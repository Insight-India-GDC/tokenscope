// @vitest-environment node
/*
 * The Org setup routes (docs/design/org-setup/00-spec.md): tree, preview, units and
 * decisions against real Postgres, over evidence seeded straight into
 * placement_evidence, with the directory stubbed for the owner picks.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'
import * as schema from '../../../drizzle/schema'
import { injectTestSession } from '../../helpers/auth'
import type { Session } from '../../../server/utils/auth'
import type { DirectoryUser, GraphCallOptions } from '../../../server/azure/directory'
import type {
  OrgSetupDecisionsResponse,
  OrgSetupPreviewResponse,
  OrgSetupUnitsResponse,
  OrgTreeResponse,
} from '../../../shared/org-setup/contract'
import { makePlacementStore } from '../../../server/reconciliation/placement-store'
import { upsertPlacementEvidence } from '../../../server/reconciliation/placement-check-store'
import { directoryAttributesOf } from '../../../server/reconciliation/region-derivation'

const dir = vi.hoisted(() => ({
  users: new Map<string, { oid: string; email: string; displayName: string }>(),
  /** Every strict lookup the route made, with the deadline it was handed. */
  calls: [] as { oid: string; deadline: number | undefined }[],
  /** Runs inside each strict lookup, before it answers (the budget test moves the clock here). */
  onLookup: null as ((oid: string) => void) | null,
}))

/*
 * The STRICT lookup is what units.post uses, so that a thrown Graph failure is the
 * item's `directory-error`. Only it is stubbed: the lenient getDirectoryUserByOid
 * stays real and resolves against the built-in mock directory, where none of
 * these people exist — a route that slipped back to it would report every owner
 * as `directory-user`.
 */
vi.mock('../../../server/azure/directory', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../server/azure/directory')>()
  return {
    ...real,
    getDirectoryUserByOidStrict: async (oid: string, call?: GraphCallOptions): Promise<DirectoryUser | null> => {
      dir.calls.push({ oid, deadline: call?.deadline })
      dir.onLookup?.(oid)
      if (oid === 'oid-boom') throw new real.GraphHttpError(503, `/users/${oid}`)
      const u = dir.users.get(oid)
      return u
        ? {
            oid: u.oid, email: u.email, displayName: u.displayName, mail: u.email, upn: u.email, department: null,
            jobTitle: null, companyName: null, country: null, officeLocation: null, state: null, costCenter: null, division: null,
          }
        : null
    },
  }
})

const { default: getTree } = await import('../../../server/api/v1/admin/org-setup/tree.get')
const { default: postPreview } = await import('../../../server/api/v1/admin/org-setup/preview.post')
const { default: postUnits, UNITS_REQUEST_BUDGET_MS } = await import('../../../server/api/v1/admin/org-setup/units.post')
const { default: getDecisions } = await import('../../../server/api/v1/admin/org-setup/decisions.get')

let t: TestDb
let r1 = ''
let r2 = ''
let u1 = ''
let u2 = ''
let hold1 = ''
let hold2 = ''
let cycleId = ''
let platformId = ''
let regionAdminId = ''
const ids: Record<string, string> = {}

