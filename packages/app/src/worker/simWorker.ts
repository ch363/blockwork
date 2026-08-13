/**
 * The simulation worker (PRD 4.6).
 *
 * Everything in `packages/sim` runs here, on its own thread, so a 11ms
 * simulation step and a 14ms frame never queue behind each other. The main
 * thread's only jobs are drawing and input; see `bridge.ts` for its half.
 *
 * **Pacing.** PRD 4.1 fixes the simulation at 10 ticks per in-game minute but
 * only `4 * speedMultiplier` steps per real second, so 1x is 4 steps a second
 * and 20x is 80. The loop is driven by accumulated `performance.now()` deltas
 * rather than `setInterval`, for two reasons: `setInterval` drifts and coalesces
 * under load, silently changing how fast the game runs, and it gives no way to
 * notice that a slice took longer than its budget. Accumulation makes the real
 * elapsed time the source of truth and the step count the consequence.
 *
 * `setTimeout` still schedules the *slices*, but a slice runs however many
 * steps the accumulator has earned, including none. Nothing in the simulation
 * ever sees a delta time (CLAUDE.md rule 3): the accumulator converts real
 * seconds into a whole number of integer ticks out here, and `Simulation.step()`
 * takes no argument.
 *
 * **Transport.** Where the host is cross-origin isolated the main thread hands
 * over a `SharedArrayBuffer` and the worker writes snapshots straight into it.
 * Where it is not — several iPadOS webview configurations, per PRD 4.6 — the
 * worker encodes each snapshot into its own `ArrayBuffer` and transfers it by
 * `postMessage`. Same bytes, same decoder, one branch.
 *
 * The module is import-safe: it only attaches to the worker global when it is
 * actually running inside one, so tests can drive `startSimWorker` against a
 * stub scope.
 */

import {
  ChunkVersionWriter,
  CausalEventLog,
  DEFAULT_SNAPSHOT_LIMITS,
  MAX_SAVED_LOG_ENTRIES,
  SnapshotWriter,
  actionFromJson,
  autoRouteUtility,
  buildTrace,
  captureInmateWorld,
  createGame,
  encodeSnapshotToTransferable,
  encodeTilePatch,
  isInmateWorld,
  isTruncated,
  loadGameData,
  nextSequence,
  notificationKindId,
  parseTraceStrings,
  saveToBytes,
  ticksToDay,
  ticksToTimeString,
  uniformWorkforce,
  validateBlueprint,
} from '@blockwork/sim'
import { RAW_TRACE_STRINGS } from '@blockwork/data'
import type {
  DirectorateModel,
  EmergencyModel,
  IntelligenceModel,
  PostsModel,
  ProgramsModel,
  ReportsModel,
  StandingOrdersModel,
} from '@blockwork/ui'
import type {
  BlueprintReport,
  BuildAction,
  Command,
  EventSink,
  Game,
  JsonValue,
  LogEntry,
  RoomRequirement,
  Simulation,
  Tile,
  SimulationEvent,
  SnapshotContents,
  SnapshotEntity,
  SnapshotLimits,
  SnapshotNotification,
  TileGridBuffers,
  UiDigest,
  InmateWorld,
  InmateEntity,
  StaffEntity,
  GameData,
  UtilityRouteKind,
  UtilityRouteResult,
} from '@blockwork/sim'

import { buildGameDigest, collectGameEntities } from './collectAgents'
import { buildControlHud } from './controlHud'
import { NotificationPolicy, severityForKind } from './notificationPolicy'
import type { NotificationSettings } from './notificationPolicy'
import { describeRoomGrade } from './roomGrade'
import type { UnlockSnapshot } from '../game/palette'
import { buildOverlayData } from './overlayData'
import type { OverlayRequestMode } from './overlayData'
import {
  buildReportsModel,
  newestCausalEvents,
  resolveEventPresentation,
} from './reportData'

/**
 * Trace copy, validated once at module load.
 *
 * It lives on this side of the worker boundary because the panel is handed
 * finished sentences: the templates need each event's own `data` to fill in,
 * and that data never leaves the simulation.
 */
const TRACE_CATALOGUE = parseTraceStrings(RAW_TRACE_STRINGS)

/** PRD 4.1: steps per real second at 1x. Speed scales it linearly. */
export const STEPS_PER_SECOND_AT_1X = 4

/**
 * How far behind real time the loop will try to catch up in one slice.
 *
 * A backgrounded tab or a locked iPad stops delivering timers, and without a
 * clamp the first slice after resuming would run every step it "missed" and
 * freeze the thread for seconds. Clamping means a backgrounded prison pauses
 * rather than fast-forwards, which is also what the autosave-on-background
 * behaviour in PRD 7.4 assumes.
 */
export const MAX_CATCHUP_MS = 250

/** A second guard on the same problem, in case a slice is handed a huge delta. */
export const MAX_STEPS_PER_SLICE = 64

/**
 * Slice cadence. Browsers clamp nested timers to about 4ms, so this is the
 * floor in practice; it gives roughly 250 slices a second, comfortably more
 * than the 80 steps a second that 20x needs.
 */
export const SLICE_INTERVAL_MS = 4

export type SnapshotTransportKind = 'shared' | 'transfer'

/** Boots the simulation. `snapshotBuffer` present means the shared transport. */
export interface SimInitMessage {
  readonly type: 'sim:init'
  readonly seed: number
  readonly mapSize: number
  readonly limits: SnapshotLimits
  readonly speed: number
  readonly snapshotBuffer?: SharedArrayBuffer
  /** Shared per-chunk version counters. Present with `gridBuffers`. */
  readonly chunkVersionBuffer?: ArrayBufferLike
  /**
   * Shared buffers to build the tile grid over. Present only on the shared
   * transport, where the renderer reads the simulation's own tile bytes and no
   * tile data is ever sent. Absent means the worker packs changed chunks into
   * `sim:tiles` messages instead.
   */
  readonly gridBuffers?: TileGridBuffers
  /**
   * Headcount the construction system pretends is on every site.
   *
   * Phase 2 brings agents and this goes away. Until then a prison with no
   * workers never finishes a wall, which makes every acceptance case in T1.2
   * and T1.3 untestable in the running game rather than only in a unit test.
   */
  readonly builders?: number
}

export interface SimCommandMessage {
  readonly type: 'sim:command'
  readonly command: Command
}

export interface SimSpeedMessage {
  readonly type: 'sim:speed'
  /** 0 is pause. PRD 3.9 offers 1, 2, 5 and 20. */
  readonly speed: number
}

export interface SimStopMessage {
  readonly type: 'sim:stop'
}

/**
 * Per-category mute and auto-pause (T6.3, PRD 6.5). Partial: the alerts panel
 * toggles one thing at a time and should not have to restate the rest.
 */
export interface SimNotificationSettingsMessage {
  readonly type: 'sim:notifications'
  readonly settings: Partial<NotificationSettings>
}

/**
 * The worker changed the speed itself.
 *
 * Only auto-pause does this today. It is a distinct kind from the inbound
 * `sim:speed` so the main thread cannot mistake its own request echoing back
 * for the worker overriding it.
 */
export interface SimSpeedChangedMessage {
  readonly type: 'sim:speedChanged'
  readonly speed: number
  readonly reason: 'critical'
}

