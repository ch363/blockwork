/**
 * `SearchSystem`: detection, searches and Standing Orders (T4.3, PRD 5.10).
 *
 * Search kinds: individual, cell, block, prison-wide shakedown, and automatic
 * intake hall searches. Detection chances are data-driven and scaled by staff
 * morale. Metal detectors and dogs are passive pass-through detectors.
 *
 * Standing Orders hold the misconduct → punishment matrix, per-type search
 * triggers, cell reassignment strictness, and meal quantity / variety. Meal
 * policy writes through to `MealLogistics.standingOrders` so the kitchen chain
 * (T3.3) stays the single consumer of meal numbers.
 *
 * Contraband uses T4.2 inventory + tile stashes on {@link ContrabandState}.
 * Standing Orders policy lives on InmateWorld (shared with T4.4).
 */

import { isJsonArray } from '../core/commands'
import type { JsonValue } from '../core/commands'
import { TICKS_PER_MINUTE } from '../core/clock'
import type { Fnv1aHasher } from '../core/hash'
import type { RngStream } from '../core/rng'
import type { CommandHandler, EventSink, System, SystemContext } from '../core/simulation'
import type { GameData } from '../data/loader'
import type { Balance, ContrabandDef } from '../data/schemas'
import { NeedIndex, clampNeed } from '../entities/needs'
import { isOperational } from '../entities/objects'
import type { InmateEntity } from '../entities/inmate'
import { NO_ROOM } from '../world/rooms'
import { NO_SECTOR } from '../world/sectors'
import { idx } from '../world/coords'

import { isInmateWorld } from './intakeSystem'
import type { InmateWorld } from './intakeSystem'
import type { MealQuantity, MealStandingOrders } from './logistics/mealChain'
import { isMealQuantity } from './logistics/mealChain'

function uniqueStashTiles(stashes: readonly { tileIndex: number }[]): number[] {
  const seen = new Set<number>()
  const tiles: number[] = []
  for (const stash of stashes) {
    if (seen.has(stash.tileIndex)) continue
    seen.add(stash.tileIndex)
    tiles.push(stash.tileIndex)
  }
  return tiles
}


/* -------------------------------------------------------------------------- */
/* Identity                                                                    */
/* -------------------------------------------------------------------------- */

export const SEARCH_SYSTEM_NAME = 'search'
/** PRD 4.4: Security runs every 6 in-game minutes. */
export const SEARCH_SYSTEM_PERIOD = 60

export const SEARCH_EVENTS = {
  performed: 'search.performed',
  found: 'search.found',
  intakeDelayed: 'search.intakeDelayed',
  metalDetect: 'search.metalDetect',
  dogDetect: 'search.dogDetect',
  standingOrderApplied: 'search.standingOrderApplied',
  rejected: 'search.rejected',
} as const

export const SEARCH_COMMANDS = {
  individual: 'search.individual',
  cell: 'search.cell',
  block: 'search.block',
  shakedown: 'search.shakedown',
  setPunishment: 'standingOrders.setPunishment',
  setSearchTrigger: 'standingOrders.setSearchTrigger',
  setStrictness: 'standingOrders.setStrictness',
  setMeals: 'standingOrders.setMeals',
} as const

export const SEARCH_KINDS = [
  'individual',
  'cell',
  'block',
  'shakedown',
  'intake',
] as const
export type SearchKind = (typeof SEARCH_KINDS)[number]

export const MISCONDUCT_KINDS = [
  'complaint',
  'contraband',
  'intoxication',
  'destruction',
  'attackInmate',
  'attackStaff',
  'seriousInjury',
  'homicide',
  'escapeAttempt',
] as const
export type MisconductKind = (typeof MISCONDUCT_KINDS)[number]

export const PUNISHMENT_KINDS = ['ignore', 'lockdown', 'isolation'] as const
export type PunishmentKind = (typeof PUNISHMENT_KINDS)[number]

