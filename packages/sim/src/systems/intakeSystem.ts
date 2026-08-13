/**
 * `IntakeSystem`: buses arrive, inmates are generated, fees are paid, and
 * housing is assigned (T2.4).
 *
 * Runs once per in-game hour. A bus is due when the clock reaches
 * `nextBusAtTick`. Continuous intake fills free bed capacity automatically;
 * manual intake drains the per-category request queue. Either way each arrival
 * credits the intake fee onto the economy ledger and walks the cell → holding
 * pen → intake hall assignment chain.
 *
 * Standing in the intake hall with nowhere to sleep is a `warn`: the event
 * kind is `intake.noHousing` and carries enough data for the Trace panel (T3.1)
 * to reconstruct why the inmate could not be housed.
 */

import { isJsonArray } from '../core/commands'
import type { Command, JsonValue } from '../core/commands'
import type { Fnv1aHasher } from '../core/hash'
import type { Rng } from '../core/rng'
import type {
  CommandHandler,
  EventSink,
  System,
  SystemContext,
  World,
} from '../core/simulation'
import type { GameData } from '../data/loader'
import {
  createInmateShell,
  findHousing,
  generateInmate,
  housingCapacity,
  inmateRoomContents,
  InmateRegistry,
  NO_INMATE,
} from '../entities/inmate'
import type { InmateEntity } from '../entities/inmate'
import { FAILURE_CONDITIONS, MUTATORS } from '../core/mapSettings'
import type { FailureCondition, Mutator } from '../core/mapSettings'
import { isUnlocked } from '../entities/directorate'
import { NeedsRuntime } from '../entities/needs'
import { ObjectRegistry, ObjectWorld } from '../entities/objects'
import { JobPool } from '../entities/job'
import {
  EscortJobQueue,
  FogOfWar,
  OfficeClaimRegistry,
  StaffRegistry,
  enqueueEscort,
} from '../entities/staff'
import { FlowFieldCache } from '../pathfinding/flowField'
import { RegionGraph } from '../pathfinding/regionGraph'
import { refreshPassabilityRect } from '../world/construction'
import { MaterialTable } from '../world/materials'
import { SectorRegistry } from '../world/sectors'
import { detectAllRooms } from '../world/roomDetection'
import type { RoomContents } from '../world/rooms'
import { NO_ROOM, RoomRegistry } from '../world/rooms'
import { createRoutineBook, RoutineRuntime } from '../world/routine'
import type { RoutineBook } from '../world/routine'
import { TileGrid } from '../world/tileGrid'
import type { TileGridBuffers } from '../world/tileGrid'
import { createEconomyLedger } from '../entities/economy'
import type { EconomyLedger } from '../entities/economy'
import { createContractBook } from '../entities/contracts'
import type { ContractBook } from '../entities/contracts'
import { MoraleState } from '../entities/morale'
import { InmateAgentStore } from './inmateAgents'
import { PostRegistry } from './postSystem'
import { MealLogistics } from './logistics/mealChain'
import { SupplyLogistics } from './logistics/supply'
import { DeliverySchedule } from './logistics/deliveries'
import { CleaningLogistics } from './logistics/cleaning'
import { LaundryLogistics } from './logistics/laundry'
import { createContrabandState } from '../entities/contraband'
import type { ContrabandState } from '../entities/contraband'
import {
  createDefaultStandingOrders,
  hashStandingOrders,
} from '../entities/standingOrders'
import type { StandingOrdersState } from '../entities/standingOrders'
import { createPunishmentRuntime } from '../entities/punishment'
import type { PunishmentRuntime } from '../entities/punishment'
import { CombatRuntime } from '../entities/health'
import { FireGrid } from '../world/fireGrid'
import { PowerGrid } from '../world/powerGrid'
import { WaterGrid } from '../world/waterGrid'
import { GradingRuntime } from './gradingSystem'
import { ProgramRuntime } from './programSystem'
import { GradesRuntime } from './gradesSystem'
import { ParoleRuntime } from './paroleSystem'
import { ReleaseRuntime } from './releaseSystem'
import { IntelligenceRuntime } from './intelligenceSystem'
import { LabourRuntime } from './labourSystem'
import { createEscapeState } from './escapeSystem'
import type { EscapeState } from './escapeSystem'
import {
  EmergencyState,
  MisconductWindow,
  RiotState,
} from '../entities/securityState'

