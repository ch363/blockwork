/**
 * `FireSystem`: per-tile fire intensity, spread, damage, smoke and suppression
 * (T4.8).
 *
 * Fire lives beside the tile grid rather than inside it — PRD 4.3's typed
 * arrays do not list intensity or smoke, and EmergencySystem (PRD 4.4 slot 14)
 * owns the emergency. `FireGrid` is parallel structure-of-arrays so spread and
 * suppression stay cache-friendly without changing the save layout of
 * `TileGrid`.
 *
 * Ignition sources: lighter contraband, workshop accident on powered tools,
 * electrical fault on an overloaded power branch. Suppression: water-connected
 * sprinklers within radius, and callable firefighter staff with hoses.
 * Every ignition, burnout and destroyed object emits a `CausalEvent`.
 */

import type { EventSink, System, SystemContext, World } from '../core/simulation'
import type { GameData } from '../data/loader'
import type { MaterialDef } from '../data/schemas'
import { NO_OBJECT, removeObject } from '../entities/objects'
import type { ObjectDeps, ObjectEntity } from '../entities/objects'
import { NO_PIN, NO_STAFF } from '../entities/staff'
import type { StaffEntity, StaffWorldView } from '../entities/staff'
import {
  FireGrid,
  perTickFromPerSecond,
  smokeBlocksVisibility,
  smokeMovementMultiplier,
  secondsPerTick,
} from '../world/fireGrid'
import { NO_ROOM } from '../world/rooms'
import type { TileGrid } from '../world/tileGrid'

import { isInmateWorld } from './intakeSystem'
import type { InmateWorld } from './intakeSystem'

/* -------------------------------------------------------------------------- */
/* Constants                                                                   */
/* -------------------------------------------------------------------------- */

export const FIRE_SYSTEM_NAME = 'fire'

/** Fire responds every tick so spread and hose suppression stay responsive. */
export const FIRE_SYSTEM_PERIOD = 1

export const FIRE_EVENTS = {
  ignited: 'fire.ignited',
  spread: 'fire.spread',
  extinguished: 'fire.extinguished',
  objectDestroyed: 'fire.objectDestroyed',
  agentDamaged: 'fire.agentDamaged',
  sprinklerActive: 'fire.sprinklerActive',
  firefighterSummoned: 'fire.firefighterSummoned',
  firefighterRejected: 'fire.firefighterRejected',
  overloadMarked: 'fire.overloadMarked',
} as const

export type FireIgnitionSource = 'lighter' | 'workshop' | 'electrical' | 'manual' | 'spread'

export {
  FireGrid,
  perTickFromPerSecond,
  secondsPerTick,
  smokeBlocksVisibility,
  smokeMovementMultiplier,
}

const CARDINAL = [
  { dx: 1, dy: 0 },
  { dx: -1, dy: 0 },
  { dx: 0, dy: 1 },
  { dx: 0, dy: -1 },
] as const

const SPRINKLER_DEF_ID = 'sprinkler'
const LIGHTER_ITEM_ID = 'lighter'
const FIREFIGHTER_DEF_ID = 'firefighter'
const WORKSHOP_ROOM_ID = 'workshop'

/* -------------------------------------------------------------------------- */
/* Flammability                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Combined flammability of floor, wall and any object anchored on the tile.
 * Materials with no definition (slot 0 / unknown) contribute 0.
 */
export function tileFlammability(
  world: InmateWorld,
  tileIndex: number,
  data: GameData,
): number {
  const floorIdx = world.grid.getAt('floorMaterial', tileIndex)
  const wallIdx = world.grid.getAt('wallMaterial', tileIndex)
  let best = materialFlammability(data, world.materials.idAt(floorIdx))
  best = Math.max(best, materialFlammability(data, world.materials.idAt(wallIdx)))

  const objectId = world.grid.getAt('objectId', tileIndex)
  if (objectId !== NO_OBJECT) {
    const entity = world.objects.get(objectId)
    if (entity !== undefined) {
      const def = data.objects.find(entity.object.defId)
      if (def !== undefined) best = Math.max(best, def.flammability)
    }
  }
  return best
}

