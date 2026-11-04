// @vitest-environment node
/*
 * Wave-VI admin endpoints — users list + role-change PATCH.
 *
 * Pattern follows tests/integration/auth/persona-override.test.ts:
 * direct handler invocation against a mocked h3 event, real DB via
 * testcontainers. We assert RBAC (200/403/404), the role-change verdict
 * matrix, the audit-row shape, and the fail-closed property when the
 * verdict refuses (no UPDATE applied).
 *
 * The tests intentionally use unique region UUIDs per case where
 * relevant so admin-count snapshots stay deterministic across the
 * suite.
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
  process.env.NUXT_SESSION_SECRET = 'wave-vi-admin-test-padded-to-thirty-two-chars'
  t = await startTestDb()
  process.env.DATABASE_URL = t.url
  vi.resetModules()

  // Two regions, with admins in each + a developer in region A + a
  // platform-admin (no region home — sits in region A for convenience).
  const [regionA] = await t.db
    .insert(schema.region)
    .values({ code: 'wvi-a', displayName: 'Wave VI A' })
    .returning()
  regionAId = regionA!.id
  const [regionB] = await t.db
    .insert(schema.region)
    .values({ code: 'wvi-b', displayName: 'Wave VI B' })
    .returning()
  regionBId = regionB!.id

  const [ouA] = await t.db
    .insert(schema.orgUnit)
    .values({
      regionId: regionAId,
      path: 'wvi-a.svc',
      code: 'wvi-a-svc',
      displayName: 'Services',
      unitType: 'bu',
    })
    .returning()
  const [ouB] = await t.db
    .insert(schema.orgUnit)
    .values({
      regionId: regionBId,
      path: 'wvi-b.svc',
      code: 'wvi-b-svc',
      displayName: 'Services',
      unitType: 'bu',
    })
    .returning()

  for (const seed of [
    { email: 'admin-a@wvi.test', oid: 'oid-admin-a-wvi', role: 'admin', regionId: regionAId, orgUnitId: ouA!.id, var: 'adminA' },
    { email: 'admin-a2@wvi.test', oid: 'oid-admin-a2-wvi', role: 'admin', regionId: regionAId, orgUnitId: ouA!.id, var: 'adminA2' },
    { email: 'dev-a@wvi.test', oid: 'oid-dev-a-wvi', role: 'developer', regionId: regionAId, orgUnitId: ouA!.id, var: 'devA' },
    { email: 'admin-b@wvi.test', oid: 'oid-admin-b-wvi', role: 'admin', regionId: regionBId, orgUnitId: ouB!.id, var: 'adminB' },
    { email: 'finops@wvi.test', oid: 'oid-finops-wvi', role: 'platform-admin', regionId: regionAId, orgUnitId: ouA!.id, var: 'finops' },
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

// ── Event factory ─────────────────────────────────────────────────
// Compact shape lifted from tests/integration/auth/persona-override.test.ts
// but generalised: path + method + body + routerParams are all parameters
// so the same factory drives both the list GET and the per-id PATCH.
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
    // h3's getRouterParam reads event.context.params.
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

function adminASession(): Session {
  return {
    teammateId: adminAId,
    email: 'admin-a@wvi.test',
    displayName: 'Admin A',
    role: 'admin',
    regionId: regionAId,
    orgPath: 'wvi-a.svc',
  }
}

function orgWideSession(): Session {
  return {
    teammateId: finopsId,
    email: 'finops@wvi.test',
    displayName: 'Finops',
    role: 'platform-admin',
    regionId: regionAId,
    orgPath: 'wvi-a.svc',
  }
}

function devSession(): Session {
  return {
    teammateId: devAId,
    email: 'dev-a@wvi.test',
    displayName: 'Dev A',
    role: 'developer',
    regionId: regionAId,
    orgPath: 'wvi-a.svc',
  }
}

// ── GET /api/v1/admin/users ────────────────────────────────────────
describe('GET /api/v1/admin/users', () => {
  async function loadHandler() {
    return (await import('../../../server/api/v1/admin/users/index.get'))
      .default as (event: unknown) => Promise<unknown>
  }

  it('admin in region A → returns A teammates only (region-scoped)', async () => {
    const handler = await loadHandler()
    const ev = makeEvent({
      path: `/api/v1/admin/users?region=${regionAId}&limit=50`,
      initialSession: adminASession(),
    })
    const result = (await handler(ev as never)) as {
      users: { email: string }[]
      total: number
      adminCount: number
    }
    const emails = result.users.map((u) => u.email).sort()
    expect(emails).toEqual([
      'admin-a2@wvi.test',
      'admin-a@wvi.test',
      'dev-a@wvi.test',
      'finops@wvi.test',
    ])
    expect(result.total).toBe(4)
    expect(result.adminCount).toBe(2)
  })

  it('admin in region A trying to read region B → 403 region-scope', async () => {
    const handler = await loadHandler()
    const ev = makeEvent({
      path: `/api/v1/admin/users?region=${regionBId}&limit=50`,
      initialSession: adminASession(),
    })
    await expect(handler(ev as never)).rejects.toMatchObject({ statusCode: 403 })
  })

  it('platform-admin reading region B → 200 (cross-region allowed)', async () => {
    const handler = await loadHandler()
    const ev = makeEvent({
      path: `/api/v1/admin/users?region=${regionBId}&limit=50`,
      initialSession: orgWideSession(),
    })
    const result = (await handler(ev as never)) as { users: unknown[]; total: number }
    expect(result.total).toBe(1)
    expect(result.users.length).toBe(1)
  })

  it('developer caller → 403 forbidden (app-level role gate)', async () => {
    const handler = await loadHandler()
    const ev = makeEvent({
      path: `/api/v1/admin/users?region=${regionAId}&limit=50`,
      initialSession: devSession(),
    })
    await expect(handler(ev as never)).rejects.toMatchObject({ statusCode: 403 })
  })

  it('unauthenticated caller → 401', async () => {
    const handler = await loadHandler()
    const ev = makeEvent({ path: `/api/v1/admin/users?region=${regionAId}&limit=50` })
    await expect(handler(ev as never)).rejects.toMatchObject({ statusCode: 401 })
  })

  it('role filter → only matching rows', async () => {
    const handler = await loadHandler()
    const ev = makeEvent({
      path: `/api/v1/admin/users?region=${regionAId}&role=admin&limit=50`,
      initialSession: adminASession(),
    })
    const result = (await handler(ev as never)) as { users: { role: string }[] }
    expect(result.users.length).toBe(2)
    expect(result.users.every((u) => u.role === 'admin')).toBe(true)
  })

  it('search filter q → ILIKE match', async () => {
    const handler = await loadHandler()
    const ev = makeEvent({
      path: `/api/v1/admin/users?region=${regionAId}&q=dev-a&limit=50`,
      initialSession: adminASession(),
    })
    const result = (await handler(ev as never)) as { users: { email: string }[] }
    expect(result.users.map((u) => u.email)).toEqual(['dev-a@wvi.test'])
  })
})

// ── PATCH /api/v1/admin/users/:id ─────────────────────────────────
describe('PATCH /api/v1/admin/users/:id — role change', () => {
  async function loadHandler() {
    return (await import('../../../server/api/v1/admin/users/[id].patch'))
      .default as (event: unknown) => Promise<unknown>
  }

  beforeEach(async () => {
    // Reset roles so each test starts from the same matrix.
    await t.db.execute(sql`UPDATE teammate SET role = 'admin' WHERE id IN (${sql.raw(`'${adminAId}'::uuid`)}, ${sql.raw(`'${adminA2Id}'::uuid`)}, ${sql.raw(`'${adminBId}'::uuid`)})`)
    await t.db.execute(sql`UPDATE teammate SET role = 'developer' WHERE id = ${devAId}::uuid`)
    await t.db.execute(sql`UPDATE teammate SET role = 'platform-admin' WHERE id = ${finopsId}::uuid`)
    await t.db.execute(sql`TRUNCATE TABLE audit_event RESTART IDENTITY CASCADE`)
  })

  it('admin promoting a developer → manager — UPDATE applied + audit row written', async () => {
    const handler = await loadHandler()
    const ev = makeEvent({
      method: 'PATCH',
      path: `/api/v1/admin/users/${devAId}`,
      body: { role: 'manager' },
      routerParams: { id: devAId },
      initialSession: adminASession(),
    })
    const result = (await handler(ev as never)) as { ok: boolean; previousRole: string; newRole: string }
    expect(result).toMatchObject({ ok: true, previousRole: 'developer', newRole: 'manager' })

    const rows = await t.client<{ role: string }[]>`SELECT role FROM teammate WHERE id = ${devAId}`
    expect(rows[0]!.role).toBe('manager')

    const audit = await t.client<{
      event_type: string
      actor_teammate_id: string | null
      subject_id: string | null
      payload: { previousRole?: string; newRole?: string; targetEmail?: string }
    }[]>`SELECT event_type, actor_teammate_id::text AS actor_teammate_id,
                subject_id::text AS subject_id, payload
         FROM audit_event WHERE event_type = 'teammate-role-changed'`
    expect(audit.length).toBe(1)
    expect(audit[0]!.actor_teammate_id).toBe(adminAId)
    expect(audit[0]!.subject_id).toBe(devAId)
    expect(audit[0]!.payload.previousRole).toBe('developer')
    expect(audit[0]!.payload.newRole).toBe('manager')
    expect(audit[0]!.payload.targetEmail).toBe('dev-a@wvi.test')
  })

  /*
   * RETIRED ROLES, AT THE ROUTE. `canModifyHolderOf` / `canAssignRole` are proven
   * as functions elsewhere, but rule 10 applies: only a route test sees the RBAC
   * gate, the 403 translation, the row and the audit together. A retired role is
   * `text` in the column and absent from `SELECTABLE_ROLES`, so nothing the
   * compiler checks would catch a regression here.
   */
  it('region admin modifying a RETIRED-role holder → 403 + role unchanged + no audit', async () => {
    await t.db.execute(sql`UPDATE teammate SET role = 'global-finops' WHERE id = ${devAId}::uuid`)
    const handler = await loadHandler()
    const ev = makeEvent({
      method: 'PATCH',
      path: `/api/v1/admin/users/${devAId}`,
      body: { role: 'developer' },
      routerParams: { id: devAId },
      initialSession: adminASession(),
    })
    // The 403 must name the ACTUAL denial. This branch also fires for org-wide
    // GRANTS, and a message mentioning only platform-admin tells a region admin
    // the wrong reason when the target holds a retired role.
    await expect(handler(ev as never)).rejects.toMatchObject({
      statusCode: 403,
      // Named by its label since #489 (roles shown by label, not raw code).
      data: { detail: expect.stringContaining('Global finance (retired)') },
    })

    const rows = await t.client<{ role: string }[]>`SELECT role FROM teammate WHERE id = ${devAId}`
    expect(rows[0]!.role, 'a region admin changed a retired-role holder').toBe('global-finops')
    const audit = await t.client<{ n: string }[]>`SELECT count(*)::text AS n FROM audit_event WHERE event_type = 'teammate-role-changed'`
    expect(audit[0]!.n).toBe('0')
  })

  it('platform-admin demoting a RETIRED-role holder → 200 + row moves + audit written', async () => {
    // The other direction: retirement must not STRAND its holders. Somebody has
    // to be able to move them off, or the role is unassignable AND permanent.
    await t.db.execute(sql`UPDATE teammate SET role = 'global-finops' WHERE id = ${devAId}::uuid`)
    const handler = await loadHandler()
    const ev = makeEvent({
      method: 'PATCH',
      path: `/api/v1/admin/users/${devAId}`,
      body: { role: 'developer' },
      routerParams: { id: devAId },
      initialSession: orgWideSession(),
    })
    const result = (await handler(ev as never)) as { ok: boolean; previousRole: string; newRole: string }
    expect(result).toMatchObject({ ok: true, previousRole: 'global-finops', newRole: 'developer' })

    const rows = await t.client<{ role: string }[]>`SELECT role FROM teammate WHERE id = ${devAId}`
    expect(rows[0]!.role).toBe('developer')
    const audit = await t.client<{ payload: { previousRole?: string } }[]>`SELECT payload FROM audit_event WHERE event_type = 'teammate-role-changed'`
    expect(audit.length).toBe(1)
    expect(audit[0]!.payload.previousRole).toBe('global-finops')
  })

  it('ASSIGNING a retired role is refused even for platform-admin', async () => {
    // Retirement is one-way. The role stays in the enum only so historical rows
    // render a label; nothing may move a teammate back onto it.
    //
    // 403, not 400: the value is still a member of ROLES, so it passes schema
    // validation and is refused by canAssignRole. Retirement is an AUTHORIZATION
    // rule here, not a vocabulary one — which is why dropping it from
    // SELECTABLE_ROLES (a UI concern) could never have been the whole fix.
    const handler = await loadHandler()
    const ev = makeEvent({
      method: 'PATCH',
      path: `/api/v1/admin/users/${devAId}`,
      body: { role: 'global-finops' },
      routerParams: { id: devAId },
      initialSession: orgWideSession(),
    })
    await expect(handler(ev as never)).rejects.toMatchObject({ statusCode: 403 })

    const rows = await t.client<{ role: string }[]>`SELECT role FROM teammate WHERE id = ${devAId}`
    expect(rows[0]!.role, 'a retired role was re-assigned').toBe('developer')
  })

  it('GRANTING Region admin is refused even for platform-admin (one admin role)', async () => {
    const handler = await loadHandler()
    const ev = makeEvent({
      method: 'PATCH',
      path: `/api/v1/admin/users/${devAId}`,
      body: { role: 'admin' },
      routerParams: { id: devAId },
      initialSession: orgWideSession(),
    })
    await expect(handler(ev as never)).rejects.toMatchObject({
      statusCode: 403,
      data: { type: 'https://tokenscope.example.com/errors/role-grant', detail: 'Region admin (retired) can no longer be granted.' },
    })
    const rows = await t.client<{ role: string }[]>`SELECT role FROM teammate WHERE id = ${devAId}`
    expect(rows[0]!.role).toBe('developer')
  })

  it('admin self-demote → 400 self-role-change-blocked + role unchanged + no audit row', async () => {
    const handler = await loadHandler()
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
    const rows = await t.client<{ role: string }[]>`SELECT role FROM teammate WHERE id = ${adminAId}`
    expect(rows[0]!.role).toBe('admin')
    const audit = await t.client<{ count: string }[]>`SELECT COUNT(*)::text AS count FROM audit_event WHERE event_type = 'teammate-role-changed'`
    expect(Number(audit[0]!.count)).toBe(0)
  })

  it('demoting the last Region admin in region B → allowed (the role can no longer be granted, so its holders must be demotable)', async () => {
    // Region B has only adminB. Before Region admin was retired this was 409
    // last-admin-protected, with "promote a second admin first" as the way out;
    // that way out is gone (canAssignRole refuses `admin`), so the guard went too.
    const handler = await loadHandler()
    const ev = makeEvent({
      method: 'PATCH',
      path: `/api/v1/admin/users/${adminBId}`,
      body: { role: 'developer' },
      routerParams: { id: adminBId },
      initialSession: orgWideSession(),
    })
    const result = (await handler(ev as never)) as { ok: boolean; previousRole: string; newRole: string }
    expect(result).toEqual({ ok: true, previousRole: 'admin', newRole: 'developer' })
    const rows = await t.client<{ role: string }[]>`SELECT role FROM teammate WHERE id = ${adminBId}`
    expect(rows[0]!.role).toBe('developer')
  })

  it('demoting admin A while admin A2 is also admin → allowed (count > 1)', async () => {
    const handler = await loadHandler()
    // Use finops as caller so the self-demote gate isn't triggered.
    const ev = makeEvent({
      method: 'PATCH',
      path: `/api/v1/admin/users/${adminAId}`,
      body: { role: 'manager' },
      routerParams: { id: adminAId },
      initialSession: orgWideSession(),
    })
    const result = (await handler(ev as never)) as { ok: boolean }
    expect(result.ok).toBe(true)
    const rows = await t.client<{ role: string }[]>`SELECT role FROM teammate WHERE id = ${adminAId}`
    expect(rows[0]!.role).toBe('manager')
  })

  it('same-role no-op → 400 same-role-noop + no audit row', async () => {
    const handler = await loadHandler()
    const ev = makeEvent({
      method: 'PATCH',
      path: `/api/v1/admin/users/${devAId}`,
      body: { role: 'developer' },
      routerParams: { id: devAId },
      initialSession: adminASession(),
    })
    await expect(handler(ev as never)).rejects.toMatchObject({
      statusCode: 400,
      data: { reason: 'same-role-noop' },
    })
    const audit = await t.client<{ count: string }[]>`SELECT COUNT(*)::text AS count FROM audit_event WHERE event_type = 'teammate-role-changed'`
    expect(Number(audit[0]!.count)).toBe(0)
  })

  it('admin in region A mutating a region B teammate → 403 region-scope', async () => {
    const handler = await loadHandler()
    const ev = makeEvent({
      method: 'PATCH',
      path: `/api/v1/admin/users/${adminBId}`,
      body: { role: 'developer' },
      routerParams: { id: adminBId },
      initialSession: adminASession(),
    })
    await expect(handler(ev as never)).rejects.toMatchObject({ statusCode: 403 })
  })

  it('developer caller → 403 forbidden (app-level role gate)', async () => {
    const handler = await loadHandler()
    const ev = makeEvent({
      method: 'PATCH',
      path: `/api/v1/admin/users/${adminAId}`,
      body: { role: 'developer' },
      routerParams: { id: adminAId },
      initialSession: devSession(),
    })
    await expect(handler(ev as never)).rejects.toMatchObject({ statusCode: 403 })
  })

  it('invalid teammate id (not a UUID) → 400 invalid-input', async () => {
    const handler = await loadHandler()
    const ev = makeEvent({
      method: 'PATCH',
      path: `/api/v1/admin/users/not-a-uuid`,
      body: { role: 'developer' },
      routerParams: { id: 'not-a-uuid' },
      initialSession: adminASession(),
    })
    await expect(handler(ev as never)).rejects.toMatchObject({ statusCode: 400 })
  })

  it('teammate id not present → 404 not-found', async () => {
    const handler = await loadHandler()
    const missingId = '00000000-0000-0000-0000-000000000000'
    const ev = makeEvent({
      method: 'PATCH',
      path: `/api/v1/admin/users/${missingId}`,
      body: { role: 'developer' },
      routerParams: { id: missingId },
      initialSession: adminASession(),
    })
    await expect(handler(ev as never)).rejects.toMatchObject({ statusCode: 404 })
  })

  it('invalid role in body → 400 zod-validation', async () => {
    const handler = await loadHandler()
    const ev = makeEvent({
      method: 'PATCH',
      path: `/api/v1/admin/users/${devAId}`,
      body: { role: 'super-admin' },
      routerParams: { id: devAId },
      initialSession: adminASession(),
    })
    await expect(handler(ev as never)).rejects.toBeDefined()
  })

  // ── Privilege-escalation guard (adversarial R1 HIGH) ──────────────
  it('region admin promoting a developer → platform-admin → 403 role-grant + role unchanged', async () => {
    const handler = await loadHandler()
    const ev = makeEvent({
      method: 'PATCH',
      path: `/api/v1/admin/users/${devAId}`,
      body: { role: 'platform-admin' },
      routerParams: { id: devAId },
      initialSession: adminASession(),
    })
    await expect(handler(ev as never)).rejects.toMatchObject({ statusCode: 403 })
    const rows = await t.client<{ role: string }[]>`SELECT role FROM teammate WHERE id = ${devAId}`
    expect(rows[0]!.role).toBe('developer') // unchanged
  })

  it('region admin cannot modify a teammate who already holds an org-wide role → 403', async () => {
    // finops sits in region A for convenience, so region-scope passes; the
    // block must come from canAssignRole on the TARGET's org-wide role.
    const handler = await loadHandler()
    const ev = makeEvent({
      method: 'PATCH',
      path: `/api/v1/admin/users/${finopsId}`,
      body: { role: 'developer' },
      routerParams: { id: finopsId },
      initialSession: adminASession(),
    })
    await expect(handler(ev as never)).rejects.toMatchObject({ statusCode: 403 })
    const rows = await t.client<{ role: string }[]>`SELECT role FROM teammate WHERE id = ${finopsId}`
    expect(rows[0]!.role).toBe('platform-admin') // unchanged
  })

  it('platform-admin (org-wide) CAN promote a developer → platform-admin', async () => {
    const handler = await loadHandler()
    const ev = makeEvent({
      method: 'PATCH',
      path: `/api/v1/admin/users/${devAId}`,
      body: { role: 'platform-admin' },
      routerParams: { id: devAId },
      initialSession: orgWideSession(),
    })
    const result = (await handler(ev as never)) as { ok: boolean; newRole: string }
    expect(result).toMatchObject({ ok: true, newRole: 'platform-admin' })
  })
})

