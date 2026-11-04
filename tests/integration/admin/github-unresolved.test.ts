// @vitest-environment node
/*
 * Admin "Unresolved Copilot users" surface (identity-tail layer 3):
 *   GET  /api/v1/admin/reconciliation/github/unresolved — the live provider roster diffed
 *        against teammate_identity_map (both lanes) → the unmatched logins + context.
 *   POST /api/v1/admin/reconciliation/github/map — map a login → an existing teammate; writes
 *        the ENTERPRISE lane (source='admin-manual'), audited, so the reconciler then resolves it.
 *
 * The GitHub client + App-auth are MOCKED (no live calls); the DB is a real testcontainers PG
 * (so the roster read, the upsert, and the audit row are honest). Covers:
 *   - RBAC (developer → 403), input validation, not-found / non-github → 404/400
 *   - GET returns ONLY genuinely-unresolved logins (a mapped login drops out); PAT context
 *     (license org) vs App context (credits/day); a probe failure → clean 502 (never a partial
 *     list); SAFETY — the fake key never leaks
 *   - POST upserts the enterprise-lane row + audit event; rejects a provisional teammate; and the
 *     mapped login then RESOLVES through resolveGithubRoster (the money-path loop closes)
 */
import { randomUUID } from 'node:crypto'
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'
import { injectTestSession } from '../../helpers/auth'
import type { Session } from '../../../server/utils/auth'
import unresolvedGet from '../../../server/api/v1/admin/reconciliation/github/unresolved.get'
import mapPost from '../../../server/api/v1/admin/reconciliation/github/map.post'
import { resolveGithubRoster } from '../../../server/reconciliation/adapters/github'
import * as schema from '../../../drizzle/schema'
import type { DirectoryUser } from '../../../server/azure/directory'
import teammateSearchGet from '../../../server/api/v1/admin/reconciliation/github/teammate-search.get'

const FAKE_SECRET = 'SUPER-SECRET-APP-KEY-DO-NOT-LEAK-xyz789'

// Mutable client behaviour, shared with the hoisted mock.
const stub = vi.hoisted(() => ({
  seats: [] as Array<{ assignee: { login: string }; organization?: { login: string } | null }>,
  userDailyCredits: [] as Array<{ login: string; credits: number }>,
  failSeats: null as unknown,
  failMetrics: null as unknown,
  // Public-profile decoration: login -> profile, plus a forced failure.
  profiles: {} as Record<string, { name: string | null; email: string | null } | null>,
  failProfile: null as unknown,
  profileDelayMs: 0,
  profileCalls: [] as string[],
  // Entra directory (searchDirectory / getDirectoryUserByMailOrUpn).
  directoryHits: [] as DirectoryUser[],
  failDirectory: null as unknown,
}))

vi.mock('../../../server/reconciliation/adapters/github-client', () => {
  class GithubCopilotClient {
    async listSeats() { if (stub.failSeats) throw stub.failSeats; return stub.seats }
    async getUserDailyCredits() { if (stub.failMetrics) throw stub.failMetrics; return stub.userDailyCredits }
    async getUserProfile(login: string) {
      stub.profileCalls.push(login)
      if (stub.failProfile) throw stub.failProfile
      if (stub.profileDelayMs > 0) await new Promise((r) => setTimeout(r, stub.profileDelayMs))
      return stub.profiles[login.toLowerCase()] ?? null
    }
    static withApp() { return new GithubCopilotClient() }
    static withPat() { return new GithubCopilotClient() }
  }
  return { GithubCopilotClient }
})
vi.mock('../../../server/azure/directory', () => ({
  searchDirectory: async () => {
    if (stub.failDirectory) throw stub.failDirectory
    return stub.directoryHits
  },
  getDirectoryUserByMailOrUpn: async (email: string) => {
    if (stub.failDirectory) throw stub.failDirectory
    return stub.directoryHits.find((h) => h.email.toLowerCase() === email.toLowerCase()) ?? null
  },
  getDirectoryUserByOid: async (oid: string) => {
    if (stub.failDirectory) throw stub.failDirectory
    return stub.directoryHits.find((h) => h.oid === oid) ?? null
  },
}))
vi.mock('../../../server/reconciliation/adapters/github-app-auth', () => {
  // eslint-disable-next-line @typescript-eslint/no-extraneous-class
  class GithubAppAuth {}
  return { GithubAppAuth }
})

let t: TestDb
let regionId = ''
let ouId = ''
let adminId = ''
let devId = ''
let aliceId = ''
let bobId = ''
let provisionalId = ''
let appEntId = ''
let patEntId = ''
let anthEntId = ''

const APP_SLUG = 'app-unres-ent'
const PAT_SLUG = 'pat-unres-ent'

function evGet(opts: { session: Session; enterpriseId?: string; raw?: string }) {
  const qs = opts.raw !== undefined ? opts.raw : opts.enterpriseId !== undefined ? `?enterpriseId=${opts.enterpriseId}` : ''
  const headers: Record<string, string> = { host: 'localhost:3450', origin: 'http://localhost:3450' }
  const e = {
    method: 'GET',
    path: `/x${qs}`,
    context: { params: {} },
    node: {
      req: { method: 'GET', url: `/x${qs}`, socket: { remoteAddress: '127.0.0.1' }, get headers() { return headers } },
      res: baseRes(),
    },
  }
  injectTestSession(e as unknown as Parameters<typeof injectTestSession>[0], opts.session)
  return e as unknown as Parameters<typeof unresolvedGet>[0]
}

