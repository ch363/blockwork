/**
 * T5.5 — Utilities: power connectivity & shedding, water flow, temperature,
 * auto-route, electrical ignition via overload.
 */

import { describe, expect, it } from 'vitest'

import { Simulation } from '../../src/core/simulation'
import type { SimulationEvent } from '../../src/core/simulation'
import { loadGameData } from '../../src/data/loader'
import type { GameData } from '../../src/data/loader'
import { Registry } from '../../src/data/loader'
import type { ObjectDef } from '../../src/data/schemas'
import { placeObject, suppliesPower, suppliesWater } from '../../src/entities/objects'
import type { ObjectDeps } from '../../src/entities/objects'
import { createInmateWorld } from '../../src/systems/intakeSystem'
import type { InmateWorld } from '../../src/systems/intakeSystem'
import {
  FIRE_EVENTS,
  createFireSystem,
} from '../../src/systems/fireSystem'
import {
  UTILITIES_EVENTS,
  UTILITIES_SYSTEM_PERIOD,
  autoRouteUtility,
  createUtilitiesSystem,
  outdoorTemperatureC,
  setCableTile,
  setPipeTile,
  utilityPathToLines,
  waterUseMultiplier,
} from '../../src/systems/utilitiesSystem'
import { createObjectSystem } from '../../src/systems/objectSystem'
import { refreshPassability } from '../../src/world/construction'
import { TRACE_KINDS } from '../../src/trace/causalEvent'

const RAW = loadGameData()

/** Utilities tests keep the feature flag on. */
const DATA: GameData = {
  ...RAW,
  balance: {
    ...RAW.balance,
    utilities: { ...RAW.balance.utilities, utilitiesEnabled: true },
    construction: { ...RAW.balance.construction, stubMaterialDelivery: true },
  },
}

class RecordingSink {
  readonly events: SimulationEvent[] = []
  emit(event: SimulationEvent): void {
    this.events.push(event)
  }
  of(kind: string): SimulationEvent[] {
    return this.events.filter((event) => event.kind === kind)
  }
}

function objectDeps(world: InmateWorld, events: RecordingSink): ObjectDeps {
  return { world, data: world.data, events, tick: 0 }
}

function putFloor(world: InmateWorld, x: number, y: number): void {
  const index = world.grid.idx(x, y)
  world.grid.setAt('floorMaterial', index, world.materials.indexOf('concrete_floor'))
  world.grid.setAt('outdoors', index, 0)
  world.grid.setAt('owned', index, 1)
  refreshPassability(world, world.data, index)
}

function cable(world: InmateWorld, x: number, y: number): void {
  putFloor(world, x, y)
  setCableTile(world, { x, y }, true)
}

function pipe(world: InmateWorld, x: number, y: number): void {
  putFloor(world, x, y)
  setPipeTile(world, { x, y }, true)
}

function withObject(
  base: GameData,
  patch: Partial<ObjectDef> & { readonly id: string },
): GameData {
  const existing = base.objects.find(patch.id)
  if (existing === undefined) throw new Error(`missing object ${patch.id}`)
  const next: ObjectDef = { ...existing, ...patch }
  const all = base.objects.all.map((def) => (def.id === patch.id ? next : def))
  return { ...base, objects: new Registry(all) }
}

function scenario(options: {
  readonly data?: GameData
  readonly withFire?: boolean
} = {}): {
  readonly world: InmateWorld
  readonly sim: Simulation
  readonly events: RecordingSink
  readonly data: GameData
} {
  const data = options.data ?? DATA
  const events = new RecordingSink()
  const world = createInmateWorld({ size: 24, data, continuousIntake: false })
  const systems = [
    createUtilitiesSystem({ data }),
    createObjectSystem({ data }),
    ...(options.withFire === true ? [createFireSystem({ data })] : []),
  ]
  const sim = new Simulation({
    seed: 0xb10c_5505,
    world,
    systems,
    events,
  })
  return { world, sim, events, data }
}

function step(sim: Simulation, ticks: number): void {
  for (let i = 0; i < ticks; i += 1) sim.step()
}

