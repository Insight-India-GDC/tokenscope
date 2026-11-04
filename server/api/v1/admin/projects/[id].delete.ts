/*
 * DELETE /api/v1/admin/projects/:id — HARD delete a $0-SPEND project (D4 of
 * docs/design/project-lifecycle.md, revised for the lingering-test-project case).
 *
 * Allowed when the project has NO real usage — the two HARD blockers:
 *   - attribution_record  (no spend ever attributed → no money history to lose)
 *   - repo_project_map    (no repo tagged to it → nothing to un-route)
 * The budget allocation, member assignments, any setup tokens and per-conversation
 * session tags are CASCADE-removed (safe when zero spend; and there is no UI to
 * drop a budget, so requiring manual teardown made deletion impractical — the
 * exact friction the reported empty-$0 project hit). Otherwise → 409 (End it
 * instead). Authorization is the same class as create/edit/end (D8):
 * requireRole('admin') + requireRegionScope — a region admin
 * still can't delete outside their region even when deletable.
 */
import {
  defineEventHandler,
  createError,
  getRouterParam,
  getRequestIP,
  getHeader,
} from 'h3'
import { sql } from 'drizzle-orm'
import { z } from 'zod'
import { requireRole, requireRegionScope } from '../../../../auth/rbac'
import { assertSameOrigin } from '../../../../auth/csrf'
import { withRequestRls } from '../../../../db/request-rls'
import { recordAuditEvent } from '../../../../db/audit'
import { lockProjectRow } from '../../../../projects/last-manager'

