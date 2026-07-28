import { performance } from 'node:perf_hooks'

import { describe, expect, it } from 'vitest'

import { Rng } from '../../src/core/rng'
import type { SimulationEvent } from '../../src/core/simulation'
import {
  DEFAULT_SNAPSHOT_LIMITS,
  NOTIFICATION_SEVERITY,
  SNAPSHOT_CONTROL,
  SNAPSHOT_CONTROL_BYTES,
  SNAPSHOT_CONTROL_INTS,
  SNAPSHOT_FLAG_TRUNCATED,
  SNAPSHOT_FORMAT_VERSION,
  SNAPSHOT_MAGIC,
  SNAPSHOT_SLOTS,
  SnapshotReader,
  SnapshotWriter,
  createSnapshotBuffer,
  decodeSnapshot,
  encodeSnapshotToTransferable,
  notificationKindId,
  snapshotBufferBytes,
  snapshotPayloadBytes,
  snapshotSlotBytes,
} from '../../src/core/snapshot'
import type {
  Snapshot,
  SnapshotContents,
  SnapshotEntity,
  SnapshotLimits,
  SnapshotNotification,
} from '../../src/core/snapshot'

/**
 * Small limits so a test buffer is small, and so truncation is reachable
 * without building thousands of records.
 */
const TEST_LIMITS: SnapshotLimits = {
  maxEntities: 512,
  maxChunks: 32,
  maxNotifications: 4,
  maxRemovedNotifications: 4,
}

/**
 * Every field of snapshot `n` is a pure function of `n`, so any mixture of two
 * snapshots is detectable from the decoded result alone. That is what makes
 * "internally consistent" checkable without trusting the transport.
 */
function entityAt(n: number, i: number): SnapshotEntity {
  return {
    id: n * 1000 + i,
    // Powers of two in the fraction, so the Float32 round trip is exact.
    x: n + i / 1024,
    y: n - i / 1024,
    kind: n % 256,
    spriteIndex: (n * 7 + i) % 65_536,
    facing: n % 8,
    flags: n % 4,
  }
}

function notificationAt(n: number): SnapshotNotification {
  return {
    id: n,
    tick: n,
    kindId: n * 31,
    subjectId: n * 2,
    traceId: n * 3,
    severity: (n % 3) as SnapshotNotification['severity'],
    count: n % 256,
  }
}

function contentsFor(n: number, entityCount: number): SnapshotContents {
  const entities: SnapshotEntity[] = new Array<SnapshotEntity>(entityCount)
  for (let i = 0; i < entityCount; i += 1) {
    entities[i] = entityAt(n, i)
  }

  return {
    tick: n,
    entities,
    changedChunks: [n % 4096, (n + 1) % 4096, (n + 2) % 4096],
    notifications: { added: [notificationAt(n)], removedIds: [n, n + 1] },
    digest: { balance: n * 3 - 500, danger: n % 101, population: n, alerts: n % 10 },
  }
}

/**
 * True when every field of `snapshot` agrees on a single `n`. A torn read
 * would carry some fields from one write and some from the next, so a single
 * disagreement is enough to fail.
 */
function inconsistency(snapshot: Snapshot, entityCount: number): string | null {
  const n = snapshot.tick
  const expected = contentsFor(n, entityCount)

  if (snapshot.sequence !== n) return `sequence ${snapshot.sequence} for tick ${n}`
  if (snapshot.entities.length !== entityCount) {
    return `entity count ${snapshot.entities.length} for tick ${n}`
  }

  for (let i = 0; i < entityCount; i += 1) {
    const actual = snapshot.entities[i]
    const want = expected.entities[i]
    if (actual === undefined || want === undefined) return `missing entity ${i} at tick ${n}`
    if (
      actual.id !== want.id ||
      actual.x !== want.x ||
      actual.y !== want.y ||
      actual.kind !== want.kind ||
      actual.spriteIndex !== want.spriteIndex ||
      actual.facing !== want.facing ||
      actual.flags !== want.flags
    ) {
      return `entity ${i} at tick ${n}: ${JSON.stringify(actual)}`
    }
  }

  if (snapshot.changedChunks.join() !== expected.changedChunks.join()) {
    return `chunks ${snapshot.changedChunks.join()} at tick ${n}`
  }
  if (JSON.stringify(snapshot.notifications) !== JSON.stringify(expected.notifications)) {
    return `notifications at tick ${n}`
  }
  if (JSON.stringify(snapshot.digest) !== JSON.stringify(expected.digest)) {
    return `digest ${JSON.stringify(snapshot.digest)} at tick ${n}`
  }

  return null
}