function ev(opts: { method: string; body?: unknown; session: Session; origin?: string }) {
  const headers: Record<string, string> = {
    host: 'localhost:3450', origin: opts.origin ?? 'http://localhost:3450', 'content-type': 'application/json', 'user-agent': 'vitest',
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
  return e as unknown as Parameters<typeof getTree>[0]
}

const platform = (): Session => ({ teammateId: platformId, email: 'os-platform@x.test', displayName: 'P', role: 'platform-admin', regionId: r1, orgPath: 'os1.u1', issuedAt: new Date().toISOString() })
const regionAdmin = (): Session => ({ teammateId: regionAdminId, email: 'os-ra@x.test', displayName: 'RA', role: 'admin', regionId: r1, orgPath: 'os1.u1', issuedAt: new Date().toISOString() })

async function unit(regionId: string, path: string, code: string, name: string): Promise<string> {
  const [o] = await t.db.insert(schema.orgUnit).values({ regionId, path, code, displayName: name, unitType: 'bu', isCostOwningUnit: true }).returning()
  return o!.id
}

/** A teammate with evidence: `chain` is the managers above them, nearest first. */
async function person(key: string, chain: string[], home: { regionId: string; orgUnitId: string }, opts: { walkEnd?: 'graph-error' } = {}) {
  const [tm] = await t.db.insert(schema.teammate)
    .values({ entraOid: `oid-${key}`, email: `${key}@os.test`, displayName: key.toUpperCase(), ...home })
    .returning()
  ids[key] = tm!.id
  dir.users.set(`oid-${key}`, { oid: `oid-${key}`, email: `${key}@os.test`, displayName: key.toUpperCase() })
  const links = [key, ...chain].map((k) => ({ oid: `oid-${k}`, name: k === 'apac' ? 'Grace Liu' : k.toUpperCase(), email: `${k}@os.test` }))
  await upsertPlacementEvidence(t.db, {
    teammateId: tm!.id,
    cycleId,
    lookup: 'oid',
    evidence: { attributes: directoryAttributesOf(null), chain: opts.walkEnd ? links.slice(0, 1) : links, walkEnd: opts.walkEnd ?? 'top-of-chart' },
  })
}

const utcDay = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10)
const setTop = (oid: string | null) => t.client`UPDATE org_setup_setting SET top_oid = ${oid}, top_name = ${oid ? 'CEO' : null}`

/*
 * ceo
 * ├─ apac (Grace Liu, leads Region Two; not a user)
 * │   ├─ mgra → a1, a2, a3       on Region One's Unplaced: move to Region Two, a new team
 * │   └─ ownerx (owns Unit One) → x1
 * ├─ emea (leads Region Two)  → e1 on Region Two's Unplaced
 * └─ misc → n1                   no region (no-signal)
 * o1 → other (outside the top); f1 failed lookup
 * never1 (Region One's Unplaced) and never2 (Unit Two): in the population, never read
 */
beforeAll(async () => {
  t = await startTestDb()
  process.env.DATABASE_URL = t.url
  const [a] = await t.db.insert(schema.region).values({ code: 'os1', displayName: 'Region One' }).returning()
  const [b] = await t.db.insert(schema.region).values({ code: 'os2', displayName: 'Region Two' }).returning()
  r1 = a!.id
  r2 = b!.id
  u1 = await unit(r1, 'os1.u1', 'os1-u1', 'Unit One')
  u2 = await unit(r2, 'os2.u2', 'os2-u2', 'Unit Two')
  hold1 = await makePlacementStore(t.db).unplacedOrgUnitIdForRegion(r1)
  hold2 = await makePlacementStore(t.db).unplacedOrgUnitIdForRegion(r2)
  const [p] = await t.db.insert(schema.teammate).values({ entraOid: 'oid-os-platform', email: 'os-platform@x.test', role: 'platform-admin', regionId: r1, orgUnitId: u1, isActive: false }).returning()
  platformId = p!.id
  const [ra] = await t.db.insert(schema.teammate).values({ entraOid: 'oid-os-ra', email: 'os-ra@x.test', role: 'admin', regionId: r1, orgUnitId: u1, isActive: false }).returning()
  regionAdminId = ra!.id
  const [c] = await t.client<{ id: string }[]>`INSERT INTO placement_check_cycle (started_by) VALUES (NULL) RETURNING id::text AS id`
  cycleId = c!.id

  const R1H = { regionId: r1, orgUnitId: hold1 }
  await person('mgra', ['apac', 'ceo'], R1H)
  await person('a1', ['mgra', 'apac', 'ceo'], R1H)
  await person('a2', ['mgra', 'apac', 'ceo'], R1H)
  await person('a3', ['mgra', 'apac', 'ceo'], R1H)
  await person('ownerx', ['apac', 'ceo'], { regionId: r1, orgUnitId: u1 })
  await person('x1', ['ownerx', 'apac', 'ceo'], { regionId: r1, orgUnitId: u1 })
  await person('e1', ['emea', 'ceo'], { regionId: r2, orgUnitId: hold2 })
  await person('n1', ['misc', 'ceo'], R1H)
  await person('o1', ['other'], R1H)
  await person('f1', [], R1H, { walkEnd: 'graph-error' })
  // Population members with no evidence row at all: coverage must still count them.
  await t.db.insert(schema.teammate).values([
    { entraOid: 'oid-never1', email: 'never1@os.test', displayName: 'NEVER1', ...R1H },
    { entraOid: 'oid-never2', email: 'never2@os.test', displayName: 'NEVER2', regionId: r2, orgUnitId: u2 },
  ])
  await t.client`INSERT INTO cou_owner (org_unit_id, teammate_id) VALUES (${u1}::uuid, ${ids.ownerx!}::uuid)`
  await t.client`INSERT INTO region_leader (region_id, leader_oid, leader_email) VALUES (${r2}::uuid, 'oid-apac', 'apac@os.test')`
  await t.client`INSERT INTO region_leader (region_id, leader_oid, leader_email) VALUES (${r2}::uuid, 'oid-emea', 'emea@os.test')`
  await t.db.insert(schema.actualSpend).values([
    { teammateId: ids.a1!, date: utcDay(0), tool: 'claude-code', inputTokens: 0n, outputTokens: 0n, costUsd: '7.5', source: 'anthropic-analytics-api' },
  ])
}, 180_000)

