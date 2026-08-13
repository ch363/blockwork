/**
 * Performance gate (T8.19 / T6.9).
 *
 * A headless 400-agent, 1000-tick test that fails CI on a mean step-time
 * regression over 10% from a recorded baseline.
 *
 * PRD 7.5 budgets:
 *   - Total simulation step: 11ms
 *   - Snapshot read + interpolation: 2ms (main thread)
 *
 * This gate covers the simulation budget. Main-thread render is tested
 * separately in the app package.
 */

import { createGame, loadGameData, CausalEventLog, uniformWorkforce } from '@blockwork/sim'
import type { GameData, Game } from '@blockwork/sim'

export const PERF_GATE_TICKS = 1000
export const PERF_GATE_AGENTS = 400
export const PERF_GATE_MAP_SIZE = 220
export const PERF_GATE_REGRESSION_THRESHOLD = 0.10

export interface PerfGateResult {
  readonly passed: boolean
  readonly meanStepMs: number
  readonly baselineMs: number | null
  readonly regressionPercent: number | null
  readonly totalMs: number
  readonly ticksRun: number
  readonly message: string
}

export interface PerfGateOptions {
  /** Override the baseline for testing. */
  readonly baseline?: number
  /** Custom game data. */
  readonly data?: GameData
  /** Number of ticks to run. */
  readonly ticks?: number
  /** Callback for progress. */
  readonly onProgress?: (tick: number, total: number) => void
}

/**
 * Runs the performance gate test.
 *
 * Returns a result with pass/fail, timing stats, and regression analysis.
 */
export function runPerfGate(options: PerfGateOptions = {}): PerfGateResult {
  const data = options.data ?? loadGameData()
  const ticks = options.ticks ?? PERF_GATE_TICKS
  const baseline = options.baseline ?? null

  const events = new CausalEventLog()
  const game = createGame({
    seed: 42424242,
    mapSize: PERF_GATE_MAP_SIZE,
    data,
    events,
    applyOpening: true,
    workforce: uniformWorkforce(20),
  })

  const startTime = performance.now()

  for (let i = 0; i < ticks; i++) {
    game.simulation.step()
    options.onProgress?.(i + 1, ticks)
  }

  const endTime = performance.now()
  const totalMs = endTime - startTime
  const meanStepMs = totalMs / ticks

  let passed = true
  let regressionPercent: number | null = null
  let message: string

  if (baseline !== null && baseline > 0) {
    regressionPercent = (meanStepMs - baseline) / baseline
    passed = regressionPercent <= PERF_GATE_REGRESSION_THRESHOLD

    if (passed) {
      if (regressionPercent <= 0) {
        message = `Performance improved: ${meanStepMs.toFixed(3)}ms (${(-regressionPercent * 100).toFixed(1)}% faster than baseline ${baseline.toFixed(3)}ms)`
      } else {
        message = `Performance within threshold: ${meanStepMs.toFixed(3)}ms (${(regressionPercent * 100).toFixed(1)}% slower than baseline ${baseline.toFixed(3)}ms)`
      }
    } else {
      message = `REGRESSION: ${meanStepMs.toFixed(3)}ms is ${(regressionPercent * 100).toFixed(1)}% slower than baseline ${baseline.toFixed(3)}ms (threshold: ${PERF_GATE_REGRESSION_THRESHOLD * 100}%)`
    }
  } else {
    message = `First run: ${meanStepMs.toFixed(3)}ms mean step time over ${ticks} ticks`
  }

  return {
    passed,
    meanStepMs,
    baselineMs: baseline,
    regressionPercent,
    totalMs,
    ticksRun: ticks,
    message,
  }
}

/**
 * Formats the result for CI output.
 */
export function formatPerfGateResult(result: PerfGateResult): string {
  const lines: string[] = [
    '─'.repeat(60),
    'Performance Gate Results',
    '─'.repeat(60),
    `Status: ${result.passed ? 'PASSED ✓' : 'FAILED ✗'}`,
    `Mean step time: ${result.meanStepMs.toFixed(3)}ms`,
    `Total time: ${result.totalMs.toFixed(1)}ms`,
    `Ticks run: ${result.ticksRun}`,
  ]

  if (result.baselineMs !== null) {
    lines.push(`Baseline: ${result.baselineMs.toFixed(3)}ms`)
  }

  if (result.regressionPercent !== null) {
    const sign = result.regressionPercent >= 0 ? '+' : ''
    lines.push(`Change: ${sign}${(result.regressionPercent * 100).toFixed(1)}%`)
  }

  lines.push('─'.repeat(60))
  lines.push(result.message)
  lines.push('─'.repeat(60))

  return lines.join('\n')
}
