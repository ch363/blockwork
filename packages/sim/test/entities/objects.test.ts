import { describe, expect, it } from 'vitest'

import type { Command } from '../../src/core/commands'
import {
  MAX_OBJECT_ID,
  NO_OBJECT,
  OBJECT_COMMANDS,
  ROTATIONS,
  containingRoom,
  isRotation,
  objectFootprint,
  placeObject,
  removeObject,
  rotatedSize,
  surfaceAccepts,
  validatePlacement,
} from '../../src/entities/objects'
import type { ObjectEntity, Rotation } from '../../src/entities/objects'
import { designateRoom, detectRooms } from '../../src/world/roomDetection'
import { failedRequirements } from '../../src/world/rooms'
import type { RoomStatus } from '../../src/world/rooms'
import {
  DATA,
  makeRoom,
  putDoor,
  putFloor,
  putRoomShell,
  putWall,
  scenario,
  withObjectDef,
} from './objectFixture'

type Scenario = ReturnType<typeof scenario>

/** The acceptance case's object: 2x1, rotatable, mains powered. */
const COOKER = 'cooker'

/** A 1x1 floor object that turns no room functional, for the plain cases. */
const STOOL = 'stool'

/** Wall mounted, and the one object a `washroom` requires. */
const SHOWER_HEAD = 'shower_head'

/** The placed entity. Its absence is a test failure, not a branch. */
function place(
  run: Scenario,
  x: number,
  y: number,
  objectDefId: string,
  rotation: Rotation = 0,
): ObjectEntity {
  const entity = placeObject(run.objectDeps(), { x, y }, objectDefId, rotation)
  if (entity === undefined) {
    throw new Error(
      `placing '${objectDefId}' at (${x}, ${y}) failed: ${run.events.reasons().join(', ')}`,
    )
  }
  return entity
}

function statusOf(run: Scenario, roomId: number): RoomStatus {
  const status = run.world.rooms.statusOf(roomId)
  if (status === undefined) throw new Error(`room ${roomId} has no status`)
  return status
}

/** The subjects of a room's failed requirements, which is what the UI lists. */
function missing(run: Scenario, roomId: number): string[] {
  return failedRequirements(statusOf(run, roomId)).map((entry) => entry.subject)
}

/* -------------------------------------------------------------------------- */
/* Rotation geometry                                                           */
/* -------------------------------------------------------------------------- */

describe('rotation geometry', () => {
  it('accepts only the four quarter turns', () => {
    expect(ROTATIONS).toEqual([0, 90, 180, 270])
    for (const rotation of ROTATIONS) expect(isRotation(rotation)).toBe(true)
    for (const bad of [-90, 45, 1, 360, 0.5, Number.NaN]) expect(isRotation(bad)).toBe(false)
  })

  it('swaps the axes on the quarter turns and leaves them on the half turns', () => {
    const size = { w: 3, h: 1 }
    expect(rotatedSize(size, 0)).toEqual({ w: 3, h: 1 })
    expect(rotatedSize(size, 90)).toEqual({ w: 1, h: 3 })
    expect(rotatedSize(size, 180)).toEqual({ w: 3, h: 1 })
    expect(rotatedSize(size, 270)).toEqual({ w: 1, h: 3 })
  })

  it('anchors every rotation at the placed tile', () => {
    const def = DATA.objects.get(COOKER)
    for (const rotation of ROTATIONS) {
      const rect = objectFootprint(def, { x: 7, y: 4 }, rotation)
      expect({ x: rect.x, y: rect.y }).toEqual({ x: 7, y: 4 })
    }
  })

  it('puts a 2x1 cooker rotated 90 degrees on the two tiles below the anchor', () => {
    const run = scenario()
    putRoomShell(run, { x: 2, y: 2, width: 8, height: 8 })

    const upright = place(run, 4, 4, COOKER, 0)
    expect(upright.object.footprint).toEqual({ x: 4, y: 4, width: 2, height: 1 })
    expect(upright.object.tiles).toEqual([run.world.grid.idx(4, 4), run.world.grid.idx(5, 4)])

    const turned = place(run, 7, 4, COOKER, 90)
    expect(turned.object.footprint).toEqual({ x: 7, y: 4, width: 1, height: 2 })
    expect(turned.object.tiles).toEqual([run.world.grid.idx(7, 4), run.world.grid.idx(7, 5)])
  })

  it('reports every footprint tile as occupied, not just the anchor', () => {
    const run = scenario()
    putRoomShell(run, { x: 2, y: 2, width: 8, height: 8 })
    const entity = place(run, 4, 4, COOKER, 90)

    expect(run.world.objects.at(run.world.grid.idx(4, 4))).toBe(entity)
    expect(run.world.objects.at(run.world.grid.idx(4, 5))).toBe(entity)
    expect(run.world.objects.at(run.world.grid.idx(4, 6))).toBeUndefined()
  })

  it('writes the entity id onto the anchor tile only, per PRD 4.3', () => {
    const run = scenario()
    putRoomShell(run, { x: 2, y: 2, width: 8, height: 8 })
    const entity = place(run, 4, 4, COOKER, 0)

    expect(run.world.grid.get('objectId', 4, 4)).toBe(entity.id)
    expect(run.world.grid.get('objectId', 5, 4)).toBe(NO_OBJECT)
  })

  it('refuses a rotation on an object that cannot turn', () => {
    const run = scenario()
    putRoomShell(run, { x: 2, y: 2, width: 8, height: 8 })

    expect(placeObject(run.objectDeps(), { x: 4, y: 4 }, STOOL, 90)).toBeUndefined()
    expect(run.events.reasons()).toEqual(['not-rotatable'])
    expect(run.world.objects.size).toBe(0)
  })
})

