/**
 * The mixer and the ambient bed (T6.7, PRD 7.8).
 *
 * Four requirements: an ambient loop layered by danger, positional one-shots,
 * separate music and SFX sliders, and a full mute. This module is all four,
 * and it is deliberately split from anything that touches `AudioContext`:
 *
 *   - **`AudioMixer`** is arithmetic. Given the settings, the danger level and
 *     a listener position, it says which layers should be audible and at what
 *     gain, and how loud a one-shot at a given tile should be. No Web Audio, no
 *     DOM, no timers — so every rule in PRD 7.8 is testable without a browser.
 *   - **`AudioEngine`** (below) owns the actual nodes and does what the mixer
 *     says.
 *
 * The layering is a crossfade, not a switch. Danger is a continuous 0–100 that
 * moves a point at a time, and a bed that cut between "calm" and "tense" on a
 * threshold would audibly click every time the meter wobbled across it. Each
 * layer instead has a band it fades up across, and two layers overlap through
 * the middle of the range.
 *
 * Nothing here is simulation state and nothing here is read by a tick: audio
 * must never be able to change the game (CLAUDE.md rule 3).
 */

import { clampVolume, effectiveVolume } from './appSettings'
import type { AudioSettings } from './appSettings'

/* -------------------------------------------------------------------------- */
/* Layers                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * The ambient bed, quietest first.
 *
 * `room` is the building itself and never stops; the other three come in as
 * the prison gets worse, so the player hears trouble before they see it.
 */
export const AMBIENT_LAYERS = ['room', 'unease', 'tension', 'alarm'] as const
export type AmbientLayer = (typeof AMBIENT_LAYERS)[number]

/**
 * Where each layer fades in and out, on the 0–100 danger scale.
 *
 * The bands overlap on purpose: at danger 45 both `unease` and `tension` are
 * partly up, which is what makes the transition a swell rather than a switch.
 */
interface LayerBand {
  /** Danger at which the layer starts to be heard. */
  readonly from: number
  /** Danger at which it reaches full gain. */
  readonly to: number
  /** Ceiling, so the bed never drowns the effects. */
  readonly peak: number
}

export const AMBIENT_BANDS: Readonly<Record<AmbientLayer, LayerBand>> = {
  // Always present. The building has a sound even when nothing is happening.
  room: { from: 0, to: 0, peak: 0.6 },
  unease: { from: 15, to: 45, peak: 0.5 },
  tension: { from: 40, to: 75, peak: 0.55 },
  alarm: { from: 70, to: 95, peak: 0.45 },
}

/** Gain of one layer at a danger level, 0..1. */
export function layerGain(layer: AmbientLayer, danger: number): number {
  const band = AMBIENT_BANDS[layer]
  const clamped = Math.min(100, Math.max(0, danger))

  if (band.to <= band.from) {
    // A layer with no ramp is either always on or never on.
    return clamped >= band.from ? band.peak : 0
  }
  if (clamped <= band.from) return 0
  if (clamped >= band.to) return band.peak

  const t = (clamped - band.from) / (band.to - band.from)
  return band.peak * t
}

/* -------------------------------------------------------------------------- */
/* One-shots                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * The positional effects of PRD 7.8: "doors, alarms, fights and construction".
 *
 * A closed set, because each one is a distinct synthesised voice in the engine
 * and a string nobody has written a voice for would simply be silence.
 */
export const SOUND_EFFECTS = [
  'door_open',
  'door_close',
  'door_locked',
  'alarm',
  'fight',
  'construction',
  'cell_slam',
  'whistle',
] as const
export type SoundEffect = (typeof SOUND_EFFECTS)[number]

/** Tiles beyond which a one-shot is inaudible. */
export const HEARING_RANGE_TILES = 24

/**
 * How loud a one-shot at `distanceTiles` should be, 0..1.
 *
 * Linear rolloff rather than inverse-square: the camera is looking down at a
 * building from above, not standing in it, and true distance attenuation makes
 * everything more than a few tiles away vanish. Linear keeps the far side of a
 * wing quietly present, which is what the player actually wants to hear.
 */
