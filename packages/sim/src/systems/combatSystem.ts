/**
 * `CombatSystem`: fights, injury, death, medics, overdose (T4.5).
 *
 * Combat is turn-based per weapon recharge, not per tick: each participant
 * strikes when their recharge elapses. Misconduct (T4.4) starts fights via
 * {@link beginFight} for violent kinds when a target is in range.
 *
 * PRD 4.4 slot 13 — runs every tick alongside movement / pathing.
 */

import { TICKS_PER_MINUTE } from '../core/clock'
import type { EventSink, System, SystemContext } from '../core/simulation'
import type { RngStream } from '../core/rng'
import type { GameData } from '../data/loader'
import type { ContrabandDef, StatusEffectId } from '../data/schemas'
import {
  CombatRuntime,
  HEALTH_EVENTS,
  applyDamage,
  applyHeal,
  chebyshevDistance,
  clearStatus,
  computeHitDamage,
  ensureStatus,
  hasLineOfSight,
  isIncapacitated,
  isRangedWeapon,
  isStunWeapon,
  rangedAccuracy,
  rechargeTicks,
  resolveWeapon,
  rollDisarm,
  rollInstantKill,
  rollStunResist,
  emitCorpseCreated,
  type CombatantKind,
  type CombatantRef,
  type Corpse,
  type Fight,
  type FightParticipant,
  type OverdoseTimer,
} from '../entities/health'
import { enqueueEscort, hasCapability, type StaffEntity } from '../entities/staff'
import { NO_STAFF } from '../entities/staff'
import { isWall } from '../world/walls'
import { accrueBloodSpillDirt } from './logistics/cleaning'
import { postJob } from './jobSystem'
import { isInmateWorld } from './intakeSystem'
import type { InmateWorld } from './intakeSystem'

/* -------------------------------------------------------------------------- */
/* Events                                                                      */
/* -------------------------------------------------------------------------- */

export const COMBAT_EVENTS = {
  ...HEALTH_EVENTS,
  fightStarted: 'combat.fightStarted',
  fightEnded: 'combat.fightEnded',
  attackMissed: 'combat.attackMissed',
  intervention: 'combat.intervention',
  rejected: 'combat.rejected',
} as const

export { CombatRuntime }
export type {
  CombatantKind,
  CombatantRef,
  Fight,
  FightParticipant,
  FightState,
  OverdoseTimer,
} from '../entities/health'

/* -------------------------------------------------------------------------- */
/* System                                                                      */
/* -------------------------------------------------------------------------- */

export interface CombatSystemOptions {
  readonly data: GameData
}

export const COMBAT_SYSTEM_NAME = 'combat'
export const COMBAT_SYSTEM_PERIOD = 1

export function createCombatSystem(options: CombatSystemOptions): System {
  const { data } = options
  let reportedWrongWorld = false
  let lastMinuteTick = -1

  return {
    name: COMBAT_SYSTEM_NAME,
    period: COMBAT_SYSTEM_PERIOD,

    update(context: SystemContext): void {
      const tick = context.clock.tick
      if (!isInmateWorld(context.world)) {
        if (reportedWrongWorld) return
        reportedWrongWorld = true
        context.events.emit({
          tick,
          kind: COMBAT_EVENTS.rejected,
          causeIds: [],
          data: { command: COMBAT_SYSTEM_NAME, reason: 'wrong-world' },
        })
        return
      }

      const world = context.world
      const rng = context.rng.stream('combat')

      refillStunCharges(world, data, tick)
      resolveFightTurns(world, data, context.events, tick, rng)
      progressInterventions(world, data, context.events, tick)
      processCorpses(world, data, context.events, tick)
      trackOverdoses(world, data, context.events, tick)

      const minute = Math.floor(tick / TICKS_PER_MINUTE)
      if (minute !== lastMinuteTick) {
        lastMinuteTick = minute
        medicHealPass(world, data, context.events, tick)
      }
    },
  }
}

/* -------------------------------------------------------------------------- */
/* Public API (misconduct / tests)                                             */
/* -------------------------------------------------------------------------- */

