/**
 * Construction supply and refuse logistics (T3.4, PRD 5.13).
 *
 * Committing builds places material orders. `deliveries.ts` batches those onto
 * trucks; this module owns dock / store stock, posts carry jobs
 * (dock → store → site), detects the no-store stall, and runs the refuse loop
 * (bins → refuse zone → truck pickup). Uncollected refuse raises tile dirt so
 * the environment need rises through the existing needs fill path.
 */

import { TICKS_PER_MINUTE, ticksToDay, ticksToTimeString } from '../../core/clock'
import type { Fnv1aHasher } from '../../core/hash'
import type { EventSink, System, SystemContext } from '../../core/simulation'
import type { GameData } from '../../data/loader'
import { isOperational } from '../../entities/objects'
import type { ObjectEntity } from '../../entities/objects'
import { deliver, isDelivered } from '../../world/construction'
import type { ConstructionSite } from '../../world/construction'
import { NO_ROOM } from '../../world/rooms'
import type { Room } from '../../world/rooms'
import { isInmateWorld } from '../intakeSystem'
import type { InmateWorld } from '../intakeSystem'
import { completeJob, postJob } from '../jobSystem'
import type { DeliveryLine } from './deliveries'

/* -------------------------------------------------------------------------- */
/* Constants / events                                                          */
/* -------------------------------------------------------------------------- */

export const SUPPLY_EVENTS = {
  ordered: 'supply.ordered',
  carried: 'supply.carried',
  noStore: 'supply.noStore',
  noDock: 'supply.noDock',
  materialsReady: 'supply.materialsReady',
} as const

export const SUPPLY_SYSTEM_NAME = 'supply'

/** PRD 4.4: Logistics runs once an in-game minute. */
export const SUPPLY_SYSTEM_PERIOD = TICKS_PER_MINUTE

const DOCK_ROOM = 'dock'
const STORE_ROOM = 'store'
const REFUSE_ROOM = 'refuse'
const REFUSE_BIN = 'refuse_bin'

/* -------------------------------------------------------------------------- */
/* Types                                                                       */
/* -------------------------------------------------------------------------- */

export interface MaterialOrder {
  readonly id: number
  readonly itemId: string
  readonly units: number
  readonly siteId: number
  readonly orderedAtTick: number
  /** Units not yet packed onto a truck. */
  remaining: number
}

export type CarryHop = 'dockToStore' | 'storeToSite' | 'binToRefuse'

export interface CarryMission {
  readonly jobId: number
  readonly hop: CarryHop
  readonly itemId: string
  readonly units: number
  readonly siteId: number
  readonly fromObjectId: number
}

interface DockPile {
  /** Unreserved dock stock by item id. */
  readonly free: Map<string, number>
  /** siteId → itemId → units reserved for that site. */
  readonly reserved: Map<number, Map<string, number>>
}

/* -------------------------------------------------------------------------- */
/* State                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Per-prison construction supply and refuse piles.
 *
 * Stock is prison-wide per logistics room type (first dock / store / refuse),
 * matching the v1 meal-chain room model. Reserved dock lines keep a site's
 * ordered materials from being eaten by another site's carry.
 */
export class SupplyLogistics {
  readonly orders: MaterialOrder[] = []
  /** siteId → itemId → units already ordered (including shipped / pending). */
  readonly orderedBySite = new Map<number, Map<string, number>>()
  readonly dock: DockPile = { free: new Map(), reserved: new Map() }
  /** itemId → units in the store. */
  readonly storeStock = new Map<string, number>()
  /** refuse_bin objectId → units. */
  readonly binRefuse = new Map<number, number>()
  /** refuse roomId → units awaiting truck pickup. */
  readonly refuseZone = new Map<number, number>()
  /** Active carry missions keyed by job id. */
  readonly carries = new Map<number, CarryMission>()
  /** Sites for which a no-store stall notification has been emitted. */
  readonly noStoreNotified = new Set<number>()
  noDockNotified = false
  #nextOrderId = 1