// ── GET /api/v1/admin/audit ────────────────────────────────────────
describe('GET /api/v1/admin/audit', () => {
  async function loadHandler() {
    return (await import('../../../server/api/v1/admin/audit/index.get'))
      .default as (event: unknown) => Promise<unknown>
  }
  async function loadPatchHandler() {
    return (await import('../../../server/api/v1/admin/users/[id].patch'))
      .default as (event: unknown) => Promise<unknown>
  }

  beforeEach(async () => {
    await t.db.execute(sql`UPDATE teammate SET role = 'admin' WHERE id IN (${sql.raw(`'${adminAId}'::uuid`)}, ${sql.raw(`'${adminA2Id}'::uuid`)}, ${sql.raw(`'${adminBId}'::uuid`)})`)
    await t.db.execute(sql`UPDATE teammate SET role = 'developer' WHERE id = ${devAId}::uuid`)
    await t.db.execute(sql`TRUNCATE TABLE audit_event RESTART IDENTITY CASCADE`)
  })

  it('returns impersonatorOid: the admin behind a persona-override row, null otherwise', async () => {
    const REAL_ADMIN_OID = '9a1e0000-0000-4000-8000-0000000000aa'
    await t.db.execute(sql`
      INSERT INTO audit_event (event_type, actor_teammate_id, actor_system, subject_kind, subject_id, payload, impersonator_oid)
      VALUES ('teammate-role-changed', ${devAId}::uuid, 'admin-ui', 'teammate', ${devAId}::uuid, '{}'::jsonb, ${REAL_ADMIN_OID}),
             ('teammate-role-changed', ${devAId}::uuid, 'admin-ui', 'teammate', ${devAId}::uuid, '{}'::jsonb, NULL)
    `)
    const handler = await loadHandler()
    const res = (await handler(makeEvent({ path: '/api/v1/admin/audit?limit=200', initialSession: orgWideSession() }) as never)) as {
      events: { impersonatorOid: string | null }[]
    }
    expect(res.events.map((e) => e.impersonatorOid).sort()).toEqual([REAL_ADMIN_OID, null].sort())
  })

  it('admin sees their region`s audit footprint; platform-admin sees all', async () => {
    // Generate two role-change events: one in region A (admin A2 demoting dev A)
    // and one in region B (finops demoting admin B → manager — region B has
    // only one admin so that would fail; promote dev → admin won't work either
    // since there's no dev in B. We seed an audit row directly to keep the
    // test focused on the region-scope filter, not on the mutation chain.)
    const patch = await loadPatchHandler()
    const ev = makeEvent({
      method: 'PATCH',
      path: `/api/v1/admin/users/${devAId}`,
      body: { role: 'manager' },
      routerParams: { id: devAId },
      initialSession: orgWideSession(),
    })
    await patch(ev as never)

    // Manually insert a region-B audit row (actor in region B).
    await t.db.execute(sql`
      INSERT INTO audit_event (event_type, actor_teammate_id, actor_system, subject_kind, subject_id, payload)
      VALUES ('teammate-role-changed', ${adminBId}::uuid, 'admin-ui', 'teammate', ${adminBId}::uuid, '{"previousRole":"admin","newRole":"admin"}'::jsonb)
    `)

    const handler = await loadHandler()

    // Admin A sees only region-A actor/subject events.
    const evA = makeEvent({
      path: `/api/v1/admin/audit?limit=200`,
      initialSession: adminASession(),
    })
    const resultA = (await handler(evA as never)) as { events: { actorEmail: string | null; subjectId: string | null }[] }
    const aSubjects = resultA.events.map((e) => e.subjectId)
    expect(aSubjects).toContain(devAId) // region-A subject visible
    expect(aSubjects).not.toContain(adminBId) // region-B subject filtered out

    // platform-admin sees both.
    const evF = makeEvent({
      path: `/api/v1/admin/audit?limit=200`,
      initialSession: orgWideSession(),
    })
    const resultF = (await handler(evF as never)) as { events: { subjectId: string | null }[] }
    const fSubjects = resultF.events.map((e) => e.subjectId)
    expect(fSubjects).toContain(devAId)
    expect(fSubjects).toContain(adminBId)
  })

  it('developer caller → 403 forbidden', async () => {
    const handler = await loadHandler()
    const ev = makeEvent({
      path: `/api/v1/admin/audit?limit=50`,
      initialSession: devSession(),
    })
    await expect(handler(ev as never)).rejects.toMatchObject({ statusCode: 403 })
  })

  it('eventType filter narrows', async () => {
    // Seed two distinct event types.
    await t.db.execute(sql`
      INSERT INTO audit_event (event_type, actor_teammate_id, actor_system, subject_kind, subject_id, payload)
      VALUES
        ('alpha', ${adminAId}::uuid, 'test', 'teammate', ${adminAId}::uuid, '{}'::jsonb),
        ('beta', ${adminAId}::uuid, 'test', 'teammate', ${adminAId}::uuid, '{}'::jsonb)
    `)
    const handler = await loadHandler()
    const ev = makeEvent({
      path: `/api/v1/admin/audit?eventType=alpha&limit=50`,
      initialSession: orgWideSession(),
    })
    const result = (await handler(ev as never)) as { events: { eventType: string }[]; total: number }
    expect(result.events.every((e) => e.eventType === 'alpha')).toBe(true)
    expect(result.total).toBe(1)
  })
  it('actorSystem filter selects system-actor events only, never a teammate event from the same system', async () => {
    await t.db.execute(sql`
      INSERT INTO audit_event (event_type, actor_teammate_id, actor_system, subject_kind, subject_id, payload)
      VALUES
        ('gamma', NULL, 'worker-x', NULL, NULL, '{}'::jsonb),
        ('gamma', ${adminAId}::uuid, 'worker-x', 'teammate', ${adminAId}::uuid, '{}'::jsonb),
        ('gamma', NULL, 'worker-y', NULL, NULL, '{}'::jsonb)
    `)
    const handler = await loadHandler()
    const ev = makeEvent({
      path: `/api/v1/admin/audit?actorSystem=worker-x&limit=50`,
      initialSession: orgWideSession(),
    })
    const result = (await handler(ev as never)) as {
      events: { actorSystem: string | null; actorTeammateId: string | null }[]
      total: number
    }
    expect(result.total).toBe(1)
    expect(result.events).toEqual([expect.objectContaining({ actorSystem: 'worker-x', actorTeammateId: null })])
  })

  it('actorTeammateId filter narrows to that teammate', async () => {
    await t.db.execute(sql`
      INSERT INTO audit_event (event_type, actor_teammate_id, actor_system, subject_kind, subject_id, payload)
      VALUES
        ('delta', ${adminAId}::uuid, 'admin-ui', 'teammate', ${devAId}::uuid, '{}'::jsonb),
        ('delta', ${adminA2Id}::uuid, 'admin-ui', 'teammate', ${devAId}::uuid, '{}'::jsonb)
    `)
    const handler = await loadHandler()
    const ev = makeEvent({
      path: `/api/v1/admin/audit?actorTeammateId=${adminA2Id}&limit=50`,
      initialSession: orgWideSession(),
    })
    const result = (await handler(ev as never)) as { events: { actorTeammateId: string | null }[]; total: number }
    expect(result.total).toBe(1)
    expect(result.events[0]!.actorTeammateId).toBe(adminA2Id)
  })

  // Nested so the enclosing beforeEach (roles reset, audit_event emptied) runs first.
  describe('GET /api/v1/admin/audit/facets', () => {
    async function loadFacets() {
      return (await import('../../../server/api/v1/admin/audit/facets.get'))
        .default as (event: unknown) => Promise<unknown>
    }
    interface Facets {
      eventTypes: string[]
      actors: { teammateId: string; email: string | null }[]
      systems: string[]
      truncated: boolean
    }

    beforeEach(async () => {
      // Region A: a teammate actor; region B: another; plus a system actor on
      // each side, visible to a region admin only through a teammate subject.
      await t.db.execute(sql`
        INSERT INTO audit_event (event_type, actor_teammate_id, actor_system, subject_kind, subject_id, payload)
        VALUES
          ('region-a-only', ${adminAId}::uuid, 'admin-ui', 'teammate', ${devAId}::uuid, '{}'::jsonb),
          ('region-b-only', ${adminBId}::uuid, 'admin-ui', 'teammate', ${adminBId}::uuid, '{}'::jsonb),
          ('sys-on-a', NULL, 'nightly-sync', 'teammate', ${devAId}::uuid, '{}'::jsonb),
          ('sys-on-b', NULL, 'b-only-sync', 'teammate', ${adminBId}::uuid, '{}'::jsonb)
      `)
    })

    it('platform-admin is offered every event type, teammate actor and system actor', async () => {
      const res = (await (await loadFacets())(makeEvent({ path: '/api/v1/admin/audit/facets', initialSession: orgWideSession() }) as never)) as Facets
      expect(res.eventTypes).toEqual(['region-a-only', 'region-b-only', 'sys-on-a', 'sys-on-b'])
      expect(res.actors.map((a) => a.teammateId).sort()).toEqual([adminAId, adminBId].sort())
      expect(res.actors.find((a) => a.teammateId === adminAId)?.email).toBe('admin-a@wvi.test')
      expect(res.systems).toEqual(['b-only-sync', 'nightly-sync'])
      expect(res.truncated).toBe(false)
    })

    it('a region admin is offered only options drawn from events they can read', async () => {
      const res = (await (await loadFacets())(makeEvent({ path: '/api/v1/admin/audit/facets', initialSession: adminASession() }) as never)) as Facets
      expect(res.eventTypes).toEqual(['region-a-only', 'sys-on-a'])
      expect(res.actors.map((a) => a.teammateId)).toEqual([adminAId])
      expect(res.systems).toEqual(['nightly-sync'])
    })

    it('developer caller → 403 forbidden', async () => {
      await expect(
        (await loadFacets())(makeEvent({ path: '/api/v1/admin/audit/facets', initialSession: devSession() }) as never),
      ).rejects.toMatchObject({ statusCode: 403 })
    })
  })
})

