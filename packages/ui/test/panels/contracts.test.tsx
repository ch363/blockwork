/**
 * @vitest-environment happy-dom
 */

import { describe, expect, it } from 'vitest'

import { Contracts } from '../../src/panels/Contracts'
import type { ContractsModel } from '../../src/panels/Contracts'
import { mountShell, unmount } from '../helpers/mount'

function model(): ContractsModel {
  return {
    active: [
      {
        id: 'c1',
        name: 'Federal Holding',
        description: 'House 10 minimum security inmates.',
        advance: 5_000,
        completion: 10_000,
        progress: 0.4,
        todos: [
          { id: 't1', label: 'Build holding cell', done: true, current: '1', required: '1' },
          { id: 't2', label: 'Accept 10 inmates', done: false, current: '4', required: '10' },
        ],
        active: true,
        locked: false,
        lockReason: null,
      },
    ],
    available: [
      {
        id: 'c2',
        name: 'Workshop Grant',
        description: 'Establish a workshop program.',
        advance: 2_500,
        completion: 5_000,
        progress: 0,
        todos: [
          { id: 't3', label: 'Build workshop', done: false, current: '0', required: '1' },
          { id: 't4', label: 'Hire foreman', done: false, current: '0', required: '1' },
        ],
        active: false,
        locked: false,
        lockReason: null,
      },
    ],
    maxActive: 3,
    loan: {
      principal: 10_000,
      maxPrincipal: 50_000,
      interestRate: 0.05,
      creditRating: 7,
      available: true,
      availableReason: null,
    },
  }
}

describe('Contracts', () => {
  it('renders active and available contract cards', () => {
    const host = mountShell(
      <Contracts
        model={model()}
        onClose={() => undefined}
        onAccept={() => undefined}
        onCancel={() => undefined}
        onTakeLoan={() => undefined}
        onRepayLoan={() => undefined}
      />,
    )

    try {
      expect(host.textContent).toContain('Contracts')
      expect(host.textContent).toContain('Federal Holding')
      expect(host.textContent).toContain('Workshop Grant')
      expect(host.textContent).toContain('Active contracts')
      expect(host.textContent).toContain('Available contracts')
    } finally {
      unmount(host)
    }
  })

  it('shows loan controls in the detail panel', () => {
    const host = mountShell(
      <Contracts
        model={model()}
        onClose={() => undefined}
        onAccept={() => undefined}
        onCancel={() => undefined}
        onTakeLoan={() => undefined}
        onRepayLoan={() => undefined}
      />,
    )

    try {
      expect(host.textContent).toContain('Credit line')
      expect(host.textContent).toContain('$10,000')
    } finally {
      unmount(host)
    }
  })

  it('renders closed when model is null', () => {
    const host = mountShell(
      <Contracts
        model={null}
        onClose={() => undefined}
        onAccept={() => undefined}
        onCancel={() => undefined}
        onTakeLoan={() => undefined}
        onRepayLoan={() => undefined}
      />,
    )

    try {
      const panel = host.querySelector('.bw-contracts-panel')
      expect(panel?.getAttribute('data-open')).toBe('false')
    } finally {
      unmount(host)
    }
  })
})
