/**
 * Standing Orders — misconduct → punishment matrix (T4.3 stub for T4.4).
 *
 * Full search / UI panel land with T4.3. This module owns the policy state that
 * punishment and misconduct already need: per-kind response, duration, search
 * flag, housing strictness, and meal quantity / variety.
 */

import type { Fnv1aHasher } from '../core/hash'
import type { MisconductKind, PunishmentKind, ReassignmentStrictness } from '../data/schemas'
import { MISCONDUCT_KINDS } from '../data/schemas'

export type MealPolicyQuantity = 'low' | 'normal' | 'high'

export interface MisconductStandingOrder {
  punishment: PunishmentKind
  /**
   * Hold length in hours. `0` means indefinite (homicide default). Ignored
   * when `punishment` is `ignore`.
   */
  durationHours: number
  /** Queue an automatic search when this kind fires (T4.3). */
  search: boolean
}

export interface StandingOrdersState {
  readonly misconduct: Record<MisconductKind, MisconductStandingOrder>
  reassignmentStrictness: ReassignmentStrictness
  mealQuantity: MealPolicyQuantity
  mealVariety: number
}

/** Defaults match the Standing Orders mockup (docs/04-ui-mockups.html §9). */
export function createDefaultStandingOrders(): StandingOrdersState {
  return {
    misconduct: {
      complaint: { punishment: 'ignore', durationHours: 0, search: false },
      contraband: { punishment: 'lockdown', durationHours: 6, search: true },
      intoxication: { punishment: 'lockdown', durationHours: 4, search: true },
      destruction: { punishment: 'lockdown', durationHours: 8, search: false },
      attackInmate: { punishment: 'isolation', durationHours: 12, search: true },
      attackStaff: { punishment: 'isolation', durationHours: 24, search: true },
      seriousInjury: { punishment: 'isolation', durationHours: 36, search: true },
      homicide: { punishment: 'isolation', durationHours: 0, search: true },
      escapeAttempt: { punishment: 'isolation', durationHours: 24, search: true },
    },
    reassignmentStrictness: 'lenient',
    mealQuantity: 'normal',
    mealVariety: 2,
  }
}

export function orderForKind(
  orders: StandingOrdersState,
  kind: MisconductKind,
): MisconductStandingOrder {
  return orders.misconduct[kind]
}

export function setMisconductOrder(
  orders: StandingOrdersState,
  kind: MisconductKind,
  patch: Partial<MisconductStandingOrder>,
): void {
  const current = orders.misconduct[kind]
  orders.misconduct[kind] = {
    punishment: patch.punishment ?? current.punishment,
    durationHours: patch.durationHours ?? current.durationHours,
    search: patch.search ?? current.search,
  }
}

export function hashStandingOrders(hasher: Fnv1aHasher, orders: StandingOrdersState): void {
  for (const kind of MISCONDUCT_KINDS) {
    const order = orders.misconduct[kind]
    hasher.writeString(kind)
    hasher.writeString(order.punishment)
    hasher.writeUint32(order.durationHours)
    hasher.writeUint32(order.search ? 1 : 0)
  }
  hasher.writeString(orders.reassignmentStrictness)
  hasher.writeString(orders.mealQuantity)
  hasher.writeUint32(orders.mealVariety)
}

/** Alias used by the package index to avoid clashing with save JSON. */
export type StandingOrdersPolicy = StandingOrdersState