// ── GET /api/v1/admin/settings ────────────────────────────────────
describe('GET /api/v1/admin/settings', () => {
  async function loadHandler() {
    return (await import('../../../server/api/v1/admin/settings/index.get'))
      .default as (event: unknown) => Promise<unknown>
  }

  beforeEach(() => {
    delete process.env.NUXT_OIDC_AUTH_DEV_MODE
    delete process.env.NUXT_ALLOW_PERSONA_OVERRIDE
    delete process.env.NUXT_BOOTSTRAP_ADMIN_EMAIL
  })

  it('admin → returns sectioned read-only config; NEVER includes secret material', async () => {
    process.env.NUXT_OIDC_AUTH_DEV_MODE = 'true'
    process.env.NUXT_BOOTSTRAP_ADMIN_EMAIL = 'bootstrap@wvi.test'
    // R1 F1: provider key is `entra`, not `microsoft`. Match the env
    // var names set by infra/modules/container-app.bicep.
    process.env.NUXT_OIDC_PROVIDERS_ENTRA_TENANT_ID = 'tenant-abc'
    process.env.NUXT_OIDC_PROVIDERS_ENTRA_CLIENT_ID = 'client-abc'
    const handler = await loadHandler()
    const ev = makeEvent({
      path: `/api/v1/admin/settings`,
      initialSession: adminASession(),
    })
    const result = (await handler(ev as never)) as {
      auth: { devMode: boolean; allowPersonaOverride: boolean; bootstrapAdminConfigured: boolean }
      entra: { tenantId: string; clientId: string }
      features: Record<string, boolean>
      region: { id: string } | null
    }
    expect(result.auth.devMode).toBe(true)
    // S8: the boolean, not the address. The operational question is whether a
    // bootstrap admin is configured; the address itself is an account
    // identifier this tier has no reason to read.
    expect(result.auth.bootstrapAdminConfigured).toBe(true)
    expect(result.entra.tenantId).toBe('tenant-abc')
    expect(result.region?.id).toBe(regionAId)

    // Non-leak invariant — serialised shape must not carry any of the
    // canonical secret keys.
    const serialised = JSON.stringify(result)
    for (const banned of ['clientSecret', 'CLIENT_SECRET', 'SESSION_SECRET', 'HMAC_SESSION_KEY', 'sessionSecret']) {
      expect(serialised).not.toContain(banned)
    }
    // S8: nor the bootstrap address itself, in any field. Asserting the
    // configured-boolean alone would still pass if the address leaked
    // somewhere else in the payload.
    expect(serialised).not.toContain('bootstrap@wvi.test')
    expect(serialised).not.toContain('@')
  })

  it('admin → settings never carries connection detail from a probe error', async () => {
    // S8 redacts probe errors to a reason enum. This asserts the payload
    // carries no host/port/database substring from a postgres-js style error,
    // which is what the raw driver message used to embed.
    process.env.NUXT_OIDC_AUTH_DEV_MODE = 'true'
    const handler = await loadHandler()
    const ev = makeEvent({
      path: `/api/v1/admin/settings`,
      initialSession: adminASession(),
    })
    const serialised = JSON.stringify(await handler(ev as never))
    for (const banned of ['.postgres.database.azure.com', ':5432', 'password=', 'sslmode=']) {
      expect(serialised, `settings payload leaked ${banned}`).not.toContain(banned)
    }
  })

  it('developer caller → 403 forbidden', async () => {
    const handler = await loadHandler()
    const ev = makeEvent({
      path: `/api/v1/admin/settings`,
      initialSession: devSession(),
    })
    await expect(handler(ev as never)).rejects.toMatchObject({ statusCode: 403 })
  })
})

