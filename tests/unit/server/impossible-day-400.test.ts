// @vitest-environment node
/*
 * An impossible calendar day (2026-02-31) passes a YYYY-MM-DD shape regex and
 * then fails the Postgres `::date` cast, which surfaces as a 500. Each route
 * below must refuse it as a 400 BEFORE it reaches the database: the DB layer is
 * stubbed to throw, so a request that gets that far fails the assertion.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { injectTestSession } from '../../helpers/auth'
import type { Session } from '../../../server/utils/auth'

vi.mock('../../../server/db/request-rls', () => ({
  withRequestRls: vi.fn(async () => {
    throw new Error('reached the database')
  }),
}))

const { default: recordsGet } = await import('../../../server/api/v1/admin/reconciliation/records.get')
const { default: backfillPost } = await import('../../../server/api/v1/admin/reconciliation/backfill.post')
const { default: ratePlansPost } = await import(
  '../../../server/api/v1/admin/reconciliation/enterprises/[id]/copilot-rate-plans.post'
)
const { default: wireShapePost } = await import('../../../server/api/v1/admin/diagnostics/provider-wire-shape.post')

const ADMIN: Session = {
  teammateId: '9a1e0000-0000-4000-8000-0000000000a1',
  email: 'pa@x.test',
  displayName: 'PA',
  role: 'platform-admin',
  regionId: '9a1e0000-0000-4000-8000-0000000000b1',
  orgPath: 'x',
}

type Handler = (e: never) => Promise<unknown>

function ev(opts: { method: string; url: string; body?: unknown; params?: Record<string, string> }) {
  const headers: Record<string, string> = {
    host: 'localhost:3450',
    origin: 'http://localhost:3450',
    'content-type': 'application/json',
  }
  const e = {
    method: opts.method,
    path: opts.url,
    context: { params: opts.params ?? {} },
    node: {
      req: { method: opts.method, url: opts.url, body: opts.body, socket: { remoteAddress: '127.0.0.1' }, headers },
      res: {
        _headers: {} as Record<string, string | string[]>,
        statusCode: 200,
        getHeader(n: string) { return this._headers[n.toLowerCase()] },
        setHeader(n: string, v: string | string[]) { this._headers[n.toLowerCase()] = v },
        removeHeader(n: string) { this._headers[n.toLowerCase()] = '' },
        get headersSent() { return false },
      },
    },
  }
  injectTestSession(e as never, ADMIN)
  return e as never
}

async function statusOf(handler: Handler, e: never): Promise<number | string> {
  try {
    await handler(e)
    return 200
  } catch (err) {
    return (err as { statusCode?: number }).statusCode ?? (err as Error).message
  }
}

describe('impossible calendar days are a 400, not a 500', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-10-15T12:00:00Z'))
  })
  afterEach(() => vi.useRealTimers())

  it('GET /admin/reconciliation/records?periodFrom=2026-02-31', async () => {
    expect(await statusOf(recordsGet as Handler, ev({ method: 'GET', url: '/x?periodFrom=2026-02-31' }))).toBe(400)
    expect(await statusOf(recordsGet as Handler, ev({ method: 'GET', url: '/x?periodTo=2026-09-31' }))).toBe(400)
  })

  it('POST /admin/reconciliation/backfill with startDate 2026-09-31 (inside the 90-day window once rolled over)', async () => {
    const body = { targetKind: 'org', targetId: '9a1e0000-0000-4000-8000-0000000000c1', startDate: '2026-09-31' }
    expect(await statusOf(backfillPost as Handler, ev({ method: 'POST', url: '/x', body }))).toBe(400)
  })

  it('POST copilot-rate-plans with a date-only validFrom / validTo of 2026-02-31', async () => {
    const params = { id: '9a1e0000-0000-4000-8000-0000000000d1' }
    for (const body of [{ validFrom: '2026-02-31' }, { validFrom: '2026-01-01', validTo: '2026-02-31' }]) {
      expect(await statusOf(ratePlansPost as Handler, ev({ method: 'POST', url: '/x', body, params }))).toBe(400)
    }
  })

  it('POST /admin/diagnostics/provider-wire-shape with day 2026-02-31', async () => {
    const body = { mode: 'stored', day: '2026-02-31' }
    expect(await statusOf(wireShapePost as Handler, ev({ method: 'POST', url: '/x', body }))).toBe(400)
  })

  it('a real day still gets past validation (reaches the stubbed database)', async () => {
    expect(await statusOf(recordsGet as Handler, ev({ method: 'GET', url: '/x?periodFrom=2026-02-28' }))).toBe(
      'reached the database',
    )
  })
})
