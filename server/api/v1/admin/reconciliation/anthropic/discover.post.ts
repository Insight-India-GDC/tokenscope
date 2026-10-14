/*
 * POST /api/v1/admin/reconciliation/anthropic/discover — onboarding probe that,
 * given a credential_secret_name, resolves its env key, detects which Anthropic
 * API variant the key is for, calls that variant for one in-range day, and reads
 * back the organization_id. Lets an admin onboard an org WITHOUT hand-typing the
 * org id (the brittle seed.ts step).
 *
 * Body (zod): { credentialSecretName }.
 *
 * Response — 200 ONLY when an organization_id was read:
 *   { organizationId, apiKindDetected, keyFormatLooksLike }
 * A classified failure (no-key / endpoint-unset / 401 / 403 / 404 / parse-mismatch
 * / …) returns 422 with { reason, apiKindDetected?, keyFormatLooksLike? } — the
 * SAME safe vocabulary health.ts uses. The KEY IS NEVER returned or logged, and no
 * raw provider error text (which could echo the key) is surfaced.
 *
 * RBAC: requireRole(platform-admin) + assertSameOrigin. (No audit row: this
 * is a read-only probe — it writes nothing. The onboarding orgs.post that follows
 * is the audited mutation.)
 */
import { defineEventHandler, setResponseStatus } from 'h3'
import { readValidated } from '../../../../../utils/validated-body'
import { z } from 'zod'
import { requireRole } from '../../../../../auth/rbac'
import { assertSameOrigin } from '../../../../../auth/csrf'
import { discoverAnthropicOrg } from '../../../../../anthropic/discover'
import { credentialSecretNameSchema } from '../../../../../reconciliation/provider-validation'

const Body = z.object({
  credentialSecretName: credentialSecretNameSchema,
})

export default defineEventHandler(async (event) => {
  // Provider configuration is estate config (owner ruling 2026-10-08): it resolves a deployment-wide credential namespace and probes the provider, so platform-admin is the only clamp.
  await requireRole(event, 'platform-admin')
  assertSameOrigin(event)
  const body = await readValidated(event, Body)

  // Read the endpoint once; an unset endpoint folds into a clear 'endpoint-unset'
  // result (NOT a throw, never a red auth verdict).
  const endpoint = process.env.NUXT_ANTHROPIC_API_ENDPOINT || undefined

  const result = await discoverAnthropicOrg(body.credentialSecretName, { endpoint })

  if (result.ok) {
    return {
      organizationId: result.organizationId,
      apiKindDetected: result.apiKindDetected,
      keyFormatLooksLike: result.keyFormatLooksLike,
    }
  }

  // Classified failure — the request was well-formed but discovery couldn't read an
  // org id. 422 with the SAFE reason (key/raw-error never surfaced).
  setResponseStatus(event, 422)
  return {
    reason: result.reason,
    ...(result.apiKindDetected ? { apiKindDetected: result.apiKindDetected } : {}),
    ...(result.keyFormatLooksLike ? { keyFormatLooksLike: result.keyFormatLooksLike } : {}),
  }
})
