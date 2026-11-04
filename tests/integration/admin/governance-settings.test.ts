// @vitest-environment node
/*
 * Governance dials (mig 0049): seeded platform defaults, the resolver's
 * region-over-platform precedence + fail-loud missing-key contract, and the
 * admin PUT's allowlist / bounds / scope-authority / audit behaviour.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { sql } from 'drizzle-orm'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'
import * as schema from '../../../drizzle/schema'
import { injectTestSession } from '../../helpers/auth'
import type { Session } from '../../../server/utils/auth'
import {
  GOV_VELOCITY_SPIKE_THRESHOLD,
  GOV_RECONCILIATION_GAP_THRESHOLD,
  GOV_RECONCILIATION_EPSILON_USD,
  GOV_RECONCILIATION_LAG_BUFFER_HOURS,
  GOVERNANCE_SETTING_KEYS,
  resolveGovernanceSetting,
  resolveGovernanceSettings,
  loadGovernanceSettingResolver,
} from '../../../server/utils/governance-settings'
import adminGet from '../../../server/api/v1/admin/governance-settings/index.get'
import adminPut from '../../../server/api/v1/admin/governance-settings/index.put'
import resolvedGet from '../../../server/api/v1/governance/settings.get'

let t: TestDb
let regionId: string
let otherRegionId: string
let ouId: string
let finopsId: string
let adminId: string
let devId: string

beforeAll(async () => {
  t = await startTestDb()
  process.env.DATABASE_URL = t.url
  const [r] = await t.db.insert(schema.region).values({ code: 'gs-r', displayName: 'GS R' }).returning()
  regionId = r!.id
  const [r2] = await t.db.insert(schema.region).values({ code: 'gs-o', displayName: 'GS Other' }).returning()
  otherRegionId = r2!.id
  const [o] = await t.db
    .insert(schema.orgUnit)
    .values({ regionId, path: 'gs.svc', code: 'gs-svc', displayName: 'Svc', unitType: 'bu' })
    .returning()
  ouId = o!.id
  const [f] = await t.db
    .insert(schema.teammate)
    .values({ entraOid: 'oid-gs-fin', email: 'gs-fin@x.test', role: 'platform-admin', regionId, orgUnitId: ouId })
    .returning()
  finopsId = f!.id
  const [a] = await t.db
    .insert(schema.teammate)
    .values({ entraOid: 'oid-gs-admin', email: 'gs-admin@x.test', role: 'admin', regionId, orgUnitId: ouId })
    .returning()
  adminId = a!.id
  const [d] = await t.db
    .insert(schema.teammate)
    .values({ entraOid: 'oid-gs-dev', email: 'gs-dev@x.test', role: 'developer', regionId, orgUnitId: ouId })
    .returning()
  devId = d!.id
}, 120_000)

afterAll(async () => {
  await stopTestDb(t)
}, 30_000)

function ev(opts: { method: string; body?: unknown; session: Session }) {
  const headers: Record<string, string> = { host: 'localhost:3450', origin: 'http://localhost:3450' }
  const e = {
    method: opts.method,
    path: '/x',
    context: { params: {} },
    node: {
      req: {
        method: opts.method,
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
  return e as unknown as Parameters<typeof adminPut>[0]
}

const finops = (): Session => ({ teammateId: finopsId, email: 'gs-fin@x.test', displayName: 'Fin', role: 'platform-admin', regionId, orgPath: 'gs.svc' })
const admin = (): Session => ({ teammateId: adminId, email: 'gs-admin@x.test', displayName: 'Admin', role: 'admin', regionId, orgPath: 'gs.svc' })
const dev = (): Session => ({ teammateId: devId, email: 'gs-dev@x.test', displayName: 'Dev', role: 'developer', regionId, orgPath: 'gs.svc' })

describe('resolver precedence + fail-loud', () => {
  it('returns the seeded platform defaults (the previously hard-coded constants)', async () => {
    const resolved = await resolveGovernanceSettings(t.db, [
      GOV_VELOCITY_SPIKE_THRESHOLD,
      GOV_RECONCILIATION_GAP_THRESHOLD,
      GOV_RECONCILIATION_EPSILON_USD,
      GOV_RECONCILIATION_LAG_BUFFER_HOURS,
    ], regionId)
    expect(resolved).toEqual({
      [GOV_VELOCITY_SPIKE_THRESHOLD]: 0.25,
      [GOV_RECONCILIATION_GAP_THRESHOLD]: 0.1,
      [GOV_RECONCILIATION_EPSILON_USD]: 0.01,
      [GOV_RECONCILIATION_LAG_BUFFER_HOURS]: 48,
    })
  })

  it('a region override beats the platform row; other regions still inherit', async () => {
    await adminPut(ev({
      method: 'PUT',
      body: { key: GOV_VELOCITY_SPIKE_THRESHOLD, scope_type: 'region', region_id: regionId, value: 0.5 },
      session: admin(),
    }))
    expect(await resolveGovernanceSetting(t.db, GOV_VELOCITY_SPIKE_THRESHOLD, regionId)).toBe(0.5)
    expect(await resolveGovernanceSetting(t.db, GOV_VELOCITY_SPIKE_THRESHOLD, otherRegionId)).toBe(0.25)
    // No regionId → platform.
    expect(await resolveGovernanceSetting(t.db, GOV_VELOCITY_SPIKE_THRESHOLD)).toBe(0.25)
    // The snapshot resolver agrees.
    const fn = await loadGovernanceSettingResolver(t.db, GOV_VELOCITY_SPIKE_THRESHOLD)
    expect(fn(regionId)).toBe(0.5)
    expect(fn(otherRegionId)).toBe(0.25)
    expect(fn(null)).toBe(0.25)
  })

  it('a missing key throws (broken deploy, not a silent default)', async () => {
    await expect(resolveGovernanceSetting(t.db, 'no.such_dial', regionId)).rejects.toThrow(/no platform row/)
    await expect(loadGovernanceSettingResolver(t.db, 'no.such_dial')).rejects.toThrow(/no platform row/)
  })
})

describe('PUT validation + scope authority', () => {
  it('rejects an unknown key with 400', async () => {
    await expect(
      adminPut(ev({ method: 'PUT', body: { key: 'velocity.bogus', scope_type: 'platform', value: 0.3 }, session: finops() })),
    ).rejects.toMatchObject({ statusCode: 400 })
  })

  it('rejects out-of-bounds values with 400 (exclusive minimums included)', async () => {
    // spike threshold is (0, 10] — zero is OUT.
    await expect(
      adminPut(ev({ method: 'PUT', body: { key: GOV_VELOCITY_SPIKE_THRESHOLD, scope_type: 'platform', value: 0 }, session: finops() })),
    ).rejects.toMatchObject({ statusCode: 400 })
    // gap threshold is (0, 1].
    await expect(
      adminPut(ev({ method: 'PUT', body: { key: GOV_RECONCILIATION_GAP_THRESHOLD, scope_type: 'platform', value: 1.5 }, session: finops() })),
    ).rejects.toMatchObject({ statusCode: 400 })
    // lag hours is [0, 720] — zero is IN, 721 is out.
    await expect(
      adminPut(ev({ method: 'PUT', body: { key: GOV_RECONCILIATION_LAG_BUFFER_HOURS, scope_type: 'platform', value: 721 }, session: finops() })),
    ).rejects.toMatchObject({ statusCode: 400 })
  })

  it('a region admin cannot write the PLATFORM scope (403)', async () => {
    await expect(
      adminPut(ev({ method: 'PUT', body: { key: GOV_RECONCILIATION_GAP_THRESHOLD, scope_type: 'platform', value: 0.2 }, session: admin() })),
    ).rejects.toMatchObject({ statusCode: 403 })
  })

  it('a region admin cannot write ANOTHER region (403 via requireRegionScope)', async () => {
    await expect(
      adminPut(ev({
        method: 'PUT',
        body: { key: GOV_RECONCILIATION_GAP_THRESHOLD, scope_type: 'region', region_id: otherRegionId, value: 0.2 },
        session: admin(),
      })),
    ).rejects.toMatchObject({ statusCode: 403 })
  })

  it('region scope against a non-existent region UUID → 404', async () => {
    await expect(
      adminPut(ev({
        method: 'PUT',
        body: { key: GOV_RECONCILIATION_GAP_THRESHOLD, scope_type: 'region', region_id: '00000000-0000-0000-0000-000000000001', value: 0.2 },
        session: finops(),
      })),
    ).rejects.toMatchObject({ statusCode: 404 })
  })

  it('platform-admin sets the platform default; repeated PUTs upsert one row; audited with before/after', async () => {
    await adminPut(ev({ method: 'PUT', body: { key: GOV_RECONCILIATION_EPSILON_USD, scope_type: 'platform', value: 0.05 }, session: finops() }))
    await adminPut(ev({ method: 'PUT', body: { key: GOV_RECONCILIATION_EPSILON_USD, scope_type: 'platform', value: 0.02 }, session: finops() }))
    const rows = await t.db.execute<{ n: string }>(sql`
      SELECT COUNT(*)::text AS n FROM governance_setting
      WHERE key = ${GOV_RECONCILIATION_EPSILON_USD} AND scope_type = 'platform'
    `)
    expect(Number([...rows][0]!.n)).toBe(1)
    expect(await resolveGovernanceSetting(t.db, GOV_RECONCILIATION_EPSILON_USD)).toBe(0.02)

    const audits = await t.client<{ payload: { key: string; before: number | null; after: number } }[]>`
      SELECT payload::jsonb AS payload FROM audit_event
      WHERE event_type = 'governance-setting-changed'
        AND payload->>'key' = ${GOV_RECONCILIATION_EPSILON_USD}
      ORDER BY ts_recorded
    `
    expect(audits.length).toBe(2)
    expect(audits[0]!.payload.before).toBe(0.01) // the seeded default
    expect(audits[0]!.payload.after).toBe(0.05)
    expect(audits[1]!.payload.before).toBe(0.05)
    expect(audits[1]!.payload.after).toBe(0.02)
  })
})

describe('projects.pm_own_region_only — a platform-only switch (A4)', () => {
  const KEY = 'projects.pm_own_region_only'

  it('is seeded at 0 and accepts exactly 0 or 1', async () => {
    expect(await resolveGovernanceSetting(t.db, KEY)).toBe(0)
    await expect(
      adminPut(ev({ method: 'PUT', body: { key: KEY, scope_type: 'platform', value: 0.5 }, session: finops() })),
    ).rejects.toMatchObject({ statusCode: 400 })
    await adminPut(ev({ method: 'PUT', body: { key: KEY, scope_type: 'platform', value: 1 }, session: finops() }))
    expect(await resolveGovernanceSetting(t.db, KEY)).toBe(1)
    await adminPut(ev({ method: 'PUT', body: { key: KEY, scope_type: 'platform', value: 0 }, session: finops() }))
  })

  it('refuses a region override, even from platform-admin', async () => {
    for (const session of [finops(), admin()]) {
      await expect(
        adminPut(ev({ method: 'PUT', body: { key: KEY, scope_type: 'region', region_id: regionId, value: 1 }, session })),
      ).rejects.toMatchObject({ statusCode: 400 })
    }
    const rows = await t.client`SELECT 1 FROM governance_setting WHERE key = ${KEY} AND scope_type = 'region'`
    expect(rows.length).toBe(0)
  })

  it('the admin GET marks it as a platform-only switch', async () => {
    const got = (await adminGet(ev({ method: 'GET', session: finops() }))) as { switch_keys: string[]; platform_only_keys: string[] }
    expect(got.switch_keys).toEqual([KEY])
    expect(got.platform_only_keys).toEqual([KEY])
  })
})

describe('read endpoints', () => {
  it('resolved GET serves any authenticated user their region-effective dials + override keys', async () => {
    const got = (await resolvedGet(ev({ method: 'GET', session: dev() }))) as {
      settings: Record<string, number>
      scope: { region_id: string; overrides: string[] }
    }
    expect(got.scope.region_id).toBe(regionId)
    // The region override set above wins; the rest are platform values.
    expect(got.settings[GOV_VELOCITY_SPIKE_THRESHOLD]).toBe(0.5)
    expect(got.settings[GOV_RECONCILIATION_GAP_THRESHOLD]).toBe(0.1)
    expect(got.scope.overrides).toEqual([GOV_VELOCITY_SPIKE_THRESHOLD])
  })

  it('admin list: platform rows + own-region overrides for a region admin', async () => {
    const got = (await adminGet(ev({ method: 'GET', session: admin() }))) as {
      platform: { key: string; value: number }[]
      region_overrides: { key: string; region_id: string; value: number }[]
    }
    // Every allowlisted dial must have a seeded platform baseline — the
    // resolver throws rather than inventing one, so a missing seed is a broken
    // deploy. Asserted against the key list rather than a literal, so adding a
    // dial cannot make this pass by being forgotten here.
    expect(got.platform.map((p) => p.key).sort()).toEqual([...GOVERNANCE_SETTING_KEYS].sort())
    expect(got.region_overrides).toHaveLength(1)
    expect(got.region_overrides[0]).toMatchObject({
      key: GOV_VELOCITY_SPIKE_THRESHOLD,
      region_id: regionId,
      value: 0.5,
    })
  })
})
