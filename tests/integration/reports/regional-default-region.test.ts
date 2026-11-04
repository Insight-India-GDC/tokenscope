// @vitest-environment node
/*
 * THE REGIONAL DEFAULT REGION — decided server-side, from the caller alone.
 *
 * Owner decision: "the default should be the region the user is an admin of. If
 * they are a platform admin, alphabetical is fine. You should never have wrong
 * region under wrong name." Extended 2026-08-01, verbatim: "platform-admin should
 * get alphabetical too, they have no region."
 *
 * mig 0129 made this GRANT-DRIVEN, uniformly: cross-region reach is now ALWAYS an
 * ACTIVE 'operational' report-access grant, never a role. So the rule now splits on
 * whether the grant is HELD, not on where the caller's Entra record sits: a caller
 * holding an active 'operational' grant — region-bound (admin) or org-wide
 * (platform-admin) alike — answers for no single region and opens on
 * the first by (display_name, code) (server/reporting/regional.ts's own comment on
 * `ownRegionId`, which is now `undefined` whenever `isCrossRegion` is true, full
 * stop). The OLD exception — an elevated region admin kept its own region — is
 * gone; an UNGRANTED org-wide role is the new one, clamped to its own region
 * exactly like `admin` (`resolveRegionalScope`'s `isOrgWide && !isCrossRegion`
 * class) rather than by role alone.
 *
 * "Never a wrong region under a wrong name" is the load-bearing sentence, and it is
 * why the rule may not depend on spend, on the window, or on anything else a
 * request carries. FIVE
 * Regional endpoints plus the CSV export resolve this scope INDEPENDENTLY, in
 * separate requests, with no shared state — so a default any of them could
 * compute differently would put one region's name in the page header above
 * another region's figures. `/reporting` used to do exactly that on purpose: the
 * browser ranked the regions by spend after the first response landed and patched
 * the URL, discarding a whole round of answers on the way past.
 *
 * So this suite asserts the rule on RESPONSES, through every path a Regional
 * screen actually calls, for one caller at a time — not on the resolver in
 * isolation, which cannot see an endpoint threading a different caller through.
 *
 * The fixture gives the two regions DIFFERENT totals and DIFFERENT active-user
 * counts, so every endpoint's answer identifies which region it resolved even
 * when the endpoint returns no region object at all (active-trend, seasonality).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'
import { buildUsageRollup, rebuildUsageRollup } from '../helpers/usage-rollup'
import { injectTestSession } from '../../helpers/auth'
import { grantReportAccess } from '../helpers/report-access'
import type { Session } from '../../../server/utils/auth'
import regionalIndex from '../../../server/api/v1/reports/region/index.get'
import regionalDrivers from '../../../server/api/v1/reports/region/drivers.get'
import regionalTrend from '../../../server/api/v1/reports/region/trend.get'
import regionalActiveTrend from '../../../server/api/v1/reports/region/active-trend.get'
import regionalSeasonality from '../../../server/api/v1/reports/region/seasonality.get'
import reportsExport from '../../../server/api/v1/reports/export.get'

let t: TestDb
/** 'Aardvark Region' — first by display_name, and the SMALLER of the two. */
let aardvarkId = ''
/** 'Zebra Region' — last by display_name, and where every caller below lives. */
let zebraId = ''
let aardvarkUnit = ''
let zebraUnit = ''

const MONTH = 'month=2026-07'
/** Σ cost_usd in each region over MONTH — the fingerprint every endpoint carries. */
const AARDVARK_USD = 11
const ZEBRA_USD = 23
/** Distinct active teammates per region — a second, independent fingerprint. */
const AARDVARK_USERS = 1
const ZEBRA_USERS = 2

