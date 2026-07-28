/**
 * `LabourSystem`: inmates earn their keep (T5.7, PRD 5.7 / 5.13 / 5.14).
 *
 * Labour is the third leg of the prison's economy, and the only one the player
 * builds rather than receives. Intake fees and daily payments arrive whatever
 * you do; a workshop only pays if you bought the timber, trained the workers,
 * gave them a contiguous work block, and put a truck on the dock.
 *
 * It is also the quiet half of the behaviour loop. Work discharges `freedom`
 * and feeds the reform grade, so an assigned inmate is measurably less trouble
 * than an idle one — which is the argument for the whole subsystem, and is
 * what the acceptance test measures.
 *
 * Production is deliberately worker-limited rather than machine-limited.
 * Capacity comes from `workerMinutesPerUnit` against the heads actually
 * assigned, so "ten inmates in the workshop" is a number the player can reason
 * about and a bottleneck they can see.
 *
 * Slot: PRD 4.4 #8, the logistics band, once an in-game minute.
 */

import { TICKS_PER_HOUR, TICKS_PER_MINUTE } from '../core/clock'
import type { Command, JsonObject, JsonValue } from '../core/commands'
import type { Fnv1aHasher } from '../core/hash'
import type { RngStream } from '../core/rng'
import type { CommandHandler, EventSink, System, SystemContext } from '../core/simulation'
import type { GameData } from '../data/loader'
import type { Balance, LabourAssignment } from '../data/schemas'
import { LABOUR_ASSIGNMENTS } from '../data/schemas'
import { hasFeature } from '../entities/directorate'
import type { InmateEntity } from '../entities/inmate'
import { NeedIndex, clampNeed } from '../entities/needs'
import { NO_ROOM } from '../world/rooms'
import type { Room } from '../world/rooms'

import { creditLabourHours } from './gradesSystem'
import { isInmateWorld } from './intakeSystem'
import type { InmateWorld } from './intakeSystem'
import { isInmateInWorkBlock } from './logistics/cleaning'

/* -------------------------------------------------------------------------- */
/* Identity                                                                    */
/* -------------------------------------------------------------------------- */

export const LABOUR_SYSTEM_NAME = 'labour'
export const LABOUR_SYSTEM_PERIOD = TICKS_PER_MINUTE
export const LABOUR_RNG_STREAM = 'labour'

export const LABOUR_EVENTS = {
  assigned: 'labour.assigned',
  unassigned: 'labour.unassigned',
  produced: 'labour.produced',
  dispatched: 'labour.dispatched',
  treeFelled: 'labour.treeFelled',
  commissarySale: 'labour.commissarySale',
  rejected: 'labour.rejected',
} as const

export type LabourRejection =
  | 'wrong-world'
  | 'invalid-payload'
  | 'unknown-inmate'
  | 'unknown-assignment'
  | 'feature-locked'
  | 'missing-programme'
  | 'no-room'
  | 'no-free-slot'

/** The room each labour assignment is worked in. */
export const LABOUR_ROOMS: Readonly<Record<LabourAssignment, string>> = {
  kitchen: 'kitchen',
  laundry: 'laundry',
  cleaning: 'supply_closet',
  workshop: 'workshop',
  library: 'library',
  mail: 'mail_sort',
  commissary: 'commissary',
  grove: 'grove',
}

/* -------------------------------------------------------------------------- */
/* State                                                                       */
/* -------------------------------------------------------------------------- */

export interface LabourSnapshot extends JsonObject {
  readonly assignments: readonly { readonly inmateId: number; readonly assignment: string }[]
  readonly workerMinutes: readonly { readonly key: string; readonly minutes: number }[]
  readonly finishedGoods: readonly { readonly productId: string; readonly units: number }[]
  readonly groveMinutes: readonly { readonly roomId: number; readonly minutes: number }[]
  readonly grownTrees: readonly { readonly roomId: number; readonly trees: number }[]
  readonly commissaryGoods: number
  readonly lifetimeExportIncome: number
  readonly lifetimeCommissaryIncome: number
}

