/**
 * Danger level (T4.6, PRD 5.11).
 *
 * Recomputed every `balance.danger.recomputeMinutes` in-game minutes:
 *
 * ```
 * danger = clamp(
 *     0.30 * pctInmatesWithAnyCriticalNeed
 *   + 0.20 * (misconductLast6h / population) * 400
 *   + 0.15 * pctInmatesArmed * 300
 *   + 0.15 * (1 - staffMorale/100) * 100
 *   + 0.10 * (1 - guardCoverageRatio) * 100
 *   + 0.10 * pctMaxSecPopulation * 100
 * , 0, 100)
 * ```
 *
 * Weights and scales live in `balance.json`. Pure helpers are exported so tests
 * can assert each term without a full world.
 */

import { TICKS_PER_HOUR, TICKS_PER_MINUTE } from '../core/clock'
import type { System, SystemContext } from '../core/simulation'
import type { GameData } from '../data/loader'
import type { Balance } from '../data/schemas'
import { NeedIndex } from '../entities/needs'

import { isInmateWorld } from './intakeSystem'
import type { InmateWorld } from './intakeSystem'

/* -------------------------------------------------------------------------- */
/* Events                                                                      */
/* -------------------------------------------------------------------------- */

export const DANGER_EVENTS = {
  recomputed: 'danger.recomputed',
  rejected: 'danger.rejected',
} as const

export const DANGER_SYSTEM_NAME = 'danger'

/** Recompute cadence is data-driven; the system wakes every minute. */
export const DANGER_SYSTEM_PERIOD = TICKS_PER_MINUTE

export { MisconductWindow } from '../entities/securityState'

/* -------------------------------------------------------------------------- */
/* Pure formula                                                                */
/* -------------------------------------------------------------------------- */

export interface DangerInputs {
  /** 0..100 — share of inmates with any need at/above critical. */
  readonly pctInmatesWithAnyCriticalNeed: number
  /** Misconduct events inside the configured window. */
  readonly misconductLastWindow: number
  readonly population: number
  /** 0..100 — share of inmates carrying a weapon. */
  readonly pctInmatesArmed: number
  /** Prison-wide staff morale 0..100. */
  readonly staffMorale: number
  /** 0..1 — fraction of expected guard coverage that is present. */
  readonly guardCoverageRatio: number
  /** 0..100 — share of population in max-security categories. */
  readonly pctMaxSecPopulation: number
}

export interface DangerComponents {
  readonly criticalNeeds: number
  readonly misconduct: number
  readonly armedInmates: number
  readonly staffMorale: number
  readonly guardCoverage: number
  readonly maxSecurityShare: number
  readonly total: number
}

/** Clamp to [0, 100]. */
export function clampDanger(value: number): number {
  if (value <= 0) return 0
  if (value >= 100) return 100
  return value
}

/**
 * Each PRD 5.11 term in isolation, then the clamped sum.
 *
 * Weights multiply the scaled inputs exactly as the formula shows — e.g. the
 * misconduct term is `weight * (count / pop) * misconductScale`.
 */
export function dangerComponents(
  inputs: DangerInputs,
  balance: Balance['danger'],
): DangerComponents {
  const w = balance.weights
  const population = Math.max(0, inputs.population)
  const misconductRate =
    population <= 0 ? 0 : inputs.misconductLastWindow / population

  const criticalNeeds = w.criticalNeeds * clampDanger(inputs.pctInmatesWithAnyCriticalNeed)
  const misconduct = w.misconduct * misconductRate * balance.misconductScale
  // pctInmatesArmed is 0..100; PRD writes a 0..1 fraction × armedScale.
  const armedInmates =
    w.armedInmates * (clampDanger(inputs.pctInmatesArmed) / 100) * balance.armedScale
  const staffMorale =
    w.staffMorale * (1 - clampDanger(inputs.staffMorale) / 100) * 100
  const guardCoverage =
    w.guardCoverage * (1 - clamp01(inputs.guardCoverageRatio)) * 100
  const maxSecurityShare =
    w.maxSecurityShare * clampDanger(inputs.pctMaxSecPopulation)

  const total = clampDanger(
    criticalNeeds +
      misconduct +
      armedInmates +
      staffMorale +
      guardCoverage +
      maxSecurityShare,
  )

  return {
    criticalNeeds,
    misconduct,
    armedInmates,
    staffMorale,
    guardCoverage,
    maxSecurityShare,
    total,
  }
}

/** Convenience: just the clamped danger value. */
export function computeDanger(inputs: DangerInputs, balance: Balance['danger']): number {
  return dangerComponents(inputs, balance).total
}