export const REASSIGNMENT_STRICTNESS = ['off', 'lenient', 'strict'] as const
export type ReassignmentStrictness = (typeof REASSIGNMENT_STRICTNESS)[number]

export function isMisconductKind(value: string): value is MisconductKind {
  return (MISCONDUCT_KINDS as readonly string[]).includes(value)
}

export function isPunishmentKind(value: string): value is PunishmentKind {
  return (PUNISHMENT_KINDS as readonly string[]).includes(value)
}

export function isReassignmentStrictness(value: string): value is ReassignmentStrictness {
  return (REASSIGNMENT_STRICTNESS as readonly string[]).includes(value)
}

export function isSearchKind(value: string): value is SearchKind {
  return (SEARCH_KINDS as readonly string[]).includes(value)
}

/* -------------------------------------------------------------------------- */
/* Standing Orders                                                             */
/* -------------------------------------------------------------------------- */

export interface MisconductStandingOrder {
  punishment: PunishmentKind
  /**
   * Hours of lockdown / isolation. `0` means indefinite when punishment is not
   * `ignore` (T4.4 homicide default). Ignored for `ignore`.
   */
  durationHours: number
  /** Queue an automatic search of the inmate when this misconduct fires. */
  search: boolean
}

/** Matches T4.4 `StandingOrdersState` (shared InmateWorld field). */
export interface StandingOrdersPolicy {
  readonly misconduct: Record<MisconductKind, MisconductStandingOrder>
  reassignmentStrictness: ReassignmentStrictness
  mealQuantity: MealQuantity
  mealVariety: number
}

export function createStandingOrdersPolicy(data: GameData): StandingOrdersPolicy {
  const defaults = data.balance.contraband.standingOrders.defaults
  const misconduct = {} as Record<MisconductKind, MisconductStandingOrder>
  for (const kind of MISCONDUCT_KINDS) {
    const entry = defaults[kind]
    if (entry === undefined) {
      misconduct[kind] = { punishment: 'ignore', durationHours: 0, search: false }
    } else {
      misconduct[kind] = {
        punishment: entry.punishment,
        durationHours: entry.durationHours < 0 ? 0 : entry.durationHours,
        search: entry.search,
      }
    }
  }
  return {
    misconduct,
    reassignmentStrictness: data.balance.contraband.standingOrders.defaultReassignmentStrictness,
    mealQuantity: data.balance.kitchen.defaultMealQuantity,
    mealVariety: data.balance.kitchen.defaultMealVariety,
  }
}

/**
 * Reads the Standing Order for a misconduct type. Pure — does not mutate.
 * Punishment systems (T4.4) call this, then optionally queue a search when
 * `order.search` is true.
 */
export function applyStandingOrder(
  policy: StandingOrdersPolicy,
  kind: MisconductKind,
): MisconductStandingOrder {
  return { ...policy.misconduct[kind] }
}

export function hashStandingOrders(policy: StandingOrdersPolicy, hasher: Fnv1aHasher): void {
  for (const kind of MISCONDUCT_KINDS) {
    const order = policy.misconduct[kind]
    hasher.writeString(kind)
    hasher.writeString(order.punishment)
    hasher.writeUint32(Math.max(0, order.durationHours))
    hasher.writeUint32(order.search ? 1 : 0)
  }
  hasher.writeString(policy.reassignmentStrictness)
  hasher.writeString(policy.mealQuantity)
  hasher.writeUint32(policy.mealVariety)
}

/* -------------------------------------------------------------------------- */
/* Detection maths                                                             */
/* -------------------------------------------------------------------------- */

export type DetectionCurve = { readonly base: number; readonly moraleScale: number }

/**
 * PRD 5.10 / morale scaling: `base + moraleScale * (morale / 100)`, clamped
 * to `[0, 1]`. Used for manual searches, metal detectors and dogs.
 */
export function detectionChance(morale: number, curve: DetectionCurve): number {
  const m = Math.max(0, Math.min(100, morale))
  return clamp01(curve.base + curve.moraleScale * (m / 100))
}