/* -------------------------------------------------------------------------- */
/* Policy                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Player-facing intake controls (PRD 6.5 Intake panel).
 *
 * `requestedCounts` is only consulted while continuous intake is off. Counts
 * are drained as buses arrive; setting a count queues that many of the
 * category for the next buses.
 */
export interface IntakePolicy {
  continuous: boolean
  /** Keyed by security category id. */
  readonly requestedCounts: Map<string, number>
  /** Absolute tick of the next bus. */
  nextBusAtTick: number
}

export function createIntakePolicy(data: GameData, startTick = 0): IntakePolicy {
  return {
    continuous: true,
    requestedCounts: new Map(),
    nextBusAtTick: startTick + busIntervalTicks(data),
  }
}

export function busIntervalTicks(data: GameData): number {
  const { ticksPerMinute, minutesPerHour } = data.balance.time
  return data.balance.intake.busIntervalHours * minutesPerHour * ticksPerMinute
}

/* -------------------------------------------------------------------------- */
/* Map settings                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Map-level toggles (sandbox mutators). Staff needs default on per PRD 5.6.
 */
export interface MapRuntimeSettings {
  staffNeeds: boolean
  /**
   * Which failure conditions are armed (T6.5, PRD 5.15 / 7.9).
   *
   * Every one off is PRD 7.9's "no failure" mode. The checks consult this
   * rather than a separate flag, so there is one thing to be wrong about.
   */
  failures: Record<FailureCondition, boolean>
  /** Subsystems switched on. A mutator that is off stops its system dead. */
  mutators: Record<Mutator, boolean>
  /** Random events (T6.5). */
  randomEvents: boolean
}

export function createMapRuntimeSettings(): MapRuntimeSettings {
  const config = defaultRuntimeFlags()
  return {
    staffNeeds: true,
    failures: config.failures,
    mutators: config.mutators,
    randomEvents: true,
  }
}

function defaultRuntimeFlags(): {
  failures: Record<FailureCondition, boolean>
  mutators: Record<Mutator, boolean>
} {
  return {
    failures: Object.fromEntries(
      FAILURE_CONDITIONS.map((condition) => [condition, true]),
    ) as Record<FailureCondition, boolean>,
    mutators: Object.fromEntries(MUTATORS.map((mutator) => [mutator, true])) as Record<
      Mutator,
      boolean
    >,
  }
}

/** Whether a failure condition may fire in this prison (T6.5). */
export function failureArmed(world: InmateWorld, condition: FailureCondition): boolean {
  return world.settings.failures[condition]
}

/** Whether a subsystem is switched on in this prison (T6.5). */
export function mutatorEnabled(world: InmateWorld, mutator: Mutator): boolean {
  return world.settings.mutators[mutator]
}

/* -------------------------------------------------------------------------- */
/* World                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * An `ObjectWorld` that also holds inmates and the intake policy.
 *
 * The economy ledger lives here (T3.6). Intake fees post directly; construction
 * spend still stages on the outbox and is drained each hour.
 *
 * Pathfinding state (`regions`, `flowFields`, `agents`) lives here so the
 * composed game satisfies `PathingWorld` without a parallel agent store.
 */
