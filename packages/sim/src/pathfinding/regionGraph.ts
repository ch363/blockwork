/**
 * Pathfinding layer 1: the region graph (T2.1, PRD 4.5).
 *
 * Walkable tiles are partitioned into **regions** — four-connected components
 * bounded by walls and doors. A room is usually one region; a corridor is
 * another. Doors are not members of any region: they are the **edges** between
 * the regions on either side.
 *
 * Coarse routing asks this graph for a corridor of regions before layer 3's
 * A* ever expands a tile. The graph is small (hundreds of nodes on a large
 * map) and is rebuilt incrementally: a passability change dirties only the
 * regions it touches, and a door lock or type change that leaves the
 * partition intact updates only that door's edges.
 *
 * Edge cost is `doorTraverseTicks` (from `balance.pathfinding`) plus the
 * destination region's mean crossing distance — the average axis span of its
 * bounding box, which is cheap and good enough for coarse ordering.
 *
 * Each edge carries an **access mask**: which agent categories may pass,
 * derived from the door's type and lock state, ANDed with the sector
 * permissions of the door tile and of the region the edge leads into (T4.1).
 * A sector is a grouping of regions, so an edge is exactly where a sector
 * boundary falls, and masking the edge is what makes every layer of
 * pathfinding respect access without knowing that sectors exist.
 */

import type { GameData } from '../data/loader'
import type { DoorDef } from '../data/schemas'

import type { Rect } from '../world/construction'
import type { DoorRegistry } from '../world/doors'
import { PASSABILITY } from '../world/tileGrid'
import type { TileGrid } from '../world/tileGrid'

/* -------------------------------------------------------------------------- */
/* Access masks                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Agent-category bits for coarse and fine pathfinding (PRD 4.5).
 *
 * An agent holds one or more of these; an edge lists who may cross. A path
 * step is allowed when `(agentMask & edge.accessMask) !== 0`.
 *
 * Bits 0 and 1 are the coarse kinds. Bits 2 upward are **one per security
 * category**, in `inmates.json` order, so a sector can refuse minimum-security
 * traffic while still admitting maximum (T4.1). An inmate carries
 * `INMATE | categoryBit`, so an unrestricted edge admits them through the
 * generic bit and a restricted edge — which deliberately omits `INMATE` —
 * admits them only through their own category bit.
 */
export const ACCESS = {
  STAFF: 0b0000_0001,
  INMATE: 0b0000_0010,
} as const

export type AccessFlag = (typeof ACCESS)[keyof typeof ACCESS]

/** Bit index of the first security category. */
export const ACCESS_CATEGORY_BIT_0 = 2

/**
 * How many security categories fit in a mask.
 *
 * Masks are plain numbers held in edges and flow-field cache keys, so the
 * ceiling is chosen to keep one comfortably inside 16 bits. PRD 5.5 names six
 * categories for v1.
 */
export const MAX_ACCESS_CATEGORIES = 14

/** Every per-category bit at once. */
export const ACCESS_CATEGORY_MASK = 0xfffc

/** Staff and every inmate category. The open-door, no-sector default. */
export const ACCESS_ALL = ACCESS.STAFF | ACCESS.INMATE | ACCESS_CATEGORY_MASK

/**
 * The bit standing for one security category, or 0 for an unknown id.
 *
 * File order is the bit order, which makes the mask a derived value rather
 * than a hardcoded table — adding a category to `inmates.json` needs no code
 * change until there are more than {@link MAX_ACCESS_CATEGORIES} of them, at
 * which point this throws rather than silently aliasing two categories onto
 * one bit.
 */
export function categoryAccessBit(data: GameData, categoryId: string): number {
  const index = data.securityCategories.indexOf(categoryId)
  if (index < 0) return 0
  if (index >= MAX_ACCESS_CATEGORIES) {
    throw new RangeError(
      `security category '${categoryId}' is number ${index + 1}; access masks hold ` +
        `at most ${MAX_ACCESS_CATEGORIES}`,
    )
  }
  return 1 << (ACCESS_CATEGORY_BIT_0 + index)
}

