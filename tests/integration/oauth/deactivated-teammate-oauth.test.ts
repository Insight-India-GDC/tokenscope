// @vitest-environment node
/*
 * `is_active` on the OAUTH surfaces (audit round 2, finding #1 — second half).
 *
 * THE DEFECT: the sprint added the deactivation gate to the COOKIE-session path
 * (isRevoked, server/utils/auth.ts) and stopped there. Neither
 * server/auth/oauth-bearer.ts nor server/auth/oauth.ts mentioned is_active at
 * all — `grep -c is_active` returned 0 for both. requireOAuthBearer joined
 * `teammate` but selected only `revoked_at`, and compared it as
 * `teammateRevokedMs > issuedMs`.
 *
 * WHY THAT COMPARISON CAN NEVER FIRE FOR A CLEANED ACCOUNT: the
 * privileged-identity-cleanup worker's ONLY identity mutation is
 * `UPDATE teammate SET is_active = FALSE`
 * (server/workers/privileged-identity-cleanup.ts:245) — it never sets
 * revoked_at. So a "cleaned" teammate kept:
 *   - a valid unexpired access token across every requireOAuthBearer consumer
 *     (the four /instances/{id}/* emit routes AND the MCP endpoint, which is the
 *     gate on the surface that actually carries telemetry);
 *   - a refresh token that re-minted a fresh 30-day access token every cycle,
 *     indefinitely;
 *   - any outstanding authorization code — invisible to the worker, which only
 *     inspects existing oauth_token rows (its has_live_token gate), so this was
 *     the path by which a retired account could re-arm itself entirely.
 *
 * The two axes stay deliberately different shapes, and both are asserted here:
 *   - revoked_at is a SESSION ANCHOR — overloaded (ADR-0005 §E2), so it only
 *     invalidates credentials minted BEFORE it. Unchanged by this file.
 *   - is_active=false is DEACTIVATION — durable, no timestamp comparison.
 *
 * Every case carries an ACTIVE control so a blanket refusal cannot pass.
 */
import { createHash, randomBytes } from 'node:crypto'
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'
import * as schema from '../../../drizzle/schema'
import { injectTestSession } from '../../helpers/auth'
import type { Session } from '../../../server/utils/auth'
import { requireOAuthBearer } from '../../../server/auth/oauth-bearer'
import {
  refreshAccessToken,
  issueTokens,
  issueAuthCode,
  consumeAuthCode,
  OAuthError,
} from '../../../server/auth/oauth'
import { hashSessionToken } from '../../../server/auth/hmac'
import { issueEmitCredential } from '../../../server/auth/emit-credential'
import registerHandler from '../../../server/api/v1/oauth/register.post'
import authorizePostHandler from '../../../server/api/v1/oauth/authorize.post'
import tokenHandler from '../../../server/api/v1/oauth/token.post'

let t: TestDb
let regionId: string
let ouId: string

/** The account the cleanup worker retires. Active at seed; each test sets state. */
let subjectId: string
const SUBJECT_EMAIL = 'svc-admin@example.com'

/** An ordinary teammate that stays ACTIVE throughout — the control. */
let controlId: string
const CONTROL_EMAIL = 'ordinary.dev@example.com'

const REDIRECT_URI = 'http://localhost:43117/callback'

beforeAll(async () => {
  t = await startTestDb()
  process.env.DATABASE_URL = t.url
  process.env.NUXT_SESSION_SECRET = 'deact-oauth-test-padded-to-thirty-two!!'
  process.env.NUXT_HMAC_SESSION_KEY = 'deact-oauth-test-hmac-key-padded-beyond-32-chars'

  const [r] = await t.db
    .insert(schema.region)
    .values({ code: 'do', displayName: 'Deact OAuth Region' })
    .returning()
  regionId = r!.id
  const [ou] = await t.db
    .insert(schema.orgUnit)
    .values({
      regionId,
      path: 'do.svc',
      code: 'do-svc',
      displayName: 'DO Svc',
      unitType: 'bu',
      isCostOwningUnit: true,
    })
    .returning()
  ouId = ou!.id

  for (const seed of [
    { email: SUBJECT_EMAIL, oid: 'do-oid-subject', name: 'Service Admin' },
    { email: CONTROL_EMAIL, oid: 'do-oid-control', name: 'Ordinary Dev' },
  ]) {
    const [row] = await t.db
      .insert(schema.teammate)
      .values({
        entraOid: seed.oid,
        email: seed.email,
        displayName: seed.name,
        role: 'developer',
        regionId,
        orgUnitId: ouId,
      })
      .returning()
    if (seed.email === SUBJECT_EMAIL) subjectId = row!.id
    else controlId = row!.id
  }
}, 90_000)

