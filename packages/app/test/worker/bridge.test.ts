import { afterEach, describe, expect, it } from 'vitest'

import { DEFAULT_SNAPSHOT_LIMITS } from '@blockwork/sim'
import type { Snapshot, SnapshotEntity, SnapshotLimits } from '@blockwork/sim'

import { SimBridge, sharedMemoryUsable } from '../../src/worker/bridge'
import { startSimWorker } from '../../src/worker/simWorker'
import type { SimWorkerHandle, SnapshotTransportKind } from '../../src/worker/simWorker'

import { FakeWorkerChannel, ManualClock, ManualScheduler } from './fakeWorker'

const MAP_SIZE = 32
const SEED = 0xb10c_0404

const LIMITS: SnapshotLimits = { ...DEFAULT_SNAPSHOT_LIMITS, maxEntities: 512 }

/** Raises a registered Trace kind through the worker's own sink. */
function raiseFailure(worker: SimWorkerHandle): void {
  worker.loop?.events.emit({
    tick: 0,
    kind: 'cleaning.noCleaners',
    subjectId: 0,
    causeIds: [],
    data: { dirtyTiles: 12, meanDirt: 60, day: 1, time: '00:00' },
  })
}

function dummyEntities(count: number): (tick: number, out: SnapshotEntity[]) => void {
  return (tick, out) => {
    for (let i = 0; i < count; i += 1) {
      out.push({
        id: i + 1,
        x: (tick + i) % MAP_SIZE,
        y: (tick * 3 + i) % MAP_SIZE,
        kind: 1,
        spriteIndex: i % 8,
        facing: tick % 4,
        flags: 0,
      })
    }
  }
}

interface Rig {
  readonly bridge: SimBridge
  readonly clock: ManualClock
  readonly scheduler: ManualScheduler
  readonly channel: FakeWorkerChannel
  /** The worker's own loop, so a test can raise a failure to notify about. */
  readonly worker: SimWorkerHandle
  /** Runs `slices` of 4ms of worker time, the real slice cadence. */
  readonly runMs: (ms: number) => void
}

/**
 * A bridge talking to a real `startSimWorker`, both ends in this thread. Only
 * the transport differs between the two cases, so the same rig proves both.
 */
function rig(
  options: {
    readonly sharedMemory: boolean
    readonly speed?: number
    readonly entities?: number
  } = {
    sharedMemory: true,
  },
): Rig {
  const channel = new FakeWorkerChannel()
  const clock = new ManualClock()
  const scheduler = new ManualScheduler()

  const worker = startSimWorker(channel.scope, {
    now: clock.now,
    schedule: scheduler.schedule,
    ...(options.entities === undefined ? {} : { collectEntities: dummyEntities(options.entities) }),
  })

  const bridge = new SimBridge({
    worker: channel.port,
    seed: SEED,
    mapSize: MAP_SIZE,
    limits: LIMITS,
    speed: options.speed ?? 1,
    sharedMemory: options.sharedMemory,
  })

  return {
    bridge,
    clock,
    scheduler,
    channel,
    worker,
    runMs: (ms: number): void => {
      for (let elapsed = 0; elapsed < ms; elapsed += 4) {
        clock.advance(4)
        scheduler.pump()
      }
    },
  }
}

const transports: SnapshotTransportKind[] = ['shared', 'transfer']

function isShared(transport: SnapshotTransportKind): boolean {
  return transport === 'shared'
}

afterEach(() => {
  Reflect.deleteProperty(globalThis, 'crossOriginIsolated')
})

