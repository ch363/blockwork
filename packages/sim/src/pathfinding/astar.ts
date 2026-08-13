/**
 * Pathfinding layer 3: budgeted per-agent A* (T2.3, PRD 4.5).
 *
 * One-off destinations (a specific tile, an inmate's own cell) use A* rather
 * than a shared flow field. Search is bounded by the region-graph corridor
 * from layer 1, so expansion never fans out over the whole map — only the
 * rooms and door tiles on the coarse path are walkable for the search.
 *
 * Costs are octile (orthogonal 10, diagonal 14). Diagonal steps are refused
 * when either orthogonal neighbour is impassable, matching the movement
 * system's corner-cutting rule so a returned path is always steppable.
 *
 * Searches are budgeted: at most `balance.pathfinding.astarSearchesPerTick`
 * complete per tick. Over-budget requests stay queued and the agent idles.
 */

import { FLOW_COST_DIAG, FLOW_COST_ORTH, tilePassableForAccess } from './flowField'
import { NO_REGION, REGION_NEIGHBOURS } from './regionGraph'
import type { RegionGraph } from './regionGraph'
import { PASSABILITY } from '../world/tileGrid'
import type { TileGrid } from '../world/tileGrid'

/* -------------------------------------------------------------------------- */
/* Neighbours                                                                  */
/* -------------------------------------------------------------------------- */

/** Eight neighbours in the same clockwise-from-north order as flow fields. */
const ASTAR_NEIGHBOURS: readonly {
  readonly dx: number
  readonly dy: number
  readonly cost: number
  readonly diagonal: boolean
}[] = [
  { dx: 0, dy: -1, cost: FLOW_COST_ORTH, diagonal: false },
  { dx: 1, dy: -1, cost: FLOW_COST_DIAG, diagonal: true },
  { dx: 1, dy: 0, cost: FLOW_COST_ORTH, diagonal: false },
  { dx: 1, dy: 1, cost: FLOW_COST_DIAG, diagonal: true },
  { dx: 0, dy: 1, cost: FLOW_COST_ORTH, diagonal: false },
  { dx: -1, dy: 1, cost: FLOW_COST_DIAG, diagonal: true },
  { dx: -1, dy: 0, cost: FLOW_COST_ORTH, diagonal: false },
  { dx: -1, dy: -1, cost: FLOW_COST_DIAG, diagonal: true },
]

/* -------------------------------------------------------------------------- */
/* Binary min-heap                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Binary heap keyed by `(f, g, tile)` so equal-f ties break deterministically.
 *
 * Stores parallel arrays rather than object nodes: A* pushes and pops tens of
 * thousands of entries on a busy tick, and object churn would dominate the
 * pathfinding budget.
 */
export class BinaryHeap {
  readonly #f: number[] = []
  readonly #g: number[] = []
  readonly #tile: number[] = []

  get size(): number {
    return this.#tile.length
  }

  clear(): void {
    this.#f.length = 0
    this.#g.length = 0
    this.#tile.length = 0
  }

  push(tile: number, f: number, g: number): void {
    this.#tile.push(tile)
    this.#f.push(f)
    this.#g.push(g)
    this.#siftUp(this.#tile.length - 1)
  }

