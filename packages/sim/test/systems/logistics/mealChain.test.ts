/**
 * T3.3 — meal chain: capacity formula, prep timing, routing, failure CausalEvents.
 */

import { describe, expect, it } from 'vitest'

import {
  TICKS_PER_DAY,
  TICKS_PER_HOUR,
  TICKS_PER_MINUTE,
} from '../../../src/core/clock'
import { Simulation } from '../../../src/core/simulation'
import type { SimulationEvent } from '../../../src/core/simulation'
import { loadGameData } from '../../../src/data/loader'
import type { GameData } from '../../../src/data/loader'
import { createInmateShell, generateInmate } from '../../../src/entities/inmate'
import { hireStaff } from '../../../src/entities/staff'
import { placeObject } from '../../../src/entities/objects'
import { Rng } from '../../../src/core/rng'
import { createInmateWorld } from '../../../src/systems/intakeSystem'
import type { InmateWorld } from '../../../src/systems/intakeSystem'
import {
  MEAL_EVENTS,
  collectMealHours,
  createMealChainSystem,
  mealsPerHour,
  neededCookersFor,
  nextMealPrepWindow,
  requiredMealCount,
  selectMessForKitchen,
  updateMealChain,
} from '../../../src/systems/logistics/mealChain'
import { CausalEventLog, TRACE_KINDS } from '../../../src/trace/causalEvent'
import { refreshPassability } from '../../../src/world/construction'
import type { Rect } from '../../../src/world/construction'
import { initialLockState } from '../../../src/world/doors'
import { designateRoom } from '../../../src/world/roomDetection'
import { setCategoryRoutine } from '../../../src/world/routine'

const RAW_DATA = loadGameData()
const DATA: GameData = {
  ...RAW_DATA,
  balance: {
    ...RAW_DATA.balance,
    utilities: { ...RAW_DATA.balance.utilities, utilitiesEnabled: false },
  },
}
const KITCHEN = DATA.balance.kitchen
const SEED = 0xb10c_3003

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

function objectDeps(world: InmateWorld, events: RecordingSink | CausalEventLog, tick = 0) {
  return { world, data: DATA, events, tick }
}

function roomDeps(world: InmateWorld, events: RecordingSink | CausalEventLog, tick = 0) {
  return { world, data: DATA, events, tick }
}

function stockAllFridges(world: InmateWorld, unitsPerType: number): void {
  for (const entity of world.objects.all()) {
    if (entity.object.defId !== 'fridge') continue
    for (const type of KITCHEN.ingredientTypes) {
      world.meals.stockFridge(entity.id, type, unitsPerType)
    }
  }
}

function spawnInmates(world: InmateWorld, count: number, tx: number, ty: number): void {
  const rng = new Rng(SEED)
  for (let i = 0; i < count; i += 1) {
    const component = generateInmate({ data: DATA, rng: rng.stream('meal'), category: 'medium' })
    const shell = createInmateShell({
      id: world.inmates.allocateId(),
      data: DATA,
      inmate: component,
      tx,
      ty,
    })
    world.inmates.add(shell)
  }
}

interface Facility {
  readonly world: InmateWorld
  readonly events: RecordingSink
  readonly kitchenId: number
  readonly messId: number
  readonly cookerCount: number
}

