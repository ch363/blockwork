/**
 * `StaffSystem`: hire duties, escorts, fog and door assistance (T2.7).
 *
 * Runs every tick. Idle officers with `escort` claim queued escort jobs;
 * claimed jobs walk the officer to the inmate, then both to the destination.
 * Officers also clear fog in a radius, unlock locked secure doors for inmates
 * within `doorOpenRadiusTiles`, and wander when idle. Wages are paid by
 * `EconomySystem` (T3.6).
 *
 * Incident response is a stub until SecuritySystem (T4.x) posts incidents:
 * officers with nothing else to do ignore an empty incident list.
 */

import { isJsonArray } from '../core/commands'
import type { Command, JsonValue } from '../core/commands'
import type { CommandHandler, System, SystemContext } from '../core/simulation'
import type { GameData } from '../data/loader'
import {
  ACCESS,
} from '../pathfinding/regionGraph'
import { tilePassableForAccess } from '../pathfinding/flowField'
import {
  NO_PIN,
  STAFF_EVENTS,
  enqueueEscort,
  fireStaff,
  hasCapability,
  hireStaff,
  inmateBlockedByLockedSecure,
  openDoorAt,
  staffMayEnter,
  type EscortJob,
  type EscortPurpose,
  type StaffEntity,
  type StaffWorldView,
} from '../entities/staff'
import { NO_INMATE } from '../entities/inmate'
import { PASSABILITY } from '../world/tileGrid'

import { isInmateWorld } from './intakeSystem'
import type { InmateWorld } from './intakeSystem'
import {
  isEmergencyStaff,
  isStaffAvailableForWork,
  movementSpeedMultiplier,
} from './staffNeedsSystem'

/* -------------------------------------------------------------------------- */
/* System                                                                      */
/* -------------------------------------------------------------------------- */

export interface StaffSystemOptions {
  readonly data: GameData
}

export const STAFF_SYSTEM_NAME = 'staff'

/** Every tick: escorts and fog need per-tick progress. */
export const STAFF_SYSTEM_PERIOD = 1

export function createStaffSystem(options: StaffSystemOptions): System {
  const { data } = options
  let reportedWrongWorld = false

  return {
    name: STAFF_SYSTEM_NAME,
    period: STAFF_SYSTEM_PERIOD,

    update(context: SystemContext): void {
      const tick = context.clock.tick
      if (!isInmateWorld(context.world)) {
        if (reportedWrongWorld) return
        reportedWrongWorld = true
        context.events.emit({
          tick,
          kind: STAFF_EVENTS.hireRejected,
          causeIds: [],
          data: { command: STAFF_SYSTEM_NAME, reason: 'wrong-world' },
        })
        return
      }

      const world = context.world

      claimEscortJobs(world, data, context)
      progressEscorts(world, data, context)
      assistSecureDoors(world, data, context)
      revealFog(world, data)
      wanderOfficers(world, data, context)
      world.escorts.pruneTerminal()
    },
  }
}

/* -------------------------------------------------------------------------- */
/* Escort assignment                                                           */
/* -------------------------------------------------------------------------- */

function claimEscortJobs(world: InmateWorld, data: GameData, context: SystemContext): void {
  const queued = world.escorts.queued()
  if (queued.length === 0) return

  const idle = world.staff
    .withCapability(data, 'escort')
    .filter(
      (officer) =>
        officer.staff.duty.kind === 'idle' && isStaffAvailableForWork(world, data, officer),
    )
  let officerIndex = 0
  for (const job of queued) {
    if (officerIndex >= idle.length) break
    const officer = idle[officerIndex]
    officerIndex += 1
    if (officer === undefined) break
    if (world.inmates.get(job.inmateId) === undefined) {
      job.state = 'aborted'
      context.events.emit({
        tick: context.clock.tick,
        kind: STAFF_EVENTS.escortAborted,
        causeIds: [],
        data: { jobId: job.id, reason: 'inmate-missing' },
      })
      continue
    }
    job.state = 'approach_inmate'
    job.claimedBy = officer.id
    job.path = null
    job.pathIndex = 0
    officer.staff.duty = { kind: 'escort', jobId: job.id }
    context.events.emit({
      tick: context.clock.tick,
      kind: STAFF_EVENTS.escortClaimed,
      causeIds: [],
      data: { jobId: job.id, staffId: officer.id, inmateId: job.inmateId },
    })
  }
}

