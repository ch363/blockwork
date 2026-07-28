/**
 * T4.8 — Fire: spread by material, damage, sprinklers, firefighters.
 */

import { describe, expect, it } from 'vitest'

import { Rng } from '../../src/core/rng'
import { Simulation } from '../../src/core/simulation'
import type { SimulationEvent } from '../../src/core/simulation'
import { loadGameData } from '../../src/data/loader'
import { createInmateShell, generateInmate } from '../../src/entities/inmate'
import type { InmateEntity } from '../../src/entities/inmate'
import { placeObject } from '../../src/entities/objects'
import type { ObjectDeps } from '../../src/entities/objects'
import type { InmateWorld } from '../../src/systems/intakeSystem'
import { createInmateWorld } from '../../src/systems/intakeSystem'
import {
  FIRE_EVENTS,
  FIRE_SYSTEM_NAME,
  FIRE_SYSTEM_PERIOD,
  createFireSystem,
  igniteTile,
  perTickFromPerSecond,
  smokeBlocksVisibility,
  smokeMovementMultiplier,
  summonFirefighters,
  tileFlammability,
} from '../../src/systems/fireSystem'
import { refreshPassability } from '../../src/world/construction'
import type { Rect } from '../../src/world/construction'
import { initialLockState } from '../../src/world/doors'
import { designateRoom } from '../../src/world/roomDetection'
import type { RoomDeps } from '../../src/world/roomDetection'

const RAW_DATA = loadGameData()
const DATA = {
  ...RAW_DATA,
  balance: {
    ...RAW_DATA.balance,
    utilities: { ...RAW_DATA.balance.utilities, utilitiesEnabled: false },
  },
}
const SEED = 0xb10c_4008

class RecordingSink {
  readonly events: SimulationEvent[] = []
  emit(event: SimulationEvent): void {
    this.events.push(event)
  }
  of(kind: string): SimulationEvent[] {
    return this.events.filter((event) => event.kind === kind)
  }
}

function putFloor(world: InmateWorld, x: number, y: number, materialId = 'timber_board'): number {
  const index = world.grid.idx(x, y)
  world.grid.setAt('floorMaterial', index, world.materials.indexOf(materialId))
  world.grid.setAt('outdoors', index, 0)
  refreshPassability(world, world.data, index)
  world.structureChanged(index)
  return index
}

function putWall(world: InmateWorld, x: number, y: number): number {
  const index = putFloor(world, x, y, 'timber_board')
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

function putRoomShell(world: InmateWorld, rect: Rect, floorMaterial = 'timber_board'): void {
  for (let y = rect.y; y < rect.y + rect.height; y += 1) {
    for (let x = rect.x; x < rect.x + rect.width; x += 1) {
      const onEdge =
        x === rect.x ||
        y === rect.y ||
        x === rect.x + rect.width - 1 ||
        y === rect.y + rect.height - 1
      if (onEdge) putWall(world, x, y)
      else putFloor(world, x, y, floorMaterial)
    }
  }
  putDoor(world, rect.x + Math.floor(rect.width / 2), rect.y + rect.height - 1)
}

function objectDeps(world: InmateWorld, events: RecordingSink, tick = 0): ObjectDeps {
  return { world, data: world.data, events, tick }
}

function roomDeps(world: InmateWorld, events: RecordingSink, tick = 0): RoomDeps {
  return { world, data: world.data, events, tick }
}

function scenario(size = 24): {
  world: InmateWorld
  sim: Simulation
  events: RecordingSink
} {
  const events = new RecordingSink()
  const world = createInmateWorld({ size, data: DATA, continuousIntake: false })
  const sim = new Simulation({
    seed: SEED,
    world,
    systems: [createFireSystem({ data: DATA })],
    events,
  })
  return { world, sim, events }
}

function step(sim: Simulation, ticks: number): void {
  for (let i = 0; i < ticks; i += 1) sim.step()
}

function placeInmate(world: InmateWorld, tx: number, ty: number): InmateEntity {
  const component = generateInmate({
    data: world.data,
    rng: new Rng(SEED).stream('test'),
    category: 'medium',
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
      inventory: [],
    },
    tx,
    ty,
  })
  world.inmates.add(entity)
  return entity
}

function giveLighter(inmate: InmateEntity): void {
  ;(inmate.inmate as unknown as { inventory: string[] }).inventory = ['lighter']
}

function countBurning(world: InmateWorld): number {
  let n = 0
  for (let i = 0; i < world.fire.intensity.length; i += 1) {
    if (world.fire.isBurning(i)) n += 1
  }
  return n
}

function eventFieldIs(event: SimulationEvent, key: string, value: string): boolean {
  const data = event.data
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return false
  const record = data as Record<string, unknown>
  return record[key] === value
}

