/**
 * `PunishmentSystem`: holds, meal delivery and suppression (T4.4, PRD 5.11).
 *
 * Runs once per in-game minute. Progresses pending escorts into holds, ticks
 * remaining duration, delivers meals during meal Routine blocks, accrues and
 * decays suppression, and applies the isolation reform penalty.
 */

import { TICKS_PER_MINUTE } from '../core/clock'
import type { EventSink, System, SystemContext } from '../core/simulation'
import type { GameData } from '../data/loader'
import type { MisconductKind, PunishmentKind } from '../data/schemas'
import { MISCONDUCT_EVENTS, chebyshevTiles, relieveFoodNeed } from '../entities/misconduct'
import {
  clampSuppression,
  hoursToMinutes,
  type ActivePunishment,
  type ActivePunishmentKind,
} from '../entities/punishment'
import { NeedIndex } from '../entities/needs'
import { enqueueEscort, hasCapability } from '../entities/staff'
import { NO_ROOM } from '../world/rooms'
import { isInmateWorld } from './intakeSystem'
import type { InmateWorld } from './intakeSystem'

export interface PunishmentSystemOptions {
  readonly data: GameData
  readonly index?: NeedIndex
}

export const PUNISHMENT_SYSTEM_NAME = 'punishment'

/** Hold countdown, meal delivery and suppression all tick per minute. */
export const PUNISHMENT_SYSTEM_PERIOD = TICKS_PER_MINUTE

export function createPunishmentSystem(options: PunishmentSystemOptions): System {
  const { data } = options
  const index = options.index ?? NeedIndex.fromData(data)
  let reportedWrongWorld = false

  return {
    name: PUNISHMENT_SYSTEM_NAME,
    period: PUNISHMENT_SYSTEM_PERIOD,

    update(context: SystemContext): void {
      const world = context.world
      const tick = context.clock.tick

      if (!isInmateWorld(world)) {
        if (reportedWrongWorld) return
        reportedWrongWorld = true
        context.events.emit({
          tick,
          kind: MISCONDUCT_EVENTS.rejected,
          causeIds: [],
          data: { command: PUNISHMENT_SYSTEM_NAME, reason: 'wrong-world' },
        })
        return
      }

      advancePendingEscorts(world, context.events, tick)
      progressHolds(world, data, index, context.events, tick)
      updateSuppression(world, data, tick)
    },
  }
}

export interface BeginPunishmentOptions {
  readonly world: InmateWorld
  readonly data: GameData
  readonly events: EventSink
  readonly tick: number
  readonly inmateId: number
  readonly kind: Exclude<PunishmentKind, 'ignore'>
  readonly sourceMisconduct: MisconductKind
  readonly durationHours: number
}

/**
 * Starts a lockdown or isolation hold. Prefers a free isolation cell; on
 * overflow falls back to cell lockdown (mockup §9). Without escort staff the
 * inmate is moved immediately so tests and empty prisons still progress.
 */
export function beginPunishment(options: BeginPunishmentOptions): ActivePunishment | undefined {
  const { world, data, events, tick, inmateId, kind, sourceMisconduct, durationHours } = options
  const entity = world.inmates.get(inmateId)
  if (entity === undefined) return undefined

  // Replace any existing hold.
  world.punishments.remove(inmateId)

  const homeCellId = entity.inmate.cellId
  let effectiveKind: ActivePunishmentKind = kind
  let holdRoomId = homeCellId

  if (kind === 'isolation') {
    const isolation = findFreeIsolationRoom(world, inmateId)
    if (isolation === undefined) {
      effectiveKind = 'lockdown'
      events.emit({
        tick,
        kind: MISCONDUCT_EVENTS.isolationOverflow,
        subjectId: inmateId,
        causeIds: [],
        data: { inmateId, fallback: 'lockdown' },
      })
    } else {
      holdRoomId = isolation
    }
  }

  if (holdRoomId === NO_ROOM && homeCellId !== NO_ROOM) {
    holdRoomId = homeCellId
  }

  const destinationTile = destinationTileForRoom(world, holdRoomId)
  const remainingMinutes = hoursToMinutes(durationHours)

  const punishment: ActivePunishment = {
    inmateId,
    kind: effectiveKind,
    sourceMisconduct,
    phase: 'pending_escort',
    remainingMinutes,
    homeCellId,
    holdRoomId,
    destinationTile: destinationTile ?? -1,
    escortJobId: 0,
    lastMealHourKey: -1,
    isolationSuppressionAccrued: 0,
  }

  const alreadyThere =
    destinationTile !== undefined &&
    entity.ty * world.grid.size + entity.tx === destinationTile

  if (alreadyThere || destinationTile === undefined) {
    enterHold(world, data, events, tick, punishment)
  } else {
    const job = enqueueEscort({
      world,
      inmateId,
      destinationTile,
      purpose: effectiveKind === 'isolation' ? 'isolation' : 'other',
      events,
      tick,
    })
    punishment.escortJobId = job?.id ?? 0
    // No escort-capable staff: move immediately so the hold still starts.
    if (job === undefined || !hasEscortStaff(world, data)) {
      placeOnTile(world, inmateId, destinationTile)
      if (effectiveKind === 'isolation' && holdRoomId !== NO_ROOM) {
        world.inmates.assignHousing(inmateId, holdRoomId)
      }
      enterHold(world, data, events, tick, punishment)
    } else {
      world.punishments.set(punishment)
    }
  }

  return world.punishments.get(inmateId) ?? punishment
}