function materialFlammability(data: GameData, materialId: string): number {
  if (materialId === 'none') return 0
  const def: MaterialDef | undefined = data.materials.find(materialId)
  return def?.flammability ?? 0
}

function fuelFromFlammability(flammability: number): number {
  if (flammability <= 0) return 0
  return Math.max(1, Math.min(255, Math.round(flammability * 255)))
}

/* -------------------------------------------------------------------------- */
/* Ignition                                                                    */
/* -------------------------------------------------------------------------- */

export interface IgniteOptions {
  readonly world: InmateWorld
  readonly tileIndex: number
  readonly intensity: number
  readonly source: FireIgnitionSource
  readonly events: EventSink
  readonly tick: number
  readonly causeIds?: readonly number[]
  readonly subjectId?: number
}

/**
 * Lights a tile if it has fuel. Returns whether intensity was written.
 * Re-igniting an already-burning tile raises intensity to at least `intensity`.
 */
export function igniteTile(options: IgniteOptions): boolean {
  const { world, tileIndex, source, events, tick } = options
  const fire = world.fire
  const data = world.data
  const max = data.balance.fire.maxIntensity
  const flam = tileFlammability(world, tileIndex, data)
  if (flam <= 0 && fire.intensityAt(tileIndex) === 0) return false

  const desired = Math.max(1, Math.min(max, Math.round(options.intensity)))
  const wasBurning = fire.isBurning(tileIndex)
  const next = Math.max(fire.intensityAt(tileIndex), desired)
  fire.intensity[tileIndex] = next
  if (fire.fuel[tileIndex] === 0) {
    fire.fuel[tileIndex] = fuelFromFlammability(flam > 0 ? flam : 0.25)
  }

  if (!wasBurning) {
    events.emit({
      tick,
      kind: FIRE_EVENTS.ignited,
      subjectId: options.subjectId ?? 0,
      causeIds: options.causeIds ?? [],
      data: {
        tileIndex,
        intensity: next,
        source,
        flammability: flam,
      },
    })
  }
  return true
}

/* -------------------------------------------------------------------------- */
/* Callable firefighters (T4.6 stub)                                           */
/* -------------------------------------------------------------------------- */

export interface SummonFirefightersOptions {
  readonly world: StaffWorldView & { readonly fire?: FireGrid }
  readonly count: number
  readonly events: EventSink
  readonly tick: number
  /** Spawn near this tile when set; otherwise map centre. */
  readonly nearTileIndex?: number
}

export type SummonFirefightersRejection = 'unknown-role' | 'not-callable' | 'id-exhausted' | 'count'

export interface SummonFirefightersResult {
  readonly summoned: readonly StaffEntity[]
  readonly reason?: SummonFirefightersRejection
}

/**
 * Emergency ladder stub until T4.6's `EmergencySystem` owns callouts.
 * Spawns callable `firefighter` staff without going through `hireStaff`
 * (which rejects `callable` roles).
 */