describe('utilitiesSystem — connectivity', () => {
  it('labels connected cable tiles with the same powerGridId', () => {
    const run = scenario()
    cable(run.world, 4, 4)
    cable(run.world, 5, 4)
    cable(run.world, 6, 4)
    cable(run.world, 8, 8) // disconnected

    placeObject(objectDeps(run.world, run.events), { x: 4, y: 4 }, 'generator')
    step(run.sim, UTILITIES_SYSTEM_PERIOD)

    const a = run.world.grid.get('powerGridId', 4, 4)
    const b = run.world.grid.get('powerGridId', 5, 4)
    const c = run.world.grid.get('powerGridId', 6, 4)
    const d = run.world.grid.get('powerGridId', 8, 8)
    expect(a).toBeGreaterThan(0)
    expect(b).toBe(a)
    expect(c).toBe(a)
    expect(d).not.toBe(a)
    expect(d).toBeGreaterThan(0)
  })

  it('supplies a powered object once a cable reaches a generator', () => {
    const run = scenario()
    // Generator is 3x3 at (3,3); cable run to a cooker beyond it.
    for (let x = 3; x <= 8; x += 1) cable(run.world, x, 4)
    placeObject(objectDeps(run.world, run.events), { x: 3, y: 3 }, 'generator')
    const cooker = placeObject(objectDeps(run.world, run.events), { x: 8, y: 4 }, 'cooker')
    expect(cooker).toBeDefined()

    step(run.sim, UTILITIES_SYSTEM_PERIOD)

    expect(cooker!.object.hasPower).toBe(true)
    expect(
      suppliesPower(run.world, run.data.objects.get('cooker'), cooker!.tileIndex),
    ).toBe(true)
  })
})

describe('utilitiesSystem — shedding', () => {
  it('sheds comfort before lifeSafety and emits utilities.brownout', () => {
    // Tiny generator so comfort + production + security cannot all fit.
    const data = withObject(
      withObject(DATA, {
        id: 'generator',
        outputWatts: 500,
      }),
      {
        id: 'ceiling_light',
        needsPower: 400,
        powerPriority: 'comfort',
      },
    )
    const patched = withObject(data, {
      id: 'water_pump',
      needsPower: 400,
      powerPriority: 'lifeSafety',
      outputWatts: 0,
      flowRate: 0,
    })

    const run = scenario({ data: patched })
    for (let x = 2; x <= 10; x += 1) cable(run.world, x, 5)
    placeObject(objectDeps(run.world, run.events), { x: 2, y: 4 }, 'generator')
    const light = placeObject(objectDeps(run.world, run.events), { x: 6, y: 5 }, 'ceiling_light')
    const pump = placeObject(objectDeps(run.world, run.events), { x: 8, y: 5 }, 'water_pump')
    expect(light).toBeDefined()
    expect(pump).toBeDefined()

    step(run.sim, UTILITIES_SYSTEM_PERIOD)

    expect(light!.object.hasPower).toBe(false)
    expect(pump!.object.hasPower).toBe(true)

    const brownouts = run.events.of(UTILITIES_EVENTS.brownout)
    expect(brownouts.length).toBeGreaterThan(0)
    expect(brownouts[0]?.kind).toBe(TRACE_KINDS.utilitiesBrownout)
    const payload = brownouts[0]?.data as {
      shortfallWatts: number
      priority: string
      capacityWatts: number
    }
    expect(payload.shortfallWatts).toBeGreaterThan(0)
    expect(payload.capacityWatts).toBe(500)
    expect(payload.priority).toBe('comfort')
    expect(run.world.fire.overloadedBranches.size).toBeGreaterThan(0)
  })
})

describe('utilitiesSystem — water', () => {
  it('connects fixtures to a pump and slows use when flow is short', () => {
    const data = withObject(DATA, {
      id: 'water_pump',
      flowRate: 1,
      needsPower: 0,
    })
    const run = scenario({ data })
    for (let x = 3; x <= 8; x += 1) pipe(run.world, x, 4)
    placeObject(objectDeps(run.world, run.events), { x: 3, y: 4 }, 'water_pump')
    const toiletA = placeObject(objectDeps(run.world, run.events), { x: 6, y: 4 }, 'toilet')
    const toiletB = placeObject(objectDeps(run.world, run.events), { x: 8, y: 4 }, 'toilet')
    expect(toiletA).toBeDefined()
    expect(toiletB).toBeDefined()

    step(run.sim, UTILITIES_SYSTEM_PERIOD)

    expect(toiletA!.object.hasWater).toBe(true)
    expect(toiletB!.object.hasWater).toBe(true)
    expect(suppliesWater(run.world, run.data.objects.get('toilet'), toiletA!.tileIndex)).toBe(
      true,
    )

    const mult = waterUseMultiplier(run.world, toiletA!.tileIndex)
    // 1 flow / (2 fixtures * 1 unit) = 0.5
    expect(mult).toBeCloseTo(0.5)
  })
})

