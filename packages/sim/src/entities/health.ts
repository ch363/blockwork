/**
 * Health, damage maths, and corpse handling (T4.5, PRD combat / injury).
 *
 * Pure helpers live here so every trait / vest / weapon combo can be asserted
 * without a world. `CombatRuntime` (see combatSystem) owns live fights; this
 * module owns the numbers that decide whether a hit injures, incapacitates,
 * kills, disarms, or is shrugged off.
 */

import type { Fnv1aHasher } from '../core/hash'
import type { EventSink } from '../core/simulation'
import type { RngStream } from '../core/rng'
import type { GameData } from '../data/loader'
import type { Balance, ContrabandDef, StatusEffectId } from '../data/schemas'

/* -------------------------------------------------------------------------- */
/* Events                                                                      */
/* -------------------------------------------------------------------------- */

export const HEALTH_EVENTS = {
  damaged: 'combat.damaged',
  incapacitated: 'combat.incapacitated',
  died: 'combat.died',
  disarmed: 'combat.disarmed',
  instantKill: 'combat.instantKill',
  stunned: 'combat.stunned',
  stunResisted: 'combat.stunResisted',
  healed: 'combat.healed',
  overdoseFatal: 'combat.overdoseFatal',
  corpseCreated: 'combat.corpseCreated',
  corpseToMortuary: 'combat.corpseToMortuary',
  hearseDeparted: 'combat.hearseDeparted',
} as const

/* -------------------------------------------------------------------------- */
/* Reputation helpers                                                          */
/* -------------------------------------------------------------------------- */

export type AttackReputation = 'strong' | 'very_strong'
export type DefenseReputation = 'hardy' | 'very_hardy'
export type DeadlyReputation = 'deadly' | 'very_deadly'
export type FighterReputation = 'trained_fighter' | 'expert_fighter'

export function hasReputation(reputations: readonly string[], id: string): boolean {
  return reputations.includes(id)
}

/** Strongest attack multiplier from reputations (very_strong wins over strong). */
export function attackMultiplier(
  reputations: readonly string[],
  balance: Balance['combat'],
): number {
  if (hasReputation(reputations, 'very_strong')) return balance.attackMultipliers.very_strong
  if (hasReputation(reputations, 'strong')) return balance.attackMultipliers.strong
  return 1
}

/** Strongest defense multiplier (very_hardy wins over hardy). */
export function defenseMultiplier(
  reputations: readonly string[],
  balance: Balance['combat'],
): number {
  if (hasReputation(reputations, 'very_hardy')) return balance.defenseMultipliers.very_hardy
  if (hasReputation(reputations, 'hardy')) return balance.defenseMultipliers.hardy
  return 1
}

/** Instant-kill chance from deadly reputations (very_deadly wins). */
export function instantKillChance(
  reputations: readonly string[],
  balance: Balance['combat'],
): number {
  if (hasReputation(reputations, 'very_deadly')) return balance.instantKillChance.very_deadly
  if (hasReputation(reputations, 'deadly')) return balance.instantKillChance.deadly
  return 0
}

/** Disarm chance from fighter reputations (expert wins). */
export function disarmChance(reputations: readonly string[], balance: Balance['combat']): number {
  if (hasReputation(reputations, 'expert_fighter')) return balance.disarmChance.expert_fighter
  if (hasReputation(reputations, 'trained_fighter')) return balance.disarmChance.trained_fighter
  return 0
}

/* -------------------------------------------------------------------------- */
/* Damage                                                                      */
/* -------------------------------------------------------------------------- */

export interface DamageInput {
  readonly attackPower: number
  readonly attackerReputations: readonly string[]
  readonly defenderReputations: readonly string[]
  readonly wearingVest: boolean
  readonly balance: Balance['combat']
}

/**
 * Hit damage after attack / defense / vest modifiers.
 *
 * `attackPower * attackMult * defenseMult * (vest ? vestMult : 1)`.
 */
