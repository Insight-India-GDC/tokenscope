// @vitest-environment node
/*
 * Admin surfaces for org-Entra region derivation (mig 0068;
 * docs/design/org-entra-region-derivation.md):
 *   - region_leader CRUD  — GET/POST /admin/regions/{id}/leaders,
 *                           DELETE …/leaders/{leaderId} (soft-revoke)
 *   - region-delete emptiness fix — a region with a leader or a department rule
 *     is BLOCKED (clean 409, not a raw 23503 500).
 *
 * Mirrors the activity-types integration test's h3-event harness +
 * injectTestSession; runs against testcontainers Postgres so the real
 * partial-unique index, the upsert, and the FK posture are exercised.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'
import * as schema from '../../../drizzle/schema'
import { injectTestSession } from '../../helpers/auth'
import type { Session } from '../../../server/utils/auth'
import leadersGet from '../../../server/api/v1/admin/regions/[id]/leaders.get'
import leadersPost from '../../../server/api/v1/admin/regions/[id]/leaders.post'
import leaderDelete from '../../../server/api/v1/admin/regions/[id]/leaders/[leaderId].delete'
import regionDelete from '../../../server/api/v1/admin/regions/[id].delete'
import rulesGet from '../../../server/api/v1/admin/directory-region-rules.get'
import rulesPost from '../../../server/api/v1/admin/directory-region-rules.post'
import ruleDelete from '../../../server/api/v1/admin/directory-region-rules/[id].delete'
import fieldDist from '../../../server/api/v1/admin/directory/field-distribution.get'

let t: TestDb
let regionA: string
let regionB: string
let ouA: string
let adminAId: string
let platformId: string

beforeAll(async () => {
  t = await startTestDb()
  process.env.DATABASE_URL = t.url

  const [ra] = await t.db.insert(schema.region).values({ code: 'rd-a', displayName: 'RD A' }).returning()
  const [rb] = await t.db.insert(schema.region).values({ code: 'rd-b', displayName: 'RD B' }).returning()
  regionA = ra!.id
  regionB = rb!.id

  const [ou] = await t.db
    .insert(schema.orgUnit)
    .values({ regionId: regionA, path: 'rda.svc', code: 'rda-svc', displayName: 'Svc', unitType: 'bu', isCostOwningUnit: true })
    .returning()
  ouA = ou!.id

  const [admin] = await t.db
    .insert(schema.teammate)
    .values({ entraOid: 'oid-rd-admin', email: 'rd-admin@x.test', role: 'admin', regionId: regionA, orgUnitId: ouA })
    .returning()
  adminAId = admin!.id

  const [platform] = await t.db
    .insert(schema.teammate)
    .values({ entraOid: 'oid-rd-platform', email: 'rd-platform@x.test', role: 'platform-admin', regionId: regionA, orgUnitId: ouA })
    .returning()
  platformId = platform!.id
}, 120_000)

afterAll(async () => {
  await stopTestDb(t)
}, 30_000)

function ev(opts: {
  method: string
  params?: Record<string, string>
  query?: string
  body?: unknown
  session: Session
}) {
  const url = '/x' + (opts.query ? `?${opts.query}` : '')
  const headers: Record<string, string> = { host: 'localhost:3450', origin: 'http://localhost:3450' }
  const e = {
    method: opts.method,
    path: url,
    context: { params: opts.params ?? {} },
    node: {
      req: {
        method: opts.method,
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
  return e as unknown as Parameters<typeof leadersPost>[0]
}

const adminA = (): Session => ({ teammateId: adminAId, email: 'rd-admin@x.test', displayName: 'Admin A', role: 'admin', regionId: regionA, orgPath: 'rda.svc', issuedAt: new Date().toISOString() })
const platformAdmin = (): Session => ({ teammateId: platformId, email: 'rd-platform@x.test', displayName: 'Platform', role: 'platform-admin', regionId: regionA, orgPath: 'rda.svc', issuedAt: new Date().toISOString() })

interface Leader { id: string; leader_oid: string; leader_email: string; kind: string; display_name: string | null }
interface LeadersResp { leaders: Leader[] }

describe('region_leader — add / list / revoke', () => {
  it('adds a leader, lists it active, then soft-revokes it', async () => {
    const created = (await leadersPost(
      ev({
        method: 'POST',
        params: { id: regionA },
        body: { leader_oid: 'oid-leader-1', leader_email: 'Leader.One@x.test', kind: 'region-svp', display_name: 'Leader One' },
        session: platformAdmin(),
      }),
    )) as Leader
    expect(created.leader_oid).toBe('oid-leader-1')
    // email is normalised to lower-case on store.
    expect(created.leader_email).toBe('leader.one@x.test')

    const listed = (await leadersGet(
      ev({ method: 'GET', params: { id: regionA }, session: adminA() }),
    )) as LeadersResp
    expect(listed.leaders.map((l) => l.leader_oid)).toContain('oid-leader-1')

    const revoked = (await leaderDelete(
      ev({ method: 'DELETE', params: { id: regionA, leaderId: created.id }, session: platformAdmin() }),
    )) as { revoked: boolean }
    expect(revoked.revoked).toBe(true)

    // Gone from the active list.
    const after = (await leadersGet(
      ev({ method: 'GET', params: { id: regionA }, session: adminA() }),
    )) as LeadersResp
    expect(after.leaders.find((l) => l.id === created.id)).toBeUndefined()

    // The audit trail recorded both the assign and the revoke.
    const audit = await t.client<{ event_type: string }[]>`
      SELECT event_type FROM audit_event WHERE event_type IN ('region-leader-assigned','region-leader-revoked')`
    const types = audit.map((a) => a.event_type)
    expect(types).toContain('region-leader-assigned')
    expect(types).toContain('region-leader-revoked')
  })

  it('409s on a duplicate ACTIVE leader oid (partial-unique)', async () => {
    await leadersPost(
      ev({
        method: 'POST',
        params: { id: regionA },
        body: { leader_oid: 'oid-dup', leader_email: 'dup@x.test', kind: 'region-svp' },
        session: platformAdmin(),
      }),
    )
    await expect(
      leadersPost(
        ev({
          method: 'POST',
          params: { id: regionB },
          body: { leader_oid: 'oid-dup', leader_email: 'dup2@x.test', kind: 'region-svp' },
          session: platformAdmin(),
        }),
      ),
    ).rejects.toMatchObject({ statusCode: 409 })
  })

  it('a region admin cannot assign or revoke leaders, even in their own region (403)', async () => {
    await expect(
      leadersPost(
        ev({
          method: 'POST',
          params: { id: regionA },
          body: { leader_oid: 'oid-own-region', leader_email: 'own@x.test', kind: 'region-svp' },
          session: adminA(),
        }),
      ),
    ).rejects.toMatchObject({ statusCode: 403 })
    const [none] = await t.client<{ n: number }[]>`
      SELECT count(*)::int AS n FROM region_leader WHERE leader_oid = 'oid-own-region'`
    expect(none!.n).toBe(0)

    const created = (await leadersPost(
      ev({
        method: 'POST',
        params: { id: regionA },
        body: { leader_oid: 'oid-keep', leader_email: 'keep@x.test', kind: 'region-svp' },
        session: platformAdmin(),
      }),
    )) as Leader
    await expect(
      leaderDelete(ev({ method: 'DELETE', params: { id: regionA, leaderId: created.id }, session: adminA() })),
    ).rejects.toMatchObject({ statusCode: 403 })
    const [still] = await t.client<{ revoked_at: Date | null }[]>`
      SELECT revoked_at FROM region_leader WHERE id = ${created.id}::uuid`
    expect(still!.revoked_at).toBeNull()

    await expect(
      leadersGet(ev({ method: 'GET', params: { id: regionB }, session: adminA() })),
    ).rejects.toMatchObject({ statusCode: 403 })
  })

  it('re-assigning the same oid after revoke is allowed (a fresh active row)', async () => {
    const first = (await leadersPost(
      ev({
        method: 'POST',
        params: { id: regionA },
        body: { leader_oid: 'oid-reassign', leader_email: 'r@x.test', kind: 'region-svp' },
        session: platformAdmin(),
      }),
    )) as Leader
    await leaderDelete(ev({ method: 'DELETE', params: { id: regionA, leaderId: first.id }, session: platformAdmin() }))
    const second = (await leadersPost(
      ev({
        method: 'POST',
        params: { id: regionA },
        body: { leader_oid: 'oid-reassign', leader_email: 'r@x.test', kind: 'region-svp' },
        session: platformAdmin(),
      }),
    )) as Leader
    expect(second.id).not.toBe(first.id)
  })
})

describe('region-delete emptiness — leader / dept-map block the delete (HIGH fix)', () => {
  it('a region with an ACTIVE leader is BLOCKED (409, not a raw 23503)', async () => {
    const [r] = await t.db.insert(schema.region).values({ code: 'rd-leader', displayName: 'RD Leader' }).returning()
    await t.db.insert(schema.regionLeader).values({
      regionId: r!.id,
      leaderOid: 'oid-block',
      leaderEmail: 'block@x.test',
      kind: 'region-svp',
    })
    await expect(
      regionDelete(ev({ method: 'DELETE', params: { id: r!.id }, session: platformAdmin() })),
    ).rejects.toMatchObject({ statusCode: 409 })
  })

  it('a region with a department mapping is BLOCKED (409)', async () => {
    const [r] = await t.db.insert(schema.region).values({ code: 'rd-dept', displayName: 'RD Dept' }).returning()
    await t.db.insert(schema.directoryRegionRule).values({
      attribute: 'department',
      matchMode: 'exact',
      matchValue: 'blocking dept',
      matchValueRaw: 'Blocking Dept',
      regionId: r!.id,
    })
    await expect(
      regionDelete(ev({ method: 'DELETE', params: { id: r!.id }, session: platformAdmin() })),
    ).rejects.toMatchObject({ statusCode: 409 })
  })

  it('a region with a REVOKED leader is still BLOCKED (the row keeps the FK)', async () => {
    const [r] = await t.db.insert(schema.region).values({ code: 'rd-revoked', displayName: 'RD Revoked' }).returning()
    await t.db.insert(schema.regionLeader).values({
      regionId: r!.id,
      leaderOid: 'oid-revoked-block',
      leaderEmail: 'rb@x.test',
      kind: 'region-svp',
      revokedAt: new Date(),
    })
    await expect(
      regionDelete(ev({ method: 'DELETE', params: { id: r!.id }, session: platformAdmin() })),
    ).rejects.toMatchObject({ statusCode: 409 })
  })

  it('a truly empty region still deletes', async () => {
    const [r] = await t.db.insert(schema.region).values({ code: 'rd-empty', displayName: 'RD Empty' }).returning()
    const out = (await regionDelete(
      ev({ method: 'DELETE', params: { id: r!.id }, session: platformAdmin() }),
    )) as { deleted: boolean }
    expect(out.deleted).toBe(true)
  })
})

describe('directory_region_rule — generalised rules API + diagnostic (GLOBAL roles only)', () => {
  it('upsert (companyName) / list / prefix / delete by id', async () => {
    const created = (await rulesPost(
      ev({ method: 'POST', body: { attribute: 'companyName', match_value: 'Insight Australia', region_id: regionA }, session: platformAdmin() }),
    )) as { id: string; attribute: string; match_value: string }
    expect(created.attribute).toBe('companyName')
    expect(created.match_value).toBe('insight australia')

    // re-add (case-insensitive) → re-points, same row id
    const re = (await rulesPost(
      ev({ method: 'POST', body: { attribute: 'companyName', match_value: 'insight australia', region_id: regionA }, session: platformAdmin() }),
    )) as { id: string }
    expect(re.id).toBe(created.id)

    // a prefix rule on a different attribute
    await rulesPost(
      ev({ method: 'POST', body: { attribute: 'officeLocation', match_mode: 'prefix', match_value: 'AU-', region_id: regionA }, session: platformAdmin() }),
    )
    const listed = (await rulesGet(ev({ method: 'GET', session: platformAdmin() }))) as {
      rules: Array<{ id: string; attribute: string; match_mode: string; match_value: string }>
    }
    expect(listed.rules.find((r) => r.attribute === 'officeLocation')?.match_mode).toBe('prefix')
    expect(listed.rules.find((r) => r.attribute === 'companyName')?.match_value).toBe('insight australia')

    const removed = (await ruleDelete(ev({ method: 'DELETE', params: { id: created.id }, session: platformAdmin() }))) as { removed: boolean }
    expect(removed.removed).toBe(true)
  })

  it('rejects an unknown attribute', async () => {
    await expect(
      rulesPost(ev({ method: 'POST', body: { attribute: 'email', match_value: 'x@y', region_id: regionA }, session: platformAdmin() })),
    ).rejects.toMatchObject({ statusCode: 400 })
  })

  it('region admin is FORBIDDEN (403) — cross-region placement config', async () => {
    await expect(rulesGet(ev({ method: 'GET', session: adminA() }))).rejects.toMatchObject({ statusCode: 403 })
  })

  it('field-distribution returns per-attribute coverage (mock directory)', async () => {
    const d = (await fieldDist(ev({ method: 'GET', query: 'sample=50', session: platformAdmin() }))) as {
      sampled: number
      attributes: Array<{ attribute: string; coveragePct: number }>
    }
    expect(d.sampled).toBeGreaterThan(0)
    expect(d.attributes.some((a) => a.attribute === 'companyName')).toBe(true)
  })
})
