/**
 * Standing Orders — misconduct → punishment matrix (T4.3 stub for T4.4).
 *
 * Full search / UI panel land with T4.3. This module owns the policy state that
 * punishment and misconduct already need: per-kind response, duration, search
 * flag, housing strictness, and meal quantity / variety.
 */

import type { Fnv1aHasher } from '../core/hash'
import type { GameData } from '../data/loader'
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
export function createDefaultStandingOrders(data: GameData): StandingOrdersState {
  const defaults = data.balance.contraband.standingOrders.defaults
  const misconduct = {} as Record<MisconductKind, MisconductStandingOrder>
  for (const kind of MISCONDUCT_KINDS) {
    const entry = defaults[kind]
    if (entry === undefined) {
      misconduct[kind] = { punishment: 'ignore', durationHours: 0, search: false }
    } else {
      misconduct[kind] = {
        punishment: entry.punishment,
        durationHours: entry.durationHours < 0 ? 0 : entry.durationHours,
        search: entry.search,
      }
    }
  }
  return {
    misconduct,
    reassignmentStrictness: data.balance.contraband.standingOrders.defaultReassignmentStrictness,
    mealQuantity: data.balance.kitchen.defaultMealQuantity,
    mealVariety: data.balance.kitchen.defaultMealVariety,
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
