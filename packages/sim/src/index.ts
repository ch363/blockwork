/**
 * @blockwork/sim - the deterministic simulation core.
 *
 * This package has zero DOM dependencies (enforced by omitting the DOM lib from
 * its tsconfig) and never imports from render, ui or app (enforced by lint).
 */

export const SIM_PACKAGE_NAME = '@blockwork/sim'

export {
  Clock,
  HOURS_PER_DAY,
  MINUTES_PER_HOUR,
  TICKS_PER_DAY,
  TICKS_PER_HOUR,
  TICKS_PER_MINUTE,
  ticksToDay,
  ticksToHour,
  ticksToMinute,
  ticksToTimeString,
} from './core/clock'
export type { ClockState, ReadonlyClock } from './core/clock'

export {
  CommandQueue,
  assertCommand,
  assertSerialisablePayload,
  isJsonArray,
} from './core/commands'
export type { Command, JsonObject, JsonPrimitive, JsonValue } from './core/commands'

export { FNV_OFFSET_BASIS_32, FNV_PRIME_32, Fnv1aHasher, fnv1a32 } from './core/hash'

export { Rng, RngStream, deriveStreamSeed } from './core/rng'
export type { RngState, RngStreamState } from './core/rng'

export {
  DEFAULT_SNAPSHOT_LIMITS,
  NOTIFICATION_SEVERITY,
  NO_TRUNCATION,
  SNAPSHOT_CONTROL,
  SNAPSHOT_CONTROL_BYTES,
  SNAPSHOT_CONTROL_INTS,
  SNAPSHOT_FLAG_TRUNCATED,
  SNAPSHOT_FORMAT_VERSION,
  SNAPSHOT_MAGIC,
  SNAPSHOT_SLOTS,
  SnapshotReader,
  SnapshotWriter,
  assertSnapshotLimits,
  createSharedSnapshotBuffer,
  createSnapshotBuffer,
  decodeSnapshot,
  encodeSnapshot,
  encodeSnapshotToTransferable,
  isTruncated,
  nextSequence,
  notificationKindId,
  sharedMemoryAvailable,
  snapshotBufferBytes,
  snapshotPayloadBytes,
  snapshotSlotBytes,
} from './core/snapshot'
export type {
  EncodeResult,
  NotificationDelta,
  NotificationSeverity,
  Snapshot,
  SnapshotContents,
  SnapshotEntity,
  SnapshotLimits,
  SnapshotNotification,
  SnapshotTruncation,
  SnapshotWriterOptions,
  UiDigest,
} from './core/snapshot'

export {
  CURRENT_SAVE_VERSION,
  FIRST_SUPPORTED_SAVE_VERSION,
  HOST_IS_LITTLE_ENDIAN,
  MAX_SAVED_LOG_ENTRIES,
  MIGRATIONS,
  SAVE_CONTAINER_VERSION,
  SAVE_FILE_EXTENSION,
  SAVE_HEADER,
  SAVE_HEADER_BYTES,
  SAVE_MAGIC,
  SaveError,
  assertSaveFile,
  base64ToBytes,
  bytesToBase64,
  checksumBytes,
  compressionAvailable,
  concatBytes,
  decodeSaveFile,
  deserialiseGrid,
  deserialiseSave,
  encodeSaveFile,
  gunzipBytes,
  gzipBytes,
  hashSaveState,
  loadFromBytes,
  migrateSave,
  migrationSteps,
  orientBytes,
  readSaveHeader,
  saveStateWorld,
  saveToBytes,
  serialiseGrid,
  toSaveFile,
  utf8Decode,
  utf8Encode,
} from './save'
export type {
  ContractState,
  DirectorateState,
  EconomyState,
  LoadOptions,
  LogEntry,
  MapSettings,
  Migration,
  PostState,
  RoutineState,
  SaveErrorCode,
  SaveFile,
  SaveHeader,
  SaveOptions,
  SaveState,
  SerialisedEntity,
  SerialisedGrid,
  SerialisedRngState,
  SerialisedRoom,
  SerialisedSector,
  StandingOrdersState,
} from './save'

export {
  ChunkVersionReader,
  ChunkVersionWriter,
  chunkVersionBytes,
  createChunkVersionBuffer,
} from './core/chunkVersions'

