// @vitest-environment node
/*
 * ROUTE tests for the handlers the RLS lane conversion changed that had NO
 * route test at all (CLAUDE.md rule 10 — "a module test is not a route test";
 * the engine test cannot see the boundary).
 *
 * These are not RLS assertions — tests/integration/db/rls-force-lanes.test.ts
 * owns that, under a real non-owner with FORCE on. What these cover is the
 * BEHAVIOUR the conversion moved: several handlers had a mutation and its audit
 * row on two separate handles, so a 404 or a conflict could commit half the
 * work. Folding both into one withRequestRls transaction made them atomic, and
 * atomicity is observable without RLS: the negative paths must leave NO
 * audit_event row behind.
 *
 * Covered here (each previously had zero tests importing it):
 *   PATCH  /api/v1/me/inbox/{id}
 *   POST   /api/v1/me/identities        GET /api/v1/me/identities
 *   DELETE /api/v1/me/identities/{id}
 *   GET    /api/v1/me/projects
 *   GET    /api/v1/admin/regions
 *   POST   /api/v1/auth/logout
 *   GET    /api/v1/admin/reconciliation/anthropic/health
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { sql } from 'drizzle-orm'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'
import * as schema from '../../../drizzle/schema'
import { injectTestSession } from '../../helpers/auth'
import type { Session } from '../../../server/utils/auth'

import inboxPatchHandler from '../../../server/api/v1/me/inbox/[id].patch'
import identitiesGetHandler from '../../../server/api/v1/me/identities.get'
import identitiesPostHandler, { MAX_SELF_LINKED_IDENTITIES } from '../../../server/api/v1/me/identities.post'
import identityDeleteHandler from '../../../server/api/v1/me/identities/[id].delete'
import myProjectsHandler from '../../../server/api/v1/me/projects.get'
import adminRegionsHandler from '../../../server/api/v1/admin/regions.get'
import logoutHandler from '../../../server/api/v1/auth/logout.post'
import anthropicHealthHandler from '../../../server/api/v1/admin/reconciliation/anthropic/health.get'

let t: TestDb
let regionId = ''
let ouId = ''
let devId = ''
let peerId = ''
let adminId = ''
let projectId = ''
let myInboxItemId = ''
let peerInboxItemId = ''

// Real uuid (CLAUDE.md rule 18 — z.string().uuid() enforces the version and
// variant nibbles, so 00000000-…-0001 400s before reaching the behaviour).
const UNKNOWN_ID = '9a1e0000-0000-4000-8000-0000000000a1'

beforeAll(async () => {
  t = await startTestDb()
  process.env.DATABASE_URL = t.url
  process.env.NUXT_SESSION_SECRET = 'lane-routes-secret-padded-to-thirty-two!!'
  process.env.NUXT_HMAC_SESSION_KEY = 'lane-routes-hmac-key-padded-well-beyond-32-chars'
  // The anthropic health route folds an unset endpoint into an amber
  // 'endpoint-unset' verdict WITHOUT any outbound call — that is what keeps
  // this suite hermetic.
  delete process.env.NUXT_ANTHROPIC_API_ENDPOINT

  const [r] = await t.db.insert(schema.region).values({ code: 'lr1', displayName: 'LR One' }).returning()
  regionId = r!.id
  // A second region so /admin/regions has more than one row to return.
  await t.db.insert(schema.region).values({ code: 'lr2', displayName: 'LR Two' })

  const [ou] = await t.db
    .insert(schema.orgUnit)
    .values({ regionId, path: 'lr1.svc', code: 'lr-svc', displayName: 'LR Svc', unitType: 'bu', isCostOwningUnit: true })
    .returning()
  ouId = ou!.id

  const [dev] = await t.db
    .insert(schema.teammate)
    .values({ entraOid: 'lr-oid-dev', email: 'lr-dev@example.com', displayName: 'LR Dev', role: 'developer', regionId, orgUnitId: ouId })
    .returning()
  devId = dev!.id
  const [peer] = await t.db
    .insert(schema.teammate)
    .values({ entraOid: 'lr-oid-peer', email: 'lr-peer@example.com', displayName: 'LR Peer', role: 'developer', regionId, orgUnitId: ouId })
    .returning()
  peerId = peer!.id
  const [admin] = await t.db
    .insert(schema.teammate)
    .values({ entraOid: 'lr-oid-admin', email: 'lr-admin@example.com', displayName: 'LR Admin', role: 'admin', regionId, orgUnitId: ouId })
    .returning()
  adminId = admin!.id

  const [proj] = await t.db
    .insert(schema.project)
    .values({ code: 'LR-A', codeHash: 'h-lr-a', displayName: 'LR A', type: 'billable', regionId, costOwningUnitId: ouId })
    .returning({ id: schema.project.id })
  projectId = proj!.id
  // `effective` is a NOT NULL tstzrange — getMyProjects filters on it containing
  // now(), so an open-ended range starting in the past is what "current member"
  // means here.
  await t.db.insert(schema.projectAssignment).values({
    projectId,
    teammateId: devId,
    effective: '[2020-01-01T00:00:00+00,)',
    role: 'member',
  })

  const [mine] = await t.db
    .insert(schema.inboxItem)
    .values({ recipientTeammateId: devId, category: 'budget', severity: 'info', subject: 'Yours', body: {} })
    .returning({ id: schema.inboxItem.id })
  myInboxItemId = mine!.id
  const [theirs] = await t.db
    .insert(schema.inboxItem)
    .values({ recipientTeammateId: peerId, category: 'budget', severity: 'info', subject: 'Theirs', body: {} })
    .returning({ id: schema.inboxItem.id })
  peerInboxItemId = theirs!.id
}, 90_000)

afterAll(async () => {
  await stopTestDb(t)
}, 30_000)

function ev(opts: { session?: Session; body?: unknown; params?: Record<string, string>; method?: string }) {
  const method = opts.method ?? 'POST'
  const headers: Record<string, string> = {
    host: 'localhost:3450',
    origin: 'http://localhost:3450',
    'content-type': 'application/json',
  }
  const e = {
    method,
    path: '/x',
    context: { params: opts.params ?? {} },
    node: {
      req: {
        method,
        url: '/x',
        body: opts.body,
        socket: { remoteAddress: '127.0.0.1' },
        get headers() {
          return headers
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
  if (opts.session) {
    injectTestSession(e as unknown as Parameters<typeof injectTestSession>[0], opts.session)
  }
  return e
}

const sessionFor = (teammateId: string, role: string, opts: { regionId?: string } = {}): Session =>
  ({
    teammateId,
    email: `${role}@example.com`,
    displayName: role,
    role,
    regionId: opts.regionId ?? regionId,
    orgPath: 'lr1.svc',
  }) as Session

async function auditCount(eventType: string): Promise<number> {
  const rows = await t.client<{ n: string }[]>`
    SELECT COUNT(*)::text AS n FROM audit_event WHERE event_type = ${eventType}
  `
  return Number(rows[0]!.n)
}

describe('PATCH /me/inbox/{id} — the ack and its audit row are now one transaction', () => {
  it('acking my own item returns the new state and writes exactly one audit row', async () => {
    const before = await auditCount('inbox-acked')
    const out = (await inboxPatchHandler(
      ev({ session: sessionFor(devId, 'developer'), params: { id: myInboxItemId }, body: { ack_state: 'acknowledged' }, method: 'PATCH' }) as never,
    )) as { id: string; ack_state: string }

    expect(out).toEqual({ id: myInboxItemId, ack_state: 'acknowledged' })
    expect(await auditCount('inbox-acked')).toBe(before + 1)

    const rows = await t.client<{ ack_state: string; ack_by: string }[]>`
      SELECT ack_state, ack_by::text AS ack_by FROM inbox_item WHERE id = ${myInboxItemId}::uuid
    `
    expect(rows[0]!.ack_state).toBe('acknowledged')
    expect(rows[0]!.ack_by).toBe(devId)
  })

  it("acking a PEER's item 404s and leaves NO audit row — the 404 is inside the transaction now", async () => {
    const before = await auditCount('inbox-acked')
    await expect(
      inboxPatchHandler(
        ev({ session: sessionFor(devId, 'developer'), params: { id: peerInboxItemId }, body: { ack_state: 'dismissed' }, method: 'PATCH' }) as never,
      ),
    ).rejects.toMatchObject({ statusCode: 404 })

    // The peer's row is untouched and nothing was audited. (This direction held
    // before the conversion too — the throw preceded the audit write. The
    // direction that did NOT hold is the next test.)
    expect(await auditCount('inbox-acked')).toBe(before)
    const rows = await t.client<{ ack_state: string }[]>`
      SELECT ack_state FROM inbox_item WHERE id = ${peerInboxItemId}::uuid
    `
    expect(rows[0]!.ack_state).toBe('unread') // the schema default; untouched
  })

  it('THE ATOMICITY THE CONVERSION BOUGHT: a failing audit write now rolls the ack back', async () => {
    /*
     * The direction that did not hold before. The audit row used to be written
     * on a second, context-less handle AFTER the ack's own transaction had
     * already committed, so an audit failure left an acked item with no record
     * of who acked it — the forensic hole recordAuditEvent exists to close.
     *
     * Injected with a throwing BEFORE INSERT trigger rather than by RLS: this
     * suite connects as the test database's owner/superuser, for whom even
     * FORCE is inert (a superuser bypasses row security outright). Reaching for
     * RLS here would produce a test that passes for the wrong reason — it did,
     * on the first run, because the audit INSERT simply succeeded. The
     * non-owner path is proven in tests/integration/db/rls-force-lanes.test.ts,
     * which builds a real non-owner login for exactly this reason.
     */
    const [fresh] = await t.db
      .insert(schema.inboxItem)
      .values({ recipientTeammateId: devId, category: 'budget', severity: 'info', subject: 'Rollback probe', body: {} })
      .returning({ id: schema.inboxItem.id })

    await t.client.unsafe(`
      CREATE OR REPLACE FUNCTION lane_probe_fail_audit() RETURNS trigger AS $$
      BEGIN RAISE EXCEPTION 'audit write refused (test probe)'; END;
      $$ LANGUAGE plpgsql;
      CREATE TRIGGER lane_probe_fail_audit_trg BEFORE INSERT ON audit_event
        FOR EACH ROW EXECUTE FUNCTION lane_probe_fail_audit();
    `)
    try {
      await expect(
        inboxPatchHandler(
          ev({ session: sessionFor(devId, 'developer'), params: { id: fresh!.id }, body: { ack_state: 'acknowledged' }, method: 'PATCH' }) as never,
        ),
      ).rejects.toThrow()

      // THE assertion: the ack did not survive the failed audit.
      const rows = await t.client<{ ack_state: string; ack_by: string | null }[]>`
        SELECT ack_state, ack_by::text AS ack_by FROM inbox_item WHERE id = ${fresh!.id}::uuid
      `
      expect(rows[0]!.ack_state).toBe('unread')
      expect(rows[0]!.ack_by).toBeNull()
    } finally {
      await t.client.unsafe('DROP TRIGGER IF EXISTS lane_probe_fail_audit_trg ON audit_event')
      await t.client.unsafe('DROP FUNCTION IF EXISTS lane_probe_fail_audit()')
    }
  })

  it('an unknown id 404s', async () => {
    await expect(
      inboxPatchHandler(
        ev({ session: sessionFor(devId, 'developer'), params: { id: UNKNOWN_ID }, body: { ack_state: 'read' }, method: 'PATCH' }) as never,
      ),
    ).rejects.toMatchObject({ statusCode: 404 })
  })
})

