/**
 * `StaffNeedsSystem`: staff needs, breaks, morale and strikes (T3.8, PRD 5.6).
 *
 * Runs every tick. On each in-game minute it fills staff needs (when the map
 * setting allows), starts/advances breaks, and recomputes prison-wide morale
 * on its configured cadence. Break movement steps every tick. Strikes stop
 * non-emergency staff from taking work; pay-demand commands accept or refuse.
 *
 * Staff satisfy needs only during breaks, and only in staff-accessible rooms:
 * break room, store, control room, armoury, kennel, offices, staff-only
 * canteens, or any staff-only sector / room mark.
 */

import { isJsonArray } from '../core/commands'
import type { Command, JsonValue } from '../core/commands'
import { TICKS_PER_MINUTE } from '../core/clock'
import type { CommandHandler, System, SystemContext } from '../core/simulation'
import type { GameData } from '../data/loader'
import {
  NEED_MAX,
  NeedIndex,
  applyNeedDischarge,
  clampNeed,
  computeNeedFill,
  meanRoomDirt,
} from '../entities/needs'
import type { NeedFillContext } from '../entities/needs'
import {
  MORALE_EVENTS,
  MoraleState,
  bribeChance,
  computeMorale,
  dangerContributionFromMorale,
  movementSpeedMultiplier,
  resolveSearchBribe,
  searchEffectiveness,
} from '../entities/morale'
import { NO_OBJECT, isOperational } from '../entities/objects'
import {
  openDoorAt,
  staffMayEnter,
  type StaffEntity,
} from '../entities/staff'
import { ACCESS } from '../pathfinding/regionGraph'
import { tilePassableForAccess } from '../pathfinding/flowField'
import { NO_ROOM } from '../world/rooms'

import { isInmateWorld } from './intakeSystem'
import type { InmateWorld } from './intakeSystem'

/* -------------------------------------------------------------------------- */
/* System                                                                      */
/* -------------------------------------------------------------------------- */

export interface StaffNeedsSystemOptions {
  readonly data: GameData
  readonly index?: NeedIndex
}

export const STAFF_NEEDS_SYSTEM_NAME = 'staffNeeds'

/** Break movement needs per-tick progress; fill/morale gate on the minute. */
export const STAFF_NEEDS_SYSTEM_PERIOD = 1

export const STAFF_NEEDS_EVENTS = {
  breakStarted: 'staffNeeds.breakStarted',
  breakEnded: 'staffNeeds.breakEnded',
  breakAbandoned: 'staffNeeds.breakAbandoned',
  rejected: 'staffNeeds.rejected',
} as const

export const STAFF_NEEDS_COMMANDS = {
  acceptPayDemand: 'morale.acceptPayDemand',
  refusePayDemand: 'morale.refusePayDemand',
  setStaffNeedsEnabled: 'map.setStaffNeedsEnabled',
  markStaffOnlyRoom: 'map.markStaffOnlyRoom',
} as const

export function createStaffNeedsSystem(options: StaffNeedsSystemOptions): System {
  const { data } = options
  const index = options.index ?? NeedIndex.fromData(data)
  let reportedWrongWorld = false

  return {
    name: STAFF_NEEDS_SYSTEM_NAME,
    period: STAFF_NEEDS_SYSTEM_PERIOD,

    update(context: SystemContext): void {
      const tick = context.clock.tick
      if (!isInmateWorld(context.world)) {
        if (reportedWrongWorld) return
        reportedWrongWorld = true
        context.events.emit({
          tick,
          kind: STAFF_NEEDS_EVENTS.rejected,
          causeIds: [],
          data: { command: STAFF_NEEDS_SYSTEM_NAME, reason: 'wrong-world' },
        })
        return
      }

      const world = context.world
      const onMinute = context.clock.everyNTicks(TICKS_PER_MINUTE)

      if (onMinute && world.settings.staffNeeds) {
        fillStaffNeeds(world, data, index)
        advanceBreakSessions(world, data, index, context)
        beginBreaks(world, data, index, context)
      }

      stepBreakMovement(world, data, context)

      if (onMinute) {
        const moraleMinutes = data.balance.staffNeeds.recomputeMoraleMinutes
        if (context.clock.minute % moraleMinutes === 0 || tick === 0) {
          recomputeMorale(world, data, index, context)
        }
        world.morale.tickCooldown(tick)
        world.morale.maybeEndStrike(tick, data.balance.morale, context.events)
        if (world.settings.staffNeeds) {
          world.morale.maybeBeginStrike(
            tick,
            world.morale.value,
            data.balance.morale,
            context.rng.stream('morale'),
            context.events,
          )
        }
        stopStrikingWorkers(world, data, context)
      }
    },
  }
}