/* -------------------------------------------------------------------------- */
/* Placement validation                                                        */
/* -------------------------------------------------------------------------- */

describe('placement validation', () => {
  it('refuses an unknown definition', () => {
    const run = scenario()
    expect(placeObject(run.objectDeps(), { x: 4, y: 4 }, 'not_a_thing')).toBeUndefined()
    expect(run.events.reasons()).toEqual(['unknown-object'])
  })

  it('refuses a footprint that runs off the grid', () => {
    const run = scenario({ size: 16 })
    for (let x = 0; x < 16; x += 1) putFloor(run, x, 8)

    // The anchor is on the grid; the cooker's second tile is not.
    expect(placeObject(run.objectDeps(), { x: 15, y: 8 }, COOKER, 0)).toBeUndefined()
    expect(placeObject(run.objectDeps(), { x: -1, y: 8 }, COOKER, 0)).toBeUndefined()
    expect(run.events.reasons()).toEqual(['off-grid', 'off-grid'])
  })

  it('refuses a footprint that overlaps an object already there', () => {
    const run = scenario()
    putRoomShell(run, { x: 2, y: 2, width: 8, height: 8 })
    place(run, 4, 4, COOKER, 0)
    run.events.clear()

    // Overlaps the cooker's second tile, not its anchor.
    expect(placeObject(run.objectDeps(), { x: 5, y: 4 }, STOOL)).toBeUndefined()
    expect(run.events.reasons()).toEqual(['occupied'])
  })

  it('holds a floor object off walls and doorways', () => {
    const run = scenario()
    putRoomShell(run, { x: 2, y: 2, width: 8, height: 8 })
    putDoor(run, 2, 5)

    const def = DATA.objects.get(STOOL)
    expect(surfaceAccepts(run.world, def, run.world.grid.idx(4, 4))).toBe(true)
    expect(surfaceAccepts(run.world, def, run.world.grid.idx(2, 2))).toBe(false)
    expect(surfaceAccepts(run.world, def, run.world.grid.idx(2, 5))).toBe(false)

    expect(placeObject(run.objectDeps(), { x: 2, y: 2 }, STOOL)).toBeUndefined()
    expect(run.events.reasons()).toEqual(['wrong-surface'])
  })

  it('puts a wall fixture on a wall and nowhere else', () => {
    const run = scenario()
    putRoomShell(run, { x: 2, y: 2, width: 8, height: 8 })
    putDoor(run, 2, 5)

    const def = DATA.objects.get(SHOWER_HEAD)
    expect(surfaceAccepts(run.world, def, run.world.grid.idx(2, 3))).toBe(true)
    expect(surfaceAccepts(run.world, def, run.world.grid.idx(4, 4))).toBe(false)
    // A door has replaced the wall segment, so there is nothing left to hang on.
    expect(surfaceAccepts(run.world, def, run.world.grid.idx(2, 5))).toBe(false)
  })

  it('puts a ceiling fixture only under a roof', () => {
    const run = scenario()
    putRoomShell(run, { x: 2, y: 2, width: 8, height: 8 })

    const def = DATA.objects.get('ceiling_light')
    expect(surfaceAccepts(run.world, def, run.world.grid.idx(4, 4))).toBe(true)
    // Open ground: no foundation, so no ceiling.
    expect(surfaceAccepts(run.world, def, run.world.grid.idx(15, 15))).toBe(false)
  })

  it('keeps an object that requires a room wholly inside one room', () => {
    const run = scenario({ data: withObjectDef(COOKER, { requiresRoom: true }) })
    putRoomShell(run, { x: 2, y: 2, width: 10, height: 8 })
    // Only the left half of the interior is designated, so the right half is
    // indoor floor belonging to no room.
    designateRoom(run.roomDeps(), { x: 3, y: 3, width: 4, height: 5 }, 'kitchen')
    expect(run.world.grid.get('roomId', 4, 4)).not.toBe(0)

    expect(placeObject(run.objectDeps(), { x: 4, y: 4 }, COOKER, 0)).toBeDefined()
    // Anchor inside the room, second tile on undesignated floor.
    expect(placeObject(run.objectDeps(), { x: 6, y: 5 }, COOKER, 0)).toBeUndefined()
    // Both tiles outside any room.
    expect(placeObject(run.objectDeps(), { x: 8, y: 5 }, COOKER, 0)).toBeUndefined()

    expect(run.events.reasons()).toEqual(['needs-room', 'needs-room'])
  })

  it('lets an object with no room requirement stand on open ground', () => {
    const run = scenario()
    expect(place(run, 14, 14, STOOL).object.roomId).toBe(0)
  })

  it('validates against the world as it stands, not as it will be', () => {
    const run = scenario()
    putRoomShell(run, { x: 2, y: 2, width: 8, height: 8 })
    const def = DATA.objects.get(COOKER)
    const clear = { x: 4, y: 4, width: 2, height: 1 }

    expect(validatePlacement(run.world, def, clear)).toBeUndefined()
    place(run, 4, 4, COOKER, 0)
    expect(validatePlacement(run.world, def, clear)).toBe('occupied')
  })

  it('stops issuing ids at the Uint16 ceiling the grid imposes', () => {
    const run = scenario()
    const objects = run.world.objects

    let last = NO_OBJECT
    for (let i = 0; i < MAX_OBJECT_ID; i += 1) last = objects.allocateId()
    expect(last).toBe(MAX_OBJECT_ID)
    expect(objects.allocateId()).toBe(NO_OBJECT)

    putFloor(run, 14, 14)
    expect(placeObject(run.objectDeps(), { x: 14, y: 14 }, STOOL)).toBeUndefined()
    expect(run.events.reasons()).toEqual(['id-exhausted'])
  })
})

