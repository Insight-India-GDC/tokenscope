// @vitest-environment node
/*
 * ADR-0005 — /bearer is OAuth-ONLY: a durable `tokenscope.emit` access token.
 * The legacy per-instance 12h session token has been removed entirely. Coverage:
 *   - OAuth token whose teammate OWNS the instance → mints.
 *   - OAuth token whose teammate does NOT own the instance → 403.
 *   - E2-revoked teammate's OAuth token → 401.
 *   - An owned instance that is ended → 401 (lifecycle gate).
 *   - A bogus/unknown bearer (incl. a would-be legacy session token) → 401.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { randomUUID } from 'node:crypto'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'
import * as schema from '../../../drizzle/schema'
import { resetHmacKeyForTests } from '../../../server/auth/hmac'
import { issueEmitCredential } from '../../../server/auth/emit-credential'
import { refreshAccessToken } from '../../../server/auth/oauth'
import { issueInstanceEmitCredentialTx } from '../../../server/auth/emit-provision'
import bearerHandler from '../../../server/api/v1/instances/[instanceId]/bearer.get'
import healthHandler from '../../../server/api/v1/instances/[instanceId]/health.get'
import endHandler from '../../../server/api/v1/instances/[instanceId]/end.post'
import projectResolveHandler from '../../../server/api/v1/instances/[instanceId]/project-resolve.get'

let t: TestDb
let regionId: string
let ouId: string
let ownerId: string
let strangerId: string

beforeAll(async () => {
  t = await startTestDb()
  process.env.DATABASE_URL = t.url
  process.env.NUXT_HMAC_SESSION_KEY = 'bearer-oauth-test-key-padded-well-beyond-32-chars'
  process.env.NUXT_SESSION_SECRET = 'bearer-oauth-test-padded-to-thirty-two-chars!!'
  resetHmacKeyForTests()

  const [r] = await t.db.insert(schema.region).values({ code: 'bo-r', displayName: 'BO R' }).returning()
  regionId = r!.id
  const [o] = await t.db
    .insert(schema.orgUnit)
    .values({ regionId, path: 'bo.svc', code: 'bo-svc', displayName: 'Svc', unitType: 'bu' })
    .returning()
  ouId = o!.id
  const [owner] = await t.db
    .insert(schema.teammate)
    .values({ entraOid: 'oid-bo-owner', email: 'bo-owner@x.test', role: 'developer', regionId, orgUnitId: ouId })
    .returning()
  ownerId = owner!.id
  const [stranger] = await t.db
    .insert(schema.teammate)
    .values({ entraOid: 'oid-bo-stranger', email: 'bo-stranger@x.test', role: 'developer', regionId, orgUnitId: ouId })
    .returning()
  strangerId = stranger!.id
}, 60_000)

afterAll(async () => {
  await stopTestDb(t)
}, 30_000)

/** Enrol an instance owned by `teammateId`. Returns its id. */
async function enrolInstance(teammateId: string, email: string, tsStart = new Date()): Promise<{ instanceId: string }> {
  const instanceId = randomUUID()
  // session_token_hash is vestigial (the legacy 12h token was removed) — omitted.
  await t.client.unsafe(`
    INSERT INTO instance_attestation (instance_id, principal_oid, principal_email, teammate_id, tool, ts_start, region_id, org_unit_id, attestation_state)
    VALUES ('${instanceId}','oid-bo','${email}','${teammateId}','claude-code','${tsStart.toISOString()}','${regionId}','${ouId}','unassigned')`)
  return { instanceId }
}

/**
 * Mint a fresh emit-scoped OAuth access token for a teammate — via
 * issueEmitCredential, the SAME bypass helper bearer-revocation /
 * route-auth-hardening / project-resolve / end / mcp-tools / oauth-flow all
 * use. It NEVER sets oauth_token.instance_id (the legacy-permissive/NULL
 * shape) — exactly what makes it right for the "legacy grant still passes"
 * coverage below, and exactly why it must NOT be used to test the NEW
 * cross-instance DENIAL (see boundEmitAccessTokenFor).
 */
async function emitAccessTokenFor(teammateId: string): Promise<string> {
  const cred = await issueEmitCredential(t.db as never, teammateId)
  return cred.tokens.access_token
}

