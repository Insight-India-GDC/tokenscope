/*
 * The default budget period on the project forms is the server's current UTC
 * month, as [first day, first day of next month).
 */
import { describe, it, expect } from 'vitest'
import { defaultBudgetPeriod, utcMidnight } from '../../../app/composables/useProjectFormOptions'

describe('defaultBudgetPeriod', () => {
  it('spans the month of the server today', () => {
    expect(defaultBudgetPeriod('2026-10-28')).toEqual({ from: '2026-10-01', to: '2026-11-01' })
  })

  it('rolls over the year and handles a leap February', () => {
    expect(defaultBudgetPeriod('2026-12-31')).toEqual({ from: '2026-12-01', to: '2027-01-01' })
    expect(defaultBudgetPeriod('2028-02-29')).toEqual({ from: '2028-02-01', to: '2028-03-01' })
  })

  it('utcMidnight turns a date input into the UTC instant the API takes', () => {
    expect(utcMidnight('2026-11-01')).toBe('2026-11-01T00:00:00Z')
  })
})
