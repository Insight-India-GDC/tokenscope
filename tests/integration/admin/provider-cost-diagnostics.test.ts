// @vitest-environment node
/*
 * Provider-cost diagnostics — the rewritten v_cost_drift (mig 0091) and the
 * costing-rung mix on GET /api/v1/admin/diagnostics.
 *
 * Design: docs/design/provider-cost-precedence.md.
 *
 * WHY THIS FILE EXISTS. The provider-cost change moves the PROVIDER's figure
 * into attribution_record.cost_usd. The old drift view compared cost_usd
 * against metadata.law_cost_usd — which, after the change, is the same number
 * on both sides. Left alone the view would report ~0 drift forever: green
 * precisely when the rate card is most wrong. Every assertion below exists to
 * pin one of the two failure modes that would reintroduce that:
 *
 *   1. the TAUTOLOGY — a provider-priced span must be compared against the
 *      PERSISTED rate-card estimate, never against itself;
 *   2. the SILENT PARTIAL — a provider-priced span with no persisted estimate
 *      must produce NO drift row, not a number computed from whatever rows
 *      happened to carry the key.
 *
 * Both vintages coexist indefinitely (history is frozen, COST-8), so the same
 * window deliberately holds an 'estimated' span and a 'provider-reported' one.
 *
 * Real testcontainers Postgres per AGENTS.md (never mock Drizzle).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'
import * as schema from '../../../drizzle/schema'
import { injectTestSession } from '../../helpers/auth'
import type { Session } from '../../../server/utils/auth'

let t: TestDb
let regionId: string
let ouId: string
let teammateId: string

// rate_card_id has no FK on attribution_record (mig 0055 lists six FKs and this
// is not one of them), so a literal id is enough to express "this row pinned a
// card" — which is the whole signal the view reads.
const RATE_CARD_ID = '9c0f0000-0000-4000-8000-00000000cafe'

// Instances are separated by CLOCK, not just by id: the view-level suite parks
// its spans two months back so the 7-day-windowed endpoint suite below can
// assert exact totals without the two interfering. v_cost_drift has no region
// column, so the window is the only lever available.
const VIEW_INSTANCE = 'cd110091-0000-0000-0000-000000000001'
const EP_INSTANCE = 'cd110091-0000-0000-0000-000000000002'
// RELATIVE, not a literal date: a hard-coded timestamp turns date-flaky the
// moment the calendar moves past it (month-boundary seeds have burned this repo
// before). 60 days back is comfortably outside every 7-day window here.
const OLD_TS = new Date(Date.now() - 60 * 24 * 3600_000)

interface SpanRow {
  tokenType: string
  costUsd: string
  /** metadata.rate_card_cost_usd for this row; undefined = key absent. */
  estimate?: string
}

/**
 * Seed one span (one api_request → up to four token-type rows sharing an
 * identity). lawCostUsd is duplicated onto every row exactly as the KQL
 * mv-expand does, which is why the view MAXes it.
 */
async function seedSpan(opts: {
  instanceId: string
  spanKey: string
  tsEvent: Date
  model: string
  costBasis: string
  /** null = did not pin a rate card ⇒ provider-priced by the view's predicate. */
  rateCardId: string | null
  rows: SpanRow[]
  lawCostUsd?: number
  tool?: string
}): Promise<void> {
  for (const r of opts.rows) {
    const metadata: Record<string, unknown> = {}
    if (opts.lawCostUsd !== undefined) metadata.law_cost_usd = opts.lawCostUsd
    if (r.estimate !== undefined) metadata.rate_card_cost_usd = r.estimate
    await t.db.insert(schema.attributionRecord).values({
      instanceId: opts.instanceId,
      claudeSessionId: `conv-${opts.spanKey}`,
      teammateId,
      regionId,
      orgUnitId: ouId,
      costOwningUnitId: ouId,
      tool: opts.tool ?? 'claude-code',
      model: opts.model,
      tokenType: r.tokenType,
      tokens: 1000n,
      costUsd: r.costUsd,
      rateCardId: opts.rateCardId,
      rateCardVersion: opts.rateCardId ? 1 : null,
      fidelityTier: 'tier-1',
      costBasis: opts.costBasis,
      tsEvent: opts.tsEvent,
      sourceRunId: opts.spanKey,
      metadata: Object.keys(metadata).length > 0 ? metadata : null,
    })
  }
}

interface DriftRow {
  span_key: string
  model: string
  rate_card_cost_usd: string | null
  law_cost_usd: string | null
  drift_usd: string | null
  booked_cost_usd: string | null
  priced_by: string
}

async function drift(instanceId: string): Promise<DriftRow[]> {
  return t.client<DriftRow[]>`
    SELECT span_key, model, rate_card_cost_usd, law_cost_usd, drift_usd,
           booked_cost_usd, priced_by
      FROM v_cost_drift
     WHERE instance_id = ${instanceId}::uuid
     ORDER BY span_key
  `
}

