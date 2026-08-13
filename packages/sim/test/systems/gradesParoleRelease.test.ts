/**
 * T5.4 — the moral ledger: each grade formula, the reoffend derivation, parole
 * eligibility and outcome, the release flow, and the statistics that count it.
 */

import { describe, expect, it } from 'vitest'

import { TICKS_PER_DAY, TICKS_PER_HOUR } from '../../src/core/clock'
import { Rng } from '../../src/core/rng'
import { Simulation } from '../../src/core/simulation'
import type { JsonObject } from '../../src/core/commands'
import type { SimulationEvent } from '../../src/core/simulation'
import { loadGameData } from '../../src/data/loader'
import type { GameData } from '../../src/data/loader'
import { createInmateShell, generateInmate } from '../../src/entities/inmate'
import {
  GRADES_EVENTS,
  accrueExposure,
  computeGrades,
  createGradesSystem,
  creditLabourHours,
  deriveReoffendChance,
  healthGrade,
  misconductInWindow,
  punishmentGrade,
  reformGrade,
  securityGrade,
} from '../../src/systems/gradesSystem'
import {
  PAROLE_EVENTS,
  approvalChance,
  createParoleSystem,
  holdHearings,
  isParoleEligible,
  refreshQueue,
} from '../../src/systems/paroleSystem'
import {
  RELEASE_EVENTS,
  checkRecidivismFailure,
  createReleaseSystem,
  releaseExpiredSentences,
  releaseInmate,
  rollPendingReoffences,
  serveTime,
} from '../../src/systems/releaseSystem'
import { createInmateWorld } from '../../src/systems/intakeSystem'
import type { InmateWorld } from '../../src/systems/intakeSystem'

const DATA: GameData = loadGameData()

class RecordingSink {
  readonly events: SimulationEvent[] = []
  emit(event: SimulationEvent): void {
    this.events.push(event)
  }
  of(kind: string): SimulationEvent[] {
    return this.events.filter((event) => event.kind === kind)
  }
}

function world(): InmateWorld {
  return createInmateWorld({ size: 24, data: DATA, continuousIntake: false, research: 'all' })
}

function addInmate(
  target: InmateWorld,
  patch: Partial<{
    sentenceHours: number
    servedHours: number
    health: number
    suppression: number
    addictions: { substance: 'narcotics' | 'alcohol'; strength: number }[]
  }> = {},
): number {
  const rng = new Rng(0xb10c_5004).stream('test')
  const component = generateInmate({ data: DATA, rng, category: 'medium' })
  if (patch.sentenceHours !== undefined) component.sentenceHours = patch.sentenceHours
  if (patch.servedHours !== undefined) component.servedHours = patch.servedHours
  if (patch.health !== undefined) component.health = patch.health
  if (patch.suppression !== undefined) component.suppression = patch.suppression
  if (patch.addictions !== undefined) component.addictions = patch.addictions
  else component.addictions = []

  const id = target.inmates.allocateId()
  target.inmates.add(createInmateShell({ id, data: DATA, inmate: component, tx: 2, ty: 2 }))
  return id
}

/* -------------------------------------------------------------------------- */
/* The four grades                                                             */
/* -------------------------------------------------------------------------- */

