// @vitest-environment node
/*
 * GET /api/v1/admin/diagnostics/ab-decomposition — the operator surface for the
 * Workstream A gate.
 *
 * The route is what makes the gate's MAGNITUDE half answerable at all: the
 * decomposition's correctness is provable locally against synthesised data, but
 * "do non-Code surfaces actually dominate?" is a question about production
 * numbers, and nobody can run SQL against Dev. So the verdict this route
 * computes is load-bearing — a wrong verdict would green-light (or block)
 * Workstream A on a false reading.
 *
 * The sibling attribution-gaps route exists because a mutation sweep found every
 * one of its lines deletable with the suite green, `requireRole` included. Same
 * exposure applies here, so RBAC is asserted directly rather than assumed.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'
import { seedKnownOutcomeCompany, seedAbDecompositionPlantings } from '../helpers/known-outcome-fixture'
import { injectTestSession } from '../../helpers/auth'
import type { Session } from '../../../server/utils/auth'
import handler, { classifyDecomposition } from '../../../server/api/v1/admin/diagnostics/ab-decomposition.get'
import type { AbDecompositionResult } from '../../../server/usage/ab-decomposition'
import {
  AB_DECOMPOSITION_TERMS,
  type AbDecompositionTermName,
} from '../../../shared/usage/ab-decomposition-terms'
import {
  REPORT_VISIBILITY_PERSONAS,
  baselineGrants,
  grantsToScopes,
} from '../../../shared/auth/report-visibility'

let t: TestDb
let regionId: string
let adminId: string

function ev(opts: { session: Session; query?: Record<string, string> }) {
  const qs = opts.query ? `?${new URLSearchParams(opts.query).toString()}` : ''
  const path = `/api/v1/admin/diagnostics/ab-decomposition${qs}`
  const headers: Record<string, string> = {}
  const e = {
    // h3's getQuery reads event.path, NOT node.req.url — a mock without it
    // silently yields an empty query, so every param test would pass vacuously.
    path,
    node: {
      req: {
        method: 'GET',
        url: path,
        socket: { remoteAddress: '127.0.0.1' },
        get headers() {
          return { ...headers, 'content-type': 'application/json' }
        },
      },
      res: {
        _headers: {} as Record<string, string | string[]>,
        statusCode: 200,
        getHeader(n: string) { return this._headers[n.toLowerCase()] },
        setHeader(n: string, v: string | string[]) { this._headers[n.toLowerCase()] = v },
        removeHeader(n: string) { this._headers[n.toLowerCase()] = '' },
        appendHeader(n: string, v: string | string[]) { this._headers[n.toLowerCase()] = v },
        get headersSent() { return false },
      },
    },
  }
  injectTestSession(e as unknown as Parameters<typeof injectTestSession>[0], opts.session)
  return e as unknown as Parameters<typeof handler>[0]
}

const sess = (role: Session['role'], teammateId: string): Session => ({
  teammateId,
  email: `abd-${role}@x.test`,
  displayName: role,
  role,
  regionId,
  orgPath: 'apac',
})

beforeAll(async () => {
  t = await startTestDb()
  process.env.DATABASE_URL = t.url
  const ids = await seedKnownOutcomeCompany(t)
  await seedAbDecompositionPlantings(t, ids)
  regionId = ids.regionApac
  adminId = ids.alice
}, 180_000)

afterAll(async () => {
  await stopTestDb(t)
})

describe('GET /admin/diagnostics/ab-decomposition', () => {
  it('returns every named term, a zero residual, and the computed dominance verdict', async () => {
    const res = (await handler(
      ev({ session: sess('platform-admin', adminId), query: { from: '2026-05' } }),
    )) as {
      reachable: boolean
      delta: string
      residual: string
      terms: Record<string, string>
      termOrder: string[]
      verdict: string
      nonCodeShareOfExplained: number
      window: { startIso: string; endIso: string }
    }

    expect(res.reachable).toBe(true)
    // NEGATIVE post-cutover (mig 0101, A3): arm 3 makes §A exceed §B for these
    // lanes for the first time on this fixture — see
    // tests/integration/usage/ab-decomposition.test.ts for the full worked
    // arithmetic (sectionA 1148 -> 1379, delta 193 -> -38).
    expect(res.delta).toBe('-38.000000')
    expect(res.residual).toBe('0.000000')
    // Pinned to the shared const, not to a literal: the count is not the point,
    // the agreement between the wire order and the const is.
    expect(res.termOrder).toEqual([...AB_DECOMPOSITION_TERMS])
    // Both ZERO post-cutover — the two terms this gate exists to close are
    // closed: arm 3 covers the non-Code surfaces and the coding-agent lane
    // exactly (see the independent diagnostics pins in the ab-decomposition
    // unit test for the absence/double-count alarm this doesn't by itself rule
    // out).
    expect(res.terms.nonCodeSurfaces).toBe('0.000000')
    expect(res.terms.licenceLanes).toBe('40.000000')
    expect(res.terms.copilotAgentUsage).toBe('0.000000')
    // UNCHANGED across the cutover (self-correcting algebra — see
    // ab-decomposition.ts's residual-preserving-algebra note).
    expect(res.terms.copilotUsageGap).toBe('-25.000000')
    expect(res.terms.unreconciledApiLag).toBe('23.000000')
    expect(res.terms.unreconciledApiStale).toBe('-11.000000')
    // chargebackExemptUsage widens post-cutover (mig 0101 narrows its exclusion
    // list to match v_teammate_usage_daily's actual_spend-branch exclusion —
    // GITHUB_USAGE_VIEW_TOOLS only), so alice's exempt non-Code row is now named here
    // instead of reaching neither side: -31 (carol, claude-code) + -19 (alice,
    // claude-ai) = -50.
    expect(res.terms.chargebackExemptUsage).toBe('-50.000000')

    /*
     * non-code-does-not-dominate, and that is the CORRECT post-cutover reading,
     * not a regression of the pre-cutover finding. Pre-cutover this fixture read
     * 'non-code-dominates' at 200/357 (56.0%) — the finding that justified
     * building arm 3 (usage-completeness-and-provider-governance.md §1.1, "the
     * gate CLOSED"). Now that arm 3 exists, `nonCodeSurfaces` is $0 (fully
     * covered, see above), so it has nothing left to dominate: absTotal = |40| +
     * |-25| + |-15| + |-50| + |23| + |-11| = 164, nonCodeAbs = 0, share = 0%.
     * A dominance verdict on a term that just closed to zero would be a
     * regression in the OPPOSITE direction — it would mean the fix did not
     * actually cover the lane. `classifyDecomposition`'s ability to return
     * EITHER verdict is what the unit cases below exercise directly, rather
     * than relying on a fixture whose sign is a historical accident.
     */
    expect(res.verdict).toBe('non-code-does-not-dominate')
    expect(res.nonCodeShareOfExplained).toBeCloseTo(0, 6)

    // A single month must resolve to a month-aligned, half-open window.
    expect(res.window.startIso).toBe('2026-05-01T00:00:00.000Z')
    expect(res.window.endIso).toBe('2026-06-01T00:00:00.000Z')
  })

  /*
   * The cause split on the WIRE. The module test proves the arithmetic; this
   * proves the route actually carries it, reconciled, against the SAME unhomed
   * figure the card's existing line renders. A `null` here — the shape a failed
   * sub-probe returns — must never be mistaken for "no causes".
   */
  it('carries the unhomed cause split, reconciled against the figure the card renders', async () => {
    const res = (await handler(
      ev({ session: sess('platform-admin', adminId), query: { from: '2026-05' } }),
    )) as {
      diagnostics: { unhomedChargeUsd: string }
      unhomed: {
        unhomedUsd: string
        residualUsd: string
        reconciles: boolean
        causes: { cause: string; usd: string; placementFailure: boolean }[]
        worklists: { cause: string; bucketUsd: string }[]
        history: { month: string; selected: boolean }[]
        placementConfig: { activeCostOwningUnits: number; unitsWithCostCentreCode: number }
      } | null
      unhomedError: string | null
    }

    expect(res.unhomedError).toBeNull()
    expect(res.unhomed).not.toBeNull()
    const u = res.unhomed!

    // ONE DEFINITION: the split decomposes the figure already on the card, not a
    // second one defined somewhere else. (Two STATEMENTS, though — see the
    // probe's ONE DEFINITION, TWO STATEMENTS header. What this pins is that they
    // agree on a quiescent estate, which is all a test database can show.)
    expect(u.unhomedUsd).toBe(res.diagnostics.unhomedChargeUsd)
    expect(u.unhomedUsd).toBe('17.000000')
    expect(u.residualUsd).toBe('0.000000')
    expect(u.reconciles).toBe(true)

    // This fixture's only unhomed money is erin's, on a unit with no cost-owning
    // ancestor — so exactly one bucket carries it and the other three are zero.
    // (The all-four-causes fixture lives in the module suite.)
    const by = Object.fromEntries(u.causes.map((c) => [c.cause, c.usd]))
    expect(by['no-cost-owning-ancestor']).toBe('17.000000')
    expect(by['no-region']).toBe('0.000000')
    expect(by['region-no-unit']).toBe('0.000000')
    expect(by['pooled-copilot']).toBe('0.000000')
    // The pooled cause is not a placement failure and must not read as one.
    expect(u.causes.find((c) => c.cause === 'pooled-copilot')!.placementFailure).toBe(false)

    // The counters answer "can automatic placement work at all" — and on this
    // fixture the answer is the live instance's: units exist, none has a code.
    expect(u.placementConfig.activeCostOwningUnits).toBe(5)
    expect(u.placementConfig.unitsWithCostCentreCode).toBe(0)

    // Six complete months, newest first, with the selected month in the series.
    expect(u.history).toHaveLength(6)
    expect(u.history[0]!.month).toBe('2026-05')
    expect(u.history.filter((h) => h.selected).map((h) => h.month)).toEqual(['2026-05'])
  })

  /*
   * THE TREND'S ANCHOR, on a RANGE. The route passes `to` — the newest month in
   * view — so the selected month is always the newest in the series. Every other
   * case in this file queries a single month, where `from === to` and passing
   * either reads identically: the mutation was invisible until a range was asked
   * for. A `from`-anchored trend would end three months before the window does
   * and mark a month the operator is not looking at.
   */
  it('anchors the trend on the LAST month of a range, not the first', async () => {
    const res = (await handler(
      ev({ session: sess('platform-admin', adminId), query: { from: '2026-02', to: '2026-05' } }),
    )) as { unhomed: { history: { month: string; selected: boolean }[] } | null }

    expect(res.unhomed).not.toBeNull()
    const months = res.unhomed!.history.map((h) => h.month)
    expect(months).toEqual(['2026-05', '2026-04', '2026-03', '2026-02', '2026-01', '2025-12'])
    expect(res.unhomed!.history.filter((h) => h.selected).map((h) => h.month)).toEqual(['2026-05'])
  })

  /*
   * THE SUB-PROBE'S FAILURE PATH — the branch the route's dedicated try/catch
   * exists for, and which nothing exercised.
   *
   * The contract is CONTAINMENT: a split that cannot be computed must blank that
   * section ALONE, say why, and leave the decomposition above it — including the
   * unhomed total the split decomposes — untouched. A `null` here must never be
   * readable as "no causes", so the error field is what tells the panel to render
   * "No reading" instead of four plausible zeros.
   *
   * Failure is induced by renaming `provider_org`, which ONLY the split reads
   * (its pooled drill joins it for the organisation name). Deliberately not a
   * module mock: a mock proves the catch block runs, while this proves the
   * failure is genuinely contained — computeAbDecomposition reads neither
   * `provider_org` nor any view over it, so the assertions below would fail if
   * the two probes shared more than the route pretends.
   */
  it('blanks ONLY the cause split when its sub-probe fails, and says why', async () => {
    await t.client.unsafe('ALTER TABLE provider_org RENAME TO provider_org_hidden')
    let res: {
      reachable: boolean
      residual: string
      diagnostics: { unhomedChargeUsd: string }
      unhomed: unknown
      unhomedError: string | null
      unhomedErrorCorrelationId: string | null
      unhomedWorklistCap: number
    }
    try {
      res = (await handler(
        ev({ session: sess('platform-admin', adminId), query: { from: '2026-05' } }),
      )) as typeof res
    } finally {
      await t.client.unsafe('ALTER TABLE provider_org_hidden RENAME TO provider_org')
    }

    // The split is absent AND says so — null with a null error would read as
    // "we looked and there are no causes".
    expect(res.unhomed).toBeNull()
    expect(res.unhomedError).not.toBeNull()
    expect(typeof res.unhomedError).toBe('string')
    // A correlation id, so the raw cause is recoverable from the logs without
    // putting a provider error string on an admin surface.
    expect(res.unhomedErrorCorrelationId).not.toBeNull()
    // The classified reason must not leak the raw SQL error.
    expect(res.unhomedError).not.toContain('provider_org')

    // …and the decomposition it sits inside is UNAFFECTED: still reachable, still
    // reconciled, still carrying the very figure the split decomposes.
    expect(res.reachable).toBe(true)
    expect(res.residual).toBe('0.000000')
    expect(res.diagnostics.unhomedChargeUsd).toBe('17.000000')
    // The cap is a route constant, not part of the probe, so it still ships —
    // the panel can disclose it even when there is nothing to disclose it for.
    expect(res.unhomedWorklistCap).toBeGreaterThan(0)

    // Guard the guard: the rename was undone, so no later assertion is measuring
    // a mutated schema.
    const healed = (await handler(
      ev({ session: sess('platform-admin', adminId), query: { from: '2026-05' } }),
    )) as { unhomed: unknown; unhomedError: string | null }
    expect(healed.unhomedError).toBeNull()
    expect(healed.unhomed).not.toBeNull()
  })

  /*
   * AC-5 / PB-2 (mig 0129 successor): the BASELINE column only — the
   * three-mode matrix /admin/policies/report-visibility used to render is
   * retired along with the table it read. What matters is that the card
   * resolves grants LIVE from the same primitive enforcement uses
   * (`baselineGrants`), so an operator reasons against the SAME floor every
   * caller starts from, plus `elevated` — the ONE live fact this probe adds:
   * how many teammates currently hold an ACTIVE grant, counted with the same
   * active predicate `resolveReportPermissions` uses.
   */
  it('resolves the BASELINE grants per persona from the same primitive enforcement uses', async () => {
    type VisRes = {
      visibility: {
        personas: { key: string; label: string; scopes: string[] }[]
        elevated: { teammates: number; operational: number; finance: number }
      }
    }
    const res = (await handler(
      ev({ session: sess('platform-admin', adminId), query: { from: '2026-05' } }),
    )) as VisRes

    expect(res.visibility.personas.map((p) => p.key)).toEqual(
      REPORT_VISIBILITY_PERSONAS.map((p) => p.key),
    )
    // Rendered from `baselineGrants`, not from a second table invented for this
    // card — so the preview and the gate cannot drift.
    for (const p of res.visibility.personas) {
      const def = REPORT_VISIBILITY_PERSONAS.find((x) => x.key === p.key)!
      expect(p.scopes).toEqual(grantsToScopes(baselineGrants(def.role, def.ownsCostCentre)))
    }
    // BASELINE — no grant needed. A cost-centre owner sees only what they own;
    // the two ORG-WIDE roles (platform-admin) see the WHOLE
    // COMPANY by role (PO decision 2026-08-13, reversing #251 for these roles —
    // their `own-region` floor was degenerate and stranded admins on an empty
    // report shell).
    expect(res.visibility.personas.find((p) => p.key === 'cost-centre-owner')!.scopes).not.toContain(
      'Business Units (all)',
    )
    const gfoScopes = res.visibility.personas.find((p) => p.key === 'platform-admin')!.scopes
    expect(gfoScopes).toContain('Region (all regions + every region)')
    expect(gfoScopes).toContain('Business Units (all)')
    expect(gfoScopes).toContain('Finance (whole company)')
    // …and this is BASELINE, with NO active grant seeded on the fixture: the
    // access above is by ROLE, which is exactly what `elevated: 0/0/0` proves.
    expect(res.visibility.elevated).toEqual({ teammates: 0, operational: 0, finance: 0 })
  })

  it('elevated counts ACTIVE grants live — the one fact baselineGrants cannot show', async () => {
    await t.client`INSERT INTO report_access_grant (teammate_id, permission, granted_by)
      VALUES (${adminId}::uuid, 'operational', NULL), (${adminId}::uuid, 'finance', NULL)`
    try {
      const res = (await handler(
        ev({ session: sess('platform-admin', adminId), query: { from: '2026-05' } }),
      )) as { visibility: { elevated: { teammates: number; operational: number; finance: number } } }
      expect(res.visibility.elevated).toEqual({ teammates: 1, operational: 1, finance: 1 })
    } finally {
      await t.client`DELETE FROM report_access_grant WHERE teammate_id = ${adminId}::uuid`
    }
  })

  it('rolls a from..to range up to the exclusive end of the LAST month', async () => {
    const res = (await handler(
      ev({ session: sess('platform-admin', adminId), query: { from: '2026-05', to: '2026-06' } }),
    )) as { window: { startIso: string; endIso: string }; residual: string }

    expect(res.window.startIso).toBe('2026-05-01T00:00:00.000Z')
    expect(res.window.endIso).toBe('2026-07-01T00:00:00.000Z')
    // Widening the window must not break exhaustiveness.
    expect(res.residual).toBe('0.000000')
  })

  // A PAST December, deliberately: a future anchor is rejected now (a month that
  // has not happened cannot be reported as having billed nothing), so the month-13
  // arithmetic has to be exercised on a December that is actually behind us. That
  // also puts the year rollover under test, which the future-dated version never did.
  it('rolls December to the following January, not month 13', async () => {
    const res = (await handler(
      ev({ session: sess('platform-admin', adminId), query: { from: '2025-12' } }),
    )) as { window: { endIso: string } }
    expect(res.window.endIso).toBe('2026-01-01T00:00:00.000Z')
  })

  it('allows platform-admin', async () => {
    const res = (await handler(
      ev({ session: sess('platform-admin', adminId), query: { from: '2026-05' } }),
    )) as { reachable: boolean }
    expect(res.reachable).toBe(true)
  })

  it('denies a REGION admin, who would otherwise read every region', async () => {
    /*
     * This endpoint cannot be region-scoped: §B's Copilot arm is a per-org pooled
     * invoice with no region, so filtering by region drops those lanes from §B
     * while §A keeps its rows and the residual goes non-zero for a reason that is
     * an artefact of the filter.
     *
     * That is a fact about the DATA, not a reason to widen who may read it. An
     * earlier version admitted `admin` and explained the cross-region exposure in
     * a comment, as though explaining it made it acceptable. When the shape of the
     * data conflicts with the scope of a role, the role loses.
     */
    await expect(
      handler(ev({ session: sess('admin', adminId), query: { from: '2026-05' } })),
    ).rejects.toMatchObject({ statusCode: 403 })
  })

  it('denies a developer', async () => {
    await expect(
      handler(ev({ session: sess('developer', adminId), query: { from: '2026-05' } })),
    ).rejects.toMatchObject({ statusCode: 403 })
  })

  it('rejects a non-month-aligned window rather than returning a wrong number', async () => {
    // §A filters on a timestamptz and §B on a month-grained date, so a partial
    // month counts a whole month of §B against part of §A. A confidently wrong
    // residual is worse than a 400.
    await expect(
      handler(ev({ session: sess('platform-admin', adminId), query: { from: '2026-05-15' } })),
    ).rejects.toMatchObject({ statusCode: 400 })
  })

  it('rejects an inverted range', async () => {
    await expect(
      handler(ev({ session: sess('platform-admin', adminId), query: { from: '2026-06', to: '2026-05' } })),
    ).rejects.toMatchObject({ statusCode: 400 })
  })

  it('requires the from parameter', async () => {
    await expect(
      handler(ev({ session: sess('platform-admin', adminId) })),
    ).rejects.toMatchObject({ statusCode: 400 })
  })
})

