/**
 * `ContrabandSystem`: the illicit economy (T4.2, PRD 5.10).
 *
 * Five acquisition vectors plus crafting feed a tile-stash inventory and an
 * hourly regional market. Detection / search land in T4.3 — this ticket only
 * creates, hides, trades and intercepts.
 *
 * Cadence (PRD 4.4): every 60 ticks (6 in-game minutes) for theft, visit
 * smuggling, crafting and throw-in collection; trading recomputes hourly.
 */

import { TICKS_PER_HOUR, TICKS_PER_MINUTE } from '../core/clock'
import type { Rng, RngStream } from '../core/rng'
import type { EventSink, System, SystemContext } from '../core/simulation'
import type { GameData } from '../data/loader'
import type { ContrabandDef } from '../data/schemas'
import type { InmateComponent, InmateEntity } from '../entities/inmate'
import { ContrabandState, createContrabandState } from '../entities/contraband'
import type { ArrangedThrowIn, ContrabandStash } from '../entities/contraband'
import { NO_ROOM } from '../world/rooms'
import type { Room } from '../world/rooms'
import { PASSABILITY } from '../world/tileGrid'

import { isInmateWorld, mutatorEnabled } from './intakeSystem'
import type { InmateWorld } from './intakeSystem'

export type { ArrangedThrowIn, ContrabandStash }
export { ContrabandState, createContrabandState }

/* -------------------------------------------------------------------------- */
/* Constants                                                                   */
/* -------------------------------------------------------------------------- */

export const CONTRABAND_SYSTEM_NAME = 'contraband'

/** PRD 4.4: Contraband runs once every 6 in-game minutes. */
export const CONTRABAND_SYSTEM_PERIOD = 60

export const CONTRABAND_EVENTS = {
  arrivedWith: 'contraband.arrivedWith',
  visitSmuggled: 'contraband.visitSmuggled',
  deliveryContaminated: 'contraband.deliveryContaminated',
  stolen: 'contraband.stolen',
  crafted: 'contraband.crafted',
  throwInArranged: 'contraband.throwInArranged',
  throwInCollected: 'contraband.throwInCollected',
  throwInIntercepted: 'contraband.throwInIntercepted',
  traded: 'contraband.traded',
  pricesUpdated: 'contraband.pricesUpdated',
  rejected: 'contraband.rejected',
} as const

const VISIT_TABLE = 'visit_table'
const VISIT_BOOTH = 'visit_booth'
const PHONE_BOOTH = 'phone_booth'
const VISIT_HALL = 'visit_hall'

const INTERCEPTOR_DEFS = new Set(['officer', 'armed_officer', 'k9_officer', 'dog'])

/* -------------------------------------------------------------------------- */
/* World state                                                                 */
/* -------------------------------------------------------------------------- */

// Re-exported from entities/contraband for callers that import the system.

/* -------------------------------------------------------------------------- */
/* Inventory helpers                                                           */
/* -------------------------------------------------------------------------- */

export function addToInventory(inmate: InmateComponent, itemId: string): void {
  inmate.inventory.push(itemId)
}

export function removeFromInventory(inmate: InmateComponent, itemId: string): boolean {
  const index = inmate.inventory.indexOf(itemId)
  if (index < 0) return false
  inmate.inventory.splice(index, 1)
  return true
}

export function countInventoryItem(inmate: InmateComponent, itemId: string): number {
  let count = 0
  for (const id of inmate.inventory) {
    if (id === itemId) count += 1
  }
  return count
}

/* -------------------------------------------------------------------------- */
/* Pure pricing                                                                */
/* -------------------------------------------------------------------------- */

/**
 * `price = basePrice * (1 + demand / supply)` clamped to balance bounds.
 * Supply of 0 with positive demand saturates at the clamp max.
 */
export function computeContrabandPrice(
  basePrice: number,
  demand: number,
  supply: number,
  clamp: { readonly min: number; readonly max: number },
): number {
  if (basePrice <= 0) return 0
  const ratio = supply <= 0 ? (demand > 0 ? clamp.max : 1) : 1 + demand / supply
  const clamped = Math.min(clamp.max, Math.max(clamp.min, ratio))
  return Math.max(0, Math.round(basePrice * clamped))
}

