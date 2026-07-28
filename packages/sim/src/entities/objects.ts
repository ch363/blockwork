/**
 * Objects: the furniture, fixtures and machines a room is made of (T1.4, PRD
 * 5.3).
 *
 * An object is the first thing in this simulation that is an **entity** rather
 * than a property of a tile. It has an id of its own, it outlives the tile it
 * stands on, and other systems will hold references to it: a job points at a
 * cooker, a need discharge points at a toilet, a grading rule points at a
 * bookshelf. So it gets PRD 4.4's shape — an id, a kind, a cached tile
 * coordinate — and an `ObjectComponent` holding everything specific to being
 * an object.
 *
 * Three decisions here are load bearing.
 *
 * **The room an object is in is an index, not a search.** T1.3 left
 * `RoomContents` as an interface precisely so that this ticket could answer
 * "how many toilets does room 12 have" with a map lookup. Every placement and
 * removal maintains that index, and detection rebinds it through
 * `RoomWorld.roomAssigned` at the moment it writes new room ids, so a room is
 * never graded against contents that belong to the room it used to be. The
 * alternative — walking the tile set on every evaluation — turns requirement
 * checking from O(1) into O(area) at exactly the scale where it matters.
 *
 * **A wall object belongs to the room it faces, not the wall it is in.**
 * Detection never puts a wall tile in a room, so a shower head anchored in a
 * washroom wall has no room of its own; without a rule for it, `washroom`
 * could never satisfy its one requirement. The rule is: use the anchor's own
 * room if it has one, otherwise, for wall and door fixtures only, take the
 * adjoining room that lists the object in `countsForRooms`, and the lowest
 * adjoining room id if none does. That is what `countsForRooms` is for, and it
 * gives a deterministic answer on a wall between two rooms.
 *
 * **The grid stores the anchor and nothing else.** PRD 4.3 is explicit that
 * `TileGrid.objectId` is the anchor tile of a multi-tile object, which is what
 * the renderer needs to draw a 2x1 cooker once rather than twice. Occupancy of
 * the rest of the footprint therefore lives in this registry, and `objectAt`
 * is the only honest way to ask what is standing on a tile.
 *
 * Power and water are booleans on the component, not a system's private state,
 * because every consumer of "is this cooker working" is somewhere else. Until
 * T5.5 builds the grids, `balance.utilities.utilitiesEnabled` decides: while it
 * is false everything is supplied, and while it is true supply is read from
 * `powerGridId` / `waterGridId`, which are zero until the grids exist. Turning
 * the flag on early is therefore a way to see the unpowered-kitchen failure
 * path in the Trace panel before the utilities system is written.
 */

import { isJsonArray } from '../core/commands'
import type { Command, JsonValue } from '../core/commands'
import type { Fnv1aHasher } from '../core/hash'
import type { CommandHandler, EventSink, SystemContext } from '../core/simulation'
import type { GameData } from '../data/loader'
import type { ObjectDef } from '../data/schemas'
import { gatingNode, isUnlocked } from './directorate'
import { clipRect, isValidRect, rectTiles, refreshPassabilityRect } from '../world/construction'
import type { Rect, Tile } from '../world/construction'
import { MaterialTable, NO_MATERIAL } from '../world/materials'
import { refreshRoomStatus } from '../world/roomDetection'
import type { RoomDeps } from '../world/roomDetection'
import { NO_ROOM, ROOM_NEIGHBOURS, RoomRegistry, RoomWorld } from '../world/rooms'
import type { RoomContents } from '../world/rooms'
import { TileGrid } from '../world/tileGrid'

/* -------------------------------------------------------------------------- */
/* Geometry                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * The four orientations, in degrees clockwise.
 *
 * Degrees rather than an index because the number is what the UI sends and
 * what a save records, and `270` is unambiguous where `3` is not.
 */
export const ROTATIONS = [0, 90, 180, 270] as const

export type Rotation = (typeof ROTATIONS)[number]

export function isRotation(value: number): value is Rotation {
  return ROTATIONS.some((rotation) => rotation === value)
}

/** A footprint's extent after rotation: the quarter turns swap the axes. */
export function rotatedSize(
  size: { readonly w: number; readonly h: number },
  rotation: Rotation,
): { readonly w: number; readonly h: number } {
  return rotation === 90 || rotation === 270 ? { w: size.h, h: size.w } : { w: size.w, h: size.h }
}

