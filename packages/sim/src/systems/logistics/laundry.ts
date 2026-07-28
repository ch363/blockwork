/**
 * Laundry logistics chain (T3.5, PRD 5.13).
 *
 * Uniforms accumulate dirtiness each day worn. Dirty uniforms pile on beds,
 * are collected into baskets, washed, ironed, and redistributed to housing
 * blocks. Receiving a clean uniform discharges the `clothing` need. Laundry →
 * block routing is nearest-by-centroid, overridable once Delegation unlocks
 * `laundry_routing`.
 */

import {
  TICKS_PER_MINUTE,
  ticksToDay,
  ticksToTimeString,
} from '../../core/clock'
import type { Fnv1aHasher } from '../../core/hash'
import type { EventSink, System, SystemContext } from '../../core/simulation'
import type { GameData } from '../../data/loader'
import { hasFeature } from '../../entities/directorate'
import { hasCapability } from '../../entities/staff'
import { isOperational } from '../../entities/objects'
import type { ObjectEntity } from '../../entities/objects'
import { clampNeed } from '../../entities/needs'
import { TRACE_KINDS } from '../../trace/causalEvent'
import type { EventId } from '../../trace/causalEvent'
import type { Room } from '../../world/rooms'
import { NO_ROOM } from '../../world/rooms'
import { roomCentroid, roomCentroidDistance } from './mealChain'
import { roomsOfType } from './supply'
import { isInmateInWorkBlock } from './cleaning'
import { isInmateWorld } from '../intakeSystem'
import type { InmateWorld } from '../intakeSystem'
import { postJob } from '../jobSystem'

/* -------------------------------------------------------------------------- */
/* Constants                                                                   */
/* -------------------------------------------------------------------------- */

export const LAUNDRY_EVENTS = {
  collected: 'laundry.collected',
  washed: 'laundry.washed',
  ironed: 'laundry.ironed',
  distributed: 'laundry.distributed',
  clothingSatisfied: 'laundry.clothingSatisfied',
} as const

export const LAUNDRY_SYSTEM_NAME = 'laundry'

/** PRD 4.4: Logistics runs once an in-game minute. */
export const LAUNDRY_SYSTEM_PERIOD = TICKS_PER_MINUTE

const WASHING_MACHINE = 'washing_machine'
const IRONING_BOARD = 'ironing_board'
const LAUNDRY_BASKET = 'laundry_basket'
const BED_DEFS = new Set(['bed', 'bunk_bed', 'comfort_bed'])
const LAUNDRY_ROOM = 'laundry'
const HOUSING_ROOMS = new Set(['cell', 'dormitory', 'holding_pen', 'isolation'])

/* -------------------------------------------------------------------------- */
/* Pure helpers                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Wash throughput: `machines * uniformsPerMachinePerHour * (1 + assist * labour)`.
 * Numbers come from `balance.logistics.laundry`.
 */
export function uniformsPerHour(
  machines: number,
  labourAssigned: number,
  laundry: GameData['balance']['logistics']['laundry'],
): number {
  if (machines <= 0) return 0
  const labour = Math.max(0, labourAssigned)
  return (
    machines *
    laundry.uniformsPerMachinePerHour *
    (1 + laundry.labourAssistBonus * labour)
  )
}

/** Iron throughput, same shape as wash. */
export function ironPerHour(
  boards: number,
  labourAssigned: number,
  laundry: GameData['balance']['logistics']['laundry'],
): number {
  if (boards <= 0) return 0
  const labour = Math.max(0, labourAssigned)
  return (
    boards *
    laundry.uniformsPerBoardPerHour *
    (1 + laundry.labourAssistBonus * labour)
  )
}

/**
 * Laundry → housing routing: automatic nearest housing room, or an explicit
 * override once Delegation (`laundry_routing`) is researched.
 */
export function selectHousingForLaundry(
  laundryRoom: Room,
  housing: readonly Room[],
  mapSize: number,
  options: {
    readonly routingUnlocked: boolean
    readonly overrideHousingId: number | null
  },
): Room | null {
  if (housing.length === 0) return null
  if (options.routingUnlocked && options.overrideHousingId !== null) {
    const override = housing.find((room) => room.id === options.overrideHousingId)
    if (override !== undefined) return override
  }
  let best: Room | null = null
  let bestDist = Number.POSITIVE_INFINITY
  for (const room of housing) {
    const dist = roomCentroidDistance(laundryRoom, room, mapSize)
    if (dist < bestDist || (dist === bestDist && best !== null && room.id < best.id)) {
      best = room
      bestDist = dist
    }
  }
  return best
}

