/**
 * Capture a live `InmateWorld` into `SaveState` field snapshots (save v3).
 *
 * The grid itself is shared by reference into the returned state — callers that
 * need a detached snapshot should clone buffers before mutating further.
 */

import type { RngState } from '../core/rng'
import type { JsonObject } from '../core/commands'
import type { EconomySnapshot } from '../entities/economy'
import type { ContractBookSnapshot } from '../entities/contracts'
import type { InmateWorld } from '../systems/intakeSystem'
import { isSectorAccessMode } from '../world/sectors'
import type { UnfilledReason } from '../systems/postSystem'

import type {
  CombatStateSnapshot,
  ContrabandStateSnapshot,
  ContractState,
  EconomyState,
  EmergencyStateSnapshot,
  EscapesStateSnapshot,
  FireStateSnapshot,
  LogEntry,
  MapSettings,
  PostsState,
  PunishmentsStateSnapshot,
  RiotStateSnapshot,
  RoutineState,
  SectorsState,
  SerialisedEntity,
  SerialisedRoom,
  StandingOrdersState,
  UtilitiesStateSnapshot,
} from './format'
import type { SaveState } from './state'

export interface CaptureInmateWorldOptions {
  readonly seed: number
  readonly playedTicks: number
  readonly rngState: RngState
  readonly settings?: MapSettings
  readonly log?: readonly LogEntry[]
}

function asEconomyState(snapshot: EconomySnapshot): EconomyState {
  return {
    balance: snapshot.balance,
    loanPrincipal: snapshot.loanPrincipal,
    insolvencyDeadlineTick: snapshot.insolvencyDeadlineTick,
    insolvencyStartedTick: snapshot.insolvencyStartedTick ?? null,
    entries: snapshot.entries.map((entry) => ({ ...entry })),
  }
}

function asContractState(snapshot: ContractBookSnapshot): ContractState {
  return {
    active: snapshot.active.map((c) => ({
      defId: c.defId,
      acceptedTick: c.acceptedTick,
      advancePaid: c.advancePaid,
      itemPassed: [...c.itemPassed],
    })),
    finished: snapshot.finished.map((f) => ({ ...f })),
    revealed: [...snapshot.revealed],
  }
}

function captureSectors(world: InmateWorld): SectorsState {
  const snapshot = world.sectors.serialise()
  return {
    nextSectorId: snapshot.nextSectorId,
    sectors: snapshot.sectors.map((sector) => ({
      id: sector.id,
      name: sector.name,
      colour: sector.colour,
      access: isSectorAccessMode(sector.access) ? sector.access : 'shared',
      categories: [...sector.categories],
    })),
  }
}

function capturePosts(world: InmateWorld): PostsState {
  const snapshot = world.posts.serialise()
  return {
    nextPostId: snapshot.nextPostId,
    nextRouteId: snapshot.nextRouteId,
    posts: snapshot.posts.map((post) => ({
      id: post.id,
      name: post.name,
      sectorId: post.sectorId,
      objectId: post.objectId,
      staffRole: post.staffRole,
      count: post.count,
      timeWindows: post.timeWindows.map((w) => ({ ...w })),
      assigned: [...post.assigned],
      shortfallReason: post.shortfallReason,
      lastReportedTick: post.lastReportedTick,
    })),
    routes: snapshot.routes.map((route) => ({
      id: route.id,
      name: route.name,
      staffRole: route.staffRole,
      count: route.count,
      waypoints: [...route.waypoints],
      timeWindows: route.timeWindows.map((w) => ({ ...w })),
      assigned: [...route.assigned],
      shortfallReason: route.shortfallReason,
      lastReportedTick: route.lastReportedTick,
    })),
  }
}

