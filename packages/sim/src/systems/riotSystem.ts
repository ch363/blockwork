/**
 * Riots (T4.6, PRD 5.11).
 *
 * Trigger check every `balance.riot.checkMinutes`:
 * `p = base * (danger/pivot)^exponent * (1 + agitators) * (lockdown ? factor : 1)`
 *
 * Spreads to inmates within `spreadTiles` with probability scaled by mood.
 * Contained when no rioting inmates remain for `containedMinutes` continuous
 * minutes. While active, rioters attack staff, damage objects, break doors,
 * and seek the map edge.
 */

import { TICKS_PER_MINUTE } from '../core/clock'
import type { RngStream } from '../core/rng'
import type { System, SystemContext } from '../core/simulation'
import type { GameData } from '../data/loader'
import type { Balance } from '../data/schemas'
import { requestMeleeAttack } from '../entities/combat'
import { NeedIndex } from '../entities/needs'
import { removeObject } from '../entities/objects'
import type { ObjectDeps } from '../entities/objects'
import { refreshPassability } from '../world/construction'
import { PASSABILITY } from '../world/tileGrid'

import { isInmateWorld } from './intakeSystem'
import type { InmateWorld } from './intakeSystem'

export { RiotState } from '../entities/securityState'

/* -------------------------------------------------------------------------- */
/* Events / identity                                                           */
/* -------------------------------------------------------------------------- */

export const RIOT_EVENTS = {
  started: 'riot.started',
  joined: 'riot.joined',
  spread: 'riot.spread',
  contained: 'riot.contained',
  attackStaff: 'riot.attackStaff',
  destroyObject: 'riot.destroyObject',
  breakDoor: 'riot.breakDoor',
  rejected: 'riot.rejected',
} as const

export const RIOT_SYSTEM_NAME = 'riot'
export const RIOT_SYSTEM_PERIOD = TICKS_PER_MINUTE

/* -------------------------------------------------------------------------- */
/* Pure helpers                                                                */
/* -------------------------------------------------------------------------- */

/** Riot trigger probability for one check. */
export function riotTriggerProbability(
  danger: number,
  agitatorsActive: number,
  lockdownActive: boolean,
  balance: Balance['riot'],
): number {
  const ratio = danger / balance.dangerPivot
  const scaled = Math.pow(Math.max(0, ratio), balance.dangerExponent)
  const lockdown = lockdownActive ? balance.lockdownFactor : 1
  return (
    balance.baseProbability * scaled * (1 + agitatorsActive * balance.agitatorFactor) * lockdown
  )
}

/**
 * Mood 0..100: `100 - weightedMean(needs)`, violence-escalating needs × 1.5
 * (PRD 5.4).
 */
export function computeInmateMood(needs: Float32Array, index: NeedIndex): number {
  let weightedSum = 0
  let weightTotal = 0
  for (let i = 0; i < index.size; i += 1) {
    const def = index.defAt(i)
    const weight = def.escalatesToViolence ? 1.5 : 1
    weightedSum += (needs[i] ?? 0) * weight
    weightTotal += weight
  }
  if (weightTotal <= 0) return 100
  const mean = weightedSum / weightTotal
  const mood = 100 - mean
  if (mood <= 0) return 0
  if (mood >= 100) return 100
  return mood
}

/**
 * Spread chance for one neighbour. Low mood → higher join probability.
 * `p = base * (1 - mood/pivot)` clamped to [0, 1], mood above pivot rarely joins.
 */
export function riotSpreadProbability(mood: number, balance: Balance['riot']): number {
  const pivot = balance.spreadMoodPivot <= 0 ? 1 : balance.spreadMoodPivot
  const factor = 1 - mood / pivot
  const p = balance.spreadBaseProbability * Math.max(0, factor)
  if (p <= 0) return 0
  if (p >= 1) return 1
  return p
}

export function chebyshevTiles(ax: number, ay: number, bx: number, by: number): number {
  return Math.max(Math.abs(ax - bx), Math.abs(ay - by))
}

