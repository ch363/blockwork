/**
 * Render snapshots and the transport that carries them out of the worker
 * (PRD 4.6).
 *
 * The simulation lives on a worker thread; the renderer lives on the main
 * thread and must never wait for it. After every step the worker writes a
 * **snapshot**: entity positions and sprite state, the tile chunks that
 * changed, a notification delta, and a small digest for the top bar. It is a
 * view for drawing, not simulation state, so nothing here feeds `hash()` and
 * nothing here may be read back into the simulation.
 *
 * The transport is a two-slot ring in one buffer, with a seqlock per slot:
 *
 *   - The writer alternates slots. Before touching a slot it bumps that slot's
 *     version to an odd number, and after finishing it bumps it to the next
 *     even number, then publishes the slot index and the sequence.
 *   - The reader loads the published slot, reads its version, decodes, and
 *     re-reads the version. Equal and even means nothing moved underneath it.
 *
 * That is what makes a read wait-free and tear-free. The reader never blocks
 * the writer and the writer never blocks the reader, so a slow frame on the
 * main thread cannot stall the simulation, and a fast simulation cannot hand
 * the renderer half of one frame and half of the next. Because the writer
 * alternates, the slot a reader is working on is two whole writes away from
 * being overwritten, so the retry path is a safety net rather than a
 * a hot path.
 *
 * The same encoding serves the `postMessage` fallback for webviews where
 * `crossOriginIsolated` is false and `SharedArrayBuffer` therefore is not
 * available: `encodeSnapshotToTransferable` produces an exactly-sized
 * `ArrayBuffer` to hand over as a transferable, and `decodeSnapshot` reads it
 * back. One format, two transports.
 *
 * The format is fixed-width and delta-friendly from day one, per PRD 4.6:
 * changed chunks and notifications are already deltas, and the header carries
 * a flags word and two reserved slots so entity deltas can be added without a
 * new format version.
 *
 * Text never crosses this boundary. Notifications carry a numeric `kindId`
 * (`notificationKindId`) that the main thread resolves against the string
 * catalogue, which keeps the buffer fixed-width and keeps this module free of
 * `TextEncoder`, a DOM global that `packages/sim` may not depend on.
 */

import { MAX_GRID_SIZE, boundsChecksEnabled, chunkCount } from '../world/coords'

import { fnv1a32 } from './hash'
import type { EventSink } from './simulation'

/** 'BKW1'. Guards against a buffer that is not a snapshot buffer at all. */
export const SNAPSHOT_MAGIC = 0x424b5731

/** Bump only for a change the reader cannot absorb. Reserved fields are free. */
export const SNAPSHOT_FORMAT_VERSION = 1

/** PRD 6.5. Also the order the alert badge escalates in. */
export const NOTIFICATION_SEVERITY = {
  /** Log only, no badge. */
  INFO: 0,
  /** Badge plus a toast. Carries a `traceId`. */
  WARN: 1,
  /** Toast, a pulse on the alerts button, and optionally auto-pause. */
  CRITICAL: 2,
} as const

export type NotificationSeverity =
  (typeof NOTIFICATION_SEVERITY)[keyof typeof NOTIFICATION_SEVERITY]

/** Header flags. Bit 0 says the writer had to drop content to fit the slot. */
export const SNAPSHOT_FLAG_TRUNCATED = 0b0001

/**
 * One drawable thing, in world units, independent of the camera.
 *
 * `kind`, `spriteIndex`, `facing` and `flags` are opaque indices here on
 * purpose: their tables belong to the entity store and the sprite atlas
 * (T1.4, T2.4, T2.8), and this module only guarantees they survive the
 * crossing at the declared widths.
 */
export interface SnapshotEntity {
  /** Stable entity id. 0 is never a live entity. */
  readonly id: number
  /** World x. Fractional: the renderer interpolates between snapshots. */
  readonly x: number
  readonly y: number
  /** Entity category index, 0..255. */
  readonly kind: number
  /** Frame index into the atlas, 0..65535. */
  readonly spriteIndex: number
  /** Direction index, 0..255. */
  readonly facing: number
  /** Presentation bitfield, 0..65535: selected, incapacitated, and so on. */
  readonly flags: number
}

/**
 * One entry in the notification queue (PRD 6.5). Numeric throughout; the
 * display string comes from the catalogue on the main thread.
 */
export interface SnapshotNotification {
  readonly id: number
  /** The tick it was raised on. */
  readonly tick: number
  /** `notificationKindId` of the event kind, for the string catalogue. */
  readonly kindId: number
  /** The entity the notification is about, or 0. */
  readonly subjectId: number
  /** The `CausalEvent` to open the Trace panel at (T3.1), or 0. */
  readonly traceId: number
  readonly severity: NotificationSeverity
  /** Grouping count (PRD 6.5), saturating at 255. */
  readonly count: number
}

