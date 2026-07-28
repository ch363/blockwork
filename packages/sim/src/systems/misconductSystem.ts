/**
 * `MisconductSystem`: per-inmate misconduct rolls (T4.4, PRD 5.4).
 *
 * Every 10 in-game minutes each inmate rolls against the PRD probability. On a
 * hit: emit a CausalEvent, log the rap sheet, adjust entitlement, apply
 * auto-reclassification, queue Standing Orders punishment (and a search stub),
 * and propagate agitator boosts to neighbours within 5 tiles.
 */

import { TICKS_PER_MINUTE } from '../core/clock'
import type { EventSink, System, SystemContext } from '../core/simulation'
import type { GameData } from '../data/loader'
import type { MisconductKind } from '../data/schemas'
import {
  MISCONDUCT_EVENTS,
  applyAutoReclassification,
  applyEntitlementOnMisconduct,
  cellGradeMisconductModifier,
  chebyshevTiles,
  computeMisconductProbability,
  countCriticalNeeds,
  misconductKindWeights,
  pickMisconductKind,
} from '../entities/misconduct'
import type { MisconductRecord } from '../entities/misconduct'
import { NeedIndex } from '../entities/needs'
import { inmateAccessMask } from '../pathfinding/regionGraph'
import { orderForKind } from '../entities/standingOrders'
import { hasCapability } from '../entities/staff'
import { isInmateWorld } from './intakeSystem'
import type { InmateWorld } from './intakeSystem'
import { beginPunishment } from './punishmentSystem'

export interface MisconductSystemOptions {
  readonly data: GameData
  readonly index?: NeedIndex
}

export const MISCONDUCT_SYSTEM_NAME = 'misconduct'

/** PRD 5.4: one roll per inmate every `evaluationMinutes`. */
export const MISCONDUCT_SYSTEM_PERIOD = TICKS_PER_MINUTE * 10

export function createMisconductSystem(options: MisconductSystemOptions): System {
  const { data } = options
  const index = options.index ?? NeedIndex.fromData(data)
  let reportedWrongWorld = false

  return {
    name: MISCONDUCT_SYSTEM_NAME,
    period: MISCONDUCT_SYSTEM_PERIOD,

    update(context: SystemContext): void {
      const world = context.world
      const tick = context.clock.tick

      if (!isInmateWorld(world)) {
        if (reportedWrongWorld) return
        reportedWrongWorld = true
        context.events.emit({
          tick,
          kind: MISCONDUCT_EVENTS.rejected,
          causeIds: [],
          data: { command: MISCONDUCT_SYSTEM_NAME, reason: 'wrong-world' },
        })
        return
      }

      const rng = context.rng.stream('misconduct')
      const inmates = [...world.inmates.all()].sort((a, b) => a.id - b.id)

      for (const entity of inmates) {
        const criticalNeedCount = countCriticalNeeds(
          entity.inmate.needs,
          index,
          entity.inmate.traits,
        )
        const hasViolent = entity.inmate.traits.includes('violent')
        const cellGradeModifier = cellGradeMisconductModifier(
          data.balance.misconduct.cellGrade,
          world.averageCellGrade,
          cellGradeOf(world, entity.inmate.cellId),
        )
        const instigatorNearby = nearbyAgitatorPresent(world, entity.tx, entity.ty, data) ? 1 : 0
        const guardNearby = nearbyGuardPresent(
          world,
          data,
          entity.tx,
          entity.ty,
          data.balance.misconduct.guardProximityTiles,
        )
        const boost = world.punishments.agitatorBoostMultiplier(
          entity.id,
          tick,
          data.balance.misconduct.agitator.boostFactor,
        )

        const probability = computeMisconductProbability(
          data.balance.misconduct,
          data.balance.suppression.max,
          {
            category: entity.inmate.category,
            criticalNeedCount,
            cellGradeModifier,
            suppression: entity.inmate.suppression,
            instigatorNearby,
            guardNearby,
            hasViolentTrait: hasViolent,
            agitatorBoostMultiplier: boost,
          },
        )

        if (rng.next() >= probability) continue

        const kind = pickMisconductKind(
          rng,
          misconductKindWeights(data.balance.misconduct, criticalNeedCount, hasViolent),
        )
        commitMisconduct({
          world,
          data,
          events: context.events,
          tick,
          inmateId: entity.id,
          kind,
        })
      }
    },
  }
}

export interface CommitMisconductOptions {
  readonly world: InmateWorld
  readonly data: GameData
  readonly events: EventSink
  readonly tick: number
  readonly inmateId: number
  readonly kind: MisconductKind
}