/**
 * What labour remembers.
 *
 * Partial worker-minutes are state, not derivation: an inmate who has spent
 * forty of the ninety minutes a fine chair needs has done real work, and
 * throwing that away on a save would make long production lines impossible.
 */
export class LabourRuntime {
  /** inmateId → assignment. */
  readonly assignments = new Map<number, LabourAssignment>()
  /** `roomId:productId` → accumulated worker-minutes. */
  readonly workerMinutes = new Map<string, number>()
  /** Finished goods on the dispatch dock, awaiting a truck. */
  readonly finishedGoods = new Map<string, number>()
  /** Grove roomId → accumulated growth minutes. */
  readonly groveMinutes = new Map<number, number>()
  /** Grove roomId → trees standing and ready to fell. */
  readonly grownTrees = new Map<number, number>()
  /** Commissary stock, in units. */
  commissaryGoods = 0
  lifetimeExportIncome = 0
  lifetimeCommissaryIncome = 0

  assignedTo(assignment: LabourAssignment): number[] {
    const ids: number[] = []
    for (const [inmateId, entry] of this.assignments) {
      if (entry === assignment) ids.push(inmateId)
    }
    ids.sort((a, b) => a - b)
    return ids
  }

  clearInmate(inmateId: number): void {
    this.assignments.delete(inmateId)
  }

  serialise(): LabourSnapshot {
    return {
      assignments: [...this.assignments.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([inmateId, assignment]) => ({ inmateId, assignment })),
      workerMinutes: [...this.workerMinutes.entries()]
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([key, minutes]) => ({ key, minutes })),
      finishedGoods: [...this.finishedGoods.entries()]
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([productId, units]) => ({ productId, units })),
      groveMinutes: [...this.groveMinutes.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([roomId, minutes]) => ({ roomId, minutes })),
      grownTrees: [...this.grownTrees.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([roomId, trees]) => ({ roomId, trees })),
      commissaryGoods: this.commissaryGoods,
      lifetimeExportIncome: this.lifetimeExportIncome,
      lifetimeCommissaryIncome: this.lifetimeCommissaryIncome,
    }
  }

  restore(snapshot: LabourSnapshot): void {
    this.assignments.clear()
    this.workerMinutes.clear()
    this.finishedGoods.clear()
    this.groveMinutes.clear()
    this.grownTrees.clear()

    for (const entry of snapshot.assignments) {
      if (!isLabourAssignment(entry.assignment)) continue
      this.assignments.set(entry.inmateId, entry.assignment)
    }
    for (const entry of snapshot.workerMinutes) this.workerMinutes.set(entry.key, entry.minutes)
    for (const entry of snapshot.finishedGoods) {
      this.finishedGoods.set(entry.productId, entry.units)
    }
    for (const entry of snapshot.groveMinutes) this.groveMinutes.set(entry.roomId, entry.minutes)
    for (const entry of snapshot.grownTrees) this.grownTrees.set(entry.roomId, entry.trees)
    this.commissaryGoods = snapshot.commissaryGoods
    this.lifetimeExportIncome = snapshot.lifetimeExportIncome
    this.lifetimeCommissaryIncome = snapshot.lifetimeCommissaryIncome
  }

  hashInto(hasher: Fnv1aHasher): void {
    const snapshot = this.serialise()
    hasher.writeUint32(snapshot.assignments.length)
    for (const entry of snapshot.assignments) {
      hasher.writeUint32(entry.inmateId)
      hasher.writeString(entry.assignment)
    }
    hasher.writeUint32(snapshot.workerMinutes.length)
    for (const entry of snapshot.workerMinutes) {
      hasher.writeString(entry.key)
      hasher.writeFloat64(entry.minutes)
    }
    hasher.writeUint32(snapshot.finishedGoods.length)
    for (const entry of snapshot.finishedGoods) {
      hasher.writeString(entry.productId)
      hasher.writeUint32(entry.units)
    }
    hasher.writeUint32(snapshot.groveMinutes.length)
    for (const entry of snapshot.groveMinutes) {
      hasher.writeUint32(entry.roomId)
      hasher.writeFloat64(entry.minutes)
    }
    hasher.writeUint32(snapshot.grownTrees.length)
    for (const entry of snapshot.grownTrees) {
      hasher.writeUint32(entry.roomId)
      hasher.writeUint32(entry.trees)
    }
    hasher.writeUint32(this.commissaryGoods)
    hasher.writeUint32(this.lifetimeExportIncome)
    hasher.writeUint32(this.lifetimeCommissaryIncome)
  }
}

