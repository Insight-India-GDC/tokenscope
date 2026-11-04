/*
 * RBAC — requireRole / requireRegionScope.
 *
 * This gate IS the authorization boundary — the RLS policies do not execute, so
 * nothing sits behind it. requireRole returns 403 with the RFC-9457
 * Problem-Details body. Every denial writes one `authz-denied` warn line (no
 * audit row: 403s are frequent and expected, e.g. a scoped-out diagnostics card).
 *
 * Async now: requireAuth/tryAuth resolve from OIDC + DB enrichment
 * (see server/utils/auth.ts). The per-event cache there means
 * multiple rbac calls in the same handler share one DB lookup.
 *
 * Naming: `requireAuth` is re-exported from utils/auth for ergonomic
 * imports — `import { requireRole, requireAuth } from '../auth/rbac'`
 * stays a one-line idiom in handlers.
 */
import { createError, type H3Event } from 'h3'
import { consola } from 'consola'
import { requireAuth as utilsRequireAuth, type Session } from '../utils/auth'
import { isRole, isPlatformAdmin, type Role } from '../../shared/auth/roles'

export const requireAuth = utilsRequireAuth

function logDenied(event: H3Event, session: Session, gate: 'role' | 'region', need: string): void {
  consola.warn('[rbac] authz-denied', {
    event: 'authz-denied',
    teammateId: session.teammateId,
    role: session.role,
    regionId: session.regionId,
    path: event.path,
    gate,
    need,
  })
}

export async function requireRole(event: H3Event, ...allowed: Role[]): Promise<Session> {
  const session = await utilsRequireAuth(event)
  // platform-admin is the cross-region super-admin — satisfies every gate.
  if (isPlatformAdmin(session.role)) return session
  if (!isRole(session.role) || !allowed.includes(session.role)) {
    logDenied(event, session, 'role', allowed.join(','))
    throw createError({
      statusCode: 403,
      statusMessage: 'Forbidden',
      data: {
        type: 'https://tokenscope.example.com/errors/forbidden',
        title: 'Forbidden',
        status: 403,
        detail: `Role '${session.role}' is not permitted for this endpoint (need one of: ${allowed.join(', ')}).`,
      },
    })
  }
  return session
}

/*
 * requireRegionScope — admin-role callers are bounded to their home
 * region; platform-admin are region-unbounded. Apply
 * before reading region-scoped resources to keep the cross-region
 * check uniform across the admin endpoints.
 *
 * Explicit allowlist with a fail-closed default (CORE-3): any role NOT
 * listed here (developer / manager / finance / a future addition) is
 * DENIED rather than silently granted unbounded region scope — this
 * helper must not depend on every caller remembering requireRole.
 */
/**
 * requireRegionScope, but a region DENIAL is indistinguishable from the row not
 * existing at all.
 *
 * WHY: on a handler that has ALREADY resolved a row by id, a 403-for-foreign-region
 * beside a 404-for-unknown-id is an existence oracle — a region admin can enumerate
 * which ids exist in other regions purely from the status code, which is exactly what
 * the "resolve first, then scope" ordering was meant to avoid. Collapsing the two is
 * the same rule the /instances/* handlers apply to not-found vs not-owned.
 *
 * Pass the SAME `notFound` error the caller throws for an unknown id, so the two
 * paths are byte-identical rather than merely both-404. Throwing inside the caller's
 * transaction still rolls back any write already issued.
 *
 * `platform-admin` pass through unchanged.
 */
export async function requireRegionScopeOrNotFound(
  event: H3Event,
  regionId: string,
  notFound: unknown,
): Promise<void> {
  try {
    await requireRegionScope(event, regionId)
  } catch (err) {
    if ((err as { statusCode?: number })?.statusCode === 403) throw notFound
    throw err
  }
}

export async function requireRegionScope(event: H3Event, regionId: string): Promise<Session> {
  const session = await utilsRequireAuth(event)
  if (isPlatformAdmin(session.role)) return session
  if (session.role === 'admin') {
    if (session.regionId !== regionId) {
      logDenied(event, session, 'region', regionId)
      throw createError({
        statusCode: 403,
        statusMessage: 'Forbidden',
        data: {
          type: 'https://tokenscope.example.com/errors/region-scope',
          title: 'Region scope mismatch',
          status: 403,
          detail: 'Region admin scope does not include this region.',
        },
      })
    }
    return session
  }
  // Default DENY: unrecognized / unlisted roles get no region scope.
  logDenied(event, session, 'region', regionId)
  throw createError({
    statusCode: 403,
    statusMessage: 'Forbidden',
    data: {
      type: 'https://tokenscope.example.com/errors/region-scope',
      title: 'Region scope mismatch',
      status: 403,
      detail: `Role '${session.role}' has no region-scoped access.`,
    },
  })
}

export type { Session }
