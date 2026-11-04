// @vitest-environment node
/*
 * §F4 — Activity: ONE list holding OTel sessions AND provider-recorded days.
 * T17-T20 plus the grain rule. Design:
 * docs/design/developer-pages-consolidation/04-fix-sprint-design.md §F4.
 *
 * THE BUG THIS PINS. A Copilot day that arrived from the provider API vanished
 * the moment it was tagged: `/me/sessions/recent` read `attribution_record`
 * (OTel only, by design) so it was never eligible, and the only list that ever
 * showed it — the needs-tagging worklist — filters `project_id IS NULL`.
 * Tagging was removal. The first assertion below is exactly that: a TAGGED
 * provider-recorded day is on this list.
 *
 * ── THE FIXTURE, AND WHY IT IS SHAPED THIS WAY ──────────────────────────────
 * 12 sessions and 4 provider-recorded days, on INTERLEAVED days, with the
 * sessions deliberately outnumbering the days 3:1. The skew is the point: a
 * union that bounded only the whole result (rather than each branch) would let
 * the sessions crowd the days out of the first pages, and every day-row
 * assertion here would still pass on page 1 by accident if the two kinds sat on
 * separate days. They do not.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'
import * as schema from '../../../drizzle/schema'
import { injectTestSession } from '../../helpers/auth'
import type { Session } from '../../../server/utils/auth'
import listHandler from '../../../server/api/v1/me/activity.get'
import exportHandler from '../../../server/api/v1/me/activity/export.get'
import type { ActivityListResponse, ActivityRow } from '../../../shared/schemas/activity'

let t: TestDb
let devId = ''
let regionId = ''
let ouId = ''
let projId = ''

/*
 * ── THE SECOND TEAMMATE ─────────────────────────────────────────────────────
 * Everything below about token PROVENANCE and about the project tuple is seeded
 * on their own teammate, so the counts the fixture above pins (SESSIONS,
 * PROVIDER_DAYS, the CSV line count) keep meaning what they say. RLS makes the
 * separation real rather than conventional: neither reader can see the other.
 */
let dev2Id = ''
/** Two projects whose UUID order and CODE order DISAGREE — see the tuple test. */
const ZED_ID = '00000000-0000-4000-8000-0000000000aa'
const ALPHA_ID = 'ffffffff-0000-4000-8000-0000000000bb'

/*
 * ── THE THIRD TEAMMATE ──────────────────────────────────────────────────────
 * The two-phase sessions branch (request-floor-performance.md F6) and the
 * legacy key arm, isolated on their own teammate so the pinned counts above
 * keep meaning what they say. Their instance id doubles as the conversation
 * key of the legacy (claude_session_id NULL) conversation.
 */
let dev3Id = ''
let inst3 = ''

/** Day 0 is a fixed past UTC day, so no assertion here depends on the run clock. */
const DAY0 = Date.UTC(2026, 4, 4) // 2026-05-04
const dayIso = (n: number) => new Date(DAY0 + n * 86_400_000).toISOString().slice(0, 10)

const SESSIONS = 12
const PROVIDER_DAYS = 4
/** Which provider days are tagged: the record the old surfaces lost. */
const TAGGED_DAY_INDEX = 1
const DISMISSED_DAY_INDEX = 2

