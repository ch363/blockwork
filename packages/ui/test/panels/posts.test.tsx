/**
 * @vitest-environment happy-dom
 */

import { describe, expect, it } from 'vitest'

import { Posts, unfilledReasonLabel } from '../../src/panels/Posts'
import type { PostsModel } from '../../src/panels/Posts'
import { mountShell, unmount } from '../helpers/mount'

function sampleModel(): PostsModel {
  return {
    unfilledCount: 2,
    deployedCount: 5,
    hiredOfficers: 5,
    peakRequired: 7,
    peakWindow: '12:00 to 13:00',
    hireSuggestion: 2,
    hireCost: 800,
    hireWagePerHour: 60,
    posts: [
      {
        id: 1,
        name: 'West Hall',
        detail: 'Meal blocks · 07:00, 12:00, 18:00',
        filled: 3,
        required: 3,
        shortfallReason: null,
      },
      {
        id: 2,
        name: 'Yard',
        detail: 'Yard blocks · 10:00 to 12:00',
        filled: 1,
        required: 3,
        shortfallReason: 'not enough staff hired',
      },
    ],
    patrols: [
      {
        id: 1,
        name: 'C Wing corridor',
        detail: 'Continuous patrol',
        filled: 1,
        required: 2,
        shortfallReason: 'none reachable',
      },
    ],
    sectors: [
      {
        id: 1,
        name: 'Maximum wing',
        colour: '#c44',
        access: 'secure',
        categories: 'maximum',
        tileCount: 48,
      },
    ],
  }
}

describe('Posts panel', () => {
  it('renders unfilled badge, post rows, and hire suggestion', () => {
    const selected: number[] = []
    const hired: string[] = []
    const host = mountShell(
      <Posts
        model={sampleModel()}
        tab="posts"
        onTab={() => undefined}
        onClose={() => undefined}
        onSelectPost={(id) => {
          selected.push(id)
        }}
        onHireSuggested={() => {
          hired.push('hire')
        }}
      />,
    )

    expect(host.querySelector('.bw-posts-panel')?.getAttribute('data-open')).toBe('true')
    expect(host.textContent).toContain('2 unfilled')
    expect(host.textContent).toContain('West Hall')
    expect(host.textContent).toContain('not enough staff hired')
    expect(host.textContent).toContain('Hire 2 officers')

    const rows = [...host.querySelectorAll('.bw-postrow')] as HTMLButtonElement[]
    expect(rows.length).toBe(2)
    rows[1]?.click()
    expect(selected).toEqual([2])

    const hire = [...host.querySelectorAll('.bw-posts-hire .bw-btn')] as HTMLButtonElement[]
    hire[0]?.click()
    expect(hired).toEqual(['hire'])

    unmount(host)
  })

  it('switches to sector access and lists sectors', () => {
    let tab = 'posts'
    const host = mountShell(
      <Posts
        model={sampleModel()}
        tab="sectors"
        onTab={(next) => {
          tab = next
        }}
        onClose={() => undefined}
      />,
    )

    expect(host.textContent).toContain('Maximum wing')
    expect(host.textContent).toContain('secure')
    expect(host.textContent).toContain('maximum')

    const tabs = [...host.querySelectorAll('.bw-posts-head .bw-seg button')] as HTMLButtonElement[]
    tabs[0]?.click()
    expect(tab).toBe('posts')

    unmount(host)
  })

  it('hides when model is null', () => {
    const host = mountShell(
      <Posts model={null} tab="posts" onTab={() => undefined} onClose={() => undefined} />,
    )
    expect(host.querySelector('.bw-posts-panel')?.getAttribute('data-open')).toBe('false')
    unmount(host)
  })
})

describe('unfilledReasonLabel', () => {
  it('maps sim reason codes to player-facing copy', () => {
    expect(unfilledReasonLabel('no-staff-hired')).toBe('not enough staff hired')
    expect(unfilledReasonLabel('unreachable')).toBe('none reachable')
    expect(unfilledReasonLabel('all-staff-busy')).toBe('all staff busy')
    expect(unfilledReasonLabel(null)).toBeNull()
  })
})