describe('classifyDecomposition', () => {
  const base = (terms: Partial<Record<string, string>>, residual = '0.000000'): AbDecompositionResult =>
    ({
      sectionA: '0',
      sectionB: '0',
      delta: '0',
      residual,
      diagnostics: {
        unhomedChargeUsd: '0.000000',
        quarantinedOtelUsd: '0.000000',
        codingAgentInSectionAUsd: '0.000000',
        codingAgentRawUsd: '0.000000',
        nonCodeSurfacesInSectionAUsd: '0.000000',
        nonCodeSurfacesRawUsd: '0.000000',
      },
      // Derived from the shared const rather than hand-listed. The hand-listed
      // version silently went stale when a term was added: the enclosing `as`
      // cast means a missing key is not a type error, so the drift surfaced as
      // seven unrelated verdict tests failing on a length assertion instead.
      terms: {
        ...(Object.fromEntries(
          AB_DECOMPOSITION_TERMS.map((name) => [name, '0.000000']),
        ) as Record<AbDecompositionTermName, string>),
        ...terms,
      },
    }) as AbDecompositionResult

  it('reports residual-non-zero before any dominance claim', () => {
    // A decomposition that does not close cannot support ANY verdict about which
    // term dominates, because the unexplained money could be larger than all of
    // them. Order matters here.
    const r = classifyDecomposition(base({ nonCodeSurfaces: '999.000000' }, '5.000000'))
    expect(r.verdict).toBe('residual-non-zero')
    expect(r.nonCodeShareOfExplained).toBeNull()
  })

  it('reports no-delta when every term is zero, rather than dividing by zero', () => {
    const r = classifyDecomposition(base({}))
    expect(r.verdict).toBe('no-delta')
    expect(r.nonCodeShareOfExplained).toBeNull()
  })

  it('measures dominance on ABSOLUTE contributions so opposite signs cannot cancel', () => {
    // The trap: on a signed sum, +500 and −500 cancel and a $100 non-Code term
    // would look like it explains the entire (zero) delta. Absolute values stop
    // a term looking dominant merely because the others offset each other.
    const r = classifyDecomposition(
      base({ nonCodeSurfaces: '100.000000', quarantine: '500.000000', floor: '-500.000000' }),
    )
    expect(r.verdict).toBe('non-code-does-not-dominate')
    expect(r.nonCodeShareOfExplained).toBeCloseTo(100 / 1100, 6)
  })

  it('does not call a bare majority-of-one dominant at exactly 50%', () => {
    const r = classifyDecomposition(
      base({ nonCodeSurfaces: '50.000000', quarantine: '50.000000' }),
    )
    expect(r.verdict).toBe('non-code-does-not-dominate')
  })

  it('counts a NEGATIVE non-Code term toward dominance', () => {
    const r = classifyDecomposition(
      base({ nonCodeSurfaces: '-80.000000', quarantine: '10.000000' }),
    )
    expect(r.verdict).toBe('non-code-dominates')
  })

  it('does NOT call an exact 50% tie dominant (integer, not float, arithmetic)', () => {
    /*
     * The single point the whole gate turns on. nonCode is exactly half the
     * absolute total, so a STRICT "more than half" must answer no.
     *
     * These are the values that break float arithmetic: computed as
     * 0.1 + 0.2-style binary fractions, |nonCode| / absTotal evaluates to
     * 0.5000000000000001, which passes `> 0.5` and flips the verdict to
     * "dominates" on a tie. The verdict is now decided as 2 * |nonCode| >
     * absTotal in integer micro-dollars, where a tie is a tie.
     *
     * Reverting classifyDecomposition to the float comparison makes this fail.
     */
    const terms = {
      nonCodeSurfaces: '1.000015',
      licenceLanes: '0.500007',
      floor: '-0.500008',
    }
    // Guard the guard: these specific values must actually trip float, or this
    // test passes for the wrong reason and proves nothing.
    const floatShare =
      Math.abs(Number(terms.nonCodeSurfaces)) /
      (Math.abs(Number(terms.nonCodeSurfaces)) +
        Math.abs(Number(terms.licenceLanes)) +
        Math.abs(Number(terms.floor)))
    expect(floatShare).toBeGreaterThan(0.5)

    const r = classifyDecomposition(base(terms))
    expect(r.verdict).toBe('non-code-does-not-dominate')
  })

  it('counts a NEGATIVE non-Code term by magnitude, not sign', () => {
    // Dominance is about how much of the explained gap a term accounts for.
    // A large negative term explains just as much as a large positive one.
    const r = classifyDecomposition(base({ nonCodeSurfaces: '-90.000000', floor: '10.000000' }))
    expect(r.verdict).toBe('non-code-dominates')
  })
})
