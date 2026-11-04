// @vitest-environment node
/*
 * Admin report-access grants (mig 0129) — replaces the retired
 * admin/report-visibility.test.ts (three-mode admin dial, task #19).
 *
 * Covers: GET (org-wide only per A4 — a region admin now 403s on READ too,
 * not just write), POST (grant + audit, region-admin 403, CSRF, validation,
 * duplicate 409, ineligible target), DELETE (revoke + audit, second revoke
 * 404, developer 403), the post-revoke re-grant (partial unique index
 * respects a revoked row), the A5 expiry-supersede lifecycle (an expired
 * grant shows `status: 'expired'` on GET rather than vanishing, and a POST
 * for the SAME (teammate, permission) supersedes it instead of 409-ing
 * forever), and that an expired-but-not-yet-superseded grant does NOT
 * elevate `resolveReportGrants`. Plus a light pass over the new
 * teammate-search typeahead (A7).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'
import * as schema from '../../../drizzle/schema'
import { injectTestSession } from '../../helpers/auth'
import { withRlsContext } from '../../../server/db/rls'
import { resolveReportGrants } from '../../../server/auth/report-scope'
import type { Session } from '../../../server/utils/auth'
import getHandler from '../../../server/api/v1/admin/report-access/index.get'
import postHandler from '../../../server/api/v1/admin/report-access/index.post'
import deleteHandler from '../../../server/api/v1/admin/report-access/[id].delete'
import searchHandler from '../../../server/api/v1/admin/report-access/teammate-search.get'

let t: TestDb
let regionId = ''
let unitId = ''
let finopsId = ''
let platformAdminId = ''
let regionAdminId = ''
let devId = ''
let targetId = ''
let inactiveTargetId = ''
let provisionalTargetId = ''

function ev(opts: {
  session?: Session
  method?: string
  body?: unknown
  routerParams?: Record<string, string>
  query?: Record<string, string>
  origin?: string | null
}) {
  const method = opts.method ?? 'GET'
  const qs = opts.query ? `?${new URLSearchParams(opts.query).toString()}` : ''
  const path = `/x${qs}`
  const headers: Record<string, string> = { host: 'localhost:3450' }
  if (opts.origin !== null) headers.origin = opts.origin ?? 'http://localhost:3450'
  const e = {
    method,
    path,
    context: { params: opts.routerParams ?? {} },
    node: {
      req: {
        method,
        url: path,
        body: opts.body,
        socket: { remoteAddress: '127.0.0.1' },
        get headers() {
          return { ...headers, 'content-type': 'application/json' }
        },
      },
      res: {
        _headers: {} as Record<string, unknown>,
        statusCode: 200,
        getHeader() {},
        setHeader() {},
        removeHeader() {},
        appendHeader() {},
        get headersSent() {
          return false
        },
      },
    },
  }
  if (opts.session) injectTestSession(e as unknown as Parameters<typeof injectTestSession>[0], opts.session)
  return e as never
}

const orgWideSession = (): Session =>
  ({ teammateId: finopsId, email: 'ra-fin@x.test', displayName: 'Fin', role: 'platform-admin', regionId, orgPath: 'ra' }) as Session
const platformAdminSession = (): Session =>
  ({ teammateId: platformAdminId, email: 'ra-pa@x.test', displayName: 'PA', role: 'platform-admin', regionId, orgPath: 'ra' }) as Session
const regionAdminSession = (): Session =>
  ({ teammateId: regionAdminId, email: 'ra-adm@x.test', displayName: 'Adm', role: 'admin', regionId, orgPath: 'ra' }) as Session
const devSession = (): Session =>
  ({ teammateId: devId, email: 'ra-dev@x.test', displayName: 'Dev', role: 'developer', regionId, orgPath: 'ra' }) as Session

beforeAll(async () => {
  t = await startTestDb()
  process.env.DATABASE_URL = t.url
  const [r] = await t.db.insert(schema.region).values({ code: 'rag-a', displayName: 'RAG A' }).returning()
  regionId = r!.id
  const [u] = await t.db
    .insert(schema.orgUnit)
    .values({ regionId, parentId: null, path: 'rag_a', code: 'rag-a-default', displayName: 'RAG A', unitType: 'bu' })
    .returning()
  unitId = u!.id

  const mk = async (
    entraOid: string,
    email: string,
    displayName: string,
    role: string,
    extra: Partial<typeof schema.teammate.$inferInsert> = {},
  ) => {
    const [row] = await t.db
      .insert(schema.teammate)
      .values({ entraOid, email, displayName, role, regionId, orgUnitId: unitId, ...extra })
      .returning()
    return row!.id
  }
  finopsId = await mk('oid-rag-fin', 'ra-fin@x.test', 'Fin', 'platform-admin')
  platformAdminId = await mk('oid-rag-pa', 'ra-pa@x.test', 'PA', 'platform-admin')
  regionAdminId = await mk('oid-rag-adm', 'ra-adm@x.test', 'Adm', 'admin')
  devId = await mk('oid-rag-dev', 'ra-dev@x.test', 'Dev', 'developer')
  targetId = await mk('oid-rag-target', 'ra-target@x.test', 'Target', 'developer')
  inactiveTargetId = await mk('oid-rag-inactive', 'ra-inactive@x.test', 'Inactive', 'developer', { isActive: false })
  provisionalTargetId = await mk('oid-rag-prov', 'ra-prov@x.test', 'Prov', 'developer', { provisional: true })
}, 180_000)

afterAll(async () => {
  if (t) await stopTestDb(t)
}, 30_000)

/*
 * `report_access_grant` is a plain table (freely DELETEable between tests).
 * `audit_event` is trigger-enforced APPEND-ONLY (AGENTS.md §Audit events) —
 * DELETE raises, so it is NEVER cleared. Every audit assertion below scopes
 * its query to a key unique to the row(s) that TEST created (a grant id, or
 * `ORDER BY ts_recorded DESC LIMIT 1` for "the audit row my last write just
 * made") rather than asserting a bare COUNT(*) across the whole file.
 */