/**
 * Prices and grades a staged blueprint against the live world (T1.5).
 *
 * The blueprint itself stays on the main thread — it is staged, not applied,
 * and nothing is charged until Commit. But `validateBlueprint` is pure and has
 * to run somewhere that holds the authoritative world, and that is here. The
 * reply is advisory: the world is not touched, and the same actions committed
 * a tick later may be refused for reasons that appeared in between.
 */
export interface SimValidateMessage {
  readonly type: 'sim:validate'
  /** Echoed back on the reply, so a stale answer can be dropped. */
  readonly requestId: number
  /** `actionToJson` output, one per staged stroke. */
  readonly actions: readonly JsonValue[]
}

/**
 * Asks what is on a tile (PRD 6.2's inspector).
 *
 * The renderer's mirror knows which room id a tile carries, and nothing else:
 * not the room's requirement status, not the object's power state, not the
 * display name of either. Those live in registries the main thread does not
 * and should not hold a copy of, so selecting a tile is a question, not a
 * lookup.
 */
export interface SimInspectMessage {
  readonly type: 'sim:inspect'
  readonly requestId: number
  readonly tile: Tile
}

/**
 * Asks for the causal chain behind a notification (PRD 3.1 / T3.1).
 *
 * The chain is text, and text never crosses the snapshot buffer — the header
 * carries only a `traceId`. So the panel is a question too: the worker walks
 * the DAG, resolves the catalogue strings against each event's own data, and
 * sends back a tree that is already renderable.
 *
 * `notificationId` pins the chain for as long as its toast is on screen, so a
 * Trace the player has not opened yet cannot age out of the ring buffer
 * underneath them.
 */
export interface SimTraceMessage {
  readonly type: 'sim:trace'
  readonly requestId: number
  readonly traceId: number
  /** Notification holding this chain, or 0 for an unpinned one-off lookup. */
  readonly notificationId: number
}

/** Releases the pin taken by `sim:trace` when its toast is dismissed. */
export interface SimUntraceMessage {
  readonly type: 'sim:untrace'
  readonly notificationId: number
}

/**
 * Shortest utility run from a tile to the nearest live cable/pipe (PRD 3.4).
 *
 * Pure preview: the world is not mutated. The session stages the path as
 * blueprint cable/pipe strokes when placing a powered or plumbed object.
 */
export interface SimAutoRouteMessage {
  readonly type: 'sim:autoRoute'
  readonly requestId: number
  readonly tile: Tile
  readonly kind: UtilityRouteKind
}

/**
 * Captures the live InmateWorld into `.blockwork` bytes for autosave / export.
 *
 * `createdAt` is owned by the host because the simulation may not read the
 * wall clock (CLAUDE.md rule 3).
 */
export interface SimSaveMessage {
  readonly type: 'sim:save'
  readonly requestId: number
  readonly createdAt: string
}

/** Requests a fresh authoritative data texture for one PRD 6.4 overlay. */
export interface SimOverlayMessage {
  readonly type: 'sim:overlay'
  readonly requestId: number
  readonly mode: OverlayRequestMode
  readonly needId?: string
}

/** Requests one bounded, authoritative PRD 6.2 report snapshot. */
export interface SimReportsRequestMessage {
  readonly type: 'sim:reports'
  readonly requestId: number
}

export type SimWorkerInbound =
  | SimInitMessage
  | SimCommandMessage
  | SimSpeedMessage
  | SimStopMessage
  | SimValidateMessage
  | SimInspectMessage
  | SimTraceMessage
  | SimUntraceMessage
  | SimAutoRouteMessage
  | SimOverlayMessage
  | SimReportsRequestMessage
  | SimNotificationSettingsMessage
  | SimSaveMessage

export interface SimReadyMessage {
  readonly type: 'sim:ready'
  readonly transport: SnapshotTransportKind
  readonly mapSize: number
  /** Material ids in table order, so the renderer can colour what it draws. */
  readonly materialIds: readonly string[]
}

/** Fallback transport only. The buffer is transferred, not copied. */
export interface SimSnapshotMessage {
  readonly type: 'sim:snapshot'
  readonly buffer: ArrayBuffer
}

/**
 * Changed tile chunks, fallback transport only.
 *
 * On the shared transport the renderer reads the grid directly and this
 * message is never sent. See `tilePatch.ts` for why the two paths differ.
 */
export interface SimTilesMessage {
  readonly type: 'sim:tiles'
  readonly buffer: ArrayBuffer
}

export interface SimReportMessage {
  readonly type: 'sim:report'
  readonly requestId: number
  readonly report: BlueprintReport
}

/** One need row for the inspector (display-ready). */
export interface InspectNeed {
  readonly id: string
  readonly name: string
  readonly value: number
  readonly severity: 'ok' | 'medium' | 'high' | 'critical' | 'active'
}

export interface InspectReputation {
  readonly id: string
  readonly name: string
  readonly tone: 'bad' | 'warn' | 'info' | 'ghost'
}

export interface InspectMisconduct {
  readonly day: number
  readonly label: string
  readonly outcome: string
}

export interface InspectGrade {
  readonly id: string
  readonly label: string
  readonly letter: string
  readonly score: number
  readonly tone: 'ok' | 'warn' | 'danger'
}

/**
 * The answer to `sim:inspect`, in the shape the inspector renders.
 *
 * Names, not ids: the data layer owns display strings and the UI package
 * cannot hold a `GameData`. Everything here is structured-cloneable.
 */
export type InspectResult =
  | {
      readonly kind: 'inmate'
      readonly entityId: number
      readonly name: string
      readonly subtitle: string
      readonly categoryId: string
      readonly categoryName: string
      readonly criticalNeedCount: number
      readonly sentenceServedLabel: string
      readonly sentenceTotalLabel: string
      readonly sentenceProgress: number
      readonly paroleLabel: string | null
      readonly needs: readonly InspectNeed[]
      readonly traits: readonly string[]
      readonly reputations: readonly InspectReputation[]
      readonly unknownReputationCount: number
      readonly activity: string
      readonly cellLabel: string
      readonly entitlement: number
      readonly suppression: number
      readonly workLabel: string
      readonly programmeLabel: string
      readonly grades: readonly InspectGrade[]
      readonly reoffendPercent: number
      readonly misconduct: readonly InspectMisconduct[]
      readonly centre: Tile
    }
  | {
      readonly kind: 'staff'
      readonly entityId: number
      readonly name: string
      readonly roleName: string
      readonly wagePerHour: number
      readonly needs: readonly InspectNeed[]
      readonly moraleContribution: number
      readonly currentTask: string
      readonly postAssignment: string
      readonly equipment: readonly string[]
      readonly centre: Tile
    }
  | {
      readonly kind: 'room'
      readonly roomId: number
      readonly name: string
      readonly typeName: string
      readonly width: number
      readonly height: number
      readonly tiles: number
      readonly functional: boolean
      readonly requirements: readonly RoomRequirement[]
      readonly properties: readonly string[]
      readonly occupants: number
      readonly gradeLines: readonly {
        readonly label: string
        readonly points: number
        readonly detail: string | null
      }[]
      readonly grade: number | null
      readonly gradeMax: number
      readonly throughputLabel: string | null
      readonly centre: Tile
    }
  | {
      readonly kind: 'object'
      readonly entityId: number
      readonly name: string
      readonly cost: number
      readonly hasPower: boolean
      readonly hasWater: boolean
      readonly needsPower: boolean
      readonly needsWater: boolean
      readonly roomName: string | null
      readonly condition: number
      readonly conditionMax: number
      readonly needsServed: readonly string[]
      readonly contrabandRisk: number
      readonly centre: Tile
    }
  | {
      readonly kind: 'tile'
      readonly x: number
      readonly y: number
      readonly floorName: string
      readonly wallName: string | null
      readonly roomName: string | null
      readonly walkable: boolean
      readonly centre: Tile
    }

