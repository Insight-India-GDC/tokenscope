// @vitest-environment node
/*
 * Authorization-scope contract for the rollup + finance surfaces.
 *
 * Security regression for the endpoint sweep: a manager's per-project /
 * week-over-week rollup must not span outside their org subtree.
 * global-finops / admin (org-wide vs region) bypass as designed.
 *
 * These assert the APP-LEVEL predicates (orgSubtreeScopePredicate and
 * managerScopePredicate) — the live gate, since RLS is bypassed here (test connects
 * as the table owner, same as the running app until Epic 10's non-owner role
 * lands).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { sql } from 'drizzle-orm'
import { randomUUID } from 'node:crypto'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'
import { withRlsContext } from '../../../server/db/rls'
import { orgSubtreeScopePredicate, managerScopePredicate } from '../../../server/auth/org-subtree-scope'
import * as schema from '../../../drizzle/schema'

let t: TestDb
let regionAId: string
let regionBId: string
let regionCId: string
let alphaOuId: string
let betaOuId: string
let gammaOuId: string
let projAId: string
let projGId: string

const A_PATH = 'r1.alpha'
const B_PATH = 'r1.beta'

async function project(code: string, regionId: string, couId: string): Promise<string> {
  const [p] = await t.db
    .insert(schema.project)
    .values({ code, codeHash: 'h-' + code, displayName: code, type: 'billable', regionId, costOwningUnitId: couId })
    .returning({ id: schema.project.id })
  return p!.id
}

beforeAll(async () => {
  t = await startTestDb()

  const [rA, rB] = await t.db
    .insert(schema.region)
    .values([
      { code: 'r1', displayName: 'Region One' },
      { code: 'r2', displayName: 'Region Two' },
    ])
    .returning()
  regionAId = rA!.id
  regionBId = rB!.id

  // S3 part (a) — the headline fixture fix: tests/integration/rollups/scope.test.ts
  // seeded r1.alpha, r1.beta, r2.gamma and NO unit at bare path 'r1' at all, so "a
  // teammate whose userOrgPath is the bare region label gets ZERO rows" passed
  // because nothing matched self.path = 'r1' — it would pass identically for
  // nlevel(path)=1, for parent_id IS NULL, or for a hard-coded FALSE. A REAL region
  // root at path 'r1' (parentless, code='default' — the seed-region shape) makes
  // the assertion below actually exercise placedBelowRegionRootPredicate().
  const [r1Root] = await t.db
    .insert(schema.orgUnit)
    .values({ regionId: regionAId, path: 'r1', code: 'default', displayName: 'R1 Root', unitType: 'bu' })
    .returning()
  const [alpha, beta] = await t.db
    .insert(schema.orgUnit)
    .values([
      { regionId: regionAId, parentId: r1Root!.id, path: A_PATH, code: 'alpha', displayName: 'Alpha', unitType: 'practice', isCostOwningUnit: true },
      { regionId: regionAId, parentId: r1Root!.id, path: B_PATH, code: 'beta', displayName: 'Beta', unitType: 'practice', isCostOwningUnit: true },
    ])
    .returning()
  alphaOuId = alpha!.id
  betaOuId = beta!.id
  const [gamma] = await t.db
    .insert(schema.orgUnit)
    .values({ regionId: regionBId, path: 'r2.gamma', code: 'gamma', displayName: 'Gamma', unitType: 'practice', isCostOwningUnit: true })
    .returning()
  gammaOuId = gamma!.id

  // A THIRD region shaped like a runtime-created one (regions.post.ts BEFORE part
  // (f) planted nothing; even after (f), org-units.post.ts only reserves 'default'
  // going forward) — a parentless root coded 'hq', NOT 'default', with a genuine
  // child. This is the discriminator `code <> 'default'` alone would MISS and the
  // whole reason (a) is keyed on parent_id IS NOT NULL, not the naming test.
  const [rC] = await t.db.insert(schema.region).values({ code: 'r3', displayName: 'Region Three' }).returning()
  regionCId = rC!.id
  const [hqRoot] = await t.db
    .insert(schema.orgUnit)
    .values({ regionId: regionCId, path: 'r3', code: 'hq', displayName: 'HQ', unitType: 'bu' })
    .returning()
  await t.db
    .insert(schema.orgUnit)
    .values({ regionId: regionCId, parentId: hqRoot!.id, path: 'r3.eng', code: 'eng', displayName: 'Eng', unitType: 'practice', isCostOwningUnit: true })

  const [devA, devB, devG] = await t.db
    .insert(schema.teammate)
    .values([
      { entraOid: 'oid-a', email: 'a@r1.com', displayName: 'A', regionId: regionAId, orgUnitId: alphaOuId },
      { entraOid: 'oid-b', email: 'b@r1.com', displayName: 'B', regionId: regionAId, orgUnitId: betaOuId },
      { entraOid: 'oid-g', email: 'g@r2.com', displayName: 'G', regionId: regionBId, orgUnitId: gammaOuId },
    ])
    .returning()

  projAId = await project('P-A', regionAId, alphaOuId)
  const projBId = await project('P-B', regionAId, betaOuId)
  projGId = await project('P-G', regionBId, gammaOuId)

  const [rc] = await t.db.select({ id: schema.rateCard.id, version: schema.rateCard.version }).from(schema.rateCard).limit(1)
  async function emit(teammateId: string, projectId: string, regionId: string, ouId: string) {
    const sid = randomUUID()
    await t.db.insert(schema.instanceAttestation).values({
      instanceId: sid, principalOid: 'oid-' + sid, teammateId, projectCodeHash: 'h', rawProjectCode: 'X',
      tool: 'claude-code', sessionTokenHash: 'tok-' + sid, tsStart: new Date(), regionId, orgUnitId: ouId, costOwningUnitId: ouId,
    })
    await t.db.insert(schema.attributionRecord).values({
      instanceId: sid, teammateId, projectId, regionId, orgUnitId: ouId, costOwningUnitId: ouId,
      tool: 'claude-code', model: 'claude-opus-4-1', tokenType: 'output', tokens: BigInt(1000), costUsd: '100.000000',
      rateCardId: rc!.id, rateCardVersion: rc!.version, fidelityTier: 'tier-1', costBasis: 'estimated', tsEvent: new Date(),
    })
  }
  await emit(devA!.id, projAId, regionAId, alphaOuId)
  await emit(devB!.id, projBId, regionAId, betaOuId)
  await emit(devG!.id, projGId, regionBId, gammaOuId)
}, 90_000)

afterAll(async () => {
  await stopTestDb(t)
}, 30_000)

/** Run the manager per_project scope clause for a role/orgPath; return project codes. */
async function perProjectCodes(role: string, orgPath: string): Promise<string[]> {
  return withRlsContext(
    t.db as never,
    { userRole: role as never, userOrgPath: orgPath, userRegionId: regionAId, userTeammateId: projAId },
    async (tx) => {
      const rows = await tx.execute<{ code: string }>(sql`
        SELECT p.code AS code
        FROM project p
        WHERE (
          current_setting('app.user_role', true) IN ('admin', 'global-finops')
          OR p.cost_owning_unit_id IN (
            SELECT id FROM org_unit WHERE path <@ current_setting('app.user_org_path', true)::ltree
          )
        )
        ORDER BY p.code
      `)
      return [...rows].map((r) => r.code)
    },
  )
}

