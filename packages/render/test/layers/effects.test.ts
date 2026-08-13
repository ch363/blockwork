/**
 * @vitest-environment happy-dom
 */

import { Texture } from 'pixi.js'
import { describe, expect, it } from 'vitest'

import { Camera } from '../../src/camera/camera'
import {
  EFFECT_ATLAS_CELL_PX,
  EFFECT_PIN_COLOURS,
  EFFECT_PULSE_FRAMES,
  EffectsLayer,
  effectsPinCell,
  effectsSelectionCell,
} from '../../src/layers/effects'
import type { EffectPin, EffectSelection, EffectPinSeverity } from '../../src/layers/effects'
import type { SpriteAtlas } from '../../src/sprites/atlas'
import { TILE_SIZE } from '../../src/tiles'

const ATLAS_COLUMNS = Math.max(EFFECT_PULSE_FRAMES, 8)
const ATLAS_ROWS = 5

function testAtlas(): SpriteAtlas {
  return {
    texture: Texture.EMPTY,
    columns: ATLAS_COLUMNS,
    rows: ATLAS_ROWS,
    cellPx: EFFECT_ATLAS_CELL_PX,
    destroy(): void {},
  }
}

function selection(partial: Partial<EffectSelection> & Pick<EffectSelection, 'id'>): EffectSelection {
  return {
    x: 100,
    y: 100,
    ...partial,
  }
}

function pin(partial: Partial<EffectPin> & Pick<EffectPin, 'id' | 'subjectId'>): EffectPin {
  return {
    x: 100,
    y: 100,
    severity: 'info',
    ...partial,
  }
}

function camera(mapSize: number, centre?: { x: number; y: number }): Camera {
  return new Camera({
    worldWidth: mapSize * TILE_SIZE,
    worldHeight: mapSize * TILE_SIZE,
    viewportWidth: 320,
    viewportHeight: 320,
    zoom: 1,
    centre: centre ?? { x: 100, y: 100 },
  })
}