/**
 * The tile rectangle an object covers.
 *
 * Anchored at the placed tile, which stays the top-left corner through every
 * rotation. Rotating about the centre would move a 2x1 object off the tile the
 * player tapped, and a drag preview that does not sit under the finger is a
 * drag preview nobody can aim.
 */
export function objectFootprint(def: ObjectDef, tile: Tile, rotation: Rotation): Rect {
  const { w, h } = rotatedSize(def.size, rotation)
  return { x: tile.x, y: tile.y, width: w, height: h }
}

/* -------------------------------------------------------------------------- */
/* The entity                                                                  */
/* -------------------------------------------------------------------------- */

/** `TileGrid.objectId` 0 means "no object" (PRD 4.3), so ids start at 1. */
export const NO_OBJECT = 0

/** `objectId` is a `Uint16Array`, which is the ceiling on live plus retired ids. */
export const MAX_OBJECT_ID = 65535

/** `powerGridId` / `waterGridId` 0: the tile is on no utility grid (PRD 4.3). */
export const NO_UTILITY_GRID = 0

/**
 * Everything specific to being an object, per PRD 4.4's component model.
 *
 * `tiles` is the footprint in ascending index order and is derived from
 * `footprint`, cached because deregistration walks it on every removal.
 *
 * `hasPower` and `hasWater` mean "the demand this object makes is met", so an
 * object that needs neither reads true for both. That keeps the question a
 * consumer asks — can this thing be used — a single conjunction rather than a
 * check against the definition every time.
 */
export interface ObjectComponent {
  readonly defId: string
  readonly rotation: Rotation
  readonly footprint: Rect
  readonly tiles: readonly number[]
  /** The room this object counts towards, or `NO_ROOM`. Maintained by the registry. */
  roomId: number
  hasPower: boolean
  hasWater: boolean
  /** Current condition, from `ObjectDef.hp`. Damage arrives with T4.8. */
  hp: number
}

/** PRD 4.4's `Entity`, for the one kind that exists so far. */
export interface ObjectEntity {
  readonly id: number
  readonly kind: 'object'
  /** The anchor tile, and the only tile that carries this id in the grid. */
  readonly tileIndex: number
  readonly tx: number
  readonly ty: number
  readonly object: ObjectComponent
}

/** Whether every utility the object asks for is currently supplied. */
export function isOperational(entity: ObjectEntity): boolean {
  return entity.object.hasPower && entity.object.hasWater
}

/* -------------------------------------------------------------------------- */
/* Registry                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Every placed object, with the two indexes that make it useful.
 *
 * `#byTile` covers the whole footprint, so occupancy is one lookup rather than
 * a rectangle intersection against every object in the prison. `#byRoom` and
 * `#members` are the room index: counts for `RoomContents.objectCount`, and
 * the membership set that makes dissolving a room O(its objects).
 *
 * Iteration is always in ascending id order, so two runs that placed the same
 * objects in a different order still hash the same.
 */
export class ObjectRegistry {
  readonly #objects = new Map<number, ObjectEntity>()
  readonly #byTile = new Map<number, number>()
  readonly #byRoom = new Map<number, Map<string, number>>()
  readonly #members = new Map<number, Set<number>>()
  #nextId = 1

  get size(): number {
    return this.#objects.size
  }

  /** The next id that would be allocated. Part of the fingerprint. */
  get nextId(): number {
    return this.#nextId
  }

  get(entityId: number): ObjectEntity | undefined {
    return this.#objects.get(entityId)
  }

