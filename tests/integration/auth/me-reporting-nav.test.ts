// @vitest-environment node
/*
 * GET /api/v1/auth/me — the Reporting nav VERDICT.
 *
 * This field replaced two blocking header fetches whose results the browser
 * OR-ed together (`/me/cost-centres?count=1` + `/reports/meta`). Moving an
 * authorization decision from the client to the server is only safe if the
 * verdict is IDENTICAL, so this pins the whole matrix rather than the happy
 * path — every arm that could open the Reporting entry, and the one that must
 * not.
 *
 * The old expression, preserved verbatim in server/auth/nav-visibility.ts:
 *
 *     visible = reportingRole || isOwner || isGranted
 *     scope   = (!reportingRole && isOwner) ? 'cost-centre' : null
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'
import { injectTestSession } from '../../helpers/auth'
import type { Session } from '../../../server/utils/auth'
import handler from '../../../server/api/v1/auth/me.get'
import { resolveReportingNav } from '../../../server/auth/nav-visibility'

let t: TestDb
let regionId = ''
let couId = ''
let plainCouId = ''
let ownerId = ''
let strangerId = ''
let grantedId = ''

const ev = (session: Session) => {
  const headers: Record<string, string> = { host: 'localhost:3450' }
  const e = {
    method: 'GET',
    path: '/x',
    context: { params: {} },
    node: {
      req: {
        method: 'GET',
        url: '/x',
        socket: { remoteAddress: '127.0.0.1' },
        get headers() {
          return { ...headers }
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
  injectTestSession(e as unknown as Parameters<typeof injectTestSession>[0], session)
  return e as unknown as Parameters<typeof handler>[0]
}

const sessionFor = (teammateId: string, role: string, email: string): Session =>
  ({
    teammateId,
    email,
    displayName: email,
    role,
    regionId,
    orgPath: 'n',
    issuedAt: new Date().toISOString(),
  }) as unknown as Session

interface MeResp {
  authenticated: boolean
  reporting?: { visible: boolean; scope: 'cost-centre' | null }
}
const call = async (s: Session) => (await handler(ev(s))) as unknown as MeResp

beforeAll(async () => {
  t = await startTestDb()
  // The handler opens its OWN connection through withRequestRls → getDb(),
  // which reads this — `t.client` alone is not enough to serve a route test.
  process.env.DATABASE_URL = t.url

  await t.client`INSERT INTO region (code, display_name) VALUES ('rn', 'Region N')`
  ;[{ id: regionId }] = await t.client<
    { id: string }[]
  >`SELECT id::text AS id FROM region WHERE code='rn'`

  const mkUnit = async (path: string, code: string, owning: boolean) => {
    await t.client`INSERT INTO org_unit (region_id, path, code, display_name, unit_type, is_cost_owning_unit)
      VALUES (${regionId}::uuid, ${path}::ltree, ${code}, ${code}, 'bu', ${owning})`
    const [r] = await t.client<
      { id: string }[]
    >`SELECT id::text AS id FROM org_unit WHERE code=${code}`
    return r!.id
  }
  couId = await mkUnit('n', 'n', true)
  // A Business Unit that does not own cost, so a teammate can be HOMED without that alone
  // implying ownership — ownership is a cou_owner row, never a placement.
  plainCouId = await mkUnit('n.sub', 'nsub', false)

  const mkTeammate = async (email: string) => {
    await t.client`INSERT INTO teammate (entra_oid, email, display_name, region_id, org_unit_id, is_active)
      VALUES ('oid-'||${email}, ${email}, ${email}, ${regionId}::uuid, ${plainCouId}::uuid, true)`
    const [r] = await t.client<
      { id: string }[]
    >`SELECT id::text AS id FROM teammate WHERE email=${email}`
    return r!.id
  }
  ownerId = await mkTeammate('owner@n.test')
  strangerId = await mkTeammate('stranger@n.test')
  grantedId = await mkTeammate('granted@n.test')

  await t.client`INSERT INTO cou_owner (org_unit_id, teammate_id) VALUES (${couId}::uuid, ${ownerId}::uuid)`

  /*
   * Asserted ONCE, here, rather than guarded per-test. The grant cases below
   * used to `return` when this table was absent — which meant three of them
   * passed with ZERO assertions if the grant surface ever went away, silently
   * certifying the arm they exist to protect. A missing table is a broken
   * fixture, so it fails setup instead.
   */
  const [{ present }] = await t.client<{ present: boolean }[]>`
    SELECT to_regclass('report_access_grant') IS NOT NULL AS present`
  if (!present) throw new Error('report_access_grant is missing — the grant arm cannot be tested')
}, 180_000)

