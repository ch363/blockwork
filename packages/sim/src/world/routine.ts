/**
 * The Routine: 24 hourly blocks per security category (T2.6, PRD 5.7).
 *
 * A block does not force an action. It constrains which room defs an inmate may
 * occupy and names a preferred need. Free / work_free blocks leave the need
 * open so Activity picks the highest reachable need, weighted by travel time.
 *
 * Sleep is refused between `sleepForbiddenFromHour` (inclusive) and
 * `sleepForbiddenUntilHour` (exclusive) regardless of the current block.
 */

import type { Fnv1aHasher } from '../core/hash'
import type { GameData } from '../data/loader'
import type { Balance, RoutineBlockId } from '../data/schemas'
import { ROUTINE_BLOCKS } from '../data/schemas'
import { NO_ROOM } from './rooms'

export { ROUTINE_BLOCKS }
export type { RoutineBlockId }

/* -------------------------------------------------------------------------- */
/* Constants                                                                   */
/* -------------------------------------------------------------------------- */

export const ROUTINE_HOURS = 24

/** CausalEvent kinds emitted by routine / activity systems. */
export const ROUTINE_EVENTS = {
  rejected: 'routine.rejected',
  hourAssigned: 'routine.hourAssigned',
} as const

export const ACTIVITY_EVENTS = {
  rejected: 'activity.rejected',
  beganUsing: 'activity.beganUsing',
  endedUsing: 'activity.endedUsing',
} as const

export type RoutineRejection = 'wrong-world' | 'unknown-block' | 'unknown-category'
export type ActivityRejection = 'wrong-world' | 'object-busy' | 'object-unusable'

/* -------------------------------------------------------------------------- */
/* Block lookup                                                                */
/* -------------------------------------------------------------------------- */

export type RoutineBlockDef = Balance['routine']['blocks'][RoutineBlockId]

export function isRoutineBlockId(value: string): value is RoutineBlockId {
  return (ROUTINE_BLOCKS as readonly string[]).includes(value)
}

/** Resolves a block id to its data-driven permitted rooms / preferred need. */
export function blockDefOf(data: GameData, blockId: RoutineBlockId): RoutineBlockDef {
  return data.balance.routine.blocks[blockId]
}

/**
 * Room defs an inmate may occupy during `blockId`.
 *
 * Pure over balance data so mapping tests do not need a world.
 */
export function permittedRoomsForBlock(data: GameData, blockId: RoutineBlockId): readonly string[] {
  return blockDefOf(data, blockId).permittedRooms
}

export function preferredNeedForBlock(data: GameData, blockId: RoutineBlockId): string | null {
  return blockDefOf(data, blockId).preferredNeed
}

/* -------------------------------------------------------------------------- */
/* Sleep rule                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * PRD 5.7: inmates will not sleep between 08:00 and 20:00.
 *
 * `from` is inclusive, `until` is exclusive — hour 8..19 with until=20.
 */
export function isSleepForbidden(hour: number, fromHour: number, untilHour: number): boolean {
  if (!Number.isInteger(hour) || hour < 0 || hour >= ROUTINE_HOURS) {
    throw new RangeError(`hour must be an integer in 0..23, received ${hour}`)
  }
  return hour >= fromHour && hour < untilHour
}

export function isSleepForbiddenAt(data: GameData, hour: number): boolean {
  const { sleepForbiddenFromHour, sleepForbiddenUntilHour } = data.balance.routine
  return isSleepForbidden(hour, sleepForbiddenFromHour, sleepForbiddenUntilHour)
}

/* -------------------------------------------------------------------------- */
/* Free-choice ranking                                                         */
/* -------------------------------------------------------------------------- */

export interface FreeChoiceOption {
  readonly needId: string
  readonly roomDefId: string
  readonly needValue: number
  /** Estimated minutes to reach a serving room (Manhattan / flow cost proxy). */
  readonly travelMinutes: number
}

/**
 * Picks the highest need any reachable room can serve, weighted by travel.
 *
 * `score = needValue - travelTimeWeight * travelMinutes`. Ties break on need
 * id then room def id so two runs with the same inputs agree.
 */
