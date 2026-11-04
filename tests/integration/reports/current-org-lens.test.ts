// @vitest-environment node
/*
 * The current-org lens (docs/design/current-org-lens/00-design.md §3.1, §3.3, §7):
 * every report groups and scopes a person's usage by where they sit NOW.
 *
 * THE FIXTURE. `mover` spent July while placed in region A / unit X; every row
 * is STAMPED A / X. They now sit in region B / unit Y. Their July is
 *   $30 arm 1 tagged to project P (P's Business Unit is X)
 *   $20 arm 1 untagged
 *   $40 arm 2 (api-reconciled)
 *   $7  arm 3 (provider-usage, claude-ai), stamped Business Unit X
 *   = $97, plus an $11 Anthropic billed fact (stamped A / X / X).
 * `stayer` sits in A / X and spent $5 (arm 1 untagged).
 * `nohome` sits in B under a unit with NO cost-owning ancestor; their $3 arm-3
 * row and $2 billed fact are stamped Business Unit Y.
 * An unresolved $13 billed fact has no teammate and no homing.
 *
 * Stamped, region A read $102 and region B $3. Under the lens: A $5, B $100,
 * whole company $105 either way.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'
import { buildUsageRollup } from '../helpers/usage-rollup'
import { injectTestSession } from '../../helpers/auth'
import { grantReportAccess } from '../helpers/report-access'
import type { Session } from '../../../server/utils/auth'
import regionHandler from '../../../server/api/v1/reports/region/index.get'
import driversHandler from '../../../server/api/v1/reports/region/drivers.get'
import behaviourHandler from '../../../server/api/v1/reports/region/behaviour.get'
import ccCardsHandler from '../../../server/api/v1/reports/cost-centres/index.get'
import ccDrillHandler from '../../../server/api/v1/reports/cost-centres/[ccId].get'
import teammateHandler from '../../../server/api/v1/reports/teammate/[id]/index.get'
import { fetchDrivers } from '../../../server/reporting/engine/drivers'
import { wholeCompanyUsage } from '../../../server/reporting/engine/scope'

let t: TestDb
let regionA = ''
let regionB = ''
let unitX = ''
let unitY = ''
let unitN = ''
let mover = ''
let stayer = ''
let nohome = ''
let adminAId = ''
let adminBId = ''
let elevatedId = ''

const MONTH = 'month=2026-07'
const JULY = { startIso: '2026-07-01T00:00:00.000Z', endIso: '2026-08-01T00:00:00.000Z' }

const ev = (session: Session, query = '', params: Record<string, string> = {}) => {
  const url = '/x' + (query ? `?${query}` : '')
  const headers: Record<string, string> = { host: 'localhost:3450', origin: 'http://localhost:3450' }
  const e = {
    method: 'GET',
    path: url,
    context: { params },
    node: {
      req: { method: 'GET', url, socket: { remoteAddress: '127.0.0.1' }, get headers() { return { ...headers } } },
      res: { _headers: {} as Record<string, unknown>, statusCode: 200, getHeader() {}, setHeader() {}, removeHeader() {}, appendHeader() {}, get headersSent() { return false } },
    },
  }
  injectTestSession(e as unknown as Parameters<typeof injectTestSession>[0], session)
  return e as unknown as Parameters<typeof regionHandler>[0]
}
const sess = (teammateId: string, role: string, regionId: string, orgPath: string): Session =>
  ({ teammateId, email: 'x@x.test', displayName: 'X', role, regionId, orgPath, issuedAt: new Date().toISOString() }) as unknown as Session
const adminA = () => sess(adminAId, 'admin', regionA, 'ra.x')
const adminB = () => sess(adminBId, 'admin', regionB, 'rb.y')
const elevated = () => sess(elevatedId, 'platform-admin', regionA, 'ra.x')

interface Row { key: string; label: string; usd: number }
interface DriversResp { headlineUsd: number; rows: Row[] }
interface RegionResp {
  kpis: { genuineUsd: number; activeUsers: number }
  practices: { key: string; label: string; value: number }[]
  regionCards?: { regionId: string | null; genuineUsd: number; activeUsers: number }[]
}
interface DrillResp { burnUsd: number; rows: Row[]; headlineUsd: number; kpis: { genuineUsd: number } }
interface CardsResp { cards: { id: string; burnUsd: number }[] }

const usdOf = (rows: Row[], key: string) => rows.find((r) => r.key === key)?.usd

beforeAll(async () => {
  t = await startTestDb()
  process.env.DATABASE_URL = t.url

  const mkRegion = async (code: string) => {
    const [r] = await t.client<{ id: string }[]>`
      INSERT INTO region (code, display_name) VALUES (${code}, ${'Region ' + code}) RETURNING id::text AS id`
    return r!.id
  }
  regionA = await mkRegion('ra')
  regionB = await mkRegion('rb')
  const mkUnit = async (region: string, path: string, code: string, costOwning: boolean, parent: string | null) => {
    const [r] = await t.client<{ id: string }[]>`
      INSERT INTO org_unit (region_id, parent_id, path, code, display_name, unit_type, is_cost_owning_unit)
      VALUES (${region}::uuid, ${parent}::uuid, ${path}::ltree, ${code}, ${'Unit ' + code}, 'bu', ${costOwning})
      RETURNING id::text AS id`
    return r!.id
  }
  const rootA = await mkUnit(regionA, 'ra', 'default', false, null)
  const rootB = await mkUnit(regionB, 'rb', 'default', false, null)
  unitX = await mkUnit(regionA, 'ra.x', 'x', true, rootA)
  unitY = await mkUnit(regionB, 'rb.y', 'y', true, rootB)
  unitN = await mkUnit(regionB, 'rb.n', 'n', false, rootB) // no cost-owning ancestor

  const mkTeammate = async (email: string, region: string, unit: string, role = 'developer') => {
    const [r] = await t.client<{ id: string }[]>`
      INSERT INTO teammate (entra_oid, email, display_name, region_id, org_unit_id, role, is_active)
      VALUES (${'oid-' + email}, ${email}, ${email}, ${region}::uuid, ${unit}::uuid, ${role}, true)
      RETURNING id::text AS id`
    return r!.id
  }
  // `mover` is created where their July happened; moved to B / Y after seeding.
  mover = await mkTeammate('mover@x.test', regionA, unitX)
  stayer = await mkTeammate('stayer@x.test', regionA, unitX)
  nohome = await mkTeammate('nohome@x.test', regionB, unitN)
  adminAId = await mkTeammate('admin-a@x.test', regionA, unitX, 'admin')
  adminBId = await mkTeammate('admin-b@x.test', regionB, unitY, 'admin')
  elevatedId = await mkTeammate('elevated@x.test', regionA, unitX, 'platform-admin')
  await grantReportAccess(t.client, elevatedId)

  const [{ id: projP }] = await t.client<{ id: string }[]>`
    INSERT INTO project (code, code_hash, display_name, type, region_id, cost_owning_unit_id)
    VALUES ('PROJ-P', 'hash-p', 'Project P', 'billable', ${regionA}::uuid, ${unitX}::uuid)
    RETURNING id::text AS id`

  const inst = async (tm: string, region: string, unit: string) => {
    const [r] = await t.client<{ id: string }[]>`
      INSERT INTO instance_attestation (instance_id, principal_oid, teammate_id, tool, region_id, org_unit_id, project_code_hash, raw_project_code)
      VALUES (gen_random_uuid(), 'p', ${tm}::uuid, 'claude-code', ${region}::uuid, ${unit}::uuid, 'h', 'P')
      RETURNING instance_id::text AS id`
    return r!.id
  }
  const moverInst = await inst(mover, regionA, unitX)
  const stayerInst = await inst(stayer, regionA, unitX)
  const ar = async (i: string, tm: string, cou: string | null, project: string | null, cost: number, ts: string) => {
    await t.client`INSERT INTO attribution_record
        (instance_id, teammate_id, region_id, org_unit_id, cost_owning_unit_id, project_id, tool, model, token_type, tokens, cost_usd, fidelity_tier, cost_basis, ts_event, claude_session_id)
      VALUES (${i}::uuid, ${tm}::uuid, ${regionA}::uuid, ${unitX}::uuid, ${cou}::uuid, ${project}::uuid, 'claude-code', 'claude-sonnet-4-6', 'input', 1000, ${cost}, 'tier-1', 'estimated', ${ts}::timestamptz, ${'conv-' + tm + ts})`
  }
  // Arm 1: the project-tagged row carries P's Business Unit (X); untagged carries none.
  await ar(moverInst, mover, unitX, projP, 30, '2026-07-02T10:00:00Z')
  await ar(moverInst, mover, null, null, 20, '2026-07-03T10:00:00Z')
  await ar(stayerInst, stayer, null, null, 5, '2026-07-03T11:00:00Z')
  // Arm 2: the API−OTel gap, stamped A / X.
  await t.client`INSERT INTO unaccounted_usage (teammate_id, region_id, org_unit_id, day, tool, cost_usd, tokens, source, model_gap_reason)
    VALUES (${mover}::uuid, ${regionA}::uuid, ${unitX}::uuid, '2026-07-10'::date, 'copilot-cli', 40, 0, 'api-reconciled', 'provider-day-grain')`
  // Arm 3: provider-reported claude-ai, stamped with the PERSON's Business Unit then.
  const spend = async (tm: string, region: string, unit: string, cou: string | null, day: string, cost: number) => {
    await t.client`INSERT INTO actual_spend
        (teammate_id, date, tool, input_tokens, output_tokens, cost_usd, source, chargeback_exempt, region_id, org_unit_id, cost_owning_unit_id, dimension_source)
      VALUES (${tm}::uuid, ${day}::date, 'claude-ai', 100, 100, ${cost}, 'anthropic-analytics-api', false, ${region}::uuid, ${unit}::uuid, ${cou}::uuid, 'ingest-snapshot')`
  }
  await spend(mover, regionA, unitX, unitX, '2026-07-05', 7)
  await spend(nohome, regionB, unitN, unitY, '2026-07-06', 3)
  // The billed lane: stamped at ingest like the rest.
  const fact = async (tm: string | null, actor: string, region: string | null, unit: string | null, cou: string | null, cost: number) => {
    await t.client`INSERT INTO provider_usage_fact
        (source, provider, teammate_id, actor_ref, date, tool, model, cost_type, cost_usd, currency, region_id, org_unit_id, cost_owning_unit_id)
      VALUES ('anthropic-analytics-api', 'anthropic', ${tm}::uuid, ${actor}, '2026-07-08'::date, 'claude-code', 'claude-sonnet-4-6', 'tokens', ${cost}, 'USD',
              ${region}::uuid, ${unit}::uuid, ${cou}::uuid)`
  }
  await fact(mover, 'mover@x.test', regionA, unitX, unitX, 11)
  await fact(nohome, 'nohome@x.test', regionB, unitN, unitY, 2)
  await fact(null, 'ghost@elsewhere.test', null, null, null, 13)
  // A current GitHub pull, so the teammate drill's freshness check (the mover
  // has an arm-2 Copilot row) answers instead of refusing. Consumption, not a
  // charge: no billed headline below includes it.
  await t.client`INSERT INTO provider_usage_fact
      (source, provider, teammate_id, date, tool, cost_type, cost_usd, pulled_at)
    VALUES ('github-api', 'github', ${mover}::uuid, '2026-07-10'::date, 'copilot-cli', 'ai-credit', 1, now())`

  await buildUsageRollup(t.db)

  // The restructure: one UPDATE, the way Org setup places a person. No stamp moves.
  await t.client`UPDATE teammate SET region_id = ${regionB}::uuid, org_unit_id = ${unitY}::uuid WHERE id = ${mover}::uuid`
}, 180_000)

afterAll(async () => {
  await stopTestDb(t)
})

describe('the stamps are untouched — the lens is a read', () => {
  it('every one of the mover\'s rows still records A / X', async () => {
    const [r] = await t.client<{ n: string }[]>`
      SELECT (SELECT count(*) FROM attribution_record WHERE teammate_id = ${mover}::uuid AND region_id <> ${regionA}::uuid)
           + (SELECT count(*) FROM usage_rollup_daily WHERE teammate_id = ${mover}::uuid AND region_id <> ${regionA}::uuid)
           + (SELECT count(*) FROM provider_usage_fact WHERE teammate_id = ${mover}::uuid AND region_id <> ${regionA}::uuid) AS n`
    expect(Number(r!.n)).toBe(0)
  })
})

describe('GET /reports/region — KPIs, practices and drivers follow the person', () => {
  it('region B carries the mover; region A keeps only the stayer', async () => {
    const b = (await regionHandler(ev(adminB(), MONTH))) as unknown as RegionResp
    expect(b.kpis.genuineUsd).toBeCloseTo(100, 6) // mover 97 + nohome 3
    expect(b.kpis.activeUsers).toBe(2)
    const a = (await regionHandler(ev(adminA(), MONTH))) as unknown as RegionResp
    expect(a.kpis.genuineUsd).toBeCloseTo(5, 6)
    expect(a.kpis.activeUsers).toBe(1)
  })

  it('the practice ranking homes the mover on Y and the unhomed person on no Business Unit', async () => {
    const b = (await regionHandler(ev(adminB(), MONTH))) as unknown as RegionResp
    const byKey = new Map(b.practices.map((p) => [p.key, p.value]))
    expect(byKey.get(unitY)).toBeCloseTo(97, 6)
    expect(byKey.get('unattributed')).toBeCloseTo(3, 6)
    expect(byKey.has(unitX)).toBe(false)
  })

  it('the drivers practice axis matches, and sums back to the headline', async () => {
    const d = (await driversHandler(ev(adminB(), `${MONTH}&axis=practice`))) as unknown as DriversResp
    expect(usdOf(d.rows, unitY)).toBeCloseTo(97, 6)
    expect(usdOf(d.rows, '__null_practice')).toBeCloseTo(3, 6)
    expect(d.headlineUsd).toBeCloseTo(100, 6)
  })

  it('a unit drill and a manager subtree clamp on where the person sits now', async () => {
    const drill = (await regionHandler(ev(elevated(), `${MONTH}&ou=${unitY}`))) as unknown as RegionResp
    expect(drill.kpis.genuineUsd).toBeCloseTo(97, 6)
    const oldUnit = (await regionHandler(ev(elevated(), `${MONTH}&ou=${unitX}`))) as unknown as RegionResp
    expect(oldUnit.kpis.genuineUsd).toBeCloseTo(5, 6)
    const manager = (await regionHandler(
      ev(sess(adminBId, 'manager', regionB, 'rb.y'), MONTH),
    )) as unknown as RegionResp
    expect(manager.kpis.genuineUsd).toBeCloseTo(97, 6)
  })

  it('the teammate axis lists the mover in B, never in A', async () => {
    const b = (await driversHandler(ev(adminB(), `${MONTH}&axis=teammate`))) as unknown as DriversResp
    expect(usdOf(b.rows, mover)).toBeCloseTo(97, 6)
    const a = (await driversHandler(ev(adminA(), `${MONTH}&axis=teammate`))) as unknown as DriversResp
    expect(usdOf(a.rows, mover)).toBeUndefined()
  })
})

describe('GET /reports/region?region=all — cards and the region axis', () => {
  it('the region cards place the mover in B, and the total is conserved', async () => {
    const r = (await regionHandler(ev(elevated(), `${MONTH}&region=all`))) as unknown as RegionResp
    const byRegion = new Map((r.regionCards ?? []).map((c) => [c.regionId, c.genuineUsd]))
    expect(byRegion.get(regionA)).toBeCloseTo(5, 6)
    expect(byRegion.get(regionB)).toBeCloseTo(100, 6)
    expect(r.kpis.genuineUsd).toBeCloseTo(105, 6)
  })

  /*
   * The drivers ROUTE offers no region axis (ACROSS_DRIVER_AXES — the cards
   * answer "which region"), so the engine's region branch is exercised directly.
   */
  it('the drivers engine region axis agrees with the cards', async () => {
    const d = await t.db.transaction((tx) =>
      fetchDrivers(tx as unknown as Parameters<typeof fetchDrivers>[0], wholeCompanyUsage, JULY, 'region'),
    )
    expect(usdOf(d.rows, regionA)).toBeCloseTo(5, 6)
    expect(usdOf(d.rows, regionB)).toBeCloseTo(100, 6)
    expect(d.headlineUsd).toBeCloseTo(105, 6)
  })
})

