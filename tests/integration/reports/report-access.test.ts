// @vitest-environment node
/*
 * Report-access rows — the endpoint-matrix proof (mig 0129, successor to
 * the retired report-visibility.test.ts / task #19's three-mode dial).
 *
 * Per-literal-endpoint proof (sg-M6/M8): every merged Region route (×5, incl. the
 * `region=all` width) and every /reports/finance surface (index + drill + export)
 * asserts 200/403 against `effectiveReportGrants` for FIVE personas — plain
 * developer, cost-centre owner, region admin, manager, platform-admin — crossed
 * with the states a `report_access_grant` row can put a caller in. (It said SIX
 * and listed four: retiring `global-finops` collapsed two personas into one and
 * dropped manager coverage without changing this sentence.) Plus:
 *   - THE ROLE-DEFAULT PROOF (PO decision 2026-08-13, reversing #251 for the
 *     org-wide roles only): an ungranted platform-admin is 200 on
 *     every whole-company width by ROLE, while an ungranted region `admin` stays
 *     region-bound (403 on region=all and on finance) — the anti-IDOR clamp.
 *   - sg-L11 successor: DROP TABLE report_access_grant degrades every caller to
 *     baseline, 200, never a throw.
 *   - sg-M4: every deny of an unclamped answer (region=all + finance) is audited,
 *     payload now carrying `permissions` (the `mode` field is gone).
 *   - S3 part (d): a plain developer (no ownership) is denied the cost-centre
 *     scope with no grants.
 *   - T30: the teammate drill + project reports-depth admission, across the same
 *     matrix.
 *   - C3 (post-review amendments): a foreign-region `?ou=` drill refuses an
 *     ungranted org-wide caller; the `ownerOnly` seal for an org-wide role that
 *     holds cost-centre visibility SOLELY via ownership; a role demotion does NOT
 *     retract an already-active grant (designed persistence); the `expires_at`
 *     boundary is `<=`, not `<`.
 *
 * Grant rows are written directly (`grantReportAccess` / raw SQL) — the admin
 * POST/DELETE surface belongs to a different agent
 * (tests/integration/admin/report-access.test.ts); this suite exercises
 * ENFORCEMENT, not the grant CRUD path.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { consola } from 'consola'
import * as auditModule from '../../../server/db/audit'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'
import { injectTestSession } from '../../helpers/auth'
import { grantReportAccess } from '../helpers/report-access'
import type { Session } from '../../../server/utils/auth'

import regionIndex from '../../../server/api/v1/reports/region/index.get'
import acrossDrivers from '../../../server/api/v1/reports/region/drivers.get'
import acrossTrend from '../../../server/api/v1/reports/region/trend.get'
import acrossActiveTrend from '../../../server/api/v1/reports/region/active-trend.get'
import acrossSeasonality from '../../../server/api/v1/reports/region/seasonality.get'
import financeIndex from '../../../server/api/v1/reports/finance/index.get'
import financeCou from '../../../server/api/v1/reports/finance/[couId].get'
import reportsExport from '../../../server/api/v1/reports/export.get'
import costCentresIndex from '../../../server/api/v1/reports/cost-centres/index.get'
import costCentreDrill from '../../../server/api/v1/reports/cost-centres/[ccId].get'
import teammateDrill from '../../../server/api/v1/reports/teammate/[id]/index.get'
import teammateDrillExport from '../../../server/api/v1/reports/teammate/[id]/export.get'
import projectDepth from '../../../server/api/v1/reports/project/[code].get'
import metaHandler from '../../../server/api/v1/reports/meta.get'

let t: TestDb
let regionA = ''
let regionB = ''
let couA = '' // cost-owning unit, region A
let couB = '' // cost-owning unit, region B
let adminId = ''
let ownerId = '' // developer WITH an active cou_owner row on couA
let plainDevId = '' // developer with NO cou_owner row (S3 part d)
let finopsId = '' // platform-admin, NO ownership — the disconnect-proof persona
let platformId = '' // platform-admin, NO ownership — same disconnect
let finopsOwnerId = '' // platform-admin WITH active cou_owner on couA (C3 ownerOnly seal)
let demotedId = '' // seeded platform-admin, demoted to developer mid-suite (C3 role-demotion pin)
let subjectId = '' // a teammate with in-scope spend — the drill's SUBJECT

const ev = (session: Session, query = '', params: Record<string, string> = {}) => {
  const url = '/x' + (query ? `?${query}` : '')
  const headers: Record<string, string> = { host: 'localhost:3450', origin: 'http://localhost:3450' }
  const e = {
    method: 'GET',
    path: url,
    context: { params },
    node: {
      req: { method: 'GET', url, socket: { remoteAddress: '127.0.0.1' }, get headers() { return { ...headers } } },
      // setHeader RECORDS into _headers rather than discarding: `/reports/meta`
      // carries authorisation state (scopes / permissions), so its Cache-Control
      // is part of the contract and needs to be assertable. A no-op stub cannot
      // catch a response that tells the browser to keep a stale grant set.
      res: {
        _headers: {} as Record<string, unknown>,
        statusCode: 200,
        getHeader(this: { _headers: Record<string, unknown> }, k: string) { return this._headers[String(k).toLowerCase()] },
        setHeader(this: { _headers: Record<string, unknown> }, k: string, v: unknown) { this._headers[String(k).toLowerCase()] = v },
        removeHeader(this: { _headers: Record<string, unknown> }, k: string) { Reflect.deleteProperty(this._headers, String(k).toLowerCase()) },
        appendHeader() {},
        get headersSent() { return false },
      },
    },
  }
  injectTestSession(e as unknown as Parameters<typeof injectTestSession>[0], session)
  return e as unknown as Parameters<typeof regionIndex>[0]
}
/*
 * The WHOLE-COMPANY width of the merged `/reports/region*` family (was the
 * separate `/reports/across-regions*` routes). `region=all` is not an optional
 * extra here - it is what selects the unclamped engine scope, so every call that
 * used to reach an across route reaches it through this.
 */