/**
 * Intake / multi-officer compounding: chance that *at least one* of `n`
 * independent rolls succeeds.
 */
export function compoundDetectionChance(singleChance: number, officers: number): number {
  if (officers <= 0) return 0
  if (singleChance >= 1) return 1
  if (singleChance <= 0) return 0
  return clamp01(1 - (1 - singleChance) ** officers)
}

export function searchMoodCost(
  kind: SearchKind,
  balance: Balance['contraband']['search'],
): number {
  return balance.moodCost[kind]
}

function clamp01(value: number): number {
  if (value <= 0) return 0
  if (value >= 1) return 1
  return value
}

/* -------------------------------------------------------------------------- */
/* Search results                                                              */
/* -------------------------------------------------------------------------- */

export interface SearchResult {
  readonly kind: SearchKind
  readonly found: readonly string[]
  readonly moodCostApplied: number
  readonly inmatesTouched: number
  readonly stashesTouched: number
  readonly intakeDelayMinutes: number
}

export interface PerformSearchOptions {
  readonly world: InmateWorld
  readonly data: GameData
  readonly rng: RngStream
  readonly events: EventSink
  readonly tick: number
  readonly kind: SearchKind
  readonly inmateId?: number
  readonly roomId?: number
  readonly sectorId?: number
  /** Officers participating (intake / manual). Defaults from room proximity. */
  readonly officerCount?: number
  readonly causeIds?: readonly number[]
  readonly needIndex?: NeedIndex
}

/* -------------------------------------------------------------------------- */
/* Core search                                                                 */
/* -------------------------------------------------------------------------- */

