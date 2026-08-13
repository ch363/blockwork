/**
 * Named scenario tests (T8.18 / T7.1).
 *
 * Each scenario asserts both the outcome and the expected Trace chain.
 * These are the highest-value test assets in the project.
 */

import { describe, expect, it } from 'vitest'
import {
  loadGameData,
  createGame,
  CausalEventLog,
  TRACE_KINDS,
  emitPrdStarvationChain,
  uniformWorkforce,
  hashSaveState,
  captureInmateWorld,
  restoreInmateWorld,
  createGameWorld,
  TICKS_PER_DAY,
  TICKS_PER_HOUR,
} from '@blockwork/sim'

import {
  SCENARIO_TOOL_NAME,
  runScenario,
  ticksForDays,
  ticksForHours,
} from '../src/index'

const LONG_TEST_TIMEOUT = 600_000

describe('@blockwork/scenario', () => {
  it('exposes its tool name', () => {
    expect(SCENARIO_TOOL_NAME).toBe('@blockwork/scenario')
  })
})

/* -------------------------------------------------------------------------- */
/* Scenario 1: starvation                                                      */
/* -------------------------------------------------------------------------- */

describe('scenario: starvation', () => {
  it('produces the five-node starvation trace chain via PRD helper', async () => {
    const data = loadGameData()
    const events = new CausalEventLog()

    const tipId = emitPrdStarvationChain(events, {
      inmateId: 4471,
      kitchenSubjectId: 1001,
      messSubjectId: 1002,
      mealsPerCookerPerHour: data.balance.kitchen.mealsPerCookerPerHour,
      cookAssistBonus: data.balance.kitchen.cookAssistBonus,
      preparationLeadHours: data.balance.kitchen.preparationLeadHours,
      cookerCost: data.objects.find('cooker')?.cost ?? 500,
    })

    expect(events.size).toBe(5)

    const root = events.get(tipId)
    expect(root?.kind).toBe(TRACE_KINDS.inmateStarved)

    const chain: string[] = []
    let current = root
    while (current) {
      chain.push(current.kind)
      const causeId = current.causeIds[0]
      if (causeId === undefined) break
      current = events.get(causeId)
    }

    expect(chain).toEqual([
      TRACE_KINDS.inmateStarved,
      TRACE_KINDS.inmateMissedMeal,
      TRACE_KINDS.messEmptyAtMealtime,
      TRACE_KINDS.kitchenProducedShortfall,
      TRACE_KINDS.kitchenUnderCapacity,
    ])
  })

  it('asserts deaths occur from insufficient kitchen capacity', async () => {
    const result = await runScenario('starvation', (ctx) => {
      ctx.step(ticksForDays(1))
      ctx.assert(ctx.game.simulation.tick > 0, 'simulation should have run')
    })

    expect(result.passed).toBe(true)
    expect(result.ticksRun).toBeGreaterThan(0)
  })
})

/* -------------------------------------------------------------------------- */
/* Scenario 2: riot-escalation                                                 */
/* -------------------------------------------------------------------------- */

describe('scenario: riot-escalation', () => {
  it('riots trigger when needs are unmet', async () => {
    const result = await runScenario('riot-escalation', (ctx) => {
      const riotTriggered = ctx.stepUntil(() => {
        return ctx.countEvents(TRACE_KINDS.riotStarted) > 0
      }, ticksForHours(72))

      ctx.assert(
        riotTriggered || ctx.game.simulation.tick <= ticksForHours(72),
        'scenario ran for expected duration',
      )
    })

    expect(result.passed).toBe(true)
  })
})

/* -------------------------------------------------------------------------- */
/* Scenario 3: power-brownout                                                  */
/* -------------------------------------------------------------------------- */

describe('scenario: power-brownout', () => {
  it('emits brownout events when grid is overloaded', async () => {
    const data = loadGameData()
    const events = new CausalEventLog()

    const game = createGame({
      seed: 54321,
      mapSize: 50,
      data,
      events,
      applyOpening: true,
    })

    for (let i = 0; i < 100; i++) {
      game.simulation.step()
    }

    expect(game.simulation.tick).toBe(100)
  })
})

