/**
 * Graduated emergency response and riot failure (T4.6, PRD 3.7 / 5.15).
 *
 * Escalation ladder:
 *   1. Sector lockdown — free, +suppression in that sector
 *   2. Full lockdown — free, +suppression prison-wide, needs unmet
 *   3. Riot squad — $/hour, temporary callable staff, +fear
 *   4. Free fire — free, deaths, re-offending + PR penalty
 *   5. National guard — huge $, retakes prison, high chance of being fired
 *
 * Uncontained riot failure: warning after `failure.uncontainedRiot.warningHours`,
 * then game-over after a further `thenHours`. Containment (riot.contained)
 * cancels the countdown. The warning is the CEO-equivalent notification.
 */

import { isJsonArray } from '../core/commands'
import type { Command, JsonValue } from '../core/commands'
import { TICKS_PER_HOUR, TICKS_PER_MINUTE } from '../core/clock'
import type { CommandHandler, System, SystemContext } from '../core/simulation'
import type { GameData } from '../data/loader'
import { FACILITY_SOURCE_ID } from '../entities/economy'
import { fireStaff, NO_PIN, NO_STAFF } from '../entities/staff'
import type { StaffEntity } from '../entities/staff'
import { NO_ROOM } from '../world/rooms'

import { isInmateWorld } from './intakeSystem'
import type { InmateWorld } from './intakeSystem'

export { EmergencyState } from '../entities/securityState'

/* -------------------------------------------------------------------------- */
/* Events / commands                                                           */
/* -------------------------------------------------------------------------- */

export const EMERGENCY_EVENTS = {
  sectorLockdown: 'emergency.sectorLockdown',
  sectorLockdownLifted: 'emergency.sectorLockdownLifted',
  fullLockdown: 'emergency.fullLockdown',
  fullLockdownLifted: 'emergency.fullLockdownLifted',
  riotSquadCalled: 'emergency.riotSquadCalled',
  riotSquadDismissed: 'emergency.riotSquadDismissed',
  freeFireAuthorised: 'emergency.freeFireAuthorised',
  freeFireRevoked: 'emergency.freeFireRevoked',
  freeFireKill: 'emergency.freeFireKill',
  nationalGuardCalled: 'emergency.nationalGuardCalled',
  playerFired: 'emergency.playerFired',
  failureWarning: 'failure.riotWarning',
  failure: 'failure.riot',
  failureCancelled: 'failure.riotCancelled',
  rejected: 'emergency.rejected',
} as const

export const EMERGENCY_COMMANDS = {
  sectorLockdown: 'emergency.sectorLockdown',
  liftSectorLockdown: 'emergency.liftSectorLockdown',
  fullLockdown: 'emergency.fullLockdown',
  liftFullLockdown: 'emergency.liftFullLockdown',
  callRiotSquad: 'emergency.callRiotSquad',
  dismissRiotSquad: 'emergency.dismissRiotSquad',
  authoriseFreeFire: 'emergency.authoriseFreeFire',
  revokeFreeFire: 'emergency.revokeFreeFire',
  callNationalGuard: 'emergency.callNationalGuard',
  setFailureEnabled: 'map.setRiotFailureEnabled',
} as const

export const EMERGENCY_SYSTEM_NAME = 'emergency'
export const EMERGENCY_SYSTEM_PERIOD = TICKS_PER_MINUTE

export type EmergencyLevel = 1 | 2 | 3 | 4 | 5

