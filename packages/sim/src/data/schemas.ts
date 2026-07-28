/**
 * Zod schemas for every game content definition (PRD 5, PRD 7.3).
 *
 * All balance numbers and content live in `packages/data/*.json` and are
 * validated here at load (CLAUDE.md rule 4). Nothing in this module knows how
 * to read a file; it only describes shapes. `loader.ts` does the reading, the
 * cross-reference checks and the indexing.
 *
 * Two conventions run through every schema:
 *
 *   - **Strict objects.** An unknown key is an error, never a silent no-op. A
 *     typo in a data file is the single most likely content bug and the one
 *     hardest to spot from behaviour alone.
 *   - **`_tuning: true`.** A definition whose numbers are placeholders the PRD
 *     does not specify carries this marker. T7.2 sweeps them; until then it is
 *     an honest record of what has actually been designed versus guessed.
 *
 * Optional fields with defaults mean "absent implies none": a missing
 * `servesNeeds` is an empty list, a missing `size` is one tile. Defaults are
 * never used to supply a balance number, which is why `cost` and `hp` are
 * required on every object even where the value is a placeholder.
 */

import { z } from 'zod'

/* -------------------------------------------------------------------------- */
/* Primitives                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Every definition id is `lower_snake_case`. Ids are written into saves and
 * used as cross-reference keys, so the constraint is worth enforcing rather
 * than discovering a `Cell` and a `cell` in the same file.
 */
export const ID_PATTERN = /^[a-z][a-z0-9_]*$/

const id = z.string().regex(ID_PATTERN, 'must be lower_snake_case')
const name = z.string().min(1)
const text = z.string().min(1)

/** Whole currency units. Negative money is never a definition, only a ledger entry. */
const money = z.number().int().min(0)
const rate = z.number().min(0)
const fraction = z.number().min(0).max(1)
const count = z.number().int().min(0)
const positiveCount = z.number().int().min(1)

/** The marker described in the module comment. Allowed on every definition. */
const tuning = { _tuning: z.literal(true).optional() }

/** A `_tuning`-aware strict object, so no schema below can forget either half. */
function def<T extends z.ZodRawShape>(shape: T) {
  return z.strictObject({ ...shape, ...tuning })
}

/* -------------------------------------------------------------------------- */
/* Shared enumerations                                                         */
/* -------------------------------------------------------------------------- */

/*
 * These are structural, not balance: they name the shapes the simulation can
 * actually implement. Adding a value here is a code change, which is the
 * point. Content that only needs a new number stays in JSON.
 */

export const ROOM_CATEGORIES = [
  'housing',
  'inmateActivity',
  'production',
  'staff',
  'logistics',
  'medical',
  'admin',
] as const

export const ROOM_PROPERTIES = ['enclosed', 'indoors', 'outdoors', 'secure'] as const

export const OBJECT_PLACEMENTS = ['floor', 'wall', 'door', 'ceiling'] as const

export const MATERIAL_SURFACES = ['floor', 'wall'] as const

/**
 * The door types of T1.2. Structural rather than content: each one maps onto a
 * distinct `passability` mask and a distinct lock behaviour that `world/doors`
 * implements, so a data file may tune a door's price but may not invent a
 * seventh kind that no system knows how to open.
 */
export const DOOR_TYPES = ['standard', 'secure', 'barred', 'staff', 'isolation', 'remote'] as const

/**
 * What drives a need's fill. PRD 5.4's table is explicit that several needs
 * are "driven by X, not time", which `fillPerMinute` alone cannot express.
 */
export const NEED_DRIVERS = [
  'time',
  'danger',
  'dirt',
  'proximity',
  'temperature',
  'confinement',
  'addiction',
] as const

export const CRITICAL_BEHAVIOURS = [
  'urinate',
  'starve',
  'seekWeapon',
  'digTunnel',
  'withdrawal',
  'exposure',
  'none',
] as const

export const RISK_TIERS = ['low', 'medium', 'high'] as const

/** Daily Routine block ids (T2.6, PRD 5.7). */
export const ROUTINE_BLOCKS = [
  'lockup',
  'sleep',
  'meal',
  'yard',
  'wash',
  'free',
  'work_free',
  'work_lockup',
] as const

export const STAFF_CAPABILITIES = [
  'administrate',
  'armed',
  'build',
  'carryStun',
  'clean',
  'cleanOutdoors',
  'cook',
  'detectContraband',
  'driveTruck',
  'escort',
  'handleDog',
  'hearing',
  'marksman',
  'minister',
  'openDoors',
  'patrol',
  'repair',
  'riotControl',
  'search',
  'serve',
  'treat',
  'tutor',
] as const

/**
 * How a painted sector treats traffic (T4.1, PRD 3.5). Structural: each mode
 * maps onto a distinct passability stamp and a distinct access mask that
 * `world/sectors` implements, so data may not invent a fifth.
 */
export const SECTOR_ACCESS_MODES = ['staffOnly', 'secure', 'shared', 'open'] as const

export type SectorAccessMode = (typeof SECTOR_ACCESS_MODES)[number]

export const DIRECTORATE_BRANCHES = ['root', 'security', 'legal', 'works', 'finance'] as const

export const PROGRAM_ATTENDANCE = ['referred', 'voluntary', 'mandatory', 'queue'] as const

export const PROGRAM_DIFFICULTIES = ['easy', 'intermediate', 'advanced'] as const

/** Inmate work assignments (PRD 5.7, 5.13). Gated by program completion. */
export const LABOUR_ASSIGNMENTS = [
  'kitchen',
  'laundry',
  'cleaning',
  'workshop',
  'library',
  'mail',
  'commissary',
  'grove',
] as const

