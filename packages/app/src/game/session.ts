/**
 * The session: the running game, as one object the UI can read.
 *
 * This is the state machine the composition root was missing. Every package
 * below it was complete and none of them knew about each other, so what lives
 * here is exactly the wiring and nothing else:
 *
 *   - the **bridge** publishes the world and takes commands,
 *   - the **renderer** draws whatever the bridge's tile arrays say,
 *   - the **blueprint** stages build actions on this thread until Commit,
 *   - **signals** expose all of it to Preact.
 *
 * Three rules keep it honest.
 *
 * **The simulation is the only authority.** Nothing here mutates a world. A
 * stroke becomes a `BuildAction` staged in a `Blueprint`; the price and the
 * problems come back from `validateBlueprint` running in the worker against
 * the real world; Commit sends one atomic command. The blueprint bar can
 * therefore never quote a number the simulation would disagree with, because
 * this thread never computes one.
 *
 * **The frame loop touches no DOM.** It reads the snapshot, hands changed
 * chunks to the renderer, and writes signals. Preact re-renders only when a
 * signal actually changes value, which is why the digest is compared field by
 * field before being published rather than replaced every frame: a new object
 * every frame would re-render the top bar sixty times a second to show the
 * same number.
 *
 * **Validation is debounced by supersession, not by a timer.** Every stroke
 * fires a request; a reply is dropped if a newer request has gone out since.
 * That keeps the bar responsive on a fast drag without ever showing a price
 * computed from a blueprint the player has already changed.
 */

import {
  Blueprint,
  NOTIFICATION_SEVERITY,
  actionToJson,
  chunkBounds,
  ticksToDay,
  ticksToTimeString,
  undoCommand,
  redoCommand,
  utilityPathToLines,
} from '@blockwork/sim'
import type {
  BlueprintReport,
  BuildAction,
  Command,
  GameData,
  NewPrisonConfig,
  NotificationSeverity,
  Tile,
  UtilityRouteKind,
} from '@blockwork/sim'
import {
  BlockworkRenderer,
  OVERLAY_MODE_DEFINITIONS,
  OVERLAY_PALETTES,
  TILE_SIZE,
  interpolateAgents,
  materialAppearances,
  objectAppearances,
  defaultObjectAppearance,
  overlayCategoricalPattern,
  overlayLegendBands,
  parseCssColour,
  terrainPaletteFor,
} from '@blockwork/render'
import type {
  OverlayMode,
  OverlayPaletteId,
  PrdOverlayMode,
  RenderAgent,
  RenderObject,
  ToolStroke,
} from '@blockwork/render'
import { signal } from '@preact/signals'
import type { Signal } from '@preact/signals'
import {
  categoryToken,
  resolveWorldTap,
  traceModelFromView,
  type AlertRowModel,
  type AlertSeverity,
  type AlertsModel,
  type ColourBlindPalette,
  type ContractsModel,
  type DockToolId,
  type DirectorateBranchId,
  type DirectorateModel,
  type EmergencyModel,
  type FlowChainId,
  type FlowModel,
  type InspectorModel,
  type IntakeModel,
  type IntelligenceModel,
  type IntelligenceTab,
  type MapSizePreset,
  type NewPrisonModel,
  type OnboardingMode,
  type OnboardingModel,
  type OverlayLegendModel,
  type PostsModel,
  type PostsTab,
  type ProgramsModel,
  type ReportsModel,
  type ReportsTab,
  type RoutineBlockId,
  type RoutineModel,
  type SettingsModel,
  type SettingsTab,
  type SpeedStop,
  type StandingMealQuantity,
  type StandingOrdersModel,
  type StandingOrdersTab,
  type StandingPunishment,
  type StandingStrictness,
  type ToastModel,
  type ToastSeverity,
  type TopBarModel,
  type TraceModel,
  type TraceNodeModel,
  type TrayGroup,
} from '@blockwork/ui'
import { SimBridge, createSimWorker, isolationDiagnostic } from '../worker/bridge'
import type { InspectResult, TraceResult } from '../worker/simWorker'
import {
  isObjectSnapshotId,
  snapshotEntityToRenderAgent,
  snapshotEntityToRenderObject,
} from '../worker/collectAgents'
import { SaveStore } from '../save/store'

import {
  createPalettes,
  gestureHint,
  unlockSnapshotKey,
  type Palette,
  type PaletteEntry,
  type UnlockSnapshot,
} from './palette'
import type { AppSettings, AudioSettings, AutosaveHours } from './appSettings'
import { DEFAULT_APP_SETTINGS } from './appSettings'
import { createAudioEngine, effectForEventKind } from './audio'
import type { AudioEngine } from './audio'
import { WebAudioBackend } from './webAudioBackend'
import {
  Onboarding,
  objectivesFromContract,
} from './onboarding'
import {
  newPrisonConfigFromModel,
  onboardingModelFromMachine,
  settingsModelFromAppSettings,
} from './onboardingView'

/** The first-play contract that *is* the tutorial (T6.4 / T8.8). */
export const GUIDED_CONTRACT_ID = 'fit_for_purpose'

/** PRD 4.3's Large map. The size a new game starts at until T5.x offers a menu. */
export const DEFAULT_MAP_SIZE = 220

async function createSessionRenderer(
  parent: HTMLElement,
  data: GameData,
  mapSize: number,
): Promise<BlockworkRenderer> {
  const materialIds = data.materials.ids()
  const appearances = materialAppearances(
    materialIds.map((id) => {
      const def = data.materials.find(id)
      return def === undefined ? { id } : { id, appearance: def.appearance }
    }),
  )
  const objectTable = objectAppearances(
    data.objects.all.map((def) => ({
      id: def.id,
      size: def.size,
      appearance: def.appearance,
    })),
  )
  return BlockworkRenderer.create({
    parent,
    mapSize,
    palette: terrainPaletteFor(materialIds, appearances),
    wallMaterialIds: ['none', ...materialIds],
    appearanceFor: (defId) => objectTable.get(defId) ?? defaultObjectAppearance(defId),
  })
}

interface ParsedOverlaySelection {
  readonly mode: PrdOverlayMode
  readonly needId?: string
}

const DIRECT_OVERLAY_MODES = new Set<PrdOverlayMode>([
  'sectors',
  'roomGrade',
  'contrabandRisk',
  'power',
  'water',
  'temperature',
  'cleanliness',
  'guardCoverage',
  'fogOfWar',
])

const REPORT_TAB_IDS = new Set<ReportsTab>([
  'needs',
  'finance',
  'population',
  'intelligence',
  'log',
  'statistics',
])

function isReportsTab(value: string | null): value is ReportsTab {
  return value !== null && REPORT_TAB_IDS.has(value as ReportsTab)
}

export function parseOverlaySelection(selection: string | null): ParsedOverlaySelection | null {
  if (selection === null) return null
  if (selection.startsWith('needs:')) {
    const needId = selection.slice('needs:'.length)
    return needId.length === 0 ? null : { mode: 'needs', needId }
  }
  return DIRECT_OVERLAY_MODES.has(selection as PrdOverlayMode)
    ? { mode: selection as PrdOverlayMode }
    : null
}

function colourToCss(colour: number): string {
  return `#${colour.toString(16).padStart(6, '0')}`
}

/** Where the camera starts: the middle of the map. */
function centreTile(mapSize: number): number {
  return Math.floor(mapSize / 2)
}

export interface SessionOptions {
  readonly parent: HTMLElement
  readonly data: GameData
  readonly seed?: number
  readonly mapSize?: number
  /**
   * First-order material grace for a new prison (T8.4). Defaults to the
   * balance flag; the New Prison panel can override it.
   */
  readonly firstOrderGrace?: boolean
}

/** Everything the shell renders, as signals. */
export interface SessionState {
  readonly topBar: Signal<TopBarModel>
  readonly speed: Signal<SpeedStop>
  readonly tool: Signal<DockToolId | null>
  readonly palette: Signal<readonly TrayGroup[]>
  readonly paletteSelection: Signal<string | null>
  readonly overlayLegend: Signal<OverlayLegendModel | null>
  readonly blueprint: Signal<BlueprintReport | null>
  readonly inspector: Signal<InspectorModel | null>
  readonly toasts: Signal<readonly ToastModel[]>
  /** Open Trace chain, or null when the panel is closed (PRD 3.1). */
  readonly trace: Signal<TraceModel | null>
  /** Open Posts panel, or null when closed (T4.1, PRD 3.5). */
  readonly posts: Signal<PostsModel | null>
  readonly postsTab: Signal<PostsTab>
  /** Open Emergency panel, or null when closed (T4.6, PRD 3.7). */
  readonly emergency: Signal<EmergencyModel | null>
  /** Open Standing Orders panel, or null when closed (T4.3). */
  readonly standingOrders: Signal<StandingOrdersModel | null>
  readonly standingOrdersTab: Signal<StandingOrdersTab>
  /** Open Directorate panel, or null when closed (T5.1). */
  readonly directorate: Signal<DirectorateModel | null>
  readonly directorateBranch: Signal<DirectorateBranchId | 'all'>
  /** Open Programs panel, or null when closed (T5.3). */
  readonly programs: Signal<ProgramsModel | null>
  /** Open Intelligence panel, or null when closed (T5.6). */
  readonly intelligence: Signal<IntelligenceModel | null>
  readonly intelligenceTab: Signal<IntelligenceTab>
  /** Open Reports hub, or null while closed/loading (T6.2). */
  readonly reports: Signal<ReportsModel | null>
  readonly reportsTab: Signal<ReportsTab>
  readonly hint: Signal<string | null>
  readonly hud: Signal<string | null>
  readonly committing: Signal<boolean>
  readonly canUndo: Signal<boolean>
  readonly canRedo: Signal<boolean>
  /** Staged strokes. Drives the Commit button, which the report cannot. */
  readonly stagedCount: Signal<number>

  /** Open Settings panel, or null when closed (T8.7). */
  readonly settings: Signal<SettingsModel | null>
  readonly settingsTab: Signal<SettingsTab>
  /** Open NewPrison screen, or null when closed (T8.7). */
  readonly newPrison: Signal<NewPrisonModel | null>
  /** Open Onboarding guide, or null when closed (T8.7). */
  readonly onboarding: Signal<OnboardingModel | null>
  /** Open Alerts panel, or null when closed (T8.7). */
  readonly alerts: Signal<AlertsModel | null>
  readonly alertsFilter: Signal<AlertSeverity | null>

  /** Open Routine editor panel, or null when closed (T8.9). */
  readonly routine: Signal<RoutineModel | null>
  /** Open Contracts panel, or null when closed (T8.9). */
  readonly contracts: Signal<ContractsModel | null>
  /** Open Intake panel, or null when closed (T8.9). */
  readonly intake: Signal<IntakeModel | null>
  /** Open Flow (logistics) panel, or null when closed (T8.9). */
  readonly flow: Signal<FlowModel | null>
  readonly flowChain: Signal<FlowChainId | null>

  /** Runtime error message to display (T8.15). Null when nothing is wrong. */
  readonly runtimeError: Signal<string | null>
}

const EMPTY_TOP_BAR: TopBarModel = {
  time: '00:00',
  day: 1,
  dayNote: 'Paused',
  balance: 0,
  balancePerDay: 0,
  population: 0,
  capacity: 0,
  danger: 0,
  reoffending: 0,
  alerts: 0,
  critical: false,
}

/** Fallback Posts model before the worker's first control publish. */
const EMPTY_POSTS_MODEL: PostsModel = {
  unfilledCount: 0,
  deployedCount: 0,
  hiredOfficers: 0,
  peakRequired: 0,
  peakWindow: null,
  hireSuggestion: 0,
  hireCost: 0,
  hireWagePerHour: 0,
  posts: [],
  patrols: [],
  sectors: [],
}

function emptyEmergencyModel(data: GameData): EmergencyModel {
  const emergency = data.balance.emergency
  const riotWage = data.staff.get(emergency.riotSquadDefId).hourlyWage * emergency.riotSquadCount
  return {
    danger: 0,
    riotActive: false,
    riotingCount: 0,
    containmentQuietMinutes: null,
    containmentNeededMinutes: data.balance.riot.containedMinutes,
    failureWarning: false,
    failureAtTick: null,
    playerFired: false,
    riotSquadHourlyCost: riotWage,
    nationalGuardCost: emergency.nationalGuardCost,
    selectedSectorId: null,
    selectedSectorName: null,
    levels: [
      {
        id: 'sector_lockdown',
        level: 1,
        label: 'Sector lockdown',
        costLabel: 'Free',
        sideEffect: '+suppression in that sector',
        active: false,
        disabled: true,
        disabledReason: 'Select a sector in Posts first',
      },
      {
        id: 'full_lockdown',
        level: 2,
        label: 'Full lockdown',
        costLabel: 'Free',
        sideEffect: '+suppression prison-wide, needs go unmet',
        active: false,
        disabled: false,
        disabledReason: null,
      },
      {
        id: 'riot_squad',
        level: 3,
        label: 'Call in riot squad',
        costLabel: `$${riotWage}/hour`,
        sideEffect: 'Injuries, +fear',
        active: false,
        disabled: false,
        disabledReason: null,
      },
      {
        id: 'free_fire',
        level: 4,
        label: 'Free fire authorisation',
        costLabel: 'Free',
        sideEffect: 'Deaths, huge re-offending and PR penalty',
        active: false,
        disabled: false,
        disabledReason: null,
      },
      {
        id: 'national_guard',
        level: 5,
        label: 'Call the national guard',
        costLabel: `$${emergency.nationalGuardCost}`,
        sideEffect: 'Prison retaken; you are almost certainly fired',
        active: false,
        disabled: false,
        disabledReason: null,
      },
    ],
  }
}

function emptyStandingOrdersModel(data: GameData): StandingOrdersModel {
  const defaults = data.balance.contraband.standingOrders.defaults
  return {
    rows: Object.entries(defaults).map(([misconduct, order]) => ({
      misconduct,
      label: misconduct,
      punishment: order.punishment,
      durationHours: order.durationHours < 0 ? 0 : order.durationHours,
      search: order.search,
    })),
    strictness: data.balance.contraband.standingOrders.defaultReassignmentStrictness,
    mealQuantity: data.balance.kitchen.defaultMealQuantity,
    mealVariety: data.balance.kitchen.defaultMealVariety,
    maxMealVariety: data.balance.kitchen.maxMealVariety,
    projection: null,
  }
}

