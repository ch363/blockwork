/**
 * `EconomySystem`: the prison ledger (T3.6, PRD 5.14).
 *
 * Money moves only through categorised ledger entries. Every debit and credit
 * carries a reason string and a source entity id (0 for facility-level
 * charges). Balance may go negative; insolvency begins a countdown when the
 * balance and the trailing 24-hour cash flow are both negative, and cancels
 * when either recovers.
 *
 * Cadence (PRD 4.4): once per in-game hour.
 *   - Hourly: wages, utility bills, loan interest, drain construction outboxes.
 *   - Daily at midnight (hour 0, tick > 0): per-inmate payments, then tax.
 */

import { TICKS_PER_DAY } from '../core/clock'
import type { EventSink, System, SystemContext } from '../core/simulation'
import type { GameData } from '../data/loader'
import {
  ECONOMY_EVENTS,
  ECONOMY_SYSTEM_NAME,
  ECONOMY_SYSTEM_PERIOD,
  FACILITY_SOURCE_ID,
} from '../entities/economy'

import { isInmateWorld } from './intakeSystem'
import type { InmateWorld } from './intakeSystem'

export {
  ECONOMY_EVENTS,
  ECONOMY_SYSTEM_NAME,
  ECONOMY_SYSTEM_PERIOD,
  FACILITY_SOURCE_ID,
  FINANCE_CHART_DAYS,
  LEDGER_CATEGORIES,
  EconomyLedger,
  createEconomyLedger,
  hasEconomy,
} from '../entities/economy'
export type {
  CategoryBreakdown,
  DayCashflow,
  EconomyLedgerOptions,
  EconomySnapshot,
  EconomyWorldView,
  FinanceReport,
  LedgerCategory,
  LedgerEntry,
  LedgerPostInput,
} from '../entities/economy'

/* -------------------------------------------------------------------------- */
/* Hourly / daily settlements                                                  */
/* -------------------------------------------------------------------------- */

/** Pays permanent staff; one ledger entry per employee. */
export function payWages(world: InmateWorld, events: EventSink, tick: number): number {
  let total = 0
  const breakdown: { staffId: number; defId: string; wage: number }[] = []

  for (const entity of world.staff.all()) {
    const def = world.data.staff.find(entity.staff.defId)
    if (def === undefined) continue
    if (def.perSession || def.callable) continue
    if (def.hourlyWage <= 0) continue
    const wage = Math.floor(def.hourlyWage * world.morale.wageMultiplier)
    if (wage <= 0) continue
    world.economy.debit(
      tick,
      'wages',
      wage,
      `Hourly wage (${def.name})`,
      entity.id,
    )
    total += wage
    breakdown.push({ staffId: entity.id, defId: def.id, wage })
  }

  if (total > 0) {
    events.emit({
      tick,
      kind: ECONOMY_EVENTS.wagesPaid,
      causeIds: [],
      data: { total, count: breakdown.length, breakdown },
    })
  }
  return total
}

/**
 * Bills power (watts × rate) and water (fixtures × units × rate) for placed
 * objects. One combined utilities debit when either charge is non-zero.
 */
export function billUtilities(world: InmateWorld, events: EventSink, tick: number): number {
  const { utilityCostPerWattHour, utilityCostPerWaterUnit } = world.data.balance.economy
  const waterUnitsPerFixture = world.data.balance.utilities.waterUnitsPerFixture

  let watts = 0
  let waterFixtures = 0
  for (const entity of world.objects.all()) {
    const def = world.data.objects.find(entity.object.defId)
    if (def === undefined) continue
    if (def.needsPower > 0) watts += def.needsPower
    if (def.needsWater) waterFixtures += 1
  }

  const powerCost = Math.floor(watts * utilityCostPerWattHour)
  const waterCost = Math.floor(waterFixtures * waterUnitsPerFixture * utilityCostPerWaterUnit)
  const total = powerCost + waterCost
  if (total <= 0) return 0

  world.economy.debit(
    tick,
    'utilities',
    total,
    `Utilities (power ${powerCost}, water ${waterCost})`,
    FACILITY_SOURCE_ID,
  )
  events.emit({
    tick,
    kind: ECONOMY_EVENTS.utilitiesBilled,
    causeIds: [],
    data: { total, powerCost, waterCost, watts, waterFixtures },
  })
  return total
}

