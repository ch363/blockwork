/**
 * Empty / default Phase 4 save fields for migrations and fixtures.
 */

import { loadGameData } from '../data/loader'
import type { GameData } from '../data/loader'
import { createDefaultStandingOrders } from '../entities/standingOrders'

import type {
  CellGradesStateSnapshot,
  CleaningStateSnapshot,
  CombatStateSnapshot,
  ConstructionStateSnapshot,
  ContrabandStateSnapshot,
  ContractState,
  DeliveriesStateSnapshot,
  DoorsStateSnapshot,
  DirectorateStateSnapshot,
  EconomyState,
  EmergencyStateSnapshot,
  EntityRegistryState,
  EscapesStateSnapshot,
  EscortsStateSnapshot,
  FireStateSnapshot,
  FogStateSnapshot,
  GradingStateSnapshot,
  ProgramsStateSnapshot,
  ParoleStateSnapshot,
  ReleaseStateSnapshot,
  GradesStateSnapshot,
  IntelligenceStateSnapshot,
  IntakeStateSnapshot,
  JobsStateSnapshot,
  LabourStateSnapshot,
  LaundryStateSnapshot,
  MealsStateSnapshot,
  MoraleStateSnapshot,
  NeedsRuntimeStateSnapshot,
  OfficesStateSnapshot,
  PostsState,
  PunishmentsStateSnapshot,
  RiotStateSnapshot,
  RoutineRuntimeStateSnapshot,
  SectorsState,
  StandingOrdersState,
  SupplyStateSnapshot,
  UtilitiesStateSnapshot,
} from './format'

export function emptySectorsState(): SectorsState {
  return { nextSectorId: 1, sectors: [] }
}

export function emptyPostsState(): PostsState {
  return { nextPostId: 1, nextRouteId: 1, posts: [], routes: [] }
}

export function emptyEconomyState(): EconomyState {
  return {
    balance: 0,
    loanPrincipal: 0,
    insolvencyDeadlineTick: null,
    insolvencyStartedTick: null,
    entries: [],
  }
}

export function emptyContractState(): ContractState {
  return { active: [], finished: [], revealed: [] }
}

/** No grades computed and no entitlement earned (T5.2). */
export function emptyGradingState(): GradingStateSnapshot {
  return { roomGrades: [], lastEntitlementTick: [], averageCellGrade: 0 }
}

/** Nobody enrolled, nothing completed, nothing pinned (T5.3). */
export function emptyProgramsState(): ProgramsStateSnapshot {
  return { enrolments: [], completions: [], pins: [] }
}

/** No confinement served yet (T5.4). */
export function emptyGradesState(): GradesStateSnapshot {
  return { confinement: [] }
}

/** Nobody eligible and no hearings sat (T5.4). */
export function emptyParoleState(): ParoleStateSnapshot {
  return { queue: [], hearingsToday: 0, hearingDay: 0 }
}

/** Nobody released and nobody re-offended (T5.4). */
export function emptyReleaseState(): ReleaseStateSnapshot {
  return {
    released: [],
    lifetimeReleased: 0,
    lifetimeReoffended: 0,
    paroleReoffences: [],
    recidivismWarned: false,
  }
}

/** No informants recruited and nothing revealed (T5.6). */
export function emptyIntelligenceState(): IntelligenceStateSnapshot {
  return {
    informants: [],
    revealedStashIds: [],
    revealedThrowInIds: [],
    lastBlowRollDay: -1,
  }
}

/** No research bought and none in progress (T5.1). */
export function emptyDirectorateState(): DirectorateStateSnapshot {
  return { completed: [], active: [] }
}

export function emptyContrabandState(): ContrabandStateSnapshot {
  return {
    nextStashId: 1,
    nextThrowInId: 1,
    confiscatedCount: 0,
    pendingArrivalIds: [],
    pendingDeliveryLines: [],
    stashes: [],
    throwIns: [],
    prices: [],
  }
}

export function emptyFireState(size: number): FireStateSnapshot {
  return { size, burning: [], smoke: [], overloadedBranches: [] }
}

export function emptyRiotState(): RiotStateSnapshot {
  return {
    active: false,
    riotingInmateIds: [],
    quietMinutes: 0,
    startedAtTick: 0,
    doorBreakProgress: [],
  }
}

export function emptyEmergencyState(): EmergencyStateSnapshot {
  return {
    sectorLockdowns: [],
    fullLockdown: false,
    riotSquadActive: false,
    riotSquadStaffIds: [],
    freeFireActive: false,
    freeFirePenaltiesApplied: false,
    nationalGuardActive: false,
    nationalGuardStaffIds: [],
    playerFired: false,
    riotFailureEnabled: true,
    warningAtTick: null,
    failureAtTick: null,
    warningEmitted: false,
    failed: false,
    prPenalty: 0,
    riotSquadLastWageTick: 0,
  }
}

