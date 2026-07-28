import { describe, expect, it } from 'vitest'

import { Rng, RngStream, deriveStreamSeed } from '../../src/core/rng'

const SEED = 0x5eed_1234

function draw(stream: RngStream, count: number): number[] {
  return Array.from({ length: count }, () => stream.next())
}

describe('Rng (PRD 4.2)', () => {
  it('produces the same sequence for the same seed and stream name', () => {
    const a = draw(new Rng(SEED).stream('intake'), 100)
    const b = draw(new Rng(SEED).stream('intake'), 100)

    expect(a).toEqual(b)
  })

  it('produces different sequences for different seeds', () => {
    const a = draw(new Rng(SEED).stream('intake'), 20)
    const b = draw(new Rng(SEED + 1).stream('intake'), 20)

    expect(a).not.toEqual(b)
  })

  it('keeps streams isolated: draining one does not disturb another', () => {
    const expected = draw(new Rng(SEED).stream('contraband'), 100)

    const rng = new Rng(SEED)
    draw(rng.stream('intake'), 100)

    expect(draw(rng.stream('contraband'), 100)).toEqual(expected)
  })

  it('does not shift existing streams when a new named stream is added', () => {
    const before = new Rng(SEED)
    const beforeIntake = draw(before.stream('intake'), 50)
    const beforeCombat = draw(before.stream('combat'), 50)

    // A later ticket adds a system, and with it a stream, part way through.
    const after = new Rng(SEED)
    const afterIntake = draw(after.stream('intake'), 25)
    draw(after.stream('tunnels'), 500)
    afterIntake.push(...draw(after.stream('intake'), 25))
    const afterCombat = draw(after.stream('combat'), 50)

    expect(afterIntake).toEqual(beforeIntake)
    expect(afterCombat).toEqual(beforeCombat)
  })

  it('gives the same stream state regardless of creation order', () => {
    const forwards = new Rng(SEED)
    forwards.stream('a')
    forwards.stream('b')

    const backwards = new Rng(SEED)
    backwards.stream('b')
    backwards.stream('a')

    expect(forwards.serialise()).toEqual(backwards.serialise())
  })

  it('returns the same stream object for a repeated name', () => {
    const rng = new Rng(SEED)

    expect(rng.stream('intake')).toBe(rng.stream('intake'))
  })

  it('derives distinct, uncorrelated seeds for similar names', () => {
    const names = ['intake', 'intakf', 'intake ', 'Intake', 'contraband', 'combat']
    const seeds = names.map((name) => deriveStreamSeed(SEED, name))

    expect(new Set(seeds).size).toBe(names.length)

    // Adjacent names must not produce adjacent first draws.
    const firsts = names.map((name) => new Rng(SEED).stream(name).next())
    expect(Math.max(...firsts) - Math.min(...firsts)).toBeGreaterThan(0.1)
  })

  it('draws uniformly in [0, 1) over 100,000 samples', () => {
    const stream = new Rng(SEED).stream('uniformity')
    const buckets = new Array<number>(10).fill(0)
    const samples = 100_000
    let outOfRange = 0

    for (let i = 0; i < samples; i += 1) {
      const value = stream.next()
      if (value < 0 || value >= 1) outOfRange += 1
      const bucket = Math.floor(value * 10)
      buckets[bucket] = (buckets[bucket] ?? 0) + 1
    }

    expect(outOfRange).toBe(0)
    // Ten sigma either side of the expected 10,000 per bucket.
    for (const count of buckets) {
      expect(count).toBeGreaterThan(samples / 10 - samples / 100)
      expect(count).toBeLessThan(samples / 10 + samples / 100)
    }
  })

  it('draws integers within bounds', () => {
    const stream = new Rng(SEED).stream('bounds')
    const seen = new Set<number>()

    for (let i = 0; i < 1_000; i += 1) {
      const value = stream.nextInt(3, 7)
      expect(Number.isInteger(value)).toBe(true)
      expect(value).toBeGreaterThanOrEqual(3)
      expect(value).toBeLessThan(7)
      seen.add(value)
    }

    expect(seen).toEqual(new Set([3, 4, 5, 6]))
  })

  it('consumes exactly one draw per chance() call, whatever the probability', () => {
    const certain = new Rng(SEED).stream('rolls')
    const impossible = new Rng(SEED).stream('rolls')

    expect(certain.chance(1)).toBe(true)
    expect(impossible.chance(0)).toBe(false)
    expect(certain.state).toBe(impossible.state)
  })

  it('rejects invalid seeds, bounds and probabilities', () => {
    expect(() => new Rng(-1)).toThrow(RangeError)
    expect(() => new Rng(1.5)).toThrow(RangeError)
    expect(() => new Rng(SEED).stream('x').nextInt(5, 5)).toThrow(RangeError)
    expect(() => new Rng(SEED).stream('x').nextInt(0, 1.5)).toThrow(RangeError)
    expect(() => new Rng(SEED).stream('x').chance(1.1)).toThrow(RangeError)
    expect(() => new Rng(SEED).stream('x').chance(-0.1)).toThrow(RangeError)
  })
})

describe('Rng serialisation', () => {
  it('restores mid-sequence and continues identically', () => {
    const original = new Rng(SEED)
    draw(original.stream('intake'), 37)
    draw(original.stream('combat'), 11)

    const restored = Rng.restore(original.serialise())

    expect(draw(restored.stream('intake'), 20)).toEqual(draw(original.stream('intake'), 20))
    expect(draw(restored.stream('combat'), 20)).toEqual(draw(original.stream('combat'), 20))
  })

  it('serialises streams sorted by name, independent of creation order', () => {
    const rng = new Rng(SEED)
    rng.stream('zulu')
    rng.stream('alpha')
    rng.stream('mike')

    expect(rng.serialise().streams.map((stream) => stream.name)).toEqual(['alpha', 'mike', 'zulu'])
  })

  it('restores a single stream in place', () => {
    const stream = new RngStream('intake', 1234)
    draw(stream, 5)
    const checkpoint = stream.serialise()
    const expected = draw(stream, 5)

    stream.restore(checkpoint)

    expect(draw(stream, 5)).toEqual(expected)
  })

  it('refuses to restore a stream from another stream\u2019s state', () => {
    const stream = new RngStream('intake', 1234)

    expect(() => stream.restore({ name: 'combat', state: 99 })).toThrow(/intake/)
  })

  it('refuses to restore state from a different master seed', () => {
    const other = new Rng(SEED + 1).serialise()

    expect(() => new Rng(SEED).restore(other)).toThrow(/seed/)
  })
})
