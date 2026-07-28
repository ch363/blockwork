/**
 * T4.2 — Contraband: acquisition vectors, guard suppression, prices, throw-ins.
 */

import { describe, expect, it } from 'vitest'

import { TICKS_PER_HOUR, TICKS_PER_MINUTE } from '../../src/core/clock'
import { Rng } from '../../src/core/rng'
import type { SimulationEvent } from '../../src/core/simulation'
import { loadGameData } from '../../src/data/loader'
import { placeObject } from '../../src/entities/objects'
import type { ObjectDeps } from '../../src/entities/objects'
import {
  createInmateShell,
  generateInmate,
  NO_INMATE,
} from '../../src/entities/inmate'
import { hireStaff } from '../../src/entities/staff'
import {
  CONTRABAND_EVENTS,
  addToInventory,
  applyArrivalPossession,
  arrangeThrowIn,
  attemptCraft,
  attemptRoomTheft,
  attemptVisitSmuggle,
  computeContrabandPrice,
  contaminateDelivery,
  countInventoryItem,
  flushPendingArrivals,
  itemsSourcedFromRoom,
  measureMarket,
  resolveThrowIn,
  runHourlyMarket,
  theftProbability,
  visitSmuggleChance,
} from '../../src/systems/contrabandSystem'
import { createInmateWorld } from '../../src/systems/intakeSystem'
import type { InmateWorld } from '../../src/systems/intakeSystem'
import { refreshPassability } from '../../src/world/construction'
import type { Rect } from '../../src/world/construction'
import { initialLockState } from '../../src/world/doors'
import { designateRoom } from '../../src/world/roomDetection'
import type { RoomDeps } from '../../src/world/roomDetection'
import { NO_ROOM } from '../../src/world/rooms'

const DATA = loadGameData()
const SEED = 0xc0a7_4002
const CLAMP = DATA.balance.contraband.priceDemandClamp

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

function makeWorld(size = 48): { world: InmateWorld; events: RecordingSink } {
  const events = new RecordingSink()
  const world = createInmateWorld({ size, data: DATA, continuousIntake: false })
  return { world, events }
}

function addInmate(
  world: InmateWorld,
  options: {
    readonly tx: number
    readonly ty: number
    readonly category?: string
    readonly traits?: readonly string[]
    readonly seed?: number
    readonly cellId?: number
  },
): number {
  const id = world.inmates.allocateId()
  if (id === NO_INMATE) throw new Error('inmate id exhausted')
  const component = generateInmate({
    data: DATA,
    rng: new Rng((options.seed ?? SEED) + id).stream('intake'),
    category: options.category ?? 'medium',
  })
  if (options.traits !== undefined) {
    ;(component as unknown as { traits: string[] }).traits = [...options.traits]
  }
  if (options.cellId !== undefined) {
    component.cellId = options.cellId
  }
  world.inmates.add(
    createInmateShell({
      id,
      data: DATA,
      inmate: component,
      tx: options.tx,
      ty: options.ty,
    }),
  )
  return id
}

function inmateOf(world: InmateWorld, id: number) {
  const entity = world.inmates.get(id)
  if (entity === undefined) throw new Error(`no inmate ${String(id)}`)
  return entity
}

function buildDesignatedRoom(
  world: InmateWorld,
  events: RecordingSink,
  rect: Rect,
  defId: string,
): number {
  putRoomShell(world, rect)
  const interior = interiorOf(rect)
  designateRoom(roomDeps(world, events), interior, defId)
  const room = [...world.rooms.all()].find(
    (entry) =>
      entry.defId === defId &&
      entry.tiles.includes(world.grid.idx(interior.x, interior.y)),
  )
  if (room === undefined) throw new Error(`${defId} was not detected`)
  return room.id
}

function placeInmateInRoom(world: InmateWorld, inmateId: number, roomId: number): void {
  const room = world.rooms.get(roomId)
  if (room === undefined || room.tiles.length === 0) throw new Error('empty room')
  const tile = room.tiles[0]
  if (tile === undefined) throw new Error('no tile')
  const { x, y } = world.grid.xy(tile)
  const entity = inmateOf(world, inmateId)
  entity.tx = x
  entity.ty = y
  entity.x = (x + 0.5) * DATA.balance.map.tileWorldUnits
  entity.y = (y + 0.5) * DATA.balance.map.tileWorldUnits
}

