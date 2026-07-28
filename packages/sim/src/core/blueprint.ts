/**
 * Blueprint mode: draw the whole prison for free, then buy it in one go (T1.5,
 * PRD 3.2, 6.3).
 *
 * The load-bearing idea is that **a blueprint is not simulation state**. It is
 * a list of build actions the player has drawn but not paid for, held on the
 * main thread, reaching the worker only when they tap Commit. Nothing here is
 * hashed, nothing here ticks, and discarding a blueprint costs one assignment.
 * That is what makes planning free, and it is the whole of PRD 3.2.
 *
 * Three decisions follow from that, and they are the reason this module is the
 * size it is.
 *
 * **A `BuildAction` is a command in typed clothing.** T1.2, T1.3 and T1.4 each
 * defined their own command names and their own JSON payloads, which is right
 * for the worker boundary and useless for anything that has to reason about a
 * *list* of them. So there is one discriminated union covering every build
 * command, with a codec at each end. Pricing, validation and inversion all
 * switch on it exhaustively, so adding a build command that this module has
 * not been taught about is a compile error rather than a silently unpriced,
 * un-undoable tool.
 *
 * **Validation runs against a copy of the world, never the world.** The report
 * has to answer "what will this prison be like when the build lands", which
 * means detecting rooms that do not exist yet and grading them against objects
 * that have not been bought. There is no way to know that without running the
 * real detection over the real rules, so `projectBlueprint` builds a detached
 * `ObjectWorld`, replays the world into it, applies the staged actions and
 * settles them. The alternative — a second, simplified model of what a
 * foundation does to a room — is the kind of duplicate rule set that is right
 * on the day it is written and wrong a month later.
 *
 * The projection also **finishes the work already queued**. A player who
 * commits a wing and then draws the next one while the first is still going up
 * is asking about the settled prison, not the half-built one.
 *
 * **The price is whatever the build queue says it is.** Nothing here computes
 * a cost from a rectangle's area. The staged actions are queued into the
 * projection exactly as they would be queued into the world, and the bill is
 * the sum of the `ConstructionSite.cost` values that came back, plus
 * `ObjectDef.cost` per object. So a foundation drawn over a wall you already
 * own is free, a stroke drawn twice is charged once, and the number on the bar
 * is the number the worker will deduct, because both sides ran the same code.
 *
 * A note on where this file sits. `core/` otherwise depends on nothing below
 * it, and this module reaches into `world/` and `entities/`. That is the
 * ticket's chosen path and it is defensible — a blueprint is a statement about
 * every build system at once, so it has to sit above all of them — but the
 * arrow does point the other way from its neighbours.
 */

import type { GameData } from '../data/loader'
import { DOOR_TYPES } from '../data/schemas'
import type { DoorType, ObjectDef } from '../data/schemas'
import {
  NO_OBJECT,
  ObjectRegistry,
  ObjectWorld,
  isRotation,
  objectFootprint,
  placeObject,
  removeObject,
} from '../entities/objects'
import type { Rotation } from '../entities/objects'
import {
  applyJob,
  clipRect,
  demolish,
  isValidRect,
  paintFloor,
  placeDoor,
  placeFoundation,
  placeWall,
  rectTiles,
  refreshPassability,
  removeWall,
} from '../world/construction'
import type { ConstructionSite, Rect, Tile } from '../world/construction'
import { tileCount } from '../world/coords'
import { NO_MATERIAL } from '../world/materials'
import type { MaterialId } from '../world/materials'
import { designateRoom, detectRooms, undesignateRoom } from '../world/roomDetection'
import { NO_DESIGNATION, NO_ROOM, RoomRegistry, failedRequirements } from '../world/rooms'
import type { Room, RoomRequirement } from '../world/rooms'
import { TileGrid } from '../world/tileGrid'
import { wallLineTiles } from '../world/walls'

import { isJsonArray } from './commands'
import type { Command, JsonObject, JsonValue } from './commands'
import type { EventSink, SimulationEvent } from './simulation'

/* -------------------------------------------------------------------------- */
/* The action vocabulary                                                       */
/* -------------------------------------------------------------------------- */

/** An axis-aligned stroke, as `PlaceWall` and `RemoveWall` take one. */
export interface BuildLine {
  readonly x1: number
  readonly y1: number
  readonly x2: number
  readonly y2: number
}

/**
 * One tile's structure and designation, captured so it can be put back.
 *
 * This is what makes undo exact rather than approximate. An inverse expressed
 * as "demolish what you built" cannot restore the floor that was there first,
 * and an inverse expressed as "the opposite command" does not exist for
 * `PaintFloor` at all. A snapshot of the six facts a build command can change
 * inverts every one of them with the same primitive.
 *
 * Material and room ids rather than table indices, because a `BuildAction`
 * crosses the worker boundary as JSON and an index means nothing without the
 * table it came from.
 */
export interface TileRestore {
  readonly index: number
  /** Wall material id, or null for no wall. */
  readonly wall: MaterialId | null
  /** Floor material id, or null for bare ground. */
  readonly floor: MaterialId | null
  readonly door: DoorType | null
  readonly doorLocked: boolean
  readonly outdoors: boolean
  /** Room definition id painted on the tile, or null for none. */
  readonly designation: string | null
}

