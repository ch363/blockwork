/**
 * T2.7 — staff hiring, escort jobs, office claims and fog of war.
 */

import { describe, expect, it } from 'vitest'

import { Rng } from '../../src/core/rng'
import { Simulation } from '../../src/core/simulation'
import type { SimulationEvent } from '../../src/core/simulation'
import { TICKS_PER_DAY } from '../../src/core/clock'
import { loadGameData } from '../../src/data/loader'
import { placeObject } from '../../src/entities/objects'
import type { ObjectDeps } from '../../src/entities/objects'
import {
  STAFF_EVENTS,
  hireStaff,
  fireStaff,
  openDoorAt,
  inmateBlockedByLockedSecure,
} from '../../src/entities/staff'
import type { InmateWorld } from '../../src/systems/intakeSystem'
import { arriveInmate, createInmateWorld } from '../../src/systems/intakeSystem'
import { createStaffSystem } from '../../src/systems/staffSystem'
import { refreshPassability } from '../../src/world/construction'
import type { Rect } from '../../src/world/construction'
import { initialLockState } from '../../src/world/doors'
import { designateRoom } from '../../src/world/roomDetection'
import type { RoomDeps } from '../../src/world/roomDetection'
import { PASSABILITY } from '../../src/world/tileGrid'

const DATA = loadGameData()
const SEED = 0xb10c_2007

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

function putDoor(
  world: InmateWorld,
  x: number,
  y: number,
  type: 'standard' | 'secure' | 'barred' = 'standard',
  locked?: boolean,
): number {
  const index = putFloor(world, x, y)
  world.grid.setAt('wallMaterial', index, 0)
  const def = world.data.doors.get(type)
  world.doors.place(index, type, locked ?? initialLockState(def))
  refreshPassability(world, world.data, index)
  world.structureChanged(index)
  return index
}

function putRoomShell(
  world: InmateWorld,
  rect: Rect,
  doorType: 'standard' | 'secure' | 'barred' = 'standard',
): void {
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
  putDoor(world, rect.x + Math.floor(rect.width / 2), rect.y + rect.height - 1, doorType)
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
  doorType: 'standard' | 'secure' | 'barred' = 'standard',
): number {
  putRoomShell(world, shell, doorType)
  const interior = interiorOf(shell)
  designateRoom(roomDeps(world, events), interior, roomDefId)
  const roomId = world.grid.get('roomId', interior.x, interior.y)
  if (roomId === 0) throw new Error(`no ${roomDefId} at (${interior.x}, ${interior.y})`)
  return roomId
}

function furnishOffice(world: InmateWorld, events: RecordingSink, shell: Rect): number {
  const roomId = makeRoom(world, events, shell, 'office')
  const interior = interiorOf(shell)
  const desk = placeObject(
    objectDeps(world, events),
    { x: interior.x, y: interior.y },
    'office_desk',
    0,
  )
  const chair = placeObject(
    objectDeps(world, events),
    { x: interior.x + 2, y: interior.y },
    'chair',
    0,
  )
  const cabinet = placeObject(
    objectDeps(world, events),
    { x: interior.x, y: interior.y + 2 },
    'filing_cabinet',
    0,
  )
  if (desk === undefined || chair === undefined || cabinet === undefined) {
    throw new Error(`failed to furnish office: ${JSON.stringify(events.of('objects.rejected'))}`)
  }
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
    throw new Error('failed to furnish cell')
  }
  return roomId
}

function furnishIntakeHall(world: InmateWorld, events: RecordingSink, shell: Rect): number {
  const roomId = makeRoom(world, events, shell, 'intake_hall')
  const interior = interiorOf(shell)
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
    throw new Error('failed to furnish intake hall')
  }
  return roomId
}

function runStaffTicks(
  world: InmateWorld,
  events: RecordingSink,
  ticks: number,
  seed = SEED,
): void {
  const simulation = new Simulation({
    seed,
    world,
    systems: [createStaffSystem({ data: DATA })],
    events,
  })
  for (let i = 0; i < ticks; i += 1) simulation.step()
}

/* -------------------------------------------------------------------------- */
/* Office claiming                                                             */
/* -------------------------------------------------------------------------- */

