/**
 * Meal logistics chain (T3.3, PRD 5.13).
 *
 * Ingredients live in fridges, cookers produce into serving counters during a
 * preparation window that opens `preparationLeadHours` before each contiguous
 * `meal` block, trays return to kitchen sinks, and refuse accumulates for
 * export. Every failure point emits a CausalEvent so the Trace can reconstruct
 * why a mess hall ran empty.
 *
 * Agent-carried hops for dock → store → fridge arrive with T3.4; this system
 * owns fridge stock onward and posts cook / serve / wash jobs onto the T3.2
 * pool when work is available.
 */

import {
  HOURS_PER_DAY,
  TICKS_PER_DAY,
  TICKS_PER_HOUR,
  TICKS_PER_MINUTE,
  ticksToDay,
  ticksToHour,
  ticksToMinute,
  ticksToTimeString,
} from '../../core/clock'
import type { Fnv1aHasher } from '../../core/hash'
import type { EventSink, System, SystemContext } from '../../core/simulation'
import type { GameData } from '../../data/loader'
import type { RoutineBlockId } from '../../data/schemas'
import { hasFeature } from '../../entities/directorate'
import { hasCapability } from '../../entities/staff'
import { isOperational } from '../../entities/objects'
import type { ObjectEntity } from '../../entities/objects'
import { tileXy } from '../../entities/job'
import { TRACE_KINDS } from '../../trace/causalEvent'
import type { EventId } from '../../trace/causalEvent'
import type { Room } from '../../world/rooms'
import { NO_ROOM } from '../../world/rooms'
import { isInmateWorld } from '../intakeSystem'
import type { InmateWorld } from '../intakeSystem'
import { postJob } from '../jobSystem'

/* -------------------------------------------------------------------------- */
/* Policy                                                                      */
/* -------------------------------------------------------------------------- */

export const MEAL_QUANTITIES = ['low', 'normal', 'high'] as const
export type MealQuantity = (typeof MEAL_QUANTITIES)[number]

export function isMealQuantity(value: string): value is MealQuantity {
  return (MEAL_QUANTITIES as readonly string[]).includes(value)
}

/** Standing-order meal policy (PRD 5.13 / Directorate Standing Orders). */
export interface MealStandingOrders {
  quantity: MealQuantity
  /** Distinct ingredient types required in fridge stock (1..maxMealVariety). */
  variety: number
}

export const MEAL_EVENTS = {
  prepStarted: 'meal.prepStarted',
  mealProduced: 'meal.produced',
  mealServed: 'meal.served',
  trayWashed: 'meal.trayWashed',
  missedMeal: 'meal.missed',
} as const

export const MEAL_CHAIN_SYSTEM_NAME = 'mealChain'

/** PRD 4.4: Logistics runs once an in-game minute. */
export const MEAL_CHAIN_SYSTEM_PERIOD = TICKS_PER_MINUTE

const FRIDGE_DEF = 'fridge'
const COOKER_DEF = 'cooker'
const SERVING_COUNTER_DEF = 'serving_counter'
const KITCHEN_SINK_DEF = 'kitchen_sink'
const KITCHEN_ROOM = 'kitchen'
const MESS_ROOM = 'mess_hall'
const REFUSE_ROOM = 'refuse'

/* -------------------------------------------------------------------------- */
/* Pure helpers (exported for tests)                                           */
/* -------------------------------------------------------------------------- */

/**
 * PRD 5.13: `mealsPerHour = cookers * 12 * (1 + 0.25 * cooksAssigned)`.
 * Numbers come from `balance.kitchen`, never hardcoded here.
 */
export function mealsPerHour(
  cookers: number,
  cooksAssigned: number,
  kitchen: GameData['balance']['kitchen'],
): number {
  if (cookers <= 0) return 0
  const cooks = Math.max(0, cooksAssigned)
  return cookers * kitchen.mealsPerCookerPerHour * (1 + kitchen.cookAssistBonus * cooks)
}

/** Required meal count for a mess hall's served population under meal policy. */
export function requiredMealCount(
  population: number,
  quantity: MealQuantity,
  kitchen: GameData['balance']['kitchen'],
): number {
  const pop = Math.max(0, population)
  const multiplier = kitchen.quantityMultipliers[quantity]
  return Math.ceil(pop * multiplier)
}

/** Cookers needed to hit `needed` meals in the preparation window with `cooks`. */
export function neededCookersFor(
  needed: number,
  cooksAssigned: number,
  kitchen: GameData['balance']['kitchen'],
): number {
  if (needed <= 0) return 0
  const perHour = mealsPerHour(1, cooksAssigned, kitchen)
  if (perHour <= 0) return needed
  const capacityPerCooker = perHour * kitchen.preparationLeadHours
  return Math.max(1, Math.ceil(needed / capacityPerCooker))
}

/**
 * Next contiguous `meal` run that has not yet started preparation relative to
 * `tick`. Consecutive meal hours collapse to one production window sized to
 * headcount (PRD 5.7).
 */
export interface MealPrepWindow {
  /** Absolute tick when cooks should begin (meal start − lead hours). */
  readonly prepStartTick: number
  /** Absolute tick of the first hour of the meal run. */
  readonly mealStartTick: number
  /** First hour (0..23) of the contiguous meal run. */
  readonly mealHour: number
  /** Day (1-based) of the meal start. */
  readonly mealDay: number
  /** Length of the contiguous meal run in hours (informational). */
  readonly runHours: number
}

/**
 * Finds meal-block starts across every security category's routine and returns
 * the active prep window at `tick`, or the next upcoming one.
 */
