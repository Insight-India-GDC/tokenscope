// @vitest-environment node
/*
 * Budget requests (quota_request, mig 0165) through the real route handlers —
 * docs/design/project-requests/00-spec.md §5 and amendments A6/A7, A8, A9, A10,
 * A12.
 *
 * Pins:
 *   - only current members file; one pending per (project, requester);
 *   - who decides: the project's PM or an admin in scope, never an org-role
 *     manager who is not the PM;
 *   - approving raises the project total by EXACTLY $Y and the requester's
 *     personal figure by $Y, read through the real readers
 *     (fetchProjectAllocation, getMyUsage), on a shared-pool AND a per-developer
 *     project;
 *   - a second decision is 409, sequential or concurrent; ended project 409; no
 *     budget 409 — each leaving the request pending;
 *   - inbox: managers notified, their items resolved on the decision, requester
 *     told; no PM → the region's admins;
 *   - project delete still works with requests on it (cascade).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'
import { injectTestSession } from '../../helpers/auth'
import type { Session } from '../../../server/utils/auth'
import { fetchProjectAllocation } from '../../../server/usage/consumption'
import { getMyUsage } from '../../../server/utils/me-queries'
import listGet from '../../../server/api/v1/projects/[id]/budget-requests/index.get'
import filePost from '../../../server/api/v1/projects/[id]/budget-requests/index.post'
import withdrawPost from '../../../server/api/v1/projects/[id]/budget-requests/[reqId]/withdraw.post'
import approvePost from '../../../server/api/v1/projects/[id]/budget-requests/[reqId]/approve.post'
import rejectPost from '../../../server/api/v1/projects/[id]/budget-requests/[reqId]/reject.post'
import projectDelete from '../../../server/api/v1/admin/projects/[id].delete'
import allocationPatch from '../../../server/api/v1/allocations/[id].patch'
import allocationGet from '../../../server/api/v1/allocations/[id].get'
import splitPost from '../../../server/api/v1/allocations/[id]/split.post'

let t: TestDb
let regionId = ''
let otherRegionId = ''
let pracId = ''

const U = (n: number) => `9a1e0000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`
const PM = U(1) // developer-role PM of every project below
const MEMBER = U(2)
const MEMBER2 = U(3) // per-dev project: no cap row
const MGR = U(4) // org-role manager in scope, not a PM
const ADMIN = U(5)
const ADMIN_OTHER = U(6)
const PLATFORM = U(7)
const OUTSIDER = U(8)

let S = '' // shared pool
let D = '' // per-developer
let N = '' // no budget
let E = '' // ended
let X = '' // no PM
let poolS = ''

type Handler = (e: never) => Promise<unknown>
interface Row {
  id: string
  status: string
  amount_usd: string
  approved_amount_usd: string | null
}

const ROLE_OF: Record<string, { role: string; region: () => string; orgPath: string }> = {
  [PM]: { role: 'developer', region: () => regionId, orgPath: 'bra.prac' },
  [MEMBER]: { role: 'developer', region: () => regionId, orgPath: 'bra.prac' },
  [MEMBER2]: { role: 'developer', region: () => regionId, orgPath: 'bra.prac' },
  [MGR]: { role: 'manager', region: () => regionId, orgPath: 'bra.prac' },
  [ADMIN]: { role: 'admin', region: () => regionId, orgPath: 'bra' },
  [ADMIN_OTHER]: { role: 'admin', region: () => otherRegionId, orgPath: 'brb' },
  [PLATFORM]: { role: 'platform-admin', region: () => otherRegionId, orgPath: 'brb' },
  [OUTSIDER]: { role: 'developer', region: () => regionId, orgPath: 'bra.prac' },
}
const as = (id: string): Session => {
  const r = ROLE_OF[id]!
  return { teammateId: id, email: `${id}@x.test`, displayName: id, role: r.role, regionId: r.region(), orgPath: r.orgPath } as Session
}

function ev(opts: { session: Session; params: Record<string, string>; body?: unknown; method: string }) {
  const headers: Record<string, string> = {
    host: 'localhost:3450',
    origin: 'http://localhost:3450',
    'content-type': 'application/json',
  }
  const e = {
    method: opts.method,
    path: '/x',
    context: { params: opts.params },
    node: {
      req: { method: opts.method, url: '/x', body: opts.body, headers, socket: { remoteAddress: '127.0.0.1' } },
      res: {
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

const file = (who: string, project: string, body: unknown) =>
  (filePost as Handler)(ev({ session: as(who), params: { id: project }, body, method: 'POST' })) as Promise<Row>
const list = (who: string, project: string) =>
  (listGet as Handler)(ev({ session: as(who), params: { id: project }, method: 'GET' })) as Promise<{
    mine: Row[]
    pending: Row[] | null
    can_decide: boolean
  }>
const approve = (who: string, project: string, reqId: string, body: unknown = {}) =>
  (approvePost as Handler)(ev({ session: as(who), params: { id: project, reqId }, body, method: 'POST' })) as Promise<Row>
const reject = (who: string, project: string, reqId: string, body: unknown) =>
  (rejectPost as Handler)(ev({ session: as(who), params: { id: project, reqId }, body, method: 'POST' })) as Promise<Row>
const withdraw = (who: string, project: string, reqId: string) =>
  (withdrawPost as Handler)(ev({ session: as(who), params: { id: project, reqId }, method: 'POST' })) as Promise<Row>
const patchPool = (who: string, poolId: string, body: unknown) =>
  (allocationPatch as Handler)(ev({ session: as(who), params: { id: poolId }, body, method: 'PATCH' }))
const split = (who: string, poolId: string, body: unknown) =>
  (splitPost as Handler)(ev({ session: as(who), params: { id: poolId }, body, method: 'POST' }))
const editor = (who: string, poolId: string) =>
  (allocationGet as Handler)(ev({ session: as(who), params: { id: poolId }, method: 'GET' })) as Promise<{
    per_dev_caps: { teammate_id: string; budget_usd: string }[]
  }>

async function status(p: Promise<unknown>): Promise<number> {
  try {
    await p
    return 200
  } catch (e) {
    return (e as { statusCode?: number }).statusCode ?? 500
  }
}

async function mkProject(code: string, opts: { mode?: string; endDate?: string } = {}): Promise<string> {
  const [p] = await t.client<{ id: string }[]>`
    INSERT INTO project (code, code_hash, display_name, type, region_id, cost_owning_unit_id, allocation_mode, end_date)
    VALUES (${code}, ${'h-' + code}, ${code + ' name'}, 'billable', ${regionId}::uuid, ${pracId}::uuid,
            ${opts.mode ?? 'shared_pool'}, ${opts.endDate ?? null}::timestamptz)
    RETURNING id::text AS id`
  return p!.id
}
async function assign(projectId: string, teammateId: string, role: 'manager' | 'member') {
  await t.client`INSERT INTO project_assignment (project_id, teammate_id, effective, role)
    VALUES (${projectId}::uuid, ${teammateId}::uuid, '[2026-01-01T00:00:00Z,)', ${role})`
}
const PERIOD = '[2026-01-01T00:00:00Z,2099-01-01T00:00:00Z)'
async function mkAllocation(projectId: string, budget: number, teammateId: string | null = null): Promise<string> {
  const [evt] = await t.client<{ id: string }[]>`
    INSERT INTO audit_event (event_type, subject_kind, subject_id, payload)
    VALUES ('allocation-created', 'project', ${projectId}::uuid, '{}'::jsonb) RETURNING id::text AS id`
  const [a] = await t.client<{ id: string }[]>`
    INSERT INTO allocation (scope_type, scope_id, teammate_id, budget_usd, effective, allocation_kind, audit_event_id)
    VALUES ('project', ${projectId}::uuid, ${teammateId}::uuid, ${budget}, ${PERIOD}, 'baseline', ${evt!.id}::uuid)
    RETURNING id::text AS id`
  return a!.id
}

/** The two readers A7 names: the project total and the requester's own figure. */
async function readers(projectId: string, code: string, teammateId: string) {
  const projectTotal = await fetchProjectAllocation(t.db, projectId)
  const usage = await getMyUsage(t.db, teammateId)
  const bucket = usage.buckets.find((b) => b.project_code === code)
  return { projectTotal, personal: Number(bucket?.allocation_total_usd ?? NaN) }
}

