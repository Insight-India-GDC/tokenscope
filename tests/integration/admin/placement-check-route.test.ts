// @vitest-environment node
/*
 * The placement-check routes (docs/design/placement-check/00-spec.md P4, P5, P8)
 * against real Postgres, with the directory stubbed: start a cycle, run passes
 * through the worker dispatch path, read verdicts, preview a rule.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'
import * as schema from '../../../drizzle/schema'
import { injectTestSession } from '../../helpers/auth'
import type { Session } from '../../../server/utils/auth'
import type { DirectoryUser } from '../../../server/azure/directory'
import type {
  PlacementApplyResponse,
  PlacementCheckResponse,
  PlacementPassResponse,
  PlacementRulePreviewResponse,
} from '../../../shared/placement/placement-check'
import { makePlacementStore } from '../../../server/reconciliation/placement-store'

/*
 * The fake directory: users by oid / email and each user's manager. `fail` makes a
 * person's own lookup throw a Graph 503.
 */
const dir = vi.hoisted(() => ({
  users: new Map<string, { oid: string; email: string; displayName: string; country?: string }>(),
  managers: new Map<string, string>(),
  fail: new Set<string>(),
  lookups: [] as string[],
}))

vi.mock('../../../server/azure/directory', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../server/azure/directory')>()
  const toDir = (u: { oid: string; email: string; displayName: string; country?: string }): DirectoryUser => ({
    oid: u.oid, email: u.email, displayName: u.displayName, mail: u.email, upn: u.email, department: null,
    jobTitle: null, companyName: null, country: u.country ?? null, officeLocation: null, state: null,
    costCenter: null, division: null,
  })
  return {
    ...real,
    getDirectoryUserByOidStrict: async (oid: string) => {
      dir.lookups.push(`oid:${oid}`)
      if (dir.fail.has(oid)) throw new real.GraphHttpError(503, `/users/${oid}`)
      const u = dir.users.get(oid)
      return u ? toDir(u) : null
    },
    getDirectoryUserByMailOrUpnStrict: async (email: string) => {
      dir.lookups.push(`email:${email}`)
      const u = [...dir.users.values()].find((x) => x.email === email)
      return u ? toDir(u) : null
    },
    getUserManager: async (oid: string) => {
      const m = dir.managers.get(oid)
      const u = m ? dir.users.get(m) : undefined
      return u ? { oid: u.oid, email: u.email, name: u.displayName } : null
    },
  }
})

const { default: getCheck } = await import('../../../server/api/v1/admin/placement-check/index.get')
const { default: postCycle } = await import('../../../server/api/v1/admin/placement-check/cycle.post')
const { default: postPass } = await import('../../../server/api/v1/admin/placement-check/pass.post')
const { default: postPreview } = await import('../../../server/api/v1/admin/placement-check/preview.post')
const { default: postApply } = await import('../../../server/api/v1/admin/placement-check/apply.post')

let t: TestDb
let r1 = ''
let r2 = ''
let u1 = ''
let u1b = ''
let u2 = ''
let hold1 = ''
let platformId = ''
let regionAdminId = ''
const ids: Record<string, string> = {}

function ev(opts: { method: string; body?: unknown; session: Session }) {
  const headers: Record<string, string> = {
    host: 'localhost:3450', origin: 'http://localhost:3450', 'content-type': 'application/json', 'user-agent': 'vitest',
  }
  const e = {
    method: opts.method,
    path: '/x',
    context: { params: {} },
    node: {
      req: { method: opts.method, url: '/x', body: opts.body, socket: { remoteAddress: '10.0.0.9' }, get headers() { return headers } },
      res: {
        _headers: {} as Record<string, string | string[]>, statusCode: 200,
        getHeader(n: string) { return this._headers[n.toLowerCase()] },
        setHeader(n: string, v: string | string[]) { this._headers[n.toLowerCase()] = v },
        removeHeader(n: string) { this._headers[n.toLowerCase()] = '' },
        appendHeader(n: string, v: string | string[]) { this._headers[n.toLowerCase()] = v },
        get headersSent() { return false },
      },
    },
  }
  injectTestSession(e as unknown as Parameters<typeof injectTestSession>[0], opts.session)
  return e as unknown as Parameters<typeof getCheck>[0]
}

