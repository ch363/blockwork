/**
 * T6.7 — audio: the bed layered by danger, positional one-shots, the two
 * sliders and the full mute (PRD 7.8).
 */

import { describe, expect, it } from 'vitest'

import { DEFAULT_APP_SETTINGS } from '../../src/game/appSettings'
import type { AudioSettings } from '../../src/game/appSettings'
import {
  AMBIENT_LAYERS,
  AudioEngine,
  AudioMixer,
  HEARING_RANGE_TILES,
  SOUND_EFFECTS,
  distanceGain,
  effectForEventKind,
  layerGain,
  stereoPan,
} from '../../src/game/audio'
import type { AmbientLayer, AudioBackend, SoundEffect } from '../../src/game/audio'

const LOUD: AudioSettings = { music: 1, sfx: 1, muted: false }
const LISTENER = { tileX: 50, tileY: 50, halfWidthTiles: 20 }

/** Records what the engine asked for, so the rules can be asserted. */
class RecordingBackend implements AudioBackend {
  readonly layers: [AmbientLayer, number][] = []
  readonly shots: [SoundEffect, number, number][] = []
  stops = 0

  setLayerGain(layer: AmbientLayer, gain: number): void {
    this.layers.push([layer, gain])
  }
  playOneShot(effect: SoundEffect, gain: number, pan: number): void {
    this.shots.push([effect, gain, pan])
  }
  stopAll(): void {
    this.stops += 1
  }
  gainOf(layer: AmbientLayer): number | undefined {
    const entries = this.layers.filter(([name]) => name === layer)
    return entries[entries.length - 1]?.[1]
  }
}

describe('the ambient bed layers by danger (PRD 7.8)', () => {
  it('keeps the room tone on at every danger level', () => {
    for (const danger of [0, 25, 50, 75, 100]) {
      expect(layerGain('room', danger), String(danger)).toBeGreaterThan(0)
    }
  })

  it('brings each layer in as danger rises, and only then', () => {
    expect(layerGain('unease', 0)).toBe(0)
    expect(layerGain('unease', 30)).toBeGreaterThan(0)

    expect(layerGain('tension', 20)).toBe(0)
    expect(layerGain('tension', 60)).toBeGreaterThan(0)

    expect(layerGain('alarm', 50)).toBe(0)
    expect(layerGain('alarm', 90)).toBeGreaterThan(0)
  })

  it('crossfades rather than switching', () => {
    // Through the middle of the range two layers are partly up at once, which
    // is what makes it a swell instead of a click.
    const danger = 45
    expect(layerGain('unease', danger)).toBeGreaterThan(0)
    expect(layerGain('tension', danger)).toBeGreaterThan(0)
  })

  it('rises monotonically with danger for every layer', () => {
    for (const layer of AMBIENT_LAYERS) {
      let previous = -1
      for (let danger = 0; danger <= 100; danger += 5) {
        const gain = layerGain(layer, danger)
        expect(gain, `${layer} at ${String(danger)}`).toBeGreaterThanOrEqual(previous)
        previous = gain
      }
    }
  })

  it('never exceeds its ceiling, so the bed cannot drown the effects', () => {
    for (const layer of AMBIENT_LAYERS) {
      expect(layerGain(layer, 1000), layer).toBeLessThanOrEqual(1)
      expect(layerGain(layer, 100), layer).toBeLessThanOrEqual(0.6)
    }
  })

  it('clamps a danger level outside 0..100', () => {
    expect(layerGain('alarm', -50)).toBe(0)
    expect(layerGain('alarm', 500)).toBe(layerGain('alarm', 100))
  })
})

describe('positional one-shots (PRD 7.8)', () => {
  it('is loudest underfoot and silent past the hearing range', () => {
    expect(distanceGain(0)).toBe(1)
    expect(distanceGain(HEARING_RANGE_TILES / 2)).toBeCloseTo(0.5, 6)
    expect(distanceGain(HEARING_RANGE_TILES)).toBe(0)
    expect(distanceGain(HEARING_RANGE_TILES + 10)).toBe(0)
  })

  it('survives nonsense distances', () => {
    expect(distanceGain(-1)).toBe(0)
    expect(distanceGain(Number.NaN)).toBe(0)
  })

  it('pans by horizontal offset and never past the edges', () => {
    expect(stereoPan(0, 20)).toBe(0)
    expect(stereoPan(10, 20)).toBeCloseTo(0.5, 6)
    expect(stereoPan(-10, 20)).toBeCloseTo(-0.5, 6)
    // Off screen is already hard over; it does not keep panning.
    expect(stereoPan(500, 20)).toBe(1)
    expect(stereoPan(-500, 20)).toBe(-1)
  })

  it('mixes a nearby effect and drops a distant one', () => {
    const mixer = new AudioMixer(LOUD)

    const near = mixer.oneShot('door_open', { tileX: 54, tileY: 50 }, LISTENER)
    expect(near).not.toBeNull()
    expect(near?.gain ?? 0).toBeGreaterThan(0)
    // To the right of the listener.
    expect(near?.pan ?? 0).toBeGreaterThan(0)

    const far = mixer.oneShot('door_open', { tileX: 500, tileY: 500 }, LISTENER)
    expect(far).toBeNull()
  })
})

