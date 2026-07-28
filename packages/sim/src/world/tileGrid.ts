/**
 * The tile grid: the world's data substrate (PRD 4.3).
 *
 * Structure of arrays, not array of structures. One parallel typed array per
 * per-tile property, each `size * size` long, so a 300x300 map costs 17 bytes
 * a tile and 1.5MB in total, contiguously, with no per-tile object header and
 * no garbage collector involvement. Object-per-tile allocation is the
 * reference game's primary source of memory pressure and the PRD calls typed
 * arrays non-optional.
 *
 * The arrays are public because the systems that matter read them in bulk: the
 * pathfinder walks `passability` a million times a step and cannot afford an
 * accessor call. Writes are different. Every write has to tell the renderer
 * and the pathfinder what changed, so writes go through `set` / `setAt`, which
 * mark the containing 16x16 chunk dirty. Code that writes an array directly
 * for speed must call `markDirty`, `markDirtyRect` or `markAllDirty` itself,
 * or the change will not be drawn and paths will be computed against a stale
 * world.
 *
 * `hashInto` makes a grid usable as the simulation's `World` (see
 * `core/simulation.ts`): every byte of tile state reaches the determinism
 * fingerprint. The dirty set deliberately does not, because it is a
 * subscription, not state; `fromBuffers` marks everything dirty so a loaded
 * save rebuilds every derived structure rather than trusting a set that was
 * never saved.
 */

import type { Fnv1aHasher } from '../core/hash'

import type { ChunkBounds, TileCoord } from './coords'
import {
  CHUNK_SIZE,
  assertChunkId,
  assertGridSize,
  assertInBounds,
  assertIndexInRange,
  boundsChecksEnabled,
  chunkBounds,
  chunkCount,
  chunksPerAxis,
  idx,
  inBounds,
  tileCount,
  xy,
} from './coords'

/**
 * `passability` bit flags (PRD 4.3, 4.5).
 *
 * `WALKABLE` says an agent may enter at all; the rest qualify how. Access
 * filtering during flow-field generation is a mask test against these plus the
 * agent's sector permissions, so the flags must stay independent of each
 * other: a door is walkable and a door, a secure door is all three.
 */
export const PASSABILITY = {
  /** Agents may enter the tile. */
  WALKABLE: 0b0001,
  /** A door: an edge in the region graph and a queue point for movement. */
  DOOR: 0b0010,
  /** Staff only. Inmates are refused regardless of sector permissions. */
  STAFF_ONLY: 0b0100,
  /** Inside a secure boundary. Crossing needs a permission check. */
  SECURE: 0b1000,
} as const

export type PassabilityFlag = (typeof PASSABILITY)[keyof typeof PASSABILITY]

/** The parallel arrays of PRD 4.3, one entry per tile, in row-major order. */
export interface TileArrays {
  /** Index into the material table (`materials.ts`). 0 is bare ground. */
  readonly floorMaterial: Uint8Array
  /** Index into the material table. 0 is no wall. */
  readonly wallMaterial: Uint8Array
  /** 0 is unassigned. */
  readonly roomId: Uint16Array
  readonly sectorId: Uint16Array
  /** 0 is none. Set on the anchor tile of a multi-tile object. */
  readonly objectId: Uint16Array
  /** Bitmask of `PASSABILITY`. */
  readonly passability: Uint8Array
  /** 0..255. */
  readonly dirt: Uint8Array
  /** Degrees C. */
  readonly temperature: Int8Array
  readonly powerGridId: Uint16Array
  readonly waterGridId: Uint16Array
  /** Boolean, derived from foundation coverage. */
  readonly outdoors: Uint8Array
  /** Boolean. Only owned parcels are buildable (PRD 4.3). */
  readonly owned: Uint8Array
}

export type TileField = keyof TileArrays

export type TileArrayView = Uint8Array | Uint16Array | Int8Array

type TileArrayConstructor = Uint8ArrayConstructor | Uint16ArrayConstructor | Int8ArrayConstructor

/**
 * The element type of every field. Typing it as a full `Record` is what makes
 * the compiler reject a field added to `TileArrays` and forgotten here.
 */