export function nextMealPrepWindow(
  mealHours: readonly number[],
  tick: number,
  preparationLeadHours: number,
): MealPrepWindow | null {
  if (mealHours.length === 0) return null
  const unique = [...new Set(mealHours)].sort((a, b) => a - b)
  const runs = collapseMealRuns(unique)
  if (runs.length === 0) return null

  const day = ticksToDay(tick)
  const leadTicks = preparationLeadHours * TICKS_PER_HOUR

  for (let dayOffset = 0; dayOffset <= 2; dayOffset += 1) {
    const searchDay = day + dayOffset
    for (const run of runs) {
      const mealStartTick = (searchDay - 1) * TICKS_PER_DAY + run.startHour * TICKS_PER_HOUR
      const prepStartTick = mealStartTick - leadTicks
      if (tick < mealStartTick) {
        return {
          prepStartTick,
          mealStartTick,
          mealHour: run.startHour,
          mealDay: searchDay,
          runHours: run.length,
        }
      }
    }
  }
  return null
}

/** Hours (0..23) that are `meal` in any category schedule. */
export function collectMealHours(
  schedules: ReadonlyMap<string, readonly RoutineBlockId[]>,
): number[] {
  const hours: number[] = []
  for (const blocks of schedules.values()) {
    for (let hour = 0; hour < HOURS_PER_DAY; hour += 1) {
      if (blocks[hour] === 'meal') hours.push(hour)
    }
  }
  return hours
}

interface MealRun {
  readonly startHour: number
  readonly length: number
}

function collapseMealRuns(sortedUniqueHours: readonly number[]): MealRun[] {
  if (sortedUniqueHours.length === 0) return []
  const runs: MealRun[] = []
  // Checked: length > 0.
  let start = sortedUniqueHours[0]
  if (start === undefined) return []
  let prev = start
  let length = 1
  for (let i = 1; i < sortedUniqueHours.length; i += 1) {
    const hour = sortedUniqueHours[i]
    if (hour === undefined) break
    if (hour === prev + 1) {
      length += 1
      prev = hour
      continue
    }
    runs.push({ startHour: start, length })
    start = hour
    prev = hour
    length = 1
  }
  runs.push({ startHour: start, length })
  return runs
}

/** Manhattan distance between room centroids (tile indices). */
export function roomCentroidDistance(a: Room, b: Room, mapSize: number): number {
  const ac = roomCentroid(a, mapSize)
  const bc = roomCentroid(b, mapSize)
  return Math.abs(ac.x - bc.x) + Math.abs(ac.y - bc.y)
}

export function roomCentroid(
  room: Room,
  mapSize: number,
): { readonly x: number; readonly y: number } {
  if (room.tiles.length === 0) {
    return { x: room.bounds.x, y: room.bounds.y }
  }
  let sx = 0
  let sy = 0
  for (const tile of room.tiles) {
    const { x, y } = tileXy(tile, mapSize)
    sx += x
    sy += y
  }
  return {
    x: Math.floor(sx / room.tiles.length),
    y: Math.floor(sy / room.tiles.length),
  }
}

/**
 * Kitchen → mess routing: automatic nearest mess, or an explicit override once
 * Delegation (`kitchen_routing`) is researched.
 */
export function selectMessForKitchen(
  kitchen: Room,
  messHalls: readonly Room[],
  mapSize: number,
  options: {
    readonly routingUnlocked: boolean
    readonly overrideMessId: number | null
  },
): Room | null {
  if (messHalls.length === 0) return null
  if (options.routingUnlocked && options.overrideMessId !== null) {
    const override = messHalls.find((mess) => mess.id === options.overrideMessId)
    if (override !== undefined) return override
  }
  let best: Room | null = null
  let bestDist = Number.POSITIVE_INFINITY
  for (const mess of messHalls) {
    const dist = roomCentroidDistance(kitchen, mess, mapSize)
    if (dist < bestDist || (dist === bestDist && best !== null && mess.id < best.id)) {
      best = mess
      bestDist = dist
    }
  }
  return best
}

/**
 * Nearest mess hall to a tile (inmate routing for headcount). Tie-break: lower
 * room id.
 */
export function selectNearestMess(
  tx: number,
  ty: number,
  messHalls: readonly Room[],
  mapSize: number,
): Room | null {
  if (messHalls.length === 0) return null
  let best: Room | null = null
  let bestDist = Number.POSITIVE_INFINITY
  for (const mess of messHalls) {
    const c = roomCentroid(mess, mapSize)
    const dist = Math.abs(c.x - tx) + Math.abs(c.y - ty)
    if (dist < bestDist || (dist === bestDist && best !== null && mess.id < best.id)) {
      best = mess
      bestDist = dist
    }
  }
  return best
}

/* -------------------------------------------------------------------------- */
/* State                                                                       */
/* -------------------------------------------------------------------------- */

/** One kitchen's active preparation toward a meal run. */
export interface KitchenPrepSession {
  readonly kitchenRoomId: number
  readonly messRoomId: number
  readonly prepStartTick: number
  readonly mealStartTick: number
  readonly mealHour: number
  readonly mealDay: number
  readonly needed: number
  produced: number
  /** Event id for under-capacity / no-cook / no-ingredients when set. */
  rootCauseId: EventId
  underCapacityEmitted: boolean
  shortfallEmitted: boolean
  /** Fractional meal remainder carried across minutes. */
  productionRemainder: number
}

