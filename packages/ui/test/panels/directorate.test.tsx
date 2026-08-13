/**
 * @vitest-environment happy-dom
 */

import { describe, expect, it } from 'vitest'

import {
  DIRECTORATE_MAX_ZOOM,
  DIRECTORATE_MIN_ZOOM,
  Directorate,
  clampZoom,
  edgePath,
  formatDurationHours,
} from '../../src/panels/Directorate'
import type { DirectorateModel, DirectorateNodeModel } from '../../src/panels/Directorate'
import { mountShell, unmount } from '../helpers/mount'

function node(
  patch: Partial<DirectorateNodeModel> & { readonly id: string },
): DirectorateNodeModel {
  return {
    name: patch.id,
    branch: 'root',
    status: 'available',
    cost: 500,
    durationHours: 6,
    x: 0,
    y: 0,
    prerequisites: [],
    progress: 0,
    remainingLabel: null,
    pausedReason: null,
    summary: 'Does a thing.',
    why: 'Because a thing needs doing.',
    unlocks: [],
    administrator: 'Warden',
    administratorReady: true,
    blockers: [],
    ...patch,
  }
}

function sampleModel(selectedId: string | null = 'intelligence'): DirectorateModel {
  return {
    completeCount: 2,
    totalCount: 4,
    activeCount: 1,
    balance: 84_120,
    selectedId,
    nodes: [
      node({ id: 'security_office', name: 'Security Office', status: 'complete', x: 16, y: 40 }),
      node({
        id: 'intelligence',
        name: 'Intelligence',
        branch: 'security',
        status: 'active',
        cost: 1000,
        x: 240,
        y: 20,
        prerequisites: ['security_office'],
        progress: 0.31,
        remainingLabel: '4h 10m',
        unlocks: ['Intelligence panel', 'Informant recruitment'],
        administrator: 'Security Director',
        why: 'You are losing roughly 9 items of contraband a day and cannot see the source.',
      }),
      node({
        id: 'canine',
        name: 'Canine',
        branch: 'security',
        status: 'locked',
        cost: 1000,
        x: 240,
        y: 120,
        prerequisites: ['security_office'],
        administrator: 'Security Director',
        administratorReady: false,
        blockers: [
          { kind: 'prerequisite', sentence: 'Patrols must complete first.' },
          { kind: 'administrator', sentence: 'No Security Director is in post.' },
        ],
      }),
      node({
        id: 'tax_relief',
        name: 'Tax Relief',
        branch: 'finance',
        status: 'available',
        cost: 10_000,
        durationHours: 48,
        x: 240,
        y: 220,
      }),
    ],
  }
}