beforeEach(async () => {
  await t.client`DELETE FROM report_access_grant`
})

async function forbidden(p: Promise<unknown>) {
  await expect(p).rejects.toMatchObject({ statusCode: 403 })
}

describe('GET /api/v1/admin/report-access', () => {
  it('org-wide (platform-admin) lists grants with joined teammate + granter names', async () => {
    await postHandler(
      ev({ session: orgWideSession(), method: 'POST', body: { teammate_id: targetId, permission: 'operational' } }),
    )
    const got = (await getHandler(ev({ session: orgWideSession() }))) as {
      grants: Array<{
        id: string
        teammate_id: string
        display_name: string | null
        email: string
        role: string
        permission: string
        granted_by: string | null
        granted_by_name: string | null
        status: string
      }>
    }
    expect(got.grants.length).toBe(1)
    const row = got.grants[0]!
    expect(row.teammate_id).toBe(targetId)
    expect(row.email).toBe('ra-target@x.test')
    expect(row.role).toBe('developer')
    expect(row.permission).toBe('operational')
    expect(row.granted_by).toBe(finopsId)
    expect(row.granted_by_name).toBe('Fin')
    expect(row.status).toBe('active')
  })

  it('platform-admin also passes the org-wide gate (bypasses any requireRole)', async () => {
    const got = (await getHandler(ev({ session: platformAdminSession() }))) as { grants: unknown[] }
    expect(Array.isArray(got.grants)).toBe(true)
  })

  it('A4: a REGION admin is 403 on GET too — not just write', async () => {
    await forbidden(getHandler(ev({ session: regionAdminSession() })))
  })

  it('a developer is 403', async () => {
    await forbidden(getHandler(ev({ session: devSession() })))
  })
})

