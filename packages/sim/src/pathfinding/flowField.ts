/**
 * Pathfinding layer 2: shared flow fields (T2.2, PRD 4.5).
 *
 * Hundreds of agents heading for the same class of destination share one
 * precomputed direction grid. Generation expands from every goal tile with a
 * multi-source BFS (uniform orthogonal cost — a Dijkstra special case),
 * respects an access mask (staff-only doors and, later, sector permissions),
 * and stores a direction index per tile so each agent only samples its
 * current cell.
 *
 * Fields are cached by `(goalSetId, accessMask)`, built lazily on first
 * request, and regenerated under a per-tick budget (`balance.pathfinding.
 * flowFieldsPerTick`). Dirty chunks that intersect a field drop it so the
 * next request re-queues generation.
 *
 * Standard goal sets (serving counter, shower, toilet, yard, exit, work
 * stations) are maintained from world state. An inmate's own cell is
 * deliberately **not** a flow field — it is per-agent and belongs to A*
 * (T2.3).
 */

import type { GameData } from '../data/loader'

import type { ObjectRegistry } from '../entities/objects'
import { ACCESS } from './regionGraph'
import type { SectorAccessView } from './regionGraph'
import { CHUNK_SIZE, chunkIdOfIndex, chunksPerAxis } from '../world/coords'
import type { MaterialTable } from '../world/materials'
import type { RoomRegistry } from '../world/rooms'
import { PASSABILITY } from '../world/tileGrid'
import type { TileGrid } from '../world/tileGrid'

/* -------------------------------------------------------------------------- */
/* Directions                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Direction indices stored in a `FlowField`.
 *
 * 0..7 are the eight neighbours in clockwise order from north. `NONE` (8) means
 * the tile is a goal, unreachable, or impassable — an agent standing on it
 * should not step from the field.
 */
export const FLOW_DIR = {
  N: 0,
  NE: 1,
  E: 2,
  SE: 3,
  S: 4,
  SW: 5,
  W: 6,
  NW: 7,
  NONE: 8,
} as const

export type FlowDir = (typeof FLOW_DIR)[keyof typeof FLOW_DIR]

/** Octile step cost for an orthogonal neighbour. Geometric, not a balance knob. */
export const FLOW_COST_ORTH = 10

/** Octile step cost for a diagonal neighbour (≈ √2 × orthogonal). */
export const FLOW_COST_DIAG = 14

/** Unreached integration cost. Fits in a `Uint32Array`. */
export const FLOW_COST_INF = 0xffffffff

/**
 * The eight neighbours, fixed order matching `FLOW_DIR`.
 *
 * `dir` is the direction an agent at the neighbour must step to reach the
 * current tile (i.e. the reverse of the expansion offset).
 */
export const FLOW_NEIGHBOURS: readonly {
  readonly dx: number
  readonly dy: number
  /** Direction index stored on the neighbour when expanded from current. */
  readonly dir: FlowDir
  readonly cost: number
}[] = [
  { dx: 0, dy: -1, dir: FLOW_DIR.S, cost: FLOW_COST_ORTH },
  { dx: 1, dy: -1, dir: FLOW_DIR.SW, cost: FLOW_COST_DIAG },
  { dx: 1, dy: 0, dir: FLOW_DIR.W, cost: FLOW_COST_ORTH },
  { dx: 1, dy: 1, dir: FLOW_DIR.NW, cost: FLOW_COST_DIAG },
  { dx: 0, dy: 1, dir: FLOW_DIR.N, cost: FLOW_COST_ORTH },
  { dx: -1, dy: 1, dir: FLOW_DIR.NE, cost: FLOW_COST_DIAG },
  { dx: -1, dy: 0, dir: FLOW_DIR.E, cost: FLOW_COST_ORTH },
  { dx: -1, dy: -1, dir: FLOW_DIR.SE, cost: FLOW_COST_DIAG },
]

/** Offset an agent applies when following a direction index. */
export const FLOW_STEP: readonly (readonly [number, number])[] = [
  [0, -1],
  [1, -1],
  [1, 0],
  [1, 1],
  [0, 1],
  [-1, 1],
  [-1, 0],
  [-1, -1],
]

/* -------------------------------------------------------------------------- */
/* Goal set ids                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Stable ids for the shared destination classes (T2.2).
 *
 * Work stations are `work:<objectDefId>` via `workStationGoalSetId`. Own-cell
 * routing is per inmate and must not appear here.
 */
