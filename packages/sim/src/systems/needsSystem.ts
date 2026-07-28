/**
 * `NeedsSystem`: fill, discharge and critical behaviours (T2.5, PRD 5.4).
 *
 * Runs once per in-game minute. For every inmate it:
 *
 *   1. Fills needs from their drivers (time, confinement, addiction, or a
 *      contextual set from danger / dirt / proximity / temperature).
 *   2. Discharges needs while the inmate is `using` an operational object,
 *      subtracting each served need's `decayOnUse`.
 *   3. On a rising edge across `thresholds.critical`, fires the need's
 *      critical behaviour and emits a `needs.critical` CausalEvent.
 *
 * Slot 6 in the PRD 4.4 order — after movement, before activity. Activity
 * (T2.6) claims objects; this system only reads the claim and discharges.
 */

import { TICKS_PER_MINUTE } from '../core/clock'
import type { EventSink, System, SystemContext } from '../core/simulation'
import type { GameData } from '../data/loader'
import type { CriticalBehaviour, NeedDef } from '../data/schemas'
import {
  NEEDS_EVENTS,
  NeedIndex,
  applyNeedDischarge,
  applyNeedFills,
  clampNeed,
  meanRoomDirt,
  nearbyInmatesInTileRoom,
  resolveUsingObject,
} from '../entities/needs'
import type { InmateNeedState, NeedFillContext } from '../entities/needs'
import type { InmateEntity } from '../entities/inmate'
import { suppressedNeedFor } from './programSystem'
import { isInmateWorld } from './intakeSystem'
import { NO_ROOM } from '../world/rooms'
import { waterUseMultiplier } from './utilitiesSystem'

export interface NeedsSystemOptions {
  readonly data: GameData
  /** Optional shared index; defaults to one built from `data.needs`. */
  readonly index?: NeedIndex
}

export const NEEDS_SYSTEM_NAME = 'needs'

/** PRD 4.4: Needs runs once an in-game minute. */
export const NEEDS_SYSTEM_PERIOD = TICKS_PER_MINUTE

export function createNeedsSystem(options: NeedsSystemOptions): System {
  const { data } = options
  const index = options.index ?? NeedIndex.fromData(data)
  let reportedWrongWorld = false

  return {
    name: NEEDS_SYSTEM_NAME,
    period: NEEDS_SYSTEM_PERIOD,

    update(context: SystemContext): void {
      const world = context.world
      const tick = context.clock.tick

      if (!isInmateWorld(world)) {
        if (reportedWrongWorld) return
        reportedWrongWorld = true
        context.events.emit({
          tick,
          kind: NEEDS_EVENTS.rejected,
          causeIds: [],
          data: { command: NEEDS_SYSTEM_NAME, reason: 'wrong-world' },
        })
        return
      }

      const balance = data.balance.needs
      const dirtMax = data.balance.logistics.dirt.max
      const urineDirt = data.balance.logistics.dirt.perUrination

      for (const entity of world.inmates.all()) {
        const state = world.needsRuntime.stateOf(entity.id)
        const tileIndex = entity.ty * world.grid.size + entity.tx
        const roomId = world.grid.getAt('roomId', tileIndex)

        const fillCtx: NeedFillContext = {
          lockedUp: state.lockedUp,
          dangerLevel: world.dangerLevel,
          meanRoomDirt: meanRoomDirt(world.grid, world.rooms, tileIndex),
          nearbyInmateCount: nearbyInmatesInTileRoom(world.inmates, world.grid, entity),
          temperatureC: world.grid.temperature[tileIndex] ?? 0,
          traits: entity.inmate.traits,
          addictions: entity.inmate.addictions,
        }

        applyNeedFills(entity.inmate.needs, index, balance, fillCtx)

        // Substance Treatment holds the narcotics need down for as long as the
        // inmate stays enrolled, and no longer (PRD 5.9).
        const suppressedNeed = suppressedNeedFor(world, data, entity.id)
        if (suppressedNeed !== undefined) {
          const suppressedIndex = index.indexOf(suppressedNeed)
          if (suppressedIndex >= 0) entity.inmate.needs[suppressedIndex] = 0
        }

        const using = resolveUsingObject(world.objects, state.usingObjectId)
        if (using !== undefined) {
          const def = data.objects.find(using.object.defId)
          if (def !== undefined && def.servesNeeds.length > 0) {
            const scale =
              def.needsWater && isInmateWorld(world)
                ? waterUseMultiplier(world, using.tileIndex)
                : 1
            applyNeedDischarge(entity.inmate.needs, index, def.servesNeeds, scale)
          }
        }

        processCriticals({
          entity,
          state,
          index,
          events: context.events,
          tick,
          urineDirt,
          tileIndex,
          roomId,
          starveDamage: balance.starveDamagePerMinute,
          exposureDamage: balance.exposureDamagePerMinute,
          setDirt: (tile, amount) => {
            const next = Math.min(dirtMax, (world.grid.dirt[tile] ?? 0) + amount)
            world.grid.setAt('dirt', tile, next)
          },
        })
      }
    },
  }
}

