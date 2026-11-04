// @vitest-environment node
/*
 * POST /api/v1/admin/org-units/:id/owners — directory-backed owner assignment.
 * Covers the oid path (find-or-provision the teammate from the Entra directory pick,
 * consistent with the region-leaders picker) plus the legacy teammate_id path.
 * Runs in MOCK directory mode (NUXT_GRAPH_DIRECTORY_MODE unset → MOCK_DIRECTORY).
 *
 * Issue #121 coverage: the find-or-provision is a check-first bind-or-adopt ladder.
 * The mock roster carries a dual-identity pair (Rio Tanaka: dir-oid-0007 primary +
 * dir-oid-0007-cld secondary, one shared mailbox) mirroring the reported repro
 * (two live Entra identities for one human), plus these seeded DB shapes:
 * bill: placeholder on the email → adopt; other-live-identity row → resolve;
 * stale/unverifiable oid on the email → 409; secondary pick → 422.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'
import { injectTestSession } from '../../helpers/auth'
import type { Session } from '../../../server/utils/auth'
import handler from '../../../server/api/v1/admin/org-units/[id]/owners.post'

let t: TestDb
let regionId = ''
const ids: Record<string, string> = {}
const ADMIN_ID = '00000000-0000-0000-0000-000000000001'

function ev(opts: { session: Session; unitId: string; body: unknown }) {
  const headers: Record<string, string> = { host: 'localhost:3450', origin: 'http://localhost:3450' }
  const e = {
    method: 'POST', path: '/x', context: { params: { id: opts.unitId } },
    node: {
      req: { method: 'POST', url: '/x', body: opts.body, socket: { remoteAddress: '127.0.0.1' }, get headers() { return { ...headers, 'content-type': 'application/json' } } },
      res: { _headers: {} as Record<string, unknown>, statusCode: 200, getHeader() {}, setHeader() {}, removeHeader() {}, appendHeader() {}, get headersSent() { return false } },
    },
  }
  injectTestSession(e as unknown as Parameters<typeof injectTestSession>[0], opts.session)
  return e as unknown as Parameters<typeof handler>[0]
}
const admin = (): Session => ({ teammateId: ADMIN_ID, email: 'ow-admin@x.test', displayName: 'Admin', role: 'admin', regionId, orgPath: 'ow' } as Session)
// Provisioning a new person as an owner is platform-admin only.
const platformAdmin = (): Session => ({ ...admin(), role: 'platform-admin' } as Session)

async function unplacedIdFor(rid: string): Promise<string> {
  const [row] = await t.client<{ id: string }[]>`
    SELECT id::text AS id FROM org_unit WHERE region_id = ${rid}::uuid AND code = '__UNPLACED__'`
  return row!.id
}

// The #121 pair from MOCK_DIRECTORY: a standard @example.com account and a
// separate privileged/CLD account on the tenant onmicrosoft domain.
const RIO_PRIMARY_OID = 'dir-oid-0007'
const RIO_CLD_OID = 'dir-oid-0007-cld'
const RIO_EMAIL = 'rio.tanaka@example.com'
const ONMICROSOFT_PATTERN = '*@contoso.onmicrosoft.com'

async function seedPattern(pattern = ONMICROSOFT_PATTERN) {
  await t.client`INSERT INTO directory_exclusion_pattern (pattern) VALUES (${pattern})`
}

/** Seed a teammate row directly (simulating pre-existing state: a bill-driven
 *  placeholder, a row bound to the person's OTHER identity, etc). */
async function seedTeammate(row: { oid: string; email: string; source?: string; isActive?: boolean }): Promise<string> {
  const [r] = await t.client<{ id: string }[]>`
    INSERT INTO teammate (entra_oid, email, display_name, region_id, org_unit_id, role, source, is_active)
    VALUES (${row.oid}, ${row.email}, 'Seeded', ${regionId}::uuid, ${ids['default']}::uuid, 'developer', ${row.source ?? 'directory'}, ${row.isActive ?? true})
    RETURNING id::text AS id`
  return r!.id
}