export interface SimInspectResultMessage {
  readonly type: 'sim:inspected'
  readonly requestId: number
  readonly result: InspectResult
}

/** One node of a resolved Trace, ready to render (PRD 3.1). */
export interface TraceNodeResult {
  readonly eventId: number
  readonly subjectId: number
  readonly title: string
  readonly detail: string
  readonly meta: string
  readonly isRootCause: boolean
  readonly tick: number
  /**
   * Where to pan when the node is tapped, or null when the subject is not on
   * the map. Resolved here because only the worker can turn a subject id into
   * a tile — the main thread holds no registries.
   */
  readonly focus: Tile | null
}

export interface TraceResult {
  readonly rootId: number
  readonly nodes: readonly TraceNodeResult[]
  readonly fixes: readonly { readonly id: string; readonly label: string }[]
  readonly reportText: string
  /** Day / time of the tip, for the panel subtitle. */
  readonly subtitle: string
}

export interface SimTraceResultMessage {
  readonly type: 'sim:traced'
  readonly requestId: number
  /** Null when the chain has been evicted or the id was never recorded. */
  readonly result: TraceResult | null
}

export interface SimControlMessage {
  readonly type: 'sim:control'
  readonly control: ControlHudPayload
}

/**
 * Fire tiles and discovered tunnels for the interim overlay layer (Phase 4).
 *
 * Published beside `sim:control` so the main thread can paint emergencies and
 * dug routes without holding FireGrid / EscapeState.
 */
export interface SimEffectsMessage {
  readonly type: 'sim:effects'
  readonly fire: readonly {
    readonly index: number
    readonly intensity: number
    readonly smoke: number
  }[]
  readonly tunnels: readonly {
    readonly id: number
    readonly originTile: number
    readonly tiles: readonly number[]
  }[]
}

/** Panel summaries transferred with each snapshot (T4.1 / T4.3 / T4.6 / T5.x). */
export interface ControlHudPayload {
  readonly posts: PostsModel
  readonly emergency: EmergencyModel
  readonly standingOrders: StandingOrdersModel
  readonly directorate: DirectorateModel
  readonly programs: ProgramsModel
  readonly intelligence: IntelligenceModel
  readonly unlocks: UnlockSnapshot
}

export interface SimErrorMessage {
  readonly type: 'sim:error'
  readonly message: string
}

export interface SimAutoRoutedMessage {
  readonly type: 'sim:autoRouted'
  readonly requestId: number
  readonly route: UtilityRouteResult | null
}

export interface SimSavedMessage {
  readonly type: 'sim:saved'
  readonly requestId: number
  /** Transferred ArrayBuffer of a `.blockwork` container. */
  readonly buffer: ArrayBuffer
  readonly playedTicks: number
}

export interface SimOverlayResultMessage {
  readonly type: 'sim:overlayed'
  readonly requestId: number
  readonly mode: OverlayRequestMode
  readonly buffer: ArrayBuffer
}

export interface SimReportsResultMessage {
  readonly type: 'sim:reported'
  readonly requestId: number
  readonly reports: ReportsModel
}

export type SimWorkerOutbound =
  | SimReadyMessage
  | SimSnapshotMessage
  | SimTilesMessage
  | SimReportMessage
  | SimInspectResultMessage
  | SimTraceResultMessage
  | SimControlMessage
  | SimEffectsMessage
  | SimOverlayResultMessage
  | SimReportsResultMessage
  | SimAutoRoutedMessage
  | SimSavedMessage
  | SimSpeedChangedMessage
  | SimErrorMessage

export type PostToMain = (message: SimWorkerOutbound, transfer: Transferable[]) => void

/**
 * The seam the entity store plugs into. Production always collects inmates and
 * staff; tests may override with a stub collector.
 */
export type EntityCollector = (tick: number, out: SnapshotEntity[]) => void

/**
 * The seam for the top-bar digest. Population, danger and balance come from
 * the live world; tests may override with a stub builder.
 */
export type DigestBuilder = (tick: number, alerts: number) => UiDigest

/**
 * Turns simulation events into notification records for the snapshot, and
 * records them in the CausalEvent log so the Trace panel can reconstruct the
 * chain (PRD 3.1 / T3.1).
 *
 * Pinning an active notification's tip (`log.pin` / `unpinTrace`) is available
 * for the host once toast dismiss is wired across the worker boundary. The
 * relay itself only assigns ids, subject, severity and `traceId`.
 */
class NotificationRelay implements EventSink {
  readonly log: CausalEventLog
  readonly policy: NotificationPolicy
  readonly #capacity: number
  #pending: SnapshotNotification[] = []
  #nextId = 1
  #alerts = 0
  #dropped = 0
  /** notification id → CausalEvent tip, when the host has asked to pin. */
  readonly #pinnedTraces = new Map<number, number>()
  /** Trace tip of each open group, so a regrouped toast still opens a chain. */
  readonly #groupTraceIds = new Map<number, number>()

  constructor(
    capacity: number,
    log: CausalEventLog = new CausalEventLog(),
    policy: NotificationPolicy = new NotificationPolicy(),
  ) {
    this.#capacity = capacity
    this.log = log
    this.policy = policy
  }

