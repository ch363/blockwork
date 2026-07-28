/**
 * `PathingSystem`: request and consume per-agent A* paths (T2.3, PRD 4.4 slot 4).
 *
 * Agents that need a one-off destination enqueue through `AStarScheduler`. At
 * most `balance.pathfinding.astarSearchesPerTick` searches complete each tick;
 * the rest stay queued and those agents idle. Flow-field destinations are a
 * separate path (layer 2) and do not consume this budget.
 *
 * Inmate/staff entities arrive in T2.4 / T2.7. Until then this system owns a
 * lightweight `MobileAgent` store that the movement system also updates, so
 * pathfinding and avoidance can be stress-tested without the full ECS.
 */

import type { System, SystemContext } from '../core/simulation'
import type { GameData } from '../data/loader'
import { AStarScheduler } from '../pathfinding/astar'
import type { RegionGraph } from '../pathfinding/regionGraph'
import { ACCESS } from '../pathfinding/regionGraph'
import type { TileGrid } from '../world/tileGrid'

/* -------------------------------------------------------------------------- */
/* Mobile agents                                                               */
/* -------------------------------------------------------------------------- */

export type AgentCategory = 'inmate' | 'staff'

/**
 * A mover the pathing and movement systems share (PRD 4.4 entity core).
 *
 * Positions are world units; `tx`/`ty` are the cached floor tile. `path` is the
 * remaining tile waypoint list including the current tile at index 0 when a
 * search has just completed.
 */
export interface MobileAgent {
  id: number
  category: AgentCategory
  accessMask: number
  /** World-unit position. */
  x: number
  y: number
  tx: number
  ty: number
  /** World units per tick from `balance.pathfinding.speedsWorldUnitsPerTick`. */
  speed: number
  /** Facing used by local avoidance (−1, 0, 1). */
  dx: number
  dy: number
  /** Destination tile index, or `-1` when idle. */
  goalTile: number
  /** Remaining waypoints (tile indices), or `null` while waiting / idle. */
  path: number[] | null
  /** Index into `path` of the next tile to walk toward. */
  pathIndex: number
  /** True while a search is queued or in flight. */
  awaitingPath: boolean
  /** Ticks since this agent last changed tile — for stall diagnostics. */
  ticksSinceTileChange: number
}

export interface SpawnAgentOptions {
  readonly category: AgentCategory
  readonly tx: number
  readonly ty: number
  readonly goalTile?: number
}

/**
 * Read/write surface pathing and movement share. `MobileAgentStore` is the
 * test fixture; the live game uses `InmateAgentStore` over entity shells.
 */
export interface AgentStore {
  readonly size: number
  all(): readonly MobileAgent[]
  get(id: number): MobileAgent | undefined
  setGoal(agentId: number, goalTile: number): void
  tileWorldUnits(): number
}

/**
 * Dense agent store for pathfinding stress tests and fixtures.
 */
export class MobileAgentStore implements AgentStore {
  readonly #agents: MobileAgent[] = []
  readonly #byId = new Map<number, MobileAgent>()
  #nextId = 1
  readonly #tileWorldUnits: number
  readonly #speeds: Readonly<{ inmate: number; staff: number }>

  constructor(
    tileWorldUnits: number,
    speeds: Readonly<{ inmate: number; staff: number }>,
  ) {
    this.#tileWorldUnits = tileWorldUnits
    this.#speeds = speeds
  }

  get size(): number {
    return this.#agents.length
  }

  /** Insertion order. Pathing and movement iterate this every tick — no sort. */
  all(): readonly MobileAgent[] {
    return this.#agents
  }

  get(id: number): MobileAgent | undefined {
    return this.#byId.get(id)
  }

  spawn(options: SpawnAgentOptions): MobileAgent {
    const id = this.#nextId
    this.#nextId += 1
    const speed =
      options.category === 'staff' ? this.#speeds.staff : this.#speeds.inmate
    const accessMask = options.category === 'staff' ? ACCESS.STAFF : ACCESS.INMATE
    const agent: MobileAgent = {
      id,
      category: options.category,
      accessMask,
      x: (options.tx + 0.5) * this.#tileWorldUnits,
      y: (options.ty + 0.5) * this.#tileWorldUnits,
      tx: options.tx,
      ty: options.ty,
      speed,
      dx: 0,
      dy: 0,
      goalTile: options.goalTile ?? -1,
      path: null,
      pathIndex: 0,
      awaitingPath: false,
      ticksSinceTileChange: 0,
    }
    this.#agents.push(agent)
    this.#byId.set(id, agent)
    return agent
  }