/* -------------------------------------------------------------------------- */
/* Price computation                                                           */
/* -------------------------------------------------------------------------- */

describe('computeContrabandPrice', () => {
  it('rises with demand relative to supply and respects clamp', () => {
    const base = 100
    expect(computeContrabandPrice(base, 0, 10, CLAMP)).toBe(100)
    expect(computeContrabandPrice(base, 10, 10, CLAMP)).toBe(200)
    expect(computeContrabandPrice(base, 100, 1, CLAMP)).toBe(Math.round(base * CLAMP.max))
    expect(computeContrabandPrice(base, 0, 0, CLAMP)).toBe(100)
    expect(computeContrabandPrice(base, 5, 0, CLAMP)).toBe(Math.round(base * CLAMP.max))
    // Abundant supply: 1 + 1/100 = 1.01 (still above clamp.min).
    expect(computeContrabandPrice(base, 1, 100, CLAMP)).toBe(101)
  })
})

describe('theftProbability', () => {
  it('is suppressed by guards and raised by trait modifiers', () => {
    const base = DATA.balance.contraband.theftBaseChance
    const suppress = DATA.balance.contraband.guardSuppressionFactor
    const saturate = DATA.balance.contraband.guardsInRoomSaturateAt
    const unguarded = theftProbability(base, 0, saturate, suppress, 1)
    const guarded = theftProbability(base, saturate, saturate, suppress, 1)
    const thief = theftProbability(base, 0, saturate, suppress, 2.5)
    expect(unguarded).toBeCloseTo(base, 5)
    expect(guarded).toBeCloseTo(base * (1 - suppress), 5)
    expect(thief).toBeGreaterThan(unguarded)
  })
})

/* -------------------------------------------------------------------------- */
/* Arrival possession                                                          */
/* -------------------------------------------------------------------------- */

describe('arrival possession', () => {
  it('scales with security category and grants smuggleable items', () => {
    const { world, events } = makeWorld()
    const stream = new Rng(SEED).stream('contraband')

    let minHits = 0
    let maxHits = 0
    const trials = 200

    for (let i = 0; i < trials; i += 1) {
      const minId = addInmate(world, { tx: 1, ty: 1, category: 'minimum', seed: SEED + i })
      const maxId = addInmate(world, {
        tx: 2,
        ty: 1,
        category: 'maximum',
        seed: SEED + 10_000 + i,
      })
      if (
        applyArrivalPossession({
          world,
          entity: inmateOf(world, minId),
          rng: stream,
          events,
          tick: i,
        }) !== undefined
      ) {
        minHits += 1
      }
      if (
        applyArrivalPossession({
          world,
          entity: inmateOf(world, maxId),
          rng: stream,
          events,
          tick: i,
        }) !== undefined
      ) {
        maxHits += 1
      }
    }

    expect(maxHits).toBeGreaterThan(minHits)
    expect(events.of(CONTRABAND_EVENTS.arrivedWith).length).toBe(minHits + maxHits)

    for (const event of events.of(CONTRABAND_EVENTS.arrivedWith)) {
      const data = event.data as { itemId: string }
      const def = DATA.contraband.get(data.itemId)
      expect(def.smuggleable).toBe(true)
    }
  })

  it('flushes pending arrivals queued by intake', () => {
    const { world, events } = makeWorld()
    const id = addInmate(world, { tx: 1, ty: 1, category: 'maximum', seed: 1 })
    world.contraband.queueArrival(id)
    flushPendingArrivals(world, new Rng(SEED).stream('contraband'), events, 60)
    expect(world.contraband.pendingArrivalIds).toHaveLength(0)
  })
})

/* -------------------------------------------------------------------------- */
/* Visit smuggling                                                             */
/* -------------------------------------------------------------------------- */

