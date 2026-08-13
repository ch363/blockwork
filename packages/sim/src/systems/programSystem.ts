/**
 * `ProgramSystem`: rehabilitation as a mechanic (T5.3, PRD 5.9).
 *
 * A programme is the only thing in the game that makes an inmate better rather
 * than merely quieter, so it is deliberately the hardest thing to run: it
 * needs a tutor on the payroll, a functional room, enough seats, and — the
 * part that catches every new player — a **contiguous** run of `work_*` hours
 * in the routine long enough to hold a session.
 *
 * That last requirement is why this module invests as much in explaining
 * failure as in producing success. `describeBlocker` returns the exact number
 * the prison is short by, because "Literacy is not running" is useless and
 * "the longest work block in the medium routine is 2 hours, Literacy needs 3"
 * is a repair instruction (PRD 5.9's improvement note).
 *
 * Shape of a session:
 *
 *   1. Scheduling picks an hour once a day (or honours the player's pin, once
 *      Delegation is researched).
 *   2. At that hour the session opens: the tutor is pinned to the room and
 *      every enrolled inmate is escorted to it.
 *   3. Each hour the session counts who is actually inside and on a seat.
 *   4. At the end, one success roll per attendee (PRD 5.9's formula).
 *   5. `sessionsRequired` successes complete the programme and apply its
 *      effects.
 *
 * Attendance is counted rather than assumed. An inmate who never arrives
 * learns nothing, which is what makes the escort chain and the routine matter.
 *
 * Slot: PRD 4.4 #15, hourly.
 */

import { HOURS_PER_DAY, TICKS_PER_DAY, TICKS_PER_HOUR } from '../core/clock'
import type { Command, JsonObject, JsonValue } from '../core/commands'
import type { Fnv1aHasher } from '../core/hash'
import type { RngStream } from '../core/rng'
import type { CommandHandler, EventSink, System, SystemContext } from '../core/simulation'
import type { GameData } from '../data/loader'
import type { ProgramDef, RoutineBlockId, StatusEffectId } from '../data/schemas'
import { hasFeature, isUnlocked } from '../entities/directorate'
import type { InmateEntity } from '../entities/inmate'
import { NO_INMATE } from '../entities/inmate'
import { enqueueEscort } from '../entities/staff'
import { NO_ROOM } from '../world/rooms'
import type { Room } from '../world/rooms'

import { isInmateWorld } from './intakeSystem'
import type { InmateWorld } from './intakeSystem'

/* -------------------------------------------------------------------------- */
/* Identity                                                                    */
/* -------------------------------------------------------------------------- */

export const PROGRAM_SYSTEM_NAME = 'programs'

/** PRD 4.4: programmes are hourly. */
export const PROGRAM_SYSTEM_PERIOD = TICKS_PER_HOUR

export const PROGRAM_EVENTS = {
  scheduled: 'program.scheduled',
  blocked: 'program.blocked',
  enrolled: 'program.enrolled',
  sessionStarted: 'program.sessionStarted',
  sessionFinished: 'program.sessionFinished',
  completed: 'program.completed',
  droppedOut: 'program.droppedOut',
  rejected: 'program.rejected',
} as const

/** The RNG stream programmes draw from. */
export const PROGRAM_RNG_STREAM = 'programs'

/** Routine blocks a session may be scheduled into (PRD 5.7). */
export const WORK_BLOCKS: readonly RoutineBlockId[] = ['work_free', 'work_lockup']

/* -------------------------------------------------------------------------- */
/* Blocking reasons                                                            */
/* -------------------------------------------------------------------------- */

export const PROGRAM_BLOCKERS = [
  'locked',
  'no_tutor',
  'no_room',
  'room_not_functional',
  'not_enough_seats',
  'no_contiguous_work_block',
  'no_enrolment',
  'insufficient_funds',
] as const

export type ProgramBlockerKind = (typeof PROGRAM_BLOCKERS)[number]

/**
 * Why a programme cannot run, with the numbers that make it actionable.
 *
 * `have` / `need` are the whole point: the panel renders "Classroom has 6
 * desks, Literacy needs 10", and it can only do that if the simulation carries
 * both halves rather than a boolean.
 */
export interface ProgramBlocker {
  readonly kind: ProgramBlockerKind
  readonly have: number
  readonly need: number
  /** Subject of the shortfall: a room id, a staff role, a category id. */
  readonly subject: string
}

/* -------------------------------------------------------------------------- */
/* Runtime state                                                               */
/* -------------------------------------------------------------------------- */

export interface ProgramEnrolment {
  readonly programId: string
  /** Successful sessions so far. */
  sessionsPassed: number
  /** Consecutive sessions the inmate failed to attend. */
  sessionsMissed: number
  readonly enrolledTick: number
}

export interface ProgramSchedule {
  readonly programId: string
  /** Security category whose routine holds the slot. */
  readonly categoryId: string
  readonly startHour: number
  readonly hours: number
  /** The player pinned this, rather than the scheduler choosing it. */
  readonly pinned: boolean
}

