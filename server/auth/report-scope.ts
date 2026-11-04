/*
 * report-scope — the per-request enforcement layer for report ACCESS (mig 0129
 * replaces the three-mode admin dial, task #19). Resolves the caller's ACTIVE
 * `report_access_grant` permissions + cost-centre ownership, computes their
 * grants (shared/auth/report-visibility.ts), and gates the report scopes.
 *
 * The security boundary is NOT an import invariant — it is "every report-data
 * endpoint enforces effectiveReportGrants" (sg-M6/M8). This module is the shared
 * primitive those endpoints call:
 *   - resolveReportPermissions — this teammate's ACTIVE report_access_grant rows,
 *     one indexed query, memoised on the event, degrading to `[]` when the
 *     table is missing (upgrade/rollback safety — sg-L11), never throwing.
 *   - resolveReportGrants      — permissions + ACTIVE cost-centre ownership →
 *     grants. Used by the regional / cost-centre endpoints, which thread the
 *     grant into their EXISTING region clamps (the grant is a level, never a
 *     bypass).
 *   - costCentreScopeOpts      — the org-wide "ownership arm only" seal (A3 —
 *     see its own comment); server/reporting/cost-centres.ts's two resolvers
 *     thread it.
 *   - requireReportScope       — the hard 403 gate for the all-regions-required
 *     scopes (across + /reports/finance). It AUDITS every deny (sg-M4): those
 *     scopes have no in-query backstop, so the audit IS the forensic record.
 */
import { createError, getRequestIP, getHeader, type H3Event } from 'h3'
import { sql } from 'drizzle-orm'
import { consola } from 'consola'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { requireAuth, type Session } from '../utils/auth'
import { getDb } from '../db'
import { withRlsContext, rlsRoleFor } from '../db/rls'
import { recordAuditEvent } from '../db/audit'
import { isOrgWideRole } from '../../shared/auth/roles'
import {
  effectiveReportGrants,
  regionScopeGrant,
  REPORT_ACCESS_PERMISSIONS,
  type ReportAccessPermission,
  type ReportScopeGrants,
} from '../../shared/auth/report-visibility'

type Tx = PostgresJsDatabase<Record<string, unknown>>

/** The three report scopes a caller can be gated on (shared/reports/types.ts). */
export type ReportScopeName = 'region' | 'cost-centre' | 'finance'

/**
 * Which WIDTH of the Region scope is being requested. `all-regions` is the
 * unclamped, whole-company answer — the old `across` scope, now an option of the
 * region selector rather than a tab — and it is gated separately because it is the
 * only Region width with no in-query clamp behind it.
 */
export interface ReportScopeOpts {
  width?: 'all-regions' | 'region'
}

/**
 * True iff this request is asking for an answer that NO query predicate narrows —
 * the whole-company Region width, or the whole-company finance pack. These are the
 * denies that get audited: with no clamp underneath, the audit row is the only
 * record that the attempt happened (sg-M4).
 */
function isUnclampedRequest(scope: ReportScopeName, opts?: ReportScopeOpts): boolean {
  return scope === 'finance' || (scope === 'region' && opts?.width === 'all-regions')
}

const PERMISSIONS_CTX_KEY = '__tokenscope_report_access_permissions'

/**
 * This teammate's ACTIVE report-access permissions (`report_access_grant`,
 * mig 0129), memoised on the event. Fail-closed to `[]` on EVERY unexpected
 * shape — a MISSING table (migration not yet applied / rolled back) — the
 * SAME to_regclass table-existence guard `getReportVisibilityMode` used to run
 * (sg-L11 — /reports must still 200 at baseline, never throw). An unknown
 * literal (a permission this build does not know) is filtered out by the
 * declaration-order intersection, never passed through permissively.
 */
export async function resolveReportPermissions(
  event: H3Event,
  tx: Tx,
  teammateId: string,
): Promise<ReportAccessPermission[]> {
  if (!event.context) event.context = {} as H3Event['context']
  const cached = event.context[PERMISSIONS_CTX_KEY] as ReportAccessPermission[] | undefined
  if (cached) return cached

  let permissions: ReportAccessPermission[] = []
  const [present] = [
    ...(await tx.execute<{ present: boolean }>(sql`
      SELECT to_regclass('report_access_grant') IS NOT NULL AS present`)),
  ]
  if (present?.present) {
    const rows = await tx.execute<{ permission: string }>(sql`
      SELECT DISTINCT permission FROM report_access_grant
      WHERE teammate_id = ${teammateId}::uuid AND revoked_at IS NULL
        AND (expires_at IS NULL OR expires_at > now())`)
    // Canonical declaration order, not DB order: /reports/meta exposes this
    // array verbatim, so a nondeterministic DISTINCT would make the chip's
    // label order flap between requests. Unknown literals still drop out.
    const held = new Set([...rows].map((r) => r.permission))
    permissions = REPORT_ACCESS_PERMISSIONS.filter((p) => held.has(p))
    // else: absent table ⇒ [] (never throw, never permissive).
  }

  event.context[PERMISSIONS_CTX_KEY] = permissions
  return permissions
}

