/**
 * `MovementSystem`: advance agents along paths with local avoidance (T2.3).
 *
 * Runs every tick after `PathingSystem` (PRD 4.4 slots 4–5). Each agent with a
 * path moves in world units at its category speed toward the next waypoint.
 * Diagonal steps are allowed only when both orthogonal neighbours are
 * passable. Before claiming a tile the system consults door queues and the
 * 3×3 avoidance resolver so agents wait or side-step instead of piling up.
 *
 * An agent occupies its current tile until it arrives at the reserved next
 * tile. Mid-move reservations stop two agents choosing the same cell.
 */

import type { System, SystemContext, World } from '../core/simulation'
import type { GameData } from '../data/loader'
import { resolveAvoidance } from '../pathfinding/avoidance'
import type { AvoidanceAgent } from '../pathfinding/avoidance'
import { DoorQueueRegistry } from '../pathfinding/doorQueue'
import { tilePassableForAccess } from '../pathfinding/flowField'
import { PASSABILITY } from '../world/tileGrid'
import type { TileGrid } from '../world/tileGrid'
import { accrueAgentPassDirt } from './logistics/cleaning'
import { isInmateWorld } from './intakeSystem'
import type { InmateWorld } from './intakeSystem'

import { isPathingWorld, type MobileAgent, type PathingWorld } from './pathingSystem'

export interface MovementSystemOptions {
  readonly data: GameData
  readonly doorQueues?: DoorQueueRegistry
}

export const MOVEMENT_SYSTEM_NAME = 'movement'

/** PRD 4.4: Movement runs every tick. */
export const MOVEMENT_SYSTEM_PERIOD = 1

export interface MovementSystem extends System {
  readonly doorQueues: DoorQueueRegistry
}

/** Per-agent in-flight reservation toward a tile centre. */
interface MoveIntent {
  nextTx: number
  nextTy: number
  targetX: number
  targetY: number
  /** True when this step came from avoidance rather than the path. */
  sidestep: boolean
  doorTile: number
}

export function createMovementSystem(options: MovementSystemOptions): MovementSystem {
  const doorQueues =
    options.doorQueues ??
    new DoorQueueRegistry({
      doorQueueThreshold: options.data.balance.pathfinding.doorQueueThreshold,
    })
  let reportedWrongWorld = false
  const intents = new Map<number, MoveIntent>()
  const scratch = createMovementScratch()
  const data = options.data

  return {
    name: MOVEMENT_SYSTEM_NAME,
    period: MOVEMENT_SYSTEM_PERIOD,
    doorQueues,

    update(context: SystemContext): void {
      const world = context.world
      const tick = context.clock.tick

      if (!isPathingWorld(world)) {
        if (reportedWrongWorld) return
        reportedWrongWorld = true
        context.events.emit({
          tick,
          kind: 'movement.rejected',
          causeIds: [],
          data: { command: MOVEMENT_SYSTEM_NAME, reason: 'wrong-world' },
        })
        return
      }

      stepMovement(world, doorQueues, intents, scratch, data)
    },
  }
}

interface MovementScratch {
  occupancy: Map<number, number>
  reserved: Map<number, number>
  desires: Map<number, number>
  doorWaitCounts: Map<number, number>
  agentsById: Map<number, AvoidanceAgent>
}

function createMovementScratch(): MovementScratch {
  return {
    occupancy: new Map(),
    reserved: new Map(),
    desires: new Map(),
    doorWaitCounts: new Map(),
    agentsById: new Map(),
  }
}

/**
 * One movement pass. Exported for headless stress tests that time pathing and
 * movement without the full simulation clock.
 */
