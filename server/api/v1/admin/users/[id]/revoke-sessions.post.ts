/*
 * POST /api/v1/admin/users/:id/revoke-sessions — explicit Wave-VII
 * force-sign-out for a single teammate.
 *
 * Mutation contour:
 *   a) requireRole(admin) — app-level gate, 403 on miss.
 *   b) assertSameOrigin — block cross-origin POST CSRF.
 *   c) Validate path UUID + optional body.reason (z.string().max(200)).
 *   d) Inside ONE withRequestRls transaction:
 *      - SELECT target row (id, region_id, email, role) — 404 on miss.
 *      - requireRegionScope on the target row's region (admin caller is
 *        bounded to their home region; platform-admin is unbounded).
 *      - evaluateRevokeSessions(caller, target) — refuses a region admin
 *        acting on a higher-role holder (403).
 *      - recordAuditEvent (eventType='teammate-sessions-revoked',
 *        payload={ reason, byUser:false, ... }).
 *      - UPDATE teammate SET revoked_at = NOW(), emit_revoked_at = NOW().
 *
 * Self-revoke IS allowed: forcing your own sessions to sign-out is a
 * legitimate operator action (e.g. you suspect your laptop is
 * compromised — force-revoke from another device).
 *
 * The role-change and region-move PATCHes bump `teammate.revoked_at`
 * too, but NOT `emit_revoked_at` and they do not end devices (#414): only
 * this endpoint and teammate retirement stop a device's emission.
 *
 * Returns { ok: true } on success. validate-session middleware on the
 * target's NEXT /api/v1/** request returns 401 + clears the cookie.
 */
import {
  createError,
  defineEventHandler,
  getRouterParam,
  readValidatedBody,
} from 'h3'
import { sql } from 'drizzle-orm'
import { z } from 'zod'
import { requireRole, requireRegionScope } from '../../../../../auth/rbac'
import { assertSameOrigin } from '../../../../../auth/csrf'
import { withRequestRls } from '../../../../../db/request-rls'
import { evaluateRevokeSessions } from '../../../../../auth/admin-guards'
import { recordAuditEvent } from '../../../../../db/audit'
import { endLiveDevicesOf } from '../../../../../utils/device-lifecycle'
import type { Role } from '../../../../../../shared/auth/roles'

// Body shape: { reason?: string } where reason is bounded to 200 chars.
// The body is intentionally optional — an operator-driven revoke from
// the admin UI may not have a textual justification, and we don't want
// to fail the mutation on its absence. When provided, the reason rides
// on the audit row's payload.
const Body = z.object({
  reason: z.string().max(200).optional(),
})

interface TargetRow extends Record<string, unknown> {
  id: string
  region_id: string
  email: string
  role: Role
}

