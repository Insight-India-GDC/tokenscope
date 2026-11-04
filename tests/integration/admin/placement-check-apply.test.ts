// @vitest-environment node
/*
 * POST /api/v1/admin/placement-check/apply (spec P7): one guarded write per
 * person, real Postgres. Each refusal is reached with every other guard passing.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { randomUUID } from 'node:crypto'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'
import { injectTestSession } from '../../helpers/auth'
import type { Session } from '../../../server/utils/auth'
import applyHandler from '../../../server/api/v1/admin/placement-check/apply.post'
import orgUnitHandler from '../../../server/api/v1/admin/users/[id]/org-unit.patch'
import provisionHandler from '../../../server/api/v1/admin/teammates.post'
import { provenanceOf } from '../../../server/reconciliation/placement-provenance'
import { loadPlacementCheck } from '../../../server/reconciliation/placement-check-read'
import { bulkSelectablePlacementIds } from '../../../app/utils/placement-check-view'
import type { PlacementApplyItem, PlacementApplyResponse, PlacementSeen, WalkEnd } from '../../../shared/placement/placement-check'

let t: TestDb
let regionA = ''
let regionB = ''
let a1 = ''
let a2 = ''
let a4 = ''
let aRetired = ''
let aTeam = ''
let b1 = ''
let cycleId = ''
const ADMIN_ID = '9a1e0000-0000-4000-8000-0000000005a1'
const PLATFORM_ID = '9a1e0000-0000-4000-8000-0000000005a2'
const OWNER_ID = '9a1e0000-0000-4000-8000-0000000005a3'
const OWNER_OID = 'oid-pca-owner'
const LEADER_B_OID = 'oid-pcb-leader'

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
const platform = (): Session =>
  ({ teammateId: PLATFORM_ID, email: 'pca-pa@x.test', displayName: 'PA', role: 'platform-admin', regionId: regionA, orgPath: 'pca1' }) as Session
const regionAdmin = (): Session =>
  ({ teammateId: ADMIN_ID, email: 'pca-admin@x.test', displayName: 'Admin', role: 'admin', regionId: regionA, orgPath: 'pca1' }) as Session

const apply = (items: PlacementApplyItem[], session = platform()) =>
  applyHandler(ev({ session, body: { items } })) as Promise<PlacementApplyResponse>

async function unit(rid: string, path: string, opts: { costOwning?: boolean; retired?: boolean; type?: string } = {}) {
  const [r] = await t.client<{ id: string }[]>`
    INSERT INTO org_unit (region_id, path, code, display_name, unit_type, is_cost_owning_unit, retired_at)
    VALUES (${rid}::uuid, ${path}::ltree, ${path}, ${path}, ${opts.type ?? 'bu'}, ${opts.costOwning ?? true},
            ${opts.retired ? new Date().toISOString() : null}::timestamptz)
    RETURNING id::text AS id`
  return r!.id
}

/** A teammate on `orgUnitId` with stored evidence. */
async function subject(opts: {
  orgUnitId: string
  regionId?: string
  department?: string | null
  managers?: string[]
  walkEnd?: WalkEnd
  metadata?: Record<string, string>
  evidence?: boolean
}) {
  const id = randomUUID()
  const oid = `oid-${id}`
  await t.client`INSERT INTO teammate (id, entra_oid, email, display_name, region_id, org_unit_id, is_active, metadata)
    VALUES (${id}::uuid, ${oid}, ${`${id}@x.test`}, 'Subject', ${opts.regionId ?? regionA}::uuid, ${opts.orgUnitId}::uuid, true,
            ${JSON.stringify(opts.metadata ?? {})}::jsonb)`
  if (opts.evidence !== false) {
    const chain = [{ oid, name: 'Subject', email: null }, ...(opts.managers ?? []).map((m) => ({ oid: m, name: m, email: null }))]
    await t.client`INSERT INTO placement_evidence (teammate_id, gathered_at, cycle_id, lookup, attributes, chain, walk_end)
      VALUES (${id}::uuid, now(), ${cycleId}::uuid, 'oid', ${JSON.stringify({ department: opts.department ?? null })}::jsonb,
              ${JSON.stringify(chain)}::jsonb, ${opts.walkEnd ?? 'top-of-chart'})`
  }
  return id
}

