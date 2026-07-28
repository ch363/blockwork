import { describe, expect, it } from 'vitest'

import { isJsonArray } from '../../src/core/commands'
import {
  demolish,
  demolitionRefund,
  paintFloor,
  placeDoor,
  placeFoundation,
  placeWall,
  queueSite,
  refreshPassability,
  removeWall,
} from '../../src/world/construction'
import type { Rect } from '../../src/world/construction'
import { NO_MATERIAL } from '../../src/world/materials'
import { PASSABILITY } from '../../src/world/tileGrid'
import { wallNeighbourMask } from '../../src/world/walls'

import {
  DATA,
  FLOOR_MATERIAL,
  FOUNDATION_FLOOR,
  WALL_MATERIAL,
  interiorTiles,
  perimeterTiles,
  scenario,
  walkableFrom,
} from './constructionFixture'

/** The acceptance case: a 10x8 shell. */
const SHELL: Rect = { x: 4, y: 3, width: 10, height: 8 }

const OUTSIDE = { x: 0, y: 0 }
const INSIDE = { x: SHELL.x + 1, y: SHELL.y + 1 }

const REFUND_FRACTION = DATA.balance.construction.materialRefundOnDemolish
const WALL_COST = DATA.materials.get(WALL_MATERIAL).costPerTile
const FOUNDATION_FLOOR_COST = DATA.materials.get(FOUNDATION_FLOOR).costPerTile

describe('PlaceFoundation (T1.2)', () => {
  it('queues a wall on every perimeter tile and a floor on every interior tile', () => {
    const run = scenario({ workers: 0 })

    const queued = placeFoundation(run.deps(), SHELL, WALL_MATERIAL)

    expect(queued).toBe(SHELL.width * SHELL.height)
    expect(run.world.sites.size).toBe(SHELL.width * SHELL.height)

    for (const index of perimeterTiles(run.world, SHELL)) {
      expect(run.world.sites.get(index)?.job).toEqual({
        kind: 'wall',
        material: WALL_MATERIAL,
        foundation: true,
      })
    }
    for (const index of interiorTiles(run.world, SHELL)) {
      expect(run.world.sites.get(index)?.job).toEqual({
        kind: 'floor',
        material: FOUNDATION_FLOOR,
        foundation: true,
      })
    }
  })

  it('changes nothing until the work is done', () => {
    const run = scenario({ workers: 0 })
    placeFoundation(run.deps(), SHELL, WALL_MATERIAL)

    run.sim.step()

    const corner = run.world.grid.idx(SHELL.x, SHELL.y)
    expect(run.world.grid.getAt('wallMaterial', corner)).toBe(NO_MATERIAL)
    expect(run.world.grid.getAt('passability', corner) & PASSABILITY.WALKABLE).toBe(
      PASSABILITY.WALKABLE,
    )
  })

  it('builds a closed shell: walls round the edge, floor inside, all of it indoors', () => {
    const run = scenario()
    placeFoundation(run.deps(), SHELL, WALL_MATERIAL)
    run.runUntilIdle()

    const grid = run.world.grid
    const wallIndex = run.world.materials.indexOf(WALL_MATERIAL)
    const floorIndex = run.world.materials.indexOf(FOUNDATION_FLOOR)

    for (const index of perimeterTiles(run.world, SHELL)) {
      expect(grid.getAt('wallMaterial', index)).toBe(wallIndex)
      expect(grid.getAt('passability', index)).toBe(0)
      expect(grid.getAt('outdoors', index)).toBe(0)
    }

    for (const index of interiorTiles(run.world, SHELL)) {
      expect(grid.getAt('wallMaterial', index)).toBe(NO_MATERIAL)
      expect(grid.getAt('floorMaterial', index)).toBe(floorIndex)
      expect(grid.getAt('passability', index)).toBe(PASSABILITY.WALKABLE)
      expect(grid.getAt('outdoors', index)).toBe(0)
    }

    // Nothing leaked outside the footprint.
    expect(grid.getAt('wallMaterial', grid.idx(SHELL.x - 1, SHELL.y))).toBe(NO_MATERIAL)
    expect(grid.getAt('outdoors', grid.idx(SHELL.x - 1, SHELL.y))).toBe(1)
  })

  it('produces wall autotiling data that joins the shell up', () => {
    const run = scenario()
    placeFoundation(run.deps(), SHELL, WALL_MATERIAL)
    run.runUntilIdle()

    const { grid, doors } = run.world
    const mask = (x: number, y: number): number => wallNeighbourMask(grid, doors, x, y)
    const right = SHELL.x + SHELL.width - 1
    const bottom = SHELL.y + SHELL.height - 1

    // Corners connect along the two edges they belong to, and nowhere else:
    // the tile diagonally inwards is floor.
    expect(mask(SHELL.x, SHELL.y)).toBe(0b0001_0100) // E | S
    expect(mask(right, SHELL.y)).toBe(0b0101_0000) // S | W
    expect(mask(SHELL.x, bottom)).toBe(0b0000_0101) // N | E
    expect(mask(right, bottom)).toBe(0b0100_0001) // N | W

    // A tile in the middle of the top run: neighbours left and right, plus the
    // two diagonals that are also on the run.
    const topMiddle = mask(SHELL.x + 4, SHELL.y)
    expect(topMiddle & 0b0100_0100).toBe(0b0100_0100) // E | W
    expect(topMiddle & 0b0001_0000).toBe(0) // nothing to the south

    // Every wall of a closed shell is joined to at least two others.
    for (const index of perimeterTiles(run.world, SHELL)) {
      const { x, y } = grid.xy(index)
      const cardinals = mask(x, y) & 0b0101_0101
      const joins = [1, 4, 16, 64].filter((bit) => (cardinals & bit) !== 0).length
      expect(joins).toBeGreaterThanOrEqual(2)
    }
  })

  it('seals the interior off from the outside', () => {
    const run = scenario()
    placeFoundation(run.deps(), SHELL, WALL_MATERIAL)
    run.runUntilIdle()

    const outside = walkableFrom(run.world, OUTSIDE)
    const inside = walkableFrom(run.world, INSIDE)

    expect(inside.size).toBe(interiorTiles(run.world, SHELL).length)
    for (const index of inside) {
      expect(outside.has(index)).toBe(false)
    }
  })
})

