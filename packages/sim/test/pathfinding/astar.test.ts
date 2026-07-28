/**
 * Budgeted A*, local avoidance, and corridor stress (T2.3).
 */

import { describe, expect, it } from 'vitest'

import {
  ASTAR_COST_INF,
  AStarScheduler,
  BinaryHeap,
  astarNeighbours,
  buildRegionBound,
  findPathAStar,
  octileHeuristic,
} from '../../src/pathfinding/astar'
import { FLOW_COST_DIAG, FLOW_COST_ORTH } from '../../src/pathfinding/flowField'
import { ACCESS, ACCESS_ALL } from '../../src/pathfinding/regionGraph'
import { DoorQueueRegistry } from '../../src/pathfinding/doorQueue'
import { Simulation } from '../../src/core/simulation'
import type { SystemContext } from '../../src/core/simulation'
import { createMovementSystem } from '../../src/systems/movementSystem'
import {
  MobileAgentStore,
  createPathingSystem,
  type PathingWorld,
} from '../../src/systems/pathingSystem'
import type { Fnv1aHasher } from '../../src/core/hash'
import { PASSABILITY } from '../../src/world/tileGrid'
import { setBoundsChecks } from '../../src/world/coords'

import {
  DATA,
  buildTwoRooms,
  graphWorld,
  putFloor,
  putFloorRect,
  putPerimeter,
  putWall,
  rebuildAll,
} from './regionFixture'

/* -------------------------------------------------------------------------- */
/* Reference Dijkstra (same neighbour + cost rules as A*)                      */
/* -------------------------------------------------------------------------- */

function dijkstraCost(
  size: number,
  passability: Uint8Array,
  accessMask: number,
  allowed: Uint8Array,
  start: number,
  goal: number,
): number {
  const total = size * size
  const dist = new Float64Array(total)
  dist.fill(Number.POSITIVE_INFINITY)
  const closed = new Uint8Array(total)
  const heap = new BinaryHeap()
  dist[start] = 0
  heap.push(start, 0, 0)

  const neighbours = astarNeighbours()

  while (heap.size > 0) {
    const current = heap.pop()
    if (current === undefined) break
    const tile = current.tile
    if (closed[tile] === 1) continue
    if (current.g !== dist[tile]) continue
    closed[tile] = 1
    if (tile === goal) return dist[goal] ?? Number.POSITIVE_INFINITY

    const y = (tile / size) | 0
    const x = tile - y * size
    const base = dist[tile] ?? Number.POSITIVE_INFINITY

    for (const step of neighbours) {
      const nx = x + step.dx
      const ny = y + step.dy
      if (nx < 0 || ny < 0 || nx >= size || ny >= size) continue
      const next = ny * size + nx
      if (allowed[next] !== 1) continue
      if (closed[next] === 1) continue
      const pass = passability[next] ?? 0
      if ((pass & PASSABILITY.WALKABLE) === 0) continue
      if ((pass & PASSABILITY.STAFF_ONLY) !== 0 && (accessMask & ACCESS.STAFF) === 0) continue
      if (step.diagonal) {
        const orthA = passability[y * size + nx] ?? 0
        const orthB = passability[ny * size + x] ?? 0
        if ((orthA & PASSABILITY.WALKABLE) === 0) continue
        if ((orthB & PASSABILITY.WALKABLE) === 0) continue
      }
      const tentative = base + step.cost
      if (tentative >= (dist[next] ?? Number.POSITIVE_INFINITY)) continue
      dist[next] = tentative
      heap.push(next, tentative, tentative)
    }
  }
  return Number.POSITIVE_INFINITY
}

function openAllowed(size: number): Uint8Array {
  const allowed = new Uint8Array(size * size)
  allowed.fill(1)
  return allowed
}

function makeAgents(): MobileAgentStore {
  return new MobileAgentStore(
    DATA.balance.map.tileWorldUnits,
    DATA.balance.pathfinding.speedsWorldUnitsPerTick,
  )
}

function openWorld(size: number): PathingWorld & { hashInto(h: Fnv1aHasher): void } {
  const run = graphWorld(size)
  putFloorRect(run, { x: 0, y: 0, width: size, height: size })
  rebuildAll(run)
  const agents = makeAgents()
  return {
    grid: run.world.grid,
    regions: run.graph,
    agents,
    hashInto(hasher: Fnv1aHasher): void {
      run.world.grid.hashInto(hasher)
      hasher.writeUint32(agents.size)
    },
  }
}

/* -------------------------------------------------------------------------- */
/* A* optimality                                                               */
/* -------------------------------------------------------------------------- */

