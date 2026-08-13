/**
 * T8.20 — EmergencySystem smoke.
 */

import { describe, expect, it } from 'vitest'

import { Simulation, createEmptyWorld } from '../../src/core/simulation'
import type { SimulationEvent } from '../../src/core/simulation'
import { loadGameData } from '../../src/data/loader'
import {
  EMERGENCY_EVENTS,
  EMERGENCY_LEVELS,
  EMERGENCY_SYSTEM_NAME,
  EMERGENCY_SYSTEM_PERIOD,
  createEmergencySystem,
} from '../../src/systems/emergencySystem'

const DATA = loadGameData()

class RecordingSink {
  readonly events: SimulationEvent[] = []
  emit(event: SimulationEvent): void {
    this.events.push(event)
  }
}

describe('emergencySystem', () => {
  it('declares the five-level escalation ladder', () => {
    expect(EMERGENCY_LEVELS.map((entry) => entry.level)).toEqual([1, 2, 3, 4, 5])
  })

  it('runs once per in-game minute', () => {
    const system = createEmergencySystem({ data: DATA })
    expect(system.name).toBe(EMERGENCY_SYSTEM_NAME)
    expect(system.period).toBe(EMERGENCY_SYSTEM_PERIOD)
  })

  it('emits emergency.rejected once on a non-InmateWorld', () => {
    const events = new RecordingSink()
    const sim = new Simulation({
      seed: 1,
      world: createEmptyWorld(),
      systems: [createEmergencySystem({ data: DATA })],
      events,
    })

    for (let i = 0; i < EMERGENCY_SYSTEM_PERIOD; i += 1) sim.step()

    expect(events.events.filter((event) => event.kind === EMERGENCY_EVENTS.rejected)).toHaveLength(
      1,
    )
  })
})
