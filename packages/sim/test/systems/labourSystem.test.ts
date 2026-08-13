/**
 * T5.7 — prison labour: production throughput, programme prerequisites,
 * commissary economics, and the grove growth cycle.
 */

import { describe, expect, it } from 'vitest'

import { TICKS_PER_HOUR, TICKS_PER_MINUTE } from '../../src/core/clock'
import type { JsonObject } from '../../src/core/commands'
import { Rng } from '../../src/core/rng'
import { Simulation } from '../../src/core/simulation'
import type { SimulationEvent } from '../../src/core/simulation'
import { loadGameData } from '../../src/data/loader'
import type { GameData } from '../../src/data/loader'
import { computeMisconductProbability } from '../../src/entities/misconduct'
import { createInmateShell, generateInmate } from '../../src/entities/inmate'
import { NeedIndex } from '../../src/entities/needs'
import { placeObject } from '../../src/entities/objects'
import {
  LABOUR_COMMANDS,
  LABOUR_EVENTS,
  LABOUR_ROOMS,
  activeProductionLine,
  advanceGrove,
  advanceWorkshop,
  applyWorkEffects,
  assignLabour,
  checkAssignment,
  createLabourSystem,
  dispatchGoods,
  labourCommandHandlers,
  restockCommissary,
  runCommissary,
  unassignLabour,
} from '../../src/systems/labourSystem'
import { createInmateWorld } from '../../src/systems/intakeSystem'
import type { InmateWorld } from '../../src/systems/intakeSystem'
import { refreshPassability } from '../../src/world/construction'
import { initialLockState } from '../../src/world/doors'
import { designateRoom, refreshRoomStatus } from '../../src/world/roomDetection'
import type { Room } from '../../src/world/rooms'

const DATA: GameData = loadGameData()
const NEED_INDEX = NeedIndex.fromData(DATA)
const LABOUR = DATA.balance.labour
const SEED = 0xb10c_5007

class RecordingSink {
  readonly events: SimulationEvent[] = []
  emit(event: SimulationEvent): void {
    this.events.push(event)
  }
  of(kind: string): SimulationEvent[] {
    return this.events.filter((event) => event.kind === kind)
  }
  reasons(): string[] {
    return this.of(LABOUR_EVENTS.rejected).map((event) =>
      String((event.data as JsonObject)['reason']),
    )
  }
}

function put(world: InmateWorld, x: number, y: number, kind: 'floor' | 'wall' | 'door'): void {
  const index = world.grid.idx(x, y)
  world.grid.setAt('floorMaterial', index, world.materials.indexOf('concrete_floor'))
  world.grid.setAt('outdoors', index, 0)
  world.grid.setAt('owned', index, 1)
  if (kind === 'wall') {
    world.grid.setAt('wallMaterial', index, world.materials.indexOf('brick_wall'))
  }
  if (kind === 'door') {
    world.doors.place(index, 'standard', initialLockState(DATA.doors.get('standard')))
  }
  refreshPassability(world, DATA, index)
  world.structureChanged(index)
}

/** Indoor walled room. `rect` is the interior. */
function makeIndoorRoom(
  world: InmateWorld,
  events: RecordingSink,
  defId: string,
  rect: { x: number; y: number; width: number; height: number },
): Room {
  const left = rect.x - 1
  const top = rect.y - 1
  const right = rect.x + rect.width
  const bottom = rect.y + rect.height
  for (let y = top; y <= bottom; y += 1) {
    for (let x = left; x <= right; x += 1) {
      const onEdge = x === left || y === top || x === right || y === bottom
      if (!onEdge) put(world, x, y, 'floor')
      else if (x === rect.x && y === top) put(world, x, y, 'door')
      else put(world, x, y, 'wall')
    }
  }
  designateRoom({ world, data: DATA, events, tick: 0 }, rect, defId)
  const room = [...world.rooms.all()].find(
    (entry) => entry.defId === defId && entry.bounds.x === rect.x && entry.bounds.y === rect.y,
  )
  if (room === undefined) throw new Error(`room ${defId} was not detected`)
  return room
}

