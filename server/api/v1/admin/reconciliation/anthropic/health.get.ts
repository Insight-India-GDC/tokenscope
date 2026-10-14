/*
 * GET /api/v1/admin/reconciliation/anthropic/health — live validation + health
 * probe for the two Anthropic reconciliation API variants (mig 0063 api_kind).
 *
 * Per anthropic org (all, or one via ?org=<externalOrgId>):
 *   - keyPresent   : is NUXT_ANTHROPIC_KEY_<credential_secret_name> set?
 *   - keyFormatOk  : does the key prefix match api_kind? Admin keys start
 *     sk-ant-admin01-; an enterprise-analytics org carrying an Admin-prefixed key
 *     (or vice-versa) is flagged as a MISMATCH. The key itself is NEVER returned —
 *     only a boolean + which-kind-it-looks-like (prefix-derived).
 *   - connects     : a LIVE read-only probe against the variant's cheapest endpoint
 *     (Enterprise: user_usage_report; Admin: claude_code usage report), one recent
 *     in-range day, single page. green (200+parses) or red with a SAFE classified
 *     reason. NUXT_ANTHROPIC_API_ENDPOINT unset => amber 'endpoint-unset' (not red).
 *   - color        : green | amber | red badge.
 *
 * SAFETY: never throws (the probe is caught + classified), never leaks the key or
 * raw provider error text. RBAC: requireRole(platform-admin) — it lists and
 * live-probes every region's anthropic provider_org (no region term).
 *
 * LANES (docs/design/rls-enforcement.md §2): the config READ runs in the request
 * lane (withRequestRls), even though `provider_org` carries no RLS policy — the
 * lane is decided by who is asking, not by which table this query names. The
 * PROBE stays outside that transaction: it is third-party HTTP, and holding a
 * request transaction across it is the anti-pattern §2 names.
 */
import { defineEventHandler, getValidatedQuery, createError } from 'h3'
import { sql } from 'drizzle-orm'
import { z } from 'zod'
import { requireRole } from '../../../../../auth/rbac'
import { withRequestRls } from '../../../../../db/request-rls'
import { computeOrgHealth, type AnthropicOrgRow } from '../../../../../anthropic/org-health'
import type { AnthropicApiKind } from '../../../../../reconciliation/adapters/registry'

const Query = z.object({
  // Restrict to a single org by its external_org_id (omitted => all anthropic orgs).
  org: z.string().max(200).optional(),
})

interface Row extends Record<string, unknown> {
  external_org_id: string
  display_name: string
  api_kind: string
  credential_secret_name: string | null
  reconciliation_mode: string
}

export default defineEventHandler(async (event) => {
  // Reads and probes provider_org of every region, so platform-admin is the only clamp.
  await requireRole(event, 'platform-admin')
  // safeParse → a proper 400 on bad ?org (never an unhandled 500; never echo the input).
  const query = await getValidatedQuery(event, (data) => {
    const parsed = Query.safeParse(data)
    if (!parsed.success) {
      throw createError({ statusCode: 400, statusMessage: 'invalid query parameter' })
    }
    return parsed.data
  })
  const orgClause = query.org ? sql`AND external_org_id = ${query.org}` : sql``
  const rows = await withRequestRls(event, (tx) =>
    tx.execute<Row>(sql`
      SELECT external_org_id, display_name, api_kind, credential_secret_name,
             reconciliation_mode
      FROM provider_org
      WHERE provider = 'anthropic' ${orgClause}
      ORDER BY display_name
    `),
  )

  // Read the endpoint once; empty/undefined => the per-org verdict is
  // amber 'endpoint-unset' (a config gap, NOT a red auth/connect error).
  const endpoint = process.env.NUXT_ANTHROPIC_API_ENDPOINT || undefined

  const orgRows: AnthropicOrgRow[] = [...rows].map((r) => {
    const apiKind: AnthropicApiKind =
      r.api_kind === 'enterprise-analytics' ? 'enterprise-analytics' : 'claude-code-admin'
    return {
      externalOrgId: r.external_org_id,
      displayName: r.display_name,
      apiKind,
      credentialSecretName: r.credential_secret_name,
      reconciliationMode: r.reconciliation_mode,
    }
  })

  // Probe each org (sequential — the probe set is tiny and we honour the 60 RPM
  // org-wide rate limit; computeOrgHealth never throws).
  const orgs = []
  for (const org of orgRows) {
    orgs.push(await computeOrgHealth(org, { endpoint }))
  }

  return { orgs, total: orgs.length, endpointConfigured: endpoint != null }
})
