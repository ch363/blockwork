/**
 * T2.6 — Routine system and activity: block mapping, sleep rule, free-choice,
 * hour-boundary transitions.
 */

import { describe, expect, it } from 'vitest'

import { Clock, TICKS_PER_HOUR, TICKS_PER_MINUTE } from '../../src/core/clock'
import { Simulation } from '../../src/core/simulation'
import type { SimulationEvent, SystemContext } from '../../src/core/simulation'
import { Rng } from '../../src/core/rng'
import { loadGameData } from '../../src/data/loader'
import { createInmateShell, generateInmate } from '../../src/entities/inmate'
import type { InmateEntity } from '../../src/entities/inmate'
import { NeedIndex } from '../../src/entities/needs'
import { NO_OBJECT, placeObject } from '../../src/entities/objects'
import type { ObjectDeps } from '../../src/entities/objects'
import type { InmateWorld } from '../../src/systems/intakeSystem'
import { createInmateWorld } from '../../src/systems/intakeSystem'
import {
  ACTIVITY_SYSTEM_NAME,
  ACTIVITY_SYSTEM_PERIOD,
  createActivitySystem,
} from '../../src/systems/activitySystem'
import {
  ROUTINE_COMMANDS,
  ROUTINE_SYSTEM_NAME,
  ROUTINE_SYSTEM_PERIOD,
  createRoutineSystem,
  routineCommandHandlers,
} from '../../src/systems/routineSystem'
import { refreshPassability } from '../../src/world/construction'
import type { Rect } from '../../src/world/construction'
import { initialLockState } from '../../src/world/doors'
import { designateRoom } from '../../src/world/roomDetection'
import type { RoomDeps } from '../../src/world/roomDetection'
import {
  ACTIVITY_EVENTS,
  ROUTINE_EVENTS,
  isSleepForbidden,
  isSleepForbiddenAt,
  permittedRoomsForBlock,
  preferredNeedForBlock,
  rankFreeChoice,
  setCategoryRoutine,
} from '../../src/world/routine'
import type { RoutineBlockId } from '../../src/data/schemas'

const RAW_DATA = loadGameData()
const DATA = {
  ...RAW_DATA,
  balance: {
    ...RAW_DATA.balance,
    utilities: { ...RAW_DATA.balance.utilities, utilitiesEnabled: false },
  },
}
const INDEX = NeedIndex.fromData(DATA)
const SEED = 0xb10c_2006

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
  putDoor(world, rect.x + Math.floor(rect.width / 2), rect.y + rect.height - 1)
}

function interiorOf(rect: Rect): Rect {
  return { x: rect.x + 1, y: rect.y + 1, width: rect.width - 2, height: rect.height - 2 }
}

function spawnInmate(world: InmateWorld, x: number, y: number, category = 'medium'): InmateEntity {
  const component = generateInmate({
    data: world.data,
    rng: new Rng(SEED).stream('test'),
    category,
  })
  const id = world.inmates.allocateId()
  const entity = createInmateShell({
    id,
    data: world.data,
    inmate: {
      ...component,
      traits: [...component.traits],
      addictions: [...component.addictions],
      status: [...component.status],
      needs: new Float32Array(component.needs),
    },
    tx: x,
    ty: y,
    x,
    y,
  })
  world.inmates.add(entity)
  return entity
}

function contextAt(world: InmateWorld, events: RecordingSink, tick: number): SystemContext {
  const clock = new Clock(tick)
  return {
    clock,
    rng: new Rng(SEED),
    world,
    events,
  }
}

/* -------------------------------------------------------------------------- */
/* Block → room-set mapping                                                    */
/* -------------------------------------------------------------------------- */