/** Charges interest on outstanding loan principal. */
export function chargeLoanInterest(world: InmateWorld, events: EventSink, tick: number): number {
  const principal = world.economy.loanPrincipal
  if (principal <= 0) return 0
  const rate = world.data.balance.economy.loan.hourlyInterestRate
  const interest = Math.floor(principal * rate)
  if (interest <= 0) return 0

  world.economy.debit(
    tick,
    'loan_interest',
    interest,
    'Loan interest',
    FACILITY_SOURCE_ID,
  )
  events.emit({
    tick,
    kind: ECONOMY_EVENTS.loanInterestCharged,
    causeIds: [],
    data: { interest, principal },
  })
  return interest
}

/** Credits each inmate's category daily payment at midnight. */
export function payInmateDaily(world: InmateWorld, events: EventSink, tick: number): number {
  let total = 0
  let count = 0
  for (const entity of world.inmates.all()) {
    const category = world.data.securityCategories.get(entity.inmate.category)
    const payment = category.dailyPayment
    if (payment <= 0) continue
    world.economy.credit(
      tick,
      'inmate_payment',
      payment,
      `Daily payment (${category.name})`,
      entity.id,
    )
    total += payment
    count += 1
  }
  if (total > 0) {
    events.emit({
      tick,
      kind: ECONOMY_EVENTS.inmatePayments,
      causeIds: [],
      data: { total, count },
    })
  }
  return total
}

/**
 * Taxes positive income posted since the previous midnight (exclusive of the
 * opening funds and of this tax debit itself).
 */
export function applyTax(
  world: InmateWorld,
  events: EventSink,
  tick: number,
  dayStartTick: number,
): number {
  const rate = world.data.balance.economy.taxRate
  if (rate <= 0) return 0

  let taxable = 0
  for (const entry of world.economy.entries) {
    if (entry.tick <= dayStartTick || entry.tick > tick) continue
    if (entry.amount <= 0) continue
    if (entry.category === 'starting_funds' || entry.category === 'loan_principal') continue
    taxable += entry.amount
  }

  const tax = Math.floor(taxable * rate)
  if (tax <= 0) return 0

  world.economy.debit(tick, 'tax', tax, `Tax at ${(rate * 100).toFixed(0)}%`, FACILITY_SOURCE_ID)
  events.emit({
    tick,
    kind: ECONOMY_EVENTS.taxApplied,
    causeIds: [],
    data: { tax, taxable, rate },
  })
  return tax
}

/**
 * Moves construction spend / demolition refunds / intake-fee outbox tallies
 * into the ledger so the outboxes stay an optional staging area.
 */
export function drainOutboxes(world: InmateWorld, tick: number): void {
  const spend = world.takeSpend()
  if (spend > 0) {
    world.economy.debit(
      tick,
      'construction',
      spend,
      'Construction spend',
      FACILITY_SOURCE_ID,
    )
  }

  const refunds = world.takeRefunds()
  if (refunds > 0) {
    world.economy.credit(
      tick,
      'construction_refund',
      refunds,
      'Demolition refund',
      FACILITY_SOURCE_ID,
    )
  }

  const income = world.takeIncome()
  if (income > 0) {
    world.economy.credit(
      tick,
      'intake_fee',
      income,
      'Intake fees',
      FACILITY_SOURCE_ID,
    )
  }
}

/* -------------------------------------------------------------------------- */
/* System                                                                      */
/* -------------------------------------------------------------------------- */

export interface EconomySystemOptions {
  readonly data: GameData
}

export function createEconomySystem(_options: EconomySystemOptions): System {
  let reportedWrongWorld = false

  return {
    name: ECONOMY_SYSTEM_NAME,
    period: ECONOMY_SYSTEM_PERIOD,

    update(context: SystemContext): void {
      const tick = context.clock.tick
      if (!isInmateWorld(context.world)) {
        if (reportedWrongWorld) return
        reportedWrongWorld = true
        context.events.emit({
          tick,
          kind: 'economy.rejected',
          causeIds: [],
          data: { command: ECONOMY_SYSTEM_NAME, reason: 'wrong-world' },
        })
        return
      }

      const world = context.world
      // Tick 0 never runs (clock advances before systems). First hour is 600.
      drainOutboxes(world, tick)
      payWages(world, context.events, tick)
      billUtilities(world, context.events, tick)
      chargeLoanInterest(world, context.events, tick)

      const atMidnight = tick % TICKS_PER_DAY === 0
      if (atMidnight) {
        const dayStartTick = tick - TICKS_PER_DAY
        payInmateDaily(world, context.events, tick)
        applyTax(world, context.events, tick, dayStartTick)
      }

      world.economy.updateInsolvency(tick, context.events)

    },
  }
}
