// @vitest-environment node
/*
 * The shared reporting engine must never serve the WRONG scope.
 *
 * across-regions.ts is regional.ts with the scope predicate deleted — 7 of 12
 * paired query functions are >=70% line-identical once naming and the predicate
 * are normalised away — so every fix had to be applied twice, and the two
 * copies had already drifted (their (day, lane) map-key separators differed).
 * Consolidating them removes that, but introduces a hazard the copies did not
 * have: ONE implementation now answers for both scopes, so a mistake in how the
 * clamp is threaded is a mistake in whose money is reported.
 *
 * The two failures that matter are opposites:
 *   - a REGIONAL caller losing its clamp reports the whole company's spend
 *     under one region's name — a cross-region data leak on a governance
 *     surface;
 *   - a WHOLE-COMPANY caller inheriting a clamp silently under-reports the
 *     company total, which nothing else on the page would contradict.
 *
 * Both are asserted here against real data in two regions, on numbers that
 * differ, so either mistake is a wrong FIGURE rather than a wrong shape.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { sql } from 'drizzle-orm'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'
import { buildUsageRollup, rebuildUsageRollup } from '../helpers/usage-rollup'
import {
  wholeCompanyUsage,
  wholeCompanyFinance,
  clampedUsage,
  clampedFinance,
  scopeSql,
} from '../../../server/reporting/engine/scope'
import {
  fetchUsageWeeklyLanes,
  fetchDailyMetrics,
} from '../../../server/reporting/engine/usage-series'
import {
  fetchChargebackTrend,
  fetchChargebackLaneTrend,
  fetchChargebackLanes,
} from '../../../server/reporting/engine/chargeback-series'
import { fetchKpiCore } from '../../../server/reporting/engine/kpis'
import { fetchPerPerson } from '../../../server/reporting/engine/per-person'
import { fetchDrivers } from '../../../server/reporting/engine/drivers'
import { resolveServerClock } from '../../../shared/reports/clock'

/*
 * A PINNED clock. `fetchDailyMetrics` / `fetchChargebackTrend` no longer read
 * `CURRENT_DATE` (F1/D2) — the axis frontier is `clock.settledThrough`, passed
 * in. Fixed well past every window below, so the frontier is the window's own
 * end and these assertions are about the CLAMP, not about the calendar.
 */
const CLOCK = resolveServerClock(new Date('2026-12-31T12:00:00Z'))


let t: TestDb
let regionA = ''
let regionB = ''

const WINDOW = { startIso: '2026-06-01T00:00:00.000Z', endIso: '2026-06-04T00:00:00.000Z' }

beforeAll(async () => {
  t = await startTestDb()
  await t.client`INSERT INTO region (code, display_name) VALUES ('sa', 'Scope A'), ('sb', 'Scope B')`
  ;[{ id: regionA }] = await t.client<{ id: string }[]>`SELECT id::text AS id FROM region WHERE code='sa'`
  ;[{ id: regionB }] = await t.client<{ id: string }[]>`SELECT id::text AS id FROM region WHERE code='sb'`

  const seed = async (code: string, region: string, usd: number, usageUsd: number) => {
    await t.client`INSERT INTO org_unit (region_id, path, code, display_name, unit_type, is_cost_owning_unit)
      VALUES (${region}::uuid, ${code}::ltree, ${code}, ${code}, 'practice', true)`
    const [u] = await t.client<{ id: string }[]>`SELECT id::text AS id FROM org_unit WHERE code=${code}`
    await t.client`INSERT INTO teammate (entra_oid, email, display_name, region_id, org_unit_id)
      VALUES (${'oid-' + code}, ${code + '@x.test'}, ${code}, ${region}::uuid, ${u!.id}::uuid)`
    const [m] = await t.client<{ id: string }[]>`SELECT id::text AS id FROM teammate WHERE email=${code + '@x.test'}`
    await t.client`INSERT INTO actual_spend (teammate_id, date, tool, cost_usd, input_tokens, output_tokens, chargeback_exempt)
      VALUES (${m!.id}::uuid, DATE '2026-06-02', 'claude-code', ${usd}, 10, 5, false)`

    /*
     * §A usage for the same teammate, at a DIFFERENT amount from the §B bill on
     * purpose: if a §A function were pointed at the bill lane (or vice versa)
     * it would still return plausible cells, just the wrong lane's money, and
     * no shape assertion would notice. Different figures make that a wrong
     * NUMBER.
     */
    await t.client`INSERT INTO instance_attestation
        (instance_id, principal_oid, teammate_id, tool, region_id, org_unit_id, project_code_hash, raw_project_code)
      VALUES (gen_random_uuid(), ${'p-' + code}, ${m!.id}::uuid, 'claude-code', ${region}::uuid, ${u!.id}::uuid, 'h', 'P')`
    const [inst] = await t.client<{ id: string }[]>`
      SELECT instance_id::text AS id FROM instance_attestation WHERE teammate_id=${m!.id}::uuid LIMIT 1`
    await t.client`INSERT INTO attribution_record
        (instance_id, teammate_id, region_id, org_unit_id, tool, model, token_type, tokens, cost_usd,
         fidelity_tier, cost_basis, ts_event, claude_session_id)
      VALUES (${inst!.id}::uuid, ${m!.id}::uuid, ${region}::uuid, ${u!.id}::uuid, 'claude-code',
              'claude-sonnet-4-6', 'input', 1000, ${usageUsd}, 'tier-1', 'estimated',
              '2026-06-02T00:00:00Z'::timestamptz, ${'conv-' + code})`
  }
  // Distinct amounts, so a leaked or dropped clamp is a wrong NUMBER.
  await seed('sa', regionA, 100, 11)
  await seed('sb', regionB, 7, 3)

  /*
   * A POOLED Copilot bill for June, in region A's cost centre. Without this the
   * month-alignment assertion below is vacuous: with no pool rows, including
   * and excluding the pool give the same answer whatever the gate does.
   */
  const [ccA] = await t.client<{ id: string }[]>`SELECT id::text AS id FROM org_unit WHERE code='sa'`
  const [ent] = await t.client<{ id: string }[]>`
    INSERT INTO provider_enterprise (provider, external_id, display_name)
    VALUES ('github', 'scope-ent', 'Scope Ent') RETURNING id::text AS id`
  const [po] = await t.client<{ id: string }[]>`
    INSERT INTO provider_org (provider, external_org_id, display_name, provider_enterprise_id, cost_owning_unit_id)
    VALUES ('github', 'scope-org', 'Scope Org', ${ent!.id}::uuid, ${ccA!.id}::uuid) RETURNING id::text AS id`
  await t.client`
    INSERT INTO copilot_pool_bill
      (month, provider_enterprise_id, provider_org_id, cost_owning_unit_id, seats,
       license_net_usd, overage_net_usd, unclassified_net_usd, included_allowance_usd, usage_gross_usd)
    VALUES (DATE '2026-06-01', ${ent!.id}::uuid, ${po!.id}::uuid, ${ccA!.id}::uuid, 5, 200, 100, 55, 400, 350)`
  // The region reports' §A reads come from usage_rollup_daily (usage-rollup-
  // lane.md R5/R8): materialise it from the seeds above via the real worker.
  await buildUsageRollup(t.db)
})

