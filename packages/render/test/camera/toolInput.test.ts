/**
 * Build-stroke geometry.
 *
 * The controller itself needs a DOM and pointer events, which the workspace's
 * node environment does not have. What is worth pinning without one is the
 * arithmetic that decides what a drag *means* — the rectangle two tiles bound,
 * and the axis a diagonal drag collapses onto — because every build command in
 * `packages/sim` takes one or the other, and getting either wrong builds the
 * wrong thing rather than failing.
 */

import { describe, expect, it } from 'vitest'

import { lineBetween, rectBetween } from '../../src/camera/toolInput'

describe('rectBetween', () => {
  it('includes both corners', () => {
    expect(rectBetween({ x: 2, y: 3 }, { x: 5, y: 7 })).toEqual({
      x: 2,
      y: 3,
      width: 4,
      height: 5,
    })
  })

  it('normalises a drag made in any direction', () => {
    const corners = [
      [
        { x: 5, y: 7 },
        { x: 2, y: 3 },
      ],
      [
        { x: 2, y: 7 },
        { x: 5, y: 3 },
      ],
      [
        { x: 5, y: 3 },
        { x: 2, y: 7 },
      ],
    ] as const

    for (const [from, to] of corners) {
      expect(rectBetween(from, to)).toEqual({ x: 2, y: 3, width: 4, height: 5 })
    }
  })

  it('is one tile for a drag that never left its starting tile', () => {
    expect(rectBetween({ x: 9, y: 9 }, { x: 9, y: 9 })).toEqual({
      x: 9,
      y: 9,
      width: 1,
      height: 1,
    })
  })
})

describe('lineBetween', () => {
  it('keeps a horizontal drag horizontal', () => {
    expect(lineBetween({ x: 2, y: 5 }, { x: 9, y: 5 })).toEqual({ x1: 2, y1: 5, x2: 9, y2: 5 })
  })

  it('keeps a vertical drag vertical', () => {
    expect(lineBetween({ x: 4, y: 1 }, { x: 4, y: 8 })).toEqual({ x1: 4, y1: 1, x2: 4, y2: 8 })
  })

  it('collapses a diagonal onto whichever axis travelled further', () => {
    // Walls are axis-aligned, so a diagonal has to become one of the two runs
    // the player might have meant rather than being refused.
    expect(lineBetween({ x: 0, y: 0 }, { x: 10, y: 3 })).toEqual({ x1: 0, y1: 0, x2: 10, y2: 0 })
    expect(lineBetween({ x: 0, y: 0 }, { x: 3, y: 10 })).toEqual({ x1: 0, y1: 0, x2: 0, y2: 10 })
  })

  it('breaks an exact tie towards horizontal', () => {
    expect(lineBetween({ x: 0, y: 0 }, { x: 6, y: 6 })).toEqual({ x1: 0, y1: 0, x2: 6, y2: 0 })
  })

  it('always starts at the tile the drag started on', () => {
    const line = lineBetween({ x: 12, y: 4 }, { x: 3, y: 5 })
    expect([line.x1, line.y1]).toEqual([12, 4])
  })
})
