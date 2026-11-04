// @vitest-environment node
/*
 * Admin diagnostics clamp a region admin by the region each teammate sits in NOW
 * (docs/design/current-org-lens/00-design.md §3.2), never by the stamped
 * attribution_record.region_id. Mo's records are stamped region A; he now sits in
 * region B. Both the pipeline-freshness panel (GET /diagnostics) and the costing
 * rungs (GET /diagnostics/costing) must count him for B's admin and not for A's.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { randomUUID } from 'node:crypto'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'
import * as schema from '../../../drizzle/schema'
import { injectTestSession } from '../../helpers/auth'
import type { Session } from '../../../server/utils/auth'
import snapshotHandler from '../../../server/api/v1/admin/diagnostics/index.get'
import costingHandler from '../../../server/api/v1/admin/diagnostics/costing.get'

let t: TestDb
let regionA = ''
let regionB = ''
let adminA = ''
let adminB = ''

function ev(session: Session) {
  const e = {
    path: '/api/v1/admin/diagnostics',
    node: {
      req: {
        method: 'GET',
        url: '/api/v1/admin/diagnostics',
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
  injectTestSession(e as unknown as Parameters<typeof injectTestSession>[0], session)
  return e as unknown as Parameters<typeof snapshotHandler>[0]
}

const sessionFor = (teammateId: string, regionId: string, orgPath: string): Session =>
  ({ teammateId, email: `${teammateId}@x.test`, displayName: 'Admin', role: 'admin', regionId, orgPath })

beforeAll(async () => {
  t = await startTestDb()
  process.env.DATABASE_URL = t.url
  const mk = async (code: string) => {
    const [r] = await t.db.insert(schema.region).values({ code, displayName: code }).returning()
    const [o] = await t.db
      .insert(schema.orgUnit)
      .values({ regionId: r!.id, path: `${code}.svc`, code: `${code}-svc`, displayName: code, unitType: 'bu', isCostOwningUnit: true })
      .returning()
    return { region: r!.id, unit: o!.id }
  }
  const a = await mk('dcr_a')
  const b = await mk('dcr_b')
  regionA = a.region
  regionB = b.region
  const person = async (email: string, role: string, at: { region: string; unit: string }) => {
    const [tm] = await t.db
      .insert(schema.teammate)
      .values({ entraOid: `oid-${email}`, email, role, regionId: at.region, orgUnitId: at.unit })
      .returning()
    return tm!.id
  }
  adminA = await person('dcr-admin-a@x.test', 'admin', a)
  adminB = await person('dcr-admin-b@x.test', 'admin', b)
  const mo = await person('dcr-mo@x.test', 'developer', b) // sits in B now

  // Everything Mo emitted was stamped region A (where he sat at the time).
  const instanceId = randomUUID()
  await t.client.unsafe(`
    INSERT INTO instance_attestation
      (instance_id, principal_oid, principal_email, teammate_id, project_code_hash, raw_project_code,
       tool, ts_start, last_bearer_at, attestation_state, region_id, org_unit_id, cost_owning_unit_id)
    VALUES ('${instanceId}', 'oid-dcr-mo', 'dcr-mo@x.test', '${mo}', 'h-dcr', 'DCR',
       'claude-code', NOW() - INTERVAL '30 days', NOW(), 'attested', '${a.region}', '${a.unit}', '${a.unit}')`)
  await t.db.insert(schema.attributionRecord).values({
    instanceId, teammateId: mo, regionId: a.region, orgUnitId: a.unit, costOwningUnitId: a.unit,
    tool: 'claude-code', model: 'claude-sonnet-4-6', tokenType: 'input', tokens: 100n, costUsd: '0.01',
    fidelityTier: 'tier-1', costBasis: 'provider-reported', tsEvent: new Date(Date.now() - 10 * 60_000),
    sourceRunId: 'dcr-span',
  })
}, 180_000)

afterAll(async () => {
  await stopTestDb(t)
})

describe('admin diagnostics — region admin sees the people in their region now', () => {
  it('pipeline freshness: usage stamped A counts for the admin of B, where its teammate sits', async () => {
    type Snap = { pipeline: { lastUsageSeen: string | null } }
    const asB = (await snapshotHandler(ev(sessionFor(adminB, regionB, 'dcr_b.svc')))) as Snap
    const asA = (await snapshotHandler(ev(sessionFor(adminA, regionA, 'dcr_a.svc')))) as Snap
    expect(asB.pipeline.lastUsageSeen).not.toBeNull()
    expect(asA.pipeline.lastUsageSeen).toBeNull()
  })

  it('costing rungs: the span stamped A is counted for B and not for A', async () => {
    type Costing = { costingRungs: { spans: number; provider: number } }
    const asB = (await costingHandler(ev(sessionFor(adminB, regionB, 'dcr_b.svc')))) as Costing
    const asA = (await costingHandler(ev(sessionFor(adminA, regionA, 'dcr_a.svc')))) as Costing
    expect(asB.costingRungs).toMatchObject({ spans: 1, provider: 1 })
    expect(asA.costingRungs.spans).toBe(0)
  })
})