describe('office claiming (T2.7)', () => {
  it('claims and renames a free functional office when hiring an administrator', () => {
    const events = new RecordingSink()
    const world = createInmateWorld({
      size: 40,
      data: DATA,
      continuousIntake: false,
      research: 'all',
    })
    const roomId = furnishOffice(world, events, { x: 2, y: 2, width: 6, height: 6 })

    const result = hireStaff({
      world,
      defId: 'warden',
      events,
      tick: 1,
    })

    expect(result.entity).toBeDefined()
    expect(result.entity?.staff.officeRoomId).toBe(roomId)
    const claim = world.offices.get(roomId)
    expect(claim).toEqual({
      roomId,
      staffId: result.entity?.id,
      displayName: "Warden's Office",
    })
    expect(events.of(STAFF_EVENTS.officeClaimed)).toHaveLength(1)
    expect(events.of(STAFF_EVENTS.hired)[0]?.data).toMatchObject({
      defId: 'warden',
      hireCost: DATA.staff.get('warden').hireCost,
      officeRoomId: roomId,
    })
    expect(world.economy.entries.some((e) => e.category === 'hire')).toBe(true)
    expect(world.spendOwed).toBe(0)
  })

  it('rejects an administrator hire when no free office remains', () => {
    const events = new RecordingSink()
    const world = createInmateWorld({
      size: 40,
      data: DATA,
      continuousIntake: false,
      research: 'all',
    })
    furnishOffice(world, events, { x: 2, y: 2, width: 6, height: 6 })

    expect(hireStaff({ world, defId: 'warden', events, tick: 1 }).entity).toBeDefined()
    const second = hireStaff({ world, defId: 'counsellor', events, tick: 2 })
    expect(second.entity).toBeUndefined()
    expect(second.reason).toBe('no-office')
    expect(
      events.of(STAFF_EVENTS.hireRejected).some((e) => {
        const data = e.data as { reason?: string }
        return data.reason === 'no-office'
      }),
    ).toBe(true)
  })
})

/* -------------------------------------------------------------------------- */
/* Wage accrual                                                                */
/* -------------------------------------------------------------------------- */

describe('hire costs (T2.7 / T3.6)', () => {
  it('debits hire cost onto the economy ledger immediately', () => {
    const events = new RecordingSink()
    const world = createInmateWorld({
      size: 24,
      data: DATA,
      continuousIntake: false,
      research: 'all',
    })
    const starting = world.economy.balance

    const officer = hireStaff({ world, defId: 'officer', events, tick: 0, tx: 2, ty: 2 })
    expect(officer.entity).toBeDefined()
    expect(world.economy.balance).toBe(starting - DATA.staff.get('officer').hireCost)
    const hire = world.economy.entries.find((e) => e.category === 'hire')
    expect(hire).toMatchObject({
      amount: -DATA.staff.get('officer').hireCost,
      sourceEntityId: officer.entity?.id,
    })
  })
})

/* -------------------------------------------------------------------------- */
/* Escort lifecycle                                                            */
/* -------------------------------------------------------------------------- */

describe('escort job lifecycle (T2.7)', () => {
  it('claims, picks up, escorts and completes', () => {
    const events = new RecordingSink()
    const world = createInmateWorld({
      size: 32,
      data: DATA,
      continuousIntake: false,
      research: 'all',
    })

    // Open corridor: officer at (2,2), inmate at (5,2), destination at (10,2).
    for (let x = 1; x <= 12; x += 1) putFloor(world, x, 2)

    const hire = hireStaff({ world, defId: 'officer', events, tick: 0, tx: 2, ty: 2 })
    expect(hire.entity).toBeDefined()

    const inmate = arriveInmate({
      world,
      data: DATA,
      rng: new Rng(SEED),
      events,
      tick: 0,
      category: 'medium',
    })
    expect(inmate).toBeDefined()
    // Force positions: arrive with no housing leaves them at origin.
    const units = DATA.balance.map.tileWorldUnits
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- asserted above
    const person = inmate!
    person.tx = 5
    person.ty = 2
    person.x = (5 + 0.5) * units
    person.y = (2 + 0.5) * units

    const dest = world.grid.idx(10, 2)
    const job = world.escorts.enqueue({
      inmateId: person.id,
      destinationTile: dest,
      purpose: 'cell_assignment',
    })

    runStaffTicks(world, events, 400)

    expect(events.of(STAFF_EVENTS.escortClaimed).length).toBeGreaterThan(0)
    expect(events.of(STAFF_EVENTS.escortCompleted).length).toBeGreaterThan(0)
    expect(person.tx).toBe(10)
    expect(person.ty).toBe(2)
    // Completed jobs are pruned from the queue; duty returns to idle.
    expect(world.escorts.get(job.id)).toBeUndefined()
    expect(hire.entity?.staff.duty.kind).toBe('idle')
  })
})