function progressEscorts(world: InmateWorld, data: GameData, context: SystemContext): void {
  const pickup = data.balance.staff.escortPickupTiles
  const staffSpeed =
    data.balance.pathfinding.speedsWorldUnitsPerTick.staff *
    movementSpeedMultiplier(world.morale.value, data.balance.morale)
  const inmateSpeed = data.balance.pathfinding.speedsWorldUnitsPerTick.inmate
  const units = data.balance.map.tileWorldUnits

  for (const job of world.escorts.active()) {
    const officer = world.staff.get(job.claimedBy)
    const inmate = world.inmates.get(job.inmateId)
    if (officer === undefined || inmate === undefined) {
      abortEscort(job, context, 'missing-agent', officer)
      continue
    }
    if (world.morale.striking && !isEmergencyStaff(data, officer)) {
      abortEscort(job, context, 'strike', officer)
      continue
    }

    if (job.state === 'approach_inmate') {
      stepEntityToward(
        world,
        data,
        officer,
        inmate.tx,
        inmate.ty,
        staffSpeed,
        units,
        officer.id,
        context,
        job,
      )
      if (chebyshev(officer.tx, officer.ty, inmate.tx, inmate.ty) <= pickup) {
        job.state = 'escort_to_destination'
        job.path = null
        job.pathIndex = 0
      }
      continue
    }

    // escort_to_destination
    const { x: destTx, y: destTy } = world.grid.xy(job.destinationTile)
    const officerArrived = officer.tx === destTx && officer.ty === destTy
    if (!officerArrived) {
      stepEntityToward(
        world,
        data,
        officer,
        destTx,
        destTy,
        staffSpeed,
        units,
        officer.id,
        context,
        job,
      )
    }
    // Inmate follows the officer (or walks to destination once nearby).
    const followTx = officerArrived ? destTx : officer.tx
    const followTy = officerArrived ? destTy : officer.ty
    stepEntityToward(
      world,
      data,
      inmate,
      followTx,
      followTy,
      inmateSpeed,
      units,
      undefined,
      context,
      undefined,
    )

    if (inmate.tx === destTx && inmate.ty === destTy) {
      completeEscort(job, officer, context)
    }
  }
}

function completeEscort(
  job: EscortJob,
  officer: StaffEntity,
  context: SystemContext,
): void {
  job.state = 'completed'
  officer.staff.duty = { kind: 'idle' }
  context.events.emit({
    tick: context.clock.tick,
    kind: STAFF_EVENTS.escortCompleted,
    causeIds: [],
    data: {
      jobId: job.id,
      staffId: officer.id,
      inmateId: job.inmateId,
      purpose: job.purpose,
      destinationTile: job.destinationTile,
    },
  })
}

function abortEscort(
  job: EscortJob,
  context: SystemContext,
  reason: string,
  officer?: StaffEntity,
): void {
  if (officer !== undefined) officer.staff.duty = { kind: 'idle' }
  job.state = 'aborted'
  job.claimedBy = 0
  context.events.emit({
    tick: context.clock.tick,
    kind: STAFF_EVENTS.escortAborted,
    causeIds: [],
    data: { jobId: job.id, reason },
  })
}

/* -------------------------------------------------------------------------- */
/* Door assistance                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Officers with `openDoors` unlock locked secure doors near waiting inmates.
 * Without any such officer, inmates stay blocked — the acceptance case for
 * "remove all officers ⇒ no inmate passes a locked secure door".
 */
