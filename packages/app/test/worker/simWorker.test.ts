import { describe, expect, it } from 'vitest'

import {
  DEFAULT_SNAPSHOT_LIMITS,
  SnapshotReader,
  TICKS_PER_MINUTE,
  chunkCount,
  NOTIFICATION_SEVERITY,
  createSnapshotBuffer,
  decodeSnapshot,
  decodeTilePatch,
  loadFromBytes,
  notificationKindId,
  CURRENT_SAVE_VERSION,
} from '@blockwork/sim'
import type { Snapshot, SnapshotEntity, SnapshotLimits } from '@blockwork/sim'

import {
  MAX_CATCHUP_MS,
  STEPS_PER_SECOND_AT_1X,
  SimWorkerLoop,
  startSimWorker,
} from '../../src/worker/simWorker'
import type { SimWorkerOutbound } from '../../src/worker/simWorker'

import { FakeWorkerChannel, ManualClock, ManualScheduler } from './fakeWorker'

const MAP_SIZE = 64
const SEED = 0xb10c_0004

const LIMITS: SnapshotLimits = {
  ...DEFAULT_SNAPSHOT_LIMITS,
  maxEntities: 512,
}

/** Stands in for the entity store until T2.4 gives the world real inhabitants. */
function dummyEntities(count: number): (tick: number, out: SnapshotEntity[]) => void {
  return (tick, out) => {
    for (let i = 0; i < count; i += 1) {
      out.push({
        id: i + 1,
        x: (tick + i) % MAP_SIZE,
        y: (tick * 2 + i) % MAP_SIZE,
        kind: 1,
        spriteIndex: i % 16,
        facing: tick % 4,
        flags: 0,
      })
    }
  }
}

/**
 * Raises a real failure kind through the loop's own sink.
 *
 * A notification has to be a registered Trace kind to reach the player at all
 * (PRD 6.5), so a test that wants one raises a failure rather than an
 * unhandled command.
 */
function raiseFailure(harness: Harness): void {
  harness.loop.events.emit({
    tick: 0,
    kind: 'cleaning.noCleaners',
    subjectId: 0,
    causeIds: [],
    data: { dirtyTiles: 12, meanDirt: 60, day: 1, time: '00:00' },
  })
}

interface Harness {
  readonly loop: SimWorkerLoop
  readonly clock: ManualClock
  readonly read: () => Snapshot | null
}

function sharedHarness(
  options: { readonly speed?: number; readonly entities?: number } = {},
): Harness {
  const buffer = createSnapshotBuffer(LIMITS, { shared: true }) as SharedArrayBuffer
  const reader = new SnapshotReader(buffer)
  const clock = new ManualClock()

  const loop = new SimWorkerLoop({
    seed: SEED,
    mapSize: MAP_SIZE,
    limits: LIMITS,
    snapshotBuffer: buffer,
    speed: options.speed ?? 1,
    post: (message) => {
      if (message.type === 'sim:control' || message.type === 'sim:effects') return
      throw new Error('the shared transport must not post snapshots')
    },
    ...(options.entities === undefined ? {} : { collectEntities: dummyEntities(options.entities) }),
  })

  return { loop, clock, read: () => reader.read() }
}

/** Feeds the loop `slices` ticks of the wall clock and returns steps run. */
function run(harness: Harness, slices: number, sliceMs: number): number {
  harness.loop.advance(harness.clock.now())
  let steps = 0
  for (let i = 0; i < slices; i += 1) {
    harness.clock.advance(sliceMs)
    steps += harness.loop.advance(harness.clock.now())
  }
  return steps
}

