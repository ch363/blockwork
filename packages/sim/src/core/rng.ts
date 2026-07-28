/**
 * Seeded random number generation (PRD 4.2).
 *
 * One master seed, and a `mulberry32` sub-stream per subsystem. A stream's
 * starting state is derived purely from the master seed and a hash of the
 * stream's name, so streams are independent of each other and of the order
 * they were first requested in. That is what makes it safe to add
 * `rng.stream('tunnels')` in a later ticket without shifting the rolls that
 * `rng.stream('intake')` produces.
 *
 * Simulation code only. Rendering and UI must never advance a stream.
 */

import { fnv1a32 } from './hash'

/** One stream's whole serialised state. */
export interface RngStreamState {
  readonly name: string
  /** The mulberry32 internal state, an unsigned 32-bit integer. */
  readonly state: number
}

/** The RNG's whole serialised state. See `RngState` in PRD 7.4. */
export interface RngState {
  readonly seed: number
  /** Sorted by name, so serialisation does not depend on creation order. */
  readonly streams: readonly RngStreamState[]
}

const UINT32_RANGE = 0x1_0000_0000

function assertUint32Seed(seed: number, label: string): void {
  if (!Number.isInteger(seed) || seed < 0 || seed >= UINT32_RANGE) {
    throw new RangeError(`${label} must be an integer in 0..4294967295, received ${seed}`)
  }
}

/**
 * Derives a stream's starting state from the master seed and its name.
 *
 * FNV-1a alone leaves neighbouring names in neighbouring buckets, and
 * mulberry32 seeded with adjacent values produces visibly correlated first
 * draws, so the hash goes through the murmur3 finaliser to avalanche it.
 */
export function deriveStreamSeed(masterSeed: number, name: string): number {
  let hash = fnv1a32(name, masterSeed >>> 0)
  hash ^= hash >>> 16
  hash = Math.imul(hash, 0x85ebca6b)
  hash ^= hash >>> 13
  hash = Math.imul(hash, 0xc2b2ae35)
  hash ^= hash >>> 16
  return hash >>> 0
}

/** A single named mulberry32 stream. */
export class RngStream {
  readonly name: string
  #state: number

  constructor(name: string, state: number) {
    if (name.length === 0) {
      throw new TypeError('rng stream name must be a non-empty string')
    }
    assertUint32Seed(state, 'rng stream state')
    this.name = name
    this.#state = state
  }

  /** The mulberry32 internal state, exposed for saves and determinism hashing. */
  get state(): number {
    return this.#state
  }

  /** The next raw 32-bit draw. Every other draw method is built on this one. */
  nextUint32(): number {
    this.#state = (this.#state + 0x6d2b79f5) >>> 0
    let t = this.#state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return (t ^ (t >>> 14)) >>> 0
  }

  /** The next draw in [0, 1). */
  next(): number {
    return this.nextUint32() / UINT32_RANGE
  }

  /** The next integer in [minInclusive, maxExclusive). */
  nextInt(minInclusive: number, maxExclusive: number): number {
    if (!Number.isInteger(minInclusive) || !Number.isInteger(maxExclusive)) {
      throw new RangeError(
        `nextInt bounds must be integers, received ${minInclusive}..${maxExclusive}`,
      )
    }
    if (maxExclusive <= minInclusive) {
      throw new RangeError(
        `nextInt requires maxExclusive > minInclusive, received ${minInclusive}..${maxExclusive}`,
      )
    }
    return minInclusive + Math.floor(this.next() * (maxExclusive - minInclusive))
  }

  /**
   * A weighted coin flip. Always consumes exactly one draw, including at
   * probability 0 and 1, so that changing a balance number cannot shift the
   * stream out from under everything downstream of it.
   */
  chance(probability: number): boolean {
    if (!Number.isFinite(probability) || probability < 0 || probability > 1) {
      throw new RangeError(`probability must be in 0..1, received ${probability}`)
    }
    return this.next() < probability
  }

  serialise(): RngStreamState {
    return { name: this.name, state: this.#state }
  }

  restore(state: RngStreamState): void {
    if (state.name !== this.name) {
      throw new Error(`cannot restore stream '${this.name}' from state for '${state.name}'`)
    }
    assertUint32Seed(state.state, 'rng stream state')
    this.#state = state.state
  }
}

/** The master RNG. Hands out named streams and owns their collective state. */
export class Rng {
  readonly seed: number
  #streams = new Map<string, RngStream>()

  constructor(seed: number) {
    assertUint32Seed(seed, 'rng seed')
    this.seed = seed
  }

  static restore(state: RngState): Rng {
    const rng = new Rng(state.seed)
    rng.restore(state)
    return rng
  }

  /**
   * The named stream, created on first request. Creating a stream never
   * touches any other stream's state.
   */
  stream(name: string): RngStream {
    const existing = this.#streams.get(name)
    if (existing !== undefined) {
      return existing
    }
    const created = new RngStream(name, deriveStreamSeed(this.seed, name))
    this.#streams.set(name, created)
    return created
  }

  /** The names of every stream created so far, sorted. */
  streamNames(): readonly string[] {
    return [...this.#streams.keys()].sort()
  }

  serialise(): RngState {
    const streams = this.streamNames().map((name) => this.stream(name).serialise())
    return { seed: this.seed, streams }
  }

  restore(state: RngState): void {
    if (state.seed !== this.seed) {
      throw new Error(`cannot restore rng seeded ${this.seed} from state seeded ${state.seed}`)
    }
    this.#streams.clear()
    for (const streamState of state.streams) {
      this.#streams.set(streamState.name, new RngStream(streamState.name, streamState.state))
    }
  }
}