describe('block-to-room-set mapping', () => {
  it('maps each PRD block to the expected permitted rooms and preferred need', () => {
    const expected: Record<
      RoutineBlockId,
      { rooms: readonly string[]; need: string | null; goal: string | null }
    > = {
      lockup: { rooms: ['cell', 'dormitory', 'isolation'], need: null, goal: null },
      sleep: { rooms: ['cell', 'dormitory'], need: 'sleep', goal: null },
      meal: { rooms: ['mess_hall'], need: 'food', goal: 'serving_counter' },
      yard: { rooms: ['exercise_yard'], need: 'exercise', goal: 'yard' },
      wash: { rooms: ['washroom'], need: 'hygiene', goal: 'shower_head' },
      free: {
        rooms: permittedRoomsForBlock(DATA, 'free'),
        need: null,
        goal: null,
      },
      work_free: {
        rooms: permittedRoomsForBlock(DATA, 'work_free'),
        need: null,
        goal: null,
      },
      work_lockup: {
        rooms: permittedRoomsForBlock(DATA, 'work_lockup'),
        need: null,
        goal: null,
      },
    }

    for (const [blockId, want] of Object.entries(expected)) {
      const id = blockId as RoutineBlockId
      expect(permittedRoomsForBlock(DATA, id)).toEqual(want.rooms)
      expect(preferredNeedForBlock(DATA, id)).toBe(want.need)
      expect(DATA.balance.routine.blocks[id].goalSet).toBe(want.goal)
    }
  })

  it('includes mess hall, washroom, yard and cell among free permitted rooms', () => {
    const free = permittedRoomsForBlock(DATA, 'free')
    expect(free).toContain('mess_hall')
    expect(free).toContain('washroom')
    expect(free).toContain('exercise_yard')
    expect(free).toContain('cell')
  })
})

/* -------------------------------------------------------------------------- */
/* Sleep rule                                                                  */
/* -------------------------------------------------------------------------- */

describe('sleep rule', () => {
  it('forbids sleep from 08:00 inclusive to 20:00 exclusive', () => {
    const { sleepForbiddenFromHour, sleepForbiddenUntilHour } = DATA.balance.routine
    expect(sleepForbiddenFromHour).toBe(8)
    expect(sleepForbiddenUntilHour).toBe(20)

    expect(isSleepForbidden(7, 8, 20)).toBe(false)
    expect(isSleepForbidden(8, 8, 20)).toBe(true)
    expect(isSleepForbidden(12, 8, 20)).toBe(true)
    expect(isSleepForbidden(19, 8, 20)).toBe(true)
    expect(isSleepForbidden(20, 8, 20)).toBe(false)
    expect(isSleepForbiddenAt(DATA, 8)).toBe(true)
    expect(isSleepForbiddenAt(DATA, 20)).toBe(false)
  })

  it('refuses to claim a bed during the forbidden window', () => {
    const events = new RecordingSink()
    const world = createInmateWorld({ size: 24, data: DATA, continuousIntake: false })
    world.grid.fill('temperature', 18)

    const cellRect = { x: 2, y: 2, width: 5, height: 5 }
    putRoomShell(world, cellRect)
    const interior = interiorOf(cellRect)
    const roomDeps: RoomDeps = { world, data: DATA, events, tick: 0 }
    designateRoom(roomDeps, interior, 'cell')

    const bedX = interior.x
    const bedY = interior.y
    const objectDeps: ObjectDeps = { world, data: DATA, events, tick: 0 }
    placeObject(objectDeps, { x: bedX, y: bedY }, 'bed', 0)
    placeObject(objectDeps, { x: bedX + 1, y: bedY }, 'toilet', 0)

    const inmate = spawnInmate(world, bedX, bedY)
    const rooms = [...world.rooms.all()]
    const cell = rooms.find((room) => room.defId === 'cell')
    expect(cell).toBeDefined()
    if (cell !== undefined) world.inmates.assignHousing(inmate.id, cell.id)

    INDEX.set(inmate.inmate.needs, 'sleep', 80)

    // Force a sleep-block assignment as if the hour had just landed.
    const runtime = world.routineRuntime.stateOf(inmate.id)
    runtime.blockId = 'sleep'
    runtime.permittedRooms = permittedRoomsForBlock(DATA, 'sleep')
    runtime.preferredNeed = 'sleep'
    runtime.lockedUp = true

    const activity = createActivitySystem({ data: DATA, index: INDEX })
    // Tick corresponding to 10:00 — well inside the forbidden window.
    const tickAt10 = 10 * TICKS_PER_HOUR
    activity.update(contextAt(world, events, tickAt10))

    expect(world.needsRuntime.stateOf(inmate.id).usingObjectId).toBe(NO_OBJECT)
    expect(events.of(ACTIVITY_EVENTS.beganUsing)).toHaveLength(0)

    // Same assignment at 21:00 — sleep is allowed again.
    events.clear()
    const tickAt21 = 21 * TICKS_PER_HOUR
    activity.update(contextAt(world, events, tickAt21))
    expect(world.needsRuntime.stateOf(inmate.id).usingObjectId).not.toBe(NO_OBJECT)
    expect(events.of(ACTIVITY_EVENTS.beganUsing)).toHaveLength(1)
  })
})

