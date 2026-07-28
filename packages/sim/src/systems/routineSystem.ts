/**
 * `RoutineSystem`: assign each inmate a target room set on the hour (T2.6).
 *
 * Slot 2 in the PRD 4.4 order. Runs once per in-game hour. For every inmate
 * whose category `followsRoutine`, it reads the current hour's block from
 * `RoutineState`, resolves permitted rooms / preferred need, runs free-choice
 * ranking when the block is open, and writes the assignment onto
 * `RoutineRuntime` (including a flow-field goal set id where one exists).
 *
 * Edits to `RoutineState` mid-hour are ignored until the next hour boundary.
 */

import { TICKS_PER_HOUR } from '../core/clock'
import { isJsonArray } from '../core/commands'
import type { Command, JsonValue } from '../core/commands'
import type { CommandHandler, System, SystemContext } from '../core/simulation'
import type { GameData } from '../data/loader'
import type { RoutineBlockId } from '../data/schemas'
import { NeedIndex } from '../entities/needs'
import { NO_ROOM } from '../world/rooms'
import {
  ROUTINE_EVENTS,
  ROUTINE_HOURS,
  assignRoutineHour,
  blockAtHour,
  blockDefOf,
  isSleepForbiddenAt,
  manhattanTiles,
  rankFreeChoice,
  setCategoryRoutine,
} from '../world/routine'
import type { FreeChoiceOption } from '../world/routine'
import { isInmateWorld } from './intakeSystem'

export interface RoutineSystemOptions {
  readonly data: GameData
  readonly index?: NeedIndex
}

export const ROUTINE_SYSTEM_NAME = 'routine'

/** Ticket T2.6: routine assignments fire on the hour boundary. */
export const ROUTINE_SYSTEM_PERIOD = TICKS_PER_HOUR

export function createRoutineSystem(options: RoutineSystemOptions): System {
  const { data } = options
  const index = options.index ?? NeedIndex.fromData(data)
  let reportedWrongWorld = false

  return {
    name: ROUTINE_SYSTEM_NAME,
    period: ROUTINE_SYSTEM_PERIOD,

    update(context: SystemContext): void {
      const world = context.world
      const tick = context.clock.tick
      const hour = context.clock.hour

      if (!isInmateWorld(world)) {
        if (reportedWrongWorld) return
        reportedWrongWorld = true
        context.events.emit({
          tick,
          kind: ROUTINE_EVENTS.rejected,
          causeIds: [],
          data: { command: ROUTINE_SYSTEM_NAME, reason: 'wrong-world' },
        })
        return
      }

      const travelWeight = data.balance.routine.travelTimeWeight

      for (const entity of world.inmates.all()) {
        const category = data.securityCategories.find(entity.inmate.category)
        if (category === undefined) {
          context.events.emit({
            tick,
            kind: ROUTINE_EVENTS.rejected,
            causeIds: [entity.id],
            data: {
              command: ROUTINE_SYSTEM_NAME,
              reason: 'unknown-category',
              category: entity.inmate.category,
            },
          })
          continue
        }

        const runtime = world.routineRuntime.stateOf(entity.id)
        const needState = world.needsRuntime.stateOf(entity.id)

        if (!category.followsRoutine) {
          runtime.blockId = null
          runtime.permittedRooms = []
          runtime.preferredNeed = null
          runtime.goalSetId = null
          runtime.goalTile = -1
          runtime.lockedUp = false
          runtime.freeChoiceNeed = null
          runtime.freeChoiceRoomDef = null
          needState.lockedUp = false
          continue
        }

        const blockId = blockAtHour(world.routines, entity.inmate.category, hour)
        if (blockId === undefined) {
          context.events.emit({
            tick,
            kind: ROUTINE_EVENTS.rejected,
            causeIds: [entity.id],
            data: {
              command: ROUTINE_SYSTEM_NAME,
              reason: 'unknown-category',
              category: entity.inmate.category,
            },
          })
          continue
        }

        const freeChoice = isFreeLike(blockId)
          ? pickFreeChoice({
              data,
              index,
              entityTx: entity.tx,
              entityTy: entity.ty,
              needs: entity.inmate.needs,
              permittedRooms: blockDefOf(data, blockId).permittedRooms,
              travelWeight,
              rooms: world.rooms,
              gridSize: world.grid.size,
              sleepForbidden: isSleepForbiddenAt(data, hour),
            })
          : undefined

        const cellTile = cellGoalTile(world, entity.inmate.cellId)
        const assignment = assignRoutineHour({
          data,
          blockId,
          cellId: entity.inmate.cellId,
          cellTile,
          ...(freeChoice === undefined ? {} : { freeChoice }),
        })

        runtime.blockId = assignment.blockId
        runtime.permittedRooms = assignment.permittedRooms
        runtime.preferredNeed = assignment.preferredNeed
        runtime.goalSetId = assignment.goalSetId
        runtime.goalTile = assignment.goalTile
        runtime.lockedUp = assignment.lockedUp
        runtime.freeChoiceNeed = assignment.freeChoiceNeed
        runtime.freeChoiceRoomDef = assignment.freeChoiceRoomDef
        // Drop any in-progress use so the new hour's activity can claim fresh.
        runtime.useMinutesRemaining = 0
        world.needsRuntime.endUsing(entity.id)
        needState.lockedUp = assignment.lockedUp

        context.events.emit({
          tick,
          kind: ROUTINE_EVENTS.hourAssigned,
          causeIds: [entity.id],
          data: {
            inmateId: entity.id,
            hour,
            blockId: assignment.blockId,
            goalSetId: assignment.goalSetId,
            goalTile: assignment.goalTile,
            preferredNeed: assignment.preferredNeed,
            lockedUp: assignment.lockedUp,
          },
        })
      }
    },
  }
}

