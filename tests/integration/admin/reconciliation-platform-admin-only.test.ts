// @vitest-environment node
/*
 * Route matrix for the owner ruling of 2026-10-08: provider configuration is estate
 * config, so every route that reads, probes or recomputes REGIONLESS provider-enterprise
 * data is platform-admin only (docs/security-sprint/owner-decisions.md §1 / §11).
 *
 * For each route: a REGION admin gets 403 BEFORE anything happens — no provider client
 * is built, no Anthropic probe runs, no row is written, no audit row is recorded — and a
 * platform-admin is not 403 (the route's own behaviour is pinned in its own test file).
 *
 * enterprises.get is deliberately NOT in the 403 matrix: the org dialog's GitHub enterprise
 * picker reads it, and a region admin may onboard a GitHub org into their own region
 * (orgs.post). Ruled 2026-10-08: region admins get a names-only read (last block).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'
import { injectTestSession } from '../../helpers/auth'
import type { Session } from '../../../server/utils/auth'
import * as schema from '../../../drizzle/schema'
// vitest hoists the vi.mock calls below above ALL imports, so these handler imports bind
// to the stubbed provider modules (the github-coverage-routes.test.ts convention).
import enterprisesGet from '../../../server/api/v1/admin/reconciliation/enterprises.get'
import ratePlansGet from '../../../server/api/v1/admin/reconciliation/enterprises/[id]/copilot-rate-plans.get'
import githubHealthGet from '../../../server/api/v1/admin/reconciliation/github/health.get'
import coverageGet from '../../../server/api/v1/admin/reconciliation/github/coverage.get'
import coverageRecheckPost from '../../../server/api/v1/admin/reconciliation/github/coverage-recheck.post'
import unresolvedGet from '../../../server/api/v1/admin/reconciliation/github/unresolved.get'
import backfillGet from '../../../server/api/v1/admin/reconciliation/backfill.get'
import anthropicDiscoverPost from '../../../server/api/v1/admin/reconciliation/anthropic/discover.post'

// Every provider seam these routes can reach counts here; a region-admin call must leave it at 0.
const calls = vi.hoisted(() => ({ githubClient: 0, githubAppAuth: 0, anthropicDiscover: 0 }))

vi.mock('../../../server/reconciliation/adapters/github-client', () => {
  class GithubCopilotClient {
    constructor() { calls.githubClient += 1 }
    async listSamlIdentities() { return [] }
    async listOrgCopilotSeats() { return [] }
    async getUserDailyCredits() { return [] }
    async listSeats() { return [] }
    async getAiCreditUsage() { return { usageItems: [] } }
    async getUserProfile() { return null }
    async listInstallableOrganizations() { return { organizations: [], pagesCapped: false, shortPageBreak: true } }
    static withApp() { return new GithubCopilotClient() }
    static withPat() { return new GithubCopilotClient() }
  }
  return { GithubCopilotClient }
})
vi.mock('../../../server/reconciliation/adapters/github-app-auth', () => {
  class GithubAppAuth {
    constructor() { calls.githubAppAuth += 1 }
    async orgInstallationDetail() { return { status: 'not-found' } }
  }
  return { GithubAppAuth }
})
vi.mock('../../../server/anthropic/discover', () => ({
  discoverAnthropicOrg: async () => {
    calls.anthropicDiscover += 1
    return { ok: false, reason: 'no-key' }
  },
}))

process.env.NUXT_GITHUB_APP_KEY_PAO = 'stub-app-key-mocked-auth-never-parses-it'

let t: TestDb
let regionId = ''
let platformAdminId = ''
let regionAdminId = ''
let entId = ''

type Handler = (e: never) => Promise<unknown>

function ev(opts: {
  session: Session
  method: 'GET' | 'POST'
  query?: Record<string, string>
  params?: Record<string, string>
  body?: unknown
}) {
  const path = opts.query ? `/x?${new URLSearchParams(opts.query).toString()}` : '/x'
  const headers: Record<string, string> = {
    host: 'localhost:3450',
    origin: 'http://localhost:3450',
    'content-type': 'application/json',
  }
  const e = {
    method: opts.method,
    path,
    context: { params: opts.params ?? {} },
    node: {
      req: { method: opts.method, url: path, body: opts.body, socket: { remoteAddress: '127.0.0.1' }, get headers() { return headers } },
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
  injectTestSession(e as unknown as Parameters<typeof injectTestSession>[0], opts.session)
  return e as never
}

const platformAdmin = (): Session => ({
  teammateId: platformAdminId, email: 'pao-pa@x.test', displayName: 'PA', role: 'platform-admin', regionId, orgPath: 'pao.svc',
})
const regionAdmin = (): Session => ({
  teammateId: regionAdminId, email: 'pao-ra@x.test', displayName: 'RA', role: 'admin', regionId, orgPath: 'pao.svc',
})

interface RouteCase {
  name: string
  handler: Handler
  req: (session: Session) => never
}
const ROUTES: RouteCase[] = [
  {
    name: 'GET enterprises/{id}/copilot-rate-plans',
    handler: ratePlansGet as Handler,
    req: (s) => ev({ session: s, method: 'GET', params: { id: entId } }),
  },
  {
    name: 'GET github/health',
    handler: githubHealthGet as Handler,
    req: (s) => ev({ session: s, method: 'GET', query: { enterpriseId: entId } }),
  },
  {
    name: 'GET github/coverage',
    handler: coverageGet as Handler,
    req: (s) => ev({ session: s, method: 'GET' }),
  },
  {
    name: 'POST github/coverage-recheck',
    handler: coverageRecheckPost as Handler,
    req: (s) => ev({ session: s, method: 'POST', body: { enterpriseId: entId } }),
  },
  {
    name: 'GET github/unresolved',
    handler: unresolvedGet as Handler,
    req: (s) => ev({ session: s, method: 'GET', query: { enterpriseId: entId } }),
  },
  {
    name: 'GET backfill',
    handler: backfillGet as Handler,
    req: (s) => ev({ session: s, method: 'GET' }),
  },
  {
    name: 'POST anthropic/discover',
    handler: anthropicDiscoverPost as Handler,
    req: (s) => ev({ session: s, method: 'POST', body: { credentialSecretName: 'pao-anthropic-key' } }),
  },
]

/** Every table one of these routes can write, plus the audit trail. */
async function writeCounts(): Promise<Record<string, number>> {
  const [r] = await t.client<Record<string, string>[]>`
    SELECT (SELECT COUNT(*) FROM audit_event)::text                         AS audit_event,
           (SELECT COUNT(*) FROM provider_org_coverage)::text               AS provider_org_coverage,
           (SELECT COUNT(*) FROM provider_enterprise_coverage_census)::text AS provider_enterprise_coverage_census,
           (SELECT COUNT(*) FROM reconciliation_backfill_request)::text     AS reconciliation_backfill_request,
           (SELECT COUNT(*) FROM copilot_rate_plan)::text                   AS copilot_rate_plan
  `
  return Object.fromEntries(Object.entries(r!).map(([k, v]) => [k, Number(v)]))
}

