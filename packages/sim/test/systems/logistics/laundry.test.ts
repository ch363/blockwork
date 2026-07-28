/**
 * T3.5 — uniform lifecycle and laundry→block routing.
 */

import { describe, expect, it } from 'vitest'

import {
  TICKS_PER_DAY,
  TICKS_PER_HOUR,
  TICKS_PER_MINUTE,
} from '../../../src/core/clock'
import type { SimulationEvent } from '../../../src/core/simulation'
import { Rng } from '../../../src/core/rng'
import { loadGameData } from '../../../src/data/loader'
import { createInmateShell, generateInmate } from '../../../src/entities/inmate'
import { hireStaff } from '../../../src/entities/staff'
import { placeObject } from '../../../src/entities/objects'
import { createInmateWorld } from '../../../src/systems/intakeSystem'
import type { InmateWorld } from '../../../src/systems/intakeSystem'
import {
  LAUNDRY_EVENTS,
  ironPerHour,
  selectHousingForLaundry,
  uniformsPerHour,
  updateLaundry,
} from '../../../src/systems/logistics/laundry'
import { refreshPassability } from '../../../src/world/construction'
import type { Rect } from '../../../src/world/construction'
import { initialLockState } from '../../../src/world/doors'
import { designateRoom } from '../../../src/world/roomDetection'
import { roomCentroidDistance } from '../../../src/systems/logistics/mealChain'

const DATA = loadGameData()
const LAUNDRY = DATA.balance.logistics.laundry
const SEED = 0xb10c_3005

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
      if (onEdge) {
        const midX = x === Math.floor(rect.x + rect.width / 2)
        const midY = y === Math.floor(rect.y + rect.height / 2)
        const onDoor =
          (midX && (y === rect.y || y === rect.y + rect.height - 1)) ||
          (midY && (x === rect.x || x === rect.x + rect.width - 1))
        if (onDoor) putDoor(world, x, y)
        else putWall(world, x, y)
      } else {
        putFloor(world, x, y)
      }
    }
  }
}

function interiorOf(rect: Rect): Rect {
  return {
    x: rect.x + 1,
    y: rect.y + 1,
    width: rect.width - 2,
    height: rect.height - 2,
  }
}

function objectDeps(world: InmateWorld, events: RecordingSink, tick = 0) {
  return { world, data: DATA, events, tick }
}

function roomDeps(world: InmateWorld, events: RecordingSink, tick = 0) {
  return { world, data: DATA, events, tick }
}

interface LaundryFacility {
  readonly world: InmateWorld
  readonly events: RecordingSink
  readonly laundryId: number
  readonly cellNearId: number
  readonly cellFarId: number
  readonly bedNearId: number
  readonly bedFarId: number
  readonly machineCount: number
}