/**
 * Snapshot `n`'s entity array, with a one-shot side effect fired while the
 * writer is partway through encoding entity `index`.
 *
 * This is how a single-threaded test reaches inside a write. The writer reads
 * each entity's `id` first, so the callback runs after the header and every
 * earlier entity have been written and before this one has, which is exactly
 * the window a concurrent reader could land in.
 */
function contentsInterruptedAt(
  n: number,
  entityCount: number,
  index: number,
  interrupt: () => void,
): SnapshotContents {
  const contents = contentsFor(n, entityCount)
  const entities = [...contents.entities]
  const original = entityAt(n, index)
  let fired = false

  entities[index] = {
    ...original,
    get id(): number {
      if (!fired) {
        fired = true
        interrupt()
      }
      return original.id
    },
  }

  return { ...contents, entities }
}

function controlOf(buffer: ArrayBufferLike): Int32Array {
  return new Int32Array(buffer, 0, SNAPSHOT_CONTROL_INTS)
}

describe('snapshot layout (PRD 4.6)', () => {
  it('sizes a slot from its limits and both slots plus control from the buffer', () => {
    const slotBytes = snapshotSlotBytes(TEST_LIMITS)

    // 64 byte header, 20 byte entities, 2 byte chunk ids, 24 byte
    // notifications, 4 byte removals.
    expect(slotBytes).toBe(64 + 512 * 20 + 32 * 2 + 4 * 24 + 4 * 4)
    expect(snapshotBufferBytes(TEST_LIMITS)).toBe(SNAPSHOT_CONTROL_BYTES + 2 * slotBytes)
    expect(SNAPSHOT_CONTROL_BYTES).toBe(32)
    expect(SNAPSHOT_SLOTS).toBe(2)
  })

  it('pads the notification section back to a 4 byte boundary after odd chunk counts', () => {
    // Three 2-byte chunk ids leave the cursor 2 bytes past alignment.
    expect(snapshotPayloadBytes(0, 3, 1, 0)).toBe(64 + 8 + 24)
    expect(snapshotPayloadBytes(0, 4, 1, 0)).toBe(64 + 8 + 24)
    expect(snapshotPayloadBytes(0, 5, 1, 0)).toBe(64 + 12 + 24)
  })

  it('never lets a snapshot within its limits outgrow a slot', () => {
    const slotBytes = snapshotSlotBytes(TEST_LIMITS)
    for (let chunks = 0; chunks <= TEST_LIMITS.maxChunks; chunks += 1) {
      expect(
        snapshotPayloadBytes(
          TEST_LIMITS.maxEntities,
          chunks,
          TEST_LIMITS.maxNotifications,
          TEST_LIMITS.maxRemovedNotifications,
        ),
      ).toBeLessThanOrEqual(slotBytes)
    }
  })

  it('holds the default limits in a buffer small enough to keep on the heap', () => {
    // A 220x220 map is 196 chunks, so the default headroom is generous.
    expect(DEFAULT_SNAPSHOT_LIMITS.maxChunks).toBe(4096)
    expect(snapshotBufferBytes(DEFAULT_SNAPSHOT_LIMITS)).toBeLessThan(128 * 1024)
  })

  it('initialises the control block so a bare buffer describes itself', () => {
    const buffer = createSnapshotBuffer(TEST_LIMITS)
    const control = controlOf(buffer)

    expect(control[SNAPSHOT_CONTROL.MAGIC]).toBe(SNAPSHOT_MAGIC)
    expect(control[SNAPSHOT_CONTROL.FORMAT_VERSION]).toBe(SNAPSHOT_FORMAT_VERSION)
    expect(control[SNAPSHOT_CONTROL.SLOT_BYTES]).toBe(snapshotSlotBytes(TEST_LIMITS))
    expect(control[SNAPSHOT_CONTROL.LATEST_SLOT]).toBe(-1)
    expect(control[SNAPSHOT_CONTROL.PUBLISHED]).toBe(0)
  })

  it('refuses to attach to a buffer that is not a snapshot transport', () => {
    expect(() => new SnapshotReader(new ArrayBuffer(4096))).toThrow(/bad magic/)
    expect(() => new SnapshotReader(new ArrayBuffer(8))).toThrow(RangeError)

    const buffer = createSnapshotBuffer(TEST_LIMITS)
    controlOf(buffer)[SNAPSHOT_CONTROL.FORMAT_VERSION] = SNAPSHOT_FORMAT_VERSION + 1
    expect(() => new SnapshotReader(buffer)).toThrow(/format/)
  })

  it('refuses a writer whose limits do not fit the buffer it was given', () => {
    const buffer = createSnapshotBuffer(TEST_LIMITS)
    expect(() => new SnapshotWriter(buffer, { limits: DEFAULT_SNAPSHOT_LIMITS })).toThrow(
      RangeError,
    )
  })
})

