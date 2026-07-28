/**
 * Combat hooks stubbed for T4.6 until T4.5 lands a full CombatSystem.
 *
 * Rioters attack staff through {@link requestMeleeAttack}. The stub applies a
 * fixed health delta and records injuries on morale when present, so emergency
 * free-fire / riot-squad side effects can be tested without the full weapon
 * recharge / trait / LOS pipeline.
 */

import type { EventSink } from '../core/simulation'
import type { Fnv1aHasher } from '../core/hash'

export const COMBAT_EVENTS = {
  attack: 'combat.attack',
  injured: 'combat.injured',
  killed: 'combat.killed',
} as const

/** Default stub damage when T4.5 weapon tables are absent. */
export const STUB_MELEE_DAMAGE = 15

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
 * target dropped below zero health.
 */
export function requestMeleeAttack(options: {
  readonly tick: number
  readonly events: EventSink
  readonly attacker: CombatActorRef
  readonly target: CombatActorRef
  readonly damage?: number
  /** Optional: mark staff injury on morale when target is staff. */
  readonly onStaffInjured?: (staffId: number) => void
  readonly onStaffKilled?: (staffId: number) => void
}): MeleeAttackResult {
  const damage = options.damage ?? STUB_MELEE_DAMAGE
  const before = options.target.health
  options.target.health = Math.max(0, before - damage)
  const killed = before > 0 && options.target.health <= 0
  const injured = !killed && options.target.health < before

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
    if (options.target.kind === 'staff') {
      options.onStaffInjured?.(options.target.id)
    }
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
        byKind: options.attacker.kind,
        byId: options.attacker.id,
      },
    })
    if (options.target.kind === 'staff') {
      options.onStaffKilled?.(options.target.id)
    }
  }

  return { damage, killed, injured }
}

/** Hash helper for worlds that store pending combat cooldowns (T4.5). */
export function hashCombatCooldowns(
  hasher: Fnv1aHasher,
  cooldowns: ReadonlyMap<number, number>,
): void {
  const entries = [...cooldowns.entries()].sort((a, b) => a[0] - b[0])
  hasher.writeUint32(entries.length)
  for (const [id, untilTick] of entries) {
    hasher.writeUint32(id)
    hasher.writeUint32(untilTick)
  }
}