/** The whole of June — month-aligned, so the pooled Copilot lane is eligible. */
const MONTH_WINDOW = { startIso: '2026-06-01T00:00:00.000Z', endIso: '2026-07-01T00:00:00.000Z' }

afterAll(async () => {
  await stopTestDb(t)
})

const total = (rows: { chargeUsd: number }[]) => rows.reduce((a, r) => a + r.chargeUsd, 0)
const clampA = () => clampedFinance(sql`region_id = ${regionA}::uuid`)
const clampAUsage = () => clampedUsage(sql`region_id = ${regionA}::uuid`)

describe('the clamp is threaded, in both directions', () => {
  it('a clamped caller sees ONLY its own region', async () => {
    const rows = await fetchChargebackTrend(t.db, clampA(), WINDOW, CLOCK)
    expect(total(rows)).toBeCloseTo(100, 2)
    expect(total(rows)).not.toBeCloseTo(107, 2) // would be the whole company
  })

  it('a whole-company caller sees EVERY region, not just one', async () => {
    const rows = await fetchChargebackTrend(t.db, wholeCompanyFinance, WINDOW, CLOCK)
    expect(total(rows)).toBeCloseTo(107, 2)
    expect(total(rows)).not.toBeCloseTo(100, 2) // would be region A alone
  })

  it('the lane trend threads the clamp identically to the total', async () => {
    const clamped = await fetchChargebackLaneTrend(t.db, clampA(), WINDOW)
    const all = await fetchChargebackLaneTrend(t.db, wholeCompanyFinance, WINDOW)
    expect(total(clamped)).toBeCloseTo(100, 2)
    expect(total(all)).toBeCloseTo(107, 2)
  })

  it('Σ lanes equals the total for the SAME scope, cent-exactly', async () => {
    // The invariant that would catch a clamp threaded into one but not the
    // other — the two would still each look internally plausible.
    for (const scope of [clampA(), wholeCompanyFinance]) {
      const totals = await fetchChargebackTrend(t.db, scope, WINDOW, CLOCK)
      const lanes = await fetchChargebackLaneTrend(t.db, scope, WINDOW)
      expect(total(lanes)).toBeCloseTo(total(totals), 2)
    }
  })

  it('zero-fills the total series but not the lane series', async () => {
    // The window spans three days with spend on one; the total is the axis of
    // record so a spendless day is a real zero, while the lane series carries
    // only cells that exist.
    const totals = await fetchChargebackTrend(t.db, wholeCompanyFinance, WINDOW, CLOCK)
    const lanes = await fetchChargebackLaneTrend(t.db, wholeCompanyFinance, WINDOW)
    expect(totals.length).toBe(3)
    expect(totals.filter((r) => r.chargeUsd === 0).length).toBe(2)
    expect(lanes.every((r) => r.chargeUsd !== 0)).toBe(true)
  })
})