const inboxFor = (recipient: string, category: string) =>
  t.client<{ ack_state: string; body: Record<string, unknown> }[]>`
    SELECT ack_state, body FROM inbox_item WHERE recipient_teammate_id = ${recipient}::uuid AND category = ${category}
    ORDER BY created_at DESC`

beforeAll(async () => {
  t = await startTestDb()
  process.env.DATABASE_URL = t.url
  const [r] = await t.client<{ id: string }[]>`INSERT INTO region (code, display_name) VALUES ('bra', 'BRA') RETURNING id::text AS id`
  regionId = r!.id
  const [r2] = await t.client<{ id: string }[]>`INSERT INTO region (code, display_name) VALUES ('brb', 'BRB') RETURNING id::text AS id`
  otherRegionId = r2!.id
  const [root] = await t.client<{ id: string }[]>`INSERT INTO org_unit (region_id, path, code, display_name, unit_type, is_cost_owning_unit)
    VALUES (${regionId}::uuid, 'bra', 'default', 'BRA', 'bu', true) RETURNING id::text AS id`
  const [prac] = await t.client<{ id: string }[]>`INSERT INTO org_unit (region_id, parent_id, path, code, display_name, unit_type, is_cost_owning_unit)
    VALUES (${regionId}::uuid, ${root!.id}::uuid, 'bra.prac', 'prac', 'Practice', 'practice', true) RETURNING id::text AS id`
  pracId = prac!.id
  const [root2] = await t.client<{ id: string }[]>`INSERT INTO org_unit (region_id, path, code, display_name, unit_type, is_cost_owning_unit)
    VALUES (${otherRegionId}::uuid, 'brb', 'default', 'BRB', 'bu', true) RETURNING id::text AS id`
  for (const [id, rr] of Object.entries(ROLE_OF)) {
    const unit = rr.region() === regionId ? pracId : root2!.id
    await t.client`INSERT INTO teammate (id, entra_oid, email, display_name, region_id, org_unit_id, role)
      VALUES (${id}::uuid, ${'oid-' + id}, ${id + '@x.test'}, ${'Name ' + id.slice(-2)}, ${rr.region()}::uuid, ${unit}::uuid, ${rr.role})`
  }

  S = await mkProject('BR-S')
  D = await mkProject('BR-D', { mode: 'per_dev_fixed' })
  N = await mkProject('BR-N')
  E = await mkProject('BR-E', { endDate: '2026-02-01T00:00:00Z' })
  X = await mkProject('BR-X')
  for (const p of [S, D, N, E]) {
    await assign(p, PM, 'manager')
    await assign(p, MEMBER, 'member')
  }
  await assign(D, MEMBER2, 'member')
  await assign(X, MEMBER, 'member')
  poolS = await mkAllocation(S, 1000)
  await mkAllocation(D, 1000)
  await mkAllocation(D, 300, MEMBER)
  await mkAllocation(E, 1000)
  await mkAllocation(X, 1000)
}, 180_000)

