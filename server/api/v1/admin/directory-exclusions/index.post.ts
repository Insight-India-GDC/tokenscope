/*
 * POST /api/v1/admin/directory-exclusions — add a directory-exclusion pattern
 * (mig 0083). Org-wide config (the directory is org-wide, not region-scoped),
 * so platform-admin only, mirroring the platform-baseline
 * governance dials. Validated against the match-all footgun, audited.
 *
 * Returns `matched_existing_count`: how many ACTIVE teammates the new pattern
 * matches TODAY (by stored email — the CLD/privileged rows store their
 * onmicrosoft address as email), so the UI can warn before a fat-fingered
 * pattern silently excludes real people. It does NOT block — the admin may
 * intend a broad pattern — but the count makes the blast radius visible.
 */
import { defineEventHandler, createError, getRequestIP, getHeader } from 'h3'
import { readValidated } from '../../../../utils/validated-body'
import { sql } from 'drizzle-orm'
import { z } from 'zod'
import { requireRole } from '../../../../auth/rbac'
import { isPlatformAdmin } from '../../../../../shared/auth/roles'
import { assertSameOrigin } from '../../../../auth/csrf'
import { withRequestRls } from '../../../../db/request-rls'
import { recordAuditEvent } from '../../../../db/audit'
import { translatePgConstraintError } from '../../../../utils/pg-constraint-error'
import { upnGlobToSqlLike, validateExclusionPattern } from '../../../../utils/directory-exclusions'
import { LIKE_ESCAPE } from '../../../../utils/sql-like'

const Body = z.object({
  pattern: z.string().trim().min(1).max(200),
  note: z.string().trim().max(500).optional(),
})

export default defineEventHandler(async (event) => {
  const caller = await requireRole(event, 'admin')
  // Org-wide config — not a region admin's to set (mirrors the platform dial baseline).
  if (!(isPlatformAdmin(caller.role))) {
    throw createError({
      statusCode: 403,
      statusMessage: 'Forbidden',
      data: {
        type: 'https://tokenscope.example.com/errors/forbidden',
        title: 'Forbidden',
        status: 403,
        detail: 'Directory-exclusion patterns are org-wide config; requires an Admin.',
      },
    })
  }
  assertSameOrigin(event)
  const body = await readValidated(event, Body)
  const ip = getRequestIP(event, { xForwardedFor: true }) ?? null
  const ua = getHeader(event, 'user-agent') ?? null

  // Match-all footgun guard (also enforced in the compiler — defense in depth).
  const invalid = validateExclusionPattern(body.pattern)
  if (invalid) {
    throw createError({
      statusCode: 400,
      statusMessage: 'Invalid exclusion pattern',
      data: {
        type: 'https://tokenscope.example.com/errors/validation',
        title: 'Invalid exclusion pattern',
        status: 400,
        detail: invalid,
      },
    })
  }
  const pattern = body.pattern.trim()

  return await withRequestRls(event, async (tx) => {
    let created: { id: string } | undefined
    try {
      ;[created] = [
        ...(await tx.execute<{ id: string }>(sql`
          INSERT INTO directory_exclusion_pattern (pattern, note, created_by)
          VALUES (${pattern}, ${body.note ?? null}, ${caller.teammateId}::uuid)
          RETURNING id::text AS id
        `)),
      ]
    } catch (err: unknown) {
      translatePgConstraintError(err, {
        '23505': {
          status: 409,
          title: 'Pattern already exists',
          detail: 'That exclusion pattern is already configured.',
        },
      })
    }

    // Blast-radius preview: count ACTIVE teammates whose stored email matches,
    // computed in the DB (not by loading the roster into memory). Emails are the
    // stored proxy for UPN (CLD rows store the onmicrosoft address as email).
    //
    // LIKE_ESCAPE is bound as a PARAMETER, never written as a literal `ESCAPE
    // '\'` — that literal collapses to `ESCAPE ''` before Postgres ever sees
    // it, silently disabling upnGlobToSqlLike's escaping and under-reporting
    // this preview's blast radius (an admin would then approve a pattern
    // blind — see server/utils/sql-like.ts).
    const like = upnGlobToSqlLike(pattern)
    const matchRows = await tx.execute<{ n: string }>(sql`
      SELECT count(*)::text AS n FROM teammate
      WHERE is_active = TRUE AND NOT provisional AND lower(email) LIKE ${like} ESCAPE ${LIKE_ESCAPE}
    `)
    const matchedExisting = Number([...matchRows][0]?.n ?? '0')

    await recordAuditEvent(tx, {
      eventType: 'directory-exclusion-added',
      actorTeammateId: caller.teammateId,
      subjectKind: 'platform',
      payload: { pattern, note: body.note ?? null, matched_existing_count: matchedExisting },
      ipAddress: ip,
      userAgent: ua,
    })

    return {
      id: created!.id,
      pattern,
      note: body.note ?? null,
      matched_existing_count: matchedExisting,
    }
  })
})