export const GOAL_SET = {
  SERVING_COUNTER: 'serving_counter',
  SHOWER_HEAD: 'shower_head',
  TOILET: 'toilet',
  YARD: 'yard',
  EXIT: 'exit',
} as const

export type StandardGoalSetId = (typeof GOAL_SET)[keyof typeof GOAL_SET]

/** Room def id whose walkable tiles feed the yard goal set. */
export const YARD_ROOM_ID = 'exercise_yard'

/** Floor material treated as the road / exit surface when refreshing goals. */
export const EXIT_FLOOR_MATERIAL = 'asphalt'

/** Object def ids that are fixed standard goal sets (not work stations). */
export const STANDARD_OBJECT_GOAL_DEFS: Readonly<Record<string, StandardGoalSetId>> = {
  serving_counter: GOAL_SET.SERVING_COUNTER,
  shower_head: GOAL_SET.SHOWER_HEAD,
  toilet: GOAL_SET.TOILET,
}

export function workStationGoalSetId(objectDefId: string): string {
  return `work:${objectDefId}`
}

export function isWorkStationGoalSet(goalSetId: string): boolean {
  return goalSetId.startsWith('work:')
}

/* -------------------------------------------------------------------------- */
/* Passability                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Whether an agent with `accessMask` may enter a tile during field generation.
 *
 * Walkability is required. Staff-only tiles need the staff bit — which is also
 * how a `staffOnly` sector filters, since it stamps that bit onto its tiles.
 * A sector's per-category restriction is a separate test, applied by
 * {@link generateFlowField} where the sector table is available.
 */
export function tilePassableForAccess(passability: number, accessMask: number): boolean {
  if ((passability & PASSABILITY.WALKABLE) === 0) return false
  if ((passability & PASSABILITY.STAFF_ONLY) !== 0) {
    return (accessMask & ACCESS.STAFF) !== 0
  }
  return true
}

/* -------------------------------------------------------------------------- */
/* Field record                                                                */
/* -------------------------------------------------------------------------- */

/**
 * One shared direction grid for a `(goalSetId, accessMask)` key.
 *
 * `directions[tile]` is a `FLOW_DIR` index. `costs` is the integration field
 * used while building and retained so tests (and later avoidance) can read
 * distance without rebuilding.
 */
export interface FlowField {
  readonly goalSetId: string
  readonly accessMask: number
  readonly size: number
  readonly directions: Uint8Array
  readonly costs: Uint32Array
  /** Chunks that contain at least one reached tile; used for invalidation. */
  readonly coveredChunks: ReadonlySet<number>
}

export interface FlowFieldGenerateResult {
  readonly field: FlowField
  /** Tiles that received a finite cost, including goals. */
  readonly reached: number
}

/* -------------------------------------------------------------------------- */
/* Pure generation                                                             */
/* -------------------------------------------------------------------------- */

/* Scratch walk/closed buffers reused for the same map size. */
let scratchSize = 0
let scratchWalk = new Uint8Array(0)
let scratchClosed = new Uint8Array(0)
let scratchQueue = new Int32Array(0)

function acquireScratch(total: number): {
  walk: Uint8Array
  closed: Uint8Array
  queue: Int32Array
} {
  if (scratchSize !== total) {
    scratchSize = total
    scratchWalk = new Uint8Array(total)
    scratchClosed = new Uint8Array(total)
    scratchQueue = new Int32Array(total)
  }
  return { walk: scratchWalk, closed: scratchClosed, queue: scratchQueue }
}

/**
 * Multi-source BFS flow field from one or more goal tiles.
 *
 * Integration is **four-connected** with uniform orthogonal cost
 * (`FLOW_COST_ORTH`). Direction indices still span 0..8 so diagonal steps
 * remain representable for local avoidance (T2.3); generation writes the four
 * orthogonal downhill directions. This keeps a 220×220 field inside the 6ms
 * budget (T2.2) while matching brute-force BFS on the same grid.
 *
 * Goal tiles that fail the passability test are skipped — callers must supply
 * standable tiles.
 *
 * `sectors`, when supplied, additionally refuses tiles whose sector does not
 * admit `accessMask` (T4.1). Fields are already keyed by access mask, so a
 * restricted sector simply does not appear in the field a refused category
 * shares.
 */