function evPost(opts: { session: Session; body?: unknown; origin?: string }) {
  const headers: Record<string, string> = { host: 'localhost:3450', origin: opts.origin ?? 'http://localhost:3450', 'content-type': 'application/json' }
  const e = {
    method: 'POST',
    path: '/x',
    context: { params: {} },
    node: {
      req: { method: 'POST', url: '/x', body: opts.body, socket: { remoteAddress: '127.0.0.1' }, get headers() { return headers } },
      res: baseRes(),
    },
  }
  injectTestSession(e as unknown as Parameters<typeof injectTestSession>[0], opts.session)
  return e as unknown as Parameters<typeof mapPost>[0]
}

function baseRes() {
  return {
    _headers: {} as Record<string, string | string[]>, statusCode: 200,
    getHeader(n: string) { return this._headers[n.toLowerCase()] },
    setHeader(n: string, v: string | string[]) { this._headers[n.toLowerCase()] = v },
    removeHeader(n: string) { this._headers[n.toLowerCase()] = '' },
    appendHeader(n: string, v: string | string[]) { this._headers[n.toLowerCase()] = v },
    get headersSent() { return false },
  }
}

const admin = (): Session => ({ teammateId: adminId, email: 'a@x.test', displayName: 'A', role: 'platform-admin', regionId, orgPath: 'd.svc' })
const dev = (): Session => ({ teammateId: devId, email: 'd@x.test', displayName: 'D', role: 'developer', regionId, orgPath: 'd.svc' })

type UnresolvedResult = Awaited<ReturnType<typeof unresolvedGet>>
const callGet = (e: ReturnType<typeof evGet>) => unresolvedGet(e) as Promise<UnresolvedResult>

async function auditCount(eventType: string, subjectId: string): Promise<number> {
  const rows = await t.client<{ n: string }[]>`
    SELECT COUNT(*)::text AS n FROM audit_event WHERE event_type = ${eventType} AND subject_id = ${subjectId}::uuid`
  return Number(rows[0]!.n)
}

beforeAll(async () => {
  t = await startTestDb()
  process.env.DATABASE_URL = t.url
  const [r] = await t.db.insert(schema.region).values({ code: 'ur-r', displayName: 'UR R' }).returning()
  regionId = r!.id
  const [o] = await t.db.insert(schema.orgUnit).values({ regionId, path: 'd.svc', code: 'd-svc', displayName: 'Svc', unitType: 'bu' }).returning()
  ouId = o!.id
  const [a] = await t.db.insert(schema.teammate).values({ entraOid: 'oid-ur-a', email: 'a@x.test', role: 'platform-admin', regionId, orgUnitId: ouId }).returning()
  adminId = a!.id
  const [d] = await t.db.insert(schema.teammate).values({ entraOid: 'oid-ur-d', email: 'd@x.test', role: 'developer', regionId, orgUnitId: ouId }).returning()
  devId = d!.id
  const [alice] = await t.db.insert(schema.teammate).values({ entraOid: 'oid-ur-alice', email: 'alice@x.test', role: 'developer', regionId, orgUnitId: ouId }).returning()
  aliceId = alice!.id
  const [bob] = await t.db.insert(schema.teammate).values({ entraOid: 'oid-ur-bob', email: 'bob@x.test', role: 'developer', regionId, orgUnitId: ouId }).returning()
  bobId = bob!.id
  const [prov] = await t.db.insert(schema.teammate).values({ entraOid: 'provisional:ur-1', email: 'shadow@x.test', role: 'developer', regionId, orgUnitId: ouId, provisional: true }).returning()
  provisionalId = prov!.id

  // App-mode enterprise (github_app_id set), App key wired to the fake secret.
  process.env.NUXT_GITHUB_APP_KEY_URAPP = FAKE_SECRET
  const [appEnt] = await t.db.insert(schema.providerEnterprise).values({
    provider: 'github', externalId: APP_SLUG, displayName: 'App Unres Ent', reconciliationMode: 'reconciled', credentialSecretName: 'urapp', githubAppId: '9990001',
  }).returning()
  appEntId = appEnt!.id

  // PAT-mode enterprise, PAT wired to the fake secret.
  process.env.NUXT_GITHUB_PAT_URPAT = FAKE_SECRET
  const [patEnt] = await t.db.insert(schema.providerEnterprise).values({
    provider: 'github', externalId: PAT_SLUG, displayName: 'PAT Unres Ent', reconciliationMode: 'reconciled', credentialSecretName: 'urpat',
  }).returning()
  patEntId = patEnt!.id

  const [anthEnt] = await t.db.insert(schema.providerEnterprise).values({
    provider: 'anthropic', externalId: 'anth-unres-ent', displayName: 'Anth', reconciliationMode: 'reconciled',
  }).returning()
  anthEntId = anthEnt!.id
}, 180_000)

afterAll(async () => {
  delete process.env.NUXT_GITHUB_APP_KEY_URAPP
  delete process.env.NUXT_GITHUB_PAT_URPAT
  await stopTestDb(t)
}, 30_000)

beforeEach(async () => {
  stub.seats = []
  stub.userDailyCredits = []
  stub.failSeats = null
  stub.failMetrics = null
  stub.profiles = {}
  stub.failProfile = null
  stub.profileDelayMs = 0
  stub.profileCalls = []
  stub.directoryHits = []
  stub.failDirectory = null
  // A clean identity map each test (both lanes).
  await t.client`DELETE FROM teammate_identity_map WHERE system = 'github'`
})

