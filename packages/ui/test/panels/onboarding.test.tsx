/**
 * @vitest-environment happy-dom
 */

import { describe, expect, it } from 'vitest'

import {
  COACH_BUBBLE_MARGIN,
  COACH_BUBBLE_WIDTH,
  Onboarding,
  placeBubble,
} from '../../src/panels/Onboarding'
import type { OnboardingModel } from '../../src/panels/Onboarding'
import { mountShell, unmount } from '../helpers/mount'

function sampleModel(patch: Partial<OnboardingModel> = {}): OnboardingModel {
  return {
    mode: 'guided',
    contractName: 'Fit for Purpose',
    viewport: { width: 1194, height: 834 },
    objectives: [
      { index: 0, label: 'Build 8 cells', done: true, current: false },
      { index: 1, label: 'Build a mess hall', done: false, current: true },
      { index: 2, label: 'Build a kitchen', done: false, current: false },
    ],
    marks: [],
    ...patch,
  }
}

describe('Onboarding checklist', () => {
  it('shows the contract objectives and what is left', () => {
    const host = mountShell(
      <Onboarding model={sampleModel()} onSkip={() => undefined} onDismissMark={() => undefined} />,
    )

    try {
      expect(host.textContent).toContain('Fit for Purpose')
      expect(host.textContent).toContain('2 of 3 to go')
      expect(host.querySelectorAll('.bw-onboarding-list li')).toHaveLength(3)
      expect(host.querySelectorAll('.bw-onboarding-list li[data-done="true"]')).toHaveLength(1)
      expect(host.querySelectorAll('.bw-onboarding-list li[data-current="true"]')).toHaveLength(1)
    } finally {
      unmount(host)
    }
  })

  it('renders nothing at all once skipped', () => {
    const host = mountShell(
      <Onboarding
        model={sampleModel({ mode: 'off' })}
        onSkip={() => undefined}
        onDismissMark={() => undefined}
      />,
    )

    try {
      expect(host.querySelector('.bw-onboarding')).toBeNull()
      expect(host.querySelector('.bw-coach')).toBeNull()
    } finally {
      unmount(host)
    }
  })

  it('skips on request', () => {
    let skipped = 0
    const host = mountShell(
      <Onboarding
        model={sampleModel()}
        onSkip={() => {
          skipped += 1
        }}
        onDismissMark={() => undefined}
      />,
    )

    try {
      const skip = host.querySelector<HTMLButtonElement>('[aria-label="Skip the guide"]')
      skip?.click()
      expect(skipped).toBe(1)
    } finally {
      unmount(host)
    }
  })

  it('offers veteran mode from guided, and not from veteran', () => {
    const chosen: string[] = []
    const host = mountShell(
      <Onboarding
        model={sampleModel()}
        onSkip={() => undefined}
        onDismissMark={() => undefined}
        onMode={(mode) => {
          chosen.push(mode)
        }}
      />,
    )

    try {
      const button = [...host.querySelectorAll('button')].find((b) =>
        (b.textContent ?? '').includes('Show me everything'),
      )
      button?.click()
      expect(chosen).toEqual(['veteran'])
    } finally {
      unmount(host)
    }

    const veteran = mountShell(
      <Onboarding
        model={sampleModel({ mode: 'veteran' })}
        onSkip={() => undefined}
        onDismissMark={() => undefined}
        onMode={() => undefined}
      />,
    )
    try {
      expect(
        [...veteran.querySelectorAll('button')].find((b) =>
          (b.textContent ?? '').includes('Show me everything'),
        ),
      ).toBeUndefined()
    } finally {
      unmount(veteran)
    }
  })

  it('says so when everything is done', () => {
    const done = sampleModel({
      objectives: [
        { index: 0, label: 'Build 8 cells', done: true, current: false },
        { index: 1, label: 'Build a mess hall', done: true, current: false },
      ],
    })
    const host = mountShell(
      <Onboarding model={done} onSkip={() => undefined} onDismissMark={() => undefined} />,
    )
    try {
      expect(host.textContent).toContain('All objectives met')
    } finally {
      unmount(host)
    }
  })
})

