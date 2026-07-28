/**
 * T3.8 — staff needs, breaks, morale, bribes and strikes.
 */

import { describe, expect, it } from 'vitest'

import { TICKS_PER_DAY, TICKS_PER_HOUR, TICKS_PER_MINUTE } from '../../src/core/clock'
import { Rng } from '../../src/core/rng'
import { Simulation } from '../../src/core/simulation'
import type { SimulationEvent } from '../../src/core/simulation'
import { loadGameData } from '../../src/data/loader'
import { NeedIndex } from '../../src/entities/needs'
import {
  MORALE_EVENTS,
  MoraleState,
  bribeChance,
  computeMorale,
  dangerContributionFromMorale,
  movementSpeedMultiplier,
  resolveSearchBribe,
  searchEffectiveness,
} from '../../src/entities/morale'
import { placeObject } from '../../src/entities/objects'
import type { ObjectDeps } from '../../src/entities/objects'
import { hireStaff } from '../../src/entities/staff'
import type { StaffEntity } from '../../src/entities/staff'
import type { InmateWorld } from '../../src/systems/intakeSystem'
import { createInmateWorld } from '../../src/systems/intakeSystem'
import { createJobSystem, postJob } from '../../src/systems/jobSystem'
import {
  STAFF_NEEDS_EVENTS,
  createStaffNeedsSystem,
  findBreakTarget,
  isStaffAccessibleRoom,
  meanStaffNeedSatisfaction,
  peakStaffNeed,
} from '../../src/systems/staffNeedsSystem'
import { createStaffSystem } from '../../src/systems/staffSystem'
import { refreshPassability } from '../../src/world/construction'
import type { Rect } from '../../src/world/construction'
import { initialLockState } from '../../src/world/doors'
import { designateRoom } from '../../src/world/roomDetection'
import type { RoomDeps } from '../../src/world/roomDetection'

const DATA = loadGameData()
const INDEX = NeedIndex.fromData(DATA)
const SEED = 0xb10c_3008
const MORALE = DATA.balance.morale

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

function putWall(world: InmateWorld, x: number, y: number): number {
  const index = putFloor(world, x, y)
  world.grid.setAt('wallMaterial', index, world.materials.indexOf('brick_wall'))
  refreshPassability(world, world.data, index)
  world.structureChanged(index)
  return index
}

function putDoor(world: InmateWorld, x: number, y: number): number {
  const index = putFloor(world, x, y)
  world.grid.setAt('wallMaterial', index, 0)
  const def = world.data.doors.get('standard')
  world.doors.place(index, 'standard', initialLockState(def))
  refreshPassability(world, world.data, index)
  world.structureChanged(index)
  return index
}

function putRoomShell(world: InmateWorld, rect: Rect): void {
  for (let y = rect.y; y < rect.y + rect.height; y += 1) {
    for (let x = rect.x; x < rect.x + rect.width; x += 1) {
      const onEdge =
        x === rect.x ||
        y === rect.y ||
        x === rect.x + rect.width - 1 ||
        y === rect.y + rect.height - 1
      if (onEdge) putWall(world, x, y)
      else putFloor(world, x, y)
    }
  }
  putDoor(world, rect.x + Math.floor(rect.width / 2), rect.y + rect.height - 1)
}

function interiorOf(rect: Rect): Rect {
  return { x: rect.x + 1, y: rect.y + 1, width: rect.width - 2, height: rect.height - 2 }
}

function roomDeps(world: InmateWorld, events: RecordingSink): RoomDeps {
  return { world, data: world.data, events, tick: 0 }
}

function objectDeps(world: InmateWorld, events: RecordingSink): ObjectDeps {
  return { world, data: world.data, events, tick: 0 }
}

function makeWorld(size = 40): { world: InmateWorld; events: RecordingSink } {
  const events = new RecordingSink()
  const world = createInmateWorld({ size, data: DATA })
  return { world, events }
}