/** Serializable meal logistics (save v5). */
export interface MealLogisticsSnapshot {
  readonly standingOrders: { readonly quantity: string; readonly variety: number }
  readonly missedMeals: number
  readonly mealsServed: number
  readonly routingOverrides: readonly { readonly kitchenId: number; readonly messId: number }[]
  readonly fridgeStock: readonly {
    readonly id: number
    readonly items: readonly { readonly itemId: string; readonly units: number }[]
  }[]
  readonly counterMeals: readonly { readonly id: number; readonly value: number }[]
  readonly dirtyTrays: readonly { readonly id: number; readonly value: number }[]
  readonly refuseStock: readonly { readonly id: number; readonly value: number }[]
  readonly prepSessions: readonly {
    readonly kitchenRoomId: number
    readonly messRoomId: number
    readonly prepStartTick: number
    readonly mealStartTick: number
    readonly needed: number
    readonly produced: number
    readonly rootCauseId: number
    readonly productionRemainder: number
  }[]
}

/**
 * Per-prison meal logistics: fridge / counter / tray / refuse stocks, routing
 * overrides, standing orders, and prep sessions.
 */
export class MealLogistics {
  standingOrders: MealStandingOrders
  /** Feature flags unlocked by Directorate research. */
  /** kitchenRoomId → messRoomId overrides (Delegation). */
  readonly routingOverrides = new Map<number, number>()
  /** fridgeObjectId → ingredientId → count */
  readonly fridgeStock = new Map<number, Map<string, number>>()
  /** servingCounterObjectId → cooked meals staged */
  readonly counterMeals = new Map<number, number>()
  /** kitchenRoomId → dirty trays waiting at sinks */
  readonly dirtyTrays = new Map<number, number>()
  /** refuseRoomId → refuse units awaiting export */
  readonly refuseStock = new Map<number, number>()
  /** Optional display names for Trace copy. */
  readonly roomNames = new Map<number, string>()
  /** Active prep sessions keyed by kitchen room id. */
  readonly prepSessions = new Map<number, KitchenPrepSession>()
  /** mealStartTick keys already finalised (shortfall / serve accounting). */
  readonly finalisedMeals = new Set<string>()
  /** Cumulative missed meal servings (acceptance / Trace). */
  missedMeals = 0
  /** Meals successfully served across all mess halls. */
  mealsServed = 0

  constructor(kitchen: GameData['balance']['kitchen']) {
    this.standingOrders = {
      quantity: kitchen.defaultMealQuantity,
      variety: kitchen.defaultMealVariety,
    }
  }

  setRoutingOverride(kitchenRoomId: number, messRoomId: number): void {
    this.routingOverrides.set(kitchenRoomId, messRoomId)
  }

  clearRoutingOverride(kitchenRoomId: number): void {
    this.routingOverrides.delete(kitchenRoomId)
  }

  stockFridge(fridgeObjectId: number, ingredientId: string, units: number): void {
    if (units <= 0) return
    let stock = this.fridgeStock.get(fridgeObjectId)
    if (stock === undefined) {
      stock = new Map()
      this.fridgeStock.set(fridgeObjectId, stock)
    }
    stock.set(ingredientId, (stock.get(ingredientId) ?? 0) + units)
  }

  fridgeUnits(fridgeObjectId: number, ingredientId: string): number {
    return this.fridgeStock.get(fridgeObjectId)?.get(ingredientId) ?? 0
  }

  totalIngredientUnits(fridgeIds: readonly number[]): number {
    let total = 0
    for (const fridgeId of fridgeIds) {
      const stock = this.fridgeStock.get(fridgeId)
      if (stock === undefined) continue
      for (const units of stock.values()) total += units
    }
    return total
  }

  distinctIngredientTypes(fridgeIds: readonly number[]): number {
    const types = new Set<string>()
    for (const fridgeId of fridgeIds) {
      const stock = this.fridgeStock.get(fridgeId)
      if (stock === undefined) continue
      for (const [id, units] of stock) {
        if (units > 0) types.add(id)
      }
    }
    return types.size
  }

  /** Consume `units` ingredients round-robin across stocked types. */
  consumeIngredients(fridgeIds: readonly number[], units: number): number {
    let remaining = units
    while (remaining > 0) {
      let progressed = false
      for (const fridgeId of fridgeIds) {
        const stock = this.fridgeStock.get(fridgeId)
        if (stock === undefined) continue
        for (const [id, count] of stock) {
          if (count <= 0 || remaining <= 0) continue
          stock.set(id, count - 1)
          remaining -= 1
          progressed = true
          if (remaining <= 0) break
        }
        if (remaining <= 0) break
      }
      if (!progressed) break
    }
    return units - remaining
  }

  counterMealCount(counterIds: readonly number[]): number {
    let total = 0
    for (const id of counterIds) total += this.counterMeals.get(id) ?? 0
    return total
  }

  stageMeals(
    counterIds: readonly number[],
    meals: number,
    capacityPerCounter: number,
  ): {
    readonly staged: number
    readonly blocked: number
  } {
    let remaining = meals
    let staged = 0
    for (const id of counterIds) {
      if (remaining <= 0) break
      const held = this.counterMeals.get(id) ?? 0
      const space = Math.max(0, capacityPerCounter - held)
      const add = Math.min(space, remaining)
      if (add > 0) {
        this.counterMeals.set(id, held + add)
        staged += add
        remaining -= add
      }
    }
    return { staged, blocked: remaining }
  }

  takeMeals(counterIds: readonly number[], meals: number): number {
    let remaining = meals
    let taken = 0
    for (const id of counterIds) {
      if (remaining <= 0) break
      const held = this.counterMeals.get(id) ?? 0
      const take = Math.min(held, remaining)
      if (take > 0) {
        this.counterMeals.set(id, held - take)
        taken += take
        remaining -= take
      }
    }
    return taken
  }