export function emptyEscapesState(): EscapesStateSnapshot {
  return {
    nextTunnelId: 1,
    tunnels: [],
    breachedDoorTiles: [],
    pendingEscapes: [],
    escapesToday: 0,
    escapesYesterday: 0,
    accountedDay: 1,
    warningActive: false,
    failed: false,
    totalEscapes: 0,
  }
}

export function emptyCombatState(): CombatStateSnapshot {
  return {
    nextFightId: 1,
    fights: [],
    corpses: { nextId: 1, list: [] },
    vestWearers: [],
    stunCharges: [],
    stunRechargeAt: [],
    overdoses: [],
    clinicEscortQueued: [],
    staffHealth: [],
    staffStatus: [],
    staffInventory: [],
  }
}

export function emptyPunishmentsState(): PunishmentsStateSnapshot {
  return { active: [], agitatorBoostUntil: [] }
}

export function emptyUtilitiesState(): UtilitiesStateSnapshot {
  return { cableTiles: [], pipeTiles: [], shedBranches: [], waterMultipliers: [] }
}

export function emptyEntityRegistryState(): EntityRegistryState {
  return { nextInmateId: 1, nextStaffId: 1, nextObjectId: 1, staffHireCounts: [] }
}

export function emptyDoorsState(): DoorsStateSnapshot {
  return { doors: [] }
}

export function emptyConstructionState(): ConstructionStateSnapshot {
  return { nextSiteId: 1, sites: [], spendOwed: 0, refundsOwed: 0 }
}

export function emptyIntakeState(): IntakeStateSnapshot {
  return { continuous: true, nextBusAtTick: 0, requestedCounts: [] }
}

export function emptyCellGradesState(): CellGradesStateSnapshot {
  return { grades: [] }
}

export function emptyFogState(): FogStateSnapshot {
  return { revealedTiles: [] }
}

export function emptyOfficesState(): OfficesStateSnapshot {
  return { claims: [] }
}

export function emptyEscortsState(): EscortsStateSnapshot {
  return { nextId: 1, jobs: [] }
}

export function emptyJobsState(): JobsStateSnapshot {
  return { nextId: 1, jobs: [] }
}

export function emptyLabourState(): LabourStateSnapshot {
  return {
    assignments: [],
    workerMinutes: [],
    finishedGoods: [],
    groveMinutes: [],
    grownTrees: [],
    commissaryGoods: 0,
    lifetimeExportIncome: 0,
    lifetimeCommissaryIncome: 0,
  }
}

export function emptyMoraleState(): MoraleStateSnapshot {
  return {
    value: 100,
    wageMultiplier: 1,
    lastDangerContribution: 0,
    deaths: [],
    injured: [],
    strike: {
      phase: 'none',
      endsAtTick: 0,
      cooldownUntilTick: 0,
      refuseCount: 0,
      payDemandOpen: false,
      demandedRaise: 0,
    },
    hasStruckBefore: false,
  }
}

export function emptyNeedsRuntimeState(): NeedsRuntimeStateSnapshot {
  return { inmates: [] }
}

export function emptyRoutineRuntimeState(): RoutineRuntimeStateSnapshot {
  return { inmates: [] }
}

export function emptyMealsState(): MealsStateSnapshot {
  return {
    standingOrders: { quantity: 'normal', variety: 1 },
    missedMeals: 0,
    mealsServed: 0,
    routingOverrides: [],
    fridgeStock: [],
    counterMeals: [],
    dirtyTrays: [],
    refuseStock: [],
    prepSessions: [],
  }
}

export function emptySupplyState(): SupplyStateSnapshot {
  return {
    nextOrderId: 1,
    orders: [],
    dockFree: [],
    dockReserved: [],
    storeStock: [],
    binRefuse: [],
    refuseZone: [],
    carries: [],
  }
}

export function emptyDeliveriesState(): DeliveriesStateSnapshot {
  return { nextTruckId: 1, nextTruckAt: 0, pending: [], scheduled: [] }
}

export function emptyCleaningState(): CleaningStateSnapshot {
  return { cleanRemainder: 0, noCleanersNotified: false, dirtRemoved: 0 }
}

export function emptyLaundryState(): LaundryStateSnapshot {
  return {
    uniformsDistributed: 0,
    lastAccrualDay: 0,
    routingOverrides: [],
    uniformDirtiness: [],
    bedDirty: [],
    basketDirty: [],
    pendingWash: [],
    washedReady: [],
    ironedReady: [],
    bedClean: [],
  }
}

export function defaultStandingOrdersState(data: GameData = loadGameData()): StandingOrdersState {
  const defaults = createDefaultStandingOrders(data)
  return {
    misconduct: Object.fromEntries(
      Object.entries(defaults.misconduct).map(([kind, order]) => [
        kind,
        {
          punishment: order.punishment,
          durationHours: order.durationHours,
          search: order.search,
        },
      ]),
    ),
    reassignmentStrictness: defaults.reassignmentStrictness,
    mealQuantity: defaults.mealQuantity,
    mealVariety: defaults.mealVariety,
  } as StandingOrdersState
}
