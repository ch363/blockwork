/**
 * T3.1 — CausalEvent log, Trace builder, string catalogue, ring buffer.
 */

import { RAW_TRACE_STRINGS } from '@blockwork/data'
import { describe, expect, it } from 'vitest'

import { TICKS_PER_DAY } from '../../src/core/clock'
import { loadGameData } from '../../src/data/loader'
import {
  CausalEventLog,
  PRD_STARVATION_EXAMPLE,
  REGISTERED_TRACE_KINDS,
  TRACE_BUFFER_CAPACITY,
  TRACE_KINDS,
  TRACE_MAX_DEPTH,
  buildTrace,
  catalogueCoversKinds,
  emitPrdStarvationChain,
  parseTraceStrings,
  tickAt,
} from '../../src/index'

const DATA = loadGameData()
const CATALOGUE = parseTraceStrings(RAW_TRACE_STRINGS)
const COOKER = DATA.objects.get('cooker')

function starvationParams() {
  return {
    inmateId: PRD_STARVATION_EXAMPLE.inmateId,
    kitchenSubjectId: 2002,
    messSubjectId: 3003,
    mealsPerCookerPerHour: DATA.balance.kitchen.mealsPerCookerPerHour,
    cookAssistBonus: DATA.balance.kitchen.cookAssistBonus,
    preparationLeadHours: DATA.balance.kitchen.preparationLeadHours,
    cookerCost: COOKER.cost,
  }
}

describe('CausalEventLog', () => {
  it('assigns ids and builds a DAG of causes', () => {
    const log = new CausalEventLog()
    const root = log.record({
      tick: 10,
      kind: 'kitchen.underCapacity',
      subjectId: 1,
      causeIds: [],
      data: { cookers: 2 },
    })
    const child = log.record({
      tick: 20,
      kind: 'kitchen.producedShortfall',
      subjectId: 1,
      causeIds: [root.id],
      data: { produced: 40, needed: 118 },
    })
    const tip = log.record({
      tick: 30,
      kind: 'inmate.starved',
      subjectId: 9,
      causeIds: [child.id],
      data: { inmateId: 9 },
    })

    expect(root.id).toBe(1)
    expect(child.causeIds).toEqual([root.id])
    expect(tip.causeIds).toEqual([child.id])
    expect(log.get(tip.id)?.kind).toBe('inmate.starved')
  })

  it('drops unknown cause ids so legacy entity-id misuse cannot abort a tick', () => {
    const log = new CausalEventLog()
    const recorded = log.record({
      tick: 1,
      kind: 'construction.completed',
      causeIds: [99],
      data: {},
    })
    expect(recorded.causeIds).toEqual([])
  })

  it('evicts the oldest unpinned events once the ring is full', () => {
    const capacity = 8
    const log = new CausalEventLog({ capacity })
    for (let i = 0; i < capacity + 5; i += 1) {
      log.record({ tick: i, kind: 'noise', causeIds: [], data: { i } })
    }
    expect(log.ringSize).toBe(capacity)
    expect(log.size).toBe(capacity)
    expect(log.get(1)).toBeUndefined()
    expect(log.get(6)).toBeDefined()
  })

  it('retains pinned events (and their causes) past ring eviction', () => {
    const capacity = 4
    const log = new CausalEventLog({ capacity })
    const a = log.record({ tick: 1, kind: 'a', causeIds: [], data: {} })
    const b = log.record({ tick: 2, kind: 'b', causeIds: [a.id], data: {} })
    log.pin(b.id)

    for (let i = 0; i < capacity + 10; i += 1) {
      log.record({ tick: 100 + i, kind: 'noise', causeIds: [], data: { i } })
    }

    expect(log.ringSize).toBeLessThanOrEqual(capacity)
    expect(log.get(a.id)).toBeDefined()
    expect(log.get(b.id)).toBeDefined()
    expect(log.isPinned(a.id)).toBe(true)
    expect(log.isPinned(b.id)).toBe(true)

    log.unpin(b.id)
    // After unpin, pinned-only events that left the ring are dropped.
    expect(log.get(a.id)).toBeUndefined()
    expect(log.get(b.id)).toBeUndefined()
  })

  it('never lets the ring exceed its memory cap under a long busy run', () => {
    // 100 in-game days at one failure per in-game minute ≫ capacity.
    const events = 100 * (TICKS_PER_DAY / 10)
    expect(events).toBeGreaterThan(TRACE_BUFFER_CAPACITY)

    const log = new CausalEventLog()
    for (let i = 0; i < events; i += 1) {
      log.record({ tick: i, kind: 'noise', causeIds: [], data: { i } })
      if (i % 10_000 === 0) {
        expect(log.ringSize).toBeLessThanOrEqual(TRACE_BUFFER_CAPACITY)
      }
    }
    expect(log.ringSize).toBe(TRACE_BUFFER_CAPACITY)
    expect(log.size).toBe(TRACE_BUFFER_CAPACITY)
  })
})