  placeOrder(
    itemId: string,
    units: number,
    siteId: number,
    tick: number,
  ): MaterialOrder | undefined {
    if (units <= 0) return undefined
    const order: MaterialOrder = {
      id: this.#nextOrderId,
      itemId,
      units,
      siteId,
      orderedAtTick: tick,
      remaining: units,
    }
    this.#nextOrderId += 1
    this.orders.push(order)
    let byItem = this.orderedBySite.get(siteId)
    if (byItem === undefined) {
      byItem = new Map()
      this.orderedBySite.set(siteId, byItem)
    }
    byItem.set(itemId, (byItem.get(itemId) ?? 0) + units)
    return order
  }

  orderedUnits(siteId: number, itemId: string): number {
    return this.orderedBySite.get(siteId)?.get(itemId) ?? 0
  }

  /** Drain remaining order lines into delivery-schedule lines. */
  takePendingDeliveryLines(): DeliveryLine[] {
    const lines: DeliveryLine[] = []
    for (const order of this.orders) {
      if (order.remaining <= 0) continue
      lines.push({
        itemId: order.itemId,
        units: order.remaining,
        siteId: order.siteId,
        orderId: order.id,
      })
      order.remaining = 0
    }
    for (let i = this.orders.length - 1; i >= 0; i -= 1) {
      const order = this.orders[i]
      if (order !== undefined && order.remaining <= 0) this.orders.splice(i, 1)
    }
    return lines
  }

  addDockStock(itemId: string, units: number, siteId: number): void {
    if (units <= 0) return
    if (siteId > 0) {
      let byItem = this.dock.reserved.get(siteId)
      if (byItem === undefined) {
        byItem = new Map()
        this.dock.reserved.set(siteId, byItem)
      }
      byItem.set(itemId, (byItem.get(itemId) ?? 0) + units)
      return
    }
    this.dock.free.set(itemId, (this.dock.free.get(itemId) ?? 0) + units)
  }

  dockUnits(itemId: string, siteId?: number): number {
    let total = this.dock.free.get(itemId) ?? 0
    if (siteId !== undefined) {
      total += this.dock.reserved.get(siteId)?.get(itemId) ?? 0
    } else {
      for (const byItem of this.dock.reserved.values()) {
        total += byItem.get(itemId) ?? 0
      }
    }
    return total
  }

  totalDockUnits(): number {
    let total = 0
    for (const units of this.dock.free.values()) total += units
    for (const byItem of this.dock.reserved.values()) {
      for (const units of byItem.values()) total += units
    }
    return total
  }

  takeDockStock(itemId: string, units: number, preferredSiteId: number): number {
    let remaining = units
    let taken = 0

    if (preferredSiteId > 0) {
      const byItem = this.dock.reserved.get(preferredSiteId)
      const held = byItem?.get(itemId) ?? 0
      const take = Math.min(held, remaining)
      if (take > 0 && byItem !== undefined) {
        byItem.set(itemId, held - take)
        if (held - take <= 0) byItem.delete(itemId)
        if (byItem.size === 0) this.dock.reserved.delete(preferredSiteId)
        taken += take
        remaining -= take
      }
    }

    if (remaining > 0) {
      const free = this.dock.free.get(itemId) ?? 0
      const take = Math.min(free, remaining)
      if (take > 0) {
        this.dock.free.set(itemId, free - take)
        if (free - take <= 0) this.dock.free.delete(itemId)
        taken += take
        remaining -= take
      }
    }

    if (remaining > 0) {
      for (const [siteId, byItem] of this.dock.reserved) {
        if (remaining <= 0) break
        if (siteId === preferredSiteId) continue
        const held = byItem.get(itemId) ?? 0
        const take = Math.min(held, remaining)
        if (take <= 0) continue
        byItem.set(itemId, held - take)
        if (held - take <= 0) byItem.delete(itemId)
        if (byItem.size === 0) this.dock.reserved.delete(siteId)
        taken += take
        remaining -= take
      }
    }

    return taken
  }

  addStoreStock(itemId: string, units: number): void {
    if (units <= 0) return
    this.storeStock.set(itemId, (this.storeStock.get(itemId) ?? 0) + units)
  }

  takeStoreStock(itemId: string, units: number): number {
    const held = this.storeStock.get(itemId) ?? 0
    const take = Math.min(held, Math.max(0, units))
    if (take > 0) {
      this.storeStock.set(itemId, held - take)
      if (held - take <= 0) this.storeStock.delete(itemId)
    }
    return take
  }