export class InmateWorld extends ObjectWorld {
  readonly inmates: InmateRegistry
  readonly intake: IntakePolicy
  /** Per-inmate need activity state (using, latches, critical flags). */
  readonly needsRuntime: NeedsRuntime
  /** 24-hour Routine strips per security category (T2.6). */
  readonly routines: RoutineBook
  /** Per-inmate Routine / Activity assignment state (T2.6). */
  readonly routineRuntime: RoutineRuntime
  /** Hired staff (T2.7). */
  readonly staff: StaffRegistry
  /** Administrator office exclusivity and display names (T2.7). */
  readonly offices: OfficeClaimRegistry
  /** Escort jobs until the full job system absorbs them. */
  readonly escorts: EscortJobQueue
  /** General work pool (T3.2). */
  readonly jobs: JobPool
  /** Meal logistics chain (T3.3). */
  readonly meals: MealLogistics
  /** Construction supply and refuse piles (T3.4). */
  readonly supply: SupplyLogistics
  /** Inbound material / outbound refuse truck schedule (T3.4). */
  readonly deliveries: DeliverySchedule
  /** Dirt cleaning labour (T3.5). */
  readonly cleaning: CleaningLogistics
  /** Laundry uniform lifecycle (T3.5). */
  readonly laundry: LaundryLogistics
  /** Officer / camera fog revelation (T2.7). */
  readonly fog: FogOfWar
  /** Player-painted access sectors (T4.1). */
  readonly sectors: SectorRegistry
  /** Staffing intents and patrol routes (T4.1). */
  readonly posts: PostRegistry
  /** Coarse region graph for A* corridor bounds (T2.1). */
  readonly regions: RegionGraph
  /** Shared flow-field cache (T2.2). */
  readonly flowFields: FlowFieldCache
  /** Pathing facade over inmate shells (T2.3). */
  readonly agents: InmateAgentStore
  /** Prison ledger (T3.6). */
  readonly economy: EconomyLedger
  /** Contracts / grants (T3.7). */
  readonly contracts: ContractBook
  /** Prison-wide staff morale and strike state (T3.8). */
  readonly morale: MoraleState
  /** Illicit economy: stashes, throw-ins, live prices (T4.2). */
  readonly contraband: ContrabandState
  /** Standing Orders policy matrix (T4.3 / T4.4). */
  readonly standingOrders: StandingOrdersState
  /** Active punishment holds and agitator boosts (T4.4). */
  readonly punishments: PunishmentRuntime
  /**
   * Per-room cell grades for the misconduct cell-grade modifier (T5.2 writes;
   * until then stays empty and `averageCellGrade` is used).
   */
  readonly cellGrades = new Map<number, number>()
  /** Room grade breakdowns, sector grades and entitlement clocks (T5.2). */
  readonly grading = new GradingRuntime()
  /** Programme enrolment, schedules, sessions and blocking reasons (T5.3). */
  readonly programs = new ProgramRuntime()
  /** Confinement and suppression exposure behind the four grades (T5.4). */
  readonly grades = new GradesRuntime()
  /** Parole queue and hearing budget (T5.4). */
  readonly parole = new ParoleRuntime()
  /** Everyone who has left, and the re-offending ledger (T5.4). */
  readonly release = new ReleaseRuntime()
  /** Informants, revealed stashes and phone-tap intelligence (T5.6). */
  readonly intelligence = new IntelligenceRuntime()
  /** Inmate work assignments, production and the commissary (T5.7). */
  readonly labour = new LabourRuntime()
  /** Prison-wide mean cell grade used when a room has no entry. */
  averageCellGrade = 5
  /** Fights, injury, corpses (T4.5). */
  readonly combat: CombatRuntime
  /** Inmates already intake-searched this stay in the hall (T4.3). */
  readonly intakeSearchedInmateIds = new Set<number>()
  /** Sandbox / map mutators (staff needs default on). */
  readonly settings: MapRuntimeSettings
  /**
   * Room ids the player marked staff-only (staff-only canteen, etc.).
   * `staffOnlySectorRoomIds` is the sector-paint counterpart (T4.1).
   */
  readonly staffOnlyRoomIds = new Set<number>()
  /** Rooms whose tiles sit under a `staffOnly` sector (T4.1). */
  readonly staffOnlySectorRoomIds = new Set<number>()
  /**
   * Passability tiles waiting for a region / flow invalidation. Filled by
   * `refreshPassabilityRect`; drained by `navigation`.
   */
  readonly pathingDirtyTiles = new Set<number>()
  /**
   * Prison-wide danger 0..100. Written by DangerSystem (T4.6); needs read it
   * to drive the `safety` need until then tests set it directly. Staff morale
   * (T3.8) contributes its PRD 5.11 term into this value.
   */
  dangerLevel = 0
  /** Facility lockdown — claimed jobs abandon back to the pool (T3.2 / T4.x). */
  lockdownActive = false
  /** Active riot — claimed jobs abandon back to the pool (T3.2 / T4.x). */
  riotActive = false
  /** Rolling misconduct ticks for the danger formula (T4.6; T4.4 writes). */
  readonly misconductWindow = new MisconductWindow()
  /** Active riot membership and door-break progress (T4.6). */
  readonly riot = new RiotState()
  /** Emergency ladder and riot-failure countdown (T4.6). */
  readonly emergency = new EmergencyState()
  /** Per-tile fire intensity and smoke (T4.8). */
  readonly fire: FireGrid
  /** Electrical cable overlay and shed branches (T5.5). */
  readonly power: PowerGrid
  /** Water pipe overlay and flow multipliers (T5.5). */
  readonly water: WaterGrid
  /** Escapes, tunnels and failure accounting (T4.7). */
  readonly escapes: EscapeState

