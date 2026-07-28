/**
 * T4.3 — search, detection and Standing Orders.
 */

import { describe, expect, it } from 'vitest'

import { Rng } from '../../src/core/rng'
import type { SimulationEvent } from '../../src/core/simulation'
import { loadGameData } from '../../src/data/loader'
import { NeedIndex } from '../../src/entities/needs'
import { createInmateShell, generateInmate } from '../../src/entities/inmate'
import { createInmateWorld } from '../../src/systems/intakeSystem'
import type { InmateWorld } from '../../src/systems/intakeSystem'
import {
  MISCONDUCT_KINDS,
  SEARCH_EVENTS,
  applyStandingOrder,
  applyStandingOrderForMisconduct,
  compoundDetectionChance,
  createStandingOrdersPolicy,
  detectionChance,
  performSearch,
  searchMoodCost,
} from '../../src/systems/searchSystem'

const DATA = loadGameData()
const INDEX = NeedIndex.fromData(DATA)
const SEED = 0xb10c_4003
const SEARCH = DATA.balance.contraband.search

class RecordingSink {
  readonly events: SimulationEvent[] = []
  emit(event: SimulationEvent): void {
    this.events.push(event)
  }
  of(kind: string): SimulationEvent[] {
    return this.events.filter((event) => event.kind === kind)
  }
}

function makeWorld(): { world: InmateWorld; events: RecordingSink } {
  const events = new RecordingSink()
  const world = createInmateWorld({ size: 32, data: DATA, continuousIntake: false })
  return { world, events }
}

function addInmate(world: InmateWorld, tx = 2, ty = 2) {
  const rng = new Rng(SEED)
  const component = generateInmate({ data: DATA, rng: rng.stream('intake'), category: 'minimum' })
  const id = world.inmates.allocateId()
  const entity = createInmateShell({ id, data: DATA, inmate: component, tx, ty })
  world.inmates.add(entity)
  return entity
}

describe('detection probability under morale variation (T4.3)', () => {
  it('raises manual / metal / dog chances as morale rises', () => {
    const manualLow = detectionChance(5, SEARCH.manual)
    const manualHigh = detectionChance(95, SEARCH.manual)
    expect(manualHigh).toBeGreaterThan(manualLow)
    expect(manualHigh - manualLow).toBeGreaterThan(0.3)

    const metal = DATA.balance.contraband.metalDetector
    expect(detectionChance(100, metal)).toBeCloseTo(metal.base + metal.moraleScale, 5)
    expect(detectionChance(0, metal)).toBeCloseTo(metal.base, 5)

    const dog = DATA.balance.contraband.dog
    expect(detectionChance(80, dog)).toBeGreaterThan(detectionChance(10, dog))
  })

  it('compounds intake detection so 4 officers nearly always find goods', () => {
    const single = detectionChance(90, SEARCH.intake)
    const withFour = compoundDetectionChance(single, SEARCH.intakeNearPerfectOfficerCount)
    expect(withFour).toBeGreaterThan(0.99)

    const withZero = compoundDetectionChance(single, 0)
    expect(withZero).toBe(0)
  })

  it('finds more carried items at high morale than low on the same seed', () => {
    const run = (morale: number): number => {
      const { world, events } = makeWorld()
      world.morale.value = morale
      const inmate = addInmate(world)
      for (let i = 0; i < 20; i += 1) {
        world.contraband.giveCarried(inmate.inmate, inmate.id, 'cigarettes')
      }
      const rng = new Rng(SEED + 7)
      const result = performSearch({
        world,
        data: DATA,
        rng: rng.stream('search'),
        events,
        tick: 0,
        kind: 'individual',
        inmateId: inmate.id,
        needIndex: INDEX,
      })
      return result.found.length
    }

    expect(run(95)).toBeGreaterThan(run(5))
  })
})

