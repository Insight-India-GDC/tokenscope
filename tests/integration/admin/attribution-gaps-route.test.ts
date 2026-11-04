// @vitest-environment node
/*
 * GET /api/v1/admin/diagnostics/attribution-gaps — the operator surface for the
 * silent-attribution outage class.
 *
 * Written because the mutation sweep found EVERY line of this route deletable
 * with the suite green — including `requireRole`. The worker had 13 tests; the
 * endpoint had none. That matters more than usual here: the response carries
 * instance ids and teammate emails, so an unguarded route leaks who is using
 * what, and "the RBAC line is obviously there" is exactly the assumption a
 * refactor breaks silently.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { randomUUID } from 'node:crypto'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'
import * as schema from '../../../drizzle/schema'
import { injectTestSession } from '../../helpers/auth'
import type { Session } from '../../../server/utils/auth'
import handler from '../../../server/api/v1/admin/diagnostics/attribution-gaps.get'

let t: TestDb
let regionId: string
let ouId: string
let adminId: string
let devId: string
let finopsId: string
let regionBId: string
let ouBId: string
let devBId: string

/** Minimal h3-shaped event with a query string + injected session. */
function ev(opts: { session: Session; query?: Record<string, string> }) {
  const qs = opts.query ? `?${new URLSearchParams(opts.query).toString()}` : ''
  const headers: Record<string, string> = {}
  const e = {
    // h3's getQuery reads event.path, NOT node.req.url — a mock without it
    // silently yields an empty query, so every param test would pass vacuously.
    path: `/api/v1/admin/diagnostics/attribution-gaps${qs}`,
    node: {
      req: {
        method: 'GET',
        url: `/api/v1/admin/diagnostics/attribution-gaps${qs}`,
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
  return e as unknown as Parameters<typeof handler>[0]
}

const admin = (): Session => ({ teammateId: adminId, email: 'ag-admin@x.test', displayName: 'Admin', role: 'admin', regionId, orgPath: 'ag.svc' })
const finops = (): Session => ({ teammateId: finopsId, email: 'ag-fin@x.test', displayName: 'Fin', role: 'platform-admin', regionId, orgPath: 'ag.svc' })
const dev = (): Session => ({ teammateId: devId, email: 'ag-dev@x.test', displayName: 'Dev', role: 'developer', regionId, orgPath: 'ag.svc' })

beforeAll(async () => {
  t = await startTestDb()
  process.env.DATABASE_URL = t.url
  const [r] = await t.db.insert(schema.region).values({ code: 'ag-r', displayName: 'AG R' }).returning()
  regionId = r!.id
  const [o] = await t.db
    .insert(schema.orgUnit)
    .values({ regionId, path: 'ag.svc', code: 'ag-svc', displayName: 'Svc', unitType: 'bu', isCostOwningUnit: true })
    .returning()
  ouId = o!.id
  const [a] = await t.db
    .insert(schema.teammate)
    .values({ entraOid: 'oid-ag-admin', email: 'ag-admin@x.test', role: 'admin', regionId, orgUnitId: ouId })
    .returning()
  adminId = a!.id
  const [f] = await t.db
    .insert(schema.teammate)
    .values({ entraOid: 'oid-ag-fin', email: 'ag-fin@x.test', role: 'platform-admin', regionId, orgUnitId: ouId })
    .returning()
  finopsId = f!.id
  const [d] = await t.db
    .insert(schema.teammate)
    .values({ entraOid: 'oid-ag-dev', email: 'ag-dev@x.test', role: 'developer', regionId, orgUnitId: ouId })
    .returning()
  devId = d!.id

  // A second region, for the region-clamp case.
  const [rb] = await t.db.insert(schema.region).values({ code: 'ag-r-b', displayName: 'AG R B' }).returning()
  regionBId = rb!.id
  const [ob] = await t.db
    .insert(schema.orgUnit)
    .values({ regionId: regionBId, path: 'ag-b.svc', code: 'ag-b-svc', displayName: 'Svc B', unitType: 'bu', isCostOwningUnit: true })
    .returning()
  ouBId = ob!.id
  const [db_] = await t.db
    .insert(schema.teammate)
    .values({ entraOid: 'oid-ag-dev-b', email: 'ag-dev-b@x.test', role: 'developer', regionId: regionBId, orgUnitId: ouBId })
    .returning()
  devBId = db_!.id
}, 180_000)

afterAll(async () => {
  await stopTestDb(t)
})

/** An instance that is minting now but last attributed `daysBehind` ago. */
async function seedGap(daysBehind: number): Promise<string> {
  return seedGapIn({ regionId, ouId, teammateId: devId, teammateEmail: 'ag-dev@x.test', daysBehind })
}

/** Same as seedGap, but parameterised over region/org-unit/teammate — used by the region-clamp case. */
async function seedGapIn(opts: {
  regionId: string
  ouId: string
  teammateId: string
  teammateEmail: string
  daysBehind: number
}): Promise<string> {
  const instanceId = randomUUID()
  await t.client.unsafe(`
    INSERT INTO instance_attestation
      (instance_id, principal_oid, principal_email, teammate_id, project_code_hash, raw_project_code,
       tool, session_token_hash, ts_start, last_bearer_at, attestation_state, region_id, org_unit_id, cost_owning_unit_id)
    VALUES
      ('${instanceId}', 'oid-${instanceId.slice(0, 8)}', '${opts.teammateEmail}', '${opts.teammateId}', 'h-agr', 'AGR',
       'claude-code', 'tok-${instanceId.slice(0, 8)}', NOW() - INTERVAL '60 days', NOW() - INTERVAL '1 hour',
       'attested', '${opts.regionId}', '${opts.ouId}', '${opts.ouId}')
  `)
  await t.db.insert(schema.attributionRecord).values({
    instanceId,
    teammateId: opts.teammateId,
    regionId: opts.regionId,
    orgUnitId: opts.ouId,
    costOwningUnitId: opts.ouId,
    tool: 'claude-code',
    model: 'claude-sonnet-4-7',
    tokenType: 'input',
    tokens: 100n,
    costUsd: '0.01',
    fidelityTier: 'tier-2',
    costBasis: 'telemetry-only',
    tsEvent: new Date(Date.now() - opts.daysBehind * 24 * 3600_000),
  })
  return instanceId
}

describe('GET /admin/diagnostics/attribution-gaps — RBAC', () => {
  it('REJECTS a developer — the response carries instance ids and teammate emails', async () => {
    await expect(handler(ev({ session: dev() }))).rejects.toMatchObject({ statusCode: 403 })
  })

  it('allows an admin', async () => {
    const res = (await handler(ev({ session: admin() }))) as { reachable: boolean }
    expect(res.reachable).toBe(true)
  })

  it('allows platform-admin', async () => {
    const res = (await handler(ev({ session: finops() }))) as { reachable: boolean }
    expect(res.reachable).toBe(true)
  })
})

describe('GET /admin/diagnostics/attribution-gaps — payload', () => {
  it('reports a starved instance with the teammate and how far behind it is', async () => {
    const id = await seedGap(19)
    const res = (await handler(ev({ session: admin() }))) as {
      count: number
      instances: Array<{ instanceId: string; email: string | null; gapHours: number }>
    }
    const row = res.instances.find((i) => i.instanceId === id)
    expect(row, 'the seeded gap should be listed').toBeTruthy()
    expect(row!.email).toBe('ag-dev@x.test')
    expect(row!.gapHours).toBeGreaterThan(18 * 24)
    expect(res.count).toBeGreaterThanOrEqual(1)
  })

  it('honours the gapHours query param so the lens can be widened mid-incident', async () => {
    // Seed a gap UNDER the default threshold, then widen the lens to catch it —
    // the actual operator move during an incident ("show me anything more than
    // 12h behind"), and the only way to prove the param is wired rather than
    // silently ignored.
    const id = await seedGap(1) // 24h behind — under the 72h default
    const tight = (await handler(ev({ session: admin() }))) as { instances: Array<{ instanceId: string }> }
    expect(tight.instances.map((i) => i.instanceId)).not.toContain(id)

    const widened = (await handler(ev({ session: admin(), query: { gapHours: '12' } }))) as {
      instances: Array<{ instanceId: string }>
    }
    expect(widened.instances.map((i) => i.instanceId)).toContain(id)
  })

  it('echoes the thresholds it applied, so a widened lens is visible in the response', async () => {
    const dflt = (await handler(ev({ session: admin() }))) as { gapHours: number | null; liveHours: number | null }
    expect(dflt.gapHours).toBeNull() // null = the worker's default was used
    expect(dflt.liveHours).toBeNull()

    const tuned = (await handler(ev({ session: admin(), query: { gapHours: '12', liveHours: '48' } }))) as {
      gapHours: number | null
      liveHours: number | null
    }
    expect(tuned.gapHours).toBe(12)
    expect(tuned.liveHours).toBe(48)
  })

  it('rejects a nonsense query param rather than silently using the default', async () => {
    await expect(handler(ev({ session: admin(), query: { gapHours: '-5' } }))).rejects.toBeTruthy()
  })
})

describe('GET /admin/diagnostics/attribution-gaps — region clamp', () => {
  it('a region-A admin never sees a region-B gap; platform-admin sees both', async () => {
    const idA = await seedGap(19)
    const idB = await seedGapIn({ regionId: regionBId, ouId: ouBId, teammateId: devBId, teammateEmail: 'ag-dev-b@x.test', daysBehind: 19 })

    const asAdmin = (await handler(ev({ session: admin() }))) as { instances: Array<{ instanceId: string }> }
    const adminIds = asAdmin.instances.map((i) => i.instanceId)
    expect(adminIds).toContain(idA)
    expect(adminIds).not.toContain(idB)

    const asFinops = (await handler(ev({ session: finops() }))) as { instances: Array<{ instanceId: string }> }
    const finopsIds = asFinops.instances.map((i) => i.instanceId)
    expect(finopsIds).toContain(idA)
    expect(finopsIds).toContain(idB)
  })

  it('clamps on the region the teammate sits in NOW, not the attestation stamp (current-org-lens §3.2)', async () => {
    // Stamped region A (where the device was enrolled); its teammate devB sits in region B.
    const id = await seedGapIn({ regionId, ouId, teammateId: devBId, teammateEmail: 'ag-dev-b3@x.test', daysBehind: 19 })
    const [adminB] = await t.db
      .insert(schema.teammate)
      .values({ entraOid: 'oid-ag-admin-b', email: 'ag-admin-b@x.test', role: 'admin', regionId: regionBId, orgUnitId: ouBId })
      .returning()
    const sessionB: Session = { teammateId: adminB!.id, email: 'ag-admin-b@x.test', displayName: 'Admin B', role: 'admin', regionId: regionBId, orgPath: 'ag-b.svc' }

    const asA = (await handler(ev({ session: admin() }))) as { instances: Array<{ instanceId: string }> }
    const asB = (await handler(ev({ session: sessionB }))) as { instances: Array<{ instanceId: string }> }
    expect(asA.instances.map((i) => i.instanceId)).not.toContain(id)
    expect(asB.instances.map((i) => i.instanceId)).toContain(id)
  })

  it('MUST NOT BREAK: the underlying worker predicate stays estate-wide when called with no regionId (the parameter defaults to null)', async () => {
    const idB = await seedGapIn({ regionId: regionBId, ouId: ouBId, teammateId: devBId, teammateEmail: 'ag-dev-b2@x.test', daysBehind: 20 })
    const { findAttributionGaps } = await import('../../../server/workers/attribution-gap')
    const unfiltered = await findAttributionGaps(t.db, {})
    expect(unfiltered.map((i) => i.instanceId)).toContain(idB)
  })
})
