// @vitest-environment node
/*
 * A Project Manager on their OWN project (docs/design/project-requests/00-spec.md
 * §4, amendments A1, A2, A5), through the real route handlers.
 *
 * RBAC matrix: member, developer-role PM, org-role manager who is not the PM,
 * region admin (own / other region), platform-admin, non-member — on the routes
 * the PM gate widens (consumption, allocations POST/PATCH/split, assignments)
 * and the new end-date route. Plus A2 (no directory provisioning on the PM arm)
 * and the last-PM rule, including two PMs demoting themselves concurrently.
 * A PM removed while their request waits on the project lock is judged at the
 * post-lock instant, on every locked route, as approve and decline are.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'
import { injectTestSession } from '../../helpers/auth'
import type { Session } from '../../../server/utils/auth'
import consumptionGet from '../../../server/api/v1/projects/[id]/consumption.get'
import timelinePatch from '../../../server/api/v1/projects/[id]/timeline.patch'
import allocationsPost from '../../../server/api/v1/allocations/index.post'
import allocationPatch from '../../../server/api/v1/allocations/[id].patch'
import allocationGet from '../../../server/api/v1/allocations/[id].get'
import splitPost from '../../../server/api/v1/allocations/[id]/split.post'
import topupsPost from '../../../server/api/v1/allocations/[id]/topups.post'
import assignmentsGet from '../../../server/api/v1/admin/projects/[id]/assignments.get'
import assignmentsPost from '../../../server/api/v1/admin/projects/[id]/assignments.post'
import assignmentDelete from '../../../server/api/v1/admin/projects/[id]/assignments/[teammateId].delete'
import assignmentPatch from '../../../server/api/v1/admin/projects/[id]/assignments/[teammateId].patch'
import projectPageGet from '../../../server/api/v1/me/projects/[code]/index.get'
import { resolveServerClock } from '../../../shared/reports/clock'

let t: TestDb
let regionId = ''
let otherRegionId = ''
let pracId = ''

const U = (n: number) => `9a1e0000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`
const PM_DEV = U(1) // developer role, PM of P
const MEMBER = U(2)
const MGR = U(3) // org-role manager in scope, NOT a PM of P
const ADMIN = U(4)
const ADMIN_OTHER = U(5)
const PLATFORM = U(6)
const OUTSIDER = U(7)
const PM_A = U(8)
const PM_B = U(9)
const PLACEHOLDER = U(10)

let P = '' // PM_DEV manages it
let Q = '' // PM_DEV is only a member
let L = '' // PM_DEV is its only PM
let C = '' // two PMs, for the concurrent case
let poolP = ''
let poolQ = ''

type Handler = (e: never) => Promise<unknown>

function ev(opts: { session: Session; params: Record<string, string>; body?: unknown; method?: string }) {
  const method = opts.method ?? 'POST'
  const headers: Record<string, string> = {
    host: 'localhost:3450',
    origin: 'http://localhost:3450',
    'content-type': 'application/json',
  }
  const e = {
    method,
    path: '/x',
    context: { params: opts.params },
    node: {
      req: { method, url: '/x', body: opts.body, headers, socket: { remoteAddress: '127.0.0.1' } },
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
  injectTestSession(e as never, opts.session)
  return e as never
}

const call = (h: Handler, session: Session, params: Record<string, string>, body?: unknown, method?: string) =>
  h(ev({ session, params, body, method }))

const ROLE_OF: Record<string, { role: string; region: () => string; orgPath: string }> = {
  [PM_DEV]: { role: 'developer', region: () => regionId, orgPath: 'pma.prac' },
  [MEMBER]: { role: 'developer', region: () => regionId, orgPath: 'pma.prac' },
  [MGR]: { role: 'manager', region: () => regionId, orgPath: 'pma.prac' },
  [ADMIN]: { role: 'admin', region: () => regionId, orgPath: 'pma' },
  [ADMIN_OTHER]: { role: 'admin', region: () => otherRegionId, orgPath: 'pmb' },
  [PLATFORM]: { role: 'platform-admin', region: () => otherRegionId, orgPath: 'pmb' },
  [OUTSIDER]: { role: 'developer', region: () => regionId, orgPath: 'pma.prac' },
  [PM_A]: { role: 'developer', region: () => regionId, orgPath: 'pma.prac' },
  [PM_B]: { role: 'developer', region: () => regionId, orgPath: 'pma.prac' },
}
const as = (id: string): Session => {
  const r = ROLE_OF[id]!
  return { teammateId: id, email: `${id}@x.test`, displayName: id, role: r.role, regionId: r.region(), orgPath: r.orgPath } as Session
}

async function mkProject(code: string): Promise<string> {
  const [p] = await t.client<{ id: string }[]>`
    INSERT INTO project (code, code_hash, display_name, type, region_id, cost_owning_unit_id)
    VALUES (${code}, ${'h-' + code}, ${code}, 'billable', ${regionId}::uuid, ${pracId}::uuid)
    RETURNING id::text AS id`
  return p!.id
}
async function assign(projectId: string, teammateId: string, role: 'manager' | 'member') {
  await t.client`INSERT INTO project_assignment (project_id, teammate_id, effective, role)
    VALUES (${projectId}::uuid, ${teammateId}::uuid, '[2026-01-01T00:00:00Z,)', ${role})`
}
async function mkPool(projectId: string): Promise<string> {
  const [evt] = await t.client<{ id: string }[]>`
    INSERT INTO audit_event (event_type, subject_kind, subject_id, payload)
    VALUES ('allocation-created', 'project', ${projectId}::uuid, '{}'::jsonb) RETURNING id::text AS id`
  const [a] = await t.client<{ id: string }[]>`
    INSERT INTO allocation (scope_type, scope_id, budget_usd, effective, allocation_kind, audit_event_id)
    VALUES ('project', ${projectId}::uuid, 1000, '[2026-01-01T00:00:00Z,2099-01-01T00:00:00Z)', 'baseline', ${evt!.id}::uuid)
    RETURNING id::text AS id`
  return a!.id
}

async function status(p: Promise<unknown>): Promise<number> {
  try {
    await p
    return 200
  } catch (e) {
    return (e as { statusCode?: number }).statusCode ?? 500
  }
}

beforeAll(async () => {
  delete process.env.NUXT_GRAPH_DIRECTORY_MODE // mock directory
  t = await startTestDb()
  process.env.DATABASE_URL = t.url
  const [r] = await t.client<{ id: string }[]>`INSERT INTO region (code, display_name) VALUES ('pma', 'PMA') RETURNING id::text AS id`
  regionId = r!.id
  const [r2] = await t.client<{ id: string }[]>`INSERT INTO region (code, display_name) VALUES ('pmb', 'PMB') RETURNING id::text AS id`
  otherRegionId = r2!.id
  const [root] = await t.client<{ id: string }[]>`INSERT INTO org_unit (region_id, path, code, display_name, unit_type, is_cost_owning_unit)
    VALUES (${regionId}::uuid, 'pma', 'default', 'PMA', 'bu', true) RETURNING id::text AS id`
  const [prac] = await t.client<{ id: string }[]>`INSERT INTO org_unit (region_id, parent_id, path, code, display_name, unit_type, is_cost_owning_unit)
    VALUES (${regionId}::uuid, ${root!.id}::uuid, 'pma.prac', 'prac', 'Practice', 'practice', true) RETURNING id::text AS id`
  pracId = prac!.id
  const [root2] = await t.client<{ id: string }[]>`INSERT INTO org_unit (region_id, path, code, display_name, unit_type, is_cost_owning_unit)
    VALUES (${otherRegionId}::uuid, 'pmb', 'default', 'PMB', 'bu', true) RETURNING id::text AS id`

  for (const [id, r] of Object.entries(ROLE_OF)) {
    const unit = r.region() === regionId ? pracId : root2!.id
    await t.client`INSERT INTO teammate (id, entra_oid, email, display_name, region_id, org_unit_id, role)
      VALUES (${id}::uuid, ${'oid-' + id}, ${id + '@x.test'}, ${id}, ${r.region()}::uuid, ${unit}::uuid, ${r.role})`
  }
  await t.client`INSERT INTO teammate (id, entra_oid, email, display_name, region_id, org_unit_id, role)
    VALUES (${PLACEHOLDER}::uuid, 'bill:someone@x.test', 'someone@x.test', 'Someone', ${regionId}::uuid, ${pracId}::uuid, 'developer')`

  P = await mkProject('PMA-P')
  Q = await mkProject('PMA-Q')
  L = await mkProject('PMA-L')
  C = await mkProject('PMA-C')
  await assign(P, PM_DEV, 'manager')
  await assign(P, MEMBER, 'member')
  await assign(Q, PM_DEV, 'member')
  await assign(Q, PM_A, 'manager')
  await assign(L, PM_DEV, 'manager')
  await assign(L, MEMBER, 'member')
  await assign(C, PM_A, 'manager')
  await assign(C, PM_B, 'manager')
  poolP = await mkPool(P)
  poolQ = await mkPool(Q)
}, 180_000)

afterAll(async () => {
  if (t) await stopTestDb(t)
}, 30_000)

describe('existing routes: today’s gate OR PM of this project (A1)', () => {
  it('consumption: the developer-role PM reads it; a member, a non-member and the PM on another project get 403', async () => {
    const out = (await call(consumptionGet as Handler, as(PM_DEV), { id: P }, undefined, 'GET')) as { project_id: string; total_cost_usd: string }
    expect(out).toMatchObject({ project_id: P, total_cost_usd: '0.00' })
    expect(await status(call(consumptionGet as Handler, as(MEMBER), { id: P }, undefined, 'GET'))).toBe(403)
    expect(await status(call(consumptionGet as Handler, as(OUTSIDER), { id: P }, undefined, 'GET'))).toBe(403)
    expect(await status(call(consumptionGet as Handler, as(PM_DEV), { id: Q }, undefined, 'GET'))).toBe(403)
    // An org-role manager in scope keeps today's access.
    expect(await status(call(consumptionGet as Handler, as(MGR), { id: P }, undefined, 'GET'))).toBe(200)
  })

  it('POST /allocations: the PM creates a baseline on their project; refused on a project they only belong to', async () => {
    const body = (project_id: string) => ({ project_id, budget_usd: '50', effective: '[2099-02-01T00:00:00Z,2099-03-01T00:00:00Z)' })
    const out = (await call(allocationsPost as Handler, as(PM_DEV), {}, body(P))) as { id: string }
    expect(out.id).toBeTruthy()
    const [audit] = await t.client<{ via: string }[]>`
      SELECT payload->>'via' AS via FROM audit_event WHERE event_type = 'allocation-created' AND actor_teammate_id = ${PM_DEV}::uuid`
    expect(audit!.via).toBe('project-manager')
    expect(await status(call(allocationsPost as Handler, as(PM_DEV), {}, body(Q)))).toBe(403)
    expect(await status(call(allocationsPost as Handler, as(MEMBER), {}, body(P)))).toBe(403)
  })

  it('PATCH /allocations/{id}: the PM edits their pool; another project’s pool is 404', async () => {
    const body = { budget_usd: '1200', effective: '[2026-01-01T00:00:00Z,2099-01-01T00:00:00Z)' }
    await call(allocationPatch as Handler, as(PM_DEV), { id: poolP }, body, 'PATCH')
    const [row] = await t.client<{ b: string }[]>`SELECT budget_usd::text AS b FROM allocation WHERE id = ${poolP}::uuid`
    expect(row!.b).toBe('1200.00')
    expect(await status(call(allocationPatch as Handler, as(PM_DEV), { id: poolQ }, body, 'PATCH'))).toBe(404)
    expect(await status(call(allocationPatch as Handler, as(MEMBER), { id: poolP }, body, 'PATCH'))).toBe(404)
  })

  it('split: the PM sets per-developer caps on their project only', async () => {
    const out = (await call(splitPost as Handler, as(PM_DEV), { id: poolP }, { mode: 'per_dev_fixed', caps: [{ teammate_id: MEMBER, budget_usd: '100' }] })) as { mode: string }
    expect(out.mode).toBe('per_dev_fixed')
    expect(await status(call(splitPost as Handler, as(PM_DEV), { id: poolQ }, { mode: 'shared_pool' }))).toBe(403)
    expect(await status(call(splitPost as Handler, as(MEMBER), { id: poolP }, { mode: 'shared_pool' }))).toBe(403)
    await call(splitPost as Handler, as(PM_DEV), { id: poolP }, { mode: 'shared_pool' })
  })

  it('assignments: the PM lists, adds an existing teammate and makes them PM; not on another project', async () => {
    const list = (await call(assignmentsGet as Handler, as(PM_DEV), { id: P }, undefined, 'GET')) as { members: unknown[] }
    expect(list.members.length).toBe(2)
    const added = (await call(assignmentsPost as Handler, as(PM_DEV), { id: P }, { teammate_id: OUTSIDER })) as { teammate_id: string }
    expect(added.teammate_id).toBe(OUTSIDER)
    const promoted = (await call(assignmentPatch as Handler, as(PM_DEV), { id: P, teammateId: OUTSIDER }, { role: 'manager' }, 'PATCH')) as { role: string }
    expect(promoted.role).toBe('manager')
    await call(assignmentDelete as Handler, as(PM_DEV), { id: P, teammateId: OUTSIDER }, undefined, 'DELETE')
    expect(await status(call(assignmentsPost as Handler, as(PM_DEV), { id: Q }, { teammate_id: OUTSIDER }))).toBe(403)
    expect(await status(call(assignmentsGet as Handler, as(MEMBER), { id: P }, undefined, 'GET'))).toBe(403)
  })

  it('A2: a caller admitted only as PM cannot provision from the directory or adopt a bill: placeholder', async () => {
    expect(await status(call(assignmentsPost as Handler, as(PM_DEV), { id: P }, { oid: 'dir-oid-0001' }))).toBe(403)
    expect(await status(call(assignmentsPost as Handler, as(PM_DEV), { id: P }, { teammate_id: PLACEHOLDER }))).toBe(403)
    const [n] = await t.client<{ n: number }[]>`SELECT COUNT(*)::int AS n FROM teammate WHERE entra_oid = 'dir-oid-0001'`
    expect(n!.n).toBe(0)
    // The org-role manager in scope keeps directory provisioning (A1: nothing taken away).
    const out = (await call(assignmentsPost as Handler, as(MGR), { id: P }, { oid: 'dir-oid-0001' })) as { provisioned: boolean }
    expect(out.provisioned).toBe(true)
  })
})

describe('GET /allocations/{id}: siblings are the displayed period’s only', () => {
  it('an expired top-up and an earlier baseline are left out; an overlapping top-up is kept', async () => {
    const id = await mkProject('PMA-SIB')
    await assign(id, PM_DEV, 'manager')
    const [evt] = await t.client<{ id: string }[]>`
      INSERT INTO audit_event (event_type, subject_kind, subject_id, payload)
      VALUES ('allocation-created', 'project', ${id}::uuid, '{}'::jsonb) RETURNING id::text AS id`
    const row = async (kind: string, usd: number, range: string) => {
      const [a] = await t.client<{ id: string }[]>`
        INSERT INTO allocation (scope_type, scope_id, budget_usd, effective, allocation_kind, audit_event_id)
        VALUES ('project', ${id}::uuid, ${usd}, ${range}::tstzrange, ${kind}, ${evt!.id}::uuid)
        RETURNING id::text AS id`
      return a!.id
    }
    await row('baseline', 50, '[2026-01-01T00:00:00Z,2026-06-01T00:00:00Z)')
    await row('top-up', 25, '[2026-01-01T00:00:00Z,2026-02-01T00:00:00Z)')
    const current = await row('baseline', 100, '[2026-06-01T00:00:00Z,2099-01-01T00:00:00Z)')
    const overlapping = await row('top-up', 10, '[2026-07-01T00:00:00Z,2026-08-01T00:00:00Z)')

    const out = (await call(allocationGet as Handler, as(PM_DEV), { id: current }, undefined, 'GET')) as {
      siblings: { id: string }[]
    }
    expect(out.siblings.map((s) => s.id)).toEqual([overlapping])
  })
})

describe('project page payload: viewer.can_manage drives the Manage section', () => {
  it('true for the project’s PM, false for a plain member', async () => {
    const page = (who: string) =>
      call(projectPageGet as Handler, as(who), { code: 'PMA-P' }, undefined, 'GET') as Promise<{ viewer: { can_manage: boolean } }>
    expect((await page(PM_DEV)).viewer.can_manage).toBe(true)
    expect((await page(MEMBER)).viewer.can_manage).toBe(false)
  })

  it('an admin in scope who is not a member opens it to manage (the no-PM fallback); out of scope is 404', async () => {
    type Page = { viewer: { can_manage: boolean; access: string }; team: { members: unknown[] } }
    const page = (who: string) =>
      call(projectPageGet as Handler, as(who), { code: 'PMA-P' }, undefined, 'GET') as Promise<Page>
    for (const who of [ADMIN, PLATFORM]) {
      const out = await page(who)
      expect(out.viewer).toMatchObject({ can_manage: true, access: 'admin' })
      // Aggregates only, like a cou-owner: no named per-member rows.
      expect(out.team.members).toEqual([])
    }
    expect(await status(page(ADMIN_OTHER))).toBe(404)
    expect(await status(page(OUTSIDER))).toBe(404)
    // An org-role manager in scope is not an admin: still 404 off the membership.
    expect(await status(page(MGR))).toBe(404)
  })
})

describe('project page payload: the budget in effect reaches Manage, baseline or top-ups only (#513)', () => {
  type Page = {
    viewer: { budget_allocation_id: string | null; budget_topup_allocation_id: string | null; role: string }
    budget: { allocation_usd: string }
  }
  const page = (code: string) =>
    call(projectPageGet as Handler, as(PM_DEV), { code }, undefined, 'GET') as Promise<Page>
  async function mkRow(projectId: string, kind: string, usd: number, range: string, teammateId: string | null = null) {
    const [evt] = await t.client<{ id: string }[]>`
      INSERT INTO audit_event (event_type, subject_kind, subject_id, payload)
      VALUES ('allocation-created', 'project', ${projectId}::uuid, '{}'::jsonb) RETURNING id::text AS id`
    const [a] = await t.client<{ id: string }[]>`
      INSERT INTO allocation (scope_type, scope_id, teammate_id, budget_usd, effective, allocation_kind, audit_event_id)
      VALUES ('project', ${projectId}::uuid, ${teammateId}::uuid, ${usd}, ${range}::tstzrange, ${kind}, ${evt!.id}::uuid)
      RETURNING id::text AS id`
    return a!.id
  }

  it('top-ups only: no baseline id (the editor would treat a top-up as the total), the latest top-up instead', async () => {
    const id = await mkProject('PMA-TOPONLY')
    await assign(id, PM_DEV, 'manager')
    await mkRow(id, 'baseline', 500, '[2026-01-01T00:00:00Z,2026-02-01T00:00:00Z)') // expired
    const older = await mkRow(id, 'top-up', 1000, '[2026-01-01T00:00:00Z,2099-01-01T00:00:00Z)')
    const latest = await mkRow(id, 'top-up', 2000, '[2026-03-01T00:00:00Z,2099-01-01T00:00:00Z)')
    const out = await page('PMA-TOPONLY')
    expect(out.viewer.role).toBe('manager')
    expect(out.budget.allocation_usd).toBe('3000.00')
    expect(out.viewer.budget_allocation_id).toBeNull()
    expect(out.viewer.budget_topup_allocation_id).toBe(latest)
    expect(out.viewer.budget_topup_allocation_id).not.toBe(older)
  })

  it('a baseline in effect wins over a later top-up; a per-developer cap alone is no budget', async () => {
    const id = await mkProject('PMA-BASE')
    await assign(id, PM_DEV, 'manager')
    const base = await mkRow(id, 'baseline', 1000, '[2026-01-01T00:00:00Z,2099-01-01T00:00:00Z)')
    await mkRow(id, 'top-up', 200, '[2026-06-01T00:00:00Z,2099-01-01T00:00:00Z)')
    expect((await page('PMA-BASE')).viewer).toMatchObject({ budget_allocation_id: base, budget_topup_allocation_id: null })

    const capOnly = await mkProject('PMA-CAPONLY')
    await assign(capOnly, PM_DEV, 'manager')
    await mkRow(capOnly, 'baseline', 300, '[2026-01-01T00:00:00Z,2099-01-01T00:00:00Z)', PM_DEV)
    const out = await page('PMA-CAPONLY')
    expect(out.budget.allocation_usd).toBe('0.00')
    expect(out.viewer).toMatchObject({ budget_allocation_id: null, budget_topup_allocation_id: null })
  })
})

describe('PATCH /projects/{id}/timeline: PM of the project or an admin, never an org-role manager (A1)', () => {
  const end = (d: string | null) => ({ end_date: d })

  it.each([
    ['developer-role PM', PM_DEV, 200],
    ['region admin', ADMIN, 200],
    ['platform-admin', PLATFORM, 200],
    ['org-role manager who is not the PM', MGR, 403],
    ['admin of another region', ADMIN_OTHER, 403],
    ['member', MEMBER, 403],
    ['non-member', OUTSIDER, 403],
  ])('%s → %i', async (_label, who, expected) => {
    expect(await status(call(timelinePatch as Handler, as(who), { id: P }, end('2099-06-30T00:00:00Z'), 'PATCH'))).toBe(expected)
  })

  it('writes the end date, clears it with null, and audits before and after', async () => {
    await call(timelinePatch as Handler, as(PM_DEV), { id: P }, end('2099-07-31T00:00:00Z'), 'PATCH')
    const out = (await call(timelinePatch as Handler, as(PM_DEV), { id: P }, end(null), 'PATCH')) as { end_date: string | null }
    expect(out.end_date).toBeNull()
    const [a] = await t.client<{ before: string; after: unknown; via: string }[]>`
      SELECT payload->'before'->>'end_date' AS before, payload->'changed'->'end_date' AS after, payload->'context'->>'via' AS via
      FROM audit_event WHERE event_type = 'project-updated' AND subject_id = ${P}::uuid
      ORDER BY ts_recorded DESC, id DESC LIMIT 1`
    expect(a!.before).toContain('2099-07-31')
    expect(a!.after).toBeNull()
    expect(a!.via).toBe('project-manager')
  })

  it('validates the body (400) and 404s an unknown project', async () => {
    expect(await status(call(timelinePatch as Handler, as(PM_DEV), { id: P }, { end_date: 'soon' }, 'PATCH'))).toBe(400)
    expect(await status(call(timelinePatch as Handler, as(PLATFORM), { id: U(999) }, end(null), 'PATCH'))).toBe(404)
  })
})

describe('last-PM rule (A5)', () => {
  it('a PM cannot remove or demote the project’s last PM, themselves included', async () => {
    const del = await status(call(assignmentDelete as Handler, as(PM_DEV), { id: L, teammateId: PM_DEV }, undefined, 'DELETE'))
    expect(del).toBe(409)
    const demote = await status(call(assignmentPatch as Handler, as(PM_DEV), { id: L, teammateId: PM_DEV }, { role: 'member' }, 'PATCH'))
    expect(demote).toBe(409)
    // An org-role manager in scope is not an admin either.
    expect(await status(call(assignmentDelete as Handler, as(MGR), { id: L, teammateId: PM_DEV }, undefined, 'DELETE'))).toBe(409)
    const [pm] = await t.client<{ role: string; open: boolean }[]>`
      SELECT role, upper_inf(effective) AS open FROM project_assignment WHERE project_id = ${L}::uuid AND teammate_id = ${PM_DEV}::uuid`
    expect(pm).toEqual({ role: 'manager', open: true })
  })

  it('removing a plain member is unaffected', async () => {
    expect(await status(call(assignmentDelete as Handler, as(PM_DEV), { id: L, teammateId: MEMBER }, undefined, 'DELETE'))).toBe(200)
  })

  it('a last PM whose own assignment is finite cannot demote themselves (no open-ended PM before or after)', async () => {
    const id = await mkProject('PMA-FIN')
    await t.client`INSERT INTO project_assignment (project_id, teammate_id, effective, role)
      VALUES (${id}::uuid, ${PM_DEV}::uuid, '[2026-01-01T00:00:00Z,2099-01-01T00:00:00Z)', 'manager')`
    await assign(id, MEMBER, 'member')
    expect(await status(call(assignmentPatch as Handler, as(PM_DEV), { id, teammateId: PM_DEV }, { role: 'member' }, 'PATCH'))).toBe(409)
    const [pm] = await t.client<{ role: string }[]>`
      SELECT role FROM project_assignment WHERE project_id = ${id}::uuid AND teammate_id = ${PM_DEV}::uuid`
    expect(pm!.role).toBe('manager')
    // Making an open-ended member PM first, then stepping down, is allowed.
    await call(assignmentPatch as Handler, as(PM_DEV), { id, teammateId: MEMBER }, { role: 'manager' }, 'PATCH')
    expect(await status(call(assignmentPatch as Handler, as(PM_DEV), { id, teammateId: PM_DEV }, { role: 'member' }, 'PATCH'))).toBe(200)
  })

  it('an admin may leave a project without a PM', async () => {
    expect(await status(call(assignmentPatch as Handler, as(ADMIN), { id: L, teammateId: PM_DEV }, { role: 'member' }, 'PATCH'))).toBe(200)
  })

  it('two PMs demoting themselves at the same time: one wins, the other gets 409, one PM remains', async () => {
    const results = await Promise.all([
      status(call(assignmentPatch as Handler, as(PM_A), { id: C, teammateId: PM_A }, { role: 'member' }, 'PATCH')),
      status(call(assignmentPatch as Handler, as(PM_B), { id: C, teammateId: PM_B }, { role: 'member' }, 'PATCH')),
    ])
    expect([...results].sort()).toEqual([200, 409])
    const [n] = await t.client<{ n: number }[]>`
      SELECT COUNT(*)::int AS n FROM project_assignment WHERE project_id = ${C}::uuid AND role = 'manager'`
    expect(n!.n).toBe(1)
  })
})

/*
 * A PM is demoted by an admin while they act. The admin's transaction holds the
 * project row lock (as the role-change route does) with the demotion written but
 * not committed; the PM's request starts inside that window. Each route must
 * wait for the lock and only then read the PM's standing, so it sees the
 * demotion: without the lock it reads the old, committed "manager" row and goes
 * through.
 */