/** Nearest laundry to a housing room. Tie-break: lower room id. */
export function selectLaundryForHousing(
  housing: Room,
  laundries: readonly Room[],
  mapSize: number,
): Room | null {
  if (laundries.length === 0) return null
  let best: Room | null = null
  let bestDist = Number.POSITIVE_INFINITY
  for (const laundry of laundries) {
    const dist = roomCentroidDistance(housing, laundry, mapSize)
    if (
      dist < bestDist ||
      (dist === bestDist && best !== null && laundry.id < best.id)
    ) {
      best = laundry
      bestDist = dist
    }
  }
  return best
}

/* -------------------------------------------------------------------------- */
/* State                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Per-prison laundry stocks and routing. Uniform dirtiness is tracked per
 * inmate; piles live on beds / baskets / laundry rooms through the wash cycle.
 */
export class LaundryLogistics {
  /** Feature flags unlocked by Directorate research. */
  /** laundryRoomId → housingRoomId overrides (Delegation). */
  readonly routingOverrides = new Map<number, number>()
  /** inmateId → worn uniform dirtiness. */
  readonly uniformDirtiness = new Map<number, number>()
  /** bedObjectId → dirty uniforms piled on the bed. */
  readonly bedDirty = new Map<number, number>()
  /** basketObjectId → dirty uniforms in the basket. */
  readonly basketDirty = new Map<number, number>()
  /** laundryRoomId → dirty uniforms staged for washing. */
  readonly pendingWash = new Map<number, number>()
  /** laundryRoomId → washed uniforms waiting for iron. */
  readonly washedReady = new Map<number, number>()
  /** laundryRoomId → ironed uniforms ready to redistribute. */
  readonly ironedReady = new Map<number, number>()
  /** bedObjectId → clean uniforms waiting for the inmate. */
  readonly bedClean = new Map<number, number>()
  /** Optional display names for Trace copy. */
  readonly roomNames = new Map<number, string>()
  /** Last day we applied daily uniform dirtiness. */
  lastAccrualDay = 0
  /** Fractional wash / iron remainders per laundry room. */
  readonly washRemainder = new Map<number, number>()
  readonly ironRemainder = new Map<number, number>()
  /** One-shot Trace flags. */
  readonly noRouteNotified = new Set<number>()
  readonly noLabourNotified = new Set<number>()
  readonly underCapacityNotified = new Set<number>()
  /** Cumulative uniforms distributed (acceptance). */
  uniformsDistributed = 0

  setRoutingOverride(laundryRoomId: number, housingRoomId: number): void {
    this.routingOverrides.set(laundryRoomId, housingRoomId)
  }

  clearRoutingOverride(laundryRoomId: number): void {
    this.routingOverrides.delete(laundryRoomId)
  }

  hashInto(hasher: Fnv1aHasher): void {
    hasher.writeUint32(this.uniformsDistributed)
    hasher.writeUint32(this.lastAccrualDay)
    hasher.writeUint32(this.routingOverrides.size)
    const routes = [...this.routingOverrides.entries()].sort((a, b) => a[0] - b[0])
    for (const [laundryId, housingId] of routes) {
      hasher.writeUint32(laundryId)
      hasher.writeUint32(housingId)
    }
    hashNumberMap(hasher, this.uniformDirtiness)
    hashNumberMap(hasher, this.bedDirty)
    hashNumberMap(hasher, this.basketDirty)
    hashNumberMap(hasher, this.pendingWash)
    hashNumberMap(hasher, this.washedReady)
    hashNumberMap(hasher, this.ironedReady)
    hashNumberMap(hasher, this.bedClean)
  }
}

function hashNumberMap(hasher: Fnv1aHasher, map: Map<number, number>): void {
  hasher.writeUint32(map.size)
  const entries = [...map.entries()].sort((a, b) => a[0] - b[0])
  for (const [key, value] of entries) {
    hasher.writeUint32(key)
    hasher.writeUint32(Math.round(value))
  }
}

/* -------------------------------------------------------------------------- */
/* System                                                                      */
/* -------------------------------------------------------------------------- */

