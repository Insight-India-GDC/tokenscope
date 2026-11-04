/*
 * reporting/regional — the query layer behind the Regional reporting scope
 * (docs/design/reporting-consolidation/00-build-design.md §2/§3/§4/§5).
 *
 * ONE lane per axis (build-design §4):
 *   - usage KPIs / ranking / drivers / trend / exceptions → the §A completeness
 *     lane (attribution ∪ the API−OTel gap), read through `usage_rollup_daily` —
 *     the day-grain rollup DEFINED as an aggregate of `v_complete_usage`
 *     (docs/design/usage-rollup-lane.md R5; seasonality alone stays on the view
 *     — it is off the page's request path), through the current-lens views
 *     (`v_usage_rollup_current`, `v_complete_usage_current`): usage is grouped and
 *     scoped by where each person sits NOW (docs/design/current-org-lens).
 *   - the monetised genuine-vs-chargeable pair → `v_finance_chargeback_month`
 *     (the §B bill lane), region/subtree grain.
 * No reporting query here touches `attribution_record` or raw `actual_spend`
 * (the lane firewall, build-design §7(7) — test-enforced over BOTH
 * `server/api/v1/reports/**` and `server/reporting/**`). The Copilot chargeable
 * is gated on `copilot.mode` (build-design §6 interim labelling).
 *
 * These are the SAME functions `/reports/export` calls, so the CSV is
 * byte-identical to the screen figures (build-design §2 "byte-identical rule").
 */
import { sql, type SQL } from 'drizzle-orm'
import { clampedFinance, clampedUsage, currentPlacementTeammates } from './engine/scope'
import { vendorSplitAggregates } from './vendor-split'
import { fetchKpiCore, type ReportKpiCore } from './engine/kpis'
import { fetchPerPerson, type PerPersonKpi } from './engine/per-person'
import { fetchDrivers, type DriversResult } from './engine/drivers'
import type { ServerClock } from '../../shared/reports/clock'
import { fetchUsageWeeklyLanes, fetchDailyMetrics } from './engine/usage-series'
import { fetchUsageBudgetCoverage } from './engine/usage-coverage'
import { fetchSpendTrend, fetchActiveTrend, type TrendPoint } from './engine/trend-series'
import { fetchTierExposure } from './engine/tier-exposure'
import {
  fetchChargebackTrend,
  fetchChargebackLaneTrend,
  fetchChargebackLanes,
} from './engine/chargeback-series'
import { createError } from 'h3'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import {
  callerHomeUnitQuery,
  managerScopePredicate,
  orgSubtreeScopePredicate,
} from '../auth/org-subtree-scope'
import { orgSubtreeIds } from '../auth/org-subtree'
import { TEAMMATE_DRILL_FACTS, teammateDrillFacts } from './teammate-drill-facts'
import { isOrgWideRole } from '../../shared/auth/roles'
import { csvEscape, csvMetaLine } from '../utils/csv-escape'
import { laneListSql, SECTION_A_USAGE_TOOLS } from '../../shared/usage/vendor'
import { CLAUDE_CODE_TOOL } from '../../shared/usage/surface'
import type { SpendLens } from '../../shared/usage/lens'
import { UNALLOCATED_KEY, UNALLOCATED_LABEL } from '../../shared/reports/unallocated'
import { UNASSIGNED_REGION_CODE } from '../../shared/placement/holding-nodes'
import {
  GITHUB_CHARGEABLE_LANES,
  COPILOT_CLI_TOOL,
  COPILOT_AGENT_TOOL,
} from '../../shared/usage/github-surface'
import {
  buildSeasonality,
  fillDowBuckets,
  driverProvenanceCsvCells,
  driverSurfaceMixCsvCell,
  driverArmCsvLines,
  type UsageWindow,
} from './params'
import type { MonthRangeUtc } from '../utils/period'
import type {
  MeasureLane,
  BilledLaneMeta,
  ChargebackCoverage,
  DriverRow,
  DailyMetric,
  SpendClass,
  ProviderSplit,
  ActiveTrendPoint,
  SeasonalityCell,
  ChargeDailyPoint,
  ChargeLanePoint,
  ChargebackLaneRow,
  ChargeDowBucket,
  UsageSurfaceWeeklyCell,
  UsageBudgetCoverage,
} from '../../shared/reports/types'
import type { TierExposure } from '../../shared/reports/tier-exposure'

type Tx = PostgresJsDatabase<Record<string, unknown>>

/** The minimal caller shape the scope resolver needs (a resolved Session). */
export interface RegionalCaller {
  role: string
  regionId: string
}

export interface RegionRef {
  id: string
  code: string
  displayName: string
}

export interface OuRef {
  id: string
  path: string
  regionId: string
  code: string
  displayName: string
}

/** The drivers axis (build-design §2 `/reports/regional/drivers`). */
export const REGIONAL_DRIVER_AXES = ['practice', 'teammate', 'model', 'project', 'surface'] as const
export type RegionalDriverAxis = (typeof REGIONAL_DRIVER_AXES)[number]

/**
 * A resolved Regional scope: the effective region, the optional `ou` drill, the
 * cross-region region list (for the selector), and the two scope-clause builders
 * (usage lane + finance lane) every query applies so they cannot diverge.
 */
export interface RegionalScope {
  effectiveRegionId: string
  region: RegionRef | null
  regionOptions: RegionRef[]
  isCrossRegion: boolean
  ou: OuRef | null
  /**
   * Usage-lane predicate: the people whose CURRENT placement is in scope, as a
   * clamp on the given teammate-id column (`currentPlacementTeammates`).
   */
  usageScope: (teammateCol: string) => SQL
  /** Finance-lane predicate over (`region_id`, `cost_owning_unit_id`)-style columns. */
  financeScope: (regionCol: string, costOwningCol: string) => SQL
  /**
   * Stable identity of THIS scope, for caching scope-derived values (the month
   * floor). Built from exactly the inputs `usageScope` closes over, in the same
   * place, so the two cannot drift: a key that failed to vary with the
   * predicate would serve one scope's floor to another — a wrong 400 on a month
   * the caller does have data in.
   */
  scopeKey: string
  /**
   * WHAT `usageScope` ACTUALLY CLAMPS TO, in the words a reader names it — the drilled
   * unit, else the caller's own org unit (dev/manager subtree), else the region. It is
   * built here, beside the predicate, because nothing downstream can see the predicate:
   * a component reading `drill ?? region` names the REGION for a manager whose figures
   * are their subtree's, which is contract C11's over-wide denominator (the defect this
   * field exists to remove).
   *
   * `null` when the subtree clamp resolves to NO org unit — the caller's own placement
   * is the region root or a holding node, so `placedBelowRegionRootPredicate` degrades
   * the clamp to zero rows. Consumers must render "no resolved scope", NEVER fall back
   * to the region: that fallback is exactly what was wrong.
   */
  scopeLabel: string | null
}

/**
 * Every selectable region, in the selector's order.
 *
 * ORDER BY (display_name, code) — a TOTAL order, not just a pleasant one. The
 * org-wide default region is `regionOptions[0]`, and `region.display_name` carries
 * no unique constraint (only `region.code` does, 0001_schema.sql), so `ORDER BY
 * display_name` alone leaves two same-named regions in whatever order the scan
 * happened to produce — which can differ between two executions of the same query
 * once a row is rewritten. Six endpoints plus the CSV export run this
 * independently, so an unbroken tie is exactly the "wrong region under a wrong
 * name" state the owner's default-region rule forbids. `code` is UNIQUE NOT NULL,
 * so appending it makes the order total and the default reproducible.
 *
 * Exported because the Region scope's WHOLE-COMPANY width needs the same list for
 * the same selector while resolving no regional clamp at all — and a second copy of
 * this query is a second order.
 */