const ev = (session: Session, query = '') => {
  const url = '/x' + (query ? `?${query}` : '')
  const headers: Record<string, string> = { host: 'localhost:3450', origin: 'http://localhost:3450' }
  const e = {
    method: 'GET',
    path: url,
    context: {},
    node: {
      req: { method: 'GET', url, socket: { remoteAddress: '127.0.0.1' }, get headers() { return { ...headers } } },
      res: { _headers: {} as Record<string, unknown>, statusCode: 200, getHeader() {}, setHeader() {}, removeHeader() {}, appendHeader() {}, get headersSent() { return false } },
    },
  }
  injectTestSession(e as unknown as Parameters<typeof injectTestSession>[0], session)
  return e as unknown as Parameters<typeof regionalIndex>[0]
}

/** Every caller below is HOMED IN ZEBRA — the region that is NOT alphabetically first. */
const sess = (role: string, teammateId: string, orgPath = 'zz'): Session =>
  ({
    teammateId,
    email: `${role}@z.test`,
    displayName: role,
    role,
    regionId: zebraId,
    orgPath,
    issuedAt: new Date().toISOString(),
  }) as unknown as Session

let zebraAdminId = ''
let zebraFinopsId = ''
let zebraPlatformId = ''

async function clearGrants(): Promise<void> {
  await t.client`DELETE FROM report_access_grant`
}

interface RegionRefLike {
  id: string
  code: string
  displayName: string
}
interface IndexResp {
  region: RegionRefLike | null
  regionOptions: RegionRefLike[]
  kpis: { genuineUsd: number }
}
interface DriversResp {
  region: RegionRefLike | null
  headlineUsd: number
  rows: { label: string; usd: number }[]
}
interface TrendResp {
  region: RegionRefLike | null
  series: { value: number }[]
}

/**
 * Resolve the Regional scope through EVERY path a Regional screen calls, for one
 * caller, and report what each one landed on. `names` is what the caller is TOLD
 * the region is; `totals` is what was actually computed underneath it. The
 * invariant is that each collapses to a single value.
 */
async function resolveEverywhere(session: Session, query = MONTH) {
  const index = (await regionalIndex(ev(session, query))) as unknown as IndexResp
  const drivers = (await regionalDrivers(ev(session, query))) as unknown as DriversResp
  const trend = (await regionalTrend(ev(session, query))) as unknown as TrendResp
  const activeTrend = (await regionalActiveTrend(ev(session, query))) as unknown as {
    series: { claudeCode: number }[]
  }
  const seasonality = (await regionalSeasonality(ev(session, query))) as unknown as {
    cells: { value: number }[]
  }
  const csv = (await reportsExport(
    ev(session, `scope=region&report=drivers&${query}`),
  )) as unknown as string

  // `# tokenscope regional drivers · … · scope=<region display name>`
  const csvScope = csv.split('\n')[0]!.split('scope=')[1]!
  const csvTotal = csv
    .split('\n')
    .slice(2)
    .filter((l) => l.trim() !== '')
    .reduce((a, l) => a + Number(l.split(',')[1]), 0)

  return {
    names: [index.region?.displayName, drivers.region?.displayName, trend.region?.displayName, csvScope],
    /*
     * The region CODE each endpoint resolved. `region.code` is UNIQUE (0001_schema),
     * so this identifies the row even when two regions share a display_name — which
     * `names` above, and every heading a user reads, cannot.
     */
    codes: [index.region?.code, drivers.region?.code, trend.region?.code],
    totals: [
      index.kpis.genuineUsd,
      drivers.headlineUsd,
      trend.series.reduce((a, p) => a + p.value, 0),
      seasonality.cells.reduce((a, c) => a + c.value, 0),
      csvTotal,
    ],
    activeUsers: activeTrend.series.reduce((a, p) => a + p.claudeCode, 0),
    regionOptions: index.regionOptions.map((o) => o.displayName),
    driverLabels: drivers.rows.map((r) => r.label),
  }
}