beforeAll(async () => {
  process.env.NUXT_SESSION_SECRET = 'provider-cost-diagnostics-padded-to-32ch'
  t = await startTestDb()
  process.env.DATABASE_URL = t.url
  vi.resetModules()

  const [r] = await t.db.insert(schema.region).values({ code: 'pcd', displayName: 'PCD' }).returning()
  regionId = r!.id
  const [o] = await t.db
    .insert(schema.orgUnit)
    .values({ regionId, path: 'pcd.svc', code: 'pcd-svc', displayName: 'Svc', unitType: 'bu', isCostOwningUnit: true })
    .returning()
  ouId = o!.id
  const [tm] = await t.db
    .insert(schema.teammate)
    .values({ entraOid: 'oid-pcd-dev', email: 'pcd-dev@x.test', role: 'developer', regionId, orgUnitId: ouId })
    .returning()
  teammateId = tm!.id

  for (const instanceId of [VIEW_INSTANCE, EP_INSTANCE]) {
    await t.client.unsafe(`
      INSERT INTO instance_attestation
        (instance_id, principal_oid, principal_email, teammate_id, project_code_hash, raw_project_code,
         tool, session_token_hash, ts_start, region_id, org_unit_id, cost_owning_unit_id)
      VALUES
        ('${instanceId}', 'oid-${instanceId.slice(-4)}', 'pcd-dev@x.test', '${teammateId}', 'h-pcd', 'PCD',
         'claude-code', 'tok-${instanceId.slice(-4)}', NOW() - INTERVAL '30 days',
         '${regionId}', '${ouId}', '${ouId}')
    `)
  }
}, 180_000)

afterAll(async () => {
  await stopTestDb(t)
}, 30_000)

// ── v_cost_drift (mig 0091) ────────────────────────────────────────────────
describe('v_cost_drift — both cost vintages in the same window', () => {
  beforeAll(async () => {
    // (1) PRE-CUTOVER vintage: cost_usd IS our rate-card estimate; the provider
    // figure only exists in metadata. Estimate 0.020000, provider 0.012300.
    await seedSpan({
      instanceId: VIEW_INSTANCE,
      spanKey: 'span-estimated',
      tsEvent: OLD_TS,
      model: 'claude-sonnet-4-6',
      costBasis: 'estimated',
      rateCardId: RATE_CARD_ID,
      lawCostUsd: 0.0123,
      rows: [
        { tokenType: 'input', costUsd: '0.005000' },
        { tokenType: 'output', costUsd: '0.010000' },
        { tokenType: 'cache-read', costUsd: '0.002000' },
        { tokenType: 'cache-write', costUsd: '0.003000' },
      ],
    })

    // (2) POST-CUTOVER vintage: cost_usd holds the PROVIDER's figure, sliced
    // across the token types so it sums back to exactly 0.050000. The rate-card
    // estimate (0.080000) survives only because the joiner persisted it per row.
    // Deliberately far from the provider figure: if the view ever compares the
    // provider against itself, drift collapses to 0 and this test fails.
    await seedSpan({
      instanceId: VIEW_INSTANCE,
      spanKey: 'span-provider',
      tsEvent: OLD_TS,
      model: 'claude-fable-5',
      costBasis: 'provider-reported',
      rateCardId: null,
      lawCostUsd: 0.05,
      rows: [
        { tokenType: 'input', costUsd: '0.010000', estimate: '0.020000' },
        { tokenType: 'output', costUsd: '0.025000', estimate: '0.040000' },
        { tokenType: 'cache-read', costUsd: '0.005000', estimate: '0.005000' },
        { tokenType: 'cache-write', costUsd: '0.010000', estimate: '0.015000' },
      ],
    })
  })

  it('an ESTIMATED-vintage span keeps its pre-cutover meaning (our estimate vs the provider)', async () => {
    const rows = await drift(VIEW_INSTANCE)
    const est = rows.find((r) => r.span_key === 'span-estimated')
    expect(est, 'the pre-cutover span must still be compared').toBeTruthy()
    expect(est!.priced_by).toBe('rate-card')
    // SUM of the four per-type costs, not one of them.
    expect(Number(est!.rate_card_cost_usd)).toBeCloseTo(0.02, 9)
    // Duplicated onto all four rows — MAX, never SUM (SUM would report 0.0492).
    expect(Number(est!.law_cost_usd)).toBeCloseTo(0.0123, 9)
    expect(Number(est!.drift_usd)).toBeCloseTo(0.0077, 9)
    expect(Number(est!.booked_cost_usd)).toBeCloseTo(0.02, 9)
  })

  it('a PROVIDER-vintage span compares the persisted estimate against the provider — NOT itself', async () => {
    const rows = await drift(VIEW_INSTANCE)
    const prov = rows.find((r) => r.span_key === 'span-provider')
    expect(prov, 'the post-cutover span must still be compared').toBeTruthy()
    expect(prov!.priced_by).toBe('provider')
    // The estimate comes from metadata.rate_card_cost_usd (SUMmed per row) —
    // cost_usd is the provider's number now and would give 0.05.
    expect(Number(prov!.rate_card_cost_usd)).toBeCloseTo(0.08, 9)
    expect(Number(prov!.law_cost_usd)).toBeCloseTo(0.05, 9)
    // THE ANTI-TAUTOLOGY ASSERTION. Comparing cost_usd against law_cost_usd
    // would yield 0 here; the diagnostic only works if it yields 0.03.
    expect(Number(prov!.drift_usd)).toBeCloseTo(0.03, 9)
    expect(Number(prov!.drift_usd)).not.toBeCloseTo(0, 3)
    // What the ledger actually charges = exactly the provider's figure. A
    // mismatch here would be a slicing/residue bug, invisible anywhere else.
    expect(Number(prov!.booked_cost_usd)).toBeCloseTo(0.05, 9)
  })

  it('both vintages coexist as separate rows — one span in, one row out, per vintage', async () => {
    const rows = await drift(VIEW_INSTANCE)
    const byKey = new Map(rows.map((r) => [r.span_key, r]))
    expect(byKey.get('span-estimated')?.priced_by).toBe('rate-card')
    expect(byKey.get('span-provider')?.priced_by).toBe('provider')
    // Four rows in per span, one row out per span — the mv-expand must not
    // multiply the comparison.
    expect(rows.filter((r) => r.span_key === 'span-estimated')).toHaveLength(1)
    expect(rows.filter((r) => r.span_key === 'span-provider')).toHaveLength(1)
  })

  it('sign convention is unchanged across the split — positive drift = the card over-prices', async () => {
    // Both seeded spans have an estimate ABOVE the provider figure, so both must
    // be positive. A silent operand swap in one branch would flip one of them.
    const rows = (await drift(VIEW_INSTANCE)).filter((r) =>
      ['span-estimated', 'span-provider'].includes(r.span_key),
    )
    expect(rows).toHaveLength(2)
    for (const r of rows) {
      expect(Number(r.drift_usd), `${r.span_key} drift sign`).toBeGreaterThan(0)
      expect(Number(r.drift_usd)).toBeCloseTo(
        Number(r.rate_card_cost_usd) - Number(r.law_cost_usd),
        9,
      )
    }
  })
})