/** Outdoor designation with no foundation (grove / yard style). */
function makeOutdoorRoom(
  world: InmateWorld,
  events: RecordingSink,
  defId: string,
  rect: { x: number; y: number; width: number; height: number },
): Room {
  for (let y = rect.y; y < rect.y + rect.height; y += 1) {
    for (let x = rect.x; x < rect.x + rect.width; x += 1) {
      const index = world.grid.idx(x, y)
      world.grid.setAt('outdoors', index, 1)
      world.grid.setAt('owned', index, 1)
      world.grid.setAt('floorMaterial', index, 0)
      world.grid.setAt('wallMaterial', index, 0)
      refreshPassability(world, DATA, index)
      world.structureChanged(index)
    }
  }
  designateRoom({ world, data: DATA, events, tick: 0 }, rect, defId)
  const room = [...world.rooms.all()].find(
    (entry) => entry.defId === defId && entry.bounds.x === rect.x && entry.bounds.y === rect.y,
  )
  if (room === undefined) throw new Error(`outdoor room ${defId} was not detected`)
  return room
}

function addInmate(
  world: InmateWorld,
  patch: Partial<{ tx: number; ty: number; money: number }> = {},
): number {
  const rng = new Rng(SEED).stream('inmate')
  const component = generateInmate({ data: DATA, rng, category: 'medium' })
  if (patch.money !== undefined) component.money = patch.money
  const id = world.inmates.allocateId()
  world.inmates.add(
    createInmateShell({
      id,
      data: DATA,
      inmate: component,
      tx: patch.tx ?? 2,
      ty: patch.ty ?? 2,
    }),
  )
  return id
}

function completeProgramme(world: InmateWorld, inmateId: number, programId: string): void {
  world.programs.recordCompletion(inmateId, programId)
  const def = DATA.programs.get(programId)
  if (def === undefined) return
  for (const effect of def.effects) {
    if (effect.type === 'unlockLabour') {
      const set = world.programs.unlockedLabour.get(inmateId) ?? new Set<string>()
      set.add(effect.assignment)
      world.programs.unlockedLabour.set(inmateId, set)
    }
    if (effect.type === 'unlockProduction') {
      const set = world.programs.unlockedProduction.get(inmateId) ?? new Set<string>()
      set.add(effect.productionId)
      world.programs.unlockedProduction.set(inmateId, set)
    }
  }
}

function forceWorkBlock(world: InmateWorld, inmateId: number): void {
  world.routineRuntime.stateOf(inmateId).blockId = 'work_free'
}

function objectDeps(world: InmateWorld, events: RecordingSink) {
  return { world, data: DATA, events, tick: 0 }
}

/** Functional workshop with enough workbenches for `slots` workers. */
function buildWorkshop(world: InmateWorld, events: RecordingSink, slots: number): Room {
  // Workbenches are 2×1; leave a row for the saw / press and a packing lane.
  const width = Math.max(10, slots * 2 + 2)
  const height = 8
  const room = makeIndoorRoom(world, events, 'workshop', { x: 2, y: 2, width, height })
  const deps = objectDeps(world, events)

  expect(placeObject(deps, { x: 3, y: 3 }, 'bench_saw')).toBeDefined()
  expect(placeObject(deps, { x: 6, y: 3 }, 'sheet_press')).toBeDefined()

  for (let i = 0; i < slots; i += 1) {
    const x = 3 + (i % Math.floor(width / 2)) * 2
    const y = 5 + Math.floor(i / Math.floor(width / 2))
    expect(placeObject(deps, { x, y }, 'workbench'), `workbench ${i}`).toBeDefined()
  }

  refreshRoomStatus(deps, room.id)
  expect(world.rooms.statusOf(room.id)?.functional).toBe(true)
  return room
}

function buildCommissary(world: InmateWorld, events: RecordingSink): Room {
  const room = makeIndoorRoom(world, events, 'commissary', { x: 2, y: 2, width: 6, height: 5 })
  const deps = objectDeps(world, events)
  expect(placeObject(deps, { x: 3, y: 3 }, 'shop_counter')).toBeDefined()
  expect(placeObject(deps, { x: 5, y: 3 }, 'shop_shelf')).toBeDefined()
  expect(placeObject(deps, { x: 3, y: 5 }, 'table')).toBeDefined()
  refreshRoomStatus(deps, room.id)
  expect(world.rooms.statusOf(room.id)?.functional).toBe(true)
  return room
}