function advancePendingEscorts(world: InmateWorld, events: EventSink, tick: number): void {
  for (const punishment of world.punishments.all()) {
    if (punishment.phase !== 'pending_escort') continue
    const entity = world.inmates.get(punishment.inmateId)
    if (entity === undefined) {
      world.punishments.remove(punishment.inmateId)
      continue
    }

    const here = entity.ty * world.grid.size + entity.tx
    const escort = punishment.escortJobId !== 0 ? world.escorts.get(punishment.escortJobId) : undefined
    const escortDone = escort !== undefined && escort.state === 'completed'
    const atDest = punishment.destinationTile >= 0 && here === punishment.destinationTile

    if (!escortDone && !atDest) continue

    if (punishment.kind === 'isolation' && punishment.holdRoomId !== NO_ROOM) {
      world.inmates.assignHousing(punishment.inmateId, punishment.holdRoomId)
    }
    enterHold(world, world.data, events, tick, punishment)
  }
}

function enterHold(
  world: InmateWorld,
  _data: GameData,
  events: EventSink,
  tick: number,
  punishment: ActivePunishment,
): void {
  punishment.phase = 'holding'
  world.punishments.set(punishment)

  const entity = world.inmates.get(punishment.inmateId)
  if (entity !== undefined) {
    const needState = world.needsRuntime.stateOf(entity.id)
    needState.lockedUp = true
    const runtime = world.routineRuntime.stateOf(entity.id)
    runtime.lockedUp = true
    if (punishment.destinationTile >= 0) {
      runtime.goalTile = punishment.destinationTile
      runtime.goalSetId = null
    }
  }

  events.emit({
    tick,
    kind: MISCONDUCT_EVENTS.punishmentStarted,
    subjectId: punishment.inmateId,
    causeIds: [],
    data: {
      inmateId: punishment.inmateId,
      punishment: punishment.kind,
      misconductKind: punishment.sourceMisconduct,
      remainingMinutes: punishment.remainingMinutes,
      holdRoomId: punishment.holdRoomId,
    },
  })

}

function progressHolds(
  world: InmateWorld,
  data: GameData,
  index: NeedIndex,
  events: EventSink,
  tick: number,
): void {
  const hourKey = Math.floor(tick / (data.balance.time.ticksPerMinute * data.balance.time.minutesPerHour))

  for (const punishment of world.punishments.all()) {
    if (punishment.phase !== 'holding') continue
    const entity = world.inmates.get(punishment.inmateId)
    if (entity === undefined) {
      world.punishments.remove(punishment.inmateId)
      continue
    }

    // Keep confinement latched while held.
    world.needsRuntime.stateOf(entity.id).lockedUp = true
    world.routineRuntime.stateOf(entity.id).lockedUp = true

    deliverMealIfDue(world, data, index, events, tick, hourKey, punishment)

    if (punishment.remainingMinutes < 0) continue // indefinite

    punishment.remainingMinutes -= 1
    if (punishment.remainingMinutes > 0) continue

    releasePunishment(world, data, events, tick, punishment)
  }
}

function deliverMealIfDue(
  world: InmateWorld,
  data: GameData,
  index: NeedIndex,
  events: EventSink,
  tick: number,
  hourKey: number,
  punishment: ActivePunishment,
): void {
  if (punishment.lastMealHourKey === hourKey) return

  const entity = world.inmates.get(punishment.inmateId)
  if (entity === undefined) return

  const hour = hourKey % data.balance.time.hoursPerDay
  const blockId = world.routines.blockAt(entity.inmate.category, hour)
  if (blockId !== 'meal') return

  const foodIndex = index.indexOf('food')
  const relieved = relieveFoodNeed(
    entity.inmate.needs,
    foodIndex,
    data.balance.punishment.mealFoodRelief,
  )
  punishment.lastMealHourKey = hourKey

  events.emit({
    tick,
    kind: MISCONDUCT_EVENTS.mealDelivered,
    subjectId: punishment.inmateId,
    causeIds: [],
    data: {
      inmateId: punishment.inmateId,
      foodRelieved: relieved,
      punishment: punishment.kind,
    },
  })
}