export interface BeginFightOptions {
  readonly world: InmateWorld
  readonly data: GameData
  readonly events: EventSink
  readonly tick: number
  readonly a: CombatantRef
  readonly b: CombatantRef
  readonly aWeaponId?: string
  readonly bWeaponId?: string
}

/**
 * Starts a fight between two combatants. No-ops when either is already in a
 * fight, missing, or dead. Called by misconduct violence and by tests.
 */
export function beginFight(options: BeginFightOptions): Fight | undefined {
  const { world, data, events, tick, a, b } = options
  if (a.kind === b.kind && a.id === b.id) return undefined
  if (world.combat.fightInvolving(a.kind, a.id) !== undefined) return undefined
  if (world.combat.fightInvolving(b.kind, b.id) !== undefined) return undefined
  if (resolveCombatant(world, a) === undefined) return undefined
  if (resolveCombatant(world, b) === undefined) return undefined

  const id = world.combat.allocateFightId()
  const fight: Fight = {
    id,
    participants: [
      {
        ref: a,
        nextAttackTick: tick,
        weaponId: options.aWeaponId ?? null,
      },
      {
        ref: b,
        nextAttackTick: tick,
        weaponId: options.bWeaponId ?? null,
      },
    ],
    state: 'active',
    startedAtTick: tick,
    interveningOfficerId: NO_STAFF,
    interventionTilesRemaining: 0,
  }
  world.combat.fights.set(id, fight)
  events.emit({
    tick,
    kind: COMBAT_EVENTS.fightStarted,
    subjectId: id,
    causeIds: [],
    data: {
      fightId: id,
      aKind: a.kind,
      aId: a.id,
      bKind: b.kind,
      bId: b.id,
    },
  })
  void data
  return fight
}

/**
 * Marks an inmate as overdosed and starts the untreated fatal timer.
 * Narcotics systems (T4.2+) call this; tests drive it directly.
 */
export function beginOverdose(
  world: InmateWorld,
  data: GameData,
  inmateId: number,
  tick: number,
): OverdoseTimer | undefined {
  const entity = world.inmates.get(inmateId)
  if (entity === undefined) return undefined
  ensureStatus(entity.inmate.status, 'overdosed')
  const fatalAtTick = tick + data.balance.combat.overdose.untreatedDeathMinutes * TICKS_PER_MINUTE
  const timer: OverdoseTimer = { inmateId, startedAtTick: tick, fatalAtTick }
  world.combat.overdoses.set(inmateId, timer)
  return timer
}

/** Posts a clinic escort for an incapacitated inmate when a clinic tile exists. */
export function queueClinicEscort(
  world: InmateWorld,
  data: GameData,
  events: EventSink,
  tick: number,
  inmateId: number,
): boolean {
  if (world.combat.clinicEscortQueued.has(inmateId)) return false
  const destination = findClinicTile(world)
  if (destination === undefined) return false
  const job = enqueueEscort({
    world,
    inmateId,
    destinationTile: destination,
    purpose: 'clinic',
    events,
    tick,
  })
  if (job === undefined) return false
  world.combat.clinicEscortQueued.add(inmateId)
  void data
  return true
}

/* -------------------------------------------------------------------------- */
/* Fight resolution                                                            */
/* -------------------------------------------------------------------------- */

function resolveFightTurns(
  world: InmateWorld,
  data: GameData,
  events: EventSink,
  tick: number,
  rng: RngStream,
): void {
  for (const fight of world.combat.activeFights()) {
    for (let i = 0; i < fight.participants.length; i += 1) {
      // Index is 0|1; length is fixed at 2.
      const attacker = fight.participants[i]
      const defender = fight.participants[1 - i]
      if (attacker === undefined || defender === undefined) continue
      if (fight.state !== 'active') break
      if (tick < attacker.nextAttackTick) continue
      const result = attemptStrike({
        world,
        data,
        events,
        tick,
        rng,
        fight,
        attacker,
        defender,
      })
      if (result === 'ended') break
    }
  }
}

type StrikeResult = 'continued' | 'ended'