  emit(event: SimulationEvent): void {
    const recorded = this.log.record(event)

    const action = this.policy.admit({
      kind: recorded.kind,
      subjectId: recorded.subjectId,
      tick: recorded.tick,
    })
    // Info and muted categories are logged and nothing else: a muted category
    // must not badge either, or the mute is a lie (PRD 6.5).
    if (action.kind === 'drop') return

    if (action.kind === 'group') {
      // Republished under the *same* id, so the main thread updates the toast
      // it already has rather than stacking a second one. The count is the
      // whole point of the collapse.
      this.#republish({
        id: action.notificationId,
        tick: recorded.tick,
        kindId: notificationKindId(recorded.kind),
        subjectId: recorded.subjectId,
        traceId: this.#groupTraceIds.get(action.notificationId) ?? recorded.id,
        severity: action.severity,
        count: action.count,
      })
      return
    }

    // Counted after the INFO / mute gates: the badge means "warnings you have
    // not read", and neither of those is one.
    this.#alerts += 1

    if (this.#pending.length >= this.#capacity) {
      this.#dropped += 1
      return
    }

    const id = this.#nextId
    this.#pending.push({
      id,
      tick: recorded.tick,
      kindId: notificationKindId(recorded.kind),
      subjectId: recorded.subjectId,
      traceId: recorded.id,
      severity: action.severity,
      count: 1,
    })
    this.#groupTraceIds.set(id, recorded.id)
    this.policy.recordRaised({
      kind: recorded.kind,
      subjectId: recorded.subjectId,
      tick: recorded.tick,
      notificationId: id,
    })
    this.#nextId = this.#nextId >= 0xffff_ffff ? 1 : this.#nextId + 1
  }

  /**
   * Replaces a pending record with the same id, or appends one.
   *
   * A group that fires twice between snapshots must cross the boundary once,
   * with the final count — otherwise the reader sees the same id twice in one
   * delta and has to guess which is newer.
   */
  #republish(record: SnapshotNotification): void {
    const index = this.#pending.findIndex((entry) => entry.id === record.id)
    if (index >= 0) {
      this.#pending[index] = record
      return
    }
    if (this.#pending.length >= this.#capacity) {
      this.#dropped += 1
      return
    }
    this.#pending.push(record)
  }

  /** Pin a drained notification's tip so its Trace chain survives eviction. */
  pinTrace(notificationId: number, traceId: number): void {
    if (this.#pinnedTraces.has(notificationId)) return
    this.log.pin(traceId)
    this.#pinnedTraces.set(notificationId, traceId)
  }

  /** Release the pin held by a dismissed notification. */
  unpinTrace(notificationId: number): void {
    const tip = this.#pinnedTraces.get(notificationId)
    if (tip === undefined) return
    this.#pinnedTraces.delete(notificationId)
    this.log.unpin(tip)
  }

  /** Every notification raised since the last snapshot, left in place. */
  peek(): readonly SnapshotNotification[] {
    return this.#pending
  }

  /** Every notification raised since the last snapshot. */
  drain(): SnapshotNotification[] {
    const drained = this.#pending
    this.#pending = []
    return drained
  }

  get alerts(): number {
    return this.#alerts
  }

  /** Notifications discarded because the relay was full between snapshots. */
  get dropped(): number {
    return this.#dropped
  }

  /**
   * The persistent event-log window written into `SaveFile.log`.
   *
   * It is intentionally the same newest 2,000 events the Reports Log reads.
   * The causal ring may retain more for Trace reconstruction, but old
   * informational noise must not make saves grow without bound.
   */
  savedLog(): readonly LogEntry[] {
    return newestCausalEvents(this.log.retainedEvents(), MAX_SAVED_LOG_ENTRIES).map((event) => {
      const presentation = resolveEventPresentation(event, severityForKind)
      return {
        id: event.id,
        tick: event.tick,
        kind: event.kind,
        subjectId: event.subjectId,
        causeIds: [...event.causeIds],
        data: event.data,
        severity: presentation.notificationSeverity,
        traceId: presentation.traceId ?? 0,
      }
    })
  }
}

/**
 * Failures and warnings surface as toasts; everything else stays log-only.
 *
 * Registration in the Trace catalogue is the test, and deliberately so: a
 * notification's whole job is to be tappable (PRD 3.1), and a kind with no
 * catalogue entry has no chain to show. Systems emit far more than failures —
 * every object placed, every room graded — and treating those as alerts both
 * buries the real ones and makes the badge count meaningless.
 */
export interface SimWorkerLoopOptions {
  readonly seed: number
  /** Tiles per axis. Supplied by the caller: map sizes are content, not code. */
  readonly mapSize: number
  readonly post: PostToMain
  readonly limits?: SnapshotLimits
  /** Present for the shared transport, absent for the `postMessage` fallback. */
  readonly snapshotBuffer?: SharedArrayBuffer
  /** Shared tile buffers. Present exactly when `snapshotBuffer` is. */
  readonly gridBuffers?: TileGridBuffers
  /** Shared per-chunk version counters. Present with `gridBuffers`. */
  readonly chunkVersionBuffer?: ArrayBufferLike
  readonly speed?: number
  readonly builders?: number
  readonly collectEntities?: EntityCollector
  readonly buildDigest?: DigestBuilder
}

/**
 * The simulation plus its snapshot publishing. Knows nothing about timers or
 * about the worker global, so a test can step it by hand.
 */
export class SimWorkerLoop {
  readonly game: Game
  readonly simulation: Simulation
  readonly world: InmateWorld
  readonly transport: SnapshotTransportKind
  readonly limits: SnapshotLimits

  readonly #post: PostToMain
  readonly #relay: NotificationRelay
  readonly #writer: SnapshotWriter | null
  readonly #versions: ChunkVersionWriter | null
  readonly #collectEntities: EntityCollector
  readonly #buildDigest: DigestBuilder

  #speed: number
  /**
   * Real milliseconds elapsed but not yet spent on a step.
   *
   * Milliseconds rather than fractional steps, because the residual is then
   * always `elapsed - steps * (1000 / stepsPerSecond)`, and for every speed on
   * PRD 3.9's ladder that divisor (250, 125, 50, 12.5) is exact in binary
   * floating point. Accumulating fractional steps instead loses a bit per
   * slice, and at 250 slices a second the game visibly runs slow.
   */
  #accumulatedMs = 0
  #lastNow: number | null = null
  #sequence = 0
  /** Reused every frame: the encoder reads it synchronously and keeps nothing. */
  readonly #entities: SnapshotEntity[] = []