describe('fetchChargebackLanes threads the same clamp', () => {
  const laneTotal = (rows: { chargeUsd: number }[]) => rows.reduce((a, r) => a + r.chargeUsd, 0)

  it('clamps to one region, and reports every region when unclamped', async () => {
    const mine = await fetchChargebackLanes(t.db, clampA(), WINDOW, { copilotChargeback: false })
    const all = await fetchChargebackLanes(t.db, wholeCompanyFinance, WINDOW, { copilotChargeback: false })
    expect(laneTotal(mine)).toBeCloseTo(100, 2)
    expect(laneTotal(all)).toBeCloseTo(107, 2)
  })

  it('agrees with the day-series total for the SAME scope', async () => {
    // Two different queries over two different groupings of one bill lane; if
    // the clamp were threaded into one and not the other, each would still look
    // internally consistent.
    for (const scope of [clampA(), wholeCompanyFinance]) {
      const lanes = await fetchChargebackLanes(t.db, scope, WINDOW, { copilotChargeback: false })
      const days = await fetchChargebackTrend(t.db, scope, WINDOW, CLOCK)
      expect(laneTotal(lanes)).toBeCloseTo(laneTotal(days), 2)
    }
  })

  it('INCLUDES the pooled Copilot lanes over a month-aligned window', async () => {
    // Proves the fixture actually carries a pool, so the exclusion assertion
    // below is about the gate rather than about an empty table.
    const on = await fetchChargebackLanes(t.db, wholeCompanyFinance, MONTH_WINDOW, {
      copilotChargeback: true,
    })
    const off = await fetchChargebackLanes(t.db, wholeCompanyFinance, MONTH_WINDOW, {
      copilotChargeback: false,
    })
    expect(laneTotal(on)).toBeGreaterThan(laneTotal(off))
    expect(on.some((r) => r.lane.startsWith('copilot'))).toBe(true)
  })

  it('keeps the month-grained Copilot pool OUT of a non-month-aligned window', async () => {
    /*
     * The window here is 3 days. v_finance_copilot_pool_chargeback is POOLED
     * per cost-centre per MONTH, so folding it in would attribute a whole
     * month's pool to a partial period — a figure that cannot be reconciled
     * against anything else on the page.
     */
    const withPool = await fetchChargebackLanes(t.db, wholeCompanyFinance, WINDOW, {
      copilotChargeback: true,
    })
    const without = await fetchChargebackLanes(t.db, wholeCompanyFinance, WINDOW, {
      copilotChargeback: false,
    })
    expect(laneTotal(withPool)).toBeCloseTo(laneTotal(without), 2)
    expect(withPool.some((r) => r.lane.startsWith('copilot'))).toBe(false)
  })

  it('clamps the pooled lanes too, not just the daily bill', async () => {
    // The pool lives in region A's cost centre; a region-B caller must not see it.
    const b = await fetchChargebackLanes(
      t.db,
      clampedFinance(sql`region_id = ${regionB}::uuid`),
      MONTH_WINDOW,
      { copilotChargeback: true },
    )
    expect(b.some((r) => r.lane.startsWith('copilot'))).toBe(false)
  })
})

describe('tool folding — what reaches a lane, and what never vanishes', () => {
  /*
   * Every other fixture here bills a single known tool, so the JS lane merge
   * and the unknown/NULL fallback were both untested: adding `WHERE tool IS NOT
   * NULL` to either extracted query left the whole suite green while a
   * reconciliation row with no tool silently disappeared from a §B total.
   */
  const laneOf = (rows: { lane: string; chargeUsd: number }[], lane: string) =>
    rows.filter((r) => r.lane === lane).reduce((a, r) => a + r.chargeUsd, 0)

  it('folds an unknown tool into `other` rather than dropping it', async () => {
    /*
     * NOT tested here: a NULL tool. chargeToVendor handles null, but
     * actual_spend.tool is NOT NULL (drizzle/schema/spend.ts:32), so no NULL
     * can reach the §B view by this path — the null branch is defensive and
     * unreachable from this source. Asserting on it would mean seeding a row
     * the schema forbids, i.e. testing a state production cannot be in.
     */
    const [m] = await t.client<{ id: string }[]>`SELECT id::text AS id FROM teammate WHERE email='sa@x.test'`
    try {
      await t.client`INSERT INTO actual_spend (teammate_id, date, tool, cost_usd, input_tokens, output_tokens, chargeback_exempt)
        VALUES (${m!.id}::uuid, DATE '2026-06-03', 'some-future-tool', 4, 1, 1, false)`
      const lanes = await fetchChargebackLaneTrend(t.db, wholeCompanyFinance, WINDOW)
      const totals = await fetchChargebackTrend(t.db, wholeCompanyFinance, WINDOW, CLOCK)
      // It lands in `other`, and it does not leave the total.
      expect(laneOf(lanes, 'other')).toBeCloseTo(4, 2)
      expect(lanes.reduce((a, r) => a + r.chargeUsd, 0)).toBeCloseTo(
        totals.reduce((a, r) => a + r.chargeUsd, 0),
        2,
      )
    } finally {
      await t.client`DELETE FROM actual_spend WHERE date = DATE '2026-06-03'`
    }
  })

  it('MERGES two tools that share one lane into a single cell', async () => {
    /*
     * The tool→lane mapping is N:1 by contract, and the merge happens in JS
     * after the SQL GROUP BY. SQL aggregation of one tool does not exercise it:
     * two distinct tools on the same day must produce ONE summed lane cell, not
     * two cells the client would then render twice.
     */
    const [m] = await t.client<{ id: string }[]>`SELECT id::text AS id FROM teammate WHERE email='sa@x.test'`
    // Inserts INSIDE the try: one outside it, throwing, leaves the row behind
    // and the next test sees a total it cannot explain.
    try {
      await t.client`INSERT INTO actual_spend (teammate_id, date, tool, cost_usd, input_tokens, output_tokens, chargeback_exempt)
        VALUES (${m!.id}::uuid, DATE '2026-06-03', 'unknown-a', 2, 1, 1, false)`
      await t.client`INSERT INTO actual_spend (teammate_id, date, tool, cost_usd, input_tokens, output_tokens, chargeback_exempt)
        VALUES (${m!.id}::uuid, DATE '2026-06-03', 'unknown-b', 3, 1, 1, false)`
      const lanes = await fetchChargebackLaneTrend(t.db, wholeCompanyFinance, WINDOW)
      const onThatDay = lanes.filter((r) => r.day === '2026-06-03' && r.lane === 'other')
      expect(onThatDay.length).toBe(1)
      expect(onThatDay[0]!.chargeUsd).toBeCloseTo(5, 2)
    } finally {
      await t.client`DELETE FROM actual_spend WHERE date = DATE '2026-06-03'`
    }
  })
})