export function generateFlowField(
  grid: TileGrid,
  goals: readonly number[],
  accessMask: number,
  goalSetId = '',
  sectors?: SectorAccessView,
): FlowFieldGenerateResult {
  const size = grid.size
  const total = size * size
  const directions = new Uint8Array(total)
  const costs = new Uint32Array(total)
  directions.fill(FLOW_DIR.NONE)
  costs.fill(FLOW_COST_INF)

  const scratch = acquireScratch(total)
  const walk = scratch.walk
  const closed = scratch.closed
  const queue = scratch.queue
  walk.fill(0)
  closed.fill(0)

  const pass = grid.passability
  const sectorOf = grid.sectorId
  for (let i = 0; i < total; i += 1) {
    const p = pass[i] ?? 0
    if ((p & PASSABILITY.WALKABLE) === 0) continue
    if ((p & PASSABILITY.STAFF_ONLY) !== 0 && (accessMask & ACCESS.STAFF) === 0) continue
    if (sectors !== undefined) {
      const sectorId = sectorOf[i] ?? 0
      if (sectorId !== 0 && (sectors.maskOfSector(sectorId) & accessMask) === 0) continue
    }
    walk[i] = 1
  }

  let qHead = 0
  let qTail = 0
  let reached = 0
  let minX = size
  let minY = size
  let maxX = -1
  let maxY = -1

  for (let g = 0; g < goals.length; g += 1) {
    const goal = goals[g]
    if (goal === undefined || goal < 0 || goal >= total) continue
    if (walk[goal] !== 1) continue
    if ((costs[goal] ?? FLOW_COST_INF) !== FLOW_COST_INF) continue
    costs[goal] = 0
    directions[goal] = FLOW_DIR.NONE
    queue[qTail] = goal
    qTail += 1
  }

  // Four-connected expansion offsets and the reverse direction stored on the
  // neighbour (the step an agent takes to move toward the current tile).
  const odx = [0, 1, 0, -1]
  const ody = [-1, 0, 1, 0]
  const odir = [FLOW_DIR.S, FLOW_DIR.W, FLOW_DIR.N, FLOW_DIR.E]

  while (qHead < qTail) {
    const tile = queue[qHead] ?? 0
    qHead += 1
    if (closed[tile] === 1) continue
    closed[tile] = 1
    reached += 1

    const cost = costs[tile] ?? FLOW_COST_INF
    const y = (tile / size) | 0
    const x = tile - y * size
    if (x < minX) minX = x
    if (x > maxX) maxX = x
    if (y < minY) minY = y
    if (y > maxY) maxY = y

    for (let n = 0; n < 4; n += 1) {
      const nx = x + (odx[n] ?? 0)
      const ny = y + (ody[n] ?? 0)
      if (nx < 0 || ny < 0 || nx >= size || ny >= size) continue
      const next = ny * size + nx
      if (walk[next] !== 1) continue
      const prior = costs[next] ?? FLOW_COST_INF
      const nextCost = cost + FLOW_COST_ORTH
      if (nextCost >= prior) continue
      costs[next] = nextCost
      directions[next] = odir[n] ?? FLOW_DIR.NONE
      queue[qTail] = next
      qTail += 1
    }
  }

  const coveredChunks = new Set<number>()
  if (reached > 0 && maxX >= minX) {
    const perAxis = chunksPerAxis(size)
    const c0 = (minX / CHUNK_SIZE) | 0
    const c1 = (maxX / CHUNK_SIZE) | 0
    const r0 = (minY / CHUNK_SIZE) | 0
    const r1 = (maxY / CHUNK_SIZE) | 0
    for (let row = r0; row <= r1; row += 1) {
      for (let col = c0; col <= c1; col += 1) {
        coveredChunks.add(row * perAxis + col)
      }
    }
  }

  return {
    field: {
      goalSetId,
      accessMask,
      size,
      directions,
      costs,
      coveredChunks,
    },
    reached,
  }
}

/**
 * Brute-force integration costs with the same rules as `generateFlowField`.
 *
 * Four-connected uniform orthogonal cost, relaxed to a fixed point. Used by
 * tests to assert field correctness without trusting the queue.
 */