/** Delta, not the whole queue: only what changed since the last snapshot. */
export interface NotificationDelta {
  readonly added: readonly SnapshotNotification[]
  readonly removedIds: readonly number[]
}

/** What the top bar needs, so the UI never walks the entity array for it. */
export interface UiDigest {
  /** Signed: PRD 5 lets the balance go negative. */
  readonly balance: number
  /** Danger level, 0..100 (PRD 5.11). */
  readonly danger: number
  readonly population: number
  /** Unread notifications of `warn` or above. */
  readonly alerts: number
}

/** Everything one snapshot carries, before the writer stamps a sequence on it. */
export interface SnapshotContents {
  readonly tick: number
  readonly entities: readonly SnapshotEntity[]
  /** Chunk ids from `TileGrid.consumeDirtyChunks()`. */
  readonly changedChunks: readonly number[]
  readonly notifications: NotificationDelta
  readonly digest: UiDigest
}

export interface Snapshot extends SnapshotContents {
  /** Monotonic, 1-based. The renderer uses it to skip a frame it has drawn. */
  readonly sequence: number
  /** `SNAPSHOT_FLAG_*` bits. */
  readonly flags: number
}

/**
 * Slot capacity, in records. Allocation guards, not balance numbers: they size
 * the buffer, and content that exceeds them is dropped with a `CausalEvent`
 * rather than growing the buffer mid-frame.
 */
export interface SnapshotLimits {
  readonly maxEntities: number
  readonly maxChunks: number
  readonly maxNotifications: number
  readonly maxRemovedNotifications: number
}

export const DEFAULT_SNAPSHOT_LIMITS: SnapshotLimits = {
  /** PRD 7.5 budgets 400 agents; objects and items share the array. */
  maxEntities: 2048,
  /** Every chunk of the largest grid the coordinate system allows. */
  maxChunks: chunkCount(MAX_GRID_SIZE),
  maxNotifications: 64,
  maxRemovedNotifications: 64,
}

/**
 * The control block: `Int32Array` indices at the head of the buffer.
 *
 * Everything needed to attach a reader to a bare buffer is in here, so the
 * transport can hand over a `SharedArrayBuffer` with nothing alongside it.
 * Public because it is the contract between the two threads, and because a
 * diagnostic or a test needs to see the handshake without reaching into a
 * writer or a reader.
 */
export const SNAPSHOT_CONTROL = {
  MAGIC: 0,
  FORMAT_VERSION: 1,
  SLOT_BYTES: 2,
  /** Index of the slot holding the newest complete snapshot. -1 until the first write. */
  LATEST_SLOT: 3,
  /** Odd while that slot is being written. Slot n is at `SLOT_VERSION + n`. */
  SLOT_VERSION: 4,
  PUBLISHED: 6,
  RESERVED: 7,
} as const

export const SNAPSHOT_CONTROL_INTS = 8
export const SNAPSHOT_CONTROL_BYTES = SNAPSHOT_CONTROL_INTS * 4

export const SNAPSHOT_SLOTS = 2

/** Slot header field offsets, relative to the start of the slot. */
const HEAD = {
  MAGIC: 0,
  FORMAT_VERSION: 4,
  SEQUENCE: 8,
  TICK: 12,
  ENTITY_COUNT: 16,
  CHUNK_COUNT: 20,
  ADDED_COUNT: 24,
  REMOVED_COUNT: 28,
  BALANCE: 32,
  DANGER: 36,
  POPULATION: 40,
  ALERTS: 44,
  FLAGS: 48,
  PAYLOAD_BYTES: 52,
  /** Room for entity deltas without a format bump (PRD 4.6). */
  RESERVED_0: 56,
  RESERVED_1: 60,
} as const

const HEADER_BYTES = 64

/**
 * Entity record, 20 bytes. Declaration order in `SnapshotEntity` is the order
 * the ticket lists; the bytes are reordered so every field is naturally
 * aligned and the record is a multiple of 4.
 */
const ENTITY = {
  ID: 0,
  X: 4,
  Y: 8,
  SPRITE_INDEX: 12,
  FLAGS: 14,
  KIND: 16,
  FACING: 17,
} as const

const ENTITY_BYTES = 20

/** Notification record, 24 bytes. */
const NOTIFICATION = {
  ID: 0,
  TICK: 4,
  KIND_ID: 8,
  SUBJECT_ID: 12,
  TRACE_ID: 16,
  SEVERITY: 20,
  COUNT: 21,
} as const

