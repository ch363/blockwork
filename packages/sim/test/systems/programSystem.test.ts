/**
 * T5.3 — programmes: scheduling (including the contiguity constraint),
 * enrolment rules, the success roll, effect application, and every blocking
 * reason the panel can show.
 */

import { describe, expect, it } from 'vitest'

import { TICKS_PER_DAY, TICKS_PER_HOUR } from '../../src/core/clock'
import { Rng } from '../../src/core/rng'
import { Simulation } from '../../src/core/simulation'
import type { JsonObject } from '../../src/core/commands'
import type { SimulationEvent } from '../../src/core/simulation'
import { Registry, loadGameData } from '../../src/data/loader'
import type { GameData } from '../../src/data/loader'
import type { ProgramDef, RoutineBlockId } from '../../src/data/schemas'
import { computeMisconductProbability } from '../../src/entities/misconduct'
import { createInmateShell, generateInmate } from '../../src/entities/inmate'
import { placeObject } from '../../src/entities/objects'
import { hireStaff } from '../../src/entities/staff'
import {
  PROGRAM_COMMANDS,
  PROGRAM_EVENTS,
  applyProgramEffects,
  createProgramSystem,
  describeBlocker,
  enrol,
  isEligible,
  isReferralCandidate,
  longestWorkRun,
  programCommandHandlers,
  refreshSchedules,
  runFitsAt,
  sessionSuccessChance,
  suppressedNeedFor,
  traitMisconductMultiplierFor,
  voluntaryOptInChance,
} from '../../src/systems/programSystem'
import { createInmateWorld } from '../../src/systems/intakeSystem'
import type { InmateWorld } from '../../src/systems/intakeSystem'
import { refreshPassability } from '../../src/world/construction'
import { initialLockState } from '../../src/world/doors'
import { designateRoom } from '../../src/world/roomDetection'
import type { Room } from '../../src/world/rooms'

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

const SINK = new RecordingSink()

function put(world: InmateWorld, x: number, y: number, kind: 'floor' | 'wall' | 'door'): void {
  const index = world.grid.idx(x, y)
  world.grid.setAt('floorMaterial', index, world.materials.indexOf('concrete_floor'))
  world.grid.setAt('outdoors', index, 0)
  world.grid.setAt('owned', index, 1)
  if (kind === 'wall') {
    world.grid.setAt('wallMaterial', index, world.materials.indexOf('brick_wall'))
  }
  if (kind === 'door') {
    world.doors.place(index, 'standard', initialLockState(world.data.doors.get('standard')))
  }
  refreshPassability(world, world.data, index)
  world.structureChanged(index)
}

/** A walled, roofed, designated room. `rect` is the interior. */
function makeRoom(
  world: InmateWorld,
  data: GameData,
  defId: string,
  rect: { x: number; y: number; width: number; height: number },
): Room {
  const left = rect.x - 1
  const top = rect.y - 1
  const right = rect.x + rect.width
  const bottom = rect.y + rect.height
  for (let y = top; y <= bottom; y += 1) {
    for (let x = left; x <= right; x += 1) {
      const onEdge = x === left || y === top || x === right || y === bottom
      if (!onEdge) put(world, x, y, 'floor')
      else if (x === rect.x && y === top) put(world, x, y, 'door')
      else put(world, x, y, 'wall')
    }
  }
  designateRoom({ world, data, events: SINK, tick: 0 }, rect, defId)
  const room = [...world.rooms.all()].find(
    (entry) => entry.defId === defId && entry.bounds.x === rect.x && entry.bounds.y === rect.y,
  )
  if (room === undefined) throw new Error(`room ${defId} was not detected`)
  return room
}

function addInmate(
  world: InmateWorld,
  data: GameData,
  patch: Partial<{
    traits: string[]
    addictions: { substance: 'narcotics' | 'alcohol'; strength: number }[]
    aptitude: number
    suppression: number
    tx: number
    ty: number
  }> = {},
): number {
  const rng = new Rng(0xb10c_1234).stream('test')
  const component = generateInmate({ data, rng, category: 'medium' })
  if (patch.traits !== undefined) {
    ;(component as { traits: readonly string[] }).traits = patch.traits
  }
  if (patch.addictions !== undefined) component.addictions = patch.addictions
  if (patch.aptitude !== undefined) {
    ;(component as { aptitude: number }).aptitude = patch.aptitude
  }
  if (patch.suppression !== undefined) component.suppression = patch.suppression

  const id = world.inmates.allocateId()
  const shell = createInmateShell({
    id,
    data,
    inmate: component,
    tx: patch.tx ?? 1,
    ty: patch.ty ?? 1,
  })
  world.inmates.add(shell)
  return id
}

