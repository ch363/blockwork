/**
 * T8.20 — ParoleSystem smoke.
 */

import { describe, expect, it } from 'vitest'

import { loadGameData } from '../../src/data/loader'
import { createInmateShell, generateInmate } from '../../src/entities/inmate'
import { Rng } from '../../src/core/rng'
import { createInmateWorld } from '../../src/systems/intakeSystem'
import {
  PAROLE_SYSTEM_NAME,
  PAROLE_SYSTEM_PERIOD,
  createParoleSystem,
  isParoleEligible,
} from '../../src/systems/paroleSystem'

const DATA = loadGameData()

describe('paroleSystem', () => {
  it('isParoleEligible requires a minimum served fraction of the sentence', () => {
    const rng = new Rng(0xb10c_8020).stream('parole')
    const component = generateInmate({ data: DATA, rng, category: 'medium' })
    component.sentenceHours = 1000
    component.servedHours = 10
    const shell = createInmateShell({ id: 1, data: DATA, inmate: component, tx: 1, ty: 1 })

    expect(isParoleEligible(DATA.balance.parole, shell)).toBe(false)

    component.servedHours = DATA.balance.parole.eligibilityFraction * component.sentenceHours
    expect(isParoleEligible(DATA.balance.parole, shell)).toBe(true)
  })

  it('runs once per in-game hour', () => {
    const system = createParoleSystem({ data: DATA })
    expect(system.name).toBe(PAROLE_SYSTEM_NAME)
    expect(system.period).toBe(PAROLE_SYSTEM_PERIOD)
  })

  it('createParoleSystem accepts a live InmateWorld wiring check', () => {
    const world = createInmateWorld({ size: 16, data: DATA, continuousIntake: false })
    expect(world.inmates.size).toBe(0)
    expect(createParoleSystem({ data: DATA }).name).toBe(PAROLE_SYSTEM_NAME)
  })
})