describe('visit hall smuggling', () => {
  it('succeeds with tables and is blocked by booths', () => {
    const { world, events } = makeWorld()
    const hallId = buildDesignatedRoom(world, events, { x: 2, y: 2, width: 10, height: 8 }, 'visit_hall')
    const hall = world.rooms.get(hallId)
    if (hall === undefined) throw new Error('missing hall')
    const inmateId = addInmate(world, { tx: 4, ty: 4, traits: ['deceitful'] })
    placeInmateInRoom(world, inmateId, hallId)

    const interior = hall.tiles[0]
    if (interior === undefined) throw new Error('no tile')
    const { x, y } = world.grid.xy(interior)

    placeObject(objectDeps(world, events), { x, y }, 'visit_table', 0)
    expect(visitSmuggleChance(world, hall)).toBe(DATA.balance.contraband.visitSmuggleChanceTables)

    let tableHits = 0
    const stream = new Rng(SEED).stream('contraband')
    for (let i = 0; i < 120; i += 1) {
      const entity = inmateOf(world, inmateId)
      entity.inmate.inventory.length = 0
      if (
        attemptVisitSmuggle({
          world,
          entity,
          room: hall,
          rng: stream,
          events,
          tick: i,
        }) !== undefined
      ) {
        tableHits += 1
      }
    }
    expect(tableHits).toBeGreaterThan(10)

    // Replace with booths: remove tables by redesignating a clean hall.
    events.clear()
    const boothHallId = buildDesignatedRoom(
      world,
      events,
      { x: 20, y: 2, width: 10, height: 8 },
      'visit_hall',
    )
    const boothHall = world.rooms.get(boothHallId)
    if (boothHall === undefined) throw new Error('missing booth hall')
    const boothTile = boothHall.tiles[0]
    if (boothTile === undefined) throw new Error('no booth tile')
    const boothXY = world.grid.xy(boothTile)
    placeObject(objectDeps(world, events), boothXY, 'visit_booth', 0)
    expect(visitSmuggleChance(world, boothHall)).toBe(
      DATA.balance.contraband.visitSmuggleChanceBooths,
    )

    let boothHits = 0
    placeInmateInRoom(world, inmateId, boothHallId)
    for (let i = 0; i < 120; i += 1) {
      const entity = inmateOf(world, inmateId)
      entity.inmate.inventory.length = 0
      world.contraband.stashes.length = 0
      if (
        attemptVisitSmuggle({
          world,
          entity,
          room: boothHall,
          rng: stream,
          events,
          tick: 1000 + i,
        }) !== undefined
      ) {
        boothHits += 1
      }
    }
    expect(boothHits).toBeLessThan(tableHits / 3)
  })
})

/* -------------------------------------------------------------------------- */
/* Delivery contamination                                                      */
/* -------------------------------------------------------------------------- */

describe('delivery contamination', () => {
  it('spawns contraband stashes from contaminable delivery lines', () => {
    const { world, events } = makeWorld()
    buildDesignatedRoom(world, events, { x: 2, y: 2, width: 8, height: 6 }, 'dock')
    const stream = new Rng(SEED).stream('contraband')

    const spawned = contaminateDelivery({
      world,
      itemId: 'commissary_goods',
      units: 80,
      rng: stream,
      events,
      tick: 100,
      truckId: 7,
    })

    expect(spawned.length).toBeGreaterThan(0)
    expect(world.contraband.stashes.length).toBe(spawned.length)
    expect(events.of(CONTRABAND_EVENTS.deliveryContaminated).length).toBe(spawned.length)
    for (const itemId of spawned) {
      expect(DATA.balance.contraband.deliveryContamination['commissary_goods']).toContain(itemId)
    }
  })
})

/* -------------------------------------------------------------------------- */
/* Room theft                                                                  */
/* -------------------------------------------------------------------------- */