function attemptStrike(options: {
  readonly world: InmateWorld
  readonly data: GameData
  readonly events: EventSink
  readonly tick: number
  readonly rng: RngStream
  readonly fight: Fight
  readonly attacker: FightParticipant
  readonly defender: FightParticipant
}): StrikeResult {
  const { world, data, events, tick, rng, fight, attacker, defender } = options
  const attackerEntity = resolveCombatant(world, attacker.ref)
  const defenderEntity = resolveCombatant(world, defender.ref)
  if (attackerEntity === undefined || defenderEntity === undefined) {
    endFight(world, events, tick, fight, 'missing')
    return 'ended'
  }

  if (attackerEntity.health <= 0 || defenderEntity.health <= 0) {
    endFight(world, events, tick, fight, 'dead')
    return 'ended'
  }

  // Incapacitated / stunned combatants cannot strike.
  if (
    isIncapacitated(attackerEntity.health, data.balance.combat) ||
    attackerEntity.status.includes('stunned') ||
    attackerEntity.status.includes('surrendered')
  ) {
    attacker.nextAttackTick = tick + TICKS_PER_MINUTE
    return 'continued'
  }

  const inventory = attackerEntity.inventory
  const weapon = resolveWeapon(data, inventory, attacker.weaponId ?? undefined)
  attacker.weaponId = weapon.id

  const dist = chebyshevDistance(
    attackerEntity.tx,
    attackerEntity.ty,
    defenderEntity.tx,
    defenderEntity.ty,
  )

  if (isStunWeapon(weapon, data.balance.combat)) {
    return resolveStunStrike({
      world,
      data,
      events,
      tick,
      rng,
      fight,
      attacker,
      defender,
      attackerEntity,
      defenderEntity,
      weapon,
      dist,
    })
  }

  if (isRangedWeapon(weapon, data.balance.combat)) {
    if (dist > weapon.range) {
      attacker.nextAttackTick = tick + TICKS_PER_MINUTE
      return 'continued'
    }
    const los = hasLineOfSight(
      attackerEntity.tx,
      attackerEntity.ty,
      defenderEntity.tx,
      defenderEntity.ty,
      (tx, ty) => {
        if (tx < 0 || ty < 0 || tx >= world.grid.size || ty >= world.grid.size) return true
        return isWall(world.grid, world.grid.idx(tx, ty))
      },
    )
    if (!los) {
      attacker.nextAttackTick = tick + TICKS_PER_MINUTE
      return 'continued'
    }
    const accuracy = rangedAccuracy(weapon.id, data.balance.combat)
    if (!rng.chance(accuracy)) {
      attacker.nextAttackTick =
        tick + rechargeTicks(weapon.rechargeMinutes, data.balance.time.ticksPerMinute)
      events.emit({
        tick,
        kind: COMBAT_EVENTS.attackMissed,
        subjectId: fight.id,
        causeIds: [],
        data: {
          fightId: fight.id,
          attackerKind: attacker.ref.kind,
          attackerId: attacker.ref.id,
          weaponId: weapon.id,
          accuracy,
        },
      })
      return 'continued'
    }
  } else if (dist > 1) {
    // Melee out of reach — wait a minute and try again.
    attacker.nextAttackTick = tick + TICKS_PER_MINUTE
    return 'continued'
  }

  // Defender disarm chance before the hit lands.
  const disarm = rollDisarm(defenderEntity.reputations, data.balance.combat, rng)
  if (disarm.disarmed && weapon.id !== data.balance.combat.defaultWeaponId) {
    removeWeaponFromInventory(attackerEntity, weapon.id)
    attacker.weaponId = data.balance.combat.defaultWeaponId
    events.emit({
      tick,
      kind: COMBAT_EVENTS.disarmed,
      subjectId: attacker.ref.id,
      causeIds: [],
      data: {
        fightId: fight.id,
        attackerKind: attacker.ref.kind,
        attackerId: attacker.ref.id,
        defenderKind: defender.ref.kind,
        defenderId: defender.ref.id,
        weaponId: weapon.id,
        chance: disarm.chance,
      },
    })
    attacker.nextAttackTick =
      tick + rechargeTicks(weapon.rechargeMinutes, data.balance.time.ticksPerMinute)
    return 'continued'
  }

  const kill = rollInstantKill(attackerEntity.reputations, data.balance.combat, rng)
  if (kill.killed) {
    events.emit({
      tick,
      kind: COMBAT_EVENTS.instantKill,
      subjectId: defender.ref.id,
      causeIds: [],
      data: {
        fightId: fight.id,
        attackerKind: attacker.ref.kind,
        attackerId: attacker.ref.id,
        defenderKind: defender.ref.kind,
        defenderId: defender.ref.id,
        chance: kill.chance,
        weaponId: weapon.id,
      },
    })
    killCombatant(world, data, events, tick, defender.ref, fight.id)
    endFight(world, events, tick, fight, 'death')
    return 'ended'
  }

  const damage = computeHitDamage({
    attackPower: weapon.attackPower,
    attackerReputations: attackerEntity.reputations,
    defenderReputations: defenderEntity.reputations,
    wearingVest: world.combat.wearingVest(defender.ref.kind, defender.ref.id),
    balance: data.balance.combat,
  })

  const applied = applyDamage(defenderEntity.health, damage, data.balance.combat)
  defenderEntity.health = applied.healthAfter
  attacker.nextAttackTick =
    tick + rechargeTicks(weapon.rechargeMinutes, data.balance.time.ticksPerMinute)

  if (applied.damage > 0 && data.balance.combat.bloodOnDamagingHit) {
    accrueBloodSpillDirt(world, data, world.grid.idx(defenderEntity.tx, defenderEntity.ty))
  }

  events.emit({
    tick,
    kind: COMBAT_EVENTS.damaged,
    subjectId: defender.ref.id,
    causeIds: [],
    data: {
      fightId: fight.id,
      attackerKind: attacker.ref.kind,
      attackerId: attacker.ref.id,
      defenderKind: defender.ref.kind,
      defenderId: defender.ref.id,
      weaponId: weapon.id,
      damage: applied.damage,
      healthAfter: applied.healthAfter,
      outcome: applied.outcome,
    },
  })

  if (applied.outcome === 'dead') {
    killCombatant(world, data, events, tick, defender.ref, fight.id)
    endFight(world, events, tick, fight, 'death')
    return 'ended'
  }

  if (applied.crossedIncap || applied.outcome === 'incapacitated') {
    ensureStatus(defenderEntity.status, 'bleeding')
    events.emit({
      tick,
      kind: COMBAT_EVENTS.incapacitated,
      subjectId: defender.ref.id,
      causeIds: [],
      data: {
        fightId: fight.id,
        defenderKind: defender.ref.kind,
        defenderId: defender.ref.id,
        health: applied.healthAfter,
      },
    })
    if (defender.ref.kind === 'inmate') {
      queueClinicEscort(world, data, events, tick, defender.ref.id)
    }
    // Fight continues until both are down, dead, or an officer intervenes —
    // but an incapacitated defender can no longer strike (checked above).
    if (
      isIncapacitated(attackerEntity.health, data.balance.combat) ||
      attackerEntity.status.includes('stunned')
    ) {
      endFight(world, events, tick, fight, 'incapacitated')
      return 'ended'
    }
  }

  return 'continued'
}