export const STATUS_EFFECTS = [
  'angry',
  'bleeding',
  'calmed',
  'drunk',
  'exposure',
  'foodPoisoning',
  'high',
  'overdosed',
  'overheating',
  'riledUp',
  'sick',
  'stunned',
  'suppressed',
  'surrendered',
  'wellFed',
  'withdrawal',
] as const

export const CONTRABAND_CATEGORIES = ['weapon', 'tool', 'narcotic', 'luxury'] as const

/** Misconduct kinds (PRD 5.4 / T4.4). Order is severity for entitlement cuts. */
export const MISCONDUCT_KINDS = [
  'complaint',
  'contraband',
  'intoxication',
  'destruction',
  'attackInmate',
  'attackStaff',
  'seriousInjury',
  'homicide',
  'escapeAttempt',
] as const

/** Standing Orders punishment responses (PRD 5.4 / T4.3 stub). */
export const PUNISHMENT_KINDS = ['ignore', 'lockdown', 'isolation'] as const

/** Cell reassignment strictness on Standing Orders. */
export const REASSIGNMENT_STRICTNESS = ['off', 'lenient', 'strict'] as const

/** Load-shedding order, lowest priority shed first (PRD 5.12). */
export const POWER_PRIORITIES = ['lifeSafety', 'security', 'production', 'comfort'] as const

/** Events a contract can require a clean streak of. */
export const INCIDENT_KINDS = ['death', 'escape', 'riot', 'misconduct'] as const

/* -------------------------------------------------------------------------- */
/* balance.json                                                                */
/* -------------------------------------------------------------------------- */

const thresholdsSchema = z.strictObject({
  medium: z.number().min(0).max(100),
  high: z.number().min(0).max(100),
  critical: z.number().min(0).max(100),
})

/** One Routine block's location constraint and preferred need (T2.6). */
const routineBlockDefSchema = z.strictObject({
  permittedRooms: z.array(id).nonempty(),
  preferredNeed: id.nullable(),
  lockedUp: z.boolean(),
  /** Shared flow-field goal set id, or null when routing is per-inmate. */
  goalSet: id.nullable(),
  /** Prefer the inmate's assigned cell tile over a shared goal set. */
  ownCell: z.boolean(),
})