async function statusOf(p: Promise<unknown>): Promise<number> {
  try {
    await p
    return 200
  } catch (err) {
    return (err as { statusCode?: number }).statusCode ?? 500
  }
}

beforeAll(async () => {
  t = await startTestDb()
  process.env.DATABASE_URL = t.url
  const [r] = await t.db.insert(schema.region).values({ code: 'pao-r', displayName: 'PAO R' }).returning()
  regionId = r!.id
  const [o] = await t.db.insert(schema.orgUnit).values({ regionId, path: 'pao.svc', code: 'pao-svc', displayName: 'Svc', unitType: 'bu' }).returning()
  const [pa] = await t.db.insert(schema.teammate).values({ entraOid: 'oid-pao-pa', email: 'pao-pa@x.test', role: 'platform-admin', regionId, orgUnitId: o!.id }).returning()
  platformAdminId = pa!.id
  const [ra] = await t.db.insert(schema.teammate).values({ entraOid: 'oid-pao-ra', email: 'pao-ra@x.test', role: 'admin', regionId, orgUnitId: o!.id }).returning()
  regionAdminId = ra!.id
  const [e] = await t.db.insert(schema.providerEnterprise).values({
    provider: 'github', externalId: 'pao-ent', displayName: 'PAO Ent', reconciliationMode: 'reconciled', credentialSecretName: 'pao', githubAppId: '424242',
  }).returning()
  entId = e!.id
}, 180_000)

afterAll(async () => {
  await stopTestDb(t)
}, 30_000)

beforeEach(() => {
  calls.githubClient = 0
  calls.githubAppAuth = 0
  calls.anthropicDiscover = 0
})

describe('regionless provider-enterprise routes are platform-admin only (ruling 2026-10-08)', () => {
  describe.each(ROUTES)('$name', ({ handler, req }) => {
    it('a region admin → 403, with no provider call, no write and no audit row', async () => {
      const before = await writeCounts()
      await expect(handler(req(regionAdmin()))).rejects.toMatchObject({ statusCode: 403 })
      expect(calls).toEqual({ githubClient: 0, githubAppAuth: 0, anthropicDiscover: 0 })
      expect(await writeCounts()).toEqual(before)
    })

    it('a platform-admin is not refused', async () => {
      expect(await statusOf(handler(req(platformAdmin())))).not.toBe(403)
    })
  })

  it('the matrix really reaches a provider for a platform-admin (the 0-call assertion is not vacuous)', async () => {
    await statusOf((coverageRecheckPost as Handler)(ev({ session: platformAdmin(), method: 'POST', body: { enterpriseId: entId } })))
    await statusOf((anthropicDiscoverPost as Handler)(ev({ session: platformAdmin(), method: 'POST', body: { credentialSecretName: 'pao-anthropic-key' } })))
    expect(calls.githubClient + calls.githubAppAuth).toBeGreaterThan(0)
    expect(calls.anthropicDiscover).toBe(1)
  })
})

describe('enterprises.get: a names-only read for region admins (the org dialog picker)', () => {
  type Res = { enterprises: Record<string, unknown>[]; scope: string }
  it('a region admin gets exactly the four picker fields, nothing estate-config', async () => {
    const res = (await (enterprisesGet as Handler)(ev({ session: regionAdmin(), method: 'GET' }))) as Res
    expect(res.scope).toBe('picker')
    const row = res.enterprises.find((e) => e.id === entId)!
    expect(Object.keys(row).sort()).toEqual(['displayName', 'externalId', 'id', 'provider'])
  })

  it('a platform admin gets the full record', async () => {
    const res = (await (enterprisesGet as Handler)(ev({ session: platformAdmin(), method: 'GET' }))) as Res
    expect(res.scope).toBe('full')
    const row = res.enterprises.find((e) => e.id === entId)!
    for (const k of ['credentialSecretName', 'keyPresent', 'billing', 'orgCount', 'notes']) expect(row).toHaveProperty(k)
  })
})
