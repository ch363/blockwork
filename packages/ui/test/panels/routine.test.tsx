/**
 * @vitest-environment happy-dom
 */

import { describe, expect, it } from 'vitest'

import { Routine } from '../../src/panels/Routine'
import type { RoutineModel, RoutineBlockId } from '../../src/panels/Routine'
import { mountShell, unmount } from '../helpers/mount'

function model(): RoutineModel {
  return {
    categories: [
      {
        id: 'all',
        name: 'All prisoners',
        blocks: Array(24).fill('free') as RoutineBlockId[],
      },
      {
        id: 'min_sec',
        name: 'Minimum Security',
        blocks: Array(24)
          .fill('free')
          .map((_, i) => (i >= 7 && i < 19 ? 'work_free' : 'free')) as RoutineBlockId[],
      },
    ],
    conflicts: [
      { message: 'Meal overlap at 12:00 between All prisoners and Minimum Security', severity: 'warn' },
    ],
  }
}

describe('Routine', () => {
  it('renders the 24-hour strip with category tabs', () => {
    const host = mountShell(
      <Routine
        model={model()}
        onClose={() => undefined}
        onSetCategory={() => undefined}
      />,
    )

    try {
      expect(host.textContent).toContain('Routine')
      expect(host.textContent).toContain('All prisoners')
      expect(host.textContent).toContain('Minimum Security')
      const cells = host.querySelectorAll('.bw-routine-cell')
      expect(cells.length).toBe(24)
    } finally {
      unmount(host)
    }
  })

  it('shows conflicts when present', () => {
    const host = mountShell(
      <Routine
        model={model()}
        onClose={() => undefined}
        onSetCategory={() => undefined}
      />,
    )

    try {
      expect(host.textContent).toContain('Conflicts')
      expect(host.textContent).toContain('Meal overlap at 12:00')
    } finally {
      unmount(host)
    }
  })

  it('renders closed when model is null', () => {
    const host = mountShell(
      <Routine
        model={null}
        onClose={() => undefined}
        onSetCategory={() => undefined}
      />,
    )

    try {
      const panel = host.querySelector('.bw-routine-panel')
      expect(panel?.getAttribute('data-open')).toBe('false')
    } finally {
      unmount(host)
    }
  })
})