afterAll(async () => {
  if (t) await stopTestDb(t)
}, 30_000)

describe('filing', () => {
  it('a member files; the PM gets an inbox item; the request is audited', async () => {
    const row = await file(MEMBER, S, { amount_usd: '50', reason: 'Load testing week' })
    expect(row).toMatchObject({ status: 'pending', amount_usd: '50.00' })
    const items = await inboxFor(PM, 'quota-request')
    expect(items[0]!.body).toMatchObject({ quota_request_id: row.id, project_code: 'BR-S', amount_usd: '50' })
    const [a] = await t.client<{ n: number }[]>`
      SELECT COUNT(*)::int AS n FROM audit_event WHERE event_type = 'budget-request-filed' AND subject_id = ${row.id}::uuid`
    expect(a!.n).toBe(1)
  })

  it('one pending request per member and project (409); a non-member is refused (403); bad input is 400', async () => {
    expect(await status(file(MEMBER, S, { amount_usd: '10', reason: 'again' }))).toBe(409)
    expect(await status(file(OUTSIDER, S, { amount_usd: '10', reason: 'please' }))).toBe(403)
    expect(await status(file(MEMBER, D, { amount_usd: '0', reason: 'zero' }))).toBe(400)
    expect(await status(file(MEMBER, D, { amount_usd: '10', reason: '' }))).toBe(400)
    expect(await status(file(MEMBER, E, { amount_usd: '10', reason: 'ended' }))).toBe(409)
  })

  it('a project with no PM notifies its region’s admins', async () => {
    await file(MEMBER, X, { amount_usd: '20', reason: 'nobody manages this' })
    expect((await inboxFor(ADMIN, 'quota-request')).length).toBe(1)
    expect((await inboxFor(ADMIN_OTHER, 'quota-request')).length).toBe(0)
  })
})