afterAll(async () => {
  await stopTestDb(t)
})

describe('GET /auth/me — reporting nav verdict', () => {
  it('a plain developer with no ownership and no grant does NOT get the entry', async () => {
    const r = await call(sessionFor(strangerId, 'developer', 'stranger@n.test'))
    expect(r.authenticated).toBe(true)
    expect(r.reporting).toEqual({ visible: false, scope: null })
  })

  it('a Business-Unit OWNER gets the entry, deep-linked to their P&L', async () => {
    const r = await call(sessionFor(ownerId, 'developer', 'owner@n.test'))
    expect(r.reporting).toEqual({ visible: true, scope: 'cost-centre' })
  })

  it('a reporting ROLE gets the entry with NO deep-link', async () => {
    // A teammate id that does not exist, so the verdict cannot be coming from
    // ownership or grants. (This does NOT prove no query ran — a nonexistent id
    // simply returns empty rows. The no-DB-read claim is proven directly, with
    // a poisoned transaction, in the resolver test below.)
    const ghost = '9a1e0000-0000-4000-8000-00000000beef'
    for (const role of ['manager', 'admin', 'platform-admin']) {
      const r = await call(sessionFor(ghost, role, `${role}@n.test`))
      expect(r.reporting, role).toEqual({ visible: true, scope: null })
    }
  })

  it('a reporting role touches the database ZERO times — proven, not assumed', async () => {
    /*
     * The earlier version of this asserted "pays no DB read" using a nonexistent
     * teammate id, which proves nothing: the reads would simply have returned no
     * rows and the test stayed green either way. A poisoned transaction is the
     * actual proof — any query at all throws.
     */
    const poisoned = {
      execute: () => {
        throw new Error('resolveReportingNav queried the database on the role fast path')
      },
    } as unknown as Parameters<typeof resolveReportingNav>[1]

    for (const role of ['manager', 'admin', 'platform-admin']) {
      const verdict = await resolveReportingNav(
        ev(sessionFor(ownerId, role, 'x@n.test')) as never,
        poisoned,
        ownerId,
        role,
      )
      expect(verdict, role).toEqual({ visible: true, scope: null })
    }
    // ...and the same transaction DOES get used for a non-reporting role, so the
    // poison is real rather than an unused argument.
    await expect(
      resolveReportingNav(
        ev(sessionFor(ownerId, 'developer', 'x@n.test')) as never,
        poisoned,
        ownerId,
        'developer',
      ),
    ).rejects.toThrow(/queried the database/)
  })

  it('a developer holding only a report-access GRANT gets the entry, undeep-linked', async () => {
    await t.client`INSERT INTO report_access_grant (teammate_id, permission)
      VALUES (${grantedId}::uuid, 'operational')`
    const r = await call(sessionFor(grantedId, 'developer', 'granted@n.test'))
    // Granted but NOT an owner: entry appears, and the shell self-lands.
    expect(r.reporting).toEqual({ visible: true, scope: null })
  })

  it('ownership of a RETIRED unit is not ownership', async () => {
    await t.client`UPDATE org_unit SET retired_at = now() WHERE id = ${couId}::uuid`
    try {
      const r = await call(sessionFor(ownerId, 'developer', 'owner@n.test'))
      expect(r.reporting).toEqual({ visible: false, scope: null })
    } finally {
      await t.client`UPDATE org_unit SET retired_at = NULL WHERE id = ${couId}::uuid`
    }
  })
})
