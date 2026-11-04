/*
 * GET /api/v1/reports/teammate/{id}?src&month|from&to — the E3 CONTRIBUTION
 * view of one named individual (developer pages build D31-D36).
 *
 * ONE round trip: identity, TokenSheet by project (two operands per row),
 * surface + provenance mix, worklist pressure, and the chip-row meta operands.
 * Model donut, cache economics, insights, quota and peer stats are ABSENT — not
 * `.gap`-ed (prototype `:848`): they are structurally unpopulatable for arms-2/3
 * subjects and behavioural rather than contributional. Their absence is pinned
 * by test, not merely unrendered.
 *
 * ── THE ORDER OF OPERATIONS IS THE SECURITY CONTRACT ────────────────────────
 *   1. authenticate + resolve grants LIVE (never cached — plan D5)
 *   2. resolve the `?src=` FRAME against the caller's own grants (D33) — a
 *      frame they do not hold is a 403 here, before any subject read
 *   3. the D34 gate: an in-frame row EXISTS ∧ `is_active`, through the ONE
 *      exported rule `teammateDrillAdmission` (D38)
 *   4. AUDIT — in the handler, BEFORE the response cache, so a cache HIT still
 *      writes a row (an audit inside `compute` fires only for the leader)
 *   5. FRESHNESS — evaluated on EVERY request, BEFORE the cache lookup (r1-H7),
 *      so a warm body becomes unreachable the moment the threshold passes
 *   6. only then the cached compute
 *
 * ── `Cache-Control: no-store`, ALWAYS (r1-H6/r2-M1) ─────────────────────────
 * The inherited report-cache contract sets `private, max-age=60`. A browser
 * cache hit never reaches this handler — so no audit row would be written and no
 * refusal could intervene. Both are unacceptable on a named-person surface, so
 * the browser layer is disabled outright here. The internal identity-keyed
 * SERVER cache stays: it is behind the audit and the freshness check.
 *
 * No `attribution_record` / raw `actual_spend` / `attribution_aggregate` — the
 * lane firewall scans this directory.
 */
import { createError, defineEventHandler, getRouterParam, getValidatedQuery, setHeader } from 'h3'
import { z } from 'zod'
import { requireAuth } from '../../../../../auth/rbac'
import { resolveReportGrants } from '../../../../../auth/report-scope'
import { withRequestRls } from '../../../../../db/request-rls'
import {
  withReportCache,
  identityKey,
  normalizedQuery,
} from '../../../../../reporting/report-cache'
import { resolveReportWindow, DATE_REGEX } from '../../../../../reporting/params'
import {
  resolveDrillScope,
  fetchTeammateIdentity,
  subjectHasInScopeRow,
  fetchTeammateTokenSheet,
  fetchTeammateContribution,
  teammateDrillKey,
  writeDrillAudit,
} from '../../../../../reporting/teammate'
import { subjectFreshness } from '../../../../../reporting/teammate-freshness'
import { teammateDrillAdmission } from '../../../../../../shared/auth/report-visibility'
import { providerStatesForWindow } from '../../../../../reports/settling'
import { reportCoverageMeta } from '../../../../../reports/coverage-meta'
import { MONTH_REGEX, monthKeyUtc } from '../../../../../utils/period'
import { isUuid } from '../../../../../utils/uuid'

const Query = z.object({
  /*
   * REQUIRED. `src` is the entry scope frame (D16/D30) and the endpoint has no
   * default for it, because a drill with no frame IS a bare `teammate_id` — the
   * thing C14 forbids (annex :893-901). Inventing a frame would compute a
   * headline over a scope the reader never asked for.
   */
  src: z.string().min(1),
  month: z.string().regex(MONTH_REGEX).optional(),
  from: z.string().regex(DATE_REGEX).optional(),
  to: z.string().regex(DATE_REGEX).optional(),
})

/**
 * The ONE 403 this endpoint speaks. Every refusal reason collapses to the same
 * body: a viewer without the grant, a viewer with the grant but no in-scope
 * rows, and a deactivated subject are indistinguishable from outside. Splitting
 * them would make the endpoint an existence oracle — "does this person have
 * spend in a scope I cannot see" is exactly the question a 404-vs-403 pair
 * answers for free.
 */