export function computeHitDamage(input: DamageInput): number {
  const attack = attackMultiplier(input.attackerReputations, input.balance)
  const defense = defenseMultiplier(input.defenderReputations, input.balance)
  const vest = input.wearingVest ? input.balance.vestDamageMultiplier : 1
  return input.attackPower * attack * defense * vest
}

export interface InstantKillRoll {
  readonly chance: number
  readonly killed: boolean
}

export function rollInstantKill(
  reputations: readonly string[],
  balance: Balance['combat'],
  rng: RngStream,
): InstantKillRoll {
  const chance = instantKillChance(reputations, balance)
  return { chance, killed: rng.chance(chance) }
}

export interface DisarmRoll {
  readonly chance: number
  readonly disarmed: boolean
}

export function rollDisarm(
  reputations: readonly string[],
  balance: Balance['combat'],
  rng: RngStream,
): DisarmRoll {
  const chance = disarmChance(reputations, balance)
  return { chance, disarmed: rng.chance(chance) }
}

export interface StunResistRoll {
  readonly chance: number
  readonly resisted: boolean
}

/** `very_hardy` may shrug off a stun device; everyone else always goes down. */
export function rollStunResist(
  reputations: readonly string[],
  balance: Balance['combat'],
  rng: RngStream,
): StunResistRoll {
  if (!hasReputation(reputations, 'very_hardy')) {
    // Still consume a draw so adding resist later cannot shift the stream.
    rng.chance(0)
    return { chance: 0, resisted: false }
  }
  const chance = balance.stun.veryHardyResistChance
  return { chance, resisted: rng.chance(chance) }
}

/* -------------------------------------------------------------------------- */
/* Health application                                                          */
/* -------------------------------------------------------------------------- */

export type HealthOutcome = 'ok' | 'incapacitated' | 'dead'

export interface ApplyDamageResult {
  readonly healthBefore: number
  readonly healthAfter: number
  readonly damage: number
  readonly outcome: HealthOutcome
  readonly crossedIncap: boolean
}

export function clampHealth(value: number, maxHealth: number): number {
  if (!Number.isFinite(value)) return 0
  if (value <= 0) return 0
  if (value >= maxHealth) return maxHealth
  return value
}

/**
 * Applies damage to a 0..maxHealth pool. Crossing below the incap threshold
 * (without reaching 0) yields `incapacitated`; reaching 0 yields `dead`.
 */
export function applyDamage(
  health: number,
  damage: number,
  balance: Balance['combat'],
): ApplyDamageResult {
  const healthBefore = clampHealth(health, balance.maxHealth)
  const raw = healthBefore - Math.max(0, damage)
  const healthAfter = clampHealth(raw, balance.maxHealth)
  const wasCapable = healthBefore >= balance.incapHealthThreshold
  let outcome: HealthOutcome = 'ok'
  if (healthAfter <= 0) outcome = 'dead'
  else if (healthAfter < balance.incapHealthThreshold) outcome = 'incapacitated'
  return {
    healthBefore,
    healthAfter,
    damage: Math.max(0, damage),
    outcome,
    crossedIncap: wasCapable && outcome === 'incapacitated',
  }
}

export function applyHeal(health: number, amount: number, balance: Balance['combat']): number {
  return clampHealth(health + Math.max(0, amount), balance.maxHealth)
}

export function isIncapacitated(health: number, balance: Balance['combat']): boolean {
  return health > 0 && health < balance.incapHealthThreshold
}

export function ensureStatus(status: StatusEffectId[], effect: StatusEffectId): void {
  if (!status.includes(effect)) status.push(effect)
}

export function clearStatus(status: StatusEffectId[], effect: StatusEffectId): void {
  const index = status.indexOf(effect)
  if (index >= 0) status.splice(index, 1)
}

/* -------------------------------------------------------------------------- */
/* Weapons                                                                     */
/* -------------------------------------------------------------------------- */