describe('the §A usage engine threads the clamp on its own lane', () => {
  /*
   * §A reads v_complete_usage; §B reads v_finance_bill_chargeback. They are
   * different lanes answering different questions, and consistency contract C2
   * ("one lane per axis, firewall-enforced") exists because a figure from one
   * summed with a figure from the other is a number that means nothing.
   */
  const usd = (rows: { usd: number }[]) => rows.reduce((a, r) => a + r.usd, 0)

  it('clamps §A usage to one region, and reports all regions when unclamped', async () => {
    const mine = await fetchUsageWeeklyLanes(t.db, clampAUsage(), MONTH_WINDOW)
    const all = await fetchUsageWeeklyLanes(t.db, wholeCompanyUsage, MONTH_WINDOW)
    expect(usd(mine)).toBeCloseTo(11, 2)
    expect(usd(all)).toBeCloseTo(14, 2)
  })

  it('clamps the daily metrics, and counts distinct people per scope', async () => {
    const mine = await fetchDailyMetrics(t.db, clampAUsage(), MONTH_WINDOW, CLOCK)
    const all = await fetchDailyMetrics(t.db, wholeCompanyUsage, MONTH_WINDOW, CLOCK)
    expect(mine.reduce((a, r) => a + r.genuineUsd, 0)).toBeCloseTo(11, 2)
    expect(all.reduce((a, r) => a + r.genuineUsd, 0)).toBeCloseTo(14, 2)
    // activeUsers is COUNT(DISTINCT teammate_id) and must follow the clamp too
    // — a leaked clamp inflates the headcount as well as the money.
    expect(Math.max(...mine.map((r) => r.activeUsers))).toBe(1)
    expect(Math.max(...all.map((r) => r.activeUsers))).toBe(2)
  })

  it('counts a person ONCE per day however many times they emitted', async () => {
    /*
     * Every other fixture gives each teammate a single usage row, so COUNT and
     * COUNT(DISTINCT) agree and the distinctness is untested — dropping DISTINCT
     * left the whole suite green. A second row for the SAME person on the SAME
     * day separates them: two rows, still one active person. Without DISTINCT
     * the "active users" figure counts EMISSIONS, which on a busy day would
     * report more active people than the company employs.
     */
    const [m] = await t.client<{ id: string }[]>`SELECT id::text AS id FROM teammate WHERE email='sa@x.test'`
    const [inst] = await t.client<{ id: string }[]>`
      SELECT instance_id::text AS id FROM instance_attestation WHERE teammate_id=${m!.id}::uuid LIMIT 1`
    const [u] = await t.client<{ id: string }[]>`SELECT id::text AS id FROM org_unit WHERE code='sa'`
    try {
      await t.client`INSERT INTO attribution_record
          (instance_id, teammate_id, region_id, org_unit_id, tool, model, token_type, tokens, cost_usd,
           fidelity_tier, cost_basis, ts_event, claude_session_id)
        VALUES (${inst!.id}::uuid, ${m!.id}::uuid, ${regionA}::uuid, ${u!.id}::uuid, 'claude-code',
                'claude-sonnet-4-6', 'input', 500, 1, 'tier-1', 'estimated',
                '2026-06-02T12:00:00Z'::timestamptz, 'conv-sa-second')`
      // Mid-test §A mutation → the rollup the engine reads must be recomputed
      // (usage-rollup-lane.md R8; a plain re-run would skip the already-
      // materialised day, so this is the rebuild variant).
      await rebuildUsageRollup(t.db)
      const rows = await fetchDailyMetrics(t.db, clampAUsage(), MONTH_WINDOW, CLOCK)
      const day = rows.find((r) => r.day === '2026-06-02')!
      expect(day.activeUsers).toBe(1) // one PERSON, two emissions
      expect(day.genuineUsd).toBeCloseTo(12, 2) // and both emissions' money counts
    } finally {
      await t.client`DELETE FROM attribution_record WHERE claude_session_id = 'conv-sa-second'`
      // Restore the rollup to the fixture state the sibling tests read.
      await rebuildUsageRollup(t.db)
    }
  })

  it('zero-fills every day of the window, so a sparkline keeps its shape', async () => {
    /*
     * Spend lands on one day of a whole month. Without the zero-fill the series
     * would be a single point and the chart would compress scattered activity
     * into contiguous ones, misstating the month.
     */
    const rows = await fetchDailyMetrics(t.db, wholeCompanyUsage, MONTH_WINDOW, CLOCK)
    expect(rows.length).toBe(30) // June
    expect(rows.filter((r) => r.genuineUsd === 0).length).toBe(29)
  })

  it('reads the USAGE lane, not the bill lane', async () => {
    /*
     * The fixture seeds §A usage and §B bill at DIFFERENT amounts on purpose.
     * If this function were pointed at v_finance_bill_chargeback it would still
     * return plausible weekly cells — just the wrong lane's money — and no
     * shape assertion would notice.
     */
    const usage = await fetchUsageWeeklyLanes(t.db, wholeCompanyUsage, MONTH_WINDOW)
    const bill = await fetchChargebackTrend(t.db, wholeCompanyFinance, MONTH_WINDOW, CLOCK)
    expect(usd(usage)).toBeCloseTo(14, 2)
    expect(bill.reduce((a, r) => a + r.chargeUsd, 0)).toBeCloseTo(107, 2)
    expect(usd(usage)).not.toBeCloseTo(107, 2)
  })
})

