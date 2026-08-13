/**
 * T8.20 — GradesSystem smoke.
 */

import { describe, expect, it } from 'vitest'

import { Rng } from '../../src/core/rng'
import { loadGameData } from '../../src/data/loader'
import { createInmateShell, generateInmate } from '../../src/entities/inmate'
import { createInmateWorld } from '../../src/systems/intakeSystem'
import {
  GRADES_SYSTEM_NAME,
  GRADES_SYSTEM_PERIOD,
  computeGrades,
  createGradesSystem,
  punishmentGrade,
} from '../../src/systems/gradesSystem'

const DATA = loadGameData()

describe('gradesSystem', () => {
  it('punishmentGrade scales confinement against the sentence', () => {
    const cfg = DATA.balance.grades.punishment
    const low = punishmentGrade(cfg, { isolationHours: 0, lockdownHours: 0, sentenceHours: 1000 })
    const high = punishmentGrade(cfg, {
      isolationHours: 0,
      lockdownHours: 100,
      sentenceHours: 1000,
    })
    expect(low).toBe(0)
    expect(high).toBeGreaterThan(low)
  })

  it('computeGrades recomputes the four ledger scores from world state', () => {
    const world = createInmateWorld({ size: 16, data: DATA, continuousIntake: false })
    const rng = new Rng(0xb10c_8020).stream('grades')
    const component = generateInmate({ data: DATA, rng, category: 'medium' })
    component.sentenceHours = 500
    const entity = createInmateShell({ id: 1, data: DATA, inmate: component, tx: 2, ty: 2 })
    world.inmates.add(entity)

    const { grades } = computeGrades(world, DATA, entity, 0)
    expect(grades.punishment).toBeGreaterThanOrEqual(0)
    expect(grades.reform).toBeGreaterThanOrEqual(0)
    expect(grades.security).toBeGreaterThanOrEqual(0)
    expect(grades.health).toBeGreaterThanOrEqual(0)
  })

  it('runs once per in-game hour', () => {
    const system = createGradesSystem({ data: DATA })
    expect(system.name).toBe(GRADES_SYSTEM_NAME)
    expect(system.period).toBe(GRADES_SYSTEM_PERIOD)
  })
})
