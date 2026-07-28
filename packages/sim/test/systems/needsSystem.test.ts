/**
 * T2.5 — Needs system: fill/discharge maths, critical behaviours, index stability.
 */

import { describe, expect, it } from 'vitest'

import { TICKS_PER_DAY, TICKS_PER_MINUTE } from '../../src/core/clock'
import { Simulation } from '../../src/core/simulation'
import type { SimulationEvent } from '../../src/core/simulation'
import { Rng } from '../../src/core/rng'
import { loadGameData } from '../../src/data/loader'
import { createInmateShell, generateInmate } from '../../src/entities/inmate'
import type { InmateEntity } from '../../src/entities/inmate'
import {
  NEED_MAX,
  NEEDS_EVENTS,
  NeedIndex,
  applyNeedDischarge,
  applyNeedFills,
  clampNeed,
  computeNeedFill,
} from '../../src/entities/needs'
import type { NeedFillContext } from '../../src/entities/needs'
import { placeObject } from '../../src/entities/objects'
import type { ObjectDeps } from '../../src/entities/objects'
import type { InmateWorld } from '../../src/systems/intakeSystem';
import { createInmateWorld } from '../../src/systems/intakeSystem'
import {
  NEEDS_SYSTEM_NAME,
  NEEDS_SYSTEM_PERIOD,
  createNeedsSystem,
} from '../../src/systems/needsSystem'
import { refreshPassability } from '../../src/world/construction'
import type { Rect } from '../../src/world/construction'
import { initialLockState } from '../../src/world/doors'
import { designateRoom } from '../../src/world/roomDetection'
import type { RoomDeps } from '../../src/world/roomDetection'

const DATA = loadGameData()
const INDEX = NeedIndex.fromData(DATA)
const SEED = 0xb10c_2005

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