describe('the KPI row threads a SEPARATE clamp per lane', () => {
  /*
   * The KPI core is the one engine function holding both lanes at once: the
   * tiles render `genuineUsd` (§A, v_complete_usage) beside `chargeableUsd`
   * (§B, the v_finance_* views). It therefore takes TWO clamps, and each has to
   * reach its own lane — a §B clamp applied to the §A total, or one clamp used
   * for both, would still return a plausible row.
   *
   * The fixture's §A and §B amounts differ per region on purpose (A: 11 usage /
   * 100 bill, B: 3 usage / 7 bill), so every mistake of that shape is a wrong
   * FIGURE rather than a wrong shape.
   */
  const scopeA = () => ({
    usage: clampedUsage(sql`region_id = ${regionA}::uuid`),
    finance: clampedFinance(sql`region_id = ${regionA}::uuid`),
    monthFloorKey: `test:region:${regionA}`,
  })
  const scopeAll = () => ({
    usage: wholeCompanyUsage,
    finance: wholeCompanyFinance,
    monthFloorKey: 'test:across:global',
  })
  const OFF = { copilotChargeback: false, momMonthRange: null, now: new Date('2026-07-15T00:00:00Z') }

  it('clamps the §A half to one region, and reports every region unclamped', async () => {
    const mine = await fetchKpiCore(t.db, scopeA(), MONTH_WINDOW, OFF)
    const all = await fetchKpiCore(t.db, scopeAll(), MONTH_WINDOW, OFF)
    expect(mine.genuineUsd).toBeCloseTo(11, 2)
    expect(all.genuineUsd).toBeCloseTo(14, 2)
    // COUNT(DISTINCT teammate_id) must follow the clamp too — a leaked clamp
    // inflates the headcount as well as the money.
    expect(mine.activeUsers).toBe(1)
    expect(all.activeUsers).toBe(2)
  })

  it('clamps the §B half to one region, and reports every region unclamped', async () => {
    const mine = await fetchKpiCore(t.db, scopeA(), MONTH_WINDOW, OFF)
    const all = await fetchKpiCore(t.db, scopeAll(), MONTH_WINDOW, OFF)
    expect(mine.anthropicChargeableUsd).toBeCloseTo(100, 2)
    expect(all.anthropicChargeableUsd).toBeCloseTo(107, 2)
    expect(mine.billedTeammates).toBe(1)
    expect(all.billedTeammates).toBe(2)
  })

  it('keeps the two lanes apart — the §A total is never the §B one', async () => {
    /*
     * The swap that type-checks nowhere but would be invisible in a shape
     * assertion: reading the bill lane into `genuineUsd`. 11 ≠ 100 and 14 ≠ 107,
     * so it is a wrong number here.
     */
    const all = await fetchKpiCore(t.db, scopeAll(), MONTH_WINDOW, OFF)
    expect(all.genuineUsd).not.toBeCloseTo(all.anthropicChargeableUsd, 2)
    expect(all.avgChargePerBilledUser).toBeCloseTo(107 / 2, 2)
  })

  it('folds the pooled Copilot net only in chargeback mode, on the SAME clamp', async () => {
    const off = await fetchKpiCore(t.db, scopeAll(), MONTH_WINDOW, OFF)
    const on = await fetchKpiCore(t.db, scopeAll(), MONTH_WINDOW, { ...OFF, copilotChargeback: true })
    // Non-vacuous: the fixture's pool is real money, so the fold is observable.
    expect(off.copilotChargeableUsd).toBeGreaterThan(0)
    expect(off.chargeableUsd).toBeCloseTo(off.anthropicChargeableUsd, 2)
    expect(on.chargeableUsd).toBeCloseTo(on.anthropicChargeableUsd + on.copilotChargeableUsd, 2)
    expect(on.copilotPartialMonthUnavailable).toBe(false)

    // The pool sits in region A's cost centre, so a region-B caller has none of it.
    const b = await fetchKpiCore(
      t.db,
      {
        usage: clampedUsage(sql`region_id = ${regionB}::uuid`),
        finance: clampedFinance(sql`region_id = ${regionB}::uuid`),
        monthFloorKey: `test:region:${regionB}`,
      },
      MONTH_WINDOW,
      { ...OFF, copilotChargeback: true },
    )
    expect(b.copilotChargeableUsd).toBeCloseTo(0, 2)
  })

  it('withholds the month-grained pool over a partial-month window', async () => {
    // WINDOW is three days. Folding a whole month's pooled net into it would
    // attribute a month of Copilot to a partial period.
    const on = await fetchKpiCore(t.db, scopeAll(), WINDOW, { ...OFF, copilotChargeback: true })
    expect(on.copilotPartialMonthUnavailable).toBe(true)
    expect(on.chargeableUsd).toBeCloseTo(on.anthropicChargeableUsd, 2)
  })

  it('takes the month floor from the §A clamp, not from the whole company', async () => {
    /*
     * The floor is a MIN over ALL history and is enforced as a 400, so a floor
     * summed over a wider scope than the headline beside it refuses a month the
     * caller does have data in. The engine derives the floor's predicate from
     * the same §A clamp it sums the total over; this seeds history that exists
     * for ONE region only, so a floor that ignored the clamp is a wrong MONTH.
     *
     * The row is April, outside every window asserted elsewhere in this file.
     */
    const [m] = await t.client<{ id: string }[]>`SELECT id::text AS id FROM teammate WHERE email='sb@x.test'`
    const [inst] = await t.client<{ id: string }[]>`
      SELECT instance_id::text AS id FROM instance_attestation WHERE teammate_id=${m!.id}::uuid LIMIT 1`
    const [u] = await t.client<{ id: string }[]>`SELECT id::text AS id FROM org_unit WHERE code='sb'`
    try {
      await t.client`INSERT INTO attribution_record
          (instance_id, teammate_id, region_id, org_unit_id, tool, model, token_type, tokens, cost_usd,
           fidelity_tier, cost_basis, ts_event, claude_session_id)
        VALUES (${inst!.id}::uuid, ${m!.id}::uuid, ${regionB}::uuid, ${u!.id}::uuid, 'claude-code',
                'claude-sonnet-4-6', 'input', 100, 2, 'tier-1', 'estimated',
                '2026-04-09T00:00:00Z'::timestamptz, 'conv-sb-april')`
      // The floor reads the day rollup (month-floor.ts), so materialise the row.
      await rebuildUsageRollup(t.db)
      const mine = await fetchKpiCore(t.db, scopeA(), MONTH_WINDOW, OFF)
      const all = await fetchKpiCore(t.db, scopeAll(), MONTH_WINDOW, OFF)
      expect(all.monthFloor).toBe('2026-04') // region B's April is company history
      expect(mine.monthFloor).toBe('2026-06') // region A has never emitted before June
      // And the April row stays outside the June window's money.
      expect(mine.genuineUsd).toBeCloseTo(11, 2)
      expect(all.genuineUsd).toBeCloseTo(14, 2)
    } finally {
      await t.client`DELETE FROM attribution_record WHERE claude_session_id = 'conv-sb-april'`
      await rebuildUsageRollup(t.db)
    }
  })
})

