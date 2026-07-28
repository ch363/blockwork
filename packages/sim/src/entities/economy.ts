/**
 * Prison ledger: categorised money movements (T3.6, PRD 5.14).
 *
 * Lives apart from `economySystem` so `InmateWorld` can own a ledger without a
 * circular import through the hourly settlement system.
 */

import { TICKS_PER_DAY, TICKS_PER_HOUR } from '../core/clock'
import type { Fnv1aHasher } from '../core/hash'
import type { EventSink } from '../core/simulation'
import type { GameData } from '../data/loader'

/* -------------------------------------------------------------------------- */
/* Categories & events                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Ledger categories for the finance report breakdown. Structural rather than
 * balance: adding one is a code change because the report and Trace copy key
 * off these ids.
 */
export const LEDGER_CATEGORIES = [
  'starting_funds',
  'intake_fee',
  'inmate_payment',
  'wages',
  'hire',
  'construction',
  'construction_refund',
  'utilities',
  'loan_interest',
  'loan_principal',
  'tax',
  'contract',
  'export',
  'commissary',
  'program',
  'research',
  'other',
] as const

export type LedgerCategory = (typeof LEDGER_CATEGORIES)[number]

export const ECONOMY_EVENTS = {
  entryPosted: 'economy.entryPosted',
  insolvencyStarted: 'economy.insolvencyStarted',
  insolvencyCancelled: 'economy.insolvencyCancelled',
  insolvencyFailed: 'economy.insolvencyFailed',
  wagesPaid: 'economy.wagesPaid',
  utilitiesBilled: 'economy.utilitiesBilled',
  loanInterestCharged: 'economy.loanInterestCharged',
  inmatePayments: 'economy.inmatePayments',
  taxApplied: 'economy.taxApplied',
} as const

export const ECONOMY_SYSTEM_NAME = 'economy'

/** PRD 4.4: Economy runs once an in-game hour. */
export const ECONOMY_SYSTEM_PERIOD = TICKS_PER_HOUR

/** Facility-level source when no entity owns the transaction. */
export const FACILITY_SOURCE_ID = 0

/** How many complete days the finance chart covers. */
export const FINANCE_CHART_DAYS = 7

/* -------------------------------------------------------------------------- */
/* Types                                                                       */
/* -------------------------------------------------------------------------- */

export interface LedgerEntry {
  readonly tick: number
  readonly category: LedgerCategory
  /** Signed whole currency: positive credit, negative debit. */
  readonly amount: number
  readonly reason: string
  /** Entity that caused the movement, or {@link FACILITY_SOURCE_ID}. */
  readonly sourceEntityId: number
}

export interface LedgerPostInput {
  readonly tick: number
  readonly category: LedgerCategory
  readonly amount: number
  readonly reason: string
  readonly sourceEntityId: number
}

export interface DayCashflow {
  /** 1-based day number matching the clock. */
  readonly day: number
  readonly income: number
  readonly expense: number
  readonly net: number
}

export interface CategoryBreakdown {
  readonly category: LedgerCategory
  readonly amount: number
}

export interface FinanceReport {
  readonly balance: number
  readonly loanPrincipal: number
  /** Net over the trailing 24 in-game hours. */
  readonly cashFlow24h: number
  /** Mean daily net across complete days in the chart window. */
  readonly projectedDailyNet: number
  readonly last7Days: readonly DayCashflow[]
  readonly breakdownByCategory: readonly CategoryBreakdown[]
  readonly insolvencyDeadlineTick: number | null
}

/** Serialisable economy snapshot (save format / tests). */
export interface EconomySnapshot {
  readonly balance: number
  readonly loanPrincipal: number
  readonly insolvencyDeadlineTick: number | null
  readonly entries: readonly LedgerEntry[]
}

export interface EconomyLedgerOptions {
  readonly startingFunds: number
  readonly insolvencyCountdownHours: number
}

/* -------------------------------------------------------------------------- */
/* Ledger                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Authoritative money state. `balance` is always equal to the sum of entry
 * amounts (including the opening `starting_funds` credit).
 */
export class EconomyLedger {
  #balance: number
  #loanPrincipal = 0
  /** Tick at which insolvency fails the prison; null when not counting down. */
  #insolvencyDeadlineTick: number | null = null
  /** Tick when the current insolvency countdown began; null when idle. */
  #insolvencyStartedTick: number | null = null
  readonly #entries: LedgerEntry[] = []
  readonly #insolvencyCountdownTicks: number

