/**
 * Prison-wide staff morale (T3.8, PRD 5.6).
 *
 * Pure formulas live here so unit tests can assert search effectiveness,
 * movement speed and bribe chance without a world. `MoraleState` owns the
 * rolling death window, injury set, wage multiplier, and strike lifecycle.
 *
 * Need satisfaction is the backbone (0–100). Wage and danger are weighted
 * pulls around that backbone — at market wages and zero danger, morale equals
 * mean need satisfaction — so a prison with no break facilities can still
 * strike within a few days even when staff are paid at the market rate.
 */

import { TICKS_PER_DAY, TICKS_PER_HOUR } from '../core/clock'
import type { Fnv1aHasher } from '../core/hash'
import type { EventSink } from '../core/simulation'
import type { RngStream } from '../core/rng'
import type { Balance } from '../data/schemas'

/* -------------------------------------------------------------------------- */
/* Events                                                                      */
/* -------------------------------------------------------------------------- */

export const MORALE_EVENTS = {
  recomputed: 'morale.recomputed',
  strikeStarted: 'morale.strikeStarted',
  strikeEnded: 'morale.strikeEnded',
  payDemand: 'morale.payDemand',
  payDemandAccepted: 'morale.payDemandAccepted',
  payDemandRefused: 'morale.payDemandRefused',
  bribeTaken: 'morale.bribeTaken',
} as const

/* -------------------------------------------------------------------------- */
/* Effect formulas                                                             */
/* -------------------------------------------------------------------------- */

export interface MoraleInputs {
  /** Mean of (100 − need) across every staff need value, 0..100. */
  readonly needSatisfaction: number
  /** Mean staff hourly wage / market rate (1 = at market). */
  readonly wageRatio: number
  /** Prison danger 0..100. */
  readonly dangerLevel: number
  /** Staff deaths inside the rolling window. */
  readonly recentDeaths: number
  /** Currently injured staff count. */
  readonly injuries: number
}

/**
 * Prison-wide morale 0..100.
 *
 * `weights.needSatisfaction` scales the backbone. `weights.wage` and
 * `weights.danger` scale how far wage/danger deviations pull away from it.
 */
export function computeMorale(inputs: MoraleInputs, balance: Balance['morale']): number {
  const needSat = clamp01_100(inputs.needSatisfaction)
  const wagePull = (clamp(inputs.wageRatio, 0, 2) - 1) * 100
  const dangerPull = -clamp01_100(inputs.dangerLevel)
  const w = balance.weights
  const backboneScale = w.needSatisfaction <= 0 ? 1 : 1 / w.needSatisfaction
  const value =
    needSat +
    w.wage * backboneScale * wagePull +
    w.danger * backboneScale * dangerPull -
    balance.staffDeathPenalty * Math.max(0, inputs.recentDeaths) -
    balance.injuryPenalty * Math.max(0, inputs.injuries)
  return clamp01_100(value)
}

/** Search effectiveness multiplier: `base + scale * morale/100`. */
export function searchEffectiveness(morale: number, balance: Balance['morale']): number {
  const { base, scale } = balance.searchEffectiveness
  return base + scale * (clamp01_100(morale) / 100)
}

/** Movement speed multiplier: `base + scale * morale/100`. */
export function movementSpeedMultiplier(morale: number, balance: Balance['morale']): number {
  const { base, scale } = balance.movementSpeed
  return base + scale * (clamp01_100(morale) / 100)
}

/** Bribe chance: `max(0, (pivot - morale) / divisor)`. */
export function bribeChance(morale: number, balance: Balance['morale']): number {
  const { pivot, divisor } = balance.bribeChance
  if (divisor <= 0) return 0
  return Math.max(0, (pivot - clamp01_100(morale)) / divisor)
}

/**
 * Danger term from staff morale (PRD 5.11):
 * `weight * (1 - morale/100) * 100`.
 */
export function dangerContributionFromMorale(morale: number, staffMoraleWeight: number): number {
  return staffMoraleWeight * (1 - clamp01_100(morale) / 100) * 100
}

/* -------------------------------------------------------------------------- */
/* Bribes                                                                      */
/* -------------------------------------------------------------------------- */

