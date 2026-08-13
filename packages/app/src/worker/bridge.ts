/**
 * The main thread's handle on the simulation worker (PRD 4.6).
 *
 * What the renderer and the UI need, and nothing else:
 *
 *   - `latestSnapshot()` — the newest complete frame, or the previous one if
 *     the worker is mid-write. Never blocks, never throws, never waits on the
 *     worker. PRD 7.5 budgets 2ms per frame for the read and interpolation
 *     together, so this call must stay close to free.
 *   - `tiles` — the world's drawable tile arrays, and `consumeDirtyChunks()`
 *     to say which chunks of them moved.
 *   - `sendCommand(command)` — player input, applied at the start of the
 *     worker's next tick. Validated here so a malformed command fails at the
 *     call site rather than as a hash mismatch hours later.
 *   - `validate(actions)` — prices and grades a staged blueprint without
 *     touching the world (T1.5).
 *   - `setSpeed(multiplier)` — 0 to pause, then PRD 3.9's 1, 2, 5 and 20.
 *
 * **Transport choice.** `SharedArrayBuffer` needs cross-origin isolation, which
 * needs COOP and COEP headers, which some iPadOS webview configurations do not
 * give us. So the bridge picks: isolated hosts get a shared double buffer, a
 * shared tile grid and a wait-free read; everyone else gets snapshots and tile
 * patches transferred by `postMessage`. The two paths differ only in where the
 * bytes come from — the decoder, the format and this API are identical, so
 * nothing downstream has to care, and `tiles` is the same four arrays either
 * way.
 *
 * On the fallback path the bridge holds the newest transferred snapshot and
 * decodes it lazily, inside `latestSnapshot()`. The worker can post faster than
 * the display refreshes, and decoding a frame nobody draws would spend main
 * thread time on nothing. Tile patches are the exception: they are applied on
 * arrival, because unlike a snapshot they are a delta and skipping one loses
 * the change for good.
 */

import {
  ChunkVersionReader,
  DEFAULT_SNAPSHOT_LIMITS,
  SnapshotReader,
  allocateTileGridBuffers,
  applyTilePatch,
  assertCommand,
  createChunkVersionBuffer,
  createSharedSnapshotBuffer,
  createTileMirror,
  decodeSnapshot,
  decodeTilePatch,
  sharedMemoryAvailable,
  tileCount,
} from '@blockwork/sim'
import type {
  BlueprintReport,
  Command,
  JsonValue,
  Snapshot,
  SnapshotNotification,
  SnapshotLimits,
  Tile,
  TileGridBuffers,
  TileMirror,
  UtilityRouteKind,
  UtilityRouteResult,
} from '@blockwork/sim'
import type { ReportsModel } from '@blockwork/ui'

import type {
  ControlHudPayload,
  InspectResult,
  SimEffectsMessage,
  SimWorkerInbound,
  SimWorkerOutbound,
  SnapshotTransportKind,
  TraceResult,
} from './simWorker'
import type { NotificationSettings } from './notificationPolicy'
import type { OverlayRequestMode } from './overlayData'

/** Shared empty result, so the common no-alerts frame allocates nothing. */
const EMPTY_NOTIFICATIONS: readonly SnapshotNotification[] = []

/** The subset of `Worker` the bridge uses, so tests can substitute a stub. */
export interface SimWorkerPort {
  postMessage(message: SimWorkerInbound, transfer: Transferable[]): void
  addEventListener(
    type: 'message',
    listener: (event: MessageEvent<SimWorkerOutbound>) => void,
  ): void
  addEventListener(type: 'error', listener: (event: ErrorEvent) => void): void
  addEventListener(type: 'messageerror', listener: (event: MessageEvent) => void): void
  removeEventListener(
    type: 'message',
    listener: (event: MessageEvent<SimWorkerOutbound>) => void,
  ): void
  removeEventListener(type: 'error', listener: (event: ErrorEvent) => void): void
  removeEventListener(type: 'messageerror', listener: (event: MessageEvent) => void): void
  terminate(): void
}

/**
 * True where a `SharedArrayBuffer` can actually be allocated and shared.
 *
 * Both halves matter: `crossOriginIsolated` can be false while the constructor
 * exists, and in a non-browser host such as the test runner neither is
 * guaranteed.
 */
