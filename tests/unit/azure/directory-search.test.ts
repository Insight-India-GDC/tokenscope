// @vitest-environment node
/*
 * searchDirectory builds a Graph `$search` of quoted phrases. Backslash is
 * Graph's escape character inside a phrase, so a term ending in `\` would
 * escape the closing quote and reshape the expression: the outbound `$search`
 * must carry neither `"` nor `\` from the caller.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { searchDirectory, _resetGraphTokenCache, _resetOrgDataLatch } from '../../../server/azure/directory'

const TOKEN_URL = 'https://login.example.test/token'
const GRAPH = 'https://graph.example.test/v1.0'

let searches: string[] = []

beforeEach(() => {
  process.env.NUXT_GRAPH_DIRECTORY_MODE = 'graph'
  process.env.NUXT_GRAPH_BASE_URL = GRAPH
  process.env.NUXT_OIDC_PROVIDERS_ENTRA_CLIENT_ID = 'cid'
  process.env.NUXT_OIDC_PROVIDERS_ENTRA_CLIENT_SECRET = 'secret'
  process.env.NUXT_OIDC_PROVIDERS_ENTRA_TOKEN_URL = TOKEN_URL
  _resetGraphTokenCache()
  _resetOrgDataLatch()
  searches = []
  vi.stubGlobal('fetch', async (input: string) => {
    const url = String(input)
    if (url === TOKEN_URL) {
      return new Response(JSON.stringify({ access_token: 'tok', expires_in: 3600 }), { status: 200 })
    }
    searches.push(new URL(url).searchParams.get('$search') ?? '')
    return new Response(JSON.stringify({ value: [] }), { status: 200 })
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

describe('searchDirectory — $search escaping', () => {
  it('strips a trailing backslash and embedded quotes from the term', async () => {
    await searchDirectory('ab"c\\')
    expect(searches.length).toBeGreaterThan(0)
    for (const s of searches) {
      expect(s).toBe('"displayName:abc" OR "mail:abc"')
    }
  })
})
