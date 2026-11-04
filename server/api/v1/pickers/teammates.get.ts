/*
 * GET /api/v1/pickers/teammates?q= — existing, active, confirmed teammates by
 * name or email, for PM pickers and member adds (A13). Any signed-in teammate:
 * names and emails are already open through the directory
 * (docs/security-model.md). It never provisions from the directory (A2).
 *
 * Contract (shared with the PM-powers track): { teammates: [{ id, display_name, email }] }.
 */
import { defineEventHandler } from 'h3'
import { sql } from 'drizzle-orm'
import { z } from 'zod'
import { requireAuth } from '../../../auth/rbac'
import { getValidated } from '../../../utils/validated-body'
import { withRequestRls } from '../../../db/request-rls'
import { LIKE_ESCAPE, escapeLikeLiteral } from '../../../utils/sql-like'

const Query = z.object({
  q: z.string().trim().min(2).max(100),
  limit: z.coerce.number().int().positive().max(25).default(10),
})

export default defineEventHandler(async (event) => {
  await requireAuth(event)
  const query = await getValidated(event, Query)
  return await withRequestRls(event, async (tx) => {
    const like = `%${escapeLikeLiteral(query.q)}%`
    const rows = await tx.execute<{ id: string; display_name: string | null; email: string }>(sql`
      SELECT id::text AS id, display_name, email
      FROM teammate
      WHERE is_active AND provisional IS NOT TRUE
        AND (display_name ILIKE ${like} ESCAPE ${LIKE_ESCAPE} OR email ILIKE ${like} ESCAPE ${LIKE_ESCAPE})
      ORDER BY display_name NULLS LAST, email
      LIMIT ${query.limit}
    `)
    return { teammates: [...rows] }
  })
})