describe('POST /api/v1/admin/report-access', () => {
  it('org-wide grants a permission → row created + report-access-granted audit (before/after/context)', async () => {
    const created = (await postHandler(
      ev({ session: orgWideSession(), method: 'POST', body: { teammate_id: targetId, permission: 'finance' } }),
    )) as { id: string; teammate_id: string; permission: string }
    expect(created.teammate_id).toBe(targetId)
    expect(created.permission).toBe('finance')

    // `audit_event` is append-only (never cleared between tests) — take the
    // MOST RECENT 'report-access-granted' row for this subject, which is the
    // one the POST just above wrote.
    const [audit] = await t.client<{ subject_id: string; payload: { before: unknown; after: Record<string, unknown>; context: Record<string, unknown> } }[]>`
      SELECT subject_id::text AS subject_id, payload::jsonb AS payload
      FROM audit_event
      WHERE event_type = 'report-access-granted' AND subject_id = ${targetId}::uuid
      ORDER BY ts_recorded DESC LIMIT 1`
    expect(audit!.subject_id).toBe(targetId)
    expect(audit!.payload.before).toBeNull()
    expect(audit!.payload.after.permission).toBe('finance')
    expect(audit!.payload.after.teammate_email).toBe('ra-target@x.test')
    expect(audit!.payload.context.teammate_id).toBe(targetId)
  })

  it('a REGION admin cannot grant (403)', async () => {
    await forbidden(
      postHandler(
        ev({ session: regionAdminSession(), method: 'POST', body: { teammate_id: targetId, permission: 'operational' } }),
      ),
    )
  })

  it('a cross-origin request is rejected (CSRF)', async () => {
    await expect(
      postHandler(
        ev({
          session: orgWideSession(),
          method: 'POST',
          origin: 'http://evil.example',
          body: { teammate_id: targetId, permission: 'operational' },
        }),
      ),
    ).rejects.toMatchObject({ statusCode: 403 })
  })

  it('an invalid permission literal is a 400 naming the field', async () => {
    await expect(
      postHandler(
        ev({ session: orgWideSession(), method: 'POST', body: { teammate_id: targetId, permission: 'bogus' } }),
      ),
    ).rejects.toMatchObject({ statusCode: 400 })
    try {
      await postHandler(
        ev({ session: orgWideSession(), method: 'POST', body: { teammate_id: targetId, permission: 'bogus' } }),
      )
      expect.unreachable()
    } catch (err) {
      const detail = (err as { data?: { detail?: string } }).data?.detail ?? ''
      expect(detail).toMatch(/permission/)
    }
  })

  it('a duplicate ACTIVE grant is a 409', async () => {
    await postHandler(
      ev({ session: orgWideSession(), method: 'POST', body: { teammate_id: targetId, permission: 'operational' } }),
    )
    await expect(
      postHandler(
        ev({ session: orgWideSession(), method: 'POST', body: { teammate_id: targetId, permission: 'operational' } }),
      ),
    ).rejects.toMatchObject({ statusCode: 409 })
  })

  it('an INACTIVE target teammate is refused (4xx)', async () => {
    await expect(
      postHandler(
        ev({
          session: orgWideSession(),
          method: 'POST',
          body: { teammate_id: inactiveTargetId, permission: 'operational' },
        }),
      ),
    ).rejects.toMatchObject({ statusCode: 400 })
  })

  it('a PROVISIONAL target teammate is refused (4xx)', async () => {
    await expect(
      postHandler(
        ev({
          session: orgWideSession(),
          method: 'POST',
          body: { teammate_id: provisionalTargetId, permission: 'operational' },
        }),
      ),
    ).rejects.toMatchObject({ statusCode: 400 })
  })

  it('an expires_at in the past is a 400', async () => {
    const past = new Date(Date.now() - 60_000).toISOString()
    await expect(
      postHandler(
        ev({
          session: orgWideSession(),
          method: 'POST',
          body: { teammate_id: targetId, permission: 'operational', expires_at: past },
        }),
      ),
    ).rejects.toMatchObject({ statusCode: 400 })
  })
})

