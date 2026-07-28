/**
 * T4.1 — posts: satisfaction, time windows, patrol looping, unfilled reasons.
 */

import { describe, expect, it } from 'vitest'

import type { SimulationEvent } from '../../src/core/simulation'
import { loadGameData } from '../../src/data/loader'
import { hireStaff } from '../../src/entities/staff'
import { createInmateWorld } from '../../src/systems/intakeSystem'
import type { InmateWorld } from '../../src/systems/intakeSystem'
import {
  POST_EVENTS,
  assignPosts,
  isHourInRange,
  isHourInWindows,
  movePostedStaff,
  nextWaypointIndex,
} from '../../src/systems/postSystem'
import { refreshPassability } from '../../src/world/construction'
import type { Rect } from '../../src/world/construction'

const DATA = loadGameData()

class RecordingSink {
  readonly events: SimulationEvent[] = []
  emit(event: SimulationEvent): void {
    this.events.push(event)
  }
  of(kind: string): SimulationEvent[] {
    return this.events.filter((event) => event.kind === kind)
  }
}

function putFloor(world: InmateWorld, x: number, y: number): number {
  const floor = world.data.balance.construction.foundationFloorMaterial
  const index = world.grid.idx(x, y)
  world.grid.setAt('floorMaterial', index, world.materials.indexOf(floor))
  world.grid.setAt('outdoors', index, 0)
  refreshPassability(world, world.data, index)
  return index
}

function putFloorRect(world: InmateWorld, rect: Rect): number[] {
  const tiles: number[] = []
  for (let y = rect.y; y < rect.y + rect.height; y += 1) {
    for (let x = rect.x; x < rect.x + rect.width; x += 1) {
      tiles.push(putFloor(world, x, y))
    }
  }
  return tiles
}

function hireOfficers(world: InmateWorld, events: RecordingSink, count: number, tx: number, ty: number): void {
  for (let i = 0; i < count; i += 1) {
    hireStaff({
      world,
      defId: 'officer',
      events,
      tick: 0,
      tx,
      ty,
    })
  }
}

describe('time window handling (T4.1)', () => {
  it('treats equal start/end as always-on and supports overnight wrap', () => {
    expect(isHourInRange(3, { startHour: 8, endHour: 8 })).toBe(true)
    expect(isHourInRange(12, { startHour: 12, endHour: 13 })).toBe(true)
    expect(isHourInRange(13, { startHour: 12, endHour: 13 })).toBe(false)
    expect(isHourInRange(23, { startHour: 22, endHour: 6 })).toBe(true)
    expect(isHourInRange(5, { startHour: 22, endHour: 6 })).toBe(true)
    expect(isHourInRange(10, { startHour: 22, endHour: 6 })).toBe(false)
  })

  it('treats an empty window list as always active', () => {
    expect(isHourInWindows(0, [])).toBe(true)
    expect(isHourInWindows(14, [{ startHour: 12, endHour: 13 }])).toBe(false)
    expect(
      isHourInWindows(12, [
        { startHour: 7, endHour: 8 },
        { startHour: 12, endHour: 13 },
      ]),
    ).toBe(true)
  })
})

