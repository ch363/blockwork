/**
 * Named scenario tests (T8.18 / T7.1).
 *
 * Each scenario asserts both the outcome and the expected Trace chain.
 * Worlds are fixtured on `ctx.game.world` rather than waiting in-game days.
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

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
  TICKS_PER_HOUR,
  TICKS_PER_MINUTE,
  beginRiot,
  RIOT_EVENTS,
  hireStaff,
  placeObject,
  setCableTile,
  UTILITIES_SYSTEM_PERIOD,
  UTILITIES_EVENTS,
  Registry,
  encodeSaveFile,
  decodeSaveFile,
  deserialiseSave,
  toSaveFile,
  FACILITY_SOURCE_ID,
  ECONOMY_EVENTS,
  ESCAPE_EVENTS,
  discoverTunnel,
  setCategoryRoutine,
  updateMealChain,
  type GameData,
  type ObjectDef,
} from '@blockwork/sim'

import {
  SCENARIO_TOOL_NAME,
  runScenario,
  ticksForHours,
} from '../src/index'
import { buildUndersizedKitchen, fillOwned, objectDeps, placeDog, putFloor, spawnInmate } from '../src/fixtures'
import {
  runPerfGate,
  formatPerfGateResult,
  PERF_GATE_TICKS,
  PERF_GATE_REGRESSION_THRESHOLD,
} from '../src/perfGate'

const LONG_TEST_TIMEOUT = 600_000
const STARVATION_CHAIN = [
  TRACE_KINDS.inmateMissedMeal,
  TRACE_KINDS.messEmptyAtMealtime,
  TRACE_KINDS.kitchenProducedShortfall,
  TRACE_KINDS.kitchenUnderCapacity,
] as const

function withObject(base: GameData, patch: Partial<ObjectDef> & { readonly id: string }): GameData {
  const existing = base.objects.find(patch.id)
  if (existing === undefined) throw new Error(`missing object ${patch.id}`)
  const next: ObjectDef = { ...existing, ...patch }
  const all = base.objects.all.map((def) => (def.id === patch.id ? next : def))
  return { ...base, objects: new Registry(all) }
}

describe('@blockwork/scenario', () => {
  it('exposes its tool name', () => {
    expect(SCENARIO_TOOL_NAME).toBe('@blockwork/scenario')
  })
})

describe('scenario: starvation', () => {
  it('documents the five-node PRD chain', () => {
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
    const root = events.get(tipId)
    expect(root?.kind).toBe(TRACE_KINDS.inmateStarved)
  })

  it(
    'an undersized kitchen kills an inmate and records the five-node Trace',
    async () => {
      const result = await runScenario(
        'starvation',
        (ctx) => {
          buildUndersizedKitchen(ctx.game.world, ctx.events, ctx.data)
          for (let i = 0; i < 80; i += 1) {
            spawnInmate(ctx.game.world, ctx.data, 20, 20, 9000 + i)
          }
          for (const category of ctx.data.securityCategories.all) {
            const blocks = Array.from({ length: 24 }, (_, hour) => (hour === 12 ? 'meal' : 'lockup'))
            setCategoryRoutine(ctx.game.world.routines, category.id, blocks)
          }

          const prepStart =
            12 * TICKS_PER_HOUR - ctx.data.balance.kitchen.preparationLeadHours * TICKS_PER_HOUR
          const minutes = ctx.data.balance.kitchen.preparationLeadHours * 60 + 2
          let tick = prepStart - TICKS_PER_MINUTE
          for (let i = 0; i < minutes; i += 1) {
            tick += TICKS_PER_MINUTE
            updateMealChain(ctx.game.world, ctx.data, ctx.events, tick)
          }

          const inmateId = [...ctx.game.world.meals.missedMealEventByInmate.keys()][0]
          ctx.assert(inmateId !== undefined, 'expected a missed-meal inmate')
          if (inmateId === undefined) return
          const entity = ctx.game.world.inmates.get(inmateId)
          ctx.assert(entity !== undefined, 'missed-meal inmate still exists')
          if (entity === undefined) return
          const foodIndex = ctx.data.needs.ids().indexOf('food')
          entity.inmate.health = 0
          if (foodIndex >= 0) {
            entity.inmate.needs[foodIndex] = ctx.data.needs.get('food').thresholds.critical
          }
          ctx.game.world.needsRuntime.stateOf(inmateId).starveMinutes = 30
          ctx.step(TICKS_PER_MINUTE)

          ctx.assert(ctx.countEvents(TRACE_KINDS.inmateStarved) > 0, 'expected a starvation death')
          ctx.assertTraceChain(TRACE_KINDS.inmateStarved, STARVATION_CHAIN)
        },
        { mapSize: 48, applyOpening: false, seed: 0x5a12_0001 },
      )

      expect(result.errors, result.errors.join('\n')).toEqual([])
      expect(result.passed).toBe(true)
    },
    LONG_TEST_TIMEOUT,
  )
})

describe('scenario: riot-escalation', () => {
  it('riots when danger is critical and a seed inmate flares', async () => {
    const result = await runScenario(
      'riot-escalation',
      (ctx) => {
        const seedId = spawnInmate(ctx.game.world, ctx.data, 4, 4, 1)
        for (let i = 0; i < 6; i += 1) {
          const id = spawnInmate(ctx.game.world, ctx.data, 5 + i, 4, 10 + i)
          const neighbour = ctx.game.world.inmates.get(id)
          neighbour?.inmate.needs.fill(95)
        }
        ctx.game.world.dangerLevel = 100
        beginRiot(ctx.game.world, seedId, ctx.game.simulation.tick, { events: ctx.events })
        ctx.step(TICKS_PER_MINUTE)
        ctx.assertEventKind(RIOT_EVENTS.started)
        ctx.assert(ctx.game.world.riot.active, 'riot should be active')
      },
      { mapSize: 32, applyOpening: false },
    )
    expect(result.errors, result.errors.join('\n')).toEqual([])
    expect(result.passed).toBe(true)
  })
})

describe('scenario: power-brownout', () => {
  it('sheds comfort before life-safety and emits utilities.brownout', async () => {
    const data = withObject(
      withObject(loadGameData(), { id: 'generator', outputWatts: 500 }),
      { id: 'ceiling_light', needsPower: 400, powerPriority: 'comfort' },
    )
    const patched = withObject(data, {
      id: 'water_pump',
      needsPower: 400,
      powerPriority: 'lifeSafety',
      outputWatts: 0,
      flowRate: 0,
    })

    const result = await runScenario(
      'power-brownout',
      (ctx) => {
        for (let x = 2; x <= 10; x += 1) {
          putFloor(ctx.game.world, x, 5)
          setCableTile(ctx.game.world, { x, y: 5 }, true)
        }
        const events = ctx.events
        placeObject(objectDeps(ctx.game.world, events), { x: 2, y: 4 }, 'generator')
        placeObject(objectDeps(ctx.game.world, events), { x: 6, y: 5 }, 'ceiling_light')
        placeObject(objectDeps(ctx.game.world, events), { x: 8, y: 5 }, 'water_pump')
        ctx.step(UTILITIES_SYSTEM_PERIOD)
        ctx.assertEventKind(UTILITIES_EVENTS.brownout)
        ctx.assertEventKind(TRACE_KINDS.utilitiesBrownout)
      },
      { data: patched, mapSize: 24, applyOpening: false, seed: 54321 },
    )
    expect(result.errors, result.errors.join('\n')).toEqual([])
    expect(result.passed).toBe(true)
  })
})

describe('scenario: tunnel-escape', () => {
  it('a reached tunnel queues a night-time escape without dogs', async () => {
    const result = await runScenario(
      'tunnel-escape-no-dogs',
      (ctx) => {
        fillOwned(ctx.game.world)
        const inmateId = spawnInmate(ctx.game.world, ctx.data, 3, 3, 44)
        const origin = ctx.game.world.grid.idx(3, 3)
        const tunnelId = ctx.game.world.escapes.allocateId()
        ctx.game.world.escapes.add({
          id: tunnelId,
          originTile: origin,
          tiles: [origin, ctx.game.world.grid.idx(0, 3)],
          diggerIds: [inmateId],
          discovered: false,
          progress: 0,
          reachedExit: true,
          networkId: tunnelId,
        })
        ctx.game.world.escapes.pendingEscapes.push({
          networkId: tunnelId,
          inmateIds: [inmateId],
          remainingIds: [inmateId],
        })
        const escaped = ctx.stepUntil(
          () => ctx.countEvents(ESCAPE_EVENTS.inmateEscaped) > 0,
          ticksForHours(24),
        )
        ctx.assert(escaped, 'expected a tunnel escape within 24 hours')
        ctx.assertEventKind(TRACE_KINDS.escapeInmateEscaped)
      },
      { mapSize: 24, applyOpening: false, seed: 0xe5ca_0001 },
    )
    expect(result.errors, result.errors.join('\n')).toEqual([])
    expect(result.passed).toBe(true)
  })

  it('a dog at the entrance discovers the tunnel before anyone walks', async () => {
    const result = await runScenario(
      'tunnel-escape-with-dogs',
      (ctx) => {
        fillOwned(ctx.game.world)
        const inmateId = spawnInmate(ctx.game.world, ctx.data, 4, 4, 55)
        const origin = ctx.game.world.grid.idx(4, 4)
        const tunnelId = ctx.game.world.escapes.allocateId()
        ctx.game.world.escapes.add({
          id: tunnelId,
          originTile: origin,
          tiles: [origin, ctx.game.world.grid.idx(5, 4)],
          diggerIds: [inmateId],
          discovered: false,
          progress: 0,
          reachedExit: false,
          networkId: tunnelId,
        })
        const dogRole = ctx.data.balance.tunnels.dogStaffRoleId
        const dog = placeDog(ctx.game.world, 4, 4)
        ctx.assert(
          [...ctx.game.world.staff.all()].some((staff) => staff.staff.defId === dogRole),
          `expected a ${dogRole} on the entrance`,
        )
        const tunnel = ctx.game.world.escapes.get(tunnelId)
        ctx.assert(tunnel !== undefined, 'tunnel should exist')
        if (tunnel !== undefined) {
          discoverTunnel({
            world: ctx.game.world,
            tunnel,
            data: ctx.data,
            events: ctx.events,
            tick: ctx.game.simulation.tick,
            method: 'dog',
            detectorId: dog.id,
          })
        }
        ctx.assert(ctx.countEvents(ESCAPE_EVENTS.inmateEscaped) === 0, 'no escape with dogs present')
        ctx.assertEventKind(ESCAPE_EVENTS.tunnelDiscovered)
      },
      { mapSize: 24, applyOpening: false, seed: 0xe5ca_0002 },
    )
    expect(result.errors, result.errors.join('\n')).toEqual([])
    expect(result.passed).toBe(true)
  })
})

describe('scenario: contraband-flood', () => {
  it('an unguarded workshop holds weapons in inmate hands', async () => {
    const result = await runScenario(
      'contraband-flood',
      (ctx) => {
        const weapon =
          ctx.data.contraband.all.find((item) => item.category === 'weapon')?.id ?? 'kitchen_knife'
        for (let i = 0; i < 8; i += 1) {
          const id = spawnInmate(ctx.game.world, ctx.data, 6, 6, 200 + i)
          const entity = ctx.game.world.inmates.get(id)
          if (entity === undefined) continue
          ctx.game.world.contraband.giveCarried(entity.inmate, id, weapon)
        }
        ctx.step(TICKS_PER_MINUTE)
        let armed = 0
        for (const entity of ctx.game.world.inmates.all()) {
          if (ctx.game.world.contraband.carriedOf(entity.inmate).includes(weapon)) armed += 1
        }
        ctx.assert(armed >= 8, `expected weapon prevalence, got ${String(armed)}`)
      },
      { mapSize: 32, applyOpening: false },
    )
    expect(result.errors, result.errors.join('\n')).toEqual([])
    expect(result.passed).toBe(true)
  })
})

describe('scenario: reform-vs-punishment', () => {
  it('reform and punishment prisons diverge on reoffend chance', () => {
    const data = loadGameData()
    const reform = createGame({
      seed: 11111,
      mapSize: 40,
      data,
      events: new CausalEventLog(),
      applyOpening: false,
    })
    const punish = createGame({
      seed: 11111,
      mapSize: 40,
      data,
      events: new CausalEventLog(),
      applyOpening: false,
    })
    for (let i = 0; i < 6; i += 1) {
      const rid = spawnInmate(reform.world, data, 3, 3, 300 + i)
      const pid = spawnInmate(punish.world, data, 3, 3, 300 + i)
      const r = reform.world.inmates.get(rid)
      const p = punish.world.inmates.get(pid)
      if (r !== undefined) {
        r.inmate.reoffendChance = Math.max(data.balance.reoffend.min, data.balance.reoffend.base - 0.2)
        reform.world.contracts.progress.recordProgramCompletion('basic_literacy')
      }
      if (p !== undefined) {
        p.inmate.reoffendChance = Math.min(data.balance.reoffend.max, data.balance.reoffend.base + 0.2)
      }
    }
    const mean = (game: typeof reform): number => {
      const all = [...game.world.inmates.all()]
      if (all.length === 0) return 0
      return all.reduce((sum, entity) => sum + entity.inmate.reoffendChance, 0) / all.length
    }
    expect(mean(reform)).toBeLessThan(mean(punish))
  })
})

describe('scenario: bankruptcy', () => {
  it('overstaffing with a negative ledger starts insolvency', async () => {
    const result = await runScenario(
      'bankruptcy',
      (ctx) => {
        const starting = ctx.game.world.economy.balance
        ctx.game.world.economy.debit(
          0,
          'other',
          starting + 8_000,
          'Test overspend',
          FACILITY_SOURCE_ID,
        )
        for (let i = 0; i < 24; i += 1) {
          hireStaff({
            world: ctx.game.world,
            defId: 'officer',
            events: ctx.events,
            tick: 0,
            tx: 2,
            ty: 2,
          })
        }
        ctx.assert(ctx.game.world.economy.balance < 0, 'balance should be negative')
        ctx.step(TICKS_PER_HOUR)
        ctx.assertEventKind(ECONOMY_EVENTS.insolvencyStarted)
        ctx.assertEventKind(TRACE_KINDS.economyInsolvencyStarted)
      },
      { mapSize: 32, applyOpening: false, seed: 0xba12_0007 },
    )
    expect(result.errors, result.errors.join('\n')).toEqual([])
    expect(result.passed).toBe(true)
  })
})

describe('scenario: full-day-loop', () => {
  it('a fed, housed handful of inmates does not die or escape over a day', async () => {
    const result = await runScenario(
      'full-day-loop',
      (ctx) => {
        for (let i = 0; i < 4; i += 1) {
          const id = spawnInmate(ctx.game.world, ctx.data, 5, 5, 400 + i)
          const entity = ctx.game.world.inmates.get(id)
          if (entity === undefined) continue
          entity.inmate.needs.fill(0)
          entity.inmate.health = 100
        }
        ctx.step(ticksForHours(8))
        ctx.assert(ctx.countEvents(TRACE_KINDS.inmateStarved) === 0, 'no starvation deaths')
        ctx.assert(ctx.countEvents(TRACE_KINDS.escapeInmateEscaped) === 0, 'no escapes')
        ctx.assert(ctx.countEvents(TRACE_KINDS.combatDied) === 0, 'no combat deaths')
      },
      { mapSize: 32, applyOpening: false, seed: 0xf011_0008 },
    )
    expect(result.errors, result.errors.join('\n')).toEqual([])
    expect(result.passed).toBe(true)
  })
})

describe('scenario: capacity-stress', () => {
  it('handles a crowded prison for 1000 ticks within the sim budget', () => {
    const data = loadGameData()
    const events = new CausalEventLog()
    const game = createGame({
      seed: 99999,
      mapSize: 80,
      data,
      events,
      applyOpening: true,
      workforce: uniformWorkforce(20),
    })
    for (let i = 0; i < 80; i += 1) {
      spawnInmate(game.world, data, 10 + (i % 20), 10 + Math.floor(i / 20), 5000 + i)
    }
    const ticks = 1000
    const startTime = performance.now()
    for (let i = 0; i < ticks; i += 1) game.simulation.step()
    const meanStepTime = (performance.now() - startTime) / ticks
    expect(game.simulation.tick).toBe(ticks)
    expect(meanStepTime).toBeLessThan(11)
  })
})

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

describe('performance-gate', () => {
  it(
    'runs perf gate and checks against baseline (T8.19)',
    async () => {
      const baseline = loadBaseline()
      const baselineMs = baseline?.stepMsBaseline ?? null
      const result = runPerfGate({
        ...(baselineMs === null ? {} : { baseline: baselineMs }),
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
})

describe('scenario: save-migration', () => {
  it('a v1 save loads under the current schema and stays deterministic for 100 ticks', async () => {
    const data = loadGameData()
    const events = new CausalEventLog()
    const game = createGame({
      seed: 77777,
      mapSize: 48,
      data,
      events,
      applyOpening: true,
    })
    for (let i = 0; i < 100; i += 1) game.simulation.step()

    const captured = captureInmateWorld(game.world, {
      seed: 77777,
      playedTicks: game.simulation.tick,
      rngState: game.simulation.rng.serialise(),
    })
    const file = toSaveFile(captured, { createdAt: '2031-03-12T14:05:00.000Z' })
    const bytes = await encodeSaveFile({ ...file, version: 1 })
    const fromV1 = deserialiseSave(await decodeSaveFile(bytes))
    expect(fromV1.playedTicks).toBe(100)
    expect(hashSaveState(fromV1)).toBe(hashSaveState(deserialiseSave(file)))

    const replay = async (): Promise<number> => {
      const state = deserialiseSave(await decodeSaveFile(bytes))
      const clone = createGame({
        seed: 77777,
        mapSize: 48,
        data,
        events: new CausalEventLog(),
        applyOpening: false,
      })
      restoreInmateWorld(clone.world, state, data)
      for (let i = 0; i < 100; i += 1) clone.simulation.step()
      return clone.simulation.hash()
    }
    expect(await replay()).toBe(await replay())
  })
})

describe('balance-curve: reoffending', () => {
  it('reoffend rate is clamped to 20-70% range', () => {
    const data = loadGameData()
    expect(data.balance.reoffend.min).toBeCloseTo(0.2, 2)
    expect(data.balance.reoffend.max).toBeCloseTo(0.7, 2)
  })
})
