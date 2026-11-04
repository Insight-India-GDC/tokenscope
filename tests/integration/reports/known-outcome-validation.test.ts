// @vitest-environment node
/*
 * KNOWN-OUTCOME end-to-end validation of the /reporting numbers.
 *
 * This exists to PROVE the reports are correct against a fully-specified synthetic
 * company (tests/integration/helpers/known-outcome-fixture.ts) where every expected
 * value is hand-derived from the canonical model + the live view definitions. Real
 * testcontainers Postgres, the REAL server/reporting/* functions + the real SQL
 * views — no mocks. Each surface is asserted against its exact expected value and
 * the cross-surface invariants (sum-backs, §A = bill truth, personal ≠ CC-burn,
 * burn ≠ chargeback for the SAME cost-centre).
 *
 * The headline proof (the owner's screenshot discrepancy), for CTO APAC (apac.cto):
 *   - alice's PERSONAL "My usage"          = 350  (all her tagged claude spend)
 *   - apac.cto §A cost-centre BURN         = 100  (only proj-scholarship homes here)
 *   - apac.cto §B cost-centre CHARGEBACK   = 350  (alice is emit-homed at apac.cto)
 * All three are correct-BY-DESIGN and different-by-design — see the assertions below.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'
import { buildUsageRollup } from '../helpers/usage-rollup'
import {
  seedKnownOutcomeCompany,
  seedCostCentreProjectSumBack,
  KO_NOW,
  KO_MAY_WINDOW,
  KO_MAY_PARTIAL_WINDOW,
  KO_MAR_WINDOW,
  KO_MAR_ARM1_ACTIVITY,
  KO_MAR_ARM2_ACTIVITY,
  KO_MAR_MEMBER_UNTAGGED_USD,
  type CostCentreSumBackIds,
  type KnownOutcomeIds,
} from '../helpers/known-outcome-fixture'
import {
  completeCostCentreProjectResidual,
  completeOneProjectSpend,
  completeProjectSpend,
  completeProjectSpendByActivity,
} from '../../../server/usage/complete-spend'
import {
  fetchAcrossKpis,
  fetchAcrossRegionCards,
  fetchAcrossChargebackByRegion,
  fetchProviderSplit,
  fetchAcrossDrivers,
  fetchAcrossChargebackTrend,
  fetchAcrossChargebackDow,
} from '../../../server/reporting/across-regions'
import {
  fetchCostCentreCards,
  fetchCostCentreBurnDrill,
  fetchCostCentreBurnDrivers,
  type CostCentreRef,
} from '../../../server/reporting/cost-centres'
import {
  fetchFinanceBillCheck,
  fetchFinanceCous,
  fetchFinanceExemptGap,
  fetchAnthropicCharges,
  fetchFinanceProjectOverlay,
} from '../../../server/reporting/finance'
import { getMyUsage } from '../../../server/utils/me-queries'
import { resolveServerClock } from '../../../shared/reports/clock'

/*
 * A PINNED clock. `fetchDailyMetrics` / `fetchChargebackTrend` no longer read
 * `CURRENT_DATE` (F1/D2) — the axis frontier is `clock.settledThrough`, passed
 * in. Fixed well past every window below, so the frontier is the window's own
 * end and these assertions are about the CLAMP, not about the calendar.
 */
const CLOCK = resolveServerClock(new Date('2026-12-31T12:00:00Z'))


type Tx = PostgresJsDatabase<Record<string, unknown>>

let t: TestDb
let tx: Tx
let ids: KnownOutcomeIds
let marIds: CostCentreSumBackIds
let ccs: CostCentreRef[]

const WIN = KO_MAY_WINDOW
const monthCtx = { month: '2026-05', now: KO_NOW }

beforeAll(async () => {
  t = await startTestDb()
  process.env.DATABASE_URL = t.url
  ids = await seedKnownOutcomeCompany(t)
  // The March estate for the cost-centre→project node pair. Outside May, so every
  // figure below is unchanged.
  marIds = await seedCostCentreProjectSumBack(t, ids)
  tx = t.db as unknown as Tx

  // Build the CostCentreRef list the card/drill fns take (bypassing the RLS-scoped
  // resolver — we assert the query math, not the RBAC clamp which its own suite covers).
  const rows = await t.client<
    { id: string; code: string; display_name: string; region_id: string; region_code: string }[]
  >`SELECT ou.id::text AS id, ou.code, ou.display_name, ou.region_id::text AS region_id, r.code AS region_code
      FROM org_unit ou JOIN region r ON r.id = ou.region_id WHERE ou.is_cost_owning_unit = TRUE ORDER BY r.code, ou.display_name`
  ccs = rows.map((r) => ({
    id: r.id,
    code: r.code,
    displayName: r.display_name,
    regionId: r.region_id,
    regionCode: r.region_code,
  }))
  // The region reports' §A reads come from usage_rollup_daily (usage-rollup-
  // lane.md R5/R8): materialise it from the seeds above via the real worker.
  await buildUsageRollup(t.db)
}, 180_000)

afterAll(async () => {
  await stopTestDb(t)
})

