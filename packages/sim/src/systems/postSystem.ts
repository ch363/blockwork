/**
 * `PostSystem`: intent-based deployment (T4.1, PRD 3.5).
 *
 * The player does not pin guards to tiles. They declare **posts** — "three
 * officers in the mess hall during meal blocks", "two on the C Wing corridor
 * continuously" — and the game works out who stands where. That single change
 * is what PRD 3.5 says removes most of the tedium in the reference game, and
 * it means the interesting failure is not "I forgot to move a guard" but
 * "there is nobody left to send, and here is why".
 *
 * Three shapes of intent, all handled here:
 *
 *   - **Posts** cover a sector or a specific object. `count` officers of one
 *     role stand in it during the post's time windows.
 *   - **Patrol routes** are an ordered waypoint list walked in a loop, also
 *     under an optional time window.
 *   - **Manual pins** override both. A pinned officer is invisible to
 *     assignment and walks to their tile; the player asked for that guard, in
 *     that spot, and no solver gets to argue.
 *
 * Assignment re-solves on the hour (`balance.posts.assignmentPeriodHours`) and
 * whenever the roster or the post list changes; movement runs every tick,
 * because a post is only filled when somebody is actually standing in it.
 *
 * Every shortfall emits a `post.unfilled` CausalEvent carrying the reason —
 * nobody of that role hired, everybody of that role busy, or nobody able to
 * reach it — which is what the panel's unfilled badge expands into and what
 * PRD 3.1's Trace needs to explain a coverage failure.
 */

import { isJsonArray } from '../core/commands'
import type { Command, JsonValue } from '../core/commands'
import type { Fnv1aHasher } from '../core/hash'
import type { CommandHandler, EventSink, System, SystemContext } from '../core/simulation'
import type { GameData } from '../data/loader'
import { NO_OBJECT } from '../entities/objects'
import { NO_PIN } from '../entities/staff'
import type { StaffEntity } from '../entities/staff'
import { ACCESS } from '../pathfinding/regionGraph'
import { tilePassableForAccess } from '../pathfinding/flowField'
import { NO_SECTOR } from '../world/sectors'
import { PASSABILITY } from '../world/tileGrid'

import { isInmateWorld } from './intakeSystem'
import type { InmateWorld } from './intakeSystem'
import { isStaffAvailableForWork, movementSpeedMultiplier } from './staffNeedsSystem'

/* -------------------------------------------------------------------------- */
/* Identity                                                                    */
/* -------------------------------------------------------------------------- */

export const NO_POST = 0
export const NO_ROUTE = 0

export const POST_EVENTS = {
  created: 'post.created',
  removed: 'post.removed',
  updated: 'post.updated',
  filled: 'post.filled',
  unfilled: 'post.unfilled',
  staffPinned: 'post.staffPinned',
  staffUnpinned: 'post.staffUnpinned',
  rejected: 'post.rejected',
} as const

/** Why a post could not be staffed. Surfaced verbatim in the Trace. */
export type UnfilledReason = 'no-staff-hired' | 'all-staff-busy' | 'unreachable'

/* -------------------------------------------------------------------------- */
/* Time windows                                                                */
/* -------------------------------------------------------------------------- */

/**
 * A half-open range of whole hours, `[startHour, endHour)`.
 *
 * Wrapping is supported and is the common case for night watches: 22 → 6 is
 * 22:00 to 06:00. `startHour === endHour` means the whole day rather than
 * nothing, because a zero-length window is never what anybody drew.
 */
export interface HourRange {
  readonly startHour: number
  readonly endHour: number
}

export function isHourInRange(hour: number, range: HourRange): boolean {
  const { startHour, endHour } = range
  if (startHour === endHour) return true
  if (startHour < endHour) return hour >= startHour && hour < endHour
  // Wrapped: inside means after the start, or before the end on the next day.
  return hour >= startHour || hour < endHour
}

/** An empty window list means "always". Otherwise any range may match. */
export function isHourInWindows(hour: number, windows: readonly HourRange[]): boolean {
  if (windows.length === 0) return true
  return windows.some((range) => isHourInRange(hour, range))
}

function isValidHourRange(range: HourRange): boolean {
  return (
    Number.isInteger(range.startHour) &&
    Number.isInteger(range.endHour) &&
    range.startHour >= 0 &&
    range.startHour < 24 &&
    range.endHour >= 0 &&
    range.endHour < 24
  )
}

/* -------------------------------------------------------------------------- */
/* Records                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * One staffing intent (PRD 3.5).
 *
 * Exactly one of `sectorId` / `objectId` is set: a post covers an area or a
 * fixture, never both. `assigned` is derived — it is rewritten by every
 * assignment pass — but it lives on the record because the panel reads it and
 * because the fingerprint has to see who is standing where.
 */
