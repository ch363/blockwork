/**
 * `ActivitySystem`: claim need-serving objects while in a permitted room (T2.6).
 *
 * Slot 7 in the PRD 4.4 order — after Needs. Runs once per in-game minute.
 * An inmate standing in a room allowed by the current Routine block, with a
 * spare object that serves the preferred (or free-choice) need, claims it and
 * enters a timed `using` state. NeedsSystem discharges while the claim holds.
 *
 * Sleep is refused between the configured forbidden hours even during a sleep
 * block: beds will not be claimed, other in-cell objects still may.
 */

import { TICKS_PER_MINUTE } from '../core/clock'
import type { System, SystemContext } from '../core/simulation'
import type { GameData } from '../data/loader'
import { NeedIndex, NEEDS_EVENTS } from '../entities/needs'
import type { NeedsRejection } from '../entities/needs'
import { isOperational, NO_OBJECT } from '../entities/objects'
import type { ObjectEntity } from '../entities/objects'
import { NO_ROOM } from '../world/rooms'
import {
  ACTIVITY_EVENTS,
  isSleepForbiddenAt,
  sessionMinutesForNeed,
} from '../world/routine'
import type { InmateRoutineState } from '../world/routine'
import { isInmateWorld } from './intakeSystem'
import type { InmateWorld } from './intakeSystem'

export interface ActivitySystemOptions {
  readonly data: GameData
  readonly index?: NeedIndex
}

export const ACTIVITY_SYSTEM_NAME = 'activity'

/** PRD 4.4: Activity runs once an in-game minute. */
export const ACTIVITY_SYSTEM_PERIOD = TICKS_PER_MINUTE

export function createActivitySystem(options: ActivitySystemOptions): System {
  const { data } = options
  const index = options.index ?? NeedIndex.fromData(data)
  let reportedWrongWorld = false

  return {
    name: ACTIVITY_SYSTEM_NAME,
    period: ACTIVITY_SYSTEM_PERIOD,

    update(context: SystemContext): void {
      const world = context.world
      const tick = context.clock.tick
      const hour = context.clock.hour

      if (!isInmateWorld(world)) {
        if (reportedWrongWorld) return
        reportedWrongWorld = true
        context.events.emit({
          tick,
          kind: ACTIVITY_EVENTS.rejected,
          causeIds: [],
          data: { command: ACTIVITY_SYSTEM_NAME, reason: 'wrong-world' },
        })
        return
      }

      const sleepForbidden = isSleepForbiddenAt(data, hour)

      for (const entity of world.inmates.all()) {
        const runtime = world.routineRuntime.stateOf(entity.id)
        const needState = world.needsRuntime.stateOf(entity.id)

        if (runtime.blockId === null) {
          if (needState.usingObjectId !== NO_OBJECT) {
            world.needsRuntime.endUsing(entity.id)
            runtime.useMinutesRemaining = 0
          }
          continue
        }

        // Tick down an active session.
        if (needState.usingObjectId !== NO_OBJECT) {
          if (runtime.useMinutesRemaining > 0) {
            runtime.useMinutesRemaining -= 1
          }
          if (runtime.useMinutesRemaining <= 0) {
            const endedId = needState.usingObjectId
            world.needsRuntime.endUsing(entity.id)
            context.events.emit({
              tick,
              kind: ACTIVITY_EVENTS.endedUsing,
              causeIds: [entity.id],
              data: { inmateId: entity.id, objectId: endedId },
            })
          }
          continue
        }

        const tileIndex = entity.ty * world.grid.size + entity.tx
        const roomId = world.grid.getAt('roomId', tileIndex)
        if (roomId === NO_ROOM) continue

        const room = world.rooms.get(roomId)
        if (room === undefined) continue
        if (!runtime.permittedRooms.includes(room.defId)) continue

        const targetNeed = runtime.preferredNeed
        if (targetNeed === null) {
          // Lockup with no preferred need: pick the highest need this room serves.
          const opportunistic = highestNeedInRoom({
            data,
            index,
            needs: entity.inmate.needs,
            roomDefId: room.defId,
            sleepForbidden,
          })
          if (opportunistic === undefined) continue
          tryClaim({
            world,
            data,
            entityId: entity.id,
            roomId,
            needId: opportunistic,
            needValue: index.get(entity.inmate.needs, opportunistic),
            sleepForbidden,
            tick,
            events: context.events,
            runtime,
          })
          continue
        }

        if (targetNeed === 'sleep' && sleepForbidden) continue

        tryClaim({
          world,
          data,
          entityId: entity.id,
          roomId,
          needId: targetNeed,
          needValue: index.get(entity.inmate.needs, targetNeed),
          sleepForbidden,
          tick,
          events: context.events,
          runtime,
        })
      }
    },
  }
}