const platform = (): Session => ({ teammateId: platformId, email: 'pc-platform@x.test', displayName: 'P', role: 'platform-admin', regionId: r1, orgPath: 'pc1.u1', issuedAt: new Date().toISOString() })
const regionAdmin = (): Session => ({ teammateId: regionAdminId, email: 'pc-ra@x.test', displayName: 'RA', role: 'admin', regionId: r1, orgPath: 'pc1.u1', issuedAt: new Date().toISOString() })

async function unit(regionId: string, path: string, code: string, name: string): Promise<string> {
  const [o] = await t.db.insert(schema.orgUnit).values({ regionId, path, code, displayName: name, unitType: 'bu', isCostOwningUnit: true }).returning()
  return o!.id
}

async function person(key: string, orgUnitId: string, regionId: string, opts: { oid?: string; email?: string } = {}) {
  const email = opts.email ?? `${key}@pc.test`
  const [tm] = await t.db.insert(schema.teammate)
    .values({ entraOid: opts.oid ?? `oid-${key}`, email, displayName: key.toUpperCase(), regionId, orgUnitId })
    .returning()
  ids[key] = tm!.id
  return tm!.id
}

const user = (key: string, manager?: string, extra: { country?: string } = {}) => {
  dir.users.set(`oid-${key}`, { oid: `oid-${key}`, email: `${key}@pc.test`, displayName: key.toUpperCase(), ...extra })
  if (manager) dir.managers.set(`oid-${key}`, `oid-${manager}`)
}

const utcDay = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10)

beforeAll(async () => {
  t = await startTestDb()
  process.env.DATABASE_URL = t.url
  const [a] = await t.db.insert(schema.region).values({ code: 'pc1', displayName: 'Region One' }).returning()
  const [b] = await t.db.insert(schema.region).values({ code: 'pc2', displayName: 'Region Two' }).returning()
  r1 = a!.id
  r2 = b!.id
  u1 = await unit(r1, 'pc1.u1', 'pc1-u1', 'Unit One')
  u1b = await unit(r1, 'pc1.u1b', 'pc1-u1b', 'Unit One B')
  u2 = await unit(r2, 'pc2.u2', 'pc2-u2', 'Unit Two')
  hold1 = await makePlacementStore(t.db).unplacedOrgUnitIdForRegion(r1)

  const [p] = await t.db.insert(schema.teammate).values({ entraOid: 'oid-pc-platform', email: 'pc-platform@x.test', role: 'platform-admin', regionId: r1, orgUnitId: u1, isActive: false }).returning()
  platformId = p!.id
  const [ra] = await t.db.insert(schema.teammate).values({ entraOid: 'oid-pc-ra', email: 'pc-ra@x.test', role: 'admin', regionId: r1, orgUnitId: u1, isActive: false }).returning()
  regionAdminId = ra!.id

  // boss owns Unit One; svp leads Region One; the directory chain tops out above them.
  const bossId = await person('boss', u1, r1)
  await t.client`INSERT INTO cou_owner (org_unit_id, teammate_id) VALUES (${u1}::uuid, ${bossId}::uuid)`
  await t.client`INSERT INTO region_leader (region_id, leader_oid, leader_email) VALUES (${r1}::uuid, 'oid-svp', 'svp@pc.test')`
  user('boss')
  user('svp')
  user('mgr', 'svp')

  await person('alice', u1, r1) // ok, placed by the chain
  await makePlacementStore(t.db).setPlacementProvenance(ids.alice!, { via: 'manager-chain', ownerOid: 'oid-boss' })
  user('alice', 'boss')
  await person('bob', hold1, r1) // place
  user('bob', 'boss')
  await person('cara', u2, r2) // move-region
  user('cara', 'boss')
  await person('dan', hold1, r1) // needs-owner
  user('dan', 'mgr')
  await person('erin', hold1, r1) // lookup-failed
  user('erin', 'boss')
  dir.fail.add('oid-erin')
  await person('gus', u1b, r1) // unit-unverified
  user('gus', 'svp', { country: 'Australia' })
  await person('fay', u1b, r1) // manual
  user('fay', 'boss')
  await t.client`INSERT INTO audit_event (event_type, actor_teammate_id, subject_kind, subject_id, payload)
    VALUES ('teammate-org-unit-changed', ${platformId}::uuid, 'teammate', ${ids.fay}::uuid, '{}'::jsonb)`
  await person('hal', hold1, r1, { oid: 'bill:9a1e0000-0000-4000-8000-000000000001', email: 'hal@pc.test' }) // place, by email
  user('hal', 'boss')
  await person('demo', hold1, r1, { email: 'demo-zed@pc.test' }) // excluded

  await t.db.insert(schema.actualSpend).values([
    { teammateId: ids.bob!, date: utcDay(0), tool: 'claude-code', inputTokens: 0n, outputTokens: 0n, costUsd: '12.5', source: 'anthropic-analytics-api' },
    { teammateId: ids.bob!, date: utcDay(-40), tool: 'claude-code', inputTokens: 0n, outputTokens: 0n, costUsd: '99', source: 'anthropic-analytics-api' },
  ])
}, 180_000)

