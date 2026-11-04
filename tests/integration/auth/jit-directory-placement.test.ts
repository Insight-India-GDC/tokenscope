// @vitest-environment node
/*
 * Spec P9: a first sign-in with no bill row to adopt is homed where the directory
 * places them, under a 3 s budget that covers the Graph token mint; any directory
 * failure falls back to the default region, a database failure still throws.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest'
import { sql } from 'drizzle-orm'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'
import { resolveOrCreateTeammate } from '../../../server/auth/jit-teammate'
import type { JitDirectory } from '../../../server/auth/jit-placement'
import { _resetGraphTokenCache, _resetOrgDataLatch, type DirectoryUser, type GraphCallOptions } from '../../../server/azure/directory'
import { reenrichmentCandidatePredicate } from '../../../server/reconciliation/placement-provenance'
import { manualPlacementSql } from '../../../server/reconciliation/placement-manual'
import { DeadlinePassedError } from '../../../server/utils/resilient-fetch'

let t: TestDb
let regionAId: string // 'a-region': the default
let regionBId: string
let unitB1Id: string // cost-owning, in b-region, owned by OWNER_OID
let seq = 0

const OWNER_OID = '9a1e0000-0000-4000-8000-0000000000a1'
const nextOid = () => `9a1e0000-0000-4000-8000-${String(++seq).padStart(12, '0')}`

const dirUser = (oid: string, over: Partial<DirectoryUser> = {}): DirectoryUser => ({
  oid,
  email: `${oid}@x.test`,
  displayName: 'Dir',
  mail: `${oid}@x.test`,
  upn: `${oid}@x.test`,
  department: null,
  jobTitle: null,
  companyName: null,
  country: null,
  officeLocation: null,
  state: null,
  costCenter: null,
  division: null,
  ...over,
})

/** A directory of `users` whose managers are `managers` (oid → manager oid). */
function directory(users: DirectoryUser[], managers: Record<string, string> = {}): JitDirectory & { calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    async getUser(oid) {
      calls.push(`user:${oid}`)
      return users.find((u) => u.oid === oid) ?? null
    },
    async getManager(oid) {
      calls.push(`manager:${oid}`)
      const m = managers[oid]
      return m ? { oid: m, email: null } : null
    },
  }
}

async function homeOf(teammateId: string) {
  const [row] = await t.client<{ region_id: string; org_unit_id: string; code: string; metadata: Record<string, string> | null; role: string }[]>`
    SELECT tm.region_id::text AS region_id, tm.org_unit_id::text AS org_unit_id, ou.code, tm.metadata, tm.role
    FROM teammate tm JOIN org_unit ou ON ou.id = tm.org_unit_id WHERE tm.id = ${teammateId}::uuid`
  return row!
}

async function jitAudit(teammateId: string) {
  const [row] = await t.client<{ payload: { placement: Record<string, string> } }[]>`
    SELECT payload FROM audit_event WHERE event_type = 'teammate-jit-created' AND subject_id = ${teammateId}::uuid`
  return row!.payload.placement
}

beforeAll(async () => {
  t = await startTestDb()
  await t.client`INSERT INTO region (code, display_name) VALUES ('z-region', 'Z'), ('b-region', 'B'), ('a-region', 'A')`
  const regions = await t.client<{ id: string; code: string }[]>`SELECT id::text AS id, code FROM region`
  regionAId = regions.find((r) => r.code === 'a-region')!.id
  regionBId = regions.find((r) => r.code === 'b-region')!.id
  const [b1] = await t.client<{ id: string }[]>`
    INSERT INTO org_unit (region_id, path, code, display_name, unit_type, is_cost_owning_unit)
    VALUES (${regionBId}::uuid, 'b_one'::ltree, 'b-one', 'B One', 'bu', true) RETURNING id::text AS id`
  unitB1Id = b1!.id
  const [owner] = await t.client<{ id: string }[]>`
    INSERT INTO teammate (entra_oid, email, display_name, role, region_id, org_unit_id)
    VALUES (${OWNER_OID}, 'owner@x.test', 'Owner', 'developer', ${regionBId}::uuid, ${unitB1Id}::uuid)
    RETURNING id::text AS id`
  await t.client`INSERT INTO cou_owner (org_unit_id, teammate_id) VALUES (${unitB1Id}::uuid, ${owner!.id}::uuid)`
  await t.client`INSERT INTO directory_region_rule (attribute, match_mode, match_value, match_value_raw, region_id)
    VALUES ('department', 'exact', 'b dept', 'B Dept', ${regionBId}::uuid)`
}, 120_000)

