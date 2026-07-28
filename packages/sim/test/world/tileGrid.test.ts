import { performance } from 'node:perf_hooks'

import { afterEach, describe, expect, it } from 'vitest'

import { Fnv1aHasher } from '../../src/core/hash'
import { Rng } from '../../src/core/rng'
import { CHUNK_SIZE, chunkCount, chunksPerAxis, setBoundsChecks } from '../../src/world/coords'
import { BYTES_PER_TILE, PASSABILITY, TILE_FIELDS, TileGrid } from '../../src/world/tileGrid'
import type { TileArrayView, TileField } from '../../src/world/tileGrid'

const HUGE_MAP = 300
const MEGABYTE = 1024 * 1024

function allZero(view: TileArrayView): boolean {
  for (let i = 0; i < view.length; i += 1) {
    if (view[i] !== 0) return false
  }
  return true
}

function hashOf(grid: TileGrid): number {
  const hasher = new Fnv1aHasher()
  grid.hashInto(hasher)
  return hasher.digest()
}

afterEach(() => {
  setBoundsChecks(true)
})

describe('TileGrid allocation (PRD 4.3)', () => {
  it('has every field of PRD 4.3, each one tile per entry', () => {
    const grid = TileGrid.allocate(64)

    expect([...TILE_FIELDS].sort()).toEqual(
      [
        'dirt',
        'floorMaterial',
        'objectId',
        'outdoors',
        'owned',
        'passability',
        'powerGridId',
        'roomId',
        'sectorId',
        'temperature',
        'wallMaterial',
        'waterGridId',
      ].sort(),
    )

    for (const field of TILE_FIELDS) {
      expect(grid.array(field).length, field).toBe(64 * 64)
    }
  })

  it('uses the element widths PRD 4.3 specifies', () => {
    const grid = TileGrid.allocate(4)

    expect(grid.floorMaterial).toBeInstanceOf(Uint8Array)
    expect(grid.wallMaterial).toBeInstanceOf(Uint8Array)
    expect(grid.roomId).toBeInstanceOf(Uint16Array)
    expect(grid.sectorId).toBeInstanceOf(Uint16Array)
    expect(grid.objectId).toBeInstanceOf(Uint16Array)
    expect(grid.passability).toBeInstanceOf(Uint8Array)
    expect(grid.dirt).toBeInstanceOf(Uint8Array)
    expect(grid.temperature).toBeInstanceOf(Int8Array)
    expect(grid.powerGridId).toBeInstanceOf(Uint16Array)
    expect(grid.waterGridId).toBeInstanceOf(Uint16Array)
    expect(grid.outdoors).toBeInstanceOf(Uint8Array)
    expect(grid.owned).toBeInstanceOf(Uint8Array)

    expect(BYTES_PER_TILE).toBe(17)
  })

  it('holds a 300x300 map in well under 5MB', () => {
    const grid = TileGrid.allocate(HUGE_MAP)

    expect(grid.size).toBe(HUGE_MAP)
    expect(grid.tileCount).toBe(90_000)
    expect(grid.byteLength).toBe(90_000 * BYTES_PER_TILE)
    expect(grid.byteLength).toBeLessThan(5 * MEGABYTE)

    // The declared size has to match what was actually allocated, or the
    // budget above is measuring nothing.
    const measured = TILE_FIELDS.reduce((total, field) => total + grid.array(field).byteLength, 0)
    expect(measured).toBe(grid.byteLength)
  })

  it('allocates a 300x300 map well inside the 20ms budget', () => {
    // Wall-clock in a test only, never in sim code. Generous against a cold or
    // shared CI machine: the point is to catch an accidental per-tile object,
    // which would miss by orders of magnitude, not to benchmark.
    const started = performance.now()
    const grid = TileGrid.allocate(HUGE_MAP)
    const elapsed = performance.now() - started

    expect(grid.tileCount).toBe(90_000)
    expect(elapsed).toBeLessThan(20)
  })

  it('starts zeroed and clean', () => {
    const grid = TileGrid.allocate(32)

    for (const field of TILE_FIELDS) {
      expect(allZero(grid.array(field)), field).toBe(true)
    }
    expect(grid.dirtyChunkCount).toBe(0)
    expect(grid.consumeDirtyChunks()).toEqual([])
  })

  it('rejects a size outside the allocation guard', () => {
    expect(() => TileGrid.allocate(0)).toThrow(RangeError)
    expect(() => TileGrid.allocate(2.5)).toThrow(RangeError)
    expect(() => TileGrid.allocate(100_000)).toThrow(RangeError)
  })
})

