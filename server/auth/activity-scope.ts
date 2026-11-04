/*
 * requireActivityScope — the global-vs-region authz split for the activity-tag
 * vocabulary (activity_type). One decision point reused by the create / edit /
 * delete handlers so the rule can't drift between them.
 *
 * The vocabulary has two scopes:
 *   - GLOBAL  (region_id IS NULL) — the seeded standard set. Only the org-wide
 *     roles (platform-admin) may mutate it. A region `admin` is
 *     bounded to their own region and must NOT edit the global vocabulary.
 *   - REGION  (region_id = a uuid) — a region's own additions. A region `admin`
 *     may mutate ONLY their own region (requireRegionScope); org-wide roles may
 *     act on any region.
 *
 * requireRole(event, 'admin') must already have run upstream so
 * the caller is a known admin-class Session (platform-admin satisfies it via
 * isPlatformAdmin). This helper adds the scope gate on top.
 *
 * Why a dedicated helper rather than requireRegionScope alone: requireRegionScope
 * only blocks an `admin` whose regionId !== the target. For a GLOBAL entry the
 * target region is null, which requireRegionScope can't express — so the global
 * case needs an explicit "org-wide roles only" gate, kept here next to the
 * region case for a single, auditable rule.
 */
import { createError, type H3Event } from 'h3'
import { requireRegionScope } from './rbac'
import type { Session } from '../utils/auth'

export async function requireActivityScope(
  event: H3Event,
  caller: Session,
  regionId: string | null,
): Promise<void> {
  if (regionId === null) {
    // GLOBAL scope — region admins are excluded. Only org-wide roles
    // (platform-admin) may touch the standard vocabulary.
    if (caller.role === 'admin') {
      throw createError({
        statusCode: 403,
        statusMessage: 'Forbidden',
        data: {
          type: 'https://tokenscope.example.com/errors/forbidden',
          title: 'Global vocabulary is org-wide only',
          status: 403,
          detail:
            'Region admins cannot manage the global (standard) activity vocabulary. ' +
            'An Admin must do so.',
        },
      })
    }
    return
  }

  // REGION scope — a region admin is bounded to their own region; org-wide roles
  // pass. Delegates to the shared region-scope gate so the rule stays uniform
  // with the projects / instances admin endpoints.
  await requireRegionScope(event, regionId)
}
