// @vitest-environment node
/*
 * GET /api/v1/rollups/practice/:ouId — the practice detail view. Testcontainers Postgres via the
 * OWNER connection (RLS inert in prod too) so the in-query gate is what's exercised. Validates:
 * the dual lane (usage from attribution_record subtree + reconciled bill from
 * v_finance_bill_chargeback), the owner-aware gate (a cou_owner sees their practice even with no
 * managerial scope), the cross-region 403, and that the comparison panel is RE-GATED to the
 * caller (a pure owner never sees a sibling practice's numbers).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'
import { injectTestSession } from '../../helpers/auth'
import type { Session } from '../../../server/utils/auth'
import handler from '../../../server/api/v1/rollups/practice/[ouId].get'

let t: TestDb
let regionA = ''
let regionB = ''
let regionC = '' // isolated region for the Copilot-only (no-OTel) visibility case
let mpoId = '' // practice P (region A), owned by kat
let bizId = '' // sibling practice Q (region A), NOT owned by kat
let opsId = '' // practice R (region B)
let copId = '' // practice (region C) whose only member is Copilot-only (unaccounted, no OTel)
const KAT = '00000000-0000-0000-0000-00000000ca71'

const ev = (session: Session, ouId: string) => {
  const headers: Record<string, string> = { host: 'localhost:3450', origin: 'http://localhost:3450' }
  const e = {
    method: 'GET', path: `/x/${ouId}`, context: { params: { ouId } },
    node: {
      req: { method: 'GET', url: `/x/${ouId}`, socket: { remoteAddress: '127.0.0.1' }, get headers() { return { ...headers } } },
      res: { _headers: {} as Record<string, unknown>, statusCode: 200, getHeader() {}, setHeader() {}, removeHeader() {}, appendHeader() {}, get headersSent() { return false } },
    },
  }
  injectTestSession(e as unknown as Parameters<typeof injectTestSession>[0], session)
  return e as unknown as Parameters<typeof handler>[0]
}
const sess = (role: string, orgPath: string, regionId: string, teammateId = '00000000-0000-0000-0000-000000000001'): Session =>
  ({ teammateId, email: 'x@x.test', displayName: 'X', role, regionId, orgPath, issuedAt: new Date().toISOString() } as unknown as Session)

beforeAll(async () => {
  t = await startTestDb()
  process.env.DATABASE_URL = t.url
  const mkRegion = async (code: string, name: string) => {
    await t.client`INSERT INTO region (code, display_name) VALUES (${code}, ${name})`
    const [r] = await t.client<{ id: string }[]>`SELECT id::text AS id FROM region WHERE code=${code}`
    return r!.id
  }
  regionA = await mkRegion('pra', 'Prac Region A')
  regionB = await mkRegion('prb', 'Prac Region B')
  const mkUnit = async (region: string, path: string, code: string, cou = true, parent: string | null = null) => {
    await t.client`INSERT INTO org_unit (region_id, parent_id, path, code, display_name, unit_type, is_cost_owning_unit)
      VALUES (${region}::uuid, ${parent}::uuid, ${path}::ltree, ${code}, ${code}, 'practice', ${cou})`
    const [r] = await t.client<{ id: string }[]>`SELECT id::text AS id FROM org_unit WHERE region_id=${region}::uuid AND code=${code}`
    return r!.id
  }
  // S3 part (a): 'mpo' is used below as a MANAGER's own placement, which now must pass
  // placedBelowRegionRootPredicate() (parent_id IS NOT NULL). 'biz' gets the SAME parent_id
  // (not just any non-null value) because the comparison panel below groups siblings by
  // `parent_id IS NOT DISTINCT FROM` (practice/[ouId].get.ts) — giving mpo a DIFFERENT
  // parent than biz would silently break "comparison shows region siblings for an admin
  // (mpo + biz)". `cou=false` keeps this placeholder out of the comparison query (it
  // requires is_cost_owning_unit=TRUE) and every usage/bill query (none reference its id) —
  // it exists ONLY as a parent_id target.
  const s3RegionARootId = await mkUnit(regionA, 'pra_root', '__s3_root__', false, null)
  mpoId = await mkUnit(regionA, 'mpo', 'mpo', true, s3RegionARootId)
  bizId = await mkUnit(regionA, 'biz', 'biz', true, s3RegionARootId)
  opsId = await mkUnit(regionB, 'ops', 'ops')

  const mkTeammate = async (id: string | null, region: string, unit: string, email: string) => {
    if (id) {
      await t.client`INSERT INTO teammate (id, entra_oid, email, display_name, region_id, org_unit_id)
        VALUES (${id}::uuid, 'oid-'||${email}, ${email}, ${email}, ${region}::uuid, ${unit}::uuid)`
      return id
    }
    await t.client`INSERT INTO teammate (entra_oid, email, display_name, region_id, org_unit_id)
      VALUES ('oid-'||${email}, ${email}, ${email}, ${region}::uuid, ${unit}::uuid)`
    const [r] = await t.client<{ id: string }[]>`SELECT id::text AS id FROM teammate WHERE email=${email}`
    return r!.id
  }
  const addUsage = async (teammateId: string, region: string, unit: string, cost: number, tool: string) => {
    await t.client`INSERT INTO instance_attestation (instance_id, principal_oid, teammate_id, tool, region_id, org_unit_id, project_code_hash, raw_project_code)
      VALUES (gen_random_uuid(), 'p', ${teammateId}::uuid, ${tool}, ${region}::uuid, ${unit}::uuid, 'h', 'P')`
    const [ia] = await t.client<{ id: string }[]>`SELECT instance_id::text AS id FROM instance_attestation WHERE teammate_id=${teammateId}::uuid LIMIT 1`
    await t.client`INSERT INTO attribution_record (instance_id, teammate_id, region_id, org_unit_id, tool, model, token_type, tokens, cost_usd, fidelity_tier, cost_basis, ts_event)
      VALUES (${ia!.id}::uuid, ${teammateId}::uuid, ${region}::uuid, ${unit}::uuid, ${tool}, 'claude-sonnet-4-6', 'input', 1000, ${cost}, 'tier-1', 'estimated', now())`
  }

  const alice = await mkTeammate(KAT, regionA, mpoId, 'kat@a.test') // kat is homed in mpo AND owns it
  await addUsage(alice, regionA, mpoId, 10, 'claude-code')
  await addUsage(alice, regionA, mpoId, 4, 'copilot-cli')
  // The reconciled bill for kat (homes to mpo, her nearest cost-owning ancestor).
  await t.client`INSERT INTO actual_spend (teammate_id, date, tool, input_tokens, output_tokens, cost_usd)
    VALUES (${alice}::uuid, CURRENT_DATE, 'claude-code', 1000, 500, 20)`
  // kat owns mpo (the owner-gate subject).
  await t.client`INSERT INTO cou_owner (org_unit_id, teammate_id) VALUES (${mpoId}::uuid, ${KAT}::uuid)`

  const bob = await mkTeammate(null, regionA, bizId, 'bob@a.test')
  await addUsage(bob, regionA, bizId, 7, 'claude-code')
  const carol = await mkTeammate(null, regionB, opsId, 'carol@b.test')
  await addUsage(carol, regionB, opsId, 99, 'claude-code')

  // Region C: the real-world Copilot case — dave has NO OTel (no attribution_record), only the
  // §A unaccounted_usage gap from the provider API (reconciliation_record). Before the
  // v_complete_usage fix this practice showed $0 / 0 users; it must now show his usage.
  regionC = await mkRegion('prc', 'Prac Region C')
  copId = await mkUnit(regionC, 'cop', 'cop')
  const dave = await mkTeammate(null, regionC, copId, 'dave@c.test')
  await t.client`INSERT INTO unaccounted_usage (teammate_id, region_id, org_unit_id, day, tool, cost_usd, tokens, source)
    VALUES (${dave}::uuid, ${regionC}::uuid, ${copId}::uuid, CURRENT_DATE, 'copilot-cli', 30, 0, 'api-reconciled')`
}, 120_000)
afterAll(async () => { await stopTestDb(t) })

interface Resp {
  header: { usageUsd: number; users: number; pctOfRegion: number | null; vsRegionAvgPct: number | null }
  lanes: { usageSignalUsd: number; billUsd: number }
  // #142: ordered per-lane array (claude = Claude CODE first, copilot, then any
  // non-Code surface lane with spend; zero-spend surface lanes are elided).
  vendorSplit: { lane: string; label: string; usageUsd: number; billUsd: number }[]
  users: { name: string }[]
  comparison: { code: string; isSelf: boolean }[]
  trend: { weekStart: string; claudeUsd: number; copilotUsd: number }[]
}

/** The vendorSplit entry for a lane; fails the test loudly if the lane is absent. */
function lane(r: Resp, id: string): { lane: string; label: string; usageUsd: number; billUsd: number } {
  const l = r.vendorSplit.find((v) => v.lane === id)
  expect(l, `vendorSplit is missing the ${id} lane`).toBeDefined()
  return l!
}