export {
  TILE_PATCH_CHUNK_BYTES,
  TILE_PATCH_FIELDS,
  TILE_PATCH_HEADER_BYTES,
  TILE_PATCH_MAGIC,
  TILE_PATCH_VERSION,
  TILES_PER_CHUNK,
  applyTilePatch,
  createTileMirror,
  decodeTilePatch,
  encodeTilePatch,
  tilePatchBytes,
} from './core/tilePatch'
export type { TileMirror, TilePatch, TilePatchChunk, TilePatchField } from './core/tilePatch'

export { GameDataError, Registry, loadGameData } from './data/loader'
export type { DirectorateUnlocks, GameData, GameDataIssue } from './data/loader'

export {
  CONTRABAND_CATEGORIES,
  CRITICAL_BEHAVIOURS,
  DIRECTORATE_BRANCHES,
  DOOR_TYPES,
  FILE_SCHEMAS,
  GAME_DATA_FILES,
  ID_PATTERN,
  INCIDENT_KINDS,
  LABOUR_ASSIGNMENTS,
  MATERIAL_SURFACES,
  MISCONDUCT_KINDS,
  PUNISHMENT_KINDS,
  REASSIGNMENT_STRICTNESS,
  NEED_DRIVERS,
  OBJECT_PLACEMENTS,
  POWER_PRIORITIES,
  PROGRAM_ATTENDANCE,
  PROGRAM_DIFFICULTIES,
  RISK_TIERS,
  ROOM_CATEGORIES,
  ROOM_PROPERTIES,
  ROUTINE_BLOCKS,
  STAFF_CAPABILITIES,
  STATUS_EFFECTS,
  balanceSchema,
  contrabandDefSchema,
  contractDefSchema,
  convictionDefSchema,
  directorateNodeSchema,
  doorDefSchema,
  materialDefSchema,
  needDefSchema,
  objectDefSchema,
  programDefSchema,
  reputationDefSchema,
  roomDefSchema,
  securityCategoryDefSchema,
  staffDefSchema,
  supplyDefSchema,
  traitDefSchema,
} from './data/schemas'
export type {
  Balance,
  ContrabandCategory,
  ContrabandDef,
  ContractDef,
  MisconductKind,
  PunishmentKind,
  ReassignmentStrictness,
  ContractPredicate,
  ConvictionDef,
  CriticalBehaviour,
  DirectorateBranch,
  DirectorateNode,
  DoorDef,
  DoorType,
  GameDataFileName,
  GradingRuleSet,
  IncidentKind,
  InmateNames,
  LabourAssignment,
  MaterialDef,
  MaterialSurface,
  NeedDef,
  NeedDriver,
  ObjectDef,
  ObjectPlacement,
  PowerPriority,
  ProgramAttendance,
  ProgramDef,
  ProgramDifficulty,
  ProgramEffect,
  RawGameDataFiles,
  ReputationDef,
  RiskTier,
  RoomCategory,
  RoomDef,
  RoomProperty,
  RoutineBlockId,
  SecurityCategoryDef,
  StaffCapability,
  StaffDef,
  StatusEffectId,
  SupplyDef,
  TraitDef,
} from './data/schemas'

export { allocateTileGridBuffers, createGame, createGameWorld } from './core/game'
export type { Game, GameOptions, GameWorldOptions } from './core/game'

export { Simulation, createEmptyWorld, nullEventSink } from './core/simulation'
export type {
  CommandHandler,
  EventSink,
  SimulationEvent,
  SimulationOptions,
  System,
  SystemContext,
  World,
} from './core/simulation'

export {
  CHUNK_SIZE,
  MAX_GRID_SIZE,
  assertChunkId,
  assertGridSize,
  assertInBounds,
  assertIndexInRange,
  boundsChecksEnabled,
  chunkBounds,
  chunkCount,
  chunkIdAt,
  chunkIdOfIndex,
  chunksPerAxis,
  idx,
  inBounds,
  indexInRange,
  setBoundsChecks,
  tileCount,
  tileX,
  tileY,
  xy,
} from './world/coords'
export type { ChunkBounds, TileCoord } from './world/coords'

export {
  MAX_MATERIALS,
  MAX_MATERIAL_INDEX,
  MaterialTable,
  NO_MATERIAL,
  NO_MATERIAL_ID,
} from './world/materials'
export type { MaterialId, MaterialIndex } from './world/materials'

