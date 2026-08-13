/**
 * The save format (PRD 7.4): what a `.blockwork` file contains and how its
 * bytes are laid out.
 *
 * Two versions live here and they are deliberately separate.
 *
 *   - `SAVE_CONTAINER_VERSION` versions the *envelope*: the magic number, the
 *     header fields, the compression. It changes when the bytes around the
 *     payload change, which should be almost never.
 *   - `CURRENT_SAVE_VERSION` versions the *payload*, the `SaveFile` object.
 *     It is the number the migration chain walks, and it moves whenever a
 *     system changes the shape of what it stores.
 *
 * Splitting them means a reader can decide whether it understands a file, and
 * which migrations it must run, without decompressing a megabyte first. It
 * also means a payload migration never has to care about compression.
 *
 * v3 wires Phase 4 live registries (sectors, posts, standing orders, fire,
 * riot, emergency, escapes, contraband, combat, punishments) and replaces the
 * opaque stubs that shipped with the save skeleton.
 */

import type { JsonObject } from '../core/commands'
import type { SectorAccessMode } from '../data/schemas'
import type { TileField } from '../world/tileGrid'

/**
 * The payload schema version this build writes and migrates towards.
 *
 * v1 was the format at T0.6. v2 is identical to it (chain bootstrap). v3
 * replaces opaque Phase 4 stubs with live registry snapshots. v4 adds the
 * Phase 5 state: Directorate research, room grades and entitlement,
 * programmes, parole and the release ledger. v5 covers the live world
 * runtimes `InmateWorld.hashInto` treats as authoritative (labour, morale,
 * logistics, inmate history, fog, intake policy, and the rest of T8.5).
 */
export const CURRENT_SAVE_VERSION = 5

/** The oldest payload version the migration chain can still bring forward. */
export const FIRST_SUPPORTED_SAVE_VERSION = 1

/** `'BWSV'`, big-endian ASCII. Rejects a file that was never one of ours. */
export const SAVE_MAGIC = 0x42575356

/** The envelope version. See the module comment for why it is not the schema version. */
export const SAVE_CONTAINER_VERSION = 1

/**
 * Header layout, all little-endian `uint32`. The payload follows immediately:
 * a gzip stream whose plaintext is the UTF-8 JSON of a `SaveFile`.
 */
export const SAVE_HEADER = {
  MAGIC: 0,
  CONTAINER_VERSION: 4,
  /** The payload's `version`, readable without decompressing. */
  SCHEMA_VERSION: 8,
  /** Plaintext length in bytes, so a truncated gzip stream is caught. */
  PAYLOAD_BYTES: 12,
  /** FNV-1a over the plaintext bytes, so a flipped bit is caught. */
  PAYLOAD_CHECKSUM: 16,
} as const

export const SAVE_HEADER_BYTES = 20

/** The extension used for export and import through the Files app. */
export const SAVE_FILE_EXTENSION = '.blockwork'

/**
 * PRD 7.4 caps the saved log at 2000 entries. A format limit rather than a
 * balance number: it bounds the file, and the oldest entries are the ones a
 * player will never scroll back to.
 */
export const MAX_SAVED_LOG_ENTRIES = 2000

/**
 * Why a save could not be written or read.
 *
 * Load is the one place where the input is genuinely untrusted — a file the
 * player picked, a record written by an older build, a partial write from a
 * device that lost power — so every failure mode gets a code a caller can
 * branch on and a message a player could be shown.
 */
export type SaveErrorCode =
  /** Not a `.blockwork` file: the magic number does not match. */
  | 'not-a-save'
  /** Fewer bytes than the header needs, or a payload shorter than declared. */
  | 'truncated'
  /** A container version this build does not know how to open. */
  | 'unsupported-container'
  /** Gzip refused the payload on the way out. Should never happen. */
  | 'compression-failed'
  /** Gzip refused the payload on the way in: the bytes are damaged. */
  | 'decompression-failed'
  /** The plaintext checksum or length disagrees with the header. */
  | 'corrupt-payload'
  /** The plaintext is not valid UTF-8 JSON. */
  | 'malformed-json'
  /** Valid JSON, but not the shape a `SaveFile` of that version must have. */
  | 'invalid-save'
  /** Older than `FIRST_SUPPORTED_SAVE_VERSION`, or newer than this build. */
  | 'unsupported-version'
  /** The chain is missing a step, or a step threw. */
  | 'migration-failed'
  /** The host has no Compression Streams implementation. */
  | 'compression-unavailable'

