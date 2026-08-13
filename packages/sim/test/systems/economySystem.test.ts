/**
 * T3.6 — Economy: wages, tax, insolvency, ledger invariant, 30-day cash flow.
 */

import { describe, expect, it } from 'vitest'

import { TICKS_PER_DAY, TICKS_PER_HOUR } from '../../src/core/clock'
import { Rng } from '../../src/core/rng'
import type { SimulationEvent } from '../../src/core/simulation'
import { Simulation } from '../../src/core/simulation'
import { loadGameData } from '../../src/data/loader'
import { hireStaff } from '../../src/entities/staff'
import { createInmateShell, generateInmate, NO_INMATE } from '../../src/entities/inmate'
import {
  ECONOMY_EVENTS,
  ECONOMY_SYSTEM_PERIOD,
  FACILITY_SOURCE_ID,
  applyTax,
  createEconomySystem,
  payInmateDaily,
} from '../../src/systems/economySystem'
import { createInmateWorld } from '../../src/systems/intakeSystem'
import type { InmateWorld } from '../../src/systems/intakeSystem'

const DATA = loadGameData()
const STARTING = DATA.balance.economy.startingFunds
const SEED = 0xec00_0001

class RecordingSink {
  readonly events: SimulationEvent[] = []
  emit(event: SimulationEvent): void {
    this.events.push(event)
  }
  of(kind: string): SimulationEvent[] {
    return this.events.filter((event) => event.kind === kind)
  }
}

function runEconomyHours(
  world: InmateWorld,
  events: RecordingSink,
  hours: number,
  simulation?: Simulation,
): Simulation {
  const sim =
    simulation ??
    new Simulation({
      seed: SEED,
      world,
      systems: [createEconomySystem({ data: DATA })],
      events,
    })
  for (let i = 0; i < hours * ECONOMY_SYSTEM_PERIOD; i += 1) {
    sim.step()
  }
  return sim
}

function addInmate(world: InmateWorld, category = 'medium', seed = SEED): number {
  const id = world.inmates.allocateId()
  if (id === NO_INMATE) throw new Error('inmate id exhausted')
  const component = generateInmate({
    data: DATA,
    rng: new Rng((seed + id) >>> 0).stream('intake'),
    category,
  })
  world.inmates.add(
    createInmateShell({
      id,
      data: DATA,
      inmate: component,
      tx: 1,
      ty: 1,
    }),
  )
  return id
}

describe('wage accrual timing (T3.6)', () => {
  it('posts per-staff wage debits on each in-game hour boundary', () => {
    const events = new RecordingSink()
    const world = createInmateWorld({ size: 24, data: DATA, continuousIntake: false })

    const officer = hireStaff({ world, defId: 'officer', events, tick: 0, tx: 2, ty: 2 })
    const cook = hireStaff({ world, defId: 'cook', events, tick: 0, tx: 3, ty: 2 })
    expect(officer.entity).toBeDefined()
    expect(cook.entity).toBeDefined()

    const hireTotal = DATA.staff.get('officer').hireCost + DATA.staff.get('cook').hireCost
    expect(world.economy.balance).toBe(STARTING - hireTotal)

    const sim = runEconomyHours(world, events, 1)

    const expectedWage =
      Math.floor(DATA.staff.get('officer').hourlyWage) +
      Math.floor(DATA.staff.get('cook').hourlyWage)
    expect(events.of(ECONOMY_EVENTS.wagesPaid)).toHaveLength(1)
    expect(events.of(ECONOMY_EVENTS.wagesPaid)[0]?.data).toMatchObject({
      total: expectedWage,
      count: 2,
    })

    const wageEntries = world.economy.entries.filter((e) => e.category === 'wages')
    expect(wageEntries).toHaveLength(2)
    expect(wageEntries.every((e) => e.tick === TICKS_PER_HOUR)).toBe(true)
    expect(wageEntries.every((e) => e.sourceEntityId > 0)).toBe(true)
    expect(world.economy.balance).toBe(STARTING - hireTotal - expectedWage)

    runEconomyHours(world, events, 1, sim)
    expect(events.of(ECONOMY_EVENTS.wagesPaid)).toHaveLength(2)
    expect(world.economy.entries.filter((e) => e.category === 'wages')).toHaveLength(4)
  })
})

