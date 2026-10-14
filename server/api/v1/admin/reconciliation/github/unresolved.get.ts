/*
 * GET /api/v1/admin/reconciliation/github/unresolved?enterpriseId=<uuid> — the UNRESOLVED
 * github Copilot logins for ONE enterprise: those the live provider roster reports with
 * Copilot spend/seats but which the identity map does NOT bind to a teammate (either lane).
 * The identity-tail layer-3 surface: an admin maps each to an existing teammate via the sibling
 * POST /map, which writes the ENTERPRISE lane so the reconciler then attributes their spend.
 *
 * WHY LIVE (not a DB list): an unmapped login is SKIPPED before reconciliation_record is written
 * (github.ts `if (!teammateId) continue`), so it is not persisted anywhere — it lives only in
 * the live provider roster. See server/reconciliation/github-unresolved.ts.
 *
 * SAFETY: listUnresolvedCopilotLogins never returns/logs a PAT, App key, PEM, installation
 * token, or a raw provider body — only logins + numeric context. A credential/roster/upstream
 * failure surfaces as a clean, FIXED-reason status (never a partial list read as "none left").
 * RBAC: requireRole(platform-admin) — same guard as the github health route. GET (read-
 * only probe) → no assertSameOrigin, matching health.get.ts.
 *
 * NO RLS LANE, tracked as an explicit residue in scripts/check-handler-rls-context.mjs, for
 * the same reason as its sibling github/health.get.ts: `listUnresolvedCopilotLogins`
 * interleaves DB reads with GitHub HTTP across the probe, and holding a request transaction
 * across third-party HTTP is the anti-pattern docs/design/rls-enforcement.md §2 names. Both
 * routes want the same restructure and should get it together, with the six worker-invoking
 * admin handlers §2 lists — following the `DbRunner` shape admin/diagnostics/
 * provider-wire-shape.post.ts already uses (a per-read short transaction, closed before the
 * fetch that follows it).
 *
 * Phase-1 safe, phase-2 NOT: `provider_enterprise` carries no RLS policy, but the probe shares
 * `resolveGithubRoster` with the reconciler, which reads `teammate`. Once `teammate` is FORCEd
 * the roster comes back empty on a context-less connection and EVERY login would be reported
 * as unresolved — a wrong answer that reads as a real finding.
 */
import { defineEventHandler, getValidatedQuery, createError } from 'h3'
import { sql } from 'drizzle-orm'
import { z } from 'zod'
import { requireRole } from '../../../../../auth/rbac'
import { getDb } from '../../../../../db'
import type { GithubEnterpriseRow } from '../../../../../reconciliation/github-health'
import { listUnresolvedCopilotLogins, UnresolvedProbeError } from '../../../../../reconciliation/github-unresolved'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const Query = z.object({ enterpriseId: z.string().regex(UUID_RE) })

interface Row extends Record<string, unknown> {
  id: string
  provider: string
  external_id: string
  github_app_id: string | null
}

export default defineEventHandler(async (event) => {
  // Provider configuration is estate config (owner ruling 2026-10-08): it reads enterprise-grain logins of every region, so platform-admin is the only clamp.
  await requireRole(event, 'platform-admin')
  const query = await getValidatedQuery(event, (data) => {
    const parsed = Query.safeParse(data)
    if (!parsed.success) {
      throw createError({ statusCode: 400, statusMessage: 'invalid query parameter' })
    }
    return parsed.data
  })
  const db = getDb()

  const rows = await db.execute<Row>(sql`
    SELECT id::text AS id, provider, external_id, github_app_id
    FROM provider_enterprise
    WHERE id = ${query.enterpriseId}::uuid
    LIMIT 1
  `)
  const row = [...rows][0]
  if (!row) throw createError({ statusCode: 404, statusMessage: 'Enterprise not found' })
  if (row.provider !== 'github') {
    throw createError({
      statusCode: 400,
      statusMessage: 'Not a GitHub enterprise',
      data: {
        type: 'https://tokenscope.example.com/errors/validation',
        title: 'Not a GitHub enterprise',
        status: 400,
        detail: 'Unresolved Copilot users are GitHub-only.',
      },
    })
  }

  const ent: GithubEnterpriseRow = { enterpriseId: row.id, externalId: row.external_id, githubAppId: row.github_app_id }
  try {
    return await listUnresolvedCopilotLogins(db, ent)
  } catch (err) {
    if (err instanceof UnresolvedProbeError) {
      // A FIXED, key-safe reason bucket → a clean 502 (upstream/probe failure). Never echo a
      // provider body; the reason enum is all the UI needs to show an honest error.
      throw createError({
        statusCode: 502,
        statusMessage: 'Could not list unresolved Copilot users',
        data: {
          type: 'https://tokenscope.example.com/errors/github-unresolved',
          title: 'Could not list unresolved Copilot users',
          status: 502,
          detail: err.reason,
        },
      })
    }
    throw err
  }
})
