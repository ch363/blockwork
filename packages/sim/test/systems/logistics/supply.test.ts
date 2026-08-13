/**
 * T3.4 — construction supply: order batching, truck schedule, carry jobs, stall.
 */

import { describe, expect, it } from 'vitest'

import { TICKS_PER_HOUR, TICKS_PER_MINUTE } from '../../../src/core/clock'
import { Simulation } from '../../../src/core/simulation'
import type { SimulationEvent } from '../../../src/core/simulation'
import { loadGameData } from '../../../src/data/loader'
import { placeObject } from '../../../src/entities/objects'
import { hireStaff } from '../../../src/entities/staff'
import { createInmateWorld } from '../../../src/systems/intakeSystem'
import type { InmateWorld } from '../../../src/systems/intakeSystem'
import { createJobSystem } from '../../../src/systems/jobSystem'
import { createConstructionSystem, uniformWorkforce } from '../../../src/systems/constructionSystem'
import {
  DELIVERY_EVENTS,
  batchOrdersIntoTrucks,
  createDeliveriesSystem,
  nextTruckTick,
  truckIntervalTicks,
} from '../../../src/systems/logistics/deliveries'
import type { DeliveryLine } from '../../../src/systems/logistics/deliveries'
import {
  SUPPLY_EVENTS,
  claimOpenCarryJobs,
  createSupplySystem,
  outstandingRequirement,
  updateSupply,
} from '../../../src/systems/logistics/supply'
import {
  isDelivered,
  placeWall,
  queueSite,
  refreshPassability,
} from '../../../src/world/construction'
import type { Rect } from '../../../src/world/construction'
import { initialLockState } from '../../../src/world/doors'
import { designateRoom } from '../../../src/world/roomDetection'

const RAW_DATA = loadGameData()
const DATA = {
  ...RAW_DATA,
  balance: {
    ...RAW_DATA.balance,
    utilities: { ...RAW_DATA.balance.utilities, utilitiesEnabled: false },
  },
}
const SEED = 0xb10c_3004
const WALL = 'brick_wall'
const INTERVAL = truckIntervalTicks(DATA)
const CAPACITY = DATA.balance.logistics.truckCapacity

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
  world.grid.setAt('wallMaterial', index, world.materials.indexOf(WALL))
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

