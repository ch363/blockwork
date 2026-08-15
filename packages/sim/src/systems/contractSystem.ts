/**
 * `ContractSystem`: grants with declarative world-state predicates (T3.7, PRD 5.14).
 *
 * Accept pays the advance; every tick re-evaluates active todo predicates and
 * pays the completion bonus when all pass. Cancel debits the advance plus the
 * configured penalty fraction. Concurrent actives are capped (2, or 3 with the
 * Additional Contract Directorate node). Hidden contracts reveal once when
 * every `revealWhen` predicate passes.
 */

import { isJsonArray } from '../core/commands'
import type { Command, JsonValue } from '../core/commands'
import type { CommandHandler, EventSink, System, SystemContext } from '../core/simulation'
import type { GameData } from '../data/loader'
import { hasFeature } from '../entities/directorate'
import { gradeRoom } from './gradingSystem'
import type { ContractDef, ContractPredicate, RoomDef } from '../data/schemas'
import {
  CONTRACT_EVENTS,
  CONTRACT_SYSTEM_NAME,
  CONTRACT_SYSTEM_PERIOD,
  type ContractRejection,
} from '../entities/contracts'
import { FACILITY_SOURCE_ID } from '../entities/economy'
import { housingCapacity } from '../entities/inmate'
import { NeedIndex } from '../entities/needs'
import type { ObjectRegistry } from '../entities/objects'
import type { Room } from '../world/rooms'

import { isInmateWorld } from './intakeSystem'
import type { InmateWorld } from './intakeSystem'

export {
  CONTRACT_EVENTS,
  CONTRACT_SYSTEM_NAME,
  CONTRACT_SYSTEM_PERIOD,
  ContractBook,
  FacilityProgress,
  STARTING_CONTRACT_IDS,
  createContractBook,
  contractDefOf,
} from '../entities/contracts'
export type {
  ActiveContract,
  ContractBookSnapshot,
  ContractLifecycle,
  ContractRejection,
  FinishedContract,
} from '../entities/contracts'

/* -------------------------------------------------------------------------- */
/* Predicate evaluation                                                        */
/* -------------------------------------------------------------------------- */

export interface PredicateContext {
  readonly world: InmateWorld
  readonly data: GameData
  readonly tick: number
  readonly needIndex: NeedIndex
}

/** Counts functional rooms whose definition id matches. */
export function countRoomsOfType(world: InmateWorld, roomId: string): number {
  let count = 0
  for (const room of world.rooms.all()) {
    if (room.defId !== roomId) continue
    const status = world.rooms.statusOf(room.id)
    if (status !== undefined && status.functional) count += 1
  }
  return count
}

/** Counts placed objects of a definition across the whole map. */
export function countObjectsOfType(objects: ObjectRegistry, objectId: string): number {
  let count = 0
  for (const entity of objects.all()) {
    if (entity.object.defId === objectId) count += 1
  }
  return count
}

/** Counts hired staff of a definition. */
export function countStaffOfType(world: InmateWorld, staffId: string): number {
  let count = 0
  for (const entity of world.staff.all()) {
    if (entity.staff.defId === staffId) count += 1
  }
  return count
}

/**
 * The grade a contract predicate sees.
 *
 * T5.2 owns the scoring; this is the adapter that keeps the override on
 * {@link FacilityProgress} authoritative for scripted scenarios, and answers 0
 * for an ungraded room rather than throwing.
 */
export function evaluateRoomGrade(
  world: InmateWorld,
  room: Room,
  def: RoomDef,
  override: number | undefined,
): number {
  if (override !== undefined) return override
  if (!def.graded || def.gradingRules === undefined) return 0
  return gradeRoom(world, world.data, room, def)?.score ?? 0
}

/** How many rooms of `roomId` meet `minGrade`. */
export function countRoomsAtGrade(world: InmateWorld, roomId: string, minGrade: number): number {
  let count = 0
  for (const room of world.rooms.all()) {
    if (room.defId !== roomId) continue
    const status = world.rooms.statusOf(room.id)
    if (status === undefined || !status.functional) continue
    const def = world.data.rooms.find(room.defId)
    if (def === undefined) continue
    const grade = evaluateRoomGrade(
      world,
      room,
      def,
      world.contracts.progress.roomGradeOverride.get(room.id),
    )
    if (grade >= minGrade) count += 1
  }
  return count
}