function resolveStunStrike(options: {
  readonly world: InmateWorld
  readonly data: GameData
  readonly events: EventSink
  readonly tick: number
  readonly rng: RngStream
  readonly fight: Fight
  readonly attacker: FightParticipant
  readonly defender: FightParticipant
  readonly attackerEntity: ResolvedCombatant
  readonly defenderEntity: ResolvedCombatant
  readonly weapon: ContrabandDef
  readonly dist: number
}): StrikeResult {
  const {
    world,
    data,
    events,
    tick,
    rng,
    fight,
    attacker,
    defender,
    attackerEntity,
    defenderEntity,
    weapon,
    dist,
  } = options
  const balance = data.balance.combat
  if (dist > weapon.range) {
    attacker.nextAttackTick = tick + TICKS_PER_MINUTE
    return 'continued'
  }

  if (attacker.ref.kind === 'staff') {
    const charges = world.combat.stunCharges.get(attacker.ref.id) ?? balance.stun.charges
    if (charges <= 0) {
      attacker.nextAttackTick = tick + TICKS_PER_MINUTE
      return 'continued'
    }
    world.combat.stunCharges.set(attacker.ref.id, charges - 1)
    if (charges - 1 <= 0) {
      world.combat.stunRechargeAt.set(
        attacker.ref.id,
        tick + balance.stun.rechargeMinutes * TICKS_PER_MINUTE,
      )
    }
  }

  const resist = rollStunResist(defenderEntity.reputations, balance, rng)
  attacker.nextAttackTick =
    tick + rechargeTicks(weapon.rechargeMinutes, data.balance.time.ticksPerMinute)

  if (resist.resisted) {
    events.emit({
      tick,
      kind: COMBAT_EVENTS.stunResisted,
      subjectId: defender.ref.id,
      causeIds: [],
      data: {
        fightId: fight.id,
        defenderId: defender.ref.id,
        chance: resist.chance,
      },
    })
    return 'continued'
  }

  ensureStatus(defenderEntity.status, 'stunned')
  events.emit({
    tick,
    kind: COMBAT_EVENTS.stunned,
    subjectId: defender.ref.id,
    causeIds: [],
    data: {
      fightId: fight.id,
      defenderKind: defender.ref.kind,
      defenderId: defender.ref.id,
      durationMinutes: balance.stun.durationMinutes,
    },
  })
  void attackerEntity
  endFight(world, events, tick, fight, 'stunned')
  return 'ended'
}

