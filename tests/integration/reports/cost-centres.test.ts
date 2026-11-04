// @vitest-environment node
/*
 * Cost-Centre reporting scope — the Wave 3 endpoints (`/reports/cost-centres{,/
 * [ccId]}`, `/reports/export?scope=cost-centre`) exercised against a real
 * testcontainers Postgres via the OWNER connection (RLS inert in prod too, so the
 * in-query scope clauses are what's tested). Covers build-design §7:
 *   - RBAC: owner sees only owned + subtree cost-owning; non-owner/foreign 403;
 *     anti-IDOR on `ccId` (foreign region → 403, missing → 404);
 *   - the burn drill RECONCILES to the tracker card burn (both the §A PROJECT-CoU
 *     usage axis) — incl. a spender who now sits in another region, whose
 *     project-tagged spend stays on the project's Business Unit, and the
 *     NULL-CoU Copilot gap is excluded from both;
 *   - forecast (run-rate $) + exhaustion (budget DATE) are distinct mechanics;
 *   - burn drivers sum-back = headline (each drill axis, incl. the NULL bucket);
 *   - month-boundary invariance;
 *   - export byte-identical to the JSON figures.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'
import { buildUsageRollup } from '../helpers/usage-rollup'
import { injectTestSession } from '../../helpers/auth'
import { grantReportAccess } from '../helpers/report-access'
import type { Session } from '../../../server/utils/auth'
import cardsHandler from '../../../server/api/v1/reports/cost-centres/index.get'
import drillHandler from '../../../server/api/v1/reports/cost-centres/[ccId].get'
import exportHandler from '../../../server/api/v1/reports/export.get'
import trendHandler from '../../../server/api/v1/reports/cost-centres/[ccId]/trend.get'
// Asserted through the CONSTANT: these check WHICH DENOMINATOR the payload
// names, not the noun it is currently spelled with.
import { BU_LABEL_LOWER } from '../../../shared/reports/vocabulary'

let t: TestDb
let regionA = ''
let regionB = ''
let ccA = '' // cost-owning practice 'a' (region A)
let ccCur = '' // cost-owning 'cur' (region A) — current-month forecast fixture
let ccB = '' // cost-owning 'b' (region B)
let alice = ''
let ownerDev = ''
let devInCc = '' // a developer placed IN ccA — subtree covers it, owns nothing
let projA = ''
let projB = '' // ccB's lead project — the three-arm clamp fixture
/*
 * mig 0129: a DEDICATED teammate for this file's 'platform-admin' sessions —
 * NEVER the shared sess() default sentinel ('00000000-0000-0000-0000-
 * 000000000009', already backed by the "Caller" row below for the audit FK).
 * adminA() and the anti-IDOR 403 tests ALSO resolve to that sentinel, and
 * granting it would silently widen those region-clamped 403 assertions via
 * the 'operational' overlay's unbounded/all-regions grant.
 */
let costCentresElevatedId = ''