export function performSearch(options: PerformSearchOptions): SearchResult {
  const { world, data, rng, events, tick, kind } = options
  const searchBal = data.balance.contraband.search
  const morale = world.morale.value
  const needIndex = options.needIndex ?? NeedIndex.fromData(data)
  const found: string[] = []
  let inmatesTouched = 0
  let stashesTouched = 0
  let intakeDelayMinutes = 0

  const moodCost = searchMoodCost(kind, searchBal)

  if (kind === 'individual') {
    const inmateId = options.inmateId ?? 0
    const entity = world.inmates.get(inmateId)
    if (entity === undefined) {
      reject(events, tick, 'unknown-inmate', { kind, inmateId })
      return emptyResult(kind)
    }
    const chance = detectionChance(morale, searchBal.manual)
    const taken = world.contraband.confiscateCarriedWithChance(
      entity.inmate,
      inmateId,
      chance,
      () => rng.chance(chance),
    )
    found.push(...taken)
    applyMoodCost(entity, moodCost, needIndex)
    inmatesTouched = 1
    // Also search the inmate's own cell stashes if housed.
    if (entity.inmate.cellId !== NO_ROOM) {
      const cellTaken = searchRoomStashes(world, entity.inmate.cellId, chance, rng, found)
      stashesTouched += cellTaken
    }
  } else if (kind === 'cell') {
    const roomId = options.roomId ?? 0
    const room = world.rooms.get(roomId)
    if (room === undefined) {
      reject(events, tick, 'unknown-room', { kind, roomId })
      return emptyResult(kind)
    }
    const chance = detectionChance(morale, searchBal.manual)
    for (const entity of world.inmates.all()) {
      if (entity.inmate.cellId !== roomId) continue
      const taken = world.contraband.confiscateCarriedWithChance(
        entity.inmate,
        entity.id,
        chance,
        () => rng.chance(chance),
      )
      found.push(...taken)
      applyMoodCost(entity, moodCost, needIndex)
      inmatesTouched += 1
    }
    stashesTouched += searchRoomStashes(world, roomId, chance, rng, found)
  } else if (kind === 'block') {
    const sectorId = options.sectorId ?? NO_SECTOR
    if (sectorId === NO_SECTOR || world.sectors.get(sectorId) === undefined) {
      reject(events, tick, 'unknown-sector', { kind, sectorId })
      return emptyResult(kind)
    }
    const chance = detectionChance(morale, searchBal.manual)
    const size = world.grid.size
    for (const entity of world.inmates.all()) {
      const tile = idx(entity.tx, entity.ty, size)
      if ((world.grid.sectorId[tile] ?? NO_SECTOR) !== sectorId) continue
      const taken = world.contraband.confiscateCarriedWithChance(
        entity.inmate,
        entity.id,
        chance,
        () => rng.chance(chance),
      )
      found.push(...taken)
      applyMoodCost(entity, moodCost, needIndex)
      inmatesTouched += 1
    }
    for (const tileIndex of uniqueStashTiles(world.contraband.stashes)) {
      if ((world.grid.sectorId[tileIndex] ?? NO_SECTOR) !== sectorId) continue
      const taken = world.contraband.searchStash(tileIndex, chance, () => rng.chance(chance))
      if (taken.length > 0) {
        found.push(...taken)
        stashesTouched += 1
      }
    }
  } else if (kind === 'shakedown') {
    const chance = detectionChance(morale, searchBal.shakedown)
    for (const entity of world.inmates.all()) {
      const taken = world.contraband.confiscateCarriedWithChance(
        entity.inmate,
        entity.id,
        chance,
        () => rng.chance(chance),
      )
      found.push(...taken)
      applyMoodCost(entity, moodCost, needIndex)
      inmatesTouched += 1
    }
    for (const tileIndex of uniqueStashTiles(world.contraband.stashes)) {
      const taken = world.contraband.searchStash(tileIndex, chance, () => rng.chance(chance))
      if (taken.length > 0) {
        found.push(...taken)
        stashesTouched += 1
      }
    }
    world.dangerLevel = Math.min(100, world.dangerLevel + searchBal.shakedownDangerSpike)
  } else {
    // intake
    const inmateId = options.inmateId ?? 0
    const entity = world.inmates.get(inmateId)
    if (entity === undefined) {
      reject(events, tick, 'unknown-inmate', { kind, inmateId })
      return emptyResult(kind)
    }
    const officers =
      options.officerCount ??
      countOfficersInRoom(world, data, roomIdOfInmate(world, entity))
    const single = detectionChance(morale, searchBal.intake)
    const chance = compoundDetectionChance(single, officers)
    const taken = world.contraband.confiscateCarriedWithChance(
      entity.inmate,
      inmateId,
      chance,
      () => rng.chance(chance),
    )
    found.push(...taken)
    // Intake mood cost is 0 by default; still account when non-zero.
    if (moodCost > 0) applyMoodCost(entity, moodCost, needIndex)
    inmatesTouched = 1
    intakeDelayMinutes = searchBal.intakeDelayMinutesPerInmate
    if (intakeDelayMinutes > 0) {
      events.emit({
        tick,
        kind: SEARCH_EVENTS.intakeDelayed,
        subjectId: inmateId,
        causeIds: options.causeIds === undefined ? [] : [...options.causeIds],
        data: {
          inmateId,
          officers,
          delayMinutes: intakeDelayMinutes,
          chance,
        },
      })
    }
  }

  const causeIds = options.causeIds === undefined ? [] : [...options.causeIds]
  events.emit({
    tick,
    kind: SEARCH_EVENTS.performed,
    subjectId: options.inmateId ?? options.roomId ?? options.sectorId ?? 0,
    causeIds,
    data: {
      kind,
      found: found.length,
      moodCost,
      inmatesTouched,
      stashesTouched,
      intakeDelayMinutes,
      morale,
    },
  })
  if (found.length > 0) {
    events.emit({
      tick,
      kind: SEARCH_EVENTS.found,
      subjectId: options.inmateId ?? 0,
      causeIds,
      data: { kind, items: found, count: found.length },
    })
  }

  return {
    kind,
    found,
    moodCostApplied: moodCost * Math.max(1, inmatesTouched),
    inmatesTouched,
    stashesTouched,
    intakeDelayMinutes,
  }
}