describe('v_cost_drift — degrades to silence, never to a tautological zero', () => {
  const DEGRADE_INSTANCE = VIEW_INSTANCE

  it('a provider-priced span with NO persisted estimate produces no row at all', async () => {
    await seedSpan({
      instanceId: DEGRADE_INSTANCE,
      spanKey: 'span-no-estimate',
      tsEvent: OLD_TS,
      model: 'claude-opus-5',
      costBasis: 'provider-reported',
      rateCardId: null,
      lawCostUsd: 0.07,
      rows: [
        { tokenType: 'input', costUsd: '0.030000' },
        { tokenType: 'output', costUsd: '0.040000' },
      ],
    })
    const rows = await drift(DEGRADE_INSTANCE)
    expect(rows.map((r) => r.span_key)).not.toContain('span-no-estimate')
  })

  it('a PARTIALLY-annotated span drops out whole — never a SUM over the rows that had the key', async () => {
    // The failure this pins: SUM() ignores NULLs, so without the bool_and guard
    // this span would report a 0.02 estimate (from the one annotated row) and
    // manufacture drift out of a missing key.
    await seedSpan({
      instanceId: DEGRADE_INSTANCE,
      spanKey: 'span-partial-estimate',
      tsEvent: OLD_TS,
      model: 'claude-opus-5',
      costBasis: 'provider-reported',
      rateCardId: null,
      lawCostUsd: 0.09,
      rows: [
        { tokenType: 'input', costUsd: '0.040000', estimate: '0.020000' },
        { tokenType: 'output', costUsd: '0.050000' }, // key absent
      ],
    })
    const rows = await drift(DEGRADE_INSTANCE)
    expect(rows.map((r) => r.span_key)).not.toContain('span-partial-estimate')
  })

  it('a legacy span with no metadata at all still produces no row (pre-0045 behaviour)', async () => {
    await seedSpan({
      instanceId: DEGRADE_INSTANCE,
      spanKey: 'span-legacy',
      tsEvent: OLD_TS,
      model: 'claude-sonnet-4-6',
      costBasis: 'estimated',
      rateCardId: RATE_CARD_ID,
      rows: [{ tokenType: 'input', costUsd: '0.001000' }],
    })
    const rows = await drift(DEGRADE_INSTANCE)
    expect(rows.map((r) => r.span_key)).not.toContain('span-legacy')
  })
})

