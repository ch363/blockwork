/**
 * `IntelligenceSystem`: informants, phone monitoring, and the map they draw
 * (T5.6, PRD 5.10).
 *
 * Contraband is invisible by design. A prison can be swimming in it and the
 * player sees only the consequences — fights, overdoses, a shank in a search.
 * Intelligence is the mechanic that turns that into a picture, and it costs
 * something real: an informant is an inmate you have put in danger.
 *
 * Three moving parts.
 *
 * **Recruitment** is a *pair* of conditions, not a single stat. Low loyalty
 * says they would inform; high fear says they need to. Someone loyal is not
 * for sale at any price, and someone unafraid has no reason to take the risk,
 * so a prison that is either too soft or too tight recruits nobody — and that
 * is the tension the mechanic exists to create.
 *
 * **Revelation** is positional. An informant reveals what is near *them*, so
 * coverage is a map problem: three informants in the same wing tell you about
 * one wing. The panel draws the radii for exactly this reason.
 *
 * **Being blown** is the price. A daily roll, raised by careless handling —
 * summoning someone in the open where the wing can see them go — and once
 * blown they are a target, which is how a player learns that intelligence is
 * not free surveillance.
 *
 * Slot: PRD 4.4 #12, the security band.
 */

import { TICKS_PER_DAY, TICKS_PER_MINUTE } from '../core/clock'
import type { Command, JsonObject, JsonValue } from '../core/commands'
import type { Fnv1aHasher } from '../core/hash'
import type { RngStream } from '../core/rng'
import type { CommandHandler, EventSink, System, SystemContext } from '../core/simulation'
import type { GameData } from '../data/loader'
import type { Balance } from '../data/schemas'
import { hasFeature } from '../entities/directorate'
import { applyDamage } from '../entities/health'
import type { InmateEntity } from '../entities/inmate'
import { NO_ROOM } from '../world/rooms'

import { isInmateWorld } from './intakeSystem'
import type { InmateWorld } from './intakeSystem'

/* -------------------------------------------------------------------------- */
/* Identity                                                                    */
/* -------------------------------------------------------------------------- */

export const INTELLIGENCE_SYSTEM_NAME = 'intelligence'
export const INTELLIGENCE_SYSTEM_PERIOD = TICKS_PER_MINUTE
export const INTELLIGENCE_RNG_STREAM = 'intelligence'

export const INTELLIGENCE_EVENTS = {
  recruited: 'intelligence.recruited',
  revealed: 'intelligence.revealed',
  blown: 'intelligence.blown',
  assassinationAttempt: 'intelligence.assassinationAttempt',
  phoneTapReveal: 'intelligence.phoneTapReveal',
  rejected: 'intelligence.rejected',
} as const

export type RecruitRejection =
  | 'wrong-world'
  | 'invalid-payload'
  | 'feature-locked'
  | 'unknown-inmate'
  | 'already-informant'
  | 'too-loyal'
  | 'not-afraid-enough'
  | 'roster-full'
  | 'insufficient-funds'

/* -------------------------------------------------------------------------- */
/* State                                                                       */
/* -------------------------------------------------------------------------- */

export interface Informant {
  readonly inmateId: number
  readonly recruitedTick: number
  /** True once the wing works out who they are. */
  blown: boolean
  readonly blownTick: number
  /** Set when the player summoned them somewhere visible this day. */
  carelesslyHandled: boolean
  /** Stashes and throw-ins this informant has surfaced. */
  revealCount: number
}

export interface IntelligenceSnapshot extends JsonObject {
  readonly informants: readonly {
    readonly inmateId: number
    readonly recruitedTick: number
    readonly blown: boolean
    readonly blownTick: number
    readonly carelesslyHandled: boolean
    readonly revealCount: number
  }[]
  readonly revealedStashIds: readonly number[]
  readonly revealedThrowInIds: readonly number[]
  readonly lastBlowRollDay: number
}

export class IntelligenceRuntime {
  readonly informants = new Map<number, Informant>()
  /** Stash ids the player can see. */
  readonly revealedStashIds = new Set<number>()
  /** Arranged throw-in ids the player can see. */
  readonly revealedThrowInIds = new Set<number>()
  lastBlowRollDay = -1