beforeAll(async () => {
  t = await startTestDb()
  process.env.DATABASE_URL = t.url

  const [r] = await t.db.insert(schema.region).values({ code: 'act-r', displayName: 'Act R' }).returning()
  regionId = r!.id
  const [o] = await t.db
    .insert(schema.orgUnit)
    .values({ regionId, path: 'act.svc', code: 'act-svc', displayName: 'Svc', unitType: 'bu' })
    .returning()
  ouId = o!.id
  const [dev] = await t.db
    .insert(schema.teammate)
    .values({ entraOid: 'oid-act-dev', email: 'act-dev@x.test', role: 'developer', regionId, orgUnitId: ouId })
    .returning()
  devId = dev!.id
  const [p] = await t.db
    .insert(schema.project)
    .values({
      code: 'ACT-P',
      codeHash: 'h-act-p',
      displayName: 'Activity Project',
      type: 'billable',
      regionId,
      costOwningUnitId: ouId,
    })
    .returning()
  projId = p!.id

  const [rc] = await t.db
    .select({ id: schema.rateCard.id, version: schema.rateCard.version })
    .from(schema.rateCard)
    .limit(1)

  // 12 sessions, one per day, days 0..11. Every other one is on the project so
  // the tagged/untagged filter has both populations to choose between.
  const instanceId = crypto.randomUUID()
  await t.client.unsafe(`
    INSERT INTO instance_attestation (instance_id, principal_oid, principal_email, teammate_id, tool, session_token_hash, ts_start, region_id, org_unit_id, attestation_state)
    VALUES ('${instanceId}','oid-act-dev','act-dev@x.test','${devId}','claude-code','tok-${instanceId}', now(), '${regionId}','${ouId}','unassigned')`)
  for (let i = 0; i < SESSIONS; i++) {
    await t.db.insert(schema.attributionRecord).values({
      instanceId,
      claudeSessionId: `conv-${String(i).padStart(2, '0')}`,
      teammateId: devId,
      projectId: i % 2 === 0 ? projId : null,
      regionId,
      orgUnitId: ouId,
      costOwningUnitId: i % 2 === 0 ? ouId : null,
      tool: 'claude-code',
      model: 'claude-sonnet-4-6',
      tokenType: 'input',
      tokens: BigInt(100 * (i + 1)),
      costUsd: (0.5 * (i + 1)).toFixed(6),
      rateCardId: rc!.id,
      rateCardVersion: rc!.version,
      fidelityTier: 'tier-1',
      costBasis: 'estimated',
      // 10:00Z, so the UTC day of the event is unambiguous.
      tsEvent: new Date(DAY0 + i * 86_400_000 + 10 * 3_600_000),
    })
  }

  // 4 provider-recorded days on days 0, 3, 6, 9 — INTERLEAVED with the sessions.
  for (let i = 0; i < PROVIDER_DAYS; i++) {
    await t.db.insert(schema.unaccountedUsage).values({
      teammateId: devId,
      regionId,
      orgUnitId: ouId,
      day: dayIso(i * 3),
      tool: 'copilot-cli',
      costUsd: (7 + i).toFixed(6),
      tokens: BigInt(1000 * (i + 1)),
      // THE RECORD THE OLD SURFACES LOST: decided, therefore off the worklist.
      projectId: i === TAGGED_DAY_INDEX ? projId : null,
      taggedAt: i === TAGGED_DAY_INDEX ? new Date() : null,
      dismissedAt: i === DISMISSED_DAY_INDEX ? new Date() : null,
    })
    /*
     * THE PROVIDER ROW THE RESIDUAL WAS COMPUTED FROM. A Copilot day cannot
     * exist without one — the reconciler only ever mints an unaccounted_usage
     * row for a (teammate, day, tool) `v_teammate_usage_daily` backs — and this
     * fixture used to omit it, which is what MASKED the token defect: with no
     * backing row the read cannot tell "never measured" from "measured zero",
     * and every assertion passed on a fabricated number.
     *
     * The GitHub arm of that view is `NULL::bigint AS tokens` (mig 0101):
     * ai_credit/usage meters ai-credits and reports NO token quantity, ever.
     */
    await t.db.insert(schema.reconciliationRecord).values({
      teammateId: devId,
      provider: 'github',
      enterpriseRef: 'ent-act',
      periodDate: dayIso(i * 3),
      category: 'copilot_interactive',
      scope: 'teammate',
      regionId,
      orgUnitId: ouId,
      actualQty: '12.000000',
      actualUnitType: 'ai-credits',
      actualUsd: (7 + i).toFixed(6),
      otelAttributedUsd: '0.000000',
      deltaUsd: (7 + i).toFixed(6),
      spendClass: 'billed',
      disposition: 'untagged',
      status: 'applied',
    })
  }

  // ── The second teammate: token provenance + the project tuple ─────────────
  const [dev2] = await t.db
    .insert(schema.teammate)
    .values({ entraOid: 'oid-act-dev2', email: 'act-dev2@x.test', role: 'developer', regionId, orgUnitId: ouId })
    .returning()
  dev2Id = dev2!.id

  for (const [id, code, name] of [
    [ZED_ID, 'ACT-ZED', 'Zed'],
    [ALPHA_ID, 'ACT-ALPHA', 'Alpha'],
  ] as const) {
    await t.db.insert(schema.project).values({
      id,
      code,
      codeHash: `h-${code}`,
      displayName: name,
      type: 'billable',
      regionId,
      costOwningUnitId: ouId,
    })
  }

  // ONE conversation, TWO projects. `MAX(project_id)` ranks by uuid text and
  // would pick ALPHA; `MAX(code)` ranks by code and would pick ZED.
  const inst2 = crypto.randomUUID()
  await t.client.unsafe(`
    INSERT INTO instance_attestation (instance_id, principal_oid, principal_email, teammate_id, tool, session_token_hash, ts_start, region_id, org_unit_id, attestation_state)
    VALUES ('${inst2}','oid-act-dev2','act-dev2@x.test','${dev2Id}','claude-code','tok-${inst2}', now(), '${regionId}','${ouId}','unassigned')`)
  for (const [i, pid] of [ZED_ID, ALPHA_ID].entries()) {
    await t.db.insert(schema.attributionRecord).values({
      instanceId: inst2,
      claudeSessionId: 'conv-two-projects',
      teammateId: dev2Id,
      projectId: pid,
      regionId,
      orgUnitId: ouId,
      costOwningUnitId: ouId,
      tool: 'claude-code',
      model: 'claude-sonnet-4-6',
      tokenType: 'input',
      tokens: 500n,
      costUsd: '1.000000',
      rateCardId: rc!.id,
      rateCardVersion: rc!.version,
      fidelityTier: 'tier-1',
      costBasis: 'estimated',
      tsEvent: new Date(DAY0 + 20 * 86_400_000 + (10 + i) * 3_600_000),
    })
  }

  /*
   * Four provider days for dev2, each pinning ONE state of the two axes the
   * list reads independently — money and tokens:
   *
   *   day 30  copilot-cli  cost > 0, tokens stored 4242 — NEVER REPORTED (null)
   *   day 31  claude-code  cost > 0, tokens 250         — reported (a number)
   *   day 32  claude-code  cost = 0, tokens 777         — the zero-COST day the
   *                                                       old `cost_usd > 0`
   *                                                       predicate dropped
   *   day 33  claude-code  cost = 0, tokens 0           — the artefact: stays out
   */
  await t.db.insert(schema.reconciliationRecord).values({
    teammateId: dev2Id,
    provider: 'github',
    enterpriseRef: 'ent-act',
    periodDate: dayIso(30),
    category: 'copilot_interactive',
    scope: 'teammate',
    regionId,
    orgUnitId: ouId,
    actualQty: '9.000000',
    actualUnitType: 'ai-credits',
    actualUsd: '4.000000',
    otelAttributedUsd: '0.000000',
    deltaUsd: '4.000000',
    spendClass: 'billed',
    disposition: 'untagged',
    status: 'applied',
  })
  for (const n of [31, 32, 33]) {
    await t.db.insert(schema.actualSpend).values({
      teammateId: dev2Id,
      date: dayIso(n),
      tool: 'claude-code',
      inputTokens: 900n,
      outputTokens: 100n,
      costUsd: '2.000000',
      source: 'anthropic-analytics-api',
    })
  }
  const dev2Days: Array<[number, string, string, bigint]> = [
    [30, 'copilot-cli', '4.000000', 4242n],
    [31, 'claude-code', '1.500000', 250n],
    [32, 'claude-code', '0.000000', 777n],
    [33, 'claude-code', '0.000000', 0n],
  ]
  for (const [n, tool, cost, tokens] of dev2Days) {
    await t.db.insert(schema.unaccountedUsage).values({
      teammateId: dev2Id,
      regionId,
      orgUnitId: ouId,
      day: dayIso(n),
      tool,
      costUsd: cost,
      tokens,
    })
  }

  // ── The third teammate: two-phase rank semantics + the legacy key arm ─────
  const [dev3] = await t.db
    .insert(schema.teammate)
    .values({ entraOid: 'oid-act-dev3', email: 'act-dev3@x.test', role: 'developer', regionId, orgUnitId: ouId })
    .returning()
  dev3Id = dev3!.id
  inst3 = crypto.randomUUID()
  await t.client.unsafe(`
    INSERT INTO instance_attestation (instance_id, principal_oid, principal_email, teammate_id, tool, session_token_hash, ts_start, region_id, org_unit_id, attestation_state)
    VALUES ('${inst3}','oid-act-dev3','act-dev3@x.test','${dev3Id}','claude-code','tok-${inst3}', now(), '${regionId}','${ouId}','unassigned')`)
  const ar3 = (conv: string | null, dayN: number, hour: number, tokens: bigint, cost: string) =>
    t.db.insert(schema.attributionRecord).values({
      instanceId: inst3,
      claudeSessionId: conv,
      teammateId: dev3Id,
      projectId: null,
      regionId,
      orgUnitId: ouId,
      costOwningUnitId: null,
      tool: 'claude-code',
      model: 'claude-sonnet-4-6',
      tokenType: 'input',
      tokens,
      costUsd: cost,
      rateCardId: rc!.id,
      rateCardVersion: rc!.version,
      fidelityTier: 'tier-1',
      costBasis: 'estimated',
      tsEvent: new Date(DAY0 + dayN * 86_400_000 + hour * 3_600_000),
    })
  /*
   * The window is [day 40 .. day 42]. The bounds compare against the
   * conversation's UNFILTERED last event (they live in HAVING, on MAX), so:
   *   conv-win-in   days 38 + 42 — last event INSIDE the window; its day-38
   *                 row is outside it and must STILL be summed. A phase that
   *                 truncated history to the window would show 200/2.00.
   *   conv-win-out  days 41 + 44 — a row inside the window, last event after
   *                 it: excluded. A truncating phase would rank it day 41 and
   *                 let it back IN.
   *   conv-win-only day 42, one hour after conv-win-in's last event — ranks
   *                 first on the ts leg of the same day.
   */
  await ar3('conv-win-in', 38, 10, 100n, '1.000000')
  await ar3('conv-win-in', 42, 9, 200n, '2.000000')
  await ar3('conv-win-out', 41, 10, 300n, '3.000000')
  await ar3('conv-win-out', 44, 8, 400n, '4.000000')
  await ar3('conv-win-only', 42, 10, 500n, '5.000000')
  // The legacy pre-0016 conversation: claude_session_id NULL on every row, so
  // its conversation key is the INSTANCE id (conversation-key.ts).
  await ar3(null, 50, 10, 600n, '6.000000')
  await ar3(null, 50, 11, 50n, '0.500000')
}, 180_000)

