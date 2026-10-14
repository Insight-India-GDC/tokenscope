// @vitest-environment node
/*
 * #417: a teammate's live devices follow their placement on every move path,
 * and a device provisioned or confirmed during a move lands on the new one.
 *
 * The joiner stamps new records' region / org unit from the device row, so a
 * device left on the old placement keeps billing the old Business Unit. Owner
 * ruling: a move within a region counts as well as a region move.
 *
 * The races are made deterministic with a held lock: one transaction holds
 * the teammate row while the other is started and seen waiting on it.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { randomUUID } from 'node:crypto'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'
import { injectTestSession } from '../../helpers/auth'
import type { Session } from '../../../server/utils/auth'
import orgUnitHandler from '../../../server/api/v1/admin/users/[id]/org-unit.patch'
import bulkPlaceHandler from '../../../server/api/v1/admin/users/bulk-place.post'
import regionPatchHandler from '../../../server/api/v1/admin/users/[id]/region.patch'
import { locateOrCreateInstance } from '../../../server/auth/emit-provision'
import { confirmProvisionalInstance } from '../../../server/auth/confirm-instance'
import { followPlacement } from '../../../server/utils/device-lifecycle'
import { sql as dsql } from 'drizzle-orm'

let t: TestDb
let regionA = ''
let regionB = ''
let buFrom = ''
let buTo = ''
let buOther = ''
let holding = ''
// Real v4 UUIDs: the routes validate path ids with z.string().uuid() (CLAUDE.md rule 18).
const ADMIN_ID = '9a1e0000-0000-4000-8000-0000000004a1'
const PLATFORM_ID = '9a1e0000-0000-4000-8000-0000000004a2'

function ev(opts: { session: Session; id?: string; body?: unknown; method?: string }) {
  const headers: Record<string, string> = { host: 'localhost:3450', origin: 'http://localhost:3450' }
  const e = {
    method: opts.method ?? 'POST',
    path: '/x',
    context: { params: { id: opts.id ?? '' } },
    node: {
      req: {
        method: opts.method ?? 'POST',
        url: '/x',
        body: opts.body,
        socket: { remoteAddress: '127.0.0.1' },
        get headers() {
          return { ...headers, 'content-type': 'application/json' }
        },
      },
      res: {
        _headers: {} as Record<string, unknown>,
        statusCode: 200,
        getHeader() {},
        setHeader() {},
        removeHeader() {},
        appendHeader() {},
        get headersSent() {
          return false
        },
      },
    },
  }
  injectTestSession(e as unknown as Parameters<typeof injectTestSession>[0], opts.session)
  return e as never
}
const admin = (): Session =>
  ({ teammateId: ADMIN_ID, email: 'dfp-admin@x.test', displayName: 'Admin', role: 'admin', regionId: regionA, orgPath: 'dfrom' }) as Session
const platform = (): Session =>
  ({ teammateId: PLATFORM_ID, email: 'dfp-pa@x.test', displayName: 'PA', role: 'platform-admin', regionId: regionA, orgPath: 'dfrom' }) as Session

async function unit(rid: string, path: string) {
  const [r] = await t.client<{ id: string }[]>`
    INSERT INTO org_unit (region_id, path, code, display_name, unit_type, is_cost_owning_unit)
    VALUES (${rid}::uuid, ${path}::ltree, ${path}, ${path}, 'bu', true) RETURNING id::text AS id`
  return r!.id
}

/** A fresh teammate on buFrom with one live and one ended device. */
async function subject() {
  const id = randomUUID()
  const oid = `oid-${id}`
  await t.client`INSERT INTO teammate (id, entra_oid, email, display_name, region_id, org_unit_id, is_active)
    VALUES (${id}::uuid, ${oid}, ${`${id}@x.test`}, 'Subject', ${regionA}::uuid, ${buFrom}::uuid, true)`
  const live = randomUUID()
  const ended = randomUUID()
  for (const [iid, end] of [[live, null], [ended, new Date(Date.now() - 86_400_000).toISOString()]] as const) {
    await t.client`INSERT INTO instance_attestation
        (instance_id, principal_oid, teammate_id, tool, region_id, org_unit_id, project_code_hash, raw_project_code, ts_actual_end)
      VALUES (${iid}::uuid, ${oid}, ${id}::uuid, 'claude-code', ${regionA}::uuid, ${buFrom}::uuid, 'h', 'P', ${end}::timestamptz)`
  }
  return { id, oid, live, ended }
}

