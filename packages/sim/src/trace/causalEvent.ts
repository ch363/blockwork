/**
 * CausalEvent recording (PRD 3.1, T3.1).
 *
 * Every simulation failure or warning is a node in a DAG of causes. The Trace
 * panel walks that DAG; this module is the recorder that makes the walk
 * possible. Systems emit through `EventSink`; the log assigns ids, retains a
 * ring of recent events, and permanently keeps anything an active notification
 * still points at.
 */

import type { JsonObject, JsonValue } from '../core/commands'
import { isJsonArray } from '../core/commands'
import type { EventSink, SimulationEvent } from '../core/simulation'

/** Stable id assigned by the recorder. 0 is never a live event. */
export type EventId = number

/**
 * A recorded simulation failure or warning.
 *
 * `causeIds` point at earlier events, forming a DAG. Cycles are rejected at
 * emit time so `buildTrace` can walk without a visited set for correctness —
 * it still uses one for diamond DAGs.
 */
export interface CausalEvent {
  readonly id: EventId
  readonly tick: number
  readonly kind: string
  /** Entity the event is about, or 0. */
  readonly subjectId: number
  readonly causeIds: readonly EventId[]
  readonly data: JsonValue
}

/** Ring capacity for unpinned history (PRD 3.1 / T3.1). */
export const TRACE_BUFFER_CAPACITY = 20_000

/** How deep `buildTrace` walks causes. */
export const TRACE_MAX_DEPTH = 8

/**
 * Event kinds the Trace catalogue must cover.
 *
 * Systems that emit a kind used by the Trace panel register it here. The
 * completeness test fails if any entry lacks a string in `traceStrings.json`.
 * Kinds that only exist as log noise stay off this list until a Trace needs
 * them.
 */
export const TRACE_KINDS = {
  inmateStarved: 'inmate.starved',
  inmateMissedMeal: 'inmate.missedMeal',
  messEmptyAtMealtime: 'mess.emptyAtMealtime',
  messFull: 'mess.full',
  kitchenProducedShortfall: 'kitchen.producedShortfall',
  kitchenUnderCapacity: 'kitchen.underCapacity',
  kitchenNoIngredients: 'kitchen.noIngredients',
  kitchenNoCookAssigned: 'kitchen.noCookAssigned',
  kitchenNoRouteToMess: 'kitchen.noRouteToMess',
  laundryNoRouteToHousing: 'laundry.noRouteToHousing',
  laundryUnderCapacity: 'laundry.underCapacity',
  laundryNoLabour: 'laundry.noLabour',
  cleaningNoCleaners: 'cleaning.noCleaners',
  staffBribeTaken: 'morale.bribeTaken',
  staffStrikeStarted: 'morale.strikeStarted',
  staffPayDemand: 'morale.payDemand',
  // T4.1 posts
  postUnfilled: 'post.unfilled',
  // T4.2 contraband
  contrabandThrowInIntercepted: 'contraband.throwInIntercepted',
  // T4.3 search
  searchPerformed: 'search.performed',
  searchFound: 'search.found',
  searchIntakeDelayed: 'search.intakeDelayed',
  searchMetalDetect: 'search.metalDetect',
  searchDogDetect: 'search.dogDetect',
  searchStandingOrderApplied: 'search.standingOrderApplied',
  // T4.4 misconduct / punishment
  misconductCommitted: 'misconduct.committed',
  punishmentStarted: 'punishment.started',
  // T4.5 combat
  combatFightStarted: 'combat.fightStarted',
  combatDied: 'combat.died',
  // T4.6 danger / riot / emergency / failure
  dangerRecomputed: 'danger.recomputed',
  riotStarted: 'riot.started',
  riotContained: 'riot.contained',
  emergencyRiotSquadCalled: 'emergency.riotSquadCalled',
  emergencyNationalGuardCalled: 'emergency.nationalGuardCalled',
  emergencyPlayerFired: 'emergency.playerFired',
  failureRiotWarning: 'failure.riotWarning',
  failureRiot: 'failure.riot',
  failureRiotCancelled: 'failure.riotCancelled',
  // T4.7 escape
  escapeTunnelDiscovered: 'escape.tunnelDiscovered',
  escapeInmateEscaped: 'escape.inmateEscaped',
  escapeFailureWarning: 'escape.failureWarning',
  escapeFailure: 'escape.failure',
  // T4.8 fire
  fireIgnited: 'fire.ignited',
  fireSpread: 'fire.spread',
  fireExtinguished: 'fire.extinguished',
  fireObjectDestroyed: 'fire.objectDestroyed',
  fireAgentDamaged: 'fire.agentDamaged',
  fireSprinklerActive: 'fire.sprinklerActive',
  fireFirefighterSummoned: 'fire.firefighterSummoned',
  fireFirefighterRejected: 'fire.firefighterRejected',
  fireOverloadMarked: 'fire.overloadMarked',
  // T5.5 utilities
  utilitiesBrownout: 'utilities.brownout',
  // T5.1 Directorate
  directorateResearchPaused: 'directorate.paused',
} as const