const now = new Date()
const currentMonth = now.toISOString().slice(0, 7)
const currentMonthStartIso = new Date(
  Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1),
).toISOString()

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
  return e as unknown as Parameters<typeof cardsHandler>[0]
}
const sess = (role: string, orgPath: string, regionId: string, teammateId = '00000000-0000-0000-0000-000000000009'): Session =>
  ({ teammateId, email: 'x@x.test', displayName: 'X', role, regionId, orgPath, issuedAt: new Date().toISOString() } as unknown as Session)

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

  const mkUnit = async (region: string, path: string, code: string, costOwning: boolean, type = 'bu', parent: string | null = null) => {
    await t.client`INSERT INTO org_unit (region_id, parent_id, path, code, display_name, unit_type, is_cost_owning_unit)
      VALUES (${region}::uuid, ${parent}::uuid, ${path}::ltree, ${code}, ${code}, ${type}, ${costOwning})`
    const [r] = await t.client<{ id: string }[]>`SELECT id::text AS id FROM org_unit WHERE region_id=${region}::uuid AND code=${code}`
    return r!.id
  }
  // S3 part (a): 'a' (ccA) is used below as a MANAGER's own placement, which now must
  // pass placedBelowRegionRootPredicate() (parent_id IS NOT NULL). unit_type 'holding'
  // keeps this placeholder out of every §A/§B query (none select holding units).
  const s3RegionARootId = await mkUnit(regionA, 'ra_root', '__s3_root__', false, 'holding')
  ccA = await mkUnit(regionA, 'a', 'a', true, 'bu', s3RegionARootId)
  await mkUnit(regionA, 'a.team', 'a-team', false, 'team') // where alice/ellen/frank home → nearest CoU 'a'
  await mkUnit(regionA, 'a.owners', 'a-owners', false, 'team') // ownerDev's home (no cost-owning descendants)
  ccCur = await mkUnit(regionA, 'cur', 'cur', true)
  ccB = await mkUnit(regionB, 'b', 'b', true)

  const mkTeammate = async (region: string, path: string, email: string) => {
    const [u] = await t.client<{ id: string }[]>`SELECT id::text AS id FROM org_unit WHERE region_id=${region}::uuid AND path=${path}::ltree`
    await t.client`INSERT INTO teammate (entra_oid, email, display_name, region_id, org_unit_id, is_active)
      VALUES ('oid-'||${email}, ${email}, ${email}, ${region}::uuid, ${u!.id}::uuid, true)`
    const [r] = await t.client<{ id: string }[]>`SELECT id::text AS id FROM teammate WHERE email=${email}`
    return r!.id
  }
  alice = await mkTeammate(regionA, 'a.team', 'alice@a.test')
  const carol = await mkTeammate(regionA, 'cur', 'carol@a.test')
  const daveNull = await mkTeammate(regionA, 'a.team', 'dave@a.test')
  ownerDev = await mkTeammate(regionA, 'a.owners', 'owner@a.test')
  /*
   * The caller that tells the two gates apart. Placed AT ccA's own path, so
   * `orgSubtreeScopePredicate` covers it and `resolveCostCentreDrill` is happy —
   * but a developer who owns no centre gets `costCentre: false`
   * (shared/auth/report-visibility.ts standardGrants). Before `requireReportScope`
   * was added to these two routes, this session read a cost centre the policy
   * denies. Every other denial case in this file 403s at the RESOURCE gate, so
   * none of them notice if the scope gate is removed — verified by mutation.
   */
  devInCc = await mkTeammate(regionA, 'a', 'dev-in-cc@a.test')
  // Phil H — ccA's largest spender, now placed in REGION B (a role/region change);
  // his July usage still HOMED to ccA at emit, so §A keeps him in ccA's burn drill.
  const phil = await mkTeammate(regionB, 'b', 'phil@b.test')

  // ownerDev OWNS ccA (a relationship, not a role) — sits outside their own subtree.
  await t.client`INSERT INTO cou_owner (org_unit_id, teammate_id) VALUES (${ccA}::uuid, ${ownerDev}::uuid)`

  /*
   * THE DEFAULT CALLER (`sess()`'s teammateId), as a real teammate row. The
   * teammate-axis drivers export now writes a `report-export-teammate-axis`
   * audit row, and `audit_event.actor_teammate_id` REFERENCES teammate(id) — a
   * session whose id has no row is a FK violation at export time.
   *
   * Homed on the 'holding' placeholder, which no §A/§B query selects, so this
   * caller cannot appear in a burn, a driver ranking or a roster.
   */
  await t.client`INSERT INTO teammate (id, entra_oid, email, display_name, region_id, org_unit_id, is_active)
    VALUES ('00000000-0000-0000-0000-000000000009'::uuid, 'oid-caller', 'caller@a.test', 'Caller',
            ${regionA}::uuid, ${s3RegionARootId}::uuid, true)`

  // A SEPARATE, DEDICATED teammate for this file's 'platform-admin' sessions
  // (mig 0129) — see the `costCentresElevatedId` declaration above.
  await t.client`INSERT INTO teammate (entra_oid, email, display_name, region_id, org_unit_id, role, is_active)
    VALUES ('oid-finops-elevated', 'finops-elevated@a.test', 'Finops Elevated', ${regionA}::uuid, ${ccA}::uuid, 'platform-admin', true)`
  ;[{ id: costCentresElevatedId }] = await t.client<{ id: string }[]>`SELECT id::text AS id FROM teammate WHERE email='finops-elevated@a.test'`
  await grantReportAccess(t.client, costCentresElevatedId)

  // Projects (allocation source, homed to the CC).
  await t.client`INSERT INTO project (code, code_hash, display_name, type, region_id, cost_owning_unit_id)
    VALUES ('PROJ-A', 'hash-a', 'Project A', 'billable', ${regionA}::uuid, ${ccA}::uuid)`
  ;[{ id: projA }] = await t.client<{ id: string }[]>`SELECT id::text AS id FROM project WHERE code='PROJ-A'`
  await t.client`INSERT INTO project (code, code_hash, display_name, type, region_id, cost_owning_unit_id)
    VALUES ('PROJ-CUR', 'hash-cur', 'Project Cur', 'billable', ${regionA}::uuid, ${ccCur}::uuid)`
  const [{ id: projCur }] = await t.client<{ id: string }[]>`SELECT id::text AS id FROM project WHERE code='PROJ-CUR'`

  // Allocations: ccA has 100 (burn 50 → 50% util); ccCur has 50 (burn 100 → over budget).
  await t.client`INSERT INTO audit_event (event_type, actor_system, payload) VALUES ('seed', 'test', '{}'::jsonb)`
  const [{ id: auditId }] = await t.client<{ id: string }[]>`SELECT id::text AS id FROM audit_event ORDER BY ts_recorded DESC LIMIT 1`
  await t.client`INSERT INTO allocation (scope_type, scope_id, budget_usd, effective, allocation_kind, audit_event_id)
    VALUES ('project', ${projA}::uuid, 100.00, tstzrange('2020-01-01', NULL, '[)'), 'baseline', ${auditId}::uuid)`
  await t.client`INSERT INTO allocation (scope_type, scope_id, budget_usd, effective, allocation_kind, audit_event_id)
    VALUES ('project', ${projCur}::uuid, 50.00, tstzrange('2020-01-01', NULL, '[)'), 'baseline', ${auditId}::uuid)`

  const mkInstance = async (teammateId: string, region: string, path: string) => {
    const [u] = await t.client<{ id: string }[]>`SELECT id::text AS id FROM org_unit WHERE region_id=${region}::uuid AND path=${path}::ltree`
    await t.client`INSERT INTO instance_attestation (instance_id, principal_oid, teammate_id, tool, region_id, org_unit_id, project_code_hash, raw_project_code)
      VALUES (gen_random_uuid(), 'p', ${teammateId}::uuid, 'claude-code', ${region}::uuid, ${u!.id}::uuid, 'h', 'P')`
    const [r] = await t.client<{ id: string }[]>`SELECT instance_id::text AS id FROM instance_attestation WHERE teammate_id=${teammateId}::uuid LIMIT 1`
    return r!.id
  }
  const aliceInst = await mkInstance(alice, regionA, 'a.team')
  const carolInst = await mkInstance(carol, regionA, 'cur')
  const philInst = await mkInstance(phil, regionB, 'b')

  // Attribution = the PROJECT-CoU usage axis (cost_owning_unit_id set explicitly).
  const ar = async (inst: string, tm: string, region: string, cou: string, model: string, cost: number, day: string, projectId: string | null, tool = 'claude-code') => {
    const [u] = await t.client<{ id: string }[]>`SELECT id::text AS id FROM org_unit WHERE id=${cou}::uuid`
    await t.client`INSERT INTO attribution_record
        (instance_id, teammate_id, region_id, org_unit_id, cost_owning_unit_id, project_id, tool, model, token_type, tokens, cost_usd, fidelity_tier, cost_basis, ts_event, claude_session_id)
      VALUES (${inst}::uuid, ${tm}::uuid, ${region}::uuid, ${u!.id}::uuid, ${cou}::uuid, ${projectId}::uuid, ${tool}, ${model}, 'input', 1000, ${cost}, 'tier-1', 'estimated', ${day}::timestamptz, ${'conv-' + tm + day + tool})`
  }
  // ccA — alice: July sonnet 30 + opus 20 = 50 (project-CoU axis); June sonnet 15.
  await ar(aliceInst, alice, regionA, ccA, 'claude-sonnet-4-6', 30, '2026-07-02T00:00:00Z', projA)
  await ar(aliceInst, alice, regionA, ccA, 'claude-opus-4-6', 20, '2026-07-03T00:00:00Z', projA)
  await ar(aliceInst, alice, regionA, ccA, 'claude-sonnet-4-6', 15, '2026-06-05T00:00:00Z', projA)
  /*
   * The VENDOR-CLASSIFICATION fixture, in MAY so it perturbs no July/June figure.
   * Four surfaces, one cost centre: Claude Code and a non-Code Claude surface,
   * Copilot CLI and the Copilot coding agent. Before the shared classifier the
   * split matched only the bare literals 'claude-code' / 'copilot-cli', so
   * claude-ai and copilot-agent BOTH landed in "Other" — on a chat-heavy centre
   * that read "Other · 100%" while the People card split the same money by model.
   */
  await ar(aliceInst, alice, regionA, ccA, 'claude-sonnet-4-6', 11, '2026-05-04T00:00:00Z', projA, 'claude-code')
  await ar(aliceInst, alice, regionA, ccA, 'gpt-5', 5, '2026-05-06T00:00:00Z', projA, 'copilot-cli')
  /*
   * `claude-ai` CANNOT be seeded through `attribution_record`: the non-Code
   * Claude surfaces are INGEST-ONLY (surface.ts:111) and every attribution arm
   * of `v_complete_usage` excludes them by name. They reach §A on the
   * PROVIDER-FACT arm instead — which is why the misclassification was
   * unreachable from arm 1 and survived every existing test.
   *
   * That arm is a JOIN, so both halves are required and must agree:
   *   - `actual_spend` supplies the day and the COST-OWNING UNIT (via
   *     v_teammate_usage_daily) — this is what makes it a cost-centre's burn;
   *   - `provider_usage_fact` supplies the MODEL grain, and the arm demands
   *     `fm.key_usd <= vtd.usage_usd`, so the fact money may not exceed the
   *     day's actual spend. Both are 7.
   */
  await t.client`INSERT INTO actual_spend
      (teammate_id, date, tool, input_tokens, output_tokens, cost_usd, source, chargeback_exempt, region_id, org_unit_id, cost_owning_unit_id)
    VALUES (${alice}::uuid, '2026-05-05'::date, 'claude-ai', 500, 500, 7, 'anthropic-analytics-api', false, ${regionA}::uuid, ${ccA}::uuid, ${ccA}::uuid)`
  await t.client`INSERT INTO provider_usage_fact
      (source, provider, teammate_id, actor_ref, date, tool, model, cost_type, cost_usd, currency)
    VALUES ('anthropic-analytics-api', 'anthropic', ${alice}::uuid, 'alice@a.test', '2026-05-05'::date, 'claude-ai', 'claude-sonnet-4-6', 'tokens', 7, 'USD')`
  // ccCur — carol: current-month burn 100 (forecast/exhaustion fixture).
  await ar(carolInst, carol, regionA, ccCur, 'claude-sonnet-4-6', 100, currentMonthStartIso, projCur)
  // ccA — phil: July opus 90, emit-homed to ccA (region A) though he now sits in region B.
  // His row is tagged to projA, so it counts toward projA's Business Unit (ccA)
  // wherever he sits (the current-org lens keeps the project axis).
  await ar(philInst, phil, regionA, ccA, 'claude-opus-4-6', 90, '2026-07-04T00:00:00Z', projA)

  // NULL-CoU Copilot gap (unaccounted): must NEVER appear in any CC burn.
  await t.client`INSERT INTO unaccounted_usage (teammate_id, region_id, org_unit_id, day, tool, cost_usd, tokens, source)
    VALUES (${daveNull}::uuid, ${regionA}::uuid, (SELECT id FROM org_unit WHERE region_id=${regionA}::uuid AND path='a.team'::ltree), '2026-07-10'::date, 'copilot-cli', 30, 0, 'api-reconciled')`

  // §B chargeback bill (region A, July) — alice actual_spend homes (teammate org_unit
  // 'a.team' → nearest cost-owning ancestor ccA) to ccA. Feeds the per-CC `chargeUsd`
  // (bill lane), NOT the burn (v_complete_usage). Distinct from the burn on purpose.
  await t.client`INSERT INTO actual_spend (teammate_id, date, tool, input_tokens, output_tokens, cost_usd, source, chargeback_exempt)
    VALUES (${alice}::uuid, '2026-07-06'::date, 'claude-code', 800, 800, 40, 'anthropic-analytics-api', false)`

  /*
   * ── ccB: ALL THREE ARMS of the §A lane, on ONE cost centre ─────────────────
   * The project-axis clamp fixture. Kept on ccB (region B, untouched by every
   * assertion above) so the three arms are the ONLY thing this cost centre says,
   * and so ccA's heavily-pinned figures do not move.
   *
   * The whole point is that the arms are NOT uniform (mig 0101/0113):
   *   arm 1 otel-emitted   — real cost_owning_unit_id AND real project_id.
   *   arm 2 api-reconciled — cost_owning_unit_id NULL BY CONSTRUCTION, project real.
   *   arm 3 provider-usage — cost_owning_unit_id real, project_id NULL BY CONSTRUCTION.
   * So the burn axis (clamped on the usage row) sees arms 1+3, and the project
   * axis (clamped on the PROJECT's own cost centre) sees arms 1+2. Distinct
   * amounts (10 / 40 / 7) so no pair can swap without the assertion noticing.
   */
  await t.client`INSERT INTO project (code, code_hash, display_name, type, region_id, cost_owning_unit_id)
    VALUES ('PROJ-B', 'hash-b', 'Project B', 'billable', ${regionB}::uuid, ${ccB}::uuid)`
  ;[{ id: projB }] = await t.client<{ id: string }[]>`SELECT id::text AS id FROM project WHERE code='PROJ-B'`
  // Arm 1 — emitted, homed to ccB, tagged to ccB's own project.
  await ar(philInst, phil, regionB, ccB, 'claude-sonnet-4-6', 10, '2026-07-05T00:00:00Z', projB)
  // Arm 2 — the API−OTel reconciliation gap: a REAL project claim with NO cost
  // owning unit (the view hard-codes NULL::uuid on this arm). At today's adoption
  // most consumption arrives this way, which is exactly why the clamp matters.
  await t.client`INSERT INTO unaccounted_usage (teammate_id, region_id, org_unit_id, day, tool, cost_usd, tokens, source, project_id)
    VALUES (${phil}::uuid, ${regionB}::uuid, ${ccB}::uuid, '2026-07-06'::date, 'claude-code', 40, 0, 'api-reconciled', ${projB}::uuid)`
  // Arm 3 — the ingest-only lane: homed to ccB, untaggable by construction. In
  // the BURN, and structurally absent from any project axis.
  await t.client`INSERT INTO actual_spend
      (teammate_id, date, tool, input_tokens, output_tokens, cost_usd, source, chargeback_exempt,
       region_id, org_unit_id, cost_owning_unit_id, dimension_source)
    VALUES (${phil}::uuid, '2026-07-07'::date, 'claude-ai', 100, 100, 7, 'anthropic-analytics-api', false,
       ${regionB}::uuid, ${ccB}::uuid, ${ccB}::uuid, 'ingest-snapshot')`

  // The region reports' §A reads come from usage_rollup_daily (usage-rollup-
  // lane.md R5/R8): materialise it from the seeds above via the real worker.
  await buildUsageRollup(t.db)
}, 180_000)

