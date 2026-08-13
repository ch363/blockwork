/**
 * `GradingSystem`: room grades, the entitlement ladder, and the hourly
 * reassignment that connects them (T5.2, PRD 5.2).
 *
 * This is the game's reward loop. An inmate who behaves earns entitlement; a
 * cell that has been furnished earns a grade; once an hour the two are matched
 * and the escorts that follow are the player watching their investment move
 * people around. Build one luxurious block and one bare one and the population
 * sorts itself over a few days without the player touching an assignment.
 *
 * Two decisions shape the code.
 *
 * **A grade is a breakdown, not a number.** `gradeRoom` returns every line that
 * contributed — which object, how many were found, how many the occupancy
 * needed, what it was worth — because the cell inspector's job is to answer
 * "why is this a 4?" and a bare integer cannot. The score is the sum of the
 * lines, so the two can never drift.
 *
 * **Reassignment is bounded and ordered.** Sorting by entitlement descending
 * (ties by id) makes the pass deterministic and gives the best-behaved inmate
 * first refusal on the best free cell, which is the ladder the player is being
 * sold. `maxEscortsPerPass` stops a newly-finished cell block from queuing two
 * hundred escorts in one tick.
 *
 * Slot: PRD 4.4 #17, hourly, after Economy — the last thing that happens in an
 * hour is that the prison re-reads itself.
 */

import { TICKS_PER_DAY, TICKS_PER_HOUR } from '../core/clock'
import type { EventSink, System, SystemContext } from '../core/simulation'
import type { Fnv1aHasher } from '../core/hash'
import type { GameData } from '../data/loader'
import type { Balance, GradingRuleSet, ReassignmentStrictness, RoomDef } from '../data/schemas'
import { NO_INMATE } from '../entities/inmate'
import type { InmateEntity } from '../entities/inmate'
import { enqueueEscort } from '../entities/staff'
import { inmateAccessMask } from '../pathfinding/regionGraph'
import { NO_ROOM } from '../world/rooms'
import type { Room } from '../world/rooms'

import { isInmateWorld } from './intakeSystem'
import type { InmateWorld } from './intakeSystem'

/* -------------------------------------------------------------------------- */
/* Identity                                                                    */
/* -------------------------------------------------------------------------- */

export const GRADING_SYSTEM_NAME = 'grading'

/** PRD 4.4: grading is hourly. The evaluation cadence itself is data. */
export const GRADING_SYSTEM_PERIOD = TICKS_PER_HOUR

export const GRADING_EVENTS = {
  roomGraded: 'grading.roomGraded',
  entitlementGained: 'grading.entitlementGained',
  reassigned: 'grading.reassigned',
  rejected: 'grading.rejected',
} as const

/** Housing room kinds the reassignment pass may move an inmate between. */
export const HOUSING_ROOM_DEFS = ['cell', 'dormitory'] as const

/* -------------------------------------------------------------------------- */
/* Grade breakdown                                                             */
/* -------------------------------------------------------------------------- */

export const GRADE_RULE_KINDS = ['object', 'size', 'window', 'material', 'custom'] as const
export type GradeRuleKind = (typeof GRADE_RULE_KINDS)[number]

/**
 * One contribution to a room's grade, in the shape the inspector renders.
 *
 * `found` / `needed` are what turn "Beds +1" into "Comfort beds 2 of 3 needed
 * for 9 occupants", which is the difference between a score and an
 * explanation.
 */
export interface GradeLine {
  readonly rule: GradeRuleKind
  /** Object id, material id, custom rule id, or `'size'` / `'window'`. */
  readonly subject: string
  readonly points: number
  readonly found: number
  /** Occupancy- or count-derived requirement, or 0 when the rule has none. */
  readonly needed: number
}

export interface RoomGrade {
  readonly roomId: number
  readonly defId: string
  /** Clamped to the rule set's `[min, max]`. This is the published grade. */
  readonly score: number
  /** Before clamping, so the inspector can say "capped at 10". */
  readonly rawScore: number
  readonly min: number
  readonly max: number
  readonly occupants: number
  readonly lines: readonly GradeLine[]
}

/**
 * Scores one room against its rule set, line by line.
 *
 * Pure over the world: it reads objects, tiles and materials but writes
 * nothing, so the inspector can call it on demand and the system can call it
 * hourly without the two disagreeing.
 */