export const EMERGENCY_LEVELS: readonly {
  readonly level: EmergencyLevel
  readonly id: string
  readonly label: string
  readonly costLabel: string
  readonly sideEffect: string
}[] = [
  {
    level: 1,
    id: 'sector_lockdown',
    label: 'Sector lockdown',
    costLabel: 'Free',
    sideEffect: '+suppression in that sector',
  },
  {
    level: 2,
    id: 'full_lockdown',
    label: 'Full lockdown',
    costLabel: 'Free',
    sideEffect: '+suppression prison-wide, needs go unmet',
  },
  {
    level: 3,
    id: 'riot_squad',
    label: 'Call in riot squad',
    costLabel: '$/hour',
    sideEffect: 'Injuries, +fear',
  },
  {
    level: 4,
    id: 'free_fire',
    label: 'Free fire authorisation',
    costLabel: 'Free',
    sideEffect: 'Deaths, huge re-offending and PR penalty',
  },
  {
    level: 5,
    id: 'national_guard',
    label: 'Call the national guard',
    costLabel: 'Huge $',
    sideEffect: 'Prison retaken; you are almost certainly fired',
  },
]

/* -------------------------------------------------------------------------- */
/* System                                                                      */
/* -------------------------------------------------------------------------- */

export interface EmergencySystemOptions {
  readonly data: GameData
}

export function createEmergencySystem(options: EmergencySystemOptions): System {
  const { data } = options
  let reportedWrongWorld = false
  /** Last observed riot.active to detect rising edges for the failure clock. */
  let wasRiotActive = false

  return {
    name: EMERGENCY_SYSTEM_NAME,
    period: EMERGENCY_SYSTEM_PERIOD,

    update(context: SystemContext): void {
      if (!isInmateWorld(context.world)) {
        if (reportedWrongWorld) return
        reportedWrongWorld = true
        context.events.emit({
          tick: context.clock.tick,
          kind: EMERGENCY_EVENTS.rejected,
          causeIds: [],
          data: { command: EMERGENCY_SYSTEM_NAME, reason: 'wrong-world' },
        })
        return
      }

      const world = context.world
      const tick = context.clock.tick
      const emergency = world.emergency

      // Sync facility lockdown flag with level-2.
      world.lockdownActive = emergency.fullLockdown

      applyLockdownSuppression(world, data)
      applyRiotSquadFear(world, data)
      chargeRiotSquadWages(world, data, tick, context)
      runFreeFire(world, data, tick, context)
      advanceFailureCountdown(world, data, tick, context, wasRiotActive)
      wasRiotActive = world.riot.active
    },
  }
}

function applyLockdownSuppression(world: InmateWorld, data: GameData): void {
  const balance = data.balance.emergency
  const sectorRate = balance.sectorLockdownSuppressionPerHour / 60
  const fullRate = balance.fullLockdownSuppressionPerHour / 60

  for (const inmate of world.inmates.all()) {
    if (inmate.inmate.health <= 0) continue
    let gain = 0
    if (world.emergency.fullLockdown) {
      gain += fullRate
      // Needs go unmet: freeze discharge by marking locked up.
      world.needsRuntime.stateOf(inmate.id).lockedUp = true
    }
    if (world.emergency.sectorLockdowns.size > 0) {
      const tile = inmate.ty * world.grid.size + inmate.tx
      const sectorId = world.grid.getAt('sectorId', tile)
      if (sectorId !== 0 && world.emergency.sectorLockdowns.has(sectorId)) {
        gain += sectorRate
      }
    }
    if (gain > 0) {
      inmate.inmate.suppression = Math.min(100, inmate.inmate.suppression + gain)
    }
  }
}

function applyRiotSquadFear(world: InmateWorld, data: GameData): void {
  if (!world.emergency.riotSquadActive) return
  const boost = data.balance.emergency.riotSquadFearBoost
  const safetyIndex = needIndexOf(data, 'safety')
  if (safetyIndex < 0) return
  for (const inmate of world.inmates.all()) {
    if (inmate.inmate.health <= 0) continue
    const value = inmate.inmate.needs[safetyIndex] ?? 0
    inmate.inmate.needs[safetyIndex] = Math.min(100, Math.max(value, boost))
  }
}