describe('GET unresolved — RBAC + validation', () => {
  it('a developer → 403', async () => {
    await expect(callGet(evGet({ session: dev(), enterpriseId: patEntId }))).rejects.toMatchObject({ statusCode: 403 })
  })
  it('a missing/invalid enterpriseId → 400', async () => {
    await expect(callGet(evGet({ session: admin(), raw: '' }))).rejects.toMatchObject({ statusCode: 400 })
    await expect(callGet(evGet({ session: admin(), raw: '?enterpriseId=nope' }))).rejects.toMatchObject({ statusCode: 400 })
  })
  it('an unknown enterprise → 404; an anthropic enterprise → 400', async () => {
    await expect(callGet(evGet({ session: admin(), enterpriseId: '00000000-0000-0000-0000-000000000001' }))).rejects.toMatchObject({ statusCode: 404 })
    await expect(callGet(evGet({ session: admin(), enterpriseId: anthEntId }))).rejects.toMatchObject({ statusCode: 400 })
  })
})

describe('GET unresolved — PAT mode (seat roster)', () => {
  it('returns ONLY the unmapped seat logins, with license-org context', async () => {
    // alice is already bound (enterprise lane); bob + carol are not.
    await t.db.insert(schema.teammateIdentityMap).values({
      teammateId: aliceId, system: 'github', identifier: 'alice', identifierKind: 'username', enterpriseSlug: PAT_SLUG,
    })
    stub.seats = [
      { assignee: { login: 'alice' }, organization: { login: 'acme-prod' } },
      { assignee: { login: 'bob' }, organization: { login: 'acme-prod' } },
      { assignee: { login: 'carol' }, organization: { login: 'acme-demo' } },
    ]
    const res = await callGet(evGet({ session: admin(), enterpriseId: patEntId }))
    expect(res.credentialKind).toBe('github-pat')
    expect(res.logins.map((l) => l.login)).toEqual(['bob', 'carol']) // alice excluded, sorted
    expect(res.logins.find((l) => l.login === 'bob')).toMatchObject({ licenseOrg: 'acme-prod', credits: null })
    expect(res.logins.find((l) => l.login === 'carol')).toMatchObject({ licenseOrg: 'acme-demo' })
    expect(JSON.stringify(res)).not.toContain(FAKE_SECRET)
  })

  it('a SELF-ONLY login stays listed, flagged with its claimant, until an admin binds it', async () => {
    await t.db.insert(schema.teammateIdentityMap).values({
      teammateId: bobId, system: 'github', identifier: 'bob', identifierKind: 'username', source: 'self',
    })
    stub.seats = [{ assignee: { login: 'bob' }, organization: { login: 'acme-prod' } }, { assignee: { login: 'carol' }, organization: null }]
    const res = await callGet(evGet({ session: admin(), enterpriseId: patEntId }))
    expect(res.logins.map((l) => l.login)).toEqual(['bob', 'carol'])
    const [bobEmail] = await t.client<{ email: string }[]>`SELECT email FROM teammate WHERE id = ${bobId}::uuid`
    expect(res.logins.find((l) => l.login === 'bob')).toMatchObject({ selfClaimedBy: bobEmail!.email })
    expect(res.logins.find((l) => l.login === 'carol')).toMatchObject({ licenseOrg: null, selfClaimedBy: null })

    // The enterprise-lane bind verifies it: off the queue.
    await t.db.insert(schema.teammateIdentityMap).values({
      teammateId: bobId, system: 'github', identifier: 'bob', identifierKind: 'username', enterpriseSlug: PAT_SLUG, source: 'admin-manual',
    })
    const after = await callGet(evGet({ session: admin(), enterpriseId: patEntId }))
    expect(after.logins.map((l) => l.login)).toEqual(['carol'])
  })

  it('dedups a multi-org unmapped login to ONE entry', async () => {
    stub.seats = [
      { assignee: { login: 'dave' }, organization: { login: 'org-a' } },
      { assignee: { login: 'dave' }, organization: { login: 'org-b' } },
    ]
    const res = await callGet(evGet({ session: admin(), enterpriseId: patEntId }))
    expect(res.logins).toHaveLength(1)
    expect(res.logins[0]!.login).toBe('dave')
  })

  it('a provider failure → clean 502 (never a partial/empty list)', async () => {
    stub.failSeats = { statusCode: 502, data: { status: 502, detail: `seats returned HTTP 403 token=${FAKE_SECRET}` } }
    await expect(callGet(evGet({ session: admin(), enterpriseId: patEntId }))).rejects.toMatchObject({ statusCode: 502 })
    // And the thrown error carries no secret.
    const err = await callGet(evGet({ session: admin(), enterpriseId: patEntId })).catch((e) => e)
    expect(JSON.stringify(err.data ?? err)).not.toContain(FAKE_SECRET)
  })
})

