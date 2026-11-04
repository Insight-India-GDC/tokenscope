// @vitest-environment node
/*
 * GET /api/v1/me/inbox — `target_project_code`, the drawer's "Open project →"
 * (issue 488). It used to link the budget EDITOR, which a member who is not the
 * project's manager cannot open. It now names the project PAGE, and only for a
 * recipient that page admits (honourable-links rule): a current member, an
 * active owner of the project's Business Unit, or an admin in scope of the
 * project's region (platform-admin, or that region's admin). Exercised through
 * the REAL handler against Postgres.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'
import { injectTestSession } from '../../helpers/auth'
import type { Session } from '../../../server/utils/auth'
import handler from '../../../server/api/v1/me/inbox/index.get'

let t: TestDb
let regionA = ''
let regionB = ''
let unitA = ''
let unitB = ''
let projectId = ''

const MEMBER = '9a1e0000-0000-4000-8000-0000000000a1'
const OUTSIDER = '9a1e0000-0000-4000-8000-0000000000a2'
const OWNER = '9a1e0000-0000-4000-8000-0000000000a3'
const ADMIN_A = '9a1e0000-0000-4000-8000-0000000000a4'
const ADMIN_B = '9a1e0000-0000-4000-8000-0000000000a5'
const PLATFORM = '9a1e0000-0000-4000-8000-0000000000a6'
const EX_MEMBER = '9a1e0000-0000-4000-8000-0000000000a7'

const ev = (session: Session) => {
  const headers: Record<string, string> = { host: 'localhost:3450', origin: 'http://localhost:3450' }
  const e = {
    method: 'GET', path: '/api/v1/me/inbox', context: { params: {} },
    node: {
      req: { method: 'GET', url: '/api/v1/me/inbox', socket: { remoteAddress: '127.0.0.1' }, get headers() { return { ...headers } } },
      res: { _headers: {} as Record<string, unknown>, statusCode: 200, getHeader() {}, setHeader() {}, removeHeader() {}, appendHeader() {}, get headersSent() { return false } },
    },
  }
  injectTestSession(e as unknown as Parameters<typeof injectTestSession>[0], session)
  return e as unknown as Parameters<typeof handler>[0]
}
const sess = (teammateId: string, role: string, regionId: string): Session =>
  ({ teammateId, email: `${teammateId}@x.test`, displayName: 'X', role, regionId, orgPath: 'a', issuedAt: new Date().toISOString() } as unknown as Session)

interface Item { related_entity_kind: string | null; target_project_code: string | null }

async function projectItemFor(session: Session): Promise<Item> {
  const r = (await handler(ev(session))) as unknown as { items: Item[] }
  const item = r.items.find((i) => i.related_entity_kind === 'project')
  expect(item).toBeDefined()
  return item!
}

beforeAll(async () => {
  t = await startTestDb()
  process.env.DATABASE_URL = t.url

  await t.client`INSERT INTO region (code, display_name) VALUES ('ipa', 'Inbox A'), ('ipb', 'Inbox B')`
  const regions = await t.client<{ id: string; code: string }[]>`SELECT id::text AS id, code FROM region WHERE code IN ('ipa','ipb')`
  regionA = regions.find((r) => r.code === 'ipa')!.id
  regionB = regions.find((r) => r.code === 'ipb')!.id
  await t.client`INSERT INTO org_unit (region_id, path, code, display_name, unit_type, is_cost_owning_unit)
    VALUES (${regionA}::uuid, 'ia'::ltree, 'ia', 'Unit A', 'bu', true),
           (${regionB}::uuid, 'ib'::ltree, 'ib', 'Unit B', 'bu', true)`
  const units = await t.client<{ id: string; code: string }[]>`SELECT id::text AS id, code FROM org_unit WHERE code IN ('ia','ib')`
  unitA = units.find((u) => u.code === 'ia')!.id
  unitB = units.find((u) => u.code === 'ib')!.id

  const mk = async (id: string, region: string, unit: string, role: string) => {
    await t.client`INSERT INTO teammate (id, entra_oid, email, region_id, org_unit_id, role)
      VALUES (${id}::uuid, ${`oid-${id}`}, ${`${id}@x.test`}, ${region}::uuid, ${unit}::uuid, ${role})`
  }
  await mk(MEMBER, regionA, unitA, 'developer')
  await mk(OUTSIDER, regionA, unitA, 'manager')
  await mk(OWNER, regionA, unitA, 'developer')
  await mk(ADMIN_A, regionA, unitA, 'admin')
  await mk(ADMIN_B, regionB, unitB, 'admin')
  await mk(PLATFORM, regionB, unitB, 'platform-admin')
  await mk(EX_MEMBER, regionA, unitA, 'developer')

  const [p] = await t.client<{ id: string }[]>`
    INSERT INTO project (code, code_hash, display_name, type, region_id, cost_owning_unit_id)
    VALUES ('INB-OPEN', 'h-inb-open', 'Inbox Open', 'billable', ${regionA}::uuid, ${unitA}::uuid)
    RETURNING id::text AS id`
  projectId = p!.id
  // A plain member (not the manager): the case the editor link failed.
  await t.client`INSERT INTO project_assignment (project_id, teammate_id, effective, role)
    VALUES (${projectId}::uuid, ${MEMBER}::uuid, tstzrange(now() - interval '1 day', NULL), 'member')`
  // A membership that has ENDED admits nobody.
  await t.client`INSERT INTO project_assignment (project_id, teammate_id, effective, role)
    VALUES (${projectId}::uuid, ${EX_MEMBER}::uuid, tstzrange(now() - interval '30 days', now() - interval '1 day'), 'member')`
  await t.client`INSERT INTO cou_owner (org_unit_id, teammate_id) VALUES (${unitA}::uuid, ${OWNER}::uuid)`

  for (const id of [MEMBER, OUTSIDER, OWNER, ADMIN_A, ADMIN_B, PLATFORM, EX_MEMBER]) {
    await t.client`INSERT INTO inbox_item (recipient_teammate_id, category, severity, subject, body, related_entity_kind, related_entity_id)
      VALUES (${id}::uuid, 'over-budget', 'attention', 'INB-OPEN over budget', '{}'::jsonb, 'project', ${projectId}::uuid)`
  }
}, 180_000)

afterAll(async () => {
  await stopTestDb(t)
})

describe('inbox "Open project" names the project page, for recipients it admits (issue 488)', () => {
  it('a member who is not the manager gets the project code', async () => {
    expect((await projectItemFor(sess(MEMBER, 'developer', regionA))).target_project_code).toBe('INB-OPEN')
  })

  it('an active owner of the project\'s Business Unit gets it', async () => {
    expect((await projectItemFor(sess(OWNER, 'developer', regionA))).target_project_code).toBe('INB-OPEN')
  })

  it('the project region\'s admin and a platform-admin get it', async () => {
    expect((await projectItemFor(sess(ADMIN_A, 'admin', regionA))).target_project_code).toBe('INB-OPEN')
    expect((await projectItemFor(sess(PLATFORM, 'platform-admin', regionB))).target_project_code).toBe('INB-OPEN')
  })

  it('withheld from anyone the page would refuse: a non-member manager, another region\'s admin, an ended member', async () => {
    expect((await projectItemFor(sess(OUTSIDER, 'manager', regionA))).target_project_code).toBeNull()
    expect((await projectItemFor(sess(ADMIN_B, 'admin', regionB))).target_project_code).toBeNull()
    expect((await projectItemFor(sess(EX_MEMBER, 'developer', regionA))).target_project_code).toBeNull()
  })
})
