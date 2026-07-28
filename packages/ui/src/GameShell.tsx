/**
 * The game shell: the frame every panel hangs in (PRD 6.1).
 *
 * Top bar, world, tool dock, with the inspector, the palette tray, the
 * blueprint bar and the toasts layered over the world in that order. It owns
 * no game state — every value arrives as a prop and every gesture leaves as a
 * callback — so the shell can be reasoned about as a layout and the host can
 * be reasoned about as a state machine.
 *
 * **The world is a hole, not a child.** The Pixi canvas is created by
 * `packages/render` and appended to whatever element it is handed, which does
 * not fit a virtual DOM that reserves the right to re-render its children. So
 * the stage is an empty `<div>` and the host is given a ref to it: Preact owns
 * everything except that rectangle, and inside it nothing but Pixi ever
 * writes. It also keeps the two repaint budgets of PRD 7.5 separate — 3ms for
 * the UI, 4ms for sprites — because a signal update cannot touch the canvas
 * and a frame cannot touch the DOM.
 *
 * **Nothing sits on top of the world except transient overlays.** PRD 6.1 is
 * explicit about that, and it is why the tray and the blueprint bar are
 * absolutely positioned inside the stage rather than being rows in the column:
 * a panel that reflows the world would move the map under the player's finger
 * every time a palette opened.
 */

import type { BlueprintIssue, BlueprintReport, Tile } from '@blockwork/sim'
import type { JSX, Ref } from 'preact'

import { BlueprintBar } from './panels/BlueprintBar'
import { Inspector } from './panels/Inspector'
import type { InspectorModel } from './panels/Inspector'
import { ToolDock } from './panels/ToolDock'
import type { DockToolId } from './panels/ToolDock'
import { TopBar } from './panels/TopBar'
import type { SpeedStop, TopBarModel } from './panels/TopBar'
import { Toasts } from './panels/Toasts'
import type { ToastModel } from './panels/Toasts'
import { Trace } from './panels/Trace'
import type { TraceFixModel, TraceModel, TraceNodeModel } from './panels/Trace'
import { Posts } from './panels/Posts'
import type { PostsModel, PostsTab } from './panels/Posts'
import { Emergency } from './panels/Emergency'
import type { EmergencyModel } from './panels/Emergency'
import { Tray } from './panels/Tray'
import type { TrayGroup } from './panels/Tray'

export interface GameShellProps {
  /** The element the renderer appends its canvas to. */
  readonly stageRef: Ref<HTMLDivElement>

  readonly topBar: TopBarModel
  readonly speed: SpeedStop
  readonly onSpeed: (speed: SpeedStop) => void

  readonly tool: DockToolId | null
  readonly onTool: (tool: DockToolId) => void
  readonly disabledTools?: readonly DockToolId[]

  /** The open tool's palette. Empty groups close the tray. */
  readonly palette: readonly TrayGroup[]
  readonly paletteSelection: string | null
  readonly onPaletteSelect: (itemId: string) => void

  readonly inspector: InspectorModel | null
  readonly onInspectorClose: () => void
  readonly onInspectorFocus?: () => void
  readonly onInspectorDemolish?: () => void
  readonly onInspectorSearch?: () => void
  readonly onInspectorReclassify?: () => void
  readonly onInspectorPunish?: () => void
  readonly onInspectorProtective?: () => void
  readonly onInspectorNeedSelect?: (needId: string) => void

  /** Null while nothing is staged, which is what hides the bar. */
  readonly blueprint: BlueprintReport | null
  readonly onCommit: () => void
  readonly onDiscard: () => void
  readonly onIssueFocus: (tile: Tile, issue: BlueprintIssue) => void
  readonly committing?: boolean
  /** Whether the staged blueprint has anything in it. */
  readonly canCommit?: boolean

  readonly toasts: readonly ToastModel[]
  readonly onTrace: (toast: ToastModel) => void
  readonly onDismissToast: (toast: ToastModel) => void