/** Mean need value across all inmates, or 0 when the prison is empty. */
export function meanNeed(world: InmateWorld, needIndex: NeedIndex, needId: string): number {
  const index = needIndex.indexOf(needId)
  if (index < 0) return 0
  let sum = 0
  let n = 0
  for (const entity of world.inmates.all()) {
    sum += entity.inmate.needs[index] ?? 0
    n += 1
  }
  if (n === 0) return 0
  return sum / n
}

/**
 * Pure predicate check over the current world. Unknown predicate types are a
 * TypeScript exhaustiveness error — keep the switch complete.
 */
export function evaluatePredicate(predicate: ContractPredicate, ctx: PredicateContext): boolean {
  const { world, tick, needIndex } = ctx
  const progress = world.contracts.progress

  switch (predicate.type) {
    case 'roomCount':
      return countRoomsOfType(world, predicate.roomId) >= predicate.min
    case 'roomGrade':
      return countRoomsAtGrade(world, predicate.roomId, predicate.minGrade) >= predicate.count
    case 'objectCount':
      return countObjectsOfType(world.objects, predicate.objectId) >= predicate.min
    case 'staffHired':
      return countStaffOfType(world, predicate.staffId) >= predicate.min
    case 'populationAtLeast':
      return world.inmates.size >= predicate.min
    case 'capacityAtLeast':
      return housingCapacity(world.rooms, world.objects) >= predicate.min
    case 'programCompletions':
      return (progress.programCompletions.get(predicate.programId) ?? 0) >= predicate.min
    case 'directorateComplete':
      return world.directorate.isComplete(predicate.nodeId)
    case 'needBelow':
      return meanNeed(world, needIndex, predicate.needId) < predicate.maxMean
    case 'daysWithout':
      return progress.daysSinceIncident(predicate.incident, tick) >= predicate.days
    case 'balanceAtLeast':
      return world.economy.balance >= predicate.min
    case 'staffMoraleAtLeast':
      return progress.staffMorale >= predicate.min
    case 'contrabandBelow':
      // maxItems is an inclusive ceiling (at most N in circulation).
      return progress.contrabandItems <= predicate.maxItems
    case 'insolvencyImminent':
      return world.economy.insolvencyDeadlineTick !== null
    default: {
      const _exhaustive: never = predicate
      return _exhaustive
    }
  }
}

/** Every predicate in a list must pass (empty list → true). */
export function evaluateAllPredicates(
  predicates: readonly ContractPredicate[],
  ctx: PredicateContext,
): boolean {
  for (const predicate of predicates) {
    if (!evaluatePredicate(predicate, ctx)) return false
  }
  return true
}

/* -------------------------------------------------------------------------- */
/* Availability & concurrency                                                  */
/* -------------------------------------------------------------------------- */

export function maxConcurrentContracts(world: InmateWorld): number {
  const economy = world.data.balance.economy
  if (hasFeature(world.data, world.directorate, 'additional_contract')) {
    return economy.maxConcurrentContractsWithAdditional
  }
  return economy.maxConcurrentContracts
}

/**
 * Whether a definition may be accepted right now (visible, not finished, not
 * active, prerequisites met). Does not check the concurrency cap.
 */
export function isContractAvailable(def: ContractDef, world: InmateWorld): boolean {
  if (world.contracts.isActive(def.id) || world.contracts.isFinished(def.id)) return false

  for (const nodeId of def.prerequisites) {
    if (!world.directorate.isComplete(nodeId)) return false
  }

  if (def.hidden && !world.contracts.wasRevealed(def.id)) return false

  // Reveal predicates gate reveal only; once revealed, availability is
  // independent of whether the reveal condition still holds.
  return true
}

