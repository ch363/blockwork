/**
 * T6.7 — the synthesis backend, against a stub `AudioContext`.
 *
 * There is no way to assert what something sounds like in a unit test, so what
 * is pinned here is the graph: that each layer builds its voices once and is
 * reused, that a one-shot is a short envelope that stops itself, that the noise
 * buffer is deterministic, and that stopping disconnects everything rather than
 * leaking oscillators for the life of the session.
 */

import { describe, expect, it } from 'vitest'

import { WebAudioBackend } from '../../src/game/webAudioBackend'
import type {
  AudioBufferLike,
  AudioContextLike,
  AudioParamLike,
  BiquadFilterLike,
  BufferSourceLike,
  GainNodeLike,
  OscillatorNodeLike,
  StereoPannerLike,
} from '../../src/game/webAudioBackend'

class StubParam implements AudioParamLike {
  value = 0
  readonly writes: [string, number, number][] = []
  setValueAtTime(value: number, when: number): void {
    this.value = value
    this.writes.push(['set', value, when])
  }
  linearRampToValueAtTime(value: number, when: number): void {
    this.value = value
    this.writes.push(['linear', value, when])
  }
  exponentialRampToValueAtTime(value: number, when: number): void {
    this.value = value
    this.writes.push(['exp', value, when])
  }
}

class StubNode {
  connections = 0
  disconnections = 0
  connect(): unknown {
    this.connections += 1
    return this
  }
  disconnect(): void {
    this.disconnections += 1
  }
}

class StubGain extends StubNode implements GainNodeLike {
  readonly gain = new StubParam()
}

class StubOscillator extends StubNode implements OscillatorNodeLike {
  type = 'sine'
  readonly frequency = new StubParam()
  started = false
  stoppedAt: number | null = null
  start(): void {
    this.started = true
  }
  stop(when?: number): void {
    this.stoppedAt = when ?? 0
  }
}

class StubFilter extends StubNode implements BiquadFilterLike {
  type = 'lowpass'
  readonly frequency = new StubParam()
  readonly Q = new StubParam()
}

class StubPanner extends StubNode implements StereoPannerLike {
  readonly pan = new StubParam()
}

class StubSource extends StubNode implements BufferSourceLike {
  buffer: AudioBufferLike | null = null
  loop = false
  started = false
  stoppedAt: number | null = null
  start(): void {
    this.started = true
  }
  stop(when?: number): void {
    this.stoppedAt = when ?? 0
  }
}

class StubContext implements AudioContextLike {
  currentTime = 0
  readonly destination = {}
  readonly sampleRate = 48_000
  readonly state = 'running'

  readonly gains: StubGain[] = []
  readonly oscillators: StubOscillator[] = []
  readonly filters: StubFilter[] = []
  readonly panners: StubPanner[] = []
  readonly sources: StubSource[] = []
  buffersCreated = 0

  createGain(): GainNodeLike {
    const node = new StubGain()
    this.gains.push(node)
    return node
  }
  createOscillator(): OscillatorNodeLike {
    const node = new StubOscillator()
    this.oscillators.push(node)
    return node
  }
  createBiquadFilter(): BiquadFilterLike {
    const node = new StubFilter()
    this.filters.push(node)
    return node
  }
  createStereoPanner(): StereoPannerLike {
    const node = new StubPanner()
    this.panners.push(node)
    return node
  }
  createBufferSource(): BufferSourceLike {
    const node = new StubSource()
    this.sources.push(node)
    return node
  }
  createBuffer(_channels: number, length: number): AudioBufferLike {
    this.buffersCreated += 1
    const data = new Float32Array(length)
    return { getChannelData: () => data }
  }
  async resume(): Promise<void> {
    return Promise.resolve()
  }
  async close(): Promise<void> {
    return Promise.resolve()
  }
}

