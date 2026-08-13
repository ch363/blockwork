/**
 * T8.20 — Trace builder depth-limited DAG walk.
 */

import { RAW_TRACE_STRINGS } from '@blockwork/data'
import { describe, expect, it } from 'vitest'

import { CausalEventLog, TRACE_KINDS, TRACE_MAX_DEPTH } from '../../src/trace/causalEvent'
import { buildTrace, parseTraceStrings } from '../../src/trace/traceBuilder'

const CATALOGUE = parseTraceStrings(RAW_TRACE_STRINGS)

describe('traceBuilder depth-8 DAG walk', () => {
  it('walks causes to TRACE_MAX_DEPTH and stops deeper nodes', () => {
    const log = new CausalEventLog()
    let prev = log.record({
      tick: 0,
      kind: TRACE_KINDS.kitchenUnderCapacity,
      causeIds: [],
      data: {
        kitchenName: 'K',
        cookers: 1,
        cooks: 1,
        mealsPerCookerPerHour: 12,
        assistFactor: 1,
        mealsPerHour: 12,
        needed: 10,
        prepHours: 4,
        neededCookers: 2,
        neededCooks: 2,
        altCookers: 2,
        altCooks: 2,
        cookerCost: 700,
      },
    })

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

    expect(TRACE_MAX_DEPTH).toBe(8)
    expect(maxDepth).toBe(TRACE_MAX_DEPTH)
    expect(view.nodes.length).toBe(TRACE_MAX_DEPTH + 1)
  })
})
