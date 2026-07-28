/**
 * The simulation clock (PRD 4.1).
 *
 * The base unit is the tick, fixed at 10 ticks per in-game minute, so an
 * in-game day is exactly 14,400 ticks. Every other unit is integer division of
 * the tick count. There is no wall-clock time and no delta-time here: the tick
 * count is part of the determinism contract, and real-time speed multipliers
 * are the worker loop's problem, not the clock's.
 *
 * Tick 0 is day 1 at 00:00.
 */

/** PRD 4.1: the fixed simulation rate. */
export const TICKS_PER_MINUTE = 10
export const MINUTES_PER_HOUR = 60
export const HOURS_PER_DAY = 24
export const TICKS_PER_HOUR = TICKS_PER_MINUTE * MINUTES_PER_HOUR
export const TICKS_PER_DAY = TICKS_PER_HOUR * HOURS_PER_DAY

/** The clock's whole serialised state. See PRD 7.4. */
export interface ClockState {
  readonly tick: number
}

/**
 * The clock as systems see it. Only the simulation's own step loop may advance
 * time, so `advance` is absent from this view.
 */
export interface ReadonlyClock {
  readonly tick: number
  readonly minute: number
  readonly hour: number
  readonly day: number
  isHour(hour: number): boolean
  everyNTicks(n: number): boolean
  timeString(): string
  serialise(): ClockState
}

function assertTick(tick: number): void {
  if (!Number.isInteger(tick) || tick < 0) {
    throw new RangeError(`tick must be a non-negative integer, received ${tick}`)
  }
}

function pad2(value: number): string {
  return value.toString().padStart(2, '0')
}

/** Minute of the hour, 0 to 59. */
export function ticksToMinute(tick: number): number {
  assertTick(tick)
  return Math.floor(tick / TICKS_PER_MINUTE) % MINUTES_PER_HOUR
}

/** Hour of the day, 0 to 23. */
export function ticksToHour(tick: number): number {
  assertTick(tick)
  return Math.floor(tick / TICKS_PER_HOUR) % HOURS_PER_DAY
}

/** Day number, 1-based: tick 0 is day 1. */
export function ticksToDay(tick: number): number {
  assertTick(tick)
  return Math.floor(tick / TICKS_PER_DAY) + 1
}

/** 24 hour `HH:MM`, matching the clock in the UI mockups. */
export function ticksToTimeString(tick: number): string {
  return `${pad2(ticksToHour(tick))}:${pad2(ticksToMinute(tick))}`
}

export class Clock implements ReadonlyClock {
  #tick: number

  constructor(tick = 0) {
    assertTick(tick)
    this.#tick = tick
  }

  static restore(state: ClockState): Clock {
    return new Clock(state.tick)
  }

  get tick(): number {
    return this.#tick
  }

  get minute(): number {
    return ticksToMinute(this.#tick)
  }

  get hour(): number {
    return ticksToHour(this.#tick)
  }

  get day(): number {
    return ticksToDay(this.#tick)
  }

  /** Advances exactly one tick. Nothing else may move the clock. */
  advance(): void {
    this.#tick += 1
  }

  /**
   * True while the clock is anywhere inside the given hour, not only on its
   * boundary. Compose with `everyNTicks` for an exact time, for example
   * `clock.everyNTicks(TICKS_PER_HOUR) && clock.isHour(8)` is 08:00 sharp.
   */
  isHour(hour: number): boolean {
    if (!Number.isInteger(hour) || hour < 0 || hour >= HOURS_PER_DAY) {
      throw new RangeError(`hour must be an integer in 0..23, received ${hour}`)
    }
    return this.hour === hour
  }

  /**
   * True on ticks that are an exact multiple of `n`. This is how a system
   * declares its period (PRD 4.4), so the periods must divide evenly into
   * `TICKS_PER_DAY` if they are to line up with the day boundary.
   */
  everyNTicks(n: number): boolean {
    if (!Number.isInteger(n) || n < 1) {
      throw new RangeError(`n must be a positive integer, received ${n}`)
    }
    return this.#tick % n === 0
  }

  timeString(): string {
    return ticksToTimeString(this.#tick)
  }

  serialise(): ClockState {
    return { tick: this.#tick }
  }
}
