/**
 * T4.7 — Escapes and tunnels: dig maths, merging, detection, network escapes,
 * escape-count failure accounting.
 */

import { describe, expect, it } from 'vitest'

import { TICKS_PER_DAY } from '../../src/core/clock'
import { Rng } from '../../src/core/rng'
import type { RngStream } from '../../src/core/rng'
import { Simulation } from '../../src/core/simulation'
import type { SimulationEvent } from '../../src/core/simulation'
import { loadGameData } from '../../src/data/loader'
import { createInmateShell, generateInmate } from '../../src/entities/inmate'
import { placeObject } from '../../src/entities/objects'
import type { ObjectDeps } from '../../src/entities/objects'
import { NO_PIN, NO_STAFF } from '../../src/entities/staff'
import type { StaffEntity } from '../../src/entities/staff'
import {
  ESCAPE_EVENTS,
  ESCAPE_SYSTEM_PERIOD,
  advanceTunnelDig,
  checkEscapeFailure,
  createEscapeSystem,
  digProgressThisHour,
  discoverTunnel,
  maintenanceSweep,
  mergeTunnels,
  resolveInmateEscape,
  resolvePendingNetworkEscapes,
  rollEscapeDayCounters,
  searchCellForTunnels,
  setInmateInventory,
  tryDogDetection,
  tryFenceClimb,
  tryRiotDoorEscape,
  tryVehicleTheft,
  tryWalkOut,
} from '../../src/systems/escapeSystem'
import type { Tunnel } from '../../src/systems/escapeSystem'
import { createInmateWorld } from '../../src/systems/intakeSystem'
import type { InmateWorld } from '../../src/systems/intakeSystem'
import { refreshPassability } from '../../src/world/construction'
import { NO_ROOM } from '../../src/world/rooms'
import type { Room } from '../../src/world/rooms'
import { PASSABILITY } from '../../src/world/tileGrid'

const DATA = loadGameData()
const SEED = 0xe5ca_7e01

class RecordingSink {
  readonly events: SimulationEvent[] = []
  emit(event: SimulationEvent): void {
    this.events.push(event)
  }
  of(kind: string): SimulationEvent[] {
    return this.events.filter((event) => event.kind === kind)
  }
}

function world(size = 24): InmateWorld {
  const w = createInmateWorld({ size, data: DATA, continuousIntake: false })
  w.grid.fill('owned', 1)
  return w
}

function objectDeps(w: InmateWorld, events: RecordingSink, tick = 0): ObjectDeps {
  return { world: w, data: DATA, events, tick }
}

function putFloor(w: InmateWorld, x: number, y: number): number {
  const floor = DATA.balance.construction.foundationFloorMaterial
  const index = w.grid.idx(x, y)
  w.grid.setAt('floorMaterial', index, w.materials.indexOf(floor))
  w.grid.setAt('outdoors', index, 0)
  refreshPassability(w, DATA, index)
  return index
}

function addCell(
  w: InmateWorld,
  events: RecordingSink,
  ox: number,
  oy: number,
): { roomId: number; toiletTile: number; tiles: number[] } {
  const tiles: number[] = []
  for (let y = oy; y < oy + 3; y += 1) {
    for (let x = ox; x < ox + 3; x += 1) {
      tiles.push(putFloor(w, x, y))
    }
  }
  const roomId = w.rooms.allocateId()
  const room: Room = {
    id: roomId,
    defId: 'cell',
    tiles,
    bounds: { x: ox, y: oy, width: 3, height: 3 },
    properties: { enclosed: true, indoors: true, outdoors: false, secure: true },
  }
  w.rooms.set(room)
  for (const tile of tiles) w.grid.setAt('roomId', tile, roomId)
  w.rooms.setStatus({
    roomId,
    defId: 'cell',
    functional: true,
    requirements: [],
  })

  const placed = placeObject(objectDeps(w, events), { x: ox + 1, y: oy + 1 }, 'toilet', 0)
  if (placed === undefined) throw new Error('toilet placement failed')
  const toiletTile = (oy + 1) * w.grid.size + (ox + 1)
  return { roomId, toiletTile, tiles }
}