describe('utilitiesSystem — temperature', () => {
  it('diffuses heat from sources and follows the outdoor day cycle', () => {
    const run = scenario()
    for (let y = 3; y <= 7; y += 1) {
      for (let x = 3; x <= 7; x += 1) putFloor(run.world, x, y)
    }
    // Cooker is a floor heat source (radiators are wall-only).
    const heater = placeObject(objectDeps(run.world, run.events), { x: 5, y: 5 }, 'cooker')
    expect(heater).toBeDefined()

    const noon = outdoorTemperatureC(
      12 * 600,
      DATA.balance.utilities.outdoorTemperatureC.min,
      DATA.balance.utilities.outdoorTemperatureC.max,
    )
    expect(noon).toBeCloseTo(DATA.balance.utilities.outdoorTemperatureC.max)

    const midnight = outdoorTemperatureC(
      0,
      DATA.balance.utilities.outdoorTemperatureC.min,
      DATA.balance.utilities.outdoorTemperatureC.max,
    )
    expect(midnight).toBeCloseTo(DATA.balance.utilities.outdoorTemperatureC.min)

    step(run.sim, DATA.balance.utilities.temperatureDiffusionTicks)

    const heated = run.world.grid.get('temperature', 5, 5)
    const far = run.world.grid.get('temperature', 3, 3)
    expect(heated).toBeGreaterThan(far)
    expect(heated).toBeGreaterThan(DATA.balance.utilities.indoorBaselineC)
  })
})

describe('utilitiesSystem — the season cycle (T5.5)', () => {
  it('rides the daily cycle on a slower seasonal one', () => {
    const { min, max } = DATA.balance.utilities.outdoorTemperatureC
    const season = DATA.balance.utilities.season
    const noon = 12 * 600

    // Without a season the daily cycle is unchanged.
    expect(outdoorTemperatureC(noon, min, max)).toBeCloseTo(max, 6)

    // Coldest at the start of the cycle, warmest half a cycle later.
    const winterNoon = outdoorTemperatureC(noon, min, max, season)
    const summerNoon = outdoorTemperatureC(
      noon + season.lengthDays * 24 * 600,
      min,
      max,
      season,
    )
    expect(summerNoon - winterNoon).toBeCloseTo(2 * season.swingC, 6)

    // And it comes back round: two season lengths on is winter again.
    const nextWinter = outdoorTemperatureC(
      noon + 2 * season.lengthDays * 24 * 600,
      min,
      max,
      season,
    )
    expect(nextWinter).toBeCloseTo(winterNoon, 6)
  })
})

describe('utilitiesSystem — auto-route', () => {
  it('finds a shortest path from an object tile to the nearest live cable', () => {
    const run = scenario()
    for (let x = 2; x <= 5; x += 1) cable(run.world, x, 3)
    placeObject(objectDeps(run.world, run.events), { x: 2, y: 2 }, 'generator')
    step(run.sim, UTILITIES_SYSTEM_PERIOD)

    putFloor(run.world, 8, 3)
    putFloor(run.world, 7, 3)
    putFloor(run.world, 6, 3)
    const from = run.world.grid.idx(8, 3)
    const route = autoRouteUtility(run.world, from, 'power')
    expect(route).toBeDefined()
    expect(route!.path[0]).toBe(from)
    expect(route!.costTiles).toBeGreaterThan(0)
    // Ends on a live cable node.
    const end = route!.path[route!.path.length - 1]!
    expect(run.world.power.hasCableAt(end)).toBe(true)
    expect(run.world.grid.powerGridId[end]).toBeGreaterThan(0)
  })

  it('collapses a path into axis-aligned paint strokes', () => {
    const size = 16
    // L-shape: (2,2)→(5,2)→(5,4)
    const path = [
      2 + 2 * size,
      3 + 2 * size,
      4 + 2 * size,
      5 + 2 * size,
      5 + 3 * size,
      5 + 4 * size,
    ]
    const lines = utilityPathToLines(path, size)
    expect(lines).toEqual([
      { x1: 2, y1: 2, x2: 5, y2: 2 },
      { x1: 5, y1: 2, x2: 5, y2: 4 },
    ])
    expect(utilityPathToLines([10], size)).toEqual([])
  })
})

describe('utilitiesSystem — electrical ignition', () => {
  it('marks shed branches overloaded so fire can ignite electrically', () => {
    const data = withObject(DATA, { id: 'generator', outputWatts: 50 })
    const run = scenario({ data, withFire: true })
    for (let x = 3; x <= 7; x += 1) {
      cable(run.world, x, 4)
      // Flammable floor for ignition.
      run.world.grid.setAt(
        'floorMaterial',
        run.world.grid.idx(x, 4),
        run.world.materials.indexOf('timber_board'),
      )
    }
    placeObject(objectDeps(run.world, run.events), { x: 3, y: 3 }, 'generator')
    placeObject(objectDeps(run.world, run.events), { x: 6, y: 4 }, 'cooker')

    step(run.sim, UTILITIES_SYSTEM_PERIOD)
    expect(run.world.fire.overloadedBranches.size).toBeGreaterThan(0)

    // Force many fire ticks so electricalFaultChance can land.
    step(run.sim, 20_000)
    expect(
      run.events.of(FIRE_EVENTS.ignited).some((e) => {
        const d = e.data
        if (d === null || typeof d !== 'object' || Array.isArray(d)) return false
        return (d as { readonly source?: string }).source === 'electrical'
      }),
    ).toBe(true)
  })
})