export function isLabourAssignment(value: string): value is LabourAssignment {
  return (LABOUR_ASSIGNMENTS as readonly string[]).includes(value)
}

/* -------------------------------------------------------------------------- */
/* Assignment                                                                  */
/* -------------------------------------------------------------------------- */

export interface AssignCheck {
  readonly ok: boolean
  readonly reason?: LabourRejection
  readonly detail?: JsonObject
}

/**
 * Every rule that decides whether this inmate may take this job.
 *
 * Research, then training, then premises, then a free seat — the order the
 * player would fix them in, and the same discipline the programme blockers
 * follow.
 */
export function checkAssignment(
  world: InmateWorld,
  data: GameData,
  inmateId: number,
  assignment: LabourAssignment,
): AssignCheck {
  const balance = data.balance.labour

  if (!hasFeature(data, world.directorate, 'inmate_labour')) {
    return { ok: false, reason: 'feature-locked', detail: { featureId: 'inmate_labour' } }
  }

  const extraFeature = balance.featureByAssignment[assignment]
  if (extraFeature !== undefined && !hasFeature(data, world.directorate, extraFeature)) {
    return { ok: false, reason: 'feature-locked', detail: { featureId: extraFeature } }
  }

  const programmeId = balance.prerequisites[assignment]
  if (programmeId !== undefined && !world.programs.hasCompleted(inmateId, programmeId)) {
    return { ok: false, reason: 'missing-programme', detail: { programId: programmeId } }
  }

  const rooms = functionalRooms(world, LABOUR_ROOMS[assignment])
  if (rooms.length === 0) {
    return { ok: false, reason: 'no-room', detail: { roomId: LABOUR_ROOMS[assignment] } }
  }

  const capacity = slotsFor(world, data, rooms, assignment)
  const taken = world.labour.assignedTo(assignment).filter((id) => id !== inmateId).length
  if (taken >= capacity) {
    return { ok: false, reason: 'no-free-slot', detail: { capacity, taken } }
  }

  return { ok: true }
}

/** Seats available for an assignment, from the room's `jobSlots`. */
export function slotsFor(
  world: InmateWorld,
  data: GameData,
  rooms: readonly Room[],
  assignment: LabourAssignment,
): number {
  const def = data.rooms.find(LABOUR_ROOMS[assignment])
  const slots = def?.jobSlots
  if (slots === undefined) return 0
  let capacity = 0
  for (const room of rooms) {
    capacity += world.objects.objectCount(room.id, slots.objectId) * slots.slotsPerObject
  }
  return capacity
}

function functionalRooms(world: InmateWorld, roomDefId: string): Room[] {
  return world.rooms
    .all()
    .filter(
      (room) =>
        room.defId === roomDefId && world.rooms.statusOf(room.id)?.functional === true,
    )
}

/** Puts an inmate on a job, or reports why not. */
export function assignLabour(
  world: InmateWorld,
  data: GameData,
  events: EventSink,
  tick: number,
  inmateId: number,
  assignment: LabourAssignment,
): boolean {
  const entity = world.inmates.get(inmateId)
  if (entity === undefined) {
    reject(events, tick, 'unknown-inmate', { inmateId })
    return false
  }

  const check = checkAssignment(world, data, inmateId, assignment)
  if (!check.ok) {
    reject(events, tick, check.reason ?? 'no-free-slot', {
      inmateId,
      assignment,
      ...(check.detail ?? {}),
    })
    return false
  }

  world.labour.assignments.set(inmateId, assignment)
  entity.inmate.jobId = assignment
  events.emit({
    tick,
    kind: LABOUR_EVENTS.assigned,
    subjectId: inmateId,
    causeIds: [],
    data: { assignment },
  })
  return true
}