const mkRegion = async (code: string, name: string) => {
  await t.client`INSERT INTO region (code, display_name) VALUES (${code}, ${name})`
  const [r] = await t.client<{ id: string }[]>`SELECT id::text AS id FROM region WHERE code=${code}`
  return r!.id
}

const mkUnit = async (regionId: string, path: string, code: string, name: string) => {
  await t.client`INSERT INTO org_unit (region_id, path, code, display_name, unit_type, is_cost_owning_unit)
    VALUES (${regionId}::uuid, ${path}::ltree, ${code}, ${name}, 'bu', true)`
  const [r] = await t.client<{ id: string }[]>`SELECT id::text AS id FROM org_unit WHERE code=${code}`
  return r!.id
}

const mkTeammate = async (oid: string, email: string, name: string, regionId: string, unitId: string) => {
  await t.client`INSERT INTO teammate (entra_oid, email, display_name, region_id, org_unit_id, is_active)
    VALUES (${oid}, ${email}, ${name}, ${regionId}::uuid, ${unitId}::uuid, true)`
  const [r] = await t.client<{ id: string }[]>`SELECT id::text AS id FROM teammate WHERE email=${email}`
  return r!.id
}

const mkProject = async (code: string, name: string, regionId: string, unitId: string) => {
  await t.client`INSERT INTO project (code, code_hash, display_name, type, region_id, cost_owning_unit_id)
    VALUES (${code}, ${'h-' + code}, ${name}, 'billable', ${regionId}::uuid, ${unitId}::uuid)`
  const [r] = await t.client<{ id: string }[]>`SELECT id::text AS id FROM project WHERE code=${code}`
  return r!.id
}

const spend = async (teammateId: string, regionId: string, unitId: string, projectId: string, usd: number) => {
  await t.client`INSERT INTO instance_attestation (instance_id, principal_oid, teammate_id, tool, region_id, org_unit_id, project_code_hash, raw_project_code)
    VALUES (gen_random_uuid(), 'p', ${teammateId}::uuid, 'claude-code', ${regionId}::uuid, ${unitId}::uuid, 'h', 'P')`
  const [inst] = await t.client<{ id: string }[]>`SELECT instance_id::text AS id FROM instance_attestation WHERE teammate_id=${teammateId}::uuid LIMIT 1`
  await t.client`INSERT INTO attribution_record
      (instance_id, teammate_id, region_id, org_unit_id, cost_owning_unit_id, project_id, tool, model, token_type, tokens, cost_usd, fidelity_tier, cost_basis, ts_event, claude_session_id)
    VALUES (${inst!.id}::uuid, ${teammateId}::uuid, ${regionId}::uuid, ${unitId}::uuid, ${unitId}::uuid, ${projectId}::uuid, 'claude-code', 'claude-sonnet-4-6', 'input', 100, ${usd}, 'tier-1', 'estimated', '2026-07-02T00:00:00Z'::timestamptz, ${'c-' + teammateId})`
}