/* -------------------------------------------------------------------------- */
/* Need fill                                                                   */
/* -------------------------------------------------------------------------- */

function fillStaffNeeds(world: InmateWorld, data: GameData, index: NeedIndex): void {
  const balance = data.balance.needs
  for (const entity of world.staff.all()) {
    const def = data.staff.find(entity.staff.defId)
    if (def === undefined || def.needs.length === 0) continue

    const tileIndex = entity.ty * world.grid.size + entity.tx
    const fillCtx: NeedFillContext = {
      lockedUp: false,
      dangerLevel: world.dangerLevel,
      meanRoomDirt: meanRoomDirt(world.grid, world.rooms, tileIndex),
      nearbyInmateCount: 0,
      temperatureC: world.grid.temperature[tileIndex] ?? 0,
      traits: [],
      addictions: [],
    }

    applyStaffNeedFills(entity, def.needs, index, balance, fillCtx)
  }
}

/**
 * Fills only the listed need ids. Time drivers add; contextual drivers set.
 */
export function applyStaffNeedFills(
  entity: StaffEntity,
  needIds: readonly string[],
  index: NeedIndex,
  balance: GameData['balance']['needs'],
  ctx: NeedFillContext,
): void {
  for (const needId of needIds) {
    const needIndex = index.indexOf(needId)
    if (needIndex < 0) continue
    const def = index.defAt(needIndex)
    const result = computeNeedFill(def, balance, ctx)
    if (result.mode === 'skip') continue
    if (result.mode === 'set') {
      entity.staff.needs[needIndex] = result.value
    } else {
      entity.staff.needs[needIndex] = clampNeed(
        (entity.staff.needs[needIndex] ?? 0) + result.delta,
      )
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Breaks                                                                      */
/* -------------------------------------------------------------------------- */

function beginBreaks(
  world: InmateWorld,
  data: GameData,
  index: NeedIndex,
  context: SystemContext,
): void {
  if (world.morale.striking) return
  const threshold = data.balance.staffNeeds.breakThreshold

  for (const entity of world.staff.all()) {
    const def = data.staff.find(entity.staff.defId)
    if (def === undefined || def.needs.length === 0) continue
    if (entity.staff.duty.kind === 'break') continue

    if (entity.staff.breakCooldownMinutes > 0) {
      entity.staff.breakCooldownMinutes -= 1
      continue
    }

    const peak = peakStaffNeed(entity, def.needs, index)
    if (peak < threshold) {
      entity.staff.breakPending = false
      continue
    }

    entity.staff.breakPending = true
    if (!isStaffFreeForBreak(entity)) continue

    startBreakSeek(world, data, index, entity, context)
  }
}

function isStaffFreeForBreak(entity: StaffEntity): boolean {
  const kind = entity.staff.duty.kind
  return kind === 'idle' || kind === 'wander'
}

function startBreakSeek(
  world: InmateWorld,
  data: GameData,
  index: NeedIndex,
  entity: StaffEntity,
  context: SystemContext,
): void {
  const target = findBreakTarget(world, data, index, entity)
  entity.staff.breakPending = false
  entity.staff.duty = {
    kind: 'break',
    phase: target === undefined ? 'seek' : 'seek',
    targetRoomId: target?.roomId ?? NO_ROOM,
    targetObjectId: target?.objectId ?? NO_OBJECT,
    seekMinutes: 0,
    sessionMinutes: 0,
  }
  context.events.emit({
    tick: context.clock.tick,
    kind: STAFF_NEEDS_EVENTS.breakStarted,
    subjectId: entity.id,
    causeIds: [],
    data: {
      staffId: entity.id,
      targetRoomId: target?.roomId ?? NO_ROOM,
      targetObjectId: target?.objectId ?? NO_OBJECT,
    },
  })
}

function advanceBreakSessions(
  world: InmateWorld,
  data: GameData,
  index: NeedIndex,
  context: SystemContext,
): void {
  const resumeBelow = data.balance.staffNeeds.breakResumeBelow
  const seekTimeout = data.balance.staffNeeds.breakSeekTimeoutMinutes
  const maxMinutes = data.balance.staffNeeds.breakMaxMinutes

  for (const entity of world.staff.all()) {
    if (entity.staff.duty.kind !== 'break') continue
    const duty = entity.staff.duty
    duty.sessionMinutes += 1

    if (duty.phase === 'seek') {
      duty.seekMinutes += 1
      // Retarget periodically in case objects free up.
      if (duty.targetObjectId === NO_OBJECT || duty.seekMinutes % 5 === 0) {
        const target = findBreakTarget(world, data, index, entity)
        if (target !== undefined) {
          duty.targetRoomId = target.roomId
          duty.targetObjectId = target.objectId
        }
      }
      if (duty.seekMinutes >= seekTimeout) {
        abandonBreak(entity, context, 'timeout', seekTimeout)
        continue
      }
      // Arrived at object tile?
      const object = world.objects.get(duty.targetObjectId)
      if (object !== undefined && entity.tx === object.tx && entity.ty === object.ty) {
        duty.phase = 'use'
      }
      continue
    }

    // phase === 'use'
    const object = world.objects.get(duty.targetObjectId)
    if (object === undefined || !isOperational(object)) {
      duty.phase = 'seek'
      duty.targetObjectId = NO_OBJECT
      duty.seekMinutes = 0
      continue
    }
    const objDef = data.objects.find(object.object.defId)
    if (objDef === undefined || objDef.servesNeeds.length === 0) {
      abandonBreak(entity, context, 'object-unusable', seekTimeout)
      continue
    }
    applyNeedDischarge(entity.staff.needs, index, objDef.servesNeeds)

    const def = data.staff.find(entity.staff.defId)
    const needs = def?.needs ?? []
    const peak = peakStaffNeed(entity, needs, index)
    if (peak <= resumeBelow || duty.sessionMinutes >= maxMinutes) {
      endBreak(entity, context)
    }
  }
}

function abandonBreak(
  entity: StaffEntity,
  context: SystemContext,
  reason: string,
  cooldownMinutes: number,
): void {
  entity.staff.duty = { kind: 'idle' }
  entity.staff.breakPending = false
  entity.staff.breakCooldownMinutes = Math.max(1, cooldownMinutes)
  context.events.emit({
    tick: context.clock.tick,
    kind: STAFF_NEEDS_EVENTS.breakAbandoned,
    subjectId: entity.id,
    causeIds: [],
    data: { staffId: entity.id, reason },
  })
}

function endBreak(entity: StaffEntity, context: SystemContext): void {
  entity.staff.duty = { kind: 'idle' }
  entity.staff.breakPending = false
  context.events.emit({
    tick: context.clock.tick,
    kind: STAFF_NEEDS_EVENTS.breakEnded,
    subjectId: entity.id,
    causeIds: [],
    data: { staffId: entity.id },
  })
}

function stepBreakMovement(world: InmateWorld, data: GameData, context: SystemContext): void {
  const baseSpeed = data.balance.pathfinding.speedsWorldUnitsPerTick.staff
  const speed =
    baseSpeed * movementSpeedMultiplier(world.morale.value, data.balance.morale)
  const units = data.balance.map.tileWorldUnits

  for (const entity of world.staff.all()) {
    if (entity.staff.duty.kind !== 'break') continue
    if (entity.staff.duty.phase !== 'seek') continue
    const object = world.objects.get(entity.staff.duty.targetObjectId)
    if (object === undefined) continue
    stepStaffToward(world, data, entity, object.tx, object.ty, speed, units, context)
  }
}

/* -------------------------------------------------------------------------- */
/* Room / object routing                                                       */
/* -------------------------------------------------------------------------- */

export function isStaffAccessibleRoom(
  world: InmateWorld,
  data: GameData,
  roomId: number,
): boolean {
  if (roomId === NO_ROOM) return false
  const room = world.rooms.get(roomId)
  if (room === undefined) return false
  if (world.staffOnlyRoomIds.has(roomId)) return true
  if (world.staffOnlySectorRoomIds.has(roomId)) return true

  const accessible = data.balance.staffNeeds.accessibleRoomDefIds
  if (accessible.includes(room.defId)) return true

  const canteens = data.balance.staffNeeds.staffOnlyCanteenDefIds
  if (canteens.includes(room.defId) && world.staffOnlyRoomIds.has(roomId)) return true

  return false
}

interface BreakTarget {
  readonly roomId: number
  readonly objectId: number
  readonly tileIndex: number
  readonly dist: number
}

export function findBreakTarget(
  world: InmateWorld,
  data: GameData,
  index: NeedIndex,
  entity: StaffEntity,
): BreakTarget | undefined {
  const def = data.staff.find(entity.staff.defId)
  if (def === undefined) return undefined

  // Prefer the highest need that an object can serve.
  const ranked = [...def.needs]
    .map((needId) => ({ needId, value: index.get(entity.staff.needs, needId) }))
    .sort((a, b) => b.value - a.value || (a.needId < b.needId ? -1 : 1))

  let best: BreakTarget | undefined

  for (const room of world.rooms.all()) {
    if (!isStaffAccessibleRoom(world, data, room.id)) continue
    // Prefer functional rooms but still allow a furnished non-graded staff
    // room that detection has not marked yet — objects are the real gate.
    for (const object of world.objects.inRoom(room.id)) {
      if (!isOperational(object)) continue
      const objDef = data.objects.find(object.object.defId)
      if (objDef === undefined || objDef.servesNeeds.length === 0) continue

      const servesStaffNeed = objDef.servesNeeds.some((served) =>
        def.needs.includes(served.need),
      )
      if (!servesStaffNeed) continue

      // Prefer objects that serve the current top need.
      const top = ranked[0]
      const servesTop =
        top !== undefined && objDef.servesNeeds.some((served) => served.need === top.needId)
      const dist = Math.abs(object.tx - entity.tx) + Math.abs(object.ty - entity.ty)
      const tileIndex = object.ty * world.grid.size + object.tx
      const candidate: BreakTarget = {
        roomId: room.id,
        objectId: object.id,
        tileIndex,
        dist: servesTop ? dist : dist + 1000,
      }
      if (best === undefined || candidate.dist < best.dist || (candidate.dist === best.dist && candidate.objectId < best.objectId)) {
        best = candidate
      }
    }
  }

  return best
}

export function peakStaffNeed(
  entity: StaffEntity,
  needIds: readonly string[],
  index: NeedIndex,
): number {
  let peak = 0
  for (const needId of needIds) {
    const value = index.get(entity.staff.needs, needId)
    if (value > peak) peak = value
  }
  return peak
}

export function meanStaffNeedSatisfaction(
  world: InmateWorld,
  data: GameData,
  index: NeedIndex,
): number {
  let total = 0
  let count = 0
  for (const entity of world.staff.all()) {
    const def = data.staff.find(entity.staff.defId)
    if (def === undefined || def.needs.length === 0) continue
    for (const needId of def.needs) {
      const needIndex = index.indexOf(needId)
      if (needIndex < 0) continue
      // Contextual needs (safety / environment / warmth) track the prison and
      // would otherwise floor morale above the strike threshold even when every
      // break facility is missing. Morale uses dischargeable (time-driven)
      // needs — the ones staff can only clear on a break.
      const needDef = index.defAt(needIndex)
      if (needDef.driver !== 'time' && needDef.driver !== 'confinement') continue
      const value = entity.staff.needs[needIndex] ?? 0
      total += NEED_MAX - value
      count += 1
    }
  }
  if (count === 0) return NEED_MAX
  return total / count
}

export function meanStaffWageRatio(world: InmateWorld, data: GameData): number {
  const market = data.balance.morale.marketHourlyWage
  if (market <= 0) return 1
  let total = 0
  let count = 0
  for (const entity of world.staff.all()) {
    const def = data.staff.find(entity.staff.defId)
    if (def === undefined) continue
    if (def.perSession || def.callable) continue
    if (def.hourlyWage <= 0) continue
    total += def.hourlyWage * world.morale.wageMultiplier
    count += 1
  }
  if (count === 0) return 1
  return total / count / market
}

/* -------------------------------------------------------------------------- */
/* Morale recompute                                                            */
/* -------------------------------------------------------------------------- */

function recomputeMorale(
  world: InmateWorld,
  data: GameData,
  index: NeedIndex,
  context: SystemContext,
): void {
  const needSatisfaction = world.settings.staffNeeds
    ? meanStaffNeedSatisfaction(world, data, index)
    : NEED_MAX
  const wageRatio = meanStaffWageRatio(world, data)
  const recentDeaths = world.morale.recentDeaths(context.clock.tick, data.balance.morale)
  const injuries = world.morale.injuryCount()

  const morale = computeMorale(
    {
      needSatisfaction,
      wageRatio,
      dangerLevel: world.dangerLevel - world.morale.lastDangerContribution,
      recentDeaths,
      injuries,
    },
    data.balance.morale,
  )
  world.morale.value = morale

  const weight = data.balance.danger.weights.staffMorale
  const contribution = dangerContributionFromMorale(morale, weight)
  const without = world.dangerLevel - world.morale.lastDangerContribution
  world.dangerLevel = clampNeed(without + contribution)
  world.morale.lastDangerContribution = contribution

  context.events.emit({
    tick: context.clock.tick,
    kind: MORALE_EVENTS.recomputed,
    causeIds: [],
    data: {
      morale,
      needSatisfaction,
      wageRatio,
      recentDeaths,
      injuries,
      dangerContribution: contribution,
      searchEffectiveness: searchEffectiveness(morale, data.balance.morale),
      movementSpeed: movementSpeedMultiplier(morale, data.balance.morale),
      bribeChance: bribeChance(morale, data.balance.morale),
    },
  })
}

/* -------------------------------------------------------------------------- */
/* Strike labour                                                               */
/* -------------------------------------------------------------------------- */

export function isEmergencyStaff(data: GameData, entity: StaffEntity): boolean {
  const def = data.staff.find(entity.staff.defId)
  return def !== undefined && def.callable === true
}

export function isStaffAvailableForWork(world: InmateWorld, data: GameData, entity: StaffEntity): boolean {
  if (entity.staff.duty.kind === 'break') return false
  if (entity.staff.breakPending) return false
  if (world.morale.striking && !isEmergencyStaff(data, entity)) return false
  return true
}

function stopStrikingWorkers(world: InmateWorld, data: GameData, context: SystemContext): void {
  if (!world.morale.striking) return
  for (const entity of world.staff.all()) {
    if (isEmergencyStaff(data, entity)) continue
    if (entity.staff.duty.kind === 'job') {
      const jobId = entity.staff.duty.jobId
      world.jobs.abandon(jobId, context.clock.tick)
      entity.staff.duty = { kind: 'idle' }
    } else if (entity.staff.duty.kind === 'escort') {
      const job = world.escorts.get(entity.staff.duty.jobId)
      if (job !== undefined) {
        job.state = 'queued'
        job.claimedBy = 0
        job.path = null
        job.pathIndex = 0
      }
      entity.staff.duty = { kind: 'idle' }
    } else if (entity.staff.duty.kind === 'wander' || entity.staff.duty.kind === 'break') {
      entity.staff.duty = { kind: 'idle' }
      entity.staff.breakPending = false
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Movement helper (break seek)                                                */
/* -------------------------------------------------------------------------- */

const NEIGHBOURS: readonly (readonly [number, number])[] = [
  [0, -1],
  [1, 0],
  [0, 1],
  [-1, 0],
]

function stepStaffToward(
  world: InmateWorld,
  data: GameData,
  entity: StaffEntity,
  goalTx: number,
  goalTy: number,
  speed: number,
  tileWorldUnits: number,
  context: SystemContext,
): void {
  if (entity.tx === goalTx && entity.ty === goalTy) {
    entity.x = (entity.tx + 0.5) * tileWorldUnits
    entity.y = (entity.ty + 0.5) * tileWorldUnits
    return
  }

  const path = buildPathBfs(world, data, entity.tx, entity.ty, goalTx, goalTy)
  const nextIndex = path[0]
  if (nextIndex === undefined) return
  const nextTy = (nextIndex / world.grid.size) | 0
  const nextTx = nextIndex - nextTy * world.grid.size

  if (!tilePassableForAccess(world.grid.passability[nextIndex] ?? 0, ACCESS.STAFF)) {
    if (staffMayEnter(world, data, nextIndex, true)) {
      openDoorAt(world, data, nextIndex, context.events, context.clock.tick, entity.id)
    }
  }

  const nextCentreX = (nextTx + 0.5) * tileWorldUnits
  const nextCentreY = (nextTy + 0.5) * tileWorldUnits
  const dx = nextCentreX - entity.x
  const dy = nextCentreY - entity.y
  const dist = Math.hypot(dx, dy)
  if (dist <= speed || dist === 0) {
    entity.x = nextCentreX
    entity.y = nextCentreY
  } else {
    entity.x += (dx / dist) * speed
    entity.y += (dy / dist) * speed
  }
  entity.tx = Math.floor(entity.x / tileWorldUnits)
  entity.ty = Math.floor(entity.y / tileWorldUnits)
}

function buildPathBfs(
  world: InmateWorld,
  data: GameData,
  tx: number,
  ty: number,
  goalTx: number,
  goalTy: number,
): number[] {
  if (tx === goalTx && ty === goalTy) return []
  const size = world.grid.size
  const total = size * size
  const start = ty * size + tx
  const goal = goalTy * size + goalTx
  const cameFrom = new Int32Array(total)
  cameFrom.fill(-1)
  const visited = new Uint8Array(total)
  const queue = new Int32Array(total)
  let head = 0
  let tail = 0
  queue[tail] = start
  tail += 1
  visited[start] = 1
  let found = false

  while (head < tail) {
    const current = queue[head]
    head += 1
    if (current === undefined) break
    if (current === goal) {
      found = true
      break
    }
    const cy = (current / size) | 0
    const cx = current - cy * size
    for (const [ox, oy] of NEIGHBOURS) {
      const nx = cx + ox
      const ny = cy + oy
      if (nx < 0 || ny < 0 || nx >= size || ny >= size) continue
      const next = ny * size + nx
      if (visited[next] === 1) continue
      const pass = world.grid.passability[next] ?? 0
      if (!tilePassableForAccess(pass, ACCESS.STAFF) && !staffMayEnter(world, data, next, true)) {
        continue
      }
      visited[next] = 1
      cameFrom[next] = current
      queue[tail] = next
      tail += 1
    }
  }

  if (!found) return []
  const reversed: number[] = []
  let step = goal
  while (step !== start && step !== -1) {
    reversed.push(step)
    step = cameFrom[step] ?? -1
  }
  reversed.reverse()
  return reversed
}

/* -------------------------------------------------------------------------- */
/* Commands                                                                    */
/* -------------------------------------------------------------------------- */

export function staffNeedsCommandHandlers(
  _data: GameData,
): Readonly<Record<string, CommandHandler>> {
  return {
    [STAFF_NEEDS_COMMANDS.acceptPayDemand]: (command, context) => {
      if (!isInmateWorld(context.world)) {
        reject(context, command, 'wrong-world')
        return
      }
      if (
        !context.world.morale.acceptPayDemand(
          context.clock.tick,
          context.world.data.balance.morale,
          context.events,
        )
      ) {
        reject(context, command, 'no-pay-demand')
      }
    },
    [STAFF_NEEDS_COMMANDS.refusePayDemand]: (command, context) => {
      if (!isInmateWorld(context.world)) {
        reject(context, command, 'wrong-world')
        return
      }
      if (!context.world.morale.refusePayDemand(context.clock.tick, context.events)) {
        reject(context, command, 'no-pay-demand')
      }
    },
    [STAFF_NEEDS_COMMANDS.setStaffNeedsEnabled]: (command, context) => {
      if (!isInmateWorld(context.world)) {
        reject(context, command, 'wrong-world')
        return
      }
      const enabled = readBoolean(command.payload, 'enabled')
      if (enabled === undefined) {
        reject(context, command, 'malformed-payload')
        return
      }
      context.world.settings.staffNeeds = enabled
    },
    [STAFF_NEEDS_COMMANDS.markStaffOnlyRoom]: (command, context) => {
      if (!isInmateWorld(context.world)) {
        reject(context, command, 'wrong-world')
        return
      }
      const roomId = readOptionalInt(command.payload, 'roomId')
      const staffOnly = readBoolean(command.payload, 'staffOnly')
      if (roomId === undefined || staffOnly === undefined) {
        reject(context, command, 'malformed-payload')
        return
      }
      if (staffOnly) context.world.staffOnlyRoomIds.add(roomId)
      else context.world.staffOnlyRoomIds.delete(roomId)
    },
  }
}

function reject(context: SystemContext, command: Command, reason: string): void {
  context.events.emit({
    tick: context.clock.tick,
    kind: STAFF_NEEDS_EVENTS.rejected,
    causeIds: [],
    data: { command: command.type, reason },
  })
}

function readBoolean(payload: JsonValue, key: string): boolean | undefined {
  if (payload === null || typeof payload !== 'object' || isJsonArray(payload)) return undefined
  const value = payload[key]
  return typeof value === 'boolean' ? value : undefined
}

function readOptionalInt(payload: JsonValue, key: string): number | undefined {
  if (payload === null || typeof payload !== 'object' || isJsonArray(payload)) return undefined
  const value = payload[key]
  if (typeof value !== 'number' || !Number.isInteger(value)) return undefined
  return value
}

/** Re-export effect helpers for callers (search system, movement). */
export {
  MoraleState,
  MORALE_EVENTS,
  bribeChance,
  computeMorale,
  dangerContributionFromMorale,
  movementSpeedMultiplier,
  resolveSearchBribe,
  searchEffectiveness,
}
export type { MoraleInputs, SearchBribeResult, StrikeSnapshot } from '../entities/morale'