describe('TileGrid reads and writes', () => {
  it('reads back what it writes, per field', () => {
    const grid = TileGrid.allocate(20)

    grid.set('floorMaterial', 3, 4, 7)
    grid.set('roomId', 3, 4, 65_535)
    grid.set('temperature', 3, 4, -40)
    grid.set('passability', 3, 4, PASSABILITY.WALKABLE | PASSABILITY.DOOR)

    expect(grid.get('floorMaterial', 3, 4)).toBe(7)
    expect(grid.get('roomId', 3, 4)).toBe(65_535)
    expect(grid.get('temperature', 3, 4)).toBe(-40)
    expect(grid.get('passability', 3, 4)).toBe(0b0011)

    // The public arrays and the accessors are the same memory.
    expect(grid.floorMaterial[grid.idx(3, 4)]).toBe(7)
    expect(grid.temperature[grid.idx(3, 4)]).toBe(-40)
  })

  it('keeps fields independent', () => {
    const grid = TileGrid.allocate(8)
    grid.set('dirt', 2, 2, 200)

    expect(grid.get('dirt', 2, 2)).toBe(200)
    expect(grid.get('floorMaterial', 2, 2)).toBe(0)
    expect(grid.get('owned', 2, 2)).toBe(0)
    expect(grid.get('dirt', 3, 2)).toBe(0)
  })

  it('fills a whole field', () => {
    const grid = TileGrid.allocate(8)
    grid.fill('owned', 1)

    expect(grid.owned.every((value) => value === 1)).toBe(true)
    expect(grid.dirtyChunkCount).toBe(grid.chunkCount)
  })

  it('rejects out-of-range coordinates and values in dev builds', () => {
    const grid = TileGrid.allocate(8)

    expect(() => grid.set('dirt', 8, 0, 1)).toThrow(RangeError)
    expect(() => grid.get('dirt', -1, 0)).toThrow(RangeError)
    expect(() => grid.setAt('dirt', 64, 1)).toThrow(RangeError)

    // Typed arrays truncate silently, so these are the writes worth catching.
    expect(() => grid.set('dirt', 0, 0, 256)).toThrow(RangeError)
    expect(() => grid.set('dirt', 0, 0, -1)).toThrow(RangeError)
    expect(() => grid.set('temperature', 0, 0, 128)).toThrow(RangeError)
    expect(() => grid.set('temperature', 0, 0, -129)).toThrow(RangeError)
    expect(() => grid.set('roomId', 0, 0, 65_536)).toThrow(RangeError)
    expect(() => grid.set('dirt', 0, 0, 1.5)).toThrow(RangeError)

    expect(() => grid.set('temperature', 0, 0, -128)).not.toThrow()
    expect(() => grid.set('roomId', 0, 0, 65_535)).not.toThrow()
  })

  it('drops the value check with the bounds checks', () => {
    const grid = TileGrid.allocate(8)
    setBoundsChecks(false)

    expect(() => grid.set('dirt', 0, 0, 256)).not.toThrow()
    // Truncated by the Uint8Array, which is exactly what the dev check warns about.
    expect(grid.get('dirt', 0, 0)).toBe(0)
  })
})