afterAll(async () => {
  await stopTestDb(t)
})

afterEach(() => {
  vi.unstubAllGlobals()
  delete process.env.NUXT_GRAPH_DIRECTORY_MODE
  delete process.env.NUXT_BOOTSTRAP_ADMIN_EMAIL
})

describe('JIT creation places from the directory', () => {
  it('a chain owner places them on the owned unit, with manager-chain provenance', async () => {
    const oid = nextOid()
    const d = directory([dirUser(oid)], { [oid]: OWNER_OID })
    const r = await resolveOrCreateTeammate(t.db, { oid, email: `${oid}@x.test` }, { directory: d })

    expect(r.created).toBe(true)
    expect(r.role).toBe('developer')
    expect(r.regionId).toBe(regionBId)
    const home = await homeOf(r.teammateId)
    expect(home.org_unit_id).toBe(unitB1Id)
    expect(home.metadata).toMatchObject({ placedVia: 'manager-chain', placedOwnerOid: OWNER_OID })
    expect(home.metadata!.placedAt).toBeTruthy()
    expect(await jitAudit(r.teammateId)).toMatchObject({ placed: 'directory', step: 'unit', orgUnitId: unitB1Id })
  })

  it('a unit un-flagged during the lookup is not used: they land on its region\'s Unplaced node', async () => {
    const oid = nextOid()
    const d = directory([dirUser(oid)], { [oid]: OWNER_OID })
    const getManager = d.getManager.bind(d)
    d.getManager = async (o, call) => {
      await t.client`UPDATE org_unit SET is_cost_owning_unit = false WHERE id = ${unitB1Id}::uuid`
      return getManager(o, call)
    }
    try {
      const r = await resolveOrCreateTeammate(t.db, { oid, email: `${oid}@x.test` }, { directory: d })
      const home = await homeOf(r.teammateId)
      expect(home.region_id).toBe(regionBId)
      expect(home.org_unit_id).not.toBe(unitB1Id)
      expect(home.code).toBe('__UNPLACED__')
      expect(home.metadata).toMatchObject({ placedVia: 'jit-directory' })
      expect(await jitAudit(r.teammateId)).toMatchObject({ regionId: regionBId, orgUnitId: home.org_unit_id })
    } finally {
      await t.client`UPDATE org_unit SET is_cost_owning_unit = true WHERE id = ${unitB1Id}::uuid`
    }
  })

  it('a region rule alone homes them on that region\'s Unplaced node', async () => {
    const oid = nextOid()
    const d = directory([dirUser(oid, { department: 'B Dept' })])
    const r = await resolveOrCreateTeammate(t.db, { oid, email: `${oid}@x.test` }, { directory: d })

    const home = await homeOf(r.teammateId)
    expect(home.region_id).toBe(regionBId)
    expect(home.code).toBe('__UNPLACED__')
    expect(home.metadata).toMatchObject({ placedVia: 'jit-directory', placedAttribute: 'department' })
    expect(await jitAudit(r.teammateId)).toMatchObject({ placed: 'directory', step: 'attribute', regionId: regionBId })
  })

  it('the bootstrap email is still platform-admin when the directory places them', async () => {
    const oid = nextOid()
    process.env.NUXT_BOOTSTRAP_ADMIN_EMAIL = `${oid}@x.test`
    const d = directory([dirUser(oid)], { [oid]: OWNER_OID })
    const r = await resolveOrCreateTeammate(t.db, { oid, email: `${oid}@x.test` }, { directory: d })
    expect(r.role).toBe('platform-admin')
    expect(r.regionId).toBe(regionBId)
  })

  it('a person placed at sign-in is neither a re-enrichment candidate nor "placed by hand"', async () => {
    const placed = nextOid()
    const fellBack = nextOid()
    const a = await resolveOrCreateTeammate(t.db, { oid: placed, email: `${placed}@x.test` }, { directory: directory([dirUser(placed)], { [placed]: OWNER_OID }) })
    const b = await resolveOrCreateTeammate(t.db, { oid: fellBack, email: `${fellBack}@x.test` }, { directory: directory([]) })
    const rows = await t.db.execute<{ id: string; candidate: boolean; manual: boolean }>(sql`
      SELECT t.id::text AS id,
             ${reenrichmentCandidatePredicate(sql`t`, sql`ou`)} AS candidate,
             ${manualPlacementSql(sql`t`)} AS manual
      FROM teammate t JOIN org_unit ou ON ou.id = t.org_unit_id
      WHERE t.id IN (${a.teammateId}::uuid, ${b.teammateId}::uuid)`)
    expect(rows).toHaveLength(2)
    for (const row of rows) {
      expect(row.candidate).toBe(false)
      expect(row.manual).toBe(false)
    }
  })
})

