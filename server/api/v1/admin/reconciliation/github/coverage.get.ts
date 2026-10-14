/*
 * GET /api/v1/admin/reconciliation/github/coverage[?enterpriseId=<uuid>] — the
 * PERSISTED latest GitHub enterprise-org coverage (Workstream D, design §6).
 *
 * Reads ONLY the mig-0108 observation tables (coverage-store.ts) — no live network
 * call, so this is safe to call on every admin page load (the banner + the
 * enterprises-table coverage column both hit this). `enterpriseId` omitted returns
 * every GitHub enterprise (the banner's shape); supplied, narrows to one (a table-row
 * detail read). An enterprise never swept still appears — with `available: false,
 * stale: false` (never observed, distinct from "observed once, now expired").
 *
 * CENSUS UNAVAILABLE/PARTIAL MUST SHOW UNKNOWN, NO DENOMINATOR (requirement 4):
 * coverage-store.ts's expiry logic already enforces this at read time (an expired row
 * reads available:false / state:'coverage-unknown' regardless of what was last
 * observed) — this route is a thin pass-through of that guarantee, never re-derives it.
 *
 * RBAC: requireRole(platform-admin) — same guard as the github health / unresolved
 * probes. Database access still uses request-scoped RLS context consistently.
 */
import { defineEventHandler, createError } from 'h3'
import { sql } from 'drizzle-orm'
import { z } from 'zod'
import { requireRole } from '../../../../../auth/rbac'
import { withRequestRls } from '../../../../../db/request-rls'
import { getValidated } from '../../../../../utils/validated-body'
import {
  loadPersistedEnterpriseCoverage,
  loadAllPersistedCoverage,
} from '../../../../../reconciliation/coverage-store'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const Query = z.object({ enterpriseId: z.string().regex(UUID_RE).optional() })

export default defineEventHandler(async (event) => {
  // Provider configuration is estate config (owner ruling 2026-10-08): coverage is per region-less provider_enterprise, so platform-admin is the only clamp.
  await requireRole(event, 'platform-admin')
  const query = await getValidated(event, Query)

  return withRequestRls(event, async (db) => {
    if (query.enterpriseId) {
      const rows = await db.execute<{ id: string }>(
        sql`SELECT id::text AS id FROM provider_enterprise WHERE id = ${query.enterpriseId}::uuid AND provider = 'github' LIMIT 1`,
      )
      if ([...rows].length === 0) {
        throw createError({
          statusCode: 404,
          statusMessage: 'Enterprise not found',
          data: {
            type: 'https://tokenscope.example.com/errors/not-found',
            title: 'Enterprise not found',
            status: 404,
            detail: 'No github provider_enterprise matches enterpriseId.',
          },
        })
      }
      const coverage = await loadPersistedEnterpriseCoverage(db, query.enterpriseId)
      return { coverage }
    }

    const coverage = await loadAllPersistedCoverage(db)
    return { coverage }
  })
})
