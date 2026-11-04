// @vitest-environment node
/*
 * The coverage denominator published beside a reporting total ("Four — make
 * reports honest about coverage", docs/design/reporting-stakeholder-visibility/
 * 00-decisions.md §5b):
 *   - GET /reports/across-regions → `budgetCoverage` (whole company)
 *   - GET /reports/regional       → `budgetCoverage` (region-clamped)
 *
 * WHY THE FIXTURE LOOKS LIKE THIS. Every bucket carries a DIFFERENT amount, and
 * the two regions differ from each other and from the company in ALL FIVE figures.
 * A wrong denominator is then a wrong NUMBER rather than a wrong shape: a dropped
 * clamp, a swallowed arm, a budget predicate that ignores the window or the scope
 * axis, a $0 allocation admitted as a budget, a per-developer cap counted as a
 * budget of its own, or a fanned-out allocation join each land on a value no other bucket
 * carries.
 *
 * The identity under test is that the four parts PARTITION the surface's own
 * attributed-usage headline. That is the whole point of the qualifier — a
 * coverage figure that does not foot to the total it sits beside is worse than
 * none, because a reader would reconcile it against the tile above and fail.
 *
 * Deliberately NOT asserted: that the denominator is all enterprise consumption.
 * It is not, and the copy does not claim it is — provider spend that has never
 * matched a teammate reaches no §A row, so it is in neither the headline nor
 * this. Asserting completeness we do not deliver is the defect class this
 * codebase keeps re-learning.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'
import { buildUsageRollup } from '../helpers/usage-rollup'
import { injectTestSession } from '../../helpers/auth'
import { grantReportAccess } from '../helpers/report-access'
import type { Session } from '../../../server/utils/auth'
import type { UsageBudgetCoverage } from '#shared/reports/types'
import regionIndex from '../../../server/api/v1/reports/region/index.get'
import reportsExport from '../../../server/api/v1/reports/export.get'

let t: TestDb
let regionA = ''
let regionB = ''
let regionC = ''

const ev = (session: Session, query = '') => {
  const url = '/x' + (query ? `?${query}` : '')
  const headers: Record<string, string> = { host: 'localhost:3450', origin: 'http://localhost:3450' }
  const e = {
    method: 'GET',
    path: url,
    context: { params: {} },
    node: {
      req: { method: 'GET', url, socket: { remoteAddress: '127.0.0.1' }, get headers() { return { ...headers } } },
      res: { _headers: {} as Record<string, unknown>, statusCode: 200, getHeader() {}, setHeader() {}, removeHeader() {}, appendHeader() {}, get headersSent() { return false } },
    },
  }
  injectTestSession(e as unknown as Parameters<typeof injectTestSession>[0], session)
  return e as unknown as Parameters<typeof regionIndex>[0]
}
/*
 * The WHOLE-COMPANY width of the merged `/reports/region*` family (was the
 * separate `/reports/across-regions*` routes). `region=all` is not an optional
 * extra here — it is what selects the unclamped engine scope, so every call that
 * used to reach an across route reaches it through this.
 */
const evAll = (session: Session, query = '') =>
  ev(session, query ? `${query}&region=all` : 'region=all')

const gfo = (): Session =>
  ({ teammateId: '00000000-0000-0000-0000-000000000009', email: 'x@x.test', displayName: 'X', role: 'platform-admin', regionId: regionA, orgPath: 'a', issuedAt: new Date().toISOString() } as unknown as Session)
/*
 * A SUBTREE-scoped caller. `role` and `orgPath` are the two inputs that decide the §A
 * clamp: withRequestRls copies orgPath into `app.user_org_path`, which is what
 * managerScopePredicate's manager arm scopes by. 'developer' and 'manager' take the
 * SAME arm (resolveRegionalScope maps both to scopeRole 'manager'), so the tests below
 * run over both rather than asserting the manager and assuming the developer.
 */
const subtreeCaller = (role: 'manager' | 'developer', regionId: string, orgPath: string): Session =>
  ({ teammateId: '00000000-0000-0000-0000-00000000000a', email: 'm@x.test', displayName: 'M', role, regionId, orgPath, issuedAt: new Date().toISOString() } as unknown as Session)
const regionAdmin = (regionId: string): Session =>
  ({ teammateId: '00000000-0000-0000-0000-00000000000b', email: 'a@x.test', displayName: 'A', role: 'admin', regionId, orgPath: 'bcc', issuedAt: new Date().toISOString() } as unknown as Session)

const cents = (n: number) => Math.round(n * 100)

interface CoverageResp {
  kpis: { genuineUsd: number }
  budgetCoverage: UsageBudgetCoverage
}