function spawnCleverDigger(
  w: InmateWorld,
  cellId: number,
  tx: number,
  ty: number,
  toolId = 'screwdriver',
) {
  const rng = new Rng(SEED)
  const component = generateInmate({
    data: DATA,
    rng: rng.stream('intake'),
    category: 'medium',
  })
  const withTrait = {
    ...component,
    traits: component.traits.includes('clever')
      ? component.traits
      : [...component.traits, 'clever'],
    cellId,
  }
  const id = w.inmates.allocateId()
  const entity = createInmateShell({
    id,
    data: DATA,
    inmate: withTrait,
    tx,
    ty,
  })
  setInmateInventory(entity, [toolId])
  w.inmates.add(entity)
  w.inmates.assignHousing(id, cellId)
  const runtime = w.routineRuntime.stateOf(id)
  runtime.blockId = 'sleep'
  runtime.lockedUp = true
  return entity
}

function makeTunnel(
  w: InmateWorld,
  originTile: number,
  diggerIds: number[],
  extraTiles: number[] = [],
): Tunnel {
  const id = w.escapes.allocateId()
  const tunnel: Tunnel = {
    id,
    originTile,
    tiles: [originTile, ...extraTiles],
    diggerIds: [...diggerIds],
    discovered: false,
    progress: 0,
    reachedExit: false,
    networkId: id,
  }
  w.escapes.add(tunnel)
  return tunnel
}

function alwaysHitStream(): RngStream {
  const stream = new Rng(1).stream('tunnels')
  stream.chance = () => true
  return stream
}

/** Dogs require a kennel to hire — tests place the entity directly. */
function placeDog(w: InmateWorld, tx: number, ty: number): StaffEntity {
  const id = w.staff.allocateId()
  if (id === NO_STAFF) throw new Error('staff id exhausted')
  const units = DATA.balance.map.tileWorldUnits
  const entity: StaffEntity = {
    id,
    kind: 'staff',
    x: (tx + 0.5) * units,
    y: (ty + 0.5) * units,
    tx,
    ty,
    staff: {
      defId: DATA.balance.tunnels.dogStaffRoleId,
      name: `Patrol Dog ${id}`,
      officeRoomId: NO_ROOM,
      assignedAreaId: 0,
      pinnedTile: NO_PIN,
      duty: { kind: 'idle' },
      wanderCooldown: 0,
      needs: new Float32Array(DATA.needs.size),
      breakPending: false,
      breakCooldownMinutes: 0,
    },
  }
  w.staff.add(entity)
  return entity
}

describe('dig progress maths', () => {
  it('matches tilesPerHourBase + variance * rand and consumes one draw', () => {
    const rng = new Rng(SEED).stream(DATA.balance.tunnels.rngStream)
    const a = digProgressThisHour(rng, DATA)
    const b = digProgressThisHour(rng, DATA)
    expect(a).toBeGreaterThanOrEqual(DATA.balance.tunnels.tilesPerHourBase)
    expect(a).toBeLessThanOrEqual(
      DATA.balance.tunnels.tilesPerHourBase + DATA.balance.tunnels.tilesPerHourVariance,
    )
    expect(b).not.toBe(a)

    const replay = new Rng(SEED).stream(DATA.balance.tunnels.rngStream)
    expect(digProgressThisHour(replay, DATA)).toBe(a)
  })
})

describe('tunnel merging', () => {
  it('merges diggers and tiles when heads meet', () => {
    const w = world()
    const events = new RecordingSink()
    const a = makeTunnel(w, 10, [1], [11, 12])
    const b = makeTunnel(w, 30, [2], [31, 12])

    const merged = mergeTunnels(w, a, b, events, 0)

    expect(merged.id).toBe(a.id)
    expect(w.escapes.get(b.id)).toBeUndefined()
    expect(merged.diggerIds).toEqual([1, 2])
    expect(merged.tiles).toEqual(expect.arrayContaining([10, 11, 12, 30, 31]))
    expect(merged.networkId).toBe(Math.min(a.id, b.id))
    expect(events.of(ESCAPE_EVENTS.tunnelMerged)).toHaveLength(1)
  })
})