function releasePunishment(
  world: InmateWorld,
  data: GameData,
  events: EventSink,
  tick: number,
  punishment: ActivePunishment,
): void {
  const entity = world.inmates.get(punishment.inmateId)
  punishment.phase = 'releasing'

  if (entity !== undefined) {
    if (
      punishment.kind === 'isolation' &&
      punishment.homeCellId !== NO_ROOM &&
      punishment.homeCellId !== entity.inmate.cellId
    ) {
      world.inmates.assignHousing(entity.id, punishment.homeCellId)
      const dest = destinationTileForRoom(world, punishment.homeCellId)
      if (dest !== undefined) {
        if (hasEscortStaff(world, data)) {
          enqueueEscort({
            world,
            inmateId: entity.id,
            destinationTile: dest,
            purpose: 'cell_assignment',
            events,
            tick,
          })
        } else {
          placeOnTile(world, entity.id, dest)
        }
      }
    }

    world.needsRuntime.stateOf(entity.id).lockedUp = false
    world.routineRuntime.stateOf(entity.id).lockedUp = false
  }

  world.punishments.remove(punishment.inmateId)

  events.emit({
    tick,
    kind: MISCONDUCT_EVENTS.punishmentReleased,
    subjectId: punishment.inmateId,
    causeIds: [],
    data: {
      inmateId: punishment.inmateId,
      punishment: punishment.kind,
      misconductKind: punishment.sourceMisconduct,
      isolationSuppressionAccrued: punishment.isolationSuppressionAccrued,
    },
  })
}

function updateSuppression(world: InmateWorld, data: GameData, _tick: number): void {
  const balance = data.balance.suppression
  const stoicId = balance.stoicReputationId

  for (const entity of world.inmates.all()) {
    const punishment = world.punishments.get(entity.id)
    const holding = punishment !== undefined && punishment.phase === 'holding'
    const stoic = entity.inmate.reputations.some((rep) => rep.id === stoicId)

    let points = 0
    if (holding && punishment.kind === 'lockdown') {
      points += world.punishments.accrueConfinementSuppression(
        entity.id,
        balance.lockdownMinutesPerPoint,
        1,
      )
    } else if (holding && punishment.kind === 'isolation' && !stoic) {
      const gained = world.punishments.accrueConfinementSuppression(
        entity.id,
        balance.isolationMinutesPerPoint,
        1,
      )
      points += gained
      if (gained > 0 && punishment !== undefined) {
        punishment.isolationSuppressionAccrued += gained
        // Isolation visibly harms reform (PRD 5.11 / T4.4 acceptance).
        const grades = entity.inmate.grades
        entity.inmate.grades = {
          punishment: grades.punishment,
          reform: Math.max(0, grades.reform - gained * balance.reformPenaltyPerPoint),
          security: grades.security,
          health: grades.health,
        }
      }
    }

    const armedNearby = nearbyArmedOfficer(
      world,
      data,
      entity.tx,
      entity.ty,
      balance.armedOfficerTiles,
    )
    const decaying = !holding && !armedNearby
    points += world.punishments.applyHourlySuppressionDelta(
      entity.id,
      armedNearby,
      decaying,
      balance,
      1,
    )

    if (points !== 0) {
      entity.inmate.suppression = clampSuppression(
        entity.inmate.suppression + points,
        balance.max,
      )
    }

    syncSuppressedStatus(entity.inmate.status, entity.inmate.suppression, balance.statusThreshold)
  }
}

function syncSuppressedStatus(
  status: import('../data/schemas').StatusEffectId[],
  suppression: number,
  threshold: number,
): void {
  const idx = status.indexOf('suppressed')
  if (suppression >= threshold) {
    if (idx < 0) status.push('suppressed')
  } else if (idx >= 0) {
    status.splice(idx, 1)
  }
}

function nearbyArmedOfficer(
  world: InmateWorld,
  data: GameData,
  tx: number,
  ty: number,
  tiles: number,
): boolean {
  for (const staff of world.staff.all()) {
    if (!hasCapability(data, staff, 'armed')) continue
    if (chebyshevTiles(tx, ty, staff.tx, staff.ty) <= tiles) return true
  }
  return false
}

function findFreeIsolationRoom(world: InmateWorld, excludeInmateId: number): number | undefined {
  for (const room of world.rooms.all()) {
    if (room.defId !== 'isolation') continue
    const status = world.rooms.statusOf(room.id)
    if (status === undefined || !status.functional) continue
    const occupants = world.inmates.occupantsInRoom(room.id)
    if (occupants === 0) return room.id
    // Allow the punished inmate if they already occupy it.
    if (occupants === 1) {
      const entity = world.inmates.get(excludeInmateId)
      if (entity !== undefined && entity.inmate.cellId === room.id) return room.id
    }
  }
  return undefined
}

function destinationTileForRoom(world: InmateWorld, roomId: number): number | undefined {
  if (roomId === NO_ROOM) return undefined
  const room = world.rooms.get(roomId)
  if (room === undefined || room.tiles.length === 0) return undefined
  return room.tiles[0]
}

function placeOnTile(world: InmateWorld, inmateId: number, tileIndex: number): void {
  const entity = world.inmates.get(inmateId)
  if (entity === undefined) return
  const { x, y } = world.grid.xy(tileIndex)
  const units = world.data.balance.map.tileWorldUnits
  entity.tx = x
  entity.ty = y
  entity.x = (x + 0.5) * units
  entity.y = (y + 0.5) * units
}

function hasEscortStaff(world: InmateWorld, data: GameData): boolean {
  return world.staff.withCapability(data, 'escort').length > 0
}