describe('JIT creation falls back to the default region', () => {
  async function expectDefault(teammateId: string, reason: string) {
    const home = await homeOf(teammateId)
    expect(home.region_id).toBe(regionAId)
    expect(home.code).toBe('__UNPLACED__')
    expect(home.metadata).toMatchObject({ placedVia: 'jit-default' })
    expect(await jitAudit(teammateId)).toMatchObject({ placed: 'default', reason })
  }

  it('not in the directory', async () => {
    const oid = nextOid()
    const r = await resolveOrCreateTeammate(t.db, { oid, email: `${oid}@x.test` }, { directory: directory([]) })
    await expectDefault(r.teammateId, 'not-in-directory')
  })

  it('in the directory with nothing that places them', async () => {
    const oid = nextOid()
    const r = await resolveOrCreateTeammate(t.db, { oid, email: `${oid}@x.test` }, { directory: directory([dirUser(oid)]) })
    await expectDefault(r.teammateId, 'no-placement')
  })

  it('a lookup that never answers is abandoned at the budget and its signal aborted', async () => {
    const oid = nextOid()
    const seen: GraphCallOptions[] = []
    const hang: JitDirectory = {
      getUser: async () => dirUser(oid),
      getManager: (_oid, call) => {
        seen.push(call)
        return new Promise(() => undefined)
      },
    }
    const started = Date.now()
    const r = await resolveOrCreateTeammate(t.db, { oid, email: `${oid}@x.test` }, { directory: hang, budgetMs: 300 })
    expect(Date.now() - started).toBeLessThan(2_000)
    expect(seen).toHaveLength(1)
    expect(seen[0]!.signal!.aborted).toBe(true)
    // The budget starts after the config loads, so bound the deadline by when the call returned.
    expect(seen[0]!.deadline).toBeGreaterThanOrEqual(started + 300)
    expect(seen[0]!.deadline).toBeLessThanOrEqual(Date.now())
    await expectDefault(r.teammateId, 'timeout')
  })

  it('a call that fails with its own timeout at the deadline, before the budget timer, is still a timeout', async () => {
    // Busy-waits to the deadline so the rejection settles before the budget timer can fire.
    const failAtDeadline = (make: () => Error): JitDirectory => ({
      getUser: async (_oid, call) => {
        while (Date.now() < call.deadline!) { /* spin */ }
        throw make()
      },
      getManager: async () => null,
    })
    for (const make of [() => new DeadlinePassedError('graph.example.test'), () => new DOMException('attempt timed out', 'TimeoutError')]) {
      const oid = nextOid()
      const r = await resolveOrCreateTeammate(t.db, { oid, email: `${oid}@x.test` }, { directory: failAtDeadline(make), budgetMs: 50 })
      await expectDefault(r.teammateId, 'timeout')
    }
  })

  it('a hung token mint is cancelled at the budget: the mint fetch is aborted, nothing else is sent', async () => {
    process.env.NUXT_GRAPH_DIRECTORY_MODE = 'graph'
    process.env.NUXT_GRAPH_BASE_URL = 'https://graph.example.test/v1.0'
    process.env.NUXT_OIDC_PROVIDERS_ENTRA_CLIENT_ID = 'cid'
    process.env.NUXT_OIDC_PROVIDERS_ENTRA_CLIENT_SECRET = 'secret'
    process.env.NUXT_OIDC_PROVIDERS_ENTRA_TOKEN_URL = 'https://login.example.test/token'
    _resetGraphTokenCache()
    _resetOrgDataLatch()
    const fetches: { url: string; signal: AbortSignal }[] = []
    vi.stubGlobal('fetch', (url: string, init: RequestInit) => {
      fetches.push({ url: String(url), signal: init.signal! })
      return new Promise((_resolve, reject) => {
        init.signal!.addEventListener('abort', () => reject(init.signal!.reason))
      })
    })
    try {
      const oid = nextOid()
      const started = Date.now()
      const r = await resolveOrCreateTeammate(t.db, { oid, email: `${oid}@x.test` }, { budgetMs: 300 })
      expect(Date.now() - started).toBeLessThan(2_000)
      expect(fetches.map((f) => f.url)).toEqual(['https://login.example.test/token'])
      expect(fetches[0]!.signal.aborted).toBe(true)
      await expectDefault(r.teammateId, 'timeout')
    } finally {
      _resetGraphTokenCache()
      delete process.env.NUXT_GRAPH_BASE_URL
      delete process.env.NUXT_OIDC_PROVIDERS_ENTRA_CLIENT_ID
      delete process.env.NUXT_OIDC_PROVIDERS_ENTRA_CLIENT_SECRET
      delete process.env.NUXT_OIDC_PROVIDERS_ENTRA_TOKEN_URL
    }
  })

  it('a Graph 5xx', async () => {
    process.env.NUXT_GRAPH_DIRECTORY_MODE = 'graph'
    process.env.NUXT_GRAPH_BASE_URL = 'https://graph.example.test/v1.0'
    process.env.NUXT_OIDC_PROVIDERS_ENTRA_CLIENT_ID = 'cid'
    process.env.NUXT_OIDC_PROVIDERS_ENTRA_CLIENT_SECRET = 'secret'
    process.env.NUXT_OIDC_PROVIDERS_ENTRA_TOKEN_URL = 'https://login.example.test/token'
    _resetGraphTokenCache()
    vi.stubGlobal('fetch', async (url: string) =>
      new URL(String(url)).host === 'login.example.test'
        ? new Response(JSON.stringify({ access_token: 'tok', expires_in: 3600 }), { status: 200 })
        : new Response(null, { status: 503 }),
    )
    try {
      const oid = nextOid()
      const r = await resolveOrCreateTeammate(t.db, { oid, email: `${oid}@x.test` })
      await expectDefault(r.teammateId, 'directory-error')
    } finally {
      _resetGraphTokenCache()
      delete process.env.NUXT_GRAPH_BASE_URL
      delete process.env.NUXT_OIDC_PROVIDERS_ENTRA_CLIENT_ID
      delete process.env.NUXT_OIDC_PROVIDERS_ENTRA_CLIENT_SECRET
      delete process.env.NUXT_OIDC_PROVIDERS_ENTRA_TOKEN_URL
    }
  })
})

