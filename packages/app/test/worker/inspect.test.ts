/**
 * `sim:inspect`: what the inspector is told about a tile.
 *
 * This is the reply that carries PRD 6.2's room panel — "requirement checklist
 * with pass/fail" — across the worker boundary. Two things have to hold, and
 * neither is obvious from either side alone: the reply must be
 * structured-cloneable, because it crosses a `postMessage`, and it must carry
 * **display names**, because the UI package holds no `GameData` and an id in a
 * panel is a bug the type system cannot see.
 */

import { describe, expect, it } from 'vitest'

import {
  CONSTRUCTION_COMMANDS,
  OBJECT_COMMANDS,
  ROOM_COMMANDS,
  TICKS_PER_MINUTE,
  deliverAll,
  uniformWorkforce,
} from '@blockwork/sim'
import type { Command } from '@blockwork/sim'

import { SimWorkerLoop } from '../../src/worker/simWorker'

const MAP = 40
const SEED = 0xb10c_7001

const SHELL = { x: 8, y: 8, width: 8, height: 7 }
const INSIDE = { x: 9, y: 9, width: 6, height: 5 }

function command(type: string, payload: Record<string, unknown>): Command {
  return { type, payload: payload as never, issuedAtTick: 0 }
}

/** A loop with a shell, a cell zoned inside it, and a bed against the wall. */
function builtLoop(): SimWorkerLoop {
  const loop = new SimWorkerLoop({
    seed: SEED,
    mapSize: MAP,
    post: () => {
      // The transfer transport posts snapshots; nothing here reads them.
    },
    workforce: uniformWorkforce(4),
  })

  loop.enqueue(
    command(CONSTRUCTION_COMMANDS.placeFoundation, { rect: SHELL, material: 'brick_wall' }),
  )
  // The command lands on the first step; sites exist from the second onwards.
  loop.simulation.step()
  // T3.4 made materials real: without a dock and a store nothing is ever
  // carried to a site and the shell never rises. This test is about what the
  // inspector reports, not about logistics, so the bill is settled directly.
  for (const site of loop.world.sites.all()) deliverAll(site)
  for (let i = 0; i < TICKS_PER_MINUTE * 30; i += 1) loop.simulation.step()

  loop.enqueue(command(ROOM_COMMANDS.designateRoom, { rect: INSIDE, roomDefId: 'cell' }))
  loop.enqueue(
    command(OBJECT_COMMANDS.placeObject, {
      tile: { x: INSIDE.x + 1, y: INSIDE.y + 1 },
      objectDefId: 'bed',
      rotation: 0,
    }),
  )
  for (let i = 0; i < TICKS_PER_MINUTE * 2; i += 1) loop.simulation.step()

  return loop
}

describe('SimWorkerLoop.inspect', () => {
  it('describes bare ground outside anything built', () => {
    const loop = builtLoop()
    const result = loop.inspect({ x: 1, y: 1 })

    expect(result.kind).toBe('tile')
    if (result.kind !== 'tile') throw new Error('expected a tile')
    expect(result.floorName).toBe('Bare ground')
    expect(result.wallName).toBeNull()
    expect(result.roomName).toBeNull()
  })

  it('names the wall material on a perimeter tile', () => {
    const loop = builtLoop()
    const result = loop.inspect({ x: SHELL.x, y: SHELL.y })

    expect(result.kind).toBe('tile')
    if (result.kind !== 'tile') throw new Error('expected a tile')
    // The display name from `materials.json`, not the id.
    expect(result.wallName).toBe('Brick')
    expect(result.walkable).toBe(false)
  })

  it('reports a room with its requirement checklist', () => {
    const loop = builtLoop()
    // A floor tile of the cell that no object stands on.
    const result = loop.inspect({ x: INSIDE.x + 4, y: INSIDE.y + 3 })

    expect(result.kind).toBe('room')
    if (result.kind !== 'room') throw new Error('expected a room')

    expect(result.typeName).toBe('Cell')
    expect(result.requirements.length).toBeGreaterThan(0)
    // A bed is in; a toilet is not. Pass and fail on the same list.
    expect(result.requirements.some((entry) => entry.subject === 'bed' && entry.met)).toBe(true)
    expect(result.requirements.some((entry) => entry.subject === 'toilet' && !entry.met)).toBe(true)
    expect(result.functional).toBe(false)
    expect(result.properties).toContain('enclosed')
  })

  it('reports the object standing on a tile in preference to its room', () => {
    const loop = builtLoop()
    const result = loop.inspect({ x: INSIDE.x + 1, y: INSIDE.y + 1 })

    expect(result.kind).toBe('object')
    if (result.kind !== 'object') throw new Error('expected an object')

    expect(result.name).toBe('Bed')
    expect(result.roomName).toBe('Cell')
    expect(result.needsPower).toBe(false)
    expect(result.conditionMax).toBeGreaterThan(0)
    expect(result.needsServed.length).toBeGreaterThan(0)
  })

  it('answers for a tile outside the map without throwing', () => {
    const loop = builtLoop()
    expect(loop.inspect({ x: -5, y: 900 }).kind).toBe('tile')
  })

  it('returns something that survives a structured clone', () => {
    const loop = builtLoop()
    const result = loop.inspect({ x: INSIDE.x + 4, y: INSIDE.y + 3 })

    // The reply crosses a postMessage; a class instance or a function on it
    // would throw there rather than here.
    expect(() => structuredClone(result)).not.toThrow()
    expect(structuredClone(result)).toEqual(result)
  })
})