afterAll(async () => { await stopTestDb(t) }, 30_000)

const EMPTY = { leaders: [], newUnits: [] }

describe('org-setup routes: access', () => {
  it('a region admin gets 403 on every route', async () => {
    await expect(getTree(ev({ method: 'GET', session: regionAdmin() }))).rejects.toMatchObject({ statusCode: 403 })
    await expect(getDecisions(ev({ method: 'GET', session: regionAdmin() }))).rejects.toMatchObject({ statusCode: 403 })
    await expect(postPreview(ev({ method: 'POST', session: regionAdmin(), body: EMPTY }))).rejects.toMatchObject({ statusCode: 403 })
    await expect(postUnits(ev({ method: 'POST', session: regionAdmin(), body: { items: [] } }))).rejects.toMatchObject({ statusCode: 403 })
  })

  it('the POSTs refuse a cross-origin request', async () => {
    await expect(postPreview(ev({ method: 'POST', session: platform(), body: EMPTY, origin: 'https://evil.test' }))).rejects.toMatchObject({ statusCode: 403 })
    await expect(postUnits(ev({
      method: 'POST', session: platform(), origin: 'https://evil.test',
      body: { items: [{ ownerOid: 'oid-mgra', name: 'Evil', regionId: r1, parentUnitId: null }] },
    }))).rejects.toMatchObject({ statusCode: 403 })
    const [n] = await t.client<{ n: number }[]>`SELECT count(*)::int AS n FROM org_unit WHERE display_name = 'Evil'`
    expect(n!.n).toBe(0)
  })
})