export interface LaundrySystemOptions {
  readonly data: GameData
}

export function createLaundrySystem(options: LaundrySystemOptions): System {
  const { data } = options
  let reportedWrongWorld = false

  return {
    name: LAUNDRY_SYSTEM_NAME,
    period: LAUNDRY_SYSTEM_PERIOD,

    update(context: SystemContext): void {
      const tick = context.clock.tick
      if (!isInmateWorld(context.world)) {
        if (reportedWrongWorld) return
        reportedWrongWorld = true
        context.events.emit({
          tick,
          kind: LAUNDRY_EVENTS.collected,
          causeIds: [],
          data: { command: LAUNDRY_SYSTEM_NAME, reason: 'wrong-world' },
        })
        return
      }

      updateLaundry(context.world, data, context.events, tick)
    },
  }
}

/** One logistics minute of the uniform lifecycle. */
export function updateLaundry(
  world: InmateWorld,
  data: GameData,
  events: EventSink,
  tick: number,
): void {
  const laundryCfg = data.balance.logistics.laundry
  const laundries = roomsOfType(world, LAUNDRY_ROOM)
  const housing = housingRooms(world)

  accrueDailyUniformDirt(world, data, tick)
  depositDirtyUniformsOnBeds(world, data)
  collectDirtyIntoBaskets(world, data, events, tick)
  moveBasketsIntoWashQueue(world, laundries)

  for (const laundry of laundries) {
    advanceWashIron(world, data, events, tick, laundry, laundryCfg)
    redistributeCleanUniforms(world, data, events, tick, laundry, housing, laundryCfg)
    postLaundryJobs(world, events, tick, laundry)
  }

  deliverCleanUniformsToInmates(world, data, events, tick)
}

/* -------------------------------------------------------------------------- */
/* Daily dirtiness                                                             */
/* -------------------------------------------------------------------------- */

function accrueDailyUniformDirt(
  world: InmateWorld,
  data: GameData,
  tick: number,
): void {
  const day = ticksToDay(tick)
  const logistics = world.laundry
  if (day <= logistics.lastAccrualDay) return
  logistics.lastAccrualDay = day
  const perDay = data.balance.logistics.uniformDirtinessPerDay
  for (const inmate of world.inmates.all()) {
    const prev = logistics.uniformDirtiness.get(inmate.id) ?? 0
    logistics.uniformDirtiness.set(inmate.id, prev + perDay)
  }
}

/**
 * When worn dirtiness crosses the threshold, the dirty uniform piles on the
 * inmate's bed and worn dirtiness resets (they keep wearing it until a clean
 * one arrives).
 */
function depositDirtyUniformsOnBeds(world: InmateWorld, data: GameData): void {
  const threshold = data.balance.logistics.laundry.dirtyThreshold
  const logistics = world.laundry
  for (const inmate of world.inmates.all()) {
    const dirtiness = logistics.uniformDirtiness.get(inmate.id) ?? 0
    if (dirtiness < threshold) continue
    const bed = bedForInmate(world, inmate.id)
    if (bed === null) continue
    logistics.bedDirty.set(bed.id, (logistics.bedDirty.get(bed.id) ?? 0) + 1)
    logistics.uniformDirtiness.set(inmate.id, 0)
  }
}

/* -------------------------------------------------------------------------- */
/* Collect → wash → iron → redistribute                                        */
/* -------------------------------------------------------------------------- */

function collectDirtyIntoBaskets(
  world: InmateWorld,
  data: GameData,
  events: EventSink,
  tick: number,
): void {
  const cfg = data.balance.logistics.laundry
  const collectors = countLaundryLabour(world, data) + countCleanerCollectors(world, data)
  if (collectors <= 0) return

  let budget = Math.floor(collectors * cfg.collectPerWorkerPerMinute)
  if (budget <= 0) return

  const beds = [...world.laundry.bedDirty.entries()]
    .filter(([, n]) => n > 0)
    .sort((a, b) => a[0] - b[0])

  for (const [bedId, dirty] of beds) {
    if (budget <= 0) break
    const basket = nearestBasket(world, bedId)
    if (basket === null) continue
    const space =
      cfg.basketCapacity - (world.laundry.basketDirty.get(basket.id) ?? 0)
    if (space <= 0) continue
    const take = Math.min(dirty, budget, space)
    if (take <= 0) continue
    world.laundry.bedDirty.set(bedId, dirty - take)
    world.laundry.basketDirty.set(
      basket.id,
      (world.laundry.basketDirty.get(basket.id) ?? 0) + take,
    )
    budget -= take
    events.emit({
      tick,
      kind: LAUNDRY_EVENTS.collected,
      subjectId: basket.id,
      causeIds: [bedId],
      data: { bedId, basketId: basket.id, units: take },
    })
  }
}

