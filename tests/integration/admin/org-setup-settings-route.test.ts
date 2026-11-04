// @vitest-environment node
/*
 * Org setup settings and dismissals routes (docs/design/org-setup/00-spec.md)
 * against real Postgres: RBAC, CSRF, validation, audit, the cycle a new top person
 * starts, and dismissals scoped to the current cycle.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'
import * as schema from '../../../drizzle/schema'
import { injectTestSession } from '../../helpers/auth'
import type { Session } from '../../../server/utils/auth'
import type { OrgSetupSettings } from '../../../shared/org-setup/contract'

const { default: getSettings } = await import('../../../server/api/v1/admin/org-setup/settings.get')
const { default: putSettings } = await import('../../../server/api/v1/admin/org-setup/settings.put')
const { default: postDismissal } = await import('../../../server/api/v1/admin/org-setup/dismissals.post')

const TOP_A = '9a1e0000-0000-4000-8000-0000000000a1'
const TOP_B = '9a1e0000-0000-4000-8000-0000000000b1'

let t: TestDb
let r1 = ''
let platformId = ''
let regionAdminId = ''

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
  return e as unknown as Parameters<typeof getSettings>[0]
}

const platform = (): Session => ({ teammateId: platformId, email: 'os-platform@x.test', displayName: 'P', role: 'platform-admin', regionId: r1, orgPath: 'os1', issuedAt: new Date().toISOString() })
const regionAdmin = (): Session => ({ teammateId: regionAdminId, email: 'os-ra@x.test', displayName: 'RA', role: 'admin', regionId: r1, orgPath: 'os1', issuedAt: new Date().toISOString() })

const cycles = async () => (await t.client<{ n: number }[]>`SELECT count(*)::int AS n FROM placement_check_cycle`)[0]!.n
const audits = async (type: string) =>
  t.client<{ payload: Record<string, unknown>; actor: string | null; subject_id: string | null }[]>`
    SELECT payload, actor_teammate_id::text AS actor, subject_id::text AS subject_id
    FROM audit_event WHERE event_type = ${type} ORDER BY ts_recorded, id`

beforeAll(async () => {
  t = await startTestDb()
  process.env.DATABASE_URL = t.url
  const [a] = await t.db.insert(schema.region).values({ code: 'os1', displayName: 'Region One' }).returning()
  r1 = a!.id
  const [o] = await t.db.insert(schema.orgUnit).values({ regionId: r1, path: 'os1', code: 'os1', displayName: 'Unit', unitType: 'bu', isCostOwningUnit: true }).returning()
  const [p] = await t.db.insert(schema.teammate).values({ entraOid: 'oid-os-platform', email: 'os-platform@x.test', role: 'platform-admin', regionId: r1, orgUnitId: o!.id }).returning()
  platformId = p!.id
  const [ra] = await t.db.insert(schema.teammate).values({ entraOid: 'oid-os-ra', email: 'os-ra@x.test', role: 'admin', regionId: r1, orgUnitId: o!.id }).returning()
  regionAdminId = ra!.id
}, 180_000)

afterAll(async () => { await stopTestDb(t) }, 30_000)

describe('org-setup settings + dismissals routes', () => {
  it('a region admin gets 403 on every route', async () => {
    await expect(getSettings(ev({ method: 'GET', session: regionAdmin() }))).rejects.toMatchObject({ statusCode: 403 })
    await expect(putSettings(ev({ method: 'PUT', session: regionAdmin(), body: { readCadence: 'week' } }))).rejects.toMatchObject({ statusCode: 403 })
    await expect(postDismissal(ev({ method: 'POST', session: regionAdmin(), body: { kind: 'new-team', subjectKey: 'x' } }))).rejects.toMatchObject({ statusCode: 403 })
  })

  it('writes refuse a cross-origin request', async () => {
    await expect(putSettings(ev({ method: 'PUT', session: platform(), origin: 'https://evil.test', body: { readCadence: 'week' } }))).rejects.toMatchObject({ statusCode: 403 })
    await expect(postDismissal(ev({ method: 'POST', session: platform(), origin: 'https://evil.test', body: { kind: 'new-team', subjectKey: 'x' } }))).rejects.toMatchObject({ statusCode: 403 })
  })

  it('GET before anything is set: no top, monthly', async () => {
    const s = (await getSettings(ev({ method: 'GET', session: platform() }))) as OrgSetupSettings
    expect(s.top).toBeNull()
    expect(s.readCadence).toBe('month')
  })

  it('a dismissal before any cycle is a 409 and writes nothing', async () => {
    await expect(postDismissal(ev({ method: 'POST', session: platform(), body: { kind: 'new-team', subjectKey: 'oid-x' } })))
      .rejects.toMatchObject({ statusCode: 409, data: { type: 'https://tokenscope.example.com/errors/placement-check-no-cycle' } })
    const [n] = await t.client<{ n: number }[]>`SELECT count(*)::int AS n FROM org_setup_dismissal`
    expect(n!.n).toBe(0)
  })

  it('PUT validates strictly', async () => {
    for (const body of [
      { readCadence: 'day' },
      { extra: true },
      { top: { oid: '', name: null, email: null } },
      { top: { oid: 'bill:9a1e0000-0000-4000-8000-000000000001', name: null, email: null } },
      { top: { oid: TOP_A, name: null, email: null, more: 1 } },
    ]) {
      await expect(putSettings(ev({ method: 'PUT', session: platform(), body })), JSON.stringify(body)).rejects.toMatchObject({ statusCode: 400 })
    }
    expect(await cycles()).toBe(0)
  })

  it('a cadence change alone is audited and starts no cycle', async () => {
    const s = (await putSettings(ev({ method: 'PUT', session: platform(), body: { readCadence: 'week' } }))) as OrgSetupSettings
    expect(s).toMatchObject({ top: null, readCadence: 'week' })
    expect(await cycles()).toBe(0)
    const rows = await audits('org-setup-settings-changed')
    expect(rows).toHaveLength(1)
    expect(rows[0]!.actor).toBe(platformId)
    expect(rows[0]!.payload).toEqual({
      before: { top: null, read_cadence: 'month' },
      after: { top: null, read_cadence: 'week' },
      cycle_id: null,
    })
  })

  it('setting the top starts a cycle in the same save; re-saving the same top does not', async () => {
    const top = { oid: TOP_A, name: 'Ada Top', email: 'ada@x.test' }
    const s = (await putSettings(ev({ method: 'PUT', session: platform(), body: { top } }))) as OrgSetupSettings
    expect(s).toMatchObject({ top, readCadence: 'week' })
    expect(await cycles()).toBe(1)
    const [cycle] = await t.client<{ id: string; started_by: string }[]>`SELECT id::text, started_by::text FROM placement_check_cycle`
    expect(cycle!.started_by).toBe(platformId)
    const changed = await audits('org-setup-settings-changed')
    expect(changed.at(-1)!.payload).toMatchObject({ before: { top: null }, after: { top }, cycle_id: cycle!.id })
    const started = await audits('placement-check-started')
    expect(started.map((a) => a.subject_id)).toEqual([cycle!.id])

    // Same oid, new display name: stored, no new cycle.
    await putSettings(ev({ method: 'PUT', session: platform(), body: { top: { ...top, name: 'Ada T.' } } }))
    expect(await cycles()).toBe(1)
    const after = (await getSettings(ev({ method: 'GET', session: platform() }))) as OrgSetupSettings
    expect(after.top).toEqual({ ...top, name: 'Ada T.' })

    // A different top person: a new cycle.
    await putSettings(ev({ method: 'PUT', session: platform(), body: { top: { oid: TOP_B, name: null, email: null } } }))
    expect(await cycles()).toBe(2)
  })

  it('a dismissal is stored in the current cycle once, audited once, and refuses a kind that is not dismissible', async () => {
    const body = { kind: 'new-team', subjectKey: 'oid-mgr-1' }
    const first = await postDismissal(ev({ method: 'POST', session: platform(), body }))
    const second = await postDismissal(ev({ method: 'POST', session: platform(), body }))
    expect(first).toMatchObject({ ...body, created: true })
    expect(second).toMatchObject({ ...body, created: false, cycleId: first.cycleId })
    const [current] = await t.client<{ id: string }[]>`SELECT id::text FROM placement_check_cycle ORDER BY started_at DESC, id DESC LIMIT 1`
    expect(first.cycleId).toBe(current!.id)
    const rows = await t.client<{ cycle_id: string; dismissed_by: string }[]>`SELECT cycle_id::text, dismissed_by::text FROM org_setup_dismissal`
    expect(rows).toEqual([{ cycle_id: current!.id, dismissed_by: platformId }])
    const audit = await audits('org-setup-decision-dismissed')
    expect(audit).toHaveLength(1)
    expect(audit[0]!.payload).toEqual({ kind: 'new-team', subject_key: 'oid-mgr-1', cycle_id: current!.id })

    await expect(postDismissal(ev({ method: 'POST', session: platform(), body: { kind: 'owner-left', subjectKey: 'x' } }))).rejects.toMatchObject({ statusCode: 400 })
    await expect(postDismissal(ev({ method: 'POST', session: platform(), body: { kind: 'new-team', subjectKey: '' } }))).rejects.toMatchObject({ statusCode: 400 })
    await expect(postDismissal(ev({ method: 'POST', session: platform(), body: { ...body, extra: 1 } }))).rejects.toMatchObject({ statusCode: 400 })
  })
})