/** PRD 6.5: the toast rail holds a handful, and the alerts panel holds the rest. */
const MAX_TOASTS = 4

function severityLabel(severity: NotificationSeverity): ToastSeverity {
  if (severity === NOTIFICATION_SEVERITY.CRITICAL) return 'critical'
  if (severity === NOTIFICATION_SEVERITY.WARN) return 'warn'
  return 'info'
}

function sameTopBar(a: TopBarModel, b: TopBarModel): boolean {
  return (
    a.time === b.time &&
    a.day === b.day &&
    a.dayNote === b.dayNote &&
    a.balance === b.balance &&
    a.balancePerDay === b.balancePerDay &&
    a.population === b.population &&
    a.capacity === b.capacity &&
    a.danger === b.danger &&
    a.reoffending === b.reoffending &&
    a.alerts === b.alerts &&
    a.critical === b.critical
  )
}

/** The inspector's view model, from the worker's answer. */
function toInspectorModel(result: InspectResult): InspectorModel {
  switch (result.kind) {
    case 'inmate':
      return {
        kind: 'inmate',
        entityId: result.entityId,
        name: result.name,
        subtitle: result.subtitle,
        categoryId: result.categoryId,
        categoryName: result.categoryName,
        categoryToken: categoryToken(result.categoryId),
        criticalNeedCount: result.criticalNeedCount,
        sentenceServedLabel: result.sentenceServedLabel,
        sentenceTotalLabel: result.sentenceTotalLabel,
        sentenceProgress: result.sentenceProgress,
        paroleLabel: result.paroleLabel,
        needs: result.needs,
        traits: result.traits,
        reputations: result.reputations,
        unknownReputationCount: result.unknownReputationCount,
        activity: result.activity,
        cellLabel: result.cellLabel,
        entitlement: result.entitlement,
        suppression: result.suppression,
        workLabel: result.workLabel,
        programmeLabel: result.programmeLabel,
        grades: result.grades,
        reoffendPercent: result.reoffendPercent,
        misconduct: result.misconduct,
      }
    case 'staff':
      return {
        kind: 'staff',
        entityId: result.entityId,
        name: result.name,
        roleName: result.roleName,
        wagePerHour: result.wagePerHour,
        needs: result.needs,
        moraleContribution: result.moraleContribution,
        currentTask: result.currentTask,
        postAssignment: result.postAssignment,
        equipment: result.equipment,
      }
    case 'room':
      return {
        kind: 'room',
        roomId: result.roomId,
        name: result.name,
        typeName: result.typeName,
        width: result.width,
        height: result.height,
        tiles: result.tiles,
        functional: result.functional,
        requirements: result.requirements,
        properties: result.properties,
        occupants: result.occupants,
        gradeLines: result.gradeLines,
        grade: result.grade,
        gradeMax: result.gradeMax,
        throughputLabel: result.throughputLabel,
      }
    case 'object':
      return {
        kind: 'object',
        entityId: result.entityId,
        name: result.name,
        cost: result.cost,
        hasPower: result.hasPower,
        hasWater: result.hasWater,
        needsPower: result.needsPower,
        needsWater: result.needsWater,
        roomName: result.roomName,
        condition: result.condition,
        conditionMax: result.conditionMax,
        needsServed: result.needsServed,
        contrabandRisk: result.contrabandRisk,
      }
    case 'tile':
      return {
        kind: 'tile',
        x: result.x,
        y: result.y,
        floorName: result.floorName,
        wallName: result.wallName,
        roomName: result.roomName,
        walkable: result.walkable,
      }
  }
}

export class Session {
  readonly state: SessionState
  bridge: SimBridge
  renderer: BlockworkRenderer
  readonly data: GameData
  mapSize: number

  /** Staged, unsent, and priced by the worker. Nothing here has been paid for. */
  readonly staged = new Blueprint()

  #palettes: Readonly<Record<DockToolId, Palette>>
  #unlockKey = ''
  #validationId = 0
  #focusTile: Tile | null = null
  #frames = 0
  #sampledAt = 0
  /** Previous render poses for snapshot interpolation (T2.8). */
  #prevAgents: RenderAgent[] = []
  /** Notification id → its resolved chain, held while the toast is on screen. */
  readonly #traces = new Map<number, TraceResult>()
  /** Notifications already asked about, so a re-read never double-requests. */
  readonly #requestedTraces = new Set<number>()
  /** The chain the panel is showing, for node focus. */
  #openTrace: TraceResult | null = null
  /** Snapshot entity id highlighted with the selection ring. */
  #selectedSnapshotId: number | null = null
  /** Sector chosen in Posts for Emergency level-1 lockdown / post target. */
  #selectedSectorId: number | null = null
  /** Sector currently being painted onto the map. */
  #paintSectorId: number | null = null
  /** Pending sector name after create, matched on next control HUD. */
  #pendingSectorName: string | null = null
  /** Patrol waypoint collection mode. */
  #patrolWaypoints: number[] | null = null
  #sectorCounter = 1
  #postCounter = 1
  #patrolCounter = 1
  /** Bumped to drop in-flight auto-route replies after discard / commit. */
  #autoRouteGeneration = 0
  readonly #categoryIds: readonly string[]
  readonly #objectIds: readonly string[]
  /** Local mirror of CommitLedger.redoSize for the TopBar button. */
  #redoDepth = 0
  #overlayPaletteId: OverlayPaletteId = 'standard'
  #overlayRequestKey = ''
  #overlayRefreshBucket = -1
  #overlayGeneration = 0
  #overlayLegendKey = ''
  #reportsGeneration = 0
  #reportsRefreshBucket = -1
  #reportsOpen = false
  /** Set once at boot; isolation does not change at runtime (T8.16). */
  readonly #isolationDiagnostic = isolationDiagnostic()

  /**
   * Performance: last control version seen (T8.19). Panel refresh is skipped
   * when the version hasn't changed, keeping the 2ms main-thread budget.
   */
  #lastControlVersion = 0
  /** Performance: cached sector colour map (T8.19). */
  #sectorColourCache: Map<number, number> = new Map()
  /** Performance: key for sector colour cache invalidation (T8.19). */
  #sectorColourKey = ''

  /** Audio engine for ambient bed and one-shots (T8.8). */
  #audioEngine: AudioEngine | null = null
  #audioContext: { resume(): Promise<void>; state: string } | null = null
  #audioUnlocked = false
  /** Backed by the app settings; used for timed autosave scheduling. */
  #autosaveHours: AutosaveHours = DEFAULT_APP_SETTINGS.autosaveHours
  #appSettings: AppSettings = DEFAULT_APP_SETTINGS
  /** Canvas host, so a New Prison restart can rebuild the renderer. */
  #host: HTMLElement
  /** Guided Contract controller; null after skip. */
  #onboarding: Onboarding | null = null
  #onboardingStarted = false

  /** Callback fired when settings change via the Settings panel. */
  onSettingsChange: ((settings: AppSettings) => void) | null = null

  /** Current autosave cadence in in-game hours. */
  get autosaveHours(): AutosaveHours {
    return this.#autosaveHours
  }

  private constructor(
    bridge: SimBridge,
    renderer: BlockworkRenderer,
    data: GameData,
    mapSize: number,
    host: HTMLElement,
  ) {
    this.bridge = bridge
    this.renderer = renderer
    this.data = data
    this.mapSize = mapSize
    this.#host = host
    this.#palettes = createPalettes(data)
    this.#categoryIds = data.securityCategories.ids()
    this.#objectIds = data.objects.ids()
    this.#installCommandTap()

    this.state = {
      topBar: signal(EMPTY_TOP_BAR),
      speed: signal<SpeedStop>(1),
      tool: signal<DockToolId | null>(null),
      palette: signal<readonly TrayGroup[]>([]),
      paletteSelection: signal<string | null>(null),
      overlayLegend: signal<OverlayLegendModel | null>(null),
      blueprint: signal<BlueprintReport | null>(null),
      inspector: signal<InspectorModel | null>(null),
      toasts: signal<readonly ToastModel[]>([]),
      trace: signal<TraceModel | null>(null),
      posts: signal<PostsModel | null>(null),
      postsTab: signal<PostsTab>('posts'),
      emergency: signal<EmergencyModel | null>(null),
      standingOrders: signal<StandingOrdersModel | null>(null),
      standingOrdersTab: signal<StandingOrdersTab>('punishment'),
      directorate: signal<DirectorateModel | null>(null),
      directorateBranch: signal<DirectorateBranchId | 'all'>('all'),
      programs: signal<ProgramsModel | null>(null),
      intelligence: signal<IntelligenceModel | null>(null),
      intelligenceTab: signal<IntelligenceTab>('sources'),
      reports: signal<ReportsModel | null>(null),
      reportsTab: signal<ReportsTab>('needs'),
      hint: signal<string | null>(null),
      hud: signal<string | null>(null),
      committing: signal(false),
      canUndo: signal(false),
      canRedo: signal(false),
      stagedCount: signal(0),
      settings: signal<SettingsModel | null>(null),
      settingsTab: signal<SettingsTab>('audio'),
      newPrison: signal<NewPrisonModel | null>(null),
      onboarding: signal<OnboardingModel | null>(null),
      alerts: signal<AlertsModel | null>(null),
      alertsFilter: signal<AlertSeverity | null>(null),
      routine: signal<RoutineModel | null>(null),
      contracts: signal<ContractsModel | null>(null),
      intake: signal<IntakeModel | null>(null),
      flow: signal<FlowModel | null>(null),
      flowChain: signal<FlowChainId | null>(null),
      runtimeError: signal<string | null>(null),
    }

    // The renderer draws the bridge's arrays directly. On the shared transport
    // those *are* the simulation's tile buffers, so this is the last copy that
    // never happens.
    renderer.setFloors(bridge.tiles.floorMaterial)
    renderer.setWalls(bridge.tiles.wallMaterial)
    renderer.setSectorIds(bridge.tiles.sectorId)

    renderer.tools.handlers = {
      onTap: (tile) => {
        this.#onTap(tile)
      },
      onStrokeUpdate: (stroke) => {
        this.#onStrokePreview(stroke)
      },
      onStrokeEnd: (stroke) => {
        this.#onStrokeEnd(stroke)
      },
      onStrokeCancel: () => {
        this.#clearPreview()
      },
    }

    // Taps select from the start, before any tool has been opened.
    renderer.tools.active = true

    renderer.app.ticker.add(this.#frame)

    if (this.#isolationDiagnostic !== null) {
      this.state.hud.value = this.#isolationDiagnostic
    }

    this.#beginOnboarding()
  }

  static async create(options: SessionOptions): Promise<Session> {
    const mapSize = options.mapSize ?? DEFAULT_MAP_SIZE
    const seed = options.seed ?? 0xb10c_0001

    const bridge = new SimBridge({
      worker: createSimWorker(),
      seed,
      mapSize,
      ...(options.firstOrderGrace === undefined
        ? {}
        : { firstOrderGrace: options.firstOrderGrace }),
    })

    const renderer = await createSessionRenderer(options.parent, options.data, mapSize)

    const centre = centreTile(mapSize) * 32
    renderer.camera.moveTo(centre, centre)

    const session = new Session(bridge, renderer, options.data, mapSize, options.parent)
    session.#acceptGuidedContract()
    return session
  }

  /**
   * Moves the canvas into the shell's stage and resizes it to fit.
   *
   * The renderer is created before Preact mounts, because negotiating a GPU
   * context is the slowest part of boot and there is no reason to wait for a
   * DOM tree to do it. That means it is created against a parent that is not
   * its final one, and `resizeTo` has to be repointed or the canvas keeps the
   * dimensions of the whole page and is clipped by a stage that is a top bar
   * and a dock shorter.
   *
   * Re-parenting a live WebGL canvas is free; re-creating one is not.
   */
  attachTo(stage: HTMLElement): void {
    this.#host = stage
    if (this.renderer.canvas.parentElement !== stage) {
      stage.appendChild(this.renderer.canvas)
    }
    this.renderer.app.resizeTo = stage
    this.renderer.app.resize()
  }

  dispose(): void {
    this.renderer.app.ticker.remove(this.#frame)
    this.renderer.destroy()
    this.bridge.dispose()
    this.#audioEngine?.dispose()
  }

  /**
   * Starts a new prison from the New Prison panel (T8.8).
   *
   * Replaces the worker and, when the map size changes, the renderer. UI
   * state that belonged to the old world is dropped.
   */
  async startNewPrison(): Promise<void> {
    const model = this.state.newPrison.value
    if (model === null) return
    const config = this.#configFromNewPrisonModel(model)
    await this.restart(config)
  }

  /** Pause and return to the New Prison screen (T8.8 quit). */
  quitToNewPrison(): void {
    this.setSpeed(0)
    this.#closeAllPanels()
    this.openNewPrison()
  }

  async restart(config: NewPrisonConfig): Promise<void> {
    this.setSpeed(0)
    this.#resetWorldUi()
    this.bridge.dispose()

    const sizeChanged = config.mapSize !== this.mapSize
    this.mapSize = config.mapSize

    this.bridge = new SimBridge({
      worker: createSimWorker(),
      seed: config.seed,
      mapSize: config.mapSize,
      firstOrderGrace: config.firstOrderGrace,
      prison: config,
      speed: 1,
    })

    if (sizeChanged) {
      this.renderer.app.ticker.remove(this.#frame)
      this.renderer.destroy()
      this.renderer = await createSessionRenderer(this.#host, this.data, config.mapSize)
      this.#bindRenderer()
      this.attachTo(this.#host)
    } else {
      this.renderer.setFloors(this.bridge.tiles.floorMaterial)
      this.renderer.setWalls(this.bridge.tiles.wallMaterial)
      this.renderer.setSectorIds(this.bridge.tiles.sectorId)
      this.renderer.markTilesDirty(0, 0, config.mapSize, config.mapSize)
    }

    const centre = centreTile(config.mapSize) * 32
    this.renderer.camera.moveTo(centre, centre)
    this.state.speed.value = 1
    this.bridge.setSpeed(1)
    this.closeNewPrison()
    this.#installCommandTap()
    this.#beginOnboarding()
    this.#acceptGuidedContract()
  }

  #installCommandTap(): void {
    this.bridge.onCommandSent = (command: Command) => {
      this.#onboarding?.noteCommand(command.type, performance.now())
    }
  }

  #bindRenderer(): void {
    this.renderer.setFloors(this.bridge.tiles.floorMaterial)
    this.renderer.setWalls(this.bridge.tiles.wallMaterial)
    this.renderer.setSectorIds(this.bridge.tiles.sectorId)
    this.renderer.tools.handlers = {
      onTap: (tile) => {
        this.#onTap(tile)
      },
      onStrokeUpdate: (stroke) => {
        this.#onStrokePreview(stroke)
      },
      onStrokeEnd: (stroke) => {
        this.#onStrokeEnd(stroke)
      },
      onStrokeCancel: () => {
        this.#clearPreview()
      },
    }
    this.renderer.tools.active = true
    this.renderer.app.ticker.add(this.#frame)
  }

  #resetWorldUi(): void {
    this.staged.clear()
    this.#renderBlueprint()
    this.#abandonValidation()
    this.#closeAllPanels()
    this.state.toasts.value = []
    this.#traces.clear()
    this.#requestedTraces.clear()
    this.#focusTile = null
    this.#selectedSnapshotId = null
    this.#selectedSectorId = null
    this.#paintSectorId = null
    this.#patrolWaypoints = null
    this.#openTrace = null
    this.state.trace.value = null
    this.state.canUndo.value = false
    this.state.canRedo.value = false
    this.#redoDepth = 0
    this.#lastControlVersion = 0
    this.renderer.clearPins()
    this.renderer.setSelections([])
  }

  #closeAllPanels(): void {
    this.closeInspector()
    this.closePosts()
    this.closeEmergency()
    this.closeStandingOrders()
    this.closeTrace()
    this.closeDirectorate()
    this.closePrograms()
    this.closeIntelligence()
    this.closeReports()
    this.closeSettings()
    this.closeAlerts()
    this.closeRoutine()
    this.closeContracts()
    this.closeIntake()
    this.closeFlow()
    this.state.tool.value = null
    this.state.palette.value = []
    this.state.paletteSelection.value = null
  }

  #configFromNewPrisonModel(model: NewPrisonModel): NewPrisonConfig {
    return newPrisonConfigFromModel(model, this.data)
  }

  #acceptGuidedContract(): void {
    this.bridge.sendCommand({
      type: 'contracts.accept',
      issuedAtTick: this.#tick(),
      payload: { contractId: GUIDED_CONTRACT_ID },
    })
  }

