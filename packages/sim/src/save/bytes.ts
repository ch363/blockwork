/**
 * Byte-level codecs for the save format: base64, UTF-8, little-endian
 * normalisation and the payload checksum.
 *
 * All of it is hand-rolled because `packages/sim` has no DOM dependency
 * (CLAUDE.md rule 2), which rules out `btoa`, `atob`, `TextEncoder` and
 * `TextDecoder` — the same reason `core/snapshot.ts` keeps text out of the
 * worker boundary entirely. What is left is a few hundred lines of table
 * lookups, which is a fair price for a save format that behaves identically in
 * a browser, a worker, Node and the replay harness.
 *
 * Decoders here are strict. A save file is the one input to the simulation
 * that a player can hand us from outside, so "nearly valid base64" and
 * "truncated UTF-8" are corruption to be reported, not something to patch up
 * silently and load anyway.
 */

import { FNV_OFFSET_BASIS_32, FNV_PRIME_32 } from '../core/hash'

import { SaveError } from './format'

const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
const BASE64_PAD = '='

/** 256 entries so any char code indexes it directly. -1 is "not base64". */
const BASE64_REVERSE = ((): Int8Array => {
  const table = new Int8Array(128).fill(-1)
  for (let i = 0; i < BASE64_ALPHABET.length; i += 1) {
    table[BASE64_ALPHABET.charCodeAt(i)] = i
  }
  return table
})()

/**
 * Joining in blocks keeps peak string memory near the output size instead of
 * near twice it, which matters: the grid of a 300x300 map is 2.4MB of base64.
 */
const JOIN_BLOCK = 8192

/** Standard base64 with padding. */
export function bytesToBase64(bytes: Uint8Array): string {
  const groups: string[] = []
  const blocks: string[] = []

  let i = 0
  for (; i + 2 < bytes.length; i += 3) {
    // Indices are inside the loop bound; `?? 0` only satisfies
    // noUncheckedIndexedAccess, which cannot see that.
    const word = ((bytes[i] ?? 0) << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0)
    groups.push(
      BASE64_ALPHABET.charAt((word >>> 18) & 0x3f) +
        BASE64_ALPHABET.charAt((word >>> 12) & 0x3f) +
        BASE64_ALPHABET.charAt((word >>> 6) & 0x3f) +
        BASE64_ALPHABET.charAt(word & 0x3f),
    )

    if (groups.length === JOIN_BLOCK) {
      blocks.push(groups.join(''))
      groups.length = 0
    }
  }

  const remaining = bytes.length - i
  if (remaining === 1) {
    const word = (bytes[i] ?? 0) << 16
    groups.push(
      BASE64_ALPHABET.charAt((word >>> 18) & 0x3f) +
        BASE64_ALPHABET.charAt((word >>> 12) & 0x3f) +
        BASE64_PAD +
        BASE64_PAD,
    )
  } else if (remaining === 2) {
    const word = ((bytes[i] ?? 0) << 16) | ((bytes[i + 1] ?? 0) << 8)
    groups.push(
      BASE64_ALPHABET.charAt((word >>> 18) & 0x3f) +
        BASE64_ALPHABET.charAt((word >>> 12) & 0x3f) +
        BASE64_ALPHABET.charAt((word >>> 6) & 0x3f) +
        BASE64_PAD,
    )
  }

  blocks.push(groups.join(''))
  return blocks.join('')
}

function base64Sextet(text: string, index: number, label: string): number {
  const code = text.charCodeAt(index)
  const value = code < 128 ? (BASE64_REVERSE[code] ?? -1) : -1
  if (value < 0) {
    throw new SaveError(
      'corrupt-payload',
      `${label} is not valid base64: unexpected character at index ${index}`,
    )
  }
  return value
}

/**
 * Strict base64: no whitespace, no URL-safe alphabet, correct padding.
 * `label` names the field so a bad grid array says which one.
 */
export function base64ToBytes(text: string, label = 'value'): Uint8Array {
  if (text.length % 4 !== 0) {
    throw new SaveError(
      'corrupt-payload',
      `${label} is not valid base64: length ${text.length} is not a multiple of 4`,
    )
  }
  if (text.length === 0) return new Uint8Array(0)

  let padding = 0
  if (text.endsWith(`${BASE64_PAD}${BASE64_PAD}`)) padding = 2
  else if (text.endsWith(BASE64_PAD)) padding = 1

  const groups = text.length / 4
  const bytes = new Uint8Array(groups * 3 - padding)

  let out = 0
  for (let group = 0; group < groups; group += 1) {
    const at = group * 4
    const last = group === groups - 1
    const a = base64Sextet(text, at, label)
    const b = base64Sextet(text, at + 1, label)
    const c = last && padding === 2 ? 0 : base64Sextet(text, at + 2, label)
    const d = last && padding > 0 ? 0 : base64Sextet(text, at + 3, label)

    const word = (a << 18) | (b << 12) | (c << 6) | d
    bytes[out] = (word >>> 16) & 0xff
    if (out + 1 < bytes.length) bytes[out + 1] = (word >>> 8) & 0xff
    if (out + 2 < bytes.length) bytes[out + 2] = word & 0xff
    out += 3
  }

  return bytes
}

/**
 * True on every platform Blockwork targets, but the save format does not get
 * to assume that: a file written on one architecture must load on another.
 */
export const HOST_IS_LITTLE_ENDIAN = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1

/**
 * Converts between host byte order and the format's little-endian order.
 *
 * Byte swapping is its own inverse, so one function serves both directions.
 * On a little-endian host, and for single-byte elements, it is a no-op that
 * returns the input untouched.
 */
