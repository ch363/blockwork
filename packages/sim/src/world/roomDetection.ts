/**
 * Room detection: turning designated tiles into rooms, and doing it again
 * cheaply (T1.3, PRD 5.1).
 *
 * Detection is a flood fill over tiles that share a designation, four
 * connected, bounded by anything wall-like. Each connected component is one
 * room. That is the easy half. The hard half, and the reason this is a module
 * rather than a function, is that the fill must never run over the whole map.
 * A prison is a few hundred rooms and the player edits one wall at a time; a
 * full re-scan on every change would be the single most expensive thing the
 * build tools do, and it would get worse as the prison got better.
 *
 * So a pass works from **seeds** instead. A seed is a tile whose designation
 * or structure changed, widened to its four neighbours — because knocking a
 * wall out merges the rooms either side of it, and neither of those tiles has
 * itself changed. Every room touching a seed is dissolved, its tiles become
 * seeds in turn, and the fill re-runs over exactly that set. Nothing else on
 * the map is read, which is what `RoomUpdate.evaluated` lets a test assert.
 *
 * A **structural** change needs a wider net than a designation change, and
 * this is the part that is easy to get wrong. Membership is local: a tile is
 * in a room or it is not, and only its neighbours can be affected. `enclosed`
 * and `secure` are not: they are properties of the whole open space the room
 * sits in, so a hole cut in a perimeter fence fifty tiles away un-secures
 * every room inside it. A pass therefore floods the open space around each
 * structural change — the same space, bounded by the same wall-like tiles,
 * that the enclosure walk itself covers — and dissolves every room it finds
 * there. That flood shares `enclosureFillLimit` with the walk, because they
 * are answering the same question from opposite ends, and beyond that limit
 * neither of them claims to know.
 *
 * Two details make dissolving safe:
 *
 *   - **Identity survives.** A component that covers the tiles of a room that
 *     was just dissolved reclaims that room's id, so a wall change inside a
 *     cell leaves the cell with the id its objects and its occupant know. When
 *     two rooms merge, the lower id wins and the other is reported removed;
 *     when one splits, the component containing the lowest tile keeps the id
 *     and the rest are new.
 *   - **The fill absorbs what it meets.** If a fill reaches a tile still owned
 *     by a room nobody dissolved, that room is dissolved on the spot and its
 *     tiles join the work list. A seed set that under-reports produces a
 *     slower pass, never a wrong one.
 *
 * Ordering is fixed throughout — seeds ascending, components in ascending
 * start-tile order, tiles ascending within a component — so two runs that
 * reach the same world assign the same ids.
 */

import { isJsonArray } from '../core/commands'
import type { Command, JsonValue } from '../core/commands'
import type { CommandHandler, EventSink, SystemContext } from '../core/simulation'
import type { GameData } from '../data/loader'
import { DirectorateState, gatingNode, hasFeature, isUnlocked } from '../entities/directorate'

import { clipRect, isValidRect, rectTiles } from './construction'
import type { Rect } from './construction'
import { indexInRange } from './coords'
import {
  NO_DESIGNATION,
  NO_ROOM,
  ROOM_NEIGHBOURS,
  RoomWorld,
  computeRoomProperties,
  evaluateRoom,
  failedRequirements,
} from './rooms'
import type { Room, RoomContents, RoomStatus } from './rooms'
import { isWallLike } from './walls'

/* -------------------------------------------------------------------------- */
/* Dependencies and events                                                     */
/* -------------------------------------------------------------------------- */

export interface RoomDeps {
  readonly world: RoomWorld
  readonly data: GameData
  readonly events: EventSink
  readonly tick: number
  /** What is inside each room. Defaults to whatever the world reports. */
  readonly contents?: RoomContents
}

/** Why a designation command, or part of one, produced nothing. */
export type RoomRejection =
  | 'invalid-payload'
  | 'invalid-rect'
  | 'off-grid'
  | 'unknown-room'
  /** The room's Directorate node has not completed (T5.1). */
  | 'locked'
  | 'wrong-world'

function compactCellsEnabled(deps: RoomDeps): boolean {
  const world = deps.world
  if (!('directorate' in world)) return false
  const directorate = (world as { directorate?: DirectorateState }).directorate
  if (!(directorate instanceof DirectorateState)) return false
  return hasFeature(deps.data, directorate, 'compact_cells')
}

