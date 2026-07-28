/**
 * Construction: how a drawn rectangle becomes physical structure (T1.2).
 *
 * The load-bearing decision here is that **nothing a player draws changes the
 * world immediately**. Every command produces `ConstructionSite`s, one per
 * tile, each holding a bill of materials and a work total; `constructionSystem`
 * advances them and only a completed site writes to the grid. That is what
 * makes a prison something the staff build rather than something the player
 * conjures, and it is what gives logistics (T3.4) and the job system (T2.3)
 * somewhere to attach.
 *
 * Consequences worth knowing before reading on:
 *
 *   - A site is keyed by tile, so a second command over the same tile replaces
 *     the first rather than queueing behind it. Drawing a floor across a wall
 *     you already ordered cancels the wall, which is what the drag preview
 *     showed you.
 *   - Commands validate against the world as it is now, not as it will be. A
 *     wall ordered where a wall already stands is dropped at queue time; a
 *     wall ordered where one is half built is not, because the tile is still
 *     empty.
 *   - Passability is derived, never authored. `refreshPassability` reads the
 *     tile back out of the grid and the door registry, so there is one rule
 *     for what a tile allows and every mutation path goes through it. Getting
 *     this wrong strands agents inside walls, and it is exactly the class of
 *     bug that only shows up two systems downstream.
 *
 * Money: demolition refunds accumulate on the world rather than being paid
 * out here, because the economy does not exist until T3.6. The maths is done
 * and recorded at the moment of demolition, which is the only moment that
 * knows what was standing there.
 */

import { TICKS_PER_MINUTE } from '../core/clock'
import { isJsonArray } from '../core/commands'
import type { Command, JsonValue } from '../core/commands'
import type { Fnv1aHasher } from '../core/hash'
import type { CommandHandler, EventSink, SystemContext, World } from '../core/simulation'
import type { GameData } from '../data/loader'
import { DOOR_TYPES } from '../data/schemas'
import type { DoorDef, DoorType, MaterialDef } from '../data/schemas'
import { DirectorateState } from '../entities/directorate'

import { DoorRegistry, doorPassability, initialLockState } from './doors'
import { MaterialTable, NO_MATERIAL } from './materials'
import type { MaterialId } from './materials'
import { PASSABILITY, TileGrid } from './tileGrid'
import { isAxisAligned, wallLineTiles } from './walls'

/* -------------------------------------------------------------------------- */
/* Geometry                                                                    */
/* -------------------------------------------------------------------------- */

