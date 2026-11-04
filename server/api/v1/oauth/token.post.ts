/*
 * OAuth Token Endpoint — RFC 6749 §4.1.3 (authorization_code) + §6 (refresh).
 *
 * Client-authenticated (client_secret_post). No user session. Returns the
 * RFC 6749 OAuth JSON shape { error, error_description } on every error path —
 * the MCP SDK's OAuth parser requires a string `error` (Nitro's default error
 * handler returns { error: true } which breaks it), so this handler returns
 * its own JSON rather than throwing createError.
 *
 * No assertSameOrigin — programmatic (CLI) endpoint, not a browser-cookie path.
 *
 * NO RLS LANE, by design ruling (docs/design/rls-enforcement.md §5; tracked as
 * an explicit residue in scripts/check-handler-rls-context.mjs). The teammate is
 * resolved BY the very `oauth_auth_code` / `oauth_token` lookup RLS would gate —
 * there is no identity to set before the query that discovers the identity. §5's
 * decision is that `oauth_token` is in server/db/rls-bootstrap.ts::RLS_BOOTSTRAP_TABLES and is explicitly DISABLEd before the
 * app connects as a non-owner. NOT "omitted from the FORCE set" — that protects
 * nothing, because a non-owner is filtered by ENABLE alone whatever any FORCE
 * phase says. (`oauth_client` / `oauth_auth_code` carry no RLS at all, so they
 * need nothing.) Access here is already gated by possession of a secret, and this
 * is the bootstrap path every other lane depends on.
 */
import {
  defineEventHandler,
  readValidatedBody,
  setResponseHeaders,
  setResponseStatus,
  type H3Event,
} from 'h3'
import { consola } from 'consola'
import {
  validateClientCredentials,
  consumeAuthCode,
  markAuthCodeTokenIssued,
  validatePkce,
  issueTokens,
  refreshAccessToken,
  getClient,
  OAuthError,
} from '../../../auth/oauth'
import { recordAuditEvent } from '../../../db/audit'
import { getDb } from '../../../db'
import { tokenRequestSchema, type TokenRequestBody } from '../../../../shared/schemas/oauth'

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

  let body: TokenRequestBody
  try {
    body = await readValidatedBody(event, (d) => tokenRequestSchema.parse(d))
  } catch (e) {
    return err(event, 400, 'invalid_request', e instanceof Error ? e.message : 'Invalid token request')
  }

  const db = getDb()

  // The internal emit client (ADR-0005) is PUBLIC: it has no recoverable secret,
  // so client_secret_post can never succeed for it. For the refresh_token grant
  // ONLY, we authenticate it by client_id alone (auth strength rides on the
  // refresh token + the E2 revocation cascade). It is never accepted for
  // authorization_code, and confidential clients still require a valid secret.
  const internalEmitClient = await getClient(db, body.client_id)
  const isEmitClient = internalEmitClient?.internal === true

  if (isEmitClient) {
    if (body.grant_type !== 'refresh_token') {
      return err(event, 400, 'unauthorized_client', 'The emit client only supports the refresh_token grant')
    }
  } else {
    // Client authentication (client_secret_post).
    if (!body.client_secret) {
      return err(event, 401, 'invalid_client', 'client_secret is required')
    }
    const client = await validateClientCredentials(db, body.client_id, body.client_secret)
    if (!client) {
      return err(event, 401, 'invalid_client', 'Invalid client credentials')
    }
  }

  try {
    if (body.grant_type === 'authorization_code') {
      return await handleAuthorizationCode(event, db, body)
    }
    if (body.grant_type === 'refresh_token') {
      return await handleRefreshToken(event, db, body)
    }
    return err(
      event,
      400,
      'unsupported_grant_type',
      'Only authorization_code and refresh_token grant types are supported',
    )
  } catch (e) {
    if (e instanceof OAuthError) {
      return err(event, 400, e.code, e.message)
    }
    consola.error('[oauth:token] exchange failed', e instanceof Error ? e.message : e)
    return err(event, 500, 'server_error', 'Token exchange failed. Please try again.')
  }
})

async function handleAuthorizationCode(
  event: H3Event,
  db: ReturnType<typeof getDb>,
  body: TokenRequestBody,
) {
  if (!body.code) {
    return err(event, 400, 'invalid_request', 'code is required for authorization_code grant')
  }
  if (!body.code_verifier) {
    return err(event, 400, 'invalid_request', 'code_verifier is required (PKCE)')
  }

  // ONE transaction for consume → validate → issue → audit (AUTH-4): a transient
  // failure in issueTokens / recordAuditEvent THROWS out of the callback, rolling
  // the consume back so the code stays exchangeable on retry (no permanently
  // burned code, no orphaned token pair the client never received). Validation
  // failures RETURN an error body instead — the callback completes, the consume
  // COMMITS, and the code stays burned (replay/brute-force safety unchanged).
  return await db.transaction(async (tx) => {
    // Consume the code (single-use, atomic). A consumed/expired/unknown code → null.
    const authCode = await consumeAuthCode(tx as never, body.code!)
    if (!authCode) {
      return err(event, 400, 'invalid_grant', 'Authorization code is invalid, expired, or already used')
    }

    // Code must have been issued to THIS client (prevents cross-client theft).
    if (authCode.clientId !== body.client_id) {
      consola.warn('[oauth:token] auth code client mismatch', {
        expected: authCode.clientId,
        received: body.client_id,
      })
      return err(event, 400, 'invalid_grant', 'Authorization code was not issued to this client')
    }

    // redirect_uri must match the one bound at authorization (RFC 6749 §4.1.3).
    if (!body.redirect_uri || body.redirect_uri !== authCode.redirectUri) {
      return err(
        event,
        400,
        'invalid_grant',
        'redirect_uri is required and must match the one used during authorization',
      )
    }

    // PKCE.
    if (!validatePkce(body.code_verifier!, authCode.codeChallenge, authCode.codeChallengeMethod)) {
      consola.warn('[oauth:token] PKCE validation failed', {
        clientId: body.client_id,
        teammateId: authCode.teammateId,
      })
      return err(event, 400, 'invalid_grant', 'PKCE code_verifier validation failed')
    }

    const tokens = await issueTokens(tx as never, {
      teammateId: authCode.teammateId,
      clientId: body.client_id,
      scope: authCode.scope,
    })
    await markAuthCodeTokenIssued(tx as never, authCode.id)

    await recordAuditEvent(tx as never, {
      eventType: 'oauth_token_issue',
      actorTeammateId: authCode.teammateId,
      actorSystem: 'oauth',
      subjectKind: 'oauth_client',
      payload: { client_id: body.client_id, grant_type: 'authorization_code', scope: authCode.scope },
    })

    return tokens
  })
}

async function handleRefreshToken(
  event: H3Event,
  db: ReturnType<typeof getDb>,
  body: TokenRequestBody,
) {
  if (!body.refresh_token) {
    return err(event, 400, 'invalid_request', 'refresh_token is required for refresh_token grant')
  }

  const { teammateId, ...tokens } = await refreshAccessToken(db, body.refresh_token, body.client_id)

  await recordAuditEvent(db, {
    eventType: 'oauth_token_issue',
    actorTeammateId: teammateId,
    actorSystem: 'oauth',
    subjectKind: 'oauth_client',
    payload: { client_id: body.client_id, grant_type: 'refresh_token', scope: tokens.scope },
  })

  return tokens
}