/**
 * True iff the caller holds an ACTIVE cost-centre ownership row (revoked_at IS NULL,
 * non-retired unit). Byte-identical to the meta.get.ts cou_owner check — a revoked /
 * expired row grants NOTHING (sg-L10).
 */
export async function computeOwnsCostCentre(tx: Tx, teammateId: string): Promise<boolean> {
  const [own] = [
    ...(await tx.execute<{ n: string }>(sql`
      SELECT COUNT(*)::text AS n FROM cou_owner co
      JOIN org_unit ou ON ou.id = co.org_unit_id
      WHERE co.teammate_id = ${teammateId}::uuid
        AND co.revoked_at IS NULL AND ou.retired_at IS NULL`)),
  ]
  return Number(own?.n ?? 0) > 0
}

/** ACTIVE permissions + ACTIVE ownership → the caller's per-scope grants. */
export async function resolveReportGrants(
  event: H3Event,
  tx: Tx,
  session: Session,
): Promise<ReportScopeGrants> {
  const ownsCostCentre = await computeOwnsCostCentre(tx, session.teammateId)
  const permissions = await resolveReportPermissions(event, tx, session.teammateId)
  return effectiveReportGrants({ role: session.role, ownsCostCentre, permissions })
}

/**
 * SEALS THE BU-LIST SEAM (A3): what `fetchVisibleCostCentres` /
 * `resolveCostCentreDrill` (server/reporting/cost-centres.ts) may widen their
 * in-query scope clause to, for THIS caller.
 *
 *   - `unbounded` — `grants.costCentre === 'all'` (an 'operational' grant):
 *     every Business Unit is visible.
 *   - `ownerOnly` — an ORG-WIDE role (`isOrgWideRole`) holding costCentre ONLY
 *     via its baseline ('owned-or-subtree', not elevated to 'all'). An
 *     org-wide role at baseline holds cost-centre visibility SOLELY through an
 *     active `cou_owner` row (`baselineGrants`'s own comment) — but
 *     `orgSubtreeScopePredicate`'s GUC arm is UNCONDITIONALLY TRUE for
 *     'global-finops' (org-subtree-scope.ts:49; platform-admin maps to it at
 *     the RLS layer, request-rls.ts:33), so passing that predicate through
 *     unmodified would silently widen an UNGRANTED org-wide caller to EVERY
 *     Business Unit. `ownerOnly: true` tells the resolvers to use the
 *     ownership arm ALONE — never the subtree predicate — for this one class.
 *     manager / admin / developer callers: always `false` (their
 *     'owned-or-subtree' comes from a real org subtree, which the predicate
 *     scopes correctly).
 */
export function costCentreScopeOpts(
  session: Pick<Session, 'role'>,
  grants: Pick<ReportScopeGrants, 'costCentre'>,
): { unbounded: boolean; ownerOnly: boolean } {
  return {
    unbounded: grants.costCentre === 'all',
    ownerOnly: isOrgWideRole(session.role) && grants.costCentre === 'owned-or-subtree',
  }
}

function scopePermitted(
  scope: ReportScopeName,
  grants: ReportScopeGrants,
  opts?: ReportScopeOpts,
): boolean {
  switch (scope) {
    case 'finance':
      // The whole-company /reports/finance pack — a simple boolean grant.
      return grants.finance === true
    case 'region': {
      /*
       * The SAME function that builds the caller's region selector decides what the
       * endpoint will serve — that is the whole point of "the selector's options ARE
       * the grant". A width the caller cannot pick in the UI is a width the endpoint
       * 403s, and neither can drift from the other, because there is only one of them.
       */
      const rg = regionScopeGrant(grants)
      return opts?.width === 'all-regions' ? rg.allRegions : rg.tab
    }
    case 'cost-centre':
      return grants.costCentre !== false
  }
}