/* -------------------------------------------------------------------------- */
/* Intervention                                                                */
/* -------------------------------------------------------------------------- */

function progressInterventions(
  world: InmateWorld,
  data: GameData,
  events: EventSink,
  tick: number,
): void {
  const melee = data.balance.combat.intervention.meleeRangeTiles
  const movePerMinute = data.balance.combat.intervention.officerMoveTilesPerMinute
  // Advance distance once per minute of sim time so intervention scales with
  // path length without depending on pathfinding (stub until T4.6 routes).
  const onMinute = tick % TICKS_PER_MINUTE === 0

  for (const fight of world.combat.activeFights()) {
    const centre = fightCentre(world, fight)
    if (centre === undefined) {
      endFight(world, events, tick, fight, 'missing')
      continue
    }

    if (fight.interveningOfficerId === NO_STAFF) {
      const officer = findNearestIdleOfficer(world, data, centre.tx, centre.ty)
      if (officer === undefined) continue
      const dist = chebyshevDistance(officer.tx, officer.ty, centre.tx, centre.ty)
      fight.interveningOfficerId = officer.id
      fight.interventionTilesRemaining = dist
      officer.staff.duty = { kind: 'incident', tileIndex: world.grid.idx(centre.tx, centre.ty) }
      if (dist <= melee) {
        finishIntervention(world, events, tick, fight, officer)
      }
      continue
    }

    const officer = world.staff.get(fight.interveningOfficerId)
    if (officer === undefined) {
      fight.interveningOfficerId = NO_STAFF
      fight.interventionTilesRemaining = 0
      continue
    }

    if (onMinute && fight.interventionTilesRemaining > melee) {
      fight.interventionTilesRemaining = Math.max(
        melee,
        fight.interventionTilesRemaining - movePerMinute,
      )
    }

    if (fight.interventionTilesRemaining <= melee) {
      finishIntervention(world, events, tick, fight, officer)
    }
  }
}

function finishIntervention(
  world: InmateWorld,
  events: EventSink,
  tick: number,
  fight: Fight,
  officer: StaffEntity,
): void {
  for (const participant of fight.participants) {
    const entity = resolveCombatant(world, participant.ref)
    if (entity === undefined) continue
    ensureStatus(entity.status, 'surrendered')
  }
  events.emit({
    tick,
    kind: COMBAT_EVENTS.intervention,
    subjectId: fight.id,
    causeIds: [],
    data: {
      fightId: fight.id,
      officerId: officer.id,
      tilesTravelled: Math.max(0, fight.interventionTilesRemaining),
    },
  })
  if (officer.staff.duty.kind === 'incident') {
    officer.staff.duty = { kind: 'idle' }
  }
  endFight(world, events, tick, fight, 'intervention')
}