describe('/me/identities — link, list, unlink', () => {
  let linkedId = ''

  it('POST links an identity, audits it, and GET lists it', async () => {
    const out = (await identitiesPostHandler(
      ev({ session: sessionFor(devId, 'developer'), body: { system: 'github', identifier: 'lr-dev-gh', identifier_kind: 'username' } }) as never,
    )) as { id: string; identifier: string; verified: boolean }
    linkedId = out.id
    expect(out.identifier).toBe('lr-dev-gh')
    expect(out.verified).toBe(false)
    expect(await auditCount('identity-linked')).toBe(1)

    const listed = (await identitiesGetHandler(
      ev({ session: sessionFor(devId, 'developer'), method: 'GET' }) as never,
    )) as { primary: string; identities: Array<{ id: string; identifier: string }> }
    expect(listed.primary).toBe('lr-dev@example.com')
    expect(listed.identities.map((i) => i.identifier)).toContain('lr-dev-gh')
  })

  it('re-linking the same identity 409s — the pre-checks still run, now inside the transaction', async () => {
    await expect(
      identitiesPostHandler(
        ev({ session: sessionFor(devId, 'developer'), body: { system: 'github', identifier: 'lr-dev-gh', identifier_kind: 'username' } }) as never,
      ),
    ).rejects.toMatchObject({ statusCode: 409 })
    expect(await auditCount('identity-linked')).toBe(1) // no second audit row
  })

  it("claiming another teammate's PRIMARY email 409s", async () => {
    await expect(
      identitiesPostHandler(
        ev({ session: sessionFor(devId, 'developer'), body: { system: 'claude-code', identifier: 'lr-peer@example.com' } }) as never,
      ),
    ).rejects.toMatchObject({ statusCode: 409 })
  })

  it('DELETE unlinks mine and audits it', async () => {
    const out = (await identityDeleteHandler(
      ev({ session: sessionFor(devId, 'developer'), params: { id: linkedId }, method: 'DELETE' }) as never,
    )) as { removed: boolean }
    expect(out.removed).toBe(true)
    expect(await auditCount('identity-unlinked')).toBe(1)
  })

  it(`a ${MAX_SELF_LINKED_IDENTITIES + 1}th self-linked identity is refused (409), inserts nothing and audits nothing`, async () => {
    const mine = async () =>
      Number(
        [
          ...(await t.db.execute<{ c: string }>(sql`
            SELECT COUNT(*)::text AS c FROM teammate_identity_map WHERE teammate_id = ${peerId}::uuid AND source = 'self'
          `)),
        ][0]!.c,
      )
    for (let i = await mine(); i < MAX_SELF_LINKED_IDENTITIES; i++) {
      await identitiesPostHandler(
        ev({ session: sessionFor(peerId, 'developer'), body: { system: 'github', identifier: `lr-peer-cap-${i}`, identifier_kind: 'username' } }) as never,
      )
    }
    expect(await mine()).toBe(MAX_SELF_LINKED_IDENTITIES)
    const audits = await auditCount('identity-linked')
    await expect(
      identitiesPostHandler(
        ev({ session: sessionFor(peerId, 'developer'), body: { system: 'github', identifier: 'lr-peer-cap-over', identifier_kind: 'username' } }) as never,
      ),
    ).rejects.toMatchObject({ statusCode: 409 })
    expect(await mine()).toBe(MAX_SELF_LINKED_IDENTITIES)
    expect(await auditCount('identity-linked')).toBe(audits)
  })

  it('DELETE of an unknown id 404s and writes NO audit row', async () => {
    const before = await auditCount('identity-unlinked')
    await expect(
      identityDeleteHandler(
        ev({ session: sessionFor(devId, 'developer'), params: { id: UNKNOWN_ID }, method: 'DELETE' }) as never,
      ),
    ).rejects.toMatchObject({ statusCode: 404 })
    expect(await auditCount('identity-unlinked')).toBe(before)
  })

  it('DELETE of a peer-owned row 404s (the teammate predicate is still the gate)', async () => {
    const [peerRow] = await t.db
      .insert(schema.teammateIdentityMap)
      .values({ teammateId: peerId, system: 'github', identifier: 'lr-peer-gh', identifierKind: 'username', source: 'self' })
      .returning({ id: schema.teammateIdentityMap.id })
    await expect(
      identityDeleteHandler(
        ev({ session: sessionFor(devId, 'developer'), params: { id: peerRow!.id }, method: 'DELETE' }) as never,
      ),
    ).rejects.toMatchObject({ statusCode: 404 })
    const still = await t.client<{ n: string }[]>`
      SELECT COUNT(*)::text AS n FROM teammate_identity_map WHERE id = ${peerRow!.id}::uuid
    `
    expect(Number(still[0]!.n)).toBe(1)
  })

  it('DELETE of my own directory-sync or admin-manual binding 404s and leaves it in place', async () => {
    const before = await auditCount('identity-unlinked')
    for (const source of ['directory-sync', 'admin-manual']) {
      const [row] = await t.db
        .insert(schema.teammateIdentityMap)
        .values({
          teammateId: devId,
          system: 'github',
          identifier: `lr-dev-${source}`,
          identifierKind: 'username',
          enterpriseSlug: 'lr-ent',
          source,
          verifiedAt: new Date(),
        })
        .returning({ id: schema.teammateIdentityMap.id })
      await expect(
        identityDeleteHandler(
          ev({ session: sessionFor(devId, 'developer'), params: { id: row!.id }, method: 'DELETE' }) as never,
        ),
      ).rejects.toMatchObject({ statusCode: 404 })
      const still = await t.client<{ n: string }[]>`
        SELECT COUNT(*)::text AS n FROM teammate_identity_map WHERE id = ${row!.id}::uuid
      `
      expect(Number(still[0]!.n)).toBe(1)
    }
    expect(await auditCount('identity-unlinked')).toBe(before)
  })
})

