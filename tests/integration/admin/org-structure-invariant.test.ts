// @vitest-environment node
/*
 * S3 part (f) — regions.post.ts / org-units.post.ts against real handlers
 * (the region-lifecycle.test.ts pattern: inject a session, call the handler
 * directly against withRequestRls + testcontainers).
 *
 * Before part (f), a runtime-created region had ZERO org units — which is what
 * let placedBelowRegionRootPredicate()'s naming arm (`code <> 'default'`) fail
 * open (a runtime region's root, if one ever got created via org-units.post.ts,
 * could be coded ANYTHING) and what made unplacedOrgUnitIdForRegion the only
 * structure such a region ever got. This asserts:
 *   - regions.post.ts plants EXACTLY ONE parentless, code='default',
 *     unit_type='bu', is_cost_owning_unit=true root, in the SAME transaction
 *     as the region insert, mirroring seed-regions.ts's shape+label rule;
 *   - org-units.post.ts reserves 'default' UNCONDITIONALLY (it is never the
 *     writer of the true root — only regions.post.ts's own INSERT is) so a
 *     legitimate non-root unit coded 'default' can no longer exist anywhere,
 *     closing the naming arm's mirror false positive.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { sql } from 'drizzle-orm'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'
import * as schema from '../../../drizzle/schema'
import { injectTestSession } from '../../helpers/auth'
import type { Session } from '../../../server/utils/auth'

import regionsCreate from '../../../server/api/v1/admin/regions.post'
import orgUnitsCreate from '../../../server/api/v1/admin/org-units.post'
import { unplacedOrgUnitIdForRegion } from '../../../server/auth/placement-home'

let t: TestDb
let homeRegionId: string

beforeAll(async () => {
  t = await startTestDb()
  process.env.DATABASE_URL = t.url
  process.env.NUXT_SESSION_SECRET = 'osi-test-padded-to-thirty-two-characters'
  process.env.NUXT_HMAC_SESSION_KEY = 'osi-test-hmac-key-padded-well-beyond-32-chars'

  // A home region + teammate row for the platform-admin caller (recordAuditEvent's
  // actor_teammate_id FKs onto teammate.id — the region-lifecycle.test.ts pattern).
  const [home] = await t.db.insert(schema.region).values({ code: 'osi-home', displayName: 'OSI Home' }).returning()
  homeRegionId = home!.id
  const [homeOu] = await t.db
    .insert(schema.orgUnit)
    .values({ regionId: home!.id, path: 'osi_home', code: 'default', displayName: 'OSI Home (default)', unitType: 'bu', isCostOwningUnit: true })
    .returning()
  await t.db.insert(schema.teammate).values({
    id: '00000000-0000-4000-8000-0000000000f1',
    entraOid: 'osi-oid-pa',
    email: 'osi-pa@example.com',
    displayName: 'OSI PA',
    role: 'platform-admin',
    regionId: home!.id,
    orgUnitId: homeOu!.id,
  })
}, 60_000)

afterAll(async () => {
  await stopTestDb(t)
}, 30_000)

type AnyHandler = (e: unknown) => Promise<unknown>

function ev(opts: { params?: Record<string, string>; body?: unknown; session: Session }) {
  const headers: Record<string, string> = { host: 'localhost:3450', origin: 'http://localhost:3450' }
  const e = {
    method: 'POST',
    path: '/x',
    context: { params: opts.params ?? {} },
    node: {
      req: {
        method: 'POST',
        url: '/x',
        body: opts.body,
        socket: { remoteAddress: '127.0.0.1' },
        get headers() {
          return { ...headers, 'content-type': 'application/json' }
        },
      },
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
  injectTestSession(e as unknown as Parameters<typeof injectTestSession>[0], opts.session)
  return e as unknown
}

const platformAdmin = (): Session =>
  ({ teammateId: '00000000-0000-4000-8000-0000000000f1', email: 'osi-pa@example.com', displayName: 'OSI PA', role: 'platform-admin', regionId: homeRegionId, orgPath: 'osi_home' }) as Session

async function call<R = unknown>(h: unknown, e: unknown): Promise<R> {
  return (h as AnyHandler)(e) as Promise<R>
}

describe('regions.post.ts plants the root org_unit (S3 part f)', () => {
  it('creating a region plants EXACTLY ONE parentless, code=default, unit_type=bu, cost-owning root', async () => {
    const region = await call<{ id: string; code: string }>(
      regionsCreate,
      ev({ body: { code: 'osi-new', display_name: 'OSI New' }, session: platformAdmin() }),
    )
    const rows = await t.db.execute<{
      id: string
      parent_id: string | null
      code: string
      unit_type: string
      is_cost_owning_unit: boolean
      path: string
    }>(sql`
      SELECT id::text AS id, parent_id::text AS parent_id, code, unit_type, is_cost_owning_unit, path::text AS path
      FROM org_unit WHERE region_id = ${region.id}::uuid
    `)
    const units = [...rows]
    expect(units.length).toBe(1) // exactly one — no children, no extras
    expect(units[0]!.parent_id).toBeNull()
    expect(units[0]!.code).toBe('default')
    expect(units[0]!.unit_type).toBe('bu')
    expect(units[0]!.is_cost_owning_unit).toBe(true)
    // Label rule mirrors seed-regions.ts exactly: code.replace(/-/g, '_').
    expect(units[0]!.path).toBe('osi_new')
  })

  it('a hyphenated region code folds to underscores in the root path (same rule as seed-regions.ts)', async () => {
    const region = await call<{ id: string }>(
      regionsCreate,
      ev({ body: { code: 'osi-multi-hyphen', display_name: 'OSI Multi Hyphen' }, session: platformAdmin() }),
    )
    const [row] = await t.db.execute<{ path: string }>(sql`
      SELECT path::text AS path FROM org_unit WHERE region_id = ${region.id}::uuid
    `)
    expect(row!.path).toBe('osi_multi_hyphen')
  })
})

describe("org-units.post.ts reserves 'default' (S3 part f)", () => {
  it("rejects a SECOND 'default' in a region that already has its regions.post.ts-planted root (409)", async () => {
    const region = await call<{ id: string }>(
      regionsCreate,
      ev({ body: { code: 'osi-reserve', display_name: 'OSI Reserve' }, session: platformAdmin() }),
    )
    await expect(
      call(
        orgUnitsCreate,
        ev({ body: { region_id: region.id, code: 'default', display_name: 'Sneaky Default', unit_type: 'bu' }, session: platformAdmin() }),
      ),
    ).rejects.toMatchObject({ statusCode: 409 })
    // Still exactly one org_unit in the region — the reservation refused BEFORE
    // any insert, not after (no orphaned second row, no path collision noise).
    const rows = await t.db.execute<{ n: string }>(sql`SELECT COUNT(*)::text AS n FROM org_unit WHERE region_id = ${region.id}::uuid`)
    expect(Number([...rows][0]!.n)).toBe(1)
  })

  it("rejects 'default' UNCONDITIONALLY — even in a region seeded directly with NO existing default root", async () => {
    // A region that did NOT go through regions.post.ts (e.g. a raw seed insert)
    // has no 'default' unit yet. The reservation is not "unless none exists" —
    // it is absolute: only regions.post.ts's own writer may ever create the
    // parentless code='default' root, so org-units.post.ts refuses it here too.
    const [bareRegion] = await t.db.insert(schema.region).values({ code: 'osi-bare', displayName: 'OSI Bare' }).returning()
    await expect(
      call(
        orgUnitsCreate,
        ev({ body: { region_id: bareRegion!.id, code: 'default', display_name: 'Should Be Refused', unit_type: 'bu' }, session: platformAdmin() }),
      ),
    ).rejects.toMatchObject({ statusCode: 409 })
  })

  it('a normal, non-default code is unaffected', async () => {
    const region = await call<{ id: string }>(
      regionsCreate,
      ev({ body: { code: 'osi-normal', display_name: 'OSI Normal' }, session: platformAdmin() }),
    )
    const out = await call<{ id: string; code: string }>(
      orgUnitsCreate,
      ev({ body: { region_id: region.id, code: 'eng', display_name: 'Engineering', unit_type: 'bu' }, session: platformAdmin() }),
    )
    expect(out.code).toBe('eng')
  })
})

describe('org-units.post.ts nests a new unit inside its region (org-setup 01, item 1)', () => {
  it("a null or absent parent means the region's default unit", async () => {
    const region = await call<{ id: string }>(
      regionsCreate,
      ev({ body: { code: 'osi-nest', display_name: 'OSI Nest' }, session: platformAdmin() }),
    )
    for (const [code, parent] of [['nest-null', { parent_id: null }], ['nest-absent', {}]] as const) {
      const out = await call<{ id: string; path: string }>(
        orgUnitsCreate,
        ev({ body: { region_id: region.id, code, display_name: code, unit_type: 'bu', ...parent }, session: platformAdmin() }),
      )
      const [row] = await t.db.execute<{ parent_code: string; parent_parent: string | null }>(sql`
        SELECT p.code AS parent_code, p.parent_id::text AS parent_parent
        FROM org_unit ou JOIN org_unit p ON p.id = ou.parent_id WHERE ou.id = ${out.id}::uuid
      `)
      expect(row).toEqual({ parent_code: 'default', parent_parent: null })
      expect(out.path).toBe(`osi_nest.${code.replace('-', '_')}`)
    }
  })

  it('refuses a parent that is the holding node or anything beneath it (422)', async () => {
    const region = await call<{ id: string }>(
      regionsCreate,
      ev({ body: { code: 'osi-hold', display_name: 'OSI Hold' }, session: platformAdmin() }),
    )
    const holdingId = await unplacedOrgUnitIdForRegion(t.db, region.id)
    const [under] = await t.db.execute<{ id: string }>(sql`
      INSERT INTO org_unit (region_id, parent_id, path, code, display_name, unit_type, is_cost_owning_unit)
      VALUES (${region.id}::uuid, ${holdingId}::uuid, 'osi_hold_unplaced.legacy', 'legacy', 'Legacy', 'team', false)
      RETURNING id::text AS id
    `)
    for (const parentId of [holdingId, under!.id]) {
      await expect(
        call(
          orgUnitsCreate,
          ev({ body: { region_id: region.id, parent_id: parentId, code: 'refused', display_name: 'Refused', unit_type: 'bu' }, session: platformAdmin() }),
        ),
      ).rejects.toMatchObject({ statusCode: 422 })
    }
    const rows = await t.db.execute<{ n: string }>(sql`SELECT COUNT(*)::text AS n FROM org_unit WHERE code = 'refused'`)
    expect(Number([...rows][0]!.n)).toBe(0)
  })
})