  readonly #inmateContents: RoomContents
  #income = 0

  constructor(
    grid: TileGrid,
    materials: MaterialTable,
    rooms: RoomRegistry,
    objects: ObjectRegistry,
    data: GameData,
    inmates: InmateRegistry = new InmateRegistry(),
    intake: IntakePolicy = createIntakePolicy(data),
    needsRuntime: NeedsRuntime = new NeedsRuntime(data.needs.size),
    routines: RoutineBook = createRoutineBook(data),
    routineRuntime: RoutineRuntime = new RoutineRuntime(),
    staff: StaffRegistry = new StaffRegistry(),
    offices: OfficeClaimRegistry = new OfficeClaimRegistry(),
    escorts: EscortJobQueue = new EscortJobQueue(),
    fog: FogOfWar = new FogOfWar(grid.size),
    jobs: JobPool = new JobPool(),
    meals: MealLogistics = new MealLogistics(data.balance.kitchen),
    supply: SupplyLogistics = new SupplyLogistics(),
    deliveries: DeliverySchedule = new DeliverySchedule(),
    cleaning: CleaningLogistics = new CleaningLogistics(),
    laundry: LaundryLogistics = new LaundryLogistics(),
    economy: EconomyLedger = createEconomyLedger(data),
    contracts: ContractBook = createContractBook(),
    morale: MoraleState = new MoraleState(),
    contraband: ContrabandState = createContrabandState(),
    combat: CombatRuntime = new CombatRuntime(),
    settings: MapRuntimeSettings = createMapRuntimeSettings(),
  ) {
    super(grid, materials, rooms, objects, data)
    this.inmates = inmates
    this.intake = intake
    this.needsRuntime = needsRuntime
    this.routines = routines
    this.routineRuntime = routineRuntime
    this.staff = staff
    this.offices = offices
    this.escorts = escorts
    this.fog = fog
    this.jobs = jobs
    this.meals = meals
    this.supply = supply
    this.deliveries = deliveries
    this.cleaning = cleaning
    this.laundry = laundry
    this.economy = economy
    this.contracts = contracts
    this.morale = morale
    this.contraband = contraband
    this.standingOrders = createDefaultStandingOrders()
    this.punishments = createPunishmentRuntime()
    this.combat = combat
    this.escapes = createEscapeState()
    this.fire = new FireGrid(grid.size)
    this.power = new PowerGrid(grid.size)
    this.water = new WaterGrid(grid.size)
    this.settings = settings
    this.sectors = new SectorRegistry(grid.size)
    this.posts = new PostRegistry()
    this.regions = new RegionGraph(grid.size, {
      doorTraverseTicks: data.balance.pathfinding.doorTraverseTicks,
    })
    this.flowFields = new FlowFieldCache(grid.size, {
      flowFieldsPerTick: data.balance.pathfinding.flowFieldsPerTick,
    })
    this.agents = new InmateAgentStore({
      inmates,
      escorts,
      tileWorldUnits: data.balance.map.tileWorldUnits,
      inmateSpeed: data.balance.pathfinding.speedsWorldUnitsPerTick.inmate,
      fire: this.fire,
      data,
    })
    this.#inmateContents = inmateRoomContents(objects, inmates)
  }

  override contents(): RoomContents {
    return this.#inmateContents
  }