/* -------------------------------------------------------------------------- */
/* Locked secure doors                                                         */
/* -------------------------------------------------------------------------- */

describe('locked secure doors (T2.7)', () => {
  it('lets an officer open a locked secure door for a nearby inmate', () => {
    const events = new RecordingSink()
    const world = createInmateWorld({
      size: 24,
      data: DATA,
      continuousIntake: false,
      research: 'all',
    })
    for (let x = 1; x <= 8; x += 1) putFloor(world, x, 4)
    const doorTile = putDoor(world, 5, 4, 'barred', true)
    expect(inmateBlockedByLockedSecure(world, DATA, doorTile)).toBe(true)
    expect((world.grid.passability[doorTile] ?? 0) & PASSABILITY.WALKABLE).toBe(0)

    hireStaff({ world, defId: 'officer', events, tick: 0, tx: 4, ty: 4 })
    const inmate = arriveInmate({
      world,
      data: DATA,
      rng: new Rng(SEED),
      events,
      tick: 0,
      category: 'medium',
    })
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- asserted by hire path
    const person = inmate!
    const units = DATA.balance.map.tileWorldUnits
    person.tx = 4
    person.ty = 4
    person.x = (4 + 0.5) * units
    person.y = (4 + 0.5) * units

    runStaffTicks(world, events, 5)

    expect(events.of(STAFF_EVENTS.doorOpened).length).toBeGreaterThan(0)
    expect(world.doors.get(doorTile)?.locked).toBe(false)
    expect((world.grid.passability[doorTile] ?? 0) & PASSABILITY.WALKABLE).toBe(
      PASSABILITY.WALKABLE,
    )
  })

  it('keeps inmates blocked when no officers remain', () => {
    const events = new RecordingSink()
    const world = createInmateWorld({
      size: 24,
      data: DATA,
      continuousIntake: false,
      research: 'all',
    })
    for (let x = 1; x <= 8; x += 1) putFloor(world, x, 4)
    const doorTile = putDoor(world, 5, 4, 'barred', true)

    const hire = hireStaff({ world, defId: 'officer', events, tick: 0, tx: 4, ty: 4 })
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- hire succeeded
    fireStaff(world, hire.entity!.id, events, 1)

    const inmate = arriveInmate({
      world,
      data: DATA,
      rng: new Rng(SEED),
      events,
      tick: 2,
      category: 'medium',
    })
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const person = inmate!
    const units = DATA.balance.map.tileWorldUnits
    person.tx = 4
    person.ty = 4
    person.x = (4 + 0.5) * units
    person.y = (4 + 0.5) * units

    runStaffTicks(world, events, 20)

    expect(world.doors.get(doorTile)?.locked).toBe(true)
    expect(inmateBlockedByLockedSecure(world, DATA, doorTile)).toBe(true)
    expect(events.of(STAFF_EVENTS.doorOpened)).toHaveLength(0)
  })
})

/* -------------------------------------------------------------------------- */
/* Acceptance: 20 officers / cell escorts                                      */
/* -------------------------------------------------------------------------- */

