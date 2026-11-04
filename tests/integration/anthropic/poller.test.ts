// @vitest-environment node
/*
 * Analytics poller + reconciliation — end-to-end against an in-process
 * synthetic-anthropic-api stub + testcontainers Postgres.
 *
 * Per docs/build/mvp-lite-epic.md §Epic 9 EVS:
 *   - poller upserts actual_spend idempotently
 *   - reconciliation creates info-severity inbox items for users with
 *     >10% gap
 */
import { createServer, type Server } from 'node:http'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'
import { AnthropicAnalyticsClient } from '../../../server/anthropic/client'
import { runAnalyticsPoll, runAnalyticsPollReconciledOrgs } from '../../../server/workers/analytics-poller'
import { runReconciliation } from '../../../server/workers/reconciliation'
import * as schema from '../../../drizzle/schema'

let t: TestDb
let stub: Server
let stubUrl = ''
let priyaId: string
let projectId: string

// Current-month-relative spend date: runReconciliation scopes to the
// current calendar month, so a hardcoded date silently falls out of window
// when the month rolls over (this test used '2026-05-24' and broke in June).
// First-of-month is always >= the reconciliation monthStart.
const _now = new Date()
const SPEND_DATE = `${_now.getUTCFullYear()}-${String(_now.getUTCMonth() + 1).padStart(2, '0')}-01`

