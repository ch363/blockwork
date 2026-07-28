/**
 * @vitest-environment happy-dom
 */

import { describe, expect, it } from 'vitest'

import { Intelligence, coverageOf, formatChance } from '../../src/panels/Intelligence'
import type { IntelligenceModel } from '../../src/panels/Intelligence'
import { mountShell, unmount } from '../helpers/mount'

function sampleModel(): IntelligenceModel {
  return {
    maxInformants: 12,
    sources: [
      { roomId: 1, roomName: 'Cell Block A', revealed: 3, actual: 4 },
      { roomId: 2, roomName: 'Workshop', revealed: 1, actual: 6 },
      { roomId: 3, roomName: 'Chapel', revealed: 0, actual: 0 },
    ],
    market: [
      { itemId: 'shiv', itemName: 'Shiv', price: 90, supply: 4, demand: 22 },
      { itemId: 'liquor', itemName: 'Liquor', price: 40, supply: 11, demand: 60 },
    ],
    informants: [
      {
        inmateId: 11,
        name: 'Inmate 11',
        blown: false,
        revealCount: 7,
        coverageRadius: 8,
        blowChance: 0.06,
        carelesslyHandled: false,
      },
      {
        inmateId: 12,
        name: 'Inmate 12',
        blown: true,
        revealCount: 2,
        coverageRadius: 8,
        blowChance: 0.26,
        carelesslyHandled: true,
      },
    ],
    reputations: [
      { inmateId: 21, inmateName: 'Inmate 21', reputationName: 'Supplier' },
      { inmateId: 22, inmateName: 'Inmate 22', reputationName: 'Notorious' },
    ],
    recruitCandidate: null,
  }
}

describe('Intelligence panel', () => {
  it('shows what is known against what is there', () => {
    const host = mountShell(
      <Intelligence
        model={sampleModel()}
        tab="sources"
        onTab={() => undefined}
        onClose={() => undefined}
      />,
    )

    try {
      expect(host.querySelector('.bw-intel-panel')?.getAttribute('data-open')).toBe('true')
      expect(host.textContent).toContain('1 of 12 informants active')
      expect(host.textContent).toContain('Cell Block A')
      expect(host.textContent).toContain('75%')
      // A room with nothing in it is "clear", not "100% covered".
      expect(host.textContent).toContain('clear')
      // Thin coverage is flagged.
      expect(host.querySelectorAll('[data-thin="true"]')).toHaveLength(1)
    } finally {
      unmount(host)
    }
  })

  it('lists the market with price, supply and demand', () => {
    const host = mountShell(
      <Intelligence
        model={sampleModel()}
        tab="market"
        onTab={() => undefined}
        onClose={() => undefined}
      />,
    )

    try {
      expect(host.textContent).toContain('Shiv')
      expect(host.textContent).toContain('$90')
      expect(host.textContent).toContain('Liquor')
    } finally {
      unmount(host)
    }
  })

  it('shows the roster with coverage and risk, and marks the blown one', () => {
    const focused: number[] = []
    const host = mountShell(
      <Intelligence
        model={sampleModel()}
        tab="informants"
        onTab={() => undefined}
        onClose={() => undefined}
        onFocusInformant={(id) => {
          focused.push(id)
        }}
      />,
    )

    try {
      expect(host.textContent).toContain('8 tile radius')
      expect(host.textContent).toContain('6% risk today')
      expect(host.textContent).toContain('Blown — a target')
      expect(
        host.querySelectorAll('.bw-intel-informant[data-blown="true"]'),
      ).toHaveLength(1)

      const first = host.querySelector('.bw-intel-informant')
      ;(first as HTMLButtonElement | null)?.click()
      expect(focused).toEqual([11])
    } finally {
      unmount(host)
    }
  })

  it('lists revealed reputations', () => {
    const host = mountShell(
      <Intelligence
        model={sampleModel()}
        tab="reputations"
        onTab={() => undefined}
        onClose={() => undefined}
      />,
    )

    try {
      expect(host.textContent).toContain('Inmate 21')
      expect(host.textContent).toContain('Supplier')
    } finally {
      unmount(host)
    }
  })

  it('offers to turn a candidate, or says why not', () => {
    const recruited: number[] = []
    const willing = {
      ...sampleModel(),
      recruitCandidate: {
        inmateId: 31,
        name: 'Inmate 31',
        loyalty: 30,
        fear: 70,
        cost: 250,
        refusal: null,
      },
    }
    const host = mountShell(
      <Intelligence
        model={willing}
        tab="informants"
        onTab={() => undefined}
        onClose={() => undefined}
        onRecruit={(id) => {
          recruited.push(id)
        }}
      />,
    )

    try {
      const turn = [...host.querySelectorAll('button')].find((b) =>
        (b.textContent ?? '').includes('Turn'),
      )
      expect(turn?.textContent).toContain('$250')
      turn?.click()
      expect(recruited).toEqual([31])
    } finally {
      unmount(host)
    }

    const refusing = {
      ...sampleModel(),
      recruitCandidate: {
        inmateId: 32,
        name: 'Inmate 32',
        loyalty: 95,
        fear: 10,
        cost: 250,
        refusal: 'Too loyal to the wing to turn.',
      },
    }
    const second = mountShell(
      <Intelligence
        model={refusing}
        tab="informants"
        onTab={() => undefined}
        onClose={() => undefined}
      />,
    )
    try {
      expect(second.textContent).toContain('Too loyal to the wing to turn.')
      expect(
        [...second.querySelectorAll('button')].find((b) =>
          (b.textContent ?? '').includes('Turn'),
        ),
      ).toBeUndefined()
    } finally {
      unmount(second)
    }
  })

  it('switches tab', () => {
    const chosen: string[] = []
    const host = mountShell(
      <Intelligence
        model={sampleModel()}
        tab="sources"
        onTab={(next) => {
          chosen.push(next)
        }}
        onClose={() => undefined}
      />,
    )

    try {
      const market = [...host.querySelectorAll('.bw-intel-tabs button')].find(
        (b) => b.textContent === 'Market',
      )
      ;(market as HTMLButtonElement | undefined)?.click()
      expect(chosen).toEqual(['market'])
    } finally {
      unmount(host)
    }
  })
})

describe('intelligence copy helpers', () => {
  it('formats a chance as a whole percentage', () => {
    expect(formatChance(0)).toBe('0%')
    expect(formatChance(0.064)).toBe('6%')
    expect(formatChance(1)).toBe('100%')
  })

  it('answers null for a room with nothing in it', () => {
    expect(coverageOf({ roomId: 1, roomName: 'x', revealed: 0, actual: 0 })).toBeNull()
    expect(coverageOf({ roomId: 1, roomName: 'x', revealed: 2, actual: 4 })).toBe(0.5)
  })
})
