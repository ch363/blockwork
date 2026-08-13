/**
 * `ReleaseSystem`: the gate, and what happens after it (T5.4, PRD 5.5, 5.15).
 *
 * An inmate leaves at the end of their sentence or on parole, walks out via
 * the dock, and — after a delay — rolls once against the `reoffendChance` the
 * prison gave them. That single roll is the game's actual scoreboard: every
 * programme, every hour of solitary and every unmet need has been quietly
 * moving it for the whole sentence.
 *
 * The delay matters. A re-offence that landed the instant someone walked out
 * would read as a dice roll; one that lands a month later, against a rolling
 * window, reads as a consequence, and it is what the recidivism failure
 * condition (PRD 5.15) counts.
 *
 * Slot: PRD 4.4 #17, hourly, after parole.
 */

import { TICKS_PER_DAY, TICKS_PER_HOUR } from '../core/clock'
import type { JsonObject } from '../core/commands'
import type { Fnv1aHasher } from '../core/hash'
import type { RngStream } from '../core/rng'
import type { EventSink, System, SystemContext } from '../core/simulation'
import type { GameData } from '../data/loader'
import type { InmateEntity } from '../entities/inmate'
import { NO_ROOM } from '../world/rooms'

import { failureArmed, isInmateWorld } from './intakeSystem'
import type { InmateWorld } from './intakeSystem'

export const RELEASE_SYSTEM_NAME = 'release'
export const RELEASE_SYSTEM_PERIOD = TICKS_PER_HOUR
export const RELEASE_RNG_STREAM = 'release'

export const RELEASE_EVENTS = {
  released: 'release.released',
  reoffended: 'release.reoffended',
  recidivismWarning: 'release.recidivismWarning',
  recidivismFailure: 'release.recidivismFailure',
  rejected: 'release.rejected',
} as const

export type ReleaseReason = 'sentence_served' | 'parole'

/* -------------------------------------------------------------------------- */
/* State                                                                       */
/* -------------------------------------------------------------------------- */

/** One person who has left, and the roll still pending on them. */
export interface ReleasedInmate {
  readonly inmateId: number
  readonly name: string
  readonly reason: ReleaseReason
  readonly releasedTick: number
  /** The chance this person carried out of the gate. */
  readonly reoffendChance: number
  /** When the roll happens. */
  readonly rollsAtTick: number
  /** Null until the roll has been made. */
  reoffended: boolean | null
  readonly reoffendedTick: number
}

export interface ReleaseSnapshot extends JsonObject {
  readonly released: readonly {
    readonly inmateId: number
    readonly name: string
    readonly reason: string
    readonly releasedTick: number
    readonly reoffendChance: number
    readonly rollsAtTick: number
    readonly reoffended: boolean | null
    readonly reoffendedTick: number
  }[]
  readonly lifetimeReleased: number
  readonly lifetimeReoffended: number
  readonly paroleReoffences: readonly number[]
  readonly recidivismWarned: boolean
}

/**
 * The lifetime ledger.
 *
 * Everyone who has left stays in the list, because the statistics panel's
 * rolling rate needs the denominator as much as the numerator, and because a
 * re-offence that lands a month after release has to find its record.
 */
export class ReleaseRuntime {
  readonly released: ReleasedInmate[] = []
  lifetimeReleased = 0
  lifetimeReoffended = 0
  /** Ticks of re-offences by *paroled* inmates — the failure condition's input. */
  readonly paroleReoffences: number[] = []
  recidivismWarned = false

  /** Releases and re-offences inside the rolling window, and the rate. */
  statistics(
    data: GameData,
    tick: number,
  ): {
    readonly released: number
    readonly reoffended: number
    readonly rate: number
    readonly lifetimeReleased: number
    readonly lifetimeReoffended: number
    readonly lifetimeRate: number
  } {
    const from = tick - data.balance.parole.statisticsWindowDays * TICKS_PER_DAY
    let released = 0
    let reoffended = 0
    for (const record of this.released) {
      if (record.releasedTick < from) continue
      released += 1
      if (record.reoffended === true) reoffended += 1
    }
    return {
      released,
      reoffended,
      rate: released === 0 ? 0 : reoffended / released,
      lifetimeReleased: this.lifetimeReleased,
      lifetimeReoffended: this.lifetimeReoffended,
      lifetimeRate:
        this.lifetimeReleased === 0 ? 0 : this.lifetimeReoffended / this.lifetimeReleased,
    }
  }

