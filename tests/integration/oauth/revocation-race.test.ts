/*
 * #431 — an interactive token minted while a region move (or role change, or
 * revoke-sessions) commits must not skip the forced re-login.
 *
 * The move bumps teammate.revoked_at to its transaction's NOW() and revokes the
 * teammate's interactive tokens, holding the teammate row FOR NO KEY UPDATE
 * until it commits. Two holes, both closed in server/auth/oauth.ts:
 *
 *  1. THE EXCHANGE. A token inserted after the move's revocation query and
 *     before its commit escaped both: the move never saw it, and its issue time
 *     postdated revoked_at. consumeAuthCode now locks the teammate row first, so
 *     the two serialise. Both orders are proven below with a real second
 *     transaction held open.
 *  2. THE CONSENT. A code approved while the move was open was created after
 *     the move's NOW(), so "revoked_at < created_at" let it through although the
 *     session that approved it was void. The code now carries that session's
 *     mint time (session_issued_at, mig 0168) and the exchange judges the
 *     earlier of the two.
 *
 * Real Postgres; reassignTeammateRegion is the real move. The role-change
 * PATCH and revoke-sessions are not driven here: they share its order (UPDATE
 * teammate, which takes the same FOR NO KEY UPDATE lock, then revoke the
 * tokens in the same transaction), which is what both cases depend on.
 *
 * Every held transaction is released in a finally: a failed assertion must
 * not leave the teammate row locked for the next case's beforeEach.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { randomBytes, createHash } from 'node:crypto'
import { sql } from 'drizzle-orm'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'
import * as schema from '../../../drizzle/schema'
import { injectTestSession } from '../../helpers/auth'
import type { Session } from '../../../server/utils/auth'
import { consumeAuthCode, issueAuthCode, issueTokens } from '../../../server/auth/oauth'
import { hashSessionToken } from '../../../server/auth/hmac'
import { reassignTeammateRegion } from '../../../server/db/reassign-teammate-region'
import authorizePostHandler from '../../../server/api/v1/oauth/authorize.post'

let t: TestDb
let regionAId: string
let regionBId: string
let ouAId: string
let ouBId: string
let subjectId: string
let adminId: string
let clientId: string

const REDIRECT_URI = 'http://localhost:43117/callback'

beforeAll(async () => {
  t = await startTestDb()
  process.env.DATABASE_URL = t.url
  process.env.NUXT_SESSION_SECRET = 'revocation-race-test-padded-to-32-chars'
  process.env.NUXT_HMAC_SESSION_KEY = 'revocation-race-test-hmac-key-padded-beyond-32-chars'

  const [rA] = await t.db.insert(schema.region).values({ code: 'rc-a', displayName: 'RC A' }).returning()
  const [rB] = await t.db.insert(schema.region).values({ code: 'rc-b', displayName: 'RC B' }).returning()
  regionAId = rA!.id
  regionBId = rB!.id
  const [oA] = await t.db.insert(schema.orgUnit).values({ regionId: regionAId, path: 'rc-a.svc', code: 'rc-a-svc', displayName: 'A Svc', unitType: 'bu', isCostOwningUnit: true }).returning()
  const [oB] = await t.db.insert(schema.orgUnit).values({ regionId: regionBId, path: 'rc-b.svc', code: 'rc-b-svc', displayName: 'B Svc', unitType: 'bu', isCostOwningUnit: true }).returning()
  ouAId = oA!.id
  ouBId = oB!.id
  const [sub] = await t.db.insert(schema.teammate).values({ entraOid: 'rc-oid-subject', email: 'rc-subject@x.test', role: 'developer', regionId: regionAId, orgUnitId: ouAId }).returning()
  const [adm] = await t.db.insert(schema.teammate).values({ entraOid: 'rc-oid-admin', email: 'rc-admin@x.test', role: 'platform-admin', regionId: regionAId, orgUnitId: ouAId }).returning()
  subjectId = sub!.id
  adminId = adm!.id
  const [c] = await t.db.insert(schema.oauthClient).values({ clientSecretHash: 'unused', redirectUris: [REDIRECT_URI] }).returning()
  clientId = c!.clientId
}, 90_000)

afterAll(async () => {
  await stopTestDb(t)
}, 30_000)

beforeEach(async () => {
  await t.client`UPDATE teammate SET revoked_at = NULL, region_id = ${regionAId}::uuid, org_unit_id = ${ouAId}::uuid
                  WHERE id = ${subjectId}::uuid`
  await t.client`DELETE FROM oauth_token WHERE teammate_id = ${subjectId}::uuid`
})

async function mintCode(sessionIssuedAt: string): Promise<string> {
  const challenge = createHash('sha256').update(randomBytes(32)).digest('base64url')
  return issueAuthCode(t.db as never, {
    clientId,
    teammateId: subjectId,
    redirectUri: REDIRECT_URI,
    scope: 'tokenscope.read',
    codeChallenge: challenge,
    codeChallengeMethod: 'S256',
    sessionIssuedAt,
  })
}

/** The token.post.ts exchange, minus the request plumbing: consume, then mint. */
async function exchange(tx: unknown, raw: string): Promise<boolean> {
  const code = await consumeAuthCode(tx as never, raw)
  if (!code) return false
  await issueTokens(tx as never, { teammateId: code.teammateId, clientId, scope: code.scope })
  return true
}

