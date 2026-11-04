// @vitest-environment node
/*
 * FINANCE reporting scope — the Wave 5 endpoints (`/reports/finance{,/[couId]}`,
 * `/reports/export?scope=finance`) exercised against a real testcontainers Postgres
 * via the OWNER connection (RLS inert in prod too, so the in-query scope clauses are
 * what's tested). Covers build-design §7 + owner-decisions D-Q5/D-Q6/D-Homing/D-Q8:
 *   - RBAC: `requireReportScope(..., 'finance')` — platform-admin as the baseline
 *     role, PLUS any teammate holding an active finance report-access grant
 *     whatever their role (mig 0129, and the reason `global-finops` could be
 *     retired rather than replaced). A role alone, without a grant, still 403s:
 *     admin/manager/developer/finance. The old wording here said "ONLY
 *     platform-admin + platform-admin" — a rename artefact that both duplicated
 *     the role and denied the grant path this file now exercises;
 *   - the VISIBLE Σ=bill check row (matched GREEN; a seeded unsettled month RED);
 *   - exempt gap = indicative usage − chargeback (a seeded exempt org: visible
 *     indicative, zero chargeback);
 *   - Overage Drivers proportional shares SUM to the paid overage + are informational
 *     (spendClass, never a charge field); chargeback-mode vs pool-utilisation gating;
 *   - anti-IDOR on `couId` (missing → 404, malformed → 400);
 *   - ledger CSV byte-identical to the per-CoU JSON figures;
 *   - "finalised" absent from every finance response (grep).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'
import { injectTestSession } from '../../helpers/auth'
import { grantReportAccess } from '../helpers/report-access'
import type { Session } from '../../../server/utils/auth'
import indexHandler from '../../../server/api/v1/reports/finance/index.get'
import drillHandler from '../../../server/api/v1/reports/finance/[couId].get'
import exportHandler from '../../../server/api/v1/reports/export.get'

let t: TestDb
let regionA = ''
let regionB = ''
let ccA = '' // cost-owning practice 'a' (region A) — Anthropic + Copilot + overage
let ccB = '' // cost-owning practice 'b' (region B)
let orgO1 = '' // provider_org mapped to ccA
let alice = ''
let bob = ''
let carol = ''
let evan = '' // exempt Anthropic teammate (indicative usage, zero chargeback)
/*
 * mig 0129: a DEDICATED teammate for every 'platform-admin' / 'platform-admin'
 * session in this file — NEVER the shared sess() default sentinel, which the
 * admin/manager/developer/finance 403 loop below ALSO resolves to.
 */
let financeElevatedId = ''

const ev = (session: Session, query = '', params: Record<string, string> = {}) => {
  const url = '/x' + (query ? `?${query}` : '')
  const headers: Record<string, string> = { host: 'localhost:3450', origin: 'http://localhost:3450' }
  const e = {
    method: 'GET',
    path: url,
    context: { params },
    node: {
      req: { method: 'GET', url, socket: { remoteAddress: '127.0.0.1' }, get headers() { return { ...headers } } },
      res: { _headers: {} as Record<string, unknown>, statusCode: 200, getHeader() {}, setHeader() {}, removeHeader() {}, appendHeader() {}, get headersSent() { return false } },
    },
  }
  injectTestSession(e as unknown as Parameters<typeof injectTestSession>[0], session)
  return e as unknown as Parameters<typeof indexHandler>[0]
}
const sess = (role: string, orgPath: string, regionId: string, teammateId = '00000000-0000-0000-0000-000000000009'): Session =>
  ({ teammateId, email: 'x@x.test', displayName: 'X', role, regionId, orgPath, issuedAt: new Date().toISOString() } as unknown as Session)

const gfo = () => sess('platform-admin', 'a', regionA, financeElevatedId)