/*
 * ── THE FIXTURE, stated as the arithmetic the assertions below check ─────────
 *
 * The window is MARCH 2026 — a month that is closed and will stay closed. That is
 * load-bearing, not incidental: region A's budgets are bounded to March, so a
 * predicate that asked "is there a budget NOW" instead of "was there a budget over
 * this window" answers differently. With the window sitting on the current month
 * the two questions coincide and the window rule cannot be proven.
 *
 * Region A (March 2026)
 *   budgeted           120.00  arm 1, tagged to A-FUNDED (baseline AND top-up AND a
 *                              per-dev cap, all three overlapping March — the
 *                              DISTINCT case)
 *                       37.00  arm 2, tagged to A-FUNDED (the reconciled money that
 *                              dominates at today's adoption)
 *                       50.00  arm 1, tagged to A-TOPUP (a TOP-UP is budget too)
 *   taggedNoBudget      31.00  arm 1, tagged to A-PERDEV (its ONLY project allocation
 *                              is a per-developer cap with no pool — a cap divides a
 *                              pool, it is not a budget of its own)
 *                       64.00  arm 1, tagged to A-BARE (no PROJECT allocation ever — it
 *                              carries a REGION-scoped row whose scope_id is A-BARE's
 *                              own uuid, which must not fund it)
 *                       23.00  arm 1, tagged to A-LAPSED (allocation ended before March)
 *                       13.00  arm 1, tagged to A-ZERO (a $0 baseline over March — an
 *                              allocation row, but not a budget)
 *   untagged            11.00  arm 1, no project claim
 *                        6.00  arm 2, no project claim
 *   untaggable           9.00  arm 3 (claude-ai) — no project axis by construction
 *   ─────────────────────────
 *   total              364.00 = 207 budgeted + 131 taggedNoBudget + 17 untagged + 9 untaggable
 *
 *   Plus two rows JUST OUTSIDE the window — 999.00 on the last day of February and
 *   777.00 on the first day of April — so a window that slips by a day at either
 *   end stops matching the headline by an amount nothing else could produce.
 *
 * Region B (March 2026)
 *   budgeted           500.00 · taggedNoBudget 40.00 · untagged 3.00 · untaggable 2.00
 *   total              545.00
 *   B-FUNDED's budget is OPEN-ENDED, so both allocation shapes are represented.
 *
 * ── Region C — the SUBTREE fixture (March 2026) ──────────────────────────────
 * A and B are flat: one org unit each, sitting at their region's root. That shape
 * cannot tell a region-clamped scope from a subtree-clamped one, because the two
 * cover the same rows — so it could never have caught a note naming the region above
 * a subtree's numbers. Region C has a real tree:
 *
 *   Coverage Region C            (path `bcc`, code `default`, PARENTLESS — the region
 *                                 root; a caller placed HERE has their clamp degraded
 *                                 to zero rows by placedBelowRegionRootPredicate)
 *     ├── Platform Engineering   (path `bcc.plat`)  budgeted 70 · untagged 5 → 75
 *     └── Sales Engineering      (path `bcc.sales`) taggedNoBudget 30        → 30
 *   region C total 105.00
 *
 * Every one of those four figures is distinct from every other in the fixture, so
 * "which scope answered" is a different NUMBER, not a different shape: a subtree
 * caller who was silently given the region reads 105 where they should read 75.
 *
 * Whole company       1014.00 = 808 budgeted + 170 taggedNoBudget + 25 untagged + 11 untaggable
 */
const A = { totalUsd: 364, budgetedUsd: 207, taggedNoBudgetUsd: 131, untaggedUsd: 17, untaggableUsd: 9 }
const B = { totalUsd: 545, budgetedUsd: 500, taggedNoBudgetUsd: 40, untaggedUsd: 3, untaggableUsd: 2 }
const C = { totalUsd: 105, budgetedUsd: 70, taggedNoBudgetUsd: 30, untaggedUsd: 5, untaggableUsd: 0 }
const C_PLAT = { totalUsd: 75, budgetedUsd: 70, taggedNoBudgetUsd: 0, untaggedUsd: 5, untaggableUsd: 0 }
const C_SALES = { totalUsd: 30, budgetedUsd: 0, taggedNoBudgetUsd: 30, untaggedUsd: 0, untaggableUsd: 0 }
const NOTHING = { totalUsd: 0, budgetedUsd: 0, taggedNoBudgetUsd: 0, untaggedUsd: 0, untaggableUsd: 0 }
const COMPANY = {
  totalUsd: 1014,
  budgetedUsd: 777,
  taggedNoBudgetUsd: 201,
  untaggedUsd: 25,
  untaggableUsd: 11,
}

const asCents = (c: UsageBudgetCoverage) => ({
  totalUsd: cents(c.totalUsd),
  budgetedUsd: cents(c.budgetedUsd),
  taggedNoBudgetUsd: cents(c.taggedNoBudgetUsd),
  untaggedUsd: cents(c.untaggedUsd),
  untaggableUsd: cents(c.untaggableUsd),
})
const expected = (e: typeof A) => ({
  totalUsd: cents(e.totalUsd),
  budgetedUsd: cents(e.budgetedUsd),
  taggedNoBudgetUsd: cents(e.taggedNoBudgetUsd),
  untaggedUsd: cents(e.untaggedUsd),
  untaggableUsd: cents(e.untaggableUsd),
})