/**
 * Every build command, in one union.
 *
 * The first ten mirror T1.2, T1.3 and T1.4's commands one for one. The last
 * two exist only as inverses: `restore` puts a tile back the way it was, and
 * `removeObjectAt` names an object by the tile it stands on rather than by an
 * entity id the main thread never sees.
 */
export type BuildAction =
  | { readonly kind: 'placeFoundation'; readonly rect: Rect; readonly material: MaterialId }
  | { readonly kind: 'placeWall'; readonly line: BuildLine; readonly material: MaterialId }
  | { readonly kind: 'removeWall'; readonly line: BuildLine }
  | { readonly kind: 'placeDoor'; readonly tile: Tile; readonly doorType: DoorType }
  | { readonly kind: 'paintFloor'; readonly rect: Rect; readonly material: MaterialId }
  | { readonly kind: 'demolish'; readonly rect: Rect }
  | { readonly kind: 'designateRoom'; readonly rect: Rect; readonly roomDefId: string }
  | { readonly kind: 'undesignateRoom'; readonly rect: Rect }
  | {
      readonly kind: 'placeObject'
      readonly tile: Tile
      readonly objectDefId: string
      readonly rotation: Rotation
    }
  | { readonly kind: 'removeObject'; readonly entityId: number }
  | { readonly kind: 'removeObjectAt'; readonly tile: Tile }
  | { readonly kind: 'restore'; readonly tiles: readonly TileRestore[] }

export const BUILD_ACTION_KINDS = [
  'placeFoundation',
  'placeWall',
  'removeWall',
  'placeDoor',
  'paintFloor',
  'demolish',
  'designateRoom',
  'undesignateRoom',
  'placeObject',
  'removeObject',
  'removeObjectAt',
  'restore',
] as const

export type BuildActionKind = (typeof BUILD_ACTION_KINDS)[number]

/** The command names the UI sends across the worker boundary (PRD 4.6). */
export const BLUEPRINT_COMMANDS = {
  commit: 'blueprint.commit',
  undo: 'blueprint.undo',
} as const

/* -------------------------------------------------------------------------- */
/* JSON codec                                                                  */
/* -------------------------------------------------------------------------- */

/*
 * A commit carries its whole action list across the worker boundary, so every
 * action has to survive structured clone as plain JSON, and every action that
 * comes back has to be read defensively. `actionToJson` and `actionFromJson`
 * are the only two places that know the wire shape.
 */

function tileJson(tile: Tile): JsonObject {
  return { x: tile.x, y: tile.y }
}

function rectJson(rect: Rect): JsonObject {
  return { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
}

function restoreJson(entry: TileRestore): JsonObject {
  return {
    index: entry.index,
    wall: entry.wall,
    floor: entry.floor,
    door: entry.door,
    doorLocked: entry.doorLocked,
    outdoors: entry.outdoors,
    designation: entry.designation,
  }
}

export function actionToJson(action: BuildAction): JsonObject {
  switch (action.kind) {
    case 'placeFoundation':
      return { kind: action.kind, rect: rectJson(action.rect), material: action.material }
    case 'placeWall':
      return { kind: action.kind, line: { ...action.line }, material: action.material }
    case 'removeWall':
      return { kind: action.kind, line: { ...action.line } }
    case 'placeDoor':
      return { kind: action.kind, tile: tileJson(action.tile), doorType: action.doorType }
    case 'paintFloor':
      return { kind: action.kind, rect: rectJson(action.rect), material: action.material }
    case 'demolish':
      return { kind: action.kind, rect: rectJson(action.rect) }
    case 'designateRoom':
      return { kind: action.kind, rect: rectJson(action.rect), roomDefId: action.roomDefId }
    case 'undesignateRoom':
      return { kind: action.kind, rect: rectJson(action.rect) }
    case 'placeObject':
      return {
        kind: action.kind,
        tile: tileJson(action.tile),
        objectDefId: action.objectDefId,
        rotation: action.rotation,
      }
    case 'removeObject':
      return { kind: action.kind, entityId: action.entityId }
    case 'removeObjectAt':
      return { kind: action.kind, tile: tileJson(action.tile) }
    case 'restore':
      return { kind: action.kind, tiles: action.tiles.map(restoreJson) }
  }
}

function asRecord(value: JsonValue | undefined): Readonly<Record<string, JsonValue>> | undefined {
  if (value === undefined || value === null || typeof value !== 'object' || isJsonArray(value)) {
    return undefined
  }
  return value
}

function asInteger(value: JsonValue | undefined): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) ? value : undefined
}

function asString(value: JsonValue | undefined): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function asNullableString(value: JsonValue | undefined): string | null | undefined {
  if (value === null) return null
  return asString(value)
}

function asBoolean(value: JsonValue | undefined): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined
}

function asDoorType(value: JsonValue | undefined): DoorType | undefined {
  return DOOR_TYPES.find((type) => type === value)
}

function asTile(value: JsonValue | undefined): Tile | undefined {
  const record = asRecord(value)
  if (record === undefined) return undefined
  const x = asInteger(record['x'])
  const y = asInteger(record['y'])
  if (x === undefined || y === undefined) return undefined
  return { x, y }
}