describe('EffectsLayer', () => {
  describe('constructor', () => {
    it('creates a layer with a provided atlas', () => {
      const layer = new EffectsLayer({ mapSize: 64, atlas: testAtlas() })
      expect(layer.container.label).toBe('effects')
      expect(layer.mapSize).toBe(64)
      expect(layer.selectionCount).toBe(0)
      expect(layer.pinCount).toBe(0)
      layer.destroy()
    })

    it('rejects invalid mapSize', () => {
      expect(() => new EffectsLayer({ mapSize: 0 })).toThrow(RangeError)
      expect(() => new EffectsLayer({ mapSize: -1 })).toThrow(RangeError)
      expect(() => new EffectsLayer({ mapSize: 1.5 })).toThrow(RangeError)
    })
  })

  describe('selections', () => {
    it('adds and tracks a selection', () => {
      const layer = new EffectsLayer({ mapSize: 64, atlas: testAtlas() })
      layer.setSelection(selection({ id: 1 }))
      expect(layer.selectionCount).toBe(1)
      layer.destroy()
    })

    it('replaces selections with setSelections', () => {
      const layer = new EffectsLayer({ mapSize: 64, atlas: testAtlas() })
      layer.setSelection(selection({ id: 1 }))
      layer.setSelection(selection({ id: 2 }))
      expect(layer.selectionCount).toBe(2)

      layer.setSelections([selection({ id: 3 })])
      expect(layer.selectionCount).toBe(1)
      layer.destroy()
    })

    it('removes a selection by id', () => {
      const layer = new EffectsLayer({ mapSize: 64, atlas: testAtlas() })
      layer.setSelection(selection({ id: 1 }))
      layer.setSelection(selection({ id: 2 }))
      expect(layer.selectionCount).toBe(2)

      layer.removeSelection(1)
      expect(layer.selectionCount).toBe(1)

      layer.removeSelection(1) // idempotent
      expect(layer.selectionCount).toBe(1)
      layer.destroy()
    })

    it('clears all selections', () => {
      const layer = new EffectsLayer({ mapSize: 64, atlas: testAtlas() })
      layer.setSelection(selection({ id: 1 }))
      layer.setSelection(selection({ id: 2 }))
      layer.clearSelections()
      expect(layer.selectionCount).toBe(0)
      layer.destroy()
    })

    it('creates selection sprites on update', () => {
      const layer = new EffectsLayer({ mapSize: 64, atlas: testAtlas() })
      layer.setSelection(selection({ id: 1, x: 50, y: 50 }))

      const cam = camera(64, { x: 50, y: 50 })
      layer.update(cam, 16)

      expect(layer.selectionCount).toBe(1)
      layer.destroy()
    })
  })

  describe('pins', () => {
    it('adds and tracks a pin', () => {
      const layer = new EffectsLayer({ mapSize: 64, atlas: testAtlas() })
      layer.setPin(pin({ id: 'notif-1', subjectId: 100 }))
      expect(layer.pinCount).toBe(1)
      layer.destroy()
    })

    it('removes a pin by id', () => {
      const layer = new EffectsLayer({ mapSize: 64, atlas: testAtlas() })
      layer.setPin(pin({ id: 'notif-1', subjectId: 100 }))
      layer.setPin(pin({ id: 'notif-2', subjectId: 101 }))
      expect(layer.pinCount).toBe(2)

      layer.removePin('notif-1')
      expect(layer.pinCount).toBe(1)
      layer.destroy()
    })

    it('clears all pins', () => {
      const layer = new EffectsLayer({ mapSize: 64, atlas: testAtlas() })
      layer.setPin(pin({ id: 'notif-1', subjectId: 100 }))
      layer.setPin(pin({ id: 'notif-2', subjectId: 101 }))
      layer.clearPins()
      expect(layer.pinCount).toBe(0)
      layer.destroy()
    })

    it('removes pins for a subject', () => {
      const layer = new EffectsLayer({ mapSize: 64, atlas: testAtlas() })
      layer.setPin(pin({ id: 'notif-1', subjectId: 100 }))
      layer.setPin(pin({ id: 'notif-2', subjectId: 100 }))
      layer.setPin(pin({ id: 'notif-3', subjectId: 200 }))
      expect(layer.pinCount).toBe(3)

      layer.removePinsForSubject(100)
      expect(layer.pinCount).toBe(1)
      layer.destroy()
    })

    it('supports all severity levels', () => {
      const layer = new EffectsLayer({ mapSize: 64, atlas: testAtlas() })
      layer.setPin(pin({ id: 'info', subjectId: 1, severity: 'info' }))
      layer.setPin(pin({ id: 'warn', subjectId: 2, severity: 'warn' }))
      layer.setPin(pin({ id: 'critical', subjectId: 3, severity: 'critical' }))
      expect(layer.pinCount).toBe(3)
      layer.destroy()
    })
  })

  describe('path debug', () => {
    it('starts disabled', () => {
      const layer = new EffectsLayer({ mapSize: 64, atlas: testAtlas() })
      expect(layer.pathDebugEnabled).toBe(false)
      layer.destroy()
    })

    it('can be enabled and disabled', () => {
      const layer = new EffectsLayer({ mapSize: 64, atlas: testAtlas() })
      layer.setPathDebugEnabled(true)
      expect(layer.pathDebugEnabled).toBe(true)
      layer.setPathDebugEnabled(false)
      expect(layer.pathDebugEnabled).toBe(false)
      layer.destroy()
    })

    it('accepts path segments', () => {
      const layer = new EffectsLayer({ mapSize: 64, atlas: testAtlas() })
      layer.setDebugPath([
        { fromX: 0, fromY: 0, toX: 100, toY: 100 },
        { fromX: 100, fromY: 100, toX: 200, toY: 50 },
      ])
      layer.clearDebugPath()
      layer.destroy()
    })
  })

  describe('update', () => {
    it('animates pulse frames over time', () => {
      const layer = new EffectsLayer({ mapSize: 64, atlas: testAtlas() })
      layer.setSelection(selection({ id: 1, x: 50, y: 50 }))

      const cam = camera(64, { x: 50, y: 50 })

      layer.update(cam, 0)
      layer.update(cam, 120 * EFFECT_PULSE_FRAMES) // one full cycle

      expect(layer.selectionCount).toBe(1)
      layer.destroy()
    })

    it('culls off-screen selections', () => {
      const layer = new EffectsLayer({ mapSize: 64, atlas: testAtlas() })
      layer.setSelection(selection({ id: 1, x: 50, y: 50 }))

      const nearCam = camera(64, { x: 50, y: 50 })
      layer.update(nearCam, 16)

      const farCam = camera(64, { x: 2000, y: 2000 })
      layer.update(farCam, 16)

      expect(layer.selectionCount).toBe(1)
      layer.destroy()
    })
  })

  describe('destroy', () => {
    it('cleans up resources', () => {
      const layer = new EffectsLayer({ mapSize: 64, atlas: testAtlas() })
      layer.setSelection(selection({ id: 1 }))
      layer.setPin(pin({ id: 'notif-1', subjectId: 1 }))
      layer.destroy()
      expect(layer.selectionCount).toBe(0)
      expect(layer.pinCount).toBe(0)
    })
  })
})

describe('effectsSelectionCell', () => {
  it('cycles through pulse frames', () => {
    const cells = Array.from({ length: EFFECT_PULSE_FRAMES }, (_, i) => effectsSelectionCell(i))
    const unique = new Set(cells)
    expect(unique.size).toBe(EFFECT_PULSE_FRAMES)
  })

  it('wraps around', () => {
    expect(effectsSelectionCell(0)).toBe(effectsSelectionCell(EFFECT_PULSE_FRAMES))
    expect(effectsSelectionCell(1)).toBe(effectsSelectionCell(EFFECT_PULSE_FRAMES + 1))
  })
})

describe('effectsPinCell', () => {
  it('returns different cells for different severities', () => {
    const severities: EffectPinSeverity[] = ['info', 'warn', 'critical']
    const cells = severities.map((s) => effectsPinCell(s, 0))
    const unique = new Set(cells)
    expect(unique.size).toBe(3)
  })

  it('cycles through pulse frames for each severity', () => {
    const severities: EffectPinSeverity[] = ['info', 'warn', 'critical']
    for (const severity of severities) {
      const cells = Array.from({ length: EFFECT_PULSE_FRAMES }, (_, i) => effectsPinCell(severity, i))
      const unique = new Set(cells)
      expect(unique.size).toBe(EFFECT_PULSE_FRAMES)
    }
  })
})

describe('EFFECT_PIN_COLOURS', () => {
  it('defines colours for all severity levels', () => {
    expect(EFFECT_PIN_COLOURS.info).toBeDefined()
    expect(EFFECT_PIN_COLOURS.warn).toBeDefined()
    expect(EFFECT_PIN_COLOURS.critical).toBeDefined()
  })
})