function chargeRiotSquadWages(
  world: InmateWorld,
  data: GameData,
  tick: number,
  context: SystemContext,
): void {
  if (!world.emergency.riotSquadActive) return
  const def = data.staff.get(data.balance.emergency.riotSquadDefId)
  const hourly = def.hourlyWage
  if (hourly <= 0) return

  const last = world.emergency.riotSquadLastWageTick
  if (last === 0) {
    world.emergency.riotSquadLastWageTick = tick
    return
  }
  const hoursDue = Math.floor((tick - last) / TICKS_PER_HOUR)
  if (hoursDue < 1) return

  const heads = world.emergency.riotSquadStaffIds.length
  const amount = hourly * heads * hoursDue
  if (amount > 0) {
    world.economy.debit(
      tick,
      'emergency',
      amount,
      `Riot squad wages (${heads} × $${hourly}/h × ${hoursDue}h)`,
      FACILITY_SOURCE_ID,
    )
  }
  world.emergency.riotSquadLastWageTick = last + hoursDue * TICKS_PER_HOUR
  void context
}

function runFreeFire(
  world: InmateWorld,
  data: GameData,
  tick: number,
  context: SystemContext,
): void {
  if (!world.emergency.freeFireActive) return
  if (world.riot.riotingInmateIds.size === 0) return

  const chance = data.balance.emergency.freeFireKillChancePerMinute
  const rng = context.rng.stream('emergency.freefire')
  const armedStaff = [...world.staff.all()].filter((entity) => {
    const def = data.staff.find(entity.staff.defId)
    return def !== undefined && def.capabilities.includes('armed')
  })
  if (armedStaff.length === 0) return

  for (const inmateId of [...world.riot.riotingInmateIds]) {
    const inmate = world.inmates.get(inmateId)
    if (inmate === undefined || inmate.inmate.health <= 0) continue
    if (rng.next() >= chance) continue

    inmate.inmate.health = 0
    world.riot.riotingInmateIds.delete(inmateId)
    context.events.emit({
      tick,
      kind: EMERGENCY_EVENTS.freeFireKill,
      subjectId: inmateId,
      causeIds: [],
      data: { inmateId, armedStaff: armedStaff.length },
    })
  }
}

function advanceFailureCountdown(
  world: InmateWorld,
  data: GameData,
  tick: number,
  context: SystemContext,
  wasRiotActive: boolean,
): void {
  const emergency = world.emergency
  if (!emergency.riotFailureEnabled || emergency.failed || emergency.playerFired) return

  // Containment: rising quiet clears the clock.
  if (!world.riot.active && wasRiotActive) {
    if (emergency.warningAtTick !== null || emergency.failureAtTick !== null) {
      emergency.cancelFailureCountdown()
      context.events.emit({
        tick,
        kind: EMERGENCY_EVENTS.failureCancelled,
        causeIds: [],
        data: { reason: 'contained' },
      })
    }
    return
  }

  if (!world.riot.active) return

  const cfg = data.balance.failure.uncontainedRiot
  const warningTicks = cfg.warningHours * TICKS_PER_HOUR
  const thenTicks = cfg.thenHours * TICKS_PER_HOUR

  if (emergency.warningAtTick === null) {
    // `startedAtTick` may be 0 (riot began at the epoch of the run).
    const start = world.riot.startedAtTick
    emergency.warningAtTick = start + warningTicks
    emergency.failureAtTick = start + warningTicks + thenTicks
  }

  if (
    !emergency.warningEmitted &&
    emergency.warningAtTick !== null &&
    tick >= emergency.warningAtTick
  ) {
    emergency.warningEmitted = true
    context.events.emit({
      tick,
      kind: EMERGENCY_EVENTS.failureWarning,
      causeIds: [],
      data: {
        message:
          'Directorate notice: the riot remains uncontained. Restore order within six hours or the facility will be seized.',
        failureAtTick: emergency.failureAtTick,
        warningHours: cfg.warningHours,
        thenHours: cfg.thenHours,
      },
    })
  }

  if (emergency.failureAtTick !== null && tick >= emergency.failureAtTick) {
    emergency.failed = true
    emergency.playerFired = true
    context.events.emit({
      tick,
      kind: EMERGENCY_EVENTS.failure,
      causeIds: [],
      data: {
        reason: 'uncontained-riot',
        warningHours: cfg.warningHours,
        thenHours: cfg.thenHours,
        riotStartedAtTick: world.riot.startedAtTick,
      },
    })
    context.events.emit({
      tick,
      kind: EMERGENCY_EVENTS.playerFired,
      causeIds: [],
      data: { reason: 'uncontained-riot' },
    })
  }
}