export function bruteForceIntegrationCosts(
  grid: TileGrid,
  goals: readonly number[],
  accessMask: number,
): Uint32Array {
  const size = grid.size
  const total = size * size
  const costs = new Uint32Array(total)
  costs.fill(FLOW_COST_INF)
  const pass = grid.passability

  for (const goal of goals) {
    if (goal < 0 || goal >= total) continue
    if (!tilePassableForAccess(pass[goal] ?? 0, accessMask)) continue
    costs[goal] = 0
  }

  const odx = [0, 1, 0, -1]
  const ody = [-1, 0, 1, 0]

  let changed = true
  while (changed) {
    changed = false
    for (let tile = 0; tile < total; tile += 1) {
      const cost = costs[tile] ?? FLOW_COST_INF
      if (cost === FLOW_COST_INF) continue
      if (!tilePassableForAccess(pass[tile] ?? 0, accessMask)) continue

      const y = (tile / size) | 0
      const x = tile - y * size

      for (let n = 0; n < 4; n += 1) {
        const nx = x + (odx[n] ?? 0)
        const ny = y + (ody[n] ?? 0)
        if (nx < 0 || ny < 0 || nx >= size || ny >= size) continue
        const next = ny * size + nx
        if (!tilePassableForAccess(pass[next] ?? 0, accessMask)) continue
        const nextCost = cost + FLOW_COST_ORTH
        const prior = costs[next] ?? FLOW_COST_INF
        if (nextCost < prior) {
          costs[next] = nextCost
          changed = true
        }
      }
    }
  }

  return costs
}

/* -------------------------------------------------------------------------- */
/* Goal maintenance                                                            */
/* -------------------------------------------------------------------------- */

/** World views needed to refresh the standard goal sets. */
export interface FlowGoalSources {
  readonly grid: TileGrid
  readonly objects: ObjectRegistry
  readonly rooms: RoomRegistry
  readonly materials: MaterialTable
  readonly data: GameData
}

/**
 * Walkable tiles an agent may stand on to use an object.
 *
 * Floor objects contribute their walkable footprint tiles. Wall fixtures
 * (shower heads) contribute the adjoining walkable tiles instead.
 */
export function standTilesForObject(
  grid: TileGrid,
  tiles: readonly number[],
  accessMask: number,
): number[] {
  const standable: number[] = []
  for (const tile of tiles) {
    if (tilePassableForAccess(grid.passability[tile] ?? 0, accessMask)) {
      standable.push(tile)
    }
  }
  if (standable.length > 0) return uniqueSorted(standable)

  const size = grid.size
  const adjacent = new Set<number>()
  for (const tile of tiles) {
    const y = (tile / size) | 0
    const x = tile - y * size
    for (const [dx, dy] of [
      [0, -1],
      [1, 0],
      [0, 1],
      [-1, 0],
    ] as const) {
      const nx = x + dx
      const ny = y + dy
      if (nx < 0 || ny < 0 || nx >= size || ny >= size) continue
      const next = ny * size + nx
      if (tilePassableForAccess(grid.passability[next] ?? 0, accessMask)) {
        adjacent.add(next)
      }
    }
  }
  return uniqueSorted(adjacent)
}

/**
 * Collects goal tiles for every standard and work-station goal set.
 *
 * Object goals ignore access (tiles are filtered again at generation time).
 * Yard uses `exercise_yard` room tiles. Exit uses asphalt floor tiles. Work
 * stations come from every room def that declares `jobSlots`.
 */
export function collectStandardGoals(sources: FlowGoalSources): Map<string, number[]> {
  const { grid, objects, rooms, materials, data } = sources
  const out = new Map<string, number[]>()

  const ensure = (id: string): number[] => {
    let list = out.get(id)
    if (list === undefined) {
      list = []
      out.set(id, list)
    }
    return list
  }

  for (const id of Object.values(GOAL_SET)) ensure(id)

  const workObjectIds = new Set<string>()
  for (const room of data.rooms.all) {
    if (room.jobSlots !== undefined) workObjectIds.add(room.jobSlots.objectId)
  }
  for (const objectId of workObjectIds) ensure(workStationGoalSetId(objectId))

  for (const entity of objects.all()) {
    const standard = STANDARD_OBJECT_GOAL_DEFS[entity.object.defId]
    if (standard !== undefined) {
      ensure(standard).push(
        ...standTilesForObject(grid, entity.object.tiles, ACCESS.STAFF | ACCESS.INMATE),
      )
      continue
    }
    if (workObjectIds.has(entity.object.defId)) {
      ensure(workStationGoalSetId(entity.object.defId)).push(
        ...standTilesForObject(grid, entity.object.tiles, ACCESS.STAFF | ACCESS.INMATE),
      )
    }
  }

  for (const room of rooms.all()) {
    if (room.defId !== YARD_ROOM_ID) continue
    for (const tile of room.tiles) {
      if (tilePassableForAccess(grid.passability[tile] ?? 0, ACCESS.STAFF | ACCESS.INMATE)) {
        ensure(GOAL_SET.YARD).push(tile)
      }
    }
  }

  const asphalt = materials.tryIndexOf(EXIT_FLOOR_MATERIAL)
  if (asphalt !== undefined && asphalt > 0) {
    const floors = grid.floorMaterial
    const total = grid.tileCount
    for (let tile = 0; tile < total; tile += 1) {
      if (floors[tile] !== asphalt) continue
      if (!tilePassableForAccess(grid.passability[tile] ?? 0, ACCESS.STAFF | ACCESS.INMATE)) {
        continue
      }
      ensure(GOAL_SET.EXIT).push(tile)
    }
  }

  for (const [id, tiles] of out) {
    out.set(id, uniqueSorted(tiles))
  }
  return out
}

