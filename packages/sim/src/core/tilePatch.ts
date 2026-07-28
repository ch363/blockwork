/**
 * Tile patches: how the world's appearance reaches the renderer when memory
 * cannot be shared (PRD 4.6).
 *
 * There are two transports and they solve this problem very differently.
 *
 * Where the host is cross-origin isolated, the `TileGrid` is allocated over
 * `SharedArrayBuffer` and the renderer reads the simulation's own bytes. There
 * is nothing to send: the snapshot carries chunk *ids*, the renderer re-meshes
 * those chunks, and the tile data was already there. That is the fast path and
 * the one the format was designed around.
 *
 * Where it is not — several iPadOS webview configurations — the renderer has
 * no way to see the grid, and chunk ids on their own are useless. So the
 * worker packs the changed chunks' drawable fields into an `ArrayBuffer` and
 * transfers it. This module is that codec.
 *
 * **Only the drawable fields travel.** Four of the twelve: the two materials,
 * the room a tile belongs to, and the object anchored on it. `passability`,
 * `temperature`, `powerGridId` and the rest are simulation state the renderer
 * has no business drawing and no business knowing; shipping all twelve would
 * nearly triple the bytes to no visible effect. A patch is a render concern,
 * and it carries exactly what a render needs.
 *
 * **The layout is alignment-first.** Each chunk writes its 16-bit fields
 * before its 8-bit ones, so every typed-array view lands on its natural
 * boundary and decoding is a `set` per field rather than a loop per tile.
 */

import { CHUNK_SIZE, assertChunkId, chunkBounds, chunkCount, tileCount } from '../world/coords'
import type { TileGrid } from '../world/tileGrid'

/** 'BKT1'. Distinguishes a patch from a snapshot on the same message port. */
export const TILE_PATCH_MAGIC = 0x424b5431

export const TILE_PATCH_VERSION = 2

/** Tiles in one chunk. Square, so this is `CHUNK_SIZE ** 2`. */
export const TILES_PER_CHUNK = CHUNK_SIZE * CHUNK_SIZE

/**
 * The fields a patch carries, in the order they are written. 16-bit first so
 * every view is naturally aligned. `sectorId` was added in version 2 for the
 * Phase 4 sectors overlay.
 */
export const TILE_PATCH_FIELDS = [
  'roomId',
  'objectId',
  'sectorId',
  'floorMaterial',
  'wallMaterial',
] as const

export type TilePatchField = (typeof TILE_PATCH_FIELDS)[number]

/** `chunkId` plus the five field runs. */
export const TILE_PATCH_CHUNK_BYTES =
  4 +
  TILES_PER_CHUNK * 2 +
  TILES_PER_CHUNK * 2 +
  TILES_PER_CHUNK * 2 +
  TILES_PER_CHUNK +
  TILES_PER_CHUNK

/** magic, version + chunkSize, gridSize, chunk count. */
export const TILE_PATCH_HEADER_BYTES = 16

export function tilePatchBytes(chunks: number): number {
  return TILE_PATCH_HEADER_BYTES + chunks * TILE_PATCH_CHUNK_BYTES
}

/** One chunk's drawable tiles, in row-major order within the chunk. */
export interface TilePatchChunk {
  readonly chunkId: number
  readonly roomId: Uint16Array
  readonly objectId: Uint16Array
  readonly sectorId: Uint16Array
  readonly floorMaterial: Uint8Array
  readonly wallMaterial: Uint8Array
}

export interface TilePatch {
  readonly gridSize: number
  readonly chunkSize: number
  readonly chunks: readonly TilePatchChunk[]
}

/**
 * Copies one chunk out of the grid, clipped to the map.
 *
 * A chunk on the right or bottom edge of a map whose size is not a multiple of
 * `CHUNK_SIZE` is partial. Rather than encode its true width — which would
 * make every chunk a different length and the format variable-width — the
 * short rows are left zeroed and the decoder clips the same way. Zero is
 * "nothing here" in all four fields, so a partial chunk decodes to exactly
 * what it means.
 */
function packChunk(grid: TileGrid, chunkId: number, view: DataView, at: number): number {
  const bounds = chunkBounds(chunkId, grid.size)
  let offset = at

  view.setUint32(offset, chunkId, true)
  offset += 4

  const roomId = new Uint16Array(view.buffer, view.byteOffset + offset, TILES_PER_CHUNK)
  offset += TILES_PER_CHUNK * 2
  const objectId = new Uint16Array(view.buffer, view.byteOffset + offset, TILES_PER_CHUNK)
  offset += TILES_PER_CHUNK * 2
  const sectorId = new Uint16Array(view.buffer, view.byteOffset + offset, TILES_PER_CHUNK)
  offset += TILES_PER_CHUNK * 2
  const floorMaterial = new Uint8Array(view.buffer, view.byteOffset + offset, TILES_PER_CHUNK)
  offset += TILES_PER_CHUNK
  const wallMaterial = new Uint8Array(view.buffer, view.byteOffset + offset, TILES_PER_CHUNK)
  offset += TILES_PER_CHUNK

  for (let y = bounds.y; y < bounds.y + bounds.height; y += 1) {
    const row = y * grid.size
    const local = (y - bounds.y) * CHUNK_SIZE
    for (let x = bounds.x; x < bounds.x + bounds.width; x += 1) {
      const from = row + x
      const to = local + (x - bounds.x)
      roomId[to] = grid.roomId[from] as number
      objectId[to] = grid.objectId[from] as number
      sectorId[to] = grid.sectorId[from] as number
      floorMaterial[to] = grid.floorMaterial[from] as number
      wallMaterial[to] = grid.wallMaterial[from] as number
    }
  }

  return offset
}