/** Every failure this module raises. Never a bare `Error`, never a crash. */
export class SaveError extends Error {
  override readonly name = 'SaveError'
  readonly code: SaveErrorCode

  constructor(code: SaveErrorCode, message: string, options?: { readonly cause?: unknown }) {
    super(message, options)
    this.code = code
  }
}

/**
 * New-game options that stay fixed for the life of a prison.
 *
 * T6.5 gives this a real shape when map creation and settings land.
 */
export type MapSettings = JsonObject

/**
 * The tile grid as base64, one string per parallel array (PRD 7.4's
 * `{ [K in keyof TileGrid]: string }`, narrowed to the fields that are
 * actually arrays).
 *
 * The bytes inside are little-endian regardless of the host that wrote them,
 * so a save is portable between architectures.
 */
export type SerialisedGrid = { readonly [K in TileField]: string }

/** One conviction on an inmate's record. */
export interface SerialisedConviction extends JsonObject {
  readonly id: string
  readonly years: number
}

/** One reputation flag on an inmate. */
export interface SerialisedReputation extends JsonObject {
  readonly id: string
  readonly revealed: boolean
}

/** One addiction entry. */
export interface SerialisedAddiction extends JsonObject {
  readonly substance: string
  readonly strength: number
}

/** One misconduct log line. */
export interface SerialisedMisconductEntry extends JsonObject {
  readonly tick: number
  readonly kind: string
  readonly punishment: string
  readonly durationHours: number
}

/** Inmate grades (punishment / reform / security / health). */
export interface SerialisedInmateGrades extends JsonObject {
  readonly punishment: number
  readonly reform: number
  readonly security: number
  readonly health: number
}

/** Full inmate entity snapshot (history fields included — T8.5). */
export interface SerialisedInmateEntity extends JsonObject {
  readonly id: number
  readonly kind: 'inmate'
  readonly name: string
  readonly portraitSeed: number
  readonly category: string
  readonly convictions: readonly SerialisedConviction[]
  readonly sentenceHours: number
  readonly servedHours: number
  readonly traits: readonly string[]
  readonly reputations: readonly SerialisedReputation[]
  readonly needs: readonly number[]
  readonly addictions: readonly SerialisedAddiction[]
  readonly suppression: number
  readonly entitlement: number
  readonly cellId: number
  readonly jobId: string | null
  readonly misconductLog: readonly SerialisedMisconductEntry[]
  readonly grades: SerialisedInmateGrades
  readonly reoffendChance: number
  readonly status: readonly string[]
  readonly health: number
  readonly inventory: readonly string[]
  readonly money: number
  readonly aptitude: number
  readonly x: number
  readonly y: number
  readonly tx: number
  readonly ty: number
  readonly accessMask: number
}

/** Staff duty payload (kind + target fields vary by kind). */
export type SerialisedStaffDuty = JsonObject & { readonly kind: string }

/** Full staff entity snapshot. */
export interface SerialisedStaffEntity extends JsonObject {
  readonly id: number
  readonly kind: 'staff'
  readonly defId: string
  readonly name: string
  readonly officeRoomId: number
  readonly assignedAreaId: number
  readonly pinnedTile: number
  readonly duty: SerialisedStaffDuty
  readonly wanderCooldown: number
  readonly breakPending: boolean
  readonly breakCooldownMinutes: number
  readonly needs: readonly number[]
  readonly x: number
  readonly y: number
  readonly tx: number
  readonly ty: number
}

/** Full object entity snapshot. */
export interface SerialisedObjectEntity extends JsonObject {
  readonly id: number
  readonly kind: 'object'
  readonly tileIndex: number
  readonly tx: number
  readonly ty: number
  readonly defId: string
  readonly rotation: number
  readonly roomId: number
  readonly hasPower: boolean
  readonly hasWater: boolean
  readonly hp: number
  readonly tiles: readonly number[]
  readonly footprint: {
    readonly x: number
    readonly y: number
    readonly width: number
    readonly height: number
  }
}