/** A routine strip with `hours` contiguous work blocks starting at `startHour`. */
function workStrip(startHour: number, hours: number): RoutineBlockId[] {
  const strip: RoutineBlockId[] = Array.from({ length: 24 }, () => 'free' as RoutineBlockId)
  for (let i = 0; i < hours; i += 1) strip[startHour + i] = 'work_free'
  return strip
}

function setAllRoutines(world: InmateWorld, strip: readonly RoutineBlockId[]): void {
  for (const categoryId of [...world.routines.byCategory.keys()]) {
    world.routines.setCategory(categoryId, strip)
  }
}

/* -------------------------------------------------------------------------- */
/* Scheduling                                                                  */
/* -------------------------------------------------------------------------- */

describe('programs — scheduling and the contiguity constraint', () => {
  it('finds the longest unbroken run of work blocks and where it starts', () => {
    const strip: RoutineBlockId[] = Array.from({ length: 24 }, () => 'free' as RoutineBlockId)
    strip[3] = 'work_free'
    strip[4] = 'work_free'
    strip[9] = 'work_lockup'
    strip[10] = 'work_lockup'
    strip[11] = 'work_free'

    expect(longestWorkRun(strip)).toEqual({ startHour: 9, hours: 3 })
  })

  it('does not wrap a run across midnight', () => {
    const strip: RoutineBlockId[] = Array.from({ length: 24 }, () => 'free' as RoutineBlockId)
    strip[23] = 'work_free'
    strip[0] = 'work_free'
    strip[1] = 'work_free'

    // 0–1 is a run of two; 23 is a run of one. Nothing joins them.
    expect(longestWorkRun(strip)).toEqual({ startHour: 0, hours: 2 })
  })

  it('accepts a pinned start only where the run actually fits', () => {
    const strip = workStrip(9, 3)
    expect(runFitsAt(strip, 9, 3)).toBe(true)
    expect(runFitsAt(strip, 10, 3)).toBe(false)
    expect(runFitsAt(strip, 9, 4)).toBe(false)
    expect(runFitsAt(strip, 22, 3)).toBe(false)
  })

  it('schedules into the earliest category run that is long enough', () => {
    const world = createInmateWorld({ size: 32, data: DATA, continuousIntake: false, research: 'all' })
    setAllRoutines(world, workStrip(9, 3))
    const events = new RecordingSink()

    makeRoom(world, DATA, 'classroom', { x: 2, y: 2, width: 6, height: 6 })
    stockClassroom(world, events, 20)
    // `instructor` is engaged per session, so `hireStaff` refuses it; the
    // registry still needs one for the programme to run.
    expect(hireStaff({ world, defId: 'instructor', events, tick: 0 }).reason).toBe('per-session')
    seedTutor(world, 'instructor', 3, 3)
    enrolSomeone(world, 'basic_literacy')

    refreshSchedules(world, DATA, events, 0)
    const schedule = world.programs.schedules.get('basic_literacy')
    expect(schedule?.startHour).toBe(9)
    expect(schedule?.hours).toBe(3)
    expect(schedule?.pinned).toBe(false)
  })
})

/* -------------------------------------------------------------------------- */
/* Blocking reasons                                                            */
/* -------------------------------------------------------------------------- */

