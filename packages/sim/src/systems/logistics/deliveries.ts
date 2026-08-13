/**
 * Truck deliveries (T3.4, PRD 5.13).
 *
 * Material orders batch into inbound trucks that arrive at the dock on a fixed
 * schedule (`balance.logistics.truckIntervalHours`, capacity
 * `truckCapacity`). The same cadence drives refuse collection from the refuse
 * zone. Pure batching / scheduling lives here; stock piles and carry jobs are
 * owned by `supply.ts`.
 */

import { TICKS_PER_HOUR, TICKS_PER_MINUTE, ticksToDay, ticksToTimeString } from '../../core/clock'
import type { Fnv1aHasher } from '../../core/hash'
import type { EventSink, System, SystemContext } from '../../core/simulation'
import type { GameData } from '../../data/loader'
import { isInmateWorld } from '../intakeSystem'
import type { InmateWorld } from '../intakeSystem'

/* -------------------------------------------------------------------------- */
/* Events                                                                      */
/* -------------------------------------------------------------------------- */

export const DELIVERY_EVENTS = {
  truckScheduled: 'delivery.truckScheduled',
  truckArrived: 'delivery.truckArrived',
  refuseCollected: 'delivery.refuseCollected',
} as const

export const DELIVERIES_SYSTEM_NAME = 'deliveries'

/** PRD 4.4: Logistics runs once an in-game minute. */
export const DELIVERIES_SYSTEM_PERIOD = TICKS_PER_MINUTE

/* -------------------------------------------------------------------------- */
/* Types                                                                       */
/* -------------------------------------------------------------------------- */

/** One line item on an inbound truck (or still waiting to be batched). */
export interface DeliveryLine {
  readonly itemId: string
  readonly units: number
  /** Construction site that ordered these units, or 0 for bulk stock. */
  readonly siteId: number
  readonly orderId: number
}

export interface ScheduledTruck {
  readonly id: number
  readonly arriveTick: number
  readonly lines: readonly DeliveryLine[]
  /** Refuse units scheduled for pickup on this run (outbound). */
  readonly refuseUnits: number
}

/** Serializable delivery schedule (save v5). */
export interface DeliveryScheduleSnapshot {
  readonly nextTruckId: number
  readonly nextTruckAt: number
  readonly pending: readonly DeliveryLine[]
  readonly scheduled: readonly {
    readonly id: number
    readonly arriveTick: number
    readonly refuseUnits: number
    readonly lines: readonly DeliveryLine[]
  }[]
}

/* -------------------------------------------------------------------------- */
/* Pure helpers (exported for tests)                                           */
/* -------------------------------------------------------------------------- */

/**
 * Packs pending order lines into trucks of `capacity` items each, earliest
 * first. Returns the batches in schedule order; does not mutate `lines`.
 */
export function batchOrdersIntoTrucks(
  lines: readonly DeliveryLine[],
  capacity: number,
): DeliveryLine[][] {
  if (capacity <= 0 || lines.length === 0) return []

  const remaining: DeliveryLine[] = lines.map((line) => ({ ...line }))
  const trucks: DeliveryLine[][] = []

  while (remaining.length > 0) {
    let space = capacity
    const batch: DeliveryLine[] = []
    let index = 0
    while (index < remaining.length && space > 0) {
      const line = remaining[index]
      if (line === undefined) break
      const take = Math.min(line.units, space)
      if (take <= 0) {
        index += 1
        continue
      }
      batch.push({
        itemId: line.itemId,
        units: take,
        siteId: line.siteId,
        orderId: line.orderId,
      })
      space -= take
      if (take >= line.units) {
        remaining.splice(index, 1)
      } else {
        remaining[index] = { ...line, units: line.units - take }
        index += 1
      }
    }
    if (batch.length === 0) break
    trucks.push(mergeLines(batch))
  }

  return trucks
}

/** Collapses identical (itemId, siteId, orderId) rows after packing. */
function mergeLines(lines: readonly DeliveryLine[]): DeliveryLine[] {
  const keyed = new Map<string, DeliveryLine>()
  for (const line of lines) {
    const key = `${line.orderId}:${line.siteId}:${line.itemId}`
    const existing = keyed.get(key)
    if (existing === undefined) {
      keyed.set(key, { ...line })
    } else {
      keyed.set(key, { ...existing, units: existing.units + line.units })
    }
  }
  return [...keyed.values()].sort((a, b) => {
    if (a.orderId !== b.orderId) return a.orderId - b.orderId
    if (a.siteId !== b.siteId) return a.siteId - b.siteId
    return a.itemId < b.itemId ? -1 : a.itemId > b.itemId ? 1 : 0
  })
}

/** Tick of the next truck slot at or after `fromTick` (interval in hours). */
export function nextTruckTick(fromTick: number, intervalHours: number): number {
  const intervalTicks = Math.max(1, intervalHours) * TICKS_PER_HOUR
  if (fromTick <= 0) return intervalTicks
  const slots = Math.ceil(fromTick / intervalTicks)
  const candidate = slots * intervalTicks
  return candidate === fromTick ? fromTick + intervalTicks : candidate
}