describe('listing', () => {
  it('the requester sees their own; the PM and admins also see the pending queue; an org-role manager does not', async () => {
    const mine = await list(MEMBER, S)
    expect(mine.mine.length).toBe(1)
    expect(mine.pending).toBeNull()
    expect((await list(PM, S)).pending!.length).toBe(1)
    expect((await list(ADMIN, S)).can_decide).toBe(true)
    expect((await list(PLATFORM, S)).can_decide).toBe(true)
    expect((await list(MGR, S)).can_decide).toBe(false)
    expect((await list(ADMIN_OTHER, S)).pending).toBeNull()
  })
})

describe('deciding: who', () => {
  it.each([
    ['member', MEMBER],
    ['org-role manager who is not the PM', MGR],
    ['admin of another region', ADMIN_OTHER],
    ['non-member', OUTSIDER],
  ])('%s → 403', async (_l, who) => {
    const [req] = (await list(PM, S)).pending!
    expect(await status(approve(who, S, req!.id))).toBe(403)
    expect(await status(reject(who, S, req!.id, { note: 'no' }))).toBe(403)
  })
})

describe('approving: exact amounts through the real readers (A7)', () => {
  it('shared pool: a different amount, $40 of $50 asked — project total and personal figure both rise by exactly $40', async () => {
    const [req] = (await list(PM, S)).pending!
    const before = await readers(S, 'BR-S', MEMBER)
    const out = await approve(PM, S, req!.id, { amount_usd: '40', note: 'Half now' })
    expect(out).toMatchObject({ status: 'approved', approved_amount_usd: '40.00' })
    const after = await readers(S, 'BR-S', MEMBER)
    expect(after.projectTotal - before.projectTotal).toBeCloseTo(40, 2)
    expect(after.personal - before.personal).toBeCloseTo(40, 2)

    const [link] = await t.client<{ kind: string; budget: string; teammate: string | null }[]>`
      SELECT a.allocation_kind AS kind, a.budget_usd::text AS budget, a.teammate_id::text AS teammate
      FROM quota_request q JOIN allocation a ON a.id = q.allocation_id WHERE q.id = ${req!.id}::uuid`
    expect(link).toEqual({ kind: 'top-up', budget: '40.00', teammate: null })
    const [topupAudit] = await t.client<{ via: string; qr: string }[]>`
      SELECT payload->'context'->>'via' AS via, payload->'context'->>'quota_request_id' AS qr
      FROM audit_event WHERE event_type = 'allocation-topup-added' AND subject_id = ${poolS}::uuid`
    expect(topupAudit).toEqual({ via: 'project-manager', qr: req!.id })

    // The manager's item is resolved; the requester is told.
    expect((await inboxFor(PM, 'quota-request'))[0]!.ack_state).toBe('resolved')
    expect((await inboxFor(MEMBER, 'quota-request-decided'))[0]!.body).toMatchObject({
      decision: 'approved',
      approved_amount_usd: '40.00',
    })
  })

  it('a second decision on the same request is 409, approve or reject', async () => {
    const [req] = (await list(MEMBER, S)).mine
    expect(await status(approve(PM, S, req!.id))).toBe(409)
    expect(await status(reject(ADMIN, S, req!.id, { note: 'late' }))).toBe(409)
  })

  it('per-developer, capped requester: project total +$25 (not 2×) and their cap +$25', async () => {
    const req = await file(MEMBER, D, { amount_usd: '25', reason: 'More tokens' })
    const before = await readers(D, 'BR-D', MEMBER)
    await approve(ADMIN, D, req.id)
    const after = await readers(D, 'BR-D', MEMBER)
    expect(after.projectTotal - before.projectTotal).toBeCloseTo(25, 2)
    expect(after.personal - before.personal).toBeCloseTo(25, 2)
    const [cap] = await t.client<{ b: string }[]>`
      SELECT budget_usd::text AS b FROM allocation
      WHERE scope_id = ${D}::uuid AND teammate_id = ${MEMBER}::uuid`
    expect(cap!.b).toBe('325.00')
  })

  it('per-developer, the pool period edited through PATCH: its caps move with it, the editor and a re-split see them, and approval raises the cap on that pool', async () => {
    const D2 = await mkProject('BR-D2', { mode: 'per_dev_fixed' })
    await assign(D2, PM, 'manager')
    await assign(D2, MEMBER, 'member')
    await assign(D2, MEMBER2, 'member')
    const pool = await mkAllocation(D2, 1000) // over PERIOD
    await split(PM, pool, {
      mode: 'per_dev_fixed',
      caps: [
        { teammate_id: MEMBER, budget_usd: '200' },
        { teammate_id: MEMBER2, budget_usd: '100' },
      ],
    })
    // Shorten the pool: a cap left on the old period would reach past it.
    await patchPool(PM, pool, { budget_usd: '1000', effective: '[2026-01-01T00:00:00Z,2098-01-01T00:00:00Z)' })
    const capRanges = () =>
      t.client<{ same: boolean }[]>`
        SELECT c.effective = p.effective AS same
        FROM allocation c JOIN allocation p ON p.id = ${pool}::uuid
        WHERE c.scope_id = ${D2}::uuid AND c.teammate_id IS NOT NULL`
    expect((await capRanges()).map((r) => r.same)).toEqual([true, true])
    expect((await editor(PM, pool)).per_dev_caps.length).toBe(2)

    // A re-split after the edit replaces the caps (it used to collide: 500).
    expect(await status(split(PM, pool, { mode: 'per_dev_fixed', caps: [{ teammate_id: MEMBER, budget_usd: '200' }] }))).toBe(200)

    const req = await file(MEMBER, D2, { amount_usd: '20', reason: 'After the edit' })
    const before = await readers(D2, 'BR-D2', MEMBER)
    await approve(PM, D2, req.id)
    const after = await readers(D2, 'BR-D2', MEMBER)
    expect(after.projectTotal - before.projectTotal).toBeCloseTo(20, 2)
    expect(after.personal - before.personal).toBeCloseTo(20, 2)
    const [cap] = await t.client<{ b: string }[]>`
      SELECT budget_usd::text AS b FROM allocation WHERE scope_id = ${D2}::uuid AND teammate_id = ${MEMBER}::uuid`
    expect(cap!.b).toBe('220.00')
    expect((await capRanges()).map((r) => r.same)).toEqual([true])
  })

  it('per-developer, uncapped requester: no cap is created; their figure (the pool) rises by exactly $15', async () => {
    const req = await file(MEMBER2, D, { amount_usd: '15', reason: 'Spike' })
    const before = await readers(D, 'BR-D', MEMBER2)
    await approve(PM, D, req.id)
    const after = await readers(D, 'BR-D', MEMBER2)
    expect(after.projectTotal - before.projectTotal).toBeCloseTo(15, 2)
    expect(after.personal - before.personal).toBeCloseTo(15, 2)
    const [n] = await t.client<{ n: number }[]>`
      SELECT COUNT(*)::int AS n FROM allocation WHERE scope_id = ${D}::uuid AND teammate_id = ${MEMBER2}::uuid`
    expect(n!.n).toBe(0)
  })

  it('two concurrent approvals of one request: one succeeds, the other is 409, one top-up', async () => {
    const req = await file(MEMBER, S, { amount_usd: '5', reason: 'race' })
    const results = await Promise.all([status(approve(PM, S, req.id)), status(approve(ADMIN, S, req.id))])
    expect([...results].sort()).toEqual([200, 409])
    const [n] = await t.client<{ n: number }[]>`
      SELECT COUNT(*)::int AS n FROM audit_event
      WHERE event_type = 'allocation-topup-added' AND payload->'context'->>'quota_request_id' = ${req.id}`
    expect(n!.n).toBe(1)
  })
})