describe('grades — the four formulas', () => {
  const cfg = DATA.balance.grades

  it('scores punishment from weighted confinement against the sentence', () => {
    const sentenceHours = 1000
    const ceiling = sentenceHours * cfg.punishment.maxHoursScale

    expect(
      punishmentGrade(cfg.punishment, { isolationHours: 0, lockdownHours: 0, sentenceHours }),
    ).toBe(0)

    // Solitary weighs more than lockdown, hour for hour.
    const solitary = punishmentGrade(cfg.punishment, {
      isolationHours: 10,
      lockdownHours: 0,
      sentenceHours,
    })
    const locked = punishmentGrade(cfg.punishment, {
      isolationHours: 0,
      lockdownHours: 10,
      sentenceHours,
    })
    expect(solitary).toBeGreaterThan(locked)
    expect(solitary / locked).toBeCloseTo(
      cfg.punishment.isolationWeight / cfg.punishment.lockdownWeight,
      6,
    )

    // Reaches 100 at the ceiling, and stays there.
    expect(
      punishmentGrade(cfg.punishment, {
        isolationHours: 0,
        lockdownHours: ceiling / cfg.punishment.lockdownWeight,
        sentenceHours,
      }),
    ).toBeCloseTo(100, 6)
    expect(
      punishmentGrade(cfg.punishment, {
        isolationHours: sentenceHours,
        lockdownHours: sentenceHours,
        sentenceHours,
      }),
    ).toBe(100)

    // A sentence of zero hours cannot be a proportion of anything.
    expect(
      punishmentGrade(cfg.punishment, {
        isolationHours: 50,
        lockdownHours: 50,
        sentenceHours: 0,
      }),
    ).toBe(0)
  })

  it('scores reform as what was learned minus what suppression cost', () => {
    const base = reformGrade(cfg.reform, {
      programsCompleted: 2,
      sessionsPassed: 0,
      suppressionExposure: 0,
      labourHours: 0,
    })
    expect(base).toBeCloseTo(2 * cfg.reform.perProgramCompleted, 6)

    const withSessions = reformGrade(cfg.reform, {
      programsCompleted: 2,
      sessionsPassed: 3,
      suppressionExposure: 0,
      labourHours: 0,
    })
    expect(withSessions).toBeCloseTo(base + 3 * cfg.reform.perSessionPassed, 6)

    const suppressed = reformGrade(cfg.reform, {
      programsCompleted: 2,
      sessionsPassed: 0,
      suppressionExposure: 50,
      labourHours: 0,
    })
    expect(suppressed).toBeCloseTo(base - 50 * cfg.reform.suppressionPenaltyPerPoint, 6)

    // Work counts, and the grade never goes negative or above 100.
    expect(
      reformGrade(cfg.reform, {
        programsCompleted: 0,
        sessionsPassed: 0,
        suppressionExposure: 0,
        labourHours: cfg.reform.labourHoursPerPoint * 4,
      }),
    ).toBeCloseTo(4, 6)
    expect(
      reformGrade(cfg.reform, {
        programsCompleted: 0,
        sessionsPassed: 0,
        suppressionExposure: 10_000,
        labourHours: 0,
      }),
    ).toBe(0)
    expect(
      reformGrade(cfg.reform, {
        programsCompleted: 100,
        sessionsPassed: 0,
        suppressionExposure: 0,
        labourHours: 0,
      }),
    ).toBe(100)
  })

  it('scores security down from a clean sheet, weighting major offences more', () => {
    expect(securityGrade(cfg.security, { minorInWindow: 0, majorInWindow: 0 })).toBe(100)
    expect(securityGrade(cfg.security, { minorInWindow: 1, majorInWindow: 0 })).toBeCloseTo(
      100 - cfg.security.perMinorMisconduct,
      6,
    )
    expect(securityGrade(cfg.security, { minorInWindow: 0, majorInWindow: 1 })).toBeCloseTo(
      100 - cfg.security.perMajorMisconduct,
      6,
    )
    expect(cfg.security.perMajorMisconduct).toBeGreaterThan(cfg.security.perMinorMisconduct)
    expect(securityGrade(cfg.security, { minorInWindow: 50, majorInWindow: 50 })).toBe(0)
  })

  it('scores health from needs, body and sobriety', () => {
    const perfect = healthGrade(cfg.health, { meanNeed: 0, health: 100, addictionStrength: 0 })
    expect(perfect).toBeCloseTo(100, 6)

    const starving = healthGrade(cfg.health, { meanNeed: 100, health: 100, addictionStrength: 0 })
    expect(starving).toBeCloseTo(100 * (cfg.health.injuryWeight + cfg.health.addictionWeight), 6)

    const injured = healthGrade(cfg.health, { meanNeed: 0, health: 0, addictionStrength: 0 })
    expect(injured).toBeCloseTo(100 * (cfg.health.needWeight + cfg.health.addictionWeight), 6)

    const addicted = healthGrade(cfg.health, { meanNeed: 0, health: 100, addictionStrength: 1 })
    expect(addicted).toBeCloseTo(100 * (cfg.health.needWeight + cfg.health.injuryWeight), 6)
  })

  it('counts only the misconduct inside the trailing window', () => {
    const target = world()
    const id = addInmate(target)
    const entity = target.inmates.get(id)
    if (entity === undefined) throw new Error('inmate missing')

    const windowDays = cfg.security.windowDays
    entity.inmate.misconductLog.push(
      { tick: 0, kind: 'complaint', punishment: 'ignore', durationHours: 0 },
      {
        tick: (windowDays + 5) * TICKS_PER_DAY,
        kind: 'complaint',
        punishment: 'ignore',
        durationHours: 0,
      },
      {
        tick: (windowDays + 6) * TICKS_PER_DAY,
        kind: 'homicide',
        punishment: 'isolation',
        durationHours: 0,
      },
    )

    const now = (windowDays + 7) * TICKS_PER_DAY
    expect(misconductInWindow(entity, DATA.balance, now)).toEqual({ minor: 1, major: 1 })
  })
})

