/**
 * Staff: hiring, offices, escort jobs and fog of war (T2.7, PRD 5.6).
 *
 * Staff are the second mobile entity kind after inmates. Hiring deducts
 * `hireCost` immediately on the economy ledger (T3.6). Hourly wages are paid
 * by `EconomySystem`. Administrators claim a free functional office on hire
 * and rename it; officers clear fog, open locked secure doors for inmates,
 * and run escort jobs until the full job system (T3.2) absorbs that queue.
 */

import type { Fnv1aHasher } from '../core/hash'
import type { EventSink } from '../core/simulation'
import type { GameData } from '../data/loader'
import type { StaffCapability, StaffDef } from '../data/schemas'
import { refreshPassability } from '../world/construction'
import type { ConstructionWorld } from '../world/construction'
import { tileCount } from '../world/coords'
import { PASSABILITY } from '../world/tileGrid'
import { NO_ROOM } from '../world/rooms'

import { isUnlocked } from './directorate'
import type { DirectorateState } from './directorate'
import { NO_INMATE } from './inmate'

/* -------------------------------------------------------------------------- */
/* Identity                                                                    */
/* -------------------------------------------------------------------------- */

/** `staffId` 0 and missing registry lookups mean "none". */
export const NO_STAFF = 0

/** `StaffComponent.pinnedTile` when the player has not pinned this member. */
export const NO_PIN = -1

/** Soft ceiling so ids stay JSON- and snapshot-friendly. */
export const MAX_STAFF_ID = 0xffff_ffff

/** CausalEvent kinds emitted by hiring / escort / wage paths. */
export const STAFF_EVENTS = {
  hired: 'staff.hired',
  hireRejected: 'staff.hireRejected',
  fired: 'staff.fired',
  officeClaimed: 'staff.officeClaimed',
  escortQueued: 'staff.escortQueued',
  escortClaimed: 'staff.escortClaimed',
  escortCompleted: 'staff.escortCompleted',
  escortAborted: 'staff.escortAborted',
  wagesPaid: 'staff.wagesPaid',
  doorOpened: 'staff.doorOpened',
} as const

/* -------------------------------------------------------------------------- */
/* Component                                                                   */
/* -------------------------------------------------------------------------- */

export type StaffDuty =
  | { readonly kind: 'idle' }
  | { readonly kind: 'wander'; readonly goalTx: number; readonly goalTy: number }
  | { readonly kind: 'escort'; readonly jobId: number }
  /** Claimed via the general job pool (T3.2). */
  | { readonly kind: 'job'; readonly jobId: number }
  | { readonly kind: 'incident'; readonly tileIndex: number }
  /** Standing a post (T4.1). `stationTile` is this officer's slot in it. */
  | { readonly kind: 'post'; readonly postId: number; readonly stationTile: number }
  /** Walking a patrol route in a loop (T4.1). */
  | {
      readonly kind: 'patrol'
      readonly routeId: number
      /** Index into the route's waypoints; wraps at the end. */
      waypointIndex: number
    }
  /**
   * On break (T3.8). `seek` walks to a staff-accessible room; `use` discharges
   * needs at an object. Abandon resets to idle after the seek timeout.
   */
  | {
      readonly kind: 'break'
      phase: 'seek' | 'use'
      targetRoomId: number
      targetObjectId: number
      /** Minutes spent seeking without a usable object. */
      seekMinutes: number
      /** Minutes spent on this break session. */
      sessionMinutes: number
    }

export interface StaffComponent {
  readonly defId: string
  /** Display name: role name plus a hire-order suffix. */
  readonly name: string
  /** Claimed office room id, or `NO_ROOM` when the role needs none / none free. */
  officeRoomId: number
  /** Player-painted sector / post (T4.1). 0 means unassigned — wander the map. */
  assignedAreaId: number
  /**
   * Manual pin (PRD 3.5). A tile index the player nailed this member to, or
   * -1. A pinned member is invisible to post assignment: the override is the
   * whole point of it.
   */
  pinnedTile: number
  duty: StaffDuty
  /** Ticks until the next wander re-roll while idle. */
  wanderCooldown: number
  /**
   * Staff need vector laid out like inmate needs (`NeedIndex` order). Only
   * ids listed on the staff def are filled/discharged (T3.8).
   */
  needs: Float32Array
  /** True once needs cross the break threshold; break starts after the job ends. */
  breakPending: boolean
  /** Minutes to wait after abandoning a break before seeking again. */
  breakCooldownMinutes: number
}

