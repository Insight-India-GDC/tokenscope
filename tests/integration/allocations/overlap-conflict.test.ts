// @vitest-environment node
/*
 * Allocation write-path robustness (API-6 + SYS-1/SYS-2 adoption) —
 * handler-level against testcontainers Postgres (the lifecycle-policy.test.ts
 * harness pattern: direct h3 event mocking, no Nuxt boot).
 *
 * Regressions pinned:
 *   - PATCH effective overlapping a sibling → 409 from the gist EXCLUDE
 *     translation (was a raw 23P01 → 500)
 *   - garbage tstzrange / oversized budget rejected with 400 BEFORE Postgres
 *     (was 22007/22003 → 500)
 *   - malformed allocation id → 400 via requireUuidParam (representative
 *     route for the SYS-1 sweep; the old 36-char regex 500'd on ::uuid)
 *   - GET returns normalised effective_from/effective_to ISO fields (FE-1)
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { sql } from 'drizzle-orm'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'
import * as schema from '../../../drizzle/schema'
import { injectTestSession } from '../../helpers/auth'
import type { Session } from '../../../server/utils/auth'
import allocationGet from '../../../server/api/v1/allocations/[id].get'
import allocationPatch from '../../../server/api/v1/allocations/[id].patch'
import allocationsPost from '../../../server/api/v1/allocations/index.post'
import topupsPost from '../../../server/api/v1/allocations/[id]/topups.post'
import { MAX_LIVE_TOPUPS_PER_PROJECT } from '../../../server/utils/allocation-validation'
import { resolveServerClock } from '../../../shared/reports/clock'
import allocationsList from '../../../server/api/v1/allocations/index.get'

let t: TestDb
let regionId: string
let ouId: string
let finopsId: string
let projectId: string
let mayAllocationId: string
let juneAllocationId: string

beforeAll(async () => {
  t = await startTestDb()
  process.env.DATABASE_URL = t.url

  const [r] = await t.db.insert(schema.region).values({ code: 'oc-r', displayName: 'OC R' }).returning()
  regionId = r!.id
  const [o] = await t.db
    .insert(schema.orgUnit)
    .values({ regionId, path: 'oc.svc', code: 'oc-svc', displayName: 'Svc', unitType: 'bu' })
    .returning()
  ouId = o!.id
  const [f] = await t.db
    .insert(schema.teammate)
    .values({ entraOid: 'oid-oc-fin', email: 'oc-fin@x.test', role: 'platform-admin', regionId, orgUnitId: ouId })
    .returning()
  finopsId = f!.id
  const [p] = await t.db
    .insert(schema.project)
    .values({
      code: 'OC-PRJ',
      codeHash: 'h-oc-prj',
      displayName: 'Overlap Conflict',
      type: 'billable',
      regionId,
      costOwningUnitId: ouId,
    })
    .returning()
  projectId = p!.id

  async function seedBaseline(effective: string): Promise<string> {
    const [evt] = await t.db
      .insert(schema.auditEvent)
      .values({
        eventType: 'allocation-created',
        actorTeammateId: finopsId,
        subjectKind: 'project',
        subjectId: projectId,
        payload: { seed: true },
      })
      .returning({ id: schema.auditEvent.id })
    const [alloc] = await t.db
      .insert(schema.allocation)
      .values({
        scopeType: 'project',
        scopeId: projectId,
        budgetUsd: '1000.00',
        effective,
        allocationKind: 'baseline',
        auditEventId: evt!.id,
      })
      .returning({ id: schema.allocation.id })
    return alloc!.id
  }
  mayAllocationId = await seedBaseline('[2026-05-01T00:00:00+00,2026-06-01T00:00:00+00)')
  juneAllocationId = await seedBaseline('[2026-06-01T00:00:00+00,2026-07-01T00:00:00+00)')
}, 120_000)

afterAll(async () => {
  await stopTestDb(t)
}, 30_000)

const finops = (): Session => ({
  teammateId: finopsId,
  email: 'oc-fin@x.test',
  displayName: 'Fin',
  role: 'platform-admin',
  regionId,
  orgPath: 'oc.svc',
})

function ev(opts: { method: string; id?: string; body?: unknown; session: Session; path?: string }) {
  const headers: Record<string, string> = { host: 'localhost:3450', origin: 'http://localhost:3450' }
  const e = {
    method: opts.method,
    path: opts.path ?? '/x',
    context: { params: opts.id ? { id: opts.id } : {} },
    node: {
      req: {
        method: opts.method,
        url: opts.path ?? '/x',
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
  return e as unknown as Parameters<typeof allocationGet>[0]
}

describe('SYS-1 — malformed allocation id → 400 (representative route)', () => {
  it('GET with 36 hex chars (no dashes) is a 400, not a PG 22P02 → 500', async () => {
    await expect(
      allocationGet(ev({ method: 'GET', id: 'abcdefabcdefabcdefabcdefabcdefabcdef', session: finops() })),
    ).rejects.toMatchObject({ statusCode: 400 })
  })

  it('PATCH with a non-uuid id is a 400 too', async () => {
    await expect(
      allocationPatch(
        ev({
          method: 'PATCH',
          id: 'not-a-uuid',
          body: { budget_usd: '10.00', effective: '[2026-05-01T00:00:00Z,2026-06-01T00:00:00Z)' },
          session: finops(),
        }),
      ),
    ).rejects.toMatchObject({ statusCode: 400 })
  })
})

describe('API-6 — zod rejects garbage before Postgres', () => {
  it('PATCH with unparseable tstzrange bounds → 400 (was 22007 → 500)', async () => {
    await expect(
      allocationPatch(
        ev({
          method: 'PATCH',
          id: juneAllocationId,
          body: { budget_usd: '10.00', effective: '[banana,cherry)' },
          session: finops(),
        }),
      ),
    ).rejects.toMatchObject({ statusCode: 400 })
  })

  it('PATCH with lower >= upper → 400', async () => {
    await expect(
      allocationPatch(
        ev({
          method: 'PATCH',
          id: juneAllocationId,
          body: {
            budget_usd: '10.00',
            effective: '[2026-07-01T00:00:00Z,2026-06-01T00:00:00Z)',
          },
          session: finops(),
        }),
      ),
    ).rejects.toMatchObject({ statusCode: 400 })
  })

  it('POST with a budget exceeding NUMERIC(14,2) → 400 (was 22003 → 500)', async () => {
    await expect(
      allocationsPost(
        ev({
          method: 'POST',
          body: {
            project_id: projectId,
            budget_usd: '99999999999999999',
            effective: '[2027-01-01T00:00:00Z,2027-02-01T00:00:00Z)',
          },
          session: finops(),
        }),
      ),
    ).rejects.toMatchObject({ statusCode: 400 })
  })
})

describe('API-6 / SYS-2 — overlap is a clean 409', () => {
  it('PATCH moving June onto May trips the gist EXCLUDE → 409 (was 23P01 → 500)', async () => {
    await expect(
      allocationPatch(
        ev({
          method: 'PATCH',
          id: juneAllocationId,
          body: {
            budget_usd: '1000.00',
            effective: '[2026-05-15T00:00:00Z,2026-06-15T00:00:00Z)',
          },
          session: finops(),
        }),
      ),
    ).rejects.toMatchObject({ statusCode: 409 })

    // The aborted write must not have moved the row (tx rollback).
    const rows = await t.db
      .select({ effective: schema.allocation.effective })
      .from(schema.allocation)
    const june = rows.find((r) => String(r.effective).includes('2026-07-01'))
    expect(june).toBeDefined()
  })

  it('POST of an overlapping baseline pool → 409', async () => {
    await expect(
      allocationsPost(
        ev({
          method: 'POST',
          body: {
            project_id: projectId,
            budget_usd: '500.00',
            effective: '[2026-05-10T00:00:00Z,2026-05-20T00:00:00Z)',
          },
          session: finops(),
        }),
      ),
    ).rejects.toMatchObject({ statusCode: 409 })
  })
})

describe('mig 0052 — top-ups stack (overlapping top-ups allowed)', () => {
  it('two OVERLAPPING top-ups on the same project both persist', async () => {
    // First top-up covering all of June.
    const first = (await topupsPost(
      ev({
        method: 'POST',
        id: juneAllocationId,
        body: { budget_usd: '500.00', effective: '[2026-06-01T00:00:00Z,2026-07-01T00:00:00Z)' },
        session: finops(),
      }),
    )) as { id: string }
    expect(first.id).toBeTruthy()

    // Second top-up FULLY OVERLAPPING the first — would have tripped the gist
    // EXCLUDE (409) before mig 0052. The user's exact case: a budget already
    // has a top-up and needs another for the same month.
    const second = (await topupsPost(
      ev({
        method: 'POST',
        id: juneAllocationId,
        body: { budget_usd: '650.00', effective: '[2026-06-10T00:00:00Z,2026-07-01T00:00:00Z)' },
        session: finops(),
      }),
    )) as { id: string }
    expect(second.id).toBeTruthy()
    expect(second.id).not.toBe(first.id)

    // Both rows persisted; the project's June budget now sums baseline + both
    // top-ups (fetchProjectAllocation's @> now() sum).
    const cnt = await t.db.execute<{ c: string }>(sql`
      SELECT COUNT(*)::text AS c FROM allocation
      WHERE scope_id = ${projectId}::uuid AND allocation_kind = 'top-up'
    `)
    expect(Number([...cnt][0]!.c)).toBeGreaterThanOrEqual(2)
  })
  // NB: the baseline-overlap 409 tests above run against the SAME post-0052
  // schema, so they already prove baselines stay mutually non-overlapping —
  // the partial rebuild preserved that guarantee.
})

describe('FE-1 (server half) — normalised effective bounds', () => {
  it('GET returns effective_from/effective_to as ISO-8601 alongside the raw text', async () => {
    const res = (await allocationGet(ev({ method: 'GET', id: mayAllocationId, session: finops() }))) as {
      focused: { effective: string; effective_from: string | null; effective_to: string | null }
    }
    expect(res.focused.effective).toBeTruthy()
    expect(res.focused.effective_from).toBe('2026-05-01T00:00:00.000Z')
    expect(res.focused.effective_to).toBe('2026-06-01T00:00:00.000Z')
  })
})

describe('H32 — top-up role gate, per-project cap, amount ceiling', () => {
  // Its own project + baseline so the cap count is not shared with the
  // stacking test above. Future ranges: the cap counts LIVE top-ups only.
  const FUTURE = '[2027-03-01T00:00:00Z,2027-04-01T00:00:00Z)'
  let capProjectId = ''
  let capBaselineId = ''
  let devId = ''
  let pmId = ''

  const as = (teammateId: string, role: Session['role']): Session => ({
    teammateId,
    email: `${teammateId}@x.test`,
    displayName: 'T',
    role,
    regionId,
    orgPath: 'oc.svc',
  })
  const topupCount = async () =>
    Number(
      [
        ...(await t.db.execute<{ c: string }>(sql`
          SELECT COUNT(*)::text AS c FROM allocation
          WHERE scope_id = ${capProjectId}::uuid AND allocation_kind = 'top-up'
        `)),
      ][0]!.c,
    )

  beforeAll(async () => {
    const [p] = await t.db
      .insert(schema.project)
      .values({ code: 'OC-CAP', codeHash: 'h-oc-cap', displayName: 'Cap', type: 'billable', regionId, costOwningUnitId: ouId })
      .returning()
    capProjectId = p!.id
    const [evt] = await t.db
      .insert(schema.auditEvent)
      .values({ eventType: 'allocation-created', actorTeammateId: finopsId, subjectKind: 'project', subjectId: capProjectId, payload: { seed: true } })
      .returning({ id: schema.auditEvent.id })
    const [alloc] = await t.db
      .insert(schema.allocation)
      .values({ scopeType: 'project', scopeId: capProjectId, budgetUsd: '1000.00', effective: FUTURE, allocationKind: 'baseline', auditEventId: evt!.id })
      .returning({ id: schema.allocation.id })
    capBaselineId = alloc!.id
    const [dev] = await t.db
      .insert(schema.teammate)
      .values({ entraOid: 'oid-oc-dev', email: 'oc-dev@x.test', role: 'developer', regionId, orgUnitId: ouId })
      .returning()
    devId = dev!.id
    const [pm] = await t.db
      .insert(schema.teammate)
      .values({ entraOid: 'oid-oc-pm', email: 'oc-pm@x.test', role: 'developer', regionId, orgUnitId: ouId })
      .returning()
    pmId = pm!.id
    await t.db.insert(schema.projectAssignment).values({
      projectId: capProjectId,
      teammateId: pmId,
      effective: '[2020-01-01T00:00:00+00,)',
      role: 'manager',
    })
  })

  it('a developer who manages no project is refused 403, and nothing is inserted', async () => {
    const before = await topupCount()
    await expect(
      topupsPost(ev({ method: 'POST', id: capBaselineId, body: { budget_usd: '10.00', effective: FUTURE }, session: as(devId, 'developer') })),
    ).rejects.toMatchObject({ statusCode: 403 })
    expect(await topupCount()).toBe(before)
  })

  it('a developer-role project manager of the project still tops up (PM path kept)', async () => {
    const out = (await topupsPost(
      ev({ method: 'POST', id: capBaselineId, body: { budget_usd: '10.00', effective: FUTURE }, session: as(pmId, 'developer') }),
    )) as { id: string }
    expect(out.id).toBeTruthy()
  })

  it('a single top-up above the ceiling is a 400; exactly the ceiling is accepted', async () => {
    const before = await topupCount()
    await expect(
      topupsPost(ev({ method: 'POST', id: capBaselineId, body: { budget_usd: '1000000.01', effective: FUTURE }, session: finops() })),
    ).rejects.toMatchObject({ statusCode: 400 })
    await expect(
      topupsPost(ev({ method: 'POST', id: capBaselineId, body: { budget_usd: '999999999999', effective: FUTURE }, session: finops() })),
    ).rejects.toMatchObject({ statusCode: 400 })
    expect(await topupCount()).toBe(before)
    const ok = (await topupsPost(
      ev({ method: 'POST', id: capBaselineId, body: { budget_usd: '1000000.00', effective: FUTURE }, session: finops() }),
    )) as { id: string }
    expect(ok.id).toBeTruthy()
  })

  it(`the ${MAX_LIVE_TOPUPS_PER_PROJECT + 1}th LIVE top-up is a 409 and inserts nothing; expired ones do not count`, async () => {
    // An expired top-up must not consume quota.
    const [oldEvt] = await t.db
      .insert(schema.auditEvent)
      .values({ eventType: 'allocation-topup-added', actorTeammateId: finopsId, subjectKind: 'allocation', subjectId: capBaselineId, payload: { seed: true } })
      .returning({ id: schema.auditEvent.id })
    await t.db.insert(schema.allocation).values({
      scopeType: 'project', scopeId: capProjectId, budgetUsd: '1.00',
      effective: '[2020-01-01T00:00:00Z,2020-02-01T00:00:00Z)', allocationKind: 'top-up', auditEventId: oldEvt!.id,
    })
    // Fill the live quota through the route itself.
    const live = async () =>
      Number(
        [
          ...(await t.db.execute<{ c: string }>(sql`
            SELECT COUNT(*)::text AS c FROM allocation
            WHERE scope_id = ${capProjectId}::uuid AND allocation_kind = 'top-up' AND upper(effective) > now()
          `)),
        ][0]!.c,
      )
    for (let n = await live(); n < MAX_LIVE_TOPUPS_PER_PROJECT; n++) {
      await topupsPost(ev({ method: 'POST', id: capBaselineId, body: { budget_usd: '1.00', effective: FUTURE }, session: finops() }))
    }
    expect(await live()).toBe(MAX_LIVE_TOPUPS_PER_PROJECT)
    const before = await topupCount()
    await expect(
      topupsPost(ev({ method: 'POST', id: capBaselineId, body: { budget_usd: '1.00', effective: FUTURE }, session: finops() })),
    ).rejects.toMatchObject({ statusCode: 409 })
    expect(await topupCount()).toBe(before)
    // An already-ended top-up never joins the live set, so the full cap does not refuse it.
    const past = (await topupsPost(
      ev({ method: 'POST', id: capBaselineId, body: { budget_usd: '1.00', effective: '[2020-03-01T00:00:00Z,2020-04-01T00:00:00Z)' }, session: finops() }),
    )) as { id: string }
    expect(past.id).toBeTruthy()
  })

  // Runs after the cap test: the project now holds the full live quota plus one expired top-up.
  it('PATCH cannot revive an expired top-up past the live cap, nor raise a top-up above the ceiling', async () => {
    const pick = async (live: boolean) =>
      [
        ...(await t.db.execute<{ id: string; budget: string; eff: string }>(sql`
          SELECT id::text AS id, budget_usd::text AS budget, effective::text AS eff FROM allocation
          WHERE scope_id = ${capProjectId}::uuid AND allocation_kind = 'top-up'
            AND (upper(effective) > now()) = ${live}
          ORDER BY id LIMIT 1
        `)),
      ][0]!
    const expired = await pick(false)
    await expect(
      allocationPatch(ev({ method: 'PATCH', id: expired.id, body: { budget_usd: '1.00', effective: FUTURE }, session: finops() })),
    ).rejects.toMatchObject({ statusCode: 409 })
    expect((await pick(false)).id).toBe(expired.id) // still expired

    const live = await pick(true)
    await expect(
      allocationPatch(ev({ method: 'PATCH', id: live.id, body: { budget_usd: '1000000.01', effective: FUTURE }, session: finops() })),
    ).rejects.toMatchObject({ statusCode: 400 })
    // The cap reads the REQUEST's clock, not the database's: pinned past FUTURE's
    // end, nothing is live, so the same revival is allowed.
    const pinned = ev({ method: 'PATCH', id: expired.id, body: { budget_usd: '1.00', effective: FUTURE }, session: finops() }) as unknown as {
      context: Record<string, unknown>
    }
    pinned.context.serverClock = resolveServerClock(new Date('2030-01-01T00:00:00Z'))
    await expect(allocationPatch(pinned as never)).resolves.toMatchObject({ id: expired.id })
    // Restore it as expired so the next assertions see the full quota again.
    await t.db.execute(sql`UPDATE allocation SET effective = '[2020-01-01T00:00:00Z,2020-02-01T00:00:00Z)' WHERE id = ${expired.id}::uuid`)

    // A live top-up edited within limits is not counted against itself.
    const ok = (await allocationPatch(
      ev({ method: 'PATCH', id: live.id, body: { budget_usd: '2.00', effective: FUTURE }, session: finops() }),
    )) as { id: string }
    expect(ok.id).toBe(live.id)
  })
})

describe('H33 — allocation list paging is deterministic under equal budgets', () => {
  it('limit/offset pages tie-break on id: no repeats, no gaps, ties in id order', async () => {
    const [p] = await t.db
      .insert(schema.project)
      .values({ code: 'OC-TIE', codeHash: 'h-oc-tie', displayName: 'Tie', type: 'billable', regionId, costOwningUnitId: ouId })
      .returning()
    for (let i = 0; i < 6; i++) {
      const [evt] = await t.db
        .insert(schema.auditEvent)
        .values({ eventType: 'allocation-created', actorTeammateId: finopsId, subjectKind: 'project', subjectId: p!.id, payload: { seed: i } })
        .returning({ id: schema.auditEvent.id })
      await t.db.insert(schema.allocation).values({
        scopeType: 'project', scopeId: p!.id, budgetUsd: '4242.00',
        effective: `[2028-0${i + 1}-01T00:00:00Z,2028-0${i + 2}-01T00:00:00Z)`, allocationKind: 'top-up', auditEventId: evt!.id,
      })
    }
    type Page = { allocations: Array<{ id: string; budget_usd: string }>; total: number }
    const first = (await allocationsList(ev({ method: 'GET', path: '/x?limit=200&offset=0', session: finops() }))) as Page
    const seen: string[] = []
    for (let off = 0; off < first.total; off += 2) {
      const page = (await allocationsList(ev({ method: 'GET', path: `/x?limit=2&offset=${off}`, session: finops() }))) as Page
      seen.push(...page.allocations.map((a) => a.id))
    }
    expect(new Set(seen).size).toBe(first.total)
    expect(seen).toEqual(first.allocations.map((a) => a.id))
    const tied = first.allocations.filter((a) => a.budget_usd === '4242.00').map((a) => a.id)
    expect(tied).toHaveLength(6)
    expect(tied).toEqual([...tied].sort())
  })
})
