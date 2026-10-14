/*
 * POST /api/v1/me/unaccounted/{id}/assign  { project_id?, activity? } — tag a per-day
 * "unaccounted usage" record (the provider API truth that OTel didn't capture; see
 * docs/design/provider-billing-attribution-model.md §A). Same correction primitive as a
 * session tag, but the unit is a (teammate, day, tool) reconciled record, not a
 * conversation:
 *   - project_id: uuid → attribute this day's unaccounted usage to a project budget
 *                        (membership-gated, same rule as sessions)
 *   - project_id: null → move it back to unallocated ("needs tagging")
 *   - activity: string → tag the activity axis; null = clear; omitted = preserve
 *
 * The logic lives in tagUnaccountedTx (shared with the bulk worklist action):
 * ownership + ended-budget + membership gates, then the update + audit, atomically.
 * At least one field must be present.
 */
import { ACTIVITY_LABEL_MAX, displayText } from '../../../../../../shared/schemas/display-text'
import { defineEventHandler, getRouterParam, createError } from 'h3'
import { z } from 'zod'
import { requireAuth } from '../../../../../auth/rbac'
import { assertSameOrigin } from '../../../../../auth/csrf'
import { withRequestRls } from '../../../../../db/request-rls'
import { readValidated } from '../../../../../utils/validated-body'
import { tagUnaccountedTx } from '../../../../../utils/tag-unaccounted'

const Body = z
  .object({
    project_id: z.string().uuid().nullable().optional(),
    activity: z.union([displayText(ACTIVITY_LABEL_MAX, { trim: true }), z.null()]).optional(),
  })
  .refine((b) => b.project_id !== undefined || b.activity !== undefined, {
    message: 'Provide project_id and/or activity (or null to clear).',
  })

export default defineEventHandler(async (event) => {
  assertSameOrigin(event)
  const session = await requireAuth(event)
  const idParsed = z.string().uuid().safeParse(getRouterParam(event, 'id'))
  if (!idParsed.success) throw createError({ statusCode: 400, statusMessage: 'Invalid record id' })
  const id = idParsed.data
  const body = await readValidated(event, Body)

  // withRequestRls IS the transaction — same atomicity, now carrying the
  // caller's RLS identity (docs/design/rls-enforcement.md §2, request lane).
  return await withRequestRls(event, (tx) =>
    tagUnaccountedTx(
      tx,
      session.teammateId,
      id,
      {
        setProject: body.project_id !== undefined,
        projectVal: body.project_id ?? null,
        setActivity: body.activity !== undefined,
        activityVal: body.activity ?? null,
      },
      { actorSystem: 'me-unaccounted-assign' },
    ),
  )
})
