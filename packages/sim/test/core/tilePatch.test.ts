/**
 * The tile patch codec: how the world's appearance reaches a renderer that
 * cannot share memory with it.
 *
 * The property under test is that the two transports converge — a mirror fed
 * by patches holds the same drawable bytes as the grid they came from. If that
 * ever stops being true, the fallback path renders a different prison from the
 * one the simulation is running, and nothing else in the codebase would catch
 * it.
 */

import { describe, expect, it } from 'vitest'

import {
  TILES_PER_CHUNK,
  TILE_PATCH_MAGIC,
  applyTilePatch,
  createTileMirror,
  decodeTilePatch,
  encodeTilePatch,
  tilePatchBytes,
} from '../../src/core/tilePatch'
import { CHUNK_SIZE, chunkCount, chunkIdAt } from '../../src/world/coords'
import { TileGrid } from '../../src/world/tileGrid'

const SIZE = 64

/** A grid with a distinct value in every drawable field of every tile. */
function paintedGrid(size = SIZE): TileGrid {
  const grid = TileGrid.allocate(size)

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      grid.set('floorMaterial', x, y, (x * 7 + y * 3) % 251)
      grid.set('wallMaterial', x, y, (x + y) % 17)
      grid.set('roomId', x, y, (x * 31 + y) % 60_000)
      grid.set('objectId', x, y, (y * 13 + x) % 60_000)
      // Not drawable: must not travel, and must not be needed to draw.
      grid.set('temperature', x, y, ((x - y) % 100) - 50)
    }
  }

  grid.consumeDirtyChunks()
  return grid
}

function allChunks(size = SIZE): number[] {
  return Array.from({ length: chunkCount(size) }, (_, id) => id)
}

describe('encodeTilePatch', () => {
  it('produces an exactly sized buffer', () => {
    const grid = paintedGrid()
    const buffer = encodeTilePatch(grid, [0, 1, 2])

    expect(buffer.byteLength).toBe(tilePatchBytes(3))
  })

  it('writes the magic so a snapshot cannot be mistaken for a patch', () => {
    const buffer = encodeTilePatch(paintedGrid(), [0])
    expect(new DataView(buffer).getUint32(0, true)).toBe(TILE_PATCH_MAGIC)
  })

  it('refuses a chunk id outside the map', () => {
    expect(() => encodeTilePatch(paintedGrid(), [99_999])).toThrow()
  })
})

describe('decodeTilePatch', () => {
  it('round-trips one chunk exactly', () => {
    const grid = paintedGrid()
    const chunkId = chunkIdAt(20, 36, SIZE)

    const patch = decodeTilePatch(encodeTilePatch(grid, [chunkId]))
    expect(patch).not.toBeNull()
    if (patch === null) throw new Error('expected a patch')

    expect(patch.gridSize).toBe(SIZE)
    expect(patch.chunks.length).toBe(1)

    const chunk = patch.chunks[0]
    if (chunk === undefined) throw new Error('expected a chunk')
    expect(chunk.chunkId).toBe(chunkId)
    expect(chunk.floorMaterial.length).toBe(TILES_PER_CHUNK)

    // Row-major within the chunk, starting at its own origin.
    const originX = (chunkId % (SIZE / CHUNK_SIZE)) * CHUNK_SIZE
    const originY = Math.floor(chunkId / (SIZE / CHUNK_SIZE)) * CHUNK_SIZE
    for (let y = 0; y < CHUNK_SIZE; y += 1) {
      for (let x = 0; x < CHUNK_SIZE; x += 1) {
        const at = y * CHUNK_SIZE + x
        expect(chunk.floorMaterial[at]).toBe(grid.get('floorMaterial', originX + x, originY + y))
        expect(chunk.roomId[at]).toBe(grid.get('roomId', originX + x, originY + y))
      }
    }
  })

  it('returns null rather than throwing on a buffer that is not a patch', () => {
    expect(decodeTilePatch(new ArrayBuffer(4))).toBeNull()
    expect(decodeTilePatch(new ArrayBuffer(64))).toBeNull()

    const truncated = encodeTilePatch(paintedGrid(), [0, 1]).slice(0, 40)
    expect(decodeTilePatch(truncated)).toBeNull()
  })

  it('returns null on a corrupt chunk id', () => {
    const buffer = encodeTilePatch(paintedGrid(), [0])
    new DataView(buffer).setUint32(16, 99_999, true)
    expect(decodeTilePatch(buffer)).toBeNull()
  })
})

describe('applyTilePatch', () => {
  it('reproduces every drawable field of the whole grid', () => {
    const grid = paintedGrid()
    const mirror = createTileMirror(SIZE)

    const patch = decodeTilePatch(encodeTilePatch(grid, allChunks()))
    if (patch === null) throw new Error('expected a patch')
    applyTilePatch(mirror, patch)

    expect(mirror.floorMaterial).toEqual(grid.floorMaterial)
    expect(mirror.wallMaterial).toEqual(grid.wallMaterial)
    expect(mirror.roomId).toEqual(grid.roomId)
    expect(mirror.objectId).toEqual(grid.objectId)
  })

  it('touches only the chunks it carries', () => {
    const grid = paintedGrid()
    const mirror = createTileMirror(SIZE)

    const chunkId = chunkIdAt(0, 0, SIZE)
    const patch = decodeTilePatch(encodeTilePatch(grid, [chunkId]))
    if (patch === null) throw new Error('expected a patch')

    expect(applyTilePatch(mirror, patch)).toEqual([chunkId])
    expect(mirror.floorMaterial[grid.idx(0, 0)]).toBe(grid.get('floorMaterial', 0, 0))
    // Well outside that chunk: still untouched.
    expect(mirror.floorMaterial[grid.idx(40, 40)]).toBe(0)
  })

  it('carries a later change over an earlier one', () => {
    const grid = paintedGrid()
    const mirror = createTileMirror(SIZE)

    const chunkId = chunkIdAt(2, 2, SIZE)
    const first = decodeTilePatch(encodeTilePatch(grid, [chunkId]))
    if (first === null) throw new Error('expected a patch')
    applyTilePatch(mirror, first)

    grid.set('wallMaterial', 2, 2, 9)
    const second = decodeTilePatch(encodeTilePatch(grid, [chunkId]))
    if (second === null) throw new Error('expected a patch')
    applyTilePatch(mirror, second)

    expect(mirror.wallMaterial[grid.idx(2, 2)]).toBe(9)
  })

  it('ignores a patch for a map of a different size', () => {
    const grid = paintedGrid()
    const mirror = createTileMirror(32)

    const patch = decodeTilePatch(encodeTilePatch(grid, [0]))
    if (patch === null) throw new Error('expected a patch')

    expect(applyTilePatch(mirror, patch)).toEqual([])
  })

  it('clips a partial edge chunk rather than writing past the row', () => {
    // 40 is not a multiple of CHUNK_SIZE, so the right-hand chunks are short.
    const size = 40
    const grid = paintedGrid(size)
    const mirror = createTileMirror(size)

    const patch = decodeTilePatch(encodeTilePatch(grid, allChunks(size)))
    if (patch === null) throw new Error('expected a patch')
    applyTilePatch(mirror, patch)

    expect(mirror.floorMaterial).toEqual(grid.floorMaterial)
    expect(mirror.roomId).toEqual(grid.roomId)
  })
})