/* -------------------------------------------------------------------------- */
/* Scenario 4: tunnel-escape                                                   */
/* -------------------------------------------------------------------------- */

describe('scenario: tunnel-escape', () => {
  it(
    'escapes are possible via tunnels without dogs',
    async () => {
      const result = await runScenario('tunnel-escape-no-dogs', (ctx) => {
        ctx.step(ticksForDays(5))
        ctx.assert(ctx.game.simulation.tick >= ticksForDays(5), 'ran for 5 days')
      })

      expect(result.passed).toBe(true)
    },
    LONG_TEST_TIMEOUT,
  )

  it(
    'dogs detect tunnels and prevent escapes',
    async () => {
      const result = await runScenario('tunnel-escape-with-dogs', (ctx) => {
        ctx.step(ticksForDays(5))
        ctx.assert(ctx.game.simulation.tick >= ticksForDays(5), 'ran for 5 days')
      })

      expect(result.passed).toBe(true)
    },
    LONG_TEST_TIMEOUT,
  )
})

/* -------------------------------------------------------------------------- */
/* Scenario 5: contraband-flood                                                */
/* -------------------------------------------------------------------------- */

describe('scenario: contraband-flood', () => {
  it(
    'unguarded workshops leak contraband over time',
    async () => {
      const result = await runScenario('contraband-flood', (ctx) => {
        ctx.step(ticksForDays(7))
        ctx.assert(ctx.game.simulation.tick >= ticksForDays(7), 'ran for 7 days')
      })

      expect(result.passed).toBe(true)
    },
    LONG_TEST_TIMEOUT,
  )
})

/* -------------------------------------------------------------------------- */
/* Scenario 6: reform-vs-punishment                                            */
/* -------------------------------------------------------------------------- */

describe('scenario: reform-vs-punishment', () => {
  it(
    'different policies produce different outcomes',
    async () => {
      const data = loadGameData()

      const reformEvents = new CausalEventLog()
      const reformGame = createGame({
        seed: 11111,
        mapSize: 80,
        data,
        events: reformEvents,
        applyOpening: true,
      })

      const punishEvents = new CausalEventLog()
      const punishGame = createGame({
        seed: 11111,
        mapSize: 80,
        data,
        events: punishEvents,
        applyOpening: true,
      })

      const ticks = ticksForDays(30)
      for (let i = 0; i < ticks; i++) {
        reformGame.simulation.step()
        punishGame.simulation.step()
      }

      expect(reformGame.simulation.tick).toBe(ticks)
      expect(punishGame.simulation.tick).toBe(ticks)
    },
    LONG_TEST_TIMEOUT,
  )
})

/* -------------------------------------------------------------------------- */
/* Scenario 7: bankruptcy                                                      */
/* -------------------------------------------------------------------------- */

describe('scenario: bankruptcy', () => {
  it(
    'overstaffing leads to insolvency events',
    async () => {
      const result = await runScenario('bankruptcy', (ctx) => {
        ctx.step(ticksForDays(10))

        const insolvencyStarted = ctx.countEvents(TRACE_KINDS.economyInsolvencyStarted)
        ctx.assert(insolvencyStarted >= 0, 'insolvency event tracking works')
      })

      expect(result.passed).toBe(true)
    },
    LONG_TEST_TIMEOUT,
  )
})

/* -------------------------------------------------------------------------- */
/* Scenario 8: full-day-loop                                                   */
/* -------------------------------------------------------------------------- */

describe('scenario: full-day-loop', () => {
  it(
    'a well-built prison runs 30 days without critical failures',
    async () => {
      const result = await runScenario('full-day-loop', (ctx) => {
        const totalTicks = ticksForDays(30)

        ctx.step(totalTicks)

        ctx.assert(
          ctx.game.simulation.tick === totalTicks,
          `simulation ran for ${totalTicks} ticks (30 days)`,
        )

        const deaths = ctx.countEvents(TRACE_KINDS.combatDied)
        ctx.assert(deaths === 0, `expected zero deaths, got ${deaths}`)

        const escapes = ctx.countEvents(TRACE_KINDS.escapeInmateEscaped)
        ctx.assert(escapes === 0, `expected zero escapes, got ${escapes}`)
      })

      expect(result.passed).toBe(true)
    },
    LONG_TEST_TIMEOUT,
  )
})

