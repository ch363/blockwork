/**
 * T3.7 — Contracts: every predicate type, completion, cancellation maths,
 * hidden reveal (Rescue Package once on insolvency).
 */

import { describe, expect, it } from 'vitest'

import { TICKS_PER_DAY, TICKS_PER_HOUR } from '../../src/core/clock'
import { Rng } from '../../src/core/rng'
import type { SimulationEvent } from '../../src/core/simulation'
import { Simulation } from '../../src/core/simulation'
import { loadGameData } from '../../src/data/loader'
import type { ContractPredicate } from '../../src/data/schemas'
import { createInmateShell, generateInmate, NO_INMATE } from '../../src/entities/inmate'
import { NeedIndex } from '../../src/entities/needs'
import { NO_OBJECT } from '../../src/entities/objects'
import type { ObjectEntity } from '../../src/entities/objects'
import { NO_PIN, NO_STAFF, hireStaff } from '../../src/entities/staff'
import type { StaffEntity } from '../../src/entities/staff'
import {
  CONTRACT_COMMANDS,
  CONTRACT_EVENTS,
  CONTRACT_SYSTEM_PERIOD,
  STARTING_CONTRACT_IDS,
  acceptContract,
  cancelContract,
  cancellationDebit,
  contractCommandHandlers,
  createContractSystem,
  evaluatePredicate,
  maxConcurrentContracts,
} from '../../src/systems/contractSystem'
import { createInmateWorld } from '../../src/systems/intakeSystem'
import type { InmateWorld } from '../../src/systems/intakeSystem'
import { NO_ROOM } from '../../src/world/rooms'
import type { Room } from '../../src/world/rooms'

const DATA = loadGameData()
const SEED = 0xc07_7_ac7
const NEED_INDEX = NeedIndex.fromData(DATA)

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
  return createInmateWorld({ size: 32, data: DATA, continuousIntake: false })
}

function ctx(w: InmateWorld, tick = 0) {
  return { world: w, data: DATA, tick, needIndex: NEED_INDEX }
}

function pred(predicate: ContractPredicate, w: InmateWorld, tick = 0): boolean {
  return evaluatePredicate(predicate, ctx(w, tick))
}

function addFunctionalRoom(
  w: InmateWorld,
  defId: string,
  tiles = [0, 1, 2, 3, 4, 5, 6, 7, 8],
): number {
  const id = w.rooms.allocateId()
  const room: Room = {
    id,
    defId,
    tiles,
    bounds: { x: 0, y: 0, width: 3, height: 3 },
    properties: { enclosed: true, indoors: true, outdoors: false, secure: false },
  }
  w.rooms.set(room)
  w.rooms.setStatus({
    roomId: id,
    defId,
    functional: true,
    requirements: [],
  })
  return id
}

function addObject(w: InmateWorld, defId: string, roomId = NO_ROOM): number {
  const id = w.objects.allocateId()
  if (id === NO_OBJECT) throw new Error('object id exhausted')
  const entity: ObjectEntity = {
    id,
    kind: 'object',
    tileIndex: id,
    tx: id % w.grid.size,
    ty: Math.floor(id / w.grid.size) % w.grid.size,
    object: {
      defId,
      rotation: 0,
      footprint: { x: 0, y: 0, width: 1, height: 1 },
      tiles: [id],
      roomId,
      hasPower: true,
      hasWater: true,
      hp: 100,
    },
  }
  w.objects.add(entity)
  return id
}

function addInmate(w: InmateWorld, category = 'medium', seed = SEED): number {
  const id = w.inmates.allocateId()
  if (id === NO_INMATE) throw new Error('inmate id exhausted')
  const component = generateInmate({
    data: DATA,
    rng: new Rng((seed + id) >>> 0).stream('intake'),
    category,
  })
  w.inmates.add(
    createInmateShell({
      id,
      data: DATA,
      inmate: component,
      tx: 1,
      ty: 1,
    }),
  )
  return id
}

