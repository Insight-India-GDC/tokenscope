// @vitest-environment node
/*
 * GET /api/v1/admin/diagnostics/instance-telemetry — the client-vs-server
 * discriminator.
 *
 * This endpoint answers the ONE question that splits an attribution outage in
 * half, so its two dangerous failure modes are not "it 500s" but:
 *   - blaming the CLIENT when our own ingest probe failed, and
 *   - blaming US when nothing ever reached ingest.
 * Both produce a confident, plausible, wrong answer. Both are asserted below.
 *
 * The ingest side is driven by a REAL LocalCollectorReader pointed at a stub HTTP
 * store, not by a mocked reader: the mapping from "what the store returns" to
 * "what the verdict says" is the part that can silently invert, and a mock of the
 * reader would assert nothing about it.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import { randomUUID } from 'node:crypto'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'
import * as schema from '../../../drizzle/schema'
import { injectTestSession } from '../../helpers/auth'
import type { Session } from '../../../server/utils/auth'
import handler from '../../../server/api/v1/admin/diagnostics/instance-telemetry.get'

let t: TestDb
let regionId: string
let ouId: string
let adminId: string
let devId: string
let finopsId: string
let regionBId: string
let ouBId: string

/** Stub telemetry store: serves whatever `storeUsage` currently holds. */
let server: http.Server
let storeUsage: Array<{ tokens: number; tokenType: string; model: string; tsEvent: string }> = []
/**
 * Counts requests that actually reached the stub store's `/usage` route —
 * i.e. that `LocalCollectorReader.instancePresence` (via getSessionUsage)
 * actually fired an HTTP call. Standing in for a spy on the reader: the
 * region-clamp test asserts this does NOT increase for a denied request, so
 * "the ingest probe never ran" is checked against the real network call, not
 * an assumption about the code path.
 */
let usageRequestCount = 0

