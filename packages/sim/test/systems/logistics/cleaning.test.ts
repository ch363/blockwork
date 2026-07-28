/**
 * T3.5 — dirt accrual rates and cleaning throughput.
 */

import { describe, expect, it } from 'vitest'

import { TICKS_PER_DAY, TICKS_PER_MINUTE } from '../../../src/core/clock'
import type { SimulationEvent } from '../../../src/core/simulation'
import { loadGameData } from '../../../src/data/loader'
import { hireStaff } from '../../../src/entities/staff'
import { meanRoomDirt, computeNeedFill } from '../../../src/entities/needs'
import { createInmateWorld } from '../../../src/systems/intakeSystem'
import type { InmateWorld } from '../../../src/systems/intakeSystem'
import {
  CLEANING_EVENTS,
  accrueAgentPassDirt,
  accrueBloodSpillDirt,
  accrueFoodWasteDirt,
  accrueUrinationDirt,
  cleaningMinutesForDirt,
  countIndoorCleaners,
  updateCleaning,
} from '../../../src/systems/logistics/cleaning'
import { TRACE_KINDS } from '../../../src/trace/causalEvent'
import { refreshPassability } from '../../../src/world/construction'
import type { Rect } from '../../../src/world/construction'
import { initialLockState } from '../../../src/world/doors'
import { designateRoom } from '../../../src/world/roomDetection'

const DATA = loadGameData()
const DIRT = DATA.balance.logistics.dirt
const CLEANING = DATA.balance.logistics.cleaning

class RecordingSink {
  readonly events: SimulationEvent[] = []
  emit(event: SimulationEvent): void {
    this.events.push(event)
  }
  of(kind: string): SimulationEvent[] {
    return this.events.filter((event) => event.kind === kind)
  }
}

function putFloor(world: InmateWorld, x: number, y: number): number {
  const floor = world.data.balance.construction.foundationFloorMaterial
  const index = world.grid.idx(x, y)
  world.grid.setAt('floorMaterial', index, world.materials.indexOf(floor))
  world.grid.setAt('outdoors', index, 0)
  refreshPassability(world, world.data, index)
  world.structureChanged(index)
  return index
}

function putWall(world: InmateWorld, x: number, y: number): number {
  const index = putFloor(world, x, y)
  world.grid.setAt('wallMaterial', index, world.materials.indexOf('brick_wall'))
  refreshPassability(world, world.data, index)
  world.structureChanged(index)
  return index
}

function putDoor(world: InmateWorld, x: number, y: number): number {
  const index = putFloor(world, x, y)
  world.grid.setAt('wallMaterial', index, 0)
  world.doors.place(index, 'standard', initialLockState(world.data.doors.get('standard')))
  refreshPassability(world, world.data, index)
  world.structureChanged(index)
  return index
}

function putRoomShell(world: InmateWorld, rect: Rect): void {
  for (let y = rect.y; y < rect.y + rect.height; y += 1) {
    for (let x = rect.x; x < rect.x + rect.width; x += 1) {
      const onEdge =
        x === rect.x ||
        y === rect.y ||
        x === rect.x + rect.width - 1 ||
        y === rect.y + rect.height - 1
      if (onEdge) {
        const midX = x === Math.floor(rect.x + rect.width / 2)
        const midY = y === Math.floor(rect.y + rect.height / 2)
        const onDoor =
          (midX && (y === rect.y || y === rect.y + rect.height - 1)) ||
          (midY && (x === rect.x || x === rect.x + rect.width - 1))
        if (onDoor) putDoor(world, x, y)
        else putWall(world, x, y)
      } else {
        putFloor(world, x, y)
      }
    }
  }
}

function interiorOf(rect: Rect): Rect {
  return {
    x: rect.x + 1,
    y: rect.y + 1,
    width: rect.width - 2,
    height: rect.height - 2,
  }
}

describe('dirt accrual rates', () => {
  it('applies ticket rates and caps at dirt.max', () => {
    const world = createInmateWorld({ size: 16, data: DATA, continuousIntake: false })
    putFloor(world, 4, 4)
    const tile = world.grid.idx(4, 4)

    expect(accrueAgentPassDirt(world, DATA, tile)).toBe(DIRT.perAgentPass)
    expect(world.grid.dirt[tile]).toBe(DIRT.perAgentPass)

    expect(accrueUrinationDirt(world, DATA, tile)).toBe(DIRT.perUrination)
    expect(world.grid.dirt[tile]).toBe(DIRT.perAgentPass + DIRT.perUrination)

    expect(accrueBloodSpillDirt(world, DATA, tile)).toBe(DIRT.perBloodSpill)
    expect(accrueFoodWasteDirt(world, DATA, tile)).toBe(DIRT.perFoodWaste)

    world.grid.setAt('dirt', tile, DIRT.max - 2)
    expect(accrueBloodSpillDirt(world, DATA, tile)).toBe(2)
    expect(world.grid.dirt[tile]).toBe(DIRT.max)
  })

  it('scales agent-pass dirt by floor dirtMultiplier', () => {
    const world = createInmateWorld({ size: 16, data: DATA, continuousIntake: false })
    const tile = world.grid.idx(5, 5)
    world.grid.setAt('floorMaterial', tile, world.materials.indexOf('ceramic_tile'))
    world.grid.setAt('outdoors', tile, 0)
    const added = accrueAgentPassDirt(world, DATA, tile)
    const expected = Math.round(
      DIRT.perAgentPass * (DATA.materials.get('ceramic_tile').dirtMultiplier),
    )
    expect(added).toBe(expected)
    expect(world.grid.dirt[tile]).toBe(expected)
  })
})

