/**
 * T8.9 — Routine / Contracts / Intake / Flow HUD snapshots are live, not stubs.
 */

import { describe, expect, it } from 'vitest'

import { DEFAULT_SNAPSHOT_LIMITS } from '@blockwork/sim'

import { buildControlHud } from '../../src/worker/controlHud'
import { SimWorkerLoop } from '../../src/worker/simWorker'

function loop(): SimWorkerLoop {
  return new SimWorkerLoop({
    seed: 0xb10c_0809,
    mapSize: 32,
    limits: DEFAULT_SNAPSHOT_LIMITS,
    post: () => undefined,
  })
}

describe('control HUD live panels (T8.9)', () => {
  it('Routine is the authored default, not 24 hours of free', () => {
    const worker = loop()
    const hud = buildControlHud(worker.world, worker.game.data, worker.simulation.clock, null)

    expect(hud.routine.categories.length).toBeGreaterThan(0)
    const anyMeal = hud.routine.categories.some((category) =>
      category.blocks.some((block) => block === 'meal'),
    )
    expect(anyMeal).toBe(true)
  })

  it('Contracts lists available grants and a loan snapshot', () => {
    const worker = loop()
    const hud = buildControlHud(worker.world, worker.game.data, worker.simulation.clock, null)

    expect(hud.contracts.available.length + hud.contracts.active.length).toBeGreaterThan(0)
    expect(hud.contracts.loan).not.toBeNull()
    expect(hud.contracts.loan?.maxPrincipal).toBe(worker.game.data.balance.economy.loan.maxCap)
    expect(hud.contracts.loan?.available).toBe(false)
  })

  it('Intake reports live requested counts and capacity, not a static zero bus', () => {
    const worker = loop()
    worker.world.intake.requestedCounts.set('medium', 4)
    worker.world.intake.continuous = true
    const hud = buildControlHud(worker.world, worker.game.data, worker.simulation.clock, null)

    const medium = hud.intake.categories.find((row) => row.id === 'medium')
    expect(medium?.requested).toBe(4)
    expect(hud.intake.continuous).toBe(true)
    expect(hud.intake.nextBusLabel.length).toBeGreaterThan(0)
    expect(hud.intake.capacityModel.population).toBe(0)
  })

  it('Flow has the five logistics chains with real throughput numbers', () => {
    const worker = loop()
    const hud = buildControlHud(worker.world, worker.game.data, worker.simulation.clock, null)

    expect(hud.flow.chains.map((chain) => chain.id)).toEqual([
      'meals',
      'laundry',
      'cleaning',
      'supply',
      'exports',
    ])
    for (const chain of hud.flow.chains) {
      expect(chain.stages.length).toBeGreaterThan(0)
    }
  })
})
