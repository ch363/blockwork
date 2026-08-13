/**
 * The palette of PRD 7.7 (T6.6).
 *
 * "Muted institutional palette: concrete greys, sodium-light amber, cold
 * fluorescent blue-white." This module is the one place those words become
 * numbers, and every sprite in the game is tinted from it.
 *
 * The vocabulary itself — which swatches exist — lives in
 * `packages/sim/data/schemas` as `ART_SWATCHES`, so a content file can pick a
 * swatch but cannot invent a colour. This is the other half: the hex each name
 * resolves to. Splitting it that way means the whole game can be re-tinted by
 * editing one table, and that no `objects.json` entry can quietly drift out of
 * the palette because the only thing it is allowed to name is a swatch.
 *
 * Three rules the values follow, all of them from PRD 7.7:
 *
 *   - **Muted.** Nothing is saturated. The greys carry a slight blue cast and
 *     the warm tones a slight desaturation, so a screen full of them reads as
 *     a building rather than a toy.
 *   - **Readable at default zoom.** Neighbouring swatches differ in *value*,
 *     not only in hue, so the silhouettes stay legible in greyscale — which is
 *     also what makes them survive every colour-blind palette (PRD 7.9).
 *   - **Accents are rare.** `alarm`, `growth` and `utility` are the only
 *     saturated entries and are reserved for things that need to be found.
 */

import type { ArtSwatch } from '@blockwork/sim'

/**
 * Swatch to `0xRRGGBB`.
 *
 * Original values chosen for this project. Nothing here is sampled from any
 * other game (CLAUDE.md rule 1).
 */
export const ART_PALETTE: Readonly<Record<ArtSwatch, number>> = {
  // Concrete greys — the fabric. A cool cast keeps them from reading as mud.
  concrete: 0x5b626d,
  concrete_dark: 0x3c424b,
  concrete_light: 0x7a8391,
  steel: 0x8a94a3,
  steel_dark: 0x646d7b,

  // Warm materials. Desaturated so timber sits beside concrete without shouting.
  timber: 0x8a6f4c,
  timber_dark: 0x5f4c34,
  brick: 0x8a5a48,
  earth: 0x6b5a45,
  turf: 0x53704f,

  // Sodium amber — the institutional light, and anything that signals warmth.
  amber: 0xd0a054,
  amber_dim: 0x9a7a3e,

  // Cold fluorescent blue-white — hygiene, medical, electronics.
  fluorescent: 0xaebfd0,
  ceramic: 0xc3cdd7,
  medical: 0x9fc4cc,

  // Accents. Used sparingly, and never as the only signal (PRD 7.9).
  alarm: 0xc4553f,
  growth: 0x4f8a5c,
  utility: 0xc9a24b,
}

/** Resolves a swatch, falling back to concrete for anything unrecognised. */
export function swatchColour(swatch: string): number {
  const known = (ART_PALETTE as Readonly<Record<string, number>>)[swatch]
  return known ?? ART_PALETTE['concrete']
}

/**
 * Every swatch, for the palette test and for a debug swatch sheet.
 *
 * Read off the table's own keys rather than off `ART_SWATCHES`, because
 * `packages/render` may import `@blockwork/sim` for types only (PRD 7.2). The
 * completeness guarantee is not lost: `ART_PALETTE` is typed
 * `Record<ArtSwatch, number>`, so a swatch added to the vocabulary and not to
 * this table is a compile error rather than a missing entry.
 */
export function paletteEntries(): readonly { readonly swatch: ArtSwatch; readonly colour: number }[] {
  return (Object.keys(ART_PALETTE) as ArtSwatch[])
    .sort()
    .map((swatch) => ({ swatch, colour: ART_PALETTE[swatch] }))
}

/* -------------------------------------------------------------------------- */
/* Value and contrast                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Perceived lightness of a colour, 0..1.
 *
 * Rec. 709 luma. Used to prove the palette stays readable without hue — the
 * property PRD 7.9 depends on and the reason neighbouring swatches are
 * separated by value rather than only by tint.
 */
export function swatchLuma(colour: number): number {
  const r = ((colour >> 16) & 0xff) / 255
  const g = ((colour >> 8) & 0xff) / 255
  const b = (colour & 0xff) / 255
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

/** How saturated a colour is, 0..1. The muted rule is a ceiling on this. */
export function swatchSaturation(colour: number): number {
  const r = ((colour >> 16) & 0xff) / 255
  const g = ((colour >> 8) & 0xff) / 255
  const b = (colour & 0xff) / 255
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  if (max === 0) return 0
  return (max - min) / max
}

/** The three deliberately-saturated accents, for things that must be found. */
export const ACCENT_SWATCHES: readonly ArtSwatch[] = ['alarm', 'growth', 'utility']

/**
 * The sodium lights.
 *
 * PRD 7.7 names "sodium-light amber" as one of the three defining colours, so
 * amber is *supposed* to be the warm, saturated note in an otherwise grey
 * room — it is a light source, not a surface. Grouped with the accents when
 * the muted rule is checked, for the same reason.
 */
export const LIGHT_SWATCHES: readonly ArtSwatch[] = ['amber', 'amber_dim']

/**
 * Swatches allowed to be saturated: the lights and the accents.
 *
 * Everything else is a surface — concrete, steel, timber, brick, earth — and
 * surfaces stay muted, which is what stops the prison reading as a toy.
 */
export const SATURATED_SWATCHES: readonly ArtSwatch[] = [
  ...LIGHT_SWATCHES,
  ...ACCENT_SWATCHES,
]

/** The ceiling the muted surfaces sit under. Earth tones run warm; 0.5 is fair. */
export const MUTED_SATURATION_CEILING = 0.5