describe('A* optimality (T2.3)', () => {
  it('matches Dijkstra cost on a fixture (BFS-equivalent under the same costs)', () => {
    const size = 16
    const run = graphWorld(size)
    putFloorRect(run, { x: 0, y: 0, width: size, height: size })
    for (let y = 2; y <= 12; y += 1) putWall(run, 8, y)

    const start = run.world.grid.idx(2, 8)
    const goal = run.world.grid.idx(14, 8)
    const allowed = openAllowed(size)

    const result = findPathAStar({
      grid: run.world.grid,
      start,
      goal,
      accessMask: ACCESS_ALL,
      allowed,
    })
    expect(result.path).not.toBeNull()
    expect(result.cost).not.toBe(ASTAR_COST_INF)

    const reference = dijkstraCost(
      size,
      run.world.grid.passability,
      ACCESS_ALL,
      allowed,
      start,
      goal,
    )
    expect(result.cost).toBe(reference)

    const path = result.path
    expect(path).not.toBeNull()
    if (path === null) return
    expect(path[0]).toBe(start)
    expect(path[path.length - 1]).toBe(goal)
  })

  it('octile heuristic never overestimates the true octile distance', () => {
    expect(octileHeuristic(0, 0, 3, 4)).toBe(
      FLOW_COST_ORTH * 4 + (FLOW_COST_DIAG - FLOW_COST_ORTH) * 3,
    )
    expect(octileHeuristic(0, 0, 5, 0)).toBe(FLOW_COST_ORTH * 5)
    expect(octileHeuristic(2, 2, 2, 2)).toBe(0)
  })

  it('refuses to expand outside the region corridor', () => {
    const size = 24
    const run = graphWorld(size)
    const { left, right } = buildTwoRooms(run)
    rebuildAll(run)

    const regionPath = run.graph.findRegionPath(left, right, ACCESS_ALL)
    expect(regionPath).not.toBeNull()
    if (regionPath === null) return

    const allowed = buildRegionBound(
      run.graph,
      run.world.grid,
      regionPath,
      ACCESS_ALL,
      left,
      right,
    )
    // Far outdoor tile is not on the corridor.
    putFloor(run, 20, 20)
    const outsider = run.world.grid.idx(20, 20)
    expect(allowed[outsider] ?? 0).toBe(0)

    const result = findPathAStar({
      grid: run.world.grid,
      start: left,
      goal: right,
      accessMask: ACCESS_ALL,
      allowed,
    })
    expect(result.path).not.toBeNull()
    if (result.path === null) return
    for (const tile of result.path) {
      expect(allowed[tile]).toBe(1)
    }
  })
})

/* -------------------------------------------------------------------------- */
/* Budget                                                                      */
/* -------------------------------------------------------------------------- */

describe('A* budget enforcement (T2.3)', () => {
  it('runs at most astarSearchesPerTick searches and queues the rest', () => {
    const size = 24
    const world = openWorld(size)
    const budget = DATA.balance.pathfinding.astarSearchesPerTick
    expect(budget).toBe(8)

    const scheduler = new AStarScheduler({ astarSearchesPerTick: budget })
    for (let i = 0; i < 20; i += 1) {
      scheduler.request({
        agentId: i + 1,
        from: world.grid.idx(1, 1 + (i % 10)),
        to: world.grid.idx(size - 2, 1 + (i % 10)),
        accessMask: ACCESS.INMATE,
      })
    }
    expect(scheduler.pendingCount).toBe(20)

    const first = scheduler.tick(world.grid, world.regions)
    expect(first.searched).toBe(budget)
    expect(first.pending).toBe(20 - budget)
    expect(first.completed.size).toBe(budget)

    const second = scheduler.tick(world.grid, world.regions)
    expect(second.searched).toBe(budget)
    expect(second.pending).toBe(20 - budget * 2)
  })
})

/* -------------------------------------------------------------------------- */
/* Door queues                                                                 */
/* -------------------------------------------------------------------------- */

describe('door queues (T2.3)', () => {
  it('forms an ordered line once more than the threshold are waiting', () => {
    const queues = new DoorQueueRegistry({
      doorQueueThreshold: DATA.balance.pathfinding.doorQueueThreshold,
    })
    const door = 42
    expect(queues.mayEnter(door, 1, 2)).toBe(true)

    expect(queues.mayEnter(door, 3, 3)).toBe(false)
    queues.enqueue(door, 1)
    queues.enqueue(door, 2)
    queues.enqueue(door, 3)
    expect(queues.queueLength(door)).toBe(3)
    expect(queues.mayEnter(door, 1, 3)).toBe(true)
    expect(queues.mayEnter(door, 2, 3)).toBe(false)
    queues.release(door, 1)
    expect(queues.mayEnter(door, 2, 2)).toBe(true)
  })
})

/* -------------------------------------------------------------------------- */
/* Stress: 400 agents in a corridor                                            */
/* -------------------------------------------------------------------------- */