/* -------------------------------------------------------------------------- */
/* Reoffend derivation                                                         */
/* -------------------------------------------------------------------------- */

describe('grades — reoffendChance (PRD 5.4)', () => {
  const cfg = DATA.balance.reoffend
  const neutral = {
    completedBasicLiteracy: false,
    completedVocational: false,
    completedJoinery: false,
    activeAddiction: 0,
    suppressionExposure: 0,
    healthGrade: 0,
    misconductRate: 0,
  }

  it('starts at the base rate with every term neutral', () => {
    expect(deriveReoffendChance(cfg, neutral)).toBeCloseTo(cfg.base, 6)
  })

  it("applies each term with the PRD's sign and weight", () => {
    expect(deriveReoffendChance(cfg, { ...neutral, completedBasicLiteracy: true })).toBeCloseTo(
      cfg.base - cfg.basicLiteracy,
      6,
    )
    expect(deriveReoffendChance(cfg, { ...neutral, completedVocational: true })).toBeCloseTo(
      cfg.base - cfg.vocational,
      6,
    )
    expect(deriveReoffendChance(cfg, { ...neutral, completedJoinery: true })).toBeCloseTo(
      cfg.base - cfg.joinery,
      6,
    )
    expect(deriveReoffendChance(cfg, { ...neutral, activeAddiction: 1 })).toBeCloseTo(
      cfg.base + cfg.activeAddiction,
      6,
    )
    expect(deriveReoffendChance(cfg, { ...neutral, suppressionExposure: 1 })).toBeCloseTo(
      cfg.base + cfg.suppressionExposure,
      6,
    )
    expect(deriveReoffendChance(cfg, { ...neutral, healthGrade: 1 })).toBeCloseTo(
      cfg.base - cfg.healthGrade,
      6,
    )
    expect(deriveReoffendChance(cfg, { ...neutral, misconductRate: 1 })).toBeCloseTo(
      cfg.base + cfg.misconductRate,
      6,
    )
  })

  it('clamps to the configured range', () => {
    const best = deriveReoffendChance(cfg, {
      ...neutral,
      completedBasicLiteracy: true,
      completedVocational: true,
      completedJoinery: true,
      healthGrade: 1,
      programmeDelta: -5,
    })
    expect(best).toBe(cfg.min)

    const worst = deriveReoffendChance(cfg, {
      ...neutral,
      activeAddiction: 1,
      suppressionExposure: 1,
      misconductRate: 1,
      programmeDelta: 5,
    })
    expect(worst).toBe(cfg.max)
  })

  it("counts a completed programme's own reoffend delta once", () => {
    const target = world()
    const id = addInmate(target, { sentenceHours: 1000, health: 100 })
    const entity = target.inmates.get(id)
    if (entity === undefined) throw new Error('inmate missing')

    const before = computeGrades(target, DATA, entity, 0).reoffendChance
    // Alcohol Recovery is not one of the three named terms, so its -0.35
    // arrives through `programmeDelta`.
    target.programs.recordCompletion(id, 'alcohol_recovery_group')
    const after = computeGrades(target, DATA, entity, 0).reoffendChance
    expect(after).toBeLessThan(before)
  })
})

