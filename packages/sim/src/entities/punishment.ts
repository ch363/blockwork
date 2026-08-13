/**
 * Active punishment holds and suppression accrual (T4.4, PRD 5.11).
 *
 * Punishment lifecycle: Standing Orders → escort (or immediate if already at
 * the destination) → hold with meal delivery → release. Suppression accrues
 * while locked down / isolated / near armed officers, decays otherwise, and
 * isolation harms reform via a per-point grade penalty.
 */

import type { Fnv1aHasher } from '../core/hash'
import type { Balance, MisconductKind, PunishmentKind } from '../data/schemas'

export type ActivePunishmentKind = Exclude<PunishmentKind, 'ignore'>

export type PunishmentPhase = 'pending_escort' | 'holding' | 'releasing'

export interface ActivePunishment {
  readonly inmateId: number
  readonly kind: ActivePunishmentKind
  readonly sourceMisconduct: MisconductKind
  phase: PunishmentPhase
  /**
   * Minutes remaining on the hold. `-1` means indefinite. Only ticks down
   * while `phase === 'holding'`.
   */
  remainingMinutes: number
  /** Housing cell to restore after isolation (or the lockdown cell). */
  homeCellId: number
  /** Isolation / cell room currently holding the inmate. */
  holdRoomId: number
  destinationTile: number
  escortJobId: number
  /** Last Routine meal-block hour we already delivered for, or `-1`. */
  lastMealHourKey: number
  /** Isolation-only: suppression points accrued this hold (for reform harm). */
  isolationSuppressionAccrued: number
}

export class PunishmentRuntime {
  readonly #byInmate = new Map<number, ActivePunishment>()
  /** inmateId → tick when temporary agitator boost expires. */
  readonly #agitatorBoostUntil = new Map<number, number>()
  /** Minutes spent in lockdown / isolation since the last whole suppression point. */
  readonly #confinementMinutes = new Map<number, number>()
  /** Fractional armed-officer / decay leftovers (hourly rates applied per minute). */
  readonly #suppressionHourFrac = new Map<number, number>()

  get(inmateId: number): ActivePunishment | undefined {
    return this.#byInmate.get(inmateId)
  }