function hireOfficer(
  world: InmateWorld,
  events: RecordingSink,
  tx = 5,
  ty = 5,
): number {
  const result = hireStaff({
    world,
    defId: 'officer',
    events,
    tick: 0,
    tx,
    ty,
  })
  if (result.entity === undefined) {
    throw new Error(`hire rejected: ${JSON.stringify(events.of('staff.rejected'))}`)
  }
  return result.entity.id
}

/** Narrowing lookup: a missing officer is a broken fixture, not an assertion. */
function officerOf(world: InmateWorld, id: number): StaffEntity {
  const officer = world.staff.get(id)
  if (officer === undefined) throw new Error(`no staff ${String(id)}`)
  return officer
}

function buildBreakRoom(world: InmateWorld, events: RecordingSink, rect: Rect): number {
  putRoomShell(world, rect)
  const interior = interiorOf(rect)
  designateRoom(roomDeps(world, events), interior, 'break_room')
  const couch = placeObject(
    objectDeps(world, events),
    { x: interior.x, y: interior.y },
    'couch',
    0,
  )
  const toilet = placeObject(
    objectDeps(world, events),
    { x: interior.x, y: interior.y + 1 },
    'toilet',
    0,
  )
  if (couch === undefined || toilet === undefined) {
    throw new Error(
      `failed to furnish break room: ${JSON.stringify(events.of('objects.rejected'))}`,
    )
  }
  const room = [...world.rooms.all()].find((entry) => entry.defId === 'break_room')
  if (room === undefined) throw new Error('break room was not detected')
  return room.id
}

function buildMessHall(world: InmateWorld, events: RecordingSink, rect: Rect): number {
  putRoomShell(world, rect)
  const interior = interiorOf(rect)
  designateRoom(roomDeps(world, events), interior, 'mess_hall')
  placeObject(
    objectDeps(world, events),
    { x: interior.x, y: interior.y },
    'serving_counter',
    0,
  )
  placeObject(objectDeps(world, events), { x: interior.x + 1, y: interior.y }, 'bench', 0)
  const room = [...world.rooms.all()].find((entry) => entry.defId === 'mess_hall')
  if (room === undefined) throw new Error('mess hall was not detected')
  return room.id
}

function runMinutes(
  sim: Simulation,
  minutes: number,
): void {
  for (let i = 0; i < minutes * TICKS_PER_MINUTE; i += 1) {
    sim.step()
  }
}

/* -------------------------------------------------------------------------- */
/* Morale formulas                                                             */
/* -------------------------------------------------------------------------- */

describe('morale formulas (PRD 5.6)', () => {
  it('uses need satisfaction as the backbone at market wages and zero danger', () => {
    expect(
      computeMorale(
        {
          needSatisfaction: 80,
          wageRatio: 1,
          dangerLevel: 0,
          recentDeaths: 0,
          injuries: 0,
        },
        MORALE,
      ),
    ).toBeCloseTo(80, 5)
  })

  it('applies death and injury penalties after the blend', () => {
    const base = computeMorale(
      {
        needSatisfaction: 50,
        wageRatio: 1,
        dangerLevel: 0,
        recentDeaths: 0,
        injuries: 0,
      },
      MORALE,
    )
    const withDeaths = computeMorale(
      {
        needSatisfaction: 50,
        wageRatio: 1,
        dangerLevel: 0,
        recentDeaths: 2,
        injuries: 3,
      },
      MORALE,
    )
    expect(withDeaths).toBeCloseTo(
      base - 2 * MORALE.staffDeathPenalty - 3 * MORALE.injuryPenalty,
      5,
    )
  })

  it('pulls morale down when wages are below market', () => {
    const atMarket = computeMorale(
      {
        needSatisfaction: 60,
        wageRatio: 1,
        dangerLevel: 0,
        recentDeaths: 0,
        injuries: 0,
      },
      MORALE,
    )
    const underpaid = computeMorale(
      {
        needSatisfaction: 60,
        wageRatio: 0.5,
        dangerLevel: 0,
        recentDeaths: 0,
        injuries: 0,
      },
      MORALE,
    )
    expect(underpaid).toBeLessThan(atMarket)
  })

  it('computes search effectiveness, movement speed and bribe chance', () => {
    expect(searchEffectiveness(0, MORALE)).toBeCloseTo(0.4, 5)
    expect(searchEffectiveness(100, MORALE)).toBeCloseTo(1.0, 5)
    expect(searchEffectiveness(50, MORALE)).toBeCloseTo(0.7, 5)

    expect(movementSpeedMultiplier(0, MORALE)).toBeCloseTo(0.7, 5)
    expect(movementSpeedMultiplier(100, MORALE)).toBeCloseTo(1.0, 5)
    expect(movementSpeedMultiplier(50, MORALE)).toBeCloseTo(0.85, 5)

    expect(bribeChance(100, MORALE)).toBe(0)
    expect(bribeChance(35, MORALE)).toBe(0)
    expect(bribeChance(0, MORALE)).toBeCloseTo(0.35, 5)
    expect(bribeChance(10, MORALE)).toBeCloseTo(0.25, 5)
  })

  it('feeds danger from low morale', () => {
    const weight = DATA.balance.danger.weights.staffMorale
    expect(dangerContributionFromMorale(100, weight)).toBeCloseTo(0, 5)
    expect(dangerContributionFromMorale(0, weight)).toBeCloseTo(weight * 100, 5)
  })
})

