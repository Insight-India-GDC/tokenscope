// @vitest-environment node
/*
 * On-demand reconciliation backfill (mig 0074): admin enqueues a historical pull → the
 * reconciliation-backfill worker drains it (adapter pull + engine + §A reconcile). Tests the
 * NEW logic: endpoint validation/RBAC + the worker's claim/error/idempotency + happy-path wiring.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import * as schema from '../../../drizzle/schema'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'
import { injectTestSession } from '../../helpers/auth'
import type { Session } from '../../../server/utils/auth'
import { runReconciliationBackfill, BACKFILL_CHUNK_DAYS } from '../../../server/workers/reconciliation-backfill'
import { ADAPTER_FACTORIES } from '../../../server/reconciliation/adapters/registry'
import type { ReconciledLine } from '../../../server/reconciliation/types'
import backfillPost from '../../../server/api/v1/admin/reconciliation/backfill.post'
import backfillGet from '../../../server/api/v1/admin/reconciliation/backfill.get'

let t: TestDb
let regionId = ''
let ouId = ''
let finopsId = ''
let devId = ''
let targetTeammateId = ''
let instanceId = ''
let entReconciledId = '' // github enterprise, reconciled
let entIndicativeId = '' // github enterprise, indicative (not backfillable)

const SECRET = 'ent-bf-key'
const ENV_KEY = 'NUXT_GITHUB_PAT_ENT_BF_KEY'

function daysAgo(n: number): string {
  const d = new Date()
  d.setUTCDate(d.getUTCDate() - n)
  return d.toISOString().slice(0, 10)
}
function addDays(iso: string, n: number): string {
  const d = new Date(`${iso}T00:00:00.000Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}
/** The consecutive slice windows the worker should pull for [start, end] — CHUNK_DAYS-agnostic. */
function slicesFor(start: string, end: string): string[] {
  const out: string[] = []
  let c = start
  while (c <= end) {
    const e = addDays(c, BACKFILL_CHUNK_DAYS - 1)
    const sliceEnd = e < end ? e : end
    out.push(`${c}..${sliceEnd}`)
    c = addDays(sliceEnd, 1)
  }
  return out
}

function ev(opts: { method: string; body?: unknown; session: Session; params?: Record<string, string> }) {
  const headers: Record<string, string> = { host: 'localhost:3450', origin: 'http://localhost:3450' }
  const e = {
    method: opts.method, path: '/x', context: { params: opts.params ?? {} },
    node: {
      req: { method: opts.method, url: '/x', body: opts.body, socket: { remoteAddress: '127.0.0.1' }, get headers() { return { ...headers, 'content-type': 'application/json' } } },
      res: {
        _headers: {} as Record<string, string | string[]>, statusCode: 200,
        getHeader(n: string) { return this._headers[n.toLowerCase()] }, setHeader(n: string, v: string | string[]) { this._headers[n.toLowerCase()] = v },
        removeHeader(n: string) { this._headers[n.toLowerCase()] = '' }, appendHeader(n: string, v: string | string[]) { this._headers[n.toLowerCase()] = v },
        get headersSent() { return false },
      },
    },
  }
  injectTestSession(e as unknown as Parameters<typeof injectTestSession>[0], opts.session)
  return e as unknown as Parameters<typeof backfillPost>[0]
}
const finops = (): Session => ({ teammateId: finopsId, email: 'bf-fin@x.test', displayName: 'Fin', role: 'platform-admin', regionId, orgPath: 'bf.svc' })
const dev = (): Session => ({ teammateId: devId, email: 'bf-dev@x.test', displayName: 'Dev', role: 'developer', regionId, orgPath: 'bf.svc' })
// A region-scoped admin. The target is resolved with no region term, so the route is platform-admin only.
const regionAdmin = (): Session => ({ teammateId: '9a1e0000-0000-4000-8000-0000000000b3', email: 'bf-ra@x.test', displayName: 'RA', role: 'admin', regionId, orgPath: 'bf.svc' })

