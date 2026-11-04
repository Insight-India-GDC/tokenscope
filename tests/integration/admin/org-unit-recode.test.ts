// @vitest-environment node
/*
 * PATCH /api/v1/admin/org-units/:id with `code` — a code change re-paths the unit and its whole
 * subtree in one statement, is refused for the region's `default` unit and holding node, and
 * refuses any code or path another unit (active or retired) already holds
 * (docs/design/org-setup/01-second-run-fixes.md, item 3).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'
import { injectTestSession } from '../../helpers/auth'
import type { Session } from '../../../server/utils/auth'
import handler from '../../../server/api/v1/admin/org-units/[id].patch'
import { HOLDING_UNIT_TYPE, UNPLACED_UNIT_CODE } from '../../../shared/placement/holding-nodes'

let t: TestDb
let regionId = ''
const ids: Record<string, string> = {}
const ADMIN_ID = '9a1e0000-0000-4000-8000-0000000000a1'

function ev(opts: { unitId: string; body: unknown }) {
  const headers: Record<string, string> = { host: 'localhost:3450', origin: 'http://localhost:3450' }
  const e = {
    method: 'PATCH', path: '/x', context: { params: { id: opts.unitId } },
    node: {
      req: { method: 'PATCH', url: '/x', body: opts.body, socket: { remoteAddress: '127.0.0.1' }, get headers() { return { ...headers, 'content-type': 'application/json' } } },
      res: { _headers: {} as Record<string, unknown>, statusCode: 200, getHeader() {}, setHeader() {}, removeHeader() {}, appendHeader() {}, get headersSent() { return false } },
    },
  }
  const session = { teammateId: ADMIN_ID, email: 'rc-admin@x.test', displayName: 'Admin', role: 'admin', regionId, orgPath: 'rc' } as Session
  injectTestSession(e as unknown as Parameters<typeof injectTestSession>[0], session)
  return e as unknown as Parameters<typeof handler>[0]
}

async function row(id: string) {
  const [r] = await t.client<{ code: string; path: string }[]>`SELECT code, path::text AS path FROM org_unit WHERE id = ${id}::uuid`
  return r!
}

beforeAll(async () => {
  t = await startTestDb(); process.env.DATABASE_URL = t.url
  const [r] = await t.client<{ id: string }[]>`INSERT INTO region (code, display_name) VALUES ('rc', 'RC') RETURNING id::text AS id`; regionId = r!.id
  const [rx] = await t.client<{ id: string }[]>`INSERT INTO region (code, display_name) VALUES ('rcx', 'RCX') RETURNING id::text AS id`
  const [ux] = await t.client<{ id: string }[]>`INSERT INTO org_unit (region_id, parent_id, path, code, display_name, unit_type, is_cost_owning_unit) VALUES (${rx!.id}::uuid, NULL, 'rcx'::ltree, 'admin-home', 'Admin Home', 'bu', false) RETURNING id::text AS id`
  await t.client`INSERT INTO teammate (id, entra_oid, email, display_name, region_id, org_unit_id, role) VALUES (${ADMIN_ID}::uuid, 'oid-rc-admin', 'rc-admin@x.test', 'Admin', ${rx!.id}::uuid, ${ux!.id}::uuid, 'admin')`
}, 180_000)
afterAll(async () => { if (t) await stopTestDb(t) }, 30_000)

beforeEach(async () => {
  await t.client`DELETE FROM org_unit WHERE region_id = ${regionId}::uuid`
  // default → eng → platform → sre ;  default → old-thing (retired) ;  holding node
  const mk = async (parent: string | null, p: string, code: string, opts: { type?: string; retired?: boolean } = {}) => {
    const [r] = await t.client<{ id: string }[]>`
      INSERT INTO org_unit (region_id, parent_id, path, code, display_name, unit_type, is_cost_owning_unit, retired_at)
      VALUES (${regionId}::uuid, ${parent}::uuid, ${p}::ltree, ${code}, ${code}, ${opts.type ?? 'bu'}, false,
              CASE WHEN ${opts.retired ?? false} THEN now() END)
      RETURNING id::text AS id`
    ids[code] = r!.id
  }
  await mk(null, 'rc', 'default')
  await mk(null, 'rc_unplaced', UNPLACED_UNIT_CODE, { type: HOLDING_UNIT_TYPE })
  await mk(ids.default!, 'rc.eng', 'eng')
  await mk(ids.eng!, 'rc.eng.platform', 'platform')
  await mk(ids.platform!, 'rc.eng.platform.sre', 'sre')
  await mk(ids.default!, 'rc.old_thing', 'old-thing', { retired: true })
})

describe('org-unit code change (PATCH code)', () => {
  it('lets only one of two concurrent changes to codes that fold to the same path through', async () => {
    const [ops] = await t.client<{ id: string }[]>`
      INSERT INTO org_unit (region_id, parent_id, path, code, display_name, unit_type, is_cost_owning_unit)
      VALUES (${regionId}::uuid, ${ids.default!}::uuid, 'rc.ops', 'ops', 'ops', 'bu', false) RETURNING id::text AS id`
    const results = await Promise.allSettled([
      handler(ev({ unitId: ids.eng!, body: { code: 'a-b' } })),
      handler(ev({ unitId: ops!.id, body: { code: 'a_b' } })),
    ])
    expect(results.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected'])
    const rejected = results.find((r) => r.status === 'rejected') as PromiseRejectedResult
    expect((rejected.reason as { statusCode?: number }).statusCode).toBe(409)
    const [{ n }] = await t.client<{ n: number }[]>`
      SELECT count(*)::int AS n FROM org_unit WHERE region_id = ${regionId}::uuid AND path = 'rc.a_b'`
    expect(n).toBe(1)
  })

  it('changes the code and re-paths the unit and its whole subtree, recording old and new in the audit row', async () => {
    const res = (await handler(ev({ unitId: ids.eng!, body: { code: 'Engineering' } }))) as { code: string }
    expect(res.code).toBe('Engineering')
    expect(await row(ids.eng!)).toEqual({ code: 'Engineering', path: 'rc.engineering' })
    expect((await row(ids.platform!)).path).toBe('rc.engineering.platform')
    expect((await row(ids.sre!)).path).toBe('rc.engineering.platform.sre')
    expect((await row(ids.default!)).path).toBe('rc')

    const [audit] = await t.client<{ payload: { code: string; changes: Record<string, { from: unknown; to: unknown }> } }[]>`
      SELECT payload::jsonb AS payload FROM audit_event
      WHERE event_type = 'org-unit-updated' AND subject_id = ${ids.eng!}::uuid ORDER BY ts_recorded DESC LIMIT 1`
    expect(audit!.payload.changes.code).toEqual({ from: 'eng', to: 'Engineering' })
    expect(audit!.payload.changes.path).toEqual({ from: 'rc.eng', to: 'rc.engineering' })
  })

  it('the same code is not a change', async () => {
    await handler(ev({ unitId: ids.eng!, body: { code: 'eng', display_name: 'Eng' } }))
    expect(await row(ids.eng!)).toEqual({ code: 'eng', path: 'rc.eng' })
  })

  it('409s a code another unit in the region already has', async () => {
    await expect(handler(ev({ unitId: ids.platform!, body: { code: 'sre' } }))).rejects.toMatchObject({ statusCode: 409 })
    expect(await row(ids.platform!)).toEqual({ code: 'platform', path: 'rc.eng.platform' })
  })

  it('409s a code whose path a RETIRED unit already holds', async () => {
    // 'old_thing' folds to the label the retired 'old-thing' holds.
    await expect(handler(ev({ unitId: ids.eng!, body: { code: 'old_thing' } }))).rejects.toMatchObject({ statusCode: 409 })
    expect(await row(ids.eng!)).toEqual({ code: 'eng', path: 'rc.eng' })
  })

  it("refuses changing the default unit's or the holding node's code", async () => {
    await expect(handler(ev({ unitId: ids.default!, body: { code: 'root' } }))).rejects.toMatchObject({ statusCode: 422 })
    await expect(handler(ev({ unitId: ids[UNPLACED_UNIT_CODE]!, body: { code: 'unplaced' } }))).rejects.toMatchObject({ statusCode: 422 })
    expect((await row(ids.default!)).code).toBe('default')
    expect((await row(ids[UNPLACED_UNIT_CODE]!)).code).toBe(UNPLACED_UNIT_CODE)
  })

  it("refuses a unit taking 'default' (409) or the holding code (400)", async () => {
    await expect(handler(ev({ unitId: ids.eng!, body: { code: 'default' } }))).rejects.toMatchObject({ statusCode: 409, statusMessage: "Org unit code 'default' is reserved" })
    await expect(handler(ev({ unitId: ids.eng!, body: { code: UNPLACED_UNIT_CODE } }))).rejects.toMatchObject({ statusCode: 400 })
    expect(await row(ids.eng!)).toEqual({ code: 'eng', path: 'rc.eng' })
  })
})
