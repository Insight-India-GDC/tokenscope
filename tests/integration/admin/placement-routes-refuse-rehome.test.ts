// @vitest-environment node
/*
 * The two admin placement doors, after the history re-home left the product.
 *
 * Reports group usage by where people sit now (docs/design/current-org-lens/
 * 00-design.md), so rewriting a person's recorded placement corrects nothing.
 * The doors still place people. A request that still sends `rehome` is refused
 * with a 400 rather than silently ignored, so a stale client fails loudly; and
 * a placement never edits the recorded placement on usage rows.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { existsSync, readdirSync } from 'node:fs'
import { REHOME_REMOVED_DETAIL } from '../../../server/db/place-teammate'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'
import { injectTestSession } from '../../helpers/auth'
import type { Session } from '../../../server/utils/auth'
import orgUnitHandler from '../../../server/api/v1/admin/users/[id]/org-unit.patch'
import bulkPlaceHandler from '../../../server/api/v1/admin/users/bulk-place.post'

let t: TestDb
let regionA = ''
let regionB = ''
let buFrom = ''
let buTo = ''
let buOtherRegion = ''
let subjectId = ''
let projectId = ''
let instanceId = ''
/*
 * REAL v4 UUIDs, version nibble and all. The routes validate the path id with
 * `z.string().uuid()`, and zod enforces the version and variant bits — a
 * convenient `00000000-…-0001` fixture id is refused as malformed, so every
 * test 400s on the id before reaching the behaviour it was written for. The two
 * that "passed" were the ones expecting a 400 anyway.
 */
const ADMIN_ID = '9a1e0000-0000-4000-8000-0000000000a1'
const SUBJECT_ID = '9a1e0000-0000-4000-8000-0000000000a2'

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
  return e as unknown as Parameters<typeof orgUnitHandler>[0]
}

const admin = (rid = regionA): Session =>
  ({ teammateId: ADMIN_ID, email: 'pc-admin@x.test', displayName: 'Admin', role: 'admin', regionId: rid, orgPath: 'from' }) as Session
const dev = (): Session =>
  ({ teammateId: ADMIN_ID, email: 'pc-dev@x.test', displayName: 'Dev', role: 'developer', regionId: regionA, orgPath: 'from' }) as Session

const iso = (d: Date) => d.toISOString()
const RECENT = iso(new Date(Date.now() - 3 * 86_400_000))

beforeAll(async () => {
  t = await startTestDb()
  // The handlers open their own connection via withRequestRls.
  process.env.DATABASE_URL = t.url
  ;[{ id: regionA }] = await t.client<{ id: string }[]>`
    INSERT INTO region (code, display_name) VALUES ('pa', 'PA') RETURNING id::text AS id`
  ;[{ id: regionB }] = await t.client<{ id: string }[]>`
    INSERT INTO region (code, display_name) VALUES ('pb', 'PB') RETURNING id::text AS id`
  const unit = async (rid: string, path: string, code: string) => {
    const [r] = await t.client<{ id: string }[]>`
      INSERT INTO org_unit (region_id, path, code, display_name, unit_type, is_cost_owning_unit)
      VALUES (${rid}::uuid, ${path}::ltree, ${code}, ${code}, 'bu', true) RETURNING id::text AS id`
    return r!.id
  }
  buFrom = await unit(regionA, 'pfrom', 'pfrom')
  buTo = await unit(regionA, 'pto', 'pto')
  buOtherRegion = await unit(regionB, 'pother', 'pother')
  await t.client`INSERT INTO teammate (id, entra_oid, email, display_name, region_id, org_unit_id, is_active)
    VALUES (${ADMIN_ID}::uuid, 'oid-pc-admin', 'pc-admin@x.test', 'Admin', ${regionA}::uuid, ${buFrom}::uuid, true)`
  ;[{ id: subjectId }] = await t.client<{ id: string }[]>`
    INSERT INTO teammate (id, entra_oid, email, display_name, region_id, org_unit_id, is_active)
    VALUES (${SUBJECT_ID}::uuid, 'oid-pc-subj', 'pc-subj@x.test', 'Subject', ${regionA}::uuid, ${buFrom}::uuid, true)
    RETURNING id::text AS id`
  ;[{ id: projectId }] = await t.client<{ id: string }[]>`
    INSERT INTO project (code, code_hash, display_name, type, region_id, cost_owning_unit_id)
    VALUES ('PC1', 'hpc1', 'PC1', 'internal', ${regionA}::uuid, ${buFrom}::uuid) RETURNING id::text AS id`
  ;[{ id: instanceId }] = await t.client<{ id: string }[]>`
    INSERT INTO instance_attestation (instance_id, principal_oid, teammate_id, tool, region_id, org_unit_id, project_code_hash, raw_project_code)
    VALUES (gen_random_uuid(), 'p', ${SUBJECT_ID}::uuid, 'claude-code', ${regionA}::uuid, ${buFrom}::uuid, 'h', 'P')
    RETURNING instance_id::text AS id`
}, 60_000)

afterAll(async () => {
  await stopTestDb(t)
})

async function seed(unitId: string, ts: string, usd: string, session: string) {
  await t.client`INSERT INTO attribution_record
      (instance_id, teammate_id, region_id, org_unit_id, cost_owning_unit_id, project_id, tool, model,
       token_type, tokens, cost_usd, fidelity_tier, cost_basis, ts_event, claude_session_id)
    VALUES (${instanceId}::uuid, ${SUBJECT_ID}::uuid, ${regionA}::uuid, ${unitId}::uuid, ${unitId}::uuid,
            ${projectId}::uuid, 'claude-code', 'claude-sonnet-4-6', 'input', 100, ${usd},
            'tier-1', 'estimated', ${ts}::timestamptz, ${session})`
}

