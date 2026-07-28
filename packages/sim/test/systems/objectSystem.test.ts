import { describe, expect, it } from 'vitest'

import { Simulation, createEmptyWorld } from '../../src/core/simulation'
import { isOperational, placeObject } from '../../src/entities/objects'
import type { ObjectEntity } from '../../src/entities/objects'
import {
  OBJECT_SYSTEM_NAME,
  OBJECT_SYSTEM_PERIOD,
  createObjectSystem,
} from '../../src/systems/objectSystem'
import {
  DATA,
  RecordingSink,
  putRoomShell,
  scenario,
  withUtilities,
} from '../entities/objectFixture'

type Scenario = ReturnType<typeof scenario>

/** Mains powered, 2x1. */
const COOKER = 'cooker'

/** Plumbed, 1x1. */
const TOILET = 'toilet'

const SHELL = { x: 2, y: 2, width: 8, height: 8 }

function place(run: Scenario, x: number, y: number, objectDefId: string): ObjectEntity {
  const entity = placeObject(run.objectDeps(), { x, y }, objectDefId, 0)
  if (entity === undefined) {
    throw new Error(`placing '${objectDefId}' failed: ${run.events.reasons().join(', ')}`)
  }
  return entity
}

function step(run: Scenario, ticks: number): void {
  for (let i = 0; i < ticks; i += 1) run.sim.step()
}

describe('objectSystem (PRD 4.4 slot 10)', () => {
  it('runs once an in-game minute, as the PRD period table says', () => {
    const system = createObjectSystem({ data: DATA })

    expect(system.name).toBe(OBJECT_SYSTEM_NAME)
    expect(system.period).toBe(10)
    expect(OBJECT_SYSTEM_PERIOD).toBe(10)
  })

  it('leaves every object supplied while utilitiesEnabled is off', () => {
    const run = scenario()
    putRoomShell(run, SHELL)
    const cooker = place(run, 4, 4, COOKER)
    const toilet = place(run, 4, 6, TOILET)

    step(run, OBJECT_SYSTEM_PERIOD * 3)

    expect(cooker.object.hasPower).toBe(true)
    expect(toilet.object.hasWater).toBe(true)
    expect(isOperational(cooker)).toBe(true)
    expect(run.events.of('objects.unsupplied')).toHaveLength(0)
  })

  it('reports an object that is short of the utility it asks for', () => {
    // The Phase 4 seam: with the grids switched on, `powerGridId` and
    // `waterGridId` still read zero everywhere, so demand goes unmet and says
    // so. T5.5 fills the grids in and these objects come back on.
    const run = scenario({ data: withUtilities(true) })
    putRoomShell(run, SHELL)

    const cooker = place(run, 4, 4, COOKER)
    const toilet = place(run, 4, 6, TOILET)
    expect(cooker.object.hasPower).toBe(false)
    expect(toilet.object.hasWater).toBe(false)

    step(run, OBJECT_SYSTEM_PERIOD)

    expect(isOperational(cooker)).toBe(false)
    expect(isOperational(toilet)).toBe(false)
    // Placement already recorded them as unsupplied, so the system has no
    // transition to report.
    expect(run.events.of('objects.unsupplied')).toHaveLength(0)
  })

  it('emits once when an object loses supply, not once a minute forever', () => {
    const run = scenario({ data: withUtilities(true) })
    putRoomShell(run, SHELL)

    const cooker = place(run, 4, 4, COOKER)
    // Stand the object up as if a live grid had reached it, the way T5.5 will.
    run.world.grid.set('powerGridId', 4, 4, 7)
    step(run, OBJECT_SYSTEM_PERIOD)
    expect(cooker.object.hasPower).toBe(true)

    run.world.grid.set('powerGridId', 4, 4, 0)
    step(run, OBJECT_SYSTEM_PERIOD)
    expect(cooker.object.hasPower).toBe(false)

    const first = run.events.of('objects.unsupplied')
    expect(first).toHaveLength(1)
    expect(first[0]?.causeIds).toEqual([cooker.id])

    step(run, OBJECT_SYSTEM_PERIOD * 5)
    expect(run.events.of('objects.unsupplied')).toHaveLength(1)
  })

  it('picks supply back up when the grid returns', () => {
    const run = scenario({ data: withUtilities(true) })
    putRoomShell(run, SHELL)
    const cooker = place(run, 4, 4, COOKER)

    run.world.grid.set('powerGridId', 4, 4, 3)
    step(run, OBJECT_SYSTEM_PERIOD)

    expect(cooker.object.hasPower).toBe(true)
    // Regaining supply is not a failure, so it is not a CausalEvent of its own.
    expect(run.events.of('objects.unsupplied')).toHaveLength(0)
  })

  it('reports a world with no object registry once, not once a minute', () => {
    const events = new RecordingSink()
    const sim = new Simulation({
      seed: 1,
      world: createEmptyWorld(),
      systems: [createObjectSystem({ data: DATA })],
      events,
    })

    for (let i = 0; i < OBJECT_SYSTEM_PERIOD * 4; i += 1) sim.step()

    expect(events.reasons()).toEqual(['wrong-world'])
  })
})