/** Move basket contents into the nearest laundry's wash pipeline. */
function moveBasketsIntoWashQueue(world: InmateWorld, laundries: readonly Room[]): void {
  if (laundries.length === 0) return
  for (const [basketId, units] of [...world.laundry.basketDirty.entries()]) {
    if (units <= 0) continue
    const basket = world.objects.get(basketId)
    if (basket === undefined) continue
    const laundry = nearestLaundryToTile(world, basket.tileIndex, laundries)
    if (laundry === null) continue
    const roomId = world.grid.getAt('roomId', basket.tileIndex)
    const targetId =
      roomId !== NO_ROOM && laundries.some((r) => r.id === roomId) ? roomId : laundry.id
    world.laundry.basketDirty.set(basketId, 0)
    world.laundry.pendingWash.set(
      targetId,
      (world.laundry.pendingWash.get(targetId) ?? 0) + units,
    )
  }
}

function advanceWashIron(
  world: InmateWorld,
  data: GameData,
  events: EventSink,
  tick: number,
  laundry: Room,
  cfg: GameData['balance']['logistics']['laundry'],
): void {
  const labour = countLaundryLabour(world, data, laundry.id)
  const machines = operationalInRoom(world, laundry.id, WASHING_MACHINE).length
  const boards = operationalInRoom(world, laundry.id, IRONING_BOARD).length

  if (machines > 0 && labour === 0) {
    notifyNoLabour(world, events, tick, laundry, machines)
  } else {
    world.laundry.noLabourNotified.delete(laundry.id)
  }

  const needed = countServedInmates(world, data, laundry, housingRooms(world))
  const capacity = uniformsPerHour(machines, labour, cfg)
  if (needed > 0 && capacity > 0 && capacity < needed / 24) {
    notifyUnderCapacity(world, events, tick, laundry, machines, labour, needed, capacity, cfg)
  }

  const pending = world.laundry.pendingWash.get(laundry.id) ?? 0
  if (pending > 0 && machines > 0 && (labour > 0 || countCleanerCollectors(world, data) > 0)) {
    const workers = Math.max(labour, countCleanerCollectors(world, data) > 0 ? 1 : 0)
    const perMinute = uniformsPerHour(machines, workers, cfg) / 60
    const available = perMinute + (world.laundry.washRemainder.get(laundry.id) ?? 0)
    const whole = Math.min(pending, Math.floor(available))
    world.laundry.washRemainder.set(laundry.id, available - whole)
    if (whole > 0) {
      world.laundry.pendingWash.set(laundry.id, pending - whole)
      world.laundry.washedReady.set(
        laundry.id,
        (world.laundry.washedReady.get(laundry.id) ?? 0) + whole,
      )
      events.emit({
        tick,
        kind: LAUNDRY_EVENTS.washed,
        subjectId: laundry.id,
        causeIds: [],
        data: { laundryRoomId: laundry.id, units: whole },
      })
    }
  }

  const washed = world.laundry.washedReady.get(laundry.id) ?? 0
  if (washed > 0 && boards > 0 && (labour > 0 || countCleanerCollectors(world, data) > 0)) {
    const workers = Math.max(labour, countCleanerCollectors(world, data) > 0 ? 1 : 0)
    const perMinute = ironPerHour(boards, workers, cfg) / 60
    const available = perMinute + (world.laundry.ironRemainder.get(laundry.id) ?? 0)
    const whole = Math.min(washed, Math.floor(available))
    world.laundry.ironRemainder.set(laundry.id, available - whole)
    if (whole > 0) {
      world.laundry.washedReady.set(laundry.id, washed - whole)
      world.laundry.ironedReady.set(
        laundry.id,
        (world.laundry.ironedReady.get(laundry.id) ?? 0) + whole,
      )
      events.emit({
        tick,
        kind: LAUNDRY_EVENTS.ironed,
        subjectId: laundry.id,
        causeIds: [],
        data: { laundryRoomId: laundry.id, units: whole },
      })
    }
  }
}