describe('GET unresolved — App mode (metrics report)', () => {
  it('returns the unmapped users with credits + day context', async () => {
    await t.db.insert(schema.teammateIdentityMap).values({
      teammateId: aliceId, system: 'github', identifier: 'alice', identifierKind: 'username', enterpriseSlug: APP_SLUG,
    })
    stub.userDailyCredits = [{ login: 'alice', credits: 100 }, { login: 'erin', credits: 42 }]
    const res = await callGet(evGet({ session: admin(), enterpriseId: appEntId }))
    expect(res.credentialKind).toBe('github-app')
    expect(res.logins.map((l) => l.login)).toEqual(['erin'])
    expect(res.logins[0]).toMatchObject({ credits: 42, licenseOrg: null })
    expect(res.logins[0]!.lastSeenDay).toBe(res.probeDay)
    expect(res.probeDay).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  it('a metrics-report failure → clean 502 (never a partial list), key-safe', async () => {
    stub.failMetrics = { statusCode: 502, data: { status: 502, detail: `users-1-day returned HTTP 404 token=${FAKE_SECRET}` } }
    const err = await callGet(evGet({ session: admin(), enterpriseId: appEntId })).catch((e) => e)
    expect(err).toMatchObject({ statusCode: 502 })
    expect(JSON.stringify(err.data ?? err)).not.toContain(FAKE_SECRET)
  })
})

describe('POST map — RBAC, CSRF, validation', () => {
  it('a developer → 403', async () => {
    await expect(mapPost(evPost({ session: dev(), body: { enterpriseId: patEntId, login: 'bob', teammateId: bobId } }))).rejects.toMatchObject({ statusCode: 403 })
  })
  it('a cross-origin request → CSRF rejection', async () => {
    await expect(
      mapPost(evPost({ session: admin(), origin: 'https://evil.example', body: { enterpriseId: patEntId, login: 'bob', teammateId: bobId } })),
    ).rejects.toMatchObject({ statusCode: expect.any(Number) })
  })
  it('an unknown enterprise → 404; an anthropic enterprise → 400', async () => {
    await expect(mapPost(evPost({ session: admin(), body: { enterpriseId: '00000000-0000-0000-0000-000000000001', login: 'bob', teammateId: bobId } }))).rejects.toMatchObject({ statusCode: 404 })
    await expect(mapPost(evPost({ session: admin(), body: { enterpriseId: anthEntId, login: 'bob', teammateId: bobId } }))).rejects.toMatchObject({ statusCode: 400 })
  })
  it('an unknown teammate → 404; a provisional teammate → 400', async () => {
    await expect(mapPost(evPost({ session: admin(), body: { enterpriseId: patEntId, login: 'bob', teammateId: '00000000-0000-0000-0000-000000000002' } }))).rejects.toMatchObject({ statusCode: 404 })
    await expect(mapPost(evPost({ session: admin(), body: { enterpriseId: patEntId, login: 'bob', teammateId: provisionalId } }))).rejects.toMatchObject({ statusCode: 400 })
  })
})

describe('POST map — the money-path loop closes', () => {
  it('upserts the ENTERPRISE-lane row + audit event; the mapped login then RESOLVES', async () => {
    const res = (await mapPost(evPost({
      session: admin(),
      body: { enterpriseId: patEntId, login: 'Bob', teammateId: bobId, licenseOrg: 'acme-prod' },
    }))) as { id: string; enterpriseSlug: string; login: string; teammateId: string; source: string }
    expect(res).toMatchObject({ enterpriseSlug: PAT_SLUG, login: 'bob', teammateId: bobId, source: 'admin-manual' })

    // The row is the enterprise lane (enterprise_slug = slug), source admin-manual, verified.
    const rows = await t.client<{ enterprise_slug: string | null; source: string; teammate_id: string; verified_at: string | null; license_org: string | null }[]>`
      SELECT enterprise_slug, source, teammate_id::text AS teammate_id, verified_at, license_org
      FROM teammate_identity_map WHERE system = 'github' AND lower(identifier) = 'bob'`
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ enterprise_slug: PAT_SLUG, source: 'admin-manual', teammate_id: bobId, license_org: 'acme-prod' })
    expect(rows[0]!.verified_at).not.toBeNull()

    // Audit event written (subject = the teammate).
    expect(await auditCount('copilot-login-mapped', bobId)).toBe(1)

    // The reconciler's roster reader now resolves the login → the loop is closed.
    const roster = await resolveGithubRoster(t.db, PAT_SLUG)
    expect(roster.get('bob')).toBe(bobId)

    // And the login no longer appears as unresolved for the same seat roster.
    stub.seats = [{ assignee: { login: 'bob' }, organization: { login: 'acme-prod' } }]
    const unres = await callGet(evGet({ session: admin(), enterpriseId: patEntId }))
    expect(unres.logins).toHaveLength(0)
  })

  it('is idempotent — a re-map cleanly re-binds (ON CONFLICT DO UPDATE), no 409', async () => {
    await mapPost(evPost({ session: admin(), body: { enterpriseId: patEntId, login: 'carol', teammateId: bobId } }))
    // Re-map the SAME login to a DIFFERENT teammate (admin override).
    const res = (await mapPost(evPost({ session: admin(), body: { enterpriseId: patEntId, login: 'carol', teammateId: aliceId } }))) as { teammateId: string }
    expect(res.teammateId).toBe(aliceId)
    const rows = await t.client<{ teammate_id: string }[]>`
      SELECT teammate_id::text AS teammate_id FROM teammate_identity_map WHERE system='github' AND lower(identifier)='carol'`
    expect(rows).toHaveLength(1)
    expect(rows[0]!.teammate_id).toBe(aliceId)
  })

  it('does NOT clobber a self-service link (NULL lane survives; enterprise lane still wins on read)', async () => {
    // Self-link carol → alice (NULL lane); then admin-map carol → bob (enterprise lane).
    await t.db.insert(schema.teammateIdentityMap).values({
      teammateId: aliceId, system: 'github', identifier: 'carol', identifierKind: 'username', source: 'self',
    })
    await mapPost(evPost({ session: admin(), body: { enterpriseId: patEntId, login: 'carol', teammateId: bobId } }))
    // BOTH rows coexist (different lanes).
    const rows = await t.client<{ enterprise_slug: string | null; teammate_id: string }[]>`
      SELECT enterprise_slug, teammate_id::text AS teammate_id FROM teammate_identity_map
      WHERE system='github' AND lower(identifier)='carol' ORDER BY enterprise_slug NULLS LAST`
    expect(rows).toHaveLength(2)
    // The reader picks the ENTERPRISE lane (bob), never the self-link (alice).
    const roster = await resolveGithubRoster(t.db, PAT_SLUG)
    expect(roster.get('carol')).toBe(bobId)
  })
})