export function sharedMemoryUsable(): boolean {
  return globalThis.crossOriginIsolated === true && sharedMemoryAvailable()
}

/**
 * One-line warning when the host is not cross-origin isolated (T8.16).
 *
 * The bridge still works over `postMessage`, but snapshot delivery is much
 * slower and there is no other signal unless we say so here.
 */
export function isolationDiagnostic(): string | null {
  if (globalThis.crossOriginIsolated === true) return null
  return 'Not cross-origin isolated — using postMessage transport instead of shared memory'
}

/** Spawns the real worker. Vite bundles the module graph behind this URL. */
export function createSimWorker(): Worker {
  return new Worker(new URL('./simWorker.ts', import.meta.url), {
    type: 'module',
    name: 'blockwork-sim',
  })
}

/**
 * A view of the shared tile grid in the same shape a patched mirror has.
 *
 * This is what collapses the two transports into one API: on the shared path
 * these arrays *are* the simulation's, so there is no copy and no staleness;
 * on the fallback path they are a mirror the patches write into. Neither the
 * renderer nor the UI can tell which it was handed, and neither should.
 */
function sharedTileView(size: number, buffers: TileGridBuffers): TileMirror {
  return {
    size,
    roomId: new Uint16Array(buffers.roomId),
    objectId: new Uint16Array(buffers.objectId),
    sectorId: new Uint16Array(buffers.sectorId),
    floorMaterial: new Uint8Array(buffers.floorMaterial),
    wallMaterial: new Uint8Array(buffers.wallMaterial),
  }
}

export interface SimBridgeOptions {
  readonly worker: SimWorkerPort
  /** Master seed for the run. */
  readonly seed: number
  /** Tiles per axis. Map sizes are content, so the caller supplies one. */
  readonly mapSize: number
  readonly limits?: SnapshotLimits
  /** Starting speed multiplier. Defaults to 1x. */
  readonly speed?: number
  /** Overrides transport detection. Tests use it to force the fallback. */
  readonly sharedMemory?: boolean
  /** First-order material grace for a new prison (T8.4). */
  readonly firstOrderGrace?: boolean
  /** Called on worker crash or message error (T8.15). */
  readonly onWorkerError?: (message: string) => void
}

export class SimBridge {
  readonly transport: SnapshotTransportKind
  readonly limits: SnapshotLimits
  readonly mapSize: number
  /** The world's drawable tiles. Shared or mirrored; the same shape either way. */
  readonly tiles: TileMirror

  readonly #worker: SimWorkerPort
  readonly #onMessage: (event: MessageEvent<SimWorkerOutbound>) => void
  readonly #onError: (event: ErrorEvent) => void
  readonly #onMessageError: (event: MessageEvent) => void
  readonly #reader: SnapshotReader | null
  readonly #chunkVersions: ChunkVersionReader | null

  /** Chunks changed but not yet redrawn. A set, so a busy chunk is one entry. */
  readonly #dirtyChunks = new Set<number>()
  readonly #pendingReports = new Map<number, (report: BlueprintReport) => void>()
  readonly #pendingInspections = new Map<number, (result: InspectResult) => void>()
  readonly #pendingTraces = new Map<number, (result: TraceResult | null) => void>()
  readonly #pendingAutoRoutes = new Map<number, (route: UtilityRouteResult | null) => void>()
  readonly #pendingOverlays = new Map<number, (values: Uint8Array) => void>()
  readonly #pendingReportSnapshots = new Map<number, (reports: ReportsModel) => void>()
  readonly #pendingSaves = new Map<
    number,
    (result: { bytes: Uint8Array; playedTicks: number }) => void
  >()
  readonly #pendingLoads = new Map<
    number,
    (result: { mapSize: number; playedTicks: number; materialIds: readonly string[] }) => void
  >()
  #notifications: SnapshotNotification[] = []
  #control: ControlHudPayload | null = null
  #effects: SimEffectsMessage | null = null

  #latest: Snapshot | null = null
  /** Fallback transport: received but not yet decoded. */
  #pending: ArrayBuffer | null = null
  #ready = false
  #error: string | null = null
  #materialIds: readonly string[] = []
  #speed: number
  /** Set when the worker paused itself; drained by `takeSpeedOverride`. */
  #speedOverride: { readonly speed: number; readonly reason: 'critical' } | null = null
  #nextRequestId = 1
  #disposed = false

