/**
 * Contracts (grants): goals, advances, and facility progress meters (T3.7, PRD 5.14).
 *
 * Lives apart from `contractSystem` so `InmateWorld` can own contract state
 * without a circular import through the evaluator.
 *
 * Predicates that need systems not yet built (Directorate, programs, room
 * grading, morale, contraband, incidents) read from {@link FacilityProgress}.
 * Later tickets write those meters; tests set them directly.
 */

import { TICKS_PER_DAY } from '../core/clock'
import type { Fnv1aHasher } from '../core/hash'
import type { GameData } from '../data/loader'
import type { ContractDef, IncidentKind } from '../data/schemas'
import { INCIDENT_KINDS } from '../data/schemas'

/* -------------------------------------------------------------------------- */
/* Events & identity                                                           */
/* -------------------------------------------------------------------------- */

export const CONTRACT_EVENTS = {
  accepted: 'contracts.accepted',
  completed: 'contracts.completed',
  cancelled: 'contracts.cancelled',
  revealed: 'contracts.revealed',
  rejected: 'contracts.rejected',
  itemProgress: 'contracts.itemProgress',
} as const

export const CONTRACT_SYSTEM_NAME = 'contracts'

/** Evaluate and settle every tick — predicates are cheap. */
export const CONTRACT_SYSTEM_PERIOD = 1

export type ContractRejection =
  | 'unknown-contract'
  | 'already-active'
  | 'already-finished'
  | 'not-available'
  | 'concurrency-cap'
  | 'not-active'
  | 'wrong-world'
  | 'prerequisites'
  | 'locked'

/* -------------------------------------------------------------------------- */
/* Facility progress (meters future systems write)                             */
/* -------------------------------------------------------------------------- */

/**
 * Cross-cutting counters contracts read. Defaults are "clean prison, no
 * research, no programs" so a fresh world only passes predicates that look at
 * rooms / staff / population / capacity / balance.
 */
export class FacilityProgress {
  /** Completions keyed by program definition id. */
  readonly programCompletions = new Map<string, number>()
  /**
   * Tick of the most recent incident of each kind, or absent when none have
   * occurred yet (clean streak measured from tick 0).
   */
  readonly lastIncidentTick = new Map<IncidentKind, number>()
  /** Mean staff morale 0..100. */
  staffMorale = 100
  /** Contraband items currently in circulation. */
  contrabandItems = 0
  /** Cumulative deaths (inmates + staff) this session (T4.5). */
  deathCount = 0
  /**
   * Optional per-room grade overrides (room entity id → score). When absent,
   * {@link evaluateRoomGrade} computes from grading rules.
   */
  readonly roomGradeOverride = new Map<number, number>()

  recordProgramCompletion(programId: string, count = 1): void {
    if (!Number.isInteger(count) || count < 1) {
      throw new RangeError(`program completion count must be a positive integer, received ${count}`)
    }
    this.programCompletions.set(programId, (this.programCompletions.get(programId) ?? 0) + count)
  }

  recordIncident(kind: IncidentKind, tick: number): void {
    if (!Number.isInteger(tick) || tick < 0) {
      throw new RangeError(`incident tick must be a non-negative integer, received ${tick}`)
    }
    this.lastIncidentTick.set(kind, tick)
  }

  daysSinceIncident(kind: IncidentKind, tick: number): number {
    const last = this.lastIncidentTick.get(kind)
    const since = last === undefined ? tick : tick - last
    if (since < 0) return 0
    return Math.floor(since / TICKS_PER_DAY)
  }

  setStaffMorale(value: number): void {
    if (!Number.isFinite(value) || value < 0 || value > 100) {
      throw new RangeError(`staffMorale must be in 0..100, received ${value}`)
    }
    this.staffMorale = value
  }

  setContrabandItems(count: number): void {
    if (!Number.isInteger(count) || count < 0) {
      throw new RangeError(`contrabandItems must be a non-negative integer, received ${count}`)
    }
    this.contrabandItems = count
  }

  /** Records a death incident and increments the session death counter. */
  recordDeath(tick: number): void {
    this.deathCount += 1
    this.recordIncident('death', tick)
  }

  setRoomGrade(roomId: number, grade: number): void {
    this.roomGradeOverride.set(roomId, grade)
  }

  hashInto(hasher: Fnv1aHasher): void {
    const programs = [...this.programCompletions.entries()].sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0,
    )
    hasher.writeUint32(programs.length)
    for (const [id, count] of programs) {
      hasher.writeString(id)
      hasher.writeUint32(count)
    }

    hasher.writeUint32(INCIDENT_KINDS.length)
    for (const kind of INCIDENT_KINDS) {
      hasher.writeString(kind)
      hasher.writeUint32(this.lastIncidentTick.get(kind) ?? 0xffffffff)
    }

    hasher.writeFloat64(this.staffMorale)
    hasher.writeUint32(this.contrabandItems)
    hasher.writeUint32(this.deathCount)