describe('passability after each operation (PRD 4.3, 4.5)', () => {
  it('starts open: bare ground is walkable', () => {
    const run = scenario()
    const index = run.world.grid.idx(2, 2)

    expect(run.world.grid.getAt('passability', index)).toBe(PASSABILITY.WALKABLE)
  })

  it('PlaceWall blocks the tile once built', () => {
    const run = scenario()
    const index = run.world.grid.idx(6, 6)

    placeWall(run.deps(), { x1: 6, y1: 6, x2: 6, y2: 6 }, WALL_MATERIAL)
    expect(run.world.grid.getAt('passability', index)).toBe(PASSABILITY.WALKABLE)

    run.runUntilIdle()
    expect(run.world.grid.getAt('passability', index)).toBe(0)
  })

  it('RemoveWall on one tile lets the outside walk in', () => {
    const run = scenario()
    placeFoundation(run.deps(), SHELL, WALL_MATERIAL)
    run.runUntilIdle()

    const breach = { x: SHELL.x + 3, y: SHELL.y }
    const breachIndex = run.world.grid.idx(breach.x, breach.y)
    expect(walkableFrom(run.world, OUTSIDE).has(run.world.grid.idx(INSIDE.x, INSIDE.y))).toBe(false)

    removeWall(run.deps(), { x1: breach.x, y1: breach.y, x2: breach.x, y2: breach.y })
    run.runUntilIdle()

    expect(run.world.grid.getAt('wallMaterial', breachIndex)).toBe(NO_MATERIAL)
    expect(run.world.grid.getAt('passability', breachIndex)).toBe(PASSABILITY.WALKABLE)
    expect(walkableFrom(run.world, OUTSIDE).has(run.world.grid.idx(INSIDE.x, INSIDE.y))).toBe(true)
  })

  it('PlaceDoor opens a wall to whoever the door type admits', () => {
    const run = scenario()
    placeFoundation(run.deps(), SHELL, WALL_MATERIAL)
    run.runUntilIdle()

    const tile = { x: SHELL.x + 5, y: SHELL.y }
    const index = run.world.grid.idx(tile.x, tile.y)

    expect(placeDoor(run.deps(), tile, 'staff')).toBe(true)
    run.runUntilIdle()

    // The door takes the wall segment rather than sitting beside it.
    expect(run.world.grid.getAt('wallMaterial', index)).toBe(NO_MATERIAL)
    expect(run.world.doors.get(index)?.type).toBe('staff')
    expect(run.world.grid.getAt('passability', index)).toBe(
      PASSABILITY.WALKABLE | PASSABILITY.DOOR | PASSABILITY.STAFF_ONLY,
    )
    expect(walkableFrom(run.world, OUTSIDE).has(run.world.grid.idx(INSIDE.x, INSIDE.y))).toBe(true)
  })

  it('a door that starts locked keeps the shell shut until it is unlocked', () => {
    const run = scenario()
    placeFoundation(run.deps(), SHELL, WALL_MATERIAL)
    run.runUntilIdle()

    const tile = { x: SHELL.x + 5, y: SHELL.y }
    const index = run.world.grid.idx(tile.x, tile.y)

    placeDoor(run.deps(), tile, 'barred')
    run.runUntilIdle()

    expect(run.world.doors.get(index)?.locked).toBe(true)
    expect(run.world.grid.getAt('passability', index) & PASSABILITY.DOOR).toBe(PASSABILITY.DOOR)
    expect(run.world.grid.getAt('passability', index) & PASSABILITY.WALKABLE).toBe(0)
    expect(walkableFrom(run.world, OUTSIDE).has(run.world.grid.idx(INSIDE.x, INSIDE.y))).toBe(false)

    run.world.doors.setLocked(index, false)
    refreshPassability(run.world, DATA, index)

    expect(walkableFrom(run.world, OUTSIDE).has(run.world.grid.idx(INSIDE.x, INSIDE.y))).toBe(true)
  })

  it('PaintFloor changes the surface without changing the walk or the roof', () => {
    const run = scenario()
    const area: Rect = { x: 15, y: 15, width: 3, height: 2 }

    paintFloor(run.deps(), area, FLOOR_MATERIAL)
    run.runUntilIdle()

    const index = run.world.grid.idx(15, 15)
    expect(run.world.grid.getAt('floorMaterial', index)).toBe(
      run.world.materials.indexOf(FLOOR_MATERIAL),
    )
    expect(run.world.grid.getAt('passability', index)).toBe(PASSABILITY.WALKABLE)
    // A paved yard is still a yard.
    expect(run.world.grid.getAt('outdoors', index)).toBe(1)
  })

  it('Demolish takes the wall, the door and the floor, and puts the sky back', () => {
    const run = scenario()
    placeFoundation(run.deps(), SHELL, WALL_MATERIAL)
    run.runUntilIdle()
    placeDoor(run.deps(), { x: SHELL.x + 5, y: SHELL.y }, 'standard')
    run.runUntilIdle()

    demolish(run.deps(), SHELL)
    run.runUntilIdle()

    const grid = run.world.grid
    expect(run.world.doors.size).toBe(0)
    for (const index of [...perimeterTiles(run.world, SHELL), ...interiorTiles(run.world, SHELL)]) {
      expect(grid.getAt('wallMaterial', index)).toBe(NO_MATERIAL)
      expect(grid.getAt('floorMaterial', index)).toBe(NO_MATERIAL)
      expect(grid.getAt('outdoors', index)).toBe(1)
      expect(grid.getAt('passability', index)).toBe(PASSABILITY.WALKABLE)
    }
  })

  it('marks the chunk of a finished tile dirty, and its neighbours with it', () => {
    const run = scenario()
    placeWall(run.deps(), { x1: 20, y1: 20, x2: 20, y2: 20 }, WALL_MATERIAL)
    run.world.grid.consumeDirtyChunks()

    run.runUntilIdle()

    const dirty = run.world.grid.consumeDirtyChunks()
    expect(dirty).toContain(run.world.grid.chunkIdAt(20, 20))
  })
})