function redistributeCleanUniforms(
  world: InmateWorld,
  data: GameData,
  events: EventSink,
  tick: number,
  laundry: Room,
  housing: readonly Room[],
  cfg: GameData['balance']['logistics']['laundry'],
): void {
  const ready = world.laundry.ironedReady.get(laundry.id) ?? 0
  if (ready <= 0) return

  const override = world.laundry.routingOverrides.get(laundry.id) ?? null
  const target = selectHousingForLaundry(laundry, housing, world.grid.size, {
    routingUnlocked: hasFeature(data, world.directorate, 'laundry_routing'),
    overrideHousingId: override,
  })

  if (target === null) {
    if (!world.laundry.noRouteNotified.has(laundry.id)) {
      world.laundry.noRouteNotified.add(laundry.id)
      recordEvent(events, {
        tick,
        kind: TRACE_KINDS.laundryNoRouteToHousing,
        subjectId: laundry.id,
        causeIds: [],
        data: {
          laundryName: roomName(world.laundry, laundry, 'Laundry'),
          day: ticksToDay(tick),
          time: ticksToTimeString(tick),
        },
      })
    }
    return
  }
  world.laundry.noRouteNotified.delete(laundry.id)

  const distributors =
    countLaundryLabour(world, data, laundry.id) + countCleanerCollectors(world, data)
  if (distributors <= 0) return

  const budget = Math.min(
    ready,
    Math.floor(distributors * cfg.distributePerWorkerPerMinute),
  )
  if (budget <= 0) return

  const beds = bedsInRoom(world, target.id)
  if (beds.length === 0) return

  let remaining = budget
  let bedIndex = 0
  while (remaining > 0 && beds.length > 0) {
    const bed = beds[bedIndex % beds.length]
    if (bed === undefined) break
    world.laundry.bedClean.set(bed.id, (world.laundry.bedClean.get(bed.id) ?? 0) + 1)
    remaining -= 1
    bedIndex += 1
  }
  const sent = budget - remaining
  if (sent > 0) {
    world.laundry.ironedReady.set(laundry.id, ready - sent)
    world.laundry.uniformsDistributed += sent
    events.emit({
      tick,
      kind: LAUNDRY_EVENTS.distributed,
      subjectId: laundry.id,
      causeIds: [target.id],
      data: {
        laundryRoomId: laundry.id,
        housingRoomId: target.id,
        units: sent,
      },
    })
  }
}

/**
 * When a clean uniform is on the inmate's bed, discharge clothing and consume
 * one clean uniform.
 */
function deliverCleanUniformsToInmates(
  world: InmateWorld,
  data: GameData,
  events: EventSink,
  tick: number,
): void {
  const clothingIndex = data.needs.indexOf('clothing')
  if (clothingIndex < 0) return
  const decay = data.needs.get('clothing').decayOnUse

  for (const inmate of world.inmates.all()) {
    const bed = bedForInmate(world, inmate.id)
    if (bed === null) continue
    const clean = world.laundry.bedClean.get(bed.id) ?? 0
    if (clean <= 0) continue
    world.laundry.bedClean.set(bed.id, clean - 1)
    const needs = inmate.inmate.needs
    needs[clothingIndex] = clampNeed((needs[clothingIndex] ?? 0) - decay)
    events.emit({
      tick,
      kind: LAUNDRY_EVENTS.clothingSatisfied,
      subjectId: inmate.id,
      causeIds: [bed.id],
      data: { inmateId: inmate.id, bedId: bed.id },
    })
  }
}

/* -------------------------------------------------------------------------- */
/* Queries                                                                     */
/* -------------------------------------------------------------------------- */

function housingRooms(world: InmateWorld): Room[] {
  const out: Room[] = []
  for (const room of world.rooms.all()) {
    if (HOUSING_ROOMS.has(room.defId)) out.push(room)
  }
  out.sort((a, b) => a.id - b.id)
  return out
}

function bedForInmate(world: InmateWorld, inmateId: number): ObjectEntity | null {
  const inmate = world.inmates.get(inmateId)
  if (inmate === undefined) return null
  const cellId = inmate.inmate.cellId
  if (cellId === NO_ROOM) return null
  const beds = bedsInRoom(world, cellId)
  if (beds.length === 0) return null
  const bed = beds[inmateId % beds.length]
  return bed ?? null
}