/** Hidden defs whose reveal predicates just became true and have never shown. */
export function contractsToReveal(world: InmateWorld, ctx: PredicateContext): ContractDef[] {
  const out: ContractDef[] = []
  for (const def of world.data.contracts.all) {
    if (!def.hidden) continue
    if (world.contracts.wasRevealed(def.id)) continue
    if (world.contracts.isFinished(def.id)) continue
    const revealWhen = def.revealWhen
    if (revealWhen === undefined || revealWhen.length === 0) continue
    if (evaluateAllPredicates(revealWhen, ctx)) out.push(def)
  }
  return out
}

/** Cancellation debit: advance + floor(advance × penalty). */
export function cancellationDebit(advance: number, penaltyFraction: number): number {
  if (advance <= 0) return 0
  return advance + Math.floor(advance * penaltyFraction)
}

/* -------------------------------------------------------------------------- */
/* Accept / cancel / complete                                                  */
/* -------------------------------------------------------------------------- */

export interface ContractActionResult {
  readonly ok: boolean
  readonly reason?: ContractRejection
}

export function acceptContract(
  world: InmateWorld,
  defId: string,
  events: EventSink,
  tick: number,
  needIndex: NeedIndex,
): ContractActionResult {
  const def = world.data.contracts.find(defId)
  if (def === undefined) {
    reject(events, tick, defId, 'unknown-contract')
    return { ok: false, reason: 'unknown-contract' }
  }
  if (world.contracts.isActive(defId)) {
    reject(events, tick, defId, 'already-active')
    return { ok: false, reason: 'already-active' }
  }
  if (world.contracts.isFinished(defId)) {
    reject(events, tick, defId, 'already-finished')
    return { ok: false, reason: 'already-finished' }
  }

  const ctx: PredicateContext = { world, data: world.data, tick, needIndex }

  for (const nodeId of def.prerequisites) {
    if (!world.directorate.isComplete(nodeId)) {
      reject(events, tick, defId, 'prerequisites')
      return { ok: false, reason: 'prerequisites' }
    }
  }

  if (def.hidden && !world.contracts.wasRevealed(defId)) {
    reject(events, tick, defId, 'not-available')
    return { ok: false, reason: 'not-available' }
  }

  if (world.contracts.activeCount() >= maxConcurrentContracts(world)) {
    reject(events, tick, defId, 'concurrency-cap')
    return { ok: false, reason: 'concurrency-cap' }
  }

  if (def.advance > 0) {
    world.economy.credit(
      tick,
      'contract',
      def.advance,
      `Contract advance (${def.name})`,
      FACILITY_SOURCE_ID,
    )
  }

  const itemPassed = def.todoItems.map((item) => evaluatePredicate(item.predicate, ctx))
  world.contracts.addActive({
    defId,
    acceptedTick: tick,
    advancePaid: def.advance,
    itemPassed,
  })

  events.emit({
    tick,
    kind: CONTRACT_EVENTS.accepted,
    causeIds: [],
    data: { contractId: defId, advance: def.advance, activeCount: world.contracts.activeCount() },
  })

  // Immediate completion if already satisfied (e.g. Staff Welfare with advance 0).
  tryCompleteActive(world, defId, events, tick, needIndex)
  return { ok: true }
}

export function cancelContract(
  world: InmateWorld,
  defId: string,
  events: EventSink,
  tick: number,
): ContractActionResult {
  const active = world.contracts.removeActive(defId)
  if (active === undefined) {
    reject(events, tick, defId, 'not-active')
    return { ok: false, reason: 'not-active' }
  }

  const def = world.data.contracts.find(defId)
  const penalty = world.data.balance.economy.contractCancellationPenalty
  const debit = cancellationDebit(active.advancePaid, penalty)

  if (debit > 0) {
    world.economy.debit(
      tick,
      'contract',
      debit,
      `Contract cancellation (${def?.name ?? defId})`,
      FACILITY_SOURCE_ID,
    )
  }

  world.contracts.addFinished({
    defId,
    lifecycle: 'cancelled',
    settledTick: tick,
    advancePaid: active.advancePaid,
    cancellationDebit: debit,
    completionCredit: 0,
  })

  events.emit({
    tick,
    kind: CONTRACT_EVENTS.cancelled,
    causeIds: [],
    data: {
      contractId: defId,
      advancePaid: active.advancePaid,
      debit,
      penaltyFraction: penalty,
    },
  })
  return { ok: true }
}

