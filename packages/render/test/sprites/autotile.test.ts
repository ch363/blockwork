import { describe, expect, it } from 'vitest'

import {
  AUTOTILE_CANONICAL_MASKS,
  AUTOTILE_CARDINALS,
  AUTOTILE_CORNERS,
  AUTOTILE_DIAGONALS,
  AUTOTILE_INDEX_BY_MASK,
  AUTOTILE_MASK_COUNT,
  AUTOTILE_NEIGHBOUR,
  AUTOTILE_OFFSETS,
  AUTOTILE_TILE_COUNT,
  autotileCanonicalMask,
  autotileConnects,
  autotileIndex,
  autotileIsInnerCorner,
  autotileMaskAt,
} from '../../src/sprites/autotile'

const { N, NE, E, SE, S, SW, W, NW } = AUTOTILE_NEIGHBOUR

/** Every mask an eight-neighbour tile can have. */
const ALL_MASKS = Array.from({ length: AUTOTILE_MASK_COUNT }, (_, mask) => mask)

/**
 * The 47 blob tiles, written out longhand rather than derived, so this test
 * catches a table generator that is wrong in the same way twice.
 *
 * A mask belongs here when every diagonal bit it sets has both of its
 * cardinals set. Grouped by cardinal subset, which is how it was enumerated:
 *
 *   no cardinals                                 1
 *   one cardinal                        4 x 1 =  4
 *   two opposite cardinals              2 x 1 =  2
 *   two adjacent cardinals, +/- 1 corner 4 x 2 =  8
 *   three cardinals, +/- 2 corners      4 x 4 = 16
 *   four cardinals, +/- 4 corners       1 x 16 = 16
 *                                             ---
 *                                              47
 */
const EXPECTED_CANONICAL_MASKS: readonly number[] = [
  0, // isolated post
  1, // N
  4, // E
  5, // N E
  7, // N E + NE
  16, // S
  17, // N S
  20, // E S
  21, // N E S
  23, // N E S + NE
  28, // E S + SE
  29, // N E S + SE
  31, // N E S + NE SE
  64, // W
  65, // N W
  68, // E W
  69, // N E W
  71, // N E W + NE
  80, // S W
  81, // N S W
  84, // E S W
  85, // N E S W
  87, // N E S W + NE
  92, // E S W + SE
  93, // N E S W + SE
  95, // N E S W + NE SE
  112, // S W + SW
  113, // N S W + SW
  116, // E S W + SW
  117, // N E S W + SW
  119, // N E S W + NE SW
  124, // E S W + SE SW
  125, // N E S W + SE SW
  127, // N E S W + NE SE SW
  193, // N W + NW
  197, // N E W + NW
  199, // N E W + NE NW
  209, // N S W + NW
  213, // N E S W + NW
  215, // N E S W + NE NW
  221, // N E S W + SE NW
  223, // N E S W + NE SE NW
  241, // N S W + SW NW
  245, // N E S W + SW NW
  247, // N E S W + NE SW NW
  253, // N E S W + SE SW NW
  255, // every neighbour
]

/**
 * The specification, restated as an equivalence rather than as a construction:
 * two tiles draw the same sprite exactly when they agree on all four cardinals
 * and on every diagonal whose two cardinals are both present.
 */
function drawsTheSame(a: number, b: number): boolean {
  if ((a & AUTOTILE_CARDINALS) !== (b & AUTOTILE_CARDINALS)) return false

  for (const corner of AUTOTILE_CORNERS) {
    if ((a & corner.cardinals) !== corner.cardinals) continue
    if ((a & corner.diagonal) !== (b & corner.diagonal)) return false
  }

  return true
}

describe('autotile neighbour bits', () => {
  it('matches the ordering sim/world/walls.ts builds masks in', () => {
    // WALL_NEIGHBOUR, clockwise from north. Restated because PRD 7.2 lets
    // render import types from sim but not values.
    expect(AUTOTILE_NEIGHBOUR).toEqual({
      N: 1,
      NE: 2,
      E: 4,
      SE: 8,
      S: 16,
      SW: 32,
      W: 64,
      NW: 128,
    })
    expect(AUTOTILE_CARDINALS).toBe(N | E | S | W)
    expect(AUTOTILE_DIAGONALS).toBe(NE | SE | SW | NW)
    expect(AUTOTILE_CARDINALS | AUTOTILE_DIAGONALS).toBe(0xff)
  })

  it('lists the eight offsets in bit order', () => {
    expect(AUTOTILE_OFFSETS).toEqual([
      [0, -1, N],
      [1, -1, NE],
      [1, 0, E],
      [1, 1, SE],
      [0, 1, S],
      [-1, 1, SW],
      [-1, 0, W],
      [-1, -1, NW],
    ])
  })
})