export {
  BYTES_PER_TILE,
  PASSABILITY,
  TILE_FIELDS,
  TILE_FIELD_BYTES,
  TileGrid,
} from './world/tileGrid'
export type {
  PassabilityFlag,
  TileArrayView,
  TileArrays,
  TileField,
  TileGridBuffers,
} from './world/tileGrid'

export { DoorRegistry, doorPassability, doorTypeIndex, initialLockState } from './world/doors'
export type { Door, PlacedDoor } from './world/doors'

export {
  WALL_CARDINALS,
  WALL_DIAGONALS,
  WALL_NEIGHBOUR,
  isAxisAligned,
  isWall,
  isWallLike,
  wallLineTiles,
  wallNeighbourMask,
  wallNeighbourMaskAt,
} from './world/walls'
export type { WallLine, WallNeighbourBit } from './world/walls'

export {
  CONSTRUCTION_BLOCKERS,
  CONSTRUCTION_COMMANDS,
  CONSTRUCTION_JOB_KINDS,
  ConstructionQueue,
  ConstructionWorld,
  applyJob,
  clipRect,
  completeSite,
  constructionCommandHandlers,
  createConstructionWorld,
  deliver,
  deliverAll,
  demolish,
  demolitionRefund,
  isDelivered,
  isPerimeter,
  isValidRect,
  paintFloor,
  placeDoor,
  placeFoundation,
  placeWall,
  queueSite,
  rectTiles,
  refreshPassability,
  refreshPassabilityRect,
  removeWall,
  tilePassability,
} from './world/construction'
export type {
  ConstructionBlocker,
  ConstructionDeps,
  ConstructionJob,
  ConstructionJobKind,
  ConstructionRejection,
  ConstructionSite,
  MaterialRequirement,
  Rect,
  Tile,
} from './world/construction'

export {
  EMPTY_ROOM_CONTENTS,
  MAX_ROOM_ID,
  NO_DESIGNATION,
  NO_ROOM,
  REQUIREMENT_KINDS,
  ROOM_NEIGHBOURS,
  RoomRegistry,
  RoomWorld,
  computeRoomProperties,
  createRoomWorld,
  evaluateRoom,
  failedRequirements,
  scanEnclosure,
} from './world/rooms'
export type {
  EnclosureScan,
  RequirementKind,
  Room,
  RoomContents,
  RoomPropertySet,
  RoomRequirement,
  RoomStatus,
} from './world/rooms'

export {
  MAX_SECTOR_ID,
  NO_SECTOR,
  SECTOR_ACCESS_MODES,
  SECTOR_EVENTS,
  SectorRegistry,
  isSectorAccessMode,
  sectorAccessMask,
  sectorAdmits,
  sectorPassabilityBits,
} from './world/sectors'
export type { Sector, SectorAccessMode, SectorPaintResult } from './world/sectors'

export {
  SECTOR_COMMANDS,
  applySectorDerived,
  refreshStaffOnlySectorRooms,
  sectorCommandHandlers,
} from './world/sectorCommands'

export {
  ROOM_COMMANDS,
  designateRoom,
  detectAllRooms,
  detectRooms,
  refreshRoomStatus,
  roomCommandHandlers,
  undesignateRoom,
  updateStaleRooms,
} from './world/roomDetection'
export type { RoomDeps, RoomRejection, RoomUpdate } from './world/roomDetection'

export {
  MAX_OBJECT_ID,
  NO_OBJECT,
  NO_UTILITY_GRID,
  OBJECT_COMMANDS,
  ROTATIONS,
  ObjectRegistry,
  ObjectWorld,
  containingRoom,
  createObjectWorld,
  isOperational,
  isRotation,
  objectCommandHandlers,
  objectFootprint,
  objectRoomContents,
  placeObject,
  removeObject,
  rotatedSize,
  suppliesPower,
  suppliesWater,
  surfaceAccepts,
  validatePlacement,
} from './entities/objects'
export type {
  ObjectComponent,
  ObjectDeps,
  ObjectEntity,
  ObjectRejection,
  Rotation,
} from './entities/objects'

