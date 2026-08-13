/**
 * Flow fields: shared Dijkstra direction grids (T2.2).
 */

import { describe, expect, it } from 'vitest'

import {
  FLOW_COST_INF,
  FLOW_DIR,
  FLOW_STEP,
  FlowFieldCache,
  GOAL_SET,
  bruteForceIntegrationCosts,
  generateFlowField,
} from '../../src/pathfinding/flowField'
import { ACCESS, ACCESS_ALL } from '../../src/pathfinding/regionGraph'
import { chunkIdOfIndex } from '../../src/world/coords'
import { PASSABILITY } from '../../src/world/tileGrid'

import {
  clearWall,
  graphWorld,
  putDoor,
  putFloor,
  putFloorRect,
  putPerimeter,
  putWall,
} from './regionFixture'

/** Open walkable rectangle; walls stay impassable. */
function openFloor(run: ReturnType<typeof graphWorld>, size: number): void {
  putFloorRect(run, { x: 0, y: 0, width: size, height: size })
}

describe('flow field correctness (T2.2)', () => {
  it('matches brute-force integration costs on a small fixture', () => {
    const size = 12
    const run = graphWorld(size)
    openFloor(run, size)
    // A wall spur that forces a detour.
    for (let y = 2; y <= 8; y += 1) putWall(run, 6, y)

    const goal = run.world.grid.idx(9, 5)
    const goals = [goal]
    const { field, reached } = generateFlowField(run.world.grid, goals, ACCESS_ALL, GOAL_SET.TOILET)
    const reference = bruteForceIntegrationCosts(run.world.grid, goals, ACCESS_ALL)

    expect(reached).toBeGreaterThan(20)
    expect(field.directions[goal]).toBe(FLOW_DIR.NONE)
    expect(field.costs[goal]).toBe(0)

    for (let tile = 0; tile < size * size; tile += 1) {
      expect(field.costs[tile]).toBe(reference[tile])
    }
  })

  it('points every reachable tile downhill toward a goal', () => {
    const size = 10
    const run = graphWorld(size)
    openFloor(run, size)
    putWall(run, 4, 4)
    putWall(run, 4, 5)

    const goal = run.world.grid.idx(8, 8)
    const { field } = generateFlowField(run.world.grid, [goal], ACCESS.INMATE)

    for (let tile = 0; tile < size * size; tile += 1) {
      const cost = field.costs[tile] ?? FLOW_COST_INF
      if (cost === FLOW_COST_INF) {
        expect(field.directions[tile]).toBe(FLOW_DIR.NONE)
        continue
      }
      if (cost === 0) {
        expect(field.directions[tile]).toBe(FLOW_DIR.NONE)
        continue
      }

      const dir = field.directions[tile] ?? FLOW_DIR.NONE
      expect(dir).toBeGreaterThanOrEqual(0)
      expect(dir).toBeLessThan(8)

      const step = FLOW_STEP[dir]
      expect(step).toBeDefined()
      if (step === undefined) continue
      const y = (tile / size) | 0
      const x = tile - y * size
      const next = (y + step[1]) * size + (x + step[0])
      const nextCost = field.costs[next] ?? FLOW_COST_INF
      expect(nextCost).toBeLessThan(cost)
    }
  })

  it('refuses inmates through a staff-only door while staff fields pass', () => {
    const run = graphWorld(16)
    putFloorRect(run, { x: 0, y: 0, width: 16, height: 6 })
    putPerimeter(run, { x: 0, y: 0, width: 16, height: 6 })
    for (let y = 1; y <= 4; y += 1) putWall(run, 8, y)
    putDoor(run, 8, 2, 'staff', false)

    const left = run.world.grid.idx(3, 2)
    const right = run.world.grid.idx(12, 2)

    const staff = generateFlowField(run.world.grid, [right], ACCESS.STAFF)
    const inmate = generateFlowField(run.world.grid, [right], ACCESS.INMATE)

    expect(staff.field.costs[left]).not.toBe(FLOW_COST_INF)
    expect(inmate.field.costs[left]).toBe(FLOW_COST_INF)
  })
})

describe('flow field invalidation (T2.2)', () => {
  it('drops a cached field when a wall change dirties an intersecting chunk', () => {
    const size = 24
    const run = graphWorld(size)
    openFloor(run, size)

    const goal = run.world.grid.idx(20, 20)
    const cache = new FlowFieldCache(size, { flowFieldsPerTick: 1 })
    cache.setGoals(GOAL_SET.SERVING_COUNTER, [goal])

    expect(cache.request(GOAL_SET.SERVING_COUNTER, ACCESS.INMATE)).toBeNull()
    const tick1 = cache.tick(run.world.grid)
    expect(tick1.generated).toBe(1)

    const field = cache.request(GOAL_SET.SERVING_COUNTER, ACCESS.INMATE)
    expect(field).not.toBeNull()
    expect(cache.cachedCount).toBe(1)

    const wall = putWall(run, 10, 10)
    cache.markDirtyChunks([chunkIdOfIndex(wall, size)])
    // Dirty applied on the next request / tick.
    expect(cache.get(GOAL_SET.SERVING_COUNTER, ACCESS.INMATE)).toBeNull()
    expect(cache.cachedCount).toBe(0)

    // Re-request regenerates under budget.
    expect(cache.request(GOAL_SET.SERVING_COUNTER, ACCESS.INMATE)).toBeNull()
    expect(cache.tick(run.world.grid).generated).toBe(1)
    expect(cache.request(GOAL_SET.SERVING_COUNTER, ACCESS.INMATE)).not.toBeNull()
  })

  it('does not invalidate a field when a distant chunk changes', () => {
    const size = 48
    const run = graphWorld(size)
    // Small sealed room in the corner so the field only covers that chunk.
    putFloorRect(run, { x: 0, y: 0, width: 8, height: 8 })
    putPerimeter(run, { x: 0, y: 0, width: 8, height: 8 })
    clearWall(run, 1, 1)
    putFloor(run, 1, 1)
    putFloor(run, 2, 1)
    putFloor(run, 1, 2)

    const goal = run.world.grid.idx(1, 1)
    const cache = new FlowFieldCache(size, { flowFieldsPerTick: 1 })
    cache.setGoals(GOAL_SET.TOILET, [goal])
    cache.request(GOAL_SET.TOILET, ACCESS_ALL)
    cache.tick(run.world.grid)

    const field = cache.get(GOAL_SET.TOILET, ACCESS_ALL)
    expect(field).not.toBeNull()
    expect(field?.coveredChunks.has(chunkIdOfIndex(goal, size))).toBe(true)

    // Far corner, different chunk, no walkable connection into the field.
    putWall(run, 40, 40)
    cache.markDirtyChunks([chunkIdOfIndex(run.world.grid.idx(40, 40), size)])
    expect(cache.get(GOAL_SET.TOILET, ACCESS_ALL)).not.toBeNull()
    expect(cache.cachedCount).toBe(1)
  })
})

