/**
 * The Web Audio backend: where the mixer's numbers become sound (T6.7).
 *
 * Every voice is **synthesised**, not sampled. That is the same decision the
 * art pass made and for the same two reasons: there is no audio binary in the
 * repository that could be mistaken for someone else's (CLAUDE.md rule 1), and
 * a procedural bed can be crossfaded continuously by danger without a library
 * of pre-rendered loops for every combination.
 *
 * The four ambient layers are built from the same two primitives — filtered
 * noise and a low oscillator pair — differing in filter and in pitch:
 *
 *   - `room`      low brown-ish noise: air handling, a building at rest
 *   - `unease`    a slow detuned pair, barely audible, that never resolves
 *   - `tension`   the same pair a fifth apart with a faster tremolo
 *   - `alarm`     a narrow band around a klaxon frequency, pulsed
 *
 * One-shots are short envelopes over the same primitives. None of them are
 * pitched to a scale, because the prison is not meant to sound musical.
 *
 * Everything is created lazily on the first audible frame: browsers refuse to
 * start an `AudioContext` before a gesture, and building the graph up front
 * would leave a suspended context running for a player who never unmutes.
 */

import type { AmbientLayer, AudioBackend, SoundEffect } from './audio'

/** The subset of Web Audio this needs, so the module can be typed without DOM. */
export interface AudioContextLike {
  readonly currentTime: number
  readonly destination: unknown
  readonly sampleRate: number
  readonly state: string
  createGain(): GainNodeLike
  createOscillator(): OscillatorNodeLike
  createBiquadFilter(): BiquadFilterLike
  createStereoPanner(): StereoPannerLike
  createBufferSource(): BufferSourceLike
  createBuffer(channels: number, length: number, sampleRate: number): AudioBufferLike
  resume(): Promise<void>
  close(): Promise<void>
}

export interface AudioParamLike {
  value: number
  setValueAtTime(value: number, when: number): void
  linearRampToValueAtTime(value: number, when: number): void
  exponentialRampToValueAtTime(value: number, when: number): void
}

export interface NodeLike {
  connect(destination: unknown): unknown
  disconnect(): void
}

export interface GainNodeLike extends NodeLike {
  readonly gain: AudioParamLike
}

export interface OscillatorNodeLike extends NodeLike {
  type: string
  readonly frequency: AudioParamLike
  start(when?: number): void
  stop(when?: number): void
}

export interface BiquadFilterLike extends NodeLike {
  type: string
  readonly frequency: AudioParamLike
  readonly Q: AudioParamLike
}

export interface StereoPannerLike extends NodeLike {
  readonly pan: AudioParamLike
}

export interface AudioBufferLike {
  getChannelData(channel: number): Float32Array
}

export interface BufferSourceLike extends NodeLike {
  buffer: AudioBufferLike | null
  loop: boolean
  start(when?: number): void
  stop(when?: number): void
}

/** Base frequency of each ambient layer, in Hz. */
const LAYER_TONE: Readonly<Record<AmbientLayer, number>> = {
  room: 55,
  unease: 82.5,
  tension: 123.5,
  alarm: 440,
}

/** How much the second oscillator is detuned, in Hz. The beat is the unease. */
const LAYER_DETUNE: Readonly<Record<AmbientLayer, number>> = {
  room: 0.3,
  unease: 1.1,
  tension: 2.4,
  alarm: 0,
}

interface Layer {
  readonly gain: GainNodeLike
  readonly nodes: readonly NodeLike[]
}

/** One-shot shapes: duration in seconds, and the voice that makes them. */
const ONE_SHOT: Readonly<
  Record<SoundEffect, { readonly seconds: number; readonly frequency: number; readonly noise: boolean }>
> = {
  door_open: { seconds: 0.18, frequency: 220, noise: true },
  door_close: { seconds: 0.14, frequency: 160, noise: true },
  door_locked: { seconds: 0.09, frequency: 320, noise: false },
  alarm: { seconds: 0.7, frequency: 660, noise: false },
  fight: { seconds: 0.25, frequency: 110, noise: true },
  construction: { seconds: 0.3, frequency: 90, noise: true },
  cell_slam: { seconds: 0.22, frequency: 70, noise: true },
  whistle: { seconds: 0.2, frequency: 1400, noise: false },
}

/**
 * Synthesises the mixer's instructions.
 *
 * Holds one persistent chain per ambient layer and creates a short-lived chain
 * per one-shot, which the browser garbage-collects once it has stopped.
 */
