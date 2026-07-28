import { describe, expect, it } from 'vitest'

import { roomDefSchema } from '../../src/data/schemas'
import { applyJob, placeDoor, placeFoundation } from '../../src/world/construction'
import type { Rect } from '../../src/world/construction'
import {
  designateRoom,
  detectRooms,
  refreshRoomStatus,
  updateStaleRooms,
} from '../../src/world/roomDetection'
import { evaluateRoom, failedRequirements } from '../../src/world/rooms'
import type { Room, RoomStatus } from '../../src/world/rooms'

import {
  CELL,
  DATA,
  FENCE_MATERIAL,
  FakeContents,
  WALL_MATERIAL,
  putPerimeter,
  scenario,
  withBalance,
} from './roomFixture'
import type { Scenario } from './roomFixture'

/** A 4x5 shell, so the floor inside it is the acceptance case's 2x3 cell. */
const SHELL: Rect = { x: 2, y: 2, width: 4, height: 5 }
const CELL_AREA: Rect = { x: 3, y: 3, width: 2, height: 3 }

function onlyRoom(run: Scenario): Room {
  const rooms = run.world.rooms.all()
  expect(rooms).toHaveLength(1)
  const room = rooms[0]
  if (room === undefined) throw new Error('no room was detected')
  return room
}

function statusOf(run: Scenario, roomId: number): RoomStatus {
  const status = run.world.rooms.statusOf(roomId)
  if (status === undefined) throw new Error(`room ${roomId} has no status`)
  return status
}

/** A walled shell with its interior designated as a cell. */
function cellScenario(options: Parameters<typeof scenario>[0] = {}): Scenario {
  const run = scenario(options)
  placeFoundation(run.constructionDeps(), SHELL, WALL_MATERIAL)
  run.runUntilIdle()
  designateRoom(run.roomDeps(), CELL_AREA, CELL)
  return run
}

describe('room properties (T1.3)', () => {
  it('reports a walled, foundationed room as enclosed, indoors and secure', () => {
    const run = cellScenario()

    expect(onlyRoom(run).properties).toEqual({
      enclosed: true,
      indoors: true,
      outdoors: false,
      secure: true,
    })
  })

  it('stops being enclosed when a wall comes out, because the fill escapes', () => {
    const run = cellScenario()
    const gap = run.world.grid.idx(SHELL.x, SHELL.y + 1)

    applyJob(run.constructionDeps(), gap, { kind: 'clear', wall: true, floor: false })
    updateStaleRooms(run.roomDeps())

    const room = onlyRoom(run)
    expect(room.properties.enclosed).toBe(false)
    // The same gap is a way out to the map edge, so the room is not inside a
    // perimeter either.
    expect(room.properties.secure).toBe(false)
    expect(room.properties.indoors).toBe(true)
  })

  it('stays enclosed when the hole in the wall is a door', () => {
    const run = cellScenario()
    const opening = { x: SHELL.x, y: SHELL.y + 1 }

    placeDoor(run.constructionDeps(), opening, 'standard')
    run.runUntilIdle()
    updateStaleRooms(run.roomDeps())

    expect(onlyRoom(run).properties.enclosed).toBe(true)
    expect(onlyRoom(run).properties.secure).toBe(true)
  })

  it('reports a designation on open ground as outdoors and nothing else', () => {
    const run = scenario()

    designateRoom(run.roomDeps(), { x: 10, y: 10, width: 5, height: 5 }, 'exercise_yard')

    expect(onlyRoom(run).properties).toEqual({
      enclosed: false,
      indoors: false,
      outdoors: true,
      secure: false,
    })
  })

  it('reports a fenced yard as secure but not enclosed', () => {
    const run = scenario()
    putPerimeter(run, { x: 4, y: 4, width: 11, height: 11 }, FENCE_MATERIAL)

    designateRoom(run.roomDeps(), { x: 6, y: 6, width: 5, height: 5 }, 'exercise_yard')

    const room = onlyRoom(run)
    // Open sky inside the fence, so the fill meets undesignated outdoor ground
    // straight away, but it never reaches the edge of the map.
    expect(room.properties.enclosed).toBe(false)
    expect(room.properties.secure).toBe(true)
    expect(room.properties.outdoors).toBe(true)
  })

  it('stops being secure when the fence has a gap', () => {
    const run = scenario()
    putPerimeter(run, { x: 4, y: 4, width: 11, height: 11 }, FENCE_MATERIAL)
    designateRoom(run.roomDeps(), { x: 6, y: 6, width: 5, height: 5 }, 'exercise_yard')

    applyJob(run.constructionDeps(), run.world.grid.idx(4, 8), {
      kind: 'clear',
      wall: true,
      floor: false,
    })
    updateStaleRooms(run.roomDeps())

    expect(onlyRoom(run).properties.secure).toBe(false)
  })

  it('is neither indoors nor outdoors when only some tiles have a foundation', () => {
    const run = cellScenario()
    const hole = run.world.grid.idx(CELL_AREA.x, CELL_AREA.y)

    applyJob(run.constructionDeps(), hole, { kind: 'clear', wall: false, floor: true })
    updateStaleRooms(run.roomDeps())

    const room = onlyRoom(run)
    expect(room.properties.indoors).toBe(false)
    expect(room.properties.outdoors).toBe(false)
  })

  it('gives up on a space larger than the enclosure budget, and says so', () => {
    const run = cellScenario({ data: withBalance({ enclosureFillLimit: 4 }) })

    const room = onlyRoom(run)
    expect(room.tiles.length).toBeGreaterThan(4)
    expect(room.properties.enclosed).toBe(false)
    expect(room.properties.secure).toBe(false)

    const warnings = run.events.of('rooms.enclosureUnbounded')
    expect(warnings).toHaveLength(1)
    expect(warnings[0]?.data).toMatchObject({ roomId: room.id, limit: 4 })
  })
})

