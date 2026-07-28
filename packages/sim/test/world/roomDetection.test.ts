import { describe, expect, it } from 'vitest'

import { Simulation } from '../../src/core/simulation'
import { applyJob, createConstructionWorld, placeDoor } from '../../src/world/construction'
import type { ConstructionJob } from '../../src/world/construction'
import {
  ROOM_COMMANDS,
  designateRoom,
  detectAllRooms,
  detectRooms,
  roomCommandHandlers,
  undesignateRoom,
  updateStaleRooms,
} from '../../src/world/roomDetection'
import { NO_ROOM } from '../../src/world/rooms'
import type { Room } from '../../src/world/rooms'

import {
  CELL,
  DATA,
  FENCE_MATERIAL,
  WALL_MATERIAL,
  buildCellBlock,
  putPerimeter,
  scenario,
} from './roomFixture'
import type { CellBlock, Scenario } from './roomFixture'

const CLEAR_WALL: ConstructionJob = { kind: 'clear', wall: true, floor: false }
const REBUILD_WALL: ConstructionJob = { kind: 'wall', material: WALL_MATERIAL, foundation: true }

/** A row of cells sharing their walls, the whole slab designated in one drag. */
function cellRow(
  columns: number,
  options: Parameters<typeof scenario>[0] = {},
): {
  readonly run: Scenario
  readonly block: CellBlock
} {
  const run = scenario(options)
  const block = buildCellBlock(run, columns, 1)
  designateRoom(run.roomDeps(), block.slab, CELL)
  return { run, block }
}

function roomAt(run: Scenario, tileIndex: number): Room {
  const roomId = run.world.grid.getAt('roomId', tileIndex)
  const room = run.world.rooms.get(roomId)
  if (room === undefined) throw new Error(`tile ${tileIndex} belongs to no room`)
  return room
}

describe('room detection (T1.3)', () => {
  it('splits a designated slab into one room per walled interior', () => {
    const { run, block } = cellRow(3)

    const rooms = run.world.rooms.all()
    expect(rooms).toHaveLength(3)
    for (const room of rooms) {
      expect(room.defId).toBe(CELL)
      expect(room.tiles).toHaveLength(9)
      expect(room.bounds.width).toBe(3)
      expect(room.bounds.height).toBe(3)
    }

    // Ids follow tile order, so the leftmost cell is the lowest id.
    expect(roomAt(run, block.interior(0, 0)).id).toBeLessThan(roomAt(run, block.interior(1, 0)).id)
  })

  it('leaves the wall tiles themselves out of every room', () => {
    const { run, block } = cellRow(2)

    expect(run.world.grid.getAt('roomId', block.sharedWall(0, 0))).toBe(NO_ROOM)
    // Still designated, though: demolish the wall and the tile joins.
    expect(run.world.rooms.designationIdAt(block.sharedWall(0, 0))).toBe(CELL)
  })

  it('treats a door as a boundary, not an opening', () => {
    const { run, block } = cellRow(2)
    const wall = block.sharedWall(0, 0)
    const { x, y } = run.world.grid.xy(wall)

    placeDoor(run.constructionDeps(), { x, y }, 'standard')
    run.runUntilIdle()
    updateStaleRooms(run.roomDeps())

    expect(run.world.rooms.roomCount).toBe(2)
    expect(run.world.grid.getAt('roomId', wall)).toBe(NO_ROOM)
  })

  it('changes nothing when the same designation is painted twice', () => {
    const { run, block } = cellRow(2)
    const before = run.world.rooms.all()

    const changed = designateRoom(run.roomDeps(), block.slab, CELL)

    expect(changed).toBe(0)
    expect(run.world.rooms.all()).toEqual(before)
  })

  it('undesignating removes the room and clears its tiles', () => {
    const { run, block } = cellRow(2)
    const interior = block.interior(1, 0)
    const doomed = roomAt(run, interior)

    const changed = undesignateRoom(run.roomDeps(), {
      x: block.slab.x + 4,
      y: block.slab.y,
      width: 5,
      height: block.slab.height,
    })

    expect(changed).toBeGreaterThan(0)
    expect(run.world.rooms.get(doomed.id)).toBeUndefined()
    expect(run.world.grid.getAt('roomId', interior)).toBe(NO_ROOM)
    expect(run.world.rooms.roomCount).toBe(1)
  })

  it('rebuilds everything from the designations on demand', () => {
    const { run } = cellRow(3)

    const update = detectAllRooms(run.roomDeps())

    expect(update.evaluated).toHaveLength(3)
    expect(run.world.rooms.roomCount).toBe(3)
  })
})