export class WebAudioBackend implements AudioBackend {
  readonly #context: AudioContextLike
  readonly #master: GainNodeLike
  readonly #layers = new Map<AmbientLayer, Layer>()
  #noiseBuffer: AudioBufferLike | null = null

  constructor(context: AudioContextLike) {
    this.#context = context
    this.#master = context.createGain()
    this.#master.gain.value = 1
    this.#master.connect(context.destination)
  }

  setLayerGain(layer: AmbientLayer, gain: number): void {
    const existing = this.#layers.get(layer) ?? this.#createLayer(layer)
    const now = this.#context.currentTime
    // A short ramp rather than a jump: danger moves a point at a time and a
    // stepped gain is audible as a click.
    existing.gain.gain.setValueAtTime(existing.gain.gain.value, now)
    existing.gain.gain.linearRampToValueAtTime(gain, now + 0.25)
  }

  playOneShot(effect: SoundEffect, gain: number, pan: number): void {
    const shape = ONE_SHOT[effect]
    const now = this.#context.currentTime
    const context = this.#context

    const panner = context.createStereoPanner()
    panner.pan.value = pan
    panner.connect(this.#master)

    const envelope = context.createGain()
    envelope.gain.setValueAtTime(0, now)
    // A 5 ms attack, because an instantaneous one is a click on every voice.
    envelope.gain.linearRampToValueAtTime(gain, now + 0.005)
    envelope.gain.linearRampToValueAtTime(0, now + shape.seconds)
    envelope.connect(panner)

    if (shape.noise) {
      const source = context.createBufferSource()
      source.buffer = this.#noise()
      source.loop = true
      const filter = context.createBiquadFilter()
      filter.type = 'bandpass'
      filter.frequency.value = shape.frequency
      filter.Q.value = 1.2
      source.connect(filter)
      filter.connect(envelope)
      source.start(now)
      source.stop(now + shape.seconds)
      return
    }

    const oscillator = context.createOscillator()
    oscillator.type = 'triangle'
    oscillator.frequency.value = shape.frequency
    oscillator.connect(envelope)
    oscillator.start(now)
    oscillator.stop(now + shape.seconds)
  }

  stopAll(): void {
    for (const layer of this.#layers.values()) {
      for (const node of layer.nodes) node.disconnect()
      layer.gain.disconnect()
    }
    this.#layers.clear()
  }

  #createLayer(layer: AmbientLayer): Layer {
    const context = this.#context
    const gain = context.createGain()
    gain.gain.value = 0
    gain.connect(this.#master)

    const nodes: NodeLike[] = []

    if (layer === 'room') {
      // Filtered noise: the building's own hum.
      const source = context.createBufferSource()
      source.buffer = this.#noise()
      source.loop = true
      const filter = context.createBiquadFilter()
      filter.type = 'lowpass'
      filter.frequency.value = 220
      source.connect(filter)
      filter.connect(gain)
      source.start(0)
      nodes.push(source, filter)
    } else {
      // A detuned pair. The beat frequency between them is what unsettles.
      const base = LAYER_TONE[layer]
      const detune = LAYER_DETUNE[layer]
      for (const offset of [0, detune]) {
        const oscillator = context.createOscillator()
        oscillator.type = layer === 'alarm' ? 'square' : 'sine'
        oscillator.frequency.value = base + offset
        oscillator.connect(gain)
        oscillator.start(0)
        nodes.push(oscillator)
      }
    }

    const created: Layer = { gain, nodes }
    this.#layers.set(layer, created)
    return created
  }

  /**
   * One second of white noise, generated once and looped.
   *
   * Deterministic rather than `Math.random`: nothing here is simulation state,
   * but a reproducible buffer means two runs sound identical, which makes an
   * audio regression something a person can actually notice.
   */
  #noise(): AudioBufferLike {
    if (this.#noiseBuffer !== null) return this.#noiseBuffer

    const sampleRate = this.#context.sampleRate
    const buffer = this.#context.createBuffer(1, sampleRate, sampleRate)
    const data = buffer.getChannelData(0)

    // A 32-bit LCG, seeded fixed. Cheap, and good enough for noise.
    let state = 0x9e37_79b9
    for (let i = 0; i < data.length; i += 1) {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0
      data[i] = (state / 0xffff_ffff) * 2 - 1
    }

    this.#noiseBuffer = buffer
    return buffer
  }
}
