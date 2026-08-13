/**
 * `JobAssignmentSystem`: claim work for idle eligible agents (T3.2, PRD 4.4 slot 3).
 *
 * Runs once per in-game minute. Each update:
 *   1. Abandons claimed jobs interrupted by riot, lockdown, or injury.
 *   2. Offers open jobs to idle eligible staff / reserved inmates, scoring
 *      each pair by aged `priority / travelTime`.
 *   3. Greedily assigns without duplicate claims (one job per agent, one
 *      agent per job).
 *
 * Escort jobs from T2.7 still live on `EscortJobQueue` until a later ticket
 * migrates them onto this pool; this system owns every other v1 job kind.
 */

import { TICKS_PER_MINUTE } from '../core/clock'
import type { System, SystemContext } from '../core/simulation'
import type { GameData } from '../data/loader'
import type { LabourAssignment, StaffCapability, StatusEffectId } from '../data/schemas'
import {
  JOB_EVENTS,
  NO_CLAIMANT,
  emitJobAbandoned,
  emitJobClaimed,
  emitJobEnqueued,
  jobAssignmentScore,
  type Job,
  type JobAbandonReason,
  type JobClaimantKind,
  type JobKind,
} from '../entities/job'
import type { InmateEntity } from '../entities/inmate'
import { hasCapability, type StaffEntity } from '../entities/staff'
import { isInmateWorld } from './intakeSystem'
import type { InmateWorld } from './intakeSystem'
import { isStaffAvailableForWork } from './staffNeedsSystem'

/* -------------------------------------------------------------------------- */
/* System                                                                      */
/* -------------------------------------------------------------------------- */

export interface JobSystemOptions {
  readonly data: GameData
}

export const JOB_SYSTEM_NAME = 'jobAssignment'

/** PRD 4.4: Job assignment runs once an in-game minute. */
export const JOB_SYSTEM_PERIOD = TICKS_PER_MINUTE

/** Status effects that force an agent to drop their claim. */
const INJURY_STATUSES: ReadonlySet<StatusEffectId> = new Set([
  'bleeding',
  'stunned',
  'overdosed',
  'sick',
])

export function createJobSystem(options: JobSystemOptions): System {
  const { data } = options
  let reportedWrongWorld = false

  return {
    name: JOB_SYSTEM_NAME,
    period: JOB_SYSTEM_PERIOD,

    update(context: SystemContext): void {
      const tick = context.clock.tick
      if (!isInmateWorld(context.world)) {
        if (reportedWrongWorld) return
        reportedWrongWorld = true
        context.events.emit({
          tick,
          kind: JOB_EVENTS.cancelled,
          causeIds: [],
          data: { command: JOB_SYSTEM_NAME, reason: 'wrong-world' },
        })
        return
      }

      const world = context.world
      processAbandonments(world, data, context)
      if (!world.riotActive && !world.lockdownActive) {
        assignJobs(world, data, context)
      }
      world.jobs.pruneTerminal()
    },
  }
}

/* -------------------------------------------------------------------------- */
/* Public helpers (tests + logistics producers)                                */
/* -------------------------------------------------------------------------- */

export interface PostJobOptions {
  readonly world: InmateWorld
  readonly kind: JobKind
  readonly priority: number
  readonly location: number
  readonly tick: number
  readonly events: SystemContext['events']
  readonly requiredRole?: StaffCapability | LabourAssignment
  readonly reservedFor?: LabourAssignment | true
}

/** Enqueues a job and emits `job.enqueued`. */
export function postJob(options: PostJobOptions): Job {
  const job = options.world.jobs.enqueue({
    kind: options.kind,
    priority: options.priority,
    location: options.location,
    tick: options.tick,
    ...(options.requiredRole === undefined ? {} : { requiredRole: options.requiredRole }),
    ...(options.reservedFor === undefined ? {} : { reservedFor: options.reservedFor }),
  })
  emitJobEnqueued(options.events, options.tick, job)
  return job
}

/**
 * Completes a claimed job and clears staff duty when the claimant was staff.
 * Logistics systems call this when the work finishes.
 */
export function completeJob(
  world: InmateWorld,
  jobId: number,
  events: SystemContext['events'],
  tick: number,
): boolean {
  const before = world.jobs.get(jobId)
  if (before === undefined || before.state !== 'claimed') return false
  const claimantKind = before.claimantKind
  const agentId = before.claimedBy
  const job = world.jobs.complete(jobId)
  if (job === undefined) return false
  if (claimantKind === 'staff' && agentId !== NO_CLAIMANT) {
    clearStaffJobDuty(world, agentId)
  }
  events.emit({
    tick,
    kind: JOB_EVENTS.completed,
    subjectId: job.id,
    causeIds: agentId === NO_CLAIMANT ? [] : [agentId],
    data: { jobId: job.id, kind: job.kind, claimantKind, agentId },
  })
  return true
}

/* -------------------------------------------------------------------------- */
/* Abandonment                                                                 */
/* -------------------------------------------------------------------------- */

function processAbandonments(world: InmateWorld, data: GameData, context: SystemContext): void {
  const tick = context.clock.tick
  const globalReason: JobAbandonReason | null = world.riotActive
    ? 'riot'
    : world.lockdownActive
      ? 'lockdown'
      : null

  for (const job of world.jobs.claimed()) {
    const reason = abandonmentReason(world, data, job, globalReason)
    if (reason === null) continue
    const agentId = job.claimedBy
    const claimantKind = job.claimantKind
    const abandoned = world.jobs.abandon(job.id, tick)
    if (abandoned === undefined) continue
    if (claimantKind === 'staff') clearStaffJobDuty(world, agentId)
    emitJobAbandoned(context.events, tick, abandoned, reason, agentId, claimantKind)
  }
}