export const balanceSchema = z.strictObject({
  time: def({
    ticksPerMinute: positiveCount,
    minutesPerHour: positiveCount,
    hoursPerDay: positiveCount,
    /** PRD 5.5: one sentence year is 120 in-game hours. */
    hoursPerSentenceYear: positiveCount,
  }),

  map: def({
    sizes: z.strictObject({
      small: positiveCount,
      medium: positiveCount,
      large: positiveCount,
      huge: positiveCount,
    }),
    parcelSize: positiveCount,
    tileWorldUnits: positiveCount,
  }),

  needs: def({
    defaultThresholds: thresholdsSchema,
    /** Violence-escalating needs weigh this much more in the mood mean. */
    violenceWeightMultiplier: rate,
    /** PRD 5.4: freedom fills three times as fast while locked up. */
    freedomLockedUpMultiplier: rate,
    /** Degrees C below which the warmth need fills. */
    warmthColdThresholdC: z.number(),
    /**
     * Warmth need points per °C below `warmthColdThresholdC`. Chosen so a
     * tile at 0°C reaches critical (~88) before absolute zero extremes.
     */
    warmthPerDegreeBelow: rate,
    /** Maps 0..255 mean room dirt onto the 0..100 environment need. */
    environmentDirtScale: rate,
    /** Points of privacy need per nearby inmate. */
    privacyPerNeighbour: rate,
    /** Health lost each minute while food is at critical (starve behaviour). */
    starveDamagePerMinute: rate,
    /** Health lost each minute while warmth is at critical (exposure). */
    exposureDamagePerMinute: rate,
  }),

  misconduct: def({
    evaluationMinutes: positiveCount,
    /** Keyed by security category id. */
    baseRatePer10MinutesByCategory: z.record(id, fraction),
    criticalNeedStep: rate,
    suppressionFactor: fraction,
    instigatorFactor: rate,
    guardProximityMultiplier: fraction,
    guardProximityTiles: positiveCount,
    violentTraitMultiplier: rate,
    cellGrade: z.strictObject({ perPoint: rate, min: rate, max: rate }),
    kinds: z.array(z.enum(MISCONDUCT_KINDS)).min(1),
    kindBaseWeights: z.record(z.enum(MISCONDUCT_KINDS), rate),
    kindPerCriticalNeed: z.record(z.enum(MISCONDUCT_KINDS), rate),
    violentKindBonus: z.record(z.enum(MISCONDUCT_KINDS), rate),
    majorSeverityFrom: z.enum(MISCONDUCT_KINDS),
    homicideSentenceYears: positiveCount,
    reclassLadder: z.array(id).min(2),
    agitator: z.strictObject({
      reputationId: id,
      nearbyTiles: positiveCount,
      boostFactor: rate,
      boostMinutes: positiveCount,
    }),
  }),

  entitlement: def({
    start: count,
    max: count,
    perCleanDay: count,
    minorPenalty: count,
    reassignmentPeriodHours: positiveCount,
  }),

  suppression: def({
    lockdownMinutesPerPoint: positiveCount,
    isolationMinutesPerPoint: positiveCount,
    armedOfficerPerHour: rate,
    armedOfficerTiles: positiveCount,
    decayPerHour: rate,
    misconductFactor: fraction,
    programFactor: fraction,
    voluntaryRefusalThreshold: z.number().min(0).max(100),
    psychReferralThreshold: z.number().min(0).max(100),
    statusThreshold: z.number().min(0).max(100),
    reformPenaltyPerPoint: rate,
    stoicReputationId: id,
    max: z.number().min(0).max(100),
  }),

  punishment: def({
    /** Food need points cleared when a meal is delivered during a hold. */
    mealFoodRelief: rate,
    /**
     * Hours stored for indefinite holds in Standing Orders (`0` means
     * indefinite — homicide default). Finite holds use a positive hour count.
     */
    indefiniteHours: count,
  }),

  danger: def({
    recomputeMinutes: positiveCount,
    weights: z.strictObject({
      criticalNeeds: fraction,
      misconduct: fraction,
      armedInmates: fraction,
      staffMorale: fraction,
      guardCoverage: fraction,
      maxSecurityShare: fraction,
    }),
    misconductWindowHours: positiveCount,
    misconductScale: rate,
    armedScale: rate,
  }),

  riot: def({
    checkMinutes: positiveCount,
    baseProbability: fraction,
    dangerPivot: rate,
    dangerExponent: rate,
    agitatorFactor: rate,
    lockdownFactor: fraction,
    spreadTiles: positiveCount,
    containedMinutes: positiveCount,
  }),

  tunnels: def({
    tilesPerHourBase: rate,
    tilesPerHourVariance: rate,
    dogDetectionChance: fraction,
    dogDetectionTiles: positiveCount,
    cellSearchDetectionChance: fraction,
  }),

  morale: def({
    weights: z.strictObject({ needSatisfaction: fraction, wage: fraction, danger: fraction }),
    marketHourlyWage: rate,
    staffDeathPenalty: rate,
    staffDeathWindowDays: positiveCount,
    injuryPenalty: rate,
    searchEffectiveness: z.strictObject({ base: fraction, scale: fraction }),
    movementSpeed: z.strictObject({ base: fraction, scale: fraction }),
    bribeChance: z.strictObject({ pivot: rate, divisor: rate }),
    strikeThreshold: z.number().min(0).max(100),
    strikeHours: positiveCount,
    /** Fractional wage raise offered in a strike pay demand (accept path). */
    payDemandRaise: fraction,
    /** Hours after a strike ends before another can begin while morale stays low. */
    strikeCooldownHours: positiveCount,
    /** Base chance per hour of a repeat strike while morale is below threshold. */
    repeatStrikeBaseChance: fraction,
    /** Added to repeat-strike chance each time the player refuses a pay demand. */
    refuseStrikeChanceBonus: fraction,
  }),

  /**
   * Staff breaks and need discharge (T3.8, PRD 5.6). Timing and room routing
   * live here so the system never hardcodes break thresholds.
   */
  staffNeeds: def({
    /** Highest staff need that triggers a break once the current job ends. */
    breakThreshold: z.number().min(0).max(100),
    /** Break ends once every staff need is at or below this. */
    breakResumeBelow: z.number().min(0).max(100),
    /** Minutes seeking a staff room before the break is abandoned. */
    breakSeekTimeoutMinutes: positiveCount,
    /** Soft cap on a single break session (minutes), even if needs remain high. */
    breakMaxMinutes: positiveCount,
    /** Minutes between prison-wide morale recomputes. */
    recomputeMoraleMinutes: positiveCount,
    /**
     * Room def ids staff may use during breaks without a staff-only mark
     * (break room, store, control room, armoury, kennel, offices).
     */
    accessibleRoomDefIds: z.array(id).nonempty(),
    /**
     * Canteen-class rooms that are usable only when marked staff-only (or in a
     * staff-only sector). `mess_hall` is the v1 staff canteen.
     */
    staffOnlyCanteenDefIds: z.array(id).default([]),
  }),

  economy: def({
    startingFunds: money,
    taxRate: fraction,
    utilityCostPerWattHour: rate,
    utilityCostPerWaterUnit: rate,
    loan: z.strictObject({
      startingCap: money,
      maxCap: money,
      hourlyInterestRate: fraction,
    }),
    contractCancellationPenalty: fraction,
    maxConcurrentContracts: positiveCount,
    maxConcurrentContractsWithAdditional: positiveCount,
    demolishRefund: fraction,
    insolvencyCountdownHours: positiveCount,
  }),

  kitchen: def({
    /** PRD 5.13: mealsPerHour = cookers * base * (1 + assist * cooksAssigned). */
    mealsPerCookerPerHour: rate,
    cookAssistBonus: rate,
    preparationLeadHours: positiveCount,
    /** Standing-order meal quantity → required-meal multiplier. */
    quantityMultipliers: z.strictObject({
      low: rate,
      normal: rate,
      high: rate,
    }),
    defaultMealQuantity: z.enum(['low', 'normal', 'high']),
    defaultMealVariety: positiveCount,
    maxMealVariety: positiveCount,
    /** Distinct supply ids that count toward meal variety (PRD 5.13). */
    ingredientTypes: z.array(id).nonempty(),
    ingredientsPerMeal: positiveCount,
    /** Soft cap on cooked meals staged on one serving counter. */
    mealsPerServingCounter: positiveCount,
  }),

  logistics: def({
    truckIntervalHours: positiveCount,
    truckCapacity: positiveCount,
    dirt: z.strictObject({
      perAgentPass: count,
      perUrination: count,
      perBloodSpill: count,
      perFoodWaste: count,
      max: positiveCount,
    }),
    uniformDirtinessPerDay: rate,
    /** Indoor/outdoor cleaning throughput (T3.5). */
    cleaning: z.strictObject({
      dirtRemovedPerCleanerPerMinute: rate,
      dirtyTileThreshold: positiveCount,
      maxTilesTouchedPerMinute: positiveCount,
    }),
    /** Uniform wash / iron / collect / redistribute (T3.5). */
    laundry: z.strictObject({
      dirtyThreshold: positiveCount,
      uniformsPerMachinePerHour: rate,
      uniformsPerBoardPerHour: rate,
      labourAssistBonus: rate,
      collectPerWorkerPerMinute: rate,
      distributePerWorkerPerMinute: rate,
      basketCapacity: positiveCount,
    }),
  }),

  pathfinding: def({
    astarSearchesPerTick: positiveCount,
    flowFieldsPerTick: positiveCount,
    doorQueueThreshold: positiveCount,
    /**
     * Fixed cost of crossing a door edge in the region graph (T2.1). Paid once
     * per door on a coarse path, on top of the destination region's mean
     * crossing distance.
     */
    doorTraverseTicks: positiveCount,
    /**
     * World-unit displacement per tick by agent category (T2.3). Multiplied by
     * morale later (PRD 5.6); the raw values live here so movement never
     * hardcodes a speed.
     */
    speedsWorldUnitsPerTick: z.strictObject({
      inmate: rate,
      staff: rate,
    }),
  }),

  /**
   * Officer vision, door assistance and escort pickup (T2.7). Tunable so duty
   * radii are never hardcoded in `staffSystem`.
   */
  staff: def({
    /** Tiles of fog cleared around an officer each tick. */
    fogRadiusTiles: positiveCount,
    /** Distance at which an officer with `openDoors` unlocks a locked secure door. */
    doorOpenRadiusTiles: positiveCount,
    /** Officer must be this close to claim an escorted inmate as following. */
    escortPickupTiles: positiveCount,
    /** Idle officers re-pick a wander tile this often. */
    wanderPeriodTicks: positiveCount,
    /** How far an idle officer looks when choosing a wander destination. */
    wanderRadiusTiles: positiveCount,
  }),

  /** Painted sector defaults (T4.1, PRD 3.5). */
  sectors: def({
    /** Access mode a freshly painted sector starts on. */
    defaultAccess: z.enum(SECTOR_ACCESS_MODES),
  }),

  /**
   * Intent-based deployment (T4.1, PRD 3.5): how often posts are re-staffed,
   * how far apart posted officers stand, and how close counts as arrived.
   */
  posts: def({
    /** Reassignment cadence. PRD 3.5 re-solves deployment hourly. */
    assignmentPeriodHours: positiveCount,
    /** Officers on the same sector post stand at least this far apart. */
    stationSpacingTiles: positiveCount,
    /** Chebyshev distance at which a station or waypoint counts as reached. */
    arriveTiles: count,
    /** How often an unfilled post re-notifies, so the log does not flood. */
    unfilledReportPeriodHours: positiveCount,
    /** Ceiling on one patrol route's waypoint list. */
    maxWaypoints: positiveCount,
  }),

  /**
   * Job assignment scoring (T3.2). Aging raises effective priority each tick a
   * job sits open so low-priority work is not starved forever.
   */
  jobs: def({
    /** Added to base priority per tick the job has been open. */
    agingPerTick: rate,
    /** Floor for travel-time so co-located jobs do not divide by zero. */
    minTravelTime: positiveCount,
  }),

  /**
   * Bus arrivals and generation rolls (T2.4). Category weights apply only to
   * categories that arrive on a bus (`manualDesignationOnly: false`).
   */
  intake: def({
    busIntervalHours: positiveCount,
    maxPerBus: positiveCount,
    convictionCount: z.strictObject({ min: positiveCount, max: positiveCount }),
    addiction: z.strictObject({
      chanceWhenDependent: fraction,
      strengthMin: fraction,
      strengthMax: fraction,
    }),
    categoryWeights: z.record(id, rate),
  }),

  construction: def({
    undoDepth: positiveCount,
    materialRefundOnDemolish: fraction,
    /** The floor a foundation lays inside its perimeter walls (T1.2). */
    foundationFloorMaterial: id,
    /** Clearing a tile costs this share of the build time of what stood on it. */
    demolishMinutesFraction: fraction,
    /**
     * Isolated construction fixtures may set this true so sites do not wait on
     * T3.4 logistics. Production data keeps it false: materials arrive via
     * `supply` / `deliveries`.
     */
    stubMaterialDelivery: z.boolean(),
  }),

  rooms: def({
    /**
     * How many tiles the enclosure flood fill may walk before it concludes
     * that the space is not a sealed room (T1.3).
     *
     * A room bounded by its own walls and doors costs its own area to test. A
     * designation on open ground costs whatever open ground is reachable, so
     * without a ceiling one badly drawn rectangle would scan the map. A space
     * you can walk this far through without meeting a wall is, for the
     * purposes of `enclosed` and `secure`, outdoors.
     */
    enclosureFillLimit: positiveCount,
  }),

  /**
   * Daily Routine (T2.6, PRD 5.7): block → room constraints, sleep window,
   * free-choice weighting, and the default 24-hour strip per category.
   */
  routine: def({
    /** Inclusive start of the no-sleep window (PRD: no sleep 08:00–20:00). */
    sleepForbiddenFromHour: z.number().int().min(0).max(23),
    /** Exclusive end of the no-sleep window (hour 20 means sleep resumes at 20:00). */
    sleepForbiddenUntilHour: z.number().int().min(0).max(24),
    /**
     * Subtracted as `travelTimeWeight * travelMinutes` from a need value when
     * ranking free-choice destinations.
     */
    travelTimeWeight: rate,
    /** Cap on how long one object-use session may run. */
    maxSessionMinutes: positiveCount,
    minSessionMinutes: positiveCount,
    blocks: z.strictObject({
      lockup: routineBlockDefSchema,
      sleep: routineBlockDefSchema,
      meal: routineBlockDefSchema,
      yard: routineBlockDefSchema,
      wash: routineBlockDefSchema,
      free: routineBlockDefSchema,
      work_free: routineBlockDefSchema,
      work_lockup: routineBlockDefSchema,
    }),
    /** Keyed by security category; each value is exactly 24 block ids. */
    defaults: z.record(id, z.array(z.enum(ROUTINE_BLOCKS)).length(24)),
  }),

  programs: def({
    difficultyBase: z.strictObject({
      easy: fraction,
      intermediate: fraction,
      advanced: fraction,
    }),
    concentrationBase: fraction,
    concentrationScale: fraction,
    suppressionFactor: fraction,
    aptitude: z.strictObject({ min: rate, max: rate }),
  }),

  reoffend: def({
    base: fraction,
    basicLiteracy: rate,
    vocational: rate,
    joinery: rate,
    activeAddiction: rate,
    suppressionExposure: rate,
    healthGrade: rate,
    misconductRate: rate,
    min: fraction,
    max: fraction,
  }),

  parole: def({
    eligibilityFraction: fraction,
    hearingHours: positiveCount,
    deniedAngryHours: positiveCount,
    reoffendDelayDays: positiveCount,
  }),

  utilities: def({
    /** T1.4 places objects before the grids exist; false means always supplied. */
    utilitiesEnabled: z.boolean(),
    sheddingPriority: z.array(z.enum(POWER_PRIORITIES)).nonempty(),
    temperatureDiffusionTicks: positiveCount,
    outdoorTemperatureC: z.strictObject({ min: z.number(), max: z.number() }),
    waterUnitsPerFixture: rate,
  }),

  contraband: def({
    theftCheckMinutes: positiveCount,
    theftBaseChance: fraction,
    guardSuppressionFactor: fraction,
    /** Guards in the room at this count drive guardsInRoomFactor to 1. */
    guardsInRoomSaturateAt: positiveCount,
    traitTheftModifiers: z.record(id, rate),
    defaultTraitTheftModifier: rate,
    /** Chance a successful theft is hidden in the inmate's cell stash. */
    stashInCellChance: fraction,
    tradeCheckMinutes: positiveCount,
    priceDemandClamp: z.strictObject({ min: rate, max: rate }),
    throwInRangeTiles: positiveCount,
    throwInArrangeChance: fraction,
    throwInDelayMinutes: z.strictObject({ min: positiveCount, max: positiveCount }),
    metalDetector: z.strictObject({ base: fraction, moraleScale: fraction }),
    dogRadiusTiles: positiveCount,
    arrivalPossessionChanceByCategory: z.record(id, fraction),
    visitSmuggleChanceTables: fraction,
    visitSmuggleChanceBooths: fraction,
    craftCheckMinutes: positiveCount,
    craftBaseChance: fraction,
    startingMoney: z.strictObject({ min: money, max: money }),
    deliveryContaminationChance: fraction,
    /** Delivery stock item id → possible contraband item ids. */
    deliveryContamination: z.record(id, z.array(id).nonempty()),
  }),

  failure: def({
    uncontainedRiot: z.strictObject({ warningHours: positiveCount, thenHours: positiveCount }),
    insolvency: z.strictObject({ hours: positiveCount }),
    deaths: z.strictObject({ warningPerDay: positiveCount, thenNextDay: positiveCount }),
    escapes: z.strictObject({ warningPerDay: positiveCount, thenNextDay: positiveCount }),
    wardenDeaths: z.strictObject({ warning: positiveCount, thenAdditional: positiveCount }),
    paroleRecidivism: z.strictObject({ count: positiveCount, windowDays: positiveCount }),
    wrongfulExecutions: z.strictObject({ warning: positiveCount, thenAdditional: positiveCount }),
  }),

  /**
   * The vocabulary a Directorate node may unlock beyond rooms, objects, staff
   * and programs: panels, views and mechanics that have no definition of their
   * own. Listed here so `directorate.json` cannot invent a feature that no
   * system will ever gate.
   */
  features: z.array(id).nonempty(),
})

