/**
 * `GradesSystem`: the four per-inmate grades and the number they add up to
 * (T5.4, PRD 5.5).
 *
 * The grades are the moral ledger's line items. Each is 0–100 and each answers
 * a different question about the same person:
 *
 *   - **punishment** — how much of this sentence has been spent confined
 *   - **reform** — what they have been taught, minus what suppression undid
 *   - **security** — how often and how badly they offend
 *   - **health** — whether their needs, injuries and addictions are handled
 *
 * They exist to be *disagreed with*. A prison can run a high punishment grade
 * and a low security grade and call it control; `reoffendChance` is where that
 * bill arrives, because it is derived from all four and is what the failure
 * condition and the statistics panel ultimately measure.
 *
 * Every formula is exported as a pure function over its inputs, so the
 * balance pass can chart them and the tests can assert them without a prison.
 *
 * Slot: PRD 4.4 #17, hourly, beside grading.
 */

import { TICKS_PER_DAY, TICKS_PER_HOUR } from '../core/clock'
import type { Fnv1aHasher } from '../core/hash'
import type { System, SystemContext } from '../core/simulation'
import type { GameData } from '../data/loader'
import type { Balance, MisconductKind } from '../data/schemas'
import type { InmateEntity, InmateGrades } from '../entities/inmate'
import { isMajorMisconduct } from '../entities/misconduct'

import { isInmateWorld } from './intakeSystem'
import type { InmateWorld } from './intakeSystem'

export const GRADES_SYSTEM_NAME = 'grades'
export const GRADES_SYSTEM_PERIOD = TICKS_PER_HOUR

export const GRADES_EVENTS = {
  recomputed: 'grades.recomputed',
  rejected: 'grades.rejected',
} as const

/* -------------------------------------------------------------------------- */
/* Confinement ledger                                                          */
/* -------------------------------------------------------------------------- */

export interface ConfinementRecord {
  isolationHours: number
  lockdownHours: number
  /** Cumulative suppression-points-hours, the reform grade's debit. */
  suppressionExposure: number
  /** Hours spent on a labour assignment (T5.7 credits this). */
  labourHours: number
}

/**
 * What the grades need remembered between passes.
 *
 * None of it can be recomputed from the world: an inmate released from
 * solitary carries no trace of the fortnight they spent in it, and that
 * fortnight is exactly what the punishment grade is about.
 */
export class GradesRuntime {
  readonly confinement = new Map<number, ConfinementRecord>()

  recordFor(inmateId: number): ConfinementRecord {
    let record = this.confinement.get(inmateId)
    if (record === undefined) {
      record = { isolationHours: 0, lockdownHours: 0, suppressionExposure: 0, labourHours: 0 }
      this.confinement.set(inmateId, record)
    }
    return record
  }

  clearInmate(inmateId: number): void {
    this.confinement.delete(inmateId)
  }

  serialise(): {
    readonly confinement: readonly {
      readonly inmateId: number
      readonly isolationHours: number
      readonly lockdownHours: number
      readonly suppressionExposure: number
      readonly labourHours: number
    }[]
  } {
    return {
      confinement: [...this.confinement.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([inmateId, record]) => ({ inmateId, ...record })),
    }
  }

  restore(snapshot: {
    readonly confinement: readonly {
      readonly inmateId: number
      readonly isolationHours: number
      readonly lockdownHours: number
      readonly suppressionExposure: number
      readonly labourHours: number
    }[]
  }): void {
    this.confinement.clear()
    for (const entry of snapshot.confinement) {
      this.confinement.set(entry.inmateId, {
        isolationHours: entry.isolationHours,
        lockdownHours: entry.lockdownHours,
        suppressionExposure: entry.suppressionExposure,
        labourHours: entry.labourHours,
      })
    }
  }

  hashInto(hasher: Fnv1aHasher): void {
    const entries = [...this.confinement.entries()].sort((a, b) => a[0] - b[0])
    hasher.writeUint32(entries.length)
    for (const [inmateId, record] of entries) {
      hasher.writeUint32(inmateId)
      hasher.writeFloat64(record.isolationHours)
      hasher.writeFloat64(record.lockdownHours)
      hasher.writeFloat64(record.suppressionExposure)
      hasher.writeFloat64(record.labourHours)
    }
  }
}

