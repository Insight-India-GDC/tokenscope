// @vitest-environment node
/*
 * Intent: reporting-consolidation build-design §7 Wave-0 correctness invariants for the POOLED
 * Copilot chargeback (docs/design/provider-billing-attribution-model.md §B). Executable against
 * real Postgres (testcontainers). Covers:
 *
 *  (1) Σ v_finance_chargeback_month (incl. NULL-CoU + unallocated residual) = Σ
 *      v_finance_bill_totals_month, with the Copilot term sourced SOLELY from copilot_pool_bill
 *      and copilot ABSENT from every actual_spend-rooted chargeback operand.
 *  (2) Exempt org in the bill report → ZERO copilot_pool_bill rows, yet non-zero indicative
 *      usage-lane rows (v_teammate_usage_daily copilot branch).
 *  (3) Missing SKU line → no license row (NULL) + alert emitted + month reports unsettled +
 *      flat_seat_price_usd never feeds a chargeback figure (grep + seeded).
 *  (4) Bill-read fidelity: worker license/overage/included EXACTLY equal the seeded report's
 *      net/net/discount under a MID-MONTH SEAT-CHANGE fixture (the recomputation-divergence case).
 *  (5) source='copilot-overage' rows deleted; v_teammate_usage_daily unaffected.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'
import * as schema from '../../../drizzle/schema'
import {
  runCopilotPoolBill,
  aggregateOrgBill,
  copilotRawNetUsd,
  type BillingReportClient,
} from '../../../server/workers/copilot-pool-bill'
import { BillingUsageReportSchema } from '../../../server/reconciliation/adapters/github-client'
import type { GithubBillingUsageItem, GithubBillingUsageReport } from '../../../server/reconciliation/adapters/github-client'

let t: TestDb
let regionId = ''
let couA = ''
let couB = ''
let entId = ''
let orgAcme = ''
let orgGamma = ''
const ENT = 'ts-pool-ent'
const NOW = new Date('2026-06-15T09:00:00.000Z')
const MONTH = '2026-06-01'

/* Build one billing-report usage item (the enhanced-billing shape). */
function item(
  org: string | null,
  sku: string,
  opts: { gross?: number; discount?: number; net?: number; quantity?: number; product?: string },
): GithubBillingUsageItem {
  return {
    date: '2026-06-10',
    product: opts.product ?? 'Copilot',
    sku,
    quantity: opts.quantity ?? 0,
    unitType: '',
    pricePerUnit: 0,
    grossAmount: opts.gross ?? 0,
    discountAmount: opts.discount ?? 0,
    netAmount: opts.net ?? 0,
    organizationName: org,
    repositoryName: null,
  }
}
const LICENSE = 'Copilot Enterprise'
const CREDITS = 'Copilot AI Credits'

/** A stub billing client returning a fixed report regardless of (year, month). */
function stub(report: GithubBillingUsageReport): BillingReportClient {
  return { getEnterpriseBillingUsage: async () => report }
}

async function mkCou(code: string, path: string): Promise<string> {
  const [ou] = await t.db
    .insert(schema.orgUnit)
    .values({ regionId, path, code, displayName: code, unitType: 'bu', isCostOwningUnit: true })
    .returning({ id: schema.orgUnit.id })
  return ou!.id
}

async function mkOrg(externalOrgId: string, couId: string | null, displayName?: string): Promise<string> {
  const [po] = await t.db
    .insert(schema.providerOrg)
    .values({
      provider: 'github',
      externalOrgId,
      displayName: displayName ?? externalOrgId,
      reconciliationMode: 'reconciled',
      providerEnterpriseId: entId,
      costOwningUnitId: couId,
    })
    .returning({ id: schema.providerOrg.id })
  return po!.id
}

async function mkTeammate(orgUnitId: string, role = 'developer'): Promise<string> {
  const [tm] = await t.db
    .insert(schema.teammate)
    .values({
      entraOid: `oid-pb-${randomUUID().slice(0, 8)}`,
      email: `pb.${randomUUID().slice(0, 8)}@example.com`,
      regionId,
      orgUnitId,
      role,
    })
    .returning({ id: schema.teammate.id })
  return tm!.id
}

async function sumChargebackMonth(): Promise<number> {
  const [r] = await t.client<{ s: string }[]>`
    SELECT COALESCE(SUM(charge_usd), 0)::text AS s FROM v_finance_chargeback_month WHERE period_month = ${MONTH}::date`
  return Number(r!.s)
}
async function sumBillTotals(): Promise<number> {
  const [r] = await t.client<{ s: string }[]>`
    SELECT COALESCE(SUM(bill_usd), 0)::text AS s FROM v_finance_bill_totals_month WHERE period_month = ${MONTH}::date`
  return Number(r!.s)
}

beforeAll(async () => {
  t = await startTestDb()
  const [r] = await t.db.insert(schema.region).values({ code: 'pb', displayName: 'PB' }).returning()
  regionId = r!.id
  couA = await mkCou('pb-a', 'pba')
  couB = await mkCou('pb-b', 'pbb')
  const [ent] = await t.db
    .insert(schema.providerEnterprise)
    .values({ provider: 'github', externalId: ENT, displayName: ENT, reconciliationMode: 'reconciled' })
    .returning({ id: schema.providerEnterprise.id })
  entId = ent!.id
  orgAcme = await mkOrg('acme', couA)
  await mkOrg('beta', couB)
  await mkOrg('lonely', null) // registered but no CoU → visible unallocated
  await mkOrg('partner-demo', couA) // exempt-by-name → never written
  // Login 'gamma' but a DISTINCT display name — the MEDIUM-2 display-name-match fixture.
  orgGamma = await mkOrg('gamma', couB, 'Gamma Display')
  // A platform-admin recipient so the unsettled alert has somewhere to route.
  await mkTeammate(couA, 'platform-admin')
}, 180_000)