/* -------------------------------------------------------------------------- */
/* Room registration                                                           */
/* -------------------------------------------------------------------------- */

describe('room registration', () => {
  it('registers a placed object with the room it stands in', () => {
    const run = scenario()
    const roomId = makeRoom(run, { x: 2, y: 2, width: 8, height: 8 }, 'kitchen')

    const cooker = place(run, 4, 4, COOKER, 0)
    expect(cooker.object.roomId).toBe(roomId)
    expect(run.world.objects.objectCount(roomId, COOKER)).toBe(1)
    expect(run.world.objects.inRoom(roomId).map((entity) => entity.id)).toEqual([cooker.id])
  })

  it('makes requirement evaluation a lookup rather than a scan', () => {
    const run = scenario()
    const roomId = makeRoom(run, { x: 2, y: 2, width: 8, height: 8 }, 'kitchen')

    expect(run.world.contents().objectCount(roomId, COOKER)).toBe(0)
    place(run, 4, 4, COOKER, 0)
    place(run, 4, 6, COOKER, 0)
    expect(run.world.contents().objectCount(roomId, COOKER)).toBe(2)
  })

  it('attributes a wall fixture to the room it faces', () => {
    const run = scenario()
    const roomId = makeRoom(run, { x: 2, y: 2, width: 6, height: 6 }, 'washroom')

    // Anchored in the shell wall, which detection puts in no room at all.
    const shower = place(run, 2, 4, SHOWER_HEAD)
    expect(run.world.grid.get('roomId', 2, 4)).toBe(0)
    expect(shower.object.roomId).toBe(roomId)
    expect(run.world.objects.objectCount(roomId, SHOWER_HEAD)).toBe(1)
  })

  it('turns a washroom functional when its shower head goes up', () => {
    const run = scenario()
    const roomId = makeRoom(run, { x: 2, y: 2, width: 6, height: 6 }, 'washroom')
    expect(missing(run, roomId)).toEqual([SHOWER_HEAD])

    place(run, 2, 4, SHOWER_HEAD)
    expect(statusOf(run, roomId).functional).toBe(true)
  })

  it('invalidates the room status the moment an object is removed', () => {
    const run = scenario()
    const roomId = makeRoom(run, { x: 2, y: 2, width: 8, height: 8 }, 'kitchen')

    place(run, 4, 4, COOKER, 0)
    place(run, 4, 6, 'fridge')
    const sink = place(run, 6, 6, 'kitchen_sink')
    expect(statusOf(run, roomId).functional).toBe(true)

    run.events.clear()
    expect(removeObject(run.objectDeps(), sink.id)).toBe(true)

    expect(statusOf(run, roomId).functional).toBe(false)
    expect(missing(run, roomId)).toEqual(['kitchen_sink'])
    expect(run.world.objects.objectCount(roomId, 'kitchen_sink')).toBe(0)
    expect(run.events.of('rooms.notFunctional')).toHaveLength(1)
  })

  it('frees every footprint tile when a multi-tile object is removed', () => {
    const run = scenario()
    putRoomShell(run, { x: 2, y: 2, width: 8, height: 8 })
    const cooker = place(run, 4, 4, COOKER, 90)

    expect(removeObject(run.objectDeps(), cooker.id)).toBe(true)
    expect(run.world.objects.at(run.world.grid.idx(4, 4))).toBeUndefined()
    expect(run.world.objects.at(run.world.grid.idx(4, 5))).toBeUndefined()
    expect(run.world.grid.get('objectId', 4, 4)).toBe(NO_OBJECT)
    expect(run.world.objects.size).toBe(0)
  })

  it('reports removing an entity that is not there', () => {
    const run = scenario()
    expect(removeObject(run.objectDeps(), 9999)).toBe(false)
    expect(run.events.reasons()).toEqual(['unknown-entity'])
  })

  it('follows its room when a wall change splits the room in two', () => {
    const run = scenario()
    const roomId = makeRoom(run, { x: 2, y: 2, width: 11, height: 6 }, 'washroom')

    const west = place(run, 2, 4, SHOWER_HEAD)
    const east = place(run, 12, 4, SHOWER_HEAD)
    expect(run.world.objects.objectCount(roomId, SHOWER_HEAD)).toBe(2)

    // A partition down the middle. Detection dissolves the room and re-fills
    // both halves; the half holding the lowest tile reclaims the id.
    for (let y = 3; y <= 6; y += 1) putWall(run, 7, y)
    detectRooms(run.roomDeps())

    const westRoom = run.world.grid.get('roomId', 3, 3)
    const eastRoom = run.world.grid.get('roomId', 11, 3)
    expect(westRoom).toBe(roomId)
    expect(eastRoom).not.toBe(0)
    expect(eastRoom).not.toBe(roomId)

    expect(west.object.roomId).toBe(westRoom)
    expect(east.object.roomId).toBe(eastRoom)
    expect(run.world.objects.objectCount(westRoom, SHOWER_HEAD)).toBe(1)
    expect(run.world.objects.objectCount(eastRoom, SHOWER_HEAD)).toBe(1)
  })

  it('lets go of a room that no longer exists', () => {
    const run = scenario()
    const roomId = makeRoom(run, { x: 2, y: 2, width: 8, height: 8 }, 'kitchen')
    const cooker = place(run, 4, 4, COOKER, 0)
    expect(cooker.object.roomId).toBe(roomId)

    run.sim.enqueue({
      type: 'rooms.undesignate',
      payload: { rect: { x: 3, y: 3, width: 6, height: 6 } },
      issuedAtTick: run.sim.tick,
    })
    run.sim.step()

    expect(run.world.rooms.get(roomId)).toBeUndefined()
    expect(cooker.object.roomId).toBe(0)
    expect(run.world.objects.objectCount(roomId, COOKER)).toBe(0)
    // The object survives its room. Only the registration went.
    expect(run.world.objects.get(cooker.id)).toBe(cooker)
  })

  it('grades a room designated over objects that were already standing there', () => {
    const run = scenario()
    putRoomShell(run, { x: 2, y: 2, width: 8, height: 8 })

    place(run, 4, 4, COOKER, 0)
    place(run, 4, 6, 'fridge')
    place(run, 6, 6, 'kitchen_sink')

    run.sim.enqueue({
      type: 'rooms.designate',
      payload: { rect: { x: 3, y: 3, width: 6, height: 6 }, roomDefId: 'kitchen' },
      issuedAtTick: run.sim.tick,
    })
    run.sim.step()

    const roomId = run.world.grid.get('roomId', 4, 4)
    expect(roomId).not.toBe(0)
    expect(statusOf(run, roomId).functional).toBe(true)
    expect(run.events.of('rooms.notFunctional')).toHaveLength(0)
  })

  it('answers zero occupants until T2.4 supplies heads', () => {
    const run = scenario()
    expect(run.world.contents().occupants(1)).toBe(0)
  })
})