function asRect(value: JsonValue | undefined): Rect | undefined {
  const record = asRecord(value)
  if (record === undefined) return undefined
  const x = asInteger(record['x'])
  const y = asInteger(record['y'])
  const width = asInteger(record['width'])
  const height = asInteger(record['height'])
  if (x === undefined || y === undefined || width === undefined || height === undefined) {
    return undefined
  }
  return { x, y, width, height }
}

function asLine(value: JsonValue | undefined): BuildLine | undefined {
  const record = asRecord(value)
  if (record === undefined) return undefined
  const x1 = asInteger(record['x1'])
  const y1 = asInteger(record['y1'])
  const x2 = asInteger(record['x2'])
  const y2 = asInteger(record['y2'])
  if (x1 === undefined || y1 === undefined || x2 === undefined || y2 === undefined) {
    return undefined
  }
  return { x1, y1, x2, y2 }
}

function asRestore(value: JsonValue): TileRestore | undefined {
  const record = asRecord(value)
  if (record === undefined) return undefined

  const index = asInteger(record['index'])
  const wall = asNullableString(record['wall'])
  const floor = asNullableString(record['floor'])
  const doorLocked = asBoolean(record['doorLocked'])
  const outdoors = asBoolean(record['outdoors'])
  const designation = asNullableString(record['designation'])
  const rawDoor = record['door']
  const door = rawDoor === null ? null : asDoorType(rawDoor)

  if (
    index === undefined ||
    wall === undefined ||
    floor === undefined ||
    door === undefined ||
    doorLocked === undefined ||
    outdoors === undefined ||
    designation === undefined
  ) {
    return undefined
  }
  return { index, wall, floor, door, doorLocked, outdoors, designation }
}

/** Reads one action off the wire. `undefined` for anything malformed. */
export function actionFromJson(value: JsonValue): BuildAction | undefined {
  const record = asRecord(value)
  if (record === undefined) return undefined

  const kind = BUILD_ACTION_KINDS.find((candidate) => candidate === record['kind'])
  if (kind === undefined) return undefined

  switch (kind) {
    case 'placeFoundation':
    case 'paintFloor': {
      const rect = asRect(record['rect'])
      const material = asString(record['material'])
      if (rect === undefined || material === undefined) return undefined
      return { kind, rect, material }
    }
    case 'placeWall': {
      const line = asLine(record['line'])
      const material = asString(record['material'])
      if (line === undefined || material === undefined) return undefined
      return { kind, line, material }
    }
    case 'removeWall': {
      const line = asLine(record['line'])
      if (line === undefined) return undefined
      return { kind, line }
    }
    case 'placeDoor': {
      const tile = asTile(record['tile'])
      const doorType = asDoorType(record['doorType'])
      if (tile === undefined || doorType === undefined) return undefined
      return { kind, tile, doorType }
    }
    case 'demolish':
    case 'undesignateRoom': {
      const rect = asRect(record['rect'])
      if (rect === undefined) return undefined
      return { kind, rect }
    }
    case 'designateRoom': {
      const rect = asRect(record['rect'])
      const roomDefId = asString(record['roomDefId'])
      if (rect === undefined || roomDefId === undefined) return undefined
      return { kind, rect, roomDefId }
    }
    case 'placeObject': {
      const tile = asTile(record['tile'])
      const objectDefId = asString(record['objectDefId'])
      const rotation = asInteger(record['rotation'])
      if (tile === undefined || objectDefId === undefined || rotation === undefined)
        return undefined
      if (!isRotation(rotation)) return undefined
      return { kind, tile, objectDefId, rotation }
    }
    case 'removeObject': {
      const entityId = asInteger(record['entityId'])
      if (entityId === undefined) return undefined
      return { kind, entityId }
    }
    case 'removeObjectAt': {
      const tile = asTile(record['tile'])
      if (tile === undefined) return undefined
      return { kind, tile }
    }
    case 'restore': {
      const raw = record['tiles']
      if (raw === undefined || !isJsonArray(raw)) return undefined
      const tiles: TileRestore[] = []
      for (const entry of raw) {
        const parsed = asRestore(entry)
        if (parsed === undefined) return undefined
        tiles.push(parsed)
      }
      return { kind, tiles }
    }
  }
}

/** The one atomic command a Commit sends (PRD 3.2). */
export function commitCommand(actions: readonly BuildAction[], issuedAtTick: number): Command {
  return {
    type: BLUEPRINT_COMMANDS.commit,
    payload: { actions: actions.map(actionToJson) },
    issuedAtTick,
  }
}

/** Reverses the most recent commit. Payloadless: the ledger is a stack. */
export function undoCommand(issuedAtTick: number): Command {
  return { type: BLUEPRINT_COMMANDS.undo, payload: {}, issuedAtTick }
}

/* -------------------------------------------------------------------------- */
/* Geometry                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Every tile an action can touch, before it is applied.
 *
 * Used for two things: scoping the validity report to the rooms the player is
 * actually drawing on, and choosing which tiles an inverse has to snapshot.
 * It is deliberately the *footprint*, not the set of tiles that will change —
 * an action that turns out to be a no-op still names the tiles it aimed at.
 */