describe('room-as-source theft', () => {
  it('leaks tools from an unguarded workshop', () => {
    const { world, events } = makeWorld()
    const workshopId = buildDesignatedRoom(
      world,
      events,
      { x: 2, y: 2, width: 10, height: 8 },
      'workshop',
    )
    const workshop = world.rooms.get(workshopId)
    if (workshop === undefined) throw new Error('missing workshop')
    expect(itemsSourcedFromRoom(DATA, 'workshop').length).toBeGreaterThan(0)

    const inmateId = addInmate(world, {
      tx: 4,
      ty: 4,
      traits: ['thief'],
      cellId: NO_ROOM,
    })
    placeInmateInRoom(world, inmateId, workshopId)

    const stream = new Rng(SEED).stream('contraband')
    let stolen = 0
    for (let i = 0; i < 400; i += 1) {
      const item = attemptRoomTheft({
        world,
        entity: inmateOf(world, inmateId),
        room: workshop,
        rng: stream,
        events,
        tick: i,
      })
      if (item !== undefined) stolen += 1
    }

    expect(stolen).toBeGreaterThan(5)
    const tools = [...inmateOf(world, inmateId).inmate.inventory, ...world.contraband.stashes.map((s) => s.itemId)]
    expect(tools.some((id) => itemsSourcedFromRoom(DATA, 'workshop').some((d) => d.id === id))).toBe(
      true,
    )
    expect(events.of(CONTRABAND_EVENTS.stolen).length).toBe(stolen)
  })

  it('yields nothing from a weapon rack in the yard (room is the source)', () => {
    const { world, events } = makeWorld()
    // Exercise yard can be outdoors — designate a floored yard area.
    const rect = { x: 2, y: 2, width: 10, height: 8 }
    for (let y = rect.y; y < rect.y + rect.height; y += 1) {
      for (let x = rect.x; x < rect.x + rect.width; x += 1) {
        putFloor(world, x, y)
        world.grid.setAt('outdoors', world.grid.idx(x, y), 1)
      }
    }
    designateRoom(roomDeps(world, events), rect, 'exercise_yard')
    const yard = [...world.rooms.all()].find((entry) => entry.defId === 'exercise_yard')
    if (yard === undefined) throw new Error('yard missing')

    const tile = yard.tiles[0]
    if (tile === undefined) throw new Error('no yard tile')
    const { x, y } = world.grid.xy(tile)
    placeObject(objectDeps(world, events), { x, y }, 'weapon_rack', 0)

    expect(itemsSourcedFromRoom(DATA, 'exercise_yard')).toHaveLength(0)

    const inmateId = addInmate(world, { tx: x, ty: y, traits: ['thief', 'reckless'] })
    placeInmateInRoom(world, inmateId, yard.id)

    const stream = new Rng(SEED).stream('contraband')
    for (let i = 0; i < 200; i += 1) {
      expect(
        attemptRoomTheft({
          world,
          entity: inmateOf(world, inmateId),
          room: yard,
          rng: stream,
          events,
          tick: i,
        }),
      ).toBeUndefined()
    }
    expect(inmateOf(world, inmateId).inmate.inventory).toHaveLength(0)
    expect(world.contraband.stashes).toHaveLength(0)
    expect(events.of(CONTRABAND_EVENTS.stolen)).toHaveLength(0)
  })

  it('suppresses theft when guards are in the room', () => {
    const { world, events } = makeWorld()
    const workshopId = buildDesignatedRoom(
      world,
      events,
      { x: 2, y: 2, width: 10, height: 8 },
      'workshop',
    )
    const workshop = world.rooms.get(workshopId)
    if (workshop === undefined) throw new Error('missing workshop')

    const inmateId = addInmate(world, { tx: 4, ty: 4, traits: ['thief'] })
    placeInmateInRoom(world, inmateId, workshopId)

    const streamUnguarded = new Rng(SEED).stream('contraband')
    let unguarded = 0
    for (let i = 0; i < 300; i += 1) {
      inmateOf(world, inmateId).inmate.inventory.length = 0
      world.contraband.stashes.length = 0
      if (
        attemptRoomTheft({
          world,
          entity: inmateOf(world, inmateId),
          room: workshop,
          rng: streamUnguarded,
          events,
          tick: i,
        }) !== undefined
      ) {
        unguarded += 1
      }
    }

    const tile = workshop.tiles[1] ?? workshop.tiles[0]
    if (tile === undefined) throw new Error('no tile')
    const { x, y } = world.grid.xy(tile)
    const hire = hireStaff({
      world,
      defId: 'officer',
      events,
      tick: 0,
      tx: x,
      ty: y,
    })
    if (hire.entity === undefined) throw new Error('hire failed')

    events.clear()
    const streamGuarded = new Rng(SEED).stream('contraband')
    let guarded = 0
    for (let i = 0; i < 300; i += 1) {
      inmateOf(world, inmateId).inmate.inventory.length = 0
      world.contraband.stashes.length = 0
      if (
        attemptRoomTheft({
          world,
          entity: inmateOf(world, inmateId),
          room: workshop,
          rng: streamGuarded,
          events,
          tick: i,
        }) !== undefined
      ) {
        guarded += 1
      }
    }

    expect(unguarded).toBeGreaterThan(guarded)
    expect(guarded).toBeLessThan(unguarded * 0.7)
  })
})