async function state(id: string) {
  const [r] = await t.client<{ region_id: string; org_unit_id: string; revoked: boolean; metadata: string }[]>`
    SELECT region_id::text AS region_id, org_unit_id::text AS org_unit_id, (revoked_at IS NOT NULL) AS revoked,
           metadata::text AS metadata
    FROM teammate WHERE id = ${id}::uuid`
  return { ...r!, provenance: provenanceOf(JSON.parse(r!.metadata)) }
}

async function seenOf(id: string): Promise<PlacementSeen> {
  const s = await state(id)
  return { regionId: s.region_id, orgUnitId: s.org_unit_id, provenance: s.provenance }
}

async function audits(id: string) {
  return t.client<{ event_type: string; batch_id: string | null; actor: string | null }[]>`
    SELECT event_type, payload->>'batchId' AS batch_id, actor_teammate_id::text AS actor
    FROM audit_event WHERE subject_kind = 'teammate' AND subject_id = ${id}::uuid ORDER BY ts_recorded`
}

async function auditPayloads(id: string) {
  const rows = await t.client<{ payload: Record<string, unknown> }[]>`
    SELECT payload FROM audit_event WHERE subject_kind = 'teammate' AND subject_id = ${id}::uuid ORDER BY ts_recorded`
  return rows.map((r) => r.payload)
}

const outcomeOf = (res: PlacementApplyResponse, id: string) => res.results.find((r) => r.teammateId === id)

beforeAll(async () => {
  t = await startTestDb()
  process.env.DATABASE_URL = t.url
  process.env.NUXT_SESSION_SECRET = 'placement-check-apply-test-padded-to-32-chars'
  ;[{ id: regionA }] = await t.client<{ id: string }[]>`INSERT INTO region (code, display_name) VALUES ('pca', 'PCA') RETURNING id::text AS id`
  ;[{ id: regionB }] = await t.client<{ id: string }[]>`INSERT INTO region (code, display_name) VALUES ('pcb', 'PCB') RETURNING id::text AS id`
  a1 = await unit(regionA, 'pca1')
  a2 = await unit(regionA, 'pca2')
  a4 = await unit(regionA, 'pca4')
  aRetired = await unit(regionA, 'pcaretired', { retired: true })
  aTeam = await unit(regionA, 'pcateam', { costOwning: false, type: 'team' })
  b1 = await unit(regionB, 'pcb1')
  await t.client`INSERT INTO teammate (id, entra_oid, email, display_name, role, region_id, org_unit_id, is_active)
    VALUES (${ADMIN_ID}::uuid, 'oid-pca-admin', 'pca-admin@x.test', 'Admin', 'admin', ${regionA}::uuid, ${a1}::uuid, true),
           (${PLATFORM_ID}::uuid, 'oid-pca-pa', 'pca-pa@x.test', 'PA', 'platform-admin', ${regionA}::uuid, ${a1}::uuid, true),
           (${OWNER_ID}::uuid, ${OWNER_OID}, 'pca-owner@x.test', 'Owner', 'developer', ${regionA}::uuid, ${a2}::uuid, true)`
  await t.client`INSERT INTO cou_owner (org_unit_id, teammate_id) VALUES (${a2}::uuid, ${OWNER_ID}::uuid)`
  await t.client`INSERT INTO directory_region_rule (attribute, match_mode, match_value, match_value_raw, region_id, org_unit_id)
    VALUES ('department', 'exact', 'dept-b1', 'dept-b1', ${regionB}::uuid, ${b1}::uuid),
           ('department', 'exact', 'dept-a4', 'dept-a4', ${regionA}::uuid, ${a4}::uuid)`
  await t.client`INSERT INTO region_leader (region_id, leader_oid, leader_email, kind)
    VALUES (${regionB}::uuid, ${LEADER_B_OID}, 'pcb-leader@x.test', 'region-svp')`
  ;[{ id: cycleId }] =await t.client<{ id: string }[]>`INSERT INTO placement_check_cycle DEFAULT VALUES RETURNING id::text AS id`
}, 120_000)
afterAll(async () => {
  if (t) await stopTestDb(t)
}, 30_000)
beforeEach(() => {
  process.env.DATABASE_URL = t.url
})

