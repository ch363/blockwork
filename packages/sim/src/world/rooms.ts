/**
 * Rooms: what a designated area is, what is true about it, and whether it
 * works (T1.3, PRD 5.1).
 *
 * A room is not a thing the player builds. It is a **reading of the world**:
 * the player paints a designation over tiles and the simulation reports back
 * what that designation currently amounts to. Everything in a `Room` is
 * derived — the tile set, the bounding box, `enclosed`, `indoors` — and the
 * only authored state is the per-tile designation this module stores. That is
 * the whole reason detection can be incremental: a derived value may be thrown
 * away and recomputed, and the only question is how little of it to throw.
 *
 * Two decisions here are worth stating, because they are the ones a later
 * ticket would otherwise quietly contradict.
 *
 * **Requirements are a list, not a boolean.** `RoomStatus` carries one entry
 * per rule with what was required and what was found. A cell that reports
 * "false" is a dead end for the player; a cell that reports "toilet: needed 1,
 * found 0" is a next action, and it is what the Blueprint bar (T1.5) and the
 * Trace panel (T3.1) both need in order to say something useful. This is also
 * why a room that passes every rule still keeps its passing entries.
 *
 * **What is in a room is somebody else's fact.** Objects arrive in T1.4 and
 * occupants in T2.4, and both will register with their containing room so that
 * evaluation is a lookup rather than a scan of the tile set. Until they exist,
 * `RoomContents` is the seam they will fill, and its default answers zero —
 * so an unfurnished prison reports every missing object rather than silently
 * passing.
 */

import type { Fnv1aHasher } from '../core/hash'
import type { GameData } from '../data/loader'
import { ROOM_PROPERTIES } from '../data/schemas'
import type { RoomDef, RoomProperty } from '../data/schemas'

import { ConstructionWorld, refreshPassabilityRect } from './construction'
import type { Rect } from './construction'
import { tileCount } from './coords'
import { MaterialTable } from './materials'
import { TileGrid } from './tileGrid'
import { isWallLike } from './walls'

/* -------------------------------------------------------------------------- */
/* Identity                                                                    */
/* -------------------------------------------------------------------------- */

/** `TileGrid.roomId` 0 means "no room" (PRD 4.3), so ids start at 1. */
export const NO_ROOM = 0

/** `roomId` is a `Uint16Array`, which is the ceiling on live plus retired ids. */
export const MAX_ROOM_ID = 65535

/** Designation slot 0: the tile belongs to no room type. */
export const NO_DESIGNATION = 0

/** Four-connected, in a fixed order so every fill in this module agrees. */
export const ROOM_NEIGHBOURS: readonly (readonly [number, number])[] = [
  [0, -1],
  [1, 0],
  [0, 1],
  [-1, 0],
]

/* -------------------------------------------------------------------------- */
/* The room record                                                             */
/* -------------------------------------------------------------------------- */

export type RoomPropertySet = Readonly<Record<RoomProperty, boolean>>

/**
 * One connected component of designated tiles.
 *
 * `tiles` is in ascending index order and `bounds` is its bounding box, which
 * is deliberately the box and not the shape: `minWidth` and `minHeight` are
 * measured against it, so an L-shaped room is judged on the rectangle it
 * spans. A tighter measure would need the largest inscribed rectangle, which
 * costs more than the rule is worth.
 */
export interface Room {
  readonly id: number
  readonly defId: string
  readonly tiles: readonly number[]
  readonly bounds: Rect
  readonly properties: RoomPropertySet
}

/* -------------------------------------------------------------------------- */
/* Properties                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * The result of the one flood fill that answers both `enclosed` and `secure`.
 *
 * They are the same walk with two different escape conditions, so they are one
 * walk. Starting from the room's tiles and blocked by anything wall-like:
 *
 *   - reaching an **outdoor tile that is not this room's** means the space
 *     leaks to the sky through a gap that is not a door, so it is not
 *     `enclosed`. A room's own tiles are exempt because a fenced yard is
 *     enclosed by its fence (PRD 5.1 says the fill must reach an *undesignated*
 *     outdoor tile), and `kennel` in `rooms.json` requires exactly that.
 *   - reaching the **edge of the map** means the space is not inside any
 *     perimeter, so it is not `secure`. Doors block the walk, which is what
 *     makes a walled compound with a gate still secure.
 */