export function theftProbability(
  base: number,
  guardsInRoom: number,
  saturateAt: number,
  guardSuppression: number,
  traitModifier: number,
): number {
  const factor = saturateAt <= 0 ? 0 : Math.min(1, guardsInRoom / saturateAt)
  const p = base * (1 - guardSuppression * factor) * traitModifier
  return Math.min(1, Math.max(0, p))
}

export function traitTheftModifier(
  traits: readonly string[],
  modifiers: Readonly<Record<string, number>>,
  fallback: number,
): number {
  let best = fallback
  for (const trait of traits) {
    const value = modifiers[trait]
    if (value !== undefined && value > best) best = value
  }
  return best
}

/* -------------------------------------------------------------------------- */
/* Acquisition: arrival                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Rolls arrival possession for a freshly generated inmate. Probability scales
 * with security category; only smuggleable items are eligible.
 */
export function applyArrivalPossession(options: {
  readonly world: InmateWorld
  readonly entity: InmateEntity
  readonly rng: RngStream
  readonly events: EventSink
  readonly tick: number
}): string | undefined {
  const { world, entity, rng, events, tick } = options
  const balance = world.data.balance.contraband
  const chance = balance.arrivalPossessionChanceByCategory[entity.inmate.category] ?? 0
  if (chance <= 0 || rng.next() >= chance) return undefined

  const pool = smuggleableItems(world.data)
  if (pool.length === 0) return undefined
  const pick = pool[rng.nextInt(0, pool.length)]
  if (pick === undefined) return undefined

  grantItem({
    world,
    entity,
    itemId: pick.id,
    rng,
    preferStash: false,
    events,
    tick,
    kind: CONTRABAND_EVENTS.arrivedWith,
  })
  return pick.id
}

/** Drains `world.contraband.pendingArrivalIds` and rolls possession for each. */
export function flushPendingArrivals(
  world: InmateWorld,
  rng: RngStream,
  events: EventSink,
  tick: number,
): void {
  for (const inmateId of world.contraband.takePendingArrivals()) {
    const entity = world.inmates.get(inmateId)
    if (entity === undefined) continue
    applyArrivalPossession({ world, entity, rng, events, tick })
  }
}

/* -------------------------------------------------------------------------- */
/* Acquisition: delivery contamination                                         */
/* -------------------------------------------------------------------------- */

/**
 * Called when a delivery truck lands. Each contaminable stock line may spawn
 * a contraband stash at the dock (or a fallback perimeter tile).
 */
export function contaminateDelivery(options: {
  readonly world: InmateWorld
  readonly itemId: string
  readonly units: number
  readonly rng: RngStream
  readonly events: EventSink
  readonly tick: number
  readonly truckId: number
}): readonly string[] {
  const { world, itemId, units, rng, events, tick, truckId } = options
  const balance = world.data.balance.contraband
  const pool = balance.deliveryContamination[itemId]
  if (pool === undefined || pool.length === 0 || units <= 0) return []

  const spawned: string[] = []
  for (let i = 0; i < units; i += 1) {
    if (rng.next() >= balance.deliveryContaminationChance) continue
    const contrabandId = pool[rng.nextInt(0, pool.length)]
    if (contrabandId === undefined) continue
    const tile = findDockTile(world) ?? findPerimeterTile(world, rng)
    if (tile === undefined) continue
    world.contraband.addStash(tile, contrabandId, 0)
    spawned.push(contrabandId)
    events.emit({
      tick,
      kind: CONTRABAND_EVENTS.deliveryContaminated,
      subjectId: truckId,
      causeIds: [],
      data: { truckId, deliveryItemId: itemId, contrabandId, tileIndex: tile },
    })
  }
  refreshCirculationCount(world)
  return spawned
}

/* -------------------------------------------------------------------------- */
/* Hide / carry                                                                */
/* -------------------------------------------------------------------------- */