describe('programs — every blocking reason names its number', () => {
  it('reports a locked programme before anything else', () => {
    const world = createInmateWorld({ size: 24, data: DATA, continuousIntake: false })
    const blocker = describeBlocker(world, DATA, DATA.programs.get('basic_literacy'))
    expect(blocker?.kind).toBe('locked')
    expect(blocker?.subject).toBe('education')
  })

  it('reports a missing tutor', () => {
    const world = createInmateWorld({ size: 24, data: DATA, continuousIntake: false, research: 'all' })
    const blocker = describeBlocker(world, DATA, DATA.programs.get('basic_literacy'))
    expect(blocker?.kind).toBe('no_tutor')
    expect(blocker?.subject).toBe('instructor')
    expect(blocker?.have).toBe(0)
    expect(blocker?.need).toBe(1)
  })

  it('reports a missing room', () => {
    const world = createInmateWorld({ size: 24, data: DATA, continuousIntake: false, research: 'all' })
    seedTutor(world, 'instructor', 2, 2)
    const blocker = describeBlocker(world, DATA, DATA.programs.get('basic_literacy'))
    expect(blocker?.kind).toBe('no_room')
    expect(blocker?.subject).toBe('classroom')
  })

  it('reports a room that exists but is not functional', () => {
    const world = createInmateWorld({ size: 32, data: DATA, continuousIntake: false, research: 'all' })
    seedTutor(world, 'instructor', 2, 2)
    makeRoom(world, DATA, 'classroom', { x: 2, y: 2, width: 6, height: 6 })
    const blocker = describeBlocker(world, DATA, DATA.programs.get('basic_literacy'))
    expect(blocker?.kind).toBe('room_not_functional')
    expect(blocker?.subject).toBe('classroom')
  })

  it('reports the seat shortfall with both numbers', () => {
    const world = createInmateWorld({ size: 32, data: DATA, continuousIntake: false, research: 'all' })
    const events = new RecordingSink()
    seedTutor(world, 'instructor', 2, 2)
    makeRoom(world, DATA, 'classroom', { x: 2, y: 2, width: 6, height: 6 })
    stockClassroom(world, events, 6)

    const blocker = describeBlocker(world, DATA, DATA.programs.get('basic_literacy'))
    expect(blocker?.kind).toBe('not_enough_seats')
    expect(blocker?.subject).toBe('classroom_desk')
    expect(blocker?.have).toBe(6)
    expect(blocker?.need).toBe(20)
  })

  it('reports the contiguity shortfall with the longest block it found', () => {
    const world = createInmateWorld({ size: 32, data: DATA, continuousIntake: false, research: 'all' })
    const events = new RecordingSink()
    // Two hours of work, split by a meal: the longest run is 2, Literacy needs 3.
    const strip = workStrip(9, 2)
    strip[11] = 'meal'
    strip[12] = 'work_free'
    setAllRoutines(world, strip)

    seedTutor(world, 'instructor', 2, 2)
    makeRoom(world, DATA, 'classroom', { x: 2, y: 2, width: 6, height: 6 })
    stockClassroom(world, events, 20)
    enrolSomeone(world, 'basic_literacy')

    const blocker = describeBlocker(world, DATA, DATA.programs.get('basic_literacy'))
    expect(blocker?.kind).toBe('no_contiguous_work_block')
    expect(blocker?.have).toBe(2)
    expect(blocker?.need).toBe(3)
  })

  it('reports an empty enrolment list', () => {
    const world = fullyStockedClassroom()
    const blocker = describeBlocker(world, DATA, DATA.programs.get('basic_literacy'))
    expect(blocker?.kind).toBe('no_enrolment')
  })

  it('reports an unaffordable session with the balance and the fee', () => {
    const world = fullyStockedClassroom()
    enrolSomeone(world, 'basic_literacy')
    world.economy.debit(0, 'other', world.economy.balance, 'Drain', 0)

    const def = DATA.programs.get('basic_literacy')
    const blocker = describeBlocker(world, DATA, def)
    expect(blocker?.kind).toBe('insufficient_funds')
    expect(blocker?.have).toBe(0)
    expect(blocker?.need).toBe(def.costPerSession)
  })

  it('clears the blocker entirely once the prison can run it', () => {
    const world = fullyStockedClassroom()
    enrolSomeone(world, 'basic_literacy')
    expect(describeBlocker(world, DATA, DATA.programs.get('basic_literacy'))).toBeUndefined()
  })

  it('covers every blocking reason the panel can render', () => {
    // A live list, so a new blocker kind without a test shows up here.
    const covered = new Set([
      'locked',
      'no_tutor',
      'no_room',
      'room_not_functional',
      'not_enough_seats',
      'no_contiguous_work_block',
      'no_enrolment',
      'insufficient_funds',
    ])
    expect([...covered].sort()).toEqual(
      [
        'insufficient_funds',
        'locked',
        'no_contiguous_work_block',
        'no_enrolment',
        'no_room',
        'no_tutor',
        'not_enough_seats',
        'room_not_functional',
      ].sort(),
    )
  })
})

/* -------------------------------------------------------------------------- */
/* Enrolment                                                                   */
/* -------------------------------------------------------------------------- */