/* -------------------------------------------------------------------------- */
/* Room attribution                                                            */
/* -------------------------------------------------------------------------- */

describe('containingRoom', () => {
  it('leaves a floor object outside every room in no room', () => {
    const run = scenario()
    putFloor(run, 14, 14)
    expect(containingRoom(run.world, DATA.objects.get(STOOL), run.world.grid.idx(14, 14))).toBe(0)
  })

  it('prefers the adjoining room that lists the fixture over the lower id', () => {
    const run = scenario({ size: 20 })
    const cellId = makeRoom(run, { x: 2, y: 2, width: 7, height: 6 }, 'cell')
    const kitchenId = makeRoom(run, { x: 8, y: 2, width: 7, height: 6 }, 'kitchen')
    expect(cellId).toBeLessThan(kitchenId)

    // The wall the two rooms share, which belongs to neither.
    const shared = run.world.grid.idx(8, 4)
    expect(run.world.grid.getAt('roomId', shared)).toBe(0)

    const firstAid = DATA.objects.get('first_aid_station')
    expect(firstAid.countsForRooms).toContain('kitchen')
    expect(firstAid.countsForRooms).not.toContain('cell')
    expect(containingRoom(run.world, firstAid, shared)).toBe(kitchenId)

    const whiteboard = DATA.objects.get('whiteboard')
    expect(whiteboard.countsForRooms).toEqual(['classroom'])
    // Neither room wants a whiteboard, so the lowest adjoining id breaks the tie.
    expect(containingRoom(run.world, whiteboard, shared)).toBe(cellId)
  })
})

