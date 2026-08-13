/**
 * @vitest-environment happy-dom
 */

import { Texture } from 'pixi.js'
import { describe, expect, it } from 'vitest'

import { Camera } from '../../src/camera/camera'
import {
  OBJECT_SHAPES,
  ObjectLayer,
  objectSortY,
} from '../../src/layers/objects'
import type { RenderObject } from '../../src/layers/objects'
import type { SpriteAtlas } from '../../src/sprites/atlas'
import { TILE_SIZE } from '../../src/tiles'

function object(partial: Partial<RenderObject> & Pick<RenderObject, 'id'>): RenderObject {
  return {
    defId: 'bed',
    tileX: 0,
    tileY: 0,
    width: 2,
    height: 1,
    rotation: 0,
    ...partial,
  }
}

/** Avoids canvas 2D, which happy-dom does not provide for atlas painting. */
function testAtlas(): SpriteAtlas {
  return {
    texture: Texture.EMPTY,
    columns: OBJECT_SHAPES.length,
    rows: 1,
    cellPx: 32,
    destroy(): void {
      // Texture.EMPTY is shared; never destroy it.
    },
  }
}

describe('ObjectLayer', () => {
  it('places a setObjects entry into the sprite pool', () => {
    const layer = new ObjectLayer({ mapSize: 64, atlas: testAtlas() })
    layer.setObjects([object({ id: 7, tileX: 4, tileY: 5, defId: 'toilet', width: 1, height: 1 })])

    expect(layer.objectCount).toBe(1)

    const camera = new Camera({
      worldWidth: 64 * TILE_SIZE,
      worldHeight: 64 * TILE_SIZE,
      viewportWidth: 320,
      viewportHeight: 320,
      zoom: 1,
      centre: { x: 4.5 * TILE_SIZE, y: 5.5 * TILE_SIZE },
    })
    layer.update(camera)
    expect(layer.visibleObjectCount).toBe(1)

    layer.destroy()
  })

  it('culls sprites when their chunk leaves the camera frustum', () => {
    const layer = new ObjectLayer({ mapSize: 96, atlas: testAtlas() })
    layer.setObjects([object({ id: 1, tileX: 2, tileY: 2 })])

    const onCamera = new Camera({
      worldWidth: 96 * TILE_SIZE,
      worldHeight: 96 * TILE_SIZE,
      viewportWidth: 256,
      viewportHeight: 256,
      zoom: 1,
      centre: { x: 3 * TILE_SIZE, y: 3 * TILE_SIZE },
    })
    layer.update(onCamera)
    expect(layer.visibleObjectCount).toBe(1)

    const offCamera = new Camera({
      worldWidth: 96 * TILE_SIZE,
      worldHeight: 96 * TILE_SIZE,
      viewportWidth: 256,
      viewportHeight: 256,
      zoom: 1,
      centre: { x: 80 * TILE_SIZE, y: 80 * TILE_SIZE },
    })
    layer.update(offCamera)
    expect(layer.visibleObjectCount).toBe(0)
    expect(layer.objectCount).toBe(1)

    layer.destroy()
  })

  it('sorts by the southern edge of the footprint', () => {
    const north = object({ id: 1, tileX: 0, tileY: 0, width: 1, height: 1 })
    const south = object({ id: 2, tileX: 0, tileY: 0, width: 1, height: 2 })
    expect(objectSortY(south)).toBeGreaterThan(objectSortY(north))
  })
})
