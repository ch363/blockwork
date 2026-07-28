/**
 * T3.2 — job claim exclusivity, priority ordering, abandonment, aging.
 */

import { describe, expect, it } from 'vitest'

import { TICKS_PER_MINUTE } from '../../src/core/clock'
import { Simulation } from '../../src/core/simulation'
import type { SimulationEvent } from '../../src/core/simulation'
import { loadGameData } from '../../src/data/loader'
import {
  JOB_EVENTS,
  JOB_KINDS,
  JobPool,
  effectivePriority,
  jobAssignmentScore,
} from '../../src/entities/job'
import { hireStaff } from '../../src/entities/staff'
import { createInmateShell, generateInmate } from '../../src/entities/inmate'
import { Rng } from '../../src/core/rng'
import { createInmateWorld } from '../../src/systems/intakeSystem'
import type { InmateWorld } from '../../src/systems/intakeSystem'
import { completeJob, createJobSystem, postJob } from '../../src/systems/jobSystem'

const DATA = loadGameData()
const SEED = 0xb10c_3002

class RecordingSink {
  readonly events: SimulationEvent[] = []
  emit(event: SimulationEvent): void {
    this.events.push(event)
  }
  of(kind: string): SimulationEvent[] {
    return this.events.filter((event) => event.kind === kind)
  }
}

function harness(): {
  readonly world: InmateWorld
  readonly sim: Simulation
  readonly events: RecordingSink
  run(ticks: number): void
} {
  const events = new RecordingSink()
  const world = createInmateWorld({
    size: 40,
    data: DATA,
    continuousIntake: false,
    research: 'all',
  })
  const sim = new Simulation({
    seed: SEED,
    world,
    systems: [createJobSystem({ data: DATA })],
    events,
  })
  return {
    world,
    sim,
    events,
    run(ticks) {
      for (let i = 0; i < ticks; i += 1) sim.step()
    },
  }
}

function hireCleaner(world: InmateWorld, events: RecordingSink, tx: number, ty: number): number {
  const result = hireStaff({
    world,
    defId: 'cleaner',
    events,
    tick: 0,
    tx,
    ty,
  })
  const entity = result.entity
  expect(entity).toBeDefined()
  if (entity === undefined) throw new Error('hireCleaner expected an entity')
  return entity.id
}

function spawnLabourInmate(world: InmateWorld, labour: string, tx: number, ty: number): number {
  const rng = new Rng(SEED).stream('job-test-inmate')
  const component = generateInmate({ data: DATA, rng, category: 'minimum' })
  component.jobId = labour
  const id = world.inmates.allocateId()
  expect(id).toBeGreaterThan(0)
  const entity = createInmateShell({
    id,
    data: DATA,
    inmate: component,
    tx,
    ty,
  })
  world.inmates.add(entity)
  return id
}

describe('JobPool', () => {
  it('lists every v1 job kind', () => {
    expect(JOB_KINDS).toEqual([
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
    ])
  })

  it('enforces claim exclusivity on the pool', () => {
    const pool = new JobPool()
    const a = pool.enqueue({
      kind: 'clean',
      priority: 1,
      location: 10,
      tick: 0,
    })
    const b = pool.enqueue({
      kind: 'clean',
      priority: 1,
      location: 20,
      tick: 0,
    })
    expect(pool.claim(a.id, 'staff', 1)).toBe(true)
    expect(pool.claim(a.id, 'staff', 2)).toBe(false)
    expect(pool.claim(b.id, 'staff', 1)).toBe(false)
    expect(pool.claim(b.id, 'staff', 2)).toBe(true)
    expect(pool.claimOf('staff', 1)?.id).toBe(a.id)
    expect(pool.claimOf('staff', 2)?.id).toBe(b.id)
  })
})