const NOTIFICATION_BYTES = 24

/** Chunk ids are `Uint16`: the largest grid has 4096 chunks. */
const CHUNK_BYTES = 2
const REMOVED_ID_BYTES = 4

/** Little-endian everywhere, so a save or a log is readable on any device. */
const LE = true

/**
 * How many times a reader retries before giving up for this frame. A retry
 * only happens if the writer laps the reader mid-decode, which takes two full
 * writes; more than a couple of attempts means the reader is descheduled, and
 * redrawing the previous frame beats blocking.
 */
const MAX_READ_ATTEMPTS = 8

function align4(bytes: number): number {
  return (bytes + 3) & ~3
}

function assertCount(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new RangeError(`${label} must be a non-negative integer, received ${value}`)
  }
}

export function assertSnapshotLimits(limits: SnapshotLimits): void {
  assertCount(limits.maxEntities, 'maxEntities')
  assertCount(limits.maxChunks, 'maxChunks')
  assertCount(limits.maxNotifications, 'maxNotifications')
  assertCount(limits.maxRemovedNotifications, 'maxRemovedNotifications')
}

/** Bytes a snapshot with these counts occupies, header included. */
export function snapshotPayloadBytes(
  entityCount: number,
  chunkCount_: number,
  addedCount: number,
  removedCount: number,
): number {
  return (
    align4(HEADER_BYTES + entityCount * ENTITY_BYTES + chunkCount_ * CHUNK_BYTES) +
    addedCount * NOTIFICATION_BYTES +
    removedCount * REMOVED_ID_BYTES
  )
}

/** Bytes one slot must reserve to hold any snapshot within `limits`. */
export function snapshotSlotBytes(limits: SnapshotLimits): number {
  assertSnapshotLimits(limits)
  return snapshotPayloadBytes(
    limits.maxEntities,
    limits.maxChunks,
    limits.maxNotifications,
    limits.maxRemovedNotifications,
  )
}

/** Total transport size: the control block plus both slots. */
export function snapshotBufferBytes(limits: SnapshotLimits): number {
  return SNAPSHOT_CONTROL_BYTES + SNAPSHOT_SLOTS * snapshotSlotBytes(limits)
}

/** True where `SharedArrayBuffer` exists. The caller still checks isolation. */
export function sharedMemoryAvailable(): boolean {
  return typeof SharedArrayBuffer !== 'undefined'
}

/**
 * Allocates and initialises a transport buffer.
 *
 * Shared where the host allows it, plain otherwise: a plain `ArrayBuffer`
 * behaves identically for a writer and reader in the same thread, which is
 * what the tests and the single-threaded fallback use.
 */
export function createSnapshotBuffer(
  limits: SnapshotLimits = DEFAULT_SNAPSHOT_LIMITS,
  options: { readonly shared?: boolean } = {},
): ArrayBufferLike {
  const slotBytes = snapshotSlotBytes(limits)
  const totalBytes = SNAPSHOT_CONTROL_BYTES + SNAPSHOT_SLOTS * slotBytes

  const shared = options.shared ?? false
  if (shared && !sharedMemoryAvailable()) {
    throw new Error(
      'SharedArrayBuffer is unavailable: the page is not cross-origin isolated. ' +
        'Use the postMessage transport instead.',
    )
  }

  const buffer: ArrayBufferLike = shared
    ? new SharedArrayBuffer(totalBytes)
    : new ArrayBuffer(totalBytes)

  const control = new Int32Array(buffer, 0, SNAPSHOT_CONTROL_INTS)
  control[SNAPSHOT_CONTROL.MAGIC] = SNAPSHOT_MAGIC
  control[SNAPSHOT_CONTROL.FORMAT_VERSION] = SNAPSHOT_FORMAT_VERSION
  control[SNAPSHOT_CONTROL.SLOT_BYTES] = slotBytes
  control[SNAPSHOT_CONTROL.LATEST_SLOT] = -1
  control[SNAPSHOT_CONTROL.SLOT_VERSION] = 0
  control[SNAPSHOT_CONTROL.SLOT_VERSION + 1] = 0
  control[SNAPSHOT_CONTROL.PUBLISHED] = 0
  control[SNAPSHOT_CONTROL.RESERVED] = 0

  return buffer
}

/**
 * `createSnapshotBuffer` for the shared transport, typed so the caller can
 * hand the result straight to `postMessage` without a cast. Throws where
 * shared memory is unavailable, which is the signal to use the fallback.
 */