const TILE_FIELD_TYPES: Readonly<Record<TileField, TileArrayConstructor>> = {
  floorMaterial: Uint8Array,
  wallMaterial: Uint8Array,
  roomId: Uint16Array,
  sectorId: Uint16Array,
  objectId: Uint16Array,
  passability: Uint8Array,
  dirt: Uint8Array,
  temperature: Int8Array,
  powerGridId: Uint16Array,
  waterGridId: Uint16Array,
  outdoors: Uint8Array,
  owned: Uint8Array,
}

/**
 * Field names in a fixed order, which is the declaration order above: object
 * key order is specified for string keys, and `hashInto` and the save format
 * both depend on it staying put.
 */
export const TILE_FIELDS = Object.keys(TILE_FIELD_TYPES) as readonly TileField[]

/**
 * Bytes per element of each field. The save format needs it to normalise byte
 * order without first having a grid to read `BYTES_PER_ELEMENT` from.
 */
export const TILE_FIELD_BYTES: Readonly<Record<TileField, number>> = Object.fromEntries(
  TILE_FIELDS.map((field) => [field, TILE_FIELD_TYPES[field].BYTES_PER_ELEMENT]),
) as Record<TileField, number>

/** 17 bytes: the per-tile cost of the whole grid. */
export const BYTES_PER_TILE = TILE_FIELDS.reduce(
  (total, field) => total + TILE_FIELD_TYPES[field].BYTES_PER_ELEMENT,
  0,
)

/** One raw buffer per field, for save/load (PRD 7.4) and worker transfer (PRD 4.6). */
export type TileGridBuffers = {
  readonly [K in TileField]: ArrayBufferLike
}

function assertBufferLength(buffer: ArrayBufferLike, field: TileField, size: number): void {
  const expected = tileCount(size) * TILE_FIELD_TYPES[field].BYTES_PER_ELEMENT
  if (buffer.byteLength !== expected) {
    throw new RangeError(
      `buffer for '${field}' must be ${expected} bytes for a ${size}x${size} grid, ` +
        `received ${buffer.byteLength}`,
    )
  }
}

function u8(buffers: TileGridBuffers, field: TileField, size: number): Uint8Array {
  assertBufferLength(buffers[field], field, size)
  return new Uint8Array(buffers[field])
}

function u16(buffers: TileGridBuffers, field: TileField, size: number): Uint16Array {
  assertBufferLength(buffers[field], field, size)
  return new Uint16Array(buffers[field])
}

function i8(buffers: TileGridBuffers, field: TileField, size: number): Int8Array {
  assertBufferLength(buffers[field], field, size)
  return new Int8Array(buffers[field])
}

/**
 * Dev-only. Typed arrays truncate silently, so writing 300 to a `Uint8` field
 * or 1.5 to any field is a bug that would otherwise surface hours later as a
 * wrong material or a stuck agent.
 */
function assertWritableValue(field: TileField, value: number): void {
  if (!boundsChecksEnabled()) return

  const constructor = TILE_FIELD_TYPES[field]
  const bits = constructor.BYTES_PER_ELEMENT * 8
  const signed = constructor === Int8Array
  const min = signed ? -(2 ** (bits - 1)) : 0
  const max = signed ? 2 ** (bits - 1) - 1 : 2 ** bits - 1

  if (!Number.isInteger(value) || value < min || value > max) {
    throw new RangeError(
      `tile field '${field}' takes integers in ${min}..${max}, received ${value}`,
    )
  }
}

export class TileGrid {
  /** Width and height in tiles. */
  readonly size: number

  readonly floorMaterial: Uint8Array
  readonly wallMaterial: Uint8Array
  readonly roomId: Uint16Array
  readonly sectorId: Uint16Array
  readonly objectId: Uint16Array
  readonly passability: Uint8Array
  readonly dirt: Uint8Array
  readonly temperature: Int8Array
  readonly powerGridId: Uint16Array
  readonly waterGridId: Uint16Array
  readonly outdoors: Uint8Array
  readonly owned: Uint8Array

  readonly #arrays: TileArrays
  readonly #chunksPerAxis: number
  /** One byte per chunk. Flag plus list gives O(1) marking with no rehashing. */
  readonly #dirtyFlags: Uint8Array
  #dirtyChunks: number[] = []

