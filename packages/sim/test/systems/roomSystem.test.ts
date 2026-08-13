/**
 * T8.20 — RoomSystem drains construction-stale tiles on the ten-tick cadence.
 */

import { describe, expect, it } from 'vitest'

import { Simulation, createEmptyWorld } from '../../src/core/simulation'
import type { SimulationEvent } from '../../src/core/simulation'
import {
  ROOM_SYSTEM_NAME,
  ROOM_SYSTEM_PERIOD,
  createRoomSystem,
} from '../../src/systems/roomSystem'
import { createConstructionSystem, uniformWorkforce } from '../../src/systems/constructionSystem'
import { designateRoom } from '../../src/world/roomDetection'
import { buildCellBlock, CELL, scenario } from '../world/roomFixture'

class RecordingSink {
  readonly events: SimulationEvent[] = []
  emit(event: SimulationEvent): void {
    this.events.push(event)
  }
}

describe('roomSystem', () => {
  it('runs on the ten-tick cadence after construction', () => {
    const system = createRoomSystem({ data: scenario().data })
    expect(system.name).toBe(ROOM_SYSTEM_NAME)
    expect(system.period).toBe(ROOM_SYSTEM_PERIOD)
    expect(ROOM_SYSTEM_PERIOD).toBe(10)
  })

  it('emits rooms.rejected once when wired to a non-RoomWorld', () => {
    const events = new RecordingSink()
    const sim = new Simulation({
      seed: 1,
      world: createEmptyWorld(),
      systems: [createRoomSystem({ data: scenario().data })],
      events,
    })

    for (let i = 0; i < ROOM_SYSTEM_PERIOD; i += 1) sim.step()

    expect(events.events.filter((event) => event.kind === 'rooms.rejected')).toHaveLength(1)
  })

  it('re-detects rooms whose tiles were marked stale by a structural change', () => {
    const run = scenario()
    const block = buildCellBlock(run, 2, 1)
    designateRoom(run.roomDeps(), block.slab, CELL)
    expect(run.world.rooms.all()).toHaveLength(2)

    const sharedWall = block.sharedWall(0, 0)
    run.world.grid.setAt('wallMaterial', sharedWall, 0)
    run.world.structureChanged(sharedWall)
    expect(run.world.rooms.staleCount).toBeGreaterThan(0)

    const events = new RecordingSink()
    const sim = new Simulation({
      seed: 0xb10c_8020,
      world: run.world,
      systems: [
        createConstructionSystem({ data: run.data, workforce: uniformWorkforce(0) }),
        createRoomSystem({ data: run.data }),
      ],
      events,
    })

    for (let tick = 0; tick < ROOM_SYSTEM_PERIOD; tick += 1) sim.step()

    expect(run.world.rooms.staleCount).toBe(0)
    // Removing the shared wall merges the two cells into one room.
    expect(run.world.rooms.all()).toHaveLength(1)
  })
})
