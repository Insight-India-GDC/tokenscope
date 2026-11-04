// @vitest-environment node
/*
 * Admin worker-enablement ROUTE guards (mig 0090).
 *
 * The DB layer is covered by tests/integration/workers/enablement.test.ts. This
 * file covers what the HANDLERS refuse, which is where the misleading-state bugs
 * live:
 *
 *   - GET must not present a cron for a worker that has no cron job, because the
 *     card renders that as its live schedule.
 *   - PUT must refuse to write an enablement row for such a worker. The UI already
 *     offers no toggle, but a script or a stale client could still mint a row that
 *     governs nothing and then reads back as a configured control — the same
 *     "dead row" the unknown-worker guard exists to prevent.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'
import { injectTestSession } from '../../helpers/auth'
import type { Session } from '../../../server/utils/auth'
import { UNSCHEDULED_WORKERS } from '../../../shared/workers/unscheduled'
import getHandler from '../../../server/api/v1/admin/workers/enablement.get'
import putHandler from '../../../server/api/v1/admin/workers/enablement.put'

let t: TestDb
let regionId = ''
let unitId = ''
const FINOPS_ID = '9a1e0000-0000-4000-8000-0000000000f1'
const REGION_ADMIN_ID = '9a1e0000-0000-4000-8000-0000000000a1'

// One worker that genuinely has no cron job, taken from the shared source of
// truth rather than hardcoded, so this test follows the list if it changes.
const UNSCHEDULED = Object.keys(UNSCHEDULED_WORKERS)[0]!

function ev(opts: { session: Session; body?: unknown; method?: string; ua?: string }) {
  const headers: Record<string, string> = { host: 'localhost:3450', origin: 'http://localhost:3450' }
  if (opts.ua) headers['user-agent'] = opts.ua
  const method = opts.method ?? 'GET'
  const e = {
    method,
    path: '/x',
    context: { params: {} },
    node: {
      req: {
        method,
        url: '/x',
        body: opts.body,
        socket: { remoteAddress: '127.0.0.1' },
        get headers() {
          return { ...headers, 'content-type': 'application/json' }
        },
      },
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
  injectTestSession(e as unknown as Parameters<typeof injectTestSession>[0], opts.session)
  return e as never
}

const finops = (): Session =>
  ({ teammateId: FINOPS_ID, email: 'fx@x.test', displayName: 'Fx', role: 'platform-admin', regionId, orgPath: 'de' } as Session)

const regionAdmin = (): Session =>
  ({ teammateId: REGION_ADMIN_ID, email: 'ra@x.test', displayName: 'Ra', role: 'admin', regionId, orgPath: 'de' } as Session)

beforeAll(async () => {
  t = await startTestDb()
  process.env.DATABASE_URL = t.url
  const [r] = await t.client<{ id: string }[]>`INSERT INTO region (code, display_name) VALUES ('de', 'DE') RETURNING id::text AS id`
  regionId = r!.id
  const [u] = await t.client<{ id: string }[]>`INSERT INTO org_unit (region_id, parent_id, path, code, display_name, unit_type) VALUES (${regionId}::uuid, NULL, 'de'::ltree, 'default', 'DE', 'bu') RETURNING id::text AS id`
  unitId = u!.id
  await t.client`INSERT INTO teammate (id, entra_oid, email, display_name, region_id, org_unit_id, role) VALUES (${FINOPS_ID}::uuid, 'oid-fx', 'fx@x.test', 'Fx', ${regionId}::uuid, ${unitId}::uuid, 'platform-admin')`
  await t.client`INSERT INTO teammate (id, entra_oid, email, display_name, region_id, org_unit_id, role) VALUES (${REGION_ADMIN_ID}::uuid, 'oid-ra', 'ra@x.test', 'Ra', ${regionId}::uuid, ${unitId}::uuid, 'admin')`
}, 180_000)

afterAll(async () => {
  if (t) await stopTestDb(t)
}, 30_000)

beforeEach(async () => {
  // Keep the mig-0090 seed row (heartbeat-coverage) out of each test's way.
  await t.client`DELETE FROM worker_enablement WHERE worker_name <> 'heartbeat-coverage'`
})

interface WorkerRow {
  name: string
  scheduled: boolean
  unscheduledReason: string | null
  recommendedCron: string | null
  enabled: boolean
}

describe('admin worker-enablement GET', () => {
  it('suppresses the cron for an UNSCHEDULED worker and says why', async () => {
    const got = (await getHandler(ev({ session: finops(), method: 'GET' }))) as { workers: WorkerRow[] }
    const row = got.workers.find((w) => w.name === UNSCHEDULED)
    expect(row, `${UNSCHEDULED} should still be listed`).toBeTruthy()
    expect(row!.scheduled).toBe(false)
    // The defect this replaced: a cadence shown for a worker that never runs.
    expect(row!.recommendedCron).toBeNull()
    expect(row!.unscheduledReason).toBeTruthy()
  })

  it('a SCHEDULED worker still reports its live cron', async () => {
    const got = (await getHandler(ev({ session: finops(), method: 'GET' }))) as { workers: WorkerRow[] }
    const row = got.workers.find((w) => w.name === 'budget-alert')!
    expect(row.scheduled).toBe(true)
    expect(row.recommendedCron).toBe('0 * * * *')
    expect(row.unscheduledReason).toBeNull()
  })
})

describe('admin worker-enablement PUT', () => {
  it('REFUSES to write a row for a worker with no cron job', async () => {
    await expect(
      putHandler(ev({ session: finops(), method: 'PUT', body: { workerName: UNSCHEDULED, enabled: false, reason: 'because' } })),
    ).rejects.toMatchObject({ statusCode: 400 })

    const rows = await t.client`SELECT worker_name FROM worker_enablement WHERE worker_name = ${UNSCHEDULED}`
    expect(rows.length, 'no dead row may be persisted').toBe(0)
  })

  it('still REFUSES an unknown worker', async () => {
    await expect(
      putHandler(ev({ session: finops(), method: 'PUT', body: { workerName: 'not-a-worker', enabled: false, reason: 'x' } })),
    ).rejects.toMatchObject({ statusCode: 400 })
  })

  it('a SCHEDULED worker toggles normally', async () => {
    await putHandler(ev({ session: finops(), method: 'PUT', body: { workerName: 'budget-alert', enabled: false, reason: 'noisy in dev' } }))
    const rows = await t.client<{ enabled: boolean; reason: string }[]>`
      SELECT enabled, reason FROM worker_enablement WHERE worker_name = 'budget-alert'`
    expect(rows[0]!.enabled).toBe(false)
    expect(rows[0]!.reason).toBe('noisy in dev')
  })

  it('audits the toggle with the caller IP and user-agent, like every other admin write', async () => {
    await putHandler(
      ev({ session: finops(), method: 'PUT', ua: 'ts-test-ua', body: { workerName: 'budget-alert', enabled: false, reason: 'audit me' } }),
    )
    const [row] = await t.client<{ user_agent: string | null; ip_address: string | null }[]>`
      SELECT user_agent, host(ip_address) AS ip_address FROM audit_event
      WHERE event_type = 'worker-disabled' ORDER BY ts_recorded DESC LIMIT 1`
    expect(row!.user_agent).toBe('ts-test-ua')
    expect(row!.ip_address).not.toBeNull()
  })

  it('a malformed body is a 400 that names the field', async () => {
    await expect(
      putHandler(ev({ session: finops(), method: 'PUT', body: { workerName: 'budget-alert', enabled: 'no' } })),
    ).rejects.toMatchObject({ statusCode: 400, statusMessage: expect.stringContaining('enabled') })
  })

  it('requires a reason to disable', async () => {
    await expect(
      putHandler(ev({ session: finops(), method: 'PUT', body: { workerName: 'budget-alert', enabled: false } })),
    ).rejects.toMatchObject({ statusCode: 400 })
  })
})

/*
 * The two doors to one estate-wide switch must not sit at different tiers.
 * `worker_enablement` has no region column (mig 0090) and every worker it governs
 * runs globally, so a region admin toggling one acts outside their region — which
 * is the reason the RUN twin already excludes them ([name]/run.post.ts:29-33).
 * Until this, PUT admitted `admin` while RUN did not, for the same worker.
 */