function reject(
  deps: RoomDeps,
  command: string,
  reason: RoomRejection,
  detail: Readonly<Record<string, JsonValue>> = {},
): void {
  deps.events.emit({
    tick: deps.tick,
    kind: 'rooms.rejected',
    causeIds: [],
    data: { command, reason, ...detail },
  })
}

/* -------------------------------------------------------------------------- */
/* Geometry helpers                                                            */
/* -------------------------------------------------------------------------- */

function boundsOf(tiles: readonly number[], size: number): Rect {
  let left = size
  let top = size
  let right = -1
  let bottom = -1

  for (const tile of tiles) {
    const y = Math.floor(tile / size)
    const x = tile - y * size
    if (x < left) left = x
    if (x > right) right = x
    if (y < top) top = y
    if (y > bottom) bottom = y
  }

  if (right < left) return { x: 0, y: 0, width: 0, height: 0 }
  return { x: left, y: top, width: right - left + 1, height: bottom - top + 1 }
}

/* -------------------------------------------------------------------------- */
/* Detection                                                                   */
/* -------------------------------------------------------------------------- */

/** What one detection pass did. `evaluated` is the re-evaluation scope. */
export interface RoomUpdate {
  /** Rooms detected in this pass, ascending by id. */
  readonly evaluated: readonly Room[]
  /** Ids that no longer name a room, ascending. */
  readonly removed: readonly number[]
  /** Tiles the fills assigned. The cost of the pass, for the perf budget. */
  readonly tilesVisited: number
}

const EMPTY_UPDATE: RoomUpdate = { evaluated: [], removed: [], tilesVisited: 0 }

/**
 * Re-detects the connected components touched by `changedTiles`, plus anything
 * construction has marked stale since the last pass.
 *
 * `changedTiles` is for **designation** changes, whose effect is local. A
 * structural change reaches detection through
 * `ConstructionWorld.structureChanged`, which is what earns it the wider open
 * space flood described at the top of this module — so code that writes walls
 * into the grid behind construction's back has to mark the tile stale itself
 * or the rooms around it will keep yesterday's answer.
 *
 * Stale tiles are always drained, so no caller can accidentally detect against
 * a world whose walls have moved underneath it.
 */