describe('cell assignment escorts (T2.7 acceptance)', () => {
  it('completes cell escorts for many inmates within one in-game day', () => {
    const events = new RecordingSink()
    const world = createInmateWorld({
      size: 160,
      data: DATA,
      continuousIntake: false,
      research: 'all',
    })
    const inmateCount = 200
    const officerCount = 20

    // Two rows of cells, each with a corridor on its south side.
    furnishIntakeHall(world, events, { x: 2, y: 2, width: 6, height: 6 })

    const cellIds: number[] = []
    for (let i = 0; i < inmateCount; i += 1) {
      const col = i % 20
      const row = Math.floor(i / 20)
      const x = 12 + col * 5
      const y = 2 + row * 8
      cellIds.push(furnishCell(world, events, { x, y, width: 4, height: 6 }))
    }

    // Corridors under each row (door at y+5 for shell height 6 → south at y+5).
    for (let row = 0; row < 10; row += 1) {
      const corridorY = 2 + row * 8 + 6
      for (let x = 2; x < 120; x += 1) putFloor(world, x, corridorY)
    }
    // Vertical spine from intake to every corridor.
    for (let y = 2; y < 90; y += 1) putFloor(world, 5, y)

    for (let i = 0; i < officerCount; i += 1) {
      const result = hireStaff({
        world,
        defId: 'officer',
        events,
        tick: 0,
        tx: 4 + (i % 5),
        ty: 8,
      })
      expect(result.entity).toBeDefined()
    }

    for (let i = 0; i < inmateCount; i += 1) {
      const inmate = arriveInmate({
        world,
        data: DATA,
        rng: new Rng(SEED + i),
        events,
        tick: 0,
        category: 'medium',
      })
      expect(inmate?.inmate.cellId).toBe(cellIds[i])
    }

    expect(world.escorts.queued().length + world.escorts.active().length).toBe(inmateCount)

    runStaffTicks(world, events, TICKS_PER_DAY)

    expect(events.of(STAFF_EVENTS.escortCompleted).length).toBe(inmateCount)
    for (const inmate of world.inmates.all()) {
      const room = world.rooms.get(inmate.inmate.cellId)
      expect(room?.defId).toBe('cell')
      expect(room?.tiles.includes(world.grid.idx(inmate.tx, inmate.ty))).toBe(true)
    }
  }, 120_000)
})

/* -------------------------------------------------------------------------- */
/* Fog                                                                         */
/* -------------------------------------------------------------------------- */

describe('officer fog of war (T2.7)', () => {
  it('reveals tiles around a patrolling officer', () => {
    const events = new RecordingSink()
    const world = createInmateWorld({
      size: 24,
      data: DATA,
      continuousIntake: false,
      research: 'all',
    })
    for (let y = 1; y < 12; y += 1) {
      for (let x = 1; x < 12; x += 1) putFloor(world, x, y)
    }
    hireStaff({ world, defId: 'officer', events, tick: 0, tx: 5, ty: 5 })
    expect(world.fog.isRevealed(5, 5)).toBe(false)
    runStaffTicks(world, events, 2)
    expect(world.fog.isRevealed(5, 5)).toBe(true)
    expect(world.fog.isRevealed(5 + DATA.balance.staff.fogRadiusTiles, 5)).toBe(true)
  })
})

describe('protective vests (T4.5 / T5.1)', () => {
  it('issues a vest on hire only after protective_vests is researched', () => {
    const events = new RecordingSink()
    const world = createInmateWorld({
      size: 24,
      data: DATA,
      continuousIntake: false,
    })
    for (let y = 1; y < 8; y += 1) {
      for (let x = 1; x < 8; x += 1) putFloor(world, x, y)
    }

    const locked = hireStaff({ world, defId: 'officer', events, tick: 0, tx: 3, ty: 3 })
    expect(locked.entity).toBeDefined()
    if (locked.entity === undefined) throw new Error('hire')
    expect(world.combat.wearingVest('staff', locked.entity.id)).toBe(false)

    world.directorate.grant('protective_vests')
    const unlocked = hireStaff({ world, defId: 'officer', events, tick: 1, tx: 5, ty: 5 })
    expect(unlocked.entity).toBeDefined()
    if (unlocked.entity === undefined) throw new Error('hire vest')
    expect(world.combat.wearingVest('staff', unlocked.entity.id)).toBe(true)
  })
})

/* -------------------------------------------------------------------------- */
/* openDoorAt helper                                                           */
/* -------------------------------------------------------------------------- */

describe('openDoorAt', () => {
  it('refreshes passability when unlocking', () => {
    const events = new RecordingSink()
    const world = createInmateWorld({
      size: 16,
      data: DATA,
      continuousIntake: false,
      research: 'all',
    })
    putFloor(world, 3, 3)
    putFloor(world, 4, 3)
    const doorTile = putDoor(world, 4, 3, 'barred', true)
    expect(openDoorAt(world, DATA, doorTile, events, 1, 99)).toBe(true)
    expect(world.doors.get(doorTile)?.locked).toBe(false)
  })
})