  /** Sets a new goal and clears any current path so pathing will re-request. */
  setGoal(agentId: number, goalTile: number): void {
    const agent = this.#byId.get(agentId)
    if (agent === undefined) return
    agent.goalTile = goalTile
    agent.path = null
    agent.pathIndex = 0
    agent.awaitingPath = false
  }

  remove(agentId: number): void {
    const agent = this.#byId.get(agentId)
    if (agent === undefined) return
    this.#byId.delete(agentId)
    const index = this.#agents.indexOf(agent)
    if (index >= 0) this.#agents.splice(index, 1)
  }

  clear(): void {
    this.#agents.length = 0
    this.#byId.clear()
    this.#nextId = 1
  }

  tileWorldUnits(): number {
    return this.#tileWorldUnits
  }
}

/* -------------------------------------------------------------------------- */
/* World bridge                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Anything the pathing system can read. The live `InmateWorld` satisfies this;
 * tests use a thin fixture around `MobileAgentStore`.
 */
export interface PathingWorld {
  readonly grid: TileGrid
  readonly regions: RegionGraph
  readonly agents: AgentStore
}

export function isPathingWorld(world: unknown): world is PathingWorld {
  if (typeof world !== 'object' || world === null) return false
  const candidate = world as Partial<PathingWorld>
  return (
    candidate.grid !== undefined &&
    candidate.regions !== undefined &&
    candidate.agents !== undefined
  )
}

/* -------------------------------------------------------------------------- */
/* System                                                                      */
/* -------------------------------------------------------------------------- */

export interface PathingSystemOptions {
  readonly data: GameData
  readonly scheduler?: AStarScheduler
}

export const PATHING_SYSTEM_NAME = 'pathing'

/** PRD 4.4: Pathing runs every tick. */
export const PATHING_SYSTEM_PERIOD = 1

export interface PathingSystem extends System {
  readonly scheduler: AStarScheduler
}

export function createPathingSystem(options: PathingSystemOptions): PathingSystem {
  const scheduler =
    options.scheduler ??
    new AStarScheduler({
      astarSearchesPerTick: options.data.balance.pathfinding.astarSearchesPerTick,
    })
  let reportedWrongWorld = false

  return {
    name: PATHING_SYSTEM_NAME,
    period: PATHING_SYSTEM_PERIOD,
    scheduler,

    update(context: SystemContext): void {
      const world = context.world
      const tick = context.clock.tick

      if (!isPathingWorld(world)) {
        if (reportedWrongWorld) return
        reportedWrongWorld = true
        context.events.emit({
          tick,
          kind: 'pathing.rejected',
          causeIds: [],
          data: { command: PATHING_SYSTEM_NAME, reason: 'wrong-world' },
        })
        return
      }

      const { grid, regions, agents } = world

      for (const agent of agents.all()) {
        if (agent.goalTile < 0) continue
        const tileIndex = agent.ty * grid.size + agent.tx
        if (tileIndex === agent.goalTile) {
          agent.goalTile = -1
          agent.path = null
          agent.pathIndex = 0
          agent.awaitingPath = false
          agent.dx = 0
          agent.dy = 0
          continue
        }

        if (agent.path !== null && agent.pathIndex < agent.path.length) continue
        if (agent.awaitingPath && scheduler.isQueued(agent.id)) continue

        agent.awaitingPath = true
        agent.path = null
        agent.pathIndex = 0
        scheduler.request({
          agentId: agent.id,
          from: tileIndex,
          to: agent.goalTile,
          accessMask: agent.accessMask,
        })
      }

      const result = scheduler.tick(grid, regions)

      for (const [agentId, path] of result.completed) {
        const agent = agents.get(agentId)
        if (agent === undefined) continue
        agent.awaitingPath = false
        if (path === null) {
          agent.path = null
          agent.pathIndex = 0
          context.events.emit({
            tick,
            kind: 'pathing.unreachable',
            causeIds: [],
            data: {
              agentId,
              from: agent.ty * grid.size + agent.tx,
              to: agent.goalTile,
              category: agent.category,
            },
          })
          continue
        }
        agent.path = path
        // Skip the current tile if the path starts there.
        agent.pathIndex = path.length > 1 && path[0] === agent.ty * grid.size + agent.tx ? 1 : 0
      }
    },
  }
}
