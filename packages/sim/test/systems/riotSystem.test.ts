/**
 * T8.20 — RiotSystem smoke.
 */

import { describe, expect, it } from 'vitest'

import { Simulation, createEmptyWorld } from '../../src/core/simulation'
import type { SimulationEvent } from '../../src/core/simulation'
import { loadGameData } from '../../src/data/loader'
import {
  RIOT_EVENTS,
  RIOT_SYSTEM_NAME,
  RIOT_SYSTEM_PERIOD,
  createRiotSystem,
  riotTriggerProbability,
} from '../../src/systems/riotSystem'

const DATA = loadGameData()

class RecordingSink {
  readonly events: SimulationEvent[] = []
  emit(event: SimulationEvent): void {
    this.events.push(event)
  }
}

describe('riotSystem', () => {
  it('riotTriggerProbability rises with danger and agitators', () => {
    const balance = DATA.balance.riot
    const calm = riotTriggerProbability(10, 0, false, balance)
    const hot = riotTriggerProbability(balance.dangerPivot * 2, 2, false, balance)
    expect(hot).toBeGreaterThan(calm)
  })

  it('runs once per in-game minute', () => {
    const system = createRiotSystem({ data: DATA })
    expect(system.name).toBe(RIOT_SYSTEM_NAME)
    expect(system.period).toBe(RIOT_SYSTEM_PERIOD)
  })

  it('emits riot.rejected once on a non-InmateWorld', () => {
    const events = new RecordingSink()
    const sim = new Simulation({
      seed: 1,
      world: createEmptyWorld(),
      systems: [createRiotSystem({ data: DATA })],
      events,
    })

    for (let i = 0; i < RIOT_SYSTEM_PERIOD; i += 1) sim.step()

    expect(events.events.filter((event) => event.kind === RIOT_EVENTS.rejected)).toHaveLength(1)
  })
})
