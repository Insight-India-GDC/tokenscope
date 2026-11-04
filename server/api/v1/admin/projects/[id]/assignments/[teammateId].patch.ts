/*
 * PATCH /api/v1/admin/projects/{id}/assignments/{teammateId} — change a
 * member's assignment role (member ↔ manager) on their OPEN assignment.
 *
 * Gate (spec A1): today's gate — manager / admin / platform-admin bound to the
 * project — OR a current PM of this project, who may make another member PM
 * (spec §4). Last-PM rule (A5): a caller who is not an admin of the project's
 * region cannot demote the last open-ended PM.
 */
import { defineEventHandler, createError, getRequestIP, getHeader } from 'h3'
import { readValidated } from '../../../../../../utils/validated-body'
import { sql } from 'drizzle-orm'
import { z } from 'zod'
import { requireAuth } from '../../../../../../auth/rbac'
import {
  assertProjectScopeOrManager,
  isProjectAdmin,
  loadProjectTarget,
} from '../../../../../../auth/project-authority'
import { assertSameOrigin } from '../../../../../../auth/csrf'
import { withRequestRls } from '../../../../../../db/request-rls'
import { recordAuditEvent } from '../../../../../../db/audit'
import { requireUuidParam } from '../../../../../../utils/require-uuid-param'
import { requestClock } from '../../../../../../utils/request-clock'
import {
  countOpenEndedManagers,
  lastManagerConflict,
  lockProjectRowAt,
} from '../../../../../../projects/last-manager'

const Body = z.object({
  role: z.enum(['manager', 'member']),
})

export default defineEventHandler(async (event) => {
  const caller = await requireAuth(event)
  assertSameOrigin(event)
  const at = requestClock(event).now
  const id = requireUuidParam(event, 'id', 'project id')
  const teammateId = requireUuidParam(event, 'teammateId', 'teammate id')
  const body = await readValidated(event, Body)
  const ip = getRequestIP(event, { xForwardedFor: true }) ?? null
  const ua = getHeader(event, 'user-agent') ?? null

  return await withRequestRls(event, async (tx) => {
    const proj = await loadProjectTarget(tx, id)
    if (!proj) {
      throw createError({ statusCode: 404, statusMessage: 'Project not found' })
    }
    // Lock before the gate. Everything after it, the caller's own PM standing,
    // the target's assignment and the manager count, is judged at the post-lock
    // instant, so a removal through the remove route that this request waited on
    // is seen (a just-removed member is not re-roled on their closed range).
    const lockedAt = await lockProjectRowAt(tx, id, at)
    const via = await assertProjectScopeOrManager(event, tx, proj, lockedAt)

    const updated = await tx.execute<{ id: string; prior_role: string }>(sql`
      UPDATE project_assignment pa
      SET role = ${body.role}
      FROM (
        SELECT id, role AS prior_role FROM project_assignment
        WHERE project_id = ${id}::uuid
          AND teammate_id = ${teammateId}::uuid
          AND effective @> ${lockedAt}::timestamptz
        LIMIT 1
      ) cur
      WHERE pa.id = cur.id
      RETURNING pa.id::text AS id, cur.prior_role
    `)
    const row = [...updated][0]
    if (!row) {
      throw createError({ statusCode: 404, statusMessage: 'No open assignment for this teammate' })
    }
    // Judged on the state AFTER the write, whatever it was before: demoting a
    // manager must leave a current, open-ended one. A last PM whose own
    // assignment is finite (so the project had no open-ended PM to begin with)
    // is held to the same rule.
    if (
      row.prior_role === 'manager' &&
      body.role !== 'manager' &&
      (await countOpenEndedManagers(tx, id, lockedAt)) === 0 &&
      !isProjectAdmin(caller, proj.regionId)
    ) {
      throw lastManagerConflict()
    }

    if (row.prior_role !== body.role) {
      await recordAuditEvent(tx, {
        eventType: 'project-member-role-changed',
        actorTeammateId: caller.teammateId,
        subjectKind: 'project',
        subjectId: id,
        payload: { teammate_id: teammateId, before: row.prior_role, after: body.role, via },
        ipAddress: ip,
        userAgent: ua,
      })
    }

    return { id: row.id, teammate_id: teammateId, role: body.role }
  })
})