describe('detection methods', () => {
  it('detects with a dog pass inside range at the configured chance', () => {
    const w = world()
    const events = new RecordingSink()
    const cell = addCell(w, events, 4, 4)
    const digger = spawnCleverDigger(w, cell.roomId, 5, 5)
    const tunnel = makeTunnel(w, cell.toiletTile, [digger.id])

    const dog = placeDog(w, 5, 5)

    const detected = tryDogDetection(w, dog, DATA, alwaysHitStream(), events, 10)
    expect(detected).toBe(true)
    expect(tunnel.discovered).toBe(true)
    expect(events.of(ESCAPE_EVENTS.tunnelDiscovered)[0]?.data).toMatchObject({ method: 'dog' })
    expect(digger.inmate.suppression).toBeGreaterThan(0)
  })

  it('detects at 100% on cell search', () => {
    const w = world()
    const events = new RecordingSink()
    const cell = addCell(w, events, 2, 2)
    const digger = spawnCleverDigger(w, cell.roomId, 3, 3)
    const tunnel = makeTunnel(w, cell.toiletTile, [digger.id])

    const found = searchCellForTunnels(w, cell.roomId, DATA, events, 5, 99)
    expect(found).toHaveLength(1)
    expect(tunnel.discovered).toBe(true)
    expect(events.of(ESCAPE_EVENTS.tunnelDiscovered)[0]?.data).toMatchObject({
      method: 'cellSearch',
      detectorId: 99,
    })
  })

  it('detects on maintenance sweep of the entrance tile', () => {
    const w = world()
    const events = new RecordingSink()
    const cell = addCell(w, events, 6, 6)
    const digger = spawnCleverDigger(w, cell.roomId, 7, 7)
    const tunnel = makeTunnel(w, cell.toiletTile, [digger.id])

    const found = maintenanceSweep(w, DATA, events, 8, [cell.toiletTile], 7)
    expect(found).toHaveLength(1)
    expect(tunnel.discovered).toBe(true)
    expect(events.of(ESCAPE_EVENTS.tunnelDiscovered)[0]?.data).toMatchObject({
      method: 'maintenanceSweep',
    })
  })
})

describe('escape resolution for a network', () => {
  it('queues connected diggers and escapes them over nights', () => {
    const w = world()
    const events = new RecordingSink()
    const cellA = addCell(w, events, 2, 2)
    const cellB = addCell(w, events, 8, 2)
    const a = spawnCleverDigger(w, cellA.roomId, 3, 3)
    const b = spawnCleverDigger(w, cellB.roomId, 9, 3)

    const tunnel = makeTunnel(w, cellA.toiletTile, [a.id, b.id], [cellB.toiletTile])
    tunnel.reachedExit = true
    w.escapes.pendingEscapes.push({
      networkId: tunnel.networkId,
      inmateIds: [a.id, b.id],
      remainingIds: [a.id, b.id],
    })

    expect(resolvePendingNetworkEscapes(w, DATA, events, 100)).toBe(1)
    expect(w.inmates.get(a.id)).toBeUndefined()
    expect(w.inmates.get(b.id)).toBeDefined()
    expect(w.escapes.escapesToday).toBe(1)

    expect(resolvePendingNetworkEscapes(w, DATA, events, 200)).toBe(1)
    expect(w.inmates.get(b.id)).toBeUndefined()
    expect(w.escapes.escapesToday).toBe(2)
    expect(events.of(ESCAPE_EVENTS.inmateEscaped)).toHaveLength(2)
  })

  it('marks exit when dig reaches the map edge', () => {
    const w = world(8)
    const events = new RecordingSink()
    const origin = w.grid.idx(2, 3)
    const tunnel = makeTunnel(w, origin, [1])
    advanceTunnelDig(w, tunnel, 10, events, 0)
    expect(tunnel.reachedExit).toBe(true)
    expect(events.of(ESCAPE_EVENTS.tunnelReachedEdge).length).toBeGreaterThan(0)
    expect(w.escapes.pendingEscapes.length).toBeGreaterThan(0)
  })
})

