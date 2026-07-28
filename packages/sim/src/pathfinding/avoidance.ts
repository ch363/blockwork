/**
 * Local avoidance over a 3×3 neighbourhood (T2.3, PRD 4.5).
 *
 * Before an agent steps onto its next path tile it samples every neighbour.
 * If another agent already occupies that tile:
 *
 *   - same travel direction → wait (follow, do not shove)
 *   - otherwise → try a free orthogonal side-step that stays passable
 *
 * This is a cheap reciprocal-velocity approximation: no continuous RVO solver,
 * just tile occupancy and the mover's current facing.
 */

import { tilePassableForAccess } from './flowField'
import type { TileGrid } from '../world/tileGrid'

/** Facing used for "same direction" waits. Zeroes mean idle / unknown. */
export interface AvoidanceAgent {
  readonly id: number
  readonly tx: number
  readonly ty: number
  /** Sign of travel along x (−1, 0, 1). */
  readonly dx: number
  /** Sign of travel along y (−1, 0, 1). */
  readonly dy: number
}

export type AvoidanceAction =
  | { readonly kind: 'advance'; readonly nextTx: number; readonly nextTy: number }
  | { readonly kind: 'wait' }
  | { readonly kind: 'sidestep'; readonly nextTx: number; readonly nextTy: number }

export interface AvoidanceContext {
  readonly grid: TileGrid
  readonly accessMask: number
  /** Tile index → agent id currently standing there. */
  readonly occupancy: ReadonlyMap<number, number>
  /** Agent id → mover, for direction tests. */
  readonly agentsById: ReadonlyMap<number, AvoidanceAgent>
}

/**
 * Decide how `agent` should treat a desired next tile.
 *
 * `desiredTx/Ty` is the next waypoint on the path (usually adjacent). When
 * that cell is free the action is `advance`. Occupied cells wait or side-step.
 */
export function resolveAvoidance(
  agent: AvoidanceAgent,
  desiredTx: number,
  desiredTy: number,
  context: AvoidanceContext,
): AvoidanceAction {
  const { grid, accessMask, occupancy, agentsById } = context
  const size = grid.size

  if (desiredTx < 0 || desiredTy < 0 || desiredTx >= size || desiredTy >= size) {
    return { kind: 'wait' }
  }

  const desiredIndex = desiredTy * size + desiredTx
  if (!tilePassableForAccess(grid.passability[desiredIndex] ?? 0, accessMask)) {
    return { kind: 'wait' }
  }

  const blockerId = occupancy.get(desiredIndex)
  if (blockerId === undefined || blockerId === agent.id) {
    return { kind: 'advance', nextTx: desiredTx, nextTy: desiredTy }
  }

  const blocker = agentsById.get(blockerId)
  if (blocker !== undefined) {
    // Stationary blockers are a queue, not a crossing — wait rather than
    // fan out into side-steps that invalidate paths.
    if (blocker.dx === 0 && blocker.dy === 0) {
      return { kind: 'wait' }
    }
    if (sameDirection(agent, blocker)) {
      return { kind: 'wait' }
    }
  }

  const side = pickSideStep(agent, desiredTx, desiredTy, context)
  if (side !== null) {
    return { kind: 'sidestep', nextTx: side.tx, nextTy: side.ty }
  }

  return { kind: 'wait' }
}

function sameDirection(a: AvoidanceAgent, b: AvoidanceAgent): boolean {
  if (a.dx === 0 && a.dy === 0) return false
  if (b.dx === 0 && b.dy === 0) return false
  return a.dx === b.dx && a.dy === b.dy
}

/**
 * Orthogonal side-steps relative to the desired move, in a fixed order so the
 * choice is deterministic when several cells are free.
 */
function pickSideStep(
  agent: AvoidanceAgent,
  desiredTx: number,
  desiredTy: number,
  context: AvoidanceContext,
): { tx: number; ty: number } | null {
  const moveDx = desiredTx - agent.tx
  const moveDy = desiredTy - agent.ty
  const candidates: readonly (readonly [number, number])[] =
    moveDx !== 0 && moveDy === 0
      ? [
          [agent.tx, agent.ty - 1],
          [agent.tx, agent.ty + 1],
        ]
      : moveDy !== 0 && moveDx === 0
        ? [
            [agent.tx - 1, agent.ty],
            [agent.tx + 1, agent.ty],
          ]
        : [
            // Diagonal desire: try the two orth projections as side options.
            [agent.tx + Math.sign(moveDx), agent.ty],
            [agent.tx, agent.ty + Math.sign(moveDy)],
            [agent.tx - Math.sign(moveDy), agent.ty],
            [agent.tx, agent.ty - Math.sign(moveDx)],
          ]

  const { grid, accessMask, occupancy } = context
  const size = grid.size

  for (const [tx, ty] of candidates) {
    if (tx < 0 || ty < 0 || tx >= size || ty >= size) continue
    if (tx === agent.tx && ty === agent.ty) continue
    const index = ty * size + tx
    if (!tilePassableForAccess(grid.passability[index] ?? 0, accessMask)) continue
    const occupant = occupancy.get(index)
    if (occupant !== undefined && occupant !== agent.id) continue
    return { tx, ty }
  }

  return null
}

/**
 * Build an occupancy map from a list of agents. Later agents overwrite earlier
 * ones on the same tile — callers should keep at most one agent per tile for
 * stable avoidance.
 */
export function buildOccupancy(agents: readonly AvoidanceAgent[], size: number): Map<number, number> {
  const occupancy = new Map<number, number>()
  for (const agent of agents) {
    if (agent.tx < 0 || agent.ty < 0 || agent.tx >= size || agent.ty >= size) continue
    occupancy.set(agent.ty * size + agent.tx, agent.id)
  }
  return occupancy
}