function baseFillCtx(overrides: Partial<NeedFillContext> = {}): NeedFillContext {
  return {
    lockedUp: false,
    dangerLevel: 0,
    meanRoomDirt: 0,
    nearbyInmateCount: 0,
    temperatureC: 18,
    traits: [],
    addictions: [],
    ...overrides,
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

function spawnInmate(
  world: InmateWorld,
  events: RecordingSink,
  x: number,
  y: number,
  overrides: {
    readonly traits?: readonly string[]
    readonly addictions?: InmateEntity['inmate']['addictions']
  } = {},
): InmateEntity {
  const component = generateInmate({
    data: world.data,
    rng: new Rng(SEED).stream('test'),
    category: 'medium',
  })
  // Replace trait / addiction rolls when a critical-behaviour test needs them.
  const inmate = {
    ...component,
    traits: overrides.traits !== undefined ? [...overrides.traits] : [...component.traits],
    addictions:
      overrides.addictions !== undefined ? [...overrides.addictions] : [...component.addictions],
    status: [...component.status],
    needs: new Float32Array(component.needs),
  }
  const id = world.inmates.allocateId()
  const entity = createInmateShell({
    id,
    data: world.data,
    inmate,
    tx: x,
    ty: y,
    x,
    y,
  })
  world.inmates.add(entity)
  void events
  return entity
}

function stepMinutes(sim: Simulation, minutes: number): void {
  for (let i = 0; i < minutes * TICKS_PER_MINUTE; i += 1) sim.step()
}

function harness(): {
  world: InmateWorld
  events: RecordingSink
  sim: Simulation
  objectDeps: () => ObjectDeps
} {
  const events = new RecordingSink()
  const world = createInmateWorld({ size: 24, data: DATA, continuousIntake: false })
  // Comfortable ambient until the temperature system exists (T5.5).
  world.grid.fill('temperature', 18)
  const sim = new Simulation({
    seed: SEED,
    world,
    systems: [createNeedsSystem({ data: DATA, index: INDEX })],
    events,
  })
  return {
    world,
    events,
    sim,
    objectDeps: () => ({ world, data: DATA, events, tick: sim.clock.tick }),
  }
}

/* -------------------------------------------------------------------------- */
/* Index stability                                                             */
/* -------------------------------------------------------------------------- */

describe('NeedIndex', () => {
  it('mirrors needs.json file order', () => {
    expect(INDEX.indexOf('bladder')).toBe(0)
    expect(INDEX.idAt(0)).toBe('bladder')
    expect(INDEX.indexOf('luxury')).toBe(INDEX.size - 1)
    expect(INDEX.size).toBe(DATA.needs.size)
  })

  it('throws when a saved order is reordered rather than silently remapping', () => {
    const shuffled = [...INDEX.order]
    const first = shuffled[0]
    const last = shuffled[shuffled.length - 1]
    if (first === undefined || last === undefined) throw new Error('empty need order')
    shuffled[0] = last
    shuffled[shuffled.length - 1] = first

    expect(() => INDEX.assertCompatible(shuffled)).toThrow(/need order mismatch at index 0/)
  })

  it('throws on length mismatch', () => {
    expect(() => INDEX.assertCompatible(INDEX.order.slice(0, 3))).toThrow(
      /need order length mismatch/,
    )
  })

  it('throws when a Float32Array length does not match the index', () => {
    const values = new Float32Array(3)
    expect(() => INDEX.get(values, 'bladder')).toThrow(/need array length mismatch/)
  })
})

/* -------------------------------------------------------------------------- */
/* Fill / discharge maths                                                      */
/* -------------------------------------------------------------------------- */

describe('need fill and discharge maths', () => {
  it('adds fillPerMinute for time-driven needs', () => {
    const bladder = DATA.needs.get('bladder')
    const result = computeNeedFill(bladder, DATA.balance.needs, baseFillCtx())
    expect(result).toEqual({ mode: 'add', delta: bladder.fillPerMinute })
  })

  it('triples freedom fill while locked up', () => {
    const freedom = DATA.needs.get('freedom')
    const free = computeNeedFill(freedom, DATA.balance.needs, baseFillCtx({ lockedUp: false }))
    const locked = computeNeedFill(freedom, DATA.balance.needs, baseFillCtx({ lockedUp: true }))
    expect(free).toEqual({ mode: 'add', delta: freedom.fillPerMinute })
    expect(locked).toEqual({
      mode: 'add',
      delta: freedom.fillPerMinute * DATA.balance.needs.freedomLockedUpMultiplier,
    })
  })

  it('drives environment from room dirt and privacy from nearby count', () => {
    const environment = DATA.needs.get('environment')
    const privacy = DATA.needs.get('privacy')
    const dirt = computeNeedFill(
      environment,
      DATA.balance.needs,
      baseFillCtx({ meanRoomDirt: 100 }),
    )
    const crowd = computeNeedFill(
      privacy,
      DATA.balance.needs,
      baseFillCtx({ nearbyInmateCount: 4 }),
    )
    expect(dirt).toEqual({
      mode: 'set',
      value: clampNeed(100 * DATA.balance.needs.environmentDirtScale),
    })
    expect(crowd).toEqual({
      mode: 'set',
      value: clampNeed(4 * DATA.balance.needs.privacyPerNeighbour),
    })
  })

  it('drives safety from danger and warmth from cold tiles', () => {
    const safety = DATA.needs.get('safety')
    const warmth = DATA.needs.get('warmth')
    expect(computeNeedFill(safety, DATA.balance.needs, baseFillCtx({ dangerLevel: 70 }))).toEqual({
      mode: 'set',
      value: 70,
    })
    expect(
      computeNeedFill(warmth, DATA.balance.needs, baseFillCtx({ temperatureC: 2 })),
    ).toEqual({
      mode: 'set',
      value: clampNeed(
        (DATA.balance.needs.warmthColdThresholdC - 2) * DATA.balance.needs.warmthPerDegreeBelow,
      ),
    })
    expect(
      computeNeedFill(warmth, DATA.balance.needs, baseFillCtx({ temperatureC: 18 })),
    ).toEqual({ mode: 'set', value: 0 })
  })

  it('skips trait-gated needs without the trait, and scales addiction fill', () => {
    const literacy = DATA.needs.get('literacy')
    const narcotics = DATA.needs.get('narcotics')
    expect(computeNeedFill(literacy, DATA.balance.needs, baseFillCtx())).toEqual({ mode: 'skip' })
    expect(
      computeNeedFill(literacy, DATA.balance.needs, baseFillCtx({ traits: ['clever'] })),
    ).toEqual({ mode: 'add', delta: literacy.fillPerMinute })
    expect(
      computeNeedFill(
        narcotics,
        DATA.balance.needs,
        baseFillCtx({
          traits: ['dependent'],
          addictions: [{ substance: 'narcotics', strength: 0.5 }],
        }),
      ),
    ).toEqual({ mode: 'add', delta: narcotics.fillPerMinute * 0.5 })
  })

  it('applyNeedFills accumulates and clamps at 100', () => {
    const values = INDEX.allocate()
    INDEX.set(values, 'bladder', 99.9)
    applyNeedFills(values, INDEX, DATA.balance.needs, baseFillCtx())
    expect(INDEX.get(values, 'bladder')).toBe(NEED_MAX)
  })

  it('applyNeedDischarge subtracts decayOnUse per served need', () => {
    const values = INDEX.allocate()
    INDEX.set(values, 'bladder', 80)
    INDEX.set(values, 'food', 40)
    applyNeedDischarge(values, INDEX, [{ need: 'bladder' }, { need: 'food' }])
    expect(INDEX.get(values, 'bladder')).toBe(clampNeed(80 - DATA.needs.get('bladder').decayOnUse))
    expect(INDEX.get(values, 'food')).toBe(clampNeed(40 - DATA.needs.get('food').decayOnUse))
  })
})

/* -------------------------------------------------------------------------- */
/* System + critical behaviours                                                */
/* -------------------------------------------------------------------------- */

describe('needsSystem', () => {
  it('declares the PRD minute period', () => {
    const system = createNeedsSystem({ data: DATA })
    expect(system.name).toBe(NEEDS_SYSTEM_NAME)
    expect(system.period).toBe(NEEDS_SYSTEM_PERIOD)
    expect(NEEDS_SYSTEM_PERIOD).toBe(TICKS_PER_MINUTE)
  })

  it('reaches critical bladder without a toilet and urinates, adding dirt', () => {
    const { world, events, sim } = harness()
    const shell = { x: 2, y: 2, width: 8, height: 8 }
    putRoomShell(world, shell)
    const interior = interiorOf(shell)
    designateRoom(
      { world, data: DATA, events, tick: 0 } satisfies RoomDeps,
      interior,
      'holding_pen',
    )
    // Bench only — no toilet, so bladder has nowhere to discharge.
    placeObject(
      { world, data: DATA, events, tick: 0 },
      { x: interior.x, y: interior.y },
      'bench',
      0,
    )

    const entity = spawnInmate(world, events, interior.x + 1, interior.y + 1)
    const bladder = DATA.needs.get('bladder')
    const minutesToCritical = Math.ceil(bladder.thresholds.critical / bladder.fillPerMinute)

    stepMinutes(sim, minutesToCritical)

    const criticals = events.of(NEEDS_EVENTS.critical).filter((event) => {
      const data = event.data as { needId?: string; behaviour?: string }
      return data.needId === 'bladder' && data.behaviour === 'urinate'
    })
    expect(criticals.length).toBe(1)

    const tileIndex = entity.ty * world.grid.size + entity.tx
    expect(world.grid.dirt[tileIndex]).toBe(DATA.balance.logistics.dirt.perUrination)
    expect(INDEX.get(entity.inmate.needs, 'bladder')).toBe(0)
  })

  it('never reaches critical food over 30 days while continuously eating', () => {
    const { world, events, sim } = harness()
    const shell = { x: 2, y: 2, width: 8, height: 8 }
    putRoomShell(world, shell)
    const interior = interiorOf(shell)
    designateRoom({ world, data: DATA, events, tick: 0 }, interior, 'mess_hall')
    const table = placeObject(
      { world, data: DATA, events, tick: 0 },
      { x: interior.x, y: interior.y },
      'serving_counter',
      0,
    )
    if (table === undefined) throw new Error('serving_counter missing')

    const entity = spawnInmate(world, events, interior.x + 2, interior.y + 2)
    const claim = world.needsRuntime.beginUsing(
      entity.id,
      table,
      DATA.objects.get('serving_counter').servesNeeds,
    )
    expect(claim).toBeUndefined()

    // 30 in-game days at one needs pass per minute.
    const days = 30
    stepMinutes(sim, days * (TICKS_PER_DAY / TICKS_PER_MINUTE))

    const foodCriticals = events.of(NEEDS_EVENTS.critical).filter((event) => {
      const data = event.data as { needId?: string }
      return data.needId === 'food'
    })
    expect(foodCriticals).toHaveLength(0)
    expect(INDEX.get(entity.inmate.needs, 'food')).toBeLessThan(
      DATA.needs.get('food').thresholds.critical,
    )
  })

  it('fires starve on food critical and ticks the starvation timer', () => {
    const { world, events, sim } = harness()
    const entity = spawnInmate(world, events, 4, 4)
    INDEX.set(entity.inmate.needs, 'food', DATA.needs.get('food').thresholds.critical - 0.01)

    stepMinutes(sim, 1)
    const crossing = events.of(NEEDS_EVENTS.critical).find((event) => {
      const data = event.data as { needId?: string; behaviour?: string }
      return data.needId === 'food' && data.behaviour === 'starve'
    })
    expect(crossing).toBeDefined()

    const healthBefore = entity.inmate.health
    stepMinutes(sim, 5)
    const state = world.needsRuntime.stateOf(entity.id)
    expect(state.starveMinutes).toBeGreaterThanOrEqual(5)
    expect(entity.inmate.health).toBeLessThan(healthBefore)
  })

  it('fires seekWeapon when safety crosses critical', () => {
    const { world, events, sim } = harness()
    const entity = spawnInmate(world, events, 4, 4)
    world.dangerLevel = DATA.needs.get('safety').thresholds.critical

    stepMinutes(sim, 1)

    const event = events.of(NEEDS_EVENTS.critical).find((e) => {
      const data = e.data as { needId?: string; behaviour?: string }
      return data.needId === 'safety' && data.behaviour === 'seekWeapon'
    })
    expect(event).toBeDefined()
    expect(world.needsRuntime.stateOf(entity.id).seekingWeapon).toBe(true)
  })

  it('fires digTunnel when freedom crosses critical while locked up', () => {
    const { world, events, sim } = harness()
    const entity = spawnInmate(world, events, 4, 4)
    const freedom = DATA.needs.get('freedom')
    INDEX.set(entity.inmate.needs, 'freedom', freedom.thresholds.critical - 0.01)
    world.needsRuntime.stateOf(entity.id).lockedUp = true

    stepMinutes(sim, 1)

    const event = events.of(NEEDS_EVENTS.critical).find((e) => {
      const data = e.data as { needId?: string; behaviour?: string }
      return data.needId === 'freedom' && data.behaviour === 'digTunnel'
    })
    expect(event).toBeDefined()
    expect(world.needsRuntime.stateOf(entity.id).diggingTunnel).toBe(true)
  })

  it('fires withdrawal for narcotics and alcohol', () => {
    const { world, events, sim } = harness()
    const entity = spawnInmate(world, events, 4, 4, {
      traits: ['dependent'],
      addictions: [
        { substance: 'narcotics', strength: 1 },
        { substance: 'alcohol', strength: 1 },
      ],
    })
    INDEX.set(entity.inmate.needs, 'narcotics', DATA.needs.get('narcotics').thresholds.critical)
    INDEX.set(entity.inmate.needs, 'alcohol', DATA.needs.get('alcohol').thresholds.critical)

    stepMinutes(sim, 1)

    const behaviours = events.of(NEEDS_EVENTS.critical).map((event) => {
      const data = event.data as { needId: string; behaviour: string }
      return `${data.needId}:${data.behaviour}`
    })
    expect(behaviours).toEqual(
      expect.arrayContaining(['narcotics:withdrawal', 'alcohol:withdrawal']),
    )
    expect(entity.inmate.status).toContain('withdrawal')
  })

  it('fires exposure when warmth crosses critical and damages health', () => {
    const { world, events, sim } = harness()
    const entity = spawnInmate(world, events, 4, 4)
    const tile = entity.ty * world.grid.size + entity.tx
    // Cold enough that warmthPerDegreeBelow pushes past critical in one set.
    world.grid.setAt('temperature', tile, -20)

    stepMinutes(sim, 1)

    const event = events.of(NEEDS_EVENTS.critical).find((e) => {
      const data = e.data as { needId?: string; behaviour?: string }
      return data.needId === 'warmth' && data.behaviour === 'exposure'
    })
    expect(event).toBeDefined()
    expect(entity.inmate.status).toContain('exposure')

    const healthAfterCrossing = entity.inmate.health
    stepMinutes(sim, 3)
    expect(entity.inmate.health).toBeLessThan(healthAfterCrossing)
  })

  it('enforces concurrentUsers when claiming an object', () => {
    const { world, events } = harness()
    const shell = { x: 2, y: 2, width: 6, height: 6 }
    putRoomShell(world, shell)
    const interior = interiorOf(shell)
    const toilet = placeObject(
      { world, data: DATA, events, tick: 0 },
      { x: interior.x, y: interior.y },
      'toilet',
      0,
    )
    if (toilet === undefined) throw new Error('toilet missing')
    const serves = DATA.objects.get('toilet').servesNeeds

    const a = spawnInmate(world, events, interior.x + 1, interior.y)
    const b = spawnInmate(world, events, interior.x + 2, interior.y)

    expect(world.needsRuntime.beginUsing(a.id, toilet, serves)).toBeUndefined()
    expect(world.needsRuntime.beginUsing(b.id, toilet, serves)).toBe('object-busy')
    expect(world.needsRuntime.usersOf(toilet.id)).toBe(1)
  })
})