/**
 * Mint a fresh emit-scoped OAuth access token BOUND to a specific instance —
 * via issueInstanceEmitCredentialTx (the real bind path: redeem/enroll), NOT
 * issueEmitCredential. THE TEST-CORPUS TRAP (per the story): every other
 * helper in this repo's instance-route tests bypasses the binding, so a
 * denial case built on the wrong helper silently never fires. Asserts the
 * minted row's instance_id is genuinely set before returning, so a
 * regression in the mint path itself can't quietly turn this into another
 * unbound token.
 */
async function boundEmitAccessTokenFor(teammateId: string, instanceId: string): Promise<string> {
  const emit = await t.db.transaction((tx) =>
    issueInstanceEmitCredentialTx(tx as never, teammateId, instanceId, issueEmitCredential),
  )
  const [bound] = await t.client<{ n: string }[]>`
    SELECT COUNT(*)::text AS n FROM oauth_token
     WHERE teammate_id = ${teammateId}::uuid AND instance_id = ${instanceId}::uuid
       AND scope = 'tokenscope.emit' AND revoked_at IS NULL`
  if (Number(bound?.n ?? 0) < 1) {
    throw new Error('boundEmitAccessTokenFor: minted row is not instance-bound — test would prove nothing')
  }
  const refreshed = await refreshAccessToken(t.db as never, emit.refreshToken, emit.clientId)
  return refreshed.access_token
}

/** Minimal h3-event stub shared by all four /instances/{instanceId}/* routes. */
function instanceEvent(
  instanceId: string,
  token: string,
  opts: { method?: string; query?: Record<string, string> } = {},
) {
  const qs = opts.query ? '?' + new URLSearchParams(opts.query).toString() : ''
  const url = '/x' + qs
  // requireOAuthBearer sets a WWW-Authenticate header on the OAuth failure paths,
  // so provide a minimal res stub.
  return {
    // h3's getQuery(event) reads event.path (NOT node.req.url) — project-resolve's
    // code_hash query param silently vanished without this, failing its OWN
    // validation (400) before the auth/binding logic under test ever ran.
    path: url,
    context: { params: { instanceId } },
    node: {
      req: {
        method: opts.method ?? 'GET',
        url,
        headers: { authorization: `Bearer ${token}` },
      },
      res: {
        _headers: {} as Record<string, string | string[]>,
        statusCode: 200,
        getHeader(n: string) { return this._headers[n.toLowerCase()] },
        setHeader(n: string, v: string | string[]) { this._headers[n.toLowerCase()] = v },
        removeHeader(n: string) { this._headers[n.toLowerCase()] = '' },
        appendHeader(n: string, v: string | string[]) { this._headers[n.toLowerCase()] = v },
        get headersSent() { return false },
      },
    },
  }
}

const bearerEvent = instanceEvent