describe('tax application (T3.6)', () => {
  it('taxes positive income since the previous midnight at the configured rate', () => {
    const events = new RecordingSink()
    const world = createInmateWorld({ size: 24, data: DATA, continuousIntake: false })
    addInmate(world, 'medium', 1)
    addInmate(world, 'medium', 2)

    const dayStart = 0
    const midnight = TICKS_PER_DAY
    const payments = payInmateDaily(world, events, midnight)
    const expectedPayment = 2 * DATA.securityCategories.get('medium').dailyPayment
    expect(payments).toBe(expectedPayment)

    const tax = applyTax(world, events, midnight, dayStart)
    const expectedTax = Math.floor(expectedPayment * DATA.balance.economy.taxRate)
    expect(tax).toBe(expectedTax)
    expect(events.of(ECONOMY_EVENTS.taxApplied)[0]?.data).toMatchObject({
      tax: expectedTax,
      taxable: expectedPayment,
      rate: DATA.balance.economy.taxRate,
    })

    const taxEntry = world.economy.entries.find((e) => e.category === 'tax')
    expect(taxEntry).toMatchObject({
      amount: -expectedTax,
      sourceEntityId: FACILITY_SOURCE_ID,
      tick: midnight,
    })
  })

  it('applies tax at midnight through the economy system', () => {
    const events = new RecordingSink()
    const world = createInmateWorld({ size: 24, data: DATA, continuousIntake: false })
    addInmate(world, 'medium')

    runEconomyHours(world, events, 24)

    expect(events.of(ECONOMY_EVENTS.inmatePayments)).toHaveLength(1)
    expect(events.of(ECONOMY_EVENTS.taxApplied)).toHaveLength(1)
    const payment = DATA.securityCategories.get('medium').dailyPayment
    const tax = Math.floor(payment * DATA.balance.economy.taxRate)
    expect(events.of(ECONOMY_EVENTS.taxApplied)[0]?.data).toMatchObject({ tax })
  })
})

describe('insolvency countdown and cancellation (T3.6)', () => {
  it('starts a countdown when balance and 24h cash flow are both negative', () => {
    const events = new RecordingSink()
    const world = createInmateWorld({ size: 24, data: DATA, continuousIntake: false })

    world.economy.debit(0, 'other', STARTING + 5_000, 'Test overspend', FACILITY_SOURCE_ID)
    for (let i = 0; i < 40; i += 1) {
      hireStaff({ world, defId: 'officer', events, tick: 0, tx: 2, ty: 2 })
    }
    expect(world.economy.balance).toBeLessThan(0)

    runEconomyHours(world, events, 1)

    expect(events.of(ECONOMY_EVENTS.insolvencyStarted)).toHaveLength(1)
    expect(world.economy.insolvencyDeadlineTick).toBe(
      TICKS_PER_HOUR + DATA.balance.economy.insolvencyCountdownHours * TICKS_PER_HOUR,
    )
  })

  it('cancels the countdown when cash flow recovers', () => {
    const events = new RecordingSink()
    const world = createInmateWorld({ size: 24, data: DATA, continuousIntake: false })

    world.economy.debit(0, 'other', STARTING + 1_000, 'Test overspend', FACILITY_SOURCE_ID)
    hireStaff({ world, defId: 'officer', events, tick: 0, tx: 2, ty: 2 })

    const sim = runEconomyHours(world, events, 1)
    expect(events.of(ECONOMY_EVENTS.insolvencyStarted).length).toBeGreaterThanOrEqual(1)
    expect(world.economy.insolvencyDeadlineTick).not.toBeNull()

    world.economy.credit(sim.tick, 'contract', 100_000, 'Test bailout', FACILITY_SOURCE_ID)

    runEconomyHours(world, events, 1, sim)
    expect(events.of(ECONOMY_EVENTS.insolvencyCancelled)).toHaveLength(1)
    expect(world.economy.insolvencyDeadlineTick).toBeNull()
  })
})

