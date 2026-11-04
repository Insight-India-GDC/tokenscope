// @vitest-environment node
/*
 * Every /api response defaults to `Cache-Control: no-store`, from a route rule
 * in nuxt.config.ts. Nitro matches route rules with radix3 + defu and applies
 * their headers in a handler registered BEFORE the router, so a handler that
 * sets its own policy (report-cache's `private, max-age`, the plugin files'
 * `immutable`) overrides the default. The app below reproduces that order with
 * the real config.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import { createApp, createRouter, eventHandler, setHeader, setHeaders, toNodeListener } from 'h3'
import { createRouter as createRadixRouter, toRouteMatcher } from 'radix3'
import defu from 'defu'
import { createServer, request, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

vi.stubGlobal('defineNuxtConfig', (c: unknown) => c)
const { default: config } = (await import('../../../nuxt.config')) as unknown as {
  default: { routeRules: Record<string, Record<string, unknown>> }
}

const matcher = toRouteMatcher(createRadixRouter({ routes: config.routeRules }))
const rulesFor = (path: string) =>
  defu({}, ...matcher.matchAll(path).reverse()) as { headers?: Record<string, string>; security?: unknown }

let server: Server
let port: number

beforeAll(async () => {
  const app = createApp()
  app.use(
    eventHandler((event) => {
      const rules = rulesFor(event.path.split('?')[0]!)
      if (rules.headers) setHeaders(event, rules.headers)
    }),
  )
  app.use(
    createRouter()
      .get('/api/v1/instances/x/bearer', eventHandler(() => ({ ok: true })))
      .get(
        '/api/v1/reports/x',
        eventHandler((event) => {
          setHeader(event, 'cache-control', 'private, max-age=60')
          return { ok: true }
        }),
      ),
  )
  server = createServer(toNodeListener(app))
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  port = (server.address() as AddressInfo).port
})

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()))
})

function cacheControlOf(path: string): Promise<string | undefined> {
  return new Promise((resolvePromise, reject) => {
    const req = request({ host: '127.0.0.1', port, method: 'GET', path }, (res) => {
      res.resume()
      res.on('end', () => resolvePromise(res.headers['cache-control']))
    })
    req.on('error', reject)
    req.end()
  })
}

describe('/api/** Cache-Control route rule', () => {
  it('defaults an API response with no policy of its own to no-store', async () => {
    expect(await cacheControlOf('/api/v1/instances/x/bearer')).toBe('no-store')
  })

  it('leaves a handler-set policy in place', async () => {
    expect(await cacheControlOf('/api/v1/reports/x')).toBe('private, max-age=60')
  })

  it('keeps the /api/health rate-limiter exemption alongside the header', () => {
    const rules = rulesFor('/api/health')
    expect(rules.headers?.['cache-control']).toBe('no-store')
    expect(rules.security).toEqual({ rateLimiter: false })
  })
})
