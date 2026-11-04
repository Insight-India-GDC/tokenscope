// @vitest-environment node
/*
 * POST /api/v1/admin/org-units/:id/move — within-region reparent. Validates the ltree subtree
 * re-path (root + descendants), the cycle + cross-region guards, and no-op. There is no top level
 * to move to, and the region's `default` unit and holding node stay where they are
 * (docs/design/org-setup/01-second-run-fixes.md, item 1).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'
import { injectTestSession } from '../../helpers/auth'
import type { Session } from '../../../server/utils/auth'
import handler from '../../../server/api/v1/admin/org-units/[id]/move.post'
import { HOLDING_UNIT_TYPE, UNPLACED_UNIT_CODE } from '../../../shared/placement/holding-nodes'

let t: TestDb
let regionId = ''
let region2Id = ''
const ids: Record<string, string> = {}

function ev(opts: { session: Session; unitId: string; body: unknown }) {
  const headers: Record<string, string> = { host: 'localhost:3450', origin: 'http://localhost:3450' }
  const e = {
    method: 'POST', path: '/x', context: { params: { id: opts.unitId } },
    node: {
      req: { method: 'POST', url: '/x', body: opts.body, socket: { remoteAddress: '127.0.0.1' }, get headers() { return { ...headers, 'content-type': 'application/json' } } },
      res: { _headers: {} as Record<string, unknown>, statusCode: 200, getHeader() {}, setHeader() {}, removeHeader() {}, appendHeader() {}, get headersSent() { return false } },
    },
  }
  injectTestSession(e as unknown as Parameters<typeof injectTestSession>[0], opts.session)
  return e as unknown as Parameters<typeof handler>[0]
}
const admin = (): Session => ({ teammateId: '00000000-0000-0000-0000-000000000001', email: 'mv-admin@x.test', displayName: 'Admin', role: 'admin', regionId, orgPath: 'mv' } as Session)

async function path(code: string): Promise<string> {
  const [r] = await t.client<{ path: string }[]>`SELECT path::text AS path FROM org_unit WHERE id = ${ids[code]}::uuid`
  return r!.path
}
async function parentOf(code: string): Promise<string | null> {
  const [r] = await t.client<{ p: string | null }[]>`SELECT parent_id::text AS p FROM org_unit WHERE id = ${ids[code]}::uuid`
  return r!.p
}

const ADMIN_ID = '00000000-0000-0000-0000-000000000001'

beforeAll(async () => {
  t = await startTestDb(); process.env.DATABASE_URL = t.url
  const [r] = await t.client<{ id: string }[]>`INSERT INTO region (code, display_name) VALUES ('mv', 'MV') RETURNING id::text AS id`; regionId = r!.id
  const [r2] = await t.client<{ id: string }[]>`INSERT INTO region (code, display_name) VALUES ('mv2', 'MV2') RETURNING id::text AS id`; region2Id = r2!.id
  // The actor teammate must exist (audit FK). Home it in a persistent region/unit beforeEach never wipes.
  const [rx] = await t.client<{ id: string }[]>`INSERT INTO region (code, display_name) VALUES ('mvx', 'MVX') RETURNING id::text AS id`
  const [ux] = await t.client<{ id: string }[]>`INSERT INTO org_unit (region_id, parent_id, path, code, display_name, unit_type, is_cost_owning_unit) VALUES (${rx!.id}::uuid, NULL, 'mvx'::ltree, 'admin-home', 'Admin Home', 'bu', false) RETURNING id::text AS id`
  await t.client`INSERT INTO teammate (id, entra_oid, email, display_name, region_id, org_unit_id, role) VALUES (${ADMIN_ID}::uuid, 'oid-mv-admin', 'mv-admin@x.test', 'Admin', ${rx!.id}::uuid, ${ux!.id}::uuid, 'admin')`
}, 180_000)
afterAll(async () => { if (t) await stopTestDb(t) }, 30_000)

beforeEach(async () => {
  await t.client`DELETE FROM org_unit WHERE region_id IN (${regionId}::uuid, ${region2Id}::uuid)`
  // mv:  bu-a → prac-1 → sub-1 ;  bu-b           |  mv2: other
  const mk = async (region: string, parent: string | null, p: string, code: string, cou = false, type = 'bu') => {
    const [row] = await t.client<{ id: string }[]>`
      INSERT INTO org_unit (region_id, parent_id, path, code, display_name, unit_type, is_cost_owning_unit)
      VALUES (${region}::uuid, ${parent}::uuid, ${p}::ltree, ${code}, ${code}, ${type}, ${cou}) RETURNING id::text AS id`
    ids[code] = row!.id
  }
  await mk(regionId, null, 'mv', 'default', true)
  await mk(regionId, null, 'mv_unplaced', UNPLACED_UNIT_CODE, false, HOLDING_UNIT_TYPE)
  await mk(regionId, ids[UNPLACED_UNIT_CODE] ?? null, 'mv_unplaced.stray', 'stray')
  await mk(regionId, null, 'mv.bu_a', 'bu-a')
  await mk(regionId, ids['bu-a'] ?? null, 'mv.bu_a.prac_1', 'prac-1', true)
  await mk(regionId, ids['prac-1'] ?? null, 'mv.bu_a.prac_1.sub_1', 'sub-1', true)
  await mk(regionId, null, 'mv.bu_b', 'bu-b')
  await mk(region2Id, null, 'mv2.other', 'other')
})

describe('org-unit move (within-region reparent)', () => {
  it('reparents a unit AND re-paths its whole subtree, repointing parent_id', async () => {
    const res = (await handler(ev({ session: admin(), unitId: ids['prac-1']!, body: { new_parent_id: ids['bu-b'] } }))) as { moved: boolean; path: string }
    expect(res.moved).toBe(true)
    expect(res.path).toBe('mv.bu_b.prac_1')
    expect(await path('prac-1')).toBe('mv.bu_b.prac_1')
    expect(await path('sub-1')).toBe('mv.bu_b.prac_1.sub_1') // descendant followed
    expect(await parentOf('prac-1')).toBe(ids['bu-b']) // root repointed
    expect(await parentOf('sub-1')).toBe(ids['prac-1']) // descendant parent unchanged
    expect(await path('bu-a')).toBe('mv.bu_a') // the old parent's own path is untouched
  })

  it('REFUSES a move to the top level (new_parent_id null) — even for a unit already at the top (400)', async () => {
    await expect(
      handler(ev({ session: admin(), unitId: ids['prac-1']!, body: { new_parent_id: null } })),
    ).rejects.toMatchObject({ statusCode: 400 })
    await expect(
      handler(ev({ session: admin(), unitId: ids['bu-b']!, body: { new_parent_id: null } })),
    ).rejects.toMatchObject({ statusCode: 400 })
    expect(await parentOf('prac-1')).toBe(ids['bu-a'])
  })

  it("moves a stray top-level unit under the region's default unit", async () => {
    await handler(ev({ session: admin(), unitId: ids['bu-a']!, body: { new_parent_id: ids['default'] } }))
    expect(await parentOf('bu-a')).toBe(ids['default'])
    expect(await path('bu-a')).toBe('mv.bu_a')
    expect(await path('sub-1')).toBe('mv.bu_a.prac_1.sub_1')
  })

  it("REFUSES moving the region's default unit or its holding node (400)", async () => {
    // A destination outside default's subtree, so the cycle guard cannot be what refuses it.
    const [outside] = await t.client<{ id: string }[]>`
      INSERT INTO org_unit (region_id, parent_id, path, code, display_name, unit_type, is_cost_owning_unit)
      VALUES (${regionId}::uuid, NULL, 'mv_outside'::ltree, 'outside', 'Outside', 'bu', false) RETURNING id::text AS id`
    await expect(
      handler(ev({ session: admin(), unitId: ids['default']!, body: { new_parent_id: outside!.id } })),
    ).rejects.toMatchObject({ statusCode: 400 })
    await expect(
      handler(ev({ session: admin(), unitId: ids[UNPLACED_UNIT_CODE]!, body: { new_parent_id: ids['default'] } })),
    ).rejects.toMatchObject({ statusCode: 400 })
    expect(await parentOf('default')).toBeNull()
    expect(await parentOf(UNPLACED_UNIT_CODE)).toBeNull()
  })

  it('REFUSES a destination at or under the holding node (400)', async () => {
    for (const dest of [UNPLACED_UNIT_CODE, 'stray']) {
      await expect(
        handler(ev({ session: admin(), unitId: ids['prac-1']!, body: { new_parent_id: ids[dest] } })),
      ).rejects.toMatchObject({ statusCode: 400 })
    }
    expect(await path('prac-1')).toBe('mv.bu_a.prac_1')
  })

  it('REJECTS a cycle — moving a unit under its own descendant (400)', async () => {
    await expect(
      handler(ev({ session: admin(), unitId: ids['bu-a']!, body: { new_parent_id: ids['sub-1'] } })),
    ).rejects.toMatchObject({ statusCode: 400 })
  })

  it('REJECTS a cross-region move (400)', async () => {
    await expect(
      handler(ev({ session: admin(), unitId: ids['prac-1']!, body: { new_parent_id: ids['other'] } })),
    ).rejects.toMatchObject({ statusCode: 400 })
  })

  it('404s an unknown unit', async () => {
    await expect(
      handler(ev({ session: admin(), unitId: '00000000-0000-4000-8000-000000000099', body: { new_parent_id: ids['bu-b'] } })),
    ).rejects.toMatchObject({ statusCode: 404 })
  })

  it('REJECTS a move that would COLLIDE on the destination path (distinct codes, same ltree label) → 409', async () => {
    // bu-b already has a child whose code 'prac_1' folds to the SAME ltree label as 'prac-1'.
    await t.client`INSERT INTO org_unit (region_id, parent_id, path, code, display_name, unit_type, is_cost_owning_unit)
      VALUES (${regionId}::uuid, ${ids['bu-b']}::uuid, 'mv.bu_b.prac_1'::ltree, 'prac_1', 'Collider', 'bu', false)`
    await expect(
      handler(ev({ session: admin(), unitId: ids['prac-1']!, body: { new_parent_id: ids['bu-b'] } })),
    ).rejects.toMatchObject({ statusCode: 409 })
    expect(await path('prac-1')).toBe('mv.bu_a.prac_1') // unmoved — no partial corruption
  })

  it('REJECTS a collision even with a RETIRED occupant at the destination (retire is path-soft) → 409', async () => {
    await t.client`INSERT INTO org_unit (region_id, parent_id, path, code, display_name, unit_type, is_cost_owning_unit, retired_at)
      VALUES (${regionId}::uuid, ${ids['bu-b']}::uuid, 'mv.bu_b.prac_1'::ltree, 'prac_1', 'Retired Collider', 'bu', false, now())`
    await expect(
      handler(ev({ session: admin(), unitId: ids['prac-1']!, body: { new_parent_id: ids['bu-b'] } })),
    ).rejects.toMatchObject({ statusCode: 409 })
  })

  it('a region-scoped move does NOT touch a same-path unit in ANOTHER region (clamp is load-bearing)', async () => {
    // region 2 carries a unit whose path equals region-1 prac-1's OLD path.
    await t.client`INSERT INTO org_unit (region_id, parent_id, path, code, display_name, unit_type, is_cost_owning_unit)
      VALUES (${region2Id}::uuid, NULL, 'mv.bu_a.prac_1'::ltree, 'r2-collider', 'R2', 'bu', false)`
    await handler(ev({ session: admin(), unitId: ids['prac-1']!, body: { new_parent_id: ids['bu-b'] } }))
    const [r2] = await t.client<{ path: string }[]>`SELECT path::text AS path FROM org_unit WHERE region_id=${region2Id}::uuid AND code='r2-collider'`
    expect(r2!.path).toBe('mv.bu_a.prac_1') // untouched by the region-1 UPDATE
  })

  it('is a no-op when already under the requested parent', async () => {
    const res = (await handler(ev({ session: admin(), unitId: ids['prac-1']!, body: { new_parent_id: ids['bu-a'] } }))) as { moved: boolean }
    expect(res.moved).toBe(false)
    expect(await path('prac-1')).toBe('mv.bu_a.prac_1') // unchanged
  })
})