const evAll = (session: Session, query = '', params: Record<string, string> = {}) =>
  ev(session, query ? `${query}&region=all` : 'region=all', params)

const adminSess = (): Session =>
  ({ teammateId: adminId, email: 'admin@a.test', displayName: 'A', role: 'admin', regionId: regionA, orgPath: 'a', issuedAt: new Date().toISOString() } as unknown as Session)
const ownerSess = (): Session =>
  ({ teammateId: ownerId, email: 'owner@a.test', displayName: 'O', role: 'developer', regionId: regionA, orgPath: 'a', issuedAt: new Date().toISOString() } as unknown as Session)
const plainDevSess = (): Session =>
  ({ teammateId: plainDevId, email: 'plaindev@a.test', displayName: 'PD', role: 'developer', regionId: regionA, orgPath: 'a', issuedAt: new Date().toISOString() } as unknown as Session)
const finopsSess = (): Session =>
  ({ teammateId: finopsId, email: 'finops@a.test', displayName: 'F', role: 'platform-admin', regionId: regionA, orgPath: 'a', issuedAt: new Date().toISOString() } as unknown as Session)
const managerSess = (): Session =>
  ({ teammateId: plainDevId, email: 'plaindev@a.test', displayName: 'M', role: 'manager', regionId: regionA, orgPath: 'a', issuedAt: new Date().toISOString() } as unknown as Session)
const platformSess = (): Session =>
  ({ teammateId: platformId, email: 'platform@a.test', displayName: 'P', role: 'platform-admin', regionId: regionA, orgPath: 'a', issuedAt: new Date().toISOString() } as unknown as Session)
const finopsOwnerSess = (): Session =>
  ({ teammateId: finopsOwnerId, email: 'finopsowner@a.test', displayName: 'FO', role: 'platform-admin', regionId: regionA, orgPath: 'a', issuedAt: new Date().toISOString() } as unknown as Session)

/** DELETE every grant between cases — the grant-model successor of `setMode(null)`. */
async function clearGrants(): Promise<void> {
  await t.client`DELETE FROM report_access_grant`
}

const ok = (p: Promise<unknown>) => expect(p).resolves.toBeDefined()
const forbidden = (p: Promise<unknown>) => expect(p).rejects.toMatchObject({ statusCode: 403 })