export function stepMovement(
  world: PathingWorld,
  doorQueues: DoorQueueRegistry,
  intents: Map<number, MoveIntent> = new Map(),
  scratch: MovementScratch = createMovementScratch(),
  data?: GameData,
): void {
  const { grid, agents } = world
  const size = grid.size
  const tileWorldUnits = agents.tileWorldUnits()
  const list = agents.all()

  const occupancy = scratch.occupancy
  const reserved = scratch.reserved
  const desires = scratch.desires
  const doorWaitCounts = scratch.doorWaitCounts
  const agentsById = scratch.agentsById
  occupancy.clear()
  reserved.clear()
  desires.clear()
  doorWaitCounts.clear()
  agentsById.clear()

  for (let i = 0; i < list.length; i += 1) {
    const agent = list[i]
    if (agent === undefined) continue
    agentsById.set(agent.id, agent)
    occupancy.set(agent.ty * size + agent.tx, agent.id)

    const desired = desiredNextTile(agent, grid)
    if (desired !== null) {
      desires.set(agent.id, desired)
      if (((grid.passability[desired] ?? 0) & PASSABILITY.DOOR) !== 0) {
        doorWaitCounts.set(desired, (doorWaitCounts.get(desired) ?? 0) + 1)
      }
    }
  }

  for (const [agentId, intent] of intents) {
    reserved.set(intent.nextTy * size + intent.nextTx, agentId)
    // Destinations count as occupied so followers wait on the mover ahead.
    if (!occupancy.has(intent.nextTy * size + intent.nextTx)) {
      occupancy.set(intent.nextTy * size + intent.nextTx, agentId)
    }
  }

  for (let i = 0; i < list.length; i += 1) {
    const agent = list[i]
    if (agent === undefined) continue
    agent.ticksSinceTileChange += 1

    if (agent.goalTile < 0) {
      cancelIntent(agent, intents, doorQueues)
      continue
    }

    const active = intents.get(agent.id)
    if (active !== undefined) {
      continueMove(agent, active, intents, doorQueues, grid, world, data)
      continue
    }

    if (agent.path === null) {
      agent.dx = 0
      agent.dy = 0
      if (doorQueues.isQueued(agent.id)) doorQueues.leave(agent.id)
      continue
    }

    const desiredIndex = desires.get(agent.id)
    if (desiredIndex === undefined) {
      agent.dx = 0
      agent.dy = 0
      continue
    }

    const desiredTy = (desiredIndex / size) | 0
    const desiredTx = desiredIndex - desiredTy * size
    const isDoor = ((grid.passability[desiredIndex] ?? 0) & PASSABILITY.DOOR) !== 0

    if (isDoor) {
      const waiting = doorWaitCounts.get(desiredIndex) ?? 0
      const lineExists = doorQueues.queueLength(desiredIndex) > 0
      const alreadyQueued =
        doorQueues.isQueued(agent.id) && doorQueues.doorOf(agent.id) === desiredIndex
      if (waiting > doorQueues.doorQueueThreshold || lineExists || alreadyQueued) {
        doorQueues.enqueue(desiredIndex, agent.id)
        if (!doorQueues.mayEnter(desiredIndex, agent.id, waiting)) {
          agent.dx = 0
          agent.dy = 0
          continue
        }
      }
    } else if (doorQueues.isQueued(agent.id)) {
      doorQueues.leave(agent.id)
    }

    const action = resolveAvoidance(
      {
        id: agent.id,
        tx: agent.tx,
        ty: agent.ty,
        dx: Math.sign(desiredTx - agent.tx),
        dy: Math.sign(desiredTy - agent.ty),
      },
      desiredTx,
      desiredTy,
      {
        grid,
        accessMask: agent.accessMask,
        occupancy,
        agentsById,
      },
    )

    if (action.kind === 'wait') {
      agent.dx = 0
      agent.dy = 0
      continue
    }

    const nextTx = action.nextTx
    const nextTy = action.nextTy
    if (!canStep(grid, agent, nextTx, nextTy)) {
      agent.dx = 0
      agent.dy = 0
      continue
    }

    const nextIndex = nextTy * size + nextTx
    const claim = occupancy.get(nextIndex)
    if (claim !== undefined && claim !== agent.id) {
      agent.dx = 0
      agent.dy = 0
      continue
    }

    const intent: MoveIntent = {
      nextTx,
      nextTy,
      targetX: (nextTx + 0.5) * tileWorldUnits,
      targetY: (nextTy + 0.5) * tileWorldUnits,
      sidestep: action.kind === 'sidestep',
      doorTile: isDoor && nextIndex === desiredIndex ? desiredIndex : -1,
    }
    intents.set(agent.id, intent)
    reserved.set(nextIndex, agent.id)
    occupancy.set(nextIndex, agent.id)
    agent.dx = Math.sign(nextTx - agent.tx)
    agent.dy = Math.sign(nextTy - agent.ty)
    continueMove(agent, intent, intents, doorQueues, grid, world, data)
  }
}