beforeAll(async () => {
  t = await startTestDb()

  // Spin a stub of the synthetic-anthropic-api shape — payload dated
  // SPEND_DATE (current month) with priya + an unknown email. Self-contained.
  stub = createServer((req, res) => {
    if (req.url?.startsWith('/v1/organizations/usage_report/claude_code')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      // Real claude_code Admin shape (mig 0063): FLAT data[] of per-user records;
      // tokens + cost NESTED under model_breakdown[]; estimated_cost.amount in CENTS;
      // actor union user_actor (email_address) / api_actor; customer_type.
      res.end(
        JSON.stringify({
          has_more: false,
          data: [
            {
              date: SPEND_DATE,
              actor: { type: 'user_actor', email_address: 'priya.iyer@example.com' },
              customer_type: 'api',
              model_breakdown: [
                {
                  model: 'claude-sonnet-4-6',
                  tokens: { input: 12000, output: 8000, cache_read: 0, cache_creation: 0 },
                  estimated_cost: { currency: 'USD', amount: 15.6 }, // 15.6 cents -> $0.1560
                },
              ],
            },
            {
              date: SPEND_DATE,
              actor: { type: 'user_actor', email_address: 'ghost@nowhere.com' },
              customer_type: 'api',
              model_breakdown: [
                {
                  model: 'claude-sonnet-4-6',
                  tokens: { input: 100, output: 50, cache_read: 0, cache_creation: 0 },
                  estimated_cost: { currency: 'USD', amount: 0.1 }, // 0.1 cents -> $0.0010
                },
              ],
            },
          ],
        }),
      )
      return
    }
    // Enterprise Analytics API shape (mig 0063 'enterprise-analytics'): per-actor
    // rows. user_usage_report carries token counts; user_cost_report carries
    // `amount` as a fractional-CENTS decimal STRING + cost_type. actor uses `email`.
    if (req.url?.startsWith('/v1/organizations/analytics/user_usage_report')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          organization_id: 'org-ENT',
          has_more: false,
          next_page: null,
          data: [
            {
              actor: { type: 'user_actor', email: 'priya.iyer@example.com' },
              product: 'claude_code',
              model: 'claude-sonnet-4-6',
              uncached_input_tokens: 5000,
              output_tokens: 3000,
              total_tokens: 8000,
            },
            // Unknown email -> resolves to no teammate -> counted as skipped.
            {
              actor: { type: 'user_actor', email: 'ghost@nowhere.com' },
              product: 'claude_code',
              model: 'claude-sonnet-4-6',
              uncached_input_tokens: 100,
              output_tokens: 50,
              total_tokens: 150,
            },
          ],
        }),
      )
      return
    }
    if (req.url?.startsWith('/v1/organizations/analytics/user_cost_report')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          organization_id: 'org-ENT',
          has_more: false,
          next_page: null,
          data: [
            // Token cost -> folds into priya's actual_spend.cost_usd. 25 cents -> $0.25.
            {
              actor: { type: 'user_actor', email: 'priya.iyer@example.com' },
              currency: 'USD',
              amount: '25',
              cost_type: 'tokens',
              token_type: 'uncached_input',
              product: 'claude_code',
            },
            // web_search is ORG-GRAIN -> MUST NOT inflate priya's per-teammate cost_usd.
            // 1000 cents -> $10.00 would be a glaring inflation if double-counted.
            {
              actor: { type: 'user_actor', email: 'priya.iyer@example.com' },
              currency: 'USD',
              amount: '1000',
              cost_type: 'web_search',
              product: 'claude_code',
            },
          ],
        }),
      )
      return
    }
    res.writeHead(404)
    res.end()
  })
  await new Promise<void>((r) =>
    stub.listen(0, '127.0.0.1', () => {
      const addr = stub.address()
      stubUrl = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`
      r()
    }),
  )

  // Seed a region + org + project + priya.
  const [region] = await t.db
    .insert(schema.region)
    .values({ code: 'apac-an', displayName: 'APAC' })
    .returning()
  const [org] = await t.db
    .insert(schema.orgUnit)
    .values({
      regionId: region!.id,
      path: 'apac.an',
      code: 'an-bu',
      displayName: 'An BU',
      unitType: 'bu',
    })
    .returning()
  const [priya] = await t.db
    .insert(schema.teammate)
    .values({
      entraOid: 'oid-priya-an',
      email: 'priya.iyer@example.com',
      regionId: region!.id,
      orgUnitId: org!.id,
    })
    .returning()
  const [proj] = await t.db
    .insert(schema.project)
    .values({
      code: 'AN-1',
      codeHash: 'h-an-1',
      displayName: 'An',
      type: 'billable',
      regionId: region!.id,
      costOwningUnitId: org!.id,
    })
    .returning()
  priyaId = priya!.id
  projectId = proj!.id
}, 120_000)

afterAll(async () => {
  await new Promise<void>((r) => stub.close(() => r()))
  await stopTestDb(t)
}, 30_000)

describe('runAnalyticsPoll', () => {
  it('upserts the known user, skips unknown email', async () => {
    const client = new AnthropicAnalyticsClient(stubUrl)
    const result = await runAnalyticsPoll(t.db, client, {
      startingAt: SPEND_DATE,
      endingAt: SPEND_DATE,
    })
    expect(result.daysPulled).toBe(1)
    expect(result.recordsTotal).toBe(2)
    expect(result.recordsUpserted).toBe(1)
    expect(result.recordsSkippedUnknownUser).toBe(1)

    const rows = await t.client<{ input_tokens: string; cost_usd: string }[]>`
      SELECT input_tokens::text AS input_tokens, cost_usd::text AS cost_usd
      FROM actual_spend WHERE teammate_id = ${priyaId}::uuid
    `
    expect(rows.length).toBe(1)
    expect(rows[0]!.input_tokens).toBe('12000')
  })

  it('second poll is idempotent (same row, refreshed pulled_at)', async () => {
    const client = new AnthropicAnalyticsClient(stubUrl)
    const result = await runAnalyticsPoll(t.db, client, {
      startingAt: SPEND_DATE,
      endingAt: SPEND_DATE,
    })
    expect(result.recordsUpserted).toBe(1)
    const rows = await t.client<{ count: string }[]>`
      SELECT COUNT(*)::text AS count FROM actual_spend WHERE teammate_id = ${priyaId}::uuid
    `
    expect(rows[0]!.count).toBe('1')
  })

  it('resolves the teammate CASE-INSENSITIVELY — a mixed-case provider email binds the lowercased row (fix #1)', async () => {
    // Bill-driven placement stores emails lowercased; provider bills carry mixed
    // case (First.Last@…). A case-SENSITIVE resolve would skip + enqueue this
    // forever and drop post-placement cost revisions. Seed lowercase, poll
    // mixed-case, assert it BINDS (upserted, not skipped-unknown).
    const [seed] = await t.client<{ region_id: string; org_unit_id: string }[]>`
      SELECT region_id::text AS region_id, org_unit_id::text AS org_unit_id FROM teammate WHERE id = ${priyaId}::uuid`
    const [tm] = await t.db
      .insert(schema.teammate)
      .values({
        entraOid: 'oid-mixed',
        email: 'mixed.case@example.com', // stored lowercase
        regionId: seed!.region_id,
        orgUnitId: seed!.org_unit_id,
      })
      .returning()

    const fakeClient = {
      getClaudeCodeUsage: async () => ({
        has_more: false,
        data: [
          {
            date: SPEND_DATE,
            actor: { type: 'user_actor', email_address: 'Mixed.Case@example.com' }, // mixed case
            customer_type: 'api',
            model_breakdown: [
              {
                model: 'claude-sonnet-4-6',
                tokens: { input: 7, output: 3, cache_read: 0, cache_creation: 0 },
                estimated_cost: { currency: 'USD', amount: 1 },
              },
            ],
          },
        ],
      }),
    } as unknown as AnthropicAnalyticsClient

    const result = await runAnalyticsPoll(t.db, fakeClient, {
      startingAt: SPEND_DATE,
      endingAt: SPEND_DATE,
      externalOrgId: 'mixedcase',
    })
    expect(result.recordsUpserted).toBe(1)
    expect(result.recordsSkippedUnknownUser).toBe(0) // resolved, NOT enqueued

    const rows = await t.client<{ input_tokens: string }[]>`
      SELECT input_tokens::text AS input_tokens FROM actual_spend
      WHERE teammate_id = ${tm!.id}::uuid AND source = 'anthropic-analytics-api:mixedcase'`
    expect(rows.length).toBe(1)
    expect(rows[0]!.input_tokens).toBe('7')

    // And nothing landed in the placement queue (the bug's tell-tale).
    const owed = await t.client<{ count: string }[]>`
      SELECT COUNT(*)::text AS count FROM pending_placement WHERE lower(identity_email) = 'mixed.case@example.com'`
    expect(owed[0]!.count).toBe('0')
  })
})

describe('runReconciliation', () => {
  it('creates an info-severity untagged-backlog inbox item when gap > 10%', async () => {
    // The poll wrote actual_spend $0.1560 for priya. OTel attribution is
    // 0 for her. Gap = (0.156 - 0) / 0.156 = 100% > 10% → flag.
    const result = await runReconciliation(t.db)
    expect(result.gapsFlagged).toBeGreaterThanOrEqual(1)

    const rows = await t.client<{ category: string; severity: string; subject: string }[]>`
      SELECT category, severity, subject FROM inbox_item
      WHERE recipient_teammate_id = ${priyaId}::uuid
    `
    const target = rows.find((r) => r.category === 'untagged-backlog')
    expect(target).toBeDefined()
    expect(target!.severity).toBe('info')
    // The gap is Anthropic's total vs ALL recorded sessions (tagged or not), so the
    // subject says unrecorded, never "untagged" (PR 508 review).
    expect(target!.subject).toContain('Unrecorded spend')
    expect(target!.subject).not.toMatch(/tagged/i)
  })

  it('does not duplicate the same-month inbox item', async () => {
    const before = await t.client<{ count: string }[]>`
      SELECT COUNT(*)::text AS count FROM inbox_item
      WHERE recipient_teammate_id = ${priyaId}::uuid AND category = 'untagged-backlog'
    `
    await runReconciliation(t.db)
    const after = await t.client<{ count: string }[]>`
      SELECT COUNT(*)::text AS count FROM inbox_item
      WHERE recipient_teammate_id = ${priyaId}::uuid AND category = 'untagged-backlog'
    `
    expect(after[0]!.count).toBe(before[0]!.count)
  })
})

describe('runReconciliation — over-attribution (slice 11)', () => {
  const BOB = 'dddddddd-0000-0000-0000-000000000001'
  const BOB_SESSION = 'dddddddd-0000-0000-0000-0000000000aa'

  it('flags + audits when reconciled-lane attribution exceeds the Anthropic actual', async () => {
    // Reuse priya's region/org + the AN-1 project. Bob: actual $1.00 but
    // reconciled-lane (cost_basis='estimated') attribution $1.50 → over by 50%.
    const [tm] = await t.client<{ region_id: string; org_unit_id: string }[]>`
      SELECT region_id::text AS region_id, org_unit_id::text AS org_unit_id FROM teammate WHERE id = ${priyaId}::uuid`
    const [pr] = await t.client<{ code_hash: string; cou: string }[]>`
      SELECT code_hash, cost_owning_unit_id::text AS cou FROM project WHERE id = ${projectId}::uuid`
    await t.client.unsafe(`
      INSERT INTO teammate (id, entra_oid, email, region_id, org_unit_id)
        VALUES ('${BOB}', 'oid-bob', 'bob@example.com', '${tm!.region_id}', '${tm!.org_unit_id}');
      INSERT INTO actual_spend (teammate_id, date, tool, source, input_tokens, output_tokens, cost_usd)
        VALUES ('${BOB}', now()::date, 'claude-code', 'anthropic-analytics-api', 1000, 1000, 1.00);
      INSERT INTO instance_attestation
        (instance_id, principal_oid, principal_email, teammate_id, project_code_hash, raw_project_code,
         tool, session_token_hash, ts_start, region_id, org_unit_id, cost_owning_unit_id)
        VALUES ('${BOB_SESSION}', 'oid-bob', 'bob@example.com', '${BOB}', '${pr!.code_hash}', 'AN-1',
                'claude-code', 'h-bob', now(), '${tm!.region_id}', '${tm!.org_unit_id}', '${pr!.cou}');
      INSERT INTO attribution_record
        (instance_id, teammate_id, project_id, region_id, org_unit_id, cost_owning_unit_id,
         tool, model, token_type, tokens, cost_usd, rate_card_id, rate_card_version,
         fidelity_tier, cost_basis, ts_event)
        VALUES ('${BOB_SESSION}', '${BOB}', '${projectId}', '${tm!.region_id}', '${tm!.org_unit_id}', '${pr!.cou}',
                'claude-code', 'claude-sonnet-4-7', 'input', 1000, 1.50,
                'eeeeeeee-0000-0000-0000-000000000001', 1, 'tier-1', 'estimated', now());
    `)

    const result = await runReconciliation(t.db)
    expect(result.overAttributionsFlagged).toBeGreaterThanOrEqual(1)

    const items = await t.client<{ category: string; severity: string; subject: string }[]>`
      SELECT category, severity, subject FROM inbox_item WHERE recipient_teammate_id = ${BOB}::uuid`
    const over = items.find((i) => i.category === 'over-attribution')
    expect(over).toBeDefined()
    expect(over!.severity).toBe('attention')
    expect(over!.subject).toContain('Over-attribution')

    const audit = await t.client<{ count: string }[]>`
      SELECT COUNT(*)::text AS count FROM audit_event
      WHERE event_type = 'over-attribution-flagged' AND subject_id = ${BOB}::uuid`
    expect(Number(audit[0]!.count)).toBeGreaterThanOrEqual(1)
  })

  it('is idempotent — no duplicate over-attribution item the same month', async () => {
    await runReconciliation(t.db)
    const rows = await t.client<{ count: string }[]>`
      SELECT COUNT(*)::text AS count FROM inbox_item
      WHERE recipient_teammate_id = ${BOB}::uuid AND category = 'over-attribution'`
    expect(rows[0]!.count).toBe('1')
  })
})

describe('runAnalyticsPollReconciledOrgs — multi-org (slice 6)', () => {
  beforeAll(async () => {
    process.env.NUXT_ANTHROPIC_API_ENDPOINT = stubUrl
    process.env.NUXT_ANTHROPIC_KEY_ANTHROPIC_AAA = 'k-aaa' // org-AAA has a key
    delete process.env.NUXT_ANTHROPIC_KEY_ANTHROPIC_CCC // org-CCC has none
    // anthropic rows MUST carry a valid api_kind (mig 0063 CHECK). The legacy
    // analytics-poller uses the claude-code-admin client, so stamp that here.
    // external_org_id is CHECK-constrained lowercase (mig 0064), so the fixtures are
    // lowercase; the per-org `source` is derived from external_org_id, so the
    // assertions below use the lowercased ids too.
    await t.client.unsafe(`
      INSERT INTO provider_org (provider, external_org_id, display_name, reconciliation_mode, billing, api_kind, credential_secret_name) VALUES
        ('anthropic', 'org-aaa', 'Org AAA', 'reconciled', 'billed',  'claude-code-admin', 'anthropic-aaa'),
        ('anthropic', 'org-ccc', 'Org CCC', 'reconciled', 'tracked', 'claude-code-admin', 'anthropic-ccc'),
        ('anthropic', 'org-ind', 'Org IND', 'indicative', 'tracked', 'claude-code-admin', NULL);
    `)
  })
  afterAll(() => {
    delete process.env.NUXT_ANTHROPIC_API_ENDPOINT
    delete process.env.NUXT_ANTHROPIC_KEY_ANTHROPIC_AAA
  })

  it('polls reconciled orgs with a key, skips reconciled-without-key + indicative, stamps source per org', async () => {
    const res = await runAnalyticsPollReconciledOrgs(t.db, { startingAt: SPEND_DATE, endingAt: SPEND_DATE })
    expect(res.orgsConsidered).toBe(2) // only the two reconciled (indicative excluded)
    expect(res.orgsPolled).toBe(1) // AAA (has key)
    expect(res.orgsSkippedNoCredential).toBe(1) // CCC (no key)

    // priya now has a per-org row from org-aaa (source suffixed).
    const rows = await t.client<{ source: string }[]>`
      SELECT source FROM actual_spend
      WHERE teammate_id = ${priyaId}::uuid AND source = 'anthropic-analytics-api:org-aaa'
    `
    expect(rows.length).toBe(1)
  })

  it('POLLS an enterprise-analytics org into actual_spend (HIGH-A — bill-anchored parity)', async () => {
    // HIGH-A: enterprise-analytics orgs are now POLLED via the Enterprise client into
    // actual_spend, giving them the SAME bill-anchored coverage as the Admin path.
    await t.client.unsafe(`
      INSERT INTO provider_org (provider, external_org_id, display_name, reconciliation_mode, billing, api_kind, credential_secret_name) VALUES
        ('anthropic', 'org-ent', 'Org ENT', 'reconciled', 'tracked', 'enterprise-analytics', 'anthropic-ent')
    `)
    process.env.NUXT_ANTHROPIC_KEY_ANTHROPIC_ENT = 'k-ent' // enterprise org has an analytics key
    try {
      const res = await runAnalyticsPollReconciledOrgs(t.db, { startingAt: SPEND_DATE, endingAt: SPEND_DATE })
      const ent = res.perOrg.find((p) => p.externalOrgId === 'org-ent')
      expect(ent).toBeDefined()
      expect(ent!.polled).toBe(true)
      // 2 usage rows (priya + ghost) + 2 cost rows (priya token + priya web_search) = 4 considered.
      expect(ent!.result?.recordsTotal).toBe(4)
      // ghost usage row resolves to no teammate -> skipped (web_search cost is excluded
      // pre-resolution, so it does NOT count as a skipped-unknown-user).
      expect(ent!.result?.recordsSkippedUnknownUser).toBe(1)
      expect(ent!.result?.recordsUpserted).toBe(1) // priya's one (teammate, day) row

      // #142 per-surface observability: every fixture row is product claude_code,
      // so the ONE upserted row is the claude-code lane, nothing fell to
      // claude-other, and a first pull has nothing stale to prune.
      expect(ent!.result?.rowsByTool).toEqual({ 'claude-code': 1 })
      expect(ent!.result?.unknownProducts).toEqual({})
      expect(ent!.result?.staleRowsDeleted).toBe(0)
      // A routine run (no prune, no unknown products) leaves NO surface-adjusted audit trail.
      const audit = await t.client<{ count: string }[]>`
        SELECT COUNT(*)::text AS count FROM audit_event
        WHERE event_type = 'actual-spend-surface-adjusted'
          AND payload->>'source' = 'anthropic-analytics-api:org-ent'`
      expect(audit[0]!.count).toBe('0')

      // priya gets a per-org actual_spend row from org-ENT. Tokens come from the usage
      // report; cost_usd is the TOKEN cost ($0.25) ONLY — the $10.00 web_search row is
      // ORG-GRAIN and must NOT inflate her per-teammate spend.
      const rows = await t.client<{ input_tokens: string; output_tokens: string; cost_usd: string }[]>`
        SELECT input_tokens::text AS input_tokens, output_tokens::text AS output_tokens, cost_usd::text AS cost_usd
        FROM actual_spend
        WHERE teammate_id = ${priyaId}::uuid AND source = 'anthropic-analytics-api:org-ent'
      `
      expect(rows.length).toBe(1)
      expect(rows[0]!.input_tokens).toBe('5000') // Σ uncached_input_tokens
      expect(rows[0]!.output_tokens).toBe('3000') // Σ output_tokens
      expect(Number(rows[0]!.cost_usd)).toBeCloseTo(0.25, 6) // token cost only; web_search EXCLUDED
    } finally {
      delete process.env.NUXT_ANTHROPIC_KEY_ANTHROPIC_ENT
      await t.client.unsafe(
        `DELETE FROM actual_spend WHERE source = 'anthropic-analytics-api:org-ent'`,
      )
      await t.client.unsafe(`DELETE FROM provider_org WHERE external_org_id = 'org-ent'`)
    }
  })

  it('is a clean no-op when there are no reconciled orgs', async () => {
    await t.client.unsafe(`DELETE FROM provider_org WHERE external_org_id IN ('org-aaa','org-ccc','org-ind')`)
    const res = await runAnalyticsPollReconciledOrgs(t.db, { startingAt: SPEND_DATE, endingAt: SPEND_DATE })
    expect(res.orgsConsidered).toBe(0)
    expect(res.orgsPolled).toBe(0)
  })
})

// Suppress unused-symbol noise.
void projectId