function findNearestIdleOfficer(
  world: InmateWorld,
  data: GameData,
  tx: number,
  ty: number,
): StaffEntity | undefined {
  let best: StaffEntity | undefined
  let bestDist = Number.POSITIVE_INFINITY
  for (const officer of world.staff.all()) {
    if (!hasCapability(data, officer, 'escort') && !hasCapability(data, officer, 'patrol')) {
      continue
    }
    if (officer.staff.duty.kind !== 'idle' && officer.staff.duty.kind !== 'wander') continue
    const dist = chebyshevDistance(officer.tx, officer.ty, tx, ty)
    if (dist < bestDist) {
      bestDist = dist
      best = officer
    }
  }
  return best
}

function fightCentre(world: InmateWorld, fight: Fight): { tx: number; ty: number } | undefined {
  const a = resolveCombatant(world, fight.participants[0].ref)
  const b = resolveCombatant(world, fight.participants[1].ref)
  if (a === undefined && b === undefined) return undefined
  if (a === undefined && b !== undefined) return { tx: b.tx, ty: b.ty }
  if (b === undefined && a !== undefined) return { tx: a.tx, ty: a.ty }
  if (a === undefined || b === undefined) return undefined
  return {
    tx: Math.floor((a.tx + b.tx) / 2),
    ty: Math.floor((a.ty + b.ty) / 2),
  }
}

/* -------------------------------------------------------------------------- */
/* Death / corpses                                                             */
/* -------------------------------------------------------------------------- */

function killCombatant(
  world: InmateWorld,
  data: GameData,
  events: EventSink,
  tick: number,
  ref: CombatantRef,
  fightId: number,
): void {
  const entity = resolveCombatant(world, ref)
  if (entity === undefined) return
  entity.health = 0
  const tileIndex = world.grid.idx(entity.tx, entity.ty)
  const corpse = world.combat.corpses.create({
    agentKind: ref.kind,
    agentId: ref.id,
    name: entity.name,
    tileIndex,
    diedAtTick: tick,
  })
  emitCorpseCreated(events, tick, corpse, [])
  world.contracts.progress.recordDeath(tick)
  if (ref.kind === 'staff') {
    world.morale.recordDeath(tick)
    world.morale.setInjured(ref.id, false)
  }

  const job = postJob({
    world,
    kind: 'collectRefuse',
    priority: data.balance.combat.mortuaryJobPriority,
    location: tileIndex,
    tick,
    events,
  })
  corpse.mortuaryJobId = job.id

  events.emit({
    tick,
    kind: COMBAT_EVENTS.died,
    subjectId: ref.id,
    causeIds: [],
    data: {
      agentKind: ref.kind,
      agentId: ref.id,
      fightId,
      corpseId: corpse.id,
      tileIndex,
      deathCount: world.contracts.progress.deathCount,
    },
  })

  if (ref.kind === 'inmate') {
    world.combat.overdoses.delete(ref.id)
    world.combat.clinicEscortQueued.delete(ref.id)
    world.inmates.remove(ref.id)
  } else {
    world.staff.remove(ref.id)
  }
}

