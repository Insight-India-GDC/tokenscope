// @vitest-environment node
/*
 * Grant lifecycle & consent management (design doc §Grant lifecycle, F3.1-3.5,
 * F3b.1). Real DB via testcontainers + the actual handlers called directly (the
 * instance-visibility.test.ts pattern: ev() builds an h3-shaped event with an
 * injected session + same-origin headers so assertSameOrigin passes).
 *
 * Invariants under test (RLS is inert under the owner DB connection, so the
 * app-level predicates ARE the live gate):
 *   1. GET /me/grants — owner-scoping + derived state (active for fresh,
 *      inactive when COALESCE(last_used_at, refresh_issued_at) older than 14d,
 *      revoked, expired). Never a peer's grant.
 *   2. POST /me/grants/{id}/revoke — owner-scoping: 404 (NOT 403, no existence
 *      leak) on a peer's grant; sets revoked_at on own; emit-grant revoke ALSO
 *      ends the teammate's live instances (F3.4).
 *   3. POST /admin/grants/{id}/revoke — region-scoping: region-admin → peer-region
 *      grant = 403; platform-admin any region. GET /admin/grants likewise scoped.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { sql } from 'drizzle-orm'
import { randomUUID } from 'node:crypto'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'
import * as schema from '../../../drizzle/schema'
import { injectTestSession } from '../../helpers/auth'
import type { Session } from '../../../server/utils/auth'

import meGrants from '../../../server/api/v1/me/grants/index.get'
import meRevoke from '../../../server/api/v1/me/grants/[id]/revoke.post'
import adminGrants from '../../../server/api/v1/admin/grants/index.get'
import adminRevoke from '../../../server/api/v1/admin/grants/[id]/revoke.post'

let t: TestDb
let regionAId: string
let regionBId: string
let ouAId: string
let ouBId: string
let devAId: string
let devA2Id: string
let devBId: string
let clientId: string

// Grant ids.
let grantFresh: string // devA, read+tag, fresh (active)
let grantStale: string // devA, read+tag, last_used 30d ago (inactive)
let grantRevoked: string // devA, already revoked
let grantExpired: string // devA, refresh expired
let grantEmit: string // devA, emit-scoped (cascade target)
let grantPeer: string // devA2, read (404 foil for devA's revoke)
let grantRegionB: string // devB, read (403 foil for admin A's revoke)

// devA's live instance (emit-cascade target).
let instDevA: string

const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR

async function insertGrant(opts: {
  teammateId: string
  scope: string
  refreshIssuedAt: Date
  lastUsedAt?: Date | null
  revokedAt?: Date | null
  refreshExpiresAt?: Date
  instanceId?: string | null
}): Promise<string> {
  const id = randomUUID()
  const now = Date.now()
  await t.db.insert(schema.oauthToken).values({
    id,
    accessTokenHash: `acc-${id}`,
    refreshTokenHash: `ref-${id}`,
    clientId,
    teammateId: opts.teammateId,
    scope: opts.scope,
    accessIssuedAt: opts.refreshIssuedAt,
    accessExpiresAt: new Date(now + HOUR),
    refreshIssuedAt: opts.refreshIssuedAt,
    refreshExpiresAt: opts.refreshExpiresAt ?? new Date(now + 90 * DAY),
    revokedAt: opts.revokedAt ?? null,
    lastUsedAt: opts.lastUsedAt ?? null,
    instanceId: opts.instanceId ?? null,
  })
  return id
}

/** Insert a live region-A instance_attestation for a teammate; returns its id. */
async function insertInstance(teammateId: string): Promise<string> {
  const instanceId = randomUUID()
  await t.db.insert(schema.instanceAttestation).values({
    instanceId,
    principalOid: `oid-${instanceId}`,
    principalEmail: `dev-${instanceId}@x.test`,
    teammateId,
    tool: 'claude-code',
    sessionTokenHash: `tok-${instanceId}`,
    regionId: regionAId,
    orgUnitId: ouAId,
    attestationState: 'unassigned',
  })
  return instanceId
}

