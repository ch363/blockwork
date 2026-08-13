/**
 * Combat bridge for riot / emergency (T4.6) onto T4.5 health maths.
 *
 * `requestMeleeAttack` keeps the small surface riotSystem needs. When a combat
 * balance table is supplied, damage is clamped through {@link applyDamage};
 * otherwise raw subtraction is applied for callers that omit balance.
 */

import type { EventSink } from '../core/simulation'
import type { Fnv1aHasher } from '../core/hash'
import type { Balance } from '../data/schemas'
import { applyDamage } from './health'

export const COMBAT_EVENTS = {
  attack: 'combat.attack',
  injured: 'combat.injured',
  killed: 'combat.killed',
} as const

export type CombatActorKind = 'inmate' | 'staff'

export interface CombatActorRef {
  readonly kind: CombatActorKind
  readonly id: number
  health: number
}

export interface MeleeAttackResult {
  readonly damage: number
  readonly killed: boolean
  readonly injured: boolean
}

/**
 * Applies melee damage immediately (no recharge gate). Returns whether the
 * target dropped to zero health.
 */
export function requestMeleeAttack(options: {
  readonly tick: number
  readonly events: EventSink
  readonly attacker: CombatActorRef
  readonly target: CombatActorRef
  readonly damage?: number
  readonly balance: Balance['combat']
  /** Optional: mark staff injury on morale when target is staff. */
  readonly onStaffInjured?: (staffId: number) => void
  readonly onStaffKilled?: (staffId: number) => void
}): MeleeAttackResult {
  const requested = options.damage ?? options.balance.stubMeleeDamage
  const before = options.target.health
  let after: number
  let damage: number
  const result = applyDamage(before, requested, options.balance)
  after = result.healthAfter
  damage = result.damage
  options.target.health = after
  const killed = before > 0 && after <= 0
  const injured = !killed && after < before

  options.events.emit({
    tick: options.tick,
    kind: COMBAT_EVENTS.attack,
    subjectId: options.attacker.id,
    causeIds: [],
    data: {
      attackerKind: options.attacker.kind,
      attackerId: options.attacker.id,
      targetKind: options.target.kind,
      targetId: options.target.id,
      damage,
      remainingHealth: options.target.health,
    },
  })

  if (injured) {
    options.events.emit({
      tick: options.tick,
      kind: COMBAT_EVENTS.injured,
      subjectId: options.target.id,
      causeIds: [],
      data: {
        kind: options.target.kind,
        id: options.target.id,
        health: options.target.health,
      },
    })
    if (options.target.kind === 'staff') options.onStaffInjured?.(options.target.id)
  }

  if (killed) {
    options.events.emit({
      tick: options.tick,
      kind: COMBAT_EVENTS.killed,
      subjectId: options.target.id,
      causeIds: [],
      data: {
        kind: options.target.kind,
        id: options.target.id,
        killerKind: options.attacker.kind,
        killerId: options.attacker.id,
      },
    })
    if (options.target.kind === 'staff') options.onStaffKilled?.(options.target.id)
  }

  return { damage, killed, injured }
}

/** Placeholder hash hook if a future runtime stores melee bookkeeping here. */
export function hashCombatStub(hasher: Fnv1aHasher): void {
  hasher.writeUint32(0)
}
