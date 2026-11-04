// @vitest-environment node
/*
 * The shared token mint honours each caller's signal: a caller that gives up
 * stops waiting at once, and the mint request is cancelled only when no caller
 * is still waiting on it.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { getUserManager, _resetGraphTokenCache } from '../../../server/azure/directory'

const TOKEN_URL = 'https://login.example.test/token'
const GRAPH = 'https://graph.example.test/v1.0'

let tokenSignals: AbortSignal[] = []
let releaseToken: (() => void) | null = null

beforeEach(() => {
  process.env.NUXT_GRAPH_DIRECTORY_MODE = 'graph'
  process.env.NUXT_GRAPH_BASE_URL = GRAPH
  process.env.NUXT_OIDC_PROVIDERS_ENTRA_CLIENT_ID = 'cid'
  process.env.NUXT_OIDC_PROVIDERS_ENTRA_CLIENT_SECRET = 'secret'
  process.env.NUXT_OIDC_PROVIDERS_ENTRA_TOKEN_URL = TOKEN_URL
  _resetGraphTokenCache()
  tokenSignals = []
  vi.stubGlobal('fetch', (input: string, init: RequestInit) => {
    if (String(input) === TOKEN_URL) {
      tokenSignals.push(init.signal!)
      return new Promise((resolve, reject) => {
        init.signal!.addEventListener('abort', () => reject(init.signal!.reason))
        releaseToken = () => resolve(new Response(JSON.stringify({ access_token: 'tok', expires_in: 3600 })))
      })
    }
    return Promise.resolve(new Response(JSON.stringify({ id: 'mgr', mail: 'm@x.test' })))
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
  _resetGraphTokenCache()
  delete process.env.NUXT_GRAPH_DIRECTORY_MODE
  delete process.env.NUXT_GRAPH_BASE_URL
  delete process.env.NUXT_OIDC_PROVIDERS_ENTRA_CLIENT_ID
  delete process.env.NUXT_OIDC_PROVIDERS_ENTRA_CLIENT_SECRET
  delete process.env.NUXT_OIDC_PROVIDERS_ENTRA_TOKEN_URL
})

const tick = () => new Promise((r) => setTimeout(r, 0))

describe('token mint cancellation', () => {
  it('the only waiter giving up cancels the mint request', async () => {
    const c = new AbortController()
    const call = getUserManager('u1', { signal: c.signal })
    await tick()
    c.abort(new DOMException('budget', 'TimeoutError'))
    await expect(call).rejects.toMatchObject({ name: 'TimeoutError' })
    expect(tokenSignals).toHaveLength(1)
    expect(tokenSignals[0]!.aborted).toBe(true)
  })

  it('a waiter giving up leaves the mint running for a caller still waiting', async () => {
    const c = new AbortController()
    const leaving = getUserManager('u1', { signal: c.signal })
    const staying = getUserManager('u2')
    await tick()
    c.abort(new DOMException('budget', 'TimeoutError'))
    await expect(leaving).rejects.toMatchObject({ name: 'TimeoutError' })
    expect(tokenSignals).toHaveLength(1)
    expect(tokenSignals[0]!.aborted).toBe(false)
    releaseToken!()
    expect(await staying).toMatchObject({ oid: 'mgr' })
  })

  it('an already-aborted signal sends nothing', async () => {
    const c = new AbortController()
    c.abort(new DOMException('budget', 'TimeoutError'))
    await expect(getUserManager('u1', { signal: c.signal })).rejects.toMatchObject({ name: 'TimeoutError' })
    expect(tokenSignals).toHaveLength(0)
  })
})
