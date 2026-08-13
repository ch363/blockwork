/**
 * Player preferences (T6.5, PRD 3.10 / 7.9).
 *
 * These belong to the *player*, not to the prison: they follow someone between
 * saves, and none of them may change what the simulation does. That rule is
 * what keeps determinism honest — a replay recorded with Reduce Motion on has
 * to produce the same hash as one recorded with it off, so nothing here is
 * allowed anywhere near a tick.
 *
 * Everything is a plain value with a stated default and a defensive reader,
 * because this comes back off `localStorage`, which is to say off disk, which
 * is to say it may be anything at all.
 */

/** Overlay palettes, all of them readable in the three common deficiencies. */
export const COLOUR_BLIND_PALETTES = [
  'default',
  'deuteranopia',
  'protanopia',
  'tritanopia',
] as const
export type ColourBlindPalette = (typeof COLOUR_BLIND_PALETTES)[number]

/** PRD 3.10: autosave every 5 in-game hours, with 5 rotating slots. */
export const AUTOSAVE_HOURS = [1, 3, 5, 12, 24] as const
export type AutosaveHours = (typeof AUTOSAVE_HOURS)[number]

/** PRD 7.9: dynamic type to 130%. */
export const MIN_TYPE_SCALE = 1
export const MAX_TYPE_SCALE = 1.3

export interface AudioSettings {
  /** 0..1. */
  readonly music: number
  readonly sfx: number
  /** Silences everything regardless of the sliders. */
  readonly muted: boolean
}

export interface AccessibilitySettings {
  readonly palette: ColourBlindPalette
  /** Disables camera easing and panel slide animations. */
  readonly reduceMotion: boolean
  /** 1.0 to 1.3. */
  readonly typeScale: number
  /** PRD 7.9: a no-failure mode offered as a preference as well as per map. */
  readonly preferNoFailure: boolean
}

export interface AppSettings {
  readonly audio: AudioSettings
  readonly accessibility: AccessibilitySettings
  readonly autosaveHours: AutosaveHours
}

export const DEFAULT_APP_SETTINGS: AppSettings = {
  audio: { music: 0.6, sfx: 0.8, muted: false },
  accessibility: {
    palette: 'default',
    reduceMotion: false,
    typeScale: MIN_TYPE_SCALE,
    preferNoFailure: false,
  },
  // PRD 3.10's cadence.
  autosaveHours: 5,
}

/** Where the preferences live. Versioned so a shape change can be ignored. */
export const APP_SETTINGS_KEY = 'blockwork.settings.v1'

/* -------------------------------------------------------------------------- */
/* Reading and writing                                                         */
/* -------------------------------------------------------------------------- */

export function clampVolume(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.min(1, Math.max(0, value))
}

export function clampTypeScale(value: number): number {
  if (!Number.isFinite(value)) return MIN_TYPE_SCALE
  return Math.min(MAX_TYPE_SCALE, Math.max(MIN_TYPE_SCALE, value))
}

export function isColourBlindPalette(value: unknown): value is ColourBlindPalette {
  return typeof value === 'string' && (COLOUR_BLIND_PALETTES as readonly string[]).includes(value)
}

export function isAutosaveHours(value: unknown): value is AutosaveHours {
  return typeof value === 'number' && (AUTOSAVE_HOURS as readonly number[]).includes(value)
}

/**
 * Reads preferences out of whatever was stored, defaulting field by field.
 *
 * Field by field rather than all-or-nothing: a build that adds a preference
 * should not throw away the six the player already set.
 */
export function parseAppSettings(raw: unknown): AppSettings {
  if (typeof raw !== 'object' || raw === null) return DEFAULT_APP_SETTINGS
  const source = raw as Record<string, unknown>

  const audioSource = asRecord(source['audio'])
  const accessSource = asRecord(source['accessibility'])

  return {
    audio: {
      music: clampVolume(asNumber(audioSource['music'], DEFAULT_APP_SETTINGS.audio.music)),
      sfx: clampVolume(asNumber(audioSource['sfx'], DEFAULT_APP_SETTINGS.audio.sfx)),
      muted: asBoolean(audioSource['muted'], DEFAULT_APP_SETTINGS.audio.muted),
    },
    accessibility: {
      palette: isColourBlindPalette(accessSource['palette'])
        ? accessSource['palette']
        : DEFAULT_APP_SETTINGS.accessibility.palette,
      reduceMotion: asBoolean(
        accessSource['reduceMotion'],
        DEFAULT_APP_SETTINGS.accessibility.reduceMotion,
      ),
      typeScale: clampTypeScale(
        asNumber(accessSource['typeScale'], DEFAULT_APP_SETTINGS.accessibility.typeScale),
      ),
      preferNoFailure: asBoolean(
        accessSource['preferNoFailure'],
        DEFAULT_APP_SETTINGS.accessibility.preferNoFailure,
      ),
    },
    autosaveHours: isAutosaveHours(source['autosaveHours'])
      ? source['autosaveHours']
      : DEFAULT_APP_SETTINGS.autosaveHours,
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
}

function asNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function asBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

/* -------------------------------------------------------------------------- */
/* Applying them                                                               */
/* -------------------------------------------------------------------------- */

/**
 * The CSS custom properties the shell reads.
 *
 * Returned rather than applied so the caller owns the DOM write and a test can
 * assert the mapping without one. Reduce Motion is expressed as a duration
 * scale of zero rather than a flag, because every animation in the sheet is
 * already `var(--dur) * something`.
 */
export function settingsCssVariables(settings: AppSettings): Readonly<Record<string, string>> {
  return {
    '--type-scale': settings.accessibility.typeScale.toFixed(2),
    '--motion-scale': settings.accessibility.reduceMotion ? '0' : '1',
    '--palette': settings.accessibility.palette,
  }
}

/** The effective volume of a channel, after the master mute. */
export function effectiveVolume(settings: AudioSettings, channel: 'music' | 'sfx'): number {
  if (settings.muted) return 0
  return clampVolume(channel === 'music' ? settings.music : settings.sfx)
}
