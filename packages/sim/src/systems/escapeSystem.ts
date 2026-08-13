/**
 * `EscapeSystem`: tunnels, detection, and escape routes (T4.7, PRD 5.11 / 5.15).
 *
 * Slot 14 in the PRD 4.4 order (EmergencySystem — escapes). Digging runs on the
 * hour during `sleep` / `lockup`. A clever inmate with a digging tool in a cell
 * that has a toilet advances a tunnel by `tilesPerHourBase + variance * rand`
 * tiles; tunnels merge when their dig fronts meet; dogs, cell searches and
 * maintenance sweeps discover and collapse them. Reaching the map edge or an
 * unowned parcel queues every connected digger to escape over subsequent nights.
 *
 * Other routes (riot door breaches, fence climbs, vehicle theft, walking out of
 * a badly zoned prison) are resolved here too. Riot door-breach state is a
 * stub hook for T4.6 — callers mark tiles, and this system consumes them while
 * a riot is active.
 *
 * Escape counts feed the PRD 5.15 failure condition (warning then fail).
 */

import { TICKS_PER_HOUR, ticksToDay } from '../core/clock'
import type { Fnv1aHasher } from '../core/hash'
import type { RngStream } from '../core/rng'
import type { EventSink, System, SystemContext } from '../core/simulation'
import type { GameData } from '../data/loader'
import type { RoutineBlockId } from '../data/schemas'
import type { InmateEntity } from '../entities/inmate'
import type { StaffEntity } from '../entities/staff'
import { hasCapability } from '../entities/staff'
import { xy } from '../world/coords'
import { NO_MATERIAL } from '../world/materials'
import { NO_ROOM } from '../world/rooms'
import { PASSABILITY } from '../world/tileGrid'

import { failureArmed, isInmateWorld, mutatorEnabled } from './intakeSystem'
import type { InmateWorld } from './intakeSystem'

/* -------------------------------------------------------------------------- */
/* Constants                                                                   */
/* -------------------------------------------------------------------------- */

export const ESCAPE_SYSTEM_NAME = 'escape'
/** Digging and dog passes are hourly; escape accounting rolls at midnight. */
export const ESCAPE_SYSTEM_PERIOD = TICKS_PER_HOUR

export const NO_TUNNEL = 0

export const ESCAPE_EVENTS = {
  digProgress: 'escape.digProgress',
  tunnelStarted: 'escape.tunnelStarted',
  tunnelExtended: 'escape.tunnelExtended',
  tunnelMerged: 'escape.tunnelMerged',
  tunnelReachedEdge: 'escape.tunnelReachedEdge',
  tunnelDiscovered: 'escape.tunnelDiscovered',
  inmateEscaped: 'escape.inmateEscaped',
  failureWarning: 'escape.failureWarning',
  failure: 'escape.failure',
  rejected: 'escape.rejected',
} as const

export type EscapeRoute = 'tunnel' | 'riotDoor' | 'fenceClimb' | 'vehicleTheft' | 'walkOut'

/* -------------------------------------------------------------------------- */
/* Tunnel entity                                                               */
/* -------------------------------------------------------------------------- */

/**
 * One dig route. `tiles[0]` is the entrance (`originTile`); the last entry is
 * the dig head. Fractional progress toward the next tile lives on `progress`.
 */
export interface Tunnel {
  readonly id: number
  originTile: number
  tiles: number[]
  diggerIds: number[]
  discovered: boolean
  /** Fractional tiles accrued toward the next dug tile. */
  progress: number
  /** True once the head has reached the map edge or an unowned parcel. */
  reachedExit: boolean
  /** Network id shared after merges; defaults to `id`. */
  networkId: number
}

export interface PendingNetworkEscape {
  readonly networkId: number
  /** Every digger that was connected when the exit was reached. */
  inmateIds: number[]
  /** Diggers still waiting to leave on a later night. */
  remainingIds: number[]
}

/* -------------------------------------------------------------------------- */
/* Escape state                                                                */
/* -------------------------------------------------------------------------- */

/**
 * World-owned escape / tunnel state.
 *
 * Lives on `InmateWorld` so detection commands and the hourly system share one
 * source of truth, and so the determinism hash covers every dig.
 */
export class EscapeState {
  readonly #tunnels = new Map<number, Tunnel>()
  /** Tile index → tunnel id for every dug tile (including entrances). */
  readonly #tileIndex = new Map<number, number>()
  #nextTunnelId = 1

  /**
   * Door tiles breached during a riot (T4.6 stub). Cleared when the riot ends
   * or when an inmate escapes through them.
   */
  readonly breachedDoorTiles = new Set<number>()

  /** Networks that have reached an exit and still have diggers underground. */
  readonly pendingEscapes: PendingNetworkEscape[] = []

  /** Escapes recorded on the current in-game day. */
  escapesToday = 0
  /** Escapes recorded on the previous in-game day. */
  escapesYesterday = 0
  /** Day number last applied to the midnight roll (1-based). */
  accountedDay = 1
  /** True after the warning threshold fired for `escapesYesterday`. */
  warningActive = false
  /** Prison has failed on the escape condition. */
  failed = false
  /** Total escapes over the whole game (accounting / Trace). */
  totalEscapes = 0

  get tunnelCount(): number {
    return this.#tunnels.size
  }

  get nextTunnelId(): number {
    return this.#nextTunnelId
  }

  get(id: number): Tunnel | undefined {
    return this.#tunnels.get(id)
  }