  roster(): Informant[] {
    return [...this.informants.values()].sort((a, b) => a.inmateId - b.inmateId)
  }

  activeCount(): number {
    let count = 0
    for (const informant of this.informants.values()) {
      if (!informant.blown) count += 1
    }
    return count
  }

  clearInmate(inmateId: number): void {
    this.informants.delete(inmateId)
  }

  serialise(): IntelligenceSnapshot {
    return {
      informants: this.roster().map((informant) => ({ ...informant })),
      revealedStashIds: [...this.revealedStashIds].sort((a, b) => a - b),
      revealedThrowInIds: [...this.revealedThrowInIds].sort((a, b) => a - b),
      lastBlowRollDay: this.lastBlowRollDay,
    }
  }

  restore(snapshot: IntelligenceSnapshot): void {
    this.informants.clear()
    this.revealedStashIds.clear()
    this.revealedThrowInIds.clear()
    for (const entry of snapshot.informants) {
      this.informants.set(entry.inmateId, {
        inmateId: entry.inmateId,
        recruitedTick: entry.recruitedTick,
        blown: entry.blown,
        blownTick: entry.blownTick,
        carelesslyHandled: entry.carelesslyHandled,
        revealCount: entry.revealCount,
      })
    }
    for (const id of snapshot.revealedStashIds) this.revealedStashIds.add(id)
    for (const id of snapshot.revealedThrowInIds) this.revealedThrowInIds.add(id)
    this.lastBlowRollDay = snapshot.lastBlowRollDay
  }

  hashInto(hasher: Fnv1aHasher): void {
    const roster = this.roster()
    hasher.writeUint32(roster.length)
    for (const informant of roster) {
      hasher.writeUint32(informant.inmateId)
      hasher.writeUint32(informant.recruitedTick)
      hasher.writeUint32(informant.blown ? 1 : 0)
      hasher.writeUint32(informant.blownTick)
      hasher.writeUint32(informant.carelesslyHandled ? 1 : 0)
      hasher.writeUint32(informant.revealCount)
    }
    const stashes = [...this.revealedStashIds].sort((a, b) => a - b)
    hasher.writeUint32(stashes.length)
    for (const id of stashes) hasher.writeUint32(id)
    const throwIns = [...this.revealedThrowInIds].sort((a, b) => a - b)
    hasher.writeUint32(throwIns.length)
    for (const id of throwIns) hasher.writeUint32(id)
    hasher.writeUint32(this.lastBlowRollDay + 1)
  }
}

/* -------------------------------------------------------------------------- */
/* Eligibility                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * How attached this inmate is to the other side, 0..100.
 *
 * The `loyal` trait is the whole story where it exists; `deceitful` is its
 * mirror. Everything else sits at the baseline, which is deliberately above
 * the recruitment threshold: informing is the exception, not the default.
 */
export function informantLoyalty(
  balance: Balance['intelligence']['recruitment'],
  entity: InmateEntity,
): number {
  let loyalty = balance.baseLoyalty
  if (entity.inmate.traits.includes('loyal')) loyalty += balance.loyalTraitBonus
  if (entity.inmate.traits.includes('deceitful')) loyalty -= balance.deceitfulTraitPenalty
  return clamp100(loyalty)
}

/**
 * How frightened they are, 0..100.
 *
 * Suppression, the prison's danger level and their own injuries, weighted.
 * A safe, unsuppressed prison produces no informants at all, which is the
 * honest cost of running one.
 */
export function informantFear(
  balance: Balance['intelligence']['recruitment'],
  entity: InmateEntity,
  dangerLevel: number,
): number {
  const injury = 100 - clamp100(entity.inmate.health)
  return clamp100(
    entity.inmate.suppression * balance.fearFromSuppression +
      dangerLevel * balance.fearFromDanger +
      injury * balance.fearFromInjury,
  )
}

export interface RecruitCheck {
  readonly ok: boolean
  readonly reason?: RecruitRejection
  readonly loyalty: number
  readonly fear: number
}