function assistSecureDoors(world: InmateWorld, data: GameData, context: SystemContext): void {
  const radius = data.balance.staff.doorOpenRadiusTiles
  const officers = world.staff
    .withCapability(data, 'openDoors')
    .filter((officer) => hasCapability(data, officer, 'openDoors'))

  if (officers.length === 0) return

  for (const inmate of world.inmates.all()) {
    for (const [dx, dy] of NEIGHBOURS) {
      const nx = inmate.tx + dx
      const ny = inmate.ty + dy
      if (nx < 0 || ny < 0 || nx >= world.grid.size || ny >= world.grid.size) continue
      const tile = world.grid.idx(nx, ny)
      if (!inmateBlockedByLockedSecure(world, data, tile)) continue

      const helper = nearestOfficer(officers, inmate.tx, inmate.ty, radius)
      if (helper === undefined) continue
      openDoorAt(world, data, tile, context.events, context.clock.tick, helper.id)
    }
  }

  // Escorts: open the next locked secure door on the officer's path.
  for (const officer of officers) {
    if (officer.staff.duty.kind !== 'escort') continue
    for (const [dx, dy] of NEIGHBOURS) {
      const nx = officer.tx + dx
      const ny = officer.ty + dy
      if (nx < 0 || ny < 0 || nx >= world.grid.size || ny >= world.grid.size) continue
      const tile = world.grid.idx(nx, ny)
      if (!inmateBlockedByLockedSecure(world, data, tile)) continue
      openDoorAt(world, data, tile, context.events, context.clock.tick, officer.id)
    }
  }
}

function nearestOfficer(
  officers: readonly StaffEntity[],
  tx: number,
  ty: number,
  radius: number,
): StaffEntity | undefined {
  let best: StaffEntity | undefined
  let bestDist = radius + 1
  for (const officer of officers) {
    const dist = chebyshev(officer.tx, officer.ty, tx, ty)
    if (dist > radius) continue
    if (dist < bestDist) {
      best = officer
      bestDist = dist
    }
  }
  return best
}

/* -------------------------------------------------------------------------- */
/* Fog + wander                                                                */
/* -------------------------------------------------------------------------- */

function revealFog(world: InmateWorld, data: GameData): void {
  const radius = data.balance.staff.fogRadiusTiles
  for (const officer of world.staff.withCapability(data, 'patrol')) {
    world.fog.revealAround(officer.tx, officer.ty, radius)
  }
  // Administrators and other staff also clear fog where they stand — smaller
  // presence, same radius so the player is never blind at a hired desk.
  for (const staff of world.staff.all()) {
    if (hasCapability(data, staff, 'patrol')) continue
    world.fog.revealAround(staff.tx, staff.ty, Math.max(1, Math.floor(radius / 2)))
  }
}

function wanderOfficers(world: InmateWorld, data: GameData, context: SystemContext): void {
  const period = data.balance.staff.wanderPeriodTicks
  const radius = data.balance.staff.wanderRadiusTiles
  const speed =
    data.balance.pathfinding.speedsWorldUnitsPerTick.staff *
    movementSpeedMultiplier(world.morale.value, data.balance.morale)
  const units = data.balance.map.tileWorldUnits
  const rng = context.rng.stream('staff')

  for (const officer of world.staff.withCapability(data, 'patrol')) {
    if (!isStaffAvailableForWork(world, data, officer)) continue
    // A pinned officer stands where the player put them (T4.1); a posted or
    // patrolling one is already deployed. Wandering off any of those would
    // undo the deployment the same tick it was decided.
    if (officer.staff.pinnedTile !== NO_PIN) continue
    if (
      officer.staff.duty.kind === 'escort' ||
      officer.staff.duty.kind === 'incident' ||
      officer.staff.duty.kind === 'job' ||
      officer.staff.duty.kind === 'break' ||
      officer.staff.duty.kind === 'post' ||
      officer.staff.duty.kind === 'patrol'
    ) {
      continue
    }

    if (officer.staff.duty.kind === 'wander') {
      const { goalTx, goalTy } = officer.staff.duty
      if (officer.tx === goalTx && officer.ty === goalTy) {
        officer.staff.duty = { kind: 'idle' }
        officer.staff.wanderCooldown = period
        continue
      }
      stepEntityToward(
        world,
        data,
        officer,
        goalTx,
        goalTy,
        speed,
        units,
        officer.id,
        context,
        undefined,
      )
      continue
    }

    // idle
    if (officer.staff.wanderCooldown > 0) {
      officer.staff.wanderCooldown -= 1
      continue
    }
    const goal = pickWanderTile(world, officer.tx, officer.ty, radius, rng.nextUint32())
    if (goal === undefined) {
      officer.staff.wanderCooldown = period
      continue
    }
    officer.staff.duty = { kind: 'wander', goalTx: goal.tx, goalTy: goal.ty }
  }
}

