/*
 * POST /api/v1/admin/org-setup/preview — who would move if the proposed region
 * leaders and new Business Units were saved: every person decided under the live
 * config with the proposal applied (docs/design/org-setup/00-spec.md). Writes
 * nothing. Platform-admin only.
 */
import { createError, defineEventHandler } from 'h3'
import { z } from 'zod'
import { requireRole } from '../../../../auth/rbac'
import { assertSameOrigin } from '../../../../auth/csrf'
import { withRequestRls } from '../../../../db/request-rls'
import { readValidated } from '../../../../utils/validated-body'
import { requestClock } from '../../../../utils/request-clock'
import { fetchRegionOptions } from '../../../../reporting/regional'
import { loadOrgSetupPreview } from '../../../../reconciliation/org-setup-read'
import type { OrgSetupPreviewResponse } from '../../../../../shared/org-setup/contract'

/** Most leaders, and most new units, one preview takes. */
const ORG_SETUP_PREVIEW_MAX = 500

const Oid = z.string().trim().min(1).max(200)

const Body = z
  .object({
    leaders: z.array(z.object({ oid: Oid, regionId: z.string().uuid().nullable() }).strict()).max(ORG_SETUP_PREVIEW_MAX),
    newUnits: z
      .array(
        z
          .object({
            key: z.string().trim().min(1).max(100),
            ownerOid: Oid,
            regionId: z.string().uuid(),
            name: z.string().trim().min(1).max(200),
          })
          .strict(),
      )
      .max(ORG_SETUP_PREVIEW_MAX),
  })
  .strict()
  .refine((b) => new Set(b.newUnits.map((u) => u.key)).size === b.newUnits.length, {
    message: 'newUnits keys must be unique',
    path: ['newUnits'],
  })

export default defineEventHandler(async (event): Promise<OrgSetupPreviewResponse> => {
  await requireRole(event, 'platform-admin')
  assertSameOrigin(event)
  const body = await readValidated(event, Body)
  const { today } = requestClock(event)
  return withRequestRls(event, async (tx) => {
    const known = new Set((await fetchRegionOptions(tx)).map((r) => r.id))
    const unknown = [...body.leaders.map((l) => l.regionId), ...body.newUnits.map((u) => u.regionId)].find(
      (id) => id !== null && !known.has(id),
    )
    if (unknown) {
      throw createError({
        statusCode: 422,
        statusMessage: 'Unknown region',
        data: {
          type: 'https://tokenscope.example.com/errors/unprocessable',
          title: 'Unprocessable',
          status: 422,
          detail: `Region ${unknown} does not exist.`,
        },
      })
    }
    return loadOrgSetupPreview(tx, body, { today })
  })
})