export function summonFirefighters(options: SummonFirefightersOptions): SummonFirefightersResult {
  const { world, events, tick } = options
  if (!Number.isInteger(options.count) || options.count <= 0) {
    events.emit({
      tick,
      kind: FIRE_EVENTS.firefighterRejected,
      causeIds: [],
      data: { reason: 'count', count: options.count },
    })
    return { summoned: [], reason: 'count' }
  }

  const def = world.data.staff.find(FIREFIGHTER_DEF_ID)
  if (def === undefined) {
    events.emit({
      tick,
      kind: FIRE_EVENTS.firefighterRejected,
      causeIds: [],
      data: { reason: 'unknown-role', defId: FIREFIGHTER_DEF_ID },
    })
    return { summoned: [], reason: 'unknown-role' }
  }
  if (!def.callable) {
    events.emit({
      tick,
      kind: FIRE_EVENTS.firefighterRejected,
      causeIds: [],
      data: { reason: 'not-callable', defId: FIREFIGHTER_DEF_ID },
    })
    return { summoned: [], reason: 'not-callable' }
  }

  const units = world.data.balance.map.tileWorldUnits
  const spawn = resolveFirefighterSpawn(world, options.nearTileIndex)
  const summoned: StaffEntity[] = []

  for (let i = 0; i < options.count; i += 1) {
    const id = world.staff.allocateId()
    if (id === NO_STAFF) {
      events.emit({
        tick,
        kind: FIRE_EVENTS.firefighterRejected,
        causeIds: summoned.map((s) => s.id),
        data: { reason: 'id-exhausted', summoned: summoned.length },
      })
      break
    }
    const suffix = world.staff.nextHireSuffix(FIREFIGHTER_DEF_ID)
    const tx = clampCoord(spawn.tx + (i % 3), world.grid.size)
    const ty = clampCoord(spawn.ty + Math.floor(i / 3), world.grid.size)
    const entity: StaffEntity = {
      id,
      kind: 'staff',
      x: (tx + 0.5) * units,
      y: (ty + 0.5) * units,
      tx,
      ty,
      staff: {
        defId: FIREFIGHTER_DEF_ID,
        name: `${def.name} ${suffix}`,
        officeRoomId: NO_ROOM,
        assignedAreaId: 0,
        pinnedTile: NO_PIN,
        duty: { kind: 'idle' },
        wanderCooldown: 0,
        needs: new Float32Array(world.data.needs.size),
        breakPending: false,
        breakCooldownMinutes: 0,
      },
    }
    world.staff.add(entity)
    summoned.push(entity)
  }

  if (summoned.length > 0) {
    events.emit({
      tick,
      kind: FIRE_EVENTS.firefighterSummoned,
      causeIds: [],
      data: {
        count: summoned.length,
        staffIds: summoned.map((s) => s.id),
        tx: spawn.tx,
        ty: spawn.ty,
      },
    })
  }

  return { summoned }
}

function resolveFirefighterSpawn(
  world: StaffWorldView,
  nearTileIndex: number | undefined,
): { tx: number; ty: number } {
  if (nearTileIndex !== undefined && nearTileIndex >= 0) {
    const { x, y } = world.grid.xy(nearTileIndex)
    return { tx: x, ty: y }
  }
  const mid = Math.floor(world.grid.size / 2)
  return { tx: mid, ty: mid }
}

function clampCoord(value: number, size: number): number {
  if (value < 0) return 0
  if (value >= size) return size - 1
  return value
}

/* -------------------------------------------------------------------------- */
/* System                                                                      */
/* -------------------------------------------------------------------------- */

export interface FireSystemOptions {
  readonly data: GameData
}

export function createFireSystem(options: FireSystemOptions): System {
  const { data } = options
  let reportedWrongWorld = false
  /** Sprinklers that already announced this blaze window. */
  const announcedSprinklers = new Set<number>()

  return {
    name: FIRE_SYSTEM_NAME,
    period: FIRE_SYSTEM_PERIOD,

    update(context: SystemContext): void {
      const world = context.world
      const tick = context.clock.tick

      if (!isInmateWorld(world)) {
        if (reportedWrongWorld) return
        reportedWrongWorld = true
        context.events.emit({
          tick,
          kind: 'fire.rejected',
          causeIds: [],
          data: { command: FIRE_SYSTEM_NAME, reason: 'wrong-world' },
        })
        return
      }

      const fire = world.fire
      const ticksPerMinute = data.balance.time.ticksPerMinute
      const cfg = data.balance.fire
      const maxIntensity = cfg.maxIntensity

      runIgnitionSources(world, fire, data, context, tick, ticksPerMinute)
      applySprinklers(world, fire, data, context, tick, ticksPerMinute, announcedSprinklers)
      runFirefighters(world, fire, data, context, tick, ticksPerMinute)
      stepFire(world, fire, data, context, tick, maxIntensity)
      applyDamage(world, fire, data, context, tick, ticksPerMinute)
      stepSmoke(fire, cfg)
      applySmokeMovementPenalty(world, fire, data)

      if (!anyBurning(fire)) announcedSprinklers.clear()
    },
  }
}