/*
 * THE PER-PERSON COHORT THREADS THE CLAMP TOO.
 *
 * `fetchPerPerson` was `fetchAcrossPerPerson` -- an UNCLAMPED query, because only
 * the whole-company width rendered a Median-per-person tile. Both widths render it
 * now, so the query takes a scope, and the failure this guards is the worse of the
 * two directions: a region owner reading the WHOLE COMPANY's median and
 * percentiles under their own region's name.
 *
 * The fixture's two regions carry ONE person each at DIFFERENT amounts (A: $11,
 * B: $3), so a leaked clamp is a wrong SHARE rather than merely a wrong shape.
 *
 * MUTATION: pass `wholeCompanyUsage` inside `fetchRegionalPerPerson` -- the
 * top1 assertions go red.
 */
describe('the per-person cohort threads the §A clamp', () => {
  it('takes the cohort over ONE region, and over every region unclamped', async () => {
    const mine = await fetchPerPerson(t.db, clampAUsage(), MONTH_WINDOW)
    const all = await fetchPerPerson(t.db, wholeCompanyUsage, MONTH_WINDOW)
    expect(mine.medianUsd).toBeCloseTo(11, 2)
    // The SHARES separate them: the one person in region A holds 100% of their
    // own region and 11/14 of the company.
    expect(mine.top1).toBeCloseTo(1, 6)
    expect(all.top1).toBeCloseTo(11 / 14, 6)
  })

  it('counts the emitting subset within the clamp, never the company', async () => {
    const mine = await fetchPerPerson(t.db, clampAUsage(), MONTH_WINDOW)
    const all = await fetchPerPerson(t.db, wholeCompanyUsage, MONTH_WINDOW)
    expect(mine.emittingPeople).toBe(1)
    expect(all.emittingPeople).toBe(2)
  })

  /*
   * The cohort's population must be the SAME one `fetchKpiCore` publishes as
   * `activeUsers`, because the tile reads "half of N are below this" over that N.
   * Two queries that agree today are not one definition -- this pins them
   * together under the same clamp.
   */
  it('divides by the same headcount the KPI row publishes', async () => {
    const scope = {
      usage: clampAUsage(),
      finance: clampA(),
      monthFloorKey: 'test:per-person:' + regionA,
    }
    const kpis = await fetchKpiCore(t.db, scope, MONTH_WINDOW, {
      copilotChargeback: false,
      momMonthRange: null,
      now: new Date('2026-07-15T00:00:00Z'),
    })
    const cohort = await fetchPerPerson(t.db, clampAUsage(), MONTH_WINDOW)
    expect(kpis.activeUsers).toBe(1)
    expect(cohort.top1).toBeCloseTo(1, 6)
  })

  it('withholds both deltas with no month anchor, rather than inventing an operand', async () => {
    const c = await fetchPerPerson(t.db, clampAUsage(), MONTH_WINDOW, { momMonthRange: null })
    expect(c.peopleMomDelta).toBeNull()
    expect(c.medianMomDeltaPct).toBeNull()
  })
})