/* -------------------------------------------------------------------------- */
/* Cache                                                                       */
/* -------------------------------------------------------------------------- */

export interface FlowFieldCacheOptions {
  /** `balance.pathfinding.flowFieldsPerTick`. */
  readonly flowFieldsPerTick: number
}

export interface FlowFieldTickResult {
  /** Fields generated this tick, at most `flowFieldsPerTick`. */
  readonly generated: number
  /** Pending requests still waiting on budget. */
  readonly pending: number
  /** Cached fields dropped because a dirty chunk intersected them. */
  readonly invalidated: number
}

interface CacheEntry {
  field: FlowField | null
  /** True while waiting for a budgeted generation pass. */
  pending: boolean
}

/**
 * Lazy, budgeted cache of flow fields keyed by `(goalSetId, accessMask)`.
 *
 * Callers `setGoals` (or `refreshStandardGoals`) when destinations change,
 * `markDirtyChunks` when passability changes, `request` when an agent needs a
 * field, and `tick` once per simulation step to spend the generation budget.
 */
export class FlowFieldCache {
  readonly size: number
  readonly flowFieldsPerTick: number

  readonly #goals = new Map<string, number[]>()
  readonly #entries = new Map<string, CacheEntry>()
  readonly #queue: string[] = []
  readonly #queued = new Set<string>()
  readonly #dirtyChunks = new Set<number>()

  constructor(size: number, options: FlowFieldCacheOptions) {
    this.size = size
    this.flowFieldsPerTick = options.flowFieldsPerTick
  }

  /** Goal tiles currently registered for a set, ascending. */
  goalsOf(goalSetId: string): readonly number[] {
    return this.#goals.get(goalSetId) ?? EMPTY_GOALS
  }

  get pendingCount(): number {
    return this.#queue.length
  }

  get cachedCount(): number {
    let count = 0
    for (const entry of this.#entries.values()) {
      if (entry.field !== null) count += 1
    }
    return count
  }

  /**
   * Replaces the goal tiles for a set and drops every cached field that used
   * it. An empty list leaves the set registered but unusable until goals
   * return.
   */
  setGoals(goalSetId: string, tiles: readonly number[]): void {
    this.#goals.set(goalSetId, uniqueSorted(tiles))
    this.#invalidateGoalSet(goalSetId)
  }

  /** Rebuilds every standard and work-station goal set from the world. */
  refreshStandardGoals(sources: FlowGoalSources): void {
    const collected = collectStandardGoals(sources)
    for (const [goalSetId, tiles] of collected) {
      this.setGoals(goalSetId, tiles)
    }
  }

  /** Announces chunks whose passability (or door access) changed. */
  markDirtyChunks(chunks: Iterable<number>): void {
    for (const chunk of chunks) this.#dirtyChunks.add(chunk)
  }

  markDirtyTiles(tiles: Iterable<number>): void {
    for (const tile of tiles) {
      if (tile < 0 || tile >= this.size * this.size) continue
      this.#dirtyChunks.add(chunkIdOfIndex(tile, this.size))
    }
  }

  /**
   * Returns a ready field, or `null` while generation is pending / goals are
   * empty. First request enqueues work; `tick` spends the budget.
   */
  request(goalSetId: string, accessMask: number): FlowField | null {
    this.#applyDirty()
    const key = cacheKey(goalSetId, accessMask)
    const existing = this.#entries.get(key)
    if (existing?.field !== null && existing?.field !== undefined) {
      return existing.field
    }

    const goals = this.#goals.get(goalSetId)
    if (goals === undefined || goals.length === 0) return null

    if (existing === undefined) {
      this.#entries.set(key, { field: null, pending: true })
      this.#enqueue(key)
    } else if (!existing.pending) {
      existing.pending = true
      this.#enqueue(key)
    }

    return null
  }

