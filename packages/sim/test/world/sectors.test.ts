/**
 * T4.1 — sectors: access mask propagation into the region graph.
 */

import { describe, expect, it } from 'vitest'

import { loadGameData } from '../../src/data/loader'
import {
  ACCESS,
  inmateAccessMask,
} from '../../src/pathfinding/regionGraph'
import { applySectorDerived } from '../../src/world/sectorCommands'
import {
  sectorAccessMask,
  sectorPassabilityBits,
} from '../../src/world/sectors'
import { PASSABILITY } from '../../src/world/tileGrid'
import { createInmateWorld } from '../../src/systems/intakeSystem'
import type { InmateWorld } from '../../src/systems/intakeSystem'
import { refreshPassability } from '../../src/world/construction'
import { initialLockState } from '../../src/world/doors'
import type { Rect } from '../../src/world/construction'

const DATA = loadGameData()

function putFloor(world: InmateWorld, x: number, y: number): number {
  const floor = world.data.balance.construction.foundationFloorMaterial
  const index = world.grid.idx(x, y)
  world.grid.setAt('floorMaterial', index, world.materials.indexOf(floor))
  world.grid.setAt('outdoors', index, 0)
  refreshPassability(world, world.data, index)
  return index
}

function putWall(world: InmateWorld, x: number, y: number): number {
  const index = putFloor(world, x, y)
  world.grid.setAt('wallMaterial', index, world.materials.indexOf('brick_wall'))
  refreshPassability(world, world.data, index)
  return index
}

function putDoor(world: InmateWorld, x: number, y: number): number {
  const index = putFloor(world, x, y)
  world.grid.setAt('wallMaterial', index, 0)
  const def = world.data.doors.get('standard')
  world.doors.place(index, 'standard', initialLockState(def))
  refreshPassability(world, world.data, index)
  return index
}

/** Two rooms linked by a standard door — left at (2,2), right at (8,2). */
function buildTwoRooms(world: InmateWorld): {
  readonly left: number
  readonly right: number
  readonly door: number
  readonly rightTiles: number[]
} {
  const outer: Rect = { x: 0, y: 0, width: 11, height: 6 }
  for (let y = outer.y; y < outer.y + outer.height; y += 1) {
    for (let x = outer.x; x < outer.x + outer.width; x += 1) {
      const onEdge =
        x === outer.x ||
        y === outer.y ||
        x === outer.x + outer.width - 1 ||
        y === outer.y + outer.height - 1
      if (onEdge) putWall(world, x, y)
      else putFloor(world, x, y)
    }
  }
  for (let y = 1; y <= 4; y += 1) putWall(world, 5, y)
  const door = putDoor(world, 5, 2)
  const rightTiles: number[] = []
  for (let y = 1; y <= 4; y += 1) {
    for (let x = 6; x <= 9; x += 1) {
      rightTiles.push(world.grid.idx(x, y))
    }
  }
  return {
    left: world.grid.idx(2, 2),
    right: world.grid.idx(8, 2),
    door,
    rightTiles,
  }
}

describe('sectorAccessMask (T4.1)', () => {
  it('omits the generic inmate bit when a category restriction is set', () => {
    const sector = {
      id: 1,
      name: 'Max wing',
      colour: '#f00',
      access: 'secure' as const,
      categories: ['maximum'],
    }
    const mask = sectorAccessMask(DATA, sector)
    expect(mask & ACCESS.STAFF).toBe(ACCESS.STAFF)
    expect(mask & ACCESS.INMATE).toBe(0)
    expect(mask & inmateAccessMask(DATA, 'maximum')).not.toBe(0)
    expect(mask & inmateAccessMask(DATA, 'minimum')).toBe(0)
  })

  it('stamps STAFF_ONLY / SECURE passability bits from the access mode', () => {
    expect(sectorPassabilityBits('staffOnly')).toBe(PASSABILITY.STAFF_ONLY)
    expect(sectorPassabilityBits('secure')).toBe(PASSABILITY.SECURE)
    expect(sectorPassabilityBits('shared')).toBe(0)
    expect(sectorPassabilityBits('open')).toBe(0)
  })
})

describe('access mask propagation to the region graph (T4.1)', () => {
  it('blocks a minimum inmate from pathing into a maximum-only sector', () => {
    const world = createInmateWorld({ size: 16, data: DATA })
    const rooms = buildTwoRooms(world)
    world.regions.rebuildAll(world.grid, world.doors, DATA, world.sectors)

    const sector = world.sectors.create(DATA, {
      name: 'Maximum wing',
      access: 'secure',
      categories: ['maximum'],
    })
    expect(sector).toBeDefined()
    if (sector === undefined) return

    const painted = world.sectors.paintTiles(world.grid, rooms.rightTiles, sector.id)
    applySectorDerived(world, DATA, painted.changed)

    const minMask = inmateAccessMask(DATA, 'minimum')
    const maxMask = inmateAccessMask(DATA, 'maximum')

    expect(world.regions.findRegionPath(rooms.left, rooms.right, minMask)).toBeNull()
    expect(world.regions.findRegionPath(rooms.left, rooms.right, maxMask)).not.toBeNull()
    expect(world.regions.findRegionPath(rooms.left, rooms.right, ACCESS.STAFF)).not.toBeNull()

    // Directed: leaving the restricted wing into the open side still works for
    // whoever is already inside — the destination sector admits everyone.
    expect(world.regions.findRegionPath(rooms.right, rooms.left, minMask)).not.toBeNull()
  })

  it('propagates the destination sector mask onto the door edge', () => {
    const world = createInmateWorld({ size: 16, data: DATA })
    const rooms = buildTwoRooms(world)
    world.regions.rebuildAll(world.grid, world.doors, DATA, world.sectors)

    const sector = world.sectors.create(DATA, {
      name: 'Maximum wing',
      access: 'secure',
      categories: ['maximum'],
    })
    expect(sector).toBeDefined()
    if (sector === undefined) return

    applySectorDerived(
      world,
      DATA,
      world.sectors.paintTiles(world.grid, rooms.rightTiles, sector.id).changed,
    )

    const leftRegion = world.regions.regionAt(rooms.left)
    const rightRegion = world.regions.regionAt(rooms.right)
    const intoRight = world.regions
      .edgesFrom(leftRegion)
      .filter((edge) => edge.to === rightRegion)
    expect(intoRight).toHaveLength(1)
    const edge = intoRight[0]
    expect(edge).toBeDefined()
    if (edge === undefined) return
    expect(edge.accessMask & inmateAccessMask(DATA, 'maximum')).not.toBe(0)
    expect(edge.accessMask & inmateAccessMask(DATA, 'minimum')).toBe(0)
  })
})
