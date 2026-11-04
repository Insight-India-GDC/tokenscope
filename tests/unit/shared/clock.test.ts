/*
 * T2 — the three quantities stay distinct at the edge.
 *
 * `now`, `today` and `settledThrough` are three different facts, and the
 * codebase conflated the last two: SQL's `GREATEST(CURRENT_DATE, MAX(day))`
 * pulled every chart's right edge onto the WALL CLOCK, where the axis needs a
 * COVERAGE fact. The gap between them is the morning dip. These assertions exist
 * so a later "simplification" that collapses `settledThrough` back onto `today`
 * — which looks harmless, and reads as a one-day off-by-one — goes red.
 *
 * Also pins the pure derivations, because `dayOfMonth` is the DIVISOR behind
 * every project card's "on pace for ~$X": it is the one clock-shaped value in
 * this codebase that reaches money.
 */
import { describe, it, expect } from 'vitest'
import {
  resolveServerClock,
  shiftUtcDay,
  utcDay,
  utcDayOfMonth,
  utcDaysInMonth,
  utcMonthEnd,
  utcMonthOf,
  utcWeekStart,
} from '../../../shared/reports/clock'

describe('resolveServerClock — three quantities, kept apart', () => {
  it('now is an instant, today is its UTC day, settledThrough is the day before', () => {
    const c = resolveServerClock(new Date('2026-08-05T09:14:22.123Z'))
    expect(c.now).toBe('2026-08-05T09:14:22.123Z')
    expect(c.today).toBe('2026-08-05')
    expect(c.settledThrough).toBe('2026-08-04')
  })

  it('settledThrough is NEVER today — the still-filling day is not the edge', () => {
    // Sampled across a month, a month end, a year end and a leap day: at no
    // instant may the settled edge equal the day still accruing.
    for (const iso of [
      '2026-08-05T00:00:00.000Z', // the very first millisecond of a UTC day
      '2026-08-05T23:59:59.999Z', // the very last
      '2026-09-01T09:00:00.000Z', // the case that breaks naive month arithmetic
      '2027-01-01T00:00:00.000Z',
      '2028-03-01T12:00:00.000Z', // leap year
    ]) {
      const c = resolveServerClock(new Date(iso))
      expect(c.settledThrough).not.toBe(c.today)
      expect(c.settledThrough < c.today).toBe(true)
      expect(shiftUtcDay(c.settledThrough, 1)).toBe(c.today)
    }
  })

  it('the edge steps back across a month boundary, not to "day 0"', () => {
    expect(resolveServerClock(new Date('2026-09-01T00:30:00Z')).settledThrough).toBe('2026-08-31')
    expect(resolveServerClock(new Date('2027-01-01T00:30:00Z')).settledThrough).toBe('2026-12-31')
    expect(resolveServerClock(new Date('2028-03-01T00:30:00Z')).settledThrough).toBe('2028-02-29')
  })

  it('is a pure function of its argument — the same instant always resolves the same', () => {
    const at = new Date('2026-08-05T09:14:22.123Z')
    expect(resolveServerClock(at)).toEqual(resolveServerClock(at))
  })

  it('renders `now` as an INSTANT and `today` as a DAY BUCKET (D2)', () => {
    // 09:14Z is the same instant everywhere; the DAY it belongs to is a
    // provider fact and must not be re-derived in a viewer's zone. The contract
    // therefore ships both, rather than shipping one and letting the client
    // convert.
    const c = resolveServerClock(new Date('2026-08-05T09:14:22.123Z'))
    expect(Date.parse(c.now)).toBe(Date.parse('2026-08-05T09:14:22.123Z'))
    expect(c.today).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(c.settledThrough).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })
})

describe('pure derivations from a server-resolved day', () => {
  it('utcDayOfMonth is the pace DIVISOR and reads the day it is given', () => {
    expect(utcDayOfMonth('2026-08-01')).toBe(1)
    expect(utcDayOfMonth('2026-08-31')).toBe(31)
    // The failure this replaces: on 1 Sept at 09:00 Sydney the browser said
    // day 1 while the server's August still had hours to run.
    expect(utcDayOfMonth('2026-08-31')).not.toBe(utcDayOfMonth('2026-09-01'))
  })

  it('utcDaysInMonth handles the short months and leap Februaries', () => {
    expect(utcDaysInMonth('2026-02-10')).toBe(28)
    expect(utcDaysInMonth('2028-02-10')).toBe(29)
    expect(utcDaysInMonth('2026-04-10')).toBe(30)
    expect(utcDaysInMonth('2026-12-31')).toBe(31)
    expect(utcDaysInMonth('2100-02-01')).toBe(28) // century non-leap
  })

  it('utcMonthOf / utcMonthEnd', () => {
    expect(utcMonthOf('2026-08-05')).toBe('2026-08')
    expect(utcMonthEnd('2026-02-05')).toBe('2026-02-28')
    expect(utcMonthEnd('2028-02-05')).toBe('2028-02-29')
    expect(utcMonthEnd('2026-08-05')).toBe('2026-08-31')
  })

  it('shiftUtcDay is DST-immune — UTC has no offsets to trip over', () => {
    // 29 March 2026 is when most of Europe springs forward; a local-time shift
    // would land on the same day or skip one.
    expect(shiftUtcDay('2026-03-28', 1)).toBe('2026-03-29')
    expect(shiftUtcDay('2026-03-29', 1)).toBe('2026-03-30')
    expect(shiftUtcDay('2026-01-01', -1)).toBe('2025-12-31')
    expect(shiftUtcDay('2026-08-05', -59)).toBe('2026-06-07')
  })

  it('refuses a value that is not a UTC day rather than silently drifting', () => {
    expect(() => shiftUtcDay('not-a-day', 1)).toThrow(/YYYY-MM-DD/)
  })

  it('utcDay reads an instant as its UTC day', () => {
    expect(utcDay(Date.parse('2026-08-05T23:59:59Z'))).toBe('2026-08-05')
    expect(utcDay(Date.parse('2026-08-06T00:00:00Z'))).toBe('2026-08-06')
  })
})

describe('utcWeekStart — the ISO week bucket, from a server day', () => {
  it('is the Monday of the week, as Postgres date_trunc(\'week\') gives it', () => {
    expect(utcWeekStart('2026-03-02')).toBe('2026-03-02') // Monday
    expect(utcWeekStart('2026-03-04')).toBe('2026-03-02') // Wednesday
    expect(utcWeekStart('2026-03-08')).toBe('2026-03-02') // Sunday ends the ISO week
    expect(utcWeekStart('2026-03-09')).toBe('2026-03-09')
  })

  it('crosses month and year boundaries', () => {
    expect(utcWeekStart('2026-03-01')).toBe('2026-02-23')
    expect(utcWeekStart('2027-01-01')).toBe('2026-12-28')
  })
})