export function resolveWeapon(
  data: GameData,
  inventory: readonly string[],
  preferredId?: string,
): ContrabandDef {
  const combat = data.balance.combat
  if (preferredId !== undefined) {
    const preferred = data.contraband.find(preferredId)
    if (preferred !== undefined && preferred.attackPower > 0) return preferred
  }
  let best: ContrabandDef | undefined
  for (const itemId of inventory) {
    const def = data.contraband.find(itemId)
    if (def === undefined || def.attackPower <= 0) continue
    if (best === undefined || def.attackPower > best.attackPower) best = def
  }
  if (best !== undefined) return best
  const fists = data.contraband.get(combat.defaultWeaponId)
  return fists
}

export function isStunWeapon(def: ContrabandDef, balance: Balance['combat']): boolean {
  return def.id === balance.stun.weaponId
}

/** True for firearms / thrown range; stun devices are handled separately. */
export function isRangedWeapon(def: ContrabandDef, balance: Balance['combat']): boolean {
  return def.range > 0 && !isStunWeapon(def, balance)
}

/** Ranged accuracy for a weapon id (falls back to default). */
export function rangedAccuracy(weaponId: string, balance: Balance['combat']): number {
  return balance.ranged.accuracyByWeapon[weaponId] ?? balance.ranged.defaultAccuracy
}

export function rechargeTicks(rechargeMinutes: number, ticksPerMinute: number): number {
  return Math.max(1, Math.round(rechargeMinutes * ticksPerMinute))
}

/* -------------------------------------------------------------------------- */
/* Line of sight                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Bresenham LOS. Walls block; doors and empty tiles do not. `hasWall` is
 * injected so tests can exercise the pure path without a grid.
 */
export function hasLineOfSight(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  hasWall: (tx: number, ty: number) => boolean,
): boolean {
  let x = x0
  let y = y0
  const dx = Math.abs(x1 - x0)
  const dy = Math.abs(y1 - y0)
  const sx = x0 < x1 ? 1 : -1
  const sy = y0 < y1 ? 1 : -1
  let err = dx - dy

  while (x !== x1 || y !== y1) {
    const e2 = err * 2
    if (e2 > -dy) {
      err -= dy
      x += sx
    }
    if (e2 < dx) {
      err += dx
      y += sy
    }
    if (x === x1 && y === y1) return true
    if (hasWall(x, y)) return false
  }
  return true
}

export function chebyshevDistance(ax: number, ay: number, bx: number, by: number): number {
  return Math.max(Math.abs(ax - bx), Math.abs(ay - by))
}

/* -------------------------------------------------------------------------- */
/* Corpses                                                                     */
/* -------------------------------------------------------------------------- */

export type CorpseAgentKind = 'inmate' | 'staff'
export type CorpseState = 'on_site' | 'at_mortuary' | 'removed'

export interface Corpse {
  readonly id: number
  readonly agentKind: CorpseAgentKind
  readonly agentId: number
  readonly name: string
  tileIndex: number
  readonly diedAtTick: number
  state: CorpseState
  /** Tick when a hearse is due after mortuary delivery. */
  hearseAtTick: number
  /** Job id for the mortuary pickup, or 0 when none. */
  mortuaryJobId: number
}

export class CorpseRegistry {
  readonly #corpses = new Map<number, Corpse>()
  #nextId = 1

  get size(): number {
    return this.#corpses.size
  }

  get(id: number): Corpse | undefined {
    return this.#corpses.get(id)
  }