  constructor(options: SimWorkerLoopOptions) {
    this.limits = options.limits ?? DEFAULT_SNAPSHOT_LIMITS
    this.#post = options.post
    this.#relay = new NotificationRelay(this.limits.maxNotifications)
    this.#speed = options.speed ?? 1
    assertSpeed(this.#speed)

    this.game = createGame({
      seed: options.seed,
      mapSize: options.mapSize,
      data: loadGameData(),
      events: this.#relay,
      ...(options.gridBuffers === undefined ? {} : { buffers: options.gridBuffers }),
      ...(options.builders === undefined || options.builders <= 0
        ? {}
        : { workforce: uniformWorkforce(options.builders) }),
    })
    this.simulation = this.game.simulation
    this.world = this.game.world

    this.#collectEntities =
      options.collectEntities ??
      ((tick, out) => {
        collectGameEntities(this.world, this.game.data, tick, out)
      })
    this.#buildDigest =
      options.buildDigest ?? ((_tick, alerts) => buildGameDigest(this.world, alerts))

    // The renderer has drawn nothing yet, so the first snapshot has to offer
    // it every chunk.
    this.world.grid.markAllDirty()

    this.#versions =
      options.chunkVersionBuffer === undefined
        ? null
        : new ChunkVersionWriter(options.chunkVersionBuffer, options.mapSize)

    if (options.snapshotBuffer === undefined) {
      this.transport = 'transfer'
      this.#writer = null
    } else {
      this.transport = 'shared'
      this.#writer = new SnapshotWriter(options.snapshotBuffer, {
        limits: this.limits,
        events: this.#relay,
      })
    }
  }

  get speed(): number {
    return this.#speed
  }

  /** The sequence of the last published snapshot. */
  get sequence(): number {
    return this.#writer === null ? this.#sequence : this.#writer.sequence
  }

  /** Notifications the relay had to discard. Exposed for tests and diagnostics. */
  get droppedNotifications(): number {
    return this.#relay.dropped
  }

  /**
   * Unread warn-and-above count — the number on the alerts badge.
   *
   * A muted category never reaches it, which is what makes the mute honest
   * rather than cosmetic (T6.3).
   */
  get alerts(): number {
    return this.#relay.alerts
  }

  /**
   * Notifications raised since the last snapshot, without draining them.
   *
   * The grouping in PRD 6.5 happens before this point, so what is here is what
   * the player will actually be shown — which makes it the right thing for a
   * test, and for a diagnostic overlay, to read.
   */
  peekNotifications(): readonly SnapshotNotification[] {
    return this.#relay.peek()
  }

  /** Drains the pending notifications, as publishing does. */
  drainNotifications(): readonly SnapshotNotification[] {
    return this.#relay.drain()
  }

  /**
   * The sink every system emits through.
   *
   * Narrowed to `EventSink` deliberately: a caller may raise an event, which is
   * what a test needs to exercise the notification and Trace path without
   * building a whole failing prison, but cannot reach into the log or the pins.
   */
  get events(): EventSink {
    return this.#relay
  }

  setSpeed(multiplier: number): void {
    assertSpeed(multiplier)
    this.#speed = multiplier
    if (multiplier === 0) {
      // Otherwise unpausing would immediately spend whatever built up while
      // the player was reading a panel.
      this.#accumulatedMs = 0
    }
  }

  enqueue(command: Command): void {
    this.simulation.enqueue(command)
  }

  /**
   * Runs whatever whole steps the elapsed real time has earned, publishing a
   * snapshot after each one, and returns how many ran.
   *
   * The first call only establishes the baseline: there is no meaningful
   * elapsed time before it.
   */
  advance(now: number): number {
    const last = this.#lastNow
    this.#lastNow = now
    if (last === null) return 0

    if (this.#speed === 0) return 0

    // A clock that went backwards contributes nothing rather than unwinding
    // the accumulator.
    this.#accumulatedMs += Math.min(Math.max(now - last, 0), MAX_CATCHUP_MS)

    const msPerStep = 1000 / (STEPS_PER_SECOND_AT_1X * this.#speed)
    let steps = Math.floor(this.#accumulatedMs / msPerStep)
    if (steps <= 0) return 0

    if (steps > MAX_STEPS_PER_SLICE) {
      steps = MAX_STEPS_PER_SLICE
      this.#accumulatedMs = 0
    } else {
      this.#accumulatedMs = Math.max(this.#accumulatedMs - steps * msPerStep, 0)
    }

    for (let i = 0; i < steps; i += 1) {
      this.simulation.step()
      this.publish()
      // Checked per step rather than per slice: at 20x a slice is twenty ticks,
      // and a player who asked for auto-pause wants the clock stopped on the
      // tick the death happened, not twenty ticks of riot later.
      if (this.#applyAutoPause()) {
        return i + 1
      }
    }
    return steps
  }

  /**
   * Stops the clock when a critical was raised and the player asked for it
   * (PRD 6.5).
   *
   * Returns whether it paused, so the caller can stop spending its slice.
   * The control message goes out unconditionally after a pause so the speed
   * control on the main thread stops showing a speed the game is not running.
   */
  #applyAutoPause(): boolean {
    const raised = this.#relay.policy.takeCriticalRaised()
    if (!raised || !this.#relay.policy.autoPauseOnCritical) return false
    if (this.#speed === 0) return false
    this.setSpeed(0)
    this.#post({ type: 'sim:speedChanged', speed: 0, reason: 'critical' }, [])
    return true
  }

  /** Current notification policy, for the settings panel. */
  notificationSettings(): NotificationSettings {
    return this.#relay.policy.settings()
  }

  /** Applies a partial policy change from the alerts panel. */
  setNotificationSettings(settings: Partial<NotificationSettings>): void {
    this.#relay.policy.apply(settings)
  }

  /** Material ids in table order, for the renderer's palette. */
  get materialIds(): readonly string[] {
    return this.world.materials.ids()
  }

  /**
   * The causal chain behind `traceId`, resolved to display strings (PRD 3.1).
   *
   * Returns null rather than throwing when the id is unknown: a chain can age
   * out of the ring buffer between a toast being raised and the player tapping
   * it, and a missing Trace is a closed panel, not a crashed worker.
   */
  trace(traceId: number, notificationId = 0): TraceResult | null {
    if (!this.#relay.log.has(traceId)) return null
    if (notificationId > 0) this.#relay.pinTrace(notificationId, traceId)

    // A cause anywhere in the chain may be a kind with no catalogue entry, and
    // `buildTrace` refuses to render half a sentence. Closing the panel is the
    // right answer; stopping the simulation is not.
    let view
    try {
      view = buildTrace(this.#relay.log, traceId, TRACE_CATALOGUE)
    } catch {
      return null
    }
    const tip = this.#relay.log.get(traceId)
    const tipTick = tip?.tick ?? 0

    return {
      rootId: view.rootId,
      nodes: view.nodes.map((node) => ({
        eventId: node.eventId,
        subjectId: node.subjectId,
        title: node.title,
        detail: node.detail,
        meta: node.meta,
        isRootCause: node.isRootCause,
        tick: node.tick,
        focus: this.#focusTileFor(node.subjectId),
      })),
      fixes: view.fixes.map((fix) => ({ id: fix.id, label: fix.label })),
      reportText: view.reportText,
      subtitle: `Day ${String(ticksToDay(tipTick))} · ${ticksToTimeString(tipTick)}`,
    }
  }

  /** Releases a toast's hold on its chain. */
  untrace(notificationId: number): void {
    this.#relay.unpinTrace(notificationId)
  }

  /**
   * Where the camera goes when a Trace node is tapped.
   *
   * A subject id is ambiguous on its own — the same number can be a room, an
   * inmate or an object — so each registry is asked in turn. Rooms first,
   * because every logistics event subjects a room.
   */
  #focusTileFor(subjectId: number): Tile | null {
    if (subjectId <= 0) return null

    const room = this.world.rooms.get(subjectId)
    if (room !== undefined) {
      return {
        x: room.bounds.x + Math.floor(room.bounds.width / 2),
        y: room.bounds.y + Math.floor(room.bounds.height / 2),
      }
    }

    const inmate = this.world.inmates.get(subjectId)
    if (inmate !== undefined) return { x: inmate.tx, y: inmate.ty }

    const officer = this.world.staff.get(subjectId)
    if (officer !== undefined) return { x: officer.tx, y: officer.ty }

    const object = this.world.objects.get(subjectId)
    if (object !== undefined) return { x: object.tx, y: object.ty }

    return null
  }

  /**
   * Prices and grades staged build actions without touching the world.
   *
   * Unparseable actions are dropped rather than rejected wholesale: the reply
   * is a preview, and a preview that vanishes because one stroke was malformed
   * is worse than one that prices the other ninety-nine.
   */
  validate(actions: readonly JsonValue[]): BlueprintReport {
    const parsed: BuildAction[] = []
    for (const entry of actions) {
      const action = actionFromJson(entry)
      if (action !== undefined) parsed.push(action)
    }

    return validateBlueprint(this.world, this.game.data, parsed, this.simulation.tick)
  }

  /**
   * Shortest cable/pipe run from a tile to the nearest live utility node.
   * Null when the world cannot route or no live node is reachable.
   */
  autoRoute(tile: Tile, kind: UtilityRouteKind): UtilityRouteResult | null {
    if (!isInmateWorld(this.world)) return null
    if (!this.world.grid.inBounds(tile.x, tile.y)) return null
    const from = this.world.grid.idx(tile.x, tile.y)
    return autoRouteUtility(this.world, from, kind) ?? null
  }

  overlay(mode: OverlayRequestMode, needId?: string): Uint8Array {
    return buildOverlayData(this.world, this.game.data, {
      mode,
      ...(needId === undefined ? {} : { needId }),
    })
  }

  /** One on-demand PRD 6.2 report snapshot; never published in the hot path. */
  reports(): ReportsModel {
    return buildReportsModel({
      world: this.world,
      data: this.game.data,
      clock: this.simulation.clock,
      log: this.#relay.log,
      severityForKind,
    })
  }

  /**
   * Captures the live world into `.blockwork` container bytes (save v3).
   *
   * Used by the host for autosave-on-background and manual export. Does not
   * pause or mutate the simulation.
   */
  async exportSave(createdAt: string): Promise<{ bytes: Uint8Array; playedTicks: number }> {
    if (!isInmateWorld(this.world)) {
      throw new Error('exportSave requires an InmateWorld')
    }
    const playedTicks = this.simulation.tick
    const state = captureInmateWorld(this.world, {
      seed: this.simulation.rng.serialise().seed,
      playedTicks,
      rngState: this.simulation.rng.serialise(),
      log: this.#relay.savedLog(),
    })
    const bytes = await saveToBytes(state, { createdAt, events: this.#relay })
    return { bytes, playedTicks }
  }

  /**
   * What is on a tile, resolved to display names.
   *
   * Priority is agent (inmate / staff), then object, then room, then the bare
   * tile — matching T2.9's "entities first, then tiles" hit order.
   */
  inspect(tile: Tile): InspectResult {
    const { grid, rooms, objects, inmates, staff } = this.world
    const data = this.game.data

    const offMap = (): InspectResult => ({
      kind: 'tile',
      x: tile.x,
      y: tile.y,
      floorName: 'Outside the map',
      wallName: null,
      roomName: null,
      walkable: false,
      centre: tile,
    })

    const bare = (): InspectResult => {
      const index = grid.idx(tile.x, tile.y)
      const floorIndex = grid.floorMaterial[index] as number
      const wallIndex = grid.wallMaterial[index] as number
      const materials = this.world.materials
      const floor = materials.isNone(floorIndex) ? undefined : materials.idAt(floorIndex)
      const wall = materials.isNone(wallIndex) ? undefined : materials.idAt(wallIndex)
      const roomId = grid.roomId[index] as number
      const room = rooms.get(roomId)

      return {
        kind: 'tile',
        x: tile.x,
        y: tile.y,
        floorName:
          floor === undefined ? 'Bare ground' : (data.materials.find(floor)?.name ?? floor),
        wallName: wall === undefined ? null : (data.materials.find(wall)?.name ?? wall),
        roomName: room === undefined ? null : (data.rooms.find(room.defId)?.name ?? room.defId),
        walkable: ((grid.passability[index] as number) & 1) !== 0,
        centre: tile,
      }
    }

    if (!grid.inBounds(tile.x, tile.y)) return offMap()

    const inmate = inmates.all().find((entity) => entity.tx === tile.x && entity.ty === tile.y)
    if (inmate !== undefined) return describeInmate(inmate, this.world, data)

    const officer = staff.all().find((entity) => entity.tx === tile.x && entity.ty === tile.y)
    if (officer !== undefined) return describeStaff(officer, data)

    const index = grid.idx(tile.x, tile.y)
    const entity = objects.at(index)
    if (entity !== undefined) {
      const def = data.objects.find(entity.object.defId)
      const room = rooms.get(entity.object.roomId)
      const maxHp = def?.hp ?? entity.object.hp
      const needsServed = (def?.servesNeeds ?? []).map((entry) => {
        const need = data.needs.find(entry.need)
        return need?.name ?? entry.need
      })
      const contrabandRisk =
        def?.contrabandSourceFor !== undefined && def.contrabandSourceFor.length > 0 ? 55 : 0

      return {
        kind: 'object',
        entityId: entity.id,
        name: def?.name ?? entity.object.defId,
        cost: def?.cost ?? 0,
        hasPower: entity.object.hasPower,
        hasWater: entity.object.hasWater,
        needsPower: (def?.needsPower ?? 0) > 0,
        needsWater: def?.needsWater ?? false,
        roomName: room === undefined ? null : (data.rooms.find(room.defId)?.name ?? room.defId),
        condition: entity.object.hp,
        conditionMax: maxHp,
        needsServed,
        contrabandRisk,
        centre: { x: entity.tx, y: entity.ty },
      }
    }

    const roomId = grid.roomId[index] as number
    const room = rooms.get(roomId)
    if (room !== undefined) {
      const status = rooms.statusOf(room.id)
      const def = data.rooms.find(room.defId)
      const properties = Object.entries(room.properties)
        .filter(([, held]) => held === true)
        .map(([name]) => name)

      return {
        kind: 'room',
        roomId: room.id,
        name: `${def?.name ?? room.defId} ${String(room.id)}`,
        typeName: def?.name ?? room.defId,
        width: room.bounds.width,
        height: room.bounds.height,
        tiles: room.tiles.length,
        functional: status?.functional ?? false,
        requirements: status?.requirements ?? [],
        properties,
        occupants: this.world.contents().occupants(room.id),
        ...describeRoomGrade(this.world, data, room, def),
        throughputLabel: null,
        centre: {
          x: room.bounds.x + Math.floor(room.bounds.width / 2),
          y: room.bounds.y + Math.floor(room.bounds.height / 2),
        },
      }
    }

    return bare()
  }

  /** Builds and sends one snapshot. Called after every step. */
  publish(): void {
    const contents = this.#collect()

    // Before the snapshot, so a renderer that reads the counters and then the
    // snapshot can never see a chunk id it has already accounted for as clean.
    this.#versions?.bump(contents.changedChunks)

    if (this.#writer !== null) {
      this.#writer.write(contents)
      this.#publishControl()
      this.#publishEffects()
      return
    }

    // Shared memory would have carried the tiles themselves; without it the
    // chunk ids in the snapshot mean nothing on their own.
    if (contents.changedChunks.length > 0) {
      const tiles = encodeTilePatch(this.world.grid, contents.changedChunks)
      this.#post({ type: 'sim:tiles', buffer: tiles }, [tiles])
    }

    this.#sequence = nextSequence(this.#sequence)
    const { buffer, truncation } = encodeSnapshotToTransferable(
      contents,
      this.#sequence,
      this.limits,
    )
    this.#post({ type: 'sim:snapshot', buffer }, [buffer])
    this.#publishControl()
    this.#publishEffects()

    if (isTruncated(truncation)) {
      // The shared writer raises this itself; the fallback path has to.
      this.#relay.emit({
        tick: contents.tick,
        kind: 'snapshot.truncated',
        causeIds: [],
        data: {
          sequence: this.#sequence,
          droppedEntities: truncation.entities,
          droppedChunks: truncation.chunks,
          droppedNotifications: truncation.added,
          droppedRemovals: truncation.removed,
        },
      })
    }
  }

  /** Posts / Emergency / Standing Orders summaries for open panels. */
  #publishControl(): void {
    const control = buildControlHud(this.world, this.game.data, this.simulation.clock, null)
    this.#post({ type: 'sim:control', control }, [])
  }

  /** Fire and discovered tunnels for the world overlay. */
  #publishEffects(): void {
    const { fire, escapes } = this.world
    const fireTiles: { index: number; intensity: number; smoke: number }[] = []
    for (let i = 0; i < fire.intensity.length; i += 1) {
      const intensity = fire.intensity[i] ?? 0
      const smoke = fire.smoke[i] ?? 0
      if (intensity === 0 && smoke === 0) continue
      fireTiles.push({ index: i, intensity, smoke })
    }

    const tunnels = escapes
      .all()
      .filter((tunnel) => tunnel.discovered)
      .map((tunnel) => ({
        id: tunnel.id,
        originTile: tunnel.originTile,
        tiles: [...tunnel.tiles],
      }))

    this.#post({ type: 'sim:effects', fire: fireTiles, tunnels }, [])
  }

  #collect(): SnapshotContents {
    const tick = this.simulation.tick

    this.#entities.length = 0
    this.#collectEntities(tick, this.#entities)

    return {
      tick,
      entities: this.#entities,
      changedChunks: this.world.grid.consumeDirtyChunks(),
      notifications: { added: this.#relay.drain(), removedIds: [] },
      digest: this.#buildDigest(tick, this.#relay.alerts),
    }
  }
}

function needSeverity(
  value: number,
  thresholds: { readonly medium: number; readonly high: number; readonly critical: number },
): InspectNeed['severity'] {
  if (value >= thresholds.critical) return 'critical'
  if (value >= thresholds.high) return 'high'
  if (value >= thresholds.medium) return 'medium'
  return 'ok'
}

function formatNeedRows(
  data: GameData,
  values: Float32Array,
  ids: readonly string[],
): InspectNeed[] {
  const rows: InspectNeed[] = []
  for (let i = 0; i < ids.length; i += 1) {
    const id = ids[i]
    if (id === undefined) continue
    const def = data.needs.find(id)
    if (def === undefined) continue
    const raw = values[i] ?? 0
    const value = Math.max(0, Math.min(100, Math.round(raw)))
    rows.push({
      id,
      name: def.name,
      value,
      severity: needSeverity(value, def.thresholds),
    })
  }
  rows.sort((a, b) => b.value - a.value || a.name.localeCompare(b.name))
  return rows
}

function durationLabel(hours: number): string {
  const total = Math.max(0, Math.floor(hours))
  const years = Math.floor(total / (24 * 365))
  const months = Math.floor((total % (24 * 365)) / (24 * 30))
  if (years > 0 && months > 0) return `${String(years)}y ${String(months)}m`
  if (years > 0) return `${String(years)}y`
  if (months > 0) return `${String(months)}m`
  const days = Math.floor(total / 24)
  if (days > 0) return `${String(days)}d`
  return `${String(total)}h`
}

function gradeLetter(score: number): { letter: string; tone: InspectGrade['tone'] } {
  if (score >= 80) return { letter: 'A', tone: 'ok' }
  if (score >= 65) return { letter: 'B', tone: 'ok' }
  if (score >= 50) return { letter: 'C', tone: 'warn' }
  if (score >= 35) return { letter: 'D', tone: 'danger' }
  return { letter: 'E', tone: 'danger' }
}

function reputationTone(id: string): InspectReputation['tone'] {
  if (id.includes('deadly') || id.includes('violent') || id.includes('agitator')) return 'bad'
  if (id.includes('unstable') || id.includes('volatile')) return 'warn'
  return 'info'
}

function describeInmate(
  entity: InmateEntity,
  world: InmateWorld,
  data: GameData,
): Extract<InspectResult, { kind: 'inmate' }> {
  const { inmate } = entity
  const category = data.securityCategories.find(inmate.category)
  const needIds = data.needs.ids()
  const needs = formatNeedRows(data, inmate.needs, needIds)
  const criticalNeedCount = needs.filter((need) => need.severity === 'critical').length

  const served = inmate.servedHours
  const total = Math.max(1, inmate.sentenceHours)
  const progress = Math.max(0, Math.min(100, Math.round((served / total) * 100)))
  const intakeDay = Math.max(1, Math.floor(served / 24) + 1)

  const traits = inmate.traits.map((id) => data.traits.find(id)?.name ?? id)
  const revealed = inmate.reputations.filter((rep) => rep.revealed)
  const reputations = revealed.map((rep) => ({
    id: rep.id,
    name: data.reputations.find(rep.id)?.name ?? rep.id,
    tone: reputationTone(rep.id),
  }))
  const unknownReputationCount = inmate.reputations.length - revealed.length

  const cell = inmate.cellId === 0 ? undefined : world.rooms.get(inmate.cellId)
  const cellDef = cell === undefined ? undefined : data.rooms.find(cell.defId)
  const cellLabel =
    cell === undefined ? 'Unassigned' : `${cellDef?.name ?? cell.defId} ${String(cell.id)}`

  const activityState = world.needsRuntime.stateOf(entity.id)
  const activity =
    activityState.usingObjectId !== 0
      ? 'Using object'
      : world.escorts
            .all()
            .some(
              (job) =>
                job.inmateId === entity.id &&
                (job.state === 'approach_inmate' || job.state === 'escort_to_destination'),
            )
        ? 'Escorted'
        : 'Idle'

  const gradeDefs: { id: keyof typeof inmate.grades; label: string }[] = [
    { id: 'punishment', label: 'Punishment' },
    { id: 'reform', label: 'Reform' },
    { id: 'security', label: 'Security' },
    { id: 'health', label: 'Health' },
  ]
  const grades: InspectGrade[] = gradeDefs.map((entry) => {
    const score = Math.max(0, Math.min(100, Math.round(inmate.grades[entry.id])))
    const { letter, tone } = gradeLetter(score)
    return { id: entry.id, label: entry.label, letter, score, tone }
  })

  return {
    kind: 'inmate',
    entityId: entity.id,
    name: inmate.name,
    subtitle: `Inmate ${String(entity.id)} · intake day ${String(intakeDay)}`,
    categoryId: inmate.category,
    categoryName: category?.name ?? inmate.category,
    criticalNeedCount,
    sentenceServedLabel: durationLabel(served),
    sentenceTotalLabel: durationLabel(total),
    sentenceProgress: progress,
    paroleLabel: null,
    needs,
    traits,
    reputations,
    unknownReputationCount,
    activity,
    cellLabel,
    entitlement: Math.round(inmate.entitlement),
    suppression: Math.round(inmate.suppression),
    workLabel: inmate.jobId ?? 'Unassigned',
    programmeLabel: inmate.programEnrolment === null ? 'None' : 'Enrolled',
    grades,
    reoffendPercent: Math.round(inmate.reoffendChance * 100),
    misconduct: [],
    centre: { x: entity.tx, y: entity.ty },
  }
}

function describeStaff(
  entity: StaffEntity,
  data: GameData,
): Extract<InspectResult, { kind: 'staff' }> {
  const def = data.staff.find(entity.staff.defId)
  const needIds = def?.needs ?? []
  // Staff needs are not yet a typed array on the entity; surface empty until
  // the staff-needs system lands. Role wage and duty still render.
  const needs: InspectNeed[] = needIds.map((id) => {
    const needDef = data.needs.find(id)
    return {
      id,
      name: needDef?.name ?? id,
      value: 0,
      severity: 'ok' as const,
    }
  })

  let currentTask = 'Idle'
  switch (entity.staff.duty.kind) {
    case 'wander':
      currentTask = 'Patrolling'
      break
    case 'escort':
      currentTask = 'Escorting'
      break
    case 'incident':
      currentTask = 'Responding'
      break
    case 'idle':
      currentTask = 'Idle'
      break
  }

  return {
    kind: 'staff',
    entityId: entity.id,
    name: entity.staff.name,
    roleName: def?.name ?? entity.staff.defId,
    wagePerHour: def?.hourlyWage ?? 0,
    needs,
    moraleContribution: 0,
    currentTask,
    postAssignment:
      entity.staff.assignedAreaId === 0
        ? 'Unassigned'
        : `Post ${String(entity.staff.assignedAreaId)}`,
    equipment: [],
    centre: { x: entity.tx, y: entity.ty },
  }
}

function assertSpeed(multiplier: number): void {
  if (!Number.isFinite(multiplier) || multiplier < 0) {
    throw new RangeError(`speed multiplier must be a finite number >= 0, received ${multiplier}`)
  }
}

/** The subset of `DedicatedWorkerGlobalScope` the worker actually uses. */
export interface SimWorkerScope {
  postMessage(message: SimWorkerOutbound, transfer: Transferable[]): void
  addEventListener(type: 'message', listener: (event: MessageEvent<SimWorkerInbound>) => void): void
}

export type SliceScheduler = (callback: () => void) => void

export interface SimWorkerOverrides {
  readonly now?: () => number
  readonly schedule?: SliceScheduler
  readonly collectEntities?: EntityCollector
  readonly buildDigest?: DigestBuilder
}

export interface SimWorkerHandle {
  /** Null until the `sim:init` message arrives. */
  readonly loop: SimWorkerLoop | null
  stop(): void
}

function defaultSchedule(callback: () => void): void {
  setTimeout(callback, SLICE_INTERVAL_MS)
}

/**
 * Wires a scope's message port to a `SimWorkerLoop` and starts the slice loop.
 *
 * Exported so a test can drive it with a stub scope, a fake clock and a
 * synchronous scheduler; the module's own bootstrap below calls it with the
 * real worker global.
 */
export function startSimWorker(
  scope: SimWorkerScope,
  overrides: SimWorkerOverrides = {},
): SimWorkerHandle {
  const now = overrides.now ?? ((): number => performance.now())
  const schedule = overrides.schedule ?? defaultSchedule

  let loop: SimWorkerLoop | null = null
  let running = false

  const runSlice = (): void => {
    if (!running || loop === null) return
    loop.advance(now())
    if (running) schedule(runSlice)
  }

  const fail = (error: unknown): void => {
    running = false
    scope.postMessage(
      { type: 'sim:error', message: error instanceof Error ? error.message : String(error) },
      [],
    )
  }

  scope.addEventListener('message', (event: MessageEvent<SimWorkerInbound>) => {
    const message = event.data

    try {
      switch (message.type) {
        case 'sim:init': {
          if (loop !== null) throw new Error('the simulation worker is already initialised')

          loop = new SimWorkerLoop({
            seed: message.seed,
            mapSize: message.mapSize,
            limits: message.limits,
            speed: message.speed,
            post: (outbound, transfer) => {
              scope.postMessage(outbound, transfer)
            },
            ...(message.snapshotBuffer === undefined
              ? {}
              : { snapshotBuffer: message.snapshotBuffer }),
            ...(message.gridBuffers === undefined ? {} : { gridBuffers: message.gridBuffers }),
            ...(message.chunkVersionBuffer === undefined
              ? {}
              : { chunkVersionBuffer: message.chunkVersionBuffer }),
            ...(message.builders === undefined ? {} : { builders: message.builders }),
            ...(overrides.collectEntities === undefined
              ? {}
              : { collectEntities: overrides.collectEntities }),
            ...(overrides.buildDigest === undefined ? {} : { buildDigest: overrides.buildDigest }),
          })

          scope.postMessage(
            {
              type: 'sim:ready',
              transport: loop.transport,
              mapSize: message.mapSize,
              materialIds: loop.materialIds,
            },
            [],
          )

          // Tick 0 exists before any step runs, and the renderer needs the
          // opening frame to have something to draw.
          loop.publish()

          // Anchors the accumulator to boot time. Without it the first slice
          // is spent establishing the baseline and the run starts a slice
          // behind real time, forever.
          loop.advance(now())

          running = true
          schedule(runSlice)
          break
        }

        case 'sim:command':
          loop?.enqueue(message.command)
          break

        case 'sim:speed':
          loop?.setSpeed(message.speed)
          break

        case 'sim:notifications':
          loop?.setNotificationSettings(message.settings)
          break

        case 'sim:validate': {
          if (loop === null) break
          const report = loop.validate(message.actions)
          scope.postMessage({ type: 'sim:report', requestId: message.requestId, report }, [])
          break
        }

        case 'sim:inspect': {
          if (loop === null) break
          const result = loop.inspect(message.tile)
          scope.postMessage({ type: 'sim:inspected', requestId: message.requestId, result }, [])
          break
        }

        case 'sim:trace': {
          // Answered even before init, with null: the host's promise must
          // settle or the panel waits forever.
          const result = loop === null ? null : loop.trace(message.traceId, message.notificationId)
          scope.postMessage({ type: 'sim:traced', requestId: message.requestId, result }, [])
          break
        }

        case 'sim:untrace':
          loop?.untrace(message.notificationId)
          break

        case 'sim:autoRoute': {
          const route = loop === null ? null : loop.autoRoute(message.tile, message.kind)
          scope.postMessage({ type: 'sim:autoRouted', requestId: message.requestId, route }, [])
          break
        }

        case 'sim:overlay': {
          if (loop === null) break
          const values = loop.overlay(message.mode, message.needId)
          const copy = values.slice()
          const buffer = copy.buffer
          scope.postMessage(
            { type: 'sim:overlayed', requestId: message.requestId, mode: message.mode, buffer },
            [buffer],
          )
          break
        }

        case 'sim:reports': {
          if (loop === null) break
          scope.postMessage(
            { type: 'sim:reported', requestId: message.requestId, reports: loop.reports() },
            [],
          )
          break
        }

        case 'sim:save': {
          if (loop === null) break
          void loop
            .exportSave(message.createdAt)
            .then(({ bytes, playedTicks }) => {
              const copy = bytes.slice()
              scope.postMessage(
                {
                  type: 'sim:saved',
                  requestId: message.requestId,
                  buffer: copy.buffer,
                  playedTicks,
                },
                [copy.buffer],
              )
            })
            .catch((error: unknown) => {
              fail(error)
            })
          break
        }

        case 'sim:stop':
          running = false
          break
      }
    } catch (error) {
      fail(error)
    }
  })

  return {
    get loop(): SimWorkerLoop | null {
      return loop
    },
    stop(): void {
      running = false
    },
  }
}

/**
 * The worker global, or null when this module was imported on the main thread
 * or in a test runner. Keeps the module free of import-time side effects
 * anywhere it is not actually the worker.
 */
function dedicatedWorkerScope(): SimWorkerScope | null {
  // By constructor name rather than `instanceof DedicatedWorkerGlobalScope`,
  // because that global only exists in the WebWorker lib, and adding it to
  // this package's libs collides with the DOM declarations the UI needs.
  if (globalThis.constructor.name !== 'DedicatedWorkerGlobalScope') return null
  // Structurally a `SimWorkerScope`; the cast only narrows the DOM's overloads.
  return globalThis as unknown as SimWorkerScope
}

const workerScope = dedicatedWorkerScope()
if (workerScope !== null) {
  startSimWorker(workerScope)
}