// ─────────────────────────────────────────────────────────────────────────────
// §A USAGE COMPLETENESS (v_complete_usage) — the developer-truth lane
// ─────────────────────────────────────────────────────────────────────────────
describe('§A usage — v_complete_usage totals (attribution ∪ unaccounted gap)', () => {
  it('whole-company §A usage = 915 (claude 900 = OTel 850 + gap 50) + (copilot 15)', async () => {
    const kpis = await fetchAcrossKpis(tx, WIN, { copilotChargeback: false, momMonthRange: null, now: KO_NOW })
    expect(kpis.genuineUsd).toBeCloseTo(915, 6)
    // 4 distinct spenders (alice, bob, carol, dave).
    expect(kpis.activeUsers).toBe(4)
    // §A tokens: claude 1,800,000 (attribution 1,700,000 + dave gap 100,000) + copilot 30,000.
    expect(kpis.tokens).toBe(1_830_000)
    // No prior month seeded → MoM withheld (null), never a spurious delta.
    expect(kpis.momDeltaPct).toBeNull()
  })

  it('raw view: Σ v_complete_usage cost = 915 and splits claude 900 / copilot 15', async () => {
    const [row] = await t.client<{ total: string; claude: string; copilot: string }[]>`
      SELECT COALESCE(SUM(cost_usd),0)::text AS total,
             COALESCE(SUM(cost_usd) FILTER (WHERE tool='claude-code'),0)::text AS claude,
             COALESCE(SUM(cost_usd) FILTER (WHERE tool='copilot-cli'),0)::text AS copilot
      FROM v_complete_usage
      WHERE ts_event >= ${WIN.startIso}::timestamptz AND ts_event < ${WIN.endIso}::timestamptz`
    expect(Number(row!.total)).toBeCloseTo(915, 6)
    expect(Number(row!.claude)).toBeCloseTo(900, 6) // §A INVARIANT: claude §A = the bill truth
    expect(Number(row!.copilot)).toBeCloseTo(15, 6)
  })

  it('§A by region: APAC = 715 (350+300+50 + copilot 15), EMEA = 200 — cards sum back to 915', async () => {
    const cards = await fetchAcrossRegionCards(tx, WIN, { copilotChargeback: false })
    const apac = cards.find((r) => r.code === 'apac')!
    const emea = cards.find((r) => r.code === 'emea')!
    // Copilot §A homes by the TEAMMATE's region (unaccounted_usage.region_id) — alice+bob
    // are APAC, so the copilot 15 lands in APAC. STATED here per the fixture derivation.
    expect(apac.genuineUsd).toBeCloseTo(715, 6)
    expect(emea.genuineUsd).toBeCloseTo(200, 6)
    expect(apac.activeUsers).toBe(3) // alice, bob, dave
    expect(emea.activeUsers).toBe(1) // carol
    expect(cards.reduce((a, c) => a + c.genuineUsd, 0)).toBeCloseTo(915, 6)
  })

  it('§A provider split: claude 900 (4 users) / copilot 15 (2 users) — sums back to 915', async () => {
    const s = await fetchProviderSplit(tx, WIN)
    expect(s.claudeCode.spendUsd).toBeCloseTo(900, 6)
    expect(s.claudeCode.activeUsers).toBe(4)
    expect(s.copilotCli.spendUsd).toBeCloseTo(15, 6)
    expect(s.copilotCli.activeUsers).toBe(2) // alice, bob
    // Three-lane §A ceiling: copilot-agent is structurally absent from
    // v_complete_usage (mig 0086) — its bucket exists and reads 0.
    expect(s.copilotAgent.spendUsd).toBeCloseTo(0, 6)
    expect(s.copilotAgent.activeUsers).toBe(0)
    expect(s.other.spendUsd).toBeCloseTo(0, 6)
    expect(
      s.claudeCode.spendUsd + s.copilotCli.spendUsd + s.copilotAgent.spendUsd + s.other.spendUsd,
    ).toBeCloseTo(915, 6)
  })

  it('§A model drivers sum back to 915 (claude-sonnet 850 + NULL-model residual 65)', async () => {
    const { rows, headlineUsd } = await fetchAcrossDrivers(tx, WIN, 'model')
    expect(headlineUsd).toBeCloseTo(915, 6)
    const sonnet = rows.find((r) => r.label === 'claude-sonnet-4-6')!
    const unattributed = rows.find((r) => r.key.startsWith('__null_') || r.label === 'Unattributed')!
    // All attribution rows are sonnet (850); the unaccounted gap (dave 50 + copilot 15) has
    // NULL model → the explicit "Unattributed" bucket (65) so the drivers still foot.
    expect(sonnet.usd).toBeCloseTo(850, 6)
    expect(unattributed.usd).toBeCloseTo(65, 6)
    expect(rows.reduce((a, r) => a + r.usd, 0)).toBeCloseTo(915, 6)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// COST-CENTRE BURN (§A, by the tagged PROJECT's cost_owning_unit)
// ─────────────────────────────────────────────────────────────────────────────
describe('cost-centre burn — §A, homed by the tagged project cost_owning_unit', () => {
  it('CTO APAC burn = 100 (only proj-scholarship homes here) — the "$101.71" case', async () => {
    const { cards } = await fetchCostCentreCards(tx, ccs, WIN, monthCtx, { copilotChargeback: false })
    const cto = cards.find((c) => c.id === ids.uApacCto)!
    expect(cto.burnUsd).toBeCloseTo(100, 6)
    expect(cto.allocationUsd).toBeCloseTo(500, 6)
  })

  it('APAC Delivery burn = 550 (alice deliveryx 250 + bob 300), EMEA Delivery burn = 200', async () => {
    const { cards } = await fetchCostCentreCards(tx, ccs, WIN, monthCtx, { copilotChargeback: false })
    expect(cards.find((c) => c.id === ids.uApacDelivery)!.burnUsd).toBeCloseTo(550, 6)
    expect(cards.find((c) => c.id === ids.uEmeaDelivery)!.burnUsd).toBeCloseTo(200, 6)
    // The default units carry NO §A burn (nothing tags to them; dave's gap is NULL-CoU).
    expect(cards.find((c) => c.id === ids.uApac)!.burnUsd).toBeCloseTo(0, 6)
    expect(cards.find((c) => c.id === ids.uEmea)!.burnUsd).toBeCloseTo(0, 6)
  })

  it('INVARIANT: Σ cost-centre burns = 850 = total claude §A (900) − untagged dave (50); copilot 15 excluded', async () => {
    const { cards } = await fetchCostCentreCards(tx, ccs, WIN, monthCtx, { copilotChargeback: false })
    const sumBurns = cards.reduce((a, c) => a + c.burnUsd, 0)
    expect(sumBurns).toBeCloseTo(850, 6)
    // Cross-check straight off the view: Σ over NON-NULL cost_owning_unit.
    const [row] = await t.client<{ total: string }[]>`
      SELECT COALESCE(SUM(cost_usd),0)::text AS total FROM v_complete_usage
      WHERE cost_owning_unit_id IS NOT NULL
        AND ts_event >= ${WIN.startIso}::timestamptz AND ts_event < ${WIN.endIso}::timestamptz`
    expect(Number(row!.total)).toBeCloseTo(850, 6)
  })

  it('the burn DRILL reconciles to the card burn (apac.cto = 100, all claude, copilot excluded)', async () => {
    const drill = await fetchCostCentreBurnDrill(tx, ids.uApacCto, WIN)
    expect(drill.burnUsd).toBeCloseTo(100, 6)
    expect(drill.vendor.claudeUsd).toBeCloseTo(100, 6)
    expect(drill.vendor.copilotUsd).toBeCloseTo(0, 6)
  })

  it('the apac.cto teammate driver shows alice at 100 — NOT her personal 350 (project-homed axis)', async () => {
    const { rows, headlineUsd } = await fetchCostCentreBurnDrivers(tx, ids.uApacCto, WIN, 'teammate', 100)
    expect(headlineUsd).toBeCloseTo(100, 6)
    const aliceRow = rows.find((r) => r.label === 'alice@ko.test')!
    expect(aliceRow.usd).toBeCloseTo(100, 6) // her scholarship spend only; deliveryx homes elsewhere
    expect(rows.reduce((a, r) => a + r.usd, 0)).toBeCloseTo(100, 6)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// COST-CENTRE → PROJECT sum-back, ONE lane (consistency contract §6.3)
//
// The third node pair. Every project figure here comes from `completeProjectSpend`
// — THE definition the project header, the /projects cards, the budget editor
// and the budget alert all call — and the cost-centre figure
// comes from the production `fetchCostCentreCards`. Same lane, same window, same
// options on both sides: if any ONE of those four sites is reverted to
// `attribution_aggregate` or `attribution_record`, its number stops matching the
// figure asserted here and the identity below stops closing.
//
// March estate; see seedCostCentreProjectSumBack for the derivation of every
// figure. Deliberately NOT a both-sides-zero identity — three projects at 165 /
// 80 / 91 and four residual terms at 33 / 18 / 27 / 45, all distinct — plus $12
// of untagged RECONCILED spend that sits outside the identity entirely and is
// reported on the teammate axis instead of vanishing.
//
// NOTE what this file does NOT prove: that the five surfaces quoting these
// figures still call `completeProjectSpend`. It calls the helper directly, so
// reverting any call site leaves it green. That contract is pinned statically in
// tests/unit/server/project-spend-one-lane.test.ts, and the two are a pair.
// ─────────────────────────────────────────────────────────────────────────────
describe('cost-centre → project sum-back on the §A lane', () => {
  const MAR = KO_MAR_WINDOW
  // The CC burn (fetchCostCentreCards) does NOT filter provisional identity, so
  // the project side must not either — an identity asserted across two different
  // questions is not an identity.
  const OPTS = { excludeProvisional: false }

  it('project spend is one lane: deliveryx 165 (120 OTel + 45 reconciled), atlas 80, scholarship 91', async () => {
    const spend = await completeProjectSpend(tx, MAR, {
      projectIds: [marIds.projAtlas, ids.projDeliveryx, ids.projScholarship],
      ...OPTS,
    })
    const deliveryx = spend.get(ids.projDeliveryx)!
    expect(deliveryx.costUsd).toBeCloseTo(165, 6)
    // The arm split is the whole point: $45 of this project's March spend exists
    // ONLY on the completeness lane. The old aggregate-backed headline was 120.
    expect(deliveryx.otelUsd).toBeCloseTo(120, 6)
    expect(deliveryx.reconciledUsd).toBeCloseTo(45, 6)
    expect(spend.get(marIds.projAtlas)!.costUsd).toBeCloseTo(80, 6)
    // Scholarship is led by apac.cto but carries $27 that homes to apac.delivery
    // (the post-re-home shape) — the project total is blind to CoU, by design.
    expect(spend.get(ids.projScholarship)!.costUsd).toBeCloseTo(91, 6)
  })

  it('APAC Delivery: Σ projects + ingestOnly + untagged + foreignProject − offCentre = burn (278)', async () => {
    const { cards } = await fetchCostCentreCards(tx, ccs, MAR, null, { copilotChargeback: false })
    const burn = cards.find((c) => c.id === ids.uApacDelivery)!.burnUsd
    expect(burn).toBeCloseTo(278, 6)

    // Σ over the projects THIS cost centre leads, from the one function.
    const spend = await completeProjectSpend(tx, MAR, {
      projectIds: [ids.projDeliveryx, marIds.projAtlas],
      ...OPTS,
    })
    const sumProjects = [...spend.values()].reduce((a, s) => a + s.costUsd, 0)
    expect(sumProjects).toBeCloseTo(245, 6)

    const residual = await completeCostCentreProjectResidual(tx, ids.uApacDelivery, MAR, OPTS)
    // The residual carries the BURN it reconciles to, and it must be the same
    // number the production cost-centre card reports. A reconciliation whose
    // target comes from somewhere else is two questions, not one identity.
    expect(residual.burnUsd).toBeCloseTo(burn, 6)
    // Each term is separately pinned — a swap between any two would otherwise
    // leave the identity closing while both labels lied.
    expect(residual.ingestOnlyUsd).toBeCloseTo(33, 6) // arm 3, untaggable by construction
    expect(residual.untaggedUsd).toBeCloseTo(18, 6) // homed here, no project claim
    expect(residual.foreignProjectUsd).toBeCloseTo(27, 6) // homed here, another CC's project
    expect(residual.offCentreUsd).toBeCloseTo(45, 6) // this CC's project, not homed here

    expect(
      sumProjects +
        residual.ingestOnlyUsd +
        residual.untaggedUsd +
        residual.foreignProjectUsd -
        residual.offCentreUsd,
    ).toBeCloseTo(residual.burnUsd, 6)
  })

  it('UNTAGGED RECONCILED money lands in a named term, and the identity still closes', async () => {
    /*
     * The hole this closes: an arm-2 row with no project claim carries no
     * cost_owning_unit_id either (every writer sets the CoU only alongside a
     * project), so bob's $12 of unclaimed reconciled spend was in the §A estate,
     * in no project total, in no cost-centre burn and in none of the four
     * residual terms. Money the whole reporting surface could not account for.
     *
     * It is caught on the only dimension it has — WHO spent it — and reported
     * OUTSIDE the burn identity, because a teammate-home figure added to a
     * project-home identity is two axes in one number.
     */
    const residual = await completeCostCentreProjectResidual(tx, ids.uApacDelivery, MAR, OPTS)
    expect(residual.memberUntaggedUsd).toBeCloseTo(KO_MAR_MEMBER_UNTAGGED_USD, 6)

    // It is REALLY on the lane and REALLY in nobody's burn — asserted against
    // the raw view so the term cannot be passing off a constant.
    const [row] = await t.client<{ total: string }[]>`
      SELECT COALESCE(SUM(cost_usd), 0)::text AS total FROM v_complete_usage
      WHERE usage_provenance = 'api-reconciled' AND project_id IS NULL
        AND cost_owning_unit_id IS NULL AND teammate_id = ${ids.bob}::uuid
        AND ts_event >= ${MAR.startIso}::timestamptz AND ts_event < ${MAR.endIso}::timestamptz`
    expect(Number(row!.total)).toBeCloseTo(KO_MAR_MEMBER_UNTAGGED_USD, 6)

    // And it moved NOTHING: the burn, the four terms and the project totals are
    // exactly what they were before the term existed. That is what makes this a
    // new disclosure rather than a re-homing of money.
    expect(residual.burnUsd).toBeCloseTo(278, 6)
    expect(residual.untaggedUsd).toBeCloseTo(18, 6) // disjoint: that one needs a CoU
    const spend = await completeProjectSpend(tx, MAR, {
      projectIds: [ids.projDeliveryx, marIds.projAtlas],
      ...OPTS,
    })
    expect([...spend.values()].reduce((a, s) => a + s.costUsd, 0)).toBeCloseTo(245, 6)
  })

  it('CTO APAC: the mirror case — Σ projects 91 − offCentre 27 = burn (64)', async () => {
    const { cards } = await fetchCostCentreCards(tx, ccs, MAR, null, { copilotChargeback: false })
    const burn = cards.find((c) => c.id === ids.uApacCto)!.burnUsd
    expect(burn).toBeCloseTo(64, 6)

    const spend = await completeProjectSpend(tx, MAR, { projectIds: [ids.projScholarship], ...OPTS })
    const sumProjects = [...spend.values()].reduce((a, s) => a + s.costUsd, 0)
    expect(sumProjects).toBeCloseTo(91, 6)

    const residual = await completeCostCentreProjectResidual(tx, ids.uApacCto, MAR, OPTS)
    expect(residual.burnUsd).toBeCloseTo(burn, 6)
    expect(residual.offCentreUsd).toBeCloseTo(27, 6)
    expect(residual.ingestOnlyUsd).toBeCloseTo(0, 6)
    expect(residual.untaggedUsd).toBeCloseTo(0, 6)
    expect(residual.foreignProjectUsd).toBeCloseTo(0, 6)
    // bob's unclaimed $12 homes to apac.DELIVERY — it must not leak here.
    expect(residual.memberUntaggedUsd).toBeCloseTo(0, 6)

    expect(
      sumProjects +
        residual.ingestOnlyUsd +
        residual.untaggedUsd +
        residual.foreignProjectUsd -
        residual.offCentreUsd,
    ).toBeCloseTo(residual.burnUsd, 6)
  })

  it('the residual is NOT a rounding term: dropping any one of it breaks the identity', async () => {
    // Guards against the identity being asserted with all-zero residual terms,
    // which is the failure mode that makes a sum-back test worthless. Every term
    // is individually large enough to break the equation on its own.
    const residual = await completeCostCentreProjectResidual(tx, ids.uApacDelivery, MAR, OPTS)
    for (const [label, usd] of Object.entries(residual)) {
      expect(Math.abs(usd as number), `${label} must be materially non-zero`).toBeGreaterThan(1)
    }
  })

  it('the `untagged` TERM is schema-legal but UNREACHABLE in production — and stays anyway', async () => {
    /*
     * Said plainly rather than left for the next reader to discover: NO writer
     * produces the row this term counts. `attribution_record.cost_owning_unit_id`
     * is set only alongside a project (tag-session.ts, azure-monitor-reader.ts)
     * and arm 2 has no CoU column at all, so "homed at a cost centre AND carrying
     * no project claim" cannot arise. The $18 row below is planted by hand.
     *
     * It is kept, not deleted, for one reason: `untagged` and `ingestOnly` differ
     * by a single `usage_provenance` clause, so without a row in this shape a
     * term that swallowed the other returns the same total and the mutation
     * survives. That is a statement about MUTATION COVERAGE, not about the
     * product — the money a cost-centre owner actually has unclaimed is
     * `memberUntaggedUsd`, which IS reachable and is asserted above.
     */
    const [planted] = await t.client<{ n: string }[]>`
      SELECT COUNT(*)::text AS n FROM attribution_record
      WHERE claude_session_id = 'ko-mar-untagged-bob'`
    expect(Number(planted!.n)).toBe(1) // hand-planted, never written by the app
    const residual = await completeCostCentreProjectResidual(tx, ids.uApacDelivery, MAR, OPTS)
    expect(residual.untaggedUsd).toBeCloseTo(18, 6)
    expect(residual.ingestOnlyUsd).toBeCloseTo(33, 6) // the term it must not swallow
  })

  it('ACTIVITY reaches the project mix from BOTH taggable arms (mig 0113)', async () => {
    /*
     * The per-activity grain must foot to the same headline as everything else
     * on the project page, which means it has to carry arm 2. The reconciled
     * $45 is tagged `reconciled-catchup` — a label on NO attribution_record row
     * anywhere in this fixture, so it can only appear here through
     * `unaccounted_usage.activity` on the §A lane.
     */
    const mix = await completeProjectSpendByActivity(tx, ids.projDeliveryx, MAR, OPTS)
    const byActivity = new Map(mix.map((m) => [m.activity, m.costUsd]))

    expect(byActivity.get(KO_MAR_ARM1_ACTIVITY)).toBeCloseTo(120, 6) // arm 1
    expect(byActivity.get(KO_MAR_ARM2_ACTIVITY)).toBeCloseTo(45, 6) // arm 2 — the point
    // No NULL bucket: every dollar of this project's March spend is tagged, so a
    // mix blind to arm 2 puts the $45 under `null` — asserted as a NUMBER so the
    // failure reads as money in the wrong bucket, not as a missing key.
    expect(byActivity.get(null) ?? 0).toBeCloseTo(0, 6)
    expect(byActivity.has(null)).toBe(false)

    // And the mix FOOTS to the headline — the reason the grain moved onto this
    // lane in the first place.
    const headline = await completeOneProjectSpend(tx, ids.projDeliveryx, MAR, OPTS)
    expect(headline.costUsd).toBeCloseTo(165, 6)
    expect(mix.reduce((a, m) => a + m.costUsd, 0)).toBeCloseTo(headline.costUsd, 6)
  })

  it('arm 3 can never enter a project figure, on any project, at any grain', async () => {
    // The $33 of claude-cowork is in the cost centre's burn but must be absent
    // from EVERY project row — that is what "project_id NULL by construction"
    // means, and it is why it needs its own labelled bucket on the page.
    const spend = await completeProjectSpend(tx, MAR, OPTS)
    const anyIngestOnly = [...spend.values()].some((s) => s.costUsd + 1e-9 < s.otelUsd + s.reconciledUsd)
    expect(anyIngestOnly).toBe(false)
    // Every project's total is exactly arms 1+2 — no third arm anywhere.
    for (const [projectId, s] of spend) {
      expect(s.otelUsd + s.reconciledUsd, `project ${projectId}`).toBeCloseTo(s.costUsd, 6)
    }
    const [row] = await t.client<{ total: string }[]>`
      SELECT COALESCE(SUM(cost_usd), 0)::text AS total FROM v_complete_usage
      WHERE usage_provenance = 'provider-usage' AND project_id IS NOT NULL`
    expect(Number(row!.total)).toBeCloseTo(0, 6)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// PERSONAL "MY USAGE" (alice) — and the CTO-APAC proof triangle
// ─────────────────────────────────────────────────────────────────────────────
describe('personal "My usage" (alice) vs CTO-APAC burn vs CTO-APAC chargeback', () => {
  it("alice's personal usage total = 350 (scholarship 100 + deliveryx 250)", async () => {
    const usage = await getMyUsage(tx, ids.alice, KO_NOW)
    expect(usage.total_cost_usd).toBe('350.00')
    const byCode = new Map(usage.buckets.map((b) => [b.project_code, b.cost_usd]))
    expect(byCode.get('PROJ-SCHOLARSHIP')).toBe('100.00')
    expect(byCode.get('PROJ-DELIVERYX')).toBe('250.00')
    // Her copilot §A ($5, untagged) surfaces in the unallocated worklist, not the
    // project-bucket total — so her COMPLETE §A usage displayed = 350 + 5 = 355
    // (still ≥ provider truth, the §A invariant). The buckets headline is 350.
    expect(usage.unallocated.total_cost_usd).toBe('5.00')
  })

  it('PROOF: personal 350 ≠ CC-burn 100 ≠ CC-chargeback 350 — all correct-by-design', async () => {
    const usage = await getMyUsage(tx, ids.alice, KO_NOW)
    const { cards } = await fetchCostCentreCards(tx, ccs, WIN, monthCtx, { copilotChargeback: false })
    const cto = cards.find((c) => c.id === ids.uApacCto)!
    const charges = await fetchAnthropicCharges(tx, ids.uApacCto, WIN)

    const personal = Number(usage.total_cost_usd) // 350
    const burn = cto.burnUsd // 100
    const chargeback = charges.totalUsd // 350

    expect(personal).toBeCloseTo(350, 6)
    expect(burn).toBeCloseTo(100, 6)
    expect(chargeback).toBeCloseTo(350, 6)
    // personal == chargeback (both teammate-scoped: all of alice's tagged spend / her
    // full bill homed to her emit-unit apac.cto) but personal != burn.
    expect(personal).toBeCloseTo(chargeback, 6)
    // burn (project-CoU axis) is DIFFERENT from chargeback (teammate-home axis) for the
    // SAME cost-centre — the exact discrepancy the owner screenshotted.
    expect(burn).not.toBeCloseTo(chargeback, 1)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// §B CHARGEBACK (v_finance_*) — teammate-homed, pooled Copilot gated
// ─────────────────────────────────────────────────────────────────────────────
describe('§B chargeback — per-cost-centre, teammate-homed (Anthropic) + pooled (Copilot)', () => {
  it('CTO APAC chargeback = 350 (alice full bill homes to her emit-unit) — burn was 100', async () => {
    const charges = await fetchAnthropicCharges(tx, ids.uApacCto, WIN)
    expect(charges.totalUsd).toBeCloseTo(350, 6)
    expect(charges.charges).toHaveLength(1)
    expect(charges.charges[0]!.label).toBe('alice@ko.test')
  })

  it('APAC Delivery chargeback = 300 (bob), EMEA Delivery = 200 (carol), apac default = 50 (dave)', async () => {
    expect((await fetchAnthropicCharges(tx, ids.uApacDelivery, WIN)).totalUsd).toBeCloseTo(300, 6)
    expect((await fetchAnthropicCharges(tx, ids.uEmeaDelivery, WIN)).totalUsd).toBeCloseTo(200, 6)
    expect((await fetchAnthropicCharges(tx, ids.uApac, WIN)).totalUsd).toBeCloseTo(50, 6)
  })

  it('per-CoU chargeable — Copilot pool ($40) held back OFF (Σ 900), folded ON (Σ 940)', async () => {
    const off = await fetchFinanceCous(tx, WIN, { copilotChargeback: false })
    const on = await fetchFinanceCous(tx, WIN, { copilotChargeback: true })

    const ctoOff = off.find((r) => r.couId === ids.uApacCto)!
    expect(ctoOff.anthropicUsd).toBeCloseTo(350, 6)
    expect(ctoOff.copilotUsd).toBeCloseTo(0, 6)

    const delOff = off.find((r) => r.couId === ids.uApacDelivery)!
    expect(delOff.anthropicUsd).toBeCloseTo(300, 6)
    expect(delOff.copilotUsd).toBeCloseTo(40, 6) // pooled net surfaced...
    expect(delOff.copilotPending).toBe(true)
    expect(delOff.chargeableUsd).toBeCloseTo(300, 6) // ...but NOT folded (pending)

    const delOn = on.find((r) => r.couId === ids.uApacDelivery)!
    expect(delOn.copilotPending).toBe(false)
    expect(delOn.chargeableUsd).toBeCloseTo(340, 6) // 300 + 40 pooled net

    // Σ chargeable: OFF = 900 (Anthropic only); ON = 940 (+ Copilot pooled net 40).
    expect(off.reduce((a, r) => a + r.chargeableUsd, 0)).toBeCloseTo(900, 6)
    expect(on.reduce((a, r) => a + r.chargeableUsd, 0)).toBeCloseTo(940, 6)
  })

  it('INVARIANT: Σ Anthropic chargeback = 900; by region APAC = 700, EMEA = 200', async () => {
    // Whole-company Anthropic chargeback (bill lane).
    // mig 0085: the copilot arm emits the three §B LANE IDS, so the Anthropic
    // reference excludes THOSE (the old `tool <> 'copilot-cli'` would now let the
    // copilot lane rows leak into the Anthropic sum).
    const [row] = await t.client<{ total: string; apac: string; emea: string }[]>`
      SELECT COALESCE(SUM(charge_usd),0)::text AS total,
             COALESCE(SUM(charge_usd) FILTER (WHERE region_id = ${ids.regionApac}::uuid),0)::text AS apac,
             COALESCE(SUM(charge_usd) FILTER (WHERE region_id = ${ids.regionEmea}::uuid),0)::text AS emea
      FROM v_finance_chargeback_month
      WHERE tool NOT IN ('copilot-license', 'copilot-usage', 'copilot-unclassified')
        AND period_month >= '2026-05-01'::date AND period_month < '2026-06-01'::date`
    expect(Number(row!.total)).toBeCloseTo(900, 6)
    expect(Number(row!.apac)).toBeCloseTo(700, 6) // alice 350 + bob 300 + dave 50
    expect(Number(row!.emea)).toBeCloseTo(200, 6) // carol 200
  })

  it('chargeback-by-region sums back to the chargeable headline (OFF 900 / ON 940)', async () => {
    const off = await fetchAcrossChargebackByRegion(tx, WIN, { copilotChargeback: false })
    const on = await fetchAcrossChargebackByRegion(tx, WIN, { copilotChargeback: true })
    expect(off.reduce((a, r) => a + r.chargeableUsd, 0)).toBeCloseTo(900, 6)
    expect(on.reduce((a, r) => a + r.chargeableUsd, 0)).toBeCloseTo(940, 6)
    // APAC gains the pooled Copilot 40 only in chargeback mode.
    const apacOff = off.find((r) => r.regionId === ids.regionApac)!
    const apacOn = on.find((r) => r.regionId === ids.regionApac)!
    expect(apacOff.chargeableUsd).toBeCloseTo(700, 6)
    expect(apacOn.chargeableUsd).toBeCloseTo(740, 6)
  })

  it('Copilot pooled chargeback = 40, homed to apac.delivery (region APAC per the view)', async () => {
    // mig 0085: one row PER §B LANE per (cou, month) — the (cou, month) group still
    // homes to apac.delivery and Σ lanes is the pre-split 40.
    const [row] = await t.client<{ cou: string | null; region: string | null; charge: string }[]>`
      SELECT cost_owning_unit_id::text AS cou, region_id::text AS region,
             COALESCE(SUM(charge_usd), 0)::text AS charge
      FROM v_finance_copilot_pool_chargeback WHERE period_month = '2026-05-01'::date
      GROUP BY cost_owning_unit_id, region_id`
    expect(row!.cou).toBe(ids.uApacDelivery)
    expect(row!.region).toBe(ids.regionApac) // derived from the CoU's org_unit region
    expect(Number(row!.charge)).toBeCloseTo(40, 6)
  })

  it('billed teammates = 4; billed tokens = Σ claude bill tokens = 1,800,000', async () => {
    const kpis = await fetchAcrossKpis(tx, WIN, { copilotChargeback: false, momMonthRange: null, now: KO_NOW })
    expect(kpis.billedTeammates).toBe(4)
    expect(kpis.billedTokens).toBe(1_800_000)
    expect(kpis.avgChargePerBilledUser).toBeCloseTo(225, 6) // 900 / 4
  })

  it('§B daily trend has a nonzero day per spend day (05-05..05-08) summing to 900', async () => {
    const trend = await fetchAcrossChargebackTrend(tx, WIN, CLOCK)
    const nonzero = trend.filter((p) => p.chargeUsd > 0)
    const byDay = new Map(nonzero.map((p) => [p.day, p.chargeUsd]))
    expect(byDay.get('2026-05-05')).toBeCloseTo(350, 6) // alice
    expect(byDay.get('2026-05-06')).toBeCloseTo(300, 6) // bob
    expect(byDay.get('2026-05-07')).toBeCloseTo(200, 6) // carol
    expect(byDay.get('2026-05-08')).toBeCloseTo(50, 6) // dave
    expect(nonzero).toHaveLength(4)
    expect(nonzero.reduce((a, p) => a + p.chargeUsd, 0)).toBeCloseTo(900, 6)
  })

  it('finance project overlay for apac.cto sums back to the Anthropic chargeable headline (350)', async () => {
    const overlay = await fetchFinanceProjectOverlay(tx, ids.uApacCto, WIN, 350)
    expect(overlay.reduce((a, r) => a + r.usd, 0)).toBeCloseTo(350, 6)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// §B CHARGEBACK — NON-month-aligned range windows by DAY (the grain-mismatch fix)
// ─────────────────────────────────────────────────────────────────────────────
describe('§B chargeback — a non-month-aligned custom range windows by DAY, not month', () => {
  // Window [2026-05-06, 2026-05-08): bob's 05-06 bill (300) + carol's 05-07 bill (200)
  // ONLY — alice (05-05) and dave (05-08) fall OUTSIDE the half-open bounds. Before the
  // fix the §B chargeable/rankings read the MONTH view (period_month = 2026-05-01, which
  // is ∉ [05-06, 05-08)), so the Chargeable tile + provider-split + by-region dropped to
  // $0 WHILE the day-grained tiles (billed teammates, trend, dow) showed real bars — the
  // exact contradiction. Copilot OFF: its pooled-MONTHLY charge (period_month 2026-05-01)
  // is not day-windowable and is honestly absent from a sub-month slice (documented).
  const RANGE = KO_MAY_PARTIAL_WINDOW

  it('Anthropic chargeable = 500 (bob 300 + carol 200) — NOT the whole-month 900, NOT the pre-fix $0', async () => {
    const kpis = await fetchAcrossKpis(tx, RANGE, { copilotChargeback: false, momMonthRange: null, now: KO_NOW })
    expect(kpis.anthropicChargeableUsd).toBeCloseTo(500, 6)
    expect(kpis.chargeableUsd).toBeCloseTo(500, 6)
    // The pre-fix behaviour is GONE: the month-grained read returned 0 (dropped); the
    // whole-month read would return 900. The windowed day-grained read is the only 500.
    expect(kpis.anthropicChargeableUsd).not.toBeCloseTo(0, 6)
    expect(kpis.anthropicChargeableUsd).not.toBeCloseTo(900, 6)
  })

  it('billed teammates = 2 (bob, carol); billed tokens = 1,000,000; avg = 250 — same window+grain as the charge', async () => {
    const kpis = await fetchAcrossKpis(tx, RANGE, { copilotChargeback: false, momMonthRange: null, now: KO_NOW })
    expect(kpis.billedTeammates).toBe(2)
    expect(kpis.billedTokens).toBe(1_000_000) // bob (2×300k) + carol (2×200k)
    // avg = Anthropic chargeable (500) ÷ billed teammates (2) — both now the SAME day-set;
    // pre-fix this divided a month-grained 0 by a day-grained 2 → a spurious 0.
    expect(kpis.avgChargePerBilledUser).toBeCloseTo(250, 6)
  })

  it('Σ chargeDaily == 500 (bob 05-06 = 300, carol 05-07 = 200); alice/dave days excluded', async () => {
    const trend = await fetchAcrossChargebackTrend(tx, RANGE, CLOCK)
    const byDay = new Map(trend.map((p) => [p.day, p.chargeUsd]))
    expect(byDay.get('2026-05-06')).toBeCloseTo(300, 6)
    expect(byDay.get('2026-05-07')).toBeCloseTo(200, 6)
    // The half-open window is exactly [05-06, 05-08): only those two days exist (zero-fill
    // spans the window), and alice's 05-05 + dave's 05-08 are outside it entirely.
    expect(trend).toHaveLength(2)
    expect(byDay.has('2026-05-05')).toBe(false)
    expect(byDay.has('2026-05-08')).toBe(false)
    expect(trend.reduce((a, p) => a + p.chargeUsd, 0)).toBeCloseTo(500, 6)
  })

  it('Σ chargeDow == 500 (matches the windowed Anthropic chargeable)', async () => {
    const dow = await fetchAcrossChargebackDow(tx, RANGE)
    expect(dow).toHaveLength(7) // always seven zero-filled buckets
    expect(dow.reduce((a, b) => a + b.chargeUsd, 0)).toBeCloseTo(500, 6)
  })

  it('chargebackByRegion sums back to the windowed chargeable (APAC 300 bob + EMEA 200 carol = 500)', async () => {
    const rows = await fetchAcrossChargebackByRegion(tx, RANGE, { copilotChargeback: false })
    expect(rows.reduce((a, r) => a + r.chargeableUsd, 0)).toBeCloseTo(500, 6)
    expect(rows.find((r) => r.regionId === ids.regionApac)!.chargeableUsd).toBeCloseTo(300, 6)
    expect(rows.find((r) => r.regionId === ids.regionEmea)!.chargeableUsd).toBeCloseTo(200, 6)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// COST-CENTRE §B chargeUsd — DAILY-grain Anthropic + month-aligned-only Copilot pool
// (the grain-mismatch fix, mirroring the Across/Regional §B chargeback lane)
// ─────────────────────────────────────────────────────────────────────────────
describe('cost-centre §B chargeUsd — day-grained Anthropic; Copilot pool only when month-aligned', () => {
  // A window that STARTS on a month boundary but ends MID-month → NOT month-aligned, yet it
  // DOES cover the pool's 05-01 period_month. Without the month-aligned gate the whole $40
  // pool would fold into a half-month window; with it, the pool is honestly withheld.
  const MID_MONTH = { startIso: '2026-05-01T00:00:00.000Z', endIso: '2026-05-15T00:00:00.000Z' }

  it('month-aligned (whole May), Copilot OFF: per-CC chargeUsd on the DAY grain sums to 900', async () => {
    const { cards, copilotChargebackPartialMonth } = await fetchCostCentreCards(tx, ccs, WIN, monthCtx, {
      copilotChargeback: false,
    })
    const by = new Map(cards.map((c) => [c.id, c.chargeUsd]))
    expect(by.get(ids.uApacCto)).toBeCloseTo(350, 6) // alice's bill homes to apac.cto
    expect(by.get(ids.uApacDelivery)).toBeCloseTo(300, 6) // bob → apac.delivery
    expect(by.get(ids.uEmeaDelivery)).toBeCloseTo(200, 6) // carol → emea.delivery
    expect(by.get(ids.uApac)).toBeCloseTo(50, 6) // dave → apac (default)
    expect(cards.reduce((a, c) => a + c.chargeUsd, 0)).toBeCloseTo(900, 6) // = whole-company Anthropic
    expect(copilotChargebackPartialMonth).toBe(false)
  })

  it('month-aligned (whole May), Copilot ON: apac.delivery folds the $40 pool → 340; Σ = 940; not partial', async () => {
    const { cards, copilotChargebackPartialMonth } = await fetchCostCentreCards(tx, ccs, WIN, monthCtx, {
      copilotChargeback: true,
    })
    const by = new Map(cards.map((c) => [c.id, c.chargeUsd]))
    expect(by.get(ids.uApacDelivery)).toBeCloseTo(340, 6) // 300 Anthropic + 40 pooled net
    expect(by.get(ids.uApacCto)).toBeCloseTo(350, 6) // pool homes to apac.delivery, not here
    expect(cards.reduce((a, c) => a + c.chargeUsd, 0)).toBeCloseTo(940, 6)
    expect(copilotChargebackPartialMonth).toBe(false)
  })

  it('NON-month-aligned [05-06,05-08): chargeUsd is DAY-windowed = 500 — NOT the whole-month 900, NOT the pre-fix $0', async () => {
    const { cards, copilotChargebackPartialMonth } = await fetchCostCentreCards(
      tx,
      ccs,
      KO_MAY_PARTIAL_WINDOW,
      null,
      { copilotChargeback: false },
    )
    const by = new Map(cards.map((c) => [c.id, c.chargeUsd]))
    // bob homes apac.delivery (05-06 = 300); carol homes emea.delivery (05-07 = 200).
    expect(by.get(ids.uApacDelivery)).toBeCloseTo(300, 6)
    expect(by.get(ids.uEmeaDelivery)).toBeCloseTo(200, 6)
    // CTO-APAC = 0 in this window: alice's 05-05 bill is OUTSIDE the half-open [05-06, 05-08).
    expect(by.get(ids.uApacCto)).toBeCloseTo(0, 6)
    expect(by.get(ids.uApac)).toBeCloseTo(0, 6) // dave's 05-08 excluded too
    const sum = cards.reduce((a, c) => a + c.chargeUsd, 0)
    expect(sum).toBeCloseTo(500, 6)
    // The pre-fix month-view read `period_month = 05-01` ∉ [05-06, 05-08) → every card $0.00;
    // the whole-month read would be 900. The windowed DAY-grained read is the only 500.
    expect(sum).not.toBeCloseTo(900, 6)
    expect(sum).not.toBeCloseTo(0, 6)
    expect(copilotChargebackPartialMonth).toBe(false) // copilot OFF → nothing to withhold
  })

  it('partial-month + Copilot ON: the pooled MONTHLY net is WITHHELD (not sliced, not $0-faked), flagged partial', async () => {
    const { cards, copilotChargebackPartialMonth } = await fetchCostCentreCards(tx, ccs, MID_MONTH, null, {
      copilotChargeback: true,
    })
    const by = new Map(cards.map((c) => [c.id, c.chargeUsd]))
    // apac.delivery: bob's 300 Anthropic (05-06 ∈ window); the $40 pool is NOT folded.
    expect(by.get(ids.uApacDelivery)).toBeCloseTo(300, 6)
    expect(by.get(ids.uApacDelivery)).not.toBeCloseTo(340, 6) // would be 340 if the pool were sliced in
    expect(copilotChargebackPartialMonth).toBe(true)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// ACROSS §B — the partial-month Copilot caveat (payload flag, not a silent $0)
// ─────────────────────────────────────────────────────────────────────────────
describe('across §B chargeable — Copilot pool folds only when month-aligned; else flagged partial', () => {
  const MID_MONTH = { startIso: '2026-05-01T00:00:00.000Z', endIso: '2026-05-15T00:00:00.000Z' }

  it('month-aligned + Copilot ON folds the pool: chargeable 940, not partial', async () => {
    const kpis = await fetchAcrossKpis(tx, WIN, { copilotChargeback: true, momMonthRange: null, now: KO_NOW })
    expect(kpis.chargeableUsd).toBeCloseTo(940, 6) // 900 Anthropic + 40 pooled net
    expect(kpis.copilotPartialMonthUnavailable).toBe(false)
  })

  it('partial-month + Copilot ON WITHHOLDS the pool: chargeable stays 900 (pool 40 present but NOT folded), flagged', async () => {
    const kpis = await fetchAcrossKpis(tx, MID_MONTH, {
      copilotChargeback: true,
      momMonthRange: null,
      now: KO_NOW,
    })
    expect(kpis.anthropicChargeableUsd).toBeCloseTo(900, 6) // whole-May Anthropic, day-windowed
    expect(kpis.copilotChargeableUsd).toBeCloseTo(40, 6) // the pool IS computed...
    expect(kpis.chargeableUsd).toBeCloseTo(900, 6) // ...but NOT folded over a partial month
    expect(kpis.copilotPartialMonthUnavailable).toBe(true)
    // The silent-omission bug is gone: it neither slices the pool into a half-month (940) nor
    // shows $0 under a "+ Copilot pooled net" label — it flags the withholding honestly.
    expect(kpis.chargeableUsd).not.toBeCloseTo(940, 6)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// §B FINANCE Σ=bill reconciliation + exempt gap
// ─────────────────────────────────────────────────────────────────────────────
describe('§B finance — Σ=bill reconciliation (whole-truth) + provider split', () => {
  it('Σ chargeback = Σ bill = 940 (Anthropic 900 + Copilot pooled net 40), matched GREEN', async () => {
    const check = await fetchFinanceBillCheck(tx, WIN)
    expect(check.chargebackUsd).toBeCloseTo(940, 6)
    expect(check.billUsd).toBeCloseTo(940, 6)
    expect(check.deltaUsd).toBeCloseTo(0, 6)
    expect(check.matched).toBe(true)
    expect(check.unsettled).toBe(false)
    expect(check.copilotChargebackUsd).toBeCloseTo(40, 6)
  })

  it('§B provider split: Anthropic bill 900 vs Copilot bill 40 (settled, not unsettled)', async () => {
    const check = await fetchFinanceBillCheck(tx, WIN)
    const anthropic = check.providers.find((p) => p.provider === 'anthropic')!
    const github = check.providers.find((p) => p.provider === 'github')!
    expect(anthropic.billUsd).toBeCloseTo(900, 6)
    expect(anthropic.unsettled).toBe(false)
    expect(github.billUsd).toBeCloseTo(40, 6)
    expect(github.unsettled).toBe(false) // license present + usage>0 → settled
  })

  it('exempt gap = §A usage (915) − §B chargeback (940) = −25, the Copilot license/usage basis mismatch', async () => {
    // NO exempt teammates in this fixture, so the classic exempt gap is ~0 on the claude
    // lane (its §A usage 900 == its §B chargeback 900). The −25 is entirely the Copilot
    // pooled LICENSE ($40 net chargeback) exceeding Copilot gross §A usage ($15) — a
    // real pooled-billing basis mismatch (§B: license READ from the bill, NOT ∝ usage),
    // never a bug. Asserted honestly rather than fudged to 0.
    const gap = await fetchFinanceExemptGap(tx, WIN)
    expect(gap.indicativeUsageUsd).toBeCloseTo(915, 6)
    expect(gap.chargebackUsd).toBeCloseTo(940, 6)
    expect(gap.gapUsd).toBeCloseTo(-25, 6)
    expect(gap.copilotChargebackUsd).toBeCloseTo(40, 6)
  })
})