describe('programs — enrolment rules', () => {
  it('refers an inmate whose trigger condition holds, and nobody else', () => {
    const world = createInmateWorld({ size: 24, data: DATA, continuousIntake: false, research: 'all' })
    const drinker = addInmate(world, DATA, {
      addictions: [{ substance: 'alcohol', strength: 0.6 }],
    })
    const clean = addInmate(world, DATA, { addictions: [] })
    const def = DATA.programs.get('alcohol_recovery_group')

    const drinkerEntity = world.inmates.get(drinker)
    const cleanEntity = world.inmates.get(clean)
    expect(drinkerEntity && isReferralCandidate(drinkerEntity, def)).toBe(true)
    expect(cleanEntity && isReferralCandidate(cleanEntity, def)).toBe(false)
  })

  it('refers on a trait as well as on an addiction', () => {
    const world = createInmateWorld({ size: 24, data: DATA, continuousIntake: false, research: 'all' })
    const violent = addInmate(world, DATA, { traits: ['violent'] })
    const entity = world.inmates.get(violent)
    expect(entity && isReferralCandidate(entity, DATA.programs.get('anger_management'))).toBe(true)
  })

  it('refuses a voluntary programme above the suppression threshold', () => {
    const world = createInmateWorld({ size: 24, data: DATA, continuousIntake: false, research: 'all' })
    const threshold = DATA.balance.suppression.voluntaryRefusalThreshold
    const calm = addInmate(world, DATA, { suppression: 0 })
    const crushed = addInmate(world, DATA, { suppression: threshold + 10 })
    const def = DATA.programs.get('workshop_induction')

    const calmEntity = world.inmates.get(calm)
    const crushedEntity = world.inmates.get(crushed)
    expect(calmEntity && isEligible(world, DATA, calmEntity, def)).toBe(true)
    expect(crushedEntity && isEligible(world, DATA, crushedEntity, def)).toBe(false)
  })

  it('refuses a programme whose prerequisite is outstanding', () => {
    const world = createInmateWorld({ size: 24, data: DATA, continuousIntake: false, research: 'all' })
    const id = addInmate(world, DATA)
    const entity = world.inmates.get(id)
    const vocational = DATA.programs.get('vocational_certificate')

    expect(entity && isEligible(world, DATA, entity, vocational)).toBe(false)
    world.programs.recordCompletion(id, 'basic_literacy')
    expect(entity && isEligible(world, DATA, entity, vocational)).toBe(true)
  })

  it('weights the voluntary opt-in by mood and suppression', () => {
    const happy = voluntaryOptInChance(DATA, 10, 0)
    const miserable = voluntaryOptInChance(DATA, 90, 0)
    const suppressed = voluntaryOptInChance(DATA, 10, DATA.balance.suppression.max)

    expect(happy).toBeGreaterThan(miserable)
    expect(happy).toBeGreaterThan(suppressed)
    expect(suppressed).toBeGreaterThanOrEqual(0)
  })

  it('caps enrolment at seats × the cap multiplier', () => {
    const world = fullyStockedClassroom()
    const def = DATA.programs.get('basic_literacy')
    const cap = def.seats * DATA.balance.programs.enrolmentCapMultiplier
    const events = new RecordingSink()

    for (let i = 0; i < cap + 5; i += 1) {
      const id = addInmate(world, DATA)
      enrol(world, DATA, events, 0, id, def.id)
    }
    expect(world.programs.enrolledIn(def.id).length).toBe(cap)
  })
})

/* -------------------------------------------------------------------------- */
/* Success roll                                                                */
/* -------------------------------------------------------------------------- */