export type TraceKind = (typeof TRACE_KINDS)[keyof typeof TRACE_KINDS]

/** Every registered Trace kind, in a stable order for tests. */
export const REGISTERED_TRACE_KINDS: readonly TraceKind[] = [
  TRACE_KINDS.inmateStarved,
  TRACE_KINDS.inmateMissedMeal,
  TRACE_KINDS.messEmptyAtMealtime,
  TRACE_KINDS.messFull,
  TRACE_KINDS.kitchenProducedShortfall,
  TRACE_KINDS.kitchenUnderCapacity,
  TRACE_KINDS.kitchenNoIngredients,
  TRACE_KINDS.kitchenNoCookAssigned,
  TRACE_KINDS.kitchenNoRouteToMess,
  TRACE_KINDS.laundryNoRouteToHousing,
  TRACE_KINDS.laundryUnderCapacity,
  TRACE_KINDS.laundryNoLabour,
  TRACE_KINDS.cleaningNoCleaners,
  TRACE_KINDS.staffBribeTaken,
  TRACE_KINDS.staffStrikeStarted,
  TRACE_KINDS.staffPayDemand,
  TRACE_KINDS.postUnfilled,
  TRACE_KINDS.contrabandThrowInIntercepted,
  TRACE_KINDS.searchPerformed,
  TRACE_KINDS.searchFound,
  TRACE_KINDS.searchIntakeDelayed,
  TRACE_KINDS.searchMetalDetect,
  TRACE_KINDS.searchDogDetect,
  TRACE_KINDS.searchStandingOrderApplied,
  TRACE_KINDS.misconductCommitted,
  TRACE_KINDS.punishmentStarted,
  TRACE_KINDS.combatFightStarted,
  TRACE_KINDS.combatDied,
  TRACE_KINDS.dangerRecomputed,
  TRACE_KINDS.riotStarted,
  TRACE_KINDS.riotContained,
  TRACE_KINDS.emergencyRiotSquadCalled,
  TRACE_KINDS.emergencyNationalGuardCalled,
  TRACE_KINDS.emergencyPlayerFired,
  TRACE_KINDS.failureRiotWarning,
  TRACE_KINDS.failureRiot,
  TRACE_KINDS.failureRiotCancelled,
  TRACE_KINDS.escapeTunnelDiscovered,
  TRACE_KINDS.escapeInmateEscaped,
  TRACE_KINDS.escapeFailureWarning,
  TRACE_KINDS.escapeFailure,
  TRACE_KINDS.fireIgnited,
  TRACE_KINDS.fireSpread,
  TRACE_KINDS.fireExtinguished,
  TRACE_KINDS.fireObjectDestroyed,
  TRACE_KINDS.fireAgentDamaged,
  TRACE_KINDS.fireSprinklerActive,
  TRACE_KINDS.fireFirefighterSummoned,
  TRACE_KINDS.fireFirefighterRejected,
  TRACE_KINDS.fireOverloadMarked,
  TRACE_KINDS.utilitiesBrownout,
  TRACE_KINDS.directorateResearchPaused,
]

export interface CausalEventLogOptions {
  /** Defaults to {@link TRACE_BUFFER_CAPACITY}. */
  readonly capacity?: number
}

/**
 * Ring-buffered CausalEvent store that implements `EventSink`.
 *
 * Eviction never drops an event whose pin count is above zero, so a toast that
 * still points at a Trace keeps its whole retained chain even after the tip
 * ages out of the 20,000-event window.
 */
export class CausalEventLog implements EventSink {
  readonly capacity: number

  #nextId: EventId = 1
  readonly #events = new Map<EventId, CausalEvent>()
  /** Insertion order of events still counted against the ring capacity. */
  readonly #ring: EventId[] = []
  readonly #inRing = new Set<EventId>()
  /** Refcount: an active notification (or explicit pin) holds the chain. */
  readonly #pinCounts = new Map<EventId, number>()

  constructor(options: CausalEventLogOptions = {}) {
    this.capacity = options.capacity ?? TRACE_BUFFER_CAPACITY
    if (!Number.isInteger(this.capacity) || this.capacity < 1) {
      throw new RangeError(`capacity must be a positive integer, received ${String(this.capacity)}`)
    }
  }

  /** Events retained right now (ring + pinned-but-evicted). */
  get size(): number {
    return this.#events.size
  }

  /** Events still occupying a ring slot. Always ≤ {@link capacity}. */
  get ringSize(): number {
    return this.#ring.length
  }

  get pinnedCount(): number {
    let n = 0
    for (const count of this.#pinCounts.values()) {
      if (count > 0) n += 1
    }
    return n
  }