/**
 * Applies one misconduct hit. Exported so tests and later combat / escape
 * systems can force a kind without rolling.
 */
export function commitMisconduct(options: CommitMisconductOptions): MisconductRecord | undefined {
  const { world, data, events, tick, inmateId, kind } = options
  const entity = world.inmates.get(inmateId)
  if (entity === undefined) return undefined

  const order = orderForKind(world.standingOrders, kind)
  const record: MisconductRecord = {
    tick,
    kind,
    punishment: order.punishment,
    durationHours: order.durationHours,
  }

  // Rap sheet — mutate the array in place (typed as mutable on the component).
  ;(entity.inmate.misconductLog as MisconductRecord[]).push(record)

  entity.inmate.entitlement = applyEntitlementOnMisconduct(
    entity.inmate.entitlement,
    kind,
    data.balance,
  )

  const reclass = applyAutoReclassification(
    entity.inmate.category,
    kind,
    data.balance.misconduct,
    data.balance.time.hoursPerSentenceYear,
  )
  if (reclass.changed) {
    const previous = entity.inmate.category
    entity.inmate.category = reclass.category
    entity.inmate.sentenceHours += reclass.sentenceHoursDelta
    entity.accessMask = inmateAccessMask(data, reclass.category)
    events.emit({
      tick,
      kind: MISCONDUCT_EVENTS.reclassified,
      subjectId: inmateId,
      causeIds: [],
      data: {
        inmateId,
        from: previous,
        to: reclass.category,
        sentenceHoursDelta: reclass.sentenceHoursDelta,
        reason: kind,
      },
    })
  }

  events.emit({
    tick,
    kind: MISCONDUCT_EVENTS.committed,
    subjectId: inmateId,
    causeIds: [],
    data: {
      inmateId,
      misconductKind: kind,
      punishment: order.punishment,
      durationHours: order.durationHours,
      entitlement: entity.inmate.entitlement,
      category: entity.inmate.category,
    },
  })

  if (order.search) {
    events.emit({
      tick,
      kind: MISCONDUCT_EVENTS.searchQueued,
      subjectId: inmateId,
      causeIds: [],
      data: { inmateId, misconductKind: kind, reason: 'standing-orders' },
    })
  }

  if (order.punishment !== 'ignore') {
    beginPunishment({
      world,
      data,
      events,
      tick,
      inmateId,
      kind: order.punishment,
      sourceMisconduct: kind,
      durationHours: order.durationHours,
    })
  }

  propagateAgitatorBoost(world, data, tick, inmateId, entity.tx, entity.ty)

  return record
}

function propagateAgitatorBoost(
  world: InmateWorld,
  data: GameData,
  tick: number,
  sourceId: number,
  tx: number,
  ty: number,
): void {
  const entity = world.inmates.get(sourceId)
  if (entity === undefined) return
  const agitatorId = data.balance.misconduct.agitator.reputationId
  const isAgitator = entity.inmate.reputations.some((rep) => rep.id === agitatorId)
  if (!isAgitator) return

  const tiles = data.balance.misconduct.agitator.nearbyTiles
  const until =
    tick + data.balance.misconduct.agitator.boostMinutes * data.balance.time.ticksPerMinute

  for (const other of world.inmates.all()) {
    if (other.id === sourceId) continue
    if (chebyshevTiles(tx, ty, other.tx, other.ty) > tiles) continue
    world.punishments.setAgitatorBoost(other.id, until)
  }
}

function nearbyAgitatorPresent(
  world: InmateWorld,
  tx: number,
  ty: number,
  data: GameData,
): boolean {
  const tiles = data.balance.misconduct.agitator.nearbyTiles
  const agitatorId = data.balance.misconduct.agitator.reputationId
  for (const other of world.inmates.all()) {
    if (chebyshevTiles(tx, ty, other.tx, other.ty) > tiles) continue
    if (other.inmate.reputations.some((rep) => rep.id === agitatorId)) return true
  }
  return false
}

function nearbyGuardPresent(
  world: InmateWorld,
  data: GameData,
  tx: number,
  ty: number,
  tiles: number,
): boolean {
  for (const staff of world.staff.all()) {
    if (!hasCapability(data, staff, 'patrol')) continue
    if (chebyshevTiles(tx, ty, staff.tx, staff.ty) <= tiles) return true
  }
  return false
}

function cellGradeOf(world: InmateWorld, cellId: number): number {
  if (cellId <= 0) return world.averageCellGrade
  return world.cellGrades.get(cellId) ?? world.averageCellGrade
}
