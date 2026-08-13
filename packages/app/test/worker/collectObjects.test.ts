import { describe, expect, it } from 'vitest'

import { createInmateWorld, loadGameData, placeObject } from '@blockwork/sim'
import type { SnapshotEntity } from '@blockwork/sim'

import {
  SNAPSHOT_OBJECT_ID_FLAG,
  collectGameEntities,
  isObjectSnapshotId,
  snapshotEntityToRenderObject,
} from '../../src/worker/collectAgents'

const DATA = loadGameData()

class NoopEvents {
  emit(): void {}
}

function putFloor(world: ReturnType<typeof createInmateWorld>, x: number, y: number): void {
  const index = world.grid.idx(x, y)
  world.grid.setAt('floorMaterial', index, world.materials.indexOf('concrete_floor'))
  world.grid.setAt('outdoors', index, 0)
  world.grid.setAt('owned', index, 1)
}

describe('collectGameEntities objects (T8.2)', () => {
  it('packs placed furniture so the main thread can rebuild RenderObjects', () => {
    const world = createInmateWorld({ size: 16, data: DATA })
    putFloor(world, 4, 4)
    putFloor(world, 5, 4)

    const placed = placeObject(
      { world, data: DATA, events: new NoopEvents(), tick: 0 },
      { x: 4, y: 4 },
      'bed',
      0,
    )
    expect(placed).toBeDefined()

    const out: SnapshotEntity[] = []
    collectGameEntities(world, DATA, 0, out)

    const packed = out.find((entity) => isObjectSnapshotId(entity.id))
    expect(packed).toBeDefined()
    expect((packed?.id ?? 0) & SNAPSHOT_OBJECT_ID_FLAG).toBe(SNAPSHOT_OBJECT_ID_FLAG)

    // Present after the find above.
    const render = snapshotEntityToRenderObject(packed as SnapshotEntity, DATA.objects.ids())
    expect(render).toMatchObject({
      defId: 'bed',
      tileX: 4,
      tileY: 4,
      width: 1,
      height: 1,
      rotation: 0,
    })
    expect(render?.id).toBe(placed?.id)
  })
})