/* -------------------------------------------------------------------------- */
/* Crafting                                                                    */
/* -------------------------------------------------------------------------- */

describe('crafting', () => {
  it('crafts workshop items in the workshop', () => {
    const { world, events } = makeWorld()
    const workshopId = buildDesignatedRoom(
      world,
      events,
      { x: 2, y: 2, width: 10, height: 8 },
      'workshop',
    )
    const workshop = world.rooms.get(workshopId)
    if (workshop === undefined) throw new Error('missing workshop')
    const inmateId = addInmate(world, { tx: 4, ty: 4, traits: ['clever'] })
    placeInmateInRoom(world, inmateId, workshopId)

    const stream = new Rng(SEED).stream('contraband')
    let crafted = 0
    for (let i = 0; i < 500; i += 1) {
      if (
        attemptCraft({
          world,
          entity: inmateOf(world, inmateId),
          room: workshop,
          rng: stream,
          events,
          tick: i,
        }) !== undefined
      ) {
        crafted += 1
      }
    }
    expect(crafted).toBeGreaterThan(0)
    expect(events.of(CONTRABAND_EVENTS.crafted).length).toBe(crafted)
  })
})

/* -------------------------------------------------------------------------- */
/* Throw-ins                                                                   */
/* -------------------------------------------------------------------------- */

describe('perimeter throw-ins', () => {
  it('collects when unguarded and intercepts when an officer is on the tile', () => {
    const { world, events } = makeWorld(32)
    // Clear perimeter tiles for drops.
    for (let x = 0; x < 32; x += 1) {
      putFloor(world, x, 0)
      world.grid.setAt('outdoors', world.grid.idx(x, 0), 1)
    }

    const inmateId = addInmate(world, { tx: 5, ty: 5, traits: ['deceitful'] })
    addToInventory(inmateOf(world, inmateId).inmate, 'mobile_phone')
    const dropTile = world.grid.idx(3, 0)
    const stream = new Rng(SEED).stream('contraband')

    const arranged = arrangeThrowIn({
      world,
      entity: inmateOf(world, inmateId),
      rng: stream,
      events,
      tick: 100,
      itemId: 'cigarettes',
      tileIndex: dropTile,
    })
    if (arranged === undefined) throw new Error('arrange failed')
    expect(events.of(CONTRABAND_EVENTS.throwInArranged)).toHaveLength(1)

    const beforeCollect = inmateOf(world, inmateId).inmate.inventory.length
    const collected = resolveThrowIn({
      world,
      entry: arranged,
      events,
      tick: arranged.collectTick,
    })
    expect(collected).toBe('collected')
    expect(inmateOf(world, inmateId).inmate.inventory.length).toBe(beforeCollect + 1)
    expect(events.of(CONTRABAND_EVENTS.throwInCollected)).toHaveLength(1)

    // Second drop, intercepted.
    const arranged2 = arrangeThrowIn({
      world,
      entity: inmateOf(world, inmateId),
      rng: stream,
      events,
      tick: 200,
      itemId: 'lighter',
      tileIndex: dropTile,
    })
    if (arranged2 === undefined) throw new Error('arrange2 failed')

    const hire = hireStaff({
      world,
      defId: 'officer',
      events,
      tick: 0,
      tx: 3,
      ty: 0,
    })
    if (hire.entity === undefined) throw new Error('hire failed')

    const result = resolveThrowIn({
      world,
      entry: arranged2,
      events,
      tick: arranged2.collectTick,
    })
    expect(result).toBe('intercepted')
    expect(events.of(CONTRABAND_EVENTS.throwInIntercepted).length).toBeGreaterThanOrEqual(1)
    expect(countInventoryItem(inmateOf(world, inmateId).inmate, 'lighter')).toBe(0)
  })
})