describe('ledger balance invariant (T3.6)', () => {
  it('keeps balance equal to the sum of all entries after every posting', () => {
    const events = new RecordingSink()
    const world = createInmateWorld({ size: 24, data: DATA, continuousIntake: false })

    expect(world.economy.sumEntries()).toBe(world.economy.balance)
    expect(world.economy.balance).toBe(STARTING)

    hireStaff({ world, defId: 'officer', events, tick: 0, tx: 2, ty: 2 })
    expect(world.economy.sumEntries()).toBe(world.economy.balance)

    addInmate(world, 'medium')
    world.addSpend(250)
    world.addRefund(40)
    world.addIncome(90)

    runEconomyHours(world, events, 3)

    expect(world.economy.sumEntries()).toBe(world.economy.balance)
    for (const entry of world.economy.entries) {
      expect(entry.reason.length).toBeGreaterThan(0)
      expect(entry.sourceEntityId).toBeGreaterThanOrEqual(0)
    }
  })
})

describe('30-day cash flow (T3.6 acceptance)', () => {
  it('produces a plausible non-degenerate cash flow for 100 medium inmates and 20 officers', () => {
    const events = new RecordingSink()
    const world = createInmateWorld({ size: 48, data: DATA, continuousIntake: false })

    for (let i = 0; i < 20; i += 1) {
      const hired = hireStaff({
        world,
        defId: 'officer',
        events,
        tick: 0,
        tx: 2 + (i % 10),
        ty: 2 + Math.floor(i / 10),
      })
      expect(hired.entity).toBeDefined()
    }

    for (let i = 0; i < 100; i += 1) addInmate(world, 'medium', SEED + i)
    expect(world.inmates.size).toBe(100)
    expect(world.staff.size).toBe(20)

    runEconomyHours(world, events, 24 * 30)

    const endTick = 24 * 30 * TICKS_PER_HOUR
    const report = world.economy.buildFinanceReport(endTick)
    expect(report.last7Days.length).toBeGreaterThanOrEqual(1)
    expect(report.last7Days.length).toBeLessThanOrEqual(7)
    expect(report.breakdownByCategory.some((row) => row.category === 'wages')).toBe(true)
    expect(report.breakdownByCategory.some((row) => row.category === 'inmate_payment')).toBe(true)
    expect(report.breakdownByCategory.some((row) => row.category === 'tax')).toBe(true)

    const dailyPayment = 100 * DATA.securityCategories.get('medium').dailyPayment
    const dailyWages = 20 * Math.floor(DATA.staff.get('officer').hourlyWage) * 24
    const dailyTax = Math.floor(dailyPayment * DATA.balance.economy.taxRate)
    const expectedDailyNet = dailyPayment - dailyWages - dailyTax

    expect(expectedDailyNet).toBeGreaterThan(0)
    // Last complete days in the chart should track the closed-form daily net.
    expect(Math.abs(report.projectedDailyNet - expectedDailyNet)).toBeLessThan(
      expectedDailyNet * 0.2 + 1,
    )

    const hireCost = 20 * DATA.staff.get('officer').hireCost
    const expectedEnd = STARTING - hireCost + expectedDailyNet * 30
    expect(Math.abs(world.economy.balance - expectedEnd)).toBeLessThan(expectedDailyNet * 2)

    expect(world.economy.sumEntries()).toBe(world.economy.balance)
    expect(world.economy.entries.every((e) => e.reason.length > 0)).toBe(true)
  })
})

describe('finance report (T3.6)', () => {
  it('builds a 7-day chart, category breakdown and projected daily net', () => {
    const events = new RecordingSink()
    const world = createInmateWorld({ size: 24, data: DATA, continuousIntake: false })
    addInmate(world, 'medium')
    hireStaff({ world, defId: 'officer', events, tick: 0, tx: 2, ty: 2 })

    runEconomyHours(world, events, 24 * 3)

    const tick = 24 * 3 * TICKS_PER_HOUR
    const report = world.economy.buildFinanceReport(tick)
    expect(report.balance).toBe(world.economy.balance)
    expect(report.last7Days.length).toBe(4)
    expect(typeof report.projectedDailyNet).toBe('number')
    expect(report.breakdownByCategory.length).toBeGreaterThan(0)
  })
})