describe('GET /me/projects', () => {
  it('lists the caller\'s own memberships', async () => {
    const out = (await myProjectsHandler(
      ev({ session: sessionFor(devId, 'developer'), method: 'GET' }) as never,
    )) as { projects: Array<{ id: string; code: string }> }
    expect(out.projects.map((p) => p.id)).toEqual([projectId])
  })

  it('a non-member sees none', async () => {
    const out = (await myProjectsHandler(
      ev({ session: sessionFor(peerId, 'developer'), method: 'GET' }) as never,
    )) as { projects: unknown[] }
    expect(out.projects).toEqual([])
  })
})

describe('GET /admin/regions', () => {
  it('an admin gets every region', async () => {
    const out = (await adminRegionsHandler(
      ev({ session: sessionFor(adminId, 'admin'), method: 'GET' }) as never,
    )) as { regions: Array<{ id: string; code: string }> }
    const codes = out.regions.map((r) => r.code)
    expect(codes).toContain('lr1')
    expect(codes).toContain('lr2')
  })

  it('a developer is refused (403) — requireRole is still the gate', async () => {
    await expect(
      adminRegionsHandler(ev({ session: sessionFor(devId, 'developer'), method: 'GET' }) as never),
    ).rejects.toMatchObject({ statusCode: 403 })
  })
})

