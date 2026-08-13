/**
 * @vitest-environment happy-dom
 */

import { describe, expect, it } from 'vitest'

import { Alerts, countLabel } from '../../src/panels/Alerts'
import type { AlertRowModel, AlertsModel } from '../../src/panels/Alerts'
import { mountShell, unmount } from '../helpers/mount'

/** Sets a checkbox and fires the change the component listens for. */
function toggleCheckbox(input: HTMLInputElement | null | undefined, checked: boolean): void {
  if (input === null || input === undefined) throw new Error('checkbox not found')
  input.checked = checked
  input.dispatchEvent(new Event('change', { bubbles: true }))
}

function row(patch: Partial<AlertRowModel> & { readonly id: number }): AlertRowModel {
  return {
    severity: 'warn',
    category: 'fire',
    categoryLabel: 'Fire',
    title: 'Fire spreading',
    detail: 'Cell block A',
    count: 1,
    traceId: 100 + patch.id,
    timeLabel: '14:20',
    ...patch,
  }
}

function sampleModel(): AlertsModel {
  return {
    autoPauseOnCritical: false,
    filter: null,
    rows: [
      row({ id: 1, severity: 'critical', title: 'Inmate died', category: 'combat', count: 1 }),
      row({ id: 2, severity: 'warn', title: 'Fire spreading', count: 6 }),
      row({ id: 3, severity: 'info', title: 'Truck arrived', category: 'logistics', traceId: 0 }),
    ],
    categories: [
      { id: 'fire', label: 'Fire', muted: false, total: 12 },
      { id: 'riot', label: 'Riots', muted: true, total: 2 },
      { id: 'combat', label: 'Combat', muted: false, total: 5 },
    ],
  }
}

describe('Alerts panel', () => {
  it('lists the history with grouped counts', () => {
    const host = mountShell(
      <Alerts model={sampleModel()} onClose={() => undefined} onFilter={() => undefined} />,
    )

    try {
      expect(host.querySelector('.bw-alerts-panel')?.getAttribute('data-open')).toBe('true')
      expect(host.querySelectorAll('.bw-alerts-row')).toHaveLength(3)
      // A collapsed group shows its count; a single does not.
      expect(host.textContent).toContain('×6')
      expect(host.textContent).toContain('Inmate died')
      expect(host.textContent).toContain('3 shown')
      expect(host.textContent).toContain('1 muted')
    } finally {
      unmount(host)
    }
  })

  it('filters by severity', () => {
    const model = { ...sampleModel(), filter: 'critical' as const }
    const host = mountShell(
      <Alerts model={model} onClose={() => undefined} onFilter={() => undefined} />,
    )

    try {
      const rows = host.querySelectorAll('.bw-alerts-row')
      expect(rows).toHaveLength(1)
      expect(host.textContent).toContain('Inmate died')
      expect(host.textContent).not.toContain('Fire spreading')
    } finally {
      unmount(host)
    }
  })

  it('changes the filter', () => {
    const chosen: (string | null)[] = []
    const host = mountShell(
      <Alerts
        model={sampleModel()}
        onClose={() => undefined}
        onFilter={(severity) => {
          chosen.push(severity)
        }}
      />,
    )

    try {
      const warnings = [...host.querySelectorAll('.bw-alerts-filters button')].find(
        (b) => b.textContent === 'Warnings',
      )
      ;(warnings as HTMLButtonElement | undefined)?.click()
      expect(chosen).toEqual(['warn'])
    } finally {
      unmount(host)
    }
  })

  it('mutes a category', () => {
    const muted: [string, boolean][] = []
    const host = mountShell(
      <Alerts
        model={sampleModel()}
        onClose={() => undefined}
        onFilter={() => undefined}
        onMute={(category, next) => {
          muted.push([category, next])
        }}
      />,
    )

    try {
      const fire = host.querySelector<HTMLInputElement>('input[aria-label="Mute Fire"]')
      expect(fire?.checked).toBe(false)
      toggleCheckbox(fire, true)
      expect(muted).toEqual([['fire', true]])

      // The already-muted one renders checked.
      const riots = host.querySelector<HTMLInputElement>('input[aria-label="Mute Riots"]')
      expect(riots?.checked).toBe(true)
    } finally {
      unmount(host)
    }
  })

  it('toggles auto-pause', () => {
    const toggled: boolean[] = []
    const host = mountShell(
      <Alerts
        model={sampleModel()}
        onClose={() => undefined}
        onFilter={() => undefined}
        onAutoPause={(enabled) => {
          toggled.push(enabled)
        }}
      />,
    )

    try {
      expect(host.textContent).toContain('Pause the game on a critical alert')
      const checkbox = [...host.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')][0]
      toggleCheckbox(checkbox, true)
      expect(toggled).toEqual([true])
    } finally {
      unmount(host)
    }
  })

  it('opens the Trace for a row that has a chain, and disables one that does not', () => {
    const opened: number[] = []
    const host = mountShell(
      <Alerts
        model={sampleModel()}
        onClose={() => undefined}
        onFilter={() => undefined}
        onOpenTrace={(entry) => {
          opened.push(entry.id)
        }}
      />,
    )

    try {
      const rows = [...host.querySelectorAll<HTMLButtonElement>('.bw-alerts-row')]
      rows[0]?.click()
      expect(opened).toEqual([1])

      // The info row carries no chain, so there is nothing to open.
      expect(rows[2]?.disabled).toBe(true)
    } finally {
      unmount(host)
    }
  })

  it('says so when the filter leaves nothing', () => {
    const model: AlertsModel = { ...sampleModel(), rows: [], filter: null }
    const host = mountShell(
      <Alerts model={model} onClose={() => undefined} onFilter={() => undefined} />,
    )

    try {
      expect(host.textContent).toContain('Nothing to report.')
    } finally {
      unmount(host)
    }
  })
})

describe('alert count copy', () => {
  it('shows a count only when there is more than one', () => {
    expect(countLabel(1)).toBe('')
    expect(countLabel(2)).toBe('×2')
    expect(countLabel(37)).toBe('×37')
  })
})