export interface Post {
  readonly id: number
  name: string
  /** The sector this post covers, or `NO_SECTOR` for an object post. */
  sectorId: number
  /** The object this post covers, or `NO_OBJECT` for a sector post. */
  objectId: number
  /** Staff definition id, for example `officer`. */
  staffRole: string
  count: number
  timeWindows: readonly HourRange[]
  /** Staff currently standing it, ascending. Derived. */
  assigned: number[]
  /** Last reason the post went short, or null while it is filled. Derived. */
  shortfallReason: UnfilledReason | null
  /** Tick of the last `post.unfilled` emission, for report throttling. */
  lastReportedTick: number
}

/**
 * An ordered waypoint loop (PRD 3.5).
 *
 * Waypoints are tile indices in walk order. The loop closes: the officer walks
 * the last waypoint and then heads back to the first.
 */
export interface PatrolRoute {
  readonly id: number
  name: string
  staffRole: string
  count: number
  waypoints: readonly number[]
  timeWindows: readonly HourRange[]
  assigned: number[]
  shortfallReason: UnfilledReason | null
  lastReportedTick: number
}

/** The next waypoint index in a loop. The whole of "patrol looping". */
export function nextWaypointIndex(current: number, length: number): number {
  if (length <= 0) return 0
  return (current + 1) % length
}

/* -------------------------------------------------------------------------- */
/* Registry                                                                    */
/* -------------------------------------------------------------------------- */

const EMPTY_WINDOWS: readonly HourRange[] = Object.freeze([])

/**
 * Every post and patrol route the player has declared.
 *
 * `dirty` is the re-solve trigger: any change to the list, or to the roster,
 * asks for an assignment pass before the next hour boundary would have come
 * round. Deployment that only reacted hourly would leave a newly hired officer
 * standing in reception for up to an hour, which reads as a bug.
 */
export class PostRegistry {
  readonly #posts = new Map<number, Post>()
  readonly #routes = new Map<number, PatrolRoute>()
  #nextPostId = 1
  #nextRouteId = 1
  #dirty = true

  get postCount(): number {
    return this.#posts.size
  }

  get routeCount(): number {
    return this.#routes.size
  }

  get nextPostId(): number {
    return this.#nextPostId
  }

  get nextRouteId(): number {
    return this.#nextRouteId
  }

  get dirty(): boolean {
    return this.#dirty
  }

  /** Asks for an assignment pass on the next tick. */
  markDirty(): void {
    this.#dirty = true
  }

  clearDirty(): void {
    this.#dirty = false
  }

  getPost(postId: number): Post | undefined {
    return this.#posts.get(postId)
  }

  getRoute(routeId: number): PatrolRoute | undefined {
    return this.#routes.get(routeId)
  }

