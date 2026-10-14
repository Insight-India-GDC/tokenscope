/*
 * POST /api/v1/admin/reconciliation/github/coverage-recheck — force a FRESH,
 * live coverage recompute for ONE GitHub enterprise (Workstream D, design §6/§8.4:
 * "Coverage is computed from a fresh capability probe... cached success can never
 * outlive a failed current probe").
 *
 * Body (zod): { enterpriseId }. Bypasses any in-memory cache by construction — this
 * route builds a BRAND NEW GithubAppAuth/GithubCopilotClient per call (the same
 * pattern the Verify probe uses), so a permission revoked five seconds ago is
 * reflected in this response, never shadowed by a stale prior success.
 *
 * Persists the fresh result (coverage-store.ts) so the GET route + admin UI + the
 * sweep worker's transition detection all see it immediately, and returns it directly
 * so the caller does not need a second round-trip.
 *
 * NOTE ON THE FLAT FILENAME (not github/coverage/recheck.post.ts): every sibling route
 * in this directory is a flat file (discover-orgs.post.ts, map.post.ts, ...) — a
 * `coverage/` SUBDIRECTORY would also collide with this repo's .gitignore `coverage/`
 * entry (the test-coverage-report convention), silently untracking the route AND
 * excluding it from lint. Named coverage-recheck.post.ts for both reasons.
 *
 * RBAC: requireRole(platform-admin) + assertSameOrigin. Audited (request +
 * outcome, mirroring copilot-bill-repull.post.ts).
 */
import { defineEventHandler, createError, getRequestIP, getHeader } from 'h3'
import { sql } from 'drizzle-orm'
import { z } from 'zod'
import { requireRole } from '../../../../../auth/rbac'
import { assertSameOrigin } from '../../../../../auth/csrf'
import { withRequestRls } from '../../../../../db/request-rls'
import { readValidated } from '../../../../../utils/validated-body'
import { recordAuditEvent } from '../../../../../db/audit'
import {
  computeEnterpriseCoverage,
  type CoverageEnterpriseRow,
} from '../../../../../reconciliation/github-coverage'
import {
  loadPersistedEnterpriseCoverage,
  persistEnterpriseCoverage,
} from '../../../../../reconciliation/coverage-store'
import { reconcileCoverageTransitions } from '../../../../../reconciliation/coverage-alerts'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const Body = z.object({ enterpriseId: z.string().regex(UUID_RE) })

interface Row extends Record<string, unknown> {
  id: string
  provider: string
  external_id: string
  github_app_id: string | null
}

export default defineEventHandler(async (event) => {
  // Provider configuration is estate config (owner ruling 2026-10-08): it live-probes and persists coverage for a region-less provider_enterprise, so platform-admin is the only clamp.
  const caller = await requireRole(event, 'platform-admin')
  assertSameOrigin(event)
  const body = await readValidated(event, Body)
  const ip = getRequestIP(event, { xForwardedFor: true }) ?? null
  const ua = getHeader(event, 'user-agent') ?? null

  return withRequestRls(event, async (db) => {
    const rows = await db.execute<Row>(sql`
      SELECT id::text AS id, provider, external_id, github_app_id
      FROM provider_enterprise WHERE id = ${body.enterpriseId}::uuid LIMIT 1
    `)
    const row = [...rows][0]
    if (!row) {
      throw createError({
        statusCode: 404,
        statusMessage: 'Enterprise not found',
        data: {
          type: 'https://tokenscope.example.com/errors/not-found',
          title: 'Enterprise not found',
          status: 404,
          detail: 'No provider_enterprise matches enterpriseId.',
        },
      })
    }
    if (row.provider !== 'github') {
      throw createError({
        statusCode: 400,
        statusMessage: 'Not a GitHub enterprise',
        data: {
          type: 'https://tokenscope.example.com/errors/validation',
          title: 'Not a GitHub enterprise',
          status: 400,
          detail: 'Coverage recheck is GitHub-only.',
        },
      })
    }

    const ent: CoverageEnterpriseRow = {
      enterpriseId: row.id,
      externalId: row.external_id,
      githubAppId: row.github_app_id,
    }

    await recordAuditEvent(db, {
      eventType: 'github-coverage-recheck-triggered',
      actorTeammateId: caller.teammateId,
      subjectKind: 'provider-enterprise',
      subjectId: row.id,
      payload: { externalId: row.external_id },
      ipAddress: ip,
      userAgent: ua,
    })

    const prior = await loadPersistedEnterpriseCoverage(db, ent.enterpriseId)
    const result = await computeEnterpriseCoverage(db, ent)
    const now = new Date()
    await db.transaction(async (tx) => {
      await persistEnterpriseCoverage(tx, result, { now })
      await reconcileCoverageTransitions(tx, ent, prior, result, now)
    })

    await recordAuditEvent(db, {
      eventType: 'github-coverage-recheck-completed',
      actorTeammateId: caller.teammateId,
      subjectKind: 'provider-enterprise',
      subjectId: row.id,
      payload: {
        externalId: row.external_id,
        censusAvailable: result.census.available,
        censusReason: result.census.reason,
        denominator: result.summary.denominator,
        connected: result.summary.connected,
        states: result.summary.states,
        probesCapped: result.probesCapped,
      },
      ipAddress: ip,
      userAgent: ua,
    })

    return { result }
  })
})