export function rankFreeChoice(
  options: readonly FreeChoiceOption[],
  travelTimeWeight: number,
): FreeChoiceOption | undefined {
  let best: FreeChoiceOption | undefined
  let bestScore = -Infinity

  for (const option of options) {
    const score = option.needValue - travelTimeWeight * option.travelMinutes
    if (best === undefined || score > bestScore) {
      best = option
      bestScore = score
      continue
    }
    if (score < bestScore) continue
    if (option.needId < best.needId) {
      best = option
      bestScore = score
      continue
    }
    if (option.needId === best.needId && option.roomDefId < best.roomDefId) {
      best = option
      bestScore = score
    }
  }

  return best
}

/* -------------------------------------------------------------------------- */
/* Schedules                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Mutable 24-block strip per security category. Edits take effect on the next
 * hour boundary (the system re-reads this map only then).
 */
export class RoutineBook {
  readonly byCategory: Map<string, RoutineBlockId[]>

  constructor(byCategory: Map<string, RoutineBlockId[]>) {
    this.byCategory = byCategory
  }

  scheduleFor(categoryId: string): readonly RoutineBlockId[] | undefined {
    return this.byCategory.get(categoryId)
  }

  blockAt(categoryId: string, hour: number): RoutineBlockId | undefined {
    return blockAtHour(this, categoryId, hour)
  }

  setCategory(categoryId: string, blocks: readonly string[]): void {
    setCategoryRoutine(this, categoryId, blocks)
  }