beforeAll(async () => {
  delete process.env.NUXT_GRAPH_DIRECTORY_MODE // mock directory
  t = await startTestDb(); process.env.DATABASE_URL = t.url
  const [r] = await t.client<{ id: string }[]>`INSERT INTO region (code, display_name) VALUES ('ow', 'OW') RETURNING id::text AS id`; regionId = r!.id
  // Region default BU (where a provisioned owner lands) + a cost-owning practice to own.
  const [def] = await t.client<{ id: string }[]>`INSERT INTO org_unit (region_id, parent_id, path, code, display_name, unit_type, is_cost_owning_unit) VALUES (${regionId}::uuid, NULL, 'ow'::ltree, 'default', 'OW (default)', 'bu', true) RETURNING id::text AS id`; ids['default'] = def!.id
  const [prac] = await t.client<{ id: string }[]>`INSERT INTO org_unit (region_id, parent_id, path, code, display_name, unit_type, is_cost_owning_unit) VALUES (${regionId}::uuid, ${def!.id}::uuid, 'ow.prac'::ltree, 'prac', 'Practice', 'practice', true) RETURNING id::text AS id`; ids['prac'] = prac!.id
  const [team] = await t.client<{ id: string }[]>`INSERT INTO org_unit (region_id, parent_id, path, code, display_name, unit_type, is_cost_owning_unit) VALUES (${regionId}::uuid, ${def!.id}::uuid, 'ow.team'::ltree, 'team', 'Team', 'practice', true) RETURNING id::text AS id`; ids['team'] = team!.id
  await t.client`INSERT INTO teammate (id, entra_oid, email, display_name, region_id, org_unit_id, role) VALUES (${ADMIN_ID}::uuid, 'oid-ow-admin', 'ow-admin@x.test', 'Admin', ${regionId}::uuid, ${def!.id}::uuid, 'admin')`
}, 180_000)
afterAll(async () => { if (t) await stopTestDb(t) }, 30_000)

beforeEach(async () => {
  await t.client`DELETE FROM cou_owner`
  await t.client`DELETE FROM directory_exclusion_pattern`
  await t.client`DELETE FROM teammate WHERE source IN ('directory', 'bill') OR entra_oid LIKE 'bill:%' OR entra_oid LIKE 'stale-%'`
})

