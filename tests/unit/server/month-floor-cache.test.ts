// @vitest-environment node
/*
 * server/reporting/month-floor.ts — the cached, single-implementation month floor.
 *
 * Three copies of this query existed (regional, across-regions, cost-centres)
 * and every one scanned v_complete_usage with NO date predicate: ~580MB of
 * blocks, 241ms, on every request, to answer a question whose value changes at
 * most monthly. Because it is a MIN over all history it cannot be windowed, so
 * it got strictly slower every month the deployment ran.
 *
 * The risky part of caching it is not the caching — it is the KEY. A key that
 * fails to vary with the scope predicate serves one scope's floor to another,
 * and the floor is enforced server-side as a 400, so the symptom is a caller
 * being refused a month they DO have data in. These tests pin that.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { sql } from 'drizzle-orm'
import {
  reportMonthFloor,
  confirmBelowFloor,
  resetMonthFloorCache,
  monthFloorCacheSize,
  MONTH_FLOOR_TTL_MS,
} from '../../../server/reporting/month-floor'

/**
 * A tx stub that records every execute and returns a scripted floor.
 *
 * `execute` is the only member reportMonthFloor touches, so the stub stays
 * minimal and reaches the parameter type through `unknown` rather than `any` —
 * a cast, not a hole: `any` would silently accept a stub that no longer matches
 * the signature the helper actually calls.
 */
type FloorTx = Parameters<typeof reportMonthFloor>[0]
function stubTx(floors: (string | null)[]) {
  const calls: unknown[] = []
  let i = 0
  const tx = {
    execute: vi.fn(async (q: unknown) => {
      calls.push(q)
      const v = floors[Math.min(i, floors.length - 1)]
      i += 1
      return [{ floor_month: v }]
    }),
  }
  return { calls, tx: tx as unknown as FloorTx }
}

beforeEach(() => {
  resetMonthFloorCache()
})

describe('reportMonthFloor', () => {
  it('queries once and serves the cached value within the TTL', async () => {
    const { tx, calls } = stubTx(['2026-01'])
    const a = await reportMonthFloor(tx, { key: 'k', where: null }, { now: 1_000, ttlMs: MONTH_FLOOR_TTL_MS })
    const b = await reportMonthFloor(tx, { key: 'k', where: null }, { now: 1_000 + 60_000, ttlMs: MONTH_FLOOR_TTL_MS })
    expect(a).toBe('2026-01')
    expect(b).toBe('2026-01')
    expect(calls.length).toBe(1)
  })

  it('re-queries once the TTL has elapsed, so an archived month is picked up', async () => {
    const { tx, calls } = stubTx(['2026-01', '2026-02'])
    const a = await reportMonthFloor(tx, { key: 'k', where: null }, { now: 0, ttlMs: MONTH_FLOOR_TTL_MS })
    const b = await reportMonthFloor(tx, { key: 'k', where: null }, { now: MONTH_FLOOR_TTL_MS, ttlMs: MONTH_FLOOR_TTL_MS })
    expect(a).toBe('2026-01')
    expect(b).toBe('2026-02')
    expect(calls.length).toBe(2)
  })

  it('does NOT share a value between different scopes', async () => {
    /*
     * The failure this prevents: a cost-centre owner whose scope starts in
     * March being served the whole company's January floor (harmless), or the
     * reverse — being refused February with a 400 because another scope's later
     * floor was cached under a shared key.
     */
    const { tx, calls } = stubTx(['2026-01', '2026-06'])
    const global = await reportMonthFloor(tx, { key: 'across:global', where: null }, { now: 0, ttlMs: MONTH_FLOOR_TTL_MS })
    const scoped = await reportMonthFloor(
      tx,
      { key: 'cost-centres:abc', where: sql`u.cost_owning_unit_id = ANY(ARRAY['abc'])` },
      { now: 0, ttlMs: MONTH_FLOOR_TTL_MS },
    )
    expect(global).toBe('2026-01')
    expect(scoped).toBe('2026-06')
    expect(calls.length).toBe(2)
    expect(monthFloorCacheSize()).toBe(2)
  })

  it('caches a null floor, so an empty scope does not re-scan every request', async () => {
    const { tx, calls } = stubTx([null])
    expect(await reportMonthFloor(tx, { key: 'empty', where: null }, { now: 0, ttlMs: MONTH_FLOOR_TTL_MS })).toBeNull()
    expect(await reportMonthFloor(tx, { key: 'empty', where: null }, { now: 1, ttlMs: MONTH_FLOOR_TTL_MS })).toBeNull()
    expect(calls.length).toBe(1)
  })

  it('bounds the cache so a pathological caller cannot grow it without limit', async () => {
    const { tx } = stubTx(['2026-01'])
    for (let i = 0; i < 300; i += 1) {
      await reportMonthFloor(tx, { key: `scope-${i}`, where: null }, { now: 0, ttlMs: MONTH_FLOOR_TTL_MS })
    }
    expect(monthFloorCacheSize()).toBeLessThanOrEqual(256)
  })

  it('collapses concurrent cold misses into ONE scan', async () => {
    /*
     * Without in-flight dedupe, N simultaneous requests for the same scope each
     * run the full unbounded MIN — the exact cost the cache exists to remove,
     * at its worst precisely when the instance is busiest.
     */
    const { tx, calls } = stubTx(['2026-05'])
    const all = await Promise.all(
      Array.from({ length: 8 }, () =>
        reportMonthFloor(tx, { key: 'hot', where: null }, { now: 0, ttlMs: MONTH_FLOOR_TTL_MS }),
      ),
    )
    expect(all.every((v) => v === '2026-05')).toBe(true)
    expect(calls.length).toBe(1)
  })

  it('applies the scope predicate rather than silently reading whole-company', async () => {
    const { tx, calls } = stubTx(['2026-03'])
    await reportMonthFloor(tx, { key: 'k', where: sql`u.region_id = 'r1'` }, { now: 0, ttlMs: MONTH_FLOOR_TTL_MS })
    // The rendered query must carry the predicate; a helper that dropped it
    // would return the global floor and still look correct in every other test.
    expect(JSON.stringify(calls[0])).toContain('region_id')
  })
})

