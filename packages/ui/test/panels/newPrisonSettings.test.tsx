/**
 * @vitest-environment happy-dom
 */

import { describe, expect, it } from 'vitest'

import { FUNDS_STOPS, NewPrison, formatFunds, isNoFailureMode } from '../../src/panels/NewPrison'
import type { NewPrisonModel, ToggleModel } from '../../src/panels/NewPrison'
import { Settings, percentLabel, typeScaleLabel } from '../../src/panels/Settings'
import type { SettingsModel } from '../../src/panels/Settings'
import { mountShell, unmount } from '../helpers/mount'

/** Sets a checkbox and fires the change the component listens for. */
function toggleCheckbox(input: HTMLInputElement | null | undefined, checked: boolean): void {
  if (input === null || input === undefined) throw new Error('checkbox not found')
  input.checked = checked
  input.dispatchEvent(new Event('change', { bubbles: true }))
}

/** Sets a text or range input and fires the input event. */
function setInputValue(input: HTMLInputElement | null | undefined, value: string): void {
  if (input === null || input === undefined) throw new Error('input not found')
  input.value = value
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

function toggles(ids: readonly string[], enabled: boolean): ToggleModel[] {
  return ids.map((id) => ({
    id,
    label: id,
    description: `What ${id} does`,
    enabled,
  }))
}

function newPrisonModel(patch: Partial<NewPrisonModel> = {}): NewPrisonModel {
  return {
    sizePreset: 'medium',
    sizes: [
      { id: 'small', label: 'Small', tiles: 100 },
      { id: 'medium', label: 'Medium', tiles: 160 },
      { id: 'large', label: 'Large', tiles: 220 },
      { id: 'huge', label: 'Huge', tiles: 300 },
    ],
    startingFunds: 30_000,
    continuousIntake: true,
    randomEvents: true,
    firstOrderGrace: true,
    seedInput: '',
    failures: toggles(['escapes', 'insolvency', 'deaths'], true),
    mutators: toggles(['fires', 'contraband'], true),
    ...patch,
  }
}

function noop(): void {
  // Intentionally empty.
}

function newPrison(model: NewPrisonModel, overrides: Partial<Record<string, unknown>> = {}) {
  return (
    <NewPrison
      model={model}
      onSize={noop}
      onStartingFunds={noop}
      onContinuousIntake={noop}
      onRandomEvents={noop}
      onFirstOrderGrace={noop}
      onSeed={noop}
      onFailure={noop}
      onMutator={noop}
      onStart={noop}
      onCancel={noop}
      {...overrides}
    />
  )
}

describe('New prison screen', () => {
  it('shows every choice on one screen', () => {
    const host = mountShell(newPrison(newPrisonModel()))

    try {
      expect(host.textContent).toContain('New prison')
      expect(host.textContent).toContain('160×160')
      expect(host.textContent).toContain(formatFunds(30_000))
      expect(host.textContent).toContain('Continuous intake')
      expect(host.textContent).toContain('Random events')
      expect(host.textContent).toContain('Starter deliveries')
      // Intake (3) + failure conditions (3) + mutators (2).
      expect(host.querySelectorAll('.bw-newprison-toggle')).toHaveLength(3 + 3 + 2)
    } finally {
      unmount(host)
    }
  })

  it('marks the chosen size and funds', () => {
    const host = mountShell(newPrison(newPrisonModel({ sizePreset: 'large' })))

    try {
      const chosen = host.querySelectorAll('.bw-newprison-sizes button[data-on="true"]')
      expect(chosen).toHaveLength(1)
      expect(chosen[0]?.textContent).toContain('Large')
    } finally {
      unmount(host)
    }
  })

  it('picks a size, a funds stop and a seed', () => {
    const sized: string[] = []
    const funded: number[] = []
    const seeded: string[] = []
    const host = mountShell(
      newPrison(newPrisonModel(), {
        onSize: (preset: string) => sized.push(preset),
        onStartingFunds: (amount: number) => funded.push(amount),
        onSeed: (input: string) => seeded.push(input),
      }),
    )

    try {
      const huge = [...host.querySelectorAll('.bw-newprison-sizes button')].find((b) =>
        (b.textContent ?? '').includes('Huge'),
      )
      ;(huge as HTMLButtonElement | undefined)?.click()
      expect(sized).toEqual(['huge'])

      const stop = [...host.querySelectorAll('.bw-newprison-funds button')].find(
        (b) => b.textContent === formatFunds(FUNDS_STOPS[4] ?? 0),
      )
      ;(stop as HTMLButtonElement | undefined)?.click()
      expect(funded).toEqual([FUNDS_STOPS[4]])

      const seed = host.querySelector<HTMLInputElement>('input[aria-label="Seed"]')
      setInputValue(seed, 'Alcatraz')
      expect(seeded).toEqual(['Alcatraz'])
    } finally {
      unmount(host)
    }
  })

  it('toggles a single failure condition', () => {
    const changed: [string, boolean][] = []
    const host = mountShell(
      newPrison(newPrisonModel(), {
        onFailure: (id: string, enabled: boolean) => changed.push([id, enabled]),
      }),
    )

    try {
      const escapes = host.querySelector<HTMLInputElement>('input[aria-label="escapes"]')
      toggleCheckbox(escapes, false)
      expect(changed).toEqual([['escapes', false]])
    } finally {
      unmount(host)
    }
  })

  it('says so when every failure condition is off (PRD 7.9)', () => {
    const off = newPrisonModel({ failures: toggles(['escapes', 'insolvency'], false) })
    expect(isNoFailureMode(off.failures)).toBe(true)

    const host = mountShell(newPrison(off))
    try {
      expect(host.textContent).toContain('cannot be lost')
    } finally {
      unmount(host)
    }

    const armed = mountShell(newPrison(newPrisonModel()))
    try {
      expect(armed.textContent).not.toContain('cannot be lost')
    } finally {
      unmount(armed)
    }
  })

  it('starts and cancels', () => {
    let started = 0
    let cancelled = 0
    const host = mountShell(
      newPrison(newPrisonModel(), {
        onStart: () => {
          started += 1
        },
        onCancel: () => {
          cancelled += 1
        },
      }),
    )

    try {
      const buttons = [...host.querySelectorAll('button')]
      buttons.find((b) => (b.textContent ?? '').includes('Open the prison'))?.click()
      buttons.find((b) => b.textContent === 'Cancel')?.click()
      expect(started).toBe(1)
      expect(cancelled).toBe(1)
    } finally {
      unmount(host)
    }
  })

  it('renders nothing when closed', () => {
    const host = mountShell(newPrison(null as never))
    try {
      expect(host.querySelector('.bw-newprison')).toBeNull()
    } finally {
      unmount(host)
    }
  })
})

function settingsModel(patch: Partial<SettingsModel> = {}): SettingsModel {
  return {
    music: 0.6,
    sfx: 0.8,
    muted: false,
    palette: 'default',
    paletteOptions: [
      { id: 'default', label: 'Default' },
      { id: 'deuteranopia', label: 'Deuteranopia' },
      { id: 'protanopia', label: 'Protanopia' },
      { id: 'tritanopia', label: 'Tritanopia' },
    ],
    reduceMotion: false,
    typeScale: 1,
    preferNoFailure: false,
    autosaveHours: 5,
    autosaveOptions: [1, 3, 5, 12, 24],
    ...patch,
  }
}

describe('Settings panel', () => {
  it('mixes music and effects separately', () => {
    const changed: [string, number][] = []
    const host = mountShell(
      <Settings
        model={settingsModel()}
        tab="audio"
        onTab={noop}
        onClose={noop}
        onVolume={(channel, value) => changed.push([channel, value])}
      />,
    )

    try {
      expect(host.textContent).toContain('60%')
      expect(host.textContent).toContain('80%')

      const music = host.querySelector<HTMLInputElement>('input[aria-label="Music"]')
      setInputValue(music, '25')
      expect(changed).toEqual([['music', 0.25]])
    } finally {
      unmount(host)
    }
  })

  it('disables the sliders when muted', () => {
    const host = mountShell(
      <Settings model={settingsModel({ muted: true })} tab="audio" onTab={noop} onClose={noop} />,
    )

    try {
      const music = host.querySelector<HTMLInputElement>('input[aria-label="Music"]')
      expect(music?.disabled).toBe(true)
    } finally {
      unmount(host)
    }
  })

  it('offers a palette per deficiency and a Reduce Motion switch', () => {
    const palettes: string[] = []
    let motion: boolean | null = null
    const host = mountShell(
      <Settings
        model={settingsModel()}
        tab="accessibility"
        onTab={noop}
        onClose={noop}
        onPalette={(palette) => palettes.push(palette)}
        onReduceMotion={(enabled) => {
          motion = enabled
        }}
      />,
    )

    try {
      expect(host.textContent).toContain('hue alone')
      const tritan = [...host.querySelectorAll('.bw-settings-choices button')].find(
        (b) => b.textContent === 'Tritanopia',
      )
      ;(tritan as HTMLButtonElement | undefined)?.click()
      expect(palettes).toEqual(['tritanopia'])

      const reduce = host.querySelector<HTMLInputElement>('input[aria-label="Reduce motion"]')
      toggleCheckbox(reduce, true)
      expect(motion).toBe(true)
    } finally {
      unmount(host)
    }
  })

  it('reports the type scale as a percentage', () => {
    const host = mountShell(
      <Settings
        model={settingsModel({ typeScale: 1.3 })}
        tab="accessibility"
        onTab={noop}
        onClose={noop}
      />,
    )

    try {
      expect(host.textContent).toContain('130%')
    } finally {
      unmount(host)
    }
  })

  it('chooses an autosave cadence', () => {
    const chosen: number[] = []
    const host = mountShell(
      <Settings
        model={settingsModel()}
        tab="game"
        onTab={noop}
        onClose={noop}
        onAutosaveHours={(hours) => chosen.push(hours)}
      />,
    )

    try {
      const twelve = [...host.querySelectorAll('.bw-settings-choices button')].find(
        (b) => b.textContent === '12h',
      )
      ;(twelve as HTMLButtonElement | undefined)?.click()
      expect(chosen).toEqual([12])
    } finally {
      unmount(host)
    }
  })

  it('switches tab', () => {
    const tabs: string[] = []
    const host = mountShell(
      <Settings
        model={settingsModel()}
        tab="audio"
        onTab={(tab) => tabs.push(tab)}
        onClose={noop}
      />,
    )

    try {
      const access = [...host.querySelectorAll('.bw-settings-tabs button')].find(
        (b) => b.textContent === 'Accessibility',
      )
      ;(access as HTMLButtonElement | undefined)?.click()
      expect(tabs).toEqual(['accessibility'])
    } finally {
      unmount(host)
    }
  })
})

describe('settings copy', () => {
  it('formats a fraction as a whole percentage', () => {
    expect(percentLabel(0)).toBe('0%')
    expect(percentLabel(0.625)).toBe('63%')
    expect(percentLabel(1)).toBe('100%')
  })

  it('formats the type scale the way the player reads it', () => {
    expect(typeScaleLabel(1)).toBe('100%')
    expect(typeScaleLabel(1.3)).toBe('130%')
  })

  it('formats money with thousands separators', () => {
    expect(formatFunds(30_000)).toBe('$30,000')
  })
})