export interface ProgramSession {
  readonly programId: string
  readonly roomId: number
  readonly tutorId: number
  readonly startedTick: number
  readonly endsAtTick: number
  /** Inmate ids counted present on at least one hour of the session. */
  readonly attendees: Set<number>
}

export interface ProgramsSnapshot extends JsonObject {
  readonly enrolments: readonly {
    readonly inmateId: number
    readonly programId: string
    readonly sessionsPassed: number
    readonly sessionsMissed: number
    readonly enrolledTick: number
  }[]
  readonly completions: readonly {
    readonly inmateId: number
    readonly programIds: readonly string[]
  }[]
  readonly pins: readonly {
    readonly programId: string
    readonly categoryId: string
    readonly startHour: number
  }[]
}

/**
 * Everything programmes remember.
 *
 * Enrolments and completions are history and are saved. Schedules, sessions
 * and blockers are derived from the routine, the staff list and the rooms, and
 * are recomputed on the next hourly pass — a saved schedule could disagree
 * with a routine the player edited before saving.
 */
export class ProgramRuntime {
  readonly enrolments = new Map<number, ProgramEnrolment>()
  readonly completions = new Map<number, Set<string>>()
  /** Player-pinned slots, honoured once Delegation is researched. */
  readonly pins = new Map<string, { categoryId: string; startHour: number }>()

  /** Derived: recomputed hourly. */
  readonly schedules = new Map<string, ProgramSchedule>()
  readonly blockers = new Map<string, ProgramBlocker>()
  readonly sessions = new Map<string, ProgramSession>()
  /** Labour assignments and production lines unlocked by completions (T5.7). */
  readonly unlockedLabour = new Map<number, Set<string>>()
  readonly unlockedProduction = new Map<number, Set<string>>()
  /** Trait misconduct multipliers a completed programme overrode (T4.4). */
  readonly traitMisconductOverrides = new Map<number, Map<string, number>>()
  /** Reoffend deltas earned by completion, summed by T5.4. */
  readonly reoffendDeltas = new Map<number, number>()

  hasCompleted(inmateId: number, programId: string): boolean {
    return this.completions.get(inmateId)?.has(programId) === true
  }

  completedCount(programId: string): number {
    let count = 0
    for (const set of this.completions.values()) {
      if (set.has(programId)) count += 1
    }
    return count
  }

  enrolledIn(programId: string): number[] {
    const ids: number[] = []
    for (const [inmateId, enrolment] of this.enrolments) {
      if (enrolment.programId === programId) ids.push(inmateId)
    }
    ids.sort((a, b) => a - b)
    return ids
  }

  recordCompletion(inmateId: number, programId: string): void {
    let set = this.completions.get(inmateId)
    if (set === undefined) {
      set = new Set()
      this.completions.set(inmateId, set)
    }
    set.add(programId)
  }

  clearInmate(inmateId: number): void {
    this.enrolments.delete(inmateId)
    this.completions.delete(inmateId)
    this.unlockedLabour.delete(inmateId)
    this.unlockedProduction.delete(inmateId)
    this.traitMisconductOverrides.delete(inmateId)
    this.reoffendDeltas.delete(inmateId)
  }

