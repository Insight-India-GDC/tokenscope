// @vitest-environment node
/*
 * Copilot §B chargeback LANE SPLIT (copilot-surface-lanes design D2/D5, mig 0085) —
 * real-Postgres invariants over the deployed views + the real reporting functions:
 *
 *   (1) C2 lanes-vs-columns identity: v_finance_copilot_pool_chargeback emits one row
 *       per lane per (cou, month) — copilot-license ← license_net, copilot-usage ←
 *       overage_net, copilot-unclassified ← unclassified_net — and Σ(license+usage
 *       lanes) == the pre-split single-lane total (the old view formula).
 *   (2) pg_get_viewdef SHAPE (r1-F7, mechanical §A/§B enforcement): no user/teammate
 *       column anywhere in v_finance_copilot_pool_chargeback, and 'copilot-cli'
 *       appears in the chargeback views ONLY inside §A-exclusion predicates.
 *   (3) Per-§B-site NON-ZERO-charge regression (r1-F4 — the empty-aggregate failure
 *       mode is silent): a fixture CoU with license 200 + usage 100 (+ unclassified
 *       55) shows a NON-ZERO Copilot charge post-split in the finance, across-regions,
 *       regional and cost-centres outputs.
 *   (4) copilot-unclassified is VISIBLE everywhere but NEVER in a chargeableUsd —
 *       even in chargeback mode (design D2, r1-F10).
 *   (5) Workstream C (ADR-0011 D10, migration 0107): the persisted overage allocation
 *       REPLACES the org-homed copilot-usage figure for an (enterprise, month) once
 *       computed — never both (no double charge), same total either way; license and
 *       unclassified are untouched.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { randomUUID } from 'node:crypto'
import { sql, type SQL } from 'drizzle-orm'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'
import { buildUsageRollup } from '../helpers/usage-rollup'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import {
  fetchFinanceBillCheck,
  fetchFinanceCous,
  fetchFinanceExemptGap,
  fetchCopilotPool,
  financeLedgerToCsv,
} from '../../../server/reporting/finance'
import {
  fetchAcrossKpis,
  fetchAcrossRegionCards,
  fetchAcrossChargebackByRegion,
} from '../../../server/reporting/across-regions'
import {
  fetchRegionalKpis,
  fetchRegionalChargebackByCostCentre,
  type RegionalScope,
} from '../../../server/reporting/regional'
import { fetchCostCentreCards, type CostCentreRef } from '../../../server/reporting/cost-centres'
import { GITHUB_ALL_CHARGEBACK_LANES } from '../../../shared/usage/github-surface'

type Tx = PostgresJsDatabase<Record<string, unknown>>

let t: TestDb
let tx: Tx
let regionId = ''
let ccA = ''

const NOW = new Date('2026-06-10T12:00:00.000Z')
const WIN = { startIso: '2026-05-01T00:00:00.000Z', endIso: '2026-06-01T00:00:00.000Z' }
const MONTH = '2026-05-01'

/* Fixture: anthropic 50 (claude-code actual_spend) + a pooled Copilot bill with
 * license 200, overage 100, unclassified 55 — all homed to ccA. Expected:
 * copilot display 355, copilot CHARGEABLE 300, chargeable-with-anthropic 350. */
