/**
 * T8.20 — ActivitySystem smoke.
 */

import { describe, expect, it } from 'vitest'

import { Simulation, createEmptyWorld } from '../../src/core/simulation'
import type { SimulationEvent } from '../../src/core/simulation'
import { loadGameData } from '../../src/data/loader'
import {
  ACTIVITY_SYSTEM_NAME,
  ACTIVITY_SYSTEM_PERIOD,
  createActivitySystem,
} from '../../src/systems/activitySystem'
import { ACTIVITY_EVENTS } from '../../src/world/routine'

const DATA = loadGameData()

class RecordingSink {
  readonly events: SimulationEvent[] = []
  emit(event: SimulationEvent): void {
    this.events.push(event)
  }
}

describe('activitySystem', () => {
  it('runs once per in-game minute after needs', () => {
    const system = createActivitySystem({ data: DATA })
    expect(system.name).toBe(ACTIVITY_SYSTEM_NAME)
    expect(system.period).toBe(ACTIVITY_SYSTEM_PERIOD)
  })

  it('emits activity.rejected once on a non-InmateWorld', () => {
    const events = new RecordingSink()
    const sim = new Simulation({
      seed: 1,
      world: createEmptyWorld(),
      systems: [createActivitySystem({ data: DATA })],
      events,
    })

    for (let i = 0; i < ACTIVITY_SYSTEM_PERIOD; i += 1) sim.step()

    expect(events.events.filter((event) => event.kind === ACTIVITY_EVENTS.rejected)).toHaveLength(1)
  })
})