beforeAll(async () => {
  t = await startTestDb()
  process.env.DATABASE_URL = t.url
  process.env.NUXT_SESSION_SECRET = 'grant-test-padded-to-thirty-two-characters'
  process.env.NUXT_HMAC_SESSION_KEY = 'grant-test-hmac-key-padded-well-beyond-32-chars'

  const [ra] = await t.db.insert(schema.region).values({ code: 'gr-a', displayName: 'Region A' }).returning()
  regionAId = ra!.id
  const [oa] = await t.db
    .insert(schema.orgUnit)
    .values({ regionId: regionAId, path: 'a.svc', code: 'a-svc', displayName: 'A Svc', unitType: 'bu', isCostOwningUnit: true })
    .returning()
  ouAId = oa!.id
  const [rb] = await t.db.insert(schema.region).values({ code: 'gr-b', displayName: 'Region B' }).returning()
  regionBId = rb!.id
  const [ob] = await t.db
    .insert(schema.orgUnit)
    .values({ regionId: regionBId, path: 'b.svc', code: 'b-svc', displayName: 'B Svc', unitType: 'bu', isCostOwningUnit: true })
    .returning()
  ouBId = ob!.id

  const [da] = await t.db
    .insert(schema.teammate)
    .values({ entraOid: 'gr-oid-dev-a', email: 'gr-dev-a@example.com', displayName: 'Dev A', role: 'developer', regionId: regionAId, orgUnitId: ouAId })
    .returning()
  devAId = da!.id
  const [da2] = await t.db
    .insert(schema.teammate)
    .values({ entraOid: 'gr-oid-dev-a2', email: 'gr-dev-a2@example.com', displayName: 'Dev A2', role: 'developer', regionId: regionAId, orgUnitId: ouAId })
    .returning()
  devA2Id = da2!.id
  const [dbb] = await t.db
    .insert(schema.teammate)
    .values({ entraOid: 'gr-oid-dev-b', email: 'gr-dev-b@example.com', displayName: 'Dev B', role: 'developer', regionId: regionBId, orgUnitId: ouBId })
    .returning()
  devBId = dbb!.id

  // Admins (caller sessions need a matching teammate row for audit FKs).
  await t.db.insert(schema.teammate).values([
    { id: '00000000-0000-4000-8000-0000000000a1', entraOid: 'gr-oid-admin-a', email: 'gr-admin-a@example.com', displayName: 'Admin A', role: 'admin', regionId: regionAId, orgUnitId: ouAId },
    { id: '00000000-0000-4000-8000-0000000000b1', entraOid: 'gr-oid-admin-b', email: 'gr-admin-b@example.com', displayName: 'Admin B', role: 'admin', regionId: regionBId, orgUnitId: ouBId },
    { id: '00000000-0000-4000-8000-0000000000f1', entraOid: 'gr-oid-plat', email: 'gr-plat@example.com', displayName: 'Platform', role: 'platform-admin', regionId: regionAId, orgUnitId: ouAId },
  ])

  // One oauth client (the client_name join target).
  const [c] = await t.db
    .insert(schema.oauthClient)
    .values({ clientSecretHash: 'csh', clientName: 'Claude Code', redirectUris: ['http://127.0.0.1:7777/callback'] })
    .returning()
  clientId = c!.clientId

  const now = Date.now()
  grantFresh = await insertGrant({ teammateId: devAId, scope: 'tokenscope.read tokenscope.tag', refreshIssuedAt: new Date(now) })
  // Inactive: both refresh_issued_at AND last_used_at older than 14d.
  grantStale = await insertGrant({
    teammateId: devAId,
    scope: 'tokenscope.read tokenscope.tag',
    refreshIssuedAt: new Date(now - 40 * DAY),
    lastUsedAt: new Date(now - 30 * DAY),
  })
  grantRevoked = await insertGrant({ teammateId: devAId, scope: 'tokenscope.read', refreshIssuedAt: new Date(now - DAY), revokedAt: new Date(now - HOUR) })
  grantExpired = await insertGrant({
    teammateId: devAId,
    scope: 'tokenscope.read',
    refreshIssuedAt: new Date(now - 100 * DAY),
    refreshExpiresAt: new Date(now - DAY),
  })
  grantEmit = await insertGrant({ teammateId: devAId, scope: 'tokenscope.emit', refreshIssuedAt: new Date(now) })
  grantPeer = await insertGrant({ teammateId: devA2Id, scope: 'tokenscope.read', refreshIssuedAt: new Date(now) })
  grantRegionB = await insertGrant({ teammateId: devBId, scope: 'tokenscope.read', refreshIssuedAt: new Date(now) })

  // devA's live instance — the emit-cascade target (ts_actual_end IS NULL).
  instDevA = randomUUID()
  await t.db.insert(schema.instanceAttestation).values({
    instanceId: instDevA,
    principalOid: 'gr-oid-dev-a',
    teammateId: devAId,
    tool: 'claude-code',
    regionId: regionAId,
    orgUnitId: ouAId,
    attestationState: 'unassigned',
  })
}, 60_000)