export function unassignLabour(
  world: InmateWorld,
  events: EventSink,
  tick: number,
  inmateId: number,
): void {
  const assignment = world.labour.assignments.get(inmateId)
  if (assignment === undefined) return
  world.labour.assignments.delete(inmateId)
  const entity = world.inmates.get(inmateId)
  if (entity !== undefined) entity.inmate.jobId = null
  events.emit({
    tick,
    kind: LABOUR_EVENTS.unassigned,
    subjectId: inmateId,
    causeIds: [],
    data: { assignment },
  })
}

/* -------------------------------------------------------------------------- */
/* Who is actually working                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Assigned inmates who are in a work block *and* standing in the right room.
 *
 * Both halves matter. The Routine decides when work happens, and the room
 * decides whether it can — an inmate assigned to the workshop and locked in
 * their cell is producing nothing, and the throughput number has to say so.
 */
export function workersPresent(
  world: InmateWorld,
  assignment: LabourAssignment,
  roomId: number,
): InmateEntity[] {
  const workers: InmateEntity[] = []
  for (const inmateId of world.labour.assignedTo(assignment)) {
    const entity = world.inmates.get(inmateId)
    if (entity === undefined) continue
    if (!isInmateInWorkBlock(world, entity.id)) continue
    const tile = world.grid.idx(entity.tx, entity.ty)
    if (world.grid.getAt('roomId', tile) !== roomId) continue
    workers.push(entity)
  }
  return workers
}

/* -------------------------------------------------------------------------- */
/* Workshop                                                                    */
/* -------------------------------------------------------------------------- */

type ProductionLine = Balance['labour']['workshop']['basic']

/**
 * Which product line the workshop is running.
 *
 * The high-value line needs someone in the room who has finished Joinery, so
 * the upgrade is a *training* decision rather than a toggle: the player who
 * put people through the apprenticeship gets the better chair.
 */
export function activeProductionLine(
  world: InmateWorld,
  data: GameData,
  workers: readonly InmateEntity[],
): ProductionLine {
  const { basic, fine } = data.balance.labour.workshop
  const required = fine.requiresProductionId
  if (required === undefined) return basic
  for (const worker of workers) {
    if (world.programs.unlockedProduction.get(worker.id)?.has(required) === true) return fine
  }
  return basic
}

/**
 * One minute of workshop production.
 *
 * Worker-minutes accumulate against the line's requirement; when the bar is
 * cleared the raw material is consumed and a finished unit lands on the
 * dispatch dock. Running out of timber stops the line rather than producing
 * from nothing.
 */
export function advanceWorkshop(
  world: InmateWorld,
  data: GameData,
  events: EventSink,
  tick: number,
  minutes: number,
): number {
  let produced = 0

  for (const room of functionalRooms(world, LABOUR_ROOMS.workshop)) {
    const workers = workersPresent(world, 'workshop', room.id)
    if (workers.length === 0) continue

    const line = activeProductionLine(world, data, workers)
    const key = `${room.id}:${line.productId}`
    const accrued = (world.labour.workerMinutes.get(key) ?? 0) + workers.length * minutes

    let remaining = accrued
    let made = 0
    while (remaining >= line.workerMinutesPerUnit) {
      if (!consumeInput(world, line)) break
      remaining -= line.workerMinutesPerUnit
      made += 1
    }
    world.labour.workerMinutes.set(key, remaining)
    if (made === 0) continue

    world.labour.finishedGoods.set(
      line.productId,
      (world.labour.finishedGoods.get(line.productId) ?? 0) + made,
    )
    produced += made
    events.emit({
      tick,
      kind: LABOUR_EVENTS.produced,
      subjectId: room.id,
      causeIds: [],
      data: {
        roomId: room.id,
        productId: line.productId,
        units: made,
        workers: workers.length,
      },
    })
  }

  return produced
}