export interface StaffEntity {
  readonly id: number
  readonly kind: 'staff'
  x: number
  y: number
  tx: number
  ty: number
  readonly staff: StaffComponent
}

/* -------------------------------------------------------------------------- */
/* Escort jobs                                                                 */
/* -------------------------------------------------------------------------- */

export type EscortPurpose = 'cell_assignment' | 'isolation' | 'clinic' | 'program' | 'other'

export type EscortJobState =
  'queued' | 'approach_inmate' | 'escort_to_destination' | 'completed' | 'aborted'

/**
 * A one-off escort until T3.2's job system owns every work kind.
 *
 * Lifecycle: queued → officer claims → walks to inmate → inmate follows →
 * both reach `destinationTile` → completed.
 */
export interface EscortJob {
  readonly id: number
  readonly inmateId: number
  readonly destinationTile: number
  readonly purpose: EscortPurpose
  state: EscortJobState
  /** Claiming officer, or `NO_STAFF` while queued. */
  claimedBy: number
  /**
   * Cached tile waypoints for the current leg (officer→inmate or pair→dest).
   * Cleared whenever the leg or goal changes.
   */
  path: number[] | null
  pathIndex: number
}

export class EscortJobQueue {
  readonly #jobs = new Map<number, EscortJob>()
  #nextId = 1

  get size(): number {
    return this.#jobs.size
  }

  get nextId(): number {
    return this.#nextId
  }

  get(jobId: number): EscortJob | undefined {
    return this.#jobs.get(jobId)
  }