function buildLaundryFacility(options: {
  readonly machines?: number
  readonly boards?: number
  readonly hireCleaners?: number
  readonly laundryLabour?: number
  readonly mapSize?: number
}): LaundryFacility {
  const events = new RecordingSink()
  const world = createInmateWorld({
    size: options.mapSize ?? 64,
    data: DATA,
    continuousIntake: false,
  })

  const laundryShell = { x: 2, y: 2, width: 12, height: 10 }
  const nearCellShell = { x: 16, y: 2, width: 6, height: 6 }
  const farCellShell = { x: 40, y: 30, width: 6, height: 6 }
  putRoomShell(world, laundryShell)
  putRoomShell(world, nearCellShell)
  putRoomShell(world, farCellShell)

  const laundryInterior = interiorOf(laundryShell)
  const nearInterior = interiorOf(nearCellShell)
  const farInterior = interiorOf(farCellShell)

  designateRoom(roomDeps(world, events), laundryInterior, 'laundry')
  designateRoom(roomDeps(world, events), nearInterior, 'cell')
  designateRoom(roomDeps(world, events), farInterior, 'cell')

  const laundryRoom = [...world.rooms.all()].find((room) => room.defId === 'laundry')
  const cells = [...world.rooms.all()].filter((room) => room.defId === 'cell').sort((a, b) => a.id - b.id)
  if (laundryRoom === undefined || cells.length < 2) {
    throw new Error('expected laundry and two cells')
  }
  // nearer cell is the one with smaller centroid distance
  const sorted = [...cells].sort(
    (a, b) =>
      roomCentroidDistance(laundryRoom, a, world.grid.size) -
      roomCentroidDistance(laundryRoom, b, world.grid.size),
  )
  const nearCell = sorted[0]
  const farCell = sorted[1]
  if (nearCell === undefined || farCell === undefined) throw new Error('cells missing')

  world.laundry.roomNames.set(laundryRoom.id, 'Block Laundry')

  const machines = options.machines ?? 2
  let placed = 0
  for (let x = laundryInterior.x; x < laundryInterior.x + laundryInterior.width && placed < machines; x += 2) {
    const result = placeObject(
      objectDeps(world, events),
      { x, y: laundryInterior.y + 1 },
      'washing_machine',
      0,
    )
    if (result === undefined) throw new Error('washing machine failed')
    placed += 1
  }

  const boards = options.boards ?? machines
  let placedBoards = 0
  for (
    let x = laundryInterior.x;
    x < laundryInterior.x + laundryInterior.width && placedBoards < boards;
    x += 2
  ) {
    const result = placeObject(
      objectDeps(world, events),
      { x, y: laundryInterior.y + 3 },
      'ironing_board',
      0,
    )
    if (result === undefined) throw new Error('ironing board failed')
    placedBoards += 1
  }

  const laundryBasket = placeObject(
    objectDeps(world, events),
    { x: laundryInterior.x + 1, y: laundryInterior.y + 5 },
    'laundry_basket',
    0,
  )
  if (laundryBasket === undefined) throw new Error('laundry basket failed')

  const bedNear = placeObject(
    objectDeps(world, events),
    { x: nearInterior.x, y: nearInterior.y },
    'bed',
    0,
  )
  const toiletNear = placeObject(
    objectDeps(world, events),
    { x: nearInterior.x + 1, y: nearInterior.y },
    'toilet',
    0,
  )
  const basketNear = placeObject(
    objectDeps(world, events),
    { x: nearInterior.x, y: nearInterior.y + 1 },
    'laundry_basket',
    0,
  )
  const bedFar = placeObject(
    objectDeps(world, events),
    { x: farInterior.x, y: farInterior.y },
    'bed',
    0,
  )
  const toiletFar = placeObject(
    objectDeps(world, events),
    { x: farInterior.x + 1, y: farInterior.y },
    'toilet',
    0,
  )
  if (
    bedNear === undefined ||
    toiletNear === undefined ||
    basketNear === undefined ||
    bedFar === undefined ||
    toiletFar === undefined
  ) {
    throw new Error('cell fixtures failed')
  }

  const cleaners = options.hireCleaners ?? 1
  for (let i = 0; i < cleaners; i += 1) {
    const hired = hireStaff({
      world,
      defId: 'cleaner',
      events,
      tick: 0,
      tx: laundryInterior.x + 2 + i,
      ty: laundryInterior.y + 4,
    })
    if (hired.entity === undefined) throw new Error('hire cleaner failed')
  }

  const labour = options.laundryLabour ?? 0
  for (let i = 0; i < labour; i += 1) {
    const component = generateInmate({
      data: DATA,
      rng: new Rng(SEED + i).stream('laundry'),
      category: 'medium',
    })
    component.jobId = 'laundry'
    const shell = createInmateShell({
      id: world.inmates.allocateId(),
      data: DATA,
      inmate: component,
      tx: laundryInterior.x + 3,
      ty: laundryInterior.y + 4,
    })
    world.inmates.add(shell)
    world.routineRuntime.stateOf(shell.id).blockId = 'work_free'
  }

  return {
    world,
    events,
    laundryId: laundryRoom.id,
    cellNearId: nearCell.id,
    cellFarId: farCell.id,
    bedNearId: bedNear.id,
    bedFarId: bedFar.id,
    machineCount: machines,
  }
}

describe('laundry capacity formula', () => {
  it('mirrors the kitchen assist shape', () => {
    expect(uniformsPerHour(2, 0, LAUNDRY)).toBe(2 * LAUNDRY.uniformsPerMachinePerHour)
    expect(uniformsPerHour(2, 2, LAUNDRY)).toBe(
      2 * LAUNDRY.uniformsPerMachinePerHour * (1 + LAUNDRY.labourAssistBonus * 2),
    )
    expect(ironPerHour(1, 1, LAUNDRY)).toBe(
      LAUNDRY.uniformsPerBoardPerHour * (1 + LAUNDRY.labourAssistBonus),
    )
  })

  it('a correctly sized laundry covers 200 inmates per day', () => {
    // 200 uniforms/day ≈ 8.33/hour. One machine + one labour → 15/hour.
    const capacity = uniformsPerHour(1, 1, LAUNDRY)
    expect(capacity).toBeGreaterThanOrEqual(200 / 24)
  })
})