  /** Objects in ascending id order. */
  all(): ObjectEntity[] {
    const entities = [...this.#objects.values()]
    entities.sort((a, b) => a.id - b.id)
    return entities
  }

  /** The object covering a tile, anchor or not. */
  at(tileIndex: number): ObjectEntity | undefined {
    const entityId = this.#byTile.get(tileIndex)
    return entityId === undefined ? undefined : this.#objects.get(entityId)
  }

  occupied(tileIndex: number): boolean {
    return this.#byTile.has(tileIndex)
  }

  /** The `RoomContents` answer: how many of one definition a room holds. */
  objectCount(roomId: number, objectDefId: string): number {
    return this.#byRoom.get(roomId)?.get(objectDefId) ?? 0
  }

  /** The objects registered to a room, in ascending id order. */
  inRoom(roomId: number): ObjectEntity[] {
    const ids = this.#members.get(roomId)
    if (ids === undefined) return []
    const entities: ObjectEntity[] = []
    for (const id of ids) {
      const entity = this.#objects.get(id)
      if (entity !== undefined) entities.push(entity)
    }
    entities.sort((a, b) => a.id - b.id)
    return entities
  }

  /** The next free id, or `NO_OBJECT` when the `Uint16` space is exhausted. */
  allocateId(): number {
    if (this.#nextId > MAX_OBJECT_ID) return NO_OBJECT
    const id = this.#nextId
    this.#nextId += 1
    return id
  }

  /** Adds an object and indexes its footprint and its room. */
  add(entity: ObjectEntity): void {
    this.#objects.set(entity.id, entity)
    for (const tile of entity.object.tiles) {
      this.#byTile.set(tile, entity.id)
    }
    this.#enterRoom(entity)
  }

  /** Forgets an object. Does not touch the grid; `removeObject` owns that. */
  remove(entityId: number): ObjectEntity | undefined {
    const entity = this.#objects.get(entityId)
    if (entity === undefined) return undefined

    this.#leaveRoom(entity)
    for (const tile of entity.object.tiles) {
      if (this.#byTile.get(tile) === entityId) this.#byTile.delete(tile)
    }
    this.#objects.delete(entityId)
    return entity
  }

  /** Moves an object between rooms. `NO_ROOM` unregisters it from all of them. */
  assign(entityId: number, roomId: number): void {
    const entity = this.#objects.get(entityId)
    if (entity === undefined || entity.object.roomId === roomId) return
    this.#leaveRoom(entity)
    entity.object.roomId = roomId
    this.#enterRoom(entity)
  }

  /** Unregisters every object of a room, for a room that no longer exists. */
  releaseRoom(roomId: number): void {
    const ids = this.#members.get(roomId)
    if (ids === undefined) return
    for (const id of ids) {
      const entity = this.#objects.get(id)
      if (entity !== undefined) entity.object.roomId = NO_ROOM
    }
    this.#members.delete(roomId)
    this.#byRoom.delete(roomId)
  }

  hashInto(hasher: Fnv1aHasher): void {
    hasher.writeUint32(this.#nextId)
    hasher.writeUint32(this.#objects.size)
    for (const entity of this.all()) {
      hasher.writeUint32(entity.id)
      hasher.writeUint32(entity.tileIndex)
      hasher.writeString(entity.object.defId)
      hasher.writeUint32(entity.object.rotation)
      hasher.writeUint32(entity.object.footprint.width)
      hasher.writeUint32(entity.object.footprint.height)
      hasher.writeUint32(entity.object.roomId)
      hasher.writeBoolean(entity.object.hasPower)
      hasher.writeBoolean(entity.object.hasWater)
      hasher.writeInt32(entity.object.hp)
    }
  }

  #enterRoom(entity: ObjectEntity): void {
    const roomId = entity.object.roomId
    if (roomId === NO_ROOM) return

    let counts = this.#byRoom.get(roomId)
    if (counts === undefined) {
      counts = new Map<string, number>()
      this.#byRoom.set(roomId, counts)
    }
    counts.set(entity.object.defId, (counts.get(entity.object.defId) ?? 0) + 1)

    let members = this.#members.get(roomId)
    if (members === undefined) {
      members = new Set<number>()
      this.#members.set(roomId, members)
    }
    members.add(entity.id)
  }

  #leaveRoom(entity: ObjectEntity): void {
    const roomId = entity.object.roomId
    if (roomId === NO_ROOM) return

    const counts = this.#byRoom.get(roomId)
    if (counts !== undefined) {
      const remaining = (counts.get(entity.object.defId) ?? 0) - 1
      if (remaining > 0) counts.set(entity.object.defId, remaining)
      else counts.delete(entity.object.defId)
      if (counts.size === 0) this.#byRoom.delete(roomId)
    }

    const members = this.#members.get(roomId)
    if (members !== undefined) {
      members.delete(entity.id)
      if (members.size === 0) this.#members.delete(roomId)
    }
  }
}

/**
 * Adapts the registry to T1.3's `RoomContents`.
 *
 * `occupants` answers zero here: heads live on `InmateRegistry` (T2.4), wired
 * through `inmateRoomContents` / `InmateWorld.contents`. Using this adapter
 * alone would silently under-scale every `perOccupant` requirement.
 */
export function objectRoomContents(objects: ObjectRegistry): RoomContents {
  return {
    objectCount(roomId: number, objectId: string): number {
      return objects.objectCount(roomId, objectId)
    },
    occupants(): number {
      return 0
    },
  }
}

/* -------------------------------------------------------------------------- */
/* World                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * A world with rooms that also knows what is standing in them.
 *
 * It holds `GameData` where its ancestors do not, because the room rebinding
 * hooks are called from inside detection with no dependency bundle to hand and
 * they need an object's `placement` and `countsForRooms` to answer correctly.
 * Content is not state, so it stays out of the fingerprint for the same reason
 * `MaterialTable` does.
 */
export class ObjectWorld extends RoomWorld {
  readonly objects: ObjectRegistry
  readonly data: GameData

  readonly #contents: RoomContents

  constructor(
    grid: TileGrid,
    materials: MaterialTable,
    rooms: RoomRegistry,
    objects: ObjectRegistry,
    data: GameData,
  ) {
    super(grid, materials, rooms)
    this.objects = objects
    this.data = data
    this.#contents = objectRoomContents(objects)
  }

  override contents(): RoomContents {
    return this.#contents
  }

  override roomAssigned(_roomId: number, tiles: readonly number[]): void {
    // Recomputed rather than assigned, because a wall fixture beside these
    // tiles may belong to this room, to the room on the other side of it, or
    // to neither, and only `containingRoom` knows the rule.
    rebindObjects(this, tiles)
  }

  override roomDissolved(roomId: number): void {
    this.objects.releaseRoom(roomId)
  }

  override hashInto(hasher: Fnv1aHasher): void {
    super.hashInto(hasher)
    this.objects.hashInto(hasher)
  }
}

/** An unbuilt world with objects wired in. Mirrors `createRoomWorld`. */
export function createObjectWorld(size: number, data: GameData): ObjectWorld {
  const world = new ObjectWorld(
    TileGrid.allocate(size),
    MaterialTable.from(data.materials.ids()),
    new RoomRegistry(size, data.rooms.ids()),
    new ObjectRegistry(),
    data,
  )
  world.grid.fill('outdoors', 1)
  refreshPassabilityRect(world, data)
  return world
}

/* -------------------------------------------------------------------------- */
/* Room attribution                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Which room an object anchored at `anchorTile` counts towards.
 *
 * The anchor's own room wins outright. Only wall and door fixtures fall
 * through to the neighbours, because only they are anchored in tiles that
 * detection refuses to put in a room; a floor object outside any room simply
 * counts for nothing.
 *
 * Among the neighbours, a room that lists this object in `countsForRooms` is
 * preferred — a shower head in a shared wall belongs to the washroom, not the
 * corridor — and the lowest adjoining room id breaks any remaining tie, so the
 * answer never depends on which room was detected first.
 */
export function containingRoom(world: ObjectWorld, def: ObjectDef, anchorTile: number): number {
  const grid = world.grid
  const own = grid.getAt('roomId', anchorTile)
  if (own !== NO_ROOM) return own
  if (def.placement !== 'wall' && def.placement !== 'door') return NO_ROOM

  const size = grid.size
  const y = Math.floor(anchorTile / size)
  const x = anchorTile - y * size

  const adjoining = new Set<number>()
  for (const [dx, dy] of ROOM_NEIGHBOURS) {
    const nx = x + dx
    const ny = y + dy
    if (nx < 0 || ny < 0 || nx >= size || ny >= size) continue
    const roomId = grid.getAt('roomId', ny * size + nx)
    if (roomId !== NO_ROOM) adjoining.add(roomId)
  }

  const ordered = [...adjoining].sort((a, b) => a - b)
  for (const roomId of ordered) {
    const room = world.rooms.get(roomId)
    if (room !== undefined && def.countsForRooms.includes(room.defId)) return roomId
  }
  return ordered[0] ?? NO_ROOM
}

/**
 * Recomputes the room of every object anchored on, or beside, `tiles`.
 *
 * The neighbours are included for the wall fixtures of `containingRoom`: their
 * anchors are never in a room's own tile set, so a pass that only looked at
 * `tiles` would never rebind them.
 */
function rebindObjects(world: ObjectWorld, tiles: readonly number[]): void {
  const size = world.grid.size
  const seen = new Set<number>()

  const consider = (tileIndex: number): void => {
    const entity = world.objects.at(tileIndex)
    if (entity === undefined || entity.tileIndex !== tileIndex) return
    if (seen.has(entity.id)) return
    seen.add(entity.id)

    const def = world.data.objects.find(entity.object.defId)
    if (def === undefined) return
    world.objects.assign(entity.id, containingRoom(world, def, tileIndex))
  }

  for (const tile of tiles) {
    consider(tile)
    const y = Math.floor(tile / size)
    const x = tile - y * size
    for (const [dx, dy] of ROOM_NEIGHBOURS) {
      const nx = x + dx
      const ny = y + dy
      if (nx < 0 || ny < 0 || nx >= size || ny >= size) continue
      consider(ny * size + nx)
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Utilities                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Whether an object's power demand is met.
 *
 * Three cases, in order: an object that needs no power always has it; while
 * `balance.utilities.utilitiesEnabled` is false nothing is ever short; and
 * otherwise the answer comes off the grid. A non-zero `powerGridId` that is
 * currently shed (brownout) does not count as supplied.
 */
export function suppliesPower(world: ObjectWorld, def: ObjectDef, anchorTile: number): boolean {
  if (def.needsPower <= 0) return true
  if (!world.data.balance.utilities.utilitiesEnabled) return true
  const gridId = world.grid.getAt('powerGridId', anchorTile)
  if (gridId === NO_UTILITY_GRID) return false
  if (isPowerBranchShed(world, gridId)) return false
  return true
}

/** Whether an object's water demand is met. See `suppliesPower`. */
export function suppliesWater(world: ObjectWorld, def: ObjectDef, anchorTile: number): boolean {
  if (!def.needsWater) return true
  if (!world.data.balance.utilities.utilitiesEnabled) return true
  return world.grid.getAt('waterGridId', anchorTile) !== NO_UTILITY_GRID
}

function isPowerBranchShed(world: ObjectWorld, gridId: number): boolean {
  const power = (world as { readonly power?: { isBranchShed(id: number): boolean } }).power
  if (power === undefined) return false
  return power.isBranchShed(gridId)
}

/* -------------------------------------------------------------------------- */
/* Events                                                                      */
/* -------------------------------------------------------------------------- */

/** Why a command, or part of one, produced nothing. */
export type ObjectRejection =
  | 'invalid-payload'
  | 'unknown-object'
  | 'unknown-entity'
  | 'invalid-rotation'
  | 'not-rotatable'
  | 'off-grid'
  | 'occupied'
  | 'wrong-surface'
  | 'needs-room'
  | 'id-exhausted'
  /** The object's Directorate node has not completed (T5.1). */
  | 'locked'
  | 'wrong-world'

export interface ObjectDeps {
  readonly world: ObjectWorld
  readonly data: GameData
  readonly events: EventSink
  readonly tick: number
}

function reject(
  deps: ObjectDeps,
  command: string,
  reason: ObjectRejection,
  detail: Readonly<Record<string, JsonValue>> = {},
): void {
  deps.events.emit({
    tick: deps.tick,
    kind: 'objects.rejected',
    causeIds: [],
    data: { command, reason, ...detail },
  })
}

function roomDeps(deps: ObjectDeps): RoomDeps {
  return { world: deps.world, data: deps.data, events: deps.events, tick: deps.tick }
}

/* -------------------------------------------------------------------------- */
/* Placement validation                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Whether a tile offers the surface an object mounts on.
 *
 * A floor object wants bare tile: not a wall, not a doorway. A wall object
 * wants a standing wall — a door has replaced the wall segment it sits in, so
 * a doorway is not somewhere to hang a mirror. A door object wants exactly the
 * door. A ceiling object wants a roof, which is what `outdoors` records.
 */
export function surfaceAccepts(world: ObjectWorld, def: ObjectDef, tileIndex: number): boolean {
  const wall = world.grid.getAt('wallMaterial', tileIndex) !== NO_MATERIAL
  const door = world.doors.has(tileIndex)

  switch (def.placement) {
    case 'floor':
      return !wall && !door
    case 'wall':
      return wall
    case 'door':
      return door
    case 'ceiling':
      return !wall && !door && world.grid.getAt('outdoors', tileIndex) === 0
  }
}

/**
 * Checks a footprint against the world. `undefined` means it may be placed.
 *
 * Validation is against the world as it stands, exactly as construction's is:
 * a tile with a half-built wall on it is an empty tile, and an object ordered
 * there will be standing in a wall the moment the wall finishes. Reconciling
 * that is construction's problem, not placement's.
 */
export function validatePlacement(
  world: ObjectWorld,
  def: ObjectDef,
  rect: Rect,
): ObjectRejection | undefined {
  if (!isValidRect(rect)) return 'off-grid'
  const clipped = clipRect(rect, world.grid.size)
  if (clipped === undefined || clipped.width !== rect.width || clipped.height !== rect.height) {
    return 'off-grid'
  }

  const tiles = rectTiles(world.grid, rect)
  for (const tile of tiles) {
    if (world.objects.occupied(tile)) return 'occupied'
    if (!surfaceAccepts(world, def, tile)) return 'wrong-surface'
  }

  if (def.requiresRoom) {
    // One room across the whole footprint. An object that must be in a room
    // and is half out of it is in no room worth naming.
    let roomId = NO_ROOM
    for (const tile of tiles) {
      const here = world.grid.getAt('roomId', tile)
      if (here === NO_ROOM) return 'needs-room'
      if (roomId !== NO_ROOM && here !== roomId) return 'needs-room'
      roomId = here
    }
  }

  return undefined
}

/* -------------------------------------------------------------------------- */
/* Commands                                                                    */
/* -------------------------------------------------------------------------- */

/** The command names the UI sends across the worker boundary (PRD 4.6). */
export const OBJECT_COMMANDS = {
  placeObject: 'objects.place',
  removeObject: 'objects.remove',
} as const

/**
 * `PlaceObject`: puts one object into the world.
 *
 * Instant, unlike construction. Objects are bought and delivered rather than
 * built, and PRD 3.4's placement flow has no build stage; T3.4 may later route
 * the delivery, which changes when the object appears but not what appears.
 *
 * @returns the placed entity, or `undefined` with a `CausalEvent` explaining why.
 */
export function placeObject(
  deps: ObjectDeps,
  tile: Tile,
  objectDefId: string,
  rotation: Rotation = 0,
): ObjectEntity | undefined {
  const command = OBJECT_COMMANDS.placeObject
  const world = deps.world

  const def = deps.data.objects.find(objectDefId)
  if (def === undefined) {
    reject(deps, command, 'unknown-object', { objectDefId })
    return undefined
  }
  if (!isRotation(rotation)) {
    reject(deps, command, 'invalid-rotation', { objectDefId, rotation })
    return undefined
  }
  if (rotation !== 0 && !def.rotatable) {
    reject(deps, command, 'not-rotatable', { objectDefId, rotation })
    return undefined
  }
  if (!isUnlocked(deps.data, world.directorate, 'objects', objectDefId)) {
    reject(deps, command, 'locked', {
      objectDefId,
      nodeId: gatingNode(deps.data, 'objects', objectDefId) ?? '',
    })
    return undefined
  }

  const footprint = objectFootprint(def, tile, rotation)
  const problem = validatePlacement(world, def, footprint)
  if (problem !== undefined) {
    reject(deps, command, problem, { objectDefId, ...footprint })
    return undefined
  }

  const id = world.objects.allocateId()
  if (id === NO_OBJECT) {
    // 65,535 objects have been placed over this prison's life. Placing a
    // 65,536th would collide with a live object in the grid's Uint16 field.
    reject(deps, command, 'id-exhausted', { objectDefId })
    return undefined
  }

  const anchorTile = world.grid.idx(tile.x, tile.y)
  const entity: ObjectEntity = {
    id,
    kind: 'object',
    tileIndex: anchorTile,
    tx: tile.x,
    ty: tile.y,
    object: {
      defId: def.id,
      rotation,
      footprint,
      tiles: rectTiles(world.grid, footprint),
      roomId: containingRoom(world, def, anchorTile),
      hasPower: suppliesPower(world, def, anchorTile),
      hasWater: suppliesWater(world, def, anchorTile),
      hp: def.hp,
    },
  }

  world.objects.add(entity)
  // Only the anchor, per PRD 4.3. The whole footprint repaints because the
  // renderer draws the object over all of it.
  world.grid.setAt('objectId', anchorTile, id)
  world.grid.markDirtyRect(footprint.x, footprint.y, footprint.width, footprint.height)

  const status = refreshRoomStatus(roomDeps(deps), entity.object.roomId)

  deps.events.emit({
    tick: deps.tick,
    kind: 'objects.placed',
    causeIds: [id],
    data: {
      entityId: id,
      objectDefId: def.id,
      tileIndex: anchorTile,
      rotation,
      roomId: entity.object.roomId,
      roomFunctional: status?.functional ?? null,
    },
  })

  return entity
}

/**
 * `RemoveObject`: takes an object back out.
 *
 * The room it was in is re-graded before this function returns, which is what
 * makes "remove the toilet and the cell stops being a cell" true on the tick
 * it happens rather than on the next system pass.
 *
 * @returns whether anything was removed.
 */
export function removeObject(deps: ObjectDeps, entityId: number): boolean {
  const command = OBJECT_COMMANDS.removeObject
  const world = deps.world

  const entity = world.objects.remove(entityId)
  if (entity === undefined) {
    reject(deps, command, 'unknown-entity', { entityId })
    return false
  }

  const { footprint, roomId, defId } = entity.object
  if (world.grid.getAt('objectId', entity.tileIndex) === entityId) {
    world.grid.setAt('objectId', entity.tileIndex, NO_OBJECT)
  }
  world.grid.markDirtyRect(footprint.x, footprint.y, footprint.width, footprint.height)

  const status = refreshRoomStatus(roomDeps(deps), roomId)

  deps.events.emit({
    tick: deps.tick,
    kind: 'objects.removed',
    causeIds: [entityId],
    data: {
      entityId,
      objectDefId: defId,
      tileIndex: entity.tileIndex,
      roomId,
      roomFunctional: status?.functional ?? null,
    },
  })

  return true
}

/* -------------------------------------------------------------------------- */
/* Command handlers                                                            */
/* -------------------------------------------------------------------------- */

/*
 * Payloads arrive as untrusted JSON from the main thread, so each one is read
 * defensively and a malformed command becomes a `CausalEvent` rather than an
 * exception inside the tick loop.
 */

function asRecord(value: JsonValue): Readonly<Record<string, JsonValue>> | undefined {
  if (value === null || typeof value !== 'object' || isJsonArray(value)) return undefined
  return value
}

function asInteger(value: JsonValue | undefined): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) ? value : undefined
}

function asTile(value: JsonValue | undefined): Tile | undefined {
  const record = value === undefined ? undefined : asRecord(value)
  if (record === undefined) return undefined
  const x = asInteger(record['x'])
  const y = asInteger(record['y'])
  if (x === undefined || y === undefined) return undefined
  return { x, y }
}

/**
 * Adapts the command queue to the functions above.
 *
 * The world comes from the `SystemContext` rather than a closure, so a
 * simulation that reloads a save keeps working. A world without an object
 * registry is a wiring mistake and says so once per command instead of
 * throwing inside the tick.
 */
export function objectCommandHandlers(data: GameData): Record<string, CommandHandler> {
  const bind = (
    context: SystemContext,
    command: Command,
    run: (deps: ObjectDeps, payload: Readonly<Record<string, JsonValue>>) => void,
  ): void => {
    const world = context.world
    const tick = context.clock.tick

    if (!(world instanceof ObjectWorld)) {
      context.events.emit({
        tick,
        kind: 'objects.rejected',
        causeIds: [],
        data: { command: command.type, reason: 'wrong-world' satisfies ObjectRejection },
      })
      return
    }

    const deps: ObjectDeps = { world, data, events: context.events, tick }

    const payload = asRecord(command.payload)
    if (payload === undefined) {
      reject(deps, command.type, 'invalid-payload')
      return
    }

    run(deps, payload)
  }

  return {
    [OBJECT_COMMANDS.placeObject]: (command, context) => {
      bind(context, command, (deps, payload) => {
        const tile = asTile(payload['tile'])
        const objectDefId = payload['objectDefId']
        // Absent rotation is the common case: most objects cannot turn.
        const rotation = payload['rotation'] === undefined ? 0 : asInteger(payload['rotation'])
        if (tile === undefined || typeof objectDefId !== 'string' || rotation === undefined) {
          reject(deps, command.type, 'invalid-payload')
          return
        }
        if (!isRotation(rotation)) {
          reject(deps, command.type, 'invalid-rotation', { objectDefId, rotation })
          return
        }
        placeObject(deps, tile, objectDefId, rotation)
      })
    },
    [OBJECT_COMMANDS.removeObject]: (command, context) => {
      bind(context, command, (deps, payload) => {
        const entityId = asInteger(payload['entityId'])
        if (entityId === undefined) {
          reject(deps, command.type, 'invalid-payload')
          return
        }
        removeObject(deps, entityId)
      })
    },
  }
}