beforeAll(async () => {
  t = await startTestDb()
  process.env.DATABASE_URL = t.url

  // Inserted Zebra FIRST so nothing about the answer can come from insert order.
  zebraId = await mkRegion('drz', 'Zebra Region')
  aardvarkId = await mkRegion('dra', 'Aardvark Region')

  zebraUnit = await mkUnit(zebraId, 'zz', 'zz', 'Zebra BU')
  aardvarkUnit = await mkUnit(aardvarkId, 'aa', 'aa', 'Aardvark BU')

  const ann = await mkTeammate('oid-ann', 'ann@a.test', 'Ann', aardvarkId, aardvarkUnit)
  const zoe = await mkTeammate('oid-zoe', 'zoe@z.test', 'Zoe', zebraId, zebraUnit)
  const zack = await mkTeammate('oid-zack', 'zack@z.test', 'Zack', zebraId, zebraUnit)
  // The three CALLERS are real teammates too — resolveReportGrants looks their
  // cost-centre ownership up by teammate_id.
  zebraAdminId = await mkTeammate('oid-adm', 'admin@z.test', 'Zed Admin', zebraId, zebraUnit)
  zebraFinopsId = await mkTeammate('oid-gfo', 'zoe.orgwide@z.test', 'Zoe Finops', zebraId, zebraUnit)
  zebraPlatformId = await mkTeammate('oid-pa', 'platform-admin@z.test', 'Pat Admin', zebraId, zebraUnit)

  const projA = await mkProject('PROJ-A', 'Project Aardvark', aardvarkId, aardvarkUnit)
  const projZ = await mkProject('PROJ-Z', 'Project Zebra', zebraId, zebraUnit)

  // Aardvark: ONE teammate, $11. Zebra: TWO teammates, $23. Both fingerprints
  // differ, so no endpoint's answer is ambiguous about which region it resolved.
  await spend(ann, aardvarkId, aardvarkUnit, projA, AARDVARK_USD)
  await spend(zoe, zebraId, zebraUnit, projZ, 13)
  await spend(zack, zebraId, zebraUnit, projZ, 10)
  // The region reports' §A reads come from usage_rollup_daily (usage-rollup-
  // lane.md R5/R8): materialise it from the seeds above via the real worker.
  await buildUsageRollup(t.db)
}, 180_000)

afterAll(async () => {
  await stopTestDb(t)
})

describe('a caller who names NO region: region admin → own region; org-wide → alphabetical by role', () => {
  it('a region admin gets their own region — and no picker to get it wrong with', async () => {
    // A region admin is REGION-BOUND (unchanged): own region, no cross-region
    // picker. Only the org-wide roles open on the alphabetical default by role.
    await clearGrants()
    const r = await resolveEverywhere(sess('admin', zebraAdminId))
    expect(new Set(r.names)).toEqual(new Set(['Zebra Region']))
    expect(new Set(r.totals)).toEqual(new Set([ZEBRA_USD]))
    expect(r.regionOptions).toEqual([])
  })

  it('an admin GRANTED operational now opens on the alphabetical-first region too', async () => {
    // mig 0129 removed the old exception: cross-region reach is now ALWAYS an
    // active 'operational' grant, and EVERY caller it admits — region-bound or
    // org-wide alike — opens on `regionOptions[0]`. An admin who used to keep
    // their own region under the retired 'region-admins-see-all' mode now lands
    // on 'Aardvark Region' exactly like an org-wide grantee.
    await clearGrants()
    await grantReportAccess(t.client, zebraAdminId, 'operational')
    try {
      const r = await resolveEverywhere(sess('admin', zebraAdminId))
      expect(new Set(r.names)).toEqual(new Set(['Aardvark Region']))
      expect(new Set(r.totals)).toEqual(new Set([AARDVARK_USD]))
      expect(r.regionOptions).toEqual(['Aardvark Region', 'Zebra Region'])
    } finally {
      await clearGrants()
    }
  })

  it('global finance, GRANTED operational, gets the first by display name', async () => {
    // Homed in Zebra like every caller here, and that home is deliberately IGNORED
    // once cross-region reach is held. Zebra is what "own region" would have given,
    // so the assertion tells the two apart.
    await clearGrants()
    await grantReportAccess(t.client, zebraFinopsId, 'operational')
    try {
      const r = await resolveEverywhere(sess('platform-admin', zebraFinopsId))
      expect(new Set(r.names)).toEqual(new Set(['Aardvark Region']))
      expect(new Set(r.totals)).toEqual(new Set([AARDVARK_USD]))
      expect(r.regionOptions).toEqual(['Aardvark Region', 'Zebra Region'])
    } finally {
      await clearGrants()
    }
  })

  it('a platform admin, GRANTED operational, gets the same first-by-display-name', async () => {
    await clearGrants()
    await grantReportAccess(t.client, zebraPlatformId, 'operational')
    try {
      const r = await resolveEverywhere(sess('platform-admin', zebraPlatformId))
      expect(new Set(r.names)).toEqual(new Set(['Aardvark Region']))
      expect(new Set(r.totals)).toEqual(new Set([AARDVARK_USD]))
      expect(r.regionOptions).toEqual(['Aardvark Region', 'Zebra Region'])
    } finally {
      await clearGrants()
    }
  })

  it('an org-wide role (platform-admin), NO grant, opens alphabetical-first by ROLE', async () => {
    // Role default: full cross-region reach with no grant. Both open on Aardvark
    // (regionOptions[0]) with the full picker — the reverse of #251's clamp.
    await clearGrants()
    const gfo = await resolveEverywhere(sess('platform-admin', zebraFinopsId))
    expect(new Set(gfo.names)).toEqual(new Set(['Aardvark Region']))
    expect(new Set(gfo.totals)).toEqual(new Set([AARDVARK_USD]))
    expect(gfo.regionOptions).toEqual(['Aardvark Region', 'Zebra Region'])

    const pa = await resolveEverywhere(sess('platform-admin', zebraPlatformId))
    expect(new Set(pa.names)).toEqual(new Set(['Aardvark Region']))
    expect(new Set(pa.totals)).toEqual(new Set([AARDVARK_USD]))
    expect(pa.regionOptions).toEqual(['Aardvark Region', 'Zebra Region'])
  })
})