/**
 * Discriminated entity snapshot. Concrete fields — not an open index signature
 * alone — so omitting history or duty state is a type error (T8.5).
 */
export type SerialisedEntity =
  | SerialisedInmateEntity
  | SerialisedStaffEntity
  | SerialisedObjectEntity

/** Minimal room snapshot (id references + detection seed). */
export interface SerialisedRoom extends JsonObject {
  readonly id: number
  readonly defId: string
  readonly tiles: readonly number[]
  readonly bounds: {
    readonly x: number
    readonly y: number
    readonly width: number
    readonly height: number
  }
  readonly properties: Readonly<Record<string, boolean>>
}

/** One sector definition. Tile membership lives on `grid.sectorId`. */
export interface SerialisedSector extends JsonObject {
  readonly id: number
  readonly name: string
  readonly colour: string
  readonly access: SectorAccessMode
  readonly categories: readonly string[]
}

/** Sector defs plus the next id allocator. */
export interface SectorsState extends JsonObject {
  readonly nextSectorId: number
  readonly sectors: readonly SerialisedSector[]
}

/** Prison ledger snapshot (`EconomyLedger.serialise`). */
export interface EconomyState extends JsonObject {
  readonly balance: number
  readonly loanPrincipal: number
  readonly insolvencyDeadlineTick: number | null
  readonly insolvencyStartedTick?: number | null
  readonly entries: readonly {
    readonly tick: number
    readonly category: string
    readonly amount: number
    readonly reason: string
    readonly sourceEntityId: number
  }[]
}

/** Directorate research snapshot (`DirectorateState.serialise`, T5.1). */
export interface DirectorateStateSnapshot extends JsonObject {
  readonly completed: readonly string[]
  readonly active: readonly {
    readonly nodeId: string
    readonly startedTick: number
    /** Ticks of progress, excluding time spent paused. */
    readonly elapsedTicks: number
    /** `'no-administrator'` / `'no-office'`, or null while advancing. */
    readonly pausedReason: string | null
  }[]
}

/** Room grading and entitlement clocks (`GradingRuntime.serialise`, T5.2). */
export interface GradingStateSnapshot extends JsonObject {
  /** Latest published grade per room. Recomputed on the next hourly pass. */
  readonly roomGrades: readonly { readonly roomId: number; readonly score: number }[]
  /** Tick each inmate last earned an entitlement point. */
  readonly lastEntitlementTick: readonly {
    readonly inmateId: number
    readonly tick: number
  }[]
  readonly averageCellGrade: number
}

/** Programme enrolment, completions and pins (`ProgramRuntime.serialise`, T5.3). */
export interface ProgramsStateSnapshot extends JsonObject {
  readonly enrolments: readonly {
    readonly inmateId: number
    readonly programId: string
    readonly sessionsPassed: number
    readonly sessionsMissed: number
    readonly enrolledTick: number
  }[]
  readonly completions: readonly {
    readonly inmateId: number
    readonly programIds: readonly string[]
  }[]
  readonly pins: readonly {
    readonly programId: string
    readonly categoryId: string
    readonly startHour: number
  }[]
}

/** Confinement / suppression exposure ledgers (`GradesRuntime.serialise`, T5.4). */
export interface GradesStateSnapshot extends JsonObject {
  readonly confinement: readonly {
    readonly inmateId: number
    readonly isolationHours: number
    readonly lockdownHours: number
    readonly suppressionExposure: number
    readonly labourHours: number
  }[]
}

/** Parole queue and hearing budget (`ParoleRuntime.serialise`, T5.4). */
export interface ParoleStateSnapshot extends JsonObject {
  readonly queue: readonly {
    readonly inmateId: number
    readonly eligibleAtTick: number
    readonly hearingsHeld: number
    readonly nextHearingTick: number
  }[]
  readonly hearingsToday: number
  readonly hearingDay: number
}