beforeAll(async () => {
  t = await startTestDb()
  process.env.DATABASE_URL = t.url

  const mkRegion = async (code: string, name: string) => {
    await t.client`INSERT INTO region (code, display_name) VALUES (${code}, ${name})`
    const [r] = await t.client<{ id: string }[]>`SELECT id::text AS id FROM region WHERE code=${code}`
    return r!.id
  }
  regionA = await mkRegion('ra', 'Region A')
  regionB = await mkRegion('rb', 'Region B')

  const mkUnit = async (region: string, path: string, code: string, costOwning: boolean, type = 'bu') => {
    await t.client`INSERT INTO org_unit (region_id, path, code, display_name, unit_type, is_cost_owning_unit)
      VALUES (${region}::uuid, ${path}::ltree, ${code}, ${code}, ${type}, ${costOwning})`
    const [r] = await t.client<{ id: string }[]>`SELECT id::text AS id FROM org_unit WHERE region_id=${region}::uuid AND code=${code}`
    return r!.id
  }
  ccA = await mkUnit(regionA, 'a', 'a', true)
  await mkUnit(regionA, 'a.team', 'a-team', false, 'team') // alice/bob/carol/evan home → nearest CoU 'a'
  ccB = await mkUnit(regionB, 'b', 'b', true)

  const mkTeammate = async (region: string, path: string, email: string) => {
    const [u] = await t.client<{ id: string }[]>`SELECT id::text AS id FROM org_unit WHERE region_id=${region}::uuid AND path=${path}::ltree`
    await t.client`INSERT INTO teammate (entra_oid, email, display_name, region_id, org_unit_id, is_active)
      VALUES ('oid-'||${email}, ${email}, ${email}, ${region}::uuid, ${u!.id}::uuid, true)`
    const [r] = await t.client<{ id: string }[]>`SELECT id::text AS id FROM teammate WHERE email=${email}`
    return r!.id
  }
  alice = await mkTeammate(regionA, 'a.team', 'alice@a.test')
  bob = await mkTeammate(regionA, 'a.team', 'bob@a.test')
  carol = await mkTeammate(regionA, 'a.team', 'carol@a.test')
  evan = await mkTeammate(regionA, 'a.team', 'evan@a.test')
  const bianca = await mkTeammate(regionB, 'b', 'bianca@b.test')

  // A SEPARATE, DEDICATED teammate for this file's 'platform-admin'/'platform-admin'
  // sessions (mig 0129) — see the `financeElevatedId` declaration above. Granted
  // BOTH permissions so gfo()/the platform-admin session keep their pre-mig-0129
  // (unconditional org-wide) reach.
  await t.client`INSERT INTO teammate (entra_oid, email, display_name, region_id, org_unit_id, role, is_active)
    VALUES ('oid-finops-elevated', 'finops-elevated@a.test', 'Finops Elevated', ${regionA}::uuid, ${ccA}::uuid, 'platform-admin', true)`
  ;[{ id: financeElevatedId }] = await t.client<{ id: string }[]>`SELECT id::text AS id FROM teammate WHERE email='finops-elevated@a.test'`
  await grantReportAccess(t.client, financeElevatedId)

  const mkInstance = async (teammateId: string, region: string, path: string) => {
    const [u] = await t.client<{ id: string }[]>`SELECT id::text AS id FROM org_unit WHERE region_id=${region}::uuid AND path=${path}::ltree`
    await t.client`INSERT INTO instance_attestation (instance_id, principal_oid, teammate_id, tool, region_id, org_unit_id, project_code_hash, raw_project_code)
      VALUES (gen_random_uuid(), 'p', ${teammateId}::uuid, 'claude-code', ${region}::uuid, ${u!.id}::uuid, 'h', 'P')`
    const [r] = await t.client<{ id: string }[]>`SELECT instance_id::text AS id FROM instance_attestation WHERE teammate_id=${teammateId}::uuid LIMIT 1`
    return r!.id
  }
  const aliceInst = await mkInstance(alice, regionA, 'a.team')
  const evanInst = await mkInstance(evan, regionA, 'a.team')
  const bobInst = await mkInstance(bob, regionA, 'a.team')
  const biancaInst = await mkInstance(bianca, regionB, 'b')

  // attribution_record → the §A usage lane (v_complete_usage). cost_owning_unit_id set.
  const ar = async (inst: string, tm: string, region: string, cou: string, cost: number, day: string) => {
    await t.client`INSERT INTO attribution_record
        (instance_id, teammate_id, region_id, org_unit_id, cost_owning_unit_id, project_id, tool, model, token_type, tokens, cost_usd, fidelity_tier, cost_basis, ts_event, claude_session_id)
      VALUES (${inst}::uuid, ${tm}::uuid, ${region}::uuid, ${cou}::uuid, ${cou}::uuid, NULL::uuid, 'claude-code', 'claude-sonnet-4-6', 'input', 1000, ${cost}, 'tier-1', 'estimated', ${day}::timestamptz, ${'conv-' + tm + day})`
  }
  // April — the exempt-gap month (Anthropic only): alice 30 (chargeable) + evan 40 (exempt).
  await ar(aliceInst, alice, regionA, ccA, 30, '2026-04-05T00:00:00Z')
  await ar(evanInst, evan, regionA, ccA, 40, '2026-04-06T00:00:00Z')
  // May — the matched month usage (so the index is non-empty): alice/bob/bianca.
  await ar(aliceInst, alice, regionA, ccA, 30, '2026-05-05T00:00:00Z')
  await ar(bobInst, bob, regionA, ccA, 20, '2026-05-06T00:00:00Z')
  await ar(biancaInst, bianca, regionB, ccB, 10, '2026-05-07T00:00:00Z')

  // actual_spend → the §B Anthropic bill (chargeback + bill_totals). Exempt evan excluded.
  const asp = async (tm: string, cost: number, exempt: boolean, day: string) => {
    await t.client`INSERT INTO actual_spend (teammate_id, date, tool, input_tokens, output_tokens, cost_usd, source, chargeback_exempt)
      VALUES (${tm}::uuid, ${day}::date, 'claude-code', 500, 500, ${cost}, 'anthropic-analytics-api', ${exempt})`
  }
  await asp(alice, 30, false, '2026-04-05') // April chargeable
  await asp(evan, 40, true, '2026-04-06') // April EXEMPT → not chargeback, not bill
  await asp(alice, 30, false, '2026-05-05') // May chargeable
  await asp(bob, 20, false, '2026-05-06')
  await asp(bianca, 10, false, '2026-05-07') // region B

  // Copilot pooled bill (mig 0080) — a NAMED org O1 mapped to ccA.
  await t.client`INSERT INTO provider_enterprise (provider, external_id, display_name)
    VALUES ('github', 'ent-x', 'Enterprise X')`
  const [{ id: entId }] = await t.client<{ id: string }[]>`SELECT id::text AS id FROM provider_enterprise WHERE external_id='ent-x'`
  await t.client`INSERT INTO provider_org (provider, external_org_id, display_name, provider_enterprise_id, cost_owning_unit_id)
    VALUES ('github', 'octo', 'Octo Org', ${entId}::uuid, ${ccA}::uuid)`
  ;[{ id: orgO1 }] = await t.client<{ id: string }[]>`SELECT id::text AS id FROM provider_org WHERE external_org_id='octo'`
  // May — matched: license 200 + overage 100 = 300 net; pool 400, seats 4.
  await t.client`INSERT INTO copilot_pool_bill (month, provider_enterprise_id, provider_org_id, cost_owning_unit_id, seats, license_net_usd, overage_net_usd, included_allowance_usd, usage_gross_usd)
    VALUES ('2026-05-01'::date, ${entId}::uuid, ${orgO1}::uuid, ${ccA}::uuid, 4, 200, 100, 400, 500)`
  // June — UNSETTLED: license NULL (missing SKU) but usage_gross > 0; overage 50.
  await t.client`INSERT INTO copilot_pool_bill (month, provider_enterprise_id, provider_org_id, cost_owning_unit_id, seats, license_net_usd, overage_net_usd, included_allowance_usd, usage_gross_usd)
    VALUES ('2026-06-01'::date, ${entId}::uuid, ${orgO1}::uuid, ${ccA}::uuid, 4, NULL, 50, 400, 600)`
  // July — SETTLED with PAID overage 80, but the Overage-Drivers weight exercises the Σexcess=0
  // fallback: every teammate's July usage is BELOW their per-seat share (pool 400 / seats 4 = 100)
  // so no one has excess → shares distribute by RAW usage instead (L2 raw-usage fallback path).
  await t.client`INSERT INTO copilot_pool_bill (month, provider_enterprise_id, provider_org_id, cost_owning_unit_id, seats, license_net_usd, overage_net_usd, included_allowance_usd, usage_gross_usd)
    VALUES ('2026-07-01'::date, ${entId}::uuid, ${orgO1}::uuid, ${ccA}::uuid, 4, 200, 80, 400, 300)`
  // August — SETTLED with PAID overage 60, but NO teammate had Copilot usage this month → the
  // distribution has nothing to weight over (totalWeight = 0). The panel must still foot via a
  // single explicit "unallocated overage" row (L2 empty-distribution edge).
  await t.client`INSERT INTO copilot_pool_bill (month, provider_enterprise_id, provider_org_id, cost_owning_unit_id, seats, license_net_usd, overage_net_usd, included_allowance_usd, usage_gross_usd)
    VALUES ('2026-08-01'::date, ${entId}::uuid, ${orgO1}::uuid, ${ccA}::uuid, 4, 200, 60, 400, 300)`

  // reconciliation_record → per-teammate Copilot GROSS usage (v_teammate_usage_daily
  // copilot branch), the Overage-Drivers weight. May: alice 250, bob 150, carol 50.
  // Alice's 250 is deliberately SPLIT across the two §A usage lanes (mig 0086:
  // copilot_interactive → copilot-cli, copilot_coding_agent → copilot-agent): the
  // Overage-Drivers weight is ALL view-emitted Copilot usage (GITHUB_USAGE_VIEW_TOOLS), so her
  // May expectations below only foot if BOTH lanes weigh in.
  const rr = async (tm: string, usd: number, day: string, category = 'copilot_interactive') => {
    await t.client`INSERT INTO reconciliation_record
        (teammate_id, provider, enterprise_ref, period_date, category, scope, actual_usd, otel_attributed_usd, delta_usd, spend_class, disposition, status)
      VALUES (${tm}::uuid, 'github', 'ent-x', ${day}::date, ${category}, 'teammate', ${usd}, 0, ${usd}, 'indicative', 'ingest_only', 'proposed')`
  }
  await rr(alice, 200, '2026-05-15')
  await rr(alice, 50, '2026-05-15', 'copilot_coding_agent')
  await rr(bob, 150, '2026-05-15')
  await rr(carol, 50, '2026-05-15')
  // July — both BELOW the per-seat share (100): alice 50, bob 40 → Σexcess = 0 → raw-usage weight.
  await rr(alice, 50, '2026-07-15')
  await rr(bob, 40, '2026-07-15')
  // August — deliberately NO reconciliation rows → no teammate usage to distribute the overage over.
}, 180_000)