export function gradeRoom(
  world: InmateWorld,
  data: GameData,
  room: Room,
  def: RoomDef,
): RoomGrade | undefined {
  if (!def.graded || def.gradingRules === undefined) return undefined
  const rules = def.gradingRules
  const occupants = world.contents().occupants(room.id)
  const lines: GradeLine[] = []

  scoreObjects(world, room, rules, occupants, lines)
  scoreSize(room, rules, lines)
  scoreWindows(world, data, room, rules, occupants, lines)
  scoreMaterials(world, room, rules, lines)
  scoreCustom(world, data, room, rules, lines)

  let rawScore = 0
  for (const line of lines) rawScore += line.points

  const score = rawScore < rules.min ? rules.min : rawScore > rules.max ? rules.max : rawScore
  return {
    roomId: room.id,
    defId: def.id,
    score,
    rawScore,
    min: rules.min,
    max: rules.max,
    occupants,
    lines,
  }
}

function scoreObjects(
  world: InmateWorld,
  room: Room,
  rules: GradingRuleSet,
  occupants: number,
  lines: GradeLine[],
): void {
  for (const entry of rules.objectPoints) {
    let found = 0
    for (const objectId of entry.objectIds) {
      found += world.objects.objectCount(room.id, objectId)
    }
    const subject = entry.objectIds.join('/')

    if (entry.perCount !== undefined) {
      const steps = Math.floor(found / entry.perCount)
      if (steps === 0) continue
      lines.push({
        rule: 'object',
        subject,
        points: steps * entry.points,
        found,
        needed: entry.perCount,
      })
      continue
    }

    if (entry.perOccupants !== undefined) {
      // One per N heads, and an empty room still needs one: a cell with no
      // occupant is graded on what it offers the occupant it will get.
      const needed = Math.max(1, Math.ceil(occupants / entry.perOccupants))
      if (found < needed) continue
      lines.push({ rule: 'object', subject, points: entry.points, found, needed })
      continue
    }

    if (found <= 0) continue
    lines.push({ rule: 'object', subject, points: entry.points, found, needed: 1 })
  }
}

function scoreSize(room: Room, rules: GradingRuleSet, lines: GradeLine[]): void {
  // Thresholds are a ladder, not a sum: the room scores the best one it clears,
  // and a set that opens with a negative (the yard's "too small" rung) still
  // applies when nothing better is met.
  let best: { readonly tiles: number; readonly points: number } | undefined
  for (const threshold of rules.sizeThresholds) {
    if (room.tiles.length < threshold.tiles) continue
    if (best === undefined || threshold.tiles > best.tiles) best = threshold
  }
  if (best === undefined) return
  lines.push({
    rule: 'size',
    subject: 'size',
    points: best.points,
    found: room.tiles.length,
    needed: best.tiles,
  })
}

/**
 * Windows: an outdoor-facing one is a bonus, none at all is a penalty.
 *
 * "Outdoor facing" is checked rather than assumed — a window in an internal
 * partition looks out onto a corridor, and PRD 5.2 pays for daylight, not for
 * glass. A wall object sits *in* the wall, so the test is whether either tile
 * the wall separates is under the sky.
 */
function scoreWindows(
  world: InmateWorld,
  data: GameData,
  room: Room,
  rules: GradingRuleSet,
  occupants: number,
  lines: GradeLine[],
): void {
  const rule = rules.windowRule
  if (rule === undefined) return

  const windowId = data.balance.grading.windowObjectId
  const total = world.objects.objectCount(room.id, windowId)
  const outdoorFacing = countOutdoorFacingWindows(world, room, windowId)

  if (total === 0) {
    if (rule.nonePenalty === 0) return
    lines.push({ rule: 'window', subject: 'window', points: rule.nonePenalty, found: 0, needed: 1 })
    return
  }

  const needed =
    rule.perOccupants === undefined ? 1 : Math.max(1, Math.ceil(occupants / rule.perOccupants))
  if (outdoorFacing < needed) return
  lines.push({
    rule: 'window',
    subject: 'window',
    points: rule.outdoorFacingBonus,
    found: outdoorFacing,
    needed,
  })
}