  addDirtyTrays(kitchenRoomId: number, count: number): void {
    if (count <= 0) return
    this.dirtyTrays.set(kitchenRoomId, (this.dirtyTrays.get(kitchenRoomId) ?? 0) + count)
  }

  washTrays(kitchenRoomId: number, count: number): number {
    const held = this.dirtyTrays.get(kitchenRoomId) ?? 0
    const washed = Math.min(held, Math.max(0, count))
    this.dirtyTrays.set(kitchenRoomId, held - washed)
    return washed
  }

  addRefuse(refuseRoomId: number, units: number): void {
    if (units <= 0 || refuseRoomId === NO_ROOM) return
    this.refuseStock.set(refuseRoomId, (this.refuseStock.get(refuseRoomId) ?? 0) + units)
  }

  hashInto(hasher: Fnv1aHasher): void {
    hasher.writeString(this.standingOrders.quantity)
    hasher.writeUint32(this.standingOrders.variety)
    hasher.writeUint32(this.missedMeals)
    hasher.writeUint32(this.mealsServed)
    hasher.writeUint32(this.routingOverrides.size)
    const routes = [...this.routingOverrides.entries()].sort((a, b) => a[0] - b[0])
    for (const [kitchenId, messId] of routes) {
      hasher.writeUint32(kitchenId)
      hasher.writeUint32(messId)
    }
    hasher.writeUint32(this.fridgeStock.size)
    const fridges = [...this.fridgeStock.entries()].sort((a, b) => a[0] - b[0])
    for (const [fridgeId, stock] of fridges) {
      hasher.writeUint32(fridgeId)
      const items = [...stock.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))
      hasher.writeUint32(items.length)
      for (const [itemId, units] of items) {
        hasher.writeString(itemId)
        hasher.writeUint32(units)
      }
    }
    hasher.writeUint32(this.counterMeals.size)
    const counters = [...this.counterMeals.entries()].sort((a, b) => a[0] - b[0])
    for (const [id, meals] of counters) {
      hasher.writeUint32(id)
      hasher.writeUint32(meals)
    }
    hasher.writeUint32(this.dirtyTrays.size)
    const trays = [...this.dirtyTrays.entries()].sort((a, b) => a[0] - b[0])
    for (const [id, count] of trays) {
      hasher.writeUint32(id)
      hasher.writeUint32(count)
    }
    hasher.writeUint32(this.refuseStock.size)
    const refuse = [...this.refuseStock.entries()].sort((a, b) => a[0] - b[0])
    for (const [id, units] of refuse) {
      hasher.writeUint32(id)
      hasher.writeUint32(units)
    }
    hasher.writeUint32(this.prepSessions.size)
    const sessions = [...this.prepSessions.values()].sort(
      (a, b) => a.kitchenRoomId - b.kitchenRoomId,
    )
    for (const session of sessions) {
      hasher.writeUint32(session.kitchenRoomId)
      hasher.writeUint32(session.messRoomId)
      hasher.writeUint32(session.prepStartTick)
      hasher.writeUint32(session.mealStartTick)
      hasher.writeUint32(session.needed)
      hasher.writeUint32(session.produced)
      hasher.writeUint32(session.rootCauseId)
      hasher.writeFloat64(session.productionRemainder)
    }
  }

  serialise(): MealLogisticsSnapshot {
    const mapStock = (map: Map<number, Map<string, number>>) =>
      [...map.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([fridgeId, stock]) => ({
          id: fridgeId,
          items: [...stock.entries()]
            .sort((a, b) => (a[0] < b[0] ? -1 : 1))
            .map(([itemId, units]) => ({ itemId, units })),
        }))
    const mapCounts = (map: Map<number, number>) =>
      [...map.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([id, value]) => ({ id, value }))
    return {
      standingOrders: { ...this.standingOrders },
      missedMeals: this.missedMeals,
      mealsServed: this.mealsServed,
      routingOverrides: [...this.routingOverrides.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([kitchenId, messId]) => ({ kitchenId, messId })),
      fridgeStock: mapStock(this.fridgeStock),
      counterMeals: mapCounts(this.counterMeals),
      dirtyTrays: mapCounts(this.dirtyTrays),
      refuseStock: mapCounts(this.refuseStock),
      prepSessions: [...this.prepSessions.values()]
        .sort((a, b) => a.kitchenRoomId - b.kitchenRoomId)
        .map((session) => ({
          kitchenRoomId: session.kitchenRoomId,
          messRoomId: session.messRoomId,
          prepStartTick: session.prepStartTick,
          mealStartTick: session.mealStartTick,
          needed: session.needed,
          produced: session.produced,
          rootCauseId: session.rootCauseId,
          productionRemainder: session.productionRemainder,
        })),
    }
  }

  restore(snapshot: MealLogisticsSnapshot): void {
    this.standingOrders = {
      quantity: isMealQuantity(snapshot.standingOrders.quantity)
        ? snapshot.standingOrders.quantity
        : this.standingOrders.quantity,
      variety: snapshot.standingOrders.variety,
    }
    this.missedMeals = snapshot.missedMeals
    this.mealsServed = snapshot.mealsServed
    this.routingOverrides.clear()
    for (const route of snapshot.routingOverrides) {
      this.routingOverrides.set(route.kitchenId, route.messId)
    }
    this.fridgeStock.clear()
    for (const fridge of snapshot.fridgeStock) {
      const stock = new Map<string, number>()
      for (const item of fridge.items) stock.set(item.itemId, item.units)
      this.fridgeStock.set(fridge.id, stock)
    }
    this.counterMeals.clear()
    for (const entry of snapshot.counterMeals) this.counterMeals.set(entry.id, entry.value)
    this.dirtyTrays.clear()
    for (const entry of snapshot.dirtyTrays) this.dirtyTrays.set(entry.id, entry.value)
    this.refuseStock.clear()
    for (const entry of snapshot.refuseStock) this.refuseStock.set(entry.id, entry.value)
    this.prepSessions.clear()
    for (const session of snapshot.prepSessions) {
      this.prepSessions.set(session.kitchenRoomId, {
        kitchenRoomId: session.kitchenRoomId,
        messRoomId: session.messRoomId,
        prepStartTick: session.prepStartTick,
        mealStartTick: session.mealStartTick,
        mealHour: 0,
        mealDay: 0,
        needed: session.needed,
        produced: session.produced,
        rootCauseId: session.rootCauseId,
        underCapacityEmitted: false,
        shortfallEmitted: false,
        productionRemainder: session.productionRemainder,
      })
    }
  }
}