export {
  CONSTRUCTION_SYSTEM_NAME,
  CONSTRUCTION_SYSTEM_PERIOD,
  NO_WORKFORCE,
  createConstructionSystem,
  uniformWorkforce,
} from './systems/constructionSystem'
export type { ConstructionSystemOptions, Workforce } from './systems/constructionSystem'

export {
  OBJECT_SYSTEM_NAME,
  OBJECT_SYSTEM_PERIOD,
  createObjectSystem,
} from './systems/objectSystem'
export type { ObjectSystemOptions } from './systems/objectSystem'

export { ROOM_SYSTEM_NAME, ROOM_SYSTEM_PERIOD, createRoomSystem } from './systems/roomSystem'
export type { RoomSystemOptions } from './systems/roomSystem'

export {
  ADDICTION_SUBSTANCES,
  MAX_INMATE_ID,
  NO_INMATE,
  InmateRegistry,
  arrivalCategories,
  convictionsForTier,
  createInmateShell,
  expectedTraitRates,
  findHousing,
  generateInmate,
  housingCapacity,
  inmateRoomContents,
  pickArrivalCategory,
} from './entities/inmate'
export type {
  AddictionSubstance,
  CreateInmateShellOptions,
  HousingAssignment,
  HousingKind,
  InmateAddiction,
  InmateComponent,
  InmateConviction,
  InmateEntity,
  InmateGrades,
  InmateReputation,
  GenerateInmateOptions,
} from './entities/inmate'

export {
  INTAKE_COMMANDS,
  INTAKE_SYSTEM_NAME,
  INTAKE_SYSTEM_PERIOD,
  InmateWorld,
  arriveInmate,
  busIntervalTicks,
  createIntakePolicy,
  createIntakeSystem,
  createInmateWorld,
  createMapRuntimeSettings,
  intakeCommandHandlers,
  isInmateWorld,
  runBusArrival,
} from './systems/intakeSystem'
export type {
  ArriveInmateOptions,
  CreateInmateWorldOptions,
  IntakePolicy,
  IntakeSystemOptions,
  MapRuntimeSettings,
} from './systems/intakeSystem'

export {
  NEED_MAX,
  NEED_MIN,
  NEEDS_EVENTS,
  NeedIndex,
  NeedsRuntime,
  applyNeedDischarge,
  applyNeedFills,
  assertNeedLength,
  clampNeed,
  computeNeedFill,
  createInmateNeedState,
  meanRoomDirt,
  nearbyInmatesInTileRoom,
  resolveUsingObject,
} from './entities/needs'
export type {
  InmateNeedState,
  NeedFillContext,
  NeedFillResult,
  NeedsRejection,
} from './entities/needs'

export {
  NEEDS_SYSTEM_NAME,
  NEEDS_SYSTEM_PERIOD,
  createNeedsSystem,
} from './systems/needsSystem'
export type { NeedsSystemOptions } from './systems/needsSystem'

export {
  MISCONDUCT_EVENTS,
  applyAutoReclassification,
  applyEntitlementOnMisconduct,
  cellGradeMisconductModifier,
  chebyshevTiles,
  computeMisconductProbability,
  countCriticalNeeds,
  isMajorMisconduct,
  misconductKindWeights,
  pickMisconductKind,
  relieveFoodNeed,
} from './entities/misconduct'
export type { MisconductRecord, MisconductRollInput, ReclassificationResult } from './entities/misconduct'

export {
  PunishmentRuntime,
  clampSuppression,
  createPunishmentRuntime,
  hoursToMinutes,
} from './entities/punishment'
export type {
  ActivePunishment,
  ActivePunishmentKind,
  PunishmentPhase,
} from './entities/punishment'

export {
  createDefaultStandingOrders,
  hashStandingOrders,
  orderForKind,
  setMisconductOrder,
} from './entities/standingOrders'
export type {
  MealPolicyQuantity,
  MisconductStandingOrder,
  StandingOrdersPolicy,
} from './entities/standingOrders'

export {
  MISCONDUCT_SYSTEM_NAME,
  MISCONDUCT_SYSTEM_PERIOD,
  commitMisconduct,
  createMisconductSystem,
} from './systems/misconductSystem'
export type { CommitMisconductOptions, MisconductSystemOptions } from './systems/misconductSystem'

