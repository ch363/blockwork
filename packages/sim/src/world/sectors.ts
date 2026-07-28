/**
 * Sectors: who is allowed where (T4.1, PRD 3.5, 6.2).
 *
 * A sector is a **player-painted grouping of regions**. That phrasing in the
 * ticket is load-bearing rather than decorative: because a region is a
 * connected component of walkable tiles bounded by walls and doors, painting
 * whole regions means every door in the prison is either wholly inside one
 * sector or is the boundary between two of them. Access can therefore be
 * enforced on the region graph's **edges**, which is the one place every layer
 * of pathfinding already agrees on — coarse routing consults the edge mask
 * directly, and A* only ever expands inside the corridor of regions coarse
 * routing returned. Nothing downstream has to be taught about sectors.
 *
 * Two things a sector carries beyond a name and a colour:
 *
 * **An access mode.** `staffOnly` admits nobody but staff, `secure` and
 * `shared` admit staff plus whichever inmate categories are permitted, and
 * `open` admits everyone regardless of restriction. `staffOnly` and `secure`
 * additionally stamp `PASSABILITY.STAFF_ONLY` / `PASSABILITY.SECURE` onto
 * their tiles, which is the half of the job `world/construction` deliberately
 * left to this module.
 *
 * **A security category restriction.** An empty restriction means "every
 * category". A non-empty one is the acceptance case: a sector restricted to
 * `maximum` refuses a `minimum` inmate, because the edge mask into it carries
 * only the maximum-security bit and the generic inmate bit is deliberately
 * absent.
 *
 * The per-tile membership store is `TileGrid.sectorId` — sectors are a tile
 * field in PRD 4.3 and the renderer's Sectors overlay reads the same bytes.
 * This registry owns the definitions and the reverse index, not the tiles.
 */

import type { Fnv1aHasher } from '../core/hash'
import type { GameData } from '../data/loader'
import { SECTOR_ACCESS_MODES } from '../data/schemas'
import type { SectorAccessMode } from '../data/schemas'
import {
  ACCESS,
  ACCESS_ALL,
  categoriesAccessMask,
} from '../pathfinding/regionGraph'
import type { RegionGraph } from '../pathfinding/regionGraph'

import { PASSABILITY } from './tileGrid'
import type { TileGrid } from './tileGrid'

/* -------------------------------------------------------------------------- */
/* Identity                                                                    */
/* -------------------------------------------------------------------------- */

/** `TileGrid.sectorId` 0 means "no sector", so ids start at 1. */
export const NO_SECTOR = 0

/** `sectorId` is a `Uint16Array`, which is the ceiling on live plus retired ids. */
export const MAX_SECTOR_ID = 65535

export type { SectorAccessMode }
export { SECTOR_ACCESS_MODES }

export function isSectorAccessMode(value: string): value is SectorAccessMode {
  return (SECTOR_ACCESS_MODES as readonly string[]).includes(value)
}

/** CausalEvent kinds emitted by the sector command handlers. */
export const SECTOR_EVENTS = {
  created: 'sector.created',
  updated: 'sector.updated',
  removed: 'sector.removed',
  painted: 'sector.painted',
  rejected: 'sector.rejected',
} as const

/* -------------------------------------------------------------------------- */
/* The sector record                                                           */
/* -------------------------------------------------------------------------- */

/**
 * One named grouping of regions.
 *
 * `categories` is the security-category restriction and is empty for "any
 * inmate the mode admits". `colour` is a player choice with no simulation
 * meaning; it is hashed so two saves that differ only in a recolour are
 * honestly different states.
 */
export interface Sector {
  readonly id: number
  name: string
  colour: string
  access: SectorAccessMode
  /** Security category ids. Empty means unrestricted. */
  categories: readonly string[]
}

/**
 * The access mask a sector grants.
 *
 * `open` returns {@link ACCESS_ALL} — everyone, restriction ignored, which is
 * what "open" has to mean if it is to differ from `shared`. `staffOnly`
 * returns the staff bit alone. The middle two grant staff plus the permitted
 * inmate categories, and a restricted sector deliberately omits the generic
 * `ACCESS.INMATE` bit so that an agent carrying only that bit — an
 * unclassified query, or an inmate of a category the sector refuses — fails
 * the `(agent & edge) !== 0` test.
 */