/* -------------------------------------------------------------------------- */
/* System                                                                      */
/* -------------------------------------------------------------------------- */

export interface MealChainSystemOptions {
  readonly data: GameData
}

export function createMealChainSystem(options: MealChainSystemOptions): System {
  const { data } = options
  let reportedWrongWorld = false

  return {
    name: MEAL_CHAIN_SYSTEM_NAME,
    period: MEAL_CHAIN_SYSTEM_PERIOD,

    update(context: SystemContext): void {
      const tick = context.clock.tick
      if (!isInmateWorld(context.world)) {
        if (reportedWrongWorld) return
        reportedWrongWorld = true
        context.events.emit({
          tick,
          kind: MEAL_EVENTS.missedMeal,
          causeIds: [],
          data: { command: MEAL_CHAIN_SYSTEM_NAME, reason: 'wrong-world' },
        })
        return
      }

      updateMealChain(context.world, data, context.events, tick)
    },
  }
}

/** Core tick — also callable from tests without a full Simulation. */
export function updateMealChain(
  world: InmateWorld,
  data: GameData,
  events: EventSink,
  tick: number,
): void {
  const kitchenBalance = data.balance.kitchen
  const kitchens = roomsOfType(world, KITCHEN_ROOM)
  const messHalls = roomsOfType(world, MESS_ROOM)
  const refuseRooms = roomsOfType(world, REFUSE_ROOM)

  const mealHours = collectMealHours(world.routines.byCategory)
  const window = nextMealPrepWindow(mealHours, tick, kitchenBalance.preparationLeadHours)

  const populationByMess = countPopulationByMess(world, messHalls)

  // Serve first: at a meal-hour boundary the next prep window has already
  // opened (e.g. 08:00 meal ends as 12:00 prep begins), and must not replace
  // the finished session before shortfall accounting runs.
  if (ticksToMinute(tick) === 0) {
    const hour = ticksToHour(tick)
    if (isMealHourAnywhere(world, hour)) {
      serveMealtime(world, data, events, tick, messHalls, kitchens, populationByMess)
    }
  }

  for (const kitchen of kitchens) {
    advanceKitchen({
      world,
      data,
      events,
      tick,
      kitchen,
      messHalls,
      refuseRooms,
      window,
      populationByMess,
    })
  }

  washDirtyTrays(world, data, events, tick, kitchens, refuseRooms)
}

/* -------------------------------------------------------------------------- */
/* Kitchen advance                                                             */
/* -------------------------------------------------------------------------- */

interface AdvanceKitchenArgs {
  readonly world: InmateWorld
  readonly data: GameData
  readonly events: EventSink
  readonly tick: number
  readonly kitchen: Room
  readonly messHalls: readonly Room[]
  readonly refuseRooms: readonly Room[]
  readonly window: MealPrepWindow | null
  readonly populationByMess: ReadonlyMap<number, number>
}