  all(): ActivePunishment[] {
    const list = [...this.#byInmate.values()]
    list.sort((a, b) => a.inmateId - b.inmateId)
    return list
  }

  set(punishment: ActivePunishment): void {
    this.#byInmate.set(punishment.inmateId, punishment)
  }

  remove(inmateId: number): ActivePunishment | undefined {
    const current = this.#byInmate.get(inmateId)
    if (current === undefined) return undefined
    this.#byInmate.delete(inmateId)
    this.#confinementMinutes.delete(inmateId)
    return current
  }

  has(inmateId: number): boolean {
    return this.#byInmate.has(inmateId)
  }

  setAgitatorBoost(inmateId: number, untilTick: number): void {
    const existing = this.#agitatorBoostUntil.get(inmateId) ?? 0
    if (untilTick > existing) this.#agitatorBoostUntil.set(inmateId, untilTick)
  }

  agitatorBoostMultiplier(inmateId: number, tick: number, factor: number): number {
    const until = this.#agitatorBoostUntil.get(inmateId)
    if (until === undefined || tick >= until) {
      if (until !== undefined) this.#agitatorBoostUntil.delete(inmateId)
      return 1
    }
    return factor
  }

  isAgitatorBoosted(inmateId: number, tick: number): boolean {
    const until = this.#agitatorBoostUntil.get(inmateId)
    return until !== undefined && tick < until
  }

  /**
   * Accrues confinement time toward the next whole suppression point.
   * `minutesPerPoint` is the PRD cadence (30 lockdown / 15 isolation).
   */
  accrueConfinementSuppression(inmateId: number, minutesPerPoint: number, minutes: number): number {
    if (minutesPerPoint <= 0 || minutes <= 0) return 0
    const next = (this.#confinementMinutes.get(inmateId) ?? 0) + minutes
    const whole = Math.floor(next / minutesPerPoint)
    this.#confinementMinutes.set(inmateId, next - whole * minutesPerPoint)
    return whole
  }

  /**
   * Applies hourly armed-officer accrual and free-decay in minute steps.
   * Returns the signed delta to apply to `inmate.suppression`.
   */
  applyHourlySuppressionDelta(
    inmateId: number,
    armedNearby: boolean,
    decaying: boolean,
    balance: Balance['suppression'],
    minutes: number,
  ): number {
    if (minutes <= 0) return 0
    let frac = this.#suppressionHourFrac.get(inmateId) ?? 0
    const perMinuteArmed = balance.armedOfficerPerHour / 60
    const perMinuteDecay = balance.decayPerHour / 60

    if (armedNearby) {
      frac += perMinuteArmed * minutes
    } else if (decaying) {
      frac -= perMinuteDecay * minutes
    }

    const whole = frac > 0 ? Math.floor(frac) : Math.ceil(frac)
    this.#suppressionHourFrac.set(inmateId, frac - whole)
    return whole
  }

  hashInto(hasher: Fnv1aHasher): void {
    const punishments = this.all()
    hasher.writeUint32(punishments.length)
    for (const punishment of punishments) {
      hasher.writeUint32(punishment.inmateId)
      hasher.writeString(punishment.kind)
      hasher.writeString(punishment.sourceMisconduct)
      hasher.writeString(punishment.phase)
      hasher.writeInt32(punishment.remainingMinutes)
      hasher.writeUint32(punishment.homeCellId)
      hasher.writeUint32(punishment.holdRoomId)
      hasher.writeUint32(punishment.destinationTile)
      hasher.writeUint32(punishment.escortJobId)
      hasher.writeInt32(punishment.lastMealHourKey)
      hasher.writeFloat64(punishment.isolationSuppressionAccrued)
    }

    const boosts = [...this.#agitatorBoostUntil.entries()].sort((a, b) => a[0] - b[0])
    hasher.writeUint32(boosts.length)
    for (const [id, until] of boosts) {
      hasher.writeUint32(id)
      hasher.writeUint32(until)
    }
  }

  serialise(): {
    readonly active: readonly ActivePunishment[]
    readonly agitatorBoostUntil: readonly {
      readonly inmateId: number
      readonly untilTick: number
    }[]
  } {
    return {
      active: this.all().map((punishment) => ({ ...punishment })),
      agitatorBoostUntil: [...this.#agitatorBoostUntil.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([inmateId, untilTick]) => ({ inmateId, untilTick })),
    }
  }

  restore(snapshot: {
    readonly active: readonly {
      readonly inmateId: number
      readonly kind: string
      readonly sourceMisconduct: string
      readonly phase: string
      readonly remainingMinutes: number
      readonly homeCellId: number
      readonly holdRoomId: number
      readonly destinationTile: number
      readonly escortJobId: number
      readonly lastMealHourKey: number
      readonly isolationSuppressionAccrued: number
    }[]
    readonly agitatorBoostUntil: readonly {
      readonly inmateId: number
      readonly untilTick: number
    }[]
  }): void {
    this.#byInmate.clear()
    this.#agitatorBoostUntil.clear()
    this.#confinementMinutes.clear()
    this.#suppressionHourFrac.clear()
    for (const entry of snapshot.active) {
      this.#byInmate.set(entry.inmateId, {
        inmateId: entry.inmateId,
        kind: entry.kind as ActivePunishmentKind,
        sourceMisconduct: entry.sourceMisconduct as MisconductKind,
        phase: entry.phase as PunishmentPhase,
        remainingMinutes: entry.remainingMinutes,
        homeCellId: entry.homeCellId,
        holdRoomId: entry.holdRoomId,
        destinationTile: entry.destinationTile,
        escortJobId: entry.escortJobId,
        lastMealHourKey: entry.lastMealHourKey,
        isolationSuppressionAccrued: entry.isolationSuppressionAccrued,
      })
    }
    for (const entry of snapshot.agitatorBoostUntil) {
      this.#agitatorBoostUntil.set(entry.inmateId, entry.untilTick)
    }
  }
}

export function createPunishmentRuntime(): PunishmentRuntime {
  return new PunishmentRuntime()
}

export function hoursToMinutes(hours: number): number {
  if (hours <= 0) return -1
  return hours * 60
}

export function clampSuppression(value: number, max: number): number {
  if (value < 0) return 0
  if (value > max) return max
  return value
}