export function sectorAccessMask(data: GameData, sector: Sector): number {
  switch (sector.access) {
    case 'open':
      return ACCESS_ALL
    case 'staffOnly':
      return ACCESS.STAFF
    case 'secure':
    case 'shared':
      return sector.categories.length === 0
        ? ACCESS_ALL
        : ACCESS.STAFF | categoriesAccessMask(data, sector.categories)
    default:
      return ACCESS_ALL
  }
}

/**
 * The `passability` bits a sector stamps onto every tile it covers.
 *
 * This is the other half of `world/construction`'s `tilePassability`, which
 * owns the structural bits (walls, doors) and leaves these to T4.1. Recomputed
 * from scratch on every refresh, so clearing a sector clears its bits.
 */
export function sectorPassabilityBits(access: SectorAccessMode): number {
  switch (access) {
    case 'staffOnly':
      return PASSABILITY.STAFF_ONLY
    case 'secure':
      return PASSABILITY.SECURE
    default:
      return 0
  }
}

/* -------------------------------------------------------------------------- */
/* Registry                                                                    */
/* -------------------------------------------------------------------------- */

export interface SectorPaintResult {
  /** Tiles whose `sectorId` changed, ascending. */
  readonly changed: readonly number[]
  /** Sectors that lost tiles to this paint, ascending. */
  readonly displaced: readonly number[]
}

const EMPTY_TILES: readonly number[] = Object.freeze([])

/**
 * Every sector definition and which tiles belong to it.
 *
 * The mask table is kept as a plain array indexed by sector id so the hot
 * lookups — one per tile during flow-field generation, one per door edge
 * during a region rebuild — are an array index rather than a map probe. It is
 * rebuilt whenever a definition changes, which is a player action and
 * therefore rare.
 */
export class SectorRegistry {
  readonly size: number

  readonly #sectors = new Map<number, Sector>()
  readonly #tiles = new Map<number, Set<number>>()
  /** sectorId → access mask. Index 0 (no sector) is always `ACCESS_ALL`. */
  #masks: number[] = [ACCESS_ALL]
  /** sectorId → passability bits. Index 0 is always 0. */
  #bits: number[] = [0]
  #nextId = 1

  constructor(size: number) {
    this.size = size
  }

  get count(): number {
    return this.#sectors.size
  }

  /** The next id that would be allocated. Part of the fingerprint. */
  get nextId(): number {
    return this.#nextId
  }

  get(sectorId: number): Sector | undefined {
    return this.#sectors.get(sectorId)
  }