describe('buildTrace', () => {
  it('reconstructs the PRD 3.1 five-node kitchen starvation chain', () => {
    const log = new CausalEventLog()
    const tipId = emitPrdStarvationChain(log, starvationParams())
    const view = buildTrace(log, tipId, CATALOGUE)

    expect(view.nodes).toHaveLength(5)
    expect(view.nodes.map((node) => node.kind)).toEqual([
      TRACE_KINDS.inmateStarved,
      TRACE_KINDS.inmateMissedMeal,
      TRACE_KINDS.messEmptyAtMealtime,
      TRACE_KINDS.kitchenProducedShortfall,
      TRACE_KINDS.kitchenUnderCapacity,
    ])

    const [starved, missed, mess, shortfall, capacity] = view.nodes
    expect(starved?.title).toContain('4471')
    expect(starved?.title).toMatch(/starved/i)
    expect(missed?.title).toContain('0 meals')
    expect(missed?.title).toContain('3')
    expect(mess?.title).toContain('West Hall')
    expect(mess?.title).toContain('0 meals')
    expect(shortfall?.title).toContain('40')
    expect(shortfall?.title).toContain('118')
    expect(capacity?.title).toContain('2 cookers')
    expect(capacity?.isRootCause).toBe(true)

    expect(view.fixes.map((fix) => fix.id)).toEqual(['add_cookers', 'assign_cooks'])
    expect(view.fixes[0]?.label).toContain('Add 4 cookers')
    expect(view.fixes[0]?.label).toMatch(/\$2,?800/)
    expect(view.fixes[1]?.label).toContain('Assign 3 more inmates')

    expect(view.reportText).toContain('4471')
    expect(view.reportText).toContain('40')
    expect(view.reportText).toContain('118')
  })

  it('limits cause walking to the configured depth', () => {
    const log = new CausalEventLog()
    let prev = log.record({ tick: 0, kind: TRACE_KINDS.kitchenUnderCapacity, causeIds: [], data: {
      kitchenName: 'K',
      cookers: 1,
      cooks: 1,
      mealsPerCookerPerHour: 12,
      assistFactor: 1.25,
      mealsPerHour: 15,
      needed: 10,
      prepHours: 4,
      neededCookers: 2,
      neededCooks: 2,
      altCookers: 2,
      altCooks: 2,
      cookerCost: 700,
    } })

    // Build a chain deeper than TRACE_MAX_DEPTH using a registered kind that
    // only needs a few placeholders — kitchen.producedShortfall for the rest.
    for (let depth = 1; depth <= TRACE_MAX_DEPTH + 3; depth += 1) {
      prev = log.record({
        tick: depth,
        kind: TRACE_KINDS.kitchenProducedShortfall,
        causeIds: [prev.id],
        data: {
          kitchenName: 'K',
          produced: depth,
          needed: 100,
          prepStart: '08:00',
          mealTime: '12:00',
        },
      })
    }

    const view = buildTrace(log, prev.id, CATALOGUE, TRACE_MAX_DEPTH)
    const maxDepth = Math.max(...view.nodes.map((node) => node.depth))
    expect(maxDepth).toBe(TRACE_MAX_DEPTH)
    expect(view.nodes.length).toBe(TRACE_MAX_DEPTH + 1)
  })

  it('handles a diamond DAG without duplicating nodes', () => {
    const log = new CausalEventLog()
    const root = log.record({
      tick: 1,
      kind: TRACE_KINDS.kitchenUnderCapacity,
      causeIds: [],
      data: {
        kitchenName: 'K',
        cookers: 2,
        cooks: 1,
        mealsPerCookerPerHour: 12,
        assistFactor: 1.25,
        mealsPerHour: 30,
        needed: 118,
        prepHours: 4,
        neededCookers: 6,
        neededCooks: 4,
        altCookers: 3,
        altCooks: 4,
        cookerCost: 700,
      },
    })
    const left = log.record({
      tick: 2,
      kind: TRACE_KINDS.kitchenProducedShortfall,
      causeIds: [root.id],
      data: { kitchenName: 'K', produced: 40, needed: 118, prepStart: '08:00', mealTime: '12:00' },
    })
    const right = log.record({
      tick: 2,
      kind: TRACE_KINDS.messEmptyAtMealtime,
      causeIds: [root.id],
      data: {
        messName: 'West Hall',
        mealsAvailable: 0,
        mealsDelivered: 40,
        routed: 118,
        leftHungry: 78,
        missedThreePlus: 12,
        time: '12:00',
      },
    })
    const tip = log.record({
      tick: 3,
      kind: TRACE_KINDS.inmateMissedMeal,
      causeIds: [left.id, right.id],
      data: {
        mealsEaten: 0,
        blocks: 3,
        messName: 'West Hall',
        blockTimes: '07:00, 12:00 and 18:00',
      },
    })

    const view = buildTrace(log, tip.id, CATALOGUE)
    const ids = view.nodes.map((node) => node.eventId)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids).toContain(root.id)
  })
})