describe('coach marks', () => {
  it('renders a bubble pointing at its anchor', () => {
    const model = sampleModel({
      marks: [
        {
          objectiveIndex: 1,
          title: 'Designate the room',
          body: 'Walls first, then Rooms.',
          anchorRect: { x: 400, y: 700, width: 56, height: 56 },
        },
      ],
    })
    const host = mountShell(
      <Onboarding model={model} onSkip={() => undefined} onDismissMark={() => undefined} />,
    )

    try {
      const bubble = host.querySelector<HTMLElement>('.bw-coach')
      expect(bubble).not.toBeNull()
      expect(host.textContent).toContain('Designate the room')
      // The dock is at the bottom, so the bubble goes above it.
      expect(bubble?.getAttribute('data-side')).toBe('above')
    } finally {
      unmount(host)
    }
  })

  it('dismisses a mark', () => {
    const dismissed: number[] = []
    const model = sampleModel({
      marks: [
        {
          objectiveIndex: 1,
          title: 'Designate the room',
          body: 'Walls first.',
          anchorRect: null,
        },
      ],
    })
    const host = mountShell(
      <Onboarding
        model={model}
        onSkip={() => undefined}
        onDismissMark={(index) => {
          dismissed.push(index)
        }}
      />,
    )

    try {
      const got = [...host.querySelectorAll('button')].find((b) =>
        (b.textContent ?? '').includes('Got it'),
      )
      got?.click()
      expect(dismissed).toEqual([1])
    } finally {
      unmount(host)
    }
  })

  it('shows every outstanding mark in veteran mode', () => {
    const model = sampleModel({
      mode: 'veteran',
      marks: [
        { objectiveIndex: 1, title: 'One', body: 'a', anchorRect: null },
        { objectiveIndex: 2, title: 'Two', body: 'b', anchorRect: null },
      ],
    })
    const host = mountShell(
      <Onboarding model={model} onSkip={() => undefined} onDismissMark={() => undefined} />,
    )

    try {
      expect(host.querySelectorAll('.bw-coach')).toHaveLength(2)
    } finally {
      unmount(host)
    }
  })
})

describe('bubble placement', () => {
  const viewport = { width: 1194, height: 834 }

  it('centres over the anchor and sits above it', () => {
    const placement = placeBubble({ x: 500, y: 700, width: 56, height: 56 }, viewport, 120)
    expect(placement.side).toBe('above')
    expect(placement.left).toBe(500 + 28 - COACH_BUBBLE_WIDTH / 2)
    expect(placement.top).toBe(700 - 120 - COACH_BUBBLE_MARGIN)
  })

  it('drops below when there is no room above', () => {
    const placement = placeBubble({ x: 500, y: 8, width: 56, height: 56 }, viewport, 120)
    expect(placement.side).toBe('below')
    expect(placement.top).toBe(8 + 56 + COACH_BUBBLE_MARGIN)
  })

  it('keeps the bubble on screen at either edge', () => {
    const left = placeBubble({ x: 0, y: 700, width: 40, height: 40 }, viewport, 120)
    expect(left.left).toBeGreaterThanOrEqual(COACH_BUBBLE_MARGIN)

    const right = placeBubble({ x: 1180, y: 700, width: 40, height: 40 }, viewport, 120)
    expect(right.left + COACH_BUBBLE_WIDTH).toBeLessThanOrEqual(viewport.width)
  })

  it('centres on screen when there is no anchor to point at', () => {
    const placement = placeBubble(null, viewport, 120)
    expect(placement.side).toBe('centre')
    expect(placement.left).toBe((viewport.width - COACH_BUBBLE_WIDTH) / 2)
  })
})