afterAll(async () => {
  await stopTestDb(t)
}, 30_000)

beforeEach(async () => {
  // Both fully active between cases — no test may inherit another's state.
  await t.client`UPDATE teammate SET is_active = TRUE, revoked_at = NULL
                  WHERE id IN (${subjectId}::uuid, ${controlId}::uuid)`
})

// ── harness (the oauth-flow.test.ts shape) ───────────────────────────────────

type AnyHandler = (e: unknown) => Promise<unknown>

const sessionFor = (id: string, email: string): Session =>
  ({
    teammateId: id,
    email,
    displayName: 'T',
    role: 'developer',
    regionId,
    orgPath: 'do.svc',
    // Minted now, as a real sign-in would be: the exchange judges a code by the
    // approving session's mint time (#431), and a session with none fails closed.
    issuedAt: new Date().toISOString(),
  }) as Session

function ev(opts: {
  method?: string
  body?: unknown
  headers?: Record<string, string>
  session?: Session
}) {
  const headers: Record<string, string> = {
    host: 'localhost:3450',
    origin: 'http://localhost:3450',
    ...(opts.headers ?? {}),
  }
  const method = opts.method ?? 'POST'
  const e = {
    method,
    path: '/x',
    context: { params: {} },
    node: {
      req: {
        method,
        url: '/x',
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
        getHeader(n: string) {
          return this._headers[n.toLowerCase()]
        },
        setHeader(n: string, v: string | string[]) {
          this._headers[n.toLowerCase()] = v
        },
        removeHeader(n: string) {
          this._headers[n.toLowerCase()] = ''
        },
        appendHeader(n: string, v: string | string[]) {
          this._headers[n.toLowerCase()] = v
        },
        write() {
          return true
        },
        end() {
          this._ended = true
          return this
        },
        get headersSent() {
          return this._ended
        },
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
function bearerEv(token: string) {
  return ev({ method: 'GET', headers: { authorization: `Bearer ${token}` } })
}
function makePkce() {
  const verifier = randomBytes(48).toString('base64url')
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') }
}
async function registerClient(): Promise<{ client_id: string; client_secret: string }> {
  return call(registerHandler, ev({ body: { client_name: 'Deact MCP', redirect_uris: [REDIRECT_URI] } }))
}

const deactivate = (id: string) => t.client`UPDATE teammate SET is_active = FALSE WHERE id = ${id}::uuid`
const reactivate = (id: string) => t.client`UPDATE teammate SET is_active = TRUE WHERE id = ${id}::uuid`

/** Mint an emit access+refresh pair the legit way (emit is not interactively grantable). */
async function mintEmit(teammateId: string) {
  const cred = await issueEmitCredential(t.db as never, teammateId)
  const refreshed = await refreshAccessToken(t.db as never, cred.tokens.refresh_token, cred.clientId)
  return {
    accessToken: refreshed.access_token,
    refreshToken: cred.tokens.refresh_token,
    clientId: cred.clientId,
  }
}

/** Drive the consent POST to obtain a real authorization code for `session`. */
async function authorizeForCode(clientId: string, challenge: string, session: Session): Promise<string> {
  const e = ev({
    body: {
      response_type: 'code',
      client_id: clientId,
      redirect_uri: REDIRECT_URI,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      scope: 'tokenscope.read tokenscope.tag',
      state: randomBytes(16).toString('hex'),
      action: 'approve',
    },
    session,
  })
  await call(authorizePostHandler, e)
  expect(statusOf(e)).toBe(302)
  const loc = (e as { node: { res: { _headers: Record<string, string> } } }).node.res._headers['location']
  expect(loc).toBeTruthy()
  const code = new URL(loc!).searchParams.get('code')
  expect(code).toBeTruthy()
  return code!
}

// ── 1. Bearer validation ─────────────────────────────────────────────────────

describe('bearer: a deactivated teammate loses an already-issued access token', () => {
  it('CONTROL: an ACTIVE teammate’s bearer is accepted', async () => {
    const { accessToken } = await mintEmit(controlId)
    const tm = await requireOAuthBearer(bearerEv(accessToken) as never, 'tokenscope.emit', t.db as never)
    expect(tm.teammateId).toBe(controlId)
  })

  it('an existing, unexpired bearer is REFUSED once is_active=FALSE (revoked_at untouched)', async () => {
    const { accessToken } = await mintEmit(subjectId)
    // It genuinely works first — this is a live credential, not a dud.
    expect(
      (await requireOAuthBearer(bearerEv(accessToken) as never, 'tokenscope.emit', t.db as never)).teammateId,
    ).toBe(subjectId)

    await deactivate(subjectId) // EXACTLY the cleanup worker's mutation
    const [row] = await t.client<{ revoked_at: string | null }[]>`
      SELECT revoked_at::text AS revoked_at FROM teammate WHERE id = ${subjectId}::uuid`
    expect(row!.revoked_at).toBeNull() // the worker really does not set it

    await expect(
      requireOAuthBearer(bearerEv(accessToken) as never, 'tokenscope.emit', t.db as never),
    ).rejects.toMatchObject({ statusCode: 401 })
  })

  it('the MCP lane is gated too (requireOAuthBearer with no scope and no instance binding)', async () => {
    // server/api/v1/mcp/[...].ts:132 calls requireOAuthBearer(event) with NO
    // scope arg and NO requiredInstanceId — the one deliberate opt-out of the
    // per-device check. It must still refuse a deactivated teammate.
    const { accessToken } = await mintEmit(subjectId)
    expect((await requireOAuthBearer(bearerEv(accessToken) as never, undefined, t.db as never)).teammateId).toBe(
      subjectId,
    )
    await deactivate(subjectId)
    await expect(
      requireOAuthBearer(bearerEv(accessToken) as never, undefined, t.db as never),
    ).rejects.toMatchObject({ statusCode: 401 })
  })

  it('the SAME token works again the moment the teammate is REACTIVATED (the gate is is_active, nothing else)', async () => {
    const { accessToken } = await mintEmit(subjectId)
    await deactivate(subjectId)
    await expect(
      requireOAuthBearer(bearerEv(accessToken) as never, 'tokenscope.emit', t.db as never),
    ).rejects.toMatchObject({ statusCode: 401 })

    await reactivate(subjectId)
    expect(
      (await requireOAuthBearer(bearerEv(accessToken) as never, 'tokenscope.emit', t.db as never)).teammateId,
    ).toBe(subjectId)
  })

  it('revoked_at keeps its EXISTING semantics: it invalidates only credentials minted BEFORE it', async () => {
    // Guards against "fixed is_active by making revoked_at absolute". A benign
    // role/region change bumps revoked_at (ADR-0005 §E2) and must NOT kill a
    // credential minted after the bump.
    await t.client`UPDATE teammate SET revoked_at = now() WHERE id = ${subjectId}::uuid`
    await new Promise((r) => setTimeout(r, 5))
    const { accessToken } = await mintEmit(subjectId) // minted AFTER the bump
    expect(
      (await requireOAuthBearer(bearerEv(accessToken) as never, 'tokenscope.emit', t.db as never)).teammateId,
    ).toBe(subjectId)
  })
})

// ── 2. Refresh ───────────────────────────────────────────────────────────────

describe('refresh: a deactivated teammate cannot mint a fresh access token', () => {
  it('CONTROL: an ACTIVE teammate refreshes normally, through the real /oauth/token route', async () => {
    const cred = await issueEmitCredential(t.db as never, controlId)
    const e = ev({
      body: {
        grant_type: 'refresh_token',
        refresh_token: cred.tokens.refresh_token,
        client_id: cred.clientId,
      },
    })
    const res = await call<{ access_token?: string; error?: string }>(tokenHandler, e)
    expect(res.error).toBeUndefined()
    expect(res.access_token).toBeTruthy()
  })

  it('the refresh grant is REFUSED once is_active=FALSE (invalid_grant, via the route)', async () => {
    const cred = await issueEmitCredential(t.db as never, subjectId)
    await deactivate(subjectId)

    const e = ev({
      body: {
        grant_type: 'refresh_token',
        refresh_token: cred.tokens.refresh_token,
        client_id: cred.clientId,
      },
    })
    const res = await call<{ access_token?: string; error?: string }>(tokenHandler, e)
    expect(res.error).toBe('invalid_grant')
    expect(res.access_token).toBeUndefined()
    expect(statusOf(e)).toBe(400)
  })

  it('refreshAccessToken itself throws invalid_grant (the engine, not just the route)', async () => {
    const cred = await issueEmitCredential(t.db as never, subjectId)
    await deactivate(subjectId)
    await expect(
      refreshAccessToken(t.db as never, cred.tokens.refresh_token, cred.clientId),
    ).rejects.toMatchObject({ code: 'invalid_grant' })
  })

  it('the refresh token is not BURNED by the refusal — it works again after reactivation', async () => {
    // Non-rotating refresh (ADR-0005): revocation is the control, not use. A
    // deactivation must suspend the credential, not destroy it.
    const cred = await issueEmitCredential(t.db as never, subjectId)
    await deactivate(subjectId)
    await expect(
      refreshAccessToken(t.db as never, cred.tokens.refresh_token, cred.clientId),
    ).rejects.toMatchObject({ code: 'invalid_grant' })

    await reactivate(subjectId)
    const ok = await refreshAccessToken(t.db as never, cred.tokens.refresh_token, cred.clientId)
    expect(ok.access_token).toBeTruthy()
  })
})

// ── 3. Authorization-code exchange ───────────────────────────────────────────

describe('auth code: a code minted BEFORE deactivation is not exchangeable AFTER it', () => {
  it('CONTROL: an ACTIVE teammate exchanges their code for tokens', async () => {
    const client = await registerClient()
    const { verifier, challenge } = makePkce()
    const code = await authorizeForCode(client.client_id, challenge, sessionFor(controlId, CONTROL_EMAIL))

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
    const res = await call<{ access_token?: string; error?: string }>(tokenHandler, e)
    expect(res.error).toBeUndefined()
    expect(res.access_token).toBeTruthy()
  })

  it('THE RE-ARM GAP: a code issued while active is REFUSED after deactivation', async () => {
    const client = await registerClient()
    const { verifier, challenge } = makePkce()
    // Minted while fully active — the worker cannot see it (it only inspects
    // oauth_token rows), so this is the account's route back to a live token.
    const code = await authorizeForCode(client.client_id, challenge, sessionFor(subjectId, SUBJECT_EMAIL))

    await deactivate(subjectId)

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
    const res = await call<{ access_token?: string; error?: string }>(tokenHandler, e)
    expect(res.error).toBe('invalid_grant') // same opaque code as an unknown code
    expect(res.access_token).toBeUndefined()
    expect(statusOf(e)).toBe(400)

    // And nothing was minted for the retired account.
    const [minted] = await t.client<{ c: string }[]>`
      SELECT COUNT(*)::text AS c FROM oauth_token
       WHERE teammate_id = ${subjectId}::uuid AND client_id = ${client.client_id}::uuid`
    expect(Number(minted!.c)).toBe(0)
  })

  it('consumeAuthCode itself refuses IN THE CAS — not as a side effect of the mint gate', async () => {
    // Through the route, issueTokens' choke point ALSO closes this lane (its
    // throw rolls the transaction back), so the route tests above cannot tell
    // the two apart. Asserted directly here because the CAS predicate is what
    // makes the refusal atomic: it does not depend on token.post.ts keeping
    // consume+mint in one transaction, nor on the OAuthError propagating.
    const client = await registerClient()
    const { challenge } = makePkce()
    const raw = await issueAuthCode(t.db as never, {
      clientId: client.client_id,
      teammateId: subjectId,
      redirectUri: REDIRECT_URI,
      scope: 'tokenscope.read',
      codeChallenge: challenge,
      codeChallengeMethod: 'S256',
      sessionIssuedAt: new Date().toISOString(),
    })

    await deactivate(subjectId)
    expect(await consumeAuthCode(t.db as never, raw)).toBeNull()

    // The CAS matched no row, so the code was not burned either.
    const [row] = await t.client<{ consumed_at: string | null }[]>`
      SELECT consumed_at::text AS consumed_at FROM oauth_auth_code
       WHERE code_hash = ${hashSessionToken(raw)}`
    expect(row!.consumed_at).toBeNull()

    // CONTROL: reactivate and the very same code consumes normally.
    await reactivate(subjectId)
    const consumed = await consumeAuthCode(t.db as never, raw)
    expect(consumed?.teammateId).toBe(subjectId)
  })

  it('the refused code is left UNBURNED and works again after reactivation', async () => {
    // Documents the deliberate choice: the CAS matches no row, so consumed_at
    // stays NULL. The code is inert while the account is retired.
    const client = await registerClient()
    const { verifier, challenge } = makePkce()
    const code = await authorizeForCode(client.client_id, challenge, sessionFor(subjectId, SUBJECT_EMAIL))

    await deactivate(subjectId)
    const body = {
      grant_type: 'authorization_code',
      code,
      redirect_uri: REDIRECT_URI,
      code_verifier: verifier,
      client_id: client.client_id,
      client_secret: client.client_secret,
    }
    expect((await call<{ error?: string }>(tokenHandler, ev({ body }))).error).toBe('invalid_grant')

    await reactivate(subjectId)
    const res = await call<{ access_token?: string; error?: string }>(tokenHandler, ev({ body }))
    expect(res.error).toBeUndefined()
    expect(res.access_token).toBeTruthy()
  })

  it('a code minted BEFORE revoke-sessions (revoked_at) is refused; one minted after it exchanges', async () => {
    const client = await registerClient()
    const before = makePkce()
    const staleCode = await authorizeForCode(client.client_id, before.challenge, sessionFor(subjectId, SUBJECT_EMAIL))

    await new Promise((r) => setTimeout(r, 5))
    await t.client`UPDATE teammate SET revoked_at = now() WHERE id = ${subjectId}::uuid`
    await new Promise((r) => setTimeout(r, 5))

    const exchange = (code: string, verifier: string) =>
      ev({
        body: {
          grant_type: 'authorization_code',
          code,
          redirect_uri: REDIRECT_URI,
          code_verifier: verifier,
          client_id: client.client_id,
          client_secret: client.client_secret,
        },
      })
    const refusedEv = exchange(staleCode, before.verifier)
    const refused = await call<{ access_token?: string; error?: string }>(tokenHandler, refusedEv)
    expect(refused.error).toBe('invalid_grant')
    expect(refused.access_token).toBeUndefined()
    expect(statusOf(refusedEv)).toBe(400)

    const after = makePkce()
    const freshCode = await authorizeForCode(client.client_id, after.challenge, sessionFor(subjectId, SUBJECT_EMAIL))
    const ok = await call<{ access_token?: string; error?: string }>(tokenHandler, exchange(freshCode, after.verifier))
    expect(ok.error).toBeUndefined()
    expect(ok.access_token).toBeTruthy()
  })
})

// ── 4. The mint choke point ──────────────────────────────────────────────────

describe('issueTokens is the only oauth_token creator, and it refuses a deactivated teammate', () => {
  it('CONTROL: minting for an ACTIVE teammate succeeds', async () => {
    const cred = await issueEmitCredential(t.db as never, controlId)
    expect(cred.tokens.refresh_token).toBeTruthy()
  })

  it('issueTokens throws invalid_grant for a deactivated teammate', async () => {
    const cred = await issueEmitCredential(t.db as never, subjectId) // active: fine
    expect(cred.tokens.access_token).toBeTruthy()

    await deactivate(subjectId)
    await expect(
      issueTokens(t.db as never, {
        teammateId: subjectId,
        clientId: cred.clientId,
        scope: 'tokenscope.emit',
      }),
    ).rejects.toBeInstanceOf(OAuthError)
  })

  it('issueTokens FAILS CLOSED for a teammate row that does not exist at all', async () => {
    const cred = await issueEmitCredential(t.db as never, controlId)
    await expect(
      issueTokens(t.db as never, {
        teammateId: '9a1e0000-0000-4000-8000-00000000dead',
        clientId: cred.clientId,
        scope: 'tokenscope.emit',
      }),
    ).rejects.toBeInstanceOf(OAuthError)
  })
})