  private constructor(size: number, arrays: TileArrays) {
    this.size = size
    this.floorMaterial = arrays.floorMaterial
    this.wallMaterial = arrays.wallMaterial
    this.roomId = arrays.roomId
    this.sectorId = arrays.sectorId
    this.objectId = arrays.objectId
    this.passability = arrays.passability
    this.dirt = arrays.dirt
    this.temperature = arrays.temperature
    this.powerGridId = arrays.powerGridId
    this.waterGridId = arrays.waterGridId
    this.outdoors = arrays.outdoors
    this.owned = arrays.owned

    this.#arrays = arrays
    this.#chunksPerAxis = chunksPerAxis(size)
    this.#dirtyFlags = new Uint8Array(chunkCount(size))
  }

  /**
   * A `size` x `size` grid of zeroed arrays: bare ground, no walls, no rooms,
   * impassable everywhere, unowned. Starts with no dirty chunks; a renderer
   * drawing it for the first time calls `markAllDirty`.
   */
  static allocate(size: number): TileGrid {
    assertGridSize(size)
    const tiles = tileCount(size)

    return new TileGrid(size, {
      floorMaterial: new Uint8Array(tiles),
      wallMaterial: new Uint8Array(tiles),
      roomId: new Uint16Array(tiles),
      sectorId: new Uint16Array(tiles),
      objectId: new Uint16Array(tiles),
      passability: new Uint8Array(tiles),
      dirt: new Uint8Array(tiles),
      temperature: new Int8Array(tiles),
      powerGridId: new Uint16Array(tiles),
      waterGridId: new Uint16Array(tiles),
      outdoors: new Uint8Array(tiles),
      owned: new Uint8Array(tiles),
    })
  }

  /**
   * Wraps existing buffers, one per field, without copying. This is the load
   * path for a save (PRD 7.4) and the handover path for a `SharedArrayBuffer`
   * (PRD 4.6), so each buffer must be exactly the field's byte length and is
   * viewed whole, from offset 0.
   *
   * The grid starts fully dirty: its contents are new to every consumer.
   */
  static fromBuffers(size: number, buffers: TileGridBuffers): TileGrid {
    assertGridSize(size)

    const grid = new TileGrid(size, {
      floorMaterial: u8(buffers, 'floorMaterial', size),
      wallMaterial: u8(buffers, 'wallMaterial', size),
      roomId: u16(buffers, 'roomId', size),
      sectorId: u16(buffers, 'sectorId', size),
      objectId: u16(buffers, 'objectId', size),
      passability: u8(buffers, 'passability', size),
      dirt: u8(buffers, 'dirt', size),
      temperature: i8(buffers, 'temperature', size),
      powerGridId: u16(buffers, 'powerGridId', size),
      waterGridId: u16(buffers, 'waterGridId', size),
      outdoors: u8(buffers, 'outdoors', size),
      owned: u8(buffers, 'owned', size),
    })

    grid.markAllDirty()
    return grid
  }

  get tileCount(): number {
    return tileCount(this.size)
  }

  /** Total bytes of tile data, excluding the dirty tracker. */
  get byteLength(): number {
    return this.tileCount * BYTES_PER_TILE
  }

  get chunksPerAxis(): number {
    return this.#chunksPerAxis
  }

  get chunkCount(): number {
    return this.#dirtyFlags.length
  }

  idx(x: number, y: number): number {
    return idx(x, y, this.size)
  }

  xy(index: number): TileCoord {
    return xy(index, this.size)
  }

  inBounds(x: number, y: number): boolean {
    return inBounds(x, y, this.size)
  }

  /**
   * The whole array for a field. Reads are free; a write through this
   * reference must be followed by the matching `markDirty` call.
   */
  array(field: TileField): TileArrayView {
    return this.#arrays[field]
  }

  get(field: TileField, x: number, y: number): number {
    return this.getAt(field, idx(x, y, this.size))
  }

  getAt(field: TileField, index: number): number {
    assertIndexInRange(index, this.size)
    // In range by construction, and dev builds have just asserted it. The
    // `?? 0` only exists because noUncheckedIndexedAccess cannot know that.
    return this.#arrays[field][index] ?? 0
  }

  /** Writes one tile and marks its chunk dirty. */
  set(field: TileField, x: number, y: number, value: number): void {
    this.setAt(field, idx(x, y, this.size), value)
  }

  setAt(field: TileField, index: number, value: number): void {
    assertIndexInRange(index, this.size)
    assertWritableValue(field, value)
    this.#arrays[field][index] = value
    this.markDirtyAt(index)
  }