function isFreeLike(blockId: RoutineBlockId): boolean {
  return blockId === 'free' || blockId === 'work_free'
}

function cellGoalTile(
  world: {
    readonly rooms: {
      get(id: number): { readonly tiles: readonly number[] } | undefined
    }
  },
  cellId: number,
): number {
  if (cellId === NO_ROOM) return -1
  const room = world.rooms.get(cellId)
  if (room === undefined || room.tiles.length === 0) return -1
  return room.tiles[0] ?? -1
}

function pickFreeChoice(options: {
  readonly data: GameData
  readonly index: NeedIndex
  readonly entityTx: number
  readonly entityTy: number
  readonly needs: Float32Array
  readonly permittedRooms: readonly string[]
  readonly travelWeight: number
  readonly rooms: {
    readonly all: () => Iterable<{
      readonly id: number
      readonly defId: string
      readonly tiles: readonly number[]
      readonly bounds: { readonly x: number; readonly y: number }
    }>
    readonly statusOf: (roomId: number) => { readonly functional: boolean } | undefined
  }
  readonly gridSize: number
  /** PRD 5.7: sleep must not win free-choice during the daytime window. */
  readonly sleepForbidden: boolean
}): FreeChoiceOption | undefined {
  const {
    data,
    index,
    entityTx,
    entityTy,
    needs,
    permittedRooms,
    travelWeight,
    rooms,
    gridSize,
    sleepForbidden,
  } = options

  const permitted = new Set(permittedRooms)
  const candidates: FreeChoiceOption[] = []

  for (const room of rooms.all()) {
    if (!permitted.has(room.defId)) continue
    const status = rooms.statusOf(room.id)
    if (status === undefined || !status.functional) continue

    const roomDef = data.rooms.find(room.defId)
    if (roomDef === undefined || roomDef.servesNeeds.length === 0) continue

    const travel = nearestRoomTravel(entityTx, entityTy, room.tiles, gridSize)
    for (const needId of roomDef.servesNeeds) {
      if (needId === 'sleep' && sleepForbidden) continue
      const needIndex = index.indexOf(needId)
      if (needIndex < 0) continue
      const needValue = needs[needIndex] ?? 0
      if (needValue <= 0) continue
      candidates.push({
        needId,
        roomDefId: room.defId,
        needValue,
        travelMinutes: travel,
      })
    }
  }

  return rankFreeChoice(candidates, travelWeight)
}

function nearestRoomTravel(
  tx: number,
  ty: number,
  tiles: readonly number[],
  gridSize: number,
): number {
  let best = Number.POSITIVE_INFINITY
  for (const tile of tiles) {
    const y = (tile / gridSize) | 0
    const x = tile - y * gridSize
    const d = manhattanTiles(tx, ty, x, y)
    if (d < best) best = d
  }
  return Number.isFinite(best) ? best : 0
}

/* -------------------------------------------------------------------------- */
/* Commands                                                                    */
/* -------------------------------------------------------------------------- */

export const ROUTINE_COMMANDS = {
  setCategory: 'routine.setCategory',
} as const

export function routineCommandHandlers(data: GameData): Readonly<Record<string, CommandHandler>> {
  return {
    [ROUTINE_COMMANDS.setCategory]: (command, context) => {
      handleSetCategory(command, context, data)
    },
  }
}

function handleSetCategory(command: Command, context: SystemContext, data: GameData): void {
  if (!isInmateWorld(context.world)) {
    context.events.emit({
      tick: context.clock.tick,
      kind: ROUTINE_EVENTS.rejected,
      causeIds: [],
      data: { command: command.type, reason: 'wrong-world' },
    })
    return
  }

  const category = readString(command.payload, 'category')
  const blocksValue = readJsonArray(command.payload, 'blocks')
  if (category === undefined || blocksValue === undefined) {
    rejectRoutine(context, command, 'malformed-payload')
    return
  }
  if (!data.securityCategories.has(category)) {
    rejectRoutine(context, command, 'unknown-category')
    return
  }
  if (blocksValue.length !== ROUTINE_HOURS) {
    rejectRoutine(context, command, 'malformed-payload')
    return
  }

  const asStrings: string[] = []
  for (const entry of blocksValue) {
    if (typeof entry !== 'string') {
      rejectRoutine(context, command, 'malformed-payload')
      return
    }
    asStrings.push(entry)
  }

  try {
    setCategoryRoutine(context.world.routines, category, asStrings)
  } catch {
    rejectRoutine(context, command, 'unknown-block')
  }
}

function rejectRoutine(context: SystemContext, command: Command, reason: string): void {
  context.events.emit({
    tick: context.clock.tick,
    kind: ROUTINE_EVENTS.rejected,
    causeIds: [],
    data: { command: command.type, reason },
  })
}

function readString(payload: JsonValue, key: string): string | undefined {
  if (payload === null || typeof payload !== 'object' || isJsonArray(payload)) return undefined
  const value = payload[key]
  return typeof value === 'string' ? value : undefined
}

function readJsonArray(payload: JsonValue, key: string): readonly JsonValue[] | undefined {
  if (payload === null || typeof payload !== 'object' || isJsonArray(payload)) return undefined
  const value = payload[key]
  if (value === undefined || !isJsonArray(value)) return undefined
  return value
}
