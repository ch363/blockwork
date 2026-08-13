/**
 * A populated `SaveState` for the save tests.
 *
 * Built from seeded RNG streams rather than literals so the grid and the
 * entities have real variety in them — a save format that round-trips a field
 * of zeroes proves very little — while staying identical between runs, which
 * is the whole point of the determinism assertions it feeds.
 */

import { Rng } from '../../src/core/rng'
import type { RngState } from '../../src/core/rng'
import {
  defaultStandingOrdersState,
  emptyCellGradesState,
  emptyCleaningState,
  emptyCombatState,
  emptyConstructionState,
  emptyContrabandState,
  emptyContractState,
  emptyDeliveriesState,
  emptyDoorsState,
  emptyEconomyState,
  emptyEmergencyState,
  emptyEntityRegistryState,
  emptyEscapesState,
  emptyEscortsState,
  emptyFireState,
  emptyFogState,
  emptyIntakeState,
  emptyJobsState,
  emptyLabourState,
  emptyLaundryState,
  emptyMealsState,
  emptyMoraleState,
  emptyNeedsRuntimeState,
  emptyOfficesState,
  emptyPunishmentsState,
  emptyRiotState,
  emptyRoutineRuntimeState,
  emptySupplyState,
  emptyUtilitiesState,
} from '../../src/save/defaults'
import type { SaveState } from '../../src/save/state'
import { TILE_FIELDS, TileGrid } from '../../src/world/tileGrid'

/** PRD 4.3's Large preset, and the size the acceptance criterion names. */
export const LARGE_MAP = 220

/** PRD 7.5's baseline population. */
export const POPULATION = 400

/** Fills every tile of every field with values in range for that field. */
export function populateGrid(size: number, seed: number): TileGrid {
  const grid = TileGrid.allocate(size)
  const rng = new Rng(seed)

  for (const field of TILE_FIELDS) {
    const view = grid.array(field)
    const stream = rng.stream(`fixture.${field}`)
    const signed = field === 'temperature'

    for (let i = 0; i < view.length; i += 1) {
      // Written through the array rather than `setAt` so the fixture does not
      // spend its time on dirty-chunk bookkeeping it never reads.
      view[i] = signed ? stream.nextInt(-40, 60) : stream.nextInt(0, 200)
    }
  }

  grid.markAllDirty()
  return grid
}

function entities(count: number, seed: number): SaveState['entities'] {
  const rng = new Rng(seed)
  const stream = rng.stream('fixture.entities')

  return Array.from({ length: count }, (_unused, index) => ({
    id: index + 1,
    kind: 'inmate' as const,
    name: `Inmate ${index + 1}`,
    portraitSeed: index + 1,
    category: 'medium',
    convictions: [],
    sentenceHours: 8760,
    servedHours: 0,
    traits: [`trait-${stream.nextInt(0, 12)}`],
    reputations: [],
    needs: [stream.nextInt(0, 101), stream.nextInt(0, 101)],
    addictions: [],
    suppression: 0,
    entitlement: 0,
    cellId: 0,
    jobId: null,
    misconductLog: [],
    grades: { punishment: 0, reform: 0, security: 0, health: 0 },
    reoffendChance: 0.2,
    status: [],
    health: 100,
    inventory: [],
    money: 0,
    aptitude: 1,
    x: stream.nextInt(0, LARGE_MAP),
    y: stream.nextInt(0, LARGE_MAP),
    tx: stream.nextInt(0, LARGE_MAP),
    ty: stream.nextInt(0, LARGE_MAP),
    accessMask: 0,
  }))
}

function rngState(seed: number): RngState {
  const rng = new Rng(seed)
  for (const name of ['intake', 'misconduct', 'search', 'contraband']) {
    const stream = rng.stream(name)
    for (let draw = 0; draw < 32; draw += 1) stream.nextUint32()
  }
  return rng.serialise()
}

export interface FixtureOptions {
  readonly size?: number
  readonly population?: number
  readonly seed?: number
  readonly playedTicks?: number
}

