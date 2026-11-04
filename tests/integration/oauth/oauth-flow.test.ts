// @vitest-environment node
/*
 * OAuth 2.1 Authorization Server — full-flow integration (ADR-0005 credential
 * pathway). Real DB via testcontainers + the actual handlers called directly
 * (the region-lifecycle.test.ts pattern: ev() builds an h3-shaped event; the
 * OAuth handlers return RFC-6749 JSON bodies and set res.statusCode rather than
 * throwing, so we assert on the returned body + res.statusCode).
 *
 * Coverage (per brief):
 *   - Happy path: register → authorize(issues code) → token(code+PKCE) →
 *     access+refresh → refresh(new access) → revoke → token rejected.
 *   - PKCE failure (wrong verifier → invalid_grant).
 *   - Expired/used code → invalid_grant.
 *   - Cross-client code theft → invalid_grant.
 *   - requireOAuthBearer: accepts valid; rejects expired / revoked-token /
 *     E2-revoked-teammate.
 */
import { createHash, randomBytes } from 'node:crypto'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { sql } from 'drizzle-orm'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'
import * as schema from '../../../drizzle/schema'
import { injectTestSession } from '../../helpers/auth'
import type { Session } from '../../../server/utils/auth'
import { requireOAuthBearer } from '../../../server/auth/oauth-bearer'
import { hashSessionToken } from '../../../server/auth/hmac'

import registerHandler from '../../../server/api/v1/oauth/register.post'
import authorizeHandler from '../../../server/api/v1/oauth/authorize.get'
import authorizePostHandler from '../../../server/api/v1/oauth/authorize.post'
import { refreshAccessToken, MAX_OAUTH_CLIENTS, SOURCE_REGISTRATION_LIMIT } from '../../../server/auth/oauth'
import { issueEmitCredential } from '../../../server/auth/emit-credential'
import tokenHandler from '../../../server/api/v1/oauth/token.post'
import revokeHandler from '../../../server/api/v1/oauth/revoke.post'
import codeStatusHandler from '../../../server/api/v1/oauth/code-status.post'
import { OAUTH_SCOPE_LABELS } from '../../../shared/oauth-scopes'

let t: TestDb
let regionId: string
let ouId: string
let teammateId: string

const REDIRECT_URI = 'http://localhost:43117/callback'

beforeAll(async () => {
  t = await startTestDb()
  process.env.DATABASE_URL = t.url
  process.env.NUXT_SESSION_SECRET = 'oauth-test-padded-to-thirty-two-chars!!'
  process.env.NUXT_HMAC_SESSION_KEY = 'oauth-test-hmac-key-padded-well-beyond-32-chars'

  const [r] = await t.db.insert(schema.region).values({ code: 'oa', displayName: 'OAuth Region' }).returning()
  regionId = r!.id
  const [ou] = await t.db
    .insert(schema.orgUnit)
    .values({ regionId, path: 'oa.svc', code: 'oa-svc', displayName: 'OA Svc', unitType: 'bu', isCostOwningUnit: true })
    .returning()
  ouId = ou!.id
  const [tm] = await t.db
    .insert(schema.teammate)
    .values({ entraOid: 'oa-oid-1', email: 'oauth-user@example.com', displayName: 'OAuth User', role: 'developer', regionId, orgUnitId: ouId })
    .returning()
  teammateId = tm!.id
}, 60_000)

afterAll(async () => {
  await stopTestDb(t)
}, 30_000)

type AnyHandler = (e: unknown) => Promise<unknown>

const userSession = (): Session =>
  ({ teammateId, email: 'oauth-user@example.com', displayName: 'OAuth User', role: 'developer', regionId, orgPath: 'oa.svc' }) as Session

/**
 * Build an h3-shaped event. `authed` injects a TokenScope session (for the
 * authorize endpoint's requireAuth); omit it to model an unauthenticated GET.
 */
function ev(opts: {
  method?: string
  params?: Record<string, string>
  query?: Record<string, string>
  body?: unknown
  headers?: Record<string, string>
  session?: Session
}) {
  const headers: Record<string, string> = {
    host: 'localhost:3450',
    origin: 'http://localhost:3450',
    ...(opts.headers ?? {}),
  }
  const qs = opts.query ? '?' + new URLSearchParams(opts.query).toString() : ''
  const url = '/x' + qs
  const method = opts.method ?? 'POST'
  const e = {
    method,
    path: url,
    context: { params: opts.params ?? {} },
    node: {
      req: {
        method,
        url,
        body: opts.body,
        socket: { remoteAddress: '127.0.0.1' },
        get headers() {
          return { ...headers, 'content-type': 'application/json' }
        },
      },
      res: {
        _headers: {} as Record<string, string | string[]>,
        _ended: false,
        statusCode: 200,
        getHeader(n: string) { return this._headers[n.toLowerCase()] },
        setHeader(n: string, v: string | string[]) { this._headers[n.toLowerCase()] = v },
        removeHeader(n: string) { this._headers[n.toLowerCase()] = '' },
        appendHeader(n: string, v: string | string[]) { this._headers[n.toLowerCase()] = v },
        // sendRedirect() routes through h3's send() which defers
        // res.end(data) via setImmediate — provide a no-op so the deferred
        // flush doesn't throw an async uncaught exception after the handler
        // promise has already resolved.
        write() { return true },
        end() { this._ended = true; return this },
        get headersSent() { return this._ended },
      },
    },
  }
  if (opts.session) injectTestSession(e as unknown as Parameters<typeof injectTestSession>[0], opts.session)
  return e as unknown
}

async function call<R = unknown>(h: unknown, e: unknown): Promise<R> {
  return (h as AnyHandler)(e) as Promise<R>
}

function statusOf(e: unknown): number {
  return (e as { node: { res: { statusCode: number } } }).node.res.statusCode
}

