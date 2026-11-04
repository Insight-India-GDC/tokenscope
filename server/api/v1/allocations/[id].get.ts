/*
 * GET /api/v1/allocations/{id} — focused allocation row + siblings +
 * project metadata + assigned developer list + topup history + audit
 * trail (last 5 events).
 *
 * Drives the two-column allocation editor at /allocations/[id]
 * (design-notes §Screen 4). The "focused" row is the one the editor
 * acts on (typically the baseline); siblings (other rows for the
 * same project) are returned so the consumption-to-date can sum
 * them in aggregate.
 */
import { defineEventHandler, createError } from 'h3'
import { sql, type SQL } from 'drizzle-orm'
import { requireAuth } from '../../../auth/rbac'
import { allocationScopePredicate } from '../../../auth/allocation-scope'
import { isPlatformAdmin } from '../../../../shared/auth/roles'
import { withRequestRls } from '../../../db/request-rls'
import { requireUuidParam } from '../../../utils/require-uuid-param'
import { parseTstzrangeText } from '../../../utils/allocation-validation'

interface FocusedRow extends Record<string, unknown> {
  id: string
  scope_type: string
  scope_id: string
  budget_usd: string
  effective: string
  allocation_kind: string
  source: string
  is_pinned: boolean
  project_id: string | null
  project_code: string | null
  project_display_name: string | null
  allocation_mode: string | null
  region_code: string | null
  cou_code: string | null
  cou_display_name: string | null
}

interface PerDevCapRow extends Record<string, unknown> {
  allocation_id: string
  teammate_id: string
  email: string
  display_name: string | null
  budget_usd: string
}

interface SiblingRow extends Record<string, unknown> {
  id: string
  budget_usd: string
  effective: string
  allocation_kind: string
}

interface DevRow extends Record<string, unknown> {
  teammate_id: string
  email: string
  display_name: string | null
  role: string | null
}

interface TopupRow extends Record<string, unknown> {
  id: string
  budget_usd: string
  effective: string
  created_at: string
  actor_display_name: string | null
  reason: string | null
}

interface AuditRow extends Record<string, unknown> {
  id: string
  event_type: string
  ts_recorded: string
  actor_display_name: string | null
  payload: Record<string, unknown> | null
}