/** Minimal entity snapshot so Phase 4 id references stay meaningful after load. */
function captureEntities(world: InmateWorld): readonly SerialisedEntity[] {
  const entities: SerialisedEntity[] = []

  for (const inmate of world.inmates.all()) {
    entities.push({
      id: inmate.id,
      kind: 'inmate',
      category: inmate.inmate.category,
      traits: [...inmate.inmate.traits],
      needs: Array.from(inmate.inmate.needs),
      health: inmate.inmate.health,
      cellId: inmate.inmate.cellId,
      inventory: [...inmate.inmate.inventory],
      money: inmate.inmate.money,
      suppression: inmate.inmate.suppression,
      accessMask: inmate.accessMask,
      tx: inmate.tx,
      ty: inmate.ty,
      x: inmate.x,
      y: inmate.y,
      name: inmate.inmate.name,
      portraitSeed: inmate.inmate.portraitSeed,
      sentenceHours: inmate.inmate.sentenceHours,
      servedHours: inmate.inmate.servedHours,
      entitlement: inmate.inmate.entitlement,
      aptitude: inmate.inmate.aptitude,
      reoffendChance: inmate.inmate.reoffendChance,
      grades: { ...inmate.inmate.grades },
      status: [...inmate.inmate.status],
      nextInmateId: world.inmates.nextId,
    })
  }

  for (const staff of world.staff.all()) {
    entities.push({
      id: staff.id,
      kind: 'staff',
      defId: staff.staff.defId,
      name: staff.staff.name,
      officeRoomId: staff.staff.officeRoomId,
      assignedAreaId: staff.staff.assignedAreaId,
      pinnedTile: staff.staff.pinnedTile,
      duty: { ...staff.staff.duty } as JsonObject,
      wanderCooldown: staff.staff.wanderCooldown,
      breakPending: staff.staff.breakPending,
      breakCooldownMinutes: staff.staff.breakCooldownMinutes,
      needs: Array.from(staff.staff.needs),
      tx: staff.tx,
      ty: staff.ty,
      x: staff.x,
      y: staff.y,
      nextStaffId: world.staff.nextId,
    })
  }

  for (const object of world.objects.all()) {
    entities.push({
      id: object.id,
      kind: 'object',
      tileIndex: object.tileIndex,
      tx: object.tx,
      ty: object.ty,
      defId: object.object.defId,
      rotation: object.object.rotation,
      roomId: object.object.roomId,
      hasPower: object.object.hasPower,
      hasWater: object.object.hasWater,
      hp: object.object.hp,
      tiles: [...object.object.tiles],
      footprint: { ...object.object.footprint },
      nextObjectId: world.objects.nextId,
    })
  }

  return entities
}

function captureRooms(world: InmateWorld): {
  readonly rooms: readonly SerialisedRoom[]
  readonly nextRoomId: number
} {
  return {
    nextRoomId: world.rooms.nextId,
    rooms: world.rooms.all().map((room) => ({
      id: room.id,
      defId: room.defId,
      tiles: [...room.tiles],
      bounds: { ...room.bounds },
      properties: { ...room.properties },
    })),
  }
}

/**
 * Builds save-state fields from a live world.
 *
 * Does not touch the clock or RNG — those are owned by `Simulation` and passed
 * in by the caller.
 */