/** Every rule that decides whether this inmate can be turned. */
export function checkRecruit(
  world: InmateWorld,
  data: GameData,
  entity: InmateEntity,
): RecruitCheck {
  const balance = data.balance.intelligence
  const loyalty = informantLoyalty(balance.recruitment, entity)
  const fear = informantFear(balance.recruitment, entity, world.dangerLevel)

  if (world.intelligence.informants.has(entity.id)) {
    return { ok: false, reason: 'already-informant', loyalty, fear }
  }
  if (world.intelligence.activeCount() >= balance.maxInformants) {
    return { ok: false, reason: 'roster-full', loyalty, fear }
  }
  if (loyalty > balance.recruitment.maxLoyalty) {
    return { ok: false, reason: 'too-loyal', loyalty, fear }
  }
  if (fear < balance.recruitment.minFear) {
    return { ok: false, reason: 'not-afraid-enough', loyalty, fear }
  }
  if (world.economy.balance < balance.recruitCost) {
    return { ok: false, reason: 'insufficient-funds', loyalty, fear }
  }
  return { ok: true, loyalty, fear }
}

/* -------------------------------------------------------------------------- */
/* Revelation                                                                  */
/* -------------------------------------------------------------------------- */

function chebyshev(ax: number, ay: number, bx: number, by: number): number {
  return Math.max(Math.abs(ax - bx), Math.abs(ay - by))
}

function clamp100(value: number): number {
  if (value <= 0) return 0
  if (value >= 100) return 100
  return value
}

/**
 * One reveal pass: every unblown informant surfaces what is within reach.
 *
 * Stashes, arranged throw-ins and the hidden reputations of nearby inmates,
 * all inside `revealRadiusTiles` of where the informant is standing right now.
 * A blown informant reveals nothing — nobody talks to them any more.
 */
export function revealNearInformants(
  world: InmateWorld,
  data: GameData,
  events: EventSink,
  tick: number,
): number {
  const radius = data.balance.intelligence.revealRadiusTiles
  const size = world.grid.size
  let revealed = 0

  for (const informant of world.intelligence.roster()) {
    if (informant.blown) continue
    const entity = world.inmates.get(informant.inmateId)
    if (entity === undefined) continue

    for (const stash of world.contraband.stashes) {
      if (world.intelligence.revealedStashIds.has(stash.id)) continue
      const y = Math.floor(stash.tileIndex / size)
      const x = stash.tileIndex - y * size
      if (chebyshev(entity.tx, entity.ty, x, y) > radius) continue
      world.intelligence.revealedStashIds.add(stash.id)
      informant.revealCount += 1
      revealed += 1
      events.emit({
        tick,
        kind: INTELLIGENCE_EVENTS.revealed,
        subjectId: informant.inmateId,
        causeIds: [],
        data: { kind: 'stash', stashId: stash.id, itemId: stash.itemId, tile: stash.tileIndex },
      })
    }

    for (const throwIn of world.contraband.throwIns) {
      if (throwIn.resolved) continue
      if (world.intelligence.revealedThrowInIds.has(throwIn.id)) continue
      const y = Math.floor(throwIn.tileIndex / size)
      const x = throwIn.tileIndex - y * size
      if (chebyshev(entity.tx, entity.ty, x, y) > radius) continue
      world.intelligence.revealedThrowInIds.add(throwIn.id)
      informant.revealCount += 1
      revealed += 1
      events.emit({
        tick,
        kind: INTELLIGENCE_EVENTS.revealed,
        subjectId: informant.inmateId,
        causeIds: [],
        data: {
          kind: 'throwIn',
          throwInId: throwIn.id,
          itemId: throwIn.itemId,
          tile: throwIn.tileIndex,
        },
      })
    }

    for (const other of world.inmates.all()) {
      if (other.id === informant.inmateId) continue
      if (chebyshev(entity.tx, entity.ty, other.tx, other.ty) > radius) continue
      for (const reputation of other.inmate.reputations) {
        if (reputation.revealed) continue
        reputation.revealed = true
        informant.revealCount += 1
        revealed += 1
        events.emit({
          tick,
          kind: INTELLIGENCE_EVENTS.revealed,
          subjectId: other.id,
          causeIds: [],
          data: {
            kind: 'reputation',
            reputationId: reputation.id,
            viaInformant: informant.inmateId,
          },
        })
      }
    }
  }

  return revealed
}

