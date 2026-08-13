/**
 * Jobs: claimable work offered to staff or reserved inmate labour (T3.2).
 *
 * A job is a work order in the pool — not yet the logistics chains that create
 * them (T3.3+). Assignment scores open jobs for idle eligible agents by
 * `agedPriority / travelTime` so nearby high-priority work wins, while aging
 * prevents permanent starvation of low-priority jobs.
 */

import type { Fnv1aHasher } from '../core/hash'
import type { EventSink } from '../core/simulation'
import type { LabourAssignment, StaffCapability } from '../data/schemas'
import { LABOUR_ASSIGNMENTS, STAFF_CAPABILITIES } from '../data/schemas'

/* -------------------------------------------------------------------------- */
/* Identity                                                                    */
/* -------------------------------------------------------------------------- */

/** `claimedBy` 0 and missing lookups mean "unclaimed". */
export const NO_CLAIMANT = 0

/** Soft ceiling so ids stay JSON- and snapshot-friendly. */
export const MAX_JOB_ID = 0xffff_ffff

export const JOB_EVENTS = {
  enqueued: 'job.enqueued',
  claimed: 'job.claimed',
  abandoned: 'job.abandoned',
  completed: 'job.completed',
  cancelled: 'job.cancelled',
} as const

export const JOB_KINDS = [
  'build',
  'deliver',
  'clean',
  'cook',
  'serve',
  'wash',
  'iron',
  'escort',
  'search',
  'repair',
  'treat',
  'collectRefuse',
  'harvest',
  'manufacture',
] as const

export type JobKind = (typeof JOB_KINDS)[number]

export const JOB_STATES = ['open', 'claimed', 'completed', 'cancelled'] as const
export type JobState = (typeof JOB_STATES)[number]

export type JobClaimantKind = 'staff' | 'inmate'

export type JobAbandonReason = 'riot' | 'lockdown' | 'injured' | 'agentMissing'

/**
 * Who may claim the job when it is open to staff, or which labour assignment
 * an inmate must hold when the job is reserved.
 */
export type JobRequiredRole = StaffCapability | LabourAssignment

/* -------------------------------------------------------------------------- */
/* Role tables                                                                 */
/* -------------------------------------------------------------------------- */

/** Default staff capability for each job kind when the job is open to staff. */
export const JOB_KIND_STAFF_ROLE: Readonly<Record<JobKind, StaffCapability>> = {
  build: 'build',
  deliver: 'build',
  clean: 'clean',
  cook: 'cook',
  serve: 'serve',
  wash: 'clean',
  iron: 'clean',
  escort: 'escort',
  search: 'search',
  repair: 'repair',
  treat: 'treat',
  collectRefuse: 'clean',
  harvest: 'cleanOutdoors',
  manufacture: 'repair',
}

/**
 * Labour assignment that can perform each job kind when the job is reserved
 * for inmate work. Kinds with no entry are staff-only in v1.
 */
export const JOB_KIND_LABOUR: Readonly<Partial<Record<JobKind, LabourAssignment>>> = {
  cook: 'kitchen',
  serve: 'kitchen',
  wash: 'laundry',
  iron: 'laundry',
  clean: 'cleaning',
  collectRefuse: 'cleaning',
  manufacture: 'workshop',
  harvest: 'grove',
}

const STAFF_ROLE_SET: ReadonlySet<string> = new Set(STAFF_CAPABILITIES)
const LABOUR_SET: ReadonlySet<string> = new Set(LABOUR_ASSIGNMENTS)

export function isJobKind(value: string): value is JobKind {
  return (JOB_KINDS as readonly string[]).includes(value)
}

export function isStaffRequiredRole(role: JobRequiredRole): role is StaffCapability {
  return STAFF_ROLE_SET.has(role)
}

export function isLabourRequiredRole(role: JobRequiredRole): role is LabourAssignment {
  return LABOUR_SET.has(role)
}

/* -------------------------------------------------------------------------- */
/* Component                                                                   */
/* -------------------------------------------------------------------------- */

export interface Job {
  readonly id: number
  kind: JobKind
  /** Base priority. Effective priority grows with age (see `effectivePriority`). */
  priority: number
  /** Work-site tile index. */
  location: number
  requiredRole: JobRequiredRole
  /**
   * When set, only inmates whose labour assignment (`inmate.jobId`) matches
   * may claim. When null, the job is open to staff with `requiredRole`.
   */
  reservedFor: LabourAssignment | null
  claimedBy: number
  claimantKind: JobClaimantKind | null
  state: JobState
  /** Tick when the job last became `open` (enqueue or requeue after abandon). */
  enqueuedAt: number
}

