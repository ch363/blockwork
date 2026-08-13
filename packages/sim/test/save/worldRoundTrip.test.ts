/**
 * Live InmateWorld ↔ SaveState capture/restore for save v5.
 *
 * Acceptance (T8.5): a world saved after N ticks and reloaded produces an
 * identical `world.hashInto` digest — not merely a self-consistent `SaveState`.
 */

import { describe, expect, it } from 'vitest'

import { Fnv1aHasher } from '../../src/core/hash'
import { createGame } from '../../src/core/game'
import { loadGameData } from '../../src/data/loader'
import { createInmateShell } from '../../src/entities/inmate'
import { uniformWorkforce } from '../../src/systems/constructionSystem'
import type { InmateWorld } from '../../src/systems/intakeSystem'
import { decodeSaveFile, deserialiseSave } from '../../src/save/deserialise'
import { captureInmateWorld } from '../../src/save/fromWorld'
import { CURRENT_SAVE_VERSION } from '../../src/save/format'
import { encodeSaveFile, toSaveFile } from '../../src/save/serialise'
import { restoreInmateWorld } from '../../src/save/toWorld'
import { createInmateWorld } from '../../src/systems/intakeSystem'
import { isSectorAccessMode } from '../../src/world/sectors'
import { TILE_FIELDS, type TileGridBuffers } from '../../src/world/tileGrid'

const data = loadGameData()
const CREATED_AT = '2031-03-12T14:05:00.000Z'
const SEED = 0x5a5e_0005

function hashWorld(world: InmateWorld): number {
  const hasher = new Fnv1aHasher()
  world.hashInto(hasher)
  return hasher.digest()
}

function gridBuffers(grid: InmateWorld['grid']): TileGridBuffers {
  const buffers: Partial<Record<(typeof TILE_FIELDS)[number], ArrayBufferLike>> = {}
  for (const field of TILE_FIELDS) {
    const view = grid.array(field)
    buffers[field] = view.buffer
  }
  return buffers as TileGridBuffers
}

function freshWorldFromState(state: ReturnType<typeof captureInmateWorld>): InmateWorld {
  const loaded = createInmateWorld({
    size: state.grid.size,
    data,
    buffers: gridBuffers(state.grid),
  })
  restoreInmateWorld(loaded, state, data)
  return loaded
}

describe('InmateWorld save capture / restore (v5)', () => {
  it('round-trips sectors, posts and standing orders', () => {
    const world = createInmateWorld({ size: 32, data })
    const sector = world.sectors.create(data, {
      name: 'Wing A',
      colour: '#112233',
      access: 'secure',
      categories: ['maximum'],
    })
    expect(sector).toBeDefined()
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
    expect(captured.posts.posts).toHaveLength(1)
    expect(captured.dangerLevel).toBe(44)

    const loaded = freshWorldFromState(captured)

    expect(loaded.sectors.count).toBe(1)
    const restoredSector = loaded.sectors.get(sector.id)
    expect(restoredSector?.name).toBe('Wing A')
    expect(isSectorAccessMode(restoredSector?.access ?? '')).toBe(true)
    expect(loaded.posts.getPost(post.id)?.name).toBe('Gate')
    expect(loaded.dangerLevel).toBe(44)
    expect(loaded.misconductWindow.serialise()).toEqual([50, 60])
  })

  it('preserves inmate history fields through capture and restore', () => {
    const world = createInmateWorld({ size: 24, data, continuousIntake: false })
    const shell = createInmateShell({
      id: 1,
      data,
      tx: 5,
      ty: 5,
      inmate: {
        name: 'Test Inmate',
        portraitSeed: 1,
        category: 'medium',
        convictions: [{ id: 'theft', years: 2 }],
        sentenceHours: 8760,
        servedHours: 100,
        traits: [],
        reputations: [{ id: 'gang_member', revealed: true }],
        needs: new Float32Array(data.needs.size),
        addictions: [{ substance: 'narcotics', strength: 0.6 }],
        suppression: 0,
        entitlement: 0,
        cellId: 0,
        jobId: 'kitchen',
        misconductLog: [
          { tick: 100, kind: 'attackInmate', punishment: 'lockdown', durationHours: 4 },
        ],
        grades: { punishment: 0, reform: 0, security: 0, health: 0 },
        reoffendChance: 0.2,
        status: [],
        health: 100,
        inventory: [],
        money: 0,
        aptitude: 1,
      },
    })
    world.inmates.add(shell)
    while (world.inmates.nextId <= 1) world.inmates.allocateId()

    const captured = captureInmateWorld(world, {
      seed: SEED,
      playedTicks: 500,
      rngState: { seed: SEED, streams: [] },
    })
    const loaded = freshWorldFromState(captured)
    const restored = loaded.inmates.get(1)
    expect(restored).toBeDefined()
    if (restored === undefined) return

    expect(restored.inmate.convictions).toEqual([{ id: 'theft', years: 2 }])
    expect(restored.inmate.reputations).toEqual([{ id: 'gang_member', revealed: true }])
    expect(restored.inmate.addictions).toEqual([{ substance: 'narcotics', strength: 0.6 }])
    expect(restored.inmate.jobId).toBe('kitchen')
    expect(restored.inmate.misconductLog).toHaveLength(1)
  })

  it('matches world.hashInto after N simulation ticks and a byte round-trip', async () => {
    const game = createGame({
      seed: SEED,
      mapSize: 32,
      data,
      workforce: uniformWorkforce(0),
      applyOpening: false,
    })

    const ticks = 600
    for (let i = 0; i < ticks; i += 1) game.simulation.step()

    game.world.addIncome(250)
    game.world.cellGrades.set(2, 3.5)
    game.world.intake.continuous = false
    game.world.intake.requestedCounts.set('medium', 3)
    game.world.staffOnlyRoomIds.add(2)
    game.world.intakeSearchedInmateIds.add(1)

    const beforeHash = hashWorld(game.world)

    const captured = captureInmateWorld(game.world, {
      seed: SEED,
      playedTicks: game.simulation.tick,
      rngState: game.simulation.rng.serialise(),
    })

    const file = toSaveFile(captured, { createdAt: CREATED_AT })
    expect(file.version).toBe(CURRENT_SAVE_VERSION)

    const state = deserialiseSave(await decodeSaveFile(await encodeSaveFile(file)))
    const loaded = freshWorldFromState(state)
    const afterHash = hashWorld(loaded)

    expect(afterHash).toBe(beforeHash)
  })

  it('migrates a v4 save and loads with defaulted runtime fields', async () => {
    const world = createInmateWorld({ size: 16, data })
    const captured = captureInmateWorld(world, {
      seed: SEED,
      playedTicks: 100,
      rngState: { seed: SEED, streams: [] },
    })
    const v4File = { ...toSaveFile(captured, { createdAt: CREATED_AT }), version: 4 }
    const state = deserialiseSave(await decodeSaveFile(await encodeSaveFile(v4File)))
    expect(state.labour.assignments).toEqual([])
    expect(state.morale.value).toBe(100)
    expect(state.needsRuntime.inmates).toEqual([])

    const loaded = freshWorldFromState(state)
    expect(loaded.labour.assignments.size).toBe(0)
    expect(loaded.morale.value).toBe(100)
  })
})
