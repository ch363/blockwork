/**
 * The material table behind `TileGrid.floorMaterial` and
 * `TileGrid.wallMaterial` (PRD 4.3).
 *
 * The grid stores a `Uint8` index per tile rather than a string, which is the
 * whole reason a table exists: 90,000 tiles holding an interned index cost
 * 90KB, the same tiles holding a string reference cost megabytes and a pointer
 * chase per lookup.
 *
 * Materials themselves are **content**, and content lives in
 * `packages/data/materials.json` validated with Zod (CLAUDE.md rule 4, PRD
 * 7.2, 7.3). This module owns only the runtime representation: the id-to-index
 * mapping, the reserved empty slot, and the width limit the typed array
 * imposes. T1.1 builds the table from the JSON. Floors and walls share one
 * index space, as PRD 4.3 describes a single material table; deciding which
 * materials may be used as a floor and which as a wall is the data layer's
 * job, not the grid's.
 */

/** A material's stable string id, as written in `materials.json`. */
export type MaterialId = string

/** An index into a `MaterialTable`, and the value stored in the grid. */
export type MaterialIndex = number

/**
 * Slot 0. On `wallMaterial` this is "no wall" (PRD 4.3); on `floorMaterial` it
 * is bare ground, the state of every tile in a freshly allocated grid.
 */
export const NO_MATERIAL: MaterialIndex = 0

/** The reserved id of slot 0. A data file may not define it. */
export const NO_MATERIAL_ID: MaterialId = 'none'

/** `Uint8Array` width: slot 0 plus 255 real materials. */
export const MAX_MATERIALS = 256

export const MAX_MATERIAL_INDEX = MAX_MATERIALS - 1

/**
 * An ordered, immutable registry of material ids.
 *
 * Index order is the order the ids were supplied in, which makes it the data
 * file's order. That matters: the indices are written into saved grids, so
 * reordering `materials.json` invalidates old saves and needs a migration
 * (PRD 7.4). Appending is always safe.
 */
export class MaterialTable {
  readonly #ids: readonly MaterialId[]
  readonly #indexById: ReadonlyMap<MaterialId, MaterialIndex>

  private constructor(ids: readonly MaterialId[], indexById: ReadonlyMap<MaterialId, number>) {
    this.#ids = ids
    this.#indexById = indexById
  }

  /**
   * Builds a table from material ids in file order. Slot 0 is prepended
   * automatically, so `from(['concrete'])` puts `concrete` at index 1.
   */
  static from(ids: Iterable<MaterialId>): MaterialTable {
    const ordered: MaterialId[] = [NO_MATERIAL_ID]
    const indexById = new Map<MaterialId, MaterialIndex>([[NO_MATERIAL_ID, NO_MATERIAL]])

    for (const id of ids) {
      if (typeof id !== 'string' || id.length === 0) {
        throw new TypeError('material id must be a non-empty string')
      }
      if (indexById.has(id)) {
        throw new Error(
          id === NO_MATERIAL_ID
            ? `material id '${NO_MATERIAL_ID}' is reserved for the empty slot`
            : `duplicate material id '${id}'`,
        )
      }
      if (ordered.length >= MAX_MATERIALS) {
        throw new RangeError(
          `a material table holds at most ${MAX_MATERIALS} entries including the empty slot, ` +
            `because the grid stores one Uint8 index per tile`,
        )
      }
      indexById.set(id, ordered.length)
      ordered.push(id)
    }

    return new MaterialTable(ordered, indexById)
  }

  /** A table with nothing but the empty slot, for a grid with no data loaded. */
  static empty(): MaterialTable {
    return MaterialTable.from([])
  }

  /** Entries including the empty slot, so always at least 1. */
  get size(): number {
    return this.#ids.length
  }

  /** Ids in index order. `ids()[0]` is always the empty slot. */
  ids(): readonly MaterialId[] {
    return this.#ids
  }

  has(id: MaterialId): boolean {
    return this.#indexById.has(id)
  }

  /** The index to store in the grid. Throws if the material is unknown. */
  indexOf(id: MaterialId): MaterialIndex {
    const index = this.#indexById.get(id)
    if (index === undefined) {
      throw new Error(`unknown material '${id}'`)
    }
    return index
  }

  /** As `indexOf`, but `undefined` rather than throwing, for validation paths. */
  tryIndexOf(id: MaterialId): MaterialIndex | undefined {
    return this.#indexById.get(id)
  }

  /** The id at an index. Throws if the index is not in the table. */
  idAt(index: MaterialIndex): MaterialId {
    const id = this.#ids[index]
    if (id === undefined) {
      throw new RangeError(`material index ${index} is outside a table of ${this.size}`)
    }
    return id
  }

  isNone(index: MaterialIndex): boolean {
    return index === NO_MATERIAL
  }
}
