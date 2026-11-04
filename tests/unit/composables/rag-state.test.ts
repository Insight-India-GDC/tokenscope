/*
 * useRagState.ragOf — RAG threshold pure function unit test.
 *
 * Pins the green / amber / red thresholds shared across UiPbar and
 * UiKpi. Edge cases on the boundaries matter — design-notes
 * §Screen 2 says amber at "≥ 75%" and red at "≥ 90%".
 */
import { describe, it, expect } from 'vitest'
import { ragOf, ragLabel } from '../../../app/composables/useRagState'

describe('ragOf', () => {
  it('returns green below the amber threshold', () => {
    expect(ragOf(0)).toBe('green')
    expect(ragOf(0.5)).toBe('green')
    expect(ragOf(0.7499)).toBe('green')
  })

  it('returns amber at and above 0.75 up to the red threshold', () => {
    expect(ragOf(0.75)).toBe('amber')
    expect(ragOf(0.8)).toBe('amber')
    expect(ragOf(0.8999)).toBe('amber')
  })

  it('returns red at and above 0.90', () => {
    expect(ragOf(0.9)).toBe('red')
    expect(ragOf(1.0)).toBe('red')
    expect(ragOf(1.5)).toBe('red')
  })

  it('clamps negative percentages to green (defensive)', () => {
    expect(ragOf(-0.1)).toBe('green')
  })
})

describe('ragLabel', () => {
  it('labels "Over" ONLY when budget is actually exceeded (pct > 1)', () => {
    expect(ragLabel(1.01)).toBe('Over')
    expect(ragLabel(2)).toBe('Over')
    // The reported bug: 90–100% is red but NOT over — must NOT say "Over".
    expect(ragLabel(0.9096)).toBe('Critical')
    expect(ragLabel(0.9)).toBe('Critical')
    expect(ragLabel(1.0)).toBe('Critical') // exactly at budget is not yet over
  })

  it('labels Watch / Healthy below the red band', () => {
    expect(ragLabel(0.75)).toBe('Watch')
    expect(ragLabel(0.8999)).toBe('Watch')
    expect(ragLabel(0.74)).toBe('Healthy')
    expect(ragLabel(0)).toBe('Healthy')
  })
})