  constructor(options: EconomyLedgerOptions) {
    this.#insolvencyCountdownTicks = options.insolvencyCountdownHours * TICKS_PER_HOUR
    this.#balance = 0
    if (options.startingFunds !== 0) {
      this.post({
        tick: 0,
        category: 'starting_funds',
        amount: options.startingFunds,
        reason: 'Starting funds',
        sourceEntityId: FACILITY_SOURCE_ID,
      })
    }
  }

  get balance(): number {
    return this.#balance
  }

  get loanPrincipal(): number {
    return this.#loanPrincipal
  }

  setLoanPrincipal(amount: number): void {
    if (!Number.isInteger(amount) || amount < 0) {
      throw new RangeError(`loanPrincipal must be a non-negative integer, received ${amount}`)
    }
    this.#loanPrincipal = amount
  }

  get insolvencyDeadlineTick(): number | null {
    return this.#insolvencyDeadlineTick
  }

  get insolvencyStartedTick(): number | null {
    return this.#insolvencyStartedTick
  }

  get entries(): readonly LedgerEntry[] {
    return this.#entries
  }

  /** Sum of every entry amount — must equal {@link balance}. */
  sumEntries(): number {
    let total = 0
    for (const entry of this.#entries) total += entry.amount
    return total
  }

  /**
   * Records one movement and updates the balance. Amount must be a non-zero
   * integer; credits are positive, debits negative.
   */
  post(input: LedgerPostInput): LedgerEntry {
    if (!Number.isInteger(input.amount) || input.amount === 0) {
      throw new RangeError(`ledger amount must be a non-zero integer, received ${input.amount}`)
    }
    if (!Number.isInteger(input.tick) || input.tick < 0) {
      throw new RangeError(`ledger tick must be a non-negative integer, received ${input.tick}`)
    }
    if (!Number.isInteger(input.sourceEntityId) || input.sourceEntityId < 0) {
      throw new RangeError(
        `sourceEntityId must be a non-negative integer, received ${input.sourceEntityId}`,
      )
    }
    if (input.reason.length === 0) {
      throw new RangeError('ledger reason must be a non-empty string')
    }

    const entry: LedgerEntry = {
      tick: input.tick,
      category: input.category,
      amount: input.amount,
      reason: input.reason,
      sourceEntityId: input.sourceEntityId,
    }
    this.#entries.push(entry)
    this.#balance += entry.amount
    return entry
  }

  credit(
    tick: number,
    category: LedgerCategory,
    amount: number,
    reason: string,
    sourceEntityId: number,
  ): LedgerEntry {
    if (!Number.isInteger(amount) || amount <= 0) {
      throw new RangeError(`credit amount must be a positive integer, received ${amount}`)
    }
    return this.post({ tick, category, amount, reason, sourceEntityId })
  }

  debit(
    tick: number,
    category: LedgerCategory,
    amount: number,
    reason: string,
    sourceEntityId: number,
  ): LedgerEntry {
    if (!Number.isInteger(amount) || amount <= 0) {
      throw new RangeError(`debit amount must be a positive integer, received ${amount}`)
    }
    return this.post({ tick, category, amount: -amount, reason, sourceEntityId })
  }

  /**
   * Trailing cash flow over `[tick - windowTicks, tick]` (inclusive of entries
   * at `tick`). Window defaults to one in-game day.
   */
  cashFlowSince(tick: number, windowTicks: number = TICKS_PER_DAY): number {
    const start = tick - windowTicks
    let total = 0
    for (const entry of this.#entries) {
      if (entry.category === 'starting_funds') continue
      if (entry.tick > start && entry.tick <= tick) total += entry.amount
    }
    return total
  }

  /**
   * Updates insolvency state after money has moved this hour.
   * Returns the event kind emitted, if any.
   */
  updateInsolvency(
    tick: number,
    events: EventSink,
  ): 'started' | 'cancelled' | 'failed' | null {
    const cashFlow = this.cashFlowSince(tick)
    const distressed = this.#balance < 0 && cashFlow < 0

    if (distressed) {
      if (this.#insolvencyDeadlineTick === null) {
        this.#insolvencyStartedTick = tick
        this.#insolvencyDeadlineTick = tick + this.#insolvencyCountdownTicks
        events.emit({
          tick,
          kind: ECONOMY_EVENTS.insolvencyStarted,
          causeIds: [],
          data: {
            balance: this.#balance,
            cashFlow24h: cashFlow,
            deadlineTick: this.#insolvencyDeadlineTick,
          },
        })
        return 'started'
      }
      if (tick >= this.#insolvencyDeadlineTick) {
        events.emit({
          tick,
          kind: ECONOMY_EVENTS.insolvencyFailed,
          causeIds: [],
          data: {
            balance: this.#balance,
            cashFlow24h: cashFlow,
            startedTick: this.#insolvencyStartedTick,
          },
        })
        return 'failed'
      }
      return null
    }

    if (this.#insolvencyDeadlineTick !== null) {
      const startedTick = this.#insolvencyStartedTick
      this.#insolvencyDeadlineTick = null
      this.#insolvencyStartedTick = null
      events.emit({
        tick,
        kind: ECONOMY_EVENTS.insolvencyCancelled,
        causeIds: [],
        data: {
          balance: this.#balance,
          cashFlow24h: cashFlow,
          startedTick,
        },
      })
      return 'cancelled'
    }

    return null
  }

  buildFinanceReport(tick: number): FinanceReport {
    const currentDay = Math.floor(tick / TICKS_PER_DAY) + 1
    const firstChartDay = Math.max(1, currentDay - FINANCE_CHART_DAYS + 1)

    const dayBuckets = new Map<number, { income: number; expense: number }>()
    for (let day = firstChartDay; day <= currentDay; day += 1) {
      dayBuckets.set(day, { income: 0, expense: 0 })
    }

    const categoryTotals = new Map<LedgerCategory, number>()
    const chartStartTick = (firstChartDay - 1) * TICKS_PER_DAY

    for (const entry of this.#entries) {
      if (entry.category === 'starting_funds') continue
      if (entry.tick < chartStartTick || entry.tick > tick) continue

      const day = Math.floor(entry.tick / TICKS_PER_DAY) + 1
      const bucket = dayBuckets.get(day)
      if (bucket !== undefined) {
        if (entry.amount > 0) bucket.income += entry.amount
        else bucket.expense += -entry.amount
      }

      categoryTotals.set(
        entry.category,
        (categoryTotals.get(entry.category) ?? 0) + entry.amount,
      )
    }

    const last7Days: DayCashflow[] = []
    for (let day = firstChartDay; day <= currentDay; day += 1) {
      const bucket = dayBuckets.get(day) ?? { income: 0, expense: 0 }
      last7Days.push({
        day,
        income: bucket.income,
        expense: bucket.expense,
        net: bucket.income - bucket.expense,
      })
    }

    // Project from complete days only; the current partial day is excluded
    // when there is at least one finished day in the window.
    const complete = last7Days.filter((row) => row.day < currentDay)
    const sample = complete.length > 0 ? complete : last7Days
    const projectedDailyNet =
      sample.length === 0
        ? 0
        : Math.trunc(sample.reduce((sum, row) => sum + row.net, 0) / sample.length)

    const breakdownByCategory: CategoryBreakdown[] = [...categoryTotals.entries()]
      .map(([category, amount]) => ({ category, amount }))
      .sort((a, b) => (a.category < b.category ? -1 : a.category > b.category ? 1 : 0))

    return {
      balance: this.#balance,
      loanPrincipal: this.#loanPrincipal,
      cashFlow24h: this.cashFlowSince(tick),
      projectedDailyNet,
      last7Days,
      breakdownByCategory,
      insolvencyDeadlineTick: this.#insolvencyDeadlineTick,
    }
  }

  serialise(): EconomySnapshot {
    return {
      balance: this.#balance,
      loanPrincipal: this.#loanPrincipal,
      insolvencyDeadlineTick: this.#insolvencyDeadlineTick,
      entries: this.#entries.map((entry) => ({ ...entry })),
    }
  }

  hashInto(hasher: Fnv1aHasher): void {
    hasher.writeInt32(this.#balance)
    hasher.writeUint32(this.#loanPrincipal)
    hasher.writeUint32(this.#insolvencyDeadlineTick ?? 0xffffffff)
    hasher.writeUint32(this.#insolvencyStartedTick ?? 0xffffffff)
    hasher.writeUint32(this.#entries.length)
    for (const entry of this.#entries) {
      hasher.writeUint32(entry.tick)
      hasher.writeString(entry.category)
      hasher.writeInt32(entry.amount)
      hasher.writeString(entry.reason)
      hasher.writeUint32(entry.sourceEntityId)
    }
  }
}

/** Builds a ledger seeded with starting funds from balance data. */
export function createEconomyLedger(data: GameData): EconomyLedger {
  return new EconomyLedger({
    startingFunds: data.balance.economy.startingFunds,
    insolvencyCountdownHours: data.balance.economy.insolvencyCountdownHours,
  })
}

/* -------------------------------------------------------------------------- */
/* World view                                                                  */
/* -------------------------------------------------------------------------- */

/** Minimal surface hire / intake use to post money without importing the system. */
export interface EconomyWorldView {
  readonly economy: EconomyLedger
}

export function hasEconomy(world: object): world is EconomyWorldView {
  return 'economy' in world && (world as { economy?: unknown }).economy instanceof EconomyLedger
}