function advanceKitchen(args: AdvanceKitchenArgs): void {
  const { world, data, events, tick, kitchen, messHalls, window, populationByMess } = args
  const meals = world.meals
  const kitchenBalance = data.balance.kitchen

  if (window === null) return

  const routingUnlocked = hasFeature(data, world.directorate, 'kitchen_routing')
  const override = meals.routingOverrides.get(kitchen.id) ?? null
  const mess = selectMessForKitchen(kitchen, messHalls, world.grid.size, {
    routingUnlocked,
    overrideMessId: override,
  })

  const cookers = operationalObjectsInRoom(world, kitchen.id, COOKER_DEF)
  const fridges = objectsInRoom(world, kitchen.id, FRIDGE_DEF)
  const fridgeIds = fridges.map((entity) => entity.id)
  const cooksAssigned = countCooksAssigned(world, data, kitchen.id)
  const sessionKey = kitchen.id

  // Outside the prep window for this meal: nothing to do yet. Sessions whose
  // meal has started are kept until serveMealtime finalises and removes them.
  if (tick < window.prepStartTick || tick >= window.mealStartTick) return

  const existing = meals.prepSessions.get(sessionKey)
  let session: KitchenPrepSession
  if (existing !== undefined && existing.mealStartTick === window.mealStartTick) {
    session = existing
  } else {
    const started = beginPrepSession({
      world,
      data,
      events,
      tick,
      kitchen,
      mess,
      window,
      populationByMess,
      cookers: cookers.length,
      cooksAssigned,
      fridgeIds,
    })
    if (started === null) return
    session = started
    meals.prepSessions.set(sessionKey, session)
  }

  if (session.messRoomId === NO_ROOM) return
  if (cooksAssigned <= 0 || cookers.length === 0) return

  const remaining = session.needed - session.produced
  if (remaining <= 0) return

  const rate = mealsPerHour(cookers.length, cooksAssigned, kitchenBalance)
  const perMinute = rate / 60
  const available = perMinute + session.productionRemainder
  let toProduce = Math.floor(available)
  session.productionRemainder = available - toProduce
  toProduce = Math.min(toProduce, remaining)
  if (toProduce <= 0) return

  const ingredientsNeeded = toProduce * kitchenBalance.ingredientsPerMeal
  const consumed = meals.consumeIngredients(fridgeIds, ingredientsNeeded)
  const mealsFromStock = Math.floor(consumed / kitchenBalance.ingredientsPerMeal)
  if (mealsFromStock <= 0) {
    emitOnceRoot(events, tick, kitchen, session, TRACE_KINDS.kitchenNoIngredients, {
      kitchenName: roomName(meals, kitchen, 'Kitchen'),
      needed: session.needed,
      variety: meals.standingOrders.variety,
      varietyPlural: meals.standingOrders.variety === 1 ? '' : 's',
    })
    return
  }

  const counters = objectsInRoom(world, session.messRoomId, SERVING_COUNTER_DEF)
  const counterIds = counters.map((entity) => entity.id)
  const { staged, blocked } = meals.stageMeals(
    counterIds,
    mealsFromStock,
    kitchenBalance.mealsPerServingCounter,
  )

  session.produced += staged

  if (blocked > 0) {
    const messRoom = messHalls.find((room) => room.id === session.messRoomId)
    events.emit({
      tick,
      kind: TRACE_KINDS.messFull,
      subjectId: session.messRoomId,
      causeIds: [],
      data: {
        messName: messRoom
          ? roomName(meals, messRoom, 'Mess hall')
          : `Mess ${String(session.messRoomId)}`,
        mealsHeld: meals.counterMealCount(counterIds),
        capacity: counterIds.length * kitchenBalance.mealsPerServingCounter,
        kitchenName: roomName(meals, kitchen, 'Kitchen'),
        blocked,
        day: ticksToDay(tick),
        time: ticksToTimeString(tick),
      },
    })
  }

  if (staged > 0) {
    events.emit({
      tick,
      kind: MEAL_EVENTS.mealProduced,
      subjectId: kitchen.id,
      causeIds: [],
      data: {
        kitchenRoomId: kitchen.id,
        messRoomId: session.messRoomId,
        produced: staged,
        totalProduced: session.produced,
        needed: session.needed,
      },
    })

    // Ensure a cook job exists so the job system sees kitchen work.
    if (cookers[0] !== undefined) {
      ensureOpenJob(world, events, tick, 'cook', cookers[0].tileIndex, 80)
    }
  }
}

interface BeginPrepArgs {
  readonly world: InmateWorld
  readonly data: GameData
  readonly events: EventSink
  readonly tick: number
  readonly kitchen: Room
  readonly mess: Room | null
  readonly window: MealPrepWindow
  readonly populationByMess: ReadonlyMap<number, number>
  readonly cookers: number
  readonly cooksAssigned: number
  readonly fridgeIds: readonly number[]
}

function beginPrepSession(args: BeginPrepArgs): KitchenPrepSession | null {
  const {
    world,
    data,
    events,
    tick,
    kitchen,
    mess,
    window,
    populationByMess,
    cookers,
    cooksAssigned,
    fridgeIds,
  } = args
  const meals = world.meals
  const kitchenBalance = data.balance.kitchen
  const name = roomName(meals, kitchen, 'Kitchen')

  events.emit({
    tick,
    kind: MEAL_EVENTS.prepStarted,
    subjectId: kitchen.id,
    causeIds: [],
    data: {
      kitchenRoomId: kitchen.id,
      prepStart: ticksToTimeString(window.prepStartTick),
      mealTime: ticksToTimeString(window.mealStartTick),
      mealDay: window.mealDay,
    },
  })

  if (mess === null) {
    const recorded = recordEvent(events, {
      tick,
      kind: TRACE_KINDS.kitchenNoRouteToMess,
      subjectId: kitchen.id,
      causeIds: [],
      data: { kitchenName: name },
    })
    return {
      kitchenRoomId: kitchen.id,
      messRoomId: NO_ROOM,
      prepStartTick: window.prepStartTick,
      mealStartTick: window.mealStartTick,
      mealHour: window.mealHour,
      mealDay: window.mealDay,
      needed: 0,
      produced: 0,
      rootCauseId: recorded,
      underCapacityEmitted: false,
      shortfallEmitted: false,
      productionRemainder: 0,
    }
  }

  const population = populationByMess.get(mess.id) ?? 0
  const needed = requiredMealCount(population, meals.standingOrders.quantity, kitchenBalance)

  const session: KitchenPrepSession = {
    kitchenRoomId: kitchen.id,
    messRoomId: mess.id,
    prepStartTick: window.prepStartTick,
    mealStartTick: window.mealStartTick,
    mealHour: window.mealHour,
    mealDay: window.mealDay,
    needed,
    produced: 0,
    rootCauseId: 0,
    underCapacityEmitted: false,
    shortfallEmitted: false,
    productionRemainder: 0,
  }

  const varietyNeeded = meals.standingOrders.variety
  const distinct = meals.distinctIngredientTypes(fridgeIds)
  const totalUnits = meals.totalIngredientUnits(fridgeIds)

  if (totalUnits <= 0 || distinct < varietyNeeded) {
    session.rootCauseId = recordEvent(events, {
      tick,
      kind: TRACE_KINDS.kitchenNoIngredients,
      subjectId: kitchen.id,
      causeIds: [],
      data: {
        kitchenName: name,
        needed,
        variety: varietyNeeded,
        varietyPlural: varietyNeeded === 1 ? '' : 's',
      },
    })
    return session
  }

  if (cooksAssigned <= 0) {
    session.rootCauseId = recordEvent(events, {
      tick,
      kind: TRACE_KINDS.kitchenNoCookAssigned,
      subjectId: kitchen.id,
      causeIds: [],
      data: {
        kitchenName: name,
        cookers,
        cookersPlural: cookers === 1 ? '' : 's',
      },
    })
    return session
  }

  const capacity =
    mealsPerHour(cookers, cooksAssigned, kitchenBalance) * kitchenBalance.preparationLeadHours
  if (cookers <= 0 || capacity + 1e-9 < needed) {
    const neededCookers = neededCookersFor(needed, cooksAssigned, kitchenBalance)
    const assistFactor = 1 + kitchenBalance.cookAssistBonus * cooksAssigned
    const mph = mealsPerHour(Math.max(cookers, 0), cooksAssigned, kitchenBalance)
    const altCooks = Math.max(cooksAssigned + 3, 4)
    const altCookers = neededCookersFor(needed, altCooks, kitchenBalance)
    const cookerDef = data.objects.find(COOKER_DEF)
    session.rootCauseId = recordEvent(events, {
      tick,
      kind: TRACE_KINDS.kitchenUnderCapacity,
      subjectId: kitchen.id,
      causeIds: [],
      data: {
        kitchenName: name,
        cookers,
        cooks: cooksAssigned,
        cooksPlural: cooksAssigned === 1 ? '' : 's',
        mealsPerCookerPerHour: kitchenBalance.mealsPerCookerPerHour,
        assistFactor,
        mealsPerHour: mph,
        needed,
        prepHours: kitchenBalance.preparationLeadHours,
        neededCookers,
        neededCooks: altCooks,
        altCookers,
        altCooks,
        cookerCost: cookerDef?.cost ?? 0,
      },
    })
    session.underCapacityEmitted = true
  }

  return session
}