function putRoomShell(world: InmateWorld, rect: Rect, outdoors = false): void {
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
      } else if (outdoors) {
        const index = world.grid.idx(x, y)
        world.grid.setAt('outdoors', index, 1)
        refreshPassability(world, world.data, index)
        world.structureChanged(index)
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

function deps(world: InmateWorld, events: RecordingSink, tick = 0) {
  return { world, data: DATA, events, tick }
}

interface FacilityOptions {
  readonly withStore?: boolean
  readonly withDock?: boolean
  readonly withRefuse?: boolean
  readonly mapSize?: number
}

interface Facility {
  readonly world: InmateWorld
  readonly events: RecordingSink
  readonly sim: Simulation
  run(ticks: number): void
}

function buildFacility(options: FacilityOptions = {}): Facility {
  const events = new RecordingSink()
  const world = createInmateWorld({
    size: options.mapSize ?? 48,
    data: DATA,
    continuousIntake: false,
  })

  if (options.withDock !== false) {
    const dockShell = { x: 2, y: 2, width: 5, height: 5 }
    putRoomShell(world, dockShell, true)
    const dockInterior = interiorOf(dockShell)
    // Dock is outdoors: paint designation tiles as outdoors walkable.
    for (let y = dockInterior.y; y < dockInterior.y + dockInterior.height; y += 1) {
      for (let x = dockInterior.x; x < dockInterior.x + dockInterior.width; x += 1) {
        const index = world.grid.idx(x, y)
        world.grid.setAt('outdoors', index, 1)
        refreshPassability(world, world.data, index)
      }
    }
    designateRoom(deps(world, events), dockInterior, 'dock')
    placeObject(deps(world, events), { x: dockInterior.x, y: dockInterior.y }, 'dock_marker', 0)
  }

  if (options.withStore !== false) {
    const storeShell = { x: 10, y: 2, width: 7, height: 7 }
    putRoomShell(world, storeShell)
    designateRoom(deps(world, events), interiorOf(storeShell), 'store')
  }

  if (options.withRefuse === true) {
    const refuseShell = { x: 20, y: 2, width: 5, height: 5 }
    putRoomShell(world, refuseShell, true)
    const refuseInterior = interiorOf(refuseShell)
    for (let y = refuseInterior.y; y < refuseInterior.y + refuseInterior.height; y += 1) {
      for (let x = refuseInterior.x; x < refuseInterior.x + refuseInterior.width; x += 1) {
        const index = world.grid.idx(x, y)
        world.grid.setAt('outdoors', index, 1)
        refreshPassability(world, world.data, index)
      }
    }
    designateRoom(deps(world, events), refuseInterior, 'refuse')
    placeObject(deps(world, events), { x: refuseInterior.x, y: refuseInterior.y }, 'refuse_bin', 0)
  }

  const sim = new Simulation({
    seed: SEED,
    world,
    systems: [
      createJobSystem({ data: DATA }),
      createSupplySystem({ data: DATA }),
      createDeliveriesSystem({ data: DATA }),
      createConstructionSystem({ data: DATA, workforce: uniformWorkforce(4) }),
    ],
    events,
  })

  return {
    world,
    events,
    sim,
    run(ticks) {
      for (let i = 0; i < ticks; i += 1) sim.step()
    },
  }
}

/** Advance carries: claim open missions then let supply complete them. */
function pumpCarries(facility: Facility, rounds = 20): void {
  for (let i = 0; i < rounds; i += 1) {
    claimOpenCarryJobs(facility.world)
    updateSupply(facility.world, DATA, facility.events, facility.sim.tick)
  }
}

describe('order batching', () => {
  it('packs lines into trucks of capacity without splitting past the limit', () => {
    const lines: DeliveryLine[] = []
    for (let i = 0; i < 50; i += 1) {
      lines.push({ itemId: WALL, units: 1, siteId: i + 1, orderId: i + 1 })
    }

    const trucks = batchOrdersIntoTrucks(lines, 40)
    expect(trucks).toHaveLength(2)
    expect(trucks[0]?.reduce((sum, line) => sum + line.units, 0)).toBe(40)
    expect(trucks[1]?.reduce((sum, line) => sum + line.units, 0)).toBe(10)
  })

  it('splits an oversized single line across trucks', () => {
    const trucks = batchOrdersIntoTrucks([{ itemId: WALL, units: 55, siteId: 1, orderId: 1 }], 40)
    expect(trucks).toHaveLength(2)
    expect(trucks[0]?.[0]?.units).toBe(40)
    expect(trucks[1]?.[0]?.units).toBe(15)
  })

  it('places material orders when sites are queued', () => {
    const facility = buildFacility()
    const tile = facility.world.grid.idx(30, 30)
    putFloor(facility.world, 30, 30)
    queueSite(deps(facility.world, facility.events), tile, {
      kind: 'wall',
      material: WALL,
      foundation: false,
    })

    updateSupply(facility.world, DATA, facility.events, 0)

    expect(facility.events.of(SUPPLY_EVENTS.ordered)).toHaveLength(1)
    expect(facility.world.deliveries.totalPendingUnits()).toBe(1)
  })
})

describe('truck scheduling', () => {
  it('computes the next truck slot on the logistics interval', () => {
    expect(nextTruckTick(0, 2)).toBe(2 * TICKS_PER_HOUR)
    expect(INTERVAL).toBe(2 * TICKS_PER_HOUR)
    expect(CAPACITY).toBe(40)
  })

  it('lands a pending order at the dock when the truck slot is due', () => {
    const facility = buildFacility()
    const tile = facility.world.grid.idx(30, 30)
    putFloor(facility.world, 30, 30)
    queueSite(deps(facility.world, facility.events), tile, {
      kind: 'wall',
      material: WALL,
      foundation: false,
    })

    // Orders flush on the first supply minute; truck arrives at the interval.
    facility.run(INTERVAL)

    expect(facility.events.of(DELIVERY_EVENTS.truckArrived).length).toBeGreaterThan(0)
    expect(facility.world.supply.totalDockUnits()).toBeGreaterThan(0)
  })
})

describe('carry job generation', () => {
  it('posts dock→store deliver jobs once materials land', () => {
    const facility = buildFacility()
    facility.world.supply.addDockStock(WALL, 5, 1)
    updateSupply(facility.world, DATA, facility.events, 10)

    const deliverJobs = facility.world.jobs.open().filter((job) => job.kind === 'deliver')
    expect(deliverJobs.length).toBeGreaterThan(0)
    expect([...facility.world.supply.carries.values()].some((m) => m.hop === 'dockToStore')).toBe(
      true,
    )
  })

  it('moves dock stock into the store when carry jobs are claimed', () => {
    const facility = buildFacility()
    facility.world.supply.addDockStock(WALL, 5, 1)
    updateSupply(facility.world, DATA, facility.events, 10)
    pumpCarries(facility, 5)

    expect(facility.world.supply.totalDockUnits()).toBe(0)
    expect(facility.world.supply.storeUnits(WALL)).toBe(5)
    expect(facility.events.of(SUPPLY_EVENTS.carried).length).toBeGreaterThan(0)
  })

  it('posts store→site jobs and delivers into the construction bill', () => {
    const facility = buildFacility()
    const tile = facility.world.grid.idx(30, 30)
    putFloor(facility.world, 30, 30)
    const site = queueSite(deps(facility.world, facility.events), tile, {
      kind: 'wall',
      material: WALL,
      foundation: false,
    })
    expect(site).toBeDefined()

    updateSupply(facility.world, DATA, facility.events, 0)
    // Bypass the truck: stock the store directly after ordering bookkeeping.
    facility.world.supply.addStoreStock(WALL, 1)
    updateSupply(facility.world, DATA, facility.events, 10)
    pumpCarries(facility, 5)

    expect(site !== undefined && isDelivered(site)).toBe(true)
  })
})

describe('stall detection', () => {
  it('notifies when materials pile at the dock with no store', () => {
    const facility = buildFacility({ withStore: false })
    const tile = facility.world.grid.idx(30, 30)
    putFloor(facility.world, 30, 30)
    queueSite(deps(facility.world, facility.events), tile, {
      kind: 'wall',
      material: WALL,
      foundation: false,
    })

    facility.run(INTERVAL)
    updateSupply(facility.world, DATA, facility.events, facility.sim.tick)

    expect(facility.world.supply.totalDockUnits()).toBeGreaterThan(0)
    expect(facility.world.supply.storeUnits(WALL)).toBe(0)
    expect(facility.events.of(SUPPLY_EVENTS.noStore).length).toBeGreaterThan(0)
    const stalled = facility.world.sites.get(tile)
    if (stalled === undefined) throw new Error('site vanished')
    expect(isDelivered(stalled)).toBe(false)
  })

  it('keeps construction blocked on materials while the store is missing', () => {
    const facility = buildFacility({ withStore: false })
    placeWall(deps(facility.world, facility.events), { x1: 30, y1: 30, x2: 30, y2: 30 }, WALL)
    facility.run(INTERVAL + TICKS_PER_MINUTE * 5)

    const site = facility.world.sites.get(facility.world.grid.idx(30, 30))
    expect(site?.blockedBy).toBe('materials')
    expect(facility.world.grid.get('wallMaterial', 30, 30)).toBe(0)
  })
})

describe('end-to-end 40-object blueprint supply', () => {
  it('delivers forty wall sites through trucks and carries over a few hours', () => {
    const facility = buildFacility()
    // Forty single-tile wall sites → forty material units → one truck.
    for (let i = 0; i < 40; i += 1) {
      const x = 24 + (i % 8)
      const y = 20 + Math.floor(i / 8)
      putFloor(facility.world, x, y)
      queueSite(deps(facility.world, facility.events), facility.world.grid.idx(x, y), {
        kind: 'wall',
        material: WALL,
        foundation: false,
      })
    }

    expect(facility.world.sites.size).toBe(40)

    // Flush orders, wait for the truck, then pump carries until bills fill.
    facility.run(TICKS_PER_MINUTE)
    expect(
      facility.world.deliveries.totalPendingUnits() + facility.world.deliveries.scheduled.length,
    ).toBeGreaterThan(0)

    facility.run(INTERVAL)

    // Move dock → store → site without the job system abandoning fake claimants.
    let guard = 0
    while (guard < 200 && [...facility.world.sites.all()].some((site) => !isDelivered(site))) {
      claimOpenCarryJobs(facility.world)
      updateSupply(facility.world, DATA, facility.events, facility.sim.tick)
      // Post fresh carry jobs after completions.
      updateSupply(facility.world, DATA, facility.events, facility.sim.tick + 1)
      guard += 1
    }

    const undelivered = facility.world.sites.all().filter((site) => !isDelivered(site)).length
    expect(undelivered).toBe(0)
    expect(facility.events.of(DELIVERY_EVENTS.truckArrived).length).toBeGreaterThan(0)
    // Construction with uniform workforce finishes the walls shortly after.
    facility.run(TICKS_PER_MINUTE * 30)
    expect(facility.world.sites.size).toBe(0)
  })
})

describe('refuse dirt', () => {
  it('raises tile dirt while refuse sits uncollected', () => {
    const facility = buildFacility({ withRefuse: true })
    const bin = [...facility.world.objects.all()].find(
      (entity) => entity.object.defId === 'refuse_bin',
    )
    expect(bin).toBeDefined()
    if (bin === undefined) throw new Error('expected refuse bin')

    facility.world.supply.addBinRefuse(bin.id, 20)
    const before = facility.world.grid.dirt[bin.tileIndex] ?? 0
    updateSupply(facility.world, DATA, facility.events, 10)
    const after = facility.world.grid.dirt[bin.tileIndex] ?? 0
    expect(after).toBeGreaterThan(before)
  })
})

describe('outstandingRequirement', () => {
  it('reports only the gap between bill and ordered units', () => {
    const facility = buildFacility()
    const tile = facility.world.grid.idx(30, 30)
    putFloor(facility.world, 30, 30)
    const site = queueSite(deps(facility.world, facility.events), tile, {
      kind: 'wall',
      material: WALL,
      foundation: false,
    })
    if (site === undefined) throw new Error('expected site')

    expect(outstandingRequirement(site, () => 0)).toEqual([{ itemId: WALL, units: 1 }])
    expect(outstandingRequirement(site, () => 1)).toEqual([])
  })
})

describe('hired workers claim deliver jobs', () => {
  it('lets the job system claim a dock carry for maintenance staff', () => {
    const facility = buildFacility()
    hireStaff({
      world: facility.world,
      defId: 'maintenance',
      events: facility.events,
      tick: 0,
      tx: 4,
      ty: 4,
    })
    facility.world.supply.addDockStock(WALL, 2, 1)
    updateSupply(facility.world, DATA, facility.events, 0)
    facility.run(TICKS_PER_MINUTE * 2)

    const claimed = facility.world.jobs.claimed().filter((job) => job.kind === 'deliver')
    expect(claimed.length + facility.events.of(SUPPLY_EVENTS.carried).length).toBeGreaterThan(0)
  })
})
