/**
 * A per-chunk version counter in shared memory: how the renderer learns what
 * to re-mesh without ever missing a change.
 *
 * The obvious design is to read `changedChunks` off each snapshot, and it is
 * wrong. The snapshot transport is a two-slot ring that keeps only the newest
 * frame, which is exactly what makes reads wait-free — but it means that when
 * the simulation runs at 20x and publishes eighty frames a second while the
 * display refreshes sixty times, the renderer *never sees* most snapshots. A
 * chunk that changed in a snapshot nobody read is a chunk that never gets
 * redrawn, and the symptom is a wall that stays invisible until something else
 * happens to dirty the same chunk. Deltas are only safe on a transport that
 * guarantees delivery, and this one deliberately does not.
 *
 * A version counter has no such problem because it is state, not an event. The
 * writer bumps a chunk's counter whenever it changes; the reader keeps its own
 * copy and re-meshes every chunk whose counter moved. Miss a hundred bumps and
 * you still notice, once, which is the correct number of times to redraw.
 *
 * Cost is one `Atomics.add` per changed chunk on the worker, and one pass over
 * a small integer array per frame on the main thread: 196 entries for the
 * 220x220 map of PRD 4.3, well inside the 2ms the frame budget gives the
 * snapshot read.
 *
 * The `postMessage` fallback does not use this at all — there the tile bytes
 * travel with the chunk ids, and delivery is guaranteed.
 */

import { assertGridSize, chunkCount } from '../world/coords'

/** Bytes needed to version every chunk of a `size` x `size` map. */
export function chunkVersionBytes(size: number): number {
  assertGridSize(size)
  return chunkCount(size) * 4
}

/**
 * Allocates the table. Shared where the host allows it; the private form is
 * for tests, which want the same semantics without cross-origin isolation.
 */
export function createChunkVersionBuffer(size: number, shared = true): ArrayBufferLike {
  const bytes = chunkVersionBytes(size)
  return shared ? new SharedArrayBuffer(bytes) : new ArrayBuffer(bytes)
}

/**
 * The worker's half. One `Atomics.add` per changed chunk, so a step that
 * changes nothing costs nothing.
 */
export class ChunkVersionWriter {
  readonly #versions: Int32Array

  constructor(buffer: ArrayBufferLike, size: number) {
    if (buffer.byteLength !== chunkVersionBytes(size)) {
      throw new RangeError(
        `chunk version buffer must be ${chunkVersionBytes(size)} bytes for a ${size}x${size} ` +
          `map, received ${buffer.byteLength}`,
      )
    }
    this.#versions = new Int32Array(buffer)
  }

  get chunkCount(): number {
    return this.#versions.length
  }

  /** Records that these chunks changed. Ids outside the map are ignored. */
  bump(chunkIds: readonly number[]): void {
    for (const chunkId of chunkIds) {
      if (chunkId < 0 || chunkId >= this.#versions.length) continue
      Atomics.add(this.#versions, chunkId, 1)
    }
  }

  /** The current counter for one chunk. For tests and diagnostics. */
  versionOf(chunkId: number): number {
    return Atomics.load(this.#versions, chunkId)
  }
}

/**
 * The main thread's half.
 *
 * `consume()` returns the chunks that changed since the last call. The first
 * call after construction returns every chunk whose counter is non-zero, which
 * is how a renderer that attached late catches up; a caller that wants the
 * whole map regardless calls `invalidateAll()` first.
 */
export class ChunkVersionReader {
  readonly #versions: Int32Array
  readonly #seen: Int32Array

  constructor(buffer: ArrayBufferLike, size: number) {
    if (buffer.byteLength !== chunkVersionBytes(size)) {
      throw new RangeError(
        `chunk version buffer must be ${chunkVersionBytes(size)} bytes for a ${size}x${size} ` +
          `map, received ${buffer.byteLength}`,
      )
    }
    this.#versions = new Int32Array(buffer)
    this.#seen = new Int32Array(this.#versions.length)
  }

  get chunkCount(): number {
    return this.#versions.length
  }

  /**
   * Chunks whose version moved since the last call.
   *
   * Reading a counter that the writer bumps concurrently is safe: whichever of
   * the two values this read returns, the reader either redraws now with data
   * that is at worst one write stale, or notices the difference on the next
   * call. It cannot lose the change, which is the whole point.
   */
  consume(): readonly number[] {
    const changed: number[] = []
    for (let chunkId = 0; chunkId < this.#versions.length; chunkId += 1) {
      const version = Atomics.load(this.#versions, chunkId)
      if (version === this.#seen[chunkId]) continue
      this.#seen[chunkId] = version
      changed.push(chunkId)
    }
    return changed
  }

  /** Forces the next `consume()` to report every chunk. */
  invalidateAll(): void {
    this.#seen.fill(-1)
  }
}