function countOutdoorFacingWindows(world: InmateWorld, room: Room, windowId: string): number {
  const size = world.grid.size
  const roomTiles = new Set(room.tiles)
  let count = 0

  for (const entity of world.objects.all()) {
    if (entity.object.defId !== windowId) continue
    let inRoom = false
    for (const tile of entity.object.tiles) {
      if (roomTiles.has(tile)) inRoom = true
    }
    // A wall object's own tile is the wall; the room claims it only when the
    // registry assigned it, so fall back to adjacency for wall-line windows.
    const anchor = entity.object.tiles[0]
    if (anchor === undefined) continue
    if (!inRoom && !touchesRoom(anchor, roomTiles, size)) continue
    if (anyNeighbourOutdoors(world, anchor, size)) count += 1
  }
  return count
}

function touchesRoom(tile: number, roomTiles: ReadonlySet<number>, size: number): boolean {
  const x = tile % size
  const y = (tile / size) | 0
  for (const [dx, dy] of NEIGHBOURS) {
    const nx = x + dx
    const ny = y + dy
    if (nx < 0 || ny < 0 || nx >= size || ny >= size) continue
    if (roomTiles.has(ny * size + nx)) return true
  }
  return false
}

function anyNeighbourOutdoors(world: InmateWorld, tile: number, size: number): boolean {
  const x = tile % size
  const y = (tile / size) | 0
  for (const [dx, dy] of NEIGHBOURS) {
    const nx = x + dx
    const ny = y + dy
    if (nx < 0 || ny < 0 || nx >= size || ny >= size) continue
    if ((world.grid.outdoors[ny * size + nx] ?? 0) !== 0) return true
  }
  return false
}

const NEIGHBOURS: readonly (readonly [number, number])[] = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
]

function scoreMaterials(
  world: InmateWorld,
  room: Room,
  rules: GradingRuleSet,
  lines: GradeLine[],
): void {
  const penalties = rules.materialPenalties
  if (penalties === undefined) return

  for (const entry of penalties) {
    let found = 0
    for (const materialId of entry.materialIds) {
      const index = world.materials.indexOf(materialId)
      if (index < 0) continue
      for (const tile of room.tiles) {
        if (world.grid.getAt('floorMaterial', tile) === index) found += 1
        if (world.grid.getAt('wallMaterial', tile) === index) found += 1
      }
    }
    if (found === 0) continue
    lines.push({
      rule: 'material',
      subject: entry.materialIds.join('/'),
      points: entry.points,
      found,
      needed: 1,
    })
  }
}

/**
 * The named rules `rooms.json` defers to code.
 *
 * They exist because some of what makes a room good is not in the room: the
 * mess hall's grade depends on the meal policy, and a yard's on whether you
 * can actually run a lap of it.
 */
function scoreCustom(
  world: InmateWorld,
  data: GameData,
  room: Room,
  rules: GradingRuleSet,
  lines: GradeLine[],
): void {
  const custom = rules.custom
  if (custom === undefined) return
  const cfg = data.balance.grading.custom

  for (const ruleId of custom) {
    switch (ruleId) {
      case 'meal_quality': {
        const quantity = world.standingOrders.mealQuantity
        const points = cfg.mealQualityPoints[quantity] ?? 0
        if (points === 0) break
        lines.push({ rule: 'custom', subject: ruleId, points, found: 0, needed: 0 })
        break
      }
      case 'meal_variety': {
        const variety = world.standingOrders.mealVariety
        const steps = Math.floor(Math.max(0, variety - 1) / cfg.mealVarietyIngredientsPerPoint)
        const points = Math.min(steps, cfg.mealVarietyMaxPoints)
        if (points === 0) break
        lines.push({
          rule: 'custom',
          subject: ruleId,
          points,
          found: variety,
          needed: cfg.mealVarietyIngredientsPerPoint,
        })
        break
      }
      case 'running_track_length': {
        const perimeter = roomPerimeterTiles(room)
        if (perimeter < cfg.runningTrackMinPerimeterTiles) break
        lines.push({
          rule: 'custom',
          subject: ruleId,
          points: cfg.runningTrackPoints,
          found: perimeter,
          needed: cfg.runningTrackMinPerimeterTiles,
        })
        break
      }
      default:
        // An unknown custom id scores nothing. The loader is what should have
        // caught it; silently scoring it would be worse than scoring zero.
        break
    }
  }
}

/** Tiles around the room's bounding box — how far a lap of the yard is. */
function roomPerimeterTiles(room: Room): number {
  const { width, height } = room.bounds
  if (width <= 0 || height <= 0) return 0
  return 2 * (width + height) - 4
}

/* -------------------------------------------------------------------------- */
/* Runtime state                                                               */
/* -------------------------------------------------------------------------- */