function emptyResult(kind: SearchKind): SearchResult {
  return {
    kind,
    found: [],
    moodCostApplied: 0,
    inmatesTouched: 0,
    stashesTouched: 0,
    intakeDelayMinutes: 0,
  }
}

function applyMoodCost(entity: InmateEntity, cost: number, needIndex: NeedIndex): void {
  if (cost <= 0) return
  // Freedom is the need that spikes under searches / lockups (PRD 5.4).
  if (needIndex.indexOf('freedom') < 0) return
  const current = needIndex.get(entity.inmate.needs, 'freedom')
  needIndex.set(entity.inmate.needs, 'freedom', clampNeed(current + cost))
}

function searchRoomStashes(
  world: InmateWorld,
  roomId: number,
  chance: number,
  rng: RngStream,
  found: string[],
): number {
  if (world.rooms.get(roomId) === undefined) return 0
  let touched = 0
  for (const tileIndex of uniqueStashTiles(world.contraband.stashes)) {
    if ((world.grid.roomId[tileIndex] ?? NO_ROOM) !== roomId) continue
    const taken = world.contraband.searchStash(tileIndex, chance, () => rng.chance(chance))
    if (taken.length > 0) {
      found.push(...taken)
      touched += 1
    }
  }
  return touched
}

function roomIdOfInmate(world: InmateWorld, entity: InmateEntity): number {
  const tile = idx(entity.tx, entity.ty, world.grid.size)
  return world.grid.roomId[tile] ?? NO_ROOM
}

export function countOfficersInRoom(
  world: InmateWorld,
  data: GameData,
  roomId: number,
): number {
  if (roomId === NO_ROOM) return 0
  let count = 0
  for (const staff of world.staff.all()) {
    const def = data.staff.find(staff.staff.defId)
    if (def === undefined) continue
    if (def.id !== 'officer' && def.id !== 'armed_officer') continue
    const tile = idx(staff.tx, staff.ty, world.grid.size)
    if ((world.grid.roomId[tile] ?? NO_ROOM) === roomId) count += 1
  }
  return count
}

/* -------------------------------------------------------------------------- */
/* Passive detectors                                                           */
/* -------------------------------------------------------------------------- */

export interface PassiveDetectOptions {
  readonly world: InmateWorld
  readonly data: GameData
  readonly rng: RngStream
  readonly events: EventSink
  readonly tick: number
  readonly inmateId: number
}

/**
 * Metal detector pass-through: each metal item on the inmate rolls
 * `base + moraleScale * morale/100` (PRD 5.10).
 */
export function rollMetalDetectorPass(options: PassiveDetectOptions): string[] {
  const { world, data, rng, events, tick, inmateId } = options
  const entity = world.inmates.get(inmateId)
  if (entity === undefined) return []
  if (!inmateNearObject(world, entity, 'metal_detector')) return []

  const chance = detectionChance(world.morale.value, data.balance.contraband.metalDetector)
  const bag = [...world.contraband.carriedOf(entity.inmate)]
  const taken: string[] = []
  for (const defId of bag) {
    const def = data.contraband.find(defId)
    if (def === undefined || !def.isMetal) continue
    if (!rng.chance(chance)) continue
    taken.push(defId)
  }
  if (taken.length === 0) return []

  removeSpecificCarried(world.contraband, entity.inmate, inmateId, taken)
  events.emit({
    tick,
    kind: SEARCH_EVENTS.metalDetect,
    subjectId: inmateId,
    causeIds: [],
    data: { inmateId, items: taken, chance, morale: world.morale.value },
  })
  return taken
}

/**
 * Dog pass-through: odorous items within `dogRadiusTiles` of a k9 / dog.
 */