  /** Sectors in ascending id order. */
  all(): Sector[] {
    return [...this.#sectors.values()].sort((a, b) => a.id - b.id)
  }

  /** Tiles painted into a sector, ascending. */
  tilesOf(sectorId: number): readonly number[] {
    const set = this.#tiles.get(sectorId)
    if (set === undefined) return EMPTY_TILES
    return [...set].sort((a, b) => a - b)
  }

  tileCountOf(sectorId: number): number {
    return this.#tiles.get(sectorId)?.size ?? 0
  }

  /* -- lookups used by pathfinding ----------------------------------------- */

  /** Who may enter tiles of this sector. Unknown / unpainted is everyone. */
  maskOfSector(sectorId: number): number {
    return this.#masks[sectorId] ?? ACCESS_ALL
  }

  /** The `passability` bits this sector stamps. Unknown / unpainted is none. */
  passabilityBitsOfSector(sectorId: number): number {
    return this.#bits[sectorId] ?? 0
  }

  /** Convenience for callers that hold a grid and a tile rather than a sector. */
  maskAtTile(grid: TileGrid, tileIndex: number): number {
    return this.maskOfSector(grid.sectorId[tileIndex] ?? NO_SECTOR)
  }

  /* -- definitions --------------------------------------------------------- */

  /**
   * Creates an empty sector. Returns `NO_SECTOR` when the id space is spent.
   *
   * The caller supplies the data set so the mask table can be built now rather
   * than being recomputed on every lookup.
   */
  create(
    data: GameData,
    options: {
      readonly name: string
      readonly colour?: string
      readonly access?: SectorAccessMode
      readonly categories?: readonly string[]
    },
  ): Sector | undefined {
    if (this.#nextId > MAX_SECTOR_ID) return undefined
    const id = this.#nextId
    this.#nextId += 1

    const sector: Sector = {
      id,
      name: options.name,
      colour: options.colour ?? '',
      access: options.access ?? data.balance.sectors.defaultAccess,
      categories: [...(options.categories ?? [])],
    }
    this.#sectors.set(id, sector)
    this.#tiles.set(id, new Set())
    this.#refreshTables(data)
    return sector
  }

  /**
   * Replaces a sector's access mode and / or restriction.
   *
   * @returns the tiles whose derived passability and access must be refreshed,
   *   ascending. Empty when the sector is unknown or nothing changed.
   */
  configure(
    data: GameData,
    sectorId: number,
    changes: {
      readonly name?: string
      readonly colour?: string
      readonly access?: SectorAccessMode
      readonly categories?: readonly string[]
    },
  ): readonly number[] {
    const sector = this.#sectors.get(sectorId)
    if (sector === undefined) return EMPTY_TILES

    const before = { access: sector.access, categories: sector.categories.join(',') }
    if (changes.name !== undefined) sector.name = changes.name
    if (changes.colour !== undefined) sector.colour = changes.colour
    if (changes.access !== undefined) sector.access = changes.access
    if (changes.categories !== undefined) sector.categories = [...changes.categories]
    this.#refreshTables(data)

    const changedAccess =
      before.access !== sector.access || before.categories !== sector.categories.join(',')
    return changedAccess ? this.tilesOf(sectorId) : EMPTY_TILES
  }

  /**
   * Forgets a sector and clears its tiles back to `NO_SECTOR`.
   *
   * @returns the tiles that were cleared, ascending, so the caller can refresh
   *   passability and dirty the pathfinding derivations.
   */
  remove(data: GameData, grid: TileGrid, sectorId: number): readonly number[] {
    const sector = this.#sectors.get(sectorId)
    if (sector === undefined) return EMPTY_TILES
    const tiles = this.tilesOf(sectorId)
    for (const tile of tiles) grid.setAt('sectorId', tile, NO_SECTOR)
    this.#sectors.delete(sectorId)
    this.#tiles.delete(sectorId)
    this.#refreshTables(data)
    return tiles
  }

  /* -- painting ------------------------------------------------------------ */

  /**
   * Paints tiles into a sector, or into `NO_SECTOR` to erase.
   *
   * A tile belongs to exactly one sector, so painting over another sector's
   * tile moves it. Callers refresh passability for `changed` and hand the same
   * list to the pathfinding dirty set.
   */
  paintTiles(grid: TileGrid, tiles: Iterable<number>, sectorId: number): SectorPaintResult {
    if (sectorId !== NO_SECTOR && !this.#sectors.has(sectorId)) {
      return { changed: EMPTY_TILES, displaced: EMPTY_TILES }
    }

    const changed: number[] = []
    const displaced = new Set<number>()
    const total = grid.size * grid.size

    for (const tile of tiles) {
      if (tile < 0 || tile >= total) continue
      const previous = grid.sectorId[tile] ?? NO_SECTOR
      if (previous === sectorId) continue
      if (previous !== NO_SECTOR) {
        this.#tiles.get(previous)?.delete(tile)
        displaced.add(previous)
      }
      if (sectorId !== NO_SECTOR) {
        let set = this.#tiles.get(sectorId)
        if (set === undefined) {
          set = new Set()
          this.#tiles.set(sectorId, set)
        }
        set.add(tile)
      }
      grid.setAt('sectorId', tile, sectorId)
      changed.push(tile)
    }

    changed.sort((a, b) => a - b)
    return { changed, displaced: [...displaced].sort((a, b) => a - b) }
  }

  /**
   * Paints the whole region containing `tileIndex`.
   *
   * This is the player-facing gesture: a sector is a grouping of regions, and
   * a tap inside a room enrols that room. A tile with no region — a wall, a
   * door, the void — paints nothing, because there is no region to group.
   */
  paintRegionAt(
    grid: TileGrid,
    graph: RegionGraph,
    tileIndex: number,
    sectorId: number,
  ): SectorPaintResult {
    const region = graph.getRegion(graph.regionAt(tileIndex))
    if (region === undefined) return { changed: EMPTY_TILES, displaced: EMPTY_TILES }
    return this.paintTiles(grid, region.tiles, sectorId)
  }

  /* -- maintenance --------------------------------------------------------- */

  /**
   * Rebuilds the reverse index from the grid.
   *
   * Derived state is computed, never trusted (PRD 7.4), so this is the entry
   * point after a load — and the repair path if anything ever writes
   * `sectorId` without going through `paintTiles`.
   */
  reindex(data: GameData, grid: TileGrid): void {
    for (const set of this.#tiles.values()) set.clear()
    const total = grid.size * grid.size
    for (let tile = 0; tile < total; tile += 1) {
      const sectorId = grid.sectorId[tile] ?? NO_SECTOR
      if (sectorId === NO_SECTOR) continue
      if (!this.#sectors.has(sectorId)) {
        grid.setAt('sectorId', tile, NO_SECTOR)
        continue
      }
      let set = this.#tiles.get(sectorId)
      if (set === undefined) {
        set = new Set()
        this.#tiles.set(sectorId, set)
      }
      set.add(tile)
    }
    this.#refreshTables(data)
  }

  /** Definitions only — tile membership is on `grid.sectorId`. */
  serialise(): {
    readonly nextSectorId: number
    readonly sectors: readonly Sector[]
  } {
    return {
      nextSectorId: this.#nextId,
      sectors: this.all().map((sector) => ({
        id: sector.id,
        name: sector.name,
        colour: sector.colour,
        access: sector.access,
        categories: [...sector.categories],
      })),
    }
  }

  /**
   * Restores definitions from a save. Call {@link reindex} afterwards so the
   * reverse tile index matches the grid.
   */
  restore(
    data: GameData,
    snapshot: {
      readonly nextSectorId: number
      readonly sectors: readonly {
        readonly id: number
        readonly name: string
        readonly colour: string
        readonly access: SectorAccessMode
        readonly categories: readonly string[]
      }[]
    },
  ): void {
    this.#sectors.clear()
    this.#tiles.clear()
    for (const entry of snapshot.sectors) {
      const sector: Sector = {
        id: entry.id,
        name: entry.name,
        colour: entry.colour,
        access: entry.access,
        categories: [...entry.categories],
      }
      this.#sectors.set(sector.id, sector)
      this.#tiles.set(sector.id, new Set())
    }
    this.#nextId = Math.max(1, snapshot.nextSectorId)
    this.#refreshTables(data)
  }

  hashInto(hasher: Fnv1aHasher): void {
    hasher.writeUint32(this.#nextId)
    hasher.writeUint32(this.#sectors.size)
    for (const sector of this.all()) {
      hasher.writeUint32(sector.id)
      hasher.writeString(sector.name)
      hasher.writeString(sector.colour)
      hasher.writeString(sector.access)
      hasher.writeUint32(sector.categories.length)
      for (const category of [...sector.categories].sort()) hasher.writeString(category)
      hasher.writeUint32(this.tileCountOf(sector.id))
    }
  }

  #refreshTables(data: GameData): void {
    const masks: number[] = [ACCESS_ALL]
    const bits: number[] = [0]
    for (let id = 1; id < this.#nextId; id += 1) {
      const sector = this.#sectors.get(id)
      masks[id] = sector === undefined ? ACCESS_ALL : sectorAccessMask(data, sector)
      bits[id] = sector === undefined ? 0 : sectorPassabilityBits(sector.access)
    }
    this.#masks = masks
    this.#bits = bits
  }
}

/* -------------------------------------------------------------------------- */
/* Queries                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Whether an agent carrying `agentMask` may stand on a tile.
 *
 * The same `(agent & permitted) !== 0` test the region graph applies to edges,
 * applied to the sector a tile belongs to. Tiles outside every sector admit
 * everyone.
 */
export function sectorAdmits(
  sectors: SectorRegistry,
  grid: TileGrid,
  tileIndex: number,
  agentMask: number,
): boolean {
  return (sectors.maskAtTile(grid, tileIndex) & agentMask) !== 0
}