afterAll(async () => {
  await stopTestDb(t)
})

interface Card { id: string; code: string; burnUsd: number; chargeUsd: number; allocationUsd: number; utilisation: number | null; exhaustionDate: string | null; forecast: { projectedUsd: number } | null }
interface CardsResp { cards: Card[]; laneNote: string; meta: { scope: string } }
interface DrillResp {
  cc: { id: string; code: string }
  burnUsd: number
  chargeUsd: number
  copilotChargebackPartialMonth: boolean
  vendor: { claudeUsd: number; copilotUsd: number; otherUsd: number }
  allocationUsd: number
  axis: string; headlineUsd: number; denominatorLabel: string
  rows: { key: string; label: string; usd: number; sharePct: number; spendClass: string }[]
}

const adminA = () => sess('admin', 'a', regionA)
const ccOf = (r: CardsResp, code: string) => r.cards.find((c) => c.code === code)

describe('GET /reports/cost-centres — RBAC scope (owned ∪ subtree cost-owning)', () => {
  it('a pure owner (developer) sees ONLY their owned CC — not a region sibling', async () => {
    const r = (await cardsHandler(ev(sess('developer', 'a.owners', regionA, ownerDev), 'month=2026-07'))) as unknown as CardsResp
    expect(r.cards.map((c) => c.code).sort()).toEqual(['a'])
  })

  it('a manager sees the cost-owning units in their SUBTREE, never another region', async () => {
    const r = (await cardsHandler(ev(sess('manager', 'a', regionA), 'month=2026-07'))) as unknown as CardsResp
    expect(r.cards.map((c) => c.code)).toContain('a')
    expect(r.cards.map((c) => c.code)).not.toContain('b') // region B never
    expect(r.cards.map((c) => c.code)).not.toContain('cur') // 'cur' is not under 'a'
  })

  it('a region admin sees every cost-owning unit in their region (not another)', async () => {
    const r = (await cardsHandler(ev(adminA(), 'month=2026-07'))) as unknown as CardsResp
    expect(r.cards.map((c) => c.code).sort()).toEqual(['a', 'cur'])
  })

  it('platform-admin sees every cost-owning unit across regions', async () => {
    const r = (await cardsHandler(ev(sess('platform-admin', 'a', regionA, costCentresElevatedId), 'month=2026-07'))) as unknown as CardsResp
    expect(r.cards.map((c) => c.code).sort()).toEqual(['a', 'b', 'cur'])
  })

  it('S3 part (d): a developer with no ownership → 403 (the missing deny arm, not a silent empty list)', async () => {
    // Before S3, reportGrants.costCentre === false for a plain developer was never
    // distinguished from 'owned-or-subtree': this persona fell through to
    // fetchVisibleCostCentres' owner/subtree predicate and got a silently EMPTY
    // 200 instead of the 403 their grant actually says. requireReportScope now
    // gates the whole handler on the scope being permitted AT ALL.
    await expect(
      cardsHandler(ev(sess('developer', 'a.team', regionA, alice), 'month=2026-07')),
    ).rejects.toMatchObject({ statusCode: 403 })
  })
})