export function rollDogDetection(options: PassiveDetectOptions): string[] {
  const { world, data, rng, events, tick, inmateId } = options
  const entity = world.inmates.get(inmateId)
  if (entity === undefined) return []
  const radius = data.balance.contraband.dogRadiusTiles
  if (!inmateNearDog(world, data, entity, radius)) return []

  const chance = detectionChance(world.morale.value, data.balance.contraband.dog)
  const bag = [...world.contraband.carriedOf(entity.inmate)]
  const taken: string[] = []
  for (const defId of bag) {
    const def = data.contraband.find(defId) as ContrabandDef | undefined
    if (def === undefined || !def.isOdorous) continue
    if (!rng.chance(chance)) continue
    taken.push(defId)
  }
  if (taken.length === 0) return []

  removeSpecificCarried(world.contraband, entity.inmate, inmateId, taken)
  events.emit({
    tick,
    kind: SEARCH_EVENTS.dogDetect,
    subjectId: inmateId,
    causeIds: [],
    data: { inmateId, items: taken, chance, morale: world.morale.value },
  })
  return taken
}

function removeSpecificCarried(
  ledger: { confiscatedCount: number },
  inmate: InmateEntity['inmate'],
  _inmateId: number,
  remove: readonly string[],
): void {
  const inv = inmate.inventory as string[]
  const next: string[] = []
  const toRemove = new Map<string, number>()
  for (const id of remove) toRemove.set(id, (toRemove.get(id) ?? 0) + 1)
  for (const defId of inv) {
    const left = toRemove.get(defId) ?? 0
    if (left > 0) {
      toRemove.set(defId, left - 1)
      ledger.confiscatedCount += 1
      continue
    }
    next.push(defId)
  }
  inv.splice(0, inv.length, ...next)
}

function inmateNearObject(
  world: InmateWorld,
  entity: InmateEntity,
  defId: string,
): boolean {
  for (const object of world.objects.all()) {
    if (object.object.defId !== defId) continue
    if (!isOperational(object)) continue
    if (Math.abs(object.tx - entity.tx) <= 1 && Math.abs(object.ty - entity.ty) <= 1) {
      return true
    }
  }
  return false
}

function inmateNearDog(
  world: InmateWorld,
  data: GameData,
  entity: InmateEntity,
  radius: number,
): boolean {
  for (const staff of world.staff.all()) {
    const def = data.staff.find(staff.staff.defId)
    if (def === undefined) continue
    if (def.id !== 'dog' && def.id !== 'k9_officer') continue
    const dx = staff.tx - entity.tx
    const dy = staff.ty - entity.ty
    if (dx * dx + dy * dy <= radius * radius) return true
  }
  return false
}

/* -------------------------------------------------------------------------- */
/* Standing-order search trigger                                               */
/* -------------------------------------------------------------------------- */

/**
 * Applies the Standing Order for a misconduct type and, when configured,
 * queues an individual search. Emits `search.standingOrderApplied`.
 */
export function applyStandingOrderForMisconduct(options: {
  readonly world: InmateWorld
  readonly data: GameData
  readonly kind: MisconductKind
  readonly inmateId: number
  readonly events: EventSink
  readonly tick: number
  readonly rng: RngStream
  readonly causeIds?: readonly number[]
  readonly needIndex?: NeedIndex
}): {
  readonly order: MisconductStandingOrder
  readonly search: SearchResult | null
} {
  const order = applyStandingOrder(options.world.standingOrders, options.kind)
  const causeIds = options.causeIds === undefined ? [] : [...options.causeIds]
  options.events.emit({
    tick: options.tick,
    kind: SEARCH_EVENTS.standingOrderApplied,
    subjectId: options.inmateId,
    causeIds,
    data: {
      misconduct: options.kind,
      punishment: order.punishment,
      durationHours: order.durationHours,
      search: order.search,
      inmateId: options.inmateId,
    },
  })

  let search: SearchResult | null = null
  if (order.search) {
    search = performSearch({
      world: options.world,
      data: options.data,
      rng: options.rng,
      events: options.events,
      tick: options.tick,
      kind: 'individual',
      inmateId: options.inmateId,
      causeIds,
      ...(options.needIndex === undefined ? {} : { needIndex: options.needIndex }),
    })
  }
  return { order, search }
}

/* -------------------------------------------------------------------------- */
/* System                                                                      */
/* -------------------------------------------------------------------------- */