afterAll(async () => {
  await stopTestDb(t)
}, 30_000)

const devSession = (): Session =>
  ({
    teammateId: devId,
    email: 'act-dev@x.test',
    displayName: 'Dev',
    role: 'developer',
    regionId,
    orgPath: 'act.svc',
  }) as unknown as Session

/** The second teammate — their own RLS scope, their own fixtures. */
const dev2Session = (): Session =>
  ({
    teammateId: dev2Id,
    email: 'act-dev2@x.test',
    displayName: 'Dev2',
    role: 'developer',
    regionId,
    orgPath: 'act.svc',
  }) as unknown as Session

function ev(query = '', session: Session = devSession()) {
  const url = '/x' + (query ? `?${query}` : '')
  const headers: Record<string, string> = { host: 'localhost:3450' }
  const e = {
    method: 'GET',
    path: url,
    context: { params: {} },
    node: {
      req: { method: 'GET', url, socket: { remoteAddress: '127.0.0.1' }, get headers() { return { ...headers } } },
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
  injectTestSession(e as unknown as Parameters<typeof injectTestSession>[0], session)
  return e as unknown as Parameters<typeof listHandler>[0]
}

const list = (query = '') => listHandler(ev(query)) as Promise<ActivityListResponse>
const csv = (query = '') => exportHandler(ev(query) as Parameters<typeof exportHandler>[0]) as Promise<string>
const list2 = (query = '') =>
  listHandler(ev(query, dev2Session())) as Promise<ActivityListResponse>
const csv2 = (query = '') =>
  exportHandler(ev(query, dev2Session()) as Parameters<typeof exportHandler>[0]) as Promise<string>

/** The third teammate — the two-phase / legacy-key fixtures. */
const dev3Session = (): Session =>
  ({
    teammateId: dev3Id,
    email: 'act-dev3@x.test',
    displayName: 'Dev3',
    role: 'developer',
    regionId,
    orgPath: 'act.svc',
  }) as unknown as Session
const list3 = (query = '') =>
  listHandler(ev(query, dev3Session())) as Promise<ActivityListResponse>

/** Walk every page at `limit`, returning the rows in the order they arrived. */
async function walkAll(limit: number, query = ''): Promise<ActivityRow[]> {
  const out: ActivityRow[] = []
  let cursor: string | null = null
  for (let guard = 0; guard < 50; guard++) {
    const q = [query, `limit=${limit}`, cursor ? `cursor=${encodeURIComponent(cursor)}` : '']
      .filter(Boolean)
      .join('&')
    const page: ActivityListResponse = await list(q)
    out.push(...page.rows)
    if (!page.has_more) return out
    expect(page.next_cursor).toBeTruthy()
    cursor = page.next_cursor
  }
  throw new Error('pagination did not terminate')
}

describe('T17 — the route serves BOTH row kinds, and the old routes are gone', () => {
  it('lists sessions and provider-recorded days in one list', async () => {
    const all = await walkAll(100)
    expect(all.filter((r) => r.kind === 'session')).toHaveLength(SESSIONS)
    expect(all.filter((r) => r.kind === 'provider-day')).toHaveLength(PROVIDER_DAYS)
  })

  it('a TAGGED provider-recorded day is on the list — the bug, pinned', async () => {
    const all = await walkAll(100)
    const tagged = all.filter((r) => r.kind === 'provider-day' && r.attributed)
    expect(tagged).toHaveLength(1)
    expect(tagged[0]!.project_code).toBe('ACT-P')
    expect(tagged[0]!.day).toBe(dayIso(TAGGED_DAY_INDEX * 3))
    // And it is NOT on the worklist's population — that list filters
    // project_id IS NULL, which is exactly why it needed a home here.
    const untaggedOnly = await walkAll(100, 'tagged=untagged')
    expect(untaggedOnly.some((r) => r.id === tagged[0]!.id)).toBe(false)
  })

  it('a DISMISSED provider-recorded day is still a record of what happened', async () => {
    const all = await walkAll(100)
    const dismissed = all.filter((r) => r.kind === 'provider-day' && r.dismissed)
    expect(dismissed).toHaveLength(1)
    expect(dismissed[0]!.day).toBe(dayIso(DISMISSED_DAY_INDEX * 3))
  })

  it('the superseded routes are RETIRED — no auth-reachable landmine survives', () => {
    const root = process.cwd()
    expect(existsSync(join(root, 'server/api/v1/me/sessions/recent.get.ts'))).toBe(false)
    expect(existsSync(join(root, 'server/api/v1/me/sessions/recent/export.get.ts'))).toBe(false)
    // The worklist STAYS — it is the task list, not the record.
    expect(existsSync(join(root, 'server/api/v1/me/sessions/untagged.get.ts'))).toBe(true)
  })

  it('rejects a cursor it did not mint, rather than silently restarting', async () => {
    await expect(list('cursor=not-a-cursor')).rejects.toMatchObject({ statusCode: 400 })
  })

  it('rejects a well-formed cursor carrying an impossible day as a 400, not a 500 from ::date', async () => {
    const forged = Buffer.from(JSON.stringify(['2026-02-31', 0, 'x', 'y']), 'utf8').toString('base64url')
    await expect(list(`cursor=${forged}`)).rejects.toMatchObject({ statusCode: 400 })
  })

  // A shape-only regex let `2026-02-31` through to the `::date` cast in the
  // branch predicates, where Postgres aborts the query — the caller got a 500
  // for their own typo. The bound is validated at the boundary now, so it is a
  // 400 on BOTH surfaces.
  it('rejects an impossible calendar day as a 400, never a 500 from ::date', async () => {
    await expect(list('from=2026-02-31')).rejects.toMatchObject({ statusCode: 400 })
    await expect(list('to=2026-04-31')).rejects.toMatchObject({ statusCode: 400 })
    await expect(csv('from=2026-02-31')).rejects.toMatchObject({ statusCode: 400 })
    // A real day on the same shape still works.
    await expect(list('from=2024-02-29')).resolves.toBeTruthy()
  })

  /*
   * YEAR ZERO — the day the round-trip check still let through (external review
   * r2). `0000-01-01` is a valid ISO-8601 instant in JavaScript, so it survived
   * `Date.parse` → `toISOString` unchanged; Postgres has no year 0 and
   * `'0000-01-01'::date` aborts the query. The 500 the previous fix claimed to
   * close was still reachable, one value over.
   *
   * RED ON REVERT: drop `MIN_YEAR` from `isRealUtcDay` and these stop being 400s
   * — they become the 500 this test's own title forbids.
   */
  it('rejects year zero as a 400 too — Postgres has no year 0', async () => {
    await expect(list('from=0000-01-01')).rejects.toMatchObject({ statusCode: 400 })
    await expect(list('to=0000-12-31')).rejects.toMatchObject({ statusCode: 400 })
    await expect(csv('from=0000-01-01')).rejects.toMatchObject({ statusCode: 400 })
    // The first day Postgres CAN cast is still accepted — the guard is the
    // database's range, not a business rule about plausible days.
    await expect(list('from=0001-01-01')).resolves.toBeTruthy()
  })
})

describe('T18 — one sort key, keyset-paged, BOTH sides bounded', () => {
  it('every page size yields the SAME sequence as one big read', async () => {
    const whole = await walkAll(100)
    for (const size of [1, 3, 7]) {
      const paged = await walkAll(size)
      expect(paged.map((r) => `${r.kind}|${r.id}`)).toEqual(whole.map((r) => `${r.kind}|${r.id}`))
    }
  })

  it('the one sort key is the UTC DAY, descending, across both kinds', async () => {
    const all = await walkAll(3)
    const days = all.map((r) => r.day)
    expect([...days].sort().reverse()).toEqual(days)
    // The two kinds are genuinely interleaved — not two blocks that happen to
    // be individually ordered.
    const kinds = all.map((r) => r.kind).join(',')
    expect(kinds).toMatch(/provider-day,session/)
    expect(kinds).toMatch(/session,provider-day/)
  })

  it('the sessions cannot starve the provider-days out: each branch is bounded on its own', async () => {
    // The first page of 3 sits on the newest days, which are session-only; by
    // the time the walk reaches day 9 the provider day must appear in ITS day's
    // place, not after all twelve sessions.
    const firstSix = (await walkAll(3)).slice(0, 6)
    expect(firstSix.some((r) => r.kind === 'provider-day')).toBe(true)
  })

  it('a page is never larger than its limit and stops asking when it is done', async () => {
    const page = await list('limit=5')
    expect(page.rows).toHaveLength(5)
    expect(page.has_more).toBe(true)
    const tail = await list('limit=100')
    expect(tail.has_more).toBe(false)
    expect(tail.next_cursor).toBeNull()
  })
})

describe('T19 — the list claims NON-DUPLICATION, and no total', () => {
  it('no record appears twice, across the union and across pages', async () => {
    const all = await walkAll(1)
    const keys = all.map((r) => `${r.kind}|${r.id}`)
    expect(new Set(keys).size).toBe(keys.length)
    expect(keys).toHaveLength(SESSIONS + PROVIDER_DAYS)
  })

  // The key list is EXACT, so a field cannot creep back onto the wire without
  // this going red: not `total` (D19), and not the `filters` echo, which was
  // removed because nothing ever read it and it could not prove what its own
  // comment claimed — the CSV is a separate request.
  it('asserts no total and no filters echo — the response is rows and paging only', async () => {
    const page = (await list('limit=5')) as unknown as Record<string, unknown>
    expect(Object.keys(page).sort()).toEqual(['has_more', 'next_cursor', 'rows'])
    expect(page.total).toBeUndefined()
    expect(page.filters).toBeUndefined()
  })
})

describe('the GRAIN rule — a provider-recorded day carries no instant', () => {
  it('session rows carry ts_last; provider-day rows carry NO timestamp field at all', async () => {
    const all = await walkAll(100)
    for (const r of all) {
      if (r.kind === 'session') {
        expect(r.ts_last).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
        // The instant and the sort day agree — the row shows what it sorts on.
        expect(r.ts_last.slice(0, 10)).toBe(r.day)
      } else {
        // Not "null", not "00:00" — ABSENT. A synthesised midnight would be the
        // NULL-as-0 defect in a new costume.
        expect('ts_last' in r).toBe(false)
        expect(r.day).toMatch(/^\d{4}-\d{2}-\d{2}$/)
      }
    }
  })
})

describe('T20 — filters, and a CSV that respects them', () => {
  it('filters by kind, by budget state and by client', async () => {
    expect((await walkAll(100, 'kind=provider-day')).every((r) => r.kind === 'provider-day')).toBe(true)
    expect((await walkAll(100, 'kind=session')).every((r) => r.kind === 'session')).toBe(true)
    expect((await walkAll(100, 'tool=copilot-cli')).every((r) => r.tool === 'copilot-cli')).toBe(true)
    expect((await walkAll(100, 'tagged=tagged')).every((r) => r.attributed)).toBe(true)
    expect((await walkAll(100, 'tagged=untagged')).every((r) => !r.attributed)).toBe(true)
    // The day bounds are UTC days, inclusive on both ends.
    const windowed = await walkAll(100, `from=${dayIso(3)}&to=${dayIso(5)}`)
    expect(windowed.length).toBeGreaterThan(0)
    expect(windowed.every((r) => r.day >= dayIso(3) && r.day <= dayIso(5))).toBe(true)
  })

  it('the CSV holds exactly the rows the filtered list holds, in the same order', async () => {
    for (const q of ['', 'kind=provider-day', 'tagged=tagged', 'tool=claude-code', 'project=ACT-P', `from=${dayIso(3)}&to=${dayIso(9)}`]) {
      const rows = await walkAll(100, q)
      const body = await csv(q)
      const lines = body.trim().split('\n')
      expect(lines[0]).toBe('kind,id,day,when,tool,project_code,project_display_name,activity,tokens,cost_usd')
      expect(lines.slice(1).map((l) => l.split(',')[1])).toEqual(rows.map((r) => r.id))
    }
  })

  it('the CSV `when` column is EMPTY for a provider-recorded day, never a fabricated time', async () => {
    const lines = (await csv('kind=provider-day')).trim().split('\n').slice(1)
    expect(lines.length).toBe(PROVIDER_DAYS)
    for (const line of lines) {
      const cells = line.split(',')
      expect(cells[0]).toBe('provider-day')
      expect(cells[2]).toMatch(/^\d{4}-\d{2}-\d{2}$/) // day
      expect(cells[3]).toBe('') // when — absent, not 00:00
    }
    const sessionLines = (await csv('kind=session')).trim().split('\n').slice(1)
    expect(sessionLines.every((l) => l.split(',')[3]!.includes('T'))).toBe(true)
  })
})

/** `walkAll`, for the second teammate. */
async function walkAll2(limit: number, query = ''): Promise<ActivityRow[]> {
  const out: ActivityRow[] = []
  let cursor: string | null = null
  for (let guard = 0; guard < 50; guard++) {
    const q = [query, `limit=${limit}`, cursor ? `cursor=${encodeURIComponent(cursor)}` : '']
      .filter(Boolean)
      .join('&')
    const page: ActivityListResponse = await list2(q)
    out.push(...page.rows)
    if (!page.has_more) return out
    cursor = page.next_cursor
  }
  throw new Error('pagination did not terminate')
}

describe('a provider day carries MONEY or TOKENS — a zero-cost day is not nothing', () => {
  it('a day whose dollars reconciled to 0 but whose TOKENS did not is still on the list', async () => {
    // cost_usd and tokens are INDEPENDENT residuals (GREATEST(0, api - otel) of
    // each), so this state is reachable, and `cost_usd > 0` alone dropped it
    // from a list whose claim is that it holds every provider-recorded day.
    const rows = await walkAll2(100, 'kind=provider-day')
    const zeroCost = rows.find((r) => r.day === dayIso(32))
    expect(zeroCost, 'the zero-cost, 777-token day must be on the list').toBeTruthy()
    expect(zeroCost!.cost_usd).toBe('0.00')
    expect(zeroCost!.tokens).toBe(777)
  })

  it('a day that is zero on BOTH axes stays out — that one really is an artefact', async () => {
    const rows = await walkAll2(100, 'kind=provider-day')
    expect(rows.some((r) => r.day === dayIso(33))).toBe(false)
  })
})

describe('token PROVENANCE — "not reported" is not zero', () => {
  it('a Copilot day ships tokens NULL: ai_credit/usage reports no token quantity', async () => {
    const rows = await walkAll2(100, 'kind=provider-day')
    const copilot = rows.find((r) => r.day === dayIso(30))!
    expect(copilot.tool).toBe('copilot-cli')
    // The stored column says 4242 (NOT NULL DEFAULT 0 forced the writer to put a
    // number there). The wire must say "unknown" — and specifically NOT 0, which
    // is the fabrication a reader cannot distinguish from a measurement.
    expect(copilot.tokens).toBeNull()
    expect(copilot.tokens).not.toBe(0)
  })

  it('the FIRST fixture agrees: every Copilot day is unknown, not zero', async () => {
    const rows = (await walkAll(100, 'kind=provider-day')).filter((r) => r.tool === 'copilot-cli')
    expect(rows).toHaveLength(PROVIDER_DAYS)
    expect(rows.map((r) => r.tokens)).toEqual(rows.map(() => null))
  })

  it('a Claude day still ships its measured residual — the fix is not a blanket null', async () => {
    const rows = await walkAll2(100, 'kind=provider-day')
    expect(rows.find((r) => r.day === dayIso(31))!.tokens).toBe(250)
    // And a session, whose tokens OTel counted, is always a number.
    expect((await walkAll2(100, 'kind=session')).every((r) => typeof r.tokens === 'number')).toBe(true)
  })

  it('the CSV leaves the cell EMPTY rather than writing the text "null" or a 0', async () => {
    const body = await csv2('kind=provider-day')
    const lines = body.trim().split('\n').slice(1)
    const cell = (day: string) => lines.find((l) => l.split(',')[2] === day)!.split(',')[8]
    expect(cell(dayIso(30))).toBe('')
    expect(cell(dayIso(31))).toBe('250')
    expect(body).not.toContain('null')
  })
})

describe('the project filter — a "touched it" match, paged like every other', () => {
  it('project=ACT-P returns exactly the sessions and provider days ON that project', async () => {
    const rows = await walkAll(100, 'project=ACT-P')
    // Even-indexed sessions (6) carry the project; of the provider days only
    // the tagged one does.
    expect(rows.filter((r) => r.kind === 'session')).toHaveLength(SESSIONS / 2)
    expect(rows.filter((r) => r.kind === 'provider-day')).toHaveLength(1)
    expect(rows.every((r) => r.project_code === 'ACT-P')).toBe(true)
  })

  it('filter + cursor: paging under project/tagged filters yields the unpaged sequence', async () => {
    for (const q of ['project=ACT-P', 'tagged=untagged', 'tagged=tagged']) {
      const whole = await walkAll(100, q)
      expect(whole.length).toBeGreaterThan(0)
      const paged = await walkAll(2, q)
      expect(paged.map((r) => `${r.kind}|${r.id}`)).toEqual(whole.map((r) => `${r.kind}|${r.id}`))
    }
  })

  it('a two-project conversation matches EITHER code and always displays the same ONE project', async () => {
    for (const code of ['ACT-ALPHA', 'ACT-ZED']) {
      const rows = await walkAll2(100, `project=${code}&kind=session`)
      expect(rows.map((r) => r.id)).toEqual(['conv-two-projects'])
      // The filter means "touched it"; the displayed tuple is the ONE project
      // picked once (greatest code) — so a row matching ACT-ALPHA shows ZED.
      expect(rows[0]!.project_code).toBe('ACT-ZED')
    }
  })
})

describe('ONE project per row — the tuple cannot name two', () => {
  it('project_id, code and display_name all come from the SAME touched project', async () => {
    const rows = await walkAll2(100, 'kind=session')
    const conv = rows.find((r) => r.project_id !== null)!
    // MAX(project_id) ranks by uuid TEXT and would return ALPHA here; MAX(code)
    // ranks by code and returns ZED. Three independent MAXes therefore returned
    // one project's id beside another's code — a row naming a project that does
    // not exist, and a re-tag dialog pre-pointed at the wrong one.
    expect(ALPHA_ID > ZED_ID).toBe(true) // the disagreement, stated
    expect(conv.project_code).toBe('ACT-ZED')
    expect(conv.project_id).toBe(ZED_ID)
    expect(conv.project_display_name).toBe('Zed')
  })

  it('the CSV shows the same one project, not a third combination', async () => {
    const line = (await csv2('kind=session')).trim().split('\n')[1]!.split(',')
    expect(line[5]).toBe('ACT-ZED')
    expect(line[6]).toBe('Zed')
  })
})

/** `walkAll`, for the third teammate. */
async function walkAll3(limit: number, query = ''): Promise<ActivityRow[]> {
  const out: ActivityRow[] = []
  let cursor: string | null = null
  for (let guard = 0; guard < 50; guard++) {
    const q = [query, `limit=${limit}`, cursor ? `cursor=${encodeURIComponent(cursor)}` : '']
      .filter(Boolean)
      .join('&')
    const page: ActivityListResponse = await list3(q)
    out.push(...page.rows)
    if (!page.has_more) return out
    cursor = page.next_cursor
  }
  throw new Error('pagination did not terminate')
}

/*
 * F6 (request-floor-performance.md) — the sessions branch ranks conversation
 * keys in a slim first phase, then rebuilds full rows for only those keys.
 * These pin the two facts a two-phase split can silently break: the window
 * bounds judge the UNFILTERED per-conversation MAX (HAVING semantics), and the
 * row a selected conversation ships sums its FULL history, not the window.
 */
describe('F6 — window bounds rank on the unfiltered conversation MAX', () => {
  const WIN = `from=${dayIso(40)}&to=${dayIso(42)}`

  it('a conversation ending inside the window appears WITH its outside-window history summed', async () => {
    const rows = await walkAll3(100, WIN)
    expect(rows.map((r) => r.id)).toEqual(['conv-win-only', 'conv-win-in'])
    const winIn = rows[1]!
    expect(winIn.day).toBe(dayIso(42))
    // 100 tokens / $1 sit on day 38, OUTSIDE the window — still counted.
    expect(winIn.tokens).toBe(300)
    expect(winIn.cost_usd).toBe('3.00')
  })

  it('a conversation ending AFTER the window stays out, even though it has a row inside it', async () => {
    const rows = await walkAll3(100, WIN)
    expect(rows.some((r) => r.id === 'conv-win-out')).toBe(false)
    // …and without the window it exists, on its true (unfiltered) last day.
    const all = await walkAll3(100, 'kind=session')
    expect(all.find((r) => r.id === 'conv-win-out')!.day).toBe(dayIso(44))
  })

  it('window + cursor: every page size yields the same sequence', async () => {
    const whole = await walkAll3(100, WIN)
    for (const size of [1, 2]) {
      expect((await walkAll3(size, WIN)).map((r) => r.id)).toEqual(whole.map((r) => r.id))
    }
  })
})

describe('F6 — the legacy instance-keyed conversation survives the key filter', () => {
  it('claude_session_id NULL rows group as ONE session keyed by the instance id', async () => {
    const rows = await walkAll3(100, 'kind=session')
    const legacy = rows.find((r) => r.id === inst3)
    expect(legacy, 'the legacy conversation must be on the list').toBeTruthy()
    expect(legacy!.kind).toBe('session')
    expect(legacy!.day).toBe(dayIso(50))
    expect(legacy!.tokens).toBe(650)
    expect(legacy!.cost_usd).toBe('6.50')
    // withBreakdowns rides the SAME key shape through fetchBreakdownCells, so
    // the legacy conversation's model mix must be populated, not empty.
    expect((legacy as unknown as { models: string[] }).models).toEqual(['claude-sonnet-4-6'])
  })
})