/* -------------------------------------------------------------------------- */
/* Bribes                                                                      */
/* -------------------------------------------------------------------------- */

describe('search bribes', () => {
  it('pockets contraband at the PRD bribe rate and emits a CausalEvent', () => {
    const events = new RecordingSink()
    const rng = new Rng(SEED)
    const stream = rng.stream('search')
    const morale = 0
    const chance = bribeChance(morale, MORALE)
    expect(chance).toBeCloseTo(0.35, 5)

    let bribes = 0
    const trials = 400
    for (let i = 0; i < trials; i += 1) {
      const result = resolveSearchBribe({
        morale,
        balance: MORALE,
        rng: stream,
        events,
        tick: i,
        officerId: 1,
        inmateId: 2,
        contrabandId: 'cigarette',
      })
      if (result === 'bribe') bribes += 1
    }

    const rate = bribes / trials
    expect(rate).toBeGreaterThan(0.25)
    expect(rate).toBeLessThan(0.45)
    expect(events.of(MORALE_EVENTS.bribeTaken).length).toBe(bribes)
  })

  it('never bribes at high morale', () => {
    const events = new RecordingSink()
    const stream = new Rng(SEED).stream('search')
    for (let i = 0; i < 50; i += 1) {
      expect(
        resolveSearchBribe({
          morale: 80,
          balance: MORALE,
          rng: stream,
          events,
          tick: i,
          officerId: 1,
          inmateId: 2,
          contrabandId: 'cigarette',
        }),
      ).toBe('confiscate')
    }
    expect(events.of(MORALE_EVENTS.bribeTaken)).toHaveLength(0)
  })
})

/* -------------------------------------------------------------------------- */
/* Room routing                                                                */
/* -------------------------------------------------------------------------- */