export function detectRooms(deps: RoomDeps, changedTiles: Iterable<number> = []): RoomUpdate {
  const world = deps.world
  const grid = world.grid
  const registry = world.rooms
  const size = grid.size
  const contents = deps.contents ?? world.contents()
  const fillLimit = deps.data.balance.rooms.enclosureFillLimit

  /** Tiles this pass will consider starting a fill from. */
  const queued = new Set<number>()
  let pending: number[] = []
  /** Tile to the room that owned it before this pass, for reclaiming ids. */
  const previousOwner = new Map<number, number>()
  const previousStatus = new Map<number, RoomStatus>()
  const dissolved = new Set<number>()

  const consider = (tileIndex: number): void => {
    if (queued.has(tileIndex)) return
    queued.add(tileIndex)
    pending.push(tileIndex)
  }

  const dissolve = (roomId: number): void => {
    if (roomId === NO_ROOM || dissolved.has(roomId)) return
    const room = registry.get(roomId)
    if (room === undefined) return

    dissolved.add(roomId)
    const status = registry.statusOf(roomId)
    if (status !== undefined) previousStatus.set(roomId, status)
    registry.remove(roomId)
    world.roomDissolved(roomId)

    for (const tile of room.tiles) {
      previousOwner.set(tile, roomId)
      grid.setAt('roomId', tile, NO_ROOM)
      consider(tile)
    }
  }

  const seed = (tileIndex: number): void => {
    if (!indexInRange(tileIndex, size)) return
    const y = Math.floor(tileIndex / size)
    const x = tileIndex - y * size

    consider(tileIndex)
    dissolve(grid.getAt('roomId', tileIndex))

    for (const [dx, dy] of ROOM_NEIGHBOURS) {
      const nx = x + dx
      const ny = y + dy
      if (nx < 0 || ny < 0 || nx >= size || ny >= size) continue
      const neighbour = ny * size + nx
      consider(neighbour)
      dissolve(grid.getAt('roomId', neighbour))
    }
  }

  /**
   * Dissolves every room sharing an open space with a structural change.
   *
   * Walls and doors bound the flood, exactly as they bound the enclosure walk,
   * so a change inside a sealed room costs that room and nothing more. The
   * changed tile's neighbours are opened too: a wall that has just gone up
   * blocks at its own tile, and the space it just divided is on either side of
   * it.
   */
  const spreadFromStructure = (tiles: readonly number[]): void => {
    const region = new Set<number>()
    const frontier: number[] = []

    const open = (index: number): void => {
      if (region.has(index)) return
      region.add(index)
      if (isWallLike(grid, world.doors, index)) return
      frontier.push(index)
    }

    const openAround = (index: number): void => {
      const y = Math.floor(index / size)
      const x = index - y * size
      for (const [dx, dy] of ROOM_NEIGHBOURS) {
        const nx = x + dx
        const ny = y + dy
        if (nx < 0 || ny < 0 || nx >= size || ny >= size) continue
        open(ny * size + nx)
      }
    }

    for (const tile of tiles) {
      if (!indexInRange(tile, size)) continue
      open(tile)
      openAround(tile)
    }

    let walked = 0
    while (frontier.length > 0) {
      const index = frontier.pop()
      if (index === undefined) break

      walked += 1
      if (walked > fillLimit) {
        // Beyond here the pass would be scanning the map, which is the one
        // thing incremental detection exists to avoid. Rooms further out keep
        // the enclosure they last measured until something nearer moves.
        deps.events.emit({
          tick: deps.tick,
          kind: 'rooms.scopeTruncated',
          causeIds: [],
          data: { limit: fillLimit, changedTiles: tiles.length },
        })
        return
      }

      dissolve(grid.getAt('roomId', index))
      openAround(index)
    }
  }

  const structural = registry.takeStale()
  for (const tile of structural) seed(tile)
  for (const tile of changedTiles) seed(tile)
  if (structural.length > 0) spreadFromStructure(structural)

  if (pending.length === 0) return EMPTY_UPDATE

  const visited = new Set<number>()
  const reclaimed = new Set<number>()
  const evaluated: Room[] = []
  let tilesVisited = 0

  // Rounds, because absorbing a room mid-fill adds work. Each tile enters
  // `pending` at most once, so this terminates in at most one pass per tile.
  while (pending.length > 0) {
    const round = pending
    pending = []
    round.sort((a, b) => a - b)

    for (const start of round) {
      if (visited.has(start)) continue
      visited.add(start)

      const slot = registry.designationAt(start)
      if (slot === NO_DESIGNATION) continue
      if (isWallLike(grid, world.doors, start)) continue

      const tiles: number[] = []
      const owners: number[] = []
      const frontier = [start]

      while (frontier.length > 0) {
        const index = frontier.pop()
        if (index === undefined) break
        tiles.push(index)

        const owner = previousOwner.get(index) ?? grid.getAt('roomId', index)
        if (owner !== NO_ROOM) {
          owners.push(owner)
          dissolve(owner)
        }

        const y = Math.floor(index / size)
        const x = index - y * size
        for (const [dx, dy] of ROOM_NEIGHBOURS) {
          const nx = x + dx
          const ny = y + dy
          if (nx < 0 || ny < 0 || nx >= size || ny >= size) continue
          const next = ny * size + nx
          if (visited.has(next)) continue
          if (registry.designationAt(next) !== slot) continue
          if (isWallLike(grid, world.doors, next)) continue
          visited.add(next)
          frontier.push(next)
        }
      }

      tiles.sort((a, b) => a - b)
      owners.sort((a, b) => a - b)

      let id = NO_ROOM
      for (const owner of owners) {
        if (reclaimed.has(owner)) continue
        id = owner
        break
      }
      if (id === NO_ROOM) id = registry.allocateId()
      if (id === NO_ROOM) {
        // 65,535 rooms have been created over this prison's life. The tiles
        // stay unassigned rather than colliding with a live room.
        deps.events.emit({
          tick: deps.tick,
          kind: 'rooms.idExhausted',
          causeIds: [],
          data: { tileIndex: start, tiles: tiles.length },
        })
        continue
      }
      reclaimed.add(id)

      for (const tile of tiles) grid.setAt('roomId', tile, id)
      tilesVisited += tiles.length

      // Before evaluation, so anything indexed by room is grading the room it
      // is actually standing in.
      world.roomAssigned(id, tiles)

      // After the write, because the enclosure walk asks the grid which tiles
      // are this room's.
      const { properties, scan } = computeRoomProperties(world, tiles, id, fillLimit)
      if (scan.truncated) {
        deps.events.emit({
          tick: deps.tick,
          kind: 'rooms.enclosureUnbounded',
          causeIds: [id],
          data: { roomId: id, limit: fillLimit, visited: scan.visited },
        })
      }

      const defId = registry.idOfSlot(slot)
      const room: Room = { id, defId, tiles, bounds: boundsOf(tiles, size), properties }
      registry.set(room)
      evaluated.push(room)

      const status = evaluateRoom(room, deps.data.rooms.get(defId), contents, {
        compactCells: compactCellsEnabled(deps),
      })
      registry.setStatus(status)

      // On the transition only. A prison with two hundred half-built rooms
      // would otherwise re-report every one of them on every nearby edit.
      const before = previousStatus.get(id)
      if (!status.functional && (before === undefined || before.functional)) {
        deps.events.emit({
          tick: deps.tick,
          kind: 'rooms.notFunctional',
          causeIds: [id],
          data: {
            roomId: id,
            roomDefId: defId,
            missing: failedRequirements(status).map((entry) => entry.subject),
          },
        })
      }
    }
  }

  evaluated.sort((a, b) => a.id - b.id)
  const removed = [...dissolved].filter((id) => !reclaimed.has(id)).sort((a, b) => a - b)

  return { evaluated, removed, tilesVisited }
}