beforeAll(async () => {
  t = await startTestDb()
  process.env.DATABASE_URL = t.url

  const mkRegion = async (code: string, name: string) => {
    await t.client`INSERT INTO region (code, display_name) VALUES (${code}, ${name})`
    const [r] = await t.client<{ id: string }[]>`SELECT id::text AS id FROM region WHERE code=${code}`
    return r!.id
  }
  regionA = await mkRegion('bca', 'Coverage Region A')
  regionB = await mkRegion('bcb', 'Coverage Region B')
  regionC = await mkRegion('bcc', 'Coverage Region C')

  const mkUnit = async (
    region: string, path: string, code: string,
    opts: { displayName?: string; parentId?: string } = {},
  ) => {
    const displayName = opts.displayName ?? code
    const parentId = opts.parentId ?? null
    await t.client`INSERT INTO org_unit (region_id, parent_id, path, code, display_name, unit_type, is_cost_owning_unit)
      VALUES (${region}::uuid, ${parentId}::uuid, ${path}::ltree, ${code}, ${displayName}, 'bu', true)`
    const [r] = await t.client<{ id: string }[]>`SELECT id::text AS id FROM org_unit WHERE region_id=${region}::uuid AND code=${code}`
    return r!.id
  }
  const unitA = await mkUnit(regionA, 'bca', 'bca')
  const unitB = await mkUnit(regionB, 'bcb', 'bcb')
  /*
   * Region C's tree. The root is parentless AND coded 'default' — the seeded shape, and
   * the shape placedBelowRegionRootPredicate refuses to trust as a least-privilege home.
   * Its two children are genuine homes, so a caller placed in either gets a real subtree
   * clamp and a real name for it.
   */
  const unitCRoot = await mkUnit(regionC, 'bcc', 'default', { displayName: 'Coverage Region C' })
  const unitCPlat = await mkUnit(regionC, 'bcc.plat', 'plat', {
    displayName: 'Platform Engineering', parentId: unitCRoot,
  })
  const unitCSales = await mkUnit(regionC, 'bcc.sales', 'sales', {
    displayName: 'Sales Engineering', parentId: unitCRoot,
  })

  const mkTeammate = async (region: string, unit: string, email: string) => {
    await t.client`INSERT INTO teammate (entra_oid, email, display_name, region_id, org_unit_id, is_active)
      VALUES ('oid-'||${email}, ${email}, ${email}, ${region}::uuid, ${unit}::uuid, true)`
    const [r] = await t.client<{ id: string }[]>`SELECT id::text AS id FROM teammate WHERE email=${email}`
    return r!.id
  }
  const alice = await mkTeammate(regionA, unitA, 'alice@bc.test')
  const bob = await mkTeammate(regionB, unitB, 'bob@bc.test')
  const pat = await mkTeammate(regionC, unitCPlat, 'pat@bc.test')
  const sam = await mkTeammate(regionC, unitCSales, 'sam@bc.test')

  /*
   * mig 0129: `gfo()` below resolves to this DEDICATED sentinel id — the ONLY
   * place in this file that id appears (grep confirms `subtreeCaller`/
   * `regionAdmin` use SEPARATE ids '...000a'/'...000b', and neither needs a
   * grant: their roles already hold report-scope access unconditionally via
   * `baselineGrants`, so leaving them ungranted changes nothing about what they
   * assert). A real backing row is required for the `report_access_grant` FK;
   * both permissions are granted so the whole-company (`region=all`) width and
   * the region-clamped calls the tests below exercise keep working under the
   * new per-teammate grants model.
   */
  await t.client`INSERT INTO teammate (id, entra_oid, email, display_name, region_id, org_unit_id, is_active)
    VALUES ('00000000-0000-0000-0000-000000000009'::uuid, 'oid-bc-finops', 'bc-finops@x.test', 'BC Finops', ${regionA}::uuid, ${unitA}::uuid, true)`
  await grantReportAccess(t.client, '00000000-0000-0000-0000-000000000009')

  const mkInstance = async (teammate: string, region: string, unit: string) => {
    await t.client`INSERT INTO instance_attestation (instance_id, principal_oid, teammate_id, tool, region_id, org_unit_id, project_code_hash, raw_project_code)
      VALUES (gen_random_uuid(), 'p-'||${teammate}, ${teammate}::uuid, 'claude-code', ${region}::uuid, ${unit}::uuid, 'h', 'P')`
    const [r] = await t.client<{ id: string }[]>`SELECT instance_id::text AS id FROM instance_attestation WHERE teammate_id=${teammate}::uuid LIMIT 1`
    return r!.id
  }
  const instAlice = await mkInstance(alice, regionA, unitA)
  const instBob = await mkInstance(bob, regionB, unitB)
  const instPat = await mkInstance(pat, regionC, unitCPlat)
  const instSam = await mkInstance(sam, regionC, unitCSales)

  const mkProject = async (code: string, region: string, cou: string) => {
    await t.client`INSERT INTO project (code, code_hash, display_name, type, region_id, cost_owning_unit_id)
      VALUES (${code}, 'h-'||${code}, ${code}, 'billable', ${region}::uuid, ${cou}::uuid)`
    const [r] = await t.client<{ id: string }[]>`SELECT id::text AS id FROM project WHERE code=${code}`
    return r!.id
  }
  const aFunded = await mkProject('A-FUNDED', regionA, unitA)
  const aTopup = await mkProject('A-TOPUP', regionA, unitA)
  const aPerdev = await mkProject('A-PERDEV', regionA, unitA)
  const aBare = await mkProject('A-BARE', regionA, unitA)
  const aLapsed = await mkProject('A-LAPSED', regionA, unitA)
  const aZero = await mkProject('A-ZERO', regionA, unitA)
  const bFunded = await mkProject('B-FUNDED', regionB, unitB)
  const bBare = await mkProject('B-BARE', regionB, unitB)
  const cFunded = await mkProject('C-FUNDED', regionC, unitCPlat)
  const cBare = await mkProject('C-BARE', regionC, unitCSales)

  await t.client`INSERT INTO audit_event (event_type, actor_system, payload) VALUES ('seed', 'test', '{}'::jsonb)`
  const [{ id: auditId }] = await t.client<{ id: string }[]>`SELECT id::text AS id FROM audit_event ORDER BY ts_recorded DESC LIMIT 1`
  const alloc = async (
    project: string, usd: number, kind: string, lo: string, hi: string | null,
    scopeType = 'project',
  ) => {
    await t.client`INSERT INTO allocation (scope_type, scope_id, budget_usd, effective, allocation_kind, audit_event_id)
      VALUES (${scopeType}, ${project}::uuid, ${usd}, tstzrange(${lo}::timestamptz, ${hi}::timestamptz, '[)'), ${kind}, ${auditId}::uuid)`
  }
  // A-FUNDED carries BOTH kinds over March. Without DISTINCT in the coverage CTE its
  // usage rows would join twice and be counted twice — a value no bucket carries.
  // Both are BOUNDED to March: a predicate asking "budgeted now?" would miss them.
  await alloc(aFunded, 400, 'baseline', '2026-03-01', '2026-04-01')
  await alloc(aFunded, 90, 'top-up', '2026-03-10', '2026-04-01')
  // A-TOPUP has ONLY a top-up. A predicate that recognised baselines alone would
  // move its $50 from budgeted to taggedNoBudget.
  await alloc(aTopup, 60, 'top-up', '2026-03-05', '2026-04-01')
  // A-LAPSED's budget ENDED before the window — the only thing keeping its $23 out
  // of the covered bucket is that the budget question is asked OF THE WINDOW.
  await alloc(aLapsed, 500, 'baseline', '2025-01-01', '2026-02-01')
  // B-FUNDED's is open-ended — the other allocation shape.
  await alloc(bFunded, 900, 'baseline', '2026-01-01', null)
  // C-FUNDED funds Platform Engineering's spend; C-BARE (Sales) is deliberately unfunded,
  // so the two sibling subtrees differ in WHICH bucket their money lands in as well as how
  // much — a subtree answered by the wrong node is wrong in two places, not one.
  await alloc(cFunded, 900, 'baseline', '2026-03-01', '2026-04-01')
  // A-ZERO's baseline is $0 over the whole window. It is an allocation row in every
  // other respect, so only the amount clause keeps its spend out of the covered
  // bucket (usage-coverage.ts: a $0 allocation is not a budget).
  await alloc(aZero, 0, 'baseline', '2026-03-01', '2026-04-01')
  // A REGION-scoped allocation whose scope_id is A-BARE's project uuid. `scope_id`
  // has no FK and the table is shared across scope axes, so this row is exactly what
  // the `scope_type = 'project'` clamp is for: it funds a region, not this project.
  await alloc(aBare, 750, 'baseline', '2026-03-01', '2026-04-01', 'region')
  // A-BARE / B-BARE deliberately have no PROJECT allocation row at all.

  // ── per-developer caps (mig 0008) ──────────────────────────────────────────
  // A project-scoped allocation row carrying a teammate_id: one member's share of
  // the pool (teammate_id NULL) whose period it shares. The pool is the budget.
  const capPerDev = async (project: string, teammate: string, usd: number, lo: string, hi: string) => {
    await t.client`INSERT INTO allocation (scope_type, scope_id, teammate_id, budget_usd, effective, allocation_kind, audit_event_id)
      VALUES ('project', ${project}::uuid, ${teammate}::uuid, ${usd},
              tstzrange(${lo}::timestamptz, ${hi}::timestamptz, '[)'), 'baseline', ${auditId}::uuid)`
  }
  // A-PERDEV's ONLY project allocation is a per-dev cap — no pool row at all (a
  // stranded cap). Counting caps would make it the sole reason its $31 is covered,
  // so dropping `teammate_id IS NULL` from the CTE moves that $31 and nothing else.
  await capPerDev(aPerdev, alice, 300, '2026-03-01', '2026-04-01')
  // A THIRD row on A-FUNDED, on top of its baseline + top-up: the shape split.post.ts
  // actually writes (a cap sharing the pool's exact effective range). It must be
  // absorbed by DISTINCT, not fan A-FUNDED's usage out a third time.
  await capPerDev(aFunded, alice, 100, '2026-03-01', '2026-04-01')

  // ── arm 1 (otel-emitted) ───────────────────────────────────────────────────
  const ar = async (
    inst: string, tm: string, region: string, unit: string,
    day: string, cost: number, projectId: string | null, tool = 'claude-code',
  ) => {
    await t.client`INSERT INTO attribution_record
        (instance_id, teammate_id, region_id, org_unit_id, cost_owning_unit_id, project_id, tool, model,
         token_type, tokens, cost_usd, fidelity_tier, cost_basis, ts_event, claude_session_id)
      VALUES (${inst}::uuid, ${tm}::uuid, ${region}::uuid, ${unit}::uuid, ${unit}::uuid, ${projectId}::uuid,
              ${tool}, 'claude-sonnet-4-6', 'input', 1000, ${cost}, 'tier-1', 'estimated',
              (${day}::date)::timestamp, 'conv-'||${tm}||'-'||${day}||'-'||${cost}::text)`
  }
  await ar(instAlice, alice, regionA, unitA, '2026-03-02', 120, aFunded)
  await ar(instAlice, alice, regionA, unitA, '2026-03-06', 50, aTopup)
  await ar(instAlice, alice, regionA, unitA, '2026-03-03', 64, aBare)
  await ar(instAlice, alice, regionA, unitA, '2026-03-04', 23, aLapsed)
  await ar(instAlice, alice, regionA, unitA, '2026-03-07', 13, aZero)
  await ar(instAlice, alice, regionA, unitA, '2026-03-12', 31, aPerdev)
  await ar(instAlice, alice, regionA, unitA, '2026-03-05', 11, null)
  await ar(instBob, bob, regionB, unitB, '2026-03-02', 500, bFunded)
  await ar(instBob, bob, regionB, unitB, '2026-03-03', 40, bBare)
  await ar(instBob, bob, regionB, unitB, '2026-03-04', 3, null)
  // Region C's two sibling subtrees. `org_unit_id` is what the subtree clamp filters on.
  await ar(instPat, pat, regionC, unitCPlat, '2026-03-02', 70, cFunded)
  await ar(instPat, pat, regionC, unitCPlat, '2026-03-03', 5, null)
  await ar(instSam, sam, regionC, unitCSales, '2026-03-02', 30, cBare)
  // The two window guards. Feb 28 is the day BEFORE the window opens and Apr 1 the
  // day it closes (exclusive), so a one-day slip at either end is a wrong total.
  await ar(instAlice, alice, regionA, unitA, '2026-02-28', 999, aFunded)
  await ar(instAlice, alice, regionA, unitA, '2026-04-01', 777, null)

  // ── arm 2 (api-reconciled) — taggable, and tagged here ─────────────────────
  const uu = async (tm: string, region: string, unit: string, day: string, cost: number, projectId: string | null) => {
    await t.client`INSERT INTO unaccounted_usage (teammate_id, region_id, org_unit_id, project_id, day, tool, cost_usd, tokens, source)
      VALUES (${tm}::uuid, ${region}::uuid, ${unit}::uuid, ${projectId}::uuid, ${day}::date, 'claude-code', ${cost}, 0, 'api-reconciled')`
  }
  await uu(alice, regionA, unitA, '2026-03-08', 37, aFunded)
  await uu(alice, regionA, unitA, '2026-03-09', 6, null)

  // ── arm 3 (provider-usage) — untaggable BY CONSTRUCTION (mig 0101) ─────────
  const ingest = async (tm: string, region: string, unit: string, day: string, cost: number, tool: string) => {
    await t.client`INSERT INTO actual_spend (teammate_id, date, tool, input_tokens, output_tokens, cost_usd, source,
        region_id, org_unit_id, cost_owning_unit_id, dimension_source)
      VALUES (${tm}::uuid, ${day}::date, ${tool}, 100, 100, ${cost}, 'anthropic-analytics-api',
        ${region}::uuid, ${unit}::uuid, ${unit}::uuid, 'ingest-snapshot')`
  }
  await ingest(alice, regionA, unitA, '2026-03-11', 9, 'claude-ai')
  await ingest(bob, regionB, unitB, '2026-03-11', 2, 'claude-cowork')

  // The region reports' §A reads come from usage_rollup_daily (usage-rollup-
  // lane.md R5/R8): materialise it from the seeds above via the real worker.
  await buildUsageRollup(t.db)
}, 180_000)