/** The 5 merged Region routes at the `region=all` (whole-company) width. */
const regionCallsAll = (session: Session) => [
  () => regionIndex(evAll(session, 'month=2026-07')),
  () => acrossDrivers(evAll(session, 'month=2026-07')),
  () => acrossTrend(evAll(session, 'month=2026-07')),
  () => acrossActiveTrend(evAll(session, 'month=2026-07')),
  () => acrossSeasonality(evAll(session, 'month=2026-07')),
]
/** /reports/finance index + drill + export. */
const financeCalls = (session: Session) => [
  () => financeIndex(ev(session, 'month=2026-06')),
  () => financeCou(ev(session, 'month=2026-06', { couId: couA })),
  () => reportsExport(ev(session, 'scope=finance&format=csv')),
]
async function expectAll(calls: (() => Promise<unknown>)[], allowed: boolean): Promise<void> {
  for (const call of calls) await (allowed ? ok(call()) : forbidden(call()))
}

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

  const mkUnit = async (region: string, path: string, code: string) => {
    await t.client`INSERT INTO org_unit (region_id, path, code, display_name, unit_type, is_cost_owning_unit)
      VALUES (${region}::uuid, ${path}::ltree, ${code}, ${code}, 'bu', true)`
    const [r] = await t.client<{ id: string }[]>`SELECT id::text AS id FROM org_unit WHERE region_id=${region}::uuid AND code=${code}`
    return r!.id
  }
  couA = await mkUnit(regionA, 'a', 'a')
  couB = await mkUnit(regionB, 'b', 'b')

  const mkTeammate = async (region: string, unit: string, email: string, role: string) => {
    await t.client`INSERT INTO teammate (entra_oid, email, display_name, region_id, org_unit_id, role, is_active)
      VALUES ('oid-'||${email}, ${email}, ${email}, ${region}::uuid, ${unit}::uuid, ${role}, true)`
    const [r] = await t.client<{ id: string }[]>`SELECT id::text AS id FROM teammate WHERE email=${email}`
    return r!.id
  }
  adminId = await mkTeammate(regionA, couA, 'admin@a.test', 'admin')
  ownerId = await mkTeammate(regionA, couA, 'owner@a.test', 'developer')
  plainDevId = await mkTeammate(regionA, couA, 'plaindev@a.test', 'developer') // S3 part (d): no cou_owner row
  finopsId = await mkTeammate(regionA, couA, 'finops@a.test', 'platform-admin') // disconnect-proof: no ownership either
  platformId = await mkTeammate(regionA, couA, 'platform@a.test', 'platform-admin')
  finopsOwnerId = await mkTeammate(regionA, couA, 'finopsowner@a.test', 'platform-admin') // C3 ownerOnly seal
  demotedId = await mkTeammate(regionA, couA, 'demoted@a.test', 'platform-admin') // C3 role-demotion pin
  const billerA = await mkTeammate(regionA, couA, 'billa@a.test', 'developer')
  const billerB = await mkTeammate(regionB, couB, 'billb@b.test', 'developer')

  // Active ownership → the developer 'owner' is a cost-centre owner of couA.
  await t.client`INSERT INTO cou_owner (org_unit_id, teammate_id) VALUES (${couA}::uuid, ${ownerId}::uuid)`
  // C3: an org-wide role holding cost-centre visibility SOLELY via ownership —
  // a SEPARATE teammate from `finopsId` so the disconnect-proof persona stays
  // unowned throughout the file.
  await t.client`INSERT INTO cou_owner (org_unit_id, teammate_id) VALUES (${couA}::uuid, ${finopsOwnerId}::uuid)`

  // A SUBJECT with in-scope spend, so the teammate drill's emit-time gate has
  // something real to admit (its OTHER conjuncts are pinned in teammate-drill.test.ts;
  // here the question is only per-endpoint ADMISSION).
  subjectId = await mkTeammate(regionA, couA, 'subject@a.test', 'developer')
  await t.client`INSERT INTO project (code, code_hash, display_name, type, region_id, cost_owning_unit_id)
    VALUES ('RV-PROJ', 'hash-rv', 'RV Project', 'billable', ${regionA}::uuid, ${couA}::uuid)`
  const [proj] = await t.client<{ id: string }[]>`SELECT id::text AS id FROM project WHERE code='RV-PROJ'`
  await t.client`INSERT INTO project_assignment (project_id, teammate_id, role, effective)
    VALUES (${proj!.id}::uuid, ${subjectId}::uuid, 'member', tstzrange('2020-01-01', NULL, '[)'))`
  // A FOREIGN project (region B, member in couB) — the ownerOnly seal's foil:
  // an ungranted org-wide owner of couA must NOT reach its reports depth
  // (viewerPeopleScope ownerOnly; the GUC arm alone would admit it).
  await t.client`INSERT INTO project (code, code_hash, display_name, type, region_id, cost_owning_unit_id)
    VALUES ('RV-FOREIGN', 'hash-rvf', 'RV Foreign Project', 'billable', ${regionB}::uuid, ${couB}::uuid)`
  const [foreignProj] = await t.client<{ id: string }[]>`SELECT id::text AS id FROM project WHERE code='RV-FOREIGN'`
  await t.client`INSERT INTO project_assignment (project_id, teammate_id, role, effective)
    VALUES (${foreignProj!.id}::uuid, ${billerB}::uuid, 'member', tstzrange('2020-01-01', NULL, '[)'))`
  await t.client`INSERT INTO instance_attestation (instance_id, principal_oid, teammate_id, tool, region_id, org_unit_id, project_code_hash, raw_project_code)
    VALUES (gen_random_uuid(), 'p', ${subjectId}::uuid, 'claude-code', ${regionA}::uuid, ${couA}::uuid, 'h', 'P')`
  const [inst] = await t.client<{ id: string }[]>`SELECT instance_id::text AS id FROM instance_attestation WHERE teammate_id=${subjectId}::uuid LIMIT 1`
  await t.client`INSERT INTO attribution_record
      (instance_id, teammate_id, region_id, org_unit_id, cost_owning_unit_id, project_id, tool, model, token_type, tokens, cost_usd, fidelity_tier, cost_basis, ts_event, claude_session_id)
    VALUES (${inst!.id}::uuid, ${subjectId}::uuid, ${regionA}::uuid, ${couA}::uuid, ${couA}::uuid, ${proj!.id}::uuid,
            'claude-code', 'claude-sonnet-4-6', 'input', 1000, 42, 'tier-1', 'estimated', '2026-07-05T00:00:00Z'::timestamptz, 'conv-rv')`

  // A July bill per region so the finance surfaces have real bill rows to read
  // (billerA → couA/region A; billerB → couB/region B).
  await t.client`INSERT INTO actual_spend (teammate_id, date, tool, input_tokens, output_tokens, cost_usd, source, chargeback_exempt)
    VALUES (${billerA}::uuid, '2026-07-05'::date, 'claude-code', 500, 500, 12, 'anthropic-analytics-api', false)`
  await t.client`INSERT INTO actual_spend (teammate_id, date, tool, input_tokens, output_tokens, cost_usd, source, chargeback_exempt)
    VALUES (${billerB}::uuid, '2026-07-05'::date, 'claude-code', 500, 500, 20, 'anthropic-analytics-api', false)`
}, 120_000)