describe('GET /reports/cost-centres/[ccId] — resource-anchored RBAC (anti-IDOR)', () => {
  const drill = (s: Session, ccId: string, query = '') => drillHandler(ev(s, query, { ccId }))

  it('a region admin can drill a CC in their own region', async () => {
    const r = (await drill(adminA(), ccA, 'month=2026-07')) as unknown as DrillResp
    expect(r.cc.id).toBe(ccA)
  })

  it('an owner can drill their owned CC (any role)', async () => {
    const r = (await drill(sess('developer', 'a.owners', regionA, ownerDev), ccA, 'month=2026-07')) as unknown as DrillResp
    expect(r.cc.id).toBe(ccA)
  })

  it('anti-IDOR: a region admin drilling a FOREIGN-region CC → 403', async () => {
    await expect(drill(adminA(), ccB, 'month=2026-07')).rejects.toMatchObject({ statusCode: 403 })
  })

  it('a non-owner developer drilling a CC → 403 (no region scope, not owned)', async () => {
    await expect(
      drill(sess('developer', 'a.team', regionA, alice), ccA, 'month=2026-07'),
    ).rejects.toMatchObject({ statusCode: 403 })
  })

  it('SCOPE GATE: a developer whose subtree covers the CC but who holds no cost-centre grant → 403', async () => {
    await expect(
      drill(sess('developer', 'a', regionA, devInCc), ccA, 'month=2026-07'),
    ).rejects.toMatchObject({ statusCode: 403 })
  })

  it('a non-existent CC uuid → 403 (S3 part e: folded into the SAME resolving query, not a separate 404)', async () => {
    // Before S3, existence (404) and ownership/region (403) were TWO separate steps —
    // an existence oracle over which CCs exist in a region the caller can't see. Now a
    // non-existent CC produces the SAME "no row" outcome as a foreign/unowned one.
    await expect(
      drill(adminA(), '11111111-1111-4111-8111-111111111111', 'month=2026-07'),
    ).rejects.toMatchObject({ statusCode: 403 })
  })

  it('S3 part (e): a foreign-region CC id and a random unused UUID return the SAME status and body (no existence oracle)', async () => {
    const foreign = await drill(sess('developer', 'a.team', regionA, alice), ccB, 'month=2026-07').catch((e) => e)
    const absent = await drill(
      sess('developer', 'a.team', regionA, alice),
      '22222222-2222-4222-8222-222222222222',
      'month=2026-07',
    ).catch((e) => e)
    expect(foreign.statusCode).toBe(403)
    expect(absent.statusCode).toBe(403)
    expect(foreign.statusCode).toBe(absent.statusCode)
    // Same problem+json body shape too — a caller cannot distinguish "exists but
    // foreign/unowned" from "doesn't exist" from the response at all.
    expect(foreign.data).toEqual(absent.data)
  })
})

