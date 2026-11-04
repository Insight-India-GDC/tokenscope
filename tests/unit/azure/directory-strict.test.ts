// @vitest-environment node
/*
 * Strict vs lenient directory lookups (scaling plan Phase 1 item 3).
 *
 * The strict variants are what the workers use: null ONLY for a real absence
 * (404, or a 200 with zero / ambiguous / guest-only matches) and a THROW for any
 * other HTTP status or a network failure / timeout — so a throttled Graph can
 * never read as "not in the directory". The lenient functions are wrappers over
 * the same decision and keep returning null on every failure (request handlers,
 * sign-in). Real-mode Graph with a stubbed fetch.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { DeadlinePassedError } from '../../../server/utils/resilient-fetch'
import {
  getDirectoryUserByMailOrUpn,
  getDirectoryUserByMailOrUpnStrict,
  getDirectoryUserByOid,
  getDirectoryUserByOidStrict,
  getUserManager,
  isTransientGraphFailure,
  GraphHttpError,
  WORKER_GRAPH_RETRIES,
  GRAPH_TIMEOUT_MS,
  _resetGraphTokenCache,
  _resetOrgDataLatch,
} from '../../../server/azure/directory'

const TOKEN_URL = 'https://login.example.test/token'
const GRAPH = 'https://graph.example.test/v1.0'

type Answer = { status: number; body?: unknown; headers?: Record<string, string> } | 'network-error' | 'timeout'

let graphAnswers: Answer[] = []
let graphCalls: { url: string; signal: AbortSignal | undefined }[] = []

const user = (id: string, upn: string) => ({
  id,
  displayName: id,
  mail: upn.includes('#EXT#') ? null : upn,
  userPrincipalName: upn,
  department: null,
  jobTitle: null,
  companyName: null,
  country: null,
  officeLocation: null,
  state: null,
})

beforeEach(() => {
  process.env.NUXT_GRAPH_DIRECTORY_MODE = 'graph'
  process.env.NUXT_GRAPH_BASE_URL = GRAPH
  process.env.NUXT_OIDC_PROVIDERS_ENTRA_CLIENT_ID = 'cid'
  process.env.NUXT_OIDC_PROVIDERS_ENTRA_CLIENT_SECRET = 'secret'
  process.env.NUXT_OIDC_PROVIDERS_ENTRA_TOKEN_URL = TOKEN_URL
  _resetGraphTokenCache()
  _resetOrgDataLatch()
  graphAnswers = []
  graphCalls = []
  tokenStatus = 200
  vi.stubGlobal('fetch', async (input: string, init?: RequestInit) => {
    const url = String(input)
    if (url === TOKEN_URL) {
      if (tokenStatus !== 200) return new Response(null, { status: tokenStatus })
      return new Response(JSON.stringify({ access_token: 'tok', expires_in: 3600 }), { status: 200 })
    }
    graphCalls.push({ url, signal: init?.signal ?? undefined })
    const a = graphAnswers.shift() ?? { status: 500 }
    if (a === 'network-error') throw new TypeError('fetch failed')
    if (a === 'timeout') throw new DOMException('The operation was aborted due to timeout', 'TimeoutError')
    return new Response(a.body === undefined ? null : JSON.stringify(a.body), {
      status: a.status,
      headers: a.headers,
    })
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
  delete process.env.NUXT_GRAPH_DIRECTORY_MODE
  delete process.env.NUXT_GRAPH_BASE_URL
  delete process.env.NUXT_OIDC_PROVIDERS_ENTRA_CLIENT_ID
  delete process.env.NUXT_OIDC_PROVIDERS_ENTRA_CLIENT_SECRET
  delete process.env.NUXT_OIDC_PROVIDERS_ENTRA_TOKEN_URL
})

let tokenStatus = 200

const EMAIL = 'ana.ruiz@example.com'
const OID = '9a1e0000-0000-4000-8000-000000000001'

describe('getDirectoryUserByMailOrUpn — strict vs lenient', () => {
  const absent: [string, Answer][] = [
    ['404', { status: 404 }],
    ['200 with zero matches', { status: 200, body: { value: [] } }],
    ['200 with an ambiguous match', { status: 200, body: { value: [user('a', EMAIL), user('b', EMAIL)] } }],
    ['200 with only a guest', { status: 200, body: { value: [user('g', 'ana_vendor.test#EXT#@x.onmicrosoft.com')] } }],
  ]
  for (const [name, answer] of absent) {
    it(`${name} is a real absence: null from both`, async () => {
      graphAnswers = [answer]
      expect(await getDirectoryUserByMailOrUpnStrict(EMAIL)).toBeNull()
      graphAnswers = [answer]
      expect(await getDirectoryUserByMailOrUpn(EMAIL)).toBeNull()
    })
  }

  it('a single non-guest match resolves in both', async () => {
    graphAnswers = [{ status: 200, body: { value: [user(OID, EMAIL)] } }]
    expect((await getDirectoryUserByMailOrUpnStrict(EMAIL))?.oid).toBe(OID)
    graphAnswers = [{ status: 200, body: { value: [user(OID, EMAIL)] } }]
    expect((await getDirectoryUserByMailOrUpn(EMAIL))?.oid).toBe(OID)
  })

  const failures: [string, Answer][] = [
    ['429', { status: 429, headers: { 'retry-after': '0' } }],
    ['500', { status: 500 }],
    ['a network error', 'network-error'],
    ['a timeout', 'timeout'],
  ]
  for (const [name, answer] of failures) {
    it(`${name}: strict THROWS, lenient reads it as null`, async () => {
      graphAnswers = [answer]
      await expect(getDirectoryUserByMailOrUpnStrict(EMAIL)).rejects.toThrow()
      graphAnswers = [answer]
      expect(await getDirectoryUserByMailOrUpn(EMAIL)).toBeNull()
    })
  }

  it('a 404 from the TOKEN endpoint is a broken mint, never "not in the directory": strict throws', async () => {
    tokenStatus = 404
    await expect(getDirectoryUserByMailOrUpnStrict(EMAIL)).rejects.toThrow()
    _resetGraphTokenCache()
    await expect(getDirectoryUserByOidStrict(OID)).rejects.toThrow()
  })

  it('a 400 rejecting employeeOrgData degrades to the base select once, for the strict lookups too', async () => {
    graphAnswers = [{ status: 400 }, { status: 200, body: { value: [user(OID, EMAIL)] } }]
    expect((await getDirectoryUserByMailOrUpnStrict(EMAIL))?.oid).toBe(OID)
    expect(graphCalls).toHaveLength(2)
    expect(graphCalls[0]!.url).toContain('employeeOrgData')
    expect(graphCalls[1]!.url).not.toContain('employeeOrgData')
    // Latched: the oid lookup starts on the base select and a 400 now throws.
    graphAnswers = [{ status: 400 }]
    await expect(getDirectoryUserByOidStrict(OID)).rejects.toThrow()
    expect(graphCalls[2]!.url).not.toContain('employeeOrgData')
  })

  it('a 400 the base select ALSO gets is rethrown and does NOT latch the degradation', async () => {
    graphAnswers = [{ status: 400 }, { status: 400 }]
    await expect(getDirectoryUserByMailOrUpnStrict(EMAIL)).rejects.toThrow('(400)')
    expect(graphCalls).toHaveLength(2)
    // Not latched: the next lookup still asks for employeeOrgData first.
    graphAnswers = [{ status: 200, body: { value: [user(OID, EMAIL)] } }]
    expect((await getDirectoryUserByMailOrUpnStrict(EMAIL))?.oid).toBe(OID)
    expect(graphCalls[2]!.url).toContain('employeeOrgData')
  })

  it('request-handler transport is ONE attempt; worker transport retries a 429 and succeeds', async () => {
    graphAnswers = [{ status: 429, headers: { 'retry-after': '0' } }, { status: 200, body: { value: [user(OID, EMAIL)] } }]
    expect(await getDirectoryUserByMailOrUpn(EMAIL)).toBeNull()
    expect(graphCalls).toHaveLength(1)

    graphCalls = []
    graphAnswers = [{ status: 429, headers: { 'retry-after': '0' } }, { status: 200, body: { value: [user(OID, EMAIL)] } }]
    const u = await getDirectoryUserByMailOrUpnStrict(EMAIL, { retries: WORKER_GRAPH_RETRIES })
    expect(u?.oid).toBe(OID)
    expect(graphCalls).toHaveLength(2)
  })

  it('every Graph call carries an abort signal (bounded, never an unbounded fetch)', async () => {
    graphAnswers = [{ status: 200, body: { value: [] } }]
    await getDirectoryUserByMailOrUpn(EMAIL)
    expect(graphCalls[0]!.signal).toBeInstanceOf(AbortSignal)
    expect(GRAPH_TIMEOUT_MS).toBe(10_000)
  })

  it('a passed deadline stops the call before it is sent, and strict throws', async () => {
    graphAnswers = [{ status: 200, body: { value: [user(OID, EMAIL)] } }]
    await expect(
      getDirectoryUserByMailOrUpnStrict(EMAIL, { retries: WORKER_GRAPH_RETRIES, deadline: Date.now() - 1 }),
    ).rejects.toThrow()
    expect(graphCalls).toHaveLength(0)
  })
})

describe('the shared token mint is request-independent', () => {
  it("a worker call whose deadline has passed does not fail a concurrent lenient caller's mint", async () => {
    graphAnswers = [{ status: 200, body: { value: [user(OID, EMAIL)] } }]
    const [worker, lenient] = await Promise.allSettled([
      getDirectoryUserByMailOrUpnStrict(EMAIL, { retries: WORKER_GRAPH_RETRIES, deadline: Date.now() - 1 }),
      getDirectoryUserByMailOrUpn(EMAIL),
    ])
    expect(worker.status).toBe('rejected')
    expect(lenient).toEqual({ status: 'fulfilled', value: expect.objectContaining({ oid: OID }) })
  })
})

describe('isTransientGraphFailure', () => {
  it('429 / 5xx / network / timeout / abort / passed deadline are transient; everything else is not', () => {
    expect(isTransientGraphFailure(new GraphHttpError(429, '/users'))).toBe(true)
    expect(isTransientGraphFailure(new GraphHttpError(503, '/users'))).toBe(true)
    expect(isTransientGraphFailure(new TypeError('fetch failed'))).toBe(true)
    expect(isTransientGraphFailure(new DOMException('timed out', 'TimeoutError'))).toBe(true)
    expect(isTransientGraphFailure(new DOMException('aborted', 'AbortError'))).toBe(true)
    expect(isTransientGraphFailure(new DeadlinePassedError('graph.example.test'))).toBe(true)

    expect(isTransientGraphFailure(new GraphHttpError(400, '/users'))).toBe(false)
    expect(isTransientGraphFailure(new GraphHttpError(403, '/users'))).toBe(false)
    expect(isTransientGraphFailure(new TypeError("Cannot read properties of undefined (reading 'id')"))).toBe(false)
    expect(isTransientGraphFailure(new Error('relation "org_unit" does not exist'))).toBe(false)
  })
})

describe('getDirectoryUserByOid — strict vs lenient', () => {
  it('404 is a real absence: null from both', async () => {
    graphAnswers = [{ status: 404 }]
    expect(await getDirectoryUserByOidStrict(OID)).toBeNull()
    graphAnswers = [{ status: 404 }]
    expect(await getDirectoryUserByOid(OID)).toBeNull()
  })

  it('a guest is a real absence: null from both', async () => {
    const guest = user(OID, 'ana_vendor.test#EXT#@x.onmicrosoft.com')
    graphAnswers = [{ status: 200, body: guest }]
    expect(await getDirectoryUserByOidStrict(OID)).toBeNull()
    graphAnswers = [{ status: 200, body: guest }]
    expect(await getDirectoryUserByOid(OID)).toBeNull()
  })

  for (const [name, answer] of [
    ['429', { status: 429, headers: { 'retry-after': '0' } }],
    ['500', { status: 500 }],
    ['a timeout', 'timeout'],
  ] as [string, Answer][]) {
    it(`${name}: strict THROWS, lenient reads it as null`, async () => {
      graphAnswers = [answer]
      await expect(getDirectoryUserByOidStrict(OID)).rejects.toThrow()
      graphAnswers = [answer]
      expect(await getDirectoryUserByOid(OID)).toBeNull()
    })
  }
})

describe('getUserManager — already strict, now on the bounded transport', () => {
  it('404 → null (top of chart); 429 → throws; the worker transport retries', async () => {
    graphAnswers = [{ status: 404 }]
    expect(await getUserManager(OID)).toBeNull()

    graphAnswers = [{ status: 429, headers: { 'retry-after': '0' } }]
    await expect(getUserManager(OID)).rejects.toThrow()

    graphCalls = []
    graphAnswers = [
      { status: 503, headers: { 'retry-after': '0' } },
      { status: 200, body: { id: 'mgr', mail: 'Boss@example.com', userPrincipalName: null, displayName: 'Boss' } },
    ]
    expect(await getUserManager(OID, { retries: WORKER_GRAPH_RETRIES })).toEqual({ oid: 'mgr', email: 'boss@example.com', name: 'Boss' })
    expect(graphCalls).toHaveLength(2)
  })
})