export function grantItem(options: {
  readonly world: InmateWorld
  readonly entity: InmateEntity
  readonly itemId: string
  readonly rng: RngStream
  readonly preferStash: boolean
  readonly events: EventSink
  readonly tick: number
  readonly kind: string
  readonly extraData?: Record<string, unknown>
}): void {
  const { world, entity, itemId, rng, events, tick, kind } = options
  const stashChance = world.data.balance.contraband.stashInCellChance
  const cell = world.rooms.get(entity.inmate.cellId)
  const canStash =
    options.preferStash &&
    cell !== undefined &&
    cell.tiles.length > 0 &&
    rng.next() < stashChance

  if (canStash && cell !== undefined) {
    const tile = cell.tiles[rng.nextInt(0, cell.tiles.length)]
    if (tile !== undefined) {
      world.contraband.addStash(tile, itemId, entity.id)
      events.emit({
        tick,
        kind,
        subjectId: entity.id,
        causeIds: [],
        data: {
          inmateId: entity.id,
          itemId,
          hidden: true,
          tileIndex: tile,
          ...(options.extraData ?? {}),
        },
      })
      refreshCirculationCount(world)
      return
    }
  }

  addToInventory(entity.inmate, itemId)
  events.emit({
    tick,
    kind,
    subjectId: entity.id,
    causeIds: [],
    data: {
      inmateId: entity.id,
      itemId,
      hidden: false,
      ...(options.extraData ?? {}),
    },
  })
  refreshCirculationCount(world)
}

/* -------------------------------------------------------------------------- */
/* Room theft                                                                  */
/* -------------------------------------------------------------------------- */

export function itemsSourcedFromRoom(
  data: GameData,
  roomDefId: string,
): readonly ContrabandDef[] {
  return data.contraband.all.filter((item) => item.sourceRooms.includes(roomDefId))
}

export function itemsCraftableInRoom(
  data: GameData,
  roomDefId: string,
): readonly ContrabandDef[] {
  return data.contraband.all.filter((item) => item.craftableIn.includes(roomDefId))
}

export function countGuardsInRoom(world: InmateWorld, room: Room): number {
  let count = 0
  for (const staff of world.staff.all()) {
    const tile = world.grid.idx(staff.tx, staff.ty)
    if (!room.tiles.includes(tile)) continue
    if (INTERCEPTOR_DEFS.has(staff.staff.defId)) count += 1
  }
  return count
}

export function attemptRoomTheft(options: {
  readonly world: InmateWorld
  readonly entity: InmateEntity
  readonly room: Room
  readonly rng: RngStream
  readonly events: EventSink
  readonly tick: number
}): string | undefined {
  const { world, entity, room, rng, events, tick } = options
  const balance = world.data.balance.contraband
  const pool = itemsSourcedFromRoom(world.data, room.defId)
  if (pool.length === 0) return undefined

  const guards = countGuardsInRoom(world, room)
  const modifier = traitTheftModifier(
    entity.inmate.traits,
    balance.traitTheftModifiers,
    balance.defaultTraitTheftModifier,
  )
  const p = theftProbability(
    balance.theftBaseChance,
    guards,
    balance.guardsInRoomSaturateAt,
    balance.guardSuppressionFactor,
    modifier,
  )
  if (rng.next() >= p) return undefined

  const pick = pool[rng.nextInt(0, pool.length)]
  if (pick === undefined) return undefined

  grantItem({
    world,
    entity,
    itemId: pick.id,
    rng,
    preferStash: true,
    events,
    tick,
    kind: CONTRABAND_EVENTS.stolen,
    extraData: { roomId: room.id, roomDefId: room.defId, guards },
  })
  return pick.id
}

/* -------------------------------------------------------------------------- */
/* Visit smuggling                                                             */
/* -------------------------------------------------------------------------- */

export function visitSmuggleChance(
  world: InmateWorld,
  room: Room,
): number {
  const balance = world.data.balance.contraband
  const tables = world.objects.objectCount(room.id, VISIT_TABLE)
  const booths = world.objects.objectCount(room.id, VISIT_BOOTH)
  // Booths replace tables: any booth-only (or booth-majority) hall is blocked.
  if (booths > 0 && booths >= tables) return balance.visitSmuggleChanceBooths
  return balance.visitSmuggleChanceTables
}

export function attemptVisitSmuggle(options: {
  readonly world: InmateWorld
  readonly entity: InmateEntity
  readonly room: Room
  readonly rng: RngStream
  readonly events: EventSink
  readonly tick: number
}): string | undefined {
  const { world, entity, room, rng, events, tick } = options
  if (room.defId !== VISIT_HALL) return undefined
  const chance = visitSmuggleChance(world, room)
  if (chance <= 0 || rng.next() >= chance) return undefined

  const pool = smuggleableItems(world.data)
  if (pool.length === 0) return undefined
  const pick = pool[rng.nextInt(0, pool.length)]
  if (pick === undefined) return undefined

  grantItem({
    world,
    entity,
    itemId: pick.id,
    rng,
    preferStash: true,
    events,
    tick,
    kind: CONTRABAND_EVENTS.visitSmuggled,
    extraData: { roomId: room.id },
  })
  return pick.id
}