/**
 * The hard 403 gate for a report scope. Used by the `/reports/region*` endpoints
 * (which pass `width` so the whole-company answer is gated on `across` and a single
 * region on `regional`) and the /reports/finance index + drill + export. Returns the
 * resolved session + grants so the caller can proceed without recomputing.
 *
 * Denies on an UNCLAMPED request — the whole-company Region width, or `finance` —
 * are ALWAYS audited (`report-scope-denied`, sg-M4): those answers have no in-query
 * clamp behind them, so the audit is the only record. The write goes on a SEPARATE
 * connection (getDb) so the deny survives the 403's request-transaction rollback.
 * When impersonating (sandbox persona override), the impersonator fields ride along
 * for forensics (sg-H2).
 */
export async function requireReportScope(
  event: H3Event,
  tx: Tx,
  scope: ReportScopeName,
  opts?: ReportScopeOpts,
): Promise<{ session: Session; grants: ReportScopeGrants }> {
  const session = await requireAuth(event)
  const ownsCostCentre = await computeOwnsCostCentre(tx, session.teammateId)
  const permissions = await resolveReportPermissions(event, tx, session.teammateId)
  const grants = effectiveReportGrants({ role: session.role, ownsCostCentre, permissions })

  if (!scopePermitted(scope, grants, opts)) {
    if (isUnclampedRequest(scope, opts)) {
      try {
        /*
         * A SEPARATE transaction, on purpose — and NOT the caller's `tx`.
         *
         * This deny throws a 403 two statements below, which rolls the caller's
         * transaction back. Writing the escalation-attempt record inside it
         * would erase the only evidence the attempt happened, so it has to land
         * on its own connection. What changed is that the connection now
         * carries the CALLER's RLS identity (docs/design/rls-enforcement.md §4)
         * instead of being the bare pool: separate transaction, yes;
         * identity-less, no.
         */
        await withRlsContext(
          getDb(),
          {
            userRegionId: session.regionId,
            userOrgPath: session.orgPath,
            userRole: rlsRoleFor(session.role),
            userTeammateId: session.teammateId,
          },
          (auditTx) => recordAuditEvent(auditTx as unknown as Tx, {
          eventType: 'report-scope-denied',
          actorTeammateId: session.teammateId,
          subjectKind: 'report-scope',
          subjectId: null,
          payload: {
            scope,
            // The WIDTH the deny was for. `scope` alone stopped being enough when
            // across/regional merged: both widths of `region` now arrive under one
            // scope name, and only the unclamped one is the escalation attempt.
            ...(opts?.width ? { width: opts.width } : {}),
            permissions,
            role: session.role,
            ownsCostCentre,
            grants,
            ...(session.impersonatorOid ? { impersonatorOid: session.impersonatorOid } : {}),
            ...(session.impersonatorEmail ? { impersonatorEmail: session.impersonatorEmail } : {}),
          },
          ipAddress: getRequestIP(event, { xForwardedFor: true }) ?? null,
          userAgent: getHeader(event, 'user-agent') ?? null,
          }),
        )
      } catch (err) {
        // Best-effort forensics: an audit failure must never mask the 403 (the
        // deny still returns below). But for across/finance the audit IS the only
        // record of a denied privilege-escalation attempt — so a write failure is
        // itself a security-critical event ops must be able to alert on. Emit a
        // DISTINCTIVE, stable marker with ids-only structured fields (no PII).
        consola.error('[SECURITY-AUDIT-WRITE-FAILED] report-scope deny-audit write failed', {
          scope,
          // The width rides the marker too: `scope: 'region'` alone no longer says
          // whether the denied answer was the unclamped one.
          ...(opts?.width ? { width: opts.width } : {}),
          actorTeammateId: session.teammateId,
          ...(session.impersonatorOid ? { impersonatorOid: session.impersonatorOid } : {}),
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }
    throw createError({
      statusCode: 403,
      statusMessage: 'Forbidden',
      data: {
        type: 'https://tokenscope.example.com/errors/forbidden',
        title: 'Forbidden',
        status: 403,
        detail:
          scope === 'region' && opts?.width === 'all-regions'
            ? "The whole-company ('All regions') width of the 'region' report scope requires an active 'operational' report access grant, which you do not hold."
            : scope === 'finance'
              ? "The 'finance' report scope requires an active 'finance' report access grant, which you do not hold."
              : `Your report access does not include the '${scope}' scope.`,
      },
    })
  }

  return { session, grants }
}