/* -------------------------------------------------------------------------- */
/* Mealtime serving                                                            */
/* -------------------------------------------------------------------------- */

function serveMealtime(
  world: InmateWorld,
  data: GameData,
  events: EventSink,
  tick: number,
  messHalls: readonly Room[],
  kitchens: readonly Room[],
  populationByMess: ReadonlyMap<number, number>,
): void {
  const meals = world.meals
  const kitchenBalance = data.balance.kitchen
  const day = ticksToDay(tick)
  const hour = ticksToHour(tick)
  const time = ticksToTimeString(tick)

  for (const mess of messHalls) {
    const key = `${String(mess.id)}:${String(day)}:${String(hour)}`
    if (meals.finalisedMeals.has(key)) continue
    meals.finalisedMeals.add(key)

    // Only the first hour of a contiguous meal run serves (no double production).
    if (hour > 0 && isMealHourAnywhere(world, hour - 1)) continue

    const population = populationByMess.get(mess.id) ?? 0
    const needed = requiredMealCount(population, meals.standingOrders.quantity, kitchenBalance)
    const counters = objectsInRoom(world, mess.id, SERVING_COUNTER_DEF)
    const counterIds = counters.map((entity) => entity.id)
    const available = meals.counterMealCount(counterIds)
    const served = meals.takeMeals(counterIds, Math.min(available, needed))
    const leftHungry = Math.max(0, needed - served)

    meals.mealsServed += served
    meals.missedMeals += leftHungry

    const kitchen = kitchens.find((k) => {
      const session = meals.prepSessions.get(k.id)
      return (
        session !== undefined && session.messRoomId === mess.id && session.mealStartTick === tick
      )
    })
    const session = kitchen !== undefined ? meals.prepSessions.get(kitchen.id) : undefined

    if (leftHungry > 0 || (session !== undefined && session.produced < session.needed)) {
      let causeId = session?.rootCauseId ?? 0

      if (session !== undefined && !session.shortfallEmitted && session.produced < session.needed) {
        causeId = recordEvent(events, {
          tick,
          kind: TRACE_KINDS.kitchenProducedShortfall,
          subjectId: session.kitchenRoomId,
          causeIds: session.rootCauseId > 0 ? [session.rootCauseId] : [],
          data: {
            kitchenName: kitchen
              ? roomName(meals, kitchen, 'Kitchen')
              : `Kitchen ${String(session.kitchenRoomId)}`,
            produced: session.produced,
            needed: session.needed,
            prepStart: ticksToTimeString(session.prepStartTick),
            mealTime: time,
            day,
          },
        })
        session.shortfallEmitted = true
        session.rootCauseId = causeId
      }

      if (leftHungry > 0) {
        recordEvent(events, {
          tick,
          kind: TRACE_KINDS.messEmptyAtMealtime,
          subjectId: mess.id,
          causeIds: causeId > 0 ? [causeId] : [],
          data: {
            messName: roomName(meals, mess, 'Mess hall'),
            mealsAvailable: available,
            mealsDelivered: session?.produced ?? 0,
            routed: population,
            leftHungry,
            missedThreePlus: 0,
            time,
            day,
          },
        })
      }

      if (leftHungry > 0) {
        events.emit({
          tick,
          kind: MEAL_EVENTS.missedMeal,
          subjectId: mess.id,
          causeIds: causeId > 0 ? [causeId] : [],
          data: {
            messRoomId: mess.id,
            missed: leftHungry,
            needed,
            served,
          },
        })
      }
    }

    if (served > 0) {
      events.emit({
        tick,
        kind: MEAL_EVENTS.mealServed,
        subjectId: mess.id,
        causeIds: [],
        data: { messRoomId: mess.id, served, needed },
      })
      if (kitchen !== undefined) {
        meals.addDirtyTrays(kitchen.id, served)
        const sinks = objectsInRoom(world, kitchen.id, KITCHEN_SINK_DEF)
        if (sinks[0] !== undefined) {
          ensureOpenJob(world, events, tick, 'wash', sinks[0].tileIndex, 40)
        }
      }
    }

    if (session !== undefined) {
      meals.prepSessions.delete(session.kitchenRoomId)
    }
  }
}