describe('refusals that leave the request pending', () => {
  it('no budget for the current period → 409 "set a budget first"', async () => {
    await assign(N, MEMBER2, 'member')
    const req = await file(MEMBER2, N, { amount_usd: '10', reason: 'first budget' })
    const err = await approve(PM, N, req.id).catch((e: { statusCode: number; statusMessage: string }) => e)
    expect(err).toMatchObject({ statusCode: 409, statusMessage: 'Set a budget first' })
    const [q] = await t.client<{ status: string }[]>`SELECT status FROM quota_request WHERE id = ${req.id}::uuid`
    expect(q!.status).toBe('pending')
  })

  it('ended project → approve 409; declining still works', async () => {
    const [row] = await t.client<{ id: string }[]>`
      INSERT INTO quota_request (project_id, requester_teammate_id, amount_usd, reason)
      VALUES (${E}::uuid, ${MEMBER}::uuid, 10, 'filed before the end') RETURNING id::text AS id`
    expect(await status(approve(PM, E, row!.id))).toBe(409)
    const [q] = await t.client<{ status: string }[]>`SELECT status FROM quota_request WHERE id = ${row!.id}::uuid`
    expect(q!.status).toBe('pending')
    expect((await reject(PM, E, row!.id, { note: 'Project is over' })).status).toBe('rejected')
  })
})

