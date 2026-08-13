/**
 * Sector paint / configure commands (T4.1).
 *
 * Sectors are player actions, so they arrive as commands rather than as a
 * tick system. Every mutation refreshes derived passability, dirties the
 * region graph, and rebuilds door-edge access masks so pathfinding sees the
 * new permissions on the same tick — a post assignment that runs later in
 * the frame must not walk a minimum-security inmate through a sector the
 * player just locked to maximum.
 */

import { isJsonArray } from '../core/commands'
import type { Command, JsonValue } from '../core/commands'
import type { CommandHandler, SystemContext } from '../core/simulation'
import type { GameData } from '../data/loader'
import { isInmateWorld } from '../systems/intakeSystem'
import type { InmateWorld } from '../systems/intakeSystem'
import { refreshPassability } from './construction'
import { NO_ROOM } from './rooms'
import { NO_SECTOR, SECTOR_EVENTS, isSectorAccessMode, type SectorAccessMode } from './sectors'

/* -------------------------------------------------------------------------- */
/* Commands                                                                    */
/* -------------------------------------------------------------------------- */

export const SECTOR_COMMANDS = {
  create: 'sector.create',
  configure: 'sector.configure',
  remove: 'sector.remove',
  paintTiles: 'sector.paintTiles',
  paintRegion: 'sector.paintRegion',
} as const

export function sectorCommandHandlers(data: GameData): Readonly<Record<string, CommandHandler>> {
  return {
    [SECTOR_COMMANDS.create]: (command, context) => {
      handleCreate(command, context, data)
    },
    [SECTOR_COMMANDS.configure]: (command, context) => {
      handleConfigure(command, context, data)
    },
    [SECTOR_COMMANDS.remove]: (command, context) => {
      handleRemove(command, context, data)
    },
    [SECTOR_COMMANDS.paintTiles]: (command, context) => {
      handlePaintTiles(command, context, data)
    },
    [SECTOR_COMMANDS.paintRegion]: (command, context) => {
      handlePaintRegion(command, context, data)
    },
  }
}

/* -------------------------------------------------------------------------- */
/* Handlers                                                                    */
/* -------------------------------------------------------------------------- */

function handleCreate(command: Command, context: SystemContext, data: GameData): void {
  if (!isInmateWorld(context.world)) return reject(context, command, 'wrong-world')
  const name = readString(command.payload, 'name')
  if (name === undefined) return reject(context, command, 'malformed-payload')

  const accessRaw = readString(command.payload, 'access')
  let access: SectorAccessMode | undefined
  if (accessRaw !== undefined) {
    if (!isSectorAccessMode(accessRaw)) return reject(context, command, 'unknown-access')
    access = accessRaw
  }

  const colour = readString(command.payload, 'colour')
  const categories = readStringArray(command.payload, 'categories')
  if (categories === undefined && hasKey(command.payload, 'categories')) {
    return reject(context, command, 'malformed-categories')
  }
  if (categories !== undefined) {
    for (const category of categories) {
      if (!data.securityCategories.has(category)) {
        return reject(context, command, 'unknown-category')
      }
    }
  }

  const sector = context.world.sectors.create(data, {
    name,
    ...(colour === undefined ? {} : { colour }),
    ...(access === undefined ? {} : { access }),
    ...(categories === undefined ? {} : { categories }),
  })
  if (sector === undefined) return reject(context, command, 'id-exhausted')

  context.events.emit({
    tick: context.clock.tick,
    kind: SECTOR_EVENTS.created,
    causeIds: [],
    data: {
      sectorId: sector.id,
      name: sector.name,
      access: sector.access,
      categories: [...sector.categories],
    },
  })
}