describe('standing order application on each misconduct type (T4.3)', () => {
  it('loads defaults for every misconduct kind from balance data', () => {
    const policy = createStandingOrdersPolicy(DATA)
    for (const kind of MISCONDUCT_KINDS) {
      const order = applyStandingOrder(policy, kind)
      const expected = DATA.balance.contraband.standingOrders.defaults[kind]
      expect(expected).toBeDefined()
      expect(order.punishment).toBe(expected?.punishment)
      expect(order.durationHours).toBe(expected?.durationHours)
      expect(order.search).toBe(expected?.search)
    }
  })

  it('applies each misconduct type and queues search when configured', () => {
    for (const kind of MISCONDUCT_KINDS) {
      const { world, events } = makeWorld()
      const inmate = addInmate(world)
      world.contraband.giveCarried(inmate.inmate, inmate.id, 'lighter')
      world.morale.value = 90
      const rng = new Rng(SEED + kind.length)

      const { order, search } = applyStandingOrderForMisconduct({
        world,
        data: DATA,
        kind,
        inmateId: inmate.id,
        events,
        tick: 12,
        rng: rng.stream('search'),
        needIndex: INDEX,
      })

      expect(events.of(SEARCH_EVENTS.standingOrderApplied)).toHaveLength(1)
      const applied = events.of(SEARCH_EVENTS.standingOrderApplied)[0]
      expect(applied?.data).toMatchObject({
        misconduct: kind,
        punishment: order.punishment,
        search: order.search,
      })

      if (order.search) {
        expect(search).not.toBeNull()
        expect(events.of(SEARCH_EVENTS.performed).length).toBeGreaterThan(0)
      } else {
        expect(search).toBeNull()
        expect(events.of(SEARCH_EVENTS.performed)).toHaveLength(0)
      }
    }
  })
})

describe('mood cost accounting (T4.3)', () => {
  it('applies a small individual cost and a large shakedown cost', () => {
    expect(searchMoodCost('individual', SEARCH)).toBe(SEARCH.moodCost.individual)
    expect(searchMoodCost('shakedown', SEARCH)).toBe(SEARCH.moodCost.shakedown)
    expect(SEARCH.moodCost.shakedown).toBeGreaterThan(SEARCH.moodCost.individual * 3)

    const { world, events } = makeWorld()
    const a = addInmate(world, 3, 3)
    const b = addInmate(world, 4, 4)
    INDEX.set(a.inmate.needs, 'freedom', 10)
    INDEX.set(b.inmate.needs, 'freedom', 10)

    const individual = performSearch({
      world,
      data: DATA,
      rng: new Rng(SEED).stream('search'),
      events,
      tick: 0,
      kind: 'individual',
      inmateId: a.id,
      needIndex: INDEX,
    })
    expect(individual.moodCostApplied).toBe(SEARCH.moodCost.individual)
    expect(INDEX.get(a.inmate.needs, 'freedom')).toBe(10 + SEARCH.moodCost.individual)

    const beforeDanger = world.dangerLevel
    const shakedown = performSearch({
      world,
      data: DATA,
      rng: new Rng(SEED + 1).stream('search'),
      events,
      tick: 1,
      kind: 'shakedown',
      needIndex: INDEX,
    })
    expect(shakedown.moodCostApplied).toBe(SEARCH.moodCost.shakedown * 2)
    expect(INDEX.get(a.inmate.needs, 'freedom')).toBe(
      10 + SEARCH.moodCost.individual + SEARCH.moodCost.shakedown,
    )
    expect(INDEX.get(b.inmate.needs, 'freedom')).toBe(10 + SEARCH.moodCost.shakedown)
    expect(world.dangerLevel).toBe(beforeDanger + SEARCH.shakedownDangerSpike)
  })

  it('intake with four officers finds essentially all arrival contraband and records delay', () => {
    const { world, events } = makeWorld()
    world.morale.value = 90
    const inmate = addInmate(world)
    for (let i = 0; i < 12; i += 1) {
      world.contraband.giveCarried(inmate.inmate, inmate.id, 'cigarettes')
    }

    const result = performSearch({
      world,
      data: DATA,
      rng: new Rng(SEED + 3).stream('search'),
      events,
      tick: 0,
      kind: 'intake',
      inmateId: inmate.id,
      officerCount: 4,
      needIndex: INDEX,
    })

    expect(result.found.length).toBeGreaterThanOrEqual(11)
    expect(result.intakeDelayMinutes).toBe(SEARCH.intakeDelayMinutesPerInmate)
    expect(events.of(SEARCH_EVENTS.intakeDelayed)).toHaveLength(1)
    expect(world.contraband.carriedOf(inmate.inmate).length).toBeLessThanOrEqual(1)
  })

  it('shakedown finds most stashes and spikes danger', () => {
    const { world, events } = makeWorld()
    world.morale.value = 85
    world.dangerLevel = 20
    for (let i = 0; i < 20; i += 1) {
      world.contraband.hideAt(100 + i, ['kitchen_knife', 'lighter'], 0)
    }

    const result = performSearch({
      world,
      data: DATA,
      rng: new Rng(SEED + 9).stream('search'),
      events,
      tick: 0,
      kind: 'shakedown',
      needIndex: INDEX,
    })

    expect(result.found.length).toBeGreaterThan(30)
    expect(world.contraband.stashCount()).toBeLessThan(8)
    expect(world.dangerLevel).toBe(20 + SEARCH.shakedownDangerSpike)
  })
})