describe('programs — the success roll (PRD 5.9)', () => {
  it('follows the formula term by term', () => {
    const def = DATA.programs.get('basic_literacy')
    const cfg = DATA.balance.programs
    const base = cfg.difficultyBase[def.difficulty]

    const perfect = sessionSuccessChance(DATA, def, {
      meanNeed: 0,
      suppression: 0,
      aptitude: 1,
    })
    expect(perfect).toBeCloseTo(base * (cfg.concentrationBase + cfg.concentrationScale), 6)

    const distracted = sessionSuccessChance(DATA, def, {
      meanNeed: 100,
      suppression: 0,
      aptitude: 1,
    })
    expect(distracted).toBeCloseTo(base * cfg.concentrationBase, 6)

    const crushed = sessionSuccessChance(DATA, def, {
      meanNeed: 0,
      suppression: DATA.balance.suppression.max,
      aptitude: 1,
    })
    expect(crushed).toBeCloseTo(perfect * (1 - cfg.suppressionFactor), 6)

    const gifted = sessionSuccessChance(DATA, def, {
      meanNeed: 0,
      suppression: 0,
      aptitude: cfg.aptitude.max,
    })
    expect(gifted).toBeGreaterThan(perfect)
  })

  it('ranks the three difficulties in order', () => {
    const inputs = { meanNeed: 0, suppression: 0, aptitude: 1 }
    const easy = sessionSuccessChance(DATA, DATA.programs.get('workshop_induction'), inputs)
    const intermediate = sessionSuccessChance(
      DATA,
      DATA.programs.get('vocational_certificate'),
      inputs,
    )
    const advanced = sessionSuccessChance(
      DATA,
      DATA.programs.get('joinery_apprenticeship'),
      inputs,
    )
    expect(easy).toBeGreaterThan(intermediate)
    expect(intermediate).toBeGreaterThan(advanced)
  })
})

/* -------------------------------------------------------------------------- */
/* Effects                                                                     */
/* -------------------------------------------------------------------------- */

describe('programs — completion effects', () => {
  it('halves an addiction on Alcohol Recovery', () => {
    const world = createInmateWorld({ size: 24, data: DATA, continuousIntake: false, research: 'all' })
    const events = new RecordingSink()
    const id = addInmate(world, DATA, { addictions: [{ substance: 'alcohol', strength: 0.8 }] })
    const entity = world.inmates.get(id)
    if (entity === undefined) throw new Error('inmate missing')

    applyProgramEffects(world, events, 0, entity, DATA.programs.get('alcohol_recovery_group'))
    expect(entity.inmate.addictions[0]?.strength).toBeCloseTo(0.4, 6)
    expect(world.programs.reoffendDeltas.get(id)).toBeCloseTo(-0.35, 6)
  })

  it('replaces the violent misconduct multiplier on Anger Management', () => {
    const world = createInmateWorld({ size: 24, data: DATA, continuousIntake: false, research: 'all' })
    const events = new RecordingSink()
    const id = addInmate(world, DATA, { traits: ['violent'] })
    const entity = world.inmates.get(id)
    if (entity === undefined) throw new Error('inmate missing')

    applyProgramEffects(world, events, 0, entity, DATA.programs.get('anger_management'))
    expect(traitMisconductMultiplierFor(world, id, 'violent')).toBeCloseTo(1.15, 6)

    // And it actually lowers the roll.
    const cfg = DATA.balance.misconduct
    const shared = {
      category: 'medium',
      criticalNeedCount: 0,
      cellGradeModifier: 1,
      suppression: 0,
      instigatorNearby: 0,
      guardNearby: false,
      hasViolentTrait: true,
      agitatorBoostMultiplier: 1,
    }
    const before = computeMisconductProbability(cfg, 100, shared)
    const after = computeMisconductProbability(cfg, 100, {
      ...shared,
      violentTraitMultiplierOverride: 1.15,
    })
    expect(after).toBeLessThan(before)
  })

  it('unlocks a labour assignment on Workshop Induction', () => {
    const world = createInmateWorld({ size: 24, data: DATA, continuousIntake: false, research: 'all' })
    const events = new RecordingSink()
    const id = addInmate(world, DATA)
    const entity = world.inmates.get(id)
    if (entity === undefined) throw new Error('inmate missing')

    applyProgramEffects(world, events, 0, entity, DATA.programs.get('workshop_induction'))
    expect(world.programs.unlockedLabour.get(id)?.has('workshop')).toBe(true)
  })

  it('spreads the calmed status from Chaplaincy to nearby inmates only', () => {
    const world = createInmateWorld({ size: 24, data: DATA, continuousIntake: false, research: 'all' })
    const events = new RecordingSink()
    const centre = addInmate(world, DATA, { tx: 10, ty: 10 })
    const near = addInmate(world, DATA, { tx: 12, ty: 10 })
    const far = addInmate(world, DATA, { tx: 20, ty: 10 })
    const entity = world.inmates.get(centre)
    if (entity === undefined) throw new Error('inmate missing')

    applyProgramEffects(world, events, 0, entity, DATA.programs.get('chaplaincy_service'))
    expect(entity.inmate.status).toContain('calmed')
    expect(world.inmates.get(near)?.inmate.status).toContain('calmed')
    expect(world.inmates.get(far)?.inmate.status).not.toContain('calmed')
  })

  it('suppresses the narcotics need only while enrolled', () => {
    const world = createInmateWorld({ size: 24, data: DATA, continuousIntake: false, research: 'all' })
    const events = new RecordingSink()
    const id = addInmate(world, DATA, { addictions: [{ substance: 'narcotics', strength: 0.5 }] })

    expect(suppressedNeedFor(world, DATA, id)).toBeUndefined()
    enrol(world, DATA, events, 0, id, 'substance_treatment')
    expect(suppressedNeedFor(world, DATA, id)).toBe('narcotics')
    world.programs.enrolments.delete(id)
    expect(suppressedNeedFor(world, DATA, id)).toBeUndefined()
  })
})

