/**
 * Region graph: coarse routing over rooms and corridors (T2.1).
 */

import { describe, expect, it } from 'vitest'

import {
  ACCESS,
  ACCESS_ALL,
  NO_REGION,
  accessMaskForDoor,
  meanCrossingDistance,
} from '../../src/pathfinding/regionGraph'
import { loadGameData } from '../../src/data/loader'

import {
  buildSixtyRoomWing,
  buildStaffGate,
  buildTwoRooms,
  clearWall,
  graphWorld,
  putDoor,
  putFloor,
  putPerimeter,
  putWall,
  rebuildAll,
  rebuildDirty,
  setDoorLocked,
} from './regionFixture'

const DATA = loadGameData()

describe('accessMaskForDoor (T2.1)', () => {
  it('admits nobody through a locked door', () => {
    expect(accessMaskForDoor(DATA.doors.get('standard'), true)).toBe(0)
    expect(accessMaskForDoor(DATA.doors.get('staff'), true)).toBe(0)
  })

  it('restricts staff doors to staff and leaves standard doors open', () => {
    expect(accessMaskForDoor(DATA.doors.get('staff'), false)).toBe(ACCESS.STAFF)
    expect(accessMaskForDoor(DATA.doors.get('standard'), false)).toBe(ACCESS_ALL)
    expect(accessMaskForDoor(DATA.doors.get('secure'), false)).toBe(ACCESS_ALL)
  })
})

describe('graph correctness (T2.1)', () => {
  it('partitions two rooms linked by a door into two nodes and one bridge', () => {
    const run = graphWorld(16)
    const rooms = buildTwoRooms(run)
    const update = rebuildAll(run)

    expect(update.nodeCount).toBeGreaterThanOrEqual(2)

    const left = run.graph.regionAt(rooms.left)
    const right = run.graph.regionAt(rooms.right)
    expect(left).not.toBe(NO_REGION)
    expect(right).not.toBe(NO_REGION)
    expect(left).not.toBe(right)
    expect(run.graph.regionAt(rooms.door)).toBe(NO_REGION)

    const across = run.graph.edgesFrom(left).filter((edge) => edge.to === right)
    expect(across).toHaveLength(1)
    expect(across[0]?.doorTile).toBe(rooms.door)
    expect(across[0]?.accessMask).toBe(ACCESS_ALL)

    const dest = run.graph.getRegion(right)
    expect(dest).toBeDefined()
    expect(across[0]?.cost).toBe(
      run.graph.doorTraverseTicks + (dest?.meanCrossingDistance ?? 0),
    )

    const path = run.graph.findRegionPath(rooms.left, rooms.right, ACCESS.INMATE)
    expect(path).toEqual([left, right])
  })

  it('returns a one-node path when start and goal share a region', () => {
    const run = graphWorld(12)
    putFloor(run, 3, 3)
    putFloor(run, 4, 3)
    rebuildAll(run)

    const a = run.world.grid.idx(3, 3)
    const b = run.world.grid.idx(4, 3)
    const region = run.graph.regionAt(a)
    expect(region).not.toBe(NO_REGION)
    expect(run.graph.regionAt(b)).toBe(region)
    expect(run.graph.findRegionPath(a, b, ACCESS_ALL)).toEqual([region])
  })

  it('returns null when the goal tile has no region', () => {
    const run = graphWorld(12)
    putFloor(run, 2, 2)
    putWall(run, 4, 4)
    rebuildAll(run)

    expect(run.graph.findRegionPath(run.world.grid.idx(2, 2), run.world.grid.idx(4, 4), ACCESS_ALL)).toBeNull()
  })

  it('derives mean crossing distance from the region bounds', () => {
    expect(meanCrossingDistance({ x: 0, y: 0, width: 3, height: 5 })).toBe(4)
    expect(meanCrossingDistance({ x: 0, y: 0, width: 1, height: 1 })).toBe(1)
  })
})

describe('access mask filtering (T2.1)', () => {
  it('lets staff cross a staff door and refuses inmates', () => {
    const run = graphWorld(20)
    const gate = buildStaffGate(run)
    rebuildAll(run)

    const staffPath = run.graph.findRegionPath(gate.a, gate.c, ACCESS.STAFF)
    expect(staffPath).not.toBeNull()
    expect(staffPath?.length).toBe(3)

    expect(run.graph.findRegionPath(gate.a, gate.c, ACCESS.INMATE)).toBeNull()
    expect(run.graph.findRegionPath(gate.b, gate.c, ACCESS.INMATE)).not.toBeNull()
  })

  it('returns null through a locked door even for staff', () => {
    const run = graphWorld(16)
    const rooms = buildTwoRooms(run)
    setDoorLocked(run, rooms.door, true)
    rebuildAll(run)

    expect(run.graph.findRegionPath(rooms.left, rooms.right, ACCESS.STAFF)).toBeNull()
    expect(run.graph.edgesThroughDoor(rooms.door)[0]?.accessMask).toBe(0)
  })
})