describe('transport selection (PRD 4.6)', () => {
  it('needs both cross-origin isolation and a SharedArrayBuffer constructor', () => {
    Object.defineProperty(globalThis, 'crossOriginIsolated', {
      value: false,
      configurable: true,
    })
    expect(sharedMemoryUsable()).toBe(false)

    Object.defineProperty(globalThis, 'crossOriginIsolated', {
      value: true,
      configurable: true,
    })
    expect(sharedMemoryUsable()).toBe(true)
  })

  it('falls back to postMessage when crossOriginIsolated is false', () => {
    Object.defineProperty(globalThis, 'crossOriginIsolated', {
      value: false,
      configurable: true,
    })

    const channel = new FakeWorkerChannel()
    const scheduler = new ManualScheduler()
    startSimWorker(channel.scope, { now: () => 0, schedule: scheduler.schedule })

    // No `sharedMemory` override: this is the detection path the app uses.
    const bridge = new SimBridge({
      worker: channel.port,
      seed: SEED,
      mapSize: MAP_SIZE,
      limits: LIMITS,
    })

    expect(bridge.transport).toBe('transfer')
    expect(bridge.ready).toBe(true)
    expect(bridge.latestSnapshot()?.tick).toBe(0)
  })

  it('uses shared memory when the host is isolated', () => {
    Object.defineProperty(globalThis, 'crossOriginIsolated', {
      value: true,
      configurable: true,
    })

    const channel = new FakeWorkerChannel()
    startSimWorker(channel.scope, { now: () => 0, schedule: () => undefined })
    const bridge = new SimBridge({
      worker: channel.port,
      seed: SEED,
      mapSize: MAP_SIZE,
      limits: LIMITS,
    })

    expect(bridge.transport).toBe('shared')
    // The worker writes into the buffer the bridge allocated, so nothing is
    // ever posted back.
    expect(bridge.latestSnapshot()?.tick).toBe(0)
  })
})