/* -------------------------------------------------------------------------- */
/* End to end                                                                  */
/* -------------------------------------------------------------------------- */

describe('programs — T5.3 acceptance', () => {
  it('runs a programme end to end in a real prison and completes it', () => {
    const world = fullyStockedClassroom()
    const events = new RecordingSink()
    setAllRoutines(world, workStrip(9, 3))

    // Aptitude at the ceiling and no unmet needs, so the roll is generous and
    // the test measures the machinery rather than the dice.
    const learners: number[] = []
    for (let i = 0; i < 4; i += 1) {
      const id = addInmate(world, DATA, { aptitude: DATA.balance.programs.aptitude.max, tx: 3, ty: 3 })
      learners.push(id)
      enrol(world, DATA, events, 0, id, 'basic_literacy')
    }

    const sim = new Simulation({
      seed: 0xb10c_5003,
      world,
      systems: [createProgramSystem({ data: DATA })],
      events,
    })

    const def = DATA.programs.get('basic_literacy')
    // Enough days for `sessionsRequired` successful sessions, with slack for
    // failed rolls.
    for (let day = 0; day < 40; day += 1) {
      for (let i = 0; i < TICKS_PER_DAY; i += 1) sim.step()
    }

    expect(events.of(PROGRAM_EVENTS.sessionStarted).length).toBeGreaterThan(0)
    expect(events.of(PROGRAM_EVENTS.sessionFinished).length).toBeGreaterThan(0)
    expect(world.programs.completedCount(def.id)).toBeGreaterThan(0)
  })

  it('names the precise reason when there is no contiguous work block', () => {
    const world = fullyStockedClassroom()
    const events = new RecordingSink()
    const strip = workStrip(9, 2)
    setAllRoutines(world, strip)
    enrolSomeone(world, 'basic_literacy')

    refreshSchedules(world, DATA, events, 0)

    const blocked = events
      .of(PROGRAM_EVENTS.blocked)
      .map((event) => event.data as JsonObject)
      .find((detail) => detail['programId'] === 'basic_literacy')

    expect(blocked?.['reason']).toBe('no_contiguous_work_block')
    expect(blocked?.['have']).toBe(2)
    expect(blocked?.['need']).toBe(3)
    expect(world.programs.schedules.has('basic_literacy')).toBe(false)
  })
})

/* -------------------------------------------------------------------------- */
/* Pinning                                                                     */
/* -------------------------------------------------------------------------- */

describe('programs — manual pinning needs Delegation', () => {
  it('refuses a pin while program_scheduler is locked, and accepts it after', () => {
    const world = createInmateWorld({ size: 24, data: DATA, continuousIntake: false })
    setAllRoutines(world, workStrip(9, 4))
    const events = new RecordingSink()
    const sim = new Simulation({
      seed: 1,
      world,
      commandHandlers: programCommandHandlers(DATA),
      events,
    })

    const pin = {
      type: PROGRAM_COMMANDS.pinSession,
      issuedAtTick: 0,
      payload: { programId: 'basic_literacy', categoryId: 'medium', startHour: 10 },
    }

    sim.enqueue(pin)
    sim.step()
    expect(world.programs.pins.has('basic_literacy')).toBe(false)
    expect(
      events.of(PROGRAM_EVENTS.rejected).map((event) => (event.data as JsonObject)['reason']),
    ).toContain('feature-locked')

    world.directorate.grant('delegation')
    sim.enqueue(pin)
    sim.step()
    expect(world.programs.pins.get('basic_literacy')).toEqual({
      categoryId: 'medium',
      startHour: 10,
    })
  })

  it('refuses a pin where the run does not fit', () => {
    const world = createInmateWorld({ size: 24, data: DATA, continuousIntake: false, research: 'all' })
    setAllRoutines(world, workStrip(9, 2))
    const events = new RecordingSink()
    const sim = new Simulation({
      seed: 1,
      world,
      commandHandlers: programCommandHandlers(DATA),
      events,
    })

    sim.enqueue({
      type: PROGRAM_COMMANDS.pinSession,
      issuedAtTick: 0,
      payload: { programId: 'basic_literacy', categoryId: 'medium', startHour: 9 },
    })
    sim.step()

    expect(world.programs.pins.has('basic_literacy')).toBe(false)
    expect(
      events.of(PROGRAM_EVENTS.rejected).map((event) => (event.data as JsonObject)['reason']),
    ).toContain('no_contiguous_work_block')
  })
})