const move = (tx: unknown) =>
  reassignTeammateRegion(tx as never, { teammateId: subjectId, regionId: regionBId, orgUnitId: ouBId, caller: { teammateId: adminId } })

/** Resolves once some backend is waiting on a row lock in this database. */
async function waitForBlockedLock(): Promise<void> {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    const [r] = await t.client<{ n: number }[]>`
      SELECT COUNT(*)::int AS n FROM pg_locks l
        JOIN pg_database d ON d.oid = l.database
       WHERE NOT l.granted AND d.datname = current_database()`
    // A row-lock wait shows as a waiting transactionid or tuple lock, which
    // carries no database; count those too.
    const [w] = await t.client<{ n: number }[]>`
      SELECT COUNT(*)::int AS n FROM pg_stat_activity
       WHERE datname = current_database() AND wait_event_type = 'Lock'`
    if (r!.n > 0 || w!.n > 0) return
    await new Promise((res) => setTimeout(res, 25))
  }
  throw new Error('no backend ever blocked on a lock')
}

function gate() {
  let open!: () => void
  const p = new Promise<void>((res) => (open = res))
  return { p, open }
}

async function liveTokens(): Promise<number> {
  const [r] = await t.client<{ n: number }[]>`
    SELECT COUNT(*)::int AS n FROM oauth_token WHERE teammate_id = ${subjectId}::uuid AND revoked_at IS NULL`
  return r!.n
}

describe('#431: exchange vs a committing region move', () => {
  it('move first: the exchange waits for the move, then refuses the code', async () => {
    const raw = await mintCode(new Date().toISOString())
    const hold = gate()
    const moved = gate()

    const moveTx = t.db.transaction(async (tx) => {
      await move(tx)
      moved.open()
      await hold.p
    })
    await moved.p
    let exchangeDone = false
    const exchangeTx = t.db
      .transaction(async (tx) => exchange(tx, raw))
      .finally(() => (exchangeDone = true))

    try {
      await waitForBlockedLock()
      expect(exchangeDone).toBe(false)
    } finally {
      hold.open()
    }
    await moveTx

    expect(await exchangeTx).toBe(false)
    expect(await liveTokens()).toBe(0)
  })

  it('exchange first: the move waits for the exchange, then revokes its token', async () => {
    const raw = await mintCode(new Date().toISOString())
    const hold = gate()
    const exchanged = gate()

    const exchangeTx = t.db.transaction(async (tx) => {
      const ok = await exchange(tx, raw)
      exchanged.open()
      await hold.p
      return ok
    })
    await exchanged.p
    let moveDone = false
    const moveTx = t.db.transaction(async (tx) => move(tx)).finally(() => (moveDone = true))

    try {
      await waitForBlockedLock()
      expect(moveDone).toBe(false)
    } finally {
      hold.open()
    }
    expect(await exchangeTx).toBe(true)
    await moveTx

    // The token was minted, and the move that committed after it revoked it.
    const [r] = await t.client<{ n: number }[]>`SELECT COUNT(*)::int AS n FROM oauth_token WHERE teammate_id = ${subjectId}::uuid`
    expect(r!.n).toBe(1)
    expect(await liveTokens()).toBe(0)
  })
})

