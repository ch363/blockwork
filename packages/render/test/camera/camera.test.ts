import { describe, expect, it } from 'vitest'

import {
  Camera,
  DEFAULT_CAMERA_MARGIN,
  MAX_ZOOM,
  MIN_ZOOM,
  ZOOM_STOPS,
  nearestZoomStop,
  zoomStopFrom,
} from '../../src/camera/camera'
import { TILE_SIZE } from '../../src/tiles'

/**
 * The camera is the only part of the renderer with logic worth testing without
 * a GPU, so it carries the whole of T0.5's unit coverage: the screen-to-world
 * conversion the input layer depends on, and the clamping that decides where
 * the player is allowed to look.
 *
 * The reference viewport is PRD 6.1's 1194x834pt iPad landscape, and the
 * reference map is Large, 220x220 tiles, from the ticket's acceptance case.
 */

const VIEWPORT_WIDTH = 1194
const VIEWPORT_HEIGHT = 834
const MAP_TILES = 220
const WORLD_SIZE = MAP_TILES * TILE_SIZE

function makeCamera(overrides: Partial<ConstructorParameters<typeof Camera>[0]> = {}): Camera {
  return new Camera({
    worldWidth: WORLD_SIZE,
    worldHeight: WORLD_SIZE,
    viewportWidth: VIEWPORT_WIDTH,
    viewportHeight: VIEWPORT_HEIGHT,
    ...overrides,
  })
}

describe('zoom stops (PRD 2.3)', () => {
  it('offers exactly four levels, ascending', () => {
    expect([...ZOOM_STOPS]).toEqual([0.5, 1, 2, 4])
    expect(MIN_ZOOM).toBe(0.5)
    expect(MAX_ZOOM).toBe(4)
  })

  it('rounds to the nearest stop on a log scale, so 0.7 is closer to 0.5 than to 1', () => {
    expect(nearestZoomStop(0.5)).toBe(0.5)
    expect(nearestZoomStop(0.69)).toBe(0.5)
    expect(nearestZoomStop(0.72)).toBe(1)
    expect(nearestZoomStop(2.9)).toBe(4)
    expect(nearestZoomStop(2.7)).toBe(2)
  })

  it('clamps out-of-range zooms onto the ladder', () => {
    expect(nearestZoomStop(0.01)).toBe(0.5)
    expect(nearestZoomStop(99)).toBe(4)
  })

  it('steps between stops and saturates at both ends', () => {
    expect(zoomStopFrom(1, 1)).toBe(2)
    expect(zoomStopFrom(1, -1)).toBe(0.5)
    expect(zoomStopFrom(1.4, 1)).toBe(2)
    expect(zoomStopFrom(0.5, -1)).toBe(0.5)
    expect(zoomStopFrom(4, 1)).toBe(4)
    expect(zoomStopFrom(0.5, 3)).toBe(4)
  })
})

describe('screen to world conversion', () => {
  it('puts the camera centre under the middle of the viewport', () => {
    const camera = makeCamera()
    camera.moveTo(1000, 2000)

    expect(camera.screenToWorld(VIEWPORT_WIDTH / 2, VIEWPORT_HEIGHT / 2)).toEqual({
      x: 1000,
      y: 2000,
    })
    expect(camera.worldToScreen(1000, 2000)).toEqual({
      x: VIEWPORT_WIDTH / 2,
      y: VIEWPORT_HEIGHT / 2,
    })
  })

  it('scales screen offsets by the zoom', () => {
    const camera = makeCamera({ zoom: 2 })
    camera.moveTo(3000, 3000)

    // 100 CSS pixels right of centre at zoom 2 is 50 world units right.
    expect(camera.screenToWorld(VIEWPORT_WIDTH / 2 + 100, VIEWPORT_HEIGHT / 2)).toEqual({
      x: 3050,
      y: 3000,
    })
  })

  it('round-trips at every zoom stop', () => {
    for (const zoom of ZOOM_STOPS) {
      const camera = makeCamera({ zoom })
      camera.moveTo(3520, 3520)

      for (const [screenX, screenY] of [
        [0, 0],
        [VIEWPORT_WIDTH, VIEWPORT_HEIGHT],
        [17, 823],
        [VIEWPORT_WIDTH / 2, VIEWPORT_HEIGHT / 2],
      ]) {
        // Both loops iterate literal tuples, so neither element is undefined.
        const world = camera.screenToWorld(screenX as number, screenY as number)
        const back = camera.worldToScreen(world.x, world.y)

        expect(back.x).toBeCloseTo(screenX as number, 9)
        expect(back.y).toBeCloseTo(screenY as number, 9)
      }
    }
  })

  it('reports the visible rectangle the culler uses', () => {
    const camera = makeCamera({ zoom: 1 })
    camera.moveTo(3520, 3520)

    expect(camera.visibleRect()).toEqual({
      left: 3520 - VIEWPORT_WIDTH / 2,
      right: 3520 + VIEWPORT_WIDTH / 2,
      top: 3520 - VIEWPORT_HEIGHT / 2,
      bottom: 3520 + VIEWPORT_HEIGHT / 2,
    })
  })

  it('halves the visible span when the zoom doubles', () => {
    const near = makeCamera({ zoom: 2 })
    const far = makeCamera({ zoom: 1 })

    const nearRect = near.visibleRect()
    const farRect = far.visibleRect()

    expect(farRect.right - farRect.left).toBeCloseTo((nearRect.right - nearRect.left) * 2, 9)
  })

  it('keeps the centred world point across a viewport resize', () => {
    const camera = makeCamera()
    camera.moveTo(3520, 3520)
    camera.resize(900, 700)

    expect(camera.screenToWorld(450, 350)).toEqual({ x: 3520, y: 3520 })
  })
})