afterAll(async () => {
  if (t) await stopTestDb(t)
})

describe('the endpoint matrix — persona × grant state', () => {
  it('plain dev, no grants: region own only, 403 elsewhere (byte-identical to old "standard" developer)', async () => {
    await clearGrants()
    await expectAll(regionCallsAll(plainDevSess()), false)
    await ok(regionIndex(ev(plainDevSess(), 'month=2026-07'))) // never stranded — one region still served
    await expectAll(financeCalls(plainDevSess()), false)
    await forbidden(costCentresIndex(ev(plainDevSess(), 'month=2026-07')))
    await forbidden(teammateDrill(ev(plainDevSess(), `src=cc:${couA}&month=2026-07`, { id: subjectId })))
    await forbidden(teammateDrillExport(ev(plainDevSess(), `src=cc:${couA}&month=2026-07`, { id: subjectId })))
    await forbidden(projectDepth(ev(plainDevSess(), 'month=2026-07', { code: 'RV-PROJ' })))
  })

  it('owner (developer + active cou_owner), no grants: old "standard" owner expectations', async () => {
    await clearGrants()
    await expectAll(regionCallsAll(ownerSess()), false)
    await ok(regionIndex(ev(ownerSess(), 'month=2026-07')))
    await expectAll(financeCalls(ownerSess()), false)
    await ok(costCentresIndex(ev(ownerSess(), 'month=2026-07')))
    await ok(teammateDrill(ev(ownerSess(), `src=cc:${couA}&month=2026-07`, { id: subjectId })))
    await ok(teammateDrillExport(ev(ownerSess(), `src=cc:${couA}&month=2026-07`, { id: subjectId })))
    await ok(projectDepth(ev(ownerSess(), 'month=2026-07', { code: 'RV-PROJ' })))
  })

  // ── The ROLE-DEFAULT proof (PO decision 2026-08-13, reversing #251 for the
  // ORG-WIDE roles ONLY). `platform-admin` and `platform-admin` see the WHOLE
  // COMPANY with NO grant at all: region=all, the finance pack, the unbounded BU
  // list, the across-frame teammate drill, and region-wide project depth. A
  // region `admin` is NOT in this set — the test directly above proves it stays
  // region-bound.
  const fullAccessByRole = async (session: () => ReturnType<typeof adminSess>) => {
    await clearGrants()
    await expectAll(regionCallsAll(session()), true)
    await expectAll(financeCalls(session()), true)
    await ok(costCentresIndex(ev(session(), 'month=2026-07')))
    await ok(teammateDrill(ev(session(), 'src=across&month=2026-07', { id: subjectId })))
    await ok(projectDepth(ev(session(), 'month=2026-07', { code: 'RV-PROJ' })))
  }

  it('admin (region admin), no grants: own region + owned BUs, but NOT whole-company or finance', async () => {
    // A region admin is REGION-BOUND (the anti-IDOR clamp): own-region 200,
    // region=all + finance 403, owned-BU surfaces 200. The full-company default
    // is only for the org-wide roles below.
    await clearGrants()
    await expectAll(regionCallsAll(adminSess()), false)
    await ok(regionIndex(ev(adminSess(), 'month=2026-07')))
    await expectAll(financeCalls(adminSess()), false)
    await ok(costCentresIndex(ev(adminSess(), 'month=2026-07')))
    await ok(teammateDrill(ev(adminSess(), `src=cc:${couA}&month=2026-07`, { id: subjectId })))
    await ok(projectDepth(ev(adminSess(), 'month=2026-07', { code: 'RV-PROJ' })))
  })

  it('platform-admin, no grants: FULL company access by role', async () => {
    /*
     * ONE case, not two. These were `global-finops` and `platform-admin` until
     * the former was retired; the rename made both sessions platform-admin, so
     * the identical assertion ran twice under the identical name while the
     * boundary it used to prove — that a non-org-wide role does NOT get this by
     * role — quietly disappeared. The manager case below is that boundary,
     * restored.
     */
    await fullAccessByRole(platformSess)
  })

  it('a MANAGER gets no WHOLE-COMPANY access by role — that is org-wide only', async () => {
    /*
     * Asserts what the matrix actually denies a manager: `across: false` (so no
     * region=all width) and `finance: false`. NOT the cost-centre list — a
     * manager holds `costCentre: 'owned-or-subtree'` and is legitimately 200
     * there, which is the assertion this case got wrong on the first attempt.
     */
    await clearGrants()
    await expectAll(regionCallsAll(managerSess()), false)
    await expectAll(financeCalls(managerSess()), false)
  })

  /*
   * The SHELL contract, not just the endpoints. `/reports/meta` is the ONE
   * bootstrap fetch: it decides which tabs render, where Region lands, whether
   * the drill columns are links, and whether the "elevated access" chip appears.
   */
  interface MetaShape {
    scopes: string[]
    defaultScope: string | null
    region: { landing: string | null; allRegions: boolean }
    drill: { teammate: string | false; project: string | false }
    permissions?: string[]
  }

  it('/reports/meta, platform-admin with no grant: every scope, by role alone', async () => {
    await clearGrants()
    const m = (await metaHandler(ev(platformSess()))) as unknown as MetaShape
    expect(m.scopes).toEqual(['region', 'cost-centre', 'finance'])
    expect(m.defaultScope).toBe('region')
    expect(m.region).toEqual({ landing: 'all-regions', allRegions: true })
    // No grant row exists, so still no chip — the access is role-derived.
    expect(m.permissions).toBeUndefined()
  })

  it('/reports/meta, a positive grant: the chip appears', async () => {
    await clearGrants()
    await grantReportAccess(t.client, plainDevId, 'operational')
    try {
      const m = (await metaHandler(ev(plainDevSess()))) as unknown as MetaShape
      expect(m.permissions).toEqual(['operational'])
      expect(m.scopes).toContain('region')
    } finally {
      await clearGrants()
    }
  })

  /*
   * The response that carries the grant set must not be storable. Observed in
   * production: a browser holding an hour-old `private, max-age=3600` copy
   * rendered "You don't have access to any reports" with NO request to this
   * endpoint at all, for an admin who by then had full access — and a reload
   * fixed it.
   */
  it('/reports/meta is NOT storable — it carries the grant set, so a stale copy shows the wrong access', async () => {
    const e = ev(platformSess())
    await metaHandler(e)
    const headers = (e as unknown as { node: { res: { _headers: Record<string, unknown> } } }).node.res._headers
    expect(headers['cache-control']).toBe('no-store')
    // Belt and braces: any freshness lifetime at all is the defect, whatever the
    // directive it is spelled with.
    expect(String(headers['cache-control'])).not.toMatch(/max-age|s-maxage|stale-while-revalidate/)
  })

  it('plain dev + operational: 200 on region=all, all-BU list, teammate drill via across frame; 403 on finance', async () => {
    await clearGrants()
    await grantReportAccess(t.client, plainDevId, 'operational')
    await expectAll(regionCallsAll(plainDevSess()), true)
    await ok(costCentresIndex(ev(plainDevSess(), 'month=2026-07')))
    await ok(teammateDrill(ev(plainDevSess(), 'src=across&month=2026-07', { id: subjectId })))
    await ok(projectDepth(ev(plainDevSess(), 'month=2026-07', { code: 'RV-PROJ' })))
    await expectAll(financeCalls(plainDevSess()), false)
  })

  /*
   * A REGION ADMIN IS WIDENED BY A GRANT TOO. Easy to assume the positive grants
   * only exist for non-admin roles now that the org-wide roles hold everything at
   * baseline — they do not: a grant widens ANY caller whose baseline lacks that
   * scope, and a region `admin` is exactly such a caller. Route-level on purpose
   * (rule 10): the module test proves the grant OBJECT, only the endpoints prove
   * the region clamp actually lifts. Without these two cases the whole
   * "region admins stay bound, but a grant still reaches them" contract — which
   * the wiki asserts — is unproven end to end.
   */
  it('admin (region admin) + operational: the grant WIDENS a region-bound role cross-region', async () => {
    await clearGrants()
    await grantReportAccess(t.client, adminId, 'operational')
    try {
      // region=all was 403 for this same caller with no grant (the case above).
      await expectAll(regionCallsAll(adminSess()), true)
      await ok(costCentresIndex(ev(adminSess(), 'month=2026-07')))
      await ok(teammateDrill(ev(adminSess(), 'src=across&month=2026-07', { id: subjectId })))
      await ok(projectDepth(ev(adminSess(), 'month=2026-07', { code: 'RV-PROJ' })))
      // …but 'operational' never implies the finance pack, for an admin either.
      await expectAll(financeCalls(adminSess()), false)
    } finally {
      await clearGrants()
    }
  })

  it('admin (region admin) + finance: reaches the finance pack, and STAYS region-bound elsewhere', async () => {
    await clearGrants()
    await grantReportAccess(t.client, adminId, 'finance')
    try {
      await expectAll(financeCalls(adminSess()), true)
      // The region clamp is untouched by a finance grant — the two are independent.
      await expectAll(regionCallsAll(adminSess()), false)
      await ok(regionIndex(ev(adminSess(), 'month=2026-07')))
    } finally {
      await clearGrants()
    }
  })

  it('plain dev + finance: 200 finance index/drill/export; regional stays own-region; 403 region=all', async () => {
    await clearGrants()
    await grantReportAccess(t.client, plainDevId, 'finance')
    await expectAll(financeCalls(plainDevSess()), true)
    await expectAll(regionCallsAll(plainDevSess()), false)
    await ok(regionIndex(ev(plainDevSess(), 'month=2026-07')))
  })

  it('plain dev + both: the full set', async () => {
    await clearGrants()
    await grantReportAccess(t.client, plainDevId) // default (no permissions named): BOTH
    await expectAll(regionCallsAll(plainDevSess()), true)
    await expectAll(financeCalls(plainDevSess()), true)
    await ok(costCentresIndex(ev(plainDevSess(), 'month=2026-07')))
    await ok(teammateDrill(ev(plainDevSess(), 'src=across&month=2026-07', { id: subjectId })))
    await ok(projectDepth(ev(plainDevSess(), 'month=2026-07', { code: 'RV-PROJ' })))
  })

  it('platform-admin + both (the backfill-equivalent state): old org-wide expectations, byte-identical', async () => {
    await clearGrants()
    await grantReportAccess(t.client, finopsId)
    await expectAll(regionCallsAll(finopsSess()), true)
    await expectAll(financeCalls(finopsSess()), true)
    await ok(costCentresIndex(ev(finopsSess(), 'month=2026-07')))
    await ok(teammateDrill(ev(finopsSess(), 'src=across&month=2026-07', { id: subjectId })))
    await ok(projectDepth(ev(finopsSess(), 'month=2026-07', { code: 'RV-PROJ' })))
  })
})