describe('cleaning throughput', () => {
  it('cleaning time is proportional to dirt', () => {
    expect(cleaningMinutesForDirt(80, CLEANING.dirtRemovedPerCleanerPerMinute)).toBe(
      80 / CLEANING.dirtRemovedPerCleanerPerMinute,
    )
    expect(cleaningMinutesForDirt(0, CLEANING.dirtRemovedPerCleanerPerMinute)).toBe(0)
  })

  it('indoor cleaners remove dirt each minute; no cleaners emit Trace', () => {
    const events = new RecordingSink()
    const world = createInmateWorld({ size: 32, data: DATA, continuousIntake: false })
    const shell = { x: 2, y: 2, width: 10, height: 8 }
    putRoomShell(world, shell)
    const interior = interiorOf(shell)
    designateRoom(
      { world, data: DATA, events, tick: 0 },
      interior,
      'office',
    )

    const tiles: number[] = []
    for (let y = interior.y; y < interior.y + interior.height; y += 1) {
      for (let x = interior.x; x < interior.x + interior.width; x += 1) {
        const tile = world.grid.idx(x, y)
        world.grid.setAt('dirt', tile, 40)
        tiles.push(tile)
      }
    }

    updateCleaning(world, DATA, events, TICKS_PER_MINUTE)
    expect(events.of(TRACE_KINDS.cleaningNoCleaners).length).toBe(1)
    expect(world.grid.dirt[tiles[0] ?? 0]).toBe(40)

    const hired = hireStaff({
      world,
      defId: 'cleaner',
      events,
      tick: 0,
      tx: interior.x + 1,
      ty: interior.y + 1,
    })
    expect(hired.entity).toBeDefined()
    expect(countIndoorCleaners(world, DATA)).toBe(1)

    const before = world.grid.dirt[tiles[0] ?? 0] ?? 0
    updateCleaning(world, DATA, events, 2 * TICKS_PER_MINUTE)
    const after = world.grid.dirt[tiles[0] ?? 0] ?? 0
    expect(after).toBeLessThan(before)
    expect(world.cleaning.dirtRemoved).toBeGreaterThan(0)
    expect(events.of(CLEANING_EVENTS.tileCleaned).length).toBeGreaterThan(0)
  })

  it('groundskeepers clean outdoor dirt only', () => {
    const events = new RecordingSink()
    const world = createInmateWorld({ size: 24, data: DATA, continuousIntake: false })
    const indoor = world.grid.idx(3, 3)
    const outdoor = world.grid.idx(10, 10)
    putFloor(world, 3, 3)
    world.grid.setAt('dirt', indoor, 50)
    world.grid.setAt('dirt', outdoor, 50)
    // outdoor stays outdoors=1 from createInmateWorld fill

    hireStaff({
      world,
      defId: 'groundskeeper',
      events,
      tick: 0,
      tx: 10,
      ty: 10,
    })

    updateCleaning(world, DATA, events, TICKS_PER_MINUTE)
    expect(world.grid.dirt[indoor]).toBe(50)
    expect(world.grid.dirt[outdoor]).toBeLessThan(50)
  })

  it('without cleaners, sustained footfall drives environment critical within 5 days', () => {
    const world = createInmateWorld({ size: 24, data: DATA, continuousIntake: false })
    const shell = { x: 2, y: 2, width: 8, height: 8 }
    putRoomShell(world, shell)
    const interior = interiorOf(shell)
    const events = new RecordingSink()
    designateRoom({ world, data: DATA, events, tick: 0 }, interior, 'dayroom')

    const roomTiles: number[] = []
    for (let y = interior.y; y < interior.y + interior.height; y += 1) {
      for (let x = interior.x; x < interior.x + interior.width; x += 1) {
        roomTiles.push(world.grid.idx(x, y))
      }
    }

    const critical = DATA.needs.get('environment').thresholds.critical
    const envDef = DATA.needs.get('environment')
    let env = 0
    const fiveDays = 5 * TICKS_PER_DAY

    // One agent pass per indoor tile per minute — no cleaners.
    for (let tick = TICKS_PER_MINUTE; tick <= fiveDays; tick += TICKS_PER_MINUTE) {
      for (const tile of roomTiles) {
        accrueAgentPassDirt(world, DATA, tile)
      }
      const mean = meanRoomDirt(world.grid, world.rooms, roomTiles[0] ?? 0)
      const fill = computeNeedFill(envDef, DATA.balance.needs, {
        lockedUp: false,
        dangerLevel: 0,
        meanRoomDirt: mean,
        nearbyInmateCount: 0,
        temperatureC: 20,
        traits: [],
        addictions: [],
      })
      if (fill.mode === 'set') env = fill.value
      if (env >= critical) break
    }

    expect(env).toBeGreaterThanOrEqual(critical)
  })
})