describe('Directorate panel', () => {
  it('renders the node graph, the branch filter, and the selected node detail', () => {
    const host = mountShell(
      <Directorate
        model={sampleModel()}
        branch="all"
        onBranch={() => undefined}
        onSelect={() => undefined}
        onClose={() => undefined}
      />,
    )

    try {
      const root = host.querySelector('.bw-directorate-panel')
      expect(root?.getAttribute('data-open')).toBe('true')
      expect(host.textContent).toContain('2 of 4 complete')
      expect(host.textContent).toContain('1 in progress')

      const nodes = host.querySelectorAll('.bw-directorate-node')
      expect(nodes).toHaveLength(4)
      expect(
        [...nodes].filter((element) => element.getAttribute('data-status') === 'complete'),
      ).toHaveLength(1)

      // Prerequisite edges are drawn, one per declared dependency.
      expect(host.querySelectorAll('.bw-directorate-edges path')).toHaveLength(2)

      // The detail sheet leads with the "why do I want this" copy (PRD 5.8).
      expect(host.textContent).toContain('Why you want this')
      expect(host.textContent).toContain('9 items of contraband a day')
      expect(host.textContent).toContain('Informant recruitment')
      expect(host.textContent).toContain('31% complete')
      expect(host.textContent).toContain('4h 10m remaining')
    } finally {
      unmount(host)
    }
  })

  it('names every blocker on a locked node rather than only greying it out', () => {
    const host = mountShell(
      <Directorate
        model={sampleModel('canine')}
        branch="all"
        onBranch={() => undefined}
        onSelect={() => undefined}
        onClose={() => undefined}
      />,
    )

    try {
      expect(host.textContent).toContain('Patrols must complete first.')
      expect(host.textContent).toContain('No Security Director is in post.')
      expect(host.textContent).toContain('Not available')
      // Locked nodes offer no start button.
      const start = [...host.querySelectorAll('button')].find((b) =>
        (b.textContent ?? '').includes('Begin research'),
      )
      expect(start).toBeUndefined()
    } finally {
      unmount(host)
    }
  })

  it('starts research from an available node', () => {
    const started: string[] = []
    const host = mountShell(
      <Directorate
        model={sampleModel('tax_relief')}
        branch="all"
        onBranch={() => undefined}
        onSelect={() => undefined}
        onClose={() => undefined}
        onStart={(id) => {
          started.push(id)
        }}
      />,
    )

    try {
      const start = [...host.querySelectorAll('button')].find((b) =>
        (b.textContent ?? '').includes('Begin research'),
      )
      expect(start?.textContent).toContain('$10,000')
      start?.click()
      expect(started).toEqual(['tax_relief'])
    } finally {
      unmount(host)
    }
  })

  it('filters to one branch while keeping the root nodes that explain it', () => {
    const chosen: string[] = []
    const host = mountShell(
      <Directorate
        model={sampleModel(null)}
        branch="security"
        onBranch={(branch) => {
          chosen.push(branch)
        }}
        onSelect={() => undefined}
        onClose={() => undefined}
      />,
    )

    try {
      const labels = [...host.querySelectorAll('.bw-directorate-node .nt')].map(
        (element) => element.textContent,
      )
      expect(labels).toEqual(['Security Office', 'Intelligence', 'Canine'])
      expect(host.textContent).toContain('Select a node')

      const finance = [...host.querySelectorAll('.bw-directorate-branches button')].find(
        (b) => b.textContent === 'Finance',
      )
      ;(finance as HTMLButtonElement | undefined)?.click()
      expect(chosen).toEqual(['finance'])
    } finally {
      unmount(host)
    }
  })

  it('selects a node when its card is tapped', () => {
    const selected: (string | null)[] = []
    const host = mountShell(
      <Directorate
        model={sampleModel(null)}
        branch="all"
        onBranch={() => undefined}
        onSelect={(id) => {
          selected.push(id)
        }}
        onClose={() => undefined}
      />,
    )

    try {
      const canine = [...host.querySelectorAll('.bw-directorate-node')].find((element) =>
        (element.textContent ?? '').includes('Canine'),
      )
      ;(canine as HTMLButtonElement | undefined)?.click()
      expect(selected).toEqual(['canine'])
    } finally {
      unmount(host)
    }
  })
})

describe('Directorate graph maths', () => {
  it('clamps zoom to the pinch range and survives nonsense', () => {
    expect(clampZoom(1)).toBe(1)
    expect(clampZoom(0.1)).toBe(DIRECTORATE_MIN_ZOOM)
    expect(clampZoom(9)).toBe(DIRECTORATE_MAX_ZOOM)
    expect(clampZoom(Number.NaN)).toBe(1)
  })

  it('joins nodes with a horizontal-tangent cubic from right edge to left edge', () => {
    const path = edgePath({ x: 0, y: 0 }, { x: 300, y: 100 })
    expect(path).toBe('M168,28 C234,28 234,128 300,128')
  })

  it('formats durations in hours and days', () => {
    expect(formatDurationHours(6)).toBe('6h')
    expect(formatDurationHours(48)).toBe('2d')
    expect(formatDurationHours(30)).toBe('1d 6h')
  })
})
