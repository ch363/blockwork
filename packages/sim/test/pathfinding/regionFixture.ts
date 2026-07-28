/**
 * Shared scaffolding for the T2.1 region-graph tests.
 *
 * Structure is written straight into the grid, the way T1.3's room fixtures
 * do: the graph cares about passability and doors, not about how they got
 * there, and building sixty rooms through the construction queue would spend
 * the suite on T1.2 rather than on coarse routing.
 */

import { loadGameData } from '../../src/data/loader'
import type { GameData } from '../../src/data/loader'
import type { DoorType } from '../../src/data/schemas'
import { RegionGraph } from '../../src/pathfinding/regionGraph'
import { doorPassability, initialLockState } from '../../src/world/doors'
import type { ConstructionWorld, Rect } from '../../src/world/construction'
import { createConstructionWorld, refreshPassability } from '../../src/world/construction'
import { NO_MATERIAL } from '../../src/world/materials'

/** Loaded once: content validation is not what these tests are measuring. */
export const DATA: GameData = loadGameData()

export const WALL_MATERIAL = 'brick_wall'
export const FLOOR_MATERIAL = DATA.balance.construction.foundationFloorMaterial

export interface GraphWorld {
  readonly world: ConstructionWorld
  readonly data: GameData
  readonly graph: RegionGraph
}

export function graphWorld(size = 24, data: GameData = DATA): GraphWorld {
  const world = createConstructionWorld(size, data)
  const graph = new RegionGraph(size, {
    doorTraverseTicks: data.balance.pathfinding.doorTraverseTicks,
  })
  return { world, data, graph }
}

export function putWall(run: GraphWorld, x: number, y: number): number {
  const index = run.world.grid.idx(x, y)
  run.world.grid.setAt('wallMaterial', index, run.world.materials.indexOf(WALL_MATERIAL))
  run.world.doors.remove(index)
  refreshPassability(run.world, run.data, index)
  return index
}

export function putFloor(run: GraphWorld, x: number, y: number): number {
  const index = run.world.grid.idx(x, y)
  run.world.grid.setAt('floorMaterial', index, run.world.materials.indexOf(FLOOR_MATERIAL))
  run.world.grid.setAt('outdoors', index, 0)
  refreshPassability(run.world, run.data, index)
  return index
}

export function clearWall(run: GraphWorld, x: number, y: number): number {
  const index = run.world.grid.idx(x, y)
  run.world.grid.setAt('wallMaterial', index, NO_MATERIAL)
  run.world.doors.remove(index)
  refreshPassability(run.world, run.data, index)
  return index
}

export function putDoor(
  run: GraphWorld,
  x: number,
  y: number,
  type: DoorType = 'standard',
  locked?: boolean,
): number {
  const index = run.world.grid.idx(x, y)
  const def = run.data.doors.get(type)
  run.world.grid.setAt('wallMaterial', index, NO_MATERIAL)
  const isLocked = locked ?? initialLockState(def)
  run.world.doors.place(index, type, isLocked)
  run.world.grid.setAt('passability', index, doorPassability(def, isLocked))
  return index
}

export function setDoorLocked(run: GraphWorld, tileIndex: number, locked: boolean): void {
  const door = run.world.doors.get(tileIndex)
  if (door === undefined) throw new Error(`no door at ${tileIndex}`)
  door.locked = locked
  const def = run.data.doors.get(door.type)
  run.world.grid.setAt('passability', tileIndex, doorPassability(def, locked))
}

/** An axis-aligned wall rectangle; interior is left alone. */
export function putPerimeter(run: GraphWorld, rect: Rect): void {
  for (let y = rect.y; y < rect.y + rect.height; y += 1) {
    for (let x = rect.x; x < rect.x + rect.width; x += 1) {
      const onEdge =
        x === rect.x ||
        y === rect.y ||
        x === rect.x + rect.width - 1 ||
        y === rect.y + rect.height - 1
      if (!onEdge) continue
      putFloor(run, x, y)
      putWall(run, x, y)
    }
  }
}

/** Floors every tile inside a rect, including the edge. */
export function putFloorRect(run: GraphWorld, rect: Rect): void {
  for (let y = rect.y; y < rect.y + rect.height; y += 1) {
    for (let x = rect.x; x < rect.x + rect.width; x += 1) {
      putFloor(run, x, y)
    }
  }
}

export function rebuildAll(run: GraphWorld) {
  return run.graph.rebuildAll(run.world.grid, run.world.doors, run.data)
}

export function rebuildDirty(run: GraphWorld) {
  return run.graph.rebuildDirty(run.world.grid, run.world.doors, run.data)
}

/**
 * Two rooms side by side sharing a wall, with a door in that wall.
 *
 * Layout (10x6 footprint starting at origin):
 *
 *   ####################
 *   # roomA  D  roomB  #     D = door on the shared wall
 *   #        D         #
 *   ####################
 *
 * The outer ring is wall; interiors are open. The shared wall sits at x = 5.
 */