const placement = async (iid: string) =>
  (await t.client<{ region_id: string; org_unit_id: string }[]>`
    SELECT region_id::text AS region_id, org_unit_id::text AS org_unit_id
      FROM instance_attestation WHERE instance_id = ${iid}::uuid`)[0]!

/**
 * Resolves once a backend running a statement that matches `pattern` is waiting
 * on a lock: the transaction under test is blocked where the test says it is.
 */
async function untilWaiting(pattern: string) {
  for (let i = 0; i < 200; i++) {
    const [{ n }] = await t.client<{ n: number }[]>`
      SELECT count(*)::int AS n FROM pg_stat_activity
       WHERE wait_event_type = 'Lock' AND datname = current_database() AND query ILIKE ${pattern}`
    if (n > 0) return
    await new Promise((r) => setTimeout(r, 25))
  }
  throw new Error(`no statement matching ${pattern} ever waited on a lock`)
}

/** A promise and the function that resolves it. */
function signal() {
  let fire!: () => void
  const fired = new Promise<void>((r) => (fire = r))
  return { fire, fired }
}

// The statements the tests wait for: provisioning's and confirmation's locked
// placement reads, and a move's lock on the teammate.
const PROVISION_READ = '%FROM teammate WHERE id = % FOR NO KEY UPDATE%'
const CONFIRM_READ = '%AND NOT provisional%FOR NO KEY UPDATE%'
const MOVE_LOCK = '%SELECT 1 FROM teammate WHERE id = % FOR NO KEY UPDATE%'

beforeAll(async () => {
  t = await startTestDb()
  process.env.DATABASE_URL = t.url
  ;[{ id: regionA }] = await t.client<{ id: string }[]>`INSERT INTO region (code, display_name) VALUES ('dfa', 'DFA') RETURNING id::text AS id`
  ;[{ id: regionB }] = await t.client<{ id: string }[]>`INSERT INTO region (code, display_name) VALUES ('dfb', 'DFB') RETURNING id::text AS id`
  buFrom = await unit(regionA, 'dfrom')
  buTo = await unit(regionA, 'dto')
  buOther = await unit(regionB, 'dother')
  ;[{ id: holding }] = await t.client<{ id: string }[]>`
    INSERT INTO org_unit (region_id, path, code, display_name, unit_type, is_cost_owning_unit)
    VALUES (${regionA}::uuid, 'dholding', 'dholding', 'Holding', 'holding', false) RETURNING id::text AS id`
  await t.client`INSERT INTO teammate (id, entra_oid, email, display_name, role, region_id, org_unit_id, is_active)
    VALUES (${ADMIN_ID}::uuid, 'oid-dfp-admin', 'dfp-admin@x.test', 'Admin', 'admin', ${regionA}::uuid, ${buFrom}::uuid, true),
           (${PLATFORM_ID}::uuid, 'oid-dfp-pa', 'dfp-pa@x.test', 'PA', 'platform-admin', ${regionA}::uuid, ${buFrom}::uuid, true)`
}, 120_000)
afterAll(async () => {
  if (t) await stopTestDb(t)
}, 30_000)
beforeEach(() => {
  process.env.DATABASE_URL = t.url
})

describe('every move path re-homes live devices, and only live ones', () => {
  it('org-unit PATCH (a Business Unit move within a region)', async () => {
    const s = await subject()
    await orgUnitHandler(ev({ session: admin(), id: s.id, method: 'PATCH', body: { org_unit_id: buTo } }))
    expect(await placement(s.live)).toEqual({ region_id: regionA, org_unit_id: buTo })
    expect(await placement(s.ended)).toEqual({ region_id: regionA, org_unit_id: buFrom })
    const [audit] = await t.client<{ ids: string[] }[]>`
      SELECT payload->'rehomedInstanceIds' AS ids FROM audit_event
       WHERE subject_id = ${s.id}::uuid ORDER BY ts_recorded DESC LIMIT 1`
    expect(audit!.ids).toEqual([s.live])
  })

  it('bulk-place', async () => {
    const a = await subject()
    const b = await subject()
    await bulkPlaceHandler(ev({ session: admin(), body: { teammate_ids: [a.id, b.id], org_unit_id: buTo } }))
    expect((await placement(a.live)).org_unit_id).toBe(buTo)
    expect((await placement(b.live)).org_unit_id).toBe(buTo)
    expect((await placement(a.ended)).org_unit_id).toBe(buFrom)
  })

  it('region PATCH', async () => {
    const s = await subject()
    await regionPatchHandler(ev({ session: platform(), id: s.id, method: 'PATCH', body: { region_id: regionB, org_unit_id: buOther } }))
    expect(await placement(s.live)).toEqual({ region_id: regionB, org_unit_id: buOther })
    expect(await placement(s.ended)).toEqual({ region_id: regionA, org_unit_id: buFrom })
  })

  it('a provisional (shadow) teammate is refused: confirmation places it and its devices', async () => {
    const shadow = randomUUID()
    await t.client`INSERT INTO teammate (id, entra_oid, email, display_name, region_id, org_unit_id, provisional)
      VALUES (${shadow}::uuid, ${`provisional:${shadow}`}, ${`${shadow}@x.test`}, 'shadow', ${regionA}::uuid, ${buFrom}::uuid, true)`
    await expect(orgUnitHandler(ev({ session: admin(), id: shadow, method: 'PATCH', body: { org_unit_id: buTo } }))).rejects.toMatchObject({ statusCode: 422 })
    await expect(
      regionPatchHandler(ev({ session: platform(), id: shadow, method: 'PATCH', body: { region_id: regionB, org_unit_id: buOther } })),
    ).rejects.toMatchObject({ statusCode: 422 })
  })

  it('a placement to the unit the teammate is already on moves nothing', async () => {
    const s = await subject()
    await orgUnitHandler(ev({ session: admin(), id: s.id, method: 'PATCH', body: { org_unit_id: buFrom } }))
    expect((await placement(s.live)).org_unit_id).toBe(buFrom)
  })
})