beforeAll(async () => {
  t = await startTestDb(); process.env.DATABASE_URL = t.url
  const [r] = await t.db.insert(schema.region).values({ code: 'bf-r', displayName: 'BF' }).returning(); regionId = r!.id
  const [o] = await t.db.insert(schema.orgUnit).values({ regionId, path: 'bf.svc', code: 'bf-svc', displayName: 'Svc', unitType: 'bu', isCostOwningUnit: true }).returning(); ouId = o!.id
  const [f] = await t.db.insert(schema.teammate).values({ entraOid: 'oid-bf-fin', email: 'bf-fin@x.test', role: 'platform-admin', regionId, orgUnitId: ouId }).returning(); finopsId = f!.id
  const [d] = await t.db.insert(schema.teammate).values({ entraOid: 'oid-bf-dev', email: 'bf-dev@x.test', role: 'developer', regionId, orgUnitId: ouId }).returning(); devId = d!.id
  const [tm] = await t.db.insert(schema.teammate).values({ entraOid: 'oid-bf-tgt', email: 'bf-tgt@x.test', regionId, orgUnitId: ouId }).returning(); targetTeammateId = tm!.id
  instanceId = '11111111-1111-1111-1111-111111111111'
  await t.db.insert(schema.instanceAttestation).values({ instanceId, principalOid: 'oid-bf-tgt', teammateId: targetTeammateId, projectCodeHash: 'h', rawProjectCode: 'BF', tool: 'copilot-cli', tsStart: new Date('2026-06-01T00:00:00Z'), regionId, orgUnitId: ouId })
  const [er] = await t.db.insert(schema.providerEnterprise).values({ provider: 'github', externalId: 'ent-bf', displayName: 'BF Ent', reconciliationMode: 'reconciled', billing: 'tracked', credentialSecretName: SECRET }).returning(); entReconciledId = er!.id
  const [ei] = await t.db.insert(schema.providerEnterprise).values({ provider: 'github', externalId: 'ent-bf-ind', displayName: 'BF Ind', reconciliationMode: 'indicative', billing: 'tracked' }).returning(); entIndicativeId = ei!.id
}, 180_000)
afterAll(async () => { if (t) await stopTestDb(t) }, 30_000)
beforeEach(async () => {
  await t.client`DELETE FROM reconciliation_backfill_request`
  await t.client`DELETE FROM reconciliation_record WHERE teammate_id = ${targetTeammateId}::uuid`
  await t.client`DELETE FROM unaccounted_usage WHERE teammate_id = ${targetTeammateId}::uuid`
  await t.client`DELETE FROM attribution_record WHERE teammate_id = ${targetTeammateId}::uuid`
  Reflect.deleteProperty(process.env, ENV_KEY)
})

describe('backfill endpoint (POST/GET)', () => {
  it('platform-admin enqueues a valid backfill (github enterprise, 30 days back)', async () => {
    const res = (await backfillPost(ev({ method: 'POST', session: finops(), body: { targetKind: 'enterprise', targetId: entReconciledId, startDate: daysAgo(30) } }))) as { status: string; provider: string; externalRef: string }
    expect(res.status).toBe('pending')
    expect(res.provider).toBe('github')
    expect(res.externalRef).toBe('ent-bf')
    const [row] = await t.client<{ status: string; end_date: string }[]>`SELECT status, end_date::text AS end_date FROM reconciliation_backfill_request WHERE provider='github' AND external_ref='ent-bf'`
    expect(row!.status).toBe('pending')
    expect(row!.end_date).toBe(daysAgo(0)) // endDate = today
  })

  it('rejects a non-admin (developer) with 403', async () => {
    await expect(backfillPost(ev({ method: 'POST', session: dev(), body: { targetKind: 'enterprise', targetId: entReconciledId, startDate: daysAgo(30) } }))).rejects.toMatchObject({ statusCode: 403 })
  })

  it('rejects a region admin with 403 and enqueues nothing (platform-admin only)', async () => {
    const before = await t.client<{ n: string }[]>`SELECT COUNT(*)::text AS n FROM reconciliation_backfill_request`
    await expect(backfillPost(ev({ method: 'POST', session: regionAdmin(), body: { targetKind: 'enterprise', targetId: entReconciledId, startDate: daysAgo(30) } }))).rejects.toMatchObject({ statusCode: 403 })
    const after = await t.client<{ n: string }[]>`SELECT COUNT(*)::text AS n FROM reconciliation_backfill_request`
    expect(after[0]!.n).toBe(before[0]!.n)
  })

  it('rejects a startDate more than 90 days ago (400)', async () => {
    await expect(backfillPost(ev({ method: 'POST', session: finops(), body: { targetKind: 'enterprise', targetId: entReconciledId, startDate: daysAgo(120) } }))).rejects.toMatchObject({ statusCode: 400 })
  })

  it('rejects a future startDate (400)', async () => {
    await expect(backfillPost(ev({ method: 'POST', session: finops(), body: { targetKind: 'enterprise', targetId: entReconciledId, startDate: daysAgo(-5) } }))).rejects.toMatchObject({ statusCode: 400 })
  })

  it('rejects a non-reconciled (indicative) scope (400)', async () => {
    await expect(backfillPost(ev({ method: 'POST', session: finops(), body: { targetKind: 'enterprise', targetId: entIndicativeId, startDate: daysAgo(30) } }))).rejects.toMatchObject({ statusCode: 400 })
  })

  it('404s an unknown target', async () => {
    await expect(backfillPost(ev({ method: 'POST', session: finops(), body: { targetKind: 'enterprise', targetId: '99999999-9999-9999-9999-999999999999', startDate: daysAgo(30) } }))).rejects.toMatchObject({ statusCode: 404 })
  })

  it('409s a second in-flight backfill for the same scope', async () => {
    await backfillPost(ev({ method: 'POST', session: finops(), body: { targetKind: 'enterprise', targetId: entReconciledId, startDate: daysAgo(30) } }))
    await expect(backfillPost(ev({ method: 'POST', session: finops(), body: { targetKind: 'enterprise', targetId: entReconciledId, startDate: daysAgo(10) } }))).rejects.toMatchObject({ statusCode: 409 })
  })

  it('accepts startDate == today (a valid 1-day window)', async () => {
    const res = (await backfillPost(ev({ method: 'POST', session: finops(), body: { targetKind: 'enterprise', targetId: entReconciledId, startDate: daysAgo(0) } }))) as { status: string }
    expect(res.status).toBe('pending')
    const [row] = await t.client<{ start_date: string; end_date: string }[]>`SELECT start_date::text AS start_date, end_date::text AS end_date FROM reconciliation_backfill_request WHERE external_ref='ent-bf'`
    expect(row!.start_date).toBe(daysAgo(0))
    expect(row!.end_date).toBe(daysAgo(0))
  })

  it('GET lists recent requests', async () => {
    await backfillPost(ev({ method: 'POST', session: finops(), body: { targetKind: 'enterprise', targetId: entReconciledId, startDate: daysAgo(30) } }))
    const out = (await backfillGet(ev({ method: 'GET', session: finops() }))) as { requests: Array<{ externalRef: string; status: string }> }
    expect(out.requests.some((r) => r.externalRef === 'ent-bf' && r.status === 'pending')).toBe(true)
  })
})