describe('fireSystem (T4.8)', () => {
  it('registers as an every-tick emergency system', () => {
    const system = createFireSystem({ data: DATA })
    expect(system.name).toBe(FIRE_SYSTEM_NAME)
    expect(system.period).toBe(FIRE_SYSTEM_PERIOD)
    expect(FIRE_SYSTEM_PERIOD).toBe(1)
  })

  it('converts per-second damage into per-tick using the clock rate', () => {
    const ticksPerMinute = DATA.balance.time.ticksPerMinute
    expect(perTickFromPerSecond(1, ticksPerMinute)).toBe(6)
    expect(perTickFromPerSecond(DATA.balance.fire.agentDamagePerSecond, ticksPerMinute)).toBe(
      DATA.balance.fire.agentDamagePerSecond * 6,
    )
  })
})

describe('spread rates per material', () => {
  it('spreads across timber board and refuses concrete', () => {
    const timber = scenario()
    const shell = { x: 2, y: 2, width: 8, height: 8 }
    putRoomShell(timber.world, shell, 'timber_board')
    designateRoom(roomDeps(timber.world, timber.events), {
      x: 3,
      y: 3,
      width: 6,
      height: 6,
    }, 'dormitory')

    const origin = timber.world.grid.idx(5, 5)
    expect(tileFlammability(timber.world, origin, DATA)).toBeGreaterThan(0.5)
    igniteTile({
      world: timber.world,
      tileIndex: origin,
      intensity: 200,
      source: 'manual',
      events: timber.events,
      tick: 0,
    })
    step(timber.sim, 80)
    expect(countBurning(timber.world)).toBeGreaterThan(1)
    expect(timber.events.of(FIRE_EVENTS.spread).length).toBeGreaterThan(0)

    const concrete = scenario()
    putRoomShell(concrete.world, shell, 'concrete_floor')
    designateRoom(roomDeps(concrete.world, concrete.events), {
      x: 3,
      y: 3,
      width: 6,
      height: 6,
    }, 'dormitory')
    const cold = concrete.world.grid.idx(5, 5)
    expect(tileFlammability(concrete.world, cold, DATA)).toBe(0)
    const lit = igniteTile({
      world: concrete.world,
      tileIndex: cold,
      intensity: 200,
      source: 'manual',
      events: concrete.events,
      tick: 0,
    })
    expect(lit).toBe(false)
    step(concrete.sim, 80)
    expect(countBurning(concrete.world)).toBe(0)
  })

  it('destroys a wooden-floored dormitory when unanswered', () => {
    const run = scenario()
    putRoomShell(run.world, { x: 2, y: 2, width: 8, height: 8 }, 'timber_board')
    designateRoom(roomDeps(run.world, run.events), {
      x: 3,
      y: 3,
      width: 6,
      height: 6,
    }, 'dormitory')
    const bed = placeObject(objectDeps(run.world, run.events), { x: 4, y: 4 }, 'bed')
    expect(bed).toBeDefined()
    // Placement succeeded above.
    const bedEntity = bed!

    igniteTile({
      world: run.world,
      tileIndex: bedEntity.tileIndex,
      intensity: 220,
      source: 'manual',
      events: run.events,
      tick: 0,
    })

    step(run.sim, 400)

    expect(run.events.of(FIRE_EVENTS.objectDestroyed).length).toBeGreaterThan(0)
    expect(run.world.objects.get(bedEntity.id)).toBeUndefined()
    expect(countBurning(run.world) + run.events.of(FIRE_EVENTS.spread).length).toBeGreaterThan(0)
  })
})

describe('damage application', () => {
  it('damages agents and objects on burning tiles', () => {
    const run = scenario()
    putRoomShell(run.world, { x: 2, y: 2, width: 6, height: 6 }, 'timber_board')
    designateRoom(roomDeps(run.world, run.events), {
      x: 3,
      y: 3,
      width: 4,
      height: 4,
    }, 'dormitory')
    const bed = placeObject(objectDeps(run.world, run.events), { x: 4, y: 4 }, 'bed')
    expect(bed).toBeDefined()
    const bedEntity = bed!
    const inmate = placeInmate(run.world, 4, 4)
    const healthBefore = inmate.inmate.health
    const hpBefore = bedEntity.object.hp

    igniteTile({
      world: run.world,
      tileIndex: bedEntity.tileIndex,
      intensity: 255,
      source: 'manual',
      events: run.events,
      tick: 0,
    })
    step(run.sim, 5)

    expect(inmate.inmate.health).toBeLessThan(healthBefore)
    expect(bedEntity.object.hp).toBeLessThan(hpBefore)
    expect(run.events.of(FIRE_EVENTS.agentDamaged).length).toBeGreaterThan(0)
  })

  it('emits smoke that blocks visibility and slows movement', () => {
    const run = scenario()
    putFloor(run.world, 4, 4, 'timber_board')
    const tile = run.world.grid.idx(4, 4)
    igniteTile({
      world: run.world,
      tileIndex: tile,
      intensity: 255,
      source: 'manual',
      events: run.events,
      tick: 0,
    })
    step(run.sim, 20)

    expect(run.world.fire.smokeAt(tile)).toBeGreaterThan(0)
    expect(smokeBlocksVisibility(run.world.fire, tile, DATA)).toBe(true)
    expect(smokeMovementMultiplier(run.world.fire, tile, DATA)).toBeLessThan(1)
  })
})

