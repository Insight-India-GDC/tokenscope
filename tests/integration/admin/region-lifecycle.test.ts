// @vitest-environment node
/*
 * Admin region/org-unit/project/teammate lifecycle endpoints (admin-region-
 * lifecycle). Real DB via testcontainers + the actual handlers, called
 * directly (the sessions-assign.test.ts pattern: ev() builds an h3-shaped
 * event with injected session + same-origin headers so assertSameOrigin
 * passes, then handler(ev(...)) runs against withRequestRls).
 *
 * Coverage (per brief):
 *   1. Region create — platform-admin 200; region admin/platform-admin 403;
 *      duplicate code 409.
 *   2. Region delete — 409 when non-empty; 200 when empty; platform-admin only.
 *   3. Org-unit create — root path = label; child path = parent.label;
 *      duplicate code 409; cross-region admin 403.
 *   4. Org-unit retire — 409 with active child / project / active teammate;
 *      200 (retired_at set) when empty.
 *   5. Project edit — display_name 200; COU in other region / retired → 422;
 *      cross-region admin 403.
 *   6. Provision teammate — admin provisions mock oid 200; region admin
 *      granting platform-admin 403; re-provision 409; unknown oid 404;
 *      cross-region admin 403.
 *   7. User org-unit placement — active in-region 200; retired/other-region 422.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { sql } from 'drizzle-orm'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'
import * as schema from '../../../drizzle/schema'
import { injectTestSession } from '../../helpers/auth'
import type { Session } from '../../../server/utils/auth'

import regionsCreate from '../../../server/api/v1/admin/regions.post'
import regionDelete from '../../../server/api/v1/admin/regions/[id].delete'
import orgUnitsCreate from '../../../server/api/v1/admin/org-units.post'
import orgUnitDelete from '../../../server/api/v1/admin/org-units/[id].delete'
import projectPatch from '../../../server/api/v1/admin/projects/[id].patch'
import teammatesCreate from '../../../server/api/v1/admin/teammates.post'
import userOrgUnitPatch from '../../../server/api/v1/admin/users/[id]/org-unit.patch'

let t: TestDb
// Region A (the admin's home region) and region B (cross-region foil).
let regionAId: string
let regionACode: string
let ouAId: string // root cost-owning unit in A
let regionBId: string
let ouBId: string // a unit in B
let projAId: string

beforeAll(async () => {
  t = await startTestDb()
  process.env.DATABASE_URL = t.url
  process.env.NUXT_SESSION_SECRET = 'rlc-test-padded-to-thirty-two-characters'
  process.env.NUXT_HMAC_SESSION_KEY = 'rlc-test-hmac-key-padded-well-beyond-32-chars'

  const [ra] = await t.db.insert(schema.region).values({ code: 'rlc-a', displayName: 'Region A' }).returning()
  regionAId = ra!.id
  regionACode = ra!.code
  const [oa] = await t.db
    .insert(schema.orgUnit)
    .values({ regionId: regionAId, path: 'a.svc', code: 'a-svc', displayName: 'A Svc', unitType: 'bu', isCostOwningUnit: true })
    .returning()
  ouAId = oa!.id

  const [rb] = await t.db.insert(schema.region).values({ code: 'rlc-b', displayName: 'Region B' }).returning()
  regionBId = rb!.id
  const [ob] = await t.db
    .insert(schema.orgUnit)
    .values({ regionId: regionBId, path: 'b.svc', code: 'b-svc', displayName: 'B Svc', unitType: 'bu', isCostOwningUnit: true })
    .returning()
  ouBId = ob!.id

  const [pa] = await t.db
    .insert(schema.project)
    .values({ code: 'RLC-P', codeHash: 'h-rlc-p', displayName: 'Proj A', type: 'billable', regionId: regionAId, costOwningUnitId: ouAId })
    .returning()
  projAId = pa!.id

  // The handlers now stamp recordAuditEvent.actorTeammateId = caller.teammateId,
  // and audit_event.actor_teammate_id FKs onto teammate.id. The synthetic caller
  // sessions below carry fixed teammate ids — insert matching teammate rows so the
  // FK is satisfied (in production the caller is always a real teammate).
  await t.db.insert(schema.teammate).values([
    { id: '00000000-0000-4000-8000-000000000001', entraOid: 'rlc-oid-pa', email: 'pa@example.com', displayName: 'PA', role: 'platform-admin', regionId: regionAId, orgUnitId: ouAId },
    { id: '00000000-0000-4000-8000-000000000002', entraOid: 'rlc-oid-admin-a', email: 'admin-a@example.com', displayName: 'Admin A', role: 'admin', regionId: regionAId, orgUnitId: ouAId },
    { id: '00000000-0000-4000-8000-000000000003', entraOid: 'rlc-oid-gf', email: 'gf@example.com', displayName: 'GF', role: 'platform-admin', regionId: regionAId, orgUnitId: ouAId },
    { id: '00000000-0000-4000-8000-000000000009', entraOid: 'rlc-oid-admin-b', email: 'admin-b@example.com', displayName: 'Admin B', role: 'admin', regionId: regionBId, orgUnitId: ouBId },
  ])
}, 60_000)

afterAll(async () => {
  await stopTestDb(t)
}, 30_000)

type AnyHandler = (e: unknown) => Promise<unknown>

function ev(opts: { params?: Record<string, string>; body?: unknown; session: Session }) {
  const headers: Record<string, string> = { host: 'localhost:3450', origin: 'http://localhost:3450' }
  const e = {
    method: 'POST',
    path: '/x',
    context: { params: opts.params ?? {} },
    node: {
      req: {
        method: 'POST',
        url: '/x',
        body: opts.body,
        // getRequestIP(event, { xForwardedFor: true }) reads req.socket.
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

// Session builders. issuedAt is required by the Session type but the handlers
// under test never read it (matching sessions-assign.test.ts, which omits it
// and casts at the call site).
const platformAdmin = (): Session =>
  ({ teammateId: '00000000-0000-4000-8000-000000000001', email: 'pa@example.com', displayName: 'PA', role: 'platform-admin', regionId: regionAId, orgPath: 'a.svc' }) as Session
const adminA = (): Session =>
  ({ teammateId: '00000000-0000-4000-8000-000000000002', email: 'admin-a@example.com', displayName: 'Admin A', role: 'admin', regionId: regionAId, orgPath: 'a.svc' }) as Session

async function call<R = unknown>(h: unknown, e: unknown): Promise<R> {
  return (h as AnyHandler)(e) as Promise<R>
}

describe('1. region create', () => {
  it('platform-admin creates a region (200, returns id + code)', async () => {
    const out = await call<{ id: string; code: string }>(
      regionsCreate,
      ev({ body: { code: 'rlc-new', display_name: 'Brand New' }, session: platformAdmin() }),
    )
    expect(out.id).toMatch(/^[0-9a-f-]{36}$/)
    expect(out.code).toBe('rlc-new')
  })

  it('auto-lowercases a mixed-case code ("GlobalIT" → "globalit") instead of rejecting it', async () => {
    const out = await call<{ code: string }>(
      regionsCreate,
      ev({ body: { code: 'GlobalIT', display_name: 'Global IT' }, session: platformAdmin() }),
    )
    expect(out.code).toBe('globalit')
  })

  it('a genuinely invalid code returns a DESCRIPTIVE 400 (names the field + rule, not bare "Validation Error")', async () => {
    await expect(
      call(regionsCreate, ev({ body: { code: 'a b!', display_name: 'X' }, session: platformAdmin() })),
    ).rejects.toMatchObject({
      statusCode: 400,
      data: { detail: expect.stringContaining('lowercase letters, numbers and hyphens') },
    })
  })

  it('region admin is refused (403)', async () => {
    await expect(
      call(regionsCreate, ev({ body: { code: 'rlc-x', display_name: 'X' }, session: adminA() })),
    ).rejects.toMatchObject({ statusCode: 403 })
  })


  it('duplicate code → 409', async () => {
    await expect(
      call(regionsCreate, ev({ body: { code: regionACode, display_name: 'Dup' }, session: platformAdmin() })),
    ).rejects.toMatchObject({ statusCode: 409 })
  })
})

describe('2. region delete', () => {
  it('refuses a non-empty region (409)', async () => {
    // regionAId has an org_unit + project.
    await expect(
      call(regionDelete, ev({ params: { id: regionAId }, session: platformAdmin() })),
    ).rejects.toMatchObject({ statusCode: 409 })
  })

  it('deletes an empty region (200)', async () => {
    const [empty] = await t.db.insert(schema.region).values({ code: 'rlc-empty', displayName: 'Empty' }).returning()
    const out = await call<{ deleted: boolean }>(
      regionDelete,
      ev({ params: { id: empty!.id }, session: platformAdmin() }),
    )
    expect(out.deleted).toBe(true)
    const rows = await t.db.execute(sql`SELECT id FROM region WHERE id = ${empty!.id}::uuid`)
    expect([...rows].length).toBe(0)
  })

  it('deletes a region made through the create route, with its own default and Unplaced units', async () => {
    const made = await call<{ id: string }>(
      regionsCreate,
      ev({ body: { code: 'rlc-made', display_name: 'Made' }, session: platformAdmin() }),
    )
    const [root] = [...await t.db.execute<{ id: string }>(sql`SELECT id FROM org_unit WHERE region_id = ${made.id}::uuid AND code = 'default'`)]
    await t.db.insert(schema.orgUnit).values({ regionId: made.id, parentId: root!.id, path: 'rlc_made.__unplaced__', code: '__UNPLACED__', displayName: 'Unplaced', unitType: 'holding', isCostOwningUnit: false })

    const out = await call<{ deleted: boolean }>(regionDelete, ev({ params: { id: made.id }, session: platformAdmin() }))
    expect(out.deleted).toBe(true)
    const left = await t.db.execute(sql`SELECT 1 FROM org_unit WHERE region_id = ${made.id}::uuid UNION ALL SELECT 1 FROM region WHERE id = ${made.id}::uuid`)
    expect([...left].length).toBe(0)
  })

  it('refuses a region with a unit of its own beyond default and Unplaced (409)', async () => {
    const made = await call<{ id: string }>(
      regionsCreate,
      ev({ body: { code: 'rlc-made2', display_name: 'Made Two' }, session: platformAdmin() }),
    )
    await t.db.insert(schema.orgUnit).values({ regionId: made.id, path: 'rlc_made2.extra', code: 'extra', displayName: 'Extra', unitType: 'bu', isCostOwningUnit: true })
    await expect(
      call(regionDelete, ev({ params: { id: made.id }, session: platformAdmin() })),
    ).rejects.toMatchObject({ statusCode: 409 })
  })

  it('refuses when something still points at its default unit, and deletes nothing (409)', async () => {
    const made = await call<{ id: string }>(
      regionsCreate,
      ev({ body: { code: 'rlc-made3', display_name: 'Made Three' }, session: platformAdmin() }),
    )
    const [root] = [...await t.db.execute<{ id: string }>(sql`SELECT id FROM org_unit WHERE region_id = ${made.id}::uuid AND code = 'default'`)]
    await t.db.insert(schema.couOwner).values({ orgUnitId: root!.id, teammateId: '00000000-0000-4000-8000-000000000001' })
    const err = await call(regionDelete, ev({ params: { id: made.id }, session: platformAdmin() })).catch((e: unknown) => e)
    expect(err).toMatchObject({ statusCode: 409, data: { detail: expect.stringContaining('A cou_owner row') } })
    const kept = await t.db.execute(sql`SELECT 1 FROM org_unit WHERE region_id = ${made.id}::uuid`)
    expect([...kept].length).toBe(1)
  })

  it('refuses when a budget is scoped to its default unit, which no FK would catch (409)', async () => {
    const made = await call<{ id: string }>(
      regionsCreate,
      ev({ body: { code: 'rlc-made4', display_name: 'Made Four' }, session: platformAdmin() }),
    )
    const [root] = [...await t.db.execute<{ id: string }>(sql`SELECT id FROM org_unit WHERE region_id = ${made.id}::uuid AND code = 'default'`)]
    await t.db.execute(sql`
      WITH a AS (INSERT INTO audit_event (event_type, actor_system, payload) VALUES ('seed', 'test', '{}'::jsonb) RETURNING id)
      INSERT INTO allocation (scope_type, scope_id, budget_usd, effective, audit_event_id)
      SELECT 'cou', ${root!.id}::uuid, 100, tstzrange(now(), NULL), a.id FROM a`)
    const err = await call(regionDelete, ev({ params: { id: made.id }, session: platformAdmin() })).catch((e: unknown) => e)
    expect(err).toMatchObject({ statusCode: 409, data: { detail: expect.stringContaining('1 budgets') } })
    const kept = await t.db.execute(sql`SELECT 1 FROM region WHERE id = ${made.id}::uuid`)
    expect([...kept].length).toBe(1)
  })

  it('region admin cannot delete (403 — platform-admin only)', async () => {
    const [empty] = await t.db.insert(schema.region).values({ code: 'rlc-empty2', displayName: 'Empty2' }).returning()
    await expect(
      call(regionDelete, ev({ params: { id: empty!.id }, session: adminA() })),
    ).rejects.toMatchObject({ statusCode: 403 })
  })
})

describe('3. org-unit create', () => {
  it("no parent means the region's default unit; a region without one refuses (422)", async () => {
    // Region A was inserted bare, with no default unit. A unit is never created beside it.
    await expect(
      call(orgUnitsCreate, ev({ body: { region_id: regionAId, code: 'CSL-DRP', display_name: 'AFL Delivery', unit_type: 'bu', is_cost_owning_unit: true }, session: adminA() })),
    ).rejects.toMatchObject({ statusCode: 422 })
  })

  it('creates a child → path = parent.path + "." + label', async () => {
    const out = await call<{ id: string; path: string }>(
      orgUnitsCreate,
      ev({ body: { region_id: regionAId, parent_id: ouAId, code: 'A-TEAM', display_name: 'A Team', unit_type: 'team' }, session: adminA() }),
    )
    // parent ouAId path = 'a.svc'; label 'a_team' → 'a.svc.a_team'.
    expect(out.path).toBe('a.svc.a_team')
  })

  it('duplicate code in region → 409', async () => {
    await expect(
      call(orgUnitsCreate, ev({ body: { region_id: regionAId, parent_id: ouAId, code: 'a-svc', display_name: 'Dup', unit_type: 'bu' }, session: adminA() })),
    ).rejects.toMatchObject({ statusCode: 409 })
  })

  it('region admin creating in ANOTHER region → 403 (requireRegionScope)', async () => {
    await expect(
      call(orgUnitsCreate, ev({ body: { region_id: regionBId, code: 'x-unit', display_name: 'X', unit_type: 'bu' }, session: adminA() })),
    ).rejects.toMatchObject({ statusCode: 403 })
  })
})

describe('4. org-unit retire (DELETE)', () => {
  it('409 when the unit has a referencing project', async () => {
    // ouAId is the COU of projAId.
    await expect(
      call(orgUnitDelete, ev({ params: { id: ouAId }, session: adminA() })),
    ).rejects.toMatchObject({ statusCode: 409 })
  })

  it('409 when the unit has an active child', async () => {
    const [parent] = await t.db
      .insert(schema.orgUnit)
      .values({ regionId: regionAId, path: 'a.haschild', code: 'a-haschild', displayName: 'Has Child', unitType: 'bu' })
      .returning()
    await t.db
      .insert(schema.orgUnit)
      .values({ regionId: regionAId, parentId: parent!.id, path: 'a.haschild.kid', code: 'a-haschild-kid', displayName: 'Kid', unitType: 'team' })
    await expect(
      call(orgUnitDelete, ev({ params: { id: parent!.id }, session: adminA() })),
    ).rejects.toMatchObject({ statusCode: 409 })
  })

  it('409 when the unit has an active teammate', async () => {
    const [unit] = await t.db
      .insert(schema.orgUnit)
      .values({ regionId: regionAId, path: 'a.hasmate', code: 'a-hasmate', displayName: 'Has Mate', unitType: 'team' })
      .returning()
    await t.db
      .insert(schema.teammate)
      .values({ entraOid: 'oid-hasmate', email: 'hasmate@example.com', role: 'developer', regionId: regionAId, orgUnitId: unit!.id })
    await expect(
      call(orgUnitDelete, ev({ params: { id: unit!.id }, session: adminA() })),
    ).rejects.toMatchObject({ statusCode: 409 })
  })

  it('200 (sets retired_at) when empty', async () => {
    const [unit] = await t.db
      .insert(schema.orgUnit)
      .values({ regionId: regionAId, path: 'a.empty', code: 'a-empty', displayName: 'Empty', unitType: 'team' })
      .returning()
    const out = await call<{ id: string; retired_at: string }>(
      orgUnitDelete,
      ev({ params: { id: unit!.id }, session: adminA() }),
    )
    expect(out.retired_at).toBeTruthy()
    const rows = await t.db.execute<{ retired_at: string | null }>(sql`
      SELECT retired_at FROM org_unit WHERE id = ${unit!.id}::uuid
    `)
    expect([...rows][0]!.retired_at).not.toBeNull()
  })
})

describe('5. project edit (PATCH)', () => {
  it('admin edits display_name (200)', async () => {
    const out = await call<{ display_name: string }>(
      projectPatch,
      ev({ params: { id: projAId }, body: { display_name: 'Renamed Proj' }, session: adminA() }),
    )
    expect(out.display_name).toBe('Renamed Proj')
  })

  it('cost_owning_unit_id in ANOTHER region → 422', async () => {
    await expect(
      call(projectPatch, ev({ params: { id: projAId }, body: { cost_owning_unit_id: ouBId }, session: adminA() })),
    ).rejects.toMatchObject({ statusCode: 422 })
  })

  it('cost_owning_unit_id pointing at a RETIRED unit → 422', async () => {
    const [retired] = await t.db
      .insert(schema.orgUnit)
      .values({ regionId: regionAId, path: 'a.retired', code: 'a-retired', displayName: 'Retired', unitType: 'team', retiredAt: new Date() })
      .returning()
    await expect(
      call(projectPatch, ev({ params: { id: projAId }, body: { cost_owning_unit_id: retired!.id }, session: adminA() })),
    ).rejects.toMatchObject({ statusCode: 422 })
  })

  it('non-member region admin (different region) → 403', async () => {
    // projAId is in region A; an admin whose home is region B is out of scope.
    const adminB = (): Session =>
      ({ teammateId: '00000000-0000-4000-8000-000000000009', email: 'admin-b@example.com', displayName: 'Admin B', role: 'admin', regionId: regionBId, orgPath: 'b.svc' }) as Session
    await expect(
      call(projectPatch, ev({ params: { id: projAId }, body: { display_name: 'Nope' }, session: adminB() })),
    ).rejects.toMatchObject({ statusCode: 403 })
  })
})

describe('6. provision teammate (POST /admin/teammates)', () => {
  it('admin provisions a mock-directory oid into their region (200, source=directory)', async () => {
    const out = await call<{ id: string; oid: string; created: boolean }>(
      teammatesCreate,
      ev({ body: { oid: 'dir-oid-0001', region_id: regionAId, org_unit_id: ouAId, role: 'developer' }, session: adminA() }),
    )
    expect(out.oid).toBe('dir-oid-0001')
    expect(out.created).toBe(true)
    const rows = await t.db.execute<{ source: string; entra_oid: string }>(sql`
      SELECT source, entra_oid FROM teammate WHERE id = ${out.id}::uuid
    `)
    const row = [...rows][0]!
    expect(row.source).toBe('directory')
    expect(row.entra_oid).toBe('dir-oid-0001')
  })

  it('region admin granting platform-admin → 403 (canAssignRole)', async () => {
    await expect(
      call(teammatesCreate, ev({ body: { oid: 'dir-oid-0002', region_id: regionAId, org_unit_id: ouAId, role: 'platform-admin' }, session: adminA() })),
    ).rejects.toMatchObject({ statusCode: 403 })
  })

  it('re-provisioning the same oid → 409', async () => {
    // dir-oid-0001 was provisioned in the first case.
    await expect(
      call(teammatesCreate, ev({ body: { oid: 'dir-oid-0001', region_id: regionAId, org_unit_id: ouAId, role: 'developer' }, session: adminA() })),
    ).rejects.toMatchObject({ statusCode: 409 })
  })

  it('unknown oid → 404', async () => {
    await expect(
      call(teammatesCreate, ev({ body: { oid: 'dir-oid-9999', region_id: regionAId, org_unit_id: ouAId, role: 'developer' }, session: adminA() })),
    ).rejects.toMatchObject({ statusCode: 404 })
  })

  it('provisioning into a DIFFERENT region as a region admin → 403', async () => {
    await expect(
      call(teammatesCreate, ev({ body: { oid: 'dir-oid-0003', region_id: regionBId, org_unit_id: ouBId, role: 'developer' }, session: adminA() })),
    ).rejects.toMatchObject({ statusCode: 403 })
  })
})

describe('7. user org-unit placement (PATCH)', () => {
  let movableId: string
  let activeTargetId: string

  beforeAll(async () => {
    const [unit] = await t.db
      .insert(schema.orgUnit)
      .values({ regionId: regionAId, path: 'a.placement', code: 'a-placement', displayName: 'Placement', unitType: 'team' })
      .returning()
    activeTargetId = unit!.id
    const [mate] = await t.db
      .insert(schema.teammate)
      .values({ entraOid: 'oid-movable', email: 'movable@example.com', role: 'developer', regionId: regionAId, orgUnitId: ouAId })
      .returning()
    movableId = mate!.id
  })

  it('admin moves a teammate to an active in-region unit (200)', async () => {
    const out = await call<{ org_unit_id: string }>(
      userOrgUnitPatch,
      ev({ params: { id: movableId }, body: { org_unit_id: activeTargetId }, session: adminA() }),
    )
    expect(out.org_unit_id).toBe(activeTargetId)
    const rows = await t.db.execute<{ org_unit_id: string }>(sql`
      SELECT org_unit_id::text AS org_unit_id FROM teammate WHERE id = ${movableId}::uuid
    `)
    expect([...rows][0]!.org_unit_id).toBe(activeTargetId)
  })

  it('moving to a RETIRED unit → 422', async () => {
    const [retired] = await t.db
      .insert(schema.orgUnit)
      .values({ regionId: regionAId, path: 'a.placeretired', code: 'a-placeretired', displayName: 'PlaceRetired', unitType: 'team', retiredAt: new Date() })
      .returning()
    await expect(
      call(userOrgUnitPatch, ev({ params: { id: movableId }, body: { org_unit_id: retired!.id }, session: adminA() })),
    ).rejects.toMatchObject({ statusCode: 422 })
  })

  it('moving to a unit in ANOTHER region → 422', async () => {
    // ouBId is active but in region B; the teammate is in region A.
    await expect(
      call(userOrgUnitPatch, ev({ params: { id: movableId }, body: { org_unit_id: ouBId }, session: adminA() })),
    ).rejects.toMatchObject({ statusCode: 422 })
  })
})
