/*
 * Reporting nav visibility — ONE server-side verdict.
 *
 * The nav used to assemble this authorization decision in the browser from
 * three sources: `role` (free, from the session) plus TWO blocking HTTP calls
 * (`/me/cost-centres?count=1` for ownership, `/reports/meta` for grants). The
 * client then OR-ed them. That shape cost two round-trips on every cold load
 * and produced a real defect: the two fetches shared a Nuxt payload key, one
 * registered as resolved without ever requesting, and /reporting rendered
 * "You don't have access to any reports" to a platform-admin
 * (AppHeader.vue, pre-2026-08-29).
 *
 * A client that fetches its own authorization inputs and computes the verdict
 * can disagree with the server about who may see what. This resolves it once,
 * server-side, on the session probe the app already awaits.
 *
 * NORMAL-PATH BEHAVIOUR IS UNCHANGED BY CONSTRUCTION. The verdict is exactly the
 * old expression `reportingRole || isOwner || isGranted`, and the deep-link is
 * exactly the old `reportingRole ? null : isOwner ? 'cost-centre' : null`.
 *
 * THE DEGRADED PATH DOES DIFFER, and saying "unchanged" flatly would be false.
 * The three reads now share one failure boundary: if ownership succeeds and the
 * permissions read then throws, /auth/me catches the whole resolution and the
 * entry is hidden — whereas two independent header fetches could fail apart, and
 * a working ownership fetch would still have shown the link. That is the price
 * of one verdict instead of three inputs, and it errs closed.
 */
import type { H3Event } from 'h3'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { isReportingRole } from '../../shared/auth/roles'
import { computeOwnsCostCentre, resolveReportPermissions } from './report-scope'

type Tx = PostgresJsDatabase<Record<string, unknown>>

/** The nav's verdict: whether the Reporting entry renders, and where it points. */
export interface ReportingNav {
  /** Render the Reporting nav entry at all. */
  visible: boolean
  /**
   * Deep-link target for a non-reporting-role OWNER — their P&L view, the
   * affordance the retired Business-Unit P&L entry gave. `null` means link to
   * bare `/reporting` and let the shell self-land on its own `defaultScope`;
   * the server must never hardcode which scope that is.
   */
  scope: 'cost-centre' | null
}

/**
 * The verdict when the ROLE alone settles it, else null.
 *
 * A reporting role already satisfies `visible` AND forces `scope` to null, so
 * neither ownership nor grants can change the answer — the reads would be
 * wasted. Exported so a caller can skip opening a transaction it will not use,
 * without restating the role rule: this is the only place that arm is decided,
 * and `resolveReportingNav` goes through it too.
 */
export function reportingNavFromRoleAlone(role: string | null | undefined): ReportingNav | null {
  return isReportingRole(role) ? { visible: true, scope: null } : null
}

/**
 * Resolve the Reporting nav entry for one caller.
 *
 * Ownership goes through `computeOwnsCostCentre` — the canonical resolution
 * shared with /reports/meta — rather than a second copy of the predicate, so the
 * nav and the page it links to cannot disagree about which Business Unit a
 * caller owns BY HOLDING
 * DIFFERENT RULES. They can still disagree in time: the verdict is resolved once
 * per session probe, so a grant or ownership change after that is not reflected
 * until the session refreshes.
 */
export async function resolveReportingNav(
  event: H3Event,
  tx: Tx,
  teammateId: string,
  role: string | null | undefined,
): Promise<ReportingNav> {
  const byRole = reportingNavFromRoleAlone(role)
  if (byRole) return byRole

  const owns = await computeOwnsCostCentre(tx, teammateId)
  // Ownership alone settles both outputs; the permissions read could not change them.
  if (owns) return { visible: true, scope: 'cost-centre' }

  const permissions = await resolveReportPermissions(event, tx, teammateId)
  const granted = permissions.length > 0

  return { visible: granted, scope: null }
}