function processCorpses(world: InmateWorld, data: GameData, events: EventSink, tick: number): void {
  // When the mortuary job completes, move the corpse to the mortuary and
  // schedule a hearse. Job completion is observed via job state.
  for (const corpse of world.combat.corpses.onSite()) {
    if (corpse.mortuaryJobId === 0) continue
    const job = world.jobs.get(corpse.mortuaryJobId)
    if (job === undefined || job.state !== 'completed') continue
    const hearseAt = tick + data.balance.combat.hearseDelayMinutes * TICKS_PER_MINUTE
    world.combat.corpses.markMortuary(corpse.id, hearseAt)
    const mortuaryTile = findMortuaryTile(world)
    if (mortuaryTile !== undefined) corpse.tileIndex = mortuaryTile
    events.emit({
      tick,
      kind: COMBAT_EVENTS.corpseToMortuary,
      subjectId: corpse.id,
      causeIds: [],
      data: { corpseId: corpse.id, hearseAtTick: hearseAt },
    })
  }

  for (const corpse of world.combat.corpses.awaitingHearse(tick)) {
    world.combat.corpses.markRemoved(corpse.id)
    events.emit({
      tick,
      kind: COMBAT_EVENTS.hearseDeparted,
      subjectId: corpse.id,
      causeIds: [],
      data: { corpseId: corpse.id, agentId: corpse.agentId, agentKind: corpse.agentKind },
    })
  }
}

/* -------------------------------------------------------------------------- */
/* Medics / overdose                                                           */
/* -------------------------------------------------------------------------- */

function medicHealPass(world: InmateWorld, data: GameData, events: EventSink, tick: number): void {
  const heal = data.balance.combat.medic.healPerMinute
  const range = data.balance.combat.medic.rangeTiles
  const medics = world.staff.all().filter((s) => hasCapability(data, s, 'treat'))
  if (medics.length === 0) return

  for (const inmate of world.inmates.all()) {
    if (inmate.inmate.health >= data.balance.combat.maxHealth) {
      clearStatus(inmate.inmate.status, 'bleeding')
      continue
    }
    const injured =
      inmate.inmate.health < data.balance.combat.maxHealth ||
      inmate.inmate.status.includes('bleeding') ||
      inmate.inmate.status.includes('overdosed')
    if (!injured) continue

    const medic = medics.find((m) => chebyshevDistance(m.tx, m.ty, inmate.tx, inmate.ty) <= range)
    if (medic === undefined) continue

    const before = inmate.inmate.health
    inmate.inmate.health = applyHeal(before, heal, data.balance.combat)
    if (inmate.inmate.status.includes('overdosed')) {
      clearStatus(inmate.inmate.status, 'overdosed')
      world.combat.overdoses.delete(inmate.id)
    }
    if (inmate.inmate.health >= data.balance.combat.incapHealthThreshold) {
      clearStatus(inmate.inmate.status, 'bleeding')
      world.combat.clinicEscortQueued.delete(inmate.id)
    }
    events.emit({
      tick,
      kind: COMBAT_EVENTS.healed,
      subjectId: inmate.id,
      causeIds: [],
      data: {
        inmateId: inmate.id,
        medicId: medic.id,
        healthBefore: before,
        healthAfter: inmate.inmate.health,
      },
    })
  }
}

function trackOverdoses(world: InmateWorld, data: GameData, events: EventSink, tick: number): void {
  for (const inmate of world.inmates.all()) {
    if (!inmate.inmate.status.includes('overdosed')) continue
    if (world.combat.overdoses.has(inmate.id)) continue
    beginOverdose(world, data, inmate.id, tick)
  }

  for (const timer of [...world.combat.overdoses.values()]) {
    if (tick < timer.fatalAtTick) continue
    const inmate = world.inmates.get(timer.inmateId)
    if (inmate === undefined) {
      world.combat.overdoses.delete(timer.inmateId)
      continue
    }
    // Still overdosed and untreated → fatal.
    if (!inmate.inmate.status.includes('overdosed')) {
      world.combat.overdoses.delete(timer.inmateId)
      continue
    }
    events.emit({
      tick,
      kind: COMBAT_EVENTS.overdoseFatal,
      subjectId: timer.inmateId,
      causeIds: [],
      data: {
        inmateId: timer.inmateId,
        untreatedMinutes: data.balance.combat.overdose.untreatedDeathMinutes,
      },
    })
    killCombatant(world, data, events, tick, { kind: 'inmate', id: timer.inmateId }, 0)
  }
}

function refillStunCharges(world: InmateWorld, data: GameData, tick: number): void {
  for (const [staffId, at] of [...world.combat.stunRechargeAt.entries()]) {
    if (tick < at) continue
    world.combat.stunCharges.set(staffId, data.balance.combat.stun.charges)
    world.combat.stunRechargeAt.delete(staffId)
  }
}