function ev(opts: { session: Session; query?: Record<string, string> }) {
  const qs = opts.query ? `?${new URLSearchParams(opts.query).toString()}` : ''
  const path = `/api/v1/admin/diagnostics/instance-telemetry${qs}`
  const e = {
    path,
    node: {
      req: {
        method: 'GET',
        url: path,
        socket: { remoteAddress: '127.0.0.1' },
        get headers() { return { 'content-type': 'application/json' } },
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
  return e as unknown as Parameters<typeof handler>[0]
}

const admin = (): Session => ({ teammateId: adminId, email: 'it-admin@x.test', displayName: 'Admin', role: 'admin', regionId, orgPath: 'it.svc' })
const finops = (): Session => ({ teammateId: finopsId, email: 'it-fin@x.test', displayName: 'Fin', role: 'platform-admin', regionId, orgPath: 'it.svc' })
const dev = (): Session => ({ teammateId: devId, email: 'it-dev@x.test', displayName: 'Dev', role: 'developer', regionId, orgPath: 'it.svc' })

interface Resp {
  verdict: string
  side: string | null
  known: boolean
  interpretation: string
  windowHours: number
  instance: {
    clientPluginVersion: string | null
    clientCliVersion: string | null
    clientVersionAt: string | null
    clientPlatform: string | null
    clientSurface: string | null
    setupMode: string | null
    lastBearerAt: string | null
    endedAt: string | null
  } | null
  instanceId: string
  ingest: {
    reachable: boolean
    records?: number
    usageRecords?: number
    firstSeen?: string | null
    lastSeen?: string | null
    error?: string | null
  }
  attribution: { records: number; firstTsEvent: string | null; lastTsEvent: string | null }
}

beforeAll(async () => {
  t = await startTestDb()
  process.env.DATABASE_URL = t.url

  const [r] = await t.db.insert(schema.region).values({ code: 'it-r', displayName: 'IT R' }).returning()
  regionId = r!.id
  const [o] = await t.db
    .insert(schema.orgUnit)
    .values({ regionId, path: 'it.svc', code: 'it-svc', displayName: 'Svc', unitType: 'bu', isCostOwningUnit: true })
    .returning()
  ouId = o!.id
  const [a] = await t.db.insert(schema.teammate).values({ entraOid: 'oid-it-admin', email: 'it-admin@x.test', role: 'admin', regionId, orgUnitId: ouId }).returning()
  adminId = a!.id
  const [f] = await t.db.insert(schema.teammate).values({ entraOid: 'oid-it-fin', email: 'it-fin@x.test', role: 'platform-admin', regionId, orgUnitId: ouId }).returning()
  finopsId = f!.id
  const [d] = await t.db.insert(schema.teammate).values({ entraOid: 'oid-it-dev', email: 'it-dev@x.test', role: 'developer', regionId, orgUnitId: ouId }).returning()
  devId = d!.id

  // A second region, for the region-clamp case — a region-A admin must never
  // reach an instance whose instance_attestation row lives here.
  const [rb] = await t.db.insert(schema.region).values({ code: 'it-r-b', displayName: 'IT R B' }).returning()
  regionBId = rb!.id
  const [ob] = await t.db
    .insert(schema.orgUnit)
    .values({ regionId: regionBId, path: 'it-b.svc', code: 'it-b-svc', displayName: 'Svc B', unitType: 'bu', isCostOwningUnit: true })
    .returning()
  ouBId = ob!.id

  server = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json')
    if (req.url?.includes('/usage')) {
      usageRequestCount += 1
      res.end(JSON.stringify({ session_id: 'x', usage: storeUsage }))
      return
    }
    res.statusCode = 404
    res.end('{}')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  Reflect.deleteProperty(process.env, 'NUXT_TELEMETRY_READER') // → LocalCollectorReader
  process.env.NUXT_AZURE_MONITOR_ENDPOINT = `http://127.0.0.1:${port}`
}, 180_000)

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
  await stopTestDb(t)
}, 30_000)

afterEach(() => {
  storeUsage = []
  usageRequestCount = 0
})

/** Enrol an instance; optionally with reported client versions. */
async function enrol(opts: { plugin?: string; cli?: string } = {}): Promise<string> {
  const instanceId = randomUUID()
  await t.client.unsafe(`
    INSERT INTO instance_attestation
      (instance_id, principal_oid, principal_email, teammate_id, project_code_hash, raw_project_code,
       tool, ts_start, last_bearer_at,
       attestation_state, region_id, org_unit_id, cost_owning_unit_id,
       client_plugin_version, client_cli_version, client_version_at)
    VALUES ('${instanceId}','oid-it','it-dev@x.test','${devId}','h-it','IT',
       'claude-code', NOW() - INTERVAL '30 days', NOW(),
       'attested','${regionId}','${ouId}','${ouId}',
       ${opts.plugin ? `'${opts.plugin}'` : 'NULL'}, ${opts.cli ? `'${opts.cli}'` : 'NULL'},
       ${opts.plugin || opts.cli ? 'NOW()' : 'NULL'})`)
  return instanceId
}

async function seedAttribution(instanceId: string, hoursAgo: number) {
  await t.db.insert(schema.attributionRecord).values({
    instanceId,
    teammateId: devId,
    regionId,
    orgUnitId: ouId,
    costOwningUnitId: ouId,
    tool: 'claude-code',
    model: 'claude-sonnet-4-7',
    tokenType: 'input',
    tokens: 100n,
    costUsd: '0.01',
    fidelityTier: 'tier-2',
    costBasis: 'telemetry-only',
    tsEvent: new Date(Date.now() - hoursAgo * 3600_000),
  })
}

function usageAt(hoursAgo: number) {
  return {
    tokens: 10,
    tokenType: 'input',
    model: 'claude-sonnet-4-7',
    tsEvent: new Date(Date.now() - hoursAgo * 3600_000).toISOString(),
  }
}

describe('instance-telemetry — RBAC', () => {
  it('REJECTS a developer (the response carries an instance id, a teammate email and version claims)', async () => {
    const id = await enrol()
    await expect(handler(ev({ session: dev(), query: { instanceId: id } }))).rejects.toMatchObject({ statusCode: 403 })
  })

  it('allows an admin and platform-admin', async () => {
    const id = await enrol()
    expect(((await handler(ev({ session: admin(), query: { instanceId: id } }))) as Resp).known).toBe(true)
    expect(((await handler(ev({ session: finops(), query: { instanceId: id } }))) as Resp).known).toBe(true)
  })

  it('rejects a non-UUID instanceId rather than reaching the reader', async () => {
    await expect(handler(ev({ session: admin(), query: { instanceId: 'not-a-uuid' } }))).rejects.toBeTruthy()
  })

  it('rejects a window beyond the retention ceiling', async () => {
    const id = await enrol()
    await expect(
      handler(ev({ session: admin(), query: { instanceId: id, hours: String(24 * 91) } })),
    ).rejects.toBeTruthy()
  })
})

describe('instance-telemetry — the verdict', () => {
  it('ingest HAS records, ledger has none → OUR side (the joiner)', async () => {
    const id = await enrol()
    storeUsage = [usageAt(100), usageAt(50)]
    const res = (await handler(ev({ session: admin(), query: { instanceId: id, hours: '168' } }))) as Resp
    expect(res.ingest.reachable).toBe(true)
    expect(res.ingest.records).toBe(2)
    expect(res.attribution.records).toBe(0)
    expect(res.verdict).toBe('ingested-not-attributed')
    expect(res.side).toBe('server')
  })

  it('ingest has NOTHING, ledger has nothing → the CLIENT side', async () => {
    const id = await enrol()
    storeUsage = []
    const res = (await handler(ev({ session: admin(), query: { instanceId: id, hours: '168' } }))) as Resp
    expect(res.ingest.reachable).toBe(true)
    expect(res.ingest.records).toBe(0)
    expect(res.verdict).toBe('absent-from-ingest')
    expect(res.side).toBe('client')
  })

  it('both sides populated → healthy window', async () => {
    const id = await enrol()
    storeUsage = [usageAt(10)]
    await seedAttribution(id, 10)
    const res = (await handler(ev({ session: admin(), query: { instanceId: id, hours: '168' } }))) as Resp
    expect(res.verdict).toBe('attributed')
    expect(res.side).toBe('none')
  })

  it('returns the EVIDENCE behind the verdict, not just the verdict', async () => {
    // An operator has to be able to check the working. A verdict with no counts
    // and no timestamps is an assertion, and this endpoint exists precisely
    // because assertions about where telemetry went could not be checked.
    const id = await enrol()
    storeUsage = [usageAt(20), usageAt(2)]
    await seedAttribution(id, 3)
    const res = (await handler(ev({ session: admin(), query: { instanceId: id, hours: '168' } }))) as Resp
    expect(res.instanceId).toBe(id)
    // The window is echoed: which window was measured is part of the answer, and
    // a verdict read against an unstated window is not interpretable.
    expect(res.windowHours).toBe(168)
    expect(res.ingest.records).toBe(2)
    expect(res.ingest.usageRecords).toBe(2)
    // The seen-range, so "it stopped on the 16th" is visible rather than inferred.
    expect(new Date(res.ingest.firstSeen!).getTime()).toBeLessThan(new Date(res.ingest.lastSeen!).getTime())
    expect(res.attribution.records).toBe(1)
    expect(res.attribution.firstTsEvent).toBeTruthy()
    expect(res.attribution.lastTsEvent).toBeTruthy()
    expect(res.interpretation.length).toBeGreaterThan(40)
  })

  it('the window BOUNDS both sides — records outside it count for neither', async () => {
    // A comparison across mismatched windows would look authoritative while
    // contrasting unrelated populations. Both sides must honour the same bound.
    const id = await enrol()
    storeUsage = [usageAt(200)] // ~8 days ago
    await seedAttribution(id, 200)
    const narrow = (await handler(ev({ session: admin(), query: { instanceId: id, hours: '24' } }))) as Resp
    expect(narrow.ingest.records).toBe(0)
    expect(narrow.attribution.records).toBe(0)
    const wide = (await handler(ev({ session: admin(), query: { instanceId: id, hours: '336' } }))) as Resp
    expect(wide.ingest.records).toBe(1)
    expect(wide.attribution.records).toBe(1)
  })

  it('an UNREADABLE ingest side is UNANSWERABLE — never "the client sent nothing"', async () => {
    // The endpoint's worst possible behaviour: our probe breaks and we blame the
    // device. Simulated by pointing the reader at a dead port.
    const id = await enrol()
    const good = process.env.NUXT_AZURE_MONITOR_ENDPOINT
    process.env.NUXT_AZURE_MONITOR_ENDPOINT = 'http://127.0.0.1:1' // nothing listens
    try {
      const res = (await handler(ev({ session: admin(), query: { instanceId: id, hours: '168' } }))) as Resp
      expect(res.ingest.reachable).toBe(false)
      expect(res.verdict).toBe('unanswerable')
      expect(res.side).toBeNull()
      expect(res.ingest.error).toBeTruthy()
    } finally {
      process.env.NUXT_AZURE_MONITOR_ENDPOINT = good
    }
  }, 30_000)

  it('an UNCONFIGURED reader is also unanswerable, not a client verdict', async () => {
    const id = await enrol()
    const good = process.env.NUXT_AZURE_MONITOR_ENDPOINT
    Reflect.deleteProperty(process.env, 'NUXT_AZURE_MONITOR_ENDPOINT')
    try {
      const res = (await handler(ev({ session: admin(), query: { instanceId: id, hours: '168' } }))) as Resp
      expect(res.verdict).toBe('unanswerable')
    } finally {
      process.env.NUXT_AZURE_MONITOR_ENDPOINT = good
    }
  })
})

describe('instance-telemetry — the client version claims', () => {
  it('surfaces the reported versions (the first thing wanted once the verdict says "client")', async () => {
    const id = await enrol({ plugin: '0.1.27', cli: '2.1.212' })
    const res = (await handler(ev({ session: admin(), query: { instanceId: id } }))) as Resp
    expect(res.instance?.clientPluginVersion).toBe('0.1.27')
    expect(res.instance?.clientCliVersion).toBe('2.1.212')
    // WHEN they were reported, so a stale reading from a device that has since
    // stopped reporting is not mistaken for a current one.
    expect(res.instance?.clientVersionAt).toBeTruthy()
    // Liveness alongside it — 'behind by N days' means something different for a
    // device that is still minting than for one that has been closed.
    expect(res.instance?.lastBearerAt).toBeTruthy()
    expect(res.instance?.endedAt).toBeNull()
  })

  it('reports NULL for a device that has never reported — itself the answer', async () => {
    const id = await enrol()
    const res = (await handler(ev({ session: admin(), query: { instanceId: id } }))) as Resp
    expect(res.instance?.clientPluginVersion).toBeNull()
    expect(res.instance?.clientCliVersion).toBeNull()
    expect(res.instance?.clientPlatform).toBeNull()
    expect(res.instance?.clientSurface).toBeNull()
    expect(res.instance?.setupMode).toBeNull()
  })

  it('surfaces the platform, surface and setup mode claims (mig 0150, #412)', async () => {
    const id = await enrol()
    await t.client.unsafe(`
      UPDATE instance_attestation
         SET client_platform = 'win32-x64', client_surface = 'cli', setup_mode = 'emit-only'
       WHERE instance_id = '${id}'`)
    const res = (await handler(ev({ session: admin(), query: { instanceId: id } }))) as Resp
    expect(res.instance).toMatchObject({ clientPlatform: 'win32-x64', clientSurface: 'cli', setupMode: 'emit-only' })
  })

  it('an unknown instance id reports known=false rather than pretending', async () => {
    const res = (await handler(ev({ session: admin(), query: { instanceId: randomUUID() } }))) as Resp
    expect(res.known).toBe(false)
    expect(res.instance).toBeNull()
  })

  it('an UNKNOWN instance id (genuinely does not exist) degrades to unanswerable, without probing ingest', async () => {
    // No requireRegionScope call is possible here — there is no region to
    // clamp against — so this must degrade the same way a failed probe does,
    // rather than ever reaching the ingest probe for an id nobody has issued.
    const before = usageRequestCount
    const res = (await handler(ev({ session: admin(), query: { instanceId: randomUUID() } }))) as Resp
    expect(res.known).toBe(false)
    expect(res.verdict).toBe('unanswerable')
    expect(res.ingest?.reachable).toBe(false)
    expect(res.ingest?.records ?? null).toBeNull()
    expect(res.ingest?.usageRecords ?? null).toBeNull()
    expect(usageRequestCount).toBe(before)
  })

  it('an instance that EXISTS in a DIFFERENT region is DENIED (403) before any of its data is read', async () => {
    /*
     * The disclosure this guards. RLS on instance_attestation is INERT at
     * runtime (the app connects as the table owner, which Postgres never
     * subjects to RLS regardless of policy or GUCs), so the row for a
     * region-B instance comes back from the SELECT regardless of the
     * caller's region — the OLD `inst === null` check could never catch this
     * case; it only ever fired for a truly nonexistent id (the case above).
     * The explicit `requireRegionScope` call is the real gate, and it must
     * run BEFORE the teammate email is read, BEFORE the ledger count, and
     * BEFORE the ingest probe — clamping after any of those would leave the
     * disclosure intact even though the final response looked denied.
     */
    const instanceId = randomUUID()
    const regionBTeammateEmail = 'it-dev-b@x.test'
    // A REAL region-B teammate — so the LEFT JOIN would actually surface an
    // email if the clamp failed to run before the read. Without this, a null
    // teammate_id would make "no email leaked" true for the wrong reason.
    const [devB] = await t.db
      .insert(schema.teammate)
      .values({ entraOid: 'oid-it-dev-b', email: regionBTeammateEmail, role: 'developer', regionId: regionBId, orgUnitId: ouBId })
      .returning()
    await t.client.unsafe(`
      INSERT INTO instance_attestation
        (instance_id, principal_oid, principal_email, teammate_id, project_code_hash, raw_project_code,
         tool, ts_start, last_bearer_at,
         attestation_state, region_id, org_unit_id, cost_owning_unit_id)
      VALUES ('${instanceId}','oid-it-b','${regionBTeammateEmail}','${devB!.id}','h-it-b','ITB',
         'claude-code', NOW() - INTERVAL '30 days', NOW(),
         'attested','${regionBId}','${ouBId}','${ouBId}')`)

    const before = usageRequestCount
    let caught: unknown
    try {
      await handler(ev({ session: admin(), query: { instanceId } })) // region-A admin
      throw new Error('expected the handler to reject with a 403')
    } catch (err) {
      caught = err
    }
    expect(caught).toMatchObject({ statusCode: 403 })

    // No teammate email — not even indirectly, via the rejected error's own
    // shape (RFC-9457 problem-details body).
    expect(JSON.stringify(caught)).not.toContain(regionBTeammateEmail)

    // The ingest probe (which would hit the stub store's `/usage` route) must
    // never have fired: the region clamp runs before it.
    expect(usageRequestCount).toBe(before)
  })
})

// Current-org lens (§3.2): the clamp follows where the device's teammate sits NOW, so the
// admin who sees the device on the attribution-gaps list can also diagnose it.
describe('instance-telemetry — region clamp follows the teammate, not the attestation stamp', () => {
  it('a device stamped region A whose teammate now sits in B: denied to A, served to B with its ledger', async () => {
    const instanceId = randomUUID()
    const [mover] = await t.db
      .insert(schema.teammate)
      .values({ entraOid: 'oid-it-mover', email: 'it-mover@x.test', role: 'developer', regionId: regionBId, orgUnitId: ouBId })
      .returning()
    const [adminB] = await t.db
      .insert(schema.teammate)
      .values({ entraOid: 'oid-it-admin-b', email: 'it-admin-b@x.test', role: 'admin', regionId: regionBId, orgUnitId: ouBId })
      .returning()
    await t.client.unsafe(`
      INSERT INTO instance_attestation
        (instance_id, principal_oid, principal_email, teammate_id, project_code_hash, raw_project_code,
         tool, ts_start, last_bearer_at,
         attestation_state, region_id, org_unit_id, cost_owning_unit_id)
      VALUES ('${instanceId}','oid-it-mover','it-mover@x.test','${mover!.id}','h-it-m','ITM',
         'claude-code', NOW() - INTERVAL '30 days', NOW(),
         'attested','${regionId}','${ouId}','${ouId}')`)
    await t.db.insert(schema.attributionRecord).values({
      instanceId, teammateId: mover!.id, regionId, orgUnitId: ouId, costOwningUnitId: ouId,
      tool: 'claude-code', model: 'claude-sonnet-4-7', tokenType: 'input', tokens: 100n, costUsd: '0.01',
      fidelityTier: 'tier-2', costBasis: 'telemetry-only', tsEvent: new Date(Date.now() - 3600_000),
    })

    await expect(handler(ev({ session: admin(), query: { instanceId } }))).rejects.toMatchObject({ statusCode: 403 })

    const adminBSession: Session = { teammateId: adminB!.id, email: 'it-admin-b@x.test', displayName: 'Admin B', role: 'admin', regionId: regionBId, orgPath: 'it-b.svc' }
    const r = (await handler(ev({ session: adminBSession, query: { instanceId } }))) as Resp
    expect(r.known).toBe(true)
    // Its records are stamped region A; the ledger count must not drop them for that.
    expect(r.attribution.records).toBe(1)
  })
})
