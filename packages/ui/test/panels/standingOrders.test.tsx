/**
 * @vitest-environment happy-dom
 */

import { describe, expect, it } from 'vitest'

import {
  StandingOrders,
  formatDuration,
  MISCONDUCT_LABELS,
} from '../../src/panels/StandingOrders'
import type { StandingOrdersModel } from '../../src/panels/StandingOrders'
import { mountShell, unmount } from '../helpers/mount'

function sampleModel(): StandingOrdersModel {
  return {
    strictness: 'lenient',
    mealQuantity: 'normal',
    mealVariety: 2,
    maxMealVariety: 5,
    projection: {
      meanSuppressionFrom: 44,
      meanSuppressionTo: 51,
      misconductPerDayFrom: 31,
      misconductPerDayTo: 22,
      programmeParticipationFrom: 61,
      programmeParticipationTo: 48,
      reoffendFrom: 41,
      reoffendTo: 47,
      isolationCells: 12,
      isolationOccupied: 11,
      isolationProjectedPeak: 19,
    },
    rows: [
      {
        misconduct: 'complaint',
        label: MISCONDUCT_LABELS['complaint'] ?? 'Complaint',
        punishment: 'ignore',
        durationHours: 0,
        search: false,
      },
      {
        misconduct: 'contraband',
        label: MISCONDUCT_LABELS['contraband'] ?? 'Contraband found',
        punishment: 'lockdown',
        durationHours: 6,
        search: true,
      },
      {
        misconduct: 'homicide',
        label: MISCONDUCT_LABELS['homicide'] ?? 'Homicide',
        punishment: 'isolation',
        durationHours: -1,
        search: true,
      },
    ],
  }
}

describe('Standing Orders panel', () => {
  it('renders the misconduct matrix and projected effect', () => {
    const punishments: string[] = []
    const host = mountShell(
      <StandingOrders
        model={sampleModel()}
        tab="punishment"
        onTab={() => undefined}
        onClose={() => undefined}
        onPunishment={(misconduct, punishment) => {
          punishments.push(`${misconduct}:${punishment}`)
        }}
      />,
    )

    expect(host.querySelector('.bw-orders-panel')?.getAttribute('data-open')).toBe('true')
    expect(host.textContent).toContain('Standing Orders')
    expect(host.textContent).toContain('Complaint')
    expect(host.textContent).toContain('Contraband found')
    expect(host.textContent).toContain('Mean suppression')
    expect(host.textContent).toContain('Isolation capacity')

    const responseButtons = [
      ...host.querySelectorAll('.bw-orders-matrix tbody tr:first-child .bw-radio-seg button'),
    ] as HTMLButtonElement[]
    expect(responseButtons.length).toBe(3)
    responseButtons[2]?.click()
    expect(punishments).toEqual(['complaint:isolation'])

    unmount(host)
  })

  it('switches to meals and adjusts variety', () => {
    let tab = 'punishment'
    let variety = 2
    const host = mountShell(
      <StandingOrders
        model={{ ...sampleModel(), mealVariety: variety }}
        tab="meals"
        onTab={(next) => {
          tab = next
        }}
        onClose={() => undefined}
        onMealVariety={(next) => {
          variety = next
        }}
      />,
    )

    expect(host.textContent).toContain('Meal policy')
    expect(host.textContent).toContain('2 ingredients')
    const increase = host.querySelector(
      'button[aria-label="Increase variety"]',
    ) as HTMLButtonElement | null
    increase?.click()
    expect(variety).toBe(3)

    const tabs = [...host.querySelectorAll('.bw-orders-head .bw-seg button')] as HTMLButtonElement[]
    tabs[0]?.click()
    expect(tab).toBe('punishment')

    unmount(host)
  })

  it('hides when model is null', () => {
    const host = mountShell(
      <StandingOrders
        model={null}
        tab="punishment"
        onTab={() => undefined}
        onClose={() => undefined}
      />,
    )
    expect(host.querySelector('.bw-orders-panel')?.getAttribute('data-open')).toBe('false')
    unmount(host)
  })
})

describe('formatDuration', () => {
  it('formats n/a, hours and indefinite', () => {
    expect(formatDuration(0, 'ignore')).toBe('n/a')
    expect(formatDuration(6, 'lockdown')).toBe('6 hours')
    expect(formatDuration(-1, 'isolation')).toBe('Indefinite')
  })
})
