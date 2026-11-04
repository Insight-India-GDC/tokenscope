// @vitest-environment node
/*
 * Project requests (docs/design/project-requests/00-spec.md §3, A10, A11, A12):
 * submit → inbox to the region's admins → approve / reject / withdraw, with the
 * conditional-update 409s, the final-destination re-validation, rollback on a
 * refused create, and the inbox close-out on decision.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'
import { routeEvent } from '../helpers/route-event'
import * as schema from '../../../drizzle/schema'
import type { Session } from '../../../server/utils/auth'
import submit from '../../../server/api/v1/me/project-requests/index.post'
import listMine from '../../../server/api/v1/me/project-requests/index.get'
import withdraw from '../../../server/api/v1/me/project-requests/[id]/withdraw.post'
import adminList from '../../../server/api/v1/admin/project-requests/index.get'
import adminGet from '../../../server/api/v1/admin/project-requests/[id].get'
import approve from '../../../server/api/v1/admin/project-requests/[id]/approve.post'
import reject from '../../../server/api/v1/admin/project-requests/[id]/reject.post'
import { MAX_PENDING_PER_REQUESTER } from '../../../server/projects/project-requests'

let t: TestDb
let regionA: string
let regionB: string
let buA: string
let buA2: string
let buB: string
let requesterId: string
let pmId: string
let adminAId: string
let adminBId: string
let platformId: string
let capperId: string

const MISSING = '9a1e0000-0000-4000-8000-000000000002'
const BUDGET = { amount_usd: '800.00', from: '2026-11-01T00:00:00Z', to: '2027-01-01T00:00:00Z' }

function session(id: string, role: Session['role'], regionId: string): Session {
  return { teammateId: id, email: `${id}@x.test`, displayName: id, role, regionId, orgPath: 'pr.a', issuedAt: '2026-10-28T00:00:00Z' }
}
const requester = () => session(requesterId, 'developer', regionA)
const adminA = () => session(adminAId, 'admin', regionA)
const adminB = () => session(adminBId, 'admin', regionB)
const platform = () => session(platformId, 'platform-admin', regionA)

interface RequestView { id: string; status: string; created_project_id: string | null; created_project_code: string | null }

async function newRequest(name: string, extra: Record<string, unknown> = {}): Promise<RequestView> {
  return (await submit(routeEvent({
    method: 'POST',
    body: {
      display_name: name, type: 'billable', region_id: regionA, cost_owning_unit_id: buA,
      budget: BUDGET, justification: 'Client work starting in November.', ...extra,
    },
    session: requester(),
  }))) as RequestView
}
async function statusOf(id: string): Promise<string> {
  const [r] = await t.client<{ status: string }[]>`SELECT status FROM project_request WHERE id = ${id}::uuid`
  return r!.status
}
async function inboxFor(requestId: string) {
  return t.client<{ recipient: string; category: string; ack_state: string }[]>`
    SELECT recipient_teammate_id::text AS recipient, category, ack_state
    FROM inbox_item WHERE related_entity_id = ${requestId}::uuid ORDER BY category, recipient_teammate_id`
}

beforeAll(async () => {
  t = await startTestDb()
  process.env.DATABASE_URL = t.url
  const [ra] = await t.db.insert(schema.region).values({ code: 'pr-a', displayName: 'PR A' }).returning()
  const [rb] = await t.db.insert(schema.region).values({ code: 'pr-b', displayName: 'PR B' }).returning()
  regionA = ra!.id
  regionB = rb!.id
  const unit = async (regionId: string, code: string) => {
    const [o] = await t.db.insert(schema.orgUnit).values({ regionId, path: code.replace('-', '.'), code, displayName: code, unitType: 'bu', isCostOwningUnit: true }).returning()
    return o!.id
  }
  buA = await unit(regionA, 'pra-one')
  buA2 = await unit(regionA, 'pra-two')
  buB = await unit(regionB, 'prb-one')
  const mk = async (oid: string, role: string, regionId: string, orgUnitId: string) => {
    const [row] = await t.db.insert(schema.teammate).values({ entraOid: oid, email: `${oid}@x.test`, displayName: oid, role, regionId, orgUnitId }).returning()
    return row!.id
  }
  requesterId = await mk('pr-req', 'developer', regionA, buA)
  pmId = await mk('pr-pm', 'developer', regionA, buA)
  adminAId = await mk('pr-admin-a', 'admin', regionA, buA)
  adminBId = await mk('pr-admin-b', 'admin', regionB, buB)
  platformId = await mk('pr-platform', 'platform-admin', regionA, buA)
  capperId = await mk('pr-capper', 'developer', regionA, buA)
}, 120_000)

afterAll(async () => {
  await stopTestDb(t)
}, 30_000)

describe('submit', () => {
  it('stores the request, audits it, and notifies the region admins and platform-admins only', async () => {
    const r = await newRequest('Acme data platform', { suggested_code: 'ACME-DP' })
    expect(r.status).toBe('pending')
    const items = await inboxFor(r.id)
    expect(items.map((i) => i.recipient).sort()).toEqual([adminAId, platformId].sort())
    expect(items.every((i) => i.category === 'project-request')).toBe(true)
    const audits = await t.client`SELECT 1 FROM audit_event WHERE event_type = 'project-request-created' AND subject_id = ${r.id}::uuid`
    expect(audits.length).toBe(1)
  })

  it('the PM defaults to the requester', async () => {
    const r = await newRequest('Default PM')
    const [row] = await t.client<{ pm: string }[]>`SELECT proposed_pm_teammate_id::text AS pm FROM project_request WHERE id = ${r.id}::uuid`
    expect(row!.pm).toBe(requesterId)
  })

  it('a Business Unit from another region is 422; a missing budget or justification is 400', async () => {
    await expect(newRequest('Wrong BU', { cost_owning_unit_id: buB })).rejects.toMatchObject({ statusCode: 422 })
    await expect(newRequest('No budget', { budget: undefined })).rejects.toMatchObject({ statusCode: 400 })
    await expect(newRequest('No reason', { justification: '   ' })).rejects.toMatchObject({ statusCode: 400 })
  })

  it('lists the caller’s own requests only', async () => {
    const mine = (await listMine(routeEvent({ method: 'GET', session: requester() }))) as { requests: { requester_teammate_id: string }[] }
    expect(mine.requests.length).toBeGreaterThan(0)
    expect(mine.requests.every((r) => r.requester_teammate_id === requesterId)).toBe(true)
    const theirs = (await listMine(routeEvent({ method: 'GET', session: adminA() }))) as { requests: unknown[] }
    expect(theirs.requests).toEqual([])
  })

  it('one person holds at most the pending cap, and My projects lists every one of them', async () => {
    const capper = () => session(capperId, 'developer', regionA)
    const file = (name: string) => submit(routeEvent({
      method: 'POST',
      body: { display_name: name, type: 'internal', region_id: regionA, cost_owning_unit_id: buA, budget: BUDGET, justification: 'Cap test.' },
      session: capper(),
    }))
    // Older decided history must not push pending requests out of the list.
    for (let i = 0; i < 3; i++) {
      const d = (await file(`Decided ${i}`)) as RequestView
      await reject(routeEvent({ method: 'POST', params: { id: d.id }, body: { note: 'no' }, session: adminA() }))
    }
    for (let i = 0; i < MAX_PENDING_PER_REQUESTER; i++) await file(`Waiting ${i}`)
    await expect(file('One too many')).rejects.toMatchObject({ statusCode: 409 })
    const mine = (await listMine(routeEvent({ method: 'GET', session: capper() }))) as { requests: { status: string }[] }
    expect(mine.requests.filter((r) => r.status === 'pending')).toHaveLength(MAX_PENDING_PER_REQUESTER)
    expect(mine.requests.filter((r) => r.status === 'rejected')).toHaveLength(3)
    expect(mine.requests.slice(0, MAX_PENDING_PER_REQUESTER).every((r) => r.status === 'pending')).toBe(true)

    // Withdrawing one frees exactly one slot.
    const first = mine.requests[0] as unknown as RequestView
    await withdraw(routeEvent({ method: 'POST', params: { id: first.id }, session: capper() }))

    // A concurrent submission takes that slot while ours waits: another session holds the
    // requester's lock and adds the 20th pending row. Ours must wait, then count 20 and refuse.
    let release!: () => void
    const released = new Promise<void>((r) => (release = r))
    let locked!: () => void
    const isLocked = new Promise<void>((r) => (locked = r))
    const holder = t.client.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtext(${'project-request:' + capperId}))`
      await tx`INSERT INTO project_request (requester_teammate_id, display_name, type, region_id, cost_owning_unit_id,
                 proposed_pm_teammate_id, budget_usd, budget_from, budget_to, justification)
               VALUES (${capperId}::uuid, 'Taken concurrently', 'internal', ${regionA}::uuid, ${buA}::uuid,
                 ${capperId}::uuid, 1, ${BUDGET.from}::timestamptz, ${BUDGET.to}::timestamptz, 'Race.')`
      locked()
      await released
    })
    await isLocked
    let settled = false
    const ours = file('Ours').then(() => 201, (e: { statusCode?: number }) => e.statusCode ?? 500).finally(() => (settled = true))
    for (let i = 0; i < 400 && !settled; i++) {
      const [{ n: waiting }] = (await t.client<{ n: number }[]>`
        SELECT COUNT(*)::int AS n FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND datname = current_database()`) as [{ n: number }]
      if (waiting > 0) break
      await new Promise((r) => setTimeout(r, 25))
    }
    release()
    await holder
    expect(await ours).toBe(409)
    const [{ n }] = (await t.client<{ n: number }[]>`
      SELECT COUNT(*)::int AS n FROM project_request WHERE requester_teammate_id = ${capperId}::uuid AND status = 'pending'`) as [{ n: number }]
    expect(n).toBe(MAX_PENDING_PER_REQUESTER)
  })
})

describe('submit with an idempotency key (mig 0170)', () => {
  const KEY = '9a1e0000-0000-4000-8000-0000000000f1'
  const KEY_2 = '9a1e0000-0000-4000-8000-0000000000f2'
  const other = () => session(pmId, 'developer', regionA)
  const keyed = (key: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
    display_name: 'Keyed request', type: 'internal', region_id: regionA, cost_owning_unit_id: buA,
    budget: BUDGET, justification: 'Resent after a lost answer.', idempotency_key: key, ...extra,
  })
  const send = async (s: Session, body: Record<string, unknown>) =>
    (await submit(routeEvent({ method: 'POST', body, session: s }))) as RequestView & { requester_teammate_id: string }
  async function rowsWithKey(teammateId: string, key: string): Promise<number> {
    const [{ n }] = (await t.client<{ n: number }[]>`
      SELECT COUNT(*)::int AS n FROM project_request
      WHERE requester_teammate_id = ${teammateId}::uuid AND idempotency_key = ${key}::uuid`) as [{ n: number }]
    return n
  }
  async function sideEffects(requestId: string): Promise<{ audits: number; items: number }> {
    const [row] = await t.client<{ audits: number; items: number }[]>`
      SELECT (SELECT COUNT(*)::int FROM audit_event
               WHERE event_type = 'project-request-created' AND subject_id = ${requestId}::uuid) AS audits,
             (SELECT COUNT(*)::int FROM inbox_item
               WHERE related_entity_id = ${requestId}::uuid AND category = 'project-request') AS items`
    return row!
  }

  let filed: RequestView & { requester_teammate_id: string }

  it('the first submit files the request and stores the key', async () => {
    filed = await send(requester(), keyed(KEY))
    expect(filed.status).toBe('pending')
    const [row] = await t.client<{ k: string }[]>`SELECT idempotency_key::text AS k FROM project_request WHERE id = ${filed.id}::uuid`
    expect(row!.k).toBe(KEY)
  })

  it('a resend with the same key returns the same request and files, audits and notifies nothing', async () => {
    const before = await sideEffects(filed.id)
    expect(before.audits).toBe(1)
    expect(await send(requester(), keyed(KEY))).toEqual(filed)
    expect(await rowsWithKey(requesterId, KEY)).toBe(1)
    expect(await sideEffects(filed.id)).toEqual(before)
  })

  it('a resend returns the request as it is now, even once it is decided', async () => {
    const body = keyed(KEY_2, { display_name: 'Keyed then withdrawn' })
    const r = await send(requester(), body)
    await withdraw(routeEvent({ method: 'POST', params: { id: r.id }, session: requester() }))
    expect(await send(requester(), body)).toMatchObject({ id: r.id, status: 'withdrawn' })
    expect(await rowsWithKey(requesterId, KEY_2)).toBe(1)
  })

  it('the same key with different content is 422 and files nothing', async () => {
    await expect(send(requester(), keyed(KEY, { budget: { ...BUDGET, amount_usd: '900.00' } }))).rejects.toMatchObject({ statusCode: 422 })
    await expect(send(requester(), keyed(KEY, { justification: 'Something else.' }))).rejects.toMatchObject({ statusCode: 422 })
    await expect(send(requester(), keyed(KEY, { proposed_pm_teammate_id: pmId }))).rejects.toMatchObject({ statusCode: 422 })
    expect(await rowsWithKey(requesterId, KEY)).toBe(1)
  })

  it('another requester using the same key files their own, independent request', async () => {
    const theirs = await send(other(), keyed(KEY))
    expect(theirs.id).not.toBe(filed.id)
    expect(theirs.requester_teammate_id).toBe(pmId)
    expect(await rowsWithKey(pmId, KEY)).toBe(1)
    expect(await rowsWithKey(requesterId, KEY)).toBe(1)
    // Each requester's resend finds their own row.
    expect((await send(other(), keyed(KEY))).id).toBe(theirs.id)
    expect((await send(requester(), keyed(KEY))).id).toBe(filed.id)
  })

  it('without a key, the same content files a second request (older clients)', async () => {
    const plain = keyed(KEY, { display_name: 'Unkeyed twice' })
    delete plain.idempotency_key
    const a = await send(requester(), plain)
    const b = await send(requester(), plain)
    expect(a.id).not.toBe(b.id)
  })

  it('a malformed key is 400', async () => {
    await expect(send(requester(), keyed('not-a-uuid'))).rejects.toMatchObject({ statusCode: 400 })
  })
})

describe('admin reads are region-scoped', () => {
  it('region B’s admin sees none of region A’s requests and gets 404 on one', async () => {
    const r = await newRequest('Scoped')
    const listB = (await adminList(routeEvent({ method: 'GET', session: adminB() }))) as { requests: unknown[] }
    expect(listB.requests).toEqual([])
    await expect(adminGet(routeEvent({ method: 'GET', params: { id: r.id }, session: adminB() }))).rejects.toMatchObject({ statusCode: 404 })
    const got = (await adminGet(routeEvent({ method: 'GET', params: { id: r.id }, session: adminA() }))) as { request: { id: string } }
    expect(got.request.id).toBe(r.id)
  })

  it('the pending queue is oldest first, one page at a time, and every request is reachable', async () => {
    const old = await newRequest('Oldest waiting')
    await t.client`UPDATE project_request SET created_at = '2020-01-01T00:00:00Z' WHERE id = ${old.id}::uuid`
    const [{ n }] = (await t.client<{ n: number }[]>`
      SELECT COUNT(*)::int AS n FROM project_request WHERE status = 'pending' AND region_id = ${regionA}::uuid`) as [{ n: number }]
    expect(n).toBeGreaterThan(2)
    type Page = { requests: { id: string; created_at: string }[]; total: number; offset: number; has_more: boolean }
    const pageAt = async (offset: number) =>
      (await adminList(routeEvent({ method: 'GET', session: adminA(), query: { limit: '2', offset: String(offset) } }))) as Page
    const page = await pageAt(0)
    expect(page.requests.map((r) => r.id)[0]).toBe(old.id)
    expect(page.requests).toHaveLength(2)
    expect(page.requests[0]!.created_at <= page.requests[1]!.created_at).toBe(true)
    expect(page).toMatchObject({ total: n, offset: 0, has_more: true })

    const all = (await adminList(routeEvent({ method: 'GET', session: adminA() }))) as Page
    expect(all).toMatchObject({ total: n, has_more: false })
    expect(all.requests).toHaveLength(n)

    // Paging walks the whole queue in the same order, with no overlap or gap.
    const walked: string[] = []
    for (let offset = 0; ; offset += 2) {
      const p = await pageAt(offset)
      expect(p.total).toBe(n)
      walked.push(...p.requests.map((r) => r.id))
      if (!p.has_more) break
    }
    expect(walked).toEqual(all.requests.map((r) => r.id))
    const page2 = await pageAt(2)
    expect(page2.requests.map((r) => r.id)).toEqual(all.requests.slice(2, 4).map((r) => r.id))

    // Past the end: no rows, but the total still says how many there are.
    expect(await pageAt(n + 10)).toMatchObject({ requests: [], total: n, has_more: false })
  })

  it('a developer cannot read the admin queue (403)', async () => {
    await expect(adminList(routeEvent({ method: 'GET', session: requester() }))).rejects.toMatchObject({ statusCode: 403 })
  })
})

describe('approve', () => {
  it('creates the project with the proposed PM, the requester as member, the baseline; closes and notifies', async () => {
    const r = await newRequest('Approve me', { proposed_pm_teammate_id: pmId, suggested_code: 'APP-ME' })
    const out = (await approve(routeEvent({ method: 'POST', params: { id: r.id }, body: { code: 'APP-FINAL', display_name: 'Approved under another name', note: 'Go' }, session: adminA() }))) as {
      request: RequestView; project: { id: string; code: string }; allocation_id: string
    }
    expect(out.project.code).toBe('APP-FINAL')
    expect(out.request).toMatchObject({ status: 'approved', created_project_id: out.project.id, created_project_code: 'APP-FINAL' })
    // The request keeps what was ASKED for; the created project is named as it is.
    const mine = (await listMine(routeEvent({ method: 'GET', session: requester() }))) as {
      requests: { id: string; display_name: string; created_project_code: string | null; created_project_name: string | null }[]
    }
    expect(mine.requests.find((x) => x.id === r.id)).toMatchObject({
      display_name: 'Approve me',
      created_project_code: 'APP-FINAL',
      created_project_name: 'Approved under another name',
    })

    const members = await t.client<{ teammate_id: string; role: string }[]>`
      SELECT teammate_id::text AS teammate_id, role FROM project_assignment
      WHERE project_id = ${out.project.id}::uuid AND effective @> now() ORDER BY role`
    expect(members).toEqual([{ teammate_id: pmId, role: 'manager' }, { teammate_id: requesterId, role: 'member' }])
    const [alloc] = await t.client<{ budget_usd: string }[]>`
      SELECT budget_usd::text AS budget_usd FROM allocation WHERE scope_id = ${out.project.id}::uuid AND allocation_kind = 'baseline'`
    expect(alloc!.budget_usd).toBe('800.00')
    const [created] = await t.client<{ source: string }[]>`
      SELECT payload->>'source' AS source FROM audit_event WHERE event_type = 'project-created' AND subject_id = ${out.project.id}::uuid`
    expect(created!.source).toBe(`request:${r.id}`)
    const approvedAudit = await t.client`SELECT 1 FROM audit_event WHERE event_type = 'project-request-approved' AND subject_id = ${r.id}::uuid`
    expect(approvedAudit.length).toBe(1)

    const items = await inboxFor(r.id)
    expect(items.filter((i) => i.category === 'project-request').every((i) => i.ack_state === 'resolved')).toBe(true)
    expect(items.filter((i) => i.category === 'project-request-decided')).toEqual([
      { recipient: requesterId, category: 'project-request-decided', ack_state: 'unread' },
    ])
    const [decided] = await t.client<{ asked: string; created: string; code: string }[]>`
      SELECT body->>'displayName' AS asked, body->>'projectName' AS created, body->>'projectCode' AS code
      FROM inbox_item WHERE related_entity_id = ${r.id}::uuid AND category = 'project-request-decided'`
    expect(decided).toEqual({ asked: 'Approve me', created: 'Approved under another name', code: 'APP-FINAL' })
  })

  it('a second decision on the same request is 409', async () => {
    const r = await newRequest('Twice')
    await approve(routeEvent({ method: 'POST', params: { id: r.id }, body: { code: 'TWICE-1' }, session: adminA() }))
    await expect(
      approve(routeEvent({ method: 'POST', params: { id: r.id }, body: { code: 'TWICE-2' }, session: platform() })),
    ).rejects.toMatchObject({ statusCode: 409 })
    await expect(
      reject(routeEvent({ method: 'POST', params: { id: r.id }, body: { note: 'no' }, session: platform() })),
    ).rejects.toMatchObject({ statusCode: 409 })
    expect((await t.client`SELECT 1 FROM project WHERE code = 'TWICE-2'`).length).toBe(0)
  })

  it('two concurrent approvals: exactly one wins, the other is 409', async () => {
    const r = await newRequest('Race')
    const results = await Promise.allSettled([
      approve(routeEvent({ method: 'POST', params: { id: r.id }, body: { code: 'RACE-1' }, session: adminA() })),
      approve(routeEvent({ method: 'POST', params: { id: r.id }, body: { code: 'RACE-2' }, session: platform() })),
    ])
    expect(results.filter((x) => x.status === 'fulfilled').length).toBe(1)
    const failed = results.find((x) => x.status === 'rejected') as PromiseRejectedResult
    expect(failed.reason).toMatchObject({ statusCode: 409 })
    const made = await t.client`SELECT 1 FROM project WHERE code IN ('RACE-1', 'RACE-2')`
    expect(made.length).toBe(1)
  })

  it('edits apply: a moved Business Unit within the region and a new budget', async () => {
    const r = await newRequest('Edited')
    const out = (await approve(routeEvent({
      method: 'POST', params: { id: r.id },
      body: { code: 'EDITED', cost_owning_unit_id: buA2, budget: { ...BUDGET, amount_usd: '250.00' }, display_name: 'Edited name' },
      session: adminA(),
    }))) as { project: { id: string } }
    const [p] = await t.client<{ bu: string; name: string }[]>`
      SELECT cost_owning_unit_id::text AS bu, display_name AS name FROM project WHERE id = ${out.project.id}::uuid`
    expect(p).toEqual({ bu: buA2, name: 'Edited name' })
  })

  it('a region admin cannot move the project to a region outside their scope (403, still pending)', async () => {
    const r = await newRequest('Move away')
    await expect(approve(routeEvent({
      method: 'POST', params: { id: r.id }, body: { code: 'MOVED', region_id: regionB, cost_owning_unit_id: buB }, session: adminA(),
    }))).rejects.toMatchObject({ statusCode: 403 })
    expect(await statusOf(r.id)).toBe('pending')
  })

  it('the final Business Unit is re-validated against the final region (422) and the decision rolls back', async () => {
    const r = await newRequest('Mismatch')
    await expect(approve(routeEvent({
      method: 'POST', params: { id: r.id }, body: { code: 'MISMATCH', region_id: regionB }, session: platform(),
    }))).rejects.toMatchObject({ statusCode: 422 })
    expect(await statusOf(r.id)).toBe('pending')
  })

  it('a taken code is 409 and leaves the request pending', async () => {
    const r = await newRequest('Taken')
    await expect(approve(routeEvent({ method: 'POST', params: { id: r.id }, body: { code: 'APP-FINAL' }, session: adminA() })))
      .rejects.toMatchObject({ statusCode: 409 })
    expect(await statusOf(r.id)).toBe('pending')
  })

  it('platform-admin may move a request to another region', async () => {
    const r = await newRequest('Cross')
    const out = (await approve(routeEvent({
      method: 'POST', params: { id: r.id }, body: { code: 'CROSS', region_id: regionB, cost_owning_unit_id: buB }, session: platform(),
    }))) as { project: { id: string } }
    const [p] = await t.client<{ region_id: string }[]>`SELECT region_id::text AS region_id FROM project WHERE id = ${out.project.id}::uuid`
    expect(p!.region_id).toBe(regionB)
  })

  it('an out-of-scope region admin gets 404, a developer 403', async () => {
    const r = await newRequest('Nope')
    await expect(approve(routeEvent({ method: 'POST', params: { id: r.id }, body: { code: 'NOPE' }, session: adminB() })))
      .rejects.toMatchObject({ statusCode: 404 })
    await expect(approve(routeEvent({ method: 'POST', params: { id: r.id }, body: { code: 'NOPE' }, session: requester() })))
      .rejects.toMatchObject({ statusCode: 403 })
    await expect(approve(routeEvent({ method: 'POST', params: { id: MISSING }, body: { code: 'NOPE' }, session: platform() })))
      .rejects.toMatchObject({ statusCode: 404 })
  })
})

describe('reject and withdraw', () => {
  it('reject needs a note (400), then records it, closes the admin items and notifies the requester', async () => {
    const r = await newRequest('Reject me')
    await expect(reject(routeEvent({ method: 'POST', params: { id: r.id }, body: {}, session: adminA() }))).rejects.toMatchObject({ statusCode: 400 })
    await reject(routeEvent({ method: 'POST', params: { id: r.id }, body: { note: 'Use the existing Acme project.' }, session: adminA() }))
    const [row] = await t.client<{ status: string; note: string }[]>`
      SELECT status, decision_note AS note FROM project_request WHERE id = ${r.id}::uuid`
    expect(row).toEqual({ status: 'rejected', note: 'Use the existing Acme project.' })
    const items = await inboxFor(r.id)
    expect(items.filter((i) => i.category === 'project-request').every((i) => i.ack_state === 'resolved')).toBe(true)
    expect(items.some((i) => i.category === 'project-request-decided' && i.recipient === requesterId)).toBe(true)
    const audits = await t.client`SELECT 1 FROM audit_event WHERE event_type = 'project-request-rejected' AND subject_id = ${r.id}::uuid`
    expect(audits.length).toBe(1)
  })

  it('the requester withdraws a pending request; a decision after it is 409', async () => {
    const r = await newRequest('Withdraw me')
    expect(await withdraw(routeEvent({ method: 'POST', params: { id: r.id }, session: requester() }))).toEqual({ id: r.id, status: 'withdrawn' })
    expect((await inboxFor(r.id)).every((i) => i.ack_state === 'resolved')).toBe(true)
    await expect(approve(routeEvent({ method: 'POST', params: { id: r.id }, body: { code: 'LATE' }, session: adminA() })))
      .rejects.toMatchObject({ statusCode: 409 })
    const audits = await t.client`SELECT 1 FROM audit_event WHERE event_type = 'project-request-withdrawn' AND subject_id = ${r.id}::uuid`
    expect(audits.length).toBe(1)
  })

  it('withdrawing after a decision is 409; someone else’s request is 404', async () => {
    const r = await newRequest('Decided first')
    await reject(routeEvent({ method: 'POST', params: { id: r.id }, body: { note: 'No.' }, session: adminA() }))
    await expect(withdraw(routeEvent({ method: 'POST', params: { id: r.id }, session: requester() }))).rejects.toMatchObject({ statusCode: 409 })
    const other = await newRequest('Not yours')
    await expect(withdraw(routeEvent({ method: 'POST', params: { id: other.id }, session: session(pmId, 'developer', regionA) })))
      .rejects.toMatchObject({ statusCode: 404 })
  })
})