describe('requirement evaluation (T1.3)', () => {
  it('reports a 2x3 cell with a bed and a toilet as functional', () => {
    const run = cellScenario()
    const room = onlyRoom(run)
    run.contents.put(room.id, 'bed', 1).put(room.id, 'toilet', 1)

    refreshRoomStatus(run.roomDeps(), room.id)
    const status = statusOf(run, room.id)

    expect(room.tiles).toHaveLength(6)
    expect(room.bounds).toEqual(CELL_AREA)
    expect(status.functional).toBe(true)
    expect(status.requirements.every((entry) => entry.met)).toBe(true)
    expect(status.requirements.map((entry) => entry.subject)).toEqual([
      'minTiles',
      'minWidth',
      'minHeight',
      'enclosed',
      'indoors',
      'bed',
      'toilet',
    ])
  })

  it('reports exactly one failed requirement, naming the toilet, when it is removed', () => {
    const run = cellScenario()
    const room = onlyRoom(run)
    run.contents.put(room.id, 'bed', 1).put(room.id, 'toilet', 1)
    refreshRoomStatus(run.roomDeps(), room.id)
    run.events.clear()

    run.contents.put(room.id, 'toilet', 0)
    refreshRoomStatus(run.roomDeps(), room.id)
    const status = statusOf(run, room.id)

    expect(status.functional).toBe(false)
    const failures = failedRequirements(status)
    expect(failures).toHaveLength(1)
    expect(failures[0]).toEqual({
      kind: 'object',
      subject: 'toilet',
      required: 1,
      actual: 0,
      met: false,
    })

    // CLAUDE.md rule 5: the Trace panel has to be able to reconstruct why the
    // cell stopped working.
    const warnings = run.events.of('rooms.notFunctional')
    expect(warnings).toHaveLength(1)
    expect(warnings[0]?.data).toMatchObject({ roomId: room.id, missing: ['toilet'] })
  })

  it('fails the size rules that are actually broken and passes the rest', () => {
    const run = scenario()
    placeFoundation(run.constructionDeps(), { x: 2, y: 2, width: 4, height: 4 }, WALL_MATERIAL)
    run.runUntilIdle()
    designateRoom(run.roomDeps(), { x: 3, y: 3, width: 2, height: 2 }, CELL)

    const status = statusOf(run, onlyRoom(run).id)
    const bySubject = new Map(status.requirements.map((entry) => [entry.subject, entry]))

    expect(bySubject.get('minTiles')).toMatchObject({ required: 6, actual: 4, met: false })
    expect(bySubject.get('minHeight')).toMatchObject({ required: 3, actual: 2, met: false })
    expect(bySubject.get('minWidth')).toMatchObject({ required: 2, actual: 2, met: true })
  })

  it('scales a requirement above its floor with perOccupant', () => {
    const room: Room = {
      id: 7,
      defId: 'dormitory',
      tiles: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
      bounds: { x: 0, y: 0, width: 4, height: 3 },
      properties: { enclosed: true, indoors: true, outdoors: false, secure: true },
    }
    const contents = new FakeContents().house(7, 12).put(7, 'bed', 12).put(7, 'toilet', 1)

    const status = evaluateRoom(room, DATA.rooms.get('dormitory'), contents)
    const bySubject = new Map(status.requirements.map((entry) => [entry.subject, entry]))

    // One bed a head, and one toilet per eight heads rounded up, against a
    // floor of one of each.
    expect(bySubject.get('bed')).toMatchObject({ required: 12, actual: 12, met: true })
    expect(bySubject.get('toilet')).toMatchObject({ required: 2, actual: 1, met: false })
  })

  it('leaves a rule with a zero minimum out of the report entirely', () => {
    const def = roomDefSchema.parse({
      id: 'nowhere',
      name: 'Nowhere',
      category: 'staff',
      minTiles: 0,
      minWidth: 0,
      minHeight: 0,
      graded: false,
    })
    const room: Room = {
      id: 1,
      defId: 'nowhere',
      tiles: [0],
      bounds: { x: 0, y: 0, width: 1, height: 1 },
      properties: { enclosed: false, indoors: false, outdoors: true, secure: false },
    }

    const status = evaluateRoom(room, def)

    expect(status.requirements).toEqual([])
    expect(status.functional).toBe(true)
  })

  it('re-evaluates on detection, so a newly drawn room reports its gaps at once', () => {
    const run = scenario()
    placeFoundation(run.constructionDeps(), SHELL, WALL_MATERIAL)
    run.runUntilIdle()

    detectRooms(run.roomDeps())
    designateRoom(run.roomDeps(), CELL_AREA, CELL)

    const status = statusOf(run, onlyRoom(run).id)
    expect(status.functional).toBe(false)
    expect(failedRequirements(status).map((entry) => entry.subject)).toEqual(['bed', 'toilet'])
    expect(run.events.of('rooms.notFunctional')[0]?.data).toMatchObject({
      missing: ['bed', 'toilet'],
    })
  })
})