/* -------------------------------------------------------------------------- */
/* Free-choice ranking                                                         */
/* -------------------------------------------------------------------------- */

describe('free-choice selection ranking', () => {
  it('prefers the higher need when travel times are equal', () => {
    const pick = rankFreeChoice(
      [
        { needId: 'food', roomDefId: 'mess_hall', needValue: 40, travelMinutes: 10 },
        { needId: 'hygiene', roomDefId: 'washroom', needValue: 70, travelMinutes: 10 },
      ],
      0.35,
    )
    expect(pick?.needId).toBe('hygiene')
    expect(pick?.roomDefId).toBe('washroom')
  })

  it('penalises distant rooms by travelTimeWeight', () => {
    const weight = DATA.balance.routine.travelTimeWeight
    const pick = rankFreeChoice(
      [
        { needId: 'food', roomDefId: 'mess_hall', needValue: 60, travelMinutes: 100 },
        { needId: 'hygiene', roomDefId: 'washroom', needValue: 50, travelMinutes: 2 },
      ],
      weight,
    )
    // 60 - 0.35*100 = 25; 50 - 0.35*2 = 49.3 → hygiene wins despite lower need.
    expect(pick?.needId).toBe('hygiene')
  })

  it('breaks ties deterministically by need id then room def id', () => {
    const pick = rankFreeChoice(
      [
        { needId: 'recreation', roomDefId: 'dayroom', needValue: 50, travelMinutes: 5 },
        { needId: 'exercise', roomDefId: 'exercise_yard', needValue: 50, travelMinutes: 5 },
      ],
      0.35,
    )
    expect(pick?.needId).toBe('exercise')
  })

  it('picks the highest reachable need through RoutineSystem on a free block', () => {
    const events = new RecordingSink()
    const world = createInmateWorld({ size: 40, data: DATA, continuousIntake: false })
    world.grid.fill('temperature', 18)

    const hall = { x: 2, y: 2, width: 8, height: 7 }
    putRoomShell(world, hall)
    const hallInterior = interiorOf(hall)
    designateRoom({ world, data: DATA, events, tick: 0 }, hallInterior, 'mess_hall')
    // serving_counter is 3×1; table/bench are 2×1 — keep them on separate rows.
    expect(
      placeObject(
        { world, data: DATA, events, tick: 0 },
        { x: hallInterior.x, y: hallInterior.y },
        'serving_counter',
        0,
      ),
    ).toBeDefined()
    expect(
      placeObject(
        { world, data: DATA, events, tick: 0 },
        { x: hallInterior.x, y: hallInterior.y + 2 },
        'table',
        0,
      ),
    ).toBeDefined()
    expect(
      placeObject(
        { world, data: DATA, events, tick: 0 },
        { x: hallInterior.x, y: hallInterior.y + 3 },
        'bench',
        0,
      ),
    ).toBeDefined()

    const wash = { x: 14, y: 2, width: 5, height: 5 }
    putRoomShell(world, wash)
    const washInterior = interiorOf(wash)
    designateRoom({ world, data: DATA, events, tick: 0 }, washInterior, 'washroom')
    // Shower heads are wall fixtures — hang one on the north wall of the shell.
    expect(
      placeObject(
        { world, data: DATA, events, tick: 0 },
        { x: washInterior.x, y: wash.y },
        'shower_head',
        0,
      ),
    ).toBeDefined()

    const mess = [...world.rooms.all()].find((room) => room.defId === 'mess_hall')
    const washroom = [...world.rooms.all()].find((room) => room.defId === 'washroom')
    expect(mess && world.rooms.statusOf(mess.id)?.functional).toBe(true)
    expect(washroom && world.rooms.statusOf(washroom.id)?.functional).toBe(true)

    // Stand next to the mess hall so food is closer; hygiene is still higher
    // after the travel penalty.
    const inmate = spawnInmate(world, hallInterior.x + 1, hallInterior.y + 1)
    INDEX.set(inmate.inmate.needs, 'food', 40)
    INDEX.set(inmate.inmate.needs, 'hygiene', 80)

    const allFree = Array.from({ length: 24 }, () => 'free' as const)
    setCategoryRoutine(world.routines, 'medium', allFree)

    // Hour 10 is inside the sleep-forbidden window.
    createRoutineSystem({ data: DATA, index: INDEX }).update(
      contextAt(world, events, 10 * TICKS_PER_HOUR),
    )

    const runtime = world.routineRuntime.stateOf(inmate.id)
    expect(runtime.blockId).toBe('free')
    expect(runtime.freeChoiceNeed).toBe('hygiene')
    expect(runtime.freeChoiceRoomDef).toBe('washroom')
    expect(runtime.preferredNeed).toBe('hygiene')
    expect(runtime.goalSetId).toBe('shower_head')
  })

  it('does not select sleep during free choice in the forbidden window', () => {
    const events = new RecordingSink()
    const world = createInmateWorld({ size: 32, data: DATA, continuousIntake: false })
    world.grid.fill('temperature', 18)

    const cellRect = { x: 2, y: 2, width: 5, height: 5 }
    putRoomShell(world, cellRect)
    const cellInterior = interiorOf(cellRect)
    designateRoom({ world, data: DATA, events, tick: 0 }, cellInterior, 'cell')
    expect(
      placeObject(
        { world, data: DATA, events, tick: 0 },
        { x: cellInterior.x, y: cellInterior.y },
        'bed',
        0,
      ),
    ).toBeDefined()
    expect(
      placeObject(
        { world, data: DATA, events, tick: 0 },
        { x: cellInterior.x + 1, y: cellInterior.y },
        'toilet',
        0,
      ),
    ).toBeDefined()

    const hall = { x: 10, y: 2, width: 8, height: 7 }
    putRoomShell(world, hall)
    const hallInterior = interiorOf(hall)
    designateRoom({ world, data: DATA, events, tick: 0 }, hallInterior, 'mess_hall')
    expect(
      placeObject(
        { world, data: DATA, events, tick: 0 },
        { x: hallInterior.x, y: hallInterior.y },
        'serving_counter',
        0,
      ),
    ).toBeDefined()
    expect(
      placeObject(
        { world, data: DATA, events, tick: 0 },
        { x: hallInterior.x, y: hallInterior.y + 2 },
        'table',
        0,
      ),
    ).toBeDefined()
    expect(
      placeObject(
        { world, data: DATA, events, tick: 0 },
        { x: hallInterior.x, y: hallInterior.y + 3 },
        'bench',
        0,
      ),
    ).toBeDefined()

    const cell = [...world.rooms.all()].find((room) => room.defId === 'cell')
    const mess = [...world.rooms.all()].find((room) => room.defId === 'mess_hall')
    expect(cell && world.rooms.statusOf(cell.id)?.functional).toBe(true)
    expect(mess && world.rooms.statusOf(mess.id)?.functional).toBe(true)

    const inmate = spawnInmate(world, cellInterior.x + 1, cellInterior.y + 1)
    INDEX.set(inmate.inmate.needs, 'sleep', 95)
    INDEX.set(inmate.inmate.needs, 'food', 30)

    const allFree = Array.from({ length: 24 }, () => 'free' as const)
    setCategoryRoutine(world.routines, 'medium', allFree)

    createRoutineSystem({ data: DATA, index: INDEX }).update(
      contextAt(world, events, 10 * TICKS_PER_HOUR),
    )

    const runtime = world.routineRuntime.stateOf(inmate.id)
    expect(runtime.freeChoiceNeed).not.toBe('sleep')
    expect(runtime.freeChoiceNeed).toBe('food')
    expect(runtime.goalSetId).toBe('serving_counter')
  })
})