/*
 * ── The map picker's directory fall-through, and the profile hint that feeds it ──
 *
 * These cover the fix for the structural emptiness described in teammate-search.get.ts's
 * header: everyone on the unresolved list is, by construction, someone `teammate` does not
 * contain, so a teammate-only picker could never resolve them.
 */

function evSearch(opts: { session: Session; q?: string; limit?: string }) {
  const parts: string[] = []
  if (opts.q !== undefined) parts.push(`q=${encodeURIComponent(opts.q)}`)
  if (opts.limit !== undefined) parts.push(`limit=${opts.limit}`)
  const qs = parts.length ? `?${parts.join('&')}` : ''
  const headers: Record<string, string> = { host: 'localhost:3450', origin: 'http://localhost:3450' }
  const e = {
    method: 'GET',
    path: `/x${qs}`,
    context: { params: {} },
    node: {
      req: { method: 'GET', url: `/x${qs}`, socket: { remoteAddress: '127.0.0.1' }, get headers() { return headers } },
      res: baseRes(),
    },
  }
  injectTestSession(e as unknown as Parameters<typeof injectTestSession>[0], opts.session)
  return e as unknown as Parameters<typeof teammateSearchGet>[0]
}

type SearchResult = { teammates: Array<{ id: string; email: string }>; directory: Array<{ oid: string; email: string; displayName: string | null }>; directoryError?: string | null }
const callSearch = (e: ReturnType<typeof evSearch>) => teammateSearchGet(e) as Promise<SearchResult>

// Stable per-email oids: POST /map binds on the oid, so a test that searches then maps must
// see the SAME oid both times.
const OIDS: Record<string, string> = {}
function dirUser(email: string, displayName: string, over: Partial<DirectoryUser> = {}): DirectoryUser {
  return {
    oid: OIDS[email] ?? (OIDS[email] = randomUUID()), email, displayName, mail: email, upn: email,
    department: 'Delivery', jobTitle: 'Engineer', companyName: null, country: null,
    officeLocation: null, state: null, costCenter: null, division: null, ...over,
  }
}

describe('GET teammate-search — the directory fall-through', () => {
  it('a developer → 403', async () => {
    await expect(callSearch(evSearch({ session: dev(), q: 'alice' }))).rejects.toMatchObject({ statusCode: 403 })
  })

  it('a missing/blank q → 400', async () => {
    await expect(callSearch(evSearch({ session: admin() }))).rejects.toMatchObject({ statusCode: 400 })
    await expect(callSearch(evSearch({ session: admin(), q: '   ' }))).rejects.toMatchObject({ statusCode: 400 })
  })

  it('drops a directory hit whose email is ALREADY a returned teammate (no duplicate offer)', async () => {
    stub.directoryHits = [dirUser('alice@x.test', 'Alice Other')]
    const res = await callSearch(evSearch({ session: admin(), q: 'alice@x.test' }))
    expect(res.teammates.map((t) => t.id)).toEqual([aliceId])
    expect(res.directory).toEqual([])
  })

  it('an UNRELATED teammate match does NOT suppress the directory result', async () => {
    // The teammate search is a substring ILIKE. An empty-only fall-through let one incidental
    // hit hide the person actually being looked for, which is the bug this endpoint exists to
    // fix, reintroduced one layer up.
    stub.directoryHits = [dirUser('ann.jose@example.test', 'Ann Jose')]
    const res = await callSearch(evSearch({ session: admin(), q: 'a' }))
    expect(res.teammates.length).toBeGreaterThan(0)
    expect(res.directory.map((d) => d.email)).toContain('ann.jose@example.test')
  })

  it('returns the OID for each directory hit — POST /map binds on it, not the email', async () => {
    stub.directoryHits = [dirUser('oid.probe@example.test', 'Oid Probe')]
    const res = await callSearch(evSearch({ session: admin(), q: 'oid probe' }))
    expect(res.directory[0]!.oid).toBe(OIDS['oid.probe@example.test'])
  })

  it('NO teammate match falls through to the directory — the unresolved-list case', async () => {
    stub.directoryHits = [dirUser('ann.jose@example.test', 'Ann Jose')]
    const res = await callSearch(evSearch({ session: admin(), q: 'ann jose' }))
    expect(res.teammates).toEqual([])
    expect(res.directory).toHaveLength(1)
    expect(res.directory[0]).toMatchObject({ email: 'ann.jose@example.test', displayName: 'Ann Jose' })
    expect(res.directoryError ?? null).toBeNull()
  })

  it('a provisional shadow is not a match, so the fall-through still fires', async () => {
    stub.directoryHits = [dirUser('shadow@x.test', 'Shadow Person')]
    const res = await callSearch(evSearch({ session: admin(), q: 'shadow@x.test' }))
    expect(res.teammates).toEqual([])
    expect(res.directory.map((d) => d.email)).toEqual(['shadow@x.test'])
  })

  it('a directory OUTAGE degrades to teammate-only and SAYS so (never a silent "no matches")', async () => {
    stub.failDirectory = new Error('graph exploded')
    const res = await callSearch(evSearch({ session: admin(), q: 'nobody-here' }))
    expect(res.teammates).toEqual([])
    expect(res.directory).toEqual([])
    expect(res.directoryError).toBe('unavailable')
  })

  it('reports the outage even when teammates DID match (silence would read as "not in Entra")', async () => {
    stub.failDirectory = new Error('graph exploded')
    const res = await callSearch(evSearch({ session: admin(), q: 'alice@x.test' }))
    expect(res.teammates.map((t) => t.id)).toEqual([aliceId])
    expect(res.directoryError).toBe('unavailable')
  })

  it('honours limit on the directory hits', async () => {
    // The query must match NO teammate, or the empty-only fall-through never fires.
    stub.directoryHits = Array.from({ length: 8 }, (_, i) => dirUser(`zz${i}@example.test`, `Zz ${i}`))
    const res = await callSearch(evSearch({ session: admin(), q: 'zz-nobody', limit: '3' }))
    expect(res.directory).toHaveLength(3)
  })
})