describe('escape count accounting', () => {
  it('warns at the daily threshold and fails after thenNextDay on the next day', () => {
    const w = world()
    const events = new RecordingSink()
    const { warningPerDay, thenNextDay } = DATA.balance.failure.escapes

    w.escapes.escapesToday = warningPerDay
    checkEscapeFailure(w, DATA, events, 10)
    expect(events.of(ESCAPE_EVENTS.failureWarning)).toHaveLength(1)
    expect(w.escapes.failed).toBe(false)

    rollEscapeDayCounters(w, DATA, TICKS_PER_DAY)
    expect(w.escapes.escapesYesterday).toBe(warningPerDay)
    expect(w.escapes.escapesToday).toBe(0)
    expect(w.escapes.warningActive).toBe(true)

    w.escapes.escapesToday = thenNextDay
    checkEscapeFailure(w, DATA, events, TICKS_PER_DAY + 10)
    expect(w.escapes.failed).toBe(true)
    expect(events.of(ESCAPE_EVENTS.failure)).toHaveLength(1)
  })

  it('increments counters on resolveInmateEscape', () => {
    const w = world()
    const events = new RecordingSink()
    const cell = addCell(w, events, 2, 2)
    const inmate = spawnCleverDigger(w, cell.roomId, 3, 3)

    expect(
      resolveInmateEscape({
        world: w,
        inmateId: inmate.id,
        data: DATA,
        events,
        tick: 50,
        route: 'tunnel',
      }),
    ).toBe(true)
    expect(w.escapes.escapesToday).toBe(1)
    expect(w.escapes.totalEscapes).toBe(1)
    expect(w.contracts.progress.lastIncidentTick.get('escape')).toBe(50)
  })
})

describe('alternate escape routes', () => {
  it('escapes through a breached riot door near the perimeter', () => {
    const w = world()
    const events = new RecordingSink()
    addCell(w, events, 2, 2)
    const inmate = spawnCleverDigger(w, NO_ROOM, 0, 2)
    w.riotActive = true
    const doorTile = inmate.ty * w.grid.size + inmate.tx
    w.escapes.markDoorBreached(doorTile)

    expect(tryRiotDoorEscape(w, inmate, DATA, events, 1)).toBe(true)
    expect(w.inmates.get(inmate.id)).toBeUndefined()
    expect(events.of(ESCAPE_EVENTS.inmateEscaped)[0]?.data).toMatchObject({ route: 'riotDoor' })
  })

  it('lets very_strong climb a neighbouring fence', () => {
    const w = world()
    const events = new RecordingSink()
    const cell = addCell(w, events, 4, 4)
    const inmate = spawnCleverDigger(w, cell.roomId, 5, 5)
    ;(inmate.inmate as unknown as { traits: string[] }).traits = ['very_strong']
    const fence = putFloor(w, 5, 4)
    w.grid.setAt('wallMaterial', fence, w.materials.indexOf('chain_fence'))

    expect(tryFenceClimb(w, inmate, DATA, events, 2)).toBe(true)
    expect(events.of(ESCAPE_EVENTS.inmateEscaped)[0]?.data).toMatchObject({ route: 'fenceClimb' })
  })

  it('lets a driver steal a vehicle from a dock room', () => {
    const w = world()
    const events = new RecordingSink()
    const tiles = [putFloor(w, 1, 1), putFloor(w, 2, 1), putFloor(w, 1, 2), putFloor(w, 2, 2)]
    const roomId = w.rooms.allocateId()
    w.rooms.set({
      id: roomId,
      defId: 'dock',
      tiles,
      bounds: { x: 1, y: 1, width: 2, height: 2 },
      properties: { enclosed: false, indoors: false, outdoors: true, secure: false },
    })
    for (const tile of tiles) w.grid.setAt('roomId', tile, roomId)

    const inmate = spawnCleverDigger(w, NO_ROOM, 1, 1)
    ;(inmate.inmate as unknown as { traits: string[] }).traits = ['driver']

    expect(tryVehicleTheft(w, inmate, DATA, events, 3)).toBe(true)
    expect(events.of(ESCAPE_EVENTS.inmateEscaped)[0]?.data).toMatchObject({
      route: 'vehicleTheft',
    })
  })

  it('allows walking out of an open map-edge tile', () => {
    const w = world()
    const events = new RecordingSink()
    const edge = putFloor(w, 0, 5)
    w.grid.setAt('passability', edge, PASSABILITY.WALKABLE)
    w.grid.setAt('wallMaterial', edge, 0)
    const inmate = spawnCleverDigger(w, NO_ROOM, 0, 5)

    expect(tryWalkOut(w, inmate, DATA, events, 4)).toBe(true)
    expect(events.of(ESCAPE_EVENTS.inmateEscaped)[0]?.data).toMatchObject({ route: 'walkOut' })
  })
})