/** A tile rectangle, anchored at its top-left corner. */
export interface Rect {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

export interface Tile {
  readonly x: number
  readonly y: number
}

export function isValidRect(rect: Rect): boolean {
  return (
    Number.isInteger(rect.x) &&
    Number.isInteger(rect.y) &&
    Number.isInteger(rect.width) &&
    Number.isInteger(rect.height) &&
    rect.width > 0 &&
    rect.height > 0
  )
}

/** The part of a rectangle that is on the grid, or `undefined` if none is. */
export function clipRect(rect: Rect, size: number): Rect | undefined {
  const left = Math.max(0, rect.x)
  const top = Math.max(0, rect.y)
  const right = Math.min(size - 1, rect.x + rect.width - 1)
  const bottom = Math.min(size - 1, rect.y + rect.height - 1)
  if (right < left || bottom < top) return undefined
  return { x: left, y: top, width: right - left + 1, height: bottom - top + 1 }
}

/** Tile indices covered by a rectangle, in ascending order. */
export function rectTiles(grid: TileGrid, rect: Rect): number[] {
  const tiles: number[] = []
  for (let y = rect.y; y < rect.y + rect.height; y += 1) {
    for (let x = rect.x; x < rect.x + rect.width; x += 1) {
      tiles.push(grid.idx(x, y))
    }
  }
  return tiles
}

/**
 * Whether a tile is on the rectangle's perimeter. Computed against the
 * *unclipped* rectangle so that a foundation drawn partly off the map still
 * walls the edge the player drew, rather than walling the map boundary.
 */
export function isPerimeter(rect: Rect, x: number, y: number): boolean {
  return (
    x === rect.x || y === rect.y || x === rect.x + rect.width - 1 || y === rect.y + rect.height - 1
  )
}

/* -------------------------------------------------------------------------- */
/* Sites                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * What a site is for.
 *
 * `clear` covers both `RemoveWall` and `Demolish`: they differ only in what
 * they take away, so they are one job with two switches rather than two jobs
 * with one implementation each.
 */
export type ConstructionJob =
  | { readonly kind: 'floor'; readonly material: MaterialId; readonly foundation: boolean }
  | { readonly kind: 'wall'; readonly material: MaterialId; readonly foundation: boolean }
  | { readonly kind: 'door'; readonly doorType: DoorType }
  | { readonly kind: 'clear'; readonly wall: boolean; readonly floor: boolean }

export const CONSTRUCTION_JOB_KINDS = ['floor', 'wall', 'door', 'clear'] as const

export type ConstructionJobKind = (typeof CONSTRUCTION_JOB_KINDS)[number]

/**
 * Why a site is not progressing. Tracked on the site so the system can emit a
 * `CausalEvent` when the reason *changes* rather than once every update: a
 * stalled build site is one fact, not one fact per tick.
 */
export const CONSTRUCTION_BLOCKERS = ['none', 'materials', 'worker'] as const

export type ConstructionBlocker = (typeof CONSTRUCTION_BLOCKERS)[number]

/** One line of a site's bill of materials. `itemId` names a material or a supply. */
export interface MaterialRequirement {
  readonly itemId: string
  readonly units: number
}

/**
 * A queued piece of work on one tile.
 *
 * `workTicksRequired` is in worker-ticks: one worker standing on the tile for
 * one tick contributes one. The total comes from the material's `buildMinutes`
 * so that build times stay a data decision.
 */
export interface ConstructionSite {
  readonly id: number
  readonly tileIndex: number
  readonly job: ConstructionJob
  readonly requirements: readonly MaterialRequirement[]
  /** Units delivered so far, parallel to `requirements`. */
  readonly delivered: number[]
  readonly workTicksRequired: number
  /** Material cost, for blueprint pricing (T1.5) and the ledger (T3.6). */
  readonly cost: number
  readonly queuedAtTick: number
  workTicksDone: number
  blockedBy: ConstructionBlocker
}

export function isDelivered(site: ConstructionSite): boolean {
  return site.requirements.every(
    (requirement, index) => (site.delivered[index] ?? 0) >= requirement.units,
  )
}

/**
 * Records a delivery against a site and returns the units actually accepted.
 *
 * The seam T3.4 plugs real logistics into. Surplus is refused rather than
 * stored: a site is not a warehouse, and accepting more than the bill would
 * make "delivered" untestable.
 */
export function deliver(site: ConstructionSite, itemId: string, units: number): number {
  let accepted = 0
  let remaining = units
  site.requirements.forEach((requirement, index) => {
    if (remaining <= 0 || requirement.itemId !== itemId) return
    const outstanding = requirement.units - (site.delivered[index] ?? 0)
    if (outstanding <= 0) return
    const taken = Math.min(outstanding, remaining)
    site.delivered[index] = (site.delivered[index] ?? 0) + taken
    remaining -= taken
    accepted += taken
  })
  return accepted
}

/** The T3.4 stub: fills the bill of materials outright. */
export function deliverAll(site: ConstructionSite): void {
  site.requirements.forEach((requirement, index) => {
    site.delivered[index] = requirement.units
  })
}

function sameJob(a: ConstructionJob, b: ConstructionJob): boolean {
  if (a.kind === 'floor' && b.kind === 'floor') {
    return a.material === b.material && a.foundation === b.foundation
  }
  if (a.kind === 'wall' && b.kind === 'wall') {
    return a.material === b.material && a.foundation === b.foundation
  }
  if (a.kind === 'door' && b.kind === 'door') {
    return a.doorType === b.doorType
  }
  if (a.kind === 'clear' && b.kind === 'clear') {
    return a.wall === b.wall && a.floor === b.floor
  }
  return false
}

function hashJob(job: ConstructionJob, materials: MaterialTable, hasher: Fnv1aHasher): void {
  hasher.writeUint32(CONSTRUCTION_JOB_KINDS.indexOf(job.kind))
  switch (job.kind) {
    case 'floor':
    case 'wall':
      hasher.writeUint32(materials.tryIndexOf(job.material) ?? NO_MATERIAL)
      hasher.writeBoolean(job.foundation)
      return
    case 'door':
      hasher.writeUint32(DOOR_TYPES.indexOf(job.doorType))
      return
    case 'clear':
      hasher.writeBoolean(job.wall)
      hasher.writeBoolean(job.floor)
      return
  }
}

/**
 * Every pending site, keyed by tile.
 *
 * One site per tile is a modelling choice, not a limitation: two orders for
 * the same tile are two versions of the same intent, and the later one wins.
 * Iteration is in ascending tile order so that the system does the same work
 * in the same order on every machine.
 */
export class ConstructionQueue {
  readonly #sites = new Map<number, ConstructionSite>()
  #nextId = 1

  get size(): number {
    return this.#sites.size
  }

  /**
   * The next id that would be allocated. Part of the fingerprint, and what
   * lets a caller that queues a batch tell its own sites apart from the ones
   * that were already pending (T1.5 prices a commit that way).
   */
  get nextId(): number {
    return this.#nextId
  }

  has(tileIndex: number): boolean {
    return this.#sites.has(tileIndex)
  }

  get(tileIndex: number): ConstructionSite | undefined {
    return this.#sites.get(tileIndex)
  }

