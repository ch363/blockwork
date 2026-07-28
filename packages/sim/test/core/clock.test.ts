import { describe, expect, it } from 'vitest'

import {
  Clock,
  TICKS_PER_DAY,
  TICKS_PER_HOUR,
  TICKS_PER_MINUTE,
  ticksToTimeString,
} from '../../src/core/clock'

describe('Clock (PRD 4.1)', () => {
  it('runs at 10 ticks per in-game minute', () => {
    expect(TICKS_PER_MINUTE).toBe(10)
    expect(TICKS_PER_HOUR).toBe(600)
    expect(TICKS_PER_DAY).toBe(14_400)
  })

  it('starts at day 1, 00:00', () => {
    const clock = new Clock()

    expect(clock.tick).toBe(0)
    expect(clock.minute).toBe(0)
    expect(clock.hour).toBe(0)
    expect(clock.day).toBe(1)
    expect(clock.timeString()).toBe('00:00')
  })

  it('reaches day 2, 00:00 at tick 14,400', () => {
    const clock = new Clock(TICKS_PER_DAY)

    expect(clock.minute).toBe(0)
    expect(clock.hour).toBe(0)
    expect(clock.day).toBe(2)
    expect(clock.timeString()).toBe('00:00')
  })

  it('derives minute, hour and day from the tick count', () => {
    const cases: ReadonlyArray<[tick: number, day: number, time: string]> = [
      [1, 1, '00:00'],
      [9, 1, '00:00'],
      [TICKS_PER_MINUTE, 1, '00:01'],
      [TICKS_PER_HOUR - 1, 1, '00:59'],
      [TICKS_PER_HOUR, 1, '01:00'],
      [8 * TICKS_PER_HOUR + 20 * TICKS_PER_MINUTE, 1, '08:20'],
      [TICKS_PER_DAY - 1, 1, '23:59'],
      [TICKS_PER_DAY + 14 * TICKS_PER_HOUR + 20 * TICKS_PER_MINUTE, 2, '14:20'],
      [26 * TICKS_PER_DAY + 3 * TICKS_PER_HOUR + 12 * TICKS_PER_MINUTE, 27, '03:12'],
    ]

    for (const [tick, day, time] of cases) {
      const clock = new Clock(tick)
      expect(clock.day, `day at tick ${tick}`).toBe(day)
      expect(clock.timeString(), `time at tick ${tick}`).toBe(time)
      expect(ticksToTimeString(tick)).toBe(time)
    }
  })

  it('advances exactly one tick at a time', () => {
    const clock = new Clock(TICKS_PER_MINUTE - 1)

    expect(clock.minute).toBe(0)
    clock.advance()
    expect(clock.tick).toBe(TICKS_PER_MINUTE)
    expect(clock.minute).toBe(1)
  })

  it('reports the current hour with isHour, for the whole hour', () => {
    const eightAM = new Clock(8 * TICKS_PER_HOUR)
    expect(eightAM.isHour(8)).toBe(true)
    expect(eightAM.isHour(9)).toBe(false)

    const eightThirty = new Clock(8 * TICKS_PER_HOUR + 30 * TICKS_PER_MINUTE)
    expect(eightThirty.isHour(8)).toBe(true)
  })

  it('composes isHour with everyNTicks to name an exact time', () => {
    const onTheHour = new Clock(8 * TICKS_PER_HOUR)
    expect(onTheHour.everyNTicks(TICKS_PER_HOUR) && onTheHour.isHour(8)).toBe(true)

    const oneTickLate = new Clock(8 * TICKS_PER_HOUR + 1)
    expect(oneTickLate.everyNTicks(TICKS_PER_HOUR) && oneTickLate.isHour(8)).toBe(false)
  })

  it('fires everyNTicks on exact multiples only', () => {
    expect(new Clock(0).everyNTicks(10)).toBe(true)
    expect(new Clock(10).everyNTicks(10)).toBe(true)
    expect(new Clock(11).everyNTicks(10)).toBe(false)
    expect(new Clock(600).everyNTicks(600)).toBe(true)
    expect(new Clock(599).everyNTicks(600)).toBe(false)
  })

  it('round-trips through serialise and restore', () => {
    const clock = new Clock(1234)
    const restored = Clock.restore(clock.serialise())

    expect(restored.tick).toBe(1234)
    expect(restored.timeString()).toBe(clock.timeString())
  })

  it('rejects nonsense ticks, hours and periods', () => {
    expect(() => new Clock(-1)).toThrow(RangeError)
    expect(() => new Clock(1.5)).toThrow(RangeError)
    expect(() => new Clock(0).isHour(24)).toThrow(RangeError)
    expect(() => new Clock(0).isHour(-1)).toThrow(RangeError)
    expect(() => new Clock(0).everyNTicks(0)).toThrow(RangeError)
    expect(() => new Clock(0).everyNTicks(2.5)).toThrow(RangeError)
  })
})
