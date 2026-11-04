// @vitest-environment node
/*
 * Scoped pickers for non-admins (A13): teammates (existing, active, confirmed
 * only; the contract the PM-powers track consumes), Business Units across
 * regions with the caller's own, and the similar-project duplicate hint.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'
import { routeEvent } from '../helpers/route-event'
import * as schema from '../../../drizzle/schema'
import type { Session } from '../../../server/utils/auth'
import teammatesPicker from '../../../server/api/v1/pickers/teammates.get'
import unitsPicker from '../../../server/api/v1/pickers/business-units.get'
import similarPicker from '../../../server/api/v1/pickers/similar-projects.get'

let t: TestDb
let regionA: string
let regionB: string
let buA: string
let buB: string
let devId: string

const dev = (): Session => ({ teammateId: devId, email: 'pk-dev@x.test', displayName: 'Dev', role: 'developer', regionId: regionA, orgPath: 'pka.svc', issuedAt: '2026-10-28T00:00:00Z' })

beforeAll(async () => {
  t = await startTestDb()
  process.env.DATABASE_URL = t.url
  const [ra] = await t.db.insert(schema.region).values({ code: 'pk-a', displayName: 'PK A' }).returning()
  const [rb] = await t.db.insert(schema.region).values({ code: 'pk-b', displayName: 'PK B' }).returning()
  regionA = ra!.id
  regionB = rb!.id
  const [oa] = await t.db.insert(schema.orgUnit).values({ regionId: regionA, path: 'pka.svc', code: 'pka-svc', displayName: 'A Services', unitType: 'bu', isCostOwningUnit: true }).returning()
  const [team] = await t.db.insert(schema.orgUnit).values({ regionId: regionA, path: 'pka.svc.team', code: 'pka-team', displayName: 'A Team', unitType: 'team', isCostOwningUnit: false }).returning()
  const [ob] = await t.db.insert(schema.orgUnit).values({ regionId: regionB, path: 'pkb.svc', code: 'pkb-svc', displayName: 'B Services', unitType: 'bu', isCostOwningUnit: true }).returning()
  await t.db.insert(schema.orgUnit).values({ regionId: regionB, path: 'pkb.old', code: 'pkb-old', displayName: 'B Old', unitType: 'bu', isCostOwningUnit: true, retiredAt: new Date('2026-01-01T00:00:00Z') })
  buA = oa!.id
  buB = ob!.id
  const [d] = await t.db.insert(schema.teammate).values({ entraOid: 'pk-dev', email: 'pk-dev@x.test', displayName: 'Dana Developer', role: 'developer', regionId: regionA, orgUnitId: team!.id }).returning()
  devId = d!.id
  await t.db.insert(schema.teammate).values([
    { entraOid: 'pk-dan', email: 'dan.smith@x.test', displayName: 'Dan Smith', role: 'developer', regionId: regionB, orgUnitId: buB },
    { entraOid: 'pk-gone', email: 'dan.gone@x.test', displayName: 'Dan Gone', role: 'developer', regionId: regionA, orgUnitId: buA, isActive: false },
    { entraOid: 'provisional:pk', email: 'dan.prov@x.test', displayName: 'Dan Provisional', role: 'developer', regionId: regionA, orgUnitId: buA, provisional: true },
  ])
  await t.db.insert(schema.project).values([
    { code: 'ACME-DATA', codeHash: 'h-acme-data', displayName: 'Acme data platform', type: 'billable', regionId: regionA, costOwningUnitId: buA },
    { code: 'GLOBEX', codeHash: 'h-globex', displayName: 'Globex migration', type: 'billable', regionId: regionB, costOwningUnitId: buB },
  ])
}, 120_000)

afterAll(async () => {
  await stopTestDb(t)
}, 30_000)

describe('GET /api/v1/pickers/teammates', () => {
  it('returns active, confirmed teammates across regions in the { teammates: [{ id, display_name, email }] } shape', async () => {
    const out = (await teammatesPicker(routeEvent({ method: 'GET', query: { q: 'dan' }, session: dev() }))) as {
      teammates: Record<string, unknown>[]
    }
    expect(out.teammates.map((r) => r.email).sort()).toEqual(['dan.smith@x.test', 'pk-dev@x.test'])
    for (const r of out.teammates) expect(Object.keys(r).sort()).toEqual(['display_name', 'email', 'id'])
  })

  it('a one-character query is 400; LIKE wildcards are literal', async () => {
    await expect(teammatesPicker(routeEvent({ method: 'GET', query: { q: 'd' }, session: dev() }))).rejects.toMatchObject({ statusCode: 400 })
    const out = (await teammatesPicker(routeEvent({ method: 'GET', query: { q: '%%' }, session: dev() }))) as { teammates: unknown[] }
    expect(out.teammates).toEqual([])
  })
})

describe('GET /api/v1/pickers/business-units', () => {
  it('lists active cost-owning units in every region, and the caller’s own Business Unit', async () => {
    const out = (await unitsPicker(routeEvent({ method: 'GET', session: dev() }))) as {
      units: { id: string; region_id: string }[]
      my_unit_id: string | null
    }
    expect(out.units.map((u) => u.id).sort()).toEqual([buA, buB].sort())
    expect(out.units.find((u) => u.id === buB)!.region_id).toBe(regionB)
    expect(out.my_unit_id).toBe(buA)
  })
})

describe('GET /api/v1/pickers/similar-projects', () => {
  it('finds projects sharing a word with the name, in any region', async () => {
    const out = (await similarPicker(routeEvent({ method: 'GET', query: { name: 'New ACME platform work' }, session: dev() }))) as {
      projects: { code: string }[]
    }
    expect(out.projects.map((p) => p.code)).toEqual(['ACME-DATA'])
    const none = (await similarPicker(routeEvent({ method: 'GET', query: { name: 'Initech' }, session: dev() }))) as { projects: unknown[] }
    expect(none.projects).toEqual([])
  })
})
