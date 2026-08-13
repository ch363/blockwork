/**
 * T8.20 — DangerSystem dedicated coverage.
 */

import { describe, expect, it } from 'vitest'

import { Simulation, createEmptyWorld } from '../../src/core/simulation'
import type { SimulationEvent } from '../../src/core/simulation'
import { loadGameData } from '../../src/data/loader'
import {
  DANGER_EVENTS,
  DANGER_SYSTEM_NAME,
  DANGER_SYSTEM_PERIOD,
  computeDanger,
  createDangerSystem,
} from '../../src/systems/dangerSystem'

const DATA = loadGameData()

class RecordingSink {
  readonly events: SimulationEvent[] = []

  emit(event: SimulationEvent): void {
    this.events.push(event)
  }
}

describe('dangerSystem', () => {
  it('computes no danger for a calm, covered prison', () => {
    expect(
      computeDanger(
        {
          pctInmatesWithAnyCriticalNeed: 0,
          misconductLastWindow: 0,
          population: 10,
          pctInmatesArmed: 0,
          staffMorale: 100,
          guardCoverageRatio: 1,
          pctMaxSecPopulation: 0,
        },
        DATA.balance.danger,
      ),
    ).toBe(0)
  })

  it('runs once per in-game minute', () => {
    const system = createDangerSystem({ data: DATA })
    expect(system.name).toBe(DANGER_SYSTEM_NAME)
    expect(system.period).toBe(DANGER_SYSTEM_PERIOD)
  })

  it('emits danger.rejected once on a non-InmateWorld', () => {
    const events = new RecordingSink()
    const sim = new Simulation({
      seed: 1,
      world: createEmptyWorld(),
      systems: [createDangerSystem({ data: DATA })],
      events,
    })

    for (let i = 0; i < DANGER_SYSTEM_PERIOD * 2; i += 1) sim.step()

    expect(events.events.filter((event) => event.kind === DANGER_EVENTS.rejected)).toHaveLength(1)
  })
})