/** The mask an inmate of this category walks with. */
export function inmateAccessMask(data: GameData, categoryId: string): number {
  return ACCESS.INMATE | categoryAccessBit(data, categoryId)
}

/** The union of several categories' bits, for a sector restriction. */
export function categoriesAccessMask(data: GameData, categoryIds: Iterable<string>): number {
  let mask = 0
  for (const categoryId of categoryIds) mask |= categoryAccessBit(data, categoryId)
  return mask
}

/**
 * Sector permissions as the graph needs them.
 *
 * Structural, so `world/sectors` satisfies it without this module importing
 * it — the dependency runs the other way, since sectors are expressed in the
 * access bits declared here.
 */
export interface SectorAccessView {
  /** Who may enter tiles of this sector. Sector 0 admits everyone. */
  maskOfSector(sectorId: number): number
}

/**
 * Who may walk an unlocked door of this type.
 *
 * Locked doors stay in the graph (so a guard can be sent to open them) but
 * admit nobody: their mask is `0`.
 */
export function accessMaskForDoor(def: DoorDef, locked: boolean): number {
  if (locked) return 0
  if (def.staffOnly) return ACCESS.STAFF
  return ACCESS_ALL
}

/* -------------------------------------------------------------------------- */
/* Region identity                                                             */
/* -------------------------------------------------------------------------- */

/** `regionOfTile` 0 means the tile is not a region member (wall, door, void). */
export const NO_REGION = 0

/** `Uint16Array` ceiling on live plus retired region ids. */
export const MAX_REGION_ID = 65535

/** Four-connected, fixed order so every fill in this module agrees. */
export const REGION_NEIGHBOURS: readonly (readonly [number, number])[] = [
  [0, -1],
  [1, 0],
  [0, 1],
  [-1, 0],
]

/* -------------------------------------------------------------------------- */
/* Records                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * One connected component of walkable, non-door tiles.
 *
 * `tiles` is ascending. `meanCrossingDistance` is derived from `bounds` and is
 * what an incoming edge pays on top of the door traversal time.
 */
export interface Region {
  readonly id: number
  readonly tiles: readonly number[]
  readonly bounds: Rect
  readonly meanCrossingDistance: number
}

/**
 * A directed hop through a door from one region into another.
 *
 * `cost` is in the same tick-distance units layer 3 will use: door traversal
 * plus the destination's mean crossing distance.
 */
export interface RegionEdge {
  readonly from: number
  readonly to: number
  readonly doorTile: number
  readonly cost: number
  readonly accessMask: number
}

/** What one rebuild pass did — enough for tests to assert scoping. */
export interface RegionRebuild {
  /** Regions dissolved and re-flooded this pass, ascending by id. */
  readonly rebuilt: readonly number[]
  /** Door tiles whose edges were rewritten, ascending. */
  readonly doorsUpdated: readonly number[]
  /** Tiles the flood fills walked. Zero when only edges changed. */
  readonly tilesVisited: number
  /** Live region count after the pass. */
  readonly nodeCount: number
}

const EMPTY_REBUILD: RegionRebuild = {
  rebuilt: [],
  doorsUpdated: [],
  tilesVisited: 0,
  nodeCount: 0,
}

/* -------------------------------------------------------------------------- */
/* Predicates                                                                  */
/* -------------------------------------------------------------------------- */

/** A tile agents walk, and that is not itself a door edge. */
export function isRegionMember(passability: number): boolean {
  return (passability & PASSABILITY.WALKABLE) !== 0 && (passability & PASSABILITY.DOOR) === 0
}

export function isDoorTile(passability: number): boolean {
  return (passability & PASSABILITY.DOOR) !== 0
}

/**
 * Expected distance to cross a region on a coarse path.
 *
 * Half the bounding-box perimeter axes, floored at one so a single-tile
 * alcove still costs a step. Geometric, not a balance knob.
 */
export function meanCrossingDistance(bounds: Rect): number {
  return Math.max(1, (bounds.width + bounds.height) >> 1)
}