  serialise(): ProgramsSnapshot {
    return {
      enrolments: [...this.enrolments.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([inmateId, enrolment]) => ({
          inmateId,
          programId: enrolment.programId,
          sessionsPassed: enrolment.sessionsPassed,
          sessionsMissed: enrolment.sessionsMissed,
          enrolledTick: enrolment.enrolledTick,
        })),
      completions: [...this.completions.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([inmateId, set]) => ({ inmateId, programIds: [...set].sort() })),
      pins: [...this.pins.entries()]
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([programId, pin]) => ({
          programId,
          categoryId: pin.categoryId,
          startHour: pin.startHour,
        })),
    }
  }

  restore(snapshot: ProgramsSnapshot, data: GameData): void {
    this.enrolments.clear()
    this.completions.clear()
    this.pins.clear()
    this.schedules.clear()
    this.blockers.clear()
    this.sessions.clear()
    this.unlockedLabour.clear()
    this.unlockedProduction.clear()
    this.traitMisconductOverrides.clear()
    this.reoffendDeltas.clear()

    for (const entry of snapshot.enrolments) {
      this.enrolments.set(entry.inmateId, {
        programId: entry.programId,
        sessionsPassed: entry.sessionsPassed,
        sessionsMissed: entry.sessionsMissed,
        enrolledTick: entry.enrolledTick,
      })
    }
    for (const entry of snapshot.completions) {
      for (const programId of entry.programIds) {
        this.recordCompletion(entry.inmateId, programId)
        // Effects are re-derived from the completion record rather than saved
        // twice: the definition is the authority on what completing it meant.
        const def = data.programs.find(programId)
        if (def !== undefined) recordEffectBookkeeping(this, entry.inmateId, def)
      }
    }
    for (const entry of snapshot.pins) {
      this.pins.set(entry.programId, {
        categoryId: entry.categoryId,
        startHour: entry.startHour,
      })
    }
  }

  hashInto(hasher: Fnv1aHasher): void {
    const enrolments = [...this.enrolments.entries()].sort((a, b) => a[0] - b[0])
    hasher.writeUint32(enrolments.length)
    for (const [inmateId, enrolment] of enrolments) {
      hasher.writeUint32(inmateId)
      hasher.writeString(enrolment.programId)
      hasher.writeUint32(enrolment.sessionsPassed)
      hasher.writeUint32(enrolment.sessionsMissed)
      hasher.writeUint32(enrolment.enrolledTick)
    }

    const completions = [...this.completions.entries()].sort((a, b) => a[0] - b[0])
    hasher.writeUint32(completions.length)
    for (const [inmateId, set] of completions) {
      hasher.writeUint32(inmateId)
      const ids = [...set].sort()
      hasher.writeUint32(ids.length)
      for (const programId of ids) hasher.writeString(programId)
    }

    const pins = [...this.pins.entries()].sort(([a], [b]) => (a < b ? -1 : 1))
    hasher.writeUint32(pins.length)
    for (const [programId, pin] of pins) {
      hasher.writeString(programId)
      hasher.writeString(pin.categoryId)
      hasher.writeUint32(pin.startHour)
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Scheduling                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * The longest unbroken run of `work_*` hours in a routine strip, and where it
 * starts.
 *
 * Wrapping is deliberately not allowed: a session that begins at 23:00 and ends
 * at 01:00 spans two Routine days, and the block after midnight belongs to
 * tomorrow's schedule, which the player may have edited.
 */
export function longestWorkRun(blocks: readonly RoutineBlockId[]): {
  readonly startHour: number
  readonly hours: number
} {
  let bestStart = 0
  let bestLength = 0
  let runStart = 0
  let runLength = 0

  for (let hour = 0; hour < blocks.length; hour += 1) {
    const block = blocks[hour]
    if (block !== undefined && (WORK_BLOCKS as readonly string[]).includes(block)) {
      if (runLength === 0) runStart = hour
      runLength += 1
      if (runLength > bestLength) {
        bestLength = runLength
        bestStart = runStart
      }
      continue
    }
    runLength = 0
  }

  return { startHour: bestStart, hours: bestLength }
}

/** Every category whose routine could hold this programme, best first. */
function schedulableCategories(
  world: InmateWorld,
  def: ProgramDef,
): { readonly categoryId: string; readonly startHour: number; readonly longest: number }[] {
  const options: { categoryId: string; startHour: number; longest: number }[] = []
  for (const [categoryId, blocks] of world.routines.byCategory) {
    const run = longestWorkRun(blocks)
    options.push({ categoryId, startHour: run.startHour, longest: run.hours })
  }
  options.sort((a, b) => (a.categoryId < b.categoryId ? -1 : 1))
  return options.filter((option) => option.longest >= def.hours)
}

/* -------------------------------------------------------------------------- */
/* Blockers                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * The first thing standing between this programme and a session, with numbers.
 *
 * Order matters: research, then staff, then premises, then seats, then time,
 * then people, then money. It is the order a player would fix them in, and
 * reporting the seat shortfall on a programme whose node is not researched
 * would send them to the wrong shop.
 */
export function describeBlocker(
  world: InmateWorld,
  data: GameData,
  def: ProgramDef,
): ProgramBlocker | undefined {
  if (!isUnlocked(data, world.directorate, 'programs', def.id)) {
    return { kind: 'locked', have: 0, need: 1, subject: def.unlockedBy ?? '' }
  }

  const tutors = countTutors(world, def.tutorStaffId)
  if (tutors === 0) {
    return { kind: 'no_tutor', have: 0, need: 1, subject: def.tutorStaffId }
  }

  const rooms = roomsOfDef(world, def.roomId)
  if (rooms.length === 0) {
    return { kind: 'no_room', have: 0, need: 1, subject: def.roomId }
  }

  const functional = rooms.filter((room) => world.rooms.statusOf(room.id)?.functional === true)
  if (functional.length === 0) {
    return {
      kind: 'room_not_functional',
      have: 0,
      need: 1,
      subject: def.roomId,
    }
  }

  if (def.seatObjectId !== undefined) {
    const best = functional.reduce(
      (most, room) => Math.max(most, world.objects.objectCount(room.id, def.seatObjectId ?? '')),
      0,
    )
    if (best < def.seats) {
      return {
        kind: 'not_enough_seats',
        have: best,
        need: def.seats,
        subject: def.seatObjectId,
      }
    }
  }

  const categories = schedulableCategories(world, def)
  if (categories.length === 0) {
    let longest = 0
    let subject = ''
    for (const [categoryId, blocks] of world.routines.byCategory) {
      const run = longestWorkRun(blocks)
      if (run.hours > longest) {
        longest = run.hours
        subject = categoryId
      }
      if (subject === '') subject = categoryId
    }
    return {
      kind: 'no_contiguous_work_block',
      have: longest,
      need: def.hours,
      subject,
    }
  }

  const enrolled = world.programs.enrolledIn(def.id).length
  if (enrolled === 0) {
    return { kind: 'no_enrolment', have: 0, need: 1, subject: def.id }
  }

  if (world.economy.balance < def.costPerSession) {
    return {
      kind: 'insufficient_funds',
      have: world.economy.balance,
      need: def.costPerSession,
      subject: def.id,
    }
  }

  return undefined
}

function countTutors(world: InmateWorld, staffDefId: string): number {
  let count = 0
  for (const entity of world.staff.all()) {
    if (entity.staff.defId === staffDefId) count += 1
  }
  return count
}

function roomsOfDef(world: InmateWorld, roomDefId: string): Room[] {
  return world.rooms.all().filter((room) => room.defId === roomDefId)
}

/* -------------------------------------------------------------------------- */
/* Enrolment                                                                   */
/* -------------------------------------------------------------------------- */

/** Whether a referred programme's trigger condition holds for this inmate. */
export function isReferralCandidate(entity: InmateEntity, def: ProgramDef): boolean {
  const referral = def.referral
  if (referral === undefined) return false
  if (referral.addiction !== undefined) {
    return entity.inmate.addictions.some(
      (addiction) => addiction.substance === referral.addiction && addiction.strength > 0,
    )
  }
  if (referral.traitId !== undefined) {
    return entity.inmate.traits.includes(referral.traitId)
  }
  return false
}

/**
 * Whether an inmate is eligible at all: not already enrolled, not already
 * finished, prerequisite done, and — for a voluntary programme — not so
 * suppressed that they refuse (PRD 5.11).
 */
export function isEligible(
  world: InmateWorld,
  data: GameData,
  entity: InmateEntity,
  def: ProgramDef,
): boolean {
  if (world.programs.enrolments.has(entity.id)) return false
  if (world.programs.hasCompleted(entity.id, def.id)) return false
  if (
    def.prerequisiteProgramId !== undefined &&
    !world.programs.hasCompleted(entity.id, def.prerequisiteProgramId)
  ) {
    return false
  }
  if (
    def.attendance === 'voluntary' &&
    entity.inmate.suppression > data.balance.suppression.voluntaryRefusalThreshold
  ) {
    return false
  }
  return true
}

/**
 * The chance an eligible inmate opts into a voluntary programme this pass.
 *
 * Mood is the lever: a prison where needs are met produces volunteers, and one
 * where they are not produces a waiting list of nobody. Suppression takes its
 * cut on top, which is the trade the player is being shown — a quiet wing that
 * learns nothing.
 */
export function voluntaryOptInChance(
  data: GameData,
  meanNeed: number,
  suppression: number,
): number {
  const cfg = data.balance.programs
  const mood = 1 - Math.min(1, Math.max(0, meanNeed / 100))
  const base =
    cfg.voluntaryBaseChancePerDay * (1 - cfg.voluntaryMoodWeight + cfg.voluntaryMoodWeight * mood)
  const suppressed =
    base * (1 - cfg.suppressionFactor * (suppression / data.balance.suppression.max))
  return Math.min(1, Math.max(0, suppressed))
}

function meanNeedOf(entity: InmateEntity): number {
  const needs = entity.inmate.needs
  if (needs.length === 0) return 0
  let sum = 0
  for (let i = 0; i < needs.length; i += 1) sum += needs[i] ?? 0
  return sum / needs.length
}

/** Enrols one inmate, or reports why not. */
export function enrol(
  world: InmateWorld,
  data: GameData,
  events: EventSink,
  tick: number,
  inmateId: number,
  programId: string,
): boolean {
  const entity = world.inmates.get(inmateId)
  const def = data.programs.find(programId)
  if (entity === undefined || def === undefined) return false
  if (!isEligible(world, data, entity, def)) return false

  const cap = def.seats * data.balance.programs.enrolmentCapMultiplier
  if (world.programs.enrolledIn(programId).length >= cap) return false

  world.programs.enrolments.set(inmateId, {
    programId,
    sessionsPassed: 0,
    sessionsMissed: 0,
    enrolledTick: tick,
  })
  events.emit({
    tick,
    kind: PROGRAM_EVENTS.enrolled,
    subjectId: inmateId,
    causeIds: [],
    data: { programId, attendance: def.attendance },
  })
  return true
}

/** One enrolment pass: referrals first, then volunteers. */
export function runEnrolment(
  world: InmateWorld,
  data: GameData,
  events: EventSink,
  rng: RngStream,
  tick: number,
): void {
  for (const def of data.programs.all) {
    if (world.programs.blockers.get(def.id)?.kind === 'locked') continue

    for (const entity of world.inmates.all()) {
      if (!isEligible(world, data, entity, def)) continue

      if (def.attendance === 'referred') {
        if (!isReferralCandidate(entity, def)) continue
        enrol(world, data, events, tick, entity.id, def.id)
        continue
      }

      if (def.attendance === 'voluntary') {
        const chance = voluntaryOptInChance(data, meanNeedOf(entity), entity.inmate.suppression)
        // Draw every pass so a balance edit cannot shift the stream.
        if (!rng.chance(chance / HOURS_PER_DAY)) continue
        enrol(world, data, events, tick, entity.id, def.id)
      }
      // `mandatory` and `queue` are placed by command, not by this pass.
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Sessions                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * The per-session success chance for one inmate (PRD 5.9).
 *
 * ```
 * p = difficultyBase
 *   * (concentrationBase + concentrationScale * concentration)
 *   * (1 - suppressionFactor * suppressionNormalised)
 *   * aptitude
 * ```
 */
export function sessionSuccessChance(
  data: GameData,
  def: ProgramDef,
  options: {
    readonly meanNeed: number
    readonly suppression: number
    readonly aptitude: number
  },
): number {
  const cfg = data.balance.programs
  const base = cfg.difficultyBase[def.difficulty]
  const concentration = 1 - Math.min(1, Math.max(0, options.meanNeed / 100))
  const suppressionNormalised = Math.min(
    1,
    Math.max(0, options.suppression / data.balance.suppression.max),
  )
  const p =
    base *
    (cfg.concentrationBase + cfg.concentrationScale * concentration) *
    (1 - cfg.suppressionFactor * suppressionNormalised) *
    options.aptitude
  return Math.min(1, Math.max(0, p))
}

function openSession(
  world: InmateWorld,
  events: EventSink,
  tick: number,
  def: ProgramDef,
  schedule: ProgramSchedule,
): void {
  const room = roomsOfDef(world, def.roomId).find(
    (candidate) => world.rooms.statusOf(candidate.id)?.functional === true,
  )
  if (room === undefined) return

  const tutor = world.staff.all().find((entity) => entity.staff.defId === def.tutorStaffId)
  if (tutor === undefined) return

  const tile = room.tiles[0]
  if (tile === undefined) return

  if (def.costPerSession > 0) {
    world.economy.debit(tick, 'program', def.costPerSession, `Session: ${def.name}`, 0)
  }

  // The tutor holds the room for the session's length.
  tutor.staff.pinnedTile = tile

  const session: ProgramSession = {
    programId: def.id,
    roomId: room.id,
    tutorId: tutor.id,
    startedTick: tick,
    endsAtTick: tick + def.hours * TICKS_PER_HOUR,
    attendees: new Set(),
  }
  world.programs.sessions.set(def.id, session)

  // Everyone enrolled is sent to the room. Whether they arrive is the
  // simulation's business, and attendance is counted, not assumed.
  for (const inmateId of world.programs.enrolledIn(def.id)) {
    const entity = world.inmates.get(inmateId)
    if (entity === undefined || inmateId === NO_INMATE) continue
    if (world.grid.getAt('roomId', world.grid.idx(entity.tx, entity.ty)) === room.id) continue
    enqueueEscort({
      world,
      inmateId,
      destinationTile: tile,
      purpose: 'program',
      events,
      tick,
    })
  }

  events.emit({
    tick,
    kind: PROGRAM_EVENTS.sessionStarted,
    subjectId: room.id,
    causeIds: [],
    data: {
      programId: def.id,
      roomId: room.id,
      tutorId: tutor.id,
      categoryId: schedule.categoryId,
      hours: def.hours,
      enrolled: world.programs.enrolledIn(def.id).length,
      costPerSession: def.costPerSession,
    },
  })
}

/** Counts who is in the room this hour. Called once per session hour. */
function markAttendance(world: InmateWorld, session: ProgramSession): void {
  for (const inmateId of world.programs.enrolledIn(session.programId)) {
    const entity = world.inmates.get(inmateId)
    if (entity === undefined) continue
    const tile = world.grid.idx(entity.tx, entity.ty)
    if (world.grid.getAt('roomId', tile) !== session.roomId) continue
    session.attendees.add(inmateId)
  }
}

function closeSession(
  world: InmateWorld,
  data: GameData,
  events: EventSink,
  rng: RngStream,
  tick: number,
  def: ProgramDef,
  session: ProgramSession,
): void {
  world.programs.sessions.delete(def.id)
  const tutor = world.staff.get(session.tutorId)
  if (tutor !== undefined) tutor.staff.pinnedTile = -1

  // Seats cap how many the session can actually teach; the rest of the room
  // stands and learns nothing this hour.
  const seated = [...session.attendees].sort((a, b) => a - b).slice(0, def.seats)
  const seatedSet = new Set(seated)
  let passes = 0

  for (const inmateId of world.programs.enrolledIn(def.id)) {
    const enrolment = world.programs.enrolments.get(inmateId)
    const entity = world.inmates.get(inmateId)
    if (enrolment === undefined || entity === undefined) continue

    if (!seatedSet.has(inmateId)) {
      enrolment.sessionsMissed += 1
      if (enrolment.sessionsMissed >= data.balance.programs.sessionsBeforeDropOut) {
        world.programs.enrolments.delete(inmateId)
        events.emit({
          tick,
          kind: PROGRAM_EVENTS.droppedOut,
          subjectId: inmateId,
          causeIds: [],
          data: { programId: def.id, sessionsMissed: enrolment.sessionsMissed },
        })
      }
      continue
    }

    enrolment.sessionsMissed = 0
    const chance = sessionSuccessChance(data, def, {
      meanNeed: meanNeedOf(entity),
      suppression: entity.inmate.suppression,
      aptitude: entity.inmate.aptitude,
    })
    // Always draw, so one inmate's outcome cannot shift another's stream.
    const passed = rng.chance(chance)
    if (!passed) continue

    passes += 1
    enrolment.sessionsPassed += 1
    if (enrolment.sessionsPassed < def.sessionsRequired) continue

    world.programs.enrolments.delete(inmateId)
    world.programs.recordCompletion(inmateId, def.id)
    applyProgramEffects(world, events, tick, entity, def)
    events.emit({
      tick,
      kind: PROGRAM_EVENTS.completed,
      subjectId: inmateId,
      causeIds: [],
      data: { programId: def.id, sessions: def.sessionsRequired },
    })
  }

  events.emit({
    tick,
    kind: PROGRAM_EVENTS.sessionFinished,
    subjectId: session.roomId,
    causeIds: [],
    data: {
      programId: def.id,
      attended: session.attendees.size,
      seated: seated.length,
      passes,
    },
  })
}

/* -------------------------------------------------------------------------- */
/* Effects                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * The bookkeeping half of an effect — the part that is re-derivable from "this
 * inmate completed this programme", and therefore is not saved separately.
 */
function recordEffectBookkeeping(runtime: ProgramRuntime, inmateId: number, def: ProgramDef): void {
  for (const effect of def.effects) {
    switch (effect.type) {
      case 'unlockLabour': {
        const set = runtime.unlockedLabour.get(inmateId) ?? new Set<string>()
        set.add(effect.assignment)
        runtime.unlockedLabour.set(inmateId, set)
        break
      }
      case 'unlockProduction': {
        const set = runtime.unlockedProduction.get(inmateId) ?? new Set<string>()
        set.add(effect.productionId)
        runtime.unlockedProduction.set(inmateId, set)
        break
      }
      case 'traitMisconductMultiplier': {
        const map = runtime.traitMisconductOverrides.get(inmateId) ?? new Map<string, number>()
        map.set(effect.traitId, effect.value)
        runtime.traitMisconductOverrides.set(inmateId, map)
        break
      }
      case 'reoffend': {
        const current = runtime.reoffendDeltas.get(inmateId) ?? 0
        runtime.reoffendDeltas.set(inmateId, current + effect.delta)
        break
      }
      default:
        break
    }
  }
}

/**
 * Applies a completed programme to the inmate.
 *
 * Split from `recordEffectBookkeeping` because the two have different
 * lifetimes: shrinking an addiction changes the inmate and must happen once,
 * whereas "workshop is unlocked for this inmate" is a fact about the
 * completion and is rebuilt on load.
 */
export function applyProgramEffects(
  world: InmateWorld,
  events: EventSink,
  tick: number,
  entity: InmateEntity,
  def: ProgramDef,
): void {
  recordEffectBookkeeping(world.programs, entity.id, def)

  for (const effect of def.effects) {
    switch (effect.type) {
      case 'addictionStrength': {
        // Replaced wholesale rather than mutated in place: the entries are
        // readonly, and a completion is a new fact about the inmate.
        entity.inmate.addictions = entity.inmate.addictions.map((addiction) => ({
          substance: addiction.substance,
          strength: addiction.strength * effect.multiplier,
        }))
        break
      }
      case 'applyStatus': {
        applyStatusWithSpread(world, entity, effect.statusId, effect.spreadTiles ?? 0)
        break
      }
      case 'staffCapability': {
        // A staff certification programme; the capability lands on the role,
        // not on the inmate who happened to sit the session.
        events.emit({
          tick,
          kind: PROGRAM_EVENTS.completed,
          subjectId: entity.id,
          causeIds: [],
          data: { programId: def.id, staffCapability: effect.capability },
        })
        break
      }
      case 'suppressNeedWhileEnrolled':
      case 'unlockLabour':
      case 'unlockProduction':
      case 'traitMisconductMultiplier':
      case 'reoffend':
      case 'paroleHearing':
        // Handled by bookkeeping above, by the enrolment check, or by T5.4.
        break
    }
  }
}

function applyStatusWithSpread(
  world: InmateWorld,
  entity: InmateEntity,
  statusId: StatusEffectId,
  spreadTiles: number,
): void {
  addStatus(entity, statusId)
  if (spreadTiles <= 0) return
  for (const other of world.inmates.all()) {
    if (other.id === entity.id) continue
    const distance = Math.max(Math.abs(other.tx - entity.tx), Math.abs(other.ty - entity.ty))
    if (distance > spreadTiles) continue
    addStatus(other, statusId)
  }
}

function addStatus(entity: InmateEntity, statusId: StatusEffectId): void {
  if (entity.inmate.status.includes(statusId)) return
  entity.inmate.status.push(statusId)
}

/**
 * The need a programme suppresses while an inmate is enrolled, or undefined.
 *
 * `needsSystem` consults this rather than the effect list so the suppression
 * ends the moment the enrolment does.
 */
export function suppressedNeedFor(
  world: InmateWorld,
  data: GameData,
  inmateId: number,
): string | undefined {
  const enrolment = world.programs.enrolments.get(inmateId)
  if (enrolment === undefined) return undefined
  const def = data.programs.find(enrolment.programId)
  if (def === undefined) return undefined
  for (const effect of def.effects) {
    if (effect.type === 'suppressNeedWhileEnrolled') return effect.needId
  }
  return undefined
}

/** The trait misconduct multiplier a completed programme set, if any (T4.4). */
export function traitMisconductMultiplierFor(
  world: InmateWorld,
  inmateId: number,
  traitId: string,
): number | undefined {
  return world.programs.traitMisconductOverrides.get(inmateId)?.get(traitId)
}

/* -------------------------------------------------------------------------- */
/* The hourly pass                                                             */
/* -------------------------------------------------------------------------- */

export interface ProgramSystemOptions {
  readonly data: GameData
}

export function createProgramSystem(options: ProgramSystemOptions): System {
  const { data } = options
  let reportedWrongWorld = false

  return {
    name: PROGRAM_SYSTEM_NAME,
    period: PROGRAM_SYSTEM_PERIOD,

    update(context: SystemContext): void {
      const world = context.world
      const tick = context.clock.tick

      if (!isInmateWorld(world)) {
        if (reportedWrongWorld) return
        reportedWrongWorld = true
        context.events.emit({
          tick,
          kind: PROGRAM_EVENTS.rejected,
          causeIds: [],
          data: { reason: 'wrong-world' },
        })
        return
      }

      const rng = context.rng.stream(PROGRAM_RNG_STREAM)
      refreshSchedules(world, data, context.events, tick)
      runEnrolment(world, data, context.events, rng, tick)
      advanceSessions(world, data, context.events, rng, tick)
    },
  }
}

/**
 * Recomputes each programme's slot and blocker.
 *
 * Runs every hour rather than daily because everything it reads can change
 * within the hour — a tutor is fired, a classroom loses its last desk, the
 * routine is edited — and a blocking reason a day out of date is worse than no
 * blocking reason at all.
 */
export function refreshSchedules(
  world: InmateWorld,
  data: GameData,
  events: EventSink,
  tick: number,
): void {
  world.programs.schedules.clear()

  for (const def of data.programs.all) {
    const blocker = describeBlocker(world, data, def)
    const previous = world.programs.blockers.get(def.id)

    if (blocker !== undefined) {
      world.programs.blockers.set(def.id, blocker)
      // One event per change, not one per hour: the panel reads the state, and
      // the Trace only wants to know when it moved.
      if (previous?.kind !== blocker.kind || previous.have !== blocker.have) {
        events.emit({
          tick,
          kind: PROGRAM_EVENTS.blocked,
          causeIds: [],
          data: {
            programId: def.id,
            reason: blocker.kind,
            have: blocker.have,
            need: blocker.need,
            subject: blocker.subject,
          },
        })
      }
      continue
    }

    world.programs.blockers.delete(def.id)
    const schedule = pickSchedule(world, data, def)
    if (schedule === undefined) continue
    world.programs.schedules.set(def.id, schedule)
    if (previous !== undefined) {
      events.emit({
        tick,
        kind: PROGRAM_EVENTS.scheduled,
        causeIds: [],
        data: {
          programId: def.id,
          categoryId: schedule.categoryId,
          startHour: schedule.startHour,
          hours: schedule.hours,
          pinned: schedule.pinned,
        },
      })
    }
  }
}

function pickSchedule(
  world: InmateWorld,
  data: GameData,
  def: ProgramDef,
): ProgramSchedule | undefined {
  const pin = world.programs.pins.get(def.id)
  if (pin !== undefined && hasFeature(data, world.directorate, 'program_scheduler')) {
    const blocks = world.routines.byCategory.get(pin.categoryId)
    if (blocks !== undefined && runFitsAt(blocks, pin.startHour, def.hours)) {
      return {
        programId: def.id,
        categoryId: pin.categoryId,
        startHour: pin.startHour,
        hours: def.hours,
        pinned: true,
      }
    }
  }

  const option = schedulableCategories(world, def)[0]
  if (option === undefined) return undefined
  return {
    programId: def.id,
    categoryId: option.categoryId,
    startHour: option.startHour,
    hours: def.hours,
    pinned: false,
  }
}

/** Whether `hours` contiguous work blocks start exactly at `startHour`. */
export function runFitsAt(
  blocks: readonly RoutineBlockId[],
  startHour: number,
  hours: number,
): boolean {
  if (startHour < 0 || startHour + hours > blocks.length) return false
  for (let offset = 0; offset < hours; offset += 1) {
    const block = blocks[startHour + offset]
    if (block === undefined || !(WORK_BLOCKS as readonly string[]).includes(block)) return false
  }
  return true
}

function advanceSessions(
  world: InmateWorld,
  data: GameData,
  events: EventSink,
  rng: RngStream,
  tick: number,
): void {
  const hour = Math.floor((tick % TICKS_PER_DAY) / TICKS_PER_HOUR)

  // Running sessions first: attendance this hour, then closure.
  for (const def of data.programs.all) {
    const session = world.programs.sessions.get(def.id)
    if (session === undefined) continue
    markAttendance(world, session)
    if (tick < session.endsAtTick) continue
    closeSession(world, data, events, rng, tick, def, session)
  }

  for (const def of data.programs.all) {
    if (world.programs.sessions.has(def.id)) continue
    const schedule = world.programs.schedules.get(def.id)
    if (schedule === undefined || schedule.startHour !== hour) continue
    openSession(world, events, tick, def, schedule)
  }
}

/* -------------------------------------------------------------------------- */
/* Commands                                                                    */
/* -------------------------------------------------------------------------- */

export const PROGRAM_COMMANDS = {
  /** Manual pinning; needs Delegation (`program_scheduler`). */
  pinSession: 'program.pin',
  unpinSession: 'program.unpin',
  /** Staff-directed enrolment for `mandatory` programmes. */
  enrol: 'program.enrol',
  withdraw: 'program.withdraw',
} as const

export function programCommandHandlers(data: GameData): Readonly<Record<string, CommandHandler>> {
  return {
    [PROGRAM_COMMANDS.pinSession]: (command, context) => {
      handlePin(command, context, data)
    },
    [PROGRAM_COMMANDS.unpinSession]: (command, context) => {
      const world = context.world
      if (!isInmateWorld(world)) return
      const programId = readString(command.payload, 'programId')
      if (programId === undefined) return
      world.programs.pins.delete(programId)
    },
    [PROGRAM_COMMANDS.enrol]: (command, context) => {
      const world = context.world
      if (!isInmateWorld(world)) return
      const programId = readString(command.payload, 'programId')
      const inmateId = readInt(command.payload, 'inmateId')
      if (programId === undefined || inmateId === undefined) return
      enrol(world, data, context.events, context.clock.tick, inmateId, programId)
    },
    [PROGRAM_COMMANDS.withdraw]: (command, context) => {
      const world = context.world
      if (!isInmateWorld(world)) return
      const inmateId = readInt(command.payload, 'inmateId')
      if (inmateId === undefined) return
      world.programs.enrolments.delete(inmateId)
    },
  }
}

function handlePin(command: Command, context: SystemContext, data: GameData): void {
  const world = context.world
  const tick = context.clock.tick
  if (!isInmateWorld(world)) return

  const programId = readString(command.payload, 'programId')
  const categoryId = readString(command.payload, 'categoryId')
  const startHour = readInt(command.payload, 'startHour')
  if (programId === undefined || categoryId === undefined || startHour === undefined) {
    reject(context.events, tick, 'invalid-payload', { programId: programId ?? '' })
    return
  }

  if (!hasFeature(data, world.directorate, 'program_scheduler')) {
    reject(context.events, tick, 'feature-locked', {
      programId,
      featureId: 'program_scheduler',
    })
    return
  }

  const def = data.programs.find(programId)
  if (def === undefined) {
    reject(context.events, tick, 'unknown-program', { programId })
    return
  }

  const blocks = world.routines.byCategory.get(categoryId)
  if (blocks === undefined || !runFitsAt(blocks, startHour, def.hours)) {
    reject(context.events, tick, 'no_contiguous_work_block', {
      programId,
      categoryId,
      startHour,
      need: def.hours,
    })
    return
  }

  world.programs.pins.set(programId, { categoryId, startHour })
}

function reject(events: EventSink, tick: number, reason: string, detail: JsonObject): void {
  events.emit({
    tick,
    kind: PROGRAM_EVENTS.rejected,
    causeIds: [],
    data: { reason, ...detail },
  })
}

function readString(payload: JsonValue, key: string): string | undefined {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return undefined
  const value = (payload as JsonObject)[key]
  return typeof value === 'string' ? value : undefined
}

function readInt(payload: JsonValue, key: string): number | undefined {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return undefined
  const value = (payload as JsonObject)[key]
  return typeof value === 'number' && Number.isInteger(value) ? value : undefined
}

export { NO_ROOM }
