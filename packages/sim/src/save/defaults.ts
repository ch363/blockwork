/**
 * Empty / default Phase 4 save fields for migrations and fixtures.
 */

import { createDefaultStandingOrders } from '../entities/standingOrders'

import type {
  CombatStateSnapshot,
  ContrabandStateSnapshot,
  ContractState,
  DirectorateStateSnapshot,
  EconomyState,
  EmergencyStateSnapshot,
  EscapesStateSnapshot,
  FireStateSnapshot,
  GradingStateSnapshot,
  ProgramsStateSnapshot,
  ParoleStateSnapshot,
  ReleaseStateSnapshot,
  GradesStateSnapshot,
  IntelligenceStateSnapshot,
  PostsState,
  PunishmentsStateSnapshot,
  RiotStateSnapshot,
  SectorsState,
  StandingOrdersState,
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
    staffHealth: [],
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
  return { cableTiles: [], pipeTiles: [] }
}

export function defaultStandingOrdersState(): StandingOrdersState {
  const defaults = createDefaultStandingOrders()
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