// ── PKCE helpers ────────────────────────────────────────────────────────────
function makePkce() {
  const verifier = randomBytes(48).toString('base64url') // 64 chars, valid charset
  const challenge = createHash('sha256').update(verifier).digest('base64url')
  return { verifier, challenge }
}

// Register a fresh client; returns { client_id, client_secret }.
async function registerClient(): Promise<{ client_id: string; client_secret: string }> {
  const out = await call<{ client_id: string; client_secret: string }>(
    registerHandler,
    ev({ body: { client_name: 'Test MCP', redirect_uris: [REDIRECT_URI] } }),
  )
  return out
}

// Approve consent via authorize.post (the consent page's grant) and return the
// `code` from the 302 Location. (The GET now hands off to the consent page; the
// code is issued by the POST — mirrors the real browser flow without a browser.)
async function authorizeForCode(
  clientId: string,
  challenge: string,
  opts: { scope?: string; state?: string; session?: Session } = {},
): Promise<{ code: string; state: string }> {
  const state = opts.state ?? randomBytes(16).toString('hex')
  const e = ev({
    method: 'POST',
    body: {
      response_type: 'code',
      client_id: clientId,
      redirect_uri: REDIRECT_URI,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      scope: opts.scope ?? 'tokenscope.read tokenscope.tag',
      state,
      action: 'approve',
    },
    session: opts.session ?? userSession(),
  })
  await call(authorizePostHandler, e)
  // No Accept: application/json → the POST 302s with code+state in the Location.
  expect(statusOf(e)).toBe(302)
  const loc = (e as { node: { res: { _headers: Record<string, string> } } }).node.res._headers['location']
  expect(loc).toBeTruthy()
  const u = new URL(loc)
  const code = u.searchParams.get('code')!
  expect(code).toBeTruthy()
  expect(u.searchParams.get('state')).toBe(state)
  return { code, state }
}

describe('OAuth happy path', () => {
  it('register → authorize → token → refresh → revoke → rejected', async () => {
    // 1. Register.
    const client = await registerClient()
    expect(client.client_id).toMatch(/^[0-9a-f-]{36}$/)
    expect(client.client_secret).toMatch(/^[0-9a-f]{64}$/)

    // 2. Authorize → code.
    const { verifier, challenge } = makePkce()
    const { code } = await authorizeForCode(client.client_id, challenge)

    // 3. Token (authorization_code + PKCE).
    const tok = await call<{ access_token: string; refresh_token: string; scope: string; token_type: string; expires_in: number }>(
      tokenHandler,
      ev({
        body: {
          grant_type: 'authorization_code',
          code,
          redirect_uri: REDIRECT_URI,
          code_verifier: verifier,
          client_id: client.client_id,
          client_secret: client.client_secret,
        },
      }),
    )
    expect(tok.access_token).toBeTruthy()
    expect(tok.refresh_token).toBeTruthy()
    expect(tok.token_type).toBe('bearer')
    // emit is NOT grantable via the interactive flow (R1 F1) — only read+tag.
    expect(tok.scope).toBe('tokenscope.read tokenscope.tag')

    // 4. Refresh → NEW access token, SAME refresh token (NON-ROTATING, ADR-0005).
    const refreshed = await call<{ access_token: string; refresh_token: string }>(
      tokenHandler,
      ev({
        body: {
          grant_type: 'refresh_token',
          refresh_token: tok.refresh_token,
          client_id: client.client_id,
          client_secret: client.client_secret,
        },
      }),
    )
    expect(refreshed.access_token).toBeTruthy()
    expect(refreshed.access_token).not.toBe(tok.access_token)
    // Non-rotating: the refresh token is echoed UNCHANGED and stays live.
    expect(refreshed.refresh_token).toBe(tok.refresh_token)

    // The SAME refresh token is still valid and reusable across multiple cycles
    // (this is the durable-emission fix — re-presenting it must NOT invalidate it).
    const reuse = ev({
      body: {
        grant_type: 'refresh_token',
        refresh_token: tok.refresh_token,
        client_id: client.client_id,
        client_secret: client.client_secret,
      },
    })
    const reuseRes = await call<{ access_token: string; refresh_token: string }>(tokenHandler, reuse)
    expect(statusOf(reuse)).toBe(200)
    expect(reuseRes.access_token).toBeTruthy()
    expect(reuseRes.refresh_token).toBe(tok.refresh_token)

    // A third cycle still works (durability under repeated active use).
    const reuse2 = ev({
      body: {
        grant_type: 'refresh_token',
        refresh_token: tok.refresh_token,
        client_id: client.client_id,
        client_secret: client.client_secret,
      },
    })
    const reuse2Res = await call<{ access_token: string }>(tokenHandler, reuse2)
    expect(reuse2Res.access_token).toBeTruthy()

    // 5. Revoke the (still-same) refresh token.
    const revRes = await call<Record<string, never>>(
      revokeHandler,
      ev({
        body: {
          token: tok.refresh_token,
          client_id: client.client_id,
          client_secret: client.client_secret,
        },
      }),
    )
    expect(revRes).toEqual({})

    // 6. The revoked refresh token is rejected — revocation, not rotation, is
    //    the control that ends a durable refresh credential.
    const afterRevoke = ev({
      body: {
        grant_type: 'refresh_token',
        refresh_token: tok.refresh_token,
        client_id: client.client_id,
        client_secret: client.client_secret,
      },
    })
    const afterRes = await call<{ error: string }>(tokenHandler, afterRevoke)
    expect(afterRes.error).toBe('invalid_grant')
  })
})

