// @vitest-environment node
/*
 * runBudgetAlert — over-budget producer integration test.
 *
 * Why this exists: see server/workers/budget-alert.ts header comment.
 * Validates the producer's contract end-to-end against a real testcontainers
 * Postgres so we exercise the same SQL shape the homepage uses.
 *
 * Pattern matches tests/integration/inbox/endpoints.test.ts: one
 * `startTestDb` shared across tests in the file, each case using a fresh
 * project code to isolate state.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { randomUUID } from 'node:crypto'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'
import { runBudgetAlert } from '../../../server/workers/budget-alert'
import { fetchProjectAllocations } from '../../../server/usage/consumption'
import * as schema from '../../../drizzle/schema'

let t: TestDb
let regionId: string
let buId: string
let priyaId: string
let lenaId: string
let rateCardId: string
let rateCardVersion: number

// Fixed "now" so every test runs against a known month-start window. May
// 2026 is consistent with the rest of the test corpus.
const NOW = new Date('2026-05-15T12:00:00Z')
const MONTH_START_ISO = '2026-05-01T00:00:00.000Z'

async function newAuditId(): Promise<string> {
  const [e] = await t.db
    .insert(schema.auditEvent)
    .values({
      eventType: 'allocation-created',
      actorTeammateId: priyaId,
      subjectKind: 'project',
      payload: { test: true },
    })
    .returning({ id: schema.auditEvent.id })
  return e!.id
}

async function createProject(code: string): Promise<string> {
  const [p] = await t.db
    .insert(schema.project)
    .values({
      code,
      codeHash: `h-${code.toLowerCase()}`,
      displayName: `Project ${code}`,
      type: 'billable',
      regionId,
      costOwningUnitId: buId,
    })
    .returning({ id: schema.project.id })
  return p!.id
}

async function createBaselineAllocation(projectId: string, budgetUsd: string): Promise<void> {
  await t.db.insert(schema.allocation).values({
    scopeType: 'project',
    scopeId: projectId,
    budgetUsd,
    effective: '[2026-05-01T00:00:00+00,2026-06-01T00:00:00+00)',
    allocationKind: 'baseline',
    auditEventId: await newAuditId(),
  })
}

async function recordSpend(
  projectId: string,
  costUsd: string,
  tsEvent: Date,
  teammateId: string = priyaId,
  identityState?: string,
): Promise<void> {
  const sessionId = randomUUID()
  await t.db.insert(schema.instanceAttestation).values({
    instanceId: sessionId,
    principalOid: `oid-${sessionId}`,
    teammateId,
    projectCodeHash: `h-spend-${sessionId.slice(0, 8)}`,
    rawProjectCode: 'SPEND',
    tool: 'claude-code',
    sessionTokenHash: `tok-${sessionId}`,
    tsStart: tsEvent,
    regionId,
    orgUnitId: buId,
    costOwningUnitId: buId,
  })
  await t.db.insert(schema.attributionRecord).values({
    instanceId: sessionId,
    teammateId,
    projectId,
    regionId,
    orgUnitId: buId,
    costOwningUnitId: buId,
    tool: 'claude-code',
    model: 'claude-opus-4-1',
    tokenType: 'output',
    tokens: 1000n,
    costUsd,
    rateCardId,
    rateCardVersion,
    fidelityTier: 'tier-1',
    costBasis: 'estimated',
    identityState,
    tsEvent,
  })
}

/**
 * Copilot §A usage: lands in unaccounted_usage (the API-OTel gap), NOT in
 * attribution_record — native Copilot OTLP is default-off. This is the lane the
 * worker was blind to before it read v_complete_usage.
 */
async function recordCopilotUsage(
  projectId: string,
  costUsd: string,
  day: string,
  teammateId: string = priyaId,
): Promise<void> {
  await t.db.insert(schema.unaccountedUsage).values({
    teammateId,
    regionId,
    orgUnitId: buId,
    projectId,
    day,
    tool: 'copilot-cli',
    costUsd,
    tokens: 0n,
  })
}