describe('clamping to the map', () => {
  it('stops the view leaving the map by more than the margin', () => {
    const camera = makeCamera({ zoom: 4 })
    camera.moveTo(-100000, -100000)

    const rect = camera.visibleRect()
    expect(rect.left).toBeCloseTo(-DEFAULT_CAMERA_MARGIN, 9)
    expect(rect.top).toBeCloseTo(-DEFAULT_CAMERA_MARGIN, 9)
  })

  it('stops the view at the far edge plus the margin', () => {
    const camera = makeCamera({ zoom: 4 })
    camera.moveTo(100000, 100000)

    const rect = camera.visibleRect()
    expect(rect.right).toBeCloseTo(WORLD_SIZE + DEFAULT_CAMERA_MARGIN, 9)
    expect(rect.bottom).toBeCloseTo(WORLD_SIZE + DEFAULT_CAMERA_MARGIN, 9)
  })

  it('honours a custom margin', () => {
    const camera = makeCamera({ zoom: 4, margin: 0 })
    camera.moveTo(-1, -1)

    expect(camera.visibleRect().left).toBeCloseTo(0, 9)
  })

  it('centres the map on an axis the viewport is wider than', () => {
    // 10 tiles is 320 world units, far narrower than the viewport at any zoom.
    const camera = new Camera({
      worldWidth: 10 * TILE_SIZE,
      worldHeight: 10 * TILE_SIZE,
      viewportWidth: VIEWPORT_WIDTH,
      viewportHeight: VIEWPORT_HEIGHT,
    })

    camera.moveTo(9999, -9999)
    expect(camera.centre).toEqual({ x: 160, y: 160 })
  })

  it('clamps on zoom out, when the same centre suddenly shows more map', () => {
    const camera = makeCamera({ zoom: 4 })
    camera.moveTo(0, 0)
    const closeIn = camera.centre

    camera.setZoom(0.5)

    expect(camera.centre.x).toBeGreaterThan(closeIn.x)
    expect(camera.visibleRect().left).toBeCloseTo(-DEFAULT_CAMERA_MARGIN, 9)
  })

  it('clamps after a resize', () => {
    const camera = makeCamera({ zoom: 1 })
    camera.moveTo(0, 0)
    camera.resize(VIEWPORT_WIDTH * 2, VIEWPORT_HEIGHT * 2)

    expect(camera.visibleRect().left).toBeCloseTo(-DEFAULT_CAMERA_MARGIN, 9)
  })

  it('re-clamps when the map shrinks under it', () => {
    const camera = makeCamera({ zoom: 1 })
    camera.moveTo(WORLD_SIZE, WORLD_SIZE)

    camera.setWorldSize(100 * TILE_SIZE, 100 * TILE_SIZE)

    expect(camera.visibleRect().right).toBeCloseTo(100 * TILE_SIZE + DEFAULT_CAMERA_MARGIN, 9)
  })

  it('rejects a zoom outside the stop range rather than clamping the map to it', () => {
    const camera = makeCamera()
    camera.setZoom(100)
    expect(camera.zoom).toBe(MAX_ZOOM)

    camera.setZoom(0.001)
    expect(camera.zoom).toBe(MIN_ZOOM)
  })
})

