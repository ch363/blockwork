/**
 * T8.20 — PathingSystem smoke: MobileAgentStore and system metadata.
 */

import { describe, expect, it } from 'vitest'

import { loadGameData } from '../../src/data/loader'
import {
  PATHING_SYSTEM_NAME,
  PATHING_SYSTEM_PERIOD,
  MobileAgentStore,
  createPathingSystem,
} from '../../src/systems/pathingSystem'

const DATA = loadGameData()
const SPEEDS = DATA.balance.pathfinding.speedsWorldUnitsPerTick
const TILE_UNITS = DATA.balance.map.tileWorldUnits

describe('pathingSystem', () => {
  it('runs every tick before movement', () => {
    const system = createPathingSystem({ data: DATA })
    expect(system.name).toBe(PATHING_SYSTEM_NAME)
    expect(system.period).toBe(PATHING_SYSTEM_PERIOD)
    expect(system.scheduler).toBeDefined()
  })

  it('MobileAgentStore spawns and retrieves agents', () => {
    const store = new MobileAgentStore(TILE_UNITS, SPEEDS)
    const agent = store.spawn({ category: 'inmate', tx: 2, ty: 3, goalTile: 99 })

    expect(store.size).toBe(1)
    expect(store.get(agent.id)?.goalTile).toBe(99)
    expect(store.all()[0]?.tx).toBe(2)
  })
})