describe('GET tree', () => {
  it('has no nodes until a top is set; the regions still carry current coverage and every active leader', async () => {
    const res = (await getTree(ev({ method: 'GET', session: platform() }))) as OrgTreeResponse
    expect(res.settings.top).toBeNull()
    expect(res.topHome).toBeNull()
    expect(res.nodes).toEqual([])
    const leaderIds = await t.client<{ id: string; oid: string }[]>`SELECT id::text AS id, leader_oid AS oid FROM region_leader WHERE revoked_at IS NULL ORDER BY leader_oid`
    expect(leaderIds.map((l) => l.oid)).toEqual(['oid-apac', 'oid-emea'])
    // Current homes over the WHOLE population, chains ignored: o1 (outside the top)
    // and f1 (failed lookup) count where they sit, and so do never1 and never2, who
    // have no evidence row — one on a holding node, one in a unit. The two inactive
    // admins are outside the population and count nowhere.
    expect(res.regions).toEqual([
      { id: r1, name: 'Region One', users: 10, inUnit: 2, leaders: [] },
      {
        id: r2, name: 'Region Two', users: 2, inUnit: 1,
        leaders: [
          { leaderId: leaderIds[0]!.id, oid: 'oid-apac', name: null, email: 'apac@os.test' },
          { leaderId: leaderIds[1]!.id, oid: 'oid-emea', name: null, email: 'emea@os.test' },
        ],
      },
    ])
    expect(res.read).toMatchObject({ cycleId, remaining: 2, failed: 1, complete: false })
  })

  it('roots the stored chains at the top', async () => {
    await setTop('oid-ceo')
    const res = (await getTree(ev({ method: 'GET', session: platform() }))) as OrgTreeResponse
    expect(res.nodes[0]).toMatchObject({ oid: 'oid-ceo', parentOid: null, users: 8 })
    const by = new Map(res.nodes.map((n) => [n.oid, n]))
    expect(by.get('oid-apac')).toMatchObject({
      parentOid: 'oid-ceo', users: 6, name: 'Grace Liu', department: null,
      leaderOf: { regionId: r2, regionName: 'Region Two' },
      regionCounts: { [r1]: 6 },
    })
    expect(by.get('oid-apac')!.decidedBy).toEqual({ 'chain-region': 4, 'chain-unit': 2 })
    expect(by.get('oid-mgra')!.spend30d).toBeCloseTo(7.5)
    expect(by.get('oid-ownerx')!.owns).toEqual([{ orgUnitId: u1, name: 'Unit One', regionId: r1 }])
    expect(res.outsideTop).toBe(1)
    expect(by.has('oid-o1')).toBe(false)
    // Nobody in TokenScope holds the top person's oid.
    expect(res.topHome).toEqual({ kind: 'not-a-user' })
  })

  it('names the top person\'s own home: a region and unit, or the unassigned bucket', async () => {
    await setTop('oid-ceo')
    const [ceo] = await t.db.insert(schema.teammate)
      .values({ entraOid: 'oid-ceo', email: 'ceo@os.test', displayName: 'CEO', regionId: r2, orgUnitId: u2 })
      .returning()
    try {
      const placed = (await getTree(ev({ method: 'GET', session: platform() }))) as OrgTreeResponse
      expect(placed.topHome).toEqual({ kind: 'placed', teammateId: ceo!.id, email: 'ceo@os.test', regionId: r2, regionName: 'Region Two', unitName: 'Unit Two' })

      const bucket = await makePlacementStore(t.db).unplacedOrgUnitId()
      const [b] = await t.client<{ region_id: string }[]>`SELECT region_id::text AS region_id FROM org_unit WHERE id = ${bucket}::uuid`
      await t.client`UPDATE teammate SET region_id = ${b!.region_id}::uuid, org_unit_id = ${bucket}::uuid WHERE id = ${ceo!.id}::uuid`
      const unassigned = (await getTree(ev({ method: 'GET', session: platform() }))) as OrgTreeResponse
      expect(unassigned.topHome).toEqual({ kind: 'unassigned', teammateId: ceo!.id, email: 'ceo@os.test', regionId: b!.region_id })
    } finally {
      await t.client`DELETE FROM teammate WHERE id = ${ceo!.id}::uuid`
    }
  })

  it('finds the top person by email when their teammate row still has a placeholder oid', async () => {
    await setTop('oid-ceo')
    await t.client`UPDATE org_setup_setting SET top_email = 'CEO@os.test'`
    const [ceo] = await t.db.insert(schema.teammate)
      .values({ entraOid: 'bill:ceo@os.test', email: 'ceo@os.test', displayName: 'CEO', regionId: r2, orgUnitId: u2 })
      .returning()
    try {
      const res = (await getTree(ev({ method: 'GET', session: platform() }))) as OrgTreeResponse
      expect(res.topHome).toMatchObject({ kind: 'placed', teammateId: ceo!.id, regionId: r2 })

      // The same email on a row bound to another real identity is someone else.
      await t.client`UPDATE teammate SET entra_oid = 'oid-someone-else' WHERE id = ${ceo!.id}::uuid`
      const other = (await getTree(ev({ method: 'GET', session: platform() }))) as OrgTreeResponse
      expect(other.topHome).toEqual({ kind: 'not-a-user' })
    } finally {
      await t.client`DELETE FROM teammate WHERE id = ${ceo!.id}::uuid`
      await t.client`UPDATE org_setup_setting SET top_email = NULL`
    }
  })
})