afterAll(async () => {
  await stopTestDb(t)
})

interface CouRow { couId: string | null; code: string | null; displayName: string; anthropicUsd: number; copilotUsd: number; copilotPending: boolean; chargeableUsd: number }
interface IndexResp {
  meta: { scope: string; month: string }
  billCheck: { chargebackUsd: number; billUsd: number; deltaUsd: number; matched: boolean; unsettled: boolean; copilotChargebackUsd: number; providers: { provider: string; billUsd: number; unsettled: boolean }[] }
  cous: CouRow[]
  copilot: { mode: string; pending: boolean; unclassifiedWarning: boolean }
  exemptGap: { indicativeUsageUsd: number; chargebackUsd: number; gapUsd: number; copilotChargebackUsd: number }
  homingNote: string
}
interface DrillResp {
  cou: { id: string; displayName: string }
  anthropicCharges: { teammateId: string; label: string; chargeUsd: number }[]
  anthropicChargeableUsd: number
  copilot: { mode: string; pending: boolean; pooledLines: { orgId: string | null; label: string; licenseUsd: number; overageUsd: number; netUsd: number; unsettled: boolean }[] | null; poolUtilisation: { usageGrossUsd: number; poolUsd: number; utilisation: number | null } | null; chargeableUsd: number | null; licenseNetUsd: number; overageNetUsd: number; unsettled: boolean }
  chargeableUsd: number
  projectOverlay: { label: string; usd: number; spendClass: string }[]
  projectHeadlineUsd: number
  overageDrivers: { overageNetUsd: number; perSeatShareUsd: number; rows: { key: string; label: string; usd: number; sharePct: number; spendClass: string }[] } | null
}