/** Takes the raw material a unit needs, from stored supply or felled timber. */
function consumeInput(world: InmateWorld, line: ProductionLine): boolean {
  const available = world.supply.storeStock.get(line.inputItemId) ?? 0
  if (available < line.inputUnits) return false
  world.supply.storeStock.set(line.inputItemId, available - line.inputUnits)
  return true
}

/**
 * Sells whatever is on the dispatch dock when a truck calls.
 *
 * Riding the existing delivery cadence rather than inventing a second one:
 * the same trucks that bring materials in take goods out, which is what makes
 * a dock a bottleneck worth building around.
 */
export function dispatchGoods(
  world: InmateWorld,
  data: GameData,
  events: EventSink,
  tick: number,
): number {
  if (world.labour.finishedGoods.size === 0) return 0

  const { basic, fine } = data.balance.labour.workshop
  const priceOf = (productId: string): number =>
    productId === fine.productId ? fine.salePrice : basic.salePrice

  let income = 0
  const sold: { productId: string; units: number }[] = []
  for (const [productId, units] of [...world.labour.finishedGoods.entries()].sort(([a], [b]) =>
    a < b ? -1 : 1,
  )) {
    if (units <= 0) continue
    income += units * priceOf(productId)
    sold.push({ productId, units })
  }
  if (income <= 0) return 0

  world.labour.finishedGoods.clear()
  world.labour.lifetimeExportIncome += income
  world.economy.credit(tick, 'export', income, 'Workshop dispatch', 0)
  events.emit({
    tick,
    kind: LABOUR_EVENTS.dispatched,
    causeIds: [],
    data: { income, lines: sold as unknown as JsonValue },
  })
  return income
}

/* -------------------------------------------------------------------------- */
/* Grove                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Trees grow on their own; felling them takes a person.
 *
 * That asymmetry is the whole design: a grove with no assigned inmates fills
 * up with standing timber the prison cannot use, which is a visible reason to
 * assign someone rather than an invisible penalty.
 */
export function advanceGrove(
  world: InmateWorld,
  data: GameData,
  events: EventSink,
  tick: number,
  minutes: number,
): number {
  const cfg = data.balance.labour.grove
  let felled = 0

  for (const room of functionalRooms(world, LABOUR_ROOMS.grove)) {
    const beds = world.objects.objectCount(room.id, 'sapling_bed')
    if (beds === 0) continue

    // Growth: one bed's worth of minutes per bed, per minute.
    const grown = (world.labour.groveMinutes.get(room.id) ?? 0) + beds * minutes
    const newTrees = Math.floor(grown / cfg.treeGrowthMinutes)
    world.labour.groveMinutes.set(room.id, grown - newTrees * cfg.treeGrowthMinutes)
    if (newTrees > 0) {
      world.labour.grownTrees.set(room.id, (world.labour.grownTrees.get(room.id) ?? 0) + newTrees)
    }

    // Felling: worker-minutes against standing trees.
    const standing = world.labour.grownTrees.get(room.id) ?? 0
    if (standing === 0) continue
    const workers = workersPresent(world, 'grove', room.id)
    if (workers.length === 0) continue

    const key = `${room.id}:fell`
    const accrued = (world.labour.workerMinutes.get(key) ?? 0) + workers.length * minutes
    const cut = Math.min(standing, Math.floor(accrued / cfg.fellWorkerMinutes))
    world.labour.workerMinutes.set(key, accrued - cut * cfg.fellWorkerMinutes)
    if (cut === 0) continue

    world.labour.grownTrees.set(room.id, standing - cut)
    const timber = cut * cfg.timberPerTree
    world.supply.storeStock.set(
      'timber',
      (world.supply.storeStock.get('timber') ?? 0) + timber,
    )
    felled += cut
    events.emit({
      tick,
      kind: LABOUR_EVENTS.treeFelled,
      subjectId: room.id,
      causeIds: [],
      data: { roomId: room.id, trees: cut, timber, workers: workers.length },
    })
  }

  return felled
}

