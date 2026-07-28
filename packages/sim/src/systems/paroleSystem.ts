/**
 * `ParoleSystem`: hearings, and the queue that feeds them (T5.4, PRD 5.5).
 *
 * Parole is where the grades stop being a readout and start deciding
 * something. An inmate becomes eligible halfway through their sentence and
 * joins a queue; the panel sits a fixed number of hearings a day; the outcome
 * is a roll over reform, misconduct history and time served.
 *
 * A denial is not neutral. It applies `angry`, which raises the misconduct
 * roll for a day — so a prison that reforms nobody and denies everybody is
 * choosing to make its own next week worse, which is the trade the mechanic
 * exists to present.
 *
 * Slot: PRD 4.4 #17, hourly, after the grades it reads.
 */

import { TICKS_PER_DAY, TICKS_PER_HOUR } from '../core/clock'
import type { JsonObject } from '../core/commands'
import type { Fnv1aHasher } from '../core/hash'
import type { RngStream } from '../core/rng'
import type { EventSink, System, SystemContext } from '../core/simulation'
import type { GameData } from '../data/loader'
import type { Balance } from '../data/schemas'
import type { InmateEntity } from '../entities/inmate'
import { ensureStatus } from '../entities/health'

import { isInmateWorld } from './intakeSystem'
import type { InmateWorld } from './intakeSystem'
import { misconductInWindow } from './gradesSystem'
import { releaseInmate } from './releaseSystem'

export const PAROLE_SYSTEM_NAME = 'parole'
export const PAROLE_SYSTEM_PERIOD = TICKS_PER_HOUR
export const PAROLE_RNG_STREAM = 'parole'

export const PAROLE_EVENTS = {
  becameEligible: 'parole.becameEligible',
  hearingHeld: 'parole.hearingHeld',
  approved: 'parole.approved',
  denied: 'parole.denied',
  rejected: 'parole.rejected',
} as const

/* -------------------------------------------------------------------------- */
/* State                                                                       */
/* -------------------------------------------------------------------------- */

export interface ParoleRecord {
  readonly inmateId: number
  readonly eligibleAtTick: number
  /** Hearings already held. Each denial pushes the next one back a day. */
  hearingsHeld: number
  /** Tick the next hearing may be held, or 0 when it may be held now. */
  nextHearingTick: number
}

export interface ParoleSnapshot extends JsonObject {
  readonly queue: readonly {
    readonly inmateId: number
    readonly eligibleAtTick: number
    readonly hearingsHeld: number
    readonly nextHearingTick: number
  }[]
  readonly hearingsToday: number
  readonly hearingDay: number
}

export class ParoleRuntime {
  /** Ordered by eligibility tick, then id — the queue the panel shows. */
  readonly queue = new Map<number, ParoleRecord>()
  /** Hearings sat so far on `hearingDay`. */
  hearingsToday = 0
  hearingDay = 0

  ordered(): ParoleRecord[] {
    return [...this.queue.values()].sort((a, b) => {
      const delta = a.eligibleAtTick - b.eligibleAtTick
      return delta !== 0 ? delta : a.inmateId - b.inmateId
    })
  }

  clearInmate(inmateId: number): void {
    this.queue.delete(inmateId)
  }

  serialise(): ParoleSnapshot {
    return {
      queue: this.ordered().map((record) => ({
        inmateId: record.inmateId,
        eligibleAtTick: record.eligibleAtTick,
        hearingsHeld: record.hearingsHeld,
        nextHearingTick: record.nextHearingTick,
      })),
      hearingsToday: this.hearingsToday,
      hearingDay: this.hearingDay,
    }
  }

  restore(snapshot: ParoleSnapshot): void {
    this.queue.clear()
    for (const entry of snapshot.queue) {
      this.queue.set(entry.inmateId, {
        inmateId: entry.inmateId,
        eligibleAtTick: entry.eligibleAtTick,
        hearingsHeld: entry.hearingsHeld,
        nextHearingTick: entry.nextHearingTick,
      })
    }
    this.hearingsToday = snapshot.hearingsToday
    this.hearingDay = snapshot.hearingDay
  }

  hashInto(hasher: Fnv1aHasher): void {
    const records = this.ordered()
    hasher.writeUint32(records.length)
    for (const record of records) {
      hasher.writeUint32(record.inmateId)
      hasher.writeUint32(record.eligibleAtTick)
      hasher.writeUint32(record.hearingsHeld)
      hasher.writeUint32(record.nextHearingTick)
    }
    hasher.writeUint32(this.hearingsToday)
    hasher.writeUint32(this.hearingDay)
  }
}

/* -------------------------------------------------------------------------- */
/* Eligibility and the roll                                                    */
/* -------------------------------------------------------------------------- */

/** PRD 5.5: eligible once `eligibilityFraction` of the sentence is served. */
export function isParoleEligible(balance: Balance['parole'], entity: InmateEntity): boolean {
  const sentence = entity.inmate.sentenceHours
  if (sentence <= 0) return false
  return entity.inmate.servedHours >= sentence * balance.eligibilityFraction
}

/**
 * The chance the panel approves.
 *
 * Reform pushes it up, recent misconduct pushes it down, and time served
 * pushes it up — which is what makes a long-serving, well-behaved inmate the
 * one the player can most afford to let go, and a recent offender the one they
 * cannot.
 */