function buildGroveAt(
  world: InmateWorld,
  events: RecordingSink,
  beds: number,
  rect: { x: number; y: number; width: number; height: number },
): Room {
  const room = makeOutdoorRoom(world, events, 'grove', rect)
  const deps = objectDeps(world, events)
  for (let i = 0; i < beds; i += 1) {
    const x = rect.x + 1 + (i % 3) * 2
    const y = rect.y + 1 + Math.floor(i / 3) * 2
    expect(placeObject(deps, { x, y }, 'sapling_bed'), `sapling ${i}`).toBeDefined()
  }
  refreshRoomStatus(deps, room.id)
  expect(world.rooms.statusOf(room.id)?.functional).toBe(true)
  return room
}

function buildGrove(world: InmateWorld, events: RecordingSink, beds: number): Room {
  return buildGroveAt(world, events, beds, { x: 2, y: 2, width: 8, height: 6 })
}

/* -------------------------------------------------------------------------- */
/* Production throughput                                                       */
/* -------------------------------------------------------------------------- */

describe('labour — production throughput', () => {
  it('a workshop with 10 assigned inmates produces a positive export income', () => {
    const events = new RecordingSink()
    const world = createInmateWorld({
      size: 48,
      data: DATA,
      continuousIntake: false,
      research: 'all',
    })
    const room = buildWorkshop(world, events, 10)
    world.supply.storeStock.set('timber', 500)

    const workers: number[] = []
    for (let i = 0; i < 10; i += 1) {
      const id = addInmate(world, { tx: 4 + (i % 5), ty: 5 + Math.floor(i / 5) })
      completeProgramme(world, id, 'workshop_induction')
      expect(assignLabour(world, DATA, events, 0, id, 'workshop')).toBe(true)
      forceWorkBlock(world, id)
      workers.push(id)
    }
    expect(workers).toHaveLength(10)

    const minutes = LABOUR.workshop.basic.workerMinutesPerUnit
    const produced = advanceWorkshop(world, DATA, events, minutes, minutes)
    expect(produced).toBeGreaterThan(0)
    expect(world.labour.finishedGoods.get(LABOUR.workshop.basic.productId) ?? 0).toBe(produced)

    const before = world.economy.balance
    const income = dispatchGoods(world, DATA, events, minutes)
    expect(income).toBe(produced * LABOUR.workshop.basic.salePrice)
    expect(income).toBeGreaterThan(0)
    expect(world.economy.balance).toBe(before + income)
    expect(world.labour.lifetimeExportIncome).toBe(income)
    expect(events.of(LABOUR_EVENTS.produced).length).toBeGreaterThan(0)
    expect(events.of(LABOUR_EVENTS.dispatched).length).toBe(1)

    // Room occupancy sanity: workers were counted against this workshop.
    expect(room.defId).toBe(LABOUR_ROOMS.workshop)
  })

  it('Joinery unlocks the high-value line for the room', () => {
    const events = new RecordingSink()
    const world = createInmateWorld({
      size: 32,
      data: DATA,
      continuousIntake: false,
      research: 'all',
    })
    const room = buildWorkshop(world, events, 2)
    world.supply.storeStock.set('timber', 100)

    const basicId = addInmate(world, { tx: 4, ty: 5 })
    completeProgramme(world, basicId, 'workshop_induction')
    assignLabour(world, DATA, events, 0, basicId, 'workshop')
    forceWorkBlock(world, basicId)

    const basicEntity = world.inmates.get(basicId)
    if (basicEntity === undefined) throw new Error('basic worker missing')
    expect(activeProductionLine(world, DATA, [basicEntity]).productId).toBe(
      LABOUR.workshop.basic.productId,
    )

    const fineId = addInmate(world, { tx: 5, ty: 5 })
    completeProgramme(world, fineId, 'workshop_induction')
    completeProgramme(world, fineId, 'joinery_apprenticeship')
    assignLabour(world, DATA, events, 0, fineId, 'workshop')
    forceWorkBlock(world, fineId)

    const fineEntity = world.inmates.get(fineId)
    if (fineEntity === undefined) throw new Error('fine worker missing')
    expect(activeProductionLine(world, DATA, [basicEntity, fineEntity]).productId).toBe(
      LABOUR.workshop.fine.productId,
    )

    const minutes = LABOUR.workshop.fine.workerMinutesPerUnit
    const produced = advanceWorkshop(world, DATA, events, minutes, minutes)
    expect(produced).toBeGreaterThan(0)
    expect(world.labour.finishedGoods.get(LABOUR.workshop.fine.productId) ?? 0).toBe(produced)
    expect(world.labour.finishedGoods.get(LABOUR.workshop.basic.productId) ?? 0).toBe(0)
    expect(room.id).toBeGreaterThan(0)
  })

  it('stops the line when timber runs out', () => {
    const events = new RecordingSink()
    const world = createInmateWorld({
      size: 32,
      data: DATA,
      continuousIntake: false,
      research: 'all',
    })
    buildWorkshop(world, events, 2)
    world.supply.storeStock.set('timber', LABOUR.workshop.basic.inputUnits)

    const id = addInmate(world, { tx: 4, ty: 5 })
    completeProgramme(world, id, 'workshop_induction')
    assignLabour(world, DATA, events, 0, id, 'workshop')
    forceWorkBlock(world, id)

    const first = advanceWorkshop(
      world,
      DATA,
      events,
      LABOUR.workshop.basic.workerMinutesPerUnit,
      LABOUR.workshop.basic.workerMinutesPerUnit,
    )
    expect(first).toBe(1)
    expect(world.supply.storeStock.get('timber') ?? 0).toBe(0)

    const second = advanceWorkshop(
      world,
      DATA,
      events,
      LABOUR.workshop.basic.workerMinutesPerUnit * 2,
      LABOUR.workshop.basic.workerMinutesPerUnit * 2,
    )
    expect(second).toBe(0)
  })
})