function boundsOf(tiles: readonly number[], size: number): Rect {
  let left = size
  let top = size
  let right = -1
  let bottom = -1

  for (const tile of tiles) {
    const y = (tile / size) | 0
    const x = tile - y * size
    if (x < left) left = x
    if (x > right) right = x
    if (y < top) top = y
    if (y > bottom) bottom = y
  }

  if (right < left) return { x: 0, y: 0, width: 0, height: 0 }
  return { x: left, y: top, width: right - left + 1, height: bottom - top + 1 }
}

/* -------------------------------------------------------------------------- */
/* Graph                                                                       */
/* -------------------------------------------------------------------------- */

export interface RegionGraphOptions {
  /** `balance.pathfinding.doorTraverseTicks`. */
  readonly doorTraverseTicks: number
}

/**
 * The coarse routing graph for one map.
 *
 * Owns the per-tile region assignment and the adjacency lists. Callers that
 * mutate passability must `markDirty` the changed tiles and then
 * `rebuildDirty`; a full `rebuildAll` is for new worlds and loaded saves.
 */
export class RegionGraph {
  readonly size: number
  readonly doorTraverseTicks: number

  readonly #regionOf: Uint16Array
  readonly #regions = new Map<number, Region>()
  /** Outgoing edges, keyed by `from` region id. */
  readonly #edges = new Map<number, RegionEdge[]>()
  /** Door tile → the directed edges that hop through it (both directions). */
  readonly #edgesByDoor = new Map<number, RegionEdge[]>()
  readonly #dirty = new Set<number>()
  #nextId = 1

  constructor(size: number, options: RegionGraphOptions) {
    this.size = size
    this.doorTraverseTicks = options.doorTraverseTicks
    this.#regionOf = new Uint16Array(size * size)
  }

  get nodeCount(): number {
    return this.#regions.size
  }

  get nextId(): number {
    return this.#nextId
  }

  /** Region id at a tile, or `NO_REGION`. */
  regionAt(tileIndex: number): number {
    return this.#regionOf[tileIndex] ?? NO_REGION
  }

  getRegion(id: number): Region | undefined {
    return this.#regions.get(id)
  }

