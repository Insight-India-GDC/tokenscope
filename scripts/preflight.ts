/*
 * Boot pre-flight: probe reachability of every PROVISIONED private-endpoint
 * dependency BEFORE migrations, so a network gap (a PE that doesn't resolve or
 * route — the 2026-06 dev `CONNECT_TIMEOUT pg-…:5432` class) surfaces as a
 * named per-service line instead of a cryptic `migration failed; aborting boot`.
 *
 * This is an INFRA-CONNECTIVITY check, not a runtime-dependency check: it
 * probes services regardless of whether app code uses them yet (Redis is
 * provisioned for the future job-queue tier; we still want its PE validated).
 * But it aborts boot ONLY on a CRITICAL service (Postgres) — an un-wired but
 * unused PE (Redis, Key Vault) WARNS without blocking boot, so the very check
 * meant to help can't itself brick startup.
 *
 * Probe = a raw TCP connect to host:port. That is exactly the layer the
 * CONNECT_TIMEOUT failure lives at (DNS resolves + route exists + something
 * listens), needs no credentials, and never logs the connection URL (only
 * host:port is ever emitted). Log Analytics is deliberately NOT TCP-probed
 * here: its query frontend (api.loganalytics.io) has a public IP that answers
 * even when the workspace-specific private path is broken, so a TCP probe would
 * give a misleading "ok". LAW-read is validated by a real KQL in the admin
 * diagnostics endpoint instead.
 *
 * Runs in the entrypoint via tsx (like drizzle/migrate.ts). Lives in scripts/
 * (copied raw into the runtime image) and is dependency-light (node builtins
 * only) so a broken app bundle can't stop it running. The admin diagnostics
 * endpoint imports probeServices() from here (nitro bundles it at build).
 */
import net from 'node:net'
import { consola } from 'consola'

export type ProbeStatus = 'ok' | 'unreachable' | 'skipped'
export type ProbeErrorClass = 'timeout' | 'refused' | 'dns' | 'other'

export interface ServiceProbe {
  name: string
  critical: boolean
  status: ProbeStatus
  /** host:port actually probed — NEVER the credential-bearing URL. */
  target: string | null
  latencyMs: number | null
  errorClass?: ProbeErrorClass
  /** short error code (e.g. ECONNREFUSED) — never a secret. */
  error?: string
  /** present when status === 'skipped'. */
  reason?: string
}

// Non-critical services (Redis/KV) are warn-only, so a short timeout keeps boot
// snappy when an unused-but-unwired PE is probed.
const DEFAULT_TIMEOUT_MS = Number(process.env.PREFLIGHT_TIMEOUT_MS) || 5000
// Critical services (Postgres) GATE boot, so their probe must be no tighter than
// the migrate client that runs right after it — postgres.js defaults
// connect_timeout to 30s (drizzle/migrate.ts does not override it). A tighter
// probe could false-abort a boot that migrations would have survived (a slow but
// reachable endpoint), inverting this script's whole purpose. Align with it.
const CRITICAL_TIMEOUT_MS = Number(process.env.PREFLIGHT_CRITICAL_TIMEOUT_MS) || 30000

/** Raw TCP reachability to host:port. Resolves (never rejects) with a result. */
export function probeTcp(
  host: string,
  port: number,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<{ ok: boolean; latencyMs: number; errorClass?: ProbeErrorClass; error?: string }> {
  return new Promise((resolve) => {
    const start = Date.now()
    const socket = new net.Socket()
    let settled = false
    const finish = (r: { ok: boolean; errorClass?: ProbeErrorClass; error?: string }) => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve({ latencyMs: Math.max(0, Date.now() - start), ...r })
    }
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => finish({ ok: true }))
    socket.once('timeout', () => finish({ ok: false, errorClass: 'timeout', error: 'ETIMEDOUT' }))
    socket.once('error', (err: NodeJS.ErrnoException) => {
      const code = err.code ?? 'EUNKNOWN'
      const errorClass: ProbeErrorClass =
        code === 'ECONNREFUSED' ? 'refused' : code === 'ENOTFOUND' || code === 'EAI_AGAIN' ? 'dns' : 'other'
      finish({ ok: false, errorClass, error: code })
    })
    socket.connect(port, host)
  })
}

/** host + port from a connection URL, never echoing the URL itself. */
export function parseHostPort(url: string | undefined, defaultPort: number): { host: string; port: number } | null {
  if (!url) return null
  try {
    const u = new URL(url)
    if (!u.hostname) return null
    // URL brackets IPv6 literals ([::1]); net.connect wants the bare address.
    return { host: u.hostname.replace(/^\[|\]$/g, ''), port: u.port ? Number(u.port) : defaultPort }
  } catch {
    return null
  }
}

interface ServiceDef {
  name: string
  critical: boolean
  endpoint: { host: string; port: number } | null
  reason?: string
}

/** The provisioned private-endpoint services to probe, resolved from env. */
export function resolveServices(env: NodeJS.ProcessEnv = process.env): ServiceDef[] {
  // The entrypoint unsets the owner DATABASE_URL once the app-role URL is set;
  // both point at the same server.
  const pg = parseHostPort(env.TOKENSCOPE_APP_DATABASE_URL || env.DATABASE_URL, 5432)
  const redis = parseHostPort(env.REDIS_URL, 6380)
  // AZURE_KEYVAULT_URL is already injected (container-app.bicep) — the vault
  // hostname, not a secret.
  const kv = parseHostPort(env.AZURE_KEYVAULT_URL, 443)
  return [
    { name: 'postgres', critical: true, endpoint: pg, reason: pg ? undefined : 'DATABASE_URL unset' },
    { name: 'redis', critical: false, endpoint: redis, reason: redis ? undefined : 'REDIS_URL unset' },
    { name: 'keyVault', critical: false, endpoint: kv, reason: kv ? undefined : 'AZURE_KEYVAULT_URL unset' },
  ]
}

