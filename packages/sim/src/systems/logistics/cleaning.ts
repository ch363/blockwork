/**
 * Dirt accrual and cleaning labour (T3.5, PRD 5.13).
 *
 * Dirt lives on `TileGrid.dirt` (0..255). Sources: agent footfall, urination
 * (needs), blood spills, food waste (supply refuse). Cleaners work indoors,
 * groundskeepers outdoors, and cleaning-assigned inmates during `work_*`.
 * Cleaning rate is data-driven and proportional to tile dirt. The environment
 * need is already set from mean room dirt in the needs system.
 */

import { TICKS_PER_MINUTE, ticksToDay, ticksToTimeString } from '../../core/clock'
import type { Fnv1aHasher } from '../../core/hash'
import type { EventSink, System, SystemContext } from '../../core/simulation'
import type { GameData } from '../../data/loader'
import { hasCapability } from '../../entities/staff'
import { NO_MATERIAL, NO_MATERIAL_ID } from '../../world/materials'
import { TRACE_KINDS } from '../../trace/causalEvent'
import type { EventId } from '../../trace/causalEvent'
import { isInmateWorld } from '../intakeSystem'
import type { InmateWorld } from '../intakeSystem'
import { postJob } from '../jobSystem'

/* -------------------------------------------------------------------------- */
/* Constants                                                                   */
/* -------------------------------------------------------------------------- */

export const CLEANING_EVENTS = {
  tileCleaned: 'cleaning.tileCleaned',
  rejected: 'cleaning.rejected',
} as const

export const CLEANING_SYSTEM_NAME = 'cleaning'

/** PRD 4.4: Logistics runs once an in-game minute. */
export const CLEANING_SYSTEM_PERIOD = TICKS_PER_MINUTE

const WORK_BLOCKS = new Set(['work_free', 'work_lockup'])

/* -------------------------------------------------------------------------- */
/* Dirt helpers (exported for tests / other systems)                           */
/* -------------------------------------------------------------------------- */

/** Floor material dirt multiplier for a tile (1 when bare / unknown). */
export function floorDirtMultiplier(
  world: InmateWorld,
  data: GameData,
  tileIndex: number,
): number {
  const matIndex = world.grid.floorMaterial[tileIndex] ?? NO_MATERIAL
  if (matIndex === NO_MATERIAL) return 1
  const id = world.materials.idAt(matIndex)
  if (id === NO_MATERIAL_ID) return 1
  const def = data.materials.find(id)
  return def?.dirtMultiplier ?? 1
}

/**
 * Adds dirt to a tile, applying the floor material multiplier and capping at
 * `balance.logistics.dirt.max`. Returns the amount actually written.
 */
export function addTileDirt(
  world: InmateWorld,
  data: GameData,
  tileIndex: number,
  amount: number,
  options: { readonly applyMultiplier?: boolean } = {},
): number {
  if (amount <= 0) return 0
  const dirt = data.balance.logistics.dirt
  const applyMultiplier = options.applyMultiplier !== false
  const scaled = applyMultiplier
    ? Math.round(amount * floorDirtMultiplier(world, data, tileIndex))
    : Math.round(amount)
  if (scaled <= 0) return 0
  const current = world.grid.dirt[tileIndex] ?? 0
  const next = Math.min(dirt.max, current + scaled)
  const added = next - current
  if (added > 0) world.grid.setAt('dirt', tileIndex, next)
  return added
}

/** +perAgentPass on tile entry (movement). */
export function accrueAgentPassDirt(
  world: InmateWorld,
  data: GameData,
  tileIndex: number,
): number {
  return addTileDirt(world, data, tileIndex, data.balance.logistics.dirt.perAgentPass)
}

/** +perBloodSpill (combat / injury systems call this). */
export function accrueBloodSpillDirt(
  world: InmateWorld,
  data: GameData,
  tileIndex: number,
): number {
  return addTileDirt(world, data, tileIndex, data.balance.logistics.dirt.perBloodSpill, {
    applyMultiplier: false,
  })
}

/** +perFoodWaste when refuse piles raise dirt (also used by supply). */
export function accrueFoodWasteDirt(
  world: InmateWorld,
  data: GameData,
  tileIndex: number,
): number {
  return addTileDirt(world, data, tileIndex, data.balance.logistics.dirt.perFoodWaste, {
    applyMultiplier: false,
  })
}

/** +perUrination without floor multiplier (needs already uses the raw amount). */
export function accrueUrinationDirt(
  world: InmateWorld,
  data: GameData,
  tileIndex: number,
): number {
  return addTileDirt(world, data, tileIndex, data.balance.logistics.dirt.perUrination, {
    applyMultiplier: false,
  })
}

/**
 * Minutes a single cleaner needs to clear `dirt` points at the configured rate.
 * Pure helper for tests and inspectors.
 */
