// @vitest-environment node
/*
 * GET /api/v1/rollups/practice/:ouId reads the REQUEST's clock, never the
 * database's (issue 491, clock-and-day-boundary.md D1/D3).
 *
 * The request is pinned to Wednesday 2026-03-04 through the `requestClock` test
 * seam (`event.context.serverClock`), while Postgres's own `NOW()` is whatever
 * day CI runs on: a different UTC day, week and month. Rows are seeded on both
 * sides, so every figure below has a different value under each clock:
 *   - this ISO week is 2026-03-02..; the velocity flag compares it with the
 *     three weeks before (2026-02-09..2026-03-01);
 *   - month to date is 2026-03-01 .. the pinned instant;
 *   - the 14-week windows start on 2025-12-01;
 *   - a row at the database's real `now()` is AFTER the pinned instant, so it is
 *     in no window at all.
 * Under the old `date_trunc('week', NOW())` the weekly series ran from the real
 * week, the 2026-02 and 2026-03 rows fell out of it and the flag was read
 * against the real week.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'
import { injectTestSession } from '../../helpers/auth'
import type { Session } from '../../../server/utils/auth'
import { resolveServerClock } from '../../../shared/reports/clock'
import handler from '../../../server/api/v1/rollups/practice/[ouId].get'

const PINNED = '2026-03-04T10:00:00.000Z'

let t: TestDb
let regionA = ''
let mpoId = ''
let alice = ''

const ev = (session: Session, ouId: string) => {
  const headers: Record<string, string> = { host: 'localhost:3450', origin: 'http://localhost:3450' }
  const e = {
    method: 'GET', path: `/x/${ouId}`,
    // The test seam: the whole request runs at PINNED.
    context: { params: { ouId }, serverClock: resolveServerClock(new Date(PINNED)) },
    node: {
      req: { method: 'GET', url: `/x/${ouId}`, socket: { remoteAddress: '127.0.0.1' }, get headers() { return { ...headers } } },
      res: { _headers: {} as Record<string, unknown>, statusCode: 200, getHeader() {}, setHeader() {}, removeHeader() {}, appendHeader() {}, get headersSent() { return false } },
    },
  }
  injectTestSession(e as unknown as Parameters<typeof injectTestSession>[0], session)
  return e as unknown as Parameters<typeof handler>[0]
}
const adminSession = (): Session =>
  ({ teammateId: '9a1e0000-0000-4000-8000-000000000001', email: 'x@x.test', displayName: 'X', role: 'admin', regionId: regionA, orgPath: 'mpo', issuedAt: PINNED } as unknown as Session)

const cents = (n: number) => Math.round(n * 100)

beforeAll(async () => {
  t = await startTestDb()
  process.env.DATABASE_URL = t.url

  await t.client`INSERT INTO region (code, display_name) VALUES ('prc', 'Clock Region')`
  const [r] = await t.client<{ id: string }[]>`SELECT id::text AS id FROM region WHERE code='prc'`
  regionA = r!.id
  await t.client`INSERT INTO org_unit (region_id, path, code, display_name, unit_type, is_cost_owning_unit)
    VALUES (${regionA}::uuid, 'mpo'::ltree, 'mpo', 'mpo', 'practice', true)`
  const [u] = await t.client<{ id: string }[]>`SELECT id::text AS id FROM org_unit WHERE code='mpo'`
  mpoId = u!.id
  await t.client`INSERT INTO teammate (entra_oid, email, display_name, region_id, org_unit_id, is_active)
    VALUES ('oid-clock-alice', 'alice@clock.test', 'alice', ${regionA}::uuid, ${mpoId}::uuid, true)`
  const [a] = await t.client<{ id: string }[]>`SELECT id::text AS id FROM teammate WHERE email='alice@clock.test'`
  alice = a!.id

  await t.client`INSERT INTO instance_attestation (instance_id, principal_oid, teammate_id, tool, region_id, org_unit_id, project_code_hash, raw_project_code)
    VALUES (gen_random_uuid(), 'p', ${alice}::uuid, 'claude-code', ${regionA}::uuid, ${mpoId}::uuid, 'h', 'P')`
  const [ia] = await t.client<{ id: string }[]>`SELECT instance_id::text AS id FROM instance_attestation WHERE teammate_id=${alice}::uuid LIMIT 1`
  const usage = async (cost: number, at: string | null) => {
    if (at) {
      await t.client`INSERT INTO attribution_record (instance_id, teammate_id, region_id, org_unit_id, tool, model, token_type, tokens, cost_usd, fidelity_tier, cost_basis, ts_event)
        VALUES (${ia!.id}::uuid, ${alice}::uuid, ${regionA}::uuid, ${mpoId}::uuid, 'claude-code', 'claude-sonnet-4-6', 'input', 1000, ${cost}, 'tier-1', 'estimated', ${at}::timestamptz)`
    } else {
      await t.client`INSERT INTO attribution_record (instance_id, teammate_id, region_id, org_unit_id, tool, model, token_type, tokens, cost_usd, fidelity_tier, cost_basis, ts_event)
        VALUES (${ia!.id}::uuid, ${alice}::uuid, ${regionA}::uuid, ${mpoId}::uuid, 'claude-code', 'claude-sonnet-4-6', 'input', 1000, ${cost}, 'tier-1', 'estimated', now())`
    }
  }
  await usage(10, '2026-03-03T09:00:00Z') // this pinned week, month to date
  await usage(2, '2026-02-16T09:00:00Z') // the 3-week baseline, not month to date
  await usage(100, null) // the database's real now: after the pinned instant

  const bill = async (cost: number, day: string | null) => {
    if (day) {
      await t.client`INSERT INTO actual_spend (teammate_id, date, tool, input_tokens, output_tokens, cost_usd, source)
        VALUES (${alice}::uuid, ${day}::date, 'claude-code', 100, 100, ${cost}, 'anthropic-analytics-api')`
    } else {
      await t.client`INSERT INTO actual_spend (teammate_id, date, tool, input_tokens, output_tokens, cost_usd, source)
        VALUES (${alice}::uuid, CURRENT_DATE, 'claude-code', 100, 100, ${cost}, 'anthropic-analytics-api')`
    }
  }
  await bill(5, '2026-03-03') // this pinned week, month to date
  await bill(3, '2026-02-24') // the week before, not month to date
  await bill(50, null) // the database's CURRENT_DATE: after the pinned day
}, 180_000)

afterAll(async () => {
  await stopTestDb(t)
})

interface Resp {
  header: { usageUsd: number }
  lanes: { usageSignalUsd: number; billUsd: number }
  billWeeklyLanes: { weekStart: string; lane: string; usd: number }[]
  users: { teammateId: string; spendUsd: number; flagged: boolean }[]
  trend: { weekStart: string; claudeUsd: number }[]
}

describe('practice rollup on a pinned request clock (issue 491)', () => {
  it('the database clock is on a different day from the pinned one (the premise)', async () => {
    const [{ today }] = await t.client<{ today: string }[]>`SELECT CURRENT_DATE::text AS today`
    expect(today).not.toBe(PINNED.slice(0, 10))
  })

  it('month to date runs from the pinned month start to the pinned instant', async () => {
    const r = (await handler(ev(adminSession(), mpoId))) as unknown as Resp
    expect(cents(r.header.usageUsd)).toBe(cents(10))
    expect(cents(r.lanes.billUsd)).toBe(cents(5))
  })

  it('the weekly bill series buckets on the pinned ISO weeks, and nothing after the pinned day', async () => {
    const r = (await handler(ev(adminSession(), mpoId))) as unknown as Resp
    expect(r.billWeeklyLanes.map((p) => ({ ...p, usd: cents(p.usd) }))).toEqual([
      { weekStart: '2026-02-23', lane: 'claude', usd: cents(3) },
      { weekStart: '2026-03-02', lane: 'claude', usd: cents(5) },
    ])
  })

  it('the 14-week usage trend ends on the pinned week', async () => {
    const r = (await handler(ev(adminSession(), mpoId))) as unknown as Resp
    expect(r.trend.map((w) => ({ weekStart: w.weekStart, claude: cents(w.claudeUsd) }))).toEqual([
      { weekStart: '2026-02-16', claude: cents(2) },
      { weekStart: '2026-03-02', claude: cents(10) },
    ])
  })

  it('the velocity flag compares the pinned week with the three before it', async () => {
    const r = (await handler(ev(adminSession(), mpoId))) as unknown as Resp
    const row = r.users.find((x) => x.teammateId === alice)
    expect(row).toBeDefined()
    expect(cents(row!.spendUsd)).toBe(cents(10))
    // 10 this week against a 2-over-3-weeks baseline: well over 2x the mean.
    expect(row!.flagged).toBe(true)
  })
})
