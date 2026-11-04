/*
 * PATCH /api/v1/admin/users/:id/region — move a teammate to another region.
 * Direct handler invocation against a mocked h3 event, real DB via testcontainers.
 * Verifies: org-wide gate (platform-admin only; region 'admin'
 * is 403), the move (region_id + home org_unit updated, sessions revoked,
 * audited), and the validation paths (unknown region, org_unit-not-in-region).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'
import * as schema from '../../../drizzle/schema'
import { injectTestSession } from '../../helpers/auth'
import type { Session } from '../../../server/utils/auth'
import regionHandler from '../../../server/api/v1/admin/users/[id]/region.patch'

let t: TestDb
let regionAId: string
let regionBId: string
let ouAId: string
let ouBId: string
let devAId: string
let finopsId: string
let adminAId: string

beforeAll(async () => {
  t = await startTestDb()
  // The handler resolves its DB via the getDb() singleton (DATABASE_URL), not
  // the injected t.db — point it at the test container (same as users-roles).
  process.env.DATABASE_URL = t.url
  process.env.NUXT_SESSION_SECRET = 'region-reassign-test-padded-to-thirty-two-chars'
  const [rA] = await t.db.insert(schema.region).values({ code: 'rr-a', displayName: 'RR A' }).returning()
  const [rB] = await t.db.insert(schema.region).values({ code: 'rr-b', displayName: 'RR B' }).returning()
  regionAId = rA!.id
  regionBId = rB!.id
  const [oA] = await t.db.insert(schema.orgUnit).values({ regionId: regionAId, path: 'rr-a.svc', code: 'rr-a-svc', displayName: 'A Svc', unitType: 'bu' }).returning()
  const [oB] = await t.db.insert(schema.orgUnit).values({ regionId: regionBId, path: 'rr-b.svc', code: 'rr-b-svc', displayName: 'B Svc', unitType: 'bu' }).returning()
  ouAId = oA!.id
  ouBId = oB!.id
  const [dev] = await t.db.insert(schema.teammate).values({ entraOid: 'oid-rr-dev', email: 'rr-dev@x.test', role: 'developer', regionId: regionAId, orgUnitId: ouAId }).returning()
  const [fin] = await t.db.insert(schema.teammate).values({ entraOid: 'oid-rr-fin', email: 'rr-fin@x.test', role: 'platform-admin', regionId: regionAId, orgUnitId: ouAId }).returning()
  const [adm] = await t.db.insert(schema.teammate).values({ entraOid: 'oid-rr-adm', email: 'rr-adm@x.test', role: 'admin', regionId: regionAId, orgUnitId: ouAId }).returning()
  devAId = dev!.id
  finopsId = fin!.id
  adminAId = adm!.id
}, 60_000)

afterAll(async () => {
  await stopTestDb(t)
}, 30_000)

function makeEvent(opts: { body?: unknown; routerParams?: Record<string, string>; initialSession?: Session }) {
  const cookies = new Map<string, string>()
  const headers: Record<string, string> = { host: 'localhost:3450' }
  const ev = {
    method: 'PATCH',
    path: '/api/v1/admin/users/x/region',
    context: { params: opts.routerParams ?? {} },
    node: {
      req: {
        method: 'PATCH',
        url: '/api/v1/admin/users/x/region',
        body: opts.body,
        get headers() {
          const cookieHeader = Array.from(cookies.entries()).map(([k, v]) => `${k}=${v}`).join('; ')
          return { ...headers, cookie: cookieHeader, 'content-type': 'application/json' }
        },
      },
      res: {
        _headers: {} as Record<string, string | string[]>,
        statusCode: 200,
        getHeader(n: string) { return this._headers[n.toLowerCase()] },
        setHeader(n: string, v: string | string[]) { this._headers[n.toLowerCase()] = v },
        removeHeader(n: string) { this._headers[n.toLowerCase()] = '' },
        appendHeader(n: string, v: string | string[]) { this._headers[n.toLowerCase()] = v },
        get headersSent() { return false },
      },
    },
  }
  if (opts.initialSession) injectTestSession(ev as unknown as Parameters<typeof injectTestSession>[0], opts.initialSession)
  return ev as unknown as Parameters<typeof regionHandler>[0]
}

const orgWideSession = (): Session => ({ teammateId: finopsId, email: 'rr-fin@x.test', displayName: 'Fin', role: 'platform-admin', regionId: regionAId, orgPath: 'rr-a.svc' })
const adminSession = (): Session => ({ teammateId: adminAId, email: 'rr-adm@x.test', displayName: 'Adm', role: 'admin', regionId: regionAId, orgPath: 'rr-a.svc' })

async function unplacedIdFor(rid: string): Promise<string> {
  const [row] = await t.client<{ id: string }[]>`
    SELECT id::text AS id FROM org_unit WHERE region_id = ${rid}::uuid AND code = '__UNPLACED__'`
  return row!.id
}

describe('PATCH users/:id/region', () => {
  it('platform-admin moves a teammate to another region (re-homes org_unit, revokes, audits, clears chain provenance)', async () => {
    // Pre-stamp manager-chain provenance so we can assert the admin move clears it (so
    // region-reenrichment treats the admin placement as authoritative, not re-derivable).
    await t.client`UPDATE teammate SET metadata = jsonb_build_object('placedVia','manager-chain','placedOwnerOid','o','keep','x') WHERE id = ${devAId}::uuid`
    await regionHandler(makeEvent({ body: { region_id: regionBId }, routerParams: { id: devAId }, initialSession: orgWideSession() }))
    const rows = await t.client<{ region_id: string; org_unit_id: string; revoked: boolean; via: string | null; keep: string | null }[]>`
      SELECT region_id::text AS region_id, org_unit_id::text AS org_unit_id, (revoked_at IS NOT NULL) AS revoked,
             metadata->>'placedVia' AS via, metadata->>'keep' AS keep
      FROM teammate WHERE id = ${devAId}::uuid`
    expect(rows[0]!.region_id).toBe(regionBId)
    // S3: an implicit (no explicit org_unit_id) move lands on region B's
    // __UNPLACED__ holding node, not "the lexicographically-first org_unit in
    // B" — that was the region ROOT (ouBId), whose subtree is the whole
    // region (server/auth/placement-home.ts).
    expect(rows[0]!.org_unit_id).toBe(await unplacedIdFor(regionBId))
    expect(rows[0]!.org_unit_id).not.toBe(ouBId)
    expect(rows[0]!.revoked).toBe(true)
    expect(rows[0]!.via).toBeNull() // provenance stripped by the admin move
    expect(rows[0]!.keep).toBe('x') // ... but other metadata keys preserved
    const audit = await t.client<{ count: string }[]>`
      SELECT COUNT(*)::text AS count FROM audit_event
      WHERE event_type = 'teammate-region-reassigned' AND subject_id = ${devAId}::uuid`
    expect(Number(audit[0]!.count)).toBeGreaterThanOrEqual(1)
  })

  it('strips every provenance key, including a rule-placed attribute', async () => {
    await t.client`UPDATE teammate SET metadata = jsonb_build_object('placedVia','attribute-rule','placedAttribute','department','placedStep','unit-rule','placedAt','t','keep','x') WHERE id = ${devAId}::uuid`
    await regionHandler(makeEvent({ body: { region_id: regionAId, org_unit_id: ouAId }, routerParams: { id: devAId }, initialSession: orgWideSession() }))
    const [row] = await t.client<{ metadata: Record<string, unknown> }[]>`SELECT metadata FROM teammate WHERE id = ${devAId}::uuid`
    expect(row!.metadata).toEqual({ keep: 'x' })
  })

  it('region-scoped admin cannot reassign (org-wide gate → 403)', async () => {
    await expect(
      regionHandler(makeEvent({ body: { region_id: regionAId }, routerParams: { id: devAId }, initialSession: adminSession() })),
    ).rejects.toMatchObject({ statusCode: 403 })
  })

  it('422 on an unknown region', async () => {
    await expect(
      regionHandler(makeEvent({ body: { region_id: '11111111-1111-4111-8111-111111111111' }, routerParams: { id: devAId }, initialSession: orgWideSession() })),
    ).rejects.toMatchObject({ statusCode: 422 })
  })

  it('422 when the explicit org_unit is not in the target region', async () => {
    await expect(
      regionHandler(makeEvent({ body: { region_id: regionAId, org_unit_id: ouBId }, routerParams: { id: devAId }, initialSession: orgWideSession() })),
    ).rejects.toMatchObject({ statusCode: 422 })
  })
})
