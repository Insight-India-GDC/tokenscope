// @vitest-environment node
/*
 * §A integrity — over-emission: OTel reports MORE than the provider API corroborates
 * (forged/mis-tagged emission) → flag the day → the dev quarantines the suspect session →
 * it's excluded and the over clears. The owner's example: a day's OTel is $500 ($450 + $50)
 * but the API is $50, so $450 is uncorroborated. docs/design/provider-billing-attribution-model.md §A.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { randomUUID } from 'node:crypto'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'
import { injectTestSession, type Session } from '../../helpers/auth'
import * as schema from '../../../drizzle/schema'
import { detectOverEmission } from '../../../server/usage/over-emission-detection'
import { reconcileUnaccountedUsage } from '../../../server/usage/unaccounted-reconciliation'
import { getMyUsage } from '../../../server/utils/me-queries'
import overGet from '../../../server/api/v1/me/over-emission.get'
import resolveHandler from '../../../server/api/v1/me/over-emission/[id]/resolve.post'
import { getWorker } from '../../../server/workers/registry'
import inboxListHandler from '../../../server/api/v1/me/inbox/index.get'
import { notifyEscalatedOverEmission } from '../../../server/notifications/over-emission'

let t: TestDb
let regionId = ''
let orgUnitId = ''
let teammateId = ''
let instanceId = ''
const WINDOW = { startDate: '2026-06-01', endDate: '2026-06-30' }
const DAY = '2026-06-20'

async function bill(costUsd: string): Promise<void> {
  await t.db.insert(schema.actualSpend).values({ teammateId, date: DAY, tool: 'claude-code', inputTokens: 0n, outputTokens: 0n, costUsd, source: 'api' })
}
async function otelSession(conv: string, costUsd: string): Promise<void> {
  await t.db.insert(schema.attributionRecord).values({
    instanceId, claudeSessionId: conv, teammateId, regionId, orgUnitId,
    tool: 'claude-code', model: 'opus', tokenType: 'output', tokens: 1000n, costUsd,
    fidelityTier: 'tier-1', costBasis: 'estimated', tsEvent: new Date(`${DAY}T12:00:00.000Z`), sourceRunId: randomUUID(),
  })
}
// A record of `conv` OUTSIDE the flag's (DAY, claude-code) cell — another day or tool.
async function otelRecordAt(conv: string, costUsd: string, ts: string, tool = 'claude-code'): Promise<void> {
  await t.db.insert(schema.attributionRecord).values({
    instanceId, claudeSessionId: conv, teammateId, regionId, orgUnitId,
    tool, model: 'opus', tokenType: 'output', tokens: 1000n, costUsd,
    fidelityTier: 'tier-1', costBasis: 'estimated', tsEvent: new Date(ts), sourceRunId: randomUUID(),
  })
}
// Real Entra OIDs are v4-shaped GUIDs (CLAUDE.md rule 18).
const REAL_ADMIN_OID = '9a1e0000-0000-4000-8000-0000000000ad'
function ev(opts: { id?: string; body?: unknown; impersonatorOid?: string }) {
  const headers: Record<string, string> = { host: 'localhost:3450', origin: 'http://localhost:3450', 'content-type': 'application/json' }
  const e = {
    method: 'POST', path: '/x', context: { params: opts.id ? { id: opts.id } : {} },
    node: {
      req: { method: opts.id ? 'POST' : 'GET', url: '/x', body: opts.body, socket: { remoteAddress: '127.0.0.1' }, get headers() { return headers } },
      res: {
        _headers: {} as Record<string, string | string[]>, statusCode: 200,
        getHeader(n: string) { return this._headers[n.toLowerCase()] }, setHeader(n: string, v: string | string[]) { this._headers[n.toLowerCase()] = v },
        removeHeader(n: string) { this._headers[n.toLowerCase()] = '' }, appendHeader(n: string, v: string | string[]) { this._headers[n.toLowerCase()] = v },
        get headersSent() { return false },
      },
    },
  }
  injectTestSession(e as unknown as Parameters<typeof injectTestSession>[0], {
    teammateId, email: 'oe@x.test', displayName: 'OE', role: 'developer', regionId, orgPath: 'oe',
    ...(opts.impersonatorOid ? { impersonatorOid: opts.impersonatorOid, impersonatorEmail: 'admin@x.test', impersonatedAt: new Date().toISOString() } : {}),
  } as Session)
  return e
}

beforeAll(async () => {
  t = await startTestDb(); process.env.DATABASE_URL = t.url
  const [r] = await t.db.insert(schema.region).values({ code: 'oe', displayName: 'OE' }).returning(); regionId = r!.id
  const [ou] = await t.db.insert(schema.orgUnit).values({ regionId, path: 'oe', code: 'oe-bu', displayName: 'OE', unitType: 'bu', isCostOwningUnit: true }).returning(); orgUnitId = ou!.id
  const [tm] = await t.db.insert(schema.teammate).values({ entraOid: 'oid-oe', email: 'oe@x.test', regionId, orgUnitId }).returning(); teammateId = tm!.id
  instanceId = randomUUID()
  await t.db.insert(schema.instanceAttestation).values({ instanceId, principalOid: 'oid-oe', teammateId, projectCodeHash: 'h', rawProjectCode: 'OE', tool: 'claude-code', tsStart: new Date('2026-06-01T00:00:00Z'), regionId, orgUnitId })
}, 180_000)
afterAll(async () => { if (t) await stopTestDb(t) }, 30_000)
beforeEach(async () => {
  await t.client`DELETE FROM over_emission WHERE teammate_id = ${teammateId}::uuid`
  await t.client`DELETE FROM unaccounted_usage WHERE teammate_id = ${teammateId}::uuid`
  await t.client`DELETE FROM session_quarantine WHERE teammate_id = ${teammateId}::uuid`
  await t.client`DELETE FROM attribution_record WHERE teammate_id = ${teammateId}::uuid`
  await t.client`DELETE FROM actual_spend WHERE teammate_id = ${teammateId}::uuid`
  await t.client`DELETE FROM usage_rollup_refresh WHERE teammate_id = ${teammateId}::uuid`
})

describe('over-emission (§A integrity)', () => {
  it('flags a material over-emission (API $50, OTel $500 → $450 uncorroborated)', async () => {
    await bill('50.00')
    await otelSession('sess-big', '450.00')
    await otelSession('sess-small', '50.00')
    const res = await detectOverEmission(t.db, WINDOW)
    expect(res.flagged).toBe(1)
    expect(res.totalOverUsd).toBeCloseTo(450, 2)
    // The high-confidence lane names itself (mig 0132): there IS a bill and OTel
    // materially exceeds it. Same vocabulary as the conversation_quarantine.reason
    // a resolve writes.
    const [row] = await t.client<{ reason: string }[]>`SELECT reason FROM over_emission WHERE teammate_id = ${teammateId}::uuid`
    expect(row!.reason).toBe('api-uncorroborated')
  })

  it('does NOT flag legitimate estimate drift (bill $50, OTel estimate $65 = 1.3x)', async () => {
    // The bill-vs-estimate basis means honest usage can run over; only an EGREGIOUS over
    // (>2x the bill, above a high floor) is a forgery. $15 over < max($25, 1.0*$50=$50).
    await bill('50.00')
    await otelSession('sess-a', '65.00')
    const res = await detectOverEmission(t.db, WINDOW)
    expect(res.flagged).toBe(0)
  })

  it('does NOT flag a teammate with OTel but NO API bill (org not reconciled — absence ≠ forgery); (A) the SEPARATE no-bill lane DOES pick it up above its floor', async () => {
    // No actual_spend at all for this day (the Anthropic org isn't reconciled), only OTel.
    // api=0 must NOT read as "uncorroborated $X" in the high-confidence lane — caught in
    // sandbox validation. But (A): a fully-unreconciled org with a LARGE OTel total was
    // previously invisible to BOTH lanes — $300 clears OVER_EMISSION_NO_BILL_FLOOR_USD
    // ($250), so the separate, lower-confidence lane flags it while the existing flag
    // stays untouched (never merged).
    await otelSession('sess-noapi', '300.00')
    const res = await detectOverEmission(t.db, WINDOW)
    expect(res.flagged).toBe(0)
    expect(res.totalOverUsd).toBe(0)
    expect(res.noBillFlagged).toBe(1)
    expect(res.totalNoBillUsd).toBeCloseTo(300, 2)
    // Persisted since mig 0132 (UF-21) — under its OWN reason, so it can never be
    // read as the high-confidence flag. Before the column existed this lane had
    // nowhere honest to live and was returned only in the worker's result.
    const rows = await t.client<{ reason: string; over: string; state: string }[]>`
      SELECT reason, over_usd::text AS over, state FROM over_emission WHERE teammate_id = ${teammateId}::uuid`
    expect(rows).toHaveLength(1)
    expect(rows[0]!.reason).toBe('no-bill-to-corroborate')
    expect(Number(rows[0]!.over)).toBeCloseTo(300, 2)
  })

  it('(A) the persisted no-bill row is NOT a review item: the endpoint does not return it, and it cannot be resolved', async () => {
    /*
     * The row exists so the number is durable and queryable. It is NOT an
     * accusation — api_usd = 0 means EITHER an unreconciled org OR genuinely zero
     * spend, and we cannot tell which. Asking a developer to quarantine a session
     * over it would be asking them to answer for our own configuration.
     *
     * Both doors are checked. The list filters, and the resolve route filters too:
     * an id it never handed out must not become resolvable just because the URL
     * takes one.
     */
    await otelSession('sess-noapi', '300.00')
    await detectOverEmission(t.db, WINDOW)
    const [row] = await t.client<{ id: string }[]>`
      SELECT id::text AS id FROM over_emission WHERE teammate_id = ${teammateId}::uuid AND reason = 'no-bill-to-corroborate'`
    expect(row).toBeDefined()

    const out = (await overGet(ev({}) as never)) as { flags: unknown[] }
    expect(out.flags).toHaveLength(0)

    await expect(
      resolveHandler(ev({ id: row!.id, body: { action: 'accept' } }) as never),
    ).rejects.toMatchObject({ statusCode: 404 })
    // ...and it stays open: a refused resolve must not half-apply.
    const [after] = await t.client<{ state: string }[]>`SELECT state FROM over_emission WHERE id = ${row!.id}::uuid`
    expect(after!.state).toBe('open')
  })

  it('(A) a second detector run does not blank the no-bill row (the refresh step checks BOTH lanes)', async () => {
    // Step 2 zeroes rows that are no longer material. Keyed on the high-confidence
    // CTE alone it would blank every no-bill row on the very tick that wrote it —
    // the two CTEs are disjoint, so "not in material" is not "no longer flagged".
    await otelSession('sess-noapi', '300.00')
    await detectOverEmission(t.db, WINDOW)
    const res = await detectOverEmission(t.db, WINDOW)
    expect(res.noBillFlagged).toBe(1)
    const rows = await t.client<{ over: string }[]>`
      SELECT over_usd::text AS over FROM over_emission WHERE teammate_id = ${teammateId}::uuid AND reason = 'no-bill-to-corroborate'`
    expect(rows).toHaveLength(1)
    expect(Number(rows[0]!.over)).toBeCloseTo(300, 2)
  })

  it('(A) a cell that CHANGES LANE keeps one row and stops describing itself as the lane it left', async () => {
    // The org starts reconciling: yesterday there was no bill to corroborate against,
    // today there is one and OTel materially exceeds it. Same (teammate, day, tool) —
    // the unique key means the same ROW, so its reason has to move with it.
    await otelSession('sess-big', '450.00')
    await otelSession('sess-small', '50.00')
    await detectOverEmission(t.db, WINDOW)
    const [before] = await t.client<{ reason: string }[]>`SELECT reason FROM over_emission WHERE teammate_id = ${teammateId}::uuid`
    expect(before!.reason).toBe('no-bill-to-corroborate')

    await bill('50.00') // the bill lands
    const res = await detectOverEmission(t.db, WINDOW)
    const rows = await t.client<{ reason: string; over: string }[]>`SELECT reason, over_usd::text AS over FROM over_emission WHERE teammate_id = ${teammateId}::uuid`
    expect(rows).toHaveLength(1)
    expect(rows[0]!.reason).toBe('api-uncorroborated')
    expect(Number(rows[0]!.over)).toBeCloseTo(450, 2)
    // ...and it now counts as the high-confidence flag it has become.
    expect(res.flagged).toBe(1)
    expect(res.totalOverUsd).toBeCloseTo(450, 2)
    expect(res.noBillFlagged).toBe(0)
    // The endpoint shows it, now that there IS a bill it contradicts.
    const out = (await overGet(ev({}) as never)) as { flags: unknown[] }
    expect(out.flags).toHaveLength(1)
  })

  it('(A) below the no-bill floor: the lower-confidence lane stays silent too (an unreconciled org must not read every small OTel total as a suspected forger)', async () => {
    await otelSession('sess-noapi-small', '100.00') // < OVER_EMISSION_NO_BILL_FLOOR_USD (250)
    const res = await detectOverEmission(t.db, WINDOW)
    expect(res.flagged).toBe(0)
    expect(res.noBillFlagged).toBe(0)
    expect(res.totalNoBillUsd).toBe(0)
  })

  it('(A) a still-settling recent day is exempt from the no-bill lane too (same settled-bill guard)', async () => {
    const recent = new Date(`${WINDOW.endDate}T00:00:00Z`)
    recent.setUTCDate(recent.getUTCDate() - 1)
    const recentDay = recent.toISOString().slice(0, 10)
    await t.db.insert(schema.attributionRecord).values({
      instanceId, claudeSessionId: 'recent-noapi', teammateId, regionId, orgUnitId, tool: 'claude-code',
      model: 'opus', tokenType: 'output', tokens: 1000n, costUsd: '500.00', fidelityTier: 'tier-2',
      costBasis: 'estimated', tsEvent: new Date(`${recentDay}T12:00:00Z`), sourceRunId: randomUUID(),
    })
    const res = await detectOverEmission(t.db, WINDOW)
    expect(res.noBillFlagged).toBe(0)
  })

  it('does NOT flag a still-settling recent day even with a huge over (bill lag)', async () => {
    // The bill for the last few days is still filling; OTel is real-time. Never flag it.
    const recent = new Date(`${WINDOW.endDate}T00:00:00Z`); recent.setUTCDate(recent.getUTCDate() - 1)
    const recentDay = recent.toISOString().slice(0, 10)
    await t.db.insert(schema.actualSpend).values({ teammateId, date: recentDay, tool: 'claude-code', inputTokens: 0n, outputTokens: 0n, costUsd: '50.00', source: 'api' })
    await t.db.insert(schema.attributionRecord).values({
      instanceId, claudeSessionId: 'recent-forge', teammateId, regionId, orgUnitId, tool: 'claude-code',
      model: 'opus', tokenType: 'output', tokens: 1000n, costUsd: '500.00', fidelityTier: 'tier-1',
      costBasis: 'estimated', tsEvent: new Date(`${recentDay}T12:00:00Z`), sourceRunId: randomUUID(),
    })
    const res = await detectOverEmission(t.db, WINDOW)
    expect(res.flagged).toBe(0) // within the settled-lag window → not flagged
  })

  it('RE-OPENS an accepted flag when a NEW forgery pushes the over materially past the watermark', async () => {
    await bill('50.00'); await otelSession('sess-1', '450.00'); await otelSession('sess-2', '50.00')
    await detectOverEmission(t.db, WINDOW)
    const [flag] = await t.client<{ id: string }[]>`SELECT id::text AS id FROM over_emission WHERE teammate_id = ${teammateId}::uuid`
    await resolveHandler(ev({ id: flag!.id, body: { action: 'accept' } }) as never) // vouch for $450
    // A new forged session lands the same day: over jumps to $850 (> $450 * 1.5).
    await otelSession('sess-3-forge', '400.00')
    await detectOverEmission(t.db, WINDOW)
    const [reopened] = await t.client<{ state: string; over: string }[]>`SELECT state, over_usd::text AS over FROM over_emission WHERE id = ${flag!.id}::uuid`
    expect(reopened!.state).toBe('open') // re-opened
    expect(Number(reopened!.over)).toBeCloseTo(850, 2)
  })

  it('the read endpoint returns the flag with the day sessions (biggest first)', async () => {
    await bill('50.00'); await otelSession('sess-big', '450.00'); await otelSession('sess-small', '50.00')
    await detectOverEmission(t.db, WINDOW)
    const out = (await overGet(ev({}) as never)) as { flags: Array<{ over_usd: string; sessions: Array<{ conversation_id: string; cost_usd: string }> }> }
    expect(out.flags).toHaveLength(1)
    expect(out.flags[0]!.over_usd).toBe('450.00')
    expect(out.flags[0]!.sessions[0]!.conversation_id).toBe('sess-big') // cost desc
  })

  it('quarantining the suspect session excludes it, clears the over, and removes it from needs-tagging', async () => {
    await bill('50.00'); await otelSession('sess-big', '450.00'); await otelSession('sess-small', '50.00')
    await detectOverEmission(t.db, WINDOW)
    const [flag] = await t.client<{ id: string }[]>`SELECT id::text AS id FROM over_emission WHERE teammate_id = ${teammateId}::uuid`
    // The dev calls it: the $450 session is the forgery.
    const r = (await resolveHandler(ev({ id: flag!.id, body: { action: 'quarantine', conversation_id: 'sess-big' } }) as never)) as { state: string }
    expect(r.state).toBe('quarantined')
    // session_quarantine written with the api-uncorroborated reason.
    const [sq] = await t.client<{ reason: string }[]>`SELECT reason FROM session_quarantine WHERE teammate_id = ${teammateId}::uuid AND conversation_id = 'sess-big'`
    expect(sq!.reason).toBe('api-uncorroborated')
    // The flip retro-mutates v_complete_usage with no timestamp signal, so the SAME
    // transaction must queue the teammate for a full-history rollup recompute
    // (docs/design/usage-rollup-lane.md R4).
    const refresh = await t.client<{ teammate_id: string }[]>`
      SELECT teammate_id::text AS teammate_id FROM usage_rollup_refresh WHERE teammate_id = ${teammateId}::uuid`
    expect(refresh).toHaveLength(1)
    expect(refresh[0]!.teammate_id).toBe(teammateId)
    // Re-detect: OTel (excl. the forgery) = $50 = API → over clears.
    await detectOverEmission(t.db, WINDOW)
    const [cleared] = await t.client<{ state: string; over: string }[]>`SELECT state, over_usd::text AS over FROM over_emission WHERE id = ${flag!.id}::uuid`
    expect(cleared!.state).toBe('quarantined')
    expect(Number(cleared!.over)).toBe(0)
    // The forged session no longer shows in the dev's needs-tagging.
    // AFTER the seeded event, not at the same instant. The month-to-date
    // window is half-open `[month start, now)` by house convention
    // (server/utils/period.ts) so an event at exactly `now` belongs to the
    // next read; reading at the event's own timestamp asserted against that.
    const usage = await getMyUsage(t.db, teammateId, new Date(`${DAY}T12:00:01.000Z`))
    // sess-small ($50, untagged) still needs tagging; sess-big is excluded.
    expect(Number(usage.unallocated.untagged_cost_usd)).toBeCloseTo(50, 2)
  })

  it('quarantining a forgery RESURFACES the genuine unaccounted usage it was masking', async () => {
    // API $100; OTel = real $50 + a $450 forgery = $500. Before quarantine, unaccounted is
    // masked to $0 (100 − 500 floored). After quarantining the forgery, the under lane nets
    // against the corroborated OTel ($50) → the genuine $50 of un-enrolled usage resurfaces.
    await bill('100.00')
    await otelSession('sess-real', '50.00')
    await otelSession('sess-forge', '450.00')
    await reconcileUnaccountedUsage(t.db, WINDOW)
    const [before] = await t.client<{ cost: string }[]>`SELECT COALESCE(MAX(cost_usd),0)::text AS cost FROM unaccounted_usage WHERE teammate_id = ${teammateId}::uuid AND day = ${DAY}::date`
    expect(Number(before!.cost)).toBe(0) // masked by the forgery
    await detectOverEmission(t.db, WINDOW)
    const [flag] = await t.client<{ id: string }[]>`SELECT id::text AS id FROM over_emission WHERE teammate_id = ${teammateId}::uuid`
    await resolveHandler(ev({ id: flag!.id, body: { action: 'quarantine', conversation_id: 'sess-forge' } }) as never)
    await reconcileUnaccountedUsage(t.db, WINDOW) // re-run the under lane
    const [after] = await t.client<{ cost: string }[]>`SELECT cost_usd::text AS cost FROM unaccounted_usage WHERE teammate_id = ${teammateId}::uuid AND day = ${DAY}::date`
    expect(Number(after!.cost)).toBeCloseTo(50, 2) // genuine un-enrolled usage now visible + taggable
  })

  it('quarantining a conversation with NO claude_session_id (keyed by its instance) excludes its records too', async () => {
    await bill('50.00')
    await otelSession('sess-small', '50.00')
    await t.db.insert(schema.attributionRecord).values({
      instanceId, claudeSessionId: null, teammateId, regionId, orgUnitId,
      tool: 'claude-code', model: 'opus', tokenType: 'output', tokens: 1000n, costUsd: '450.00',
      fidelityTier: 'tier-1', costBasis: 'estimated', tsEvent: new Date(`${DAY}T13:00:00.000Z`), sourceRunId: randomUUID(),
    })
    await detectOverEmission(t.db, WINDOW)
    const [flag] = await t.client<{ id: string }[]>`SELECT id::text AS id FROM over_emission WHERE teammate_id = ${teammateId}::uuid`
    const r = (await resolveHandler(ev({ id: flag!.id, body: { action: 'quarantine', conversation_id: instanceId } }) as never)) as { state: string }
    expect(r.state).toBe('quarantined')

    // The detector's corroborated OTel no longer counts it, so the over clears.
    await detectOverEmission(t.db, WINDOW)
    const [cleared] = await t.client<{ over: string }[]>`SELECT over_usd::text AS over FROM over_emission WHERE id = ${flag!.id}::uuid`
    expect(Number(cleared!.over)).toBe(0)
    // The §A read model drops it too: only sess-small's $50 remains on the OTel arm.
    const [vcu] = await t.client<{ usd: string }[]>`
      SELECT COALESCE(SUM(cost_usd), 0)::text AS usd FROM v_complete_usage
       WHERE teammate_id = ${teammateId}::uuid AND usage_provenance = 'otel-emitted'`
    expect(Number(vcu!.usd)).toBeCloseTo(50, 2)
    const usage = await getMyUsage(t.db, teammateId, new Date(`${DAY}T13:00:01.000Z`))
    expect(Number(usage.unallocated.untagged_cost_usd)).toBeCloseTo(50, 2)
  })

  it('quarantining over an existing heartbeat-coverage row takes the conversation\'s current figures, not the stale ones', async () => {
    await bill('50.00'); await otelSession('sess-big', '450.00'); await otelSession('sess-small', '50.00')
    await t.client`
      INSERT INTO session_quarantine
        (conversation_id, instance_id, teammate_id, region_id, org_unit_id,
         session_ts_start, session_ts_end, instance_ts_start, cost_usd, tokens, reason)
      VALUES ('sess-big', ${instanceId}::uuid, ${teammateId}::uuid, ${regionId}::uuid, ${orgUnitId}::uuid,
              '2026-06-01T00:00:00Z', '2026-06-01T00:00:01Z', '2026-06-01T00:00:00Z', 1.00, 1, 'no-covering-heartbeat')`
    await detectOverEmission(t.db, WINDOW)
    const [flag] = await t.client<{ id: string }[]>`SELECT id::text AS id FROM over_emission WHERE teammate_id = ${teammateId}::uuid`
    await resolveHandler(ev({ id: flag!.id, body: { action: 'quarantine', conversation_id: 'sess-big' } }) as never)
    const rows = await t.client<{ reason: string; cost: string; tokens: string; start: string }[]>`
      SELECT reason, cost_usd::text AS cost, tokens::text AS tokens,
             (session_ts_start AT TIME ZONE 'UTC')::date::text AS start
        FROM session_quarantine WHERE teammate_id = ${teammateId}::uuid AND conversation_id = 'sess-big'`
    expect(rows).toHaveLength(1)
    expect(rows[0]!.reason).toBe('api-uncorroborated')
    expect(Number(rows[0]!.cost)).toBeCloseTo(450, 2)
    expect(rows[0]!.tokens).toBe('1000')
    expect(rows[0]!.start).toBe(DAY)
  })

  it('accept keeps the OTel (dev vouches for it) and resolves the flag', async () => {
    await bill('50.00'); await otelSession('sess-x', '450.00'); await otelSession('sess-y', '50.00')
    await detectOverEmission(t.db, WINDOW)
    const [flag] = await t.client<{ id: string }[]>`SELECT id::text AS id FROM over_emission WHERE teammate_id = ${teammateId}::uuid`
    const r = (await resolveHandler(ev({ id: flag!.id, body: { action: 'accept' } }) as never)) as { state: string }
    expect(r.state).toBe('accepted')
    // AFTER the seeded event, not at the same instant. The month-to-date
    // window is half-open `[month start, now)` by house convention
    // (server/utils/period.ts) so an event at exactly `now` belongs to the
    // next read; reading at the event's own timestamp asserted against that.
    const usage = await getMyUsage(t.db, teammateId, new Date(`${DAY}T12:00:01.000Z`))
    expect(Number(usage.unallocated.untagged_cost_usd)).toBeCloseTo(500, 2) // both sessions still counted
    // accept changes NOTHING in v_complete_usage — it must not queue a rollup recompute.
    const refresh = await t.client`SELECT 1 FROM usage_rollup_refresh WHERE teammate_id = ${teammateId}::uuid`
    expect(refresh).toHaveLength(0)
  })

  /*
   * C13/H34 — the quarantine is bound to the FLAG's (UTC day, tool) cell. It removes
   * the whole conversation from §A, so a conversation with usage outside the cell
   * would remove more than the flag covers.
   */
  it('REFUSES (422) to quarantine a conversation that has usage on another day, and writes nothing', async () => {
    await bill('50.00'); await otelSession('sess-big', '450.00'); await otelSession('sess-small', '50.00')
    await detectOverEmission(t.db, WINDOW)
    // The same conversation also carries $5,000 on a day the flag says nothing about.
    await otelRecordAt('sess-big', '5000.00', '2026-06-10T12:00:00.000Z')
    const [flag] = await t.client<{ id: string }[]>`SELECT id::text AS id FROM over_emission WHERE teammate_id = ${teammateId}::uuid AND day = ${DAY}::date`
    await expect(
      resolveHandler(ev({ id: flag!.id, body: { action: 'quarantine', conversation_id: 'sess-big' } }) as never),
    ).rejects.toMatchObject({ statusCode: 422 })
    // Nothing half-applied: no quarantine, flag still open, no recompute queued, no audit.
    expect(await t.client`SELECT 1 FROM session_quarantine WHERE teammate_id = ${teammateId}::uuid`).toHaveLength(0)
    const [still] = await t.client<{ state: string }[]>`SELECT state FROM over_emission WHERE id = ${flag!.id}::uuid`
    expect(still!.state).toBe('open')
    expect(await t.client`SELECT 1 FROM usage_rollup_refresh WHERE teammate_id = ${teammateId}::uuid`).toHaveLength(0)
    expect(await t.client`SELECT 1 FROM audit_event WHERE subject_id = ${flag!.id}::uuid`).toHaveLength(0)
  })

  it('REFUSES (422) a conversation with usage under another tool on the flagged day', async () => {
    await bill('50.00'); await otelSession('sess-big', '450.00'); await otelSession('sess-small', '50.00')
    await detectOverEmission(t.db, WINDOW)
    await otelRecordAt('sess-big', '300.00', `${DAY}T13:00:00.000Z`, 'copilot-cli')
    const [flag] = await t.client<{ id: string }[]>`SELECT id::text AS id FROM over_emission WHERE teammate_id = ${teammateId}::uuid AND tool = 'claude-code'`
    await expect(
      resolveHandler(ev({ id: flag!.id, body: { action: 'quarantine', conversation_id: 'sess-big' } }) as never),
    ).rejects.toMatchObject({ statusCode: 422 })
    expect(await t.client`SELECT 1 FROM session_quarantine WHERE teammate_id = ${teammateId}::uuid`).toHaveLength(0)
  })

  /*
   * C2 — under persona override the session IS the persona, so actor_teammate_id
   * names the persona. audit_event.impersonator_oid (mig 0154) records the real
   * admin, stamped centrally by recordAuditEvent from withRequestRls's context.
   */
  it('an audited action under persona override records the real admin as impersonator', async () => {
    await bill('50.00'); await otelSession('sess-x', '450.00'); await otelSession('sess-y', '50.00')
    await detectOverEmission(t.db, WINDOW)
    const [flag] = await t.client<{ id: string }[]>`SELECT id::text AS id FROM over_emission WHERE teammate_id = ${teammateId}::uuid`
    await resolveHandler(ev({ id: flag!.id, body: { action: 'escalate' }, impersonatorOid: REAL_ADMIN_OID }) as never)
    const rows = await t.client<{ actor: string; impersonator: string | null }[]>`
      SELECT actor_teammate_id::text AS actor, impersonator_oid AS impersonator
      FROM audit_event WHERE subject_id = ${flag!.id}::uuid AND event_type = 'over-emission-resolved'`
    expect(rows).toHaveLength(1)
    expect(rows[0]!.actor).toBe(teammateId) // the persona
    expect(rows[0]!.impersonator).toBe(REAL_ADMIN_OID) // the admin behind it
  })

  it('the same action with no override records impersonator NULL', async () => {
    await bill('50.00'); await otelSession('sess-x', '450.00'); await otelSession('sess-y', '50.00')
    await detectOverEmission(t.db, WINDOW)
    const [flag] = await t.client<{ id: string }[]>`SELECT id::text AS id FROM over_emission WHERE teammate_id = ${teammateId}::uuid`
    await resolveHandler(ev({ id: flag!.id, body: { action: 'accept' } }) as never)
    const rows = await t.client<{ impersonator: string | null }[]>`
      SELECT impersonator_oid AS impersonator FROM audit_event
      WHERE subject_id = ${flag!.id}::uuid AND event_type = 'over-emission-resolved'`
    expect(rows).toHaveLength(1)
    expect(rows[0]!.impersonator).toBeNull()
  })

  /*
   * The resolve route's cell bound is a snapshot. A quarantine is conversation-wide,
   * so records the same conversation writes LATER (another day or tool) would be
   * hidden from §A with no check covering them. The usage-reconciliation worker
   * sweeps for that: lift the quarantine, escalate the flag, audit, queue a rollup.
   * Driven through the registry entry the scheduler calls (rules 10/16).
   */
  async function quarantineViaRoute(conv: string): Promise<string> {
    await bill('50.00'); await otelSession(conv, '450.00'); await otelSession('sess-honest', '50.00')
    await detectOverEmission(t.db, WINDOW)
    const [flag] = await t.client<{ id: string }[]>`SELECT id::text AS id FROM over_emission WHERE teammate_id = ${teammateId}::uuid`
    await resolveHandler(ev({ id: flag!.id, body: { action: 'quarantine', conversation_id: conv } }) as never)
    // The route queued its own recompute; clear it so the sweep's is observable.
    await t.client`DELETE FROM usage_rollup_refresh WHERE teammate_id = ${teammateId}::uuid`
    return flag!.id
  }
  async function runScheduledWorker(): Promise<void> {
    const worker = getWorker('usage-reconciliation')
    expect(worker).toBeDefined()
    await worker!.run(t.db)
  }

  it('the scheduled sweep LIFTS a quarantine whose conversation later records usage on another day, and escalates the flag', async () => {
    const flagId = await quarantineViaRoute('sess-reuse')
    // Same conversation id, used again two days later (UTC).
    await otelRecordAt('sess-reuse', '120.00', '2026-06-22T09:00:00.000Z')

    await runScheduledWorker()

    const [sq] = await t.client<{ resolved: boolean; reason: string }[]>`
      SELECT resolved_at IS NOT NULL AS resolved, reason FROM session_quarantine
      WHERE teammate_id = ${teammateId}::uuid AND conversation_id = 'sess-reuse'`
    expect(sq!.reason).toBe('api-uncorroborated') // kept, not deleted
    expect(sq!.resolved).toBe(true)
    const [flag] = await t.client<{ state: string; conv: string | null; by: string | null }[]>`
      SELECT state, quarantined_conversation_id AS conv, resolved_by::text AS by FROM over_emission WHERE id = ${flagId}::uuid`
    expect(flag!.state).toBe('escalated')
    expect(flag!.conv).toBe('sess-reuse')
    expect(flag!.by).toBeNull() // the system made this call, not the developer
    expect(await t.client`SELECT 1 FROM usage_rollup_refresh WHERE teammate_id = ${teammateId}::uuid`).toHaveLength(1)
    const audits = await t.client<{ actor: string | null; system: string; payload: { conversation_id: string; previous_state: string } }[]>`
      SELECT actor_teammate_id::text AS actor, actor_system AS system, payload FROM audit_event
      WHERE subject_id = ${flagId}::uuid AND event_type = 'over-emission-quarantine-lifted'`
    expect(audits).toHaveLength(1)
    expect(audits[0]!.actor).toBeNull()
    expect(audits[0]!.system).toBe('usage-reconciliation')
    expect(audits[0]!.payload.conversation_id).toBe('sess-reuse')
    expect(audits[0]!.payload.previous_state).toBe('quarantined')
    // The developer can no longer re-quarantine from this flag.
    await expect(
      resolveHandler(ev({ id: flagId, body: { action: 'quarantine', conversation_id: 'sess-reuse' } }) as never),
    ).rejects.toMatchObject({ statusCode: 409 })

    // Idempotent: a second tick changes nothing and audits nothing more.
    await t.client`DELETE FROM usage_rollup_refresh WHERE teammate_id = ${teammateId}::uuid`
    await runScheduledWorker()
    expect(await t.client`SELECT 1 FROM audit_event WHERE subject_id = ${flagId}::uuid AND event_type = 'over-emission-quarantine-lifted'`).toHaveLength(1)
    expect(await t.client`SELECT 1 FROM usage_rollup_refresh WHERE teammate_id = ${teammateId}::uuid`).toHaveLength(0)
  })

  it('the sweep also catches a later record under ANOTHER TOOL on the flagged day', async () => {
    const flagId = await quarantineViaRoute('sess-reuse')
    await otelRecordAt('sess-reuse', '30.00', `${DAY}T23:30:00.000Z`, 'copilot-cli')
    await runScheduledWorker()
    const [flag] = await t.client<{ state: string }[]>`SELECT state FROM over_emission WHERE id = ${flagId}::uuid`
    expect(flag!.state).toBe('escalated')
    expect(await t.client`SELECT 1 FROM session_quarantine WHERE teammate_id = ${teammateId}::uuid AND resolved_at IS NULL`).toHaveLength(0)
  })

  it('the sweep leaves a quarantine alone while its conversation stays inside the flag cell', async () => {
    const flagId = await quarantineViaRoute('sess-reuse')
    // More of the same conversation, still on the flag's UTC day and tool.
    await otelRecordAt('sess-reuse', '20.00', `${DAY}T23:59:00.000Z`)
    await runScheduledWorker()
    const [flag] = await t.client<{ state: string }[]>`SELECT state FROM over_emission WHERE id = ${flagId}::uuid`
    expect(flag!.state).toBe('quarantined')
    expect(await t.client`SELECT 1 FROM session_quarantine WHERE teammate_id = ${teammateId}::uuid AND resolved_at IS NULL`).toHaveLength(1)
    expect(await t.client`SELECT 1 FROM audit_event WHERE subject_id = ${flagId}::uuid AND event_type = 'over-emission-quarantine-lifted'`).toHaveLength(0)
    expect(await t.client`SELECT 1 FROM usage_rollup_refresh WHERE teammate_id = ${teammateId}::uuid`).toHaveLength(0)
  })
})

