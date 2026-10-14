/*
 * H30 — the per-source registration map (server/auth/oauth.ts) must stay
 * bounded. It used to be pruned only when the SAME source was read again, so a
 * flood of distinct one-shot sources grew it for the life of the process.
 *
 * Module state is per-import, so each test takes a fresh copy of the module.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

type OauthModule = typeof import('../../../server/auth/oauth')
let m: OauthModule
const HOUR = 60 * 60 * 1000

beforeEach(async () => {
  vi.resetModules()
  m = await import('../../../server/auth/oauth')
})

describe('per-source registration map bounds', () => {
  it('never tracks more than MAX_TRACKED_SOURCES sources, even when every one is live', () => {
    const t0 = 1_800_000_000_000
    for (let i = 0; i < m.MAX_TRACKED_SOURCES + 500; i++) {
      m.recordSourceRegistration(`10.0.${i >> 8}.${i & 255}#${i}`, t0 + i)
    }
    expect(m.trackedSourceCountForTest()).toBe(m.MAX_TRACKED_SOURCES)
  })

  it('sweeps expired sources on insert, without the expired keys ever being read again', () => {
    const t0 = 1_800_000_000_000
    for (let i = 0; i < 100; i++) m.recordSourceRegistration(`old-${i}`, t0 + i)
    expect(m.trackedSourceCountForTest()).toBe(100)

    // Past the window: each insert sweeps up to SOURCE_SWEEP_BATCH expired keys.
    const later = t0 + HOUR + 1_000
    const inserts = Math.ceil(100 / m.SOURCE_SWEEP_BATCH)
    for (let i = 0; i < inserts; i++) m.recordSourceRegistration(`new-${i}`, later + i)
    expect(m.trackedSourceCountForTest()).toBe(inserts)
  })

  it('the sweep stops at the first live source (constant work per insert)', () => {
    const t0 = 1_800_000_000_000
    m.recordSourceRegistration('expired', t0)
    m.recordSourceRegistration('live', t0 + HOUR) // still live at t0 + HOUR + 1
    m.recordSourceRegistration('fresh', t0 + HOUR + 1)
    // 'expired' swept; 'live' and 'fresh' kept.
    expect(m.trackedSourceCountForTest()).toBe(2)
  })

  it('a repeatedly-registering source keeps at most SOURCE_REGISTRATION_LIMIT timestamps but stays one entry', () => {
    const t0 = 1_800_000_000_000
    for (let i = 0; i < m.SOURCE_REGISTRATION_LIMIT * 5; i++) m.recordSourceRegistration('busy', t0 + i)
    expect(m.trackedSourceCountForTest()).toBe(1)
  })
})