describe('a provision during a move lands on the new placement, in either order', () => {
  const stale = (s: { id: string; oid: string }) => ({
    teammateId: s.id,
    principalOid: s.oid,
    email: `${s.id}@x.test`,
    // The placement provision_emit read BEFORE its transaction (mcp.ts).
    regionId: regionA,
    orgUnitId: buFrom,
  })

  it('move first: the provision waits on the teammate, then inserts the new placement', async () => {
    const s = await subject()
    const locked = signal()
    const release = signal()
    const move = t.client.begin(async (sql) => {
      await sql`SELECT 1 FROM teammate WHERE id = ${s.id}::uuid FOR NO KEY UPDATE`
      await sql`UPDATE teammate SET org_unit_id = ${buTo}::uuid WHERE id = ${s.id}::uuid`
      locked.fire()
      await release.fired
    })
    await locked.fired
    const provision = t.db.transaction((tx) => locateOrCreateInstance(tx as never, stale(s)))
    await untilWaiting(PROVISION_READ)
    release.fire()
    await move
    const out = (await provision) as { instanceId: string }
    expect(await placement(out.instanceId)).toEqual({ region_id: regionA, org_unit_id: buTo })
  })

  it('provision first: the move waits, then re-homes the device the provision committed', async () => {
    const s = await subject()
    const provisioned = signal()
    const release = signal()
    let created = ''
    const provision = t.db.transaction(async (tx) => {
      const out = (await locateOrCreateInstance(tx as never, stale(s))) as { instanceId: string }
      created = out.instanceId
      provisioned.fire()
      await release.fired
    })
    await provisioned.fired
    // A move as the routes run one: lock, write, then followPlacement in the
    // same transaction, which must see the device the provision committed.
    const move = t.db.transaction(async (tx) => {
      await tx.execute(dsql`SELECT 1 FROM teammate WHERE id = ${s.id}::uuid FOR NO KEY UPDATE`)
      await tx.execute(dsql`UPDATE teammate SET org_unit_id = ${buTo}::uuid WHERE id = ${s.id}::uuid`)
      await followPlacement(tx as never, s.id)
    })
    await untilWaiting(MOVE_LOCK)
    release.fire()
    await provision
    await move
    expect(await placement(created)).toEqual({ region_id: regionA, org_unit_id: buTo })
  })

  it('a re-provision writes the current placement back onto the reused device', async () => {
    const s = await subject()
    await t.client`UPDATE teammate SET org_unit_id = ${buTo}::uuid WHERE id = ${s.id}::uuid`
    const out = (await t.db.transaction((tx) =>
      locateOrCreateInstance(tx as never, stale(s), s.live),
    )) as { instanceId: string; reused: boolean }
    expect(out).toMatchObject({ instanceId: s.live, reused: true })
    expect((await placement(s.live)).org_unit_id).toBe(buTo)
  })
})