    const grades = [...this.roomGradeOverride.entries()].sort((a, b) => a[0] - b[0])
    hasher.writeUint32(grades.length)
    for (const [roomId, grade] of grades) {
      hasher.writeUint32(roomId)
      hasher.writeInt32(grade)
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Active / finished contract records                                          */
/* -------------------------------------------------------------------------- */

export type ContractLifecycle = 'active' | 'completed' | 'cancelled'

export interface ActiveContract {
  readonly defId: string
  readonly acceptedTick: number
  readonly advancePaid: number
  /** Parallel to `todoItems`; refreshed each evaluation. */
  itemPassed: boolean[]
}

export interface FinishedContract {
  readonly defId: string
  readonly lifecycle: 'completed' | 'cancelled'
  readonly settledTick: number
  readonly advancePaid: number
  /** Debit posted on cancel (advance + penalty), or 0 on completion. */
  readonly cancellationDebit: number
  /** Credit posted on completion, or 0 on cancel. */
  readonly completionCredit: number
}

/** Serialisable contract book (save format / tests). */
export interface ContractBookSnapshot {
  readonly active: readonly {
    readonly defId: string
    readonly acceptedTick: number
    readonly advancePaid: number
    readonly itemPassed: readonly boolean[]
  }[]
  readonly finished: readonly FinishedContract[]
  readonly revealed: readonly string[]
}

/**
 * Authoritative contract state: active grants, finished history, and which
 * hidden contracts have been revealed this run.
 */
export class ContractBook {
  readonly #active: ActiveContract[] = []
  readonly #finished: FinishedContract[] = []
  readonly #revealed = new Set<string>()
  readonly progress: FacilityProgress

  constructor(progress: FacilityProgress = new FacilityProgress()) {
    this.progress = progress
  }

  get active(): readonly ActiveContract[] {
    return this.#active
  }

  get finished(): readonly FinishedContract[] {
    return this.#finished
  }

  get revealed(): ReadonlySet<string> {
    return this.#revealed
  }

  isActive(defId: string): boolean {
    return this.#active.some((c) => c.defId === defId)
  }

  isFinished(defId: string): boolean {
    return this.#finished.some((c) => c.defId === defId)
  }

  findActive(defId: string): ActiveContract | undefined {
    return this.#active.find((c) => c.defId === defId)
  }

  activeCount(): number {
    return this.#active.length
  }

  markRevealed(defId: string): boolean {
    if (this.#revealed.has(defId)) return false
    this.#revealed.add(defId)
    return true
  }

  wasRevealed(defId: string): boolean {
    return this.#revealed.has(defId)
  }

  addActive(contract: ActiveContract): void {
    this.#active.push(contract)
  }

  removeActive(defId: string): ActiveContract | undefined {
    const index = this.#active.findIndex((c) => c.defId === defId)
    if (index < 0) return undefined
    return this.#active.splice(index, 1)[0]
  }

  addFinished(record: FinishedContract): void {
    this.#finished.push(record)
  }

  serialise(): ContractBookSnapshot {
    return {
      active: this.#active.map((c) => ({
        defId: c.defId,
        acceptedTick: c.acceptedTick,
        advancePaid: c.advancePaid,
        itemPassed: [...c.itemPassed],
      })),
      finished: this.#finished.map((f) => ({ ...f })),
      revealed: [...this.#revealed].sort(),
    }
  }

  /** Replaces book state from a snapshot (save load). */
  restore(snapshot: ContractBookSnapshot): void {
    this.#active.length = 0
    for (const c of snapshot.active) {
      this.#active.push({
        defId: c.defId,
        acceptedTick: c.acceptedTick,
        advancePaid: c.advancePaid,
        itemPassed: [...c.itemPassed],
      })
    }
    this.#finished.length = 0
    for (const f of snapshot.finished) {
      this.#finished.push({ ...f })
    }
    this.#revealed.clear()
    for (const id of snapshot.revealed) this.#revealed.add(id)
  }

  hashInto(hasher: Fnv1aHasher): void {
    hasher.writeUint32(this.#active.length)
    for (const c of this.#active) {
      hasher.writeString(c.defId)
      hasher.writeUint32(c.acceptedTick)
      hasher.writeUint32(c.advancePaid)
      hasher.writeUint32(c.itemPassed.length)
      for (const passed of c.itemPassed) hasher.writeUint32(passed ? 1 : 0)
    }
    hasher.writeUint32(this.#finished.length)
    for (const f of this.#finished) {
      hasher.writeString(f.defId)
      hasher.writeString(f.lifecycle)
      hasher.writeUint32(f.settledTick)
      hasher.writeUint32(f.advancePaid)
      hasher.writeUint32(f.cancellationDebit)
      hasher.writeUint32(f.completionCredit)
    }
    const revealed = [...this.#revealed].sort()
    hasher.writeUint32(revealed.length)
    for (const id of revealed) hasher.writeString(id)
    this.progress.hashInto(hasher)
  }
}

export function createContractBook(): ContractBook {
  return new ContractBook()
}

/** Starting contracts named in PRD 5.14 — available without research (except Education Trial). */
export const STARTING_CONTRACT_IDS = [
  'fit_for_purpose',
  'administration',
  'duty_of_care',
  'education_trial',
  'staff_welfare',
] as const

export function contractDefOf(data: GameData, id: string): ContractDef | undefined {
  return data.contracts.find(id)
}