const couOf = (r: IndexResp, code: string) => r.cous.find((c) => c.code === code)

// ── RBAC (D-Q5): finance is org-wide BY ROLE DEFAULT. A `finance`
// report_access_grant authorises any role (report-access.test.ts), so these
// cases pin the ungranted baseline, not an exclusive gate. ────────────────────
describe('GET /reports/finance — RBAC (role default, no grants)', () => {
  it('platform-admin sees the whole-company chargeback pack', async () => {
    /*
     * ONE request, not two. The rename that retired `global-finops` turned both
     * callers here into the same platform-admin session, so this exercised one
     * persona twice and quietly stopped covering the boundary it was written
     * for. The retired role's denial is asserted in the loop below instead.
     */
    const pa = (await indexHandler(ev(sess('platform-admin', 'a', regionA, financeElevatedId), 'month=2026-05'))) as unknown as IndexResp
    expect(pa.meta.scope).toBe('finance')
  })

  for (const role of ['admin', 'manager', 'developer', 'finance', 'global-finops'] as const) {
    it(`a ${role} is FORBIDDEN (403) without a grant; neither retired enum member is a gate`, async () => {
      await expect(indexHandler(ev(sess(role, 'a', regionA), 'month=2026-05'))).rejects.toMatchObject({ statusCode: 403 })
      await expect(drillHandler(ev(sess(role, 'a', regionA), 'month=2026-05', { couId: ccA }))).rejects.toMatchObject({ statusCode: 403 })
      await expect(exportHandler(ev(sess(role, 'a', regionA), 'scope=finance&month=2026-05'))).rejects.toMatchObject({ statusCode: 403 })
    })
  }
})

// ── The VISIBLE Σ=bill check row ──────────────────────────────────────────────
describe('GET /reports/finance — the Σ=bill check row (green matched / RED unsettled)', () => {
  it('a settled month with a read license reconciles GREEN (Σ chargeback = Σ bill)', async () => {
    delete process.env.NUXT_COPILOT_CHARGEBACK_ENABLED
    const r = (await indexHandler(ev(gfo(), 'month=2026-05'))) as unknown as IndexResp
    // Anthropic 60 (alice 30 + bob 20 + bianca 10) + Copilot pooled net 300 = 360.
    expect(r.billCheck.chargebackUsd).toBeCloseTo(360, 6)
    expect(r.billCheck.billUsd).toBeCloseTo(360, 6)
    expect(r.billCheck.deltaUsd).toBeCloseTo(0, 6)
    expect(r.billCheck.matched).toBe(true)
    expect(r.billCheck.unsettled).toBe(false)
    const github = r.billCheck.providers.find((p) => p.provider === 'github')!
    expect(github.billUsd).toBeCloseTo(300, 6)
    expect(github.unsettled).toBe(false)
  })

  it('a month with Copilot usage but NO read license SKU is RED "unsettled" (never a silent pass)', async () => {
    const r = (await indexHandler(ev(gfo(), 'month=2026-06'))) as unknown as IndexResp
    // Copilot: COALESCE(NULL license,0) + 50 overage = 50; usage_gross>0 & license NULL → unsettled.
    expect(r.billCheck.chargebackUsd).toBeCloseTo(50, 6)
    expect(r.billCheck.billUsd).toBeCloseTo(50, 6)
    expect(r.billCheck.unsettled).toBe(true)
    expect(r.billCheck.matched).toBe(false) // RED even though the delta is 0
    expect(r.billCheck.providers.find((p) => p.provider === 'github')!.unsettled).toBe(true)
  })
})

// ── Exempt gap (indicative usage − chargeback, NOT showback−chargeback) ────────
describe('GET /reports/finance — exempt gap = indicative usage − chargeback', () => {
  it('a seeded exempt org surfaces as visible indicative usage with ZERO chargeback', async () => {
    const r = (await indexHandler(ev(gfo(), 'month=2026-04'))) as unknown as IndexResp
    // April usage (v_complete_usage) = alice 30 + evan 40 = 70; chargeback = alice 30 (evan EXEMPT).
    expect(r.exemptGap.indicativeUsageUsd).toBeCloseTo(70, 6)
    expect(r.exemptGap.chargebackUsd).toBeCloseTo(30, 6)
    expect(r.exemptGap.gapUsd).toBeCloseTo(40, 6) // evan's exempt usage — indicative, never charged
    // The exempt month still reconciles (exempt is excluded from BOTH bill + chargeback).
    expect(r.billCheck.matched).toBe(true)
  })
})