function needIndexOf(data: GameData, needId: string): number {
  let i = 0
  for (const def of data.needs.all) {
    if (def.id === needId) return i
    i += 1
  }
  return -1
}

/* -------------------------------------------------------------------------- */
/* Callable staff                                                              */
/* -------------------------------------------------------------------------- */

export function summonCallableStaff(options: {
  readonly world: InmateWorld
  readonly defId: string
  readonly count: number
  readonly tick: number
  readonly events: SystemContext['events']
}): readonly number[] {
  const { world, defId, count, tick, events } = options
  const def = world.data.staff.find(defId)
  if (def === undefined || !def.callable) return []

  const ids: number[] = []
  const units = world.data.balance.map.tileWorldUnits
  const centre = Math.floor(world.grid.size / 2)

  for (let i = 0; i < count; i += 1) {
    const id = world.staff.allocateId()
    if (id === NO_STAFF) break
    const suffix = world.staff.nextHireSuffix(defId)
    const tx = Math.min(world.grid.size - 1, centre + (i % 3) - 1)
    const ty = Math.min(world.grid.size - 1, centre + Math.floor(i / 3))
    const entity: StaffEntity = {
      id,
      kind: 'staff',
      x: (tx + 0.5) * units,
      y: (ty + 0.5) * units,
      tx,
      ty,
      staff: {
        defId,
        name: `${def.name} ${suffix}`,
        officeRoomId: NO_ROOM,
        assignedAreaId: 0,
        pinnedTile: NO_PIN,
        duty: { kind: 'idle' },
        wanderCooldown: 0,
        needs: new Float32Array(world.data.needs.size),
        breakPending: false,
        breakCooldownMinutes: 0,
      },
    }
    world.staff.add(entity)
    world.combat.setStaffLoadout(
      id,
      [world.data.balance.combat.defaultWeaponId],
      world.data.balance.combat.maxHealth,
    )
    ids.push(id)
    events.emit({
      tick,
      kind: 'staff.hired',
      causeIds: [],
      data: { staffId: id, defId, callable: true },
    })
  }
  return ids
}

function dismissCallableStaff(
  world: InmateWorld,
  staffIds: readonly number[],
  tick: number,
  events: SystemContext['events'],
): void {
  for (const id of staffIds) {
    fireStaff(world, id, events, tick)
  }
}

/* -------------------------------------------------------------------------- */
/* Command handlers                                                            */
/* -------------------------------------------------------------------------- */