describe('DELETE /api/v1/admin/report-access/{id}', () => {
  it('revokes an active grant, sets revoked_at, and audits report-access-revoked (before/after/context)', async () => {
    const created = (await postHandler(
      ev({ session: orgWideSession(), method: 'POST', body: { teammate_id: targetId, permission: 'operational' } }),
    )) as { id: string }

    const revoked = (await deleteHandler(
      ev({ session: orgWideSession(), method: 'DELETE', routerParams: { id: created.id } }),
    )) as { revoked: boolean; id: string }
    expect(revoked).toEqual({ revoked: true, id: created.id })

    const rows = await t.client<{ revoked_at: string | null }[]>`
      SELECT revoked_at::text AS revoked_at FROM report_access_grant WHERE id = ${created.id}::uuid`
    expect(rows[0]!.revoked_at).not.toBeNull()

    // Scoped by grant id — unique to THIS test's grant, so it is exact even
    // though `audit_event` is append-only and never cleared between tests.
    const audits = await t.client<{ payload: { before: Record<string, unknown>; after: Record<string, unknown>; context: Record<string, unknown> } }[]>`
      SELECT payload::jsonb AS payload FROM audit_event
      WHERE event_type = 'report-access-revoked'
        AND (payload::jsonb -> 'context' ->> 'grant_id') = ${created.id}
      ORDER BY ts_recorded`
    expect(audits.length).toBe(1)
    expect(audits[0]!.payload.before.permission).toBe('operational')
    expect(audits[0]!.payload.after.revoked_at).toBeTruthy()
    expect(audits[0]!.payload.context.grant_id).toBe(created.id)
    expect(audits[0]!.payload.context.teammate_id).toBe(targetId)
  })

  it('a second revoke on the same grant is 404', async () => {
    const created = (await postHandler(
      ev({ session: orgWideSession(), method: 'POST', body: { teammate_id: targetId, permission: 'operational' } }),
    )) as { id: string }
    await deleteHandler(ev({ session: orgWideSession(), method: 'DELETE', routerParams: { id: created.id } }))
    await expect(
      deleteHandler(ev({ session: orgWideSession(), method: 'DELETE', routerParams: { id: created.id } })),
    ).rejects.toMatchObject({ statusCode: 404 })
  })

  it('a developer cannot revoke (403)', async () => {
    const created = (await postHandler(
      ev({ session: orgWideSession(), method: 'POST', body: { teammate_id: targetId, permission: 'operational' } }),
    )) as { id: string }
    await forbidden(deleteHandler(ev({ session: devSession(), method: 'DELETE', routerParams: { id: created.id } })))
  })

  it('post-revoke re-grant succeeds — the partial unique index respects a revoked row', async () => {
    const created = (await postHandler(
      ev({ session: orgWideSession(), method: 'POST', body: { teammate_id: targetId, permission: 'operational' } }),
    )) as { id: string }
    await deleteHandler(ev({ session: orgWideSession(), method: 'DELETE', routerParams: { id: created.id } }))

    const regranted = (await postHandler(
      ev({ session: orgWideSession(), method: 'POST', body: { teammate_id: targetId, permission: 'operational' } }),
    )) as { id: string }
    expect(regranted.id).not.toBe(created.id)

    const active = await t.client<{ n: string }[]>`
      SELECT count(*)::text AS n FROM report_access_grant
      WHERE teammate_id = ${targetId}::uuid AND permission = 'operational' AND revoked_at IS NULL`
    expect(Number(active[0]!.n)).toBe(1)
  })

  it("refuses the retired 'revoke-all' permission (400) and writes no row", async () => {
    await expect(
      postHandler(
        ev({ session: orgWideSession(), method: 'POST', body: { teammate_id: targetId, permission: 'revoke-all' } }),
      ),
    ).rejects.toMatchObject({ statusCode: 400 })
    const rows = await t.client<{ n: string }[]>`
      SELECT count(*)::text AS n FROM report_access_grant WHERE teammate_id = ${targetId}::uuid`
    expect(Number(rows[0]!.n)).toBe(0)
  })
})