function bedsInRoom(world: InmateWorld, roomId: number): ObjectEntity[] {
  const beds: ObjectEntity[] = []
  for (const entity of world.objects.all()) {
    if (!BED_DEFS.has(entity.object.defId)) continue
    if (entity.object.roomId !== roomId) continue
    beds.push(entity)
  }
  beds.sort((a, b) => a.id - b.id)
  return beds
}

function nearestBasket(world: InmateWorld, bedId: number): ObjectEntity | null {
  const bed = world.objects.get(bedId)
  if (bed === undefined) return null
  const size = world.grid.size
  const bedY = (bed.tileIndex / size) | 0
  const bedX = bed.tileIndex - bedY * size
  let best: ObjectEntity | null = null
  let bestDist = Number.POSITIVE_INFINITY
  for (const entity of world.objects.all()) {
    if (entity.object.defId !== LAUNDRY_BASKET) continue
    if (!isOperational(entity)) continue
    const y = (entity.tileIndex / size) | 0
    const x = entity.tileIndex - y * size
    const dist = Math.abs(x - bedX) + Math.abs(y - bedY)
    if (dist < bestDist || (dist === bestDist && best !== null && entity.id < best.id)) {
      best = entity
      bestDist = dist
    }
  }
  return best
}

function nearestLaundryToTile(
  world: InmateWorld,
  tileIndex: number,
  laundries: readonly Room[],
): Room | null {
  if (laundries.length === 0) return null
  const size = world.grid.size
  const ty = (tileIndex / size) | 0
  const tx = tileIndex - ty * size
  let best: Room | null = null
  let bestDist = Number.POSITIVE_INFINITY
  for (const laundry of laundries) {
    const c = roomCentroid(laundry, size)
    const dist = Math.abs(c.x - tx) + Math.abs(c.y - ty)
    if (
      dist < bestDist ||
      (dist === bestDist && best !== null && laundry.id < best.id)
    ) {
      best = laundry
      bestDist = dist
    }
  }
  return best
}

function operationalInRoom(
  world: InmateWorld,
  roomId: number,
  defId: string,
): ObjectEntity[] {
  const out: ObjectEntity[] = []
  for (const entity of world.objects.all()) {
    if (entity.object.defId !== defId) continue
    if (entity.object.roomId !== roomId) continue
    if (!isOperational(entity)) continue
    out.push(entity)
  }
  out.sort((a, b) => a.id - b.id)
  return out
}

function firstObjectTile(world: InmateWorld, roomId: number, defId: string): number {
  const objs = operationalInRoom(world, roomId, defId)
  return objs[0]?.tileIndex ?? 0
}

/**
 * Laundry labour: inmates with `jobId === 'laundry'` during work blocks.
 * Room-scoped when multiple laundries exist.
 */
export function countLaundryLabour(
  world: InmateWorld,
  _data: GameData,
  laundryRoomId?: number,
): number {
  let laundryCount = 0
  for (const room of world.rooms.all()) {
    if (room.defId === LAUNDRY_ROOM) laundryCount += 1
  }
  let count = 0
  for (const inmate of world.inmates.all()) {
    if (inmate.inmate.jobId !== 'laundry') continue
    if (!isInmateInWorkBlock(world, inmate.id)) continue
    if (laundryRoomId !== undefined && laundryCount > 1) {
      const tileIndex = inmate.ty * world.grid.size + inmate.tx
      const roomId = world.grid.getAt('roomId', tileIndex)
      if (roomId !== laundryRoomId && roomId !== NO_ROOM) continue
    }
    count += 1
  }
  return count
}

/** Cleaners can collect dirty laundry (teardown: janitors collect baskets). */
function countCleanerCollectors(world: InmateWorld, data: GameData): number {
  let count = 0
  for (const staff of world.staff.all()) {
    if (hasCapability(data, staff, 'clean')) count += 1
  }
  return count
}