function tryCompleteActive(
  world: InmateWorld,
  defId: string,
  events: EventSink,
  tick: number,
  needIndex: NeedIndex,
): boolean {
  const active = world.contracts.findActive(defId)
  if (active === undefined) return false
  const def = world.data.contracts.find(defId)
  if (def === undefined) return false

  const ctx: PredicateContext = { world, data: world.data, tick, needIndex }
  const itemPassed = def.todoItems.map((item) => evaluatePredicate(item.predicate, ctx))
  active.itemPassed = itemPassed

  if (!itemPassed.every(Boolean)) return false

  world.contracts.removeActive(defId)

  if (def.completion > 0) {
    world.economy.credit(
      tick,
      'contract',
      def.completion,
      `Contract completion (${def.name})`,
      FACILITY_SOURCE_ID,
    )
  }

  world.contracts.addFinished({
    defId,
    lifecycle: 'completed',
    settledTick: tick,
    advancePaid: active.advancePaid,
    cancellationDebit: 0,
    completionCredit: def.completion,
  })

  events.emit({
    tick,
    kind: CONTRACT_EVENTS.completed,
    causeIds: [],
    data: { contractId: defId, completion: def.completion, advancePaid: active.advancePaid },
  })
  return true
}

function refreshActiveContracts(
  world: InmateWorld,
  events: EventSink,
  tick: number,
  needIndex: NeedIndex,
): void {
  // Snapshot ids — completion mutates the active list.
  const ids = world.contracts.active.map((c) => c.defId)
  for (const defId of ids) {
    tryCompleteActive(world, defId, events, tick, needIndex)
  }
}

function revealHiddenContracts(
  world: InmateWorld,
  events: EventSink,
  tick: number,
  needIndex: NeedIndex,
): void {
  const ctx: PredicateContext = { world, data: world.data, tick, needIndex }
  for (const def of contractsToReveal(world, ctx)) {
    if (!world.contracts.markRevealed(def.id)) continue
    events.emit({
      tick,
      kind: CONTRACT_EVENTS.revealed,
      causeIds: [],
      data: { contractId: def.id },
    })
  }
}

function reject(
  events: EventSink,
  tick: number,
  contractId: string,
  reason: ContractRejection,
): void {
  events.emit({
    tick,
    kind: CONTRACT_EVENTS.rejected,
    causeIds: [],
    data: { contractId, reason },
  })
}

/* -------------------------------------------------------------------------- */
/* System                                                                      */
/* -------------------------------------------------------------------------- */

export interface ContractSystemOptions {
  readonly data: GameData
}

export function createContractSystem(options: ContractSystemOptions): System {
  const needIndex = NeedIndex.fromData(options.data)
  let reportedWrongWorld = false

  return {
    name: CONTRACT_SYSTEM_NAME,
    period: CONTRACT_SYSTEM_PERIOD,

    update(context: SystemContext): void {
      const tick = context.clock.tick
      if (!isInmateWorld(context.world)) {
        if (reportedWrongWorld) return
        reportedWrongWorld = true
        context.events.emit({
          tick,
          kind: CONTRACT_EVENTS.rejected,
          causeIds: [],
          data: { command: CONTRACT_SYSTEM_NAME, reason: 'wrong-world' },
        })
        return
      }

      const world = context.world
      revealHiddenContracts(world, context.events, tick, needIndex)
      refreshActiveContracts(world, context.events, tick, needIndex)
    },
  }
}

/* -------------------------------------------------------------------------- */
/* Commands                                                                    */
/* -------------------------------------------------------------------------- */

export const CONTRACT_COMMANDS = {
  accept: 'contracts.accept',
  cancel: 'contracts.cancel',
  takeLoan: 'contracts.takeLoan',
  repayLoan: 'contracts.repayLoan',
} as const