afterAll(async () => {
  await stopTestDb(t)
})

describe('GET /reports/across-regions — budgetCoverage (whole company)', () => {
  it('decomposes the company total into the four coverage buckets, by amount', async () => {
    const r = (await regionIndex(evAll(gfo(), 'month=2026-03'))) as unknown as CoverageResp
    expect(asCents(r.budgetCoverage)).toEqual(expected(COMPANY))
  })

  it('THE IDENTITY: the four parts partition the headline they are rendered beside', async () => {
    /*
     * `totalUsd` must BE `kpis.genuineUsd` — the "Attributed usage" tile this note
     * sits under — and the parts must foot to it cent-exactly. A qualifier that
     * does not reconcile against the tile above it sends the reader looking for a
     * gap that does not exist.
     */
    const r = (await regionIndex(evAll(gfo(), 'month=2026-03'))) as unknown as CoverageResp
    const c = r.budgetCoverage
    expect(cents(c.totalUsd)).toBe(cents(r.kpis.genuineUsd))
    expect(cents(c.budgetedUsd + c.taggedNoBudgetUsd + c.untaggedUsd + c.untaggableUsd)).toBe(
      cents(c.totalUsd),
    )
  })

  it('a window with no usage reports zeros, not a fabricated share', async () => {
    // The denominator-less case the note renders as "no coverage to report".
    const r = (await regionIndex(evAll(gfo(), 'month=2026-05'))) as unknown as CoverageResp
    expect(asCents(r.budgetCoverage)).toEqual(expected(NOTHING))
  })
})

