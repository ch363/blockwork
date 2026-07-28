import { describe, expect, it } from 'vitest'

import { FNV_OFFSET_BASIS_32, Fnv1aHasher, fnv1a32 } from '../../src/core/hash'

function hashJson(value: Parameters<Fnv1aHasher['writeJson']>[0]): number {
  return new Fnv1aHasher().writeJson(value).digest()
}

describe('fnv1a32', () => {
  it('returns the offset basis for the empty string', () => {
    expect(fnv1a32('')).toBe(FNV_OFFSET_BASIS_32)
  })

  it('is stable and unsigned', () => {
    const hash = fnv1a32('inmate.starved')

    expect(hash).toBe(fnv1a32('inmate.starved'))
    expect(hash).toBeGreaterThanOrEqual(0)
    expect(hash).toBeLessThan(0x1_0000_0000)
  })

  it('separates similar strings', () => {
    expect(fnv1a32('intake')).not.toBe(fnv1a32('intakf'))
    expect(fnv1a32('a', 1)).not.toBe(fnv1a32('a', 2))
  })
})

describe('Fnv1aHasher', () => {
  it('sorts object keys, so insertion order cannot change the hash', () => {
    expect(hashJson({ a: 1, b: 2, c: 3 })).toBe(hashJson({ c: 3, b: 2, a: 1 }))
  })

  it('does not sort array elements', () => {
    expect(hashJson([1, 2, 3])).not.toBe(hashJson([3, 2, 1]))
  })

  it('keeps structurally different values apart', () => {
    const hashes = [
      hashJson(1),
      hashJson('1'),
      hashJson([1]),
      hashJson({ '1': 1 }),
      hashJson(true),
      hashJson(null),
    ]

    expect(new Set(hashes).size).toBe(hashes.length)
  })

  it('treats -0 and 0 as the same state', () => {
    expect(hashJson(-0)).toBe(hashJson(0))
  })

  it('distinguishes writes of the same bits under different widths', () => {
    expect(new Fnv1aHasher().writeUint32(1).digest()).not.toBe(
      new Fnv1aHasher().writeByte(1).digest(),
    )
  })

  it('is order dependent', () => {
    expect(new Fnv1aHasher().writeUint32(1).writeUint32(2).digest()).not.toBe(
      new Fnv1aHasher().writeUint32(2).writeUint32(1).digest(),
    )
  })
})