afterAll(async () => {
  await stopTestDb(t)
}, 30_000)

type AnyHandler = (e: unknown) => Promise<unknown>

function ev(opts: { params?: Record<string, string>; query?: Record<string, string>; body?: unknown; session: Session }) {
  const headers: Record<string, string> = { host: 'localhost:3450', origin: 'http://localhost:3450' }
  const qs = opts.query ? '?' + new URLSearchParams(opts.query).toString() : ''
  const url = '/x' + qs
  const e = {
    method: 'GET',
    path: url,
    context: { params: opts.params ?? {} },
    node: {
      req: {
        method: 'GET',
        url,
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
  return e as unknown
}

const devA = (): Session =>
  ({ teammateId: devAId, email: 'gr-dev-a@example.com', displayName: 'Dev A', role: 'developer', regionId: regionAId, orgPath: 'a.svc' }) as Session
const adminA = (): Session =>
  ({ teammateId: '00000000-0000-4000-8000-0000000000a1', email: 'gr-admin-a@example.com', displayName: 'Admin A', role: 'admin', regionId: regionAId, orgPath: 'a.svc' }) as Session
const platform = (): Session =>
  ({ teammateId: '00000000-0000-4000-8000-0000000000f1', email: 'gr-plat@example.com', displayName: 'Platform', role: 'platform-admin', regionId: regionAId, orgPath: 'a.svc' }) as Session

async function call<R = unknown>(h: unknown, e: unknown): Promise<R> {
  return (h as AnyHandler)(e) as Promise<R>
}

interface GrantOut { id: string; client_name: string; scopes: string[]; scope_labels: string[]; state: string; is_emit: boolean; created_at: string; last_used_at: string | null }

describe('1. GET /me/grants — owner-scoping + derived state', () => {
  it('returns own grants only, never a peer\'s, with the joined client name + labels', async () => {
    const out = await call<{ grants: GrantOut[] }>(meGrants, ev({ session: devA() }))
    const ids = out.grants.map((g) => g.id)
    expect(ids).toContain(grantFresh)
    expect(ids).toContain(grantEmit)
    expect(ids).not.toContain(grantPeer) // peer's grant never visible
    const fresh = out.grants.find((g) => g.id === grantFresh)!
    expect(fresh.client_name).toBe('Claude Code')
    expect(fresh.scopes).toEqual(['tokenscope.read', 'tokenscope.tag'])
    expect(fresh.scope_labels.length).toBe(2)
    expect(fresh.scope_labels[0]).toMatch(/Read your usage/)
  })

  it('derives state: fresh→active, stale→inactive, revoked→revoked, expired→expired, emit→is_emit', async () => {
    const out = await call<{ grants: GrantOut[] }>(meGrants, ev({ session: devA() }))
    const byId = Object.fromEntries(out.grants.map((g) => [g.id, g]))
    expect(byId[grantFresh]!.state).toBe('active')
    expect(byId[grantStale]!.state).toBe('inactive')
    expect(byId[grantRevoked]!.state).toBe('revoked')
    expect(byId[grantExpired]!.state).toBe('expired')
    expect(byId[grantEmit]!.is_emit).toBe(true)
    expect(byId[grantFresh]!.is_emit).toBe(false)
  })
})

describe('2. POST /me/grants/{id}/revoke — owner-scoping + emit cascade', () => {
  it('404 (no existence leak) revoking a peer\'s grant; peer grant stays live', async () => {
    await expect(
      call(meRevoke, ev({ params: { id: grantPeer }, session: devA() })),
    ).rejects.toMatchObject({ statusCode: 404 })
    const rows = await t.db.execute<{ revoked_at: string | null }>(sql`
      SELECT revoked_at FROM oauth_token WHERE id = ${grantPeer}::uuid
    `)
    expect([...rows][0]!.revoked_at).toBeNull()
  })

  it('404 on an unknown grant id', async () => {
    await expect(
      call(meRevoke, ev({ params: { id: randomUUID() }, session: devA() })),
    ).rejects.toMatchObject({ statusCode: 404 })
  })

  it('200 revoking own read+tag grant → sets revoked_at, no instance cascade', async () => {
    const out = await call<{ id: string; revoked: boolean; is_emit: boolean; instances_ended: number }>(
      meRevoke,
      ev({ params: { id: grantFresh }, session: devA() }),
    )
    expect(out).toMatchObject({ id: grantFresh, revoked: true, is_emit: false, instances_ended: 0 })
    const rows = await t.db.execute<{ revoked_at: string | null }>(sql`
      SELECT revoked_at FROM oauth_token WHERE id = ${grantFresh}::uuid
    `)
    expect([...rows][0]!.revoked_at).not.toBeNull()
    // The live instance is untouched by a non-emit revoke.
    const inst = await t.db.execute<{ ts_actual_end: string | null }>(sql`
      SELECT ts_actual_end FROM instance_attestation WHERE instance_id = ${instDevA}::uuid
    `)
    expect([...inst][0]!.ts_actual_end).toBeNull()
  })

  it('200 re-revoking an already-revoked own grant → revoked:false (idempotent no-op)', async () => {
    const out = await call<{ revoked: boolean }>(meRevoke, ev({ params: { id: grantFresh }, session: devA() }))
    expect(out.revoked).toBe(false)
  })

  it('revoking the EMIT grant sets revoked_at AND ends the teammate\'s live instance (F3.4)', async () => {
    const out = await call<{ revoked: boolean; is_emit: boolean; instances_ended: number }>(
      meRevoke,
      ev({ params: { id: grantEmit }, session: devA() }),
    )
    expect(out).toMatchObject({ revoked: true, is_emit: true })
    expect(out.instances_ended).toBeGreaterThanOrEqual(1)
    const inst = await t.db.execute<{ ts_actual_end: string | null }>(sql`
      SELECT ts_actual_end FROM instance_attestation WHERE instance_id = ${instDevA}::uuid
    `)
    expect([...inst][0]!.ts_actual_end).not.toBeNull()
  })

  it('R1 F2: an instance-bound emit revoke ends ONLY that device, not the teammate\'s other live instances', async () => {
    // Two devices, each with its own 1:1 emit grant (oauth_token.instance_id, 0031).
    const instX = await insertInstance(devAId)
    const instY = await insertInstance(devAId)
    const now = Date.now()
    const grantX = await insertGrant({ teammateId: devAId, scope: 'tokenscope.emit', refreshIssuedAt: new Date(now), instanceId: instX })
    await insertGrant({ teammateId: devAId, scope: 'tokenscope.emit', refreshIssuedAt: new Date(now), instanceId: instY })

    const out = await call<{ instances_ended: number }>(meRevoke, ev({ params: { id: grantX }, session: devA() }))
    // Exactly ONE device ended — instX. instY (laptop-B) keeps emitting.
    expect(out.instances_ended).toBe(1)
    const rows = await t.db.execute<{ instance_id: string; ts_actual_end: string | null }>(sql`
      SELECT instance_id::text, ts_actual_end FROM instance_attestation WHERE instance_id IN (${instX}::uuid, ${instY}::uuid)
    `)
    const byId = Object.fromEntries([...rows].map((r) => [r.instance_id, r.ts_actual_end]))
    expect(byId[instX]).not.toBeNull()
    expect(byId[instY]).toBeNull()
  })
})

describe('3. admin grants — region-scoping (F3.3)', () => {
  it('GET /admin/grants lists a same-region teammate\'s grants', async () => {
    const out = await call<{ teammate_id: string; grants: GrantOut[] }>(
      adminGrants,
      ev({ query: { teammate_id: devA2Id }, session: adminA() }),
    )
    expect(out.teammate_id).toBe(devA2Id)
    expect(out.grants.map((g) => g.id)).toContain(grantPeer)
    expect(out.grants[0]).toHaveProperty('teammate_email')
  })

  it('GET /admin/grants for a PEER-region teammate → 403', async () => {
    await expect(
      call(adminGrants, ev({ query: { teammate_id: devBId }, session: adminA() })),
    ).rejects.toMatchObject({ statusCode: 403 })
  })

  it('POST /admin/grants/{id}/revoke on a PEER-region grant → 403, grant stays live', async () => {
    await expect(
      call(adminRevoke, ev({ params: { id: grantRegionB }, session: adminA() })),
    ).rejects.toMatchObject({ statusCode: 403 })
    const rows = await t.db.execute<{ revoked_at: string | null }>(sql`
      SELECT revoked_at FROM oauth_token WHERE id = ${grantRegionB}::uuid
    `)
    expect([...rows][0]!.revoked_at).toBeNull()
  })

  it('platform-admin revokes a grant in ANY region (region B)', async () => {
    const out = await call<{ id: string; revoked: boolean }>(
      adminRevoke,
      ev({ params: { id: grantRegionB }, session: platform() }),
    )
    expect(out).toMatchObject({ id: grantRegionB, revoked: true })
    const rows = await t.db.execute<{ revoked_at: string | null }>(sql`
      SELECT revoked_at FROM oauth_token WHERE id = ${grantRegionB}::uuid
    `)
    expect([...rows][0]!.revoked_at).not.toBeNull()
  })

  it('admin revoke on a same-region grant (peer dev A2) succeeds', async () => {
    const out = await call<{ revoked: boolean }>(
      adminRevoke,
      ev({ params: { id: grantPeer }, session: adminA() }),
    )
    expect(out.revoked).toBe(true)
  })

  it('region admin revoking a same-region platform-admin\'s grant → 403, grant stays live; platform-admin may', async () => {
    const grantPlatform = await insertGrant({
      teammateId: '00000000-0000-4000-8000-0000000000f1',
      scope: 'tokenscope.read',
      refreshIssuedAt: new Date(),
    })
    await expect(
      call(adminRevoke, ev({ params: { id: grantPlatform }, session: adminA() })),
    ).rejects.toMatchObject({ statusCode: 403 })
    const rows = await t.db.execute<{ revoked_at: string | null }>(sql`
      SELECT revoked_at FROM oauth_token WHERE id = ${grantPlatform}::uuid
    `)
    expect([...rows][0]!.revoked_at).toBeNull()

    const out = await call<{ revoked: boolean }>(adminRevoke, ev({ params: { id: grantPlatform }, session: platform() }))
    expect(out.revoked).toBe(true)
  })

  it('404 revoking an unknown grant id', async () => {
    await expect(
      call(adminRevoke, ev({ params: { id: randomUUID() }, session: adminA() })),
    ).rejects.toMatchObject({ statusCode: 404 })
  })
})