describe('cost-centre owner assignment (directory-backed)', () => {
  it('provisions the teammate from a directory oid and assigns ownership', async () => {
    const res = (await handler(ev({ session: platformAdmin(), unitId: ids['prac']!, body: { oid: 'dir-oid-0001' } }))) as { teammate_id: string; email: string; provisioned: boolean; identity_adopted: boolean }
    expect(res.provisioned).toBe(true)
    expect(res.identity_adopted).toBe(false)
    expect(res.email).toBe('sasha.kumar@example.com')
    // teammate created in THIS region, homed on the region's __UNPLACED__
    // holding node (S3, server/auth/placement-home.ts) — NOT the region-root
    // 'default' BU, whose subtree is the whole region.
    const [tm] = await t.client<{ region_id: string; org_unit_id: string; source: string }[]>`
      SELECT region_id::text AS region_id, org_unit_id::text AS org_unit_id, source FROM teammate WHERE entra_oid = 'dir-oid-0001'`
    expect(tm!.region_id).toBe(regionId)
    expect(tm!.org_unit_id).toBe(await unplacedIdFor(regionId))
    expect(tm!.org_unit_id).not.toBe(ids['default'])
    expect(tm!.source).toBe('directory')
    // ownership row exists for the practice.
    const [own] = await t.client<{ n: string }[]>`SELECT count(*)::text AS n FROM cou_owner WHERE org_unit_id = ${ids['prac']}::uuid AND teammate_id = ${res.teammate_id}::uuid AND revoked_at IS NULL`
    expect(own!.n).toBe('1')
  })

  it('does NOT re-provision when the directory person is already a teammate', async () => {
    /*
     * This used to assign the same person to a SECOND unit and assert it
     * succeeded — which was the old, unbounded shape. Since the one-owner-one-BU
     * ruling (2026-08-10) the second grant is a 409, so the test now proves the
     * thing it was actually about: the second call resolves the EXISTING
     * teammate rather than provisioning a duplicate. That resolution happens
     * before the ownership check, so the teammate count is the assertion and
     * the rejection is the new invariant, asserted beside it.
     */
    await handler(ev({ session: platformAdmin(), unitId: ids['prac']!, body: { oid: 'dir-oid-0002' } })) // provisions tom
    await expect(
      handler(ev({ session: admin(), unitId: ids['team']!, body: { oid: 'dir-oid-0002' } })),
    ).rejects.toMatchObject({ statusCode: 409 })
    const [tm] = await t.client<{ n: string }[]>`SELECT count(*)::text AS n FROM teammate WHERE entra_oid = 'dir-oid-0002'`
    expect(tm!.n).toBe('1') // exactly one teammate, not duplicated
  })

  it('refuses a SECOND Business Unit for someone who already owns one (409)', async () => {
    /*
     * Owner ruling 2026-08-10. Not tidiness: the manager-chain placement walk
     * treats an owner of more than one active cost-owning unit as AMBIGUOUS and
     * skips them entirely, so a multi-BU owner silently places nobody and their
     * reports pile up on the region default.
     */
    await handler(ev({ session: platformAdmin(), unitId: ids['prac']!, body: { oid: 'dir-oid-0003' } }))
    await expect(
      handler(ev({ session: admin(), unitId: ids['team']!, body: { oid: 'dir-oid-0003' } })),
    ).rejects.toMatchObject({ statusCode: 409 })
    // …and the first ownership is untouched: a refused second grant must not
    // disturb the one that was already valid.
    const [own] = await t.client<{ n: string }[]>`
      SELECT count(*)::text AS n FROM cou_owner co
      JOIN teammate tm ON tm.id = co.teammate_id
      WHERE tm.entra_oid = 'dir-oid-0003' AND co.revoked_at IS NULL`
    expect(own!.n).toBe('1')
  })

  it('refuses a FOREIGN-region teammate_id before resolving its identity (422 Cross-region owner, no email)', async () => {
    const [rb] = await t.client<{ id: string }[]>`
      INSERT INTO region (code, display_name) VALUES ('ow-b', 'OW B') RETURNING id::text AS id`
    const [ouB] = await t.client<{ id: string }[]>`
      INSERT INTO org_unit (region_id, parent_id, path, code, display_name, unit_type, is_cost_owning_unit)
      VALUES (${rb!.id}::uuid, NULL, 'owb'::ltree, 'owb', 'OW B', 'bu', true) RETURNING id::text AS id`
    // Not in the mock directory: identity resolution would answer 422 naming this email.
    const [foreign] = await t.client<{ id: string }[]>`
      INSERT INTO teammate (entra_oid, email, display_name, region_id, org_unit_id, role, source)
      VALUES ('bill:9a1e0000-0000-4000-8000-000000000b01', 'ghost.owner@x.test', 'Ghost', ${rb!.id}::uuid, ${ouB!.id}::uuid, 'developer', 'bill')
      RETURNING id::text AS id`
    const err = await handler(ev({ session: admin(), unitId: ids['prac']!, body: { teammate_id: foreign!.id } })).then(
      () => null,
      (e: unknown) => e as { statusCode: number; statusMessage: string; data?: unknown },
    )
    expect(err).toMatchObject({ statusCode: 422, statusMessage: 'Cross-region owner' })
    expect(JSON.stringify(err!.data)).not.toContain('ghost.owner@x.test')
    await t.client`DELETE FROM teammate WHERE id = ${foreign!.id}::uuid`
    await t.client`DELETE FROM org_unit WHERE id = ${ouB!.id}::uuid`
    await t.client`DELETE FROM region WHERE id = ${rb!.id}::uuid`
  })

  it('refuses a region admin who picks someone not yet a teammate (403), provisioning nothing', async () => {
    /*
     * A unit owner is a manager-walk target and the walk is estate-wide, so a
     * director named here would place unplaced people from every region. A
     * region admin names existing teammates only; a new person is a
     * platform-admin pick, like region leaders.
     */
    await expect(
      handler(ev({ session: admin(), unitId: ids['prac']!, body: { oid: 'dir-oid-0004' } })),
    ).rejects.toMatchObject({ statusCode: 403, statusMessage: 'Owner is not a teammate yet' })
    const [n] = await t.client<{ n: string }[]>`SELECT count(*)::text AS n FROM teammate WHERE entra_oid = 'dir-oid-0004'`
    expect(n!.n).toBe('0')
    const [own] = await t.client<{ n: string }[]>`SELECT count(*)::text AS n FROM cou_owner`
    expect(own!.n).toBe('0')
    const [aud] = await t.client<{ n: string }[]>`
      SELECT count(*)::text AS n FROM audit_event WHERE event_type = 'teammate-provisioned' AND payload->>'oid' = 'dir-oid-0004'`
    expect(aud!.n).toBe('0')
  })

  it('lets a region admin pick a directory person who is already a teammate in the region', async () => {
    await seedTeammate({ oid: 'dir-oid-0005', email: 'nadia.haddad@example.com' })
    const res = (await handler(ev({ session: admin(), unitId: ids['prac']!, body: { oid: 'dir-oid-0005' } }))) as { provisioned: boolean; email: string }
    expect(res.provisioned).toBe(false)
    expect(res.email).toBe('nadia.haddad@example.com')
  })

  it('rejects a body with neither oid nor teammate_id (400)', async () => {
    await expect(
      handler(ev({ session: admin(), unitId: ids['prac']!, body: {} })),
    ).rejects.toMatchObject({ statusCode: 400 })
  })

  it('404s an unknown directory oid', async () => {
    await expect(
      handler(ev({ session: admin(), unitId: ids['prac']!, body: { oid: 'dir-oid-nope' } })),
    ).rejects.toMatchObject({ statusCode: 404 })
  })
})