export function truckIntervalTicks(data: GameData): number {
  return Math.max(1, data.balance.logistics.truckIntervalHours) * TICKS_PER_HOUR
}

/* -------------------------------------------------------------------------- */
/* State                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Pending inbound lines and scheduled trucks. Owned by the deliveries system;
 * `SupplyLogistics` reads arrivals and refuse pickups.
 */
export class DeliverySchedule {
  /** Lines waiting to be packed onto a future truck. */
  readonly pending: DeliveryLine[] = []
  /** Trucks that have been scheduled but have not yet arrived. */
  readonly scheduled: ScheduledTruck[] = []
  /** Tick of the next truck opportunity (inbound + refuse outbound). */
  nextTruckAt = 0
  #nextTruckId = 1

  enqueue(line: DeliveryLine): void {
    if (line.units <= 0) return
    this.pending.push({ ...line })
  }

  totalPendingUnits(): number {
    let total = 0
    for (const line of this.pending) total += line.units
    return total
  }

  /**
   * Packs pending lines onto as many trucks as needed, starting at
   * `firstArriveTick` and spacing subsequent trucks by `intervalTicks`.
   * Returns newly scheduled trucks.
   */
  schedulePending(
    firstArriveTick: number,
    capacity: number,
    intervalTicks: number,
    refuseUnits = 0,
  ): ScheduledTruck[] {
    const batches = batchOrdersIntoTrucks(this.pending, capacity)
    this.pending.length = 0

    const created: ScheduledTruck[] = []
    let arrive = firstArriveTick
    let refuseLeft = Math.max(0, refuseUnits)

    if (batches.length === 0 && refuseLeft > 0) {
      const take = Math.min(capacity, refuseLeft)
      const truck = this.#addTruck(arrive, [], take)
      created.push(truck)
      refuseLeft -= take
      arrive += intervalTicks
    }

    for (const batch of batches) {
      const batchUnits = batch.reduce((sum, line) => sum + line.units, 0)
      const refuseSpace = Math.max(0, capacity - batchUnits)
      const refuseTake = Math.min(refuseSpace, refuseLeft)
      const truck = this.#addTruck(arrive, batch, refuseTake)
      created.push(truck)
      refuseLeft -= refuseTake
      arrive += intervalTicks
    }

    while (refuseLeft > 0) {
      const take = Math.min(capacity, refuseLeft)
      const truck = this.#addTruck(arrive, [], take)
      created.push(truck)
      refuseLeft -= take
      arrive += intervalTicks
    }

    if (created.length > 0) {
      const last = created[created.length - 1]
      if (last !== undefined) {
        this.nextTruckAt = last.arriveTick + intervalTicks
      }
    }

    return created
  }

  /** Trucks whose `arriveTick` is at or before `tick`, removed from the queue. */
  takeArrivals(tick: number): ScheduledTruck[] {
    const arrived: ScheduledTruck[] = []
    const remaining: ScheduledTruck[] = []
    for (const truck of this.scheduled) {
      if (truck.arriveTick <= tick) arrived.push(truck)
      else remaining.push(truck)
    }
    this.scheduled.length = 0
    this.scheduled.push(...remaining)
    arrived.sort((a, b) => a.id - b.id)
    return arrived
  }

  hashInto(hasher: Fnv1aHasher): void {
    hasher.writeUint32(this.#nextTruckId)
    hasher.writeUint32(this.nextTruckAt)
    hasher.writeUint32(this.pending.length)
    for (const line of this.pending) {
      hasher.writeString(line.itemId)
      hasher.writeUint32(line.units)
      hasher.writeUint32(line.siteId)
      hasher.writeUint32(line.orderId)
    }
    hasher.writeUint32(this.scheduled.length)
    for (const truck of this.scheduled) {
      hasher.writeUint32(truck.id)
      hasher.writeUint32(truck.arriveTick)
      hasher.writeUint32(truck.refuseUnits)
      hasher.writeUint32(truck.lines.length)
      for (const line of truck.lines) {
        hasher.writeString(line.itemId)
        hasher.writeUint32(line.units)
        hasher.writeUint32(line.siteId)
        hasher.writeUint32(line.orderId)
      }
    }
  }

  serialise(): DeliveryScheduleSnapshot {
    return {
      nextTruckId: this.#nextTruckId,
      nextTruckAt: this.nextTruckAt,
      pending: this.pending.map((line) => ({ ...line })),
      scheduled: this.scheduled.map((truck) => ({
        id: truck.id,
        arriveTick: truck.arriveTick,
        refuseUnits: truck.refuseUnits,
        lines: truck.lines.map((line) => ({ ...line })),
      })),
    }
  }

  restore(snapshot: DeliveryScheduleSnapshot): void {
    this.pending.length = 0
    this.pending.push(...snapshot.pending.map((line) => ({ ...line })))
    this.scheduled.length = 0
    this.scheduled.push(
      ...snapshot.scheduled.map((truck) => ({
        id: truck.id,
        arriveTick: truck.arriveTick,
        refuseUnits: truck.refuseUnits,
        lines: truck.lines.map((line) => ({ ...line })),
      })),
    )
    this.#nextTruckId = snapshot.nextTruckId
    this.nextTruckAt = snapshot.nextTruckAt
  }

  #addTruck(
    arriveTick: number,
    lines: readonly DeliveryLine[],
    refuseUnits: number,
  ): ScheduledTruck {
    const truck: ScheduledTruck = {
      id: this.#nextTruckId,
      arriveTick,
      lines: lines.map((line) => ({ ...line })),
      refuseUnits,
    }
    this.#nextTruckId += 1
    this.scheduled.push(truck)
    return truck
  }
}