export interface GradingSnapshot {
  readonly roomGrades: readonly { readonly roomId: number; readonly score: number }[]
  readonly lastEntitlementTick: readonly {
    readonly inmateId: number
    readonly tick: number
  }[]
  readonly averageCellGrade: number
}

/**
 * What grading remembers between passes.
 *
 * The breakdowns are not saved: they are derived from the world and are
 * recomputed on the next hourly pass, and a save that carried them would be a
 * save that could disagree with the prison it describes. The entitlement
 * clocks *are* saved, because "when did this inmate last earn a point" is
 * history, not derivation.
 */
export class GradingRuntime {
  /** Latest full breakdown per room, for the inspector. Rebuilt hourly. */
  readonly breakdowns = new Map<number, RoomGrade>()
  /** Mean grade of the graded rooms in each sector. */
  readonly sectorGrades = new Map<number, number>()
  /** Tick each inmate last gained an entitlement point. */
  readonly lastEntitlementTick = new Map<number, number>()

  clearInmate(inmateId: number): void {
    this.lastEntitlementTick.delete(inmateId)
  }

  serialise(): GradingSnapshot {
    return {
      roomGrades: [...this.breakdowns.values()]
        .sort((a, b) => a.roomId - b.roomId)
        .map((grade) => ({ roomId: grade.roomId, score: grade.score })),
      lastEntitlementTick: [...this.lastEntitlementTick.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([inmateId, tick]) => ({ inmateId, tick })),
      averageCellGrade: 0,
    }
  }

  restore(snapshot: GradingSnapshot): void {
    this.lastEntitlementTick.clear()
    for (const entry of snapshot.lastEntitlementTick) {
      this.lastEntitlementTick.set(entry.inmateId, entry.tick)
    }
    // Breakdowns and sector grades stay empty: the next hourly pass rebuilds
    // them from the world, which is the only source that cannot be stale.
    this.breakdowns.clear()
    this.sectorGrades.clear()
  }

  hashInto(hasher: Fnv1aHasher): void {
    const clocks = [...this.lastEntitlementTick.entries()].sort((a, b) => a[0] - b[0])
    hasher.writeUint32(clocks.length)
    for (const [inmateId, tick] of clocks) {
      hasher.writeUint32(inmateId)
      hasher.writeUint32(tick)
    }
  }
}

/* -------------------------------------------------------------------------- */
/* The hourly pass                                                             */
/* -------------------------------------------------------------------------- */

export interface GradingSystemOptions {
  readonly data: GameData
}

export function createGradingSystem(options: GradingSystemOptions): System {
  const { data } = options
  let reportedWrongWorld = false

  return {
    name: GRADING_SYSTEM_NAME,
    period: GRADING_SYSTEM_PERIOD,

    update(context: SystemContext): void {
      const world = context.world
      const tick = context.clock.tick

      if (!isInmateWorld(world)) {
        if (reportedWrongWorld) return
        reportedWrongWorld = true
        context.events.emit({
          tick,
          kind: GRADING_EVENTS.rejected,
          causeIds: [],
          data: { reason: 'wrong-world' },
        })
        return
      }

      const hours = data.balance.grading.evaluationHours
      if (hours > 1 && tick % (hours * TICKS_PER_HOUR) !== 0) return

      regradeRooms(world, data)
      accrueEntitlement(world, data, context.events, tick)
      reassignHousing(world, data, context.events, tick)
    },
  }
}

/**
 * Re-scores every graded room and republishes the numbers other systems read.
 *
 * `cellGrades` and `averageCellGrade` are the misconduct system's inputs
 * (T4.4), which is why this runs before anything that could act on them.
 */
export function regradeRooms(world: InmateWorld, data: GameData): void {
  world.grading.breakdowns.clear()
  world.cellGrades.clear()

  let housingTotal = 0
  let housingCount = 0

  for (const room of world.rooms.all()) {
    const def = data.rooms.find(room.defId)
    if (def === undefined) continue
    const grade = gradeRoom(world, data, room, def)
    if (grade === undefined) continue

    world.grading.breakdowns.set(room.id, grade)
    if (isHousingRoom(room.defId)) {
      world.cellGrades.set(room.id, grade.score)
      housingTotal += grade.score
      housingCount += 1
    }
  }

  if (housingCount > 0) world.averageCellGrade = housingTotal / housingCount

  regradeSectors(world, data)
}

