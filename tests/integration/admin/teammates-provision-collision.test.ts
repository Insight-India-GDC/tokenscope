// @vitest-environment node
/*
 * POST /api/v1/admin/teammates — duplicate-identity handling (#121) on the
 * admin Users-page provisioning path. This endpoint had the same latent 500
 * as the owner/member flows: a bare insert whose only conflict target was
 * entra_oid, so an email-unique 23505 escaped raw.
 *
 * Covers: bill: placeholder adoption with the admin's EXPLICIT placement,
 * dual-identity email collision → clean 409, secondary (CLD) pick → 422,
 * duplicate-oid → 409 (pre-existing behaviour preserved).
 *
 * Also covers GET /admin/directory/search's email-level annotation
 * (`teammate_via_other_identity`) that steers the picker before the POST.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'
import { injectTestSession } from '../../helpers/auth'
import type { Session } from '../../../server/utils/auth'
import createHandler from '../../../server/api/v1/admin/teammates.post'
import searchHandler from '../../../server/api/v1/admin/directory/search.get'

let t: TestDb
let regionId = ''
let unitId = ''
const ADMIN_ID = '00000000-0000-0000-0000-0000000000c1'

function ev(opts: { session: Session; body?: unknown; url?: string; method?: string }) {
  const headers: Record<string, string> = { host: 'localhost:3450', origin: 'http://localhost:3450' }
  const method = opts.method ?? 'POST'
  const url = opts.url ?? '/x'
  const e = {
    method, path: url, context: { params: {} },
    node: {
      req: { method, url, body: opts.body, socket: { remoteAddress: '127.0.0.1' }, get headers() { return { ...headers, 'content-type': 'application/json' } } },
      res: { _headers: {} as Record<string, unknown>, statusCode: 200, getHeader() {}, setHeader() {}, removeHeader() {}, appendHeader() {}, get headersSent() { return false } },
    },
  }
  injectTestSession(e as unknown as Parameters<typeof injectTestSession>[0], opts.session)
  return e as never
}
const admin = (): Session => ({ teammateId: ADMIN_ID, email: 'tp-admin@x.test', displayName: 'Admin', role: 'admin', regionId, orgPath: 'tp' } as Session)

async function seedTeammate(row: { oid: string; email: string; source?: string }): Promise<string> {
  const [r] = await t.client<{ id: string }[]>`
    INSERT INTO teammate (entra_oid, email, display_name, region_id, org_unit_id, role, source)
    VALUES (${row.oid}, ${row.email}, 'Seeded', ${regionId}::uuid, ${unitId}::uuid, 'developer', ${row.source ?? 'directory'})
    RETURNING id::text AS id`
  return r!.id
}

beforeAll(async () => {
  delete process.env.NUXT_GRAPH_DIRECTORY_MODE // mock directory
  t = await startTestDb(); process.env.DATABASE_URL = t.url
  const [r] = await t.client<{ id: string }[]>`INSERT INTO region (code, display_name) VALUES ('tp', 'TP') RETURNING id::text AS id`
  regionId = r!.id
  const [u] = await t.client<{ id: string }[]>`INSERT INTO org_unit (region_id, parent_id, path, code, display_name, unit_type) VALUES (${regionId}::uuid, NULL, 'tp'::ltree, 'default', 'TP', 'bu') RETURNING id::text AS id`
  unitId = u!.id
  await t.client`INSERT INTO teammate (id, entra_oid, email, display_name, region_id, org_unit_id, role) VALUES (${ADMIN_ID}::uuid, 'oid-tp-admin', 'tp-admin@x.test', 'Admin', ${regionId}::uuid, ${unitId}::uuid, 'admin')`
}, 180_000)
afterAll(async () => { if (t) await stopTestDb(t) }, 30_000)

beforeEach(async () => {
  await t.client`DELETE FROM directory_exclusion_pattern`
  await t.client`DELETE FROM teammate WHERE source IN ('directory', 'bill') OR entra_oid LIKE 'bill:%'`
})

const body = (oid: string) => ({ oid, region_id: regionId, org_unit_id: unitId, role: 'developer' })

describe('POST /admin/teammates — duplicate identity (#121)', () => {
  it('ADOPTS a bill: placeholder holding the email — explicit placement wins, same row', async () => {
    const billId = await seedTeammate({ oid: 'bill:44444444-4444-4444-4444-444444444444', email: 'rio.tanaka@example.com', source: 'bill' })
    const res = (await createHandler(ev({ session: admin(), body: body('dir-oid-0007') }))) as { id: string; created: boolean; adopted: boolean }
    expect(res.id).toBe(billId)
    expect(res.created).toBe(false)
    expect(res.adopted).toBe(true)
    const [tm] = await t.client<{ entra_oid: string; role: string; source: string }[]>`SELECT entra_oid, role, source FROM teammate WHERE id = ${billId}::uuid`
    expect(tm!.entra_oid).toBe('dir-oid-0007')
    expect(tm!.role).toBe('developer')
    expect(tm!.source).toBe('directory')
  })

  it('cross-region adoption: a never-placed placeholder is adopted (audited), an explicitly placed one is refused', async () => {
    const [rb] = await t.client<{ id: string }[]>`
      INSERT INTO region (code, display_name) VALUES ('tp-b', 'TP B') ON CONFLICT (code) DO UPDATE SET code = EXCLUDED.code
      RETURNING id::text AS id`
    const [ub] = await t.client<{ id: string }[]>`
      INSERT INTO org_unit (region_id, parent_id, path, code, display_name, unit_type)
      VALUES (${rb!.id}::uuid, NULL, 'tpb'::ltree, 'tpb-default', 'TP B', 'bu')
      ON CONFLICT (region_id, code) DO UPDATE SET code = EXCLUDED.code
      RETURNING id::text AS id`
    const seedB = async (oid: string, email: string, metadata: Record<string, unknown> | null) => {
      const [r] = await t.client<{ id: string }[]>`
        INSERT INTO teammate (entra_oid, email, display_name, region_id, org_unit_id, role, source, metadata)
        VALUES (${oid}, ${email}, 'Seeded', ${rb!.id}::uuid, ${ub!.id}::uuid, 'developer', 'bill', ${metadata ? JSON.stringify(metadata) : null}::jsonb)
        RETURNING id::text AS id`
      return r!.id
    }

    // Placed by derivation (placedVia): refused with the region-scope 403, row untouched.
    const derived = await seedB('bill:9a1e0000-0000-4000-8000-0000000000d1', 'rio.tanaka@example.com', { placedVia: 'manager-chain', placedOwnerOid: 'x' })
    await expect(createHandler(ev({ session: admin(), body: body('dir-oid-0007') }))).rejects.toMatchObject({ statusCode: 403 })
    const [d] = await t.client<{ entra_oid: string; region_id: string }[]>`SELECT entra_oid, region_id::text AS region_id FROM teammate WHERE id = ${derived}::uuid`
    expect(d!.entra_oid).toBe('bill:9a1e0000-0000-4000-8000-0000000000d1')
    expect(d!.region_id).toBe(rb!.id)
    await t.client`DELETE FROM teammate WHERE id = ${derived}::uuid`

    // Placed by an admin (a placement audit event, no provenance): refused.
    const moved = await seedB('bill:9a1e0000-0000-4000-8000-0000000000d2', 'rio.tanaka@example.com', null)
    await t.client`INSERT INTO audit_event (event_type, subject_kind, subject_id, payload)
                   VALUES ('teammate-org-unit-changed', 'teammate', ${moved}::uuid, '{}'::jsonb)`
    await expect(createHandler(ev({ session: admin(), body: body('dir-oid-0007') }))).rejects.toMatchObject({ statusCode: 403 })
    await t.client`DELETE FROM teammate WHERE id = ${moved}::uuid`

    // Never placed: adopted into the caller's region, and the audit names where it came from.
    const minted = await seedB('bill:9a1e0000-0000-4000-8000-0000000000d3', 'rio.tanaka@example.com', null)
    const res = (await createHandler(ev({ session: admin(), body: body('dir-oid-0007') }))) as { id: string; adopted: boolean }
    expect(res.id).toBe(minted)
    expect(res.adopted).toBe(true)
    const [a] = await t.client<{ payload: Record<string, unknown> }[]>`
      SELECT payload FROM audit_event WHERE event_type = 'teammate-directory-adopted' AND subject_id = ${minted}::uuid`
    expect(a!.payload).toMatchObject({ previous_region_id: rb!.id, previous_org_unit_id: ub!.id, previous_role: 'developer', region_id: regionId })
  })

  it('409s (clean, not 500) when the email is already held by a DIFFERENT real oid', async () => {
    await seedTeammate({ oid: 'some-other-oid', email: 'rio.tanaka@example.com' })
    await expect(
      createHandler(ev({ session: admin(), body: body('dir-oid-0007') })),
    ).rejects.toMatchObject({
      statusCode: 409,
      statusMessage: 'Identity collision',
    })
  })

  it('422s a privileged (onmicrosoft) pick when a matching exclusion pattern is configured', async () => {
    await t.client`INSERT INTO directory_exclusion_pattern (pattern) VALUES ('*@contoso.onmicrosoft.com')`
    await expect(
      createHandler(ev({ session: admin(), body: body('dir-oid-0007-cld') })),
    ).rejects.toMatchObject({ statusCode: 422, statusMessage: 'Excluded directory identity' })
  })

  it('adopt + collision are CASE-INSENSITIVE on the email axis (pre-#121 rows may carry mixed case)', async () => {
    // A historical row inserted before any lowercasing convention.
    const billId = await seedTeammate({ oid: 'bill:66666666-6666-6666-6666-666666666666', email: 'Rio.Tanaka@example.com', source: 'bill' })
    const res = (await createHandler(ev({ session: admin(), body: body('dir-oid-0007') }))) as { id: string; adopted: boolean }
    expect(res.id).toBe(billId) // lower(email) matched despite the stored casing
    expect(res.adopted).toBe(true)
  })

  it('keeps the plain duplicate-oid 409 (already a teammate)', async () => {
    await createHandler(ev({ session: admin(), body: body('dir-oid-0001') }))
    await expect(
      createHandler(ev({ session: admin(), body: body('dir-oid-0001') })),
    ).rejects.toMatchObject({ statusCode: 409, statusMessage: 'Teammate already provisioned' })
  })
})

describe('GET /admin/directory/search — email-level annotation (#121)', () => {
  it('marks the OTHER identity of an existing teammate as teammate_via_other_identity', async () => {
    await seedTeammate({ oid: 'dir-oid-0007-cld', email: 'rio.tanaka@example.com' })
    const res = (await searchHandler(ev({ session: admin(), method: 'GET', url: '/x?q=rio' }))) as {
      results: { oid: string; already_member: boolean; teammate_via_other_identity: boolean }[]
    }
    const primary = res.results.find((r) => r.oid === 'dir-oid-0007')
    const cld = res.results.find((r) => r.oid === 'dir-oid-0007-cld')
    expect(cld?.already_member).toBe(true) // oid-matched
    expect(primary?.already_member).toBe(false)
    expect(primary?.teammate_via_other_identity).toBe(true) // email-matched, different oid
  })

  it('returns where an existing teammate sits but never their role, to a manager', async () => {
    await t.client`
      INSERT INTO teammate (entra_oid, email, display_name, region_id, org_unit_id, role, source)
      VALUES ('dir-oid-0007-cld', 'rio.tanaka-cld@example.com', 'Seeded', ${regionId}::uuid, ${unitId}::uuid, 'platform-admin', 'directory')`
    const manager = { ...admin(), teammateId: '9a1e0000-0000-4000-8000-0000000000e1', role: 'manager' } as Session
    const res = (await searchHandler(ev({ session: manager, method: 'GET', url: '/x?q=rio' }))) as {
      results: Record<string, unknown>[]
    }
    const cld = res.results.find((r) => r.oid === 'dir-oid-0007-cld')
    expect(cld?.already_member).toBe(true)
    expect(cld?.existing_region_code).toBe('tp')
    expect(cld).not.toHaveProperty('existing_role')
  })

  it('does NOT annotate via a bill: placeholder (not "a teammate" in the picker sense)', async () => {
    await seedTeammate({ oid: 'bill:55555555-5555-5555-5555-555555555555', email: 'rio.tanaka@example.com', source: 'bill' })
    const res = (await searchHandler(ev({ session: admin(), method: 'GET', url: '/x?q=rio' }))) as {
      results: { oid: string; teammate_via_other_identity: boolean }[]
    }
    const primary = res.results.find((r) => r.oid === 'dir-oid-0007')
    expect(primary?.teammate_via_other_identity).toBe(false)
  })

  it('refuses to grant Region admin, even to a platform-admin caller (one admin role)', async () => {
    const platform = { ...admin(), role: 'platform-admin' } as Session
    await expect(createHandler(ev({ session: platform, body: { ...body('dir-oid-0007'), role: 'admin' } }))).rejects.toMatchObject({
      statusCode: 403,
      data: { type: 'https://tokenscope.example.com/errors/role-grant', detail: 'Region admin (retired) can no longer be granted.' },
    })
    const [n] = await t.client<{ n: number }[]>`SELECT count(*)::int AS n FROM teammate WHERE entra_oid = 'dir-oid-0007'`
    expect(n!.n).toBe(0)
  })
})