describe('patrol looping (T4.1)', () => {
  it('wraps the waypoint index at the end of the list', () => {
    expect(nextWaypointIndex(0, 3)).toBe(1)
    expect(nextWaypointIndex(1, 3)).toBe(2)
    expect(nextWaypointIndex(2, 3)).toBe(0)
    expect(nextWaypointIndex(0, 0)).toBe(0)
  })

  it('advances a patrolling officer around the loop on arrival', () => {
    const world = createInmateWorld({ size: 20, data: DATA })
    const events = new RecordingSink()
    putFloorRect(world, { x: 1, y: 1, width: 10, height: 10 })
    world.regions.rebuildAll(world.grid, world.doors, DATA, world.sectors)

    const w0 = world.grid.idx(2, 2)
    const w1 = world.grid.idx(8, 2)
    const w2 = world.grid.idx(8, 8)
    const route = world.posts.createRoute({
      name: 'Yard loop',
      staffRole: 'officer',
      count: 1,
      waypoints: [w0, w1, w2],
    })

    hireOfficers(world, events, 1, 2, 2)
    assignPosts(world, DATA, events, 0, 12)

    const staff = world.staff.all()[0]
    expect(staff).toBeDefined()
    if (staff === undefined) return
    expect(staff.staff.duty.kind).toBe('patrol')
    if (staff.staff.duty.kind !== 'patrol') return
    expect(staff.staff.duty.routeId).toBe(route.id)
    expect(staff.staff.duty.waypointIndex).toBe(0)

    // Already on the first waypoint — one move tick advances to the next.
    movePostedStaff(world, DATA)
    expect(staff.staff.duty.kind).toBe('patrol')
    if (staff.staff.duty.kind !== 'patrol') return
    expect(staff.staff.duty.waypointIndex).toBe(1)

    // Teleport onto the last waypoint and confirm wrap-around.
    staff.tx = 8
    staff.ty = 8
    staff.x = (8 + 0.5) * DATA.balance.map.tileWorldUnits
    staff.y = (8 + 0.5) * DATA.balance.map.tileWorldUnits
    staff.staff.duty.waypointIndex = 2
    movePostedStaff(world, DATA)
    expect(staff.staff.duty.waypointIndex).toBe(0)
  })
})