function anyBurning(fire: FireGrid): boolean {
  for (let i = 0; i < fire.intensity.length; i += 1) {
    if ((fire.intensity[i] ?? 0) > 0) return true
  }
  return false
}

/* -------------------------------------------------------------------------- */
/* Ignition sources                                                            */
/* -------------------------------------------------------------------------- */

function runIgnitionSources(
  world: InmateWorld,
  fire: FireGrid,
  data: GameData,
  context: SystemContext,
  tick: number,
  ticksPerMinute: number,
): void {
  const rng = context.rng.stream('fire')
  const ign = data.balance.fire.ignition
  const chanceScale = 1 / ticksPerMinute

  for (const inmate of world.inmates.all()) {
    if (!inmate.inmate.inventory.includes(LIGHTER_ITEM_ID)) continue
    if (!rng.chance(ign.lighterChancePerMinute * chanceScale)) continue
    const tileIndex = world.grid.idx(inmate.tx, inmate.ty)
    igniteTile({
      world,
      tileIndex,
      intensity: ign.lighterIntensity,
      source: 'lighter',
      events: context.events,
      tick,
      causeIds: [inmate.id],
      subjectId: inmate.id,
    })
  }

  for (const room of world.rooms.all()) {
    if (room.defId !== WORKSHOP_ROOM_ID) continue
    if (!workshopHasPoweredTool(world, data, room.id)) continue
    if (!rng.chance(ign.workshopAccidentChancePerMinute * chanceScale)) continue
    const tile = pickFlammableRoomTile(world, data, room.tiles, rng.nextUint32())
    if (tile === undefined) continue
    igniteTile({
      world,
      tileIndex: tile,
      intensity: ign.workshopAccidentIntensity,
      source: 'workshop',
      events: context.events,
      tick,
      causeIds: [],
    })
  }

  if (fire.overloadedBranches.size === 0) return
  for (let i = 0; i < world.grid.powerGridId.length; i += 1) {
    const branch = world.grid.powerGridId[i] ?? 0
    if (branch === 0 || !fire.overloadedBranches.has(branch)) continue
    if (tileFlammability(world, i, data) <= 0) continue
    if (!rng.chance(ign.electricalFaultChancePerMinute * chanceScale)) continue
    igniteTile({
      world,
      tileIndex: i,
      intensity: ign.electricalFaultIntensity,
      source: 'electrical',
      events: context.events,
      tick,
      causeIds: [],
    })
  }
}

function workshopHasPoweredTool(world: InmateWorld, data: GameData, roomId: number): boolean {
  for (const entity of world.objects.inRoom(roomId)) {
    const def = data.objects.find(entity.object.defId)
    if (def === undefined || def.needsPower <= 0) continue
    if (entity.object.hasPower) return true
  }
  return false
}

function pickFlammableRoomTile(
  world: InmateWorld,
  data: GameData,
  tiles: readonly number[],
  salt: number,
): number | undefined {
  const candidates: number[] = []
  for (const tile of tiles) {
    if (tileFlammability(world, tile, data) > 0) candidates.push(tile)
  }
  if (candidates.length === 0) return undefined
  return candidates[salt % candidates.length]
}

/* -------------------------------------------------------------------------- */
/* Spread / growth / burnout                                                   */
/* -------------------------------------------------------------------------- */