export interface EnclosureScan {
  readonly enclosed: boolean
  readonly secure: boolean
  /** Tiles the walk looked at. */
  readonly visited: number
  /** The walk hit its budget. `enclosed` and `secure` are reported false. */
  readonly truncated: boolean
}

/**
 * Walks outwards from a room and reports what it escaped to.
 *
 * `roomId` must already be written into the grid for the room's tiles, because
 * the outdoor test asks whether a tile belongs to this room rather than
 * carrying the tile set around.
 */
export function scanEnclosure(
  world: ConstructionWorld,
  tiles: readonly number[],
  roomId: number,
  limit: number,
): EnclosureScan {
  const grid = world.grid
  const size = grid.size
  const last = size - 1

  const seen = new Set<number>(tiles)
  const frontier = [...tiles]
  let enclosed = true
  let secure = true
  let visited = 0

  while (frontier.length > 0) {
    const index = frontier.pop()
    if (index === undefined) break

    visited += 1
    if (visited > limit) {
      return { enclosed: false, secure: false, visited, truncated: true }
    }

    const y = Math.floor(index / size)
    const x = index - y * size

    if (x === 0 || y === 0 || x === last || y === last) secure = false
    if (grid.outdoors[index] === 1 && grid.roomId[index] !== roomId) enclosed = false
    // Both answers are already known; whatever else the walk would find
    // cannot change them.
    if (!enclosed && !secure) return { enclosed, secure, visited, truncated: false }

    for (const [dx, dy] of ROOM_NEIGHBOURS) {
      const nx = x + dx
      const ny = y + dy
      if (nx < 0 || ny < 0 || nx > last || ny > last) continue
      const next = ny * size + nx
      if (seen.has(next)) continue
      seen.add(next)
      if (isWallLike(grid, world.doors, next)) continue
      frontier.push(next)
    }
  }

  return { enclosed, secure, visited, truncated: false }
}

/**
 * Every property of a tile set.
 *
 * `indoors` is "every tile has a foundation" and `outdoors` is "no tile does",
 * so a half-roofed room is neither. That is intentional: a room straddling the
 * wall of a building satisfies no honest answer, and reporting both false lets
 * the requirement list say which one the definition wanted.
 */
export function computeRoomProperties(
  world: ConstructionWorld,
  tiles: readonly number[],
  roomId: number,
  limit: number,
): { readonly properties: RoomPropertySet; readonly scan: EnclosureScan } {
  const scan = scanEnclosure(world, tiles, roomId, limit)

  let indoors = tiles.length > 0
  let outdoors = tiles.length > 0
  for (const tile of tiles) {
    if (world.grid.outdoors[tile] === 1) indoors = false
    else outdoors = false
  }

  return {
    properties: { enclosed: scan.enclosed, indoors, outdoors, secure: scan.secure },
    scan,
  }
}

/* -------------------------------------------------------------------------- */
/* Requirements                                                                */
/* -------------------------------------------------------------------------- */

export const REQUIREMENT_KINDS = [
  'minTiles',
  'minWidth',
  'minHeight',
  'property',
  'object',
] as const

export type RequirementKind = (typeof REQUIREMENT_KINDS)[number]

/**
 * One rule from a `RoomDef`, and what the world had to say about it.
 *
 * `subject` names the thing the rule is about: an object id, a property name,
 * or the dimension. It is what the UI puts in "3 cells missing a toilet", so
 * it is an id rather than prose — the display name is the data layer's.
 */
export interface RoomRequirement {
  readonly kind: RequirementKind
  readonly subject: string
  readonly required: number
  readonly actual: number
  readonly met: boolean
}