/* -------------------------------------------------------------------------- */
/* Hour boundary transitions                                                   */
/* -------------------------------------------------------------------------- */

describe('hour boundary transitions', () => {
  it('declares the hour period', () => {
    const system = createRoutineSystem({ data: DATA })
    expect(system.name).toBe(ROUTINE_SYSTEM_NAME)
    expect(system.period).toBe(ROUTINE_SYSTEM_PERIOD)
    expect(ROUTINE_SYSTEM_PERIOD).toBe(TICKS_PER_HOUR)
    expect(createActivitySystem({ data: DATA }).period).toBe(ACTIVITY_SYSTEM_PERIOD)
    expect(ACTIVITY_SYSTEM_PERIOD).toBe(TICKS_PER_MINUTE)
  })

  it('assigns the current hour block and updates on the next hour only', () => {
    const events = new RecordingSink()
    const world = createInmateWorld({ size: 24, data: DATA, continuousIntake: false })
    world.grid.fill('temperature', 18)
    const inmate = spawnInmate(world, 4, 4)

    // Default medium hour 1 is sleep (defaults[1] === 'sleep').
    expect(world.routines.blockAt('medium', 1)).toBe('sleep')

    const routine = createRoutineSystem({ data: DATA, index: INDEX })
    routine.update(contextAt(world, events, TICKS_PER_HOUR))

    const runtime = world.routineRuntime.stateOf(inmate.id)
    expect(runtime.blockId).toBe('sleep')
    expect(runtime.preferredNeed).toBe('sleep')
    expect(runtime.lockedUp).toBe(true)
    expect(events.of(ROUTINE_EVENTS.hourAssigned)).toHaveLength(1)

    // Mid-hour edit: paint every hour as meal. Current assignment must hold.
    const allMeal = Array.from({ length: 24 }, () => 'meal' as const)
    setCategoryRoutine(world.routines, 'medium', allMeal)
    expect(world.routines.blockAt('medium', 1)).toBe('meal')
    expect(runtime.blockId).toBe('sleep')

    // Next hour boundary picks up the edit.
    events.clear()
    routine.update(contextAt(world, events, 2 * TICKS_PER_HOUR))
    expect(runtime.blockId).toBe('meal')
    expect(runtime.preferredNeed).toBe('food')
    expect(runtime.goalSetId).toBe('serving_counter')
    expect(runtime.lockedUp).toBe(false)
    expect(events.of(ROUTINE_EVENTS.hourAssigned)).toHaveLength(1)
  })

  it('applies SetRoutine on the next hour boundary through the simulation', () => {
    const events = new RecordingSink()
    const world = createInmateWorld({ size: 24, data: DATA, continuousIntake: false })
    world.grid.fill('temperature', 18)
    const inmate = spawnInmate(world, 3, 3)

    const sim = new Simulation({
      seed: SEED,
      world,
      systems: [
        createRoutineSystem({ data: DATA, index: INDEX }),
        createActivitySystem({ data: DATA, index: INDEX }),
      ],
      commandHandlers: routineCommandHandlers(DATA),
      events,
    })

    // Advance to the first hour boundary (tick 600 → hour 1).
    for (let i = 0; i < TICKS_PER_HOUR; i += 1) sim.step()
    expect(sim.clock.hour).toBe(1)
    expect(world.routineRuntime.stateOf(inmate.id).blockId).toBe(
      world.routines.blockAt('medium', 1),
    )

    const allYard = Array.from({ length: 24 }, () => 'yard')
    sim.enqueue({
      type: ROUTINE_COMMANDS.setCategory,
      issuedAtTick: sim.clock.tick,
      payload: { category: 'medium', blocks: allYard },
    })

    // Still inside hour 1 — assignment unchanged after a few minutes.
    for (let i = 0; i < 5 * TICKS_PER_MINUTE; i += 1) sim.step()
    expect(world.routineRuntime.stateOf(inmate.id).blockId).not.toBe('yard')

    // Reach hour 2.
    while (sim.clock.hour < 2) sim.step()
    expect(world.routineRuntime.stateOf(inmate.id).blockId).toBe('yard')
    expect(world.routineRuntime.stateOf(inmate.id).goalSetId).toBe('yard')
  })

  it('skips condemned inmates that do not follow the Routine', () => {
    const events = new RecordingSink()
    const world = createInmateWorld({ size: 16, data: DATA, continuousIntake: false })
    const inmate = spawnInmate(world, 2, 2, 'condemned')

    createRoutineSystem({ data: DATA, index: INDEX }).update(
      contextAt(world, events, TICKS_PER_HOUR),
    )

    const runtime = world.routineRuntime.stateOf(inmate.id)
    expect(runtime.blockId).toBeNull()
    expect(runtime.permittedRooms).toEqual([])
    expect(events.of(ROUTINE_EVENTS.hourAssigned)).toHaveLength(0)
  })
})