describe('demolition refunds (balance.construction.materialRefundOnDemolish)', () => {
  it('returns the configured share of what stood on the tile', () => {
    const run = scenario()
    placeWall(run.deps(), { x1: 8, y1: 8, x2: 8, y2: 8 }, WALL_MATERIAL)
    run.runUntilIdle()

    const index = run.world.grid.idx(8, 8)
    expect(demolitionRefund(run.world, DATA, index, { wall: true, floor: true })).toBe(
      Math.floor(WALL_COST * REFUND_FRACTION),
    )

    demolish(run.deps(), { x: 8, y: 8, width: 1, height: 1 })
    run.runUntilIdle()

    expect(run.world.refundsOwed).toBe(Math.floor(WALL_COST * REFUND_FRACTION))
    expect(run.world.takeRefunds()).toBe(Math.floor(WALL_COST * REFUND_FRACTION))
    expect(run.world.refundsOwed).toBe(0)
  })

  it('refunds half of a whole foundation, wall by wall and floor by floor', () => {
    const run = scenario()
    placeFoundation(run.deps(), SHELL, WALL_MATERIAL)
    run.runUntilIdle()

    const walls = perimeterTiles(run.world, SHELL).length
    const floors = interiorTiles(run.world, SHELL).length
    const spent = walls * WALL_COST + floors * FOUNDATION_FLOOR_COST

    demolish(run.deps(), SHELL)
    run.runUntilIdle()

    const expected =
      walls * Math.floor(WALL_COST * REFUND_FRACTION) +
      floors * Math.floor(FOUNDATION_FLOOR_COST * REFUND_FRACTION)

    expect(run.world.refundsOwed).toBe(expected)
    expect(run.world.refundsOwed).toBe(spent * REFUND_FRACTION)
  })

  it('counts a door on the tile as well as the wall it replaced', () => {
    const run = scenario()
    const tile = { x: 9, y: 9 }
    placeDoor(run.deps(), tile, 'secure')
    run.runUntilIdle()

    const doorCost = DATA.doors.get('secure').cost
    demolish(run.deps(), { x: tile.x, y: tile.y, width: 1, height: 1 })
    run.runUntilIdle()

    expect(run.world.refundsOwed).toBe(Math.floor(doorCost * REFUND_FRACTION))
  })

  it('refunds nothing for clearing bare ground', () => {
    const run = scenario()

    expect(demolish(run.deps(), { x: 2, y: 2, width: 3, height: 3 })).toBe(0)
    run.sim.step()

    expect(run.world.refundsOwed).toBe(0)
  })
})

