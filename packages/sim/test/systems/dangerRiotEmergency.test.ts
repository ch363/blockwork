/**
 * T4.6 — danger formula, riot spread, emergency levels, failure countdown.
 */

import { describe, expect, it } from 'vitest'

import { TICKS_PER_HOUR, TICKS_PER_MINUTE } from '../../src/core/clock'
import { Simulation } from '../../src/core/simulation'
import type { SimulationEvent } from '../../src/core/simulation'
import { loadGameData } from '../../src/data/loader'
import { NeedIndex } from '../../src/entities/needs'
import { createInmateShell, generateInmate } from '../../src/entities/inmate'
import { Rng } from '../../src/core/rng'
import {
  clampDanger,
  computeDanger,
  createDangerSystem,
  dangerComponents,
  inmateHasCriticalNeed,
} from '../../src/systems/dangerSystem'
import type { DangerInputs } from '../../src/systems/dangerSystem'
import {
  EMERGENCY_EVENTS,
  createEmergencySystem,
  emergencyCommandHandlers,
} from '../../src/systems/emergencySystem'
import {
  RIOT_EVENTS,
  beginRiot,
  computeInmateMood,
  createRiotSystem,
  markRioting,
  riotSpreadProbability,
  riotTriggerProbability,
} from '../../src/systems/riotSystem'
import { createInmateWorld } from '../../src/systems/intakeSystem'
import type { InmateWorld } from '../../src/systems/intakeSystem'
import { refreshPassability } from '../../src/world/construction'
import { initialLockState } from '../../src/world/doors'
import { NO_SECTOR } from '../../src/world/sectors'
import { definedOrThrow } from '../support/defined'

const DATA = loadGameData()
const INDEX = NeedIndex.fromData(DATA)
const SEED = 0xb10c_4006

class RecordingSink {
  readonly events: SimulationEvent[] = []
  emit(event: SimulationEvent): void {
    this.events.push(event)
  }
  of(kind: string): SimulationEvent[] {
    return this.events.filter((event) => event.kind === kind)
  }
  clear(): void {
    this.events.length = 0
  }
}

function putFloor(world: InmateWorld, x: number, y: number): number {
  const floor = world.data.balance.construction.foundationFloorMaterial
  const index = world.grid.idx(x, y)
  world.grid.setAt('floorMaterial', index, world.materials.indexOf(floor))
  world.grid.setAt('outdoors', index, 0)
  refreshPassability(world, world.data, index)
  world.structureChanged(index)
  return index
}

function spawnInmate(
  world: InmateWorld,
  opts: { tx: number; ty: number; category?: string; seed?: number },
): number {
  const rng = new Rng(opts.seed ?? SEED).stream('inmate')
  const inmate = generateInmate({
    data: DATA,
    rng,
    ...(opts.category === undefined ? {} : { category: opts.category }),
  })
  // Clear needs so tests control critical / mood explicitly.
  inmate.needs.fill(0)
  const shell = createInmateShell({
    id: world.inmates.allocateId(),
    inmate,
    data: DATA,
    tx: opts.tx,
    ty: opts.ty,
  })
  world.inmates.add(shell)
  return shell.id
}

function makeSim(world: InmateWorld, sink: RecordingSink): Simulation {
  return new Simulation({
    seed: SEED,
    world,
    systems: [
      createDangerSystem({ data: DATA, index: INDEX }),
      createRiotSystem({ data: DATA, index: INDEX }),
      createEmergencySystem({ data: DATA }),
    ],
    commandHandlers: emergencyCommandHandlers(DATA),
    events: sink,
  })
}

function stepMinutes(sim: Simulation, minutes: number): void {
  for (let i = 0; i < minutes * TICKS_PER_MINUTE; i += 1) sim.step()
}

/* -------------------------------------------------------------------------- */
/* Danger formula                                                              */
/* -------------------------------------------------------------------------- */