describe('a named ?region still wins — the default is a default, not a clamp', () => {
  it('global finance, GRANTED operational, can open a region other than the default', async () => {
    // Zebra, NOT Aardvark: Aardvark is now this caller's default, so naming it
    // would prove nothing about `?region` being honoured. The grant is load-bearing
    // here too — an UNGRANTED org-wide caller has `?region=` ignored outright
    // (resolveRegionalScope's non-cross-region branch never reads `params.region`).
    await clearGrants()
    await grantReportAccess(t.client, zebraFinopsId, 'operational')
    try {
      const r = await resolveEverywhere(sess('platform-admin', zebraFinopsId), `${MONTH}&region=${zebraId}`)
      expect(new Set(r.names)).toEqual(new Set(['Zebra Region']))
      expect(new Set(r.totals)).toEqual(new Set([ZEBRA_USD]))
    } finally {
      await clearGrants()
    }
  })

  it('a platform admin, GRANTED operational, can open a region other than the alphabetically-first', async () => {
    await clearGrants()
    await grantReportAccess(t.client, zebraPlatformId, 'operational')
    try {
      const r = await resolveEverywhere(sess('platform-admin', zebraPlatformId), `${MONTH}&region=${zebraId}`)
      expect(new Set(r.names)).toEqual(new Set(['Zebra Region']))
      expect(new Set(r.totals)).toEqual(new Set([ZEBRA_USD]))
    } finally {
      await clearGrants()
    }
  })
})