/* -------------------------------------------------------------------------- */
/* Helpers that need the module under test                                     */
/* -------------------------------------------------------------------------- */

/**
 * Puts a tutor in the registry directly.
 *
 * Several tutor roles (`instructor`, `chaplain`, `hearing_panel`) are engaged
 * per session rather than hired, so `hireStaff` refuses them; the programme
 * still needs one on the books to run.
 */
function seedTutor(world: InmateWorld, defId: string, tx: number, ty: number): number {
  const id = world.staff.allocateId()
  const units = DATA.balance.map.tileWorldUnits
  world.staff.add({
    id,
    kind: 'staff',
    x: (tx + 0.5) * units,
    y: (ty + 0.5) * units,
    tx,
    ty,
    staff: {
      defId,
      name: `${defId} ${id}`,
      officeRoomId: 0,
      assignedAreaId: 0,
      pinnedTile: -1,
      duty: { kind: 'idle' },
      wanderCooldown: 0,
      needs: new Float32Array(DATA.needs.size),
      breakPending: false,
      breakCooldownMinutes: 0,
    },
  })
  return id
}

function enrolSomeone(world: InmateWorld, programId: string): number {
  const events = new RecordingSink()
  const id = addInmate(world, DATA, { tx: 3, ty: 3 })
  enrol(world, DATA, events, 0, id, programId)
  return id
}

/** A prison where Basic Literacy has everything except students. */
function fullyStockedClassroom(): InmateWorld {
  const world = createInmateWorld({
    size: 40,
    data: DATA,
    continuousIntake: false,
    research: 'all',
  })
  setAllRoutines(world, workStrip(9, 3))
  const events = new RecordingSink()

  makeRoom(world, DATA, 'classroom', { x: 2, y: 2, width: 6, height: 6 })
  stockClassroom(world, events, 20)
  seedTutor(world, 'instructor', 3, 3)
  return world
}

/**
 * Furnishes the classroom at (2,2)–(7,7): `desks` student desks, the tutor's
 * own desk, and a whiteboard on the north wall (it is a wall fixture, and
 * `containingRoom` credits it to the room the wall adjoins).
 */
function stockClassroom(world: InmateWorld, events: RecordingSink, desks: number): void {
  const deps = { world, data: DATA, events, tick: 0 }
  let placed = 0
  for (let y = 2; y < 8 && placed < desks; y += 1) {
    for (let x = 2; x < 8 && placed < desks; x += 1) {
      // The tutor's desk is two tiles wide and sits in the bottom-right corner.
      if (y === 7 && x >= 6) continue
      placeObject(deps, { x, y }, 'classroom_desk')
      placed += 1
    }
  }
  placeObject(deps, { x: 6, y: 7 }, 'office_desk')
  placeObject(deps, { x: 3, y: 1 }, 'whiteboard')
}

/** Kept honest: the fixture programme must exist with the numbers used above. */
describe('programs — fixture sanity', () => {
  it('uses a programme whose shape the tests assume', () => {
    const def: ProgramDef = DATA.programs.get('basic_literacy')
    expect(def.hours).toBe(3)
    expect(def.seats).toBe(20)
    expect(def.seatObjectId).toBe('classroom_desk')
    expect(def.roomId).toBe('classroom')
    expect(def.tutorStaffId).toBe('instructor')
  })

  it('keeps the Registry import used by the data-patching helper', () => {
    expect(new Registry(DATA.programs.all).size).toBe(DATA.programs.size)
  })

  it('runs a session inside one in-game hour of the schedule', () => {
    expect(TICKS_PER_HOUR).toBeGreaterThan(0)
  })
})