export function actionTiles(world: ObjectWorld, data: GameData, action: BuildAction): number[] {
  const grid = world.grid

  const ofRect = (rect: Rect): number[] => {
    if (!isValidRect(rect)) return []
    const clipped = clipRect(rect, grid.size)
    return clipped === undefined ? [] : rectTiles(grid, clipped)
  }

  switch (action.kind) {
    case 'placeFoundation':
    case 'paintFloor':
    case 'demolish':
    case 'designateRoom':
    case 'undesignateRoom':
      return ofRect(action.rect)
    case 'placeWall':
    case 'removeWall':
      return wallLineTiles(grid, action.line)
    case 'placeDoor':
    case 'removeObjectAt':
      return grid.inBounds(action.tile.x, action.tile.y)
        ? [grid.idx(action.tile.x, action.tile.y)]
        : []
    case 'placeObject': {
      const def = data.objects.find(action.objectDefId)
      if (def === undefined) return []
      return ofRect(objectFootprint(def, action.tile, action.rotation))
    }
    case 'removeObject': {
      const entity = world.objects.get(action.entityId)
      return entity === undefined ? [] : [...entity.object.tiles]
    }
    case 'restore':
      return action.tiles.map((entry) => entry.index)
  }
}

/* -------------------------------------------------------------------------- */
/* Money                                                                       */
/* -------------------------------------------------------------------------- */

/*
 * Every number below comes out of `balance.json` or a definition file. The one
 * arithmetic decision this module makes is to floor, always, so that salvage
 * can never be worth more than the fraction says.
 */

function materialCost(data: GameData, id: MaterialId | null): number {
  return id === null ? 0 : (data.materials.find(id)?.costPerTile ?? 0)
}

function doorCost(data: GameData, type: DoorType | null): number {
  return type === null ? 0 : (data.doors.find(type)?.cost ?? 0)
}

/** What clearing something worth `value` gives back, per `balance.json`. */
export function salvage(data: GameData, value: number): number {
  return Math.floor(value * data.balance.construction.materialRefundOnDemolish)
}

/**
 * What tearing up a queued site gives back, scaled by the work already done.
 *
 * This is the "refunding proportionally to work completed" rule. A site nobody
 * has started on refunds in full, because nothing has been consumed. A site
 * that is finished refunds `materialRefundOnDemolish` of its cost, which is
 * exactly what demolishing the finished thing would have paid — so the player
 * cannot game the timing of an undo, and the curve between the two ends is a
 * straight line rather than a cliff.
 */
export function siteCancellationRefund(data: GameData, site: ConstructionSite): number {
  const fraction = data.balance.construction.materialRefundOnDemolish
  const progress =
    site.workTicksRequired <= 0 ? 1 : Math.min(1, site.workTicksDone / site.workTicksRequired)
  return Math.floor(site.cost * (1 - progress * (1 - fraction)))
}

/* -------------------------------------------------------------------------- */
/* Applying actions                                                            */
/* -------------------------------------------------------------------------- */

/**
 * What an action needs to run. Structurally a `ConstructionDeps`, a `RoomDeps`
 * and an `ObjectDeps` all at once, which is why it can be handed to any of the
 * three layers' functions unchanged.
 */
export interface BuildDeps {
  readonly world: ObjectWorld
  readonly data: GameData
  readonly events: EventSink
  readonly tick: number
}

/** What running a list of actions did, in the terms the blueprint bar shows. */
export interface BuildRun {
  /** Construction sites the run queued. */
  readonly tiles: number
  /** Objects the run placed. */
  readonly objects: number
  /** Material and object cost, before any refund. */
  readonly cost: number
  /** Salvage and cancellations the run generated. */
  readonly refund: number
}

interface ActionOutcome {
  readonly objects: number
  readonly cost: number
  readonly refund: number
}

const NOTHING: ActionOutcome = { objects: 0, cost: 0, refund: 0 }

/** Writes a tile's structure, then everything derived from it. Mirrors `applyJob`. */
function writeStructure(deps: BuildDeps, index: number): void {
  const { world, data } = deps
  refreshPassability(world, data, index)
  const { x, y } = world.grid.xy(index)
  // Autotiling reads the eight neighbours, so a change repaints all nine tiles.
  world.grid.markDirtyRect(x - 1, y - 1, 3, 3)
  world.structureChanged(index)
}

/** Which of a tile's three slots a restore would rewrite. */
interface RestoreDiff {
  readonly inBounds: boolean
  /** The wall slot, which a door shares: a door occupies the segment it sits in. */
  readonly wall: boolean
  readonly floor: boolean
  readonly wallWanted: number
  readonly floorWanted: number
}

function restoreDiff(world: ObjectWorld, entry: TileRestore): RestoreDiff {
  const grid = world.grid
  const index = entry.index
  if (index < 0 || index >= grid.tileCount) {
    return {
      inBounds: false,
      wall: false,
      floor: false,
      wallWanted: NO_MATERIAL,
      floorWanted: NO_MATERIAL,
    }
  }

  const wallWanted =
    entry.wall === null ? NO_MATERIAL : (world.materials.tryIndexOf(entry.wall) ?? NO_MATERIAL)
  const floorWanted =
    entry.floor === null ? NO_MATERIAL : (world.materials.tryIndexOf(entry.floor) ?? NO_MATERIAL)

  return {
    inBounds: true,
    wall:
      grid.getAt('wallMaterial', index) !== wallWanted ||
      (world.doors.get(index)?.type ?? null) !== entry.door,
    floor: grid.getAt('floorMaterial', index) !== floorWanted,
    wallWanted,
    floorWanted,
  }
}