function addStaffEntity(w: InmateWorld, defId: string, tx: number, ty: number): number {
  const id = w.staff.allocateId()
  if (id === NO_STAFF) throw new Error('staff id exhausted')
  const def = DATA.staff.get(defId)
  const units = DATA.balance.map.tileWorldUnits
  const entity: StaffEntity = {
    id,
    kind: 'staff',
    x: (tx + 0.5) * units,
    y: (ty + 0.5) * units,
    tx,
    ty,
    staff: {
      defId,
      name: `${def.name} (engaged)`,
      officeRoomId: NO_ROOM,
      assignedAreaId: 0,
      pinnedTile: NO_PIN,
      duty: { kind: 'idle' },
      wanderCooldown: 0,
      needs: new Float32Array(DATA.needs.size),
      breakPending: false,
      breakCooldownMinutes: 0,
    },
  }
  w.staff.add(entity)
  return id
}

function runContractTicks(w: InmateWorld, events: RecordingSink, ticks: number): Simulation {
  const sim = new Simulation({
    seed: SEED,
    world: w,
    systems: [createContractSystem({ data: DATA })],
    events,
  })
  for (let i = 0; i < ticks; i += 1) {
    sim.step()
  }
  return sim
}

/* -------------------------------------------------------------------------- */
/* Every predicate type                                                        */
/* -------------------------------------------------------------------------- */