export function distanceGain(distanceTiles: number, range = HEARING_RANGE_TILES): number {
  if (!Number.isFinite(distanceTiles) || distanceTiles < 0) return 0
  if (range <= 0) return 0
  if (distanceTiles >= range) return 0
  return 1 - distanceTiles / range
}

/**
 * Stereo placement, -1 (hard left) to 1 (hard right).
 *
 * From the horizontal offset alone, over half the viewport width: something at
 * the left edge of the screen is hard left, and anything off screen is already
 * at the edge rather than continuing to pan.
 */
export function stereoPan(offsetTiles: number, halfWidthTiles: number): number {
  if (halfWidthTiles <= 0) return 0
  const pan = offsetTiles / halfWidthTiles
  return Math.min(1, Math.max(-1, pan))
}

/* -------------------------------------------------------------------------- */
/* The mixer                                                                   */
/* -------------------------------------------------------------------------- */

export interface ListenerPose {
  /** Camera centre, in tiles. */
  readonly tileX: number
  readonly tileY: number
  /** Half the viewport width in tiles, for the pan. */
  readonly halfWidthTiles: number
}

export interface AmbientMix {
  readonly layer: AmbientLayer
  /** Final gain after the music slider and the mute. */
  readonly gain: number
}

export interface OneShotMix {
  readonly effect: SoundEffect
  /** Final gain after distance, the SFX slider and the mute. 0 means skip it. */
  readonly gain: number
  /** -1..1. */
  readonly pan: number
}

/**
 * Turns settings plus world state into gains.
 *
 * Pure: the same inputs always give the same mix, which is what lets the whole
 * of PRD 7.8 be a unit test rather than something someone has to listen to.
 */
export class AudioMixer {
  #settings: AudioSettings

  constructor(settings: AudioSettings) {
    this.#settings = settings
  }

  get settings(): AudioSettings {
    return this.#settings
  }

  apply(settings: AudioSettings): void {
    this.#settings = settings
  }