describe('staff need satisfaction routing', () => {
  it('routes breaks to staff-accessible rooms and ignores unmarked canteens', () => {
    const { world, events } = makeWorld()
    const breakId = buildBreakRoom(world, events, { x: 2, y: 2, width: 6, height: 6 })
    const messId = buildMessHall(world, events, { x: 12, y: 2, width: 6, height: 6 })

    expect(isStaffAccessibleRoom(world, DATA, breakId)).toBe(true)
    expect(isStaffAccessibleRoom(world, DATA, messId)).toBe(false)

    world.staffOnlyRoomIds.add(messId)
    expect(isStaffAccessibleRoom(world, DATA, messId)).toBe(true)

    const officerId = hireOfficer(world, events, 4, 4)
    const officer = officerOf(world, officerId)
    INDEX.set(officer.staff.needs, 'comfort', 90)

    const target = findBreakTarget(world, DATA, INDEX, officer)
    expect(target).toBeDefined()
    expect(target?.roomId).toBe(breakId)
  })

  it('abandons a break after the seek timeout when nothing is available', () => {
    const { world, events } = makeWorld()
    // Open yard only — no staff rooms.
    for (let y = 0; y < 10; y += 1) {
      for (let x = 0; x < 10; x += 1) putFloor(world, x, y)
    }
    const officerId = hireOfficer(world, events, 3, 3)
    const officer = officerOf(world, officerId)
    // Raise a single dischargeable need so a break starts without tanking
    // prison-wide morale into a strike (which would clear the break).
    INDEX.set(officer.staff.needs, 'bladder', 90)

    const sim = new Simulation({
      seed: SEED,
      world,
      systems: [createStaffNeedsSystem({ data: DATA })],
      events,
    })

    runMinutes(sim, DATA.balance.staffNeeds.breakSeekTimeoutMinutes + 2)

    expect(events.of(STAFF_NEEDS_EVENTS.breakStarted).length).toBeGreaterThan(0)
    expect(events.of(STAFF_NEEDS_EVENTS.breakAbandoned).length).toBeGreaterThan(0)
    expect(officer.staff.duty.kind).toBe('idle')
  })

  it('finishes the current job before starting a break', () => {
    const { world, events } = makeWorld()
    buildBreakRoom(world, events, { x: 2, y: 2, width: 6, height: 6 })
    for (let y = 10; y < 16; y += 1) {
      for (let x = 2; x < 8; x += 1) putFloor(world, x, y)
    }

    const officerId = hireOfficer(world, events, 4, 12)
    const officer = officerOf(world, officerId)
    for (const needId of DATA.staff.get('officer').needs) {
      INDEX.set(officer.staff.needs, needId, 90)
    }

    const job = postJob({
      world,
      kind: 'search',
      priority: 10,
      location: world.grid.idx(5, 12),
      tick: 0,
      events,
      requiredRole: 'search',
    })
    officer.staff.duty = { kind: 'job', jobId: job.id }
    world.jobs.claim(job.id, 'staff', officerId)

    const sim = new Simulation({
      seed: SEED,
      world,
      systems: [createStaffNeedsSystem({ data: DATA }), createJobSystem({ data: DATA })],
      events,
    })

    runMinutes(sim, 2)
    expect(officer.staff.breakPending).toBe(true)
    expect(officer.staff.duty.kind).toBe('job')

    world.jobs.complete(job.id)
    officer.staff.duty = { kind: 'idle' }

    runMinutes(sim, 2)
    expect(officer.staff.duty.kind).toBe('break')
  })
})

/* -------------------------------------------------------------------------- */
/* Strike lifecycle                                                            */
/* -------------------------------------------------------------------------- */