describe('RFC 7009 revoke by access token, and the teammate on refresh/revoke audit rows', () => {
  async function auditRows(eventType: string, clientId: string) {
    return t.client<{ actor_teammate_id: string | null; grant_type: string | null }[]>`
      SELECT actor_teammate_id::text AS actor_teammate_id, payload->>'grant_type' AS grant_type
        FROM audit_event
       WHERE event_type = ${eventType} AND payload->>'client_id' = ${clientId}`
  }

  it('revoking the ACCESS token ends the bearer and the refresh; both audit rows name the teammate', async () => {
    const client = await registerClient()
    const other = await registerClient()
    const { verifier, challenge } = makePkce()
    const { code } = await authorizeForCode(client.client_id, challenge)
    const tok = await call<{ access_token: string; refresh_token: string }>(
      tokenHandler,
      ev({
        body: {
          grant_type: 'authorization_code',
          code,
          redirect_uri: REDIRECT_URI,
          code_verifier: verifier,
          client_id: client.client_id,
          client_secret: client.client_secret,
        },
      }),
    )
    const refreshed = await call<{ access_token: string; teammateId?: string }>(
      tokenHandler,
      ev({
        body: {
          grant_type: 'refresh_token',
          refresh_token: tok.refresh_token,
          client_id: client.client_id,
          client_secret: client.client_secret,
        },
      }),
    )
    expect(refreshed.access_token).toBeTruthy()
    expect(refreshed.teammateId).toBeUndefined() // not leaked into the token response
    const refreshAudit = (await auditRows('oauth_token_issue', client.client_id)).filter((r) => r.grant_type === 'refresh_token')
    expect(refreshAudit).toHaveLength(1)
    expect(refreshAudit[0]!.actor_teammate_id).toBe(teammateId)

    const bearer = () =>
      requireOAuthBearer(
        ev({ method: 'GET', headers: { authorization: `Bearer ${refreshed.access_token}` } }) as never,
        undefined,
        t.db as never,
      )
    expect((await bearer()).teammateId).toBe(teammateId)

    // Another client's credentials revoke nothing, and write no audit row.
    const foreign = await call(revokeHandler, ev({
      body: { token: refreshed.access_token, client_id: other.client_id, client_secret: other.client_secret },
    }))
    expect(foreign).toEqual({})
    expect((await bearer()).teammateId).toBe(teammateId)
    expect(await auditRows('oauth_token_revoke', other.client_id)).toHaveLength(0)

    const revRes = await call(revokeHandler, ev({
      body: { token: refreshed.access_token, client_id: client.client_id, client_secret: client.client_secret },
    }))
    expect(revRes).toEqual({})
    await expect(bearer()).rejects.toMatchObject({ statusCode: 401 })
    const afterRefresh = await call<{ error?: string }>(
      tokenHandler,
      ev({
        body: {
          grant_type: 'refresh_token',
          refresh_token: tok.refresh_token,
          client_id: client.client_id,
          client_secret: client.client_secret,
        },
      }),
    )
    expect(afterRefresh.error).toBe('invalid_grant')

    const revokeAudit = await auditRows('oauth_token_revoke', client.client_id)
    expect(revokeAudit).toHaveLength(1)
    expect(revokeAudit[0]!.actor_teammate_id).toBe(teammateId)
  })

  it('revoking the access token a refresh just superseded also ends the row', async () => {
    const client = await registerClient()
    const { verifier, challenge } = makePkce()
    const { code } = await authorizeForCode(client.client_id, challenge)
    const tok = await call<{ access_token: string; refresh_token: string }>(
      tokenHandler,
      ev({
        body: {
          grant_type: 'authorization_code',
          code,
          redirect_uri: REDIRECT_URI,
          code_verifier: verifier,
          client_id: client.client_id,
          client_secret: client.client_secret,
        },
      }),
    )
    await call(tokenHandler, ev({
      body: {
        grant_type: 'refresh_token',
        refresh_token: tok.refresh_token,
        client_id: client.client_id,
        client_secret: client.client_secret,
      },
    }))
    await call(revokeHandler, ev({
      body: { token: tok.access_token, client_id: client.client_id, client_secret: client.client_secret },
    }))
    const [row] = await t.client<{ revoked: boolean }[]>`
      SELECT revoked_at IS NOT NULL AS revoked FROM oauth_token WHERE client_id = ${client.client_id}::uuid`
    expect(row!.revoked).toBe(true)
  })
})

describe('POST /oauth/authorize JSON result carries an explicit outcome', () => {
  async function post(redirectUri: string, action: 'approve' | 'deny', scope = 'tokenscope.read') {
    const client = await call<{ client_id: string }>(
      registerHandler,
      ev({ body: { client_name: 'Outcome MCP', redirect_uris: [redirectUri] } }),
    )
    const e = ev({
      method: 'POST',
      headers: { accept: 'application/json' },
      body: {
        response_type: 'code',
        client_id: client.client_id,
        redirect_uri: redirectUri,
        code_challenge: makePkce().challenge,
        code_challenge_method: 'S256',
        scope,
        state: randomBytes(16).toString('hex'),
        action,
      },
      session: userSession(),
    })
    return call<Record<string, string>>(authorizePostHandler, e)
  }

  it('approve → outcome code, even when the registered redirect_uri carries its own `error` param', async () => {
    const res = await post('http://127.0.0.1:43118/cb?error=registered', 'approve')
    expect(res.outcome).toBe('code')
    expect(new URL(res.redirect_url!).searchParams.get('code')).toBe(res.code)
  })

  it('deny → outcome denied; approve with no grantable scope → outcome error', async () => {
    expect((await post('http://127.0.0.1:43118/cb?code=registered', 'deny')).outcome).toBe('denied')
    const bad = await post('http://127.0.0.1:43118/cb', 'approve', 'tokenscope.emit')
    expect(bad).toMatchObject({ outcome: 'error', error: 'invalid_scope' })
    expect(bad.code).toBeUndefined()
  })
})