describe('danger formula components', () => {
  const balance = DATA.balance.danger

  it('isolates each PRD 5.11 term', () => {
    const zero: DangerInputs = {
      pctInmatesWithAnyCriticalNeed: 0,
      misconductLastWindow: 0,
      population: 10,
      pctInmatesArmed: 0,
      staffMorale: 100,
      guardCoverageRatio: 1,
      pctMaxSecPopulation: 0,
    }

    expect(computeDanger(zero, balance)).toBe(0)

    const criticalOnly = dangerComponents({ ...zero, pctInmatesWithAnyCriticalNeed: 100 }, balance)
    expect(criticalOnly.criticalNeeds).toBeCloseTo(balance.weights.criticalNeeds * 100)
    expect(criticalOnly.misconduct).toBe(0)
    expect(criticalOnly.total).toBeCloseTo(criticalOnly.criticalNeeds)

    const misconductOnly = dangerComponents(
      { ...zero, misconductLastWindow: 10, population: 10 },
      balance,
    )
    // weight * (count / pop) * misconductScale
    expect(misconductOnly.misconduct).toBeCloseTo(
      balance.weights.misconduct * (10 / 10) * balance.misconductScale,
    )

    const armedOnly = dangerComponents({ ...zero, pctInmatesArmed: 100 }, balance)
    // 0.15 * 1.0 * 300 = 45
    expect(armedOnly.armedInmates).toBeCloseTo(45)

    const moraleOnly = dangerComponents({ ...zero, staffMorale: 0 }, balance)
    expect(moraleOnly.staffMorale).toBeCloseTo(balance.weights.staffMorale * 100)

    const coverageOnly = dangerComponents({ ...zero, guardCoverageRatio: 0 }, balance)
    expect(coverageOnly.guardCoverage).toBeCloseTo(balance.weights.guardCoverage * 100)

    const maxSecOnly = dangerComponents({ ...zero, pctMaxSecPopulation: 100 }, balance)
    expect(maxSecOnly.maxSecurityShare).toBeCloseTo(balance.weights.maxSecurityShare * 100)

    expect(clampDanger(-5)).toBe(0)
    expect(clampDanger(150)).toBe(100)
  })

  it('treats any need at critical as contributing to the critical-needs share', () => {
    const needs = new Float32Array(INDEX.size)
    expect(inmateHasCriticalNeed(needs, INDEX)).toBe(false)
    const food = INDEX.indexOf('food')
    expect(food).toBeGreaterThanOrEqual(0)
    const critical = INDEX.defAt(food).thresholds.critical
    needs[food] = critical
    expect(inmateHasCriticalNeed(needs, INDEX)).toBe(true)
  })
})

/* -------------------------------------------------------------------------- */
/* Riot spread                                                                 */
/* -------------------------------------------------------------------------- */

describe('riot spread on a fixture', () => {
  it('spreads to a nearby low-mood neighbour and not to a distant calm one', () => {
    const world = createInmateWorld({ size: 20, data: DATA })
    for (let y = 0; y < 12; y += 1) {
      for (let x = 0; x < 12; x += 1) putFloor(world, x, y)
    }

    const seedId = spawnInmate(world, { tx: 3, ty: 3, seed: 1 })
    const nearId = spawnInmate(world, { tx: 5, ty: 3, seed: 2 })
    const farId = spawnInmate(world, { tx: 11, ty: 11, seed: 3 })

    const near = definedOrThrow(world.inmates.get(nearId), 'near inmate')
    const far = definedOrThrow(world.inmates.get(farId), 'far inmate')
    // Low mood (high needs) for the neighbour; calm for the distant inmate.
    near.inmate.needs.fill(90)
    far.inmate.needs.fill(0)

    world.dangerLevel = 80
    const sink = new RecordingSink()
    const sim = makeSim(world, sink)

    beginRiot(world, seedId, 0, { events: sink })
    expect(world.riot.riotingInmateIds.has(seedId)).toBe(true)

    // Force spread rolls: many minutes with high probability.
    // Override mood-based p by checking formula first.
    expect(
      riotSpreadProbability(computeInmateMood(near.inmate.needs, INDEX), DATA.balance.riot),
    ).toBeGreaterThan(0.1)
    expect(
      riotSpreadProbability(computeInmateMood(far.inmate.needs, INDEX), DATA.balance.riot),
    ).toBe(0)

    stepMinutes(sim, 30)

    expect(world.riot.riotingInmateIds.has(nearId)).toBe(true)
    expect(world.riot.riotingInmateIds.has(farId)).toBe(false)
    expect(sink.of(RIOT_EVENTS.spread).length).toBeGreaterThan(0)
  })

  it('computes trigger probability per PRD 5.11', () => {
    const balance = DATA.balance.riot
    const base = riotTriggerProbability(50, 0, false, balance)
    expect(base).toBeCloseTo(balance.baseProbability)

    const high = riotTriggerProbability(100, 0, false, balance)
    expect(high).toBeGreaterThan(base)

    const lockdown = riotTriggerProbability(50, 0, true, balance)
    expect(lockdown).toBeCloseTo(base * balance.lockdownFactor)

    const agitators = riotTriggerProbability(50, 2, false, balance)
    expect(agitators).toBeCloseTo(base * (1 + 2 * balance.agitatorFactor))
  })
})

/* -------------------------------------------------------------------------- */
/* Emergency levels                                                            */
/* -------------------------------------------------------------------------- */