/* -------------------------------------------------------------------------- */
/* Prerequisite enforcement                                                    */
/* -------------------------------------------------------------------------- */

describe('labour — prerequisite enforcement', () => {
  it('rejects workshop without Workshop Induction and accepts after completion', () => {
    const events = new RecordingSink()
    const world = createInmateWorld({
      size: 32,
      data: DATA,
      continuousIntake: false,
      research: 'all',
    })
    buildWorkshop(world, events, 1)
    const id = addInmate(world, { tx: 4, ty: 5 })

    expect(checkAssignment(world, DATA, id, 'workshop').reason).toBe('missing-programme')
    expect(assignLabour(world, DATA, events, 0, id, 'workshop')).toBe(false)
    expect(events.reasons()).toContain('missing-programme')

    completeProgramme(world, id, 'workshop_induction')
    expect(checkAssignment(world, DATA, id, 'workshop').ok).toBe(true)
    expect(assignLabour(world, DATA, events, 1, id, 'workshop')).toBe(true)
    expect(world.labour.assignments.get(id)).toBe('workshop')
    expect(world.inmates.get(id)?.inmate.jobId).toBe('workshop')
  })

  it('rejects kitchen without Kitchen Induction', () => {
    const events = new RecordingSink()
    const world = createInmateWorld({
      size: 32,
      data: DATA,
      continuousIntake: false,
      research: 'all',
    })
    const room = makeIndoorRoom(world, events, 'kitchen', { x: 2, y: 2, width: 6, height: 5 })
    const deps = objectDeps(world, events)
    placeObject(deps, { x: 3, y: 3 }, 'cooker')
    placeObject(deps, { x: 5, y: 3 }, 'fridge')
    placeObject(deps, { x: 3, y: 5 }, 'kitchen_sink')
    refreshRoomStatus(deps, room.id)

    const id = addInmate(world, { tx: 4, ty: 4 })
    expect(checkAssignment(world, DATA, id, 'kitchen').reason).toBe('missing-programme')

    completeProgramme(world, id, 'kitchen_induction')
    expect(checkAssignment(world, DATA, id, 'kitchen').ok).toBe(true)
  })

  it('gates cleaning and grove on Directorate features beyond Inmate Labour', () => {
    const events = new RecordingSink()
    const locked = createInmateWorld({
      size: 32,
      data: DATA,
      continuousIntake: false,
      research: 'none',
    })
    // Inmate Labour alone is not enough for cleaning / grove.
    locked.directorate.grant('works')
    locked.directorate.grant('inmate_labour')

    const id = addInmate(locked, { tx: 4, ty: 4 })
    expect(checkAssignment(locked, DATA, id, 'cleaning').reason).toBe('feature-locked')
    expect(checkAssignment(locked, DATA, id, 'grove').reason).toBe('feature-locked')

    const open = createInmateWorld({
      size: 32,
      data: DATA,
      continuousIntake: false,
      research: 'all',
    })
    makeIndoorRoom(open, events, 'supply_closet', { x: 2, y: 2, width: 4, height: 4 })
    const closet = [...open.rooms.all()].find((entry) => entry.defId === 'supply_closet')
    if (closet === undefined) throw new Error('supply closet missing')
    const deps = objectDeps(open, events)
    placeObject(deps, { x: 3, y: 3 }, 'storage_rack')
    placeObject(deps, { x: 3, y: 4 }, 'workbench')
    refreshRoomStatus(deps, closet.id)

    const cleaner = addInmate(open, { tx: 3, ty: 3 })
    expect(checkAssignment(open, DATA, cleaner, 'cleaning').ok).toBe(true)

    buildGroveAt(open, events, 1, { x: 12, y: 2, width: 8, height: 6 })
    const fell = addInmate(open, { tx: 14, ty: 4 })
    expect(checkAssignment(open, DATA, fell, 'grove').ok).toBe(true)
  })

  it('rejects assignment when no free job slot remains', () => {
    const events = new RecordingSink()
    const world = createInmateWorld({
      size: 32,
      data: DATA,
      continuousIntake: false,
      research: 'all',
    })
    buildWorkshop(world, events, 1)

    const first = addInmate(world, { tx: 4, ty: 5 })
    const second = addInmate(world, { tx: 5, ty: 5 })
    completeProgramme(world, first, 'workshop_induction')
    completeProgramme(world, second, 'workshop_induction')

    expect(assignLabour(world, DATA, events, 0, first, 'workshop')).toBe(true)
    expect(checkAssignment(world, DATA, second, 'workshop').reason).toBe('no-free-slot')
  })

  it('unassign clears the job and labour.assign / labour.unassign commands work', () => {
    const events = new RecordingSink()
    const world = createInmateWorld({
      size: 32,
      data: DATA,
      continuousIntake: false,
      research: 'all',
    })
    buildWorkshop(world, events, 1)
    const id = addInmate(world, { tx: 4, ty: 5 })
    completeProgramme(world, id, 'workshop_induction')

    const sim = new Simulation({
      seed: SEED,
      world,
      systems: [createLabourSystem({ data: DATA })],
      events,
      commandHandlers: labourCommandHandlers(DATA),
    })
    sim.enqueue({
      type: LABOUR_COMMANDS.assign,
      payload: { inmateId: id, assignment: 'workshop' },
      issuedAtTick: 0,
    })
    sim.step()
    expect(world.labour.assignments.get(id)).toBe('workshop')

    sim.enqueue({
      type: LABOUR_COMMANDS.unassign,
      payload: { inmateId: id },
      issuedAtTick: sim.clock.tick,
    })
    sim.step()
    expect(world.labour.assignments.has(id)).toBe(false)
    expect(world.inmates.get(id)?.inmate.jobId).toBeNull()
  })
})

