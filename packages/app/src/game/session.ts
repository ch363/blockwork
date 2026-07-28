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
} from '@blockwork/sim'
import type {
  BlueprintReport,
  BuildAction,
  GameData,
  NotificationSeverity,
  Tile,
} from '@blockwork/sim'
import { BlockworkRenderer, interpolateAgents, terrainPalette } from '@blockwork/render'
import type { RenderAgent, RenderObject, ToolStroke } from '@blockwork/render'
import { signal } from '@preact/signals'
import type { Signal } from '@preact/signals'
import type {
  DockToolId,
  EmergencyModel,
  InspectorModel,
  PostsModel,
  PostsTab,
  SpeedStop,
  ToastModel,
  ToastSeverity,
  TopBarModel,
  TraceModel,
  TraceNodeModel,
  TrayGroup,
} from '@blockwork/ui'
import { categoryToken, resolveWorldTap, traceModelFromView } from '@blockwork/ui'

import { SimBridge, createSimWorker } from '../worker/bridge'
import type { InspectResult, TraceResult } from '../worker/simWorker'
import { snapshotEntityToRenderAgent } from '../worker/collectAgents'

import { createPalettes, gestureHint } from './palette'
import type { Palette, PaletteEntry } from './palette'

/** PRD 4.3's Large map. The size a new game starts at until T5.x offers a menu. */
export const DEFAULT_MAP_SIZE = 220

/**
 * Stand-in construction headcount until hired workers claim build jobs (T3.2).
 * One notional builder per tile keeps Phase 1 construction playable while
 * Phase 2 agents handle escorts and routine motion separately.
 */
export const STUB_BUILDERS = 1

/** Where the camera starts: the middle of the map. */
function centreTile(mapSize: number): number {
  return Math.floor(mapSize / 2)
}

export interface SessionOptions {
  readonly parent: HTMLElement
  readonly data: GameData
  readonly seed?: number
  readonly mapSize?: number
}

/** Everything the shell renders, as signals. */
export interface SessionState {
  readonly topBar: Signal<TopBarModel>
  readonly speed: Signal<SpeedStop>
  readonly tool: Signal<DockToolId | null>
  readonly palette: Signal<readonly TrayGroup[]>
  readonly paletteSelection: Signal<string | null>
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
  readonly hint: Signal<string | null>
  readonly hud: Signal<string | null>
  readonly committing: Signal<boolean>
  readonly canUndo: Signal<boolean>
  /** Staged strokes. Drives the Commit button, which the report cannot. */
  readonly stagedCount: Signal<number>
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

/** Placeholder until the worker publishes live post / sector summaries. */
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
  readonly bridge: SimBridge
  readonly renderer: BlockworkRenderer
  readonly data: GameData
  readonly mapSize: number

  /** Staged, unsent, and priced by the worker. Nothing here has been paid for. */
  readonly staged = new Blueprint()

  readonly #palettes: Readonly<Record<DockToolId, Palette>>
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
  readonly #categoryIds: readonly string[]

  private constructor(
    bridge: SimBridge,
    renderer: BlockworkRenderer,
    data: GameData,
    mapSize: number,
  ) {
    this.bridge = bridge
    this.renderer = renderer
    this.data = data
    this.mapSize = mapSize
    this.#palettes = createPalettes(data)
    this.#categoryIds = data.securityCategories.ids()

    this.state = {
      topBar: signal(EMPTY_TOP_BAR),
      speed: signal<SpeedStop>(1),
      tool: signal<DockToolId | null>(null),
      palette: signal<readonly TrayGroup[]>([]),
      paletteSelection: signal<string | null>(null),
      blueprint: signal<BlueprintReport | null>(null),
      inspector: signal<InspectorModel | null>(null),
      toasts: signal<readonly ToastModel[]>([]),
      trace: signal<TraceModel | null>(null),
      posts: signal<PostsModel | null>(null),
      postsTab: signal<PostsTab>('posts'),
      emergency: signal<EmergencyModel | null>(null),
      hint: signal<string | null>(null),
      hud: signal<string | null>(null),
      committing: signal(false),
      canUndo: signal(false),
      stagedCount: signal(0),
    }

    // The renderer draws the bridge's arrays directly. On the shared transport
    // those *are* the simulation's tile buffers, so this is the last copy that
    // never happens.
    renderer.setFloors(bridge.tiles.floorMaterial)
    renderer.setWalls(bridge.tiles.wallMaterial)

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
  }