export function buildTwoRooms(run: GraphWorld): {
  readonly left: number
  readonly right: number
  readonly door: number
  readonly sharedWallAbove: number
} {
  const outer: Rect = { x: 0, y: 0, width: 11, height: 6 }
  putFloorRect(run, outer)
  putPerimeter(run, outer)

  // Shared wall down the middle, leaving the door slot open.
  for (let y = 1; y <= 4; y += 1) {
    putWall(run, 5, y)
  }
  const door = putDoor(run, 5, 2, 'standard')
  const sharedWallAbove = run.world.grid.idx(5, 1)
  const left = run.world.grid.idx(2, 2)
  const right = run.world.grid.idx(8, 2)
  return { left, right, door, sharedWallAbove }
}

/**
 * Three rooms in a line: A --staff--> B --standard--> C.
 *
 * Used to assert that an inmate mask cannot hop the staff door even when a
 * route exists for staff.
 */
export function buildStaffGate(run: GraphWorld): {
  readonly a: number
  readonly b: number
  readonly c: number
  readonly staffDoor: number
  readonly openDoor: number
} {
  const outer: Rect = { x: 0, y: 0, width: 16, height: 6 }
  putFloorRect(run, outer)
  putPerimeter(run, outer)

  for (let y = 1; y <= 4; y += 1) {
    putWall(run, 5, y)
    putWall(run, 10, y)
  }
  const staffDoor = putDoor(run, 5, 2, 'staff', false)
  const openDoor = putDoor(run, 10, 2, 'standard', false)
  return {
    a: run.world.grid.idx(2, 2),
    b: run.world.grid.idx(7, 2),
    c: run.world.grid.idx(12, 2),
    staffDoor,
    openDoor,
  }
}

/** Wall lattice pitch: 3x3 interiors, matching T1.3's cell block. */
export const CELL_PITCH = 4

export interface RoomWing {
  /** Interior tile of room (`column`, `row`). */
  interior(column: number, row: number): number
  /** Door tile from that room into the corridor. */
  door(column: number, row: number): number
  /** A tile on the shared corridor. */
  readonly corridor: number
  readonly rooms: number
}

/**
 * Sixty rooms opening onto a single corridor, on a large map.
 *
 * Thirty cells north of a corridor and thirty south of it. Each cell has one
 * standard door into the corridor. The rest of the 220x220 map stays open
 * outdoor ground, so a door change inside the wing must not re-flood it.
 *
 *     y=0   ████████████████  north outer wall
 *     y=1-3 #room#room#room#  north interiors
 *     y=4   ██D███D███D████  doors into corridor
 *     y=5   #  corridor    #
 *     y=6   ██D███D███D████  doors into corridor
 *     y=7-9 #room#room#room#  south interiors
 *     y=10  ████████████████  south outer wall
 */
export function buildSixtyRoomWing(run: GraphWorld): RoomWing {
  const columns = 30
  const width = columns * CELL_PITCH + 1
  const northWallY = 0
  const northDoorY = CELL_PITCH
  const corridorY = CELL_PITCH + 1
  const southDoorY = CELL_PITCH + 2
  const southOuterY = CELL_PITCH + 2 + CELL_PITCH
  const height = southOuterY + 1

  putFloorRect(run, { x: 0, y: 0, width, height })

  // Horizontal walls: outer shells and the two door walls.
  for (const y of [northWallY, northDoorY, southDoorY, southOuterY]) {
    for (let x = 0; x < width; x += 1) putWall(run, x, y)
  }
  // Vertical cell dividers through both room bands only — not the corridor.
  for (let x = 0; x < width; x += CELL_PITCH) {
    for (let y = northWallY; y <= northDoorY; y += 1) putWall(run, x, y)
    for (let y = southDoorY; y <= southOuterY; y += 1) putWall(run, x, y)
  }
  // Corridor end caps so the wing is sealed from the outdoors.
  putWall(run, 0, corridorY)
  putWall(run, width - 1, corridorY)

  for (let column = 0; column < columns; column += 1) {
    const doorX = column * CELL_PITCH + 2
    putDoor(run, doorX, northDoorY, 'standard', false)
    putDoor(run, doorX, southDoorY, 'standard', false)
  }

  return {
    rooms: columns * 2,
    corridor: run.world.grid.idx(2, corridorY),
    interior(column: number, row: number): number {
      const y = row === 0 ? 1 : southDoorY + 1
      return run.world.grid.idx(column * CELL_PITCH + 1, y)
    },
    door(column: number, row: number): number {
      const y = row === 0 ? northDoorY : southDoorY
      return run.world.grid.idx(column * CELL_PITCH + 2, y)
    },
  }
}