/*
 * BAND 2's route. Flagged as untested by BOTH reviewers independently — a new
 * endpoint carrying scope authz, the anti-IDOR resource gate, cache-key
 * partitioning and a four-query payload, with nothing exercising any of it.
 *
 * It reuses this file's fixture deliberately rather than standing up its own: the
 * authz cases below are only meaningful against the same region/ownership shape
 * the drill's cases use, and a second fixture would drift from it.
 */
describe('GET /reports/cost-centres/[ccId]/trend — BAND 2', () => {
  const trend = (s: Session, ccId: string, query = '') => trendHandler(ev(s, query, { ccId }))

  it('returns the four band payloads over an INCLUSIVE window', async () => {
    const r = (await trend(adminA(), ccA, 'from=2026-07-01&to=2026-07-30')) as unknown as {
      window: { from: string; to: string }
      windowDays: number
      series: unknown[]
      activeTrend: { window: { from: string; to: string }; series: unknown[] }
      usageWeeklyLanes: unknown[]
      perDeveloper: unknown
    }
    // INCLUSIVE, not the half-open exclusive bound. `endIso` is "+1 day"
    // (params.ts), so slicing it labelled a 30-day band as 31 and handed the
    // surface hero a `today` one day past the data.
    expect(r.window).toEqual({ from: '2026-07-01', to: '2026-07-30' })
    expect(r.activeTrend.window).toEqual(r.window)
    expect(Array.isArray(r.series)).toBe(true)
    expect(Array.isArray(r.usageWeeklyLanes)).toBe(true)
    expect(r.perDeveloper).toBeTruthy()
  })

  it('an owner can read their owned centre band (any role)', async () => {
    const r = (await trend(
      sess('developer', 'a.owners', regionA, ownerDev),
      ccA,
      'month=2026-07',
    )) as unknown as { window: { from: string; to: string } }
    expect(r.window.from).toBe('2026-07-01')
  })

  it('anti-IDOR: a FOREIGN-region centre → 403, same as the drill', async () => {
    await expect(trend(adminA(), ccB, 'month=2026-07')).rejects.toMatchObject({ statusCode: 403 })
  })

  it('a non-owner developer → 403 (no region scope, not owned)', async () => {
    await expect(
      trend(sess('developer', 'a.team', regionA, alice), ccA, 'month=2026-07'),
    ).rejects.toMatchObject({ statusCode: 403 })
  })

  it('a non-existent centre → the SAME 403, no existence oracle', async () => {
    await expect(
      trend(adminA(), '11111111-1111-4111-8111-111111111111', 'month=2026-07'),
    ).rejects.toMatchObject({ statusCode: 403 })
  })

  it('SCOPE GATE: a developer whose subtree covers the centre but who holds no cost-centre grant → 403', async () => {
    // Passes the resource gate; denied by the policy. This is the ONLY case in
    // this file that fails when `requireReportScope` is removed.
    await expect(
      trend(sess('developer', 'a', regionA, devInCc), ccA, 'month=2026-07'),
    ).rejects.toMatchObject({ statusCode: 403 })
  })

  it('a malformed uuid → 400, NOT a 500 from the ::uuid cast', async () => {
    // The route first shipped with `/^[0-9a-f-]{36}$/i`, which admits 36 dashless
    // hex chars; those reach Postgres and raise 22P02 as a 500.
    // `requireUuidParam` is what turns this into a clean 400.
    await expect(trend(adminA(), 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')).rejects.toMatchObject({
      statusCode: 400,
    })
  })
})

describe('the burn drill is the §A usage axis — it RECONCILES to the tracker card burn', () => {
  it('the card burn is the PROJECT-CoU usage axis; the NULL-CoU Copilot gap is excluded', async () => {
    const r = (await cardsHandler(ev(adminA(), 'month=2026-07'))) as unknown as CardsResp
    const a = ccOf(r, 'a')!
    // alice 30+20 + phil 90 (emit-homed to ccA) = 140; dave's NULL-CoU copilot 30 EXCLUDED.
    expect(a.burnUsd).toBe(140)
    expect(a.allocationUsd).toBe(100)
    // #489: the lane note names the unit as a Business Unit, never "cost-owning unit".
    expect(r.laneNote).toContain('Business Unit burn is usage on the projects')
  })

  it('the drill burn EQUALS the tracker card burn (same §A lane); the NULL-CoU gap is excluded', async () => {
    const card = ccOf((await cardsHandler(ev(adminA(), 'month=2026-07'))) as unknown as CardsResp, 'a')!
    const d = (await drillHandler(ev(adminA(), 'month=2026-07', { ccId: ccA }))) as unknown as DrillResp
    expect(d.burnUsd).toBe(140)
    expect(d.burnUsd).toBe(card.burnUsd) // the drill reconciles to the tracker row
    expect(d.headlineUsd).toBe(140)
    // All ccA July usage is claude-code; the NULL-CoU copilot gap never leaks in.
    expect(d.vendor.claudeUsd).toBe(140)
    expect(d.vendor.copilotUsd).toBe(0)
    // The drill also frames the burn against the CC's current-effective allocation.
    expect(d.allocationUsd).toBe(100)
  })

  it('the vendor split classifies a NON-FLAGSHIP surface to its vendor, not to Other', async () => {
    const d = (await drillHandler(ev(adminA(), 'month=2026-05', { ccId: ccA }))) as unknown as DrillResp
    // claude-code 11 + claude-ai 7 — a non-Code Claude surface is still Anthropic.
    expect(d.vendor.claudeUsd).toBe(18)
    expect(d.vendor.copilotUsd).toBe(5)
    /*
     * NOT COVERED HERE: `copilot-agent`, the other GitHub surface the old filter
     * also missed. Seeding it faithfully is disproportionate machinery for this
     * test — GitHub money and GitHub model live on SEPARATE fact rows by
     * constraint (`provider_usage_fact_github_money_grain_chk`, mig 0120: no
     * per-model GitHub money), so its §A money arrives on a different arm again,
     * needing reconciliation_record + provider_org + provider_enterprise.
     *
     * It is covered by CONSTRUCTION rather than by fixture: the classifier binds
     * `GITHUB_USAGE_TOOLS`, composed from the surface adapter (it also carries
     * copilot-app since 2026-08-19), and copilot-agent
     * is in that list. Recorded so the coverage claim here is not overstated.
     */
    /*
     * THE ASSERTION THAT GOES RED ON THE OLD FILTER. It matched 'claude-code'
     * and 'copilot-cli' only, so claude-ai's $7 fell into "Other" — on a centre
     * whose people work in chat, that is the whole burn. Nothing may sit in
     * Other here: every tool seeded is a known, registered surface.
     */
    expect(d.vendor.otherUsd).toBe(0)
    // and the split still foots to the burn — no money invented, none lost.
    expect(d.vendor.claudeUsd + d.vendor.copilotUsd + d.vendor.otherUsd).toBe(d.burnUsd)
  })

  it("a spender who sits elsewhere still appears in the burn drill of their project's unit", async () => {
    const d = (await drillHandler(ev(adminA(), 'month=2026-07&axis=teammate', { ccId: ccA }))) as unknown as DrillResp
    // Phil sits in region B, but his July usage is TAGGED to projA, and project-tagged
    // usage counts toward the project's Business Unit (ccA), so he is ccA's LARGEST driver.
    const phil = d.rows.find((r) => r.label === 'phil@b.test')
    expect(phil).toBeDefined()
    expect(phil!.usd).toBe(90)
    expect(d.rows[0]!.label).toBe('phil@b.test') // ranked first (burn desc)
  })
})

