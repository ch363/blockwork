/**
 * T8.8 — New Prison config mapping, settings model, and autosave cadence.
 */

import { describe, expect, it } from 'vitest'

import { loadGameData, resolveMapSize, seedFromInput } from '@blockwork/sim'
import type { NewPrisonModel } from '@blockwork/ui'

import {
  DEFAULT_APP_SETTINGS,
  parseAppSettings,
  settingsCssVariables,
} from '../../src/game/appSettings'
import {
  autosaveDue,
  newPrisonConfigFromModel,
  settingsModelFromAppSettings,
} from '../../src/game/onboardingView'

const DATA = loadGameData()

function model(overrides: Partial<NewPrisonModel> = {}): NewPrisonModel {
  return {
    sizePreset: 'medium',
    sizes: [
      { id: 'small', label: 'Small', tiles: 100 },
      { id: 'medium', label: 'Medium', tiles: 160 },
      { id: 'large', label: 'Large', tiles: 220 },
      { id: 'huge', label: 'Huge', tiles: 300 },
    ],
    startingFunds: 45_000,
    continuousIntake: false,
    randomEvents: false,
    firstOrderGrace: true,
    seedInput: 'blockwork-seed',
    failures: [
      { id: 'insolvency', label: 'Insolvency', description: '', enabled: false },
      { id: 'deaths', label: 'Deaths', description: '', enabled: true },
    ],
    mutators: [
      { id: 'fires', label: 'Fires', description: '', enabled: false },
      { id: 'staffNeeds', label: 'Staff needs', description: '', enabled: true },
    ],
    ...overrides,
  }
}

describe('newPrisonConfigFromModel', () => {
  it('resolves size, seed, funds, intake and toggles onto sim config', () => {
    const config = newPrisonConfigFromModel(model(), DATA, () => 0.25)

    expect(config.sizePreset).toBe('medium')
    expect(config.mapSize).toBe(resolveMapSize(DATA, 'medium'))
    expect(config.seed).toBe(seedFromInput('blockwork-seed', () => 0.25))
    expect(config.startingFunds).toBe(45_000)
    expect(config.continuousIntake).toBe(false)
    expect(config.randomEvents).toBe(false)
    expect(config.firstOrderGrace).toBe(true)
    expect(config.failures.insolvency).toBe(false)
    expect(config.failures.deaths).toBe(true)
    expect(config.mutators.fires).toBe(false)
    expect(config.mutators.staffNeeds).toBe(true)
  })

  it('keeps unlisted failure conditions armed by default', () => {
    const config = newPrisonConfigFromModel(model({ failures: [] }), DATA, () => 0)
    expect(config.failures.escapes).toBe(true)
  })
})

describe('settings application', () => {
  it('maps persisted settings onto the Settings panel model', () => {
    const settings = parseAppSettings({
      audio: { music: 0.2, sfx: 0.4, muted: true },
      accessibility: {
        palette: 'protanopia',
        reduceMotion: true,
        typeScale: 1.2,
        preferNoFailure: true,
      },
      autosaveHours: 12,
    })
    const panel = settingsModelFromAppSettings(settings)
    expect(panel.music).toBe(0.2)
    expect(panel.sfx).toBe(0.4)
    expect(panel.muted).toBe(true)
    expect(panel.palette).toBe('protanopia')
    expect(panel.reduceMotion).toBe(true)
    expect(panel.typeScale).toBe(1.2)
    expect(panel.preferNoFailure).toBe(true)
    expect(panel.autosaveHours).toBe(12)
  })

  it('exports CSS variables the shell honours, including --motion-scale', () => {
    const reduced = settingsCssVariables({
      ...DEFAULT_APP_SETTINGS,
      accessibility: { ...DEFAULT_APP_SETTINGS.accessibility, reduceMotion: true, typeScale: 1.3 },
    })
    expect(reduced['--motion-scale']).toBe('0')
    expect(reduced['--type-scale']).toBe('1.30')

    const motion = settingsCssVariables(DEFAULT_APP_SETTINGS)
    expect(motion['--motion-scale']).toBe('1')
  })
})

describe('autosave scheduling', () => {
  it('fires when in-game hours since the last save meet the cadence', () => {
    const ticksPerHour = 600
    expect(autosaveDue(0, 0, 5, ticksPerHour)).toBe(false)
    expect(autosaveDue(5 * ticksPerHour, 0, 5, ticksPerHour)).toBe(true)
    expect(autosaveDue(5 * ticksPerHour - 1, 0, 5, ticksPerHour)).toBe(false)
    expect(autosaveDue(12 * ticksPerHour, 5 * ticksPerHour, 5, ticksPerHour)).toBe(true)
  })

  it('refuses a zero or nonsense cadence', () => {
    expect(autosaveDue(10_000, 0, 0, 600)).toBe(false)
    expect(autosaveDue(10_000, 0, 5, 0)).toBe(false)
    expect(autosaveDue(Number.NaN, 0, 5, 600)).toBe(false)
  })
})