describe('POST /oauth/code-status — consent-page delivery detection', () => {
  const status = (code: string, opts: { session?: Session; headers?: Record<string, string> } = {}) =>
    call<{ redeemed: boolean }>(codeStatusHandler, ev({ body: { code }, session: opts.session ?? userSession(), headers: opts.headers }))

  it('reads false until the client exchanges the code, then true', async () => {
    const client = await registerClient()
    const { verifier, challenge } = makePkce()
    const { code } = await authorizeForCode(client.client_id, challenge)
    expect(await status(code)).toEqual({ redeemed: false })

    await call(
      tokenHandler,
      ev({
        body: {
          grant_type: 'authorization_code',
          code,
          redirect_uri: REDIRECT_URI,
          code_verifier: verifier,
          client_id: client.client_id,
          client_secret: client.client_secret,
        },
      }),
    )
    expect(await status(code)).toEqual({ redeemed: true })
  })

  it('a FAILED exchange (wrong PKCE verifier) burns the code but still reads false', async () => {
    const client = await registerClient()
    const { challenge } = makePkce()
    const { code } = await authorizeForCode(client.client_id, challenge)
    const res = await call<{ error: string }>(
      tokenHandler,
      ev({
        body: {
          grant_type: 'authorization_code',
          code,
          redirect_uri: REDIRECT_URI,
          code_verifier: randomBytes(48).toString('base64url'),
          client_id: client.client_id,
          client_secret: client.client_secret,
        },
      }),
    )
    expect(res.error).toBe('invalid_grant')
    const [row] = await t.db.execute<{ consumed_at: Date | null }>(
      sql`SELECT consumed_at FROM oauth_auth_code WHERE code_hash = ${hashSessionToken(code)}`,
    )
    expect(row!.consumed_at).not.toBeNull()
    expect(await status(code)).toEqual({ redeemed: false })
  })

  it("another teammate's redeemed code, and an unknown code, both read false", async () => {
    const client = await registerClient()
    const { verifier, challenge } = makePkce()
    const { code } = await authorizeForCode(client.client_id, challenge)
    await call(
      tokenHandler,
      ev({
        body: {
          grant_type: 'authorization_code',
          code,
          redirect_uri: REDIRECT_URI,
          code_verifier: verifier,
          client_id: client.client_id,
          client_secret: client.client_secret,
        },
      }),
    )
    const [other] = await t.db
      .insert(schema.teammate)
      .values({ entraOid: 'oa-oid-status', email: 'status-other@example.com', displayName: 'Other', role: 'developer', regionId, orgUnitId: ouId })
      .returning()
    const otherSession = { ...userSession(), teammateId: other!.id, email: 'status-other@example.com' } as Session
    expect(await status(code, { session: otherSession })).toEqual({ redeemed: false })
    expect(await status(randomBytes(32).toString('hex'))).toEqual({ redeemed: false })
  })

  it('requires a session, same origin, and a well-formed code', async () => {
    const code = randomBytes(32).toString('hex')
    await expect(call(codeStatusHandler, ev({ body: { code } }))).rejects.toMatchObject({ statusCode: 401 })
    await expect(status(code, { headers: { origin: 'https://evil.example.com' } })).rejects.toMatchObject({ statusCode: 403 })
    await expect(status('not-a-code')).rejects.toMatchObject({ statusCode: 400 })
  })
})

describe('PKCE + code failure modes', () => {
  it('wrong verifier → invalid_grant', async () => {
    const client = await registerClient()
    const { challenge } = makePkce()
    const { code } = await authorizeForCode(client.client_id, challenge)
    const e = ev({
      body: {
        grant_type: 'authorization_code',
        code,
        redirect_uri: REDIRECT_URI,
        code_verifier: randomBytes(48).toString('base64url'), // different verifier
        client_id: client.client_id,
        client_secret: client.client_secret,
      },
    })
    const res = await call<{ error: string }>(tokenHandler, e)
    expect(res.error).toBe('invalid_grant')
    expect(statusOf(e)).toBe(400)
  })

  it('used code → invalid_grant (single-use)', async () => {
    const client = await registerClient()
    const { verifier, challenge } = makePkce()
    const { code } = await authorizeForCode(client.client_id, challenge)
    const body = {
      grant_type: 'authorization_code',
      code,
      redirect_uri: REDIRECT_URI,
      code_verifier: verifier,
      client_id: client.client_id,
      client_secret: client.client_secret,
    }
    const first = await call<{ access_token: string }>(tokenHandler, ev({ body }))
    expect(first.access_token).toBeTruthy()
    // Second exchange of the same code → consumed → invalid_grant.
    const e2 = ev({ body })
    const second = await call<{ error: string }>(tokenHandler, e2)
    expect(second.error).toBe('invalid_grant')
  })

  it('expired code → invalid_grant', async () => {
    const client = await registerClient()
    const { verifier, challenge } = makePkce()
    const { code } = await authorizeForCode(client.client_id, challenge)
    // Force-expire the code in the DB.
    await t.db.execute(sql`
      UPDATE oauth_auth_code SET expires_at = now() - interval '1 minute'
      WHERE code_hash = ${hashSessionToken(code)}
    `)
    const e = ev({
      body: {
        grant_type: 'authorization_code',
        code,
        redirect_uri: REDIRECT_URI,
        code_verifier: verifier,
        client_id: client.client_id,
        client_secret: client.client_secret,
      },
    })
    const res = await call<{ error: string }>(tokenHandler, e)
    expect(res.error).toBe('invalid_grant')
  })

  it('cross-client code theft → invalid_grant', async () => {
    const victim = await registerClient()
    const attacker = await registerClient()
    const { verifier, challenge } = makePkce()
    // Victim's client gets the code (authorized by the user).
    const { code } = await authorizeForCode(victim.client_id, challenge)
    // Attacker tries to redeem it with ITS OWN credentials.
    const e = ev({
      body: {
        grant_type: 'authorization_code',
        code,
        redirect_uri: REDIRECT_URI,
        code_verifier: verifier,
        client_id: attacker.client_id,
        client_secret: attacker.client_secret,
      },
    })
    const res = await call<{ error: string }>(tokenHandler, e)
    expect(res.error).toBe('invalid_grant')
  })
})