  get incomeOwed(): number {
    return this.#income
  }

  addIncome(amount: number): void {
    this.#income += amount
  }

  takeIncome(): number {
    const owed = this.#income
    this.#income = 0
    return owed
  }

  override hashInto(hasher: Fnv1aHasher): void {
    super.hashInto(hasher)
    this.inmates.hashInto(hasher)
    this.needsRuntime.hashInto(hasher)
    this.routines.hashInto(hasher)
    this.routineRuntime.hashInto(hasher)
    this.staff.hashInto(hasher)
    this.offices.hashInto(hasher)
    this.grading.hashInto(hasher)
    this.programs.hashInto(hasher)
    this.grades.hashInto(hasher)
    this.parole.hashInto(hasher)
    this.release.hashInto(hasher)
    this.intelligence.hashInto(hasher)
    this.labour.hashInto(hasher)
    this.escorts.hashInto(hasher)
    this.jobs.hashInto(hasher)
    this.meals.hashInto(hasher)
    this.supply.hashInto(hasher)
    this.deliveries.hashInto(hasher)
    this.cleaning.hashInto(hasher)
    this.laundry.hashInto(hasher)
    this.fog.hashInto(hasher)
    this.morale.hashInto(hasher)
    this.contraband.hashInto(hasher)
    hashStandingOrders(hasher, this.standingOrders)
    this.punishments.hashInto(hasher)
    hasher.writeFloat64(this.averageCellGrade)
    const grades = [...this.cellGrades.entries()].sort((a, b) => a[0] - b[0])
    hasher.writeUint32(grades.length)
    for (const [roomId, grade] of grades) {
      hasher.writeUint32(roomId)
      hasher.writeFloat64(grade)
    }
    this.combat.hashInto(hasher)
    hasher.writeUint32(this.intakeSearchedInmateIds.size)
    for (const id of [...this.intakeSearchedInmateIds].sort((a, b) => a - b)) {
      hasher.writeUint32(id)
    }
    this.sectors.hashInto(hasher)
    this.posts.hashInto(hasher)
    hasher.writeUint32(this.settings.staffNeeds ? 1 : 0)
    hasher.writeUint32(this.staffOnlyRoomIds.size)
    for (const roomId of [...this.staffOnlyRoomIds].sort((a, b) => a - b)) {
      hasher.writeUint32(roomId)
    }
    hasher.writeFloat64(this.dangerLevel)
    hasher.writeUint32(this.lockdownActive ? 1 : 0)
    hasher.writeUint32(this.riotActive ? 1 : 0)
    this.misconductWindow.hashInto(hasher)
    this.riot.hashInto(hasher)
    this.emergency.hashInto(hasher)
    this.fire.hashInto(hasher)
    this.power.hashInto(hasher)
    this.water.hashInto(hasher)
    this.escapes.hashInto(hasher)
    hasher.writeUint32(this.#income)
    this.economy.hashInto(hasher)
    this.contracts.hashInto(hasher)
    hasher.writeUint32(this.intake.continuous ? 1 : 0)
    hasher.writeUint32(this.intake.nextBusAtTick)
    const requests = [...this.intake.requestedCounts.entries()].sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0,
    )
    hasher.writeUint32(requests.length)
    for (const [category, count] of requests) {
      hasher.writeString(category)
      hasher.writeUint32(count)
    }
  }
}

export function isInmateWorld(world: World): world is InmateWorld {
  return world instanceof InmateWorld
}

export interface CreateInmateWorldOptions {
  readonly size: number
  readonly data: GameData
  readonly buffers?: TileGridBuffers
  readonly continuousIntake?: boolean
  /**
   * Directorate state to start from (T5.1). Defaults to `'none'`, matching
   * `createGame`: research changes more than what may be built — tax rates,
   * contract caps, routing overrides — so a scenario that silently started
   * fully researched would be measuring a different prison than the player's.
   * Scenarios about some other system pass `'all'` to get the tree out of the
   * way.
   */
  readonly research?: 'all' | 'none'
}