/** Release ledger and re-offending record (`ReleaseRuntime.serialise`, T5.4). */
export interface ReleaseStateSnapshot extends JsonObject {
  readonly released: readonly {
    readonly inmateId: number
    readonly name: string
    readonly reason: string
    readonly releasedTick: number
    readonly reoffendChance: number
    readonly rollsAtTick: number
    readonly reoffended: boolean | null
    readonly reoffendedTick: number
  }[]
  readonly lifetimeReleased: number
  readonly lifetimeReoffended: number
  readonly paroleReoffences: readonly number[]
  readonly recidivismWarned: boolean
}

/** Informants and revealed intelligence (`IntelligenceRuntime.serialise`, T5.6). */
export interface IntelligenceStateSnapshot extends JsonObject {
  readonly informants: readonly {
    readonly inmateId: number
    readonly recruitedTick: number
    readonly blown: boolean
    readonly blownTick: number
    readonly carelesslyHandled: boolean
    readonly revealCount: number
  }[]
  readonly revealedStashIds: readonly number[]
  readonly revealedThrowInIds: readonly number[]
  readonly lastBlowRollDay: number
}

/** Contract book snapshot (`ContractBook.serialise`). */
export interface ContractState extends JsonObject {
  readonly active: readonly {
    readonly defId: string
    readonly acceptedTick: number
    readonly advancePaid: number
    readonly itemPassed: readonly boolean[]
  }[]
  readonly finished: readonly {
    readonly defId: string
    readonly lifecycle: string
    readonly settledTick: number
    readonly advancePaid: number
    readonly cancellationDebit: number
    readonly completionCredit: number
  }[]
  readonly revealed: readonly string[]
}

/**
 * 24 hourly Routine blocks per security category (T2.6, PRD 5.7).
 *
 * Keys are security category ids; each value is length 24.
 */
export type RoutineState = {
  readonly [categoryId: string]: readonly string[]
}

/** Live Standing Orders policy (`createDefaultStandingOrders` shape). */
export interface StandingOrdersState extends JsonObject {
  readonly misconduct: {
    readonly [kind: string]: {
      readonly punishment: string
      readonly durationHours: number
      readonly search: boolean
    }
  }
  readonly reassignmentStrictness: string
  readonly mealQuantity: string
  readonly mealVariety: number
}

export interface SerialisedHourRange extends JsonObject {
  readonly startHour: number
  readonly endHour: number
}

export interface SerialisedPost extends JsonObject {
  readonly id: number
  readonly name: string
  readonly sectorId: number
  readonly objectId: number
  readonly staffRole: string
  readonly count: number
  readonly timeWindows: readonly SerialisedHourRange[]
  readonly assigned: readonly number[]
  readonly shortfallReason: string | null
  readonly lastReportedTick: number
}

export interface SerialisedPatrolRoute extends JsonObject {
  readonly id: number
  readonly name: string
  readonly staffRole: string
  readonly count: number
  readonly waypoints: readonly number[]
  readonly timeWindows: readonly SerialisedHourRange[]
  readonly assigned: readonly number[]
  readonly shortfallReason: string | null
  readonly lastReportedTick: number
}

/** Posts and patrol routes (`PostRegistry`). */
export interface PostsState extends JsonObject {
  readonly nextPostId: number
  readonly nextRouteId: number
  readonly posts: readonly SerialisedPost[]
  readonly routes: readonly SerialisedPatrolRoute[]
}

/** @deprecated Prefer {@link PostsState}; kept for migration typing. */
export type PostState = SerialisedPost

export interface ContrabandStateSnapshot extends JsonObject {
  readonly nextStashId: number
  readonly nextThrowInId: number
  readonly confiscatedCount: number
  readonly pendingArrivalIds: readonly number[]
  readonly pendingDeliveryLines: readonly {
    readonly itemId: string
    readonly units: number
    readonly truckId: number
  }[]
  readonly stashes: readonly {
    readonly id: number
    readonly tileIndex: number
    readonly itemId: string
    readonly ownerInmateId: number
  }[]
  readonly throwIns: readonly {
    readonly id: number
    readonly inmateId: number
    readonly itemId: string
    readonly tileIndex: number
    readonly collectTick: number
    readonly resolved: boolean
  }[]
  readonly prices: readonly { readonly itemId: string; readonly price: number }[]
}