/* -------------------------------------------------------------------------- */
/* materials.json                                                              */
/* -------------------------------------------------------------------------- */

export const materialDefSchema = def({
  id,
  name,
  surfaces: z.array(z.enum(MATERIAL_SURFACES)).nonempty(),
  costPerTile: money,
  buildMinutes: rate,
  /** 0 never burns, 1 catches immediately (T4.8). */
  flammability: fraction,
  /** Multiplies dirt accrual on the tile (PRD 5.13). */
  dirtMultiplier: rate,
  /** Counts against a graded room via `materialPenalties` (PRD 5.2). */
  depressing: z.boolean(),
  unlockedBy: id.optional(),
})

/**
 * A door type's numbers and its two passability bits (T1.2).
 *
 * Doors live in `materials.json` because they are fabric, not furniture: a
 * door is built into a wall line by the construction queue, not placed in a
 * room like an `ObjectDef`. `staffOnly` and `secure` are the data half of the
 * `PASSABILITY` mask; `world/doors` derives the mask itself, so the two can
 * never disagree.
 */
export const doorDefSchema = def({
  id: z.enum(DOOR_TYPES),
  name,
  cost: money,
  buildMinutes: rate,
  /** Delivered before work starts. Each `itemId` names a material or a supply. */
  materials: z.array(z.strictObject({ itemId: id, units: positiveCount })).default([]),
  /** Inmates are refused regardless of sector permissions. */
  staffOnly: z.boolean(),
  /** Crossing needs a permission check (PRD 4.5). */
  secure: z.boolean(),
  lockable: z.boolean(),
  startsLocked: z.boolean(),
  /** Opens only from a control room desk (T4.6). */
  remoteControlled: z.boolean(),
  unlockedBy: id.optional(),
})