  pop(): { tile: number; f: number; g: number } | undefined {
    const n = this.#tile.length
    if (n === 0) return undefined
    const tile = this.#tile[0] ?? 0
    const f = this.#f[0] ?? 0
    const g = this.#g[0] ?? 0
    const last = n - 1
    if (last > 0) {
      this.#tile[0] = this.#tile[last] ?? 0
      this.#f[0] = this.#f[last] ?? 0
      this.#g[0] = this.#g[last] ?? 0
    }
    this.#tile.pop()
    this.#f.pop()
    this.#g.pop()
    if (this.#tile.length > 1) this.#siftDown(0)
    return { tile, f, g }
  }

  #less(i: number, j: number): boolean {
    const fi = this.#f[i] ?? 0
    const fj = this.#f[j] ?? 0
    if (fi !== fj) return fi < fj
    const gi = this.#g[i] ?? 0
    const gj = this.#g[j] ?? 0
    if (gi !== gj) return gi < gj
    return (this.#tile[i] ?? 0) < (this.#tile[j] ?? 0)
  }

  #siftUp(index: number): void {
    let i = index
    while (i > 0) {
      const parent = (i - 1) >> 1
      if (!this.#less(i, parent)) break
      this.#swap(i, parent)
      i = parent
    }
  }

  #siftDown(index: number): void {
    let i = index
    const n = this.#tile.length
    for (;;) {
      const left = i * 2 + 1
      const right = left + 1
      let best = i
      if (left < n && this.#less(left, best)) best = left
      if (right < n && this.#less(right, best)) best = right
      if (best === i) break
      this.#swap(i, best)
      i = best
    }
  }

  #swap(i: number, j: number): void {
    const tf = this.#f[i] ?? 0
    const tg = this.#g[i] ?? 0
    const tt = this.#tile[i] ?? 0
    this.#f[i] = this.#f[j] ?? 0
    this.#g[i] = this.#g[j] ?? 0
    this.#tile[i] = this.#tile[j] ?? 0
    this.#f[j] = tf
    this.#g[j] = tg
    this.#tile[j] = tt
  }
}

/* -------------------------------------------------------------------------- */
/* Heuristic and bound                                                         */
/* -------------------------------------------------------------------------- */

/** Octile distance in the same units as step costs. */
export function octileHeuristic(ax: number, ay: number, bx: number, by: number): number {
  const dx = ax < bx ? bx - ax : ax - bx
  const dy = ay < by ? by - ay : ay - by
  return (
    FLOW_COST_ORTH * (dx > dy ? dx : dy) + (FLOW_COST_DIAG - FLOW_COST_ORTH) * (dx < dy ? dx : dy)
  )
}

/**
 * Marks every tile A* may expand into for a coarse region corridor.
 *
 * Region members on the path are included, plus every door tile that hops
 * between consecutive regions with a permitted edge. Start and goal are always
 * marked so a search that begins or ends on a door still closes.
 */
export function buildRegionBound(
  graph: RegionGraph,
  grid: TileGrid,
  regionPath: readonly number[],
  accessMask: number,
  startTile: number,
  goalTile: number,
): Uint8Array {
  const total = grid.tileCount
  const allowed = new Uint8Array(total)

  for (const regionId of regionPath) {
    const region = graph.getRegion(regionId)
    if (region === undefined) continue
    for (const tile of region.tiles) allowed[tile] = 1
  }

  for (let i = 0; i < regionPath.length - 1; i += 1) {
    const from = regionPath[i]
    const to = regionPath[i + 1]
    if (from === undefined || to === undefined) continue
    for (const edge of graph.edgesFrom(from)) {
      if (edge.to !== to) continue
      if ((edge.accessMask & accessMask) === 0) continue
      if (edge.doorTile >= 0 && edge.doorTile < total) allowed[edge.doorTile] = 1
    }
  }

  if (startTile >= 0 && startTile < total) allowed[startTile] = 1
  if (goalTile >= 0 && goalTile < total) allowed[goalTile] = 1

  return allowed
}

/**
 * Coarse region id for a tile, or a neighbouring region when the tile is a
 * door (doors are not region members — they are the edges between them).
 */
export function regionForPathing(graph: RegionGraph, grid: TileGrid, tile: number): number {
  const direct = graph.regionAt(tile)
  if (direct !== NO_REGION) return direct

  const pass = grid.passability[tile] ?? 0
  if ((pass & PASSABILITY.DOOR) === 0) return NO_REGION

  const size = grid.size
  const y = (tile / size) | 0
  const x = tile - y * size
  let best = NO_REGION
  for (const [dx, dy] of REGION_NEIGHBOURS) {
    const nx = x + dx
    const ny = y + dy
    if (nx < 0 || ny < 0 || nx >= size || ny >= size) continue
    const neighbour = graph.regionAt(ny * size + nx)
    if (neighbour === NO_REGION) continue
    if (best === NO_REGION || neighbour < best) best = neighbour
  }
  return best
}

/* -------------------------------------------------------------------------- */
/* Scratch buffers                                                             */
/* -------------------------------------------------------------------------- */

let scratchSize = 0
let scratchG = new Uint32Array(0)
let scratchParent = new Int32Array(0)
let scratchClosed = new Uint8Array(0)
const scratchHeap = new BinaryHeap()

function acquireAStarScratch(total: number): {
  g: Uint32Array
  parent: Int32Array
  closed: Uint8Array
  heap: BinaryHeap
} {
  if (scratchSize !== total) {
    scratchSize = total
    scratchG = new Uint32Array(total)
    scratchParent = new Int32Array(total)
    scratchClosed = new Uint8Array(total)
  }
  scratchHeap.clear()
  return { g: scratchG, parent: scratchParent, closed: scratchClosed, heap: scratchHeap }
}

const G_INF = 0xffffffff

/* -------------------------------------------------------------------------- */
/* Search                                                                      */
/* -------------------------------------------------------------------------- */

export interface AStarResult {
  /** Tile indices from start to goal inclusive, or `null` when unreachable. */
  readonly path: number[] | null
  /** Nodes popped from the open set. */
  readonly expanded: number
  /** Final g-cost at the goal, or `G_INF` when unreachable. */
  readonly cost: number
}

export interface AStarOptions {
  readonly grid: TileGrid
  readonly start: number
  readonly goal: number
  readonly accessMask: number
  /** 1 = expandable. Built by `buildRegionBound` for production searches. */
  readonly allowed: Uint8Array
}

/**
 * A* from `start` to `goal` within `allowed`.
 *
 * Returns a tile path including both endpoints. Same-tile requests return a
 * one-element path without touching the heap.
 */
export function findPathAStar(options: AStarOptions): AStarResult {
  const { grid, start, goal, accessMask, allowed } = options
  const size = grid.size
  const total = size * size

  if (start < 0 || start >= total || goal < 0 || goal >= total) {
    return { path: null, expanded: 0, cost: G_INF }
  }
  if (start === goal) {
    return { path: [start], expanded: 0, cost: 0 }
  }
  if (allowed[start] !== 1 || allowed[goal] !== 1) {
    return { path: null, expanded: 0, cost: G_INF }
  }
  if (!tilePassableForAccess(grid.passability[start] ?? 0, accessMask)) {
    return { path: null, expanded: 0, cost: G_INF }
  }
  if (!tilePassableForAccess(grid.passability[goal] ?? 0, accessMask)) {
    return { path: null, expanded: 0, cost: G_INF }
  }

  const scratch = acquireAStarScratch(total)
  const gScore = scratch.g
  const parent = scratch.parent
  const closed = scratch.closed
  const heap = scratch.heap
  gScore.fill(G_INF)
  parent.fill(-1)
  closed.fill(0)

  const goalY = (goal / size) | 0
  const goalX = goal - goalY * size
  const startY = (start / size) | 0
  const startX = start - startY * size

  gScore[start] = 0
  heap.push(start, octileHeuristic(startX, startY, goalX, goalY), 0)

  let expanded = 0
  const pass = grid.passability

  while (heap.size > 0) {
    const current = heap.pop()
    if (current === undefined) break
    const tile = current.tile
    if (closed[tile] === 1) continue
    // Stale heap entry: a better g was found after this was pushed.
    if (current.g !== (gScore[tile] ?? G_INF)) continue
    closed[tile] = 1
    expanded += 1

    if (tile === goal) {
      return { path: reconstruct(parent, start, goal), expanded, cost: gScore[goal] ?? G_INF }
    }

    const y = (tile / size) | 0
    const x = tile - y * size
    const baseG = gScore[tile] ?? G_INF

    for (let n = 0; n < ASTAR_NEIGHBOURS.length; n += 1) {
      const step = ASTAR_NEIGHBOURS[n]
      if (step === undefined) continue
      const nx = x + step.dx
      const ny = y + step.dy
      if (nx < 0 || ny < 0 || nx >= size || ny >= size) continue
      const next = ny * size + nx
      if (allowed[next] !== 1) continue
      if (closed[next] === 1) continue
      if (!tilePassableForAccess(pass[next] ?? 0, accessMask)) continue

      if (step.diagonal) {
        // Corner cutting: both orthogonal neighbours must be passable.
        const orthA = y * size + nx
        const orthB = ny * size + x
        if (!tilePassableForAccess(pass[orthA] ?? 0, accessMask)) continue
        if (!tilePassableForAccess(pass[orthB] ?? 0, accessMask)) continue
      }

      const tentative = baseG + step.cost
      const prior = gScore[next] ?? G_INF
      if (tentative >= prior) continue
      gScore[next] = tentative
      parent[next] = tile
      const h = octileHeuristic(nx, ny, goalX, goalY)
      heap.push(next, tentative + h, tentative)
    }
  }

  return { path: null, expanded, cost: G_INF }
}

function reconstruct(parent: Int32Array, start: number, goal: number): number[] {
  const path: number[] = []
  let tile = goal
  while (tile !== start) {
    path.push(tile)
    const prev = parent[tile] ?? -1
    if (prev < 0) {
      // Broken parent chain — should not happen after a successful close.
      path.push(start)
      path.reverse()
      return path
    }
    tile = prev
  }
  path.push(start)
  path.reverse()
  return path
}

/* -------------------------------------------------------------------------- */
/* Budgeted scheduler                                                          */
/* -------------------------------------------------------------------------- */

export interface AStarRequest {
  readonly agentId: number
  readonly from: number
  readonly to: number
  readonly accessMask: number
}

export interface AStarTickResult {
  /** Searches completed this tick, at most `astarSearchesPerTick`. */
  readonly searched: number
  /** Requests still waiting on budget. */
  readonly pending: number
  /** agentId → path (or `null` when unreachable within the bound). */
  readonly completed: ReadonlyMap<number, number[] | null>
}

interface QueuedSearch {
  readonly agentId: number
  readonly from: number
  readonly to: number
  readonly accessMask: number
}

export interface AStarSchedulerOptions {
  /** `balance.pathfinding.astarSearchesPerTick`. */
  readonly astarSearchesPerTick: number
}

/**
 * Queues per-agent A* work and spends a fixed search budget each tick.
 *
 * `request` never runs a search inline: the agent idles until `tick` returns
 * its result. A newer request for the same agent replaces any pending one.
 */
export class AStarScheduler {
  readonly astarSearchesPerTick: number