  #beginOnboarding(): void {
    this.#onboarding = new Onboarding('guided', performance.now())
    this.#onboardingStarted = true
    this.#publishOnboarding()
  }

  #publishOnboarding(): void {
    const machine = this.#onboarding
    if (machine === null || machine.mode === 'off') {
      this.state.onboarding.value = null
      return
    }
    const contractName = this.data.contracts.find(GUIDED_CONTRACT_ID)?.name ?? 'Guided Contract'
    this.state.onboarding.value = onboardingModelFromMachine(
      machine,
      performance.now(),
      contractName,
      this.#host,
    )
  }

  #updateOnboarding(): void {
    const machine = this.#onboarding
    if (machine === null || !this.#onboardingStarted) return
    const control = this.bridge.latestControl()
    const contract = control?.contracts.active.find((row) => row.id === GUIDED_CONTRACT_ID) ?? null
    const view =
      contract === null
        ? null
        : {
            todoItems: contract.todos.map((todo) => ({
              label: todo.label,
              predicate: { type: todo.id },
            })),
            itemPassed: contract.todos.map((todo) => todo.done),
          }
    machine.update(objectivesFromContract(view), performance.now())
    if (machine.mode === 'off' || (view !== null && view.itemPassed.every(Boolean) && view.itemPassed.length > 0)) {
      if (view !== null && view.itemPassed.every(Boolean) && view.itemPassed.length > 0) {
        this.state.onboarding.value = onboardingModelFromMachine(
          machine,
          performance.now(),
          this.data.contracts.find(GUIDED_CONTRACT_ID)?.name ?? 'Guided Contract',
          this.#host,
        )
      } else {
        this.state.onboarding.value = null
      }
      return
    }
    this.#publishOnboarding()
  }

  /* ---------------------------------------------------------------------- */
  /* Audio (T8.8)                                                            */
  /* ---------------------------------------------------------------------- */

  /**
   * Initializes the audio engine with the given settings.
   * Called once on boot after a user gesture (browsers require interaction).
   */
  initAudio(settings: AudioSettings): void {
    if (this.#audioEngine !== null) return

    try {
      const context = new AudioContext()
      this.#audioContext = context
      const backend = new WebAudioBackend(context)
      this.#audioEngine = createAudioEngine(backend, settings)
    } catch {
      this.#audioEngine = null
      this.#audioContext = null
    }
  }

  /** Resumes a suspended AudioContext after the first player gesture (T8.8). */
  unlockAudio(): void {
    if (this.#audioUnlocked) return
    this.#audioUnlocked = true
    void this.#audioContext?.resume()
  }

  /**
   * Applies full app settings, updating audio, autosave cadence, overlay palette.
   */
  applyAppSettings(settings: AppSettings): void {
    this.#appSettings = settings
    this.#autosaveHours = settings.autosaveHours

    if (this.#audioEngine !== null) {
      this.#audioEngine.applySettings(settings.audio)
    }

    this.setOverlayPalette(settings.accessibility.palette === 'default' ? 'standard' : settings.accessibility.palette)

    if (this.state.settings.value !== null) {
      this.state.settings.value = settingsModelFromAppSettings(settings)
    }
  }

  /**
   * Builds current settings from the settings panel state.
   * Used to pass to the onSettingsChange callback.
   */
  #buildCurrentSettings(): AppSettings {
    const model = this.state.settings.value
    if (model === null) return DEFAULT_APP_SETTINGS

    return {
      audio: {
        music: model.music,
        sfx: model.sfx,
        muted: model.muted,
      },
      accessibility: {
        palette: model.palette,
        reduceMotion: model.reduceMotion,
        typeScale: model.typeScale,
        preferNoFailure: model.preferNoFailure,
      },
      autosaveHours: model.autosaveHours as AutosaveHours,
    }
  }

  /* ---------------------------------------------------------------------- */
  /* Tools                                                                   */
  /* ---------------------------------------------------------------------- */

  /** The palette entry a stroke would use, or undefined in select mode. */
  activeEntry(): PaletteEntry | undefined {
    const tool = this.state.tool.value
    const selection = this.state.paletteSelection.value
    if (tool === null || selection === null) return undefined
    return this.#palettes[tool].entries.get(selection)
  }

  /** Opens a tool, or closes it if it was already open. */
  selectTool(tool: DockToolId): void {
    const already = this.state.tool.value === tool
    const next = already ? null : tool

    this.state.tool.value = next

    if (next === null) {
      this.state.palette.value = []
      this.state.paletteSelection.value = null
      this.closePosts()
      this.closeEmergency()
      this.closeStandingOrders()
      this.closeDirectorate()
      this.closePrograms()
      this.closeIntelligence()
      this.closeReports()
      this.closeRoutine()
      this.closeContracts()
      this.closeIntake()
      this.closeFlow()
    } else if (next === 'posts') {
      this.state.palette.value = []
      this.state.paletteSelection.value = null
      this.closeEmergency()
      this.closeStandingOrders()
      this.closeDirectorate()
      this.closePrograms()
      this.closeIntelligence()
      this.closeReports()
      this.closeRoutine()
      this.closeContracts()
      this.closeIntake()
      this.closeFlow()
      this.openPosts()
    } else if (next === 'emergency') {
      this.state.palette.value = []
      this.state.paletteSelection.value = null
      this.closePosts()
      this.closeStandingOrders()
      this.closeDirectorate()
      this.closePrograms()
      this.closeIntelligence()
      this.closeReports()
      this.closeRoutine()
      this.closeContracts()
      this.closeIntake()
      this.closeFlow()
      this.openEmergency()
    } else if (next === 'plan') {
      // Plan opens Standing Orders (T4.3 policy matrix).
      this.state.palette.value = []
      this.state.paletteSelection.value = null
      this.closePosts()
      this.closeEmergency()
      this.closeDirectorate()
      this.closePrograms()
      this.closeIntelligence()
      this.closeReports()
      this.closeRoutine()
      this.closeContracts()
      this.closeIntake()
      this.closeFlow()
      this.openStandingOrders()
    } else if (next === 'flow') {
      // Flow opens the logistics panel (T8.9).
      this.state.palette.value = []
      this.state.paletteSelection.value = null
      this.closePosts()
      this.closeEmergency()
      this.closeStandingOrders()
      this.closeDirectorate()
      this.closePrograms()
      this.closeIntelligence()
      this.closeReports()
      this.closeRoutine()
      this.closeContracts()
      this.closeIntake()
      this.openFlow()
    } else if (next === 'reports') {
      this.closePosts()
      this.closeEmergency()
      this.closeStandingOrders()
      this.closeDirectorate()
      this.closePrograms()
      this.closeIntelligence()
      this.closeReports()
      this.closeRoutine()
      this.closeContracts()
      this.closeIntake()
      this.closeFlow()
      const palette = this.#palettes.reports
      this.state.palette.value = palette.groups
      this.state.paletteSelection.value = palette.initial
      this.#openReportsSelection(palette.initial)
    } else {
      this.closePosts()
      this.closeEmergency()
      this.closeStandingOrders()
      this.closeDirectorate()
      this.closePrograms()
      this.closeIntelligence()
      this.closeReports()
      this.closeRoutine()
      this.closeContracts()
      this.closeIntake()
      this.closeFlow()
      const palette = this.#palettes[next]
      this.state.palette.value = palette.groups
      this.state.paletteSelection.value = palette.initial
      if (next === 'overlay') this.#syncOverlayMode()
    }

    this.#syncInput()
  }

  openPosts(): void {
    const control = this.bridge.latestControl()
    this.state.posts.value = control?.posts ?? EMPTY_POSTS_MODEL
    this.state.postsTab.value = 'posts'
  }

  closePosts(): void {
    this.state.posts.value = null
    this.#paintSectorId = null
    this.#patrolWaypoints = null
    this.#pendingSectorName = null
    if (this.state.tool.value === 'posts') this.state.tool.value = null
    this.#syncInput()
  }

  setPostsTab(tab: PostsTab): void {
    this.state.postsTab.value = tab
    if (tab !== 'sectors') this.#paintSectorId = null
    if (tab !== 'patrols') this.#patrolWaypoints = null
    this.#syncInput()
  }

  selectPostsSector(sectorId: number): void {
    this.#selectedSectorId = sectorId
    this.#paintSectorId = sectorId
    this.state.postsTab.value = 'sectors'
    this.#syncInput()
    this.#refreshOpenControlPanels()
  }

  /** Selects a post in the Posts panel and switches to the posts tab. */
  selectPostsPost(_postId: number): void {
    this.state.postsTab.value = 'posts'
  }

  /** Selects a patrol route in the Posts panel and switches to the patrols tab. */
  selectPostsPatrol(_patrolId: number): void {
    this.state.postsTab.value = 'patrols'
  }

  createPostsSector(): void {
    const name = `Sector ${this.#sectorCounter}`
    this.#sectorCounter += 1
    const colours = ['#c44', '#48a', '#4a8', '#a84', '#84a', '#4aa']
    const colour = colours[(this.#sectorCounter - 1) % colours.length] ?? '#48a'
    this.#pendingSectorName = name
    this.bridge.sendCommand({
      type: 'sector.create',
      issuedAtTick: this.#tick(),
      payload: {
        name,
        colour,
        access: this.data.balance.sectors.defaultAccess,
      },
    })
    this.state.postsTab.value = 'sectors'
    this.#syncInput()
  }

  configurePostsSector(sectorId: number): void {
    const row = this.state.posts.value?.sectors.find((s) => s.id === sectorId)
    const modes = ['staffOnly', 'secure', 'shared', 'open'] as const
    const currentAccess = (() => {
      if (row === undefined) return this.data.balance.sectors.defaultAccess
      const label = row.access.toLowerCase()
      if (label.includes('staff')) return 'staffOnly'
      if (label.includes('secure')) return 'secure'
      if (label.includes('open')) return 'open'
      return 'shared'
    })()
    const index = modes.indexOf(currentAccess)
    const next = modes[(index + 1) % modes.length] ?? 'shared'
    this.bridge.sendCommand({
      type: 'sector.configure',
      issuedAtTick: this.#tick(),
      payload: { sectorId, access: next },
    })
    this.#selectedSectorId = sectorId
    this.#paintSectorId = sectorId
  }

  createPostsPost(): void {
    const sectorId = this.#paintSectorId ?? this.#selectedSectorId
    if (sectorId === null) {
      this.state.hint.value = 'Select or create a sector before adding a post'
      return
    }
    const name = `Post ${this.#postCounter}`
    this.#postCounter += 1
    this.bridge.sendCommand({
      type: 'post.create',
      issuedAtTick: this.#tick(),
      payload: {
        name,
        staffRole: 'officer',
        count: 1,
        sectorId,
        timeWindows: [],
      },
    })
    this.state.postsTab.value = 'posts'
  }

  beginPostsPatrol(): void {
    if (this.#patrolWaypoints !== null && this.#patrolWaypoints.length >= 2) {
      this.confirmPostsPatrol()
    }
    this.#patrolWaypoints = []
    this.state.postsTab.value = 'patrols'
    this.#syncInput()
  }

  confirmPostsPatrol(): void {
    const waypoints = this.#patrolWaypoints
    if (waypoints === null || waypoints.length < 2) {
      this.state.hint.value = 'Tap at least two tiles for a patrol route'
      return
    }
    const name = `Patrol ${this.#patrolCounter}`
    this.#patrolCounter += 1
    this.bridge.sendCommand({
      type: 'post.createPatrol',
      issuedAtTick: this.#tick(),
      payload: {
        name,
        staffRole: 'officer',
        count: 1,
        waypoints,
        timeWindows: [],
      },
    })
    this.#patrolWaypoints = null
    this.#syncInput()
  }

  cancelPostsPatrol(): void {
    this.#patrolWaypoints = null
    this.#syncInput()
  }

  /** Returns true when a patrol collect was cancelled (Escape should stop). */
  cancelPostsPatrolIfActive(): boolean {
    if (this.#patrolWaypoints === null) return false
    this.cancelPostsPatrol()
    return true
  }

  hireSuggestedOfficers(): void {
    const model = this.state.posts.value
    if (model === null || model.hireSuggestion <= 0) return
    for (let i = 0; i < model.hireSuggestion; i += 1) {
      this.bridge.sendCommand({
        type: 'staff.hire',
        issuedAtTick: this.#tick(),
        payload: { defId: 'officer' },
      })
    }
  }

  /** Fires a staff member by their entity id. */
  fireStaff(staffId: number): void {
    this.bridge.sendCommand({
      type: 'staff.fire',
      issuedAtTick: this.#tick(),
      payload: { staffId },
    })
    this.closeInspector()
  }

  /** Accepts a morale pay demand (staff wages increase). */
  acceptPayDemand(): void {
    this.bridge.sendCommand({
      type: 'morale.acceptPayDemand',
      issuedAtTick: this.#tick(),
      payload: {},
    })
  }

  /** Refuses a morale pay demand (morale decreases). */
  refusePayDemand(): void {
    this.bridge.sendCommand({
      type: 'morale.refusePayDemand',
      issuedAtTick: this.#tick(),
      payload: {},
    })
  }

  /** Assigns an inmate to a labour job. */
  assignLabour(jobId: string, inmateId: number): void {
    this.bridge.sendCommand({
      type: 'labour.assign',
      issuedAtTick: this.#tick(),
      payload: { jobId, inmateId },
    })
  }

  /** Unassigns an inmate from their labour job. */
  unassignLabour(inmateId: number): void {
    this.bridge.sendCommand({
      type: 'labour.unassign',
      issuedAtTick: this.#tick(),
      payload: { inmateId },
    })
  }

  openEmergency(): void {
    const control = this.bridge.latestControl()
    const base = control?.emergency ?? emptyEmergencyModel(this.data)
    this.state.emergency.value = this.#withSelectedSector(base)
  }

  closeEmergency(): void {
    this.state.emergency.value = null
    if (this.state.tool.value === 'emergency') this.state.tool.value = null
  }

  openStandingOrders(): void {
    const control = this.bridge.latestControl()
    this.state.standingOrders.value = control?.standingOrders ?? emptyStandingOrdersModel(this.data)
    this.state.standingOrdersTab.value = 'punishment'
  }

  closeStandingOrders(): void {
    this.state.standingOrders.value = null
    if (this.state.tool.value === 'plan') this.state.tool.value = null
  }

  setStandingOrdersTab(tab: StandingOrdersTab): void {
    this.state.standingOrdersTab.value = tab
  }

  #dispatchStandingOrders(type: string, payload: Record<string, number | boolean | string>): void {
    this.bridge.sendCommand({
      type,
      issuedAtTick: this.#tick(),
      payload,
    })
  }

  standingOrdersPunishment(misconduct: string, punishment: StandingPunishment): void {
    const row = this.state.standingOrders.value?.rows.find((r) => r.misconduct === misconduct)
    const durationHours = row?.durationHours ?? 0
    this.#dispatchStandingOrders('standingOrders.setPunishment', {
      misconduct,
      punishment,
      durationHours,
    })
    this.#patchStandingOrderRow(misconduct, { punishment })
  }

  standingOrdersDuration(misconduct: string, durationHours: number): void {
    const row = this.state.standingOrders.value?.rows.find((r) => r.misconduct === misconduct)
    const punishment = row?.punishment ?? 'lockdown'
    this.#dispatchStandingOrders('standingOrders.setPunishment', {
      misconduct,
      punishment,
      durationHours,
    })
    this.#patchStandingOrderRow(misconduct, { durationHours })
  }

  standingOrdersSearchTrigger(misconduct: string, search: boolean): void {
    this.#dispatchStandingOrders('standingOrders.setSearchTrigger', { misconduct, search })
    this.#patchStandingOrderRow(misconduct, { search })
  }

  standingOrdersStrictness(strictness: StandingStrictness): void {
    this.#dispatchStandingOrders('standingOrders.setStrictness', { strictness })
    const current = this.state.standingOrders.value
    if (current !== null) {
      this.state.standingOrders.value = { ...current, strictness }
    }
  }

  standingOrdersMealQuantity(quantity: StandingMealQuantity): void {
    const current = this.state.standingOrders.value
    const variety = current?.mealVariety ?? this.data.balance.kitchen.defaultMealVariety
    this.#dispatchStandingOrders('standingOrders.setMeals', { quantity, variety })
    if (current !== null) {
      this.state.standingOrders.value = { ...current, mealQuantity: quantity }
    }
  }

  standingOrdersMealVariety(variety: number): void {
    const current = this.state.standingOrders.value
    const quantity = current?.mealQuantity ?? this.data.balance.kitchen.defaultMealQuantity
    this.#dispatchStandingOrders('standingOrders.setMeals', { quantity, variety })
    if (current !== null) {
      this.state.standingOrders.value = { ...current, mealVariety: variety }
    }
  }

  #patchStandingOrderRow(
    misconduct: string,
    patch: Partial<{
      punishment: StandingPunishment
      durationHours: number
      search: boolean
    }>,
  ): void {
    const current = this.state.standingOrders.value
    if (current === null) return
    this.state.standingOrders.value = {
      ...current,
      rows: current.rows.map((row) => (row.misconduct === misconduct ? { ...row, ...patch } : row)),
    }
  }

  #withSelectedSector(model: EmergencyModel): EmergencyModel {
    const sectorId = this.#selectedSectorId
    const sector =
      sectorId === null
        ? undefined
        : model.selectedSectorId === sectorId
          ? { id: sectorId, name: model.selectedSectorName }
          : (this.state.posts.value?.sectors.find((s) => s.id === sectorId) ??
            this.bridge.latestControl()?.posts.sectors.find((s) => s.id === sectorId))

    const selected = sector !== undefined
    const name =
      sector !== undefined && 'name' in sector ? (sector.name ?? null) : model.selectedSectorName

    return {
      ...model,
      selectedSectorId: selected ? sectorId : null,
      selectedSectorName: selected ? name : null,
      levels: model.levels.map((level) => {
        if (level.id !== 'sector_lockdown') return level
        return {
          ...level,
          disabled: !selected,
          disabledReason: selected ? null : 'Select a sector in Posts first',
        }
      }),
    }
  }

  /**
   * Refreshes open control panels from the worker's control HUD.
   *
   * T8.19: Throttled to only run when the control version changes. This keeps
   * us within PRD 7.5's 2ms main-thread budget by avoiding rebuilding signal
   * values every frame (at 60fps) when nothing has changed.
   */
  #refreshOpenControlPanels(): void {
    const control = this.bridge.latestControl()
    if (control === null) return

    const version = control.version ?? 0
    if (version === this.#lastControlVersion) return
    this.#lastControlVersion = version

    this.#syncPaletteUnlocks(control.unlocks)

    if (this.#pendingSectorName !== null) {
      const created = control.posts.sectors.find((s) => s.name === this.#pendingSectorName)
      if (created !== undefined) {
        this.#selectedSectorId = created.id
        this.#paintSectorId = created.id
        this.#pendingSectorName = null
        this.#syncInput()
      }
    }

    if (this.state.posts.value !== null) {
      this.state.posts.value = control.posts
    }
    if (this.state.emergency.value !== null) {
      this.state.emergency.value = this.#withSelectedSector(control.emergency)
    }
    if (this.state.standingOrders.value !== null) {
      this.state.standingOrders.value = control.standingOrders
    }
    if (this.state.directorate.value !== null) {
      const selectedId = this.state.directorate.value.selectedId
      this.state.directorate.value = { ...control.directorate, selectedId }
    }
    if (this.state.programs.value !== null) {
      const selectedId = this.state.programs.value.selectedId
      this.state.programs.value = { ...control.programs, selectedId }
    }
    if (this.state.intelligence.value !== null) {
      this.state.intelligence.value = control.intelligence
    }
    if (this.state.routine.value !== null) {
      this.state.routine.value = control.routine
    }
    if (this.state.contracts.value !== null) {
      this.state.contracts.value = control.contracts
    }
    if (this.state.intake.value !== null) {
      this.state.intake.value = control.intake
    }
    if (this.state.flow.value !== null) {
      this.state.flow.value = control.flow
    }
  }

  /** Rebuild trays when Directorate research unlocks rooms / objects / staff. */
  #syncPaletteUnlocks(unlocks: UnlockSnapshot): void {
    const key = unlockSnapshotKey(unlocks)
    if (key === this.#unlockKey) return
    this.#unlockKey = key
    this.#palettes = createPalettes(this.data, unlocks)

    const tool = this.state.tool.value
    if (tool === null) return
    if (tool === 'posts' || tool === 'emergency' || tool === 'plan' || tool === 'flow') return

    const palette = this.#palettes[tool]
    this.state.palette.value = palette.groups
    const selection = this.state.paletteSelection.value
    if (selection !== null && !palette.entries.has(selection)) {
      this.state.paletteSelection.value = palette.initial
    }
    this.#syncInput()
  }

  #dispatchEmergency(type: string, payload: Record<string, number | boolean | string> = {}): void {
    this.bridge.sendCommand({
      type,
      issuedAtTick: this.#tick(),
      payload,
    })
  }

  emergencySectorLockdown(): void {
    const sectorId = this.state.emergency.value?.selectedSectorId ?? this.#selectedSectorId
    if (sectorId === null || sectorId === undefined) return
    this.#dispatchEmergency('emergency.sectorLockdown', { sectorId })
    this.#patchEmergencyLevel('sector_lockdown', true)
  }

  emergencyLiftSectorLockdown(): void {
    const sectorId = this.state.emergency.value?.selectedSectorId ?? this.#selectedSectorId
    if (sectorId === null || sectorId === undefined) return
    this.#dispatchEmergency('emergency.liftSectorLockdown', { sectorId })
    this.#patchEmergencyLevel('sector_lockdown', false)
  }

  emergencyFullLockdown(): void {
    this.#dispatchEmergency('emergency.fullLockdown')
    this.#patchEmergencyLevel('full_lockdown', true)
  }

  emergencyLiftFullLockdown(): void {
    this.#dispatchEmergency('emergency.liftFullLockdown')
    this.#patchEmergencyLevel('full_lockdown', false)
  }

  emergencyCallRiotSquad(): void {
    this.#dispatchEmergency('emergency.callRiotSquad')
    this.#patchEmergencyLevel('riot_squad', true)
  }

  emergencyDismissRiotSquad(): void {
    this.#dispatchEmergency('emergency.dismissRiotSquad')
    this.#patchEmergencyLevel('riot_squad', false)
  }

  emergencyAuthoriseFreeFire(): void {
    this.#dispatchEmergency('emergency.authoriseFreeFire')
    this.#patchEmergencyLevel('free_fire', true)
  }

  emergencyRevokeFreeFire(): void {
    this.#dispatchEmergency('emergency.revokeFreeFire')
    this.#patchEmergencyLevel('free_fire', false)
  }

  emergencyCallNationalGuard(): void {
    this.#dispatchEmergency('emergency.callNationalGuard')
    this.#patchEmergencyLevel('national_guard', true)
  }

  #patchEmergencyLevel(id: EmergencyModel['levels'][number]['id'], active: boolean): void {
    const current = this.state.emergency.value
    if (current === null) return
    this.state.emergency.value = {
      ...current,
      levels: current.levels.map((level) => (level.id === id ? { ...level, active } : level)),
    }
  }

  selectPaletteItem(itemId: string): void {
    this.state.paletteSelection.value = this.state.paletteSelection.value === itemId ? null : itemId
    if (this.state.tool.value === 'overlay') this.#syncOverlayMode()
    if (this.state.tool.value === 'reports') {
      this.#openReportsSelection(this.state.paletteSelection.value)
    }
    this.#syncInput()
  }

  #openReportsSelection(itemId: string | null): void {
    this.closeDirectorate()
    this.closePrograms()
    this.closeIntelligence()
    this.closeReports()
    this.closeRoutine()
    this.closeContracts()
    this.closeIntake()
    if (itemId === 'directorate') this.openDirectorate()
    else if (itemId === 'programmes') this.openPrograms()
    else if (itemId === 'routine') this.openRoutine()
    else if (itemId === 'contracts') this.openContracts()
    else if (itemId === 'intake') this.openIntake()
    else if (isReportsTab(itemId)) this.openReports(itemId)
  }

  openDirectorate(): void {
    const control = this.bridge.latestControl()
    const base = control?.directorate
    this.state.directorate.value =
      base === undefined
        ? {
            nodes: [],
            completeCount: 0,
            totalCount: 0,
            activeCount: 0,
            balance: this.state.topBar.value.balance,
            selectedId: null,
          }
        : { ...base, selectedId: null }
    this.state.directorateBranch.value = 'all'
  }

  closeDirectorate(): void {
    this.state.directorate.value = null
  }

  setDirectorateBranch(branch: DirectorateBranchId | 'all'): void {
    this.state.directorateBranch.value = branch
  }

  selectDirectorateNode(nodeId: string | null): void {
    const current = this.state.directorate.value
    if (current === null) return
    this.state.directorate.value = { ...current, selectedId: nodeId }
  }

  startDirectorateResearch(nodeId: string): void {
    this.bridge.sendCommand({
      type: 'directorate.start',
      issuedAtTick: this.#tick(),
      payload: { nodeId },
    })
  }

  openPrograms(): void {
    const control = this.bridge.latestControl()
    const base = control?.programs
    this.state.programs.value =
      base === undefined
        ? { rows: [], selectedId: null, canPin: false }
        : { ...base, selectedId: null }
  }

  closePrograms(): void {
    this.state.programs.value = null
  }

  selectProgram(programId: string | null): void {
    const current = this.state.programs.value
    if (current === null) return
    this.state.programs.value = { ...current, selectedId: programId }
  }

  pinProgram(programId: string): void {
    this.bridge.sendCommand({
      type: 'program.pin',
      issuedAtTick: this.#tick(),
      payload: { programId },
    })
  }

  unpinProgram(programId: string): void {
    this.bridge.sendCommand({
      type: 'program.unpin',
      issuedAtTick: this.#tick(),
      payload: { programId },
    })
  }

  /** Enrolls an inmate in a program session. */
  enrolProgram(programId: string, inmateId: number): void {
    this.bridge.sendCommand({
      type: 'program.enrol',
      issuedAtTick: this.#tick(),
      payload: { programId, inmateId },
    })
  }

  /** Withdraws an inmate from a program. */
  withdrawProgram(programId: string, inmateId: number): void {
    this.bridge.sendCommand({
      type: 'program.withdraw',
      issuedAtTick: this.#tick(),
      payload: { programId, inmateId },
    })
  }

  enrolSelectedProgram(): void {
    const programId = this.state.programs.value?.selectedId
    const inspector = this.state.inspector.value
    if (programId === null || programId === undefined) return
    if (inspector === null || inspector.kind !== 'inmate') {
      this.state.hint.value = 'Inspect an inmate, then enrol them in this programme'
      return
    }
    this.enrolProgram(programId, inspector.entityId)
  }

  withdrawSelectedProgram(): void {
    const programId = this.state.programs.value?.selectedId
    const inspector = this.state.inspector.value
    if (programId === null || programId === undefined) return
    if (inspector === null || inspector.kind !== 'inmate') {
      this.state.hint.value = 'Inspect an inmate, then withdraw them from this programme'
      return
    }
    this.withdrawProgram(programId, inspector.entityId)
  }

  inspectorFire(): void {
    const model = this.state.inspector.value
    if (model === null || model.kind !== 'staff') return
    this.fireStaff(model.entityId)
  }

  inspectorAssignLabour(): void {
    const model = this.state.inspector.value
    if (model === null || model.kind !== 'inmate') return
    this.assignLabour('kitchen', model.entityId)
  }

  inspectorUnassignLabour(): void {
    const model = this.state.inspector.value
    if (model === null || model.kind !== 'inmate') return
    this.unassignLabour(model.entityId)
  }

  openIntelligence(): void {
    const control = this.bridge.latestControl()
    this.state.intelligence.value = control?.intelligence ?? {
      sources: [],
      market: [],
      informants: [],
      reputations: [],
      maxInformants: 0,
      recruitCandidate: null,
    }
    this.state.intelligenceTab.value = 'sources'
  }

  closeIntelligence(): void {
    this.state.intelligence.value = null
  }

  setIntelligenceTab(tab: IntelligenceTab): void {
    this.state.intelligenceTab.value = tab
  }

  openReports(tab: ReportsTab = 'needs'): void {
    this.#reportsOpen = true
    this.state.reportsTab.value = tab
    this.#refreshReports(true)
  }

  closeReports(): void {
    this.#reportsOpen = false
    this.#reportsGeneration += 1
    this.#reportsRefreshBucket = -1
    this.state.reports.value = null
  }

  setReportsTab(tab: ReportsTab): void {
    this.state.reportsTab.value = tab
    this.#refreshReports(false)
  }

  /**
   * Leaves Reports and turns its selected need into the T6.1 world heatmap.
   * This is a view transition only; the worker remains the data authority.
   */
  showNeedHeatmap(needId: string): void {
    this.closeDirectorate()
    this.closePrograms()
    this.closeIntelligence()
    this.closeReports()
    const palette = this.#palettes.overlay
    this.state.tool.value = 'overlay'
    this.state.palette.value = palette.groups
    this.state.paletteSelection.value = `needs:${needId}`
    this.#syncOverlayMode()
    this.#syncInput()
  }

  /** Opens a warn-or-above event from the searchable Log in Trace. */
  openReportTrace(traceId: number): void {
    void this.bridge
      .trace(traceId)
      .then((result) => {
        if (result !== null) this.#showTrace(result)
      })
      .catch(() => {
        // A disposed bridge rejects in flight; the session is going away.
      })
  }

  /**
   * Reports are deliberately not part of the up-to-80Hz control message.
   * While the panel is open, request at most one snapshot per in-game minute.
   */
  #refreshReports(force: boolean): void {
    if (!this.#reportsOpen) return
    const bucket = Math.floor(this.#tick() / 10)
    if (!force && bucket === this.#reportsRefreshBucket) return
    this.#reportsRefreshBucket = bucket
    const generation = this.#reportsGeneration

    void this.bridge
      .reports()
      .then((reports) => {
        if (generation !== this.#reportsGeneration) return
        this.state.reports.value = reports
      })
      .catch(() => {
        // See openReportTrace: disposal is not a report failure.
      })
  }

  recruitInformant(inmateId: number): void {
    this.bridge.sendCommand({
      type: 'intelligence.recruit',
      issuedAtTick: this.#tick(),
      payload: { inmateId },
    })
  }

  focusInformant(inmateId: number): void {
    const snapshot = this.bridge.latestSnapshot()
    const entity = snapshot?.entities.find((entry) => entry.id === inmateId)
    if (entity === undefined) return
    this.focusTile({ x: Math.floor(entity.x), y: Math.floor(entity.y) })
  }

  /* ---------------------------------------------------------------------- */
  /* Routine panel (T8.9)                                                    */
  /* ---------------------------------------------------------------------- */

  openRoutine(): void {
    this.state.routine.value = this.bridge.latestControl()?.routine ?? this.#defaultRoutineModel()
  }

  closeRoutine(): void {
    this.state.routine.value = null
  }

  setRoutineCategory(categoryId: string, blocks: readonly RoutineBlockId[]): void {
    this.bridge.sendCommand({
      type: 'routine.setCategory',
      issuedAtTick: this.#tick(),
      payload: { categoryId, blocks },
    })
  }

  #defaultRoutineModel(): RoutineModel {
    return {
      categories: this.data.securityCategories.all.map((cat) => ({
        id: cat.id,
        name: cat.name,
        blocks: Array(24).fill('free') as RoutineBlockId[],
      })),
      conflicts: [],
    }
  }

  /* ---------------------------------------------------------------------- */
  /* Contracts panel (T8.9)                                                  */
  /* ---------------------------------------------------------------------- */

  openContracts(): void {
    this.state.contracts.value =
      this.bridge.latestControl()?.contracts ?? this.#defaultContractsModel()
  }

  closeContracts(): void {
    this.state.contracts.value = null
  }

  acceptContract(contractId: string): void {
    this.bridge.sendCommand({
      type: 'contracts.accept',
      issuedAtTick: this.#tick(),
      payload: { contractId },
    })
  }

  cancelContract(contractId: string): void {
    this.bridge.sendCommand({
      type: 'contracts.cancel',
      issuedAtTick: this.#tick(),
      payload: { contractId },
    })
  }

  takeLoan(amount: number): void {
    this.bridge.sendCommand({
      type: 'contracts.takeLoan',
      issuedAtTick: this.#tick(),
      payload: { amount },
    })
  }

  repayLoan(amount: number): void {
    this.bridge.sendCommand({
      type: 'contracts.repayLoan',
      issuedAtTick: this.#tick(),
      payload: { amount },
    })
  }

  #defaultContractsModel(): ContractsModel {
    return {
      active: [],
      available: [],
      maxActive: 3,
      loan: null,
    }
  }

  /* ---------------------------------------------------------------------- */
  /* Intake panel (T8.9)                                                     */
  /* ---------------------------------------------------------------------- */

  openIntake(): void {
    this.state.intake.value = this.bridge.latestControl()?.intake ?? this.#defaultIntakeModel()
  }

  closeIntake(): void {
    this.state.intake.value = null
  }

  setIntakeContinuous(continuous: boolean): void {
    this.bridge.sendCommand({
      type: 'intake.setContinuous',
      issuedAtTick: this.#tick(),
      payload: { continuous },
    })
  }

  setIntakeRequested(categoryId: string, count: number): void {
    this.bridge.sendCommand({
      type: 'intake.setRequested',
      issuedAtTick: this.#tick(),
      payload: { categoryId, count },
    })
  }

  clearIntakeRequested(): void {
    this.bridge.sendCommand({
      type: 'intake.clearRequested',
      issuedAtTick: this.#tick(),
      payload: {},
    })
  }

  #defaultIntakeModel(): IntakeModel {
    return {
      continuous: false,
      categories: this.data.securityCategories.all.map((cat) => ({
        id: cat.id,
        name: cat.name,
        requested: 0,
        locked: false,
        lockReason: null,
      })),
      capacityModel: {
        population: 0,
        capacity: 0,
        housing: { cells: 0, dormitories: 0, holdingPens: 0 },
      },
      nextBusLabel: 'No bus scheduled',
      nextBusTick: null,
    }
  }

  /* ---------------------------------------------------------------------- */
  /* Flow (logistics) panel (T8.9)                                           */
  /* ---------------------------------------------------------------------- */

  openFlow(): void {
    this.state.flow.value = this.bridge.latestControl()?.flow ?? this.#defaultFlowModel()
    this.state.flowChain.value = 'meals'
  }

  closeFlow(): void {
    this.state.flow.value = null
    this.state.flowChain.value = null
  }

  setFlowChain(chainId: FlowChainId): void {
    this.state.flowChain.value = chainId
  }

  #defaultFlowModel(): FlowModel {
    return {
      chains: [
        {
          id: 'meals',
          name: 'Meals',
          stages: [
            { id: 'delivery', name: 'Delivery', throughput: 0, capacity: 0, bottleneck: false, detail: '' },
            { id: 'storage', name: 'Storage', throughput: 0, capacity: 0, bottleneck: false, detail: '' },
            { id: 'kitchen', name: 'Kitchen', throughput: 0, capacity: 0, bottleneck: false, detail: '' },
            { id: 'serving', name: 'Serving', throughput: 0, capacity: 0, bottleneck: false, detail: '' },
          ],
          healthy: true,
          summary: 'No meal chain activity',
        },
        {
          id: 'laundry',
          name: 'Laundry',
          stages: [
            { id: 'collection', name: 'Collection', throughput: 0, capacity: 0, bottleneck: false, detail: '' },
            { id: 'washing', name: 'Washing', throughput: 0, capacity: 0, bottleneck: false, detail: '' },
            { id: 'distribution', name: 'Distribution', throughput: 0, capacity: 0, bottleneck: false, detail: '' },
          ],
          healthy: true,
          summary: 'No laundry chain activity',
        },
        {
          id: 'cleaning',
          name: 'Cleaning',
          stages: [
            { id: 'supply', name: 'Supply', throughput: 0, capacity: 0, bottleneck: false, detail: '' },
            { id: 'work', name: 'Work', throughput: 0, capacity: 0, bottleneck: false, detail: '' },
          ],
          healthy: true,
          summary: 'No cleaning chain activity',
        },
        {
          id: 'supply',
          name: 'Construction Supply',
          stages: [
            { id: 'delivery', name: 'Delivery', throughput: 0, capacity: 0, bottleneck: false, detail: '' },
            { id: 'storage', name: 'Storage', throughput: 0, capacity: 0, bottleneck: false, detail: '' },
            { id: 'work', name: 'Work', throughput: 0, capacity: 0, bottleneck: false, detail: '' },
          ],
          healthy: true,
          summary: 'No construction supply activity',
        },
        {
          id: 'exports',
          name: 'Exports',
          stages: [
            { id: 'production', name: 'Production', throughput: 0, capacity: 0, bottleneck: false, detail: '' },
            { id: 'storage', name: 'Storage', throughput: 0, capacity: 0, bottleneck: false, detail: '' },
            { id: 'pickup', name: 'Pickup', throughput: 0, capacity: 0, bottleneck: false, detail: '' },
          ],
          healthy: true,
          summary: 'No export activity',
        },
      ],
    }
  }

  /* ---------------------------------------------------------------------- */
  /* Settings panel (T8.7)                                                   */
  /* ---------------------------------------------------------------------- */

  openSettings(): void {
    this.state.settings.value = this.#defaultSettingsModel()
    this.state.settingsTab.value = 'audio'
  }

  closeSettings(): void {
    this.state.settings.value = null
  }

  setSettingsTab(tab: SettingsTab): void {
    this.state.settingsTab.value = tab
  }

  setSettingsVolume(channel: 'music' | 'sfx', value: number): void {
    const current = this.state.settings.value
    if (current === null) return
    this.state.settings.value = {
      ...current,
      [channel]: value,
    }
    this.#notifySettingsChange()
  }

  setSettingsMute(muted: boolean): void {
    const current = this.state.settings.value
    if (current === null) return
    this.state.settings.value = { ...current, muted }
    this.#notifySettingsChange()
  }

  setSettingsPalette(palette: ColourBlindPalette): void {
    const current = this.state.settings.value
    if (current === null) return
    this.state.settings.value = { ...current, palette }
    this.setOverlayPalette(palette === 'default' ? 'standard' : palette)
    this.#notifySettingsChange()
  }

  setSettingsReduceMotion(enabled: boolean): void {
    const current = this.state.settings.value
    if (current === null) return
    this.state.settings.value = { ...current, reduceMotion: enabled }
    this.#notifySettingsChange()
  }

  setSettingsTypeScale(scale: number): void {
    const current = this.state.settings.value
    if (current === null) return
    this.state.settings.value = { ...current, typeScale: scale }
    this.#notifySettingsChange()
  }

  setSettingsPreferNoFailure(enabled: boolean): void {
    const current = this.state.settings.value
    if (current === null) return
    this.state.settings.value = { ...current, preferNoFailure: enabled }
    this.#notifySettingsChange()
  }

  setSettingsAutosaveHours(hours: number): void {
    const current = this.state.settings.value
    if (current === null) return
    this.state.settings.value = { ...current, autosaveHours: hours }
    this.#autosaveHours = hours as AutosaveHours
    this.#notifySettingsChange()
  }

  /** Called after any settings change to persist and apply. */
  #notifySettingsChange(): void {
    const settings = this.#buildCurrentSettings()

    // Apply audio immediately.
    if (this.#audioEngine !== null) {
      this.#audioEngine.applySettings(settings.audio)
    }

    // Notify the composition root to persist and apply CSS.
    if (this.onSettingsChange !== null) {
      this.onSettingsChange(settings)
    }
  }

  #defaultSettingsModel(): SettingsModel {
    return settingsModelFromAppSettings(this.#appSettings)
  }

  /* ---------------------------------------------------------------------- */
  /* New prison screen (T8.7)                                                */
  /* ---------------------------------------------------------------------- */

  openNewPrison(): void {
    this.state.newPrison.value = this.#defaultNewPrisonModel()
  }

  closeNewPrison(): void {
    this.state.newPrison.value = null
  }

  setNewPrisonSize(preset: MapSizePreset): void {
    const current = this.state.newPrison.value
    if (current === null) return
    this.state.newPrison.value = { ...current, sizePreset: preset }
  }

  setNewPrisonStartingFunds(amount: number): void {
    const current = this.state.newPrison.value
    if (current === null) return
    this.state.newPrison.value = { ...current, startingFunds: amount }
  }

  setNewPrisonContinuousIntake(enabled: boolean): void {
    const current = this.state.newPrison.value
    if (current === null) return
    this.state.newPrison.value = { ...current, continuousIntake: enabled }
  }

  setNewPrisonRandomEvents(enabled: boolean): void {
    const current = this.state.newPrison.value
    if (current === null) return
    this.state.newPrison.value = { ...current, randomEvents: enabled }
  }

  setNewPrisonFirstOrderGrace(enabled: boolean): void {
    const current = this.state.newPrison.value
    if (current === null) return
    this.state.newPrison.value = { ...current, firstOrderGrace: enabled }
  }

  setNewPrisonSeed(input: string): void {
    const current = this.state.newPrison.value
    if (current === null) return
    this.state.newPrison.value = { ...current, seedInput: input }
  }

  setNewPrisonFailure(id: string, enabled: boolean): void {
    const current = this.state.newPrison.value
    if (current === null) return
    this.state.newPrison.value = {
      ...current,
      failures: current.failures.map((entry) =>
        entry.id === id ? { ...entry, enabled } : entry,
      ),
    }
  }

  setNewPrisonMutator(id: string, enabled: boolean): void {
    const current = this.state.newPrison.value
    if (current === null) return
    this.state.newPrison.value = {
      ...current,
      mutators: current.mutators.map((entry) =>
        entry.id === id ? { ...entry, enabled } : entry,
      ),
    }
  }

  #defaultNewPrisonModel(): NewPrisonModel {
    const balance = this.data.balance
    const preferNoFailure = this.state.settings.value?.preferNoFailure ?? false
    return {
      sizePreset: 'large',
      sizes: [
        { id: 'small', label: 'Small', tiles: 100 },
        { id: 'medium', label: 'Medium', tiles: 160 },
        { id: 'large', label: 'Large', tiles: 220 },
        { id: 'huge', label: 'Huge', tiles: 300 },
      ],
      startingFunds: balance.economy.startingFunds,
      continuousIntake: true,
      randomEvents: true,
      firstOrderGrace: true,
      seedInput: '',
      failures: [
        {
          id: 'escapes',
          label: 'Escapes',
          description: 'Too many inmates escape and you are dismissed.',
          enabled: !preferNoFailure,
        },
        {
          id: 'insolvency',
          label: 'Insolvency',
          description: 'Your balance stays negative too long.',
          enabled: !preferNoFailure,
        },
        {
          id: 'deaths',
          label: 'Deaths',
          description: 'A death under your watch ends the prison.',
          enabled: !preferNoFailure,
        },
      ],
      mutators: [
        {
          id: 'fires',
          label: 'Fires',
          description: 'Equipment can catch fire and spread.',
          enabled: true,
        },
        {
          id: 'contraband',
          label: 'Contraband',
          description: 'Inmates will try to smuggle items.',
          enabled: true,
        },
      ],
    }
  }

  /* ---------------------------------------------------------------------- */
  /* Onboarding guide (T8.7)                                                 */
  /* ---------------------------------------------------------------------- */

  openOnboarding(): void {
    this.#beginOnboarding()
  }

  closeOnboarding(): void {
    this.state.onboarding.value = null
  }

  skipOnboarding(): void {
    this.#onboarding?.skip(performance.now())
    this.#onboarding = null
    this.#onboardingStarted = false
    this.state.onboarding.value = null
  }

  dismissOnboardingMark(_objectiveIndex: number): void {
    this.#onboarding?.dismissCurrent()
    this.#publishOnboarding()
  }

  setOnboardingMode(mode: OnboardingMode): void {
    if (mode === 'off') {
      this.skipOnboarding()
      return
    }
    if (this.#onboarding === null) {
      this.#onboarding = new Onboarding(mode, performance.now())
      this.#onboardingStarted = true
    } else {
      this.#onboarding.setMode(mode, performance.now())
    }
    this.#publishOnboarding()
  }

  /* ---------------------------------------------------------------------- */
  /* Alerts panel (T8.7)                                                     */
  /* ---------------------------------------------------------------------- */

  openAlerts(): void {
    this.state.alerts.value = this.#buildAlertsModel()
    this.state.alertsFilter.value = null
  }

  closeAlerts(): void {
    this.state.alerts.value = null
  }

  setAlertsFilter(severity: AlertSeverity | null): void {
    this.state.alertsFilter.value = severity
    const current = this.state.alerts.value
    if (current === null) return
    this.state.alerts.value = { ...current, filter: severity }
  }

  setAlertsMute(category: string, muted: boolean): void {
    const current = this.state.alerts.value
    if (current === null) return
    this.state.alerts.value = {
      ...current,
      categories: current.categories.map((entry) =>
        entry.id === category ? { ...entry, muted } : entry,
      ),
    }

    // Wire per-category mute to the worker (T8.8 PRD 6.5).
    const mutedCategories = this.state.alerts.value.categories
      .filter((entry) => entry.muted)
      .map((entry) => entry.id)
    this.bridge.setNotificationSettings({ mutedCategories })
  }

  setAlertsAutoPause(enabled: boolean): void {
    const current = this.state.alerts.value
    if (current === null) return
    this.state.alerts.value = { ...current, autoPauseOnCritical: enabled }

    // Wire auto-pause to the worker (T8.8 PRD 6.5).
    this.bridge.setNotificationSettings({ autoPauseOnCritical: enabled })
  }

  openAlertTrace(row: AlertRowModel): void {
    if (row.traceId > 0) {
      void this.bridge
        .trace(row.traceId, row.id)
        .then((result) => {
          if (result !== null) {
            this.#traces.set(row.id, result)
            this.closeAlerts()
            this.#showTrace(result)
          }
        })
        .catch(() => {
          // Disposed bridge
        })
    }
  }

  #buildAlertsModel(): AlertsModel {
    const toasts = this.state.toasts.value
    const rows: AlertRowModel[] = toasts.map((toast, index) => ({
      id: toast.id,
      severity: toast.severity,
      category: 'general',
      categoryLabel: 'General',
      title: toast.title,
      detail: toast.detail,
      count: toast.count,
      traceId: toast.traceId,
      timeLabel: index === 0 ? 'Just now' : `${String(index + 1)}m ago`,
    }))
    return {
      rows,
      categories: [
        { id: 'general', label: 'General', muted: false, total: rows.length },
        { id: 'infrastructure', label: 'Infrastructure', muted: false, total: 0 },
        { id: 'security', label: 'Security', muted: false, total: 0 },
        { id: 'welfare', label: 'Welfare', muted: false, total: 0 },
      ],
      autoPauseOnCritical: false,
      filter: this.state.alertsFilter.value,
    }
  }

  /**
   * Hands single-pointer *drags* to the build tool, or back to the camera.
   *
   * Two switches, not one, and conflating them is a bug worth naming. Tool
   * input stays **always on**, because a tap with no tool selected is how PRD
   * 2.3 opens the inspector — turning the controller off with the tool would
   * take selection away with it, and the world would become a thing you can
   * only pan. What the tool selection actually decides is whether a one-finger
   * *drag* paints or pans, which is `singlePointerPan`.
   *
   * Pinch and two-finger pan stay with the camera either way: a player drawing
   * a wing still has to be able to see where it is going.
   */
  #syncInput(): void {
    const entry = this.activeEntry()
    const tool = this.state.tool.value
    const overlaying = tool === 'overlay'
    const panelTool = tool === 'reports' || tool === 'staff'
    // Reports / Staff chips are not build strokes — keep one-finger pan.
    const building = entry !== undefined && !overlaying && !panelTool
    const postsGesture =
      this.state.posts.value !== null &&
      (this.#paintSectorId !== null || this.#patrolWaypoints !== null)

    this.renderer.tools.active = true
    this.renderer.gestures.singlePointerPan = !building
    if (overlaying) {
      const selection = this.state.paletteSelection.value
      this.state.hint.value =
        selection === null ? 'Choose an overlay' : `Showing ${selection} overlay`
    } else if (tool === 'reports') {
      const selection = this.state.paletteSelection.value
      this.state.hint.value =
        selection === null
          ? 'Choose a report'
          : selection === 'directorate'
            ? 'Directorate — research and unlocks'
            : selection === 'programmes'
              ? 'Programmes — reform sessions and blockers'
              : selection === 'intelligence'
                ? 'Intelligence — informants and contraband'
                : null
    } else if (tool === 'staff') {
      const selection = this.state.paletteSelection.value
      this.state.hint.value =
        selection === null
          ? 'Choose a staff role, then tap a tile to hire'
          : `Tap a tile to hire ${entry?.name ?? 'staff'}`
    } else if (building) {
      this.state.hint.value = gestureHint(entry)
    } else if (this.#patrolWaypoints !== null) {
      const n = this.#patrolWaypoints.length
      this.state.hint.value =
        n < 2
          ? `Patrol: tap waypoints (${String(n)} so far). Tap again to add; Escape cancels.`
          : `Patrol: ${String(n)} waypoints. Confirm in Posts or Escape to cancel.`
    } else if (this.#paintSectorId !== null) {
      this.state.hint.value = 'Tap a region to paint it into the active sector'
    } else if (postsGesture) {
      this.state.hint.value = null
    } else {
      this.state.hint.value = null
    }
  }

  /** Picks the world overlay from paint mode or the Overlay tool palette. */
  #syncOverlayMode(): void {
    if (this.#paintSectorId !== null) {
      this.#overlayRequestKey = ''
      this.#overlayGeneration += 1
      this.renderer.setOverlayMode('sectors')
      this.#publishOverlayLegend('sectors')
      return
    }
    if (this.state.tool.value !== 'overlay') {
      this.renderer.setOverlayMode('off')
      this.state.overlayLegend.value = null
      this.#overlayRequestKey = ''
      this.#overlayLegendKey = ''
      return
    }
    const selection = this.state.paletteSelection.value
    const parsed = parseOverlaySelection(selection)
    const mode: OverlayMode = parsed?.mode ?? 'off'
    this.renderer.setOverlayMode(mode)
    if (parsed === null) {
      this.state.overlayLegend.value = null
      this.#overlayRequestKey = ''
      this.#overlayLegendKey = ''
      return
    }
    this.#publishOverlayLegend(parsed.mode, parsed.needId)
    this.#requestOverlayData(parsed.mode, parsed.needId, false)
  }

  /** T6.5 will call this from Settings; T6.1 owns the complete palette support. */
  setOverlayPalette(paletteId: OverlayPaletteId): void {
    this.#overlayPaletteId = paletteId
    this.renderer.setOverlayPalette(paletteId)
    this.#overlayLegendKey = ''
    const parsed = parseOverlaySelection(this.state.paletteSelection.value)
    if (parsed !== null) this.#publishOverlayLegend(parsed.mode, parsed.needId)
  }

  #publishOverlayLegend(mode: PrdOverlayMode, needId?: string): void {
    const definition = OVERLAY_MODE_DEFINITIONS[mode]
    const palette = OVERLAY_PALETTES[this.#overlayPaletteId]
    const control = this.bridge.latestControl()
    const sectorKey =
      mode === 'sectors' && control !== null
        ? control.posts.sectors.map((sector) => `${String(sector.id)}:${sector.name}`).join('|')
        : ''
    const legendKey = `${mode}:${needId ?? ''}:${this.#overlayPaletteId}:${sectorKey}`
    if (legendKey === this.#overlayLegendKey) return
    this.#overlayLegendKey = legendKey
    const sectorEntries =
      mode === 'sectors' && control !== null
        ? control.posts.sectors.slice(0, 32).map((sector, index) => ({
            label: sector.name,
            colour: colourToCss(
              palette.categorical[index % palette.categorical.length] ?? palette.categorical[0],
            ),
            pattern: overlayCategoricalPattern(index),
          }))
        : []
    const entries =
      sectorEntries.length > 0
        ? sectorEntries
        : overlayLegendBands(mode, this.#overlayPaletteId).map((band) => ({
            label: band.label,
            colour: colourToCss(band.colour),
            pattern: band.pattern,
          }))
    const needName = needId === undefined ? undefined : this.data.needs.find(needId)?.name
    this.state.overlayLegend.value = {
      title:
        mode === 'needs' && needName !== undefined
          ? `${definition.label} · ${needName}`
          : definition.label,
      paletteLabel: palette.label,
      entries,
    }
  }

  #requestOverlayData(mode: PrdOverlayMode, needId: string | undefined, force: boolean): void {
    const key = `${mode}:${needId ?? ''}`
    const bucket = Math.floor(this.#tick() / 10)
    if (!force && this.#overlayRequestKey === key && this.#overlayRefreshBucket === bucket) return
    this.#overlayRequestKey = key
    this.#overlayRefreshBucket = bucket
    const generation = this.#overlayGeneration + 1
    this.#overlayGeneration = generation
    void this.bridge.overlay(mode, needId).then((values) => {
      if (generation !== this.#overlayGeneration) return
      if (this.#overlayRequestKey !== key) return
      this.renderer.setOverlayData(values)
    })
  }

  /* ---------------------------------------------------------------------- */
  /* Building                                                                */
  /* ---------------------------------------------------------------------- */

  #clearPreview(): void {
    this.#renderBlueprint()
  }

  /** Draws the staged blueprint plus whatever is under the finger right now. */
  #renderBlueprint(preview?: { x: number; y: number; width: number; height: number }): void {
    const rects = this.staged.strokes().flatMap((stroke) => actionRects(stroke.action))
    if (preview !== undefined) rects.push({ ...preview, valid: true })
    this.renderer.blueprint.setItems(rects)

    // The single place every staging change passes through, so the Commit
    // button cannot fall out of step with what is actually staged.
    this.state.stagedCount.value = this.staged.size
  }

  #onStrokePreview(stroke: ToolStroke): void {
    if (this.state.tool.value === 'overlay') return
    if (this.state.tool.value === 'reports' || this.state.tool.value === 'staff') return
    const entry = this.activeEntry()
    if (entry === undefined) return

    const shape =
      entry.gesture === 'line'
        ? lineRect(stroke.line)
        : {
            x: stroke.rect.x,
            y: stroke.rect.y,
            width: stroke.rect.width,
            height: stroke.rect.height,
          }

    this.#renderBlueprint(shape)
  }

  #onTap(tile: Tile): void {
    if (this.#patrolWaypoints !== null) {
      const index = tile.y * this.mapSize + tile.x
      this.#patrolWaypoints.push(index)
      this.#syncInput()
      return
    }

    if (this.#paintSectorId !== null && this.state.posts.value !== null) {
      const tileIndex = tile.y * this.mapSize + tile.x
      this.bridge.sendCommand({
        type: 'sector.paintRegion',
        issuedAtTick: this.#tick(),
        payload: { sectorId: this.#paintSectorId, tileIndex },
      })
      return
    }

    // Overlay chips only switch the layer mode; they never stage builds.
    if (this.state.tool.value === 'overlay') return
    // Reports chips open panels; strokes are never staged.
    if (this.state.tool.value === 'reports') return

    if (this.state.tool.value === 'staff') {
      const defId = this.state.paletteSelection.value
      if (defId === null) return
      this.bridge.sendCommand({
        type: 'staff.hire',
        issuedAtTick: this.#tick(),
        payload: { defId, tx: tile.x, ty: tile.y },
      })
      return
    }

    const entry = this.activeEntry()
    if (entry === undefined) {
      // Entities first (snapshot), then the tile — T2.9. The worker re-resolves
      // agents on that tile, so picking the entity only chooses *which* tile to
      // ask about when feet and tap disagree by a sub-tile.
      const snapshot = this.bridge.latestSnapshot()
      const pick = resolveWorldTap(snapshot?.entities ?? [], tile.x, tile.y)
      if (pick.kind === 'entity') {
        const entity = snapshot?.entities.find((agent) => agent.id === pick.entityId)
        if (entity !== undefined) {
          this.#selectedSnapshotId = entity.id
          void this.inspect({
            x: Math.floor(entity.x / 32),
            y: Math.floor(entity.y / 32),
          })
          return
        }
      }
      this.#selectedSnapshotId = null
      void this.inspect(tile)
      return
    }
    this.stage(
      entry.action({
        rect: { ...tile, width: 1, height: 1 },
        line: { x1: tile.x, y1: tile.y, x2: tile.x, y2: tile.y },
        tile,
      }),
    )
  }

  #onStrokeEnd(stroke: ToolStroke): void {
    if (this.state.tool.value === 'overlay') return
    if (this.state.tool.value === 'reports') return
    if (this.state.tool.value === 'staff') {
      // Hire is tap-only; a drag should not spam multiple hires.
      return
    }
    const entry = this.activeEntry()
    if (entry === undefined) return

    this.stage(
      entry.action({
        rect: stroke.rect,
        line: stroke.line,
        tile: stroke.start,
      }),
    )
  }

  /** Adds one action to the blueprint and asks the worker what it costs. */
  stage(action: BuildAction): void {
    this.staged.add(action)
    this.#renderBlueprint()
    void this.#revalidate()
    if (action.kind === 'placeObject') {
      void this.#stageAutoRoutes(action)
    }
  }

  /**
   * Captures the live world into IndexedDB's rotating autosave slots
   * (PRD 7.4). Reports quota errors visibly (T8.15) but swallows transient
   * failures so a save glitch never blocks pause.
   *
   * @param store Optional store instance for testing
   * @param reportErrors If true, shows errors to the user via runtime error
   */
  async autosave(store?: SaveStore, reportErrors = false): Promise<boolean> {
    try {
      const createdAt = new Date().toISOString()
      const { bytes, playedTicks } = await this.bridge.exportSave(createdAt)
      const target = store ?? (await SaveStore.open())
      await target.putAutosave(bytes, {
        savedAt: createdAt,
        playedTicks,
        mapSize: this.mapSize,
      })
      if (store === undefined) target.close()
      return true
    } catch (error) {
      console.error('Blockwork autosave failed', error)

      // Surface quota errors to the user (T8.15).
      if (this.#isQuotaError(error) || reportErrors) {
        const message =
          error instanceof Error
            ? error.message
            : 'Save failed — your browser may be out of storage space'
        this.reportRuntimeError(`Save failed: ${message}`)
      }

      return false
    }
  }

  /**
   * Checks if an error is a quota exceeded error (T8.15).
   *
   * IndexedDB throws QuotaExceededError or a DOMException with name
   * 'QuotaExceededError' when storage is full.
   */
  #isQuotaError(error: unknown): boolean {
    if (error instanceof DOMException && error.name === 'QuotaExceededError') {
      return true
    }
    if (error instanceof Error && error.message.includes('quota')) {
      return true
    }
    return false
  }

  /**
   * Loads a `.blockwork` save, replacing the current simulation state (T8.6).
   *
   * Returns true on success. On failure, the current session remains intact
   * and the error is reported to the user (T8.15).
   */
  async load(bytes: Uint8Array): Promise<boolean> {
    try {
      const result = await this.bridge.load(bytes)

      // Reset UI state that depends on the world
      this.staged.clear()
      this.#renderBlueprint()
      this.#abandonValidation()
      this.state.inspector.value = null
      this.state.toasts.value = []
      this.#traces.clear()
      this.#requestedTraces.clear()
      this.#focusTile = null
      this.#selectedSnapshotId = null
      this.#selectedSectorId = null
      this.#paintSectorId = null
      this.#patrolWaypoints = null
      this.#openTrace = null
      this.state.trace.value = null
      this.state.canUndo.value = false
      this.state.canRedo.value = false
      this.#redoDepth = 0

      // Re-centre camera on the loaded map
      const centre = centreTile(result.mapSize) * 32
      this.renderer.camera.moveTo(centre, centre)

      return true
    } catch (error) {
      console.error('Blockwork load failed', error)
      const message = error instanceof Error ? error.message : 'Unknown error'
      this.reportRuntimeError(`Load failed: ${message}`)
      return false
    }
  }

  /**
   * After placing a powered/plumbed object, propose cable/pipe runs to the
   * nearest live grid as dashed blueprint strokes (PRD 3.4).
   */
  async #stageAutoRoutes(
    action: Extract<BuildAction, { readonly kind: 'placeObject' }>,
  ): Promise<void> {
    const def = this.data.objects.find(action.objectDefId)
    if (def === undefined) return

    const kinds: UtilityRouteKind[] = []
    if (def.needsPower > 0) kinds.push('power')
    if (def.needsWater) kinds.push('water')
    if (kinds.length === 0) return

    const generation = this.#autoRouteGeneration
    for (const kind of kinds) {
      const route = await this.bridge.autoRoute(action.tile, kind)
      if (generation !== this.#autoRouteGeneration) return
      if (route === null || route.costTiles === 0) continue
      const lines = utilityPathToLines(route.path, this.mapSize)
      const strokeKind = kind === 'power' ? 'paintCable' : 'paintPipe'
      for (const line of lines) {
        this.staged.add({ kind: strokeKind, line })
      }
    }
    if (generation !== this.#autoRouteGeneration) return
    this.#renderBlueprint()
    void this.#revalidate()
  }

  /** Takes back the last stroke. Local and instant: nothing has been sent. */
  undoStroke(): boolean {
    if (this.staged.empty) return false
    this.staged.undoStroke()
    this.#renderBlueprint()
    void this.#revalidate()
    return true
  }

  discard(): void {
    this.#autoRouteGeneration += 1
    this.staged.clear()
    this.#renderBlueprint()
    this.#abandonValidation()
  }

  /**
   * Drops any validation still in flight and hides the bar.
   *
   * Without this, emptying the blueprint races the worker: the reply to the
   * last stroke arrives a few milliseconds after Commit, finds its id still
   * current, and puts the bar back showing the price of a build that has
   * already been sent. Bumping the id is what makes "there is no blueprint" a
   * state rather than a moment.
   */
  #abandonValidation(): void {
    this.#validationId += 1
    this.state.blueprint.value = null
  }

  /**
   * Sends the whole blueprint as one command (PRD 3.2).
   *
   * The bar is held shut for a moment afterwards, not because the send is
   * slow — it is a `postMessage` — but because the world does not change until
   * the worker's next tick, and a Commit button that goes live again before
   * anything has visibly happened invites a second commit of a blueprint that
   * is already on its way.
   */
  commit(): void {
    if (this.staged.empty) return

    this.#autoRouteGeneration += 1
    this.state.committing.value = true
    this.bridge.sendCommand(this.staged.commitCommand(this.#tick()))
    this.staged.clear()
    this.#renderBlueprint()
    this.#abandonValidation()
    this.state.canUndo.value = true
    this.#redoDepth = 0
    this.state.canRedo.value = false

    globalThis.setTimeout(() => {
      this.state.committing.value = false
    }, 250)
  }

  /**
   * Undo, at whichever level has something to take back.
   *
   * A staged stroke first, because it is local and instant and is what the
   * player just did. Only once the blueprint is empty does this reach for the
   * committed builds, which cost a round trip and a refund (PRD 3.3).
   */
  undo(): void {
    if (this.undoStroke()) return
    this.bridge.sendCommand(undoCommand(this.#tick()))
    this.#redoDepth += 1
    this.state.canRedo.value = true
  }

  /** Re-applies the most recently undone commit (PRD 3.3). */
  redo(): void {
    this.bridge.sendCommand(redoCommand(this.#tick()))
    this.#redoDepth = Math.max(0, this.#redoDepth - 1)
    this.state.canRedo.value = this.#redoDepth > 0
    this.state.canUndo.value = true
  }

  async #revalidate(): Promise<void> {
    if (this.staged.empty) {
      this.#abandonValidation()
      return
    }

    this.#validationId += 1
    const id = this.#validationId

    const report = await this.bridge.validate(this.staged.actions().map(actionToJson))
    // A newer stroke has already gone out; this answer prices a blueprint the
    // player no longer has.
    if (id !== this.#validationId) return

    this.state.blueprint.value = report
  }

  /* ---------------------------------------------------------------------- */
  /* Selection                                                               */
  /* ---------------------------------------------------------------------- */

  async inspect(tile: Tile): Promise<void> {
    const result = await this.bridge.inspect(tile)
    this.#focusTile = result.centre
    this.state.inspector.value = toInspectorModel(result)
    this.#syncSelections()
  }

  closeInspector(): void {
    this.state.inspector.value = null
    this.#focusTile = null
    this.#selectedSnapshotId = null
    this.renderer.setSelections([])
  }

  /** Triggers an individual search on the inspected inmate. */
  inspectorSearch(): void {
    const model = this.state.inspector.value
    if (model === null || model.kind !== 'inmate') return
    this.bridge.sendCommand({
      type: 'search.individual',
      issuedAtTick: this.#tick(),
      payload: { inmateId: model.entityId },
    })
  }

  /** Demolishes the object or room currently shown in the inspector. */
  inspectorDemolish(): void {
    const model = this.state.inspector.value
    if (model === null) return
    if (model.kind === 'object') {
      this.bridge.sendCommand({
        type: 'objects.remove',
        issuedAtTick: this.#tick(),
        payload: { entityId: model.entityId },
      })
    } else if (model.kind === 'room') {
      this.bridge.sendCommand({
        type: 'rooms.undesignate',
        issuedAtTick: this.#tick(),
        payload: { roomId: model.roomId },
      })
    }
    this.closeInspector()
  }

  /** Reclassifies the inspected inmate to a new security category. */
  inspectorReclassify(categoryId: string): void {
    const model = this.state.inspector.value
    if (model === null || model.kind !== 'inmate') return
    this.bridge.sendCommand({
      type: 'inmate.reclassify',
      issuedAtTick: this.#tick(),
      payload: { inmateId: model.entityId, category: categoryId },
    })
    this.closeInspector()
  }

  /** Sends the inspected inmate to 24h manual isolation. */
  inspectorPunish(): void {
    const model = this.state.inspector.value
    if (model === null || model.kind !== 'inmate') return
    this.bridge.sendCommand({
      type: 'inmate.punish',
      issuedAtTick: this.#tick(),
      payload: { inmateId: model.entityId },
    })
    this.closeInspector()
  }

  /** Moves the inspected inmate into protective custody. */
  inspectorProtective(): void {
    const model = this.state.inspector.value
    if (model === null || model.kind !== 'inmate') return
    this.bridge.sendCommand({
      type: 'inmate.protectiveCustody',
      issuedAtTick: this.#tick(),
      payload: { inmateId: model.entityId },
    })
    this.closeInspector()
  }

  /** Opens an overlay showing the selected need for the inspected inmate. */
  inspectorNeedSelect(needId: string): void {
    this.closeInspector()
    this.showNeedHeatmap(needId)
  }

  /** Pans to whatever the inspector is showing. */
  focusInspected(): void {
    if (this.#focusTile !== null) this.focusTile(this.#focusTile)
  }

  focusTile(tile: Tile): void {
    this.renderer.camera.moveTo((tile.x + 0.5) * 32, (tile.y + 0.5) * 32)
  }

  /* ---------------------------------------------------------------------- */
  /* Clock                                                                   */
  /* ---------------------------------------------------------------------- */

  setSpeed(speed: SpeedStop): void {
    this.state.speed.value = speed
    this.bridge.setSpeed(speed)
  }

  #tick(): number {
    return this.bridge.latestSnapshot()?.tick ?? 0
  }

  /* ---------------------------------------------------------------------- */
  /* Frame                                                                   */
  /* ---------------------------------------------------------------------- */

  /**
   * One frame of main-thread work, inside PRD 7.5's 2ms snapshot budget.
   *
   * Registered on the renderer's own ticker rather than a separate rAF, so the
   * snapshot read, the chunk re-mesh and the draw happen in that order within
   * one frame instead of racing across two.
   */
  readonly #frame = (): void => {
    const snapshot = this.bridge.latestSnapshot()

    for (const chunkId of this.bridge.consumeDirtyChunks()) {
      const bounds = chunkBounds(chunkId, this.mapSize)
      this.renderer.markTilesDirty(bounds.x, bounds.y, bounds.width, bounds.height)
    }

    if (snapshot !== null) {
      this.#publishAgents(snapshot.entities)
      this.#publishObjects(snapshot.entities)
      this.#publishDigest(snapshot.tick, snapshot.digest)
      this.#updateAudio(snapshot.digest.danger)
    }
    this.#refreshOpenControlPanels()
    this.#updateOnboarding()
    this.#refreshReports(false)
    this.#feedOverlay()
    this.#publishToasts()
    this.#publishHud()
    this.#checkBridgeState()
  }

  /** Drive ambient layers based on current danger level. */
  #updateAudio(dangerLevel: number): void {
    if (this.#audioEngine === null) return
    this.#audioEngine.update(dangerLevel)
  }

  #playTraceSfx(result: TraceResult): void {
    if (!this.#audioUnlocked || this.#audioEngine === null) return
    const node = result.nodes[0]
    if (node === undefined) return
    const effect = effectForEventKind(node.kind)
    if (effect === null) return
    const camera = this.renderer.camera
    const listener = {
      tileX: camera.x / TILE_SIZE,
      tileY: camera.y / TILE_SIZE,
      halfWidthTiles: camera.viewportWidth / (2 * TILE_SIZE * Math.max(0.001, camera.zoom)),
    }
    const at =
      node.focus === null
        ? { tileX: listener.tileX, tileY: listener.tileY }
        : { tileX: node.focus.x, tileY: node.focus.y }
    this.#audioEngine.play(effect, at, listener)
  }

  /**
   * Pushes sector colours, fire, tunnels and overlay mode into the renderer.
   *
   * T8.19: Sector colour map is cached and only rebuilt when the underlying
   * sector data changes. This avoids `parseCssColour` and `Map` allocation
   * every frame, keeping the main thread within its 2ms budget.
   */
  #feedOverlay(): void {
    const control = this.bridge.latestControl()
    if (control !== null) {
      const sectorKey = this.#computeSectorColourKey(control.posts.sectors)
      if (sectorKey !== this.#sectorColourKey) {
        this.#sectorColourKey = sectorKey
        this.#sectorColourCache.clear()
        for (const sector of control.posts.sectors) {
          const parsed = parseCssColour(sector.colour)
          if (parsed !== null) this.#sectorColourCache.set(sector.id, parsed)
        }
      }
      this.renderer.setSectorColours(this.#sectorColourCache)
    }

    const effects = this.bridge.latestEffects()
    if (effects !== null) {
      this.renderer.setFireOverlay(effects.fire)
      this.renderer.setTunnelOverlay(effects.tunnels)
    }

    this.#syncOverlayMode()
    const parsed = parseOverlaySelection(this.state.paletteSelection.value)
    if (this.state.tool.value === 'overlay' && parsed !== null) {
      this.#requestOverlayData(parsed.mode, parsed.needId, false)
    }
  }

  /** T8.19: computes a cache key for sector colours. */
  #computeSectorColourKey(
    sectors: readonly { readonly id: number; readonly colour: string }[],
  ): string {
    if (sectors.length === 0) return ''
    return sectors.map((s) => `${s.id}:${s.colour}`).join(',')
  }

  /* ---------------------------------------------------------------------- */
  /* Notifications and the Trace panel (PRD 3.1)                             */
  /* ---------------------------------------------------------------------- */

  /**
   * Turns new notifications into toasts.
   *
   * The toast's words come from the Trace itself rather than a catalogue on
   * this thread: the templates need the event's own numbers, and those never
   * leave the worker. So each notification costs one round trip, which is
   * affordable because a notification is a failure, not a frame.
   */
  #publishToasts(): void {
    for (const notification of this.bridge.consumeNotifications()) {
      if (notification.traceId <= 0) continue
      if (this.#requestedTraces.has(notification.id)) continue
      this.#requestedTraces.add(notification.id)

      void this.bridge
        .trace(notification.traceId, notification.id)
        .then((result) => {
          if (result === null) return
          this.#traces.set(notification.id, result)
          this.#playTraceSfx(result)
          this.#pinNotification(notification.id, result, notification.severity)
          this.#pushToast({
            id: notification.id,
            severity: severityLabel(notification.severity),
            title: result.nodes[0]?.title ?? 'Something went wrong',
            detail: result.nodes[0]?.detail ?? '',
            count: notification.count,
            traceId: notification.traceId,
          })
        })
        .catch(() => {
          // A disposed bridge rejects in flight; the session is going away.
        })
    }
  }

  /** Newest first, capped: the toast rail is a rail, not a log. */
  #pushToast(toast: ToastModel): void {
    const kept = [toast, ...this.state.toasts.value].slice(0, MAX_TOASTS)
    for (const dropped of this.state.toasts.value.slice(MAX_TOASTS - 1)) {
      this.#releaseTrace(dropped.id)
    }
    this.state.toasts.value = kept
  }

  /** Opens the Trace for a toast (PRD 3.1). No chain means nothing happens. */
  openTrace(toast: ToastModel): void {
    const cached = this.#traces.get(toast.id)
    if (cached !== undefined) {
      this.#showTrace(cached)
      return
    }

    void this.bridge
      .trace(toast.traceId, toast.id)
      .then((result) => {
        if (result === null) return
        this.#traces.set(toast.id, result)
        this.#showTrace(result)
      })
      .catch(() => {
        // See #publishToasts.
      })
  }

  closeTrace(): void {
    this.#openTrace = null
    this.state.trace.value = null
  }

  /** Applies a suggested fix from the Trace panel (T8.10). */
  traceFix(fixId: string): void {
    if (fixId === 'add_cookers') {
      this.selectTool('objects')
      this.selectPaletteItem('cooker')
      this.state.hint.value = 'Place cookers in the kitchen'
      return
    }
    if (fixId === 'assign_cooks') {
      const inmate = this.state.inspector.value
      if (inmate !== null && inmate.kind === 'inmate') {
        this.assignLabour('kitchen', inmate.entityId)
        return
      }
      this.selectTool('staff')
      this.state.hint.value = 'Select an inmate and assign kitchen labour, or hire a cook'
    }
  }

  /** Copies a diagnostic report to the clipboard. */
  traceCopyReport(reportText: string): void {
    void navigator.clipboard.writeText(reportText).catch(() => {
      // Clipboard API may not be available; fail silently.
    })
  }

  /**
   * Pans to the subject of a Trace node (PRD 3.1: "each node tappable to jump
   * the camera there"). A node about something that is not on the map — a
   * policy, a whole prison — has no tile and does nothing.
   */
  focusTraceNode(node: TraceNodeModel): void {
    const resolved = this.#openTrace?.nodes.find((entry) => entry.eventId === node.eventId)
    const focus = resolved?.focus
    if (focus === undefined || focus === null) return
    this.focusTile(focus)
  }

  dismissToast(toast: ToastModel): void {
    this.state.toasts.value = this.state.toasts.value.filter((entry) => entry.id !== toast.id)
    if (this.#openTrace?.rootId === toast.traceId) this.closeTrace()
    this.#releaseTrace(toast.id)
    this.renderer.removePin(String(toast.id))
  }

  #syncSelections(): void {
    const model = this.state.inspector.value
    const focus = this.#focusTile
    if (model === null || focus === null || model.kind === 'tile' || model.kind === 'room') {
      this.renderer.setSelections([])
      return
    }
    this.renderer.setSelections([
      {
        id: model.entityId,
        x: (focus.x + 0.5) * TILE_SIZE,
        y: (focus.y + 0.5) * TILE_SIZE,
      },
    ])
  }

  #pinNotification(
    notificationId: number,
    result: TraceResult,
    severity: NotificationSeverity,
  ): void {
    const node = result.nodes[0]
    const focus = node?.focus
    if (node === undefined || focus === null || focus === undefined) return
    const pinSeverity =
      severity === NOTIFICATION_SEVERITY.CRITICAL
        ? 'critical'
        : severity === NOTIFICATION_SEVERITY.WARN
          ? 'warn'
          : 'info'
    this.renderer.setPin({
      id: String(notificationId),
      subjectId: node.subjectId,
      x: (focus.x + 0.5) * TILE_SIZE,
      y: (focus.y + 0.5) * TILE_SIZE,
      severity: pinSeverity,
    })
  }

  #showTrace(result: TraceResult): void {
    this.#openTrace = result
    this.state.trace.value = traceModelFromView(result, result.subtitle)
  }

  #releaseTrace(notificationId: number): void {
    if (!this.#traces.delete(notificationId)) return
    this.#requestedTraces.delete(notificationId)
    this.bridge.releaseTrace(notificationId)
  }

  #publishAgents(
    entities: readonly {
      id: number
      x: number
      y: number
      kind: number
      spriteIndex: number
      facing: number
      flags: number
    }[],
  ): void {
    const agents = entities.filter((entity) => !isObjectSnapshotId(entity.id))
    const next = agents.map((entity) =>
      snapshotEntityToRenderAgent(entity, {
        categoryIds: this.#categoryIds,
        selectedId: this.#selectedSnapshotId,
      }),
    )
    const posed =
      this.#prevAgents.length === 0 ? next : interpolateAgents(this.#prevAgents, next, 0.5)
    this.renderer.agents.setAgents(posed)
    this.#prevAgents = next
  }

  #publishObjects(
    entities: readonly {
      id: number
      x: number
      y: number
      kind: number
      spriteIndex: number
      facing: number
      flags: number
    }[],
  ): void {
    const objects: RenderObject[] = []
    for (const entity of entities) {
      const object = snapshotEntityToRenderObject(entity, this.#objectIds)
      if (object !== null) objects.push(object)
    }
    this.renderer.objects.setObjects(objects)
  }

  #publishDigest(
    tick: number,
    digest: {
      readonly balance: number
      readonly danger: number
      readonly population: number
      readonly alerts: number
    },
  ): void {
    const paused = this.state.speed.value === 0

    const next: TopBarModel = {
      time: ticksToTimeString(tick),
      day: ticksToDay(tick),
      // Seasons arrive with the calendar; until then the second line carries
      // the one piece of time state the player can change.
      dayNote: paused ? 'Paused' : `${String(this.state.speed.value)}x`,
      balance: digest.balance,
      balancePerDay: 0,
      population: digest.population,
      capacity: digest.population,
      danger: digest.danger,
      reoffending: 0,
      alerts: digest.alerts,
      critical: digest.alerts > 0 && digest.danger >= 80,
    }

    // Compared, not replaced: an identical object every frame would re-render
    // the whole top bar sixty times a second.
    if (!sameTopBar(this.state.topBar.value, next)) this.state.topBar.value = next
  }

  #publishHud(): void {
    this.#frames += 1
    const now = performance.now()
    if (now - this.#sampledAt < 500) return

    const fps = Math.round((this.#frames * 1000) / (now - this.#sampledAt))
    this.#frames = 0
    this.#sampledAt = now

    const stats = [
      `${String(fps)} fps`,
      `zoom ${this.renderer.camera.zoom.toFixed(2)}`,
      `${String(this.renderer.terrain.visibleChunkCount)} terrain`,
      `${String(this.renderer.walls.visibleChunkCount)} walls`,
      `${this.bridge.transport}`,
    ].join('  ·  ')
    this.state.hud.value =
      this.#isolationDiagnostic === null
        ? stats
        : `${this.#isolationDiagnostic}  ·  ${stats}`
  }

  /* ---------------------------------------------------------------------- */
  /* Runtime error handling (T8.15)                                          */
  /* ---------------------------------------------------------------------- */

  /**
   * Reports a runtime error to the user (T8.15).
   *
   * Called by global error handlers, worker crash handlers, and save failures.
   * Shows a dismissible error banner at the top of the screen.
   */
  reportRuntimeError(message: string): void {
    this.state.runtimeError.value = message
  }

  /** Dismisses the runtime error banner. */
  dismissRuntimeError(): void {
    this.state.runtimeError.value = null
  }

  /**
   * Checks for bridge errors and speed overrides each frame (T8.15).
   *
   * The worker can report errors via sim:error or auto-pause via speedChanged.
   * This polls both and surfaces them to the UI.
   */
  #checkBridgeState(): void {
    // Surface any worker error that was captured.
    const bridgeError = this.bridge.error
    if (bridgeError !== null && this.state.runtimeError.value === null) {
      this.reportRuntimeError(`Simulation error: ${bridgeError}`)
    }

    // Honor worker-initiated speed changes (auto-pause on critical notification).
    const override = this.bridge.takeSpeedOverride()
    if (override !== null) {
      this.state.speed.value = override.speed as SpeedStop
    }
  }
}