describe('SimWorkerLoop pacing (PRD 4.1)', () => {
  it('needs a first call to establish a baseline before it can run anything', () => {
    const harness = sharedHarness()
    expect(harness.loop.advance(harness.clock.now())).toBe(0)
    expect(harness.loop.simulation.tick).toBe(0)
  })

  it('runs 4 steps a real second at 1x', () => {
    const harness = sharedHarness({ speed: 1 })
    // A second of 4ms slices, the cadence the worker's timer actually runs at.
    const steps = run(harness, 250, 4)

    expect(steps).toBe(STEPS_PER_SECOND_AT_1X)
    expect(harness.loop.simulation.tick).toBe(4)
  })

  it('runs 80 steps a real second at 20x', () => {
    const harness = sharedHarness({ speed: 20 })
    expect(run(harness, 250, 4)).toBe(80)
    expect(harness.loop.simulation.tick).toBe(80)
  })

  it('accumulates fractions rather than dropping them, so speed does not drift', () => {
    const harness = sharedHarness({ speed: 1 })
    // 4ms slices earn 0.016 of a step each: without accumulation the loop
    // would never step at all.
    const steps = run(harness, 2500, 4)

    expect(steps).toBe(10 * STEPS_PER_SECOND_AT_1X)
    // 10 real seconds at 1x is 40 ticks, which is 4 in-game minutes.
    expect(harness.loop.simulation.tick).toBe(40)
    expect(harness.loop.simulation.clock.minute).toBe(40 / TICKS_PER_MINUTE)
  })

  it('holds every speed on the PRD 3.9 ladder to 4 steps a second per multiple', () => {
    for (const speed of [1, 2, 5, 20]) {
      const harness = sharedHarness({ speed })
      expect(run(harness, 250, 4), `${speed}x`).toBe(STEPS_PER_SECOND_AT_1X * speed)
    }
  })

  it('pauses at speed 0 and does not burst on resume', () => {
    const harness = sharedHarness({ speed: 0 })

    expect(run(harness, 250, 4)).toBe(0)
    expect(harness.loop.simulation.tick).toBe(0)

    harness.loop.setSpeed(1)
    expect(run(harness, 250, 4)).toBe(STEPS_PER_SECOND_AT_1X)
  })

  it('refuses a negative or non-finite speed', () => {
    const harness = sharedHarness()
    expect(() => harness.loop.setSpeed(-1)).toThrow(RangeError)
    expect(() => harness.loop.setSpeed(Number.NaN)).toThrow(RangeError)
  })

  it('clamps catch-up so a backgrounded app resumes rather than fast-forwards', () => {
    const harness = sharedHarness({ speed: 20 })
    harness.loop.advance(harness.clock.now())

    // Ten minutes with no timer, as when the iPad is locked. Unclamped this
    // would be 48,000 steps in one slice.
    harness.clock.advance(600_000)
    const steps = harness.loop.advance(harness.clock.now())

    expect(steps).toBe((MAX_CATCHUP_MS / 1000) * STEPS_PER_SECOND_AT_1X * 20)
    expect(steps).toBeLessThanOrEqual(20)
  })

  it('ignores a clock that goes backwards', () => {
    const harness = sharedHarness({ speed: 20 })
    harness.loop.advance(1000)
    expect(harness.loop.advance(500)).toBe(0)
  })
})

describe('SimWorkerLoop save + auto-route', () => {
  it('exports a loadable current-version save from the live InmateWorld', async () => {
    const harness = sharedHarness()
    run(harness, 250, 4)
    const { bytes, playedTicks } = await harness.loop.exportSave('2031-07-28T12:00:00.000Z')
    expect(playedTicks).toBe(4)
    const loaded = await loadFromBytes(bytes)
    expect(loaded.playedTicks).toBe(4)
    expect(loaded.grid.size).toBe(MAP_SIZE)
    expect(loaded.seed).toBe(SEED)
    expect(CURRENT_SAVE_VERSION).toBe(4)
    expect(loaded.sectors.nextSectorId).toBeGreaterThanOrEqual(1)
  })

  it('answers auto-route against the live grid', () => {
    const harness = sharedHarness()
    const route = harness.loop.autoRoute({ x: 2, y: 2 }, 'power')
    // Fresh map has no live cable — null is the honest answer.
    expect(route).toBeNull()
  })
})