beforeAll(async () => {
  t = await startTestDb()

  const [region] = await t.db
    .insert(schema.region)
    .values({ code: 'apac-ba', displayName: 'APAC' })
    .returning()
  regionId = region!.id

  const [bu] = await t.db
    .insert(schema.orgUnit)
    .values({
      regionId,
      path: 'apac.svc',
      code: 'svc',
      displayName: 'Services',
      unitType: 'bu',
    })
    .returning()
  buId = bu!.id

  const [priya] = await t.db
    .insert(schema.teammate)
    .values({
      entraOid: 'oid-priya-ba',
      email: 'priya.ba@example.com',
      regionId,
      orgUnitId: buId,
    })
    .returning()
  priyaId = priya!.id

  // Second teammate in the same org_unit. Under the post-convergence
  // routing rule (resolveOverBudgetRecipients), over-budget items go
  // to ACTUAL contributors first — teammates with at least one
  // attribution_record on the project this month. So lena receives an
  // alert ONLY when the test inserts a spend row attributed to her.
  // The "happy path" test below does exactly that (priya + lena both
  // record spend → both receive the alert).
  const [lena] = await t.db
    .insert(schema.teammate)
    .values({
      entraOid: 'oid-lena-ba',
      email: 'lena.ba@example.com',
      regionId,
      orgUnitId: buId,
    })
    .returning()
  lenaId = lena!.id

  const [rc] = await t.db
    .select({ id: schema.rateCard.id, version: schema.rateCard.version })
    .from(schema.rateCard)
    .limit(1)
  rateCardId = rc!.id
  rateCardVersion = rc!.version
}, 60_000)

afterAll(async () => {
  await stopTestDb(t)
}, 30_000)