function buildFacility(options: {
  readonly cookers: number
  readonly mapSize?: number
  readonly hireCooks?: number
  readonly kitchenLabour?: number
}): Facility {
  const events = new RecordingSink()
  const world = createInmateWorld({
    size: options.mapSize ?? 48,
    data: DATA,
    continuousIntake: false,
  })

  // Kitchen on the left, mess hall on the right — kitchen is wide enough for
  // acceptance-test cooker counts on two rows.
  const kitchenShell = { x: 2, y: 2, width: 16, height: 12 }
  const messShell = { x: 20, y: 2, width: 14, height: 12 }
  putRoomShell(world, kitchenShell)
  putRoomShell(world, messShell)
  const kitchenInterior = interiorOf(kitchenShell)
  const messInterior = interiorOf(messShell)
  designateRoom(roomDeps(world, events), kitchenInterior, 'kitchen')
  designateRoom(roomDeps(world, events), messInterior, 'mess_hall')

  const kitchenRoom = [...world.rooms.all()].find((room) => room.defId === 'kitchen')
  const messRoom = [...world.rooms.all()].find((room) => room.defId === 'mess_hall')
  if (kitchenRoom === undefined || messRoom === undefined) {
    throw new Error('expected kitchen and mess hall')
  }
  world.meals.roomNames.set(kitchenRoom.id, 'K2')
  world.meals.roomNames.set(messRoom.id, 'West Hall')

  // Place cookers across two rows; fridge + sink; serving counters in the mess.
  let placedCookers = 0
  for (let row = 0; row < 2 && placedCookers < options.cookers; row += 1) {
    let cookerX = kitchenInterior.x
    const cookerY = kitchenInterior.y + 1 + row * 2
    while (placedCookers < options.cookers && cookerX + 1 < kitchenInterior.x + kitchenInterior.width) {
      const placed = placeObject(
        objectDeps(world, events),
        { x: cookerX, y: cookerY },
        'cooker',
        0,
      )
      if (placed === undefined) throw new Error(`cooker ${String(placedCookers)} failed`)
      cookerX += 2
      placedCookers += 1
    }
  }
  if (placedCookers < options.cookers) {
    throw new Error(`only placed ${String(placedCookers)} of ${String(options.cookers)} cookers`)
  }
  const fridge = placeObject(
    objectDeps(world, events),
    { x: kitchenInterior.x, y: kitchenInterior.y + 6 },
    'fridge',
    0,
  )
  if (fridge === undefined) throw new Error('fridge failed')
  const sink = placeObject(
    objectDeps(world, events),
    { x: kitchenInterior.x + 2, y: kitchenInterior.y + 6 },
    'kitchen_sink',
    0,
  )
  if (sink === undefined) throw new Error('sink failed')

  const counter = placeObject(
    objectDeps(world, events),
    { x: messInterior.x, y: messInterior.y + 1 },
    'serving_counter',
    0,
  )
  if (counter === undefined) throw new Error('serving_counter failed')
  // Enough counters to stage a 200-inmate meal without hitting mess.full.
  placeObject(
    objectDeps(world, events),
    { x: messInterior.x, y: messInterior.y + 3 },
    'serving_counter',
    0,
  )
  placeObject(
    objectDeps(world, events),
    { x: messInterior.x, y: messInterior.y + 5 },
    'serving_counter',
    0,
  )

  const cooks = options.hireCooks ?? 0
  for (let i = 0; i < cooks; i += 1) {
    const result = hireStaff({
      world,
      defId: 'cook',
      events,
      tick: 0,
      tx: kitchenInterior.x + 4,
      ty: kitchenInterior.y + 4,
    })
    if (result.entity === undefined) throw new Error('hire cook failed')
  }

  const labour = options.kitchenLabour ?? 0
  for (let i = 0; i < labour; i += 1) {
    const component = generateInmate({
      data: DATA,
      rng: new Rng(SEED + i).stream('labour'),
      category: 'medium',
    })
    component.jobId = 'kitchen'
    const shell = createInmateShell({
      id: world.inmates.allocateId(),
      data: DATA,
      inmate: component,
      tx: kitchenInterior.x + 5,
      ty: kitchenInterior.y + 5,
    })
    world.inmates.add(shell)
  }

  return {
    world,
    events,
    kitchenId: kitchenRoom.id,
    messId: messRoom.id,
    cookerCount: options.cookers,
  }
}

/** Advance logistics one in-game minute at a time. */
function stepMinutes(
  world: InmateWorld,
  events: RecordingSink | CausalEventLog,
  fromTick: number,
  minutes: number,
): number {
  let tick = fromTick
  for (let i = 0; i < minutes; i += 1) {
    tick += TICKS_PER_MINUTE
    updateMealChain(world, DATA, events, tick)
  }
  return tick
}

describe('mealsPerHour formula', () => {
  it('matches PRD 5.13: cookers * 12 * (1 + 0.25 * cooksAssigned)', () => {
    expect(mealsPerHour(2, 1, KITCHEN)).toBe(2 * 12 * (1 + 0.25 * 1))
    expect(mealsPerHour(4, 0, KITCHEN)).toBe(4 * 12)
    expect(mealsPerHour(0, 5, KITCHEN)).toBe(0)
  })

  it('scales required meals by standing-order quantity', () => {
    expect(requiredMealCount(200, 'normal', KITCHEN)).toBe(200)
    expect(requiredMealCount(200, 'low', KITCHEN)).toBe(Math.ceil(200 * KITCHEN.quantityMultipliers.low))
    expect(requiredMealCount(200, 'high', KITCHEN)).toBe(Math.ceil(200 * KITCHEN.quantityMultipliers.high))
  })
})