describe('authorize endpoint guards', () => {
  it('unauthenticated → 302 to login (no code issued)', async () => {
    const client = await registerClient()
    const { challenge } = makePkce()
    const e = ev({
      method: 'GET',
      query: {
        response_type: 'code',
        client_id: client.client_id,
        redirect_uri: REDIRECT_URI,
        code_challenge: challenge,
        code_challenge_method: 'S256',
        scope: 'tokenscope.read',
        state: randomBytes(16).toString('hex'),
      },
      // no session → unauthenticated
    })
    await call(authorizeHandler, e)
    expect(statusOf(e)).toBe(302)
    const loc = (e as { node: { res: { _headers: Record<string, string> } } }).node.res._headers['location']
    expect(loc).toContain('/auth/entra/login')
    expect(loc).not.toContain('code=')
  })

  it('unknown client_id → invalid_client (no redirect)', async () => {
    const { challenge } = makePkce()
    const e = ev({
      method: 'GET',
      query: {
        response_type: 'code',
        client_id: '00000000-0000-4000-8000-0000000000ff',
        redirect_uri: REDIRECT_URI,
        code_challenge: challenge,
        code_challenge_method: 'S256',
        scope: 'tokenscope.read',
        state: randomBytes(16).toString('hex'),
      },
      session: userSession(),
    })
    const res = await call<{ error: string }>(authorizeHandler, e)
    expect(res.error).toBe('invalid_client')
    expect(statusOf(e)).toBe(400)
  })

  it('redirect_uri not matching registration → invalid_request (no redirect)', async () => {
    const client = await registerClient()
    const { challenge } = makePkce()
    const e = ev({
      method: 'GET',
      query: {
        response_type: 'code',
        client_id: client.client_id,
        redirect_uri: 'http://localhost:9999/evil',
        code_challenge: challenge,
        code_challenge_method: 'S256',
        scope: 'tokenscope.read',
        state: randomBytes(16).toString('hex'),
      },
      session: userSession(),
    })
    const res = await call<{ error: string }>(authorizeHandler, e)
    expect(res.error).toBe('invalid_request')
    expect(statusOf(e)).toBe(400)
  })
})

describe('client + token endpoint auth', () => {
  it('invalid client secret at /token → invalid_client (401)', async () => {
    const client = await registerClient()
    const { verifier, challenge } = makePkce()
    const { code } = await authorizeForCode(client.client_id, challenge)
    const e = ev({
      body: {
        grant_type: 'authorization_code',
        code,
        redirect_uri: REDIRECT_URI,
        code_verifier: verifier,
        client_id: client.client_id,
        client_secret: 'wrong-secret',
      },
    })
    const res = await call<{ error: string }>(tokenHandler, e)
    expect(res.error).toBe('invalid_client')
    expect(statusOf(e)).toBe(401)
  })

  it('non-loopback redirect_uri at /register → rejected', async () => {
    const e = ev({ body: { client_name: 'Bad', redirect_uris: ['https://evil.example.com/cb'] } })
    const res = await call<{ error: string }>(registerHandler, e)
    // zod schema rejects → invalid_client_metadata (400).
    expect(res.error).toBe('invalid_client_metadata')
    expect(statusOf(e)).toBe(400)
  })
})