describe('queueing rules', () => {
  it('drops an order for something that is already there', () => {
    const run = scenario()
    placeWall(run.deps(), { x1: 5, y1: 5, x2: 5, y2: 5 }, WALL_MATERIAL)
    run.runUntilIdle()

    expect(placeWall(run.deps(), { x1: 5, y1: 5, x2: 5, y2: 5 }, WALL_MATERIAL)).toBe(0)
    expect(run.world.sites.size).toBe(0)
  })

  it('drops a duplicate order rather than queueing it twice', () => {
    const run = scenario({ workers: 0 })
    placeWall(run.deps(), { x1: 5, y1: 5, x2: 7, y2: 5 }, WALL_MATERIAL)

    expect(placeWall(run.deps(), { x1: 5, y1: 5, x2: 7, y2: 5 }, WALL_MATERIAL)).toBe(0)
    expect(run.world.sites.size).toBe(3)
  })

  it('replaces a pending order when the tile is ordered to be something else', () => {
    const run = scenario({ workers: 0 })
    const index = run.world.grid.idx(5, 5)

    placeWall(run.deps(), { x1: 5, y1: 5, x2: 5, y2: 5 }, WALL_MATERIAL)
    const first = run.world.sites.get(index)?.id

    paintFloor(run.deps(), { x: 5, y: 5, width: 1, height: 1 }, FLOOR_MATERIAL)

    expect(run.world.sites.size).toBe(1)
    expect(run.world.sites.get(index)?.job.kind).toBe('floor')
    expect(run.world.sites.get(index)?.id).not.toBe(first)
    expect(run.events.of('construction.site.cancelled')).toHaveLength(1)
  })

  it('cancels a pending order when the tile is ordered back to how it already is', () => {
    const run = scenario({ workers: 0 })
    const index = run.world.grid.idx(5, 5)

    placeWall(run.deps(), { x1: 5, y1: 5, x2: 5, y2: 5 }, WALL_MATERIAL)
    expect(run.world.sites.size).toBe(1)

    // The tile is bare ground already, so demolishing it means "never mind".
    demolish(run.deps(), { x: 5, y: 5, width: 1, height: 1 })

    expect(run.world.sites.has(index)).toBe(false)
    expect(run.events.of('construction.site.cancelled')[0]?.data).toMatchObject({
      reason: 'superseded',
    })
  })

  it('prices a site and bills it for its materials', () => {
    const run = scenario({ workers: 0 })
    const index = run.world.grid.idx(5, 5)

    queueSite(run.deps(), index, { kind: 'wall', material: WALL_MATERIAL, foundation: false })
    const site = run.world.sites.get(index)

    expect(site?.cost).toBe(WALL_COST)
    expect(site?.requirements).toEqual([{ itemId: WALL_MATERIAL, units: 1 }])
    expect(site?.workTicksRequired).toBe(DATA.materials.get(WALL_MATERIAL).buildMinutes * 10)
  })
})