/* -------------------------------------------------------------------------- */
/* Commissary                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Inmates spend their own money on luxuries, which is revenue and relief at
 * once.
 *
 * The prison buys the stock and sells it on, so a commissary is only worth
 * running where inmates have money — which they get from working, which is the
 * loop closing.
 */
export function runCommissary(
  world: InmateWorld,
  data: GameData,
  events: EventSink,
  rng: RngStream,
  needIndex: NeedIndex,
  tick: number,
): number {
  const cfg = data.balance.labour.commissary
  const rooms = functionalRooms(world, LABOUR_ROOMS.commissary)
  if (rooms.length === 0) return 0

  const roomIds = new Set(rooms.map((room) => room.id))
  const luxuryIndex = needIndex.indexOf('luxury')
  let revenue = 0

  for (const entity of world.inmates.all()) {
    const tile = world.grid.idx(entity.tx, entity.ty)
    const roomId = world.grid.getAt('roomId', tile)
    if (roomId === NO_ROOM || !roomIds.has(roomId)) continue
    if (entity.inmate.money < cfg.spendPerVisit) continue

    // Always draw, so who happens to be standing where cannot shift the stream.
    if (!rng.chance(cfg.visitChancePerHour)) continue
    if (world.labour.commissaryGoods <= 0) continue

    entity.inmate.money -= cfg.spendPerVisit
    world.labour.commissaryGoods -= 1
    revenue += cfg.spendPerVisit
    if (luxuryIndex >= 0) {
      entity.inmate.needs[luxuryIndex] = clampNeed(
        (entity.inmate.needs[luxuryIndex] ?? 0) - cfg.luxuryRelief,
      )
    }
    events.emit({
      tick,
      kind: LABOUR_EVENTS.commissarySale,
      subjectId: entity.id,
      causeIds: [],
      data: { roomId, spend: cfg.spendPerVisit, stockLeft: world.labour.commissaryGoods },
    })
  }

  if (revenue > 0) {
    world.labour.lifetimeCommissaryIncome += revenue
    world.economy.credit(tick, 'commissary', revenue, 'Commissary sales', 0)
  }
  return revenue
}

/** Buys commissary stock when the shelves run dry. */
export function restockCommissary(
  world: InmateWorld,
  data: GameData,
  tick: number,
): number {
  const cfg = data.balance.labour.commissary
  if (world.labour.commissaryGoods > 0) return 0
  if (functionalRooms(world, LABOUR_ROOMS.commissary).length === 0) return 0

  const cost = cfg.restockUnitCost * cfg.goodsPerRestock
  if (world.economy.balance < cost) return 0

  world.economy.debit(tick, 'commissary', cost, 'Commissary restock', 0)
  world.labour.commissaryGoods += cfg.goodsPerRestock
  return cfg.goodsPerRestock
}

/* -------------------------------------------------------------------------- */
/* What working does to the worker                                             */
/* -------------------------------------------------------------------------- */

/**
 * Work discharges `freedom` and feeds the reform grade.
 *
 * Small per minute and cumulative over a shift, which is why an assigned
 * inmate drifts toward lower misconduct rather than snapping to it — the
 * effect should be something the player notices over days, not seconds.
 */
export function applyWorkEffects(
  world: InmateWorld,
  data: GameData,
  needIndex: NeedIndex,
  minutes: number,
): number {
  const freedomIndex = needIndex.indexOf('freedom')
  const reliefPerMinute = data.balance.labour.freedomReliefPerHour / 60
  let working = 0

  for (const [inmateId, assignment] of [...world.labour.assignments.entries()].sort(
    (a, b) => a[0] - b[0],
  )) {
    const entity = world.inmates.get(inmateId)
    if (entity === undefined) continue
    if (!isInmateInWorkBlock(world, entity.id)) continue

    const roomDefId = LABOUR_ROOMS[assignment]
    const tile = world.grid.idx(entity.tx, entity.ty)
    const room = world.rooms.get(world.grid.getAt('roomId', tile))
    if (room === undefined || room.defId !== roomDefId) continue

    working += 1
    if (freedomIndex >= 0) {
      entity.inmate.needs[freedomIndex] = clampNeed(
        (entity.inmate.needs[freedomIndex] ?? 0) - reliefPerMinute * minutes,
      )
    }
    creditLabourHours(world, inmateId, minutes / 60)
  }

  return working
}

