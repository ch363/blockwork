/**
 * @vitest-environment happy-dom
 *
 * VoiceOver / accessible name coverage for every control in the shell.
 */

import { createRef } from 'preact'
import { describe, expect, it } from 'vitest'

import { GameShell, auditAccessibleNames } from '../src/index'
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
  critical: false,
}

describe('accessibility label coverage', () => {
  it('every interactive control has a meaningful accessible name', () => {
    const stageRef = createRef<HTMLDivElement>()
    const host = mountShell(
      <GameShell
        stageRef={stageRef}
        topBar={TOP_BAR}
        speed={1}
        onSpeed={() => undefined}
        tool="build"
        onTool={() => undefined}
        palette={[
          {
            id: 'foundations',
            label: 'Foundations',
            items: [{ id: 'brick', name: 'Brick', note: '£40', icon: 'wall' }],
          },
        ]}
        paletteSelection="brick"
        onPaletteSelect={() => undefined}
        inspector={FIXTURE_INMATE}
        onInspectorClose={() => undefined}
        blueprint={null}
        onCommit={() => undefined}
        onDiscard={() => undefined}
        onIssueFocus={() => undefined}
        toasts={[
          {
            id: 1,
            severity: 'critical',
            title: 'Inmate is starving',
            detail: 'Missed three meal blocks',
            count: 1,
            traceId: 9,
          },
        ]}
        onTrace={() => undefined}
        onDismissToast={() => undefined}
        onUndo={() => undefined}
        onRedo={() => undefined}
        onAlerts={() => undefined}
        onMenu={() => undefined}
      />,
    )

    const missing = auditAccessibleNames(host)
    expect(missing).toEqual([])

    unmount(host)
  })
})