function stepFire(
  world: InmateWorld,
  fire: FireGrid,
  data: GameData,
  context: SystemContext,
  tick: number,
  maxIntensity: number,
): void {
  const cfg = data.balance.fire
  const rng = context.rng.stream('fire')
  const size = fire.size
  const grid = world.grid

  // Snapshot burning tiles so spread this tick cannot chain endlessly.
  const burning: number[] = []
  for (let i = 0; i < fire.intensity.length; i += 1) {
    if ((fire.intensity[i] ?? 0) > 0) burning.push(i)
  }

  for (const tileIndex of burning) {
    const intensity = fire.intensity[tileIndex] ?? 0
    if (intensity <= 0) continue

    const flam = tileFlammability(world, tileIndex, data)
    let fuel = fire.fuel[tileIndex] ?? 0

    if (fuel > 0 && flam > 0) {
      const growth = Math.max(1, Math.round(cfg.intensityGrowthPerTick * flam))
      fire.intensity[tileIndex] = Math.min(maxIntensity, intensity + growth)
      fuel = Math.max(0, fuel - Math.max(1, Math.round(growth * 0.5)))
      fire.fuel[tileIndex] = fuel
    } else {
      const next = Math.max(0, intensity - Math.round(cfg.burnoutDecayPerTick))
      fire.intensity[tileIndex] = next
      if (next === 0) {
        charFloor(world, data, tileIndex)
        context.events.emit({
          tick,
          kind: FIRE_EVENTS.extinguished,
          causeIds: [],
          data: { tileIndex, reason: 'burnout' },
        })
      }
      continue
    }

    const intensityFraction = (fire.intensity[tileIndex] ?? 0) / maxIntensity
    const { x, y } = grid.xy(tileIndex)
    for (const { dx, dy } of CARDINAL) {
      const nx = x + dx
      const ny = y + dy
      if (nx < 0 || ny < 0 || nx >= size || ny >= size) continue
      const neighbour = grid.idx(nx, ny)
      if (fire.isBurning(neighbour)) continue
      const targetFlam = tileFlammability(world, neighbour, data)
      if (targetFlam <= 0) continue
      const chance = cfg.spreadChancePerTick * intensityFraction * targetFlam
      if (!rng.chance(chance)) continue
      const seedIntensity = Math.max(
        1,
        Math.round((fire.intensity[tileIndex] ?? 0) * 0.35 * targetFlam),
      )
      const lit = igniteTile({
        world,
        tileIndex: neighbour,
        intensity: seedIntensity,
        source: 'spread',
        events: context.events,
        tick,
        causeIds: [],
      })
      if (lit) {
        context.events.emit({
          tick,
          kind: FIRE_EVENTS.spread,
          causeIds: [],
          data: {
            fromTileIndex: tileIndex,
            toTileIndex: neighbour,
            flammability: targetFlam,
          },
        })
      }
    }
  }
}

function charFloor(world: InmateWorld, data: GameData, tileIndex: number): void {
  const burntId = data.balance.fire.burntFloorMaterialId
  const burntIdx = world.materials.tryIndexOf(burntId)
  if (burntIdx === undefined) return
  const current = world.grid.getAt('floorMaterial', tileIndex)
  const currentId = world.materials.idAt(current)
  const def = data.materials.find(currentId)
  if (def === undefined || def.flammability <= 0) return
  world.grid.setAt('floorMaterial', tileIndex, burntIdx)
}

/* -------------------------------------------------------------------------- */
/* Damage                                                                      */
/* -------------------------------------------------------------------------- */

function applyDamage(
  world: InmateWorld,
  fire: FireGrid,
  data: GameData,
  context: SystemContext,
  tick: number,
  ticksPerMinute: number,
): void {
  const cfg = data.balance.fire
  const agentDamage = perTickFromPerSecond(cfg.agentDamagePerSecond, ticksPerMinute)
  const objectDamageFull = perTickFromPerSecond(
    cfg.objectDamagePerSecondAtFullIntensity,
    ticksPerMinute,
  )
  const maxIntensity = cfg.maxIntensity

  for (const inmate of world.inmates.all()) {
    const tileIndex = world.grid.idx(inmate.tx, inmate.ty)
    const intensity = fire.intensityAt(tileIndex)
    if (intensity <= 0) continue
    const fraction = intensity / maxIntensity
    const damage = agentDamage * fraction
    if (damage <= 0) continue
    const before = inmate.inmate.health
    inmate.inmate.health = Math.max(0, before - damage)
    context.events.emit({
      tick,
      kind: FIRE_EVENTS.agentDamaged,
      subjectId: inmate.id,
      causeIds: [inmate.id],
      data: {
        entityId: inmate.id,
        kind: 'inmate',
        tileIndex,
        damage,
        health: inmate.inmate.health,
      },
    })
  }

  const destroyed: ObjectEntity[] = []
  for (const entity of world.objects.all()) {
    const tileIndex = entity.tileIndex
    const intensity = fire.intensityAt(tileIndex)
    if (intensity <= 0) continue
    const def = data.objects.find(entity.object.defId)
    if (def === undefined || !def.destructible) continue
    const fraction = intensity / maxIntensity
    const damage = objectDamageFull * fraction
    if (damage <= 0) continue
    entity.object.hp = Math.max(0, entity.object.hp - damage)
    if (entity.object.hp <= 0) destroyed.push(entity)
  }

  for (const entity of destroyed) {
    const deps: ObjectDeps = {
      world,
      data,
      events: context.events,
      tick,
    }
    const objectDefId = entity.object.defId
    const tileIndex = entity.tileIndex
    const entityId = entity.id
    removeObject(deps, entityId)
    context.events.emit({
      tick,
      kind: FIRE_EVENTS.objectDestroyed,
      subjectId: entityId,
      causeIds: [entityId],
      data: { entityId, objectDefId, tileIndex },
    })
  }
}

