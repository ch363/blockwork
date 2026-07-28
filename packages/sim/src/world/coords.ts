/**
 * Tile coordinate arithmetic for the world grid (PRD 4.3).
 *
 * The grid is square and row-major: `index = y * size + x`. Everything here is
 * a pure function of a coordinate and the grid size, so the pathfinder and the
 * renderer can do index maths without holding a `TileGrid`.
 *
 * Two grids of coordinates exist and must not be confused:
 *
 *   - **tiles**, the simulation's unit for everything in `TileGrid`
 *   - **chunks**, `CHUNK_SIZE` x `CHUNK_SIZE` blocks of tiles, which is the
 *     granularity at which the grid reports what changed
 *
 * Bounds checks are a development aid. `idx` runs millions of times per
 * simulation step once pathfinding lands (PRD 4.5, 7.5), so the checks are one
 * boolean branch and a release build switches them off at boot with
 * `setBoundsChecks(false)`. They are on by default: a build that forgets to
 * turn them off is slow, a build that forgets to turn them on is silently
 * wrong.
 */

/**
 * The dirty-region granularity: one chunk is 16x16 tiles.
 *
 * Deliberately finer than the renderer's 32x32 terrain chunks (PRD 7.6) so a
 * one-tile edit repaints a quarter of the area. A consumer that batches at a
 * coarser granularity maps four dirty chunks onto one of its own.
 */
export const CHUNK_SIZE = 16

/**
 * An allocation guard, not a balance number. The largest map in PRD 4.3 is
 * Huge at 300x300 and the map size presets are content that belongs in
 * `packages/data` (T1.1); this only stops a corrupt save or a typo from asking
 * for a terabyte of typed arrays.
 */
export const MAX_GRID_SIZE = 1024

export interface TileCoord {
  readonly x: number
  readonly y: number
}

/**
 * A chunk's tile rectangle. Chunks against the far edge of a grid whose size
 * is not a multiple of `CHUNK_SIZE` are clipped, so a 300x300 grid's last
 * column of chunks is 12 tiles wide, not 16.
 */
export interface ChunkBounds {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

let boundsChecks = true

/** Release builds call this once at boot with `false`. */
export function setBoundsChecks(enabled: boolean): void {
  boundsChecks = enabled
}

export function boundsChecksEnabled(): boolean {
  return boundsChecks
}

/** Always checked: allocation is not a hot path and a bad size is unrecoverable. */
export function assertGridSize(size: number): void {
  if (!Number.isInteger(size) || size < 1 || size > MAX_GRID_SIZE) {
    throw new RangeError(`grid size must be an integer in 1..${MAX_GRID_SIZE}, received ${size}`)
  }
}

/** Tiles in a `size` x `size` grid. */
export function tileCount(size: number): number {
  return size * size
}

export function inBounds(x: number, y: number, size: number): boolean {
  return Number.isInteger(x) && Number.isInteger(y) && x >= 0 && y >= 0 && x < size && y < size
}

export function indexInRange(index: number, size: number): boolean {
  return Number.isInteger(index) && index >= 0 && index < tileCount(size)
}

/** Dev-only. Does nothing once `setBoundsChecks(false)` has run. */
export function assertInBounds(x: number, y: number, size: number): void {
  if (!boundsChecks) return
  if (!inBounds(x, y, size)) {
    throw new RangeError(`tile (${x}, ${y}) is outside a ${size}x${size} grid`)
  }
}

/** Dev-only. Does nothing once `setBoundsChecks(false)` has run. */
export function assertIndexInRange(index: number, size: number): void {
  if (!boundsChecks) return
  if (!indexInRange(index, size)) {
    throw new RangeError(`tile index ${index} is outside a ${size}x${size} grid`)
  }
}

/** Row-major tile index. */
export function idx(x: number, y: number, size: number): number {
  assertInBounds(x, y, size)
  return y * size + x
}

/**
 * The tile coordinate at `index`. Allocates; in a hot loop prefer `tileX` and
 * `tileY`, or track x and y directly.
 */
export function xy(index: number, size: number): TileCoord {
  assertIndexInRange(index, size)
  return { x: index % size, y: Math.floor(index / size) }
}

export function tileX(index: number, size: number): number {
  assertIndexInRange(index, size)
  return index % size
}

export function tileY(index: number, size: number): number {
  assertIndexInRange(index, size)
  return Math.floor(index / size)
}

/** Chunks along one axis, rounded up: a 300 tile axis is 19 chunks. */
export function chunksPerAxis(size: number): number {
  return Math.ceil(size / CHUNK_SIZE)
}

export function chunkCount(size: number): number {
  const perAxis = chunksPerAxis(size)
  return perAxis * perAxis
}

/** Chunk ids are row-major over the chunk grid, exactly as tile indices are. */
export function chunkIdAt(x: number, y: number, size: number): number {
  assertInBounds(x, y, size)
  return Math.floor(y / CHUNK_SIZE) * chunksPerAxis(size) + Math.floor(x / CHUNK_SIZE)
}

export function chunkIdOfIndex(index: number, size: number): number {
  assertIndexInRange(index, size)
  const y = Math.floor(index / size)
  return Math.floor(y / CHUNK_SIZE) * chunksPerAxis(size) + Math.floor((index % size) / CHUNK_SIZE)
}

/** Always checked: a bad chunk id means a consumer is iterating the wrong grid. */
export function assertChunkId(chunkId: number, size: number): void {
  if (!Number.isInteger(chunkId) || chunkId < 0 || chunkId >= chunkCount(size)) {
    throw new RangeError(`chunk id ${chunkId} is outside a ${size}x${size} grid`)
  }
}

/** The tile rectangle a chunk covers, clipped to the grid. */
export function chunkBounds(chunkId: number, size: number): ChunkBounds {
  assertChunkId(chunkId, size)
  const perAxis = chunksPerAxis(size)
  const x = (chunkId % perAxis) * CHUNK_SIZE
  const y = Math.floor(chunkId / perAxis) * CHUNK_SIZE
  return {
    x,
    y,
    width: Math.min(CHUNK_SIZE, size - x),
    height: Math.min(CHUNK_SIZE, size - y),
  }
}