function abandonmentReason(
  world: InmateWorld,
  _data: GameData,
  job: Job,
  globalReason: JobAbandonReason | null,
): JobAbandonReason | null {
  if (globalReason !== null) return globalReason
  if (job.claimantKind === null || job.claimedBy === NO_CLAIMANT) return 'agentMissing'

  if (job.claimantKind === 'staff') {
    const staff = world.staff.get(job.claimedBy)
    if (staff === undefined) return 'agentMissing'
    return null
  }

  const inmate = world.inmates.get(job.claimedBy)
  if (inmate === undefined) return 'agentMissing'
  if (inmate.inmate.status.some((status) => INJURY_STATUSES.has(status))) {
    return 'injured'
  }
  return null
}

/* -------------------------------------------------------------------------- */
/* Assignment                                                                  */
/* -------------------------------------------------------------------------- */

interface Candidate {
  readonly jobId: number
  readonly agentId: number
  readonly claimantKind: JobClaimantKind
  readonly score: number
}

function assignJobs(world: InmateWorld, data: GameData, context: SystemContext): void {
  const open = world.jobs.open()
  if (open.length === 0) return

  const tick = context.clock.tick
  const aging = data.balance.jobs
  const mapSize = world.grid.size
  const candidates: Candidate[] = []

  const idleStaff = collectIdleStaff(world, data)
  const idleLabour = collectIdleLabour(world)

  for (const job of open) {
    if (job.reservedFor !== null) {
      for (const inmate of idleLabour) {
        if (inmate.inmate.jobId !== job.reservedFor) continue
        candidates.push({
          jobId: job.id,
          agentId: inmate.id,
          claimantKind: 'inmate',
          score: jobAssignmentScore(job, tick, inmate.tx, inmate.ty, mapSize, aging),
        })
      }
      continue
    }

    for (const staff of idleStaff) {
      if (!hasCapability(data, staff, job.requiredRole as StaffCapability)) continue
      candidates.push({
        jobId: job.id,
        agentId: staff.id,
        claimantKind: 'staff',
        score: jobAssignmentScore(job, tick, staff.tx, staff.ty, mapSize, aging),
      })
    }
  }

  candidates.sort(compareCandidates)

  const takenJobs = new Set<number>()
  const takenAgents = new Set<string>()

  for (const candidate of candidates) {
    if (takenJobs.has(candidate.jobId)) continue
    const agentKey = `${candidate.claimantKind}:${candidate.agentId}`
    if (takenAgents.has(agentKey)) continue
    if (!world.jobs.isIdle(candidate.claimantKind, candidate.agentId)) continue

    if (!world.jobs.claim(candidate.jobId, candidate.claimantKind, candidate.agentId)) {
      continue
    }

    takenJobs.add(candidate.jobId)
    takenAgents.add(agentKey)

    if (candidate.claimantKind === 'staff') {
      const staff = world.staff.get(candidate.agentId)
      if (staff !== undefined) {
        staff.staff.duty = { kind: 'job', jobId: candidate.jobId }
      }
    }

    const job = world.jobs.get(candidate.jobId)
    if (job !== undefined) {
      emitJobClaimed(context.events, tick, job, candidate.claimantKind, candidate.agentId)
    }
  }
}

function compareCandidates(a: Candidate, b: Candidate): number {
  if (a.score !== b.score) return b.score - a.score
  if (a.jobId !== b.jobId) return a.jobId - b.jobId
  if (a.claimantKind !== b.claimantKind) {
    return a.claimantKind === 'staff' ? -1 : 1
  }
  return a.agentId - b.agentId
}

function collectIdleStaff(world: InmateWorld, data: GameData): StaffEntity[] {
  return world.staff.all().filter((staff) => {
    if (!world.jobs.isIdle('staff', staff.id)) return false
    if (!isStaffAvailableForWork(world, data, staff)) return false
    const duty = staff.staff.duty.kind
    if (duty === 'escort' || duty === 'incident' || duty === 'job' || duty === 'break') {
      return false
    }
    const def = data.staff.find(staff.staff.defId)
    if (def === undefined) return false
    return def.capabilities.some((cap) => WORK_CAPABILITIES.has(cap))
  })
}

function collectIdleLabour(world: InmateWorld): InmateEntity[] {
  return world.inmates.all().filter((inmate) => {
    if (inmate.inmate.jobId === null) return false
    if (inmate.inmate.status.some((status) => INJURY_STATUSES.has(status))) return false
    return world.jobs.isIdle('inmate', inmate.id)
  })
}

const WORK_CAPABILITIES: ReadonlySet<StaffCapability> = new Set([
  'build',
  'clean',
  'cleanOutdoors',
  'cook',
  'serve',
  'escort',
  'search',
  'repair',
  'treat',
  'driveTruck',
])

function clearStaffJobDuty(world: InmateWorld, staffId: number): void {
  const staff = world.staff.get(staffId)
  if (staff === undefined) return
  if (staff.staff.duty.kind === 'job') {
    staff.staff.duty = { kind: 'idle' }
  }
}