  /**
   * Records an event and returns it with an assigned id.
   *
   * Prefer this over `emit` when the caller needs the id to wire later causes.
   */
  record(event: SimulationEvent): CausalEvent {
    const id = this.#nextId
    this.#nextId = this.#nextId >= 0xffff_ffff ? 1 : this.#nextId + 1

    const requestedCauses = dedupeCauses(event.causeIds)
    // Pre-T3.1 emitters sometimes stuffed entity / site ids into `causeIds`.
    // Those are not EventIds; drop anything the log does not know so recording
    // never aborts a tick. Real causal links pass because the cause was
    // recorded earlier in the same log.
    const causeIds = requestedCauses.filter((causeId) => this.#events.has(causeId))

    const recorded: CausalEvent = {
      id,
      tick: event.tick,
      kind: event.kind,
      subjectId: event.subjectId ?? 0,
      causeIds,
      data: event.data,
    }

    this.#events.set(id, recorded)
    this.#ring.push(id)
    this.#inRing.add(id)
    this.#evict()
    return recorded
  }

  /** `EventSink` entry point. */
  emit(event: SimulationEvent): void {
    this.record(event)
  }

  get(id: EventId): CausalEvent | undefined {
    return this.#events.get(id)
  }

  has(id: EventId): boolean {
    return this.#events.has(id)
  }

  isPinned(id: EventId): boolean {
    return (this.#pinCounts.get(id) ?? 0) > 0
  }

  /**
   * Retains `eventId` and every reachable cause (unbounded walk — pinning is
   * for active notifications, not the Trace depth limit).
   */
  pin(eventId: EventId): void {
    for (const id of this.#walkCauses(eventId)) {
      this.#pinCounts.set(id, (this.#pinCounts.get(id) ?? 0) + 1)
    }
  }

  /** Drops one pin hold on the chain rooted at `eventId`. */
  unpin(eventId: EventId): void {
    for (const id of this.#walkCauses(eventId)) {
      const current = this.#pinCounts.get(id) ?? 0
      if (current <= 1) {
        this.#pinCounts.delete(id)
        if (!this.#inRing.has(id)) {
          this.#events.delete(id)
        }
      } else {
        this.#pinCounts.set(id, current - 1)
      }
    }
  }

  /** Ids currently retained, oldest ring-first then pinned-only. */
  retainedIds(): readonly EventId[] {
    const out: EventId[] = [...this.#ring]
    for (const id of this.#events.keys()) {
      if (!this.#inRing.has(id)) out.push(id)
    }
    return out
  }

  /**
   * Events currently retained, oldest first.
   *
   * The Reports Log consumes this read-only projection rather than reaching
   * into the recorder's maps. Pinned-only entries are included after the ring
   * in the same stable order as {@link retainedIds}.
   */
  retainedEvents(): readonly CausalEvent[] {
    const events: CausalEvent[] = []
    for (const id of this.retainedIds()) {
      const event = this.#events.get(id)
      if (event !== undefined) events.push(event)
    }
    return events
  }

  #evict(): void {
    while (this.#ring.length > this.capacity) {
      // Oldest ring entry. Checked: length > 0 above.
      const oldest = this.#ring.shift()
      if (oldest === undefined) return
      this.#inRing.delete(oldest)
      if ((this.#pinCounts.get(oldest) ?? 0) > 0) {
        // Pinned: leave in #events. Ring length has shrunk.
        continue
      }
      this.#events.delete(oldest)
    }
  }

  /** BFS over causes, including the root. Unknown roots yield an empty list. */
  #walkCauses(rootId: EventId): EventId[] {
    if (!this.#events.has(rootId)) return []
    const out: EventId[] = []
    const seen = new Set<EventId>()
    const queue: EventId[] = [rootId]
    while (queue.length > 0) {
      // Checked: length > 0.
      const id = queue.shift()
      if (id === undefined) break
      if (seen.has(id)) continue
      seen.add(id)
      out.push(id)
      const event = this.#events.get(id)
      if (event === undefined) continue
      for (const causeId of event.causeIds) {
        if (!seen.has(causeId) && this.#events.has(causeId)) {
          queue.push(causeId)
        }
      }
    }
    return out
  }
}

function dedupeCauses(causeIds: readonly number[]): readonly EventId[] {
  if (causeIds.length === 0) return []
  const seen = new Set<EventId>()
  const out: EventId[] = []
  for (const id of causeIds) {
    if (!Number.isInteger(id) || id <= 0) {
      throw new RangeError(`cause id must be a positive integer, received ${String(id)}`)
    }
    if (seen.has(id)) continue
    seen.add(id)
    out.push(id)
  }
  return out
}

/** Narrow `data` to a plain object for string / fix helpers. */
export function eventDataObject(data: JsonValue): JsonObject {
  if (data !== null && typeof data === 'object' && !isJsonArray(data)) {
    return data
  }
  return {}
}
