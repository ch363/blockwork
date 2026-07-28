/**
 * @vitest-environment happy-dom
 *
 * Hit-target audit: every interactive control in the shell clears 44pt.
 */

import { createRef } from 'preact'
import { describe, expect, it } from 'vitest'

import { GameShell, MIN_HIT_TARGET_PT, auditHitTargets } from '../src/index'
import type { TopBarModel } from '../src/index'
import { FIXTURE_INMATE } from './fixtures/inspectors'
import { mountShell, unmount } from './helpers/mount'

const TOP_BAR: TopBarModel = {
  time: '14:20',
  day: 27,
  dayNote: 'Spring',
  balance: 84120,
  balancePerDay: 1840,
  population: 186,
  capacity: 208,
  danger: 62,
  reoffending: 41,
  alerts: 3,
  critical: true,
}

describe('hit target audit', () => {
  it('every control in the shell clears 44pt', () => {
    const stageRef = createRef<HTMLDivElement>()
    const host = mountShell(
      <GameShell
        stageRef={stageRef}
        topBar={TOP_BAR}
        speed={1}
        onSpeed={() => undefined}
        tool={null}
        onTool={() => undefined}
        palette={[]}
        paletteSelection={null}
        onPaletteSelect={() => undefined}
        inspector={FIXTURE_INMATE}
        onInspectorClose={() => undefined}
        blueprint={null}
        onCommit={() => undefined}
        onDiscard={() => undefined}
        onIssueFocus={() => undefined}
        toasts={[]}
        onTrace={() => undefined}
        onDismissToast={() => undefined}
        onUndo={() => undefined}
        onRedo={() => undefined}
        onAlerts={() => undefined}
        onMenu={() => undefined}
      />,
    )

    const violations = auditHitTargets(host, MIN_HIT_TARGET_PT)
    expect(violations).toEqual([])

    unmount(host)
  })
})
