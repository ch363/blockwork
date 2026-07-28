/**
 * Walls: what counts as one, how a wall run joins up, and how a drawn line
 * becomes a list of tiles (T1.2).
 *
 * The only interesting question here is connectivity, and it has two
 * consumers that must agree. The renderer autotiles a wall from its eight
 * neighbours (T1.6 turns the 256 permutations into the 47 distinct sprites),
 * and room detection treats a wall as a boundary (T1.3). If those two
 * disagreed about whether a door interrupts a wall run, a prison would render
 * with gaps that the simulation says are solid. So there is exactly one
 * predicate, `isWallLike`, and both sides call it: a door is part of the wall
 * run it sits in, because that is what a door frame looks like and what a
 * boundary behaves like.
 *
 * Nothing here writes to the grid. Construction owns mutation, because a wall
 * appearing changes passability, dirty chunks and, later, the region graph,
 * and those have to happen together.
 */

import type { DoorRegistry } from './doors'
import type { TileGrid } from './tileGrid'
import { NO_MATERIAL } from './materials'

/**
 * Neighbour bits, clockwise from north. This ordering is the autotile
 * contract: T1.6's lookup table is indexed by a mask built here, so the bit
 * values may not be reshuffled without regenerating it.
 */
export const WALL_NEIGHBOUR = {
  N: 0b0000_0001,
  NE: 0b0000_0010,
  E: 0b0000_0100,
  SE: 0b0000_1000,
  S: 0b0001_0000,
  SW: 0b0010_0000,
  W: 0b0100_0000,
  NW: 0b1000_0000,
} as const

export type WallNeighbourBit = (typeof WALL_NEIGHBOUR)[keyof typeof WALL_NEIGHBOUR]

export const WALL_CARDINALS =
  WALL_NEIGHBOUR.N | WALL_NEIGHBOUR.E | WALL_NEIGHBOUR.S | WALL_NEIGHBOUR.W

export const WALL_DIAGONALS =
  WALL_NEIGHBOUR.NE | WALL_NEIGHBOUR.SE | WALL_NEIGHBOUR.SW | WALL_NEIGHBOUR.NW

/** Offsets in bit order, so the mask loop is a single pass with no branching. */
const NEIGHBOUR_OFFSETS: readonly (readonly [number, number, number])[] = [
  [0, -1, WALL_NEIGHBOUR.N],
  [1, -1, WALL_NEIGHBOUR.NE],
  [1, 0, WALL_NEIGHBOUR.E],
  [1, 1, WALL_NEIGHBOUR.SE],
  [0, 1, WALL_NEIGHBOUR.S],
  [-1, 1, WALL_NEIGHBOUR.SW],
  [-1, 0, WALL_NEIGHBOUR.W],
  [-1, -1, WALL_NEIGHBOUR.NW],
]

/** A wall stroke. Axis-aligned only: see `wallLineTiles`. */
export interface WallLine {
  readonly x1: number
  readonly y1: number
  readonly x2: number
  readonly y2: number
}

export function isWall(grid: TileGrid, tileIndex: number): boolean {
  return grid.getAt('wallMaterial', tileIndex) !== NO_MATERIAL
}

/**
 * Whether a tile interrupts a wall run. Doors do not: they are built into one.
 */
export function isWallLike(grid: TileGrid, doors: DoorRegistry, tileIndex: number): boolean {
  return isWall(grid, tileIndex) || doors.has(tileIndex)
}

/**
 * The eight-neighbour connectivity mask of a tile, for autotiling.
 *
 * Off-grid neighbours read as absent, so a wall against the map edge tiles as
 * an end rather than as a run continuing into nothing.
 */
export function wallNeighbourMask(
  grid: TileGrid,
  doors: DoorRegistry,
  x: number,
  y: number,
): number {
  let mask = 0
  for (const [dx, dy, bit] of NEIGHBOUR_OFFSETS) {
    const nx = x + dx
    const ny = y + dy
    if (!grid.inBounds(nx, ny)) continue
    if (isWallLike(grid, doors, grid.idx(nx, ny))) mask |= bit
  }
  return mask
}

export function wallNeighbourMaskAt(
  grid: TileGrid,
  doors: DoorRegistry,
  tileIndex: number,
): number {
  const { x, y } = grid.xy(tileIndex)
  return wallNeighbourMask(grid, doors, x, y)
}

export function isAxisAligned(line: WallLine): boolean {
  return line.x1 === line.x2 || line.y1 === line.y2
}

/**
 * The tiles a wall stroke covers, in ascending tile order, clipped to the
 * grid.
 *
 * Axis-aligned only. A diagonal drag is not a wall the player can mean: the
 * grid has no diagonal wall face, and rasterising one would produce a line
 * agents can walk through at every step. Callers reject non-aligned lines with
 * a `CausalEvent` rather than guessing (see `construction.ts`).
 */
export function wallLineTiles(grid: TileGrid, line: WallLine): number[] {
  if (!isAxisAligned(line)) return []

  const size = grid.size
  const x1 = Math.min(line.x1, line.x2)
  const x2 = Math.max(line.x1, line.x2)
  const y1 = Math.min(line.y1, line.y2)
  const y2 = Math.max(line.y1, line.y2)

  const left = Math.max(0, x1)
  const right = Math.min(size - 1, x2)
  const top = Math.max(0, y1)
  const bottom = Math.min(size - 1, y2)

  const tiles: number[] = []
  for (let y = top; y <= bottom; y += 1) {
    for (let x = left; x <= right; x += 1) {
      tiles.push(grid.idx(x, y))
    }
  }
  return tiles
}