// ── Per-CoU chargeback table + copilot.mode gating ────────────────────────────
describe('GET /reports/finance — per-CoU chargeback + chargeback-mode vs pool-utilisation gating', () => {
  it('pool-utilisation mode: Copilot pooled net is held back "pending", not folded into chargeable', async () => {
    delete process.env.NUXT_COPILOT_CHARGEBACK_ENABLED
    const r = (await indexHandler(ev(gfo(), 'month=2026-05'))) as unknown as IndexResp
    expect(r.copilot.mode).toBe('pool-utilisation')
    expect(r.copilot.pending).toBe(true)
    const a = couOf(r, 'a')!
    expect(a.anthropicUsd).toBeCloseTo(50, 6) // alice 30 + bob 20
    expect(a.copilotUsd).toBeCloseTo(300, 6) // pooled net surfaced...
    expect(a.copilotPending).toBe(true)
    expect(a.chargeableUsd).toBeCloseTo(50, 6) // ...but NOT folded into the total
    const b = couOf(r, 'b')!
    expect(b.anthropicUsd).toBeCloseTo(10, 6)
    expect(b.copilotUsd).toBeCloseTo(0, 6)
  })

  it('chargeback mode folds the Copilot pooled net into the CoU chargeable total', async () => {
    process.env.NUXT_COPILOT_CHARGEBACK_ENABLED = 'true'
    try {
      const r = (await indexHandler(ev(gfo(), 'month=2026-05'))) as unknown as IndexResp
      expect(r.copilot.mode).toBe('chargeback')
      const a = couOf(r, 'a')!
      expect(a.copilotPending).toBe(false)
      expect(a.chargeableUsd).toBeCloseTo(350, 6) // 50 Anthropic + 300 Copilot pooled net
    } finally {
      delete process.env.NUXT_COPILOT_CHARGEBACK_ENABLED
    }
  })

  it('the region filter narrows the CoU table (convenience only — never a gate relaxation)', async () => {
    const r = (await indexHandler(ev(gfo(), `month=2026-05&region=${regionA}`))) as unknown as IndexResp
    expect(r.cous.map((c) => c.code).sort()).toEqual(['a']) // region B's ccB excluded from the table
    // The Σ=bill reconciliation stays whole-company regardless of the region view.
    expect(r.billCheck.chargebackUsd).toBeCloseTo(360, 6)
  })

  it('ADVISORY unclassifiedWarning (r1-F10): true ONLY when chargeback mode is ON and the window carries unclassified spend — never blocks data', async () => {
    // A September month with a $55 unclassified slice (2026-09 is untouched by every
    // other fixture month in this file; cleaned up in finally).
    const [{ id: entX }] = await t.client<{ id: string }[]>`
      SELECT id::text AS id FROM provider_enterprise WHERE external_id='ent-x'`
    await t.client`INSERT INTO copilot_pool_bill
        (month, provider_enterprise_id, provider_org_id, cost_owning_unit_id, seats,
         license_net_usd, overage_net_usd, unclassified_net_usd, included_allowance_usd, usage_gross_usd)
      VALUES ('2026-09-01'::date, ${entX}::uuid, ${orgO1}::uuid, ${ccA}::uuid, 4, 200, 100, 55, 400, 500)`
    process.env.NUXT_COPILOT_CHARGEBACK_ENABLED = 'true'
    try {
      // Chargeback mode + unclassified in-window → the advisory flag fires, and the
      // data is UNBLOCKED: the $55 stays out of every chargeable figure regardless.
      const warn = (await indexHandler(ev(gfo(), 'month=2026-09'))) as unknown as IndexResp
      expect(warn.copilot.unclassifiedWarning).toBe(true)
      expect(couOf(warn, 'a')!.chargeableUsd).toBeCloseTo(300, 6) // 200 + 100, never the 55
      // Same mode, a clean month → no warning.
      const clean = (await indexHandler(ev(gfo(), 'month=2026-05'))) as unknown as IndexResp
      expect(clean.copilot.unclassifiedWarning).toBe(false)
    } finally {
      delete process.env.NUXT_COPILOT_CHARGEBACK_ENABLED
      await t.client`DELETE FROM copilot_pool_bill WHERE month = '2026-09-01'::date`
    }
    // Pool-utilisation mode never warns — the advisory is chargeback-mode-scoped.
    const off = (await indexHandler(ev(gfo(), 'month=2026-05'))) as unknown as IndexResp
    expect(off.copilot.unclassifiedWarning).toBe(false)
  })
})

// ── Drill: Anthropic charges + Copilot pooled lines / pool card + project overlay
describe('GET /reports/finance/[couId] — the CoU drill', () => {
  it('chargeback mode: Anthropic per-teammate charges + Copilot per-org pooled lines', async () => {
    process.env.NUXT_COPILOT_CHARGEBACK_ENABLED = 'true'
    try {
      const d = (await drillHandler(ev(gfo(), 'month=2026-05', { couId: ccA }))) as unknown as DrillResp
      expect(d.cou.id).toBe(ccA)
      const byName = new Map(d.anthropicCharges.map((c) => [c.label, c.chargeUsd]))
      expect(byName.get('alice@a.test')).toBeCloseTo(30, 6)
      expect(byName.get('bob@a.test')).toBeCloseTo(20, 6)
      expect(byName.has('evan@a.test')).toBe(false) // exempt is never a chargeback row
      expect(d.anthropicChargeableUsd).toBeCloseTo(50, 6)
      // Copilot per-org pooled lines (org→CoU-map-homed).
      expect(d.copilot.pooledLines).not.toBeNull()
      const octo = d.copilot.pooledLines!.find((l) => l.label === 'Octo Org')!
      expect([octo.licenseUsd, octo.overageUsd, octo.netUsd]).toEqual([200, 100, 300])
      expect(d.copilot.poolUtilisation).toBeNull()
      expect(d.chargeableUsd).toBeCloseTo(350, 6)
    } finally {
      delete process.env.NUXT_COPILOT_CHARGEBACK_ENABLED
    }
  })

  it('pool-utilisation mode: a pool-utilisation card instead of pooled lines (chargeback held back)', async () => {
    delete process.env.NUXT_COPILOT_CHARGEBACK_ENABLED
    const d = (await drillHandler(ev(gfo(), 'month=2026-05', { couId: ccA }))) as unknown as DrillResp
    expect(d.copilot.pooledLines).toBeNull()
    expect(d.copilot.poolUtilisation).not.toBeNull()
    expect(d.copilot.poolUtilisation!.usageGrossUsd).toBeCloseTo(500, 6)
    expect(d.copilot.poolUtilisation!.poolUsd).toBeCloseTo(400, 6)
    expect(d.copilot.chargeableUsd).toBeNull()
    expect(d.chargeableUsd).toBeCloseTo(50, 6) // Anthropic only
  })

  it('the project overlay sums back to the Anthropic chargeable headline', async () => {
    const d = (await drillHandler(ev(gfo(), 'month=2026-05', { couId: ccA }))) as unknown as DrillResp
    const sum = d.projectOverlay.reduce((a, r) => a + r.usd, 0)
    expect(sum).toBeCloseTo(d.projectHeadlineUsd, 6)
    expect(d.projectHeadlineUsd).toBeCloseTo(50, 6)
  })
})

