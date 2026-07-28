/**
 * Blob autotiling: the rule that turns a wall's eight neighbours into one of
 * 47 sprites (PRD 7.6, T1.6).
 *
 * ## Why 47 and not 256
 *
 * Eight neighbours give 256 combinations, but most of them are the same
 * picture. A diagonal neighbour is only visible to the tile in the middle when
 * both of the cardinals beside it are also walls: if the tile to the north is
 * open, it does not matter what stands to the north-east, because the corner
 * of this tile faces open ground either way. Discarding every diagonal that
 * fails that test collapses the 256 masks onto 47 distinct ones, which is the
 * standard blob set and exactly the count PRD 7.6 asks for.
 *
 * That collapse is the whole of the rule, and it is applied **once**, at module
 * load, to fill `AUTOTILE_INDEX_BY_MASK`. Everything downstream is
 * `table[mask]`: no branching, no corner tests, no per-tile allocation. The
 * wall layer runs this over every tile of every dirty chunk, so the cost of
 * the lookup is the cost of the feature.
 *
 * Generating the table rather than transcribing 256 hand-written entries is
 * deliberate. A typo in a literal table is a wall that renders wrong in one
 * rare configuration and is invisible in review;
 * `test/sprites/autotile.test.ts` pins the generated result against the 47
 * canonical masks written out longhand, so the transcription risk is paid once,
 * in a test, where a mistake fails the build.
 *
 * ## The index is stable
 *
 * `AUTOTILE_CANONICAL_MASKS` is in ascending mask order and a tile index is a
 * position in it. That ordering is a contract: it is what the shape atlas is
 * laid out by, and it is written into the wall layer's data texture, so
 * reordering it silently redraws every wall in the prison as something else.
 */

/**
 * Neighbour bits, clockwise from north.
 *
 * These values restate `WALL_NEIGHBOUR` in `sim/world/walls.ts`, which is what
 * builds the masks this module consumes. The render package may import types
 * from `sim` but not values (PRD 7.2), so the two cannot share a constant; the
 * autotile test pins the numbers instead.
 */
export const AUTOTILE_NEIGHBOUR = {
  N: 0b0000_0001,
  NE: 0b0000_0010,
  E: 0b0000_0100,
  SE: 0b0000_1000,
  S: 0b0001_0000,
  SW: 0b0010_0000,
  W: 0b0100_0000,
  NW: 0b1000_0000,
} as const

export type AutotileNeighbourBit = (typeof AUTOTILE_NEIGHBOUR)[keyof typeof AUTOTILE_NEIGHBOUR]

export const AUTOTILE_CARDINALS =
  AUTOTILE_NEIGHBOUR.N | AUTOTILE_NEIGHBOUR.E | AUTOTILE_NEIGHBOUR.S | AUTOTILE_NEIGHBOUR.W

export const AUTOTILE_DIAGONALS =
  AUTOTILE_NEIGHBOUR.NE | AUTOTILE_NEIGHBOUR.SE | AUTOTILE_NEIGHBOUR.SW | AUTOTILE_NEIGHBOUR.NW

/**
 * Neighbour offsets in bit order, so a mask is built in one unrolled pass.
 * Mirrors the offset table in `sim/world/walls.ts` for the same reason the
 * bits do.
 */
export const AUTOTILE_OFFSETS: readonly (readonly [number, number, AutotileNeighbourBit])[] = [
  [0, -1, AUTOTILE_NEIGHBOUR.N],
  [1, -1, AUTOTILE_NEIGHBOUR.NE],
  [1, 0, AUTOTILE_NEIGHBOUR.E],
  [1, 1, AUTOTILE_NEIGHBOUR.SE],
  [0, 1, AUTOTILE_NEIGHBOUR.S],
  [-1, 1, AUTOTILE_NEIGHBOUR.SW],
  [-1, 0, AUTOTILE_NEIGHBOUR.W],
  [-1, -1, AUTOTILE_NEIGHBOUR.NW],
]

/** A diagonal, and the two cardinals that must be walls for it to count. */
export interface AutotileCorner {
  readonly diagonal: AutotileNeighbourBit
  /** Both bits, as one mask. */
  readonly cardinals: number
}

