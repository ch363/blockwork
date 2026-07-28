/**
 * @vitest-environment happy-dom
 */

import { describe, expect, it } from 'vitest'

import { Trace } from '../../src/panels/Trace'
import type { TraceModel } from '../../src/panels/Trace'
import { mountShell, unmount } from '../helpers/mount'

function sampleModel(): TraceModel {
  return {
    rootId: 5,
    headline: 'Inmate 4471 starved to death',
    subtitle: 'Day 28, 03:12',
    nodes: [
      {
        eventId: 5,
        subjectId: 4471,
        title: 'Inmate 4471 starved to death',
        detail: 'Food need held above 95 for 41 continuous in-game hours.',
        meta: 'Day 28 · 03:12 · cell A-14',
        isRootCause: false,
        isFirst: true,
      },
      {
        eventId: 1,
        subjectId: 2002,
        title: 'Kitchen K2 has 2 cookers and 1 assigned cook',
        detail: 'Capacity is 30 meals per hour.',
        meta: 'Root cause',
        isRootCause: true,
        isFirst: false,
      },
    ],
    fixes: [
      { id: 'add_cookers', label: 'Add 4 cookers · $2,800' },
      { id: 'assign_cooks', label: 'Assign 3 more inmates to kitchen work' },
    ],
    reportText: 'Inmate 4471 starved to death\n  <- Kitchen K2 has 2 cookers',
  }
}

describe('Trace panel', () => {
  it('renders the timeline, focus targets, and fix buttons', () => {
    const focused: number[] = []
    const fixes: string[] = []
    const host = mountShell(
      <Trace
        model={sampleModel()}
        onClose={() => undefined}
        onNodeFocus={(node) => {
          focused.push(node.subjectId)
        }}
        onFix={(fix) => {
          fixes.push(fix.id)
        }}
      />,
    )

    expect(host.querySelector('.bw-trace-panel')?.getAttribute('data-open')).toBe('true')
    expect(host.textContent).toContain('Why did this happen?')
    expect(host.textContent).toContain('Inmate 4471 starved to death')
    expect(host.textContent).toContain('Add 4 cookers')

    const nodes = host.querySelectorAll('.bw-tnode')
    expect(nodes.length).toBe(2)
    ;(nodes[1] as HTMLButtonElement).click()
    expect(focused).toEqual([2002])

    const buttons = [...host.querySelectorAll('.bw-fixes .bw-btn')] as HTMLButtonElement[]
    buttons[0]?.click()
    expect(fixes).toEqual(['add_cookers'])

    unmount(host)
  })

  it('hides when model is null', () => {
    const host = mountShell(
      <Trace
        model={null}
        onClose={() => undefined}
        onNodeFocus={() => undefined}
        onFix={() => undefined}
      />,
    )
    expect(host.querySelector('.bw-trace-panel')?.getAttribute('data-open')).toBe('false')
    unmount(host)
  })
})