/*
 * An escalated flag leaves the developer's queue, so the usage-reconciliation
 * worker puts it in the admins' inbox (server/notifications/over-emission.ts):
 * the flag's region's admins and the platform admins, never a sibling region's.
 * Driven through the registry entry the scheduler calls, after a real escalation
 * through the route (rules 10/16).
 */
describe('escalated flags reach the region admins', () => {
  let regionAdmin = ''
  let platformAdmin = ''
  let otherRegionAdmin = ''
  beforeAll(async () => {
    const [other] = await t.db.insert(schema.region).values({ code: 'oe-other', displayName: 'Other' }).returning()
    const [otherOu] = await t.db.insert(schema.orgUnit).values({ regionId: other!.id, path: 'oe_other', code: 'oe-other-bu', displayName: 'Other', unitType: 'bu', isCostOwningUnit: true }).returning()
    // Placed in a unit of their region: teammate.region_id follows the unit.
    const mk = async (email: string, role: string, region: string, unit: string) => {
      const [tm] = await t.db.insert(schema.teammate).values({ entraOid: `oid-${email}`, email, displayName: email, role, regionId: region, orgUnitId: unit } as never).returning()
      return tm!.id
    }
    regionAdmin = await mk('ra@x.test', 'admin', regionId, orgUnitId)
    platformAdmin = await mk('pa@x.test', 'platform-admin', regionId, orgUnitId)
    otherRegionAdmin = await mk('ora@x.test', 'admin', other!.id, otherOu!.id)
  })
  beforeEach(async () => {
    await t.client`DELETE FROM inbox_item WHERE category = 'over-emission-escalated'`
  })
  async function escalatedFlag(): Promise<string> {
    await bill('50.00'); await otelSession('sess-x', '450.00'); await otelSession('sess-y', '50.00')
    await detectOverEmission(t.db, WINDOW)
    const [flag] = await t.client<{ id: string }[]>`SELECT id::text AS id FROM over_emission WHERE teammate_id = ${teammateId}::uuid`
    await resolveHandler(ev({ id: flag!.id, body: { action: 'escalate' } }) as never)
    return flag!.id
  }
  const items = (flagId: string) => t.client<{ recipient: string; severity: string; body: Record<string, unknown>; kind: string }[]>`
    SELECT recipient_teammate_id::text AS recipient, severity, body, related_entity_kind AS kind
    FROM inbox_item WHERE category = 'over-emission-escalated' AND related_entity_id = ${flagId}::uuid`

  it('a developer escalation raises one item per region and platform admin, with the facts', async () => {
    const flagId = await escalatedFlag()
    expect(await items(flagId)).toHaveLength(0) // the route itself raises nothing (developer RLS)
    await getWorker('usage-reconciliation')!.run(t.db)

    const rows = await items(flagId)
    expect(rows.map((r) => r.recipient).sort()).toEqual([regionAdmin, platformAdmin].sort())
    expect(rows.map((r) => r.recipient)).not.toContain(otherRegionAdmin)
    expect(rows[0]!.kind).toBe('over-emission')
    expect(rows[0]!.severity).toBe('attention')
    expect(rows[0]!.body).toMatchObject({
      overEmissionId: flagId, teammateId, day: DAY, tool: 'claude-code',
      resolvedOverUsd: 450, currentOverUsd: 450, escalatedBy: 'teammate',
    })
    // A framed link: the teammate report refuses to load without ?src= (D33).
    const href = new URL(String(rows[0]!.body.actionHref), 'http://x')
    expect(href.pathname).toBe(`/reporting/teammate/${teammateId}`)
    expect(Object.fromEntries(href.searchParams)).toEqual({ src: `region:${regionId}`, from: DAY, to: DAY })
  })

  it('keeps the excess the flag was escalated on beside the current one', async () => {
    const flagId = await escalatedFlag()
    // A provider correction, then a detection run outside this worker (the
    // backfill runs one too) before the notice: the stored figures change.
    await t.client`UPDATE actual_spend SET cost_usd = 500 WHERE teammate_id = ${teammateId}::uuid`
    await detectOverEmission(t.db, WINDOW)
    await getWorker('usage-reconciliation')!.run(t.db)
    const body = (await items(flagId))[0]!.body
    expect(body).toMatchObject({ resolvedOverUsd: 450, currentOverUsd: 0 })
    expect(typeof body.computedAt).toBe('string')
    // Not sent: detection can leave them stale beside a zeroed excess.
    expect(body).not.toHaveProperty('otelUsd')
    expect(body).not.toHaveProperty('apiUsd')
  })

  // Current-org lens (§3.2): a notice reaches the admins of the region the teammate sits in
  // NOW; the flag's own region_id is the stamp at detection and is not read.
  it('routes to the teammate\'s current region, not the region stamped on the flag', async () => {
    const flagId = await escalatedFlag()
    const [other] = await t.client<{ region: string; unit: string }[]>`
      SELECT region_id::text AS region, id::text AS unit FROM org_unit WHERE code = 'oe-other-bu'`
    await t.client`UPDATE over_emission SET region_id = ${other!.region}::uuid WHERE id = ${flagId}::uuid`
    await getWorker('usage-reconciliation')!.run(t.db)
    const rows = await items(flagId)
    expect(rows.map((r) => r.recipient).sort()).toEqual([regionAdmin, platformAdmin].sort())
    expect(new URL(String(rows[0]!.body.actionHref), 'http://x').searchParams.get('src')).toBe(`region:${regionId}`)
  })

  it('follows a teammate who has moved region since the flag was raised', async () => {
    const flagId = await escalatedFlag()
    const [other] = await t.client<{ region: string; unit: string }[]>`
      SELECT region_id::text AS region, id::text AS unit FROM org_unit WHERE code = 'oe-other-bu'`
    await t.client`UPDATE teammate SET region_id = ${other!.region}::uuid, org_unit_id = ${other!.unit}::uuid WHERE id = ${teammateId}::uuid`
    try {
      await getWorker('usage-reconciliation')!.run(t.db)
    } finally {
      await t.client`UPDATE teammate SET region_id = ${regionId}::uuid, org_unit_id = ${orgUnitId}::uuid WHERE id = ${teammateId}::uuid`
    }
    const rows = await items(flagId)
    expect(rows.map((r) => r.recipient).sort()).toEqual([otherRegionAdmin, platformAdmin].sort())
    expect(new URL(String(rows[0]!.body.actionHref), 'http://x').searchParams.get('src')).toBe(`region:${other!.region}`)
  })

  it('notifies once per escalation, and again after the flag is re-opened and escalated again', async () => {
    const flagId = await escalatedFlag()
    await getWorker('usage-reconciliation')!.run(t.db)
    await getWorker('usage-reconciliation')!.run(t.db)
    expect(await items(flagId)).toHaveLength(2) // two recipients, one escalation

    // Re-opened by the detector, then escalated again: a new notice.
    await t.client`UPDATE over_emission SET state = 'open' WHERE id = ${flagId}::uuid`
    await resolveHandler(ev({ id: flagId, body: { action: 'escalate' } }) as never)
    await getWorker('usage-reconciliation')!.run(t.db)
    expect(await items(flagId)).toHaveLength(4)
  })

  it('the notice is remembered on the flag, not looked up in inbox history', async () => {
    const flagId = await escalatedFlag()
    await getWorker('usage-reconciliation')!.run(t.db)
    const [row] = await t.client<{ notified: boolean }[]>`
      SELECT escalation_notified_at >= resolved_at AS notified FROM over_emission WHERE id = ${flagId}::uuid`
    expect(row!.notified).toBe(true)
    // Items deleted (or archived) later do not make the worker notify again.
    await t.client`DELETE FROM inbox_item WHERE category = 'over-emission-escalated'`
    await getWorker('usage-reconciliation')!.run(t.db)
    expect(await items(flagId)).toHaveLength(0)
    // The partial index serves exactly the worker's predicate.
    const [idx] = await t.client<{ def: string }[]>`
      SELECT indexdef AS def FROM pg_indexes WHERE indexname = 'over_emission_escalation_unnotified'`
    expect(idx!.def).toContain("WHERE ((state = 'escalated'::text) AND ((escalation_notified_at IS NULL) OR (escalation_notified_at < resolved_at)))")
  })

  /** A route event as `who` (an admin of this region). */
  function adminEv(who: string, opts: { method: 'GET' | 'POST'; url: string; params?: Record<string, string>; body?: unknown }) {
    const headers: Record<string, string> = { host: 'localhost:3450', origin: 'http://localhost:3450', 'content-type': 'application/json' }
    const e = {
      method: opts.method, path: opts.url, context: { params: opts.params ?? {} },
      node: {
        req: { method: opts.method, url: opts.url, body: opts.body, socket: { remoteAddress: '127.0.0.1' }, get headers() { return headers } },
        res: {
          _headers: {} as Record<string, string | string[]>, statusCode: 200,
          getHeader(n: string) { return this._headers[n.toLowerCase()] }, setHeader(n: string, v: string | string[]) { this._headers[n.toLowerCase()] = v },
          removeHeader(n: string) { this._headers[n.toLowerCase()] = '' }, appendHeader(n: string, v: string | string[]) { this._headers[n.toLowerCase()] = v },
          get headersSent() { return false },
        },
      },
    }
    injectTestSession(e as unknown as Parameters<typeof injectTestSession>[0], {
      teammateId: who, email: `${who}@x.test`, displayName: 'Admin', role: who === platformAdmin ? 'platform-admin' : 'admin', regionId, orgPath: 'oe',
    } as Session)
    return e
  }
  const listAs = async (who: string) =>
    ((await inboxListHandler(adminEv(who, { method: 'GET', url: '/api/v1/me/inbox?category=over-emission-escalated' }) as never)) as {
      items: { id: string; category: string }[]
    }).items

  it('the inbox list route serves the Over-emission filter the inbox page sends (was a 400)', async () => {
    await escalatedFlag()
    await getWorker('usage-reconciliation')!.run(t.db)
    const items = await listAs(regionAdmin)
    expect(items.length).toBe(1)
    expect(items.every((i) => i.category === 'over-emission-escalated')).toBe(true)
  })

  it('a sweep escalation is marked as the system\'s, not the developer\'s', async () => {
    await bill('50.00'); await otelSession('sess-reuse', '450.00'); await otelSession('sess-honest', '50.00')
    await detectOverEmission(t.db, WINDOW)
    const [flag] = await t.client<{ id: string }[]>`SELECT id::text AS id FROM over_emission WHERE teammate_id = ${teammateId}::uuid`
    await resolveHandler(ev({ id: flag!.id, body: { action: 'quarantine', conversation_id: 'sess-reuse' } }) as never)
    await otelRecordAt('sess-reuse', '120.00', '2026-06-22T09:00:00.000Z')
    await getWorker('usage-reconciliation')!.run(t.db)
    const rows = await items(flag!.id)
    expect(rows).toHaveLength(2)
    expect(rows[0]!.body.escalatedBy).toBe('system')
  })

  it('flags with no recipient do not hold the queue for flags that have one', async () => {
    const flagId = await escalatedFlag()
    // Older escalations nobody can receive: for a teammate who sits in a region
    // with no admin, and with the only platform admin inactive.
    const [lonely] = await t.db.insert(schema.region).values({ code: 'oe-lonely', displayName: 'Lonely' }).returning()
    const [lonelyOu] = await t.db.insert(schema.orgUnit).values({ regionId: lonely!.id, path: 'oe_lonely', code: 'oe-lonely-bu', displayName: 'Lonely', unitType: 'bu', isCostOwningUnit: true }).returning()
    const [lonelyDev] = await t.db.insert(schema.teammate).values({ entraOid: 'oid-oe-lonely', email: 'lonely@x.test', regionId: lonely!.id, orgUnitId: lonelyOu!.id }).returning()
    const stale = await t.client<{ id: string }[]>`
      INSERT INTO over_emission (teammate_id, region_id, day, tool, otel_usd, api_usd, over_usd, state, resolved_at)
      SELECT ${lonelyDev!.id}::uuid, ${lonely!.id}::uuid, ('2026-01-01'::date + g), 'claude-code', 10, 0, 10, 'escalated', now() - interval '30 days'
      FROM generate_series(1, 3) g
      RETURNING id::text AS id`
    await t.client`UPDATE teammate SET is_active = false WHERE id = ${platformAdmin}::uuid`
    try {
      const out = await notifyEscalatedOverEmission(t.db as never, { limit: 1, scanLimit: 10 })
      expect(out.notified).toBe(1)
      expect((await items(flagId)).map((r) => r.recipient)).toEqual([regionAdmin])
    } finally {
      await t.client`UPDATE teammate SET is_active = true WHERE id = ${platformAdmin}::uuid`
      await t.client`DELETE FROM over_emission WHERE id IN ${t.client(stale.map((s) => s.id))}`
    }
  })

  it('accepting or quarantining raises nothing', async () => {
    await bill('50.00'); await otelSession('sess-x', '450.00'); await otelSession('sess-y', '50.00')
    await detectOverEmission(t.db, WINDOW)
    const [flag] = await t.client<{ id: string }[]>`SELECT id::text AS id FROM over_emission WHERE teammate_id = ${teammateId}::uuid`
    await resolveHandler(ev({ id: flag!.id, body: { action: 'accept' } }) as never)
    await getWorker('usage-reconciliation')!.run(t.db)
    expect(await items(flag!.id)).toHaveLength(0)
  })
})