export function createSharedSnapshotBuffer(
  limits: SnapshotLimits = DEFAULT_SNAPSHOT_LIMITS,
): SharedArrayBuffer {
  const buffer = createSnapshotBuffer(limits, { shared: true })
  if (!(buffer instanceof SharedArrayBuffer)) {
    throw new Error('shared snapshot buffer allocation did not produce shared memory')
  }
  return buffer
}

function attachControl(buffer: ArrayBufferLike): Int32Array {
  if (buffer.byteLength < SNAPSHOT_CONTROL_BYTES) {
    throw new RangeError(
      `snapshot buffer must be at least ${SNAPSHOT_CONTROL_BYTES} bytes, received ${buffer.byteLength}`,
    )
  }

  const control = new Int32Array(buffer, 0, SNAPSHOT_CONTROL_INTS)
  if (control[SNAPSHOT_CONTROL.MAGIC] !== SNAPSHOT_MAGIC) {
    throw new Error('buffer is not a snapshot transport: bad magic')
  }
  if (control[SNAPSHOT_CONTROL.FORMAT_VERSION] !== SNAPSHOT_FORMAT_VERSION) {
    throw new Error(
      `snapshot format ${String(control[SNAPSHOT_CONTROL.FORMAT_VERSION])} is not ` +
        `${String(SNAPSHOT_FORMAT_VERSION)}`,
    )
  }

  const slotBytes = control[SNAPSHOT_CONTROL.SLOT_BYTES] ?? 0
  if (slotBytes <= 0 || buffer.byteLength < SNAPSHOT_CONTROL_BYTES + SNAPSHOT_SLOTS * slotBytes) {
    throw new RangeError(
      `snapshot buffer of ${buffer.byteLength} bytes cannot hold ` +
        `${String(SNAPSHOT_SLOTS)} slots of ${String(slotBytes)} bytes`,
    )
  }

  return control
}

/**
 * A stable numeric id for an event or notification kind, so the wire format
 * stays fixed-width and the display string is resolved on the main thread.
 */
export function notificationKindId(kind: string): number {
  return fnv1a32(kind)
}

function assertUint(value: number, bits: number, label: string): void {
  const max = 2 ** bits - 1
  if (!Number.isInteger(value) || value < 0 || value > max) {
    throw new RangeError(`${label} must be an integer in 0..${max}, received ${value}`)
  }
}

/**
 * `assertUint` for the per-record loops. The path is assembled only on the way
 * to the throw: building `entity[317].kind` for every field of every entity of
 * every frame costs more than the whole rest of the encode.
 */
function assertRecordUint(
  value: number,
  bits: number,
  record: string,
  index: number,
  field: string,
): void {
  const max = 2 ** bits - 1
  if (Number.isInteger(value) && value >= 0 && value <= max) return
  throw new RangeError(
    `${record}[${index}].${field} must be an integer in 0..${max}, received ${value}`,
  )
}

function validateEntity(entity: SnapshotEntity, index: number): void {
  assertRecordUint(entity.id, 32, 'entity', index, 'id')
  if (!Number.isFinite(entity.x) || !Number.isFinite(entity.y)) {
    throw new RangeError(
      `entity[${index}] position must be finite, received (${entity.x}, ${entity.y})`,
    )
  }
  assertRecordUint(entity.kind, 8, 'entity', index, 'kind')
  assertRecordUint(entity.spriteIndex, 16, 'entity', index, 'spriteIndex')
  assertRecordUint(entity.facing, 8, 'entity', index, 'facing')
  assertRecordUint(entity.flags, 16, 'entity', index, 'flags')
}

function validateHeader(contents: SnapshotContents): void {
  assertUint(contents.tick, 32, 'tick')
  assertUint(contents.digest.population, 32, 'digest.population')
  assertUint(contents.digest.alerts, 32, 'digest.alerts')

  const { balance, danger } = contents.digest
  if (!Number.isInteger(balance) || balance < -(2 ** 31) || balance > 2 ** 31 - 1) {
    throw new RangeError(`digest.balance must be a 32-bit integer, received ${balance}`)
  }
  if (!Number.isFinite(danger)) {
    throw new RangeError(`digest.danger must be finite, received ${danger}`)
  }
}

function validateNotification(notification: SnapshotNotification, index: number): void {
  assertRecordUint(notification.id, 32, 'notification', index, 'id')
  assertRecordUint(notification.tick, 32, 'notification', index, 'tick')
  assertRecordUint(notification.kindId, 32, 'notification', index, 'kindId')
  assertRecordUint(notification.subjectId, 32, 'notification', index, 'subjectId')
  assertRecordUint(notification.traceId, 32, 'notification', index, 'traceId')
  assertRecordUint(notification.severity, 8, 'notification', index, 'severity')
  assertRecordUint(notification.count, 8, 'notification', index, 'count')
}

