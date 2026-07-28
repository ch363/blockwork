/**
 * `RoomSystem`: re-detects the rooms construction has invalidated (T1.3).
 *
 * `RoomWorld.structureChanged` marks a tile stale whenever a wall, door or
 * foundation appears or vanishes, and `updateStaleRooms` is documented as the
 * tick-time entry point that drains that set. Nothing was calling it. The
 * command handlers re-detect eagerly because a designation is instant, but a
 * *structural* change is not: a wall completes inside `constructionSystem`,
 * long after the command that ordered it was applied, and the room either side
 * of it stays stale forever without this.
 *
 * It runs every ten ticks — the same period as construction, immediately after
 * it in the fixed order of PRD 4.4 — so a minute's worth of completed sites is
 * drained in one pass. That batching is the point: demolishing a wing marks
 * several hundred tiles stale, and one flood fill over the affected components
 * is the difference between 2ms and 400.
 *
 * A pass with nothing stale costs one `Set.size` check, so running this every
 * minute on a finished prison is free.
 */

import { TICKS_PER_MINUTE } from '../core/clock'
import type { System, SystemContext } from '../core/simulation'
import type { GameData } from '../data/loader'
import { RoomWorld } from '../world/rooms'
import { updateStaleRooms } from '../world/roomDetection'
import type { RoomDeps } from '../world/roomDetection'

export interface RoomSystemOptions {
  readonly data: GameData
}

export const ROOM_SYSTEM_NAME = 'rooms'

/** PRD 4.4: structure-driven work is on the ten-tick cadence. */
export const ROOM_SYSTEM_PERIOD = TICKS_PER_MINUTE

export function createRoomSystem(options: RoomSystemOptions): System {
  const { data } = options
  let reportedWrongWorld = false

  return {
    name: ROOM_SYSTEM_NAME,
    period: ROOM_SYSTEM_PERIOD,

    update(context: SystemContext): void {
      const world = context.world
      const tick = context.clock.tick

      if (!(world instanceof RoomWorld)) {
        // Once, not once a minute: the wiring is either right or it is not.
        if (reportedWrongWorld) return
        reportedWrongWorld = true
        context.events.emit({
          tick,
          kind: 'rooms.rejected',
          causeIds: [],
          data: { command: ROOM_SYSTEM_NAME, reason: 'wrong-world' },
        })
        return
      }

      if (world.rooms.staleCount === 0) return

      const deps: RoomDeps = { world, data, events: context.events, tick }
      updateStaleRooms(deps)
    },
  }
}
