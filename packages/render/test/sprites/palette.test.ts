/**
 * T6.6 — the art pass: every definition carries a deliberate appearance, and
 * the palette holds the direction PRD 7.7 sets out.
 */

import { describe, expect, it } from 'vitest'

import {
  ART_PALETTE,
  MUTED_SATURATION_CEILING,
  SATURATED_SWATCHES,
  paletteEntries,
  swatchColour,
  swatchLuma,
  swatchSaturation,
} from '../../src/sprites/palette'
import { appearanceFromDef, objectAppearances } from '../../src/layers/objects'
import { materialAppearances, terrainPaletteFor } from '../../src/layers/terrain'

describe('the palette (PRD 7.7)', () => {
  it('resolves every swatch to a colour in range', () => {
    for (const { swatch, colour } of paletteEntries()) {
      expect(colour, swatch).toBeGreaterThanOrEqual(0)
      expect(colour, swatch).toBeLessThanOrEqual(0xffffff)
    }
    expect(paletteEntries().length).toBeGreaterThan(0)
  })

  it('has no duplicate colours — every swatch is a distinct decision', () => {
    const colours = paletteEntries().map((entry) => entry.colour)
    expect(new Set(colours).size).toBe(colours.length)
  })

  it('keeps every surface muted', () => {
    for (const { swatch, colour } of paletteEntries()) {
      // The lights and the accents are meant to be saturated; surfaces are not.
      if ((SATURATED_SWATCHES as readonly string[]).includes(swatch)) continue
      expect(swatchSaturation(colour), swatch).toBeLessThan(MUTED_SATURATION_CEILING)
    }
  })

  it('makes every light and accent read against the concrete it sits on', () => {
    // The comparison that matters: an accent is found against the *fabric* of
    // the place, which is grey. Comparing it to timber or brick would be
    // asking a green to out-shout a brown, which is not what it is for.
    const greys = ['concrete', 'concrete_dark', 'concrete_light', 'steel', 'steel_dark'] as const
    const greyest = Math.max(...greys.map((swatch) => swatchSaturation(ART_PALETTE[swatch])))

    for (const swatch of SATURATED_SWATCHES) {
      expect(swatchSaturation(ART_PALETTE[swatch]), swatch).toBeGreaterThan(greyest * 2)
    }
  })

  it('lets nothing out-shout the alarm', () => {
    // The loudest colour in the game is the one that means "come here now".
    const loudest = Math.max(...paletteEntries().map((entry) => swatchSaturation(entry.colour)))
    expect(swatchSaturation(ART_PALETTE.alarm)).toBeCloseTo(loudest, 5)
  })

  it('separates the concrete greys by value, not only by hue', () => {
    // What makes the palette survive greyscale, and therefore every
    // colour-blind palette (PRD 7.9).
    const dark = swatchLuma(ART_PALETTE.concrete_dark)
    const mid = swatchLuma(ART_PALETTE.concrete)
    const light = swatchLuma(ART_PALETTE.concrete_light)
    expect(dark).toBeLessThan(mid)
    expect(mid).toBeLessThan(light)
    expect(light - dark).toBeGreaterThan(0.15)
  })

  it('makes amber warm and fluorescent cold, as the direction asks', () => {
    const amber = ART_PALETTE.amber
    const fluorescent = ART_PALETTE.fluorescent
    // Warm: more red than blue. Cold: more blue than red.
    expect((amber >> 16) & 0xff).toBeGreaterThan(amber & 0xff)
    expect(fluorescent & 0xff).toBeGreaterThan((fluorescent >> 16) & 0xff)
  })

  it('falls back to concrete rather than throwing on an unknown swatch', () => {
    expect(swatchColour('octarine')).toBe(ART_PALETTE.concrete)
    expect(swatchColour('amber')).toBe(ART_PALETTE.amber)
  })
})

describe('resolving an appearance', () => {
  it('resolves a declared swatch through the palette', () => {
    const appearance = appearanceFromDef({
      size: { w: 2, h: 1 },
      appearance: { swatch: 'timber', shape: 'wide' },
    })
    expect(appearance.colour).toBe(ART_PALETTE.timber)
    expect(appearance.shape).toBe('wide')
  })

  it('falls back to the footprint class when no shape is declared', () => {
    expect(
      appearanceFromDef({ size: { w: 2, h: 2 }, appearance: { swatch: 'steel' } }).shape,
    ).toBe('block')
    expect(
      appearanceFromDef({ size: { w: 1, h: 1 }, appearance: { swatch: 'steel' } }).shape,
    ).toBe('square')
    expect(
      appearanceFromDef({ size: { w: 1, h: 2 }, appearance: { swatch: 'steel' } }).shape,
    ).toBe('tall')
  })

  it('falls back to concrete for a definition with no appearance at all', () => {
    const appearance = appearanceFromDef({ size: { w: 1, h: 1 } })
    expect(appearance.colour).toBe(ART_PALETTE.concrete)
  })

  it('builds a table keyed by definition id', () => {
    const table = objectAppearances([
      { id: 'bed', size: { w: 2, h: 1 }, appearance: { swatch: 'steel', shape: 'wide' } },
      { id: 'toilet', size: { w: 1, h: 1 }, appearance: { swatch: 'ceramic', shape: 'fixture' } },
    ])
    expect(table.size).toBe(2)
    expect(table.get('toilet')?.colour).toBe(ART_PALETTE.ceramic)
    expect(table.get('toilet')?.shape).toBe('fixture')
  })
})

describe('material appearances', () => {
  it('resolves each material through the palette, keeping its grain', () => {
    const table = materialAppearances([
      { id: 'concrete_floor', appearance: { swatch: 'concrete', grain: 0.05 } },
      { id: 'churned_mud', appearance: { swatch: 'earth', grain: 0.28 } },
    ])
    expect(table.get('concrete_floor')?.colour).toBe(ART_PALETTE.concrete)
    expect(table.get('churned_mud')?.grain).toBe(0.28)
  })

  it('defaults a material that declares nothing', () => {
    const table = materialAppearances([{ id: 'mystery' }])
    expect(table.get('mystery')?.colour).toBe(ART_PALETTE.concrete)
  })

  it('builds a terrain palette in table order, with bare ground at zero', () => {
    const ids = ['concrete_floor', 'grass']
    const palette = terrainPaletteFor(
      ids,
      materialAppearances([
        { id: 'concrete_floor', appearance: { swatch: 'concrete', grain: 0.05 } },
        { id: 'grass', appearance: { swatch: 'turf', grain: 0.14 } },
      ]),
    )

    expect(palette).toHaveLength(ids.length + 1)
    // Index 0 is unbuilt ground, which is not made of any material.
    expect(palette[0]?.colour).toBe(ART_PALETTE.earth)
    expect(palette[1]?.colour).toBe(ART_PALETTE.concrete)
    expect(palette[2]?.colour).toBe(ART_PALETTE.turf)
  })
})