function pickWanderTile(
  world: InmateWorld,
  tx: number,
  ty: number,
  radius: number,
  seed: number,
): { readonly tx: number; readonly ty: number } | undefined {
  const candidates: { tx: number; ty: number }[] = []
  for (let y = ty - radius; y <= ty + radius; y += 1) {
    for (let x = tx - radius; x <= tx + radius; x += 1) {
      if (x < 0 || y < 0 || x >= world.grid.size || y >= world.grid.size) continue
      if (x === tx && y === ty) continue
      const pass = world.grid.passability[world.grid.idx(x, y)] ?? 0
      if ((pass & PASSABILITY.WALKABLE) === 0) continue
      candidates.push({ tx: x, ty: y })
    }
  }
  if (candidates.length === 0) return undefined
  const pick = candidates[seed % candidates.length]
  return pick
}

/* -------------------------------------------------------------------------- */
/* Movement helpers                                                            */
/* -------------------------------------------------------------------------- */

const NEIGHBOURS: readonly (readonly [number, number])[] = [
  [0, -1],
  [1, 0],
  [0, 1],
  [-1, 0],
]

function chebyshev(ax: number, ay: number, bx: number, by: number): number {
  return Math.max(Math.abs(ax - bx), Math.abs(ay - by))
}

type Mobile = {
  x: number
  y: number
  tx: number
  ty: number
}

/**
 * Advances a mobile entity one tick toward a tile goal. Officers may unlock
 * locked doors on the step; inmates cannot.
 *
 * The next tile is chosen by a short BFS so escorts route around walls into
 * rooms rather than greedily walking into a south wall.
 */
function stepEntityToward(
  world: InmateWorld,
  data: GameData,
  entity: Mobile,
  goalTx: number,
  goalTy: number,
  speed: number,
  tileWorldUnits: number,
  staffId: number | undefined,
  context: SystemContext,
  job: EscortJob | undefined,
): void {
  if (entity.tx === goalTx && entity.ty === goalTy) {
    entity.x = (entity.tx + 0.5) * tileWorldUnits
    entity.y = (entity.ty + 0.5) * tileWorldUnits
    return
  }

  const isStaff = staffId !== undefined
  let next = peekCachedStep(job, world.grid.size, entity.tx, entity.ty)
  if (next === undefined) {
    const path = buildPathBfs(world, data, entity.tx, entity.ty, goalTx, goalTy, isStaff)
    if (job !== undefined) {
      job.path = path
      job.pathIndex = 0
    }
    next = path.length > 0 ? tileFromIndex(path[0] ?? -1, world.grid.size) : undefined
    if (job !== undefined && path.length > 0) job.pathIndex = 1
  }
  if (next === undefined) return

  const nextIndex = world.grid.idx(next.tx, next.ty)
  if (isStaff && staffId !== undefined) {
    if (!tilePassableForAccess(world.grid.passability[nextIndex] ?? 0, ACCESS.STAFF)) {
      if (staffMayEnter(world, data, nextIndex, true)) {
        openDoorAt(world, data, nextIndex, context.events, context.clock.tick, staffId)
      }
    }
  } else {
    const pass = world.grid.passability[nextIndex] ?? 0
    if (!tilePassableForAccess(pass, ACCESS.INMATE)) {
      if (job !== undefined) {
        job.path = null
        job.pathIndex = 0
      }
      return
    }
  }

  const nextCentreX = (next.tx + 0.5) * tileWorldUnits
  const nextCentreY = (next.ty + 0.5) * tileWorldUnits
  moveToward(entity, nextCentreX, nextCentreY, speed)
  snapTile(entity, tileWorldUnits)

  if (
    entity.tx === next.tx &&
    entity.ty === next.ty &&
    Math.hypot(entity.x - nextCentreX, entity.y - nextCentreY) < speed
  ) {
    entity.x = nextCentreX
    entity.y = nextCentreY
  }
}