/** What `encodeSnapshot` dropped, if anything, so the caller can report it. */
export interface SnapshotTruncation {
  readonly entities: number
  readonly chunks: number
  readonly added: number
  readonly removed: number
}

export const NO_TRUNCATION: SnapshotTruncation = {
  entities: 0,
  chunks: 0,
  added: 0,
  removed: 0,
}

export function isTruncated(truncation: SnapshotTruncation): boolean {
  return (
    truncation.entities > 0 ||
    truncation.chunks > 0 ||
    truncation.added > 0 ||
    truncation.removed > 0
  )
}

export interface EncodeResult {
  readonly byteLength: number
  readonly truncation: SnapshotTruncation
}

/**
 * Writes one snapshot into `buffer` at `byteOffset`, clamped to `limits`.
 *
 * Over-limit content is dropped rather than throwing: a frame missing the last
 * few entities still draws, and the header's `SNAPSHOT_FLAG_TRUNCATED` bit
 * plus the returned counts let the caller raise the `CausalEvent`.
 */
export function encodeSnapshot(
  contents: SnapshotContents,
  sequence: number,
  buffer: ArrayBufferLike,
  byteOffset: number,
  limits: SnapshotLimits,
): EncodeResult {
  const check = boundsChecksEnabled()

  const entityCount = Math.min(contents.entities.length, limits.maxEntities)
  const chunkTotal = Math.min(contents.changedChunks.length, limits.maxChunks)
  const addedCount = Math.min(contents.notifications.added.length, limits.maxNotifications)
  const removedCount = Math.min(
    contents.notifications.removedIds.length,
    limits.maxRemovedNotifications,
  )

  const truncation: SnapshotTruncation = {
    entities: contents.entities.length - entityCount,
    chunks: contents.changedChunks.length - chunkTotal,
    added: contents.notifications.added.length - addedCount,
    removed: contents.notifications.removedIds.length - removedCount,
  }

  const payloadBytes = snapshotPayloadBytes(entityCount, chunkTotal, addedCount, removedCount)
  if (byteOffset + payloadBytes > buffer.byteLength) {
    throw new RangeError(
      `snapshot of ${payloadBytes} bytes does not fit at offset ${byteOffset} ` +
        `in a ${buffer.byteLength} byte buffer`,
    )
  }

  if (check) validateHeader(contents)

  const view = new DataView(buffer, byteOffset, payloadBytes)

  view.setUint32(HEAD.MAGIC, SNAPSHOT_MAGIC, LE)
  view.setUint32(HEAD.FORMAT_VERSION, SNAPSHOT_FORMAT_VERSION, LE)
  view.setUint32(HEAD.SEQUENCE, sequence, LE)
  view.setUint32(HEAD.TICK, contents.tick, LE)
  view.setUint32(HEAD.ENTITY_COUNT, entityCount, LE)
  view.setUint32(HEAD.CHUNK_COUNT, chunkTotal, LE)
  view.setUint32(HEAD.ADDED_COUNT, addedCount, LE)
  view.setUint32(HEAD.REMOVED_COUNT, removedCount, LE)
  view.setInt32(HEAD.BALANCE, contents.digest.balance, LE)
  view.setFloat32(HEAD.DANGER, contents.digest.danger, LE)
  view.setUint32(HEAD.POPULATION, contents.digest.population, LE)
  view.setUint32(HEAD.ALERTS, contents.digest.alerts, LE)
  view.setUint32(HEAD.FLAGS, isTruncated(truncation) ? SNAPSHOT_FLAG_TRUNCATED : 0, LE)
  view.setUint32(HEAD.PAYLOAD_BYTES, payloadBytes, LE)
  view.setUint32(HEAD.RESERVED_0, 0, LE)
  view.setUint32(HEAD.RESERVED_1, 0, LE)

  let at = HEADER_BYTES
  for (let i = 0; i < entityCount; i += 1) {
    // Bounded by entityCount, which is the clamped array length.
    const entity = contents.entities[i] as SnapshotEntity
    if (check) validateEntity(entity, i)

    view.setUint32(at + ENTITY.ID, entity.id, LE)
    view.setFloat32(at + ENTITY.X, entity.x, LE)
    view.setFloat32(at + ENTITY.Y, entity.y, LE)
    view.setUint16(at + ENTITY.SPRITE_INDEX, entity.spriteIndex, LE)
    view.setUint16(at + ENTITY.FLAGS, entity.flags, LE)
    view.setUint8(at + ENTITY.KIND, entity.kind)
    view.setUint8(at + ENTITY.FACING, entity.facing)
    at += ENTITY_BYTES
  }

  for (let i = 0; i < chunkTotal; i += 1) {
    const chunkId = contents.changedChunks[i] ?? 0
    if (check) assertRecordUint(chunkId, 16, 'changedChunks', i, 'id')
    view.setUint16(at, chunkId, LE)
    at += CHUNK_BYTES
  }

  at = align4(at)

  for (let i = 0; i < addedCount; i += 1) {
    // Bounded by addedCount, which is the clamped array length.
    const notification = contents.notifications.added[i] as SnapshotNotification
    if (check) validateNotification(notification, i)

    view.setUint32(at + NOTIFICATION.ID, notification.id, LE)
    view.setUint32(at + NOTIFICATION.TICK, notification.tick, LE)
    view.setUint32(at + NOTIFICATION.KIND_ID, notification.kindId, LE)
    view.setUint32(at + NOTIFICATION.SUBJECT_ID, notification.subjectId, LE)
    view.setUint32(at + NOTIFICATION.TRACE_ID, notification.traceId, LE)
    view.setUint8(at + NOTIFICATION.SEVERITY, notification.severity)
    view.setUint8(at + NOTIFICATION.COUNT, notification.count)
    at += NOTIFICATION_BYTES
  }

  for (let i = 0; i < removedCount; i += 1) {
    const id = contents.notifications.removedIds[i] ?? 0
    if (check) assertRecordUint(id, 32, 'removedIds', i, 'id')
    view.setUint32(at, id, LE)
    at += REMOVED_ID_BYTES
  }

  return { byteLength: payloadBytes, truncation }
}