export {
  PUNISHMENT_SYSTEM_NAME,
  PUNISHMENT_SYSTEM_PERIOD,
  beginPunishment,
  createPunishmentSystem,
} from './systems/punishmentSystem'
export type { BeginPunishmentOptions, PunishmentSystemOptions } from './systems/punishmentSystem'

export {
  ACTIVITY_EVENTS,
  ROUTINE_EVENTS,
  ROUTINE_HOURS,
  RoutineBook,
  RoutineRuntime,
  assignRoutineHour,
  blockAtHour,
  blockDefOf,
  createInmateRoutineState,
  createRoutineBook,
  createRoutineState,
  goalSetForNeed,
  isRoutineBlockId,
  isSleepForbidden,
  isSleepForbiddenAt,
  manhattanTiles,
  permittedRoomsForBlock,
  preferredNeedForBlock,
  rankFreeChoice,
  scheduleForCategory,
  sessionMinutesForNeed,
  setCategoryRoutine,
} from './world/routine'
export type {
  FreeChoiceOption,
  InmateRoutineState,
  RoutineAssignment,
  RoutineBlockDef,
  RoutineRejection,
  ActivityRejection,
} from './world/routine'

export {
  ROUTINE_COMMANDS,
  ROUTINE_SYSTEM_NAME,
  ROUTINE_SYSTEM_PERIOD,
  createRoutineSystem,
  routineCommandHandlers,
} from './systems/routineSystem'
export type { RoutineSystemOptions } from './systems/routineSystem'

export {
  ACTIVITY_SYSTEM_NAME,
  ACTIVITY_SYSTEM_PERIOD,
  createActivitySystem,
} from './systems/activitySystem'
export type { ActivitySystemOptions } from './systems/activitySystem'

export {
  MAX_STAFF_ID,
  NO_STAFF,
  STAFF_EVENTS,
  EscortJobQueue,
  FogOfWar,
  OfficeClaimRegistry,
  StaffRegistry,
  enqueueEscort,
  fireStaff,
  hasCapability,
  hireStaff,
  inmateBlockedByLockedSecure,
  openDoorAt,
  staffDefOf,
  staffMayEnter,
} from './entities/staff'
export type {
  EscortJob,
  EscortJobState,
  EscortPurpose,
  HireRejection,
  HireStaffOptions,
  HireStaffResult,
  OfficeClaim,
  StaffComponent,
  StaffDuty,
  StaffEntity,
  StaffWorldView,
} from './entities/staff'

export {
  STAFF_COMMANDS,
  STAFF_SYSTEM_NAME,
  STAFF_SYSTEM_PERIOD,
  createStaffSystem,
  staffCommandHandlers,
} from './systems/staffSystem'
export type { StaffSystemOptions } from './systems/staffSystem'

export {
  NO_POST,
  NO_ROUTE,
  POST_COMMANDS,
  POST_EVENTS,
  POST_SYSTEM_NAME,
  POST_SYSTEM_PERIOD,
  PostRegistry,
  assignPosts,
  createPostSystem,
  isDeployable,
  isHourInRange,
  isHourInWindows,
  movePostedStaff,
  nextWaypointIndex,
  postAreaTiles,
  postCommandHandlers,
  stationTilesFor,
} from './systems/postSystem'
export type {
  HourRange,
  PatrolRoute,
  Post,
  PostSystemOptions,
  UnfilledReason,
} from './systems/postSystem'

export {
  MoraleState,
  MORALE_EVENTS,
  bribeChance,
  computeMorale,
  dangerContributionFromMorale,
  movementSpeedMultiplier,
  resolveSearchBribe,
  searchEffectiveness,
} from './entities/morale'
export type {
  MoraleInputs,
  ResolveSearchBribeOptions,
  SearchBribeResult,
  StrikePhase,
  StrikeSnapshot,
} from './entities/morale'

export {
  STAFF_NEEDS_COMMANDS,
  STAFF_NEEDS_EVENTS,
  STAFF_NEEDS_SYSTEM_NAME,
  STAFF_NEEDS_SYSTEM_PERIOD,
  applyStaffNeedFills,
  createStaffNeedsSystem,
  findBreakTarget,
  isEmergencyStaff,
  isStaffAccessibleRoom,
  isStaffAvailableForWork,
  meanStaffNeedSatisfaction,
  meanStaffWageRatio,
  peakStaffNeed,
  staffNeedsCommandHandlers,
} from './systems/staffNeedsSystem'
export type { StaffNeedsSystemOptions } from './systems/staffNeedsSystem'