/* -------------------------------------------------------------------------- */
/* Accrual                                                                     */
/* -------------------------------------------------------------------------- */

describe('grades — accrual and the hourly pass', () => {
  it('integrates suppression exposure rather than sampling it', () => {
    const target = world()
    const id = addInmate(target, { suppression: 40 })

    accrueExposure(target, 1)
    accrueExposure(target, 1)
    expect(target.grades.recordFor(id).suppressionExposure).toBeCloseTo(80, 6)
  })

  it('credits confinement hours by the hold in force', () => {
    const target = world()
    const id = addInmate(target)
    target.punishments.set({
      inmateId: id,
      kind: 'isolation',
      sourceMisconduct: 'attackInmate',
      phase: 'holding',
      remainingMinutes: 600,
      homeCellId: 0,
      holdRoomId: 0,
      destinationTile: 0,
      escortJobId: 0,
      lastMealHourKey: -1,
      isolationSuppressionAccrued: 0,
    })

    accrueExposure(target, 1)
    expect(target.grades.recordFor(id).isolationHours).toBe(1)
    expect(target.grades.recordFor(id).lockdownHours).toBe(0)
  })

  it('credits hours worked toward reform', () => {
    const target = world()
    const id = addInmate(target)
    creditLabourHours(target, id, 12)
    expect(target.grades.recordFor(id).labourHours).toBe(12)
  })

  it('writes all four grades and the derived chance onto the inmate', () => {
    const target = world()
    const id = addInmate(target, { sentenceHours: 500, health: 90 })
    const events = new RecordingSink()
    const sim = new Simulation({
      seed: 1,
      world: target,
      systems: [createGradesSystem({ data: DATA })],
      events,
    })
    for (let i = 0; i < TICKS_PER_HOUR; i += 1) sim.step()

    const entity = target.inmates.get(id)
    expect(entity?.inmate.grades.security).toBe(100)
    expect(entity?.inmate.grades.health).toBeGreaterThan(0)
    expect(entity?.inmate.reoffendChance).toBeGreaterThan(0)
    expect(events.of(GRADES_EVENTS.recomputed)).toHaveLength(1)
  })

  it('reports a world it cannot grade rather than throwing', () => {
    const events = new RecordingSink()
    const sim = new Simulation({
      seed: 1,
      systems: [createGradesSystem({ data: DATA })],
      events,
    })
    for (let i = 0; i < TICKS_PER_HOUR; i += 1) sim.step()
    expect(events.of(GRADES_EVENTS.rejected)).toHaveLength(1)
  })
})

/* -------------------------------------------------------------------------- */
/* Parole                                                                      */
/* -------------------------------------------------------------------------- */

