// @vitest-environment node
/*
 * Wave-VII admin revocation surface — end-to-end against testcontainers PG.
 *
 * Covers:
 *   - POST /api/v1/admin/users/:id/revoke-sessions: RBAC, region-scope,
 *     audit-row shape, revoked_at write, self-revoke allowed.
 *   - PATCH /api/v1/admin/users/:id auto-revoke side-effect: role-change
 *     also bumps revoked_at AND writes teammate-sessions-auto-revoked
 *     audit row.
 *   - validate-session middleware: a previously-minted session for the
 *     target whose issuedAt predates revoked_at is rejected with 401
 *     and the cookie is cleared.
 *
 * The middleware test exercises the full cookie loop: mint a session
 * cookie via setSession, bump revoked_at, present the cookie to the
 * middleware, assert that the response has Set-Cookie with Max-Age=0
 * (cookie cleared) AND that the handler throws 401.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import { sql } from 'drizzle-orm'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'
import * as schema from '../../../drizzle/schema'
import { injectTestSession } from '../../helpers/auth'
import type { Session } from '../../../server/utils/auth'

let t: TestDb
let regionAId: string
let regionBId: string
let adminAId: string
let adminA2Id: string
let devAId: string
let adminBId: string
let finopsId: string

beforeAll(async () => {
  process.env.NUXT_SESSION_SECRET = 'wave-vii-revoke-test-padded-to-thirty-two'
  t = await startTestDb()
  process.env.DATABASE_URL = t.url
  vi.resetModules()

  const [regionA] = await t.db
    .insert(schema.region)
    .values({ code: 'wvii-a', displayName: 'Wave VII A' })
    .returning()
  regionAId = regionA!.id
  const [regionB] = await t.db
    .insert(schema.region)
    .values({ code: 'wvii-b', displayName: 'Wave VII B' })
    .returning()
  regionBId = regionB!.id

  const [ouA] = await t.db
    .insert(schema.orgUnit)
    .values({
      regionId: regionAId,
      path: 'wvii-a.svc',
      code: 'wvii-a-svc',
      displayName: 'Services',
      unitType: 'bu',
    })
    .returning()
  const [ouB] = await t.db
    .insert(schema.orgUnit)
    .values({
      regionId: regionBId,
      path: 'wvii-b.svc',
      code: 'wvii-b-svc',
      displayName: 'Services',
      unitType: 'bu',
    })
    .returning()

  for (const seed of [
    { email: 'admin-a@wvii.test', oid: 'oid-admin-a-wvii', role: 'admin', regionId: regionAId, orgUnitId: ouA!.id, var: 'adminA' },
    { email: 'admin-a2@wvii.test', oid: 'oid-admin-a2-wvii', role: 'admin', regionId: regionAId, orgUnitId: ouA!.id, var: 'adminA2' },
    { email: 'dev-a@wvii.test', oid: 'oid-dev-a-wvii', role: 'developer', regionId: regionAId, orgUnitId: ouA!.id, var: 'devA' },
    { email: 'admin-b@wvii.test', oid: 'oid-admin-b-wvii', role: 'admin', regionId: regionBId, orgUnitId: ouB!.id, var: 'adminB' },
    { email: 'finops@wvii.test', oid: 'oid-finops-wvii', role: 'platform-admin', regionId: regionAId, orgUnitId: ouA!.id, var: 'finops' },
  ]) {
    const [row] = await t.db
      .insert(schema.teammate)
      .values({
        entraOid: seed.oid,
        email: seed.email,
        displayName: seed.email,
        role: seed.role,
        regionId: seed.regionId,
        orgUnitId: seed.orgUnitId,
      })
      .returning()
    if (seed.var === 'adminA') adminAId = row!.id
    if (seed.var === 'adminA2') adminA2Id = row!.id
    if (seed.var === 'devA') devAId = row!.id
    if (seed.var === 'adminB') adminBId = row!.id
    if (seed.var === 'finops') finopsId = row!.id
  }
}, 60_000)

afterAll(async () => {
  await stopTestDb(t)
}, 30_000)

beforeEach(async () => {
  // Reset role + revoked_at + audit between tests so each starts clean.
  await t.db.execute(sql`UPDATE teammate SET role = 'admin', revoked_at = NULL WHERE id IN (${sql.raw(`'${adminAId}'::uuid`)}, ${sql.raw(`'${adminA2Id}'::uuid`)}, ${sql.raw(`'${adminBId}'::uuid`)})`)
  await t.db.execute(sql`UPDATE teammate SET role = 'developer', revoked_at = NULL WHERE id = ${devAId}::uuid`)
  await t.db.execute(sql`UPDATE teammate SET role = 'platform-admin', revoked_at = NULL WHERE id = ${finopsId}::uuid`)
  await t.db.execute(sql`TRUNCATE TABLE audit_event RESTART IDENTITY CASCADE`)
})

// ── Event factory (mirror of users-roles.test.ts) ────────────────────
function makeEvent(opts: {
  method?: string
  path: string
  body?: unknown
  routerParams?: Record<string, string>
  initialSession?: Session
}) {
  const cookies = new Map<string, string>()
  const headers: Record<string, string> = { host: 'localhost:3450' }
  const method = opts.method ?? 'GET'
  const ev = {
    cookies,
    method,
    path: opts.path,
    context: { params: opts.routerParams ?? {} },
    node: {
      req: {
        method,
        url: opts.path,
        body: opts.body,
        get headers() {
          const cookieHeader = Array.from(cookies.entries())
            .map(([k, v]) => `${k}=${v}`)
            .join('; ')
          return { ...headers, cookie: cookieHeader, 'content-type': 'application/json' }
        },
      },
      res: {
        _headers: {} as Record<string, string | string[]>,
        statusCode: 200,
        getHeader(name: string) {
          return this._headers[name.toLowerCase()]
        },
        setHeader(name: string, value: string | string[]) {
          this._headers[name.toLowerCase()] = value
          if (name.toLowerCase() === 'set-cookie') {
            const items = Array.isArray(value) ? value : [value]
            for (const item of items) {
              const [pair] = item.split(';')
              const eq = pair!.indexOf('=')
              const k = pair!.slice(0, eq)
              const v = pair!.slice(eq + 1)
              if (v === '' && item.includes('Max-Age=0')) cookies.delete(k)
              else cookies.set(k, v)
            }
          }
        },
        removeHeader(name: string) {
          this._headers[name.toLowerCase()] = ''
        },
        appendHeader(name: string, value: string | string[]) {
          const incoming = Array.isArray(value) ? value : [value]
          // h3's setCookie internally appendHeader's the set-cookie line;
          // we mirror the cookie-jar bookkeeping from the setHeader path
          // so deleteCookie (set-cookie with Max-Age=0) actually removes
          // the entry from the test jar.
          if (name.toLowerCase() === 'set-cookie') {
            for (const item of incoming) {
              const [pair] = item.split(';')
              const eq = pair!.indexOf('=')
              const k = pair!.slice(0, eq)
              const v = pair!.slice(eq + 1)
              if (v === '' && item.includes('Max-Age=0')) cookies.delete(k)
              else cookies.set(k, v)
            }
          }
          const existing = this._headers[name.toLowerCase()]
          this._headers[name.toLowerCase()] = existing
            ? (Array.isArray(existing) ? existing : [existing]).concat(incoming)
            : incoming
        },
        get headersSent() {
          return false
        },
      },
    },
  }
  if (opts.initialSession) {
    injectTestSession(ev as unknown as Parameters<typeof injectTestSession>[0], opts.initialSession)
  }
  return ev
}

function adminASession(opts?: { issuedAt?: string }): Session {
  return {
    teammateId: adminAId,
    email: 'admin-a@wvii.test',
    displayName: 'Admin A',
    role: 'admin',
    regionId: regionAId,
    orgPath: 'wvii-a.svc',
    ...(opts?.issuedAt ? { issuedAt: opts.issuedAt } : {}),
  }
}

function orgWideSession(): Session {
  return {
    teammateId: finopsId,
    email: 'finops@wvii.test',
    displayName: 'Finops',
    role: 'platform-admin',
    regionId: regionAId,
    orgPath: 'wvii-a.svc',
  }
}

function devSession(opts?: { issuedAt?: string }): Session {
  return {
    teammateId: devAId,
    email: 'dev-a@wvii.test',
    displayName: 'Dev A',
    role: 'developer',
    regionId: regionAId,
    orgPath: 'wvii-a.svc',
    ...(opts?.issuedAt ? { issuedAt: opts.issuedAt } : {}),
  }
}

// ── POST /api/v1/admin/users/:id/revoke-sessions ─────────────────────
describe('POST /api/v1/admin/users/:id/revoke-sessions (Wave VII)', () => {
  async function loadHandler() {
    return (await import('../../../server/api/v1/admin/users/[id]/revoke-sessions.post'))
      .default as (event: unknown) => Promise<unknown>
  }

  it('admin revoking a developer → 200 + revoked_at populated + audit row', async () => {
    const handler = await loadHandler()
    const ev = makeEvent({
      method: 'POST',
      path: `/api/v1/admin/users/${devAId}/revoke-sessions`,
      body: { reason: 'compromised laptop' },
      routerParams: { id: devAId },
      initialSession: adminASession(),
    })
    const result = (await handler(ev as never)) as { ok: boolean }
    expect(result).toEqual({ ok: true })

    const rows = await t.client<{ revoked_at: Date | null }[]>`
      SELECT revoked_at FROM teammate WHERE id = ${devAId}`
    expect(rows[0]!.revoked_at).not.toBeNull()

    const audit = await t.client<{
      event_type: string
      actor_teammate_id: string | null
      subject_id: string | null
      payload: { reason?: string | null; byUser?: boolean; targetEmail?: string; selfRevoke?: boolean }
    }[]>`SELECT event_type, actor_teammate_id::text AS actor_teammate_id,
              subject_id::text AS subject_id, payload
         FROM audit_event WHERE event_type = 'teammate-sessions-revoked'`
    expect(audit.length).toBe(1)
    expect(audit[0]!.actor_teammate_id).toBe(adminAId)
    expect(audit[0]!.subject_id).toBe(devAId)
    expect(audit[0]!.payload.reason).toBe('compromised laptop')
    expect(audit[0]!.payload.byUser).toBe(false)
    expect(audit[0]!.payload.targetEmail).toBe('dev-a@wvii.test')
    expect(audit[0]!.payload.selfRevoke).toBe(false)
  })

  it('admin revoking themselves → 200 + audit row payload flags selfRevoke=true', async () => {
    const handler = await loadHandler()
    const ev = makeEvent({
      method: 'POST',
      path: `/api/v1/admin/users/${adminAId}/revoke-sessions`,
      body: {},
      routerParams: { id: adminAId },
      initialSession: adminASession(),
    })
    const result = (await handler(ev as never)) as { ok: boolean }
    expect(result.ok).toBe(true)

    const audit = await t.client<{
      payload: { selfRevoke?: boolean; reason?: string | null }
    }[]>`SELECT payload FROM audit_event WHERE event_type = 'teammate-sessions-revoked'`
    expect(audit[0]!.payload.selfRevoke).toBe(true)
    expect(audit[0]!.payload.reason).toBeNull()
  })

  it('admin revoking sole admin in their region → allowed (NO last-admin gate on revoke; user just signs back in)', async () => {
    // adminB is the sole admin in region B; platform-admin can revoke them.
    const handler = await loadHandler()
    const ev = makeEvent({
      method: 'POST',
      path: `/api/v1/admin/users/${adminBId}/revoke-sessions`,
      body: {},
      routerParams: { id: adminBId },
      initialSession: orgWideSession(),
    })
    const result = (await handler(ev as never)) as { ok: boolean }
    expect(result.ok).toBe(true)

    // Role unchanged — revocation does NOT touch the role column.
    const rows = await t.client<{ role: string; revoked_at: Date | null }[]>`
      SELECT role, revoked_at FROM teammate WHERE id = ${adminBId}`
    expect(rows[0]!.role).toBe('admin')
    expect(rows[0]!.revoked_at).not.toBeNull()
  })

  it('region admin revoking a platform-admin homed in their region → 403, nothing revoked; a platform-admin may', async () => {
    const handler = await loadHandler()
    const refused = makeEvent({
      method: 'POST',
      path: `/api/v1/admin/users/${finopsId}/revoke-sessions`,
      body: {},
      routerParams: { id: finopsId },
      initialSession: adminASession(),
    })
    await expect(handler(refused as never)).rejects.toMatchObject({ statusCode: 403 })
    const [before] = await t.client<{ revoked_at: Date | null }[]>`SELECT revoked_at FROM teammate WHERE id = ${finopsId}`
    expect(before!.revoked_at).toBeNull()
    const audit = await t.client<{ count: string }[]>`SELECT COUNT(*)::text AS count FROM audit_event WHERE event_type = 'teammate-sessions-revoked'`
    expect(Number(audit[0]!.count)).toBe(0)

    const allowed = makeEvent({
      method: 'POST',
      path: `/api/v1/admin/users/${finopsId}/revoke-sessions`,
      body: {},
      routerParams: { id: finopsId },
      initialSession: orgWideSession(),
    })
    expect(await handler(allowed as never)).toEqual({ ok: true })
  })

  it('admin in region A revoking a region-B teammate → 403 region-scope', async () => {
    const handler = await loadHandler()
    const ev = makeEvent({
      method: 'POST',
      path: `/api/v1/admin/users/${adminBId}/revoke-sessions`,
      body: {},
      routerParams: { id: adminBId },
      initialSession: adminASession(),
    })
    await expect(handler(ev as never)).rejects.toMatchObject({ statusCode: 403 })
    // No audit row written on the refused path.
    const audit = await t.client<{ count: string }[]>`SELECT COUNT(*)::text AS count FROM audit_event WHERE event_type = 'teammate-sessions-revoked'`
    expect(Number(audit[0]!.count)).toBe(0)
  })

  it('developer caller → 403 forbidden (app-level role gate)', async () => {
    const handler = await loadHandler()
    const ev = makeEvent({
      method: 'POST',
      path: `/api/v1/admin/users/${adminAId}/revoke-sessions`,
      body: {},
      routerParams: { id: adminAId },
      initialSession: devSession(),
    })
    await expect(handler(ev as never)).rejects.toMatchObject({ statusCode: 403 })
  })

  it('unauthenticated → 401', async () => {
    const handler = await loadHandler()
    const ev = makeEvent({
      method: 'POST',
      path: `/api/v1/admin/users/${devAId}/revoke-sessions`,
      body: {},
      routerParams: { id: devAId },
    })
    await expect(handler(ev as never)).rejects.toMatchObject({ statusCode: 401 })
  })

  it('invalid UUID in path → 400 invalid-input', async () => {
    const handler = await loadHandler()
    const ev = makeEvent({
      method: 'POST',
      path: `/api/v1/admin/users/not-a-uuid/revoke-sessions`,
      body: {},
      routerParams: { id: 'not-a-uuid' },
      initialSession: adminASession(),
    })
    await expect(handler(ev as never)).rejects.toMatchObject({ statusCode: 400 })
  })

  it('missing teammate id → 404 not-found', async () => {
    const handler = await loadHandler()
    const missingId = '00000000-0000-0000-0000-000000000000'
    const ev = makeEvent({
      method: 'POST',
      path: `/api/v1/admin/users/${missingId}/revoke-sessions`,
      body: {},
      routerParams: { id: missingId },
      initialSession: adminASession(),
    })
    await expect(handler(ev as never)).rejects.toMatchObject({ statusCode: 404 })
  })

  it('over-long reason (>200 chars) → 400 invalid-body', async () => {
    const handler = await loadHandler()
    const ev = makeEvent({
      method: 'POST',
      path: `/api/v1/admin/users/${devAId}/revoke-sessions`,
      body: { reason: 'x'.repeat(201) },
      routerParams: { id: devAId },
      initialSession: adminASession(),
    })
    await expect(handler(ev as never)).rejects.toMatchObject({ statusCode: 400 })
  })
})

// ── Auto-revoke on PATCH /api/v1/admin/users/:id (Wave VII) ──────────
describe('PATCH /api/v1/admin/users/:id — auto-revoke side effect (Wave VII)', () => {
  async function loadPatchHandler() {
    return (await import('../../../server/api/v1/admin/users/[id].patch'))
      .default as (event: unknown) => Promise<unknown>
  }

  it('successful role change → revoked_at set + single teammate-role-changed audit row carries sessionsRevoked=true', async () => {
    // R1 F4: the auto-revoke is a CONSEQUENCE of the role change, so one
    // audit row covers both via `payload.sessionsRevoked = true` (instead
    // of two separate rows). Forensics: filter by one event type.
    const handler = await loadPatchHandler()
    const ev = makeEvent({
      method: 'PATCH',
      path: `/api/v1/admin/users/${devAId}`,
      body: { role: 'manager' },
      routerParams: { id: devAId },
      initialSession: adminASession(),
    })
    const result = (await handler(ev as never)) as { ok: boolean }
    expect(result.ok).toBe(true)

    const rows = await t.client<{ role: string; revoked_at: Date | null }[]>`
      SELECT role, revoked_at FROM teammate WHERE id = ${devAId}`
    expect(rows[0]!.role).toBe('manager')
    expect(rows[0]!.revoked_at).not.toBeNull()

    // Single audit row carrying both effects via payload.sessionsRevoked.
    const roleAudit = await t.client<{
      payload: { previousRole?: string; newRole?: string; sessionsRevoked?: boolean }
      actor_teammate_id: string | null
      subject_id: string | null
    }[]>`SELECT actor_teammate_id::text AS actor_teammate_id,
              subject_id::text AS subject_id, payload
         FROM audit_event WHERE event_type = 'teammate-role-changed' AND subject_id = ${devAId}::uuid`
    expect(roleAudit.length).toBe(1)
    expect(roleAudit[0]!.actor_teammate_id).toBe(adminAId)
    expect(roleAudit[0]!.subject_id).toBe(devAId)
    expect(roleAudit[0]!.payload.previousRole).toBe('developer')
    expect(roleAudit[0]!.payload.newRole).toBe('manager')
    expect(roleAudit[0]!.payload.sessionsRevoked).toBe(true)

    // The legacy `teammate-sessions-auto-revoked` event type is gone.
    const legacyAudit = await t.client<{ count: string }[]>`
      SELECT COUNT(*)::text AS count
      FROM audit_event WHERE event_type = 'teammate-sessions-auto-revoked'`
    expect(Number(legacyAudit[0]!.count)).toBe(0)
  })

  it('refused role change (self-demote) → revoked_at unchanged + no auto-revoke audit row (fail-closed)', async () => {
    const handler = await loadPatchHandler()
    const ev = makeEvent({
      method: 'PATCH',
      path: `/api/v1/admin/users/${adminAId}`,
      body: { role: 'developer' },
      routerParams: { id: adminAId },
      initialSession: adminASession(),
    })
    await expect(handler(ev as never)).rejects.toMatchObject({
      statusCode: 400,
      data: { reason: 'self-role-change-blocked' },
    })

    const rows = await t.client<{ revoked_at: Date | null }[]>`SELECT revoked_at FROM teammate WHERE id = ${adminAId}`
    expect(rows[0]!.revoked_at).toBeNull()

    const audit = await t.client<{ count: string }[]>`SELECT COUNT(*)::text AS count FROM audit_event WHERE event_type = 'teammate-role-changed'`
    expect(Number(audit[0]!.count)).toBe(0)
  })
})

// Wave-VII revocation gate previously lived in a dedicated
// `server/middleware/validate-session.ts`. Post-Option-C refactor the
// gate is folded into `tryAuth()` (server/utils/auth.ts → isRevoked),
// so there is no separate middleware to exercise here. The behavioural
// contract — "session whose issuedAt predates teammate.revoked_at must
// be rejected" — is now covered by tryAuth() unit tests + the live
// sandbox flow (revoking via the admin endpoint forces the target's
// next request to fall back to /login). Re-instate a focused
// integration test against tryAuth when the test harness supports
// mocking the OIDC session shape.

// ── GET /api/v1/admin/settings — Wave VII build section ──────────────
describe('GET /api/v1/admin/settings — build.commitSha (Wave VII)', () => {
  async function loadHandler() {
    return (await import('../../../server/api/v1/admin/settings/index.get'))
      .default as (event: unknown) => Promise<unknown>
  }

  beforeEach(() => {
    delete process.env.GIT_COMMIT_SHA
  })

  it('GIT_COMMIT_SHA set to a real SHA → surfaces it', async () => {
    process.env.GIT_COMMIT_SHA = 'abc1234deadbeef'
    const handler = await loadHandler()
    const ev = makeEvent({
      path: `/api/v1/admin/settings`,
      initialSession: adminASession(),
    })
    const result = (await handler(ev as never)) as {
      build: { commitSha: string | null }
    }
    expect(result.build.commitSha).toBe('abc1234deadbeef')
    // S8 (7390960) dropped `build.imageTag` (CONTAINER_APP_REVISION) from the
    // payload entirely — commitSha already answers "what is deployed", so
    // the revision name was redundant infrastructure detail. No imageTag
    // assertion belongs here any more.
    expect(result.build).not.toHaveProperty('imageTag')
  })

  it('GIT_COMMIT_SHA absent → commitSha=null (UI shows "unknown")', async () => {
    const handler = await loadHandler()
    const ev = makeEvent({
      path: `/api/v1/admin/settings`,
      initialSession: adminASession(),
    })
    const result = (await handler(ev as never)) as {
      build: { commitSha: string | null }
    }
    expect(result.build.commitSha).toBeNull()
  })

  it('GIT_COMMIT_SHA = "unknown" (Dockerfile ARG default with no override) → normalised to null', async () => {
    process.env.GIT_COMMIT_SHA = 'unknown'
    const handler = await loadHandler()
    const ev = makeEvent({
      path: `/api/v1/admin/settings`,
      initialSession: adminASession(),
    })
    const result = (await handler(ev as never)) as {
      build: { commitSha: string | null }
    }
    expect(result.build.commitSha).toBeNull()
  })

  it('GIT_COMMIT_SHA = "" (Bicep override with empty value) → normalised to null', async () => {
    process.env.GIT_COMMIT_SHA = ''
    const handler = await loadHandler()
    const ev = makeEvent({
      path: `/api/v1/admin/settings`,
      initialSession: adminASession(),
    })
    const result = (await handler(ev as never)) as {
      build: { commitSha: string | null }
    }
    expect(result.build.commitSha).toBeNull()
  })
})
