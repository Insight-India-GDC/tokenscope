/*
 * GET /api/v1/admin/reconciliation/enterprises — list every provider_enterprise
 * (the credential-custody / onboarding unit above provider_org). GitHub holds one
 * manage_billing PAT per enterprise here; Anthropic's per-org key stays on the org.
 *
 * Per row: provider, externalId (lowercase per mig 0062), displayName,
 * reconciliationMode, billing, notes, the linked-org count, and keyPresent
 * (readSecret(provider, credential_secret_name) != null). The KEY IS NEVER
 * returned — only the presence boolean.
 *
 * RBAC: requireRole(admin), but only a platform admin gets the full record.
 * Provider configuration is estate config (owner-decisions.md §1, ruled
 * 2026-10-08), so a region admin gets just the four fields the org-onboarding
 * form's Enterprise picker needs (id, provider, externalId, displayName): no
 * credential names, key presence, billing, rates, notes or org counts.
 * `provider_enterprise` is a config
 * table with no RLS policy, but the read still runs in the request lane
 * (docs/design/rls-enforcement.md §2): the lane is decided by who is asking,
 * not by which table the query names. `readSecret` / `readGithubAppKey` are
 * pure env reads — no I/O inside the transaction.
 */
import { defineEventHandler } from 'h3'
import { sql } from 'drizzle-orm'
import { requireRole } from '../../../../auth/rbac'
import { withRequestRls } from '../../../../db/request-rls'
import { readSecret, readGithubAppKey } from '../../../../reconciliation/credentials'
import type { ReconcileProvider } from '../../../../reconciliation/types'

interface Row extends Record<string, unknown> {
  id: string
  provider: string
  external_id: string
  display_name: string
  reconciliation_mode: string
  billing: string
  credential_secret_name: string | null
  github_app_id: string | null
  notes: string | null
  flat_seat_price_usd: string | null
  included_allowance_usd: string | null
  overage_allocation_policy: string
  org_count: string
}

export default defineEventHandler(async (event) => {
  const session = await requireRole(event, 'admin')
  const full = session.role === 'platform-admin'

  const rows = await withRequestRls(event, (tx) =>
    tx.execute<Row>(sql`
    SELECT pe.id::text AS id,
           pe.provider,
           pe.external_id,
           pe.display_name,
           pe.reconciliation_mode,
           pe.billing,
           pe.credential_secret_name,
           pe.github_app_id,
           pe.notes,
           pe.flat_seat_price_usd::text AS flat_seat_price_usd,
           pe.included_allowance_usd::text AS included_allowance_usd,
           pe.overage_allocation_policy,
           (SELECT COUNT(*) FROM provider_org po WHERE po.provider_enterprise_id = pe.id)::text
             AS org_count
    FROM provider_enterprise pe
    ORDER BY pe.provider, pe.display_name
  `),
  )

  if (!full) {
    const picker = [...rows].map((r) => ({
      id: r.id,
      provider: r.provider,
      externalId: r.external_id,
      displayName: r.display_name,
    }))
    return { enterprises: picker, total: picker.length, scope: 'picker' as const }
  }

  const enterprises = [...rows].map((r) => {
    // App mode INTENDED iff a github_app_id is set (github only). 'github-app' here is a
    // STATEMENT OF INTENT (matches credentials.ts kind derivation); keyPresent below
    // reflects whether the matching credential (App private key vs PAT) is actually wired.
    const appMode = r.provider === 'github' && !!r.github_app_id?.trim()
    return {
      id: r.id,
      provider: r.provider,
      externalId: r.external_id,
      displayName: r.display_name,
      reconciliationMode: r.reconciliation_mode,
      billing: r.billing,
      credentialSecretName: r.credential_secret_name,
      githubAppId: r.github_app_id,
      credentialKind: appMode ? ('github-app' as const) : ('github-pat' as const),
      notes: r.notes,
      // ADR-0010 D1/D2 (Copilot only; null on Anthropic = pure metered). FORECAST/SHOWBACK
      // reference only — see docs/wiki/Reporting.md §5; the effective-dated rate-plan history
      // (ADR-0011 D9) is the authoritative period-aware source, via GET .../copilot-rate-plans.
      flatSeatPriceUsd: r.flat_seat_price_usd != null ? Number(r.flat_seat_price_usd) : null,
      includedAllowanceUsd: r.included_allowance_usd != null ? Number(r.included_allowance_usd) : null,
      // ADR-0011 D10 — configurable per-enterprise pooled-overage allocation policy.
      overageAllocationPolicy: r.overage_allocation_policy,
      orgCount: Number(r.org_count),
      // Presence ONLY — the key value never crosses this boundary. App mode checks the
      // App private key env (NUXT_GITHUB_APP_KEY_<NAME>); PAT mode the PAT env.
      keyPresent: appMode
        ? readGithubAppKey(r.credential_secret_name) != null
        : readSecret(r.provider as ReconcileProvider, r.credential_secret_name) != null,
    }
  })

  return { enterprises, total: enterprises.length, scope: 'full' as const }
})
