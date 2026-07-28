/**
 * Misconduct roll maths, kind selection, entitlement and auto-reclass (T4.4).
 *
 * Pure over balance + inmate context so each roll modifier can be tested in
 * isolation without a world. The system layer gathers context, rolls, and
 * applies Standing Orders / punishment.
 */

import type { RngStream } from '../core/rng'
import type { Balance, MisconductKind, PunishmentKind } from '../data/schemas'
import { MISCONDUCT_KINDS } from '../data/schemas'
import type { NeedIndex } from './needs'
import { NEED_MAX } from './needs'

/* -------------------------------------------------------------------------- */
/* Records                                                                     */
/* -------------------------------------------------------------------------- */

export interface MisconductRecord {
  readonly tick: number
  readonly kind: MisconductKind
  readonly punishment: PunishmentKind
  readonly durationHours: number
}

/** CausalEvent kinds emitted by the misconduct / punishment path. */
export const MISCONDUCT_EVENTS = {
  committed: 'misconduct.committed',
  searchQueued: 'misconduct.searchQueued',
  reclassified: 'misconduct.reclassified',
  punishmentStarted: 'punishment.started',
  punishmentReleased: 'punishment.released',
  mealDelivered: 'punishment.mealDelivered',
  isolationOverflow: 'punishment.isolationOverflow',
  rejected: 'misconduct.rejected',
} as const

/* -------------------------------------------------------------------------- */
/* Probability                                                                 */
/* -------------------------------------------------------------------------- */

export interface MisconductRollInput {
  readonly category: string
  readonly criticalNeedCount: number
  /** `1 + perPoint * (avgGrade - cellGrade)`, already clamped. */
  readonly cellGradeModifier: number
  /** Suppression on 0..100. */
  readonly suppression: number
  /** 1 while an agitator / instigator is within range (or boosted). */
  readonly instigatorNearby: number
  readonly guardNearby: boolean
  readonly hasViolentTrait: boolean
  /** Extra multiplier from a temporary agitator boost (usually 1). */
  readonly agitatorBoostMultiplier: number
}

/**
 * Misconduct probability per evaluation window (PRD 5.4).
 *
 * `p = base * (1 + step * critical) * cellGrade * (1 - factor * supp/100)
 *      * (1 + instigatorFactor * nearby) * guardMod * violent * agitatorBoost`
 */
export function computeMisconductProbability(
  balance: Balance['misconduct'],
  suppressionMax: number,
  input: MisconductRollInput,
): number {
  const base = balance.baseRatePer10MinutesByCategory[input.category] ?? 0
  if (base <= 0) return 0

  const criticalTerm = 1 + balance.criticalNeedStep * input.criticalNeedCount
  const suppressionNorm =
    suppressionMax > 0 ? Math.min(1, Math.max(0, input.suppression / suppressionMax)) : 0
  const suppressionTerm = 1 - balance.suppressionFactor * suppressionNorm
  const instigatorTerm = 1 + balance.instigatorFactor * input.instigatorNearby
  const guardTerm = input.guardNearby ? balance.guardProximityMultiplier : 1
  const violentTerm = input.hasViolentTrait ? balance.violentTraitMultiplier : 1

  const p =
    base *
    criticalTerm *
    input.cellGradeModifier *
    suppressionTerm *
    instigatorTerm *
    guardTerm *
    violentTerm *
    input.agitatorBoostMultiplier

  return Math.max(0, p)
}

/**
 * Cell-grade misconduct multiplier (PRD 5.3 entitlement ladder).
 * `1 + perPoint * (avgGrade - currentCellGrade)`, clamped.
 */
export function cellGradeMisconductModifier(
  balance: Balance['misconduct']['cellGrade'],
  avgGrade: number,
  currentCellGrade: number,
): number {
  const raw = 1 + balance.perPoint * (avgGrade - currentCellGrade)
  if (raw < balance.min) return balance.min
  if (raw > balance.max) return balance.max
  return raw
}

export function countCriticalNeeds(
  needs: Float32Array,
  index: NeedIndex,
  traits: readonly string[],
): number {
  let count = 0
  for (let i = 0; i < index.defs.length; i += 1) {
    const def = index.defs[i]
    if (def === undefined) continue
    if (def.onlyWithTrait !== undefined && !traits.includes(def.onlyWithTrait)) continue
    const value = needs[i] ?? 0
    if (value >= def.thresholds.critical) count += 1
  }
  return count
}