/* -------------------------------------------------------------------------- */
/* System                                                                      */
/* -------------------------------------------------------------------------- */

export interface RiotSystemOptions {
  readonly data: GameData
  readonly index?: NeedIndex
}

export function createRiotSystem(options: RiotSystemOptions): System {
  const { data } = options
  const index = options.index ?? NeedIndex.fromData(data)
  let reportedWrongWorld = false

  return {
    name: RIOT_SYSTEM_NAME,
    period: RIOT_SYSTEM_PERIOD,

    update(context: SystemContext): void {
      if (!isInmateWorld(context.world)) {
        if (reportedWrongWorld) return
        reportedWrongWorld = true
        context.events.emit({
          tick: context.clock.tick,
          kind: RIOT_EVENTS.rejected,
          causeIds: [],
          data: { command: RIOT_SYSTEM_NAME, reason: 'wrong-world' },
        })
        return
      }

      const world = context.world
      const rng = context.rng.stream('riot')
      const balance = data.balance.riot

      pruneDeadRioters(world)

      if (!world.riot.active) {
        maybeTriggerRiot(world, index, context, rng, balance)
        return
      }

      spreadRiot(world, index, context, rng, balance)
      actRioters(world, data, context, rng, balance)
      advanceContainment(world, context, balance)
    },
  }
}

function pruneDeadRioters(world: InmateWorld): void {
  for (const id of [...world.riot.riotingInmateIds]) {
    const entity = world.inmates.get(id)
    if (entity === undefined || entity.inmate.health <= 0) {
      world.riot.riotingInmateIds.delete(id)
    }
  }
}

function maybeTriggerRiot(
  world: InmateWorld,
  index: NeedIndex,
  context: SystemContext,
  rng: RngStream,
  balance: Balance['riot'],
): void {
  if (context.clock.minute % balance.checkMinutes !== 0) return
  if (world.inmates.size === 0) return

  const agitators = countActiveAgitators(world)
  const p = riotTriggerProbability(
    world.dangerLevel,
    agitators,
    world.lockdownActive || world.emergency.fullLockdown,
    balance,
  )
  if (rng.next() >= p) return

  // Seed with the angriest inmate (lowest mood).
  let seedId = 0
  let worstMood = Infinity
  for (const entity of world.inmates.all()) {
    if (entity.inmate.health <= 0) continue
    const mood = computeInmateMood(entity.inmate.needs, index)
    if (mood < worstMood) {
      worstMood = mood
      seedId = entity.id
    }
  }
  if (seedId === 0) return

  beginRiot(world, seedId, context.clock.tick, context)
}

export function beginRiot(
  world: InmateWorld,
  seedInmateId: number,
  tick: number,
  context: Pick<SystemContext, 'events'>,
): void {
  world.riot.active = true
  world.riot.startedAtTick = tick
  world.riot.quietMinutes = 0
  world.riot.riotingInmateIds.add(seedInmateId)
  world.riotActive = true
  world.contracts.progress.recordIncident('riot', tick)

  context.events.emit({
    tick,
    kind: RIOT_EVENTS.started,
    subjectId: seedInmateId,
    causeIds: [],
    data: {
      inmateId: seedInmateId,
      danger: world.dangerLevel,
      population: world.inmates.size,
    },
  })
  context.events.emit({
    tick,
    kind: RIOT_EVENTS.joined,
    subjectId: seedInmateId,
    causeIds: [],
    data: { inmateId: seedInmateId, reason: 'seed' },
  })
}