describe('parole — eligibility, the queue and the outcome', () => {
  it('becomes eligible at the configured fraction of the sentence', () => {
    const target = world()
    const balance = DATA.balance.parole
    const half = addInmate(target, { sentenceHours: 1000, servedHours: 500 })
    const early = addInmate(target, { sentenceHours: 1000, servedHours: 100 })

    const halfEntity = target.inmates.get(half)
    const earlyEntity = target.inmates.get(early)
    expect(halfEntity && isParoleEligible(balance, halfEntity)).toBe(true)
    expect(earlyEntity && isParoleEligible(balance, earlyEntity)).toBe(false)
  })

  it('admits newly eligible inmates to the queue exactly once', () => {
    const target = world()
    const events = new RecordingSink()
    addInmate(target, { sentenceHours: 1000, servedHours: 600 })

    refreshQueue(target, DATA, events, 0)
    refreshQueue(target, DATA, events, TICKS_PER_HOUR)
    expect(target.parole.queue.size).toBe(1)
    expect(events.of(PAROLE_EVENTS.becameEligible)).toHaveLength(1)
  })

  it('weights approval on reform, misconduct and time served', () => {
    const balance = DATA.balance.parole
    const neutral = { reformGrade: 0, misconductRate: 0, servedFraction: 0 }

    expect(approvalChance(balance, neutral)).toBeCloseTo(balance.approval.base, 6)
    expect(approvalChance(balance, { ...neutral, reformGrade: 1 })).toBeGreaterThan(
      approvalChance(balance, neutral),
    )
    expect(approvalChance(balance, { ...neutral, misconductRate: 1 })).toBeLessThan(
      approvalChance(balance, neutral),
    )
    expect(approvalChance(balance, { ...neutral, servedFraction: 1 })).toBeGreaterThan(
      approvalChance(balance, neutral),
    )

    expect(
      approvalChance(balance, { reformGrade: 1, misconductRate: 0, servedFraction: 1 }),
    ).toBeLessThanOrEqual(balance.approval.max)
    expect(
      approvalChance(balance, { reformGrade: 0, misconductRate: 1, servedFraction: 0 }),
    ).toBeGreaterThanOrEqual(balance.approval.min)
  })

  it('caps hearings at the daily budget', () => {
    const target = world()
    const events = new RecordingSink()
    const budget = DATA.balance.parole.hearingsPerDay
    for (let i = 0; i < budget + 4; i += 1) {
      addInmate(target, { sentenceHours: 1000, servedHours: 900 })
    }
    refreshQueue(target, DATA, events, 0)

    const rng = new Rng(0xb10c_5005).stream('parole')
    expect(holdHearings(target, DATA, events, rng, 0)).toBe(budget)
  })

  it('angers a denied inmate and pushes their next hearing back a day', () => {
    const target = world()
    const events = new RecordingSink()
    const id = addInmate(target, { sentenceHours: 1000, servedHours: 600 })
    const entity = target.inmates.get(id)
    if (entity === undefined) throw new Error('inmate missing')
    // A dismal record, so approval is at the floor and denial is near certain.
    entity.inmate.grades = { punishment: 100, reform: 0, security: 0, health: 0 }
    for (let i = 0; i < 20; i += 1) {
      entity.inmate.misconductLog.push({
        tick: 0,
        kind: 'attackInmate',
        punishment: 'isolation',
        durationHours: 6,
      })
    }
    refreshQueue(target, DATA, events, 0)

    // A stream that never passes a chance below 1.
    const rng = { chance: () => false, next: () => 0.999 } as never
    holdHearings(target, DATA, events, rng, 0)

    expect(events.of(PAROLE_EVENTS.denied)).toHaveLength(1)
    expect(entity.inmate.status).toContain('angry')
    const record = target.parole.queue.get(id)
    expect(record?.nextHearingTick).toBe(DATA.balance.parole.deniedAngryHours * TICKS_PER_HOUR)
  })

  it('releases an approved inmate early and clears them from the queue', () => {
    const target = world()
    const events = new RecordingSink()
    const id = addInmate(target, { sentenceHours: 1000, servedHours: 600 })
    refreshQueue(target, DATA, events, 0)

    const rng = { chance: () => true, next: () => 0 } as never
    holdHearings(target, DATA, events, rng, 0)

    expect(events.of(PAROLE_EVENTS.approved)).toHaveLength(1)
    expect(target.inmates.get(id)).toBeUndefined()
    expect(target.parole.queue.has(id)).toBe(false)
    expect(target.release.released[0]?.reason).toBe('parole')
  })
})