describe('sprinkler coverage', () => {
  it('contains a fire without firefighter intervention', () => {
    const run = scenario()
    putRoomShell(run.world, { x: 2, y: 2, width: 8, height: 8 }, 'timber_board')
    designateRoom(roomDeps(run.world, run.events), {
      x: 3,
      y: 3,
      width: 6,
      height: 6,
    }, 'dormitory')
    const bed = placeObject(objectDeps(run.world, run.events), { x: 5, y: 5 }, 'bed')
    expect(bed).toBeDefined()
    const bedEntity = bed!
    const sprinkler = placeObject(objectDeps(run.world, run.events), { x: 5, y: 4 }, 'sprinkler')
    expect(sprinkler).toBeDefined()
    expect(sprinkler!.object.hasWater).toBe(true)

    igniteTile({
      world: run.world,
      tileIndex: bedEntity.tileIndex,
      intensity: 120,
      source: 'manual',
      events: run.events,
      tick: 0,
    })

    step(run.sim, 60)

    expect(run.events.of(FIRE_EVENTS.sprinklerActive).length).toBeGreaterThan(0)
    expect(run.world.objects.get(bedEntity.id)).toBeDefined()
    expect(countBurning(run.world)).toBe(0)
    expect(run.events.of(FIRE_EVENTS.extinguished).some((e) => eventFieldIs(e, 'reason', 'sprinkler'))).toBe(
      true,
    )
  })
})

describe('firefighter behaviour', () => {
  it('summons callable firefighters who hose down a blaze', () => {
    const run = scenario()
    putRoomShell(run.world, { x: 2, y: 2, width: 8, height: 8 }, 'timber_board')
    designateRoom(roomDeps(run.world, run.events), {
      x: 3,
      y: 3,
      width: 6,
      height: 6,
    }, 'dormitory')
    const origin = run.world.grid.idx(5, 5)
    igniteTile({
      world: run.world,
      tileIndex: origin,
      intensity: 200,
      source: 'manual',
      events: run.events,
      tick: 0,
    })

    const summoned = summonFirefighters({
      world: run.world,
      count: 2,
      events: run.events,
      tick: 0,
      nearTileIndex: origin,
    })
    expect(summoned.summoned).toHaveLength(2)
    expect(run.events.of(FIRE_EVENTS.firefighterSummoned)).toHaveLength(1)
    const def = DATA.staff.find('firefighter')
    expect(def?.callable).toBe(true)
    expect(def?.capabilities).toContain('fightFire')

    step(run.sim, 40)

    expect(countBurning(run.world)).toBe(0)
    expect(
      run.events.of(FIRE_EVENTS.extinguished).some((e) => eventFieldIs(e, 'reason', 'firefighter')),
    ).toBe(true)
  })
})

describe('ignition sources', () => {
  it('can ignite from lighter contraband', () => {
    const events = new RecordingSink()
    const world = createInmateWorld({ size: 16, data: DATA, continuousIntake: false })
    putFloor(world, 4, 4, 'timber_board')
    const inmate = placeInmate(world, 4, 4)
    giveLighter(inmate)

    const sim = new Simulation({
      seed: 7,
      world,
      systems: [createFireSystem({ data: DATA })],
      events,
    })
    step(sim, 10_000)

    expect(events.of(FIRE_EVENTS.ignited).some((e) => eventFieldIs(e, 'source', 'lighter'))).toBe(true)
  })

  it('can ignite from an overloaded electrical branch', () => {
    const run = scenario()
    putFloor(run.world, 4, 4, 'timber_board')
    const tile = run.world.grid.idx(4, 4)
    run.world.grid.setAt('powerGridId', tile, 3)
    run.world.fire.markBranchOverloaded(3)

    step(run.sim, 8_000)

    expect(run.events.of(FIRE_EVENTS.ignited).some((e) => eventFieldIs(e, 'source', 'electrical'))).toBe(
      true,
    )
  })
})
