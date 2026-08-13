/**
 * T8.20 — ReleaseSystem smoke.
 */

import { describe, expect, it } from 'vitest'

import { loadGameData } from '../../src/data/loader'
import { createInmateShell, generateInmate } from '../../src/entities/inmate'
import { Rng } from '../../src/core/rng'
import { createInmateWorld } from '../../src/systems/intakeSystem'
import {
  RELEASE_SYSTEM_NAME,
  RELEASE_SYSTEM_PERIOD,
  checkRecidivismFailure,
  createReleaseSystem,
  serveTime,
} from '../../src/systems/releaseSystem'

const DATA = loadGameData()

class RecordingSink {
  readonly events: { kind: string }[] = []
  emit(event: { kind: string }): void {
    this.events.push(event)
  }
}

describe('releaseSystem', () => {
  it('serveTime advances every inmate servedHours by one hour', () => {
    const world = createInmateWorld({ size: 16, data: DATA, continuousIntake: false })
    const rng = new Rng(0xb10c_8020).stream('release')
    const component = generateInmate({ data: DATA, rng, category: 'medium' })
    component.servedHours = 10
    world.inmates.add(createInmateShell({ id: 1, data: DATA, inmate: component, tx: 2, ty: 2 }))

    serveTime(world)
    expect(world.inmates.get(1)?.inmate.servedHours).toBe(11)
  })

  it('checkRecidivismFailure is false when the failure condition is disarmed', () => {
    const world = createInmateWorld({ size: 16, data: DATA, continuousIntake: false })
    const events = new RecordingSink()
    expect(checkRecidivismFailure(world, DATA, events, 0)).toBe(false)
  })

  it('runs once per in-game hour', () => {
    const system = createReleaseSystem({ data: DATA })
    expect(system.name).toBe(RELEASE_SYSTEM_NAME)
    expect(system.period).toBe(RELEASE_SYSTEM_PERIOD)
  })
})
