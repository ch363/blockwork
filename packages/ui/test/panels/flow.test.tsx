/**
 * @vitest-environment happy-dom
 */

import { describe, expect, it } from 'vitest'

import { Flow } from '../../src/panels/Flow'
import type { FlowModel } from '../../src/panels/Flow'
import { mountShell, unmount } from '../helpers/mount'

function model(): FlowModel {
  return {
    chains: [
      {
        id: 'meals',
        name: 'Meals',
        stages: [
          { id: 'delivery', name: 'Delivery', throughput: 100, capacity: 100, bottleneck: false, detail: '' },
          { id: 'storage', name: 'Storage', throughput: 95, capacity: 100, bottleneck: false, detail: '' },
          { id: 'kitchen', name: 'Kitchen', throughput: 50, capacity: 100, bottleneck: true, detail: 'Only 2 cookers available' },
          { id: 'serving', name: 'Serving', throughput: 50, capacity: 100, bottleneck: false, detail: '' },
        ],
        healthy: false,
        summary: 'Kitchen at 50% capacity - meals chain is constrained',
      },
      {
        id: 'laundry',
        name: 'Laundry',
        stages: [
          { id: 'collection', name: 'Collection', throughput: 80, capacity: 80, bottleneck: false, detail: '' },
          { id: 'washing', name: 'Washing', throughput: 80, capacity: 80, bottleneck: false, detail: '' },
          { id: 'distribution', name: 'Distribution', throughput: 75, capacity: 80, bottleneck: false, detail: '' },
        ],
        healthy: true,
        summary: 'Laundry chain operating normally',
      },
    ],
  }
}

describe('Flow', () => {
  it('renders chain tabs and stage nodes', () => {
    const host = mountShell(
      <Flow model={model()} onClose={() => undefined} />,
    )

    try {
      expect(host.textContent).toContain('Logistics flow')
      expect(host.textContent).toContain('Meals')
      expect(host.textContent).toContain('Laundry')
      expect(host.textContent).toContain('Delivery')
      expect(host.textContent).toContain('Storage')
      expect(host.textContent).toContain('Kitchen')
      expect(host.textContent).toContain('Serving')
    } finally {
      unmount(host)
    }
  })

  it('highlights bottleneck nodes', () => {
    const host = mountShell(
      <Flow model={model()} onClose={() => undefined} />,
    )

    try {
      const bottleneckNode = host.querySelector('.bw-flow-stage[data-bottleneck="true"]')
      expect(bottleneckNode).not.toBeNull()
      expect(bottleneckNode?.textContent).toContain('Kitchen')
      expect(bottleneckNode?.textContent).toContain('Bottleneck')
    } finally {
      unmount(host)
    }
  })

  it('shows chain summary with throughput details', () => {
    const host = mountShell(
      <Flow model={model()} onClose={() => undefined} />,
    )

    try {
      expect(host.textContent).toContain('Kitchen at 50% capacity')
    } finally {
      unmount(host)
    }
  })

  it('renders throughput values for each stage', () => {
    const host = mountShell(
      <Flow model={model()} onClose={() => undefined} />,
    )

    try {
      expect(host.textContent).toContain('100/hr')
      expect(host.textContent).toContain('50/hr')
    } finally {
      unmount(host)
    }
  })

  it('renders closed when model is null', () => {
    const host = mountShell(
      <Flow model={null} onClose={() => undefined} />,
    )

    try {
      const panel = host.querySelector('.bw-flow-panel')
      expect(panel?.getAttribute('data-open')).toBe('false')
    } finally {
      unmount(host)
    }
  })
})