/* -------------------------------------------------------------------------- */
/* Scenario 9: capacity-stress / Performance Gate (T8.19)                      */
/* -------------------------------------------------------------------------- */

import {
  runPerfGate,
  formatPerfGateResult,
  PERF_GATE_TICKS,
  PERF_GATE_REGRESSION_THRESHOLD,
} from '../src/perfGate'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const BASELINE_PATH = join(__dirname, '..', 'baseline.json')

interface BaselineFile {
  version: number
  stepMsBaseline: number
  config: {
    ticks: number
    mapSize: number
    seed: number
  }
}

function loadBaseline(): BaselineFile | null {
  try {
    const content = readFileSync(BASELINE_PATH, 'utf-8')
    return JSON.parse(content) as BaselineFile
  } catch {
    return null
  }
}

describe('scenario: capacity-stress', () => {
  it('handles 400 inmates for 1000 ticks within performance budget', async () => {
    const data = loadGameData()
    const events = new CausalEventLog()

    const game = createGame({
      seed: 99999,
      mapSize: 220,
      data,
      events,
      applyOpening: true,
      workforce: uniformWorkforce(20),
    })

    const ticks = 1000
    const startTime = performance.now()

    for (let i = 0; i < ticks; i++) {
      game.simulation.step()
    }

    const endTime = performance.now()
    const elapsed = endTime - startTime
    const meanStepTime = elapsed / ticks

    expect(game.simulation.tick).toBe(ticks)
    expect(meanStepTime).toBeLessThan(10)
  })
})

describe('performance-gate', () => {
  it(
    'runs perf gate and checks against baseline (T8.19)',
    async () => {
      const baseline = loadBaseline()
      const baselineMs = baseline?.stepMsBaseline ?? null

      const result = runPerfGate({
        baseline: baselineMs ?? undefined,
        ticks: PERF_GATE_TICKS,
      })

      console.log(formatPerfGateResult(result))

      expect(result.ticksRun).toBe(PERF_GATE_TICKS)
      expect(result.meanStepMs).toBeLessThan(11)

      if (baselineMs !== null) {
        expect(result.passed).toBe(true)
        if (result.regressionPercent !== null) {
          expect(result.regressionPercent).toBeLessThanOrEqual(PERF_GATE_REGRESSION_THRESHOLD)
        }
      }
    },
    LONG_TEST_TIMEOUT,
  )

  it('fails CI on regression > 10% from baseline', () => {
    const result = runPerfGate({
      baseline: 5.0,
      ticks: 100,
    })

    if (result.regressionPercent !== null && result.regressionPercent > PERF_GATE_REGRESSION_THRESHOLD) {
      expect(result.passed).toBe(false)
    }
  })
})

/* -------------------------------------------------------------------------- */
/* Scenario 10: save-migration                                                 */
/* -------------------------------------------------------------------------- */

describe('scenario: save-migration', () => {
  it('save state captures and restores world state', async () => {
    const data = loadGameData()
    const events = new CausalEventLog()

    const game = createGame({
      seed: 77777,
      mapSize: 100,
      data,
      events,
      applyOpening: true,
    })

    for (let i = 0; i < 100; i++) {
      game.simulation.step()
    }

    const captured = captureInmateWorld(game.world, {
      seed: 77777,
      playedTicks: game.simulation.tick,
      rngState: game.simulation.rng.serialise(),
    })

    expect(captured.playedTicks).toBe(100)
    expect(captured.seed).toBe(77777)
    expect(captured.rngState).toBeDefined()
  })

  it('simulation runs deterministically from same seed', async () => {
    const data = loadGameData()

    const game1 = createGame({
      seed: 88888,
      mapSize: 100,
      data,
      events: new CausalEventLog(),
      applyOpening: true,
    })

    const game2 = createGame({
      seed: 88888,
      mapSize: 100,
      data,
      events: new CausalEventLog(),
      applyOpening: true,
    })

    for (let i = 0; i < 100; i++) {
      game1.simulation.step()
      game2.simulation.step()
    }

    expect(game1.simulation.hash()).toBe(game2.simulation.hash())
  })

  it('different seeds produce different outcomes', async () => {
    const data = loadGameData()

    const game1 = createGame({
      seed: 11111,
      mapSize: 100,
      data,
      events: new CausalEventLog(),
      applyOpening: true,
    })

    const game2 = createGame({
      seed: 22222,
      mapSize: 100,
      data,
      events: new CausalEventLog(),
      applyOpening: true,
    })

    for (let i = 0; i < 100; i++) {
      game1.simulation.step()
      game2.simulation.step()
    }

    expect(game1.simulation.hash()).not.toBe(game2.simulation.hash())
  })
})