/** A wall line as the one-tile-thick rectangle it covers. */
function lineRect(line: { x1: number; y1: number; x2: number; y2: number }): {
  x: number
  y: number
  width: number
  height: number
} {
  const x = Math.min(line.x1, line.x2)
  const y = Math.min(line.y1, line.y2)
  return {
    x,
    y,
    width: Math.abs(line.x1 - line.x2) + 1,
    height: Math.abs(line.y1 - line.y2) + 1,
  }
}

/**
 * The rectangles a staged action covers, for the blueprint overlay.
 *
 * Validity is not known here — only the worker's report knows that, and it
 * reports per room rather than per stroke — so everything draws valid and the
 * bar carries the problems. An overlay that guessed would be wrong in exactly
 * the cases that matter.
 */
function actionRects(
  action: BuildAction,
): { x: number; y: number; width: number; height: number; valid: boolean }[] {
  switch (action.kind) {
    case 'placeFoundation':
    case 'paintFloor':
    case 'demolish':
    case 'designateRoom':
    case 'undesignateRoom':
      return [{ ...action.rect, valid: true }]
    case 'placeWall':
    case 'removeWall':
    case 'paintCable':
    case 'paintPipe':
      return [{ ...lineRect(action.line), valid: true }]
    case 'placeDoor':
    case 'placeObject':
    case 'removeObjectAt':
      return [{ x: action.tile.x, y: action.tile.y, width: 1, height: 1, valid: true }]
    case 'removeObject':
    case 'restore':
      return []
  }
}