beforeAll(async () => {
  t = await startTestDb()
  tx = t.db as unknown as Tx
  const [r] = await t.client<{ id: string }[]>`
    INSERT INTO region (code, display_name) VALUES ('cl', 'CL') RETURNING id::text AS id`
  regionId = r!.id
  const [ou] = await t.client<{ id: string }[]>`
    INSERT INTO org_unit (region_id, path, code, display_name, unit_type, is_cost_owning_unit)
    VALUES (${regionId}::uuid, 'cla', 'cla', 'Lane BU', 'bu', TRUE) RETURNING id::text AS id`
  ccA = ou!.id

  const [tm] = await t.client<{ id: string }[]>`
    INSERT INTO teammate (entra_oid, email, region_id, org_unit_id, role)
    VALUES (${'oid-cl-' + randomUUID().slice(0, 8)}, 'lane.a@example.com', ${regionId}::uuid, ${ccA}::uuid, 'developer')
    RETURNING id::text AS id`
  await t.client`
    INSERT INTO actual_spend (teammate_id, date, tool, input_tokens, output_tokens, cost_usd, source)
    VALUES (${tm!.id}::uuid, '2026-05-10'::date, 'claude-code', 100, 100, 50, 'anthropic-analytics-api')`
  // A dab of §A usage so the region has an Across region CARD (cards drive off
  // v_complete_usage; the charge columns join onto them).
  await t.client`
    INSERT INTO instance_attestation (instance_id, principal_oid, teammate_id, tool, region_id, org_unit_id, project_code_hash, raw_project_code)
    VALUES (gen_random_uuid(), 'p', ${tm!.id}::uuid, 'claude-code', ${regionId}::uuid, ${ccA}::uuid, 'h', 'P')`
  const [inst] = await t.client<{ id: string }[]>`
    SELECT instance_id::text AS id FROM instance_attestation WHERE teammate_id=${tm!.id}::uuid LIMIT 1`
  await t.client`
    INSERT INTO attribution_record
      (instance_id, teammate_id, region_id, org_unit_id, cost_owning_unit_id, project_id, tool, model, token_type, tokens, cost_usd, fidelity_tier, cost_basis, ts_event, claude_session_id)
    VALUES (${inst!.id}::uuid, ${tm!.id}::uuid, ${regionId}::uuid, ${ccA}::uuid, ${ccA}::uuid, NULL::uuid,
            'claude-code', 'claude-sonnet-4-6', 'input', 1000, 5, 'tier-1', 'estimated',
            '2026-05-10T00:00:00Z'::timestamptz, 'conv-lane-a')`

  const [ent] = await t.client<{ id: string }[]>`
    INSERT INTO provider_enterprise (provider, external_id, display_name)
    VALUES ('github', 'lane-ent', 'Lane Ent') RETURNING id::text AS id`
  const [po] = await t.client<{ id: string }[]>`
    INSERT INTO provider_org (provider, external_org_id, display_name, provider_enterprise_id, cost_owning_unit_id)
    VALUES ('github', 'lane-org', 'Lane Org', ${ent!.id}::uuid, ${ccA}::uuid) RETURNING id::text AS id`
  await t.client`
    INSERT INTO copilot_pool_bill
      (month, provider_enterprise_id, provider_org_id, cost_owning_unit_id, seats,
       license_net_usd, overage_net_usd, unclassified_net_usd, included_allowance_usd, usage_gross_usd)
    VALUES (${MONTH}::date, ${ent!.id}::uuid, ${po!.id}::uuid, ${ccA}::uuid, 5, 200, 100, 55, 400, 350)`
  // The §A side of the region-card fetchers reads usage_rollup_daily (design
  // R5) — materialise the seeded lane before any fetcher runs. Group (3)'s
  // nested seeds are §B-only, so one build here covers the file.
  await buildUsageRollup(t.db)
}, 180_000)

afterAll(async () => {
  await stopTestDb(t)
})

/** Whole-scope RegionalScope stub — we assert the query math, not the RBAC clamp
 * (which resolveRegionalScope's own suite covers). */