describe('POST map — directoryOid mode (provision inside the map tx)', () => {
  const countTeammates = async (email: string) => {
    const rows = await t.client<{ n: string }[]>`SELECT COUNT(*)::text AS n FROM teammate WHERE lower(email) = lower(${email})`
    return Number(rows[0]!.n)
  }

  it('rejects BOTH or NEITHER of teammateId / directoryOid → 400', async () => {
    await expect(mapPost(evPost({ session: admin(), body: { enterpriseId: patEntId, login: 'x1' } })))
      .rejects.toMatchObject({ statusCode: 400 })
    await expect(mapPost(evPost({ session: admin(), body: { enterpriseId: patEntId, login: 'x1', teammateId: aliceId, directoryOid: randomUUID() } })))
      .rejects.toMatchObject({ statusCode: 400 })
  })

  it('an oid the directory does not know → 404, and creates NO teammate', async () => {
    stub.directoryHits = []
    await expect(mapPost(evPost({ session: admin(), body: { enterpriseId: patEntId, login: 'ghost-login', directoryOid: randomUUID() } })))
      .rejects.toMatchObject({ statusCode: 404 })
    const rows = await t.client<{ n: string }[]>`SELECT COUNT(*)::text AS n FROM teammate WHERE entra_oid LIKE 'bill:%'`
    expect(Number(rows[0]!.n)).toBe(0)
  })

  it('an UNKNOWN enterprise provisions nothing — validation precedes every write', async () => {
    // The ordering guarantee: an earlier revision provisioned before resolving the enterprise,
    // so a bad enterpriseId still minted (and could re-home) a teammate before 404ing.
    const email = 'ordering.probe@example.test'
    stub.directoryHits = [dirUser(email, 'Ordering Probe')]
    await expect(mapPost(evPost({
      session: admin(),
      body: { enterpriseId: randomUUID(), login: 'ordering-login', directoryOid: OIDS[email]! },
    }))).rejects.toMatchObject({ statusCode: 404 })
    expect(await countTeammates(email)).toBe(0)
  })

  it('an ANTHROPIC enterprise provisions nothing either', async () => {
    const email = 'anth.probe@example.test'
    stub.directoryHits = [dirUser(email, 'Anth Probe')]
    await expect(mapPost(evPost({
      session: admin(),
      body: { enterpriseId: anthEntId, login: 'anth-login', directoryOid: OIDS[email]! },
    }))).rejects.toMatchObject({ statusCode: 400 })
    expect(await countTeammates(email)).toBe(0)
  })

  it('an EXCLUDED (privileged/service) directory identity is refused → 422, nothing created', async () => {
    const email = 'adm.svc@example.test'
    stub.directoryHits = [dirUser(email, 'Admin Service', { upn: 'adm.svc@example.test' })]
    // Patterns must pin a real domain (validateExclusionPattern), else they are skipped on load.
    await t.client`INSERT INTO directory_exclusion_pattern (pattern, note) VALUES ('adm.*@example.test', 'test')`
    try {
      await expect(mapPost(evPost({
        session: admin(),
        body: { enterpriseId: patEntId, login: 'svc-login', directoryOid: OIDS[email]! },
      }))).rejects.toMatchObject({ statusCode: 422 })
      expect(await countTeammates(email)).toBe(0)
    } finally {
      await t.client`DELETE FROM directory_exclusion_pattern WHERE pattern = 'adm.*@example.test'`
    }
  })

  it('provisions the directory user, binds the ENTERPRISE lane, and audits the provisioning', async () => {
    const email = 'ann.jose@example.test'
    stub.directoryHits = [dirUser(email, 'Ann Jose')]
    const res = await mapPost(evPost({
      session: admin(),
      body: { enterpriseId: patEntId, login: 'annstephyjose', directoryOid: OIDS[email]!, licenseOrg: 'acme-partner-demo' },
    })) as { provisioned: boolean; teammateId: string }

    expect(res.provisioned).toBe(true)
    expect(await countTeammates(email)).toBe(1)

    // The provisioned teammate must be a VALID attribution target — the money path filters on
    // NOT provisional AND is_active, and this row has to pass both.
    const tm = await t.client<{ provisional: boolean; is_active: boolean; entra_oid: string }[]>`
      SELECT provisional, is_active, entra_oid FROM teammate WHERE id = ${res.teammateId}::uuid`
    expect(tm[0]!.provisional).toBe(false)
    expect(tm[0]!.is_active).toBe(true)
    // Bound on the Entra OID, not a bill placeholder — this came from a directory pick.
    expect(tm[0]!.entra_oid).toBe(OIDS[email])

    const map = await t.client<{ teammate_id: string; enterprise_slug: string }[]>`
      SELECT teammate_id::text AS teammate_id, enterprise_slug FROM teammate_identity_map
      WHERE system = 'github' AND lower(identifier) = 'annstephyjose'`
    expect(map).toHaveLength(1)
    expect(map[0]!.teammate_id).toBe(res.teammateId)
    expect(map[0]!.enterprise_slug).toBe(PAT_SLUG)

    const audit = await t.client<{ payload: Record<string, unknown> }[]>`
      SELECT payload FROM audit_event
      WHERE subject_id = ${res.teammateId}::uuid AND event_type = 'copilot-login-mapped'
      ORDER BY ts_recorded DESC LIMIT 1`
    expect(audit).toHaveLength(1)
    expect(audit[0]!.payload).toMatchObject({ provisioned: true, adopted: false, directory_oid: OIDS[email], source: 'admin-manual' })

    // The PROVISIONING is separately audited against the acting admin. Asserting only the bind
    // row would leave the creation of the teammate itself untested, which is the write that
    // most needs an actor on it.
    const provAudit = await t.client<{ event_type: string; actor_teammate_id: string }[]>`
      SELECT event_type, actor_teammate_id::text AS actor_teammate_id FROM audit_event
      WHERE subject_id = ${res.teammateId}::uuid AND event_type = 'teammate-provisioned'`
    expect(provAudit).toHaveLength(1)
    expect(provAudit[0]!.actor_teammate_id).toBe(adminId)
  })

  it('a SECOND map for the same person reuses the teammate and creates no duplicate', async () => {
    // Self-contained: an earlier revision relied on the PRECEDING test's committed row, so it
    // passed in file order and failed when run alone. A test that only holds in sequence is
    // asserting the suite's history, not the behaviour.
    const email = 'reuse.probe@example.test'
    stub.directoryHits = [dirUser(email, 'Reuse Probe')]
    const first = await mapPost(evPost({
      session: admin(),
      body: { enterpriseId: patEntId, login: 'reuse-login-1', directoryOid: OIDS[email]! },
    })) as { provisioned: boolean; teammateId: string }
    expect(first.provisioned).toBe(true)

    const second = await mapPost(evPost({
      session: admin(),
      body: { enterpriseId: patEntId, login: 'reuse-login-2', directoryOid: OIDS[email]! },
    })) as { provisioned: boolean; adopted: boolean; teammateId: string }
    expect(second.provisioned).toBe(false)
    expect(second.adopted).toBe(false)
    expect(second.teammateId).toBe(first.teammateId)
    expect(await countTeammates(email)).toBe(1)
  })

  it('ADOPTS a `bill:` placeholder holding that email rather than minting a second teammate', async () => {
    // The bill-driven provisioner may already have created a placeholder for this person's
    // cost. The directory pick confirms the identity, so it must UPGRADE that row, and must
    // report `adopted` rather than `provisioned` — nothing was minted.
    const email = 'placeheld@example.test'
    await t.db.insert(schema.teammate).values({
      entraOid: `bill:${email}`, email, role: 'developer', regionId, orgUnitId: ouId,
    })
    stub.directoryHits = [dirUser(email, 'Place Held')]
    const res = await mapPost(evPost({
      session: admin(),
      body: { enterpriseId: patEntId, login: 'placeheld-login', directoryOid: OIDS[email]! },
    })) as { provisioned: boolean; adopted: boolean; teammateId: string }
    expect(res.provisioned).toBe(false)
    expect(res.adopted).toBe(true)
    expect(await countTeammates(email)).toBe(1)
    const tm = await t.client<{ entra_oid: string }[]>`SELECT entra_oid FROM teammate WHERE id = ${res.teammateId}::uuid`
    expect(tm[0]!.entra_oid).toBe(OIDS[email])
  })

  it('a REGION admin cannot force another region via licenseOrg, and provisions nothing', async () => {
    /*
     * licenseOrg is client-supplied, so it only PROPOSES a region. Two clamps enforce the
     * outcome (the candidate-region clamp before the write, the target clamp after it), so this
     * asserts the GUARANTEE, not one specific clamp: 403, and no row left behind either way.
     */
    const [otherRegion] = await t.db.insert(schema.region).values({ code: 'ur-r2', displayName: 'UR R2' }).returning()
    await t.client`
      INSERT INTO provider_org (provider, external_org_id, display_name, region_id)
      VALUES ('github', 'other-region-org', 'Other Region Org', ${otherRegion!.id}::uuid)`
    const email = 'cross.region@example.test'
    stub.directoryHits = [dirUser(email, 'Cross Region')]
    const regionAdmin: Session = { teammateId: adminId, email: 'a@x.test', displayName: 'A', role: 'admin', regionId, orgPath: 'd.svc' }
    await expect(mapPost(evPost({
      session: regionAdmin,
      body: { enterpriseId: patEntId, login: 'cross-login', directoryOid: OIDS[email]!, licenseOrg: 'other-region-org' },
    }))).rejects.toMatchObject({ statusCode: 403 })
    expect(await countTeammates(email)).toBe(0)
  })

  it('a bind refused AFTER provisioning rolls the provisioning back (the tx guarantee)', async () => {
    /*
     * The clamp on the CURRENTLY-bound teammate runs after the target is resolved, so it is the
     * one refusal that can fire with a freshly-provisioned row already written. Provisioning
     * used to run outside this transaction, which meant that row survived the 403 as an
     * unaudited orphan. It must not.
     */
    const [regionB] = await t.db.insert(schema.region).values({ code: 'ur-r3', displayName: 'UR R3' }).returning()
    const [ouB] = await t.db.insert(schema.orgUnit).values({ regionId: regionB!.id, path: 'b.svc', code: 'b-svc', displayName: 'B Svc', unitType: 'bu' }).returning()
    const [bTeam] = await t.db.insert(schema.teammate).values({ entraOid: 'oid-ur-b', email: 'b@x.test', role: 'developer', regionId: regionB!.id, orgUnitId: ouB!.id }).returning()
    await t.client`
      INSERT INTO teammate_identity_map (teammate_id, system, enterprise_slug, identifier, identifier_kind, github_login, source)
      VALUES (${bTeam!.id}::uuid, 'github', ${PAT_SLUG}, 'already-bound-login', 'login', 'already-bound-login', 'admin-manual')`

    const email = 'rollback.probe@example.test'
    stub.directoryHits = [dirUser(email, 'Rollback Probe')]
    const regionAdmin: Session = { teammateId: adminId, email: 'a@x.test', displayName: 'A', role: 'admin', regionId, orgPath: 'd.svc' }
    await expect(mapPost(evPost({
      session: regionAdmin,
      body: { enterpriseId: patEntId, login: 'already-bound-login', directoryOid: OIDS[email]! },
    }))).rejects.toMatchObject({ statusCode: 403 })

    expect(await countTeammates(email)).toBe(0)
    // And the existing binding is untouched.
    const still = await t.client<{ teammate_id: string }[]>`
      SELECT teammate_id::text AS teammate_id FROM teammate_identity_map
      WHERE system = 'github' AND lower(identifier) = 'already-bound-login'`
    expect(still[0]!.teammate_id).toBe(bTeam!.id)
  })

  it('refuses a DEACTIVATED teammate as a bind target', async () => {
    const [gone] = await t.db.insert(schema.teammate).values({
      entraOid: 'oid-ur-gone', email: 'gone@x.test', role: 'developer', regionId, orgUnitId: ouId, isActive: false,
    }).returning()
    await expect(mapPost(evPost({ session: admin(), body: { enterpriseId: patEntId, login: 'gone-login', teammateId: gone!.id } })))
      .rejects.toMatchObject({ statusCode: 400 })
  })
})