  /** Null closes the Trace panel. */
  readonly trace?: TraceModel | null
  readonly onTraceClose?: () => void
  readonly onTraceNodeFocus?: (node: TraceNodeModel) => void
  readonly onTraceFix?: (fix: TraceFixModel) => void
  readonly onTraceCopyReport?: (reportText: string) => void

  /** Null closes the Posts panel. */
  readonly posts?: PostsModel | null
  readonly postsTab?: PostsTab
  readonly onPostsTab?: (tab: PostsTab) => void
  readonly onPostsClose?: () => void
  readonly onPostsNewPost?: () => void
  readonly onPostsNewPatrol?: () => void
  readonly onPostsNewSector?: () => void
  readonly onPostsSelectPost?: (id: number) => void
  readonly onPostsSelectPatrol?: (id: number) => void
  readonly onPostsSelectSector?: (id: number) => void
  readonly onPostsHireSuggested?: () => void
  readonly onPostsConfigureSector?: (id: number) => void

  /** Null closes the Emergency panel. */
  readonly emergency?: EmergencyModel | null
  readonly onEmergencyClose?: () => void
  readonly onEmergencySectorLockdown?: () => void
  readonly onEmergencyLiftSectorLockdown?: () => void
  readonly onEmergencyFullLockdown?: () => void
  readonly onEmergencyLiftFullLockdown?: () => void
  readonly onEmergencyCallRiotSquad?: () => void
  readonly onEmergencyDismissRiotSquad?: () => void
  readonly onEmergencyAuthoriseFreeFire?: () => void
  readonly onEmergencyRevokeFreeFire?: () => void
  readonly onEmergencyCallNationalGuard?: () => void

  readonly onUndo: () => void
  readonly onRedo: () => void
  readonly onAlerts: () => void
  readonly onMenu: () => void
  readonly canUndo?: boolean
  readonly canRedo?: boolean

  /** A one-line instruction for the active tool, shown over the world. */
  readonly hint?: string | null
  /** Diagnostics: fps, draw calls. Absent in a release build. */
  readonly hud?: string | null
}