describe('ADR-0005 — /bearer OAuth emit credential', () => {
  it('mints for an OAuth token whose teammate OWNS the instance', async () => {
    const { instanceId } = await enrolInstance(ownerId, 'bo-owner@x.test')
    const access = await emitAccessTokenFor(ownerId)
    const ev = bearerEvent(instanceId, access)
    const out = (await bearerHandler(ev as never)) as { Authorization: string }
    expect(out.Authorization).toMatch(/^Bearer /)
    expect(ev.node.res.getHeader('cache-control')).toBe('no-store')
  })

  it('404s for an OAuth token whose teammate does NOT own the instance (403→404 collapse, server-edge-auth:agentic:0008)', async () => {
    // The 403/404 split is collapsed to a single 404 (mirrors
    // me/instances/[instanceId]/revoke.post.ts) so a stranger can't tell
    // "exists but isn't yours" from "doesn't exist" — see the identical-body
    // assertion in the "no existence oracle" describe block below.
    const { instanceId } = await enrolInstance(ownerId, 'bo-owner@x.test')
    const strangerAccess = await emitAccessTokenFor(strangerId)
    await expect(bearerHandler(bearerEvent(instanceId, strangerAccess) as never)).rejects.toMatchObject({
      statusCode: 404,
    })
  })

  it('401s for an E2-revoked teammate OAuth token', async () => {
    const { instanceId } = await enrolInstance(ownerId, 'bo-owner@x.test')
    const access = await emitAccessTokenFor(ownerId)
    // Revoke the teammate AFTER the token was issued → E2 cascade.
    await t.client.unsafe(`UPDATE teammate SET revoked_at = NOW() WHERE id = '${ownerId}'`)
    await expect(bearerHandler(bearerEvent(instanceId, access) as never)).rejects.toMatchObject({
      statusCode: 401,
    })
    // Cleanup for later tests.
    await t.client.unsafe(`UPDATE teammate SET revoked_at = NULL WHERE id = '${ownerId}'`)
  })

  it('401s for an OAuth token on an ENDED instance (owned)', async () => {
    const { instanceId } = await enrolInstance(ownerId, 'bo-owner@x.test')
    const access = await emitAccessTokenFor(ownerId)
    await t.client.unsafe(`UPDATE instance_attestation SET ts_actual_end = NOW() WHERE instance_id = '${instanceId}'`)
    await expect(bearerHandler(bearerEvent(instanceId, access) as never)).rejects.toMatchObject({
      statusCode: 401,
    })
  })

  it('rejects a bogus / unknown bearer with 401 (OAuth-only; no legacy session-token path)', async () => {
    const { instanceId } = await enrolInstance(ownerId, 'bo-owner@x.test')
    await expect(bearerHandler(bearerEvent(instanceId, 'totally-not-a-real-token') as never)).rejects.toMatchObject({
      statusCode: 401,
    })
  })

  it('a refreshed (rotated) emit access token still authenticates', async () => {
    const { instanceId } = await enrolInstance(ownerId, 'bo-owner@x.test')
    const cred = await issueEmitCredential(t.db as never, ownerId)
    const refreshed = await refreshAccessToken(t.db as never, cred.tokens.refresh_token, cred.clientId)
    const out = (await bearerHandler(bearerEvent(instanceId, refreshed.access_token) as never)) as {
      Authorization: string
    }
    expect(out.Authorization).toMatch(/^Bearer /)
  })
})

// Re-anchored went-silent: a rejected emit credential on a LIVE instance is the
// disaster signal; the endpoint records it (and clears it on recovery).
async function openBearerFailures(instanceId: string): Promise<number> {
  const rows = await t.client<{ c: string }[]>`
    SELECT COUNT(*)::text AS c FROM instance_attestation_health
     WHERE instance_id = ${instanceId}::uuid AND status = 'bearer-auth-failed' AND resolved_at IS NULL`
  return Number(rows[0]!.c)
}