function highestNeedInRoom(options: {
  readonly data: GameData
  readonly index: NeedIndex
  readonly needs: Float32Array
  readonly roomDefId: string
  readonly sleepForbidden: boolean
}): string | undefined {
  const roomDef = options.data.rooms.find(options.roomDefId)
  if (roomDef === undefined) return undefined

  let bestId: string | undefined
  let bestValue = -Infinity
  for (const needId of roomDef.servesNeeds) {
    if (needId === 'sleep' && options.sleepForbidden) continue
    const needIndex = options.index.indexOf(needId)
    if (needIndex < 0) continue
    const value = options.needs[needIndex] ?? 0
    if (value <= 0) continue
    if (value > bestValue || (value === bestValue && (bestId === undefined || needId < bestId))) {
      bestValue = value
      bestId = needId
    }
  }
  return bestId
}

function tryClaim(options: {
  readonly world: InmateWorld
  readonly data: GameData
  readonly entityId: number
  readonly roomId: number
  readonly needId: string
  readonly needValue: number
  readonly sleepForbidden: boolean
  readonly tick: number
  readonly events: {
    emit(event: {
      readonly tick: number
      readonly kind: string
      readonly causeIds: readonly number[]
      readonly data: Record<string, string | number | boolean | null>
    }): void
  }
  readonly runtime: InmateRoutineState
}): void {
  const { world, data, entityId, roomId, needId, needValue, sleepForbidden, tick, events, runtime } =
    options

  if (needId === 'sleep' && sleepForbidden) return
  if (needValue <= 0) return

  const object = findSpareObject(world, data, roomId, needId)
  if (object === undefined) return

  const def = data.objects.find(object.object.defId)
  if (def === undefined) return

  const rejection: NeedsRejection | undefined = world.needsRuntime.beginUsing(
    entityId,
    object,
    def.servesNeeds,
  )
  if (rejection !== undefined) {
    events.emit({
      tick,
      kind: NEEDS_EVENTS.rejected,
      causeIds: [entityId],
      data: {
        command: ACTIVITY_SYSTEM_NAME,
        reason: rejection,
        inmateId: entityId,
        objectId: object.id,
        needId,
      },
    })
    return
  }

  runtime.useMinutesRemaining = sessionMinutesForNeed(data, needId, needValue)
  events.emit({
    tick,
    kind: ACTIVITY_EVENTS.beganUsing,
    causeIds: [entityId],
    data: {
      inmateId: entityId,
      objectId: object.id,
      needId,
      minutes: runtime.useMinutesRemaining,
    },
  })
}

function findSpareObject(
  world: InmateWorld,
  data: GameData,
  roomId: number,
  needId: string,
): ObjectEntity | undefined {
  let best: ObjectEntity | undefined
  for (const object of world.objects.inRoom(roomId)) {
    if (!isOperational(object)) continue
    const def = data.objects.find(object.object.defId)
    if (def === undefined) continue
    const serves = def.servesNeeds.find((entry) => entry.need === needId)
    if (serves === undefined) continue
    if (world.needsRuntime.usersOf(object.id) >= serves.concurrentUsers) continue
    if (best === undefined || object.id < best.id) best = object
  }
  return best
}