/** Sparse fire / smoke (non-zero tiles only). */
export interface FireStateSnapshot extends JsonObject {
  readonly size: number
  readonly burning: readonly {
    readonly tileIndex: number
    readonly intensity: number
    readonly fuel: number
  }[]
  readonly smoke: readonly { readonly tileIndex: number; readonly smoke: number }[]
  readonly overloadedBranches: readonly number[]
}

export interface RiotStateSnapshot extends JsonObject {
  readonly active: boolean
  readonly riotingInmateIds: readonly number[]
  readonly quietMinutes: number
  readonly startedAtTick: number
  readonly doorBreakProgress: readonly {
    readonly tileIndex: number
    readonly minutes: number
  }[]
}

export interface EmergencyStateSnapshot extends JsonObject {
  readonly sectorLockdowns: readonly number[]
  readonly fullLockdown: boolean
  readonly riotSquadActive: boolean
  readonly riotSquadStaffIds: readonly number[]
  readonly freeFireActive: boolean
  readonly freeFirePenaltiesApplied: boolean
  readonly nationalGuardActive: boolean
  readonly nationalGuardStaffIds: readonly number[]
  readonly playerFired: boolean
  readonly riotFailureEnabled: boolean
  readonly warningAtTick: number | null
  readonly failureAtTick: number | null
  readonly warningEmitted: boolean
  readonly failed: boolean
  readonly prPenalty: number
  readonly riotSquadLastWageTick: number
}

export interface EscapesStateSnapshot extends JsonObject {
  readonly nextTunnelId: number
  readonly tunnels: readonly {
    readonly id: number
    readonly originTile: number
    readonly tiles: readonly number[]
    readonly diggerIds: readonly number[]
    readonly discovered: boolean
    readonly progress: number
    readonly reachedExit: boolean
    readonly networkId: number
  }[]
  readonly breachedDoorTiles: readonly number[]
  readonly pendingEscapes: readonly {
    readonly networkId: number
    readonly inmateIds: readonly number[]
    readonly remainingIds: readonly number[]
  }[]
  readonly escapesToday: number
  readonly escapesYesterday: number
  readonly accountedDay: number
  readonly warningActive: boolean
  readonly failed: boolean
  readonly totalEscapes: number
}

export interface CombatStateSnapshot extends JsonObject {
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
}

export interface PunishmentsStateSnapshot extends JsonObject {
  readonly active: readonly {
    readonly inmateId: number
    readonly kind: string
    readonly sourceMisconduct: string
    readonly phase: string
    readonly remainingMinutes: number
    readonly homeCellId: number
    readonly holdRoomId: number
    readonly destinationTile: number
    readonly escortJobId: number
    readonly lastMealHourKey: number
    readonly isolationSuppressionAccrued: number
  }[]
  readonly agitatorBoostUntil: readonly {
    readonly inmateId: number
    readonly untilTick: number
  }[]
}

export interface LogEntry extends JsonObject {
  /** The tick the entry was recorded on. */
  readonly tick: number
}

/**
 * `RngState` as plain JSON, assignable in both directions.
 *
 * It is restated here rather than reused because an interface has no implicit
 * index signature, so `RngState` is not assignable to `JsonValue` even though
 * every value of it is JSON. Keep the two in step: the RNG must restore
 * exactly or a loaded run diverges from the one that was saved.
 */
export type SerialisedRngState = {
  readonly seed: number
  readonly streams: readonly {
    readonly name: string
    /** The stream's mulberry32 internal state. */
    readonly state: number
  }[]
}

/** Cable / pipe overlay tiles (T5.5). Grid branch ids rebuild on the next utilities tick. */
export interface UtilitiesStateSnapshot extends JsonObject {
  /** Tile indices with cable present. */
  readonly cableTiles: readonly number[]
  /** Tile indices with pipe present. */
  readonly pipeTiles: readonly number[]
  /** Power branches currently shed (hashed). */
  readonly shedBranches: readonly number[]
  /** Water use multipliers per branch (hashed). */
  readonly waterMultipliers: readonly {
    readonly branchId: number
    readonly multiplier: number
  }[]
}

