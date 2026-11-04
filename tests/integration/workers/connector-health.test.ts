// @vitest-environment node
/*
 * runConnectorHealth — pending sync_conflict rows → sync-conflict inbox
 * items.
 *
 * Per docs/build/mvp-lite-epic.md §Epic 9 + the MVP-Lite convergence
 * Wave 1 plan: the dispatch.ts category set declares sync-conflict and
 * a `sync_conflict` source table exists, but no producer was wired
 * through the MVP-Final epics. This test pins the contract for the
 * new producer (Wave 1c).
 *
 * We use direct DB inserts against testcontainers Postgres (per Epic 4
 * worker-test pattern in tests/integration/sessions/workers.test.ts).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'
import { runConnectorHealth } from '../../../server/workers/connector-health'
import * as schema from '../../../drizzle/schema'

let t: TestDb
let lenaId: string
let projId: string
// A cross-region role (platform-admin) — receives the region-less owed-bill aging
// alert. A region 'admin' (lena) does NOT, because that alert carries no related
// entity, so resolveAdmins routes to cross-region roles only (dispatch.ts).
let platformAdminId: string

beforeAll(async () => {
  t = await startTestDb()

  // Seed: APAC region + BU + admin (lena, the sync-conflict routing
  // target per dispatch.ts resolveAdmins) + project.
  const [region] = await t.db
    .insert(schema.region)
    .values({ code: 'apac-c', displayName: 'APAC' })
    .returning()
  const [bu] = await t.db
    .insert(schema.orgUnit)
    .values({
      regionId: region!.id,
      path: 'apac.c',
      code: 'c-bu',
      displayName: 'Connector BU',
      unitType: 'bu',
    })
    .returning()
  const [lena] = await t.db
    .insert(schema.teammate)
    .values({
      entraOid: 'oid-lena-c',
      email: 'lena.park@example.com',
      role: 'admin', // resolveAdmins routes by durable role now, not email
      regionId: region!.id,
      orgUnitId: bu!.id,
    })
    .returning()
  const [proj] = await t.db
    .insert(schema.project)
    .values({
      code: 'CH-1',
      codeHash: 'h-ch-1',
      displayName: 'Connector Health Test',
      type: 'billable',
      regionId: region!.id,
      costOwningUnitId: bu!.id,
    })
    .returning()

  const [pa] = await t.db
    .insert(schema.teammate)
    .values({
      entraOid: 'oid-pa-c',
      email: 'platform.admin@example.com',
      role: 'platform-admin', // cross-region role — receives region-less ops alerts
      regionId: region!.id,
      orgUnitId: bu!.id,
    })
    .returning()

  lenaId = lena!.id
  projId = proj!.id
  platformAdminId = pa!.id
}, 180_000)

afterAll(async () => {
  await stopTestDb(t)
}, 30_000)

async function clearInbox(): Promise<void> {
  await t.client.unsafe(`DELETE FROM inbox_item`)
}

async function clearSyncConflicts(): Promise<void> {
  await t.client.unsafe(`DELETE FROM sync_conflict`)
}

describe('runConnectorHealth (sync-conflict producer)', () => {
  it('emits one sync-conflict inbox_item from a pending sync_conflict row', async () => {
    await clearInbox()
    await clearSyncConflicts()

    await t.db.insert(schema.syncConflict).values({
      connectorId: 'Pathway · APAC',
      targetTable: 'project',
      targetPk: projId,
      manualRowSnapshot: { costOwningUnit: 'MED · Retail risk' },
      syncRowPayload: { costOwningUnit: 'MED · Risk Analytics' },
      resolution: 'pending',
    })

    const result = await runConnectorHealth(t.db)
    expect(result.pendingConflictsScanned).toBe(1)
    expect(result.alertsDispatched).toBe(1)
    expect(result.skippedExisting).toBe(0)

    const rows = await t.client<{
      category: string
      severity: string
      subject: string
      body: Record<string, unknown>
      related_entity_kind: string | null
      related_entity_id: string | null
    }[]>`
      SELECT category, severity, subject, body::jsonb AS body,
             related_entity_kind, related_entity_id::text AS related_entity_id
      FROM inbox_item
      WHERE recipient_teammate_id = ${lenaId}::uuid
    `
    expect(rows.length).toBe(1)
    const row = rows[0]!
    expect(row.category).toBe('sync-conflict')
    expect(row.severity).toBe('info')
    expect(row.subject).toContain('Pathway · APAC')
    expect(row.subject).toContain('Connector Health Test')
    expect(row.related_entity_kind).toBe('project')
    expect(row.related_entity_id).toBe(projId)
    // Drawer body contract (DrawerBodySyncConflict.vue): field/manual/sync/source.
    expect(row.body.field).toBe('Cost owning unit')
    expect(row.body.manual).toBe('MED · Retail risk')
    expect(row.body.sync).toBe('MED · Risk Analytics')
    expect(row.body.source).toBe('Pathway · APAC')
    // Traceability marker for idempotency:
    expect(typeof row.body.sync_conflict_id).toBe('string')
  })

  it('skips resolved rows (resolution != pending)', async () => {
    await clearInbox()
    await clearSyncConflicts()

    await t.db.insert(schema.syncConflict).values({
      connectorId: 'Pathway · APAC',
      targetTable: 'project',
      targetPk: projId,
      manualRowSnapshot: { costOwningUnit: 'A' },
      syncRowPayload: { costOwningUnit: 'B' },
      resolution: 'accepted',
    })

    const result = await runConnectorHealth(t.db)
    expect(result.pendingConflictsScanned).toBe(0)
    expect(result.alertsDispatched).toBe(0)

    const inboxCount = await t.client<{ count: string }[]>`
      SELECT COUNT(*)::text AS count FROM inbox_item
    `
    expect(Number(inboxCount[0]!.count)).toBe(0)
  })

  it('is idempotent: a second run does not re-dispatch the same conflict', async () => {
    await clearInbox()
    await clearSyncConflicts()

    await t.db.insert(schema.syncConflict).values({
      connectorId: 'Pathway · APAC',
      targetTable: 'project',
      targetPk: projId,
      manualRowSnapshot: { costOwningUnit: 'A' },
      syncRowPayload: { costOwningUnit: 'B' },
      resolution: 'pending',
    })

    const first = await runConnectorHealth(t.db)
    expect(first.alertsDispatched).toBe(1)

    const second = await runConnectorHealth(t.db)
    expect(second.alertsDispatched).toBe(0)
    expect(second.skippedExisting).toBe(1)

    // Scope to lena (the region admin): sync-conflict now also fans out to the
    // seeded cross-region platform-admin, so a global count double-counts. The
    // test's intent is "one item per conflict per recipient".
    const count = await t.client<{ count: string }[]>`
      SELECT COUNT(*)::text AS count FROM inbox_item
      WHERE category = 'sync-conflict' AND recipient_teammate_id = ${lenaId}::uuid
    `
    expect(Number(count[0]!.count)).toBe(1)
  })

  it('emits one inbox item per pending conflict (multiple conflicts)', async () => {
    await clearInbox()
    await clearSyncConflicts()

    // Second project for the second conflict so we can distinguish them.
    const [proj2] = await t.db
      .insert(schema.project)
      .values({
        code: 'CH-2',
        codeHash: 'h-ch-2',
        displayName: 'Connector Health Test 2',
        type: 'billable',
        regionId: (
          await t.client<{ id: string }[]>`SELECT id::text AS id FROM region LIMIT 1`
        )[0]!.id,
        costOwningUnitId: (
          await t.client<{ id: string }[]>`SELECT id::text AS id FROM org_unit LIMIT 1`
        )[0]!.id,
      })
      .returning()

    await t.db.insert(schema.syncConflict).values([
      {
        connectorId: 'Pathway · APAC',
        targetTable: 'project',
        targetPk: projId,
        manualRowSnapshot: { costOwningUnit: 'A' },
        syncRowPayload: { costOwningUnit: 'B' },
        resolution: 'pending',
      },
      {
        connectorId: 'Workday',
        targetTable: 'project',
        targetPk: proj2!.id,
        manualRowSnapshot: { displayName: 'Old' },
        syncRowPayload: { displayName: 'New' },
        resolution: 'pending',
      },
    ])

    const result = await runConnectorHealth(t.db)
    expect(result.pendingConflictsScanned).toBe(2)
    expect(result.alertsDispatched).toBe(2)

    // Scope to lena: the seeded cross-region platform-admin also receives a copy of
    // each, so a global subject list would carry 4 rows (2 conflicts × 2 admins).
    const rows = await t.client<{ subject: string }[]>`
      SELECT subject FROM inbox_item
      WHERE category = 'sync-conflict' AND recipient_teammate_id = ${lenaId}::uuid
      ORDER BY subject
    `
    expect(rows.length).toBe(2)
    expect(rows.some((r) => r.subject.includes('Pathway · APAC'))).toBe(true)
    expect(rows.some((r) => r.subject.includes('Workday'))).toBe(true)
  })
})

describe('runConnectorHealth (owed-bill aging alert, mig 0066)', () => {
  async function clearPending(): Promise<void> {
    await t.client.unsafe(`DELETE FROM pending_placement`)
  }

  // Insert a pending_placement row with an explicit first_seen_at / placed_at so we
  // can age it past the 7-day grace (enqueueOwedBill always stamps now()). placed_at
  // is now() when placed, NULL otherwise — bound as a nullable timestamptz literal.
  async function seedPending(
    email: string,
    ageDays: number,
    placed: boolean,
  ): Promise<void> {
    const placedAt = placed ? new Date().toISOString() : null
    await t.client`
      INSERT INTO pending_placement
        (provider, actual_source, identity_email, tool, date, cost_usd, first_seen_at, placed_at)
      VALUES ('anthropic', 'anthropic-analytics-api:o1', lower(${email}), 'claude-code',
              '2026-06-01'::date, 1.0,
              now() - (${ageDays} * INTERVAL '1 day'),
              ${placedAt}::timestamptz)`
  }

  it('dispatches ONE attention item to a cross-region admin when an owed bill ages past the grace', async () => {
    await clearInbox()
    await clearSyncConflicts()
    await clearPending()
    await seedPending('aged@example.com', 10, false) // 10d old, un-placed → aged

    const result = await runConnectorHealth(t.db)
    expect(result.agedOwedBills).toBe(1)

    const rows = await t.client<{ severity: string; subject: string; body: Record<string, unknown> }[]>`
      SELECT severity, subject, body::jsonb AS body
      FROM inbox_item
      WHERE category = 'connector-health' AND recipient_teammate_id = ${platformAdminId}::uuid`
    expect(rows.length).toBe(1)
    expect(rows[0]!.severity).toBe('attention')
    expect(rows[0]!.subject).toContain('owed bill')
    expect(rows[0]!.body.aged_owed_bills).toBe(true)
    expect(rows[0]!.body.count).toBe(1)
    expect(rows[0]!.body.grace_days).toBe(7)
    // The region 'admin' (lena) gets nothing — the alert is region-less → cross-region only.
    const lenaRows = await t.client<{ count: string }[]>`
      SELECT COUNT(*)::text AS count FROM inbox_item
      WHERE category = 'connector-health' AND recipient_teammate_id = ${lenaId}::uuid`
    expect(Number(lenaRows[0]!.count)).toBe(0)
  })

  it('does not alert on recent un-placed or old-but-placed rows', async () => {
    await clearInbox()
    await clearPending()
    await seedPending('recent@example.com', 2, false) // within grace
    await seedPending('placed-old@example.com', 30, true) // old but already replaced

    const result = await runConnectorHealth(t.db)
    expect(result.agedOwedBills).toBe(0)
    const count = await t.client<{ count: string }[]>`
      SELECT COUNT(*)::text AS count FROM inbox_item WHERE category = 'connector-health'`
    expect(Number(count[0]!.count)).toBe(0)
  })

  it('is idempotent: a second tick does not pile a duplicate aging item', async () => {
    await clearInbox()
    await clearPending()
    await seedPending('aged2@example.com', 14, false)

    const first = await runConnectorHealth(t.db)
    expect(first.agedOwedBills).toBe(1)
    const second = await runConnectorHealth(t.db)
    expect(second.agedOwedBills).toBe(1) // still aged…

    const count = await t.client<{ count: string }[]>`
      SELECT COUNT(*)::text AS count FROM inbox_item WHERE category = 'connector-health'`
    expect(Number(count[0]!.count)).toBe(1) // …but only one inbox item
  })
})