/** Bulk consumables a room buys automatically (`RoomDef.autoPurchase`). */
export const supplyDefSchema = def({
  id,
  name,
  unitCost: money,
})

export const materialsFileSchema = z.strictObject({
  materials: z.array(materialDefSchema).nonempty(),
  doors: z.array(doorDefSchema).nonempty(),
  supplies: z.array(supplyDefSchema).nonempty(),
})

/* -------------------------------------------------------------------------- */
/* needs.json                                                                  */
/* -------------------------------------------------------------------------- */

export const needDefSchema = def({
  id,
  name,
  driver: z.enum(NEED_DRIVERS),
  fillPerMinute: rate,
  decayOnUse: rate,
  escalatesToViolence: z.boolean(),
  criticalBehaviour: z.enum(CRITICAL_BEHAVIOURS).optional(),
  onlyWithTrait: id.optional(),
  staffAlso: z.boolean(),
  thresholds: thresholdsSchema,
})

export const needsFileSchema = z.strictObject({
  needs: z.array(needDefSchema).nonempty(),
})

/* -------------------------------------------------------------------------- */
/* rooms.json                                                                  */
/* -------------------------------------------------------------------------- */

const gradingRuleSetSchema = z.strictObject({
  min: z.number().int(),
  max: z.number().int(),
  objectPoints: z.array(
    z.strictObject({
      objectIds: z.array(id).nonempty(),
      points: z.number().int(),
      perCount: positiveCount.optional(),
      perOccupants: positiveCount.optional(),
    }),
  ),
  sizeThresholds: z.array(z.strictObject({ tiles: positiveCount, points: z.number().int() })),
  windowRule: z
    .strictObject({
      outdoorFacingBonus: z.number().int(),
      nonePenalty: z.number().int(),
      perOccupants: positiveCount.optional(),
    })
    .optional(),
  materialPenalties: z
    .array(z.strictObject({ materialIds: z.array(id).nonempty(), points: z.number().int() }))
    .optional(),
  /** Named rules evaluated in code by T5.2. */
  custom: z.array(id).optional(),
})