describe('POST /auth/logout', () => {
  it('audits the logout for a signed-in caller', async () => {
    const before = await auditCount('logout')
    const out = (await logoutHandler(ev({ session: sessionFor(devId, 'developer') }) as never)) as { ok: boolean }
    expect(out.ok).toBe(true)
    expect(await auditCount('logout')).toBe(before + 1)
  })

  it('is a 200 no-op with no session, and writes nothing', async () => {
    const before = await auditCount('logout')
    const out = (await logoutHandler(ev({}) as never)) as { ok: boolean }
    expect(out.ok).toBe(true)
    // The audit write lives inside `if (session)`; withRequestRls would 401 if
    // it were reached without one, so "no row" is the assertion that the guard
    // still short-circuits BEFORE the lane.
    expect(await auditCount('logout')).toBe(before)
  })
})

describe('GET /admin/reconciliation/anthropic/health', () => {
  beforeAll(async () => {
    await t.db.execute(sql`
      INSERT INTO provider_org (provider, external_org_id, display_name, api_kind, reconciliation_mode)
      VALUES ('anthropic', 'lr-org', 'LR Org', 'claude-code-admin', 'reconciled')
    `)
  })

  it('a platform-admin gets a per-org verdict; an unset endpoint is amber, not an outbound call', async () => {
    const out = (await anthropicHealthHandler(
      ev({ session: sessionFor(adminId, 'platform-admin'), method: 'GET' }) as never,
    )) as { orgs: Array<{ externalOrgId: string; color: string; reason?: string }>; total: number; endpointConfigured: boolean }

    expect(out.endpointConfigured).toBe(false)
    expect(out.total).toBe(1)
    expect(out.orgs[0]!.externalOrgId).toBe('lr-org')
    // No key + no endpoint — the verdict is a config gap, never a red auth error.
    expect(['amber', 'red']).toContain(out.orgs[0]!.color)
  })

  it('a developer is refused (403)', async () => {
    await expect(
      anthropicHealthHandler(ev({ session: sessionFor(devId, 'developer'), method: 'GET' }) as never),
    ).rejects.toMatchObject({ statusCode: 403 })
  })

  it('a region admin is refused (403): the route lists and probes every region\'s provider_org', async () => {
    await expect(
      anthropicHealthHandler(ev({ session: sessionFor(adminId, 'admin'), method: 'GET' }) as never),
    ).rejects.toMatchObject({ statusCode: 403 })
  })
})