export function createInmateWorld(options: CreateInmateWorldOptions): InmateWorld {
  const { size, data } = options

  const grid =
    options.buffers === undefined
      ? TileGrid.allocate(size)
      : TileGrid.fromBuffers(size, options.buffers)

  const intake = createIntakePolicy(data)
  if (options.continuousIntake !== undefined) {
    intake.continuous = options.continuousIntake
  }

  const world = new InmateWorld(
    grid,
    MaterialTable.from(data.materials.ids()),
    new RoomRegistry(size, data.rooms.ids()),
    new ObjectRegistry(),
    data,
    new InmateRegistry(),
    intake,
  )

  if (options.research === 'all') world.directorate.grantAll(data)

  world.grid.fill('outdoors', 1)
  world.meals.standingOrders.quantity = world.standingOrders.mealQuantity
  world.meals.standingOrders.variety = world.standingOrders.mealVariety
  refreshPassabilityRect(world, data)
  detectAllRooms({
    world,
    data,
    events: {
      emit(): void {
        // Initial detection is not player news.
      },
    },
    tick: 0,
  })
  world.sectors.reindex(data, world.grid)
  world.regions.rebuildAll(world.grid, world.doors, data, world.sectors)
  world.flowFields.refreshStandardGoals({
    grid: world.grid,
    objects: world.objects,
    rooms: world.rooms,
    materials: world.materials,
    data,
  })
  world.grid.markAllDirty()
  return world
}

/* -------------------------------------------------------------------------- */
/* Arrival                                                                     */
/* -------------------------------------------------------------------------- */

export interface ArriveInmateOptions {
  readonly world: InmateWorld
  readonly data: GameData
  readonly rng: Rng
  readonly events: EventSink
  readonly tick: number
  readonly category?: string
}

/**
 * Generates one inmate, pays the intake fee, assigns housing, and emits the
 * no-housing warning when they are left standing in reception.
 */
export function arriveInmate(options: ArriveInmateOptions): InmateEntity | undefined {
  const { world, data, events, tick } = options
  const component = generateInmate({
    data,
    rng: options.rng.stream('intake'),
    ...(options.category === undefined ? {} : { category: options.category }),
  })

  const id = world.inmates.allocateId()
  if (id === NO_INMATE) {
    events.emit({
      tick,
      kind: 'intake.rejected',
      causeIds: [],
      data: { reason: 'id-exhausted' },
    })
    return undefined
  }

  const tileWorldUnits = data.balance.map.tileWorldUnits
  const entity = createInmateShell({
    id,
    data,
    inmate: component,
    tx: 0,
    ty: 0,
    x: tileWorldUnits * 0.5,
    y: tileWorldUnits * 0.5,
  })
  world.inmates.add(entity)

  const category = data.securityCategories.get(component.category)
  const fee = category.intakeFee
  if (fee > 0) {
    world.economy.credit(tick, 'intake_fee', fee, `Intake fee (${category.name})`, entity.id)
  }

  // Exclude this inmate from the free-cell search: they are already in the
  // registry with cellId NO_ROOM, so occupied cells are unaffected.
  const housing = findHousing(
    world.rooms,
    world.inmates,
    component.category,
    component.entitlement,
  )

  if (housing.kind === 'cell') {
    // Reserve the cell, stage the inmate at reception, and queue an escort
    // (T2.7). Officers walk them in; without staff the assignment stays open.
    world.inmates.assignHousing(entity.id, housing.roomId)
    const staging = findStagingRoom(world)
    if (staging !== undefined) placeInRoom(world, entity, staging)
    const dest = destinationTileForRoom(world, housing.roomId)
    if (dest !== undefined) {
      enqueueEscort({
        world,
        inmateId: entity.id,
        destinationTile: dest,
        purpose: 'cell_assignment',
        events,
        tick,
      })
    }
  } else if (housing.kind === 'holding_pen') {
    world.inmates.assignHousing(entity.id, housing.roomId)
    placeInRoom(world, entity, housing.roomId)
  } else if (housing.kind === 'intake_hall') {
    world.inmates.assignHousing(entity.id, housing.roomId)
    placeInRoom(world, entity, housing.roomId)
    emitNoHousing(events, tick, entity, housing.roomId, 'no-free-cell-or-holding-pen')
  } else {
    emitNoHousing(events, tick, entity, NO_ROOM, 'no-free-cell-holding-pen-or-intake-hall')
  }

  events.emit({
    tick,
    kind: 'intake.arrived',
    causeIds: [],
    data: {
      inmateId: entity.id,
      category: component.category,
      fee,
      housing: housing.kind,
      roomId: housing.roomId,
    },
  })

  // Queued for ContrabandSystem so intake does not import the system module
  // (avoids a circular dependency). Flushed on the next contraband tick and
  // also available via flushPendingArrivals for tests / immediate callers.
  world.contraband.queueArrival(entity.id)

  return entity
}

