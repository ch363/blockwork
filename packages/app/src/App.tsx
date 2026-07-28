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
        session.discard()
        session.closeInspector()
        session.closePosts()
        session.closeEmergency()
        session.closeTrace()
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
        // Redo needs the inverse of an inverse; T1.5 covers undo.
      }}
      onAlerts={() => {
        // The alerts panel is T3.2.
      }}
      onMenu={() => {
        // The pause menu is T5.4.
      }}
      canUndo={state.canUndo.value || state.blueprint.value !== null}
      canRedo={false}
      hint={state.hint.value}
      hud={state.hud.value}
    />
  )
}
