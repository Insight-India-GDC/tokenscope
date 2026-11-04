// @vitest-environment node
/*
 * Creating a project (docs/design/project-requests/00-spec.md §2, A4, A13, A14):
 *   - POST /api/v1/projects: the PMO-list gate, the own-region switch, the
 *     atomic project + PM + baseline write and its audit rows.
 *   - POST /api/v1/admin/projects: the shared create service keeps the admin
 *     response shape; PM and budget are optional there.
 *   - GET /api/v1/me/capabilities.
 *   - Project delete still works on a created project (A12).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'
import { routeEvent } from '../helpers/route-event'
import * as schema from '../../../drizzle/schema'
import type { Session } from '../../../server/utils/auth'
import pmoCreate from '../../../server/api/v1/projects/index.post'
import adminCreate from '../../../server/api/v1/admin/projects.post'
import deleteProject from '../../../server/api/v1/admin/projects/[id].delete'
import capabilities from '../../../server/api/v1/me/capabilities.get'

let t: TestDb
let regionA: string
let regionB: string
let buA: string
let buB: string
let retiredBuA: string
let holderId: string
let devId: string
let otherDevId: string
let adminAId: string

const BUDGET = { amount_usd: '1500.00', from: '2026-11-01T00:00:00Z', to: '2026-12-01T00:00:00Z' }

function session(id: string, role: Session['role'], regionId: string): Session {
  return { teammateId: id, email: `${id}@x.test`, displayName: id, role, regionId, orgPath: 'pc.a', issuedAt: '2026-10-28T00:00:00Z' }
}
const holder = () => session(holderId, 'developer', regionA)
const dev = () => session(devId, 'developer', regionA)
const adminA = () => session(adminAId, 'admin', regionA)

async function grant(teammateId: string) {
  await t.client`INSERT INTO project_manager_grant (teammate_id) VALUES (${teammateId}::uuid)`
}
async function setOwnRegionOnly(v: 0 | 1) {
  await t.client`UPDATE governance_setting SET value_numeric = ${v} WHERE key = 'projects.pm_own_region_only' AND scope_type = 'platform'`
}
function body(code: string, extra: Record<string, unknown> = {}) {
  return { code, display_name: `Project ${code}`, type: 'billable', region_id: regionB, cost_owning_unit_id: buB, budget: BUDGET, ...extra }
}

beforeAll(async () => {
  t = await startTestDb()
  process.env.DATABASE_URL = t.url
  const [ra] = await t.db.insert(schema.region).values({ code: 'pc-a', displayName: 'PC A' }).returning()
  const [rb] = await t.db.insert(schema.region).values({ code: 'pc-b', displayName: 'PC B' }).returning()
  regionA = ra!.id
  regionB = rb!.id
  const [oa] = await t.db.insert(schema.orgUnit).values({ regionId: regionA, path: 'pca.svc', code: 'pca-svc', displayName: 'A Svc', unitType: 'bu', isCostOwningUnit: true }).returning()
  const [ob] = await t.db.insert(schema.orgUnit).values({ regionId: regionB, path: 'pcb.svc', code: 'pcb-svc', displayName: 'B Svc', unitType: 'bu', isCostOwningUnit: true }).returning()
  const [or] = await t.db.insert(schema.orgUnit).values({ regionId: regionA, path: 'pca.old', code: 'pca-old', displayName: 'A Old', unitType: 'bu', isCostOwningUnit: true, retiredAt: new Date('2026-01-01T00:00:00Z') }).returning()
  buA = oa!.id
  buB = ob!.id
  retiredBuA = or!.id
  const mk = async (oid: string, role: string) => {
    const [row] = await t.db.insert(schema.teammate).values({ entraOid: oid, email: `${oid}@x.test`, displayName: oid, role, regionId: regionA, orgUnitId: buA }).returning()
    return row!.id
  }
  holderId = await mk('pc-holder', 'developer')
  devId = await mk('pc-dev', 'developer')
  otherDevId = await mk('pc-other', 'developer')
  adminAId = await mk('pc-admin', 'admin')
  await grant(holderId)
}, 120_000)

afterAll(async () => {
  await stopTestDb(t)
}, 30_000)

describe('POST /api/v1/projects — PMO gate', () => {
  it('a teammate not on the PMO list gets 403 and nothing is written', async () => {
    await expect(pmoCreate(routeEvent({ method: 'POST', body: body('PC-NOPE'), session: dev() }))).rejects.toMatchObject({ statusCode: 403 })
    const rows = await t.client`SELECT 1 FROM project WHERE code = 'PC-NOPE'`
    expect(rows.length).toBe(0)
  })

  it('a region admin without a grant is refused here too (admins use the admin route)', async () => {
    await expect(pmoCreate(routeEvent({ method: 'POST', body: body('PC-ADM'), session: adminA() }))).rejects.toMatchObject({ statusCode: 403 })
  })

  it('a holder creates a project in another region: project, PM = self, baseline, onboarded, audited as pmo', async () => {
    const out = (await pmoCreate(routeEvent({ method: 'POST', body: body('PC-ONE', { end_date: '2027-06-30T00:00:00Z' }), session: holder() }))) as {
      id: string; code: string; is_onboarded: boolean; allocation_id: string
    }
    expect(out.code).toBe('PC-ONE')
    expect(out.is_onboarded).toBe(true)

    const [p] = await t.client<{ region_id: string; is_onboarded: boolean; end_date: string | null }[]>`
      SELECT region_id::text AS region_id, is_onboarded, end_date::text AS end_date FROM project WHERE id = ${out.id}::uuid`
    expect(p!.region_id).toBe(regionB)
    expect(p!.is_onboarded).toBe(true)
    expect(p!.end_date).not.toBeNull()

    const pms = await t.client<{ teammate_id: string; current: boolean }[]>`
      SELECT teammate_id::text AS teammate_id, effective @> now() AS current
      FROM project_assignment WHERE project_id = ${out.id}::uuid AND role = 'manager'`
    expect(pms).toEqual([{ teammate_id: holderId, current: true }])

    const [alloc] = await t.client<{ id: string; budget_usd: string; teammate_id: string | null; kind: string; audit_event_id: string }[]>`
      SELECT id::text AS id, budget_usd::text AS budget_usd, teammate_id::text AS teammate_id,
             allocation_kind AS kind, audit_event_id::text AS audit_event_id
      FROM allocation WHERE scope_type = 'project' AND scope_id = ${out.id}::uuid`
    expect(alloc).toMatchObject({ id: out.allocation_id, budget_usd: '1500.00', teammate_id: null, kind: 'baseline' })

    const audits = await t.client<{ id: string; event_type: string; actor: string; source: string }[]>`
      SELECT id::text AS id, event_type, actor_teammate_id::text AS actor, payload->>'source' AS source
      FROM audit_event WHERE subject_kind = 'project' AND subject_id = ${out.id}::uuid ORDER BY ts_recorded, event_type`
    expect(audits.map((a) => a.event_type).sort()).toEqual(['allocation-created', 'project-created', 'project-member-added'])
    expect(audits.every((a) => a.actor === holderId && a.source === 'pmo')).toBe(true)
    expect(audits.find((a) => a.event_type === 'allocation-created')!.id).toBe(alloc!.audit_event_id)
  })

  it('a holder can name another PM', async () => {
    const out = (await pmoCreate(routeEvent({ method: 'POST', body: body('PC-TWO', { pm_teammate_id: otherDevId }), session: holder() }))) as { id: string }
    const pms = await t.client<{ teammate_id: string }[]>`
      SELECT teammate_id::text AS teammate_id FROM project_assignment WHERE project_id = ${out.id}::uuid AND role = 'manager'`
    expect(pms.map((r) => r.teammate_id)).toEqual([otherDevId])
  })

  it('budget is required, and allow_burned_code is refused (400)', async () => {
    await expect(
      pmoCreate(routeEvent({ method: 'POST', body: body('PC-NOBUD', { budget: undefined }), session: holder() })),
    ).rejects.toMatchObject({ statusCode: 400 })
    await expect(
      pmoCreate(routeEvent({ method: 'POST', body: body('PC-BURN', { allow_burned_code: true }), session: holder() })),
    ).rejects.toMatchObject({ statusCode: 400 })
  })

  it('a taken code is 409; a retired Business Unit is 422', async () => {
    await expect(pmoCreate(routeEvent({ method: 'POST', body: body('PC-ONE'), session: holder() }))).rejects.toMatchObject({ statusCode: 409 })
    await expect(
      pmoCreate(routeEvent({ method: 'POST', body: body('PC-RET', { region_id: regionA, cost_owning_unit_id: retiredBuA }), session: holder() })),
    ).rejects.toMatchObject({ statusCode: 422 })
  })

  it('an inactive PM is 422 and rolls the project back', async () => {
    await t.client`UPDATE teammate SET is_active = FALSE WHERE id = ${otherDevId}::uuid`
    try {
      await expect(
        pmoCreate(routeEvent({ method: 'POST', body: body('PC-INACT', { pm_teammate_id: otherDevId }), session: holder() })),
      ).rejects.toMatchObject({ statusCode: 422 })
      expect((await t.client`SELECT 1 FROM project WHERE code = 'PC-INACT'`).length).toBe(0)
    } finally {
      await t.client`UPDATE teammate SET is_active = TRUE WHERE id = ${otherDevId}::uuid`
    }
  })
})

describe('own-region switch (A4)', () => {
  it('when on, a holder is refused outside their current region and allowed inside it', async () => {
    await setOwnRegionOnly(1)
    try {
      await expect(pmoCreate(routeEvent({ method: 'POST', body: body('PC-OUT'), session: holder() }))).rejects.toMatchObject({
        statusCode: 403,
        data: { detail: expect.stringMatching(/only in the region they are placed in/) },
      })
      const ok = (await pmoCreate(routeEvent({
        method: 'POST', body: body('PC-IN', { region_id: regionA, cost_owning_unit_id: buA }), session: holder(),
      }))) as { code: string }
      expect(ok.code).toBe('PC-IN')
    } finally {
      await setOwnRegionOnly(0)
    }
  })

  it('reads the CURRENT placement, not the session: a holder moved to region B may create there', async () => {
    await setOwnRegionOnly(1)
    await t.client`UPDATE teammate SET region_id = ${regionB}::uuid, org_unit_id = ${buB}::uuid WHERE id = ${holderId}::uuid`
    try {
      const ok = (await pmoCreate(routeEvent({ method: 'POST', body: body('PC-MOVED'), session: holder() }))) as { code: string }
      expect(ok.code).toBe('PC-MOVED')
    } finally {
      await t.client`UPDATE teammate SET region_id = ${regionA}::uuid, org_unit_id = ${buA}::uuid WHERE id = ${holderId}::uuid`
      await setOwnRegionOnly(0)
    }
  })

  it('a revoked grant no longer creates', async () => {
    await t.client`UPDATE project_manager_grant SET revoked_at = now(), revoked_by = ${adminAId}::uuid WHERE teammate_id = ${holderId}::uuid`
    try {
      await expect(pmoCreate(routeEvent({ method: 'POST', body: body('PC-REV'), session: holder() }))).rejects.toMatchObject({ statusCode: 403 })
    } finally {
      await grant(holderId)
    }
  })
})

describe('POST /api/v1/admin/projects — the shared service keeps the admin contract', () => {
  it('without PM or budget: the original shape, not onboarded, no assignment, no allocation', async () => {
    const out = await adminCreate(routeEvent({
      method: 'POST',
      body: { code: 'PC-ADMIN', display_name: 'Admin one', type: 'internal', region_id: regionA, cost_owning_unit_id: buA },
      session: adminA(),
    }))
    expect(Object.keys(out).sort()).toEqual(['code', 'id', 'is_onboarded'])
    expect(out.is_onboarded).toBe(false)
    const n = await t.client`SELECT 1 FROM allocation WHERE scope_id = ${out.id}::uuid
      UNION ALL SELECT 1 FROM project_assignment WHERE project_id = ${out.id}::uuid`
    expect(n.length).toBe(0)
    const [a] = await t.client<{ source: string }[]>`
      SELECT payload->>'source' AS source FROM audit_event WHERE event_type = 'project-created' AND subject_id = ${out.id}::uuid`
    expect(a!.source).toBe('admin')
  })

  it('with PM and budget: one atomic call returns allocation_id and onboards', async () => {
    const out = await adminCreate(routeEvent({
      method: 'POST',
      body: { code: 'PC-ADMIN2', display_name: 'Admin two', type: 'internal', region_id: regionA, cost_owning_unit_id: buA, pm_teammate_id: devId, budget: BUDGET },
      session: adminA(),
    }))
    expect(out).toMatchObject({ code: 'PC-ADMIN2', is_onboarded: true, allocation_id: expect.any(String) })
  })

  it('a region admin is still bound to their region (403)', async () => {
    await expect(adminCreate(routeEvent({
      method: 'POST',
      body: { code: 'PC-ADMIN3', display_name: 'x', type: 'internal', region_id: regionB, cost_owning_unit_id: buB },
      session: adminA(),
    }))).rejects.toMatchObject({ statusCode: 403 })
  })
})

describe('GET /api/v1/me/capabilities', () => {
  it('reports the grant and the switch', async () => {
    expect(await capabilities(routeEvent({ method: 'GET', session: holder() }))).toEqual({
      can_create_projects: true, pm_own_region_only: false, region_id: regionA,
    })
    expect(await capabilities(routeEvent({ method: 'GET', session: dev() }))).toMatchObject({ can_create_projects: false })
  })

  it('agrees with the create: a deactivated grant holder is offered nothing and refused (403)', async () => {
    await t.client`UPDATE teammate SET is_active = FALSE WHERE id = ${holderId}::uuid`
    try {
      expect(await capabilities(routeEvent({ method: 'GET', session: holder() }))).toMatchObject({ can_create_projects: false })
      await expect(pmoCreate(routeEvent({ method: 'POST', body: body('PC-INACTIVE'), session: holder() }))).rejects.toMatchObject({ statusCode: 403 })
      expect((await t.client`SELECT 1 FROM project WHERE code = 'PC-INACTIVE'`).length).toBe(0)
    } finally {
      await t.client`UPDATE teammate SET is_active = TRUE WHERE id = ${holderId}::uuid`
    }
    expect(await capabilities(routeEvent({ method: 'GET', session: holder() }))).toMatchObject({ can_create_projects: true })
  })

  it('agrees with the create: a revoked grant is offered nothing', async () => {
    await t.client`UPDATE project_manager_grant SET revoked_at = now(), revoked_by = ${adminAId}::uuid WHERE teammate_id = ${holderId}::uuid AND revoked_at IS NULL`
    try {
      expect(await capabilities(routeEvent({ method: 'GET', session: holder() }))).toMatchObject({ can_create_projects: false })
    } finally {
      await grant(holderId)
    }
  })
})

describe('project delete keeps working (A12)', () => {
  it('deletes a PMO-created, $0-spend project and nulls the request link', async () => {
    const out = (await pmoCreate(routeEvent({ method: 'POST', body: body('PC-DEL'), session: holder() }))) as { id: string }
    const [req] = await t.client<{ id: string }[]>`
      INSERT INTO project_request (requester_teammate_id, display_name, type, region_id, cost_owning_unit_id,
        proposed_pm_teammate_id, budget_usd, budget_from, budget_to, justification, status, decided_by, decided_at, created_project_id)
      VALUES (${devId}::uuid, 'Del', 'billable', ${regionB}::uuid, ${buB}::uuid, ${devId}::uuid, 10,
        '2026-11-01', '2026-12-01', 'why', 'approved', ${adminAId}::uuid, now(), ${out.id}::uuid)
      RETURNING id::text AS id`
    const del = (await deleteProject(routeEvent({ method: 'DELETE', params: { id: out.id }, session: session(adminAId, 'platform-admin', regionA) }))) as { deleted: boolean }
    expect(del.deleted).toBe(true)
    const [after] = await t.client<{ created_project_id: string | null; status: string }[]>`
      SELECT created_project_id::text AS created_project_id, status FROM project_request WHERE id = ${req!.id}::uuid`
    expect(after).toEqual({ created_project_id: null, status: 'approved' })
  })
})