/* -------------------------------------------------------------------------- */
/* Crafting                                                                    */
/* -------------------------------------------------------------------------- */

export function attemptCraft(options: {
  readonly world: InmateWorld
  readonly entity: InmateEntity
  readonly room: Room
  readonly rng: RngStream
  readonly events: EventSink
  readonly tick: number
}): string | undefined {
  const { world, entity, room, rng, events, tick } = options
  const balance = world.data.balance.contraband
  const pool = itemsCraftableInRoom(world.data, room.defId)
  if (pool.length === 0) return undefined
  if (rng.next() >= balance.craftBaseChance) return undefined

  const pick = pool[rng.nextInt(0, pool.length)]
  if (pick === undefined) return undefined

  grantItem({
    world,
    entity,
    itemId: pick.id,
    rng,
    preferStash: true,
    events,
    tick,
    kind: CONTRABAND_EVENTS.crafted,
    extraData: { roomId: room.id, roomDefId: room.defId },
  })
  return pick.id
}

/* -------------------------------------------------------------------------- */
/* Throw-ins                                                                   */
/* -------------------------------------------------------------------------- */

export function canArrangeThrowIn(world: InmateWorld, entity: InmateEntity): boolean {
  if (entity.inmate.inventory.includes('mobile_phone')) return true
  const roomId = world.grid.roomId[world.grid.idx(entity.tx, entity.ty)] ?? NO_ROOM
  if (roomId === NO_ROOM) return false
  const room = world.rooms.get(roomId)
  if (room === undefined) return false
  if (room.defId === VISIT_HALL) return true
  return world.objects.objectCount(roomId, PHONE_BOOTH) > 0
}

export function arrangeThrowIn(options: {
  readonly world: InmateWorld
  readonly entity: InmateEntity
  readonly rng: RngStream
  readonly events: EventSink
  readonly tick: number
  /** Force a specific item (tests). */
  readonly itemId?: string
  /** Force a specific drop tile (tests). */
  readonly tileIndex?: number
}): ArrangedThrowIn | undefined {
  const { world, entity, rng, events, tick } = options
  const balance = world.data.balance.contraband

  const pool = smuggleableItems(world.data)
  const item =
    options.itemId !== undefined
      ? world.data.contraband.find(options.itemId)
      : pool[rng.nextInt(0, pool.length)]
  if (item === undefined) return undefined

  const tile =
    options.tileIndex !== undefined ? options.tileIndex : findPerimeterTile(world, rng)
  if (tile === undefined) return undefined

  const delayMin = balance.throwInDelayMinutes.min
  const delayMax = balance.throwInDelayMinutes.max
  const delayMinutes = rng.nextInt(delayMin, delayMax + 1)
  const collectTick = tick + delayMinutes * TICKS_PER_MINUTE

  const entry = world.contraband.addThrowIn({
    inmateId: entity.id,
    itemId: item.id,
    tileIndex: tile,
    collectTick,
  })

  events.emit({
    tick,
    kind: CONTRABAND_EVENTS.throwInArranged,
    subjectId: entity.id,
    causeIds: [],
    data: {
      inmateId: entity.id,
      itemId: item.id,
      tileIndex: tile,
      collectTick,
      throwInId: entry.id,
    },
  })
  return entry
}

export function staffAtTile(world: InmateWorld, tileIndex: number): boolean {
  const { x, y } = world.grid.xy(tileIndex)
  for (const staff of world.staff.all()) {
    if (staff.tx !== x || staff.ty !== y) continue
    if (INTERCEPTOR_DEFS.has(staff.staff.defId)) return true
  }
  return false
}