describe('job assignment', () => {
  it('never double-claims across 50 workers and 300 jobs', () => {
    const { world, events, run } = harness()

    for (let i = 0; i < 50; i += 1) {
      hireCleaner(world, events, 2 + (i % 10), 2 + Math.floor(i / 10))
    }
    for (let i = 0; i < 300; i += 1) {
      postJob({
        world,
        kind: 'clean',
        priority: 1 + (i % 5),
        location: world.grid.idx(5 + (i % 20), 5 + (Math.floor(i / 20) % 20)),
        tick: 0,
        events,
      })
    }

    run(TICKS_PER_MINUTE)

    const claimed = world.jobs.claimed()
    expect(claimed.length).toBe(50)

    const claimants = claimed.map((job) => `${job.claimantKind}:${job.claimedBy}`)
    expect(new Set(claimants).size).toBe(claimants.length)
    expect(new Set(claimed.map((job) => job.id)).size).toBe(claimed.length)

    for (const staff of world.staff.all()) {
      const claim = world.jobs.claimOf('staff', staff.id)
      if (claim === undefined) continue
      expect(claim.claimedBy).toBe(staff.id)
      expect(staff.staff.duty).toEqual({ kind: 'job', jobId: claim.id })
    }
  })

  it('prefers higher priority and nearer jobs', () => {
    const { world, events, run } = harness()
    const workerId = hireCleaner(world, events, 0, 0)

    const farLow = postJob({
      world,
      kind: 'clean',
      priority: 1,
      location: world.grid.idx(30, 30),
      tick: 0,
      events,
    })
    const nearHigh = postJob({
      world,
      kind: 'clean',
      priority: 10,
      location: world.grid.idx(1, 0),
      tick: 0,
      events,
    })
    const nearLow = postJob({
      world,
      kind: 'clean',
      priority: 2,
      location: world.grid.idx(2, 0),
      tick: 0,
      events,
    })

    const aging = DATA.balance.jobs
    const highScore = jobAssignmentScore(nearHigh, 0, 0, 0, world.grid.size, aging)
    const midScore = jobAssignmentScore(nearLow, 0, 0, 0, world.grid.size, aging)
    const lowScore = jobAssignmentScore(farLow, 0, 0, 0, world.grid.size, aging)
    expect(highScore).toBeGreaterThan(midScore)
    expect(midScore).toBeGreaterThan(lowScore)

    run(TICKS_PER_MINUTE)

    const claim = world.jobs.claimOf('staff', workerId)
    expect(claim?.id).toBe(nearHigh.id)
    expect(farLow.state).toBe('open')
    expect(nearLow.state).toBe('open')
  })

  it('abandons on riot and requeues for a new claim', () => {
    const { world, events, run } = harness()
    const workerId = hireCleaner(world, events, 5, 5)
    const job = postJob({
      world,
      kind: 'clean',
      priority: 5,
      location: world.grid.idx(6, 5),
      tick: 0,
      events,
    })

    run(TICKS_PER_MINUTE)
    expect(world.jobs.claimOf('staff', workerId)?.id).toBe(job.id)

    world.riotActive = true
    run(TICKS_PER_MINUTE)

    expect(job.state).toBe('open')
    expect(job.claimedBy).toBe(0)
    expect(world.jobs.isIdle('staff', workerId)).toBe(true)
    expect(world.staff.get(workerId)?.staff.duty).toEqual({ kind: 'idle' })
    expect(
      events.of(JOB_EVENTS.abandoned).some((event) => {
        const data = event.data as { reason?: string; jobId?: number }
        return data.reason === 'riot' && data.jobId === job.id
      }),
    ).toBe(true)

    world.riotActive = false
    run(TICKS_PER_MINUTE)
    expect(world.jobs.claimOf('staff', workerId)?.id).toBe(job.id)
  })

  it('abandons when the claimant is injured', () => {
    const { world, events, run } = harness()
    const inmateId = spawnLabourInmate(world, 'cleaning', 4, 4)
    const job = postJob({
      world,
      kind: 'clean',
      priority: 3,
      location: world.grid.idx(5, 4),
      tick: 0,
      events,
      reservedFor: true,
    })

    run(TICKS_PER_MINUTE)
    expect(world.jobs.claimOf('inmate', inmateId)?.id).toBe(job.id)

    const inmate = world.inmates.get(inmateId)
    expect(inmate).toBeDefined()
    if (inmate === undefined) throw new Error('expected labour inmate')
    inmate.inmate.status.push('bleeding')

    run(TICKS_PER_MINUTE)
    expect(job.state).toBe('open')
    expect(
      events.of(JOB_EVENTS.abandoned).some((event) => {
        const data = event.data as { reason?: string }
        return data.reason === 'injured'
      }),
    ).toBe(true)
  })

  it('ages low-priority jobs until they outrank fresh high-priority work', () => {
    const { world, events, run } = harness()
    const workerId = hireCleaner(world, events, 0, 0)

    const oldLow = postJob({
      world,
      kind: 'clean',
      priority: 1,
      location: world.grid.idx(1, 0),
      tick: 0,
      events,
    })

    // Hold the worker busy on something else while the low job ages.
    const blocker = postJob({
      world,
      kind: 'clean',
      priority: 100,
      location: world.grid.idx(1, 1),
      tick: 0,
      events,
    })

    run(TICKS_PER_MINUTE)
    expect(world.jobs.claimOf('staff', workerId)?.id).toBe(blocker.id)

    // Age the open low-priority job for many assignment periods.
    const agingTicks = TICKS_PER_MINUTE * 200
    run(agingTicks)

    completeJob(world, blocker.id, events, agingTicks + TICKS_PER_MINUTE)

    const freshHigh = postJob({
      world,
      kind: 'clean',
      priority: 5,
      location: world.grid.idx(1, 0),
      tick: agingTicks + TICKS_PER_MINUTE,
      events,
    })

    // Same location ⇒ travel equal; aged low (1 + age*agingPerTick) must beat 5.
    const tick = agingTicks + TICKS_PER_MINUTE
    const ageBoost = (tick - oldLow.enqueuedAt) * DATA.balance.jobs.agingPerTick
    expect(1 + ageBoost).toBeGreaterThan(5)
    expect(effectivePriority(oldLow, tick, DATA.balance.jobs.agingPerTick)).toBeGreaterThan(
      freshHigh.priority,
    )

    run(TICKS_PER_MINUTE)
    expect(world.jobs.claimOf('staff', workerId)?.id).toBe(oldLow.id)
    expect(freshHigh.state).toBe('open')
  })

  it('does not starve low-priority jobs across a long 50×300 run', () => {
    const { world, events, run } = harness()

    for (let i = 0; i < 50; i += 1) {
      hireCleaner(world, events, 1 + (i % 10), 1 + Math.floor(i / 10))
    }

    const lowIds: number[] = []
    for (let i = 0; i < 300; i += 1) {
      const job = postJob({
        world,
        kind: 'clean',
        priority: i < 50 ? 1 : 10,
        location: world.grid.idx(3 + (i % 15), 3 + (Math.floor(i / 15) % 15)),
        tick: 0,
        events,
      })
      if (i < 50) lowIds.push(job.id)
    }

    // Complete waves so the pool drains; low-priority jobs must eventually claim.
    const claimedLow = new Set<number>()
    for (let wave = 0; wave < 20; wave += 1) {
      run(TICKS_PER_MINUTE)
      for (const job of world.jobs.claimed()) {
        if (lowIds.includes(job.id)) claimedLow.add(job.id)
        completeJob(world, job.id, events, wave * TICKS_PER_MINUTE)
      }
    }

    expect(claimedLow.size).toBe(50)
  })

  it('reserves labour jobs for assigned inmates, not staff', () => {
    const { world, events, run } = harness()
    hireCleaner(world, events, 8, 8)
    const inmateId = spawnLabourInmate(world, 'kitchen', 8, 9)

    const job = postJob({
      world,
      kind: 'cook',
      priority: 4,
      location: world.grid.idx(8, 10),
      tick: 0,
      events,
      reservedFor: true,
    })

    run(TICKS_PER_MINUTE)
    expect(job.claimedBy).toBe(inmateId)
    expect(job.claimantKind).toBe('inmate')
    const cleaner = world.staff.all()[0]
    expect(cleaner).toBeDefined()
    if (cleaner === undefined) throw new Error('expected hired cleaner')
    expect(world.jobs.claimOf('staff', cleaner.id)).toBeUndefined()
  })
})