describe('rejected commands emit a CausalEvent (CLAUDE.md rule 5)', () => {
  const reasonsFor = (run: ReturnType<typeof scenario>): unknown[] =>
    run.events.of('construction.rejected').map((event) => {
      const data = event.data
      if (data === null || typeof data !== 'object' || isJsonArray(data)) return undefined
      return data['reason']
    })

  it('names a material that does not exist', () => {
    const run = scenario()
    expect(placeWall(run.deps(), { x1: 1, y1: 1, x2: 3, y2: 1 }, 'unobtainium')).toBe(0)
    expect(reasonsFor(run)).toEqual(['unknown-material'])
  })

  it('refuses a floor material as a wall', () => {
    const run = scenario()
    expect(placeFoundation(run.deps(), SHELL, FLOOR_MATERIAL)).toBe(0)
    expect(reasonsFor(run)).toEqual(['wrong-surface'])
  })

  it('refuses a diagonal wall stroke', () => {
    const run = scenario()
    expect(placeWall(run.deps(), { x1: 1, y1: 1, x2: 4, y2: 4 }, WALL_MATERIAL)).toBe(0)
    expect(reasonsFor(run)).toEqual(['invalid-line'])
  })

  it('refuses a rectangle that is entirely off the map', () => {
    const run = scenario()
    expect(paintFloor(run.deps(), { x: 100, y: 100, width: 4, height: 4 }, FLOOR_MATERIAL)).toBe(0)
    expect(reasonsFor(run)).toEqual(['off-grid'])
  })

  it('refuses a rectangle with no area', () => {
    const run = scenario()
    expect(paintFloor(run.deps(), { x: 1, y: 1, width: 0, height: 4 }, FLOOR_MATERIAL)).toBe(0)
    expect(reasonsFor(run)).toEqual(['invalid-rect'])
  })

  it('clips a rectangle that only partly overhangs the map', () => {
    const run = scenario({ size: 20 })
    expect(paintFloor(run.deps(), { x: 18, y: 18, width: 4, height: 4 }, FLOOR_MATERIAL)).toBe(4)
    expect(run.events.of('construction.rejected')).toHaveLength(0)
  })
})

describe('commands across the worker boundary (PRD 4.6)', () => {
  it('applies a foundation sent as a serialised command', () => {
    const run = scenario()

    run.sim.enqueue({
      type: 'construction.placeFoundation',
      payload: { rect: { ...SHELL }, material: WALL_MATERIAL },
      issuedAtTick: 0,
    })
    run.sim.step()

    expect(run.world.sites.size).toBe(SHELL.width * SHELL.height)
    run.runUntilIdle()

    expect(run.world.grid.getAt('wallMaterial', run.world.grid.idx(SHELL.x, SHELL.y))).toBe(
      run.world.materials.indexOf(WALL_MATERIAL),
    )
  })

  it('reports a malformed payload instead of throwing inside the tick', () => {
    const run = scenario()

    run.sim.enqueue({
      type: 'construction.placeDoor',
      payload: { tile: { x: 1 }, doorType: 'standard' },
      issuedAtTick: 0,
    })
    run.sim.step()

    expect(run.world.sites.size).toBe(0)
    expect(run.events.of('construction.rejected')[0]?.data).toMatchObject({
      reason: 'invalid-payload',
    })
  })

  it('runs identically twice from the same seed and command list', () => {
    const build = (): number => {
      const run = scenario()
      run.sim.enqueue({
        type: 'construction.placeFoundation',
        payload: { rect: { ...SHELL }, material: WALL_MATERIAL },
        issuedAtTick: 0,
      })
      run.sim.enqueue({
        type: 'construction.placeDoor',
        payload: { tile: { x: SHELL.x + 2, y: SHELL.y }, doorType: 'secure' },
        issuedAtTick: 0,
      })
      run.runUntilIdle()
      return run.sim.hash()
    }

    expect(build()).toBe(build())
  })
})