/* -------------------------------------------------------------------------- */
/* Commissary economics                                                        */
/* -------------------------------------------------------------------------- */

describe('labour — commissary economics', () => {
  it('sells stock for revenue and discharges luxury', () => {
    const events = new RecordingSink()
    const world = createInmateWorld({
      size: 24,
      data: DATA,
      continuousIntake: false,
      research: 'all',
    })
    const room = buildCommissary(world, events)
    world.economy.credit(0, 'starting_funds', 10_000, 'test float', 0)
    world.labour.commissaryGoods = 0

    expect(restockCommissary(world, DATA, 0)).toBe(LABOUR.commissary.goodsPerRestock)
    expect(world.labour.commissaryGoods).toBe(LABOUR.commissary.goodsPerRestock)

    const luxuryIdx = NEED_INDEX.indexOf('luxury')
    const id = addInmate(world, {
      tx: room.bounds.x + 1,
      ty: room.bounds.y + 1,
      money: LABOUR.commissary.spendPerVisit * 3,
    })
    const entity = world.inmates.get(id)
    if (entity === undefined) throw new Error('inmate missing')
    entity.inmate.needs[luxuryIdx] = 80

    const rng = new Rng(SEED).stream('labour')
    rng.chance = () => true

    const beforeBalance = world.economy.balance
    const beforeMoney = entity.inmate.money
    const beforeLuxury = entity.inmate.needs[luxuryIdx] ?? 0

    const revenue = runCommissary(world, DATA, events, rng, NEED_INDEX, 0)
    expect(revenue).toBe(LABOUR.commissary.spendPerVisit)
    expect(entity.inmate.money).toBe(beforeMoney - LABOUR.commissary.spendPerVisit)
    expect(entity.inmate.needs[luxuryIdx]).toBe(beforeLuxury - LABOUR.commissary.luxuryRelief)
    expect(world.economy.balance).toBe(beforeBalance + revenue)
    expect(world.labour.lifetimeCommissaryIncome).toBe(revenue)
    expect(world.labour.commissaryGoods).toBe(LABOUR.commissary.goodsPerRestock - 1)
    expect(events.of(LABOUR_EVENTS.commissarySale)).toHaveLength(1)
  })

  it('does not sell when the inmate cannot afford a visit', () => {
    const events = new RecordingSink()
    const world = createInmateWorld({
      size: 24,
      data: DATA,
      continuousIntake: false,
      research: 'all',
    })
    const room = buildCommissary(world, events)
    world.labour.commissaryGoods = 5
    addInmate(world, {
      tx: room.bounds.x + 1,
      ty: room.bounds.y + 1,
      money: LABOUR.commissary.spendPerVisit - 1,
    })

    const rng = new Rng(SEED).stream('labour')
    rng.chance = () => true
    expect(runCommissary(world, DATA, events, rng, NEED_INDEX, 0)).toBe(0)
    expect(events.of(LABOUR_EVENTS.commissarySale)).toHaveLength(0)
  })
})