describe('snapshot encoding', () => {
  it('round-trips every field', () => {
    const contents = contentsFor(7, 3)
    const { buffer } = encodeSnapshotToTransferable(contents, 7, TEST_LIMITS)
    const decoded = decodeSnapshot(buffer)

    expect(decoded).not.toBeNull()
    expect(inconsistency(decoded as Snapshot, 3)).toBeNull()
    expect(decoded?.flags).toBe(0)
  })

  it('sizes a transferable to the snapshot, not to the limits', () => {
    const { buffer } = encodeSnapshotToTransferable(contentsFor(1, 3), 1, TEST_LIMITS)
    expect(buffer.byteLength).toBe(snapshotPayloadBytes(3, 3, 1, 2))
    expect(buffer.byteLength).toBeLessThan(snapshotSlotBytes(TEST_LIMITS))
  })

  it('carries an empty snapshot', () => {
    const empty: SnapshotContents = {
      tick: 0,
      entities: [],
      changedChunks: [],
      notifications: { added: [], removedIds: [] },
      digest: { balance: 0, danger: 0, population: 0, alerts: 0 },
    }
    const { buffer } = encodeSnapshotToTransferable(empty, 1, TEST_LIMITS)
    const decoded = decodeSnapshot(buffer)

    expect(decoded?.entities).toEqual([])
    expect(decoded?.changedChunks).toEqual([])
    expect(decoded?.notifications).toEqual({ added: [], removedIds: [] })
  })

  it('keeps a negative balance signed and the danger reading fractional', () => {
    const contents: SnapshotContents = {
      ...contentsFor(1, 0),
      digest: { balance: -250_000, danger: 62.5, population: 214, alerts: 3 },
    }
    const { buffer } = encodeSnapshotToTransferable(contents, 1, TEST_LIMITS)

    expect(decodeSnapshot(buffer)?.digest).toEqual({
      balance: -250_000,
      danger: 62.5,
      population: 214,
      alerts: 3,
    })
  })

  it('rejects out-of-range values in dev builds', () => {
    const bad = (contents: Partial<SnapshotContents>): (() => void) => {
      return () => {
        encodeSnapshotToTransferable({ ...contentsFor(1, 0), ...contents }, 1, TEST_LIMITS)
      }
    }

    expect(bad({ entities: [{ ...entityAt(1, 0), kind: 256 }] })).toThrow(RangeError)
    expect(bad({ entities: [{ ...entityAt(1, 0), spriteIndex: 65_536 }] })).toThrow(RangeError)
    expect(bad({ entities: [{ ...entityAt(1, 0), x: Number.NaN }] })).toThrow(RangeError)
    expect(bad({ changedChunks: [70_000] })).toThrow(RangeError)
    expect(bad({ digest: { balance: 0.5, danger: 0, population: 0, alerts: 0 } })).toThrow(
      RangeError,
    )
  })

  it('returns null rather than throwing on a buffer that is not a snapshot', () => {
    expect(decodeSnapshot(new ArrayBuffer(16))).toBeNull()
    expect(decodeSnapshot(new ArrayBuffer(256))).toBeNull()

    const { buffer } = encodeSnapshotToTransferable(contentsFor(1, 2), 1, TEST_LIMITS)
    // A header claiming more entities than the buffer holds is what a lapped
    // reader sees, and it must not throw its way out of the retry loop.
    new DataView(buffer).setUint32(16, 10_000, true)
    expect(decodeSnapshot(buffer)).toBeNull()
  })

  it('gives every notification kind a stable numeric id', () => {
    expect(notificationKindId('kitchen.underCapacity')).toBe(
      notificationKindId('kitchen.underCapacity'),
    )
    expect(notificationKindId('kitchen.underCapacity')).not.toBe(
      notificationKindId('kitchen.overCapacity'),
    )
  })
})

