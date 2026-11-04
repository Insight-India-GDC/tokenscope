// @vitest-environment node
/*
 * The scheduled placement-check run (docs/design/org-setup/00-spec.md, Server →
 * Worker) against real Postgres, through the registry entry the run-worker endpoint
 * dispatches, with the directory stubbed: nothing without a top person; a cycle when
 * the cadence says one is due; one pass; then each active unit owner and region
 * leader looked up once per cycle.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'
import * as schema from '../../../drizzle/schema'
import type { DirectoryUser } from '../../../server/azure/directory'

const dir = vi.hoisted(() => ({
  users: new Map<string, { oid: string; email: string; displayName: string }>(),
  managers: new Map<string, string>(),
  fail: new Set<string>(),
  lookups: [] as string[],
}))

vi.mock('../../../server/azure/directory', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../server/azure/directory')>()
  const toDir = (u: { oid: string; email: string; displayName: string }): DirectoryUser => ({
    oid: u.oid, email: u.email, displayName: u.displayName, mail: u.email, upn: u.email, department: null,
    jobTitle: null, companyName: null, country: null, officeLocation: null, state: null, costCenter: null, division: null,
  })
  return {
    ...real,
    getDirectoryUserByOidStrict: async (oid: string) => {
      dir.lookups.push(oid)
      if (dir.fail.has(oid)) throw new real.GraphHttpError(503, `/users/${oid}`)
      const u = dir.users.get(oid)
      return u ? toDir(u) : null
    },
    getDirectoryUserByMailOrUpnStrict: async () => null,
    getUserManager: async (oid: string) => {
      const m = dir.managers.get(oid)
      const u = m ? dir.users.get(m) : undefined
      return u ? { oid: u.oid, email: u.email, name: u.displayName } : null
    },
  }
})

/** The audit write passes through to the real one unless a test switches it to fail. */
const audit = vi.hoisted(() => ({ failStarted: false }))

vi.mock('../../../server/db/audit', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../server/db/audit')>()
  return {
    ...real,
    recordAuditEvent: async (...args: Parameters<typeof real.recordAuditEvent>) => {
      if (audit.failStarted && args[1].eventType === 'placement-check-started') throw new Error('audit store down')
      return real.recordAuditEvent(...args)
    },
  }
})

const { getWorker } = await import('../../../server/workers/registry')
const { runScheduledPlacementCheck } = await import('../../../server/workers/placement-check')
const { startPlacementCycle } = await import('../../../server/reconciliation/placement-check-store')
type Scheduled = Awaited<ReturnType<typeof runScheduledPlacementCheck>>

const LEADER_FOUND = '9a1e0000-0000-4000-8000-0000000000c1'
const LEADER_GONE = '9a1e0000-0000-4000-8000-0000000000c2'
const LEADER_FLAKY = '9a1e0000-0000-4000-8000-0000000000c3'
const LEADER_BILL = 'bill:9a1e0000-0000-4000-8000-0000000000c4'
const OWNER = '9a1e0000-0000-4000-8000-0000000000d1'
const ALICE = '9a1e0000-0000-4000-8000-0000000000d2'

let t: TestDb
let regionId = ''
let unitId = ''

const entry = () => getWorker('placement-check')!
const scheduled = async () => (await entry().run(t.db, { runId: null, opts: { scheduled: true } })) as Scheduled
const cycles = async () =>
  t.client<{ id: string; started_by: string | null }[]>`
    SELECT id::text, started_by::text FROM placement_check_cycle ORDER BY started_at, id`
const principalRows = async () =>
  t.client<{ oid: string; cycle_id: string; found: boolean }[]>`
    SELECT oid, cycle_id::text, found FROM placement_principal_check ORDER BY oid`

