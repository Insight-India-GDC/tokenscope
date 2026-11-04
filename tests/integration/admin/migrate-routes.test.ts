// @vitest-environment node
/*
 * The MIGRATE endpoints, exercised through the HANDLERS.
 *
 * `tests/integration/governance/rehome-spend.test.ts` calls the governance
 * module directly, which is the right place to prove the SQL. It cannot see any
 * of the things a route is responsible for — RBAC, CSRF, region scope, target
 * validation, body errors, the 409 translation, the audit row, or the response
 * contract — and a reviewer pointed out that none of them had a test at all.
 *
 * So this file asserts the boundary, not the arithmetic.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'
import { injectTestSession } from '../../helpers/auth'
import type { Session } from '../../../server/utils/auth'
import patchHandler from '../../../server/api/v1/admin/projects/[id].patch'
import previewHandler from '../../../server/api/v1/admin/projects/[id]/migrate-preview.post'

let t: TestDb
let regionA = ''
let regionB = ''
let buFrom = ''
let buTo = ''
let plainNode = ''
let buOtherRegion = ''
let projectId = ''
let teammateId = ''
const ADMIN_ID = '00000000-0000-0000-0000-000000000001'

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
  return e as unknown as Parameters<typeof patchHandler>[0]
}

const admin = (rid = regionA): Session =>
  ({ teammateId: ADMIN_ID, email: 'mig-admin@x.test', displayName: 'Admin', role: 'admin', regionId: rid, orgPath: 'from' }) as Session
const dev = (): Session =>
  ({ teammateId: ADMIN_ID, email: 'mig-dev@x.test', displayName: 'Dev', role: 'developer', regionId: regionA, orgPath: 'from' }) as Session

const DAY = new Date(Date.now() - 3 * 86_400_000).toISOString()

beforeAll(async () => {
  t = await startTestDb()
  // The handlers open their own connection via withRequestRls.
  process.env.DATABASE_URL = t.url
  ;[{ id: regionA }] = await t.client<{ id: string }[]>`
    INSERT INTO region (code, display_name) VALUES ('ra', 'RA') RETURNING id::text AS id`
  ;[{ id: regionB }] = await t.client<{ id: string }[]>`
    INSERT INTO region (code, display_name) VALUES ('rb', 'RB') RETURNING id::text AS id`
  const unit = async (rid: string, path: string, code: string, costOwning: boolean) => {
    const [r] = await t.client<{ id: string }[]>`
      INSERT INTO org_unit (region_id, path, code, display_name, unit_type, is_cost_owning_unit)
      VALUES (${rid}::uuid, ${path}::ltree, ${code}, ${code}, 'bu', ${costOwning})
      RETURNING id::text AS id`
    return r!.id
  }
  buFrom = await unit(regionA, 'from', 'from', true)
  buTo = await unit(regionA, 'to', 'to', true)
  plainNode = await unit(regionA, 'plain', 'plain', false) // NOT cost-owning
  buOtherRegion = await unit(regionB, 'other', 'other', true)
  ;[{ id: teammateId }] = await t.client<{ id: string }[]>`
    INSERT INTO teammate (id, entra_oid, email, display_name, region_id, org_unit_id, is_active)
    VALUES (${ADMIN_ID}::uuid, 'oid-mig', 'mig-admin@x.test', 'Admin', ${regionA}::uuid, ${buFrom}::uuid, true)
    RETURNING id::text AS id`
  ;[{ id: projectId }] = await t.client<{ id: string }[]>`
    INSERT INTO project (code, code_hash, display_name, type, region_id, cost_owning_unit_id)
    VALUES ('MG1', 'hmg1', 'MG1', 'internal', ${regionA}::uuid, ${buFrom}::uuid)
    RETURNING id::text AS id`
  const [inst] = await t.client<{ id: string }[]>`
    INSERT INTO instance_attestation (instance_id, principal_oid, teammate_id, tool, region_id, org_unit_id, project_code_hash, raw_project_code)
    VALUES (gen_random_uuid(), 'p', ${teammateId}::uuid, 'claude-code', ${regionA}::uuid, ${buFrom}::uuid, 'h', 'P')
    RETURNING instance_id::text AS id`
  await t.client`INSERT INTO attribution_record
      (instance_id, teammate_id, region_id, org_unit_id, cost_owning_unit_id, project_id, tool, model,
       token_type, tokens, cost_usd, fidelity_tier, cost_basis, ts_event, claude_session_id)
    VALUES (${inst!.id}::uuid, ${teammateId}::uuid, ${regionA}::uuid, ${buFrom}::uuid, ${buFrom}::uuid,
            ${projectId}::uuid, 'claude-code', 'claude-sonnet-4-6', 'input', 100, 12.50,
            'tier-1', 'estimated', ${DAY}::timestamptz, 'sess-mg1')`
}, 60_000)

afterAll(async () => {
  await stopTestDb(t)
})

beforeEach(async () => {
  await t.client`UPDATE attribution_record SET cost_owning_unit_id = ${buFrom}::uuid`
  await t.client`UPDATE project SET cost_owning_unit_id = ${buFrom}::uuid WHERE id = ${projectId}::uuid`
})

const previewBody = (to: string, from: unknown = { from: 'all', confirm_unbounded: true }) => ({
  to_cost_owning_unit_id: to,
  range: from,
})

describe('migrate-preview — the boundary', () => {
  it('a developer cannot preview a migration', async () => {
    await expect(
      previewHandler(ev({ session: dev(), id: projectId, body: previewBody(buTo) })),
    ).rejects.toMatchObject({ statusCode: 403 })
  })

  it('previews without writing', async () => {
    const res = (await previewHandler(
      ev({ session: admin(), id: projectId, body: previewBody(buTo) }),
    )) as { totalRows: number; totalUsd: number; token: string }
    expect(res.totalRows).toBe(1)
    expect(Number(res.totalUsd)).toBeCloseTo(12.5, 2)
    expect(res.token).toBeTruthy()
    const [row] = await t.client<{ cou: string }[]>`
      SELECT cost_owning_unit_id::text AS cou FROM attribution_record LIMIT 1`
    expect(row!.cou).toBe(buFrom) // nothing moved
  })

  it('refuses a target that is not a COST-OWNING unit', async () => {
    /*
     * The field being stamped is `cost_owning_unit_id`. Without this an admin
     * could park historic attribution on an ordinary org node, which no report
     * clamps on and no owner can ever see.
     */
    await expect(
      previewHandler(ev({ session: admin(), id: projectId, body: previewBody(plainNode) })),
    ).rejects.toMatchObject({ statusCode: 422 })
  })

  it('refuses a target in another region', async () => {
    await expect(
      previewHandler(ev({ session: admin(), id: projectId, body: previewBody(buOtherRegion) })),
    ).rejects.toMatchObject({ statusCode: 422 })
  })

  it('rejects a date that is not a real calendar day (400, never a 500)', async () => {
    // The shape regex alone admits 2026-02-31, which used to reach Postgres's
    // ::date cast and abort the query.
    await expect(
      previewHandler(ev({ session: admin(), id: projectId, body: previewBody(buTo, { from: '2026-02-31' }) })),
    ).rejects.toMatchObject({ statusCode: 400 })
  })

  it("rejects an unbounded range that has not been confirmed", async () => {
    await expect(
      previewHandler(ev({ session: admin(), id: projectId, body: previewBody(buTo, { from: 'all' }) })),
    ).rejects.toMatchObject({ statusCode: 400 })
  })
})

