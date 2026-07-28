/**
 * `NavigationSystem`: turn Routine goals into pathing / flow-field motion (T2.6).
 *
 * Runs every tick immediately before pathing (PRD slots 4–5). Responsibilities:
 *
 * 1. Rebuild dirty region-graph tiles and spend the flow-field generation budget.
 * 2. Refresh standard goal sets when objects or rooms change.
 * 3. For each free inmate, either set an A* own-cell goal or advance one flow-
 *    field step toward a shared destination.
 *
 * Escorted inmates and inmates mid-object-use are left alone.
 */

import type { System, SystemContext } from '../core/simulation'
import type { GameData } from '../data/loader'
import { NO_OBJECT } from '../entities/objects'
import {
  FLOW_DIR,
  FLOW_STEP,
  type FlowField,
} from '../pathfinding/flowField'
import { isInmateEscorted } from './inmateAgents'
import { isInmateWorld } from './intakeSystem'
import type { InmateWorld } from './intakeSystem'

export interface NavigationSystemOptions {
  readonly data: GameData
}

export const NAVIGATION_SYSTEM_NAME = 'navigation'

/** Every tick: flow sampling and dirty rebuilds must keep up with construction. */
export const NAVIGATION_SYSTEM_PERIOD = 1

export function createNavigationSystem(options: NavigationSystemOptions): System {
  const { data } = options
  let reportedWrongWorld = false
  let lastObjectCount = -1
  let lastRoomCount = -1

  return {
    name: NAVIGATION_SYSTEM_NAME,
    period: NAVIGATION_SYSTEM_PERIOD,

    update(context: SystemContext): void {
      const tick = context.clock.tick
      if (!isInmateWorld(context.world)) {
        if (reportedWrongWorld) return
        reportedWrongWorld = true
        context.events.emit({
          tick,
          kind: 'navigation.rejected',
          causeIds: [],
          data: { command: NAVIGATION_SYSTEM_NAME, reason: 'wrong-world' },
        })
        return
      }

      const world = context.world
      rebuildPathingDerivations(world, data)
      maybeRefreshGoals(world, lastObjectCount, lastRoomCount, (objects, rooms) => {
        lastObjectCount = objects
        lastRoomCount = rooms
      })
      world.flowFields.tick(world.grid, world.sectors)
      applyRoutineGoals(world, data)
    },
  }
}

function rebuildPathingDerivations(world: InmateWorld, data: GameData): void {
  if (world.pathingDirtyTiles.size > 0) {
    world.regions.markDirty(world.pathingDirtyTiles)
    world.flowFields.markDirtyTiles(world.pathingDirtyTiles)
    world.pathingDirtyTiles.clear()
    world.regions.rebuildDirty(world.grid, world.doors, data, world.sectors)
  }
}

function maybeRefreshGoals(
  world: InmateWorld,
  lastObjectCount: number,
  lastRoomCount: number,
  commit: (objects: number, rooms: number) => void,
): void {
  const objectCount = world.objects.size
  const roomCount = world.rooms.size
  if (objectCount === lastObjectCount && roomCount === lastRoomCount) return
  world.flowFields.refreshStandardGoals({
    grid: world.grid,
    objects: world.objects,
    rooms: world.rooms,
    materials: world.materials,
    data: world.data,
  })
  commit(objectCount, roomCount)
}

function applyRoutineGoals(world: InmateWorld, data: GameData): void {
  const size = world.grid.size

  for (const entity of world.inmates.all()) {
    if (isInmateEscorted(world.escorts, entity.id)) {
      clearMotion(entity)
      continue
    }

    const needState = world.needsRuntime.stateOf(entity.id)
    if (needState.usingObjectId !== NO_OBJECT) {
      clearMotion(entity)
      continue
    }

    const category = data.securityCategories.find(entity.inmate.category)
    if (category === undefined || !category.followsRoutine) {
      clearMotion(entity)
      continue
    }

    const runtime = world.routineRuntime.stateOf(entity.id)

    // Until the first hour boundary, leave any externally set goals alone
    // (intake staging, tests, escorts that just finished).
    if (runtime.blockId === null) continue

    // Own-cell / explicit tile → A* via the pathing system.
    if (runtime.goalTile >= 0) {
      const here = entity.ty * size + entity.tx
      if (here === runtime.goalTile) {
        clearMotion(entity)
        continue
      }
      if (entity.path !== null && entity.pathIndex < entity.path.length) {
        if (entity.goalTile === runtime.goalTile) continue
      }
      if (entity.goalTile !== runtime.goalTile || (entity.path === null && !entity.awaitingPath)) {
        world.agents.setGoal(entity.id, runtime.goalTile)
      }
      continue
    }

    // Shared destination → sample the flow field one step at a time.
    if (runtime.goalSetId === null) {
      clearMotion(entity)
      continue
    }

    if (entity.path !== null && entity.pathIndex < entity.path.length) continue

    // Per-category mask: a sector restricted to other categories is absent
    // from this inmate's field, so they simply never route into it (T4.1).
    const field = world.flowFields.request(runtime.goalSetId, entity.accessMask)
    if (field === null) continue

    applyFlowStep(entity, field, size)
  }
}

function applyFlowStep(
  entity: { tx: number; ty: number; goalTile: number; path: number[] | null; pathIndex: number; awaitingPath: boolean; dx: number; dy: number },
  field: FlowField,
  size: number,
): void {
  const here = entity.ty * size + entity.tx
  const cost = field.costs[here] ?? 0xffffffff
  if (cost === 0) {
    clearMotion(entity)
    return
  }

  const dir = field.directions[here] ?? FLOW_DIR.NONE
  if (dir === FLOW_DIR.NONE) {
    clearMotion(entity)
    return
  }

  const step = FLOW_STEP[dir]
  if (step === undefined) {
    clearMotion(entity)
    return
  }

  const nextTx = entity.tx + step[0]
  const nextTy = entity.ty + step[1]
  if (nextTx < 0 || nextTy < 0 || nextTx >= size || nextTy >= size) {
    clearMotion(entity)
    return
  }

  const next = nextTy * size + nextTx
  entity.goalTile = next
  entity.path = [here, next]
  entity.pathIndex = 1
  entity.awaitingPath = false
}

function clearMotion(entity: {
  goalTile: number
  path: number[] | null
  pathIndex: number
  awaitingPath: boolean
  dx: number
  dy: number
}): void {
  entity.goalTile = -1
  entity.path = null
  entity.pathIndex = 0
  entity.awaitingPath = false
  entity.dx = 0
  entity.dy = 0
}