describe('preparation timing', () => {
  it('opens prep preparationLeadHours before a meal block', () => {
    const mealHours = [12]
    const mealTick = 12 * TICKS_PER_HOUR
    const window = nextMealPrepWindow(mealHours, 0, KITCHEN.preparationLeadHours)
    expect(window).not.toBeNull()
    if (window === null) throw new Error('expected window')
    expect(window.mealHour).toBe(12)
    expect(window.mealStartTick).toBe(mealTick)
    expect(window.prepStartTick).toBe(mealTick - KITCHEN.preparationLeadHours * TICKS_PER_HOUR)
  })

  it('collapses consecutive meal hours into one production window', () => {
    const mealHours = [11, 12, 13, 17]
    const window = nextMealPrepWindow(mealHours, 0, KITCHEN.preparationLeadHours)
    expect(window).not.toBeNull()
    if (window === null) throw new Error('expected window')
    expect(window.mealHour).toBe(11)
    expect(window.runHours).toBe(3)
  })

  it('collects meal hours from every category routine', () => {
    const world = createInmateWorld({ size: 16, data: DATA, continuousIntake: false })
    const hours = collectMealHours(world.routines.byCategory)
    expect(hours).toContain(8)
    expect(hours).toContain(12)
    expect(hours).toContain(17)
  })
})

describe('routing selection', () => {
  it('picks the nearest mess hall by default', () => {
    const events = new RecordingSink()
    const world = createInmateWorld({ size: 48, data: DATA, continuousIntake: false })
    const nearShell = { x: 2, y: 2, width: 8, height: 8 }
    const farShell = { x: 30, y: 2, width: 8, height: 8 }
    const kitchenShell = { x: 12, y: 2, width: 8, height: 8 }
    putRoomShell(world, nearShell)
    putRoomShell(world, farShell)
    putRoomShell(world, kitchenShell)
    designateRoom(roomDeps(world, events), interiorOf(nearShell), 'mess_hall')
    designateRoom(roomDeps(world, events), interiorOf(farShell), 'mess_hall')
    designateRoom(roomDeps(world, events), interiorOf(kitchenShell), 'kitchen')

    const kitchen = [...world.rooms.all()].find((room) => room.defId === 'kitchen')
    const messes = [...world.rooms.all()].filter((room) => room.defId === 'mess_hall')
    if (kitchen === undefined) throw new Error('kitchen missing')
    const chosen = selectMessForKitchen(kitchen, messes, world.grid.size, {
      routingUnlocked: false,
      overrideMessId: null,
    })
    expect(chosen).not.toBeNull()
    const near = messes.find((mess) => mess.bounds.x < 10)
    expect(chosen?.id).toBe(near?.id)
  })

  it('honours an override only when kitchen_routing is unlocked', () => {
    const events = new RecordingSink()
    const world = createInmateWorld({ size: 48, data: DATA, continuousIntake: false })
    const nearShell = { x: 2, y: 2, width: 8, height: 8 }
    const farShell = { x: 30, y: 2, width: 8, height: 8 }
    const kitchenShell = { x: 12, y: 2, width: 8, height: 8 }
    putRoomShell(world, nearShell)
    putRoomShell(world, farShell)
    putRoomShell(world, kitchenShell)
    designateRoom(roomDeps(world, events), interiorOf(nearShell), 'mess_hall')
    designateRoom(roomDeps(world, events), interiorOf(farShell), 'mess_hall')
    designateRoom(roomDeps(world, events), interiorOf(kitchenShell), 'kitchen')

    const kitchen = [...world.rooms.all()].find((room) => room.defId === 'kitchen')
    const messes = [...world.rooms.all()]
      .filter((room) => room.defId === 'mess_hall')
      .sort((a, b) => a.bounds.x - b.bounds.x)
    if (kitchen === undefined || messes.length < 2) throw new Error('rooms missing')
    const far = messes[1]
    if (far === undefined) throw new Error('far mess missing')

    const locked = selectMessForKitchen(kitchen, messes, world.grid.size, {
      routingUnlocked: false,
      overrideMessId: far.id,
    })
    expect(locked?.id).not.toBe(far.id)

    const unlocked = selectMessForKitchen(kitchen, messes, world.grid.size, {
      routingUnlocked: true,
      overrideMessId: far.id,
    })
    expect(unlocked?.id).toBe(far.id)
  })
})

