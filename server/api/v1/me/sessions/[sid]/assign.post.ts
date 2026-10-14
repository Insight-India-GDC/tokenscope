/*
 * POST /api/v1/me/sessions/{sid}/assign  { project_id?, activity? } — tag OR
 * RE-TAG a Claude conversation. The universal correction primitive:
 *   - project_id: uuid  → assign / re-point to a project budget (membership-gated)
 *   - project_id: null  → move OFF budget (unallocated)
 *   - activity:   string→ tag an activity (orthogonal axis)
 *   - activity:   null  → clear the activity
 *   - field omitted     → preserve that axis
 * At least one field must be present.
 *
 * Since the joiner itemises ALL spend into attribution_record (mig 0021), every
 * conversation already has ledger rows. This UPDATEs them directly (the change is
 * immediate) and records the decision in session_assignment (durable for future
 * joiner runs — the joiner dedups with ON CONFLICT DO NOTHING, so it never reverts
 * these rows for already-recorded events). Known limit: on a STILL-EMITTING
 * conversation whose repo emits a project.code_hash (B′), brand-new events keep
 * following that hash until tracked separately — correcting a past/closed
 * conversation is fully durable.
 *
 * Ownership is AR-based: the conversation must have attribution_record rows for
 * THIS teammate (the joiner writes them from the unspoofable attestation), which
 * also covers itemised unallocated rows. Membership gate (tag proposes, membership
 * disposes) applies only when SETTING a non-null project.
 */
import { ACTIVITY_LABEL_MAX, displayText } from '../../../../../../shared/schemas/display-text'
import { createError, defineEventHandler, readValidatedBody, getRouterParam } from 'h3'
import { z } from 'zod'
import { requireAuth } from '../../../../../auth/rbac'
import { assertSameOrigin } from '../../../../../auth/csrf'
import { withRequestRls } from '../../../../../db/request-rls'
import { tagSessionTx } from '../../../../../utils/tag-session'

const Body = z
  .object({
    // uuid = set/re-point; null = move off budget; omitted = preserve.
    project_id: z.string().uuid().nullable().optional(),
    // non-empty string = tag; null = clear; omitted = preserve.
    activity: z.union([displayText(ACTIVITY_LABEL_MAX, { trim: true }), z.null()]).optional(),
  })
  .refine((b) => b.project_id !== undefined || b.activity !== undefined, {
    message: 'Provide project_id and/or activity (or null to clear).',
  })

export default defineEventHandler(async (event) => {
  assertSameOrigin(event)
  const session = await requireAuth(event)
  // The conversation id (Claude's session.id) — a non-empty string, not a uuid in
  // our schema (we never mint it; Claude does). Bound the length defensively.
  const sidParsed = z.string().min(1).max(256).safeParse(getRouterParam(event, 'sid'))
  if (!sidParsed.success) throw createError({ statusCode: 400, statusMessage: 'Invalid conversation id' })
  const conversationId = sidParsed.data
  const body = await readValidatedBody(event, (d) => Body.parse(d))

  // ONE transaction for the whole re-tag (shared with the MCP tag_session tool):
  // the ownership read, the ENDED-target FOR UPDATE, the boundary-preserving
  // ledger UPDATE, the session_assignment write, and the audit are atomic —
  // and withRequestRls makes that transaction carry the caller's RLS identity.
  return await withRequestRls(event, (tx) =>
    tagSessionTx(
      tx,
      session.teammateId,
      conversationId,
      {
        setProject: body.project_id !== undefined,
        projectVal: body.project_id ?? null,
        setActivity: body.activity !== undefined,
        activityVal: body.activity ?? null,
      },
      { actorSystem: 'me-sessions-assign' },
    ),
  )
})