  /** Every live region, ascending by id. */
  regions(): Region[] {
    return [...this.#regions.values()].sort((a, b) => a.id - b.id)
  }

  /** Outgoing edges from a region, in door-tile then destination order. */
  edgesFrom(regionId: number): readonly RegionEdge[] {
    return this.#edges.get(regionId) ?? EMPTY_EDGES
  }

  /** Edges that hop through a door tile. */
  edgesThroughDoor(doorTile: number): readonly RegionEdge[] {
    return this.#edgesByDoor.get(doorTile) ?? EMPTY_EDGES
  }

  /** Announces tiles whose passability (or door lock/type) changed. */
  markDirty(tiles: Iterable<number>): void {
    for (const tile of tiles) this.#dirty.add(tile)
  }

  get dirtyCount(): number {
    return this.#dirty.size
  }

  /**
   * Tears the graph down and rebuilds from the grid.
   *
   * Used for a new world and for a loaded save whose derived state must not
   * be trusted.
   */
  rebuildAll(
    grid: TileGrid,
    doors: DoorRegistry,
    data: GameData,
    sectors?: SectorAccessView,
  ): RegionRebuild {
    this.#regions.clear()
    this.#edges.clear()
    this.#edgesByDoor.clear()
    this.#regionOf.fill(NO_REGION)
    this.#nextId = 1
    this.#dirty.clear()

    const tilesVisited = this.#floodAll(grid)
    const doorsUpdated = this.#rebuildAllEdges(grid, doors, data, sectors)

    return {
      rebuilt: this.regions().map((region) => region.id),
      doorsUpdated,
      tilesVisited,
      nodeCount: this.#regions.size,
    }
  }

  /**
   * Rebuilds only what `markDirty` touched.
   *
   * When the dirty set is only door access changes that leave region
   * membership intact, regions are left alone and only those doors' edges are
   * rewritten. Otherwise the affected regions and their neighbours are
   * dissolved and re-flooded, then every door bordering the rebuilt set has
   * its edges refreshed.
   */
  rebuildDirty(
    grid: TileGrid,
    doors: DoorRegistry,
    data: GameData,
    sectors?: SectorAccessView,
  ): RegionRebuild {
    if (this.#dirty.size === 0) {
      return { ...EMPTY_REBUILD, nodeCount: this.#regions.size }
    }

    const seeds = this.#expandSeeds(grid)
    this.#dirty.clear()

    if (this.#partitionIntact(grid, seeds)) {
      const doorTiles = uniqueSorted(
        seeds.filter((tile) => isDoorTile(grid.passability[tile] ?? 0)),
      )
      for (const doorTile of doorTiles) this.#clearDoorEdges(doorTile)
      const doorsUpdated: number[] = []
      for (const doorTile of doorTiles) {
        if (this.#writeDoorEdges(grid, doors, data, doorTile, sectors)) {
          doorsUpdated.push(doorTile)
        }
      }
      return {
        rebuilt: [],
        doorsUpdated,
        tilesVisited: 0,
        nodeCount: this.#regions.size,
      }
    }

    const touched = this.#collectTouchedRegions(seeds)
    const dissolvedTiles = this.#dissolve(touched)
    const fillSeeds = uniqueSorted([
      ...dissolvedTiles.filter((tile) => isRegionMember(grid.passability[tile] ?? 0)),
      ...seeds.filter((tile) => isRegionMember(grid.passability[tile] ?? 0)),
    ])

    const { rebuilt, tilesVisited } = this.#floodFrom(grid, fillSeeds)
    const borderDoors = this.#doorsBordering(grid, rebuilt, dissolvedTiles, seeds)
    for (const doorTile of borderDoors) this.#clearDoorEdges(doorTile)
    // Neighbours kept their regions; drop edges that pointed into dissolved ids.
    this.#pruneEdgesTo(touched)
    const doorsUpdated: number[] = []
    for (const doorTile of borderDoors) {
      if (this.#writeDoorEdges(grid, doors, data, doorTile, sectors)) {
        doorsUpdated.push(doorTile)
      }
    }

    return {
      rebuilt: [...rebuilt].sort((a, b) => a - b),
      doorsUpdated,
      tilesVisited,
      nodeCount: this.#regions.size,
    }
  }

  /**
   * Coarse path as a sequence of region ids, or `null` when no permitted route
   * exists.
   *
   * `from` and `to` are tile indices. Same-region requests return a one-element
   * path. Door tiles and walls have no region and yield `null`.
   */
  findRegionPath(from: number, to: number, accessMask: number): number[] | null {
    const start = this.regionAt(from)
    const goal = this.regionAt(to)
    if (start === NO_REGION || goal === NO_REGION) return null
    if (start === goal) return [start]

    // Dijkstra on a graph this small is enough; the heap is a binary sift over
    // a dense array of pending nodes rather than a library dependency.
    const open: number[] = [start]
    const gScore = new Map<number, number>([[start, 0]])
    const cameFrom = new Map<number, number>()
    const inOpen = new Set<number>([start])

    while (open.length > 0) {
      let bestIndex = 0
      let bestScore = gScore.get(open[0] ?? start) ?? Number.POSITIVE_INFINITY
      for (let i = 1; i < open.length; i += 1) {
        const id = open[i]
        if (id === undefined) continue
        const score = gScore.get(id) ?? Number.POSITIVE_INFINITY
        if (score < bestScore) {
          bestScore = score
          bestIndex = i
        }
      }

      const current = open[bestIndex]
      if (current === undefined) break
      open[bestIndex] = open[open.length - 1] ?? current
      open.pop()
      inOpen.delete(current)

      if (current === goal) return reconstruct(cameFrom, current)

      for (const edge of this.edgesFrom(current)) {
        if ((edge.accessMask & accessMask) === 0) continue
        const tentative = bestScore + edge.cost
        const prior = gScore.get(edge.to)
        if (prior !== undefined && tentative >= prior) continue
        cameFrom.set(edge.to, current)
        gScore.set(edge.to, tentative)
        if (!inOpen.has(edge.to)) {
          open.push(edge.to)
          inOpen.add(edge.to)
        }
      }
    }

    return null
  }

  /* -- seeds and topology -------------------------------------------------- */

  #expandSeeds(grid: TileGrid): number[] {
    const size = this.size
    const out = new Set<number>()
    for (const tile of this.#dirty) {
      if (tile < 0 || tile >= this.#regionOf.length) continue
      out.add(tile)
      const y = (tile / size) | 0
      const x = tile - y * size
      for (const [dx, dy] of REGION_NEIGHBOURS) {
        const nx = x + dx
        const ny = y + dy
        if (nx < 0 || ny < 0 || nx >= size || ny >= size) continue
        out.add(grid.idx(nx, ny))
      }
    }
    return uniqueSorted(out)
  }

  /**
   * True when every seed's membership still matches `regionOf` and no two
   * adjacent members disagree on id — so the partition does not need a refill.
   */
  #partitionIntact(grid: TileGrid, seeds: readonly number[]): boolean {
    for (const tile of seeds) {
      const pass = grid.passability[tile] ?? 0
      const member = isRegionMember(pass)
      const region = this.#regionOf[tile] ?? NO_REGION
      if (member !== (region !== NO_REGION)) return false
      if (!member) continue

      const { x, y } = grid.xy(tile)
      for (const [dx, dy] of REGION_NEIGHBOURS) {
        const nx = x + dx
        const ny = y + dy
        if (!grid.inBounds(nx, ny)) continue
        const next = grid.idx(nx, ny)
        if (!isRegionMember(grid.passability[next] ?? 0)) continue
        if ((this.#regionOf[next] ?? NO_REGION) !== region) return false
      }
    }
    return true
  }

  #collectTouchedRegions(seeds: readonly number[]): Set<number> {
    const touched = new Set<number>()
    for (const tile of seeds) {
      const region = this.#regionOf[tile] ?? NO_REGION
      if (region !== NO_REGION) touched.add(region)
    }
    return touched
  }

  #dissolve(regionIds: ReadonlySet<number>): number[] {
    const tiles: number[] = []
    for (const id of regionIds) {
      const region = this.#regions.get(id)
      if (region === undefined) continue
      for (const tile of region.tiles) {
        this.#regionOf[tile] = NO_REGION
        tiles.push(tile)
      }
      this.#regions.delete(id)
      this.#edges.delete(id)
    }
    return tiles
  }

  #pruneEdgesTo(removed: ReadonlySet<number>): void {
    if (removed.size === 0) return
    for (const [from, list] of this.#edges) {
      if (removed.has(from)) continue
      const kept = list.filter((edge) => !removed.has(edge.to))
      if (kept.length === list.length) continue
      if (kept.length === 0) this.#edges.delete(from)
      else this.#edges.set(from, kept)
    }
    for (const [doorTile, list] of this.#edgesByDoor) {
      const kept = list.filter((edge) => !removed.has(edge.from) && !removed.has(edge.to))
      if (kept.length === list.length) continue
      if (kept.length === 0) this.#edgesByDoor.delete(doorTile)
      else this.#edgesByDoor.set(doorTile, kept)
    }
  }