  all(): Corpse[] {
    const list = [...this.#corpses.values()]
    list.sort((a, b) => a.id - b.id)
    return list
  }

  onSite(): Corpse[] {
    return this.all().filter((corpse) => corpse.state === 'on_site')
  }

  awaitingHearse(tick: number): Corpse[] {
    return this.all().filter(
      (corpse) => corpse.state === 'at_mortuary' && corpse.hearseAtTick <= tick,
    )
  }

  create(options: {
    readonly agentKind: CorpseAgentKind
    readonly agentId: number
    readonly name: string
    readonly tileIndex: number
    readonly diedAtTick: number
  }): Corpse {
    const id = this.#nextId
    this.#nextId += 1
    const corpse: Corpse = {
      id,
      agentKind: options.agentKind,
      agentId: options.agentId,
      name: options.name,
      tileIndex: options.tileIndex,
      diedAtTick: options.diedAtTick,
      state: 'on_site',
      hearseAtTick: Number.MAX_SAFE_INTEGER,
      mortuaryJobId: 0,
    }
    this.#corpses.set(id, corpse)
    return corpse
  }

  markMortuary(id: number, hearseAtTick: number): Corpse | undefined {
    const corpse = this.#corpses.get(id)
    if (corpse === undefined || corpse.state !== 'on_site') return undefined
    corpse.state = 'at_mortuary'
    corpse.hearseAtTick = hearseAtTick
    return corpse
  }

  markRemoved(id: number): Corpse | undefined {
    const corpse = this.#corpses.get(id)
    if (corpse === undefined) return undefined
    corpse.state = 'removed'
    return corpse
  }

  hashInto(hasher: Fnv1aHasher): void {
    hasher.writeUint32(this.#nextId)
    hasher.writeUint32(this.#corpses.size)
    for (const corpse of this.all()) {
      hasher.writeUint32(corpse.id)
      hasher.writeString(corpse.agentKind)
      hasher.writeUint32(corpse.agentId)
      hasher.writeString(corpse.name)
      hasher.writeUint32(corpse.tileIndex)
      hasher.writeUint32(corpse.diedAtTick)
      hasher.writeString(corpse.state)
      hasher.writeUint32(corpse.hearseAtTick === Number.MAX_SAFE_INTEGER ? 0xffffffff : corpse.hearseAtTick)
      hasher.writeUint32(corpse.mortuaryJobId)
    }
  }

  serialise(): {
    readonly nextId: number
    readonly list: readonly Corpse[]
  } {
    return {
      nextId: this.#nextId,
      list: this.all().map((corpse) => ({ ...corpse })),
    }
  }

  restore(snapshot: {
    readonly nextId: number
    readonly list: readonly {
      readonly id: number
      readonly agentKind: CorpseAgentKind
      readonly agentId: number
      readonly name: string
      readonly tileIndex: number
      readonly diedAtTick: number
      readonly state: CorpseState
      readonly hearseAtTick: number
      readonly mortuaryJobId: number
    }[]
  }): void {
    this.#corpses.clear()
    this.#nextId = Math.max(1, snapshot.nextId)
    for (const entry of snapshot.list) {
      this.#corpses.set(entry.id, {
        id: entry.id,
        agentKind: entry.agentKind,
        agentId: entry.agentId,
        name: entry.name,
        tileIndex: entry.tileIndex,
        diedAtTick: entry.diedAtTick,
        state: entry.state,
        hearseAtTick: entry.hearseAtTick,
        mortuaryJobId: entry.mortuaryJobId,
      })
    }
  }
}

export function emitCorpseCreated(
  events: EventSink,
  tick: number,
  corpse: Corpse,
  causeIds: readonly number[] = [],
): void {
  events.emit({
    tick,
    kind: HEALTH_EVENTS.corpseCreated,
    subjectId: corpse.id,
    causeIds: [...causeIds],
    data: {
      corpseId: corpse.id,
      agentKind: corpse.agentKind,
      agentId: corpse.agentId,
      tileIndex: corpse.tileIndex,
    },
  })
}

/* -------------------------------------------------------------------------- */
/* Combat runtime (owned by InmateWorld)                                       */
/* -------------------------------------------------------------------------- */

export type CombatantKind = 'inmate' | 'staff'

export interface CombatantRef {
  readonly kind: CombatantKind
  readonly id: number
}

export interface FightParticipant {
  readonly ref: CombatantRef
  /** Absolute tick when this combatant may strike again. */
  nextAttackTick: number
  /** Preferred weapon id while fighting; cleared on disarm. */
  weaponId: string | null
}

export type FightState = 'active' | 'ended'

export interface Fight {
  readonly id: number
  readonly participants: [FightParticipant, FightParticipant]
  state: FightState
  readonly startedAtTick: number
  /** Officer currently walking in to break it up, or 0. */
  interveningOfficerId: number
  /** Remaining chebyshev tiles until the intervening officer arrives. */
  interventionTilesRemaining: number
}

export interface OverdoseTimer {
  readonly inmateId: number
  readonly startedAtTick: number
  /** Absolute tick when untreated overdose kills. */
  fatalAtTick: number
}

/**
 * Live combat / injury state owned by InmateWorld.
 *
 * Vest wearers and stun charges are tracked here until equipment inventory
 * lands for staff. Staff health / status / loadout also live here so T4.5
 * does not widen `StaffComponent`.
 */
export class CombatRuntime {
  readonly fights = new Map<number, Fight>()
  readonly corpses = new CorpseRegistry()
  /** Entity keys (`inmate:3` / `staff:2`) currently wearing a protective vest. */
  readonly vestWearers = new Set<string>()
  /** Staff id → remaining stun charges (refilled after recharge). */
  readonly stunCharges = new Map<number, number>()
  /** Staff id → tick when stun charges refill. */
  readonly stunRechargeAt = new Map<number, number>()
  /** Inmate id → untreated overdose kill timer. */
  readonly overdoses = new Map<number, OverdoseTimer>()
  /** Inmate ids already queued for a clinic escort this incap episode. */
  readonly clinicEscortQueued = new Set<number>()
  /** Staff combat health keyed by `staff:{id}`. */
  readonly staffHealth = new Map<string, number>()
  readonly staffStatus = new Map<string, StatusEffectId[]>()
  readonly staffInventory = new Map<string, string[]>()
  #nextFightId = 1