describe('contract predicates (T3.7)', () => {
  it('roomCount counts functional rooms of the given type', () => {
    const w = world()
    expect(pred({ type: 'roomCount', roomId: 'cell', min: 1 }, w)).toBe(false)
    addFunctionalRoom(w, 'cell')
    addFunctionalRoom(w, 'cell')
    addFunctionalRoom(w, 'kitchen')
    expect(pred({ type: 'roomCount', roomId: 'cell', min: 2 }, w)).toBe(true)
    expect(pred({ type: 'roomCount', roomId: 'cell', min: 3 }, w)).toBe(false)
    expect(pred({ type: 'roomCount', roomId: 'kitchen', min: 1 }, w)).toBe(true)
  })

  it('roomGrade counts functional rooms meeting the grade floor', () => {
    const w = world()
    const a = addFunctionalRoom(
      w,
      'cell',
      Array.from({ length: 16 }, (_, i) => i),
    )
    const b = addFunctionalRoom(
      w,
      'cell',
      Array.from({ length: 6 }, (_, i) => i + 100),
    )
    w.contracts.progress.setRoomGrade(a, 6)
    w.contracts.progress.setRoomGrade(b, 3)
    expect(pred({ type: 'roomGrade', roomId: 'cell', minGrade: 5, count: 1 }, w)).toBe(true)
    expect(pred({ type: 'roomGrade', roomId: 'cell', minGrade: 5, count: 2 }, w)).toBe(false)
  })

  it('objectCount tallies placed objects by definition', () => {
    const w = world()
    expect(pred({ type: 'objectCount', objectId: 'camera', min: 2 }, w)).toBe(false)
    addObject(w, 'camera')
    addObject(w, 'camera')
    addObject(w, 'bed')
    expect(pred({ type: 'objectCount', objectId: 'camera', min: 2 }, w)).toBe(true)
    expect(pred({ type: 'objectCount', objectId: 'camera', min: 3 }, w)).toBe(false)
  })

  it('staffHired counts hired staff of the given role', () => {
    const w = world()
    const events = new RecordingSink()
    expect(pred({ type: 'staffHired', staffId: 'warden', min: 1 }, w)).toBe(false)
    addFunctionalRoom(w, 'office')
    hireStaff({ world: w, defId: 'warden', events, tick: 0, tx: 2, ty: 2 })
    expect(pred({ type: 'staffHired', staffId: 'warden', min: 1 }, w)).toBe(true)
    expect(pred({ type: 'staffHired', staffId: 'medic', min: 1 }, w)).toBe(false)
  })

  it('populationAtLeast reads the inmate registry size', () => {
    const w = world()
    expect(pred({ type: 'populationAtLeast', min: 2 }, w)).toBe(false)
    addInmate(w, 'medium', 1)
    addInmate(w, 'medium', 2)
    expect(pred({ type: 'populationAtLeast', min: 2 }, w)).toBe(true)
  })

  it('capacityAtLeast uses housing capacity from functional cells', () => {
    const w = world()
    expect(pred({ type: 'capacityAtLeast', min: 2 }, w)).toBe(false)
    addFunctionalRoom(w, 'cell')
    addFunctionalRoom(w, 'cell')
    expect(pred({ type: 'capacityAtLeast', min: 2 }, w)).toBe(true)
  })

  it('programCompletions reads facility progress meters', () => {
    const w = world()
    expect(pred({ type: 'programCompletions', programId: 'basic_literacy', min: 20 }, w)).toBe(
      false,
    )
    w.contracts.progress.recordProgramCompletion('basic_literacy', 20)
    expect(pred({ type: 'programCompletions', programId: 'basic_literacy', min: 20 }, w)).toBe(true)
  })

  it('directorateComplete checks completed Directorate nodes', () => {
    const w = world()
    expect(pred({ type: 'directorateComplete', nodeId: 'finance' }, w)).toBe(false)
    w.directorate.grant('finance')
    expect(pred({ type: 'directorateComplete', nodeId: 'finance' }, w)).toBe(true)
  })

  it('needBelow compares mean inmate need against the ceiling', () => {
    const w = world()
    const id = addInmate(w)
    const hygiene = NEED_INDEX.require('hygiene')
    const inmate = w.inmates.get(id)
    if (inmate === undefined) throw new Error(`no inmate ${String(id)}`)
    inmate.inmate.needs[hygiene] = 55
    expect(pred({ type: 'needBelow', needId: 'hygiene', maxMean: 40 }, w)).toBe(false)
    inmate.inmate.needs[hygiene] = 20
    expect(pred({ type: 'needBelow', needId: 'hygiene', maxMean: 40 }, w)).toBe(true)
  })

  it('daysWithout measures clean streaks from the last incident', () => {
    const w = world()
    const sevenDays = 7 * TICKS_PER_DAY
    expect(pred({ type: 'daysWithout', incident: 'riot', days: 7 }, w, sevenDays)).toBe(true)
    w.contracts.progress.recordIncident('riot', TICKS_PER_DAY)
    expect(pred({ type: 'daysWithout', incident: 'riot', days: 7 }, w, sevenDays)).toBe(false)
    expect(
      pred({ type: 'daysWithout', incident: 'riot', days: 7 }, w, TICKS_PER_DAY + sevenDays),
    ).toBe(true)
  })

  it('balanceAtLeast reads the economy ledger', () => {
    const w = world()
    expect(pred({ type: 'balanceAtLeast', min: DATA.balance.economy.startingFunds }, w)).toBe(true)
    w.economy.debit(0, 'other', DATA.balance.economy.startingFunds, 'drain', 0)
    expect(pred({ type: 'balanceAtLeast', min: 1 }, w)).toBe(false)
  })

  it('staffMoraleAtLeast reads the morale meter', () => {
    const w = world()
    w.contracts.progress.setStaffMorale(65)
    expect(pred({ type: 'staffMoraleAtLeast', min: 70 }, w)).toBe(false)
    w.contracts.progress.setStaffMorale(70)
    expect(pred({ type: 'staffMoraleAtLeast', min: 70 }, w)).toBe(true)
  })

  it('contrabandBelow treats maxItems as an inclusive ceiling', () => {
    const w = world()
    w.contracts.progress.setContrabandItems(5)
    expect(pred({ type: 'contrabandBelow', maxItems: 5 }, w)).toBe(true)
    w.contracts.progress.setContrabandItems(6)
    expect(pred({ type: 'contrabandBelow', maxItems: 5 }, w)).toBe(false)
  })

  it('insolvencyImminent is true while the insolvency countdown is running', () => {
    const w = world()
    expect(pred({ type: 'insolvencyImminent' }, w)).toBe(false)
    w.economy.debit(0, 'other', DATA.balance.economy.startingFunds + 1, 'go broke', 0)
    const events = new RecordingSink()
    w.economy.updateInsolvency(TICKS_PER_HOUR, events)
    expect(w.economy.insolvencyDeadlineTick).not.toBeNull()
    expect(pred({ type: 'insolvencyImminent' }, w, TICKS_PER_HOUR)).toBe(true)
  })
})