describe('activity claims', () => {
  it('claims a serving counter during a meal block when standing in the mess hall', () => {
    const events = new RecordingSink()
    const world = createInmateWorld({ size: 32, data: DATA, continuousIntake: false })
    world.grid.fill('temperature', 18)

    const hall = { x: 2, y: 2, width: 8, height: 7 }
    putRoomShell(world, hall)
    const interior = interiorOf(hall)
    designateRoom({ world, data: DATA, events, tick: 0 }, interior, 'mess_hall')

    placeObject(
      { world, data: DATA, events, tick: 0 },
      { x: interior.x, y: interior.y },
      'serving_counter',
      0,
    )
    placeObject(
      { world, data: DATA, events, tick: 0 },
      { x: interior.x + 2, y: interior.y },
      'table',
      0,
    )
    placeObject(
      { world, data: DATA, events, tick: 0 },
      { x: interior.x + 2, y: interior.y + 1 },
      'bench',
      0,
    )

    const inmate = spawnInmate(world, interior.x + 1, interior.y + 1)
    INDEX.set(inmate.inmate.needs, 'food', 60)

    const runtime = world.routineRuntime.stateOf(inmate.id)
    runtime.blockId = 'meal'
    runtime.permittedRooms = permittedRoomsForBlock(DATA, 'meal')
    runtime.preferredNeed = 'food'

    createActivitySystem({ data: DATA, index: INDEX }).update(
      contextAt(world, events, TICKS_PER_MINUTE),
    )

    expect(world.needsRuntime.stateOf(inmate.id).usingObjectId).not.toBe(NO_OBJECT)
    expect(events.of(ACTIVITY_EVENTS.beganUsing)[0]?.data).toMatchObject({
      inmateId: inmate.id,
      needId: 'food',
    })
    expect(ACTIVITY_SYSTEM_NAME).toBe('activity')
  })
})
