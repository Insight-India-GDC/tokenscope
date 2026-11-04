/*
 * Region-scoped admin notification routing (dogfood-followups.md #5).
 *
 * Admin-routed ops categories (sync-conflict / structural-conflict /
 * connector-health) must reach a region's own `admin`s ONLY for that region's
 * alerts, while the cross-region roles (`platform-admin`)
 * receive every region's. When the alert's region can't be derived, it routes
 * to the cross-region roles ONLY — never a sibling region's admin (the inbox
 * read path is recipient-scoped, so a fail-open to all admins would be a real
 * cross-region leak), and never nobody (the cross-region roles are always in).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'
import { dispatchInbox } from '../../../server/notifications/dispatch'
import * as schema from '../../../drizzle/schema'

let t: TestDb

// Captured ids for assertions.
let regionA = ''
let regionB = ''
let ouA = '' // a cost-owning org unit in region A (for org_unit-kind derivation)
let projA = '' // project in region A
let adminA = '' // role 'admin', region A — should get region-A alerts
let adminB = '' // role 'admin', region B — should NOT get region-A alerts
let inactiveAdminA = '' // role 'admin', region A, is_active=false — never alerted
let platformAdmin = '' // role 'platform-admin' — cross-region, always alerted
let orgWide = '' // role 'platform-admin' — cross-region, always alerted

beforeAll(async () => {
  t = await startTestDb()

  const regions = await t.db
    .insert(schema.region)
    .values([
      { code: 'rs-a', displayName: 'Region A' },
      { code: 'rs-b', displayName: 'Region B' },
    ])
    .returning()
  regionA = regions.find((r) => r.code === 'rs-a')!.id
  regionB = regions.find((r) => r.code === 'rs-b')!.id

  const ous = await t.db
    .insert(schema.orgUnit)
    .values([
      { regionId: regionA, path: 'rsa.bu', code: 'rsa-bu', displayName: 'A BU', unitType: 'bu', isCostOwningUnit: true },
      { regionId: regionB, path: 'rsb.bu', code: 'rsb-bu', displayName: 'B BU', unitType: 'bu', isCostOwningUnit: true },
    ])
    .returning()
  ouA = ous.find((o) => o.code === 'rsa-bu')!.id
  const ouB = ous.find((o) => o.code === 'rsb-bu')!.id

  const tms = await t.db
    .insert(schema.teammate)
    .values([
      { entraOid: 'oid-admin-a', email: 'admin-a@example.com', role: 'admin', regionId: regionA, orgUnitId: ouA },
      { entraOid: 'oid-admin-b', email: 'admin-b@example.com', role: 'admin', regionId: regionB, orgUnitId: ouB },
      { entraOid: 'oid-admin-a-off', email: 'admin-a-off@example.com', role: 'admin', regionId: regionA, orgUnitId: ouA, isActive: false },
      { entraOid: 'oid-platform', email: 'platform@example.com', role: 'platform-admin', regionId: regionA, orgUnitId: ouA },
      { entraOid: 'oid-finops', email: 'finops@example.com', role: 'platform-admin', regionId: regionB, orgUnitId: ouB },
      // negative control: a plain developer in region A must never be an admin recipient.
      { entraOid: 'oid-dev-a', email: 'dev-a@example.com', role: 'developer', regionId: regionA, orgUnitId: ouA },
    ])
    .returning()
  const byEmail = (e: string): string => tms.find((x) => x.email === e)!.id
  adminA = byEmail('admin-a@example.com')
  adminB = byEmail('admin-b@example.com')
  inactiveAdminA = byEmail('admin-a-off@example.com')
  platformAdmin = byEmail('platform@example.com')
  orgWide = byEmail('finops@example.com')

  const projs = await t.db
    .insert(schema.project)
    .values([
      { code: 'RSA-1', codeHash: 'h-rsa-1', displayName: 'A Project', type: 'billable', regionId: regionA, costOwningUnitId: ouA },
    ])
    .returning()
  projA = projs[0]!.id
}, 180_000)

afterAll(async () => {
  await stopTestDb(t)
}, 30_000)

beforeEach(async () => {
  await t.client.unsafe('DELETE FROM inbox_item')
})

function recipients(results: { recipientTeammateId: string }[]): Set<string> {
  return new Set(results.map((r) => r.recipientTeammateId))
}

const CROSS_REGION = (): string[] => [platformAdmin, orgWide]

describe('region-scoped admin routing', () => {
  it("routes a region-A conflict to region-A's admin + cross-region roles, NOT region-B's admin", async () => {
    const got = recipients(
      await dispatchInbox(t.db, {
        category: 'sync-conflict',
        subject: 'conflict on RSA-1',
        body: { connector: 'pathway' },
        relatedEntityKind: 'project',
        relatedEntityId: projA,
      }),
    )
    expect(got).toEqual(new Set([adminA, ...CROSS_REGION()]))
    expect(got.has(adminB)).toBe(false)
    expect(got.has(inactiveAdminA)).toBe(false) // is_active=false excluded
  })

  it('routes to cross-region roles ONLY when the region is underivable (no related entity)', async () => {
    const got = recipients(
      await dispatchInbox(t.db, {
        category: 'sync-conflict',
        subject: 'unscoped conflict',
        body: { connector: 'pathway' },
      }),
    )
    expect(got).toEqual(new Set(CROSS_REGION()))
    expect(got.has(adminA)).toBe(false)
    expect(got.has(adminB)).toBe(false)
  })

  it('honours an explicit regionId override (region B → admin-B, not admin-A)', async () => {
    const got = recipients(
      await dispatchInbox(t.db, {
        category: 'connector-health',
        subject: 'health',
        body: {},
        regionId: regionB,
      }),
    )
    expect(got).toEqual(new Set([adminB, ...CROSS_REGION()]))
    expect(got.has(adminA)).toBe(false)
  })

  it('fails open to cross-region roles for a deleted/nonexistent project (no FK on target_pk)', async () => {
    const got = recipients(
      await dispatchInbox(t.db, {
        category: 'sync-conflict',
        subject: 'stale conflict',
        body: {},
        relatedEntityKind: 'project',
        relatedEntityId: '00000000-0000-4000-8000-00000000dead',
      }),
    )
    expect(got).toEqual(new Set(CROSS_REGION()))
  })

  it('does not throw on a non-UUID relatedEntityId; treats it as underivable', async () => {
    const got = recipients(
      await dispatchInbox(t.db, {
        category: 'sync-conflict',
        subject: 'bad id',
        body: {},
        relatedEntityKind: 'project',
        relatedEntityId: 'not-a-uuid',
      }),
    )
    expect(got).toEqual(new Set(CROSS_REGION()))
  })

  it('derives region from an org_unit-kind related entity', async () => {
    const got = recipients(
      await dispatchInbox(t.db, {
        category: 'sync-conflict',
        subject: 'org unit conflict',
        body: {},
        relatedEntityKind: 'org_unit',
        relatedEntityId: ouA,
      }),
    )
    expect(got).toEqual(new Set([adminA, ...CROSS_REGION()]))
  })

  it('derives region from a teammate-kind related entity', async () => {
    const got = recipients(
      await dispatchInbox(t.db, {
        category: 'sync-conflict',
        subject: 'teammate conflict',
        body: {},
        relatedEntityKind: 'teammate',
        relatedEntityId: adminB, // admin-b lives in region B
      }),
    )
    expect(got).toEqual(new Set([adminB, ...CROSS_REGION()]))
  })

  it('stamps body.routing_scope with the derived region, and fail-open when underivable', async () => {
    await dispatchInbox(t.db, {
      category: 'sync-conflict',
      subject: 'scoped',
      body: { connector: 'pathway' },
      relatedEntityKind: 'project',
      relatedEntityId: projA,
    })
    const scoped = await t.client<{ routing_scope: string }[]>`
      SELECT body->>'routing_scope' AS routing_scope FROM inbox_item WHERE recipient_teammate_id = ${adminA}::uuid`
    expect(scoped[0]!.routing_scope).toBe(`region:${regionA}`)

    await t.client.unsafe('DELETE FROM inbox_item')
    await dispatchInbox(t.db, { category: 'sync-conflict', subject: 'unscoped', body: {} })
    const open = await t.client<{ routing_scope: string }[]>`
      SELECT body->>'routing_scope' AS routing_scope FROM inbox_item WHERE recipient_teammate_id = ${platformAdmin}::uuid`
    expect(open[0]!.routing_scope).toBe('fail-open')
  })
})