describe('grant lifecycle — expired / revoked behave as no grant; re-grant after revoke works', () => {
  it('an EXPIRED grant (expires_at in the past) behaves as no grant', async () => {
    await clearGrants()
    const past = new Date(Date.now() - 60_000).toISOString()
    await t.client`INSERT INTO report_access_grant (teammate_id, permission, granted_by, expires_at)
      VALUES (${plainDevId}::uuid, 'operational', NULL, ${past}::timestamptz)`
    await forbidden(regionIndex(evAll(plainDevSess(), 'month=2026-07')))
    await forbidden(costCentresIndex(ev(plainDevSess(), 'month=2026-07')))
  })

  it('a REVOKED grant behaves as no grant', async () => {
    await clearGrants()
    await grantReportAccess(t.client, plainDevId, 'operational')
    await t.client`UPDATE report_access_grant SET revoked_at = now(), revoked_by = ${adminId}::uuid
      WHERE teammate_id = ${plainDevId}::uuid AND permission = 'operational'`
    await forbidden(regionIndex(evAll(plainDevSess(), 'month=2026-07')))
  })

  it('re-grant after REVOKE works — the partial unique index respects a revoked row', async () => {
    await clearGrants()
    await grantReportAccess(t.client, plainDevId, 'operational')
    await t.client`UPDATE report_access_grant SET revoked_at = now(), revoked_by = ${adminId}::uuid
      WHERE teammate_id = ${plainDevId}::uuid AND permission = 'operational'`
    await forbidden(regionIndex(evAll(plainDevSess(), 'month=2026-07')))
    await grantReportAccess(t.client, plainDevId, 'operational') // a fresh, ACTIVE row
    await ok(regionIndex(evAll(plainDevSess(), 'month=2026-07')))
  })
})