export interface RoomStatus {
  readonly roomId: number
  readonly defId: string
  /** Every requirement met. */
  readonly functional: boolean
  readonly requirements: readonly RoomRequirement[]
}

export function failedRequirements(status: RoomStatus): readonly RoomRequirement[] {
  return status.requirements.filter((requirement) => !requirement.met)
}

/**
 * What is inside a room, asked rather than scanned.
 *
 * T1.4's object registry answers `objectCount` from an index it maintains as
 * objects are placed, and T2.4 will do the same for occupants. Keeping it an
 * interface means requirement evaluation can be tested without an entity
 * store, and that this module never learns how to walk one.
 */
export interface RoomContents {
  objectCount(roomId: number, objectId: string): number
  /** Drives `requiredObjects[].perOccupant`. Zero until T2.4. */
  occupants(roomId: number): number
}

/** The default: an unfurnished, empty room. */
export const EMPTY_ROOM_CONTENTS: RoomContents = {
  objectCount(): number {
    return 0
  },
  occupants(): number {
    return 0
  },
}

function requirement(
  kind: RequirementKind,
  subject: string,
  required: number,
  actual: number,
): RoomRequirement {
  return { kind, subject, required, actual, met: actual >= required }
}

/**
 * Grades a room against its definition.
 *
 * Pure: it reads the room record and the contents, never the grid, so the
 * status of a room can be recomputed when an object moves without re-running
 * detection (which is what T1.4 needs when an object is removed).
 *
 * A rule with a minimum of zero is left out entirely rather than listed as a
 * pass. A definition that asks for nothing is not making a promise the player
 * needs to see kept.
 */
export function evaluateRoom(
  room: Room,
  def: RoomDef,
  contents: RoomContents = EMPTY_ROOM_CONTENTS,
  options: { readonly compactCells?: boolean } = {},
): RoomStatus {
  const requirements: RoomRequirement[] = []
  const compact = options.compactCells === true && def.id === 'cell'

  if (def.minTiles > 0) {
    const needed = compact ? Math.max(1, Math.ceil(def.minTiles / 2)) : def.minTiles
    requirements.push(requirement('minTiles', 'minTiles', needed, room.tiles.length))
  }
  if (!compact && def.minWidth > 0) {
    requirements.push(requirement('minWidth', 'minWidth', def.minWidth, room.bounds.width))
  }
  if (!compact && def.minHeight > 0) {
    requirements.push(requirement('minHeight', 'minHeight', def.minHeight, room.bounds.height))
  }

  // Iterated in `ROOM_PROPERTIES` order rather than the file's, so two
  // definitions that list the same properties produce the same report.
  const wanted = new Set<RoomProperty>(def.properties)
  for (const property of ROOM_PROPERTIES) {
    if (!wanted.has(property)) continue
    requirements.push(requirement('property', property, 1, room.properties[property] ? 1 : 0))
  }

  const occupants = contents.occupants(room.id)
  for (const entry of def.requiredObjects) {
    // `count` is the floor and `perOccupant` scales above it: a dormitory
    // needs one toilet at minimum and one per eight heads once it fills.
    const perOccupant = Math.ceil(occupants * (entry.perOccupant ?? 0))
    const required = Math.max(entry.count, perOccupant)
    requirements.push(
      requirement(
        'object',
        entry.objectId,
        required,
        contents.objectCount(room.id, entry.objectId),
      ),
    )
  }

  return {
    roomId: room.id,
    defId: def.id,
    functional: requirements.every((entry) => entry.met),
    requirements,
  }
}