beforeAll(async () => {
  t = await startTestDb()
  process.env.DATABASE_URL = t.url
  const [r] = await t.db.insert(schema.region).values({ code: 'ps1', displayName: 'Region One' }).returning()
  const [u] = await t.db.insert(schema.orgUnit).values({ regionId: r!.id, path: 'ps1.u1', code: 'ps1-u1', displayName: 'Unit One', unitType: 'bu', isCostOwningUnit: true }).returning()
  regionId = r!.id
  unitId = u!.id
  const [owner] = await t.db.insert(schema.teammate).values({ entraOid: OWNER, email: 'owner@ps.test', displayName: 'Owner', regionId: r!.id, orgUnitId: u!.id }).returning()
  await t.db.insert(schema.teammate).values({ entraOid: ALICE, email: 'alice@ps.test', displayName: 'Alice', regionId: r!.id, orgUnitId: u!.id })
  await t.client`INSERT INTO cou_owner (org_unit_id, teammate_id) VALUES (${u!.id}::uuid, ${owner!.id}::uuid)`
  for (const oid of [LEADER_FOUND, LEADER_GONE, LEADER_FLAKY, LEADER_BILL]) {
    await t.client`INSERT INTO region_leader (region_id, leader_oid, leader_email) VALUES (${r!.id}::uuid, ${oid}, ${`${oid}@ps.test`})`
  }
  // A revoked leader is not checked.
  await t.client`INSERT INTO region_leader (region_id, leader_oid, leader_email, revoked_at)
    VALUES (${r!.id}::uuid, '9a1e0000-0000-4000-8000-0000000000c9', 'old@ps.test', NOW())`
  for (const [oid, name] of [[LEADER_FOUND, 'Lee'], [OWNER, 'Owner'], [ALICE, 'Alice']] as const) {
    dir.users.set(oid, { oid, email: `${name.toLowerCase()}@ps.test`, displayName: name })
  }
  dir.managers.set(ALICE, OWNER)
  dir.fail.add(LEADER_FLAKY)
}, 180_000)

afterAll(async () => { await stopTestDb(t) }, 30_000)