describe('the per-CC §B chargeUsd is the bill lane, kept SEPARATE from the §A burn', () => {
  it('ccA carries a chargeUsd (Anthropic bill homed by teammate) distinct from its burn', async () => {
    delete process.env.NUXT_COPILOT_CHARGEBACK_ENABLED
    const r = (await cardsHandler(ev(adminA(), 'month=2026-07'))) as unknown as CardsResp
    const a = ccOf(r, 'a')!
    // Burn (§A usage axis) = 140; chargeback (§B bill, alice homed to ccA) = 40 — DIFFERENT
    // lanes, DIFFERENT numbers, never summed.
    expect(a.burnUsd).toBe(140)
    expect(a.chargeUsd).toBe(40)
    // A CC with burn but no bill homed to it carries chargeUsd 0 ('cur' — carol has no bill).
    expect(ccOf(r, 'cur')!.chargeUsd).toBe(0)

    /*
     * THE DRILL CARRIES THE SAME §B FIGURE AS THE CARD — the property the shared
     * `fetchChargeByCc` exists to guarantee. Before the extraction the drill had
     * no `chargeUsd` at all: its lane toggle switched to a lane with nothing
     * behind it, and its note called the §A burn "the billed figure above".
     */
    const d = (await drillHandler(ev(adminA(), 'month=2026-07', { ccId: ccA }))) as unknown as DrillResp
    expect(d.chargeUsd).toBe(a.chargeUsd)
    // …and it stays SEPARATE from the burn. Same centre, same window, two lanes.
    expect(d.burnUsd).toBe(140)
    expect(d.chargeUsd).not.toBe(d.burnUsd)
  })
})

describe('the two on-track mechanics are DISTINCT (budget DATE ≠ run-rate $)', () => {
  it('a current-month card carries a run-rate dollar AND a budget-exhaustion date', async () => {
    const r = (await cardsHandler(ev(adminA(), `month=${currentMonth}`))) as unknown as CardsResp
    const cur = ccOf(r, 'cur')!
    // Mechanic 2 — run-rate: a DOLLAR (number).
    expect(cur.forecast).not.toBeNull()
    expect(typeof cur.forecast!.projectedUsd).toBe('number')
    // Mechanic 1 — budget exhaustion: a DATE string (burn 100 > allocation 50 → already exhausted).
    expect(cur.exhaustionDate).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    // Distinct shapes, distinct mechanics — never one number.
    expect(String(cur.forecast!.projectedUsd)).not.toBe(cur.exhaustionDate)
  })
})

describe('GET /reports/cost-centres/[ccId] — burn drivers sum-back = headline (every axis)', () => {
  const axes = ['teammate', 'model'] as const
  for (const axis of axes) {
    it(`axis=${axis}: Σ rows = burn headline`, async () => {
      const d = (await drillHandler(ev(adminA(), `month=2026-07&axis=${axis}`, { ccId: ccA }))) as unknown as DrillResp
      const sum = d.rows.reduce((a, r) => a + r.usd, 0)
      expect(sum).toBeCloseTo(d.headlineUsd, 6)
      expect(d.headlineUsd).toBe(140) // the CC burn — the SAME lane as the tracker
      expect(d.denominatorLabel).toBe(`${BU_LABEL_LOWER} burn`)
      const shareSum = d.rows.reduce((a, r) => a + r.sharePct, 0)
      expect(shareSum).toBeCloseTo(1, 6)
    })
  }

  it('teammate axis: every §A row is `indicative` (a usage $, never a per-user charge)', async () => {
    const d = (await drillHandler(ev(adminA(), 'month=2026-07&axis=teammate', { ccId: ccA }))) as unknown as DrillResp
    expect(d.rows.every((r) => r.spendClass === 'indicative')).toBe(true)
    const aliceRow = d.rows.find((r) => r.label === 'alice@a.test')!
    expect(aliceRow.usd).toBe(50) // 30 sonnet + 20 opus
  })

  it('model axis: the model buckets (sonnet + opus) sum back to the burn', async () => {
    const d = (await drillHandler(ev(adminA(), 'month=2026-07&axis=model', { ccId: ccA }))) as unknown as DrillResp
    const opus = d.rows.find((r) => r.label === 'claude-opus-4-6')!
    const sonnet = d.rows.find((r) => r.label === 'claude-sonnet-4-6')!
    expect(opus.usd).toBe(110) // alice 20 + phil 90
    expect(sonnet.usd).toBe(30) // alice 30
    expect(opus.usd + sonnet.usd).toBe(140)
  })
})