describe('placement-check apply: moves', () => {
  it('cross region: region and unit move, sessions and interactive tokens revoked, devices follow, audited with the batch id', async () => {
    const id = await subject({ orgUnitId: a1, department: 'dept-b1' })
    const live = randomUUID()
    await t.client`INSERT INTO instance_attestation
        (instance_id, principal_oid, teammate_id, tool, region_id, org_unit_id, project_code_hash, raw_project_code)
      VALUES (${live}::uuid, ${`oid-${id}`}, ${id}::uuid, 'claude-code', ${regionA}::uuid, ${a1}::uuid, 'h', 'P')`
    const [client] = await t.client<{ client_id: string }[]>`
      INSERT INTO oauth_client (client_secret_hash, client_name, redirect_uris)
      VALUES ('h', 'PCA', ARRAY['http://127.0.0.1/cb']) RETURNING client_id::text AS client_id`
    await t.client`INSERT INTO oauth_token
        (access_token_hash, refresh_token_hash, client_id, teammate_id, scope, access_expires_at, refresh_expires_at)
      VALUES ('pca-a', 'pca-r', ${client!.client_id}::uuid, ${id}::uuid, 'mcp', now() + interval '1 hour', now() + interval '1 day')`

    const res = await apply([{ teammateId: id, seen: await seenOf(id), target: { regionId: regionB, orgUnitId: b1 } }])

    expect(outcomeOf(res, id)).toEqual({ teammateId: id, outcome: 'moved' })
    const s = await state(id)
    expect([s.region_id, s.org_unit_id, s.revoked]).toEqual([regionB, b1, true])
    expect(s.provenance).toMatchObject({ placedVia: 'placement-check', placedStep: 'unit-rule', placedAttribute: 'department' })
    const [dev] = await t.client<{ region_id: string; org_unit_id: string }[]>`
      SELECT region_id::text AS region_id, org_unit_id::text AS org_unit_id FROM instance_attestation WHERE instance_id = ${live}::uuid`
    expect(dev).toEqual({ region_id: regionB, org_unit_id: b1 })
    const [tok] = await t.client<{ revoked: boolean }[]>`SELECT (revoked_at IS NOT NULL) AS revoked FROM oauth_token WHERE access_token_hash = 'pca-a'`
    expect(tok!.revoked).toBe(true)
    expect(await audits(id)).toEqual([{ event_type: 'teammate-region-reassigned', batch_id: res.batchId, actor: PLATFORM_ID }])
    expect((await auditPayloads(id))[0]).toMatchObject({
      source: 'placement-check',
      step: 'unit-rule',
      provenance: { placedVia: 'placement-check', placedStep: 'unit-rule', placedAttribute: 'department' },
    })
  })

  it('same region: unit moves through placeTeammate, no revocation, provenance names the owner', async () => {
    const id = await subject({ orgUnitId: a1, managers: ['oid-mid', OWNER_OID] })
    const res = await apply([{ teammateId: id, seen: await seenOf(id), target: { regionId: regionA, orgUnitId: a2 } }])

    expect(outcomeOf(res, id)?.outcome).toBe('moved')
    const s = await state(id)
    expect([s.region_id, s.org_unit_id, s.revoked]).toEqual([regionA, a2, false])
    expect(s.provenance).toMatchObject({ placedVia: 'placement-check', placedStep: 'chain-unit', placedOwnerOid: OWNER_OID })
    expect(s.provenance?.placedAttribute).toBeUndefined()
    expect(await audits(id)).toEqual([{ event_type: 'teammate-org-unit-changed', batch_id: res.batchId, actor: PLATFORM_ID }])
    expect((await auditPayloads(id))[0]).toMatchObject({
      source: 'placement-check',
      step: 'chain-unit',
      provenance: { placedVia: 'placement-check', placedStep: 'chain-unit', placedOwnerOid: OWNER_OID },
    })
  })

  it('region only: a chain reaching another region\'s leader lands on that region\'s Unplaced node, with the cascade', async () => {
    const id = await subject({ orgUnitId: a1, managers: ['oid-mid', LEADER_B_OID] })
    const res = await apply([{ teammateId: id, seen: await seenOf(id), target: { regionId: regionB, orgUnitId: null } }])

    expect(outcomeOf(res, id)?.outcome).toBe('moved')
    const s = await state(id)
    const [holding] = await t.client<{ id: string }[]>`
      SELECT id::text AS id FROM org_unit WHERE region_id = ${regionB}::uuid AND code = '__UNPLACED__'`
    expect([s.region_id, s.org_unit_id, s.revoked]).toEqual([regionB, holding!.id, true])
    expect(s.provenance).toMatchObject({ placedVia: 'placement-check', placedStep: 'chain-region' })
    expect(await audits(id)).toEqual([{ event_type: 'teammate-region-reassigned', batch_id: res.batchId, actor: PLATFORM_ID }])
  })

  it('an applied home is not manual: re-applying it needs no confirmation', async () => {
    const id = await subject({ orgUnitId: a1, department: 'dept-a4' })
    await apply([{ teammateId: id, seen: await seenOf(id), target: { regionId: regionA, orgUnitId: a4 } }])
    await t.client`UPDATE directory_region_rule SET org_unit_id = ${a2}::uuid WHERE match_value = 'dept-a4'`
    try {
      const res = await apply([{ teammateId: id, seen: await seenOf(id), target: { regionId: regionA, orgUnitId: a2 } }])
      expect(outcomeOf(res, id)?.outcome).toBe('moved')
    } finally {
      await t.client`UPDATE directory_region_rule SET org_unit_id = ${a4}::uuid WHERE match_value = 'dept-a4'`
    }
  })
})