beforeEach(async () => {
  await t.client`DELETE FROM attribution_record`
  // `audit_event` is append-only (a trigger denies UPDATE/DELETE), which is the
  // point of it — so the assertion below reads the LATEST row rather than
  // assuming an empty table.
  await t.client`UPDATE teammate SET org_unit_id = ${buFrom}::uuid WHERE id = ${SUBJECT_ID}::uuid`
})

/** The latest audit row for the subject — `audit_event` is append-only. */
async function latestAudit() {
  const [row] = await t.client<{ payload: Record<string, unknown> }[]>`
    SELECT payload FROM audit_event WHERE subject_id = ${SUBJECT_ID}::uuid ORDER BY ts_recorded DESC LIMIT 1`
  return row?.payload
}

async function placementOf() {
  const [row] = await t.client<{ ou: string }[]>`
    SELECT org_unit_id::text AS ou FROM teammate WHERE id = ${SUBJECT_ID}::uuid`
  return row!.ou
}

async function stampedUnit() {
  const [row] = await t.client<{ ou: string }[]>`
    SELECT org_unit_id::text AS ou FROM attribution_record WHERE teammate_id = ${SUBJECT_ID}::uuid`
  return row!.ou
}

describe('org-unit PATCH', () => {
  const patch = (body: unknown, session = admin()) =>
    orgUnitHandler(ev({ session, id: subjectId, body, method: 'PATCH' }) as Parameters<typeof orgUnitHandler>[0])

  it('refuses a request that still sends rehome, with the plain sentence, and moves nobody', async () => {
    await seed(buFrom, RECENT, '10.000000', 'pc-a')

    await expect(patch({ org_unit_id: buTo, rehome: { from: 'all' } })).rejects.toMatchObject({
      statusCode: 400,
      data: { detail: REHOME_REMOVED_DETAIL },
    })
    expect(await placementOf()).toBe(buFrom)
    expect(await stampedUnit()).toBe(buFrom)
  })

  it('refuses any rehome value, not only a well-formed one', async () => {
    await expect(patch({ org_unit_id: buTo, rehome: null })).rejects.toMatchObject({ statusCode: 400 })
    expect(await placementOf()).toBe(buFrom)
  })

  it('still places without it, and leaves the recorded placement on usage alone', async () => {
    await seed(buFrom, RECENT, '10.000000', 'pc-a')

    const res = (await patch({ org_unit_id: buTo })) as Record<string, unknown>
    expect(res).toEqual({ id: subjectId, org_unit_id: buTo, outcome: 'placed' })
    expect(await placementOf()).toBe(buTo)
    expect(await stampedUnit()).toBe(buFrom)

    const audit = await latestAudit()
    expect(audit).toMatchObject({ previousOrgUnitId: buFrom, newOrgUnitId: buTo })
    expect(audit).not.toHaveProperty('rehome')
  })

  it('already there: writes nothing', async () => {
    const res = (await patch({ org_unit_id: buFrom })) as { outcome: string }
    expect(res.outcome).toBe('noop')
  })

  it('refuses a target in another region', async () => {
    await expect(patch({ org_unit_id: buOtherRegion })).rejects.toMatchObject({ statusCode: 422 })
  })

  it('a developer cannot place anyone', async () => {
    await expect(patch({ org_unit_id: buTo }, dev())).rejects.toMatchObject({ statusCode: 403 })
  })
})

describe('bulk-place', () => {
  const bulk = (body: unknown) =>
    bulkPlaceHandler(ev({ session: admin(), body }) as Parameters<typeof bulkPlaceHandler>[0])

  it('refuses a request that still sends rehome, before placing anyone', async () => {
    await expect(
      bulk({ teammate_ids: [subjectId], org_unit_id: buTo, rehome: { from: 'all' } }),
    ).rejects.toMatchObject({ statusCode: 400, data: { detail: REHOME_REMOVED_DETAIL } })
    expect(await placementOf()).toBe(buFrom)
  })

  it('still places without it; the response has no history outcome', async () => {
    await seed(buFrom, RECENT, '10.000000', 'pc-a')

    const res = (await bulk({ teammate_ids: [subjectId], org_unit_id: buTo })) as Record<string, unknown>
    expect(res).toMatchObject({ placed: 1, noop: 0, failed: 0 })
    expect(res).not.toHaveProperty('historyRepaired')
    expect(await placementOf()).toBe(buTo)
    expect(await stampedUnit()).toBe(buFrom)
  })

  it('a large batch is no longer capped below the placement maximum', async () => {
    // 51 unknown ids: every one is refused per id, so the request was ACCEPTED.
    const ids = Array.from({ length: 51 }, (_, i) => `9a1e0000-0000-4000-8000-${String(i).padStart(12, '0')}`)
    const res = (await bulk({ teammate_ids: ids, org_unit_id: buTo })) as { failed: number }
    expect(res.failed).toBe(51)
  })
})

describe('placement-span', () => {
  it('the route is gone', () => {
    const dir = 'server/api/v1/admin/users/[id]'
    expect(existsSync(dir)).toBe(true) // the path below is not vacuously absent
    expect(readdirSync(dir).filter((f) => f.startsWith('placement-span'))).toEqual([])
  })
})