/*
 * ── C3 (post external design review) ────────────────────────────────────────
 */
describe('org-wide role, NO grants: a FOREIGN-region ?ou= drill on /reports/region now OPENS (full access by role)', () => {
  it('platform-admin', async () => {
    await clearGrants()
    await ok(regionIndex(ev(finopsSess(), `month=2026-07&ou=${couB}`)))
  })

  it('platform-admin', async () => {
    await clearGrants()
    await ok(regionIndex(ev(platformSess(), `month=2026-07&ou=${couB}`)))
  })
})

// The `ownerOnly` seal (#251) restricted an org-wide role with ownership-but-no-grant
// to its owned subtree. Under the role-default policy that class no longer exists —
// an org-wide role sees EVERY BU and EVERY project by role, ownership irrelevant —
// so the seal is now unreachable (baseline costCentre is 'all', never 'owned-or-subtree').
// FOLLOW-UP: retire `ownerOnly` from costCentreScopeOpts / cost-centres.ts / project-depth.ts.
describe('org-wide role + active cou_owner, NO grants: sees the WHOLE company by role (seal retired)', () => {
  it('/reports/cost-centres lists EVERY BU, not just the owned subtree', async () => {
    await clearGrants()
    const res = (await costCentresIndex(
      ev(finopsOwnerSess(), 'month=2026-07'),
    )) as unknown as { cards: { id: string }[] }
    const ids = res.cards.map((c) => c.id)
    expect(ids).toContain(couA)
    expect(ids).toContain(couB) // the foreign BU is now present — role sees all
  })

  it('the cc drill of BOTH the owned and a foreign BU opens', async () => {
    await clearGrants()
    await ok(costCentreDrill(ev(finopsOwnerSess(), 'month=2026-07', { ccId: couA })))
    await ok(costCentreDrill(ev(finopsOwnerSess(), 'month=2026-07', { ccId: couB })))
  })

  it('project reports-depth: both the owned and a FOREIGN project open (region-wide by role)', async () => {
    await clearGrants()
    await ok(projectDepth(ev(finopsOwnerSess(), 'month=2026-07', { code: 'RV-PROJ' })))
    await ok(projectDepth(ev(finopsOwnerSess(), 'month=2026-07', { code: 'RV-FOREIGN' })))
  })
})