  /* -- flood fills --------------------------------------------------------- */

  #floodAll(grid: TileGrid): number {
    let visited = 0
    const total = this.#regionOf.length
    for (let tile = 0; tile < total; tile += 1) {
      if ((this.#regionOf[tile] ?? NO_REGION) !== NO_REGION) continue
      if (!isRegionMember(grid.passability[tile] ?? 0)) continue
      visited += this.#floodComponent(grid, tile, this.#allocateId())
    }
    return visited
  }

  #floodFrom(
    grid: TileGrid,
    seeds: readonly number[],
  ): { rebuilt: number[]; tilesVisited: number } {
    const rebuilt: number[] = []
    let tilesVisited = 0
    // Lowest tile first so two runs that dissolve the same area reclaim ids
    // in the same order.
    for (const seed of seeds) {
      if ((this.#regionOf[seed] ?? NO_REGION) !== NO_REGION) continue
      if (!isRegionMember(grid.passability[seed] ?? 0)) continue
      const id = this.#allocateId()
      tilesVisited += this.#floodComponent(grid, seed, id)
      rebuilt.push(id)
    }
    return { rebuilt, tilesVisited }
  }

  #floodComponent(grid: TileGrid, start: number, id: number): number {
    const size = this.size
    const tiles: number[] = []
    const frontier = [start]
    this.#regionOf[start] = id

    while (frontier.length > 0) {
      const tile = frontier.pop()
      if (tile === undefined) break
      tiles.push(tile)
      const y = (tile / size) | 0
      const x = tile - y * size
      for (const [dx, dy] of REGION_NEIGHBOURS) {
        const nx = x + dx
        const ny = y + dy
        if (nx < 0 || ny < 0 || nx >= size || ny >= size) continue
        const next = ny * size + nx
        if ((this.#regionOf[next] ?? NO_REGION) !== NO_REGION) continue
        if (!isRegionMember(grid.passability[next] ?? 0)) continue
        this.#regionOf[next] = id
        frontier.push(next)
      }
    }

    tiles.sort((a, b) => a - b)
    const bounds = boundsOf(tiles, size)
    this.#regions.set(id, {
      id,
      tiles,
      bounds,
      meanCrossingDistance: meanCrossingDistance(bounds),
    })
    return tiles.length
  }

  #allocateId(): number {
    if (this.#nextId > MAX_REGION_ID) {
      throw new RangeError(`region id space exhausted (max ${MAX_REGION_ID})`)
    }
    const id = this.#nextId
    this.#nextId += 1
    return id
  }

