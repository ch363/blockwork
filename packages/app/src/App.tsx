/**
 * The Preact root.
 *
 * A thin adapter: it turns the session's signals into props for `@blockwork/ui`
 * `App` (shell + Mac speed keyboard) and routes callbacks back into the
 * session. Holds no state of its own.
 */

import { App as UiApp } from '@blockwork/ui'
import type { PauseMenuModel, SaveSlotModel } from '@blockwork/ui'
import type { JSX } from 'preact'
import { useCallback, useEffect, useRef, useState } from 'preact/hooks'

import { UNBUILT_TOOLS } from './game/palette'
import type { Session } from './game/session'
import { SaveStore } from './save/store'
import type { SaveSummary } from './save/store'

export interface AppProps {
  readonly session: Session
}

function saveSummaryToSlot(summary: SaveSummary): SaveSlotModel {
  return {
    key: summary.key,
    name: summary.name,
    savedAt: summary.savedAt,
    playedTicks: summary.playedTicks,
    mapSize: summary.mapSize,
  }
}

export function App({ session }: AppProps): JSX.Element {
  const stageRef = useRef<HTMLDivElement>(null)
  const state = session.state
  const [pauseMenuOpen, setPauseMenuOpen] = useState(false)
  const [saveSlots, setSaveSlots] = useState<readonly SaveSlotModel[]>([])

  // Panel error handler (T8.15)
  const onPanelError = useCallback(
    (error: Error, panelName: string) => {
      session.reportRuntimeError(`Error in ${panelName}: ${error.message}`)
    },
    [session],
  )

  // Dismiss runtime error (T8.15)
  const dismissRuntimeError = useCallback(() => {
    session.dismissRuntimeError()
  }, [session])

  useEffect(() => {
    const stage = stageRef.current
    if (stage !== null) session.attachTo(stage)
  }, [session])

  useEffect(() => {
    const unlock = (): void => {
      session.unlockAudio()
    }
    window.addEventListener('pointerdown', unlock)
    window.addEventListener('keydown', unlock)
    return () => {
      window.removeEventListener('pointerdown', unlock)
      window.removeEventListener('keydown', unlock)
    }
  }, [session])

  const refreshSaveSlots = useCallback(async () => {
    try {
      const store = await SaveStore.open()
      const summaries = await store.list()
      store.close()
      setSaveSlots(summaries.map(saveSummaryToSlot))
    } catch {
      setSaveSlots([])
    }
  }, [])

  const openPauseMenu = useCallback(() => {
    session.setSpeed(0)
    void refreshSaveSlots()
    setPauseMenuOpen(true)
  }, [session, refreshSaveSlots])

  const closePauseMenu = useCallback(() => {
    setPauseMenuOpen(false)
  }, [])

  const resumeGame = useCallback(() => {
    setPauseMenuOpen(false)
    session.setSpeed(1)
  }, [session])

  const saveGame = useCallback(async () => {
    await session.autosave()
    void refreshSaveSlots()
  }, [session, refreshSaveSlots])

  const loadGame = useCallback(
    async (key: string) => {
      try {
        const store = await SaveStore.open()
        const bytes = await store.read(key)
        store.close()
        if (bytes !== null) {
          const success = await session.load(bytes)
          if (success) {
            setPauseMenuOpen(false)
            session.setSpeed(1)
          }
        }
      } catch (error) {
        console.error('Load failed', error)
      }
    },
    [session],
  )

  const exportSave = useCallback(async () => {
    try {
      const createdAt = new Date().toISOString()
      const { bytes } = await session.bridge.exportSave(createdAt)
      // slice() creates a copy with a regular ArrayBuffer (not SharedArrayBuffer)
      const blob = new Blob([bytes.slice()], { type: 'application/octet-stream' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `blockwork-${Date.now()}.blockwork`
      a.click()
      URL.revokeObjectURL(url)
    } catch (error) {
      console.error('Export failed', error)
    }
  }, [session])

  const importSave = useCallback(() => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = '.blockwork'
    input.onchange = async () => {
      const file = input.files?.[0]
      if (file === undefined) return
      try {
        const buffer = await file.arrayBuffer()
        const bytes = new Uint8Array(buffer)
        const success = await session.load(bytes)
        if (success) {
          setPauseMenuOpen(false)
          session.setSpeed(1)
        }
      } catch (error) {
        console.error('Import failed', error)
      }
    }
    input.click()
  }, [session])

  const pauseMenuModel: PauseMenuModel | null = pauseMenuOpen
    ? { saves: saveSlots, canSave: true, canExport: true }
    : null

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
        session.closeSettings()
        session.closeNewPrison()
        session.closeAlerts()
        session.closeOnboarding()
        session.closeRoutine()
        session.closeContracts()
        session.closeIntake()
        session.closeFlow()
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

  const runtimeError = state.runtimeError.value

  return (
    <>
      {/* Runtime error banner (T8.15) */}
      {runtimeError !== null && (
        <div class="bw-runtime-error" role="alert" aria-live="assertive">
          <span class="bw-runtime-error-message">{runtimeError}</span>
          <button
            class="bw-runtime-error-dismiss"
            type="button"
            onClick={dismissRuntimeError}
            aria-label="Dismiss error"
          >
            Dismiss
          </button>
        </div>
      )}

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
        onPanelError={onPanelError}
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
      onInspectorSearch={() => {
        session.inspectorSearch()
      }}
      onInspectorDemolish={() => {
        session.inspectorDemolish()
      }}
      onInspectorReclassify={() => {
        const model = state.inspector.value
        if (model !== null && model.kind === 'inmate') {
          const categories = session.data.securityCategories.all.filter(
            (cat) => cat.id !== model.categoryId,
          )
          if (categories.length > 0) {
            session.inspectorReclassify(categories[0]?.id ?? model.categoryId)
          }
        }
      }}
      onInspectorPunish={() => {
        session.inspectorPunish()
      }}
      onInspectorProtective={() => {
        session.inspectorProtective()
      }}
      onInspectorNeedSelect={(needId) => {
        session.inspectorNeedSelect(needId)
      }}
      onInspectorFire={() => {
        session.inspectorFire()
      }}
      onInspectorAcceptPayDemand={() => {
        session.acceptPayDemand()
      }}
      onInspectorRefusePayDemand={() => {
        session.refusePayDemand()
      }}
      onInspectorAssignLabour={() => {
        session.inspectorAssignLabour()
      }}
      onInspectorUnassignLabour={() => {
        session.inspectorUnassignLabour()
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
      onTraceFix={(fix) => {
        session.traceFix(fix.id)
      }}
      onTraceCopyReport={(reportText) => {
        session.traceCopyReport(reportText)
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
      onPostsSelectPost={(id) => {
        session.selectPostsPost(id)
      }}
      onPostsSelectPatrol={(id) => {
        session.selectPostsPatrol(id)
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
      onProgramsEnrol={() => {
        session.enrolSelectedProgram()
      }}
      onProgramsWithdraw={() => {
        session.withdrawSelectedProgram()
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
        session.openAlerts()
      }}
      onMenu={openPauseMenu}
      pauseMenu={pauseMenuModel}
      onPauseMenuClose={closePauseMenu}
      onPauseMenuResume={resumeGame}
      onPauseMenuSave={saveGame}
      onPauseMenuLoad={loadGame}
      onPauseMenuExport={exportSave}
      onPauseMenuImport={importSave}
      onPauseMenuSettings={() => {
        closePauseMenu()
        session.openSettings()
      }}
      onPauseMenuNewPrison={() => {
        closePauseMenu()
        session.openNewPrison()
      }}
      onPauseMenuQuit={() => {
        closePauseMenu()
        session.quitToNewPrison()
      }}
      canUndo={state.canUndo.value || state.blueprint.value !== null}
      canRedo={state.canRedo.value}
      hint={state.hint.value}
      hud={state.hud.value}
      settings={state.settings.value}
      settingsTab={state.settingsTab.value}
      onSettingsTab={(tab) => {
        session.setSettingsTab(tab)
      }}
      onSettingsClose={() => {
        session.closeSettings()
      }}
      onSettingsVolume={(channel, value) => {
        session.setSettingsVolume(channel, value)
      }}
      onSettingsMute={(muted) => {
        session.setSettingsMute(muted)
      }}
      onSettingsPalette={(palette) => {
        session.setSettingsPalette(palette)
      }}
      onSettingsReduceMotion={(enabled) => {
        session.setSettingsReduceMotion(enabled)
      }}
      onSettingsTypeScale={(scale) => {
        session.setSettingsTypeScale(scale)
      }}
      onSettingsPreferNoFailure={(enabled) => {
        session.setSettingsPreferNoFailure(enabled)
      }}
      onSettingsAutosaveHours={(hours) => {
        session.setSettingsAutosaveHours(hours)
      }}
      newPrison={state.newPrison.value}
      onNewPrisonSize={(preset) => {
        session.setNewPrisonSize(preset)
      }}
      onNewPrisonStartingFunds={(amount) => {
        session.setNewPrisonStartingFunds(amount)
      }}
      onNewPrisonContinuousIntake={(enabled) => {
        session.setNewPrisonContinuousIntake(enabled)
      }}
      onNewPrisonRandomEvents={(enabled) => {
        session.setNewPrisonRandomEvents(enabled)
      }}
      onNewPrisonFirstOrderGrace={(enabled) => {
        session.setNewPrisonFirstOrderGrace(enabled)
      }}
      onNewPrisonSeed={(input) => {
        session.setNewPrisonSeed(input)
      }}
      onNewPrisonFailure={(id, enabled) => {
        session.setNewPrisonFailure(id, enabled)
      }}
      onNewPrisonMutator={(id, enabled) => {
        session.setNewPrisonMutator(id, enabled)
      }}
      onNewPrisonStart={() => {
        void session.startNewPrison()
      }}
      onNewPrisonCancel={() => {
        session.closeNewPrison()
      }}
      alerts={state.alerts.value}
      onAlertsClose={() => {
        session.closeAlerts()
      }}
      onAlertsFilter={(severity) => {
        session.setAlertsFilter(severity)
      }}
      onAlertsMute={(category, muted) => {
        session.setAlertsMute(category, muted)
      }}
      onAlertsAutoPause={(enabled) => {
        session.setAlertsAutoPause(enabled)
      }}
      onAlertsOpenTrace={(row) => {
        session.openAlertTrace(row)
      }}
      onboarding={state.onboarding.value}
      onOnboardingSkip={() => {
        session.skipOnboarding()
      }}
      onOnboardingDismissMark={(objectiveIndex) => {
        session.dismissOnboardingMark(objectiveIndex)
      }}
      onOnboardingMode={(mode) => {
        session.setOnboardingMode(mode)
      }}
      routine={state.routine.value}
      onRoutineClose={() => {
        session.closeRoutine()
      }}
      onRoutineSetCategory={(categoryId, blocks) => {
        session.setRoutineCategory(categoryId, blocks)
      }}
      contracts={state.contracts.value}
      onContractsClose={() => {
        session.closeContracts()
      }}
      onContractsAccept={(contractId) => {
        session.acceptContract(contractId)
      }}
      onContractsCancel={(contractId) => {
        session.cancelContract(contractId)
      }}
      onContractsTakeLoan={(amount) => {
        session.takeLoan(amount)
      }}
      onContractsRepayLoan={(amount) => {
        session.repayLoan(amount)
      }}
      intake={state.intake.value}
      onIntakeClose={() => {
        session.closeIntake()
      }}
      onIntakeSetContinuous={(continuous) => {
        session.setIntakeContinuous(continuous)
      }}
      onIntakeSetRequested={(categoryId, count) => {
        session.setIntakeRequested(categoryId, count)
      }}
      onIntakeClearRequested={() => {
        session.clearIntakeRequested()
      }}
      flow={state.flow.value}
      onFlowClose={() => {
        session.closeFlow()
      }}
    />
    </>
  )
}
