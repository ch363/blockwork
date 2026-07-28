/**
 * Live InmateWorld ↔ SaveState capture/restore for Phase 4 fields.
 */

import { describe, expect, it } from 'vitest'

import { loadGameData } from '../../src/data/loader'
import { captureInmateWorld } from '../../src/save/fromWorld'
import { restoreInmateWorld } from '../../src/save/toWorld'
import { createInmateWorld } from '../../src/systems/intakeSystem'
import { isSectorAccessMode } from '../../src/world/sectors'

const data = loadGameData()

describe('InmateWorld save capture / restore (v3)', () => {
  it('round-trips sectors, posts and standing orders', () => {
    const world = createInmateWorld({ size: 32, data })
    const sector = world.sectors.create(data, {
      name: 'Wing A',
      colour: '#112233',
      access: 'secure',
      categories: ['maximum'],
    })
    expect(sector).toBeDefined()
    // Sector create always returns a sector while ids remain.
    if (sector === undefined) throw new Error('expected sector')

    world.sectors.paintTiles(world.grid, [10, 11, 12], sector.id)

    const post = world.posts.createPost({
      name: 'Gate',
      sectorId: sector.id,
      staffRole: 'officer',
      count: 2,
      timeWindows: [{ startHour: 6, endHour: 18 }],
    })
    world.posts.createRoute({
      name: 'Loop',
      staffRole: 'officer',
      count: 1,
      waypoints: [10, 11, 12],
    })

    world.standingOrders.mealQuantity = 'high'
    world.standingOrders.mealVariety = 3
    world.standingOrders.misconduct.contraband.search = false
    world.dangerLevel = 44
    world.lockdownActive = true
    world.misconductWindow.record(50)
    world.misconductWindow.record(60)
    world.fire.intensity[10] = 3
    world.fire.fuel[10] = 8
    world.fire.smoke[11] = 2
    world.contraband.addStash(10, 'lighter', 0)
    world.power.hasCable[20] = 1
    world.power.hasCable[21] = 1
    world.water.hasPipe[30] = 1

    const captured = captureInmateWorld(world, {
      seed: 7,
      playedTicks: 1_000,
      rngState: { seed: 7, streams: [] },
    })

    expect(captured.sectors.sectors).toHaveLength(1)
    expect(captured.sectors.sectors[0]?.name).toBe('Wing A')
    expect(captured.posts.posts).toHaveLength(1)
    expect(captured.posts.routes).toHaveLength(1)
    expect(captured.standingOrders.mealQuantity).toBe('high')
    expect(captured.dangerLevel).toBe(44)
    expect(captured.lockdownActive).toBe(true)
    expect(captured.misconductWindowTicks).toEqual([50, 60])
    expect(captured.fire.burning).toEqual([{ tileIndex: 10, intensity: 3, fuel: 8 }])
    expect(captured.contraband.stashes).toHaveLength(1)
    expect(captured.utilities.cableTiles).toEqual([20, 21])
    expect(captured.utilities.pipeTiles).toEqual([30])

    const loaded = createInmateWorld({ size: 32, data })
    // Copy grid sector paint into the new world before restore.
    for (let i = 0; i < world.grid.size * world.grid.size; i += 1) {
      loaded.grid.setAt('sectorId', i, world.grid.getAt('sectorId', i))
    }

    restoreInmateWorld(
      loaded,
      {
        ...captured,
        grid: loaded.grid,
      },
      data,
    )

    expect(loaded.sectors.count).toBe(1)
    const restoredSector = loaded.sectors.get(sector.id)
    expect(restoredSector?.name).toBe('Wing A')
    expect(restoredSector?.access).toBe('secure')
    expect(isSectorAccessMode(restoredSector?.access ?? '')).toBe(true)
    expect(loaded.sectors.tilesOf(sector.id)).toEqual([10, 11, 12])

    expect(loaded.posts.postCount).toBe(1)
    expect(loaded.posts.routeCount).toBe(1)
    expect(loaded.posts.getPost(post.id)?.name).toBe('Gate')
    expect(loaded.posts.getPost(post.id)?.count).toBe(2)

    expect(loaded.standingOrders.mealQuantity).toBe('high')
    expect(loaded.standingOrders.mealVariety).toBe(3)
    expect(loaded.standingOrders.misconduct.contraband.search).toBe(false)

    expect(loaded.dangerLevel).toBe(44)
    expect(loaded.lockdownActive).toBe(true)
    expect(loaded.misconductWindow.serialise()).toEqual([50, 60])
    expect(loaded.fire.intensityAt(10)).toBe(3)
    expect(loaded.fire.smokeAt(11)).toBe(2)
    expect(loaded.contraband.stashes).toHaveLength(1)
    expect(loaded.power.hasCableAt(20)).toBe(true)
    expect(loaded.power.hasCableAt(21)).toBe(true)
    expect(loaded.water.hasPipeAt(30)).toBe(true)

    const recaptured = captureInmateWorld(loaded, {
      seed: 7,
      playedTicks: 1_000,
      rngState: { seed: 7, streams: [] },
    })
    expect(recaptured.sectors).toEqual(captured.sectors)
    expect(recaptured.posts).toEqual(captured.posts)
    expect(recaptured.standingOrders).toEqual(captured.standingOrders)
    expect(recaptured.fire).toEqual(captured.fire)
    expect(recaptured.contraband).toEqual(captured.contraband)
    expect(recaptured.utilities).toEqual(captured.utilities)
    expect(recaptured.dangerLevel).toBe(captured.dangerLevel)
    expect(recaptured.misconductWindowTicks).toEqual(captured.misconductWindowTicks)
  })
})