/**
 * Packs the named chunks into a transferable buffer.
 *
 * The buffer is exactly sized, so the receiver can transfer it onward or
 * adopt its views without copying.
 */
export function encodeTilePatch(grid: TileGrid, chunkIds: readonly number[]): ArrayBuffer {
  const buffer = new ArrayBuffer(tilePatchBytes(chunkIds.length))
  const view = new DataView(buffer)

  view.setUint32(0, TILE_PATCH_MAGIC, true)
  view.setUint16(4, TILE_PATCH_VERSION, true)
  view.setUint16(6, CHUNK_SIZE, true)
  view.setUint32(8, grid.size, true)
  view.setUint32(12, chunkIds.length, true)

  let offset = TILE_PATCH_HEADER_BYTES
  for (const chunkId of chunkIds) {
    assertChunkId(chunkId, grid.size)
    offset = packChunk(grid, chunkId, view, offset)
  }

  return buffer
}

/**
 * Reads a patch back, or returns null if the buffer is not one.
 *
 * Null rather than a throw: this decodes bytes that crossed a thread boundary,
 * and a renderer that drops one unreadable frame is strictly better than a
 * renderer that dies on it.
 */
export function decodeTilePatch(buffer: ArrayBuffer): TilePatch | null {
  if (buffer.byteLength < TILE_PATCH_HEADER_BYTES) return null
  const view = new DataView(buffer)

  if (view.getUint32(0, true) !== TILE_PATCH_MAGIC) return null
  if (view.getUint16(4, true) !== TILE_PATCH_VERSION) return null

  const chunkSize = view.getUint16(6, true)
  const gridSize = view.getUint32(8, true)
  const count = view.getUint32(12, true)

  if (chunkSize !== CHUNK_SIZE) return null
  if (gridSize < 1 || gridSize > 0xffff) return null
  if (buffer.byteLength !== tilePatchBytes(count)) return null

  const total = chunkCount(gridSize)
  const chunks: TilePatchChunk[] = []
  let offset = TILE_PATCH_HEADER_BYTES

  for (let i = 0; i < count; i += 1) {
    const chunkId = view.getUint32(offset, true)
    offset += 4
    if (chunkId >= total) return null

    const roomId = new Uint16Array(buffer, offset, TILES_PER_CHUNK)
    offset += TILES_PER_CHUNK * 2
    const objectId = new Uint16Array(buffer, offset, TILES_PER_CHUNK)
    offset += TILES_PER_CHUNK * 2
    const sectorId = new Uint16Array(buffer, offset, TILES_PER_CHUNK)
    offset += TILES_PER_CHUNK * 2
    const floorMaterial = new Uint8Array(buffer, offset, TILES_PER_CHUNK)
    offset += TILES_PER_CHUNK
    const wallMaterial = new Uint8Array(buffer, offset, TILES_PER_CHUNK)
    offset += TILES_PER_CHUNK

    chunks.push({ chunkId, roomId, objectId, sectorId, floorMaterial, wallMaterial })
  }

  return { gridSize, chunkSize, chunks }
}

/**
 * Writes a decoded patch into a main-thread mirror of the grid's drawable
 * fields.
 *
 * The mirror is four flat arrays the renderer already knows how to read, so
 * the two transports converge here: shared memory hands the renderer the
 * simulation's arrays, and this hands it arrays that hold the same values.
 */
export interface TileMirror {
  readonly size: number
  readonly roomId: Uint16Array
  readonly objectId: Uint16Array
  readonly sectorId: Uint16Array
  readonly floorMaterial: Uint8Array
  readonly wallMaterial: Uint8Array
}

export function createTileMirror(size: number): TileMirror {
  const tiles = tileCount(size)
  return {
    size,
    roomId: new Uint16Array(tiles),
    objectId: new Uint16Array(tiles),
    sectorId: new Uint16Array(tiles),
    floorMaterial: new Uint8Array(tiles),
    wallMaterial: new Uint8Array(tiles),
  }
}

/** Applies a patch, returning the chunk ids it touched. */
export function applyTilePatch(mirror: TileMirror, patch: TilePatch): readonly number[] {
  if (patch.gridSize !== mirror.size) return []

  const touched: number[] = []
  for (const chunk of patch.chunks) {
    const bounds = chunkBounds(chunk.chunkId, mirror.size)

    for (let y = bounds.y; y < bounds.y + bounds.height; y += 1) {
      const row = y * mirror.size
      const local = (y - bounds.y) * CHUNK_SIZE
      for (let x = bounds.x; x < bounds.x + bounds.width; x += 1) {
        const to = row + x
        const from = local + (x - bounds.x)
        mirror.roomId[to] = chunk.roomId[from] as number
        mirror.objectId[to] = chunk.objectId[from] as number
        mirror.sectorId[to] = chunk.sectorId[from] as number
        mirror.floorMaterial[to] = chunk.floorMaterial[from] as number
        mirror.wallMaterial[to] = chunk.wallMaterial[from] as number
      }
    }
    touched.push(chunk.chunkId)
  }
  return touched
}
