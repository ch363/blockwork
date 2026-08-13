/**
 * Headless scenario runner (T8.18, T7.1).
 *
 * Runs named scenarios against the simulation, asserting both outcomes and
 * expected Trace chains. Each scenario is a self-contained test that:
 *
 *   1. Sets up a world with specific conditions
 *   2. Runs the simulation for a specified number of ticks
 *   3. Collects trace events via `CausalEventLog`
 *   4. Asserts the expected outcome and trace chain
 *
 * The scenarios are the tests — they run in CI and fail the build if any
 * assertion fails.
 */

import type { Game, GameData, CausalEvent, CausalEventLog } from '@blockwork/sim'
import { createGame, loadGameData, TICKS_PER_DAY, TICKS_PER_HOUR } from '@blockwork/sim'
import { CausalEventLog as EventLog } from '@blockwork/sim'

export const SCENARIO_TOOL_NAME = '@blockwork/scenario'

/* -------------------------------------------------------------------------- */
/* Scenario result                                                             */
/* -------------------------------------------------------------------------- */

export interface ScenarioResult {
  readonly name: string
  readonly passed: boolean
  readonly ticksRun: number
  readonly errors: readonly string[]
  /** Events emitted during the run, for trace-chain inspection. */
  readonly events: readonly CausalEvent[]
}

/* -------------------------------------------------------------------------- */
/* Scenario runner                                                             */
/* -------------------------------------------------------------------------- */

export interface ScenarioOptions {
  /** Master seed for the simulation. */
  readonly seed?: number
  /** Map size (tiles per axis). */
  readonly mapSize?: number
  /** Loaded game data; defaults to real data. */
  readonly data?: GameData
  /** Callback invoked after each tick, for progress reporting. */
  readonly onTick?: (tick: number) => void
}

export interface ScenarioContext {
  readonly game: Game
  readonly data: GameData
  readonly events: CausalEventLog
  /** Run the simulation for `ticks` steps. */
  step(ticks: number): void
  /** Run until a predicate is true or `maxTicks` is reached. */
  stepUntil(predicate: () => boolean, maxTicks: number): boolean
  /** Assert a condition; failures are collected, not thrown. */
  assert(condition: boolean, message: string): void
  /** Assert an event kind appears in the log. */
  assertEventKind(kind: string, message?: string): void
  /** Assert a trace chain exists: root kind with all cause kinds in order. */
  assertTraceChain(rootKind: string, causeKinds: readonly string[]): void
  /** Count events of a given kind. */
  countEvents(kind: string): number
  /** Find the first event of a given kind. */
  findEvent(kind: string): CausalEvent | undefined
  /** All events of a given kind. */
  eventsOfKind(kind: string): readonly CausalEvent[]
}

export type ScenarioFn = (ctx: ScenarioContext) => void | Promise<void>

/**
 * Runs a named scenario and returns the result.
 */
export async function runScenario(
  name: string,
  fn: ScenarioFn,
  options: ScenarioOptions = {},
): Promise<ScenarioResult> {
  const data = options.data ?? loadGameData()
  const events = new EventLog()
  const errors: string[] = []
  let ticksRun = 0

  const game = createGame({
    seed: options.seed ?? 12345,
    mapSize: options.mapSize ?? 100,
    data,
    events,
    applyOpening: true,
    firstOrderGrace: true,
  })

  const step = (ticks: number): void => {
    for (let i = 0; i < ticks; i++) {
      game.simulation.step()
      ticksRun++
      options.onTick?.(ticksRun)
    }
  }

  const stepUntil = (predicate: () => boolean, maxTicks: number): boolean => {
    for (let i = 0; i < maxTicks; i++) {
      if (predicate()) return true
      game.simulation.step()
      ticksRun++
      options.onTick?.(ticksRun)
    }
    return predicate()
  }

  const assert = (condition: boolean, message: string): void => {
    if (!condition) {
      errors.push(message)
    }
  }

  const assertEventKind = (kind: string, message?: string): void => {
    const found = events.retainedEvents().some((e) => e.kind === kind)
    if (!found) {
      errors.push(message ?? `expected event kind '${kind}' not found`)
    }
  }

  const findEvent = (kind: string): CausalEvent | undefined => {
    return events.retainedEvents().find((e) => e.kind === kind)
  }

  const eventsOfKind = (kind: string): readonly CausalEvent[] => {
    return events.retainedEvents().filter((e) => e.kind === kind)
  }

  const countEvents = (kind: string): number => {
    return events.retainedEvents().filter((e) => e.kind === kind).length
  }

  const assertTraceChain = (rootKind: string, causeKinds: readonly string[]): void => {
    const root = findEvent(rootKind)
    if (!root) {
      errors.push(`trace chain root '${rootKind}' not found`)
      return
    }

    let current = root
    for (const causeKind of causeKinds) {
      const causeId = current.causeIds[0]
      if (causeId === undefined) {
        errors.push(`trace chain broken at '${current.kind}': no cause for '${causeKind}'`)
        return
      }
      const cause = events.get(causeId)
      if (!cause) {
        errors.push(`trace chain broken: cause id ${causeId} not found`)
        return
      }
      if (cause.kind !== causeKind) {
        errors.push(`trace chain mismatch: expected '${causeKind}', got '${cause.kind}'`)
        return
      }
      current = cause
    }
  }

  const ctx: ScenarioContext = {
    game,
    data,
    events,
    step,
    stepUntil,
    assert,
    assertEventKind,
    assertTraceChain,
    countEvents,
    findEvent,
    eventsOfKind,
  }

  try {
    await fn(ctx)
  } catch (err) {
    errors.push(`scenario threw: ${err instanceof Error ? err.message : String(err)}`)
  }

  return {
    name,
    passed: errors.length === 0,
    ticksRun,
    errors,
    events: events.retainedEvents(),
  }
}

/* -------------------------------------------------------------------------- */
/* Scenario registry                                                           */
/* -------------------------------------------------------------------------- */

const REGISTERED_SCENARIOS = new Map<string, ScenarioFn>()

export function registerScenario(name: string, fn: ScenarioFn): void {
  REGISTERED_SCENARIOS.set(name, fn)
}

export function getScenario(name: string): ScenarioFn | undefined {
  return REGISTERED_SCENARIOS.get(name)
}

export function listScenarios(): readonly string[] {
  return Array.from(REGISTERED_SCENARIOS.keys())
}

export async function runAllScenarios(
  options: ScenarioOptions = {},
): Promise<readonly ScenarioResult[]> {
  const results: ScenarioResult[] = []
  for (const [name, fn] of REGISTERED_SCENARIOS) {
    results.push(await runScenario(name, fn, options))
  }
  return results
}

/* -------------------------------------------------------------------------- */
/* Time helpers                                                                */
/* -------------------------------------------------------------------------- */

export { TICKS_PER_DAY, TICKS_PER_HOUR }

export function ticksForDays(days: number): number {
  return days * TICKS_PER_DAY
}

export function ticksForHours(hours: number): number {
  return hours * TICKS_PER_HOUR
}

/* -------------------------------------------------------------------------- */
/* Performance gate re-export (T8.19)                                          */
/* -------------------------------------------------------------------------- */

export {
  runPerfGate,
  formatPerfGateResult,
  PERF_GATE_TICKS,
  PERF_GATE_AGENTS,
  PERF_GATE_MAP_SIZE,
  PERF_GATE_REGRESSION_THRESHOLD,
} from './perfGate'
export type { PerfGateResult, PerfGateOptions } from './perfGate'