describe('v_cost_drift — the rung predicate is not fooled by the overloaded cost_basis', () => {
  it('a BACKFILLED provider-priced span (cost_basis="telemetry-only") is still read as provider-priced', async () => {
    // cost_basis carries TWO things: the costing rung and backfill provenance
    // (mig 0045 / ADR-0005 slice 3). A backfilled span that the provider priced
    // is stamped 'telemetry-only', so a cost_basis-only test would misread it as
    // an estimate and hand back drift ≈ 0 — the exact tautology being fixed.
    // rate_card_id IS NULL is what saves it.
    await seedSpan({
      instanceId: VIEW_INSTANCE,
      spanKey: 'span-backfill-provider',
      tsEvent: OLD_TS,
      model: 'claude-fable-5',
      costBasis: 'telemetry-only',
      rateCardId: null,
      lawCostUsd: 0.04,
      rows: [
        { tokenType: 'input', costUsd: '0.015000', estimate: '0.030000' },
        { tokenType: 'output', costUsd: '0.025000', estimate: '0.030000' },
      ],
    })
    const row = (await drift(VIEW_INSTANCE)).find((r) => r.span_key === 'span-backfill-provider')
    expect(row).toBeTruthy()
    expect(row!.priced_by).toBe('provider')
    expect(Number(row!.rate_card_cost_usd)).toBeCloseTo(0.06, 9)
    expect(Number(row!.drift_usd)).toBeCloseTo(0.02, 9)
  })

  it('a span half-written across the cutover reports priced_by = "mixed" and sums both branches', async () => {
    // Rows are frozen and dedup is ON CONFLICT DO NOTHING, so a span whose early
    // rows landed before the cutover keeps them. Surfaced, not hidden.
    await seedSpan({
      instanceId: VIEW_INSTANCE,
      spanKey: 'span-mixed',
      tsEvent: OLD_TS,
      model: 'claude-sonnet-4-6',
      costBasis: 'estimated',
      rateCardId: RATE_CARD_ID,
      lawCostUsd: 0.03,
      rows: [{ tokenType: 'input', costUsd: '0.012000' }],
    })
    await seedSpan({
      instanceId: VIEW_INSTANCE,
      spanKey: 'span-mixed',
      tsEvent: OLD_TS,
      model: 'claude-sonnet-4-6',
      costBasis: 'provider-reported',
      rateCardId: null,
      lawCostUsd: 0.03,
      rows: [{ tokenType: 'output', costUsd: '0.018000', estimate: '0.025000' }],
    })
    const row = (await drift(VIEW_INSTANCE)).find((r) => r.span_key === 'span-mixed')
    expect(row!.priced_by).toBe('mixed')
    // rate-card row contributes its cost_usd, provider row its persisted estimate.
    expect(Number(row!.rate_card_cost_usd)).toBeCloseTo(0.037, 9)
    expect(Number(row!.booked_cost_usd)).toBeCloseTo(0.03, 9)
  })

  it('Copilot spans are excluded — they never used a rate card and would read as provider-priced', async () => {
    await seedSpan({
      instanceId: VIEW_INSTANCE,
      spanKey: 'span-copilot',
      tsEvent: OLD_TS,
      model: 'gpt-5',
      costBasis: 'telemetry-only',
      rateCardId: null,
      tool: 'github-copilot',
      lawCostUsd: 0.02,
      rows: [{ tokenType: 'output', costUsd: '0.020000', estimate: '0.020000' }],
    })
    const rows = await drift(VIEW_INSTANCE)
    expect(rows.map((r) => r.span_key)).not.toContain('span-copilot')
  })
})

// ── GET /api/v1/admin/diagnostics — costingRungs ───────────────────────────
function makeEvent(session: Session) {
  const cookies = new Map<string, string>()
  const headers: Record<string, string> = { host: 'localhost:3450' }
  const ev = {
    cookies,
    method: 'GET',
    path: '/api/v1/admin/diagnostics',
    context: { params: {} },
    node: {
      req: {
        method: 'GET',
        url: '/api/v1/admin/diagnostics',
        get headers() {
          return { ...headers, cookie: '', 'content-type': 'application/json' }
        },
      },
      res: {
        _headers: {} as Record<string, string | string[]>,
        statusCode: 200,
        getHeader(name: string) { return this._headers[name.toLowerCase()] },
        setHeader(name: string, value: string | string[]) { this._headers[name.toLowerCase()] = value },
        removeHeader(name: string) { this._headers[name.toLowerCase()] = '' },
        appendHeader() {},
        get headersSent() { return false },
      },
    },
  }
  injectTestSession(ev as unknown as Parameters<typeof injectTestSession>[0], session)
  return ev
}