function handleConfigure(command: Command, context: SystemContext, data: GameData): void {
  if (!isInmateWorld(context.world)) return reject(context, command, 'wrong-world')
  const sectorId = readInt(command.payload, 'sectorId')
  if (sectorId === undefined || sectorId === NO_SECTOR) {
    return reject(context, command, 'malformed-payload')
  }
  if (context.world.sectors.get(sectorId) === undefined) {
    return reject(context, command, 'unknown-sector')
  }

  const name = readString(command.payload, 'name')
  const colour = readString(command.payload, 'colour')

  const accessRaw = readString(command.payload, 'access')
  let access: SectorAccessMode | undefined
  if (accessRaw !== undefined) {
    if (!isSectorAccessMode(accessRaw)) return reject(context, command, 'unknown-access')
    access = accessRaw
  }

  let categories: readonly string[] | undefined
  if (hasKey(command.payload, 'categories')) {
    const parsed = readStringArray(command.payload, 'categories')
    if (parsed === undefined) return reject(context, command, 'malformed-categories')
    for (const category of parsed) {
      if (!data.securityCategories.has(category)) {
        return reject(context, command, 'unknown-category')
      }
    }
    categories = parsed
  }

  const changed = context.world.sectors.configure(data, sectorId, {
    ...(name === undefined ? {} : { name }),
    ...(colour === undefined ? {} : { colour }),
    ...(access === undefined ? {} : { access }),
    ...(categories === undefined ? {} : { categories }),
  })

  if (changed.length > 0) applySectorDerived(context.world, data, changed)

  const sector = context.world.sectors.get(sectorId)
  context.events.emit({
    tick: context.clock.tick,
    kind: SECTOR_EVENTS.updated,
    causeIds: [],
    data: {
      sectorId,
      access: sector?.access ?? '',
      categories: sector === undefined ? [] : [...sector.categories],
      tilesRefreshed: changed.length,
    },
  })
}

function handleRemove(command: Command, context: SystemContext, data: GameData): void {
  if (!isInmateWorld(context.world)) return reject(context, command, 'wrong-world')
  const sectorId = readInt(command.payload, 'sectorId')
  if (sectorId === undefined || sectorId === NO_SECTOR) {
    return reject(context, command, 'malformed-payload')
  }
  const sector = context.world.sectors.get(sectorId)
  if (sector === undefined) return reject(context, command, 'unknown-sector')

  const cleared = context.world.sectors.remove(data, context.world.grid, sectorId)
  applySectorDerived(context.world, data, cleared)

  context.events.emit({
    tick: context.clock.tick,
    kind: SECTOR_EVENTS.removed,
    causeIds: [],
    data: { sectorId, name: sector.name, tilesCleared: cleared.length },
  })
}

function handlePaintTiles(command: Command, context: SystemContext, data: GameData): void {
  if (!isInmateWorld(context.world)) return reject(context, command, 'wrong-world')
  const sectorId = readInt(command.payload, 'sectorId')
  const tiles = readIntArray(command.payload, 'tiles')
  if (sectorId === undefined || tiles === undefined) {
    return reject(context, command, 'malformed-payload')
  }
  if (sectorId !== NO_SECTOR && context.world.sectors.get(sectorId) === undefined) {
    return reject(context, command, 'unknown-sector')
  }

  const result = context.world.sectors.paintTiles(context.world.grid, tiles, sectorId)
  if (result.changed.length > 0) applySectorDerived(context.world, data, result.changed)

  context.events.emit({
    tick: context.clock.tick,
    kind: SECTOR_EVENTS.painted,
    causeIds: [],
    data: {
      sectorId,
      tilesChanged: result.changed.length,
      displaced: result.displaced,
    },
  })
}

