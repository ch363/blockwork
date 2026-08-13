/**
 * T8.20 — MovementSystem smoke.
 */

import { describe, expect, it } from 'vitest'

import { Simulation, createEmptyWorld } from '../../src/core/simulation'
import type { SimulationEvent } from '../../src/core/simulation'
import { loadGameData } from '../../src/data/loader'
import {
  MOVEMENT_SYSTEM_NAME,
  MOVEMENT_SYSTEM_PERIOD,
  createMovementSystem,
} from '../../src/systems/movementSystem'

const DATA = loadGameData()

class RecordingSink {
  readonly events: SimulationEvent[] = []
  emit(event: SimulationEvent): void {
    this.events.push(event)
  }
}

describe('movementSystem', () => {
  it('runs every tick after pathing', () => {
    const system = createMovementSystem({ data: DATA })
    expect(system.name).toBe(MOVEMENT_SYSTEM_NAME)
    expect(system.period).toBe(MOVEMENT_SYSTEM_PERIOD)
    expect(system.doorQueues).toBeDefined()
  })

  it('emits movement.rejected once on a non-PathingWorld', () => {
    const events = new RecordingSink()
    const sim = new Simulation({
      seed: 1,
      world: createEmptyWorld(),
      systems: [createMovementSystem({ data: DATA })],
      events,
    })

    sim.step()
    sim.step()

    expect(events.events.filter((event) => event.kind === 'movement.rejected')).toHaveLength(1)
  })
})
