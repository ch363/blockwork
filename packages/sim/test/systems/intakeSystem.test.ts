/**
 * T8.20 — IntakeSystem smoke: world factory and bus cadence.
 */

import { describe, expect, it } from 'vitest'

import { loadGameData } from '../../src/data/loader'
import { createEmptyWorld } from '../../src/core/simulation'
import {
  INTAKE_SYSTEM_NAME,
  INTAKE_SYSTEM_PERIOD,
  busIntervalTicks,
  createInmateWorld,
  createIntakeSystem,
  isInmateWorld,
} from '../../src/systems/intakeSystem'

const DATA = loadGameData()

describe('intakeSystem', () => {
  it('createInmateWorld satisfies isInmateWorld', () => {
    const world = createInmateWorld({ size: 16, data: DATA, continuousIntake: false })
    expect(isInmateWorld(world)).toBe(true)
    expect(isInmateWorld(createEmptyWorld())).toBe(false)
  })

  it('derives bus interval from balance data', () => {
    expect(busIntervalTicks(DATA)).toBeGreaterThan(0)
  })

  it('runs once per in-game hour', () => {
    const system = createIntakeSystem({ data: DATA })
    expect(system.name).toBe(INTAKE_SYSTEM_NAME)
    expect(system.period).toBe(INTAKE_SYSTEM_PERIOD)
  })
})