  all(): EscortJob[] {
    const jobs = [...this.#jobs.values()]
    jobs.sort((a, b) => a.id - b.id)
    return jobs
  }

  /** Open jobs an idle escort-capable officer may claim, ascending id. */
  queued(): EscortJob[] {
    return this.all().filter((job) => job.state === 'queued')
  }

  active(): EscortJob[] {
    return this.all().filter(
      (job) => job.state === 'approach_inmate' || job.state === 'escort_to_destination',
    )
  }

  enqueue(options: {
    readonly inmateId: number
    readonly destinationTile: number
    readonly purpose: EscortPurpose
  }): EscortJob {
    const id = this.#nextId
    this.#nextId += 1
    const job: EscortJob = {
      id,
      inmateId: options.inmateId,
      destinationTile: options.destinationTile,
      purpose: options.purpose,
      state: 'queued',
      claimedBy: NO_STAFF,
      path: null,
      pathIndex: 0,
    }
    this.#jobs.set(id, job)
    return job
  }

  remove(jobId: number): EscortJob | undefined {
    const job = this.#jobs.get(jobId)
    if (job === undefined) return undefined
    this.#jobs.delete(jobId)
    return job
  }

  /** Drops finished / aborted jobs so the queue stays bounded. */
  pruneTerminal(): void {
    for (const job of this.all()) {
      if (job.state === 'completed' || job.state === 'aborted') {
        this.#jobs.delete(job.id)
      }
    }
  }

  hashInto(hasher: Fnv1aHasher): void {
    hasher.writeUint32(this.#nextId)
    hasher.writeUint32(this.#jobs.size)
    for (const job of this.all()) {
      hasher.writeUint32(job.id)
      hasher.writeUint32(job.inmateId)
      hasher.writeUint32(job.destinationTile)
      hasher.writeString(job.purpose)
      hasher.writeString(job.state)
      hasher.writeUint32(job.claimedBy)
      hasher.writeUint32(job.pathIndex)
      hasher.writeUint32(job.path?.length ?? 0)
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Office claims                                                               */
/* -------------------------------------------------------------------------- */

export interface OfficeClaim {
  readonly roomId: number
  readonly staffId: number
  /** Shown in the inspector in place of the generic "Office" label. */
  readonly displayName: string
}

/**
 * Which administrator owns which office. Room detection still sees `defId:
 * 'office'`; this is the display / exclusivity layer on top.
 */
export class OfficeClaimRegistry {
  readonly #byRoom = new Map<number, OfficeClaim>()
  readonly #byStaff = new Map<number, number>()

  get size(): number {
    return this.#byRoom.size
  }

  get(roomId: number): OfficeClaim | undefined {
    return this.#byRoom.get(roomId)
  }

  roomOf(staffId: number): number | undefined {
    return this.#byStaff.get(staffId)
  }

  isClaimed(roomId: number): boolean {
    return this.#byRoom.has(roomId)
  }

  all(): OfficeClaim[] {
    const claims = [...this.#byRoom.values()]
    claims.sort((a, b) => a.roomId - b.roomId)
    return claims
  }

  claim(roomId: number, staffId: number, displayName: string): OfficeClaim {
    const existing = this.#byStaff.get(staffId)
    if (existing !== undefined) this.releaseStaff(staffId)
    const claim: OfficeClaim = { roomId, staffId, displayName }
    this.#byRoom.set(roomId, claim)
    this.#byStaff.set(staffId, roomId)
    return claim
  }

  releaseStaff(staffId: number): void {
    const roomId = this.#byStaff.get(staffId)
    if (roomId === undefined) return
    this.#byStaff.delete(staffId)
    this.#byRoom.delete(roomId)
  }

  releaseRoom(roomId: number): void {
    const claim = this.#byRoom.get(roomId)
    if (claim === undefined) return
    this.#byRoom.delete(roomId)
    this.#byStaff.delete(claim.staffId)
  }

  hashInto(hasher: Fnv1aHasher): void {
    hasher.writeUint32(this.#byRoom.size)
    for (const claim of this.all()) {
      hasher.writeUint32(claim.roomId)
      hasher.writeUint32(claim.staffId)
      hasher.writeString(claim.displayName)
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Fog of war                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Per-tile revelation. Officers stamp a disc of `fogRadiusTiles` each tick;
 * cameras (T4.x) will OR into the same buffer.
 */
export class FogOfWar {
  readonly size: number
  readonly revealed: Uint8Array

  constructor(size: number) {
    this.size = size
    this.revealed = new Uint8Array(tileCount(size))
  }

  isRevealed(tx: number, ty: number): boolean {
    if (tx < 0 || ty < 0 || tx >= this.size || ty >= this.size) return false
    return this.revealed[ty * this.size + tx] === 1
  }

  revealAround(tx: number, ty: number, radius: number): number {
    let newly = 0
    const r2 = radius * radius
    const minX = Math.max(0, tx - radius)
    const maxX = Math.min(this.size - 1, tx + radius)
    const minY = Math.max(0, ty - radius)
    const maxY = Math.min(this.size - 1, ty + radius)
    for (let y = minY; y <= maxY; y += 1) {
      for (let x = minX; x <= maxX; x += 1) {
        const dx = x - tx
        const dy = y - ty
        if (dx * dx + dy * dy > r2) continue
        const index = y * this.size + x
        if (this.revealed[index] === 1) continue
        this.revealed[index] = 1
        newly += 1
      }
    }
    return newly
  }

  hashInto(hasher: Fnv1aHasher): void {
    hasher.writeUint32(this.size)
    let count = 0
    for (let i = 0; i < this.revealed.length; i += 1) {
      if (this.revealed[i] === 1) count += 1
    }
    hasher.writeUint32(count)
    for (let i = 0; i < this.revealed.length; i += 1) {
      if (this.revealed[i] === 1) hasher.writeUint32(i)
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Registry                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * The one number a duty is about, for the determinism fingerprint.
 *
 * Hashing the kind alone would let two runs differ on which post an officer
 * is standing, or which waypoint they are walking to, and still agree.
 */
function dutyTarget(duty: StaffDuty): number {
  switch (duty.kind) {
    case 'idle':
      return 0
    case 'wander':
      return duty.goalTx * 0x1_0000 + duty.goalTy
    case 'escort':
    case 'job':
      return duty.jobId
    case 'incident':
      return duty.tileIndex
    case 'post':
      return duty.postId * 0x1_0000 + (duty.stationTile & 0xffff)
    case 'patrol':
      return duty.routeId * 0x1_0000 + duty.waypointIndex
    case 'break':
      return duty.targetRoomId * 0x1_0000 + (duty.targetObjectId & 0xffff)
    default:
      return 0
  }
}

export class StaffRegistry {
  readonly #staff = new Map<number, StaffEntity>()
  #nextId = 1
  /** Hire-order counters per def id, for stable display names. */
  readonly #hireCounts = new Map<string, number>()

  get size(): number {
    return this.#staff.size
  }

  get nextId(): number {
    return this.#nextId
  }

  get(entityId: number): StaffEntity | undefined {
    return this.#staff.get(entityId)
  }

  all(): StaffEntity[] {
    const entities = [...this.#staff.values()]
    entities.sort((a, b) => a.id - b.id)
    return entities
  }

  /** Staff whose def lists `capability`, ascending id. */
  withCapability(data: GameData, capability: StaffCapability): StaffEntity[] {
    return this.all().filter((entity) => {
      const def = data.staff.find(entity.staff.defId)
      return def !== undefined && def.capabilities.includes(capability)
    })
  }

  allocateId(): number {
    if (this.#nextId > MAX_STAFF_ID) return NO_STAFF
    const id = this.#nextId
    this.#nextId += 1
    return id
  }

  nextHireSuffix(defId: string): number {
    const next = (this.#hireCounts.get(defId) ?? 0) + 1
    this.#hireCounts.set(defId, next)
    return next
  }

  add(entity: StaffEntity): void {
    this.#staff.set(entity.id, entity)
  }

  remove(entityId: number): StaffEntity | undefined {
    const entity = this.#staff.get(entityId)
    if (entity === undefined) return undefined
    this.#staff.delete(entityId)
    return entity
  }

  hashInto(hasher: Fnv1aHasher): void {
    hasher.writeUint32(this.#nextId)
    hasher.writeUint32(this.#staff.size)
    for (const entity of this.all()) {
      hasher.writeUint32(entity.id)
      hasher.writeString(entity.staff.defId)
      hasher.writeString(entity.staff.name)
      hasher.writeUint32(entity.staff.officeRoomId)
      hasher.writeUint32(entity.staff.assignedAreaId)
      hasher.writeInt32(entity.staff.pinnedTile)
      hasher.writeString(entity.staff.duty.kind)
      hasher.writeUint32(dutyTarget(entity.staff.duty))
      hasher.writeUint32(entity.staff.wanderCooldown)
      hasher.writeUint32(entity.staff.breakPending ? 1 : 0)
      hasher.writeUint32(entity.staff.breakCooldownMinutes)
      hasher.writeUint32(entity.staff.needs.length)
      for (let i = 0; i < entity.staff.needs.length; i += 1) {
        hasher.writeFloat64(entity.staff.needs[i] ?? 0)
      }
      hasher.writeFloat64(entity.x)
      hasher.writeFloat64(entity.y)
      hasher.writeUint32(entity.tx)
      hasher.writeUint32(entity.ty)
    }
    const counts = [...this.#hireCounts.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    hasher.writeUint32(counts.length)
    for (const [defId, count] of counts) {
      hasher.writeString(defId)
      hasher.writeUint32(count)
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Hiring                                                                      */
/* -------------------------------------------------------------------------- */

export interface StaffWorldView {
  readonly data: GameData
  /** Research state, so a locked role cannot be hired (T5.1). */
  readonly directorate: DirectorateState
  readonly staff: StaffRegistry
  readonly offices: OfficeClaimRegistry
  readonly escorts: EscortJobQueue
  readonly fog: FogOfWar
  addSpend(amount: number): void
  /**
   * Optional ledger. When present, hire costs post immediately; otherwise they
   * stage on the spend outbox for the economy system to drain.
   */
  readonly economy?: {
    debit(
      tick: number,
      category: 'hire',
      amount: number,
      reason: string,
      sourceEntityId: number,
    ): unknown
  }
  /** Optional morale state so firing clears injury tracking (T3.8). */
  readonly morale?: { clearStaff(staffId: number): void }
  rooms: {
    readonly all: () => Iterable<{
      readonly id: number
      readonly defId: string
      readonly tiles: readonly number[]
    }>
    readonly statusOf: (roomId: number) => { readonly functional: boolean } | undefined
  }
  readonly grid: {
    readonly size: number
    idx(x: number, y: number): number
    xy(index: number): { readonly x: number; readonly y: number }
  }
}

export type HireRejection =
  | 'unknown-role'
  | 'id-exhausted'
  | 'no-office'
  | 'requires-room'
  | 'callable-only'
  | 'per-session'
  /** The role's Directorate node has not completed (T5.1). */
  | 'locked'

export interface HireStaffOptions {
  readonly world: StaffWorldView
  readonly defId: string
  readonly events: EventSink
  readonly tick: number
  /** Spawn tile; defaults to the claimed office or map centre. */
  readonly tx?: number
  readonly ty?: number
}

export interface HireStaffResult {
  readonly entity?: StaffEntity
  readonly reason?: HireRejection
}

/**
 * Hires one staff member: pays `hireCost`, claims an office for administrators,
 * and places them in the world.
 */
export function hireStaff(options: HireStaffOptions): HireStaffResult {
  const { world, defId, events, tick } = options
  const def = world.data.staff.find(defId)
  if (def === undefined) {
    rejectHire(events, tick, defId, 'unknown-role')
    return { reason: 'unknown-role' }
  }
  // Research first: a role the player has not unlocked does not exist yet, so
  // "you cannot hire an instructor directly" is the wrong thing to say about
  // one whose Education node is still outstanding.
  if (!isUnlocked(world.data, world.directorate, 'staff', defId)) {
    rejectHire(events, tick, defId, 'locked')
    return { reason: 'locked' }
  }
  if (def.callable) {
    rejectHire(events, tick, defId, 'callable-only')
    return { reason: 'callable-only' }
  }
  if (def.perSession) {
    rejectHire(events, tick, defId, 'per-session')
    return { reason: 'per-session' }
  }
  if (def.requiresRoom !== undefined) {
    const hasRoom = [...world.rooms.all()].some((room) => {
      if (room.defId !== def.requiresRoom) return false
      const status = world.rooms.statusOf(room.id)
      return status !== undefined && status.functional
    })
    if (!hasRoom) {
      rejectHire(events, tick, defId, 'requires-room')
      return { reason: 'requires-room' }
    }
  }

  let officeRoomId = NO_ROOM
  if (def.requiresOffice) {
    const free = findFreeOffice(world)
    if (free === undefined) {
      rejectHire(events, tick, defId, 'no-office')
      return { reason: 'no-office' }
    }
    officeRoomId = free
  }

  const id = world.staff.allocateId()
  if (id === NO_STAFF) {
    rejectHire(events, tick, defId, 'id-exhausted')
    return { reason: 'id-exhausted' }
  }

  const suffix = world.staff.nextHireSuffix(defId)
  const name = `${def.name} ${suffix}`
  const spawn = resolveSpawn(world, options.tx, options.ty, officeRoomId)
  const units = world.data.balance.map.tileWorldUnits

  const entity: StaffEntity = {
    id,
    kind: 'staff',
    x: (spawn.tx + 0.5) * units,
    y: (spawn.ty + 0.5) * units,
    tx: spawn.tx,
    ty: spawn.ty,
    staff: {
      defId,
      name,
      officeRoomId,
      assignedAreaId: 0,
      pinnedTile: NO_PIN,
      duty: { kind: 'idle' },
      wanderCooldown: 0,
      needs: new Float32Array(world.data.needs.size),
      breakPending: false,
      breakCooldownMinutes: 0,
    },
  }
  world.staff.add(entity)
  if (def.hireCost > 0) {
    if (world.economy !== undefined) {
      world.economy.debit(tick, 'hire', def.hireCost, `Hired ${def.name}`, id)
    } else {
      world.addSpend(def.hireCost)
    }
  }

  if (officeRoomId !== NO_ROOM) {
    const displayName = `${def.name}'s Office`
    world.offices.claim(officeRoomId, id, displayName)
    events.emit({
      tick,
      kind: STAFF_EVENTS.officeClaimed,
      causeIds: [],
      data: {
        staffId: id,
        roomId: officeRoomId,
        displayName,
        defId,
      },
    })
  }

  events.emit({
    tick,
    kind: STAFF_EVENTS.hired,
    causeIds: [],
    data: {
      staffId: id,
      defId,
      hireCost: def.hireCost,
      hourlyWage: def.hourlyWage,
      officeRoomId,
      name,
    },
  })

  return { entity }
}

export function fireStaff(
  world: StaffWorldView,
  staffId: number,
  events: EventSink,
  tick: number,
): boolean {
  const entity = world.staff.remove(staffId)
  if (entity === undefined) return false
  world.offices.releaseStaff(staffId)
  world.morale?.clearStaff(staffId)
  for (const job of world.escorts.active()) {
    if (job.claimedBy !== staffId) continue
    job.state = 'queued'
    job.claimedBy = NO_STAFF
  }
  events.emit({
    tick,
    kind: STAFF_EVENTS.fired,
    causeIds: [],
    data: { staffId, defId: entity.staff.defId },
  })
  return true
}

function rejectHire(events: EventSink, tick: number, defId: string, reason: HireRejection): void {
  events.emit({
    tick,
    kind: STAFF_EVENTS.hireRejected,
    causeIds: [],
    data: { defId, reason },
  })
}

function findFreeOffice(world: StaffWorldView): number | undefined {
  for (const room of world.rooms.all()) {
    if (room.defId !== 'office') continue
    const status = world.rooms.statusOf(room.id)
    if (status === undefined || !status.functional) continue
    if (world.offices.isClaimed(room.id)) continue
    return room.id
  }
  return undefined
}

function resolveSpawn(
  world: StaffWorldView,
  tx: number | undefined,
  ty: number | undefined,
  officeRoomId: number,
): { readonly tx: number; readonly ty: number } {
  if (tx !== undefined && ty !== undefined) return { tx, ty }
  if (officeRoomId !== NO_ROOM) {
    for (const room of world.rooms.all()) {
      if (room.id !== officeRoomId) continue
      const tile = room.tiles[0]
      if (tile === undefined) break
      const { x, y } = world.grid.xy(tile)
      return { tx: x, ty: y }
    }
  }
  const mid = Math.floor(world.grid.size / 2)
  return { tx: mid, ty: mid }
}

/* -------------------------------------------------------------------------- */
/* Escorts                                                                     */
/* -------------------------------------------------------------------------- */

export interface EnqueueEscortOptions {
  readonly world: StaffWorldView
  readonly inmateId: number
  readonly destinationTile: number
  readonly purpose: EscortPurpose
  readonly events: EventSink
  readonly tick: number
}

export function enqueueEscort(options: EnqueueEscortOptions): EscortJob | undefined {
  if (options.inmateId === NO_INMATE) return undefined
  const job = options.world.escorts.enqueue({
    inmateId: options.inmateId,
    destinationTile: options.destinationTile,
    purpose: options.purpose,
  })
  options.events.emit({
    tick: options.tick,
    kind: STAFF_EVENTS.escortQueued,
    causeIds: [],
    data: {
      jobId: job.id,
      inmateId: job.inmateId,
      destinationTile: job.destinationTile,
      purpose: job.purpose,
    },
  })
  return job
}

/* -------------------------------------------------------------------------- */
/* Capabilities / doors                                                        */
/* -------------------------------------------------------------------------- */

export function staffDefOf(data: GameData, entity: StaffEntity): StaffDef | undefined {
  return data.staff.find(entity.staff.defId)
}

export function hasCapability(
  data: GameData,
  entity: StaffEntity,
  capability: StaffCapability,
): boolean {
  const def = staffDefOf(data, entity)
  return def !== undefined && def.capabilities.includes(capability)
}

/**
 * Unlocks a locked door and refreshes passability. Used by officers with
 * `openDoors` so escorted inmates (and anyone waiting) can cross secure gates.
 */
export function openDoorAt(
  world: ConstructionWorld,
  data: GameData,
  tileIndex: number,
  events: EventSink,
  tick: number,
  staffId: number,
): boolean {
  const door = world.doors.get(tileIndex)
  if (door === undefined || !door.locked) return false
  const def = data.doors.find(door.type)
  if (def === undefined || !def.lockable) return false
  world.doors.setLocked(tileIndex, false)
  refreshPassability(world, data, tileIndex)
  world.structureChanged(tileIndex)
  events.emit({
    tick,
    kind: STAFF_EVENTS.doorOpened,
    causeIds: [],
    data: {
      staffId,
      tileIndex,
      doorType: door.type,
      secure: def.secure,
    },
  })
  return true
}

/** True when an inmate may not enter this tile without staff assistance. */
export function inmateBlockedByLockedSecure(
  world: ConstructionWorld,
  data: GameData,
  tileIndex: number,
): boolean {
  const door = world.doors.get(tileIndex)
  if (door === undefined || !door.locked) return false
  const def = data.doors.find(door.type)
  if (def === undefined) return false
  return def.secure
}

/** Passability test for staff stepping (may open locked doors first). */
export function staffMayEnter(
  world: ConstructionWorld,
  data: GameData,
  tileIndex: number,
  canOpenDoors: boolean,
): boolean {
  const pass = world.grid.passability[tileIndex] ?? 0
  if ((pass & PASSABILITY.WALKABLE) !== 0) return true
  if (!canOpenDoors) return false
  const door = world.doors.get(tileIndex)
  if (door === undefined || !door.locked) return false
  const def = data.doors.find(door.type)
  return def !== undefined && def.lockable
}