describe('strike lifecycle', () => {
  it('strikes when morale falls below the threshold and ends after 24 hours', () => {
    const state = new MoraleState()
    const events = new RecordingSink()
    const rng = new Rng(SEED).stream('morale')

    expect(
      state.maybeBeginStrike(0, 9, MORALE, rng, events),
    ).toBe(true)
    expect(state.striking).toBe(true)
    expect(events.of(MORALE_EVENTS.strikeStarted)).toHaveLength(1)
    expect(events.of(MORALE_EVENTS.payDemand)).toHaveLength(1)
    expect(state.payDemandOpen).toBe(true)

    const endTick = MORALE.strikeHours * TICKS_PER_HOUR
    expect(state.maybeEndStrike(endTick - 1, MORALE, events)).toBe(false)
    expect(state.maybeEndStrike(endTick, MORALE, events)).toBe(true)
    expect(state.striking).toBe(false)
    expect(events.of(MORALE_EVENTS.strikeEnded)).toHaveLength(1)
  })

  it('accepts a pay demand and raises the wage multiplier', () => {
    const state = new MoraleState()
    const events = new RecordingSink()
    state.maybeBeginStrike(0, 5, MORALE, new Rng(SEED).stream('morale'), events)

    expect(state.acceptPayDemand(10, MORALE, events)).toBe(true)
    expect(state.wageMultiplier).toBeCloseTo(1 + MORALE.payDemandRaise, 5)
    expect(state.payDemandOpen).toBe(false)
    expect(state.striking).toBe(false)
    expect(events.of(MORALE_EVENTS.payDemandAccepted)).toHaveLength(1)
  })

  it('escalates repeat-strike chance after a refuse', () => {
    const state = new MoraleState()
    const events = new RecordingSink()
    const rng = new Rng(SEED).stream('morale')

    state.maybeBeginStrike(0, 5, MORALE, rng, events)
    expect(state.refusePayDemand(1, events)).toBe(true)
    expect(state.refuseCount).toBe(1)
    expect(events.of(MORALE_EVENTS.payDemandRefused)).toHaveLength(1)

    state.maybeEndStrike(MORALE.strikeHours * TICKS_PER_HOUR, MORALE, events)
    state.tickCooldown(MORALE.strikeHours * TICKS_PER_HOUR + MORALE.strikeCooldownHours * TICKS_PER_HOUR)

    // With refuse escalation the chance is high enough that a fresh stream
    // almost always retriggers within a modest number of rolls.
    let retriggered = false
    const rollRng = new Rng(SEED + 1).stream('morale')
    for (let i = 0; i < 40; i += 1) {
      if (state.maybeBeginStrike(100_000 + i, 5, MORALE, rollRng, events)) {
        retriggered = true
        break
      }
    }
    expect(retriggered).toBe(true)
  })
})

/* -------------------------------------------------------------------------- */
/* Acceptance: no break room → strike within ~10 days                          */
/* -------------------------------------------------------------------------- */

describe('acceptance scenarios', () => {
  it('sees morale fall and a strike within roughly 10 in-game days without a break room', () => {
    const { world, events } = makeWorld(24)
    for (let y = 0; y < 12; y += 1) {
      for (let x = 0; x < 12; x += 1) putFloor(world, x, y)
    }
    hireOfficer(world, events, 4, 4)
    hireOfficer(world, events, 6, 4)

    const sim = new Simulation({
      seed: SEED,
      world,
      systems: [createStaffNeedsSystem({ data: DATA }), createStaffSystem({ data: DATA })],
      events,
    })

    const limit = 10 * TICKS_PER_DAY
    let struck = false
    for (let tick = 0; tick < limit; tick += 1) {
      sim.step()
      if (world.morale.striking || events.of(MORALE_EVENTS.strikeStarted).length > 0) {
        struck = true
        break
      }
    }

    expect(struck).toBe(true)
    expect(world.morale.value).toBeLessThan(MORALE.strikeThreshold)
    expect(meanStaffNeedSatisfaction(world, DATA, INDEX)).toBeLessThan(40)
  })

  it('low morale visibly reduces search effectiveness versus high morale', () => {
    const high = searchEffectiveness(90, MORALE)
    const low = searchEffectiveness(5, MORALE)
    expect(high).toBeGreaterThan(low)
    expect(high - low).toBeGreaterThan(0.4)

    // Scenario-shaped: same search roll, different morale → different pass.
    const threshold = 0.55
    expect(high).toBeGreaterThan(threshold)
    expect(low).toBeLessThan(threshold)
  })
})

describe('staff need peak helper', () => {
  it('reports the highest listed need', () => {
    const { world, events } = makeWorld()
    const id = hireOfficer(world, events)
    const officer = officerOf(world, id)
    INDEX.set(officer.staff.needs, 'food', 40)
    INDEX.set(officer.staff.needs, 'bladder', 70)
    expect(peakStaffNeed(officer, DATA.staff.get('officer').needs, INDEX)).toBe(70)
  })
})