describe('identity confirmation takes the teammate before the device', () => {
  it('waits on a held teammate lock without holding the device, then confirms onto the new placement', async () => {
    const real = await subject()
    const shadowOid = `provisional:${randomUUID()}`
    const shadowId = randomUUID()
    await t.client`INSERT INTO teammate (id, entra_oid, email, display_name, region_id, org_unit_id, provisional)
      VALUES (${shadowId}::uuid, ${shadowOid}, ${`${real.id}@x.test`}, 'shadow', ${regionA}::uuid, ${buFrom}::uuid, true)`
    const iid = randomUUID()
    await t.client`INSERT INTO instance_attestation
        (instance_id, principal_oid, teammate_id, tool, region_id, org_unit_id, identity_state, claimed_email, project_code_hash, raw_project_code)
      VALUES (${iid}::uuid, ${shadowOid}, ${shadowId}::uuid, 'claude-code', ${regionA}::uuid, ${buFrom}::uuid,
              'provisional', ${`${real.id}@x.test`}, 'h', 'P')`

    const locked = signal()
    const release = signal()
    const move = t.client.begin(async (sql) => {
      await sql`SELECT 1 FROM teammate WHERE id = ${real.id}::uuid FOR NO KEY UPDATE`
      await sql`UPDATE teammate SET org_unit_id = ${buTo}::uuid WHERE id = ${real.id}::uuid`
      locked.fire()
      await release.fired
      // The move's own device step: it must be able to take the device lock,
      // which a device-first confirmation would hold (the deadlock).
      await sql`SELECT 1 FROM instance_attestation WHERE teammate_id = ${real.id}::uuid AND ts_actual_end IS NULL ORDER BY instance_id FOR UPDATE`
    })
    await locked.fired
    const confirm = confirmProvisionalInstance(t.db as never, {
      realTeammateId: real.id,
      realTeammateEmail: `${real.id}@x.test`,
      instanceId: iid,
    })
    await untilWaiting(CONFIRM_READ)
    // Confirmation is waiting on the teammate and does NOT hold the device row.
    const [{ free }] = await t.client<{ free: boolean }[]>`
      SELECT pg_try_advisory_xact_lock(0) AND EXISTS (
        SELECT 1 FROM instance_attestation WHERE instance_id = ${iid}::uuid FOR UPDATE SKIP LOCKED
      ) AS free`
    expect(free).toBe(true)
    release.fire()
    await move
    await confirm
    expect(await placement(iid)).toEqual({ region_id: regionA, org_unit_id: buTo })
  })
})

describe('the bill worker re-checks rehome-safety under the teammate lock', () => {
  it('a device provisioned after the worker read rehome_safe stops the home', async () => {
    const { makePlacementStore } = await import('../../../server/reconciliation/placement-store')
    const store = makePlacementStore(t.db as never)
    const placeholder = await store.createBillTeammate({ email: `bill-${randomUUID()}@x.test`, displayName: null, orgUnitId: holding })
    // The worker read rehome_safe = true here; then the person signs in and a
    // device is provisioned before the worker writes.
    await t.client`INSERT INTO instance_attestation
        (instance_id, principal_oid, teammate_id, tool, region_id, org_unit_id, project_code_hash, raw_project_code)
      VALUES (gen_random_uuid(), 'p', ${placeholder}::uuid, 'claude-code', ${regionA}::uuid, ${buFrom}::uuid, 'h', 'P')`
    expect(await store.homeTeammate(placeholder, buTo)).toBe(false)
    const [row] = await t.client<{ org_unit_id: string }[]>`SELECT org_unit_id::text AS org_unit_id FROM teammate WHERE id = ${placeholder}::uuid`
    expect(row!.org_unit_id).toBe(holding)
  })

  it('an admin placement made since the worker read it is not overwritten', async () => {
    const { makePlacementStore } = await import('../../../server/reconciliation/placement-store')
    const store = makePlacementStore(t.db as never)
    const placeholder = await store.createBillTeammate({ email: `bill-${randomUUID()}@x.test`, displayName: null, orgUnitId: holding })
    // The worker read on_unplaced = true; then an admin placed them on a real unit.
    await t.client`UPDATE teammate SET org_unit_id = ${buFrom}::uuid WHERE id = ${placeholder}::uuid`
    expect(await store.homeTeammate(placeholder, buTo)).toBe(false)
    const [row] = await t.client<{ org_unit_id: string }[]>`SELECT org_unit_id::text AS org_unit_id FROM teammate WHERE id = ${placeholder}::uuid`
    expect(row!.org_unit_id).toBe(buFrom)
  })

  it('a still-safe placeholder is homed', async () => {
    const { makePlacementStore } = await import('../../../server/reconciliation/placement-store')
    const store = makePlacementStore(t.db as never)
    const placeholder = await store.createBillTeammate({ email: `bill-${randomUUID()}@x.test`, displayName: null, orgUnitId: holding })
    expect(await store.homeTeammate(placeholder, buTo)).toBe(true)
  })
})