export default defineEventHandler(async (event) => {
  // J2/J5: the editor admits via org role OR a currently-effective PM
  // assignment on the allocation's project — same dual gate (and same
  // 404 existence-parity) as the topups POST on this path.
  const session = await requireAuth(event)
  const hasOrgRole =
    isPlatformAdmin(session.role) ||
    session.role === 'manager' ||
    session.role === 'admin'
  const id = requireUuidParam(event, 'id', 'allocation id')

  return await withRequestRls(event, async (tx) => {
    // Two gates, a true OR (R1 F4): org roles try the scope predicate;
    // the PM relationship is tried for EVERYONE on a miss (a manager-role
    // PM of a project outside their subtree must not be locked out of an
    // editor a developer-role PM can open). The PM arm proves the
    // relationship inside one query — a non-role caller costs exactly one
    // round-trip whether the id exists or not (no timing oracle).
    const selectFocused = (extraPredicate: SQL) =>
      tx.execute<FocusedRow>(sql`
        SELECT a.id::text AS id,
               a.scope_type, a.scope_id::text AS scope_id,
               a.budget_usd::text AS budget_usd,
               a.effective::text AS effective,
               a.allocation_kind, a.source, a.is_pinned,
               p.id::text AS project_id,
               p.code AS project_code,
               p.display_name AS project_display_name,
               p.allocation_mode AS allocation_mode,
               r.code AS region_code,
               cou.code AS cou_code,
               cou.display_name AS cou_display_name
        FROM allocation a
        LEFT JOIN project p ON p.id = a.scope_id AND a.scope_type = 'project'
        LEFT JOIN region r ON r.id = p.region_id
        LEFT JOIN org_unit cou ON cou.id = p.cost_owning_unit_id
        WHERE a.id = ${id}::uuid
          AND ${extraPredicate}
        LIMIT 1
      `)
    const pmPredicate = sql`
      a.scope_type = 'project'
      AND EXISTS (
        SELECT 1 FROM project_assignment pa
        WHERE pa.project_id = a.scope_id
          AND pa.teammate_id = ${session.teammateId}::uuid
          AND pa.role = 'manager'
          AND pa.effective @> now()
      )`

    let focusedRow: FocusedRow | undefined
    if (hasOrgRole) {
      focusedRow = [...(await selectFocused(allocationScopePredicate('a')))][0]
      if (!focusedRow) focusedRow = [...(await selectFocused(pmPredicate))][0]
    } else {
      focusedRow = [...(await selectFocused(pmPredicate))][0]
    }
    if (!focusedRow) {
      // 404 (not 403) so an out-of-scope id is indistinguishable from a
      // non-existent one — no existence oracle for other orgs' allocations.
      throw createError({ statusCode: 404, statusMessage: 'Allocation not found' })
    }

    const siblings =
      focusedRow.scope_type === 'project' && focusedRow.scope_id
        ? await tx.execute<SiblingRow>(sql`
            SELECT id::text AS id, budget_usd::text AS budget_usd,
                   effective::text AS effective, allocation_kind
            FROM allocation
            WHERE scope_type = 'project'
              AND scope_id = ${focusedRow.scope_id}::uuid
              AND teammate_id IS NULL
              AND id <> ${id}::uuid
              -- Only rows that share the displayed row's period: the editor
              -- adds these to it as that period's budget, so an expired or
              -- future row would inflate the figure.
              AND effective && ${focusedRow.effective}::tstzrange
            ORDER BY effective DESC
          `)
        : []

    const devs =
      focusedRow.project_id
        ? await tx.execute<DevRow>(sql`
            SELECT t.id::text AS teammate_id,
                   t.email,
                   t.display_name,
                   NULL::text AS role
            FROM project_assignment pa
            JOIN teammate t ON t.id = pa.teammate_id
            WHERE pa.project_id = ${focusedRow.project_id}::uuid
              -- effective @> now() (R2 F5): same "current member" predicate
              -- as the budget gates — future-dated assignments don't list.
              AND pa.effective @> now()
            ORDER BY t.display_name NULLS LAST, t.email
          `)
        : []

    // Topups are allocation rows with allocation_kind='top-up' for this project.
    const topups =
      focusedRow.scope_type === 'project' && focusedRow.scope_id
        ? await tx.execute<TopupRow>(sql`
            SELECT a.id::text AS id,
                   a.budget_usd::text AS budget_usd,
                   a.effective::text AS effective,
                   ae.ts_recorded::text AS created_at,
                   t.display_name AS actor_display_name,
                   COALESCE(
                     ae.payload->'context'->>'reason',
                     ae.payload->>'reason'
                   ) AS reason
            FROM allocation a
            LEFT JOIN audit_event ae ON ae.id = a.audit_event_id
            LEFT JOIN teammate t ON t.id = ae.actor_teammate_id
            WHERE a.scope_type = 'project'
              AND a.scope_id = ${focusedRow.scope_id}::uuid
              AND a.teammate_id IS NULL
              AND a.allocation_kind = 'top-up'
            -- Most-recent first; cap generous since top-ups now STACK
            -- (mig 0052) so a long-lived project can accrue many. The budget
            -- SUM (fetchProjectAllocation) is uncapped regardless — this only
            -- bounds the editor's history list.
            ORDER BY ae.ts_recorded DESC NULLS LAST
            LIMIT 200
          `)
        : []

    // Per-developer caps (per_dev_fixed mode) for this project + period.
    const perDevCaps =
      focusedRow.scope_type === 'project' && focusedRow.scope_id
        ? await tx.execute<PerDevCapRow>(sql`
            SELECT a.id::text AS allocation_id,
                   t.id::text AS teammate_id,
                   t.email,
                   t.display_name,
                   a.budget_usd::text AS budget_usd
            FROM allocation a
            JOIN teammate t ON t.id = a.teammate_id
            WHERE a.scope_type = 'project'
              AND a.scope_id = ${focusedRow.scope_id}::uuid
              AND a.teammate_id IS NOT NULL
              AND a.allocation_kind = 'baseline'
              AND a.effective = ${focusedRow.effective}::tstzrange
            ORDER BY t.display_name NULLS LAST, t.email
          `)
        : []

    const audit =
      focusedRow.project_id
        ? await tx.execute<AuditRow>(sql`
            SELECT ae.id::text AS id,
                   ae.event_type,
                   ae.ts_recorded::text AS ts_recorded,
                   t.display_name AS actor_display_name,
                   ae.payload
            FROM audit_event ae
            LEFT JOIN teammate t ON t.id = ae.actor_teammate_id
            WHERE (ae.subject_kind = 'project' AND ae.subject_id = ${focusedRow.project_id}::uuid)
               OR (ae.subject_kind = 'allocation'
                   AND ae.subject_id IN (
                     SELECT id FROM allocation
                     WHERE scope_type = 'project'
                       AND scope_id = ${focusedRow.scope_id}::uuid
                   ))
            ORDER BY ae.ts_recorded DESC
            LIMIT 5
          `)
        : []

    // FE-1 (server half): normalised ISO-8601 bounds parsed server-side from
    // the range. The raw `effective` text stays for compatibility, but clients
    // must consume these instead of regex-parsing the PG range literal (the
    // quoted-bound text only parses under V8 date leniency — Safari breaks).
    const effectiveBounds = parseTstzrangeText(focusedRow.effective)

    return {
      focused: {
        id: focusedRow.id,
        scope_type: focusedRow.scope_type,
        scope_id: focusedRow.scope_id,
        budget_usd: focusedRow.budget_usd,
        effective: focusedRow.effective,
        effective_from: effectiveBounds.from,
        effective_to: effectiveBounds.to,
        allocation_kind: focusedRow.allocation_kind,
        source: focusedRow.source,
        is_pinned: focusedRow.is_pinned,
        project_id: focusedRow.project_id,
        project_code: focusedRow.project_code,
        project_display_name: focusedRow.project_display_name,
        allocation_mode: focusedRow.allocation_mode,
        region_code: focusedRow.region_code,
        cou_code: focusedRow.cou_code,
        cou_display_name: focusedRow.cou_display_name,
      },
      siblings: [...siblings],
      devs: [...devs],
      topups: [...topups],
      per_dev_caps: [...perDevCaps],
      audit: [...audit],
    }
  })
})