/** Sector grade: the mean of the graded rooms whose tiles sit in it. */
export function regradeSectors(world: InmateWorld, data: GameData): void {
  world.grading.sectorGrades.clear()
  const totals = new Map<number, { sum: number; count: number }>()

  for (const grade of world.grading.breakdowns.values()) {
    const room = world.rooms.get(grade.roomId)
    if (room === undefined) continue
    const anchor = room.tiles[0]
    if (anchor === undefined) continue
    const sectorId = world.grid.sectorId[anchor] ?? 0
    if (sectorId === 0) continue
    const entry = totals.get(sectorId) ?? { sum: 0, count: 0 }
    entry.sum += grade.score
    entry.count += 1
    totals.set(sectorId, entry)
  }

  for (const sector of world.sectors.all()) {
    const entry = totals.get(sector.id)
    world.grading.sectorGrades.set(
      sector.id,
      entry === undefined || entry.count === 0
        ? data.balance.grading.defaultSectorGrade
        : entry.sum / entry.count,
    )
  }
}

/**
 * The accrual half of the entitlement ladder.
 *
 * The penalty half lives in `misconductSystem`, where the misconduct that
 * causes it is known. Here we only add: a full day since the last misconduct
 * *and* a full day since the last point, capped at the ladder's top.
 */
export function accrueEntitlement(
  world: InmateWorld,
  data: GameData,
  events: EventSink,
  tick: number,
): void {
  const { max, perCleanDay } = data.balance.entitlement

  for (const entity of world.inmates.all()) {
    const inmate = entity.inmate
    if (inmate.entitlement >= max) continue

    const lastMisconduct = lastMisconductTick(entity)
    if (tick - lastMisconduct < TICKS_PER_DAY) continue

    const lastGrant = world.grading.lastEntitlementTick.get(entity.id) ?? 0
    if (tick - lastGrant < TICKS_PER_DAY) continue

    inmate.entitlement = Math.min(max, inmate.entitlement + perCleanDay)
    world.grading.lastEntitlementTick.set(entity.id, tick)
    events.emit({
      tick,
      kind: GRADING_EVENTS.entitlementGained,
      subjectId: entity.id,
      causeIds: [],
      data: {
        entitlement: inmate.entitlement,
        cleanDays: Math.floor((tick - lastMisconduct) / TICKS_PER_DAY),
      },
    })
  }
}

function lastMisconductTick(entity: InmateEntity): number {
  const log = entity.inmate.misconductLog
  const last = log[log.length - 1]
  return last === undefined ? 0 : last.tick
}

/* -------------------------------------------------------------------------- */
/* Reassignment                                                                */
/* -------------------------------------------------------------------------- */

/** Whether a cell of `grade` is an acceptable home for `entitlement`. */
export function entitlementMatches(
  strictness: ReassignmentStrictness,
  entitlement: number,
  grade: number,
  balance: Balance['grading'],
): boolean {
  switch (strictness) {
    case 'off':
      return true
    case 'strict':
      return grade === entitlement
    case 'lenient':
      return Math.abs(grade - entitlement) <= balance.reassignment.lenientTolerance
  }
}

export function isHousingRoom(defId: string): boolean {
  return (HOUSING_ROOM_DEFS as readonly string[]).includes(defId)
}

interface HousingCandidate {
  readonly roomId: number
  readonly defId: string
  readonly grade: number
  readonly capacity: number
  occupied: number
  readonly accessMask: number
  readonly tile: number
}

/**
 * Matches entitlement to grade once an hour, best-behaved inmate first.
 *
 * The inmate is not teleported: a match queues an escort, and the escort is
 * what actually moves them. That is the whole point of PRD 5.13's "every hop
 * is a real agent" — a reassignment the prison has no officer to carry out
 * simply does not happen, and the player can see why.
 */