function washDirtyTrays(
  world: InmateWorld,
  data: GameData,
  events: EventSink,
  tick: number,
  kitchens: readonly Room[],
  refuseRooms: readonly Room[],
): void {
  const meals = world.meals
  const refuseTarget = refuseRooms[0]?.id ?? NO_ROOM

  for (const kitchen of kitchens) {
    const dirty = meals.dirtyTrays.get(kitchen.id) ?? 0
    if (dirty <= 0) continue
    const sinks = operationalObjectsInRoom(world, kitchen.id, KITCHEN_SINK_DEF)
    if (sinks.length === 0) continue
    const cooks = countCooksAssigned(world, data, kitchen.id)
    if (cooks <= 0) continue

    // One tray per sink per minute while staffed.
    const washed = meals.washTrays(kitchen.id, sinks.length)
    if (washed <= 0) continue
    meals.addRefuse(refuseTarget, washed)
    events.emit({
      tick,
      kind: MEAL_EVENTS.trayWashed,
      subjectId: kitchen.id,
      causeIds: [],
      data: {
        kitchenRoomId: kitchen.id,
        washed,
        refuseRoomId: refuseTarget,
      },
    })
  }

  void data
}

/* -------------------------------------------------------------------------- */
/* World queries                                                               */
/* -------------------------------------------------------------------------- */

function roomsOfType(world: InmateWorld, defId: string): Room[] {
  const out: Room[] = []
  for (const room of world.rooms.all()) {
    if (room.defId === defId) out.push(room)
  }
  out.sort((a, b) => a.id - b.id)
  return out
}

function objectsInRoom(world: InmateWorld, roomId: number, defId: string): ObjectEntity[] {
  return world.objects.inRoom(roomId).filter((entity) => entity.object.defId === defId)
}

function operationalObjectsInRoom(
  world: InmateWorld,
  roomId: number,
  defId: string,
): ObjectEntity[] {
  return objectsInRoom(world, roomId, defId).filter((entity) => isOperational(entity))
}

function countCooksAssigned(world: InmateWorld, data: GameData, kitchenRoomId: number): number {
  let count = 0
  for (const staff of world.staff.all()) {
    if (!hasCapability(data, staff, 'cook')) continue
    count += 1
  }
  let kitchenCount = 0
  for (const room of world.rooms.all()) {
    if (room.defId === KITCHEN_ROOM) kitchenCount += 1
  }
  for (const inmate of world.inmates.all()) {
    if (inmate.inmate.jobId !== 'kitchen') continue
    if (kitchenCount <= 1) {
      count += 1
      continue
    }
    const tileIndex = inmate.ty * world.grid.size + inmate.tx
    const roomId = world.grid.getAt('roomId', tileIndex)
    if (roomId === kitchenRoomId || roomId === NO_ROOM) count += 1
  }
  return count
}

function countPopulationByMess(
  world: InmateWorld,
  messHalls: readonly Room[],
): Map<number, number> {
  const counts = new Map<number, number>()
  for (const mess of messHalls) counts.set(mess.id, 0)
  if (messHalls.length === 0) return counts

  if (messHalls.length === 1) {
    const only = messHalls[0]
    if (only !== undefined) counts.set(only.id, world.inmates.size)
    return counts
  }

  for (const inmate of world.inmates.all()) {
    const mess = selectNearestMess(inmate.tx, inmate.ty, messHalls, world.grid.size)
    if (mess === null) continue
    counts.set(mess.id, (counts.get(mess.id) ?? 0) + 1)
  }
  return counts
}

function isMealHourAnywhere(world: InmateWorld, hour: number): boolean {
  for (const blocks of world.routines.byCategory.values()) {
    if (blocks[hour] === 'meal') return true
  }
  return false
}

function roomName(meals: MealLogistics, room: Room, fallback: string): string {
  return meals.roomNames.get(room.id) ?? `${fallback} ${String(room.id)}`
}

function ensureOpenJob(
  world: InmateWorld,
  events: EventSink,
  tick: number,
  kind: 'cook' | 'wash' | 'serve',
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
  // CausalEventLog.record returns the event; plain sinks only emit.
  const log = events as EventSink & { record?: (e: typeof event) => { id: EventId } }
  if (typeof log.record === 'function') {
    return log.record(event).id
  }
  events.emit(event)
  return 0
}

function emitOnceRoot(
  events: EventSink,
  tick: number,
  kitchen: Room,
  session: KitchenPrepSession,
  kind: string,
  data: Record<string, string | number | boolean>,
): void {
  if (session.rootCauseId > 0 && !session.underCapacityEmitted) return
  if (session.rootCauseId > 0) return
  session.rootCauseId = recordEvent(events, {
    tick,
    kind,
    subjectId: kitchen.id,
    causeIds: [],
    data,
  })
}