function handlePaintRegion(command: Command, context: SystemContext, data: GameData): void {
  if (!isInmateWorld(context.world)) return reject(context, command, 'wrong-world')
  const sectorId = readInt(command.payload, 'sectorId')
  const tileIndex = readInt(command.payload, 'tileIndex')
  if (sectorId === undefined || tileIndex === undefined) {
    return reject(context, command, 'malformed-payload')
  }
  if (sectorId !== NO_SECTOR && context.world.sectors.get(sectorId) === undefined) {
    return reject(context, command, 'unknown-sector')
  }

  // Region paint needs a current partition; rebuild first if the graph is empty.
  if (context.world.regions.regions().length === 0) {
    context.world.regions.rebuildAll(
      context.world.grid,
      context.world.doors,
      data,
      context.world.sectors,
    )
  }

  const result = context.world.sectors.paintRegionAt(
    context.world.grid,
    context.world.regions,
    tileIndex,
    sectorId,
  )
  if (result.changed.length > 0) applySectorDerived(context.world, data, result.changed)

  context.events.emit({
    tick: context.clock.tick,
    kind: SECTOR_EVENTS.painted,
    causeIds: [],
    data: {
      sectorId,
      tileIndex,
      tilesChanged: result.changed.length,
      displaced: result.displaced,
    },
  })
}

/* -------------------------------------------------------------------------- */
/* Derived state                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Recomputes everything pathfinding and staff routing read from sectors.
 *
 * Passability bits (`STAFF_ONLY` / `SECURE`), region-edge access masks, and
 * the staff-only room set all derive from the same paint — keep them in lock
 * step so a single command cannot leave them disagreeing.
 */
export function applySectorDerived(
  world: InmateWorld,
  data: GameData,
  tiles: readonly number[],
): void {
  for (const tile of tiles) {
    refreshPassability(world, data, tile)
    world.pathingDirtyTiles.add(tile)
  }
  refreshStaffOnlySectorRooms(world)
  world.regions.markDirty(tiles)
  world.regions.rebuildDirty(world.grid, world.doors, data, world.sectors)
  world.flowFields.markDirtyTiles(tiles)
}

/** Rooms whose tiles sit under a `staffOnly` sector. */
export function refreshStaffOnlySectorRooms(world: InmateWorld): void {
  world.staffOnlySectorRoomIds.clear()
  for (const sector of world.sectors.all()) {
    if (sector.access !== 'staffOnly') continue
    for (const tile of world.sectors.tilesOf(sector.id)) {
      const roomId = world.grid.roomId[tile] ?? NO_ROOM
      if (roomId !== NO_ROOM) world.staffOnlySectorRoomIds.add(roomId)
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Payload readers                                                             */
/* -------------------------------------------------------------------------- */

function reject(context: SystemContext, command: Command, reason: string): void {
  context.events.emit({
    tick: context.clock.tick,
    kind: SECTOR_EVENTS.rejected,
    causeIds: [],
    data: { command: command.type, reason },
  })
}

function asObject(payload: JsonValue): Record<string, JsonValue> | undefined {
  if (payload === null || typeof payload !== 'object' || isJsonArray(payload)) return undefined
  return payload
}

function hasKey(payload: JsonValue, key: string): boolean {
  const object = asObject(payload)
  return object !== undefined && object[key] !== undefined
}

function readString(payload: JsonValue, key: string): string | undefined {
  const value = asObject(payload)?.[key]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function readInt(payload: JsonValue, key: string): number | undefined {
  const value = asObject(payload)?.[key]
  if (typeof value !== 'number' || !Number.isInteger(value)) return undefined
  return value
}

function readIntArray(payload: JsonValue, key: string): number[] | undefined {
  const value = asObject(payload)?.[key]
  if (!Array.isArray(value)) return undefined
  const out: number[] = []
  for (const entry of value) {
    if (typeof entry !== 'number' || !Number.isInteger(entry)) return undefined
    out.push(entry)
  }
  return out
}

function readStringArray(payload: JsonValue, key: string): string[] | undefined {
  const value = asObject(payload)?.[key]
  if (!Array.isArray(value)) return undefined
  const out: string[] = []
  for (const entry of value) {
    if (typeof entry !== 'string') return undefined
    out.push(entry)
  }
  return out
}