// Region-scoped 'admin' (not platform-admin): the costing-rung query applies an
// explicit region filter for that role, which both isolates this suite's counts
// and proves the filter is wired.
const adminSession = (): Session => ({
  teammateId: '00000000-0000-0000-0000-0000000000a1',
  email: 'pcd-admin@x.test',
  displayName: 'Admin',
  role: 'admin',
  regionId,
  orgPath: 'pcd.svc',
})
// v_cost_drift has no region_id, so only platform-admin gets the drift section.
const platformSession = (): Session => ({
  teammateId: '9a1e0000-0000-4000-8000-0000000000a2',
  email: 'pcd-platform@x.test',
  displayName: 'Platform',
  role: 'platform-admin',
  regionId,
  orgPath: 'pcd.svc',
})
const devSession = (): Session => ({
  teammateId: '00000000-0000-0000-0000-0000000000d1',
  email: 'pcd-dev@x.test',
  displayName: 'Dev',
  role: 'developer',
  regionId,
  orgPath: 'pcd.svc',
})

interface DiagResp {
  costingRungs: {
    windowDays: number
    spans: number
    provider: number
    rateCard: number
    other: number
    ladderSpans: number
    rateCardPct: number | null
    fallbackModels: { model: string; spans: number }[]
  }
  costDrift: {
    spansCompared: number
    meanAbsDriftPct: number | null
    providerPricedSpans: number
    rateCardPricedSpans: number
    worstSpan: { model: string; pricedBy: string; driftUsd: string } | null
  } | null
  costDriftScopedOut?: { reason: string; detail: string }
  // Per-read availability. The zero shapes above are indistinguishable from a
  // failed query without it, so this is the only field that lets the page tell
  // "nothing happened" from "we could not find out".
  reads: {
    costDrift?: { available: boolean; error?: string; errorCorrelationId?: string }
    costingRungs: { available: boolean; error?: string; errorCorrelationId?: string }
  }
}