/**
 * An exactly-sized `ArrayBuffer` holding one snapshot, for the `postMessage`
 * fallback. Hand it to `postMessage` as a transferable so the copy is a
 * pointer move rather than a structured clone of the whole frame.
 */
export function encodeSnapshotToTransferable(
  contents: SnapshotContents,
  sequence: number,
  limits: SnapshotLimits = DEFAULT_SNAPSHOT_LIMITS,
): { readonly buffer: ArrayBuffer; readonly truncation: SnapshotTruncation } {
  const entityCount = Math.min(contents.entities.length, limits.maxEntities)
  const chunkTotal = Math.min(contents.changedChunks.length, limits.maxChunks)
  const addedCount = Math.min(contents.notifications.added.length, limits.maxNotifications)
  const removedCount = Math.min(
    contents.notifications.removedIds.length,
    limits.maxRemovedNotifications,
  )

  const buffer = new ArrayBuffer(
    snapshotPayloadBytes(entityCount, chunkTotal, addedCount, removedCount),
  )
  const { truncation } = encodeSnapshot(contents, sequence, buffer, 0, limits)
  return { buffer, truncation }
}

/**
 * Reads one snapshot back. Returns `null` rather than throwing when the header
 * does not describe a snapshot that fits in `maxBytes`, because on the seqlock
 * path that means the writer moved underneath the reader and the caller is
 * about to detect it and retry.
 */
