/**
 * T8.20 — truck batching and schedule helpers in logistics/deliveries.ts.
 */

import { describe, expect, it } from 'vitest'

import { TICKS_PER_HOUR } from '../../../src/core/clock'
import { loadGameData } from '../../../src/data/loader'
import {
  DeliverySchedule,
  batchOrdersIntoTrucks,
  nextTruckTick,
  truckIntervalTicks,
} from '../../../src/systems/logistics/deliveries'
import type { DeliveryLine } from '../../../src/systems/logistics/deliveries'

const DATA = loadGameData()
const WALL = 'brick_wall'
const CAPACITY = DATA.balance.logistics.truckCapacity
const INTERVAL = truckIntervalTicks(DATA)

describe('deliveries — batchOrdersIntoTrucks', () => {
  it('packs lines into trucks of capacity without exceeding the limit', () => {
    const lines: DeliveryLine[] = []
    for (let i = 0; i < 50; i += 1) {
      lines.push({ itemId: WALL, units: 1, siteId: i + 1, orderId: i + 1 })
    }

    const trucks = batchOrdersIntoTrucks(lines, 40)
    expect(trucks).toHaveLength(2)
    expect(trucks[0]?.reduce((sum, line) => sum + line.units, 0)).toBe(40)
    expect(trucks[1]?.reduce((sum, line) => sum + line.units, 0)).toBe(10)
  })

  it('splits an oversized single line across trucks', () => {
    const trucks = batchOrdersIntoTrucks([{ itemId: WALL, units: 55, siteId: 1, orderId: 1 }], 40)
    expect(trucks).toHaveLength(2)
    expect(trucks[0]?.[0]?.units).toBe(40)
    expect(trucks[1]?.[0]?.units).toBe(15)
  })

  it('returns nothing when capacity is zero or there are no lines', () => {
    expect(batchOrdersIntoTrucks([], CAPACITY)).toEqual([])
    expect(batchOrdersIntoTrucks([{ itemId: WALL, units: 5, siteId: 1, orderId: 1 }], 0)).toEqual(
      [],
    )
  })
})

describe('deliveries — nextTruckTick', () => {
  it('schedules the first slot one interval after tick zero', () => {
    expect(nextTruckTick(0, 2)).toBe(2 * TICKS_PER_HOUR)
    expect(INTERVAL).toBe(2 * TICKS_PER_HOUR)
  })

  it('advances to the next slot when called exactly on a boundary', () => {
    const slot = nextTruckTick(0, 2)
    expect(nextTruckTick(slot, 2)).toBe(slot + 2 * TICKS_PER_HOUR)
  })

  it('rounds up to the next slot between boundaries', () => {
    const half = TICKS_PER_HOUR
    expect(nextTruckTick(half, 2)).toBe(2 * TICKS_PER_HOUR)
  })
})

describe('deliveries — DeliverySchedule truck schedule', () => {
  it('spaces scheduled trucks by intervalTicks and clears pending lines', () => {
    const schedule = new DeliverySchedule()
    schedule.enqueue({ itemId: WALL, units: 45, siteId: 1, orderId: 1 })
    schedule.enqueue({ itemId: WALL, units: 10, siteId: 2, orderId: 2 })

    const firstArrive = INTERVAL
    const created = schedule.schedulePending(firstArrive, CAPACITY, INTERVAL)

    expect(schedule.pending).toHaveLength(0)
    expect(created).toHaveLength(2)
    expect(created[0]?.arriveTick).toBe(firstArrive)
    expect(created[1]?.arriveTick).toBe(firstArrive + INTERVAL)
    expect(schedule.nextTruckAt).toBe(firstArrive + 2 * INTERVAL)
  })

  it('takeArrivals removes trucks due at or before the tick', () => {
    const schedule = new DeliverySchedule()
    schedule.enqueue({ itemId: WALL, units: 5, siteId: 1, orderId: 1 })
    const [truck] = schedule.schedulePending(INTERVAL, CAPACITY, INTERVAL)
    if (truck === undefined) throw new Error('expected a scheduled truck')

    expect(schedule.takeArrivals(INTERVAL - 1)).toHaveLength(0)
    expect(schedule.scheduled).toHaveLength(1)

    const arrived = schedule.takeArrivals(INTERVAL)
    expect(arrived).toHaveLength(1)
    expect(arrived[0]?.id).toBe(truck.id)
    expect(schedule.scheduled).toHaveLength(0)
  })
})