export interface EnqueueJobOptions {
  readonly kind: JobKind
  readonly priority: number
  readonly location: number
  readonly tick: number
  /** Defaults from {@link JOB_KIND_STAFF_ROLE} / {@link JOB_KIND_LABOUR}. */
  readonly requiredRole?: JobRequiredRole
  /**
   * Reserve for inmate labour. When `true`, uses {@link JOB_KIND_LABOUR} for
   * the kind (errors if the kind has no labour mapping). When a labour id,
   * reserves for that assignment.
   */
  readonly reservedFor?: LabourAssignment | true
}

/* -------------------------------------------------------------------------- */
/* Pool                                                                        */
/* -------------------------------------------------------------------------- */

/**
 * All outstanding work orders. Claim exclusivity is enforced here: an agent
 * appears in at most one claim, and a job has at most one claimant.
 */
export class JobPool {
  readonly #jobs = new Map<number, Job>()
  /** agentKey → jobId for the reverse claim index. */
  readonly #claims = new Map<string, number>()
  #nextId = 1

  get size(): number {
    return this.#jobs.size
  }

  get nextId(): number {
    return this.#nextId
  }

  get(jobId: number): Job | undefined {
    return this.#jobs.get(jobId)
  }

  all(): Job[] {
    const jobs = [...this.#jobs.values()]
    jobs.sort((a, b) => a.id - b.id)
    return jobs
  }

  open(): Job[] {
    return this.all().filter((job) => job.state === 'open')
  }

  claimed(): Job[] {
    return this.all().filter((job) => job.state === 'claimed')
  }

  /** Job currently claimed by this agent, if any. */
  claimOf(kind: JobClaimantKind, agentId: number): Job | undefined {
    const jobId = this.#claims.get(claimKey(kind, agentId))
    if (jobId === undefined) return undefined
    return this.#jobs.get(jobId)
  }

  isIdle(kind: JobClaimantKind, agentId: number): boolean {
    return !this.#claims.has(claimKey(kind, agentId))
  }

  enqueue(options: EnqueueJobOptions): Job {
    const id = this.#nextId
    if (id > MAX_JOB_ID) {
      throw new Error('job id space exhausted')
    }
    this.#nextId += 1

    let reservedFor: LabourAssignment | null = null
    let requiredRole = options.requiredRole

    if (options.reservedFor === true) {
      const labour = JOB_KIND_LABOUR[options.kind]
      if (labour === undefined) {
        throw new Error(`job kind '${options.kind}' cannot be reserved for inmate labour`)
      }
      reservedFor = labour
      requiredRole = requiredRole ?? labour
    } else if (options.reservedFor !== undefined) {
      reservedFor = options.reservedFor
      requiredRole = requiredRole ?? options.reservedFor
    } else {
      requiredRole = requiredRole ?? JOB_KIND_STAFF_ROLE[options.kind]
    }

    const job: Job = {
      id,
      kind: options.kind,
      priority: options.priority,
      location: options.location,
      requiredRole,
      reservedFor,
      claimedBy: NO_CLAIMANT,
      claimantKind: null,
      state: 'open',
      enqueuedAt: options.tick,
    }
    this.#jobs.set(id, job)
    return job
  }

  /**
   * Claims `jobId` for the agent. Returns false if the job is gone, not open,
   * or the agent already holds a claim.
   */
  claim(jobId: number, kind: JobClaimantKind, agentId: number): boolean {
    if (agentId === NO_CLAIMANT) return false
    const job = this.#jobs.get(jobId)
    if (job === undefined || job.state !== 'open') return false
    const key = claimKey(kind, agentId)
    if (this.#claims.has(key)) return false

    job.state = 'claimed'
    job.claimedBy = agentId
    job.claimantKind = kind
    this.#claims.set(key, jobId)
    return true
  }

  /**
   * Returns a claimed job to the open pool after an interruption. Clears the
   * claim index so the agent may take other work.
   */
  abandon(jobId: number, tick: number): Job | undefined {
    const job = this.#jobs.get(jobId)
    if (job === undefined || job.state !== 'claimed') return undefined
    this.#clearClaim(job)
    job.state = 'open'
    job.claimedBy = NO_CLAIMANT
    job.claimantKind = null
    job.enqueuedAt = tick
    return job
  }

  complete(jobId: number): Job | undefined {
    const job = this.#jobs.get(jobId)
    if (job === undefined || job.state !== 'claimed') return undefined
    this.#clearClaim(job)
    job.state = 'completed'
    job.claimedBy = NO_CLAIMANT
    job.claimantKind = null
    return job
  }

  cancel(jobId: number): Job | undefined {
    const job = this.#jobs.get(jobId)
    if (job === undefined) return undefined
    if (job.state === 'claimed') this.#clearClaim(job)
    job.state = 'cancelled'
    job.claimedBy = NO_CLAIMANT
    job.claimantKind = null
    return job
  }

  remove(jobId: number): Job | undefined {
    const job = this.#jobs.get(jobId)
    if (job === undefined) return undefined
    if (job.state === 'claimed') this.#clearClaim(job)
    this.#jobs.delete(jobId)
    return job
  }

  /** Drops finished jobs so the pool stays bounded. */
  pruneTerminal(): void {
    for (const job of this.all()) {
      if (job.state === 'completed' || job.state === 'cancelled') {
        this.#jobs.delete(job.id)
      }
    }
  }

  hashInto(hasher: Fnv1aHasher): void {
    hasher.writeUint32(this.#nextId)
    hasher.writeUint32(this.#jobs.size)
    for (const job of this.all()) {
      hasher.writeUint32(job.id)
      hasher.writeString(job.kind)
      hasher.writeFloat64(job.priority)
      hasher.writeUint32(job.location)
      hasher.writeString(job.requiredRole)
      hasher.writeString(job.reservedFor ?? '')
      hasher.writeUint32(job.claimedBy)
      hasher.writeString(job.claimantKind ?? '')
      hasher.writeString(job.state)
      hasher.writeUint32(job.enqueuedAt)
    }
  }

  #clearClaim(job: Job): void {
    if (job.claimantKind === null || job.claimedBy === NO_CLAIMANT) return
    this.#claims.delete(claimKey(job.claimantKind, job.claimedBy))
  }
}

function claimKey(kind: JobClaimantKind, agentId: number): string {
  return `${kind}:${agentId}`
}

/* -------------------------------------------------------------------------- */
/* Scoring                                                                     */
/* -------------------------------------------------------------------------- */

export interface JobAgingConfig {
  /** Added to base priority each tick the job has been open. */
  readonly agingPerTick: number
  /** Floor for travel time so a co-located job does not divide by zero. */
  readonly minTravelTime: number
}

/** Priority after starvation-prevention aging. */
export function effectivePriority(job: Job, tick: number, agingPerTick: number): number {
  const age = Math.max(0, tick - job.enqueuedAt)
  return job.priority + age * agingPerTick
}

/** Manhattan tile distance used as travel-time proxy for assignment. */
export function travelTimeTiles(
  fromTx: number,
  fromTy: number,
  toTx: number,
  toTy: number,
  minTravelTime: number,
): number {
  const manhattan = Math.abs(fromTx - toTx) + Math.abs(fromTy - toTy)
  return Math.max(minTravelTime, manhattan)
}

/**
 * Assignment score: `priority * (1 / travelTime)` with aged priority.
 * Higher is better.
 */
export function jobAssignmentScore(
  job: Job,
  tick: number,
  fromTx: number,
  fromTy: number,
  mapSize: number,
  config: JobAgingConfig,
): number {
  const { x: toTx, y: toTy } = tileXy(job.location, mapSize)
  const travel = travelTimeTiles(fromTx, fromTy, toTx, toTy, config.minTravelTime)
  const priority = effectivePriority(job, tick, config.agingPerTick)
  return priority / travel
}

export function tileXy(
  location: number,
  mapSize: number,
): { readonly x: number; readonly y: number } {
  const y = (location / mapSize) | 0
  const x = location - y * mapSize
  return { x, y }
}

/* -------------------------------------------------------------------------- */
/* Events                                                                      */
/* -------------------------------------------------------------------------- */

export function emitJobEnqueued(events: EventSink, tick: number, job: Job): void {
  events.emit({
    tick,
    kind: JOB_EVENTS.enqueued,
    subjectId: job.id,
    causeIds: [],
    data: {
      jobId: job.id,
      kind: job.kind,
      priority: job.priority,
      location: job.location,
      requiredRole: job.requiredRole,
      reservedFor: job.reservedFor,
    },
  })
}

export function emitJobClaimed(
  events: EventSink,
  tick: number,
  job: Job,
  claimantKind: JobClaimantKind,
  agentId: number,
): void {
  events.emit({
    tick,
    kind: JOB_EVENTS.claimed,
    subjectId: job.id,
    causeIds: [agentId],
    data: {
      jobId: job.id,
      kind: job.kind,
      claimantKind,
      agentId,
      location: job.location,
    },
  })
}

export function emitJobAbandoned(
  events: EventSink,
  tick: number,
  job: Job,
  reason: JobAbandonReason,
  agentId: number,
  claimantKind: JobClaimantKind | null,
): void {
  events.emit({
    tick,
    kind: JOB_EVENTS.abandoned,
    subjectId: job.id,
    causeIds: agentId === NO_CLAIMANT ? [] : [agentId],
    data: {
      jobId: job.id,
      kind: job.kind,
      reason,
      agentId,
      claimantKind,
    },
  })
}