describe('400-agent corridor stress (T2.3)', () => {
  it('keeps pathing+movement under 4ms/step and never permanently stalls', () => {
    setBoundsChecks(false)

    const size = 128
    const run = graphWorld(size)
    // Wide corridor with a one-tile pinch so agents must single-file through.
    putFloorRect(run, { x: 1, y: 2, width: 100, height: 10 })
    putPerimeter(run, { x: 0, y: 1, width: 102, height: 12 })
    for (let y = 2; y <= 11; y += 1) {
      if (y === 6) continue
      putWall(run, 50, y)
    }
    putFloor(run, 50, 6)
    rebuildAll(run)

    const agents = makeAgents()
    const goalTile = run.world.grid.idx(98, 6)

    let spawned = 0
    for (let x = 1; x <= 40 && spawned < 400; x += 1) {
      for (let y = 2; y <= 11 && spawned < 400; y += 1) {
        agents.spawn({ category: 'inmate', tx: x, ty: y, goalTile })
        spawned += 1
      }
    }
    expect(agents.size).toBe(400)

    const world: PathingWorld & { hashInto(h: Fnv1aHasher): void } = {
      grid: run.world.grid,
      regions: run.graph,
      agents,
      hashInto(hasher: Fnv1aHasher): void {
        hasher.writeUint32(agents.size)
      },
    }

    const pathing = createPathingSystem({ data: DATA })
    const movement = createMovementSystem({ data: DATA })
    const sim = new Simulation({
      seed: 20260727,
      world,
      systems: [pathing, movement],
    })

    const stallIdleWindow = 200
    const ticks = 10_000
    let idleWindow = 0
    let maxIdleWindow = 0
    let timedMs = 0
    let timedSteps = 0
    let prevFingerprint = -1
    let arrived = 0

    for (let i = 0; i < ticks; i += 1) {
      const t0 = performance.now()
      sim.step()
      const dt = performance.now() - t0
      if (i >= 80) {
        timedMs += dt
        timedSteps += 1
      }

      // Free the shared goal tile so the convoy is not blocked by arrivals.
      for (const agent of [...agents.all()]) {
        if (agent.ty * size + agent.tx === goalTile) {
          arrived += 1
          agents.remove(agent.id)
        }
      }

      let fingerprint = 0
      let unfinished = 0
      for (const agent of agents.all()) {
        unfinished += 1
        fingerprint = (fingerprint + agent.tx * 131 + agent.ty) | 0
      }
      if (unfinished === 0) {
        idleWindow = 0
      } else if (fingerprint === prevFingerprint) {
        idleWindow += 1
        if (idleWindow > maxIdleWindow) maxIdleWindow = idleWindow
      } else {
        idleWindow = 0
        prevFingerprint = fingerprint
      }

      if (unfinished === 0) break
    }

    const meanMs = timedMs / Math.max(1, timedSteps)
    expect(meanMs).toBeLessThan(4)
    expect(maxIdleWindow).toBeLessThan(stallIdleWindow)
    expect(arrived).toBe(400)

    setBoundsChecks(true)
  }, 180_000)
})

describe('pathing system wiring (T2.3)', () => {
  it('emits pathing.unreachable when no corridor exists', () => {
    const size = 16
    const run = graphWorld(size)
    putFloorRect(run, { x: 0, y: 0, width: 6, height: 6 })
    putPerimeter(run, { x: 0, y: 0, width: 6, height: 6 })
    putFloorRect(run, { x: 10, y: 0, width: 6, height: 6 })
    putPerimeter(run, { x: 10, y: 0, width: 6, height: 6 })
    rebuildAll(run)

    const agents = makeAgents()
    const goal = run.world.grid.idx(12, 2)
    agents.spawn({ category: 'inmate', tx: 2, ty: 2, goalTile: goal })

    const world: PathingWorld & { hashInto(h: Fnv1aHasher): void } = {
      grid: run.world.grid,
      regions: run.graph,
      agents,
      hashInto(hasher: Fnv1aHasher): void {
        hasher.writeUint32(agents.size)
      },
    }

    const events: { kind: string }[] = []
    const pathing = createPathingSystem({ data: DATA })
    const context = {
      clock: { tick: 1, minute: 0, hour: 0, day: 1, isHour: () => false, everyNTicks: () => false, timeString: () => '00:00', serialise: () => ({ tick: 1 }) },
      rng: new Simulation({ seed: 1 }).rng,
      world,
      events: {
        emit(event: { kind: string }): void {
          events.push(event)
        },
      },
    } satisfies SystemContext

    // Budget allows one search on the first update.
    pathing.update(context)
    pathing.update(context)
    expect(events.some((event) => event.kind === 'pathing.unreachable')).toBe(true)
  })
})
