// @vitest-environment node
/*
 * AUTH-7 + AUTH-6 (robustness-review-2026-06-09) — instance-route hardening.
 *
 *   AUTH-7: malformed instanceId → clean 400 (was a raw ZodError 500), and the
 *   bearer is authenticated BEFORE the existence lookup — an unauthenticated
 *   caller gets the SAME status (401) for an existing and a non-existing
 *   instance id (no existence oracle at a DB round-trip per probe).
 *
 *   AUTH-6: a rejected token only opens the bearer-auth-failed disaster signal
 *   when it actually carries tokenscope.emit — a valid-but-read-scoped token
 *   presented at /bearer (misconfigured helper) must NOT forge a "your emit
 *   credential failed" health row.
 *
 * Harness mirrors tests/integration/instances/bearer-oauth.test.ts.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { randomUUID } from 'node:crypto'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'
import * as schema from '../../../drizzle/schema'
import { resetHmacKeyForTests } from '../../../server/auth/hmac'
import { issueEmitCredential, ensureEmitClient } from '../../../server/auth/emit-credential'
import { issueTokens } from '../../../server/auth/oauth'
import { injectTestSession } from '../../helpers/auth'
import type { Session } from '../../../server/utils/auth'
import bearerHandler from '../../../server/api/v1/instances/[instanceId]/bearer.get'
import endHandler from '../../../server/api/v1/instances/[instanceId]/end.post'
import claudeSessionsHandler from '../../../server/api/v1/instances/[instanceId]/claude-sessions.post'
import deleteHandler from '../../../server/api/v1/instances/[instanceId].delete'

let t: TestDb
let regionId: string
let ouId: string
let ownerId: string

beforeAll(async () => {
  t = await startTestDb()
  process.env.DATABASE_URL = t.url
  process.env.NUXT_HMAC_SESSION_KEY = 'route-hardening-test-key-padded-well-beyond-32'
  process.env.NUXT_SESSION_SECRET = 'route-hardening-test-padded-to-thirty-two-chars'
  resetHmacKeyForTests()

  const [r] = await t.db.insert(schema.region).values({ code: 'rh-r', displayName: 'RH R' }).returning()
  regionId = r!.id
  const [o] = await t.db
    .insert(schema.orgUnit)
    .values({ regionId, path: 'rh.svc', code: 'rh-svc', displayName: 'Svc', unitType: 'bu' })
    .returning()
  ouId = o!.id
  const [owner] = await t.db
    .insert(schema.teammate)
    .values({ entraOid: 'oid-rh-owner', email: 'rh-owner@x.test', role: 'developer', regionId, orgUnitId: ouId })
    .returning()
  ownerId = owner!.id
}, 60_000)

afterAll(async () => {
  await stopTestDb(t)
}, 30_000)

async function enrolInstance(): Promise<string> {
  const instanceId = randomUUID()
  await t.client.unsafe(`
    INSERT INTO instance_attestation (instance_id, principal_oid, principal_email, teammate_id, tool, ts_start, region_id, org_unit_id, attestation_state)
    VALUES ('${instanceId}','oid-rh','rh-owner@x.test','${ownerId}','claude-code','${new Date().toISOString()}','${regionId}','${ouId}','unassigned')`)
  return instanceId
}

function instanceEvent(instanceId: string, opts: { token?: string; method?: string; session?: Session } = {}) {
  const headers: Record<string, string> = {
    host: 'localhost:3450',
    origin: 'http://localhost:3450',
    'content-type': 'application/json',
  }
  if (opts.token) headers.authorization = `Bearer ${opts.token}`
  const method = opts.method ?? 'GET'
  const e = {
    method,
    path: '/x',
    context: { params: { instanceId } },
    node: {
      req: { method, url: '/x', body: {}, get headers() { return headers } },
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
  if (opts.session) injectTestSession(e as unknown as Parameters<typeof injectTestSession>[0], opts.session)
  return e
}

async function statusOfRejection(p: Promise<unknown>): Promise<number> {
  try {
    await p
    throw new Error('expected rejection')
  } catch (err) {
    return (err as { statusCode: number }).statusCode
  }
}

async function openBearerFailures(instanceId: string): Promise<number> {
  const rows = await t.client<{ c: string }[]>`
    SELECT COUNT(*)::text AS c FROM instance_attestation_health
     WHERE instance_id = ${instanceId}::uuid AND status = 'bearer-auth-failed' AND resolved_at IS NULL`
  return Number(rows[0]!.c)
}

const adminSession = (): Session =>
  ({ teammateId: ownerId, email: 'rh-admin@x.test', displayName: 'A', role: 'platform-admin', regionId, orgPath: 'rh.svc' }) as Session

describe('AUTH-7 — malformed instanceId → 400, not 500', () => {
  it('bearer.get', async () => {
    expect(await statusOfRejection(bearerHandler(instanceEvent('not-a-uuid') as never))).toBe(400)
  })
  it('end.post', async () => {
    expect(await statusOfRejection(endHandler(instanceEvent('not-a-uuid', { method: 'POST' }) as never))).toBe(400)
  })
  it('claude-sessions.post', async () => {
    expect(
      await statusOfRejection(claudeSessionsHandler(instanceEvent('not-a-uuid', { method: 'POST' }) as never)),
    ).toBe(400)
  })
  it('36-hex-no-dashes (the known-bad shape) → 400 too', async () => {
    expect(
      await statusOfRejection(bearerHandler(instanceEvent('a'.repeat(36)) as never)),
    ).toBe(400)
  })
  it('[instanceId].delete (authenticated admin)', async () => {
    expect(
      await statusOfRejection(
        deleteHandler(instanceEvent('not-a-uuid', { method: 'DELETE', session: adminSession() }) as never),
      ),
    ).toBe(400)
  })
})

describe('AUTH-7 — no unauthenticated existence oracle', () => {
  it('bearer.get: existing and non-existing ids return the SAME status for an unauthenticated caller', async () => {
    const existing = await enrolInstance()
    const missing = randomUUID()
    const sNoToken = await statusOfRejection(bearerHandler(instanceEvent(existing) as never))
    const sNoTokenMissing = await statusOfRejection(bearerHandler(instanceEvent(missing) as never))
    const sBadToken = await statusOfRejection(bearerHandler(instanceEvent(existing, { token: 'garbage' }) as never))
    const sBadTokenMissing = await statusOfRejection(bearerHandler(instanceEvent(missing, { token: 'garbage' }) as never))
    expect(sNoToken).toBe(401)
    expect(new Set([sNoToken, sNoTokenMissing, sBadToken, sBadTokenMissing]).size).toBe(1)
  })

  it('end.post: existing and non-existing ids return the SAME status for an unauthenticated caller', async () => {
    const existing = await enrolInstance()
    const missing = randomUUID()
    const sExisting = await statusOfRejection(endHandler(instanceEvent(existing, { method: 'POST', token: 'garbage' }) as never))
    const sMissing = await statusOfRejection(endHandler(instanceEvent(missing, { method: 'POST', token: 'garbage' }) as never))
    expect(sExisting).toBe(401)
    expect(sMissing).toBe(401)
  })

  it('claude-sessions.post: existing and non-existing ids return the SAME status for an unauthenticated caller', async () => {
    const existing = await enrolInstance()
    const missing = randomUUID()
    const sExisting = await statusOfRejection(
      claudeSessionsHandler(instanceEvent(existing, { method: 'POST', token: 'garbage' }) as never),
    )
    const sMissing = await statusOfRejection(
      claudeSessionsHandler(instanceEvent(missing, { method: 'POST', token: 'garbage' }) as never),
    )
    expect(sExisting).toBe(401)
    expect(sMissing).toBe(401)
  })

  it('an AUTHENTICATED owner still gets 404 for a missing id and a mint for their own', async () => {
    const existing = await enrolInstance()
    const cred = await issueEmitCredential(t.db as never, ownerId)
    const out = (await bearerHandler(instanceEvent(existing, { token: cred.tokens.access_token }) as never)) as {
      Authorization: string
    }
    expect(out.Authorization).toMatch(/^Bearer /)
    expect(
      await statusOfRejection(bearerHandler(instanceEvent(randomUUID(), { token: cred.tokens.access_token }) as never)),
    ).toBe(404)
  })
})

describe('AUTH-6 — only a rejected EMIT credential opens the disaster signal', () => {
  it('a valid-but-READ-scoped token of the OWNER at /bearer → 401 but NO bearer-auth-failed row', async () => {
    const instanceId = await enrolInstance()
    // A read/tag token for the owner (a misconfigured helper presenting the MCP
    // credential instead of the emit credential).
    const clientId = await ensureEmitClient(t.db as never)
    const readTokens = await issueTokens(t.db as never, {
      teammateId: ownerId,
      clientId,
      scope: 'tokenscope.read tokenscope.tag',
    })
    expect(
      await statusOfRejection(bearerHandler(instanceEvent(instanceId, { token: readTokens.access_token }) as never)),
    ).toBe(401)
    expect(await openBearerFailures(instanceId)).toBe(0)
  })

  it("the owner's REJECTED (revoked) EMIT credential still records the signal", async () => {
    const instanceId = await enrolInstance()
    const cred = await issueEmitCredential(t.db as never, ownerId)
    await t.client.unsafe(
      `UPDATE oauth_token SET revoked_at = NOW() WHERE access_token_hash IS NOT NULL AND scope = 'tokenscope.emit' AND teammate_id = '${ownerId}'`,
    )
    expect(
      await statusOfRejection(bearerHandler(instanceEvent(instanceId, { token: cred.tokens.access_token }) as never)),
    ).toBe(401)
    expect(await openBearerFailures(instanceId)).toBe(1)
  })
})
