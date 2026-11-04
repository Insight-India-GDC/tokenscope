/*
 * Inbox dispatcher — category routing.
 *
 * Per docs/build/mvp-lite-epic.md §Epic 3 EVS: "Inbox dispatcher utility
 * unit tests pass for category routing." Routing rules:
 *   over-budget        → project's cost-owning-unit teammates (manager pattern)
 *   sync-conflict      → admin (lena.park)
 *   structural-conflict → admin
 *   connector-health   → admin
 *   velocity-warning + untagged-backlog → recipient hint required
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { eq } from 'drizzle-orm'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'
import { dispatchInbox } from '../../../server/notifications/dispatch'
import * as schema from '../../../drizzle/schema'

let t: TestDb

beforeAll(async () => {
  t = await startTestDb()

  // Minimal seed: region + 1 BU + 1 admin teammate + 2 manager teammates +
  // 1 project owned by the BU.
  const [region] = await t.db
    .insert(schema.region)
    .values({ code: 'apac-disp', displayName: 'APAC' })
    .returning()
  const [bu] = await t.db
    .insert(schema.orgUnit)
    .values({
      regionId: region!.id,
      path: 'apac.disp.bu',
      code: 'disp-bu',
      displayName: 'Disp BU',
      unitType: 'bu',
      isCostOwningUnit: true,
    })
    .returning()
  await t.db
    .insert(schema.teammate)
    .values([
      {
        entraOid: 'oid-admin-disp',
        email: 'lena.park@example.com',
        role: 'admin', // resolveAdmins routes by durable role now, not email
        regionId: region!.id,
        orgUnitId: bu!.id,
      },
      {
        entraOid: 'oid-mgr-1',
        email: 'mgr1@example.com',
        regionId: region!.id,
        orgUnitId: bu!.id,
      },
      {
        entraOid: 'oid-mgr-2',
        email: 'mgr2@example.com',
        regionId: region!.id,
        orgUnitId: bu!.id,
      },
    ])
    .returning()
  await t.db
    .insert(schema.project)
    .values({
      code: 'DISP-1',
      codeHash: 'h-disp-1',
      displayName: 'Disp 1',
      type: 'billable',
      regionId: region!.id,
      costOwningUnitId: bu!.id,
    })
}, 120_000)

afterAll(async () => {
  await stopTestDb(t)
}, 30_000)

describe('dispatchInbox', () => {
  it('over-budget falls back to CoU teammates when no contributors exist', async () => {
    // Post-convergence routing: over-budget targets actual contributors
    // first. With no attribution_record on DISP-1, the fallback
    // delivers to the CoU teammates so SOMEONE sees the alert.
    const [proj] = await t.db
      .select({ id: schema.project.id })
      .from(schema.project)
      .where(eq(schema.project.code, 'DISP-1'))
      .limit(1)

    const results = await dispatchInbox(t.db, {
      category: 'over-budget',
      subject: 'DISP-1 over budget',
      body: { overBy: 100 },
      relatedEntityKind: 'project',
      relatedEntityId: proj!.id,
    })
    // Fallback path — 3 teammates sit on the project CoU → 3 inbox rows.
    expect(results.length).toBe(3)
  })

  it('over-budget routes to ACTUAL contributors when attribution exists', async () => {
    // Post-convergence routing: when there are contributors, the alert
    // goes ONLY to them — not to peers in the same CoU who happened to
    // not contribute this month. This is the bug that motivated the
    // routing change: a developer with $0 spend on a project should not
    // receive a "you are $X over allocation" alert.
    const [proj] = await t.db
      .select({ id: schema.project.id })
      .from(schema.project)
      .where(eq(schema.project.code, 'DISP-1'))
      .limit(1)
    const [region] = await t.db
      .select({ id: schema.region.id })
      .from(schema.region)
      .where(eq(schema.region.code, 'apac-disp'))
      .limit(1)
    const [bu] = await t.db
      .select({ id: schema.orgUnit.id })
      .from(schema.orgUnit)
      .where(eq(schema.orgUnit.code, 'disp-bu'))
      .limit(1)
    const [mgr1] = await t.db
      .select({ id: schema.teammate.id })
      .from(schema.teammate)
      .where(eq(schema.teammate.email, 'mgr1@example.com'))
      .limit(1)
    const [rc] = await t.db
      .select({ id: schema.rateCard.id, version: schema.rateCard.version })
      .from(schema.rateCard)
      .limit(1)

    // mgr1 emits one attribution_record this month — they become the
    // sole contributor.
    const sessionId = '00000000-0000-0000-0000-0000000d15a1'
    await t.db.insert(schema.instanceAttestation).values({
      instanceId: sessionId,
      principalOid: 'oid-mgr1-contrib',
      teammateId: mgr1!.id,
      projectCodeHash: 'h-disp-contrib',
      rawProjectCode: 'DISP-1',
      tool: 'claude-code',
      sessionTokenHash: 'tok-disp-contrib',
      tsStart: new Date(),
      regionId: region!.id,
      orgUnitId: bu!.id,
      costOwningUnitId: bu!.id,
    })
    await t.db.insert(schema.attributionRecord).values({
      instanceId: sessionId,
      teammateId: mgr1!.id,
      projectId: proj!.id,
      regionId: region!.id,
      orgUnitId: bu!.id,
      costOwningUnitId: bu!.id,
      tool: 'claude-code',
      model: 'claude-opus-4-1',
      tokenType: 'output',
      tokens: 1000n,
      costUsd: '10.00',
      rateCardId: rc!.id,
      rateCardVersion: rc!.version,
      fidelityTier: 'tier-1',
      costBasis: 'estimated',
      tsEvent: new Date(),
    })

    const results = await dispatchInbox(t.db, {
      category: 'over-budget',
      subject: 'DISP-1 contributor-routed alert',
      body: { overBy: 50 },
      relatedEntityKind: 'project',
      relatedEntityId: proj!.id,
    })
    // mgr1 is the ONLY contributor → exactly 1 row, addressed to mgr1.
    expect(results.length).toBe(1)
    expect(results[0]!.recipientTeammateId).toBe(mgr1!.id)
  })

  it('a DEACTIVATED contributor is not told the project code or its spend', async () => {
    /*
     * The first pass at this added `is_active` to the FALLBACK roster only —
     * the least-used branch — while contributors, PMs and BU owners still
     * resolved without consulting the teammate row. Those are the paths that
     * actually fire. A budget alert names a project code and its spend, so a
     * deactivated person kept receiving both.
     *
     * mgr1 is the sole contributor from the case above; deactivating them must
     * empty the audience rather than fall through to the CoU roster, because
     * the contributor branch matched and simply has no ACTIVE members.
     */
    const [proj] = await t.db
      .select({ id: schema.project.id })
      .from(schema.project)
      .where(eq(schema.project.code, 'DISP-1'))
      .limit(1)
    const [mgr1] = await t.db
      .select({ id: schema.teammate.id })
      .from(schema.teammate)
      .where(eq(schema.teammate.email, 'mgr1@example.com'))
      .limit(1)

    await t.db
      .update(schema.teammate)
      .set({ isActive: false })
      .where(eq(schema.teammate.id, mgr1!.id))
    try {
      const results = await dispatchInbox(t.db, {
        category: 'over-budget',
        subject: 'DISP-1 alert after deactivation',
        body: { overBy: 50 },
        relatedEntityKind: 'project',
        relatedEntityId: proj!.id,
      })
      /*
       * The WHOLE result, not just mgr1's absence. mgr1 is DISP-1's only
       * responsible party, so once deactivated the correct outcome is nobody.
       * Asserting only `not.toContain(mgr1)` also passes when the recipient
       * resolver treats "matched, all inactive" as "never matched" and fans the
       * alert out to the cost-owning unit instead — a WORSE bug than the one
       * this test guards, and invisible to a containment assertion.
       */
      expect(
        results.map((r) => r.recipientTeammateId),
        'deactivating the only responsible party fanned the alert elsewhere',
      ).toEqual([])
    } finally {
      await t.db
        .update(schema.teammate)
        .set({ isActive: true })
        .where(eq(schema.teammate.id, mgr1!.id))
    }
  })

  it('a deactivated PROJECT MANAGER does not fan the alert out to the whole BU', async () => {
    /*
     * The PM branch, which the contributor case above cannot reach. Its own
     * project, with NO contributors and no CoU owner, so the assigned manager is
     * the ONLY responsible party — the exact shape where filtering activity
     * inside the branch query turns "matched, but inactive" into "never
     * matched", and the fallback hands a project code and its spend to every
     * active teammate in the Business Unit.
     */
    const [region] = await t.db
      .select({ id: schema.region.id })
      .from(schema.region)
      .where(eq(schema.region.code, 'apac-disp'))
      .limit(1)
    const [bu] = await t.db
      .select({ id: schema.orgUnit.id })
      .from(schema.orgUnit)
      .where(eq(schema.orgUnit.code, 'disp-bu'))
      .limit(1)
    const [pm] = await t.db
      .insert(schema.teammate)
      .values({
        entraOid: 'oid-pm-only',
        email: 'pm.only@example.com',
        regionId: region!.id,
        orgUnitId: bu!.id,
      })
      .returning()
    const [proj] = await t.db
      .insert(schema.project)
      .values({
        code: 'DISP-PM',
        codeHash: 'h-disp-pm',
        displayName: 'Disp PM-only',
        type: 'billable',
        regionId: region!.id,
        costOwningUnitId: bu!.id,
      })
      .returning()
    await t.db.insert(schema.projectAssignment).values({
      projectId: proj!.id,
      teammateId: pm!.id,
      role: 'manager',
      effective: '[2020-01-01T00:00:00+00,)',
    })

    // Active first: proves the PM really is the resolved recipient, so the
    // empty result below is deactivation and not a mis-seeded fixture.
    const before = await dispatchInbox(t.db, {
      category: 'over-budget',
      subject: 'DISP-PM over budget',
      body: { overBy: 10 },
      relatedEntityKind: 'project',
      relatedEntityId: proj!.id,
    })
    expect(before.map((r) => r.recipientTeammateId)).toEqual([pm!.id])

    await t.db
      .update(schema.teammate)
      .set({ isActive: false })
      .where(eq(schema.teammate.id, pm!.id))

    const after = await dispatchInbox(t.db, {
      category: 'over-budget',
      subject: 'DISP-PM alert after the PM is deactivated',
      body: { overBy: 10 },
      relatedEntityKind: 'project',
      relatedEntityId: proj!.id,
    })
    expect(
      after.map((r) => r.recipientTeammateId),
      'deactivating the only PM fanned the alert out to the Business Unit',
    ).toEqual([])
  })

  it("sync-conflict on a project routes to that region's admin", async () => {
    // Region-scoped routing: the conflict's project (DISP-1) is in region
    // apac-disp, so the dispatcher derives that region and routes to its admin
    // (lena). No platform-admin are seeded here, so lena is the
    // sole recipient. (The cross-region roles + the underivable fail-open path
    // are covered in region-scoped-admins.test.ts.)
    const [proj] = await t.db
      .select({ id: schema.project.id })
      .from(schema.project)
      .where(eq(schema.project.code, 'DISP-1'))
      .limit(1)

    const results = await dispatchInbox(t.db, {
      category: 'sync-conflict',
      subject: 'Pathway conflict on DISP-1',
      body: { connector: 'pathway-apac', target: 'project' },
      relatedEntityKind: 'project',
      relatedEntityId: proj!.id,
    })
    expect(results.length).toBe(1)
    const [admin] = await t.db
      .select({ id: schema.teammate.id })
      .from(schema.teammate)
      .where(eq(schema.teammate.email, 'lena.park@example.com'))
      .limit(1)
    expect(results[0]!.recipientTeammateId).toBe(admin!.id)
  })

  it('velocity-warning without recipientHint returns no rows', async () => {
    const results = await dispatchInbox(t.db, {
      category: 'velocity-warning',
      subject: 'velocity over threshold',
      body: {},
    })
    expect(results).toEqual([])
  })

  it('velocity-warning with recipientHint creates one row', async () => {
    const [dev] = await t.db
      .select({ id: schema.teammate.id })
      .from(schema.teammate)
      .where(eq(schema.teammate.email, 'mgr1@example.com'))
      .limit(1)
    const results = await dispatchInbox(t.db, {
      category: 'velocity-warning',
      subject: 'velocity over threshold',
      body: {},
      recipientTeammateIdHint: dev!.id,
    })
    expect(results.length).toBe(1)
    expect(results[0]!.recipientTeammateId).toBe(dev!.id)
  })

  it('defaults severity per category', async () => {
    // over-budget defaults to 'attention'; velocity-warning to 'info'.
    const [proj] = await t.db
      .select({ id: schema.project.id })
      .from(schema.project)
      .where(eq(schema.project.code, 'DISP-1'))
      .limit(1)
    const obResults = await dispatchInbox(t.db, {
      category: 'over-budget',
      subject: 'sev-default test',
      body: {},
      relatedEntityKind: 'project',
      relatedEntityId: proj!.id,
    })
    expect(obResults.length).toBeGreaterThan(0)
    const [row] = await t.db
      .select({ severity: schema.inboxItem.severity })
      .from(schema.inboxItem)
      .where(eq(schema.inboxItem.id, obResults[0]!.inboxItemId))
      .limit(1)
    expect(row!.severity).toBe('attention')
  })
})