/* -------------------------------------------------------------------------- */
/* The four formulas                                                           */
/* -------------------------------------------------------------------------- */

function clamp100(value: number): number {
  if (value <= 0) return 0
  if (value >= 100) return 100
  return value
}

/**
 * Punishment: confinement as a share of the sentence.
 *
 * Weighted, because an hour in solitary is not an hour of cell lockdown, and
 * scaled so the grade reaches 100 well before the whole sentence has been
 * spent confined — `maxHoursScale` is the fraction at which a prison is
 * running a punishment regime by any reasonable reading.
 */
export function punishmentGrade(
  balance: Balance['grades']['punishment'],
  options: {
    readonly isolationHours: number
    readonly lockdownHours: number
    readonly sentenceHours: number
  },
): number {
  if (options.sentenceHours <= 0) return 0
  const weighted =
    options.isolationHours * balance.isolationWeight +
    options.lockdownHours * balance.lockdownWeight
  const ceiling = options.sentenceHours * balance.maxHoursScale
  if (ceiling <= 0) return 0
  return clamp100((weighted / ceiling) * 100)
}

/**
 * Reform: what they learned, less what suppression cost.
 *
 * Sessions passed count as well as programmes completed, so a prison that
 * enrols people and then locks the wing down does not read as if nothing
 * happened — it reads as progress that was undone, which is the point.
 */
export function reformGrade(
  balance: Balance['grades']['reform'],
  options: {
    readonly programsCompleted: number
    readonly sessionsPassed: number
    readonly suppressionExposure: number
    readonly labourHours: number
  },
): number {
  const earned =
    options.programsCompleted * balance.perProgramCompleted +
    options.sessionsPassed * balance.perSessionPassed +
    options.labourHours / balance.labourHoursPerPoint
  const lost = options.suppressionExposure * balance.suppressionPenaltyPerPoint
  return clamp100(earned - lost)
}

/**
 * Security: 100 is a clean sheet, and every recent offence takes a bite.
 *
 * Only the trailing window counts. An inmate who fought in their first month
 * and has been quiet for a year is not a security problem, and a grade that
 * never forgave would make the entitlement ladder pointless.
 */
export function securityGrade(
  balance: Balance['grades']['security'],
  options: {
    readonly minorInWindow: number
    readonly majorInWindow: number
  },
): number {
  const penalty =
    options.minorInWindow * balance.perMinorMisconduct +
    options.majorInWindow * balance.perMajorMisconduct
  return clamp100(100 - penalty)
}

/** Health: met needs, intact body, no live addiction. */
export function healthGrade(
  balance: Balance['grades']['health'],
  options: {
    /** 0..100 mean need level; lower is better. */
    readonly meanNeed: number
    /** 0..100 current health. */
    readonly health: number
    /** 0..1 strongest live addiction. */
    readonly addictionStrength: number
  },
): number {
  const needScore = 100 - clamp100(options.meanNeed)
  const bodyScore = clamp100(options.health)
  const soberScore = 100 * (1 - Math.min(1, Math.max(0, options.addictionStrength)))
  return clamp100(
    needScore * balance.needWeight +
      bodyScore * balance.injuryWeight +
      soberScore * balance.addictionWeight,
  )
}

/**
 * `reoffendChance`, exactly as PRD 5.4 states it.
 *
 * ```
 * clamp(0.55 - 0.10*basicLiteracy - 0.20*vocational - 0.15*joinery
 *            + 0.30*activeAddiction + 0.20*suppressionExposure
 *            - 0.10*healthGrade + 0.15*misconductRate, 0.02, 0.95)
 * ```
 *
 * The programme terms are the three named in the PRD; everything else a
 * programme does to this number arrives through `programmeDelta`, which is the
 * sum of the `reoffend` effects the inmate has actually completed.
 */