// ── Overage Drivers (D-Q6 layer 3) ────────────────────────────────────────────
describe('GET /reports/finance/[couId] — Overage Drivers (informational, never a charge)', () => {
  it('proportional shares SUM to the paid overage and carry NO charge field', async () => {
    process.env.NUXT_COPILOT_CHARGEBACK_ENABLED = 'true'
    try {
      const d = (await drillHandler(ev(gfo(), 'month=2026-05', { couId: ccA }))) as unknown as DrillResp
      expect(d.overageDrivers).not.toBeNull()
      const od = d.overageDrivers!
      expect(od.overageNetUsd).toBeCloseTo(100, 6)
      expect(od.perSeatShareUsd).toBeCloseTo(100, 6) // pool 400 / seats 4
      // alice usage 250 (200 interactive + 50 coding-agent — BOTH §A lanes weigh in) →
      // excess 150; bob 150 → excess 50; carol 50 → excess 0 (excluded).
      // Σexcess 200 → alice 150/200×100 = 75; bob 50/200×100 = 25. Σ = 100 = overage_net.
      // (Were copilot-agent excluded from the weight, alice would be 200 → 66.67 ≠ 75.)
      const byName = new Map(od.rows.map((r) => [r.label, r]))
      expect(byName.get('alice@a.test')!.usd).toBeCloseTo(75, 6)
      expect(byName.get('bob@a.test')!.usd).toBeCloseTo(25, 6)
      expect(byName.has('carol@a.test')).toBe(false) // no excess → not a driver
      expect(od.rows.reduce((a, r) => a + r.usd, 0)).toBeCloseTo(od.overageNetUsd, 6)
      // INFORMATIONAL — a §A display weight, never a charge (spendClass, no charge field).
      for (const r of od.rows) {
        expect(r.spendClass).toBe('indicative')
        expect(r).not.toHaveProperty('chargeUsd')
      }
    } finally {
      delete process.env.NUXT_COPILOT_CHARGEBACK_ENABLED
    }
  })

  it('the Overage Drivers panel is ABSENT in pool-utilisation mode (chargeback gated)', async () => {
    delete process.env.NUXT_COPILOT_CHARGEBACK_ENABLED
    const d = (await drillHandler(ev(gfo(), 'month=2026-05', { couId: ccA }))) as unknown as DrillResp
    expect(d.overageDrivers).toBeNull()
  })

  it('Σexcess=0 → the shares distribute by RAW usage and still SUM to the paid overage (L2 fallback)', async () => {
    process.env.NUXT_COPILOT_CHARGEBACK_ENABLED = 'true'
    try {
      // July: overage 80, per-seat share 100; alice 50 & bob 40 are both under → Σexcess = 0.
      const d = (await drillHandler(ev(gfo(), 'month=2026-07', { couId: ccA }))) as unknown as DrillResp
      const od = d.overageDrivers!
      expect(od.overageNetUsd).toBeCloseTo(80, 6)
      const byName = new Map(od.rows.map((r) => [r.label, r.usd]))
      // Weight = raw usage: alice 50/90×80 = 44.444…, bob 40/90×80 = 35.555….
      expect(byName.get('alice@a.test')!).toBeCloseTo((50 / 90) * 80, 6)
      expect(byName.get('bob@a.test')!).toBeCloseTo((40 / 90) * 80, 6)
      // The fallback still foots exactly to the paid overage — no unallocated row.
      expect(od.rows.reduce((a, r) => a + r.usd, 0)).toBeCloseTo(80, 6)
      expect(od.rows.some((r) => r.key === '__unallocated')).toBe(false)
    } finally {
      delete process.env.NUXT_COPILOT_CHARGEBACK_ENABLED
    }
  })

  it('PAID overage but NO usage to distribute → one explicit unallocated row that foots (L2 edge)', async () => {
    process.env.NUXT_COPILOT_CHARGEBACK_ENABLED = 'true'
    try {
      // August: overage 60 but no teammate had Copilot usage → totalWeight 0.
      const d = (await drillHandler(ev(gfo(), 'month=2026-08', { couId: ccA }))) as unknown as DrillResp
      const od = d.overageDrivers!
      expect(od.overageNetUsd).toBeCloseTo(60, 6)
      expect(od.rows).toHaveLength(1)
      const [row] = od.rows
      expect(row.key).toBe('__unallocated')
      expect(row.usd).toBeCloseTo(60, 6) // the whole paid overage lands in the unallocated row
      expect(row.spendClass).toBe('indicative') // informational, never a charge
      // The informational panel foots to the paid overage — the sum-back never RED-mismatches.
      expect(od.rows.reduce((a, r) => a + r.usd, 0)).toBeCloseTo(60, 6)
    } finally {
      delete process.env.NUXT_COPILOT_CHARGEBACK_ENABLED
    }
  })
})