/* -------------------------------------------------------------------------- */
/* Completion                                                                  */
/* -------------------------------------------------------------------------- */

describe('contract completion (T3.7)', () => {
  it('pays the advance on accept and the completion bonus when all todos pass', () => {
    const w = world()
    const events = new RecordingSink()
    const starting = w.economy.balance
    const def = DATA.contracts.get('administration')

    const accepted = acceptContract(w, 'administration', events, 0, NEED_INDEX)
    expect(accepted.ok).toBe(true)
    expect(w.economy.balance).toBe(starting + def.advance)
    expect(events.of(CONTRACT_EVENTS.accepted)).toHaveLength(1)

    addFunctionalRoom(w, 'office')
    hireStaff({ world: w, defId: 'warden', events, tick: 0, tx: 1, ty: 1 })
    w.directorate.grant('finance')

    runContractTicks(w, events, CONTRACT_SYSTEM_PERIOD)

    expect(events.of(CONTRACT_EVENTS.completed)).toHaveLength(1)
    expect(w.contracts.isFinished('administration')).toBe(true)
    expect(w.contracts.activeCount()).toBe(0)
    expect(w.economy.balance).toBe(
      starting + def.advance + def.completion - DATA.staff.get('warden').hireCost,
    )
  })

  it('completes each of the five starting contracts when their predicates pass', () => {
    const events = new RecordingSink()
    const w = world()

    for (const id of STARTING_CONTRACT_IDS) {
      if (id === 'education_trial') {
        w.directorate.grant('education')
      }

      const def = DATA.contracts.get(id)
      for (const item of def.todoItems) {
        satisfy(w, item.predicate, events)
      }

      // daysWithout needs wall-clock progress from tick 0; accept at a late tick
      // so tryCompleteActive sees a long enough clean streak.
      let tick = 0
      for (const item of def.todoItems) {
        if (item.predicate.type === 'daysWithout') {
          tick = Math.max(tick, item.predicate.days * TICKS_PER_DAY)
        }
      }

      const result = acceptContract(w, id, events, tick, NEED_INDEX)
      expect(
        result.ok,
        `${id}: ${JSON.stringify(events.of(CONTRACT_EVENTS.rejected).at(-1)?.data)}`,
      ).toBe(true)
      expect(w.contracts.isFinished(id), id).toBe(true)
    }

    expect(events.of(CONTRACT_EVENTS.completed)).toHaveLength(STARTING_CONTRACT_IDS.length)
  })

  it('raises the concurrency cap from 2 to 3 after Additional Contract', () => {
    const w = world()
    expect(maxConcurrentContracts(w)).toBe(DATA.balance.economy.maxConcurrentContracts)
    w.directorate.grant('additional_contract')
    expect(maxConcurrentContracts(w)).toBe(
      DATA.balance.economy.maxConcurrentContractsWithAdditional,
    )

    const events = new RecordingSink()
    expect(acceptContract(w, 'fit_for_purpose', events, 0, NEED_INDEX).ok).toBe(true)
    expect(acceptContract(w, 'administration', events, 0, NEED_INDEX).ok).toBe(true)
    expect(acceptContract(w, 'duty_of_care', events, 0, NEED_INDEX).ok).toBe(true)
    expect(acceptContract(w, 'staff_welfare', events, 0, NEED_INDEX).ok).toBe(false)
    expect(events.of(CONTRACT_EVENTS.rejected).at(-1)?.data).toMatchObject({
      reason: 'concurrency-cap',
    })
  })
})