/* -------------------------------------------------------------------------- */
/* Fight lifecycle                                                             */
/* -------------------------------------------------------------------------- */

function endFight(
  world: InmateWorld,
  events: EventSink,
  tick: number,
  fight: Fight,
  reason: string,
): void {
  if (fight.state !== 'active') return
  fight.state = 'ended'
  if (fight.interveningOfficerId !== NO_STAFF) {
    const officer = world.staff.get(fight.interveningOfficerId)
    if (officer !== undefined && officer.staff.duty.kind === 'incident') {
      officer.staff.duty = { kind: 'idle' }
    }
  }
  events.emit({
    tick,
    kind: COMBAT_EVENTS.fightEnded,
    subjectId: fight.id,
    causeIds: [],
    data: { fightId: fight.id, reason },
  })
}

/* -------------------------------------------------------------------------- */
/* Combatant resolution                                                        */
/* -------------------------------------------------------------------------- */

interface ResolvedCombatant {
  readonly kind: CombatantKind
  readonly id: number
  readonly name: string
  readonly tx: number
  readonly ty: number
  health: number
  readonly reputations: readonly string[]
  readonly status: StatusEffectId[]
  readonly inventory: string[]
}

function resolveCombatant(world: InmateWorld, ref: CombatantRef): ResolvedCombatant | undefined {
  if (ref.kind === 'inmate') {
    const entity = world.inmates.get(ref.id)
    if (entity === undefined) return undefined
    return {
      kind: 'inmate',
      id: entity.id,
      name: entity.inmate.name,
      tx: entity.tx,
      ty: entity.ty,
      get health() {
        return entity.inmate.health
      },
      set health(value: number) {
        entity.inmate.health = value
      },
      reputations: entity.inmate.reputations.map((r) => r.id),
      status: entity.inmate.status,
      inventory: entity.inmate.inventory,
    }
  }
  const entity = world.staff.get(ref.id)
  if (entity === undefined) return undefined
  const healthKey = world.combat.agentKey('staff', entity.id)
  if (!world.combat.staffHealth.has(healthKey)) {
    world.combat.staffHealth.set(healthKey, world.data.balance.combat.maxHealth)
  }
  if (!world.combat.staffStatus.has(healthKey)) {
    world.combat.staffStatus.set(healthKey, [])
  }
  if (!world.combat.staffInventory.has(healthKey)) {
    world.combat.staffInventory.set(healthKey, [world.data.balance.combat.defaultWeaponId])
  }
  const status = world.combat.staffStatus.get(healthKey)
  const inventory = world.combat.staffInventory.get(healthKey)
  if (status === undefined || inventory === undefined) return undefined
  return {
    kind: 'staff',
    id: entity.id,
    name: entity.staff.name,
    tx: entity.tx,
    ty: entity.ty,
    get health() {
      return world.combat.staffHealth.get(healthKey) ?? world.data.balance.combat.maxHealth
    },
    set health(value: number) {
      world.combat.staffHealth.set(healthKey, value)
    },
    reputations: [],
    status,
    inventory,
  }
}

function removeWeaponFromInventory(entity: ResolvedCombatant, weaponId: string): void {
  const index = entity.inventory.indexOf(weaponId)
  if (index >= 0) entity.inventory.splice(index, 1)
}

function findClinicTile(world: InmateWorld): number | undefined {
  return firstRoomTile(world, 'clinic')
}

function findMortuaryTile(world: InmateWorld): number | undefined {
  return firstRoomTile(world, 'mortuary')
}

function firstRoomTile(world: InmateWorld, defId: string): number | undefined {
  for (const room of world.rooms.all()) {
    if (room.defId !== defId) continue
    const roomStatus = world.rooms.statusOf(room.id)
    if (roomStatus === undefined || !roomStatus.functional) continue
    if (room.tiles.length === 0) continue
    const tile = room.tiles[0]
    if (tile === undefined) continue
    return tile
  }
  return undefined
}

/** Exported for tests that need to inspect a corpse after death. */
export type { Corpse }