/** Next entity ids and staff hire tallies. */
export interface EntityRegistryState extends JsonObject {
  readonly nextInmateId: number
  readonly nextStaffId: number
  readonly nextObjectId: number
  readonly staffHireCounts: readonly { readonly defId: string; readonly count: number }[]
}

/** Door placements (`DoorRegistry.serialise`). */
export interface DoorsStateSnapshot extends JsonObject {
  readonly doors: readonly {
    readonly tileIndex: number
    readonly type: string
    readonly locked: boolean
  }[]
}

/** Construction queue and staged spend / refunds. */
export interface ConstructionStateSnapshot extends JsonObject {
  readonly nextSiteId: number
  readonly sites: readonly {
    readonly id: number
    readonly tileIndex: number
    readonly job: JsonObject
    readonly requirements: readonly { readonly itemId: string; readonly units: number }[]
    readonly delivered: readonly number[]
    readonly workTicksRequired: number
    readonly workTicksDone: number
    readonly cost: number
    readonly queuedAtTick: number
    readonly blockedBy: string
  }[]
  readonly spendOwed: number
  readonly refundsOwed: number
}

/** Intake policy (continuous / bus clock / requested counts). */
export interface IntakeStateSnapshot extends JsonObject {
  readonly continuous: boolean
  readonly nextBusAtTick: number
  readonly requestedCounts: readonly { readonly category: string; readonly count: number }[]
}

/** Published cell grades by room. */
export interface CellGradesStateSnapshot extends JsonObject {
  readonly grades: readonly { readonly roomId: number; readonly grade: number }[]
}

/** Fog-of-war revealed tiles (sparse). */
export interface FogStateSnapshot extends JsonObject {
  readonly revealedTiles: readonly number[]
}

/** Office claims (administrator → room). */
export interface OfficesStateSnapshot extends JsonObject {
  readonly claims: readonly {
    readonly roomId: number
    readonly staffId: number
    readonly displayName: string
  }[]
}

/** Escort job queue (`EscortJobQueue.serialise`). */
export interface EscortsStateSnapshot extends JsonObject {
  readonly nextId: number
  readonly jobs: readonly {
    readonly id: number
    readonly inmateId: number
    readonly destinationTile: number
    readonly purpose: string
    readonly state: string
    readonly claimedBy: number
    readonly pathIndex: number
    readonly pathLength: number
  }[]
}

/** Job pool (`JobPool.serialise`). */
export interface JobsStateSnapshot extends JsonObject {
  readonly nextId: number
  readonly jobs: readonly {
    readonly id: number
    readonly kind: string
    readonly priority: number
    readonly location: number
    readonly requiredRole: string
    readonly reservedFor: string | null
    readonly claimedBy: number
    readonly claimantKind: string | null
    readonly state: string
    readonly enqueuedAt: number
  }[]
}

/** Inmate labour runtime (`LabourRuntime.serialise`). */
export interface LabourStateSnapshot extends JsonObject {
  readonly assignments: readonly { readonly inmateId: number; readonly assignment: string }[]
  readonly workerMinutes: readonly { readonly key: string; readonly minutes: number }[]
  readonly finishedGoods: readonly { readonly productId: string; readonly units: number }[]
  readonly groveMinutes: readonly { readonly roomId: number; readonly minutes: number }[]
  readonly grownTrees: readonly { readonly roomId: number; readonly trees: number }[]
  readonly commissaryGoods: number
  readonly lifetimeExportIncome: number
  readonly lifetimeCommissaryIncome: number
}

/** Staff morale (`MoraleState.serialise`). */
export interface MoraleStateSnapshot extends JsonObject {
  readonly value: number
  readonly wageMultiplier: number
  readonly lastDangerContribution: number
  readonly deaths: readonly number[]
  readonly injured: readonly number[]
  readonly strike: {
    readonly phase: string
    readonly endsAtTick: number
    readonly cooldownUntilTick: number
    readonly refuseCount: number
    readonly payDemandOpen: boolean
    readonly demandedRaise: number
  }
  readonly hasStruckBefore: boolean
}