export {
  JOB_EVENTS,
  JOB_KINDS,
  JOB_STATES,
  JOB_KIND_LABOUR,
  JOB_KIND_STAFF_ROLE,
  MAX_JOB_ID,
  NO_CLAIMANT,
  JobPool,
  effectivePriority,
  emitJobAbandoned,
  emitJobClaimed,
  emitJobEnqueued,
  isJobKind,
  isLabourRequiredRole,
  isStaffRequiredRole,
  jobAssignmentScore,
  tileXy,
  travelTimeTiles,
} from './entities/job'
export type {
  EnqueueJobOptions,
  Job,
  JobAbandonReason,
  JobAgingConfig,
  JobClaimantKind,
  JobKind,
  JobRequiredRole,
  JobState,
} from './entities/job'

export {
  JOB_SYSTEM_NAME,
  JOB_SYSTEM_PERIOD,
  completeJob,
  createJobSystem,
  postJob,
} from './systems/jobSystem'
export type { JobSystemOptions, PostJobOptions } from './systems/jobSystem'

export {
  MEAL_CHAIN_SYSTEM_NAME,
  MEAL_CHAIN_SYSTEM_PERIOD,
  MEAL_EVENTS,
  MEAL_QUANTITIES,
  MealLogistics,
  collectMealHours,
  createMealChainSystem,
  isMealQuantity,
  mealsPerHour,
  neededCookersFor,
  nextMealPrepWindow,
  requiredMealCount,
  roomCentroid,
  roomCentroidDistance,
  selectMessForKitchen,
  selectNearestMess,
  updateMealChain,
} from './systems/logistics/mealChain'
export type {
  KitchenPrepSession,
  MealChainSystemOptions,
  MealPrepWindow,
  MealQuantity,
  MealStandingOrders,
} from './systems/logistics/mealChain'

export {
  DELIVERIES_SYSTEM_NAME,
  DELIVERIES_SYSTEM_PERIOD,
  DELIVERY_EVENTS,
  DeliverySchedule,
  batchOrdersIntoTrucks,
  createDeliveriesSystem,
  nextTruckTick,
  truckIntervalTicks,
  updateDeliveries,
} from './systems/logistics/deliveries'
export type {
  DeliveriesSystemOptions,
  DeliveryLine,
  ScheduledTruck,
} from './systems/logistics/deliveries'

export {
  SUPPLY_EVENTS,
  SUPPLY_SYSTEM_NAME,
  SUPPLY_SYSTEM_PERIOD,
  SupplyLogistics,
  claimOpenCarryJobs,
  createSupplySystem,
  firstRoomTile,
  outstandingRequirement,
  roomsOfType,
  updateSupply,
} from './systems/logistics/supply'
export type {
  CarryHop,
  CarryMission,
  MaterialOrder,
  SupplySystemOptions,
} from './systems/logistics/supply'

export {
  CLEANING_EVENTS,
  CLEANING_SYSTEM_NAME,
  CLEANING_SYSTEM_PERIOD,
  CleaningLogistics,
  accrueAgentPassDirt,
  accrueBloodSpillDirt,
  accrueFoodWasteDirt,
  accrueUrinationDirt,
  addTileDirt,
  cleaningMinutesForDirt,
  countIndoorCleaners,
  countOutdoorCleaners,
  createCleaningSystem,
  floorDirtMultiplier,
  isInmateInWorkBlock,
  updateCleaning,
} from './systems/logistics/cleaning'
export type { CleaningSystemOptions } from './systems/logistics/cleaning'

export {
  LAUNDRY_EVENTS,
  LAUNDRY_SYSTEM_NAME,
  LAUNDRY_SYSTEM_PERIOD,
  LaundryLogistics,
  countLaundryLabour,
  createLaundrySystem,
  ironPerHour,
  selectHousingForLaundry,
  selectLaundryForHousing,
  uniformsPerHour,
  updateLaundry,
} from './systems/logistics/laundry'
export type { LaundrySystemOptions } from './systems/logistics/laundry'