// ── M2: an UNSETTLED CoU-month drill surfaces `copilot.unsettled` (never a silent drop) ─
describe('GET /reports/finance/[couId] — unsettled CoU-month (M2)', () => {
  it('chargeback mode: a pooled line with usage but NO read license SKU sets copilot.unsettled', async () => {
    process.env.NUXT_COPILOT_CHARGEBACK_ENABLED = 'true'
    try {
      // June ccA: license NULL + usage_gross 600 → the CoU-month is unsettled; chargeableUsd (50)
      // silently drops the unread license, so the flag must carry so the UI caveats it.
      const d = (await drillHandler(ev(gfo(), 'month=2026-06', { couId: ccA }))) as unknown as DrillResp
      expect(d.copilot.unsettled).toBe(true)
      expect(d.copilot.pooledLines!.some((l) => l.unsettled)).toBe(true)
    } finally {
      delete process.env.NUXT_COPILOT_CHARGEBACK_ENABLED
    }
  })

  it('a fully-settled CoU-month (read license present) does NOT flag unsettled', async () => {
    process.env.NUXT_COPILOT_CHARGEBACK_ENABLED = 'true'
    try {
      const d = (await drillHandler(ev(gfo(), 'month=2026-05', { couId: ccA }))) as unknown as DrillResp
      expect(d.copilot.unsettled).toBe(false)
    } finally {
      delete process.env.NUXT_COPILOT_CHARGEBACK_ENABLED
    }
  })
})

// ── M1: the held-back Copilot delta is on the server so the pool-utilisation caption is exact ──
describe('GET /reports/finance — held-back Copilot delta for the pool-utilisation caption (M1)', () => {
  it('pool-utilisation mode: billCheck + exemptGap carry the exact Copilot pooled-net held back from Chargeable', async () => {
    delete process.env.NUXT_COPILOT_CHARGEBACK_ENABLED
    const r = (await indexHandler(ev(gfo(), 'month=2026-05'))) as unknown as IndexResp
    expect(r.copilot.pending).toBe(true)
    // May Copilot pooled net = 300 (license 200 + overage 100), whole-company + region-scoped.
    expect(r.billCheck.copilotChargebackUsd).toBeCloseTo(300, 6)
    expect(r.exemptGap.copilotChargebackUsd).toBeCloseTo(300, 6)
    // The Σ=bill check itself stays whole-truth (NOT mode-gated) — includes the pooled net.
    expect(r.billCheck.chargebackUsd).toBeCloseTo(360, 6)
  })

  it('the held-back figure equals the CoU table Copilot column (they reconcile against the caption)', async () => {
    delete process.env.NUXT_COPILOT_CHARGEBACK_ENABLED
    const r = (await indexHandler(ev(gfo(), 'month=2026-05'))) as unknown as IndexResp
    const couCopilotTotal = r.cous.reduce((a, c) => a + c.copilotUsd, 0)
    expect(r.billCheck.copilotChargebackUsd).toBeCloseTo(couCopilotTotal, 6)
  })
})

// ── Range/quarter mode: the drill sums the whole period (== the index per-CoU total) ──
describe('GET /reports/finance/[couId] — quarter mode sums the period (mirrors the index)', () => {
  // Q2 2026 (Apr–Jun) as a custom range. The finance INDEX sums the 3 period_months; the
  // per-CoU DRILL must window the SAME range so its Chargeable foots to the index per-CoU
  // total. Before the fix the drill collapsed a quarter to its FIRST month → 1/3 of it.
  const Q2 = 'from=2026-04-01&to=2026-06-30'

  it('chargeback mode: the drill Chargeable == the index per-CoU Chargeable over the quarter (430)', async () => {
    process.env.NUXT_COPILOT_CHARGEBACK_ENABLED = 'true'
    try {
      const idx = (await indexHandler(ev(gfo(), Q2))) as unknown as IndexResp
      const drill = (await drillHandler(ev(gfo(), Q2, { couId: ccA }))) as unknown as DrillResp
      const a = couOf(idx, 'a')!
      // Anthropic: April 30 + May (alice 30 + bob 20) = 80 — the WHOLE quarter, not just April.
      expect(drill.anthropicChargeableUsd).toBeCloseTo(80, 6)
      expect(a.anthropicUsd).toBeCloseTo(80, 6)
      // Copilot pooled net: May (license 200 + overage 100) + June (license 0 + overage 50) = 350.
      expect(drill.copilot.licenseNetUsd + drill.copilot.overageNetUsd).toBeCloseTo(350, 6)
      expect(a.copilotUsd).toBeCloseTo(350, 6)
      // The drill Chargeable foots to the index per-CoU Chargeable (both 80 + 350 = 430).
      expect(drill.chargeableUsd).toBeCloseTo(430, 6)
      expect(drill.chargeableUsd).toBeCloseTo(a.chargeableUsd, 6)
      // Copilot octo appears in May AND June — the drill GROUPs it into ONE summed line.
      expect(drill.copilot.pooledLines!.filter((l) => l.label === 'Octo Org')).toHaveLength(1)
    } finally {
      delete process.env.NUXT_COPILOT_CHARGEBACK_ENABLED
    }
  })

  it('an UNSETTLED month inside the quarter is NOT masked by a settled month in the same range', async () => {
    process.env.NUXT_COPILOT_CHARGEBACK_ENABLED = 'true'
    try {
      // June (license NULL + usage 600) is inside Q2 alongside settled May — the range must
      // STILL report unsettled (bool_or of the per-month predicate), never a silent pass.
      const drill = (await drillHandler(ev(gfo(), Q2, { couId: ccA }))) as unknown as DrillResp
      expect(drill.copilot.unsettled).toBe(true)
    } finally {
      delete process.env.NUXT_COPILOT_CHARGEBACK_ENABLED
    }
  })
})