describe('a PM demoted concurrently cannot act on the project (lock before the gate)', () => {
  const blockedBackends = async () => {
    const [r] = await t.client<{ n: number }[]>`
      SELECT COUNT(*)::int AS n FROM pg_stat_activity
       WHERE wait_event_type = 'Lock' AND datname = current_database()`
    return r!.n
  }

  async function duringDemotion(projectId: string, pm: string, act: () => Promise<unknown>): Promise<number> {
    let release!: () => void
    const released = new Promise<void>((r) => (release = r))
    let locked!: () => void
    const isLocked = new Promise<void>((r) => (locked = r))
    const admin = t.client.begin(async (tx) => {
      await tx`SELECT 1 FROM project WHERE id = ${projectId}::uuid FOR UPDATE`
      await tx`UPDATE project_assignment SET role = 'member'
               WHERE project_id = ${projectId}::uuid AND teammate_id = ${pm}::uuid`
      locked()
      await released
    })
    await isLocked
    let settled = false
    const result = status(act()).finally(() => (settled = true))
    // Wait until the PM's request is queued behind the lock, or has finished
    // without waiting (the unfixed route) — either way, then commit the demotion.
    for (let i = 0; i < 400 && !settled && (await blockedBackends()) < 1; i++) {
      await new Promise((r) => setTimeout(r, 25))
    }
    release()
    await admin
    return result
  }

  async function demotableProject(code: string): Promise<{ id: string; pool: string }> {
    const id = await mkProject(code)
    await assign(id, PM_A, 'manager')
    await assign(id, PM_B, 'manager')
    return { id, pool: await mkPool(id) }
  }

  it('POST assignments: the demoted PM cannot add a manager', async () => {
    const p = await demotableProject('PMA-R1')
    const code = await duringDemotion(p.id, PM_A, () =>
      call(assignmentsPost as Handler, as(PM_A), { id: p.id }, { teammate_id: OUTSIDER, role: 'manager' }),
    )
    expect(code).toBe(403)
    const [n] = await t.client<{ n: number }[]>`
      SELECT COUNT(*)::int AS n FROM project_assignment WHERE project_id = ${p.id}::uuid AND teammate_id = ${OUTSIDER}::uuid`
    expect(n!.n).toBe(0)
  }, 30_000)

  it('PATCH allocation: the demoted PM cannot edit the pool', async () => {
    const p = await demotableProject('PMA-R2')
    const body = { budget_usd: '5000', effective: '[2026-01-01T00:00:00Z,2099-01-01T00:00:00Z)' }
    const code = await duringDemotion(p.id, PM_A, () => call(allocationPatch as Handler, as(PM_A), { id: p.pool }, body, 'PATCH'))
    expect(code).toBe(404)
    const [row] = await t.client<{ b: string }[]>`SELECT budget_usd::text AS b FROM allocation WHERE id = ${p.pool}::uuid`
    expect(row!.b).toBe('1000.00')
  }, 30_000)

  it('timeline: the demoted PM cannot change the end date', async () => {
    const p = await demotableProject('PMA-R4')
    const code = await duringDemotion(p.id, PM_A, () =>
      call(timelinePatch as Handler, as(PM_A), { id: p.id }, { end_date: '2099-06-30T00:00:00Z' }, 'PATCH'),
    )
    expect(code).toBe(403)
    const [row] = await t.client<{ end_date: string | null }[]>`SELECT end_date::text AS end_date FROM project WHERE id = ${p.id}::uuid`
    expect(row!.end_date).toBeNull()
  }, 30_000)

  it('POST /allocations: the demoted PM cannot create a baseline', async () => {
    const p = await demotableProject('PMA-R5')
    const code = await duringDemotion(p.id, PM_A, () =>
      call(allocationsPost as Handler, as(PM_A), {}, {
        project_id: p.id,
        budget_usd: '50',
        effective: '[2099-02-01T00:00:00Z,2099-03-01T00:00:00Z)',
      }),
    )
    expect(code).toBe(403)
    const [n] = await t.client<{ n: number }[]>`
      SELECT COUNT(*)::int AS n FROM allocation WHERE scope_id = ${p.id}::uuid`
    expect(n!.n).toBe(1)
  }, 30_000)

  it('top-up: the demoted PM cannot add budget', async () => {
    const p = await demotableProject('PMA-R6')
    const code = await duringDemotion(p.id, PM_A, () =>
      call(topupsPost as Handler, as(PM_A), { id: p.pool }, {
        budget_usd: '50',
        effective: '[2026-01-01T00:00:00Z,2099-01-01T00:00:00Z)',
      }),
    )
    // PM_A still manages another project (PMA-C), so the coarse pre-gate passes
    // and the project's own gate, read under the lock, refuses with 404.
    expect(code).toBe(404)
    const [n] = await t.client<{ n: number }[]>`
      SELECT COUNT(*)::int AS n FROM allocation WHERE scope_id = ${p.id}::uuid AND allocation_kind = 'top-up'`
    expect(n!.n).toBe(0)
  }, 30_000)

  it('split: the demoted PM cannot set caps', async () => {
    const p = await demotableProject('PMA-R3')
    const code = await duringDemotion(p.id, PM_A, () =>
      call(splitPost as Handler, as(PM_A), { id: p.pool }, { mode: 'per_dev_fixed', caps: [{ teammate_id: PM_B, budget_usd: '10' }] }),
    )
    expect(code).toBe(403)
    const [n] = await t.client<{ n: number }[]>`
      SELECT COUNT(*)::int AS n FROM allocation WHERE scope_id = ${p.id}::uuid AND teammate_id IS NOT NULL`
    expect(n!.n).toBe(0)
  }, 30_000)
})