  /** Every ambient layer and the gain it should be playing at. */
  ambient(danger: number): readonly AmbientMix[] {
    const music = effectiveVolume(this.#settings, 'music')
    return AMBIENT_LAYERS.map((layer) => ({
      layer,
      gain: clampVolume(layerGain(layer, danger) * music),
    }))
  }

  /**
   * The mix for one positional effect, or null when it would be silent.
   *
   * Null rather than a zero gain so the engine never allocates a voice it is
   * about to discard — at twenty times speed a busy prison fires a lot of these.
   */
  oneShot(
    effect: SoundEffect,
    at: { readonly tileX: number; readonly tileY: number },
    listener: ListenerPose,
  ): OneShotMix | null {
    const sfx = effectiveVolume(this.#settings, 'sfx')
    if (sfx <= 0) return null

    const dx = at.tileX - listener.tileX
    const dy = at.tileY - listener.tileY
    const distance = Math.hypot(dx, dy)
    const gain = clampVolume(distanceGain(distance) * sfx)
    if (gain <= 0) return null

    return { effect, gain, pan: stereoPan(dx, listener.halfWidthTiles) }
  }

  /** Whether anything at all should be making a sound. */
  get silent(): boolean {
    return (
      this.#settings.muted ||
      (effectiveVolume(this.#settings, 'music') <= 0 && effectiveVolume(this.#settings, 'sfx') <= 0)
    )
  }
}

/* -------------------------------------------------------------------------- */
/* The engine                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * The Web Audio surface the engine needs.
 *
 * Declared structurally rather than taken from `lib.dom` so a test can hand in
 * a recording stub, and so this module does not force a DOM lib on anything
 * that imports it.
 */
export interface AudioBackend {
  /** Creates or updates a continuously-playing layer at `gain`. */
  setLayerGain(layer: AmbientLayer, gain: number): void
  /** Fires a one-shot. `pan` is -1..1. */
  playOneShot(effect: SoundEffect, gain: number, pan: number): void
  /** Stops everything immediately. */
  stopAll(): void
}

/**
 * Drives a backend from the mixer.
 *
 * Holds the last gain it wrote for each layer and only pushes a change when it
 * has actually moved, because setting a gain on every frame is both wasteful
 * and, on some implementations, audibly steppy.
 */
export class AudioEngine {
  readonly mixer: AudioMixer
  readonly #backend: AudioBackend
  readonly #lastGain = new Map<AmbientLayer, number>()
  #started = false

  constructor(backend: AudioBackend, settings: AudioSettings) {
    this.#backend = backend
    this.mixer = new AudioMixer(settings)
  }

  get started(): boolean {
    return this.#started
  }

  /**
   * Updates the ambient bed for the current danger level.
   *
   * Called once a frame. A mute stops everything rather than writing zeros to
   * every layer, so a muted game is not quietly running four oscillators.
   */
  update(danger: number): void {
    if (this.mixer.silent) {
      if (!this.#started) return
      this.#backend.stopAll()
      this.#lastGain.clear()
      this.#started = false
      return
    }

    this.#started = true
    for (const { layer, gain } of this.mixer.ambient(danger)) {
      const previous = this.#lastGain.get(layer)
      // A hundredth of full scale is below the threshold of a heard change.
      if (previous !== undefined && Math.abs(previous - gain) < 0.01) continue
      this.#lastGain.set(layer, gain)
      this.#backend.setLayerGain(layer, gain)
    }
  }

  /** Fires a positional effect, if it would be audible at all. */
  play(
    effect: SoundEffect,
    at: { readonly tileX: number; readonly tileY: number },
    listener: ListenerPose,
  ): boolean {
    const mix = this.mixer.oneShot(effect, at, listener)
    if (mix === null) return false
    this.#backend.playOneShot(mix.effect, mix.gain, mix.pan)
    return true
  }

  /** Applies a settings change, stopping immediately on a mute. */
  applySettings(settings: AudioSettings): void {
    this.mixer.apply(settings)
    if (!this.mixer.silent) return
    this.#backend.stopAll()
    this.#lastGain.clear()
    this.#started = false
  }

  dispose(): void {
    this.#backend.stopAll()
    this.#lastGain.clear()
    this.#started = false
  }
}

/* -------------------------------------------------------------------------- */
/* Mapping events to sounds                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Which simulation events make a noise.
 *
 * Keyed by Trace kind, so a system that already emits a `CausalEvent` gets its
 * sound for free and nothing has to be wired twice. Kinds absent from the table
 * are silent, which is the right default: most events are for the log.
 */
export const EFFECT_BY_EVENT_KIND: Readonly<Record<string, SoundEffect>> = {
  'riot.started': 'alarm',
  'fire.ignited': 'alarm',
  'escape.inmateEscaped': 'alarm',
  'combat.fightStarted': 'fight',
  'combat.died': 'fight',
  'misconduct.committed': 'whistle',
  'punishment.started': 'cell_slam',
  'search.performed': 'whistle',
  'escape.tunnelDiscovered': 'whistle',
}

/** The sound an event kind makes, or null for the silent majority. */
export function effectForEventKind(kind: string): SoundEffect | null {
  return EFFECT_BY_EVENT_KIND[kind] ?? null
}

/* -------------------------------------------------------------------------- */
/* Wiring it up                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Builds an engine over a real `AudioContext`, or returns null where there is
 * no audio at all.
 *
 * Null rather than a silent stub so the caller can tell "the player muted it"
 * apart from "this environment has no Web Audio" — a test runner, a server
 * render, an old webview. The first is a setting; the second is a fact.
 *
 * The context is created lazily by the caller because browsers refuse to start
 * one before a gesture; this only assembles the graph once there is one.
 */
export function createAudioEngine(
  backend: AudioBackend | null,
  settings: AudioSettings,
): AudioEngine | null {
  if (backend === null) return null
  return new AudioEngine(backend, settings)
}
