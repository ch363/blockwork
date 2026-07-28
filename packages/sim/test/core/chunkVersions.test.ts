/**
 * Chunk version counters.
 *
 * The property that matters is the one the snapshot's `changedChunks` could
 * not provide: **a change is never missed, however many publishes the reader
 * skips**. The snapshot ring keeps only the newest frame by design, so at 20x
 * the renderer sees roughly one publish in two; a delta carried on that
 * transport loses whatever changed in the frames nobody read.
 */

import { describe, expect, it } from 'vitest'

import {
  ChunkVersionReader,
  ChunkVersionWriter,
  chunkVersionBytes,
  createChunkVersionBuffer,
} from '../../src/core/chunkVersions'
import { chunkCount } from '../../src/world/coords'

const SIZE = 64

function pair(size = SIZE): { writer: ChunkVersionWriter; reader: ChunkVersionReader } {
  const buffer = createChunkVersionBuffer(size, false)
  return {
    writer: new ChunkVersionWriter(buffer, size),
    reader: new ChunkVersionReader(buffer, size),
  }
}

describe('chunkVersionBytes', () => {
  it('sizes four bytes per chunk', () => {
    expect(chunkVersionBytes(SIZE)).toBe(chunkCount(SIZE) * 4)
  })

  it('refuses a buffer of the wrong length', () => {
    const buffer = createChunkVersionBuffer(SIZE, false)
    expect(() => new ChunkVersionWriter(buffer, 128)).toThrow(RangeError)
    expect(() => new ChunkVersionReader(buffer, 128)).toThrow(RangeError)
  })
})

describe('ChunkVersionReader', () => {
  it('reports nothing when nothing has changed', () => {
    const { reader } = pair()
    expect(reader.consume()).toEqual([])
    expect(reader.consume()).toEqual([])
  })

  it('reports a changed chunk once, then stops', () => {
    const { writer, reader } = pair()

    writer.bump([5])
    expect(reader.consume()).toEqual([5])
    expect(reader.consume()).toEqual([])
  })

  it('reports each changed chunk exactly once, in ascending order', () => {
    const { writer, reader } = pair()

    // A 64-tile map is 4x4 chunks, so 15 is the last valid id.
    writer.bump([9, 2, 15])
    expect(reader.consume()).toEqual([2, 9, 15])
  })

  it('collapses many writes between reads into one report', () => {
    const { writer, reader } = pair()

    // The case the delta transport got wrong: the reader skipped every frame
    // in between, and must still learn that chunk 7 moved — once.
    for (let i = 0; i < 200; i += 1) writer.bump([7])

    expect(reader.consume()).toEqual([7])
    expect(reader.consume()).toEqual([])
  })

  it('never loses a chunk that changed while the reader was away', () => {
    const { writer, reader } = pair()

    writer.bump([1])
    reader.consume()

    writer.bump([1, 2])
    writer.bump([3])
    writer.bump([1])

    expect(reader.consume()).toEqual([1, 2, 3])
  })

  it('survives a counter wrapping past 2^31', () => {
    const size = 16
    const buffer = createChunkVersionBuffer(size, false)
    // Park chunk 0 one short of overflowing a signed 32-bit counter.
    new Int32Array(buffer)[0] = 0x7fff_ffff

    const writer = new ChunkVersionWriter(buffer, size)
    const reader = new ChunkVersionReader(buffer, size)
    reader.consume()

    writer.bump([0])
    // Wrapped to a negative number, which is still a *different* number, which
    // is the only thing the comparison asks of it.
    expect(reader.consume()).toEqual([0])
  })

  it('ignores chunk ids outside the map', () => {
    const { writer, reader } = pair()

    writer.bump([-1, 99_999])
    expect(reader.consume()).toEqual([])
  })

  it('reports every chunk after invalidateAll', () => {
    const { reader } = pair()

    reader.invalidateAll()
    expect(reader.consume().length).toBe(chunkCount(SIZE))
    expect(reader.consume()).toEqual([])
  })
})