export function emergencyCommandHandlers(data: GameData): Readonly<Record<string, CommandHandler>> {
  return {
    [EMERGENCY_COMMANDS.sectorLockdown]: (command, context) => {
      if (!requireWorld(command, context)) return
      const sectorId = readUint(command.payload, 'sectorId')
      if (sectorId === undefined || sectorId === 0) {
        reject(context, command, 'malformed-payload')
        return
      }
      const world = context.world as InmateWorld
      if (world.sectors.get(sectorId) === undefined) {
        reject(context, command, 'unknown-sector')
        return
      }
      world.emergency.sectorLockdowns.add(sectorId)
      context.events.emit({
        tick: context.clock.tick,
        kind: EMERGENCY_EVENTS.sectorLockdown,
        causeIds: [],
        data: { sectorId, level: 1 },
      })
    },

    [EMERGENCY_COMMANDS.liftSectorLockdown]: (command, context) => {
      if (!requireWorld(command, context)) return
      const sectorId = readUint(command.payload, 'sectorId')
      if (sectorId === undefined) {
        reject(context, command, 'malformed-payload')
        return
      }
      const world = context.world as InmateWorld
      world.emergency.sectorLockdowns.delete(sectorId)
      context.events.emit({
        tick: context.clock.tick,
        kind: EMERGENCY_EVENTS.sectorLockdownLifted,
        causeIds: [],
        data: { sectorId },
      })
    },

    [EMERGENCY_COMMANDS.fullLockdown]: (command, context) => {
      if (!requireWorld(command, context)) return
      const world = context.world as InmateWorld
      world.emergency.fullLockdown = true
      world.lockdownActive = true
      context.events.emit({
        tick: context.clock.tick,
        kind: EMERGENCY_EVENTS.fullLockdown,
        causeIds: [],
        data: { level: 2 },
      })
    },

    [EMERGENCY_COMMANDS.liftFullLockdown]: (command, context) => {
      if (!requireWorld(command, context)) return
      const world = context.world as InmateWorld
      world.emergency.fullLockdown = false
      world.lockdownActive = false
      context.events.emit({
        tick: context.clock.tick,
        kind: EMERGENCY_EVENTS.fullLockdownLifted,
        causeIds: [],
        data: {},
      })
    },

    [EMERGENCY_COMMANDS.callRiotSquad]: (command, context) => {
      if (!requireWorld(command, context)) return
      const world = context.world as InmateWorld
      if (world.emergency.riotSquadActive) {
        reject(context, command, 'already-active')
        return
      }
      const ids = summonCallableStaff({
        world,
        defId: data.balance.emergency.riotSquadDefId,
        count: data.balance.emergency.riotSquadCount,
        tick: context.clock.tick,
        events: context.events,
      })
      world.emergency.riotSquadActive = true
      world.emergency.riotSquadStaffIds.push(...ids)
      world.emergency.riotSquadLastWageTick = context.clock.tick
      context.events.emit({
        tick: context.clock.tick,
        kind: EMERGENCY_EVENTS.riotSquadCalled,
        causeIds: [],
        data: {
          level: 3,
          staffIds: ids,
          hourlyWage: data.staff.get(data.balance.emergency.riotSquadDefId).hourlyWage,
          fearBoost: data.balance.emergency.riotSquadFearBoost,
        },
      })
    },

    [EMERGENCY_COMMANDS.dismissRiotSquad]: (command, context) => {
      if (!requireWorld(command, context)) return
      const world = context.world as InmateWorld
      dismissCallableStaff(
        world,
        [...world.emergency.riotSquadStaffIds],
        context.clock.tick,
        context.events,
      )
      world.emergency.clearCallable('riot_squad')
      context.events.emit({
        tick: context.clock.tick,
        kind: EMERGENCY_EVENTS.riotSquadDismissed,
        causeIds: [],
        data: {},
      })
    },

    [EMERGENCY_COMMANDS.authoriseFreeFire]: (command, context) => {
      if (!requireWorld(command, context)) return
      const world = context.world as InmateWorld
      world.emergency.freeFireActive = true
      if (!world.emergency.freeFirePenaltiesApplied) {
        world.emergency.freeFirePenaltiesApplied = true
        const penalty = data.balance.emergency.freeFireReoffendPenalty
        for (const inmate of world.inmates.all()) {
          inmate.inmate.reoffendChance = Math.min(1, inmate.inmate.reoffendChance + penalty)
        }
        world.emergency.prPenalty += data.balance.emergency.freeFirePrPenalty
      }
      context.events.emit({
        tick: context.clock.tick,
        kind: EMERGENCY_EVENTS.freeFireAuthorised,
        causeIds: [],
        data: {
          level: 4,
          reoffendPenalty: data.balance.emergency.freeFireReoffendPenalty,
          prPenalty: data.balance.emergency.freeFirePrPenalty,
        },
      })
    },

    [EMERGENCY_COMMANDS.revokeFreeFire]: (command, context) => {
      if (!requireWorld(command, context)) return
      const world = context.world as InmateWorld
      world.emergency.freeFireActive = false
      context.events.emit({
        tick: context.clock.tick,
        kind: EMERGENCY_EVENTS.freeFireRevoked,
        causeIds: [],
        data: {},
      })
    },

    [EMERGENCY_COMMANDS.callNationalGuard]: (command, context) => {
      if (!requireWorld(command, context)) return
      const world = context.world as InmateWorld
      if (world.emergency.nationalGuardActive) {
        reject(context, command, 'already-active')
        return
      }
      const cost = data.balance.emergency.nationalGuardCost
      if (cost > 0) {
        world.economy.debit(
          context.clock.tick,
          'emergency',
          cost,
          'National guard deployment',
          FACILITY_SOURCE_ID,
        )
      }
      const ids = summonCallableStaff({
        world,
        defId: data.balance.emergency.nationalGuardDefId,
        count: data.balance.emergency.nationalGuardCount,
        tick: context.clock.tick,
        events: context.events,
      })
      world.emergency.nationalGuardActive = true
      world.emergency.nationalGuardStaffIds.push(...ids)

      // Retake: clear rioters.
      world.riot.riotingInmateIds.clear()
      world.riot.clear()
      world.riotActive = false
      world.emergency.cancelFailureCountdown()

      const fireRoll = context.rng.stream('emergency.nationalGuard').next()
      const fired = fireRoll < data.balance.emergency.nationalGuardFireProbability
      if (fired) world.emergency.playerFired = true

      context.events.emit({
        tick: context.clock.tick,
        kind: EMERGENCY_EVENTS.nationalGuardCalled,
        causeIds: [],
        data: {
          level: 5,
          cost,
          staffIds: ids,
          playerFired: fired,
          fireProbability: data.balance.emergency.nationalGuardFireProbability,
        },
      })
      if (fired) {
        context.events.emit({
          tick: context.clock.tick,
          kind: EMERGENCY_EVENTS.playerFired,
          causeIds: [],
          data: { reason: 'national-guard' },
        })
      }
    },

    [EMERGENCY_COMMANDS.setFailureEnabled]: (command, context) => {
      if (!requireWorld(command, context)) return
      const enabled = readBoolean(command.payload, 'enabled')
      if (enabled === undefined) {
        reject(context, command, 'malformed-payload')
        return
      }
      ;(context.world as InmateWorld).emergency.riotFailureEnabled = enabled
    },
  }
}