function emitNoHousing(
  events: EventSink,
  tick: number,
  entity: InmateEntity,
  roomId: number,
  reason: string,
): void {
  events.emit({
    tick,
    kind: 'intake.noHousing',
    causeIds: [],
    data: {
      inmateId: entity.id,
      category: entity.inmate.category,
      entitlement: entity.inmate.entitlement,
      roomId,
      severity: 'warn',
      reason,
    },
  })
}

function placeInRoom(world: InmateWorld, entity: InmateEntity, roomId: number): void {
  const room = world.rooms.get(roomId)
  if (room === undefined || room.tiles.length === 0) return
  const tileIndex = room.tiles[0]
  if (tileIndex === undefined) return
  const { x, y } = world.grid.xy(tileIndex)
  const units = world.data.balance.map.tileWorldUnits
  entity.tx = x
  entity.ty = y
  entity.x = (x + 0.5) * units
  entity.y = (y + 0.5) * units
}

/** Prefer a functional intake hall for staging escorted arrivals. */
function findStagingRoom(world: InmateWorld): number | undefined {
  for (const room of world.rooms.all()) {
    if (room.defId !== 'intake_hall') continue
    const status = world.rooms.statusOf(room.id)
    if (status !== undefined && status.functional) return room.id
  }
  return undefined
}

function destinationTileForRoom(world: InmateWorld, roomId: number): number | undefined {
  const room = world.rooms.get(roomId)
  if (room === undefined || room.tiles.length === 0) return undefined
  return room.tiles[0]
}

/* -------------------------------------------------------------------------- */
/* Bus                                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Runs one due bus: fill seats from continuous weights or the request queue,
 * then schedule the next bus.
 *
 * Safe to call when no bus is due; returns 0 arrivals.
 */
export function runBusArrival(
  world: InmateWorld,
  data: GameData,
  rng: Rng,
  events: EventSink,
  tick: number,
): number {
  if (tick < world.intake.nextBusAtTick) return 0

  const capacity = housingCapacity(world.rooms, world.objects)
  const free = Math.max(0, capacity - world.inmates.size)
  const seats = Math.min(free, data.balance.intake.maxPerBus)

  let arrived = 0
  if (seats > 0) {
    if (world.intake.continuous) {
      for (let i = 0; i < seats; i += 1) {
        const entity = arriveInmate({ world, data, rng, events, tick })
        if (entity !== undefined) arrived += 1
      }
    } else {
      for (const category of drainRequests(world.intake, seats)) {
        const entity = arriveInmate({ world, data, rng, events, tick, category })
        if (entity !== undefined) arrived += 1
      }
    }
  }

  // Advance even when the bus was empty so continuous intake retries next interval.
  world.intake.nextBusAtTick = tick + busIntervalTicks(data)
  return arrived
}

function drainRequests(policy: IntakePolicy, seats: number): string[] {
  const categories: string[] = []
  const keys = [...policy.requestedCounts.keys()].sort()
  for (const category of keys) {
    if (categories.length >= seats) break
    let remaining = policy.requestedCounts.get(category) ?? 0
    while (remaining > 0 && categories.length < seats) {
      categories.push(category)
      remaining -= 1
    }
    if (remaining > 0) policy.requestedCounts.set(category, remaining)
    else policy.requestedCounts.delete(category)
  }
  return categories
}

/* -------------------------------------------------------------------------- */
/* System                                                                      */
/* -------------------------------------------------------------------------- */

export interface IntakeSystemOptions {
  readonly data: GameData
}

export const INTAKE_SYSTEM_NAME = 'intake'