describe('#431: the exchange does not wait without limit', () => {
  it('a teammate row held past the lock timeout fails the exchange and leaves the code unconsumed', async () => {
    const raw = await mintCode(new Date().toISOString())
    const hold = gate()
    const locked = gate()
    const holder = t.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT 1 FROM teammate WHERE id = ${subjectId}::uuid FOR NO KEY UPDATE`)
      locked.open()
      await hold.p
    })
    await locked.p
    try {
      const err = await t.db.transaction((tx) => exchange(tx, raw)).then(() => null, (e: unknown) => e)
      // drizzle may wrap the driver error; the Postgres message is on it or its cause.
      const e = err as { message?: string; cause?: { message?: string } } | null
      expect(`${e?.message ?? ''} ${e?.cause?.message ?? ''}`).toMatch(/lock timeout/i)
    } finally {
      hold.open()
    }
    await holder
    const [row] = await t.client<{ consumed_at: string | null }[]>`
      SELECT consumed_at::text AS consumed_at FROM oauth_auth_code WHERE code_hash = ${hashSessionToken(raw)}`
    expect(row!.consumed_at).toBeNull()
    expect(await liveTokens()).toBe(0)
  }, 20_000)
})

describe('#431: the code is judged by the session that approved it', () => {
  it('refuses a code whose approving session predates revoked_at, though the code itself is newer', async () => {
    // The consent was approved on a session minted a minute ago; the move's
    // NOW() landed 30 s ago; the code row itself is created now.
    await t.client`UPDATE teammate SET revoked_at = now() - interval '30 seconds' WHERE id = ${subjectId}::uuid`
    const raw = await mintCode(new Date(Date.now() - 60_000).toISOString())
    expect(await t.db.transaction((tx) => exchange(tx, raw))).toBe(false)
    // Refused in the CAS, so the code is not burned (same as deactivation).
    const [row] = await t.client<{ consumed_at: string | null }[]>`
      SELECT consumed_at::text AS consumed_at FROM oauth_auth_code WHERE code_hash = ${hashSessionToken(raw)}`
    expect(row!.consumed_at).toBeNull()
  })

  it('accepts a code from a session minted after revoked_at (the re-login)', async () => {
    await t.client`UPDATE teammate SET revoked_at = now() - interval '30 seconds' WHERE id = ${subjectId}::uuid`
    const raw = await mintCode(new Date(Date.now() - 10_000).toISOString())
    expect(await t.db.transaction((tx) => exchange(tx, raw))).toBe(true)
    expect(await liveTokens()).toBe(1)
  })

  it('an unreadable session mint time fails closed', async () => {
    await t.client`UPDATE teammate SET revoked_at = now() - interval '30 seconds' WHERE id = ${subjectId}::uuid`
    const raw = await mintCode('not-a-date')
    expect(await t.db.transaction((tx) => exchange(tx, raw))).toBe(false)
  })

  it('a code minted before mig 0168 (no session_issued_at) keeps the created_at rule', async () => {
    await t.client`UPDATE teammate SET revoked_at = now() - interval '30 seconds' WHERE id = ${subjectId}::uuid`
    const raw = await mintCode(new Date(Date.now() - 60_000).toISOString())
    await t.client`UPDATE oauth_auth_code SET session_issued_at = NULL WHERE code_hash = ${hashSessionToken(raw)}`
    expect(await t.db.transaction((tx) => exchange(tx, raw))).toBe(true)
  })

  it('POST /oauth/authorize stores the approving session’s mint time on the code', async () => {
    const issuedAt = new Date(Date.now() - 120_000).toISOString()
    const session = {
      teammateId: subjectId,
      email: 'rc-subject@x.test',
      displayName: 'S',
      role: 'developer',
      regionId: regionAId,
      orgPath: 'rc-a.svc',
      issuedAt,
    } as Session
    const challenge = createHash('sha256').update(randomBytes(32)).digest('base64url')
    const e = {
      method: 'POST',
      path: '/x',
      context: { params: {} },
      node: {
        req: {
          method: 'POST',
          url: '/x',
          body: {
            client_id: clientId,
            redirect_uri: REDIRECT_URI,
            state: 's'.repeat(16),
            code_challenge: challenge,
            code_challenge_method: 'S256',
            scope: 'tokenscope.read',
            action: 'approve',
          },
          socket: { remoteAddress: '127.0.0.1' },
          get headers() {
            return { host: 'localhost:3450', origin: 'http://localhost:3450', accept: 'application/json', 'content-type': 'application/json' }
          },
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
    injectTestSession(e as unknown as Parameters<typeof injectTestSession>[0], session)
    const out = (await (authorizePostHandler as unknown as (e: unknown) => Promise<{ code?: string }>)(e))
    expect(out.code).toBeTruthy()
    const [row] = await t.db.execute<{ s: string }>(sql`
      SELECT session_issued_at AS s FROM oauth_auth_code WHERE code_hash = ${hashSessionToken(out.code!)}`)
    expect(new Date(row!.s).toISOString()).toBe(issuedAt)
  })
})