describe('the ambient graph', () => {
  it('builds a layer once and reuses it', () => {
    const context = new StubContext()
    const backend = new WebAudioBackend(context)

    backend.setLayerGain('unease', 0.3)
    const afterFirst = context.oscillators.length
    expect(afterFirst).toBeGreaterThan(0)

    backend.setLayerGain('unease', 0.6)
    // The second call moves a gain; it does not build a second voice.
    expect(context.oscillators).toHaveLength(afterFirst)
  })

  it('ramps a gain rather than jumping it', () => {
    const context = new StubContext()
    const backend = new WebAudioBackend(context)

    backend.setLayerGain('tension', 0.4)
    // The master gain is created first, so the layer's is the second.
    const layerGain = context.gains[1]
    const kinds = layerGain?.gain.writes.map(([kind]) => kind) ?? []
    expect(kinds).toContain('linear')
  })

  it('builds the room tone from filtered noise, and the rest from oscillators', () => {
    const context = new StubContext()
    const backend = new WebAudioBackend(context)

    backend.setLayerGain('room', 0.5)
    expect(context.sources.length).toBeGreaterThan(0)
    expect(context.filters.length).toBeGreaterThan(0)
    const noiseSource = context.sources[0]
    expect(noiseSource?.loop).toBe(true)
    expect(noiseSource?.started).toBe(true)

    const oscillatorsBefore = context.oscillators.length
    backend.setLayerGain('tension', 0.5)
    // A detuned pair.
    expect(context.oscillators.length).toBe(oscillatorsBefore + 2)
  })

  it('detunes the pair so the two voices beat against each other', () => {
    const context = new StubContext()
    const backend = new WebAudioBackend(context)

    backend.setLayerGain('unease', 0.5)
    const pair = context.oscillators.slice(-2)
    expect(pair).toHaveLength(2)
    expect(pair[0]?.frequency.value).not.toBe(pair[1]?.frequency.value)
  })

  it('disconnects every node on stop, and rebuilds after', () => {
    const context = new StubContext()
    const backend = new WebAudioBackend(context)

    backend.setLayerGain('room', 0.5)
    const source = context.sources[0]
    backend.stopAll()
    expect(source?.disconnections).toBeGreaterThan(0)

    const before = context.sources.length
    backend.setLayerGain('room', 0.5)
    expect(context.sources.length).toBe(before + 1)
  })
})

describe('one-shots', () => {
  it('is an envelope that stops itself', () => {
    const context = new StubContext()
    const backend = new WebAudioBackend(context)

    backend.playOneShot('whistle', 0.8, 0)
    const oscillator = context.oscillators[context.oscillators.length - 1]
    expect(oscillator?.started).toBe(true)
    // Scheduled to stop rather than left running.
    expect(oscillator?.stoppedAt ?? 0).toBeGreaterThan(0)
  })

  it('opens with a short attack rather than a click', () => {
    const context = new StubContext()
    const backend = new WebAudioBackend(context)

    backend.playOneShot('whistle', 0.8, 0)
    const envelope = context.gains[context.gains.length - 1]
    const writes = envelope?.gain.writes ?? []
    // Starts at zero, ramps to the requested gain, ramps back to zero.
    expect(writes[0]?.[1]).toBe(0)
    expect(writes[1]?.[1]).toBeCloseTo(0.8, 6)
    expect(writes[writes.length - 1]?.[1]).toBe(0)
  })

  it('places the sound with the pan it was given', () => {
    const context = new StubContext()
    const backend = new WebAudioBackend(context)

    backend.playOneShot('fight', 0.5, -0.75)
    expect(context.panners[context.panners.length - 1]?.pan.value).toBeCloseTo(-0.75, 6)
  })

  it('uses noise for the percussive effects and a tone for the rest', () => {
    const context = new StubContext()
    const backend = new WebAudioBackend(context)

    const sourcesBefore = context.sources.length
    backend.playOneShot('cell_slam', 0.5, 0)
    expect(context.sources.length).toBe(sourcesBefore + 1)

    const oscillatorsBefore = context.oscillators.length
    backend.playOneShot('door_locked', 0.5, 0)
    expect(context.oscillators.length).toBe(oscillatorsBefore + 1)
  })
})

describe('the noise buffer', () => {
  it('is generated once and shared', () => {
    const context = new StubContext()
    const backend = new WebAudioBackend(context)

    backend.setLayerGain('room', 0.5)
    backend.playOneShot('fight', 0.5, 0)
    backend.playOneShot('construction', 0.5, 0)

    // One buffer, however many voices want noise.
    expect(context.buffersCreated).toBe(1)
  })
})