describe('hourly escape system dig loop', () => {
  it('digs over nights for a clever inmate with a screwdriver and toilet', () => {
    const w = world(16)
    const events = new RecordingSink()
    const cell = addCell(w, events, 6, 6)
    const digger = spawnCleverDigger(w, cell.roomId, 7, 7)

    const sim = new Simulation({
      seed: SEED,
      world: w,
      systems: [createEscapeSystem({ data: DATA })],
      events,
    })

    for (let i = 0; i < 80; i += 1) {
      const runtime = w.routineRuntime.stateOf(digger.id)
      runtime.blockId = 'sleep'
      runtime.lockedUp = true
      for (let t = 0; t < ESCAPE_SYSTEM_PERIOD; t += 1) sim.step()
    }

    const tunnels = w.escapes.all()
    expect(tunnels.length).toBeGreaterThanOrEqual(1)
    const tunnel = tunnels[0]
    expect(tunnel?.tiles.length ?? 0).toBeGreaterThan(1)
    expect(events.of(ESCAPE_EVENTS.tunnelStarted).length).toBeGreaterThan(0)
    expect(events.of(ESCAPE_EVENTS.tunnelExtended).length).toBeGreaterThan(0)
  })

  it('finds tunnels over time when a dog patrols the entrance', () => {
    const w = world(16)
    const events = new RecordingSink()
    const cell = addCell(w, events, 4, 4)
    const digger = spawnCleverDigger(w, cell.roomId, 5, 5)
    makeTunnel(w, cell.toiletTile, [digger.id])

    placeDog(w, 5, 5)

    const sim = new Simulation({
      seed: SEED,
      world: w,
      systems: [createEscapeSystem({ data: DATA })],
      events,
    })

    let found = false
    for (let hour = 0; hour < 40; hour += 1) {
      for (let t = 0; t < ESCAPE_SYSTEM_PERIOD; t += 1) sim.step()
      if (w.escapes.all().some((tunnel) => tunnel.discovered)) {
        found = true
        break
      }
    }
    expect(found).toBe(true)
    expect(events.of(ESCAPE_EVENTS.tunnelDiscovered).length).toBeGreaterThan(0)
  })
})

describe('discoverTunnel collapses and cancels pending escapes', () => {
  it('clears pending escapes when the only exit tunnel is discovered', () => {
    const w = world()
    const events = new RecordingSink()
    const cell = addCell(w, events, 2, 2)
    const digger = spawnCleverDigger(w, cell.roomId, 3, 3)
    const tunnel = makeTunnel(w, cell.toiletTile, [digger.id])
    tunnel.reachedExit = true
    w.escapes.pendingEscapes.push({
      networkId: tunnel.networkId,
      inmateIds: [digger.id],
      remainingIds: [digger.id],
    })

    discoverTunnel({
      world: w,
      tunnel,
      data: DATA,
      events,
      tick: 9,
      method: 'cellSearch',
    })

    expect(tunnel.discovered).toBe(true)
    expect(w.escapes.pendingEscapes).toHaveLength(0)
  })
})