describe('the mixer honours the sliders and the mute', () => {
  it('scales the bed by the music slider alone', () => {
    const half = new AudioMixer({ music: 0.5, sfx: 1, muted: false })
    const full = new AudioMixer(LOUD)

    const halfRoom = half.ambient(0).find((entry) => entry.layer === 'room')?.gain ?? 0
    const fullRoom = full.ambient(0).find((entry) => entry.layer === 'room')?.gain ?? 0
    expect(halfRoom).toBeCloseTo(fullRoom / 2, 6)
  })

  it('scales one-shots by the effects slider alone', () => {
    const quiet = new AudioMixer({ music: 1, sfx: 0.25, muted: false })
    const loud = new AudioMixer(LOUD)
    const at = { tileX: 52, tileY: 50 }

    const quietGain = quiet.oneShot('fight', at, LISTENER)?.gain ?? 0
    const loudGain = loud.oneShot('fight', at, LISTENER)?.gain ?? 0
    expect(quietGain).toBeCloseTo(loudGain * 0.25, 6)
  })

  it('silences everything on a full mute, whatever the sliders say', () => {
    const mixer = new AudioMixer({ music: 1, sfx: 1, muted: true })

    expect(mixer.silent).toBe(true)
    for (const entry of mixer.ambient(100)) {
      expect(entry.gain, entry.layer).toBe(0)
    }
    expect(mixer.oneShot('alarm', { tileX: 50, tileY: 50 }, LISTENER)).toBeNull()
  })

  it('counts both sliders at zero as silent too', () => {
    expect(new AudioMixer({ music: 0, sfx: 0, muted: false }).silent).toBe(true)
    expect(new AudioMixer({ music: 0, sfx: 0.5, muted: false }).silent).toBe(false)
  })

  it('starts from the shipped defaults without complaint', () => {
    const mixer = new AudioMixer(DEFAULT_APP_SETTINGS.audio)
    expect(mixer.silent).toBe(false)
    expect(mixer.ambient(0)).toHaveLength(AMBIENT_LAYERS.length)
  })
})

describe('the engine drives the backend', () => {
  it('writes a gain per layer on the first update', () => {
    const backend = new RecordingBackend()
    const engine = new AudioEngine(backend, LOUD)

    engine.update(0)
    expect(backend.layers).toHaveLength(AMBIENT_LAYERS.length)
    expect(engine.started).toBe(true)
  })

  it('does not rewrite a gain that has not moved', () => {
    const backend = new RecordingBackend()
    const engine = new AudioEngine(backend, LOUD)

    engine.update(0)
    const first = backend.layers.length
    engine.update(0)
    expect(backend.layers).toHaveLength(first)
  })

  it('rewrites the layers that a danger change actually moved', () => {
    const backend = new RecordingBackend()
    const engine = new AudioEngine(backend, LOUD)

    engine.update(0)
    backend.layers.length = 0
    engine.update(80)

    const moved = new Set(backend.layers.map(([layer]) => layer))
    expect(moved.has('tension')).toBe(true)
    expect(moved.has('alarm')).toBe(true)
    // The room tone is flat across the range and should not be rewritten.
    expect(moved.has('room')).toBe(false)
  })

  it('stops everything the moment it is muted', () => {
    const backend = new RecordingBackend()
    const engine = new AudioEngine(backend, LOUD)

    engine.update(50)
    expect(engine.started).toBe(true)

    engine.applySettings({ music: 1, sfx: 1, muted: true })
    expect(backend.stops).toBe(1)
    expect(engine.started).toBe(false)

    // And stays stopped rather than stopping again every frame.
    engine.update(50)
    expect(backend.stops).toBe(1)
  })

  it('comes back when unmuted', () => {
    const backend = new RecordingBackend()
    const engine = new AudioEngine(backend, { music: 1, sfx: 1, muted: true })

    engine.update(50)
    expect(engine.started).toBe(false)
    expect(backend.layers).toHaveLength(0)

    engine.applySettings(LOUD)
    engine.update(50)
    expect(engine.started).toBe(true)
    expect(backend.layers.length).toBeGreaterThan(0)
  })

  it('plays an audible effect and skips an inaudible one', () => {
    const backend = new RecordingBackend()
    const engine = new AudioEngine(backend, LOUD)

    expect(engine.play('door_open', { tileX: 51, tileY: 50 }, LISTENER)).toBe(true)
    expect(backend.shots).toHaveLength(1)

    expect(engine.play('door_open', { tileX: 900, tileY: 900 }, LISTENER)).toBe(false)
    expect(backend.shots).toHaveLength(1)
  })

  it('stops on dispose', () => {
    const backend = new RecordingBackend()
    const engine = new AudioEngine(backend, LOUD)
    engine.update(10)
    engine.dispose()
    expect(backend.stops).toBe(1)
    expect(engine.started).toBe(false)
  })
})

describe('events that make a noise', () => {
  it('maps the loud events onto effects the engine can play', () => {
    expect(effectForEventKind('riot.started')).toBe('alarm')
    expect(effectForEventKind('combat.fightStarted')).toBe('fight')
    expect(effectForEventKind('punishment.started')).toBe('cell_slam')
  })

  it('leaves the log-only majority silent', () => {
    expect(effectForEventKind('danger.recomputed')).toBeNull()
    expect(effectForEventKind('economy.entryPosted')).toBeNull()
  })

  it('only ever names an effect that exists', () => {
    for (const kind of ['riot.started', 'fire.ignited', 'search.performed']) {
      const effect = effectForEventKind(kind)
      expect(effect, kind).not.toBeNull()
      expect(SOUND_EFFECTS, kind).toContain(effect)
    }
  })
})