describe('the PROJECT drill axis is clamped on the PROJECT’s cost centre, not the usage row’s', () => {
  // ccB carries all three arms of the §A lane and nothing else:
  //   arm 1 $10  emitted    — CoU ccB, project PROJ-B
  //   arm 2 $40  reconciled — CoU NULL (by construction), project PROJ-B
  //   arm 3 $7   ingest-only— CoU ccB, project NULL (by construction)
  const finops = () => sess('platform-admin', 'a', regionA, costCentresElevatedId)
  const projectDrill = () =>
    drillHandler(ev(finops(), 'month=2026-07&axis=project', { ccId: ccB })) as unknown as Promise<DrillResp>

  it('KEEPS arm-2 spend on the axis — the clamp this axis exists to get right', async () => {
    const d = await projectDrill()
    const row = d.rows.find((r) => r.label === 'Project B')
    expect(row, 'the cost centre’s own project must be on its project axis').toBeDefined()
    // 10 (emitted) + 40 (reconciled). Clamping on the USAGE row's
    // cost_owning_unit_id instead — the way the burn axes clamp — would silently
    // drop the 40 and leave a self-consistent, WRONG $10.
    expect(row!.usd).toBe(50)
  })

  it('SURFACES arm 3 as "Not on a project" — its own row, never merged into a project', async () => {
    /*
     * SUPERSEDED, deliberately, by F5 D30. This assertion used to read "EXCLUDES
     * arm 3 from the axis", and its reasoning was sound as far as it went: arm 3
     * is untaggable by construction, so it belongs to no project's budget.
     *
     * What it got wrong is what to DO about that. The prototype's Projects hero
     * ends with `['Not on a project', …, 'no project']` (`R:903-907`): money
     * with no budget to be against is the one bucket on this page a cost-centre
     * owner can directly fix, and leaving it out of the only list of what the
     * money went to hid it BECAUSE it was unallocated.
     *
     * The clamp claim that is NOT superseded, and that this now pins: arm 3 gets
     * a row of its OWN. It is never folded into a project's figure, and it
     * carries no budget concept, so no per-project operand moves because of it.
     */
    const d = await projectDrill()
    expect(d.burnUsd).toBe(17) // arm 1 (10) + arm 3 (7) — the usage-row clamp
    const noProject = d.rows.find((r) => r.label === 'Not on a project')
    expect(noProject, 'arm-3 money must be visible, not silently dropped').toBeDefined()
    expect(noProject!.usd).toBe(7)
    // Nothing a budget could be set ON — absent, not `null` ("no budget set").
    expect('budgetUsd' in noProject!).toBe(false)
    expect(d.rows.find((r) => r.label === 'Project B')!.usd).toBe(50)
    expect(d.headlineUsd).toBe(57) // arm 1 (10) + arm 2 (40) + arm 3 (7)
  })

  it('the project axis rows sum back to their OWN headline, and say which denominator that is', async () => {
    const d = await projectDrill()
    expect(d.rows.reduce((a, r) => a + r.usd, 0)).toBeCloseTo(d.headlineUsd, 6)
    expect(d.rows.reduce((a, r) => a + r.sharePct, 0)).toBeCloseTo(1, 6)
    // NOT 'cost-centre burn' — a denominator that is not the burn must not be
    // labelled as the burn, or the rows read as failing to add up. And it names
    // the second arm (D30), or the "Not on a project" row reads as a project.
    expect(d.denominatorLabel).toBe(`this ${BU_LABEL_LOWER}'s projects, and burn on none`)
    expect(d.headlineUsd).not.toBe(d.burnUsd)
  })

  it('does not leak a project led by ANOTHER cost centre', async () => {
    const d = await projectDrill()
    expect(d.rows.map((r) => r.label)).toEqual(['Project B', 'Not on a project'])
    // ccA's project carries $140 of phil-and-alice spend; ccB does not lead it.
    expect(d.rows.some((r) => r.label === 'Project A')).toBe(false)
  })

  it('ccA’s project axis carries its own project at the SAME figure the burn axes foot to', async () => {
    const d = (await drillHandler(
      ev(adminA(), 'month=2026-07&axis=project', { ccId: ccA }),
    )) as unknown as DrillResp
    // ccA has no arm-2 and no arm-3 money, so here the two clamps agree — which is
    // what makes the ccB divergence above a property of the arms, not of the query.
    expect(d.rows.map((r) => r.label)).toEqual(['Project A'])
    expect(d.rows[0]!.usd).toBe(140)
    expect(d.headlineUsd).toBe(140)
    expect(d.burnUsd).toBe(140)
  })

  it('the drivers CSV export carries the project axis byte-identically', async () => {
    const json = await projectDrill()
    const csv = (await exportHandler(
      ev(finops(), `scope=cost-centre&report=drivers&cc=${ccB}&axis=project&month=2026-07`),
    )) as unknown as string
    expect(csv).toContain('Project B,50.00,87.7,indicative')
    // The "Not on a project" row ships in the file too — a CSV that dropped it
    // would not be byte-identical to the screen.
    expect(csv).toContain('Not on a project,7.00,12.3,indicative')
    expect(json.rows[0]!.usd).toBe(50)
  })
})

describe('GET /reports/cost-centres — month-boundary invariance', () => {
  it('Σ per-month (June + July) burn = the unbounded total over the range for ccA', async () => {
    const june = ccOf((await cardsHandler(ev(adminA(), 'month=2026-06'))) as unknown as CardsResp, 'a')!
    const july = ccOf((await cardsHandler(ev(adminA(), 'month=2026-07'))) as unknown as CardsResp, 'a')!
    expect(june.burnUsd).toBe(15) // alice June sonnet 15 (phil has no June usage)
    expect(july.burnUsd).toBe(140) // alice 30+20 + phil 90
    const [{ total }] = await t.client<{ total: string }[]>`
      SELECT COALESCE(SUM(cost_usd), 0)::text AS total FROM v_complete_usage
      WHERE cost_owning_unit_id = ${ccA}::uuid
        AND ts_event >= '2026-06-01T00:00:00Z'::timestamptz
        AND ts_event <  '2026-08-01T00:00:00Z'::timestamptz`
    expect(june.burnUsd + july.burnUsd).toBe(Number(total))
    expect(Number(total)).toBe(155)
  })
})