/* -------------------------------------------------------------------------- */
/* Grove growth cycle                                                          */
/* -------------------------------------------------------------------------- */

describe('labour — grove growth cycle', () => {
  it('grows trees, fells them with assigned labour, and stocks timber', () => {
    const events = new RecordingSink()
    const world = createInmateWorld({
      size: 32,
      data: DATA,
      continuousIntake: false,
      research: 'all',
    })
    const room = buildGrove(world, events, 2)
    const id = addInmate(world, { tx: room.bounds.x + 1, ty: room.bounds.y + 1 })
    expect(assignLabour(world, DATA, events, 0, id, 'grove')).toBe(true)
    forceWorkBlock(world, id)

    // Grow standing timber with nobody assigned, then reassign and fell.
    unassignLabour(world, events, 0, id)
    advanceGrove(
      world,
      DATA,
      events,
      LABOUR.grove.treeGrowthMinutes,
      LABOUR.grove.treeGrowthMinutes,
    )
    expect(world.labour.grownTrees.get(room.id) ?? 0).toBe(2)

    expect(assignLabour(world, DATA, events, 1, id, 'grove')).toBe(true)
    forceWorkBlock(world, id)
    const standing = world.labour.grownTrees.get(room.id) ?? 0
    const fallMinutes = LABOUR.grove.fellWorkerMinutes * standing
    const felled = advanceGrove(world, DATA, events, fallMinutes, fallMinutes)
    expect(felled).toBe(standing)
    expect(world.labour.grownTrees.get(room.id) ?? 0).toBe(0)
    expect(world.supply.storeStock.get('timber') ?? 0).toBe(standing * LABOUR.grove.timberPerTree)
    expect(events.of(LABOUR_EVENTS.treeFelled).length).toBeGreaterThan(0)
  })

  it('grows standing timber with no workers, but does not fell without them', () => {
    const events = new RecordingSink()
    const world = createInmateWorld({
      size: 32,
      data: DATA,
      continuousIntake: false,
      research: 'all',
    })
    const room = buildGrove(world, events, 1)

    advanceGrove(
      world,
      DATA,
      events,
      LABOUR.grove.treeGrowthMinutes,
      LABOUR.grove.treeGrowthMinutes,
    )
    expect(world.labour.grownTrees.get(room.id) ?? 0).toBe(1)
    expect(world.supply.storeStock.get('timber') ?? 0).toBe(0)

    advanceGrove(
      world,
      DATA,
      events,
      LABOUR.grove.fellWorkerMinutes * 4,
      LABOUR.grove.fellWorkerMinutes * 4,
    )
    expect(world.labour.grownTrees.get(room.id) ?? 0).toBe(1)
    expect(world.supply.storeStock.get('timber') ?? 0).toBe(0)
  })
})