export {
  ECONOMY_EVENTS,
  ECONOMY_SYSTEM_NAME,
  ECONOMY_SYSTEM_PERIOD,
  FACILITY_SOURCE_ID,
  FINANCE_CHART_DAYS,
  LEDGER_CATEGORIES,
  EconomyLedger,
  applyTax,
  billUtilities,
  chargeLoanInterest,
  createEconomyLedger,
  createEconomySystem,
  drainOutboxes,
  hasEconomy,
  payInmateDaily,
  payWages,
} from './systems/economySystem'
export type {
  CategoryBreakdown,
  DayCashflow,
  EconomyLedgerOptions,
  EconomySnapshot,
  EconomySystemOptions,
  EconomyWorldView,
  FinanceReport,
  LedgerCategory,
  LedgerEntry,
  LedgerPostInput,
} from './systems/economySystem'

export {
  CONTRACT_COMMANDS,
  CONTRACT_EVENTS,
  CONTRACT_SYSTEM_NAME,
  CONTRACT_SYSTEM_PERIOD,
  ContractBook,
  FacilityProgress,
  STARTING_CONTRACT_IDS,
  acceptContract,
  cancelContract,
  cancellationDebit,
  contractCommandHandlers,
  contractDefOf,
  contractsToReveal,
  countObjectsOfType,
  countRoomsAtGrade,
  countRoomsOfType,
  countStaffOfType,
  createContractBook,
  createContractSystem,
  evaluateAllPredicates,
  evaluatePredicate,
  evaluateRoomGrade,
  isContractAvailable,
  maxConcurrentContracts,
  meanNeed,
} from './systems/contractSystem'
export type {
  ActiveContract,
  ContractActionResult,
  ContractBookSnapshot,
  ContractLifecycle,
  ContractRejection,
  ContractSystemOptions,
  FinishedContract,
  PredicateContext,
} from './systems/contractSystem'

export {
  CONTRABAND_EVENTS,
  CONTRABAND_SYSTEM_NAME,
  CONTRABAND_SYSTEM_PERIOD,
  CONTRABAND_TRADE_PERIOD_DEFAULT,
  ContrabandState,
  addToInventory,
  applyArrivalPossession,
  arrangeThrowIn,
  attemptCraft,
  attemptRoomTheft,
  attemptVisitSmuggle,
  canArrangeThrowIn,
  computeContrabandPrice,
  contaminateDelivery,
  countCirculatingContraband,
  countGuardsInRoom,
  countInventoryItem,
  createContrabandState,
  createContrabandSystem,
  findPerimeterTile,
  flushPendingArrivals,
  grantItem,
  inmateSellsItem,
  inmateWantsItem,
  itemsCraftableInRoom,
  itemsSourcedFromRoom,
  measureMarket,
  refreshCirculationCount,
  removeFromInventory,
  resolveThrowIn,
  runHourlyMarket,
  staffAtTile,
  theftProbability,
  traitTheftModifier,
  updateContraband,
  visitSmuggleChance,
} from './systems/contrabandSystem'
export type {
  ArrangedThrowIn,
  ContrabandStash,
  ContrabandSystemOptions,
  DemandSupply,
} from './systems/contrabandSystem'

export {
  ACCESS,
  ACCESS_ALL,
  MAX_REGION_ID,
  NO_REGION,
  REGION_NEIGHBOURS,
  RegionGraph,
  accessMaskForDoor,
  isDoorTile,
  isRegionMember,
  meanCrossingDistance,
} from './pathfinding/regionGraph'
export type {
  AccessFlag,
  Region,
  RegionEdge,
  RegionGraphOptions,
  RegionRebuild,
} from './pathfinding/regionGraph'

export {
  EXIT_FLOOR_MATERIAL,
  FLOW_COST_DIAG,
  FLOW_COST_INF,
  FLOW_COST_ORTH,
  FLOW_DIR,
  FLOW_NEIGHBOURS,
  FLOW_STEP,
  FlowFieldCache,
  GOAL_SET,
  STANDARD_OBJECT_GOAL_DEFS,
  YARD_ROOM_ID,
  bruteForceIntegrationCosts,
  chunksCoveredByTiles,
  collectStandardGoals,
  generateFlowField,
  isWorkStationGoalSet,
  standTilesForObject,
  tilePassableForAccess,
  workStationGoalSetId,
} from './pathfinding/flowField'
export type {
  FlowDir,
  FlowField,
  FlowFieldCacheOptions,
  FlowFieldGenerateResult,
  FlowFieldTickResult,
  FlowGoalSources,
  StandardGoalSetId,
} from './pathfinding/flowField'