describe('emergency level effects', () => {
  it('applies sector lockdown suppression', () => {
    const world = createInmateWorld({ size: 16, data: DATA })
    for (let y = 0; y < 8; y += 1) {
      for (let x = 0; x < 8; x += 1) putFloor(world, x, y)
    }
    const sector = world.sectors.create(DATA, {
      name: 'A',
      colour: '#c44',
      access: 'shared',
    })
    const sectorId = definedOrThrow(sector, 'sector').id
    world.sectors.paintTiles(world.grid, [world.grid.idx(2, 2), world.grid.idx(3, 2)], sectorId)

    const inmateId = spawnInmate(world, { tx: 2, ty: 2 })
    const inmate = definedOrThrow(world.inmates.get(inmateId), 'inmate')
    inmate.inmate.suppression = 0

    const sink = new RecordingSink()
    const sim = makeSim(world, sink)
    sim.enqueue({
      type: 'emergency.sectorLockdown',
      issuedAtTick: 0,
      payload: { sectorId },
    })
    stepMinutes(sim, 60)

    expect(world.emergency.sectorLockdowns.has(sectorId)).toBe(true)
    expect(inmate.inmate.suppression).toBeGreaterThan(0)
    expect(sink.of(EMERGENCY_EVENTS.sectorLockdown).length).toBe(1)
    expect(NO_SECTOR).toBe(0)
  })

  it('full lockdown sets facility flag and raises suppression', () => {
    const world = createInmateWorld({ size: 12, data: DATA })
    putFloor(world, 1, 1)
    const inmateId = spawnInmate(world, { tx: 1, ty: 1 })
    const inmate = definedOrThrow(world.inmates.get(inmateId), 'inmate')
    inmate.inmate.suppression = 0

    const sink = new RecordingSink()
    const sim = makeSim(world, sink)
    sim.enqueue({ type: 'emergency.fullLockdown', issuedAtTick: 0, payload: {} })
    stepMinutes(sim, 60)

    expect(world.emergency.fullLockdown).toBe(true)
    expect(world.lockdownActive).toBe(true)
    expect(inmate.inmate.suppression).toBeGreaterThan(0)
    expect(world.needsRuntime.stateOf(inmateId).lockedUp).toBe(true)
  })

  it('riot squad summons callable staff and charges hourly wages', () => {
    const world = createInmateWorld({ size: 12, data: DATA })
    const before = world.economy.balance
    const sink = new RecordingSink()
    const sim = makeSim(world, sink)

    sim.enqueue({ type: 'emergency.callRiotSquad', issuedAtTick: 0, payload: {} })
    sim.step()

    expect(world.emergency.riotSquadActive).toBe(true)
    expect(world.emergency.riotSquadStaffIds.length).toBe(DATA.balance.emergency.riotSquadCount)
    expect(sink.of(EMERGENCY_EVENTS.riotSquadCalled).length).toBe(1)

    // Wages accrue once a full in-game hour has elapsed since the call.
    stepMinutes(sim, 61)
    const wage =
      DATA.staff.get(DATA.balance.emergency.riotSquadDefId).hourlyWage *
      DATA.balance.emergency.riotSquadCount
    expect(world.economy.balance).toBe(before - wage)
  })

  it('free fire applies re-offending and PR penalties', () => {
    const world = createInmateWorld({ size: 12, data: DATA })
    putFloor(world, 1, 1)
    const inmateId = spawnInmate(world, { tx: 1, ty: 1 })
    const inmate = definedOrThrow(world.inmates.get(inmateId), 'inmate')
    const before = inmate.inmate.reoffendChance

    const sink = new RecordingSink()
    const sim = makeSim(world, sink)
    sim.enqueue({ type: 'emergency.authoriseFreeFire', issuedAtTick: 0, payload: {} })
    sim.step()

    expect(world.emergency.freeFireActive).toBe(true)
    expect(inmate.inmate.reoffendChance).toBeCloseTo(
      Math.min(1, before + DATA.balance.emergency.freeFireReoffendPenalty),
    )
    expect(world.emergency.prPenalty).toBe(DATA.balance.emergency.freeFirePrPenalty)
    expect(sink.of(EMERGENCY_EVENTS.freeFireAuthorised).length).toBe(1)
  })

  it('national guard costs a huge fee, clears the riot, and usually fires the player', () => {
    const world = createInmateWorld({ size: 12, data: DATA })
    putFloor(world, 1, 1)
    const inmateId = spawnInmate(world, { tx: 1, ty: 1 })
    markRioting(world, inmateId)
    world.riot.startedAtTick = 0

    const before = world.economy.balance
    const sink = new RecordingSink()
    const sim = makeSim(world, sink)
    sim.enqueue({ type: 'emergency.callNationalGuard', issuedAtTick: 0, payload: {} })
    sim.step()

    expect(world.economy.balance).toBe(before - DATA.balance.emergency.nationalGuardCost)
    expect(world.riot.active).toBe(false)
    expect(world.riot.riotingInmateIds.size).toBe(0)
    expect(world.emergency.nationalGuardActive).toBe(true)
    expect(sink.of(EMERGENCY_EVENTS.nationalGuardCalled).length).toBe(1)
    // Fire probability is 0.9 — with the seeded stream this should fire.
    expect(world.emergency.playerFired).toBe(true)
  })
})