export function deriveReoffendChance(
  balance: Balance['reoffend'],
  options: {
    readonly completedBasicLiteracy: boolean
    readonly completedVocational: boolean
    readonly completedJoinery: boolean
    /** 0..1 strongest live addiction. */
    readonly activeAddiction: number
    /** 0..1 normalised suppression exposure. */
    readonly suppressionExposure: number
    /** 0..1 health grade. */
    readonly healthGrade: number
    /** 0..1 normalised misconduct rate. */
    readonly misconductRate: number
    /** Extra deltas from programmes beyond the three named terms. */
    readonly programmeDelta?: number
  },
): number {
  let chance = balance.base
  if (options.completedBasicLiteracy) chance -= balance.basicLiteracy
  if (options.completedVocational) chance -= balance.vocational
  if (options.completedJoinery) chance -= balance.joinery
  chance += balance.activeAddiction * options.activeAddiction
  chance += balance.suppressionExposure * options.suppressionExposure
  chance -= balance.healthGrade * options.healthGrade
  chance += balance.misconductRate * options.misconductRate
  chance += options.programmeDelta ?? 0
  return Math.min(balance.max, Math.max(balance.min, chance))
}

/* -------------------------------------------------------------------------- */
/* Gathering the inputs                                                        */
/* -------------------------------------------------------------------------- */

export function meanNeedOf(entity: InmateEntity): number {
  const needs = entity.inmate.needs
  if (needs.length === 0) return 0
  let sum = 0
  for (let i = 0; i < needs.length; i += 1) sum += needs[i] ?? 0
  return sum / needs.length
}

export function strongestAddiction(entity: InmateEntity): number {
  let strongest = 0
  for (const addiction of entity.inmate.addictions) {
    if (addiction.strength > strongest) strongest = addiction.strength
  }
  return strongest
}

/** Misconduct in the trailing window, split by severity. */
export function misconductInWindow(
  entity: InmateEntity,
  balance: Balance,
  tick: number,
): { readonly minor: number; readonly major: number } {
  const from = tick - balance.grades.security.windowDays * TICKS_PER_DAY
  let minor = 0
  let major = 0
  for (const record of entity.inmate.misconductLog) {
    if (record.tick < from) continue
    if (isMajorMisconduct(balance.misconduct, record.kind as MisconductKind)) major += 1
    else minor += 1
  }
  return { minor, major }
}

/**
 * The whole ledger for one inmate, recomputed from scratch.
 *
 * Exported because the inspector wants the same numbers the system wrote, and
 * recomputing is cheaper than caching a second copy that could drift.
 */
export function computeGrades(
  world: InmateWorld,
  data: GameData,
  entity: InmateEntity,
  tick: number,
): { readonly grades: InmateGrades; readonly reoffendChance: number } {
  const balance = data.balance
  const record = world.grades.recordFor(entity.id)
  const completions = world.programs.completions.get(entity.id) ?? new Set<string>()
  const enrolment = world.programs.enrolments.get(entity.id)
  const misconduct = misconductInWindow(entity, balance, tick)

  const punishment = punishmentGrade(balance.grades.punishment, {
    isolationHours: record.isolationHours,
    lockdownHours: record.lockdownHours,
    sentenceHours: entity.inmate.sentenceHours,
  })

  const reform = reformGrade(balance.grades.reform, {
    programsCompleted: completions.size,
    sessionsPassed: enrolment?.sessionsPassed ?? 0,
    suppressionExposure: record.suppressionExposure,
    labourHours: record.labourHours,
  })

  const security = securityGrade(balance.grades.security, {
    minorInWindow: misconduct.minor,
    majorInWindow: misconduct.major,
  })

  const health = healthGrade(balance.grades.health, {
    meanNeed: meanNeedOf(entity),
    health: entity.inmate.health,
    addictionStrength: strongestAddiction(entity),
  })

  // The misconduct *rate* is offences per window day, normalised so a daily
  // offender reads as 1.
  const windowDays = balance.grades.security.windowDays
  const misconductRate = Math.min(1, (misconduct.minor + misconduct.major) / windowDays)

  const reoffendChance = deriveReoffendChance(balance.reoffend, {
    completedBasicLiteracy: completions.has('basic_literacy'),
    completedVocational: completions.has('vocational_certificate'),
    completedJoinery: completions.has('joinery_apprenticeship'),
    activeAddiction: strongestAddiction(entity),
    suppressionExposure: Math.min(
      1,
      record.suppressionExposure / (balance.suppression.max * windowDays),
    ),
    healthGrade: health / 100,
    misconductRate,
    programmeDelta: otherProgrammeDelta(world, data, entity.id),
  })

  return {
    grades: { punishment, reform, security, health },
    reoffendChance,
  }
}