describe('uniform lifecycle', () => {
  it('accrues dirtiness, collects, washes, irons, redistributes, and discharges clothing', () => {
    const { world, events, cellNearId } = buildLaundryFacility({
      machines: 2,
      boards: 2,
      hireCleaners: 2,
      laundryLabour: 2,
    })

    const clothingIndex = DATA.needs.indexOf('clothing')
    const component = generateInmate({
      data: DATA,
      rng: new Rng(SEED).stream('wearer'),
      category: 'medium',
    })
    const shell = createInmateShell({
      id: world.inmates.allocateId(),
      data: DATA,
      inmate: component,
      tx: 17,
      ty: 3,
    })
    world.inmates.add(shell)
    world.inmates.assignHousing(shell.id, cellNearId)
    shell.inmate.needs[clothingIndex] = 70

    // Day 1 boundary: dirtiness accrues, deposits on the bed, then collectors
    // move it into the laundry wash queue in the same minute.
    updateLaundry(world, DATA, events, TICKS_PER_DAY)
    expect(world.laundry.uniformDirtiness.get(shell.id) ?? 0).toBe(0)
    expect(
      (world.laundry.pendingWash.get(world.rooms.all().find((r) => r.defId === 'laundry')?.id ?? -1) ??
        0) +
        [...world.laundry.basketDirty.values()].reduce((a, b) => a + b, 0) +
        [...world.laundry.bedDirty.values()].reduce((a, b) => a + b, 0),
    ).toBeGreaterThan(0)
    expect(events.of(LAUNDRY_EVENTS.collected).length).toBeGreaterThan(0)

    // Run enough minutes for wash + iron + distribute + deliver.
    for (let m = 1; m <= 120; m += 1) {
      updateLaundry(world, DATA, events, TICKS_PER_DAY + m * TICKS_PER_MINUTE)
    }

    expect(events.of(LAUNDRY_EVENTS.washed).length).toBeGreaterThan(0)
    expect(events.of(LAUNDRY_EVENTS.ironed).length).toBeGreaterThan(0)
    expect(events.of(LAUNDRY_EVENTS.distributed).length).toBeGreaterThan(0)
    expect(events.of(LAUNDRY_EVENTS.clothingSatisfied).length).toBeGreaterThan(0)
    expect(shell.inmate.needs[clothingIndex]).toBe(0)
  })

  it('keeps clothing satisfied for a 200-inmate day with enough machines', () => {
    const { world, events, laundryId, cellNearId } = buildLaundryFacility({
      machines: 2,
      boards: 2,
      hireCleaners: 4,
      laundryLabour: 4,
    })

    const clothingIndex = DATA.needs.indexOf('clothing')
    const critical = DATA.needs.get('clothing').thresholds.critical
    const rng = new Rng(SEED)

    // Seed pending wash for a full day's load and ensure redistribute can clear it.
    world.laundry.pendingWash.set(laundryId, 200)
    world.inmates.assignHousing(
      (() => {
        const component = generateInmate({
          data: DATA,
          rng: rng.stream('seed'),
          category: 'medium',
        })
        const shell = createInmateShell({
          id: world.inmates.allocateId(),
          data: DATA,
          inmate: component,
          tx: 17,
          ty: 3,
        })
        world.inmates.add(shell)
        shell.inmate.needs[clothingIndex] = 50
        return shell.id
      })(),
      cellNearId,
    )

    // Pump a day of laundry minutes.
    for (let m = 0; m < 24 * 60; m += 1) {
      updateLaundry(world, DATA, events, TICKS_PER_HOUR + m * TICKS_PER_MINUTE)
    }

    expect(world.laundry.uniformsDistributed).toBeGreaterThanOrEqual(200)
    expect(world.laundry.pendingWash.get(laundryId) ?? 0).toBe(0)

    // Clothing receivers stay below critical after discharge.
    for (const inmate of world.inmates.all()) {
      expect(inmate.inmate.needs[clothingIndex] ?? 0).toBeLessThan(critical)
    }
  })
})

describe('laundry routing', () => {
  it('routes to the nearest housing block by default', () => {
    const { world, laundryId, cellNearId, cellFarId } = buildLaundryFacility({
      hireCleaners: 1,
    })
    const laundry = world.rooms.get(laundryId)
    const near = world.rooms.get(cellNearId)
    const far = world.rooms.get(cellFarId)
    if (laundry === undefined || near === undefined || far === undefined) {
      throw new Error('rooms missing')
    }

    const chosen = selectHousingForLaundry(laundry, [near, far], world.grid.size, {
      routingUnlocked: false,
      overrideHousingId: cellFarId,
    })
    expect(chosen?.id).toBe(cellNearId)
  })

  it('honours Delegation override when laundry_routing is unlocked', () => {
    const { world, events, laundryId, cellNearId, cellFarId, bedFarId } = buildLaundryFacility({
      hireCleaners: 2,
      laundryLabour: 2,
    })
    world.laundry.unlockFeature('laundry_routing')
    world.laundry.setRoutingOverride(laundryId, cellFarId)

    const laundry = world.rooms.get(laundryId)
    const near = world.rooms.get(cellNearId)
    const far = world.rooms.get(cellFarId)
    if (laundry === undefined || near === undefined || far === undefined) {
      throw new Error('rooms missing')
    }

    const chosen = selectHousingForLaundry(laundry, [near, far], world.grid.size, {
      routingUnlocked: true,
      overrideHousingId: cellFarId,
    })
    expect(chosen?.id).toBe(cellFarId)

    world.laundry.ironedReady.set(laundryId, 3)
    updateLaundry(world, DATA, events, TICKS_PER_MINUTE)
    expect(world.laundry.bedClean.get(bedFarId) ?? 0).toBeGreaterThan(0)
    const distributed = events.of(LAUNDRY_EVENTS.distributed)[0]
    expect(distributed).toBeDefined()
    expect(distributed?.data).toMatchObject({ housingRoomId: cellFarId })
  })
})