describe('reconciliation-backfill worker', () => {
  async function enqueue(startDate: string, endDate: string): Promise<void> {
    await t.client`
      INSERT INTO reconciliation_backfill_request (provider, target_kind, external_ref, display_name, start_date, end_date)
      VALUES ('github', 'enterprise', 'ent-bf', 'BF Ent', ${startDate}::date, ${endDate}::date)`
  }

  it('claims nothing when the queue is empty', async () => {
    const res = await runReconciliationBackfill(t.db)
    expect(res.claimed).toBe(0)
  })

  it('marks a request FAILED when the credential cannot be resolved (no secret wired)', async () => {
    await enqueue(daysAgo(30), daysAgo(0)) // env secret NOT set → resolveEnterpriseCredential → null
    const res = await runReconciliationBackfill(t.db)
    expect(res.claimed).toBe(1)
    expect(res.status).toBe('failed')
    const [row] = await t.client<{ status: string; error: string }[]>`SELECT status, error FROM reconciliation_backfill_request WHERE external_ref='ent-bf'`
    expect(row!.status).toBe('failed')
    expect(row!.error).toMatch(/credential/i)
  })

  it('CONTINUES an in-progress RUNNING request (resume after a budget-exhausted/crashed tick)', async () => {
    // A 'running' row mid-window (cursor set) is re-claimed and continued — no staleness threshold;
    // the per-worker dispatch lock guarantees single-flight, so any running row is safe to resume.
    await t.client`
      INSERT INTO reconciliation_backfill_request (provider, target_kind, external_ref, start_date, end_date, status, cursor_date, claimed_at, started_at)
      VALUES ('github','enterprise','ent-bf', ${daysAgo(30)}::date, ${daysAgo(0)}::date, 'running', ${daysAgo(20)}::date, now(), now())`
    const res = await runReconciliationBackfill(t.db)
    expect(res.claimed).toBe(1) // the running row was continued (then fails on no-credential here)
    const [row] = await t.client<{ status: string }[]>`SELECT status FROM reconciliation_backfill_request WHERE external_ref='ent-bf'`
    expect(row!.status).toBe('failed') // no longer stuck 'running'
  })

  describe('happy path + chunking (injected adapter)', () => {
    const realGithub = ADAPTER_FACTORIES.github
    let pulled: string[] = []
    const WIN_START = daysAgo(13)
    const WIN_END = daysAgo(8)
    const REAL_DAY = daysAgo(10) // the day with real provider usage (inside the window)
    const BIG = 600_000 // budget large enough to drain the whole (tiny) window in one invocation

    beforeEach(() => {
      pulled = []
      process.env[ENV_KEY] = 'fake-pat'
      const line: ReconciledLine = {
        provider: 'github', enterpriseRef: 'ent-bf', licenseOrg: 'org-bf', periodDate: REAL_DAY,
        subject: { kind: 'teammate', teammateId: targetTeammateId }, category: 'copilot_interactive',
        unit: { quantity: 3400, unitType: 'ai-credits' }, facets: { gross: 3400, discount: 0, net: 0 },
        rateUsdPerUnit: '0.01', amountUsd: '34.00', spendClass: 'indicative', indicativeReason: 'copilot-pre-billing', raw: {},
      }
      // Fake adapter records each pulled slice; returns the $34 line only when its day is in-slice.
      ADAPTER_FACTORIES.github = (() => ({
        pull: async (w: { startDate: string; endDate: string }) => {
          pulled.push(`${w.startDate}..${w.endDate}`)
          return REAL_DAY >= w.startDate && REAL_DAY <= w.endDate ? [line] : []
        },
      })) as typeof realGithub
    })
    afterEach(() => { ADAPTER_FACTORIES.github = realGithub })

    it('pulls the window in consecutive slices, writes reconciliation truth, and surfaces §A unaccounted', async () => {
      // OTel captured only $19 that day → §A unaccounted should be $34 − $19 = $15.
      await t.db.insert(schema.attributionRecord).values({
        instanceId, claudeSessionId: 'bf-otel', teammateId: targetTeammateId, regionId, orgUnitId: ouId, tool: 'copilot-cli',
        model: 'gpt', tokenType: 'output', tokens: 1000n, costUsd: '19.00', fidelityTier: 'tier-1', costBasis: 'estimated',
        tsEvent: new Date(`${REAL_DAY}T12:00:00Z`), sourceRunId: '22222222-2222-2222-2222-222222222222',
      })
      await enqueue(WIN_START, WIN_END)

      const res = await runReconciliationBackfill(t.db, { budgetMs: BIG })
      expect(res.status).toBe('succeeded')
      // The window is covered by consecutive, non-overlapping slices (no gap, no dup):
      expect(pulled).toEqual(slicesFor(WIN_START, WIN_END))
      const [rec] = await t.client<{ usd: string }[]>`SELECT actual_usd::text AS usd FROM reconciliation_record WHERE teammate_id=${targetTeammateId}::uuid AND provider='github' AND period_date=${REAL_DAY}::date`
      expect(Number(rec!.usd)).toBeCloseTo(34, 2)
      const [unacc] = await t.client<{ cost: string }[]>`SELECT cost_usd::text AS cost FROM unaccounted_usage WHERE teammate_id=${targetTeammateId}::uuid AND day=${REAL_DAY}::date AND tool='copilot-cli'`
      expect(Number(unacc!.cost)).toBeCloseTo(15, 2)
    })

    it('budget-limited: one slice per invocation, monotonic cursor, no missed/dup days, then completes', async () => {
      // budgetMs=0 ⇒ exactly one slice per invocation (the post-slice budget check breaks), so it
      // takes one tick per slice and resumes from cursor_date each time.
      const expected = slicesFor(WIN_START, WIN_END)
      await enqueue(WIN_START, WIN_END)
      let prevCursor = WIN_START
      for (let i = 0; i < expected.length; i++) {
        const r = await runReconciliationBackfill(t.db, { budgetMs: 0 })
        const [c] = await t.client<{ cur: string | null }[]>`SELECT cursor_date::text AS cur FROM reconciliation_backfill_request WHERE external_ref='ent-bf'`
        if (i < expected.length - 1) {
          expect(r.status).toBe('running')
          expect(c!.cur! > prevCursor).toBe(true) // cursor advances monotonically, one slice at a time
          prevCursor = c!.cur!
        } else {
          expect(r.status).toBe('succeeded') // final slice completes the window
        }
      }
      expect(pulled).toEqual(expected) // every slice pulled exactly once, in order
    })

    it('RESUMES from cursor_date — only pulls the remaining slices, then completes', async () => {
      // A prior tick already pulled through REAL_DAY-1 (cursor parked mid-window).
      await t.client`
        INSERT INTO reconciliation_backfill_request (provider, target_kind, external_ref, start_date, end_date, status, cursor_date, started_at, claimed_at)
        VALUES ('github','enterprise','ent-bf', ${WIN_START}::date, ${WIN_END}::date, 'running', ${REAL_DAY}::date, now(), now())`
      const res = await runReconciliationBackfill(t.db, { budgetMs: BIG })
      expect(res.status).toBe('succeeded')
      expect(pulled).toEqual(slicesFor(REAL_DAY, WIN_END)) // ONLY the remaining tail, not the already-done head
    })
  })
})