export interface ResolveSearchBribeOptions {
  readonly morale: number
  readonly balance: Balance['morale']
  readonly rng: RngStream
  readonly events: EventSink
  readonly tick: number
  readonly officerId: number
  readonly inmateId: number
  readonly contrabandId: string
  /** Optional CausalEvent ids that caused this search. */
  readonly causeIds?: readonly number[]
}

export type SearchBribeResult = 'confiscate' | 'bribe'

/**
 * When an officer finds contraband, roll the bribe chance. A bribe pockets the
 * item instead of confiscating and emits `morale.bribeTaken` for the Trace.
 */
export function resolveSearchBribe(options: ResolveSearchBribeOptions): SearchBribeResult {
  const chance = bribeChance(options.morale, options.balance)
  const tookBribe = options.rng.chance(chance)
  if (!tookBribe) return 'confiscate'

  options.events.emit({
    tick: options.tick,
    kind: MORALE_EVENTS.bribeTaken,
    subjectId: options.officerId,
    causeIds: options.causeIds === undefined ? [] : [...options.causeIds],
    data: {
      officerId: options.officerId,
      inmateId: options.inmateId,
      contrabandId: options.contrabandId,
      morale: options.morale,
      chance,
    },
  })
  return 'bribe'
}

/* -------------------------------------------------------------------------- */
/* Strike state                                                                */
/* -------------------------------------------------------------------------- */

export type StrikePhase = 'none' | 'active' | 'cooldown'

export interface StrikeSnapshot {
  readonly phase: StrikePhase
  readonly endsAtTick: number
  readonly cooldownUntilTick: number
  readonly refuseCount: number
  readonly payDemandOpen: boolean
  readonly demandedRaise: number
}

/* -------------------------------------------------------------------------- */
/* MoraleState                                                                 */
/* -------------------------------------------------------------------------- */

export class MoraleState {
  /** Latest recomputed morale 0..100. */
  value = 100
  /** Multiplier applied to every staff wage for morale + payroll display. */
  wageMultiplier = 1
  /** Contribution last written into `dangerLevel` so we can replace it cleanly. */
  lastDangerContribution = 0

  #deaths: number[] = []
  readonly #injured = new Set<number>()
  #strikePhase: StrikePhase = 'none'
  #strikeEndsAtTick = 0
  #cooldownUntilTick = 0
  #refuseCount = 0
  #payDemandOpen = false
  #demandedRaise = 0
  /** True after the first strike has ever fired (gates repeat-chance path). */
  #hasStruckBefore = false

  get strikePhase(): StrikePhase {
    return this.#strikePhase
  }

  get refuseCount(): number {
    return this.#refuseCount
  }

  get payDemandOpen(): boolean {
    return this.#payDemandOpen
  }

  get striking(): boolean {
    return this.#strikePhase === 'active'
  }

  snapshot(): StrikeSnapshot {
    return {
      phase: this.#strikePhase,
      endsAtTick: this.#strikeEndsAtTick,
      cooldownUntilTick: this.#cooldownUntilTick,
      refuseCount: this.#refuseCount,
      payDemandOpen: this.#payDemandOpen,
      demandedRaise: this.#demandedRaise,
    }
  }

  recordDeath(tick: number): void {
    this.#deaths.push(tick)
  }

  setInjured(staffId: number, injured: boolean): void {
    if (injured) this.#injured.add(staffId)
    else this.#injured.delete(staffId)
  }

  clearStaff(staffId: number): void {
    this.#injured.delete(staffId)
  }

  recentDeaths(tick: number, balance: Balance['morale']): number {
    const windowTicks = balance.staffDeathWindowDays * TICKS_PER_DAY
    const cutoff = tick - windowTicks
    this.#deaths = this.#deaths.filter((deathTick) => deathTick >= cutoff)
    return this.#deaths.length
  }

  injuryCount(): number {
    return this.#injured.size
  }