describe('placement-check apply: refusals', () => {
  it('changed-since-check when the unit, the region or only the provenance differs from seen', async () => {
    const id = await subject({ orgUnitId: a1, department: 'dept-a4', metadata: { placedVia: 'manager-chain', placedOwnerOid: 'x' } })
    const seen = await seenOf(id)
    const target = { regionId: regionA, orgUnitId: a4 }
    const res = await apply([{ teammateId: id, seen: { ...seen, orgUnitId: a2 }, target }])
    expect(outcomeOf(res, id)).toEqual({ teammateId: id, outcome: 'refused', reason: 'changed-since-check' })
    const res2 = await apply([{ teammateId: id, seen: { ...seen, regionId: regionB }, target }])
    expect(outcomeOf(res2, id)?.reason).toBe('changed-since-check')
    const res3 = await apply([{ teammateId: id, seen: { ...seen, provenance: { placedVia: 'manager-chain', placedOwnerOid: 'y' } }, target }])
    expect(outcomeOf(res3, id)?.reason).toBe('changed-since-check')
    const res4 = await apply([{ teammateId: id, seen: { ...seen, provenance: null }, target }])
    expect(outcomeOf(res4, id)?.reason).toBe('changed-since-check')
    expect((await state(id)).org_unit_id).toBe(a1)
    expect(await audits(id)).toEqual([])
  })

  it('a U -> V -> U manual round trip: stale seen is changed-since-check, fresh seen needs confirmManual', async () => {
    const id = await subject({ orgUnitId: a1, department: 'dept-a4', metadata: { placedVia: 'manager-chain', placedOwnerOid: 'x' } })
    const before = await seenOf(id)
    for (const to of [a2, a1]) {
      await orgUnitHandler(ev({ session: platform(), id, method: 'PATCH', body: { org_unit_id: to } }))
    }
    const target = { regionId: regionA, orgUnitId: a4 }
    expect(outcomeOf(await apply([{ teammateId: id, seen: before, target }]), id)?.reason).toBe('changed-since-check')

    const fresh = await seenOf(id)
    expect(fresh).toEqual({ regionId: regionA, orgUnitId: a1, provenance: null })
    expect(outcomeOf(await apply([{ teammateId: id, seen: fresh, target }]), id)?.reason).toBe('manual-not-confirmed')
    expect((await state(id)).org_unit_id).toBe(a1)

    const res = await apply([{ teammateId: id, seen: fresh, target, confirmManual: true }])
    expect(outcomeOf(res, id)?.outcome).toBe('moved')
    expect((await state(id)).org_unit_id).toBe(a4)
  })

  it('derivation-changed when the evidence now derives elsewhere, is undecided, or is missing', async () => {
    const elsewhere = await subject({ orgUnitId: a1, department: 'dept-a4' })
    const failed = await subject({ orgUnitId: a1, department: 'dept-a4', walkEnd: 'graph-error' })
    const none = await subject({ orgUnitId: a1, evidence: false })
    const nothing = await subject({ orgUnitId: a1, department: 'nothing' })
    const target = { regionId: regionA, orgUnitId: a2 }
    const res = await apply([
      { teammateId: elsewhere, seen: await seenOf(elsewhere), target },
      { teammateId: failed, seen: await seenOf(failed), target: { regionId: regionA, orgUnitId: a4 } },
      { teammateId: none, seen: await seenOf(none), target },
      { teammateId: nothing, seen: await seenOf(nothing), target },
    ])
    expect(res.results.map((r) => r.reason)).toEqual(['derivation-changed', 'derivation-changed', 'derivation-changed', 'derivation-changed'])
  })

  it('derivation-changed when a region-only target meets a unit derivation, or a unit target a region-only one', async () => {
    const unitDerived = await subject({ orgUnitId: a1, department: 'dept-b1' })
    const regionDerived = await subject({ orgUnitId: a1, managers: [LEADER_B_OID] })
    const res = await apply([
      { teammateId: unitDerived, seen: await seenOf(unitDerived), target: { regionId: regionB, orgUnitId: null } },
      { teammateId: regionDerived, seen: await seenOf(regionDerived), target: { regionId: regionB, orgUnitId: b1 } },
    ])
    expect(res.results.map((r) => r.reason)).toEqual(['derivation-changed', 'derivation-changed'])
    expect((await state(regionDerived)).region_id).toBe(regionA)
  })

  it('target-invalid for a region-only target in the current region or an unknown region', async () => {
    const same = await subject({ orgUnitId: a1, managers: [LEADER_B_OID] })
    const unknown = await subject({ orgUnitId: a1, managers: [LEADER_B_OID] })
    const res = await apply([
      { teammateId: same, seen: await seenOf(same), target: { regionId: regionA, orgUnitId: null } },
      { teammateId: unknown, seen: await seenOf(unknown), target: { regionId: '9a1e0000-0000-4000-8000-0000000005fe', orgUnitId: null } },
    ])
    expect(res.results.map((r) => r.reason)).toEqual(['target-invalid', 'target-invalid'])
  })

  it('target-invalid for a retired unit, a non-cost-owning unit, a unit outside the target region, or the current unit', async () => {
    const ids = await Promise.all([0, 1, 2, 3].map(() => subject({ orgUnitId: a1, department: 'dept-a4' })))
    const targets = [
      { regionId: regionA, orgUnitId: aRetired },
      { regionId: regionA, orgUnitId: aTeam },
      { regionId: regionB, orgUnitId: a4 },
      { regionId: regionA, orgUnitId: a1 },
    ]
    const res = await apply(await Promise.all(ids.map(async (id, i) => ({ teammateId: id, seen: await seenOf(id), target: targets[i]! }))))
    expect(res.results.map((r) => r.reason)).toEqual(['target-invalid', 'target-invalid', 'target-invalid', 'target-invalid'])
  })

  it('derivation-changed when a rule changes after the page loaded, including mid-batch after the request began', async () => {
    const before = await subject({ orgUnitId: a1, department: 'dept-a4' })
    const first = await subject({ orgUnitId: a1, department: 'dept-b1' })
    const second = await subject({ orgUnitId: a1, department: 'dept-a4' })
    const target = { regionId: regionA, orgUnitId: a4 }
    const seenBefore = await seenOf(before)
    await t.client`UPDATE directory_region_rule SET org_unit_id = ${a2}::uuid WHERE match_value = 'dept-a4'`
    try {
      expect(outcomeOf(await apply([{ teammateId: before, seen: seenBefore, target }]), before)?.reason).toBe('derivation-changed')
    } finally {
      await t.client`UPDATE directory_region_rule SET org_unit_id = ${a4}::uuid WHERE match_value = 'dept-a4'`
    }

    // The first item's audit row re-targets the rule the second item derives from.
    await t.client.unsafe(`
      CREATE FUNCTION pca_rule_flip() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$
      BEGIN
        IF NEW.subject_id = '${first}'::uuid THEN
          UPDATE directory_region_rule SET org_unit_id = '${a2}'::uuid WHERE match_value = 'dept-a4';
        END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER pca_rule_flip AFTER INSERT ON audit_event FOR EACH ROW EXECUTE FUNCTION pca_rule_flip();`)
    try {
      const res = await apply([
        { teammateId: first, seen: await seenOf(first), target: { regionId: regionB, orgUnitId: b1 } },
        { teammateId: second, seen: await seenOf(second), target },
      ])
      expect(res.results.map((r) => [r.outcome, r.reason])).toEqual([['moved', undefined], ['refused', 'derivation-changed']])
      expect((await state(second)).org_unit_id).toBe(a1)
    } finally {
      await t.client.unsafe('DROP TRIGGER pca_rule_flip ON audit_event; DROP FUNCTION pca_rule_flip();')
      await t.client`UPDATE directory_region_rule SET org_unit_id = ${a4}::uuid WHERE match_value = 'dept-a4'`
    }
  })

  it('derivation-changed when the unit owner the page showed gains a second unit after it loaded', async () => {
    const id = await subject({ orgUnitId: a1, managers: [OWNER_OID] })
    const seen = await seenOf(id)
    await t.client`INSERT INTO cou_owner (org_unit_id, teammate_id) VALUES (${a4}::uuid, ${OWNER_ID}::uuid)`
    try {
      const res = await apply([{ teammateId: id, seen, target: { regionId: regionA, orgUnitId: a2 } }])
      expect(outcomeOf(res, id)?.reason).toBe('derivation-changed')
    } finally {
      await t.client`DELETE FROM cou_owner WHERE org_unit_id = ${a4}::uuid AND teammate_id = ${OWNER_ID}::uuid`
    }
  })

  it('derivation-changed when the target still matches but the verdict is no longer applicable', async () => {
    // A manager below the Region leader now owns two units: still region B, but ambiguous-owner.
    const multiId = randomUUID()
    await t.client`INSERT INTO teammate (id, entra_oid, email, display_name, region_id, org_unit_id, is_active)
      VALUES (${multiId}::uuid, 'oid-pca-multi', 'pca-multi@x.test', 'Multi', ${regionA}::uuid, ${a1}::uuid, true)`
    const ambiguous = await subject({ orgUnitId: a1, managers: ['oid-pca-multi', LEADER_B_OID] })
    const recut = await subject({ orgUnitId: a1, managers: [LEADER_B_OID] })
    const target = { regionId: regionB, orgUnitId: null }
    const seenAmbiguous = await seenOf(ambiguous)
    const seenRecut = await seenOf(recut)
    await t.client`INSERT INTO cou_owner (org_unit_id, teammate_id) VALUES (${a1}::uuid, ${multiId}::uuid), (${a4}::uuid, ${multiId}::uuid)`
    await t.client`UPDATE placement_evidence SET walk_end = 'hop-cap' WHERE teammate_id = ${recut}::uuid`
    try {
      const res = await apply([
        { teammateId: ambiguous, seen: seenAmbiguous, target },
        { teammateId: recut, seen: seenRecut, target },
      ])
      expect(res.results.map((r) => r.reason)).toEqual(['derivation-changed', 'derivation-changed'])
      expect((await state(ambiguous)).region_id).toBe(regionA)
      expect((await state(recut)).region_id).toBe(regionA)
    } finally {
      await t.client`DELETE FROM cou_owner WHERE teammate_id = ${multiId}::uuid`
    }
  })

  it('not-found for a teammate deactivated after the page loaded', async () => {
    const id = await subject({ orgUnitId: a1, department: 'dept-a4' })
    const seen = await seenOf(id)
    await t.client`UPDATE teammate SET is_active = false WHERE id = ${id}::uuid`
    const res = await apply([{ teammateId: id, seen, target: { regionId: regionA, orgUnitId: a4 } }])
    expect(outcomeOf(res, id)).toEqual({ teammateId: id, outcome: 'refused', reason: 'not-found' })
    expect((await state(id)).org_unit_id).toBe(a1)
  })

  it('not-found for an unknown teammate', async () => {
    const id = '9a1e0000-0000-4000-8000-0000000005ff'
    const res = await apply([{ teammateId: id, seen: { regionId: regionA, orgUnitId: a1, provenance: null }, target: { regionId: regionA, orgUnitId: a4 } }])
    expect(outcomeOf(res, id)).toEqual({ teammateId: id, outcome: 'refused', reason: 'not-found' })
  })

  it('a throw after the write rolls back that item only and reports error', async () => {
    const good1 = await subject({ orgUnitId: a1, department: 'dept-a4' })
    const bad = await subject({ orgUnitId: a1, department: 'dept-a4' })
    const good2 = await subject({ orgUnitId: a1, department: 'dept-a4' })
    await t.client.unsafe(`
      CREATE FUNCTION pca_fail() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.subject_id = '${bad}'::uuid THEN RAISE EXCEPTION 'pca injected failure'; END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER pca_fail BEFORE INSERT ON audit_event FOR EACH ROW EXECUTE FUNCTION pca_fail();`)
    try {
      const target = { regionId: regionA, orgUnitId: a4 }
      const res = await apply(
        await Promise.all([good1, bad, good2].map(async (id) => ({ teammateId: id, seen: await seenOf(id), target }))),
      )
      expect(res.results.map((r) => [r.outcome, r.reason])).toEqual([['moved', undefined], ['refused', 'error'], ['moved', undefined]])
      const s = await state(bad)
      expect([s.org_unit_id, s.provenance]).toEqual([a1, null])
      expect((await state(good1)).org_unit_id).toBe(a4)
      expect((await state(good2)).org_unit_id).toBe(a4)
    } finally {
      await t.client.unsafe('DROP TRIGGER pca_fail ON audit_event; DROP FUNCTION pca_fail();')
    }
  })
})

