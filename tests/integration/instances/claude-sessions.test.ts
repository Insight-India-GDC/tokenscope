// @vitest-environment node
/*
 * POST /api/v1/instances/{instanceId}/claude-sessions — the SessionStart hook's
 * "this session runs on this install" report (#494). Pinned here:
 *   - the owner's emit token records the report (204), idempotently;
 *   - the session id is normalised and held to Claude's UUID shape (400 else);
 *   - a non-owner's token 404s, byte-identical to an unknown instance;
 *   - an ended instance cannot report (the /bearer lifecycle gate);
 *   - a bogus bearer 401s before the body is read;
 *   - the per-instance hourly limit, after which new sessions 429 but a repeat
 *     of a recorded one is still a no-op 204.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { randomUUID } from 'node:crypto'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'
import * as schema from '../../../drizzle/schema'
import { resetHmacKeyForTests } from '../../../server/auth/hmac'
import { issueEmitCredential } from '../../../server/auth/emit-credential'
import handler, { REPORTS_PER_HOUR } from '../../../server/api/v1/instances/[instanceId]/claude-sessions.post'

let t: TestDb
let regionId: string
let ouId: string
let ownerId: string
let strangerId: string

beforeAll(async () => {
  t = await startTestDb()
  process.env.DATABASE_URL = t.url
  process.env.NUXT_HMAC_SESSION_KEY = 'csr-test-key-padded-well-beyond-thirty-two-chars'
  process.env.NUXT_SESSION_SECRET = 'csr-test-secret-padded-to-thirty-two-chars!!'
  resetHmacKeyForTests()

  const [r] = await t.db.insert(schema.region).values({ code: 'csr-r', displayName: 'CSR R' }).returning()
  regionId = r!.id
  const [o] = await t.db
    .insert(schema.orgUnit)
    .values({ regionId, path: 'csr.svc', code: 'csr-svc', displayName: 'Svc', unitType: 'bu' })
    .returning()
  ouId = o!.id
  const [owner] = await t.db
    .insert(schema.teammate)
    .values({ entraOid: 'oid-csr-owner', email: 'csr-owner@x.test', role: 'developer', regionId, orgUnitId: ouId })
    .returning()
  ownerId = owner!.id
  const [stranger] = await t.db
    .insert(schema.teammate)
    .values({ entraOid: 'oid-csr-stranger', email: 'csr-stranger@x.test', role: 'developer', regionId, orgUnitId: ouId })
    .returning()
  strangerId = stranger!.id
}, 60_000)

afterAll(async () => {
  await stopTestDb(t)
}, 30_000)

async function enrolInstance(teammateId: string, opts: { ended?: boolean } = {}): Promise<string> {
  const instanceId = randomUUID()
  await t.client.unsafe(`
    INSERT INTO instance_attestation (instance_id, principal_oid, principal_email, teammate_id, tool, ts_start, ts_actual_end, region_id, org_unit_id, attestation_state)
    VALUES ('${instanceId}','oid-csr','csr@x.test','${teammateId}','claude-code',NOW(),${opts.ended ? 'NOW()' : 'NULL'},'${regionId}','${ouId}','unassigned')`)
  return instanceId
}

async function tokenFor(teammateId: string): Promise<string> {
  const cred = await issueEmitCredential(t.db as never, teammateId)
  return cred.tokens.access_token
}

function event(instanceId: string, token: string, body: unknown) {
  return {
    method: 'POST',
    path: '/x',
    context: { params: { instanceId } },
    node: {
      req: {
        method: 'POST',
        url: '/x',
        body,
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
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

async function call(instanceId: string, token: string, body: unknown) {
  const ev = event(instanceId, token, body)
  try {
    await handler(ev as never)
    return { status: ev.node.res.statusCode }
  } catch (e) {
    const err = e as { statusCode?: number; statusMessage?: string; data?: unknown }
    return { status: err.statusCode, statusMessage: err.statusMessage, data: err.data }
  }
}

async function reports(instanceId: string): Promise<string[]> {
  const rows = await t.client<{ claude_session_id: string }[]>`
    SELECT claude_session_id FROM session_instance_report WHERE instance_id = ${instanceId}::uuid ORDER BY 1`
  return rows.map((r) => r.claude_session_id)
}

const SESSION = '9a1e0000-0000-4000-8000-0000000c5e55'

describe('POST /instances/:id/claude-sessions', () => {
  it('records the owner’s report, normalised, and a repeat is a no-op', async () => {
    const instanceId = await enrolInstance(ownerId)
    const token = await tokenFor(ownerId)
    expect(await call(instanceId, token, { claudeSessionId: ` ${SESSION.toUpperCase()} ` })).toEqual({ status: 204 })
    expect(await call(instanceId, token, { claudeSessionId: SESSION })).toEqual({ status: 204 })
    expect(await reports(instanceId)).toEqual([SESSION])
  })

  it('400s a session id that is not a UUID, and writes nothing', async () => {
    const instanceId = await enrolInstance(ownerId)
    const token = await tokenFor(ownerId)
    for (const body of [{}, { claudeSessionId: 'abc' }, { claudeSessionId: 42 }, null]) {
      expect((await call(instanceId, token, body)).status).toBe(400)
    }
    expect(await reports(instanceId)).toEqual([])
  })

  it('404s a non-owner, byte-identical to an unknown instance', async () => {
    const instanceId = await enrolInstance(ownerId)
    const strangerToken = await tokenFor(strangerId)
    const notOwned = await call(instanceId, strangerToken, { claudeSessionId: SESSION })
    const unknown = await call(randomUUID(), strangerToken, { claudeSessionId: SESSION })
    expect(notOwned.status).toBe(404)
    expect(notOwned).toEqual(unknown)
    expect(await reports(instanceId)).toEqual([])
  })

  it('refuses an ended instance', async () => {
    const instanceId = await enrolInstance(ownerId, { ended: true })
    const token = await tokenFor(ownerId)
    expect((await call(instanceId, token, { claudeSessionId: SESSION })).status).toBe(401)
    expect(await reports(instanceId)).toEqual([])
  })

  it('401s a bogus bearer, whatever the body', async () => {
    const instanceId = await enrolInstance(ownerId)
    expect((await call(instanceId, 'not-a-token', { claudeSessionId: SESSION })).status).toBe(401)
    expect((await call(instanceId, 'not-a-token', 'garbage')).status).toBe(401)
  })

  it('429s new sessions past the hourly limit, but a recorded session still 204s', async () => {
    const instanceId = await enrolInstance(ownerId)
    const token = await tokenFor(ownerId)
    const ids = Array.from({ length: REPORTS_PER_HOUR }, (_, i) => `9a1e0000-0000-4000-8000-${String(i).padStart(12, '0')}`)
    await t.client`
      INSERT INTO session_instance_report (claude_session_id, instance_id)
      SELECT unnest(${ids}::text[]), ${instanceId}::uuid`
    expect((await call(instanceId, token, { claudeSessionId: SESSION })).status).toBe(429)
    expect(await call(instanceId, token, { claudeSessionId: ids[0] })).toEqual({ status: 204 })
    expect((await reports(instanceId)).length).toBe(REPORTS_PER_HOUR)
  })
})