  constructor(options: SimBridgeOptions) {
    this.limits = options.limits ?? DEFAULT_SNAPSHOT_LIMITS
    this.mapSize = options.mapSize
    this.#worker = options.worker
    this.#speed = options.speed ?? 1
    assertSpeed(this.#speed)

    const useSharedMemory = options.sharedMemory ?? sharedMemoryUsable()

    let snapshotBuffer: SharedArrayBuffer | null = null
    let gridBuffers: TileGridBuffers | null = null
    let chunkVersionBuffer: ArrayBufferLike | null = null

    if (useSharedMemory) {
      // Allocated here rather than in the worker so the reader is live before
      // the worker has finished booting, and so a failure to allocate surfaces
      // on the thread that can still fall back.
      snapshotBuffer = createSharedSnapshotBuffer(this.limits)
      gridBuffers = allocateTileGridBuffers(options.mapSize, true)
      chunkVersionBuffer = createChunkVersionBuffer(options.mapSize)

      this.#reader = new SnapshotReader(snapshotBuffer)
      this.#chunkVersions = new ChunkVersionReader(chunkVersionBuffer, options.mapSize)
      this.tiles = sharedTileView(options.mapSize, gridBuffers)
      this.transport = 'shared'
    } else {
      this.#reader = null
      this.#chunkVersions = null
      this.tiles = createTileMirror(options.mapSize)
      this.transport = 'transfer'
    }

    this.#onMessage = (event: MessageEvent<SimWorkerOutbound>): void => {
      this.#handle(event.data)
    }
    this.#worker.addEventListener('message', this.#onMessage)

    // Worker crash handler (T8.15).
    this.#onError = (event: ErrorEvent): void => {
      const message = event.message || 'Worker crashed'
      console.error('Blockwork worker error:', event)
      this.#error = message
      options.onWorkerError?.(message)
    }
    this.#worker.addEventListener('error', this.#onError)