/** Corners clockwise from north-east. Atlas cells are drawn in this order. */
export const AUTOTILE_CORNERS: readonly AutotileCorner[] = [
  { diagonal: AUTOTILE_NEIGHBOUR.NE, cardinals: AUTOTILE_NEIGHBOUR.N | AUTOTILE_NEIGHBOUR.E },
  { diagonal: AUTOTILE_NEIGHBOUR.SE, cardinals: AUTOTILE_NEIGHBOUR.E | AUTOTILE_NEIGHBOUR.S },
  { diagonal: AUTOTILE_NEIGHBOUR.SW, cardinals: AUTOTILE_NEIGHBOUR.S | AUTOTILE_NEIGHBOUR.W },
  { diagonal: AUTOTILE_NEIGHBOUR.NW, cardinals: AUTOTILE_NEIGHBOUR.W | AUTOTILE_NEIGHBOUR.N },
]

/** Every value an eight-neighbour mask can take. */
export const AUTOTILE_MASK_COUNT = 256

/** Distinct sprites the 256 masks collapse onto. */
export const AUTOTILE_TILE_COUNT = 47

/**
 * Strips the diagonals that cannot be seen, leaving the mask that decides
 * which sprite is drawn.
 *
 * The result is idempotent — a canonical mask canonicalises to itself — which
 * is what makes "the set of canonical masks" and "the set of sprites" the same
 * 47 things.
 */
export function autotileCanonicalMask(mask: number): number {
  const bits = mask & 0xff
  let canonical = bits & AUTOTILE_CARDINALS

  for (const corner of AUTOTILE_CORNERS) {
    if ((bits & corner.diagonal) === 0) continue
    if ((bits & corner.cardinals) === corner.cardinals) canonical |= corner.diagonal
  }

  return canonical
}

/**
 * Builds both tables in one pass.
 *
 * Canonicalising only ever clears bits, so `canonical(m) <= m`, and a canonical
 * mask is its own canonical form. A mask is therefore first seen at its own
 * value, and walking 0..255 upwards discovers the 47 canonical masks already
 * in ascending order.
 */
function buildAutotileTables(): {
  readonly indexByMask: Uint8Array
  readonly canonicalMasks: Uint8Array
} {
  const indexByMask = new Uint8Array(AUTOTILE_MASK_COUNT)
  const canonicalMasks = new Uint8Array(AUTOTILE_TILE_COUNT)
  const indexByCanonical = new Map<number, number>()

  for (let mask = 0; mask < AUTOTILE_MASK_COUNT; mask += 1) {
    const canonical = autotileCanonicalMask(mask)

    let index = indexByCanonical.get(canonical)
    if (index === undefined) {
      index = indexByCanonical.size
      if (index >= AUTOTILE_TILE_COUNT) {
        throw new RangeError(
          `blob autotiling must collapse onto ${AUTOTILE_TILE_COUNT} sprites, found more`,
        )
      }
      indexByCanonical.set(canonical, index)
      canonicalMasks[index] = canonical
    }

    indexByMask[mask] = index
  }

  if (indexByCanonical.size !== AUTOTILE_TILE_COUNT) {
    throw new RangeError(
      `blob autotiling must collapse onto ${AUTOTILE_TILE_COUNT} sprites, ` +
        `found ${indexByCanonical.size}`,
    )
  }

  return { indexByMask, canonicalMasks }
}

const TABLES = buildAutotileTables()

/** Neighbour mask (0..255) to sprite index (0..46). The hot path. */
export const AUTOTILE_INDEX_BY_MASK: Uint8Array = TABLES.indexByMask

/** Sprite index to the mask it represents, ascending. The atlas layout order. */
export const AUTOTILE_CANONICAL_MASKS: Uint8Array = TABLES.canonicalMasks

/** The sprite a neighbour mask draws. Bits above the low eight are ignored. */
export function autotileIndex(mask: number): number {
  // The index is masked into the table's own range, so it is always present.
  return AUTOTILE_INDEX_BY_MASK[mask & 0xff] ?? 0
}

/** The canonical mask a sprite index stands for. */
export function autotileMaskAt(index: number): number {
  const mask = AUTOTILE_CANONICAL_MASKS[index]
  if (mask === undefined) {
    throw new RangeError(`autotile index must be 0..${AUTOTILE_TILE_COUNT - 1}, received ${index}`)
  }
  return mask
}

/** Whether a mask connects in a direction. Reads better than a bare `&`. */
export function autotileConnects(mask: number, bit: AutotileNeighbourBit): boolean {
  return (mask & bit) !== 0
}

/**
 * Whether a corner of this tile faces a diagonal gap: both cardinals are
 * walls, so the tile is solid there, but the diagonal is not, so the solid
 * corner meets open ground. The atlas marks these with a seam, and they are
 * the only visual difference between, say, a cross with four diagonals and a
 * cross with none.
 */
export function autotileIsInnerCorner(mask: number, corner: AutotileCorner): boolean {
  return (mask & corner.cardinals) === corner.cardinals && (mask & corner.diagonal) === 0
}