/**
 * Phone monitoring: a tapped booth gives up what the caller was arranging.
 *
 * A `phone_tap` in the same room as a `phone_booth` is what makes the booth
 * monitored, so the player builds the capability rather than toggling it. The
 * reveal is a roll, not a certainty — a tap is a lead, not a transcript.
 */
export function runPhoneMonitoring(
  world: InmateWorld,
  data: GameData,
  events: EventSink,
  rng: RngStream,
  tick: number,
): number {
  const monitored = monitoredBoothRooms(world)
  if (monitored.size === 0) return 0

  const chance = data.balance.intelligence.phoneTapRevealChance
  let revealed = 0

  for (const entity of world.inmates.all()) {
    const tile = world.grid.idx(entity.tx, entity.ty)
    const roomId = world.grid.getAt('roomId', tile)
    if (roomId === NO_ROOM || !monitored.has(roomId)) continue

    // Always draw, so who is standing where cannot shift another's stream.
    if (!rng.chance(chance)) continue

    for (const throwIn of world.contraband.throwIns) {
      if (throwIn.inmateId !== entity.id || throwIn.resolved) continue
      if (world.intelligence.revealedThrowInIds.has(throwIn.id)) continue
      world.intelligence.revealedThrowInIds.add(throwIn.id)
      revealed += 1
      events.emit({
        tick,
        kind: INTELLIGENCE_EVENTS.phoneTapReveal,
        subjectId: entity.id,
        causeIds: [],
        data: { kind: 'throwIn', throwInId: throwIn.id, itemId: throwIn.itemId, roomId },
      })
    }

    for (const reputation of entity.inmate.reputations) {
      if (reputation.revealed) continue
      reputation.revealed = true
      revealed += 1
      events.emit({
        tick,
        kind: INTELLIGENCE_EVENTS.phoneTapReveal,
        subjectId: entity.id,
        causeIds: [],
        data: { kind: 'reputation', reputationId: reputation.id, roomId },
      })
    }
  }

  return revealed
}

/** Rooms holding both a phone booth and a tap. */
export function monitoredBoothRooms(world: InmateWorld): Set<number> {
  const rooms = new Set<number>()
  for (const room of world.rooms.all()) {
    if (world.objects.objectCount(room.id, 'phone_booth') === 0) continue
    if (world.objects.objectCount(room.id, 'phone_tap') === 0) continue
    rooms.add(room.id)
  }
  return rooms
}

/* -------------------------------------------------------------------------- */
/* Being blown                                                                 */
/* -------------------------------------------------------------------------- */

/** The daily chance the wing works out who is talking. */
export function blowChance(balance: Balance['intelligence'], informant: Informant): number {
  const base = balance.blowChancePerDay
  return Math.min(1, base + (informant.carelesslyHandled ? balance.carelessSummonBlowBonus : 0))
}

/**
 * The daily blow roll, and the murder attempt that follows.
 *
 * A blown informant is not merely useless — PRD 5.10 makes them a target, and
 * the attempt is rolled here rather than left to the ordinary misconduct path
 * because it is retribution, not a fight that happened to break out.
 */