describe('incremental scoping (T1.3)', () => {
  it('re-evaluates only the two rooms a removed wall merges', () => {
    const { run, block } = cellRow(3)
    const left = roomAt(run, block.interior(0, 0))
    const right = roomAt(run, block.interior(1, 0))
    const untouched = roomAt(run, block.interior(2, 0))

    applyJob(run.constructionDeps(), block.sharedWall(0, 0), CLEAR_WALL)
    const update = updateStaleRooms(run.roomDeps())

    expect(update.evaluated).toHaveLength(1)
    expect(update.removed).toEqual([right.id])
    // Two nine-tile cells plus the tile the wall was standing on.
    expect(update.tilesVisited).toBe(19)

    const merged = update.evaluated[0]
    expect(merged?.id).toBe(left.id)
    expect(merged?.tiles).toHaveLength(19)

    // The third cell was never looked at: same record, same object.
    expect(run.world.rooms.get(untouched.id)).toBe(untouched)
    expect(run.world.rooms.roomCount).toBe(2)
  })

  it('re-evaluates only the two halves a replaced wall splits', () => {
    const { run, block } = cellRow(3)
    const untouched = roomAt(run, block.interior(2, 0))
    applyJob(run.constructionDeps(), block.sharedWall(0, 0), CLEAR_WALL)
    updateStaleRooms(run.roomDeps())

    applyJob(run.constructionDeps(), block.sharedWall(0, 0), REBUILD_WALL)
    const update = updateStaleRooms(run.roomDeps())

    expect(update.evaluated).toHaveLength(2)
    expect(update.tilesVisited).toBe(18)
    expect(update.evaluated.every((room) => room.tiles.length === 9)).toBe(true)
    expect(run.world.rooms.get(untouched.id)).toBe(untouched)
    expect(run.world.rooms.roomCount).toBe(3)
  })

  it('keeps the room id when a change only reshapes one room', () => {
    const { run, block } = cellRow(2)
    const room = roomAt(run, block.interior(0, 0))

    // A pillar in the corner: the room loses a tile but stays one room.
    applyJob(run.constructionDeps(), block.interior(0, 0), REBUILD_WALL)
    const update = updateStaleRooms(run.roomDeps())

    expect(update.evaluated).toHaveLength(1)
    expect(update.evaluated[0]?.id).toBe(room.id)
    expect(update.evaluated[0]?.tiles).toHaveLength(8)
    expect(update.removed).toEqual([])
  })

  it('looks at nothing when the change is nowhere near a room', () => {
    const { run } = cellRow(2, { size: 40 })
    const before = run.world.rooms.all()

    applyJob(run.constructionDeps(), run.world.grid.idx(30, 30), REBUILD_WALL)
    const update = updateStaleRooms(run.roomDeps())

    expect(update.evaluated).toEqual([])
    expect(update.removed).toEqual([])
    expect(update.tilesVisited).toBe(0)
    expect(run.world.rooms.all()).toEqual(before)
  })

  it('re-evaluates every room sharing the open space a change opened, and no others', () => {
    const run = scenario({ size: 40 })
    putPerimeter(run, { x: 2, y: 2, width: 12, height: 12 }, FENCE_MATERIAL)
    putPerimeter(run, { x: 20, y: 2, width: 12, height: 12 }, FENCE_MATERIAL)
    designateRoom(run.roomDeps(), { x: 4, y: 4, width: 5, height: 5 }, 'exercise_yard')
    designateRoom(run.roomDeps(), { x: 4, y: 10, width: 5, height: 2 }, 'dock')
    designateRoom(run.roomDeps(), { x: 22, y: 4, width: 5, height: 5 }, 'exercise_yard')

    const elsewhere = roomAt(run, run.world.grid.idx(22, 4))
    expect(run.world.rooms.all().every((room) => room.properties.secure)).toBe(true)

    // A hole in the first compound's fence, nowhere near either room's tiles.
    applyJob(run.constructionDeps(), run.world.grid.idx(2, 7), CLEAR_WALL)
    const update = updateStaleRooms(run.roomDeps())

    expect(update.evaluated).toHaveLength(2)
    expect(update.evaluated.every((room) => room.properties.secure)).toBe(false)
    expect(run.world.rooms.get(elsewhere.id)).toBe(elsewhere)
    expect(elsewhere.properties.secure).toBe(true)
  })

  it('does nothing at all when nothing has changed', () => {
    const { run } = cellRow(2)

    const update = detectRooms(run.roomDeps())

    expect(update).toEqual({ evaluated: [], removed: [], tilesVisited: 0 })
  })
})