function continueMove(
  agent: MobileAgent,
  intent: MoveIntent,
  intents: Map<number, MoveIntent>,
  doorQueues: DoorQueueRegistry,
  grid: TileGrid,
  world?: PathingWorld,
  data?: GameData,
): void {
  moveToward(agent, intent.targetX, intent.targetY, agent.speed)

  if (!reached(agent.x, agent.y, intent.targetX, intent.targetY)) {
    return
  }

  agent.x = intent.targetX
  agent.y = intent.targetY
  agent.tx = intent.nextTx
  agent.ty = intent.nextTy
  agent.ticksSinceTileChange = 0
  intents.delete(agent.id)

  if (world !== undefined && data !== undefined && isInmateWorld(world as unknown as World)) {
    accrueAgentPassDirt(world as InmateWorld, data, agent.ty * grid.size + agent.tx)
  }

  if (intent.doorTile >= 0) {
    doorQueues.release(intent.doorTile, agent.id)
  }

  if (intent.sidestep) {
    agent.dx = 0
    agent.dy = 0
    return
  }

  advancePathIndex(agent, grid)
  if (agent.path === null) {
    agent.dx = 0
    agent.dy = 0
  }
}

function cancelIntent(
  agent: MobileAgent,
  intents: Map<number, MoveIntent>,
  doorQueues: DoorQueueRegistry,
): void {
  intents.delete(agent.id)
  agent.dx = 0
  agent.dy = 0
  if (doorQueues.isQueued(agent.id)) doorQueues.leave(agent.id)
}

function desiredNextTile(agent: MobileAgent, grid: TileGrid): number | null {
  if (agent.path === null) return null
  while (agent.pathIndex < agent.path.length) {
    const tile = agent.path[agent.pathIndex]
    if (tile === undefined) return null
    const current = agent.ty * grid.size + agent.tx
    if (tile === current) {
      agent.pathIndex += 1
      continue
    }
    return nextAdjacentToward(agent, tile, grid)
  }
  return null
}

function nextAdjacentToward(agent: MobileAgent, goalTile: number, grid: TileGrid): number {
  const size = grid.size
  const goalY = (goalTile / size) | 0
  const goalX = goalTile - goalY * size
  const dx = Math.sign(goalX - agent.tx)
  const dy = Math.sign(goalY - agent.ty)
  return (agent.ty + dy) * size + (agent.tx + dx)
}

function advancePathIndex(agent: MobileAgent, grid: TileGrid): void {
  if (agent.path === null) return
  const current = agent.ty * grid.size + agent.tx
  while (agent.pathIndex < agent.path.length) {
    const tile = agent.path[agent.pathIndex]
    if (tile === undefined || tile !== current) break
    agent.pathIndex += 1
  }
  if (agent.pathIndex >= agent.path.length) {
    agent.path = null
    agent.pathIndex = 0
  }
}

function canStep(grid: TileGrid, agent: MobileAgent, nextTx: number, nextTy: number): boolean {
  const size = grid.size
  if (nextTx < 0 || nextTy < 0 || nextTx >= size || nextTy >= size) return false
  const next = nextTy * size + nextTx
  if (!tilePassableForAccess(grid.passability[next] ?? 0, agent.accessMask)) return false

  const dx = nextTx - agent.tx
  const dy = nextTy - agent.ty
  if (dx !== 0 && dy !== 0) {
    const orthA = agent.ty * size + nextTx
    const orthB = nextTy * size + agent.tx
    if (!tilePassableForAccess(grid.passability[orthA] ?? 0, agent.accessMask)) return false
    if (!tilePassableForAccess(grid.passability[orthB] ?? 0, agent.accessMask)) return false
  }
  return true
}

function moveToward(agent: MobileAgent, targetX: number, targetY: number, speed: number): void {
  const dx = targetX - agent.x
  const dy = targetY - agent.y
  const distSq = dx * dx + dy * dy
  const speedSq = speed * speed
  if (distSq <= speedSq || distSq <= 1e-12) {
    agent.x = targetX
    agent.y = targetY
    return
  }
  const dist = Math.sqrt(distSq)
  agent.x += (dx / dist) * speed
  agent.y += (dy / dist) * speed
}

function reached(x: number, y: number, tx: number, ty: number): boolean {
  const dx = x - tx
  const dy = y - ty
  return dx * dx + dy * dy <= 1e-12
}