describe('reject and withdraw', () => {
  it('reject needs a note (400) and tells the requester', async () => {
    const [req] = (await list(PM, N)).pending!
    expect(await status(reject(PM, N, req!.id, { note: '' }))).toBe(400)
    const out = await reject(PM, N, req!.id, { note: 'Not this month' })
    expect(out.status).toBe('rejected')
    expect((await inboxFor(MEMBER2, 'quota-request-decided'))[0]!.body).toMatchObject({ decision: 'rejected', note: 'Not this month' })
  })

  it('the requester withdraws; then an approval is 409; someone else cannot withdraw it (404)', async () => {
    const req = await file(MEMBER, S, { amount_usd: '7', reason: 'maybe' })
    expect(await status(withdraw(OUTSIDER, S, req.id))).toBe(404)
    expect((await withdraw(MEMBER, S, req.id)).status).toBe('withdrawn')
    expect(await status(approve(PM, S, req.id))).toBe(409)
    expect(await status(withdraw(MEMBER, S, req.id))).toBe(409)
  })
})

/*
 * A change commits while a budget-request write waits on the project row lock.
 * The holder takes the lock first, the request starts and queues behind it, and
 * only then does the holder end an assignment, at the database's clock — later
 * than the instant the waiting request read before it waited, as a real remove
 * (which ends the range at its own now()) would be.
 */