describe('admin worker-enablement PUT — tier', () => {
  it('REFUSES a region admin, who cannot scope an estate-wide switch to their region', async () => {
    await expect(
      putHandler(ev({ session: regionAdmin(), method: 'PUT', body: { workerName: 'budget-alert', enabled: false, reason: 'not mine to throw' } })),
    ).rejects.toMatchObject({ statusCode: 403 })
    // Refused means UNWRITTEN, not merely un-acknowledged.
    const rows = await t.client`SELECT 1 FROM worker_enablement WHERE worker_name = 'budget-alert'`
    expect(rows.length, 'a refused toggle must leave no row behind').toBe(0)
  })

  it('still admits platform-admin', async () => {
    await putHandler(ev({ session: finops(), method: 'PUT', body: { workerName: 'budget-alert', enabled: false, reason: 'mine to throw' } }))
    const rows = await t.client<{ enabled: boolean }[]>`SELECT enabled FROM worker_enablement WHERE worker_name = 'budget-alert'`
    expect(rows[0]!.enabled).toBe(false)
  })

  it('still lets a region admin READ the card — seeing a thrown kill-switch is not a boundary crossing', async () => {
    const got = (await getHandler(ev({ session: regionAdmin(), method: 'GET' }))) as { workers: WorkerRow[] }
    expect(got.workers.length, 'a region admin must still be able to explain a gap in their own attribution').toBeGreaterThan(0)
  })
})