describe('/bearer records the bearer-auth-failed health signal (owner-gated)', () => {
  it('records when the OWNER\'s real credential is rejected (revoked) on a live instance', async () => {
    const { instanceId } = await enrolInstance(ownerId, 'bo-owner@x.test')
    const access = await emitAccessTokenFor(ownerId)
    // The owner's durable credential dies → the token it minted is now revoked.
    await t.client.unsafe(`UPDATE oauth_token SET revoked_at = NOW() WHERE teammate_id = '${ownerId}'`)
    await expect(bearerHandler(bearerEvent(instanceId, access) as never)).rejects.toMatchObject({ statusCode: 401 })
    expect(await openBearerFailures(instanceId)).toBe(1)
    // Idempotent per episode: a second rejected hit does not open a second row.
    await expect(bearerHandler(bearerEvent(instanceId, access) as never)).rejects.toMatchObject({ statusCode: 401 })
    expect(await openBearerFailures(instanceId)).toBe(1)
  })

  it('does NOT record for a garbage / unrecognised token (abuse guard — can\'t forge an alert)', async () => {
    const { instanceId } = await enrolInstance(ownerId, 'bo-owner@x.test')
    await expect(bearerHandler(bearerEvent(instanceId, 'totally-bogus') as never)).rejects.toMatchObject({ statusCode: 401 })
    expect(await openBearerFailures(instanceId)).toBe(0)
  })

  it('does NOT record a FOREIGN teammate\'s rejected token against this instance', async () => {
    const { instanceId } = await enrolInstance(ownerId, 'bo-owner@x.test')
    const strangerAccess = await emitAccessTokenFor(strangerId)
    await t.client.unsafe(`UPDATE oauth_token SET revoked_at = NOW() WHERE teammate_id = '${strangerId}'`)
    await expect(bearerHandler(bearerEvent(instanceId, strangerAccess) as never)).rejects.toMatchObject({ statusCode: 401 })
    expect(await openBearerFailures(instanceId)).toBe(0)
  })

  it('a successful OWNER mint RESOLVES the open failure (recovery)', async () => {
    const { instanceId } = await enrolInstance(ownerId, 'bo-owner@x.test')
    await t.db.insert(schema.instanceAttestationHealth).values({ instanceId, status: 'bearer-auth-failed', payload: {} })
    expect(await openBearerFailures(instanceId)).toBe(1)
    const access = await emitAccessTokenFor(ownerId)
    await bearerHandler(bearerEvent(instanceId, access) as never) // valid owner token → resolves
    expect(await openBearerFailures(instanceId)).toBe(0)
  })

  it('a FOREIGN valid token does NOT resolve the owner\'s open failure (404; resolve is after ownership)', async () => {
    const { instanceId } = await enrolInstance(ownerId, 'bo-owner@x.test')
    await t.db.insert(schema.instanceAttestationHealth).values({ instanceId, status: 'bearer-auth-failed', payload: {} })
    const strangerAccess = await emitAccessTokenFor(strangerId)
    await expect(bearerHandler(bearerEvent(instanceId, strangerAccess) as never)).rejects.toMatchObject({ statusCode: 404 })
    expect(await openBearerFailures(instanceId)).toBe(1) // not resolved by a non-owner
  })

  it('does NOT record for an ENDED instance even with the owner\'s rejected token (lifecycle-expected)', async () => {
    const { instanceId } = await enrolInstance(ownerId, 'bo-owner@x.test')
    const access = await emitAccessTokenFor(ownerId)
    await t.client.unsafe(`UPDATE oauth_token SET revoked_at = NOW() WHERE teammate_id = '${ownerId}'`)
    await t.client.unsafe(`UPDATE instance_attestation SET ts_actual_end = NOW() WHERE instance_id = '${instanceId}'`)
    await expect(bearerHandler(bearerEvent(instanceId, access) as never)).rejects.toMatchObject({ statusCode: 401 })
    expect(await openBearerFailures(instanceId)).toBe(0)
  })
})

// ── Per-DEVICE binding (server-edge-auth:token_scope:0004, agentic:0004/0005/0008) ──
//
// oauth_token.instance_id is written at mint (mig 0031) but was never selected
// at USE — every instance-scoped consumer degraded a per-DEVICE binding to a
// per-TEAMMATE check. These four routes are the whole surface: one bound
// emit token must not drive ANY of the SAME teammate's OTHER devices.
//
// Well-formed but arbitrary — /project-resolve only needs a syntactically
// valid code_hash to reach the auth/binding layer under test; it never needs
// to resolve to a real project here.
const VALID_CODE_HASH = '0'.repeat(64)

const FOUR_INSTANCE_ROUTES: Array<{
  name: string
  call: (instanceId: string, token: string) => Promise<unknown>
}> = [
  { name: 'bearer', call: (id, tok) => bearerHandler(instanceEvent(id, tok) as never) },
  { name: 'health', call: (id, tok) => healthHandler(instanceEvent(id, tok) as never) },
  { name: 'end', call: (id, tok) => endHandler(instanceEvent(id, tok, { method: 'POST' }) as never) },
  {
    name: 'project-resolve',
    call: (id, tok) =>
      projectResolveHandler(instanceEvent(id, tok, { query: { code_hash: VALID_CODE_HASH } }) as never),
  },
]

