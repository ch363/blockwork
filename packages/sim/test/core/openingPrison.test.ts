/**
 * T8.4 — a brand-new prison can reach a functional cell.
 *
 * With `stubMaterialDelivery: false`, sites wait on logistics. The opening
 * layout places a dock and enables first-order grace so the Guided Contract's
 * first builds actually finish. This test issues that build sequence headless
 * and asserts a functional cell within a fixed tick budget.
 */

import { describe, expect, it } from 'vitest'

import { TICKS_PER_MINUTE } from '../../src/core/clock'
import { createGame } from '../../src/core/game'
import { loadGameData } from '../../src/data/loader'
import { OBJECT_COMMANDS } from '../../src/entities/objects'
import { uniformWorkforce } from '../../src/systems/constructionSystem'
import { CONSTRUCTION_COMMANDS } from '../../src/world/construction'
import { firstOrderGraceActive } from '../../src/world/opening'
import { ROOM_COMMANDS } from '../../src/world/roomDetection'
import type { Command } from '../../src/index'

const DATA = loadGameData()
const SEED = 0xb10c_0804
const MAP = 48
const WALL = 'brick_wall'

/** Guided Contract first housing step: a 2×3 cell inside a small shell. */
const SHELL = { x: 8, y: 8, width: 4, height: 5 }
const CELL = { x: 9, y: 9, width: 2, height: 3 }

/** Foundations + walls + door + objects, with margin for the minute cadence. */
const TICK_BUDGET = TICKS_PER_MINUTE * 120

function command(type: string, payload: Record<string, unknown>): Command {
  return { type, payload: payload as never, issuedAtTick: 0 }
}

describe('T8.4 opening prison is startable', () => {
  it('places a delivery dock, starter crew and first-order grace on a new map', () => {
    const game = createGame({
      seed: SEED,
      mapSize: MAP,
      data: DATA,
      workforce: uniformWorkforce(0),
    })

    expect(DATA.balance.construction.stubMaterialDelivery).toBe(false)
    expect(game.world.settings.firstOrderGrace).toBe(true)
    expect(firstOrderGraceActive(game.world)).toBe(true)
    expect([...game.world.rooms.all()].some((room) => room.defId === 'dock')).toBe(true)
    expect(
      game.world.staff.all().filter((entity) => entity.staff.defId === 'maintenance').length,
    ).toBeGreaterThanOrEqual(DATA.balance.opening.starterMaintenanceCount)
    expect(game.world.supply.storeUnits('brick_wall')).toBeGreaterThan(0)
  })

  it('builds a functional cell from the Guided Contract sequence within budget', () => {
    const game = createGame({
      seed: SEED,
      mapSize: MAP,
      data: DATA,
      workforce: uniformWorkforce(4),
    })
    const { simulation, world } = game

    const send = (type: string, payload: Record<string, unknown>): void => {
      simulation.enqueue(command(type, payload))
    }

    // Foundation lays floor and perimeter walls — the first Guided Contract
    // housing step after the opening dock is already in place.
    send(CONSTRUCTION_COMMANDS.placeFoundation, { rect: SHELL, material: WALL })
    send(CONSTRUCTION_COMMANDS.placeDoor, {
      tile: { x: SHELL.x, y: SHELL.y + 2 },
      doorType: 'standard',
    })

    for (let i = 0; i < TICK_BUDGET; i += 1) simulation.step()
    expect(world.sites.size).toBe(0)

    send(ROOM_COMMANDS.designateRoom, { rect: CELL, roomDefId: 'cell' })
    send(OBJECT_COMMANDS.placeObject, {
      tile: { x: CELL.x, y: CELL.y },
      objectDefId: 'bed',
      rotation: 0,
    })
    send(OBJECT_COMMANDS.placeObject, {
      tile: { x: CELL.x + 1, y: CELL.y + 1 },
      objectDefId: 'toilet',
      rotation: 0,
    })

    for (let i = 0; i < TICKS_PER_MINUTE * 4; i += 1) simulation.step()

    const cells = [...world.rooms.all()].filter((room) => room.defId === 'cell')
    expect(cells.length).toBeGreaterThanOrEqual(1)
    const cell = cells[0]
    if (cell === undefined) throw new Error('expected a cell')
    const status = world.rooms.statusOf(cell.id)
    expect(status?.functional).toBe(true)
  })

  it('ends first-order grace once a Store is designated', () => {
    const game = createGame({
      seed: SEED,
      mapSize: MAP,
      data: DATA,
      workforce: uniformWorkforce(0),
    })
    expect(firstOrderGraceActive(game.world)).toBe(true)

    // Outdoor store designation is illegal for indoors rooms; paint a small
    // indoor shell first so the designation sticks.
    const storeShell = { x: 2, y: 2, width: 5, height: 5 }
    const floor = DATA.balance.construction.foundationFloorMaterial
    for (let y = storeShell.y; y < storeShell.y + storeShell.height; y += 1) {
      for (let x = storeShell.x; x < storeShell.x + storeShell.width; x += 1) {
        const index = game.world.grid.idx(x, y)
        game.world.grid.setAt('floorMaterial', index, game.world.materials.indexOf(floor))
        game.world.grid.setAt('outdoors', index, 0)
      }
    }
    game.simulation.enqueue(
      command(ROOM_COMMANDS.designateRoom, {
        rect: { x: 3, y: 3, width: 3, height: 3 },
        roomDefId: 'store',
      }),
    )
    game.simulation.step()
    // Construction's minute tick clears grace when a store exists.
    for (let i = 0; i < TICKS_PER_MINUTE; i += 1) game.simulation.step()

    expect([...game.world.rooms.all()].some((room) => room.defId === 'store')).toBe(true)
    expect(firstOrderGraceActive(game.world)).toBe(false)
    expect(game.world.settings.firstOrderGrace).toBe(false)
  })
})