describe('snapshot truncation', () => {
  it('drops what will not fit, flags the frame and emits a CausalEvent', () => {
    const events: SimulationEvent[] = []
    const writer = SnapshotWriter.create(TEST_LIMITS, {
      events: {
        emit(event) {
          events.push(event)
        },
      },
    })
    const reader = new SnapshotReader(writer.buffer)

    const overflowing: SnapshotContents = {
      ...contentsFor(5, 0),
      changedChunks: Array.from({ length: TEST_LIMITS.maxChunks + 3 }, (_, i) => i),
      notifications: {
        added: Array.from({ length: TEST_LIMITS.maxNotifications + 2 }, (_, i) =>
          notificationAt(i + 1),
        ),
        removedIds: [],
      },
    }

    writer.write(overflowing)
    const snapshot = reader.read()

    expect(snapshot?.changedChunks).toHaveLength(TEST_LIMITS.maxChunks)
    expect(snapshot?.notifications.added).toHaveLength(TEST_LIMITS.maxNotifications)
    expect(snapshot?.flags).toBe(SNAPSHOT_FLAG_TRUNCATED)

    expect(events).toHaveLength(1)
    expect(events[0]?.kind).toBe('snapshot.truncated')
    expect(events[0]?.data).toMatchObject({ droppedChunks: 3, droppedNotifications: 2 })
  })
})

describe('snapshot double buffer', () => {
  it('publishes nothing until the first write', () => {
    const writer = SnapshotWriter.create(TEST_LIMITS)
    const reader = new SnapshotReader(writer.buffer)

    expect(reader.sequence).toBe(0)
    expect(reader.read()).toBeNull()

    writer.write(contentsFor(1, 2))
    expect(reader.sequence).toBe(1)
    expect(reader.read()?.tick).toBe(1)
  })

  it('alternates slots so the live frame is never the one being overwritten', () => {
    const writer = SnapshotWriter.create(TEST_LIMITS)
    const control = controlOf(writer.buffer)

    const slots: number[] = []
    for (let n = 1; n <= 6; n += 1) {
      writer.write(contentsFor(n, 2))
      slots.push(control[SNAPSHOT_CONTROL.LATEST_SLOT] ?? -1)
    }

    expect(slots).toEqual([0, 1, 0, 1, 0, 1])
    // Two completed writes per slot, and each write moves that slot's version
    // by exactly two.
    expect(control[SNAPSHOT_CONTROL.SLOT_VERSION]).toBe(6)
    expect(control[SNAPSHOT_CONTROL.SLOT_VERSION + 1]).toBe(6)
  })

  it('skips a slot whose version says it is mid-write', () => {
    const writer = SnapshotWriter.create(TEST_LIMITS)
    const reader = new SnapshotReader(writer.buffer)
    const control = controlOf(writer.buffer)

    writer.write(contentsFor(1, 2))
    writer.write(contentsFor(2, 2))
    expect(reader.read()?.tick).toBe(2)

    // Exactly what a reader sees if it arrives while the writer is inside slot
    // 1: an odd version. It must decline rather than decode the half-written
    // frame, and there is nothing newer to fall back to.
    control[SNAPSHOT_CONTROL.SLOT_VERSION + 1] = 5
    expect(reader.read()).toBeNull()

    control[SNAPSHOT_CONTROL.SLOT_VERSION + 1] = 4
    expect(reader.read()?.tick).toBe(2)
  })

  it('skips the decode when the caller already has the newest sequence', () => {
    const writer = SnapshotWriter.create(TEST_LIMITS)
    const reader = new SnapshotReader(writer.buffer)

    writer.write(contentsFor(1, 2))
    expect(reader.readIfNewer(0)?.sequence).toBe(1)
    expect(reader.readIfNewer(1)).toBeNull()

    writer.write(contentsFor(2, 2))
    expect(reader.readIfNewer(1)?.sequence).toBe(2)
  })

  it('leaves a slot readable even if encoding threw halfway through it', () => {
    const writer = SnapshotWriter.create(TEST_LIMITS)
    const reader = new SnapshotReader(writer.buffer)
    const control = controlOf(writer.buffer)

    writer.write(contentsFor(1, 2))
    expect(() =>
      writer.write({ ...contentsFor(2, 0), entities: [{ ...entityAt(2, 0), kind: 999 }] }),
    ).toThrow(RangeError)

    // A version left odd would wedge that slot for the rest of the run.
    expect((control[SNAPSHOT_CONTROL.SLOT_VERSION + 1] ?? 1) % 2).toBe(0)
    expect(reader.read()?.tick).toBe(1)
  })

  it('works over real shared memory', () => {
    const buffer = createSnapshotBuffer(TEST_LIMITS, { shared: true })
    expect(buffer).toBeInstanceOf(SharedArrayBuffer)

    const writer = new SnapshotWriter(buffer, { limits: TEST_LIMITS })
    // A second reader over the same buffer is what the main thread constructs
    // from the transferred handle.
    const reader = new SnapshotReader(buffer)

    for (let n = 1; n <= 9; n += 1) {
      writer.write(contentsFor(n, 16))
    }
    const snapshot = reader.read()

    expect(snapshot?.tick).toBe(9)
    expect(inconsistency(snapshot as Snapshot, 16)).toBeNull()
  })
})