describe('the 47-tile lookup table', () => {
  it('holds one entry per neighbour permutation', () => {
    expect(AUTOTILE_INDEX_BY_MASK).toHaveLength(AUTOTILE_MASK_COUNT)
    expect(AUTOTILE_CANONICAL_MASKS).toHaveLength(AUTOTILE_TILE_COUNT)
  })

  it('maps all 256 permutations into the 47 sprites', () => {
    const seen = new Set<number>()
    for (const mask of ALL_MASKS) {
      const index = autotileIndex(mask)
      expect(Number.isInteger(index)).toBe(true)
      expect(index).toBeGreaterThanOrEqual(0)
      expect(index).toBeLessThan(AUTOTILE_TILE_COUNT)
      seen.add(index)
    }
    expect(seen.size).toBe(AUTOTILE_TILE_COUNT)
  })

  it('collapses onto exactly the 47 canonical masks, in ascending order', () => {
    expect([...AUTOTILE_CANONICAL_MASKS]).toEqual(EXPECTED_CANONICAL_MASKS)
  })

  it('gives each canonical mask its own sprite, and that sprite its mask back', () => {
    for (const [index, mask] of EXPECTED_CANONICAL_MASKS.entries()) {
      expect(autotileIndex(mask)).toBe(index)
      expect(autotileMaskAt(index)).toBe(mask)
      expect(autotileCanonicalMask(mask)).toBe(mask)
    }
  })

  it('sends every permutation to the sprite of its canonical mask', () => {
    for (const mask of ALL_MASKS) {
      expect(autotileMaskAt(autotileIndex(mask))).toBe(autotileCanonicalMask(mask))
    }
  })

  it('shares a sprite between two permutations exactly when they look alike', () => {
    for (const a of ALL_MASKS) {
      for (const b of ALL_MASKS) {
        expect(autotileIndex(a) === autotileIndex(b)).toBe(drawsTheSame(a, b))
      }
    }
  })

  it('ignores bits above the low eight', () => {
    for (const mask of ALL_MASKS) {
      expect(autotileIndex(mask | 0x100)).toBe(autotileIndex(mask))
      expect(autotileIndex(mask | 0xff00)).toBe(autotileIndex(mask))
    }
  })

  it('rejects a sprite index outside the set', () => {
    expect(() => autotileMaskAt(-1)).toThrow(RangeError)
    expect(() => autotileMaskAt(AUTOTILE_TILE_COUNT)).toThrow(RangeError)
  })
})

describe('canonicalisation', () => {
  it('never invents a neighbour', () => {
    for (const mask of ALL_MASKS) {
      const canonical = autotileCanonicalMask(mask)
      expect(canonical & ~mask).toBe(0)
    }
  })

  it('keeps every cardinal', () => {
    for (const mask of ALL_MASKS) {
      expect(autotileCanonicalMask(mask) & AUTOTILE_CARDINALS).toBe(mask & AUTOTILE_CARDINALS)
    }
  })

  it('drops a diagonal whose cardinals are not both walls', () => {
    // A north-east neighbour with nothing to the north is round a corner the
    // middle tile cannot see.
    expect(autotileCanonicalMask(NE | E)).toBe(E)
    expect(autotileCanonicalMask(NE | N)).toBe(N)
    expect(autotileCanonicalMask(AUTOTILE_DIAGONALS)).toBe(0)
    expect(autotileIndex(AUTOTILE_DIAGONALS)).toBe(autotileIndex(0))
  })

  it('keeps a diagonal whose cardinals are both walls', () => {
    expect(autotileCanonicalMask(NE | N | E)).toBe(NE | N | E)
    expect(autotileIndex(NE | N | E)).not.toBe(autotileIndex(N | E))
  })

  it('is idempotent', () => {
    for (const mask of ALL_MASKS) {
      const once = autotileCanonicalMask(mask)
      expect(autotileCanonicalMask(once)).toBe(once)
    }
  })
})