describe('GET unresolved — the self-asserted profile hint', () => {
  it('decorates each login with the github profile name + email', async () => {
    stub.seats = [{ assignee: { login: 'annstephyjose' }, organization: { login: 'acme-partner-demo' } }]
    stub.profiles = { annstephyjose: { name: 'Ann Jose', email: 'ann.jose@example.test' } }
    const res = await callGet(evGet({ session: admin(), enterpriseId: patEntId }))
    expect(res.logins).toHaveLength(1)
    expect(res.logins[0]).toMatchObject({ login: 'annstephyjose', profileName: 'Ann Jose', profileEmail: 'ann.jose@example.test' })
  })

  it('a profile FAILURE leaves the list intact with null hints (best-effort, never fatal)', async () => {
    // The hint is a convenience over the list; losing it must not lose the list.
    stub.seats = [{ assignee: { login: 'annstephyjose' }, organization: { login: 'acme-partner-demo' } }]
    stub.failProfile = new Error('403 from github')
    const res = await callGet(evGet({ session: admin(), enterpriseId: patEntId }))
    expect(res.logins).toHaveLength(1)
    expect(res.logins[0]!.profileName ?? null).toBeNull()
    expect(res.logins[0]!.profileEmail ?? null).toBeNull()
  })

  it('caps the profile fan-out so a large unresolved list cannot storm the provider', async () => {
    stub.seats = Array.from({ length: 40 }, (_, i) => ({ assignee: { login: `user${i}` }, organization: { login: 'org-a' } }))
    const res = await callGet(evGet({ session: admin(), enterpriseId: patEntId }))
    expect(res.logins.length).toBe(40)
    // EXACTLY the cap, not "at most": `toBeLessThanOrEqual` also passes when decoration is
    // deleted entirely, so it proved the cap without ever proving the feature.
    expect(stub.profileCalls.length).toBe(25)
    expect(new Set(stub.profileCalls).size).toBe(25) // no login fetched twice by the workers
  })

  it('returns the list without hints rather than waiting on a hung profile API', async () => {
    // The deadline is what makes "best-effort" true: a provider that HANGS (rather than fails)
    // would otherwise hold a list that is already complete and correct.
    // Slow, not frozen: a provider that never returns proves only that the race fires. A
    // provider that returns each call slowly is what exposes workers still dequeuing after
    // the deadline, which is the leak that costs the provider quota.
    stub.seats = Array.from({ length: 40 }, (_, i) => ({ assignee: { login: `slow${i}` }, organization: { login: 'org-a' } }))
    stub.profileDelayMs = 1_500
    const started = Date.now()
    const res = await callGet(evGet({ session: admin(), enterpriseId: patEntId }))
    expect(res.logins).toHaveLength(40)
    // Bounded NEAR the 4s deadline, not merely under some generous ceiling: 25 calls at 1.5s
    // with concurrency 5 is ~7.5s unbounded, so a 30s threshold passed with no deadline at all.
    expect(Date.now() - started).toBeLessThan(6_000)
    // And the abandoned workers must STOP. Racing the deadline bounds the response only; if the
    // pool keeps dequeuing, a 40-login list quietly issues 40 provider calls after the admin
    // already has their answer.
    const afterReturn = stub.profileCalls.length
    await new Promise((r) => setTimeout(r, 3_000))
    expect(stub.profileCalls.length).toBe(afterReturn)
  }, 45_000)
})