export default defineEventHandler(async (event) => {
  const caller = await requireRole(event, 'admin')
  // CSRF check BEFORE any DB I/O — same pattern as [id].patch.ts.
  assertSameOrigin(event)

  const id = z.string().uuid().safeParse(getRouterParam(event, 'id'))
  if (!id.success) {
    throw createError({
      statusCode: 400,
      statusMessage: 'Invalid teammate id',
      data: {
        type: 'https://tokenscope.example.com/errors/invalid-input',
        title: 'Invalid teammate id',
        status: 400,
        detail: 'Expected a canonical UUID in the URL path.',
      },
    })
  }
  const teammateId = id.data

  // Body is optional (no body at all is valid — an empty POST). readValidatedBody
  // calls Body.parse with the actual body; when the request carries no body,
  // h3 returns undefined and Zod's `.optional()` chain treats it as the empty
  // object, which is fine — every field is optional already.
  let body: z.infer<typeof Body>
  try {
    body = await readValidatedBody(event, (data) =>
      Body.parse(data ?? {}),
    )
  } catch (err) {
    // Body validation failure (e.g. reason > 200 chars) → 400 with RFC-9457.
    throw createError({
      statusCode: 400,
      statusMessage: 'Invalid body',
      data: {
        type: 'https://tokenscope.example.com/errors/invalid-input',
        title: 'Invalid body',
        status: 400,
        detail: (err as Error).message,
      },
    })
  }

  await withRequestRls(event, async (tx) => {
    const targetRows = await tx.execute<TargetRow>(sql`
      SELECT id::text AS id, region_id::text AS region_id, email, role
      FROM teammate WHERE id = ${teammateId}::uuid LIMIT 1
    `)
    const target = [...targetRows][0]
    if (!target) {
      throw createError({
        statusCode: 404,
        statusMessage: 'Teammate not found',
        data: {
          type: 'https://tokenscope.example.com/errors/not-found',
          title: 'Teammate not found',
          status: 404,
          detail: 'No teammate matches the supplied id (or RLS denied access).',
        },
      })
    }

    // Region-scope check — admin caller cannot revoke a row outside
    // their home region. (platform-admin is unbounded.)
    await requireRegionScope(event, target.region_id)

    const verdict = evaluateRevokeSessions(
      { role: caller.role, teammateId: caller.teammateId },
      { id: target.id, regionId: target.region_id, role: target.role },
    )
    if (!verdict.allowed) {
      throw createError({
        statusCode: verdict.status,
        statusMessage: 'Refused',
        data: {
          type: `https://tokenscope.example.com/errors/${verdict.reason}`,
          title: 'Refused',
          status: verdict.status,
          detail: 'Session revocation refused.',
          reason: verdict.reason,
        },
      })
    }

    // Audit FIRST, then the UPDATE. Both run inside the same tx so
    // either both commit or neither does — no false audit rows.
    await recordAuditEvent(tx, {
      eventType: 'teammate-sessions-revoked',
      actorTeammateId: caller.teammateId,
      actorSystem: 'admin-ui',
      subjectKind: 'teammate',
      subjectId: target.id,
      payload: {
        reason: body.reason ?? null,
        // `byUser: false` distinguishes explicit operator action from a
        // hypothetical future "user self-revoke from their own session
        // settings" path. Wave-VII has only the operator route; the
        // flag is set so audit-log consumers can already discriminate.
        byUser: false,
        targetEmail: target.email,
        regionId: target.region_id,
        // selfRevoke is informational — the audit payload makes it easy
        // to spot in retrospective forensics (admin force-signed-out
        // their own session). Not a security gate; surfaced only.
        selfRevoke: caller.teammateId === target.id,
      },
    })

    // Both anchors: revoke-sessions is the explicit "end everything" action, so
    // it reaches device emission too (emit_revoked_at, mig 0152 / #414). A role
    // or region change bumps revoked_at alone.
    await tx.execute(sql`
      UPDATE teammate SET revoked_at = NOW(), emit_revoked_at = NOW() WHERE id = ${target.id}::uuid
    `)

    // E2 (ADR-0005): eager cascade — revoking the teammate also ENDS their
    // active emit instances (ts_actual_end), so /bearer 401s, the joiner skips
    // them, and the dashboard reflects it immediately rather than relying on
    // someone noticing. The /bearer + joiner revoked_at live-check is the
    // guarantee; this cascade is the hygiene.
    await endLiveDevicesOf(tx as never, target.id)
    // E2 (ADR-0005): same eager cascade for the OAuth emit credential — revoke
    // the teammate's live oauth_token rows so neither a cached access token
    // (requireOAuthBearer rejects revoked_at) nor the durable refresh token
    // (refreshAccessToken requires revoked_at IS NULL) keeps working. Belt to
    // refreshAccessToken's teammate-revocation join's suspenders.
    await tx.execute(sql`
      UPDATE oauth_token SET revoked_at = NOW()
      WHERE teammate_id = ${target.id}::uuid AND revoked_at IS NULL
    `)
  })

  return { ok: true }
})