export const roomDefSchema = def({
  id,
  name,
  category: z.enum(ROOM_CATEGORIES),
  minTiles: count,
  minWidth: count,
  minHeight: count,
  properties: z.array(z.enum(ROOM_PROPERTIES)).default([]),
  requiredObjects: z
    .array(
      z.strictObject({
        objectId: id,
        count: positiveCount,
        perOccupant: rate.optional(),
      }),
    )
    .default([]),
  suggestedObjects: z.array(id).default([]),
  graded: z.boolean(),
  gradingRules: gradingRuleSetSchema.optional(),
  autoPurchase: z.array(z.strictObject({ itemId: id, perTile: rate })).optional(),
  servesNeeds: z.array(id).default([]),
  jobSlots: z.strictObject({ objectId: id, slotsPerObject: positiveCount }).optional(),
  unlockedBy: id.optional(),
})

export const roomsFileSchema = z.strictObject({
  rooms: z.array(roomDefSchema).nonempty(),
})

/* -------------------------------------------------------------------------- */
/* objects.json                                                                */
/* -------------------------------------------------------------------------- */

export const objectDefSchema = def({
  id,
  name,
  cost: money,
  size: z.strictObject({ w: positiveCount, h: positiveCount }).default({ w: 1, h: 1 }),
  rotatable: z.boolean().default(false),
  placement: z.enum(OBJECT_PLACEMENTS).default('floor'),
  /**
   * T1.4 placement rule: the whole footprint must sit inside one designated
   * room. `countsForRooms` cannot serve as this test — a metal detector counts
   * for the intake hall and belongs in the corridor outside it — so the
   * restriction is its own opt-in fact. Absent means the object may be placed
   * anywhere its surface allows.
   */
  requiresRoom: z.boolean().default(false),
  /** Watts. 0 means the object never needs a cable. */
  needsPower: count.default(0),
  needsWater: z.boolean().default(false),
  servesNeeds: z
    .array(
      z.strictObject({
        need: id,
        ratePerMinute: rate,
        concurrentUsers: positiveCount,
      }),
    )
    .default([]),
  countsForRooms: z.array(id).default([]),
  /** PRD 5.10: the room is the contraband source; this marks which room. */
  contrabandSourceFor: z.array(id).optional(),
  jobSlots: positiveCount.optional(),
  producesHeat: rate.optional(),
  destructible: z.boolean().default(true),
  hp: positiveCount,
  unlockedBy: id.optional(),
})

export const objectsFileSchema = z.strictObject({
  objects: z.array(objectDefSchema).nonempty(),
})

/* -------------------------------------------------------------------------- */
/* staff.json                                                                  */
/* -------------------------------------------------------------------------- */

export const staffDefSchema = def({
  id,
  name,
  hourlyWage: rate,
  hireCost: money,
  isAdministrator: z.boolean().default(false),
  requiresOffice: z.boolean().default(false),
  requiresRoom: id.optional(),
  requiresObjectPerHead: id.optional(),
  unlockedBy: id.optional(),
  needs: z.array(id).default([]),
  capabilities: z.array(z.enum(STAFF_CAPABILITIES)).default([]),
  /** Hired per session rather than employed (instructors, chaplains, panels). */
  perSession: z.boolean().default(false),
  /** Summoned by the emergency ladder rather than hired (PRD 3.7). */
  callable: z.boolean().default(false),
})

export const staffFileSchema = z.strictObject({
  staff: z.array(staffDefSchema).nonempty(),
})

/* -------------------------------------------------------------------------- */
/* directorate.json                                                            */
/* -------------------------------------------------------------------------- */

export const directorateNodeSchema = def({
  id,
  name,
  branch: z.enum(DIRECTORATE_BRANCHES),
  cost: money,
  /** Per unit on nodes that equip a per-head item, such as stun devices. */
  costPerHead: money.optional(),
  durationHours: positiveCount,
  prerequisites: z.array(id).default([]),
  /** The administrator who must be hired and have an office (PRD 5.8). */
  administrator: id,
  /**
   * Rooms, objects, staff and programs declare their own `unlockedBy`, so the
   * node lists only the features that have no definition to point at. The
   * loader derives the full unlock set from the back-references, which keeps
   * one side of the relationship authoritative.
   */
  unlocksFeatures: z.array(id).default([]),
  summary: text,
  /** The "why do I want this" copy from PRD 5.8. */
  why: text,
})