function peekCachedStep(
  job: EscortJob | undefined,
  size: number,
  tx: number,
  ty: number,
): { readonly tx: number; readonly ty: number } | undefined {
  if (job === undefined || job.path === null) return undefined
  while (job.pathIndex < job.path.length) {
    const tile = job.path[job.pathIndex]
    if (tile === undefined) return undefined
    const step = tileFromIndex(tile, size)
    if (step.tx === tx && step.ty === ty) {
      job.pathIndex += 1
      continue
    }
    // Must be adjacent to current tile; otherwise the cache is stale.
    if (Math.abs(step.tx - tx) + Math.abs(step.ty - ty) !== 1) {
      job.path = null
      job.pathIndex = 0
      return undefined
    }
    return step
  }
  job.path = null
  job.pathIndex = 0
  return undefined
}

function tileFromIndex(
  index: number,
  size: number,
): { readonly tx: number; readonly ty: number } {
  const ty = (index / size) | 0
  const tx = index - ty * size
  return { tx, ty }
}

/**
 * Full 4-connected BFS path from start to goal as tile indices (excluding start).
 */
function buildPathBfs(
  world: InmateWorld,
  data: GameData,
  tx: number,
  ty: number,
  goalTx: number,
  goalTy: number,
  isStaff: boolean,
): number[] {
  if (tx === goalTx && ty === goalTy) return []

  const size = world.grid.size
  const total = size * size
  const start = ty * size + tx
  const goal = goalTy * size + goalTx
  const cameFrom = new Int32Array(total)
  cameFrom.fill(-1)
  const visited = new Uint8Array(total)
  const queue = new Int32Array(total)
  let head = 0
  let tail = 0
  queue[tail] = start
  tail += 1
  visited[start] = 1

  const access = isStaff ? ACCESS.STAFF : ACCESS.INMATE
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
      if (!tileEnterable(world, data, next, access, isStaff)) continue
      visited[next] = 1
      cameFrom[next] = current
      queue[tail] = next
      tail += 1
    }
  }

  if (!found) return []

  const reversed: number[] = []
  let step = goal
  while (step !== start && step !== -1) {
    reversed.push(step)
    step = cameFrom[step] ?? -1
  }
  reversed.reverse()
  return reversed
}

function tileEnterable(
  world: InmateWorld,
  data: GameData,
  tileIndex: number,
  access: number,
  isStaff: boolean,
): boolean {
  const pass = world.grid.passability[tileIndex] ?? 0
  if (tilePassableForAccess(pass, access)) return true
  return isStaff && staffMayEnter(world, data, tileIndex, true)
}

function moveToward(entity: Mobile, targetX: number, targetY: number, speed: number): void {
  const dx = targetX - entity.x
  const dy = targetY - entity.y
  const dist = Math.hypot(dx, dy)
  if (dist <= speed || dist === 0) {
    entity.x = targetX
    entity.y = targetY
    return
  }
  entity.x += (dx / dist) * speed
  entity.y += (dy / dist) * speed
}

function snapTile(entity: Mobile, tileWorldUnits: number): void {
  entity.tx = Math.floor(entity.x / tileWorldUnits)
  entity.ty = Math.floor(entity.y / tileWorldUnits)
}

/* -------------------------------------------------------------------------- */
/* Commands                                                                    */
/* -------------------------------------------------------------------------- */