export function approvalChance(
  balance: Balance['parole'],
  options: {
    /** 0..1. */
    readonly reformGrade: number
    /** 0..1 normalised recent misconduct. */
    readonly misconductRate: number
    /** 0..1 fraction of the sentence served. */
    readonly servedFraction: number
  },
): number {
  const cfg = balance.approval
  const raw =
    cfg.base +
    cfg.reformWeight * options.reformGrade -
    cfg.misconductWeight * options.misconductRate +
    cfg.servedWeight * options.servedFraction
  return Math.min(cfg.max, Math.max(cfg.min, raw))
}

/* -------------------------------------------------------------------------- */
/* The hourly pass                                                             */
/* -------------------------------------------------------------------------- */

export interface ParoleSystemOptions {
  readonly data: GameData
}

export function createParoleSystem(options: ParoleSystemOptions): System {
  const { data } = options
  let reportedWrongWorld = false

  return {
    name: PAROLE_SYSTEM_NAME,
    period: PAROLE_SYSTEM_PERIOD,

    update(context: SystemContext): void {
      const world = context.world
      const tick = context.clock.tick

      if (!isInmateWorld(world)) {
        if (reportedWrongWorld) return
        reportedWrongWorld = true
        context.events.emit({
          tick,
          kind: PAROLE_EVENTS.rejected,
          causeIds: [],
          data: { reason: 'wrong-world' },
        })
        return
      }

      refreshQueue(world, data, context.events, tick)
      holdHearings(world, data, context.events, context.rng.stream(PAROLE_RNG_STREAM), tick)
    },
  }
}

/** Admits newly-eligible inmates to the queue. */
export function refreshQueue(
  world: InmateWorld,
  data: GameData,
  events: EventSink,
  tick: number,
): void {
  for (const entity of world.inmates.all()) {
    if (world.parole.queue.has(entity.id)) continue
    if (!isParoleEligible(data.balance.parole, entity)) continue

    world.parole.queue.set(entity.id, {
      inmateId: entity.id,
      eligibleAtTick: tick,
      hearingsHeld: 0,
      nextHearingTick: tick,
    })
    events.emit({
      tick,
      kind: PAROLE_EVENTS.becameEligible,
      subjectId: entity.id,
      causeIds: [],
      data: {
        servedHours: entity.inmate.servedHours,
        sentenceHours: entity.inmate.sentenceHours,
      },
    })
  }
}

/**
 * Sits up to `hearingsPerDay` hearings, oldest eligibility first.
 *
 * The daily cap is what makes the queue a queue. A prison that paroles nobody
 * for a month has a backlog it can see, which is the information the panel
 * exists to give.
 */
export function holdHearings(
  world: InmateWorld,
  data: GameData,
  events: EventSink,
  rng: RngStream,
  tick: number,
): number {
  const balance = data.balance.parole
  const day = Math.floor(tick / TICKS_PER_DAY)
  if (day !== world.parole.hearingDay) {
    world.parole.hearingDay = day
    world.parole.hearingsToday = 0
  }

  let held = 0
  for (const record of world.parole.ordered()) {
    if (world.parole.hearingsToday >= balance.hearingsPerDay) break
    if (tick < record.nextHearingTick) continue

    const entity = world.inmates.get(record.inmateId)
    if (entity === undefined) {
      world.parole.queue.delete(record.inmateId)
      continue
    }

    const misconduct = misconductInWindow(entity, data.balance, tick)
    const windowDays = data.balance.grades.security.windowDays
    const chance = approvalChance(balance, {
      reformGrade: entity.inmate.grades.reform / 100,
      misconductRate: Math.min(1, (misconduct.minor + misconduct.major) / windowDays),
      servedFraction:
        entity.inmate.sentenceHours <= 0
          ? 1
          : Math.min(1, entity.inmate.servedHours / entity.inmate.sentenceHours),
    })

    // Always draw, so the outcome of one hearing cannot shift the next.
    const approved = rng.chance(chance)
    record.hearingsHeld += 1
    world.parole.hearingsToday += 1
    held += 1

    events.emit({
      tick,
      kind: PAROLE_EVENTS.hearingHeld,
      subjectId: entity.id,
      causeIds: [],
      data: {
        chance,
        approved,
        hearingsHeld: record.hearingsHeld,
        reformGrade: entity.inmate.grades.reform,
      },
    })

    if (approved) {
      world.parole.queue.delete(record.inmateId)
      events.emit({
        tick,
        kind: PAROLE_EVENTS.approved,
        subjectId: entity.id,
        causeIds: [],
        data: { servedHours: entity.inmate.servedHours, chance },
      })
      releaseInmate(world, data, events, tick, entity, 'parole')
      continue
    }

    // Denied: angry for a day, and no second hearing until tomorrow.
    ensureStatus(entity.inmate.status, 'angry')
    record.nextHearingTick = tick + balance.deniedAngryHours * TICKS_PER_HOUR
    events.emit({
      tick,
      kind: PAROLE_EVENTS.denied,
      subjectId: entity.id,
      causeIds: [],
      data: {
        chance,
        nextHearingTick: record.nextHearingTick,
        angryHours: balance.deniedAngryHours,
      },
    })
  }

  return held
}