function clamp01(value: number): number {
  if (value <= 0) return 0
  if (value >= 1) return 1
  return value
}

/* -------------------------------------------------------------------------- */
/* World sampling                                                              */
/* -------------------------------------------------------------------------- */

export function sampleDangerInputs(
  world: InmateWorld,
  data: GameData,
  index: NeedIndex,
  nowTick: number,
): DangerInputs {
  const inmates = [...world.inmates.all()]
  const population = inmates.length
  const balance = data.balance.danger
  const maxSec = new Set(balance.maxSecurityCategories)

  let criticalCount = 0
  let armedCount = 0
  let maxSecCount = 0

  for (const entity of inmates) {
    if (inmateHasCriticalNeed(entity.inmate.needs, index)) criticalCount += 1
    if (inmateIsArmed(entity.inmate.inventory, data)) armedCount += 1
    if (maxSec.has(entity.inmate.category)) maxSecCount += 1
  }

  const pct = (count: number): number =>
    population <= 0 ? 0 : (count / population) * 100

  const windowTicks = balance.misconductWindowHours * TICKS_PER_HOUR
  const misconductLastWindow = world.misconductWindow.countSince(nowTick, windowTicks)

  const officers = countCoverageOfficers(world, data)
  const perGuard = data.balance.emergency.inmatesPerGuardForCoverage
  const expected = population <= 0 ? 0 : Math.ceil(population / perGuard)
  const guardCoverageRatio = expected <= 0 ? 1 : clamp01(officers / expected)

  return {
    pctInmatesWithAnyCriticalNeed: pct(criticalCount),
    misconductLastWindow,
    population,
    pctInmatesArmed: pct(armedCount),
    staffMorale: world.morale.value,
    guardCoverageRatio,
    pctMaxSecPopulation: pct(maxSecCount),
  }
}

export function inmateHasCriticalNeed(needs: Float32Array, index: NeedIndex): boolean {
  for (let i = 0; i < index.size; i += 1) {
    const def = index.defAt(i)
    if ((needs[i] ?? 0) >= def.thresholds.critical) return true
  }
  return false
}

export function inmateIsArmed(inventory: readonly string[], data: GameData): boolean {
  for (const itemId of inventory) {
    const item = data.contraband.find(itemId)
    if (item !== undefined && item.category === 'weapon' && item.id !== 'fists') {
      return true
    }
  }
  return false
}

function countCoverageOfficers(world: InmateWorld, data: GameData): number {
  let count = 0
  for (const entity of world.staff.all()) {
    const def = data.staff.find(entity.staff.defId)
    if (def === undefined) continue
    if (def.callable) continue
    if (
      def.capabilities.includes('patrol') ||
      def.capabilities.includes('armed') ||
      def.capabilities.includes('riotControl')
    ) {
      count += 1
    }
  }
  return count
}

/* -------------------------------------------------------------------------- */
/* System                                                                      */
/* -------------------------------------------------------------------------- */

export interface DangerSystemOptions {
  readonly data: GameData
  readonly index?: NeedIndex
}

export function createDangerSystem(options: DangerSystemOptions): System {
  const { data } = options
  const index = options.index ?? NeedIndex.fromData(data)
  let reportedWrongWorld = false

  return {
    name: DANGER_SYSTEM_NAME,
    period: DANGER_SYSTEM_PERIOD,

    update(context: SystemContext): void {
      if (!isInmateWorld(context.world)) {
        if (reportedWrongWorld) return
        reportedWrongWorld = true
        context.events.emit({
          tick: context.clock.tick,
          kind: DANGER_EVENTS.rejected,
          causeIds: [],
          data: { command: DANGER_SYSTEM_NAME, reason: 'wrong-world' },
        })
        return
      }

      const world = context.world
      const every = data.balance.danger.recomputeMinutes
      if (context.clock.minute % every !== 0 && context.clock.tick !== 0) return

      const inputs = sampleDangerInputs(world, data, index, context.clock.tick)
      const components = dangerComponents(inputs, data.balance.danger)
      world.dangerLevel = components.total

      context.events.emit({
        tick: context.clock.tick,
        kind: DANGER_EVENTS.recomputed,
        causeIds: [],
        data: {
          danger: components.total,
          criticalNeeds: components.criticalNeeds,
          misconduct: components.misconduct,
          armedInmates: components.armedInmates,
          staffMorale: components.staffMorale,
          guardCoverage: components.guardCoverage,
          maxSecurityShare: components.maxSecurityShare,
          population: inputs.population,
        },
      })
    },
  }
}