// ── requireOAuthBearer ────────────────────────────────────────────────────────
describe('requireOAuthBearer', () => {
  // Mint an EMIT access token the LEGIT way — issueEmitCredential (internal client)
  // + refresh — since emit is NOT grantable via the interactive flow (R1 F1).
  async function mintEmitAccessToken(): Promise<string> {
    const cred = await issueEmitCredential(t.db as never, teammateId)
    const refreshed = await refreshAccessToken(t.db as never, cred.tokens.refresh_token, cred.clientId)
    return refreshed.access_token
  }

  // Mint a token via the full interactive flow, returning the raw access token.
  async function mintAccessToken(scope = 'tokenscope.read tokenscope.tag'): Promise<{ accessToken: string; clientId: string }> {
    const client = await registerClient()
    const { verifier, challenge } = makePkce()
    const { code } = await authorizeForCode(client.client_id, challenge, { scope })
    const tok = await call<{ access_token: string }>(
      tokenHandler,
      ev({
        body: {
          grant_type: 'authorization_code',
          code,
          redirect_uri: REDIRECT_URI,
          code_verifier: verifier,
          client_id: client.client_id,
          client_secret: client.client_secret,
        },
      }),
    )
    return { accessToken: tok.access_token, clientId: client.client_id }
  }

  function bearerEv(token: string) {
    return ev({ method: 'GET', headers: { authorization: `Bearer ${token}` } })
  }

  it('accepts a valid token and returns the teammate', async () => {
    const accessToken = await mintEmitAccessToken()
    const tm = await requireOAuthBearer(bearerEv(accessToken) as never, 'tokenscope.emit', t.db as never)
    expect(tm.teammateId).toBe(teammateId)
    expect(tm.email).toBe('oauth-user@example.com')
    expect(tm.scope).toContain('tokenscope.emit')
  })

  it('R1 F1: the interactive flow does NOT grant tokenscope.emit (only read+tag)', async () => {
    const { accessToken } = await mintAccessToken('tokenscope.read tokenscope.emit')
    // emit was stripped → the minted token is read-only, rejected at the emit gate.
    await expect(
      requireOAuthBearer(bearerEv(accessToken) as never, 'tokenscope.emit', t.db as never),
    ).rejects.toMatchObject({ statusCode: 401 })
    // but still valid for read.
    const tm = await requireOAuthBearer(bearerEv(accessToken) as never, 'tokenscope.read', t.db as never)
    expect(tm.teammateId).toBe(teammateId)
  })

  it('rejects a token missing the required scope (insufficient_scope)', async () => {
    const { accessToken } = await mintAccessToken('tokenscope.read')
    await expect(
      requireOAuthBearer(bearerEv(accessToken) as never, 'tokenscope.emit', t.db as never),
    ).rejects.toMatchObject({ statusCode: 401 })
  })

  it('rejects an unknown / malformed bearer', async () => {
    await expect(
      requireOAuthBearer(bearerEv('not-a-real-token') as never, undefined, t.db as never),
    ).rejects.toMatchObject({ statusCode: 401 })
    await expect(
      requireOAuthBearer(ev({ method: 'GET' }) as never, undefined, t.db as never),
    ).rejects.toMatchObject({ statusCode: 401 })
  })

  it('rejects an expired access token', async () => {
    const { accessToken } = await mintAccessToken()
    await t.db.execute(sql`
      UPDATE oauth_token SET access_expires_at = now() - interval '1 minute'
      WHERE access_token_hash = ${hashSessionToken(accessToken)}
    `)
    await expect(
      requireOAuthBearer(bearerEv(accessToken) as never, undefined, t.db as never),
    ).rejects.toMatchObject({ statusCode: 401 })
  })

  it('rejects a revoked access token', async () => {
    const { accessToken } = await mintAccessToken()
    await t.db.execute(sql`
      UPDATE oauth_token SET revoked_at = now()
      WHERE access_token_hash = ${hashSessionToken(accessToken)}
    `)
    await expect(
      requireOAuthBearer(bearerEv(accessToken) as never, undefined, t.db as never),
    ).rejects.toMatchObject({ statusCode: 401 })
  })

  it('rejects when the bound teammate is revoked AFTER issuance (ADR-0005 E2)', async () => {
    // A dedicated teammate so we don't poison the shared one.
    const [tm2] = await t.db
      .insert(schema.teammate)
      .values({ entraOid: 'oa-oid-e2', email: 'e2-user@example.com', displayName: 'E2', role: 'developer', regionId, orgUnitId: ouId })
      .returning()
    const e2Session = (): Session =>
      ({ teammateId: tm2!.id, email: 'e2-user@example.com', displayName: 'E2', role: 'developer', regionId, orgPath: 'oa.svc' }) as Session

    const client = await registerClient()
    const { verifier, challenge } = makePkce()
    const { code } = await authorizeForCode(client.client_id, challenge, { session: e2Session() })
    const tok = await call<{ access_token: string }>(
      tokenHandler,
      ev({
        body: {
          grant_type: 'authorization_code',
          code,
          redirect_uri: REDIRECT_URI,
          code_verifier: verifier,
          client_id: client.client_id,
          client_secret: client.client_secret,
        },
      }),
    )

    // Token works before revocation.
    const ok = await requireOAuthBearer(bearerEv(tok.access_token) as never, undefined, t.db as never)
    expect(ok.teammateId).toBe(tm2!.id)

    // Revoke the teammate AFTER the token was issued.
    await t.db.execute(sql`UPDATE teammate SET revoked_at = now() WHERE id = ${tm2!.id}::uuid`)

    await expect(
      requireOAuthBearer(bearerEv(tok.access_token) as never, undefined, t.db as never),
    ).rejects.toMatchObject({ statusCode: 401 })
  })
})

// ── Registration hardening (MEDIUM-1) ─────────────────────────────────────────
describe('register hardening', () => {
  it('rejects the reserved emit client_name (no client created)', async () => {
    const before = [
      ...(await t.db.execute<{ count: string }>(sql`SELECT COUNT(*)::text AS count FROM oauth_client`)),
    ][0]!.count
    const e = ev({ body: { client_name: 'tokenscope-emit', redirect_uris: [REDIRECT_URI] } })
    const res = await call<{ error: string }>(registerHandler, e)
    expect(res.error).toBe('invalid_client_metadata')
    expect(statusOf(e)).toBe(400)
    const after = [
      ...(await t.db.execute<{ count: string }>(sql`SELECT COUNT(*)::text AS count FROM oauth_client`)),
    ][0]!.count
    expect(after).toBe(before)
  })

  it('public registration always sets internal = false', async () => {
    const client = await registerClient()
    const rows = [
      ...(await t.db.execute<{ internal: boolean }>(
        sql`SELECT internal FROM oauth_client WHERE client_id = ${client.client_id}::uuid`,
      )),
    ]
    expect(rows[0]!.internal).toBe(false)
  })
})

