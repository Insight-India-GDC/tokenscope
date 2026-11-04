/*
 * POST /api/v1/oauth/authorize — the consent-page grant (RFC 6749 §4.1.2 + PKCE).
 *
 * The browser consent page (app/pages/oauth/authorize.vue) submits the user's
 * Approve/Deny here on their Entra session. With `Accept: application/json` it
 * returns an AuthorizeResult as DATA — the callback URL plus the explicit
 * outcome, because a registered redirect_uri may carry any query params and the
 * page must never infer the outcome from the URL; a normal request 302s.
 *
 * This is the ONE OAuth endpoint that runs on the browser cookie, so it
 * `assertSameOrigin` (the token/register/revoke endpoints are cookieless CLI
 * calls and deliberately skip it). Client + redirect_uri are validated BEFORE any
 * redirect (approve OR deny) to prevent open-redirect. The auth code is
 * teammate-bound + PKCE-carried by reusing `issueAuthCode` verbatim — the GET
 * handler's invariants (single-use CAS, S256) are preserved unchanged.
 */
import {
  defineEventHandler,
  readValidatedBody,
  getRequestHeader,
  sendRedirect,
  setResponseHeaders,
  setResponseStatus,
  type H3Event,
} from 'h3'
import { consola } from 'consola'
import { requireAuth } from '../../../auth/rbac'
import { assertSameOrigin } from '../../../auth/csrf'
import { getClient, issueAuthCode, computeGrantedScopes, INTERACTIVE_GRANTABLE_SCOPES } from '../../../auth/oauth'
import { recordAuditEvent } from '../../../db/audit'
import { withRequestRls } from '../../../db/request-rls'
import { authorizeBodySchema, type AuthorizeResult } from '../../../../shared/schemas/oauth'

function jsonError(event: H3Event, code: string, detail: string, status = 400) {
  setResponseHeaders(event, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
  setResponseStatus(event, status)
  return { error: code, error_description: detail }
}
function wantsJson(event: H3Event): boolean {
  return (getRequestHeader(event, 'accept') || '').includes('application/json')
}
type Outcome = AuthorizeResult extends infer R ? (R extends AuthorizeResult ? Omit<R, 'redirect_url'> : never) : never
function redirectResult(event: H3Event, url: string, result: Outcome) {
  if (wantsJson(event)) {
    setResponseHeaders(event, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
    const body: AuthorizeResult = { redirect_url: url, ...result }
    return body
  }
  return sendRedirect(event, url, 302)
}

export default defineEventHandler(async (event) => {
  assertSameOrigin(event)
  const session = await requireAuth(event)

  // GUARD-RAIL, not a fix for a live hole. `impersonatorOid` is set only when
  // the session is an ASSUMED identity — written at exactly two sites
  // (server/utils/auth.ts:303, :343) from the persona-override cookie. An
  // OAuth consent mints a teammate-bound auth code that becomes a durable
  // access/refresh token, so granting one on an assumed identity would hand
  // the impersonator a credential that outlives the impersonation and carries
  // the impersonated teammate's identity with nothing on it recording that a
  // human never consented.
  //
  // This CANNOT fire today: persona override is double-gated on the
  // {local, sandbox} demo-capable allowlist (shared/env/deploy-env.ts:27) AND
  // NUXT_ALLOW_PERSONA_OVERRIDE, and `dev` — the only environment that
  // authenticates — is in neither. The check exists so the property still
  // holds IF persona override is ever enabled on a real environment.
  //
  // Refused BEFORE the client/redirect_uri lookup deliberately: this returns a
  // JSON 403 rather than redirecting, so it cannot become an open-redirect,
  // and refusing first means no code is issued and no DB work happens.
  if (session.impersonatorOid) {
    consola.warn('[oauth:authorize.post] refused — assumed identity', {
      teammateId: session.teammateId,
      impersonatorOid: session.impersonatorOid,
    })
    return jsonError(
      event,
      'access_denied',
      'Authorization cannot be granted while acting as another user. Stop impersonating and sign in as yourself to connect a client.',
      403,
    )
  }

  const body = await readValidatedBody(event, (d) => authorizeBodySchema.parse(d))

  if (body.response_type && body.response_type !== 'code') {
    return jsonError(event, 'unsupported_response_type', 'Only response_type=code is supported')
  }

  // This is the ONE OAuth endpoint that runs on a browser cookie session
  // (requireAuth above), so — unlike design §5's token / revoke / register trio —
  // it HAS an identity to carry and uses the request lane throughout.
  //
  // Validate client + redirect_uri BEFORE any redirect (approve OR deny) — else a
  // crafted deny becomes an open-redirect.
  const client = await withRequestRls(event, (tx) => getClient(tx, body.client_id))
  if (!client) return jsonError(event, 'invalid_client', 'Unknown client_id')
  if (!client.redirectUris.includes(body.redirect_uri)) {
    return jsonError(event, 'invalid_request', 'redirect_uri does not match any registered redirect URIs')
  }

  // Denial → redirect_uri with error (safe: redirect_uri validated above).
  if (body.action === 'deny') {
    const url = new URL(body.redirect_uri)
    url.searchParams.set('error', 'access_denied')
    url.searchParams.set('error_description', 'The user denied the authorization request')
    url.searchParams.set('state', body.state)
    consola.info('[oauth:authorize.post] denied', { clientId: client.clientId, teammateId: session.teammateId })
    return redirectResult(event, url.toString(), { outcome: 'denied' })
  }

  // Approve. Filter requested scopes to the INTERACTIVE-grantable set (read+tag) —
  // computeGrantedScopes is the SAME function the consent page's info fetch
  // (authorize.get.ts) uses to RENDER the permission list, so what the user saw
  // and what gets granted here can never drift (S6 Consent (b)). tokenscope.emit
  // is NOT grantable here — the durable emit credential must never be issued
  // over the client channel (R1 F1). Defaults to read if none requested.
  const granted = computeGrantedScopes(body.scope)
  if (granted.length === 0) {
    const url = new URL(body.redirect_uri)
    const description = `At least one valid scope is required (one of: ${INTERACTIVE_GRANTABLE_SCOPES.join(', ')})`
    url.searchParams.set('error', 'invalid_scope')
    url.searchParams.set('error_description', description)
    url.searchParams.set('state', body.state)
    return redirectResult(event, url.toString(), { outcome: 'error', error: 'invalid_scope', error_description: description })
  }

  // Code issue + audit in ONE RLS-bearing transaction: the audit row used to be
  // a context-less write after the mint (design §4's class), so under FORCE the
  // consent would have been granted and the handler would then have 500'd.
  const code = await withRequestRls(event, async (tx) => {
    const code = await issueAuthCode(tx, {
      clientId: client.clientId,
      teammateId: session.teammateId,
      redirectUri: body.redirect_uri,
      scope: granted.join(' '),
      codeChallenge: body.code_challenge,
      codeChallengeMethod: body.code_challenge_method,
      // The exchange refuses the code if this session is revoked before it (#431).
      sessionIssuedAt: session.issuedAt,
    })

    await recordAuditEvent(tx, {
      eventType: 'oauth_authorize',
      actorTeammateId: session.teammateId,
      subjectKind: 'oauth_client',
      payload: { client_id: client.clientId, scope: granted.join(' '), via: 'consent-post' },
    })
    return code
  })
  consola.info('[oauth:authorize.post] code issued', { clientId: client.clientId, teammateId: session.teammateId })

  const url = new URL(body.redirect_uri)
  url.searchParams.set('code', code)
  url.searchParams.set('state', body.state)
  return redirectResult(event, url.toString(), { outcome: 'code', code })
})