export function orientBytes(bytes: Uint8Array, bytesPerElement: number): Uint8Array {
  if (HOST_IS_LITTLE_ENDIAN || bytesPerElement === 1) return bytes

  const swapped = bytes.slice()
  for (let i = 0; i + bytesPerElement <= swapped.length; i += bytesPerElement) {
    for (let low = 0, high = bytesPerElement - 1; low < high; low += 1, high -= 1) {
      const a = swapped[i + low] ?? 0
      swapped[i + low] = swapped[i + high] ?? 0
      swapped[i + high] = a
    }
  }
  return swapped
}

const REPLACEMENT_CHARACTER = 0xfffd

/**
 * UTF-8 encoding of a JavaScript string.
 *
 * Unpaired surrogates cannot be encoded and are replaced with U+FFFD, which is
 * what `TextEncoder` does. They only reach here from a string that was already
 * broken, and a save that refuses to write is worse than one that writes a
 * question mark.
 */
export function utf8Encode(text: string): Uint8Array {
  // Worst case is 3 bytes per code unit; a surrogate pair is 2 units and
  // 4 bytes, so the bound holds for astral characters too.
  const bytes = new Uint8Array(text.length * 3)
  let out = 0

  for (let i = 0; i < text.length; i += 1) {
    let code = text.charCodeAt(i)

    if (code >= 0xd800 && code <= 0xdbff) {
      const next = i + 1 < text.length ? text.charCodeAt(i + 1) : 0
      if (next >= 0xdc00 && next <= 0xdfff) {
        code = 0x10000 + ((code - 0xd800) << 10) + (next - 0xdc00)
        i += 1
      } else {
        code = REPLACEMENT_CHARACTER
      }
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      code = REPLACEMENT_CHARACTER
    }

    if (code < 0x80) {
      bytes[out] = code
      out += 1
    } else if (code < 0x800) {
      bytes[out] = 0xc0 | (code >>> 6)
      bytes[out + 1] = 0x80 | (code & 0x3f)
      out += 2
    } else if (code < 0x10000) {
      bytes[out] = 0xe0 | (code >>> 12)
      bytes[out + 1] = 0x80 | ((code >>> 6) & 0x3f)
      bytes[out + 2] = 0x80 | (code & 0x3f)
      out += 3
    } else {
      bytes[out] = 0xf0 | (code >>> 18)
      bytes[out + 1] = 0x80 | ((code >>> 12) & 0x3f)
      bytes[out + 2] = 0x80 | ((code >>> 6) & 0x3f)
      bytes[out + 3] = 0x80 | (code & 0x3f)
      out += 4
    }
  }

  return bytes.subarray(0, out)
}

/** `String.fromCharCode` is variadic, so units are flushed in bounded batches. */
const FROM_CHAR_CODE_BATCH = 4096

function malformedUtf8(offset: number): SaveError {
  return new SaveError('malformed-json', `save payload is not valid UTF-8 at byte ${offset}`)
}

/**
 * Strict UTF-8 decoding. Overlong encodings, truncated sequences, surrogate
 * code points and values above U+10FFFF are all rejected: on this path they
 * mean the bytes are damaged, and a damaged save must say so rather than load
 * with a mangled prison name.
 */
export function utf8Decode(bytes: Uint8Array): string {
  const units: number[] = []
  const blocks: string[] = []
  let i = 0

  const push = (unit: number): void => {
    units.push(unit)
    if (units.length === FROM_CHAR_CODE_BATCH) {
      blocks.push(String.fromCharCode(...units))
      units.length = 0
    }
  }

  const continuation = (at: number): number => {
    const byte = bytes[at]
    if (byte === undefined || (byte & 0xc0) !== 0x80) throw malformedUtf8(at)
    return byte & 0x3f
  }

  while (i < bytes.length) {
    const lead = bytes[i] ?? 0

    if (lead < 0x80) {
      push(lead)
      i += 1
      continue
    }

    if (lead >= 0xc2 && lead <= 0xdf) {
      push(((lead & 0x1f) << 6) | continuation(i + 1))
      i += 2
      continue
    }

    if (lead >= 0xe0 && lead <= 0xef) {
      const code = ((lead & 0x0f) << 12) | (continuation(i + 1) << 6) | continuation(i + 2)
      if (code < 0x800 || (code >= 0xd800 && code <= 0xdfff)) throw malformedUtf8(i)
      push(code)
      i += 3
      continue
    }

    if (lead >= 0xf0 && lead <= 0xf4) {
      const code =
        ((lead & 0x07) << 18) |
        (continuation(i + 1) << 12) |
        (continuation(i + 2) << 6) |
        continuation(i + 3)
      if (code < 0x10000 || code > 0x10ffff) throw malformedUtf8(i)
      const astral = code - 0x10000
      push(0xd800 + (astral >>> 10))
      push(0xdc00 + (astral & 0x3ff))
      i += 4
      continue
    }

    throw malformedUtf8(i)
  }

  blocks.push(String.fromCharCode(...units))
  return blocks.join('')
}

/**
 * FNV-1a over raw bytes, the same function `core/hash.ts` uses over strings.
 * Not cryptographic: this catches a corrupted file, not a forged one.
 */
export function checksumBytes(bytes: Uint8Array): number {
  let hash = FNV_OFFSET_BASIS_32
  for (let i = 0; i < bytes.length; i += 1) {
    hash = Math.imul(hash ^ (bytes[i] ?? 0), FNV_PRIME_32)
  }
  return hash >>> 0
}

/** Concatenates the chunks a stream reader produced into one buffer. */
export function concatBytes(chunks: readonly Uint8Array[]): Uint8Array {
  let total = 0
  for (const chunk of chunks) total += chunk.length

  const joined = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    joined.set(chunk, offset)
    offset += chunk.length
  }
  return joined
}