  /**
   * Starts a strike when morale is below threshold and the cooldown allows it.
   * First strike is immediate; repeats roll against refuse escalation.
   */
  maybeBeginStrike(
    tick: number,
    morale: number,
    balance: Balance['morale'],
    rng: RngStream,
    events: EventSink,
  ): boolean {
    if (this.#strikePhase === 'active') return false
    if (morale >= balance.strikeThreshold) return false
    if (tick < this.#cooldownUntilTick) return false

    if (this.#hasStruckBefore) {
      const chance = Math.min(
        1,
        balance.repeatStrikeBaseChance + this.#refuseCount * balance.refuseStrikeChanceBonus,
      )
      if (!rng.chance(chance)) return false
    }

    this.#strikePhase = 'active'
    this.#strikeEndsAtTick = tick + balance.strikeHours * TICKS_PER_HOUR
    this.#payDemandOpen = true
    this.#demandedRaise = balance.payDemandRaise
    this.#hasStruckBefore = true

    events.emit({
      tick,
      kind: MORALE_EVENTS.strikeStarted,
      causeIds: [],
      data: {
        morale,
        endsAtTick: this.#strikeEndsAtTick,
        demandedRaise: this.#demandedRaise,
        refuseCount: this.#refuseCount,
      },
    })
    events.emit({
      tick,
      kind: MORALE_EVENTS.payDemand,
      causeIds: [],
      data: {
        demandedRaise: this.#demandedRaise,
        currentWageMultiplier: this.wageMultiplier,
      },
    })
    return true
  }

  /** Ends an active strike once its duration elapses. */
  maybeEndStrike(tick: number, balance: Balance['morale'], events: EventSink): boolean {
    if (this.#strikePhase !== 'active') return false
    if (tick < this.#strikeEndsAtTick) return false

    this.#strikePhase = 'cooldown'
    this.#cooldownUntilTick = tick + balance.strikeCooldownHours * TICKS_PER_HOUR
    this.#payDemandOpen = false
    events.emit({
      tick,
      kind: MORALE_EVENTS.strikeEnded,
      causeIds: [],
      data: {
        cooldownUntilTick: this.#cooldownUntilTick,
        refuseCount: this.#refuseCount,
      },
    })
    return true
  }

  /** Clears cooldown once elapsed so repeat-strike rolls can fire. */
  tickCooldown(tick: number): void {
    if (this.#strikePhase === 'cooldown' && tick >= this.#cooldownUntilTick) {
      this.#strikePhase = 'none'
    }
  }

  acceptPayDemand(tick: number, balance: Balance['morale'], events: EventSink): boolean {
    if (!this.#payDemandOpen) return false
    const raise = this.#demandedRaise
    this.wageMultiplier *= 1 + raise
    this.#payDemandOpen = false
    // Accepting ends the strike early — staff got what they asked for.
    if (this.#strikePhase === 'active') {
      this.#strikePhase = 'cooldown'
      this.#cooldownUntilTick = tick + balance.strikeCooldownHours * TICKS_PER_HOUR
      this.#strikeEndsAtTick = tick
    }
    events.emit({
      tick,
      kind: MORALE_EVENTS.payDemandAccepted,
      causeIds: [],
      data: { raise, wageMultiplier: this.wageMultiplier },
    })
    return true
  }

  refusePayDemand(tick: number, events: EventSink): boolean {
    if (!this.#payDemandOpen) return false
    this.#payDemandOpen = false
    this.#refuseCount += 1
    events.emit({
      tick,
      kind: MORALE_EVENTS.payDemandRefused,
      causeIds: [],
      data: { refuseCount: this.#refuseCount },
    })
    return true
  }

  hashInto(hasher: Fnv1aHasher): void {
    hasher.writeFloat64(this.value)
    hasher.writeFloat64(this.wageMultiplier)
    hasher.writeFloat64(this.lastDangerContribution)
    hasher.writeUint32(this.#deaths.length)
    for (const death of this.#deaths) hasher.writeUint32(death)
    const injured = [...this.#injured].sort((a, b) => a - b)
    hasher.writeUint32(injured.length)
    for (const id of injured) hasher.writeUint32(id)
    hasher.writeString(this.#strikePhase)
    hasher.writeUint32(this.#strikeEndsAtTick)
    hasher.writeUint32(this.#cooldownUntilTick)
    hasher.writeUint32(this.#refuseCount)
    hasher.writeUint32(this.#payDemandOpen ? 1 : 0)
    hasher.writeFloat64(this.#demandedRaise)
    hasher.writeUint32(this.#hasStruckBefore ? 1 : 0)
  }
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

function clamp01_100(value: number): number {
  if (value <= 0) return 0
  if (value >= 100) return 100
  return value
}

function clamp(value: number, min: number, max: number): number {
  if (value <= min) return min
  if (value >= max) return max
  return value
}