  serialise(): ReleaseSnapshot {
    return {
      released: this.released.map((record) => ({ ...record })),
      lifetimeReleased: this.lifetimeReleased,
      lifetimeReoffended: this.lifetimeReoffended,
      paroleReoffences: [...this.paroleReoffences],
      recidivismWarned: this.recidivismWarned,
    }
  }

  restore(snapshot: ReleaseSnapshot): void {
    this.released.length = 0
    for (const entry of snapshot.released) {
      this.released.push({
        inmateId: entry.inmateId,
        name: entry.name,
        reason: entry.reason === 'parole' ? 'parole' : 'sentence_served',
        releasedTick: entry.releasedTick,
        reoffendChance: entry.reoffendChance,
        rollsAtTick: entry.rollsAtTick,
        reoffended: entry.reoffended,
        reoffendedTick: entry.reoffendedTick,
      })
    }
    this.lifetimeReleased = snapshot.lifetimeReleased
    this.lifetimeReoffended = snapshot.lifetimeReoffended
    this.paroleReoffences.length = 0
    this.paroleReoffences.push(...snapshot.paroleReoffences)
    this.recidivismWarned = snapshot.recidivismWarned
  }

  hashInto(hasher: Fnv1aHasher): void {
    hasher.writeUint32(this.released.length)
    for (const record of this.released) {
      hasher.writeUint32(record.inmateId)
      hasher.writeString(record.reason)
      hasher.writeUint32(record.releasedTick)
      hasher.writeFloat64(record.reoffendChance)
      hasher.writeUint32(record.rollsAtTick)
      hasher.writeUint32(record.reoffended === null ? 2 : record.reoffended ? 1 : 0)
    }
    hasher.writeUint32(this.lifetimeReleased)
    hasher.writeUint32(this.lifetimeReoffended)
    hasher.writeUint32(this.paroleReoffences.length)
    for (const tick of this.paroleReoffences) hasher.writeUint32(tick)
    hasher.writeUint32(this.recidivismWarned ? 1 : 0)
  }
}

/* -------------------------------------------------------------------------- */
/* Release                                                                     */
/* -------------------------------------------------------------------------- */

/** The tile an inmate leaves from: the dock, or the map edge if none exists. */
export function dockTile(world: InmateWorld): number | undefined {
  for (const room of world.rooms.all()) {
    if (room.defId !== 'dock') continue
    const tile = room.tiles[0]
    if (tile !== undefined) return tile
  }
  return undefined
}

/**
 * Takes one inmate out of the prison and onto the ledger.
 *
 * Removal is immediate rather than escorted. A release is the one journey that
 * cannot fail — an inmate whose sentence has expired is not the prison's to
 * hold — so modelling it as an escort would mean a short-staffed prison
 * illegally detaining people, which is a different game.
 */
export function releaseInmate(
  world: InmateWorld,
  data: GameData,
  events: EventSink,
  tick: number,
  entity: InmateEntity,
  reason: ReleaseReason,
): void {
  const delayTicks = data.balance.parole.reoffendDelayDays * TICKS_PER_DAY
  const record: ReleasedInmate = {
    inmateId: entity.id,
    name: entity.inmate.name,
    reason,
    releasedTick: tick,
    reoffendChance: entity.inmate.reoffendChance,
    rollsAtTick: tick + delayTicks,
    reoffended: null,
    reoffendedTick: 0,
  }
  world.release.released.push(record)
  world.release.lifetimeReleased += 1

  const gate = dockTile(world)
  events.emit({
    tick,
    kind: RELEASE_EVENTS.released,
    subjectId: entity.id,
    causeIds: [],
    data: {
      name: entity.inmate.name,
      reason,
      servedHours: entity.inmate.servedHours,
      sentenceHours: entity.inmate.sentenceHours,
      reoffendChance: entity.inmate.reoffendChance,
      viaDockTile: gate ?? -1,
      grades: { ...entity.inmate.grades },
    },
  })

  // Everything that indexed this person by id lets go of them.
  world.inmates.assignHousing(entity.id, NO_ROOM)
  world.inmates.remove(entity.id)
  world.parole.clearInmate(entity.id)
  world.programs.clearInmate(entity.id)
  world.grades.clearInmate(entity.id)
  world.grading.clearInmate(entity.id)
  world.punishments.remove(entity.id)
}

/* -------------------------------------------------------------------------- */
/* The hourly pass                                                             */
/* -------------------------------------------------------------------------- */

export interface ReleaseSystemOptions {
  readonly data: GameData
}

