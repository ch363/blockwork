/**
 * T8.20 — PunishmentSystem smoke.
 */

import { describe, expect, it } from 'vitest'

import { Simulation, createEmptyWorld } from '../../src/core/simulation'
import type { SimulationEvent } from '../../src/core/simulation'
import { loadGameData } from '../../src/data/loader'
import {
  PUNISHMENT_SYSTEM_NAME,
  PUNISHMENT_SYSTEM_PERIOD,
  createPunishmentSystem,
} from '../../src/systems/punishmentSystem'

const DATA = loadGameData()

class RecordingSink {
  readonly events: SimulationEvent[] = []
  emit(event: SimulationEvent): void {
    this.events.push(event)
  }
}

describe('punishmentSystem', () => {
  it('runs once per in-game minute', () => {
    const system = createPunishmentSystem({ data: DATA })
    expect(system.name).toBe(PUNISHMENT_SYSTEM_NAME)
    expect(system.period).toBe(PUNISHMENT_SYSTEM_PERIOD)
  })

  it('emits misconduct.rejected once on a non-InmateWorld', () => {
    const events = new RecordingSink()
    const sim = new Simulation({
      seed: 1,
      world: createEmptyWorld(),
      systems: [createPunishmentSystem({ data: DATA })],
      events,
    })

    for (let i = 0; i < PUNISHMENT_SYSTEM_PERIOD; i += 1) sim.step()

    expect(events.events.filter((event) => event.kind === 'misconduct.rejected')).toHaveLength(1)
  })
})