/* -------------------------------------------------------------------------- */
/* Registry                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Every designation and every detected room.
 *
 * The designation is a parallel array in the manner of `TileGrid`, but it
 * lives here rather than as a thirteenth tile field because it is not part of
 * the save format's grid (PRD 7.4 fixes those twelve) and because nothing in
 * the hot paths reads it. It stores a slot, `roomDefIndex + 1`, for the same
 * reason the grid stores a material index: an interned integer per tile costs
 * two bytes, a string reference costs a pointer chase.
 *
 * `stale` is the incremental hinge. Construction announces a structural change
 * through `ConstructionWorld.structureChanged`, `RoomWorld` records the tile
 * here, and the next detection pass seeds itself from the set. It is a
 * subscription rather than state, so — like `TileGrid`'s dirty chunks — it does
 * not reach the determinism fingerprint, and a loaded save re-runs detection
 * from scratch rather than trusting a set that was never written.
 */
export class RoomRegistry {
  readonly size: number

  readonly #designation: Uint16Array
  readonly #defIds: readonly string[]
  readonly #slotById: ReadonlyMap<string, number>
  readonly #rooms = new Map<number, Room>()
  readonly #statuses = new Map<number, RoomStatus>()
  readonly #stale = new Set<number>()
  #nextId = 1

  /** @param defIds room definition ids in file order (`GameData.rooms.ids()`). */
  constructor(size: number, defIds: Iterable<string>) {
    this.size = size
    this.#designation = new Uint16Array(tileCount(size))

    const ordered: string[] = []
    const slotById = new Map<string, number>()
    for (const defId of defIds) {
      if (slotById.has(defId)) throw new Error(`duplicate room definition id '${defId}'`)
      ordered.push(defId)
      slotById.set(defId, ordered.length)
    }
    this.#defIds = ordered
    this.#slotById = slotById
  }

  get roomCount(): number {
    return this.#rooms.size
  }

  /** The next id that would be allocated. Part of the fingerprint. */
  get nextId(): number {
    return this.#nextId
  }

  /* -- designation -- */

  /** The stored slot, or `NO_DESIGNATION`. */
  designationAt(tileIndex: number): number {
    return this.#designation[tileIndex] ?? NO_DESIGNATION
  }

  designationIdAt(tileIndex: number): string | undefined {
    const slot = this.designationAt(tileIndex)
    return slot === NO_DESIGNATION ? undefined : this.#defIds[slot - 1]
  }

  /** The slot a definition occupies, or `undefined` if it is not a room type. */
  slotOf(defId: string): number | undefined {
    return this.#slotById.get(defId)
  }

  /** The definition a slot names. Throws on a slot this registry never issued. */
  idOfSlot(slot: number): string {
    const defId = this.#defIds[slot - 1]
    if (defId === undefined) throw new RangeError(`room designation slot ${slot} is not defined`)
    return defId
  }