/**
 * Reoffend deltas from completed programmes other than the three the PRD's
 * formula names outright, so they are not counted twice.
 */
function otherProgrammeDelta(world: InmateWorld, data: GameData, inmateId: number): number {
  const completions = world.programs.completions.get(inmateId)
  if (completions === undefined) return 0
  const named = new Set(['basic_literacy', 'vocational_certificate', 'joinery_apprenticeship'])
  let delta = 0
  for (const programId of completions) {
    if (named.has(programId)) continue
    const def = data.programs.find(programId)
    if (def === undefined) continue
    for (const effect of def.effects) {
      if (effect.type === 'reoffend') delta += effect.delta
    }
  }
  return delta
}

/* -------------------------------------------------------------------------- */
/* The hourly pass                                                             */
/* -------------------------------------------------------------------------- */

export interface GradesSystemOptions {
  readonly data: GameData
}

export function createGradesSystem(options: GradesSystemOptions): System {
  const { data } = options
  let reportedWrongWorld = false

  return {
    name: GRADES_SYSTEM_NAME,
    period: GRADES_SYSTEM_PERIOD,

    update(context: SystemContext): void {
      const world = context.world
      const tick = context.clock.tick

      if (!isInmateWorld(world)) {
        if (reportedWrongWorld) return
        reportedWrongWorld = true
        context.events.emit({
          tick,
          kind: GRADES_EVENTS.rejected,
          causeIds: [],
          data: { reason: 'wrong-world' },
        })
        return
      }

      const hours = data.balance.grades.recomputeHours
      if (hours > 1 && tick % (hours * TICKS_PER_HOUR) !== 0) return

      accrueExposure(world, hours)
      for (const entity of world.inmates.all()) {
        const previous = entity.inmate.grades
        const previousChance = entity.inmate.reoffendChance
        const result = computeGrades(world, data, entity, tick)
        entity.inmate.grades = result.grades
        entity.inmate.reoffendChance = result.reoffendChance

        if (
          previous.punishment !== result.grades.punishment ||
          previous.reform !== result.grades.reform ||
          previous.security !== result.grades.security ||
          previous.health !== result.grades.health ||
          previousChance !== result.reoffendChance
        ) {
          context.events.emit({
            tick,
            kind: GRADES_EVENTS.recomputed,
            subjectId: entity.id,
            causeIds: [],
            data: {
              inmateId: entity.id,
              punishment: result.grades.punishment,
              reform: result.grades.reform,
              security: result.grades.security,
              health: result.grades.health,
              reoffendChance: result.reoffendChance,
            },
          })
        }
      }
    },
  }
}

/**
 * Adds this pass's confinement and suppression to the ledger.
 *
 * Suppression exposure is integrated rather than sampled: an inmate held at 80
 * suppression for a week has been suppressed far more than one who touched 80
 * for an hour, and only the integral tells them apart.
 */
export function accrueExposure(world: InmateWorld, hours: number): void {
  for (const entity of world.inmates.all()) {
    const record = world.grades.recordFor(entity.id)
    record.suppressionExposure += entity.inmate.suppression * hours

    const punishment = world.punishments.get(entity.id)
    if (punishment === undefined) continue
    if (punishment.kind === 'isolation') record.isolationHours += hours
    else if (punishment.kind === 'lockdown') record.lockdownHours += hours
  }
}

/** Credits hours worked, for the reform grade (T5.7). */
export function creditLabourHours(world: InmateWorld, inmateId: number, hours: number): void {
  world.grades.recordFor(inmateId).labourHours += hours
}