export const STAFF_COMMANDS = {
  hire: 'staff.hire',
  fire: 'staff.fire',
  enqueueEscort: 'staff.enqueueEscort',
} as const

export function staffCommandHandlers(data: GameData): Readonly<Record<string, CommandHandler>> {
  return {
    [STAFF_COMMANDS.hire]: (command, context) => {
      handleHire(command, context, data)
    },
    [STAFF_COMMANDS.fire]: (command, context) => {
      handleFire(command, context)
    },
    [STAFF_COMMANDS.enqueueEscort]: (command, context) => {
      handleEnqueueEscort(command, context)
    },
  }
}

function handleHire(command: Command, context: SystemContext, _data: GameData): void {
  if (!isInmateWorld(context.world)) {
    reject(context, command, 'wrong-world')
    return
  }
  const defId = readString(command.payload, 'defId')
  if (defId === undefined) {
    reject(context, command, 'malformed-payload')
    return
  }
  const tx = readOptionalInt(command.payload, 'tx')
  const ty = readOptionalInt(command.payload, 'ty')
  hireStaff({
    world: context.world,
    defId,
    events: context.events,
    tick: context.clock.tick,
    ...(tx === undefined ? {} : { tx }),
    ...(ty === undefined ? {} : { ty }),
  })
}

function handleFire(command: Command, context: SystemContext): void {
  if (!isInmateWorld(context.world)) {
    reject(context, command, 'wrong-world')
    return
  }
  const staffId = readOptionalInt(command.payload, 'staffId')
  if (staffId === undefined) {
    reject(context, command, 'malformed-payload')
    return
  }
  if (!fireStaff(context.world, staffId, context.events, context.clock.tick)) {
    reject(context, command, 'unknown-staff')
  }
}

function handleEnqueueEscort(command: Command, context: SystemContext): void {
  if (!isInmateWorld(context.world)) {
    reject(context, command, 'wrong-world')
    return
  }
  const inmateId = readOptionalInt(command.payload, 'inmateId')
  const destinationTile = readOptionalInt(command.payload, 'destinationTile')
  const purposeRaw = readString(command.payload, 'purpose') ?? 'other'
  const purpose = parseEscortPurpose(purposeRaw)
  if (inmateId === undefined || destinationTile === undefined || inmateId === NO_INMATE) {
    reject(context, command, 'malformed-payload')
    return
  }
  if (purpose === undefined) {
    reject(context, command, 'unknown-purpose')
    return
  }
  if (context.world.inmates.get(inmateId) === undefined) {
    reject(context, command, 'unknown-inmate')
    return
  }
  enqueueEscort({
    world: context.world,
    inmateId,
    destinationTile,
    purpose,
    events: context.events,
    tick: context.clock.tick,
  })
}

const ESCORT_PURPOSES: readonly EscortPurpose[] = [
  'cell_assignment',
  'isolation',
  'clinic',
  'program',
  'other',
]

function parseEscortPurpose(value: string): EscortPurpose | undefined {
  return ESCORT_PURPOSES.find((purpose) => purpose === value)
}

function reject(context: SystemContext, command: Command, reason: string): void {
  context.events.emit({
    tick: context.clock.tick,
    kind: STAFF_EVENTS.hireRejected,
    causeIds: [],
    data: { command: command.type, reason },
  })
}

function readString(payload: JsonValue, key: string): string | undefined {
  if (payload === null || typeof payload !== 'object' || isJsonArray(payload)) return undefined
  const value = payload[key]
  return typeof value === 'string' ? value : undefined
}

function readOptionalInt(payload: JsonValue, key: string): number | undefined {
  if (payload === null || typeof payload !== 'object' || isJsonArray(payload)) return undefined
  const value = payload[key]
  if (typeof value !== 'number' || !Number.isInteger(value)) return undefined
  return value
}

/** Compile-time reminder that InmateWorld satisfies the hire view. */
export type _InmateWorldIsStaffView = InmateWorld extends StaffWorldView ? true : false