/**
 * T2.4 — inmate generation, intake buses and housing assignment.
 */

import { describe, expect, it } from 'vitest'

import { Rng } from '../../src/core/rng'
import { loadGameData } from '../../src/data/loader'
import {
  expectedTraitRates,
  findHousing,
  generateInmate,
  housingCapacity,
} from '../../src/entities/inmate'
import { placeObject } from '../../src/entities/objects'
import type { ObjectDeps } from '../../src/entities/objects'
import type { InmateWorld } from '../../src/systems/intakeSystem'
import { arriveInmate, createInmateWorld, runBusArrival } from '../../src/systems/intakeSystem'
import { refreshPassability } from '../../src/world/construction'
import type { Rect } from '../../src/world/construction'
import { initialLockState } from '../../src/world/doors'
import { designateRoom } from '../../src/world/roomDetection'
import type { RoomDeps } from '../../src/world/roomDetection'
import { NO_ROOM } from '../../src/world/rooms'
import type { SimulationEvent } from '../../src/core/simulation'

const DATA = loadGameData()
const SEED = 0xb10c_2004

class RecordingSink {
  readonly events: SimulationEvent[] = []
  emit(event: SimulationEvent): void {
    this.events.push(event)
  }
  of(kind: string): SimulationEvent[] {
    return this.events.filter((event) => event.kind === kind)
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
  world.doors.place(index, 'standard', initialLockState(world.data.doors.get('standard')))
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
  // Door on the south edge so the room is enterable; still enclosed.
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

function makeRoom(
  world: InmateWorld,
  events: RecordingSink,
  shell: Rect,
  roomDefId: string,
): number {
  putRoomShell(world, shell)
  const interior = interiorOf(shell)
  designateRoom(roomDeps(world, events), interior, roomDefId)
  const roomId = world.grid.get('roomId', interior.x, interior.y)
  if (roomId === 0) throw new Error(`no ${roomDefId} at (${interior.x}, ${interior.y})`)
  return roomId
}

function furnishCell(world: InmateWorld, events: RecordingSink, shell: Rect): number {
  const roomId = makeRoom(world, events, shell, 'cell')
  const interior = interiorOf(shell)
  const bed = placeObject(objectDeps(world, events), { x: interior.x, y: interior.y }, 'bed', 0)
  const toilet = placeObject(
    objectDeps(world, events),
    { x: interior.x + 1, y: interior.y },
    'toilet',
    0,
  )
  if (bed === undefined || toilet === undefined) {
    throw new Error(`failed to furnish cell: ${events.of('objects.rejected').length} rejections`)
  }
  return roomId
}

function furnishHoldingPen(world: InmateWorld, events: RecordingSink, shell: Rect): number {
  const roomId = makeRoom(world, events, shell, 'holding_pen')
  const interior = interiorOf(shell)
  const toilet = placeObject(
    objectDeps(world, events),
    { x: interior.x, y: interior.y },
    'toilet',
    0,
  )
  const bench = placeObject(
    objectDeps(world, events),
    { x: interior.x + 1, y: interior.y },
    'bench',
    0,
  )
  if (toilet === undefined || bench === undefined) {
    throw new Error('failed to furnish holding pen')
  }
  return roomId
}

function furnishIntakeHall(world: InmateWorld, events: RecordingSink, shell: Rect): number {
  const roomId = makeRoom(world, events, shell, 'intake_hall')
  const interior = interiorOf(shell)
  // Desk, table and bench are all 2x1 — stack them on separate rows.
  const desk = placeObject(
    objectDeps(world, events),
    { x: interior.x, y: interior.y },
    'office_desk',
    0,
  )
  const table = placeObject(
    objectDeps(world, events),
    { x: interior.x, y: interior.y + 1 },
    'table',
    0,
  )
  const bench = placeObject(
    objectDeps(world, events),
    { x: interior.x, y: interior.y + 2 },
    'bench',
    0,
  )
  if (desk === undefined || table === undefined || bench === undefined) {
    const reasons = events.of('objects.rejected').map((event) => event.data)
    throw new Error(`failed to furnish intake hall: ${JSON.stringify(reasons)}`)
  }
  return roomId
}

function fingerprint(component: ReturnType<typeof generateInmate>): string {
  return JSON.stringify({
    name: component.name,
    portraitSeed: component.portraitSeed,
    category: component.category,
    convictions: component.convictions,
    traits: component.traits,
    reputations: component.reputations.map((r) => r.id),
    addictions: component.addictions,
    aptitude: component.aptitude,
    sentenceHours: component.sentenceHours,
    entitlement: component.entitlement,
  })
}

/* -------------------------------------------------------------------------- */
/* Generation                                                                  */
/* -------------------------------------------------------------------------- */

describe('inmate generation', () => {
  it('is deterministic for a fixed seed and category', () => {
    const a = new Rng(SEED)
    const b = new Rng(SEED)
    const first = Array.from({ length: 20 }, () =>
      fingerprint(generateInmate({ data: DATA, rng: a.stream('intake'), category: 'medium' })),
    )
    const second = Array.from({ length: 20 }, () =>
      fingerprint(generateInmate({ data: DATA, rng: b.stream('intake'), category: 'medium' })),
    )
    expect(second).toEqual(first)
  })

  it('never grants dangerous traits to minimum security', () => {
    const rng = new Rng(SEED)
    const dangerous = new Set(
      DATA.traits.all.filter((trait) => trait.dangerous).map((trait) => trait.id),
    )
    for (let i = 0; i < 500; i += 1) {
      const inmate = generateInmate({
        data: DATA,
        rng: rng.stream('intake'),
        category: 'minimum',
      })
      for (const trait of inmate.traits) {
        expect(dangerous.has(trait)).toBe(false)
      }
    }
  })

  it('only derives traits from the category risk-tier conviction pool', () => {
    const rng = new Rng(SEED)
    const mediumTraits = new Set<string>()
    for (const conviction of DATA.convictions.all) {
      if (conviction.riskTier !== 'medium') continue
      for (const trait of conviction.grantsTraits) mediumTraits.add(trait)
    }

    for (let i = 0; i < 200; i += 1) {
      const inmate = generateInmate({
        data: DATA,
        rng: rng.stream('intake'),
        category: 'medium',
      })
      for (const trait of inmate.traits) {
        expect(mediumTraits.has(trait)).toBe(true)
      }
      for (const conviction of inmate.convictions) {
        expect(DATA.convictions.get(conviction.id).riskTier).toBe('medium')
      }
    }
  })

  it('gates addictions on the dependent trait', () => {
    const rng = new Rng(SEED)
    for (let i = 0; i < 300; i += 1) {
      const inmate = generateInmate({
        data: DATA,
        rng: rng.stream('intake'),
        category: 'medium',
      })
      if (!inmate.traits.includes('dependent')) {
        expect(inmate.addictions).toEqual([])
      }
    }
  })

  it('produces a trait distribution consistent with the conviction table (10k)', () => {
    const sample = 10_000
    const category = 'medium'
    const expected = expectedTraitRates(DATA, category)
    const counts = new Map<string, number>()
    for (const trait of DATA.traits.all) counts.set(trait.id, 0)

    const rng = new Rng(SEED)
    for (let i = 0; i < sample; i += 1) {
      const inmate = generateInmate({
        data: DATA,
        rng: rng.stream('intake'),
        category,
      })
      for (const trait of inmate.traits) {
        counts.set(trait, (counts.get(trait) ?? 0) + 1)
      }
    }

    // 99% Wilson-ish slack: absolute error under 0.02 for rates that matter,
    // and zero-rate traits must stay zero.
    for (const trait of DATA.traits.all) {
      const rate = (counts.get(trait.id) ?? 0) / sample
      const want = expected.get(trait.id) ?? 0
      if (want === 0) {
        expect(rate, trait.id).toBe(0)
      } else {
        expect(Math.abs(rate - want), `${trait.id}: got ${rate}, want ${want}`).toBeLessThan(0.025)
      }
    }
  })

  it('starts entitlement at the balance value and rolls aptitude in range', () => {
    const inmate = generateInmate({
      data: DATA,
      rng: new Rng(SEED).stream('intake'),
      category: 'maximum',
    })
    expect(inmate.entitlement).toBe(DATA.balance.entitlement.start)
    expect(inmate.aptitude).toBeGreaterThanOrEqual(DATA.balance.programs.aptitude.min)
    expect(inmate.aptitude).toBeLessThanOrEqual(DATA.balance.programs.aptitude.max)
    expect(inmate.needs.length).toBe(DATA.needs.size)
  })
})

/* -------------------------------------------------------------------------- */
/* Housing assignment                                                          */
/* -------------------------------------------------------------------------- */

describe('cell assignment priority', () => {
  it('assigns a free functional cell first', () => {
    const events = new RecordingSink()
    const world = createInmateWorld({ size: 40, data: DATA, continuousIntake: false })
    const cellId = furnishCell(world, events, { x: 2, y: 2, width: 4, height: 5 })
    furnishHoldingPen(world, events, { x: 10, y: 2, width: 7, height: 7 })
    furnishIntakeHall(world, events, { x: 20, y: 2, width: 6, height: 6 })

    const housing = findHousing(world.rooms, world.inmates, 'medium', 2)
    expect(housing).toEqual({ kind: 'cell', roomId: cellId })
  })

  it('falls back to a holding pen when every cell is taken', () => {
    const events = new RecordingSink()
    const world = createInmateWorld({ size: 40, data: DATA, continuousIntake: false })
    const cellId = furnishCell(world, events, { x: 2, y: 2, width: 4, height: 5 })
    const penId = furnishHoldingPen(world, events, { x: 10, y: 2, width: 7, height: 7 })

    const first = arriveInmate({
      world,
      data: DATA,
      rng: new Rng(SEED),
      events,
      tick: 1,
      category: 'medium',
    })
    expect(first?.inmate.cellId).toBe(cellId)

    const second = arriveInmate({
      world,
      data: DATA,
      rng: new Rng(SEED + 1),
      events,
      tick: 2,
      category: 'medium',
    })
    expect(second?.inmate.cellId).toBe(penId)
    expect(events.of('intake.noHousing')).toHaveLength(0)
  })

  it('stands in the intake hall and warns when there is no cell or holding pen', () => {
    const events = new RecordingSink()
    const world = createInmateWorld({ size: 40, data: DATA, continuousIntake: false })
    const hallId = furnishIntakeHall(world, events, { x: 2, y: 2, width: 6, height: 6 })

    const inmate = arriveInmate({
      world,
      data: DATA,
      rng: new Rng(SEED),
      events,
      tick: 5,
      category: 'minimum',
    })

    expect(inmate?.inmate.cellId).toBe(hallId)
    const warnings = events.of('intake.noHousing')
    expect(warnings).toHaveLength(1)
    expect(warnings[0]?.data).toMatchObject({
      inmateId: inmate?.id,
      severity: 'warn',
      reason: 'no-free-cell-or-holding-pen',
      roomId: hallId,
    })
  })

  it('warns with a Traceable event when there is nowhere at all to stand', () => {
    const events = new RecordingSink()
    const world = createInmateWorld({ size: 24, data: DATA, continuousIntake: false })

    const inmate = arriveInmate({
      world,
      data: DATA,
      rng: new Rng(SEED),
      events,
      tick: 3,
      category: 'medium',
    })

    expect(inmate?.inmate.cellId).toBe(NO_ROOM)
    const warnings = events.of('intake.noHousing')
    expect(warnings).toHaveLength(1)
    expect(warnings[0]?.data).toMatchObject({
      severity: 'warn',
      reason: 'no-free-cell-holding-pen-or-intake-hall',
      roomId: NO_ROOM,
    })
  })

  it('skips cells whose sector does not admit the inmate category (T2.4 / T5.2)', () => {
    const events = new RecordingSink()
    const world = createInmateWorld({ size: 40, data: DATA, continuousIntake: false })
    const minCell = furnishCell(world, events, { x: 2, y: 2, width: 4, height: 5 })
    const maxCell = furnishCell(world, events, { x: 8, y: 2, width: 4, height: 5 })

    const sector = world.sectors.create(DATA, {
      name: 'Minimum wing',
      access: 'shared',
      categories: ['minimum'],
    })
    expect(sector).toBeDefined()
    if (sector === undefined) throw new Error('sector')
    const minRoom = world.rooms.get(minCell)
    expect(minRoom).toBeDefined()
    if (minRoom === undefined) throw new Error('min cell')
    world.sectors.paintTiles(world.grid, minRoom.tiles, sector.id)

    const housing = findHousing(world.rooms, world.inmates, 'maximum', 2, {
      data: DATA,
      grid: world.grid,
      sectors: world.sectors,
    })
    expect(housing).toEqual({ kind: 'cell', roomId: maxCell })
  })

  it('prefers the cell whose grade is closest to entitlement', () => {
    const events = new RecordingSink()
    const world = createInmateWorld({ size: 40, data: DATA, continuousIntake: false })
    const bare = furnishCell(world, events, { x: 2, y: 2, width: 4, height: 5 })
    const lush = furnishCell(world, events, { x: 8, y: 2, width: 4, height: 5 })

    const housing = findHousing(world.rooms, world.inmates, 'medium', 8, {
      data: DATA,
      grid: world.grid,
      sectors: world.sectors,
      grades: new Map([
        [bare, { score: 1 }],
        [lush, { score: 8 }],
      ]),
    })
    expect(housing).toEqual({ kind: 'cell', roomId: lush })
  })
})

/* -------------------------------------------------------------------------- */
/* Capacity / intake                                                           */
/* -------------------------------------------------------------------------- */

describe('intake capacity edge cases', () => {
  it('counts functional cells toward housing capacity', () => {
    const events = new RecordingSink()
    const world = createInmateWorld({ size: 40, data: DATA })
    expect(housingCapacity(world.rooms, world.objects)).toBe(0)
    furnishCell(world, events, { x: 2, y: 2, width: 4, height: 5 })
    furnishCell(world, events, { x: 8, y: 2, width: 4, height: 5 })
    expect(housingCapacity(world.rooms, world.objects)).toBe(2)
  })

  it('pays the intake fee on arrival', () => {
    const events = new RecordingSink()
    const world = createInmateWorld({ size: 40, data: DATA, continuousIntake: false })
    furnishCell(world, events, { x: 2, y: 2, width: 4, height: 5 })

    arriveInmate({
      world,
      data: DATA,
      rng: new Rng(SEED),
      events,
      tick: 1,
      category: 'maximum',
    })

    expect(world.incomeOwed).toBe(0)
    const fee = DATA.securityCategories.get('maximum').intakeFee
    const credit = world.economy.entries.find((e) => e.category === 'intake_fee')
    expect(credit).toMatchObject({ amount: fee, category: 'intake_fee' })
    expect(credit?.sourceEntityId).toBeGreaterThan(0)
  })

  it('does not bring continuous arrivals once capacity is full', () => {
    const events = new RecordingSink()
    const world = createInmateWorld({ size: 40, data: DATA, continuousIntake: true })
    furnishCell(world, events, { x: 2, y: 2, width: 4, height: 5 })

    const rng = new Rng(SEED)
    world.intake.nextBusAtTick = 0
    const first = runBusArrival(world, DATA, rng, events, 0)
    expect(first).toBe(1)
    expect(world.inmates.size).toBe(1)

    world.intake.nextBusAtTick = 0
    const second = runBusArrival(world, DATA, rng, events, 100)
    expect(second).toBe(0)
    expect(world.inmates.size).toBe(1)
  })

  it('manual intake drains requested counts and respects capacity', () => {
    const events = new RecordingSink()
    const world = createInmateWorld({ size: 40, data: DATA, continuousIntake: false })
    furnishCell(world, events, { x: 2, y: 2, width: 4, height: 5 })
    furnishCell(world, events, { x: 8, y: 2, width: 4, height: 5 })

    world.intake.requestedCounts.set('minimum', 5)
    world.intake.requestedCounts.set('medium', 1)
    world.intake.nextBusAtTick = 0

    const arrived = runBusArrival(world, DATA, new Rng(SEED), events, 0)
    // Capacity 2, maxPerBus 8 → two seats; requests sorted: medium then minimum?
    // Keys sorted alphabetically: medium, minimum.
    expect(arrived).toBe(2)
    expect(world.inmates.size).toBe(2)
    // medium was first alphabetically with 1 requested, then minimum.
    const categories = world.inmates
      .all()
      .map((inmate) => inmate.inmate.category)
      .sort()
    expect(categories).toEqual(['medium', 'minimum'])
    expect(world.intake.requestedCounts.get('minimum')).toBe(4)
    expect(world.intake.requestedCounts.has('medium')).toBe(false)
  })
})