describe('directory-exclusion policy (#121)', () => {
  it('REFUSES a privileged (onmicrosoft) pick with 422 when a matching pattern is configured', async () => {
    await seedPattern() // *@contoso.onmicrosoft.com
    await expect(
      handler(ev({ session: admin(), unitId: ids['prac']!, body: { oid: RIO_CLD_OID } })),
    ).rejects.toMatchObject({
      statusCode: 422,
      statusMessage: 'Excluded directory identity',
      data: expect.objectContaining({ type: 'https://tokenscope.example.com/errors/excluded-identity' }),
    })
    const [n] = await t.client<{ n: string }[]>`SELECT count(*)::text AS n FROM teammate WHERE entra_oid = ${RIO_CLD_OID}`
    expect(n!.n).toBe('0') // nothing provisioned
  })

  it('FAIL-OPEN: with NO pattern configured, even an onmicrosoft account is assignable', async () => {
    // A genuinely cloud-only real user (dir-oid-0008, no vanity twin) must not
    // be excluded by default — the portable default excludes nobody.
    const res = (await handler(ev({ session: platformAdmin(), unitId: ids['prac']!, body: { oid: 'dir-oid-0008' } }))) as { provisioned: boolean }
    expect(res.provisioned).toBe(true)
  })

  it('the STANDARD account is always assignable, even with the onmicrosoft pattern set', async () => {
    await seedPattern()
    const res = (await handler(ev({ session: platformAdmin(), unitId: ids['prac']!, body: { oid: RIO_PRIMARY_OID } }))) as { provisioned: boolean; email: string }
    expect(res.provisioned).toBe(true)
    expect(res.email).toBe(RIO_EMAIL)
  })

  it('ADOPTS a bill: placeholder holding the email — same row upgraded to the picked oid', async () => {
    const billRowId = await seedTeammate({ oid: 'bill:11111111-1111-1111-1111-111111111111', email: RIO_EMAIL, source: 'bill' })
    const res = (await handler(ev({ session: admin(), unitId: ids['prac']!, body: { oid: RIO_PRIMARY_OID } }))) as { teammate_id: string; identity_adopted: boolean }
    expect(res.teammate_id).toBe(billRowId) // spend continuity
    expect(res.identity_adopted).toBe(true)
    const [tm] = await t.client<{ entra_oid: string }[]>`SELECT entra_oid FROM teammate WHERE id = ${billRowId}::uuid`
    expect(tm!.entra_oid).toBe(RIO_PRIMARY_OID)
  })

  it('422s an INACTIVE bill: placeholder holding the email — named, not a misleading 409', async () => {
    await seedTeammate({ oid: 'bill:22222222-2222-2222-2222-222222222222', email: RIO_EMAIL, source: 'bill', isActive: false })
    await expect(
      handler(ev({ session: admin(), unitId: ids['prac']!, body: { oid: RIO_PRIMARY_OID } })),
    ).rejects.toMatchObject({ statusCode: 422, statusMessage: 'Unresolvable placeholder identity' })
  })

  it('409s (clean, not 500) when the email is already held by a DIFFERENT real oid', async () => {
    // A genuine duplicate/data anomaly: some other real-oid row already holds
    // this email. Surfaces a clean 409, not a raw 23505.
    await seedTeammate({ oid: 'dir-oid-0002', email: RIO_EMAIL })
    await expect(
      handler(ev({ session: admin(), unitId: ids['prac']!, body: { oid: RIO_PRIMARY_OID } })),
    ).rejects.toMatchObject({
      statusCode: 409,
      statusMessage: 'Identity collision',
      data: expect.objectContaining({ type: 'https://tokenscope.example.com/errors/identity-collision' }),
    })
  })
})