// ── Non-rotating refresh + E2 teammate-revocation cascade (HIGH-1/HIGH-2) ──────
describe('refresh: teammate revocation (ADR-0005 E2)', () => {
  // Full flow for a fresh teammate; returns the live access + refresh tokens.
  async function mintPair(): Promise<{
    accessToken: string
    refreshToken: string
    clientId: string
    clientSecret: string
    tmId: string
  }> {
    const [tm] = await t.db
      .insert(schema.teammate)
      .values({
        entraOid: `oa-oid-${randomBytes(4).toString('hex')}`,
        email: `rev-${randomBytes(4).toString('hex')}@example.com`,
        displayName: 'Rev',
        role: 'developer',
        regionId,
        orgUnitId: ouId,
      })
      .returning()
    const session = (): Session =>
      ({ teammateId: tm!.id, email: tm!.email, displayName: 'Rev', role: 'developer', regionId, orgPath: 'oa.svc' }) as Session

    const client = await registerClient()
    const { verifier, challenge } = makePkce()
    const { code } = await authorizeForCode(client.client_id, challenge, { session: session() })
    const tok = await call<{ access_token: string; refresh_token: string }>(
      tokenHandler,
      ev({
        body: {
          grant_type: 'authorization_code',
          code,
          redirect_uri: REDIRECT_URI,
          code_verifier: verifier,
          client_id: client.client_id,
          client_secret: client.client_secret,
        },
      }),
    )
    return {
      accessToken: tok.access_token,
      refreshToken: tok.refresh_token,
      clientId: client.client_id,
      clientSecret: client.client_secret,
      tmId: tm!.id,
    }
  }

  it('a revoked teammate can no longer refresh (invalid_grant)', async () => {
    const p = await mintPair()
    // Revoke the teammate directly (anchor: revoked_at > refresh_issued_at).
    await t.db.execute(sql`UPDATE teammate SET revoked_at = now() WHERE id = ${p.tmId}::uuid`)

    const e = ev({
      body: {
        grant_type: 'refresh_token',
        refresh_token: p.refreshToken,
        client_id: p.clientId,
        client_secret: p.clientSecret,
      },
    })
    const res = await call<{ error: string }>(tokenHandler, e)
    expect(res.error).toBe('invalid_grant')
    expect(statusOf(e)).toBe(400)
  })

  it('the eager oauth_token cascade revokes existing tokens (refresh + bearer both rejected)', async () => {
    const p = await mintPair()
    // Mirror the admin-handler eager cascade: revoke teammate + cascade oauth_token.
    await t.db.execute(sql`UPDATE teammate SET revoked_at = now() WHERE id = ${p.tmId}::uuid`)
    await t.db.execute(sql`
      UPDATE oauth_token SET revoked_at = now()
      WHERE teammate_id = ${p.tmId}::uuid AND revoked_at IS NULL
    `)

    // Refresh now fails (row revoked_at IS NOT NULL).
    const e = ev({
      body: {
        grant_type: 'refresh_token',
        refresh_token: p.refreshToken,
        client_id: p.clientId,
        client_secret: p.clientSecret,
      },
    })
    const res = await call<{ error: string }>(tokenHandler, e)
    expect(res.error).toBe('invalid_grant')

    // The previously-issued access token is rejected by requireOAuthBearer.
    await expect(
      requireOAuthBearer(
        ev({ method: 'GET', headers: { authorization: `Bearer ${p.accessToken}` } }) as never,
        undefined,
        t.db as never,
      ),
    ).rejects.toMatchObject({ statusCode: 401 })
  })
})

// ── S6: consent-page info fetch (server-verified client identity + scopes) ────
// The GET handler's Accept: application/json branch is what app/pages/oauth/
// authorize.vue calls to render the consent screen — never route.query.
describe('authorize GET — consent info fetch (Accept: application/json)', () => {
  it('returns the server-verified client_name — a query-supplied client_name has no effect', async () => {
    const client = await registerClient() // registers "Test MCP"
    const { challenge } = makePkce()
    const e = ev({
      method: 'GET',
      query: {
        response_type: 'code',
        client_id: client.client_id,
        redirect_uri: REDIRECT_URI,
        code_challenge: challenge,
        code_challenge_method: 'S256',
        // Not a real query field on this endpoint — proves the response can't
        // be steered by anything the caller puts in the URL.
        client_name: 'Definitely Not Test MCP',
        scope: 'tokenscope.read',
        state: randomBytes(16).toString('hex'),
      },
      headers: { accept: 'application/json' },
      session: userSession(),
    })
    const res = await call<{ client_name: string; redirect_host: string; granted_scopes: string[] }>(
      authorizeHandler,
      e,
    )
    expect(statusOf(e)).toBe(200)
    expect(res.client_name).toBe('Test MCP')
    expect(res.redirect_host).toBe(new URL(REDIRECT_URI).host)
  })

  it('no scope requested → granted_scopes matches what authorize.post actually grants', async () => {
    const client = await registerClient()
    const { verifier, challenge } = makePkce()

    const infoE = ev({
      method: 'GET',
      query: {
        response_type: 'code',
        client_id: client.client_id,
        redirect_uri: REDIRECT_URI,
        code_challenge: challenge,
        code_challenge_method: 'S256',
        state: randomBytes(16).toString('hex'),
        // scope omitted entirely.
      },
      headers: { accept: 'application/json' },
      session: userSession(),
    })
    const info = await call<{ granted_scopes: string[] }>(authorizeHandler, infoE)
    expect(info.granted_scopes).toEqual(['tokenscope.read'])

    // Drive the SAME no-scope request through the real approve → token
    // exchange and confirm the ACTUAL grant matches what was rendered.
    const state = randomBytes(16).toString('hex')
    const postE = ev({
      method: 'POST',
      body: {
        response_type: 'code',
        client_id: client.client_id,
        redirect_uri: REDIRECT_URI,
        code_challenge: challenge,
        code_challenge_method: 'S256',
        state,
        action: 'approve',
        // scope omitted — same as the GET above.
      },
      session: userSession(),
    })
    await call(authorizePostHandler, postE)
    expect(statusOf(postE)).toBe(302)
    const loc = (postE as { node: { res: { _headers: Record<string, string> } } }).node.res._headers['location']
    const code = new URL(loc).searchParams.get('code')!

    const tok = await call<{ scope: string }>(
      tokenHandler,
      ev({
        body: {
          grant_type: 'authorization_code',
          code,
          redirect_uri: REDIRECT_URI,
          code_verifier: verifier,
          client_id: client.client_id,
          client_secret: client.client_secret,
        },
      }),
    )
    expect(tok.scope).toBe('tokenscope.read')
  })

  it('an unknown scope in the request is not rendered', async () => {
    const client = await registerClient()
    const { challenge } = makePkce()
    const e = ev({
      method: 'GET',
      query: {
        response_type: 'code',
        client_id: client.client_id,
        redirect_uri: REDIRECT_URI,
        code_challenge: challenge,
        code_challenge_method: 'S256',
        scope: 'tokenscope.read sudo-admin',
        state: randomBytes(16).toString('hex'),
      },
      headers: { accept: 'application/json' },
      session: userSession(),
    })
    const res = await call<{ granted_scopes: string[] }>(authorizeHandler, e)
    expect(res.granted_scopes).toEqual(['tokenscope.read'])
    expect(res.granted_scopes).not.toContain('sudo-admin')
  })
})