export default defineEventHandler(async (event) => {
  const caller = await requireRole(event, 'admin')
  assertSameOrigin(event)

  const parsedId = z.string().uuid().safeParse(getRouterParam(event, 'id'))
  if (!parsedId.success) {
    throw createError({
      statusCode: 400,
      statusMessage: 'Invalid project id',
      data: {
        type: 'https://tokenscope.example.com/errors/invalid-input',
        title: 'Invalid project id',
        status: 400,
        detail: 'Expected a canonical UUID in the URL path.',
      },
    })
  }
  const projectId = parsedId.data
  const ip = getRequestIP(event, { xForwardedFor: true }) ?? null
  const ua = getHeader(event, 'user-agent') ?? null

  return await withRequestRls(event, async (tx) => {
    const existing = await tx.execute<{ id: string; code: string; region_id: string }>(sql`
      SELECT id::text AS id, code, region_id::text AS region_id
      FROM project WHERE id = ${projectId}::uuid LIMIT 1
    `)
    const projectRow = [...existing][0]
    if (!projectRow) {
      throw createError({
        statusCode: 404,
        statusMessage: 'Project not found',
        data: {
          type: 'https://tokenscope.example.com/errors/not-found',
          title: 'Project not found',
          status: 404,
          detail: 'No project matches the supplied id (or RLS denied access).',
        },
      })
    }

    // Region-scope check — a region admin cannot delete outside their region.
    await requireRegionScope(event, projectRow.region_id)

    // Lock the project row before touching any child, in the same order as every
    // other project write (projects/last-manager.ts). Deleting children first and
    // the project last would deadlock against a budget-request approval, which
    // holds this lock and then writes the project's allocation rows.
    await lockProjectRow(tx, projectId)

    // Delete is allowed for a $0-SPEND project (D4, revised): the HARD blockers
    // are real spend (`attribution_record`) and an active repo tag
    // (`repo_project_map`) — deleting either would silently lose money history or
    // un-route a live repo. Everything else (the budget allocation, member
    // assignments, any setup tokens / per-conversation session tags) is CASCADE-
    // removed: with zero spend, an allocation is unused budget and assignments
    // are reversible, so tearing them down is safe and is the only practical way
    // to retire a lingering empty test project (there is no UI to drop a budget).
    const refs = await tx.execute<{
      attribution_refs: string
      repo_refs: string
      allocation_refs: string
      assignment_refs: string
      inbox_refs: string
    }>(sql`
      SELECT
        (SELECT COUNT(*) FROM attribution_record WHERE project_id = ${projectId}::uuid)::text
          AS attribution_refs,
        (SELECT COUNT(*) FROM repo_project_map  WHERE project_id = ${projectId}::uuid)::text
          AS repo_refs,
        (SELECT COUNT(*) FROM allocation
           WHERE scope_type = 'project' AND scope_id = ${projectId}::uuid)::text
          AS allocation_refs,
        (SELECT COUNT(*) FROM project_assignment WHERE project_id = ${projectId}::uuid)::text
          AS assignment_refs,
        (SELECT COUNT(*) FROM inbox_item
           WHERE related_entity_kind = 'project' AND related_entity_id = ${projectId}::uuid)::text
          AS inbox_refs
    `)
    const r = [...refs][0]!
    const blockers: string[] = []
    if (Number(r.attribution_refs) > 0) blockers.push('attributed spend')
    if (Number(r.repo_refs) > 0) blockers.push('tagged repos')

    if (blockers.length > 0) {
      throw createError({
        statusCode: 409,
        statusMessage: 'Project has spend or tagged repos',
        data: {
          type: 'https://tokenscope.example.com/errors/conflict',
          title: 'Cannot delete',
          status: 409,
          detail: `Cannot delete: project still has ${blockers.join(' and ')}. End the project instead (set an end date).`,
          blockers,
        },
      })
    }

    // Record the audit FIRST (the project row + its children are about to vanish;
    // the append-only audit_event keeps the who/when/what), capturing the cascade.
    await recordAuditEvent(tx, {
      eventType: 'project-deleted',
      actorTeammateId: caller.teammateId,
      subjectKind: 'project',
      subjectId: projectId,
      payload: {
        code: projectRow.code,
        region_id: projectRow.region_id,
        cascaded: {
          allocations: Number(r.allocation_refs),
          member_assignments: Number(r.assignment_refs),
          inbox_items: Number(r.inbox_refs),
        },
        // Always false here (the spend blocker guarantees zero attribution), but
        // recorded so the code-burn backstop (D6, projects.post.ts) keys off a
        // stable field if a future override path ever deletes an attributed project.
        had_attribution: Number(r.attribution_refs) > 0,
      },
      ipAddress: ip,
      userAgent: ua,
    })

    // Cascade-remove every child that FKs to project (except the two blockers,
    // which are already proven absent) BEFORE deleting the project row, so the
    // NO-ACTION FKs don't reject the delete. The (scope_type, scope_id)-keyed
    // rows (allocation, limit_policy) and the polymorphic inbox_item refs aren't
    // FKs but are cleared too, so nothing dangles at a vanished project.
    try {
      await tx.execute(sql`DELETE FROM session_assignment WHERE project_id = ${projectId}::uuid`)
      await tx.execute(sql`DELETE FROM project_assignment WHERE project_id = ${projectId}::uuid`)
      await tx.execute(sql`DELETE FROM allocation   WHERE scope_type = 'project' AND scope_id = ${projectId}::uuid`)
      await tx.execute(sql`DELETE FROM limit_policy WHERE scope_type = 'project' AND scope_id = ${projectId}::uuid`)
      await tx.execute(sql`DELETE FROM inbox_item
        WHERE related_entity_kind = 'project' AND related_entity_id = ${projectId}::uuid`)
      await tx.execute(sql`DELETE FROM project WHERE id = ${projectId}::uuid`)
    } catch (err: unknown) {
      // TOCTOU: the joiner can commit an attribution_record (or a repo can be
      // tagged) between the emptiness count and this DELETE. The NO-ACTION FK
      // then rejects the project delete (code 23503) and the tx rolls back —
      // FK-safe, no orphan. Translate the raw error into the same clean 409.
      if ((err as { code?: string })?.code === '23503') {
        throw createError({
          statusCode: 409,
          statusMessage: 'Project gained spend or a repo concurrently',
          data: {
            type: 'https://tokenscope.example.com/errors/conflict',
            title: 'Cannot delete',
            status: 409,
            detail: 'The project gained spend or a tagged repo while deleting. End it instead.',
          },
        })
      }
      throw err
    }

    return {
      id: projectId,
      code: projectRow.code,
      deleted: true,
      cascaded: {
        allocations: Number(r.allocation_refs),
        member_assignments: Number(r.assignment_refs),
        inbox_items: Number(r.inbox_refs),
      },
    }
  })
})