describe('the driver axes thread the clamp, on every branch', () => {
  /*
   * Drivers are six branches over one clamp, and they do NOT all reach the lane
   * the same way: four issue their own aggregate, the project axis hands the
   * clamp to the project-spend seam, and the teammate/surface branches fold in
   * JS after the GROUP BY. A clamp threaded into some branches and not others
   * gives a table whose rows are one scope's and whose neighbours are another's.
   *
   * The clamp is `u.`-aliased here, as the engine's callers pass it — three
   * branches JOIN a second relation, so a bare `region_id` would be ambiguous.
   */
  const usageA = () => clampedUsage(sql`u.region_id = ${regionA}::uuid`)

  it('ranks only in-scope teammates, and every teammate when unclamped', async () => {
    const mine = await fetchDrivers(t.db, usageA(), MONTH_WINDOW, 'teammate')
    const all = await fetchDrivers(t.db, wholeCompanyUsage, MONTH_WINDOW, 'teammate')
    expect(mine.rows.length).toBe(1)
    expect(mine.headlineUsd).toBeCloseTo(11, 2)
    expect(all.rows.length).toBe(2)
    expect(all.headlineUsd).toBeCloseTo(14, 2)
  })

  it('clamps the practice axis, which JOINs a second relation', async () => {
    const mine = await fetchDrivers(t.db, usageA(), MONTH_WINDOW, 'practice')
    const all = await fetchDrivers(t.db, wholeCompanyUsage, MONTH_WINDOW, 'practice')
    expect(mine.headlineUsd).toBeCloseTo(11, 2)
    expect(all.headlineUsd).toBeCloseTo(14, 2)
    expect(mine.rows.map((r) => r.label)).toEqual(['sa'])
  })

  it('clamps the model and surface axes', async () => {
    for (const axis of ['model', 'surface'] as const) {
      const mine = await fetchDrivers(t.db, usageA(), MONTH_WINDOW, axis)
      const all = await fetchDrivers(t.db, wholeCompanyUsage, MONTH_WINDOW, axis)
      expect(mine.headlineUsd, axis).toBeCloseTo(11, 2)
      expect(all.headlineUsd, axis).toBeCloseTo(14, 2)
    }
  })

  it('clamps the PROJECT axis, which hands the clamp to the spend seam', async () => {
    /*
     * The branch that does not issue its own query: it passes the rendered
     * clamp to completeProjectAxisSpend. Dropping it there is invisible to every
     * other axis's assertion, and would report the whole company's project
     * spend under one region's name.
     */
    const mine = await fetchDrivers(t.db, usageA(), MONTH_WINDOW, 'project')
    const all = await fetchDrivers(t.db, wholeCompanyUsage, MONTH_WINDOW, 'project')
    expect(mine.headlineUsd).toBeCloseTo(11, 2)
    expect(all.headlineUsd).toBeCloseTo(14, 2)
    // No fixture row carries a project claim, so every dollar is the untagged
    // bucket — present as a ROW, which is what makes the sum-back hold.
    expect(all.rows.map((r) => r.label)).toEqual(['Untagged'])
  })

  it('ranks every region on the region axis, and shares sum to one', async () => {
    // The axis only the whole-company scope offers: it needs every region in the
    // scan, so it is the branch that would silently return one row if a clamp
    // leaked into it.
    const all = await fetchDrivers(t.db, wholeCompanyUsage, MONTH_WINDOW, 'region')
    expect(all.rows.length).toBe(2)
    expect(all.headlineUsd).toBeCloseTo(14, 2)
    expect(all.rows.reduce((a, r) => a + r.sharePct, 0)).toBeCloseTo(1, 6)
  })

  it('reads the USAGE lane on every axis, never the bill lane', async () => {
    // §A 14 vs §B 107 for the same window: a branch pointed at the bill lane
    // would still return plausible rows, just the wrong lane's money.
    for (const axis of ['teammate', 'practice', 'model', 'surface', 'project', 'region'] as const) {
      const all = await fetchDrivers(t.db, wholeCompanyUsage, MONTH_WINDOW, axis)
      expect(all.headlineUsd, axis).toBeCloseTo(14, 2)
    }
  })
})

describe('scopeSql', () => {
  it('renders whole-company as a clause that is safe to AND', async () => {
    // An empty fragment would make `WHERE ${scopeSql(s)} AND ...` a syntax
    // error, and "fix" it by moving the AND to the caller — which is how one
    // caller ends up dropping its clamp.
    const rows = await t.db.execute<{ ok: boolean }>(
      sql`SELECT (${scopeSql(wholeCompanyUsage)} AND TRUE) AS ok`,
    )
    expect([...rows][0]!.ok).toBe(true)
  })

  it('PARENTHESISES a clamp, so an OR predicate cannot escape the window', async () => {
    /*
     * The bug the previous test could not see: it used an atomic `1 = 2` and
     * wrapped it externally. AND binds tighter than OR, so an unwrapped
     * predicate with a top-level OR re-associates when the caller appends its
     * date window —
     *   WHERE region = A OR region = B AND day >= x
     * parses as region = A OR (region = B AND day >= x), and every region-A row
     * in HISTORY joins the result. Verified against Postgres: a 2020 row came
     * back inside a June-2026 window.
     */
    const rows = await t.db.execute<{ ok: boolean }>(
      sql`SELECT (${scopeSql(clampedUsage(sql`TRUE OR FALSE`))} AND FALSE) AS ok`,
    )
    expect([...rows][0]!.ok).toBe(false)
  })

  it('renders a clamp as the predicate itself', async () => {
    const rows = await t.db.execute<{ ok: boolean }>(
      sql`SELECT (${scopeSql(clampedUsage(sql`1 = 2`))}) AS ok`,
    )
    expect([...rows][0]!.ok).toBe(false)
  })
})

/*
 * The consolidation itself. The behavioural tests above cannot see a copy
 * REAPPEARING in regional.ts or across-regions.ts — both would still pass with
 * the old duplicated bodies restored. This is the source-text half, and it is
 * deliberately narrow: it asserts the specific queries are gone from the two
 * scope modules, not a general pattern.
 */