/* -------------------------------------------------------------------------- */
/* Critical behaviours                                                         */
/* -------------------------------------------------------------------------- */

interface CriticalDeps {
  readonly entity: InmateEntity
  readonly state: InmateNeedState
  readonly index: NeedIndex
  readonly events: EventSink
  readonly tick: number
  readonly urineDirt: number
  readonly tileIndex: number
  readonly roomId: number
  readonly starveDamage: number
  readonly exposureDamage: number
  readonly setDirt: (tileIndex: number, amount: number) => void
}

function processCriticals(deps: CriticalDeps): void {
  const { entity, state, index } = deps
  const values = entity.inmate.needs

  for (let i = 0; i < index.size; i += 1) {
    const def = index.defAt(i)
    const valueBefore = values[i] ?? 0
    const critical = def.thresholds.critical
    const crossed = valueBefore >= critical && (state.criticalLatch[i] ?? 0) === 0

    if (crossed) {
      fireCriticalCrossing(deps, def, i, valueBefore)
    }

    // Re-read: urinate resets the need to 0 on the crossing tick.
    const valueAfter = values[i] ?? 0
    const stillCritical = valueAfter >= critical

    if (stillCritical) {
      sustainCritical(deps, def)
    } else if (def.criticalBehaviour === 'starve') {
      state.starveMinutes = 0
    }

    state.criticalLatch[i] = stillCritical ? 1 : 0
  }
}

function fireCriticalCrossing(
  deps: CriticalDeps,
  def: NeedDef,
  needIndex: number,
  value: number,
): void {
  const behaviour: CriticalBehaviour = def.criticalBehaviour ?? 'none'
  const { entity, state, events, tick } = deps
  const data: Record<string, string | number | boolean | null> = {
    inmateId: entity.id,
    needId: def.id,
    needIndex,
    value,
    behaviour,
  }

  switch (behaviour) {
    case 'urinate': {
      deps.setDirt(deps.tileIndex, deps.urineDirt)
      // Relieving on the floor empties the bladder; otherwise it would latch
      // forever without a toilet and never re-cross.
      entity.inmate.needs[needIndex] = 0
      data['dirtAdded'] = deps.urineDirt
      data['tileIndex'] = deps.tileIndex
      data['roomId'] = deps.roomId === NO_ROOM ? null : deps.roomId
      break
    }
    case 'starve': {
      state.starveMinutes = 0
      break
    }
    case 'seekWeapon': {
      state.seekingWeapon = true
      data['seekingWeapon'] = true
      break
    }
    case 'digTunnel': {
      state.diggingTunnel = true
      data['diggingTunnel'] = true
      break
    }
    case 'withdrawal': {
      addStatus(entity, 'withdrawal')
      data['status'] = 'withdrawal'
      break
    }
    case 'exposure': {
      addStatus(entity, 'exposure')
      data['status'] = 'exposure'
      break
    }
    case 'none':
      break
  }

  events.emit({
    tick,
    kind: NEEDS_EVENTS.critical,
    causeIds: [entity.id],
    data,
  })
}

/**
 * Per-minute effects that continue while the need stays critical (starvation
 * timer / exposure damage). Crossing already emitted the CausalEvent.
 */
function sustainCritical(deps: CriticalDeps, def: NeedDef): void {
  const behaviour = def.criticalBehaviour ?? 'none'
  const { entity, state } = deps

  if (behaviour === 'starve') {
    state.starveMinutes += 1
    entity.inmate.health = clampNeed(entity.inmate.health - deps.starveDamage)
  } else if (behaviour === 'exposure') {
    entity.inmate.health = clampNeed(entity.inmate.health - deps.exposureDamage)
  }
}

function addStatus(entity: InmateEntity, status: 'withdrawal' | 'exposure'): void {
  if (entity.inmate.status.includes(status)) return
  entity.inmate.status.push(status)
}