// ── GET /api/v1/admin/diagnostics ──────────────────────────────────
describe('GET /api/v1/admin/diagnostics', () => {
  async function loadHandler() {
    return (await import('../../../server/api/v1/admin/diagnostics/index.get'))
      .default as (event: unknown) => Promise<unknown>
  }

  it('admin → returns postgres probe (reachable=true) + redis/queues unavailable', async () => {
    const handler = await loadHandler()
    const ev = makeEvent({
      path: `/api/v1/admin/diagnostics`,
      initialSession: adminASession(),
    })
    const result = (await handler(ev as never)) as {
      postgres: { reachable: boolean; latencyMs: number }
      redis: { unavailable?: boolean }
      queues: { unavailable?: boolean }
      workers: unknown[]
      lastSync: unknown[]
      nodeEnv: string
    }
    expect(result.postgres.reachable).toBe(true)
    expect(result.postgres.latencyMs).toBeGreaterThanOrEqual(0)
    expect(result.redis.unavailable).toBe(true)
    expect(result.queues.unavailable).toBe(true)
    // Worker-execution-health block is always present (empty when no runs).
    expect(Array.isArray(result.workers)).toBe(true)
    expect(Array.isArray(result.lastSync)).toBe(true)
    expect(typeof result.nodeEnv).toBe('string')
  })

  it('developer caller → 403 forbidden', async () => {
    const handler = await loadHandler()
    const ev = makeEvent({
      path: `/api/v1/admin/diagnostics`,
      initialSession: devSession(),
    })
    await expect(handler(ev as never)).rejects.toMatchObject({ statusCode: 403 })
  })
})