describe('the shapes a builder actually draws', () => {
  it('tiles an isolated wall as a post', () => {
    const post = autotileIndex(0)
    expect(autotileMaskAt(post)).toBe(0)
    for (const corner of AUTOTILE_CORNERS) {
      expect(autotileIsInnerCorner(0, corner)).toBe(false)
    }
  })

  it('tiles a straight run the same along its whole length', () => {
    const horizontal = autotileIndex(E | W)
    const vertical = autotileIndex(N | S)
    expect(horizontal).not.toBe(vertical)
    // Diagonals beside a straight run change nothing: there is no corner.
    expect(autotileIndex(E | W | NE | NW | SE | SW)).toBe(horizontal)
    expect(autotileIndex(N | S | NE | NW | SE | SW)).toBe(vertical)
  })

  it('tiles the four ends of a run distinctly', () => {
    const ends = new Set([autotileIndex(N), autotileIndex(E), autotileIndex(S), autotileIndex(W)])
    expect(ends.size).toBe(4)
  })

  it('tiles a corner, and separates its filled and open diagonal', () => {
    const openCorner = autotileIndex(N | E)
    const filledCorner = autotileIndex(N | E | NE)
    expect(openCorner).not.toBe(filledCorner)
    expect(autotileMaskAt(openCorner)).toBe(N | E)
    expect(autotileMaskAt(filledCorner)).toBe(N | E | NE)

    // The open one is where the wall wraps a diagonal gap, so it gets a seam.
    const northEast = AUTOTILE_CORNERS[0]
    expect(northEast).toBeDefined()
    if (northEast === undefined) return
    expect(autotileIsInnerCorner(N | E, northEast)).toBe(true)
    expect(autotileIsInnerCorner(N | E | NE, northEast)).toBe(false)

    // All four corners of the compass tile differently from one another.
    const corners = new Set([
      autotileIndex(N | E),
      autotileIndex(E | S),
      autotileIndex(S | W),
      autotileIndex(W | N),
    ])
    expect(corners.size).toBe(4)
  })

  it('tiles a T-junction with two seams, one per diagonal gap', () => {
    // A wall running north-south with a spur east: the two eastern diagonals
    // are the only ones that can be filled.
    const tee = N | E | S
    expect(autotileMaskAt(autotileIndex(tee))).toBe(tee)

    const seams = AUTOTILE_CORNERS.filter((corner) => autotileIsInnerCorner(tee, corner))
    expect(seams.map((corner) => corner.diagonal)).toEqual([NE, SE])

    // Its four fillings are four distinct sprites, and the four rotations of
    // the bare T are four more.
    const fillings = new Set([
      autotileIndex(tee),
      autotileIndex(tee | NE),
      autotileIndex(tee | SE),
      autotileIndex(tee | NE | SE),
    ])
    expect(fillings.size).toBe(4)

    const rotations = new Set([
      autotileIndex(N | E | S),
      autotileIndex(E | S | W),
      autotileIndex(S | W | N),
      autotileIndex(W | N | E),
    ])
    expect(rotations.size).toBe(4)
  })

  it('tiles a cross, and its sixteen diagonal fillings', () => {
    const cross = N | E | S | W
    expect(autotileMaskAt(autotileIndex(cross))).toBe(cross)
    for (const corner of AUTOTILE_CORNERS) {
      expect(autotileIsInnerCorner(cross, corner)).toBe(true)
      expect(autotileConnects(cross, corner.diagonal)).toBe(false)
    }

    const fillings = new Set<number>()
    for (let diagonals = 0; diagonals < 16; diagonals += 1) {
      const mask =
        cross |
        (diagonals & 1 ? NE : 0) |
        (diagonals & 2 ? SE : 0) |
        (diagonals & 4 ? SW : 0) |
        (diagonals & 8 ? NW : 0)
      fillings.add(autotileIndex(mask))
    }
    expect(fillings.size).toBe(16)

    // A tile with every neighbour is interior: no seams, nothing to draw round.
    const interior = autotileIndex(0xff)
    expect(autotileMaskAt(interior)).toBe(0xff)
    for (const corner of AUTOTILE_CORNERS) {
      expect(autotileIsInnerCorner(0xff, corner)).toBe(false)
    }
  })
})
