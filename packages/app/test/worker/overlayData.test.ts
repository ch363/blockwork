import { describe, expect, it } from 'vitest'

import { DEFAULT_SNAPSHOT_LIMITS } from '@blockwork/sim'

import { SimWorkerLoop } from '../../src/worker/simWorker'
import {
  OVERLAY_REQUEST_MODES,
  encodeOverlayTemperature,
  encodeOverlayUnit,
  stampOverlayHeat,
} from '../../src/worker/overlayData'

function loop(): SimWorkerLoop {
  return new SimWorkerLoop({
    seed: 0xb10c_0601,
    mapSize: 16,
    limits: DEFAULT_SNAPSHOT_LIMITS,
    post: () => undefined,
  })
}

describe('overlay worker data', () => {
  it('returns one byte per tile for all ten PRD modes', () => {
    const worker = loop()
    for (const mode of OVERLAY_REQUEST_MODES) {
      const values = worker.overlay(mode, mode === 'needs' ? 'food' : undefined)
      expect(values, mode).toBeInstanceOf(Uint8Array)
      expect(values, mode).toHaveLength(16 * 16)
    }
  })

  it('uses zero only as transparent and reserves 1..255 for visible values', () => {
    expect(encodeOverlayUnit(-1)).toBe(1)
    expect(encodeOverlayUnit(0)).toBe(1)
    expect(encodeOverlayUnit(0.5)).toBe(128)
    expect(encodeOverlayUnit(1)).toBe(255)
    expect(encodeOverlayUnit(Number.NaN)).toBe(0)
    expect(encodeOverlayTemperature(-10)).toBe(1)
    expect(encodeOverlayTemperature(30)).toBe(255)
  })

  it('uses live sector order rather than sparse ids after a deletion', () => {
    const worker = loop()
    const removed = worker.world.sectors.create(worker.game.data, {
      name: 'Removed sector',
      access: 'shared',
    })
    const survivor = worker.world.sectors.create(worker.game.data, {
      name: 'Surviving sector',
      access: 'shared',
    })
    expect(removed).toBeDefined()
    expect(survivor).toBeDefined()
    if (removed === undefined || survivor === undefined) return

    const tile = worker.world.grid.idx(3, 3)
    worker.world.sectors.paintTiles(worker.world.grid, [tile], survivor.id)
    worker.world.sectors.remove(worker.game.data, worker.world.grid, removed.id)

    expect(worker.overlay('sectors')[tile]).toBe(1)
  })

  it('stamps a clipped, distance-weighted heat shape', () => {
    const heat = new Float32Array(25)
    stampOverlayHeat(heat, 5, 0, 0, 1, 2)

    expect(heat[0]).toBe(1)
    expect(heat[1]).toBeCloseTo(2 / 3)
    expect(heat[2]).toBeCloseTo(1 / 3)
    expect(heat[6]).toBeCloseTo(1 / 3)
    expect(heat[24]).toBe(0)
  })

  it('keeps unseen fog visible and revealed tiles transparent', () => {
    const worker = loop()
    worker.world.directorate.grant('surveillance')
    const before = worker.overlay('fogOfWar')
    expect(before.every((value) => value === 1)).toBe(true)

    worker.world.fog.revealAround(4, 4, 1)
    const after = worker.overlay('fogOfWar')
    expect(after[4 * 16 + 4]).toBe(0)
    expect(after[0]).toBe(1)
  })

  it('returns an empty fog overlay until surveillance is researched', () => {
    const worker = loop()
    const locked = worker.overlay('fogOfWar')
    expect(locked.every((value) => value === 0)).toBe(true)
  })
})