/** Probe every resolved service concurrently (bounded by the per-probe timeout). */
export async function probeServices(
  env: NodeJS.ProcessEnv = process.env,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
  criticalTimeoutMs: number = CRITICAL_TIMEOUT_MS,
  // Injectable for tests (asserts the per-criticality timeout split deterministically).
  probe: typeof probeTcp = probeTcp,
): Promise<ServiceProbe[]> {
  return Promise.all(
    resolveServices(env).map(async (s): Promise<ServiceProbe> => {
      if (!s.endpoint) {
        return { name: s.name, critical: s.critical, status: 'skipped', target: null, latencyMs: null, reason: s.reason }
      }
      const target = `${s.endpoint.host}:${s.endpoint.port}`
      const r = await probe(s.endpoint.host, s.endpoint.port, s.critical ? criticalTimeoutMs : timeoutMs)
      return {
        name: s.name,
        critical: s.critical,
        status: r.ok ? 'ok' : 'unreachable',
        target,
        latencyMs: r.latencyMs,
        errorClass: r.errorClass,
        error: r.error,
      }
    }),
  )
}

export function formatLine(s: ServiceProbe): string {
  if (s.status === 'skipped') return `${s.name}: skipped (${s.reason})`
  if (s.status === 'ok') return `${s.name}: ok ${s.target} (${s.latencyMs}ms)`
  return `${s.name}: UNREACHABLE ${s.target} [${s.errorClass}${s.error ? ` ${s.error}` : ''}] (${s.latencyMs}ms)`
}

/** Boot gate: true iff a CRITICAL (boot-blocking) dependency is unreachable. */
export function criticalFailure(results: ServiceProbe[]): boolean {
  return results.some((s) => s.critical && s.status === 'unreachable')
}

// Literal loopback forms only — never a hostname allowlist. A docker/compose
// service name (e.g. local dev's `tokenscope-postgres`) is deliberately
// NOT loopback here: this is a WARN, not a gate, so it is safe (and honest)
// to flag it too.
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1'])

export interface DatabaseUrlTlsCheck {
  /** true when a non-loopback host is configured without sslmode=verify-full. */
  insecure: boolean
  host: string | null
  /** present only when insecure — the observed sslmode (or its absence). */
  reason?: string
}

/*
 * TLS posture of DATABASE_URL — pure, so it's unit-testable without a live
 * connection. postgres@3.4.9 (connection.js:283-284) sets
 * rejectUnauthorized=false for the literal strings require/allow/prefer;
 * only sslmode=verify-full gets real server authentication (see
 * drizzle/connect.ts). This is advisory: the actual fix is the connection
 * STRING (infra/modules/keyvault-secrets.bicep), which only takes effect on
 * the next `infra.yml` apply that rewrites the KV secret — this check exists
 * so an environment still on the old secret is visible in the boot log.
 */
export function checkDatabaseUrlTls(url: string | undefined): DatabaseUrlTlsCheck {
  if (!url) return { insecure: false, host: null }
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return { insecure: false, host: null }
  }
  const host = parsed.hostname.replace(/^\[|\]$/g, '')
  if (LOOPBACK_HOSTS.has(host)) return { insecure: false, host }
  const sslmode = parsed.searchParams.get('sslmode')
  if (sslmode === 'verify-full') return { insecure: false, host }
  return { insecure: true, host, reason: sslmode ? `sslmode=${sslmode}` : 'no sslmode set' }
}

/*
 * WARN (never throw — see the file-level rationale on checkDatabaseUrlTls)
 * when DATABASE_URL looks unauthenticated. Flipping this to a boot-blocking
 * check is UF-2, gated on the infra apply that rewrites the KV secret;
 * shipping it as a throw here would boot-loop every environment still on
 * the old secret, and migrate.ts (which runs right after preflight) is
 * fatal on failure.
 */
export function warnOnInsecureDatabaseTls(env: NodeJS.ProcessEnv = process.env): void {
  const result = checkDatabaseUrlTls(env.DATABASE_URL)
  if (result.insecure) {
    consola.warn(
      `[preflight] DATABASE_URL host '${result.host}' is non-loopback without sslmode=verify-full ` +
        `(${result.reason}) — the connection encrypts but does not authenticate the server. ` +
        'WARNING only; does not block boot. See infra/modules/keyvault-secrets.bicep.',
    )
  }
}

export async function runPreflight(): Promise<number> {
  warnOnInsecureDatabaseTls()
  const results = await probeServices()
  for (const s of results) {
    const line = formatLine(s)
    if (s.status === 'unreachable' && s.critical) console.error(`[preflight] ${line}`)
    else console.log(`[preflight] ${line}`)
  }
  if (criticalFailure(results)) {
    console.error('[preflight] a CRITICAL dependency is unreachable; aborting boot before migrations')
    return 1
  }
  console.log('[preflight] all critical dependencies reachable')
  return 0
}

// NOTE: this module has NO top-level execution by design. The admin diagnostics
// route imports probeServices() from here, and nitro evaluates route modules at
// server startup — a top-level runPreflight() (even behind an import.meta.url
// guard, which does NOT hold in the bundled nitro context) would run the probes
// INSIDE the server and could process.exit() it. The CLI entry that the
// entrypoint invokes lives in scripts/preflight-run.ts.
