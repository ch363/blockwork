/**
 * Atlas generation determinism tests for T8.22.
 *
 * All procedural atlases must be deterministic: given the same inputs, they
 * produce pixel-identical output. This is essential for visual debugging
 * (screenshots compare), test stability, and future snapshot testing.
 *
 * Note: Canvas 2D operations are not available in happy-dom, so tests that
 * require actual canvas rendering are skipped or adapted.
 */

import { describe, expect, it, vi } from 'vitest'

import {
  spriteHash,
  spriteNoise,
} from '../../src/sprites/atlas'

describe('spriteHash determinism', () => {
  it('returns the same hash for the same id', () => {
    const a = spriteHash('test-sprite')
    const b = spriteHash('test-sprite')
    expect(a).toBe(b)
  })

  it('returns different hashes for different ids', () => {
    const a = spriteHash('sprite-a')
    const b = spriteHash('sprite-b')
    expect(a).not.toBe(b)
  })

  it('returns an unsigned 32-bit integer', () => {
    const ids = ['a', 'b', 'test', 'long-sprite-name-here', '123', '!@#$%']
    for (const id of ids) {
      const hash = spriteHash(id)
      expect(Number.isInteger(hash)).toBe(true)
      expect(hash).toBeGreaterThanOrEqual(0)
      expect(hash).toBeLessThanOrEqual(0xffffffff)
    }
  })

  it('distributes across the full 32-bit range', () => {
    const samples = 100
    const hashes = new Set<number>()

    for (let i = 0; i < samples; i++) {
      hashes.add(spriteHash(`sprite-${i}`))
    }

    // All hashes should be unique for unique inputs
    expect(hashes.size).toBe(samples)

    // Hashes should span a wide range, not cluster
    const sorted = [...hashes].sort((a, b) => a - b)
    const min = sorted[0] ?? 0
    const max = sorted[sorted.length - 1] ?? 0
    const range = max - min

    // With good distribution, the range should be substantial
    expect(range).toBeGreaterThan(0xffffffff * 0.5)
  })
})

describe('spriteNoise determinism', () => {
  it('returns the same value for the same coordinates', () => {
    const a = spriteNoise(10, 20)
    const b = spriteNoise(10, 20)
    expect(a).toBe(b)
  })

  it('returns different values for different coordinates', () => {
    const a = spriteNoise(10, 20)
    const b = spriteNoise(11, 20)
    const c = spriteNoise(10, 21)
    expect(a).not.toBe(b)
    expect(a).not.toBe(c)
  })

  it('returns a value in [0, 1)', () => {
    const samples = [
      [0, 0],
      [1, 1],
      [100, 200],
      [-5, 10],
      [12345, 67890],
    ] as const

    for (const [x, y] of samples) {
      const noise = spriteNoise(x, y)
      expect(noise).toBeGreaterThanOrEqual(0)
      expect(noise).toBeLessThan(1)
    }
  })

  it('distributes uniformly across the range', () => {
    const samples = 1000
    const buckets = 10
    const counts = Array(buckets).fill(0) as number[]

    for (let i = 0; i < samples; i++) {
      const noise = spriteNoise(i, i * 2 + 7)
      const bucket = Math.min(Math.floor(noise * buckets), buckets - 1)
      const current = counts[bucket]
      if (current === undefined) continue
      counts[bucket] = current + 1
    }

    const expected = samples / buckets
    const tolerance = expected * 0.5

    for (let bucket = 0; bucket < buckets; bucket++) {
      const count = counts[bucket] ?? 0
      expect(count).toBeGreaterThan(expected - tolerance)
      expect(count).toBeLessThan(expected + tolerance)
    }
  })
})

describe('procedural atlas determinism', () => {
  it('hash-based colour derivation is repeatable', () => {
    const id = 'test-object'

    function deriveHue(objectId: string): number {
      const hash = spriteHash(objectId)
      return (hash / 0xffffffff) * 360
    }

    const hue1 = deriveHue(id)
    const hue2 = deriveHue(id)
    expect(hue1).toBe(hue2)
  })

  it('noise-based grain is repeatable', () => {
    function grainPattern(seed: number): number[] {
      const results: number[] = []
      for (let i = 0; i < 10; i++) {
        results.push(spriteNoise(seed + i, seed * 2 + i))
      }
      return results
    }

    const a = grainPattern(42)
    const b = grainPattern(42)
    expect(a).toEqual(b)

    const c = grainPattern(123)
    expect(a).not.toEqual(c)
  })

  it('random operations without Math.random are deterministic', () => {
    function deterministicPattern(seed: number): number[] {
      const results: number[] = []
      let state = seed
      for (let i = 0; i < 10; i++) {
        state = (state * 1103515245 + 12345) & 0x7fffffff
        results.push(state / 0x7fffffff)
      }
      return results
    }

    const a = deterministicPattern(42)
    const b = deterministicPattern(42)
    expect(a).toEqual(b)

    const c = deterministicPattern(123)
    expect(a).not.toEqual(c)
  })
})

describe('atlas module isolation', () => {
  it('does not call Math.random for hashing', () => {
    const randomSpy = vi.spyOn(Math, 'random')

    spriteHash('test')
    spriteNoise(10, 20)

    expect(randomSpy).not.toHaveBeenCalled()
    randomSpy.mockRestore()
  })
})