describe('Business Unit reports — the mixed column', () => {
  it("the mover's provider-reported usage moves to Y; the project-tagged row stays on P's unit X", async () => {
    const y = (await ccDrillHandler(ev(adminB(), MONTH, { ccId: unitY }))) as unknown as DrillResp
    expect(y.burnUsd).toBeCloseTo(7, 6) // arm 3 only; the unhomed person's stamped Y is gone
    // The hero reads the rollup lane: the same answer through the other view.
    expect(y.kpis.genuineUsd).toBeCloseTo(7, 6)
    const x = (await ccDrillHandler(ev(adminA(), MONTH, { ccId: unitX }))) as unknown as DrillResp
    expect(x.burnUsd).toBeCloseTo(30, 6) // the tagged row, by project, after its author left
    expect(x.kpis.genuineUsd).toBeCloseTo(30, 6)
  })

  it('the teammate axis shows the mover under both units, each on its own rows', async () => {
    const y = (await ccDrillHandler(ev(adminB(), `${MONTH}&axis=teammate`, { ccId: unitY }))) as unknown as DrillResp
    expect(usdOf(y.rows, mover)).toBeCloseTo(7, 6)
    const x = (await ccDrillHandler(ev(adminA(), `${MONTH}&axis=teammate`, { ccId: unitX }))) as unknown as DrillResp
    expect(usdOf(x.rows, mover)).toBeCloseTo(30, 6)
  })

  it('the cards agree with the drill', async () => {
    const r = (await ccCardsHandler(ev(adminB(), MONTH))) as unknown as CardsResp
    expect(r.cards.find((c) => c.id === unitY)?.burnUsd).toBeCloseTo(7, 6)
  })
})