export interface SearchSystemOptions {
  readonly data: GameData
  readonly needIndex?: NeedIndex
}

export function createSearchSystem(options: SearchSystemOptions): System {
  const { data } = options
  const needIndex = options.needIndex ?? NeedIndex.fromData(data)

  return {
    name: SEARCH_SYSTEM_NAME,
    period: SEARCH_SYSTEM_PERIOD,
    update(context: SystemContext): void {
      if (!isInmateWorld(context.world)) return
      const world = context.world
      const rng = context.rng.stream('search')

      // Automatic intake searches for inmates still in the intake hall.
      for (const entity of world.inmates.all()) {
        const roomId = roomIdOfInmate(world, entity)
        const room = world.rooms.get(roomId)
        if (room === undefined || room.defId !== 'intake_hall') continue
        if (world.contraband.carriedOf(entity.inmate).length === 0) continue
        const officers = countOfficersInRoom(world, data, roomId)
        if (officers <= 0) continue
        if (world.intakeSearchedInmateIds.has(entity.id)) continue
        performSearch({
          world,
          data,
          rng,
          events: context.events,
          tick: context.clock.tick,
          kind: 'intake',
          inmateId: entity.id,
          officerCount: officers,
          needIndex,
        })
        world.intakeSearchedInmateIds.add(entity.id)
      }

      // Passive detectors for anyone carrying metal / odorous goods.
      for (const entity of world.inmates.all()) {
        if (world.contraband.carriedOf(entity.inmate).length === 0) continue
        rollMetalDetectorPass({
          world,
          data,
          rng,
          events: context.events,
          tick: context.clock.tick,
          inmateId: entity.id,
        })
        rollDogDetection({
          world,
          data,
          rng,
          events: context.events,
          tick: context.clock.tick,
          inmateId: entity.id,
        })
      }
    },
  }
}

/* -------------------------------------------------------------------------- */
/* Commands                                                                    */
/* -------------------------------------------------------------------------- */