describe('manager rollup per_project org-scope', () => {
  it('manager in alpha sees only alpha-owned projects', async () => {
    const codes = await perProjectCodes('manager', A_PATH)
    expect(codes).toEqual(['P-A'])
  })

  it('manager in beta sees only beta-owned projects', async () => {
    const codes = await perProjectCodes('manager', B_PATH)
    expect(codes).toEqual(['P-B'])
  })

  it('admin/global-finops see projects across the org', async () => {
    const codes = await perProjectCodes('admin', A_PATH)
    expect(codes).toEqual(['P-A', 'P-B', 'P-G'])
  })
})

/** Org units orgSubtreeScopePredicate resolves for a role/orgPath/region. */
async function orgSubtreeCodes(role: string, orgPath: string, regionId: string): Promise<string[]> {
  return withRlsContext(
    t.db as never,
    { userRole: role as never, userOrgPath: orgPath, userRegionId: regionId, userTeammateId: randomUUID() },
    async (tx) => {
      const rows = await tx.execute<{ code: string }>(sql`
        SELECT code FROM org_unit WHERE ${orgSubtreeScopePredicate('org_unit')} ORDER BY code
      `)
      return [...rows].map((r) => r.code)
    },
  )
}

/** Org units managerScopePredicate('manager') resolves for an orgPath/region. */
async function managerSubtreeCodes(orgPath: string, regionId: string): Promise<string[]> {
  return withRlsContext(
    t.db as never,
    { userRole: 'manager' as never, userOrgPath: orgPath, userRegionId: regionId, userTeammateId: randomUUID() },
    async (tx) => {
      const rows = await tx.execute<{ code: string }>(sql`
        SELECT ou2.code FROM org_unit ou2
        WHERE ${managerScopePredicate({ role: 'manager', regionId }, null, 'ou2.region_id', 'ou2.id')}
        ORDER BY ou2.code
      `)
      return [...rows].map((r) => r.code)
    },
  )
}