describe('runBudgetAlert', () => {
  it('dispatches an over-budget item with the drawer body shape when spend > cap', async () => {
    const projectId = await createProject('BA-OVER')
    await createBaselineAllocation(projectId, '100.00')
    // Two records summing to $150 (over $100 cap by $50). One from
    // priya, one from lena — both are contributors, so the dispatcher
    // emits the alert to both (the same fan-out shape as the seed:
    // multiple devs on the same overage).
    await recordSpend(projectId, '60.00', new Date('2026-05-10T10:00:00Z'), priyaId)
    await recordSpend(projectId, '90.00', new Date('2026-05-12T10:00:00Z'), lenaId)

    const result = await runBudgetAlert(t.db, { now: NOW })
    expect(result.alertsDispatched).toBeGreaterThanOrEqual(1)

    const rows = await t.client<
      {
        recipient_teammate_id: string
        category: string
        subject: string
        body: {
          project: string
          usedUsd: number
          capUsd: number
          overBy: number
          otelPct: number
          anthroPct: number
        }
      }[]
    >`
      SELECT recipient_teammate_id::text AS recipient_teammate_id,
             category, subject, body::jsonb AS body
        FROM inbox_item
       WHERE related_entity_id = ${projectId}::uuid
         AND category = 'over-budget'
         AND created_at >= ${MONTH_START_ISO}::timestamptz
    `
    // Dispatcher routes to ACTUAL contributors — both priya and lena
    // emitted attribution_record above, so both receive the alert.
    expect(rows.length).toBe(2)
    const sample = rows[0]!
    expect(sample.category).toBe('over-budget')
    expect(sample.subject).toContain('BA-OVER')
    expect(sample.subject).toContain('$50')
    expect(sample.body.project).toBe('BA-OVER')
    expect(sample.body.usedUsd).toBe(150)
    expect(sample.body.capUsd).toBe(100)
    expect(sample.body.overBy).toBe(50)
    // Provenance: this project's $150 is ALL arm 1 (attribution_record), so the
    // split really is 1/0 — but that is a property of THIS fixture, not a
    // constant. The two cases below move it.
    expect(sample.body.otelPct).toBe(1)
    expect(sample.body.anthroPct).toBe(0)
  })

  /*
   * ── THE "HOW WE KNOW" SPLIT ───────────────────────────────────────────────
   * `otelPct`/`anthroPct` are rendered to a PM in DrawerBodyOverBudget as the
   * provenance of the figure that paged them. They used to be hard-coded 1.0/0.0
   * and the suite pinned exactly those constants — so every assertion on them
   * passed no matter what the worker computed, including the hard-coded version.
   * The two cases below are the ones that can tell the difference: an alert whose
   * spend is entirely reconciled, and one that is genuinely mixed.
   */
  it('PROVENANCE: an arm-2-only overage reports anthroPct = 1, otelPct = 0', async () => {
    const projectId = await createProject('BA-PROV-RECON')
    await createBaselineAllocation(projectId, '40.00')
    // No attribution_record at all: every dollar arrives through reconciliation.
    // The day is unique per (teammate, tool) across this file — unaccounted_usage
    // is one row per person-day-tool.
    await recordCopilotUsage(projectId, '90.00', '2026-05-06')

    await runBudgetAlert(t.db, { now: NOW })
    const [row] = await t.client<{ body: { usedUsd: number; otelPct: number; anthroPct: number } }[]>`
      SELECT body::jsonb AS body FROM inbox_item
       WHERE category = 'over-budget' AND related_entity_id = ${projectId}::uuid LIMIT 1`
    expect(row!.body.usedUsd).toBeCloseTo(90, 6)
    expect(row!.body.otelPct).toBeCloseTo(0, 6)
    expect(row!.body.anthroPct).toBeCloseTo(1, 6)
  })

  it('PROVENANCE: a MIXED overage reports the real ratio, and both legs sum to 1', async () => {
    const projectId = await createProject('BA-PROV-MIXED')
    await createBaselineAllocation(projectId, '50.00')
    // $30 emitted + $70 reconciled = $100 against a $50 cap. Deliberately not a
    // half-and-half split: 0.5/0.5 is the one ratio a swapped pair would survive.
    await recordSpend(projectId, '30.00', new Date('2026-05-09T10:00:00Z'))
    await recordCopilotUsage(projectId, '70.00', '2026-05-07')

    await runBudgetAlert(t.db, { now: NOW })
    const [row] = await t.client<{ body: { usedUsd: number; overBy: number; otelPct: number; anthroPct: number } }[]>`
      SELECT body::jsonb AS body FROM inbox_item
       WHERE category = 'over-budget' AND related_entity_id = ${projectId}::uuid LIMIT 1`
    expect(row!.body.usedUsd).toBeCloseTo(100, 6)
    expect(row!.body.overBy).toBeCloseTo(50, 6)
    expect(row!.body.otelPct).toBeCloseTo(0.3, 6)
    expect(row!.body.anthroPct).toBeCloseTo(0.7, 6)
    // The two legs are the WHOLE of the figure — arm 3 can never be in a project
    // total, so a third share would mean the headline had grown a lane.
    expect(row!.body.otelPct + row!.body.anthroPct).toBeCloseTo(1, 6)
  })

  it('PROVENANCE: provisional spend is excluded from the total AND from both shares', async () => {
    /*
     * The named `excludeProvisional` option and the provenance split are two
     * features of one figure, and they have to agree: if provisional spend were
     * dropped from `usedUsd` but left in `otelUsd`, the shares would exceed 1 and
     * the drawer would tell a PM that 133% of their overage was telemetry.
     */
    const projectId = await createProject('BA-PROV-EXCLUDED')
    await createBaselineAllocation(projectId, '40.00')
    await recordSpend(projectId, '60.00', new Date('2026-05-09T10:00:00Z'), priyaId)
    await recordSpend(projectId, '25.00', new Date('2026-05-10T10:00:00Z'), lenaId, 'provisional')

    await runBudgetAlert(t.db, { now: NOW })
    const [row] = await t.client<{ body: { usedUsd: number; otelPct: number; anthroPct: number } }[]>`
      SELECT body::jsonb AS body FROM inbox_item
       WHERE category = 'over-budget' AND related_entity_id = ${projectId}::uuid LIMIT 1`
    // $60 confirmed only — the $25 provisional is NOT in the figure that paged.
    expect(row!.body.usedUsd).toBeCloseTo(60, 6)
    expect(row!.body.otelPct).toBeCloseTo(1, 6)
    expect(row!.body.anthroPct).toBeCloseTo(0, 6)
    expect(row!.body.otelPct + row!.body.anthroPct).toBeCloseTo(1, 6)
  })

  it('MONTH TO DATE: spend dated LATER THIS MONTH does not page a PM today', async () => {
    /*
     * The alert's window ends at NOW, not at the month end. It used to be the
     * whole calendar month, so a row dated 2026-05-20 counted towards an alert
     * computed on 2026-05-15 — paging a PM for an overage that has not happened,
     * against a figure the project page (same window, same bug) agreed with.
     */
    const projectId = await createProject('BA-FUTURE')
    await createBaselineAllocation(projectId, '50.00')
    await recordSpend(projectId, '30.00', new Date('2026-05-10T10:00:00Z'))
    // Five days after `NOW`, still inside May.
    await recordSpend(projectId, '80.00', new Date('2026-05-20T10:00:00Z'))

    await runBudgetAlert(t.db, { now: NOW })
    const [row] = await t.client<{ c: string }[]>`
      SELECT COUNT(*)::text AS c FROM inbox_item
       WHERE category = 'over-budget' AND related_entity_id = ${projectId}::uuid`
    expect(Number(row!.c)).toBe(0)

    // Run the same worker with a clock PAST that row and it fires — proving the
    // row is real and the silence above was the window, not a missing fixture.
    await runBudgetAlert(t.db, { now: new Date('2026-05-25T12:00:00Z') })
    const [after] = await t.client<{ body: { usedUsd: number } }[]>`
      SELECT body::jsonb AS body FROM inbox_item
       WHERE category = 'over-budget' AND related_entity_id = ${projectId}::uuid LIMIT 1`
    expect(after!.body.usedUsd).toBeCloseTo(110, 6)
  })

  it('routes to budget-RESPONSIBLE parties (PM + CC owner) even with $0 contribution', async () => {
    // Honourable-links routing (mig 0048): the project's currently-
    // effective PM and the lead CC's active owner can ACT on the alert,
    // so they receive it regardless of their own spend.
    const projectId = await createProject('BA-RESP')
    await createBaselineAllocation(projectId, '100.00')
    const [pm] = await t.db
      .insert(schema.teammate)
      .values({ entraOid: 'oid-pm-ba', email: 'pm.ba@example.com', regionId, orgUnitId: buId })
      .returning()
    const [owner] = await t.db
      .insert(schema.teammate)
      .values({ entraOid: 'oid-owner-ba', email: 'owner.ba@example.com', regionId, orgUnitId: buId })
      .returning()
    await t.db.insert(schema.projectAssignment).values({
      projectId,
      teammateId: pm!.id,
      effective: '[2026-04-01T00:00:00+00,)',
      role: 'manager',
    })
    await t.db.insert(schema.couOwner).values({ orgUnitId: buId, teammateId: owner!.id })
    // Only priya spends; the PM and owner contribute $0.
    await recordSpend(projectId, '150.00', new Date('2026-05-10T10:00:00Z'), priyaId)

    await runBudgetAlert(t.db, { now: NOW })

    const rows = await t.client<{ recipient_teammate_id: string }[]>`
      SELECT recipient_teammate_id::text AS recipient_teammate_id
        FROM inbox_item
       WHERE related_entity_id = ${projectId}::uuid AND category = 'over-budget'
    `
    const recipients = rows.map((r) => r.recipient_teammate_id)
    expect(recipients).toContain(pm!.id) // $0-spend PM: budget is their job
    expect(recipients).toContain(owner!.id) // $0-spend CC owner: their P&L
    expect(recipients).toContain(priyaId) // contributor, for awareness
    // Revoke the ownership so later fixtures stay clean.
    await t.client`
      UPDATE cou_owner SET revoked_at = now(), revoked_by = ${owner!.id}::uuid
      WHERE teammate_id = ${owner!.id}::uuid AND revoked_at IS NULL
    `
  })

  it('skips projects whose spend is under cap', async () => {
    const projectId = await createProject('BA-UNDER')
    await createBaselineAllocation(projectId, '100.00')
    await recordSpend(projectId, '50.00', new Date('2026-05-10T10:00:00Z'))

    const before = Number(
      (
        await t.client<{ c: string }[]>`
          SELECT COUNT(*)::text AS c FROM inbox_item
           WHERE related_entity_id = ${projectId}::uuid
        `
      )[0]!.c,
    )

    const result = await runBudgetAlert(t.db, { now: NOW })

    const after = Number(
      (
        await t.client<{ c: string }[]>`
          SELECT COUNT(*)::text AS c FROM inbox_item
           WHERE related_entity_id = ${projectId}::uuid
        `
      )[0]!.c,
    )
    expect(after).toBe(before)
    // result.alertsDispatched might be >0 for OTHER over-budget projects
    // in this DB; assert only that THIS project produced nothing.
    expect(result).toBeDefined()
  })

  it('is idempotent: a second run does not duplicate the alert', async () => {
    const projectId = await createProject('BA-IDEM')
    await createBaselineAllocation(projectId, '50.00')
    await recordSpend(projectId, '80.00', new Date('2026-05-10T10:00:00Z'))

    const first = await runBudgetAlert(t.db, { now: NOW })
    const firstRows = await t.client<{ c: string }[]>`
      SELECT COUNT(*)::text AS c FROM inbox_item
       WHERE related_entity_id = ${projectId}::uuid AND category = 'over-budget'
    `
    const firstCount = Number(firstRows[0]!.c)
    expect(firstCount).toBeGreaterThanOrEqual(1)

    const second = await runBudgetAlert(t.db, { now: NOW })
    const secondRows = await t.client<{ c: string }[]>`
      SELECT COUNT(*)::text AS c FROM inbox_item
       WHERE related_entity_id = ${projectId}::uuid AND category = 'over-budget'
    `
    const secondCount = Number(secondRows[0]!.c)
    expect(secondCount).toBe(firstCount)
    // skippedExisting on the second run must include this project.
    expect(second.skippedExisting).toBeGreaterThanOrEqual(1)
    // Silence unused-warning on `first` while still asserting it ran.
    expect(first.projectsScanned).toBeGreaterThanOrEqual(1)
  })

  it('skips projects with no allocation (cap = 0 means no over-budget concept)', async () => {
    const projectId = await createProject('BA-NOALLOC')
    // NO allocation row — just spend.
    await recordSpend(projectId, '500.00', new Date('2026-05-10T10:00:00Z'))

    await runBudgetAlert(t.db, { now: NOW })

    const rows = await t.client<{ c: string }[]>`
      SELECT COUNT(*)::text AS c FROM inbox_item
       WHERE related_entity_id = ${projectId}::uuid
         AND category = 'over-budget'
    `
    expect(Number(rows[0]!.c)).toBe(0)
  })

  it('excludes PROVISIONAL spend from the cap (provisional-only over cap -> no page)', async () => {
    // Emit-on-install provisional usage must never drive a budget page. The
    // project is $150 of provisional spend over a $100 cap, but provisional is
    // excluded from used_usd -> used=$0 -> no over-budget item.
    const projectId = await createProject('BA-PROV')
    await createBaselineAllocation(projectId, '100.00')
    await recordSpend(projectId, '150.00', new Date('2026-05-10T10:00:00Z'), priyaId, 'provisional')

    await runBudgetAlert(t.db, { now: NOW })

    const rows = await t.client<{ c: string }[]>`
      SELECT COUNT(*)::text AS c FROM inbox_item
       WHERE related_entity_id = ${projectId}::uuid AND category = 'over-budget'
    `
    expect(Number(rows[0]!.c)).toBe(0)
  })

  it('counts CONFIRMED spend toward the cap (alert fires)', async () => {
    // The same overage but confirmed identity counts -> the page fires. (NULL
    // legacy spend is already covered by the happy-path test above.)
    const projectId = await createProject('BA-CONF')
    await createBaselineAllocation(projectId, '100.00')
    await recordSpend(projectId, '150.00', new Date('2026-05-10T10:00:00Z'), priyaId, 'confirmed')

    await runBudgetAlert(t.db, { now: NOW })

    const rows = await t.client<{ c: string }[]>`
      SELECT COUNT(*)::text AS c FROM inbox_item
       WHERE related_entity_id = ${projectId}::uuid AND category = 'over-budget'
    `
    expect(Number(rows[0]!.c)).toBeGreaterThanOrEqual(1)
  })

  it('COPILOT: a project over cap purely on unaccounted (Copilot) usage FIRES', async () => {
    // The headline bug this fix closes. Copilot per-user spend never reaches
    // attribution_record, so the old worker read $0 for a Copilot-only project
    // and stayed silent while the dev's own usage page showed it over budget.
    const projectId = await createProject('BA-COPILOT')
    await createBaselineAllocation(projectId, '50.00')
    await recordCopilotUsage(projectId, '80.00', '2026-05-10')

    const res = await runBudgetAlert(t.db, { now: NOW })
    expect(res.alertsDispatched).toBeGreaterThanOrEqual(1)
    const rows = await t.client<{ c: string }[]>`
      SELECT COUNT(*)::text AS c FROM inbox_item
       WHERE category = 'over-budget' AND related_entity_id = ${projectId}::uuid`
    expect(Number(rows[0]!.c)).toBeGreaterThanOrEqual(1)
  })

  it('COPILOT: claude + copilot spend SUM against one cap (neither lane alone trips it)', async () => {
    // Tool-completeness, not just "copilot works": $30 claude + $30 copilot vs a
    // $50 cap must fire, though each lane alone is under.
    const projectId = await createProject('BA-MIXED')
    await createBaselineAllocation(projectId, '50.00')
    await recordSpend(projectId, '30.00', new Date('2026-05-09T10:00:00Z'))
    await recordCopilotUsage(projectId, '30.00', '2026-05-11')

    const res = await runBudgetAlert(t.db, { now: NOW })
    expect(res.alertsDispatched).toBeGreaterThanOrEqual(1)
    const rows = await t.client<{ c: string }[]>`
      SELECT COUNT(*)::text AS c FROM inbox_item
       WHERE category = 'over-budget' AND related_entity_id = ${projectId}::uuid`
    expect(Number(rows[0]!.c)).toBeGreaterThanOrEqual(1)
  })

  it('MID-MONTH TOP-UP in force counts toward the cap (not month-start containment)', async () => {
    // A top-up effective from mid-month does not CONTAIN month-start, so a
    // month-start cap missed it and the worker paged "over budget" against a cap
    // the PM had already raised. The cap is the budget in force at the run's now.
    const projectId = await createProject('BA-TOPUP')
    await createBaselineAllocation(projectId, '50.00')
    await t.db.insert(schema.allocation).values({
      scopeType: 'project',
      scopeId: projectId,
      budgetUsd: '100.00',
      effective: '[2026-05-14T00:00:00+00,2026-06-01T00:00:00+00)',
      allocationKind: 'top-up',
      auditEventId: await newAuditId(),
    })
    await recordSpend(projectId, '90.00', new Date('2026-05-10T10:00:00Z'))

    // 90 used vs 50 baseline + 100 top-up = 150 cap -> NOT over budget.
    const res = await runBudgetAlert(t.db, { now: NOW })
    const rows = await t.client<{ c: string }[]>`
      SELECT COUNT(*)::text AS c FROM inbox_item
       WHERE category = 'over-budget' AND related_entity_id = ${projectId}::uuid`
    expect(Number(rows[0]!.c)).toBe(0)
    expect(res).toBeDefined()
  })

  it('DISMISS STICKS: a dismissed alert is not re-paged on the next tick', async () => {
    // The guard used to count only OPEN ack_states, so dismissing an item stopped
    // it suppressing the next run — a still-over project re-paged its PM, CoU
    // owner and every contributor on EVERY tick for the rest of the month.
    const projectId = await createProject('BA-DISMISS')
    await createBaselineAllocation(projectId, '50.00')
    await recordSpend(projectId, '80.00', new Date('2026-05-10T10:00:00Z'))

    await runBudgetAlert(t.db, { now: NOW })
    const after1 = await t.client<{ c: string }[]>`
      SELECT COUNT(*)::text AS c FROM inbox_item
       WHERE category = 'over-budget' AND related_entity_id = ${projectId}::uuid`
    const initial = Number(after1[0]!.c)
    expect(initial).toBeGreaterThanOrEqual(1)

    // The recipient dismisses it; the project is still over budget.
    await t.client.unsafe(`
      UPDATE inbox_item SET ack_state = 'dismissed'
       WHERE category = 'over-budget' AND related_entity_id = '${projectId}'`)

    await runBudgetAlert(t.db, { now: NOW })
    const after2 = await t.client<{ c: string }[]>`
      SELECT COUNT(*)::text AS c FROM inbox_item
       WHERE category = 'over-budget' AND related_entity_id = ${projectId}::uuid`
    expect(Number(after2[0]!.c)).toBe(initial) // no new items
  })

  it('SUCCESSIVE BASELINES do not double the cap (only the one in force now counts)', async () => {
    // Baselines are non-overlapping but successive ones are allowed (change the
    // budget mid-month). Summing every baseline that merely OVERLAPS the month
    // would read a $50 budget as $100 and silently suppress a real page.
    const projectId = await createProject('BA-SUCCESSIVE')
    await t.db.insert(schema.allocation).values({
      scopeType: 'project',
      scopeId: projectId,
      budgetUsd: '50.00',
      effective: '[2026-05-01T00:00:00+00,2026-05-15T00:00:00+00)',
      allocationKind: 'baseline',
      auditEventId: await newAuditId(),
    })
    await t.db.insert(schema.allocation).values({
      scopeType: 'project',
      scopeId: projectId,
      budgetUsd: '50.00',
      effective: '[2026-05-15T00:00:00+00,2026-06-01T00:00:00+00)',
      allocationKind: 'baseline',
      auditEventId: await newAuditId(),
    })
    await recordSpend(projectId, '80.00', new Date('2026-05-10T10:00:00Z'))

    // Cap is the baseline in force now ($50), not $50+$50 — so $80 IS over.
    await runBudgetAlert(t.db, { now: NOW })
    const rows = await t.client<{ c: string }[]>`
      SELECT COUNT(*)::text AS c FROM inbox_item
       WHERE category = 'over-budget' AND related_entity_id = ${projectId}::uuid`
    expect(Number(rows[0]!.c)).toBeGreaterThanOrEqual(1)
  })

  it('MID-MONTH BASELINE: the cap is the budget the project page shows, baseline and top-up together', async () => {
    // A $1,000 baseline starting mid-month with a $25 top-up over the same
    // period. The project page reads $1,025 (fetchProjectAllocations at now);
    // a month-start cap dropped the baseline and kept the top-up, paging $30 of
    // spend against $25.
    const projectId = await createProject('BA-MIDBASE')
    for (const [kind, usd] of [['baseline', '1000.00'], ['top-up', '25.00']] as const) {
      await t.db.insert(schema.allocation).values({
        scopeType: 'project',
        scopeId: projectId,
        budgetUsd: usd,
        effective: '[2026-05-10T00:00:00+00,2026-06-01T00:00:00+00)',
        allocationKind: kind,
        auditEventId: await newAuditId(),
      })
    }
    await recordSpend(projectId, '30.00', new Date('2026-05-12T10:00:00Z'))
    const page = await fetchProjectAllocations(t.db, [projectId], NOW.toISOString())
    expect(page.get(projectId)).toBe(1025)

    await runBudgetAlert(t.db, { now: NOW })
    const quiet = await t.client<{ c: string }[]>`
      SELECT COUNT(*)::text AS c FROM inbox_item
       WHERE category = 'over-budget' AND related_entity_id = ${projectId}::uuid`
    expect(Number(quiet[0]!.c)).toBe(0)

    // Over the page's figure, it pages — against that figure.
    await recordSpend(projectId, '1000.00', new Date('2026-05-13T10:00:00Z'))
    await runBudgetAlert(t.db, { now: NOW })
    const [item] = await t.client<{ body: { capUsd: number } }[]>`
      SELECT body::jsonb AS body FROM inbox_item
       WHERE category = 'over-budget' AND related_entity_id = ${projectId}::uuid LIMIT 1`
    expect(item!.body.capUsd).toBe(1025)
  })

  it('AUDIENCE: the Copilot contributor who blew the budget is notified', async () => {
    // Slice 2 made the TRIGGER Copilot-complete; if the recipient lane still read
    // raw attribution_record, the one person who caused the overage would be the
    // only one not told. Trigger and audience must use the same lane.
    const projectId = await createProject('BA-AUDIENCE')
    await createBaselineAllocation(projectId, '50.00')
    await recordCopilotUsage(projectId, '90.00', '2026-05-12', priyaId)

    await runBudgetAlert(t.db, { now: NOW })
    const rows = await t.client<{ c: string }[]>`
      SELECT COUNT(*)::text AS c FROM inbox_item
       WHERE category = 'over-budget'
         AND related_entity_id = ${projectId}::uuid
         AND recipient_teammate_id = ${priyaId}::uuid`
    expect(Number(rows[0]!.c)).toBeGreaterThanOrEqual(1)
  })

  it('excludes burst-kind allocations from the cap', async () => {
    // Setup: baseline = $100, burst = $500 in same month. usedUsd = $150.
    // Burst-included cap would be $600 → no alert. Correct (burst-excluded)
    // cap is $100 → alert fires for $50 over. This is the same rule the
    // homepage uses (home.get.ts), so this test guards the parity contract.
    const projectId = await createProject('BA-BURST')
    await createBaselineAllocation(projectId, '100.00')
    await t.db.insert(schema.allocation).values({
      scopeType: 'project',
      scopeId: projectId,
      budgetUsd: '500.00',
      effective: '[2026-05-10T00:00:00+00,2026-05-20T00:00:00+00)',
      allocationKind: 'burst',
      auditEventId: await newAuditId(),
    })
    await recordSpend(projectId, '150.00', new Date('2026-05-12T10:00:00Z'))

    await runBudgetAlert(t.db, { now: NOW })

    const rows = await t.client<{ subject: string; body: { capUsd: number } }[]>`
      SELECT subject, body::jsonb AS body FROM inbox_item
       WHERE related_entity_id = ${projectId}::uuid
         AND category = 'over-budget'
    `
    expect(rows.length).toBeGreaterThanOrEqual(1)
    expect(rows[0]!.body.capUsd).toBe(100)
  })

  it('EXCLUDES ingest-only spend (non-Code Claude surfaces / copilot-agent) from every project budget — it can never carry a project_id (mig 0101, A3 design decision, §3.1 R1-M2)', async () => {
    /*
     * v_complete_usage's third (ingest-only) union arm hardcodes
     * `project_id = NULL` unconditionally — there is no code path by which
     * this money can ever be tagged to a project, however large. This mirrors
     * the velocity-watch test proving the OPPOSITE decision for the SAME arm
     * (untaggable provider-only spend is velocity-eligible but never
     * budget-eligible): both are independent tests of one owner decision.
     */
    const projectId = await createProject('BA-INGESTONLY')
    await createBaselineAllocation(projectId, '50.00')
    // A huge non-Code Claude spend for the same teammate/month — reaches §A via
    // arm 3 (v_complete_usage), but completeProjectSpend filters
    // `project_id IS NOT NULL`, so this can never attribute to ANY project.
    await t.db.insert(schema.actualSpend).values({
      teammateId: priyaId,
      date: '2026-05-12',
      tool: 'claude-ai',
      inputTokens: 0n,
      outputTokens: 0n,
      costUsd: '999.00',
      source: 'anthropic-analytics-api',
    })

    await runBudgetAlert(t.db, { now: NOW })
    const rows = await t.client<{ c: string }[]>`
      SELECT COUNT(*)::text AS c FROM inbox_item
       WHERE category = 'over-budget' AND related_entity_id = ${projectId}::uuid`
    expect(Number(rows[0]!.c)).toBe(0)
  })
})