/** Per-inmate needs activity runtime. */
export interface NeedsRuntimeStateSnapshot extends JsonObject {
  readonly inmates: readonly {
    readonly inmateId: number
    readonly usingObjectId: number
    readonly lockedUp: boolean
    readonly seekingWeapon: boolean
    readonly diggingTunnel: boolean
    readonly starveMinutes: number
    readonly criticalLatch: readonly number[]
  }[]
}

/** Per-inmate Routine / Activity runtime. */
export interface RoutineRuntimeStateSnapshot extends JsonObject {
  readonly inmates: readonly {
    readonly inmateId: number
    readonly blockId: string | null
    readonly permittedRooms: readonly string[]
    readonly preferredNeed: string | null
    readonly goalSetId: string | null
    readonly goalTile: number
    readonly lockedUp: boolean
    readonly freeChoiceNeed: string | null
    readonly freeChoiceRoomDef: string | null
    readonly useMinutesRemaining: number
  }[]
}

/** Meal logistics (`MealLogistics.serialise`). */
export interface MealsStateSnapshot extends JsonObject {
  readonly standingOrders: { readonly quantity: string; readonly variety: number }
  readonly missedMeals: number
  readonly mealsServed: number
  readonly routingOverrides: readonly { readonly kitchenId: number; readonly messId: number }[]
  readonly fridgeStock: readonly {
    readonly id: number
    readonly items: readonly { readonly itemId: string; readonly units: number }[]
  }[]
  readonly counterMeals: readonly { readonly id: number; readonly value: number }[]
  readonly dirtyTrays: readonly { readonly id: number; readonly value: number }[]
  readonly refuseStock: readonly { readonly id: number; readonly value: number }[]
  readonly prepSessions: readonly {
    readonly kitchenRoomId: number
    readonly messRoomId: number
    readonly prepStartTick: number
    readonly mealStartTick: number
    readonly needed: number
    readonly produced: number
    readonly rootCauseId: number
    readonly productionRemainder: number
  }[]
}

/** Construction supply logistics (`SupplyLogistics.serialise`). */
export interface SupplyStateSnapshot extends JsonObject {
  readonly nextOrderId: number
  readonly orders: readonly {
    readonly id: number
    readonly itemId: string
    readonly units: number
    readonly remaining: number
    readonly siteId: number
    readonly orderedAtTick: number
  }[]
  readonly dockFree: readonly { readonly itemId: string; readonly units: number }[]
  readonly dockReserved: readonly {
    readonly siteId: number
    readonly stock: readonly { readonly itemId: string; readonly units: number }[]
  }[]
  readonly storeStock: readonly { readonly itemId: string; readonly units: number }[]
  readonly binRefuse: readonly { readonly id: number; readonly units: number }[]
  readonly refuseZone: readonly { readonly id: number; readonly units: number }[]
  readonly carries: readonly {
    readonly jobId: number
    readonly hop: string
    readonly itemId: string
    readonly units: number
    readonly siteId: number
    readonly fromObjectId: number
  }[]
}

/** Delivery schedule (`DeliverySchedule.serialise`). */
export interface DeliveriesStateSnapshot extends JsonObject {
  readonly nextTruckId: number
  readonly nextTruckAt: number
  readonly pending: readonly {
    readonly itemId: string
    readonly units: number
    readonly siteId: number
    readonly orderId: number
  }[]
  readonly scheduled: readonly {
    readonly id: number
    readonly arriveTick: number
    readonly refuseUnits: number
    readonly lines: readonly {
      readonly itemId: string
      readonly units: number
      readonly siteId: number
      readonly orderId: number
    }[]
  }[]
}

/** Cleaning logistics remainders / counters. */
export interface CleaningStateSnapshot extends JsonObject {
  readonly cleanRemainder: number
  readonly noCleanersNotified: boolean
  readonly dirtRemoved: number
}

