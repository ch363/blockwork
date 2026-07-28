/**
 * Phase 2 integration: navigation + pathing + movement on a live InmateWorld.
 */

import { describe, expect, it } from 'vitest'

import { createGame } from '../../src/core/game'
import { loadGameData } from '../../src/data/loader'
import { createInmateShell, generateInmate } from '../../src/entities/inmate'
import { Rng } from '../../src/core/rng'
import { PASSABILITY } from '../../src/world/tileGrid'
import { isPathingWorld } from '../../src/systems/pathingSystem'
import { ACCESS } from '../../src/pathfinding/regionGraph'

const DATA = loadGameData()

describe('Phase 2 pathing integration', () => {
  it('createGame worlds satisfy PathingWorld and register navigation/pathing/movement', () => {
    const game = createGame({ seed: 1, mapSize: 32, data: DATA })
    expect(isPathingWorld(game.world)).toBe(true)
    expect(game.simulation.systems.map((system) => system.name)).toEqual([
      'routine',
      'jobAssignment',
      'staff',
      'posts',
      'navigation',
      'pathing',
      'movement',
      'combat',
      'needs',
      'staffNeeds',
      'activity',
      'mealChain',
      'supply',
      'deliveries',
      'cleaning',
      'laundry',
      'labour',
      'construction',
      'rooms',
      'utilities',
      'objects',
      'intake',
      'contraband',
      'search',
      'misconduct',
      'punishment',
      'intelligence',
      'danger',
      'riot',
      'emergency',
      'fire',
      'escape',
      'programs',
      'directorate',
      'economy',
      'contracts',
      'grading',
      'grades',
      'parole',
      'release',
    ])
  })

  it('moves an inmate toward an A* goal across open ground', () => {
    const game = createGame({ seed: 2, mapSize: 24, data: DATA })
    const { world, simulation } = game
    const grid = world.grid

    // Open a walkable strip.
    for (let y = 2; y <= 4; y += 1) {
      for (let x = 2; x <= 20; x += 1) {
        const index = grid.idx(x, y)
        grid.setAt('outdoors', index, 0)
        grid.setAt('passability', index, PASSABILITY.WALKABLE)
      }
    }
    world.regions.rebuildAll(grid, world.doors, DATA)

    const component = generateInmate({
      data: DATA,
      rng: new Rng(99).stream('test'),
      category: 'medium',
    })
    const entity = createInmateShell({
      id: world.inmates.allocateId(),
      data: DATA,
      inmate: component,
      tx: 3,
      ty: 3,
    })
    world.inmates.add(entity)

    const goal = grid.idx(18, 3)
    world.agents.setGoal(entity.id, goal)

    const startX = entity.x
    for (let i = 0; i < 400; i += 1) simulation.step()

    expect(entity.x).toBeGreaterThan(startX)
    expect(entity.tx).toBeGreaterThan(3)
    // Access mask stays inmate-class for door filtering.
    expect(entity.accessMask & ACCESS.INMATE).toBe(ACCESS.INMATE)
  })
})