/**
 * Re-detects everything construction has changed since the last pass.
 *
 * The tick-time entry point: batching a whole demolition into one pass is the
 * difference between one fill and four hundred.
 */
export function updateStaleRooms(deps: RoomDeps): RoomUpdate {
  return detectRooms(deps)
}

/**
 * Rebuilds every room from the designations.
 *
 * For the paths that acquire a world rather than edit one — a loaded save,
 * whose derived state is rebuilt rather than trusted (PRD 7.4).
 */
export function detectAllRooms(deps: RoomDeps): RoomUpdate {
  const registry = deps.world.rooms
  const seeds: number[] = []
  for (let index = 0; index < deps.world.grid.tileCount; index += 1) {
    if (registry.designationAt(index) !== NO_DESIGNATION) seeds.push(index)
  }
  return detectRooms(deps, seeds)
}

/**
 * Re-grades one room against its definition without re-detecting it.
 *
 * Geometry did not change, so the fill would be wasted work. This is what
 * T1.4 calls when an object is placed or removed.
 */
export function refreshRoomStatus(deps: RoomDeps, roomId: number): RoomStatus | undefined {
  const registry = deps.world.rooms
  const room = registry.get(roomId)
  if (room === undefined) return undefined

  const def = deps.data.rooms.find(room.defId)
  if (def === undefined) return undefined

  const before = registry.statusOf(roomId)
  const status = evaluateRoom(room, def, deps.contents ?? deps.world.contents(), {
    compactCells: compactCellsEnabled(deps),
  })
  registry.setStatus(status)

  if (!status.functional && (before === undefined || before.functional)) {
    deps.events.emit({
      tick: deps.tick,
      kind: 'rooms.notFunctional',
      causeIds: [roomId],
      data: {
        roomId,
        roomDefId: room.defId,
        missing: failedRequirements(status).map((entry) => entry.subject),
      },
    })
  }

  return status
}

/* -------------------------------------------------------------------------- */
/* Commands                                                                    */
/* -------------------------------------------------------------------------- */

/** The command names the UI sends across the worker boundary (PRD 4.6). */
export const ROOM_COMMANDS = {
  designateRoom: 'rooms.designate',
  undesignateRoom: 'rooms.undesignate',
} as const

/**
 * `DesignateRoom`: paints a room type over a rectangle.
 *
 * Instant, unlike construction. Zoning is a decision, not a job: there is
 * nothing for a worker to carry and nothing to build.
 *
 * Tiles that already carry the designation are skipped, so dragging over an
 * existing room re-detects nothing.
 *
 * @returns the number of tiles whose designation changed.
 */
export function designateRoom(deps: RoomDeps, rect: Rect, roomDefId: string): number {
  const command = ROOM_COMMANDS.designateRoom
  const world = deps.world

  if (!isValidRect(rect)) {
    reject(deps, command, 'invalid-rect', { ...rect })
    return 0
  }
  const clipped = clipRect(rect, world.grid.size)
  if (clipped === undefined) {
    reject(deps, command, 'off-grid', { ...rect })
    return 0
  }
  const def = deps.data.rooms.find(roomDefId)
  if (def === undefined) {
    reject(deps, command, 'unknown-room', { roomDefId })
    return 0
  }
  if (!isUnlocked(deps.data, world.directorate, 'rooms', roomDefId)) {
    reject(deps, command, 'locked', {
      roomDefId,
      nodeId: gatingNode(deps.data, 'rooms', roomDefId) ?? '',
    })
    return 0
  }

  const changed: number[] = []
  for (const index of rectTiles(world.grid, clipped)) {
    if (world.rooms.setDesignation(index, def.id)) changed.push(index)
  }

  if (changed.length > 0) {
    // The overlay is drawn from the designation, not from room membership, so
    // a designated wall tile still has to repaint.
    world.grid.markDirtyRect(clipped.x, clipped.y, clipped.width, clipped.height)
    detectRooms(deps, changed)
  }
  return changed.length
}

