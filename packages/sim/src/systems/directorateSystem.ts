/**
 * `DirectorateSystem`: research advances, and stops when its sponsor does
 * (T5.1, PRD 5.8).
 *
 * The rule that gives the tree its character is not the cost or the timer — it
 * is that a node belongs to an administrator. Security research is the
 * Security Director's work, so firing them does not merely slow the branch, it
 * stops it, and the player is told which post is empty. The same is true of an
 * administrator who has been hired but whose office was demolished or has
 * stopped being functional: the post exists on paper and nothing is happening.
 *
 * Progress is therefore counted in *advancing* ticks, not wall ticks since the
 * start. A node paused for a day and resumed finishes a day later, and a save
 * taken mid-pause reloads still paused.
 *
 * Slot: the research band alongside Economy (PRD 4.4 #16). It runs before
 * Economy so a node completing this minute has already unlocked whatever the
 * hour's billing might touch.
 */

import { TICKS_PER_MINUTE } from '../core/clock'
import type { Command, JsonObject, JsonValue } from '../core/commands'
import type { CommandHandler, EventSink, System, SystemContext } from '../core/simulation'
import type { GameData } from '../data/loader'
import {
  DIRECTORATE_EVENTS,
  administratorStatus,
  checkStartResearch,
  nodeDurationTicks,
} from '../entities/directorate'
import type { DirectorateRejection, ResearchPauseReason } from '../entities/directorate'
import { TRACE_KINDS } from '../trace/causalEvent'

import { isInmateWorld } from './intakeSystem'
import type { InmateWorld } from './intakeSystem'

export const DIRECTORATE_SYSTEM_NAME = 'directorate'

/**
 * Once an in-game minute. Node durations are whole hours, so a finer period
 * would only add ticks to a counter nobody reads between minutes.
 */
export const DIRECTORATE_SYSTEM_PERIOD = TICKS_PER_MINUTE

export interface DirectorateSystemOptions {
  readonly data: GameData
}

export function createDirectorateSystem(options: DirectorateSystemOptions): System {
  const { data } = options
  let reportedWrongWorld = false

  return {
    name: DIRECTORATE_SYSTEM_NAME,
    period: DIRECTORATE_SYSTEM_PERIOD,

    update(context: SystemContext): void {
      const world = context.world
      const tick = context.clock.tick

      if (!isInmateWorld(world)) {
        if (reportedWrongWorld) return
        reportedWrongWorld = true
        emitRejection(context.events, tick, 'wrong-world', {})
        return
      }

      advanceResearch(world, data, context.events, tick, DIRECTORATE_SYSTEM_PERIOD)
    },
  }
}

/**
 * One pass over the in-progress nodes.
 *
 * Exported so tests can drive it a step at a time without a `Simulation`.
 */
export function advanceResearch(
  world: InmateWorld,
  data: GameData,
  events: EventSink,
  tick: number,
  ticks: number,
): void {
  // `active()` is sorted by node id, so two runs that started the same nodes in
  // a different order still complete them in the same order on the same tick.
  for (const research of world.directorate.active()) {
    const node = data.directorate.find(research.nodeId)
    if (node === undefined) continue

    const pause = administratorStatus(world, data, node.administrator)

    if (pause !== null) {
      if (research.pausedReason !== pause) {
        research.pausedReason = pause
        emitPaused(events, tick, research.nodeId, node.branch, node.administrator, pause)
      }
      continue
    }

    if (research.pausedReason !== null) {
      research.pausedReason = null
      events.emit({
        tick,
        kind: DIRECTORATE_EVENTS.resumed,
        causeIds: [],
        data: {
          nodeId: research.nodeId,
          branch: node.branch,
          administrator: node.administrator,
        },
      })
    }

    research.elapsedTicks += ticks
    const required = nodeDurationTicks(node)
    if (research.elapsedTicks < required) continue

    world.directorate.complete(research.nodeId)
    const unlocks = data.unlocks.get(research.nodeId)
    events.emit({
      tick,
      kind: DIRECTORATE_EVENTS.completed,
      causeIds: [],
      data: {
        nodeId: research.nodeId,
        branch: node.branch,
        name: node.name,
        unlockedRooms: [...(unlocks?.rooms ?? [])],
        unlockedObjects: [...(unlocks?.objects ?? [])],
        unlockedStaff: [...(unlocks?.staff ?? [])],
        unlockedPrograms: [...(unlocks?.programs ?? [])],
        unlockedFeatures: [...(unlocks?.features ?? [])],
      },
    })
  }
}

function emitPaused(
  events: EventSink,
  tick: number,
  nodeId: string,
  branch: string,
  administrator: string,
  reason: ResearchPauseReason,
): void {
  events.emit({
    tick,
    kind: TRACE_KINDS.directorateResearchPaused,
    causeIds: [],
    data: { nodeId, branch, administrator, reason },
  })
}

/* -------------------------------------------------------------------------- */
/* Commands                                                                    */
/* -------------------------------------------------------------------------- */

export const DIRECTORATE_COMMANDS = {
  startResearch: 'directorate.start',
} as const

export function directorateCommandHandlers(
  data: GameData,
): Readonly<Record<string, CommandHandler>> {
  return {
    [DIRECTORATE_COMMANDS.startResearch]: (command, context) => {
      handleStart(command, context, data)
    },
  }
}

function handleStart(command: Command, context: SystemContext, data: GameData): void {
  const tick = context.clock.tick
  const world = context.world
  if (!isInmateWorld(world)) {
    emitRejection(context.events, tick, 'wrong-world', {})
    return
  }

  const nodeId = readString(command.payload, 'nodeId')
  if (nodeId === undefined) {
    emitRejection(context.events, tick, 'invalid-payload', {})
    return
  }

  const check = checkStartResearch({
    data,
    state: world.directorate,
    world,
    nodeId,
    balance: world.economy.balance,
  })
  if (!check.ok) {
    emitRejection(context.events, tick, check.reason ?? 'unknown-node', check.detail ?? { nodeId })
    return
  }

  // Safe: `checkStartResearch` returned ok, which requires the node to resolve.
  const node = data.directorate.get(nodeId)
  if (node.cost > 0) {
    world.economy.debit(tick, 'research', node.cost, `Directorate: ${node.name}`, 0)
  }
  world.directorate.begin(nodeId, tick)

  context.events.emit({
    tick,
    kind: DIRECTORATE_EVENTS.started,
    causeIds: [],
    data: {
      nodeId,
      branch: node.branch,
      cost: node.cost,
      durationHours: node.durationHours,
      administrator: node.administrator,
    },
  })
}

function emitRejection(
  events: EventSink,
  tick: number,
  reason: DirectorateRejection,
  detail: JsonObject,
): void {
  events.emit({
    tick,
    kind: DIRECTORATE_EVENTS.rejected,
    causeIds: [],
    data: { reason, ...detail },
  })
}

function readString(payload: JsonValue, key: string): string | undefined {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return undefined
  const value = (payload as JsonObject)[key]
  return typeof value === 'string' ? value : undefined
}