// ── Anti-IDOR on couId ────────────────────────────────────────────────────────
describe('GET /reports/finance/[couId] — anti-IDOR', () => {
  it('a non-existent CoU uuid → 404 (resolvable id, just absent)', async () => {
    await expect(
      drillHandler(ev(gfo(), 'month=2026-05', { couId: '11111111-1111-4111-8111-111111111111' })),
    ).rejects.toMatchObject({ statusCode: 404 })
  })

  it('a malformed couId → 400', async () => {
    await expect(
      drillHandler(ev(gfo(), 'month=2026-05', { couId: 'not-a-uuid' })),
    ).rejects.toMatchObject({ statusCode: 400 })
  })

  it('a 36-char but non-UUID couId (all dashes) → 400, NOT a 500 on the ::uuid cast (L1)', async () => {
    // '------------------------------------' is 36 chars, passes the old lax [0-9a-f-]{36} regex,
    // then 500s on ::uuid. z.string().uuid() rejects it up front → a clean 400.
    await expect(
      drillHandler(ev(gfo(), 'month=2026-05', { couId: '-'.repeat(36) })),
    ).rejects.toMatchObject({ statusCode: 400 })
  })
})

// ── Ledger CSV byte-identical + settling honesty ──────────────────────────────
describe('GET /reports/export?scope=finance — the ledger (cost-centre × provider × month)', () => {
  it('the ledger CSV rows carry the SAME figures as the per-CoU JSON', async () => {
    process.env.NUXT_COPILOT_CHARGEBACK_ENABLED = 'true'
    try {
      const json = (await indexHandler(ev(gfo(), 'month=2026-05'))) as unknown as IndexResp
      const csv = (await exportHandler(ev(gfo(), 'scope=finance&month=2026-05'))) as unknown as string
      const lines = csv.trim().split('\n')
      expect(lines[0]).toMatch(/^# tokenscope finance ledger/)
      // mig 0085 lane split: the ledger carries a `lane` column — github rows are
      // per §B chargeback lane; the anthropic row stays aggregate (blank lane). The
      // column is APPENDED (additive-only convention, r1 finding 4) so index-based
      // consumers keep every pre-split column position.
      expect(lines[1]).toBe('cost_centre,region,provider,month,charge_usd,chargeback_pending,settling_state,lane')
      // ccA → one anthropic row (50.00) + one github row PER non-zero lane
      // (license 200 + usage 100 = the pre-split 300, not pending).
      expect(csv).toMatch(/^a,ra,anthropic,2026-05,50\.00,false,[^,]*,$/m)
      expect(csv).toMatch(/^a,ra,github,2026-05,200\.00,false,[^,]*,copilot-license$/m)
      expect(csv).toMatch(/^a,ra,github,2026-05,100\.00,false,[^,]*,copilot-usage$/m)
      // Zero-amount lanes are skipped (no unclassified fixture → no unclassified row).
      expect(csv).not.toContain('copilot-unclassified')
      // ccB → anthropic 10.00, no github rows (copilotUsd 0).
      expect(csv).toMatch(/^b,rb,anthropic,2026-05,10\.00,false,[^,]*,$/m)
      const a = couOf(json, 'a')!
      expect(a.anthropicUsd.toFixed(2)).toBe('50.00')
      expect(a.copilotUsd.toFixed(2)).toBe('300.00')
    } finally {
      delete process.env.NUXT_COPILOT_CHARGEBACK_ENABLED
    }
  })

  it('the export inherits the finance gate (a manager is 403)', async () => {
    await expect(
      exportHandler(ev(sess('manager', 'a', regionA), 'scope=finance&month=2026-05')),
    ).rejects.toMatchObject({ statusCode: 403 })
  })
})

// ── "finalised" grep + homing disclosure ──────────────────────────────────────
describe('GET /reports/finance — settling honesty + homing disclosure', () => {
  it('no finance response contains the banned string "finalised"', async () => {
    process.env.NUXT_COPILOT_CHARGEBACK_ENABLED = 'true'
    try {
      const idx = (await indexHandler(ev(gfo(), 'month=2026-05'))) as unknown as IndexResp
      const drill = (await drillHandler(ev(gfo(), 'month=2026-05', { couId: ccA }))) as unknown as DrillResp
      const csv = (await exportHandler(ev(gfo(), 'scope=finance&month=2026-05'))) as unknown as string
      expect(JSON.stringify(idx).toLowerCase()).not.toContain('finalised')
      expect(JSON.stringify(idx).toLowerCase()).not.toContain('finalized')
      expect(JSON.stringify(drill).toLowerCase()).not.toContain('finalised')
      expect(csv.toLowerCase()).not.toContain('finalised')
    } finally {
      delete process.env.NUXT_COPILOT_CHARGEBACK_ENABLED
    }
  })

  it('every finance surface carries the current-org homing disclosure', async () => {
    const idx = (await indexHandler(ev(gfo(), 'month=2026-05'))) as unknown as IndexResp
    expect(idx.meta).not.toHaveProperty('pointInTimeDims')
    expect(idx.homingNote.toLowerCase()).toContain('current org structure')
  })

  it('Finance defaults to the LAST COMPLETE month when no month is given', async () => {
    const r = (await indexHandler(ev(gfo()))) as unknown as IndexResp
    const now = new Date()
    const lastComplete = (() => {
      const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 0))
      return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`
    })()
    expect(r.meta.month).toBe(lastComplete)
  })
})