describe('never a wrong region under a wrong name', () => {
  /*
   * The one invariant the whole rule exists for. Each endpoint resolves the scope
   * on its own; nothing reconciles them afterwards. So for a single caller with a
   * single query, the region NAMED (index header, drivers header, trend header,
   * CSV header line) and the region COMPUTED (KPI genuine, drivers headline,
   * trend series, seasonality cells, CSV rows) must collapse to one region.
   */
  const CASES: {
    who: string
    role: string
    teammate: () => string
    grant: boolean
    region: string
    usd: number
    users: number
  }[] = [
    // Three OPERATIONAL-GRANTED callers, one region-bound and two org-wide — all
    // land on the SAME alphabetical default, proving the rule no longer varies
    // with role once the grant is held.
    { who: 'global finance (operational-granted)', role: 'platform-admin', teammate: () => zebraFinopsId, grant: true, region: 'Aardvark Region', usd: AARDVARK_USD, users: AARDVARK_USERS },
    { who: 'a platform admin (operational-granted)', role: 'platform-admin', teammate: () => zebraPlatformId, grant: true, region: 'Aardvark Region', usd: AARDVARK_USD, users: AARDVARK_USERS },
    { who: 'an operational-granted region admin', role: 'admin', teammate: () => zebraAdminId, grant: true, region: 'Aardvark Region', usd: AARDVARK_USD, users: AARDVARK_USERS },
    // NO grant at all — and post-2026-08-13 that resolves the SAME as granted:
    // an org-wide role has full cross-region reach BY ROLE, so it lands on the
    // alphabetical default too.
    { who: 'an UNGRANTED global finance — alphabetical by role', role: 'platform-admin', teammate: () => zebraFinopsId, grant: false, region: 'Aardvark Region', usd: AARDVARK_USD, users: AARDVARK_USERS },
  ]

  it.each(CASES)(
    '$who: every Regional endpoint resolves the SAME default',
    async ({ role, teammate, grant, region, usd, users }) => {
      await clearGrants()
      if (grant) await grantReportAccess(t.client, teammate(), 'operational')
      try {
        const r = await resolveEverywhere(sess(role, teammate()))

        // Four independently-produced names, one region.
        expect(r.names).toHaveLength(4)
        expect(new Set(r.names)).toEqual(new Set([region]))
        // Five independently-produced totals, one region's money.
        expect(r.totals).toHaveLength(5)
        expect(new Set(r.totals)).toEqual(new Set([usd]))
        // Endpoints that return NO region object are pinned by their own figures.
        expect(r.activeUsers).toBe(users)
        // …and the drivers rows name that region's project, not the other's.
        expect(r.driverLabels).toEqual([region === 'Zebra Region' ? 'Project Zebra' : 'Project Aardvark'])
      } finally {
        await clearGrants()
      }
    },
  )

  it('holds for a NAMED region too, not just the default', async () => {
    await clearGrants()
    await grantReportAccess(t.client, zebraPlatformId, 'operational')
    try {
      const r = await resolveEverywhere(
        sess('platform-admin', zebraPlatformId),
        `${MONTH}&region=${zebraId}`,
      )
      expect(new Set(r.names)).toEqual(new Set(['Zebra Region']))
      expect(new Set(r.totals)).toEqual(new Set([ZEBRA_USD]))
      expect(r.activeUsers).toBe(ZEBRA_USERS)
    } finally {
      await clearGrants()
    }
  })
})

/*
 * TWO REGIONS, ONE NAME.
 *
 * `region.display_name` carries no unique constraint — only `region.code` does
 * (0001_schema.sql). So `ORDER BY display_name` is a PARTIAL order, and the
 * platform-admin default is its first row. Postgres does not promise which of two
 * equal-keyed rows sorts first, and in practice it follows the physical scan order,
 * which MOVES when a row is rewritten. Two identical requests can then land on
 * different regions under the same heading — "wrong region under a wrong name",
 * arrived at without a single wrong line of report logic.
 *
 * These regions are seeded HERE rather than in the file's own beforeAll, because
 * they sort ahead of 'Aardvark Region' and would change the platform-admin default
 * every describe above asserts on.
 */