  /* -- edges --------------------------------------------------------------- */

  #rebuildAllEdges(
    grid: TileGrid,
    doors: DoorRegistry,
    data: GameData,
    sectors: SectorAccessView | undefined,
  ): number[] {
    this.#edges.clear()
    this.#edgesByDoor.clear()
    const updated: number[] = []
    for (const doorTile of doors.indices()) {
      if (this.#writeDoorEdges(grid, doors, data, doorTile, sectors)) updated.push(doorTile)
    }
    return updated
  }

  #clearDoorEdges(doorTile: number): void {
    const existing = this.#edgesByDoor.get(doorTile)
    if (existing === undefined) return
    for (const edge of existing) {
      const list = this.#edges.get(edge.from)
      if (list === undefined) continue
      const next = list.filter((entry) => !(entry.doorTile === doorTile && entry.to === edge.to))
      if (next.length === 0) this.#edges.delete(edge.from)
      else this.#edges.set(edge.from, next)
    }
    this.#edgesByDoor.delete(doorTile)
  }

  /**
   * Writes both directed edges for a door, if it still bridges two regions.
   * Returns true when at least one edge was written.
   *
   * The mask of a directed edge is the door's own permission ANDed with the
   * sector of the door tile and the sector of the tile the edge lands on. Two
   * sectors either side of one door therefore get different masks in each
   * direction, which is what "walk out of max-sec but not into it" needs.
   */
  #writeDoorEdges(
    grid: TileGrid,
    doors: DoorRegistry,
    data: GameData,
    doorTile: number,
    sectors: SectorAccessView | undefined,
  ): boolean {
    if (!isDoorTile(grid.passability[doorTile] ?? 0)) return false
    const door = doors.get(doorTile)
    if (door === undefined) return false
    const def = data.doors.find(door.type)
    if (def === undefined) return false

    const neighbours = this.#adjacentRegions(grid, doorTile)
    if (neighbours.length < 2) return false

    const doorMask = accessMaskForDoor(def, door.locked) & sectorMaskAt(grid, sectors, doorTile)
    const written: RegionEdge[] = []

    for (let i = 0; i < neighbours.length; i += 1) {
      for (let j = 0; j < neighbours.length; j += 1) {
        if (i === j) continue
        const from = neighbours[i]?.region
        const entry = neighbours[j]
        if (from === undefined || entry === undefined) continue
        const to = entry.region
        const dest = this.#regions.get(to)
        if (dest === undefined) continue
        const edge: RegionEdge = {
          from,
          to,
          doorTile,
          cost: this.doorTraverseTicks + dest.meanCrossingDistance,
          accessMask: doorMask & sectorMaskAt(grid, sectors, entry.tile),
        }
        written.push(edge)
        const list = this.#edges.get(from)
        if (list === undefined) this.#edges.set(from, [edge])
        else list.push(edge)
      }
    }

    if (written.length === 0) return false
    written.sort((a, b) => a.from - b.from || a.to - b.to)
    this.#edgesByDoor.set(doorTile, written)
    for (const from of new Set(written.map((edge) => edge.from))) {
      const list = this.#edges.get(from)
      if (list === undefined) continue
      list.sort((a, b) => a.doorTile - b.doorTile || a.to - b.to)
    }
    return true
  }

  /**
   * The distinct regions touching a door, each with the tile that reached it.
   *
   * The tile matters as well as the region: it is the tile an agent lands on
   * when it crosses, so it is the one whose sector decides whether it may.
   */
  #adjacentRegions(
    grid: TileGrid,
    doorTile: number,
  ): { readonly region: number; readonly tile: number }[] {
    const { x, y } = grid.xy(doorTile)
    const seen = new Set<number>()
    const out: { region: number; tile: number }[] = []
    for (const [dx, dy] of REGION_NEIGHBOURS) {
      const nx = x + dx
      const ny = y + dy
      if (!grid.inBounds(nx, ny)) continue
      const tile = grid.idx(nx, ny)
      const region = this.#regionOf[tile] ?? NO_REGION
      if (region === NO_REGION || seen.has(region)) continue
      seen.add(region)
      out.push({ region, tile })
    }
    out.sort((a, b) => a.region - b.region)
    return out
  }

  #doorsBordering(
    grid: TileGrid,
    rebuilt: readonly number[],
    dissolvedTiles: readonly number[],
    seeds: readonly number[],
  ): number[] {
    const rebuiltSet = new Set(rebuilt)
    const candidates = new Set<number>()

    for (const tile of seeds) {
      if (isDoorTile(grid.passability[tile] ?? 0)) candidates.add(tile)
    }
    for (const tile of dissolvedTiles) {
      const { x, y } = grid.xy(tile)
      for (const [dx, dy] of REGION_NEIGHBOURS) {
        const nx = x + dx
        const ny = y + dy
        if (!grid.inBounds(nx, ny)) continue
        const next = grid.idx(nx, ny)
        if (isDoorTile(grid.passability[next] ?? 0)) candidates.add(next)
      }
    }
    for (const id of rebuiltSet) {
      const region = this.#regions.get(id)
      if (region === undefined) continue
      for (const tile of region.tiles) {
        const { x, y } = grid.xy(tile)
        for (const [dx, dy] of REGION_NEIGHBOURS) {
          const nx = x + dx
          const ny = y + dy
          if (!grid.inBounds(nx, ny)) continue
          const next = grid.idx(nx, ny)
          if (isDoorTile(grid.passability[next] ?? 0)) candidates.add(next)
        }
      }
    }

    return uniqueSorted(candidates)
  }
}

const EMPTY_EDGES: readonly RegionEdge[] = Object.freeze([])

/** The sector permission on a tile. No sector view, or no sector, admits all. */
function sectorMaskAt(
  grid: TileGrid,
  sectors: SectorAccessView | undefined,
  tileIndex: number,
): number {
  if (sectors === undefined) return ACCESS_ALL
  return sectors.maskOfSector(grid.sectorId[tileIndex] ?? 0)
}

function uniqueSorted(values: Iterable<number>): number[] {
  return [...new Set(values)].sort((a, b) => a - b)
}

function reconstruct(cameFrom: ReadonlyMap<number, number>, goal: number): number[] {
  const path = [goal]
  let current = goal
  for (;;) {
    const prev = cameFrom.get(current)
    if (prev === undefined) break
    path.push(prev)
    current = prev
  }
  path.reverse()
  return path
}