/**
 * The ticket's acceptance test: write continuously while reading, and assert
 * every read is internally consistent.
 *
 * The reads happen *inside* the writes rather than between them. A test that
 * only alternated whole writes and whole reads would never enter the window
 * the seqlock exists to close, and would pass against a transport with no
 * synchronisation at all.
 */
describe('torn reads', () => {
  const ENTITIES = 24

  it('never returns a mixture of two frames, at any point inside a write', () => {
    const writer = SnapshotWriter.create(TEST_LIMITS)
    const reader = new SnapshotReader(writer.buffer)

    writer.write(contentsFor(1, ENTITIES))

    const seen: number[] = []
    // Sweep the interruption across every entity of the frame, so the read
    // lands just after the header, deep in the entity array, and everywhere
    // between.
    for (let index = 0; index < ENTITIES; index += 1) {
      const n = index + 2

      let read: Snapshot | null = null
      writer.write(
        contentsInterruptedAt(n, ENTITIES, index, () => {
          read = reader.read()
        }),
      )

      const snapshot: Snapshot | null = read
      expect(snapshot, `no snapshot while writing ${n}`).not.toBeNull()
      // Mid-write, the newest complete frame is the previous one. Reading the
      // frame under construction would be the tear.
      expect((snapshot as unknown as Snapshot).tick).toBe(n - 1)
      expect(inconsistency(snapshot as unknown as Snapshot, ENTITIES)).toBeNull()
      seen.push((snapshot as unknown as Snapshot).tick)
    }

    expect(seen).toHaveLength(ENTITIES)
    expect(reader.read()?.tick).toBe(ENTITIES + 1)
  })

  it('stays consistent over a long run of writes interrupted at random points', () => {
    const writer = SnapshotWriter.create(TEST_LIMITS)
    const reader = new SnapshotReader(writer.buffer)
    const random = new Rng(0x5eed_0104).stream('test.tornRead')

    writer.write(contentsFor(1, ENTITIES))

    let reads = 0
    let firstFailure: string | null = null

    for (let n = 2; n <= 2000; n += 1) {
      writer.write(
        contentsInterruptedAt(n, ENTITIES, random.nextInt(0, ENTITIES), () => {
          const snapshot = reader.read()
          reads += 1
          if (snapshot === null) {
            firstFailure ??= `null read while writing ${n}`
            return
          }
          firstFailure ??= inconsistency(snapshot, ENTITIES)
          if (snapshot.tick !== n - 1) {
            firstFailure ??= `read frame ${snapshot.tick} while writing ${n}`
          }
        }),
      )
    }

    expect(firstFailure).toBeNull()
    expect(reads).toBe(1999)
  })
})