describe('GET /api/v1/rollups/practice/:ouId', () => {
  it('an admin sees the dual lane (usage subtree + reconciled bill) + vendor split', async () => {
    const r = (await handler(ev(sess('admin', 'mpo', regionA), mpoId))) as Resp
    expect(r.header.usageUsd).toBe(14) // claude 10 + copilot 4
    expect(r.lanes.billUsd).toBe(20) // the reconciled bill homed to mpo — NOT the usage estimate
    expect(lane(r, 'claude').usageUsd).toBe(10)
    expect(lane(r, 'copilot').usageUsd).toBe(4)
    expect(lane(r, 'claude').billUsd).toBe(20)
    expect(lane(r, 'claude').label).toBe('Claude Code')
    // #142 lane elision: no non-Code Claude surface has spend here, so only the
    // always-present claude + copilot lanes render (zero-spend surfaces elided).
    expect(r.vendorSplit.map((v) => v.lane).sort()).toEqual(['claude', 'copilot'])
    // Conservation: Σ lane bills == the header bill (the catch-all guarantee).
    expect(r.vendorSplit.reduce((a, v) => a + v.billUsd, 0)).toBe(r.lanes.billUsd)
    expect(r.users.map((u) => u.name)).toContain('kat@a.test')
    expect(r.header.pctOfRegion).toBeCloseTo(14 / 21) // region usage = mpo 14 + biz 7; admin sees the ratio
    // Trend (v_effective_spend) — this week carries mpo's claude 10 + copilot 4.
    expect(r.trend.reduce((a, w) => a + w.claudeUsd, 0)).toBe(10)
    expect(r.trend.reduce((a, w) => a + w.copilotUsd, 0)).toBe(4)
  })

  it('a COPILOT-ONLY teammate (no OTel, only unaccounted usage) IS visible — would be $0 before v_complete_usage', async () => {
    const r = (await handler(ev(sess('admin', 'cop', regionC), copId))) as Resp
    expect(r.header.usageUsd).toBe(30) // dave's unaccounted Copilot — invisible to attribution_record alone
    expect(r.header.users).toBe(1) // and he COUNTS as a person (was 0)
    expect(lane(r, 'copilot').usageUsd).toBe(30) // attributed to the Copilot vendor lane
    expect(r.users.map((u) => u.name)).toContain('dave@c.test') // shows in the people list with his spend
  })

  it('a manager whose subtree covers the practice does NOT get region-wide context (denominator leak)', async () => {
    // manager rooted AT mpo: subtree covers mpo, but the region denominator spans biz (outside it).
    const r = (await handler(ev(sess('manager', 'mpo', regionA), mpoId))) as Resp
    expect(r.header.usageUsd).toBe(14)
    expect(r.header.pctOfRegion).toBeNull() // role-gated — a manager can't recover the region total
    expect(r.header.vsRegionAvgPct).toBeNull()
  })

  it('comparison shows region siblings for an admin (mpo + biz)', async () => {
    const r = (await handler(ev(sess('admin', 'mpo', regionA), mpoId))) as Resp
    expect(r.comparison.map((c) => c.code).sort()).toEqual(['biz', 'mpo'])
    expect(r.comparison.find((c) => c.code === 'mpo')!.isSelf).toBe(true)
  })

  it('an admin of region A cannot open a region B practice (cross-region 403)', async () => {
    await expect(handler(ev(sess('admin', 'mpo', regionA), opsId))).rejects.toMatchObject({ statusCode: 403 })
  })

  it('a cou_owner sees their practice with NO managerial scope (owner gate)', async () => {
    // kat: developer, org path that does NOT cover mpo, but she OWNS mpo.
    const r = (await handler(ev(sess('developer', 'somewhere.else', regionA, KAT), mpoId))) as Resp
    expect(r.header.usageUsd).toBe(14)
    // A pure owner must NOT get region context — else they could recover the region total from the ratio.
    expect(r.header.pctOfRegion).toBeNull()
    expect(r.header.vsRegionAvgPct).toBeNull()
  })

  it('the owner gate does NOT leak a sibling she does not own (403) and comparison is re-gated', async () => {
    // kat owns mpo only — biz must 403, and mpo's comparison must NOT include biz for her.
    await expect(handler(ev(sess('developer', 'somewhere.else', regionA, KAT), bizId))).rejects.toMatchObject({ statusCode: 403 })
    const r = (await handler(ev(sess('developer', 'somewhere.else', regionA, KAT), mpoId))) as Resp
    expect(r.comparison.map((c) => c.code)).toEqual(['mpo']) // only her own practice, NOT biz
  })

  it('a non-Code Claude surface bill gets its OWN lane — bill-only, $0 usage (#142)', async () => {
    // kat's Claude Chat spend arrives on the BILL side only (non-Code surfaces
    // never emit OTel). It must surface as a distinct claude-ai lane, labelled,
    // with usageUsd structurally 0 — and the lane totals must still conserve.
    await t.client`INSERT INTO actual_spend (teammate_id, date, tool, input_tokens, output_tokens, cost_usd)
      VALUES (${KAT}::uuid, CURRENT_DATE, 'claude-ai', 200, 100, 6)`
    const r = (await handler(ev(sess('admin', 'mpo', regionA), mpoId))) as Resp
    const chat = lane(r, 'claude-ai')
    expect(chat.billUsd).toBe(6)
    expect(chat.usageUsd).toBe(0) // no OTel for chat — bill-only by design
    expect(chat.label).toBe('Claude Chat')
    expect(lane(r, 'claude').billUsd).toBe(20) // the Code bill did NOT absorb it
    expect(r.lanes.billUsd).toBe(26)
    expect(r.vendorSplit.reduce((a, v) => a + v.billUsd, 0)).toBe(26) // conservation across lanes
  })
})

