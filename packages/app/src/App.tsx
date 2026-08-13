/**
 * The Preact root.
 *
 * A thin adapter: it turns the session's signals into props for `@blockwork/ui`
 * `App` (shell + Mac speed keyboard) and routes callbacks back into the
 * session. Holds no state of its own.
 */

import { App as UiApp } from '@blockwork/ui'
import type { JSX } from 'preact'
import { useCallback, useEffect, useRef } from 'preact/hooks'

import { UNBUILT_TOOLS } from './game/palette'
import type { Session } from './game/session'

export interface AppProps {
  readonly session: Session
}

export function App({ session }: AppProps): JSX.Element {
  const stageRef = useRef<HTMLDivElement>(null)
  const state = session.state

  useEffect(() => {
    const stage = stageRef.current
    if (stage !== null) session.attachTo(stage)
  }, [session])

  // PRD 2.3: Cmd/Ctrl+Z undoes; Escape clears blueprint and closes inspector.
  // Speed keys live in `@blockwork/ui` App.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z') {
        event.preventDefault()
        session.undo()
        return
      }
      if (event.key === 'Escape') {
        if (session.cancelPostsPatrolIfActive()) return
        session.discard()
        session.closeInspector()
        session.closePosts()
        session.closeEmergency()
        session.closeStandingOrders()
        session.closeTrace()
        session.closeDirectorate()
        session.closePrograms()
        session.closeIntelligence()
        session.closeReports()
      }
    }

    globalThis.addEventListener('keydown', onKey)
    return () => {
      globalThis.removeEventListener('keydown', onKey)
    }
  }, [session])

  const onIssueFocus = useCallback(
    (tile: { x: number; y: number }) => {
      session.focusTile(tile)
    },
    [session],
  )

  return (
    <UiApp
      stageRef={stageRef}
      topBar={state.topBar.value}
      speed={state.speed.value}
      onSpeed={(speed) => {
        session.setSpeed(speed)
      }}
      tool={state.tool.value}
      onTool={(tool) => {
        session.selectTool(tool)
      }}
      disabledTools={UNBUILT_TOOLS}
      palette={state.palette.value}
      paletteSelection={state.paletteSelection.value}
      overlayLegend={state.overlayLegend.value}
      onPaletteSelect={(itemId) => {
        session.selectPaletteItem(itemId)
      }}
      inspector={state.inspector.value}
      onInspectorClose={() => {
        session.closeInspector()
      }}
      onInspectorFocus={() => {
        session.focusInspected()
      }}
      blueprint={state.blueprint.value}
      onCommit={() => {
        session.commit()
      }}
      onDiscard={() => {
        session.discard()
      }}
      onIssueFocus={onIssueFocus}
      committing={state.committing.value}
      canCommit={state.stagedCount.value > 0}
      toasts={state.toasts.value}
      onTrace={(toast) => {
        session.openTrace(toast)
      }}
      trace={state.trace.value}
      onTraceClose={() => {
        session.closeTrace()
      }}
      onTraceNodeFocus={(node) => {
        session.focusTraceNode(node)
      }}
      posts={state.posts.value}
      postsTab={state.postsTab.value}
      onPostsTab={(tab) => {
        session.setPostsTab(tab)
      }}
      onPostsClose={() => {
        session.closePosts()
      }}
      onPostsSelectSector={(id) => {
        session.selectPostsSector(id)
      }}
      onPostsHireSuggested={() => {
        session.hireSuggestedOfficers()
      }}
      onPostsNewSector={() => {
        session.createPostsSector()
      }}
      onPostsNewPost={() => {
        session.createPostsPost()
      }}
      onPostsNewPatrol={() => {
        session.beginPostsPatrol()
      }}
      onPostsConfigureSector={(id) => {
        session.configurePostsSector(id)
      }}
      standingOrders={state.standingOrders.value}
      standingOrdersTab={state.standingOrdersTab.value}
      onStandingOrdersTab={(tab) => {
        session.setStandingOrdersTab(tab)
      }}
      onStandingOrdersClose={() => {
        session.closeStandingOrders()
      }}
      onStandingOrdersPunishment={(misconduct, punishment) => {
        session.standingOrdersPunishment(misconduct, punishment)
      }}
      onStandingOrdersDuration={(misconduct, durationHours) => {
        session.standingOrdersDuration(misconduct, durationHours)
      }}
      onStandingOrdersSearchTrigger={(misconduct, search) => {
        session.standingOrdersSearchTrigger(misconduct, search)
      }}
      onStandingOrdersStrictness={(strictness) => {
        session.standingOrdersStrictness(strictness)
      }}
      onStandingOrdersMealQuantity={(quantity) => {
        session.standingOrdersMealQuantity(quantity)
      }}
      onStandingOrdersMealVariety={(variety) => {
        session.standingOrdersMealVariety(variety)
      }}
      directorate={state.directorate.value}
      directorateBranch={state.directorateBranch.value}
      onDirectorateBranch={(branch) => {
        session.setDirectorateBranch(branch)
      }}
      onDirectorateSelect={(nodeId) => {
        session.selectDirectorateNode(nodeId)
      }}
      onDirectorateClose={() => {
        session.closeDirectorate()
      }}
      onDirectorateStart={(nodeId) => {
        session.startDirectorateResearch(nodeId)
      }}
      programs={state.programs.value}
      onProgramsSelect={(programId) => {
        session.selectProgram(programId)
      }}
      onProgramsClose={() => {
        session.closePrograms()
      }}
      onProgramsPin={(programId) => {
        session.pinProgram(programId)
      }}
      onProgramsUnpin={(programId) => {
        session.unpinProgram(programId)
      }}
      intelligence={state.intelligence.value}
      intelligenceTab={state.intelligenceTab.value}
      onIntelligenceTab={(tab) => {
        session.setIntelligenceTab(tab)
      }}
      onIntelligenceClose={() => {
        session.closeIntelligence()
      }}
      onIntelligenceRecruit={(inmateId) => {
        session.recruitInformant(inmateId)
      }}
      onIntelligenceFocusInformant={(inmateId) => {
        session.focusInformant(inmateId)
      }}
      reports={state.reports.value}
      reportsTab={state.reportsTab.value}
      onReportsTab={(tab) => {
        session.setReportsTab(tab)
      }}
      onReportsClose={() => {
        session.closeReports()
      }}
      onReportsNeedHeatmap={(needId) => {
        session.showNeedHeatmap(needId)
      }}
      onReportsTrace={(traceId) => {
        session.openReportTrace(traceId)
      }}
      emergency={state.emergency.value}
      onEmergencyClose={() => {
        session.closeEmergency()
      }}
      onEmergencySectorLockdown={() => {
        session.emergencySectorLockdown()
      }}
      onEmergencyLiftSectorLockdown={() => {
        session.emergencyLiftSectorLockdown()
      }}
      onEmergencyFullLockdown={() => {
        session.emergencyFullLockdown()
      }}
      onEmergencyLiftFullLockdown={() => {
        session.emergencyLiftFullLockdown()
      }}
      onEmergencyCallRiotSquad={() => {
        session.emergencyCallRiotSquad()
      }}
      onEmergencyDismissRiotSquad={() => {
        session.emergencyDismissRiotSquad()
      }}
      onEmergencyAuthoriseFreeFire={() => {
        session.emergencyAuthoriseFreeFire()
      }}
      onEmergencyRevokeFreeFire={() => {
        session.emergencyRevokeFreeFire()
      }}
      onEmergencyCallNationalGuard={() => {
        session.emergencyCallNationalGuard()
      }}
      onDismissToast={(toast) => {
        session.dismissToast(toast)
      }}
      onUndo={() => {
        session.undo()
      }}
      onRedo={() => {
        session.redo()
      }}
      onAlerts={() => {
        // The alerts panel is T3.2.
      }}
      onMenu={() => {
        // The pause menu is T5.4.
      }}
      canUndo={state.canUndo.value || state.blueprint.value !== null}
      canRedo={state.canRedo.value}
      hint={state.hint.value}
      hud={state.hud.value}
    />
  )
}