    // Message deserialization failure handler (T8.15).
    this.#onMessageError = (event: MessageEvent): void => {
      const message = 'Worker message could not be deserialized'
      console.error('Blockwork worker message error:', event)
      this.#error = message
      options.onWorkerError?.(message)
    }
    this.#worker.addEventListener('messageerror', this.#onMessageError)

    const init: SimWorkerInbound = {
      type: 'sim:init',
      seed: options.seed,
      mapSize: options.mapSize,
      limits: this.limits,
      speed: this.#speed,
      ...(snapshotBuffer === null ? {} : { snapshotBuffer }),
      ...(gridBuffers === null ? {} : { gridBuffers }),
      ...(chunkVersionBuffer === null ? {} : { chunkVersionBuffer }),
      ...(options.firstOrderGrace === undefined
        ? {}
        : { firstOrderGrace: options.firstOrderGrace }),
    }
    this.#worker.postMessage(init, [])
  }

  /** True once the worker has acknowledged `sim:init`. */
  get ready(): boolean {
    return this.#ready
  }

  /** The last error the worker reported, or null. */
  get error(): string | null {
    return this.#error
  }

  /** Material ids in table order. Empty until the worker is ready. */
  get materialIds(): readonly string[] {
    return this.#materialIds
  }

  get speed(): number {
    return this.#speed
  }

  /**
   * The newest snapshot available to draw.
   *
   * Returns the previous frame when the worker has not published a new one, or
   * when a shared read lost every retry to the writer, so a caller can treat
   * the result as "the world, as of now" without special cases. Null only
   * before the very first snapshot arrives.
   */
  latestSnapshot(): Snapshot | null {
    if (this.#reader !== null) {
      const next = this.#reader.readIfNewer(this.#latest?.sequence ?? 0)
      if (next !== null) {
        this.#latest = next
        this.#collectNotifications(next)
      }
      return this.#latest
    }

    const pending = this.#pending
    if (pending !== null) {
      this.#pending = null
      const decoded = decodeSnapshot(pending)
      if (decoded !== null) {
        this.#latest = decoded
        this.#collectNotifications(decoded)
      }
    }
    return this.#latest
  }

  /**
   * Notifications raised since the last call, oldest first.
   *
   * Accumulated rather than read off the newest frame, because the delta in a
   * snapshot describes only that frame: a caller that reads the snapshot at
   * 60Hz while the worker publishes at 80Hz would otherwise silently lose the
   * alerts that landed in the frames it skipped. Frames the bridge never sees
   * at all — the shared ring keeps only the newest — are still lost, which is
   * why the worker's own event log, not this queue, is the record of truth.
   */
  consumeNotifications(): readonly SnapshotNotification[] {
    if (this.#notifications.length === 0) return EMPTY_NOTIFICATIONS
    const drained = this.#notifications
    this.#notifications = []
    return drained
  }

  #collectNotifications(snapshot: Snapshot): void {
    const added = snapshot.notifications.added
    if (added.length === 0) return
    for (const notification of added) this.#notifications.push(notification)
  }

  /**
   * Tile chunks that changed since the last call.
   *
   * On the shared transport this reads the version counters rather than the
   * snapshot's `changedChunks`, because the snapshot ring keeps only the
   * newest frame and a chunk that changed in a frame nobody read would
   * otherwise never be redrawn. On the fallback transport delivery is
   * guaranteed and the set is filled as patches arrive.
   */
  consumeDirtyChunks(): readonly number[] {
    if (this.#chunkVersions !== null) return this.#chunkVersions.consume()

    if (this.#dirtyChunks.size === 0) return []
    const chunks = [...this.#dirtyChunks]
    this.#dirtyChunks.clear()
    return chunks
  }

  /**
   * Newest Posts / Emergency / Standing Orders summaries from the worker, or
   * null before the first control publish.
   */
  latestControl(): ControlHudPayload | null {
    return this.#control
  }

  /**
   * Newest fire / tunnel overlay payload from the worker, or null before the
   * first effects publish.
   */
  latestEffects(): SimEffectsMessage | null {
    return this.#effects
  }

  /** Queues a player command for the start of the worker's next tick. */
  sendCommand(command: Command): void {
    this.#assertLive()
    assertCommand(command)
    this.#worker.postMessage({ type: 'sim:command', command }, [])
  }

  /**
   * Prices and grades staged build actions against the live world.
   *
   * Resolves when the worker replies. Nothing is charged and nothing is built:
   * the worker runs the actions against a detached copy. Callers that
   * re-validate on every stroke should drop a reply whose request is no longer
   * the newest — the promise for a superseded request still resolves, because
   * leaving it pending forever would leak.
   */
  async validate(actions: readonly JsonValue[]): Promise<BlueprintReport> {
    this.#assertLive()
    const requestId = this.#nextRequestId
    this.#nextRequestId += 1

    return new Promise<BlueprintReport>((resolve) => {
      this.#pendingReports.set(requestId, resolve)
      this.#worker.postMessage({ type: 'sim:validate', requestId, actions }, [])
    })
  }

  /**
   * Asks what is on a tile, for the inspector.
   *
   * A question rather than a lookup, because the answer needs registries the
   * main thread does not hold: the room's requirement status, the object's
   * utilities, and the display names both come from the worker's `GameData`.
   */
  async inspect(tile: Tile): Promise<InspectResult> {
    this.#assertLive()
    const requestId = this.#nextRequestId
    this.#nextRequestId += 1

    return new Promise<InspectResult>((resolve) => {
      this.#pendingInspections.set(requestId, resolve)
      this.#worker.postMessage({ type: 'sim:inspect', requestId, tile }, [])
    })
  }

  /**
   * The causal chain behind a notification (PRD 3.1), resolved to display
   * strings by the worker.
   *
   * Passing the `notificationId` pins the chain for as long as its toast
   * lives; `releaseTrace` gives it back. Resolves to null when the chain is
   * gone, which the panel treats as nothing to open.
   */
  async trace(traceId: number, notificationId = 0): Promise<TraceResult | null> {
    this.#assertLive()
    const requestId = this.#nextRequestId
    this.#nextRequestId += 1

    return new Promise<TraceResult | null>((resolve) => {
      this.#pendingTraces.set(requestId, resolve)
      this.#worker.postMessage({ type: 'sim:trace', requestId, traceId, notificationId }, [])
    })
  }

  /** Drops the pin a dismissed toast held on its chain. */
  releaseTrace(notificationId: number): void {
    if (this.#disposed) return
    this.#worker.postMessage({ type: 'sim:untrace', notificationId }, [])
  }

  /**
   * Shortest cable/pipe run from a tile to the nearest live utility node
   * (PRD 3.4). Null when nothing is reachable.
   */
  async autoRoute(tile: Tile, kind: UtilityRouteKind): Promise<UtilityRouteResult | null> {
    this.#assertLive()
    const requestId = this.#nextRequestId
    this.#nextRequestId += 1

    return new Promise<UtilityRouteResult | null>((resolve) => {
      this.#pendingAutoRoutes.set(requestId, resolve)
      this.#worker.postMessage({ type: 'sim:autoRoute', requestId, tile, kind }, [])
    })
  }

  /** Reads one current PRD 6.4 overlay from the authoritative worker world. */
  async overlay(mode: OverlayRequestMode, needId?: string): Promise<Uint8Array> {
    this.#assertLive()
    const requestId = this.#nextRequestId
    this.#nextRequestId += 1

    return new Promise<Uint8Array>((resolve) => {
      this.#pendingOverlays.set(requestId, resolve)
      this.#worker.postMessage(
        {
          type: 'sim:overlay',
          requestId,
          mode,
          ...(needId === undefined ? {} : { needId }),
        },
        [],
      )
    })
  }

  /** Requests one bounded PRD 6.2 snapshot from the authoritative worker. */
  async reports(): Promise<ReportsModel> {
    this.#assertLive()
    const requestId = this.#nextRequestId
    this.#nextRequestId += 1

    return new Promise<ReportsModel>((resolve) => {
      this.#pendingReportSnapshots.set(requestId, resolve)
      this.#worker.postMessage({ type: 'sim:reports', requestId }, [])
    })
  }

  /**
   * Captures the live world as `.blockwork` bytes for autosave / export.
   *
   * `createdAt` is ISO 8601 from the host — the worker must not read the wall
   * clock. Returns the container bytes plus the tick stamped into the save.
   */
  async exportSave(createdAt: string): Promise<{ bytes: Uint8Array; playedTicks: number }> {
    this.#assertLive()
    const requestId = this.#nextRequestId
    this.#nextRequestId += 1

    return new Promise<{ bytes: Uint8Array; playedTicks: number }>((resolve) => {
      this.#pendingSaves.set(requestId, resolve)
      this.#worker.postMessage({ type: 'sim:save', requestId, createdAt }, [])
    })
  }

  /**
   * Loads a `.blockwork` save, replacing the current simulation state (T8.6).
   *
   * The bytes are transferred to the worker. On success, returns the loaded
   * map size, played ticks, and new material palette. The caller is
   * responsible for updating any UI state that depends on these.
   */
  async load(
    bytes: Uint8Array,
  ): Promise<{ mapSize: number; playedTicks: number; materialIds: readonly string[] }> {
    this.#assertLive()
    const requestId = this.#nextRequestId
    this.#nextRequestId += 1

    const copy = bytes.slice()
    const buffer = copy.buffer

    return new Promise<{
      mapSize: number
      playedTicks: number
      materialIds: readonly string[]
    }>((resolve) => {
      this.#pendingLoads.set(requestId, resolve)
      this.#worker.postMessage({ type: 'sim:load', requestId, buffer }, [buffer])
    })
  }

  /** 0 pauses. PRD 3.9's ladder is 1, 2, 5 and 20. */
  setSpeed(multiplier: number): void {
    this.#assertLive()
    assertSpeed(multiplier)
    this.#speed = multiplier
    this.#worker.postMessage({ type: 'sim:speed', speed: multiplier }, [])
  }

  /**
   * Mute a notification category, or turn auto-pause on (T6.3, PRD 6.5).
   *
   * Partial by design: the alerts panel toggles one switch at a time.
   */
  setNotificationSettings(settings: Partial<NotificationSettings>): void {
    this.#assertLive()
    this.#worker.postMessage({ type: 'sim:notifications', settings }, [])
  }

  /**
   * The speed the worker last told us it is running at, or null if it has
   * never overridden us.
   *
   * Auto-pause means the worker can stop the clock on its own, and the speed
   * control has to show what is true rather than what was asked for.
   */
  takeSpeedOverride(): { readonly speed: number; readonly reason: 'critical' } | null {
    const override = this.#speedOverride
    this.#speedOverride = null
    return override
  }

  /** Stops the loop and tears the worker down. The bridge is unusable after. */
  dispose(): void {
    if (this.#disposed) return
    this.#disposed = true
    this.#worker.postMessage({ type: 'sim:stop' }, [])
    this.#worker.removeEventListener('message', this.#onMessage)
    this.#worker.removeEventListener('error', this.#onError)
    this.#worker.removeEventListener('messageerror', this.#onMessageError)
    this.#worker.terminate()
    this.#pendingReports.clear()
    this.#pendingInspections.clear()
    this.#pendingTraces.clear()
    this.#pendingAutoRoutes.clear()
    this.#pendingOverlays.clear()
    this.#pendingReportSnapshots.clear()
    this.#pendingSaves.clear()
    this.#pendingLoads.clear()
  }

  #handle(message: SimWorkerOutbound): void {
    switch (message.type) {
      case 'sim:ready':
        this.#ready = true
        this.#materialIds = message.materialIds
        break
      case 'sim:snapshot':
        // Only the newest matters: an undrawn frame is a frame nobody misses.
        this.#pending = message.buffer
        break
      case 'sim:tiles': {
        // Applied now, not lazily: a patch is a delta, and one that is skipped
        // is a change that never reaches the screen.
        const patch = decodeTilePatch(message.buffer)
        if (patch === null) break
        for (const chunkId of applyTilePatch(this.tiles, patch)) {
          this.#dirtyChunks.add(chunkId)
        }
        break
      }
      case 'sim:report': {
        const resolve = this.#pendingReports.get(message.requestId)
        if (resolve === undefined) break
        this.#pendingReports.delete(message.requestId)
        resolve(message.report)
        break
      }
      case 'sim:inspected': {
        const resolve = this.#pendingInspections.get(message.requestId)
        if (resolve === undefined) break
        this.#pendingInspections.delete(message.requestId)
        resolve(message.result)
        break
      }
      case 'sim:traced': {
        const resolve = this.#pendingTraces.get(message.requestId)
        if (resolve === undefined) break
        this.#pendingTraces.delete(message.requestId)
        resolve(message.result)
        break
      }
      case 'sim:autoRouted': {
        const resolve = this.#pendingAutoRoutes.get(message.requestId)
        if (resolve === undefined) break
        this.#pendingAutoRoutes.delete(message.requestId)
        resolve(message.route)
        break
      }
      case 'sim:overlayed': {
        const resolve = this.#pendingOverlays.get(message.requestId)
        if (resolve === undefined) break
        this.#pendingOverlays.delete(message.requestId)
        resolve(new Uint8Array(message.buffer))
        break
      }
      case 'sim:reported': {
        const resolve = this.#pendingReportSnapshots.get(message.requestId)
        if (resolve === undefined) break
        this.#pendingReportSnapshots.delete(message.requestId)
        resolve(message.reports)
        break
      }
      case 'sim:saved': {
        const resolve = this.#pendingSaves.get(message.requestId)
        if (resolve === undefined) break
        this.#pendingSaves.delete(message.requestId)
        resolve({
          bytes: new Uint8Array(message.buffer),
          playedTicks: message.playedTicks,
        })
        break
      }
      case 'sim:loaded': {
        const resolve = this.#pendingLoads.get(message.requestId)
        if (resolve === undefined) break
        this.#pendingLoads.delete(message.requestId)
        this.#materialIds = message.materialIds
        this.#latest = null
        this.#pending = null
        this.#dirtyChunks.clear()
        resolve({
          mapSize: message.mapSize,
          playedTicks: message.playedTicks,
          materialIds: message.materialIds,
        })
        break
      }
      case 'sim:speedChanged':
        this.#speed = message.speed
        this.#speedOverride = { speed: message.speed, reason: message.reason }
        break
      case 'sim:control':
        this.#control = message.control
        break
      case 'sim:effects':
        this.#effects = message
        break
      case 'sim:error':
        this.#error = message.message
        break
    }
  }

  #assertLive(): void {
    if (this.#disposed) {
      throw new Error('the simulation bridge has been disposed')
    }
  }
}

/** Tiles in the map this bridge is bound to. Handy for sizing render buffers. */
export function bridgeTileCount(bridge: SimBridge): number {
  return tileCount(bridge.mapSize)
}

function assertSpeed(multiplier: number): void {
  if (!Number.isFinite(multiplier) || multiplier < 0) {
    throw new RangeError(`speed multiplier must be a finite number >= 0, received ${multiplier}`)
  }
}