describe('two regions sharing a display name still resolve to ONE region', () => {
  const TWIN_NAME = 'Aaa Twin Region'
  /** The twin that (display_name, code) selects. Inserted FIRST, then displaced. */
  const TWIN_A_USD = 7
  /** The twin that only the physical scan order could select. */
  const TWIN_B_USD = 5

  beforeAll(async () => {
    // Every test in this block reads the platform-admin's CROSS-REGION default,
    // which mig 0129 makes grant-driven — hold the grant for the rest of the file
    // (the earlier describes each clean up their own via clearGrants()).
    await grantReportAccess(t.client, zebraPlatformId, 'operational')
    const twinA = await mkRegion('dt-a', TWIN_NAME)
    const twinB = await mkRegion('dt-b', TWIN_NAME)
    const unitA = await mkUnit(twinA, 'ta', 'ta', 'Twin A BU')
    const unitB = await mkUnit(twinB, 'tb', 'tb', 'Twin B BU')
    const tomA = await mkTeammate('oid-ta', 'ta@t.test', 'Tam A', twinA, unitA)
    const tomB = await mkTeammate('oid-tb', 'tb@t.test', 'Tam B', twinB, unitB)
    const projTA = await mkProject('PROJ-TA', 'Project Twin A', twinA, unitA)
    const projTB = await mkProject('PROJ-TB', 'Project Twin B', twinB, unitB)
    await spend(tomA, twinA, unitA, projTA, TWIN_A_USD)
    await spend(tomB, twinB, unitB, projTB, TWIN_B_USD)
    // New §A rows after the top-level rollup build — REBUILD so the endpoints'
    // rollup reads see the twins' spend (usage-rollup-lane.md R8).
    await rebuildUsageRollup(t.db)
  })

  /**
   * Resolve the twin default through every Regional path and return the ONE region
   * it collapsed to — asserting the collapse on the way, since a caller shown two
   * different twins across two cards is the failure this whole file is about.
   * Returns the region CODE, because the two twins are indistinguishable by name.
   */
  async function resolvedTwin(): Promise<string> {
    const r = await resolveEverywhere(sess('platform-admin', zebraPlatformId))
    // Same name from all four headings — true of BOTH twins, which is the point.
    expect(new Set(r.names)).toEqual(new Set([TWIN_NAME]))
    // The codes and the money say WHICH twin, and must agree across the five
    // independently-resolved endpoints.
    expect(r.codes).toHaveLength(3)
    expect(new Set(r.codes).size).toBe(1)
    expect(r.totals).toHaveLength(5)
    expect(new Set(r.totals).size).toBe(1)
    const code = r.codes[0]!
    // The money and the drivers rows must belong to the region that was NAMED.
    expect(r.totals[0]).toBe(code === 'dt-a' ? TWIN_A_USD : TWIN_B_USD)
    expect(r.driverLabels).toEqual([code === 'dt-a' ? 'Project Twin A' : 'Project Twin B'])
    return code
  }

  it('resolves to the (display_name, code) first row however the heap is ordered', async () => {
    /*
     * Six resolutions, with the two rows physically reordered between them. Each
     * UPDATE leaves the DATA identical — same name, same code, same spend — and
     * writes a new tuple version at the end of the page, so a scan returns the
     * twins in the other order. That is the ONLY input that changes.
     *
     * An untied `ORDER BY display_name` has nothing else to go on and follows
     * whatever the executor hands it; a total order does not notice. So the
     * assertion is both halves at once — the SAME twin every time, and the twin the
     * data says: 'dt-a' is first by (display_name, code), and `code` is UNIQUE NOT
     * NULL, so that is reproducible from the table alone.
     *
     * Not hypothetical: any write to a region row (a rename, a seed re-run) moves
     * it in the heap, under a live page whose header names one region and whose
     * figures come from five separate requests.
     */
    const answers: string[] = []
    for (const rewrite of ['dt-a', 'dt-b', 'dt-a', 'dt-b', 'dt-a']) {
      answers.push(await resolvedTwin())
      await t.client`UPDATE region SET display_name = ${TWIN_NAME} WHERE code = ${rewrite}`
    }
    answers.push(await resolvedTwin())

    expect(answers).toEqual(['dt-a', 'dt-a', 'dt-a', 'dt-a', 'dt-a', 'dt-a'])
  })

  it('offers the picker both twins — the tiebreaker orders them, it does not hide one', async () => {
    const index = (await regionalIndex(
      ev(sess('platform-admin', zebraPlatformId), MONTH),
    )) as unknown as IndexResp
    expect(index.regionOptions.map((o) => o.code)).toEqual(['dt-a', 'dt-b', 'dra', 'drz'])
  })
})