export function reassignHousing(
  world: InmateWorld,
  data: GameData,
  events: EventSink,
  tick: number,
): number {
  const strictness = world.standingOrders.reassignmentStrictness
  if (strictness === 'off') return 0

  const candidates = housingCandidates(world)
  if (candidates.length === 0) return 0

  // Best-behaved first, ties by id so two runs agree.
  const inmates = world.inmates.all().sort((a, b) => {
    const delta = b.inmate.entitlement - a.inmate.entitlement
    return delta !== 0 ? delta : a.id - b.id
  })

  const budget = data.balance.grading.reassignment.maxEscortsPerPass
  let queued = 0

  for (const entity of inmates) {
    if (queued >= budget) break
    if (entity.id === NO_INMATE) continue

    const current = candidates.find((entry) => entry.roomId === entity.inmate.cellId)
    if (
      current !== undefined &&
      entitlementMatches(strictness, entity.inmate.entitlement, current.grade, data.balance.grading)
    ) {
      continue
    }

    const mask = inmateAccessMask(data, entity.inmate.category)
    const target = bestCandidate(candidates, entity, mask, strictness, data)
    if (target === undefined) continue
    if (target.roomId === entity.inmate.cellId) continue

    if (current !== undefined) current.occupied -= 1
    target.occupied += 1

    const from = entity.inmate.cellId
    world.inmates.assignHousing(entity.id, target.roomId)
    enqueueEscort({
      world,
      inmateId: entity.id,
      destinationTile: target.tile,
      purpose: 'cell_assignment',
      events,
      tick,
    })
    queued += 1

    events.emit({
      tick,
      kind: GRADING_EVENTS.reassigned,
      subjectId: entity.id,
      causeIds: [],
      data: {
        fromRoomId: from,
        toRoomId: target.roomId,
        entitlement: entity.inmate.entitlement,
        grade: target.grade,
        strictness,
      },
    })
  }

  return queued
}

/**
 * The free housing an inmate could be moved to, best match first.
 *
 * "Best" is the closest grade to the entitlement rather than the highest: an
 * entitlement-2 inmate promoted straight into a grade-9 cell would leave the
 * ladder with nothing left to offer, and PRD 5.2's misconduct modifier
 * punishes exactly that mismatch in the other direction.
 */
function bestCandidate(
  candidates: readonly HousingCandidate[],
  entity: InmateEntity,
  accessMask: number,
  strictness: ReassignmentStrictness,
  data: GameData,
): HousingCandidate | undefined {
  let best: HousingCandidate | undefined
  let bestDistance = Number.POSITIVE_INFINITY

  for (const candidate of candidates) {
    if (candidate.occupied >= candidate.capacity) continue
    if ((candidate.accessMask & accessMask) === 0) continue
    if (
      !entitlementMatches(
        strictness,
        entity.inmate.entitlement,
        candidate.grade,
        data.balance.grading,
      )
    ) {
      continue
    }
    const distance = Math.abs(candidate.grade - entity.inmate.entitlement)
    if (
      distance < bestDistance ||
      (distance === bestDistance && best !== undefined && candidate.roomId < best.roomId)
    ) {
      best = candidate
      bestDistance = distance
    }
  }
  return best
}

function housingCandidates(world: InmateWorld): HousingCandidate[] {
  const candidates: HousingCandidate[] = []

  for (const room of world.rooms.all()) {
    if (!isHousingRoom(room.defId)) continue
    const status = world.rooms.statusOf(room.id)
    if (status === undefined || !status.functional) continue

    const tile = room.tiles[0]
    if (tile === undefined) continue

    const grade = world.grading.breakdowns.get(room.id)?.score ?? 0
    candidates.push({
      roomId: room.id,
      defId: room.defId,
      grade,
      capacity: housingCapacityOf(world, room),
      occupied: world.inmates.occupantsInRoom(room.id),
      accessMask: world.sectors.maskAtTile(world.grid, tile),
      tile,
    })
  }

  // Ascending id: a tie between two equally good cells always resolves the
  // same way, which is what makes the pass replayable.
  candidates.sort((a, b) => a.roomId - b.roomId)
  return candidates
}

function housingCapacityOf(world: InmateWorld, room: Room): number {
  if (room.defId === 'cell') return 1
  const beds = world.objects.objectCount(room.id, 'bed')
  const bunks = world.objects.objectCount(room.id, 'bunk_bed')
  return beds + bunks * 2
}

/** The published grade of a room, or undefined when it is not graded. */
export function roomGradeOf(world: InmateWorld, roomId: number): number | undefined {
  return world.grading.breakdowns.get(roomId)?.score
}

/** The sector's mean graded-room score, or the data default. */
export function sectorGradeOf(world: InmateWorld, data: GameData, sectorId: number): number {
  if (sectorId === NO_ROOM) return data.balance.grading.defaultSectorGrade
  return world.grading.sectorGrades.get(sectorId) ?? data.balance.grading.defaultSectorGrade
}