describe('scheduled placement-check run', () => {
  it('without a top person it does nothing', async () => {
    const res = await scheduled()
    expect(res).toMatchObject({ skipped: 'no-top', cycleStarted: false, pass: null })
    expect(await cycles()).toEqual([])
    expect(dir.lookups).toEqual([])
  })

  it('an admin-page pass (no scheduled flag) never starts a cycle, even with a top set', async () => {
    await t.client`UPDATE org_setup_setting SET top_oid = ${OWNER} WHERE id`
    await entry().run(t.db, { runId: null, opts: { retryFailed: false } })
    expect(await cycles()).toEqual([])
  })

  it('due (no cycle yet): starts a system cycle, reads everyone, then checks each owner and leader', async () => {
    const res = await scheduled()
    expect(res.skipped).toBeNull()
    expect(res.cycleStarted).toBe(true)
    const [cycle, ...rest] = await cycles()
    expect(rest).toEqual([])
    expect(cycle!.started_by).toBeNull()
    const [audit] = await t.client<{ actor_system: string; subject_id: string }[]>`
      SELECT actor_system, subject_id::text FROM audit_event WHERE event_type = 'placement-check-started'`
    expect(audit).toEqual({ actor_system: 'placement-check', subject_id: cycle!.id })

    expect(res.pass).toMatchObject({ cycleId: cycle!.id, checked: 2, remaining: 0 })
    expect(res.principals).toEqual({ checked: 3, notFound: 1, errors: 1, remaining: 1 })
    expect(await principalRows()).toEqual(
      [
        { oid: LEADER_FOUND, cycle_id: cycle!.id, found: true },
        { oid: LEADER_GONE, cycle_id: cycle!.id, found: false },
        { oid: OWNER, cycle_id: cycle!.id, found: true },
      ].sort((a, b) => a.oid.localeCompare(b.oid)),
    )
    expect(dir.lookups).not.toContain(LEADER_BILL)
  })

  it('not due: no new cycle; only the principal whose lookup failed is tried again', async () => {
    dir.lookups.length = 0
    const res = await scheduled()
    expect(res.cycleStarted).toBe(false)
    expect(await cycles()).toHaveLength(1)
    expect(dir.lookups).toEqual([LEADER_FLAKY])
    expect(res.principals).toEqual({ checked: 0, notFound: 0, errors: 1, remaining: 1 })

    dir.fail.delete(LEADER_FLAKY)
    dir.lookups.length = 0
    const healed = await scheduled()
    expect(healed.principals).toEqual({ checked: 1, notFound: 1, errors: 0, remaining: 0 })
    expect((await principalRows()).find((r) => r.oid === LEADER_FLAKY)?.found).toBe(false)

    dir.lookups.length = 0
    await scheduled()
    expect(dir.lookups).toEqual([])
  })

  it('people not yet read hold the principal checks back', async () => {
    const [cycle] = await cycles()
    await t.client`DELETE FROM placement_principal_check`
    dir.lookups.length = 0
    const res = await runScheduledPlacementCheck(t.db, { budgetMs: 0 })
    expect(res.pass).toMatchObject({ cycleId: cycle!.id, remaining: 0 })
    // Budget spent before the first principal: nothing written, all still due.
    expect(res.principals).toEqual({ checked: 0, notFound: 0, errors: 0, remaining: 4 })

    await t.db.insert(schema.teammate).values({ entraOid: '9a1e0000-0000-4000-8000-0000000000d3', email: 'new@ps.test', displayName: 'New', regionId, orgUnitId: unitId })
    const held = await runScheduledPlacementCheck(t.db, { limit: 0 })
    expect(held.pass?.remaining).toBe(1)
    expect(held.principals.checked).toBe(0)
    expect(await principalRows()).toEqual([])
    expect(dir.lookups).toEqual([])
  })

  it('due again once the cycle predates the cadence window: monthly, then weekly', async () => {
    await t.client`UPDATE placement_check_cycle SET started_at = NOW() - interval '40 days'`
    const monthly = await scheduled()
    expect(monthly.cycleStarted).toBe(true)
    const all = await cycles()
    expect(all).toHaveLength(2)
    expect(monthly.pass).toMatchObject({ cycleId: all[1]!.id, remaining: 0 })
    const rows = await principalRows()
    expect(rows).toHaveLength(4)
    expect(rows.every((r) => r.cycle_id === all[1]!.id)).toBe(true)

    await t.client`UPDATE org_setup_setting SET read_cadence = 'week' WHERE id`
    await t.client`UPDATE placement_check_cycle SET started_at = NOW() - interval '8 days' WHERE id = ${all[1]!.id}::uuid`
    expect((await scheduled()).cycleStarted).toBe(true)
    expect(await cycles()).toHaveLength(3)
  })

  it('an admin cycle started inside the window is the one used: the scheduled run starts none', async () => {
    await t.client`UPDATE placement_check_cycle SET started_at = NOW() - interval '40 days'`
    const [owner] = await t.client<{ id: string }[]>`SELECT id::text AS id FROM teammate WHERE entra_oid = ${OWNER}`
    const admin = await startPlacementCycle(t.db, owner!.id)
    const before = (await cycles()).length
    const res = await scheduled()
    expect(res.cycleStarted).toBe(false)
    expect(res.pass?.cycleId).toBe(admin.id)
    expect(await cycles()).toHaveLength(before)
  })

  it('an admin cycle still committing when the run looks is waited for, never superseded', async () => {
    // The race the old read-then-insert lost: the admin's INSERT is in flight
    // (uncommitted) while the scheduled run decides. The run must block on it and
    // then see it, not start a newer cycle of its own.
    await t.client`UPDATE placement_check_cycle SET started_at = NOW() - interval '40 days'`
    const [owner] = await t.client<{ id: string }[]>`SELECT id::text AS id FROM teammate WHERE entra_oid = ${OWNER}`
    let release!: () => void
    const held = new Promise<void>((r) => { release = r })
    let inserted!: (id: string) => void
    const insertedId = new Promise<string>((r) => { inserted = r })
    const adminTx = t.client.begin(async (sql) => {
      const [c] = await sql<{ id: string }[]>`INSERT INTO placement_check_cycle (started_by) VALUES (${owner!.id}::uuid) RETURNING id::text AS id`
      inserted(c!.id)
      await held
    })
    const adminId = await insertedId
    const before = (await cycles()).length // the admin's row is not visible yet

    let settled = false
    const run = scheduled().finally(() => { settled = true })
    await new Promise((r) => setTimeout(r, 300))
    expect(settled).toBe(false) // blocked on the admin's lock, nothing decided

    release()
    await adminTx
    const res = await run
    expect(res.cycleStarted).toBe(false)
    expect(res.pass?.cycleId).toBe(adminId)
    expect(await cycles()).toHaveLength(before + 1)
  })

  it('the cycle and its audit row commit together: a failed audit write leaves no cycle, and the next run starts it', async () => {
    await t.client`UPDATE placement_check_cycle SET started_at = NOW() - interval '40 days'`
    const before = await cycles()
    const auditRows = async () =>
      t.client<{ subject_id: string }[]>`SELECT subject_id::text FROM audit_event WHERE event_type = 'placement-check-started'`
    const auditBefore = (await auditRows()).length

    audit.failStarted = true
    try {
      await expect(scheduled()).rejects.toThrow('audit store down')
    } finally {
      audit.failStarted = false
    }
    // Rolled back as one: no cycle without its record, nothing for the next run to skip.
    expect(await cycles()).toEqual(before)
    expect(await auditRows()).toHaveLength(auditBefore)

    const res = await scheduled()
    expect(res.cycleStarted).toBe(true)
    const all = await cycles()
    expect(all).toHaveLength(before.length + 1)
    expect((await auditRows()).map((r) => r.subject_id)).toContain(all.at(-1)!.id)
  })
})