describe('one implementation, not two', () => {
  const strip = (src: string) =>
    src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
  const read = (f: string) => strip(readFileSync(resolve(__dirname, '../../..', f), 'utf8'))

  it.each(['server/reporting/regional.ts', 'server/reporting/across-regions.ts'])(
    '%s delegates every extracted series rather than re-issuing it',
    (file) => {
      const code = read(file)
      /*
       * Each extracted query's OWN SQL signature must be gone. Asserting only
       * that the helper NAMES appear proves nothing — they already appear in
       * the import statement, so a wrapper could import the helper, ignore it,
       * and keep its old body. Likewise, forbidding just one signature (the
       * first version of this test) let all three chargeback bodies be
       * restored while it stayed green.
       */
      const extractedSignatures = [
        /SELECT to_char\(period_date, 'YYYY-MM-DD'\) AS day, tool/, // lane trend
        /SELECT period_date AS day, SUM\(bill_usd\) AS charge/, // zero-filled total
        /SELECT tool, SUM\(bill_usd\)::text AS charge/, // lane totals
        /date_trunc\('week', ts_event\)::date::text AS week_start/, // §A weekly
        /COUNT\(DISTINCT u\.teammate_id\) AS active_users/, // §A per-day metrics
        /to_char\(MAX\(ts_event\), 'YYYY-MM-DD'\) AS as_of/, // KPI §A totals
        /COALESCE\(SUM\(bill_usd\), 0\)::text AS anthropic/, // KPI §B daily bill grain
        /COALESCE\(SUM\(charge_usd\), 0\)::text AS copilot/, // KPI §B pooled Copilot month
        /SELECT u\.teammate_id::text AS key, COALESCE\(t\.display_name, t\.email\) AS label/, // teammate axis
        /SELECT NULL::text AS key, NULL::text AS label, u\.tool AS tool/, // surface axis
        /SELECT u\.model AS key, u\.model AS label, u\.usage_provenance AS provenance/, // model axis
        // The practice AXIS, not the practice RANKING card: fetchRegionalPractices
        // groups the same relation for a different surface and legitimately stays.
        // `FALSE AS pooled` is what tells the two apart.
        /cou\.cost_owning_unit_name AS label, COALESCE\(SUM\(u\.cost_usd\), 0\)::text AS value, FALSE AS pooled/,
      ]
      for (const re of extractedSignatures) expect(code).not.toMatch(re)
      /*
       * NOT asserted: that the file no longer mentions
       * v_finance_copilot_pool_chargeback at all. That would claim more than
       * this change delivers — fetchRegionalChargebackByCostCentre and
       * fetchAcrossChargebackByRegion still read it legitimately, and are a
       * later pair in the same consolidation.
       */
    },
  )

  it('neither scope module still declares its own lane-order map', () => {
    // LANE_ORDER was declared identically in both; it now lives once, in the
    // engine. Two copies of a canonical ORDER is how two surfaces start
    // sorting the same lanes differently.
    for (const f of ['server/reporting/regional.ts', 'server/reporting/across-regions.ts']) {
      expect(read(f)).not.toContain('const LANE_ORDER')
    }
  })

  it('the §A and §B engines read their own lane and only their own', () => {
    /*
     * usage-coverage.ts is here for the same reason: it decomposes a §A total by
     * budget state, and a coverage figure that mixed in a bill-lane operand would
     * be a share of one lane over a denominator from the other (contract C2). Its
     * `allocation` join is the budget PREDICATE, not a money source.
     *
     * drivers.ts is covered here too: a driver row answers "who consumed this",
     * so a §B read reaching one of its six branches would put billed money under
     * a usage denominator.
     *
     * WHAT THIS COVERS: usage-series.ts, usage-coverage.ts and drivers.ts as §A
     * only, and chargeback-series.ts as §B only. kpis.ts is deliberately absent
     * and is the one module that reads BOTH — the KPI tiles render a §A total
     * beside a §B charge — so a single-lane assertion would be false about it.
     * What holds for kpis.ts is the repo-wide lane firewall
     * (tests/unit/server/reports-lane-firewall.test.ts, which scans all of
     * server/reporting/**): no raw ledger, aggregate or actual_spend read.
     */
    // The §A source of record for these engines is usage_rollup_daily — the
    // day-grain rollup DEFINED as an aggregate of v_complete_usage
    // (docs/design/usage-rollup-lane.md R5/R7). Same lane, same wall: none of
    // them may touch a v_finance_* view, and the bill engine may touch neither
    // the §A view nor its rollup. Placement-aware readers go through the
    // current-org lens view over the rollup (mig 0162), which is the same source.
    const usage = read('server/reporting/engine/usage-series.ts')
    const coverage = read('server/reporting/engine/usage-coverage.ts')
    const drivers = read('server/reporting/engine/drivers.ts')
    const bill = read('server/reporting/engine/chargeback-series.ts')
    expect(usage).toMatch(/\b(usage_rollup_daily|v_usage_rollup_current)\b/)
    expect(usage).not.toContain('v_finance_bill_chargeback')
    expect(coverage).toMatch(/\b(usage_rollup_daily|v_usage_rollup_current)\b/)
    expect(coverage).not.toMatch(/v_finance_/)
    expect(coverage).not.toContain('attribution_record')
    expect(coverage).not.toContain('attribution_aggregate')
    expect(drivers).toMatch(/\b(usage_rollup_daily|v_usage_rollup_current)\b/)
    expect(drivers).not.toMatch(/v_finance_/)
    expect(bill).toContain('v_finance_bill_chargeback')
    expect(bill).not.toContain('v_complete_usage')
    expect(bill).not.toContain('usage_rollup_daily')
    expect(bill).not.toContain('v_usage_rollup_current')
  })
})