describe('TileGrid dirty chunk accounting', () => {
  it('marks exactly one chunk when one tile is written', () => {
    const grid = TileGrid.allocate(HUGE_MAP)

    grid.set('floorMaterial', 20, 33, 4)

    const dirty = grid.consumeDirtyChunks()
    expect(dirty).toHaveLength(1)
    expect(dirty[0]).toBe(grid.chunkIdAt(20, 33))
  })

  it('collapses repeated writes to the same chunk', () => {
    const grid = TileGrid.allocate(64)

    for (let y = 0; y < CHUNK_SIZE; y += 1) {
      for (let x = 0; x < CHUNK_SIZE; x += 1) {
        grid.set('dirt', x, y, 1)
      }
    }

    expect(grid.consumeDirtyChunks()).toEqual([0])
  })

  it('marks one chunk per chunk touched, across a chunk boundary', () => {
    const grid = TileGrid.allocate(64)
    const perAxis = chunksPerAxis(64)

    grid.set('dirt', CHUNK_SIZE - 1, 0, 1)
    grid.set('dirt', CHUNK_SIZE, 0, 1)
    grid.set('dirt', 0, CHUNK_SIZE, 1)

    expect(grid.consumeDirtyChunks()).toEqual([0, 1, perAxis])
  })

  it('returns chunk ids in ascending order regardless of write order', () => {
    const grid = TileGrid.allocate(64)

    grid.markDirty(63, 63)
    grid.markDirty(0, 0)
    grid.markDirty(20, 40)

    const dirty = grid.consumeDirtyChunks()
    expect([...dirty]).toEqual([...dirty].sort((a, b) => a - b))
    expect(dirty).toHaveLength(3)
  })

  it('clears the set when consumed', () => {
    const grid = TileGrid.allocate(32)

    grid.set('dirt', 1, 1, 1)
    expect(grid.dirtyChunkCount).toBe(1)
    expect(grid.isChunkDirty(0)).toBe(true)

    expect(grid.consumeDirtyChunks()).toHaveLength(1)
    expect(grid.dirtyChunkCount).toBe(0)
    expect(grid.isChunkDirty(0)).toBe(false)
    expect(grid.consumeDirtyChunks()).toEqual([])
  })

  it('marks every chunk a rectangle touches, clipped to the grid', () => {
    const grid = TileGrid.allocate(64)
    const perAxis = chunksPerAxis(64)

    grid.markDirtyRect(15, 15, 2, 2)
    expect(grid.consumeDirtyChunks()).toEqual([0, 1, perAxis, perAxis + 1])

    grid.markDirtyRect(-10, -10, 12, 12)
    expect(grid.consumeDirtyChunks()).toEqual([0])

    grid.markDirtyRect(-100, -100, 10, 10)
    expect(grid.consumeDirtyChunks()).toEqual([])

    grid.markDirtyRect(0, 0, 0, 5)
    expect(grid.consumeDirtyChunks()).toEqual([])
  })

  it('marks the whole grid on demand', () => {
    const grid = TileGrid.allocate(HUGE_MAP)
    grid.markAllDirty()

    const dirty = grid.consumeDirtyChunks()
    expect(dirty).toHaveLength(chunkCount(HUGE_MAP))
    expect(grid.chunkCount).toBe(361)
  })

  it('accounts for a random write set exactly once per chunk', () => {
    const random = new Rng(0xbeef_0001).stream('test.dirty')
    const grid = TileGrid.allocate(HUGE_MAP)
    const expected = new Set<number>()

    for (let i = 0; i < 500; i += 1) {
      const x = random.nextInt(0, HUGE_MAP)
      const y = random.nextInt(0, HUGE_MAP)
      grid.set('dirt', x, y, 1)
      expected.add(grid.chunkIdAt(x, y))
    }

    expect(grid.consumeDirtyChunks()).toEqual([...expected].sort((a, b) => a - b))
  })

  it('does not mark anything on a read', () => {
    const grid = TileGrid.allocate(32)

    grid.get('dirt', 5, 5)
    grid.array('dirt')
    grid.xy(17)

    expect(grid.dirtyChunkCount).toBe(0)
  })
})

describe('TileGrid buffers', () => {
  const fill = (grid: TileGrid): void => {
    const random = new Rng(0xc0ff_ee01).stream('test.buffers')
    const values: ReadonlyArray<[TileField, number]> = [
      ['floorMaterial', 200],
      ['roomId', 40_000],
      ['temperature', -100],
      ['owned', 1],
    ]

    for (const [field, value] of values) {
      const x = random.nextInt(0, grid.size)
      const y = random.nextInt(0, grid.size)
      grid.set(field, x, y, value)
    }
  }

  it('round-trips through fromBuffers without copying', () => {
    const source = TileGrid.allocate(48)
    fill(source)
    source.consumeDirtyChunks()

    const restored = TileGrid.fromBuffers(48, source.buffers())

    expect(restored.size).toBe(48)
    for (const field of TILE_FIELDS) {
      expect([...restored.array(field)], field).toEqual([...source.array(field)])
    }
    expect(hashOf(restored)).toBe(hashOf(source))
  })

  it('starts fully dirty, because its contents are new to every consumer', () => {
    const source = TileGrid.allocate(48)
    const restored = TileGrid.fromBuffers(48, source.buffers())

    expect(restored.dirtyChunkCount).toBe(chunkCount(48))
  })

  it('rejects a buffer of the wrong length', () => {
    const source = TileGrid.allocate(48)
    const buffers = { ...source.buffers(), dirt: new ArrayBuffer(10) }

    expect(() => TileGrid.fromBuffers(48, buffers)).toThrow(RangeError)
    expect(() => TileGrid.fromBuffers(49, source.buffers())).toThrow(RangeError)
  })
})

describe('TileGrid determinism hash', () => {
  it('changes when any tile changes and agrees between identical grids', () => {
    const a = TileGrid.allocate(32)
    const b = TileGrid.allocate(32)
    expect(hashOf(a)).toBe(hashOf(b))

    a.set('dirt', 7, 9, 1)
    expect(hashOf(a)).not.toBe(hashOf(b))

    b.set('dirt', 7, 9, 1)
    expect(hashOf(a)).toBe(hashOf(b))

    // The dirty set is a subscription, not state, so consuming it must not
    // move the fingerprint.
    const before = hashOf(a)
    a.consumeDirtyChunks()
    expect(hashOf(a)).toBe(before)
  })

  it('separates grids of different sizes holding the same bytes', () => {
    expect(hashOf(TileGrid.allocate(4))).not.toBe(hashOf(TileGrid.allocate(16)))
  })
})