function spreadRiot(
  world: InmateWorld,
  index: NeedIndex,
  context: SystemContext,
  rng: RngStream,
  balance: Balance['riot'],
): void {
  if (world.riot.riotingInmateIds.size === 0) return

  const rioters = [...world.riot.riotingInmateIds]
    .map((id) => world.inmates.get(id))
    .filter((entity): entity is NonNullable<typeof entity> => entity !== undefined)

  for (const candidate of world.inmates.all()) {
    if (world.riot.riotingInmateIds.has(candidate.id)) continue
    if (candidate.inmate.health <= 0) continue

    let near = false
    for (const rioter of rioters) {
      if (chebyshevTiles(rioter.tx, rioter.ty, candidate.tx, candidate.ty) <= balance.spreadTiles) {
        near = true
        break
      }
    }
    if (!near) continue

    const mood = computeInmateMood(candidate.inmate.needs, index)
    const p = riotSpreadProbability(mood, balance)
    if (rng.next() >= p) continue

    world.riot.riotingInmateIds.add(candidate.id)
    context.events.emit({
      tick: context.clock.tick,
      kind: RIOT_EVENTS.spread,
      subjectId: candidate.id,
      causeIds: [],
      data: { inmateId: candidate.id, mood, probability: p },
    })
    context.events.emit({
      tick: context.clock.tick,
      kind: RIOT_EVENTS.joined,
      subjectId: candidate.id,
      causeIds: [],
      data: { inmateId: candidate.id, reason: 'spread' },
    })
  }
}

function actRioters(
  world: InmateWorld,
  data: GameData,
  context: SystemContext,
  rng: RngStream,
  balance: Balance['riot'],
): void {
  const tick = context.clock.tick
  const size = world.grid.size

  for (const inmateId of [...world.riot.riotingInmateIds]) {
    const inmate = world.inmates.get(inmateId)
    if (inmate === undefined || inmate.inmate.health <= 0) continue

    // Attack nearest staff within range.
    const staffId = nearestStaffId(world, inmate.tx, inmate.ty, balance.attackStaffRangeTiles)
    if (staffId !== undefined) {
      const bag = world.emergency.staffHealth
      if (!bag.has(staffId)) bag.set(staffId, 100)
      const targetRef = {
        kind: 'staff' as const,
        id: staffId,
        health: bag.get(staffId) ?? 100,
      }
      const result = requestMeleeAttack({
        tick,
        events: context.events,
        balance: data.balance.combat,
        attacker: {
          kind: 'inmate',
          id: inmateId,
          health: inmate.inmate.health,
        },
        target: targetRef,
        onStaffInjured: (id) => {
          world.morale.setInjured(id, true)
        },
        onStaffKilled: (id) => {
          world.morale.recordDeath(tick)
          world.morale.clearStaff(id)
          world.staff.remove(id)
          bag.delete(id)
        },
      })
      bag.set(staffId, targetRef.health)
      if (result.killed || result.injured) {
        context.events.emit({
          tick,
          kind: RIOT_EVENTS.attackStaff,
          subjectId: inmateId,
          causeIds: [],
          data: { inmateId, staffId, killed: result.killed },
        })
      }
    }

    // Destroy object on current tile.
    const tileIndex = inmate.ty * size + inmate.tx
    const object = world.objects.at(tileIndex)
    if (object !== undefined && object.object.hp > 0) {
      const destructive = inmate.inmate.traits.includes('destructive')
      const damage =
        balance.objectDamageHpPerMinute *
        (destructive ? balance.destructiveTraitDamageMultiplier : 1)
      object.object.hp = Math.max(0, object.object.hp - damage)
      if (object.object.hp <= 0) {
        const deps: ObjectDeps = {
          world,
          data,
          events: context.events,
          tick,
        }
        removeObject(deps, object.id)
        context.events.emit({
          tick,
          kind: RIOT_EVENTS.destroyObject,
          subjectId: inmateId,
          causeIds: [],
          data: { inmateId, objectId: object.id, tileIndex },
        })
      }
    }

    // Break adjacent doors.
    let breakingDoor = false
    for (const [dx, dy] of NEIGHBOURS) {
      const nx = inmate.tx + dx
      const ny = inmate.ty + dy
      if (nx < 0 || ny < 0 || nx >= size || ny >= size) continue
      const doorTile = ny * size + nx
      const door = world.doors.get(doorTile)
      if (door === undefined) continue
      breakingDoor = true
      const progress = (world.riot.doorBreakProgress.get(doorTile) ?? 0) + 1
      world.riot.doorBreakProgress.set(doorTile, progress)
      if (progress < balance.doorBreakMinutes) continue
      world.doors.remove(doorTile)
      world.riot.doorBreakProgress.delete(doorTile)
      world.grid.setAt('passability', doorTile, PASSABILITY.WALKABLE)
      world.grid.setAt('wallMaterial', doorTile, 0)
      refreshPassability(world, data, doorTile)
      world.structureChanged(doorTile)
      context.events.emit({
        tick,
        kind: RIOT_EVENTS.breakDoor,
        subjectId: inmateId,
        causeIds: [],
        data: { inmateId, tileIndex: doorTile },
      })
    }

    // Seek map edge only when not mid-breach.
    if (!breakingDoor) {
      seekExitStep(inmate, size, rng)
    }
  }
}