/**
 * What putting one tile back would pay, without putting it back.
 *
 * Both directions are priced, which is what stops undo becoming a money pump:
 * clearing what stands there credits its salvage value, and putting back what
 * the snapshot recorded debits the same. Undoing a demolition therefore costs
 * the salvage the demolition paid out, and undoing a build refunds the salvage
 * of what got built. May be negative when the restore rebuilds more than it
 * removes.
 *
 * Split out from `restoreTile` so the UI can show a refund before the player
 * commits to it and both numbers come from one formula.
 */
export function tileRestoreRefund(world: ObjectWorld, data: GameData, entry: TileRestore): number {
  const diff = restoreDiff(world, entry)
  if (!diff.inBounds) return 0

  const grid = world.grid
  const index = entry.index
  let refund = 0

  const pending = world.sites.get(index)
  if (pending !== undefined) refund += siteCancellationRefund(data, pending)

  if (diff.wall) {
    const wallNow = grid.getAt('wallMaterial', index)
    const standing =
      materialCost(data, wallNow === NO_MATERIAL ? null : world.materials.idAt(wallNow)) +
      doorCost(data, world.doors.get(index)?.type ?? null)
    refund += salvage(data, standing)
    refund -= salvage(data, materialCost(data, entry.wall) + doorCost(data, entry.door))
  }

  if (diff.floor) {
    const floorNow = grid.getAt('floorMaterial', index)
    const standing = materialCost(
      data,
      floorNow === NO_MATERIAL ? null : world.materials.idAt(floorNow),
    )
    refund += salvage(data, standing)
    refund -= salvage(data, materialCost(data, entry.floor))
  }

  return refund
}

/** Puts one tile back the way the snapshot found it, and settles the money. */
function restoreTile(deps: BuildDeps, entry: TileRestore, changedDesignations: number[]): number {
  const { world, data } = deps
  const grid = world.grid
  const index = entry.index
  const diff = restoreDiff(world, entry)
  if (!diff.inBounds) return 0

  const refund = tileRestoreRefund(world, data, entry)

  // Work that was ordered but never finished simply un-orders itself. Anything
  // already delivered to the site is lost with it, exactly as it is when a
  // player draws over their own order (see `construction.cancelSite`).
  const pending = world.sites.remove(index)
  if (pending !== undefined) {
    deps.events.emit({
      tick: deps.tick,
      kind: 'blueprint.siteCancelled',
      causeIds: [pending.id],
      data: { tileIndex: index, job: pending.job.kind },
    })
  }

  if (diff.wall) {
    grid.setAt('wallMaterial', index, diff.wallWanted)
    world.doors.remove(index)
    if (entry.door !== null) world.doors.place(index, entry.door, entry.doorLocked)
  }

  if (diff.floor) grid.setAt('floorMaterial', index, diff.floorWanted)

  grid.setAt('outdoors', index, entry.outdoors ? 1 : 0)

  if (diff.wall || diff.floor) writeStructure(deps, index)

  const designationNow = world.rooms.designationIdAt(index) ?? null
  if (designationNow !== entry.designation) {
    world.rooms.setDesignation(index, entry.designation ?? undefined)
    changedDesignations.push(index)
    grid.markDirtyAt(index)
  }

  return refund
}

/** The object standing on a tile, if that tile is its anchor. */
function anchoredObject(world: ObjectWorld, tile: Tile): number | undefined {
  if (!world.grid.inBounds(tile.x, tile.y)) return undefined
  const index = world.grid.idx(tile.x, tile.y)
  const entity = world.objects.at(index)
  return entity !== undefined && entity.tileIndex === index ? entity.id : undefined
}