/**
 * PRD 4.1 puts 20x at 80 steps a real second, and PRD 7.5 budgets 0.5ms to
 * write a snapshot and 2ms to read and interpolate one. These measure a
 * second of 20x with 400 entities, the ticket's acceptance case.
 *
 * Medians, deliberately, not the worst sample.
 *
 * Nineteen test files share this machine's cores, and a garbage collection or
 * a descheduled thread stalls an individual iteration by tens of milliseconds.
 * A tail assertion here would measure the runner, and an assertion that fails
 * for reasons unrelated to the code teaches nobody anything. The median is
 * immune to that and still catches every regression that matters — an
 * accidental per-entity allocation, a copy of the whole buffer, a decode that
 * walks the slot rather than the payload — because those miss by a factor of
 * hundreds. Holding the *tail* to these budgets is a property of the device,
 * and PRD 7.5's CI performance harness (T6.9) is where it gets its hard gate.
 */
describe('snapshot transport budget (PRD 7.5)', () => {
  const ENTITIES = 400
  const FRAMES = 80

  const median = (samples: number[]): number => {
    const sorted = [...samples].sort((a, b) => a - b)
    return sorted[sorted.length >> 1] ?? Number.POSITIVE_INFINITY
  }

  it('reads a 400 entity frame at 20x well inside the 2ms frame budget', () => {
    const writer = SnapshotWriter.create(DEFAULT_SNAPSHOT_LIMITS, { shared: true })
    const reader = new SnapshotReader(writer.buffer)

    for (let n = 1; n <= 20; n += 1) {
      writer.write(contentsFor(n, ENTITIES))
      reader.read()
    }

    const samples: number[] = []
    for (let n = 21; n <= 20 + FRAMES; n += 1) {
      writer.write(contentsFor(n, ENTITIES))

      const started = performance.now()
      const snapshot = reader.read()
      samples.push(performance.now() - started)

      expect(snapshot?.tick).toBe(n)
      expect(snapshot?.entities).toHaveLength(ENTITIES)
    }

    // PRD 7.5 gives the frame 2ms for the read plus interpolation, and this
    // measures the read alone.
    expect(median(samples)).toBeLessThan(2)
  })

  it('writes a 400 entity frame inside the 0.5ms snapshot budget', () => {
    const writer = SnapshotWriter.create(DEFAULT_SNAPSHOT_LIMITS)

    // A few frames, reused, so the timed loop measures the encode rather than
    // the test allocating 400 entity objects a frame.
    const frames: SnapshotContents[] = []
    for (let n = 1; n <= 8; n += 1) {
      frames.push(contentsFor(n, ENTITIES))
    }
    const frameAt = (n: number): SnapshotContents => frames[n % frames.length] as SnapshotContents

    for (let n = 0; n < 20; n += 1) {
      writer.write(frameAt(n))
    }

    const samples: number[] = []
    for (let n = 20; n < 20 + FRAMES; n += 1) {
      const contents = frameAt(n)
      const started = performance.now()
      writer.write(contents)
      samples.push(performance.now() - started)
    }

    expect(median(samples)).toBeLessThan(0.5)
  })
})

describe('shared memory availability', () => {
  it('refuses to allocate shared memory when the host cannot provide it', () => {
    const original = globalThis.SharedArrayBuffer
    try {
      // What a webview without cross-origin isolation looks like.
      Reflect.deleteProperty(globalThis, 'SharedArrayBuffer')
      expect(() => createSnapshotBuffer(TEST_LIMITS, { shared: true })).toThrow(
        /cross-origin isolated/,
      )
      // The unshared allocation is the fallback, and it still works.
      expect(createSnapshotBuffer(TEST_LIMITS)).toBeInstanceOf(ArrayBuffer)
    } finally {
      Object.defineProperty(globalThis, 'SharedArrayBuffer', {
        value: original,
        configurable: true,
        writable: true,
      })
    }
  })

  it('reports the severity ladder of PRD 6.5 in escalating order', () => {
    expect(NOTIFICATION_SEVERITY.INFO).toBeLessThan(NOTIFICATION_SEVERITY.WARN)
    expect(NOTIFICATION_SEVERITY.WARN).toBeLessThan(NOTIFICATION_SEVERITY.CRITICAL)
  })
})