  /**
   * Paints or clears one tile's designation.
   *
   * @returns whether the tile changed, so callers can scope detection to the
   *   tiles that actually moved rather than to everything they dragged over.
   */
  setDesignation(tileIndex: number, defId: string | undefined): boolean {
    let slot = NO_DESIGNATION
    if (defId !== undefined) {
      const found = this.#slotById.get(defId)
      if (found === undefined) throw new Error(`unknown room definition '${defId}'`)
      slot = found
    }
    if (this.#designation[tileIndex] === slot) return false
    this.#designation[tileIndex] = slot
    return true
  }

  /* -- rooms -- */

  get(roomId: number): Room | undefined {
    return this.#rooms.get(roomId)
  }

  /** Rooms in ascending id order. */
  all(): Room[] {
    const rooms = [...this.#rooms.values()]
    rooms.sort((a, b) => a.id - b.id)
    return rooms
  }

  set(room: Room): void {
    this.#rooms.set(room.id, room)
  }

  /** Forgets a room and its status. Does not touch `TileGrid.roomId`. */
  remove(roomId: number): Room | undefined {
    const room = this.#rooms.get(roomId)
    this.#rooms.delete(roomId)
    this.#statuses.delete(roomId)
    return room
  }

  statusOf(roomId: number): RoomStatus | undefined {
    return this.#statuses.get(roomId)
  }

  setStatus(status: RoomStatus): void {
    this.#statuses.set(status.roomId, status)
  }

  /** The next free id, or `NO_ROOM` when the `Uint16` space is exhausted. */
  allocateId(): number {
    if (this.#nextId > MAX_ROOM_ID) return NO_ROOM
    const id = this.#nextId
    this.#nextId += 1
    return id
  }

  /* -- staleness -- */

  markStale(tileIndex: number): void {
    this.#stale.add(tileIndex)
  }

  get staleCount(): number {
    return this.#stale.size
  }

  /** The tiles marked since the last call, ascending, clearing the set. */
  takeStale(): number[] {
    const tiles = [...this.#stale].sort((a, b) => a - b)
    this.#stale.clear()
    return tiles
  }

  hashInto(hasher: Fnv1aHasher): void {
    const bytes = new Uint8Array(
      this.#designation.buffer,
      this.#designation.byteOffset,
      this.#designation.byteLength,
    )
    for (let i = 0; i < bytes.length; i += 1) {
      hasher.writeByte(bytes[i] ?? 0)
    }

    hasher.writeUint32(this.#nextId)
    hasher.writeUint32(this.#rooms.size)
    for (const room of this.all()) {
      hasher.writeUint32(room.id)
      hasher.writeString(room.defId)
      hasher.writeUint32(room.tiles.length)
      hasher.writeUint32(room.bounds.x)
      hasher.writeUint32(room.bounds.y)
      hasher.writeUint32(room.bounds.width)
      hasher.writeUint32(room.bounds.height)
      for (const property of ROOM_PROPERTIES) {
        hasher.writeBoolean(room.properties[property])
      }
    }
  }
}

/* -------------------------------------------------------------------------- */
/* World                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * A buildable world that also knows about rooms.
 *
 * Subclassing `ConstructionWorld` rather than replacing it means every T1.2
 * command handler and the construction system keep working unchanged, and it
 * gives rooms the one thing they need from construction: a call when a tile's
 * structure changes, so detection can be scoped to what moved instead of
 * re-reading the map.
 */
export class RoomWorld extends ConstructionWorld {
  readonly rooms: RoomRegistry

  constructor(grid: TileGrid, materials: MaterialTable, rooms: RoomRegistry) {
    super(grid, materials)
    this.rooms = rooms
  }

  override structureChanged(tileIndex: number): void {
    // Only the tile itself. Detection widens a seed to its neighbours, because
    // a wall appearing or vanishing splits or merges the rooms either side of
    // it and neither of those tiles has changed.
    this.rooms.markStale(tileIndex)
  }

  /**
   * What is inside this world's rooms.
   *
   * The default is empty, so a world with no entity registries grades every
   * room as unfurnished rather than silently passing. T1.4's `ObjectWorld`
   * overrides it with a real lookup; T2.4 adds occupants.
   */
  contents(): RoomContents {
    return EMPTY_ROOM_CONTENTS
  }

  /**
   * Announces that detection has just written `roomId` over `tiles`.
   *
   * The counterpart of `structureChanged` for room membership. Anything that
   * indexes itself by room has to rebind here rather than on a later pass,
   * because `evaluateRoom` runs immediately after the assignment and would
   * otherwise grade the room against yesterday's contents.
   */
  roomAssigned(_roomId: number, _tiles: readonly number[]): void {
    // Intentionally empty. See the comment above.
  }

  /** Announces that a room id no longer names a room. */
  roomDissolved(_roomId: number): void {
    // Intentionally empty. See `roomAssigned`.
  }

  override hashInto(hasher: Fnv1aHasher): void {
    super.hashInto(hasher)
    this.rooms.hashInto(hasher)
  }
}

/** An unbuilt world with room detection wired in. Mirrors `createConstructionWorld`. */
export function createRoomWorld(size: number, data: GameData): RoomWorld {
  const world = new RoomWorld(
    TileGrid.allocate(size),
    MaterialTable.from(data.materials.ids()),
    new RoomRegistry(size, data.rooms.ids()),
  )
  world.grid.fill('outdoors', 1)
  refreshPassabilityRect(world, data)
  return world
}
