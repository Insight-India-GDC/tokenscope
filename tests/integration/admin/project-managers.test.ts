// @vitest-environment node
/*
 * Admin → Project managers (the PMO list, mig 0164): platform-admin only (A3),
 * one live grant per teammate, soft revoke, audited; revoking leaves the
 * holder's existing PM assignments alone.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'
import { routeEvent } from '../helpers/route-event'
import * as schema from '../../../drizzle/schema'
import type { Session } from '../../../server/utils/auth'
import listGrants from '../../../server/api/v1/admin/project-managers/index.get'
import addGrant from '../../../server/api/v1/admin/project-managers/index.post'
import revokeGrant from '../../../server/api/v1/admin/project-managers/[id]/revoke.post'

let t: TestDb
let regionId: string
let platformId: string
let adminId: string
let devId: string
let inactiveId: string

const MISSING = '9a1e0000-0000-4000-8000-000000000001'

function session(id: string, role: Session['role']): Session {
  return { teammateId: id, email: `${id}@x.test`, displayName: id, role, regionId, orgPath: 'pm.a', issuedAt: '2026-10-28T00:00:00Z' }
}
const platform = () => session(platformId, 'platform-admin')

beforeAll(async () => {
  t = await startTestDb()
  process.env.DATABASE_URL = t.url
  const [r] = await t.db.insert(schema.region).values({ code: 'pm-a', displayName: 'PM A' }).returning()
  regionId = r!.id
  const [o] = await t.db.insert(schema.orgUnit).values({ regionId, path: 'pma.svc', code: 'pma-svc', displayName: 'Svc', unitType: 'bu', isCostOwningUnit: true }).returning()
  const mk = async (oid: string, role: string, isActive = true) => {
    const [row] = await t.db.insert(schema.teammate).values({ entraOid: oid, email: `${oid}@x.test`, displayName: oid, role, regionId, orgUnitId: o!.id, isActive }).returning()
    return row!.id
  }
  platformId = await mk('pm-platform', 'platform-admin')
  adminId = await mk('pm-admin', 'admin')
  devId = await mk('pm-dev', 'developer')
  inactiveId = await mk('pm-gone', 'developer', false)
}, 120_000)

afterAll(async () => {
  await stopTestDb(t)
}, 30_000)

describe('RBAC', () => {
  it('a region admin and a developer get 403 on every route', async () => {
    for (const who of [session(adminId, 'admin'), session(devId, 'developer')]) {
      await expect(listGrants(routeEvent({ method: 'GET', session: who }))).rejects.toMatchObject({ statusCode: 403 })
      await expect(addGrant(routeEvent({ method: 'POST', body: { teammate_id: devId }, session: who }))).rejects.toMatchObject({ statusCode: 403 })
      await expect(revokeGrant(routeEvent({ method: 'POST', params: { id: MISSING }, session: who }))).rejects.toMatchObject({ statusCode: 403 })
    }
  })
})

describe('grant and revoke', () => {
  let grantId: string

  it('adds a teammate, lists them, and audits it', async () => {
    const out = (await addGrant(routeEvent({ method: 'POST', body: { teammate_id: devId, note: 'Runs the Acme account' }, session: platform() }))) as { id: string }
    grantId = out.id
    const list = (await listGrants(routeEvent({ method: 'GET', session: platform() }))) as { grants: { id: string; teammate_id: string; note: string }[] }
    expect(list.grants).toEqual([expect.objectContaining({ id: grantId, teammate_id: devId, note: 'Runs the Acme account' })])
    const [a] = await t.client<{ actor: string; grant_id: string }[]>`
      SELECT actor_teammate_id::text AS actor, payload->>'grant_id' AS grant_id
      FROM audit_event WHERE event_type = 'project-manager-granted' AND subject_id = ${devId}::uuid`
    expect(a).toEqual({ actor: platformId, grant_id: grantId })
  })

  it('a second live grant for the same teammate is 409', async () => {
    await expect(addGrant(routeEvent({ method: 'POST', body: { teammate_id: devId }, session: platform() }))).rejects.toMatchObject({ statusCode: 409 })
  })

  it('an unknown teammate is 404, an inactive one 422', async () => {
    await expect(addGrant(routeEvent({ method: 'POST', body: { teammate_id: MISSING }, session: platform() }))).rejects.toMatchObject({ statusCode: 404 })
    await expect(addGrant(routeEvent({ method: 'POST', body: { teammate_id: inactiveId }, session: platform() }))).rejects.toMatchObject({ statusCode: 422 })
  })

  it('revoke soft-revokes, is audited, and leaves existing PM assignments', async () => {
    const [p] = await t.client<{ id: string }[]>`
      INSERT INTO project (code, code_hash, display_name, type, region_id, cost_owning_unit_id)
      SELECT 'PM-KEEP', 'h-pm-keep', 'Keep', 'internal', ${regionId}::uuid, org_unit_id FROM teammate WHERE id = ${devId}::uuid
      RETURNING id::text AS id`
    await t.client`INSERT INTO project_assignment (project_id, teammate_id, effective, role)
      VALUES (${p!.id}::uuid, ${devId}::uuid, tstzrange(now(), NULL), 'manager')`

    const out = await revokeGrant(routeEvent({ method: 'POST', params: { id: grantId }, session: platform() }))
    expect(out).toMatchObject({ id: grantId, revoked: true })
    const [g] = await t.client<{ revoked_by: string | null }[]>`
      SELECT revoked_by::text AS revoked_by FROM project_manager_grant WHERE id = ${grantId}::uuid`
    expect(g!.revoked_by).toBe(platformId)
    const list = (await listGrants(routeEvent({ method: 'GET', session: platform() }))) as { grants: unknown[] }
    expect(list.grants).toEqual([])
    const audits = await t.client`SELECT 1 FROM audit_event WHERE event_type = 'project-manager-revoked' AND subject_id = ${devId}::uuid`
    expect(audits.length).toBe(1)
    const pms = await t.client`SELECT 1 FROM project_assignment WHERE project_id = ${p!.id}::uuid AND role = 'manager' AND effective @> now()`
    expect(pms.length).toBe(1)
  })

  it('revoking twice is 409, an unknown grant 404; a re-grant after revoke is a new row', async () => {
    await expect(revokeGrant(routeEvent({ method: 'POST', params: { id: grantId }, session: platform() }))).rejects.toMatchObject({ statusCode: 409 })
    await expect(revokeGrant(routeEvent({ method: 'POST', params: { id: MISSING }, session: platform() }))).rejects.toMatchObject({ statusCode: 404 })
    const again = (await addGrant(routeEvent({ method: 'POST', body: { teammate_id: devId }, session: platform() }))) as { id: string }
    expect(again.id).not.toBe(grantId)
  })
})
