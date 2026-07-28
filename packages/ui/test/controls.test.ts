/**
 * Pure hit-test and speed-key unit tests (no DOM).
 */

import { describe, expect, it } from 'vitest'

import {
  WORLD_UNITS_PER_TILE,
  cycleSpeed,
  hitTestEntities,
  resolveWorldTap,
  speedFromKeyboard,
} from '../src/index'

describe('hitTestEntities', () => {
  it('prefers the entity on the tapped tile', () => {
    const id = hitTestEntities(
      [
        { id: 1, x: 10.5 * WORLD_UNITS_PER_TILE, y: 4.2 * WORLD_UNITS_PER_TILE },
        { id: 2, x: 3.1 * WORLD_UNITS_PER_TILE, y: 7.8 * WORLD_UNITS_PER_TILE },
      ],
      10,
      4,
    )
    expect(id).toBe(1)
  })

  it('returns null when the tile is empty', () => {
    expect(hitTestEntities([{ id: 1, x: 0, y: 0 }], 5, 5)).toBeNull()
  })

  it('picks the closer of two occupants on the same tile', () => {
    const id = hitTestEntities(
      [
        { id: 10, x: 5.1 * WORLD_UNITS_PER_TILE, y: 5.1 * WORLD_UNITS_PER_TILE },
        { id: 11, x: 5.45 * WORLD_UNITS_PER_TILE, y: 5.45 * WORLD_UNITS_PER_TILE },
      ],
      5,
      5,
    )
    // Tile centre is (5.5, 5.5); id 11 sits nearer it.
    expect(id).toBe(11)
  })

  it('falls through to tile when no entity hits', () => {
    expect(resolveWorldTap([], 1, 1)).toEqual({ kind: 'tile' })
  })
})

describe('speedFromKeyboard', () => {
  it('maps digit keys onto the speed ladder', () => {
    expect(speedFromKeyboard({ key: '3', metaKey: false, ctrlKey: false, altKey: false }, {
      speed: 1,
      resumeSpeed: 1,
    })).toEqual({ speed: 5, resumeSpeed: 5 })
  })

  it('toggles pause on Space', () => {
    expect(
      speedFromKeyboard(
        { key: ' ', metaKey: false, ctrlKey: false, altKey: false },
        { speed: 2, resumeSpeed: 2 },
      ),
    ).toEqual({ speed: 0, resumeSpeed: 2 })

    expect(
      speedFromKeyboard(
        { key: ' ', metaKey: false, ctrlKey: false, altKey: false },
        { speed: 0, resumeSpeed: 5 },
      ),
    ).toEqual({ speed: 5, resumeSpeed: 5 })
  })

  it('ignores chorded keys', () => {
    expect(
      speedFromKeyboard(
        { key: '1', metaKey: true, ctrlKey: false, altKey: false },
        { speed: 1, resumeSpeed: 1 },
      ),
    ).toBeNull()
  })

  it('cycles the ladder', () => {
    expect(cycleSpeed(0)).toBe(1)
    expect(cycleSpeed(20)).toBe(0)
  })
})