export function cleaningMinutesForDirt(
  dirt: number,
  dirtRemovedPerCleanerPerMinute: number,
): number {
  if (dirt <= 0) return 0
  if (dirtRemovedPerCleanerPerMinute <= 0) return Number.POSITIVE_INFINITY
  return dirt / dirtRemovedPerCleanerPerMinute
}

/* -------------------------------------------------------------------------- */
/* State                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Cleaning logistics bookkeeping: fractional clean remainders and one-shot
 * Trace notifications when the prison has dirt but no cleaners.
 */
export class CleaningLogistics {
  /** Fractional dirt-removal remainder carried across minutes. */
  cleanRemainder = 0
  /** True after we emitted `cleaning.noCleaners` for the current dirt spike. */
  noCleanersNotified = false
  /** Cumulative dirt points removed (acceptance / Trace). */
  dirtRemoved = 0

  hashInto(hasher: Fnv1aHasher): void {
    hasher.writeFloat64(this.cleanRemainder)
    hasher.writeUint32(this.noCleanersNotified ? 1 : 0)
    hasher.writeUint32(this.dirtRemoved)
  }
}

/* -------------------------------------------------------------------------- */
/* System                                                                      */
/* -------------------------------------------------------------------------- */

export interface CleaningSystemOptions {
  readonly data: GameData
}

export function createCleaningSystem(options: CleaningSystemOptions): System {
  const { data } = options
  let reportedWrongWorld = false

  return {
    name: CLEANING_SYSTEM_NAME,
    period: CLEANING_SYSTEM_PERIOD,

    update(context: SystemContext): void {
      const tick = context.clock.tick
      if (!isInmateWorld(context.world)) {
        if (reportedWrongWorld) return
        reportedWrongWorld = true
        context.events.emit({
          tick,
          kind: CLEANING_EVENTS.rejected,
          causeIds: [],
          data: { command: CLEANING_SYSTEM_NAME, reason: 'wrong-world' },
        })
        return
      }

      updateCleaning(context.world, data, context.events, tick)
    },
  }
}

/** One logistics minute of cleaning labour and no-cleaner Trace. */
export function updateCleaning(
  world: InmateWorld,
  data: GameData,
  events: EventSink,
  tick: number,
): void {
  const cleaning = world.cleaning
  const cfg = data.balance.logistics.cleaning
  const indoorWorkers = countIndoorCleaners(world, data)
  const outdoorWorkers = countOutdoorCleaners(world, data)
  const workers = indoorWorkers + outdoorWorkers

  const dirtyIndoor = collectDirtyTiles(world, cfg.dirtyTileThreshold, false)
  const dirtyOutdoor = collectDirtyTiles(world, cfg.dirtyTileThreshold, true)
  const dirtyCount = dirtyIndoor.length + dirtyOutdoor.length

  if (dirtyCount > 0 && workers === 0) {
    if (!cleaning.noCleanersNotified) {
      cleaning.noCleanersNotified = true
      const meanDirt = meanDirtyTileDirt(world, dirtyIndoor, dirtyOutdoor)
      recordEvent(events, {
        tick,
        kind: TRACE_KINDS.cleaningNoCleaners,
        subjectId: 0,
        causeIds: [],
        data: {
          meanDirt,
          day: ticksToDay(tick),
          time: ticksToTimeString(tick),
        },
      })
    }
  } else if (workers > 0 || dirtyCount === 0) {
    cleaning.noCleanersNotified = false
  }

  if (workers > 0) {
    const capacity =
      workers * cfg.dirtRemovedPerCleanerPerMinute + cleaning.cleanRemainder
    const whole = Math.floor(capacity)
    cleaning.cleanRemainder = capacity - whole
    let remaining = whole

    if (indoorWorkers > 0 && dirtyIndoor.length > 0) {
      const share = Math.max(
        1,
        Math.floor((whole * indoorWorkers) / workers),
      )
      remaining -= applyCleaningPass(
        world,
        events,
        tick,
        dirtyIndoor,
        Math.min(share, remaining),
        cfg.maxTilesTouchedPerMinute,
        cleaning,
      )
    }
    if (remaining > 0 && outdoorWorkers > 0 && dirtyOutdoor.length > 0) {
      applyCleaningPass(
        world,
        events,
        tick,
        dirtyOutdoor,
        remaining,
        cfg.maxTilesTouchedPerMinute,
        cleaning,
      )
    } else if (remaining > 0 && dirtyIndoor.length > 0) {
      applyCleaningPass(
        world,
        events,
        tick,
        dirtyIndoor,
        remaining,
        cfg.maxTilesTouchedPerMinute,
        cleaning,
      )
    }
  }

  postCleanJobs(world, events, tick, dirtyIndoor, false)
  postCleanJobs(world, events, tick, dirtyOutdoor, true)
}