/* -------------------------------------------------------------------------- */
/* Failure countdown                                                           */
/* -------------------------------------------------------------------------- */

describe('riot failure countdown', () => {
  it('warns at 6 hours and fails at 12; containment cancels', () => {
    const world = createInmateWorld({ size: 12, data: DATA })
    putFloor(world, 1, 1)
    const inmateId = spawnInmate(world, { tx: 1, ty: 1 })

    const sink = new RecordingSink()
    const sim = makeSim(world, sink)

    beginRiot(world, inmateId, 0, { events: sink })
    // Arm clocks as the emergency system would on the first minute.
    const warningHours = DATA.balance.failure.uncontainedRiot.warningHours
    const thenHours = DATA.balance.failure.uncontainedRiot.thenHours

    stepMinutes(sim, warningHours * 60)
    expect(sink.of(EMERGENCY_EVENTS.failureWarning).length).toBe(1)
    expect(world.emergency.failed).toBe(false)

    // Contain: clear rioters and wait for quiet minutes.
    world.riot.riotingInmateIds.clear()
    stepMinutes(sim, DATA.balance.riot.containedMinutes)

    expect(world.riot.active).toBe(false)
    expect(sink.of(RIOT_EVENTS.contained).length).toBeGreaterThan(0)
    expect(world.emergency.warningAtTick).toBeNull()
    expect(world.emergency.failureAtTick).toBeNull()
    expect(world.emergency.failed).toBe(false)

    // Fresh riot that runs the full window without containment.
    sink.clear()
    const inmate2 = spawnInmate(world, { tx: 2, ty: 1, seed: 99 })
    beginRiot(world, inmate2, sim.tick, { events: sink })
    stepMinutes(sim, (warningHours + thenHours) * 60)

    expect(sink.of(EMERGENCY_EVENTS.failureWarning).length).toBeGreaterThanOrEqual(1)
    expect(sink.of(EMERGENCY_EVENTS.failure).length).toBe(1)
    expect(world.emergency.failed).toBe(true)
    expect(world.emergency.playerFired).toBe(true)
  })

  it('fires exactly on the scheduled tick when never contained', () => {
    const world = createInmateWorld({ size: 12, data: DATA })
    putFloor(world, 1, 1)
    const inmateId = spawnInmate(world, { tx: 1, ty: 1 })
    const sink = new RecordingSink()
    const sim = makeSim(world, sink)

    beginRiot(world, inmateId, 0, { events: sink })
    const warningTicks = DATA.balance.failure.uncontainedRiot.warningHours * TICKS_PER_HOUR
    const failTicks = warningTicks + DATA.balance.failure.uncontainedRiot.thenHours * TICKS_PER_HOUR

    // One tick before failure — warned, not failed.
    // Systems run on period boundaries; land exactly on failTicks.
    while (sim.tick < failTicks - 1) sim.step()
    expect(world.emergency.warningEmitted).toBe(true)
    expect(world.emergency.failed).toBe(false)

    while (sim.tick < failTicks) sim.step()
    expect(world.emergency.failed).toBe(true)
    expect(sim.tick).toBe(failTicks)
  })
})

describe('door break during riot', () => {
  it('breaks an adjacent door after doorBreakMinutes', () => {
    const world = createInmateWorld({ size: 12, data: DATA })
    putFloor(world, 2, 2)
    putFloor(world, 3, 2)
    const doorTile = world.grid.idx(3, 2)
    const def = world.data.doors.get('standard')
    world.doors.place(doorTile, 'standard', initialLockState(def))
    refreshPassability(world, world.data, doorTile)

    const inmateId = spawnInmate(world, { tx: 2, ty: 2 })
    markRioting(world, inmateId)
    world.riot.startedAtTick = 0

    const sink = new RecordingSink()
    const sim = makeSim(world, sink)
    stepMinutes(sim, DATA.balance.riot.doorBreakMinutes)

    expect(world.doors.get(doorTile)).toBeUndefined()
    expect(sink.of(RIOT_EVENTS.breakDoor).length).toBeGreaterThan(0)
  })
})