  all(): Tunnel[] {
    const tunnels = [...this.#tunnels.values()]
    tunnels.sort((a, b) => a.id - b.id)
    return tunnels
  }

  /** Undiscovered tunnels only. */
  active(): Tunnel[] {
    return this.all().filter((tunnel) => !tunnel.discovered)
  }

  tunnelAt(tileIndex: number): Tunnel | undefined {
    const id = this.#tileIndex.get(tileIndex)
    return id === undefined ? undefined : this.#tunnels.get(id)
  }

  allocateId(): number {
    const id = this.#nextTunnelId
    this.#nextTunnelId += 1
    return id
  }

  add(tunnel: Tunnel): void {
    this.#tunnels.set(tunnel.id, tunnel)
    for (const tile of tunnel.tiles) {
      this.#tileIndex.set(tile, tunnel.id)
    }
  }

  remove(id: number): Tunnel | undefined {
    const tunnel = this.#tunnels.get(id)
    if (tunnel === undefined) return undefined
    for (const tile of tunnel.tiles) {
      if (this.#tileIndex.get(tile) === id) this.#tileIndex.delete(tile)
    }
    this.#tunnels.delete(id)
    return tunnel
  }

  /** Rebinds every tile in `tunnel` to its current id (after merge / extend). */
  reindex(tunnel: Tunnel): void {
    for (const tile of tunnel.tiles) {
      this.#tileIndex.set(tile, tunnel.id)
    }
  }

  markDoorBreached(tileIndex: number): void {
    this.breachedDoorTiles.add(tileIndex)
  }

  clearBreachedDoors(): void {
    this.breachedDoorTiles.clear()
  }

  hashInto(hasher: Fnv1aHasher): void {
    hasher.writeUint32(this.#nextTunnelId)
    hasher.writeUint32(this.#tunnels.size)
    for (const tunnel of this.all()) {
      hasher.writeUint32(tunnel.id)
      hasher.writeUint32(tunnel.originTile)
      hasher.writeUint32(tunnel.tiles.length)
      for (const tile of tunnel.tiles) hasher.writeUint32(tile)
      hasher.writeUint32(tunnel.diggerIds.length)
      for (const diggerId of tunnel.diggerIds) hasher.writeUint32(diggerId)
      hasher.writeUint32(tunnel.discovered ? 1 : 0)
      hasher.writeFloat64(tunnel.progress)
      hasher.writeUint32(tunnel.reachedExit ? 1 : 0)
      hasher.writeUint32(tunnel.networkId)
    }
    hasher.writeUint32(this.breachedDoorTiles.size)
    for (const tile of [...this.breachedDoorTiles].sort((a, b) => a - b)) {
      hasher.writeUint32(tile)
    }
    hasher.writeUint32(this.pendingEscapes.length)
    for (const pending of this.pendingEscapes) {
      hasher.writeUint32(pending.networkId)
      hasher.writeUint32(pending.remainingIds.length)
      for (const id of pending.remainingIds) hasher.writeUint32(id)
    }
    hasher.writeUint32(this.escapesToday)
    hasher.writeUint32(this.escapesYesterday)
    hasher.writeUint32(this.accountedDay)
    hasher.writeUint32(this.warningActive ? 1 : 0)
    hasher.writeUint32(this.failed ? 1 : 0)
    hasher.writeUint32(this.totalEscapes)
  }

  serialise(): {
    readonly nextTunnelId: number
    readonly tunnels: readonly Tunnel[]
    readonly breachedDoorTiles: readonly number[]
    readonly pendingEscapes: readonly PendingNetworkEscape[]
    readonly escapesToday: number
    readonly escapesYesterday: number
    readonly accountedDay: number
    readonly warningActive: boolean
    readonly failed: boolean
    readonly totalEscapes: number
  } {
    return {
      nextTunnelId: this.#nextTunnelId,
      tunnels: this.all().map((tunnel) => ({
        id: tunnel.id,
        originTile: tunnel.originTile,
        tiles: [...tunnel.tiles],
        diggerIds: [...tunnel.diggerIds],
        discovered: tunnel.discovered,
        progress: tunnel.progress,
        reachedExit: tunnel.reachedExit,
        networkId: tunnel.networkId,
      })),
      breachedDoorTiles: [...this.breachedDoorTiles].sort((a, b) => a - b),
      pendingEscapes: this.pendingEscapes.map((pending) => ({
        networkId: pending.networkId,
        inmateIds: [...pending.inmateIds],
        remainingIds: [...pending.remainingIds],
      })),
      escapesToday: this.escapesToday,
      escapesYesterday: this.escapesYesterday,
      accountedDay: this.accountedDay,
      warningActive: this.warningActive,
      failed: this.failed,
      totalEscapes: this.totalEscapes,
    }
  }

  restore(snapshot: {
    readonly nextTunnelId: number
    readonly tunnels: readonly {
      readonly id: number
      readonly originTile: number
      readonly tiles: readonly number[]
      readonly diggerIds: readonly number[]
      readonly discovered: boolean
      readonly progress: number
      readonly reachedExit: boolean
      readonly networkId: number
    }[]
    readonly breachedDoorTiles: readonly number[]
    readonly pendingEscapes: readonly {
      readonly networkId: number
      readonly inmateIds: readonly number[]
      readonly remainingIds: readonly number[]
    }[]
    readonly escapesToday: number
    readonly escapesYesterday: number
    readonly accountedDay: number
    readonly warningActive: boolean
    readonly failed: boolean
    readonly totalEscapes: number
  }): void {
    this.#tunnels.clear()
    this.#tileIndex.clear()
    this.#nextTunnelId = Math.max(1, snapshot.nextTunnelId)
    for (const entry of snapshot.tunnels) {
      const tunnel: Tunnel = {
        id: entry.id,
        originTile: entry.originTile,
        tiles: [...entry.tiles],
        diggerIds: [...entry.diggerIds],
        discovered: entry.discovered,
        progress: entry.progress,
        reachedExit: entry.reachedExit,
        networkId: entry.networkId,
      }
      this.add(tunnel)
    }
    this.breachedDoorTiles.clear()
    for (const tile of snapshot.breachedDoorTiles) this.breachedDoorTiles.add(tile)
    this.pendingEscapes.length = 0
    for (const pending of snapshot.pendingEscapes) {
      this.pendingEscapes.push({
        networkId: pending.networkId,
        inmateIds: [...pending.inmateIds],
        remainingIds: [...pending.remainingIds],
      })
    }
    this.escapesToday = snapshot.escapesToday
    this.escapesYesterday = snapshot.escapesYesterday
    this.accountedDay = snapshot.accountedDay
    this.warningActive = snapshot.warningActive
    this.failed = snapshot.failed
    this.totalEscapes = snapshot.totalEscapes
  }
}

export function createEscapeState(): EscapeState {
  return new EscapeState()
}

/* -------------------------------------------------------------------------- */
/* Dig maths                                                                   */
/* -------------------------------------------------------------------------- */

/** PRD 5.11: `0.4 + 0.1 * rand()` tiles per hour. Always consumes one draw. */
export function digProgressThisHour(rng: RngStream, data: GameData): number {
  const { tilesPerHourBase, tilesPerHourVariance } = data.balance.tunnels
  return tilesPerHourBase + tilesPerHourVariance * rng.next()
}

/* -------------------------------------------------------------------------- */
/* Eligibility                                                                 */
/* -------------------------------------------------------------------------- */

export function inmateHasTrait(entity: InmateEntity, traitId: string): boolean {
  return entity.inmate.traits.includes(traitId)
}

/** First inventory item flagged `canDigTunnel`, or null. */
export function diggingToolInInventory(entity: InmateEntity, data: GameData): string | null {
  for (const itemId of entity.inmate.inventory) {
    const item = data.contraband.find(itemId)
    if (item !== undefined && item.canDigTunnel) return itemId
  }
  return null
}

export function cellHasToilet(world: InmateWorld, cellId: number, data: GameData): boolean {
  if (cellId === NO_ROOM) return false
  const toiletId = data.balance.tunnels.toiletObjectId
  return world.contents().objectCount(cellId, toiletId) > 0
}

export function isDiggingRegime(blockId: RoutineBlockId | null, data: GameData): boolean {
  if (blockId === null) return false
  return data.balance.tunnels.diggingRegimeBlocks.includes(blockId)
}

export function canInmateDig(world: InmateWorld, entity: InmateEntity, data: GameData): boolean {
  // Switched off at map creation (T6.5): nobody digs, existing tunnels stay.
  if (!mutatorEnabled(world, 'tunnels')) return false

  const cfg = data.balance.tunnels
  if (!inmateHasTrait(entity, cfg.cleverTraitId)) return false
  if (diggingToolInInventory(entity, data) === null) return false
  if (!cellHasToilet(world, entity.inmate.cellId, data)) return false
  const runtime = world.routineRuntime.stateOf(entity.id)
  if (!isDiggingRegime(runtime.blockId, data) && !runtime.lockedUp) return false
  return true
}

/* -------------------------------------------------------------------------- */
/* Geometry                                                                    */
/* -------------------------------------------------------------------------- */

export function isMapEdgeTile(tileIndex: number, size: number): boolean {
  const { x, y } = xy(tileIndex, size)
  return x === 0 || y === 0 || x === size - 1 || y === size - 1
}

export function isEscapeExitTile(world: InmateWorld, tileIndex: number): boolean {
  if (isMapEdgeTile(tileIndex, world.grid.size)) return true
  return world.grid.owned[tileIndex] === 0
}

/** Nearest map-edge direction from a tile, as a unit step `(dx, dy)`. */
export function nearestEdgeStep(tileIndex: number, size: number): { dx: number; dy: number } {
  const { x, y } = xy(tileIndex, size)
  const distN = y
  const distS = size - 1 - y
  const distW = x
  const distE = size - 1 - x
  const min = Math.min(distN, distS, distW, distE)
  if (min === distN) return { dx: 0, dy: -1 }
  if (min === distS) return { dx: 0, dy: 1 }
  if (min === distW) return { dx: -1, dy: 0 }
  return { dx: 1, dy: 0 }
}

function stepTile(tileIndex: number, dx: number, dy: number, size: number): number | null {
  const { x, y } = xy(tileIndex, size)
  const nx = x + dx
  const ny = y + dy
  if (nx < 0 || ny < 0 || nx >= size || ny >= size) return null
  return ny * size + nx
}

/** Chebyshev distance in tiles. */
export function tileDistance(a: number, b: number, size: number): number {
  const A = xy(a, size)
  const B = xy(b, size)
  return Math.max(Math.abs(A.x - B.x), Math.abs(A.y - B.y))
}

function toiletTileInCell(world: InmateWorld, cellId: number, data: GameData): number | null {
  const room = world.rooms.get(cellId)
  if (room === undefined) return null
  const toiletId = data.balance.tunnels.toiletObjectId
  for (const entity of world.objects.all()) {
    if (entity.object.defId !== toiletId) continue
    if (entity.object.roomId === cellId) {
      return entity.ty * world.grid.size + entity.tx
    }
  }
  // Fallback: first room tile when the object index is faked in tests.
  const first = room.tiles[0]
  return first === undefined ? null : first
}

/* -------------------------------------------------------------------------- */
/* Tunnel dig / merge                                                          */
/* -------------------------------------------------------------------------- */

function ensureTunnelForDigger(
  world: InmateWorld,
  entity: InmateEntity,
  data: GameData,
  events: EventSink,
  tick: number,
): Tunnel | null {
  const existing = world.escapes.active().find((tunnel) => tunnel.diggerIds.includes(entity.id))
  if (existing !== undefined) return existing

  const origin = toiletTileInCell(world, entity.inmate.cellId, data)
  if (origin === null) return null

  // Another digger may already own this entrance — join their tunnel.
  const atOrigin = world.escapes.tunnelAt(origin)
  if (atOrigin !== undefined && !atOrigin.discovered) {
    if (!atOrigin.diggerIds.includes(entity.id)) {
      atOrigin.diggerIds.push(entity.id)
      atOrigin.diggerIds.sort((a, b) => a - b)
    }
    return atOrigin
  }

  const id = world.escapes.allocateId()
  const tunnel: Tunnel = {
    id,
    originTile: origin,
    tiles: [origin],
    diggerIds: [entity.id],
    discovered: false,
    progress: 0,
    reachedExit: false,
    networkId: id,
  }
  world.escapes.add(tunnel)
  events.emit({
    tick,
    kind: ESCAPE_EVENTS.tunnelStarted,
    subjectId: entity.id,
    causeIds: [entity.id],
    data: {
      tunnelId: id,
      originTile: origin,
      inmateId: entity.id,
      cellId: entity.inmate.cellId,
    },
  })
  return tunnel
}

/**
 * Advances one tunnel by fractional dig progress. Completes whole tiles toward
 * the nearest map edge. Returns the tiles newly dug this call.
 */
export function advanceTunnelDig(
  world: InmateWorld,
  tunnel: Tunnel,
  amount: number,
  events: EventSink,
  tick: number,
): number[] {
  if (tunnel.discovered || tunnel.reachedExit || amount <= 0) return []

  tunnel.progress += amount
  const dug: number[] = []
  const size = world.grid.size

  while (tunnel.progress >= 1 && !tunnel.reachedExit) {
    tunnel.progress -= 1
    const head = tunnel.tiles[tunnel.tiles.length - 1]
    if (head === undefined) break
    const step = nearestEdgeStep(head, size)
    const next = stepTile(head, step.dx, step.dy, size)
    if (next === null) {
      // Already at the edge — the head itself is the exit.
      markTunnelReachedExit(world, tunnel, events, tick)
      break
    }
    if (tunnel.tiles.includes(next)) {
      // Would loop on itself; treat as exit if we are on the edge.
      if (isEscapeExitTile(world, head)) {
        markTunnelReachedExit(world, tunnel, events, tick)
      }
      break
    }

    const other = world.escapes.tunnelAt(next)
    tunnel.tiles.push(next)
    dug.push(next)
    world.escapes.reindex(tunnel)

    events.emit({
      tick,
      kind: ESCAPE_EVENTS.tunnelExtended,
      subjectId: tunnel.diggerIds[0] ?? 0,
      causeIds: [...tunnel.diggerIds],
      data: {
        tunnelId: tunnel.id,
        tile: next,
        length: tunnel.tiles.length,
        diggerIds: [...tunnel.diggerIds],
      },
    })

    if (other !== undefined && other.id !== tunnel.id && !other.discovered) {
      mergeTunnels(world, tunnel, other, events, tick)
    }

    if (isEscapeExitTile(world, next)) {
      markTunnelReachedExit(world, tunnel, events, tick)
      break
    }
  }

  if (dug.length > 0 || amount > 0) {
    events.emit({
      tick,
      kind: ESCAPE_EVENTS.digProgress,
      subjectId: tunnel.diggerIds[0] ?? 0,
      causeIds: [...tunnel.diggerIds],
      data: {
        tunnelId: tunnel.id,
        amount,
        progress: tunnel.progress,
        length: tunnel.tiles.length,
      },
    })
  }

  return dug
}

/**
 * Merges `other` into `keeper`. Diggers, tiles and progress combine; `other`
 * is removed. Shared `networkId` is the lower of the two.
 */
export function mergeTunnels(
  world: InmateWorld,
  keeper: Tunnel,
  other: Tunnel,
  events: EventSink,
  tick: number,
): Tunnel {
  if (keeper.id === other.id) return keeper

  const networkId = Math.min(keeper.networkId, other.networkId)
  keeper.networkId = networkId

  for (const tile of other.tiles) {
    if (!keeper.tiles.includes(tile)) keeper.tiles.push(tile)
  }
  for (const diggerId of other.diggerIds) {
    if (!keeper.diggerIds.includes(diggerId)) keeper.diggerIds.push(diggerId)
  }
  keeper.diggerIds.sort((a, b) => a - b)
  keeper.progress = Math.max(keeper.progress, other.progress)
  if (other.reachedExit) keeper.reachedExit = true

  world.escapes.remove(other.id)
  // Retarget any tunnel that shared other's network id.
  for (const tunnel of world.escapes.all()) {
    if (tunnel.networkId === other.networkId || tunnel.networkId === other.id) {
      tunnel.networkId = networkId
    }
  }
  world.escapes.reindex(keeper)

  events.emit({
    tick,
    kind: ESCAPE_EVENTS.tunnelMerged,
    subjectId: keeper.diggerIds[0] ?? 0,
    causeIds: [...keeper.diggerIds],
    data: {
      keeperId: keeper.id,
      absorbedId: other.id,
      networkId,
      tiles: keeper.tiles.length,
      diggerIds: [...keeper.diggerIds],
    },
  })

  if (keeper.reachedExit) {
    queueNetworkEscape(world, keeper, events, tick)
  }

  return keeper
}

function markTunnelReachedExit(
  world: InmateWorld,
  tunnel: Tunnel,
  events: EventSink,
  tick: number,
): void {
  if (tunnel.reachedExit) return
  tunnel.reachedExit = true
  events.emit({
    tick,
    kind: ESCAPE_EVENTS.tunnelReachedEdge,
    subjectId: tunnel.diggerIds[0] ?? 0,
    causeIds: [...tunnel.diggerIds],
    data: {
      tunnelId: tunnel.id,
      networkId: tunnel.networkId,
      diggerIds: [...tunnel.diggerIds],
      length: tunnel.tiles.length,
    },
  })
  queueNetworkEscape(world, tunnel, events, tick)
}

/** Collects every digger on tunnels that share `networkId`. */
export function networkDiggerIds(world: InmateWorld, networkId: number): number[] {
  const ids = new Set<number>()
  for (const tunnel of world.escapes.active()) {
    if (tunnel.networkId !== networkId && tunnel.id !== networkId) continue
    for (const diggerId of tunnel.diggerIds) ids.add(diggerId)
  }
  // Also include diggers on discovered=false tunnels already marked reachedExit.
  for (const tunnel of world.escapes.all()) {
    if (tunnel.discovered) continue
    if (tunnel.networkId !== networkId && tunnel.id !== networkId) continue
    for (const diggerId of tunnel.diggerIds) ids.add(diggerId)
  }
  return [...ids].sort((a, b) => a - b)
}

export function queueNetworkEscape(
  world: InmateWorld,
  tunnel: Tunnel,
  _events: EventSink,
  _tick: number,
): void {
  const inmateIds = networkDiggerIds(world, tunnel.networkId)
  const existing = world.escapes.pendingEscapes.find((p) => p.networkId === tunnel.networkId)
  if (existing !== undefined) {
    for (const id of inmateIds) {
      if (!existing.inmateIds.includes(id)) existing.inmateIds.push(id)
      if (!existing.remainingIds.includes(id)) existing.remainingIds.push(id)
    }
    existing.inmateIds.sort((a, b) => a - b)
    existing.remainingIds.sort((a, b) => a - b)
    return
  }
  world.escapes.pendingEscapes.push({
    networkId: tunnel.networkId,
    inmateIds: [...inmateIds],
    remainingIds: [...inmateIds],
  })
}

/* -------------------------------------------------------------------------- */
/* Detection                                                                   */
/* -------------------------------------------------------------------------- */

export interface DiscoverTunnelOptions {
  readonly world: InmateWorld
  readonly tunnel: Tunnel
  readonly data: GameData
  readonly events: EventSink
  readonly tick: number
  readonly method: 'dog' | 'cellSearch' | 'maintenanceSweep'
  readonly detectorId?: number
}

/**
 * Collapses a tunnel and punishes every digger (suppression stub until T4.4
 * owns the full punishment matrix).
 */
export function discoverTunnel(options: DiscoverTunnelOptions): void {
  const { world, tunnel, data, events, tick, method } = options
  if (tunnel.discovered) return

  tunnel.discovered = true
  const suppression = data.balance.tunnels.discoverySuppression
  for (const diggerId of tunnel.diggerIds) {
    const inmate = world.inmates.get(diggerId)
    if (inmate === undefined) continue
    inmate.inmate.suppression = Math.min(100, inmate.inmate.suppression + suppression)
    const needState = world.needsRuntime.stateOf(diggerId)
    needState.diggingTunnel = false
  }

  // Drop pending escapes that only referenced this collapsed network's diggers
  // still listed solely on discovered tunnels.
  for (let i = world.escapes.pendingEscapes.length - 1; i >= 0; i -= 1) {
    const pending = world.escapes.pendingEscapes[i]
    if (pending === undefined) continue
    if (pending.networkId !== tunnel.networkId) continue
    const stillActive = world.escapes
      .active()
      .some((t) => t.networkId === tunnel.networkId && t.reachedExit)
    if (!stillActive) {
      world.escapes.pendingEscapes.splice(i, 1)
    }
  }

  events.emit({
    tick,
    kind: ESCAPE_EVENTS.tunnelDiscovered,
    subjectId: options.detectorId ?? tunnel.diggerIds[0] ?? 0,
    causeIds: [...tunnel.diggerIds],
    data: {
      tunnelId: tunnel.id,
      networkId: tunnel.networkId,
      method,
      diggerIds: [...tunnel.diggerIds],
      originTile: tunnel.originTile,
      detectorId: options.detectorId ?? null,
      suppression,
    },
  })
}

/**
 * Dog pass within `dogDetectionTiles` of an entrance. Consumes one RNG draw
 * even when out of range so stream positions stay stable.
 */
export function tryDogDetection(
  world: InmateWorld,
  dog: StaffEntity,
  data: GameData,
  rng: RngStream,
  events: EventSink,
  tick: number,
): boolean {
  const cfg = data.balance.tunnels
  const dogTile = dog.ty * world.grid.size + dog.tx
  let detected = false

  for (const tunnel of world.escapes.active()) {
    const dist = tileDistance(dogTile, tunnel.originTile, world.grid.size)
    const inRange = dist <= cfg.dogDetectionTiles
    // Always consume the chance draw for determinism when in range; out of
    // range skips the draw so distant dogs do not burn the stream.
    if (!inRange) continue
    if (rng.chance(cfg.dogDetectionChance)) {
      discoverTunnel({
        world,
        tunnel,
        data,
        events,
        tick,
        method: 'dog',
        detectorId: dog.id,
      })
      detected = true
    }
  }
  return detected
}

/** Cell search: 100% (data-driven) discovery of tunnels whose entrance is in the cell. */
export function searchCellForTunnels(
  world: InmateWorld,
  cellId: number,
  data: GameData,
  events: EventSink,
  tick: number,
  searcherId = 0,
): Tunnel[] {
  if (cellId === NO_ROOM) return []
  const room = world.rooms.get(cellId)
  if (room === undefined) return []

  const chance = data.balance.tunnels.cellSearchDetectionChance
  const found: Tunnel[] = []
  const tileSet = new Set(room.tiles)

  for (const tunnel of world.escapes.active()) {
    if (!tileSet.has(tunnel.originTile)) continue
    // Cell search is deterministic at chance 1; still gate on the balance number.
    if (chance >= 1 || chance > 0) {
      discoverTunnel({
        world,
        tunnel,
        data,
        events,
        tick,
        method: 'cellSearch',
        detectorId: searcherId,
      })
      found.push(tunnel)
    }
  }
  return found
}

/**
 * Maintenance sweep over an explicit tile set (or the whole map when omitted).
 * Discovers any tunnel whose entrance lies in the swept tiles.
 */
export function maintenanceSweep(
  world: InmateWorld,
  data: GameData,
  events: EventSink,
  tick: number,
  tiles?: readonly number[],
  sweeperId = 0,
  rng?: RngStream,
): Tunnel[] {
  const cfg = data.balance.tunnels
  const tileSet = tiles === undefined ? null : new Set(tiles)
  const found: Tunnel[] = []

  for (const tunnel of world.escapes.active()) {
    if (tileSet !== null && !tileSet.has(tunnel.originTile)) continue
    const hit =
      rng === undefined
        ? cfg.maintenanceSweepDetectionChance >= 1
        : rng.chance(cfg.maintenanceSweepDetectionChance)
    if (!hit && cfg.maintenanceSweepDetectionChance < 1) continue
    if (cfg.maintenanceSweepDetectionChance <= 0) continue
    discoverTunnel({
      world,
      tunnel,
      data,
      events,
      tick,
      method: 'maintenanceSweep',
      detectorId: sweeperId,
    })
    found.push(tunnel)
  }
  return found
}

/* -------------------------------------------------------------------------- */
/* Escape resolution                                                           */
/* -------------------------------------------------------------------------- */

export interface ResolveEscapeOptions {
  readonly world: InmateWorld
  readonly inmateId: number
  readonly data: GameData
  readonly events: EventSink
  readonly tick: number
  readonly route: EscapeRoute
  readonly causeIds?: readonly number[]
  readonly dataExtra?: Record<string, string | number | boolean | null>
}

/** Removes the inmate and records the escape against the failure counters. */
export function resolveInmateEscape(options: ResolveEscapeOptions): boolean {
  const { world, inmateId, events, tick, route } = options
  if (world.escapes.failed) return false

  const entity = world.inmates.get(inmateId)
  if (entity === undefined) return false

  world.inmates.remove(inmateId)
  world.needsRuntime.remove(inmateId)

  world.escapes.escapesToday += 1
  world.escapes.totalEscapes += 1
  world.contracts.progress.recordIncident('escape', tick)

  // Strip from digger lists / pending queues.
  for (const tunnel of world.escapes.all()) {
    tunnel.diggerIds = tunnel.diggerIds.filter((id) => id !== inmateId)
  }
  for (const pending of world.escapes.pendingEscapes) {
    pending.remainingIds = pending.remainingIds.filter((id) => id !== inmateId)
  }
  for (let i = world.escapes.pendingEscapes.length - 1; i >= 0; i -= 1) {
    const pending = world.escapes.pendingEscapes[i]
    if (pending !== undefined && pending.remainingIds.length === 0) {
      world.escapes.pendingEscapes.splice(i, 1)
    }
  }

  events.emit({
    tick,
    kind: ESCAPE_EVENTS.inmateEscaped,
    subjectId: inmateId,
    causeIds: options.causeIds ?? [inmateId],
    data: {
      inmateId,
      route,
      escapesToday: world.escapes.escapesToday,
      totalEscapes: world.escapes.totalEscapes,
      ...(options.dataExtra ?? {}),
    },
  })

  checkEscapeFailure(world, options.data, events, tick)
  return true
}

/**
 * Escapes connected diggers on networks that have reached an exit, up to
 * `escapeInmatesPerNight` per network per night (sleep/lockup hour).
 */
export function resolvePendingNetworkEscapes(
  world: InmateWorld,
  data: GameData,
  events: EventSink,
  tick: number,
): number {
  const perNight = data.balance.tunnels.escapeInmatesPerNight
  let escaped = 0

  for (const pending of [...world.escapes.pendingEscapes]) {
    const batch = pending.remainingIds.slice(0, perNight)
    for (const inmateId of batch) {
      if (
        resolveInmateEscape({
          world,
          inmateId,
          data,
          events,
          tick,
          route: 'tunnel',
          causeIds: [inmateId],
          dataExtra: { networkId: pending.networkId },
        })
      ) {
        escaped += 1
      }
    }
  }
  return escaped
}

/* -------------------------------------------------------------------------- */
/* Other escape routes                                                         */
/* -------------------------------------------------------------------------- */

/**
 * T4.6 stub: mark a door tile as breached so rioting inmates can flee through it.
 */
export function markRiotDoorBreached(world: InmateWorld, tileIndex: number): void {
  world.escapes.markDoorBreached(tileIndex)
  const door = world.doors.get(tileIndex)
  if (door !== undefined) door.locked = false
}

/** During a riot, an inmate on an unlocked or breached door at/near the edge escapes. */
export function tryRiotDoorEscape(
  world: InmateWorld,
  entity: InmateEntity,
  data: GameData,
  events: EventSink,
  tick: number,
): boolean {
  if (!world.riotActive) return false
  const tile = entity.ty * world.grid.size + entity.tx
  const door = world.doors.get(tile)
  const breached = world.escapes.breachedDoorTiles.has(tile)
  if (door === undefined && !breached) return false
  if (door !== undefined && door.locked && !breached) return false
  // Must be near the perimeter: edge tile or adjacent to unowned / outdoors edge.
  if (!isEscapeExitTile(world, tile) && !isNearPerimeter(world, tile)) return false
  return resolveInmateEscape({
    world,
    inmateId: entity.id,
    data,
    events,
    tick,
    route: 'riotDoor',
    dataExtra: { tile, breached },
  })
}

function isNearPerimeter(world: InmateWorld, tileIndex: number): boolean {
  const size = world.grid.size
  const { x, y } = xy(tileIndex, size)
  for (const [dx, dy] of [
    [0, -1],
    [1, 0],
    [0, 1],
    [-1, 0],
  ] as const) {
    const nx = x + dx
    const ny = y + dy
    if (nx < 0 || ny < 0 || nx >= size || ny >= size) return true
    const n = ny * size + nx
    if (world.grid.owned[n] === 0) return true
  }
  return false
}

function isFenceMaterial(world: InmateWorld, tileIndex: number, data: GameData): boolean {
  const wall = world.grid.wallMaterial[tileIndex] ?? NO_MATERIAL
  if (wall === NO_MATERIAL) return false
  const id = world.materials.idAt(wall)
  return data.balance.tunnels.fenceMaterialIds.includes(id)
}

/** Fence climb: needs rope (`canClimb`) or `very_strong`, standing next to a fence. */
export function tryFenceClimb(
  world: InmateWorld,
  entity: InmateEntity,
  data: GameData,
  events: EventSink,
  tick: number,
): boolean {
  const cfg = data.balance.tunnels
  const hasRope = entity.inmate.inventory.some((itemId) => {
    const item = data.contraband.find(itemId)
    return item !== undefined && item.canClimb
  })
  const strong = inmateHasTrait(entity, cfg.veryStrongTraitId)
  if (!hasRope && !strong) return false

  const size = world.grid.size
  const tile = entity.ty * size + entity.tx
  const { x, y } = xy(tile, size)
  let fenceTile: number | null = null
  for (const [dx, dy] of [
    [0, -1],
    [1, 0],
    [0, 1],
    [-1, 0],
  ] as const) {
    const nx = x + dx
    const ny = y + dy
    if (nx < 0 || ny < 0 || nx >= size || ny >= size) continue
    const n = ny * size + nx
    if (isFenceMaterial(world, n, data)) {
      fenceTile = n
      break
    }
  }
  if (fenceTile === null) return false

  return resolveInmateEscape({
    world,
    inmateId: entity.id,
    data,
    events,
    tick,
    route: 'fenceClimb',
    dataExtra: { fenceTile, hasRope, strong },
  })
}

/** Vehicle theft: `driver` trait on a tile with a vehicle object (or dock staging). */
export function tryVehicleTheft(
  world: InmateWorld,
  entity: InmateEntity,
  data: GameData,
  events: EventSink,
  tick: number,
): boolean {
  if (!inmateHasTrait(entity, data.balance.tunnels.driverTraitId)) return false
  const tile = entity.ty * world.grid.size + entity.tx
  const objectId = world.grid.objectId[tile] ?? 0
  let onVehicle = false
  if (objectId !== 0) {
    const obj = world.objects.get(objectId)
    if (obj !== undefined) {
      const def = data.objects.find(obj.object.defId)
      // Supply trucks / vehicles: objects whose id contains "truck" or room is dock.
      if (def !== undefined && (def.id.includes('truck') || obj.object.defId.includes('vehicle'))) {
        onVehicle = true
      }
    }
  }
  // Also allow standing in a functional dock during escape attempt.
  const roomId = world.grid.roomId[tile] ?? NO_ROOM
  const room = roomId === NO_ROOM ? undefined : world.rooms.get(roomId)
  if (!onVehicle && room?.defId !== 'dock') return false

  return resolveInmateEscape({
    world,
    inmateId: entity.id,
    data,
    events,
    tick,
    route: 'vehicleTheft',
    dataExtra: { tile, roomDef: room?.defId ?? null },
  })
}

/**
 * Walking out of a badly zoned prison: inmate stands on an owned map-edge tile
 * that is walkable (no wall), meaning the perimeter does not close.
 */
export function tryWalkOut(
  world: InmateWorld,
  entity: InmateEntity,
  data: GameData,
  events: EventSink,
  tick: number,
): boolean {
  const tile = entity.ty * world.grid.size + entity.tx
  if (!isMapEdgeTile(tile, world.grid.size)) return false
  const pass = world.grid.passability[tile] ?? 0
  if ((pass & PASSABILITY.WALKABLE) === 0) return false
  // "Badly zoned": the edge tile itself is walkable outdoor or lacks a wall.
  const wall = world.grid.wallMaterial[tile] ?? NO_MATERIAL
  if (wall !== NO_MATERIAL) return false

  return resolveInmateEscape({
    world,
    inmateId: entity.id,
    data,
    events,
    tick,
    route: 'walkOut',
    dataExtra: { tile },
  })
}

/* -------------------------------------------------------------------------- */
/* Failure accounting (PRD 5.15)                                               */
/* -------------------------------------------------------------------------- */

export function rollEscapeDayCounters(world: InmateWorld, data: GameData, tick: number): void {
  const day = ticksToDay(tick)
  if (day === world.escapes.accountedDay) return

  // Crossing midnight: yesterday ← today, today ← 0.
  // Warning stays armed if yesterday hit the threshold.
  const warningThreshold = data.balance.failure.escapes.warningPerDay
  world.escapes.warningActive = world.escapes.escapesToday >= warningThreshold
  world.escapes.escapesYesterday = world.escapes.escapesToday
  world.escapes.escapesToday = 0
  world.escapes.accountedDay = day
}

export function checkEscapeFailure(
  world: InmateWorld,
  data: GameData,
  events: EventSink,
  tick: number,
): void {
  // Disarmed at map creation, or PRD 7.9's no-failure mode (T6.5).
  if (!failureArmed(world, 'escapes')) return

  if (world.escapes.failed) return
  const { warningPerDay, thenNextDay } = data.balance.failure.escapes

  if (world.escapes.escapesToday >= warningPerDay && !world.escapes.warningActive) {
    // Same-day warning when the threshold is crossed.
    events.emit({
      tick,
      kind: ESCAPE_EVENTS.failureWarning,
      causeIds: [],
      data: {
        escapesToday: world.escapes.escapesToday,
        warningPerDay,
        thenNextDay,
      },
    })
  }

  // Fail when yesterday hit the warning bar and today adds `thenNextDay` more.
  if (
    world.escapes.escapesYesterday >= warningPerDay &&
    world.escapes.escapesToday >= thenNextDay
  ) {
    world.escapes.failed = true
    events.emit({
      tick,
      kind: ESCAPE_EVENTS.failure,
      causeIds: [],
      data: {
        escapesYesterday: world.escapes.escapesYesterday,
        escapesToday: world.escapes.escapesToday,
        warningPerDay,
        thenNextDay,
      },
    })
  }
}

/* -------------------------------------------------------------------------- */
/* System                                                                      */
/* -------------------------------------------------------------------------- */

export interface EscapeSystemOptions {
  readonly data: GameData
}

export function createEscapeSystem(options: EscapeSystemOptions): System {
  const { data } = options
  let reportedWrongWorld = false

  return {
    name: ESCAPE_SYSTEM_NAME,
    period: ESCAPE_SYSTEM_PERIOD,

    update(context: SystemContext): void {
      const world = context.world
      const tick = context.clock.tick

      if (!isInmateWorld(world)) {
        if (reportedWrongWorld) return
        reportedWrongWorld = true
        context.events.emit({
          tick,
          kind: ESCAPE_EVENTS.rejected,
          causeIds: [],
          data: { command: ESCAPE_SYSTEM_NAME, reason: 'wrong-world' },
        })
        return
      }

      const rng = context.rng.stream(data.balance.tunnels.rngStream)

      // Midnight roll — clock hour 0 on a new day.
      rollEscapeDayCounters(world, data, tick)

      // Clear breach stubs when the riot is over.
      if (!world.riotActive && world.escapes.breachedDoorTiles.size > 0) {
        world.escapes.clearBreachedDoors()
      }

      digHour(world, data, rng, context.events, tick)
      dogPasses(world, data, rng, context.events, tick)
      maintenanceProximitySweep(world, data, rng, context.events, tick)

      // Pending tunnel escapes resolve during digging regimes (night).
      const hour = context.clock.hour
      const blockDefaults = data.balance.routine.defaults
      // Use minimum-security strip as the night signal when any category is sleeping.
      const sampleStrip = blockDefaults['minimum'] ?? Object.values(blockDefaults)[0]
      const hourBlock = sampleStrip?.[hour]
      if (hourBlock !== undefined && isDiggingRegime(hourBlock, data)) {
        resolvePendingNetworkEscapes(world, data, context.events, tick)
      }

      resolveAlternateRoutes(world, data, context.events, tick)
      checkEscapeFailure(world, data, context.events, tick)
    },
  }
}

function digHour(
  world: InmateWorld,
  data: GameData,
  rng: RngStream,
  events: EventSink,
  tick: number,
): void {
  for (const entity of world.inmates.all()) {
    if (!canInmateDig(world, entity, data)) continue
    const needState = world.needsRuntime.stateOf(entity.id)
    needState.diggingTunnel = true

    const tunnel = ensureTunnelForDigger(world, entity, data, events, tick)
    if (tunnel === null || tunnel.discovered || tunnel.reachedExit) continue

    const amount = digProgressThisHour(rng, data)
    advanceTunnelDig(world, tunnel, amount, events, tick)
  }
}

function dogPasses(
  world: InmateWorld,
  data: GameData,
  rng: RngStream,
  events: EventSink,
  tick: number,
): void {
  const dogRole = data.balance.tunnels.dogStaffRoleId
  for (const staff of world.staff.all()) {
    if (staff.staff.defId !== dogRole) continue
    tryDogDetection(world, staff, data, rng, events, tick)
  }
}

/** Maintenance staff standing within dog-detection range of an entrance sweep it. */
function maintenanceProximitySweep(
  world: InmateWorld,
  data: GameData,
  rng: RngStream,
  events: EventSink,
  tick: number,
): void {
  const cfg = data.balance.tunnels
  const radius = cfg.dogDetectionTiles
  for (const staff of world.staff.all()) {
    if (!hasCapability(world.data, staff, cfg.maintenanceCapability)) continue
    const staffTile = staff.ty * world.grid.size + staff.tx
    const nearby: number[] = []
    for (const tunnel of world.escapes.active()) {
      if (tileDistance(staffTile, tunnel.originTile, world.grid.size) <= radius) {
        nearby.push(tunnel.originTile)
      }
    }
    if (nearby.length === 0) continue
    maintenanceSweep(world, data, events, tick, nearby, staff.id, rng)
  }
}

function resolveAlternateRoutes(
  world: InmateWorld,
  data: GameData,
  events: EventSink,
  tick: number,
): void {
  for (const entity of world.inmates.all()) {
    if (tryRiotDoorEscape(world, entity, data, events, tick)) continue
    if (tryFenceClimb(world, entity, data, events, tick)) continue
    if (tryVehicleTheft(world, entity, data, events, tick)) continue
    tryWalkOut(world, entity, data, events, tick)
  }
}

/* -------------------------------------------------------------------------- */
/* Inventory helper (tests / intake of stolen tools)                           */
/* -------------------------------------------------------------------------- */

/** Mutates inmate inventory; the component field is otherwise read-mostly. */
export function setInmateInventory(entity: InmateEntity, items: readonly string[]): void {
  ;(entity.inmate as unknown as { inventory: string[] }).inventory = [...items]
}

export function addInmateInventoryItem(entity: InmateEntity, itemId: string): void {
  const inventory = entity.inmate.inventory as unknown as string[]
  inventory.push(itemId)
}