  readonly #queue: QueuedSearch[] = []
  readonly #queuedAgents = new Set<number>()
  #allowedScratch = new Uint8Array(0)
  #allowedScratchSize = 0

  constructor(options: AStarSchedulerOptions) {
    this.astarSearchesPerTick = options.astarSearchesPerTick
  }

  get pendingCount(): number {
    return this.#queue.length
  }

  /**
   * Enqueues a search. A newer request for the same agent replaces any pending
   * one so a goal change does not leave a stale search at the head of the line.
   */
  request(request: AStarRequest): void {
    if (this.#queuedAgents.has(request.agentId)) {
      const index = this.#queue.findIndex((entry) => entry.agentId === request.agentId)
      if (index >= 0) this.#queue.splice(index, 1)
      this.#queuedAgents.delete(request.agentId)
    }
    this.#queue.push({
      agentId: request.agentId,
      from: request.from,
      to: request.to,
      accessMask: request.accessMask,
    })
    this.#queuedAgents.add(request.agentId)
  }

  /** True when this agent already has a search waiting. */
  isQueued(agentId: number): boolean {
    return this.#queuedAgents.has(agentId)
  }

  /**
   * Spends this tick's search budget.
   *
   * For each dequeued request the region corridor is resolved and A* runs
   * inside that bound. A missing corridor yields `null` (unreachable).
   */
  tick(grid: TileGrid, graph: RegionGraph): AStarTickResult {
    const completed = new Map<number, number[] | null>()
    let searched = 0
    const total = grid.tileCount
    if (this.#allowedScratchSize !== total) {
      this.#allowedScratch = new Uint8Array(total)
      this.#allowedScratchSize = total
    }

    while (searched < this.astarSearchesPerTick && this.#queue.length > 0) {
      const next = this.#queue.shift()
      if (next === undefined) break
      this.#queuedAgents.delete(next.agentId)
      searched += 1

      const startRegion = regionForPathing(graph, grid, next.from)
      const goalRegion = regionForPathing(graph, grid, next.to)
      if (startRegion === NO_REGION || goalRegion === NO_REGION) {
        completed.set(next.agentId, null)
        continue
      }

      const fromTile = tileInRegion(graph, next.from, startRegion)
      const toTile = tileInRegion(graph, next.to, goalRegion)
      const regionPath = graph.findRegionPath(fromTile, toTile, next.accessMask)
      if (regionPath === null) {
        completed.set(next.agentId, null)
        continue
      }

      const allowed = this.#allowedScratch
      allowed.fill(0)
      markRegionBound(allowed, graph, grid, regionPath, next.accessMask, next.from, next.to)

      const result = findPathAStar({
        grid,
        start: next.from,
        goal: next.to,
        accessMask: next.accessMask,
        allowed,
      })
      completed.set(next.agentId, result.path)
    }

    return {
      searched,
      pending: this.#queue.length,
      completed,
    }
  }
}