describe('GET /reports/regional — budgetCoverage (region-clamped)', () => {
  it('reports region A alone — never the company, in ANY bucket', async () => {
    const r = (await regionIndex(ev(gfo(), `month=2026-03&region=${regionA}`))) as unknown as CoverageResp
    expect(asCents(r.budgetCoverage)).toEqual(expected(A))
    // Every company figure differs from every region-A figure, so a dropped clamp
    // is a wrong NUMBER in all five, not a plausible-looking shape.
    expect(asCents(r.budgetCoverage)).not.toEqual(expected(COMPANY))
  })

  it('reports region B alone — so the clamp is threaded, not merely present', async () => {
    const r = (await regionIndex(ev(gfo(), `month=2026-03&region=${regionB}`))) as unknown as CoverageResp
    expect(asCents(r.budgetCoverage)).toEqual(expected(B))
  })

  it('THE IDENTITY holds under a clamp too', async () => {
    for (const region of [regionA, regionB]) {
      const r = (await regionIndex(ev(gfo(), `month=2026-03&region=${region}`))) as unknown as CoverageResp
      const c = r.budgetCoverage
      expect(cents(c.totalUsd)).toBe(cents(r.kpis.genuineUsd))
      expect(cents(c.budgetedUsd + c.taggedNoBudgetUsd + c.untaggedUsd + c.untaggableUsd)).toBe(
        cents(c.totalUsd),
      )
    }
  })
})

