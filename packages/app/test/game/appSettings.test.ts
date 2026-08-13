/**
 * T6.5 — player preferences: defaults, defensive reading, and the CSS
 * variables the shell applies (PRD 3.10 / 7.9).
 */

import { describe, expect, it } from 'vitest'

import {
  AUTOSAVE_HOURS,
  COLOUR_BLIND_PALETTES,
  DEFAULT_APP_SETTINGS,
  MAX_TYPE_SCALE,
  MIN_TYPE_SCALE,
  clampTypeScale,
  clampVolume,
  effectiveVolume,
  parseAppSettings,
  settingsCssVariables,
} from '../../src/game/appSettings'

describe('defaults', () => {
  it('starts unmuted, at default palette, with motion on', () => {
    expect(DEFAULT_APP_SETTINGS.audio.muted).toBe(false)
    expect(DEFAULT_APP_SETTINGS.accessibility.palette).toBe('default')
    expect(DEFAULT_APP_SETTINGS.accessibility.reduceMotion).toBe(false)
    expect(DEFAULT_APP_SETTINGS.accessibility.typeScale).toBe(MIN_TYPE_SCALE)
  })

  it('autosaves on PRD 3.10 cadence', () => {
    expect(DEFAULT_APP_SETTINGS.autosaveHours).toBe(5)
    expect(AUTOSAVE_HOURS).toContain(5)
  })

  it('offers a palette for each of the three deficiencies', () => {
    expect(COLOUR_BLIND_PALETTES).toEqual([
      'default',
      'deuteranopia',
      'protanopia',
      'tritanopia',
    ])
  })
})

describe('clamping', () => {
  it('keeps volume inside 0..1 and survives nonsense', () => {
    expect(clampVolume(0.5)).toBe(0.5)
    expect(clampVolume(-1)).toBe(0)
    expect(clampVolume(9)).toBe(1)
    expect(clampVolume(Number.NaN)).toBe(0)
  })

  it('keeps type scale inside PRD 7.9s 100–130%', () => {
    expect(clampTypeScale(1.15)).toBe(1.15)
    expect(clampTypeScale(0.5)).toBe(MIN_TYPE_SCALE)
    expect(clampTypeScale(3)).toBe(MAX_TYPE_SCALE)
    expect(clampTypeScale(Number.NaN)).toBe(MIN_TYPE_SCALE)
  })
})

describe('reading stored preferences', () => {
  it('round-trips a full set', () => {
    const settings = {
      audio: { music: 0.2, sfx: 0.4, muted: true },
      accessibility: {
        palette: 'protanopia',
        reduceMotion: true,
        typeScale: 1.2,
        preferNoFailure: true,
      },
      autosaveHours: 12,
    }
    expect(parseAppSettings(settings)).toEqual(settings)
  })

  it('defaults field by field rather than throwing the lot away', () => {
    const parsed = parseAppSettings({ audio: { music: 0.1 } })
    expect(parsed.audio.music).toBe(0.1)
    // The rest of audio, and every other group, keeps its default.
    expect(parsed.audio.sfx).toBe(DEFAULT_APP_SETTINGS.audio.sfx)
    expect(parsed.accessibility.palette).toBe('default')
    expect(parsed.autosaveHours).toBe(DEFAULT_APP_SETTINGS.autosaveHours)
  })

  it('rejects a palette or cadence it does not know', () => {
    const parsed = parseAppSettings({
      accessibility: { palette: 'octarine' },
      autosaveHours: 7,
    })
    expect(parsed.accessibility.palette).toBe('default')
    expect(parsed.autosaveHours).toBe(DEFAULT_APP_SETTINGS.autosaveHours)
  })

  it('clamps whatever it reads', () => {
    const parsed = parseAppSettings({
      audio: { music: 40, sfx: -3 },
      accessibility: { typeScale: 9 },
    })
    expect(parsed.audio.music).toBe(1)
    expect(parsed.audio.sfx).toBe(0)
    expect(parsed.accessibility.typeScale).toBe(MAX_TYPE_SCALE)
  })

  it('falls back entirely on nonsense', () => {
    expect(parseAppSettings(null)).toEqual(DEFAULT_APP_SETTINGS)
    expect(parseAppSettings('{}')).toEqual(DEFAULT_APP_SETTINGS)
    expect(parseAppSettings(42)).toEqual(DEFAULT_APP_SETTINGS)
  })
})

describe('applying preferences', () => {
  it('turns Reduce Motion into a duration scale of zero', () => {
    const on = settingsCssVariables({
      ...DEFAULT_APP_SETTINGS,
      accessibility: { ...DEFAULT_APP_SETTINGS.accessibility, reduceMotion: true },
    })
    expect(on['--motion-scale']).toBe('0')

    const off = settingsCssVariables(DEFAULT_APP_SETTINGS)
    expect(off['--motion-scale']).toBe('1')
  })

  it('publishes the type scale and palette for the sheet to read', () => {
    const vars = settingsCssVariables({
      ...DEFAULT_APP_SETTINGS,
      accessibility: {
        ...DEFAULT_APP_SETTINGS.accessibility,
        typeScale: 1.3,
        palette: 'tritanopia',
      },
    })
    expect(vars['--type-scale']).toBe('1.30')
    expect(vars['--palette']).toBe('tritanopia')
  })

  it('mutes both channels regardless of the sliders', () => {
    const muted = { music: 0.9, sfx: 0.9, muted: true }
    expect(effectiveVolume(muted, 'music')).toBe(0)
    expect(effectiveVolume(muted, 'sfx')).toBe(0)

    const audible = { music: 0.9, sfx: 0.3, muted: false }
    expect(effectiveVolume(audible, 'music')).toBe(0.9)
    expect(effectiveVolume(audible, 'sfx')).toBe(0.3)
  })
})