/* -------------------------------------------------------------------------- */
/* Release and re-offending                                                    */
/* -------------------------------------------------------------------------- */

describe('release — the gate and the ledger', () => {
  it('serves an hour of time per pass and releases at the end of the sentence', () => {
    const target = world()
    const events = new RecordingSink()
    const id = addInmate(target, { sentenceHours: 3, servedHours: 0 })

    serveTime(target)
    expect(releaseExpiredSentences(target, DATA, events, 0)).toBe(0)
    serveTime(target)
    serveTime(target)
    expect(releaseExpiredSentences(target, DATA, events, 0)).toBe(1)

    expect(target.inmates.get(id)).toBeUndefined()
    expect(target.release.lifetimeReleased).toBe(1)
    const released = events.of(RELEASE_EVENTS.released)[0]?.data as JsonObject
    expect(released['reason']).toBe('sentence_served')
  })

  it('records the dock the inmate left by', () => {
    const target = world()
    const events = new RecordingSink()
    const id = addInmate(target, { sentenceHours: 1, servedHours: 1 })
    const entity = target.inmates.get(id)
    if (entity === undefined) throw new Error('inmate missing')

    releaseInmate(target, DATA, events, 0, entity, 'sentence_served')
    const released = events.of(RELEASE_EVENTS.released)[0]?.data as JsonObject
    // No dock built in this fixture, and the event says so rather than lying.
    expect(released['viaDockTile']).toBe(-1)
  })

  it('rolls once, after the delay, and never again', () => {
    const target = world()
    const events = new RecordingSink()
    const id = addInmate(target, { sentenceHours: 1, servedHours: 1 })
    const entity = target.inmates.get(id)
    if (entity === undefined) throw new Error('inmate missing')
    entity.inmate.reoffendChance = 1
    releaseInmate(target, DATA, events, 0, entity, 'sentence_served')

    const rng = new Rng(0xb10c_5006).stream('release')
    const delay = DATA.balance.parole.reoffendDelayDays * TICKS_PER_DAY

    expect(rollPendingReoffences(target, events, rng, delay - 1)).toBe(0)
    expect(rollPendingReoffences(target, events, rng, delay)).toBe(1)
    expect(rollPendingReoffences(target, events, rng, delay + TICKS_PER_DAY)).toBe(0)
    expect(target.release.lifetimeReoffended).toBe(1)
  })

  it('accumulates the rolling and lifetime statistics', () => {
    const target = world()
    const events = new RecordingSink()
    const delay = DATA.balance.parole.reoffendDelayDays * TICKS_PER_DAY

    for (let i = 0; i < 4; i += 1) {
      const id = addInmate(target, { sentenceHours: 1, servedHours: 1 })
      const entity = target.inmates.get(id)
      if (entity === undefined) continue
      // Two certain re-offenders, two certain successes.
      entity.inmate.reoffendChance = i < 2 ? 1 : 0
      releaseInmate(target, DATA, events, 0, entity, 'sentence_served')
    }

    const rng = new Rng(1).stream('release')
    rollPendingReoffences(target, events, rng, delay)

    const stats = target.release.statistics(DATA, delay)
    expect(stats.lifetimeReleased).toBe(4)
    expect(stats.lifetimeReoffended).toBe(2)
    expect(stats.lifetimeRate).toBeCloseTo(0.5, 6)
    expect(stats.released).toBe(4)
    expect(stats.rate).toBeCloseTo(0.5, 6)
  })

  it('drops releases out of the rolling window as it moves', () => {
    const target = world()
    const events = new RecordingSink()
    const id = addInmate(target, { sentenceHours: 1, servedHours: 1 })
    const entity = target.inmates.get(id)
    if (entity === undefined) throw new Error('inmate missing')
    releaseInmate(target, DATA, events, 0, entity, 'sentence_served')

    const windowTicks = DATA.balance.parole.statisticsWindowDays * TICKS_PER_DAY
    expect(target.release.statistics(DATA, windowTicks - 1).released).toBe(1)
    expect(target.release.statistics(DATA, windowTicks + TICKS_PER_DAY).released).toBe(0)
    // Lifetime never forgets.
    expect(target.release.statistics(DATA, windowTicks * 10).lifetimeReleased).toBe(1)
  })

  it('warns once and then fails on parole recidivism (PRD 5.15)', () => {
    const target = world()
    const events = new RecordingSink()
    const { count, windowDays } = DATA.balance.failure.paroleRecidivism

    for (let i = 0; i < count; i += 1) target.release.paroleReoffences.push(1)

    expect(checkRecidivismFailure(target, DATA, events, 2)).toBe(false)
    expect(events.of(RELEASE_EVENTS.recidivismWarning)).toHaveLength(1)

    expect(checkRecidivismFailure(target, DATA, events, 3)).toBe(true)
    expect(events.of(RELEASE_EVENTS.recidivismFailure)).toHaveLength(1)

    // Re-offences that have aged out of the window stop counting.
    const past = windowDays * TICKS_PER_DAY + 10
    expect(checkRecidivismFailure(target, DATA, events, past)).toBe(false)
    expect(target.release.paroleReoffences).toHaveLength(0)
  })
})