export function rollBlowAndRetribution(
  world: InmateWorld,
  data: GameData,
  events: EventSink,
  rng: RngStream,
  tick: number,
): { readonly blown: number; readonly attempts: number } {
  const balance = data.balance.intelligence
  const day = Math.floor(tick / TICKS_PER_DAY)
  if (day === world.intelligence.lastBlowRollDay) return { blown: 0, attempts: 0 }
  world.intelligence.lastBlowRollDay = day

  let blown = 0
  let attempts = 0

  for (const informant of world.intelligence.roster()) {
    const entity = world.inmates.get(informant.inmateId)
    if (entity === undefined) {
      world.intelligence.informants.delete(informant.inmateId)
      continue
    }

    if (!informant.blown) {
      const chance = blowChance(balance, informant)
      // Always draw, so a careless summon cannot shift another informant's roll.
      const isBlown = rng.chance(chance)
      informant.carelesslyHandled = false
      if (!isBlown) continue

      informant.blown = true
      ;(informant as { blownTick: number }).blownTick = tick
      blown += 1
      events.emit({
        tick,
        kind: INTELLIGENCE_EVENTS.blown,
        subjectId: informant.inmateId,
        causeIds: [],
        data: { chance, revealCount: informant.revealCount },
      })
      continue
    }

    // Already blown: the wing comes for them.
    if (!rng.chance(balance.assassinationChancePerDay)) continue
    attempts += 1
    const result = applyDamage(
      entity.inmate.health,
      balance.assassinationDamage,
      data.balance.combat,
    )
    entity.inmate.health = result.healthAfter
    events.emit({
      tick,
      kind: INTELLIGENCE_EVENTS.assassinationAttempt,
      subjectId: informant.inmateId,
      causeIds: [],
      data: {
        damage: balance.assassinationDamage,
        health: entity.inmate.health,
        outcome: result.outcome,
      },
    })
  }

  return { blown, attempts }
}

/* -------------------------------------------------------------------------- */
/* Panel model                                                                 */
/* -------------------------------------------------------------------------- */

export interface ContrabandSourceRow {
  readonly roomId: number
  readonly roomDefId: string
  /** Stashes found in this room that the player can see. */
  readonly revealedStashes: number
  /** Stashes actually there, whether seen or not. */
  readonly actualStashes: number
}

/**
 * Contraband by room, as the panel's source map needs it.
 *
 * Both numbers are returned so the panel can shade "what you know" against
 * "what is there" — the gap is the argument for another informant.
 */
export function contrabandByRoom(world: InmateWorld): ContrabandSourceRow[] {
  const rows = new Map<number, { revealed: number; actual: number; defId: string }>()

  for (const stash of world.contraband.stashes) {
    const roomId = world.grid.getAt('roomId', stash.tileIndex)
    if (roomId === NO_ROOM) continue
    const room = world.rooms.get(roomId)
    if (room === undefined) continue
    const row = rows.get(roomId) ?? { revealed: 0, actual: 0, defId: room.defId }
    row.actual += 1
    if (world.intelligence.revealedStashIds.has(stash.id)) row.revealed += 1
    rows.set(roomId, row)
  }

  return [...rows.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([roomId, row]) => ({
      roomId,
      roomDefId: row.defId,
      revealedStashes: row.revealed,
      actualStashes: row.actual,
    }))
}

export interface ContrabandPriceRow {
  readonly itemId: string
  readonly price: number
  /** Units in circulation: on people and in stashes. */
  readonly supply: number
  /** Inmates who want one, by the need the item serves. */
  readonly demand: number
}

/** The live price / supply / demand table. */
export function contrabandMarket(world: InmateWorld, data: GameData): ContrabandPriceRow[] {
  const rows: ContrabandPriceRow[] = []

  for (const def of data.contraband.all) {
    let supply = 0
    for (const stash of world.contraband.stashes) {
      if (stash.itemId === def.id) supply += 1
    }
    for (const entity of world.inmates.all()) {
      for (const itemId of entity.inmate.inventory) {
        if (itemId === def.id) supply += 1
      }
    }

    let demand = 0
    for (const entity of world.inmates.all()) {
      if (entity.inmate.inventory.includes(def.id)) continue
      demand += 1
    }

    rows.push({
      itemId: def.id,
      price: world.contraband.prices.get(def.id) ?? def.basePrice,
      supply,
      demand,
    })
  }

  rows.sort((a, b) => (a.itemId < b.itemId ? -1 : 1))
  return rows
}

/* -------------------------------------------------------------------------- */
/* The pass                                                                    */
/* -------------------------------------------------------------------------- */

export interface IntelligenceSystemOptions {
  readonly data: GameData
}