/*
 * Current-org lens (docs/design/current-org-lens/00-design.md §3.2): every panel groups a
 * person's usage by where they sit NOW. Eve's rows are all stamped region D / unit X (live
 * attribution, unaccounted Copilot, and an ARCHIVED day served from spend_rollup_daily), but she
 * now sits in region E / unit Y, so every panel counts her under Y and none under X.
 */
describe('practice page — current placement, not the stamped one', () => {
  let regionD = ''
  let regionE = ''
  let unitX = '' // region D: where eve's rows were stamped, fay still sits
  let unitY = '' // region E: where eve sits now
  let unitY2 = '' // region E: Y's sibling, gus
  interface Panels extends Resp {
    topModels: { model: string; usageUsd: number }[]
    comparison: { code: string; isSelf: boolean; usageUsd: number }[]
  }
  const sum = (r: Panels, k: 'claudeUsd' | 'copilotUsd') => r.trend.reduce((a, w) => a + w[k], 0)

  beforeAll(async () => {
    const mkRegion = async (code: string) => {
      await t.client`INSERT INTO region (code, display_name) VALUES (${code}, ${code})`
      const [r] = await t.client<{ id: string }[]>`SELECT id::text AS id FROM region WHERE code=${code}`
      return r!.id
    }
    const mkUnit = async (region: string, path: string, code: string, cou: boolean, parent: string | null) => {
      const [r] = await t.client<{ id: string }[]>`INSERT INTO org_unit (region_id, parent_id, path, code, display_name, unit_type, is_cost_owning_unit)
        VALUES (${region}::uuid, ${parent}::uuid, ${path}::ltree, ${code}, ${code}, 'practice', ${cou}) RETURNING id::text AS id`
      return r!.id
    }
    const mkTeammate = async (id: string, region: string, unit: string, email: string) => {
      await t.client`INSERT INTO teammate (id, entra_oid, email, display_name, region_id, org_unit_id)
        VALUES (${id}::uuid, 'oid-'||${email}, ${email}, ${email}, ${region}::uuid, ${unit}::uuid)`
      return id
    }
    const attribute = async (tm: string, region: string, unit: string, cost: number, model: string) => {
      const [ia] = await t.client<{ id: string }[]>`INSERT INTO instance_attestation (instance_id, principal_oid, teammate_id, tool, region_id, org_unit_id, project_code_hash, raw_project_code)
        VALUES (gen_random_uuid(), 'p', ${tm}::uuid, 'claude-code', ${region}::uuid, ${unit}::uuid, 'h', 'P') RETURNING instance_id::text AS id`
      await t.client`INSERT INTO attribution_record (instance_id, teammate_id, region_id, org_unit_id, tool, model, token_type, tokens, cost_usd, fidelity_tier, cost_basis, ts_event)
        VALUES (${ia!.id}::uuid, ${tm}::uuid, ${region}::uuid, ${unit}::uuid, 'claude-code', ${model}, 'input', 1000, ${cost}, 'tier-1', 'estimated', now())`
    }
    regionD = await mkRegion('prd')
    regionE = await mkRegion('pre')
    unitX = await mkUnit(regionD, 'pdx', 'pdx', true, null)
    const rootE = await mkUnit(regionE, 'pe_root', 'pe-root', false, null)
    unitY = await mkUnit(regionE, 'pe_root.pey', 'pey', true, rootE)
    unitY2 = await mkUnit(regionE, 'pe_root.pey2', 'pey2', true, rootE)

    const eve = await mkTeammate('9a1e0000-0000-4000-8000-0000000000e1', regionE, unitY, 'eve@d.test')
    const fay = await mkTeammate('9a1e0000-0000-4000-8000-0000000000f1', regionD, unitX, 'fay@d.test')
    const gus = await mkTeammate('9a1e0000-0000-4000-8000-0000000000a1', regionE, unitY2, 'gus@e.test')
    await attribute(eve, regionD, unitX, 40, 'claude-mover-model')
    await t.client`INSERT INTO unaccounted_usage (teammate_id, region_id, org_unit_id, day, tool, cost_usd, tokens, source)
      VALUES (${eve}::uuid, ${regionD}::uuid, ${unitX}::uuid, CURRENT_DATE, 'copilot-cli', 5, 0, 'api-reconciled')`
    // An ARCHIVED day: older than the watermark, so v_effective_spend serves it from the rollup.
    await t.client`UPDATE ledger_archive_state SET archived_through = date_trunc('week', now()) - INTERVAL '6 weeks' WHERE id = 'singleton'`
    await t.client`INSERT INTO spend_rollup_daily (period_start, teammate_id, region_id, org_unit_id, tool, model, token_type, total_tokens, total_cost_usd, record_count)
      VALUES (date_trunc('week', now()) - INTERVAL '9 weeks', ${eve}::uuid, ${regionD}::uuid, ${unitX}::uuid, 'claude-code', 'claude-mover-model', 'input', 1000, 11, 1)`
    await attribute(fay, regionD, unitX, 3, 'claude-sonnet-4-6')
    await attribute(gus, regionE, unitY2, 6, 'claude-sonnet-4-6')
  })

  it('the practice she sits in now shows her usage in every panel, archived trend days included', async () => {
    const r = (await handler(ev(sess('admin', 'pe_root.pey', regionE), unitY))) as Panels
    expect(r.header.usageUsd).toBe(45) // attribution 40 + unaccounted Copilot 5, both stamped D/X
    expect(r.header.users).toBe(1)
    expect(r.users.map((u) => u.name)).toEqual(['eve@d.test'])
    expect(r.topModels).toEqual([{ model: 'claude-mover-model', usageUsd: 40 }])
    expect(r.header.pctOfRegion).toBeCloseTo(45 / 51) // region E = eve 45 + gus 6
    expect(sum(r, 'claudeUsd')).toBe(51) // live 40 + the archived rollup day 11
    expect(r.trend.length).toBe(2) // this week and the archived week
    const byCode = new Map(r.comparison.map((c) => [c.code, c.usageUsd]))
    expect(byCode.get('pey')).toBe(45)
    expect(byCode.get('pey2')).toBe(6)
  })

  it('the practice her rows were stamped with no longer counts her; totals are conserved', async () => {
    const x = (await handler(ev(sess('admin', 'pdx', regionD), unitX))) as Panels
    expect(x.header.usageUsd).toBe(3)
    expect(x.users.map((u) => u.name)).toEqual(['fay@d.test'])
    expect(x.topModels.map((m) => m.model)).not.toContain('claude-mover-model')
    expect(x.header.pctOfRegion).toBe(1) // region D is fay alone
    expect(sum(x, 'claudeUsd')).toBe(3)
    expect(x.comparison.find((c) => c.code === 'pdx')!.usageUsd).toBe(3)

    const y = (await handler(ev(sess('admin', 'pe_root.pey', regionE), unitY))) as Panels
    const y2 = (await handler(ev(sess('admin', 'pe_root.pey2', regionE), unitY2))) as Panels
    expect(x.header.usageUsd + y.header.usageUsd + y2.header.usageUsd).toBe(40 + 5 + 3 + 6)
  })

  it('a region-D admin can no longer see the practice she moved to', async () => {
    await expect(handler(ev(sess('admin', 'pdx', regionD), unitY))).rejects.toMatchObject({ statusCode: 403 })
  })
})
