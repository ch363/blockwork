/**
 * @vitest-environment happy-dom
 */

import { describe, expect, it } from 'vitest'

import {
  OVERLAY_MODES,
  OVERLAY_PALETTE_IDS,
  OverlayLayer,
  overlayCategoricalPattern,
  overlayLegendBands,
  parseCssColour,
} from '../../src/layers/overlay'

describe('OverlayLayer', () => {
  it('covers every PRD 6.4 mode', () => {
    expect(OVERLAY_MODES).toEqual([
      'sectors',
      'roomGrade',
      'needs',
      'contrabandRisk',
      'power',
      'water',
      'temperature',
      'cleanliness',
      'guardCoverage',
      'fogOfWar',
    ])
  })

  it('keeps one mesh and one draw call regardless of map size', () => {
    for (const mapSize of [4, 300]) {
      const layer = new OverlayLayer({ mapSize })
      expect(layer.container.children).toHaveLength(1)
      expect(layer.drawCallCount).toBe(0)
      layer.setMode('temperature')
      expect(layer.drawCallCount).toBe(1)
      expect(layer.container.children).toHaveLength(1)
      layer.destroy()
    }
  })

  it('packs one-byte tile values into the RGBA data texture', () => {
    const layer = new OverlayLayer({ mapSize: 2 })
    layer.setMode('roomGrade')
    layer.setData(new Uint8Array([0, 1, 128, 255]))

    expect([...layer.dataTextureBytes]).toEqual([
      0, 0, 0, 0, 1, 0, 0, 255, 128, 0, 0, 255, 255, 0, 0, 255,
    ])
    layer.destroy()
  })

  it('maps sparse sector ids into stable ordinal categories', () => {
    const layer = new OverlayLayer({ mapSize: 2 })
    layer.setSectorIds(new Uint16Array([0, 2, 9, 2]))
    layer.setMode('sectors')
    const bytes = layer.dataTextureBytes
    expect([bytes[0], bytes[4], bytes[8], bytes[12]]).toEqual([0, 1, 2, 1])
    layer.destroy()
  })

  it('clears stale values immediately when the active mode changes', () => {
    const layer = new OverlayLayer({ mapSize: 2 })
    layer.setMode('temperature')
    layer.setData(new Uint8Array([1, 64, 128, 255]))
    layer.setMode('cleanliness')
    expect([...layer.dataTextureBytes]).toEqual(new Array<number>(16).fill(0))
    layer.destroy()
  })

  it('offers shape-labelled legends for every colour-blind palette', () => {
    for (const palette of OVERLAY_PALETTE_IDS) {
      const scalar = overlayLegendBands('needs', palette)
      expect(scalar.map((entry) => entry.pattern)).toEqual(['dots', 'diagonal', 'solid'])
      expect(new Set(scalar.map((entry) => entry.colour)).size).toBe(3)

      const categorical = overlayLegendBands('sectors', palette)
      expect(categorical).toHaveLength(4)
      expect(new Set(categorical.map((entry) => entry.pattern)).size).toBe(4)
    }
    expect(overlayCategoricalPattern(0)).not.toBe(overlayCategoricalPattern(8))
    expect(overlayCategoricalPattern(8)).not.toBe(overlayCategoricalPattern(16))
  })

  it('describes only fog states the worker can emit', () => {
    expect(overlayLegendBands('fogOfWar', 'standard').map((entry) => entry.label)).toEqual([
      'Hidden · clear areas are visible',
    ])
  })

  it('parses CSS colours without non-hex fallbacks', () => {
    expect(parseCssColour('#abc')).toBe(0xaabbcc)
    expect(parseCssColour('#4C9BE8')).toBe(0x4c9be8)
    expect(parseCssColour('red')).toBeNull()
    expect(parseCssColour('#nope')).toBeNull()
  })
})
