/*
 * GET /api/v1/reports/meta — the ONE bootstrap fetch for the reporting shell
 * (docs/design/reporting-consolidation/00-build-design.md §2).
 *
 * Returns:
 *   - scopes            → the GRANTED scopes only (role + CC-ownership derived).
 *   - defaultScope      → best-granted (region → cost-centre → finance).
 *   - monthFloors       → MIN over the lanes (usage / bill / reconciliation),
 *                         daily-cacheable; `overall` = the picker floor.
 *   - providerStates    → settling states for the current month (settling.ts).
 *   - copilotMode       → 'pool-utilisation' | 'chargeback' (copilot-mode.ts).
 *
 * `requireAuth` — every scope re-enforces its own gate; this is the UX bootstrap.
 * Reads views/aggregate tables only — no `attribution_record` / raw `actual_spend`
 * (the lane firewall, build-design §7(7)).
 */
import { defineEventHandler, setHeader } from 'h3'
import { sql } from 'drizzle-orm'
import { requireAuth } from '../../../auth/rbac'
import { withRequestRls } from '../../../db/request-rls'
import { resolveReportGrants, resolveReportPermissions } from '../../../auth/report-scope'
import { regionScopeGrant } from '../../../../shared/auth/report-visibility'
import { providerStatesForMonth } from '../../../reports/settling'
import { copilotFinanceMode } from '../../../reports/copilot-mode'
import { monthKeyUtc } from '../../../utils/period'
import { REPORT_SCOPES, type ReportScope } from '../../../../shared/reports/types'

interface FloorRow extends Record<string, unknown> {
  usage: string | null
  bill: string | null
  reconciliation: string | null
}