describe('S3 part (a) — placedBelowRegionRootPredicate() via the REAL production predicates', () => {
  it('orgSubtreeScopePredicate: a teammate on the bare region root "r1" gets ZERO foreign org_unit rows', async () => {
    const codes = await orgSubtreeCodes('manager', 'r1', regionAId)
    expect(codes).toEqual([]) // NOT ['alpha', 'beta', 'default'] — the whole region
  })

  it('orgSubtreeScopePredicate: a manager properly placed at r1.alpha is UNAFFECTED (rules out a hard-coded FALSE)', async () => {
    const codes = await orgSubtreeCodes('manager', A_PATH, regionAId)
    expect(codes).toEqual(['alpha']) // their own subtree, never beta/default/gamma
  })

  it('managerScopePredicate: a teammate on the bare region root "r1" gets ZERO foreign org_unit ids', async () => {
    const codes = await managerSubtreeCodes('r1', regionAId)
    expect(codes).toEqual([])
  })

  it('managerScopePredicate: a manager properly placed at r1.alpha is UNAFFECTED', async () => {
    const codes = await managerSubtreeCodes(A_PATH, regionAId)
    expect(codes).toEqual(['alpha'])
  })

  it('orgSubtreeScopePredicate: a runtime-created region\'s root coded "hq" (NOT "default") ALSO gets ZERO rows — the discriminator code<>\'default\' alone would miss', async () => {
    // If the clamp were keyed on code <> 'default' alone, this case would fail OPEN:
    // 'hq' passes that naming test even though it is structurally the region root.
    const codes = await orgSubtreeCodes('manager', 'r3', regionCId)
    expect(codes).toEqual([])
  })

  it('orgSubtreeScopePredicate: a manager properly placed at r3.eng is UNAFFECTED (the mirror case)', async () => {
    const codes = await orgSubtreeCodes('manager', 'r3.eng', regionCId)
    expect(codes).toEqual(['eng'])
  })

  it('admin bypasses the placement clamp (region-clamped only, unaffected by its OWN placement)', async () => {
    // Admin's own orgPath is irrelevant to orgSubtreeScopePredicate's admin branch —
    // this is the control proving the r1/r3 empty results above are the placement
    // clamp specifically, not some unrelated region-scope failure.
    const codes = await orgSubtreeCodes('admin', 'r1', regionAId)
    expect(codes.sort()).toEqual(['alpha', 'beta', 'default'])
  })
})