function countServedInmates(
  world: InmateWorld,
  data: GameData,
  laundry: Room,
  housing: readonly Room[],
): number {
  if (housing.length === 0) return world.inmates.size
  const override = world.laundry.routingOverrides.get(laundry.id)
  if (hasFeature(data, world.directorate, 'laundry_routing') && override !== undefined) {
    let count = 0
    for (const inmate of world.inmates.all()) {
      if (inmate.inmate.cellId === override) count += 1
    }
    return count
  }
  const laundries = roomsOfType(world, LAUNDRY_ROOM)
  if (laundries.length <= 1) return world.inmates.size
  let count = 0
  for (const inmate of world.inmates.all()) {
    const cell = world.rooms.get(inmate.inmate.cellId)
    if (cell === undefined) {
      count += 1
      continue
    }
    const nearest = selectLaundryForHousing(cell, laundries, world.grid.size)
    if (nearest?.id === laundry.id) count += 1
  }
  return count
}

function postLaundryJobs(
  world: InmateWorld,
  events: EventSink,
  tick: number,
  laundry: Room,
): void {
  const pending = world.laundry.pendingWash.get(laundry.id) ?? 0
  const washed = world.laundry.washedReady.get(laundry.id) ?? 0
  if (pending > 0) {
    ensureOpenJob(
      world,
      events,
      tick,
      'wash',
      firstObjectTile(world, laundry.id, WASHING_MACHINE),
      70,
    )
  }
  if (washed > 0) {
    ensureOpenJob(
      world,
      events,
      tick,
      'iron',
      firstObjectTile(world, laundry.id, IRONING_BOARD),
      65,
    )
  }
}

function ensureOpenJob(
  world: InmateWorld,
  events: EventSink,
  tick: number,
  kind: 'wash' | 'iron',
  location: number,
  priority: number,
): void {
  for (const job of world.jobs.open()) {
    if (job.kind === kind && job.location === location) return
  }
  for (const job of world.jobs.claimed()) {
    if (job.kind === kind && job.location === location) return
  }
  postJob({ world, kind, priority, location, tick, events })
}

function notifyNoLabour(
  world: InmateWorld,
  events: EventSink,
  tick: number,
  laundry: Room,
  machines: number,
): void {
  if (world.laundry.noLabourNotified.has(laundry.id)) return
  // Cleaners also run the machines; only warn when nobody can work them.
  if (countCleanerCollectors(world, world.data) > 0) return
  world.laundry.noLabourNotified.add(laundry.id)
  recordEvent(events, {
    tick,
    kind: TRACE_KINDS.laundryNoLabour,
    subjectId: laundry.id,
    causeIds: [],
    data: {
      laundryName: roomName(world.laundry, laundry, 'Laundry'),
      machines,
      machinesPlural: machines === 1 ? '' : 's',
      day: ticksToDay(tick),
      time: ticksToTimeString(tick),
    },
  })
}

function notifyUnderCapacity(
  world: InmateWorld,
  events: EventSink,
  tick: number,
  laundry: Room,
  machines: number,
  labour: number,
  needed: number,
  capacity: number,
  cfg: GameData['balance']['logistics']['laundry'],
): void {
  if (world.laundry.underCapacityNotified.has(laundry.id)) return
  world.laundry.underCapacityNotified.add(laundry.id)
  const assistFactor = 1 + cfg.labourAssistBonus * labour
  recordEvent(events, {
    tick,
    kind: TRACE_KINDS.laundryUnderCapacity,
    subjectId: laundry.id,
    causeIds: [],
    data: {
      laundryName: roomName(world.laundry, laundry, 'Laundry'),
      machines,
      machinesPlural: machines === 1 ? '' : 's',
      labour,
      labourPlural: labour === 1 ? '' : 's',
      uniformsPerMachinePerHour: cfg.uniformsPerMachinePerHour,
      assistFactor,
      uniformsPerHour: capacity,
      needed,
      day: ticksToDay(tick),
      time: ticksToTimeString(tick),
    },
  })
}

function roomName(laundry: LaundryLogistics, room: Room, fallback: string): string {
  return laundry.roomNames.get(room.id) ?? `${fallback} ${String(room.id)}`
}

function recordEvent(
  events: EventSink,
  event: {
    readonly tick: number
    readonly kind: string
    readonly subjectId: number
    readonly causeIds: readonly number[]
    readonly data: Record<string, string | number | boolean>
  },
): EventId {
  const log = events as EventSink & { record?: (e: typeof event) => { id: EventId } }
  if (typeof log.record === 'function') {
    return log.record(event).id
  }
  events.emit(event)
  return 0
}
