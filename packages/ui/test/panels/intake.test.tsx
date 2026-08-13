/**
 * @vitest-environment happy-dom
 */

import { describe, expect, it } from 'vitest'

import { Intake } from '../../src/panels/Intake'
import type { IntakeModel } from '../../src/panels/Intake'
import { mountShell, unmount } from '../helpers/mount'

function model(): IntakeModel {
  return {
    continuous: true,
    categories: [
      { id: 'min_sec', name: 'Minimum Security', requested: 5, locked: false, lockReason: null },
      { id: 'med_sec', name: 'Medium Security', requested: 0, locked: false, lockReason: null },
      { id: 'max_sec', name: 'Maximum Security', requested: 2, locked: true, lockReason: 'Research required' },
    ],
    capacityModel: {
      population: 12,
      capacity: 50,
      housing: {
        cells: 20,
        dormitories: 25,
        holdingPens: 5,
      },
    },
    nextBusLabel: 'in 2 hours',
    nextBusTick: 1200,
  }
}

describe('Intake', () => {
  it('renders category rows with request counts', () => {
    const host = mountShell(
      <Intake
        model={model()}
        onClose={() => undefined}
        onSetContinuous={() => undefined}
        onSetRequested={() => undefined}
        onClearRequested={() => undefined}
      />,
    )

    try {
      expect(host.textContent).toContain('Intake')
      expect(host.textContent).toContain('Minimum Security')
      expect(host.textContent).toContain('Medium Security')
      expect(host.textContent).toContain('Maximum Security')
    } finally {
      unmount(host)
    }
  })

  it('shows capacity readout', () => {
    const host = mountShell(
      <Intake
        model={model()}
        onClose={() => undefined}
        onSetContinuous={() => undefined}
        onSetRequested={() => undefined}
        onClearRequested={() => undefined}
      />,
    )

    try {
      expect(host.textContent).toContain('12/50')
      expect(host.textContent).toContain('Housing capacity')
    } finally {
      unmount(host)
    }
  })

  it('shows next bus ETA', () => {
    const host = mountShell(
      <Intake
        model={model()}
        onClose={() => undefined}
        onSetContinuous={() => undefined}
        onSetRequested={() => undefined}
        onClearRequested={() => undefined}
      />,
    )

    try {
      expect(host.textContent).toContain('in 2 hours')
    } finally {
      unmount(host)
    }
  })

  it('renders closed when model is null', () => {
    const host = mountShell(
      <Intake
        model={null}
        onClose={() => undefined}
        onSetContinuous={() => undefined}
        onSetRequested={() => undefined}
        onClearRequested={() => undefined}
      />,
    )

    try {
      const panel = host.querySelector('.bw-intake-panel')
      expect(panel?.getAttribute('data-open')).toBe('false')
    } finally {
      unmount(host)
    }
  })
})