// The costing aggregates moved off the main snapshot to their own endpoint
// (docs/design/admin-nav-responsiveness.md D4); this block moved with them.
describe('GET /api/v1/admin/diagnostics/costing — costing rungs', () => {
  // Region admin: region-clamped rungs, no drift section.
  let resp: DiagResp
  // Platform-admin: the drift section, read from the same seeded window.
  let platformResp: DiagResp

  async function loadHandler() {
    vi.resetModules()
    return (await import('../../../server/api/v1/admin/diagnostics/costing.get'))
      .default as (event: unknown) => Promise<DiagResp>
  }

  beforeAll(async () => {
    const recent = (hoursAgo: number) => new Date(Date.now() - hoursAgo * 3600_000)

    // Healthy rung: the provider priced it. Four token-type rows, ONE span —
    // the counter must not read this as four fallbacks-worth of anything.
    await seedSpan({
      instanceId: EP_INSTANCE, spanKey: 'ep-provider', tsEvent: recent(1),
      model: 'claude-sonnet-4-6', costBasis: 'provider-reported', rateCardId: null,
      lawCostUsd: 0.05,
      rows: [
        { tokenType: 'input', costUsd: '0.010000', estimate: '0.150000' },
        { tokenType: 'output', costUsd: '0.025000', estimate: '0.100000' },
        { tokenType: 'cache-read', costUsd: '0.005000', estimate: '0.020000' },
        { tokenType: 'cache-write', costUsd: '0.010000', estimate: '0.030000' },
      ],
    })

    // Three rate-card fallbacks across two models — the anomaly.
    await seedSpan({
      instanceId: EP_INSTANCE, spanKey: 'ep-rc-a', tsEvent: recent(2),
      model: 'claude-opus-5', costBasis: 'estimated', rateCardId: RATE_CARD_ID,
      lawCostUsd: 0.01,
      rows: [
        { tokenType: 'input', costUsd: '0.004000' },
        { tokenType: 'output', costUsd: '0.008000' },
      ],
    })
    await seedSpan({
      instanceId: EP_INSTANCE, spanKey: 'ep-rc-b', tsEvent: recent(3),
      model: 'claude-opus-5', costBasis: 'estimated', rateCardId: RATE_CARD_ID,
      lawCostUsd: 0.01,
      rows: [{ tokenType: 'output', costUsd: '0.011000' }],
    })
    await seedSpan({
      instanceId: EP_INSTANCE, spanKey: 'ep-rc-c', tsEvent: recent(4),
      model: 'claude-fable-5', costBasis: 'estimated', rateCardId: RATE_CARD_ID,
      lawCostUsd: 0.01,
      rows: [{ tokenType: 'output', costUsd: '0.012000' }],
    })

    // Neither rung: backfill provenance. Must land in `other`, not be folded
    // into the alerting bucket. No metadata ⇒ stays out of the drift view too.
    await seedSpan({
      instanceId: EP_INSTANCE, spanKey: 'ep-other', tsEvent: recent(5),
      model: 'claude-sonnet-4-6', costBasis: 'telemetry-only', rateCardId: RATE_CARD_ID,
      rows: [{ tokenType: 'input', costUsd: '0.001000' }],
    })

    // Copilot: priced from AI credits, never used a rate card. Excluded.
    await seedSpan({
      instanceId: EP_INSTANCE, spanKey: 'ep-copilot', tsEvent: recent(6),
      model: 'gpt-5', costBasis: 'telemetry-only', rateCardId: null, tool: 'github-copilot',
      rows: [{ tokenType: 'output', costUsd: '0.030000' }],
    })

    // Outside the 7-day window.
    await seedSpan({
      instanceId: EP_INSTANCE, spanKey: 'ep-old', tsEvent: recent(24 * 10),
      model: 'claude-sonnet-4-6', costBasis: 'estimated', rateCardId: RATE_CARD_ID,
      lawCostUsd: 0.01,
      rows: [{ tokenType: 'input', costUsd: '0.500000' }],
    })

    const handler = await loadHandler()
    resp = await handler(makeEvent(adminSession()))
    platformResp = await handler(makeEvent(platformSession()))
  }, 60_000)

  it('REJECTS a developer — diagnostics is admin / platform-admin only', async () => {
    const handler = await loadHandler()
    await expect(handler(makeEvent(devSession()))).rejects.toMatchObject({ statusCode: 403 })
  })

  it('returns EXACTLY the two keys the main snapshot used to carry, in their old shapes (platform-admin)', () => {
    // The page re-points its drift and rungs cards at this read; a key that
    // silently stays on (or comes back to) the main snapshot would render as
    // "no data" there while looking green here.
    expect(Object.keys(platformResp).sort()).toEqual(['costDrift', 'costingRungs', 'reads'])
    // `reads` carries one entry per independently-fallible read and NOTHING is
    // merged into the two data shapes, so a consumer pinned to their fields is
    // untouched by the availability signal.
    expect(Object.keys(platformResp.reads).sort()).toEqual(['costDrift', 'costingRungs'])
    expect(platformResp.reads.costDrift).toEqual({ available: true })
    expect(platformResp.reads.costingRungs).toEqual({ available: true })
    expect(Object.keys(platformResp.costingRungs).sort()).toEqual(
      ['fallbackModels', 'ladderSpans', 'other', 'provider', 'rateCard', 'rateCardPct', 'spans', 'windowDays'],
    )
    expect(Object.keys(platformResp.costDrift!).sort()).toEqual(
      ['meanAbsDriftPct', 'providerPricedSpans', 'rateCardPricedSpans', 'spansCompared', 'worstSpan'],
    )
  })

  it('a REGION admin gets no drift section (v_cost_drift has no region) and is told why; rungs stay region-clamped', () => {
    // Drift data exists in this window (the platform-admin read sees it), so a
    // null here is the scope rule, not an empty view.
    expect(platformResp.costDrift!.spansCompared).toBeGreaterThan(0)
    expect(Object.keys(resp).sort()).toEqual(['costDrift', 'costDriftScopedOut', 'costingRungs', 'reads'])
    expect(resp.costDrift).toBeNull()
    expect(resp.costDriftScopedOut).toMatchObject({ reason: 'platform-admin-only' })
    // No availability entry for a read that was never run: it must not read as a failure.
    expect(Object.keys(resp.reads)).toEqual(['costingRungs'])
    expect(resp.reads.costingRungs).toEqual({ available: true })
    // Nothing from the estate-wide view leaks through any other field.
    expect(JSON.stringify(resp)).not.toContain(platformResp.costDrift!.worstSpan!.model + '"')
    expect(resp.costingRungs.spans).toBe(5)
  })

  it('counts SPANS, not rows — a four-token-type provider span is one provider span', () => {
    expect(resp.costingRungs.provider).toBe(1)
  })

  it('buckets the window exactly: provider / rate-card / other, with nothing hidden', () => {
    const c = resp.costingRungs
    expect(c.windowDays).toBe(7)
    expect(c.rateCard).toBe(3)
    expect(c.other).toBe(1)
    // Every claude-code span in the window is in exactly one bucket. Copilot and
    // the 10-day-old span are excluded, so the total is 5, not 7.
    expect(c.spans).toBe(5)
    expect(c.provider + c.rateCard + c.other).toBe(c.spans)
  })

  it('reports the fallback share OVER THE LADDER-PRICED SPANS, and names the models, worst first', () => {
    const c = resp.costingRungs
    // 3 rate-card spans out of the 4 the LADDER priced (1 provider + 3 rate
    // card) = 75%. NOT 3/5 = 60%: the `other` bucket is neither rung — it is
    // backfill provenance — and must not sit in the denominator of a fallback
    // rate. See the next test for why that distinction is load-bearing.
    expect(c.ladderSpans).toBe(4)
    expect(c.ladderSpans).toBe(c.provider + c.rateCard)
    expect(c.rateCardPct).toBe(75)
    expect(c.fallbackModels).toEqual([
      { model: 'claude-opus-5', spans: 2 },
      { model: 'claude-fable-5', spans: 1 },
    ])
  })

  it('the drift card keeps working across the old/new split and labels the worst span vintage', () => {
    const d = platformResp.costDrift!
    // 1 provider-priced + 3 rate-card-priced comparable spans in the window.
    expect(d.spansCompared).toBe(4)
    expect(d.providerPricedSpans).toBe(1)
    expect(d.rateCardPricedSpans).toBe(3)
    // The provider span's estimate (0.30) is far from its provider figure
    // (0.05), so it is the worst — and it is only visible at all because the
    // estimate was persisted rather than re-read from cost_usd.
    expect(d.worstSpan?.pricedBy).toBe('provider')
    expect(Number(d.worstSpan?.driftUsd)).toBeCloseTo(0.25, 6)
  })

  it('A FAILING DRIFT READ CANNOT BLANK THE RUNGS CARD, AND DECLARES ITSELF UNAVAILABLE', async () => {
    /*
     * costDrift reads v_cost_drift, which a pre-0045 database does not have. A
     * failed statement aborts the Postgres transaction it runs in, so if the two
     * reads shared one, the missing view would also throw away the rungs result
     * and the card the alert lives on would read all-zero: a success-shaped
     * nothing, indistinguishable from a healthy fleet with no traffic. Hide the
     * view for one request and assert the rungs still carry the seeded spans.
     *
     * Isolation alone is only half of it: the drift read's OWN zero shape is
     * still success-shaped, and the page draws "No comparable spans yet" from
     * it. So the failure must also be DECLARED — `reads.costDrift.available`
     * false with a classified reason — while the healthy sibling stays
     * available. Without that field the two states are the same bytes.
     */
    await t.client.unsafe('ALTER VIEW v_cost_drift RENAME TO v_cost_drift_hidden_by_test')
    try {
      const handler = await loadHandler()
      const r = await handler(makeEvent(platformSession()))
      expect(r.costDrift).toEqual({
        spansCompared: 0,
        meanAbsDriftPct: null,
        providerPricedSpans: 0,
        rateCardPricedSpans: 0,
        worstSpan: null,
      })
      // The failed read says so, with a reason and a correlation id that ties
      // back to the full-fidelity server log line (never the raw message).
      expect(r.reads.costDrift!.available).toBe(false)
      expect(r.reads.costDrift!.error).toBe('relation-missing')
      expect(r.reads.costDrift!.errorCorrelationId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      )
      // No fragment of the driver's message (which carries the relation name and
      // can carry host/db/user) rides along.
      expect(JSON.stringify(r.reads.costDrift)).not.toContain('v_cost_drift')
      // The healthy sibling is unaffected: same numbers AND still declared
      // available, so its card is not tarred by its neighbour's failure.
      expect(r.reads.costingRungs).toEqual({ available: true })
      expect(r.costingRungs).toEqual(platformResp.costingRungs)
      expect(r.costingRungs.spans).toBe(5)
    } finally {
      await t.client.unsafe('ALTER VIEW v_cost_drift_hidden_by_test RENAME TO v_cost_drift')
    }
  })

  // LAST in the file: it seeds more rows, so it must not run before the
  // assertions above, which read the `resp` captured in beforeAll.
  it('BACKFILL TRAFFIC CANNOT SOFTEN THE ALERT — the fallback share ignores the `other` bucket', async () => {
    /*
     * A backfill campaign (/tokenscope:backfill, ADR-0005 slice 3) stamps
     * cost_basis 'telemetry-only', which is neither rung, so those spans land in
     * `other`. Running one is an ordinary operator action — and exactly the kind
     * of thing someone does DURING an incident.
     *
     * With `spans` as the denominator, twenty backfilled spans would have taken
     * the fallback share from 60% to 12% while the number of real fallbacks was
     * unchanged: a live alert quietly turning green because unrelated traffic
     * arrived. The denominator is the two ladder buckets, so it does not move.
     */
    const before = resp.costingRungs
    for (let i = 0; i < 20; i++) {
      await seedSpan({
        instanceId: EP_INSTANCE,
        spanKey: `ep-backfill-${i}`,
        tsEvent: new Date(Date.now() - 3600_000),
        model: 'claude-sonnet-4-6',
        costBasis: 'telemetry-only',
        rateCardId: RATE_CARD_ID,
        rows: [{ tokenType: 'input', costUsd: '0.001000' }],
      })
    }
    const handler = await loadHandler()
    const after = (await handler(makeEvent(adminSession()))).costingRungs

    expect(after.other).toBe(before.other + 20)
    expect(after.spans).toBe(before.spans + 20)
    // The two ladder buckets, and therefore the alert, are untouched.
    expect(after.rateCard).toBe(before.rateCard)
    expect(after.provider).toBe(before.provider)
    expect(after.ladderSpans).toBe(before.ladderSpans)
    expect(after.rateCardPct).toBe(before.rateCardPct)
    // For contrast: the share the old denominator would have reported.
    expect(Number(((after.rateCard / after.spans) * 100).toFixed(2))).toBeCloseTo(12, 6)
  })
})