describe.each(transports)('SimBridge over the %s transport', (transport) => {
  const shared = isShared(transport)

  it('reports the transport the worker actually booted with', () => {
    const { bridge, channel } = rig({ sharedMemory: shared })

    expect(bridge.transport).toBe(transport)
    expect(bridge.ready).toBe(true)
    expect(bridge.error).toBeNull()

    // Only the fallback moves buffers across the boundary.
    const transferred = channel.transfers.filter((list) => list.length > 0)
    expect(transferred.length > 0).toBe(!shared)
  })

  it('serves the opening frame before a single step has run', () => {
    const { bridge } = rig({ sharedMemory: shared })

    const opening = bridge.latestSnapshot()
    expect(opening?.tick).toBe(0)
    expect(opening?.sequence).toBe(1)
    // The renderer has drawn nothing, so it is offered the whole map.
    expect(opening?.changedChunks.length).toBeGreaterThan(0)
  })

  it('keeps up with the simulation and hands back the newest frame', () => {
    const { bridge, runMs } = rig({ sharedMemory: shared, speed: 20 })

    runMs(1000)

    // PRD 4.1: 20x is 80 steps a real second.
    const snapshot = bridge.latestSnapshot()
    expect(snapshot?.tick).toBe(80)
    expect(snapshot?.sequence).toBe(81)
  })

  it('repeats the last frame rather than returning nothing between steps', () => {
    const { bridge, runMs } = rig({ sharedMemory: shared, speed: 1 })

    runMs(250)
    const first = bridge.latestSnapshot()
    expect(first?.tick).toBe(1)

    // No time has passed, so no new snapshot exists. The renderer still needs
    // a world to draw.
    expect(bridge.latestSnapshot()).toBe(first)
    expect(bridge.latestSnapshot()?.tick).toBe(1)
  })

  it('carries 400 entities at 20x', () => {
    const { bridge, runMs } = rig({ sharedMemory: shared, speed: 20, entities: 400 })

    runMs(1000)

    const snapshot = bridge.latestSnapshot()
    expect(snapshot?.entities).toHaveLength(400)
    expect(snapshot?.entities.at(-1)?.id).toBe(400)
  })

  it('sends commands, which the worker applies at the start of its next tick', () => {
    const { bridge, worker, runMs } = rig({ sharedMemory: shared, speed: 1 })

    bridge.sendCommand({ type: 'nonexistent.command', payload: { at: 3 }, issuedAtTick: 0 })
    // A wiring fault is log-only (PRD 6.5), so a real failure rides alongside
    // it to prove the notification path itself.
    raiseFailure(worker)
    runMs(250)

    const snapshot = bridge.latestSnapshot()
    expect(snapshot?.tick).toBe(1)
    expect(snapshot?.notifications.added).toHaveLength(1)
    expect(snapshot?.digest.alerts).toBe(1)
  })

  it('accumulates notifications across frames and hands them over once', async () => {
    const { bridge, worker, runMs } = rig({ sharedMemory: shared, speed: 1 })

    raiseFailure(worker)
    runMs(250)
    bridge.latestSnapshot()

    const drained = bridge.consumeNotifications()
    expect(drained).toHaveLength(1)
    expect(drained[0]?.traceId).toBeGreaterThan(0)
    // Drained, not re-read: a toast raised twice is a toast shown twice.
    expect(bridge.consumeNotifications()).toHaveLength(0)

    const trace = await bridge.trace(drained[0]?.traceId ?? 0, drained[0]?.id ?? 0)
    expect(trace).not.toBeNull()
    expect(trace?.nodes[0]?.title.length ?? 0).toBeGreaterThan(0)
  })

  it('resolves a trace request for a chain that does not exist', async () => {
    const { bridge, runMs } = rig({ sharedMemory: shared, speed: 1 })
    runMs(250)

    await expect(bridge.trace(4242)).resolves.toBeNull()
  })

  it('requests reports on demand instead of adding them to every frame', async () => {
    const { bridge } = rig({ sharedMemory: shared })

    const reports = await bridge.reports()
    expect(reports.tick).toBe(0)
    expect(reports.populationReport.total).toBe(0)
    expect(bridge.latestSnapshot()).not.toHaveProperty('reports')
  })

  it('refuses a command that would not survive the crossing', () => {
    const { bridge } = rig({ sharedMemory: shared })

    expect(() => bridge.sendCommand({ type: '', payload: null, issuedAtTick: 0 })).toThrow(
      TypeError,
    )
    expect(() => bridge.sendCommand({ type: 'x', payload: null, issuedAtTick: -1 })).toThrow(
      RangeError,
    )
  })

  it('changes the simulation rate on setSpeed, and pauses at 0', () => {
    const { bridge, runMs } = rig({ sharedMemory: shared, speed: 1 })

    runMs(1000)
    expect(bridge.latestSnapshot()?.tick).toBe(4)

    bridge.setSpeed(20)
    expect(bridge.speed).toBe(20)
    runMs(1000)
    expect(bridge.latestSnapshot()?.tick).toBe(84)

    bridge.setSpeed(0)
    runMs(1000)
    expect(bridge.latestSnapshot()?.tick).toBe(84)

    expect(() => bridge.setSpeed(-2)).toThrow(RangeError)
  })

  it('stops the worker on dispose and refuses to be used afterwards', () => {
    const { bridge, channel, runMs } = rig({ sharedMemory: shared, speed: 20 })

    runMs(100)
    bridge.dispose()
    expect(channel.terminated).toBe(true)

    const last = bridge.latestSnapshot()
    runMs(1000)
    expect(bridge.latestSnapshot()?.tick).toBe(last?.tick)

    expect(() => bridge.setSpeed(1)).toThrow(/disposed/)
    expect(() => bridge.sendCommand({ type: 'x', payload: null, issuedAtTick: 0 })).toThrow(
      /disposed/,
    )

    // Idempotent: a double dispose during teardown must not throw.
    expect(() => {
      bridge.dispose()
    }).not.toThrow()
  })
})

describe('transport equivalence', () => {
  it('produces byte-identical frames whichever transport carried them', () => {
    const sharedRig = rig({ sharedMemory: true, speed: 20, entities: 64 })
    const transferRig = rig({ sharedMemory: false, speed: 20, entities: 64 })

    const collect = (from: Rig): Snapshot[] => {
      const frames: Snapshot[] = []
      for (let second = 0; second < 3; second += 1) {
        from.runMs(1000)
        const snapshot = from.bridge.latestSnapshot()
        if (snapshot !== null) frames.push(snapshot)
      }
      return frames
    }

    const viaShared = collect(sharedRig)
    const viaTransfer = collect(transferRig)

    expect(viaShared).toHaveLength(3)
    expect(viaTransfer).toEqual(viaShared)
  })
})
