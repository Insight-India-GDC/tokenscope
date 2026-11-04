/*
 * DELETE /api/v1/admin/projects/{id}/assignments/{teammateId} — end a
 * teammate's assignment (close the effective range rather than hard-
 * delete, preserving attribution history).
 *
 * Gate (spec A1): today's gate — manager / admin / platform-admin scoped to the
 * project — OR a current PM of this project. Last-PM rule (A5): a caller who is
 * not an admin of the project's region cannot end the last open-ended PM.
 */
import { defineEventHandler, createError, setResponseStatus, getRequestIP, getHeader } from 'h3'
import { sql } from 'drizzle-orm'
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

export default defineEventHandler(async (event) => {
  const caller = await requireAuth(event)
  assertSameOrigin(event)
  const at = requestClock(event).now
  const id = requireUuidParam(event, 'id', 'project id')
  const teammateId = requireUuidParam(event, 'teammateId', 'teammate id')
  const ip = getRequestIP(event, { xForwardedFor: true }) ?? null
  const ua = getHeader(event, 'user-agent') ?? null

  return await withRequestRls(event, async (tx) => {
    const proj = await loadProjectTarget(tx, id)
    if (!proj) {
      throw createError({ statusCode: 404, statusMessage: 'Project not found' })
    }
    // Lock before the gate. The caller's own PM standing and the manager counts
    // are judged at the post-lock instant, so a removal through the remove route
    // that this request waited on, or a manager added meanwhile, is seen.
    const lockedAt = await lockProjectRowAt(tx, id, at)
    const via = await assertProjectScopeOrManager(event, tx, proj, lockedAt)
    const managersBefore = await countOpenEndedManagers(tx, id, lockedAt)

    // End the open assignment range at now().
    const ended = await tx.execute<{ id: string }>(sql`
      UPDATE project_assignment
      SET effective = tstzrange(lower(effective), NOW())
      WHERE project_id = ${id}::uuid AND teammate_id = ${teammateId}::uuid AND upper_inf(effective)
      RETURNING id::text AS id
    `)
    if (![...ended][0]) {
      throw createError({ statusCode: 404, statusMessage: 'Active assignment not found' })
    }
    if (
      managersBefore > 0 &&
      (await countOpenEndedManagers(tx, id, lockedAt)) === 0 &&
      !isProjectAdmin(caller, proj.regionId)
    ) {
      throw lastManagerConflict()
    }

    // Drop any per-dev cap for this teammate on this project — a cap is
    // meaningless once they're unassigned, and leaving it would skew the
    // sum(caps) <= pool check on the next split.
    await tx.execute(sql`
      DELETE FROM allocation
      WHERE scope_type = 'project' AND scope_id = ${id}::uuid AND teammate_id = ${teammateId}::uuid
    `)

    // API-3: membership changes gate budgets and tagging — record WHO did it.
    await recordAuditEvent(tx, {
      eventType: 'project-member-removed',
      actorTeammateId: caller.teammateId,
      subjectKind: 'project',
      subjectId: id,
      payload: { teammate_id: teammateId, via },
      ipAddress: ip,
      userAgent: ua,
    })

    setResponseStatus(event, 204)
    return null
  })
})