describe('panning', () => {
  it('moves the world with the finger when dragging', () => {
    const camera = makeCamera({ zoom: 1 })
    camera.moveTo(3520, 3520)
    camera.dragByScreen(100, 0)

    // Dragging right shows what is to the left, so the camera moves left.
    expect(camera.x).toBe(3420)
  })

  it('moves the camera with the delta when scrolling', () => {
    const camera = makeCamera({ zoom: 1 })
    camera.moveTo(3520, 3520)
    camera.panByScreen(0, 100)

    expect(camera.y).toBe(3620)
  })

  it('converts a screen delta through the zoom', () => {
    const camera = makeCamera({ zoom: 4 })
    camera.moveTo(3520, 3520)
    camera.dragByScreen(400, 0)

    expect(camera.x).toBe(3420)
  })

  it('cannot pan past the clamp', () => {
    const camera = makeCamera({ zoom: 4 })
    camera.moveTo(0, 0)
    const before = camera.centre

    camera.dragByScreen(5000, 5000)

    expect(camera.centre).toEqual(before)
  })
})

describe('zoom anchoring', () => {
  it('keeps the world point under the anchor fixed', () => {
    const camera = makeCamera({ zoom: 1 })
    camera.moveTo(3520, 3520)

    const anchor = { x: 300, y: 200 }
    const before = camera.screenToWorld(anchor.x, anchor.y)
    camera.setZoom(2, anchor)
    const after = camera.screenToWorld(anchor.x, anchor.y)

    expect(after.x).toBeCloseTo(before.x, 6)
    expect(after.y).toBeCloseTo(before.y, 6)
  })

  it('holds the anchor for the whole eased animation, not just its start', () => {
    const camera = makeCamera({ zoom: 1 })
    camera.moveTo(3520, 3520)

    const anchor = { x: 900, y: 700 }
    const before = camera.screenToWorld(anchor.x, anchor.y)
    camera.zoomTo(4, anchor)

    for (let frame = 0; frame < 5; frame += 1) {
      camera.update(16)
      const during = camera.screenToWorld(anchor.x, anchor.y)
      expect(during.x).toBeCloseTo(before.x, 6)
      expect(during.y).toBeCloseTo(before.y, 6)
    }
  })

  it('eases towards the target and arrives', () => {
    const camera = makeCamera({ zoom: 1 })
    camera.zoomTo(4)

    camera.update(16)
    expect(camera.zoom).toBeGreaterThan(1)
    expect(camera.zoom).toBeLessThan(4)

    for (let frame = 0; frame < 100; frame += 1) camera.update(16)
    expect(camera.zoom).toBe(4)
    expect(camera.animating).toBe(false)
  })

  it('jumps straight to the target when easing is off (PRD 7.9)', () => {
    const camera = makeCamera({ zoom: 1, easing: false })
    camera.zoomTo(4)

    expect(camera.zoom).toBe(4)
  })

  it('snaps a continuous pinch onto the nearest stop', () => {
    const camera = makeCamera({ zoom: 1, easing: false })
    camera.setZoom(1.7)
    camera.snapZoomToStop()

    expect(camera.zoom).toBe(2)
  })
})

describe('momentum', () => {
  it('coasts after a flick and comes to rest', () => {
    const camera = makeCamera({ zoom: 1 })
    camera.moveTo(3520, 3520)
    camera.flickByScreen(2, 0)

    camera.update(16)
    expect(camera.x).toBeLessThan(3520)

    for (let frame = 0; frame < 200; frame += 1) camera.update(16)
    expect(camera.momentum).toEqual({ x: 0, y: 0 })
  })

  it('ignores a flick too slow to be intentional', () => {
    const camera = makeCamera({ zoom: 1 })
    camera.flickByScreen(0.001, 0.001)

    expect(camera.momentum).toEqual({ x: 0, y: 0 })
  })

  it('drops momentum on the axis that hits a bound', () => {
    const camera = makeCamera({ zoom: 4 })
    camera.moveTo(0, 3520)
    camera.flickByScreen(20, 0)

    camera.update(16)

    expect(camera.momentum.x).toBe(0)
    expect(camera.visibleRect().left).toBeCloseTo(-DEFAULT_CAMERA_MARGIN, 9)
  })

  it('survives the multi-second frame a backgrounded tab resumes with', () => {
    const camera = makeCamera({ zoom: 1 })
    camera.moveTo(3520, 3520)
    camera.zoomTo(4)

    camera.update(30_000)

    expect(camera.zoom).toBeLessThanOrEqual(4)
    expect(Number.isFinite(camera.x)).toBe(true)
    expect(Number.isFinite(camera.y)).toBe(true)
  })
})

describe('construction', () => {
  it('centres on the map by default', () => {
    expect(makeCamera().centre).toEqual({ x: WORLD_SIZE / 2, y: WORLD_SIZE / 2 })
  })

  it('rejects a degenerate world or viewport', () => {
    expect(() => makeCamera({ worldWidth: 0 })).toThrow(RangeError)
    expect(() => makeCamera({ viewportHeight: -1 })).toThrow(RangeError)
    expect(() => makeCamera({ margin: -1 })).toThrow(RangeError)
  })
})