export function captureInmateWorld(
  world: InmateWorld,
  options: CaptureInmateWorldOptions,
): SaveState {
  const rooms = captureRooms(world)
  const fire: FireStateSnapshot = { ...world.fire.serialise() }
  const riot: RiotStateSnapshot = { ...world.riot.serialise() }
  const emergency: EmergencyStateSnapshot = { ...world.emergency.serialise() }
  const escapeSnap = world.escapes.serialise()
  const escapes: EscapesStateSnapshot = {
    nextTunnelId: escapeSnap.nextTunnelId,
    tunnels: escapeSnap.tunnels.map((tunnel) => ({
      id: tunnel.id,
      originTile: tunnel.originTile,
      tiles: [...tunnel.tiles],
      diggerIds: [...tunnel.diggerIds],
      discovered: tunnel.discovered,
      progress: tunnel.progress,
      reachedExit: tunnel.reachedExit,
      networkId: tunnel.networkId,
    })),
    breachedDoorTiles: [...escapeSnap.breachedDoorTiles],
    pendingEscapes: escapeSnap.pendingEscapes.map((pending) => ({
      networkId: pending.networkId,
      inmateIds: [...pending.inmateIds],
      remainingIds: [...pending.remainingIds],
    })),
    escapesToday: escapeSnap.escapesToday,
    escapesYesterday: escapeSnap.escapesYesterday,
    accountedDay: escapeSnap.accountedDay,
    warningActive: escapeSnap.warningActive,
    failed: escapeSnap.failed,
    totalEscapes: escapeSnap.totalEscapes,
  }
  const combatSnap = world.combat.serialise()
  const combat: CombatStateSnapshot = {
    nextFightId: combatSnap.nextFightId,
    fights: combatSnap.fights.map((fight) => ({
      id: fight.id,
      state: fight.state,
      startedAtTick: fight.startedAtTick,
      interveningOfficerId: fight.interveningOfficerId,
      interventionTilesRemaining: fight.interventionTilesRemaining,
      participants: fight.participants.map((p) => ({ ...p })),
    })),
    corpses: {
      nextId: combatSnap.corpses.nextId,
      list: combatSnap.corpses.list.map((c) => ({ ...c })),
    },
    vestWearers: [...combatSnap.vestWearers],
    stunCharges: combatSnap.stunCharges.map((e) => ({ ...e })),
    stunRechargeAt: combatSnap.stunRechargeAt.map((e) => ({ ...e })),
    overdoses: combatSnap.overdoses.map((e) => ({ ...e })),
    clinicEscortQueued: [...combatSnap.clinicEscortQueued],
    staffHealth: combatSnap.staffHealth.map((e) => ({ ...e })),
    staffStatus: combatSnap.staffStatus.map((e) => ({
      key: e.key,
      status: [...e.status],
    })),
    staffInventory: combatSnap.staffInventory.map((e) => ({
      key: e.key,
      inventory: [...e.inventory],
    })),
  }
  const punishmentSnap = world.punishments.serialise()
  const punishments: PunishmentsStateSnapshot = {
    active: punishmentSnap.active.map((p) => ({ ...p })),
    agitatorBoostUntil: punishmentSnap.agitatorBoostUntil.map((e) => ({ ...e })),
  }
  const contrabandSnap = world.contraband.serialise()
  const contraband: ContrabandStateSnapshot = {
    nextStashId: contrabandSnap.nextStashId,
    nextThrowInId: contrabandSnap.nextThrowInId,
    confiscatedCount: contrabandSnap.confiscatedCount,
    pendingArrivalIds: [...contrabandSnap.pendingArrivalIds],
    pendingDeliveryLines: contrabandSnap.pendingDeliveryLines.map((l) => ({ ...l })),
    stashes: contrabandSnap.stashes.map((s) => ({ ...s })),
    throwIns: contrabandSnap.throwIns.map((t) => ({ ...t })),
    prices: contrabandSnap.prices.map((p) => ({ ...p })),
  }

  const cableTiles: number[] = []
  for (let i = 0; i < world.power.hasCable.length; i += 1) {
    if ((world.power.hasCable[i] ?? 0) !== 0) cableTiles.push(i)
  }
  const pipeTiles: number[] = []
  for (let i = 0; i < world.water.hasPipe.length; i += 1) {
    if ((world.water.hasPipe[i] ?? 0) !== 0) pipeTiles.push(i)
  }
  const utilities: UtilitiesStateSnapshot = { cableTiles, pipeTiles }

  const standing = {
    misconduct: Object.fromEntries(
      Object.entries(world.standingOrders.misconduct).map(([kind, order]) => [
        kind,
        {
          punishment: order.punishment,
          durationHours: order.durationHours,
          search: order.search,
        },
      ]),
    ),
    reassignmentStrictness: world.standingOrders.reassignmentStrictness,
    mealQuantity: world.standingOrders.mealQuantity,
    mealVariety: world.standingOrders.mealVariety,
  } as StandingOrdersState

  return {
    seed: options.seed,
    playedTicks: options.playedTicks,
    settings: options.settings ?? {},
    grid: world.grid,
    entities: captureEntities(world),
    rooms: rooms.rooms,
    nextRoomId: rooms.nextRoomId,
    sectors: captureSectors(world),
    economy: asEconomyState(world.economy.serialise()),
    directorate: world.directorate.serialise(),
    grading: {
      ...world.grading.serialise(),
      averageCellGrade: world.averageCellGrade,
    },
    programs: world.programs.serialise(),
    grades: world.grades.serialise(),
    parole: world.parole.serialise(),
    release: world.release.serialise(),
    intelligence: world.intelligence.serialise(),
    contracts: asContractState(world.contracts.serialise()),
    routines: world.routines.toJSON() as RoutineState,
    standingOrders: standing,
    posts: capturePosts(world),
    contraband,
    fire,
    riot,
    emergency,
    escapes,
    combat,
    punishments,
    utilities,
    dangerLevel: world.dangerLevel,
    riotActive: world.riotActive,
    lockdownActive: world.lockdownActive,
    misconductWindowTicks: world.misconductWindow.serialise(),
    log: options.log ?? [],
    rngState: options.rngState,
  }
}

/** Narrow helper used when restoring post shortfall reasons from JSON. */
export function parseUnfilledReason(value: string | null): UnfilledReason | null {
  if (value === 'no-staff-hired' || value === 'all-staff-busy' || value === 'unreachable') {
    return value
  }
  return null
}