describe('GET /reports/cost-centres/[ccId] — range/quarter mode reconciles to the tracker', () => {
  // A multi-month custom window (June + July) — the tracker card AND the burn drill must
  // window the SAME range, so the drill headline == the card burn (the review invariant:
  // a range/quarter drill previously collapsed to ONE month and no longer reconciled).
  const RANGE = 'from=2026-06-01&to=2026-07-31'

  it('the drill burn EQUALS the range-windowed tracker card burn (June 15 + July 140 = 155)', async () => {
    const card = ccOf((await cardsHandler(ev(adminA(), RANGE))) as unknown as CardsResp, 'a')!
    const d = (await drillHandler(ev(adminA(), RANGE, { ccId: ccA }))) as unknown as DrillResp
    // June alice 15 + July (alice 50 + phil 90) = 155 — the WHOLE range, not one month.
    expect(card.burnUsd).toBe(155)
    expect(d.burnUsd).toBe(155)
    expect(d.burnUsd).toBe(card.burnUsd) // the drill reconciles to the tracker row in range mode
    expect(d.headlineUsd).toBe(155)
  })

  it('the placement-moved spender is still present in the range drill + drivers foot to the range burn', async () => {
    const d = (await drillHandler(ev(adminA(), `${RANGE}&axis=teammate`, { ccId: ccA }))) as unknown as DrillResp
    const phil = d.rows.find((r) => r.label === 'phil@b.test')
    expect(phil).toBeDefined()
    expect(phil!.usd).toBe(90) // tagged to projA → ccA's burn, wherever he sits
    expect(d.rows.reduce((a, r) => a + r.usd, 0)).toBeCloseTo(155, 6) // Σ drivers = range burn
  })
})

describe('GET /reports/export?scope=cost-centre — byte-identical to the screen figures', () => {
  it('the CC-grid CSV rows carry the SAME burn/allocation/mechanics as the JSON', async () => {
    const json = (await cardsHandler(ev(adminA(), 'month=2026-07'))) as unknown as CardsResp
    const csv = (await exportHandler(ev(adminA(), 'scope=cost-centre&report=cards&month=2026-07'))) as unknown as string
    const lines = csv.trim().split('\n')
    expect(lines[0]).toMatch(/^# tokenscope business-units/)
    expect(lines[1]).toBe('cost_centre,region,burn_usd,charge_usd,allocation_usd,utilisation_pct,exhaustion_date,projected_month_end_usd')
    const byBurn = new Map<string, string[]>()
    for (const line of lines.slice(2)) {
      const cols = line.split(',')
      byBurn.set(cols[2]!, cols) // key on burn_usd (unique per seeded CC)
    }
    const a = json.cards.find((c) => c.code === 'a')!
    const row = byBurn.get(a.burnUsd.toFixed(2))!
    expect(row).toBeDefined()
    expect(row[2]).toBe('140.00') // burn_usd (§A)
    expect(row[3]).toBe('40.00') // charge_usd (§B, always present) — alice's July bill homed to ccA
    expect(row[4]).toBe('100.00') // allocation_usd
    expect(row[5]).toBe('140.0') // utilisation_pct
  })

  it('the burn-drivers CSV rows carry the SAME spend + share as the JSON endpoint', async () => {
    const json = (await drillHandler(ev(adminA(), 'month=2026-07&axis=teammate', { ccId: ccA }))) as unknown as DrillResp
    const csv = (await exportHandler(ev(adminA(), `scope=cost-centre&report=drivers&cc=${ccA}&axis=teammate&month=2026-07`))) as unknown as string
    const lines = csv.trim().split('\n')
    expect(lines[0]).toMatch(/^# tokenscope business-unit drivers/)
    expect(lines[1]).toBe('driver,spend_usd,share_pct,spend_class,otel_emitted_usd,api_reconciled_usd,provider_usage_usd,surface_mix')
    const csvByLabel = new Map<string, { usd: number; share: number; klass: string }>()
    for (const line of lines.slice(2)) {
      const [label, usd, share, klass] = line.split(',')
      csvByLabel.set(label!, { usd: Number(usd), share: Number(share), klass: klass! })
    }
    for (const r of json.rows) {
      const c = csvByLabel.get(r.label)!
      expect(c).toBeDefined()
      expect(c.usd).toBe(Number(r.usd.toFixed(2)))
      expect(c.share).toBe(Number((r.sharePct * 100).toFixed(1)))
      expect(c.klass).toBe(r.spendClass)
    }
    // The placement-moved top spender is byte-present in the CSV (§A usage, indicative).
    expect(csv).toContain('phil@b.test,90.00,64.3,indicative')
  })

  it('the export inherits the drill anti-IDOR gate (foreign-region CC → 403)', async () => {
    await expect(
      exportHandler(ev(adminA(), `scope=cost-centre&report=drivers&cc=${ccB}&axis=teammate&month=2026-07`)),
    ).rejects.toMatchObject({ statusCode: 403 })
  })

  it('in RANGE mode the drivers CSV windows the SAME range as the drill (byte-identical)', async () => {
    const RANGE = 'from=2026-06-01&to=2026-07-31'
    const json = (await drillHandler(ev(adminA(), `${RANGE}&axis=teammate`, { ccId: ccA }))) as unknown as DrillResp
    const csv = (await exportHandler(ev(adminA(), `scope=cost-centre&report=drivers&cc=${ccA}&axis=teammate&${RANGE}`))) as unknown as string
    const lines = csv.trim().split('\n')
    const csvByLabel = new Map<string, { usd: number; share: number }>()
    for (const line of lines.slice(2)) {
      const [label, usd, share] = line.split(',')
      csvByLabel.set(label!, { usd: Number(usd), share: Number(share) })
    }
    for (const r of json.rows) {
      const c = csvByLabel.get(r.label)!
      expect(c).toBeDefined()
      expect(c.usd).toBe(Number(r.usd.toFixed(2)))
      expect(c.share).toBe(Number((r.sharePct * 100).toFixed(1)))
    }
    // Phil's full-range spend (90) is present — NOT the July-only single-month figure.
    expect(csv).toContain('phil@b.test,90.00,')
    // The screen headline the CSV foots to is the range burn (155), not one month (140).
    expect(json.headlineUsd).toBe(155)
  })
})