export function contractCommandHandlers(data: GameData): Record<string, CommandHandler> {
  const needIndex = NeedIndex.fromData(data)

  return {
    [CONTRACT_COMMANDS.accept]: (command, context) => {
      handleAccept(command, context, needIndex)
    },
    [CONTRACT_COMMANDS.cancel]: (command, context) => {
      handleCancel(command, context)
    },
    [CONTRACT_COMMANDS.takeLoan]: (command, context) => {
      handleTakeLoan(command, context, data)
    },
    [CONTRACT_COMMANDS.repayLoan]: (command, context) => {
      handleRepayLoan(command, context, data)
    },
  }
}

function handleAccept(command: Command, context: SystemContext, needIndex: NeedIndex): void {
  if (!isInmateWorld(context.world)) {
    reject(context.events, context.clock.tick, '', 'wrong-world')
    return
  }
  const contractId = readString(command.payload, 'contractId')
  if (contractId === undefined) {
    reject(context.events, context.clock.tick, '', 'unknown-contract')
    return
  }
  acceptContract(context.world, contractId, context.events, context.clock.tick, needIndex)
}

function handleCancel(command: Command, context: SystemContext): void {
  if (!isInmateWorld(context.world)) {
    reject(context.events, context.clock.tick, '', 'wrong-world')
    return
  }
  const contractId = readString(command.payload, 'contractId')
  if (contractId === undefined) {
    reject(context.events, context.clock.tick, '', 'unknown-contract')
    return
  }
  cancelContract(context.world, contractId, context.events, context.clock.tick)
}

function handleTakeLoan(command: Command, context: SystemContext, data: GameData): void {
  if (!isInmateWorld(context.world)) {
    reject(context.events, context.clock.tick, '', 'wrong-world')
    return
  }
  if (!hasFeature(data, context.world.directorate, 'credit_line')) {
    reject(context.events, context.clock.tick, '', 'locked')
    return
  }
  const amount = readNonNegativeInt(command.payload, 'amount')
  if (amount === undefined || amount <= 0) {
    reject(context.events, context.clock.tick, '', 'locked')
    return
  }
  const loan = data.balance.economy.loan
  const principal = context.world.economy.loanPrincipal
  const available = Math.max(0, loan.maxCap - principal)
  const take = Math.min(amount, available)
  if (take <= 0) {
    reject(context.events, context.clock.tick, '', 'concurrency-cap')
    return
  }
  context.world.economy.credit(
    context.clock.tick,
    'loan_principal',
    take,
    'Credit line drawn',
    FACILITY_SOURCE_ID,
  )
  context.world.economy.setLoanPrincipal(principal + take)
}

function handleRepayLoan(command: Command, context: SystemContext, data: GameData): void {
  if (!isInmateWorld(context.world)) {
    reject(context.events, context.clock.tick, '', 'wrong-world')
    return
  }
  if (!hasFeature(data, context.world.directorate, 'credit_line')) {
    reject(context.events, context.clock.tick, '', 'locked')
    return
  }
  const amount = readNonNegativeInt(command.payload, 'amount')
  if (amount === undefined || amount <= 0) {
    reject(context.events, context.clock.tick, '', 'locked')
    return
  }
  const principal = context.world.economy.loanPrincipal
  const repay = Math.min(amount, principal, Math.max(0, context.world.economy.balance))
  if (repay <= 0) {
    reject(context.events, context.clock.tick, '', 'concurrency-cap')
    return
  }
  context.world.economy.debit(
    context.clock.tick,
    'loan_principal',
    repay,
    'Credit line repaid',
    FACILITY_SOURCE_ID,
  )
  context.world.economy.setLoanPrincipal(principal - repay)
}

function readNonNegativeInt(payload: JsonValue, key: string): number | undefined {
  if (payload === null || typeof payload !== 'object' || isJsonArray(payload)) return undefined
  const value = payload[key]
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined
}

function readString(payload: JsonValue, key: string): string | undefined {
  if (payload === null || typeof payload !== 'object' || isJsonArray(payload)) return undefined
  const value = payload[key]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}