export async function fetchRegionOptions(tx: Tx): Promise<RegionRef[]> {
  const rows = await tx.execute<{ id: string; code: string; display_name: string }>(sql`
    SELECT id::text AS id, code, display_name FROM region
    WHERE code <> ${UNASSIGNED_REGION_CODE} ORDER BY display_name, code`)
  return [...rows].map((r) => ({ id: r.id, code: r.code, displayName: r.display_name }))
}

function forbid(detail: string): never {
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
 * Resolve + AUTHORISE the Regional scope in-query (build-design §2 RBAC branch):
 *   - admin                          → own region FORCED (`region` param ignored)
 *   - global-finops / platform-admin → any region (validated) + the region picker
 *                                      (ORG_WIDE_ROLES — the org-wide, region-less roles)
 *   - developer / manager            → their org SUBTREE, region-clamped
 *   - `ou` drill                     → the unit's subtree, gated by
 *     orgSubtreeScopePredicate OR active ownership (anti-IDOR: a foreign-region /
 *     out-of-scope unit → 403).
 *
 * A cross-region caller who names NO `?region` gets a default that is a function of
 * the CALLER ALONE (see the effective-region branch below) — no window, no spend.
 * Every Regional endpoint resolves this scope independently, so a default that
 * varied with anything else would let the page header name one region while the
 * drivers table computed another.
 */
export async function resolveRegionalScope(
  tx: Tx,
  caller: RegionalCaller,
  params: { region?: string | null; ou?: string | null },
  opts?: { crossRegion?: boolean },
): Promise<RegionalScope> {
  // GRANTS ARE NOW THE ONLY CROSS-REGION SOURCE (mig 0129). A role is no
  // longer cross-region by its enum: `effectiveReportGrants`'s baseline for
  // global-finops / platform-admin is 'own-region' like everyone else
  // (shared/auth/report-visibility.ts's `baselineGrants`), so cross-region
  // reach now comes ENTIRELY from an ACTIVE 'operational' report-access grant
  // (regional === 'all-regions'), threaded here as `opts.crossRegion` by every
  // caller from their already-resolved grants. The grant is a LEVEL, not a
  // bypass: an elevated caller sees the region SELECTOR + a honoured
  // `?region`, exactly as a genuinely cross-region caller does — one region
  // at a time, never an unclamped union.
  const isCrossRegion = opts?.crossRegion === true
  const isAdmin = caller.role === 'admin'
  const isSubtree = caller.role === 'developer' || caller.role === 'manager'
  // A caller whose ORG-WIDE role holds no cross-region grant is region-bound,
  // not scope-less: `baselineGrants` gives it 'own-region' (never
  // 'all-regions') until an 'operational' grant is active. Admitted here as a
  // FOURTH, non-cross class — rather than forbidden — because `scopeRole`
  // below falls through to `caller.role` for it, and
  // `managerScopePredicate`'s fallback arm (org-subtree-scope.ts:189-190)
  // clamps that to `effectiveRegionId = caller's own region`, exactly the
  // `admin` treatment.
  const isOrgWide = isOrgWideRole(caller.role)
  if (!isCrossRegion && !isAdmin && !isSubtree && !isOrgWide) {
    forbid(`Role '${caller.role}' is not permitted for the Regional report.`)
  }

  // Cross-region callers (by role or policy) get the region list (selector + validation).
  //
  // ORDER BY (display_name, code) — a TOTAL order, not just a pleasant one. The
  // platform-admin default below is `regionOptions[0]`, and `region.display_name`
  // carries no unique constraint (only `region.code` does, 0001_schema.sql), so
  // `ORDER BY display_name` alone leaves two same-named regions in whatever order
  // the sort happened to produce for that scan — which can differ between two
  // executions of the same query once a row is rewritten. Five endpoints plus the
  // CSV export run this independently, so an unbroken tie is exactly the "wrong
  // region under a wrong name" state the owner's rule forbids. `code` is UNIQUE
  // NOT NULL, so appending it makes the order total and the default reproducible.
  /*
   * A2 — SEALS THE ?ou= DRILL BYPASS. `orgSubtreeScopePredicate`'s GUC arm
   * is UNCONDITIONALLY TRUE for role 'global-finops' (org-subtree-scope.ts:
   * 49; platform-admin maps to it at the RLS layer, request-rls.ts:33). For
   * the new `isOrgWide && !isCrossRegion` class (admitted above, never
   * forbidden) that predicate would therefore validate ANY unit in ANY
   * region — an ungranted org-wide caller is supposed to be bound to their
   * OWN region, exactly like `admin`. So THIS class gets an explicit
   * JS-computed clamp instead of the predicate: `org_unit.region_id =
   * caller.regionId`, the same own-region semantics `admin` gets. Does NOT
   * touch org-subtree-scope.ts or the GUC layer.
   */
  const scopeClause = isCrossRegion
    ? sql`TRUE`
    : isOrgWide
      ? sql`org_unit.region_id = ${caller.regionId}::uuid`
      : orgSubtreeScopePredicate('org_unit')
  const ownerClause = sql`EXISTS (
      SELECT 1 FROM cou_owner co
      WHERE co.org_unit_id = org_unit.id
        AND co.teammate_id = NULLIF(current_setting('app.user_teammate_id', true), '')::uuid
        AND co.revoked_at IS NULL)`
  const usesSubtreeClamp = !isCrossRegion && isSubtree

  /*
   * Concurrent issuance on ONE tx connection: postgres-js pipelines and answers
   * in order (docs/design/request-floor-performance.md F5). CONSERVATIVE by
   * design — this is authz code: the wave carries ONLY the reads whose inputs
   * are caller flags, request params and the session GUCs, all fixed before any
   * query runs. The region-row read below is NOT in the wave: its key
   * (`effectiveRegionId`) is computed FROM the wave's results (the resolved
   * drill unit / the region list) — a real dependency chain, kept sequential.
   */
  const [regionOptionRows, ouRows, gucRows, homeRows] = await Promise.all([
    isCrossRegion ? fetchRegionOptions(tx) : null,
    // `ou` drill — resolve WITHIN scope OR active ownership (practice-page
    // pattern). A policy-elevated cross-region caller resolves ANY existing
    // unit (consistent with their honoured cross-region selector); a genuine
    // cross-region role already matched everything via
    // orgSubtreeScopePredicate's global-finops branch.
    params.ou
      ? tx.execute<{
          id: string
          path: string
          region_id: string
          code: string
          display_name: string
        }>(sql`
      SELECT id::text AS id, path::text AS path, region_id::text AS region_id, code, display_name
      FROM org_unit
      WHERE id = ${params.ou}::uuid AND retired_at IS NULL
        AND ( ${scopeClause} OR ${ownerClause} )
      LIMIT 1`)
      : null,
    // The GUC read-back for `scopeKey` (see the comment at its use below).
    tx.execute<{ org_path: string | null; region: string | null; role: string | null }>(
      sql`SELECT current_setting('app.user_org_path', true) AS org_path,
               current_setting('app.user_region_id', true) AS region,
               current_setting('app.user_role', true) AS role`,
    ),
    // The subtree caller's home-unit label (see the scopeLabel arms below). A
    // drilled request (`params.ou`) labels from the unit instead, so it skips
    // this read exactly as the sequential code did.
    usesSubtreeClamp && !params.ou
      ? tx.execute<{ display_name: string }>(callerHomeUnitQuery())
      : null,
  ])
  const regionOptions: RegionRef[] = regionOptionRows ?? []

  let ou: OuRef | null = null
  if (params.ou) {
    const r = ouRows ? [...ouRows][0] : undefined
    // Anti-IDOR: an out-of-scope / foreign-region unit simply does not resolve → 403.
    if (!r) forbid('org unit not in your scope')
    ou = {
      id: r!.id,
      path: r!.path,
      regionId: r!.region_id,
      code: r!.code,
      displayName: r!.display_name,
    }
  }

  // Effective region: the drill fixes it; else a cross-region caller honours a
  // validated `region` (else the caller-only default below); a non-cross admin/subtree
  // is hard-bound to their own region. Cross-region is checked FIRST so an elevated
  // admin is no longer collapsed to own-region by the subtree/admin branch.
  let effectiveRegionId: string
  if (ou) {
    effectiveRegionId = ou.regionId
  } else if (isCrossRegion) {
    if (params.region && !regionOptions.some((o) => o.id === params.region)) {
      throw createError({ statusCode: 404, statusMessage: 'region not found' })
    }
    /*
     * THE DEFAULT REGION. Owner decision, extended uniformly alongside the
     * grants model (mig 0129): cross-region access is now ALWAYS
     * grant-derived (`isCrossRegion` is `opts?.crossRegion === true`, full
     * stop — the role-based `roleCrossRegion` arm is gone), so EVERY caller
     * reaching this branch got here by holding an active 'operational'
     * report-access grant, never by role alone. The original ruling for
     * global-finops — "should get alphabetical too, they have no region" —
     * is therefore extended to everyone this branch admits: `ownRegionId` is
     * `undefined` whenever `isCrossRegion` is true, which it always is here,
     * so every grant-elevated caller opens on the FIRST of `regionOptions`,
     * ordered by (display_name, code) — a TOTAL order (see the region-list
     * query above for why the `code` tiebreaker is load-bearing).
     * `caller.regionId` is where such a caller's Entra record happens to sit,
     * not a region they answer for by virtue of the grant, so it plays no
     * part in the default.
     *
     * The rule reads only `isCrossRegion`, the region list and (via the `??`
     * chain below) an explicit `?region=` — never the window and never a
     * spend figure. That is the point: all five Regional endpoints plus the
     * CSV export resolve this scope independently and cannot compare notes,
     * so a default that varied with the window would name one region in the
     * header while another was computed underneath it.
     */
    const ownRegionId = isCrossRegion
      ? undefined
      : regionOptions.find((o) => o.id === caller.regionId)?.id
    effectiveRegionId =
      (params.region && regionOptions.find((o) => o.id === params.region)?.id) ??
      ownRegionId ??
      regionOptions[0]?.id ??
      caller.regionId
  } else {
    effectiveRegionId = caller.regionId
  }

  // NOT waved (F5): keyed by `effectiveRegionId`, which the wave's results decide.
  const rg = await tx.execute<{ id: string; code: string; display_name: string }>(sql`
    SELECT id::text AS id, code, display_name FROM region WHERE id = ${effectiveRegionId}::uuid LIMIT 1`)
  const rgRow = [...rg][0]
  const region: RegionRef | null = rgRow
    ? { id: rgRow.id, code: rgRow.code, displayName: rgRow.display_name }
    : null

  // Scope-clause role: a cross-region caller (grant-derived — mig 0129) clamps to the
  // single effectiveRegionId (the global-finops branch of managerScopePredicate); a
  // plain developer shares the manager subtree clause; admin/manager keep their own
  // clamps. An org-wide-but-ungranted caller falls through to `caller.role`, landing
  // in managerScopePredicate's fallback arm (own-region — see the forbid-gate comment
  // above). The drill overrides with the unit's own subtree (usage: all units;
  // finance: cost-owning only).
  const scopeRole = isCrossRegion ? 'global-finops' : isSubtree ? 'manager' : caller.role
  const scopeCaller = { role: scopeRole, regionId: caller.regionId }
  const usageScope = (teammateCol: string): SQL =>
    currentPlacementTeammates(teammateCol, (regionCol, subtreeCol) =>
      ou
        ? sql`${sql.raw(subtreeCol)} IN (${orgSubtreeIds(ou.path, ou.regionId)})`
        : managerScopePredicate(scopeCaller, effectiveRegionId, regionCol, subtreeCol),
    )
  const financeScope = (regionCol: string, costOwningCol: string): SQL =>
    ou
      ? sql`${sql.raw(costOwningCol)} IN (${orgSubtreeIds(ou.path, ou.regionId, { costOwningOnly: true })})`
      : managerScopePredicate(scopeCaller, effectiveRegionId, regionCol, costOwningCol)

  /*
   * The scope key must vary with the PREDICATE, and the predicate is not fully
   * determined by anything in `caller`. managerScopePredicate's manager arm
   * scopes by the RLS session GUCs — app.user_org_path, and app.user_region_id
   * inside placedBelowRegionRootPredicate — read at execution time, not closed
   * over here (server/auth/org-subtree-scope.ts:145,103).
   *
   * An earlier version of this key listed the values it believed the predicate
   * used and missed exactly those, so two managers in ONE region with DIFFERENT
   * subtrees produced different predicates under an identical key. The floor is
   * enforced server-side as a 400, so the symptom was one manager being refused
   * a month they DO have data in, on the strength of another manager's floor.
   *
   * Reading the GUCs back rather than re-listing the inputs is the point: the
   * key is derived from the SAME source the predicate reads, so the two cannot
   * drift no matter how the predicate is later changed. Three cheap
   * current_setting() calls, no table access — issued in the F5 wave above
   * (`gucRows`): the GUCs are fixed for the whole transaction, so reading them
   * earlier reads the same values.
   */
  const g = [...gucRows][0]
  const gucKey = `${g?.org_path ?? '-'}|${g?.region ?? '-'}|${g?.role ?? '-'}`

  /*
   * The NAME of the scope the predicate above just built, resolved from the same
   * inputs and in the same place for the same reason `scopeKey` is: a name derived
   * anywhere else is a name for a DIFFERENT scope the moment the predicate changes.
   *
   * Three arms, one per arm of `usageScope`:
   *   - a drill clamps to the unit's own subtree → the unit names it;
   *   - a dev/manager (NOT elevated cross-region) clamps to `app.user_org_path`'s
   *     subtree → their own home unit names it, read back through the SAME predicate
   *     the clamp is gated on, so an unqualified placement yields null rather than the
   *     region. Both roles hold `regional: 'own-region'` and NEITHER sees the region;
   *     the grant is an authorisation level, not the extent of the figures;
   *   - everyone else (admin, global-finops/platform-admin, a policy-elevated caller)
   *     clamps to `region_id = effectiveRegionId` → the region names it. 'this region'
   *     only when the region row itself is unreadable — still the caller's own scope,
   *     just unnamed, never a wider one.
   */
  let scopeLabel: string | null
  if (ou) {
    scopeLabel = ou.displayName
  } else if (usesSubtreeClamp) {
    // Read in the F5 wave above; this arm is only reachable without a drill,
    // which is exactly when the wave issued the query.
    scopeLabel = [...(homeRows ?? [])][0]?.display_name ?? null
  } else {
    scopeLabel = region?.displayName ?? 'this region'
  }

  return {
    effectiveRegionId,
    region,
    regionOptions,
    isCrossRegion,
    ou,
    usageScope,
    financeScope,
    // `ou.path` as well as `ou.id`: the drill predicate scopes by the unit's
    // PATH, so a unit moved in the tree keeps its id while its subtree changes.
    scopeKey: `regional:${scopeRole}:${caller.regionId ?? '-'}:${effectiveRegionId}:${ou?.id ?? '-'}:${ou?.path ?? '-'}:${gucKey}`,
    scopeLabel,
  }
}

// ── KPIs ─────────────────────────────────────────────────────────────────────
/**
 * The Regional KPI row is the engine's KPI core exactly — every field it defines
 * and none beyond it. The §A month-over-month trio the whole-company scope adds
 * (`prevGenuineUsd` / `momDeltaPct` / `avgPerUserUsd`) is not rendered at this
 * scope and is not computed for it.
 */
export type RegionalKpis = ReportKpiCore

/**
 * The Regional KPI row: usage-lane genuine total + the finance-lane chargeable
 * pair, each clamped by this scope's own predicate for its own lane.
 *
 * The §A clamp addresses the UNALIASED `teammate_id` because the engine's
 * totals query selects from the rollup with no alias; the §B clamp addresses
 * `region_id` / `cost_owning_unit_id`. Both are the SAME
 * predicates the region's series queries pass, so a tile and the card under it
 * cannot be summed over different scopes.
 *
 * `scope.scopeKey` is the month floor's cache identity, and it is built beside
 * `usageScope` in the resolver (see RegionalScope.scopeKey) so the two cannot
 * drift; the floor's predicate itself comes from the §A clamp passed here.
 */
export async function fetchRegionalKpis(
  tx: Tx,
  scope: RegionalScope,
  range: UsageWindow,
  opts: { copilotChargeback: boolean; momMonthRange?: MonthRangeUtc | null; now?: Date },
): Promise<RegionalKpis> {
  return fetchKpiCore(
    tx,
    {
      usage: clampedUsage(scope.usageScope('teammate_id')),
      finance: clampedFinance(scope.financeScope('region_id', 'cost_owning_unit_id')),
      monthFloorKey: scope.scopeKey,
    },
    range,
    opts,
  )
}

// ── Per-person KPI (the "Median per person" tile and its percentiles) ────────
/**
 * The region-clamped §A per-person cohort — the SAME engine read the whole-company
 * width uses (engine/per-person.ts), with this scope's §A predicate.
 *
 * The clamp addresses UNALIASED `region_id` / `org_unit_id`, matching the cohort
 * query's own FROM, exactly as `fetchRegionalKpis` above does — so the median's
 * denominator and the `activeUsers` count beside it are summed over one scope.
 */
export async function fetchRegionalPerPerson(
  tx: Tx,
  scope: RegionalScope,
  range: UsageWindow,
  opts: { momMonthRange?: MonthRangeUtc | null; asOfDate?: string | null } = {},
): Promise<PerPersonKpi> {
  return fetchPerPerson(tx, clampedUsage(scope.usageScope('teammate_id')), range, opts)
}

// ── Vendor split (drill donut) ───────────────────────────────────────────────
export interface VendorSplit {
  claudeUsd: number
  copilotUsd: number
  otherUsd: number
}

/** Usage-lane vendor split for the month in scope — feeds the `?ou=` drill donut. */
export async function fetchRegionalVendorSplit(
  tx: Tx,
  scope: RegionalScope,
  range: UsageWindow,
): Promise<VendorSplit> {
  const [r] = [
    ...(await tx.execute<{ claude: string; copilot: string; other: string }>(sql`
      SELECT ${vendorSplitAggregates}
      FROM v_usage_rollup_current u
      WHERE ${scope.usageScope('u.teammate_id')}
        AND u.day >= ${range.startIso.slice(0, 10)}::date
        AND u.day <  ${range.endIso.slice(0, 10)}::date`)),
  ]
  return {
    claudeUsd: Number(r?.claude ?? 0),
    copilotUsd: Number(r?.copilot ?? 0),
    otherUsd: Number(r?.other ?? 0),
  }
}

// ── Practice ranking (top-level RankedBars) ──────────────────────────────────
export interface RankedRow {
  key: string
  label: string
  value: number
  spendClass: SpendClass
  /**
   * True when this bucket IS the region's `default` BU — the node unplaced
   * teammates land under (an unplaced-teammates signal, not a real practice).
   * A read-only display flag; touches no money math (§A usage stays §A).
   */
  isDefault: boolean
}

/**
 * Rank the region's usage by PRACTICE — the nearest cost-owning ancestor of each
 * person's CURRENT unit. Records with no cost-owning ancestor bucket into an
 * explicit "Unattributed" row so the ranking SUMS BACK to the genuine headline.
 *
 * `isDefault` flags the region's `default` BU (`cou.code = 'default'`) so the
 * client can render it as a to-do ("place these teammates") rather than a peer
 * practice — a read-only boolean, no aggregation touched.
 */
export async function fetchRegionalPractices(
  tx: Tx,
  scope: RegionalScope,
  range: UsageWindow,
): Promise<RankedRow[]> {
  const rows = await tx.execute<{
    key: string | null
    label: string | null
    value: string
    is_default: boolean | null
  }>(sql`
    SELECT cou.cost_owning_unit_id::text AS key, cou.cost_owning_unit_name AS label,
           (cou.cost_owning_unit_code = 'default') AS is_default,
           COALESCE(SUM(u.cost_usd), 0)::text AS value
    FROM v_usage_rollup_current u
    -- ONE cost-owner resolution (v_org_unit_cost_owner, mig 0114), not a
    -- correlated LATERAL per usage row. LEFT, so unhomed spend keeps its row.
    -- The join key org_unit_id is in the rollup grain (usage-rollup-lane.md R5).
    LEFT JOIN v_org_unit_cost_owner cou ON cou.org_unit_id = u.org_unit_id
    WHERE ${scope.usageScope('u.teammate_id')}
      AND u.day >= ${range.startIso.slice(0, 10)}::date
      AND u.day <  ${range.endIso.slice(0, 10)}::date
    GROUP BY cou.cost_owning_unit_id, cou.cost_owning_unit_name, cou.cost_owning_unit_code
    ORDER BY SUM(u.cost_usd) DESC NULLS LAST`)
  return [...rows].map((r) => ({
    key: r.key ?? 'unattributed',
    label: r.label ?? 'Unattributed',
    value: Number(r.value),
    spendClass: 'indicative' as SpendClass,
    isDefault: r.is_default === true,
  }))
}

// ── Chargeback by cost-centre (§B finance lane — the §B analogue of practices) ─
export interface RankedChargeRow {
  key: string
  label: string
  value: number
}

/**
 * Rank the region's §B CHARGEBACK by cost-owning unit, off the bill lane — NEVER
 * `v_complete_usage`. The §B counterpart of the §A "usage by practice" ranking: usage
 * mode ranks practices off usage, chargeback mode ranks cost-centres off the real charge.
 * The NULL `cost_owning_unit_id` bucket is retained as an explicit "Unallocated" row so
 * the ranking SUMS BACK to the region chargeable headline (sum-back integrity).
 *
 * The two providers use DIFFERENT grains (the grain-mismatch fix): the Anthropic arm reads
 * the DAY-grained `v_finance_bill_chargeback` over the exact `[startDate, endDate)` window,
 * so it foots to the same windowed Anthropic total the KPI shows for ANY range. Copilot
 * pooled net is POOLED-MONTHLY (`v_finance_copilot_pool_chargeback`, no daily grain) and is
 * folded in only when `copilotChargeback` (build-design §6). Both arms are clamped by the
 * SAME finance predicate the KPI charge uses, so they can never diverge, and UNION by
 * `cost_owning_unit_id`.
 */
export async function fetchRegionalChargebackByCostCentre(
  tx: Tx,
  scope: RegionalScope,
  range: UsageWindow,
  opts: { copilotChargeback: boolean },
): Promise<RankedChargeRow[]> {
  const startDate = range.startIso.slice(0, 10)
  const endDate = range.endIso.slice(0, 10)
  const financeScope = scope.financeScope('region_id', 'cost_owning_unit_id')
  // Copilot arm: pooled MONTHLY, folded on top only in chargeback mode (pending Wave-0
  // validation otherwise) so the ranking foots to the same chargeable the KPI shows.
  const copilotArm = opts.copilotChargeback
    ? sql`
      UNION ALL
      SELECT cost_owning_unit_id, SUM(charge_usd) AS value
      FROM v_finance_copilot_pool_chargeback
      WHERE ${financeScope}
        AND tool IN (${laneListSql(GITHUB_CHARGEABLE_LANES)})
        AND period_month >= ${startDate}::date AND period_month < ${endDate}::date
      GROUP BY cost_owning_unit_id`
    : sql``
  const rows = await tx.execute<{
    cou_id: string | null
    label: string | null
    value: string
  }>(sql`
    WITH charges AS (
      SELECT cost_owning_unit_id, SUM(bill_usd) AS value
      FROM v_finance_bill_chargeback
      WHERE ${financeScope}
        AND period_date >= ${startDate}::date AND period_date < ${endDate}::date
      GROUP BY cost_owning_unit_id
      ${copilotArm}
    )
    SELECT c.cost_owning_unit_id::text AS cou_id, cou.display_name AS label,
           COALESCE(SUM(c.value), 0)::text AS value
    FROM charges c LEFT JOIN org_unit cou ON cou.id = c.cost_owning_unit_id
    GROUP BY c.cost_owning_unit_id, cou.display_name
    ORDER BY SUM(c.value) DESC NULLS LAST`)
  return [...rows].map((r) => ({
    key: r.cou_id ?? UNALLOCATED_KEY,
    label: r.label ?? UNALLOCATED_LABEL,
    value: Number(r.value),
  }))
}

// ── Daily metrics (§A usage sparkline series, region-scoped) ──────────────────
/**
 * The region-scoped §A per-day usage series over the window (`usage_rollup_daily`,
 * usage-rollup-lane.md R5) —
 * one row per UTC day in the window THAT HAS HAPPENED — zero-filled, so a day
 * with no in-scope usage is present with 0s rather than absent: `SUM(cost_usd)`,
 * `SUM(tokens)`, `COUNT(DISTINCT teammate_id)`, ordered by day. That matters
 * because this feeds the KPI-tile sparklines: dropping empty days would compress
 * scattered activity into contiguous points, and emitting days that have not
 * occurred would draw spend collapsing to zero. The exact bound lives on
 * `fetchDailyMetrics` (engine/usage-series.ts).
 * Mirrors the Across variant one tier down (scope-clamped). Pure usage lane.
 */
export async function fetchRegionalDailyMetrics(
  tx: Tx,
  scope: RegionalScope,
  window: UsageWindow,
  clock: ServerClock,
): Promise<DailyMetric[]> {
  return fetchDailyMetrics(
    tx,
    clampedUsage(scope.usageScope('u.teammate_id')),
    window,
    clock,
  )
}

// ── §A budget coverage (the denominator beside the region's own headline) ────
/**
 * The region-scoped budget-coverage decomposition of `fetchRegionalKpis`'
 * `genuineUsd` — how much of this region's attributed usage sits on a budgeted
 * project and how much sits outside the budget lens.
 *
 * Clamped by the SAME usage predicate `fetchRegionalDailyMetrics` uses
 * (`scope.usageScope('u.teammate_id')`), so its `totalUsd` IS the
 * region's headline and the parts foot to the number they are rendered beside.
 * Pure §A — no bill-lane operand (contract C2).
 *
 * "Region-scoped" is the ADMIN reading of this scope, and it is only one of three:
 * a drill clamps to the drilled unit, and a manager or developer clamps to their own
 * subtree. `scope.scopeLabel` is that distinction carried in words, taken from the same
 * object as the predicate so the name and the numbers cannot come from different scopes.
 */
export async function fetchRegionalUsageBudgetCoverage(
  tx: Tx,
  scope: RegionalScope,
  window: UsageWindow,
): Promise<UsageBudgetCoverage> {
  return fetchUsageBudgetCoverage(
    tx,
    clampedUsage(scope.usageScope('u.teammate_id')),
    window,
    scope.scopeLabel,
  )
}

// ── §B behavioural exposure (model-tier bands over provider_usage_fact) ──────
/**
 * The region-scoped Behavioural-exposure card — the same primitive the
 * whole-company surface calls, with the scope predicate supplied instead of
 * declared away. Clamped by the SAME finance predicate the KPI charge uses
 * (`scope.financeScope('region_id', 'cost_owning_unit_id')`), applied to
 * `v_provider_usage_fact_current`, whose columns are the person's current region
 * and Business Unit.
 *
 * §B lane — NEVER summed with the §A `genuineUsd` on the same page (contract C2).
 */
export async function fetchRegionalTierExposure(
  tx: Tx,
  scope: RegionalScope,
  window: UsageWindow,
): Promise<TierExposure> {
  return fetchTierExposure(
    tx,
    clampedFinance(scope.financeScope('region_id', 'cost_owning_unit_id')),
    window,
  )
}

// ── §B chargeback daily trend (bill lane — day-grained, region-scoped) ───────
/**
 * The region-scoped §B ANTHROPIC chargeback per-day series over the window
 * (`v_finance_bill_chargeback`, the per-teammate DAILY bill lane), scope-clamped by the
 * SAME finance predicate the KPI charge uses so the two can never diverge. Zero-filled
 * across every day of the window that has HAPPENED (like the §A daily metrics — same
 * bound, see engine/chargeback-series.ts). Anthropic-only (Copilot pooled/monthly).
 * The region-scoped mirror of `fetchAcrossChargebackTrend`; feeds the chargeback-mode
 * spend-trend card + the Chargeable KPI-tile sparkline. Never summed with §A usage.
 */
export async function fetchRegionalChargebackTrend(
  tx: Tx,
  scope: RegionalScope,
  window: UsageWindow,
  clock: ServerClock,
): Promise<ChargeDailyPoint[]> {
  return fetchChargebackTrend(
    tx,
    clampedFinance(scope.financeScope('region_id', 'cost_owning_unit_id')),
    window,
    clock,
  )
}

// ── §B chargeback lane trend (bill lane, per-lane — lane-visuals V2-Regional) ─

/**
 * The per-LANE widening of {@link fetchRegionalChargebackTrend}: the SAME
 * `v_finance_bill_chargeback` window + region-scope clamp, GROUP BY tool, each
 * tool mapped to its registry lane id via `chargeToVendor`. NOT zero-filled —
 * the total `chargeSeries` stays the zero-filled axis/total of record; this
 * series carries only (day, lane) cells with rows, and Σ lanes per day equals
 * that day's `chargeUsd` cent-exactly (test-pinned). Copilot lanes are
 * structurally ABSENT (the mig-0085 firewall: §B Copilot is pooled, MONTH-
 * grained, never in this daily view). The region-scoped mirror of
 * `fetchAcrossChargebackLaneTrend`; never summed with §A usage.
 */
export async function fetchRegionalChargebackLaneTrend(
  tx: Tx,
  scope: RegionalScope,
  window: UsageWindow,
): Promise<ChargeLanePoint[]> {
  return fetchChargebackLaneTrend(
    tx,
    clampedFinance(scope.financeScope('region_id', 'cost_owning_unit_id')),
    window,
  )
}

// ── §A per-surface weekly usage lanes (the usage-view hero, Regional) ────────
/**
 * The region-scoped canonical §A USAGE weekly lane series over the window — the
 * regional mirror of `fetchAcrossUsageWeeklyLanes` (requirement 1),
 * REGION-CLAMPED by the SAME usage-lane predicate every other §A regional query
 * uses (`scope.usageScope('teammate_id')` — identical to
 * `fetchRegionalKpis`', so this can never diverge from the region's genuine
 * headline). REPLACES the former billed-showback-basis fetcher
 * (`v_finance_bill_showback`) that fed this same hero while it was still
 * labelled "usage". EVERY §A surface rides this cell natively (no GitHub
 * firewall — this view IS the usage basis). Σ cells over this window ==
 * `fetchRegionalKpis(...).genuineUsd` for the SAME scope + window, cent-exact
 * (test-pinned). NOT zero-filled; NEVER summed with any §B chargeback figure.
 */
export async function fetchRegionalUsageWeeklyLanes(
  tx: Tx,
  scope: RegionalScope,
  window: UsageWindow,
): Promise<UsageSurfaceWeeklyCell[]> {
  return fetchUsageWeeklyLanes(tx, clampedUsage(scope.usageScope('teammate_id')), window)
}

// ── §B chargeback lane totals (bill lane — the split-donut operand, V2-Regional) ─
/**
 * Per-lane §B chargeback totals over the window — the region-scoped
 * ChargebackSplitCard donut operand. Two arms, mirroring the KPI composition
 * EXACTLY (so the donut sums back to `fetchRegionalKpis.chargeableUsd`
 * cent-exactly), both clamped by the SAME finance predicate the KPI charge uses:
 *   - ANTHROPIC: day-grained `v_finance_bill_chargeback` GROUP BY tool over the
 *     exact window (Σ == `anthropicChargeableUsd` for ANY range), lanes via
 *     `chargeToVendor`;
 *   - COPILOT (§B lanes): pooled-monthly `v_finance_copilot_pool_chargeback`,
 *     included ONLY when `copilotChargeback` AND the window is month-aligned —
 *     the same gate as the KPI fold (never a partial-month slice, never a
 *     silent $0). ALL three lanes ride along, INCLUDING copilot-unclassified:
 *     it is VISIBLE (badged) but excluded from every chargeable sum by the UI
 *     (the FinanceCouTable convention) — Σ(lanes minus unclassified) == the
 *     chargeable headline.
 * Rows are emitted in canonical VENDOR_LANES order; zero-amount lanes with no
 * rows are omitted (UI elides zeros anyway). The region-scoped mirror of
 * `fetchAcrossChargebackLanes`.
 */
export async function fetchRegionalChargebackLanes(
  tx: Tx,
  scope: RegionalScope,
  window: UsageWindow,
  opts: { copilotChargeback: boolean },
): Promise<ChargebackLaneRow[]> {
  return fetchChargebackLanes(
    tx,
    clampedFinance(scope.financeScope('region_id', 'cost_owning_unit_id')),
    window,
    opts,
  )
}

// ── §B chargeback day-of-week (bill lane — "when spend happens", region-scoped) ─
/**
 * The region-scoped §B ANTHROPIC chargeback grouped by ISO day-of-week over the window
 * (`v_finance_bill_chargeback`, `EXTRACT(ISODOW) - 1` → Mon=0..Sun=6), scope-clamped by
 * the SAME finance predicate. Always seven buckets (zero-filled). Anthropic-only. The
 * region-scoped mirror of `fetchAcrossChargebackDow`; never summed with §A usage.
 */
export async function fetchRegionalChargebackDow(
  tx: Tx,
  scope: RegionalScope,
  window: UsageWindow,
): Promise<ChargeDowBucket[]> {
  const startDate = window.startIso.slice(0, 10)
  const endDate = window.endIso.slice(0, 10)
  const rows = await tx.execute<{ dow: number; charge: string }>(sql`
    SELECT (EXTRACT(ISODOW FROM period_date)::int - 1) AS dow,
           COALESCE(SUM(bill_usd), 0)::text AS charge
    FROM v_finance_bill_chargeback
    WHERE ${scope.financeScope('region_id', 'cost_owning_unit_id')}
      AND period_date >= ${startDate}::date AND period_date < ${endDate}::date
    GROUP BY 1`)
  const byDow = new Map<number, number>()
  for (const r of rows) byDow.set(Number(r.dow), Number(r.charge))
  return fillDowBuckets(byDow)
}

// ── Drivers (axis-switchable) ────────────────────────────────────────────────
/**
 * Ranked drivers for one axis, region-clamped, with in-scope denominators that
 * sum back to the genuine headline (build-design §7(4)).
 *
 * The clamp is `u.`-aliased because the engine aliases the §A lane `u` and three
 * of its branches JOIN a second relation — the same contract
 * `fetchRegionalDailyMetrics` passes. REGIONAL_DRIVER_AXES is what gates the axis
 * a request may name: the engine also knows a `region` axis, which is meaningless
 * inside a single-region clamp and is not offered here.
 */
export async function fetchRegionalDrivers(
  tx: Tx,
  scope: RegionalScope,
  range: UsageWindow,
  axis: RegionalDriverAxis,
  lens: SpendLens = 'usage',
  /** `copilotChargebackEnabled()` — gates the POOLED Copilot chargeback arm. */
  opts: { copilotChargeback?: boolean } = {},
): Promise<DriversResult> {
  return fetchDrivers(
    tx,
    clampedUsage(scope.usageScope('u.teammate_id')),
    range,
    axis,
    lens,
    {
      /*
       * The §B clamp, `u.`-aliased to match the pooled view's alias. It is the
       * OTHER pair of columns (`cost_owning_unit_id`, not `org_unit_id`): the
       * pooled Copilot charge homes through the org→CoU map, and a non-cost-
       * owning child unit exists in the §A clamp and not this one.
       */
      financeScope: clampedFinance(scope.financeScope('u.region_id', 'u.cost_owning_unit_id')),
      copilotChargeback: opts.copilotChargeback ?? false,
      // This scope's OWN gate, so a "break down by …" gap sentence can only name
      // a pivot this reader actually has. `region` is meaningless inside a
      // single-region clamp and has never been offered here.
      offeredAxes: REGIONAL_DRIVER_AXES,
    },
  )
}

// ── Trend (day grain, vendor-stacked) ────────────────────────────────────────
/*
 * Re-exported from `engine/trend-series`, where the fetcher now lives. Kept as a
 * named export here so existing importers of `TrendPoint` from this module are
 * untouched by the move.
 */
export type { TrendPoint } from './engine/trend-series'

/**
 * Per-day §A vendor split over the window, for the stacked bars — one point per
 * (day, lane) with a positive cost. Registry-driven (SECTION_A_USAGE_TOOLS, the
 * three-lane §A ceiling) + the live `other` catch-all, mirroring
 * `fetchAcrossTrend` one tier down but scope-clamped. `copilot-agent` is a real,
 * live `v_complete_usage` lane (migration 0101's ingest-only completeness arm),
 * so its points appear on any day the coding agent is used.
 */
export async function fetchRegionalTrend(
  tx: Tx,
  scope: RegionalScope,
  range: UsageWindow,
): Promise<{ series: TrendPoint[]; windowDays: number }> {
  return fetchSpendTrend(tx, clampedUsage(scope.usageScope('u.teammate_id')), range)
}

// ── Provider split (region-scoped, spend + active users) ─────────────────────
/**
 * The region-scoped per-provider split over the window (`usage_rollup_daily`,
 * the §A rollup — usage-rollup-lane.md R5): one bucket per named §A lane — `claude-code` → `claudeCode`,
 * `copilot-cli` → `copilotCli`, `copilot-agent` → `copilotAgent` (the three-lane
 * §A ceiling, registry-driven via SECTION_A_USAGE_TOOLS) — plus the live `other`
 * catch-all (incl. NULL tool). Mirrors the Across `fetchProviderSplit` one tier
 * down but clamped by the resolved regional scope. `spendUsd` sums back to the
 * region genuine headline; `activeUsers` is `COUNT(DISTINCT teammate_id)` per
 * bucket (NOT additive across buckets). `copilot-agent` is a real, live
 * `v_complete_usage` lane (migration 0101's ingest-only completeness arm) — its
 * bucket carries genuine spend once the coding agent is used.
 */
export async function fetchRegionalProviderSplit(
  tx: Tx,
  scope: RegionalScope,
  range: UsageWindow,
): Promise<ProviderSplit> {
  const [row] = [
    ...(await tx.execute<{
      cc_spend: string
      cc_users: number
      cp_spend: string
      cp_users: number
      ca_spend: string
      ca_users: number
      ot_spend: string
      ot_users: number
    }>(sql`
      SELECT
        COALESCE(SUM(u.cost_usd) FILTER (WHERE u.tool = ${CLAUDE_CODE_TOOL}), 0)::text AS cc_spend,
        COUNT(DISTINCT u.teammate_id) FILTER (WHERE u.tool = ${CLAUDE_CODE_TOOL})::int AS cc_users,
        COALESCE(SUM(u.cost_usd) FILTER (WHERE u.tool = ${COPILOT_CLI_TOOL}), 0)::text AS cp_spend,
        COUNT(DISTINCT u.teammate_id) FILTER (WHERE u.tool = ${COPILOT_CLI_TOOL})::int AS cp_users,
        COALESCE(SUM(u.cost_usd) FILTER (WHERE u.tool = ${COPILOT_AGENT_TOOL}), 0)::text AS ca_spend,
        COUNT(DISTINCT u.teammate_id) FILTER (WHERE u.tool = ${COPILOT_AGENT_TOOL})::int AS ca_users,
        COALESCE(SUM(u.cost_usd) FILTER (WHERE u.tool NOT IN (${laneListSql(SECTION_A_USAGE_TOOLS)}) OR u.tool IS NULL), 0)::text AS ot_spend,
        COUNT(DISTINCT u.teammate_id) FILTER (WHERE u.tool NOT IN (${laneListSql(SECTION_A_USAGE_TOOLS)}) OR u.tool IS NULL)::int AS ot_users
      FROM v_usage_rollup_current u
      WHERE ${scope.usageScope('u.teammate_id')}
        AND u.day >= ${range.startIso.slice(0, 10)}::date
        AND u.day <  ${range.endIso.slice(0, 10)}::date`)),
  ]
  return {
    claudeCode: { spendUsd: Number(row?.cc_spend ?? 0), activeUsers: Number(row?.cc_users ?? 0) },
    copilotCli: { spendUsd: Number(row?.cp_spend ?? 0), activeUsers: Number(row?.cp_users ?? 0) },
    copilotAgent: { spendUsd: Number(row?.ca_spend ?? 0), activeUsers: Number(row?.ca_users ?? 0) },
    other: { spendUsd: Number(row?.ot_spend ?? 0), activeUsers: Number(row?.ot_users ?? 0) },
  }
}

// ── Seasonality (day-of-week × ISO-week heatmap, region-scoped) ───────────────
/**
 * The region-scoped day-of-week × ISO-week seasonality grid over the window
 * (`v_complete_usage`), mirroring the Across variant one tier down. Grouped by ISO
 * week × ISO dow (Mon=0..Sun=6), summing `cost_usd`; the endpoint wraps the window.
 */
export async function fetchRegionalSeasonality(
  tx: Tx,
  scope: RegionalScope,
  window: UsageWindow,
): Promise<{ weeks: string[]; cells: SeasonalityCell[] }> {
  const rows = await tx.execute<{ iso_week: string; dow: number; value: string }>(sql`
    SELECT to_char(u.ts_event, 'IYYY-"W"IW') AS iso_week,
           (EXTRACT(ISODOW FROM u.ts_event)::int - 1) AS dow,
           COALESCE(SUM(u.cost_usd), 0)::text AS value
    FROM v_complete_usage_current u
    WHERE ${scope.usageScope('u.teammate_id')}
      AND u.ts_event >= ${window.startIso}::timestamptz
      AND u.ts_event <  ${window.endIso}::timestamptz
    GROUP BY 1, 2
    ORDER BY 1, 2`)
  return buildSeasonality([...rows])
}

// ── Active-user trend (region-scoped, distinct teammates per tool per day) ────
/**
 * The region-scoped active-users-over-time series (`usage_rollup_daily`,
 * usage-rollup-lane.md R5): per UTC
 * day, `COUNT(DISTINCT teammate_id)` for claude-code and copilot-cli. One point per
 * day with any in-scope usage; the two counts are NOT additive.
 */
export async function fetchRegionalActiveTrend(
  tx: Tx,
  scope: RegionalScope,
  window: UsageWindow,
): Promise<ActiveTrendPoint[]> {
  return fetchActiveTrend(tx, clampedUsage(scope.usageScope('u.teammate_id')), window)
}

// ── Exceptions (velocity-flagged, dial-driven) ───────────────────────────────
export interface RegionalException {
  teammateId: string
  name: string
  currentWeekUsd: number
  baselineMeanUsd: number
  deltaPct: number
  /**
   * `teammate.is_active` — carried for the DRILL CONTRACT (developer pages
   * D29/D34), not for the signal itself. A deactivated subject 403s at
   * `/reports/teammate/{id}`, so its name renders as plain text here rather
   * than as a link that cannot open.
   */
  isActive: boolean
  /**
   * `teammate.provisional` — D34's THIRD conjunct (r3-H2 / r5-H1), and the one
   * this strip was missing. A SHADOW teammate minted by the unauthenticated
   * enrol path is `is_active = true`, so the two conjuncts above admitted it and
   * the strip published an UNCONFIRMED email claim as a live link onto a page
   * that 403s. Both facts now come from the ONE shared producer
   * (`reporting/teammate-drill-facts.ts`) rather than from a per-query column
   * list, because a per-query column list is exactly how this one was forgotten.
   *
   * The ROW is not dropped, only the DOOR is closed — the same decision the
   * drivers axes take, and for a narrower reason: this strip is a top-N callout
   * that foots to nothing, so dropping the row would silently unreport a real
   * velocity spike. (Whether an unconfirmed identity should be NAMED here at all
   * is a separate question from whether it should be a LINK; it is raised, not
   * settled, by this change.)
   */
  isProvisional: boolean
}

/**
 * Teammates whose current-week usage spikes over their rolling 4-week mean by at
 * least the governance dial (`threshold`, a fractional delta — server/reports/
 * velocity.ts). A "now" signal (trailing weeks), NOT month-bounded. Bounded LIMIT
 * (default 25) because this is a CALLOUT list — the spikes worth someone's
 * attention this week — and a callout that runs to hundreds of rows is not one.
 * It is a relevance bound on a top-N, not a bound on what the caller may see:
 * the driver table beside it reports the same population in full.
 */
export async function fetchRegionalExceptions(
  tx: Tx,
  scope: RegionalScope,
  threshold: number,
  now: Date,
  limit = 25,
): Promise<RegionalException[]> {
  // ONE clock: the request's resolved instant, never the database's NOW() —
  // around a UTC week boundary the two can disagree, and the exceptions strip
  // would describe a different week than the KPI/trend data in the same
  // response (clock-and-day-boundary.md; the SQL clock is a SECOND clock).
  const nowIso = now.toISOString()
  const rows = await tx.execute<{
    teammate_id: string
    name: string
    current_week_usd: string
    rolling_mean_usd: string
    drill_is_active: boolean | null
    drill_is_provisional: boolean | null
  }>(sql`
    WITH weekly AS (
      -- The rollup, not the live view (usage-rollup-lane.md R5): the
      -- week buckets derive from the day column, and the lower bound is exact
      -- because date_trunc('week', <request instant>) is a UTC-midnight
      -- instant under the pinned session TimeZone (server/db/index.ts), so
      -- its ::date loses nothing.
      SELECT u.teammate_id,
             date_trunc('week', u.day::timestamp)::date AS week_start,
             SUM(u.cost_usd) AS week_usd
      FROM v_usage_rollup_current u
      WHERE ${scope.usageScope('u.teammate_id')}
        AND u.day >= (date_trunc('week', ${nowIso}::timestamptz) - INTERVAL '4 weeks')::date
      GROUP BY u.teammate_id, date_trunc('week', u.day::timestamp)
    ),
    velocity AS (
      SELECT teammate_id,
             COALESCE(SUM(week_usd) FILTER (WHERE week_start = date_trunc('week', ${nowIso}::timestamptz)::date), 0) AS current_week_usd,
             AVG(week_usd) FILTER (WHERE week_start < date_trunc('week', ${nowIso}::timestamptz)::date) AS rolling_mean_usd
      FROM weekly GROUP BY teammate_id
    )
    SELECT v.teammate_id::text AS teammate_id, COALESCE(t.display_name, t.email) AS name,
           v.current_week_usd::text AS current_week_usd,
           COALESCE(v.rolling_mean_usd, 0)::text AS rolling_mean_usd,
           -- The drill facts, from the ONE shared producer (teammate-drill-facts.ts).
           -- Not a hand-rolled column list: that is how provisional came to be
           -- missing here while every drivers axis carried it (r5-H1).
           -- (No backticks inside this literal -- one in a SQL comment CLOSES the
           -- sql template and the parse error points at the wrong line.)
           ${TEAMMATE_DRILL_FACTS}
    FROM velocity v JOIN teammate t ON t.id = v.teammate_id
    WHERE v.rolling_mean_usd IS NOT NULL AND v.rolling_mean_usd > 0
      AND (v.current_week_usd - v.rolling_mean_usd) / v.rolling_mean_usd >= ${threshold}
    ORDER BY (v.current_week_usd - v.rolling_mean_usd) / v.rolling_mean_usd DESC
    LIMIT ${limit}`)
  return [...rows].map((r) => {
    const current = Number(r.current_week_usd)
    const mean = Number(r.rolling_mean_usd)
    return {
      teammateId: r.teammate_id,
      name: r.name,
      currentWeekUsd: current,
      baselineMeanUsd: mean,
      deltaPct: mean > 0 ? (current - mean) / mean : 0,
      ...teammateDrillFacts(r),
    }
  })
}

// ── CSV serialisers (byte-identical to the JSON figures) ─────────────────────
/** `spend_usd` two-decimal, matching the on-screen `fmtUsd` precision. */
function usd(n: number): string {
  return n.toFixed(2)
}

/**
 * Drivers CSV — one row per driver, plus a leading provenance stamp (asOf).
 * Every row the caller's scope authorises is written: the file is byte-identical
 * to the on-screen table (build-design §2), at any size.
 */
export function driversToCsv(
  rows: DriverRow[],
  meta: {
    month: string
    asOfDate: string | null
    axis: string
    scopeLabel: string
    /**
     * WHICH LANE these figures are, stamped in the FILE because a CSV outlives
     * the page that produced it. In the chargeback lane most axes are BILLED
     * money (`provider_usage_fact`) and the budget axis is still ATTRIBUTED
     * usage; a spreadsheet that stacks two exports without knowing which is
     * which sums across lanes that were never meant to reconcile.
     */
    lane: MeasureLane
    /**
     * The per-provider arms behind a chargeback answer, and whose charge it is.
     * Serialised as a SECOND grain (`driverArmCsvLines`) because they are ON
     * SCREEN — the consumption blocks under the table, and the arms the headline
     * itself is folded from — and a file stamped `lane=billed` that carries only
     * the folded ranking is not the screen. Absent on every attributed export,
     * which therefore stays byte-for-byte what it was.
     */
    billedLane?: BilledLaneMeta
    chargebackCoverage?: ChargebackCoverage
  },
): string {
  const lines = [
    csvMetaLine(
      `# tokenscope regional drivers · axis=${meta.axis} · lane=${meta.lane} · month=${meta.month} · as_of=${meta.asOfDate ?? 'n/a'} · scope=${meta.scopeLabel}`
    ),
    'driver,spend_usd,share_pct,spend_class,otel_emitted_usd,api_reconciled_usd,provider_usage_usd,surface_mix',
    ...rows.map(
      (r) =>
        `${csvEscape(r.label)},${usd(r.usd)},${(r.sharePct * 100).toFixed(1)},${csvEscape(r.spendClass)},` +
        `${driverProvenanceCsvCells(r).join(',')},${csvEscape(driverSurfaceMixCsvCell(r))}`,
    ),
    ...driverArmCsvLines(meta.billedLane, meta.chargebackCoverage),
  ]
  return lines.join('\n') + '\n'
}

/*
 * Human vendor label per §A trend key for the CSV — keyed by the FULL
 * TrendPoint['key'] union (a compile-time exhaustiveness pin, r1-F9): widening
 * the wire union without a label here is a type error. 'Claude Code' (not the
 * pre-widening 'Claude') per the V6 honest-labelling sweep — a label-only diff;
 * the amounts are byte-identical.
 */
const TREND_CSV_LABELS: Record<TrendPoint['key'], string> = {
  'claude-code': 'Claude Code',
  'copilot-cli': 'GitHub Copilot',
  'copilot-agent': 'Copilot Coding Agent',
  other: 'Other',
}

/** Trend CSV — one row per (day, vendor). */
export function trendToCsv(
  series: TrendPoint[],
  meta: { month: string; asOfDate: string | null; scopeLabel: string },
): string {
  const lines = [
    csvMetaLine(
      `# tokenscope regional trend · month=${meta.month} · as_of=${meta.asOfDate ?? 'n/a'} · scope=${meta.scopeLabel}`
    ),
    'day,vendor,spend_usd',
    ...series.map((s) => `${s.day},${csvEscape(TREND_CSV_LABELS[s.key])},${usd(s.value)}`),
  ]
  return lines.join('\n') + '\n'
}

/** Practice-ranking CSV — one row per practice. */
export function practicesToCsv(
  rows: RankedRow[],
  meta: { month: string; asOfDate: string | null; scopeLabel: string },
): string {
  const lines = [
    csvMetaLine(
      `# tokenscope regional practices · month=${meta.month} · as_of=${meta.asOfDate ?? 'n/a'} · scope=${meta.scopeLabel}`
    ),
    'practice,spend_usd,spend_class',
    ...rows.map((r) => `${csvEscape(r.label)},${usd(r.value)},${csvEscape(r.spendClass)}`),
  ]
  return lines.join('\n') + '\n'
}