describe('GET /reports/teammate/{id} — the drill gate reads the same lens', () => {
  it('opens from region B and is refused from region A', async () => {
    const ok = (await teammateHandler(
      ev(adminB(), `src=region:${regionB}&${MONTH}`, { id: mover }),
    )) as unknown as { headlineUsd: number }
    expect(ok.headlineUsd).toBeCloseTo(97, 6)
    await expect(
      teammateHandler(ev(adminA(), `src=region:${regionA}&${MONTH}`, { id: mover })),
    ).rejects.toMatchObject({ statusCode: 403 })
  })
})

describe('the billed lane follows the same person', () => {
  it('the chargeback practice axis homes the mover on Y in region B', async () => {
    const d = (await driversHandler(ev(adminB(), `${MONTH}&axis=practice&lane=chargeback`))) as unknown as DriversResp
    expect(usdOf(d.rows, unitY)).toBeCloseTo(11, 6)
    expect(usdOf(d.rows, '__null_practice')).toBeCloseTo(2, 6) // nohome: no Business Unit now
    const a = (await driversHandler(ev(adminA(), `${MONTH}&axis=practice&lane=chargeback`))) as unknown as DriversResp
    expect(a.headlineUsd).toBeCloseTo(0, 6)
  })

  it('whole company: the practice axis moves the mover; the unresolved actor stays unhomed', async () => {
    const d = (await driversHandler(
      ev(elevated(), `${MONTH}&region=all&axis=practice&lane=chargeback`),
    )) as unknown as DriversResp
    expect(usdOf(d.rows, unitY)).toBeCloseTo(11, 6)
    expect(usdOf(d.rows, unitX)).toBeUndefined()
    expect(usdOf(d.rows, '__null_practice')).toBeCloseTo(15, 6) // nohome 2 + unresolved 13
    expect(d.headlineUsd).toBeCloseTo(26, 6)
  })

  it('whole company: the billed region axis (engine) moves the mover', async () => {
    const d = await t.db.transaction((tx) =>
      fetchDrivers(tx as unknown as Parameters<typeof fetchDrivers>[0], wholeCompanyUsage, JULY, 'region', 'chargeback'),
    )
    expect(usdOf(d.rows, regionB)).toBeCloseTo(13, 6) // mover 11 + nohome 2
    expect(usdOf(d.rows, regionA)).toBeUndefined()
    expect(usdOf(d.rows, '__null_region')).toBeCloseTo(13, 6)
    expect(d.headlineUsd).toBeCloseTo(26, 6)
  })

  it('the tier-exposure card is clamped on the current placement too', async () => {
    const b = (await behaviourHandler(ev(adminB(), MONTH))) as unknown as {
      exposure: { providers: { provider: string; bandedSpendUsd: number; unbandedSpendUsd: number }[] }
    }
    const anthropic = b.exposure.providers.find((p) => p.provider === 'anthropic')!
    expect(anthropic.bandedSpendUsd + anthropic.unbandedSpendUsd).toBeCloseTo(13, 6)
    const a = (await behaviourHandler(ev(adminA(), MONTH))) as unknown as typeof b
    const anthropicA = a.exposure.providers.find((p) => p.provider === 'anthropic')!
    expect(anthropicA.bandedSpendUsd + anthropicA.unbandedSpendUsd).toBeCloseTo(0, 6)
  })
})