export function decodeSnapshot(
  buffer: ArrayBufferLike,
  byteOffset = 0,
  maxBytes = buffer.byteLength - byteOffset,
): Snapshot | null {
  if (maxBytes < HEADER_BYTES || byteOffset + maxBytes > buffer.byteLength) return null

  const view = new DataView(buffer, byteOffset, maxBytes)
  if (view.getUint32(HEAD.MAGIC, LE) !== SNAPSHOT_MAGIC) return null
  if (view.getUint32(HEAD.FORMAT_VERSION, LE) !== SNAPSHOT_FORMAT_VERSION) return null

  const entityCount = view.getUint32(HEAD.ENTITY_COUNT, LE)
  const chunkTotal = view.getUint32(HEAD.CHUNK_COUNT, LE)
  const addedCount = view.getUint32(HEAD.ADDED_COUNT, LE)
  const removedCount = view.getUint32(HEAD.REMOVED_COUNT, LE)

  const payloadBytes = snapshotPayloadBytes(entityCount, chunkTotal, addedCount, removedCount)
  if (payloadBytes > maxBytes) return null
  if (view.getUint32(HEAD.PAYLOAD_BYTES, LE) !== payloadBytes) return null

  const entities: SnapshotEntity[] = new Array<SnapshotEntity>(entityCount)
  let at = HEADER_BYTES
  for (let i = 0; i < entityCount; i += 1) {
    entities[i] = {
      id: view.getUint32(at + ENTITY.ID, LE),
      x: view.getFloat32(at + ENTITY.X, LE),
      y: view.getFloat32(at + ENTITY.Y, LE),
      kind: view.getUint8(at + ENTITY.KIND),
      spriteIndex: view.getUint16(at + ENTITY.SPRITE_INDEX, LE),
      facing: view.getUint8(at + ENTITY.FACING),
      flags: view.getUint16(at + ENTITY.FLAGS, LE),
    }
    at += ENTITY_BYTES
  }

  const changedChunks: number[] = new Array<number>(chunkTotal)
  for (let i = 0; i < chunkTotal; i += 1) {
    changedChunks[i] = view.getUint16(at, LE)
    at += CHUNK_BYTES
  }

  at = align4(at)

  const added: SnapshotNotification[] = new Array<SnapshotNotification>(addedCount)
  for (let i = 0; i < addedCount; i += 1) {
    added[i] = {
      id: view.getUint32(at + NOTIFICATION.ID, LE),
      tick: view.getUint32(at + NOTIFICATION.TICK, LE),
      kindId: view.getUint32(at + NOTIFICATION.KIND_ID, LE),
      subjectId: view.getUint32(at + NOTIFICATION.SUBJECT_ID, LE),
      traceId: view.getUint32(at + NOTIFICATION.TRACE_ID, LE),
      severity: toSeverity(view.getUint8(at + NOTIFICATION.SEVERITY)),
      count: view.getUint8(at + NOTIFICATION.COUNT),
    }
    at += NOTIFICATION_BYTES
  }

  const removedIds: number[] = new Array<number>(removedCount)
  for (let i = 0; i < removedCount; i += 1) {
    removedIds[i] = view.getUint32(at, LE)
    at += REMOVED_ID_BYTES
  }

  return {
    sequence: view.getUint32(HEAD.SEQUENCE, LE),
    tick: view.getUint32(HEAD.TICK, LE),
    flags: view.getUint32(HEAD.FLAGS, LE),
    entities,
    changedChunks,
    notifications: { added, removedIds },
    digest: {
      balance: view.getInt32(HEAD.BALANCE, LE),
      danger: view.getFloat32(HEAD.DANGER, LE),
      population: view.getUint32(HEAD.POPULATION, LE),
      alerts: view.getUint32(HEAD.ALERTS, LE),
    },
  }
}

function toSeverity(value: number): NotificationSeverity {
  switch (value) {
    case NOTIFICATION_SEVERITY.CRITICAL:
      return NOTIFICATION_SEVERITY.CRITICAL
    case NOTIFICATION_SEVERITY.WARN:
      return NOTIFICATION_SEVERITY.WARN
    default:
      return NOTIFICATION_SEVERITY.INFO
  }
}

/**
 * Snapshot sequences live in a `Uint32` header field, so they wrap to 1 rather
 * than to 0: 0 is reserved for "nothing published yet". At 80 steps a second
 * that happens after about seventeen months of continuous play.
 */
export function nextSequence(sequence: number): number {
  return sequence >= 0xffff_ffff ? 1 : sequence + 1
}

export interface SnapshotWriterOptions {
  readonly limits?: SnapshotLimits
  /** Receives `snapshot.truncated` when content is dropped (CLAUDE.md rule 5). */
  readonly events?: EventSink
}

/**
 * The worker end of the transport. Owns the slot rotation and the atomics; the
 * caller owns the snapshot contents.
 */
export class SnapshotWriter {
  readonly buffer: ArrayBufferLike
  readonly limits: SnapshotLimits

  readonly #control: Int32Array
  readonly #slotBytes: number
  readonly #events: EventSink | undefined
  #nextSlot = 0
  #sequence = 0

  constructor(buffer: ArrayBufferLike, options: SnapshotWriterOptions = {}) {
    this.buffer = buffer
    this.limits = options.limits ?? DEFAULT_SNAPSHOT_LIMITS
    this.#events = options.events
    this.#control = attachControl(buffer)
    this.#slotBytes = this.#control[SNAPSHOT_CONTROL.SLOT_BYTES] ?? 0

    const required = snapshotSlotBytes(this.limits)
    if (required > this.#slotBytes) {
      throw new RangeError(
        `snapshot limits need ${required} bytes per slot, buffer provides ${this.#slotBytes}`,
      )
    }
  }

  /** Allocates a buffer and a writer for it in one step. */
  static create(
    limits: SnapshotLimits = DEFAULT_SNAPSHOT_LIMITS,
    options: { readonly shared?: boolean; readonly events?: EventSink } = {},
  ): SnapshotWriter {
    const buffer = createSnapshotBuffer(limits, { shared: options.shared ?? false })
    return options.events === undefined
      ? new SnapshotWriter(buffer, { limits })
      : new SnapshotWriter(buffer, { limits, events: options.events })
  }