function wholeScope(): RegionalScope {
  const truthy = (): SQL => sql`TRUE`
  return {
    effectiveRegionId: regionId,
    region: { id: regionId, code: 'cl', displayName: 'CL' },
    regionOptions: [],
    isCrossRegion: true,
    ou: null,
    usageScope: truthy,
    financeScope: truthy,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
describe('(1) C2 — lanes vs columns identity on the deployed view', () => {
  it('one row per §B lane per (cou, month), each equal to its column', async () => {
    const rows = await t.client<{ tool: string; charge: string; cou: string | null }[]>`
      SELECT tool, charge_usd::text AS charge, cost_owning_unit_id::text AS cou
      FROM v_finance_copilot_pool_chargeback WHERE period_month = ${MONTH}::date ORDER BY tool`
    expect(rows.map((r) => [r.tool, Number(r.charge)])).toEqual([
      ['copilot-license', 200],
      ['copilot-unclassified', 55],
      ['copilot-usage', 100],
    ])
    for (const r of rows) expect(r.cou).toBe(ccA)
  })

  it('Σ(license + usage lanes) == the pre-split single-lane total (old view formula)', async () => {
    // The 0081 view emitted COALESCE(license,0) + COALESCE(overage,0) as ONE row.
    const [{ old_total }] = await t.client<{ old_total: string }[]>`
      SELECT SUM(COALESCE(license_net_usd, 0) + COALESCE(overage_net_usd, 0))::text AS old_total
      FROM copilot_pool_bill WHERE month = ${MONTH}::date`
    const [{ lanes }] = await t.client<{ lanes: string }[]>`
      SELECT COALESCE(SUM(charge_usd), 0)::text AS lanes FROM v_finance_copilot_pool_chargeback
      WHERE period_month = ${MONTH}::date AND tool IN ('copilot-license', 'copilot-usage')`
    expect(Number(lanes)).toBeCloseTo(Number(old_total), 6)
    // …and Σ all three == columns incl. unclassified (whole-truth footing).
    const [{ all3 }] = await t.client<{ all3: string }[]>`
      SELECT COALESCE(SUM(charge_usd), 0)::text AS all3 FROM v_finance_copilot_pool_chargeback
      WHERE period_month = ${MONTH}::date`
    expect(Number(all3)).toBeCloseTo(Number(old_total) + 55, 6)
  })

  it('Σ=bill still reconciles with unclassified in BOTH operands', async () => {
    const check = await fetchFinanceBillCheck(tx, WIN)
    expect(check.billUsd).toBeCloseTo(405, 6) // 50 anthropic + 355 github (incl. 55 unclassified)
    expect(check.chargebackUsd).toBeCloseTo(405, 6)
    expect(check.matched).toBe(true)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe("(2) pg_get_viewdef shape — §A/§B mechanically enforced (r1-F7)", () => {
  const viewdef = async (view: string): Promise<string> => {
    const [row] = await t.client<{ def: string }[]>`
      SELECT pg_get_viewdef(${view}::regclass, true) AS def`
    return row!.def
  }

  it('v_finance_copilot_pool_chargeback carries NO user/teammate column (pooled, never per-person)', async () => {
    const def = await viewdef('v_finance_copilot_pool_chargeback')
    expect(def).not.toMatch(/teammate/i)
    expect(def).not.toMatch(/\buser_/i)
    expect(def).not.toMatch(/actual_spend|attribution_record/i) // pooled bill table only
  })

  const CHARGEBACK_VIEWS = [
    'v_finance_bill_chargeback',
    'v_finance_chargeback_month',
    'v_finance_bill_totals_month',
    'v_finance_copilot_pool_chargeback',
  ] as const

  it.each(['copilot-cli', 'copilot-agent'])(
    "'%s' appears in the chargeback views ONLY inside exclusion predicates (unified firewall)",
    async (literal) => {
      let occurrences = 0
      for (const view of CHARGEBACK_VIEWS) {
        const def = await viewdef(view)
        const token = `'${literal}'`
        let idx = def.indexOf(token)
        while (idx !== -1) {
          occurrences += 1
          const before = def.slice(0, idx)
          // Every occurrence must be an EXCLUSION: either the right-hand side of a
          // `<>`, or a member of a `NOT IN (...)` list (which pg_get_viewdef renders
          // as `<> ALL (ARRAY[...])`) — never an emission (`AS tool`) or an
          // inclusion filter.
          const isExclusion = /<>\s*$/.test(before) || /<>\s*ALL\s*\(\s*ARRAY\s*\[[^\]]*$/.test(before)
          expect(
            isExclusion,
            `${token} in ${view} at index ${idx} must be inside an exclusion predicate`,
          ).toBe(true)
          idx = def.indexOf(token, idx + token.length)
        }
      }
      // Non-vacuous: the unified firewall (mig 0085) puts BOTH §A tool literals in the
      // exclusion lists, so each must actually appear somewhere across the views.
      expect(occurrences, `'${literal}' must appear in at least one firewall predicate`).toBeGreaterThan(0)
    },
  )

  it('the §B lane ids the view emits are exactly the registry chargeback lanes', async () => {
    const def = await viewdef('v_finance_copilot_pool_chargeback')
    for (const lane of GITHUB_ALL_CHARGEBACK_LANES) expect(def).toContain(`'${lane}'`)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('(3) per-§B-site NON-ZERO Copilot charge post-split (r1-F4)', () => {
  it('finance: fetchFinanceCous shows the three lanes; chargeable NEVER includes unclassified', async () => {
    const off = await fetchFinanceCous(tx, WIN, { copilotChargeback: false })
    const on = await fetchFinanceCous(tx, WIN, { copilotChargeback: true })
    const rowOff = off.find((c) => c.couId === ccA)!
    const rowOn = on.find((c) => c.couId === ccA)!

    // Display figure = Σ all three lanes (whole-truth), NON-ZERO post-split.
    expect(rowOff.copilotUsd).toBeCloseTo(355, 6)
    expect(rowOff.copilotPending).toBe(true)
    expect(rowOff.chargeableUsd).toBeCloseTo(50, 6) // anthropic only while pending

    // Chargeback mode folds license+usage ONLY — 55 unclassified never charges (D2).
    expect(rowOn.copilotPending).toBe(false)
    expect(rowOn.chargeableUsd).toBeCloseTo(350, 6) // 50 + 200 + 100, NOT 405

    // The per-surface lanes carry all three, labelled, in registry order.
    const laneIds = rowOn.lanes.map((l) => l.lane)
    expect(laneIds).toContain('copilot-license')
    expect(laneIds).toContain('copilot-usage')
    expect(laneIds).toContain('copilot-unclassified')
    const byLane = new Map(rowOn.lanes.map((l) => [l.lane, l.usd]))
    expect(byLane.get('copilot-license')).toBeCloseTo(200, 6)
    expect(byLane.get('copilot-usage')).toBeCloseTo(100, 6)
    expect(byLane.get('copilot-unclassified')).toBeCloseTo(55, 6)
  })

  it('finance: fetchFinanceBillCheck carries the per-lane split; exempt-gap caption is whole-truth', async () => {
    const check = await fetchFinanceBillCheck(tx, WIN)
    expect(check.copilotChargebackUsd).toBeCloseTo(355, 6)
    expect(check.copilotLanes.map((l) => [l.lane, l.usd])).toEqual([
      ['copilot-license', 200],
      ['copilot-usage', 100],
      ['copilot-unclassified', 55],
    ])
    const gap = await fetchFinanceExemptGap(tx, WIN)
    expect(gap.copilotChargebackUsd).toBeCloseTo(355, 6)
  })

  it('finance: fetchCopilotPool surfaces unclassified on lines + utilisation, outside netUsd', async () => {
    const pool = await fetchCopilotPool(tx, ccA, WIN)
    expect(pool.licenseNetUsd).toBeCloseTo(200, 6)
    expect(pool.overageNetUsd).toBeCloseTo(100, 6)
    expect(pool.unclassifiedNetUsd).toBeCloseTo(55, 6)
    expect(pool.utilisation.unclassifiedNetUsd).toBeCloseTo(55, 6)
    const [line] = pool.lines
    expect(line!.unclassifiedUsd).toBeCloseTo(55, 6)
    expect(line!.netUsd).toBeCloseTo(300, 6) // chargeable net EXCLUDES unclassified
  })

  it('finance: the ledger CSV emits one github row per lane, `lane` APPENDED as the LAST column; unclassified is ALWAYS pending', async () => {
    const check = await fetchFinanceBillCheck(tx, WIN)
    const cous = await fetchFinanceCous(tx, WIN, { copilotChargeback: true })
    const csv = financeLedgerToCsv(cous, {
      month: '2026-05',
      asOfDate: null,
      anthropicState: 'settling',
      githubState: 'settling',
      check,
    })
    // Additive-only column convention (r1 finding 4): the pre-split columns keep their
    // positions for index-based consumers; the new `lane` column sits at the END.
    expect(csv.split('\n')[1]).toBe(
      'cost_centre,region,provider,month,charge_usd,chargeback_pending,settling_state,lane',
    )
    expect(csv).toContain('Lane BU,cl,anthropic,2026-05,50.00,false,settling,')
    expect(csv).toContain('Lane BU,cl,github,2026-05,200.00,false,settling,copilot-license')
    expect(csv).toContain('Lane BU,cl,github,2026-05,100.00,false,settling,copilot-usage')
    // Even in chargeback mode the unclassified lane row is pending=true (never x-charge).
    expect(csv).toContain('Lane BU,cl,github,2026-05,55.00,true,settling,copilot-unclassified')
  })

  it('across-regions: KPIs + region cards + chargeback-by-region fold license+usage, never unclassified', async () => {
    const kpis = await fetchAcrossKpis(tx, WIN, { copilotChargeback: true, momMonthRange: null, now: NOW })
    expect(kpis.copilotChargeableUsd).toBeCloseTo(300, 6) // NON-ZERO post-split; no 55
    expect(kpis.chargeableUsd).toBeCloseTo(350, 6)

    const cards = await fetchAcrossRegionCards(tx, WIN, { copilotChargeback: true })
    const card = cards.find((c) => c.regionId === regionId)!
    expect(card.copilotChargeableUsd).toBeCloseTo(300, 6)
    expect(card.chargeableUsd).toBeCloseTo(350, 6)

    const byRegion = await fetchAcrossChargebackByRegion(tx, WIN, { copilotChargeback: true })
    expect(byRegion.reduce((a, r) => a + r.chargeableUsd, 0)).toBeCloseTo(350, 6)
  })

  it('regional: KPIs + chargeback-by-cost-centre fold license+usage, never unclassified', async () => {
    const scope = wholeScope()
    const kpis = await fetchRegionalKpis(tx, scope, WIN, { copilotChargeback: true, momMonthRange: null, now: NOW })
    expect(kpis.copilotChargeableUsd).toBeCloseTo(300, 6)
    expect(kpis.chargeableUsd).toBeCloseTo(350, 6)

    const ranked = await fetchRegionalChargebackByCostCentre(tx, scope, WIN, { copilotChargeback: true })
    expect(ranked.reduce((a, r) => a + r.value, 0)).toBeCloseTo(350, 6)
  })

  it('cost-centres: card chargeUsd folds license+usage, never unclassified', async () => {
    const refs: CostCentreRef[] = [
      { id: ccA, code: 'cla', displayName: 'Lane BU', regionId, regionCode: 'cl' },
    ]
    const { cards, copilotChargebackPartialMonth } = await fetchCostCentreCards(
      tx,
      refs,
      WIN,
      { month: '2026-05', now: NOW },
      { copilotChargeback: true },
    )
    expect(copilotChargebackPartialMonth).toBe(false)
    expect(cards[0]!.chargeUsd).toBeCloseTo(350, 6) // 50 anthropic + 300 chargeable copilot
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('(5) Workstream C — persisted allocation replaces the org-homed copilot-usage lane, never both (no double charge)', () => {
  const ENT2 = 'lane-ent-alloc'
  const MONTH2 = '2026-07-01'
  let ent2Id = ''
  let ccB = ''

  beforeAll(async () => {
    const [ou] = await t.client<{ id: string }[]>`
      INSERT INTO org_unit (region_id, path, code, display_name, unit_type, is_cost_owning_unit)
      VALUES (${regionId}::uuid, 'clb', 'clb', 'Lane BU B', 'bu', TRUE) RETURNING id::text AS id`
    ccB = ou!.id
    const [ent] = await t.client<{ id: string }[]>`
      INSERT INTO provider_enterprise (provider, external_id, display_name)
      VALUES ('github', ${ENT2}, 'Lane Ent Alloc') RETURNING id::text AS id`
    ent2Id = ent!.id
    const [po] = await t.client<{ id: string }[]>`
      INSERT INTO provider_org (provider, external_org_id, display_name, provider_enterprise_id, cost_owning_unit_id)
      VALUES ('github', 'lane-org-alloc', 'Lane Org Alloc', ${ent2Id}::uuid, ${ccA}::uuid) RETURNING id::text AS id`
    // The bill homes this org's overage to ccA — the org-homed baseline every OTHER
    // test in this file exercises.
    await t.client`
      INSERT INTO copilot_pool_bill
        (month, provider_enterprise_id, provider_org_id, cost_owning_unit_id, seats,
         license_net_usd, overage_net_usd, unclassified_net_usd, included_allowance_usd, usage_gross_usd)
      VALUES (${MONTH2}::date, ${ent2Id}::uuid, ${po!.id}::uuid, ${ccA}::uuid, 5, 200, 100, 0, 400, 350)`
  })

  async function copilotUsageByCou(): Promise<Record<string, number>> {
    const rows = await t.client<{ cou: string | null; usd: string }[]>`
      SELECT cost_owning_unit_id::text AS cou, charge_usd::text AS usd FROM v_finance_copilot_pool_chargeback
      WHERE period_month = ${MONTH2}::date AND tool = 'copilot-usage'`
    const out: Record<string, number> = {}
    for (const r of rows) out[r.cou ?? '__null'] = Number(r.usd)
    return out
  }

  it('before any allocation: copilot-usage is the org-homed figure at ccA', async () => {
    const byCou = await copilotUsageByCou()
    expect(byCou[ccA]).toBe(100)
    expect(Object.values(byCou).reduce((a, b) => a + b, 0)).toBe(100)
  })

  it('once an allocation exists (redirecting the SAME overage to ccB), the org-homed figure at ccA disappears — not both', async () => {
    await t.client`
      INSERT INTO copilot_overage_allocation
        (provider_enterprise_id, month, cost_owning_unit_id, policy, weight, allocated_usd, overage_net_usd)
      VALUES (${ent2Id}::uuid, ${MONTH2}::date, ${ccB}::uuid, 'consumption-share', 1, 100, 100)`

    const byCou = await copilotUsageByCou()
    // The org-homed ccA figure is GONE (superseded), not summed alongside the allocation.
    expect(byCou[ccA] ?? 0).toBe(0)
    expect(byCou[ccB]).toBe(100)
    // SAME TOTAL either way — allocation redistributes, never creates or drops money.
    expect(Object.values(byCou).reduce((a, b) => a + b, 0)).toBe(100)
  })

  it('license (200) is untouched by the allocation — still org-homed at ccA', async () => {
    const [row] = await t.client<{ usd: string }[]>`
      SELECT charge_usd::text AS usd FROM v_finance_copilot_pool_chargeback
      WHERE period_month = ${MONTH2}::date AND tool = 'copilot-license' AND cost_owning_unit_id = ${ccA}::uuid`
    expect(Number(row!.usd)).toBe(200)
  })
})