  agentKey(kind: CombatantKind, id: number): string {
    return `${kind}:${id}`
  }

  wearingVest(kind: CombatantKind, id: number): boolean {
    return this.vestWearers.has(this.agentKey(kind, id))
  }

  setVest(kind: CombatantKind, id: number, wearing: boolean): void {
    const key = this.agentKey(kind, id)
    if (wearing) this.vestWearers.add(key)
    else this.vestWearers.delete(key)
  }

  setStaffLoadout(staffId: number, inventory: readonly string[], health?: number): void {
    const key = this.agentKey('staff', staffId)
    this.staffInventory.set(key, [...inventory])
    if (health !== undefined) this.staffHealth.set(key, health)
  }

  activeFights(): Fight[] {
    return [...this.fights.values()]
      .filter((fight) => fight.state === 'active')
      .sort((a, b) => a.id - b.id)
  }

  allocateFightId(): number {
    const id = this.#nextFightId
    this.#nextFightId += 1
    return id
  }

  fightInvolving(kind: CombatantKind, id: number): Fight | undefined {
    for (const fight of this.activeFights()) {
      if (fight.participants.some((p) => p.ref.kind === kind && p.ref.id === id)) {
        return fight
      }
    }
    return undefined
  }

  hashInto(hasher: Fnv1aHasher): void {
    hasher.writeUint32(this.#nextFightId)
    hasher.writeUint32(this.fights.size)
    for (const fight of [...this.fights.values()].sort((a, b) => a.id - b.id)) {
      hasher.writeUint32(fight.id)
      hasher.writeString(fight.state)
      hasher.writeUint32(fight.startedAtTick)
      hasher.writeUint32(fight.interveningOfficerId)
      hasher.writeUint32(fight.interventionTilesRemaining)
      for (const p of fight.participants) {
        hasher.writeString(p.ref.kind)
        hasher.writeUint32(p.ref.id)
        hasher.writeUint32(p.nextAttackTick)
        hasher.writeString(p.weaponId ?? '')
      }
    }
    this.corpses.hashInto(hasher)
    const vests = [...this.vestWearers].sort()
    hasher.writeUint32(vests.length)
    for (const key of vests) hasher.writeString(key)
    const charges = [...this.stunCharges.entries()].sort((a, b) => a[0] - b[0])
    hasher.writeUint32(charges.length)
    for (const [id, count] of charges) {
      hasher.writeUint32(id)
      hasher.writeUint32(count)
    }
    const recharges = [...this.stunRechargeAt.entries()].sort((a, b) => a[0] - b[0])
    hasher.writeUint32(recharges.length)
    for (const [id, at] of recharges) {
      hasher.writeUint32(id)
      hasher.writeUint32(at)
    }
    const ods = [...this.overdoses.values()].sort((a, b) => a.inmateId - b.inmateId)
    hasher.writeUint32(ods.length)
    for (const od of ods) {
      hasher.writeUint32(od.inmateId)
      hasher.writeUint32(od.startedAtTick)
      hasher.writeUint32(od.fatalAtTick)
    }
    hasher.writeUint32(this.clinicEscortQueued.size)
    for (const id of [...this.clinicEscortQueued].sort((a, b) => a - b)) {
      hasher.writeUint32(id)
    }
    hashStringNumberMap(hasher, this.staffHealth)
    hashStringListMap(hasher, this.staffStatus)
    hashStringListMap(hasher, this.staffInventory)
  }

  serialise(): {
    readonly nextFightId: number
    readonly fights: readonly {
      readonly id: number
      readonly state: FightState
      readonly startedAtTick: number
      readonly interveningOfficerId: number
      readonly interventionTilesRemaining: number
      readonly participants: readonly {
        readonly kind: CombatantKind
        readonly id: number
        readonly nextAttackTick: number
        readonly weaponId: string | null
      }[]
    }[]
    readonly corpses: ReturnType<CorpseRegistry['serialise']>
    readonly vestWearers: readonly string[]
    readonly stunCharges: readonly { readonly id: number; readonly count: number }[]
    readonly stunRechargeAt: readonly { readonly id: number; readonly at: number }[]
    readonly overdoses: readonly OverdoseTimer[]
    readonly clinicEscortQueued: readonly number[]
    readonly staffHealth: readonly { readonly key: string; readonly hp: number }[]
    readonly staffStatus: readonly { readonly key: string; readonly status: readonly string[] }[]
    readonly staffInventory: readonly {
      readonly key: string
      readonly inventory: readonly string[]
    }[]
  } {
    return {
      nextFightId: this.#nextFightId,
      fights: [...this.fights.values()]
        .sort((a, b) => a.id - b.id)
        .map((fight) => ({
          id: fight.id,
          state: fight.state,
          startedAtTick: fight.startedAtTick,
          interveningOfficerId: fight.interveningOfficerId,
          interventionTilesRemaining: fight.interventionTilesRemaining,
          participants: fight.participants.map((p) => ({
            kind: p.ref.kind,
            id: p.ref.id,
            nextAttackTick: p.nextAttackTick,
            weaponId: p.weaponId,
          })),
        })),
      corpses: this.corpses.serialise(),
      vestWearers: [...this.vestWearers].sort(),
      stunCharges: [...this.stunCharges.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([id, count]) => ({ id, count })),
      stunRechargeAt: [...this.stunRechargeAt.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([id, at]) => ({ id, at })),
      overdoses: [...this.overdoses.values()]
        .sort((a, b) => a.inmateId - b.inmateId)
        .map((od) => ({ ...od })),
      clinicEscortQueued: [...this.clinicEscortQueued].sort((a, b) => a - b),
      staffHealth: [...this.staffHealth.entries()]
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, hp]) => ({ key, hp })),
      staffStatus: [...this.staffStatus.entries()]
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, status]) => ({ key, status: [...status] })),
      staffInventory: [...this.staffInventory.entries()]
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, inventory]) => ({ key, inventory: [...inventory] })),
    }
  }

  restore(snapshot: {
    readonly nextFightId: number
    readonly fights: readonly {
      readonly id: number
      readonly state: string
      readonly startedAtTick: number
      readonly interveningOfficerId: number
      readonly interventionTilesRemaining: number
      readonly participants: readonly {
        readonly kind: string
        readonly id: number
        readonly nextAttackTick: number
        readonly weaponId: string | null
      }[]
    }[]
    readonly corpses: {
      readonly nextId: number
      readonly list: readonly {
        readonly id: number
        readonly agentKind: string
        readonly agentId: number
        readonly name: string
        readonly tileIndex: number
        readonly diedAtTick: number
        readonly state: string
        readonly hearseAtTick: number
        readonly mortuaryJobId: number
      }[]
    }
    readonly vestWearers: readonly string[]
    readonly stunCharges: readonly { readonly id: number; readonly count: number }[]
    readonly stunRechargeAt: readonly { readonly id: number; readonly at: number }[]
    readonly overdoses: readonly {
      readonly inmateId: number
      readonly startedAtTick: number
      readonly fatalAtTick: number
    }[]
    readonly clinicEscortQueued: readonly number[]
    readonly staffHealth: readonly { readonly key: string; readonly hp: number }[]
    readonly staffStatus: readonly { readonly key: string; readonly status: readonly string[] }[]
    readonly staffInventory: readonly {
      readonly key: string
      readonly inventory: readonly string[]
    }[]
  }): void {
    this.fights.clear()
    this.#nextFightId = Math.max(1, snapshot.nextFightId)
    for (const entry of snapshot.fights) {
      const participants = entry.participants.map((p) => ({
        ref: { kind: p.kind as CombatantKind, id: p.id },
        nextAttackTick: p.nextAttackTick,
        weaponId: p.weaponId,
      }))
      if (participants.length < 2) continue
      const first = participants[0]
      const second = participants[1]
      if (first === undefined || second === undefined) continue
      this.fights.set(entry.id, {
        id: entry.id,
        state: entry.state as FightState,
        startedAtTick: entry.startedAtTick,
        interveningOfficerId: entry.interveningOfficerId,
        interventionTilesRemaining: entry.interventionTilesRemaining,
        participants: [first, second],
      })
    }
    this.corpses.restore({
      nextId: snapshot.corpses.nextId,
      list: snapshot.corpses.list.map((c) => ({
        ...c,
        agentKind: c.agentKind as CorpseAgentKind,
        state: c.state as CorpseState,
      })),
    })
    this.vestWearers.clear()
    for (const key of snapshot.vestWearers) this.vestWearers.add(key)
    this.stunCharges.clear()
    for (const entry of snapshot.stunCharges) this.stunCharges.set(entry.id, entry.count)
    this.stunRechargeAt.clear()
    for (const entry of snapshot.stunRechargeAt) this.stunRechargeAt.set(entry.id, entry.at)
    this.overdoses.clear()
    for (const od of snapshot.overdoses) {
      this.overdoses.set(od.inmateId, { ...od })
    }
    this.clinicEscortQueued.clear()
    for (const id of snapshot.clinicEscortQueued) this.clinicEscortQueued.add(id)
    this.staffHealth.clear()
    for (const entry of snapshot.staffHealth) this.staffHealth.set(entry.key, entry.hp)
    this.staffStatus.clear()
    for (const entry of snapshot.staffStatus) {
      this.staffStatus.set(entry.key, [...entry.status] as StatusEffectId[])
    }
    this.staffInventory.clear()
    for (const entry of snapshot.staffInventory) {
      this.staffInventory.set(entry.key, [...entry.inventory])
    }
  }
}

function hashStringNumberMap(hasher: Fnv1aHasher, map: Map<string, number>): void {
  const entries = [...map.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  hasher.writeUint32(entries.length)
  for (const [key, value] of entries) {
    hasher.writeString(key)
    hasher.writeFloat64(value)
  }
}

function hashStringListMap(hasher: Fnv1aHasher, map: Map<string, readonly string[]>): void {
  const entries = [...map.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  hasher.writeUint32(entries.length)
  for (const [key, list] of entries) {
    hasher.writeString(key)
    hasher.writeUint32(list.length)
    for (const item of list) hasher.writeString(item)
  }
}