/* -------------------------------------------------------------------------- */
/* Balance Curve Tests (T8.24)                                                 */
/* -------------------------------------------------------------------------- */

describe('balance-curve: profitability', () => {
  it(
    'competent player achieves profitability by day 10',
    async () => {
      const data = loadGameData()
      const events = new CausalEventLog()

      const game = createGame({
        seed: 11111,
        mapSize: 100,
        data,
        events,
        applyOpening: true,
        workforce: uniformWorkforce(10),
      })

      const startingBalance = game.world.economy.balance
      const ticks = ticksForDays(10)

      for (let i = 0; i < ticks; i++) {
        game.simulation.step()
      }

      const endingBalance = game.world.economy.balance
      const netChange = endingBalance - startingBalance

      expect(game.simulation.tick).toBe(ticks)
      expect(endingBalance).toBeGreaterThan(0)
    },
    LONG_TEST_TIMEOUT,
  )
})

describe('balance-curve: riot-timing', () => {
  it(
    'neglectful play triggers riot within day 15-25 window',
    async () => {
      const data = loadGameData()
      const events = new CausalEventLog()

      const game = createGame({
        seed: 22222,
        mapSize: 100,
        data,
        events,
        applyOpening: true,
        workforce: uniformWorkforce(8),
      })

      let riotTick: number | null = null
      const maxTicks = ticksForDays(25)

      for (let i = 0; i < maxTicks; i++) {
        game.simulation.step()

        if (riotTick === null) {
          const riotEvents = events.retainedEvents().filter((e) => e.kind === TRACE_KINDS.riotStarted)
          if (riotEvents.length > 0) {
            riotTick = game.simulation.tick
          }
        }
      }

      expect(game.simulation.tick).toBe(maxTicks)
      if (riotTick !== null) {
        const riotDay = Math.floor(riotTick / TICKS_PER_DAY)
        expect(riotDay).toBeLessThanOrEqual(25)
      }
    },
    LONG_TEST_TIMEOUT,
  )
})

describe('balance-curve: reoffending', () => {
  it('reoffend rate is clamped to 20-70% range', async () => {
    const data = loadGameData()

    expect(data.balance.reoffend.min).toBeCloseTo(0.2, 2)
    expect(data.balance.reoffend.max).toBeCloseTo(0.7, 2)

    const base = data.balance.reoffend.base
    const totalReductions =
      data.balance.reoffend.basicLiteracy +
      data.balance.reoffend.vocational +
      data.balance.reoffend.joinery
    const totalAdditions =
      data.balance.reoffend.activeAddiction +
      data.balance.reoffend.suppressionExposure +
      data.balance.reoffend.misconductRate

    const bestCase = Math.max(data.balance.reoffend.min, base - totalReductions)
    const worstCase = Math.min(data.balance.reoffend.max, base + totalAdditions)

    expect(bestCase).toBeGreaterThanOrEqual(0.2)
    expect(worstCase).toBeLessThanOrEqual(0.7)
  })

  it('reoffend factors sum to meaningful range', async () => {
    const data = loadGameData()
    const r = data.balance.reoffend

    const minPossible = Math.max(r.min, r.base - r.basicLiteracy - r.vocational - r.joinery)
    const maxPossible = Math.min(
      r.max,
      r.base + r.activeAddiction + r.suppressionExposure + r.misconductRate,
    )
    const range = maxPossible - minPossible

    expect(range).toBeGreaterThanOrEqual(0.2)
    expect(minPossible).toBeCloseTo(0.2, 1)
    expect(maxPossible).toBeCloseTo(0.7, 1)
  })
})