  storeUnits(itemId: string): number {
    return this.storeStock.get(itemId) ?? 0
  }

  addBinRefuse(binObjectId: number, units: number): void {
    if (units <= 0 || binObjectId <= 0) return
    this.binRefuse.set(binObjectId, (this.binRefuse.get(binObjectId) ?? 0) + units)
  }

  takeBinRefuse(binObjectId: number, units: number): number {
    const held = this.binRefuse.get(binObjectId) ?? 0
    const take = Math.min(held, Math.max(0, units))
    if (take > 0) {
      this.binRefuse.set(binObjectId, held - take)
      if (held - take <= 0) this.binRefuse.delete(binObjectId)
    }
    return take
  }

  addRefuseZone(roomId: number, units: number): void {
    if (units <= 0 || roomId === NO_ROOM) return
    this.refuseZone.set(roomId, (this.refuseZone.get(roomId) ?? 0) + units)
  }

  totalRefuseAwaitingPickup(): number {
    let total = 0
    for (const units of this.refuseZone.values()) total += units
    return total
  }

  takeRefuseForTruck(units: number): number {
    let remaining = Math.max(0, units)
    let taken = 0
    const rooms = [...this.refuseZone.keys()].sort((a, b) => a - b)
    for (const roomId of rooms) {
      if (remaining <= 0) break
      const held = this.refuseZone.get(roomId) ?? 0
      const take = Math.min(held, remaining)
      if (take <= 0) continue
      this.refuseZone.set(roomId, held - take)
      if (held - take <= 0) this.refuseZone.delete(roomId)
      taken += take
      remaining -= take
    }
    return taken
  }

  totalUncollectedRefuse(): number {
    let total = this.totalRefuseAwaitingPickup()
    for (const units of this.binRefuse.values()) total += units
    return total
  }