describe('designation commands (T1.3)', () => {
  it('designates through the command queue', () => {
    const { run, block } = cellRow(1)
    undesignateRoom(run.roomDeps(), block.slab)
    expect(run.world.rooms.roomCount).toBe(0)

    run.sim.enqueue({
      type: ROOM_COMMANDS.designateRoom,
      issuedAtTick: run.sim.tick,
      payload: { rect: { ...block.slab }, roomDefId: CELL },
    })
    run.sim.step()

    expect(run.world.rooms.roomCount).toBe(1)
  })

  it('rejects an unknown room type without designating anything', () => {
    const run = scenario()

    const changed = designateRoom(run.roomDeps(), { x: 1, y: 1, width: 3, height: 3 }, 'oubliette')

    expect(changed).toBe(0)
    expect(run.events.of('rooms.rejected')[0]?.data).toMatchObject({
      command: ROOM_COMMANDS.designateRoom,
      reason: 'unknown-room',
      roomDefId: 'oubliette',
    })
  })

  it('rejects a degenerate rectangle and one that is entirely off the grid', () => {
    const run = scenario()

    expect(designateRoom(run.roomDeps(), { x: 1, y: 1, width: 0, height: 3 }, CELL)).toBe(0)
    expect(designateRoom(run.roomDeps(), { x: 100, y: 100, width: 3, height: 3 }, CELL)).toBe(0)
    expect(undesignateRoom(run.roomDeps(), { x: -50, y: -50, width: 3, height: 3 })).toBe(0)

    expect(run.events.of('rooms.rejected').map((event) => event.data)).toMatchObject([
      { reason: 'invalid-rect' },
      { reason: 'off-grid' },
      { reason: 'off-grid' },
    ])
  })

  it('reports a world without a room registry once per command, not as a throw', () => {
    const events: { kind: string; data: unknown }[] = []
    const sim = new Simulation({
      seed: 1,
      world: createConstructionWorld(16, DATA),
      commandHandlers: roomCommandHandlers(DATA),
      events: { emit: (event): void => void events.push({ kind: event.kind, data: event.data }) },
    })

    sim.enqueue({
      type: ROOM_COMMANDS.designateRoom,
      issuedAtTick: 0,
      payload: { rect: { x: 0, y: 0, width: 2, height: 2 }, roomDefId: CELL },
    })
    sim.step()

    expect(events).toMatchObject([{ kind: 'rooms.rejected', data: { reason: 'wrong-world' } }])
  })
})

describe('room detection performance (T1.3)', () => {
  it('re-detects a 220x220 map of 400 rooms after one wall change in under 2ms', () => {
    const run = scenario({ size: 220, silent: true })
    const block = buildCellBlock(run, 20, 20)
    designateRoom(run.roomDeps(), block.slab, CELL)
    expect(run.world.rooms.roomCount).toBe(400)

    const wall = block.sharedWall(9, 9)
    const samples: number[] = []

    for (let iteration = 0; iteration < 60; iteration += 1) {
      applyJob(run.constructionDeps(), wall, CLEAR_WALL)

      const started = performance.now()
      const update = updateStaleRooms(run.roomDeps())
      samples.push(performance.now() - started)

      expect(update.evaluated).toHaveLength(1)

      applyJob(run.constructionDeps(), wall, REBUILD_WALL)
      updateStaleRooms(run.roomDeps())
    }

    samples.sort((a, b) => a - b)
    // The median rather than the worst: the first pass pays for JIT warm-up,
    // and a CI runner's scheduler is not part of the budget.
    const median = samples[Math.floor(samples.length / 2)] ?? Number.POSITIVE_INFINITY
    expect(median).toBeLessThan(2)
    expect(run.world.rooms.roomCount).toBe(400)
  })
})