  posts(): Post[] {
    return [...this.#posts.values()].sort((a, b) => a.id - b.id)
  }

  routes(): PatrolRoute[] {
    return [...this.#routes.values()].sort((a, b) => a.id - b.id)
  }

  /** Posts and routes short of staff right now. Drives the panel's badge. */
  get unfilledCount(): number {
    let count = 0
    for (const post of this.#posts.values()) {
      if (post.assigned.length < post.count) count += 1
    }
    for (const route of this.#routes.values()) {
      if (route.assigned.length < route.count) count += 1
    }
    return count
  }

  createPost(options: {
    readonly name: string
    readonly sectorId?: number
    readonly objectId?: number
    readonly staffRole: string
    readonly count: number
    readonly timeWindows?: readonly HourRange[]
  }): Post {
    const id = this.#nextPostId
    this.#nextPostId += 1
    const post: Post = {
      id,
      name: options.name,
      sectorId: options.sectorId ?? NO_SECTOR,
      objectId: options.objectId ?? NO_OBJECT,
      staffRole: options.staffRole,
      count: options.count,
      timeWindows: [...(options.timeWindows ?? EMPTY_WINDOWS)],
      assigned: [],
      shortfallReason: null,
      lastReportedTick: -1,
    }
    this.#posts.set(id, post)
    this.#dirty = true
    return post
  }

  removePost(postId: number): Post | undefined {
    const post = this.#posts.get(postId)
    if (post === undefined) return undefined
    this.#posts.delete(postId)
    this.#dirty = true
    return post
  }

  createRoute(options: {
    readonly name: string
    readonly staffRole: string
    readonly count: number
    readonly waypoints: readonly number[]
    readonly timeWindows?: readonly HourRange[]
  }): PatrolRoute {
    const id = this.#nextRouteId
    this.#nextRouteId += 1
    const route: PatrolRoute = {
      id,
      name: options.name,
      staffRole: options.staffRole,
      count: options.count,
      waypoints: [...options.waypoints],
      timeWindows: [...(options.timeWindows ?? EMPTY_WINDOWS)],
      assigned: [],
      shortfallReason: null,
      lastReportedTick: -1,
    }
    this.#routes.set(id, route)
    this.#dirty = true
    return route
  }

  removeRoute(routeId: number): PatrolRoute | undefined {
    const route = this.#routes.get(routeId)
    if (route === undefined) return undefined
    this.#routes.delete(routeId)
    this.#dirty = true
    return route
  }

  hashInto(hasher: Fnv1aHasher): void {
    hasher.writeUint32(this.#nextPostId)
    hasher.writeUint32(this.#nextRouteId)

    hasher.writeUint32(this.#posts.size)
    for (const post of this.posts()) {
      hasher.writeUint32(post.id)
      hasher.writeString(post.name)
      hasher.writeUint32(post.sectorId)
      hasher.writeUint32(post.objectId)
      hasher.writeString(post.staffRole)
      hasher.writeUint32(post.count)
      hashWindows(hasher, post.timeWindows)
      hasher.writeUint32(post.assigned.length)
      for (const staffId of post.assigned) hasher.writeUint32(staffId)
      hasher.writeString(post.shortfallReason ?? '')
    }

    hasher.writeUint32(this.#routes.size)
    for (const route of this.routes()) {
      hasher.writeUint32(route.id)
      hasher.writeString(route.name)
      hasher.writeString(route.staffRole)
      hasher.writeUint32(route.count)
      hasher.writeUint32(route.waypoints.length)
      for (const tile of route.waypoints) hasher.writeUint32(tile)
      hashWindows(hasher, route.timeWindows)
      hasher.writeUint32(route.assigned.length)
      for (const staffId of route.assigned) hasher.writeUint32(staffId)
      hasher.writeString(route.shortfallReason ?? '')
    }
  }
}

function hashWindows(hasher: Fnv1aHasher, windows: readonly HourRange[]): void {
  hasher.writeUint32(windows.length)
  for (const range of windows) {
    hasher.writeUint32(range.startHour)
    hasher.writeUint32(range.endHour)
  }
}

/* -------------------------------------------------------------------------- */
/* Station tiles                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Where the officers standing one post actually stand.
 *
 * A sector post spreads them over the sector's walkable tiles, at least
 * `stationSpacingTiles` apart so three officers in a mess hall cover it rather
 * than sharing a corner. An object post uses the object's own standable tiles,
 * falling back to its anchor. The list is ascending and deterministic: the
 * same world always produces the same stations, which is what makes the
 * assignment reproducible.
 */
export function stationTilesFor(
  world: InmateWorld,
  data: GameData,
  post: Post,
): number[] {
  const spacing = data.balance.posts.stationSpacingTiles
  const candidates = postAreaTiles(world, post)
  const chosen: number[] = []

  for (const tile of candidates) {
    if (chosen.length >= post.count) break
    if (chosen.every((taken) => chebyshevTiles(world, taken, tile) >= spacing)) {
      chosen.push(tile)
    }
  }
  // A cramped area cannot honour the spacing; better to stack officers in it
  // than to declare the post unfillable over a cosmetic rule.
  for (const tile of candidates) {
    if (chosen.length >= post.count) break
    if (!chosen.includes(tile)) chosen.push(tile)
  }

  return chosen
}

/** Every tile a post covers, ascending. Empty when the target is gone. */
export function postAreaTiles(world: InmateWorld, post: Post): number[] {
  if (post.objectId !== NO_OBJECT) {
    const entity = world.objects.get(post.objectId)
    if (entity === undefined) return []
    const standable = entity.object.tiles.filter((tile) => isStaffStandable(world, tile))
    if (standable.length > 0) return [...standable].sort((a, b) => a - b)
    return adjacentStandable(world, entity.object.tiles)
  }

  if (post.sectorId !== NO_SECTOR) {
    return world.sectors
      .tilesOf(post.sectorId)
      .filter((tile) => isStaffStandable(world, tile))
  }

  return []
}

function adjacentStandable(world: InmateWorld, tiles: readonly number[]): number[] {
  const out = new Set<number>()
  for (const tile of tiles) {
    const { x, y } = world.grid.xy(tile)
    for (const [dx, dy] of NEIGHBOURS) {
      const nx = x + dx
      const ny = y + dy
      if (!world.grid.inBounds(nx, ny)) continue
      const next = world.grid.idx(nx, ny)
      if (isStaffStandable(world, next)) out.add(next)
    }
  }
  return [...out].sort((a, b) => a - b)
}

function isStaffStandable(world: InmateWorld, tile: number): boolean {
  const pass = world.grid.passability[tile] ?? 0
  if ((pass & PASSABILITY.DOOR) !== 0) return false
  return tilePassableForAccess(pass, ACCESS.STAFF)
}

/* -------------------------------------------------------------------------- */
/* Assignment                                                                  */
/* -------------------------------------------------------------------------- */

interface Assignable {
  readonly id: number
  readonly staffRole: string
  readonly count: number
  readonly timeWindows: readonly HourRange[]
  assigned: number[]
  shortfallReason: UnfilledReason | null
  lastReportedTick: number
}

/**
 * Whether this member may be taken for a post right now.
 *
 * Pinned staff are excluded by definition. Escorts, claimed jobs, incidents
 * and breaks are real work and outrank standing still; idle and wander are
 * not, so a wandering officer is fair game.
 */
export function isDeployable(
  world: InmateWorld,
  data: GameData,
  staff: StaffEntity,
): boolean {
  if (staff.staff.pinnedTile !== NO_PIN) return false
  if (!isStaffAvailableForWork(world, data, staff)) return false
  const kind = staff.staff.duty.kind
  return kind === 'idle' || kind === 'wander' || kind === 'post' || kind === 'patrol'
}

/**
 * Solves one deployment pass.
 *
 * Posts are solved before patrols and both in ascending id order, so the
 * scarce-officer case resolves the same way every run. Within a post, staff
 * already standing it keep it — churn costs walking time and looks like
 * indecision — and the shortfall is filled by the nearest deployable member of
 * the right role who can actually reach the place.
 */
export function assignPosts(
  world: InmateWorld,
  data: GameData,
  events: EventSink,
  tick: number,
  hour: number,
): void {
  const roster = world.staff.all()
  const claimed = new Set<number>()

  // Anything currently posted or patrolling releases first: the pass decides
  // afresh, and a stale claim would make a since-deactivated post hold staff.
  for (const staff of roster) {
    const kind = staff.staff.duty.kind
    if (kind === 'post' || kind === 'patrol') staff.staff.duty = { kind: 'idle' }
  }

  for (const post of world.posts.posts()) {
    const stations = stationTilesFor(world, data, post)
    const anchors = stations.length > 0 ? stations : postAreaTiles(world, post)
    solve(world, data, events, tick, hour, roster, claimed, post, anchors, (staff, index) => {
      const station = stations[index] ?? stations[stations.length - 1] ?? -1
      if (station < 0) return false
      staff.staff.duty = { kind: 'post', postId: post.id, stationTile: station }
      staff.staff.assignedAreaId = post.sectorId
      return true
    })
  }

  for (const route of world.posts.routes()) {
    solve(
      world,
      data,
      events,
      tick,
      hour,
      roster,
      claimed,
      route,
      route.waypoints,
      (staff) => {
        if (route.waypoints.length === 0) return false
        staff.staff.duty = {
          kind: 'patrol',
          routeId: route.id,
          waypointIndex: nearestWaypointIndex(world, route.waypoints, staff),
        }
        return true
      },
    )
  }
}

function solve(
  world: InmateWorld,
  data: GameData,
  events: EventSink,
  tick: number,
  hour: number,
  roster: readonly StaffEntity[],
  claimed: Set<number>,
  target: Assignable,
  anchors: readonly number[],
  place: (staff: StaffEntity, index: number) => boolean,
): void {
  target.assigned = []

  if (!isHourInWindows(hour, target.timeWindows)) {
    target.shortfallReason = null
    return
  }

  const withRole = roster.filter((staff) => staff.staff.defId === target.staffRole)
  const deployable = withRole.filter(
    (staff) => !claimed.has(staff.id) && isDeployable(world, data, staff),
  )
  const reachable = deployable.filter((staff) => canReachAny(world, staff, anchors))

  // Nearest first, by walking distance to the closest anchor; id breaks ties so
  // two equidistant officers are always picked in the same order.
  const ordered = [...reachable].sort((a, b) => {
    const da = nearestAnchorDistance(world, a, anchors)
    const db = nearestAnchorDistance(world, b, anchors)
    return da === db ? a.id - b.id : da - db
  })

  for (const staff of ordered) {
    if (target.assigned.length >= target.count) break
    if (!place(staff, target.assigned.length)) continue
    claimed.add(staff.id)
    target.assigned.push(staff.id)
  }

  if (target.assigned.length >= target.count) {
    target.shortfallReason = null
    return
  }

  const reason: UnfilledReason =
    withRole.length === 0
      ? 'no-staff-hired'
      : deployable.length === 0
        ? 'all-staff-busy'
        : 'unreachable'
  target.shortfallReason = reason

  const period =
    data.balance.posts.unfilledReportPeriodHours *
    data.balance.time.minutesPerHour *
    data.balance.time.ticksPerMinute
  if (target.lastReportedTick >= 0 && tick - target.lastReportedTick < period) return
  target.lastReportedTick = tick

  events.emit({
    tick,
    kind: POST_EVENTS.unfilled,
    causeIds: [],
    data: {
      postId: target.id,
      staffRole: target.staffRole,
      required: target.count,
      filled: target.assigned.length,
      hired: withRole.length,
      deployable: deployable.length,
      severity: 'warn',
      reason,
    },
  })
}

function nearestAnchorDistance(
  world: InmateWorld,
  staff: StaffEntity,
  anchors: readonly number[],
): number {
  let best = Number.POSITIVE_INFINITY
  const here = staff.ty * world.grid.size + staff.tx
  for (const tile of anchors) {
    const distance = chebyshevTiles(world, here, tile)
    if (distance < best) best = distance
  }
  return best
}

/**
 * Whether a route exists at all, asked of the coarse graph.
 *
 * The region graph is the cheap answer and the correct one: it already carries
 * the door and sector permissions, so "no permitted route exists" and "the
 * post is unreachable" are the same question.
 */
function canReachAny(
  world: InmateWorld,
  staff: StaffEntity,
  anchors: readonly number[],
): boolean {
  if (anchors.length === 0) return false
  const from = staff.ty * world.grid.size + staff.tx
  for (const tile of anchors) {
    if (from === tile) return true
    if (world.regions.findRegionPath(from, tile, ACCESS.STAFF) !== null) return true
  }
  return false
}

function nearestWaypointIndex(
  world: InmateWorld,
  waypoints: readonly number[],
  staff: StaffEntity,
): number {
  const here = staff.ty * world.grid.size + staff.tx
  let best = 0
  let bestDistance = Number.POSITIVE_INFINITY
  waypoints.forEach((tile, index) => {
    const distance = chebyshevTiles(world, here, tile)
    if (distance < bestDistance) {
      bestDistance = distance
      best = index
    }
  })
  return best
}

/* -------------------------------------------------------------------------- */
/* Movement                                                                    */
/* -------------------------------------------------------------------------- */

const NEIGHBOURS: readonly (readonly [number, number])[] = [
  [0, -1],
  [1, 0],
  [0, 1],
  [-1, 0],
]

function chebyshevTiles(world: InmateWorld, a: number, b: number): number {
  const size = world.grid.size
  const ay = (a / size) | 0
  const ax = a - ay * size
  const by = (b / size) | 0
  const bx = b - by * size
  return Math.max(Math.abs(ax - bx), Math.abs(ay - by))
}

/**
 * Walks posted, patrolling and pinned staff one tick.
 *
 * Posted staff hold their station. Patrollers advance to the next waypoint on
 * arrival and wrap at the end of the list — the loop. Pinned staff walk to
 * their pin and stay there, which is the manual override doing exactly what
 * the player asked and nothing else.
 */
export function movePostedStaff(world: InmateWorld, data: GameData): void {
  const arrive = data.balance.posts.arriveTiles
  const speed =
    data.balance.pathfinding.speedsWorldUnitsPerTick.staff *
    movementSpeedMultiplier(world.morale.value, data.balance.morale)
  const units = data.balance.map.tileWorldUnits

  for (const staff of world.staff.all()) {
    if (staff.staff.pinnedTile !== NO_PIN) {
      stepToward(world, staff, staff.staff.pinnedTile, speed, units)
      continue
    }

    const duty = staff.staff.duty
    if (duty.kind === 'post') {
      if (!isStaffAvailableForWork(world, data, staff)) continue
      stepToward(world, staff, duty.stationTile, speed, units)
      continue
    }

    if (duty.kind === 'patrol') {
      if (!isStaffAvailableForWork(world, data, staff)) continue
      const route = world.posts.getRoute(duty.routeId)
      if (route === undefined || route.waypoints.length === 0) {
        staff.staff.duty = { kind: 'idle' }
        continue
      }
      const target = route.waypoints[duty.waypointIndex] ?? route.waypoints[0]
      if (target === undefined) continue
      const here = staff.ty * world.grid.size + staff.tx
      if (chebyshevTiles(world, here, target) <= arrive) {
        duty.waypointIndex = nextWaypointIndex(duty.waypointIndex, route.waypoints.length)
        continue
      }
      stepToward(world, staff, target, speed, units)
    }
    // Everyone else is somebody else's business: escorts, jobs and breaks are
    // moved by the systems that own them.
  }
}

/**
 * One tick of walking toward a tile.
 *
 * A short breadth-first search over staff-passable tiles, recomputed each
 * tick. Deployment moves are short and infrequent — an officer walks to a post
 * once and then stands there — so a cached path would cost more bookkeeping
 * than it saves.
 */
function stepToward(
  world: InmateWorld,
  staff: StaffEntity,
  goalTile: number,
  speed: number,
  units: number,
): void {
  if (goalTile < 0 || goalTile >= world.grid.size * world.grid.size) return
  const { x: goalTx, y: goalTy } = world.grid.xy(goalTile)
  if (staff.tx === goalTx && staff.ty === goalTy) {
    staff.x = (staff.tx + 0.5) * units
    staff.y = (staff.ty + 0.5) * units
    return
  }

  const next = firstStepToward(world, staff.tx, staff.ty, goalTx, goalTy)
  if (next === undefined) return

  const targetX = (next.tx + 0.5) * units
  const targetY = (next.ty + 0.5) * units
  const dx = targetX - staff.x
  const dy = targetY - staff.y
  const distance = Math.hypot(dx, dy)
  if (distance <= speed || distance === 0) {
    staff.x = targetX
    staff.y = targetY
  } else {
    staff.x += (dx / distance) * speed
    staff.y += (dy / distance) * speed
  }
  staff.tx = Math.floor(staff.x / units)
  staff.ty = Math.floor(staff.y / units)
}

function firstStepToward(
  world: InmateWorld,
  tx: number,
  ty: number,
  goalTx: number,
  goalTy: number,
): { readonly tx: number; readonly ty: number } | undefined {
  const size = world.grid.size
  const total = size * size
  const start = ty * size + tx
  const goal = goalTy * size + goalTx
  if (start === goal) return undefined

  const cameFrom = new Int32Array(total).fill(-1)
  const visited = new Uint8Array(total)
  const queue = new Int32Array(total)
  let head = 0
  let tail = 0
  queue[tail] = start
  tail += 1
  visited[start] = 1
  let found = false

  while (head < tail) {
    const current = queue[head]
    head += 1
    if (current === undefined) break
    if (current === goal) {
      found = true
      break
    }
    const cy = (current / size) | 0
    const cx = current - cy * size
    for (const [ox, oy] of NEIGHBOURS) {
      const nx = cx + ox
      const ny = cy + oy
      if (nx < 0 || ny < 0 || nx >= size || ny >= size) continue
      const next = ny * size + nx
      if (visited[next] === 1) continue
      if (!tilePassableForAccess(world.grid.passability[next] ?? 0, ACCESS.STAFF)) continue
      visited[next] = 1
      cameFrom[next] = current
      queue[tail] = next
      tail += 1
    }
  }

  if (!found) return undefined

  let step = goal
  for (;;) {
    const previous = cameFrom[step] ?? -1
    if (previous < 0) return undefined
    if (previous === start) break
    step = previous
  }
  const y = (step / size) | 0
  return { tx: step - y * size, ty: y }
}

/* -------------------------------------------------------------------------- */
/* System                                                                      */
/* -------------------------------------------------------------------------- */

export interface PostSystemOptions {
  readonly data: GameData
}

export const POST_SYSTEM_NAME = 'posts'

/** Every tick: assignment is hourly, but walking a post is not. */
export const POST_SYSTEM_PERIOD = 1

export function createPostSystem(options: PostSystemOptions): System {
  const { data } = options
  let reportedWrongWorld = false
  let lastAssignedTick = -1
  let lastRosterSize = -1

  const assignmentPeriod =
    data.balance.posts.assignmentPeriodHours *
    data.balance.time.minutesPerHour *
    data.balance.time.ticksPerMinute

  return {
    name: POST_SYSTEM_NAME,
    period: POST_SYSTEM_PERIOD,

    update(context: SystemContext): void {
      const tick = context.clock.tick
      if (!isInmateWorld(context.world)) {
        if (reportedWrongWorld) return
        reportedWrongWorld = true
        context.events.emit({
          tick,
          kind: POST_EVENTS.rejected,
          causeIds: [],
          data: { command: POST_SYSTEM_NAME, reason: 'wrong-world' },
        })
        return
      }

      const world = context.world
      const rosterChanged = world.staff.size !== lastRosterSize
      const due = lastAssignedTick < 0 || tick - lastAssignedTick >= assignmentPeriod

      if (world.posts.dirty || rosterChanged || due) {
        assignPosts(world, data, context.events, tick, context.clock.hour)
        world.posts.clearDirty()
        lastAssignedTick = tick
        lastRosterSize = world.staff.size
      }

      movePostedStaff(world, data)
    },
  }
}

/* -------------------------------------------------------------------------- */
/* Commands                                                                    */
/* -------------------------------------------------------------------------- */

export const POST_COMMANDS = {
  create: 'post.create',
  remove: 'post.remove',
  update: 'post.update',
  createPatrol: 'post.createPatrol',
  removePatrol: 'post.removePatrol',
  pinStaff: 'post.pinStaff',
  unpinStaff: 'post.unpinStaff',
} as const

export function postCommandHandlers(data: GameData): Readonly<Record<string, CommandHandler>> {
  return {
    [POST_COMMANDS.create]: (command, context) => {
      handleCreate(command, context, data)
    },
    [POST_COMMANDS.remove]: (command, context) => {
      handleRemove(command, context)
    },
    [POST_COMMANDS.update]: (command, context) => {
      handleUpdate(command, context)
    },
    [POST_COMMANDS.createPatrol]: (command, context) => {
      handleCreatePatrol(command, context, data)
    },
    [POST_COMMANDS.removePatrol]: (command, context) => {
      handleRemovePatrol(command, context)
    },
    [POST_COMMANDS.pinStaff]: (command, context) => {
      handlePin(command, context)
    },
    [POST_COMMANDS.unpinStaff]: (command, context) => {
      handleUnpin(command, context)
    },
  }
}

function handleCreate(command: Command, context: SystemContext, data: GameData): void {
  if (!isInmateWorld(context.world)) return reject(context, command, 'wrong-world')
  const name = readString(command.payload, 'name')
  const staffRole = readString(command.payload, 'staffRole')
  const count = readInt(command.payload, 'count')
  const sectorId = readInt(command.payload, 'sectorId') ?? NO_SECTOR
  const objectId = readInt(command.payload, 'objectId') ?? NO_OBJECT
  const timeWindows = readWindows(command.payload)

  if (name === undefined || staffRole === undefined || count === undefined || count < 1) {
    return reject(context, command, 'malformed-payload')
  }
  if (timeWindows === undefined) return reject(context, command, 'malformed-window')
  if (!data.staff.has(staffRole)) return reject(context, command, 'unknown-role')
  if (sectorId === NO_SECTOR && objectId === NO_OBJECT) {
    return reject(context, command, 'no-target')
  }
  if (sectorId !== NO_SECTOR && context.world.sectors.get(sectorId) === undefined) {
    return reject(context, command, 'unknown-sector')
  }
  if (objectId !== NO_OBJECT && context.world.objects.get(objectId) === undefined) {
    return reject(context, command, 'unknown-object')
  }

  const post = context.world.posts.createPost({
    name,
    sectorId,
    objectId,
    staffRole,
    count,
    timeWindows,
  })
  context.events.emit({
    tick: context.clock.tick,
    kind: POST_EVENTS.created,
    causeIds: [],
    data: { postId: post.id, name, staffRole, count, sectorId, objectId },
  })
}

function handleRemove(command: Command, context: SystemContext): void {
  if (!isInmateWorld(context.world)) return reject(context, command, 'wrong-world')
  const postId = readInt(command.payload, 'postId')
  if (postId === undefined) return reject(context, command, 'malformed-payload')
  const post = context.world.posts.removePost(postId)
  if (post === undefined) return reject(context, command, 'unknown-post')
  releaseDuty(context.world, (duty) => duty.kind === 'post' && duty.postId === postId)
  context.events.emit({
    tick: context.clock.tick,
    kind: POST_EVENTS.removed,
    causeIds: [],
    data: { postId, name: post.name },
  })
}

function handleUpdate(command: Command, context: SystemContext): void {
  if (!isInmateWorld(context.world)) return reject(context, command, 'wrong-world')
  const postId = readInt(command.payload, 'postId')
  if (postId === undefined) return reject(context, command, 'malformed-payload')
  const post = context.world.posts.getPost(postId)
  if (post === undefined) return reject(context, command, 'unknown-post')

  const count = readInt(command.payload, 'count')
  if (count !== undefined) {
    if (count < 1) return reject(context, command, 'malformed-payload')
    post.count = count
  }
  const name = readString(command.payload, 'name')
  if (name !== undefined) post.name = name

  if (hasKey(command.payload, 'timeWindows')) {
    const windows = readWindows(command.payload)
    if (windows === undefined) return reject(context, command, 'malformed-window')
    post.timeWindows = windows
  }

  context.world.posts.markDirty()
  context.events.emit({
    tick: context.clock.tick,
    kind: POST_EVENTS.updated,
    causeIds: [],
    data: { postId, count: post.count, name: post.name },
  })
}

function handleCreatePatrol(command: Command, context: SystemContext, data: GameData): void {
  if (!isInmateWorld(context.world)) return reject(context, command, 'wrong-world')
  const name = readString(command.payload, 'name')
  const staffRole = readString(command.payload, 'staffRole')
  const count = readInt(command.payload, 'count')
  const waypoints = readIntArray(command.payload, 'waypoints')
  const timeWindows = readWindows(command.payload)

  if (
    name === undefined ||
    staffRole === undefined ||
    count === undefined ||
    count < 1 ||
    waypoints === undefined ||
    waypoints.length < 2
  ) {
    return reject(context, command, 'malformed-payload')
  }
  if (timeWindows === undefined) return reject(context, command, 'malformed-window')
  if (!data.staff.has(staffRole)) return reject(context, command, 'unknown-role')
  if (waypoints.length > data.balance.posts.maxWaypoints) {
    return reject(context, command, 'too-many-waypoints')
  }
  const total = context.world.grid.size * context.world.grid.size
  if (waypoints.some((tile) => tile < 0 || tile >= total)) {
    return reject(context, command, 'waypoint-out-of-bounds')
  }

  const route = context.world.posts.createRoute({
    name,
    staffRole,
    count,
    waypoints,
    timeWindows,
  })
  context.events.emit({
    tick: context.clock.tick,
    kind: POST_EVENTS.created,
    causeIds: [],
    data: { routeId: route.id, name, staffRole, count, waypoints: waypoints.length },
  })
}

function handleRemovePatrol(command: Command, context: SystemContext): void {
  if (!isInmateWorld(context.world)) return reject(context, command, 'wrong-world')
  const routeId = readInt(command.payload, 'routeId')
  if (routeId === undefined) return reject(context, command, 'malformed-payload')
  const route = context.world.posts.removeRoute(routeId)
  if (route === undefined) return reject(context, command, 'unknown-route')
  releaseDuty(context.world, (duty) => duty.kind === 'patrol' && duty.routeId === routeId)
  context.events.emit({
    tick: context.clock.tick,
    kind: POST_EVENTS.removed,
    causeIds: [],
    data: { routeId, name: route.name },
  })
}

function handlePin(command: Command, context: SystemContext): void {
  if (!isInmateWorld(context.world)) return reject(context, command, 'wrong-world')
  const staffId = readInt(command.payload, 'staffId')
  const tileIndex = readInt(command.payload, 'tileIndex')
  if (staffId === undefined || tileIndex === undefined) {
    return reject(context, command, 'malformed-payload')
  }
  const staff = context.world.staff.get(staffId)
  if (staff === undefined) return reject(context, command, 'unknown-staff')
  const total = context.world.grid.size * context.world.grid.size
  if (tileIndex < 0 || tileIndex >= total) return reject(context, command, 'out-of-bounds')

  staff.staff.pinnedTile = tileIndex
  staff.staff.duty = { kind: 'idle' }
  context.world.posts.markDirty()
  context.events.emit({
    tick: context.clock.tick,
    kind: POST_EVENTS.staffPinned,
    causeIds: [],
    data: { staffId, tileIndex },
  })
}

function handleUnpin(command: Command, context: SystemContext): void {
  if (!isInmateWorld(context.world)) return reject(context, command, 'wrong-world')
  const staffId = readInt(command.payload, 'staffId')
  if (staffId === undefined) return reject(context, command, 'malformed-payload')
  const staff = context.world.staff.get(staffId)
  if (staff === undefined) return reject(context, command, 'unknown-staff')

  staff.staff.pinnedTile = NO_PIN
  context.world.posts.markDirty()
  context.events.emit({
    tick: context.clock.tick,
    kind: POST_EVENTS.staffUnpinned,
    causeIds: [],
    data: { staffId },
  })
}

function releaseDuty(
  world: InmateWorld,
  matches: (duty: StaffEntity['staff']['duty']) => boolean,
): void {
  for (const staff of world.staff.all()) {
    if (matches(staff.staff.duty)) staff.staff.duty = { kind: 'idle' }
  }
}

function reject(context: SystemContext, command: Command, reason: string): void {
  context.events.emit({
    tick: context.clock.tick,
    kind: POST_EVENTS.rejected,
    causeIds: [],
    data: { command: command.type, reason },
  })
}

/* -------------------------------------------------------------------------- */
/* Payload readers                                                             */
/* -------------------------------------------------------------------------- */

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

/**
 * Reads `timeWindows`, distinguishing "absent" (an empty always-on list) from
 * "present but wrong" (`undefined`, which callers report as a rejection).
 */
function readWindows(payload: JsonValue): readonly HourRange[] | undefined {
  const value = asObject(payload)?.['timeWindows']
  if (value === undefined) return EMPTY_WINDOWS
  if (!Array.isArray(value)) return undefined

  const out: HourRange[] = []
  for (const entry of value) {
    const object = asObject(entry)
    if (object === undefined) return undefined
    const startHour = object['startHour']
    const endHour = object['endHour']
    if (typeof startHour !== 'number' || typeof endHour !== 'number') return undefined
    const range = { startHour, endHour }
    if (!isValidHourRange(range)) return undefined
    out.push(range)
  }
  return out
}