describe('PATCH /admin/projects/{id} — the migrate path', () => {
  it('migrates, and the audit row can reconstruct it', async () => {
    const plan = (await previewHandler(
      ev({ session: admin(), id: projectId, body: previewBody(buTo) }),
    )) as { token: string }

    const res = (await patchHandler(
      ev({
        session: admin(),
        id: projectId,
        method: 'PATCH',
        body: {
          cost_owning_unit_id: buTo,
          migrate_spend: { from: 'all', confirm_unbounded: true },
          migrate_expect_token: plan.token,
        },
      }),
    )) as { migrated?: { rows_updated: number; usd_moved: number } }

    expect(res.migrated?.rows_updated).toBe(1)
    const [row] = await t.client<{ cou: string }[]>`
      SELECT cost_owning_unit_id::text AS cou FROM attribution_record LIMIT 1`
    expect(row!.cou).toBe(buTo)

    const [audit] = await t.client<{ payload: Record<string, unknown> }[]>`
      SELECT payload FROM audit_event
       WHERE event_type = 'project-updated' AND payload ? 'migrate_spend'
       ORDER BY ts_recorded DESC LIMIT 1`
    const m = audit!.payload.migrate_spend as {
      from_cost_owning_units: { costOwningUnitId: string; usd: number }[]
      to_cost_owning_unit_id: string
      usd_moved: number
    }
    expect(m.to_cost_owning_unit_id).toBe(buTo)
    expect(m.from_cost_owning_units[0]!.costOwningUnitId).toBe(buFrom)
    expect(Number(m.usd_moved)).toBeCloseTo(12.5, 2)
  })

  it('a STALE token is a 409 carrying the current plan, and writes nothing', async () => {
    const plan = (await previewHandler(
      ev({ session: admin(), id: projectId, body: previewBody(buTo) }),
    )) as { token: string }
    // The world moves between preview and apply.
    await t.client`INSERT INTO attribution_record
        (instance_id, teammate_id, region_id, org_unit_id, cost_owning_unit_id, project_id, tool, model,
         token_type, tokens, cost_usd, fidelity_tier, cost_basis, ts_event, claude_session_id)
      SELECT instance_id, teammate_id, region_id, org_unit_id, cost_owning_unit_id, project_id, tool, model,
             token_type, tokens, 99.00, fidelity_tier, cost_basis, ts_event, 'sess-late'
        FROM attribution_record LIMIT 1`

    await expect(
      patchHandler(
        ev({
          session: admin(),
          id: projectId,
          method: 'PATCH',
          body: {
            cost_owning_unit_id: buTo,
            migrate_spend: { from: 'all', confirm_unbounded: true },
            migrate_expect_token: plan.token,
          },
        }),
      ),
    ).rejects.toMatchObject({ statusCode: 409 })

    const [{ n }] = await t.client<{ n: string }[]>`
      SELECT count(*)::text AS n FROM attribution_record WHERE cost_owning_unit_id = ${buTo}::uuid`
    expect(n).toBe('0') // the whole transaction rolled back
    await t.client`DELETE FROM attribution_record WHERE claude_session_id = 'sess-late'`
  })

  it('migrate_spend without its token is a 400 — the preview is the safety mechanism', async () => {
    await expect(
      patchHandler(
        ev({
          session: admin(),
          id: projectId,
          method: 'PATCH',
          body: { cost_owning_unit_id: buTo, migrate_spend: { from: 'all', confirm_unbounded: true } },
        }),
      ),
    ).rejects.toMatchObject({ statusCode: 400 })
  })

  it('a token with no project field is a 400, not an empty UPDATE', async () => {
    // `{ migrate_expect_token }` alone once satisfied "at least one field" and
    // produced `UPDATE project SET  WHERE …` — a 500 from a valid-looking body.
    await expect(
      patchHandler(ev({ session: admin(), id: projectId, method: 'PATCH', body: { migrate_expect_token: 'x' } })),
    ).rejects.toMatchObject({ statusCode: 400 })
  })
})
