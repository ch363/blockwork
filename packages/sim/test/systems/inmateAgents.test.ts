/**
 * T8.20 — InmateAgentStore facade over live inmate shells.
 */

import { describe, expect, it } from 'vitest'

import { loadGameData } from '../../src/data/loader'
import { InmateRegistry, createInmateShell, generateInmate } from '../../src/entities/inmate'
import { EscortJobQueue } from '../../src/entities/staff'
import { Rng } from '../../src/core/rng'
import { ACCESS } from '../../src/pathfinding/regionGraph'
import {
  InmateAgentStore,
  isInmateEscorted,
  syncInmateMotion,
} from '../../src/systems/inmateAgents'

const DATA = loadGameData()
const SPEED = DATA.balance.pathfinding.speedsWorldUnitsPerTick.inmate
const TILE_UNITS = DATA.balance.map.tileWorldUnits

function addInmate(registry: InmateRegistry, id: number): void {
  const rng = new Rng(0xb10c_8020).stream('inmateAgents')
  const component = generateInmate({ data: DATA, rng, category: 'medium' })
  registry.add(createInmateShell({ id, data: DATA, inmate: component, tx: 3, ty: 4 }))
}

describe('inmateAgents', () => {
  it('syncInmateMotion keeps access mask and speed aligned', () => {
    const registry = new InmateRegistry()
    addInmate(registry, 1)
    const entity = registry.get(1)
    if (entity === undefined) throw new Error('missing inmate')

    entity.accessMask = 0
    entity.speed = 0
    syncInmateMotion(entity, SPEED)

    expect(entity.accessMask).toBe(ACCESS.INMATE)
    expect(entity.speed).toBe(SPEED)
  })

  it('isInmateEscorted is true only while an escort job is actively moving', () => {
    const escorts = new EscortJobQueue()
    const queued = escorts.enqueue({
      inmateId: 7,
      destinationTile: 10,
      purpose: 'cell_assignment',
    })
    expect(isInmateEscorted(escorts, 7)).toBe(false)

    queued.state = 'approach_inmate'
    expect(isInmateEscorted(escorts, 7)).toBe(true)

    queued.state = 'escort_to_destination'
    expect(isInmateEscorted(escorts, 7)).toBe(true)

    queued.state = 'completed'
    expect(isInmateEscorted(escorts, 7)).toBe(false)
  })

  it('InmateAgentStore omits escorted inmates from all() and get()', () => {
    const inmates = new InmateRegistry()
    const escorts = new EscortJobQueue()
    addInmate(inmates, 1)
    addInmate(inmates, 2)

    const store = new InmateAgentStore({
      inmates,
      escorts,
      tileWorldUnits: TILE_UNITS,
      inmateSpeed: SPEED,
    })

    expect(store.all()).toHaveLength(2)
    expect(store.get(1)?.id).toBe(1)

    const job = escorts.enqueue({ inmateId: 1, destinationTile: 99, purpose: 'other' })
    job.state = 'escort_to_destination'

    expect(store.all()).toHaveLength(1)
    expect(store.all()[0]?.id).toBe(2)
    expect(store.get(1)).toBeUndefined()
    expect(store.get(2)?.id).toBe(2)
  })

  it('setGoal clears path state on the backing inmate shell', () => {
    const inmates = new InmateRegistry()
    const escorts = new EscortJobQueue()
    addInmate(inmates, 5)
    const entity = inmates.get(5)
    if (entity === undefined) throw new Error('missing inmate')

    entity.path = [1, 2, 3]
    entity.pathIndex = 2
    entity.awaitingPath = true

    const store = new InmateAgentStore({
      inmates,
      escorts,
      tileWorldUnits: TILE_UNITS,
      inmateSpeed: SPEED,
    })
    store.setGoal(5, 42)

    expect(entity.goalTile).toBe(42)
    expect(entity.path).toBeNull()
    expect(entity.pathIndex).toBe(0)
    expect(entity.awaitingPath).toBe(false)
  })
})