  /** Peek without enqueueing. */
  get(goalSetId: string, accessMask: number): FlowField | null {
    this.#applyDirty()
    return this.#entries.get(cacheKey(goalSetId, accessMask))?.field ?? null
  }

  /**
   * Spends this tick's generation budget.
   *
   * At most `flowFieldsPerTick` fields are built. Dirty chunks are applied
   * first so a wall change never regenerates a stale field.
   */
  tick(grid: TileGrid, sectors?: SectorAccessView): FlowFieldTickResult {
    const invalidated = this.#applyDirty()
    let generated = 0

    while (generated < this.flowFieldsPerTick && this.#queue.length > 0) {
      const key = this.#queue.shift()
      if (key === undefined) break
      this.#queued.delete(key)

      const parsed = parseCacheKey(key)
      if (parsed === null) continue
      const { goalSetId, accessMask } = parsed
      const goals = this.#goals.get(goalSetId)
      const entry = this.#entries.get(key)
      if (entry === undefined) continue
      entry.pending = false

      if (goals === undefined || goals.length === 0) {
        entry.field = null
        continue
      }

      const { field } = generateFlowField(grid, goals, accessMask, goalSetId, sectors)
      entry.field = field
      generated += 1
    }

    return {
      generated,
      pending: this.#queue.length,
      invalidated,
    }
  }

  /* -- internals ------------------------------------------------------------ */

  #enqueue(key: string): void {
    if (this.#queued.has(key)) return
    this.#queued.add(key)
    this.#queue.push(key)
  }

  #invalidateGoalSet(goalSetId: string): void {
    for (const [key, entry] of this.#entries) {
      const parsed = parseCacheKey(key)
      if (parsed === null || parsed.goalSetId !== goalSetId) continue
      entry.field = null
      entry.pending = false
      this.#queued.delete(key)
    }
    // Drop queued keys for this goal set so a refresh does not rebuild with
    // the old tile list still pending ahead of a new request.
    const remaining: string[] = []
    for (const key of this.#queue) {
      const parsed = parseCacheKey(key)
      if (parsed !== null && parsed.goalSetId === goalSetId) {
        this.#queued.delete(key)
        continue
      }
      remaining.push(key)
    }
    this.#queue.length = 0
    this.#queue.push(...remaining)
  }

  #applyDirty(): number {
    if (this.#dirtyChunks.size === 0) return 0
    const dirty = [...this.#dirtyChunks]
    this.#dirtyChunks.clear()

    let invalidated = 0
    for (const [, entry] of this.#entries) {
      const field = entry.field
      if (field === null) continue
      let hit = false
      for (const chunk of dirty) {
        if (field.coveredChunks.has(chunk)) {
          hit = true
          break
        }
      }
      if (!hit) continue
      entry.field = null
      entry.pending = false
      invalidated += 1
    }

    if (invalidated > 0) {
      const remaining: string[] = []
      for (const key of this.#queue) {
        const entry = this.#entries.get(key)
        if (entry !== undefined && entry.field === null && !entry.pending) {
          this.#queued.delete(key)
          continue
        }
        remaining.push(key)
      }
      this.#queue.length = 0
      this.#queue.push(...remaining)
    }

    return invalidated
  }
}

/* -------------------------------------------------------------------------- */
/* Keys and helpers                                                            */
/* -------------------------------------------------------------------------- */

const EMPTY_GOALS: readonly number[] = Object.freeze([])

function cacheKey(goalSetId: string, accessMask: number): string {
  return `${goalSetId}\0${accessMask}`
}

function parseCacheKey(key: string): { goalSetId: string; accessMask: number } | null {
  const split = key.indexOf('\0')
  if (split < 0) return null
  const goalSetId = key.slice(0, split)
  const accessMask = Number(key.slice(split + 1))
  if (!Number.isInteger(accessMask)) return null
  return { goalSetId, accessMask }
}

function uniqueSorted(values: Iterable<number>): number[] {
  return [...new Set(values)].sort((a, b) => a - b)
}

/** Exported for tests that assert chunk coverage math. */
export function chunksCoveredByTiles(tiles: readonly number[], size: number): Set<number> {
  const covered = new Set<number>()
  for (const tile of tiles) covered.add(chunkIdOfIndex(tile, size))
  return covered
}