describe('incremental rebuild scoping (T2.1)', () => {
  it('rewrites only the changed door when a lock flips', () => {
    const run = graphWorld(16)
    const rooms = buildTwoRooms(run)
    rebuildAll(run)
    const before = run.graph.regions().map((region) => region.id)

    setDoorLocked(run, rooms.door, true)
    run.graph.markDirty([rooms.door])
    const update = rebuildDirty(run)

    expect(update.rebuilt).toEqual([])
    expect(update.tilesVisited).toBe(0)
    expect(update.doorsUpdated).toEqual([rooms.door])
    expect(run.graph.regions().map((region) => region.id)).toEqual(before)
    expect(run.graph.findRegionPath(rooms.left, rooms.right, ACCESS_ALL)).toBeNull()
  })

  it('re-floods only the rooms that a wall breach merges', () => {
    const run = graphWorld(16)
    const rooms = buildTwoRooms(run)
    rebuildAll(run)

    const leftBefore = run.graph.regionAt(rooms.left)
    const rightBefore = run.graph.regionAt(rooms.right)
    expect(leftBefore).not.toBe(rightBefore)

    clearWall(run, 5, 1)
    run.graph.markDirty([rooms.sharedWallAbove])
    const update = rebuildDirty(run)

    expect(update.tilesVisited).toBeGreaterThan(0)
    expect(update.rebuilt.length).toBeGreaterThanOrEqual(1)
    expect(update.rebuilt.length).toBeLessThanOrEqual(2)

    const leftAfter = run.graph.regionAt(rooms.left)
    const rightAfter = run.graph.regionAt(rooms.right)
    expect(leftAfter).not.toBe(NO_REGION)
    expect(leftAfter).toBe(rightAfter)
    expect(run.graph.findRegionPath(rooms.left, rooms.right, ACCESS_ALL)).toEqual([leftAfter])
  })

  it('splits a region when a wall closes a gap, without touching distant rooms', () => {
    const run = graphWorld(24)
    putPerimeter(run, { x: 0, y: 0, width: 11, height: 6 })
    for (let y = 1; y <= 4; y += 1) putWall(run, 5, y)
    putDoor(run, 5, 2, 'standard', false)

    // Distant sealed room in the far corner.
    putPerimeter(run, { x: 16, y: 16, width: 5, height: 5 })
    const distant = run.world.grid.idx(18, 18)
    rebuildAll(run)
    const distantRegion = run.graph.regionAt(distant)
    expect(distantRegion).not.toBe(NO_REGION)

    // Open the shared wall, rebuild, then close it again and assert scoping.
    clearWall(run, 5, 3)
    run.graph.markDirty([run.world.grid.idx(5, 3)])
    rebuildDirty(run)

    putWall(run, 5, 3)
    run.graph.markDirty([run.world.grid.idx(5, 3)])
    const update = rebuildDirty(run)

    expect(update.rebuilt.length).toBeGreaterThanOrEqual(1)
    expect(run.graph.regionAt(distant)).toBe(distantRegion)
    expect(update.rebuilt).not.toContain(distantRegion)
  })
})

describe('region graph performance (T2.1)', () => {
  it('stays under 200 nodes on a 220x220 map with 60 rooms and rebuilds a door change in under 1ms', () => {
    const run = graphWorld(220)
    const wing = buildSixtyRoomWing(run)
    const full = rebuildAll(run)

    expect(wing.rooms).toBe(60)
    expect(full.nodeCount).toBeLessThan(200)

    const door = wing.door(0, 0)
    const samples: number[] = []

    for (let iteration = 0; iteration < 60; iteration += 1) {
      setDoorLocked(run, door, iteration % 2 === 0)
      run.graph.markDirty([door])

      const started = performance.now()
      const update = rebuildDirty(run)
      samples.push(performance.now() - started)

      expect(update.rebuilt).toEqual([])
      expect(update.doorsUpdated).toEqual([door])
    }

    samples.sort((a, b) => a - b)
    const median = samples[Math.floor(samples.length / 2)] ?? Number.POSITIVE_INFINITY
    expect(median).toBeLessThan(1)
    expect(run.graph.nodeCount).toBeLessThan(200)

    const path = run.graph.findRegionPath(wing.interior(0, 0), wing.interior(29, 1), ACCESS.INMATE)
    // Final iteration leaves the door unlocked (59 % 2 !== 0).
    expect(path).not.toBeNull()
    expect(path?.length).toBeGreaterThanOrEqual(3)
  })
})