/** Laundry logistics maps. */
export interface LaundryStateSnapshot extends JsonObject {
  readonly uniformsDistributed: number
  readonly lastAccrualDay: number
  readonly routingOverrides: readonly { readonly laundryId: number; readonly housingId: number }[]
  readonly uniformDirtiness: readonly { readonly key: number; readonly value: number }[]
  readonly bedDirty: readonly { readonly key: number; readonly value: number }[]
  readonly basketDirty: readonly { readonly key: number; readonly value: number }[]
  readonly pendingWash: readonly { readonly key: number; readonly value: number }[]
  readonly washedReady: readonly { readonly key: number; readonly value: number }[]
  readonly ironedReady: readonly { readonly key: number; readonly value: number }[]
  readonly bedClean: readonly { readonly key: number; readonly value: number }[]
}

/**
 * One save, exactly as PRD 7.4 specifies it, plus Phase 4 keys from v3.
 *
 * It extends `JsonObject` on purpose: a `SaveFile` is required to be plain
 * JSON with no cycles and no class instances, and the migration chain works on
 * `JsonObject` because a save being migrated is, by definition, not yet a
 * `SaveFile` of the current version.
 */
export interface SaveFile extends JsonObject {
  /** Integer, bumped on any breaking change to this shape. */
  readonly version: number
  readonly seed: number
  /** ISO 8601, supplied by the caller: sim code may not read the wall clock. */
  readonly createdAt: string
  readonly playedTicks: number
  readonly mapSize: number
  readonly settings: MapSettings
  readonly grid: SerialisedGrid
  readonly entities: readonly SerialisedEntity[]
  readonly rooms: readonly SerialisedRoom[]
  readonly nextRoomId: number
  readonly sectors: SectorsState
  readonly economy: EconomyState
  readonly directorate: DirectorateStateSnapshot
  readonly grading: GradingStateSnapshot
  readonly programs: ProgramsStateSnapshot
  readonly grades: GradesStateSnapshot
  readonly parole: ParoleStateSnapshot
  readonly release: ReleaseStateSnapshot
  readonly intelligence: IntelligenceStateSnapshot
  readonly contracts: ContractState
  readonly routines: RoutineState
  readonly standingOrders: StandingOrdersState
  readonly posts: PostsState
  readonly contraband: ContrabandStateSnapshot
  readonly fire: FireStateSnapshot
  readonly riot: RiotStateSnapshot
  readonly emergency: EmergencyStateSnapshot
  readonly escapes: EscapesStateSnapshot
  readonly combat: CombatStateSnapshot
  readonly punishments: PunishmentsStateSnapshot
  readonly utilities: UtilitiesStateSnapshot
  readonly entityRegistry: EntityRegistryState
  readonly doors: DoorsStateSnapshot
  readonly construction: ConstructionStateSnapshot
  readonly intake: IntakeStateSnapshot
  readonly cellGrades: CellGradesStateSnapshot
  readonly incomeOwed: number
  readonly staffOnlyRoomIds: readonly number[]
  readonly intakeSearchedInmateIds: readonly number[]
  readonly staffNeedsEnabled: boolean
  readonly fog: FogStateSnapshot
  readonly offices: OfficesStateSnapshot
  readonly escorts: EscortsStateSnapshot
  readonly jobs: JobsStateSnapshot
  readonly labour: LabourStateSnapshot
  readonly morale: MoraleStateSnapshot
  readonly needsRuntime: NeedsRuntimeStateSnapshot
  readonly routineRuntime: RoutineRuntimeStateSnapshot
  readonly meals: MealsStateSnapshot
  readonly supply: SupplyStateSnapshot
  readonly deliveries: DeliveriesStateSnapshot
  readonly cleaning: CleaningStateSnapshot
  readonly laundry: LaundryStateSnapshot
  readonly dangerLevel: number
  readonly riotActive: boolean
  readonly lockdownActive: boolean
  readonly misconductWindowTicks: readonly number[]
  /** Capped at `MAX_SAVED_LOG_ENTRIES`, newest kept. */
  readonly log: readonly LogEntry[]
  readonly rngState: SerialisedRngState
}

/**
 * What a reader can learn from the header alone, before it commits to
 * decompressing anything. The store uses it to list saves cheaply.
 */
export interface SaveHeader {
  readonly containerVersion: number
  readonly schemaVersion: number
  readonly payloadBytes: number
  readonly payloadChecksum: number
}