describe('a change committed while the request waited on the project lock', () => {
  const blockedBackends = async () => {
    const [r] = await t.client<{ n: number }[]>`
      SELECT COUNT(*)::int AS n FROM pg_stat_activity
       WHERE wait_event_type = 'Lock' AND datname = current_database()`
    return r!.n
  }

  async function whileLocked(
    projectId: string,
    act: () => Promise<unknown>,
    inHolder: (tx: typeof t.client) => Promise<void>,
  ): Promise<number> {
    let release!: () => void
    const released = new Promise<void>((r) => (release = r))
    let locked!: () => void
    const isLocked = new Promise<void>((r) => (locked = r))
    const holder = t.client.begin(async (tx) => {
      await tx`SELECT 1 FROM project WHERE id = ${projectId}::uuid FOR UPDATE`
      locked()
      await released
      await inHolder(tx as unknown as typeof t.client)
    })
    await isLocked
    let settled = false
    const result = status(act()).finally(() => (settled = true))
    for (let i = 0; i < 400 && !settled && (await blockedBackends()) < 1; i++) {
      await new Promise((r) => setTimeout(r, 25))
    }
    release()
    await holder
    return result
  }

  const endAssignment = (projectId: string, who: string) => async (tx: typeof t.client) => {
    await tx`UPDATE project_assignment SET effective = tstzrange(lower(effective), clock_timestamp())
             WHERE project_id = ${projectId}::uuid AND teammate_id = ${who}::uuid AND upper_inf(effective)`
  }

  async function lockProject(code: string): Promise<string> {
    const id = await mkProject(code)
    await assign(id, PM, 'manager')
    await assign(id, MEMBER, 'member')
    await mkAllocation(id, 1000)
    return id
  }

  const topups = async (projectId: string) => {
    const [n] = await t.client<{ n: number }[]>`
      SELECT COUNT(*)::int AS n FROM allocation WHERE scope_id = ${projectId}::uuid AND allocation_kind = 'top-up'`
    return n!.n
  }

  it('the deciding PM is removed: approve is refused (403), the request stays pending', async () => {
    const id = await lockProject('BR-L1')
    const req = await file(MEMBER, id, { amount_usd: '10', reason: 'race' })
    expect(await whileLocked(id, () => approve(PM, id, req.id), endAssignment(id, PM))).toBe(403)
    const [q] = await t.client<{ status: string }[]>`SELECT status FROM quota_request WHERE id = ${req.id}::uuid`
    expect(q!.status).toBe('pending')
    expect(await topups(id)).toBe(0)
  }, 30_000)

  it('the requester is removed: approve is refused (409), no budget moves', async () => {
    const id = await lockProject('BR-L2')
    const req = await file(MEMBER, id, { amount_usd: '10', reason: 'race' })
    expect(await whileLocked(id, () => approve(PM, id, req.id), endAssignment(id, MEMBER))).toBe(409)
    expect(await topups(id)).toBe(0)
  }, 30_000)

  it('the member filing is removed: filing is refused (403), no request is left behind', async () => {
    const id = await lockProject('BR-L3')
    const code = await whileLocked(id, () => file(MEMBER, id, { amount_usd: '10', reason: 'race' }), endAssignment(id, MEMBER))
    expect(code).toBe(403)
    const [n] = await t.client<{ n: number }[]>`SELECT COUNT(*)::int AS n FROM quota_request WHERE project_id = ${id}::uuid`
    expect(n!.n).toBe(0)
  }, 30_000)

  it('project delete waits on the project lock before touching any child row (no deadlock with approval)', async () => {
    const id = await lockProject('BR-L4')
    // An approval holds the project lock and then writes allocation rows. The
    // delete must not hold those rows while it waits for the project.
    let childRows = 'not checked'
    const code = await whileLocked(
      id,
      () => (projectDelete as Handler)(ev({ session: as(ADMIN), params: { id }, method: 'DELETE' })),
      async (tx) => {
        try {
          await tx`SELECT 1 FROM allocation WHERE scope_type = 'project' AND scope_id = ${id}::uuid FOR UPDATE NOWAIT`
          childRows = 'free'
        } catch (e) {
          childRows = (e as { code?: string }).code ?? 'error'
        }
      },
    )
    expect(childRows).toBe('free')
    expect(code).toBe(200)
  }, 30_000)
})