describe('C3: role demotion does NOT retract an already-active grant (designed persistence)', () => {
  it('a teammate demoted platform-admin → developer keeps ACTIVE grants elevating (200 on finance + region=all)', async () => {
    await clearGrants()
    await grantReportAccess(t.client, demotedId) // both permissions, while still platform-admin
    // `report_access_grant` carries no role column (mig 0129) and
    // `resolveReportPermissions` never joins `teammate.role` — a grant is keyed
    // on `teammate_id` alone. Demoting the role therefore does NOT re-evaluate or
    // retract it: revoking access after a demotion is a SEPARATE admin action
    // (DELETE /admin/report-access/:id). This is the DESIGNED behaviour, not a
    // gap — pinned here so nobody "fixes" it into an implicit revoke later.
    await t.client`UPDATE teammate SET role = 'developer' WHERE id = ${demotedId}::uuid`
    try {
      const demotedSess: Session = {
        teammateId: demotedId,
        email: 'demoted@a.test',
        displayName: 'D',
        role: 'developer',
        regionId: regionA,
        orgPath: 'a',
        issuedAt: new Date().toISOString(),
      } as unknown as Session
      await ok(regionIndex(evAll(demotedSess, 'month=2026-07')))
      await ok(financeIndex(ev(demotedSess, 'month=2026-06')))
    } finally {
      await t.client`UPDATE teammate SET role = 'platform-admin' WHERE id = ${demotedId}::uuid`
    }
  })
})

describe('C3: expires_at boundary — a grant expiring at now() does not elevate (<=, not <)', () => {
  it('a grant whose expires_at equals the grant-time now() is already inactive by the time it is read', async () => {
    await clearGrants()
    const [row] = await t.client<{ now: string }[]>`SELECT now()::text AS now`
    await t.client`INSERT INTO report_access_grant (teammate_id, permission, granted_by, expires_at)
      VALUES (${plainDevId}::uuid, 'operational', NULL, ${row!.now}::timestamptz)`
    await forbidden(regionIndex(evAll(plainDevSess(), 'month=2026-07')))
  })
})

/*
 * sg-M4 survives the merge, restated on the WIDTH, and the deny-audit payload
 * now carries `permissions` (an array of the caller's ACTIVE permissions at the
 * time of the deny) rather than the retired `mode` field.
 */