export function searchCommandHandlers(data: GameData): Record<string, CommandHandler> {
  const needIndex = NeedIndex.fromData(data)

  return {
    [SEARCH_COMMANDS.individual]: (command, context) => {
      if (!isInmateWorld(context.world)) return
      const inmateId = readUint(command.payload, 'inmateId')
      if (inmateId === undefined) {
        reject(context.events, context.clock.tick, 'bad-payload', { command: command.type })
        return
      }
      performSearch({
        world: context.world,
        data,
        rng: context.rng.stream('search'),
        events: context.events,
        tick: context.clock.tick,
        kind: 'individual',
        inmateId,
        needIndex,
      })
    },
    [SEARCH_COMMANDS.cell]: (command, context) => {
      if (!isInmateWorld(context.world)) return
      const roomId = readUint(command.payload, 'roomId')
      if (roomId === undefined) {
        reject(context.events, context.clock.tick, 'bad-payload', { command: command.type })
        return
      }
      performSearch({
        world: context.world,
        data,
        rng: context.rng.stream('search'),
        events: context.events,
        tick: context.clock.tick,
        kind: 'cell',
        roomId,
        needIndex,
      })
    },
    [SEARCH_COMMANDS.block]: (command, context) => {
      if (!isInmateWorld(context.world)) return
      const sectorId = readUint(command.payload, 'sectorId')
      if (sectorId === undefined) {
        reject(context.events, context.clock.tick, 'bad-payload', { command: command.type })
        return
      }
      performSearch({
        world: context.world,
        data,
        rng: context.rng.stream('search'),
        events: context.events,
        tick: context.clock.tick,
        kind: 'block',
        sectorId,
        needIndex,
      })
    },
    [SEARCH_COMMANDS.shakedown]: (_command, context) => {
      if (!isInmateWorld(context.world)) return
      performSearch({
        world: context.world,
        data,
        rng: context.rng.stream('search'),
        events: context.events,
        tick: context.clock.tick,
        kind: 'shakedown',
        needIndex,
      })
    },
    [SEARCH_COMMANDS.setPunishment]: (command, context) => {
      if (!isInmateWorld(context.world)) return
      const payload = asObject(command.payload)
      if (payload === undefined) {
        reject(context.events, context.clock.tick, 'bad-payload', { command: command.type })
        return
      }
      const misconduct = payload['misconduct']
      const punishment = payload['punishment']
      const durationHours = payload['durationHours']
      if (
        typeof misconduct !== 'string' ||
        !isMisconductKind(misconduct) ||
        typeof punishment !== 'string' ||
        !isPunishmentKind(punishment) ||
        typeof durationHours !== 'number' ||
        !Number.isInteger(durationHours)
      ) {
        reject(context.events, context.clock.tick, 'bad-payload', { command: command.type })
        return
      }
      const order = context.world.standingOrders.misconduct[misconduct]
      order.punishment = punishment
      order.durationHours = durationHours
    },
    [SEARCH_COMMANDS.setSearchTrigger]: (command, context) => {
      if (!isInmateWorld(context.world)) return
      const payload = asObject(command.payload)
      if (payload === undefined) {
        reject(context.events, context.clock.tick, 'bad-payload', { command: command.type })
        return
      }
      const misconduct = payload['misconduct']
      const search = payload['search']
      if (
        typeof misconduct !== 'string' ||
        !isMisconductKind(misconduct) ||
        typeof search !== 'boolean'
      ) {
        reject(context.events, context.clock.tick, 'bad-payload', { command: command.type })
        return
      }
      context.world.standingOrders.misconduct[misconduct].search = search
    },
    [SEARCH_COMMANDS.setStrictness]: (command, context) => {
      if (!isInmateWorld(context.world)) return
      const payload = asObject(command.payload)
      const value = payload?.['strictness']
      if (typeof value !== 'string' || !isReassignmentStrictness(value)) {
        reject(context.events, context.clock.tick, 'bad-payload', { command: command.type })
        return
      }
      context.world.standingOrders.reassignmentStrictness = value
    },
    [SEARCH_COMMANDS.setMeals]: (command, context) => {
      if (!isInmateWorld(context.world)) return
      const payload = asObject(command.payload)
      if (payload === undefined) {
        reject(context.events, context.clock.tick, 'bad-payload', { command: command.type })
        return
      }
      const quantity = payload['quantity']
      const variety = payload['variety']
      const maxVariety = data.balance.kitchen.maxMealVariety
      if (
        typeof quantity !== 'string' ||
        !isMealQuantity(quantity) ||
        typeof variety !== 'number' ||
        !Number.isInteger(variety) ||
        variety < 1 ||
        variety > maxVariety
      ) {
        reject(context.events, context.clock.tick, 'bad-payload', { command: command.type })
        return
      }
      context.world.standingOrders.mealQuantity = quantity as MealQuantity
      context.world.standingOrders.mealVariety = variety
      context.world.meals.standingOrders.quantity = quantity as MealQuantity
      context.world.meals.standingOrders.variety = variety
    },
  }
}

function reject(
  events: EventSink,
  tick: number,
  reason: string,
  data: Record<string, JsonValue>,
): void {
  events.emit({
    tick,
    kind: SEARCH_EVENTS.rejected,
    subjectId: 0,
    causeIds: [],
    data: { reason, ...data },
  })
}

function asObject(value: JsonValue | undefined): Record<string, JsonValue> | undefined {
  if (value === null || value === undefined || typeof value !== 'object' || isJsonArray(value)) {
    return undefined
  }
  return value as Record<string, JsonValue>
}

function readUint(
  payload: JsonValue | undefined,
  key: string,
): number | undefined {
  const obj = asObject(payload)
  const value = obj?.[key]
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) return undefined
  return value
}

/** Exported for intake delay accounting in tests. */
export function intakeDelayTicks(data: GameData): number {
  return data.balance.contraband.search.intakeDelayMinutesPerInmate * TICKS_PER_MINUTE
}