/*
 * The personal figure on a per-developer project after one pool period ended
 * mid-month and the next began (me-queries.ts). Read at a pinned instant.
 */
describe('personal figure across a mid-month change of pool period', () => {
  const NOW = new Date('2026-10-20T12:00:00Z')
  const P1 = '[2026-10-01T00:00:00Z,2026-10-15T00:00:00Z)'
  const P2 = '[2026-10-15T00:00:00Z,2027-01-01T00:00:00Z)'
  async function row(projectId: string, usd: number, range: string, teammateId: string | null, kind = 'baseline') {
    const [evt] = await t.client<{ id: string }[]>`
      INSERT INTO audit_event (event_type, subject_kind, subject_id, payload)
      VALUES ('allocation-created', 'project', ${projectId}::uuid, '{}'::jsonb) RETURNING id::text AS id`
    await t.client`
      INSERT INTO allocation (scope_type, scope_id, teammate_id, budget_usd, effective, allocation_kind, audit_event_id)
      VALUES ('project', ${projectId}::uuid, ${teammateId}::uuid, ${usd}, ${range}::tstzrange, ${kind}, ${evt!.id}::uuid)`
  }
  const personal = async (teammateId: string, code: string) => {
    const usage = await getMyUsage(t.db, teammateId, NOW)
    return Number(usage.buckets.find((b) => b.project_code === code)?.allocation_total_usd ?? NaN)
  }

  it('uncapped in the new period: the figure is the pool, not the expired cap, and a top-up on the pool moves it', async () => {
    const id = await mkProject('BR-G1', { mode: 'per_dev_fixed' })
    await assign(id, MEMBER2, 'member')
    await row(id, 500, P1, null)
    await row(id, 100, P1, MEMBER2) // expired on the 15th
    await row(id, 800, P2, null)
    expect(await personal(MEMBER2, 'BR-G1')).toBeCloseTo(1300, 2) // was 100
    await row(id, 40, P2, null, 'top-up')
    expect(await personal(MEMBER2, 'BR-G1')).toBeCloseTo(1340, 2)
  })

  it('capped in the new period: the figure is the cap in force', async () => {
    const id = await mkProject('BR-G2', { mode: 'per_dev_fixed' })
    await assign(id, MEMBER2, 'member')
    await row(id, 500, P1, null)
    await row(id, 150, P1, MEMBER2)
    await row(id, 800, P2, null)
    await row(id, 200, P2, MEMBER2)
    expect(await personal(MEMBER2, 'BR-G2')).toBeCloseTo(200, 2) // was 350
  })
})

describe('deletion (A12)', () => {
  it('an admin can still delete a $0 project that has budget requests on it; the requests go with it', async () => {
    const [before] = await t.client<{ n: number }[]>`SELECT COUNT(*)::int AS n FROM quota_request WHERE project_id = ${S}::uuid`
    expect(before!.n).toBeGreaterThan(0)
    const out = (await (projectDelete as Handler)(ev({ session: as(ADMIN), params: { id: S }, method: 'DELETE' }))) as { deleted: boolean }
    expect(out.deleted).toBe(true)
    const [after] = await t.client<{ n: number }[]>`SELECT COUNT(*)::int AS n FROM quota_request WHERE project_id = ${S}::uuid`
    expect(after!.n).toBe(0)
  })
})