describe('POST preview', () => {
  it('a new unit under a manager takes their branch; nothing is written', async () => {
    const res = (await postPreview(ev({
      method: 'POST', session: platform(),
      body: { leaders: [], newUnits: [{ key: 'new-1', ownerOid: 'oid-mgra', regionId: r2, name: 'Cloud' }] },
    }))) as OrgSetupPreviewResponse
    expect(res.groups).toEqual([
      expect.objectContaining({
        from: { regionId: r1, regionName: 'Region One', orgUnitId: hold1, orgUnitName: expect.any(String) },
        to: { regionId: r2, regionName: 'Region Two', orgUnitId: 'new-1', orgUnitName: 'Cloud' },
        verdict: 'move-region',
        count: 4,
      }),
    ])
    expect(res.byNode['oid-mgra']).toMatchObject({ regionChanges: 4, unitChanges: 4 })
    expect(res.byNode['oid-ownerx']).toMatchObject({ regionChanges: 0, unitChanges: 0 })
    expect(res.notMoved).toEqual({ 'needs-owner': 1, 'no-signal': 2, 'lookup-failed': 1 })
    const [n] = await t.client<{ n: number }[]>`SELECT count(*)::int AS n FROM org_unit WHERE display_name = 'Cloud'`
    expect(n!.n).toBe(0)
  })

  it('removing a leader is previewed against the live config', async () => {
    const res = (await postPreview(ev({ method: 'POST', session: platform(), body: { leaders: [{ oid: 'oid-apac', regionId: null }], newUnits: [] } }))) as OrgSetupPreviewResponse
    expect(res.groups).toEqual([])
    expect(res.byNode['oid-apac']).toMatchObject({ regionChanges: 0 })
  })

  it('validates the body: unknown fields and duplicate keys are 400, an unknown region 422', async () => {
    await expect(postPreview(ev({ method: 'POST', session: platform(), body: { ...EMPTY, extra: 1 } }))).rejects.toMatchObject({ statusCode: 400 })
    const unitOf = (key: string) => ({ key, ownerOid: 'oid-mgra', regionId: r1, name: 'X' })
    await expect(postPreview(ev({ method: 'POST', session: platform(), body: { leaders: [], newUnits: [unitOf('k'), unitOf('k')] } }))).rejects.toMatchObject({ statusCode: 400 })
    await expect(postPreview(ev({ method: 'POST', session: platform(), body: { leaders: [{ oid: 'x', regionId: '9a1e0000-0000-4000-8000-000000000001' }], newUnits: [] } }))).rejects.toMatchObject({ statusCode: 422 })
  })
})

describe('GET decisions', () => {
  it('builds each card kind from the seeded organisation', async () => {
    const [def] = await t.client<{ id: string }[]>`
      INSERT INTO org_unit (region_id, path, code, display_name, unit_type, is_cost_owning_unit)
      VALUES (${r1}::uuid, 'os1', 'default', 'Region One (default)', 'bu', false) RETURNING id::text AS id`
    await t.client`INSERT INTO placement_principal_check (oid, cycle_id, checked_at, found)
      VALUES ('oid-ownerx', ${cycleId}::uuid, now(), false), ('oid-emea', ${cycleId}::uuid, now(), false),
             ('oid-apac', ${cycleId}::uuid, now(), true)`
    const res = (await getDecisions(ev({ method: 'GET', session: platform() }))) as OrgSetupDecisionsResponse
    const kinds = res.decisions.map((d) => [d.kind, d.subjectKey])
    expect(kinds).toEqual([
      ['moves-waiting', 'moves-waiting'],
      ['new-team', 'oid-mgra'],
      ['owner-left', 'oid-ownerx'],
      ['leader-left', 'oid-emea'],
      ['no-placement', 'oid-misc'],
      ['not-read', 'not-read'],
      ['outside-top', 'outside-top'],
      ['unit-under-other-region', u1],
    ])
    const card = (kind: string) => res.decisions.find((d) => d.kind === kind)!
    expect(card('moves-waiting').title).toBe('4 people are waiting to move.')
    expect(card('new-team').title).toBe('MGRA has 3 people under them and no Business Unit above them.')
    // No owned unit above mgra: a unit made from the card sits in Region One's default unit.
    expect(card('new-team').data).toMatchObject({ regionId: r1, parentUnitId: def!.id, parentUnitName: 'Region One (default)' })
    expect(card('owner-left').title).toBe('OWNERX owns Unit One but was not found in the directory.')
    expect(card('owner-left').data).toMatchObject({ ownerTeammateId: ids.ownerx, orgUnitId: u1 })
    expect(card('leader-left').title).toBe('EMEA leads Region Two but was not found in the directory.')
    const [emeaRow] = await t.client<{ id: string }[]>`SELECT id::text AS id FROM region_leader WHERE leader_oid = 'oid-emea' AND revoked_at IS NULL`
    expect(card('leader-left').data).toMatchObject({ leaderId: emeaRow!.id, regionId: r2 })
    expect(card('no-placement').title).toBe('1 person under MISC has no region.')
    expect(card('not-read').data).toEqual({ lookupFailed: 1, walkIncomplete: 0 })
    expect(card('outside-top').title).toBe('1 person does not report up to CEO.')
    expect(card('unit-under-other-region').title).toBe('Unit One is in Region One, but its owner OWNERX reports to Grace Liu of Region Two.')
    expect(res.read.cycleId).toBe(cycleId)
  })

  it('a dismissal in the current cycle hides a dismissible card only', async () => {
    await t.client`INSERT INTO org_setup_dismissal (kind, subject_key, cycle_id) VALUES
      ('new-team', 'oid-mgra', ${cycleId}::uuid),
      ('unit-under-other-region', ${u1}, ${cycleId}::uuid),
      ('outside-top', 'outside-top', ${cycleId}::uuid)`
    const res = (await getDecisions(ev({ method: 'GET', session: platform() }))) as OrgSetupDecisionsResponse
    const kinds = res.decisions.map((d) => d.kind)
    expect(kinds).not.toContain('new-team')
    expect(kinds).not.toContain('unit-under-other-region')
    expect(kinds).toContain('outside-top')
  })

  it('a principal check or dismissal from an earlier cycle does not count', async () => {
    const [c] = await t.client<{ id: string }[]>`INSERT INTO placement_check_cycle (started_by, started_at) VALUES (NULL, now() + interval '1 second') RETURNING id::text AS id`
    const res = (await getDecisions(ev({ method: 'GET', session: platform() }))) as OrgSetupDecisionsResponse
    const kinds = res.decisions.map((d) => d.kind)
    expect(kinds).toContain('new-team')
    expect(kinds).not.toContain('owner-left')
    expect(kinds).not.toContain('leader-left')
    await t.client`DELETE FROM placement_check_cycle WHERE id = ${c!.id}::uuid`
  })
})