describe('what counts as inside the budget lens', () => {
  const coverageA = async () => {
    const r = (await regionIndex(ev(gfo(), `month=2026-03&region=${regionA}`))) as unknown as CoverageResp
    return r.budgetCoverage
  }

  it('RECONCILED spend on a budgeted project is inside it (arm 2, $37)', async () => {
    /*
     * At today's adoption most consumption arrives via reconciliation and never
     * reaches attribution_record. A coverage figure blind to arm 2 would report the
     * budget lens as smaller than it is — the same structural under-read that made
     * the project headline the smallest number in the product.
     */
    const c = await coverageA()
    expect(cents(c.budgetedUsd)).toBe(cents(A.budgetedUsd))
    expect(cents(c.budgetedUsd)).not.toBe(cents(A.budgetedUsd - 37)) // arm 2 dropped
    expect(cents(c.untaggedUsd)).not.toBe(cents(A.untaggedUsd + 37)) // arm 2 mis-bucketed
  })

  it('a TOP-UP is budget: a top-up-only project is inside it ($50)', async () => {
    const c = await coverageA()
    expect(cents(c.budgetedUsd)).not.toBe(cents(A.budgetedUsd - 50))
    expect(cents(c.taggedNoBudgetUsd)).not.toBe(cents(A.taggedNoBudgetUsd + 50))
  })

  it('an allocation on ANOTHER scope axis is not this project\'s budget ($64)', async () => {
    /*
     * `allocation.scope_id` is a bare uuid with no FK and the table carries
     * region / platform / teammate rows beside project ones. A-BARE has a REGION
     * allocation stamped with its own project uuid; only `scope_type = 'project'`
     * keeps its $64 out of the covered bucket. Drop that clause and a region's
     * budget silently funds a project.
     *
     * $64 is the diagnostic: both budget guards move the SAME two buckets, so the
     * bucket totals alone cannot say which one broke. `+64` is a covered figure only
     * a lost scope clamp produces.
     */
    const c = await coverageA()
    expect(cents(c.budgetedUsd)).not.toBe(cents(A.budgetedUsd + 64))
    expect(cents(c.budgetedUsd)).toBe(cents(A.budgetedUsd))
    expect(cents(c.taggedNoBudgetUsd)).toBe(cents(A.taggedNoBudgetUsd))
  })

  it('a $0 allocation is NOT a budget — its spend is tagged-but-unbudgeted ($13)', async () => {
    /*
     * DECIDED (usage-coverage.ts): a project allocated $0 did not "have a budget for
     * it", which is what the copy beside this figure claims of everything in the
     * covered bucket. Nothing in the schema or either write path forbids a $0
     * allocation, so the question is live; counting it would inflate the covered
     * share, the one thing this decomposition exists to keep honest.
     *
     * `+13` is the diagnostic here, for the reason `+64` is above: a covered figure
     * only an admitted $0 allocation produces.
     */
    const c = await coverageA()
    expect(cents(c.budgetedUsd)).not.toBe(cents(A.budgetedUsd + 13))
    expect(cents(c.budgetedUsd)).toBe(cents(A.budgetedUsd))
    expect(cents(c.taggedNoBudgetUsd)).toBe(cents(A.taggedNoBudgetUsd))
  })

  it('a budget that ENDED before the window is outside it ($23)', async () => {
    /*
     * The budget question is asked OF THIS WINDOW, not of now. A project funded
     * last year and not this one is tagged-but-unbudgeted for July, and counting it
     * as covered would overstate coverage exactly where adoption is being measured.
     */
    const c = await coverageA()
    expect(cents(c.taggedNoBudgetUsd)).toBe(cents(A.taggedNoBudgetUsd))
    expect(cents(c.budgetedUsd)).not.toBe(cents(A.budgetedUsd + 23))
  })

  it('a PER-DEVELOPER cap is not budget on its own: a cap with no pool is outside it ($31)', async () => {
    /*
     * DECIDED (usage-coverage.ts): the budgeted_project CTE reads pool rows only
     * (`teammate_id IS NULL`). A per-dev cap is one member's share of a pool and
     * shares its period, so a project with caps already has the pool that covers
     * it; a cap with no pool behind it is a stranded row, not a budget.
     *
     * A-PERDEV has ONLY a cap, so this $31 is the whole of what the filter moves,
     * and `+31` / `-31` are figures no other reading of this fixture produces.
     */
    const c = await coverageA()
    expect(cents(c.budgetedUsd)).toBe(cents(A.budgetedUsd))
    expect(cents(c.budgetedUsd)).not.toBe(cents(A.budgetedUsd + 31)) // per-dev rows counted
    expect(cents(c.taggedNoBudgetUsd)).not.toBe(cents(A.taggedNoBudgetUsd - 31))
  })

  it('a project with a baseline AND a top-up AND a per-dev cap is counted ONCE', async () => {
    /*
     * The allocation join is a set membership test, not a sum. Extra allocation rows
     * for one project would fan its usage out and inflate BOTH the covered figure
     * and the denominator — a total no other reading of this fixture produces.
     *
     * A-FUNDED carries all three row shapes, including the per-dev cap that
     * split.post.ts writes alongside a pool baseline over the pool's own effective
     * range. That is the common production shape, and it must cost nothing.
     */
    const c = await coverageA()
    expect(cents(c.totalUsd)).toBe(cents(A.totalUsd))
    expect(cents(c.budgetedUsd)).not.toBe(cents(A.budgetedUsd + 157)) // A-FUNDED counted twice
    expect(cents(c.budgetedUsd)).not.toBe(cents(A.budgetedUsd + 314)) // counted three times
  })

  it('spend either side of the window is outside the denominator', async () => {
    /*
     * A qualifier computed over a different window than the total it sits beside is
     * a different question wearing the same label. The fixture puts $999 the day
     * before the window opens and $777 the day it closes, so a one-day slip at
     * either end is a total nothing else in this fixture can produce.
     */
    const c = await coverageA()
    expect(cents(c.totalUsd)).toBe(cents(A.totalUsd))
    expect(cents(c.totalUsd)).not.toBe(cents(A.totalUsd + 999))
    expect(cents(c.totalUsd)).not.toBe(cents(A.totalUsd + 777))
  })

  it('region C sums its two subtrees — the region node still answers for the region', async () => {
    // The control for every subtree assertion below: region C's own figures, so
    // "the subtree got the region's answer" is a specific wrong number (105, not 75).
    const r = (await regionIndex(ev(gfo(), `month=2026-03&region=${regionC}`))) as unknown as CoverageResp
    expect(asCents(r.budgetCoverage)).toEqual(expected(C))
  })

  it('arm 3 is UNTAGGABLE, never untagged ($9)', async () => {
    /*
     * `project_id` is NULL by construction on the ingest-only arm (mig 0101) — a
     * structural absence, not a bookkeeping gap. Folding it into "untagged" would
     * tell a manager to go and tag money that can never carry a tag.
     */
    const c = await coverageA()
    expect(cents(c.untaggableUsd)).toBe(cents(A.untaggableUsd))
    expect(cents(c.untaggedUsd)).toBe(cents(A.untaggedUsd))
    expect(cents(c.untaggedUsd)).not.toBe(cents(A.untaggedUsd + 9))
  })
})