// ── SSRF regression: GET /api/v1/admin/diagnostics/otel-logs ───────────────
//
// The route used to accept a caller-supplied `?endpoint=` that steered a
// Managed-Identity-authenticated outbound query, allowlisted by a hostname
// regex (`/(^|\.)monitor\.azure\.[a-z]{2,}$/`) — a wildcard TLD is not a
// network boundary. The fix removes the query-schema field entirely rather
// than tightening the regex, so this pins that the parameter is well and
// truly gone: it is silently stripped by Zod (no such field exists to bind
// to) and NEVER reaches LogAnalyticsReader's constructor, regardless of what
// a caller sends.
//
// Placed beside the rest of this file's diagnostics-route suite because it
// shares the same real-DB harness and makeEvent helper; the endpoint under
// test (otel-logs.get.ts) is a sibling of the costing-rungs route above.
describe('SSRF: GET /api/v1/admin/diagnostics/otel-logs — the endpoint override is gone', () => {
  const platformAdminSession = (): Session => ({
    teammateId: '00000000-0000-0000-0000-0000000000p1',
    email: 'pcd-pa@x.test',
    displayName: 'PA',
    role: 'platform-admin',
    regionId,
    orgPath: 'pcd.svc',
  })

  it('?endpoint=https://monitor.azure.xyz never reaches the reader', async () => {
    let capturedOptions: { queryEndpoint?: string } | undefined
    vi.resetModules()
    vi.doMock('../../../server/azure/reader', async () => {
      const actual = await vi.importActual<typeof import('../../../server/azure/reader')>(
        '../../../server/azure/reader',
      )
      return {
        ...actual,
        LogAnalyticsReader: class {
          constructor(_workspaceId: string, opts: { queryEndpoint?: string }) {
            capturedOptions = opts
          }
          diagnosticOtelLogs() {
            return Promise.resolve({
              hours: 24,
              limit: 20,
              workspaceId: 'fake-workspace-id',
              duration: 'PT24H',
              queryEndpointNote: 'stub',
              dns: [],
              queries: [],
            })
          }
        },
      }
    })

    process.env.NUXT_TELEMETRY_READER = 'log-analytics'
    process.env.NUXT_LOG_ANALYTICS_WORKSPACE_ID = 'fake-workspace-id'
    const savedEndpoint = process.env.NUXT_AZURE_MONITOR_QUERY_ENDPOINT
    delete process.env.NUXT_AZURE_MONITOR_QUERY_ENDPOINT

    try {
      const handler = (await import('../../../server/api/v1/admin/diagnostics/otel-logs.get'))
        .default as (event: unknown) => Promise<{ workspaceId?: string }>
      const ev = makeEvent(platformAdminSession())
      // A caller trying to exercise the OLD SSRF knob — the schema has no
      // field for it any more, so this must be silently dropped, not bound.
      ;(ev as { path: string }).path =
        '/api/v1/admin/diagnostics/otel-logs?endpoint=https%3A%2F%2Fmonitor.azure.xyz'
      const result = await handler(ev)

      // The reader was constructed with NO endpoint override — the env var
      // was unset above, so the option must be undefined, never the
      // attacker-supplied host.
      expect(capturedOptions?.queryEndpoint).toBeUndefined()
      // Also pins the sibling fix: the raw workspace GUID is stripped before
      // the handler returns it.
      expect(result.workspaceId).toBeUndefined()
    } finally {
      delete process.env.NUXT_TELEMETRY_READER
      delete process.env.NUXT_LOG_ANALYTICS_WORKSPACE_ID
      if (savedEndpoint !== undefined) process.env.NUXT_AZURE_MONITOR_QUERY_ENDPOINT = savedEndpoint
      vi.doUnmock('../../../server/azure/reader')
      vi.resetModules()
    }
  })
})