/* -------------------------------------------------------------------------- */
/* Work effects (acceptance: lower misconduct when working)                    */
/* -------------------------------------------------------------------------- */

describe('labour — work effects', () => {
  it('working discharges freedom, credits reform hours, and lowers misconduct odds', () => {
    const events = new RecordingSink()
    const world = createInmateWorld({
      size: 32,
      data: DATA,
      continuousIntake: false,
      research: 'all',
    })
    buildWorkshop(world, events, 1)

    const freedomIdx = NEED_INDEX.indexOf('freedom')
    const critical = DATA.needs.get('freedom').thresholds.critical

    const workingId = addInmate(world, { tx: 4, ty: 5 })
    const idleId = addInmate(world, { tx: 10, ty: 10 })
    completeProgramme(world, workingId, 'workshop_induction')
    assignLabour(world, DATA, events, 0, workingId, 'workshop')
    forceWorkBlock(world, workingId)

    const working = world.inmates.get(workingId)
    const idle = world.inmates.get(idleId)
    if (working === undefined || idle === undefined) throw new Error('inmates missing')

    working.inmate.needs[freedomIdx] = critical
    idle.inmate.needs[freedomIdx] = critical
    ;(working.inmate as { traits: readonly string[] }).traits = []
    ;(idle.inmate as { traits: readonly string[] }).traits = []

    const hours = 6
    applyWorkEffects(world, DATA, NEED_INDEX, hours * 60)

    expect(working.inmate.needs[freedomIdx]).toBeLessThan(critical)
    expect(idle.inmate.needs[freedomIdx]).toBe(critical)
    expect(world.grades.recordFor(workingId).labourHours).toBeCloseTo(hours)

    const workingCritical = (working.inmate.needs[freedomIdx] ?? 0) >= critical ? 1 : 0
    const idleCritical = (idle.inmate.needs[freedomIdx] ?? 0) >= critical ? 1 : 0
    expect(workingCritical).toBe(0)
    expect(idleCritical).toBe(1)

    const suppressionMax = DATA.balance.suppression.max
    const workingP = computeMisconductProbability(DATA.balance.misconduct, suppressionMax, {
      category: 'medium',
      criticalNeedCount: workingCritical,
      cellGradeModifier: 1,
      suppression: 0,
      instigatorNearby: 0,
      guardNearby: false,
      hasViolentTrait: false,
      agitatorBoostMultiplier: 1,
    })
    const idleP = computeMisconductProbability(DATA.balance.misconduct, suppressionMax, {
      category: 'medium',
      criticalNeedCount: idleCritical,
      cellGradeModifier: 1,
      suppression: 0,
      instigatorNearby: 0,
      guardNearby: false,
      hasViolentTrait: false,
      agitatorBoostMultiplier: 1,
    })
    expect(workingP).toBeLessThan(idleP)
  })

  it('runs on the logistics minute cadence inside the simulation', () => {
    const events = new RecordingSink()
    const world = createInmateWorld({
      size: 32,
      data: DATA,
      continuousIntake: false,
      research: 'all',
    })
    buildWorkshop(world, events, 1)
    world.supply.storeStock.set('timber', 50)

    const id = addInmate(world, { tx: 4, ty: 5 })
    completeProgramme(world, id, 'workshop_induction')
    assignLabour(world, DATA, events, 0, id, 'workshop')
    forceWorkBlock(world, id)

    const sim = new Simulation({
      seed: SEED,
      world,
      systems: [createLabourSystem({ data: DATA })],
      events,
    })
    for (let i = 0; i < LABOUR.workshop.basic.workerMinutesPerUnit * TICKS_PER_MINUTE; i += 1) {
      sim.step()
    }
    expect(world.labour.finishedGoods.get(LABOUR.workshop.basic.productId) ?? 0).toBeGreaterThan(0)

    const truckTicks = DATA.balance.logistics.truckIntervalHours * TICKS_PER_HOUR
    while (sim.clock.tick % truckTicks !== 0) sim.step()
    sim.step()
    expect(world.labour.lifetimeExportIncome).toBeGreaterThan(0)
  })
})