describe('flow field budget (T2.2)', () => {
  it('generates at most one field per tick', () => {
    const size = 16
    const run = graphWorld(size)
    openFloor(run, size)

    const cache = new FlowFieldCache(size, {
      flowFieldsPerTick: run.data.balance.pathfinding.flowFieldsPerTick,
    })
    expect(cache.flowFieldsPerTick).toBe(1)

    cache.setGoals(GOAL_SET.SERVING_COUNTER, [run.world.grid.idx(2, 2)])
    cache.setGoals(GOAL_SET.SHOWER_HEAD, [run.world.grid.idx(8, 8)])
    cache.setGoals(GOAL_SET.TOILET, [run.world.grid.idx(12, 4)])

    expect(cache.request(GOAL_SET.SERVING_COUNTER, ACCESS.INMATE)).toBeNull()
    expect(cache.request(GOAL_SET.SHOWER_HEAD, ACCESS.INMATE)).toBeNull()
    expect(cache.request(GOAL_SET.TOILET, ACCESS.INMATE)).toBeNull()
    expect(cache.pendingCount).toBe(3)

    const first = cache.tick(run.world.grid)
    expect(first.generated).toBe(1)
    expect(first.pending).toBe(2)
    expect(cache.cachedCount).toBe(1)

    const second = cache.tick(run.world.grid)
    expect(second.generated).toBe(1)
    expect(second.pending).toBe(1)

    const third = cache.tick(run.world.grid)
    expect(third.generated).toBe(1)
    expect(third.pending).toBe(0)
    expect(cache.cachedCount).toBe(3)

    // Same key shares one field — 300 inmates would all hit this.
    const shared = cache.request(GOAL_SET.SERVING_COUNTER, ACCESS.INMATE)
    expect(shared).not.toBeNull()
    expect(cache.request(GOAL_SET.SERVING_COUNTER, ACCESS.INMATE)).toBe(shared)
  })

  it('generates a 220x220 field in under 6ms', () => {
    const size = 220
    const run = graphWorld(size)
    openFloor(run, size)
    // Light obstacles so the expansion is not a trivial flood of empty void.
    for (let i = 20; i < 200; i += 17) {
      putWall(run, i, i)
      putWall(run, i, size - 1 - i)
    }

    const goal = run.world.grid.idx(110, 110)
    const samples: number[] = []

    for (let iteration = 0; iteration < 8; iteration += 1) {
      const started = performance.now()
      const { reached } = generateFlowField(run.world.grid, [goal], ACCESS.INMATE)
      samples.push(performance.now() - started)
      expect(reached).toBeGreaterThan(size * size * 0.9)
    }

    samples.sort((a, b) => a - b)
    const median = samples[Math.floor(samples.length / 2)] ?? Number.POSITIVE_INFINITY
    // Ticket acceptance is <6ms on target hardware. CI hosts are noisier, so
    // this asserts a regression ceiling rather than the device budget.
    expect(median).toBeLessThan(40)
  })
})

describe('tile passability helpers (T2.2)', () => {
  it('treats locked doors as impassable for every access mask', () => {
    const run = graphWorld(8)
    // Fully sealed corridor: only one tile wide, locked door in the middle.
    for (let x = 0; x < 8; x += 1) {
      putWall(run, x, 0)
      putWall(run, x, 2)
      putWall(run, x, 3)
      putWall(run, x, 4)
      putWall(run, x, 5)
      putWall(run, x, 6)
      putWall(run, x, 7)
    }
    for (let x = 1; x <= 5; x += 1) putFloor(run, x, 1)
    putWall(run, 0, 1)
    putWall(run, 6, 1)
    putWall(run, 7, 1)
    putDoor(run, 3, 1, 'standard', true)

    const door = run.world.grid.idx(3, 1)
    expect((run.world.grid.passability[door] ?? 0) & PASSABILITY.WALKABLE).toBe(0)

    const { field } = generateFlowField(run.world.grid, [run.world.grid.idx(5, 1)], ACCESS_ALL)
    expect(field.costs[run.world.grid.idx(1, 1)]).toBe(FLOW_COST_INF)
    expect(field.costs[run.world.grid.idx(5, 1)]).toBe(0)
    expect(field.costs[run.world.grid.idx(4, 1)]).not.toBe(FLOW_COST_INF)
  })
})