describe('post satisfaction algorithm (T4.1)', () => {
  it('fills a meal-block post with exactly the requested officer count', () => {
    const world = createInmateWorld({ size: 24, data: DATA })
    const events = new RecordingSink()
    const messTiles = putFloorRect(world, { x: 2, y: 2, width: 8, height: 6 })
    putFloorRect(world, { x: 12, y: 2, width: 4, height: 4 })
    world.regions.rebuildAll(world.grid, world.doors, DATA, world.sectors)

    const sector = world.sectors.create(DATA, { name: 'Mess hall', access: 'shared' })
    expect(sector).toBeDefined()
    if (sector === undefined) return
    world.sectors.paintTiles(world.grid, messTiles, sector.id)

    const post = world.posts.createPost({
      name: 'Mess hall meal cover',
      sectorId: sector.id,
      staffRole: 'officer',
      count: 3,
      timeWindows: [
        { startHour: 7, endHour: 8 },
        { startHour: 12, endHour: 13 },
        { startHour: 18, endHour: 19 },
      ],
    })

    hireOfficers(world, events, 5, 13, 3)
    assignPosts(world, DATA, events, 0, 12)

    expect(post.assigned).toHaveLength(3)
    expect(post.shortfallReason).toBeNull()

    const posted = world.staff.all().filter((s) => s.staff.duty.kind === 'post')
    expect(posted).toHaveLength(3)
    for (const officer of posted) {
      expect(officer.staff.duty.kind).toBe('post')
      if (officer.staff.duty.kind !== 'post') continue
      expect(officer.staff.duty.postId).toBe(post.id)
      expect(messTiles).toContain(officer.staff.duty.stationTile)
    }

    // Outside meal blocks the post releases everyone.
    assignPosts(world, DATA, events, 60, 14)
    expect(post.assigned).toHaveLength(0)
    expect(world.staff.all().every((s) => s.staff.duty.kind !== 'post')).toBe(true)
  })

  it('reports no-staff-hired when nobody of that role exists', () => {
    const world = createInmateWorld({ size: 16, data: DATA })
    const events = new RecordingSink()
    const tiles = putFloorRect(world, { x: 1, y: 1, width: 4, height: 4 })
    world.regions.rebuildAll(world.grid, world.doors, DATA, world.sectors)

    const sector = world.sectors.create(DATA, { name: 'Wing', access: 'shared' })
    expect(sector).toBeDefined()
    if (sector === undefined) return
    world.sectors.paintTiles(world.grid, tiles, sector.id)
    const post = world.posts.createPost({
      name: 'Empty wing',
      sectorId: sector.id,
      staffRole: 'officer',
      count: 2,
    })

    assignPosts(world, DATA, events, 0, 10)
    expect(post.assigned).toHaveLength(0)
    expect(post.shortfallReason).toBe('no-staff-hired')
    expect(events.of(POST_EVENTS.unfilled)[0]?.data).toMatchObject({
      reason: 'no-staff-hired',
      required: 2,
      filled: 0,
      hired: 0,
    })
  })

  it('reports unreachable when staff exist but cannot reach the post', () => {
    const world = createInmateWorld({ size: 20, data: DATA })
    const events = new RecordingSink()

    // Two rooms sealed from each other: no shared door, walls everywhere else.
    const postTiles = putFloorRect(world, { x: 2, y: 2, width: 3, height: 3 })
    putFloorRect(world, { x: 12, y: 12, width: 3, height: 3 })
    for (let y = 1; y <= 5; y += 1) {
      for (let x = 1; x <= 5; x += 1) {
        const onEdge = x === 1 || y === 1 || x === 5 || y === 5
        if (onEdge) {
          const index = world.grid.idx(x, y)
          world.grid.setAt('wallMaterial', index, world.materials.indexOf('brick_wall'))
          world.grid.setAt('floorMaterial', index, world.materials.indexOf(
            world.data.balance.construction.foundationFloorMaterial,
          ))
          world.grid.setAt('outdoors', index, 0)
          refreshPassability(world, world.data, index)
        }
      }
    }
    for (let y = 11; y <= 15; y += 1) {
      for (let x = 11; x <= 15; x += 1) {
        const onEdge = x === 11 || y === 11 || x === 15 || y === 15
        if (onEdge) {
          const index = world.grid.idx(x, y)
          world.grid.setAt('wallMaterial', index, world.materials.indexOf('brick_wall'))
          world.grid.setAt('floorMaterial', index, world.materials.indexOf(
            world.data.balance.construction.foundationFloorMaterial,
          ))
          world.grid.setAt('outdoors', index, 0)
          refreshPassability(world, world.data, index)
        }
      }
    }
    // Blank the outdoor corridor so coarse routing cannot walk around the walls.
    for (let y = 0; y < 20; y += 1) {
      for (let x = 0; x < 20; x += 1) {
        const insideA = x >= 1 && x <= 5 && y >= 1 && y <= 5
        const insideB = x >= 11 && x <= 15 && y >= 11 && y <= 15
        if (insideA || insideB) continue
        const index = world.grid.idx(x, y)
        world.grid.setAt('passability', index, 0)
      }
    }
    world.regions.rebuildAll(world.grid, world.doors, DATA, world.sectors)

    const sector = world.sectors.create(DATA, { name: 'Isolated', access: 'shared' })
    expect(sector).toBeDefined()
    if (sector === undefined) return
    world.sectors.paintTiles(world.grid, postTiles, sector.id)
    const post = world.posts.createPost({
      name: 'Isolated post',
      sectorId: sector.id,
      staffRole: 'officer',
      count: 1,
    })

    hireOfficers(world, events, 2, 13, 13)
    assignPosts(world, DATA, events, 0, 10)

    expect(post.assigned).toHaveLength(0)
    expect(post.shortfallReason).toBe('unreachable')
    expect(events.of(POST_EVENTS.unfilled)[0]?.data).toMatchObject({
      reason: 'unreachable',
      hired: 2,
      deployable: 2,
    })
  })

  it('excludes manually pinned staff from post assignment', () => {
    const world = createInmateWorld({ size: 20, data: DATA })
    const events = new RecordingSink()
    const tiles = putFloorRect(world, { x: 1, y: 1, width: 6, height: 6 })
    world.regions.rebuildAll(world.grid, world.doors, DATA, world.sectors)

    const sector = world.sectors.create(DATA, { name: 'Yard', access: 'open' })
    expect(sector).toBeDefined()
    if (sector === undefined) return
    world.sectors.paintTiles(world.grid, tiles, sector.id)
    const post = world.posts.createPost({
      name: 'Yard cover',
      sectorId: sector.id,
      staffRole: 'officer',
      count: 2,
    })

    hireOfficers(world, events, 2, 2, 2)
    const [a, b] = world.staff.all()
    expect(a).toBeDefined()
    expect(b).toBeDefined()
    if (a === undefined || b === undefined) return
    a.staff.pinnedTile = world.grid.idx(5, 5)

    assignPosts(world, DATA, events, 0, 10)
    expect(post.assigned).toEqual([b.id])
    expect(post.shortfallReason).not.toBeNull()
    expect(a.staff.duty.kind).not.toBe('post')
  })
})
