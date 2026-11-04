// @vitest-environment node
/*
 * Boot pre-flight probe logic (scripts/preflight.ts). The TCP probe is
 * exercised against a real local listener; the env-resolution + formatting is
 * pure. No Azure / no network beyond loopback.
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import net from 'node:net'
import { consola } from 'consola'
import {
  probeTcp,
  parseHostPort,
  resolveServices,
  probeServices,
  formatLine,
  criticalFailure,
  runPreflight,
  type ServiceProbe,
} from '../../../scripts/preflight'

function listenEphemeral(): Promise<{ port: number; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = net.createServer()
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as net.AddressInfo).port
      resolve({
        port,
        close: () => new Promise<void>((res) => server.close(() => res())),
      })
    })
  })
}

describe('probeTcp', () => {
  it('connects to a live local listener → ok with a latency', async () => {
    const srv = await listenEphemeral()
    try {
      const r = await probeTcp('127.0.0.1', srv.port, 2000)
      expect(r.ok).toBe(true)
      expect(r.latencyMs).toBeGreaterThanOrEqual(0)
      expect(r.errorClass).toBeUndefined()
    } finally {
      await srv.close()
    }
  })

  it('a closed port → unreachable, classed refused', async () => {
    const srv = await listenEphemeral()
    const port = srv.port
    await srv.close() // free the port so the connect is refused
    const r = await probeTcp('127.0.0.1', port, 2000)
    expect(r.ok).toBe(false)
    expect(r.errorClass).toBe('refused')
  })

  it('an unroutable address → unreachable (timeout or network error), bounded by the timeout', async () => {
    // 192.0.2.0/24 is RFC-5737 TEST-NET-1 (non-routable). Short timeout keeps it fast.
    const r = await probeTcp('192.0.2.1', 9, 300)
    expect(r.ok).toBe(false)
    expect(['timeout', 'other', 'dns']).toContain(r.errorClass)
  })
})

describe('parseHostPort', () => {
  it('extracts host + explicit port from a postgres URL (never the credentials)', () => {
    expect(parseHostPort('postgres://user:secret@pg.example:5433/db', 5432)).toEqual({
      host: 'pg.example',
      port: 5433,
    })
  })
  it('falls back to the default port when none in the URL (rediss)', () => {
    expect(parseHostPort('rediss://:secret@redis.example', 6380)).toEqual({
      host: 'redis.example',
      port: 6380,
    })
  })
  it('returns null for undefined / unparseable input', () => {
    expect(parseHostPort(undefined, 5432)).toBeNull()
    expect(parseHostPort('not a url', 5432)).toBeNull()
  })
})

describe('resolveServices', () => {
  it('postgres is critical; redis + keyVault are not', () => {
    const svc = resolveServices({
      DATABASE_URL: 'postgres://u:p@pg:5432/db',
      REDIS_URL: 'rediss://:p@redis:6380',
      AZURE_KEYVAULT_URL: 'https://kv.vault.azure.net/',
    } as NodeJS.ProcessEnv)
    const byName = Object.fromEntries(svc.map((s) => [s.name, s]))
    expect(byName.postgres.critical).toBe(true)
    expect(byName.redis.critical).toBe(false)
    expect(byName.keyVault.critical).toBe(false)
    expect(byName.keyVault.endpoint).toEqual({ host: 'kv.vault.azure.net', port: 443 })
  })
  it('postgres resolves from the app-role URL once the owner DATABASE_URL is unset', () => {
    const svc = resolveServices({ TOKENSCOPE_APP_DATABASE_URL: 'postgres://app:p@pg-app:5432/db' } as NodeJS.ProcessEnv)
    expect(svc.find((s) => s.name === 'postgres')!.endpoint).toEqual({ host: 'pg-app', port: 5432 })
  })
  it('an unset env yields no endpoint (→ skipped at probe time)', () => {
    const svc = resolveServices({ DATABASE_URL: 'postgres://u:p@pg:5432/db' } as NodeJS.ProcessEnv)
    const redis = svc.find((s) => s.name === 'redis')!
    expect(redis.endpoint).toBeNull()
    expect(redis.reason).toMatch(/REDIS_URL/)
  })
})

describe('probeServices', () => {
  afterEach(() => {
    delete process.env.DATABASE_URL
    delete process.env.REDIS_URL
    delete process.env.AZURE_KEYVAULT_URL
  })

  it('probes a reachable PG, skips unconfigured services, never leaks credentials', async () => {
    const srv = await listenEphemeral()
    try {
      const results = await probeServices(
        { DATABASE_URL: `postgres://u:supersecret@127.0.0.1:${srv.port}/db` } as NodeJS.ProcessEnv,
        2000, // non-critical timeout
        2000, // critical (postgres) timeout — keep the test bounded
      )
      const byName = Object.fromEntries(results.map((s) => [s.name, s]))
      expect(byName.postgres.status).toBe('ok')
      expect(byName.postgres.target).toBe(`127.0.0.1:${srv.port}`)
      // The credential must never appear in the surfaced target.
      expect(JSON.stringify(results)).not.toContain('supersecret')
      expect(byName.redis.status).toBe('skipped')
      expect(byName.keyVault.status).toBe('skipped')
    } finally {
      await srv.close()
    }
  })

  it('applies the CRITICAL timeout to postgres and the non-critical timeout to the rest', async () => {
    // Inject a fake probe that records the timeout it was handed per host — no
    // network, so the per-criticality split is asserted deterministically.
    const seen: Record<string, number> = {}
    const fakeProbe: typeof probeTcp = async (host, _port, timeoutMs) => {
      seen[host] = timeoutMs
      return { ok: true, latencyMs: 1 }
    }
    await probeServices(
      {
        DATABASE_URL: 'postgres://u:p@pg:5432/db',
        REDIS_URL: 'rediss://:p@redis:6380',
        AZURE_KEYVAULT_URL: 'https://kv.vault.azure.net/',
      } as NodeJS.ProcessEnv,
      5000, // non-critical
      30000, // critical
      fakeProbe,
    )
    expect(seen.pg).toBe(30000) // postgres is boot-critical → the long timeout
    expect(seen.redis).toBe(5000)
    expect(seen['kv.vault.azure.net']).toBe(5000)
  })
})

describe('criticalFailure — the boot gate', () => {
  const mk = (name: string, critical: boolean, status: ServiceProbe['status']): ServiceProbe => ({
    name,
    critical,
    status,
    target: status === 'skipped' ? null : 'h:1',
    latencyMs: status === 'skipped' ? null : 1,
  })

  it('a critical-unreachable service trips the gate (boot aborts)', () => {
    expect(criticalFailure([mk('postgres', true, 'unreachable'), mk('redis', false, 'ok')])).toBe(true)
  })
  it('a NON-critical-unreachable service does NOT trip the gate (warn, not block)', () => {
    expect(criticalFailure([mk('postgres', true, 'ok'), mk('redis', false, 'unreachable')])).toBe(false)
  })
  it('a critical SKIPPED service does not trip the gate (unconfigured ≠ down)', () => {
    expect(criticalFailure([mk('postgres', true, 'skipped')])).toBe(false)
  })
  it('all reachable → false', () => {
    expect(criticalFailure([mk('postgres', true, 'ok'), mk('redis', false, 'ok')])).toBe(false)
  })
})

describe('formatLine', () => {
  it('renders ok / skipped / unreachable distinctly', () => {
    const base = { name: 'postgres', critical: true, latencyMs: 12, target: 'pg:5432' }
    expect(formatLine({ ...base, status: 'ok' } as ServiceProbe)).toBe('postgres: ok pg:5432 (12ms)')
    expect(
      formatLine({ name: 'redis', critical: false, status: 'skipped', target: null, latencyMs: null, reason: 'REDIS_URL unset' } as ServiceProbe),
    ).toBe('redis: skipped (REDIS_URL unset)')
    expect(
      formatLine({ ...base, status: 'unreachable', errorClass: 'timeout', error: 'ETIMEDOUT' } as ServiceProbe),
    ).toBe('postgres: UNREACHABLE pg:5432 [timeout ETIMEDOUT] (12ms)')
  })
})

describe('runPreflight — the DATABASE_URL TLS warning is wired into the boot sequence', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    delete process.env.DATABASE_URL
  })

  it('warns before probing when DATABASE_URL is non-loopback without verify-full', async () => {
    const spy = vi.spyOn(consola, 'warn').mockImplementation(() => undefined as never)
    // 127.0.0.2 is within 127.0.0.0/8 (routes to `lo` — an instant, real-network-free
    // ECONNREFUSED, unlike a routable-but-dark address) but is NOT one of the literal
    // loopback forms checkDatabaseUrlTls special-cases (localhost/127.0.0.1/::1), so
    // it deterministically exercises the "non-loopback" warn path without flakiness
    // from DNS or an unbounded probe timeout.
    process.env.DATABASE_URL = 'postgres://u:p@127.0.0.2:1/db'
    await runPreflight()
    expect(spy).toHaveBeenCalledTimes(1)
    expect(spy.mock.calls[0]![0]).toContain('127.0.0.2')
  })

  it('stays silent when DATABASE_URL is unset', async () => {
    const spy = vi.spyOn(consola, 'warn').mockImplementation(() => undefined as never)
    delete process.env.DATABASE_URL
    await runPreflight()
    expect(spy).not.toHaveBeenCalled()
  })
})