describe('placement-check apply: the request', () => {
  it('a region admin is refused (403) and nothing moves', async () => {
    const id = await subject({ orgUnitId: a1, department: 'dept-a4' })
    await expect(apply([{ teammateId: id, seen: await seenOf(id), target: { regionId: regionA, orgUnitId: a4 } }], regionAdmin()))
      .rejects.toMatchObject({ statusCode: 403 })
    expect((await state(id)).org_unit_id).toBe(a1)
  })

  it('400 on a repeated teammate or more items than the cap', async () => {
    const id = await subject({ orgUnitId: a1, department: 'dept-a4' })
    const item = { teammateId: id, seen: await seenOf(id), target: { regionId: regionA, orgUnitId: a4 } }
    await expect(apply([item, item])).rejects.toMatchObject({ statusCode: 400 })
    const many = Array.from({ length: 201 }, () => ({ ...item, teammateId: randomUUID() }))
    await expect(apply(many)).rejects.toMatchObject({ statusCode: 400 })
  })
})

describe('placement-check: a home chosen at provisioning is manual', () => {
  async function evidenceFor(id: string, department: string) {
    const [row] = await t.client<{ oid: string }[]>`SELECT entra_oid AS oid FROM teammate WHERE id = ${id}::uuid`
    await t.client`INSERT INTO placement_evidence (teammate_id, gathered_at, cycle_id, lookup, attributes, chain, walk_end)
      VALUES (${id}::uuid, now(), ${cycleId}::uuid, 'oid', ${JSON.stringify({ department })}::jsonb,
              ${JSON.stringify([{ oid: row!.oid, name: 'P', email: null }])}::jsonb, 'top-of-chart')`
  }
  const rowOf = async (id: string) =>
    (await loadPlacementCheck(t.db, { today: '2026-10-21' })).rows.find((r) => r.teammateId === id)!
  const provision = (body: Record<string, string>) =>
    provisionHandler(ev({ session: platform(), body: { region_id: regionA, org_unit_id: a1, role: 'developer', ...body } })) as Promise<{
      id: string
      adopted: boolean
    }>

  it('provisioned by an admin: manual, not bulk-selectable, Apply needs confirmManual', async () => {
    const { id } = await provision({ oid: 'dir-oid-0001' })
    await evidenceFor(id, 'dept-a4')
    const row = await rowOf(id)
    expect(row.verdict).toBe('manual')
    expect(bulkSelectablePlacementIds([row])).toEqual([])

    const item = { teammateId: id, seen: row.seen, target: { regionId: regionA, orgUnitId: a4 } }
    expect(outcomeOf(await apply([item]), id)?.reason).toBe('manual-not-confirmed')
    expect(outcomeOf(await apply([{ ...item, confirmManual: true }]), id)?.outcome).toBe('moved')
  })

  it('a placed bill row adopted by an admin loses its derived provenance and reads manual', async () => {
    const billId = randomUUID()
    await t.client`INSERT INTO teammate (id, entra_oid, email, display_name, region_id, org_unit_id, is_active, metadata)
      VALUES (${billId}::uuid, ${`bill:${billId}`}, 'tom.becker@example.com', 'Tom', ${regionB}::uuid, ${b1}::uuid, true,
              ${JSON.stringify({ placedVia: 'manager-chain', placedOwnerOid: 'x' })}::jsonb)`
    const res = await provision({ oid: 'dir-oid-0002' })
    expect(res).toMatchObject({ id: billId, adopted: true })
    expect((await state(billId)).provenance).toBeNull()
    await evidenceFor(billId, 'dept-a4')
    expect((await rowOf(billId)).verdict).toBe('manual')
  })

  it('a provisioning row without a chosen unit (the project and owner doors) is not manual', async () => {
    const id = await subject({ orgUnitId: a1, department: 'dept-a4' })
    await t.client`INSERT INTO audit_event (event_type, actor_teammate_id, subject_kind, subject_id, payload)
      VALUES ('teammate-provisioned', ${PLATFORM_ID}::uuid, 'teammate', ${id}::uuid, ${JSON.stringify({ via: 'project-assign' })}::jsonb)`
    expect((await rowOf(id)).verdict).toBe('move-unit')
  })
})