describe('the views — no invented homes, no-teammate rows keep their stamps', () => {
  it('a person under a unit with no cost-owning ancestor has a NULL Business Unit', async () => {
    const rows = await t.client<{ cou: string | null }[]>`
      SELECT cost_owning_unit_id::text AS cou FROM v_complete_usage_current WHERE teammate_id = ${nohome}::uuid
      UNION ALL
      SELECT cost_owning_unit_id::text FROM v_usage_rollup_current WHERE teammate_id = ${nohome}::uuid
      UNION ALL
      SELECT cost_owning_unit_id::text FROM v_provider_usage_fact_current WHERE teammate_id = ${nohome}::uuid`
    expect(rows.length).toBe(3)
    for (const r of rows) expect(r.cou).toBeNull()
  })

  it('the §B bill views keep an unhomed person in the region they sit in', async () => {
    for (const view of ['v_finance_bill_chargeback', 'v_finance_bill_showback']) {
      const rows = await t.client<{ region: string | null; cou: string | null; usd: string }[]>`
        SELECT region_id::text AS region, cost_owning_unit_id::text AS cou, SUM(bill_usd)::text AS usd
        FROM ${t.client(view)} WHERE teammate_id = ${nohome}::uuid GROUP BY 1, 2`
      expect(rows, view).toEqual([{ region: regionB, cou: null, usd: '3.000000' }])
    }
  })

  it('arm by arm: tagged keeps the project unit, api-reconciled stays NULL, provider-usage moves', async () => {
    const rows = await t.client<{ prov: string; project: string | null; cou: string | null; region: string }[]>`
      SELECT usage_provenance AS prov, project_id::text AS project, cost_owning_unit_id::text AS cou, region_id::text AS region
        FROM v_complete_usage_current WHERE teammate_id = ${mover}::uuid ORDER BY cost_usd`
    expect(rows.every((r) => r.region === regionB)).toBe(true)
    const by = (prov: string, tagged: boolean) => rows.find((r) => r.prov === prov && (r.project !== null) === tagged)
    expect(by('otel-emitted', true)!.cou).toBe(unitX)
    expect(by('otel-emitted', false)!.cou).toBeNull()
    expect(by('api-reconciled', false)!.cou).toBeNull()
    expect(by('provider-usage', false)!.cou).toBe(unitY)
  })

  it('a billed row with no teammate keeps exactly the homing it was stamped with', async () => {
    await t.client`INSERT INTO provider_usage_fact
        (source, provider, teammate_id, actor_ref, date, tool, model, cost_type, cost_usd, currency, region_id, org_unit_id, cost_owning_unit_id)
      VALUES ('anthropic-analytics-api', 'anthropic', NULL, 'stamped-ghost@x.test', '2026-06-08'::date, 'claude-code', 'm', 'tokens', 1, 'USD',
              ${regionA}::uuid, ${unitX}::uuid, ${unitX}::uuid)`
    const [r] = await t.client<{ region: string; unit: string; cou: string }[]>`
      SELECT region_id::text AS region, org_unit_id::text AS unit, cost_owning_unit_id::text AS cou
        FROM v_provider_usage_fact_current WHERE actor_ref = 'stamped-ghost@x.test'`
    expect(r).toEqual({ region: regionA, unit: unitX, cou: unitX })
  })
})
