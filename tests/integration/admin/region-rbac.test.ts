// @vitest-environment node
/*
 * Epic 13 admin endpoints — cross-region RBAC contract.
 *
 * Pins: an `admin` role with home region A must NOT see region B's
 * data. A `platform-admin` role can see any region. This is the
 * server-side gate behind the admin 6-tab page.
 *
 * Tests run the SQL through the handlers indirectly via the
 * requireAuth + assertion logic; the contract here is the SQL row
 * filter, exercised against testcontainers.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { sql } from 'drizzle-orm'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'
import * as schema from '../../../drizzle/schema'
import { injectTestSession } from '../../helpers/auth'
import type { Session } from '../../../server/utils/auth'
import mapPost from '../../../server/api/v1/admin/reconciliation/github/map.post'

let t: TestDb
let regionAId: string
let regionBId: string
let teammateOneAId: string
let teammateOneBId: string
let adminAId: string
let finopsId: string
let ghEnterpriseId: string

beforeAll(async () => {
  t = await startTestDb()
  process.env.DATABASE_URL = t.url
  const [a] = await t.db.insert(schema.region).values({ code: 'rgn-a', displayName: 'A' }).returning()
  const [b] = await t.db.insert(schema.region).values({ code: 'rgn-b', displayName: 'B' }).returning()
  regionAId = a!.id
  regionBId = b!.id

  // 1 BU + 2 teammates per region.
  for (const [r, label] of [[regionAId, 'a'], [regionBId, 'b']] as const) {
    const [bu] = await t.db
      .insert(schema.orgUnit)
      .values({
        regionId: r,
        path: `${label}.svc`,
        code: `${label}-svc`,
        displayName: `${label} services`,
        unitType: 'bu',
        isCostOwningUnit: true,
      })
      .returning()
    const inserted = await t.db.insert(schema.teammate).values([
      {
        entraOid: `oid-${label}-1`,
        email: `one-${label}@example.com`,
        regionId: r,
        orgUnitId: bu!.id,
      },
      {
        entraOid: `oid-${label}-2`,
        email: `two-${label}@example.com`,
        regionId: r,
        orgUnitId: bu!.id,
      },
    ]).returning()
    if (label === 'a') teammateOneAId = inserted[0]!.id
    else teammateOneBId = inserted[0]!.id
    if (label === 'a') {
      const [admin] = await t.db
        .insert(schema.teammate)
        .values({ entraOid: 'oid-a-admin', email: 'admin-a@example.com', regionId: r, orgUnitId: bu!.id, role: 'admin' })
        .returning()
      adminAId = admin!.id
      const [finops] = await t.db
        .insert(schema.teammate)
        .values({ entraOid: 'oid-a-finops', email: 'finops-a@example.com', regionId: r, orgUnitId: bu!.id, role: 'platform-admin' })
        .returning()
      finopsId = finops!.id
    }
  }

  const [ent] = await t.db
    .insert(schema.providerEnterprise)
    .values({ provider: 'github', externalId: 'rbac-ent', displayName: 'RBAC Ent' })
    .returning()
  ghEnterpriseId = ent!.id
}, 60_000)

afterAll(async () => {
  await stopTestDb(t)
}, 30_000)

function ev(opts: { session: Session; body: unknown }) {
  const headers: Record<string, string> = { host: 'localhost:3450', origin: 'http://localhost:3450' }
  const e = {
    method: 'POST',
    path: '/x',
    context: { params: {} },
    node: {
      req: {
        method: 'POST',
        url: '/x',
        body: opts.body,
        socket: { remoteAddress: '127.0.0.1' },
        get headers() {
          return { ...headers, 'content-type': 'application/json' }
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
  injectTestSession(e as unknown as Parameters<typeof injectTestSession>[0], opts.session)
  return e as unknown as Parameters<typeof mapPost>[0]
}

// Lazy: adminAId/finopsId/regionAId are only populated once beforeAll has run,
// which is guaranteed by the time any `it()` body calls these.
const adminASession = (): Session => ({
  teammateId: adminAId,
  email: 'admin-a@example.com',
  displayName: 'Admin A',
  role: 'admin',
  regionId: regionAId,
  orgPath: 'a.svc',
})
const orgWideSession = (): Session => ({
  teammateId: finopsId,
  email: 'finops-a@example.com',
  displayName: 'Finops',
  role: 'platform-admin',
  regionId: regionAId,
  orgPath: 'a.svc',
})

describe('admin region SQL contract', () => {
  it('teammates query scoped by region returns only that region`s rows', async () => {
    const rowsA = await t.db.execute<{ email: string }>(sql`
      SELECT email FROM teammate WHERE region_id = ${regionAId}::uuid ORDER BY email
    `)
    const rowsB = await t.db.execute<{ email: string }>(sql`
      SELECT email FROM teammate WHERE region_id = ${regionBId}::uuid ORDER BY email
    `)
    const aList = [...rowsA].map((r) => r.email)
    const bList = [...rowsB].map((r) => r.email)
    // Region A also carries the admin / platform-admin fixtures used by the
    // github/map region-clamp tests below (admin-a@, finops-a@).
    expect(aList).toEqual(['admin-a@example.com', 'finops-a@example.com', 'one-a@example.com', 'two-a@example.com'])
    expect(bList).toEqual(['one-b@example.com', 'two-b@example.com'])
    // No leakage.
    expect(aList.some((e) => e.endsWith('-b@example.com'))).toBe(false)
    expect(bList.some((e) => e.endsWith('-a@example.com'))).toBe(false)
  })

  it('org-unit tree scoped by region returns only that region`s nodes', async () => {
    const rowsA = await t.db.execute<{ code: string }>(sql`
      SELECT code FROM org_unit WHERE region_id = ${regionAId}::uuid
    `)
    const rowsB = await t.db.execute<{ code: string }>(sql`
      SELECT code FROM org_unit WHERE region_id = ${regionBId}::uuid
    `)
    expect([...rowsA].map((r) => r.code)).toEqual(['a-svc'])
    expect([...rowsB].map((r) => r.code)).toEqual(['b-svc'])
  })

  it('counts per region are independent', async () => {
    const counts = await t.db.execute<{ region_id: string; count: string }>(sql`
      SELECT region_id::text AS region_id, COUNT(*)::text AS count
      FROM teammate GROUP BY region_id ORDER BY region_id
    `)
    const list = [...counts]
    expect(list.length).toBe(2)
    const byRegion = new Map(list.map((r) => [r.region_id, Number(r.count)]))
    // Region A: the 2 base fixtures + the admin/platform-admin fixtures added for
    // the github/map region-clamp tests below. Region B: the 2 base fixtures only.
    expect(byRegion.get(regionAId)).toBe(4)
    expect(byRegion.get(regionBId)).toBe(2)
  })
})

async function boundTeammateId(login: string): Promise<string | null> {
  const rows = await t.db.execute<{ teammate_id: string }>(sql`
    SELECT teammate_id::text AS teammate_id FROM teammate_identity_map
    WHERE system = 'github' AND COALESCE(enterprise_slug, '') = 'rbac-ent' AND lower(identifier) = ${login}
    LIMIT 1
  `)
  return [...rows][0]?.teammate_id ?? null
}

describe('github/map region clamp — both ends (server-api-app:idor:0004 / T3-xregion-05)', () => {
  it('region-A admin maps a login to a region-B teammate → 403, no row written', async () => {
    await expect(
      mapPost(ev({
        session: adminASession(),
        body: { enterpriseId: ghEnterpriseId, teammateId: teammateOneBId, login: 'octo-target-b' },
      })),
    ).rejects.toMatchObject({ statusCode: 403 })
    expect(await boundTeammateId('octo-target-b')).toBeNull()
  })

  it('same-region map → 200', async () => {
    const res = (await mapPost(ev({
      session: adminASession(),
      body: { enterpriseId: ghEnterpriseId, teammateId: teammateOneAId, login: 'octo-same-region' },
    }))) as { teammateId: string }
    expect(res.teammateId).toBe(teammateOneAId)
    expect(await boundTeammateId('octo-same-region')).toBe(teammateOneAId)
  })

  it('region-A admin re-maps a login currently bound to a region-B teammate → 403, binding unchanged', async () => {
    // platform-admin binds it to the region-B teammate first (the SOURCE binding).
    await mapPost(ev({
      session: orgWideSession(),
      body: { enterpriseId: ghEnterpriseId, teammateId: teammateOneBId, login: 'octo-bound-b' },
    }))
    expect(await boundTeammateId('octo-bound-b')).toBe(teammateOneBId)

    // region-A admin tries to pull it to their OWN (region-A) teammate — denied even though the
    // TARGET is in-region, because the CURRENTLY-bound teammate is region B (the mirror-image leak).
    await expect(
      mapPost(ev({
        session: adminASession(),
        body: { enterpriseId: ghEnterpriseId, teammateId: teammateOneAId, login: 'octo-bound-b' },
      })),
    ).rejects.toMatchObject({ statusCode: 403 })
    // The binding must be untouched — still region B.
    expect(await boundTeammateId('octo-bound-b')).toBe(teammateOneBId)
  })

  it('region-A admin binds a login SELF-linked by a region-B teammate → 403, no enterprise-lane row', async () => {
    await t.db.insert(schema.teammateIdentityMap).values({
      teammateId: teammateOneBId,
      system: 'github',
      identifier: 'octo-self-b',
      identifierKind: 'username',
      source: 'self',
    })
    await expect(
      mapPost(ev({
        session: adminASession(),
        body: { enterpriseId: ghEnterpriseId, teammateId: teammateOneAId, login: 'octo-self-b' },
      })),
    ).rejects.toMatchObject({ statusCode: 403 })
    expect(await boundTeammateId('octo-self-b')).toBeNull()
  })

  it('platform-admin maps a login to a region-B teammate → succeeds (region-unbounded)', async () => {
    const res = (await mapPost(ev({
      session: orgWideSession(),
      body: { enterpriseId: ghEnterpriseId, teammateId: teammateOneBId, login: 'octo-finops-b' },
    }))) as { teammateId: string }
    expect(res.teammateId).toBe(teammateOneBId)
  })

  it('platform-admin re-maps a login bound to a region-B teammate over to a region-A teammate → succeeds', async () => {
    // Bound to region B by the previous test; platform-admin can freely re-bind across regions.
    const res = (await mapPost(ev({
      session: orgWideSession(),
      body: { enterpriseId: ghEnterpriseId, teammateId: teammateOneAId, login: 'octo-finops-b' },
    }))) as { teammateId: string }
    expect(res.teammateId).toBe(teammateOneAId)
    expect(await boundTeammateId('octo-finops-b')).toBe(teammateOneAId)
  })
})