  /**
   * The sequence of the last published snapshot. 0 before the first write, and
   * never 0 again: it wraps back to 1, because the header field is a `Uint32`
   * and 0 is how a reader recognises an empty transport.
   */
  get sequence(): number {
    return this.#sequence
  }

  get slotBytes(): number {
    return this.#slotBytes
  }

  /**
   * Publishes one snapshot and returns its sequence.
   *
   * The two `Atomics.store` calls around the encode are the whole tear-free
   * guarantee: they are sequentially consistent, so a reader that sees the
   * even version afterwards is guaranteed to see the bytes written before it.
   */
  write(contents: SnapshotContents): number {
    const slot = this.#nextSlot
    const versionIndex = SNAPSHOT_CONTROL.SLOT_VERSION + slot
    const version = Atomics.load(this.#control, versionIndex)

    Atomics.store(this.#control, versionIndex, version + 1)

    const sequence = nextSequence(this.#sequence)
    let result: EncodeResult
    try {
      result = encodeSnapshot(
        contents,
        sequence,
        this.buffer,
        SNAPSHOT_CONTROL_BYTES + slot * this.#slotBytes,
        this.limits,
      )
    } finally {
      // Leaving the version odd would wedge every future read on this slot,
      // so it is restored even if encoding threw.
      Atomics.store(this.#control, versionIndex, version + 2)
    }

    Atomics.store(this.#control, SNAPSHOT_CONTROL.LATEST_SLOT, slot)
    Atomics.store(this.#control, SNAPSHOT_CONTROL.PUBLISHED, sequence)

    this.#sequence = sequence
    this.#nextSlot = slot ^ 1

    if (isTruncated(result.truncation)) {
      this.#events?.emit({
        tick: contents.tick,
        kind: 'snapshot.truncated',
        causeIds: [],
        data: {
          sequence,
          droppedEntities: result.truncation.entities,
          droppedChunks: result.truncation.chunks,
          droppedNotifications: result.truncation.added,
          droppedRemovals: result.truncation.removed,
        },
      })
    }

    return sequence
  }
}

/**
 * The renderer end of the transport. `read` is wait-free: it never blocks the
 * writer and never blocks on it.
 */
export class SnapshotReader {
  readonly buffer: ArrayBufferLike

  readonly #control: Int32Array
  readonly #slotBytes: number

  constructor(buffer: ArrayBufferLike) {
    this.buffer = buffer
    this.#control = attachControl(buffer)
    this.#slotBytes = this.#control[SNAPSHOT_CONTROL.SLOT_BYTES] ?? 0
  }

  /**
   * The sequence the writer last published, without decoding anything.
   *
   * Read unsigned so it keeps agreeing with the snapshot header's `Uint32`
   * sequence once the count passes 2^31, which at 80 steps a second takes
   * about ten months of continuous play.
   */
  get sequence(): number {
    return Atomics.load(this.#control, SNAPSHOT_CONTROL.PUBLISHED) >>> 0
  }

  get slotBytes(): number {
    return this.#slotBytes
  }

  /**
   * The newest complete snapshot, or `null` if nothing has been published yet
   * or the writer lapped the reader `MAX_READ_ATTEMPTS` times running. A
   * `null` means "draw the previous frame again", never "the world is empty".
   */
  read(): Snapshot | null {
    for (let attempt = 0; attempt < MAX_READ_ATTEMPTS; attempt += 1) {
      const slot = Atomics.load(this.#control, SNAPSHOT_CONTROL.LATEST_SLOT)
      if (slot < 0 || slot >= SNAPSHOT_SLOTS) return null

      const versionIndex = SNAPSHOT_CONTROL.SLOT_VERSION + slot
      const before = Atomics.load(this.#control, versionIndex)
      if ((before & 1) === 1) continue

      const snapshot = decodeSnapshot(
        this.buffer,
        SNAPSHOT_CONTROL_BYTES + slot * this.#slotBytes,
        this.#slotBytes,
      )

      const after = Atomics.load(this.#control, versionIndex)
      if (after !== before) continue

      // The version held still across the whole decode, so whatever came out
      // is one complete snapshot. A null here is genuine corruption.
      return snapshot
    }

    return null
  }

  /** `read`, but skips the decode when the caller already has this sequence. */
  readIfNewer(lastSequence: number): Snapshot | null {
    if (this.sequence === lastSequence) return null
    return this.read()
  }
}