/* -------------------------------------------------------------------------- */
/* Suppression                                                                 */
/* -------------------------------------------------------------------------- */

function applySprinklers(
  world: InmateWorld,
  fire: FireGrid,
  data: GameData,
  context: SystemContext,
  tick: number,
  ticksPerMinute: number,
  announced: Set<number>,
): void {
  const cfg = data.balance.fire
  const suppress = perTickFromPerSecond(cfg.sprinklerSuppressionPerSecond, ticksPerMinute)
  const radius = cfg.sprinklerRadiusTiles
  if (suppress <= 0 || radius < 0) return

  for (const entity of world.objects.all()) {
    if (entity.object.defId !== SPRINKLER_DEF_ID) continue
    if (!entity.object.hasWater) continue

    let fought = false
    for (const tile of tilesInRadius(world.grid, entity.tx, entity.ty, radius)) {
      if (!fire.isBurning(tile)) continue
      fought = true
      suppressTile(fire, context, tick, tile, suppress, 'sprinkler', entity.id)
    }
    if (fought && !announced.has(entity.id)) {
      announced.add(entity.id)
      context.events.emit({
        tick,
        kind: FIRE_EVENTS.sprinklerActive,
        subjectId: entity.id,
        causeIds: [entity.id],
        data: {
          entityId: entity.id,
          tileIndex: entity.tileIndex,
          radius,
        },
      })
    }
  }
}

function runFirefighters(
  world: InmateWorld,
  fire: FireGrid,
  data: GameData,
  context: SystemContext,
  tick: number,
  ticksPerMinute: number,
): void {
  const cfg = data.balance.fire
  const suppress = perTickFromPerSecond(cfg.firefighterSuppressionPerSecond, ticksPerMinute)
  const radius = cfg.firefighterHoseRadiusTiles
  const step = cfg.firefighterStepTilesPerTick
  const units = data.balance.map.tileWorldUnits

  for (const officer of world.staff.withCapability(data, 'fightFire')) {
    const target = nearestBurningTile(fire, world.grid, officer.tx, officer.ty)
    if (target === undefined) {
      if (officer.staff.duty.kind === 'incident') {
        officer.staff.duty = { kind: 'idle' }
      }
      continue
    }

    officer.staff.duty = { kind: 'incident', tileIndex: target }
    const { x: tx, y: ty } = world.grid.xy(target)
    const dist = chebyshev(officer.tx, officer.ty, tx, ty)

    if (dist > radius) {
      stepToward(officer, tx, ty, step, world.grid.size, units)
      continue
    }

    for (const tile of tilesInRadius(world.grid, officer.tx, officer.ty, radius)) {
      if (!fire.isBurning(tile)) continue
      suppressTile(fire, context, tick, tile, suppress, 'firefighter', officer.id)
    }
  }
}

function suppressTile(
  fire: FireGrid,
  context: SystemContext,
  tick: number,
  tileIndex: number,
  amount: number,
  reason: 'sprinkler' | 'firefighter',
  actorId: number,
): void {
  const before = fire.intensityAt(tileIndex)
  if (before <= 0) return
  const next = Math.max(0, Math.round(before - amount))
  fire.intensity[tileIndex] = next
  if (next === 0) {
    fire.fuel[tileIndex] = 0
    context.events.emit({
      tick,
      kind: FIRE_EVENTS.extinguished,
      subjectId: actorId,
      causeIds: [actorId],
      data: { tileIndex, reason, actorId },
    })
  }
}