  /** Pending sites in ascending tile order. */
  all(): ConstructionSite[] {
    const sites = [...this.#sites.values()]
    sites.sort((a, b) => a.tileIndex - b.tileIndex)
    return sites
  }

  add(site: Omit<ConstructionSite, 'id'>): ConstructionSite {
    const created: ConstructionSite = { ...site, id: this.#nextId }
    this.#nextId += 1
    this.#sites.set(site.tileIndex, created)
    return created
  }

  remove(tileIndex: number): ConstructionSite | undefined {
    const site = this.#sites.get(tileIndex)
    this.#sites.delete(tileIndex)
    return site
  }

  clear(): void {
    this.#sites.clear()
  }

  hashInto(hasher: Fnv1aHasher, materials: MaterialTable): void {
    hasher.writeUint32(this.#nextId)
    hasher.writeUint32(this.#sites.size)
    for (const site of this.all()) {
      hasher.writeUint32(site.id)
      hasher.writeUint32(site.tileIndex)
      hashJob(site.job, materials, hasher)
      hasher.writeUint32(site.requirements.length)
      site.requirements.forEach((requirement, index) => {
        hasher.writeString(requirement.itemId)
        hasher.writeUint32(requirement.units)
        hasher.writeUint32(site.delivered[index] ?? 0)
      })
      hasher.writeUint32(site.workTicksRequired)
      hasher.writeUint32(site.workTicksDone)
      hasher.writeUint32(site.cost)
      hasher.writeUint32(site.queuedAtTick)
      hasher.writeUint32(CONSTRUCTION_BLOCKERS.indexOf(site.blockedBy))
    }
  }
}

/* -------------------------------------------------------------------------- */
/* World                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * The buildable world: the tile grid plus everything T1.2 puts on it.
 *
 * It is the simulation's `World`, so every field here reaches the determinism
 * fingerprint. The material table does not, because it is derived from content
 * rather than play; what reaches the hash is the indices the grid holds.
 */
export class ConstructionWorld implements World {
  readonly grid: TileGrid
  readonly materials: MaterialTable
  readonly doors = new DoorRegistry()
  readonly sites = new ConstructionQueue()
  /**
   * Directorate research (T5.1).
   *
   * It sits this low because the two earliest gates — designating a room and
   * placing an object — run against a `ConstructionWorld`, both from the
   * command handlers and from a blueprint commit. Anywhere higher and those
   * paths could not see it, which would leave "locked" as UI decoration.
   */
  readonly directorate = new DirectorateState()

  /** Demolition proceeds awaiting the economy (T3.6). */
  #refunds = 0

  /** Committed blueprint costs awaiting the economy (T1.5, T3.6). */
  #spend = 0

  constructor(grid: TileGrid, materials: MaterialTable) {
    this.grid = grid
    this.materials = materials
  }

  get refundsOwed(): number {
    return this.#refunds
  }

  addRefund(amount: number): void {
    this.#refunds += amount
  }

  /** Hands the accumulated refunds to the caller and resets the tally. */
  takeRefunds(): number {
    const owed = this.#refunds
    this.#refunds = 0
    return owed
  }

  get spendOwed(): number {
    return this.#spend
  }

  /**
   * Records money the player has committed to spend.
   *
   * The mirror of `addRefund`, and it exists for the same reason: committing a
   * blueprint is the only moment that knows what the whole build costs, and
   * there is no ledger to bill until T3.6. Both tallies are world state, so
   * both reach the fingerprint.
   */
  addSpend(amount: number): void {
    this.#spend += amount
  }

  /** Hands the accumulated spend to the caller and resets the tally. */
  takeSpend(): number {
    const owed = this.#spend
    this.#spend = 0
    return owed
  }

  /**
   * Announces that a tile's physical structure changed: a wall, a door or a
   * floor went up or came down.
   *
   * Derived state that a tile can invalidate hangs off this rather than off a
   * scan, because the only cheap moment to know what changed is the moment it
   * changes. `applyJob` is the sole caller, which is the same reason it is the
   * sole writer of structure. T1.3's `RoomWorld` overrides it to scope room
   * detection; nothing at this layer is listening.
   */
  structureChanged(_tileIndex: number): void {
    // Intentionally empty. See the comment above.
  }

  hashInto(hasher: Fnv1aHasher): void {
    this.grid.hashInto(hasher)
    this.doors.hashInto(hasher)
    this.sites.hashInto(hasher, this.materials)
    this.directorate.hashInto(hasher)
    hasher.writeUint32(this.#refunds)
    hasher.writeUint32(this.#spend)
  }
}

/**
 * An unbuilt world of `size` x `size` tiles: open ground, walkable, under the
 * sky.
 *
 * `TileGrid.allocate` zeroes every field, and two of those zeroes are wrong
 * for a field that nobody has built on yet — zero `passability` means
 * impassable and zero `outdoors` means roofed. Construction derives both from
 * what stands on a tile, so the starting state has to be stated once, here,
 * rather than assumed by every caller. T6.5's map generation replaces this
 * with real terrain.
 */
export function createConstructionWorld(size: number, data: GameData): ConstructionWorld {
  const world = new ConstructionWorld(
    TileGrid.allocate(size),
    MaterialTable.from(data.materials.ids()),
  )
  world.grid.fill('outdoors', 1)
  refreshPassabilityRect(world, data)
  return world
}

/* -------------------------------------------------------------------------- */
/* Passability                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * What a tile allows, derived from what stands on it and the sector over it.
 *
 * Walls block, doors carry their own mask, everything else is open ground.
 * On top of that, a `staffOnly` or `secure` sector stamps its own bit onto
 * every tile it covers (T4.1) — walls excepted, since a wall allows nothing
 * for anybody and adding qualifiers to zero would only mislead.
 */
export function tilePassability(world: ConstructionWorld, data: GameData, index: number): number {
  if (world.grid.getAt('wallMaterial', index) !== NO_MATERIAL) return 0

  const sector = sectorPassabilityBits(world, index)

  const door = world.doors.get(index)
  if (door !== undefined) {
    const def = data.doors.find(door.type)
    if (def !== undefined) return doorPassability(def, door.locked) | sector
  }

  return PASSABILITY.WALKABLE | sector
}

/**
 * Duck-typed hook so construction can read sector access without importing
 * `world/sectors`, which needs the access bits that live under `pathfinding`.
 * A world with no sectors contributes nothing.
 */
function sectorPassabilityBits(world: ConstructionWorld, index: number): number {
  const candidate = world as ConstructionWorld & {
    sectors?: { passabilityBitsOfSector(sectorId: number): number }
  }
  const sectors = candidate.sectors
  if (sectors === undefined) return 0
  return sectors.passabilityBitsOfSector(world.grid.getAt('sectorId', index))
}

/** Recomputes one tile's passability and marks its chunk dirty. */
export function refreshPassability(world: ConstructionWorld, data: GameData, index: number): void {
  world.grid.setAt('passability', index, tilePassability(world, data, index))
}

/**
 * Recomputes a region, or the whole grid when no rectangle is given.
 *
 * The whole-grid form is for the paths that acquire a grid rather than build
 * it a tile at a time: a new world, and a loaded save whose derived state has
 * to be rebuilt rather than trusted (PRD 7.4).
 */
export function refreshPassabilityRect(
  world: ConstructionWorld,
  data: GameData,
  rect?: Rect,
): void {
  const size = world.grid.size
  const area = clipRect(rect ?? { x: 0, y: 0, width: size, height: size }, size)
  if (area === undefined) return
  const dirtySink = pathingDirtySink(world)
  for (const index of rectTiles(world.grid, area)) {
    refreshPassability(world, data, index)
    dirtySink?.add(index)
  }
}

/** Duck-typed hook so construction can dirty pathfinding without importing intake. */
function pathingDirtySink(world: ConstructionWorld): Set<number> | undefined {
  const candidate = world as ConstructionWorld & { pathingDirtyTiles?: Set<number> }
  return candidate.pathingDirtyTiles
}

/* -------------------------------------------------------------------------- */
/* Costs and work                                                              */
/* -------------------------------------------------------------------------- */

/** Whole worker-ticks, never zero: a job that takes no work would never queue. */
function workTicks(minutes: number): number {
  return Math.max(1, Math.round(minutes * TICKS_PER_MINUTE))
}

function materialOnTile(
  world: ConstructionWorld,
  data: GameData,
  field: 'wallMaterial' | 'floorMaterial',
  index: number,
): MaterialDef | undefined {
  const materialIndex = world.grid.getAt(field, index)
  if (materialIndex === NO_MATERIAL) return undefined
  return data.materials.find(world.materials.idAt(materialIndex))
}

/**
 * What clearing a tile gives back: half of what the standing structure cost,
 * by default (`balance.construction.materialRefundOnDemolish`).
 *
 * Floored rather than rounded, so salvage can never be worth more than the
 * fraction says, and computed from what is actually on the tile rather than
 * from what the site that built it claimed.
 */
export function demolitionRefund(
  world: ConstructionWorld,
  data: GameData,
  index: number,
  clear: { readonly wall: boolean; readonly floor: boolean },
): number {
  let value = 0

  if (clear.wall) {
    value += materialOnTile(world, data, 'wallMaterial', index)?.costPerTile ?? 0
    const door = world.doors.get(index)
    if (door !== undefined) value += data.doors.find(door.type)?.cost ?? 0
  }
  if (clear.floor) {
    value += materialOnTile(world, data, 'floorMaterial', index)?.costPerTile ?? 0
  }

  return Math.floor(value * data.balance.construction.materialRefundOnDemolish)
}

/** How long clearing a tile takes: a share of building what stands there. */
function clearWorkMinutes(
  world: ConstructionWorld,
  data: GameData,
  index: number,
  clear: { readonly wall: boolean; readonly floor: boolean },
): number {
  let minutes = 0
  if (clear.wall) {
    minutes += materialOnTile(world, data, 'wallMaterial', index)?.buildMinutes ?? 0
    const door = world.doors.get(index)
    if (door !== undefined) minutes += data.doors.find(door.type)?.buildMinutes ?? 0
  }
  if (clear.floor) {
    minutes += materialOnTile(world, data, 'floorMaterial', index)?.buildMinutes ?? 0
  }
  return minutes * data.balance.construction.demolishMinutesFraction
}

/* -------------------------------------------------------------------------- */
/* Events                                                                      */
/* -------------------------------------------------------------------------- */

/** Why a command, or part of one, produced nothing. */
export type ConstructionRejection =
  | 'invalid-payload'
  | 'invalid-rect'
  | 'invalid-line'
  | 'off-grid'
  | 'unknown-material'
  | 'wrong-surface'
  | 'unknown-door-type'
  | 'wrong-world'

export interface ConstructionDeps {
  readonly world: ConstructionWorld
  readonly data: GameData
  readonly events: EventSink
  readonly tick: number
}

function reject(
  deps: ConstructionDeps,
  command: string,
  reason: ConstructionRejection,
  detail: Readonly<Record<string, JsonValue>> = {},
): void {
  deps.events.emit({
    tick: deps.tick,
    kind: 'construction.rejected',
    causeIds: [],
    data: { command, reason, ...detail },
  })
}

/* -------------------------------------------------------------------------- */
/* Queueing                                                                    */
/* -------------------------------------------------------------------------- */

interface JobPlan {
  readonly requirements: readonly MaterialRequirement[]
  readonly minutes: number
  readonly cost: number
}

function planJob(deps: ConstructionDeps, index: number, job: ConstructionJob): JobPlan | undefined {
  const { world, data } = deps

  switch (job.kind) {
    case 'floor':
    case 'wall': {
      const material = data.materials.find(job.material)
      if (material === undefined) return undefined
      return {
        requirements: [{ itemId: material.id, units: 1 }],
        minutes: material.buildMinutes,
        cost: material.costPerTile,
      }
    }
    case 'door': {
      const door = data.doors.find(job.doorType)
      if (door === undefined) return undefined
      return {
        requirements: door.materials.map((entry) => ({
          itemId: entry.itemId,
          units: entry.units,
        })),
        minutes: door.buildMinutes,
        cost: door.cost,
      }
    }
    case 'clear':
      return {
        requirements: [],
        minutes: clearWorkMinutes(world, data, index, job),
        cost: 0,
      }
  }
}

/** True when the tile already is what the job would make it. */
function alreadySatisfied(deps: ConstructionDeps, index: number, job: ConstructionJob): boolean {
  const { world } = deps
  const wall = world.grid.getAt('wallMaterial', index)
  const floor = world.grid.getAt('floorMaterial', index)

  switch (job.kind) {
    case 'floor':
      return floor === world.materials.tryIndexOf(job.material)
    case 'wall':
      return wall === world.materials.tryIndexOf(job.material)
    case 'door':
      return world.doors.get(index)?.type === job.doorType && wall === NO_MATERIAL
    case 'clear': {
      const wallGone = !job.wall || (wall === NO_MATERIAL && !world.doors.has(index))
      const floorGone = !job.floor || floor === NO_MATERIAL
      return wallGone && floorGone
    }
  }
}

/**
 * Drops a pending site.
 *
 * Anything already delivered to it is lost, which is honest for now and wrong
 * later: T3.4 owns returning materials to the store when an order is torn up.
 */
function cancelSite(deps: ConstructionDeps, site: ConstructionSite, reason: string): void {
  deps.world.sites.remove(site.tileIndex)
  deps.events.emit({
    tick: deps.tick,
    kind: 'construction.site.cancelled',
    causeIds: [site.id],
    data: { tileIndex: site.tileIndex, job: site.job.kind, reason },
  })
}

/**
 * Queues one tile of work, replacing whatever was pending there.
 *
 * Returns the site, or `undefined` when there is nothing to do — the tile is
 * already in the target state, or an identical order is already pending.
 */
export function queueSite(
  deps: ConstructionDeps,
  index: number,
  job: ConstructionJob,
): ConstructionSite | undefined {
  const existing = deps.world.sites.get(index)

  if (alreadySatisfied(deps, index, job)) {
    // Ordering a tile into the state it is already in is how a player takes an
    // order back: dragging the demolish tool over a wall you have not built
    // yet should leave you with no wall and no work, not with a wall queued
    // and a demolition queued behind it.
    if (existing !== undefined) cancelSite(deps, existing, 'superseded')
    return undefined
  }

  if (existing !== undefined && sameJob(existing.job, job)) return undefined

  const plan = planJob(deps, index, job)
  if (plan === undefined) return undefined

  if (existing !== undefined) cancelSite(deps, existing, 'replaced')

  return deps.world.sites.add({
    tileIndex: index,
    job,
    requirements: plan.requirements,
    delivered: plan.requirements.map(() => 0),
    workTicksRequired: workTicks(plan.minutes),
    cost: plan.cost,
    queuedAtTick: deps.tick,
    workTicksDone: 0,
    blockedBy: 'none',
  })
}

/* -------------------------------------------------------------------------- */
/* Completion                                                                  */
/* -------------------------------------------------------------------------- */

/** Autotiling reads the eight neighbours, so a change repaints all nine tiles. */
function markNeighbourhoodDirty(world: ConstructionWorld, index: number): void {
  const { x, y } = world.grid.xy(index)
  world.grid.markDirtyRect(x - 1, y - 1, 3, 3)
}

/**
 * Applies a finished site to the world.
 *
 * This is the only function that writes structure, which is what lets the
 * passability refresh and the dirty marking be stated once instead of at every
 * call site.
 */
export function applyJob(deps: ConstructionDeps, index: number, job: ConstructionJob): number {
  const { world, data } = deps
  const grid = world.grid
  let refund = 0

  switch (job.kind) {
    case 'floor':
      grid.setAt('floorMaterial', index, world.materials.indexOf(job.material))
      if (job.foundation) grid.setAt('outdoors', index, 0)
      break

    case 'wall':
      // A wall built over a door replaces it: the opening is what was ordered
      // away.
      world.doors.remove(index)
      grid.setAt('wallMaterial', index, world.materials.indexOf(job.material))
      if (job.foundation) grid.setAt('outdoors', index, 0)
      break

    case 'door': {
      const def = data.doors.find(job.doorType)
      if (def === undefined) break
      // A door occupies the wall segment rather than sitting alongside it, so
      // the wall material goes; `walls.isWallLike` keeps the run continuous.
      grid.setAt('wallMaterial', index, NO_MATERIAL)
      world.doors.place(index, job.doorType, initialLockState(def))
      break
    }

    case 'clear':
      refund = demolitionRefund(world, data, index, job)
      if (job.wall) {
        grid.setAt('wallMaterial', index, NO_MATERIAL)
        world.doors.remove(index)
      }
      if (job.floor) {
        grid.setAt('floorMaterial', index, NO_MATERIAL)
        // Losing the floor loses the foundation, and with it the roof.
        grid.setAt('outdoors', index, 1)
      }
      if (refund > 0) world.addRefund(refund)
      break
  }

  refreshPassability(world, data, index)
  markNeighbourhoodDirty(world, index)
  world.structureChanged(index)
  return refund
}

/**
 * Finishes a site: applies it, removes it from the queue and records the
 * causal link the Trace panel follows back from "this wall exists".
 */
export function completeSite(deps: ConstructionDeps, site: ConstructionSite): void {
  const refund = applyJob(deps, site.tileIndex, site.job)
  deps.world.sites.remove(site.tileIndex)

  deps.events.emit({
    tick: deps.tick,
    kind: 'construction.completed',
    causeIds: [site.id],
    data: { tileIndex: site.tileIndex, job: site.job.kind, refund },
  })
}

/* -------------------------------------------------------------------------- */
/* Commands                                                                    */
/* -------------------------------------------------------------------------- */

/** The command names the UI sends across the worker boundary (PRD 4.6). */
export const CONSTRUCTION_COMMANDS = {
  placeFoundation: 'construction.placeFoundation',
  placeWall: 'construction.placeWall',
  removeWall: 'construction.removeWall',
  placeDoor: 'construction.placeDoor',
  paintFloor: 'construction.paintFloor',
  demolish: 'construction.demolish',
} as const

function surfaceMaterial(
  deps: ConstructionDeps,
  command: string,
  materialId: MaterialId,
  surface: 'floor' | 'wall',
): MaterialDef | undefined {
  const material = deps.data.materials.find(materialId)
  if (material === undefined) {
    reject(deps, command, 'unknown-material', { materialId })
    return undefined
  }
  if (!material.surfaces.includes(surface)) {
    reject(deps, command, 'wrong-surface', { materialId, surface })
    return undefined
  }
  return material
}

function commandRect(deps: ConstructionDeps, command: string, rect: Rect): Rect | undefined {
  if (!isValidRect(rect)) {
    reject(deps, command, 'invalid-rect', { ...rect })
    return undefined
  }
  const clipped = clipRect(rect, deps.world.grid.size)
  if (clipped === undefined) {
    reject(deps, command, 'off-grid', { ...rect })
    return undefined
  }
  return clipped
}

/**
 * `PlaceFoundation`: walls around the edge, floor inside, and the whole
 * footprint indoors.
 *
 * The floor material is not the player's choice here — a foundation lays
 * `balance.construction.foundationFloorMaterial` and the player repaints it
 * afterwards with `PaintFloor` if they want something better.
 *
 * @returns the number of tiles queued.
 */
export function placeFoundation(deps: ConstructionDeps, rect: Rect, material: MaterialId): number {
  const command = CONSTRUCTION_COMMANDS.placeFoundation
  const clipped = commandRect(deps, command, rect)
  if (clipped === undefined) return 0

  const wallMaterial = surfaceMaterial(deps, command, material, 'wall')
  if (wallMaterial === undefined) return 0

  const floorId = deps.data.balance.construction.foundationFloorMaterial
  const floorMaterial = surfaceMaterial(deps, command, floorId, 'floor')
  if (floorMaterial === undefined) return 0

  let queued = 0
  for (let y = clipped.y; y < clipped.y + clipped.height; y += 1) {
    for (let x = clipped.x; x < clipped.x + clipped.width; x += 1) {
      const index = deps.world.grid.idx(x, y)
      const job: ConstructionJob = isPerimeter(rect, x, y)
        ? { kind: 'wall', material: wallMaterial.id, foundation: true }
        : { kind: 'floor', material: floorMaterial.id, foundation: true }
      if (queueSite(deps, index, job) !== undefined) queued += 1
    }
  }
  return queued
}

/** `PlaceWall`: a wall along an axis-aligned stroke. */
export function placeWall(
  deps: ConstructionDeps,
  line: { readonly x1: number; readonly y1: number; readonly x2: number; readonly y2: number },
  material: MaterialId,
): number {
  const command = CONSTRUCTION_COMMANDS.placeWall
  if (!isAxisAligned(line)) {
    reject(deps, command, 'invalid-line', { ...line })
    return 0
  }

  const wallMaterial = surfaceMaterial(deps, command, material, 'wall')
  if (wallMaterial === undefined) return 0

  const tiles = wallLineTiles(deps.world.grid, line)
  if (tiles.length === 0) {
    reject(deps, command, 'off-grid', { ...line })
    return 0
  }

  let queued = 0
  for (const index of tiles) {
    const job: ConstructionJob = { kind: 'wall', material: wallMaterial.id, foundation: false }
    if (queueSite(deps, index, job) !== undefined) queued += 1
  }
  return queued
}

/**
 * `RemoveWall`: takes the wall, and any door built into it, off a stroke. The
 * floor underneath stays, because removing a wall is not demolishing a room.
 */
export function removeWall(
  deps: ConstructionDeps,
  line: { readonly x1: number; readonly y1: number; readonly x2: number; readonly y2: number },
): number {
  const command = CONSTRUCTION_COMMANDS.removeWall
  if (!isAxisAligned(line)) {
    reject(deps, command, 'invalid-line', { ...line })
    return 0
  }

  const tiles = wallLineTiles(deps.world.grid, line)
  if (tiles.length === 0) {
    reject(deps, command, 'off-grid', { ...line })
    return 0
  }

  let queued = 0
  for (const index of tiles) {
    if (queueSite(deps, index, { kind: 'clear', wall: true, floor: false }) !== undefined) {
      queued += 1
    }
  }
  return queued
}

/** `PlaceDoor`: one door on one tile, of one of the six types. */
export function placeDoor(deps: ConstructionDeps, tile: Tile, doorType: DoorType): boolean {
  const command = CONSTRUCTION_COMMANDS.placeDoor

  if (!deps.world.grid.inBounds(tile.x, tile.y)) {
    reject(deps, command, 'off-grid', { ...tile })
    return false
  }

  const def: DoorDef | undefined = deps.data.doors.find(doorType)
  if (def === undefined) {
    reject(deps, command, 'unknown-door-type', { doorType })
    return false
  }

  const index = deps.world.grid.idx(tile.x, tile.y)
  return queueSite(deps, index, { kind: 'door', doorType: def.id }) !== undefined
}

/** `PaintFloor`: a floor material over a rectangle. Does not make it indoors. */
export function paintFloor(deps: ConstructionDeps, rect: Rect, material: MaterialId): number {
  const command = CONSTRUCTION_COMMANDS.paintFloor
  const clipped = commandRect(deps, command, rect)
  if (clipped === undefined) return 0

  const floorMaterial = surfaceMaterial(deps, command, material, 'floor')
  if (floorMaterial === undefined) return 0

  let queued = 0
  for (const index of rectTiles(deps.world.grid, clipped)) {
    const job: ConstructionJob = { kind: 'floor', material: floorMaterial.id, foundation: false }
    if (queueSite(deps, index, job) !== undefined) queued += 1
  }
  return queued
}

/** `Demolish`: everything on a rectangle — walls, doors and floors. */
export function demolish(deps: ConstructionDeps, rect: Rect): number {
  const clipped = commandRect(deps, CONSTRUCTION_COMMANDS.demolish, rect)
  if (clipped === undefined) return 0

  let queued = 0
  for (const index of rectTiles(deps.world.grid, clipped)) {
    if (queueSite(deps, index, { kind: 'clear', wall: true, floor: true }) !== undefined) {
      queued += 1
    }
  }
  return queued
}

/* -------------------------------------------------------------------------- */
/* Command handlers                                                            */
/* -------------------------------------------------------------------------- */

/*
 * Payloads arrive as untrusted JSON from the main thread, so each one is
 * read defensively and a malformed command becomes a `CausalEvent` rather
 * than an exception inside the tick loop.
 */

function asRecord(value: JsonValue): Readonly<Record<string, JsonValue>> | undefined {
  if (value === null || typeof value !== 'object' || isJsonArray(value)) return undefined
  return value
}

function asInteger(value: JsonValue | undefined): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) ? value : undefined
}

function asRect(value: JsonValue | undefined): Rect | undefined {
  const record = value === undefined ? undefined : asRecord(value)
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

interface Line {
  readonly x1: number
  readonly y1: number
  readonly x2: number
  readonly y2: number
}

function asLine(value: JsonValue | undefined): Line | undefined {
  const record = value === undefined ? undefined : asRecord(value)
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

function asTile(value: JsonValue | undefined): Tile | undefined {
  const record = value === undefined ? undefined : asRecord(value)
  if (record === undefined) return undefined
  const x = asInteger(record['x'])
  const y = asInteger(record['y'])
  if (x === undefined || y === undefined) return undefined
  return { x, y }
}

function asMaterialId(value: JsonValue | undefined): MaterialId | undefined {
  return typeof value === 'string' ? value : undefined
}

function asDoorType(value: JsonValue | undefined): DoorType | undefined {
  return DOOR_TYPES.find((type) => type === value)
}

/**
 * Adapts the command queue to the functions above.
 *
 * The handlers take the world from the `SystemContext` rather than closing
 * over it, so a simulation that reloads a save keeps working; a world that is
 * not buildable is a wiring mistake and says so once per command instead of
 * throwing inside the tick.
 */
export function constructionCommandHandlers(data: GameData): Record<string, CommandHandler> {
  const bind = (
    context: SystemContext,
    command: Command,
    run: (deps: ConstructionDeps, payload: Readonly<Record<string, JsonValue>>) => void,
  ): void => {
    const world = context.world
    const tick = context.clock.tick

    if (!(world instanceof ConstructionWorld)) {
      context.events.emit({
        tick,
        kind: 'construction.rejected',
        causeIds: [],
        data: { command: command.type, reason: 'wrong-world' satisfies ConstructionRejection },
      })
      return
    }

    const deps: ConstructionDeps = { world, data, events: context.events, tick }

    const payload = asRecord(command.payload)
    if (payload === undefined) {
      reject(deps, command.type, 'invalid-payload')
      return
    }

    run(deps, payload)
  }

  const invalid = (deps: ConstructionDeps, command: Command): void => {
    reject(deps, command.type, 'invalid-payload')
  }

  return {
    [CONSTRUCTION_COMMANDS.placeFoundation]: (command, context) => {
      bind(context, command, (deps, payload) => {
        const rect = asRect(payload['rect'])
        const material = asMaterialId(payload['material'])
        if (rect === undefined || material === undefined) return invalid(deps, command)
        placeFoundation(deps, rect, material)
      })
    },
    [CONSTRUCTION_COMMANDS.placeWall]: (command, context) => {
      bind(context, command, (deps, payload) => {
        const line = asLine(payload['line'])
        const material = asMaterialId(payload['material'])
        if (line === undefined || material === undefined) return invalid(deps, command)
        placeWall(deps, line, material)
      })
    },
    [CONSTRUCTION_COMMANDS.removeWall]: (command, context) => {
      bind(context, command, (deps, payload) => {
        const line = asLine(payload['line'])
        if (line === undefined) return invalid(deps, command)
        removeWall(deps, line)
      })
    },
    [CONSTRUCTION_COMMANDS.placeDoor]: (command, context) => {
      bind(context, command, (deps, payload) => {
        const tile = asTile(payload['tile'])
        const doorType = asDoorType(payload['doorType'])
        if (tile === undefined || doorType === undefined) return invalid(deps, command)
        placeDoor(deps, tile, doorType)
      })
    },
    [CONSTRUCTION_COMMANDS.paintFloor]: (command, context) => {
      bind(context, command, (deps, payload) => {
        const rect = asRect(payload['rect'])
        const material = asMaterialId(payload['material'])
        if (rect === undefined || material === undefined) return invalid(deps, command)
        paintFloor(deps, rect, material)
      })
    },
    [CONSTRUCTION_COMMANDS.demolish]: (command, context) => {
      bind(context, command, (deps, payload) => {
        const rect = asRect(payload['rect'])
        if (rect === undefined) return invalid(deps, command)
        demolish(deps, rect)
      })
    },
  }
}