afterAll(async () => { await stopTestDb(t) }, 30_000)

// boss, alice, bob, cara, dan, erin, gus, fay, hal; the admins are inactive and demo is excluded.
const POPULATION = 9

describe('placement-check routes', () => {
  it('a region admin gets 403 on every route', async () => {
    await expect(getCheck(ev({ method: 'GET', session: regionAdmin() }))).rejects.toMatchObject({ statusCode: 403 })
    await expect(postCycle(ev({ method: 'POST', session: regionAdmin() }))).rejects.toMatchObject({ statusCode: 403 })
    await expect(postPass(ev({ method: 'POST', session: regionAdmin() }))).rejects.toMatchObject({ statusCode: 403 })
    await expect(postPreview(ev({ method: 'POST', session: regionAdmin(), body: { attribute: 'country', match_mode: 'exact', match_value: 'x', region_id: r1 } }))).rejects.toMatchObject({ statusCode: 403 })
  })

  it('a pass before any cycle is a 409 and nothing is gathered', async () => {
    await expect(postPass(ev({ method: 'POST', session: platform() }))).rejects.toMatchObject({ statusCode: 409 })
    const [n] = await t.client<{ n: number }[]>`SELECT count(*)::int AS n FROM placement_evidence`
    expect(n!.n).toBe(0)
  })

  it('a cycle, then passes in batches until nothing remains; every considered row is stamped', async () => {
    const cycle = (await postCycle(ev({ method: 'POST', session: platform() }))) as { id: string; startedAt: string }
    expect(cycle.id).toMatch(/^[0-9a-f-]{36}$/)
    const [audit] = await t.client<{ n: number }[]>`SELECT count(*)::int AS n FROM audit_event WHERE event_type = 'placement-check-started' AND subject_id = ${cycle.id}::uuid`
    expect(audit!.n).toBe(1)

    const first = (await postPass(ev({ method: 'POST', session: platform() }))) as PlacementPassResponse
    expect(first.checked).toBe(POPULATION)
    expect(first.errors).toBe(1) // erin
    expect(first.remaining).toBe(0)
    const runs = await t.client<{ status: string }[]>`SELECT status FROM worker_run WHERE worker_name = 'placement-check'`
    expect(runs.map((r) => r.status)).toEqual(['success'])

    const rows = await t.client<{ teammate_id: string; walk_end: string; lookup: string; cycle_id: string }[]>`
      SELECT teammate_id::text, walk_end, lookup, cycle_id::text FROM placement_evidence`
    expect(rows).toHaveLength(POPULATION)
    expect(rows.every((r) => r.cycle_id === cycle.id)).toBe(true)
    expect(rows.find((r) => r.teammate_id === ids.erin)!.walk_end).toBe('graph-error')
    expect(rows.find((r) => r.teammate_id === ids.hal)!.lookup).toBe('email')
    expect(rows.find((r) => r.teammate_id === ids.alice)!.lookup).toBe('oid')
    expect(rows.find((r) => r.teammate_id === ids.demo)).toBeUndefined()

    // Nothing remains: a further pass considers nobody.
    dir.lookups.length = 0
    const again = (await postPass(ev({ method: 'POST', session: platform() }))) as PlacementPassResponse
    expect(again).toEqual({ checked: 0, errors: 0, remaining: 0 })
    expect(dir.lookups).toEqual([])
  })

  it('retryFailed re-gathers only the failed rows of the current cycle; a re-failure is stamped again', async () => {
    dir.lookups.length = 0
    const retry = (await postPass(ev({ method: 'POST', session: platform(), body: { retryFailed: true } }))) as PlacementPassResponse
    expect(retry).toEqual({ checked: 1, errors: 1, remaining: 0 })
    expect(dir.lookups).toEqual(['oid:oid-erin'])
    const [erin] = await t.client<{ walk_end: string }[]>`SELECT walk_end FROM placement_evidence WHERE teammate_id = ${ids.erin}::uuid`
    expect(erin!.walk_end).toBe('graph-error')
  })

  it('GET classifies each person against the current config', async () => {
    const res = (await getCheck(ev({ method: 'GET', session: platform() }))) as PlacementCheckResponse
    const verdictOf = (key: string) => res.rows.find((r) => r.teammateId === ids[key])?.verdict
    expect({
      alice: verdictOf('alice'), bob: verdictOf('bob'), cara: verdictOf('cara'), dan: verdictOf('dan'),
      erin: verdictOf('erin'), gus: verdictOf('gus'), fay: verdictOf('fay'), hal: verdictOf('hal'),
    }).toEqual({
      alice: 'ok', bob: 'place', cara: 'move-region', dan: 'needs-owner',
      erin: 'lookup-failed', gus: 'unit-unverified', fay: 'manual', hal: 'place',
    })
    expect(res.rows.find((r) => r.teammateId === ids.demo)).toBeUndefined()
    expect(res.remaining).toBe(0)
    expect(res.failedThisCycle).toBe(1) // erin
    expect(res.cycle).not.toBeNull()
    expect(res.evidenceAge.oldest).not.toBeNull()

    const bob = res.rows.find((r) => r.teammateId === ids.bob)!
    expect(bob.spend30d).toBeCloseTo(12.5) // the 40-day-old bill is outside the window
    expect(bob.current).toMatchObject({ regionId: r1, regionName: 'Region One', orgUnitId: hold1, onHolding: true })
    expect(bob.derived).toMatchObject({ regionId: r1, orgUnitId: u1, orgUnitName: 'Unit One', onHolding: false, step: 'chain-unit' })
    expect(bob.why.owner).toEqual({ oid: 'oid-boss', name: 'BOSS' })
    expect(bob.why.chain.map((l) => l.oid)).toEqual(['oid-bob', 'oid-boss'])
    expect(bob.seen).toEqual({ regionId: r1, orgUnitId: hold1, provenance: null })
    expect(res.rows[0]!.teammateId).toBe(ids.bob) // highest spend first

    const dan = res.rows.find((r) => r.teammateId === ids.dan)!
    expect(dan.derived).toMatchObject({ regionId: r1, orgUnitId: null, orgUnitName: null, onHolding: true, step: 'chain-region' })
    expect(dan.why.leader).toEqual({ oid: 'oid-svp', name: 'SVP' })

    // seen.provenance is the exact strings Apply's compare-and-set reads back.
    const alice = res.rows.find((r) => r.teammateId === ids.alice)!
    const [meta] = await t.client<{ via: string; owner: string; at: string }[]>`
      SELECT metadata->>'placedVia' AS via, metadata->>'placedOwnerOid' AS owner, metadata->>'placedAt' AS at
      FROM teammate WHERE id = ${ids.alice}::uuid`
    expect(alice.seen.provenance).toEqual({ placedVia: meta!.via, placedOwnerOid: meta!.owner, placedAt: meta!.at })
    expect(alice.manual).toBe(false)

    const fay = res.rows.find((r) => r.teammateId === ids.fay)!
    expect(fay.manual).toBe(true)

    const place = res.summary.find((s) => s.verdict === 'place')!
    expect(place.count).toBe(2)
    expect(place.spend30d).toBeCloseTo(12.5)
  })

  it('GET reads the CURRENT config: a new region rule is overruled by the chain leader, and a new owner turns needs-owner into place', async () => {
    await t.client`INSERT INTO directory_region_rule (attribute, match_mode, match_value, match_value_raw, region_id)
      VALUES ('country', 'exact', 'australia', 'Australia', ${r2}::uuid)`
    const mgrId = await person('mgr', u1b, r1)
    await t.client`INSERT INTO cou_owner (org_unit_id, teammate_id) VALUES (${u1b}::uuid, ${mgrId}::uuid)`
    const res = (await getCheck(ev({ method: 'GET', session: platform() }))) as PlacementCheckResponse
    const gus = res.rows.find((r) => r.teammateId === ids.gus)!
    expect(gus.verdict).toBe('unit-unverified')
    expect(gus.why.overruledRule).toEqual({ attribute: 'country', value: 'australia' })
    expect(res.rows.find((r) => r.teammateId === ids.dan)!.verdict).toBe('place')
    expect(res.remaining).toBe(1) // mgr is new and not gathered in this cycle
    await t.client`DELETE FROM cou_owner WHERE teammate_id = ${mgrId}::uuid`
    await t.client`UPDATE teammate SET is_active = false WHERE id = ${mgrId}::uuid`
    await t.client`DELETE FROM directory_region_rule WHERE match_value = 'australia'`
  })

  it('preview lists only people whose derived home the proposed rule changes', async () => {
    const res = (await postPreview(ev({
      method: 'POST', session: platform(),
      body: { attribute: 'country', match_mode: 'exact', match_value: '  AUSTRALIA ', org_unit_id: u1 },
    }))) as PlacementRulePreviewResponse
    expect(res.changes.map((c) => c.teammateId)).toEqual([ids.gus])
    expect(res.changes[0]!.from).toMatchObject({ regionId: r1, orgUnitId: null, onHolding: true })
    expect(res.changes[0]!.to).toMatchObject({ regionId: r1, orgUnitId: u1, orgUnitName: 'Unit One', onHolding: false })
    expect(res.unchecked).toBe(1) // erin's failed lookup
    const [rules] = await t.client<{ n: number }[]>`SELECT count(*)::int AS n FROM directory_region_rule`
    expect(rules!.n).toBe(0) // preview writes nothing
  })

  it('preview validates like the rule upsert: a non-cost-owning unit target is 422, a bad body 400', async () => {
    await expect(postPreview(ev({
      method: 'POST', session: platform(),
      body: { attribute: 'country', match_mode: 'exact', match_value: 'australia', org_unit_id: hold1 },
    }))).rejects.toMatchObject({ statusCode: 422 })
    await expect(postPreview(ev({
      method: 'POST', session: platform(),
      body: { attribute: 'country', match_mode: 'exact', match_value: 'australia', region_id: r1, org_unit_id: u1 },
    }))).rejects.toMatchObject({ statusCode: 400 })
  })

  it('a successful retry replaces the failed evidence', async () => {
    dir.lookups.length = 0
    dir.fail.delete('oid-erin')
    const retry = (await postPass(ev({ method: 'POST', session: platform(), body: { retryFailed: true } }))) as PlacementPassResponse
    expect(retry).toEqual({ checked: 1, errors: 0, remaining: 0 })
    expect(dir.lookups).toEqual(['oid:oid-erin'])
    const res = (await getCheck(ev({ method: 'GET', session: platform() }))) as PlacementCheckResponse
    expect(res.rows.find((r) => r.teammateId === ids.erin)!.verdict).toBe('place')
    expect(res.failedThisCycle).toBe(0)
  })

  it('GET → Apply round trip: the rows the page received, sent back as-is, move', async () => {
    const wire = JSON.parse(JSON.stringify(await getCheck(ev({ method: 'GET', session: platform() })))) as PlacementCheckResponse
    const picked = wire.rows.filter((r) => r.teammateId === ids.bob || r.teammateId === ids.cara)
    expect(picked.map((r) => r.verdict).sort()).toEqual(['move-region', 'place'])
    const items = picked.map((r) => ({
      teammateId: r.teammateId,
      seen: r.seen,
      target: { regionId: r.derived.regionId!, orgUnitId: r.derived.orgUnitId },
    }))
    const res = (await postApply(ev({ method: 'POST', session: platform(), body: { items } }))) as PlacementApplyResponse
    expect(res.results.map((r) => r.outcome)).toEqual(['moved', 'moved'])
    const after = (await getCheck(ev({ method: 'GET', session: platform() }))) as PlacementCheckResponse
    expect(after.rows.find((r) => r.teammateId === ids.bob)!.current).toMatchObject({ regionId: r1, orgUnitId: u1 })
    expect(after.rows.find((r) => r.teammateId === ids.cara)!.current).toMatchObject({ regionId: r1, orgUnitId: u1 })
    expect(after.rows.filter((r) => r.teammateId === ids.bob || r.teammateId === ids.cara).map((r) => r.verdict)).toEqual(['ok', 'ok'])
  })

  it('failedThisCycle counts only the current cycle: a failure from an earlier cycle cannot be retried', async () => {
    await t.client`UPDATE placement_evidence SET walk_end = 'graph-error' WHERE teammate_id = ${ids.erin}::uuid`
    await postCycle(ev({ method: 'POST', session: platform() }))
    const res = (await getCheck(ev({ method: 'GET', session: platform() }))) as PlacementCheckResponse
    expect(res.rows.find((r) => r.teammateId === ids.erin)!.why.walkEnd).toBe('graph-error')
    expect(res.failedThisCycle).toBe(0)
    const retry = (await postPass(ev({ method: 'POST', session: platform(), body: { retryFailed: true } }))) as PlacementPassResponse
    expect(retry.checked).toBe(0)
  })
})
