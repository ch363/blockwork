/**
 * Capture a live `InmateWorld` into `SaveState` (save v5).
 *
 * The grid itself is shared by reference into the returned state — callers that
 * need a detached snapshot should clone buffers before mutating further.
 */

import type { RngState } from '../core/rng'
import type { EconomySnapshot } from '../entities/economy'
import type { ContractBookSnapshot } from '../entities/contracts'
import type { InmateEntity } from '../entities/inmate'
import type { InmateWorld } from '../systems/intakeSystem'
import { isSectorAccessMode } from '../world/sectors'
import type { UnfilledReason } from '../systems/postSystem'

import type {
  CellGradesStateSnapshot,
  CleaningStateSnapshot,
  CombatStateSnapshot,
  ConstructionStateSnapshot,
  ContrabandStateSnapshot,
  ContractState,
  DeliveriesStateSnapshot,
  DoorsStateSnapshot,
  EconomyState,
  EmergencyStateSnapshot,
  EntityRegistryState,
  EscapesStateSnapshot,
  EscortsStateSnapshot,
  FireStateSnapshot,
  FogStateSnapshot,
  GradingStateSnapshot,
  IntakeStateSnapshot,
  JobsStateSnapshot,
  LabourStateSnapshot,
  LaundryStateSnapshot,
  LogEntry,
  MapSettings,
  MealsStateSnapshot,
  MoraleStateSnapshot,
  NeedsRuntimeStateSnapshot,
  OfficesStateSnapshot,
  PostsState,
  PunishmentsStateSnapshot,
  RiotStateSnapshot,
  RoutineRuntimeStateSnapshot,
  RoutineState,
  SectorsState,
  SerialisedEntity,
  SerialisedInmateEntity,
  SerialisedObjectEntity,
  SerialisedRoom,
  SerialisedStaffDuty,
  SerialisedStaffEntity,
  StandingOrdersState,
  SupplyStateSnapshot,
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

function captureInmate(entity: InmateEntity): SerialisedInmateEntity {
  const inmate = entity.inmate
  return {
    id: entity.id,
    kind: 'inmate',
    name: inmate.name,
    portraitSeed: inmate.portraitSeed,
    category: inmate.category,
    convictions: inmate.convictions.map((c) => ({ id: c.id, years: c.years })),
    sentenceHours: inmate.sentenceHours,
    servedHours: inmate.servedHours,
    traits: [...inmate.traits],
    reputations: inmate.reputations.map((r) => ({ id: r.id, revealed: r.revealed })),
    needs: Array.from(inmate.needs),
    addictions: inmate.addictions.map((a) => ({ substance: a.substance, strength: a.strength })),
    suppression: inmate.suppression,
    entitlement: inmate.entitlement,
    cellId: inmate.cellId,
    jobId: inmate.jobId,
    misconductLog: inmate.misconductLog.map((entry) => ({
      tick: entry.tick,
      kind: entry.kind,
      punishment: entry.punishment,
      durationHours: entry.durationHours,
    })),
    grades: { ...inmate.grades },
    reoffendChance: inmate.reoffendChance,
    status: [...inmate.status],
    health: inmate.health,
    inventory: [...inmate.inventory],
    money: inmate.money,
    aptitude: inmate.aptitude,
    x: entity.x,
    y: entity.y,
    tx: entity.tx,
    ty: entity.ty,
    accessMask: entity.accessMask,
  }
}

function captureStaff(entity: ReturnType<InmateWorld['staff']['get']> & object): SerialisedStaffEntity {
  return {
    id: entity.id,
    kind: 'staff',
    defId: entity.staff.defId,
    name: entity.staff.name,
    officeRoomId: entity.staff.officeRoomId,
    assignedAreaId: entity.staff.assignedAreaId,
    pinnedTile: entity.staff.pinnedTile,
    duty: { ...entity.staff.duty } as SerialisedStaffDuty,
    wanderCooldown: entity.staff.wanderCooldown,
    breakPending: entity.staff.breakPending,
    breakCooldownMinutes: entity.staff.breakCooldownMinutes,
    needs: Array.from(entity.staff.needs),
    x: entity.x,
    y: entity.y,
    tx: entity.tx,
    ty: entity.ty,
  }
}

function captureObject(entity: ReturnType<InmateWorld['objects']['get']> & object): SerialisedObjectEntity {
  return {
    id: entity.id,
    kind: 'object',
    tileIndex: entity.tileIndex,
    tx: entity.tx,
    ty: entity.ty,
    defId: entity.object.defId,
    rotation: entity.object.rotation,
    roomId: entity.object.roomId,
    hasPower: entity.object.hasPower,
    hasWater: entity.object.hasWater,
    hp: entity.object.hp,
    tiles: [...entity.object.tiles],
    footprint: { ...entity.object.footprint },
  }
}

function captureEntities(world: InmateWorld): readonly SerialisedEntity[] {
  const entities: SerialisedEntity[] = []
  for (const inmate of world.inmates.all()) entities.push(captureInmate(inmate))
  for (const staff of world.staff.all()) entities.push(captureStaff(staff))
  for (const object of world.objects.all()) entities.push(captureObject(object))
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

function captureUtilities(world: InmateWorld): UtilitiesStateSnapshot {
  const cableTiles: number[] = []
  for (let i = 0; i < world.power.hasCable.length; i += 1) {
    if ((world.power.hasCable[i] ?? 0) !== 0) cableTiles.push(i)
  }
  const pipeTiles: number[] = []
  for (let i = 0; i < world.water.hasPipe.length; i += 1) {
    if ((world.water.hasPipe[i] ?? 0) !== 0) pipeTiles.push(i)
  }
  return {
    cableTiles,
    pipeTiles,
    shedBranches: [...world.power.shedBranches].sort((a, b) => a - b),
    waterMultipliers: [...world.water.useMultiplierByBranch.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([branchId, multiplier]) => ({ branchId, multiplier })),
  }
}

function captureFog(world: InmateWorld): FogStateSnapshot {
  const revealedTiles: number[] = []
  for (let i = 0; i < world.fog.revealed.length; i += 1) {
    if (world.fog.revealed[i] === 1) revealedTiles.push(i)
  }
  return { revealedTiles }
}

function captureLaundry(world: InmateWorld): LaundryStateSnapshot {
  const mapEntries = (map: Map<number, number>): readonly { readonly key: number; readonly value: number }[] =>
    [...map.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([key, value]) => ({ key, value: Math.round(value) }))
  return {
    uniformsDistributed: world.laundry.uniformsDistributed,
    lastAccrualDay: world.laundry.lastAccrualDay,
    routingOverrides: [...world.laundry.routingOverrides.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([laundryId, housingId]) => ({ laundryId, housingId })),
    uniformDirtiness: mapEntries(world.laundry.uniformDirtiness),
    bedDirty: mapEntries(world.laundry.bedDirty),
    basketDirty: mapEntries(world.laundry.basketDirty),
    pendingWash: mapEntries(world.laundry.pendingWash),
    washedReady: mapEntries(world.laundry.washedReady),
    ironedReady: mapEntries(world.laundry.ironedReady),
    bedClean: mapEntries(world.laundry.bedClean),
  }
}

function captureCellGrades(world: InmateWorld): CellGradesStateSnapshot {
  return {
    grades: [...world.cellGrades.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([roomId, grade]) => ({ roomId, grade })),
  }
}

function captureIntake(world: InmateWorld): IntakeStateSnapshot {
  return {
    continuous: world.intake.continuous,
    nextBusAtTick: world.intake.nextBusAtTick,
    requestedCounts: [...world.intake.requestedCounts.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([category, count]) => ({ category, count })),
  }
}

function captureConstruction(world: InmateWorld): ConstructionStateSnapshot {
  const queueSnap = world.sites.serialise()
  return {
    nextSiteId: queueSnap.nextId,
    sites: queueSnap.sites.map((site) => ({ ...site })),
    spendOwed: world.spendOwed,
    refundsOwed: world.refundsOwed,
  }
}

function captureDoors(world: InmateWorld): DoorsStateSnapshot {
  return { doors: world.doors.serialise() }
}

function captureEntityRegistry(world: InmateWorld): EntityRegistryState {
  return {
    nextInmateId: world.inmates.nextId,
    nextStaffId: world.staff.nextId,
    nextObjectId: world.objects.nextId,
    staffHireCounts: world.staff.serialiseHireCounts(),
  }
}

function captureOffices(world: InmateWorld): OfficesStateSnapshot {
  return {
    claims: world.offices.all().map((claim) => ({
      roomId: claim.roomId,
      staffId: claim.staffId,
      displayName: claim.displayName,
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

  const labourSnap = world.labour.serialise()
  const labour: LabourStateSnapshot = { ...labourSnap }
  const moraleSnap = world.morale.serialise()
  const morale: MoraleStateSnapshot = {
    value: moraleSnap.value,
    wageMultiplier: moraleSnap.wageMultiplier,
    lastDangerContribution: moraleSnap.lastDangerContribution,
    deaths: [...moraleSnap.deaths],
    injured: [...moraleSnap.injured],
    strike: {
      phase: moraleSnap.strike.phase,
      endsAtTick: moraleSnap.strike.endsAtTick,
      cooldownUntilTick: moraleSnap.strike.cooldownUntilTick,
      refuseCount: moraleSnap.strike.refuseCount,
      payDemandOpen: moraleSnap.strike.payDemandOpen,
      demandedRaise: moraleSnap.strike.demandedRaise,
    },
    hasStruckBefore: moraleSnap.hasStruckBefore,
  }
  const needsSnap = world.needsRuntime.serialise()
  const needsRuntime: NeedsRuntimeStateSnapshot = { ...needsSnap }
  const routineSnap = world.routineRuntime.serialise()
  const routineRuntime: RoutineRuntimeStateSnapshot = { ...routineSnap }
  const jobsSnap = world.jobs.serialise()
  const jobs: JobsStateSnapshot = {
    nextId: jobsSnap.nextId,
    jobs: jobsSnap.jobs.map((job) => ({ ...job })),
  }
  const mealsSnap = world.meals.serialise()
  const meals: MealsStateSnapshot = {
    ...mealsSnap,
    prepSessions: mealsSnap.prepSessions.map((session) => ({ ...session })),
  }
  const supplySnap = world.supply.serialise()
  const supply: SupplyStateSnapshot = {
    nextOrderId: supplySnap.nextOrderId,
    orders: supplySnap.orders.map((order) => ({ ...order })),
    dockFree: [...supplySnap.dockFree],
    dockReserved: supplySnap.dockReserved.map((entry) => ({
      siteId: entry.siteId,
      stock: [...entry.stock],
    })),
    storeStock: [...supplySnap.storeStock],
    binRefuse: [...supplySnap.binRefuse],
    refuseZone: [...supplySnap.refuseZone],
    carries: supplySnap.carries.map((mission) => ({ ...mission })),
  }
  const deliveriesSnap = world.deliveries.serialise()
  const deliveries: DeliveriesStateSnapshot = {
    nextTruckId: deliveriesSnap.nextTruckId,
    nextTruckAt: deliveriesSnap.nextTruckAt,
    pending: deliveriesSnap.pending.map((line) => ({ ...line })),
    scheduled: deliveriesSnap.scheduled.map((truck) => ({
      id: truck.id,
      arriveTick: truck.arriveTick,
      refuseUnits: truck.refuseUnits,
      lines: truck.lines.map((line) => ({ ...line })),
    })),
  }
  const escorts: EscortsStateSnapshot = { ...world.escorts.serialise() }

  const settings: MapSettings =
    options.settings ??
    ({
      staffNeeds: world.settings.staffNeeds,
      firstOrderGrace: world.settings.firstOrderGrace,
      randomEvents: world.settings.randomEvents,
      failures: { ...world.settings.failures },
      mutators: { ...world.settings.mutators },
    } as MapSettings)

  return {
    seed: options.seed,
    playedTicks: options.playedTicks,
    settings,
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
    } satisfies GradingStateSnapshot,
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
    utilities: captureUtilities(world),
    entityRegistry: captureEntityRegistry(world),
    doors: captureDoors(world),
    construction: captureConstruction(world),
    intake: captureIntake(world),
    cellGrades: captureCellGrades(world),
    incomeOwed: world.incomeOwed,
    staffOnlyRoomIds: [...world.staffOnlyRoomIds].sort((a, b) => a - b),
    intakeSearchedInmateIds: [...world.intakeSearchedInmateIds].sort((a, b) => a - b),
    staffNeedsEnabled: world.settings.staffNeeds,
    fog: captureFog(world),
    offices: captureOffices(world),
    escorts,
    jobs,
    labour,
    morale,
    needsRuntime,
    routineRuntime,
    meals,
    supply,
    deliveries,
    cleaning: {
      cleanRemainder: world.cleaning.cleanRemainder,
      noCleanersNotified: world.cleaning.noCleanersNotified,
      dirtRemoved: world.cleaning.dirtRemoved,
    } satisfies CleaningStateSnapshot,
    laundry: captureLaundry(world),
    dangerLevel: Math.round(Math.min(100, Math.max(0, world.dangerLevel))),
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
