// @vitest-environment node
/*
 * resilientFetch — the shared outbound-HTTP chokepoint (ING-7 / SYS-4,
 * robustness review 2026-06-09). Real local HTTP server, no fetch mocking.
 */
import { createServer, type Server } from 'node:http'
import { describe, it, expect, afterEach } from 'vitest'
import { resilientFetch, parseRetryAfterMs } from '../../../server/utils/resilient-fetch'

let server: Server | null = null

async function serve(handler: Parameters<typeof createServer>[1]): Promise<string> {
  server = createServer(handler)
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', () => r()))
  const addr = server!.address()
  return `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`
}

afterEach(async () => {
  if (server) {
    await new Promise<void>((r) => server!.close(() => r()))
    server = null
  }
})

describe('resilientFetch', () => {
  it('returns the first response when it is not retryable', async () => {
    let hits = 0
    const url = await serve((_req, res) => {
      hits += 1
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{"ok":true}')
    })
    const res = await resilientFetch(url)
    expect(res.status).toBe(200)
    expect(hits).toBe(1)
  })

  it('retries a 429 honouring retry-after and succeeds', async () => {
    let hits = 0
    const url = await serve((_req, res) => {
      hits += 1
      if (hits === 1) {
        res.writeHead(429, { 'retry-after': '0' })
        res.end()
        return
      }
      res.writeHead(200)
      res.end('ok')
    })
    const res = await resilientFetch(url, {}, { backoffMs: 5 })
    expect(res.status).toBe(200)
    expect(hits).toBe(2)
  })

  it('retries 5xx with bounded attempts and returns the final response', async () => {
    let hits = 0
    const url = await serve((_req, res) => {
      hits += 1
      res.writeHead(503)
      res.end()
    })
    const res = await resilientFetch(url, {}, { retries: 2, backoffMs: 1 })
    expect(res.status).toBe(503)
    expect(hits).toBe(3) // 1 + 2 retries, then the caller owns the !ok path
  })

  it('does NOT retry a non-429 4xx (the request itself is wrong)', async () => {
    let hits = 0
    const url = await serve((_req, res) => {
      hits += 1
      res.writeHead(404)
      res.end()
    })
    const res = await resilientFetch(url, {}, { retries: 3, backoffMs: 1 })
    expect(res.status).toBe(404)
    expect(hits).toBe(1)
  })

  it('times out a hung response and throws after exhausting retries', async () => {
    const url = await serve((_req, _res) => {
      // Never respond — black-holed endpoint.
    })
    await expect(
      resilientFetch(url, {}, { timeoutMs: 100, retries: 1, backoffMs: 1 }),
    ).rejects.toThrow()
  }, 15_000)
})

describe('resilientFetch deadline', () => {
  it('sends nothing when the deadline has already passed', async () => {
    let hits = 0
    const url = await serve((_req, res) => {
      hits += 1
      res.writeHead(200)
      res.end()
    })
    await expect(resilientFetch(url, {}, { deadline: Date.now() - 1 })).rejects.toThrow(/deadline/)
    expect(hits).toBe(0)
  })

  it('does not start a retry-after wait that would end past the deadline: returns the 429 at once', async () => {
    let hits = 0
    const url = await serve((_req, res) => {
      hits += 1
      res.writeHead(429, { 'retry-after': '5' })
      res.end()
    })
    const started = Date.now()
    const res = await resilientFetch(url, {}, { retries: 2, deadline: Date.now() + 1_000 })
    expect(res.status).toBe(429)
    expect(hits).toBe(1)
    expect(Date.now() - started).toBeLessThan(1_000)
  })

  it('still retries when the wait and the next attempt fit before the deadline', async () => {
    let hits = 0
    const url = await serve((_req, res) => {
      hits += 1
      if (hits === 1) {
        res.writeHead(503, { 'retry-after': '0' })
        res.end()
        return
      }
      res.writeHead(200)
      res.end('ok')
    })
    const res = await resilientFetch(url, {}, { retries: 2, deadline: Date.now() + 5_000 })
    expect(res.status).toBe(200)
    expect(hits).toBe(2)
  })

  it('clips the per-attempt timeout to the time left, and starts no retry after it', async () => {
    let hits = 0
    const url = await serve((_req, _res) => {
      hits += 1 // never respond
    })
    const started = Date.now()
    await expect(
      resilientFetch(url, {}, { timeoutMs: 10_000, retries: 2, backoffMs: 1, deadline: Date.now() + 300 }),
    ).rejects.toThrow()
    expect(Date.now() - started).toBeLessThan(2_000)
    expect(hits).toBe(1)
  }, 15_000)
})

describe('resilientFetch caller signal', () => {
  it('aborting during a backoff wait rejects at once and sends no retry', async () => {
    let hits = 0
    const url = await serve((_req, res) => {
      hits += 1
      res.writeHead(503)
      res.end()
    })
    const c = new AbortController()
    const started = Date.now()
    const call = resilientFetch(url, {}, { retries: 3, backoffMs: 5_000, signal: c.signal })
    setTimeout(() => c.abort(new DOMException('budget', 'TimeoutError')), 100)
    await expect(call).rejects.toMatchObject({ name: 'TimeoutError' })
    expect(Date.now() - started).toBeLessThan(2_000)
    expect(hits).toBe(1)
  })

  it('aborting cancels the request in flight', async () => {
    const url = await serve(() => undefined) // never answers
    const c = new AbortController()
    const call = resilientFetch(url, {}, { retries: 2, timeoutMs: 30_000, signal: c.signal })
    setTimeout(() => c.abort(new DOMException('budget', 'TimeoutError')), 100)
    await expect(call).rejects.toMatchObject({ name: 'TimeoutError' })
    server!.closeAllConnections()
  })
})

describe('parseRetryAfterMs', () => {
  it('parses delta-seconds', () => {
    expect(parseRetryAfterMs('2')).toBe(2000)
  })
  it('parses an HTTP-date relative to now', () => {
    const now = Date.now()
    const ms = parseRetryAfterMs(new Date(now + 5000).toUTCString(), now)
    expect(ms).toBeGreaterThan(3000)
    expect(ms).toBeLessThanOrEqual(5000)
  })
  it('returns null for absent/garbage headers', () => {
    expect(parseRetryAfterMs(null)).toBeNull()
    expect(parseRetryAfterMs('soon')).toBeNull()
    expect(parseRetryAfterMs('-5')).toBeNull()
  })
})