describe('failure CausalEvents', () => {
  it('emits kitchen.noIngredients when fridges are empty', () => {
    const { world, events } = buildFacility({ cookers: 2, hireCooks: 1 })
    spawnInmates(world, 20, 20, 5)
    // No stockFridge call.
    const prepStart = 8 * TICKS_PER_HOUR - KITCHEN.preparationLeadHours * TICKS_PER_HOUR
    stepMinutes(world, events, prepStart - TICKS_PER_MINUTE, 2)
    expect(events.of(TRACE_KINDS.kitchenNoIngredients).length).toBeGreaterThan(0)
  })

  it('emits kitchen.noCookAssigned when nobody can cook', () => {
    const { world, events } = buildFacility({ cookers: 2, hireCooks: 0, kitchenLabour: 0 })
    spawnInmates(world, 20, 20, 5)
    stockAllFridges(world, 500)
    const prepStart = 8 * TICKS_PER_HOUR - KITCHEN.preparationLeadHours * TICKS_PER_HOUR
    stepMinutes(world, events, prepStart - TICKS_PER_MINUTE, 2)
    expect(events.of(TRACE_KINDS.kitchenNoCookAssigned).length).toBeGreaterThan(0)
  })

  it('emits kitchen.underCapacity when cookers cannot meet demand', () => {
    const { world, events } = buildFacility({ cookers: 1, hireCooks: 1 })
    spawnInmates(world, 200, 20, 5)
    stockAllFridges(world, 5_000)
    const prepStart = 8 * TICKS_PER_HOUR - KITCHEN.preparationLeadHours * TICKS_PER_HOUR
    stepMinutes(world, events, prepStart - TICKS_PER_MINUTE, 2)
    expect(events.of(TRACE_KINDS.kitchenUnderCapacity).length).toBeGreaterThan(0)
  })

  it('emits kitchen.noRouteToMess when there is no mess hall', () => {
    const events = new RecordingSink()
    const world = createInmateWorld({ size: 32, data: DATA, continuousIntake: false })
    const kitchenShell = { x: 2, y: 2, width: 10, height: 8 }
    putRoomShell(world, kitchenShell)
    designateRoom(roomDeps(world, events), interiorOf(kitchenShell), 'kitchen')
    const kitchenInterior = interiorOf(kitchenShell)
    placeObject(objectDeps(world, events), { x: kitchenInterior.x, y: kitchenInterior.y + 1 }, 'cooker', 0)
    placeObject(objectDeps(world, events), { x: kitchenInterior.x, y: kitchenInterior.y + 3 }, 'fridge', 0)
    hireStaff({
      world,
      defId: 'cook',
      events,
      tick: 0,
      tx: kitchenInterior.x + 2,
      ty: kitchenInterior.y + 2,
    })
    stockAllFridges(world, 100)
    const prepStart = 8 * TICKS_PER_HOUR - KITCHEN.preparationLeadHours * TICKS_PER_HOUR
    stepMinutes(world, events, prepStart - TICKS_PER_MINUTE, 2)
    expect(events.of(TRACE_KINDS.kitchenNoRouteToMess).length).toBeGreaterThan(0)
  })

  it('emits mess.full when serving counters cannot take more meals', () => {
    const { world, events, messId } = buildFacility({ cookers: 8, hireCooks: 4 })
    // Tiny counter capacity forces a full event.
    // Remove the second counter and shrink capacity via balance... we can't mutate
    // frozen data easily, so stage beyond capacity by lowering mealsPerServingCounter
    // through direct staging after over-producing with a patched local capacity.
    // Instead: fill counters to capacity then force another produce minute.
    spawnInmates(world, 10, 20, 5)
    stockAllFridges(world, 5_000)
    const counters = world.objects
      .inRoom(messId)
      .filter((entity) => entity.object.defId === 'serving_counter')
    for (const counter of counters) {
      world.meals.counterMeals.set(counter.id, KITCHEN.mealsPerServingCounter)
    }
    const prepStart = 8 * TICKS_PER_HOUR - KITCHEN.preparationLeadHours * TICKS_PER_HOUR
    // Run deep into prep so production tries to stage onto full counters.
    stepMinutes(world, events, prepStart - TICKS_PER_MINUTE, 30)
    expect(events.of(TRACE_KINDS.messFull).length).toBeGreaterThan(0)
  })

  it('halving cookers produces the underCapacity → shortfall → emptyMess Trace chain', () => {
    const log = new CausalEventLog()
    const needed = 200
    const cooks = 1
    // 4 cookers × 12 × 1.25 × 4h = 240 ≥ 200; halved to 2 → 120 < 200.
    const fullCookers = 4
    const halfCookers = Math.floor(fullCookers / 2)
    expect(
      mealsPerHour(fullCookers, cooks, KITCHEN) * KITCHEN.preparationLeadHours,
    ).toBeGreaterThanOrEqual(needed)
    expect(
      mealsPerHour(halfCookers, cooks, KITCHEN) * KITCHEN.preparationLeadHours,
    ).toBeLessThan(needed)

    const { world } = buildFacility({ cookers: halfCookers, hireCooks: cooks })
    spawnInmates(world, needed, 24, 5)
    stockAllFridges(world, 10_000)

    // Single meal at 12:00 so the chain is unambiguous.
    for (const category of DATA.securityCategories.all) {
      const blocks = Array.from({ length: 24 }, (_, hour) => (hour === 12 ? 'meal' : 'lockup'))
      setCategoryRoutine(world.routines, category.id, blocks)
    }

    const prepStart = 12 * TICKS_PER_HOUR - KITCHEN.preparationLeadHours * TICKS_PER_HOUR
    let tick = prepStart - TICKS_PER_MINUTE
    tick = stepMinutes(world, log, tick, KITCHEN.preparationLeadHours * 60 + 1)

    const under = [...log.retainedIds()]
      .map((id) => log.get(id))
      .find((event) => event?.kind === TRACE_KINDS.kitchenUnderCapacity)
    const shortfall = [...log.retainedIds()]
      .map((id) => log.get(id))
      .find((event) => event?.kind === TRACE_KINDS.kitchenProducedShortfall)
    const empty = [...log.retainedIds()]
      .map((id) => log.get(id))
      .find((event) => event?.kind === TRACE_KINDS.messEmptyAtMealtime)

    expect(under).toBeDefined()
    expect(shortfall).toBeDefined()
    expect(empty).toBeDefined()
    if (under === undefined || shortfall === undefined || empty === undefined) {
      throw new Error('expected Trace chain events')
    }
    expect(shortfall.causeIds).toContain(under.id)
    expect(empty.causeIds).toContain(shortfall.id)
    void tick
  })
})

