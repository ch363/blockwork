/**
 * FNV-1a hashing, used for two things:
 *
 *   1. `Simulation.hash()`, the determinism fingerprint of all simulation
 *      state. Two runs from the same seed and command list must agree on it at
 *      every tick.
 *   2. Deriving named RNG stream seeds from the master seed (see `rng.ts`).
 *
 * Everything here is byte-exact and platform-independent: strings hash as
 * UTF-16 code units, numbers as IEEE-754 little-endian, and object keys are
 * sorted by code unit rather than by locale.
 */

import type { JsonValue } from './commands'
import { isJsonArray } from './commands'

export const FNV_OFFSET_BASIS_32 = 0x811c9dc5
export const FNV_PRIME_32 = 0x01000193

/** FNV-1a over a string's UTF-16 code units. `basis` seeds the hash. */
export function fnv1a32(value: string, basis: number = FNV_OFFSET_BASIS_32): number {
  let hash = basis >>> 0
  for (let i = 0; i < value.length; i += 1) {
    const unit = value.charCodeAt(i)
    hash = Math.imul(hash ^ (unit & 0xff), FNV_PRIME_32)
    hash = Math.imul(hash ^ (unit >>> 8), FNV_PRIME_32)
  }
  return hash >>> 0
}

// Type tags keep structurally different values apart, so that the number 1,
// the string "1" and the array [1] cannot collide.
const TAG_NULL = 0x01
const TAG_BOOLEAN = 0x02
const TAG_NUMBER = 0x03
const TAG_STRING = 0x04
const TAG_ARRAY = 0x05
const TAG_OBJECT = 0x06

// Written then immediately read on the same call, so sharing it across hashers
// is safe and avoids an allocation per float.
const floatScratch = new DataView(new ArrayBuffer(8))

function compareStrings(a: string, b: string): number {
  if (a < b) return -1
  if (a > b) return 1
  return 0
}

/** An incremental FNV-1a 32-bit hash. */
export class Fnv1aHasher {
  #hash = FNV_OFFSET_BASIS_32

  writeByte(byte: number): this {
    this.#hash = Math.imul(this.#hash ^ (byte & 0xff), FNV_PRIME_32)
    return this
  }

  writeUint32(value: number): this {
    const word = value >>> 0
    return this.writeByte(word)
      .writeByte(word >>> 8)
      .writeByte(word >>> 16)
      .writeByte(word >>> 24)
  }

  writeInt32(value: number): this {
    return this.writeUint32((value | 0) >>> 0)
  }

  writeBoolean(value: boolean): this {
    return this.writeByte(value ? 1 : 0)
  }

  writeFloat64(value: number): this {
    // -0 and 0 are the same simulation state, so they must hash the same.
    floatScratch.setFloat64(0, Object.is(value, -0) ? 0 : value, true)
    for (let i = 0; i < 8; i += 1) {
      this.writeByte(floatScratch.getUint8(i))
    }
    return this
  }

  writeString(value: string): this {
    this.writeUint32(value.length)
    for (let i = 0; i < value.length; i += 1) {
      const unit = value.charCodeAt(i)
      this.writeByte(unit).writeByte(unit >>> 8)
    }
    return this
  }

  /** Canonical: object keys are sorted, so key insertion order cannot leak in. */
  writeJson(value: JsonValue): this {
    if (value === null) {
      return this.writeByte(TAG_NULL)
    }

    switch (typeof value) {
      case 'boolean':
        return this.writeByte(TAG_BOOLEAN).writeBoolean(value)
      case 'number':
        return this.writeByte(TAG_NUMBER).writeFloat64(value)
      case 'string':
        return this.writeByte(TAG_STRING).writeString(value)
      default:
        break
    }

    if (isJsonArray(value)) {
      this.writeByte(TAG_ARRAY).writeUint32(value.length)
      for (const item of value) {
        this.writeJson(item)
      }
      return this
    }

    const entries = Object.entries(value).sort((a, b) => compareStrings(a[0], b[0]))
    this.writeByte(TAG_OBJECT).writeUint32(entries.length)
    for (const [key, entry] of entries) {
      this.writeString(key)
      this.writeJson(entry)
    }
    return this
  }

  /** The hash so far, as an unsigned 32-bit integer. */
  digest(): number {
    return this.#hash >>> 0
  }
}