/* -------------------------------------------------------------------------- */
/* The pass                                                                    */
/* -------------------------------------------------------------------------- */

export interface LabourSystemOptions {
  readonly data: GameData
}

export function createLabourSystem(options: LabourSystemOptions): System {
  const { data } = options
  const needIndex = NeedIndex.fromData(data)
  const truckIntervalTicks =
    data.balance.logistics.truckIntervalHours * TICKS_PER_HOUR
  let reportedWrongWorld = false

  return {
    name: LABOUR_SYSTEM_NAME,
    period: LABOUR_SYSTEM_PERIOD,

    update(context: SystemContext): void {
      const world = context.world
      const tick = context.clock.tick

      if (!isInmateWorld(world)) {
        if (reportedWrongWorld) return
        reportedWrongWorld = true
        reject(context.events, tick, 'wrong-world', {})
        return
      }

      const minutes = 1
      applyWorkEffects(world, data, needIndex, minutes)
      advanceGrove(world, data, context.events, tick, minutes)
      advanceWorkshop(world, data, context.events, tick, minutes)

      if (tick % truckIntervalTicks === 0) {
        dispatchGoods(world, data, context.events, tick)
      }

      if (tick % TICKS_PER_HOUR === 0) {
        restockCommissary(world, data, tick)
        runCommissary(
          world,
          data,
          context.events,
          context.rng.stream(LABOUR_RNG_STREAM),
          needIndex,
          tick,
        )
      }
    },
  }
}

/* -------------------------------------------------------------------------- */
/* Commands                                                                    */
/* -------------------------------------------------------------------------- */

export const LABOUR_COMMANDS = {
  assign: 'labour.assign',
  unassign: 'labour.unassign',
} as const

export function labourCommandHandlers(
  data: GameData,
): Readonly<Record<string, CommandHandler>> {
  return {
    [LABOUR_COMMANDS.assign]: (command, context) => {
      handleAssign(command, context, data)
    },
    [LABOUR_COMMANDS.unassign]: (command, context) => {
      const world = context.world
      if (!isInmateWorld(world)) return
      const inmateId = readInt(command.payload, 'inmateId')
      if (inmateId === undefined) return
      unassignLabour(world, context.events, context.clock.tick, inmateId)
    },
  }
}

function handleAssign(command: Command, context: SystemContext, data: GameData): void {
  const world = context.world
  const tick = context.clock.tick
  if (!isInmateWorld(world)) {
    reject(context.events, tick, 'wrong-world', {})
    return
  }

  const inmateId = readInt(command.payload, 'inmateId')
  const assignment = readString(command.payload, 'assignment')
  if (inmateId === undefined || assignment === undefined) {
    reject(context.events, tick, 'invalid-payload', {})
    return
  }
  if (!isLabourAssignment(assignment)) {
    reject(context.events, tick, 'unknown-assignment', { assignment })
    return
  }

  assignLabour(world, data, context.events, tick, inmateId, assignment)
}

function reject(
  events: EventSink,
  tick: number,
  reason: LabourRejection,
  detail: JsonObject,
): void {
  events.emit({
    tick,
    kind: LABOUR_EVENTS.rejected,
    causeIds: [],
    data: { reason, ...detail },
  })
}

function readInt(payload: JsonValue, key: string): number | undefined {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return undefined
  const value = (payload as JsonObject)[key]
  return typeof value === 'number' && Number.isInteger(value) ? value : undefined
}

function readString(payload: JsonValue, key: string): string | undefined {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return undefined
  const value = (payload as JsonObject)[key]
  return typeof value === 'string' ? value : undefined
}
