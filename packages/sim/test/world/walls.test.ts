import { beforeEach, describe, expect, it } from 'vitest'

import { DoorRegistry } from '../../src/world/doors'
import { MaterialTable } from '../../src/world/materials'
import { TileGrid } from '../../src/world/tileGrid'
import {
  WALL_CARDINALS,
  WALL_NEIGHBOUR,
  isAxisAligned,
  isWall,
  isWallLike,
  wallLineTiles,
  wallNeighbourMask,
  wallNeighbourMaskAt,
} from '../../src/world/walls'

const MATERIALS = MaterialTable.from(['brick_wall'])
const BRICK = MATERIALS.indexOf('brick_wall')

const { N, NE, E, SE, S, SW, W, NW } = WALL_NEIGHBOUR

describe('wall connectivity and autotiling (T1.2, feeds T1.6)', () => {
  let grid: TileGrid
  let doors: DoorRegistry

  beforeEach(() => {
    grid = TileGrid.allocate(16)
    doors = new DoorRegistry()
  })

  const wall = (x: number, y: number): void => {
    grid.set('wallMaterial', x, y, BRICK)
  }

  it('reports walls, doors and empty tiles apart', () => {
    wall(2, 2)
    doors.place(grid.idx(3, 2), 'standard', false)

    expect(isWall(grid, grid.idx(2, 2))).toBe(true)
    expect(isWall(grid, grid.idx(3, 2))).toBe(false)
    expect(isWall(grid, grid.idx(4, 2))).toBe(false)

    // A door is part of the wall run it is built into.
    expect(isWallLike(grid, doors, grid.idx(2, 2))).toBe(true)
    expect(isWallLike(grid, doors, grid.idx(3, 2))).toBe(true)
    expect(isWallLike(grid, doors, grid.idx(4, 2))).toBe(false)
  })

  it('masks a straight run and its ends', () => {
    for (let x = 2; x <= 6; x += 1) wall(x, 1)

    expect(wallNeighbourMask(grid, doors, 4, 1)).toBe(E | W)
    expect(wallNeighbourMask(grid, doors, 2, 1)).toBe(E)
    expect(wallNeighbourMask(grid, doors, 6, 1)).toBe(W)
  })

  it('masks a corner', () => {
    wall(10, 10)
    wall(11, 10)
    wall(10, 11)

    expect(wallNeighbourMask(grid, doors, 10, 10)).toBe(E | S)
    expect(wallNeighbourMask(grid, doors, 11, 10)).toBe(W | SW)
    expect(wallNeighbourMask(grid, doors, 10, 11)).toBe(N | NE)
  })

  it('masks a cross and the T-junction left when an arm goes', () => {
    // A plus sign centred on (5,5), each arm two tiles long.
    for (let offset = 1; offset <= 2; offset += 1) {
      wall(5 - offset, 5)
      wall(5 + offset, 5)
      wall(5, 5 - offset)
      wall(5, 5 + offset)
    }
    wall(5, 5)

    expect(wallNeighbourMask(grid, doors, 5, 5)).toBe(N | E | S | W)
    expect(wallNeighbourMask(grid, doors, 7, 5) & WALL_CARDINALS).toBe(W)

    grid.set('wallMaterial', 5, 4, 0)
    grid.set('wallMaterial', 5, 3, 0)

    expect(wallNeighbourMask(grid, doors, 5, 5)).toBe(E | S | W)
  })

  it('counts diagonals only when a diagonal neighbour is really there', () => {
    wall(4, 4)
    wall(5, 5)

    expect(wallNeighbourMask(grid, doors, 4, 4)).toBe(SE)
    expect(wallNeighbourMask(grid, doors, 5, 5)).toBe(NW)
  })

  it('keeps a wall run continuous through a door', () => {
    for (let x = 2; x <= 6; x += 1) wall(x, 8)
    grid.set('wallMaterial', 4, 8, 0)
    doors.place(grid.idx(4, 8), 'secure', false)

    expect(wallNeighbourMask(grid, doors, 3, 8)).toBe(E | W)
    expect(wallNeighbourMaskAt(grid, doors, grid.idx(5, 8))).toBe(E | W)
  })

  it('treats the map edge as the end of a run, not as more wall', () => {
    wall(0, 0)
    wall(1, 0)
    wall(0, 1)

    expect(wallNeighbourMask(grid, doors, 0, 0)).toBe(E | S)
    expect(wallNeighbourMask(grid, doors, 0, 0) & (N | W | NW | NE | SW)).toBe(0)
  })
})

describe('wallLineTiles', () => {
  const grid = TileGrid.allocate(16)

  it('walks a horizontal and a vertical stroke in tile order', () => {
    expect(wallLineTiles(grid, { x1: 2, y1: 3, x2: 5, y2: 3 })).toEqual([
      grid.idx(2, 3),
      grid.idx(3, 3),
      grid.idx(4, 3),
      grid.idx(5, 3),
    ])

    expect(wallLineTiles(grid, { x1: 7, y1: 4, x2: 7, y2: 2 })).toEqual([
      grid.idx(7, 2),
      grid.idx(7, 3),
      grid.idx(7, 4),
    ])
  })

  it('accepts a stroke drawn in either direction', () => {
    expect(wallLineTiles(grid, { x1: 5, y1: 3, x2: 2, y2: 3 })).toEqual(
      wallLineTiles(grid, { x1: 2, y1: 3, x2: 5, y2: 3 }),
    )
  })

  it('clips to the grid instead of throwing', () => {
    expect(wallLineTiles(grid, { x1: -3, y1: 0, x2: 1, y2: 0 })).toEqual([
      grid.idx(0, 0),
      grid.idx(1, 0),
    ])
    expect(wallLineTiles(grid, { x1: 20, y1: 0, x2: 30, y2: 0 })).toEqual([])
  })

  it('refuses a diagonal stroke, which the grid cannot represent', () => {
    expect(isAxisAligned({ x1: 1, y1: 1, x2: 4, y2: 4 })).toBe(false)
    expect(wallLineTiles(grid, { x1: 1, y1: 1, x2: 4, y2: 4 })).toEqual([])
  })
})