describe('traceStrings catalogue', () => {
  it('has a string entry for every registered event kind', () => {
    const coverage = catalogueCoversKinds(CATALOGUE, REGISTERED_TRACE_KINDS)
    expect(coverage).toEqual({ ok: true })
  })

  it('fails loudly when a registered kind is missing a string', () => {
    const incomplete = parseTraceStrings({
      kinds: {
        [TRACE_KINDS.inmateStarved]: {
          title: 'x',
          detail: 'y',
          meta: 'z',
        },
      },
    })
    const coverage = catalogueCoversKinds(incomplete, REGISTERED_TRACE_KINDS)
    expect(coverage.ok).toBe(false)
    if (!coverage.ok) {
      expect(coverage.missing).toContain(TRACE_KINDS.kitchenUnderCapacity)
    }
  })

  it('resolves placeholders for every registered kind against the PRD chain', () => {
    const log = new CausalEventLog()
    const tipId = emitPrdStarvationChain(log, starvationParams())
    const view = buildTrace(log, tipId, CATALOGUE)
    const prdChainKinds = [
      TRACE_KINDS.inmateStarved,
      TRACE_KINDS.inmateMissedMeal,
      TRACE_KINDS.messEmptyAtMealtime,
      TRACE_KINDS.kitchenProducedShortfall,
      TRACE_KINDS.kitchenUnderCapacity,
    ] as const
    for (const kind of prdChainKinds) {
      const node = view.nodes.find((entry) => entry.kind === kind)
      expect(node, `missing node for ${kind}`).toBeDefined()
      expect(node?.title.includes('{')).toBe(false)
      expect(node?.detail.includes('{')).toBe(false)
    }
  })

  it('has resolvable strings for meal-chain failure kinds', () => {
    const log = new CausalEventLog()
    const samples: { kind: (typeof TRACE_KINDS)[keyof typeof TRACE_KINDS]; data: Record<string, string | number> }[] = [
      {
        kind: TRACE_KINDS.kitchenNoIngredients,
        data: { kitchenName: 'K2', needed: 40, variety: 2, varietyPlural: 's', day: 1, time: '08:00' },
      },
      {
        kind: TRACE_KINDS.kitchenNoCookAssigned,
        data: { kitchenName: 'K2', cookers: 2, cookersPlural: 's', day: 1, time: '08:00' },
      },
      {
        kind: TRACE_KINDS.kitchenNoRouteToMess,
        data: { kitchenName: 'K2', day: 1, time: '08:00' },
      },
      {
        kind: TRACE_KINDS.messFull,
        data: {
          messName: 'West Hall',
          mealsHeld: 80,
          capacity: 80,
          kitchenName: 'K2',
          blocked: 12,
          day: 1,
          time: '11:00',
        },
      },
    ]
    for (const sample of samples) {
      const recorded = log.record({
        tick: 1,
        kind: sample.kind,
        causeIds: [],
        data: sample.data,
      })
      const view = buildTrace(log, recorded.id, CATALOGUE)
      const node = view.nodes[0]
      expect(node?.kind).toBe(sample.kind)
      expect(node?.title.includes('{')).toBe(false)
      expect(node?.detail.includes('{')).toBe(false)
    }
  })
})

describe('PRD timing helpers', () => {
  it('places the starvation death at day 28 03:12', () => {
    expect(tickAt(28, 3, 12)).toBe((28 - 1) * TICKS_PER_DAY + 3 * 600 + 12 * 10)
  })
})
