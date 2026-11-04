#!/usr/bin/env node
/*
 * landed-check (Copilot CLI) — ask the server whether THIS device's telemetry
 * actually LANDED, and cache the answer so a status read can render a real
 * "✓ landed" without each caller making its own network round-trip.
 *
 * Mirrors the Claude landed-check contract (plugin/scripts/landed-check.mjs):
 * calls GET /api/v1/instances/{id}/health (emit-credential authed — the SAME gate
 * as /bearer) using the emit access token the headers-helper already cached
 * (~/.tokenscope/oauth-access.copilot-cli.json), then writes a small last-landed.copilot-cli.json cache.
 * Best-effort + short timeout: ANY failure leaves the last-landed cache untouched
 * and returns a typed `{ ok:false, reason }` — it NEVER throws, so a status probe
 * can fail-open to "unconfirmed" rather than red.
 *
 * The ONE Copilot difference from Claude: the instance id + bearer endpoint come
 * from ~/.tokenscope/config.copilot-cli.json (Copilot has no ~/.claude/settings.json env block
 * and does not export OTEL_RESOURCE_ATTRIBUTES to the shell — see copilot-redeem.mjs),
 * NOT from OTEL_RESOURCE_ATTRIBUTES / settings.json. The access-token cache file is
 * the same one otel-headers-helper.sh writes (oauth-access.copilot-cli.json), so reading it here
 * never needs the durable refresh token.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { resolveStorePath, accessCachePath, readBoundAccessToken } from './device-store.mjs'
import { isMainModule } from './is-main.mjs'
// endpoint-guard.mjs (S1/S2) — the ONE endpoint validator, vendored verbatim
// (see scripts/sync-copilot-plugin.mjs). Do not write a second one; mirrors
// plugin/scripts/landed-check.mjs's S1 fix 3 exactly (this file is a
// DELIBERATELY separate, non-vendored implementation — see version-sync.test.ts's
// DELIBERATELY_NOT_VENDORED — but the fix shape is the same).
import { assertSafeEndpoint } from './endpoint-guard.mjs'
// real-home.mjs — the ONE answer to "where is the account's home", vendored verbatim
// like endpoint-guard.mjs. See stateDir() below.
import { realHome } from './real-home.mjs'

const TIMEOUT_MS = 4000

function readJson(p) {
  try {
    return JSON.parse(readFileSync(p, 'utf8'))
  } catch {
    return null
  }
}

/**
 * The TokenScope state dir: a `TOKENSCOPE_STATE_DIR` pin first, else `~/.tokenscope`
 * under the PASSWD home — the one resolution `copilot-forwarder.mjs`, `enroll.mjs`,
 * `status.mjs` and `copilot-redeem.mjs`'s `TOKENSCOPE_DIR` all share.
 *
 * `realHome()`, not `homedir()`: this reads `config.copilot-cli.json` (which holds
 * `oauth_refresh_token`) for the instance id and the bearer endpoint it derives the
 * health URL from, so a leaked or model-set `HOME` would otherwise choose which
 * device's identity is checked and which host is asked — and, absent a planted file,
 * would simply report a healthy device as "not configured".
 */
export function stateDir() {
  return (process.env.TOKENSCOPE_STATE_DIR ?? '').trim() || join(realHome(), '.tokenscope')
}

/**
 * Derive the health URL from the per-instance bearer endpoint
 * (.../instances/{id}/bearer → .../instances/{id}/health). Returns null when the
 * endpoint isn't a recognisable /bearer URL (so we never GET somewhere unexpected)
 * OR when the derived URL fails assertSafeEndpoint (S2 fix — closes the Copilot
 * leg of client-plugins:mitm:0003: refreshLanded's `fetch(healthUrl, ...)` picks
 * whatever scheme the URL carries with no complaint, so an off-box http:// bearer
 * endpoint — a poisoned config.copilot-cli.json, or a MITM'd redeem/enroll response — would
 * otherwise be GET'd in plaintext carrying the cached emit access token).
 * allowLoopback:true — local-dev TOKENSCOPE_API_BASE (:3450) legitimately returns
 * a loopback bearer endpoint.
 */
export function healthUrlFromBearer(bearerEndpoint) {
  if (!bearerEndpoint || typeof bearerEndpoint !== 'string') return null
  const healthUrl = bearerEndpoint.replace(/\/bearer(\?.*)?$/, '/health')
  if (healthUrl === bearerEndpoint) return null
  try {
    assertSafeEndpoint(healthUrl, { allowLoopback: true })
  } catch {
    return null
  }
  return healthUrl
}

/**
 * Refresh the last-landed cache for a Copilot device. Returns a small typed result
 * object; NEVER throws. Reads creds from ~/.tokenscope/config.copilot-cli.json (instance_id +
 * bearer_endpoint) and the access token from oauth-access.copilot-cli.json.
 *
 * @param {{ dir?: string }} [opts] — override the state dir (tests).
 * @returns {Promise<{ ok: boolean, reason?: string, lastEmission?: string|null, silent?: boolean, revoked?: boolean }>}
 */
export async function refreshLanded({ dir } = {}) {
  const stateD = dir || stateDir()
  const config = readJson(resolveStorePath('copilot-cli', stateD))
  const instanceId = config?.instance_id
  const bearerEndpoint = config?.bearer_endpoint
  if (!instanceId || !bearerEndpoint) return { ok: false, reason: 'not-configured' }

  const healthUrl = healthUrlFromBearer(bearerEndpoint)
  if (!healthUrl) return { ok: false, reason: 'bad-endpoint' }

  const access = readJson(accessCachePath('copilot-cli', stateD))
  // Only a cache bound to this destination may be presented.
  const token = readBoundAccessToken(access, bearerEndpoint)
  if (!token) return { ok: false, reason: 'no-token' }

  let res
  try {
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS)
    res = await fetch(healthUrl, {
      headers: { Authorization: `Bearer ${token}` },
      signal: ctrl.signal,
      // Never follow: the scheme guard checked only this URL (curl/PowerShell lanes agree).
      redirect: 'error',
    })
    clearTimeout(t)
  } catch {
    return { ok: false, reason: 'fetch-failed' }
  }
  if (!res.ok) return { ok: false, reason: `http-${res.status}` }
  let body
  try {
    body = await res.json()
  } catch {
    return { ok: false, reason: 'bad-json' }
  }

  const lastEmission = body?.last_emission ?? null
  const silent = !!body?.silent
  const revoked = !!body?.revoked
  try {
    mkdirSync(stateD, { recursive: true })
    writeFileSync(
      // Per tool (#453): the Claude plugin writes its own landing record into the
      // same ~/.tokenscope, and a shared name let each overwrite the other's.
      join(stateD, 'last-landed.copilot-cli.json'),
      `${JSON.stringify({ instanceId, lastEmission, silent, revoked, checkedAt: new Date().toISOString() })}\n`,
      { mode: 0o600 },
    )
  } catch {
    /* cache write is best-effort */
  }
  return { ok: true, lastEmission, silent, revoked }
}

// CLI: refresh from ~/.tokenscope/config.copilot-cli.json (best-effort, prints the result JSON).
if (isMainModule(import.meta.url)) {
  refreshLanded().then((r) => process.stdout.write(`${JSON.stringify(r)}\n`))
}