afterAll(async () => {
  if (t) await stopTestDb(t)
}, 30_000)

beforeEach(async () => {
  await t.client`DELETE FROM copilot_pool_bill`
  await t.client`DELETE FROM actual_spend`
  await t.client`DELETE FROM inbox_item`
  await t.client`DELETE FROM reconciliation_record`
})

describe('copilot-pool-bill Wave-0 invariants', () => {
  it('(1) Σ chargeback_month = Σ bill_totals_month; copilot solely from copilot_pool_bill; copilot absent from actual_spend chargeback', async () => {
    // Anthropic bill (chargeable) homed to couA + a per-seat COPILOT actual_spend row that must
    // NOT enter any chargeback operand.
    const tmA = await mkTeammate(couA)
    await t.db.insert(schema.actualSpend).values({ teammateId: tmA, date: '2026-06-10', tool: 'claude-code', inputTokens: 0n, outputTokens: 0n, costUsd: '123.45', source: 'anthropic-analytics-api' })
    await t.db.insert(schema.actualSpend).values({ teammateId: tmA, date: '2026-06-01', tool: 'copilot-cli', inputTokens: 0n, outputTokens: 0n, costUsd: '39.00', source: 'copilot-seat:acme' })

    const report: GithubBillingUsageReport = {
      usageItems: [
        item('acme', LICENSE, { net: 4000, quantity: 100 }),
        item('acme', CREDITS, { gross: 5000, discount: 5000, net: 0 }), // pool covered → net 0
        item('beta', LICENSE, { net: 2000, quantity: 50 }),
        item('beta', CREDITS, { gross: 800, discount: 500, net: 300 }), // paid overage 300
        item('lonely', LICENSE, { net: 1000, quantity: 25 }),
        item('lonely', CREDITS, { gross: 200, discount: 100, net: 100 }),
        item('partner-demo', LICENSE, { net: 999, quantity: 30 }), // EXEMPT — never written
        item(null, CREDITS, { gross: 60, discount: 10, net: 50 }), // org-less → residual
      ],
    }
    const res = await runCopilotPoolBill(t.db, { now: NOW, monthsBack: 0, clientOverride: stub(report) })
    expect(res.orgRowsWritten).toBe(3) // acme, beta, lonely (partner-demo skipped)
    expect(res.residualRowsWritten).toBe(1)
    expect(res.orgsExemptSkipped).toBe(1)

    // partner-demo (exempt) is NOT in copilot_pool_bill.
    const [{ n }] = await t.client<{ n: string }[]>`
      SELECT count(*)::text AS n FROM copilot_pool_bill cpb
      JOIN provider_org po ON po.id = cpb.provider_org_id
      WHERE po.external_org_id = 'partner-demo'`
    expect(Number(n)).toBe(0)

    // Copilot chargeback term = pool net only: 4000 + 2300 + 1100(lonely) + 50(residual) = 7450.
    // (mig 0085: the copilot arm emits the three §B LANE IDS, never 'copilot-cli'.)
    const [{ c }] = await t.client<{ c: string }[]>`
      SELECT COALESCE(SUM(charge_usd),0)::text AS c FROM v_finance_chargeback_month
      WHERE period_month = ${MONTH}::date
        AND tool IN ('copilot-license', 'copilot-usage', 'copilot-unclassified')`
    expect(Number(c)).toBe(7450) // NOT 7450 + 39 (the copilot-seat actual_spend row is excluded)

    // NULL-CoU bucket: 'lonely' license 1000 (unmapped org, unaffected by allocation) + the
    // WHOLE enterprise-month's overage (beta 300 + lonely 100 + residual 50 = 450). Workstream C:
    // this fixture seeds no reconciliation_record usage, so the overage allocation (ADR-0011
    // D10, default consumption-share) finds zero attributable weight and routes the entire
    // overage to the explicit unallocated bucket — replacing the org-homed breakdown that used
    // to leave beta's 300 at couB. Total conservation (Σ allocations == overage net) is asserted
    // separately by server/governance/copilot-overage-allocation.ts; see the dedicated
    // integration tests in tests/integration/governance/copilot-overage-allocation.test.ts.
    const [{ nullcou }] = await t.client<{ nullcou: string }[]>`
      SELECT COALESCE(SUM(charge_usd),0)::text AS nullcou FROM v_finance_chargeback_month
      WHERE period_month = ${MONTH}::date AND cost_owning_unit_id IS NULL`
    expect(Number(nullcou)).toBe(1450)

    // The bill_totals Copilot term comes ONLY from copilot_pool_bill.
    const [{ gh }] = await t.client<{ gh: string }[]>`
      SELECT bill_usd::text AS gh FROM v_finance_bill_totals_month WHERE period_month = ${MONTH}::date AND provider = 'github'`
    expect(Number(gh)).toBe(7450)

    // THE INVARIANT: Σ chargeback_month == Σ bill_totals_month (= 123.45 anthropic + 7450 copilot).
    const cb = await sumChargebackMonth()
    const bt = await sumBillTotals()
    expect(cb).toBeCloseTo(7573.45, 4)
    expect(bt).toBeCloseTo(7573.45, 4)
    expect(cb).toBeCloseTo(bt, 6)

    // Copilot is ABSENT from the actual_spend-rooted chargeback lane (the copilot-seat row).
    const [{ copcb }] = await t.client<{ copcb: string }[]>`
      SELECT COALESCE(SUM(bill_usd),0)::text AS copcb FROM v_finance_bill_chargeback WHERE tool = 'copilot-cli'`
    expect(Number(copcb)).toBe(0)
  })

  it('(2) exempt org in the report → ZERO copilot_pool_bill rows, yet non-zero indicative usage-lane rows', async () => {
    // A teammate seated in the exempt org, with per-user gross usage in reconciliation_record.
    const tmD = await mkTeammate(couA)
    await t.db.insert(schema.reconciliationRecord).values({
      teammateId: tmD, provider: 'github', enterpriseRef: ENT, licenseOrg: 'partner-demo',
      periodDate: '2026-06-10', category: 'copilot_interactive', scope: 'teammate',
      actualUsd: '50', otelAttributedUsd: '0', deltaUsd: '50', spendClass: 'indicative',
      disposition: 'under', status: 'proposed',
    })
    const report: GithubBillingUsageReport = {
      usageItems: [item('partner-demo', LICENSE, { net: 999, quantity: 30 }), item('partner-demo', CREDITS, { gross: 60, net: 0, discount: 60 })],
    }
    const res = await runCopilotPoolBill(t.db, { now: NOW, monthsBack: 0, clientOverride: stub(report) })
    expect(res.orgsExemptSkipped).toBe(1)
    expect(res.orgRowsWritten).toBe(0)
    expect(res.residualRowsWritten).toBe(0)

    const [{ n }] = await t.client<{ n: string }[]>`SELECT count(*)::text AS n FROM copilot_pool_bill`
    expect(Number(n)).toBe(0) // exempt org: never written

    // But the usage lane DOES surface the exempt org's usage (indicative), never $0-hidden.
    const [{ usd }] = await t.client<{ usd: string }[]>`
      SELECT COALESCE(SUM(usage_usd),0)::text AS usd FROM v_teammate_usage_daily
      WHERE teammate_id = ${tmD}::uuid AND tool = 'copilot-cli'`
    expect(Number(usd)).toBe(50)
  })

  it('(3) missing SKU line → NULL license, alert emitted, month unsettled, flat rate never charged', async () => {
    // Configure a flat seat price on the enterprise — it must NEVER become a chargeback figure.
    await t.client`UPDATE provider_enterprise SET flat_seat_price_usd = 39 WHERE external_id = ${ENT}`
    const report: GithubBillingUsageReport = {
      // acme has usage/overage but NO "Copilot Enterprise" license line.
      usageItems: [item('acme', CREDITS, { gross: 500, discount: 200, net: 300 })],
    }
    const res = await runCopilotPoolBill(t.db, { now: NOW, monthsBack: 0, clientOverride: stub(report) })
    expect(res.unsettledOrgMonths).toBe(1)
    expect(res.alertsEmitted).toBe(1)

    const [row] = await t.client<{ license: string | null; overage: string; gross: string }[]>`
      SELECT license_net_usd::text AS license, overage_net_usd::text AS overage, usage_gross_usd::text AS gross
      FROM copilot_pool_bill WHERE provider_org_id = ${orgAcme}::uuid`
    expect(row!.license).toBeNull() // NO license row (never a flat-rate fallback)
    expect(Number(row!.overage)).toBe(300)

    // An alert was raised.
    const [{ n }] = await t.client<{ n: string }[]>`
      SELECT count(*)::text AS n FROM inbox_item WHERE category = 'copilot-bill-unsettled'`
    expect(Number(n)).toBe(1)

    // The month reports UNSETTLED on the bill-totals check.
    const [{ unsettled }] = await t.client<{ unsettled: boolean }[]>`
      SELECT unsettled FROM v_finance_bill_totals_month WHERE period_month = ${MONTH}::date AND provider = 'github'`
    expect(unsettled).toBe(true)

    // The chargeback figure for the month's Copilot lanes is the OVERAGE ONLY (300) — NOT 39
    // (flat) or 339. Checked ENTERPRISE-WIDE (not scoped to couA): this fixture seeds no
    // reconciliation_record usage, so the overage allocation (ADR-0011 D10) finds zero
    // attributable weight and routes the 300 to the unallocated bucket rather than couA — the
    // homing changed, but the invariant this test exists to pin (no flat-rate leak; the money
    // sits on copilot-usage, not copilot-license) is unaffected and CoU-independent.
    // (mig 0085 lane split: the money sits on the copilot-usage lane.)
    const [{ charge }] = await t.client<{ charge: string }[]>`
      SELECT COALESCE(SUM(charge_usd),0)::text AS charge FROM v_finance_chargeback_month
      WHERE period_month = ${MONTH}::date
        AND tool IN ('copilot-license', 'copilot-usage', 'copilot-unclassified')`
    expect(Number(charge)).toBe(300)
    const [{ usage_lane }] = await t.client<{ usage_lane: string }[]>`
      SELECT COALESCE(SUM(charge_usd),0)::text AS usage_lane FROM v_finance_chargeback_month
      WHERE period_month = ${MONTH}::date AND tool = 'copilot-usage'`
    expect(Number(usage_lane)).toBe(300)

    // reset the flat price so it can't leak into other tests
    await t.client`UPDATE provider_enterprise SET flat_seat_price_usd = NULL WHERE external_id = ${ENT}`
  })

  it('(3b) flat_seat_price_usd never appears in the pooled chargeback surfaces (grep)', () => {
    const here = dirname(fileURLToPath(import.meta.url))
    const worker = readFileSync(join(here, '../../../server/workers/copilot-pool-bill.ts'), 'utf8')
    const mig = readFileSync(join(here, '../../../drizzle/migrations/0081_finance_copilot_pool_chargeback_views.sql'), 'utf8')
    const mig85 = readFileSync(join(here, '../../../drizzle/migrations/0085_copilot_chargeback_lane_split.sql'), 'utf8')
    expect(worker).not.toContain('flat_seat_price')
    expect(worker).not.toContain('flatSeatPrice')
    expect(mig).not.toContain('flat_seat_price')
    expect(mig85).not.toContain('flat_seat_price')
  })

  it('(4) bill-read fidelity under a mid-month seat change: license/overage/included EXACTLY equal the bill net/net/discount', async () => {
    // A mid-month seat change → TWO subscription lines (50 seats then 60 seats), plus split
    // AI-credit lines. A seats×rate recompute (e.g. 60×39=2340) would DIVERGE from the bill.
    const midMonthItems: GithubBillingUsageItem[] = [
      item('acme', LICENSE, { net: 2000, quantity: 50 }),
      item('acme', LICENSE, { net: 2400, quantity: 60 }),
      item('acme', CREDITS, { gross: 700, discount: 400, net: 150 }),
      item('acme', CREDITS, { gross: 300, discount: 100, net: 150 }),
    ]
    // Pure aggregation (the recomputation-divergence unit case).
    const agg = aggregateOrgBill(midMonthItems)
    expect(agg.licenseNetUsd).toBe(4400) // 2000 + 2400 EXACTLY (not seats×rate)
    expect(agg.overageNetUsd).toBe(300) // 150 + 150
    expect(agg.includedAllowanceUsd).toBe(500) // 400 + 100
    expect(agg.usageGrossUsd).toBe(1000) // 700 + 300
    expect(agg.seats).toBe(60) // max seat count across lines

    // End-to-end through the worker → the persisted row equals the bill exactly.
    const res = await runCopilotPoolBill(t.db, { now: NOW, monthsBack: 0, clientOverride: stub({ usageItems: midMonthItems }) })
    expect(res.orgRowsWritten).toBe(1)
    const [row] = await t.client<{ license: string; overage: string; included: string; gross: string; seats: number }[]>`
      SELECT license_net_usd::text AS license, overage_net_usd::text AS overage,
             included_allowance_usd::text AS included, usage_gross_usd::text AS gross, seats
      FROM copilot_pool_bill WHERE provider_org_id = ${orgAcme}::uuid`
    expect(Number(row!.license)).toBe(4400)
    expect(Number(row!.overage)).toBe(300)
    expect(Number(row!.included)).toBe(500)
    expect(Number(row!.gross)).toBe(1000)
    expect(row!.seats).toBe(60)
  })

  it('(5) source=copilot-overage rows are deleted; v_teammate_usage_daily is unaffected', async () => {
    const tm = await mkTeammate(couA)
    // A legacy forecast row (the kind mig 0081 purges) + the real per-user usage in the ledger.
    await t.db.insert(schema.actualSpend).values({ teammateId: tm, date: '2026-06-10', tool: 'copilot-cli', inputTokens: 0n, outputTokens: 0n, costUsd: '999.00', source: 'copilot-overage' })
    await t.db.insert(schema.reconciliationRecord).values({
      teammateId: tm, provider: 'github', enterpriseRef: ENT, licenseOrg: 'acme',
      periodDate: '2026-06-10', category: 'copilot_interactive', scope: 'teammate',
      actualUsd: '42', otelAttributedUsd: '0', deltaUsd: '42', spendClass: 'indicative',
      disposition: 'under', status: 'proposed',
    })

    // The migration's delete statement (mig 0081): removes ONLY the forecast rows.
    await t.client`DELETE FROM actual_spend WHERE source = 'copilot-overage'`
    const [{ n }] = await t.client<{ n: string }[]>`SELECT count(*)::text AS n FROM actual_spend WHERE source = 'copilot-overage'`
    expect(Number(n)).toBe(0)

    // The usage lane (sourced from reconciliation_record, not actual_spend) is unchanged.
    const [{ usd }] = await t.client<{ usd: string }[]>`
      SELECT COALESCE(SUM(usage_usd),0)::text AS usd FROM v_teammate_usage_daily
      WHERE teammate_id = ${tm}::uuid AND tool = 'copilot-cli'`
    expect(Number(usd)).toBe(42)
  })

  it('(6) MEDIUM-2: organizationName = the DISPLAY name (not the login) homes via display_name to the right CoU', async () => {
    // The live bill uses gamma's DISPLAY name ('Gamma Display'), not its login ('gamma').
    const report: GithubBillingUsageReport = {
      usageItems: [item('Gamma Display', LICENSE, { net: 500, quantity: 10 })],
    }
    const res = await runCopilotPoolBill(t.db, { now: NOW, monthsBack: 0, clientOverride: stub(report) })
    // Matched via display_name → its OWN org row (couB), NOT folded to residual, no mismatch alert.
    expect(res.orgRowsWritten).toBe(1)
    expect(res.residualRowsWritten).toBe(0)
    expect(res.alertsEmitted).toBe(0)

    const [row] = await t.client<{ org: string; cou: string | null; license: string }[]>`
      SELECT provider_org_id::text AS org, cost_owning_unit_id::text AS cou, license_net_usd::text AS license
      FROM copilot_pool_bill`
    expect(row!.org).toBe(orgGamma) // homed to gamma via display_name
    expect(row!.cou).toBe(couB)
    expect(Number(row!.license)).toBe(500)

    // No org-name-mismatch alert (an org DID match).
    const [{ n }] = await t.client<{ n: string }[]>`
      SELECT count(*)::text AS n FROM inbox_item WHERE category = 'copilot-bill-unsettled' AND body->>'kind' = 'org-name-mismatch'`
    expect(Number(n)).toBe(0)
  })

  it('(7) MEDIUM-2: registered orgs exist but NO bill org matches any → loud org-name-mismatch alert (not a silent all-residual)', async () => {
    // A bill org that matches NO registered login OR display name → folds to residual.
    const report: GithubBillingUsageReport = {
      usageItems: [item('Totally Unknown Org', LICENSE, { net: 100, quantity: 5 })],
    }
    const res = await runCopilotPoolBill(t.db, { now: NOW, monthsBack: 0, clientOverride: stub(report) })
    expect(res.orgRowsWritten).toBe(0)
    expect(res.residualRowsWritten).toBe(1) // folded to the visible residual (never dropped)
    expect(res.alertsEmitted).toBe(1) // the mismatch signal (residual is NOT unsettled here — has license)

    const [row] = await t.client<{ kind: string; registered: string }[]>`
      SELECT body->>'kind' AS kind, body->>'registeredOrgCount' AS registered
      FROM inbox_item WHERE category = 'copilot-bill-unsettled' AND body->>'kind' = 'org-name-mismatch'`
    expect(row!.kind).toBe('org-name-mismatch')
    expect(Number(row!.registered)).toBeGreaterThan(0)
  })

  // ── D3 lane split: June-2026 SKU reality + unclassified + C1 conservation ──

  it('(10) June-2026 snake_case SKUs classify: credits/agent/premium-request → usage, copilot_enterprise → license; spark/models ignored but COUNTED', async () => {
    const items: GithubBillingUsageItem[] = [
      item('acme', 'copilot_enterprise', { net: 3900, quantity: 100, product: 'copilot' }),
      item('acme', 'copilot_ai_credits', { gross: 500, discount: 380, net: 120, product: 'copilot' }),
      item('acme', 'coding_agent_ai_credit', { gross: 90, discount: 60, net: 30, product: 'copilot' }),
      item('acme', 'copilot_premium_request', { gross: 10, net: 10, product: 'copilot' }), // legacy metered usage — never a seat
      // Non-Copilot products: excluded from Copilot's bill, counted per product.
      item('acme', 'spark_ai_credits', { net: 77, product: 'spark_ai_credits' }),
      item('acme', 'models_inference', { net: 33, product: 'models_inference' }),
    ]
    // Pure classification.
    const ignored: Record<string, number> = {}
    const agg = aggregateOrgBill(items, ignored)
    expect(agg.licenseNetUsd).toBe(3900)
    expect(agg.overageNetUsd).toBe(160) // 120 + 30 + 10
    expect(agg.unclassifiedNetUsd).toBe(0)
    expect(agg.usageGrossUsd).toBe(600)
    expect(ignored).toEqual({ spark_ai_credits: 77, models_inference: 33 })
    // C1 reference: the classified columns equal Σ raw Copilot net exactly.
    expect((agg.licenseNetUsd ?? 0) + agg.overageNetUsd + agg.unclassifiedNetUsd).toBe(copilotRawNetUsd(items))

    // End-to-end: the run result carries the ignored products KEYED per
    // (enterprise, month) — provenance, not a run-global blur (r1 finding 8).
    const res = await runCopilotPoolBill(t.db, { now: NOW, monthsBack: 0, clientOverride: stub({ usageItems: items }) })
    expect(res.orgRowsWritten).toBe(1)
    expect(res.unclassifiedOrgMonths).toBe(0)
    expect(res.ignoredProducts).toEqual({
      [`${ENT}:2026-06`]: { spark_ai_credits: 77, models_inference: 33 },
    })
    const [row] = await t.client<{ license: string; overage: string; unclassified: string }[]>`
      SELECT license_net_usd::text AS license, overage_net_usd::text AS overage, unclassified_net_usd::text AS unclassified
      FROM copilot_pool_bill WHERE provider_org_id = ${orgAcme}::uuid`
    expect(Number(row!.license)).toBe(3900)
    expect(Number(row!.overage)).toBe(160)
    expect(Number(row!.unclassified)).toBe(0)
    // spark/models never leaked into any Copilot figure: Σ github bill = 3900 + 160.
    const [{ gh }] = await t.client<{ gh: string }[]>`
      SELECT bill_usd::text AS gh FROM v_finance_bill_totals_month WHERE period_month = ${MONTH}::date AND provider = 'github'`
    expect(Number(gh)).toBe(4060)
    // No unclassified/conservation alert.
    const [{ n }] = await t.client<{ n: string }[]>`
      SELECT count(*)::text AS n FROM inbox_item WHERE category = 'copilot-bill-unclassified'`
    expect(Number(n)).toBe(0)
  })

  it('(11) a Copilot line matching NEITHER classifier → unclassified column + visible lane + idempotent alert; C1/Σ=bill still hold', async () => {
    const items: GithubBillingUsageItem[] = [
      item('acme', 'copilot_enterprise', { net: 1000, quantity: 25, product: 'copilot' }),
      item('acme', 'copilot_mystery_new_thing', { net: 55, product: 'copilot' }), // matches neither regex
    ]
    const res = await runCopilotPoolBill(t.db, { now: NOW, monthsBack: 0, clientOverride: stub({ usageItems: items }) })
    expect(res.orgRowsWritten).toBe(1)
    expect(res.unclassifiedOrgMonths).toBe(1)

    // The column + the visible copilot-unclassified lane carry the $55.
    const [row] = await t.client<{ unclassified: string }[]>`
      SELECT unclassified_net_usd::text AS unclassified FROM copilot_pool_bill WHERE provider_org_id = ${orgAcme}::uuid`
    expect(Number(row!.unclassified)).toBe(55)
    const [{ lane }] = await t.client<{ lane: string }[]>`
      SELECT charge_usd::text AS lane FROM v_finance_copilot_pool_chargeback
      WHERE period_month = ${MONTH}::date AND tool = 'copilot-unclassified' AND cost_owning_unit_id = ${couA}::uuid`
    expect(Number(lane)).toBe(55)

    // The 'copilot-bill-unclassified' alert (kind unclassified-spend) was raised — once.
    const [{ n }] = await t.client<{ n: string }[]>`
      SELECT count(*)::text AS n FROM inbox_item
      WHERE category = 'copilot-bill-unclassified' AND body->>'kind' = 'unclassified-spend'`
    expect(Number(n)).toBe(1)
    // Idempotent: a re-run counts the month again but raises no duplicate inbox item.
    const res2 = await runCopilotPoolBill(t.db, { now: NOW, monthsBack: 0, clientOverride: stub({ usageItems: items }) })
    expect(res2.unclassifiedOrgMonths).toBe(1)
    const [{ n2 }] = await t.client<{ n2: string }[]>`
      SELECT count(*)::text AS n2 FROM inbox_item
      WHERE category = 'copilot-bill-unclassified' AND body->>'kind' = 'unclassified-spend'`
    expect(Number(n2)).toBe(1)

    // Σ=bill whole-truth: the unclassified $55 is in BOTH the bill footing and the
    // chargeback view, so the identity holds (C2 + the Σ=bill check).
    const cb = await sumChargebackMonth()
    const bt = await sumBillTotals()
    expect(bt).toBeCloseTo(1055, 6)
    expect(cb).toBeCloseTo(bt, 6)
    // No conservation-violation was raised (classification conserved every dollar).
    const [{ cv }] = await t.client<{ cv: string }[]>`
      SELECT count(*)::text AS cv FROM inbox_item
      WHERE category = 'copilot-bill-unclassified' AND body->>'kind' = 'conservation-violation'`
    expect(Number(cv)).toBe(0)
  })

  it('(12) C2 lane identity: the three view lanes are exactly the three columns per (cou, month)', async () => {
    // Workstream C: the overage allocation (ADR-0011 D10, default consumption-share) needs
    // attributable usage weight, or the overage lands in the unallocated (NULL cou) bucket
    // instead of couA. Seed ONE teammate's reconciliation_record row, homed to couA under this
    // enterprise — the ONLY org/teammate with activity this month, so 100% of the weight (and
    // therefore the overage) resolves back to couA, reproducing the pre-allocation split this
    // test pins. The login is directory-bound: a self-only login would weigh as unallocated.
    const tm12 = await mkTeammate(couA)
    await t.db.insert(schema.teammateIdentityMap).values({
      teammateId: tm12, system: 'github', identifier: 'tm12-gh', identifierKind: 'username',
      enterpriseSlug: ENT, source: 'directory-sync', verifiedAt: new Date(),
    })
    await t.db.insert(schema.reconciliationRecord).values({
      raw: { login: 'tm12-gh' },
      teammateId: tm12, provider: 'github', enterpriseRef: ENT, licenseOrg: 'acme',
      periodDate: '2026-06-10', category: 'copilot_interactive', scope: 'teammate',
      costOwningUnitId: couA, providerEnterpriseId: entId,
      actualUsd: '100', otelAttributedUsd: '0', deltaUsd: '100', spendClass: 'indicative',
      disposition: 'under', status: 'applied',
    })
    const items: GithubBillingUsageItem[] = [
      item('acme', LICENSE, { net: 200, quantity: 5 }),
      item('acme', CREDITS, { gross: 300, discount: 200, net: 100 }),
      item('acme', 'copilot_mystery_new_thing', { net: 7, product: 'copilot' }),
    ]
    await runCopilotPoolBill(t.db, { now: NOW, monthsBack: 0, clientOverride: stub({ usageItems: items }) })
    const lanes = await t.client<{ tool: string; charge: string }[]>`
      SELECT tool, charge_usd::text AS charge FROM v_finance_copilot_pool_chargeback
      WHERE period_month = ${MONTH}::date AND cost_owning_unit_id = ${couA}::uuid
      ORDER BY tool`
    expect(lanes.map((l) => [l.tool, Number(l.charge)])).toEqual([
      ['copilot-license', 200],
      ['copilot-unclassified', 7],
      ['copilot-usage', 100],
    ])
    // Σ 3 lanes == the pre-split single-lane total (license + overage) + unclassified.
    const sum = lanes.reduce((a, l) => a + Number(l.charge), 0)
    expect(sum).toBe(307)
  })

  it('(13) a SKU matching BOTH classifiers books to OVERAGE — AI-credit priority is a pinned contract, not an accident of code order', () => {
    // 'copilot_enterprise_ai_credits' matches AI_CREDIT ('ai_credit') AND the anchored
    // LICENSE ('copilot_enterprise'). AI-credit is tested FIRST → overage, never a seat.
    const items: GithubBillingUsageItem[] = [
      item('acme', 'copilot_enterprise_ai_credits', { gross: 90, discount: 50, net: 40, product: 'copilot' }),
    ]
    const agg = aggregateOrgBill(items)
    expect(agg.overageNetUsd).toBe(40)
    expect(agg.licenseNetUsd).toBeNull() // no seat booked from the overlapping match
    expect(agg.unclassifiedNetUsd).toBe(0)
    expect(agg.usageGrossUsd).toBe(90)
    // C1 conservation still holds through the overlap.
    expect((agg.licenseNetUsd ?? 0) + agg.overageNetUsd + agg.unclassifiedNetUsd).toBe(copilotRawNetUsd(items))
  })

  it("(14) a license-ISH Copilot line matching NO anchored seat SKU ('Copilot seat-warmer promo') books UNCLASSIFIED, never license — the safety net catching ambiguity (r1 finding 2)", async () => {
    const items: GithubBillingUsageItem[] = [
      item('acme', 'copilot_enterprise', { net: 1000, quantity: 25, product: 'copilot' }),
      // Generic license-flavoured words ('seat', 'subscription', 'promo') must NOT
      // classify — only the documented concrete seat SKU ids do.
      item('acme', 'Copilot seat-warmer promo', { net: 20, quantity: 10, product: 'copilot' }),
      item('acme', 'premium seat subscription', { net: 5, quantity: 1, product: 'copilot' }),
    ]
    const agg = aggregateOrgBill(items)
    expect(agg.licenseNetUsd).toBe(1000) // ONLY the concrete copilot_enterprise SKU
    expect(agg.unclassifiedNetUsd).toBe(25) // 20 + 5 — visible, alerted, never charged
    expect(agg.overageNetUsd).toBe(0)

    // End-to-end: the ambiguous money reaches the unclassified column + alert, not license.
    const res = await runCopilotPoolBill(t.db, { now: NOW, monthsBack: 0, clientOverride: stub({ usageItems: items }) })
    expect(res.unclassifiedOrgMonths).toBe(1)
    const [row] = await t.client<{ license: string; unclassified: string }[]>`
      SELECT license_net_usd::text AS license, unclassified_net_usd::text AS unclassified
      FROM copilot_pool_bill WHERE provider_org_id = ${orgAcme}::uuid`
    expect(Number(row!.license)).toBe(1000)
    expect(Number(row!.unclassified)).toBe(25)
  })

  it('(15) D3 remediation loop: unclassified month → corrected upstream re-pull → month rewrites to unclassified 0; the inbox item PERSISTS until an admin resolves it (alertUnclassified never auto-resolves)', async () => {
    // Round 1 — the runbook trigger: a mystery Copilot SKU books unclassified + alerts.
    const before: GithubBillingUsageItem[] = [
      item('acme', 'copilot_enterprise', { net: 1000, quantity: 25, product: 'copilot' }),
      item('acme', 'copilot_mystery_new_thing', { net: 55, product: 'copilot' }),
    ]
    const r1 = await runCopilotPoolBill(t.db, { now: NOW, monthsBack: 0, clientOverride: stub({ usageItems: before }) })
    expect(r1.unclassifiedOrgMonths).toBe(1)
    const [{ n1 }] = await t.client<{ n1: string }[]>`
      SELECT count(*)::text AS n1 FROM inbox_item
      WHERE category = 'copilot-bill-unclassified' AND body->>'kind' = 'unclassified-spend'`
    expect(Number(n1)).toBe(1)

    // Round 2 — remediation (runbook steps 2-3): the re-pull returns the SAME money on a
    // line the CURRENT classifier handles (the upstream SKU/report was corrected). The
    // worker's full recompute-and-replace rewrites the month.
    const after: GithubBillingUsageItem[] = [
      item('acme', 'copilot_enterprise', { net: 1000, quantity: 25, product: 'copilot' }),
      item('acme', 'copilot_ai_credits', { gross: 60, discount: 5, net: 55, product: 'copilot' }),
    ]
    const r2 = await runCopilotPoolBill(t.db, { now: NOW, monthsBack: 0, clientOverride: stub({ usageItems: after }) })
    expect(r2.unclassifiedOrgMonths).toBe(0)

    // The month rewrite: unclassified drops to 0, the $55 books where it now belongs.
    const [row] = await t.client<{ license: string; overage: string; unclassified: string }[]>`
      SELECT license_net_usd::text AS license, overage_net_usd::text AS overage,
             unclassified_net_usd::text AS unclassified
      FROM copilot_pool_bill WHERE provider_org_id = ${orgAcme}::uuid`
    expect(Number(row!.license)).toBe(1000)
    expect(Number(row!.overage)).toBe(55)
    expect(Number(row!.unclassified)).toBe(0)
    // The visible lane follows (zero-amount lane rows are emitted, value 0).
    const [{ lane }] = await t.client<{ lane: string }[]>`
      SELECT charge_usd::text AS lane FROM v_finance_copilot_pool_chargeback
      WHERE period_month = ${MONTH}::date AND tool = 'copilot-unclassified' AND cost_owning_unit_id = ${couA}::uuid`
    expect(Number(lane)).toBe(0)

    // Inbox fate (documented): the existing alert machinery NEVER auto-resolves — the
    // idempotency guard only suppresses duplicates; closing the item is the admin's act
    // (matching alertUnsettled's behaviour). The item persists, still unresolved.
    const [item1] = await t.client<{ n: string; ack: string }[]>`
      SELECT count(*)::text AS n, min(ack_state) AS ack FROM inbox_item
      WHERE category = 'copilot-bill-unclassified' AND body->>'kind' = 'unclassified-spend'`
    expect(Number(item1!.n)).toBe(1)
    expect(['unread', 'read', 'acknowledged']).toContain(item1!.ack)
  })

  it('(8) MEDIUM-1a: an ABSENT net money field THROWS at parse → the month is isolated, not a silent $0', async () => {
    // A bill line with NO netAmount (the field renamed/dropped by an unverified-live report).
    const raw = { usageItems: [{ product: 'Copilot', sku: LICENSE, grossAmount: 4000, quantity: 100, organizationName: 'acme' }] }
    // (a) the schema fails LOUD rather than coercing the missing net to a $0.
    expect(() => BillingUsageReportSchema.parse(raw)).toThrow()
    // (b) end-to-end: the real client parses via the same schema, so the worker's per-(enterprise,
    //     month) try/catch isolates the month — no copilot_pool_bill row is written.
    const parsingClient: BillingReportClient = { getEnterpriseBillingUsage: async () => BillingUsageReportSchema.parse(raw) }
    const res = await runCopilotPoolBill(t.db, { now: NOW, monthsBack: 0, clientOverride: parsingClient })
    expect(res.enterprisesErrored).toBe(1)
    expect(res.monthsProcessed).toBe(0)
    expect(res.orgRowsWritten).toBe(0)
    const [{ n }] = await t.client<{ n: string }[]>`SELECT count(*)::text AS n FROM copilot_pool_bill`
    expect(Number(n)).toBe(0) // NOT a silent $0 row
  })

  it('(9) MEDIUM-1b: usage present but ALL money reads $0 → sentinel forces unsettled + alert, not a confident $0', async () => {
    const report: GithubBillingUsageReport = {
      usageItems: [
        item('acme', LICENSE, { net: 0, quantity: 100 }), // license line PRESENT but $0 (shape drift)
        item('acme', CREDITS, { gross: 5000, discount: 5000, net: 0 }), // real usage, net reads 0
      ],
    }
    const res = await runCopilotPoolBill(t.db, { now: NOW, monthsBack: 0, clientOverride: stub(report) })
    expect(res.orgRowsWritten).toBe(1)
    expect(res.unsettledOrgMonths).toBe(1)
    expect(res.alertsEmitted).toBe(1)

    // The sentinel forced license to NULL (unsettled), NOT a confident $0.
    const [row] = await t.client<{ license: string | null; gross: string; overage: string }[]>`
      SELECT license_net_usd::text AS license, usage_gross_usd::text AS gross, overage_net_usd::text AS overage
      FROM copilot_pool_bill WHERE provider_org_id = ${orgAcme}::uuid`
    expect(row!.license).toBeNull()
    expect(Number(row!.gross)).toBe(5000)
    expect(Number(row!.overage)).toBe(0)

    // The month reports UNSETTLED on the Σ=bill view (license NULL + usage present).
    const [{ unsettled }] = await t.client<{ unsettled: boolean }[]>`
      SELECT unsettled FROM v_finance_bill_totals_month WHERE period_month = ${MONTH}::date AND provider = 'github'`
    expect(unsettled).toBe(true)

    // An inbox alert was raised.
    const [{ n }] = await t.client<{ n: string }[]>`
      SELECT count(*)::text AS n FROM inbox_item WHERE category = 'copilot-bill-unsettled'`
    expect(Number(n)).toBe(1)

    // The chargeback for acme's CoU is $0 — but flagged unsettled, NOT a confident settled $0.
    // (mig 0085: summed over the three §B lane rows.)
    const [{ charge }] = await t.client<{ charge: string }[]>`
      SELECT COALESCE(SUM(charge_usd),0)::text AS charge FROM v_finance_chargeback_month
      WHERE period_month = ${MONTH}::date AND cost_owning_unit_id = ${couA}::uuid
        AND tool IN ('copilot-license', 'copilot-usage', 'copilot-unclassified')`
    expect(Number(charge)).toBe(0)
  })
})
