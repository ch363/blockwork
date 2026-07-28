/**
 * `ObjectSystem`: keeps every object's utility supply flags honest (T1.4).
 *
 * Placement sets `hasPower` and `hasWater` once, from the world as it was at
 * that moment. Supply changes afterwards — a cable is cut, a generator is
 * overloaded, a pipe is laid — and something has to notice. That is this
 * system: once an in-game minute it re-asks `suppliesPower` and
 * `suppliesWater` for every object and writes the answer back.
 *
 * It sits in PRD 4.4's slot 10, immediately alongside `UtilitiesSystem`,
 * because it is the consumer half of that slot: T5.5 will compute the grids
 * and this reads the result. Running it before the grids exist is not busy
 * work — while `balance.utilities.utilitiesEnabled` is true, every object that
 * needs power reads `powerGridId` 0 and reports itself unpowered, which is the
 * exact failure state the utilities system will have to clear. Flip the flag
 * and the Trace panel shows the unpowered kitchen today.
 *
 * An object emits a `CausalEvent` when it *loses* supply, not on every pass. A
 * prison with two hundred unpowered lights would otherwise emit two hundred
 * events a minute forever, and the Trace panel would be useless precisely when
 * it matters. Regaining supply is not a failure and is not reported here; the
 * event that caused it is the one worth tracing.
 */

import { TICKS_PER_MINUTE } from '../core/clock'
import type { System, SystemContext } from '../core/simulation'
import { ObjectWorld, suppliesPower, suppliesWater } from '../entities/objects'
import type { ObjectEntity } from '../entities/objects'
import type { GameData } from '../data/loader'

export interface ObjectSystemOptions {
  readonly data: GameData
}

export const OBJECT_SYSTEM_NAME = 'objects'

/** PRD 4.4: the utilities slot runs once an in-game minute. */
export const OBJECT_SYSTEM_PERIOD = TICKS_PER_MINUTE

export function createObjectSystem(options: ObjectSystemOptions): System {
  const { data } = options
  let reportedWrongWorld = false

  return {
    name: OBJECT_SYSTEM_NAME,
    period: OBJECT_SYSTEM_PERIOD,

    update(context: SystemContext): void {
      const world = context.world
      const tick = context.clock.tick

      if (!(world instanceof ObjectWorld)) {
        // Once, not once a minute: the wiring is either right or it is not.
        if (reportedWrongWorld) return
        reportedWrongWorld = true
        context.events.emit({
          tick,
          kind: 'objects.rejected',
          causeIds: [],
          data: { command: OBJECT_SYSTEM_NAME, reason: 'wrong-world' },
        })
        return
      }

      for (const entity of world.objects.all()) {
        const def = data.objects.find(entity.object.defId)
        if (def === undefined) continue

        const hasPower = suppliesPower(world, def, entity.tileIndex)
        const hasWater = suppliesWater(world, def, entity.tileIndex)
        const lost = (entity.object.hasPower && !hasPower) || (entity.object.hasWater && !hasWater)

        entity.object.hasPower = hasPower
        entity.object.hasWater = hasWater

        if (lost) emitUnsupplied(context, entity, tick)
      }
    },
  }
}

function emitUnsupplied(context: SystemContext, entity: ObjectEntity, tick: number): void {
  context.events.emit({
    tick,
    kind: 'objects.unsupplied',
    causeIds: [entity.id],
    data: {
      entityId: entity.id,
      objectDefId: entity.object.defId,
      tileIndex: entity.tileIndex,
      roomId: entity.object.roomId,
      power: entity.object.hasPower,
      water: entity.object.hasWater,
    },
  })
}
