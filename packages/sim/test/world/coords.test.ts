import { afterEach, describe, expect, it } from 'vitest'

import { Rng } from '../../src/core/rng'
import {
  CHUNK_SIZE,
  MAX_GRID_SIZE,
  assertGridSize,
  boundsChecksEnabled,
  chunkBounds,
  chunkCount,
  chunkIdAt,
  chunkIdOfIndex,
  chunksPerAxis,
  idx,
  inBounds,
  setBoundsChecks,
  tileCount,
  tileX,
  tileY,
  xy,
} from '../../src/world/coords'

afterEach(() => {
  setBoundsChecks(true)
})

describe('tile coordinates (PRD 4.3)', () => {
  it('indexes row-major', () => {
    expect(idx(0, 0, 10)).toBe(0)
    expect(idx(9, 0, 10)).toBe(9)
    expect(idx(0, 1, 10)).toBe(10)
    expect(idx(9, 9, 10)).toBe(99)
    expect(tileCount(10)).toBe(100)
  })

  it('round-trips 1000 random coordinates through idx and xy', () => {
    // The seeded stream, not Math.random: a failure has to be reproducible.
    const random = new Rng(0x5eed_1234).stream('test.coords')

    for (const size of [1, 7, 16, 17, 100, 300]) {
      for (let i = 0; i < 1000; i += 1) {
        const x = random.nextInt(0, size)
        const y = random.nextInt(0, size)
        const index = idx(x, y, size)

        expect(index).toBeGreaterThanOrEqual(0)
        expect(index).toBeLessThan(tileCount(size))
        expect(xy(index, size), `size ${size}, tile (${x}, ${y})`).toEqual({ x, y })
        expect(tileX(index, size)).toBe(x)
        expect(tileY(index, size)).toBe(y)
      }
    }
  })

  it('round-trips every index of a small grid', () => {
    const size = 23
    for (let index = 0; index < tileCount(size); index += 1) {
      const { x, y } = xy(index, size)
      expect(idx(x, y, size)).toBe(index)
    }
  })

  it('rejects sizes outside the allocation guard', () => {
    expect(() => assertGridSize(0)).toThrow(RangeError)
    expect(() => assertGridSize(-1)).toThrow(RangeError)
    expect(() => assertGridSize(1.5)).toThrow(RangeError)
    expect(() => assertGridSize(MAX_GRID_SIZE + 1)).toThrow(RangeError)
    expect(() => assertGridSize(MAX_GRID_SIZE)).not.toThrow()
    // PRD 4.3 map sizes: Small, Medium, Large, Huge.
    for (const size of [100, 160, 220, 300]) {
      expect(() => assertGridSize(size)).not.toThrow()
    }
  })

  it('reports what is inside the grid', () => {
    expect(inBounds(0, 0, 10)).toBe(true)
    expect(inBounds(9, 9, 10)).toBe(true)
    expect(inBounds(10, 0, 10)).toBe(false)
    expect(inBounds(-1, 0, 10)).toBe(false)
    expect(inBounds(0.5, 0, 10)).toBe(false)
  })
})

describe('bounds checks (dev builds only)', () => {
  it('throws on an out-of-bounds coordinate while enabled', () => {
    expect(boundsChecksEnabled()).toBe(true)
    expect(() => idx(-1, 0, 10)).toThrow(RangeError)
    expect(() => idx(10, 0, 10)).toThrow(RangeError)
    expect(() => idx(0, 10, 10)).toThrow(RangeError)
    expect(() => xy(100, 10)).toThrow(RangeError)
  })

  it('costs nothing once disabled', () => {
    setBoundsChecks(false)

    expect(boundsChecksEnabled()).toBe(false)
    expect(() => idx(-1, 0, 10)).not.toThrow()
    expect(idx(10, 0, 10)).toBe(10)
  })
})

describe('chunks', () => {
  it('is 16x16 tiles', () => {
    expect(CHUNK_SIZE).toBe(16)
  })

  it('rounds the chunk grid up to cover a partial last chunk', () => {
    expect(chunksPerAxis(16)).toBe(1)
    expect(chunksPerAxis(17)).toBe(2)
    expect(chunksPerAxis(300)).toBe(19)
    expect(chunkCount(300)).toBe(361)
  })

  it('maps tiles to row-major chunk ids', () => {
    const size = 300
    const perAxis = chunksPerAxis(size)

    expect(chunkIdAt(0, 0, size)).toBe(0)
    expect(chunkIdAt(15, 15, size)).toBe(0)
    expect(chunkIdAt(16, 0, size)).toBe(1)
    expect(chunkIdAt(0, 16, size)).toBe(perAxis)
    expect(chunkIdAt(299, 299, size)).toBe(chunkCount(size) - 1)
  })

  it('agrees between the coordinate and index forms', () => {
    const random = new Rng(0x5eed_4321).stream('test.chunks')
    const size = 300

    for (let i = 0; i < 1000; i += 1) {
      const x = random.nextInt(0, size)
      const y = random.nextInt(0, size)
      expect(chunkIdOfIndex(idx(x, y, size), size)).toBe(chunkIdAt(x, y, size))
    }
  })

  it('clips the far edge chunks of a grid that is not a multiple of 16', () => {
    const size = 300

    expect(chunkBounds(0, size)).toEqual({ x: 0, y: 0, width: 16, height: 16 })
    // 300 = 18 * 16 + 12, so the last row and column are 12 tiles.
    expect(chunkBounds(chunkCount(size) - 1, size)).toEqual({
      x: 288,
      y: 288,
      width: 12,
      height: 12,
    })
  })

  it('covers every tile exactly once with its chunk rectangles', () => {
    const size = 40
    const covered = new Uint8Array(tileCount(size))

    for (let chunkId = 0; chunkId < chunkCount(size); chunkId += 1) {
      const bounds = chunkBounds(chunkId, size)
      for (let y = bounds.y; y < bounds.y + bounds.height; y += 1) {
        for (let x = bounds.x; x < bounds.x + bounds.width; x += 1) {
          const index = idx(x, y, size)
          expect(chunkIdAt(x, y, size)).toBe(chunkId)
          expect(covered[index], `tile ${index} is claimed by two chunks`).toBe(0)
          covered[index] = 1
        }
      }
    }

    expect(covered.every((flag) => flag === 1)).toBe(true)
  })

  it('rejects a chunk id from another grid', () => {
    expect(() => chunkBounds(chunkCount(300), 300)).toThrow(RangeError)
    expect(() => chunkBounds(-1, 300)).toThrow(RangeError)
  })
})
