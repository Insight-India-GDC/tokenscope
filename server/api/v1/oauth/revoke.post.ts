/*
 * OAuth Token Revocation — RFC 7009.
 *
 * Revokes a refresh or access token; both live on one oauth_token row, so
 * either ends both. Per RFC 7009 §2.2 the server ALWAYS returns 200 regardless
 * of whether the token existed — so an attacker can't probe which tokens are
 * live. Client-authenticated (client_secret_post); no user session.
 *
 * Errors return the RFC 6749 OAuth JSON shape (string `error`).
 *
 * NO RLS LANE, by design ruling (docs/design/rls-enforcement.md §5; tracked as
 * an explicit residue in scripts/check-handler-rls-context.mjs). Two reasons
 * that compound: the teammate is resolved BY the `oauth_token` lookup RLS would
 * gate, and RFC 7009 §2.2 requires a 200 for a token that does not exist at all
 * — so "the row is invisible" and "the row is absent" MUST stay
 * indistinguishable here. That holds only because `oauth_token` is in server/db/rls-bootstrap.ts::RLS_BOOTSTRAP_TABLES and is
 * explicitly DISABLEd at the role switch — not because it is "kept out of the
 * FORCE set", which would protect nothing: ENABLE alone filters a non-owner.
 */
import { defineEventHandler, readValidatedBody, setResponseHeaders, setResponseStatus, type H3Event } from 'h3'
import { consola } from 'consola'
import { validateClientCredentials, revokeOAuthToken } from '../../../auth/oauth'
import { recordAuditEvent } from '../../../db/audit'
import { getDb } from '../../../db'
import { revokeRequestSchema, type RevokeRequestBody } from '../../../../shared/schemas/oauth'

function err(event: H3Event, status: number, code: string, detail: string) {
  setResponseStatus(event, status)
  return { error: code, error_description: detail }
}

export default defineEventHandler(async (event) => {
  setResponseHeaders(event, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
    Pragma: 'no-cache',
  })

  let body: RevokeRequestBody
  try {
    body = await readValidatedBody(event, (d) => revokeRequestSchema.parse(d))
  } catch (e) {
    return err(event, 400, 'invalid_request', e instanceof Error ? e.message : 'Invalid revoke request')
  }

  const db = getDb()
  const client = await validateClientCredentials(db, body.client_id, body.client_secret)
  if (!client) {
    return err(event, 401, 'invalid_client', 'Invalid client credentials')
  }

  // Always 200 per RFC 7009 — swallow any error so the response can't be used
  // to distinguish valid from invalid tokens.
  try {
    const revoked = await revokeOAuthToken(db, body.token, body.client_id)
    if (!revoked) return {}
    await recordAuditEvent(db, {
      eventType: 'oauth_token_revoke',
      actorTeammateId: revoked.teammateId,
      actorSystem: 'oauth',
      subjectKind: 'oauth_client',
      payload: { client_id: body.client_id, token_type_hint: body.token_type_hint ?? null },
    })
  } catch (e) {
    consola.warn('[oauth:revoke] suppressed error (RFC 7009)', e instanceof Error ? e.message : e)
  }

  return {}
})