  /** Plain JSON shape for saves / tests. */
  toJSON(): Record<string, RoutineBlockId[]> {
    const out: Record<string, RoutineBlockId[]> = {}
    const entries = [...this.byCategory.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    for (const [category, blocks] of entries) {
      out[category] = [...blocks]
    }
    return out
  }

  hashInto(hasher: Fnv1aHasher): void {
    hashRoutineState(hasher, this)
  }
}

export function createRoutineBook(data: GameData): RoutineBook {
  const byCategory = new Map<string, RoutineBlockId[]>()
  for (const category of data.securityCategories.all) {
    const defaults = data.balance.routine.defaults[category.id]
    if (defaults === undefined) {
      throw new Error(`no default routine for security category '${category.id}'`)
    }
    byCategory.set(category.id, [...defaults])
  }
  return new RoutineBook(byCategory)
}

/** @deprecated Prefer RoutineBook; kept as the Map shape helpers still accept. */
export type RoutineState = {
  readonly byCategory: Map<string, RoutineBlockId[]>
}

export function createRoutineState(data: GameData): RoutineState {
  return createRoutineBook(data)
}

export function scheduleForCategory(
  state: RoutineState,
  categoryId: string,
): readonly RoutineBlockId[] | undefined {
  return state.byCategory.get(categoryId)
}

export function blockAtHour(
  state: RoutineState,
  categoryId: string,
  hour: number,
): RoutineBlockId | undefined {
  const schedule = state.byCategory.get(categoryId)
  if (schedule === undefined) return undefined
  if (!Number.isInteger(hour) || hour < 0 || hour >= ROUTINE_HOURS) {
    throw new RangeError(`hour must be an integer in 0..23, received ${hour}`)
  }
  return schedule[hour]
}

/**
 * Replaces one category's 24-hour strip. Invalid lengths / block ids throw so
 * a bad editor command never corrupts the schedule mid-run.
 */
export function setCategoryRoutine(
  state: RoutineState,
  categoryId: string,
  blocks: readonly string[],
): void {
  if (blocks.length !== ROUTINE_HOURS) {
    throw new RangeError(
      `routine for '${categoryId}' must have ${ROUTINE_HOURS} blocks, got ${blocks.length}`,
    )
  }
  const next: RoutineBlockId[] = []
  for (let i = 0; i < blocks.length; i += 1) {
    const block = blocks[i]
    if (block === undefined || !isRoutineBlockId(block)) {
      throw new Error(`routine for '${categoryId}' has unknown block '${block}' at hour ${i}`)
    }
    next.push(block)
  }
  state.byCategory.set(categoryId, next)
}

export function hashRoutineState(hasher: Fnv1aHasher, state: RoutineState): void {
  const entries = [...state.byCategory.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  hasher.writeUint32(entries.length)
  for (const [category, blocks] of entries) {
    hasher.writeString(category)
    hasher.writeUint32(blocks.length)
    for (const block of blocks) hasher.writeString(block)
  }
}

/* -------------------------------------------------------------------------- */
/* Per-inmate runtime                                                          */
/* -------------------------------------------------------------------------- */

/**
 * What the current hour assigned this inmate. Written by RoutineSystem;
 * ActivitySystem and (later) pathing read it.
 */
export interface InmateRoutineState {
  blockId: RoutineBlockId | null
  /** Room def ids currently permitted. Empty while not following a routine. */
  permittedRooms: readonly string[]
  preferredNeed: string | null
  /** Shared flow-field goal set, or null when own-cell / free-choice. */
  goalSetId: string | null
  /**
   * Specific tile for own-cell routing (A*), or `-1` when using a flow field /
   * no destination yet.
   */
  goalTile: number
  lockedUp: boolean
  /** Free-choice selection for this hour, when the block is free-like. */
  freeChoiceNeed: string | null
  freeChoiceRoomDef: string | null
  /** Minutes left on the current object-use session. */
  useMinutesRemaining: number
}

export function createInmateRoutineState(): InmateRoutineState {
  return {
    blockId: null,
    permittedRooms: [],
    preferredNeed: null,
    goalSetId: null,
    goalTile: -1,
    lockedUp: false,
    freeChoiceNeed: null,
    freeChoiceRoomDef: null,
    useMinutesRemaining: 0,
  }
}

/** Serializable per-inmate routine runtime (save v5). */
export interface RoutineRuntimeSnapshot {
  readonly inmates: readonly {
    readonly inmateId: number
    readonly blockId: string | null
    readonly permittedRooms: readonly string[]
    readonly preferredNeed: string | null
    readonly goalSetId: string | null
    readonly goalTile: number
    readonly lockedUp: boolean
    readonly freeChoiceNeed: string | null
    readonly freeChoiceRoomDef: string | null
    readonly useMinutesRemaining: number
  }[]
}

/**
 * Per-inmate Routine / Activity runtime, keyed by inmate id.
 *
 * Lives on `InmateWorld` so both systems share one assignment without reaching
 * into each other.
 */
export class RoutineRuntime {
  readonly #byInmate = new Map<number, InmateRoutineState>()

  stateOf(inmateId: number): InmateRoutineState {
    let state = this.#byInmate.get(inmateId)
    if (state === undefined) {
      state = createInmateRoutineState()
      this.#byInmate.set(inmateId, state)
    }
    return state
  }

  remove(inmateId: number): void {
    this.#byInmate.delete(inmateId)
  }

  hashInto(hasher: Fnv1aHasher): void {
    const ids = [...this.#byInmate.keys()].sort((a, b) => a - b)
    hasher.writeUint32(ids.length)
    for (const id of ids) {
      const state = this.#byInmate.get(id)
      if (state === undefined) continue
      hasher.writeUint32(id)
      hasher.writeString(state.blockId ?? '')
      hasher.writeUint32(state.permittedRooms.length)
      for (const room of state.permittedRooms) hasher.writeString(room)
      hasher.writeString(state.preferredNeed ?? '')
      hasher.writeString(state.goalSetId ?? '')
      hasher.writeUint32(state.goalTile < 0 ? 0xffffffff : state.goalTile)
      hasher.writeUint32(state.lockedUp ? 1 : 0)
      hasher.writeString(state.freeChoiceNeed ?? '')
      hasher.writeString(state.freeChoiceRoomDef ?? '')
      hasher.writeUint32(state.useMinutesRemaining)
    }
  }

  serialise(): RoutineRuntimeSnapshot {
    const ids = [...this.#byInmate.keys()].sort((a, b) => a - b)
    return {
      inmates: ids.flatMap((inmateId) => {
        const state = this.#byInmate.get(inmateId)
        if (state === undefined) return []
        return [
          {
            inmateId,
            blockId: state.blockId,
            permittedRooms: [...state.permittedRooms],
            preferredNeed: state.preferredNeed,
            goalSetId: state.goalSetId,
            goalTile: state.goalTile,
            lockedUp: state.lockedUp,
            freeChoiceNeed: state.freeChoiceNeed,
            freeChoiceRoomDef: state.freeChoiceRoomDef,
            useMinutesRemaining: state.useMinutesRemaining,
          },
        ]
      }),
    }
  }

  restore(snapshot: RoutineRuntimeSnapshot): void {
    this.#byInmate.clear()
    for (const entry of snapshot.inmates) {
      const state = createInmateRoutineState()
      state.blockId =
        entry.blockId !== null && isRoutineBlockId(entry.blockId) ? entry.blockId : null
      state.permittedRooms = [...entry.permittedRooms]
      state.preferredNeed = entry.preferredNeed
      state.goalSetId = entry.goalSetId
      state.goalTile = entry.goalTile
      state.lockedUp = entry.lockedUp
      state.freeChoiceNeed = entry.freeChoiceNeed
      state.freeChoiceRoomDef = entry.freeChoiceRoomDef
      state.useMinutesRemaining = entry.useMinutesRemaining
      this.#byInmate.set(entry.inmateId, state)
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Assignment helpers                                                          */
/* -------------------------------------------------------------------------- */

export interface RoutineAssignment {
  readonly blockId: RoutineBlockId
  readonly permittedRooms: readonly string[]
  readonly preferredNeed: string | null
  readonly goalSetId: string | null
  readonly goalTile: number
  readonly lockedUp: boolean
  readonly freeChoiceNeed: string | null
  readonly freeChoiceRoomDef: string | null
}

/**
 * Builds the hour's assignment for one inmate from the schedule + optional
 * free-choice pick. Own-cell goals use the assigned housing room's first tile.
 */
export function assignRoutineHour(options: {
  readonly data: GameData
  readonly blockId: RoutineBlockId
  readonly cellId: number
  readonly cellTile: number
  readonly freeChoice?: FreeChoiceOption
}): RoutineAssignment {
  const { data, blockId, freeChoice } = options
  const def = blockDefOf(data, blockId)

  let preferredNeed = def.preferredNeed
  let goalSetId = def.goalSet
  let goalTile = -1
  let freeChoiceNeed: string | null = null
  let freeChoiceRoomDef: string | null = null
  let lockedUp = def.lockedUp

  if (freeChoice !== undefined) {
    preferredNeed = freeChoice.needId
    freeChoiceNeed = freeChoice.needId
    freeChoiceRoomDef = freeChoice.roomDefId
    goalSetId = goalSetForNeed(freeChoice.needId)
    // Free-choice unlocks from lockup-style work_lockup when pursuing a need
    // outside the cell (unassigned work_lockup otherwise stays locked).
    if (goalSetId !== null || freeChoice.roomDefId !== 'cell') {
      lockedUp = false
    }
  } else if (def.ownCell && options.cellId !== NO_ROOM) {
    goalTile = options.cellTile
    goalSetId = null
  }

  return {
    blockId,
    permittedRooms: def.permittedRooms,
    preferredNeed,
    goalSetId,
    goalTile,
    lockedUp,
    freeChoiceNeed,
    freeChoiceRoomDef,
  }
}

/** Maps a need to a shared flow-field goal when one exists (T2.2). */
export function goalSetForNeed(needId: string): string | null {
  switch (needId) {
    case 'food':
      return 'serving_counter'
    case 'hygiene':
      return 'shower_head'
    case 'bladder':
      return 'toilet'
    case 'exercise':
    case 'freedom':
      return 'yard'
    default:
      return null
  }
}

/**
 * Session length for discharging `needId` from `needValue`, clamped by balance.
 */
export function sessionMinutesForNeed(data: GameData, needId: string, needValue: number): number {
  const { minSessionMinutes, maxSessionMinutes } = data.balance.routine
  const def = data.needs.find(needId)
  if (def === undefined || def.decayOnUse <= 0) {
    return minSessionMinutes
  }
  const raw = Math.ceil(needValue / def.decayOnUse)
  if (raw < minSessionMinutes) return minSessionMinutes
  if (raw > maxSessionMinutes) return maxSessionMinutes
  return raw
}

/** Manhattan tile distance — free-choice travel proxy (flow costs used for motion). */
export function manhattanTiles(ax: number, ay: number, bx: number, by: number): number {
  return Math.abs(ax - bx) + Math.abs(ay - by)
}