export function GameShell(props: GameShellProps): JSX.Element {
  const trayOpen = props.palette.length > 0
  const inspectorOpen = props.inspector !== null

  return (
    <div class="bw-shell">
      <TopBar
        model={props.topBar}
        speed={props.speed}
        onSpeed={props.onSpeed}
        onUndo={props.onUndo}
        onRedo={props.onRedo}
        onAlerts={props.onAlerts}
        onMenu={props.onMenu}
        canUndo={props.canUndo ?? false}
        canRedo={props.canRedo ?? false}
      />

      <div class="bw-stage">
        {/* Pixi's territory. Preact must never render into this element. */}
        <div ref={props.stageRef} style="position:absolute;inset:0" />

        {props.hud != null && <div class="bw-hud">{props.hud}</div>}

        {props.hint != null && props.blueprint === null && <div class="bw-hint">{props.hint}</div>}

        {props.blueprint !== null && (
          <BlueprintBar
            report={props.blueprint}
            onCommit={props.onCommit}
            onDiscard={props.onDiscard}
            onFocus={props.onIssueFocus}
            busy={props.committing ?? false}
            canCommit={props.canCommit ?? true}
            inspectorOpen={inspectorOpen}
            trayOpen={trayOpen}
          />
        )}

        <Tray
          groups={props.palette}
          selected={props.paletteSelection}
          onSelect={props.onPaletteSelect}
          open={trayOpen}
          inspectorOpen={inspectorOpen}
        />

        <Inspector
          model={props.inspector}
          onClose={props.onInspectorClose}
          {...(props.onInspectorFocus === undefined ? {} : { onFocus: props.onInspectorFocus })}
          {...(props.onInspectorDemolish === undefined
            ? {}
            : { onDemolish: props.onInspectorDemolish })}
          {...(props.onInspectorSearch === undefined ? {} : { onSearch: props.onInspectorSearch })}
          {...(props.onInspectorReclassify === undefined
            ? {}
            : { onReclassify: props.onInspectorReclassify })}
          {...(props.onInspectorPunish === undefined ? {} : { onPunish: props.onInspectorPunish })}
          {...(props.onInspectorProtective === undefined
            ? {}
            : { onProtective: props.onInspectorProtective })}
          {...(props.onInspectorNeedSelect === undefined
            ? {}
            : { onNeedSelect: props.onInspectorNeedSelect })}
        />

        <Trace
          model={props.trace ?? null}
          onClose={props.onTraceClose ?? (() => undefined)}
          onNodeFocus={props.onTraceNodeFocus ?? (() => undefined)}
          onFix={props.onTraceFix ?? (() => undefined)}
          {...(props.onTraceCopyReport === undefined
            ? {}
            : { onCopyReport: props.onTraceCopyReport })}
        />

        <Posts
          model={props.posts ?? null}
          tab={props.postsTab ?? 'posts'}
          onTab={props.onPostsTab ?? (() => undefined)}
          onClose={props.onPostsClose ?? (() => undefined)}
          {...(props.onPostsNewPost === undefined ? {} : { onNewPost: props.onPostsNewPost })}
          {...(props.onPostsNewPatrol === undefined
            ? {}
            : { onNewPatrol: props.onPostsNewPatrol })}
          {...(props.onPostsNewSector === undefined
            ? {}
            : { onNewSector: props.onPostsNewSector })}
          {...(props.onPostsSelectPost === undefined
            ? {}
            : { onSelectPost: props.onPostsSelectPost })}
          {...(props.onPostsSelectPatrol === undefined
            ? {}
            : { onSelectPatrol: props.onPostsSelectPatrol })}
          {...(props.onPostsSelectSector === undefined
            ? {}
            : { onSelectSector: props.onPostsSelectSector })}
          {...(props.onPostsHireSuggested === undefined
            ? {}
            : { onHireSuggested: props.onPostsHireSuggested })}
          {...(props.onPostsConfigureSector === undefined
            ? {}
            : { onConfigureSector: props.onPostsConfigureSector })}
        />

        <Emergency
          model={props.emergency ?? null}
          onClose={props.onEmergencyClose ?? (() => undefined)}
          {...(props.onEmergencySectorLockdown === undefined
            ? {}
            : { onSectorLockdown: props.onEmergencySectorLockdown })}
          {...(props.onEmergencyLiftSectorLockdown === undefined
            ? {}
            : { onLiftSectorLockdown: props.onEmergencyLiftSectorLockdown })}
          {...(props.onEmergencyFullLockdown === undefined
            ? {}
            : { onFullLockdown: props.onEmergencyFullLockdown })}
          {...(props.onEmergencyLiftFullLockdown === undefined
            ? {}
            : { onLiftFullLockdown: props.onEmergencyLiftFullLockdown })}
          {...(props.onEmergencyCallRiotSquad === undefined
            ? {}
            : { onCallRiotSquad: props.onEmergencyCallRiotSquad })}
          {...(props.onEmergencyDismissRiotSquad === undefined
            ? {}
            : { onDismissRiotSquad: props.onEmergencyDismissRiotSquad })}
          {...(props.onEmergencyAuthoriseFreeFire === undefined
            ? {}
            : { onAuthoriseFreeFire: props.onEmergencyAuthoriseFreeFire })}
          {...(props.onEmergencyRevokeFreeFire === undefined
            ? {}
            : { onRevokeFreeFire: props.onEmergencyRevokeFreeFire })}
          {...(props.onEmergencyCallNationalGuard === undefined
            ? {}
            : { onCallNationalGuard: props.onEmergencyCallNationalGuard })}
        />

        <Toasts toasts={props.toasts} onTrace={props.onTrace} onDismiss={props.onDismissToast} />
      </div>

      <ToolDock active={props.tool} onSelect={props.onTool} disabled={props.disabledTools ?? []} />
    </div>
  )
}