  static async create(options: SessionOptions): Promise<Session> {
    const mapSize = options.mapSize ?? DEFAULT_MAP_SIZE
    const seed = options.seed ?? 0xb10c_0001

    const bridge = new SimBridge({
      worker: createSimWorker(),
      seed,
      mapSize,
      builders: STUB_BUILDERS,
    })

    // The one id list both palettes must be built from: `floorMaterial` and
    // `wallMaterial` store positions in this table, so a palette assembled any
    // other way colours the wrong material.
    const materialIds = ['none', ...options.data.materials.ids()]

    const renderer = await BlockworkRenderer.create({
      parent: options.parent,
      mapSize,
      palette: terrainPalette(materialIds),
      wallMaterialIds: materialIds,
    })

    const centre = centreTile(mapSize) * 32
    renderer.camera.moveTo(centre, centre)

    return new Session(bridge, renderer, options.data, mapSize)
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
    } else if (next === 'posts') {
      // Posts is a full panel, not a tray palette.
      this.state.palette.value = []
      this.state.paletteSelection.value = null
      this.closeEmergency()
      this.openPosts()
    } else if (next === 'emergency') {
      this.state.palette.value = []
      this.state.paletteSelection.value = null
      this.closePosts()
      this.openEmergency()
    } else {
      this.closePosts()
      this.closeEmergency()
      const palette = this.#palettes[next]
      this.state.palette.value = palette.groups
      this.state.paletteSelection.value = palette.initial
    }

    this.#syncInput()
  }

  openPosts(): void {
    this.state.posts.value = EMPTY_POSTS_MODEL
    this.state.postsTab.value = 'posts'
  }

  closePosts(): void {
    this.state.posts.value = null
    if (this.state.tool.value === 'posts') this.state.tool.value = null
  }

  setPostsTab(tab: PostsTab): void {
    this.state.postsTab.value = tab
  }

  openEmergency(): void {
    const model = emptyEmergencyModel(this.data)
    const digest = this.state.topBar.value
    this.state.emergency.value = { ...model, danger: digest.danger }
  }

  closeEmergency(): void {
    this.state.emergency.value = null
    if (this.state.tool.value === 'emergency') this.state.tool.value = null
  }

  #dispatchEmergency(type: string, payload: Record<string, number | boolean | string> = {}): void {
    this.bridge.sendCommand({
      type,
      issuedAtTick: this.#tick(),
      payload,
    })
  }

  emergencySectorLockdown(): void {
    const sectorId = this.state.emergency.value?.selectedSectorId
    if (sectorId === null || sectorId === undefined) return
    this.#dispatchEmergency('emergency.sectorLockdown', { sectorId })
    this.#patchEmergencyLevel('sector_lockdown', true)
  }

  emergencyLiftSectorLockdown(): void {
    const sectorId = this.state.emergency.value?.selectedSectorId
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

  #patchEmergencyLevel(
    id: EmergencyModel['levels'][number]['id'],
    active: boolean,
  ): void {
    const current = this.state.emergency.value
    if (current === null) return
    this.state.emergency.value = {
      ...current,
      levels: current.levels.map((level) =>
        level.id === id ? { ...level, active } : level,
      ),
    }
  }

  selectPaletteItem(itemId: string): void {
    this.state.paletteSelection.value = this.state.paletteSelection.value === itemId ? null : itemId
    this.#syncInput()
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
    const building = entry !== undefined

    this.renderer.tools.active = true
    this.renderer.gestures.singlePointerPan = !building
    this.state.hint.value = building ? gestureHint(entry) : null
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

    this.state.committing.value = true
    this.bridge.sendCommand(this.staged.commitCommand(this.#tick()))
    this.staged.clear()
    this.#renderBlueprint()
    this.#abandonValidation()
    this.state.canUndo.value = true

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
  }

  closeInspector(): void {
    this.state.inspector.value = null
    this.#focusTile = null
    this.#selectedSnapshotId = null
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
      this.#publishDigest(snapshot.tick, snapshot.digest)
    }
    this.#publishToasts()
    this.#publishHud()
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

  #publishAgents(entities: readonly { id: number; x: number; y: number; kind: number; spriteIndex: number; facing: number; flags: number }[]): void {
    const next = entities.map((entity) =>
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

  #publishDigest(
    tick: number,
    digest: { readonly balance: number; readonly danger: number; readonly population: number; readonly alerts: number },
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

    this.state.hud.value = [
      `${String(fps)} fps`,
      `zoom ${this.renderer.camera.zoom.toFixed(2)}`,
      `${String(this.renderer.terrain.visibleChunkCount)} terrain`,
      `${String(this.renderer.walls.visibleChunkCount)} walls`,
      `${this.bridge.transport}`,
    ].join('  ·  ')
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

/** Placeholder until the entity store lands: the world has no drawables yet. */
export const NO_RENDER_OBJECTS: readonly RenderObject[] = []