const NEIGHBOURS: readonly (readonly [number, number])[] = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
]

function nearestStaffId(
  world: InmateWorld,
  tx: number,
  ty: number,
  range: number,
): number | undefined {
  let bestId: number | undefined
  let bestDist = Infinity
  for (const staff of world.staff.all()) {
    const dist = chebyshevTiles(tx, ty, staff.tx, staff.ty)
    if (dist > range) continue
    const health = world.emergency.staffHealth.get(staff.id) ?? 100
    if (health <= 0) continue
    if (dist < bestDist || (dist === bestDist && (bestId === undefined || staff.id < bestId))) {
      bestDist = dist
      bestId = staff.id
    }
  }
  return bestId
}

function seekExitStep(
  inmate: { tx: number; ty: number; x: number; y: number },
  size: number,
  rng: RngStream,
): void {
  const toLeft = inmate.tx
  const toRight = size - 1 - inmate.tx
  const toTop = inmate.ty
  const toBottom = size - 1 - inmate.ty
  const min = Math.min(toLeft, toRight, toTop, toBottom)
  const options: { dx: number; dy: number }[] = []
  if (toLeft === min) options.push({ dx: -1, dy: 0 })
  if (toRight === min) options.push({ dx: 1, dy: 0 })
  if (toTop === min) options.push({ dx: 0, dy: -1 })
  if (toBottom === min) options.push({ dx: 0, dy: 1 })
  const pick = options[Math.floor(rng.next() * options.length)] ?? { dx: 0, dy: 0 }
  const nx = Math.max(0, Math.min(size - 1, inmate.tx + pick.dx))
  const ny = Math.max(0, Math.min(size - 1, inmate.ty + pick.dy))
  inmate.tx = nx
  inmate.ty = ny
}

function advanceContainment(
  world: InmateWorld,
  context: SystemContext,
  balance: Balance['riot'],
): void {
  if (world.riot.riotingInmateIds.size > 0) {
    world.riot.quietMinutes = 0
    world.riotActive = true
    return
  }

  world.riot.quietMinutes += 1
  if (world.riot.quietMinutes < balance.containedMinutes) return

  world.riot.clear()
  world.riotActive = false
  // Emergency system watches this flag / event to cancel failure countdown.
  context.events.emit({
    tick: context.clock.tick,
    kind: RIOT_EVENTS.contained,
    causeIds: [],
    data: { quietMinutes: balance.containedMinutes },
  })
  // Direct cancel so failure timing tests don't depend on system order.
  if (world.emergency.warningAtTick !== null || world.emergency.failureAtTick !== null) {
    world.emergency.cancelFailureCountdown()
    context.events.emit({
      tick: context.clock.tick,
      kind: 'failure.riotCancelled',
      causeIds: [],
      data: { reason: 'contained' },
    })
  }
}

function countActiveAgitators(world: InmateWorld): number {
  let count = 0
  for (const entity of world.inmates.all()) {
    if (entity.inmate.health <= 0) continue
    const has = entity.inmate.reputations.some((rep) => rep.id === 'agitator')
    if (has) count += 1
  }
  return count
}

/** Force an inmate into the riot set (tests / emergency free-fire targets). */
export function markRioting(world: InmateWorld, inmateId: number): void {
  world.riot.riotingInmateIds.add(inmateId)
  world.riot.active = true
  world.riotActive = true
  world.riot.quietMinutes = 0
}