/* -------------------------------------------------------------------------- */
/* Kind selection                                                              */
/* -------------------------------------------------------------------------- */

export function misconductKindWeights(
  balance: Balance['misconduct'],
  criticalNeedCount: number,
  hasViolentTrait: boolean,
): Record<MisconductKind, number> {
  const weights = {} as Record<MisconductKind, number>
  for (const kind of MISCONDUCT_KINDS) {
    const base = balance.kindBaseWeights[kind] ?? 0
    const perCritical = balance.kindPerCriticalNeed[kind] ?? 0
    const violent = hasViolentTrait ? (balance.violentKindBonus[kind] ?? 0) : 0
    weights[kind] = Math.max(0, base + perCritical * criticalNeedCount + violent)
  }
  return weights
}

/** Weighted pick; returns `complaint` if every weight is zero. */
export function pickMisconductKind(
  rng: RngStream,
  weights: Readonly<Record<MisconductKind, number>>,
): MisconductKind {
  let total = 0
  for (const kind of MISCONDUCT_KINDS) {
    total += weights[kind] ?? 0
  }
  if (total <= 0) return 'complaint'

  let roll = rng.next() * total
  for (const kind of MISCONDUCT_KINDS) {
    roll -= weights[kind] ?? 0
    if (roll < 0) return kind
  }
  return MISCONDUCT_KINDS[MISCONDUCT_KINDS.length - 1] ?? 'complaint'
}

export function isMajorMisconduct(balance: Balance['misconduct'], kind: MisconductKind): boolean {
  const majorFrom = MISCONDUCT_KINDS.indexOf(balance.majorSeverityFrom)
  const index = MISCONDUCT_KINDS.indexOf(kind)
  return index >= 0 && majorFrom >= 0 && index >= majorFrom
}

/* -------------------------------------------------------------------------- */
/* Entitlement                                                                 */
/* -------------------------------------------------------------------------- */

export function applyEntitlementOnMisconduct(
  current: number,
  kind: MisconductKind,
  balance: Balance,
): number {
  if (isMajorMisconduct(balance.misconduct, kind)) return 0
  return Math.max(0, current - balance.entitlement.minorPenalty)
}

/* -------------------------------------------------------------------------- */
/* Auto-reclassification                                                       */
/* -------------------------------------------------------------------------- */

export interface ReclassificationResult {
  readonly category: string
  readonly sentenceHoursDelta: number
  readonly changed: boolean
}

/**
 * Serious injury bumps one step on the ladder. Homicide forces `maximum` and
 * adds `homicideSentenceYears` (PRD 5.5).
 */
export function applyAutoReclassification(
  category: string,
  kind: MisconductKind,
  balance: Balance['misconduct'],
  hoursPerSentenceYear: number,
): ReclassificationResult {
  if (kind === 'homicide') {
    const target = 'maximum'
    const years = balance.homicideSentenceYears
    return {
      category: target,
      sentenceHoursDelta: years * hoursPerSentenceYear,
      changed: category !== target || years > 0,
    }
  }

  if (kind === 'seriousInjury') {
    const ladder = balance.reclassLadder
    const index = ladder.indexOf(category)
    if (index < 0 || index >= ladder.length - 1) {
      return { category, sentenceHoursDelta: 0, changed: false }
    }
    const next = ladder[index + 1]
    if (next === undefined) {
      return { category, sentenceHoursDelta: 0, changed: false }
    }
    return { category: next, sentenceHoursDelta: 0, changed: next !== category }
  }

  return { category, sentenceHoursDelta: 0, changed: false }
}

/* -------------------------------------------------------------------------- */
/* Geometry helpers                                                            */
/* -------------------------------------------------------------------------- */

export function chebyshevTiles(ax: number, ay: number, bx: number, by: number): number {
  return Math.max(Math.abs(ax - bx), Math.abs(ay - by))
}

/** Food need discharge helper used when a meal is delivered during a hold. */
export function relieveFoodNeed(needs: Float32Array, foodIndex: number, amount: number): number {
  if (foodIndex < 0 || foodIndex >= needs.length) return 0
  const before = needs[foodIndex] ?? 0
  const after = Math.max(0, Math.min(NEED_MAX, before - amount))
  needs[foodIndex] = after
  return before - after
}