/* -------------------------------------------------------------------------- */
/* System                                                                      */
/* -------------------------------------------------------------------------- */

export interface DeliveriesSystemOptions {
  readonly data: GameData
}

/**
 * Schedules trucks when pending orders or refuse exist, and applies arrivals
 * into dock / refuse stock via `SupplyLogistics`.
 */
export function createDeliveriesSystem(options: DeliveriesSystemOptions): System {
  const { data } = options
  let reportedWrongWorld = false

  return {
    name: DELIVERIES_SYSTEM_NAME,
    period: DELIVERIES_SYSTEM_PERIOD,

    update(context: SystemContext): void {
      const tick = context.clock.tick
      if (!isInmateWorld(context.world)) {
        if (reportedWrongWorld) return
        reportedWrongWorld = true
        context.events.emit({
          tick,
          kind: DELIVERY_EVENTS.truckArrived,
          causeIds: [],
          data: { command: DELIVERIES_SYSTEM_NAME, reason: 'wrong-world' },
        })
        return
      }

      updateDeliveries(context.world, data, context.events, tick)
    },
  }
}

/** One logistics minute of truck scheduling and arrivals. */
export function updateDeliveries(
  world: InmateWorld,
  data: GameData,
  events: EventSink,
  tick: number,
): void {
  const schedule = world.deliveries
  const supply = world.supply
  const logistics = data.balance.logistics
  const capacity = logistics.truckCapacity
  const interval = truckIntervalTicks(data)

  if (schedule.nextTruckAt <= 0) {
    // First truck lands one interval after game start (PRD: on a schedule).
    schedule.nextTruckAt = interval
  }

  // Apply arrivals first so newly landed stock can be carried this minute.
  for (const truck of schedule.takeArrivals(tick)) {
    applyTruckArrival(world, events, tick, truck)
  }

  const refuseWaiting = supply.totalRefuseAwaitingPickup()
  const pendingUnits = schedule.totalPendingUnits()
  if (pendingUnits <= 0 && refuseWaiting <= 0) return

  // Only book new trucks when the next slot is due and nothing is already
  // queued for a future arrival — otherwise pending lines wait for that truck.
  if (schedule.scheduled.length > 0) return
  if (tick < schedule.nextTruckAt) return

  const created = schedule.schedulePending(schedule.nextTruckAt, capacity, interval, refuseWaiting)
  for (const truck of created) {
    events.emit({
      tick,
      kind: DELIVERY_EVENTS.truckScheduled,
      subjectId: truck.id,
      causeIds: [],
      data: {
        truckId: truck.id,
        arriveTick: truck.arriveTick,
        itemUnits: truck.lines.reduce((sum, line) => sum + line.units, 0),
        refuseUnits: truck.refuseUnits,
        day: ticksToDay(truck.arriveTick),
        time: ticksToTimeString(truck.arriveTick),
      },
    })
  }

  // Same-tick arrival when the due slot is now.
  for (const truck of schedule.takeArrivals(tick)) {
    applyTruckArrival(world, events, tick, truck)
  }
}

function applyTruckArrival(
  world: InmateWorld,
  events: EventSink,
  tick: number,
  truck: ScheduledTruck,
): void {
  const supply = world.supply
  let landed = 0
  for (const line of truck.lines) {
    supply.addDockStock(line.itemId, line.units, line.siteId)
    landed += line.units
    // ContrabandSystem rolls contamination on its next tick (T4.2).
    world.contraband.queueDelivery(line.itemId, line.units, truck.id)
  }

  let refuseTaken = 0
  if (truck.refuseUnits > 0) {
    refuseTaken = supply.takeRefuseForTruck(truck.refuseUnits)
  }

  events.emit({
    tick,
    kind: DELIVERY_EVENTS.truckArrived,
    subjectId: truck.id,
    causeIds: [],
    data: {
      truckId: truck.id,
      itemUnits: landed,
      refuseUnits: refuseTaken,
      day: ticksToDay(tick),
      time: ticksToTimeString(tick),
    },
  })

  if (refuseTaken > 0) {
    events.emit({
      tick,
      kind: DELIVERY_EVENTS.refuseCollected,
      subjectId: truck.id,
      causeIds: [],
      data: { truckId: truck.id, units: refuseTaken },
    })
  }
}