export function createIntelligenceSystem(options: IntelligenceSystemOptions): System {
  const { data } = options
  let reportedWrongWorld = false

  return {
    name: INTELLIGENCE_SYSTEM_NAME,
    period: INTELLIGENCE_SYSTEM_PERIOD,

    update(context: SystemContext): void {
      const world = context.world
      const tick = context.clock.tick

      if (!isInmateWorld(world)) {
        if (reportedWrongWorld) return
        reportedWrongWorld = true
        emitRejection(context.events, tick, 'wrong-world', {})
        return
      }

      const minutes = data.balance.intelligence.passMinutes
      if (minutes > 1 && tick % (minutes * TICKS_PER_MINUTE) !== 0) return

      const rng = context.rng.stream(INTELLIGENCE_RNG_STREAM)
      revealNearInformants(world, data, context.events, tick)
      runPhoneMonitoring(world, data, context.events, rng, tick)
      rollBlowAndRetribution(world, data, context.events, rng, tick)
    },
  }
}

/* -------------------------------------------------------------------------- */
/* Commands                                                                    */
/* -------------------------------------------------------------------------- */

export const INTELLIGENCE_COMMANDS = {
  recruit: 'intelligence.recruit',
  /** Marks an informant as summoned in the open, raising their blow chance. */
  summon: 'intelligence.summon',
} as const

export function intelligenceCommandHandlers(
  data: GameData,
): Readonly<Record<string, CommandHandler>> {
  return {
    [INTELLIGENCE_COMMANDS.recruit]: (command, context) => {
      handleRecruit(command, context, data)
    },
    [INTELLIGENCE_COMMANDS.summon]: (command, context) => {
      const world = context.world
      if (!isInmateWorld(world)) return
      const inmateId = readInt(command.payload, 'inmateId')
      if (inmateId === undefined) return
      const informant = world.intelligence.informants.get(inmateId)
      if (informant === undefined) return
      informant.carelesslyHandled = readBoolean(command.payload, 'inTheOpen') ?? true
    },
  }
}

function handleRecruit(command: Command, context: SystemContext, data: GameData): void {
  const world = context.world
  const tick = context.clock.tick
  if (!isInmateWorld(world)) {
    emitRejection(context.events, tick, 'wrong-world', {})
    return
  }

  const inmateId = readInt(command.payload, 'inmateId')
  if (inmateId === undefined) {
    emitRejection(context.events, tick, 'invalid-payload', {})
    return
  }

  if (!hasFeature(data, world.directorate, 'intelligence_panel')) {
    emitRejection(context.events, tick, 'feature-locked', {
      inmateId,
      featureId: 'intelligence_panel',
    })
    return
  }

  const entity = world.inmates.get(inmateId)
  if (entity === undefined) {
    emitRejection(context.events, tick, 'unknown-inmate', { inmateId })
    return
  }

  const check = checkRecruit(world, data, entity)
  if (!check.ok) {
    emitRejection(context.events, tick, check.reason ?? 'too-loyal', {
      inmateId,
      loyalty: check.loyalty,
      fear: check.fear,
    })
    return
  }

  const cost = data.balance.intelligence.recruitCost
  if (cost > 0) {
    world.economy.debit(tick, 'other', cost, `Informant: ${entity.inmate.name}`, inmateId)
  }
  world.intelligence.informants.set(inmateId, {
    inmateId,
    recruitedTick: tick,
    blown: false,
    blownTick: 0,
    carelesslyHandled: false,
    revealCount: 0,
  })

  context.events.emit({
    tick,
    kind: INTELLIGENCE_EVENTS.recruited,
    subjectId: inmateId,
    causeIds: [],
    data: { loyalty: check.loyalty, fear: check.fear, cost },
  })
}

function emitRejection(
  events: EventSink,
  tick: number,
  reason: RecruitRejection,
  detail: JsonObject,
): void {
  events.emit({
    tick,
    kind: INTELLIGENCE_EVENTS.rejected,
    causeIds: [],
    data: { reason, ...detail },
  })
}

function readInt(payload: JsonValue, key: string): number | undefined {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return undefined
  const value = (payload as JsonObject)[key]
  return typeof value === 'number' && Number.isInteger(value) ? value : undefined
}

function readBoolean(payload: JsonValue, key: string): boolean | undefined {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return undefined
  const value = (payload as JsonObject)[key]
  return typeof value === 'boolean' ? value : undefined
}