/*
 * The consolidation itself. Three modules each owned a copy of this query; the
 * point of month-floor.ts is that they no longer do. Behavioural tests above
 * cannot see a FOURTH copy reappearing in a sibling, so this is a source-text
 * guard — the same shape as the repo's other anti-duplication gates, and
 * deliberately narrow: it asserts the absence of the specific query, not a
 * general pattern.
 */
describe('one implementation, not four', () => {
  const strip = (src: string) =>
    src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
  const read = (f: string) => strip(readFileSync(resolve(__dirname, '../../..', f), 'utf8'))

  /*
   * The module each one now reaches the helper THROUGH. cost-centres.ts calls it
   * directly; the two reporting scopes stopped doing so when their KPI row moved
   * into the scope engine, and reach it via engine/kpis.ts (which computes the
   * floor from the same §A clamp it sums the headline over).
   *
   * Naming the delegate rather than deleting the assertion keeps the whole chain
   * pinned: a scope module that stopped reaching the helper by ANY route, or a
   * delegate that stopped calling it, goes red here.
   */
  const FLOOR_VIA: Record<string, string> = {
    'server/reporting/regional.ts': 'server/reporting/engine/kpis.ts',
    'server/reporting/across-regions.ts': 'server/reporting/engine/kpis.ts',
    'server/reporting/cost-centres.ts': 'server/reporting/month-floor.ts',
  }
  /** `server/reporting/x/y.ts` → the `./x/y` specifier a sibling imports it by. */
  const specifier = (file: string) => `./${file.replace('server/reporting/', '').replace(/\.ts$/, '')}`

  it.each(Object.keys(FLOOR_VIA))('%s no longer computes its own month floor', (file) => {
    const code = read(file)
    // Each of these carried `to_char(MIN(ts_event), 'YYYY-MM')` — an unbounded
    // scan of the whole lane on every request. They must go through the helper.
    expect(code).not.toMatch(/MIN\(\s*u?\.?ts_event\s*\)[\s\S]{0,40}YYYY-MM'/)
    const via = FLOOR_VIA[file]!
    expect(code, `${file} must import ${via}`).toContain(specifier(via))
    expect(read(via), `${via} must be the one that calls the helper`).toContain('reportMonthFloor')
  })

  it('the helper holds exactly the two forms of that one query', () => {
    const code = read('server/reporting/month-floor.ts')
    const floors = code.match(/to_char\(MIN\(day\), 'YYYY-MM'\)/g) ?? []
    // Scoped and whole-company. A third would be a second definition again.
    expect(floors.length).toBe(2)
  })
})

/*
 * A stale floor must never REJECT. The floor is enforced as a 400, instances do
 * not share this cache, and a backfill that restores older history LOWERS the
 * floor — so a cached value can be later than the truth for a whole TTL and
 * would refuse a month whose data exists, on one instance but not its
 * neighbour.
 */
describe('confirmBelowFloor — the cache may never deny an answer', () => {
  it('re-reads uncached and clears a rejection the stale value would have made', async () => {
    const { tx, calls } = stubTx(['2026-03', '2026-01'])
    // Warm: this instance believes the floor is March.
    const cached = await reportMonthFloor(
      tx,
      { key: 's', where: null },
      { now: 0, ttlMs: MONTH_FLOOR_TTL_MS },
    )
    expect(cached).toBe('2026-03')
    // A backfill has since restored January. Asking about January must NOT 400.
    const verdict = await confirmBelowFloor(tx, { key: 's', where: null }, '2026-01')
    expect(verdict).toBeNull()
    expect(calls.length).toBe(2) // it genuinely re-read rather than trusting the cache
  })

  it('still reports a genuinely-below-floor month, so the guard keeps working', async () => {
    const { tx } = stubTx(['2026-03'])
    const verdict = await confirmBelowFloor(tx, { key: 's2', where: null }, '2026-01')
    expect(verdict).toBe('2026-03')
  })

  it('refreshes the cache with what it read, so the next request is fast and correct', async () => {
    const { tx, calls } = stubTx(['2026-03', '2026-01'])
    await reportMonthFloor(tx, { key: 's3', where: null }, { now: 0, ttlMs: MONTH_FLOOR_TTL_MS })
    await confirmBelowFloor(tx, { key: 's3', where: null }, '2026-01')
    const after = await reportMonthFloor(
      tx,
      { key: 's3', where: null },
      { ttlMs: MONTH_FLOOR_TTL_MS },
    )
    expect(after).toBe('2026-01') // the corrected value, not the stale one
    expect(calls.length).toBe(2) // and no third scan
  })
})

describe('the VITEST default-TTL guard', () => {
  it("parses VITEST as a value, not as mere presence", () => {
    /*
     * `process.env.VITEST ? ...` treats the STRING '0' as truthy, so a host
     * exporting VITEST=0 would silently disable caching in production. The
     * guard must compare, not coerce.
     */
    const src = readFileSync(
      resolve(__dirname, '../../..', 'server/reporting/month-floor.ts'),
      'utf8',
    )
    expect(src).toContain("process.env.VITEST === 'true'")
    expect(src).not.toMatch(/process\.env\.VITEST\s*\?/)
  })
})