export const directorateFileSchema = z.strictObject({
  nodes: z.array(directorateNodeSchema).nonempty(),
})

/* -------------------------------------------------------------------------- */
/* programs.json                                                               */
/* -------------------------------------------------------------------------- */

const programEffectSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('reoffend'), delta: z.number() }),
  z.strictObject({ type: z.literal('addictionStrength'), multiplier: fraction }),
  z.strictObject({ type: z.literal('suppressNeedWhileEnrolled'), needId: id }),
  z.strictObject({ type: z.literal('traitMisconductMultiplier'), traitId: id, value: rate }),
  z.strictObject({ type: z.literal('unlockLabour'), assignment: z.enum(LABOUR_ASSIGNMENTS) }),
  z.strictObject({ type: z.literal('unlockProduction'), productionId: id }),
  z.strictObject({
    type: z.literal('applyStatus'),
    statusId: z.enum(STATUS_EFFECTS),
    hours: positiveCount,
    spreadTiles: count.optional(),
  }),
  z.strictObject({ type: z.literal('staffCapability'), capability: z.enum(STAFF_CAPABILITIES) }),
  z.strictObject({ type: z.literal('paroleHearing') }),
])

export const programDefSchema = def({
  id,
  name,
  costPerSession: money,
  seats: positiveCount,
  sessionsRequired: positiveCount,
  tutorStaffId: id,
  roomId: id,
  /** Session length. Programs schedule only into contiguous `work_*` blocks. */
  hours: positiveCount,
  attendance: z.enum(PROGRAM_ATTENDANCE),
  /** One object per seat, so the panel can say "room has 6, program needs 10". */
  seatObjectId: id.optional(),
  prerequisiteProgramId: id.optional(),
  difficulty: z.enum(PROGRAM_DIFFICULTIES),
  effects: z.array(programEffectSchema).default([]),
  unlockedBy: id.optional(),
})

export const programsFileSchema = z.strictObject({
  programs: z.array(programDefSchema).nonempty(),
})

/* -------------------------------------------------------------------------- */
/* contraband.json                                                             */
/* -------------------------------------------------------------------------- */

export const contrabandDefSchema = def({
  id,
  name,
  category: z.enum(CONTRABAND_CATEGORIES),
  /** HP per hit. 0 means the item is not a weapon. */
  attackPower: rate,
  rechargeMinutes: rate,
  /** Tiles. 0 is melee. */
  range: count,
  isMetal: z.boolean(),
  isOdorous: z.boolean(),
  canDigTunnel: z.boolean().default(false),
  canClimb: z.boolean().default(false),
  opensDoors: z.boolean().default(false),
  sourceRooms: z.array(id).default([]),
  craftableIn: z.array(id).default([]),
  smuggleable: z.boolean(),
  basePrice: money,
})

export const contrabandFileSchema = z.strictObject({
  items: z.array(contrabandDefSchema).nonempty(),
})

/* -------------------------------------------------------------------------- */
/* contracts.json                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Contract goals as declarative predicates over world state (T3.7). The
 * evaluator lands with the contract system; this ticket only guarantees that
 * every id a predicate names actually exists.
 */
const contractPredicateSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('roomCount'), roomId: id, min: positiveCount }),
  z.strictObject({
    type: z.literal('roomGrade'),
    roomId: id,
    minGrade: z.number().int(),
    count: positiveCount,
  }),
  z.strictObject({ type: z.literal('objectCount'), objectId: id, min: positiveCount }),
  z.strictObject({ type: z.literal('staffHired'), staffId: id, min: positiveCount }),
  z.strictObject({ type: z.literal('populationAtLeast'), min: positiveCount }),
  z.strictObject({ type: z.literal('capacityAtLeast'), min: positiveCount }),
  z.strictObject({ type: z.literal('programCompletions'), programId: id, min: positiveCount }),
  z.strictObject({ type: z.literal('directorateComplete'), nodeId: id }),
  z.strictObject({ type: z.literal('needBelow'), needId: id, maxMean: z.number().min(0).max(100) }),
  z.strictObject({
    type: z.literal('daysWithout'),
    incident: z.enum(INCIDENT_KINDS),
    days: positiveCount,
  }),
  z.strictObject({ type: z.literal('balanceAtLeast'), min: money }),
  z.strictObject({ type: z.literal('staffMoraleAtLeast'), min: z.number().min(0).max(100) }),
  z.strictObject({ type: z.literal('contrabandBelow'), maxItems: count }),
  z.strictObject({ type: z.literal('insolvencyImminent') }),
])

export const contractDefSchema = def({
  id,
  name,
  description: text,
  advance: money,
  completion: money,
  todoItems: z
    .array(z.strictObject({ label: text, predicate: contractPredicateSchema }))
    .nonempty(),
  prerequisites: z.array(id).default([]),
  hidden: z.boolean().default(false),
  revealWhen: z.array(contractPredicateSchema).optional(),
})

export const contractsFileSchema = z.strictObject({
  contracts: z.array(contractDefSchema).nonempty(),
})

/* -------------------------------------------------------------------------- */
/* inmates.json                                                                */
/* -------------------------------------------------------------------------- */