function satisfy(w: InmateWorld, predicate: ContractPredicate, events: RecordingSink): void {
  switch (predicate.type) {
    case 'roomCount':
      for (let i = 0; i < predicate.min; i += 1) addFunctionalRoom(w, predicate.roomId)
      break
    case 'roomGrade':
      for (let i = 0; i < predicate.count; i += 1) {
        const id = addFunctionalRoom(w, predicate.roomId)
        w.contracts.progress.setRoomGrade(id, predicate.minGrade)
      }
      break
    case 'objectCount':
      for (let i = 0; i < predicate.min; i += 1) addObject(w, predicate.objectId)
      break
    case 'staffHired':
      for (let i = 0; i < predicate.min; i += 1) {
        const hired = hireStaff({
          world: w,
          defId: predicate.staffId,
          events,
          tick: 0,
          tx: 2 + i,
          ty: 2,
        })
        if (hired.entity !== undefined) continue
        // Per-session / callable roles are engaged rather than hired permanently;
        // inject a staff entity so the predicate still sees them on the roster.
        addStaffEntity(w, predicate.staffId, 2 + i, 2)
      }
      break
    case 'populationAtLeast':
      while (w.inmates.size < predicate.min) addInmate(w, 'medium', w.inmates.size + 1)
      break
    case 'capacityAtLeast':
      while (
        [...w.rooms.all()].filter((r) => r.defId === 'cell' && w.rooms.statusOf(r.id)?.functional)
          .length < predicate.min
      ) {
        addFunctionalRoom(w, 'cell')
      }
      break
    case 'programCompletions':
      w.contracts.progress.recordProgramCompletion(predicate.programId, predicate.min)
      break
    case 'directorateComplete':
      w.directorate.grant(predicate.nodeId)
      break
    case 'needBelow': {
      const index = NEED_INDEX.require(predicate.needId)
      if (w.inmates.size === 0) addInmate(w)
      for (const entity of w.inmates.all()) {
        entity.inmate.needs[index] = Math.max(0, predicate.maxMean - 1)
      }
      break
    }
    case 'daysWithout':
      // Clean streak from tick 0; leave lastIncident unset.
      break
    case 'balanceAtLeast':
      if (w.economy.balance < predicate.min) {
        w.economy.credit(0, 'other', predicate.min - w.economy.balance, 'test top-up', 0)
      }
      break
    case 'staffMoraleAtLeast':
      w.contracts.progress.setStaffMorale(predicate.min)
      break
    case 'contrabandBelow':
      w.contracts.progress.setContrabandItems(0)
      break
    case 'insolvencyImminent':
      break
    default: {
      const _exhaustive: never = predicate
      throw new Error(`unhandled predicate ${JSON.stringify(_exhaustive)}`)
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Cancellation maths                                                          */
/* -------------------------------------------------------------------------- */

describe('contract cancellation maths (T3.7)', () => {
  it('debits advance plus the configured penalty fraction', () => {
    const penalty = DATA.balance.economy.contractCancellationPenalty
    expect(cancellationDebit(20_000, penalty)).toBe(22_000)
    expect(cancellationDebit(0, penalty)).toBe(0)
    expect(cancellationDebit(5_000, 0.1)).toBe(5_500)
  })

  it('refunds the advance plus 10% on cancel', () => {
    const w = world()
    const events = new RecordingSink()
    const def = DATA.contracts.get('fit_for_purpose')
    const beforeAccept = w.economy.balance

    acceptContract(w, 'fit_for_purpose', events, 0, NEED_INDEX)
    expect(w.economy.balance).toBe(beforeAccept + def.advance)

    const afterAdvance = w.economy.balance
    const expectedDebit = cancellationDebit(
      def.advance,
      DATA.balance.economy.contractCancellationPenalty,
    )
    cancelContract(w, 'fit_for_purpose', events, 10)

    expect(events.of(CONTRACT_EVENTS.cancelled)).toHaveLength(1)
    expect(events.of(CONTRACT_EVENTS.cancelled)[0]?.data).toMatchObject({
      contractId: 'fit_for_purpose',
      debit: expectedDebit,
    })
    expect(w.economy.balance).toBe(afterAdvance - expectedDebit)
    expect(w.contracts.isFinished('fit_for_purpose')).toBe(true)
    expect(w.contracts.isActive('fit_for_purpose')).toBe(false)

    // Net cost of accept-then-cancel is the 10% penalty alone.
    expect(w.economy.balance).toBe(beforeAccept - Math.floor(def.advance * 0.1))
  })
})

/* -------------------------------------------------------------------------- */
/* Hidden reveal                                                               */
/* -------------------------------------------------------------------------- */

describe('hidden contract reveal (T3.7)', () => {
  it('reveals the Rescue Package exactly once when insolvency is imminent', () => {
    const w = world()
    const events = new RecordingSink()
    const sim = new Simulation({
      seed: SEED,
      world: w,
      systems: [createContractSystem({ data: DATA })],
      events,
    })

    expect(w.contracts.wasRevealed('rescue_package')).toBe(false)

    // Go insolvent: negative balance and negative trailing cash flow.
    w.economy.debit(0, 'other', DATA.balance.economy.startingFunds + 500, 'overspend', 0)
    w.economy.updateInsolvency(TICKS_PER_HOUR, events)
    expect(w.economy.insolvencyDeadlineTick).not.toBeNull()

    sim.step()
    expect(events.of(CONTRACT_EVENTS.revealed)).toHaveLength(1)
    expect(events.of(CONTRACT_EVENTS.revealed)[0]?.data).toMatchObject({
      contractId: 'rescue_package',
    })
    expect(w.contracts.wasRevealed('rescue_package')).toBe(true)

    // Further ticks must not re-emit reveal.
    for (let i = 0; i < 5; i += 1) sim.step()
    expect(events.of(CONTRACT_EVENTS.revealed)).toHaveLength(1)

    // Acceptable once revealed.
    const accepted = acceptContract(w, 'rescue_package', events, sim.clock.tick, NEED_INDEX)
    expect(accepted.ok).toBe(true)

    // Cancel / finish forever — never available again even if insolvency recurs.
    cancelContract(w, 'rescue_package', events, sim.clock.tick)
    expect(w.contracts.isFinished('rescue_package')).toBe(true)
    expect(acceptContract(w, 'rescue_package', events, sim.clock.tick, NEED_INDEX).ok).toBe(false)
  })

  it('does not reveal Rescue Package when the prison is solvent', () => {
    const w = world()
    const events = new RecordingSink()
    runContractTicks(w, events, 10)
    expect(events.of(CONTRACT_EVENTS.revealed)).toHaveLength(0)
    expect(w.contracts.wasRevealed('rescue_package')).toBe(false)
  })
})

describe('credit line (T8.10 / T5.1)', () => {
  it('refuses a loan until credit_line is researched', () => {
    const w = world()
    const events = new RecordingSink()
    const sim = new Simulation({
      seed: SEED,
      world: w,
      commandHandlers: contractCommandHandlers(DATA),
      events,
    })
    sim.enqueue({
      type: CONTRACT_COMMANDS.takeLoan,
      issuedAtTick: 0,
      payload: { amount: 1_000 },
    })
    sim.step()
    expect(events.of(CONTRACT_EVENTS.rejected)[0]?.data).toMatchObject({ reason: 'locked' })
    expect(w.economy.loanPrincipal).toBe(0)
  })

  it('draws and repays against the researched credit line', () => {
    const w = world()
    w.directorate.grant('credit_line')
    const events = new RecordingSink()
    const sim = new Simulation({
      seed: SEED,
      world: w,
      commandHandlers: contractCommandHandlers(DATA),
      events,
    })
    const amount = Math.min(2_000, DATA.balance.economy.loan.maxCap)
    sim.enqueue({
      type: CONTRACT_COMMANDS.takeLoan,
      issuedAtTick: 0,
      payload: { amount },
    })
    sim.step()
    expect(w.economy.loanPrincipal).toBe(amount)
    expect(w.economy.balance).toBe(DATA.balance.economy.startingFunds + amount)

    sim.enqueue({
      type: CONTRACT_COMMANDS.repayLoan,
      issuedAtTick: 1,
      payload: { amount },
    })
    sim.step()
    expect(w.economy.loanPrincipal).toBe(0)
    expect(w.economy.balance).toBe(DATA.balance.economy.startingFunds)
  })
})