  /** Sets every tile of a field and marks the whole grid dirty. */
  fill(field: TileField, value: number): void {
    assertWritableValue(field, value)
    this.#arrays[field].fill(value)
    this.markAllDirty()
  }

  /** The raw buffers, for serialisation and worker transfer. Not copies. */
  buffers(): TileGridBuffers {
    return {
      floorMaterial: this.floorMaterial.buffer,
      wallMaterial: this.wallMaterial.buffer,
      roomId: this.roomId.buffer,
      sectorId: this.sectorId.buffer,
      objectId: this.objectId.buffer,
      passability: this.passability.buffer,
      dirt: this.dirt.buffer,
      temperature: this.temperature.buffer,
      powerGridId: this.powerGridId.buffer,
      waterGridId: this.waterGridId.buffer,
      outdoors: this.outdoors.buffer,
      owned: this.owned.buffer,
    }
  }

  chunkIdAt(x: number, y: number): number {
    assertInBounds(x, y, this.size)
    return Math.floor(y / CHUNK_SIZE) * this.#chunksPerAxis + Math.floor(x / CHUNK_SIZE)
  }

  /** The tile rectangle a chunk covers, clipped at the far edge of the grid. */
  chunkBounds(chunkId: number): ChunkBounds {
    return chunkBounds(chunkId, this.size)
  }

  markDirty(x: number, y: number): void {
    this.#markChunk(this.chunkIdAt(x, y))
  }

  markDirtyAt(index: number): void {
    assertIndexInRange(index, this.size)
    const y = Math.floor(index / this.size)
    const x = index - y * this.size
    this.#markChunk(Math.floor(y / CHUNK_SIZE) * this.#chunksPerAxis + Math.floor(x / CHUNK_SIZE))
  }

  /**
   * Marks every chunk touching a tile rectangle. The rectangle is clipped to
   * the grid, so a build tool may pass a region that runs off the edge.
   */
  markDirtyRect(x: number, y: number, width: number, height: number): void {
    if (width <= 0 || height <= 0) return

    const left = Math.max(0, x)
    const top = Math.max(0, y)
    const right = Math.min(this.size - 1, x + width - 1)
    const bottom = Math.min(this.size - 1, y + height - 1)
    if (right < left || bottom < top) return

    const firstColumn = Math.floor(left / CHUNK_SIZE)
    const lastColumn = Math.floor(right / CHUNK_SIZE)
    const firstRow = Math.floor(top / CHUNK_SIZE)
    const lastRow = Math.floor(bottom / CHUNK_SIZE)

    for (let row = firstRow; row <= lastRow; row += 1) {
      for (let column = firstColumn; column <= lastColumn; column += 1) {
        this.#markChunk(row * this.#chunksPerAxis + column)
      }
    }
  }

  markAllDirty(): void {
    for (let chunkId = 0; chunkId < this.#dirtyFlags.length; chunkId += 1) {
      this.#markChunk(chunkId)
    }
  }

  isChunkDirty(chunkId: number): boolean {
    assertChunkId(chunkId, this.size)
    return this.#dirtyFlags[chunkId] === 1
  }

  get dirtyChunkCount(): number {
    return this.#dirtyChunks.length
  }

  /**
   * The chunks written since the last call, in ascending id order, clearing
   * the set. Ascending rather than write order so that two runs which touch
   * the same chunks in a different order still hand the renderer and the
   * pathfinder identical work.
   */
  consumeDirtyChunks(): readonly number[] {
    const consumed = this.#dirtyChunks
    this.#dirtyChunks = []
    for (const chunkId of consumed) {
      this.#dirtyFlags[chunkId] = 0
    }
    consumed.sort((a, b) => a - b)
    return consumed
  }

  /**
   * Feeds every byte of tile state into the determinism fingerprint, which is
   * what lets a `TileGrid` stand in as the simulation's `World`.
   */
  hashInto(hasher: Fnv1aHasher): void {
    hasher.writeUint32(this.size)

    for (const field of TILE_FIELDS) {
      const view = this.#arrays[field]
      const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength)
      for (let i = 0; i < bytes.length; i += 1) {
        hasher.writeByte(bytes[i] ?? 0)
      }
    }
  }

  #markChunk(chunkId: number): void {
    if (this.#dirtyFlags[chunkId] === 1) return
    this.#dirtyFlags[chunkId] = 1
    this.#dirtyChunks.push(chunkId)
  }
}