/** A save state with a fully populated grid and a full population. */
export function makeSaveState(options: FixtureOptions = {}): SaveState {
  const size = options.size ?? LARGE_MAP
  const population = options.population ?? POPULATION
  const seed = options.seed ?? 0x5eed_1234
  const playedTicks = options.playedTicks ?? 123_456

  const economy = emptyEconomyState()
  return {
    seed,
    playedTicks,
    settings: { sizePreset: 'large', startingParcels: 4 },
    grid: populateGrid(size, seed),
    entities: entities(population, seed),
    rooms: [
      {
        id: 1,
        defId: 'cell',
        tiles: [10, 11, 12],
        bounds: { x: 0, y: 0, width: 3, height: 1 },
        properties: { enclosed: true, indoors: true, outdoors: false, secure: true },
      },
      {
        id: 2,
        defId: 'canteen',
        tiles: [20, 21],
        bounds: { x: 0, y: 1, width: 2, height: 1 },
        properties: { enclosed: true, indoors: true, outdoors: false, secure: false },
      },
    ],
    nextRoomId: 3,
    sectors: {
      nextSectorId: 2,
      sectors: [
        {
          id: 1,
          name: 'Secure',
          colour: '#334455',
          access: 'secure',
          categories: ['maximum'],
        },
      ],
    },
    economy: {
      ...economy,
      balance: 42_000,
      entries: [
        {
          tick: 0,
          category: 'starting_funds',
          amount: 42_000,
          reason: 'Starting funds',
          sourceEntityId: 0,
        },
      ],
    },
    directorate: {
      completed: ['security_office', 'welfare'],
      active: [{ nodeId: 'surveillance', startedTick: 120, elapsedTicks: 600, pausedReason: null }],
    },
    grading: {
      roomGrades: [{ roomId: 1, score: 4 }],
      lastEntitlementTick: [{ inmateId: 1, tick: 1440 }],
      averageCellGrade: 4,
    },
    programs: {
      enrolments: [
        {
          inmateId: 1,
          programId: 'basic_literacy',
          sessionsPassed: 2,
          sessionsMissed: 0,
          enrolledTick: 600,
        },
      ],
      completions: [{ inmateId: 1, programIds: ['workshop_induction'] }],
      pins: [{ programId: 'basic_literacy', categoryId: 'medium', startHour: 9 }],
    },
    grades: {
      confinement: [
        {
          inmateId: 1,
          isolationHours: 6,
          lockdownHours: 12,
          suppressionExposure: 240,
          labourHours: 30,
        },
      ],
    },
    parole: {
      queue: [{ inmateId: 1, eligibleAtTick: 7200, hearingsHeld: 1, nextHearingTick: 21600 }],
      hearingsToday: 1,
      hearingDay: 3,
    },
    release: {
      released: [
        {
          inmateId: 7,
          name: 'Released One',
          reason: 'parole',
          releasedTick: 3600,
          reoffendChance: 0.32,
          rollsAtTick: 435600,
          reoffended: null,
          reoffendedTick: 0,
        },
      ],
      lifetimeReleased: 1,
      lifetimeReoffended: 0,
      paroleReoffences: [],
      recidivismWarned: false,
    },
    intelligence: {
      informants: [
        {
          inmateId: 1,
          recruitedTick: 600,
          blown: false,
          blownTick: 0,
          carelesslyHandled: false,
          revealCount: 3,
        },
      ],
      revealedStashIds: [2, 5],
      revealedThrowInIds: [1],
      lastBlowRollDay: 4,
    },
    contracts: {
      ...emptyContractState(),
      active: [
        {
          defId: 'fit_for_purpose',
          acceptedTick: 0,
          advancePaid: 0,
          itemPassed: [false, false],
        },
      ],
    },
    routines: {
      medium: Array.from({ length: 24 }, (_unused, hour) =>
        hour < 6 || hour >= 22
          ? 'sleep'
          : hour === 8 || hour === 12 || hour === 17
            ? 'meal'
            : 'free',
      ),
    },
    standingOrders: defaultStandingOrdersState(),
    posts: {
      nextPostId: 2,
      nextRouteId: 2,
      posts: [
        {
          id: 1,
          name: 'Mess hall',
          sectorId: 1,
          objectId: 0,
          staffRole: 'officer',
          count: 2,
          timeWindows: [{ startHour: 8, endHour: 14 }],
          assigned: [],
          shortfallReason: null,
          lastReportedTick: -1,
        },
      ],
      routes: [
        {
          id: 1,
          name: 'Perimeter',
          staffRole: 'officer',
          count: 1,
          waypoints: [10, 11, 12],
          timeWindows: [],
          assigned: [],
          shortfallReason: null,
          lastReportedTick: -1,
        },
      ],
    },
    contraband: emptyContrabandState(),
    fire: emptyFireState(size),
    riot: emptyRiotState(),
    emergency: emptyEmergencyState(),
    escapes: emptyEscapesState(),
    combat: emptyCombatState(),
    punishments: emptyPunishmentsState(),
    utilities: emptyUtilitiesState(),
    entityRegistry: emptyEntityRegistryState(),
    doors: emptyDoorsState(),
    construction: emptyConstructionState(),
    intake: emptyIntakeState(),
    cellGrades: emptyCellGradesState(),
    incomeOwed: 0,
    staffOnlyRoomIds: [],
    intakeSearchedInmateIds: [],
    staffNeedsEnabled: true,
    fog: emptyFogState(),
    offices: emptyOfficesState(),
    escorts: emptyEscortsState(),
    jobs: emptyJobsState(),
    labour: emptyLabourState(),
    morale: emptyMoraleState(),
    needsRuntime: emptyNeedsRuntimeState(),
    routineRuntime: emptyRoutineRuntimeState(),
    meals: emptyMealsState(),
    supply: emptySupplyState(),
    deliveries: emptyDeliveriesState(),
    cleaning: emptyCleaningState(),
    laundry: emptyLaundryState(),
    dangerLevel: 12,
    riotActive: false,
    lockdownActive: false,
    misconductWindowTicks: [100, 200, 300],
    log: Array.from({ length: 50 }, (_unused, index) => ({
      tick: index * 600,
      kind: 'log.entry',
      subject: index,
    })),
    rngState: rngState(seed),
  }
}