  hashInto(hasher: Fnv1aHasher): void {
    hasher.writeUint32(this.#nextOrderId)
    hasher.writeUint32(this.orders.length)
    for (const order of this.orders) {
      hasher.writeUint32(order.id)
      hasher.writeString(order.itemId)
      hasher.writeUint32(order.units)
      hasher.writeUint32(order.remaining)
      hasher.writeUint32(order.siteId)
      hasher.writeUint32(order.orderedAtTick)
    }
    hashStockMap(hasher, this.dock.free)
    hasher.writeUint32(this.dock.reserved.size)
    const reservedSites = [...this.dock.reserved.keys()].sort((a, b) => a - b)
    for (const siteId of reservedSites) {
      hasher.writeUint32(siteId)
      hashStockMap(hasher, this.dock.reserved.get(siteId) ?? new Map())
    }
    hashStockMap(hasher, this.storeStock)
    hasher.writeUint32(this.binRefuse.size)
    for (const [id, units] of [...this.binRefuse.entries()].sort((a, b) => a[0] - b[0])) {
      hasher.writeUint32(id)
      hasher.writeUint32(units)
    }
    hasher.writeUint32(this.refuseZone.size)
    for (const [id, units] of [...this.refuseZone.entries()].sort((a, b) => a[0] - b[0])) {
      hasher.writeUint32(id)
      hasher.writeUint32(units)
    }
    hasher.writeUint32(this.carries.size)
    for (const [jobId, mission] of [...this.carries.entries()].sort((a, b) => a[0] - b[0])) {
      hasher.writeUint32(jobId)
      hasher.writeString(mission.hop)
      hasher.writeString(mission.itemId)
      hasher.writeUint32(mission.units)
      hasher.writeUint32(mission.siteId)
      hasher.writeUint32(mission.fromObjectId)
    }
  }
}

function hashStockMap(hasher: Fnv1aHasher, stock: ReadonlyMap<string, number>): void {
  const entries = [...stock.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
  hasher.writeUint32(entries.length)
  for (const [id, units] of entries) {
    hasher.writeString(id)
    hasher.writeUint32(units)
  }
}

/* -------------------------------------------------------------------------- */
/* Pure helpers                                                                */
/* -------------------------------------------------------------------------- */

/** Outstanding bill units not yet covered by ordered / delivered amounts. */
export function outstandingRequirement(
  site: ConstructionSite,
  orderedUnits: (itemId: string) => number,
): { readonly itemId: string; readonly units: number }[] {
  const gaps: { itemId: string; units: number }[] = []
  site.requirements.forEach((requirement, index) => {
    const delivered = site.delivered[index] ?? 0
    const stillNeeded = requirement.units - delivered
    if (stillNeeded <= 0) return
    const ordered = orderedUnits(requirement.itemId)
    const gap = stillNeeded - ordered
    if (gap > 0) gaps.push({ itemId: requirement.itemId, units: gap })
  })
  return gaps
}

export function roomsOfType(world: InmateWorld, defId: string): Room[] {
  const out: Room[] = []
  for (const room of world.rooms.all()) {
    if (room.defId === defId) out.push(room)
  }
  out.sort((a, b) => a.id - b.id)
  return out
}

export function firstRoomTile(_world: InmateWorld, room: Room): number {
  const tiles = [...room.tiles].sort((a, b) => a - b)
  return tiles[0] ?? 0
}

/* -------------------------------------------------------------------------- */
/* System                                                                      */
/* -------------------------------------------------------------------------- */

export interface SupplySystemOptions {
  readonly data: GameData
}

export function createSupplySystem(options: SupplySystemOptions): System {
  const { data } = options
  let reportedWrongWorld = false

  return {
    name: SUPPLY_SYSTEM_NAME,
    period: SUPPLY_SYSTEM_PERIOD,

    update(context: SystemContext): void {
      const tick = context.clock.tick
      if (!isInmateWorld(context.world)) {
        if (reportedWrongWorld) return
        reportedWrongWorld = true
        context.events.emit({
          tick,
          kind: SUPPLY_EVENTS.noStore,
          causeIds: [],
          data: { command: SUPPLY_SYSTEM_NAME, reason: 'wrong-world' },
        })
        return
      }

      updateSupply(context.world, data, context.events, tick)
    },
  }
}

/** One logistics minute of orders, carries, stall detection and refuse dirt. */
export function updateSupply(
  world: InmateWorld,
  data: GameData,
  events: EventSink,
  tick: number,
): void {
  const supply = world.supply
  const docks = roomsOfType(world, DOCK_ROOM)
  const stores = roomsOfType(world, STORE_ROOM)
  const refuseRooms = roomsOfType(world, REFUSE_ROOM)

  syncOrdersFromSites(world, events, tick)
  flushOrdersToDeliveries(world)

  completeClaimedCarries(world, events, tick)
  pruneDeadCarries(world)

  ingestKitchenRefuse(world, refuseRooms)
  raiseDirtFromRefuse(world, data)

  const hasDock = docks.length > 0
  const hasStore = stores.length > 0
  const dock = docks[0]
  const store = stores[0]

  if (!hasDock && supply.orders.length + world.deliveries.pending.length > 0) {
    if (!supply.noDockNotified) {
      supply.noDockNotified = true
      events.emit({
        tick,
        kind: SUPPLY_EVENTS.noDock,
        causeIds: [],
        data: {
          day: ticksToDay(tick),
          time: ticksToTimeString(tick),
        },
      })
    }
  }

  if (hasDock && !hasStore && supply.totalDockUnits() > 0) {
    detectNoStoreStall(world, events, tick)
  } else if (hasStore) {
    supply.noStoreNotified.clear()
  }

  if (hasDock && hasStore && dock !== undefined && store !== undefined) {
    postDockToStoreJobs(world, events, tick, dock, store, data)
  }

  if (hasStore && store !== undefined) {
    postStoreToSiteJobs(world, events, tick, store, data)
  }

  postBinToRefuseJobs(world, events, tick, refuseRooms, data)
}

/* -------------------------------------------------------------------------- */
/* Orders                                                                      */
/* -------------------------------------------------------------------------- */

function syncOrdersFromSites(world: InmateWorld, events: EventSink, tick: number): void {
  const supply = world.supply
  const liveSites = new Set<number>()

  for (const site of world.sites.all()) {
    liveSites.add(site.id)
    if (site.requirements.length === 0) continue
    if (isDelivered(site)) continue

    const gaps = outstandingRequirement(site, (itemId) => supply.orderedUnits(site.id, itemId))
    for (const gap of gaps) {
      const order = supply.placeOrder(gap.itemId, gap.units, site.id, tick)
      if (order === undefined) continue
      events.emit({
        tick,
        kind: SUPPLY_EVENTS.ordered,
        subjectId: site.id,
        causeIds: [site.id],
        data: {
          orderId: order.id,
          siteId: site.id,
          itemId: order.itemId,
          units: order.units,
          tileIndex: site.tileIndex,
        },
      })
    }
  }

  for (const siteId of [...supply.orderedBySite.keys()]) {
    if (!liveSites.has(siteId)) {
      supply.orderedBySite.delete(siteId)
      supply.noStoreNotified.delete(siteId)
      const reserved = supply.dock.reserved.get(siteId)
      if (reserved !== undefined) {
        for (const [itemId, units] of reserved) {
          supply.dock.free.set(itemId, (supply.dock.free.get(itemId) ?? 0) + units)
        }
        supply.dock.reserved.delete(siteId)
      }
    }
  }
}

function flushOrdersToDeliveries(world: InmateWorld): void {
  for (const line of world.supply.takePendingDeliveryLines()) {
    world.deliveries.enqueue(line)
  }
}

/* -------------------------------------------------------------------------- */
/* Carry jobs                                                                  */
/* -------------------------------------------------------------------------- */

function postDockToStoreJobs(
  world: InmateWorld,
  events: EventSink,
  tick: number,
  dock: Room,
  _store: Room,
  data: GameData,
): void {
  const supply = world.supply
  const dockTile = firstRoomTile(world, dock)
  const { carryBatch, carryPriorityDockToStore } = data.balance.jobs.supply

  const items = collectDockItemIds(supply)
  for (const itemId of items) {
    const available = supply.dockUnits(itemId)
    if (available <= 0) continue
    if (hasOpenCarry(world, 'dockToStore', itemId)) continue

    const units = Math.min(carryBatch, available)
    const preferredSite = preferredSiteForDockItem(supply, itemId)
    const job = postJob({
      world,
      kind: 'deliver',
      priority: carryPriorityDockToStore,
      location: dockTile,
      tick,
      events,
    })
    supply.carries.set(job.id, {
      jobId: job.id,
      hop: 'dockToStore',
      itemId,
      units,
      siteId: preferredSite,
      fromObjectId: 0,
    })
  }
}

function postStoreToSiteJobs(
  world: InmateWorld,
  events: EventSink,
  tick: number,
  _store: Room,
  data: GameData,
): void {
  const supply = world.supply
  const { carryBatch, carryPriorityStoreToSite } = data.balance.jobs.supply

  for (const site of world.sites.all()) {
    if (isDelivered(site)) continue
    site.requirements.forEach((requirement, index) => {
      const need = requirement.units - (site.delivered[index] ?? 0)
      if (need <= 0) return
      const inStore = supply.storeUnits(requirement.itemId)
      if (inStore <= 0) return
      if (hasOpenCarry(world, 'storeToSite', requirement.itemId, site.id)) return

      const units = Math.min(carryBatch, need, inStore)
      const job = postJob({
        world,
        kind: 'deliver',
        priority: carryPriorityStoreToSite,
        location: site.tileIndex,
        tick,
        events,
      })
      supply.carries.set(job.id, {
        jobId: job.id,
        hop: 'storeToSite',
        itemId: requirement.itemId,
        units,
        siteId: site.id,
        fromObjectId: 0,
      })
    })
  }
}

function postBinToRefuseJobs(
  world: InmateWorld,
  events: EventSink,
  tick: number,
  refuseRooms: readonly Room[],
  data: GameData,
): void {
  if (refuseRooms.length === 0) return
  const supply = world.supply
  const refuse = refuseRooms[0]
  if (refuse === undefined) return
  const { carryBatch, carryPriorityRefuse } = data.balance.jobs.supply

  for (const [binId, units] of supply.binRefuse) {
    if (units <= 0) continue
    if (hasOpenRefuseCarry(world, binId)) continue
    const bin = world.objects.get(binId)
    if (bin === undefined) continue

    const job = postJob({
      world,
      kind: 'collectRefuse',
      priority: carryPriorityRefuse,
      location: bin.tileIndex,
      tick,
      events,
    })
    supply.carries.set(job.id, {
      jobId: job.id,
      hop: 'binToRefuse',
      itemId: 'refuse',
      units: Math.min(carryBatch, units),
      siteId: refuse.id,
      fromObjectId: binId,
    })
  }
}

function completeClaimedCarries(world: InmateWorld, events: EventSink, tick: number): void {
  const supply = world.supply
  for (const [jobId, mission] of [...supply.carries.entries()]) {
    const job = world.jobs.get(jobId)
    if (job === undefined) {
      supply.carries.delete(jobId)
      continue
    }
    if (job.state !== 'claimed') continue

    const moved = applyCarry(world, mission)
    if (moved <= 0) {
      completeJob(world, jobId, events, tick)
      supply.carries.delete(jobId)
      continue
    }

    completeJob(world, jobId, events, tick)
    supply.carries.delete(jobId)
    events.emit({
      tick,
      kind: SUPPLY_EVENTS.carried,
      subjectId: jobId,
      causeIds: job.claimedBy > 0 ? [job.claimedBy] : [],
      data: {
        hop: mission.hop,
        itemId: mission.itemId,
        units: moved,
        siteId: mission.siteId,
      },
    })

    if (mission.hop === 'storeToSite') {
      const site = findSiteById(world, mission.siteId)
      if (site !== undefined && isDelivered(site)) {
        events.emit({
          tick,
          kind: SUPPLY_EVENTS.materialsReady,
          subjectId: site.id,
          causeIds: [site.id],
          data: { siteId: site.id, tileIndex: site.tileIndex },
        })
      }
    }
  }
}

function applyCarry(world: InmateWorld, mission: CarryMission): number {
  const supply = world.supply
  switch (mission.hop) {
    case 'dockToStore': {
      const taken = supply.takeDockStock(mission.itemId, mission.units, mission.siteId)
      if (taken > 0) supply.addStoreStock(mission.itemId, taken)
      return taken
    }
    case 'storeToSite': {
      const site = findSiteById(world, mission.siteId)
      if (site === undefined) return 0
      const taken = supply.takeStoreStock(mission.itemId, mission.units)
      if (taken <= 0) return 0
      return deliver(site, mission.itemId, taken)
    }
    case 'binToRefuse': {
      const taken = supply.takeBinRefuse(mission.fromObjectId, mission.units)
      if (taken <= 0) return 0
      supply.addRefuseZone(mission.siteId, taken)
      return taken
    }
  }
}

function pruneDeadCarries(world: InmateWorld): void {
  for (const [jobId] of [...world.supply.carries.entries()]) {
    const job = world.jobs.get(jobId)
    if (job === undefined || job.state === 'cancelled' || job.state === 'completed') {
      world.supply.carries.delete(jobId)
    }
  }
}

function detectNoStoreStall(world: InmateWorld, events: EventSink, tick: number): void {
  const supply = world.supply
  for (const site of world.sites.all()) {
    if (isDelivered(site)) continue
    if (site.requirements.length === 0) continue
    if (supply.noStoreNotified.has(site.id)) continue

    let dockHas = false
    for (const requirement of site.requirements) {
      if (supply.dockUnits(requirement.itemId, site.id) > 0) {
        dockHas = true
        break
      }
    }
    if (!dockHas) continue

    supply.noStoreNotified.add(site.id)
    events.emit({
      tick,
      kind: SUPPLY_EVENTS.noStore,
      subjectId: site.id,
      causeIds: [site.id],
      data: {
        siteId: site.id,
        tileIndex: site.tileIndex,
        dockUnits: supply.totalDockUnits(),
        day: ticksToDay(tick),
        time: ticksToTimeString(tick),
      },
    })
  }
}

/* -------------------------------------------------------------------------- */
/* Refuse                                                                      */
/* -------------------------------------------------------------------------- */

function ingestKitchenRefuse(world: InmateWorld, refuseRooms: readonly Room[]): void {
  const meals = world.meals
  const supply = world.supply
  const bins = refuseBins(world)

  for (const [roomId, units] of [...meals.refuseStock.entries()]) {
    if (units <= 0) continue
    meals.refuseStock.set(roomId, 0)

    if (bins.length > 0) {
      let remaining = units
      for (const bin of bins) {
        if (remaining <= 0) break
        const share = Math.ceil(remaining / Math.max(1, bins.length - bins.indexOf(bin)))
        const put = Math.min(remaining, share)
        supply.addBinRefuse(bin.id, put)
        remaining -= put
      }
      if (remaining > 0 && bins[0] !== undefined) {
        supply.addBinRefuse(bins[0].id, remaining)
      }
    } else if (refuseRooms[0] !== undefined) {
      supply.addRefuseZone(refuseRooms[0].id, units)
    } else if (roomId !== NO_ROOM) {
      supply.addRefuseZone(roomId, units)
    }
  }
}

function raiseDirtFromRefuse(world: InmateWorld, data: GameData): void {
  const supply = world.supply
  const dirtMax = data.balance.logistics.dirt.max
  const perTickCap = data.balance.logistics.dirt.perFoodWaste

  for (const [binId, units] of supply.binRefuse) {
    if (units <= 0) continue
    const bin = world.objects.get(binId)
    if (bin === undefined) continue
    const add = Math.min(perTickCap, units)
    const next = Math.min(dirtMax, (world.grid.dirt[bin.tileIndex] ?? 0) + add)
    world.grid.setAt('dirt', bin.tileIndex, next)
  }

  for (const [roomId, units] of supply.refuseZone) {
    if (units <= 0) continue
    const room = world.rooms.get(roomId)
    if (room === undefined) continue
    const tile = firstRoomTile(world, room)
    const add = Math.min(perTickCap, units)
    const next = Math.min(dirtMax, (world.grid.dirt[tile] ?? 0) + add)
    world.grid.setAt('dirt', tile, next)
  }
}

function refuseBins(world: InmateWorld): ObjectEntity[] {
  const bins: ObjectEntity[] = []
  for (const entity of world.objects.all()) {
    if (entity.object.defId !== REFUSE_BIN) continue
    if (!isOperational(entity)) continue
    bins.push(entity)
  }
  bins.sort((a, b) => a.id - b.id)
  return bins
}

/* -------------------------------------------------------------------------- */
/* Queries                                                                     */
/* -------------------------------------------------------------------------- */

function collectDockItemIds(supply: SupplyLogistics): string[] {
  const ids = new Set<string>()
  for (const id of supply.dock.free.keys()) ids.add(id)
  for (const byItem of supply.dock.reserved.values()) {
    for (const id of byItem.keys()) ids.add(id)
  }
  return [...ids].sort()
}

function preferredSiteForDockItem(supply: SupplyLogistics, itemId: string): number {
  let bestSite = 0
  let bestUnits = 0
  for (const [siteId, byItem] of supply.dock.reserved) {
    const units = byItem.get(itemId) ?? 0
    if (units > bestUnits || (units === bestUnits && (bestSite === 0 || siteId < bestSite))) {
      bestSite = siteId
      bestUnits = units
    }
  }
  return bestSite
}

function hasOpenCarry(world: InmateWorld, hop: CarryHop, itemId: string, siteId?: number): boolean {
  for (const mission of world.supply.carries.values()) {
    if (mission.hop !== hop) continue
    if (mission.itemId !== itemId) continue
    if (siteId !== undefined && mission.siteId !== siteId) continue
    const job = world.jobs.get(mission.jobId)
    if (job !== undefined && (job.state === 'open' || job.state === 'claimed')) return true
  }
  return false
}

function hasOpenRefuseCarry(world: InmateWorld, binId: number): boolean {
  for (const mission of world.supply.carries.values()) {
    if (mission.hop !== 'binToRefuse') continue
    if (mission.fromObjectId !== binId) continue
    const job = world.jobs.get(mission.jobId)
    if (job !== undefined && (job.state === 'open' || job.state === 'claimed')) return true
  }
  return false
}

function findSiteById(world: InmateWorld, siteId: number): ConstructionSite | undefined {
  for (const site of world.sites.all()) {
    if (site.id === siteId) return site
  }
  return undefined
}

/**
 * Test helper: claim every open carry job with a distinct fake staff id so
 * exclusivity does not block the batch.
 */
export function claimOpenCarryJobs(world: InmateWorld, baseAgentId = 9000): number {
  let claimed = 0
  for (const mission of world.supply.carries.values()) {
    const job = world.jobs.get(mission.jobId)
    if (job === undefined || job.state !== 'open') continue
    if (world.jobs.claim(job.id, 'staff', baseAgentId + claimed)) claimed += 1
  }
  return claimed
}