describe('POST units', () => {
  const item = (ownerOid: string, name: string, over: Record<string, unknown> = {}) => ({ ownerOid, name, regionId: r1, parentUnitId: u1, ...over })

  it('creates each unit with its owner in its own savepoint; a refusal leaves the others', async () => {
    const res = (await postUnits(ev({
      method: 'POST', session: platform(),
      body: {
        items: [
          item('oid-mgra', 'Cloud & Data'),
          item('oid-ownerx', 'Second Unit'),
          item('oid-a1', 'Cloud & Data'),
          item('oid-nobody', 'Ghost'),
          item('oid-a2', 'Wrong Parent', { parentUnitId: u2 }),
        ],
      },
    }))) as OrgSetupUnitsResponse
    expect(res.results.map((r) => [r.ownerOid, r.status])).toEqual([
      ['oid-mgra', 'created'], ['oid-ownerx', 'refused'], ['oid-a1', 'created'], ['oid-nobody', 'refused'], ['oid-a2', 'refused'],
    ])
    const [first, owns, second, ghost, wrongParent] = res.results
    expect(first).toMatchObject({ code: 'cloud-data' })
    expect(second).toMatchObject({ code: 'cloud-data-2' })
    expect(owns).toMatchObject({ reason: 'already-owns-a-bu' })
    expect(owns!.status === 'refused' && owns!.detail).toBe('OWNERX already owns Unit One (Region One). A person may own at most one Business Unit.')
    expect(ghost).toMatchObject({ reason: 'directory-user' })
    expect(wrongParent).toMatchObject({ reason: 'unprocessable', detail: 'parent_id must belong to the same region as region_id.' })

    const created = await t.client<{ id: string; code: string; parent: string; cost: boolean; type: string; owner: string }[]>`
      SELECT ou.id::text AS id, ou.code, ou.parent_id::text AS parent, ou.is_cost_owning_unit AS cost, ou.unit_type AS type, t.entra_oid AS owner
      FROM org_unit ou JOIN cou_owner co ON co.org_unit_id = ou.id AND co.revoked_at IS NULL JOIN teammate t ON t.id = co.teammate_id
      WHERE ou.code LIKE 'cloud-data%' ORDER BY ou.code`
    expect(created.map((c) => [c.code, c.parent, c.cost, c.type, c.owner])).toEqual([
      ['cloud-data', u1, true, 'bu', 'oid-mgra'],
      ['cloud-data-2', u1, true, 'bu', 'oid-a1'],
    ])
    expect(created.map((c) => c.id)).toEqual([
      first!.status === 'created' ? first!.orgUnitId : '', second!.status === 'created' ? second!.orgUnitId : '',
    ])
    const [refusedUnits] = await t.client<{ n: number }[]>`SELECT count(*)::int AS n FROM org_unit WHERE display_name IN ('Second Unit', 'Ghost', 'Wrong Parent')`
    expect(refusedUnits!.n).toBe(0)

    // One transaction: every row shares its timestamp, so compare as a set.
    const audit = await t.client<{ event_type: string; subject_id: string; actor: string }[]>`
      SELECT event_type, subject_id::text AS subject_id, actor_teammate_id::text AS actor FROM audit_event
      WHERE event_type IN ('org-unit-created', 'cou-owner-assigned')`
    expect(audit.map((a) => `${a.event_type} ${a.subject_id} ${a.actor}`).sort()).toEqual([
      `cou-owner-assigned ${created[0]!.id} ${platformId}`,
      `cou-owner-assigned ${created[1]!.id} ${platformId}`,
      `org-unit-created ${created[0]!.id} ${platformId}`,
      `org-unit-created ${created[1]!.id} ${platformId}`,
    ].sort())
  })

  it('a directory error and a database error each refuse their own item; the others in the request are created and kept', async () => {
    // A NUL byte is rejected by Postgres at the INSERT, after every HTTP-shaped
    // refusal has passed: a raw database error, not a createError.
    const res = (await postUnits(ev({
      method: 'POST', session: platform(),
      body: {
        items: [
          item('oid-x1', 'Alpha Unit'),
          item('oid-boom', 'Boom'),
          item('oid-n1', 'Bad\u0000Name'),
          item('oid-e1', 'Gamma Unit', { regionId: r2, parentUnitId: u2 }),
        ],
      },
    }))) as OrgSetupUnitsResponse
    expect(res.results.map((r) => [r.ownerOid, r.status])).toEqual([
      ['oid-x1', 'created'], ['oid-boom', 'refused'], ['oid-n1', 'refused'], ['oid-e1', 'created'],
    ])
    const [, boom, bad] = res.results
    // A throttle or outage is the item's error, with Graph's own message, never "no such user".
    expect(boom).toMatchObject({ reason: 'directory-error', detail: 'Graph request failed (503) for /users/oid-boom.' })
    expect(bad).toMatchObject({ reason: 'error' })
    expect(bad!.status === 'refused' && bad!.detail.length).toBeGreaterThan(0)

    const kept = await t.client<{ code: string; owner: string }[]>`
      SELECT ou.code, t.entra_oid AS owner
      FROM org_unit ou JOIN cou_owner co ON co.org_unit_id = ou.id AND co.revoked_at IS NULL JOIN teammate t ON t.id = co.teammate_id
      WHERE ou.code IN ('alpha-unit', 'gamma-unit') ORDER BY ou.code`
    expect(kept).toEqual([{ code: 'alpha-unit', owner: 'oid-x1' }, { code: 'gamma-unit', owner: 'oid-e1' }])
    const [none] = await t.client<{ n: number }[]>`SELECT count(*)::int AS n FROM org_unit WHERE code IN ('boom', 'bad-name')`
    expect(none!.n).toBe(0)
  })

  it('the request has one budget: an item not started before it runs out is refused not-started; the ones before it are kept', async () => {
    // Only Date is faked (the database driver keeps its real timers). The first
    // lookup eats the whole budget; every later item must not be started, and the
    // budget's deadline must reach the lookups themselves so a slow one cannot wait
    // past it either.
    const T0 = Date.UTC(2026, 9, 22, 1, 0, 0)
    for (const k of ['slow', 'b2', 'b3']) dir.users.set(`oid-${k}`, { oid: `oid-${k}`, email: `${k}@os.test`, displayName: k.toUpperCase() })
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(T0)
    dir.calls.length = 0
    dir.onLookup = (oid) => {
      if (oid === 'oid-slow') vi.setSystemTime(T0 + UNITS_REQUEST_BUDGET_MS)
    }
    try {
      const res = (await postUnits(ev({
        method: 'POST', session: platform(),
        body: { items: [item('oid-slow', 'Slow Unit'), item('oid-b2', 'Second Unit B'), item('oid-b3', 'Third Unit B')] },
      }))) as OrgSetupUnitsResponse
      expect(res.results).toEqual([
        { ownerOid: 'oid-slow', status: 'created', orgUnitId: expect.any(String), code: 'slow-unit' },
        { ownerOid: 'oid-b2', status: 'refused', reason: 'not-started', detail: 'Ran out of time before this one; save again for the rest.' },
        { ownerOid: 'oid-b3', status: 'refused', reason: 'not-started', detail: 'Ran out of time before this one; save again for the rest.' },
      ])
      expect(dir.calls).toEqual([{ oid: 'oid-slow', deadline: T0 + UNITS_REQUEST_BUDGET_MS }])
    } finally {
      dir.onLookup = null
      vi.useRealTimers()
    }
    const rows = await t.client<{ code: string }[]>`
      SELECT code FROM org_unit WHERE display_name IN ('Slow Unit', 'Second Unit B', 'Third Unit B') ORDER BY code`
    expect(rows).toEqual([{ code: 'slow-unit' }])
  })

  it("a unit with no parent goes under the region's default unit, never beside it", async () => {
    // A region with no default unit refuses; r1 may already hold one from an earlier test.
    const [bare] = await t.client<{ id: string }[]>`
      INSERT INTO region (code, display_name) VALUES ('os-bare', 'Bare') RETURNING id::text AS id`
    const noDefault = { items: [item('oid-a3', 'Ünïts!', { regionId: bare!.id, parentUnitId: null })] }
    const none = (await postUnits(ev({ method: 'POST', session: platform(), body: noDefault }))) as OrgSetupUnitsResponse
    expect(none.results[0]).toMatchObject({ status: 'refused', reason: 'unprocessable' })

    const body = { items: [item('oid-a3', 'Ünïts!', { parentUnitId: null })] }
    const [existing] = await t.client<{ id: string }[]>`
      SELECT id::text AS id FROM org_unit WHERE region_id = ${r1}::uuid AND code = 'default' AND parent_id IS NULL`
    const root = existing?.id ?? await unit(r1, 'os1', 'default', 'Region One (default)')
    const res = (await postUnits(ev({ method: 'POST', session: platform(), body }))) as OrgSetupUnitsResponse
    expect(res.results[0]).toMatchObject({ status: 'created', code: 'units' })
    const [row] = await t.client<{ path: string; parent: string | null }[]>`SELECT path::text AS path, parent_id::text AS parent FROM org_unit WHERE code = 'units'`
    expect(row).toEqual({ path: 'os1.units', parent: root })
  })

  it('refuses a parent that is the holding node', async () => {
    const res = (await postUnits(ev({ method: 'POST', session: platform(), body: { items: [item('oid-a3', 'Held', { parentUnitId: hold1 })] } }))) as OrgSetupUnitsResponse
    expect(res.results[0]).toMatchObject({ status: 'refused', reason: 'unprocessable' })
    expect(await t.client`SELECT 1 FROM org_unit WHERE display_name = 'Held'`).toHaveLength(0)
  })

  it('validates the body', async () => {
    await expect(postUnits(ev({ method: 'POST', session: platform(), body: { items: [] } }))).rejects.toMatchObject({ statusCode: 400 })
    const many = Array.from({ length: 51 }, (_, i) => item(`oid-${i}`, `U${i}`))
    await expect(postUnits(ev({ method: 'POST', session: platform(), body: { items: many } }))).rejects.toMatchObject({ statusCode: 400 })
    await expect(postUnits(ev({ method: 'POST', session: platform(), body: { items: [{ ...item('oid-a3', 'X'), extra: 1 }] } }))).rejects.toMatchObject({ statusCode: 400 })
    await expect(postUnits(ev({ method: 'POST', session: platform(), body: { items: [item('oid-a3', 'X', { regionId: 'r1' })] } }))).rejects.toMatchObject({ statusCode: 400 })
  })
})