describe('SimWorkerLoop snapshots', () => {
  it('publishes one snapshot per step', () => {
    const harness = sharedHarness({ speed: 20 })
    run(harness, 250, 4)

    expect(harness.loop.sequence).toBe(80)
    const snapshot = harness.read()
    expect(snapshot?.sequence).toBe(80)
    expect(snapshot?.tick).toBe(80)
  })

  it('offers the renderer every chunk once, then only what changed', () => {
    const harness = sharedHarness({ speed: 1 })

    harness.loop.publish()
    expect(harness.read()?.changedChunks).toHaveLength(chunkCount(MAP_SIZE))

    harness.loop.publish()
    expect(harness.read()?.changedChunks).toEqual([])
  })

  it('carries the entities the collector supplies', () => {
    const harness = sharedHarness({ speed: 20, entities: 400 })
    run(harness, 250, 4)

    const snapshot = harness.read()
    expect(snapshot?.entities).toHaveLength(400)
    expect(snapshot?.entities[0]).toEqual({
      id: 1,
      x: 80 % MAP_SIZE,
      y: 160 % MAP_SIZE,
      kind: 1,
      spriteIndex: 0,
      facing: 0,
      flags: 0,
    })
  })

  it('turns a failure event into a notification and an alert count (CLAUDE.md rule 5)', () => {
    const harness = sharedHarness({ speed: 1 })

    raiseFailure(harness)
    run(harness, 250, 4)

    const snapshot = harness.read()
    expect(snapshot?.digest.alerts).toBe(1)

    // The event fires on the first step, so it rides that step's snapshot and
    // is gone from the next: the queue is a delta, not a running list.
    expect(snapshot?.notifications.added).toEqual([])
  })

  it('sends each notification exactly once, on the frame it was raised', () => {
    const harness = sharedHarness({ speed: 1 })
    raiseFailure(harness)

    harness.loop.advance(harness.clock.now())
    harness.clock.advance(250)
    harness.loop.advance(harness.clock.now())

    const snapshot = harness.read()
    expect(snapshot?.notifications.added).toHaveLength(1)
    expect(snapshot?.notifications.added[0]?.kindId).toBe(notificationKindId('cleaning.noCleaners'))
    expect(snapshot?.notifications.added[0]?.severity).toBe(NOTIFICATION_SEVERITY.WARN)
    expect(snapshot?.notifications.added[0]?.traceId).toBeGreaterThan(0)
  })

  it('keeps kinds with no Trace copy silent (PRD 6.5: warn implies a traceId)', () => {
    const harness = sharedHarness({ speed: 1 })

    // No handler is registered for this type, so the core emits
    // `command.unhandled` — a wiring fault, not something to badge the player
    // about, and a kind with no chain to open.
    harness.loop.enqueue({ type: 'nonexistent.command', payload: null, issuedAtTick: 0 })
    run(harness, 250, 4)

    const snapshot = harness.read()
    expect(snapshot?.digest.alerts).toBe(0)
    expect(snapshot?.notifications.added).toEqual([])
  })
})

describe('SimWorkerLoop.trace', () => {
  it('resolves a notification into a renderable chain with fixes', () => {
    const harness = sharedHarness({ speed: 1 })

    harness.loop.events.emit({
      tick: 0,
      kind: 'kitchen.underCapacity',
      subjectId: 0,
      causeIds: [],
      data: {
        kitchenName: 'K2',
        cookers: 2,
        cooks: 1,
        cooksPlural: '',
        mealsPerCookerPerHour: 12,
        assistFactor: 1.25,
        mealsPerHour: 30,
        needed: 118,
        prepHours: 4,
        neededCookers: 6,
        neededCooks: 4,
        altCookers: 3,
        altCooks: 4,
        cookerCost: 400,
      },
    })
    harness.loop.advance(harness.clock.now())
    harness.clock.advance(250)
    harness.loop.advance(harness.clock.now())

    const traceId = harness.read()?.notifications.added[0]?.traceId ?? 0
    expect(traceId).toBeGreaterThan(0)

    const trace = harness.loop.trace(traceId, 1)
    expect(trace).not.toBeNull()
    if (trace === null) throw new Error('expected a trace')

    // Interpolated from the event's own data, not the raw template.
    expect(trace.nodes[0]?.title).toContain('K2')
    expect(trace.nodes[0]?.title).toContain('2 cookers')
    expect(trace.nodes[0]?.isRootCause).toBe(true)
    expect(trace.fixes.map((fix) => fix.id)).toContain('add_cookers')
    expect(trace.subtitle).toContain('Day 1')

    // Structured-cloneable: it crosses a postMessage.
    expect(() => structuredClone(trace)).not.toThrow()
  })

  it('answers null for a chain it never recorded rather than throwing', () => {
    const harness = sharedHarness({ speed: 1 })
    expect(harness.loop.trace(9999)).toBeNull()
  })

  it('keeps a pinned chain alive past the notification that raised it', () => {
    const harness = sharedHarness({ speed: 1 })
    harness.loop.events.emit({
      tick: 0,
      kind: 'cleaning.noCleaners',
      subjectId: 0,
      causeIds: [],
      data: { dirtyTiles: 40, meanDirt: 90, day: 1, time: '00:00' },
    })
    harness.loop.advance(harness.clock.now())
    harness.clock.advance(250)
    harness.loop.advance(harness.clock.now())

    const traceId = harness.read()?.notifications.added[0]?.traceId ?? 0
    expect(harness.loop.trace(traceId, 7)).not.toBeNull()

    harness.loop.untrace(7)
    // Still retained: the ring has not overflowed, so unpinning is not eviction.
    expect(harness.loop.trace(traceId)).not.toBeNull()
  })
})