/* -------------------------------------------------------------------------- */
/* Acceptance                                                                  */
/* -------------------------------------------------------------------------- */

describe('T5.4 acceptance', () => {
  it('produces a visibly lower re-offending rate in a reform-focused prison', () => {
    // Two cohorts, identical but for what the prison did to them, run through
    // the same derivation with the same seed.
    const reformed = world()
    const punished = world()

    for (let i = 0; i < 30; i += 1) {
      const goodId = addInmate(reformed, { sentenceHours: 2000, servedHours: 2000, health: 95 })
      reformed.programs.recordCompletion(goodId, 'basic_literacy')
      reformed.programs.recordCompletion(goodId, 'vocational_certificate')

      const badId = addInmate(punished, { sentenceHours: 2000, servedHours: 2000, health: 55 })
      const badEntity = punished.inmates.get(badId)
      if (badEntity === undefined) continue
      const record = punished.grades.recordFor(badId)
      record.isolationHours = 400
      record.suppressionExposure = 100 * DATA.balance.grades.security.windowDays
      for (let m = 0; m < 6; m += 1) {
        badEntity.inmate.misconductLog.push({
          tick: 0,
          kind: 'attackInmate',
          punishment: 'isolation',
          durationHours: 12,
        })
      }
    }

    const meanChance = (target: InmateWorld): number => {
      let sum = 0
      let n = 0
      for (const entity of target.inmates.all()) {
        sum += computeGrades(target, DATA, entity, TICKS_PER_DAY).reoffendChance
        n += 1
      }
      return n === 0 ? 0 : sum / n
    }

    const reformedRate = meanChance(reformed)
    const punishedRate = meanChance(punished)
    expect(reformedRate).toBeLessThan(punishedRate)
    // "Visibly different", not "different in the sixth decimal".
    expect(punishedRate - reformedRate).toBeGreaterThan(0.15)
  })

  it('runs grades, parole and release together inside a simulation', () => {
    const target = world()
    const events = new RecordingSink()
    // A short sentence, already most of the way served.
    addInmate(target, { sentenceHours: 4, servedHours: 2, health: 100 })

    const sim = new Simulation({
      seed: 0xb10c_5007,
      world: target,
      systems: [
        createGradesSystem({ data: DATA }),
        createParoleSystem({ data: DATA }),
        createReleaseSystem({ data: DATA }),
      ],
      events,
    })

    for (let i = 0; i < 6 * TICKS_PER_HOUR; i += 1) sim.step()

    expect(target.inmates.size).toBe(0)
    expect(target.release.lifetimeReleased).toBe(1)
  })
})