export function resolveThrowIn(options: {
  readonly world: InmateWorld
  readonly entry: ArrangedThrowIn
  readonly events: EventSink
  readonly tick: number
}): 'collected' | 'intercepted' | 'pending' {
  const { world, entry, events, tick } = options
  if (entry.resolved) return 'pending'
  if (tick < entry.collectTick) return 'pending'

  entry.resolved = true
  if (staffAtTile(world, entry.tileIndex)) {
    events.emit({
      tick,
      kind: CONTRABAND_EVENTS.throwInIntercepted,
      subjectId: entry.inmateId,
      causeIds: [],
      data: {
        throwInId: entry.id,
        inmateId: entry.inmateId,
        itemId: entry.itemId,
        tileIndex: entry.tileIndex,
      },
    })
    return 'intercepted'
  }

  const entity = world.inmates.get(entry.inmateId)
  if (entity !== undefined) {
    addToInventory(entity.inmate, entry.itemId)
  } else {
    world.contraband.addStash(entry.tileIndex, entry.itemId, 0)
  }

  events.emit({
    tick,
    kind: CONTRABAND_EVENTS.throwInCollected,
    subjectId: entry.inmateId,
    causeIds: [],
    data: {
      throwInId: entry.id,
      inmateId: entry.inmateId,
      itemId: entry.itemId,
      tileIndex: entry.tileIndex,
    },
  })
  refreshCirculationCount(world)
  return 'collected'
}

/* -------------------------------------------------------------------------- */
/* Trading                                                                     */
/* -------------------------------------------------------------------------- */

export interface DemandSupply {
  readonly demand: number
  readonly supply: number
}

/** Counts carried + stashed items (supply) and unmet category demand. */
export function measureMarket(
  world: InmateWorld,
  itemId: string,
): DemandSupply {
  let supply = 0
  let demand = 0
  for (const entity of world.inmates.all()) {
    const carried = countInventoryItem(entity.inmate, itemId)
    supply += carried
    if (inmateWantsItem(world.data, entity, itemId) && carried === 0) demand += 1
    if (!inmateWantsItem(world.data, entity, itemId) && carried > 0) {
      // Unwanted holdings still count as supply (stolen to sell).
    }
  }
  for (const stash of world.contraband.stashes) {
    if (stash.itemId === itemId) supply += 1
  }
  return { demand, supply }
}

export function inmateWantsItem(
  data: GameData,
  entity: InmateEntity,
  itemId: string,
): boolean {
  const def = data.contraband.find(itemId)
  if (def === undefined) return false
  if (entity.inmate.traits.includes('hoarder')) return true
  if (entity.inmate.traits.includes('dealer')) return true

  if (def.category === 'narcotic') {
    return entity.inmate.addictions.some((a) => a.substance === 'narcotics')
  }
  if (def.id === 'liquor') {
    return entity.inmate.addictions.some((a) => a.substance === 'alcohol')
  }
  if (def.category === 'weapon') {
    // Safety-seeking: violent inmates and anyone without a weapon already.
    if (entity.inmate.traits.includes('violent')) return true
    return !entity.inmate.inventory.some((id) => {
      const held = data.contraband.find(id)
      return held !== undefined && held.category === 'weapon' && held.attackPower > 0
    })
  }
  if (def.category === 'tool') {
    return entity.inmate.traits.includes('clever') || entity.inmate.traits.includes('thief')
  }
  if (def.category === 'luxury') {
    return !entity.inmate.traits.includes('devout')
  }
  return false
}

export function inmateSellsItem(
  data: GameData,
  entity: InmateEntity,
  itemId: string,
): boolean {
  if (entity.inmate.traits.includes('hoarder')) return false
  if (entity.inmate.traits.includes('dealer')) return true
  return !inmateWantsItem(data, entity, itemId)
}

/**
 * Recomputes live prices and matches sellers to buyers within the same region.
 */
export function runHourlyMarket(options: {
  readonly world: InmateWorld
  readonly events: EventSink
  readonly tick: number
}): void {
  const { world, events, tick } = options
  const clamp = world.data.balance.contraband.priceDemandClamp
  const priceMap = world.contraband.prices

  for (const item of world.data.contraband.all) {
    if (item.basePrice <= 0) continue
    const { demand, supply } = measureMarket(world, item.id)
    const price = computeContrabandPrice(item.basePrice, demand, supply, clamp)
    priceMap.set(item.id, price)
  }

  events.emit({
    tick,
    kind: CONTRABAND_EVENTS.pricesUpdated,
    causeIds: [],
    data: {
      prices: Object.fromEntries(priceMap.entries()),
    },
  })

  // Match trades region-by-region.
  const byRegion = new Map<number, InmateEntity[]>()
  for (const entity of world.inmates.all()) {
    const region = world.regions.regionAt(world.grid.idx(entity.tx, entity.ty))
    let list = byRegion.get(region)
    if (list === undefined) {
      list = []
      byRegion.set(region, list)
    }
    list.push(entity)
  }

  for (const inmates of byRegion.values()) {
    matchTradesInRegion(world, inmates, events, tick)
  }

  refreshCirculationCount(world)
}