describe('A5: expiry lifecycle — GET shows status, POST supersedes, resolveReportGrants stays at baseline until superseded', () => {
  it('an expired (not revoked) grant shows status "expired" on GET, and does NOT elevate resolveReportGrants', async () => {
    const past = new Date(Date.now() - 60_000).toISOString()
    await t.client`
      INSERT INTO report_access_grant (teammate_id, permission, granted_by, expires_at)
      VALUES (${targetId}::uuid, 'finance', ${finopsId}::uuid, ${past}::timestamptz)`

    const got = (await getHandler(ev({ session: orgWideSession() }))) as {
      grants: Array<{ teammate_id: string; permission: string; status: string }>
    }
    const row = got.grants.find((g) => g.teammate_id === targetId && g.permission === 'finance')
    expect(row?.status).toBe('expired')

    const targetSession: Session = {
      teammateId: targetId,
      email: 'ra-target@x.test',
      displayName: 'Target',
      role: 'developer',
      regionId,
      orgPath: 'ra',
      issuedAt: new Date().toISOString(),
    }
    const grants = await withRlsContext(
      t.db as never,
      { userRegionId: regionId, userOrgPath: 'ra', userRole: 'developer', userTeammateId: targetId },
      async (tx) => resolveReportGrants({ context: {} } as never, tx as never, targetSession),
    )
    // Baseline for a plain developer with no ownership: finance false, no elevation
    // from the expired-but-not-yet-superseded row.
    expect(grants.finance).toBe(false)
    expect(grants.across).toBe(false)
  })

  it('POSTing the SAME (teammate, permission) supersedes the expired blocker instead of 409-ing', async () => {
    const past = new Date(Date.now() - 60_000).toISOString()
    const [expired] = await t.client<{ id: string }[]>`
      INSERT INTO report_access_grant (teammate_id, permission, granted_by, expires_at)
      VALUES (${targetId}::uuid, 'finance', ${finopsId}::uuid, ${past}::timestamptz)
      RETURNING id::text AS id`

    const regranted = (await postHandler(
      ev({ session: orgWideSession(), method: 'POST', body: { teammate_id: targetId, permission: 'finance' } }),
    )) as { id: string }
    expect(regranted.id).not.toBe(expired!.id)

    const supersededRow = await t.client<{ revoked_at: string | null }[]>`
      SELECT revoked_at::text AS revoked_at FROM report_access_grant WHERE id = ${expired!.id}::uuid`
    expect(supersededRow[0]!.revoked_at).not.toBeNull()

    // Scoped by the superseded grant's own id — exact even though
    // `audit_event` is append-only and never cleared between tests.
    const supersedeAudit = await t.client<{ payload: { context: Record<string, unknown> } }[]>`
      SELECT payload::jsonb AS payload FROM audit_event
      WHERE event_type = 'report-access-revoked'
        AND (payload::jsonb -> 'context' ->> 'grant_id') = ${expired!.id}
      ORDER BY ts_recorded`
    expect(supersedeAudit.length).toBe(1)
    expect(supersedeAudit[0]!.payload.context.reason).toBe('expired-superseded')
    expect(supersedeAudit[0]!.payload.context.grant_id).toBe(expired!.id)

    const active = await t.client<{ n: string }[]>`
      SELECT count(*)::text AS n FROM report_access_grant
      WHERE teammate_id = ${targetId}::uuid AND permission = 'finance' AND revoked_at IS NULL`
    expect(Number(active[0]!.n)).toBe(1)
  })

  it('a LIVE (unexpired) duplicate is untouched by the supersede step and still 409s', async () => {
    await postHandler(
      ev({ session: orgWideSession(), method: 'POST', body: { teammate_id: targetId, permission: 'operational' } }),
    )
    await expect(
      postHandler(
        ev({ session: orgWideSession(), method: 'POST', body: { teammate_id: targetId, permission: 'operational' } }),
      ),
    ).rejects.toMatchObject({ statusCode: 409 })
  })
})

describe('GET /api/v1/admin/report-access/teammate-search (A7)', () => {
  it('org-wide finds active, non-provisional teammates by name/email substring', async () => {
    const got = (await searchHandler(
      ev({ session: orgWideSession(), query: { q: 'ra-target' } }),
    )) as { results: Array<{ id: string; email: string }> }
    expect(got.results.some((r) => r.id === targetId)).toBe(true)
  })

  it('excludes inactive and provisional teammates', async () => {
    const got = (await searchHandler(
      ev({ session: orgWideSession(), query: { q: 'ra-' } }),
    )) as { results: Array<{ id: string }> }
    const ids = got.results.map((r) => r.id)
    expect(ids).not.toContain(inactiveTargetId)
    expect(ids).not.toContain(provisionalTargetId)
  })

  it('a REGION admin is 403 (org-wide only)', async () => {
    await forbidden(searchHandler(ev({ session: regionAdminSession(), query: { q: 'ra-target' } })))
  })

  it('a q shorter than 2 chars is a 400', async () => {
    await expect(searchHandler(ev({ session: orgWideSession(), query: { q: 'a' } }))).rejects.toMatchObject({
      statusCode: 400,
    })
  })
})