describe('what P9 leaves alone', () => {
  it('a database error still fails the sign-in and creates nobody', async () => {
    const oid = nextOid()
    await t.client`ALTER TABLE region_leader RENAME TO region_leader_hidden`
    try {
      await expect(
        resolveOrCreateTeammate(t.db, { oid, email: `${oid}@x.test` }, { directory: directory([dirUser(oid)]) }),
      ).rejects.toThrow()
    } finally {
      await t.client`ALTER TABLE region_leader_hidden RENAME TO region_leader`
    }
    const [n] = await t.client<{ n: string }[]>`SELECT count(*)::text AS n FROM teammate WHERE entra_oid = ${oid}`
    expect(n!.n).toBe('0')
  })

  it('adopting a bill row asks the directory nothing and keeps the bill lane\'s home', async () => {
    const oid = nextOid()
    const email = `adopt-${oid}@x.test`
    await t.client`INSERT INTO teammate (entra_oid, email, display_name, region_id, org_unit_id, source, provisional)
      VALUES ('bill:' || gen_random_uuid(), ${email}, 'Bill', ${regionBId}::uuid, ${unitB1Id}::uuid, 'bill', false)`
    const d = directory([dirUser(oid, { department: 'B Dept' })])
    const r = await resolveOrCreateTeammate(t.db, { oid, email }, { directory: d })
    expect(r.created).toBe(false)
    expect(d.calls).toEqual([])
    const home = await homeOf(r.teammateId)
    expect(home.org_unit_id).toBe(unitB1Id)
    expect(home.metadata?.placedVia).toBeUndefined()
  })
})