function runAction(
  deps: BuildDeps,
  action: BuildAction,
  changedDesignations: number[],
): ActionOutcome {
  const { world, data } = deps

  switch (action.kind) {
    case 'placeFoundation':
      placeFoundation(deps, action.rect, action.material)
      return NOTHING
    case 'placeWall':
      placeWall(deps, action.line, action.material)
      return NOTHING
    case 'removeWall':
      removeWall(deps, action.line)
      return NOTHING
    case 'placeDoor':
      placeDoor(deps, action.tile, action.doorType)
      return NOTHING
    case 'paintFloor':
      paintFloor(deps, action.rect, action.material)
      return NOTHING
    case 'demolish':
      demolish(deps, action.rect)
      return NOTHING

    case 'designateRoom':
      designateRoom(deps, action.rect, action.roomDefId)
      return NOTHING
    case 'undesignateRoom':
      undesignateRoom(deps, action.rect)
      return NOTHING

    case 'placeObject': {
      const def: ObjectDef | undefined = data.objects.find(action.objectDefId)
      const entity = placeObject(deps, action.tile, action.objectDefId, action.rotation)
      if (entity === undefined) return NOTHING
      return { objects: 1, cost: def?.cost ?? 0, refund: 0 }
    }

    case 'removeObject': {
      // T1.4's removal, which salvages nothing. A player scrapping furniture is
      // not the same act as taking back an order they just placed, which is
      // what `removeObjectAt` below is for.
      removeObject(deps, action.entityId)
      return NOTHING
    }

    case 'removeObjectAt': {
      const entityId = anchoredObject(world, action.tile)
      if (entityId === undefined) return NOTHING
      const entity = world.objects.get(entityId)
      const def = entity === undefined ? undefined : data.objects.find(entity.object.defId)
      if (!removeObject(deps, entityId)) return NOTHING
      // Undo is "that never happened", so the purchase comes back in full.
      // Objects are bought and delivered rather than built, so unlike a wall
      // there is no part-finished work to write off.
      return { objects: 0, cost: 0, refund: def?.cost ?? 0 }
    }

    case 'restore': {
      let refund = 0
      for (const entry of action.tiles) refund += restoreTile(deps, entry, changedDesignations)
      return { objects: 0, cost: 0, refund }
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Running a list                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Applies a list of actions to a world and reports the bill.
 *
 * The whole list is applied against the world as it stands at the start, which
 * is precisely how the command queue would apply the same list within one
 * tick: construction queues sites and nothing completes mid-batch. That is
 * what lets the projection's price be the price the worker charges.
 *
 * @param observe called with each action's index before it runs, so a caller
 *   can attribute the `CausalEvent`s that follow to the action that caused them.
 */
export function applyBuildActions(
  deps: BuildDeps,
  actions: readonly BuildAction[],
  observe?: (index: number) => void,
): BuildRun {
  const world = deps.world
  const firstNewSite = world.sites.nextId

  let objects = 0
  let cost = 0
  let refund = 0
  const changedDesignations: number[] = []

  actions.forEach((action, index) => {
    observe?.(index)
    const outcome = runAction(deps, action, changedDesignations)
    objects += outcome.objects
    cost += outcome.cost
    refund += outcome.refund
  })

  // Sites the run created, and only those: a site that was already pending has
  // been paid for, and a site this run replaced is no longer owed.
  let tiles = 0
  for (const site of world.sites.all()) {
    if (site.id < firstNewSite) continue
    tiles += 1
    cost += site.cost
  }

  // `restore` writes designations behind the registry's back, and structural
  // changes queue themselves as stale, so one pass here settles both.
  if (changedDesignations.length > 0 || world.rooms.staleCount > 0) {
    detectRooms(deps, changedDesignations)
  }

  return { tiles, objects, cost, refund }
}

/* -------------------------------------------------------------------------- */
/* Staging                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * One drawn gesture. A drag-rectangle is one stroke, a tapped object is one
 * stroke, and a stroke is the unit a two-finger tap takes back (PRD 6.3).
 */
export interface BlueprintStroke {
  readonly id: number
  readonly action: BuildAction
}

/**
 * The staged build, on the main thread.
 *
 * Deliberately not a `World`, not a `System` and not hashed. It holds drawn
 * intent and nothing else, so undoing a stroke is an array pop and discarding
 * the lot is one assignment — which is what "zero cost and zero commitment"
 * in PRD 3.2 has to mean in practice.
 */
export class Blueprint {
  #strokes: BlueprintStroke[] = []
  #nextId = 1

  get size(): number {
    return this.#strokes.length
  }

  get empty(): boolean {
    return this.#strokes.length === 0
  }

  /** Strokes in the order they were drawn. */
  strokes(): readonly BlueprintStroke[] {
    return this.#strokes.slice()
  }

  actions(): readonly BuildAction[] {
    return this.#strokes.map((stroke) => stroke.action)
  }

  add(action: BuildAction): BlueprintStroke {
    const stroke: BlueprintStroke = { id: this.#nextId, action }
    this.#nextId += 1
    this.#strokes.push(stroke)
    return stroke
  }

  /** Takes back the last stroke. Local and instant: nothing has been sent. */
  undoStroke(): BlueprintStroke | undefined {
    return this.#strokes.pop()
  }

  /** Removes one stroke by id, whichever position it is in. */
  remove(strokeId: number): BlueprintStroke | undefined {
    const at = this.#strokes.findIndex((stroke) => stroke.id === strokeId)
    if (at < 0) return undefined
    const [removed] = this.#strokes.splice(at, 1)
    return removed
  }

  clear(): void {
    this.#strokes = []
  }

  /** The single atomic command a Commit sends (PRD 3.2). */
  commitCommand(issuedAtTick: number): Command {
    return commitCommand(this.actions(), issuedAtTick)
  }
}

/* -------------------------------------------------------------------------- */
/* Projection                                                                  */
/* -------------------------------------------------------------------------- */

/** A detached copy of a grid, sharing no buffers with the original. */
function copyGrid(source: TileGrid): TileGrid {
  const b = source.buffers()
  return TileGrid.fromBuffers(source.size, {
    floorMaterial: b.floorMaterial.slice(0),
    wallMaterial: b.wallMaterial.slice(0),
    roomId: b.roomId.slice(0),
    sectorId: b.sectorId.slice(0),
    objectId: b.objectId.slice(0),
    passability: b.passability.slice(0),
    dirt: b.dirt.slice(0),
    temperature: b.temperature.slice(0),
    powerGridId: b.powerGridId.slice(0),
    waterGridId: b.waterGridId.slice(0),
    outdoors: b.outdoors.slice(0),
    owned: b.owned.slice(0),
  })
}

/** Discards everything. The projection's own events are not the player's. */
class CountingSink implements EventSink {
  /** Rejections raised while `action` names a staged action. */
  readonly rejections: { action: number; kind: string; reason: string }[] = []

  /** The staged action currently running, or -1 while replaying the world. */
  action = -1

  emit(event: SimulationEvent): void {
    if (this.action < 0 || !event.kind.endsWith('.rejected')) return
    const data = event.data
    if (data === null || typeof data !== 'object' || isJsonArray(data)) return
    const reason = data['reason']
    this.rejections.push({
      action: this.action,
      kind: event.kind,
      reason: typeof reason === 'string' ? reason : 'unknown',
    })
  }
}

export interface BlueprintProjection {
  /** The forecast world. Detached: nothing here reaches the simulation. */
  readonly world: ObjectWorld
  readonly run: BuildRun
  /** Tiles the staged actions aimed at, for scoping the report. */
  readonly touched: ReadonlySet<number>
  readonly rejections: readonly { action: number; kind: string; reason: string }[]
}

/**
 * Builds the world the blueprint would produce, without touching the real one.
 *
 * The replay order is the one thing to understand here, because each step
 * depends on the last:
 *
 *   1. Copy the grid, then blank `roomId` and `objectId`. Both are indices
 *      into registries this projection is about to rebuild from scratch, and a
 *      stale id would let two projected rooms claim the same number.
 *   2. Copy the doors and the designations, which are authored state the grid
 *      does not carry.
 *   3. **Finish the work already queued.** The player is asking about the
 *      settled prison, not the scaffolding.
 *   4. Apply the staged actions and settle those too.
 *   5. Detect rooms, then re-place the existing objects, then apply the staged
 *      object actions. Rooms first because an object with `requiresRoom` needs
 *      one to stand in; objects last because every placement re-grades the
 *      room it lands in.
 *
 * An existing object whose surface the blueprint takes away simply fails to
 * re-place, and its room reports the missing requirement. That is the right
 * answer and it costs nothing to get: demolishing the wall a shower hangs on
 * really does leave the washroom short a shower.
 */
export function projectBlueprint(
  source: ObjectWorld,
  data: GameData,
  actions: readonly BuildAction[],
  tick = 0,
): BlueprintProjection {
  const size = source.grid.size
  const grid = copyGrid(source.grid)
  grid.fill('roomId', NO_ROOM)
  grid.fill('objectId', NO_OBJECT)

  const events = new CountingSink()
  const world = new ObjectWorld(
    grid,
    // Immutable and index-order sensitive: the copied grid holds indices into
    // exactly this table, so sharing it is both correct and free.
    source.materials,
    new RoomRegistry(size, data.rooms.ids()),
    new ObjectRegistry(),
    data,
  )
  const deps: BuildDeps = { world, data, events, tick }

  for (const door of source.doors.entries()) {
    world.doors.place(door.tileIndex, door.type, door.locked)
  }

  const tiles = tileCount(size)
  for (let index = 0; index < tiles; index += 1) {
    if (source.rooms.designationAt(index) === NO_DESIGNATION) continue
    world.rooms.setDesignation(index, source.rooms.designationIdAt(index))
  }

  for (const site of source.sites.all()) {
    applyJob(deps, site.tileIndex, site.job)
  }

  const touched = new Set<number>()
  for (const action of actions) {
    for (const index of actionTiles(source, data, action)) touched.add(index)
  }

  // Structural and designation actions first, so the rooms the objects need
  // exist before the objects arrive.
  const structural = actions.filter((action) => !isObjectAction(action))
  const structuralRun = applyBuildActions(deps, structural, (index) => {
    events.action = indexOfAction(actions, structural, index)
  })
  events.action = -1

  for (const site of world.sites.all()) {
    applyJob(deps, site.tileIndex, site.job)
  }
  world.sites.clear()
  // Completing the sites moved walls, so the rooms have to be read again.
  detectRooms(deps)

  for (const entity of source.objects.all()) {
    const { defId, rotation } = entity.object
    placeObject(deps, { x: entity.tx, y: entity.ty }, defId, rotation)
  }

  const objectActions = actions.filter(isObjectAction)
  const objectRun = applyBuildActions(deps, objectActions, (index) => {
    events.action = indexOfAction(actions, objectActions, index)
  })
  events.action = -1

  return {
    world,
    run: {
      tiles: structuralRun.tiles + objectRun.tiles,
      objects: structuralRun.objects + objectRun.objects,
      cost: structuralRun.cost + objectRun.cost,
      refund: structuralRun.refund + objectRun.refund,
    },
    touched,
    rejections: events.rejections,
  }
}

function isObjectAction(action: BuildAction): boolean {
  return (
    action.kind === 'placeObject' ||
    action.kind === 'removeObject' ||
    action.kind === 'removeObjectAt'
  )
}

/** Maps a position in a filtered pass back to its position in the blueprint. */
function indexOfAction(
  all: readonly BuildAction[],
  subset: readonly BuildAction[],
  index: number,
): number {
  const action = subset[index]
  return action === undefined ? -1 : all.indexOf(action)
}

/* -------------------------------------------------------------------------- */
/* The report                                                                  */
/* -------------------------------------------------------------------------- */

export const BLUEPRINT_ISSUE_KINDS = ['requirement', 'rejected'] as const

export type BlueprintIssueKind = (typeof BLUEPRINT_ISSUE_KINDS)[number]

/**
 * One line of the validity list (PRD 6.3).
 *
 * Grouped, because "3 cells have no toilet" is one thing to fix and three
 * identical rows are three things to read. `focus` carries one tile per
 * affected room so that tapping the row can walk the camera through them.
 *
 * Names as well as ids, because the display name is the data layer's and the
 * bar should not have to hold a `GameData` to render a string.
 */
export interface BlueprintIssue {
  readonly kind: BlueprintIssueKind
  /** Room definition id, or the build action's kind for a rejection. */
  readonly source: string
  readonly sourceName: string
  /** The requirement's subject, or the rejection's reason. */
  readonly subject: string
  readonly subjectName: string
  /** Rooms, or actions, sharing this problem. */
  readonly count: number
  /** Somewhere to pan to, one entry per affected room or action. */
  readonly focus: readonly Tile[]
}

export interface BlueprintReport {
  /** What Commit will deduct. */
  readonly cost: number
  /** Construction sites the commit would queue. */
  readonly tiles: number
  readonly objects: number
  readonly issues: readonly BlueprintIssue[]
  /**
   * No issues at all. Advisory: PRD 6.3 lets the player commit a blueprint
   * with known problems, and half-finished wings are a normal way to build.
   */
  readonly valid: boolean
}

interface IssueGroup {
  readonly kind: BlueprintIssueKind
  readonly source: string
  readonly sourceName: string
  readonly subject: string
  readonly subjectName: string
  readonly focus: Tile[]
}

/** The middle of a room's bounding box: the best single place to point a camera. */
function centreOf(room: Room): Tile {
  return {
    x: room.bounds.x + Math.floor(room.bounds.width / 2),
    y: room.bounds.y + Math.floor(room.bounds.height / 2),
  }
}

/** A requirement's subject as the player knows it, where the data layer names it. */
function subjectName(data: GameData, requirement: RoomRequirement): string {
  if (requirement.kind === 'object') {
    return data.objects.find(requirement.subject)?.name ?? requirement.subject
  }
  return requirement.subject
}

/**
 * Prices and grades a staged blueprint.
 *
 * Pure with respect to `source`: everything happens inside `projectBlueprint`'s
 * detached world, so calling this on every stroke is safe and calling it never
 * changes what the simulation would do.
 *
 * Requirement failures are reported only for rooms the blueprint actually
 * touches. A prison always has something wrong with it somewhere, and a bar
 * that listed all of it would be a bar nobody reads.
 */
export function validateBlueprint(
  source: ObjectWorld,
  data: GameData,
  actions: readonly BuildAction[],
  tick = 0,
): BlueprintReport {
  const projection = projectBlueprint(source, data, actions, tick)
  const groups = new Map<string, IssueGroup>()

  const record = (key: string, group: Omit<IssueGroup, 'focus'>, focus: Tile): void => {
    const existing = groups.get(key)
    if (existing === undefined) {
      groups.set(key, { ...group, focus: [focus] })
      return
    }
    existing.focus.push(focus)
  }

  for (const room of projection.world.rooms.all()) {
    if (!room.tiles.some((tile) => projection.touched.has(tile))) continue
    const status = projection.world.rooms.statusOf(room.id)
    if (status === undefined) continue

    const roomName = data.rooms.find(room.defId)?.name ?? room.defId
    for (const requirement of failedRequirements(status)) {
      record(
        `requirement|${room.defId}|${requirement.subject}`,
        {
          kind: 'requirement',
          source: room.defId,
          sourceName: roomName,
          subject: requirement.subject,
          subjectName: subjectName(data, requirement),
        },
        centreOf(room),
      )
    }
  }

  for (const rejection of projection.rejections) {
    const action = actions[rejection.action]
    if (action === undefined) continue
    const tiles = actionTiles(source, data, action)
    const first = tiles[0]
    const focus = first === undefined ? { x: 0, y: 0 } : source.grid.xy(first)
    record(
      `rejected|${action.kind}|${rejection.reason}`,
      {
        kind: 'rejected',
        source: action.kind,
        sourceName: action.kind,
        subject: rejection.reason,
        subjectName: rejection.reason,
      },
      focus,
    )
  }

  const issues = [...groups.values()]
    .map((group): BlueprintIssue => ({
      kind: group.kind,
      source: group.source,
      sourceName: group.sourceName,
      subject: group.subject,
      subjectName: group.subjectName,
      count: group.focus.length,
      focus: group.focus,
    }))
    // Fixed order, so a report redrawn after an unrelated stroke does not
    // reshuffle the rows under the player's finger.
    .sort(
      (a, b) =>
        a.kind.localeCompare(b.kind) ||
        a.source.localeCompare(b.source) ||
        a.subject.localeCompare(b.subject),
    )

  return {
    cost: projection.run.cost,
    tiles: projection.run.tiles,
    objects: projection.run.objects,
    issues,
    valid: issues.length === 0,
  }
}