// ── S6: registration bounds (client_name / redirect_uris) ─────────────────────
describe('registration bounds (S6)', () => {
  it('over-long client_name (129 chars) → 400', async () => {
    const e = ev({ body: { client_name: 'x'.repeat(129), redirect_uris: [REDIRECT_URI] } })
    const res = await call<{ error: string }>(registerHandler, e)
    expect(res.error).toBe('invalid_client_metadata')
    expect(statusOf(e)).toBe(400)
  })

  it('9 redirect_uris → 400 (cap is 8)', async () => {
    const uris = Array.from({ length: 9 }, (_, i) => `http://127.0.0.1:${40000 + i}/cb`)
    const e = ev({ body: { client_name: 'Many URIs', redirect_uris: uris } })
    const res = await call<{ error: string }>(registerHandler, e)
    expect(res.error).toBe('invalid_client_metadata')
    expect(statusOf(e)).toBe(400)
  })

  it('a client_name containing a control character (\\n) is rejected', async () => {
    const e = ev({ body: { client_name: 'Evil\nName', redirect_uris: [REDIRECT_URI] } })
    const res = await call<{ error: string }>(registerHandler, e)
    expect(res.error).toBe('invalid_client_metadata')
    expect(statusOf(e)).toBe(400)
  })

  it('a client_name containing a bidi override (U+202E) is rejected', async () => {
    const e = ev({ body: { client_name: 'Evil‮Name', redirect_uris: [REDIRECT_URI] } })
    const res = await call<{ error: string }>(registerHandler, e)
    expect(res.error).toBe('invalid_client_metadata')
    expect(statusOf(e)).toBe(400)
  })

  it('a legitimate non-ASCII client_name is accepted (charset is an allowlist, not ASCII-only)', async () => {
    const e = ev({ body: { client_name: '日本語クライアント 🚀', redirect_uris: [REDIRECT_URI] } })
    const res = await call<{ client_id?: string; client_name?: string }>(registerHandler, e)
    expect(statusOf(e)).toBe(201)
    expect(res.client_name).toBe('日本語クライアント 🚀')
  })

  it('client_secret_expires_at is non-zero (bounded, not eternal per RFC 7591)', async () => {
    const e = ev({ body: { client_name: 'Bounded Secret', redirect_uris: [REDIRECT_URI] } })
    const res = await call<{ client_secret_expires_at: number }>(registerHandler, e)
    expect(statusOf(e)).toBe(201)
    expect(res.client_secret_expires_at).toBeGreaterThan(Math.floor(Date.now() / 1000))
  })
})

// ── S6: registration ceiling — reserved headroom ───────────────────────────────
describe('registration ceiling — reserved headroom (S6)', () => {
  it('a fresh source still registers once the global ceiling is saturated by one flooding source', async () => {
    // Saturate the GLOBAL ceiling with synthetic rows — no real registration
    // flow needed for these; only their existence matters.
    const countRows = [
      ...(await t.db.execute<{ count: string }>(sql`SELECT COUNT(*)::text AS count FROM oauth_client`)),
    ]
    const needed = MAX_OAUTH_CLIENTS - Number(countRows[0]!.count)
    if (needed > 0) {
      await t.db.execute(sql`
        INSERT INTO oauth_client (client_id, client_secret_hash, client_name, redirect_uris, internal, created_at)
        SELECT gen_random_uuid(), 'synthetic-hash-' || gs, 'Synthetic Flood Client',
               ARRAY['http://127.0.0.1/cb'], false, now()
        FROM generate_series(1, ${needed}) AS gs
      `)
    }

    const FLOOD_IP = '203.0.113.9'
    // Drive the flooding source's OWN recent-registration count up to the
    // per-source limit. Each of these succeeds — the global ceiling is
    // already saturated, but THIS source's own recent volume is still
    // trivial for every one of them.
    for (let i = 0; i < SOURCE_REGISTRATION_LIMIT; i++) {
      const e = ev({
        body: { client_name: `Flood ${i}`, redirect_uris: [REDIRECT_URI] },
        headers: { 'x-forwarded-for': FLOOD_IP },
      })
      const res = await call<{ client_id?: string; error?: string }>(registerHandler, e)
      expect(statusOf(e)).toBe(201)
      expect(res.client_id).toBeTruthy()
    }

    // The SAME flooding source is now denied — global ceiling hit AND its own
    // recent volume is non-trivial.
    const deniedE = ev({
      body: { client_name: 'One Too Many', redirect_uris: [REDIRECT_URI] },
      headers: { 'x-forwarded-for': FLOOD_IP },
    })
    const denied = await call<{ error: string }>(registerHandler, deniedE)
    expect(denied.error).toBe('temporarily_unavailable')
    expect(statusOf(deniedE)).toBe(429)

    // A DIFFERENT, low-volume source still succeeds — the global ceiling can
    // never fully lock out a fresh registrant (reserved headroom).
    const freshE = ev({
      body: { client_name: 'Fresh Registrant', redirect_uris: [REDIRECT_URI] },
      headers: { 'x-forwarded-for': '198.51.100.42' },
    })
    const fresh = await call<{ client_id?: string; error?: string }>(registerHandler, freshE)
    expect(statusOf(freshE)).toBe(201)
    expect(fresh.client_id).toBeTruthy()
  })
})

// ── S6: tokenscope.read discloses the read→emit provisioning crossing ─────────
describe('oauth-scopes labels (S6)', () => {
  it('the tokenscope.read label mentions device provisioning (ADR-0005 E1 disclosure)', () => {
    expect(OAUTH_SCOPE_LABELS['tokenscope.read']).toMatch(/provision/i)
  })
})