describe('acceptance: sized kitchen feeds population', () => {
  it(
    'feeds 200 inmates with zero missed meals over 30 in-game days',
    () => {
      const population = 200
      const cooks = 2
      const mphNeeded = population / KITCHEN.preparationLeadHours
      const cookers = neededCookersFor(population, cooks, KITCHEN)
      expect(mealsPerHour(cookers, cooks, KITCHEN)).toBeGreaterThanOrEqual(mphNeeded)

      const { world, events } = buildFacility({
        cookers,
        hireCooks: cooks,
        mapSize: 64,
      })
      spawnInmates(world, population, 24, 5)
      stockAllFridges(world, 30 * 3 * population * KITCHEN.ingredientsPerMeal + 1_000)

      let tick = 0
      const minutes = 30 * (TICKS_PER_DAY / TICKS_PER_MINUTE)
      tick = stepMinutes(world, events, tick, minutes)

      expect(world.meals.missedMeals).toBe(0)
      expect(world.meals.mealsServed).toBeGreaterThan(0)
      expect(events.of(MEAL_EVENTS.missedMeal)).toHaveLength(0)
      void tick
    },
    60_000,
  )

  it('registers the mealChain system on a Simulation', () => {
    const events = new RecordingSink()
    const world = createInmateWorld({ size: 16, data: DATA, continuousIntake: false })
    const sim = new Simulation({
      seed: SEED,
      world,
      systems: [createMealChainSystem({ data: DATA })],
      events,
    })
    for (let i = 0; i < TICKS_PER_MINUTE; i += 1) sim.step()
    expect(sim.clock.tick).toBe(TICKS_PER_MINUTE)
  })
})