/*
 * ── WHOSE FIGURES ARE THESE? (consistency contract C11) ──────────────────────
 *
 * `scopeLabel` is the sentence's subject: the note reads "Of the $X attributed usage
 * in <scopeLabel> this period, $Y is on a project that had a budget for it". It is
 * chosen HERE, in resolveRegionalScope, next to the predicate — because a predicate is
 * an opaque SQL fragment everywhere downstream, and the component that renders the
 * sentence cannot see what the clamp covered.
 *
 * The defect these close: the label used to be computed in the hero as `drill ??
 * region`. That is right for an admin, whose clamp IS `region_id = …`, and wrong for a
 * manager and a developer — both carry `regional: 'own-region'`
 * (shared/auth/report-visibility.ts:99-103), both are admitted by
 * server/api/v1/reports/regional/index.get.ts, and resolveRegionalScope maps both to
 * scopeRole 'manager', whose clause is the `app.user_org_path` SUBTREE. They read the
 * REGION's name above their own org unit's numbers, on the one surface built to be
 * honest about coverage.
 *
 * These assert the label and the figures TOGETHER, every time. A label proven alone
 * could be right about a scope the amounts did not come from, which is the same class
 * of defect one layer along.
 */
describe('budgetCoverage.scopeLabel — the scope the figures were actually computed for', () => {
  const coverageFor = async (session: Session, query: string) =>
    ((await regionIndex(ev(session, query))) as unknown as CoverageResp).budgetCoverage

  it.each(['manager', 'developer'] as const)(
    'a %s reads their OWN org unit, by name and by amount — never the region',
    async (role) => {
      /*
       * Pat is placed at `bcc.plat`. The clamp covers Platform Engineering's subtree
       * ($75, of which $70 budgeted); the REGION is $105 with $30 more in a sibling
       * unit that is not theirs. So a scope that widened to the region is visible
       * twice over — in the name AND in three of the four buckets.
       */
      const c = await coverageFor(subtreeCaller(role, regionC, 'bcc.plat'), 'month=2026-03')
      expect(c.scopeLabel).toBe('Platform Engineering')
      expect(c.scopeLabel).not.toBe('Coverage Region C')
      expect(asCents(c)).toEqual(expected(C_PLAT))
      expect(asCents(c)).not.toEqual(expected(C))
    },
  )

  it('the sibling subtree gets its OWN name and figures — the label is threaded, not fixed', async () => {
    /*
     * The pair is the point. One subtree alone cannot distinguish "resolved the
     * caller's home" from "returned a constant that happened to match": Sales
     * Engineering has different money in a different bucket, so only a label that
     * actually follows `app.user_org_path` answers both.
     */
    const c = await coverageFor(subtreeCaller('manager', regionC, 'bcc.sales'), 'month=2026-03')
    expect(c.scopeLabel).toBe('Sales Engineering')
    expect(asCents(c)).toEqual(expected(C_SALES))
  })

  it('a region ADMIN reads the region — the region name is right when the clamp IS the region', async () => {
    /*
     * The other half of the same rule, and the reason the fix is not "never say the
     * region". An admin's clause is `region_id = …` (managerScopePredicate's admin
     * arm), so the region IS their scope and naming it is exactly correct. A fix that
     * moved every caller to a unit name would break this one instead.
     */
    const c = await coverageFor(regionAdmin(regionC), 'month=2026-03')
    expect(c.scopeLabel).toBe('Coverage Region C')
    expect(asCents(c)).toEqual(expected(C))
  })

  it('an `ou` drill names the DRILLED unit, not the caller home it was reached from', async () => {
    // The drill overrides the subtree clamp with the unit's own subtree, so the label
    // must follow the drill — a manager drilling sideways must not keep their own name.
    const [ouSales] = [...(await t.client<{ id: string }[]>`
      SELECT id::text AS id FROM org_unit WHERE region_id=${regionC}::uuid AND code='sales'`)]
    const c = await coverageFor(gfo(), `month=2026-03&region=${regionC}&ou=${ouSales!.id}`)
    expect(c.scopeLabel).toBe('Sales Engineering')
    expect(asCents(c)).toEqual(expected(C_SALES))
  })

  it('the whole-company report names the whole company', async () => {
    const r = (await regionIndex(evAll(gfo(), 'month=2026-03'))) as unknown as CoverageResp
    expect(r.budgetCoverage.scopeLabel).toBe('the whole company')
  })

  it('a caller placed AT the region root gets NO scope name — not the region', async () => {
    /*
     * `placedBelowRegionRootPredicate` deliberately degrades the subtree clamp to ZERO
     * rows when the caller's own home is the region root: `path <@ 'bcc'` is true of
     * every unit in region C, so trusting it would silently promote a manager to a
     * region-wide view (server/auth/org-subtree-scope.ts).
     *
     * The figures are therefore structurally zero — NOT a measurement of region C,
     * which has $105 in this window. Naming the region here would render "No attributed
     * usage recorded in Coverage Region C this period", which is false about the region
     * AND false about what was measured. `null` is what makes the note say what is
     * actually true instead.
     */
    const c = await coverageFor(subtreeCaller('manager', regionC, 'bcc'), 'month=2026-03')
    expect(c.scopeLabel).toBeNull()
    expect(asCents(c)).toEqual(expected(NOTHING))
    /*
     * And the region the old label named is NOT empty over this same window — read
     * back from the handler, not asserted against the fixture constant, because
     * `expect(C.totalUsd).toBeGreaterThan(0)` is a claim about a literal in this file
     * and could never fail. What makes the wrong label a false statement rather than a
     * harmless one is that region C really does have money here.
     */
    const regionView = await coverageFor(regionAdmin(regionC), 'month=2026-03')
    expect(regionView.scopeLabel).toBe('Coverage Region C')
    expect(regionView.totalUsd).toBeGreaterThan(0)
  })

  it('an empty WINDOW still names the scope — only an unresolved scope is nameless', async () => {
    /*
     * The two zero cases are different claims and must not collapse into one. "Nothing
     * happened in Platform Engineering in May" is a measurement; "you have no reporting
     * scope" is the absence of one. Same five zeros, so only the label separates them.
     */
    const c = await coverageFor(subtreeCaller('manager', regionC, 'bcc.plat'), 'month=2026-05')
    expect(c.scopeLabel).toBe('Platform Engineering')
    expect(asCents(c)).toEqual(expected(NOTHING))
  })
})