export default defineEventHandler(async (event) => {
  const session = await requireAuth(event)
  const now = new Date()
  const currentMonth = monthKeyUtc(now)

  return await withRequestRls(event, async (tx) => {
    // The granted tabs now come from the ONE source of truth
    // (effectiveReportGrants, via resolveReportGrants), so the shell can never
    // light up a tab the endpoint would 403. CC ownership (a RELATIONSHIP, not
    // a role) still feeds the cost-centre grant. Byte-identical to the old
    // inline map for a caller with no report-access grants at all (the
    // baseline).
    //
    // Concurrent issuance on ONE tx connection: postgres-js pipelines and
    // answers in order (docs/design/request-floor-performance.md F5). The
    // floors read shares nothing with the grant resolution; permissions below
    // are NOT in the wave — resolveReportGrants resolves them internally and
    // memoises them on the event, so a concurrent call would re-issue the same
    // query instead of hitting that memo.
    const [g, floorRows] = await Promise.all([
      resolveReportGrants(event, tx, session),
      tx.execute<FloorRow>(sql`
        SELECT (SELECT month_floor FROM v_usage_month_floor) AS usage,
               (SELECT to_char(MIN(period_month), 'YYYY-MM') FROM v_finance_bill_totals_month) AS bill,
               (SELECT to_char(MIN(period_date), 'YYYY-MM') FROM reconciliation_record) AS reconciliation`),
    ])
    const permissions = await resolveReportPermissions(event, tx, session.teammateId)

    /*
     * Map the per-scope grant object onto the tab booleans, in REPORT_SCOPES order
     * (region → cost-centre → finance) — that order IS the default-scope preference,
     * so `scopes[0]` is the best-granted of three.
     *
     * The Region tab is `regionScopeGrant(...).tab` and NOT a fresh reading of the
     * two underlying grants: the same function decides the tab here, the selector's
     * options on the response, and the endpoint's own 403. A tab lit by one rule and
     * gated by another is how the shell comes to show a scope that 403s on click.
     * The finance TAB is the whole-company /reports/finance pack — a boolean grant.
     */
    const grants: Record<ReportScope, boolean> = {
      region: regionScopeGrant(g).tab,
      'cost-centre': g.costCentre !== false,
      finance: g.finance,
    }
    const scopes = REPORT_SCOPES.filter((s) => grants[s])
    const defaultScope = scopes[0] ?? null

    /*
     * Month floors — the picker's lower bound. Fetched in the wave above.
     *
     * The usage floor reads `v_usage_month_floor` (mig 0133), not
     * `MIN(ts_event) FROM v_complete_usage`: MIN over that 4-arm UNION with
     * GROUP BY CTEs can use no index, so Postgres materialised the whole estate
     * on every load of the reporting shell — the ~2 minute /reporting load.
     */
    const [floors] = [...floorRows]
    const monthFloors = {
      usage: floors?.usage ?? null,
      bill: floors?.bill ?? null,
      reconciliation: floors?.reconciliation ?? null,
    }
    const overall =
      [monthFloors.usage, monthFloors.bill, monthFloors.reconciliation]
        .filter((m): m is string => Boolean(m))
        .sort()[0] ?? currentMonth

    /*
     * NO `defaultRegionId` here. This endpoint used to return the caller's home
     * region (or the first real region for a cross-region caller) as a shell-wide
     * region default. Two things killed it:
     *
     *   - Nothing ever consumed it. The shell deliberately does not seed a region
     *     (region is a PER-SCOPE key; a shell-wide default leaked into Finance and
     *     silently narrowed its per-CoU table — tests/unit/pages/reporting-shell).
     *   - It is now WRONG. The Regional default splits on the caller's ROLE, never
     *     on where their own record happens to sit: an ORG-WIDE role
     *     (`ORG_WIDE_ROLES` — platform-admin AND platform-admin) answers for no
     *     single region, so it opens on the FIRST region by (display_name, code);
     *     only a REGION-BOUND role opens on its own home region. That rule lives in
     *     resolveRegionalScope, which reflects the effective region back on every
     *     Regional response. A second, differently-computed answer to the same
     *     question — cached here for an hour — is exactly the "wrong region under a
     *     wrong name" hazard that rule exists to remove.
     *
     * Any consumer that needs the effective region reads it from
     * `/reports/region` (`region` + `regionOptions` + `allRegionsAvailable`), which
     * is the region the figures beside it were actually computed for — and, since
     * the Across merge, the WIDTH they were computed at.
     */

    /*
     * NOT cacheable, despite the floors being daily-stable. This response also
     * carries AUTHORISATION state — `scopes`, `defaultScope` and `permissions`
     * — which changes the instant an admin grants or revokes report access.
     *
     * It used to say `private, max-age=3600`, which was true of the payload when
     * that line was written (floors + settling config) and became false when the
     * grant fields moved in. The cost was real: a browser holding an hour-old
     * empty-scopes response renders "You don't have access to any reports" with
     * NO request to this endpoint at all, so a freshly granted admin sees the
     * refusal until the entry expires or they force a reload.
     *
     * `no-store` matches every sibling that returns per-caller report data
     * (teammate/[id]/index.get.ts:112,271; teammate/[id]/export.get.ts:73). The
     * floors are one aggregate query — not worth an hour of stale authorisation.
     */
    setHeader(event, 'cache-control', 'no-store')

    /*
     * The Region scope's LANDING WIDTH — "All regions" or one region — and nothing
     * more.
     *
     * This is deliberately NOT a default region id. `defaultRegionId` was removed
     * from this contract (see the block above) because the effective region is
     * resolved by `resolveRegionalScope` and reflected back on the response the
     * figures came with; a second answer computed here and cached for an hour is
     * free to name a region nothing was computed for. That reasoning is untouched.
     *
     * The WIDTH is a different question and it does belong here: it is a pure
     * function of the caller's grants (`regionScopeGrant(...).landing`), it changes
     * only when an admin changes the policy, and the shell needs it BEFORE its first
     * report request — otherwise the only way to learn it is to fetch one width,
     * discover the caller holds the other, and patch the URL, which re-issues every
     * query on the page. That exact "wait for the response, then patch" loop is the
     * defect ScopeRegional's header records; one bootstrap field removes the need for it.
     */
    const rg = regionScopeGrant(g)

    return {
      scopes,
      defaultScope,
      region: {
        /** Where a bare `?scope=region` lands: the whole-company width, or one region. */
        landing: rg.landing,
        /** Whether "All regions" is one of this caller's selector options at all. */
        allRegions: rg.allRegions,
      },
      monthFloors: { ...monthFloors, overall },
      /*
       * THE DRILL CONTRACT's two grant columns (developer pages D29/D38).
       *
       * The client needs them BEFORE it can render a single reports row: every
       * teammate/project name is a link or plain text BY GRANT, and a name that
       * renders as a link and then 403s is the live-looking dead button the
       * contract exists to remove. Two enum values, from the SAME
       * `effectiveReportGrants` the endpoints enforce — never a second
       * client-side reading of the role.
       *
       * The rest of the grant object stays server-side: the client's job is to
       * decide link-or-text, not to hold the policy.
       */
      drill: { teammate: g.teammate, project: g.project },
      providerStates: providerStatesForMonth(currentMonth, now),
      copilotMode: copilotFinanceMode(),
      // The caller's ACTIVE report-access permissions (mig 0129) — drives the
      // "Visibility: ... · admin-configured" chip on the reports header. Only
      // included when NON-EMPTY: a caller with no explicit grant at all is not
      // signalled (so an admin-granted permission never leaks by default),
      // while ANY held permission IS signalled by design (the chip shows for
      // everyone who holds one). The Vue chip reads `meta.value?.permissions`
      // optionally, so absence ⇒ no chip.
      ...(permissions.length ? { permissions } : {}),
    }
  })
})
