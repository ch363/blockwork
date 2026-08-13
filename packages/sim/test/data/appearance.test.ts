/**
 * T6.6 — the art pass, checked against the data.
 *
 * The palette itself lives in `packages/render`; what this pins is the half
 * that is content: every object and every material carries a deliberate
 * appearance, and none of them can name a swatch outside the vocabulary.
 *
 * The "90 object sprites" the ticket asks for is a coverage claim about the
 * definitions, so this is where it belongs.
 */

import { describe, expect, it } from 'vitest'

import { loadGameData } from '../../src/data/loader'
import type { GameData } from '../../src/data/loader'
import { ART_SWATCHES, OBJECT_SHAPES } from '../../src/data/schemas'

const DATA: GameData = loadGameData()

describe('object appearances (PRD 7.7)', () => {
  it('covers every definition — no object falls back to a hash', () => {
    const missing = DATA.objects.all
      .filter((def) => def.appearance === undefined)
      .map((def) => def.id)
    expect(missing).toEqual([])
  })

  it('covers the ninety-odd objects the ticket asks for', () => {
    expect(DATA.objects.size).toBeGreaterThanOrEqual(90)
  })

  it('never names a swatch outside the palette', () => {
    for (const def of DATA.objects.all) {
      const swatch = def.appearance?.swatch
      if (swatch === undefined) continue
      expect(ART_SWATCHES, def.id).toContain(swatch)
    }
  })

  it('never names a silhouette the atlas cannot draw', () => {
    for (const def of DATA.objects.all) {
      const shape = def.appearance?.shape
      if (shape === undefined) continue
      expect(OBJECT_SHAPES, def.id).toContain(shape)
    }
  })

  it('spreads across the palette rather than defaulting to one swatch', () => {
    const used = new Set(DATA.objects.all.map((def) => def.appearance?.swatch))
    // More than half the vocabulary is in play, which is what makes a room
    // full of objects readable rather than a wall of identical tints.
    expect(used.size).toBeGreaterThan(ART_SWATCHES.length / 2)
  })

  it('uses every silhouette class', () => {
    const shapes = new Set(
      DATA.objects.all.flatMap((def) => (def.appearance?.shape === undefined ? [] : [def.appearance.shape])),
    )
    expect([...shapes].sort()).toEqual([...OBJECT_SHAPES].sort())
  })

  it('draws plumbing and wall fixtures as fixtures', () => {
    for (const id of ['toilet', 'sink', 'shower_head', 'mirror', 'camera']) {
      expect(DATA.objects.get(id).appearance?.shape, id).toBe('fixture')
    }
  })

  it('reserves the alarm swatch for things that raise an alarm', () => {
    const alarming = DATA.objects.all
      .filter((def) => def.appearance?.swatch === 'alarm')
      .map((def) => def.id)
      .sort()
    expect(alarming).toEqual(['alarm_siren', 'fire_extinguisher'])
  })
})

describe('material appearances (PRD 7.7)', () => {
  it('covers every material', () => {
    const missing = DATA.materials.all
      .filter((def) => def.appearance === undefined)
      .map((def) => def.id)
    expect(missing).toEqual([])
  })

  it('never names a swatch outside the palette', () => {
    for (const def of DATA.materials.all) {
      const swatch = def.appearance?.swatch
      if (swatch === undefined) continue
      expect(ART_SWATCHES, def.id).toContain(swatch)
    }
  })

  it('gives the depressing surfaces the heaviest grain', () => {
    const depressing = DATA.materials.all.filter((def) => def.depressing)
    expect(depressing.length).toBeGreaterThan(0)

    const clean = DATA.materials.all.filter((def) => !def.depressing)
    const worstClean = Math.max(...clean.map((def) => def.appearance?.grain ?? 0))

    for (const def of depressing) {
      // A cracked, rusted or mildewed surface should look it.
      expect(def.appearance?.grain ?? 0, def.id).toBeGreaterThanOrEqual(worstClean)
    }
  })

  it('keeps grain inside 0..1', () => {
    for (const def of DATA.materials.all) {
      const grain = def.appearance?.grain
      if (grain === undefined) continue
      expect(grain, def.id).toBeGreaterThanOrEqual(0)
      expect(grain, def.id).toBeLessThanOrEqual(1)
    }
  })
})