describe('a PM removed while their request waits on the project lock is refused (post-lock instant)', () => {
  const blockedBackends = async () => {
    const [r] = await t.client<{ n: number }[]>`
      SELECT COUNT(*)::int AS n FROM pg_stat_activity
       WHERE wait_event_type = 'Lock' AND datname = current_database()`
    return r!.n
  }

  // The request clock is read lazily, on first use, so a route that first reads
  // it after the lock would pass these tests by accident. Pinning it before the
  // request blocks, as any early read in the handler would, makes every test
  // here fail on a route that judges PM standing at the request clock.
  const callPinned = (h: Handler, session: Session, params: Record<string, string>, body?: unknown, method?: string) => {
    const e = ev({ session, params, body, method }) as unknown as { context: Record<string, unknown> }
    e.context.serverClock = resolveServerClock(new Date())
    return h(e as never)
  }

  // Hold the project lock until the request is queued behind it, then end
  // `who`'s assignment at the database clock, as a removal committed after the
  // request clock was read does. (The remove route ends it at its own
  // transaction's start, NOW(); clock_timestamp() is later still, the harder
  // case.) Judged at the pinned request clock, the removed PM would still count.
  async function duringRemoval(projectId: string, who: string, act: () => Promise<unknown>): Promise<number> {
    let release!: () => void
    const released = new Promise<void>((r) => (release = r))
    let locked!: () => void
    const isLocked = new Promise<void>((r) => (locked = r))
    const admin = t.client.begin(async (tx) => {
      await tx`SELECT 1 FROM project WHERE id = ${projectId}::uuid FOR UPDATE`
      locked()
      await released
      await tx`UPDATE project_assignment SET effective = tstzrange(lower(effective), clock_timestamp())
               WHERE project_id = ${projectId}::uuid AND teammate_id = ${who}::uuid AND upper_inf(effective)`
    })
    await isLocked
    let settled = false
    const result = status(act()).finally(() => (settled = true))
    for (let i = 0; i < 400 && !settled && (await blockedBackends()) < 1; i++) {
      await new Promise((r) => setTimeout(r, 25))
    }
    // The request must really be waiting on the lock: one that failed before
    // reaching it (a bad fixture, a 404 for another reason) proves nothing.
    const waited = !settled && (await blockedBackends()) >= 1
    release()
    await admin
    expect(waited, 'the request did not wait on the project lock').toBe(true)
    return result
  }

  async function removableProject(code: string): Promise<{ id: string; pool: string }> {
    const id = await mkProject(code)
    await assign(id, PM_A, 'manager')
    await assign(id, PM_B, 'manager')
    await assign(id, MEMBER, 'member')
    return { id, pool: await mkPool(id) }
  }

  const openAssignments = async (projectId: string, who: string) => {
    const [n] = await t.client<{ n: number }[]>`
      SELECT COUNT(*)::int AS n FROM project_assignment
       WHERE project_id = ${projectId}::uuid AND teammate_id = ${who}::uuid AND upper_inf(effective)`
    return n!.n
  }

  it('POST assignments: the removed PM cannot add a manager', async () => {
    const p = await removableProject('PMA-X1')
    const code = await duringRemoval(p.id, PM_A, () =>
      callPinned(assignmentsPost as Handler, as(PM_A), { id: p.id }, { teammate_id: OUTSIDER, role: 'manager' }),
    )
    expect(code).toBe(403)
    expect(await openAssignments(p.id, OUTSIDER)).toBe(0)
  }, 30_000)

  it('DELETE assignment: the removed PM cannot remove the other manager', async () => {
    const p = await removableProject('PMA-X2')
    const code = await duringRemoval(p.id, PM_A, () =>
      callPinned(assignmentDelete as Handler, as(PM_A), { id: p.id, teammateId: PM_B }, undefined, 'DELETE'),
    )
    expect(code).toBe(403)
    expect(await openAssignments(p.id, PM_B)).toBe(1)
  }, 30_000)

  it('PATCH assignment: the removed PM cannot demote the other manager', async () => {
    const p = await removableProject('PMA-X3')
    const code = await duringRemoval(p.id, PM_A, () =>
      callPinned(assignmentPatch as Handler, as(PM_A), { id: p.id, teammateId: PM_B }, { role: 'member' }, 'PATCH'),
    )
    expect(code).toBe(403)
    const [row] = await t.client<{ role: string }[]>`
      SELECT role FROM project_assignment WHERE project_id = ${p.id}::uuid AND teammate_id = ${PM_B}::uuid`
    expect(row!.role).toBe('manager')
  }, 30_000)

  it('timeline: the removed PM cannot change the end date', async () => {
    const p = await removableProject('PMA-X4')
    const code = await duringRemoval(p.id, PM_A, () =>
      callPinned(timelinePatch as Handler, as(PM_A), { id: p.id }, { end_date: '2099-06-30T00:00:00Z' }, 'PATCH'),
    )
    expect(code).toBe(403)
    const [row] = await t.client<{ end_date: string | null }[]>`SELECT end_date::text AS end_date FROM project WHERE id = ${p.id}::uuid`
    expect(row!.end_date).toBeNull()
  }, 30_000)

  it('POST /allocations: the removed PM cannot create a baseline', async () => {
    const p = await removableProject('PMA-X5')
    const code = await duringRemoval(p.id, PM_A, () =>
      callPinned(allocationsPost as Handler, as(PM_A), {}, {
        project_id: p.id,
        budget_usd: '50',
        effective: '[2099-02-01T00:00:00Z,2099-03-01T00:00:00Z)',
      }),
    )
    expect(code).toBe(403)
    const [n] = await t.client<{ n: number }[]>`SELECT COUNT(*)::int AS n FROM allocation WHERE scope_id = ${p.id}::uuid`
    expect(n!.n).toBe(1)
  }, 30_000)

  it('PATCH allocation: the removed PM cannot edit the pool', async () => {
    const p = await removableProject('PMA-X6')
    const body = { budget_usd: '5000', effective: '[2026-01-01T00:00:00Z,2099-01-01T00:00:00Z)' }
    const code = await duringRemoval(p.id, PM_A, () => callPinned(allocationPatch as Handler, as(PM_A), { id: p.pool }, body, 'PATCH'))
    expect(code).toBe(404)
    const [row] = await t.client<{ b: string }[]>`SELECT budget_usd::text AS b FROM allocation WHERE id = ${p.pool}::uuid`
    expect(row!.b).toBe('1000.00')
  }, 30_000)

  it('top-up: the removed PM cannot add budget', async () => {
    const p = await removableProject('PMA-X7')
    const code = await duringRemoval(p.id, PM_A, () =>
      callPinned(topupsPost as Handler, as(PM_A), { id: p.pool }, {
        budget_usd: '50',
        effective: '[2026-01-01T00:00:00Z,2099-01-01T00:00:00Z)',
      }),
    )
    // PM_A still manages other projects, so the coarse pre-gate passes and the
    // project's own gate, judged after the lock, refuses with 404.
    expect(code).toBe(404)
    const [n] = await t.client<{ n: number }[]>`
      SELECT COUNT(*)::int AS n FROM allocation WHERE scope_id = ${p.id}::uuid AND allocation_kind = 'top-up'`
    expect(n!.n).toBe(0)
  }, 30_000)

  it('split: the removed PM cannot set caps', async () => {
    const p = await removableProject('PMA-X8')
    const code = await duringRemoval(p.id, PM_A, () =>
      callPinned(splitPost as Handler, as(PM_A), { id: p.pool }, { mode: 'per_dev_fixed', caps: [{ teammate_id: PM_B, budget_usd: '10' }] }),
    )
    expect(code).toBe(403)
    const [n] = await t.client<{ n: number }[]>`
      SELECT COUNT(*)::int AS n FROM allocation WHERE scope_id = ${p.id}::uuid AND teammate_id IS NOT NULL`
    expect(n!.n).toBe(0)
  }, 30_000)

  it('PATCH assignment: a member removed while the request waited is not re-roled on their closed range', async () => {
    const p = await removableProject('PMA-X10')
    const code = await duringRemoval(p.id, MEMBER, () =>
      callPinned(assignmentPatch as Handler, as(PM_A), { id: p.id, teammateId: MEMBER }, { role: 'manager' }, 'PATCH'),
    )
    expect(code).toBe(404)
    const [row] = await t.client<{ role: string }[]>`
      SELECT role FROM project_assignment WHERE project_id = ${p.id}::uuid AND teammate_id = ${MEMBER}::uuid`
    expect(row!.role).toBe('member')
  }, 30_000)

  it('control: a PM who is still a PM edits the pool after waiting while someone else is removed', async () => {
    const p = await removableProject('PMA-X11')
    const body = { budget_usd: '5000', effective: '[2026-01-01T00:00:00Z,2099-01-01T00:00:00Z)' }
    const code = await duringRemoval(p.id, MEMBER, () => callPinned(allocationPatch as Handler, as(PM_A), { id: p.pool }, body, 'PATCH'))
    expect(code).toBe(200)
    const [row] = await t.client<{ b: string }[]>`SELECT budget_usd::text AS b FROM allocation WHERE id = ${p.pool}::uuid`
    expect(row!.b).toBe('5000.00')
  }, 30_000)

  it('control: an admin in scope acts normally after waiting while a PM is removed', async () => {
    const p = await removableProject('PMA-X12')
    const code = await duringRemoval(p.id, PM_A, () =>
      callPinned(timelinePatch as Handler, as(ADMIN), { id: p.id }, { end_date: '2099-06-30T00:00:00Z' }, 'PATCH'),
    )
    expect(code).toBe(200)
  }, 30_000)

  it('control: a PM who is still a PM acts normally after waiting while someone else is removed', async () => {
    const p = await removableProject('PMA-X9')
    const code = await duringRemoval(p.id, MEMBER, () =>
      callPinned(timelinePatch as Handler, as(PM_A), { id: p.id }, { end_date: '2099-06-30T00:00:00Z' }, 'PATCH'),
    )
    expect(code).toBe(200)
    const [row] = await t.client<{ end_date: string | null }[]>`SELECT end_date::text AS end_date FROM project WHERE id = ${p.id}::uuid`
    expect(row!.end_date).not.toBeNull()
  }, 30_000)
})