/*
 * ── THE SAME CONTRACT, ONE SURFACE FURTHER ALONG: the Regional CSV export ────
 *
 * The export resolves the Regional scope in its OWN request and stamps a scope
 * into the file's first line. It derived that stamp from `drill ?? region` and
 * never read `scope.scopeLabel` — the identical wrong derivation the on-screen
 * note above was moved off. So a manager in Platform Engineering downloaded a
 * file headed with the whole region over rows that are only their subtree's, and
 * a file travels without the screen that would have qualified it.
 *
 * Region C is what makes these sharp: Platform Engineering is $75 of the region's
 * $105 and Sales Engineering is the other $30, so a scope that widened to the
 * region is a wrong NAME and a wrong TOTAL in the same file.
 */
describe('the Regional CSV export stamps the scope its rows were clamped to', () => {
  const exportCsv = async (session: Session, query: string): Promise<string> =>
    (await reportsExport(ev(session, query))) as unknown as string

  /** `# tokenscope regional drivers · axis=… · month=… · as_of=… · scope=<label>` */
  const scopeStamp = (csv: string): string => csv.split('\n')[0]!.split('scope=')[1]!
  /** Σ `spend_usd` over the data rows — line 0 is the stamp, line 1 the column names. */
  const rowTotalUsd = (csv: string): number =>
    csv
      .split('\n')
      .slice(2)
      .filter((l) => l.trim() !== '')
      .reduce((a, l) => a + Number(l.split(',')[1]), 0)

  const driversFor = (session: Session, month = 'month=2026-03') =>
    exportCsv(session, `scope=region&report=drivers&${month}`)

  it.each(['drivers', 'trend', 'practices'] as const)(
    'a subtree manager exporting %s is stamped with their unit, never the region',
    async (report) => {
      // All three Regional reports share one `scopeLabel`, so all three carried
      // the defect and all three have to move together.
      const csv = await exportCsv(
        subtreeCaller('manager', regionC, 'bcc.plat'),
        `scope=region&report=${report}&month=2026-03`,
      )
      expect(scopeStamp(csv)).toBe('Platform Engineering')
      expect(scopeStamp(csv)).not.toBe('Coverage Region C')
    },
  )

  it('the rows under that stamp are the subtree’s money, not the region’s', async () => {
    /*
     * The name and the amounts asserted together — a stamp proven alone could be
     * right about a scope the rows did not come from. The pair also guards the
     * guard: if the subtree and the region had the same total, "named the subtree"
     * would be unfalsifiable here. The region figure is read back from the export
     * rather than asserted against a literal in this file, so the comparison is
     * between two things the code produced.
     */
    const subtree = await driversFor(subtreeCaller('manager', regionC, 'bcc.plat'))
    const region = await driversFor(regionAdmin(regionC))

    expect(scopeStamp(subtree)).toBe('Platform Engineering')
    expect(rowTotalUsd(subtree)).toBeCloseTo(C_PLAT.totalUsd, 2)

    // The region admin's clause IS `region_id = …`, so naming the region is
    // correct for them — the fix is "name the clamp", not "never say a region".
    expect(scopeStamp(region)).toBe('Coverage Region C')
    expect(rowTotalUsd(region)).toBeCloseTo(C.totalUsd, 2)

    // …and the two really do differ, in both the name and the money.
    expect(scopeStamp(subtree)).not.toBe(scopeStamp(region))
    expect(rowTotalUsd(subtree)).toBeLessThan(rowTotalUsd(region))
  })

  it('the sibling subtree is stamped with ITS own name — the label is threaded, not fixed', async () => {
    // One subtree alone cannot tell "followed app.user_org_path" from "returned a
    // constant that happened to match". Sales Engineering has different money.
    const csv = await driversFor(subtreeCaller('manager', regionC, 'bcc.sales'))
    expect(scopeStamp(csv)).toBe('Sales Engineering')
    expect(rowTotalUsd(csv)).toBeCloseTo(C_SALES.totalUsd, 2)
  })

  it('an `ou` drill is stamped with the drilled unit', async () => {
    const [ouSales] = [
      ...(await t.client<{ id: string }[]>`
      SELECT id::text AS id FROM org_unit WHERE region_id=${regionC}::uuid AND code='sales'`),
    ]
    const csv = await driversFor(gfo(), `month=2026-03&region=${regionC}&ou=${ouSales!.id}`)
    expect(scopeStamp(csv)).toBe('Sales Engineering')
    expect(rowTotalUsd(csv)).toBeCloseTo(C_SALES.totalUsd, 2)
  })

  it('a caller whose clamp resolves to NO org unit is stamped as having none', async () => {
    /*
     * `placedBelowRegionRootPredicate` degrades the subtree clamp to zero rows when
     * the caller's own home is the region root, so the file has no rows AND no scope
     * they belong to. Stamping the region there would hand someone a file headed
     * "Coverage Region C" containing none of region C's $105 — a claim the same
     * fallback made on screen before it was removed.
     */
    const csv = await driversFor(subtreeCaller('manager', regionC, 'bcc'))
    expect(scopeStamp(csv)).toBe('no resolved scope')
    expect(scopeStamp(csv)).not.toBe('Coverage Region C')
    expect(rowTotalUsd(csv)).toBeCloseTo(0, 2)

    // And the region it would have named is not empty over this window — read back
    // from the export, so what makes the fallback FALSE is a figure the code produced.
    expect(rowTotalUsd(await driversFor(regionAdmin(regionC)))).toBeGreaterThan(0)
  })
})