function matchTradesInRegion(
  world: InmateWorld,
  inmates: readonly InmateEntity[],
  events: EventSink,
  tick: number,
): void {
  for (const item of world.data.contraband.all) {
    if (item.basePrice <= 0) continue
    const price = world.contraband.prices.get(item.id) ?? item.basePrice
    const sellers = inmates.filter(
      (entity) =>
        countInventoryItem(entity.inmate, item.id) > 0 &&
        inmateSellsItem(world.data, entity, item.id),
    )
    const buyers = inmates.filter(
      (entity) =>
        inmateWantsItem(world.data, entity, item.id) &&
        countInventoryItem(entity.inmate, item.id) === 0 &&
        entity.inmate.money >= price,
    )

    let si = 0
    let bi = 0
    while (si < sellers.length && bi < buyers.length) {
      const seller = sellers[si]
      const buyer = buyers[bi]
      if (seller === undefined || buyer === undefined) break
      if (seller.id === buyer.id) {
        bi += 1
        continue
      }
      if (!removeFromInventory(seller.inmate, item.id)) {
        si += 1
        continue
      }
      addToInventory(buyer.inmate, item.id)
      seller.inmate.money += price
      buyer.inmate.money -= price
      events.emit({
        tick,
        kind: CONTRABAND_EVENTS.traded,
        subjectId: buyer.id,
        causeIds: [],
        data: {
          buyerId: buyer.id,
          sellerId: seller.id,
          itemId: item.id,
          price,
        },
      })
      si += 1
      bi += 1
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Circulation count                                                           */
/* -------------------------------------------------------------------------- */

export function countCirculatingContraband(world: InmateWorld): number {
  let total = 0
  for (const entity of world.inmates.all()) {
    for (const itemId of entity.inmate.inventory) {
      const def = world.data.contraband.find(itemId)
      if (def !== undefined && def.id !== 'fists' && def.basePrice > 0) total += 1
    }
  }
  total += world.contraband.stashes.length
  for (const entry of world.contraband.throwIns) {
    if (!entry.resolved) total += 1
  }
  return total
}

export function refreshCirculationCount(world: InmateWorld): void {
  world.contracts.progress.setContrabandItems(countCirculatingContraband(world))
}

/* -------------------------------------------------------------------------- */
/* Spatial helpers                                                             */
/* -------------------------------------------------------------------------- */

function smuggleableItems(data: GameData): readonly ContrabandDef[] {
  return data.contraband.all.filter((item) => item.smuggleable && item.basePrice > 0)
}

function findDockTile(world: InmateWorld): number | undefined {
  for (const room of world.rooms.all()) {
    if (room.defId !== 'dock') continue
    if (room.tiles.length === 0) continue
    return room.tiles[0]
  }
  return undefined
}

/**
 * Picks a tile within `throwInRangeTiles` of the map edge (outdoors preferred).
 */
export function findPerimeterTile(world: InmateWorld, rng: RngStream): number | undefined {
  const range = world.data.balance.contraband.throwInRangeTiles
  const size = world.grid.size
  const candidates: number[] = []

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const edgeDist = Math.min(x, y, size - 1 - x, size - 1 - y)
      if (edgeDist > range) continue
      const tile = world.grid.idx(x, y)
      const bits = world.grid.passability[tile] ?? 0
      if ((bits & PASSABILITY.WALKABLE) === 0) continue
      candidates.push(tile)
    }
  }

  if (candidates.length === 0) return undefined
  return candidates[rng.nextInt(0, candidates.length)]
}

function roomContainingInmate(world: InmateWorld, entity: InmateEntity): Room | undefined {
  const tile = world.grid.idx(entity.tx, entity.ty)
  const roomId = world.grid.roomId[tile] ?? NO_ROOM
  if (roomId === NO_ROOM) return undefined
  return world.rooms.get(roomId)
}

function seedStartingMoney(entity: InmateEntity, data: GameData, rng: RngStream): void {
  if (entity.inmate.money > 0) return
  const { min, max } = data.balance.contraband.startingMoney
  entity.inmate.money = rng.nextInt(min, max + 1)
}

/* -------------------------------------------------------------------------- */
/* System tick                                                                 */
/* -------------------------------------------------------------------------- */

export function updateContraband(
  world: InmateWorld,
  data: GameData,
  rng: Rng,
  events: EventSink,
  tick: number,
): void {
  const stream = rng.stream('contraband')
  const balance = data.balance.contraband

  flushPendingArrivals(world, stream, events, tick)

  for (const line of world.contraband.takePendingDeliveries()) {
    contaminateDelivery({
      world,
      itemId: line.itemId,
      units: line.units,
      rng: stream,
      events,
      tick,
      truckId: line.truckId,
    })
  }

  // Hourly market (tradeCheckMinutes, default 60).
  const tradePeriod = balance.tradeCheckMinutes * TICKS_PER_MINUTE
  if (tick > 0 && tick % tradePeriod === 0) {
    runHourlyMarket({ world, events, tick })
  }

  // Resolve due throw-ins every contraband tick.
  for (const entry of world.contraband.throwIns) {
    if (!entry.resolved && tick >= entry.collectTick) {
      resolveThrowIn({ world, entry, events, tick })
    }
  }

  const craftEvery = balance.craftCheckMinutes * TICKS_PER_MINUTE
  const theftEvery = balance.theftCheckMinutes * TICKS_PER_MINUTE
  // System period is already 6 minutes; craft/theft share that cadence when
  // their configured minutes match. Guard against misconfiguration by checking
  // the clock modulus against each period.
  const doTheft = tick % theftEvery === 0
  const doCraft = tick % craftEvery === 0

  for (const entity of world.inmates.all()) {
    seedStartingMoney(entity, data, stream)
    const room = roomContainingInmate(world, entity)
    if (room === undefined) continue

    if (doTheft) {
      attemptRoomTheft({ world, entity, room, rng: stream, events, tick })
    }
    if (room.defId === VISIT_HALL && doTheft) {
      attemptVisitSmuggle({ world, entity, room, rng: stream, events, tick })
    }
    if (doCraft) {
      attemptCraft({ world, entity, room, rng: stream, events, tick })
    }

    // Occasional throw-in arrangement when the inmate has phone / visit access.
    if (doTheft && canArrangeThrowIn(world, entity)) {
      if (stream.next() < balance.throwInArrangeChance) {
        // Skip if they already have an unresolved drop.
        const pending = world.contraband.throwIns.some(
          (entry) => entry.inmateId === entity.id && !entry.resolved,
        )
        if (!pending) {
          arrangeThrowIn({ world, entity, rng: stream, events, tick })
        }
      }
    }
  }

  refreshCirculationCount(world)
}

/* -------------------------------------------------------------------------- */
/* System factory                                                              */
/* -------------------------------------------------------------------------- */

export interface ContrabandSystemOptions {
  readonly data: GameData
}

export function createContrabandSystem(_options: ContrabandSystemOptions): System {
  let reportedWrongWorld = false

  return {
    name: CONTRABAND_SYSTEM_NAME,
    period: CONTRABAND_SYSTEM_PERIOD,

    update(context: SystemContext): void {
      const tick = context.clock.tick
      if (!isInmateWorld(context.world)) {
        if (reportedWrongWorld) return
        reportedWrongWorld = true
        context.events.emit({
          tick,
          kind: CONTRABAND_EVENTS.rejected,
          causeIds: [],
          data: { command: CONTRABAND_SYSTEM_NAME, reason: 'wrong-world' },
        })
        return
      }

      // Switched off at map creation (T6.5). The whole subsystem stops.
      if (!mutatorEnabled(context.world, 'contraband')) return

      updateContraband(context.world, context.world.data, context.rng, context.events, tick)
    },
  }
}

/** Convenience: ticks per hour for tests that drive the market. */
export const CONTRABAND_TRADE_PERIOD_DEFAULT = TICKS_PER_HOUR