/** Writes the corridor mask into a caller-owned buffer (avoids per-search alloc). */
function markRegionBound(
  allowed: Uint8Array,
  graph: RegionGraph,
  grid: TileGrid,
  regionPath: readonly number[],
  accessMask: number,
  startTile: number,
  goalTile: number,
): void {
  const total = grid.tileCount
  for (const regionId of regionPath) {
    const region = graph.getRegion(regionId)
    if (region === undefined) continue
    for (const tile of region.tiles) allowed[tile] = 1
  }

  for (let i = 0; i < regionPath.length - 1; i += 1) {
    const from = regionPath[i]
    const to = regionPath[i + 1]
    if (from === undefined || to === undefined) continue
    for (const edge of graph.edgesFrom(from)) {
      if (edge.to !== to) continue
      if ((edge.accessMask & accessMask) === 0) continue
      if (edge.doorTile >= 0 && edge.doorTile < total) allowed[edge.doorTile] = 1
    }
  }

  if (startTile >= 0 && startTile < total) allowed[startTile] = 1
  if (goalTile >= 0 && goalTile < total) allowed[goalTile] = 1
}

/**
 * A standable tile known to belong to `regionId`, used only to seed the coarse
 * graph search when the agent is standing on a door.
 */
function tileInRegion(graph: RegionGraph, tile: number, regionId: number): number {
  if (graph.regionAt(tile) === regionId) return tile
  const region = graph.getRegion(regionId)
  if (region !== undefined && region.tiles.length > 0) {
    return region.tiles[0] ?? tile
  }
  return tile
}

/** Exported for optimality tests that need the same neighbour rules. */
export function astarNeighbours(): typeof ASTAR_NEIGHBOURS {
  return ASTAR_NEIGHBOURS
}

export { G_INF as ASTAR_COST_INF }