/* -------------------------------------------------------------------------- */
/* Trading / prices                                                            */
/* -------------------------------------------------------------------------- */

describe('hourly trading market', () => {
  it('updates prices from supply and demand and moves money', () => {
    const { world, events } = makeWorld()
    // Keep both inmates on the same tile so they share a region.
    const sellerId = addInmate(world, { tx: 2, ty: 2, traits: ['thief'], seed: 11 })
    const buyerId = addInmate(world, { tx: 2, ty: 2, traits: ['violent'], seed: 22 })
    const seller = inmateOf(world, sellerId)
    const buyer = inmateOf(world, buyerId)
    seller.inmate.money = 0
    buyer.inmate.money = 5000
    addToInventory(seller.inmate, 'kitchen_knife')

    const priceBeforeTrade = computeContrabandPrice(
      DATA.contraband.get('kitchen_knife').basePrice,
      measureMarket(world, 'kitchen_knife').demand,
      measureMarket(world, 'kitchen_knife').supply,
      CLAMP,
    )

    runHourlyMarket({ world, events, tick: TICKS_PER_HOUR })

    expect(events.of(CONTRABAND_EVENTS.pricesUpdated).length).toBeGreaterThanOrEqual(1)
    expect(world.contraband.prices.get('kitchen_knife')).toBe(priceBeforeTrade)

    expect(countInventoryItem(buyer.inmate, 'kitchen_knife')).toBe(1)
    expect(countInventoryItem(seller.inmate, 'kitchen_knife')).toBe(0)
    expect(seller.inmate.money).toBe(priceBeforeTrade)
    expect(buyer.inmate.money).toBe(5000 - priceBeforeTrade)
    expect(events.of(CONTRABAND_EVENTS.traded)).toHaveLength(1)
  })

  it('raises price when demand exceeds supply', () => {
    const { world, events } = makeWorld()
    // One cigarette, many violent buyers wanting luxuries / weapons — use cigarettes.
    const sellerId = addInmate(world, { tx: 1, ty: 1, traits: ['thief'], seed: 1 })
    addToInventory(inmateOf(world, sellerId).inmate, 'cigarettes')
    for (let i = 0; i < 8; i += 1) {
      addInmate(world, { tx: 1, ty: 1, traits: [], seed: 100 + i })
    }

    const scarce = measureMarket(world, 'cigarettes')
    const scarcePrice = computeContrabandPrice(
      DATA.contraband.get('cigarettes').basePrice,
      scarce.demand,
      scarce.supply,
      CLAMP,
    )

    // Flood supply.
    for (let i = 0; i < 20; i += 1) {
      const id = addInmate(world, { tx: 1, ty: 1, traits: ['thief'], seed: 200 + i })
      addToInventory(inmateOf(world, id).inmate, 'cigarettes')
    }
    const flooded = measureMarket(world, 'cigarettes')
    const floodedPrice = computeContrabandPrice(
      DATA.contraband.get('cigarettes').basePrice,
      flooded.demand,
      flooded.supply,
      CLAMP,
    )

    expect(scarcePrice).toBeGreaterThan(floodedPrice)

    runHourlyMarket({ world, events, tick: TICKS_PER_HOUR })
    expect(world.contraband.prices.get('cigarettes')).toBe(floodedPrice)
  })
})

describe('timing constants', () => {
  it('uses the PRD 6-minute contraband period', () => {
    expect(DATA.balance.contraband.theftCheckMinutes * TICKS_PER_MINUTE).toBe(60)
  })
})
