/**
 * @vitest-environment happy-dom
 */

import { describe, expect, it } from 'vitest'

import { Emergency } from '../../src/panels/Emergency'
import type { EmergencyModel } from '../../src/panels/Emergency'
import { mountShell, unmount } from '../helpers/mount'

function sampleModel(): EmergencyModel {
  return {
    danger: 72,
    riotActive: true,
    riotingCount: 14,
    containmentQuietMinutes: 3,
    containmentNeededMinutes: 10,
    failureWarning: true,
    failureAtTick: 7200,
    playerFired: false,
    riotSquadHourlyCost: 600,
    nationalGuardCost: 75000,
    selectedSectorId: 1,
    selectedSectorName: 'West wing',
    levels: [
      {
        id: 'sector_lockdown',
        level: 1,
        label: 'Sector lockdown',
        costLabel: 'Free',
        sideEffect: '+suppression in that sector',
        active: false,
        disabled: false,
        disabledReason: null,
      },
      {
        id: 'full_lockdown',
        level: 2,
        label: 'Full lockdown',
        costLabel: 'Free',
        sideEffect: '+suppression prison-wide, needs go unmet',
        active: true,
        disabled: false,
        disabledReason: null,
      },
      {
        id: 'riot_squad',
        level: 3,
        label: 'Call in riot squad',
        costLabel: '$600/hour',
        sideEffect: 'Injuries, +fear',
        active: false,
        disabled: false,
        disabledReason: null,
      },
      {
        id: 'free_fire',
        level: 4,
        label: 'Free fire authorisation',
        costLabel: 'Free',
        sideEffect: 'Deaths, huge re-offending and PR penalty',
        active: false,
        disabled: false,
        disabledReason: null,
      },
      {
        id: 'national_guard',
        level: 5,
        label: 'Call the national guard',
        costLabel: '$75000',
        sideEffect: 'Prison retaken; you are almost certainly fired',
        active: false,
        disabled: false,
        disabledReason: null,
      },
    ],
  }
}

describe('Emergency panel', () => {
  it('renders the five-level ladder and status', () => {
    const called: string[] = []
    const host = mountShell(
      <Emergency
        model={sampleModel()}
        onClose={() => undefined}
        onFullLockdown={() => {
          called.push('full')
        }}
        onCallRiotSquad={() => {
          called.push('squad')
        }}
      />,
    )

    try {
      const root = host.querySelector('.bw-emergency-panel')
      expect(root?.getAttribute('data-open')).toBe('true')
      expect(host.textContent).toContain('Emergency')
      expect(host.textContent).toContain('14 rioting')
      expect(host.textContent).toContain('Sector lockdown')
      expect(host.textContent).toContain('Call the national guard')
      expect(host.textContent).toContain('Directorate warning')

      const squad = [...host.querySelectorAll('button')].find((b) =>
        (b.textContent ?? '').includes('Call squad'),
      )
      expect(squad).toBeDefined()
      squad!.click()
      expect(called).toEqual(['squad'])
    } finally {
      unmount(host)
    }
  })
})