describe('startSimWorker', () => {
  it('boots on sim:init, reports its transport and publishes the opening frame', () => {
    const channel = new FakeWorkerChannel()
    const clock = new ManualClock()
    const scheduler = new ManualScheduler()
    const received: SimWorkerOutbound[] = []

    channel.port.addEventListener('message', (event) => {
      received.push(event.data)
    })

    const handle = startSimWorker(channel.scope, {
      now: clock.now,
      schedule: scheduler.schedule,
    })
    expect(handle.loop).toBeNull()

    channel.port.postMessage(
      { type: 'sim:init', seed: SEED, mapSize: MAP_SIZE, limits: LIMITS, speed: 20 },
      [],
    )

    const ready = received[0]
    expect(ready?.type).toBe('sim:ready')
    if (ready?.type !== 'sim:ready') throw new Error('expected sim:ready first')
    expect(ready.transport).toBe('transfer')
    expect(ready.mapSize).toBe(MAP_SIZE)
    // The renderer colours walls and floors by material index, so the table's
    // order is part of the handshake.
    expect(ready.materialIds.length).toBeGreaterThan(0)
    expect(handle.loop?.simulation.tick).toBe(0)

    // The opening frame offers every chunk, and on this transport the tiles
    // have to travel with the ids: the renderer cannot read the worker's grid.
    const tiles = received[1]
    expect(tiles?.type).toBe('sim:tiles')
    if (tiles?.type !== 'sim:tiles') throw new Error('expected an opening tile patch')
    expect(decodeTilePatch(tiles.buffer)?.chunks.length).toBe(chunkCount(MAP_SIZE))

    const opening = received[2]
    expect(opening?.type).toBe('sim:snapshot')
    if (opening?.type !== 'sim:snapshot') throw new Error('expected an opening snapshot')
    expect(decodeSnapshot(opening.buffer)?.tick).toBe(0)

    handle.stop()
  })

  it('drives the loop from its scheduler and stops when told to', () => {
    const channel = new FakeWorkerChannel()
    const clock = new ManualClock()
    const scheduler = new ManualScheduler()

    const handle = startSimWorker(channel.scope, {
      now: clock.now,
      schedule: scheduler.schedule,
    })
    channel.port.postMessage(
      { type: 'sim:init', seed: SEED, mapSize: MAP_SIZE, limits: LIMITS, speed: 20 },
      [],
    )

    for (let slice = 0; slice < 250; slice += 1) {
      clock.advance(4)
      scheduler.pump()
    }
    expect(handle.loop?.simulation.tick).toBe(80)

    channel.port.postMessage({ type: 'sim:stop' }, [])
    scheduler.pump()
    clock.advance(1000)
    scheduler.pump()

    expect(handle.loop?.simulation.tick).toBe(80)
    expect(scheduler.pending).toBe(0)
  })

  it('applies speed changes and commands from the main thread', () => {
    const channel = new FakeWorkerChannel()
    const clock = new ManualClock()
    const scheduler = new ManualScheduler()

    const handle = startSimWorker(channel.scope, {
      now: clock.now,
      schedule: scheduler.schedule,
    })
    channel.port.postMessage(
      { type: 'sim:init', seed: SEED, mapSize: MAP_SIZE, limits: LIMITS, speed: 1 },
      [],
    )

    channel.port.postMessage({ type: 'sim:speed', speed: 5 }, [])
    expect(handle.loop?.speed).toBe(5)

    channel.port.postMessage(
      { type: 'sim:command', command: { type: 'test.noop', payload: { a: 1 }, issuedAtTick: 0 } },
      [],
    )
    expect(handle.loop?.simulation.pendingCommands()).toHaveLength(1)

    clock.advance(1000)
    scheduler.pump()
    expect(handle.loop?.simulation.pendingCommands()).toHaveLength(0)

    handle.stop()
  })

  it('reports a bad boot as an error message instead of dying silently', () => {
    const channel = new FakeWorkerChannel()
    const received: SimWorkerOutbound[] = []
    channel.port.addEventListener('message', (event) => {
      received.push(event.data)
    })

    startSimWorker(channel.scope, {
      now: () => 0,
      schedule: () => undefined,
    })
    channel.port.postMessage(
      { type: 'sim:init', seed: SEED, mapSize: 0, limits: LIMITS, speed: 1 },
      [],
    )

    expect(received[0]?.type).toBe('sim:error')
  })
})