describe('per-DEVICE binding — a device-bound emit token must not drive a DIFFERENT device', () => {
  it('instance-A\'s bound emit token is REJECTED (401, not 403/404) on instance-B\'s bearer/health/end/project-resolve', async () => {
    const { instanceId: instanceA } = await enrolInstance(ownerId, 'bo-owner@x.test')
    const { instanceId: instanceB } = await enrolInstance(ownerId, 'bo-owner@x.test')
    const boundToA = await boundEmitAccessTokenFor(ownerId, instanceA)

    for (const route of FOUR_INSTANCE_ROUTES) {
      await expect(
        route.call(instanceB, boundToA),
        `${route.name} should reject instance-A's token on instance-B`,
      ).rejects.toMatchObject({ statusCode: 401 })
    }
  })

  it('instance-A\'s bound emit token still WORKS on instance-A\'s own bearer/health/end/project-resolve', async () => {
    const { instanceId: instanceA } = await enrolInstance(ownerId, 'bo-owner@x.test')
    const boundToA = await boundEmitAccessTokenFor(ownerId, instanceA)

    // bearer + health + project-resolve first (non-terminal); end last (it
    // closes the instance — project-resolve/health have no lifecycle gate so
    // ordering only matters for /bearer, which does).
    await expect(bearerHandler(instanceEvent(instanceA, boundToA) as never)).resolves.toBeDefined()
    await expect(healthHandler(instanceEvent(instanceA, boundToA) as never)).resolves.toBeDefined()
    await expect(
      projectResolveHandler(instanceEvent(instanceA, boundToA, { query: { code_hash: VALID_CODE_HASH } }) as never),
    ).resolves.toBeDefined()
    await expect(endHandler(instanceEvent(instanceA, boundToA, { method: 'POST' }) as never)).resolves.toBeDefined()
  })
})

describe('legacy NULL-bound emit grant stays permissive (pre-mig-0031 devices must not brick)', () => {
  it('a legacy (oauth_token.instance_id = NULL) emit token still passes bearer/health/end/project-resolve', async () => {
    const { instanceId } = await enrolInstance(ownerId, 'bo-owner@x.test')
    const legacyAccess = await emitAccessTokenFor(ownerId) // NULL-bound by construction (never sets instance_id)

    const [row] = await t.client<{ instance_id: string | null }[]>`
      SELECT instance_id::text AS instance_id FROM oauth_token
       WHERE teammate_id = ${ownerId}::uuid AND scope = 'tokenscope.emit' AND revoked_at IS NULL
       ORDER BY access_issued_at DESC LIMIT 1`
    expect(row?.instance_id).toBeNull() // sanity: genuinely testing the permissive branch

    await expect(bearerHandler(instanceEvent(instanceId, legacyAccess) as never)).resolves.toBeDefined()
    await expect(healthHandler(instanceEvent(instanceId, legacyAccess) as never)).resolves.toBeDefined()
    await expect(
      projectResolveHandler(instanceEvent(instanceId, legacyAccess, { query: { code_hash: VALID_CODE_HASH } }) as never),
    ).resolves.toBeDefined()
    await expect(endHandler(instanceEvent(instanceId, legacyAccess, { method: 'POST' }) as never)).resolves.toBeDefined()
  })
})

describe('no existence oracle — an unknown id and a peer\'s real instance are indistinguishable', () => {
  it('produce the IDENTICAL status + body on bearer/health/end/project-resolve (404 collapse)', async () => {
    const { instanceId: peerInstance } = await enrolInstance(strangerId, 'bo-stranger@x.test')
    const unknownId = randomUUID()
    const access = await emitAccessTokenFor(ownerId) // legacy-shape (NULL-bound) token; owner ≠ stranger either way

    for (const route of FOUR_INSTANCE_ROUTES) {
      const unknownErr = (await route.call(unknownId, access).catch((e) => e)) as {
        statusCode?: number
        statusMessage?: string
        data?: unknown
      }
      const peerErr = (await route.call(peerInstance, access).catch((e) => e)) as {
        statusCode?: number
        statusMessage?: string
        data?: unknown
      }
      expect(unknownErr.statusCode, `${route.name}: unknown id`).toBe(404)
      expect(peerErr.statusCode, `${route.name}: peer's real instance`).toBe(404)
      expect(
        { statusCode: peerErr.statusCode, statusMessage: peerErr.statusMessage, data: peerErr.data },
        `${route.name}: body must match the unknown-id body exactly`,
      ).toEqual({ statusCode: unknownErr.statusCode, statusMessage: unknownErr.statusMessage, data: unknownErr.data })
    }
  })
})