/* -------------------------------------------------------------------------- */
/* Cleaning pass                                                               */
/* -------------------------------------------------------------------------- */

function applyCleaningPass(
  world: InmateWorld,
  events: EventSink,
  tick: number,
  tiles: readonly number[],
  budget: number,
  maxTiles: number,
  cleaning: CleaningLogistics,
): number {
  if (budget <= 0 || tiles.length === 0) return 0
  let remaining = budget
  let touched = 0
  for (const tile of tiles) {
    if (remaining <= 0 || touched >= maxTiles) break
    const current = world.grid.dirt[tile] ?? 0
    if (current <= 0) continue
    const remove = Math.min(current, remaining)
    const next = current - remove
    world.grid.setAt('dirt', tile, next)
    remaining -= remove
    cleaning.dirtRemoved += remove
    touched += 1
    events.emit({
      tick,
      kind: CLEANING_EVENTS.tileCleaned,
      subjectId: tile,
      causeIds: [],
      data: { tileIndex: tile, removed: remove, remaining: next },
    })
  }
  return budget - remaining
}

function collectDirtyTiles(
  world: InmateWorld,
  threshold: number,
  outdoors: boolean,
): number[] {
  const grid = world.grid
  const out: number[] = []
  const want = outdoors ? 1 : 0
  for (let i = 0; i < grid.dirt.length; i += 1) {
    const dirt = grid.dirt[i] ?? 0
    if (dirt < threshold) continue
    if ((grid.outdoors[i] ?? 1) !== want) continue
    out.push(i)
  }
  // Dirtiest first so limited labour clears the worst tiles.
  out.sort((a, b) => {
    const da = grid.dirt[b] ?? 0
    const db = grid.dirt[a] ?? 0
    if (da !== db) return da - db
    return a - b
  })
  return out
}

function meanDirtyTileDirt(
  world: InmateWorld,
  indoor: readonly number[],
  outdoor: readonly number[],
): number {
  const tiles = [...indoor, ...outdoor]
  if (tiles.length === 0) return 0
  let sum = 0
  for (const tile of tiles) sum += world.grid.dirt[tile] ?? 0
  return Math.round(sum / tiles.length)
}

function postCleanJobs(
  world: InmateWorld,
  events: EventSink,
  tick: number,
  tiles: readonly number[],
  outdoors: boolean,
): void {
  const role = outdoors ? 'cleanOutdoors' : 'clean'
  for (const tile of tiles.slice(0, 16)) {
    let exists = false
    for (const job of world.jobs.open()) {
      if (job.kind === 'clean' && job.location === tile) {
        exists = true
        break
      }
    }
    if (!exists) {
      for (const job of world.jobs.claimed()) {
        if (job.kind === 'clean' && job.location === tile) {
          exists = true
          break
        }
      }
    }
    if (exists) continue
    postJob({
      world,
      kind: 'clean',
      priority: 30 + Math.min(50, world.grid.dirt[tile] ?? 0),
      location: tile,
      tick,
      events,
      requiredRole: role,
    })
  }
}

/* -------------------------------------------------------------------------- */
/* Labour counts                                                               */
/* -------------------------------------------------------------------------- */

/** Staff with `clean` plus cleaning inmates in a work block. */
export function countIndoorCleaners(world: InmateWorld, data: GameData): number {
  let count = 0
  for (const staff of world.staff.all()) {
    if (!hasCapability(data, staff, 'clean')) continue
    count += 1
  }
  for (const inmate of world.inmates.all()) {
    if (inmate.inmate.jobId !== 'cleaning') continue
    if (!isInmateInWorkBlock(world, inmate.id)) continue
    count += 1
  }
  return count
}

/** Staff with `cleanOutdoors` (groundskeepers). */
export function countOutdoorCleaners(world: InmateWorld, data: GameData): number {
  let count = 0
  for (const staff of world.staff.all()) {
    if (!hasCapability(data, staff, 'cleanOutdoors')) continue
    count += 1
  }
  return count
}

export function isInmateInWorkBlock(world: InmateWorld, inmateId: number): boolean {
  const state = world.routineRuntime.stateOf(inmateId)
  return state.blockId !== null && WORK_BLOCKS.has(state.blockId)
}

/* -------------------------------------------------------------------------- */
/* Events                                                                      */
/* -------------------------------------------------------------------------- */

function recordEvent(
  events: EventSink,
  event: {
    readonly tick: number
    readonly kind: string
    readonly subjectId: number
    readonly causeIds: readonly number[]
    readonly data: Record<string, string | number | boolean>
  },
): EventId {
  const log = events as EventSink & { record?: (e: typeof event) => { id: EventId } }
  if (typeof log.record === 'function') {
    return log.record(event).id
  }
  events.emit(event)
  return 0
}