export {
  ASTAR_COST_INF,
  AStarScheduler,
  BinaryHeap,
  astarNeighbours,
  buildRegionBound,
  findPathAStar,
  octileHeuristic,
  regionForPathing,
} from './pathfinding/astar'
export type {
  AStarOptions,
  AStarRequest,
  AStarResult,
  AStarSchedulerOptions,
  AStarTickResult,
} from './pathfinding/astar'

export {
  buildOccupancy,
  resolveAvoidance,
} from './pathfinding/avoidance'
export type { AvoidanceAction, AvoidanceAgent, AvoidanceContext } from './pathfinding/avoidance'

export { DoorQueueRegistry, countDoorWaiters } from './pathfinding/doorQueue'
export type { DoorQueueOptions } from './pathfinding/doorQueue'

export {
  MobileAgentStore,
  PATHING_SYSTEM_NAME,
  PATHING_SYSTEM_PERIOD,
  createPathingSystem,
  isPathingWorld,
} from './systems/pathingSystem'
export type {
  AgentCategory,
  AgentStore,
  MobileAgent,
  PathingSystem,
  PathingSystemOptions,
  PathingWorld,
  SpawnAgentOptions,
} from './systems/pathingSystem'

export {
  InmateAgentStore,
  isInmateEscorted,
  syncInmateMotion,
} from './systems/inmateAgents'
export type { InmateAgentStoreOptions } from './systems/inmateAgents'

export {
  NAVIGATION_SYSTEM_NAME,
  NAVIGATION_SYSTEM_PERIOD,
  createNavigationSystem,
} from './systems/navigationSystem'
export type { NavigationSystemOptions } from './systems/navigationSystem'

export {
  MOVEMENT_SYSTEM_NAME,
  MOVEMENT_SYSTEM_PERIOD,
  createMovementSystem,
  stepMovement,
} from './systems/movementSystem'
export type { MovementSystem, MovementSystemOptions } from './systems/movementSystem'

export {
  CausalEventLog,
  REGISTERED_TRACE_KINDS,
  TRACE_BUFFER_CAPACITY,
  TRACE_KINDS,
  TRACE_MAX_DEPTH,
  eventDataObject,
} from './trace/causalEvent'
export type { CausalEvent, CausalEventLogOptions, EventId, TraceKind } from './trace/causalEvent'

export {
  PRD_STARVATION_EXAMPLE,
  TraceBuildError,
  buildTrace,
  catalogueCoversKinds,
  clearSuggestedFixes,
  emitPrdStarvationChain,
  isTraceKind,
  parseTraceStrings,
  registerSuggestedFixes,
  tickAt,
  traceStringsSchema,
} from './trace/traceBuilder'
export type {
  StarvationChainParams,
  SuggestedFix,
  SuggestedFixFn,
  TraceKindStrings,
  TraceNode,
  TraceStringCatalogue,
  TraceStringsFile,
  TraceView,
} from './trace/traceBuilder'

export {
  BLUEPRINT_COMMANDS,
  BLUEPRINT_ISSUE_KINDS,
  BUILD_ACTION_KINDS,
  Blueprint,
  actionFromJson,
  actionTiles,
  actionToJson,
  applyBuildActions,
  commitCommand,
  projectBlueprint,
  salvage,
  siteCancellationRefund,
  tileRestoreRefund,
  undoCommand,
  validateBlueprint,
} from './core/blueprint'
export type {
  BlueprintIssue,
  BlueprintIssueKind,
  BlueprintProjection,
  BlueprintReport,
  BlueprintStroke,
  BuildAction,
  BuildActionKind,
  BuildDeps,
  BuildLine,
  BuildRun,
  TileRestore,
} from './core/blueprint'

export {
  CommitLedger,
  UndoStack,
  blueprintCommandHandlers,
  captureInverse,
  captureInverses,
  commitRefund,
  createUndoStack,
  snapshotTile,
} from './core/undo'
export type { BlueprintCommands, BlueprintRejection, CommitRecord, UndoEntry } from './core/undo'