function forbidden(): never {
  throw createError({
    statusCode: 403,
    statusMessage: 'Forbidden',
    data: {
      type: 'https://tokenscope.example.com/errors/forbidden',
      title: 'Forbidden',
      status: 403,
      detail:
        'This teammate is not visible in the scope you opened this view from, or your role does not grant the per-teammate reports depth.',
    },
  })
}

export default defineEventHandler(async (event) => {
  const session = await requireAuth(event)
  const subjectId = getRouterParam(event, 'id')
  if (!subjectId || !isUuid(subjectId)) {
    throw createError({ statusCode: 400, statusMessage: 'invalid teammate id' })
  }
  const query = await getValidatedQuery(event, (d) => Query.parse(d))
  const now = new Date()
  const win = resolveReportWindow(query, { now })
  const month = win.monthStr ?? monthKeyUtc(new Date(win.startIso))

  /*
   * NO BROWSER CACHE, set before anything can throw. A refusal, a 403 and a 200
   * are equally unstorable here: the first two must be re-evaluated on every
   * navigation, and the third must re-audit.
   */
  setHeader(event, 'cache-control', 'no-store')

  // ── Authz transaction: grants, frame, gate, freshness. Live, never cached. ──
  const gate = await withRequestRls(event, async (tx) => {
    const grants = await resolveReportGrants(event, tx, session)
    /*
     * The frame resolves FIRST and can 403 on its own (D33). Its own 403 is
     * scope-shaped — "you do not hold that cost centre" — and is raised by the
     * shared resolvers, which already collapse absent/foreign/unowned into one
     * answer (cost-centres.ts:183). Nothing about the SUBJECT has been read yet.
     */
    const scope = await resolveDrillScope(tx, session, grants, query.src)

    const identity = await fetchTeammateIdentity(tx, subjectId)
    const hasRow = identity ? await subjectHasInScopeRow(tx, scope.usage, subjectId, win) : false

    /*
     * THE GATE — the ONE exported rule (D38), never re-spelled here. Project
     * membership is deliberately not a conjunct: no `src` token can express a
     * membership frame, so a membership arm could not carry the C14 entry
     * predicate at all.
     */
    const decision = teammateDrillAdmission(
      { grants },
      {
        id: identity?.id ?? null,
        hasInScopeWindowRow: hasRow,
        isActive: identity?.isActive === true,
        // A PROVISIONAL shadow is active and has rows, so the first conjuncts
        // admit it — and the page would then publish audited figures under an
        // email nobody has authenticated (r3-H2). Refused in the page's own
        // vocabulary: the SAME collapsed 403 every other inadmissible subject
        // gets, so the endpoint stays free of an existence oracle over which
        // identities are unconfirmed.
        // Passed through, NOT collapsed: `=== true` would turn a missing
        // identity row into 'confirmed' and admit it. The rule refuses an
        // unknown on its own (r7-H1).
        isProvisional: identity?.isProvisional,
      },
      { src: scope.token, held: true },
      { from: win.from, to: win.to },
    )
    if (!decision.admit) forbidden()

    /*
     * FRESHNESS, still inside the authz transaction and therefore BEFORE the
     * cache lookup below (r1-H7). Evaluated on every request so a warm cached
     * body cannot outlive the threshold.
     */
    const freshness = await subjectFreshness(tx, scope.usage, subjectId, win, now)
    return { grants, scope, identity: identity!, freshness }
  })

  /*
   * THE AUDIT — in the handler, before the cache (D35.1). A cache HIT must still
   * write a row; an audit inside `compute` would fire only for the miss leader,
   * and "who looked at this person" would then be a function of TTL luck.
   *
   * IDS AND COUNTS ONLY, never row contents — the `report-export-teammate-axis`
   * discipline (export.get.ts:200-251). The write goes on a SEPARATE connection
   * so it survives a later rollback, exactly as the deny-audit does.
   */
  await writeDrillAudit(event, 'report-teammate-viewed', {
    actorTeammateId: session.teammateId,
    subjectId,
    payload: {
      src: gate.scope.token,
      window: { from: win.from, to: win.to },
      month,
      refused: gate.freshness.stale != null,
    },
  })

  /*
   * THE REFUSAL — figures OMITTED, not caveated (D36). Returned before the cache
   * so a refusal is never cached and never serves stale figures from a warm
   * entry. The identity header still renders: the reader already knows who they
   * opened, and withholding the name would not withhold anything.
   */
  if (gate.freshness.stale) {
    return {
      subject: publicIdentity(gate.identity),
      scope: { src: gate.scope.token, label: gate.scope.label },
      window: windowMeta(win, month),
      refusal: {
        reason: 'coverage-stale' as const,
        provider: gate.freshness.stale.provider,
        ageHours: gate.freshness.stale.ageHours,
        threshold: gate.freshness.thresholdHours,
      },
    }
  }

  /*
   * `withReportCache` sets `private, max-age=<ttl>` on a successful body (its D7
   * contract). On THIS surface that header must not survive: it is re-asserted
   * to `no-store` after the call, so the browser layer can never absorb a view
   * (r1-H6) — the audit above and the freshness check below only run when the
   * request actually reaches this handler.
   */
  const body = await withReportCache(
    event,
    // The ROUTE PARAM is named explicitly (r1-H1) — two drills with identical
    // queries must never share a body.
    [
      'reports/teammate',
      teammateDrillKey(gate.scope, subjectId),
      normalizedQuery(query),
      identityKey(session),
      `grant:${gate.grants.teammate}`,
    ],
    () =>
      withRequestRls(event, async (tx) => {
        const [tokensheet, contribution, coverage] = await Promise.all([
          fetchTeammateTokenSheet(tx, gate.scope.usage, subjectId, win),
          fetchTeammateContribution(tx, gate.scope.usage, subjectId, win),
          reportCoverageMeta(tx),
        ])
        return {
          subject: publicIdentity(gate.identity),
          scope: { src: gate.scope.token, label: gate.scope.label },
          window: windowMeta(win, month),
          headlineUsd: contribution.headlineUsd,
          activeDays: contribution.activeDays,
          tokensheet: tokensheet.map((r) => ({
            project_id: r.projectId,
            project_code: r.projectCode,
            project_name: r.projectName,
            // The NUMERATOR — scope-filtered (C14).
            contribution_usd: r.contributionUsd.toFixed(2),
            // The two DENOMINATORS — whole-project, unscoped (r1-H3).
            project_window_usd: r.projectWindowUsd.toFixed(2),
            allocation_usd: r.allocationUsd == null ? null : r.allocationUsd.toFixed(2),
            share_pct: r.sharePct,
          })),
          surfaceMix: contribution.surfaceMix,
          provenanceMix: contribution.provenanceMix,
          /*
           * The NO-PROJECT states, each named (r3-M5). The single figure this
           * replaces summed awaiting-a-decision spend, already-decided
           * activity-tagged spend and structurally UNTAGGABLE arm-3 spend, then
           * rendered the lot under the word "worklist" — a claim about work
           * somebody owes, over money most of which nobody can act on.
           */
          worklistPressure: {
            untagged_usd: contribution.worklist.untaggedUsd.toFixed(2),
            untagged_days: contribution.worklist.untaggedDays,
            activity_tagged_usd: contribution.worklist.activityTaggedUsd.toFixed(2),
            untaggable_usd: contribution.worklist.untaggableUsd.toFixed(2),
          },
          // The chip-row operands (r1-H8) — the SAME two the me pages carry, so
          // CcHeaderNotes renders at reports depth without a second vocabulary.
          meta: {
            providerStates: providerStatesForWindow(win, now),
            coverage,
          },
        }
      }),
  )
  setHeader(event, 'cache-control', 'no-store')
  return body
})

function publicIdentity(i: {
  id: string
  displayName: string
  practice: string | null
  region: string | null
  costOwningUnit: string | null
}) {
  // The EMAIL is deliberately absent: the drill answers "what did this person
  // contribute", and a directory lookup is not part of that question.
  return {
    id: i.id,
    display_name: i.displayName,
    practice: i.practice,
    region: i.region,
    cost_owning_unit: i.costOwningUnit,
  }
}

function windowMeta(
  win: { from: string; to: string; isMonth: boolean; monthStr: string | null },
  month: string,
) {
  return { from: win.from, to: win.to, is_month: win.isMonth, month: win.monthStr ?? month }
}