/* -------------------------------------------------------------------------- */
/* Commands                                                                    */
/* -------------------------------------------------------------------------- */

describe('object commands', () => {
  it('places and removes through the command queue', () => {
    const run = scenario()
    putRoomShell(run, { x: 2, y: 2, width: 8, height: 8 })

    run.sim.enqueue({
      type: OBJECT_COMMANDS.placeObject,
      payload: { tile: { x: 4, y: 4 }, objectDefId: COOKER, rotation: 90 },
      issuedAtTick: 0,
    })
    run.sim.step()

    const entity = run.world.objects.at(run.world.grid.idx(4, 5))
    expect(entity?.object.rotation).toBe(90)

    run.sim.enqueue({
      type: OBJECT_COMMANDS.removeObject,
      payload: { entityId: entity?.id ?? 0 },
      issuedAtTick: run.sim.tick,
    })
    run.sim.step()
    expect(run.world.objects.size).toBe(0)
  })

  it('accepts objectEntityId as an alias for entityId (T8.10)', () => {
    const run = scenario()
    putRoomShell(run, { x: 2, y: 2, width: 8, height: 8 })
    const placed = place(run, 4, 4, COOKER, 0)

    run.sim.enqueue({
      type: OBJECT_COMMANDS.removeObject,
      payload: { objectEntityId: placed.id },
      issuedAtTick: run.sim.tick,
    })
    run.sim.step()
    expect(run.world.objects.get(placed.id)).toBeUndefined()
  })

  it('defaults an absent rotation to upright', () => {
    const run = scenario()
    putRoomShell(run, { x: 2, y: 2, width: 8, height: 8 })

    run.sim.enqueue({
      type: OBJECT_COMMANDS.placeObject,
      payload: { tile: { x: 4, y: 4 }, objectDefId: COOKER },
      issuedAtTick: 0,
    })
    run.sim.step()

    expect(run.world.objects.at(run.world.grid.idx(5, 4))?.object.rotation).toBe(0)
  })

  it('turns a malformed payload into a CausalEvent, not an exception', () => {
    const run = scenario()
    const bad: readonly Command[] = [
      { type: OBJECT_COMMANDS.placeObject, payload: 7, issuedAtTick: 0 },
      { type: OBJECT_COMMANDS.placeObject, payload: { tile: { x: 4 } }, issuedAtTick: 0 },
      {
        type: OBJECT_COMMANDS.placeObject,
        payload: { tile: { x: 4, y: 4 }, objectDefId: COOKER, rotation: 45 },
        issuedAtTick: 0,
      },
      { type: OBJECT_COMMANDS.removeObject, payload: { entityId: 'one' }, issuedAtTick: 0 },
    ]
    run.sim.enqueueAll(bad)
    run.sim.step()

    expect(run.events.reasons()).toEqual([
      'invalid-payload',
      'invalid-payload',
      'invalid-rotation',
      'invalid-payload',
    ])
    expect(run.world.objects.size).toBe(0)
  })

  it('reaches the same fingerprint from the same commands', () => {
    const build = (): Scenario => {
      const run = scenario()
      putRoomShell(run, { x: 2, y: 2, width: 8, height: 8 })
      for (const tile of [
        { x: 4, y: 4 },
        { x: 4, y: 6 },
        { x: 6, y: 6 },
      ]) {
        run.sim.enqueue({
          type: OBJECT_COMMANDS.placeObject,
          payload: { tile, objectDefId: COOKER, rotation: 90 },
          issuedAtTick: 0,
        })
      }
      run.sim.step()
      return run
    }

    expect(build().sim.hash()).toBe(build().sim.hash())
  })

  it('changes the fingerprint when an object arrives or leaves', () => {
    const run = scenario()
    putRoomShell(run, { x: 2, y: 2, width: 8, height: 8 })
    const empty = run.sim.hash()

    const cooker = place(run, 4, 4, COOKER, 0)
    const placed = run.sim.hash()
    expect(placed).not.toBe(empty)

    removeObject(run.objectDeps(), cooker.id)
    expect(run.sim.hash()).not.toBe(placed)
  })
})

/* -------------------------------------------------------------------------- */
/* Power and water                                                             */
/* -------------------------------------------------------------------------- */

describe('power and water flags', () => {
  it('supplies everything while utilitiesEnabled is off', () => {
    expect(DATA.balance.utilities.utilitiesEnabled).toBe(false)

    const run = scenario()
    putRoomShell(run, { x: 2, y: 2, width: 8, height: 8 })

    const cooker = place(run, 4, 4, COOKER, 0)
    expect(DATA.objects.get(COOKER).needsPower).toBeGreaterThan(0)
    expect(cooker.object.hasPower).toBe(true)
    expect(cooker.object.hasWater).toBe(true)
  })

  it('reads an object that asks for nothing as supplied', () => {
    const run = scenario()
    putRoomShell(run, { x: 2, y: 2, width: 8, height: 8 })

    const stool = place(run, 4, 4, STOOL)
    expect(DATA.objects.get(STOOL).needsPower).toBe(0)
    expect(DATA.objects.get(STOOL).needsWater).toBe(false)
    expect(stool.object.hasPower).toBe(true)
    expect(stool.object.hasWater).toBe(true)
  })
})