export const securityCategoryDefSchema = def({
  id,
  name,
  intakeFee: money,
  dailyPayment: money,
  riskTier: z.enum(RISK_TIERS),
  /** Never arrives on a bus; the player assigns it (PRD 5.5). */
  manualDesignationOnly: z.boolean().default(false),
  /** `condemned` inmates follow no routine (PRD 5.7). */
  followsRoutine: z.boolean().default(true),
  /** Minimum security never draws a dangerous trait. */
  allowsDangerousTraits: z.boolean().default(true),
  /** Multiplies every reputation's base chance during generation. */
  reputationChanceScale: rate,
  unlockedBy: id.optional(),
})

export const traitDefSchema = def({
  id,
  name,
  description: text,
  /** Excluded from minimum-security generation when true. */
  dangerous: z.boolean().default(false),
})

export const reputationDefSchema = def({
  id,
  name,
  description: text,
  baseChance: fraction,
  /** The apex tier, which implies several others (PRD 5.5: `notorious`). */
  apex: z.boolean().default(false),
})

export const convictionDefSchema = def({
  id,
  name,
  minYears: positiveCount,
  maxYears: positiveCount,
  riskTier: z.enum(RISK_TIERS),
  grantsTraits: z.array(id).default([]),
})

/** Original given / family pools for generation (T2.4). Never empty. */
export const inmateNamesSchema = z.strictObject({
  given: z.array(name).nonempty(),
  family: z.array(name).nonempty(),
})

export const inmatesFileSchema = z.strictObject({
  securityCategories: z.array(securityCategoryDefSchema).nonempty(),
  traits: z.array(traitDefSchema).nonempty(),
  reputations: z.array(reputationDefSchema).nonempty(),
  convictions: z.array(convictionDefSchema).nonempty(),
  names: inmateNamesSchema,
})

/* -------------------------------------------------------------------------- */
/* Inferred types                                                              */
/* -------------------------------------------------------------------------- */

export type Balance = z.infer<typeof balanceSchema>
export type MaterialDef = z.infer<typeof materialDefSchema>
export type DoorDef = z.infer<typeof doorDefSchema>
export type SupplyDef = z.infer<typeof supplyDefSchema>
export type NeedDef = z.infer<typeof needDefSchema>
export type GradingRuleSet = z.infer<typeof gradingRuleSetSchema>
export type RoomDef = z.infer<typeof roomDefSchema>
export type ObjectDef = z.infer<typeof objectDefSchema>
export type StaffDef = z.infer<typeof staffDefSchema>
export type DirectorateNode = z.infer<typeof directorateNodeSchema>
export type ProgramDef = z.infer<typeof programDefSchema>
export type ProgramEffect = z.infer<typeof programEffectSchema>
export type ContrabandDef = z.infer<typeof contrabandDefSchema>
export type ContractDef = z.infer<typeof contractDefSchema>
export type ContractPredicate = z.infer<typeof contractPredicateSchema>
export type SecurityCategoryDef = z.infer<typeof securityCategoryDefSchema>
export type TraitDef = z.infer<typeof traitDefSchema>
export type ReputationDef = z.infer<typeof reputationDefSchema>
export type ConvictionDef = z.infer<typeof convictionDefSchema>
export type InmateNames = z.infer<typeof inmateNamesSchema>

export type RoomCategory = (typeof ROOM_CATEGORIES)[number]
export type RoomProperty = (typeof ROOM_PROPERTIES)[number]
export type ObjectPlacement = (typeof OBJECT_PLACEMENTS)[number]
export type MaterialSurface = (typeof MATERIAL_SURFACES)[number]
export type DoorType = (typeof DOOR_TYPES)[number]
export type NeedDriver = (typeof NEED_DRIVERS)[number]
export type CriticalBehaviour = (typeof CRITICAL_BEHAVIOURS)[number]
export type RiskTier = (typeof RISK_TIERS)[number]
export type RoutineBlockId = (typeof ROUTINE_BLOCKS)[number]
export type StaffCapability = (typeof STAFF_CAPABILITIES)[number]
export type DirectorateBranch = (typeof DIRECTORATE_BRANCHES)[number]
export type ProgramAttendance = (typeof PROGRAM_ATTENDANCE)[number]
export type ProgramDifficulty = (typeof PROGRAM_DIFFICULTIES)[number]
export type LabourAssignment = (typeof LABOUR_ASSIGNMENTS)[number]
export type StatusEffectId = (typeof STATUS_EFFECTS)[number]
export type MisconductKind = (typeof MISCONDUCT_KINDS)[number]
export type PunishmentKind = (typeof PUNISHMENT_KINDS)[number]
export type ReassignmentStrictness = (typeof REASSIGNMENT_STRICTNESS)[number]
export type ContrabandCategory = (typeof CONTRABAND_CATEGORIES)[number]
export type PowerPriority = (typeof POWER_PRIORITIES)[number]
export type IncidentKind = (typeof INCIDENT_KINDS)[number]

/* -------------------------------------------------------------------------- */
/* File registry                                                               */
/* -------------------------------------------------------------------------- */

/** The data files, in the order the loader validates them. */
export const GAME_DATA_FILES = [
  'balance',
  'materials',
  'needs',
  'rooms',
  'objects',
  'staff',
  'directorate',
  'programs',
  'contraband',
  'contracts',
  'inmates',
] as const

export type GameDataFileName = (typeof GAME_DATA_FILES)[number]

/** Raw, unvalidated file contents keyed by file name (no `.json` suffix). */
export type RawGameDataFiles = Readonly<Record<GameDataFileName, unknown>>

export const FILE_SCHEMAS = {
  balance: balanceSchema,
  materials: materialsFileSchema,
  needs: needsFileSchema,
  rooms: roomsFileSchema,
  objects: objectsFileSchema,
  staff: staffFileSchema,
  directorate: directorateFileSchema,
  programs: programsFileSchema,
  contraband: contrabandFileSchema,
  contracts: contractsFileSchema,
  inmates: inmatesFileSchema,
} as const satisfies Record<GameDataFileName, z.ZodType>