/**
 * /health PAYLOAD contract.
 *
 * Rule 10 ("a module test is not a route test"), in its other costume: this route
 * was already exercised above, but only ever as `resolves.toBeDefined()` — an AUTH
 * smoke check. Its actual product contract, `last_emission =
 * MAX(attribution_record.ts_event) for THIS instance`, had NO coverage anywhere:
 * every last_emission test in the repo (landed-check / statusline / copilot-status)
 * is a CLIENT unit test with a mocked `fetch`, i.e. the client is verified against a
 * mock of a server contract nothing verified. On 2026-09-01 a device read
 * permanently-silent while its records were landing, and no test could have caught it.
 *
 * These run through the real handler → withMachineRls → Postgres.
 */
async function landRecord(instanceId: string, teammateId: string, tsEvent: Date): Promise<void> {
  await t.client.unsafe(`
    INSERT INTO attribution_record
      (instance_id, teammate_id, region_id, org_unit_id, tool, model, token_type,
       tokens, cost_usd, fidelity_tier, cost_basis, ts_event)
    VALUES ('${instanceId}','${teammateId}','${regionId}','${ouId}','claude-code','opus-5','input',
            100, 1.234567, 'exact', 'rate_card', '${tsEvent.toISOString()}')`)
}

type HealthBody = {
  instance_id: string
  last_emission: string | null
  last_bearer_at: string | null
  ts_start: string
  silent: boolean
  revoked: boolean
}

async function health(instanceId: string, token: string): Promise<HealthBody> {
  return (await healthHandler(instanceEvent(instanceId, token) as never)) as HealthBody
}

describe('/health payload contract (the assertion whose absence hid a live incident)', () => {
  it('a NEVER-landed enrolment reports last_emission null AND silent', async () => {
    const { instanceId } = await enrolInstance(ownerId, 'bo-owner@x.test')
    const tok = await boundEmitAccessTokenFor(ownerId, instanceId)

    const body = await health(instanceId, tok)
    expect(body.last_emission).toBeNull()
    expect(body.silent).toBe(true)
    expect(body.revoked).toBe(false)
  })

  it('a landed record SURFACES as last_emission = MAX(ts_event) — not null', async () => {
    const { instanceId } = await enrolInstance(ownerId, 'bo-owner@x.test')
    const tok = await boundEmitAccessTokenFor(ownerId, instanceId)
    const older = new Date(Date.now() - 60 * 60_000)
    const newest = new Date(Date.now() - 5 * 60_000)
    await landRecord(instanceId, ownerId, older)
    await landRecord(instanceId, ownerId, newest)

    const body = await health(instanceId, tok)
    // The regression that shipped: this came back null while rows existed.
    expect(body.last_emission).not.toBeNull()
    expect(Date.parse(body.last_emission!)).toBe(newest.getTime())
    expect(body.silent).toBe(false) // a recent landing is not silent
  })

  it("does NOT leak another instance's landings into this instance's watermark", async () => {
    const { instanceId: mine } = await enrolInstance(ownerId, 'bo-owner@x.test')
    const { instanceId: other } = await enrolInstance(ownerId, 'bo-owner@x.test')
    const tok = await boundEmitAccessTokenFor(ownerId, mine)
    await landRecord(other, ownerId, new Date(Date.now() - 5 * 60_000))

    const body = await health(mine, tok)
    // Instance-SCOPED: the sibling's row must not make this device look healthy.
    expect(body.last_emission).toBeNull()
    expect(body.silent).toBe(true)
  })

  it('returns ts_start so a client can AGE a never-landed enrolment', async () => {
    const enrolledAt = new Date(Date.now() - 3 * 60 * 60_000)
    const { instanceId } = await enrolInstance(ownerId, 'bo-owner@x.test', enrolledAt)
    const tok = await boundEmitAccessTokenFor(ownerId, instanceId)

    const body = await health(instanceId, tok)
    // Without this the statusline cannot tell a 90-second-old enrolment whose first
    // record is in flight from one that has never landed in hours — both are null.
    expect(Date.parse(body.ts_start)).toBe(enrolledAt.getTime())
    expect(body.last_emission).toBeNull()
  })
})