/** `UndesignateRoom`: clears every designation over a rectangle. */
export function undesignateRoom(deps: RoomDeps, rect: Rect): number {
  const command = ROOM_COMMANDS.undesignateRoom
  const world = deps.world

  if (!isValidRect(rect)) {
    reject(deps, command, 'invalid-rect', { ...rect })
    return 0
  }
  const clipped = clipRect(rect, world.grid.size)
  if (clipped === undefined) {
    reject(deps, command, 'off-grid', { ...rect })
    return 0
  }

  const changed: number[] = []
  for (const index of rectTiles(world.grid, clipped)) {
    if (world.rooms.setDesignation(index, undefined)) changed.push(index)
  }

  if (changed.length > 0) {
    world.grid.markDirtyRect(clipped.x, clipped.y, clipped.width, clipped.height)
    detectRooms(deps, changed)
  }
  return changed.length
}

/* -------------------------------------------------------------------------- */
/* Command handlers                                                            */
/* -------------------------------------------------------------------------- */

/*
 * Payloads arrive as untrusted JSON from the main thread, so each one is read
 * defensively and a malformed command becomes a `CausalEvent` rather than an
 * exception inside the tick loop.
 */

function asRecord(value: JsonValue): Readonly<Record<string, JsonValue>> | undefined {
  if (value === null || typeof value !== 'object' || isJsonArray(value)) return undefined
  return value
}

function asInteger(value: JsonValue | undefined): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) ? value : undefined
}

function asRect(value: JsonValue | undefined): Rect | undefined {
  const record = value === undefined ? undefined : asRecord(value)
  if (record === undefined) return undefined
  const x = asInteger(record['x'])
  const y = asInteger(record['y'])
  const width = asInteger(record['width'])
  const height = asInteger(record['height'])
  if (x === undefined || y === undefined || width === undefined || height === undefined) {
    return undefined
  }
  return { x, y, width, height }
}

/**
 * Adapts the command queue to the functions above.
 *
 * The world comes from the `SystemContext` rather than a closure, so a
 * simulation that reloads a save keeps working. A world without a room
 * registry is a wiring mistake and says so once per command instead of
 * throwing inside the tick.
 */
export function roomCommandHandlers(data: GameData): Record<string, CommandHandler> {
  const bind = (
    context: SystemContext,
    command: Command,
    run: (deps: RoomDeps, payload: Readonly<Record<string, JsonValue>>) => void,
  ): void => {
    const world = context.world
    const tick = context.clock.tick

    if (!(world instanceof RoomWorld)) {
      context.events.emit({
        tick,
        kind: 'rooms.rejected',
        causeIds: [],
        data: { command: command.type, reason: 'wrong-world' satisfies RoomRejection },
      })
      return
    }

    const deps: RoomDeps = { world, data, events: context.events, tick }

    const payload = asRecord(command.payload)
    if (payload === undefined) {
      reject(deps, command.type, 'invalid-payload')
      return
    }

    run(deps, payload)
  }

  return {
    [ROOM_COMMANDS.designateRoom]: (command, context) => {
      bind(context, command, (deps, payload) => {
        const rect = asRect(payload['rect'])
        const roomDefId = payload['roomDefId']
        if (rect === undefined || typeof roomDefId !== 'string') {
          reject(deps, command.type, 'invalid-payload')
          return
        }
        designateRoom(deps, rect, roomDefId)
      })
    },
    [ROOM_COMMANDS.undesignateRoom]: (command, context) => {
      bind(context, command, (deps, payload) => {
        const rect = asRect(payload['rect'])
        if (rect !== undefined) {
          undesignateRoom(deps, rect)
          return
        }
        const roomId = asInteger(payload['roomId'])
        if (roomId === undefined) {
          reject(deps, command.type, 'invalid-payload')
          return
        }
        const room = deps.world.rooms.get(roomId)
        if (room === undefined) {
          reject(deps, command.type, 'unknown-room', { roomId })
          return
        }
        undesignateRoom(deps, room.bounds)
      })
    },
  }
}