describe('sg-M4: every deny of an UNCLAMPED answer (region=all + /reports/finance) is audited, with `permissions`', () => {
  it('a real-teammate deny writes a report-scope-denied audit carrying scope, width and permissions', async () => {
    await clearGrants() // plainDev holds NO permissions — denied region=all + finance
    await forbidden(regionIndex(evAll(plainDevSess(), 'month=2026-07')))
    await forbidden(financeIndex(ev(plainDevSess(), 'month=2026-06')))
    // audit_event is append-only, so we assert existence (never clear). The deny is
    // written on a SEPARATE connection, so it survives the 403's request-tx rollback.
    const rows = await t.client<
      { actor_teammate_id: string; payload: { scope: string; width?: string; permissions: string[] } }[]
    >`
      SELECT actor_teammate_id::text AS actor_teammate_id, payload
      FROM audit_event
      WHERE event_type = 'report-scope-denied' AND actor_teammate_id = ${plainDevId}::uuid`
    // The whole-company Region deny is recorded WITH its width.
    const acrossDeny = rows.find((r) => r.payload.scope === 'region' && r.payload.width === 'all-regions')
    expect(acrossDeny).toBeDefined()
    expect(Array.isArray(acrossDeny!.payload.permissions)).toBe(true)
    expect(acrossDeny!.payload.permissions).toEqual([]) // no ACTIVE permissions at deny time
    const financeDeny = rows.find((r) => r.payload.scope === 'finance')
    expect(financeDeny).toBeDefined()
    expect(financeDeny!.payload.permissions).toEqual([])
  })

  it('the SAME caller denied region=all is still SERVED one region — never stranded', async () => {
    await clearGrants() // this developer holds `regional: 'own-region'`, not `across`
    const before = await t.client<{ n: string }[]>`
      SELECT COUNT(*)::text AS n FROM audit_event
      WHERE event_type = 'report-scope-denied' AND payload->>'width' = 'region'`

    const served = (await regionIndex(ev(plainDevSess(), 'month=2026-07'))) as unknown as {
      width: string
      region: { id: string } | null
      allRegionsAvailable: boolean
    }
    expect(served.width).toBe('region')
    expect(served.region).not.toBeNull()
    // …and the selector honestly reports that the wider width is NOT theirs.
    expect(served.allRegionsAvailable).toBe(false)

    const after = await t.client<{ n: string }[]>`
      SELECT COUNT(*)::text AS n FROM audit_event
      WHERE event_type = 'report-scope-denied' AND payload->>'width' = 'region'`
    expect(Number(after[0]!.n)).toBe(Number(before[0]!.n))
  })

  it('an audit-write failure still returns 403 AND emits the [SECURITY-AUDIT-WRITE-FAILED] alertable marker', async () => {
    await clearGrants()
    // For across/finance the audit IS the only record, so a write failure is itself a
    // security-critical event ops must alert on. Force the write to throw (spy, not a
    // module-wide vi.mock, so the real-audit test above is unaffected).
    const auditSpy = vi.spyOn(auditModule, 'recordAuditEvent').mockRejectedValue(new Error('boom'))
    const errSpy = vi.spyOn(consola, 'error').mockImplementation(() => {})
    try {
      // The deny must STILL return 403 — audit is best-effort by nature.
      await forbidden(regionIndex(evAll(plainDevSess(), 'month=2026-07')))
      expect(auditSpy).toHaveBeenCalled()
      const marked = errSpy.mock.calls.find(
        (c) => typeof c[0] === 'string' && c[0].includes('[SECURITY-AUDIT-WRITE-FAILED]'),
      )
      expect(marked, 'expected the [SECURITY-AUDIT-WRITE-FAILED] marker line').toBeTruthy()
      // Ids-only structured fields (no PII) ride the marker for alert routing.
      expect(marked?.[1]).toMatchObject({ scope: 'region', actorTeammateId: plainDevId })
    } finally {
      auditSpy.mockRestore()
      errSpy.mockRestore()
    }
  })
})

describe('S3 part (d): a plain developer (no cou_owner row) is denied the cost-centre scope with no grants', () => {
  it('GET /reports/cost-centres → 403 (never a silent empty list)', async () => {
    await clearGrants()
    await forbidden(costCentresIndex(ev(plainDevSess(), 'month=2026-07')))
  })
})

/*
 * sg-L11 successor. MUST run LAST — it drops the table out from under every
 * subsequent test in the file.
 */
describe('sg-L11 successor: DROP TABLE report_access_grant → degrade to the ROLE baseline, never throw', () => {
  it('after dropping the table, the role DEFAULT still applies (grants are an overlay); no throw', async () => {
    await t.client`DROP TABLE report_access_grant`
    // The grant table is an OVERLAY on the role default; its absence degrades to
    // that default, it does not strand anyone and it never throws.
    // resolveReportPermissions gates on to_regclass(...) FIRST, so a missing
    // table short-circuits to [].
    //
    // An ORG-WIDE role therefore still sees the whole company (region=all +
    // finance) by ROLE — no grant row was ever needed.
    await ok(regionIndex(evAll(finopsSess(), 'month=2026-07')))
    await ok(financeIndex(ev(finopsSess(), 'month=2026-06')))
    // …while a region admin keeps their BOUNDED baseline: own-region 200,
    // region=all + finance 403 — proving the degrade is to the ROLE floor, which
    // for a region admin is their own region, not "all".
    await ok(regionIndex(ev(adminSess(), 'month=2026-07')))
    await forbidden(regionIndex(evAll(adminSess(), 'month=2026-07')))
    await forbidden(financeIndex(ev(adminSess(), 'month=2026-06')))
  })
})