/* -------------------------------------------------------------------------- */
/* Smoke                                                                       */
/* -------------------------------------------------------------------------- */

function stepSmoke(
  fire: FireGrid,
  cfg: GameData['balance']['fire'],
): void {
  const max = cfg.smokeMax
  for (let i = 0; i < fire.smoke.length; i += 1) {
    let smoke = fire.smoke[i] ?? 0
    const intensity = fire.intensity[i] ?? 0
    if (intensity > 0) {
      smoke += cfg.smokeEmitPerIntensityPerTick * intensity
    }
    smoke -= cfg.smokeDecayPerTick
    fire.smoke[i] = Math.max(0, Math.min(max, Math.round(smoke)))
  }
}

function applySmokeMovementPenalty(
  world: InmateWorld,
  fire: FireGrid,
  data: GameData,
): void {
  const base = data.balance.pathfinding.speedsWorldUnitsPerTick.inmate
  for (const inmate of world.inmates.all()) {
    const tileIndex = world.grid.idx(inmate.tx, inmate.ty)
    inmate.speed = base * smokeMovementMultiplier(fire, tileIndex, data)
  }
}

/* -------------------------------------------------------------------------- */
/* Geometry helpers                                                            */
/* -------------------------------------------------------------------------- */

function tilesInRadius(
  grid: TileGrid,
  cx: number,
  cy: number,
  radius: number,
): number[] {
  const out: number[] = []
  const r2 = radius * radius
  const minX = Math.max(0, cx - radius)
  const maxX = Math.min(grid.size - 1, cx + radius)
  const minY = Math.max(0, cy - radius)
  const maxY = Math.min(grid.size - 1, cy + radius)
  for (let y = minY; y <= maxY; y += 1) {
    for (let x = minX; x <= maxX; x += 1) {
      const dx = x - cx
      const dy = y - cy
      if (dx * dx + dy * dy > r2) continue
      out.push(grid.idx(x, y))
    }
  }
  return out
}

function nearestBurningTile(
  fire: FireGrid,
  grid: TileGrid,
  fromTx: number,
  fromTy: number,
): number | undefined {
  let best: number | undefined
  let bestDist = Number.POSITIVE_INFINITY
  for (let i = 0; i < fire.intensity.length; i += 1) {
    if ((fire.intensity[i] ?? 0) <= 0) continue
    const { x, y } = grid.xy(i)
    const dist = chebyshev(fromTx, fromTy, x, y)
    if (dist < bestDist || (dist === bestDist && (best === undefined || i < best))) {
      best = i
      bestDist = dist
    }
  }
  return best
}

function chebyshev(ax: number, ay: number, bx: number, by: number): number {
  return Math.max(Math.abs(ax - bx), Math.abs(ay - by))
}

function stepToward(
  officer: StaffEntity,
  goalTx: number,
  goalTy: number,
  stepTiles: number,
  size: number,
  tileWorldUnits: number,
): void {
  let tx = officer.tx
  let ty = officer.ty
  for (let i = 0; i < stepTiles; i += 1) {
    if (tx === goalTx && ty === goalTy) break
    if (tx < goalTx) tx += 1
    else if (tx > goalTx) tx -= 1
    if (ty < goalTy) ty += 1
    else if (ty > goalTy) ty -= 1
    tx = clampCoord(tx, size)
    ty = clampCoord(ty, size)
  }
  officer.tx = tx
  officer.ty = ty
  officer.x = (tx + 0.5) * tileWorldUnits
  officer.y = (ty + 0.5) * tileWorldUnits
}

/* -------------------------------------------------------------------------- */
/* Type guard                                                                  */
/* -------------------------------------------------------------------------- */

/** Worlds that carry a fire grid (InmateWorld). */
export function isFireWorld(world: World): world is InmateWorld {
  return isInmateWorld(world)
}