/** Hourly: bus ETA is in hours, and capacity checks are cheap. */
export const INTAKE_SYSTEM_PERIOD = 600

export function createIntakeSystem(options: IntakeSystemOptions): System {
  const { data } = options
  const period =
    data.balance.time.ticksPerMinute * data.balance.time.minutesPerHour
  let reportedWrongWorld = false

  return {
    name: INTAKE_SYSTEM_NAME,
    period,

    update(context: SystemContext): void {
      const tick = context.clock.tick
      if (!isInmateWorld(context.world)) {
        if (reportedWrongWorld) return
        reportedWrongWorld = true
        context.events.emit({
          tick,
          kind: 'intake.rejected',
          causeIds: [],
          data: { command: INTAKE_SYSTEM_NAME, reason: 'wrong-world' },
        })
        return
      }

      runBusArrival(context.world, data, context.rng, context.events, tick)
    },
  }
}

/* -------------------------------------------------------------------------- */
/* Commands                                                                    */
/* -------------------------------------------------------------------------- */

export const INTAKE_COMMANDS = {
  setContinuous: 'intake.setContinuous',
  setRequested: 'intake.setRequested',
  clearRequested: 'intake.clearRequested',
} as const

export function intakeCommandHandlers(data: GameData): Readonly<Record<string, CommandHandler>> {
  return {
    [INTAKE_COMMANDS.setContinuous]: (command, context) => {
      handleSetContinuous(command, context, data)
    },
    [INTAKE_COMMANDS.setRequested]: (command, context) => {
      handleSetRequested(command, context, data)
    },
    [INTAKE_COMMANDS.clearRequested]: (command, context) => {
      handleClearRequested(command, context)
    },
  }
}

function handleSetContinuous(command: Command, context: SystemContext, _data: GameData): void {
  if (!isInmateWorld(context.world)) {
    reject(context, command, 'wrong-world')
    return
  }
  const continuous = readBoolean(command.payload, 'continuous')
  if (continuous === undefined) {
    reject(context, command, 'malformed-payload')
    return
  }
  context.world.intake.continuous = continuous
}

function handleSetRequested(command: Command, context: SystemContext, data: GameData): void {
  if (!isInmateWorld(context.world)) {
    reject(context, command, 'wrong-world')
    return
  }
  const category = readString(command.payload, 'category')
  const count = readNonNegativeInt(command.payload, 'count')
  if (category === undefined || count === undefined) {
    reject(context, command, 'malformed-payload')
    return
  }
  if (!data.securityCategories.has(category)) {
    reject(context, command, 'unknown-category')
    return
  }
  if (!isUnlocked(data, context.world.directorate, 'securityCategories', category)) {
    reject(context, command, 'locked')
    return
  }
  const def = data.securityCategories.get(category)
  if (def.manualDesignationOnly) {
    reject(context, command, 'manual-designation-only')
    return
  }
  if (count === 0) context.world.intake.requestedCounts.delete(category)
  else context.world.intake.requestedCounts.set(category, count)
}

function handleClearRequested(command: Command, context: SystemContext): void {
  if (!isInmateWorld(context.world)) {
    reject(context, command, 'wrong-world')
    return
  }
  context.world.intake.requestedCounts.clear()
}

function reject(context: SystemContext, command: Command, reason: string): void {
  context.events.emit({
    tick: context.clock.tick,
    kind: 'intake.rejected',
    causeIds: [],
    data: { command: command.type, reason },
  })
}

function readBoolean(payload: JsonValue, key: string): boolean | undefined {
  if (payload === null || typeof payload !== 'object' || isJsonArray(payload)) return undefined
  const value = payload[key]
  return typeof value === 'boolean' ? value : undefined
}

function readString(payload: JsonValue, key: string): string | undefined {
  if (payload === null || typeof payload !== 'object' || isJsonArray(payload)) return undefined
  const value = payload[key]
  return typeof value === 'string' ? value : undefined
}

function readNonNegativeInt(payload: JsonValue, key: string): number | undefined {
  if (payload === null || typeof payload !== 'object' || isJsonArray(payload)) return undefined
  const value = payload[key]
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) return undefined
  return value
}