/** Listen for riot.contained to cancel failure (also handled via active edge). */
export function onRiotContained(
  world: InmateWorld,
  tick: number,
  events: SystemContext['events'],
): void {
  if (world.emergency.warningAtTick === null && world.emergency.failureAtTick === null) return
  world.emergency.cancelFailureCountdown()
  events.emit({
    tick,
    kind: EMERGENCY_EVENTS.failureCancelled,
    causeIds: [],
    data: { reason: 'contained' },
  })
}

function requireWorld(command: Command, context: SystemContext): boolean {
  if (isInmateWorld(context.world)) return true
  reject(context, command, 'wrong-world')
  return false
}

function reject(context: SystemContext, command: Command, reason: string): void {
  context.events.emit({
    tick: context.clock.tick,
    kind: EMERGENCY_EVENTS.rejected,
    causeIds: [],
    data: { command: command.type, reason },
  })
}

function readUint(payload: JsonValue, key: string): number | undefined {
  if (payload === null || typeof payload !== 'object' || isJsonArray(payload)) return undefined
  const value = payload[key]
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) return undefined
  return value
}

function readBoolean(payload: JsonValue, key: string): boolean | undefined {
  if (payload === null || typeof payload !== 'object' || isJsonArray(payload)) return undefined
  const value = payload[key]
  if (typeof value !== 'boolean') return undefined
  return value
}