export function createReleaseSystem(options: ReleaseSystemOptions): System {
  const { data } = options
  let reportedWrongWorld = false

  return {
    name: RELEASE_SYSTEM_NAME,
    period: RELEASE_SYSTEM_PERIOD,

    update(context: SystemContext): void {
      const world = context.world
      const tick = context.clock.tick

      if (!isInmateWorld(world)) {
        if (reportedWrongWorld) return
        reportedWrongWorld = true
        context.events.emit({
          tick,
          kind: RELEASE_EVENTS.rejected,
          causeIds: [],
          data: { reason: 'wrong-world' },
        })
        return
      }

      serveTime(world)
      releaseExpiredSentences(world, data, context.events, tick)
      rollPendingReoffences(world, context.events, context.rng.stream(RELEASE_RNG_STREAM), tick)
      checkRecidivismFailure(world, data, context.events, tick)
    },
  }
}

/** One more hour on everybody's clock. */
export function serveTime(world: InmateWorld): void {
  for (const entity of world.inmates.all()) {
    entity.inmate.servedHours += 1
  }
}

export function releaseExpiredSentences(
  world: InmateWorld,
  data: GameData,
  events: EventSink,
  tick: number,
): number {
  let released = 0
  for (const entity of world.inmates.all()) {
    if (entity.inmate.sentenceHours <= 0) continue
    if (entity.inmate.servedHours < entity.inmate.sentenceHours) continue
    releaseInmate(world, data, events, tick, entity, 'sentence_served')
    released += 1
  }
  return released
}

/**
 * Rolls every release whose delay has elapsed.
 *
 * One roll per person, ever. Rolling repeatedly would turn `reoffendChance`
 * into "eventually, everyone", which is neither what the PRD says nor a
 * scoreboard the player can move.
 */
export function rollPendingReoffences(
  world: InmateWorld,
  events: EventSink,
  rng: RngStream,
  tick: number,
): number {
  let reoffences = 0
  for (const record of world.release.released) {
    if (record.reoffended !== null) continue
    if (tick < record.rollsAtTick) continue

    const reoffended = rng.chance(record.reoffendChance)
    record.reoffended = reoffended
    if (!reoffended) continue

    // `reoffendedTick` is part of the record's identity once set.
    ;(record as { reoffendedTick: number }).reoffendedTick = tick
    world.release.lifetimeReoffended += 1
    reoffences += 1
    if (record.reason === 'parole') world.release.paroleReoffences.push(tick)

    events.emit({
      tick,
      kind: RELEASE_EVENTS.reoffended,
      subjectId: record.inmateId,
      causeIds: [],
      data: {
        name: record.name,
        reason: record.reason,
        chance: record.reoffendChance,
        daysSinceRelease: Math.floor((tick - record.releasedTick) / TICKS_PER_DAY),
      },
    })
  }
  return reoffences
}

/**
 * PRD 5.15: ten paroled inmates re-offending inside a rolling 30-day window
 * ends the game.
 *
 * A warning fires at the threshold and the failure at the threshold again, in
 * the same shape as the other failure ladders — the player is told before it
 * is over.
 */
export function checkRecidivismFailure(
  world: InmateWorld,
  data: GameData,
  events: EventSink,
  tick: number,
): boolean {
  // Disarmed at map creation, or PRD 7.9's no-failure mode (T6.5). The
  // re-offences are still counted and still shown; they simply cannot end
  // the game.
  if (!failureArmed(world, 'paroleRecidivism')) return false

  const { count, windowDays } = data.balance.failure.paroleRecidivism
  const from = tick - windowDays * TICKS_PER_DAY

  // Old entries can never re-enter the window; dropping them keeps the list
  // bounded over a long game.
  while (world.release.paroleReoffences.length > 0) {
    const oldest = world.release.paroleReoffences[0]
    if (oldest === undefined || oldest >= from) break
    world.release.paroleReoffences.shift()
  }

  const inWindow = world.release.paroleReoffences.length
  if (inWindow < count) return false

  if (!world.release.recidivismWarned) {
    world.release.recidivismWarned = true
    events.emit({
      tick,
      kind: RELEASE_EVENTS.recidivismWarning,
      causeIds: [],
      data: { reoffences: inWindow, threshold: count, windowDays },
    })
    return false
  }

  events.emit({
    tick,
    kind: RELEASE_EVENTS.recidivismFailure,
    causeIds: [],
    data: { reoffences: inWindow, threshold: count, windowDays },
  })
  return true
}
