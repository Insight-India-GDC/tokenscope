#!/usr/bin/env node
/*
 * landed-check — ask the server whether this device's telemetry actually LANDED, and
 * cache the answer so the always-on statusline can render a real green `✓ landed`
 * WITHOUT making a network call itself.
 *
 * Calls GET /api/v1/instances/{id}/health (emit-credential authed — the same gate as
 * /bearer) using the emit access token the headers-helper already cached
 * (`<state>/oauth-access.<tool>.json`). Best-effort + short timeout: ANY failure leaves the
 * last-landed cache untouched, so the statusline simply renders from the last good
 * answer. Called by the session-start hook, `/tokenscope:status`, AND — throttled +
 * detached, never blocking a render — by the always-on statusline itself, so the
 * landing state stays fresh through a long session without the statusline ever making
 * a synchronous network call.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, sep } from 'node:path'
import { accessCachePath, bearerInstance, readBoundAccessToken } from './device-store.mjs'
import { isMainModule } from './is-main.mjs'
import { claudeInstallStateDir, trustedStateDir, trustedGlobalSettingsEnv } from './plugin-runtime.mjs'
import { assertSafeEndpoint } from './endpoint-guard.mjs'

const TIMEOUT_MS = 4000

function readJson(p) {
  try {
    return JSON.parse(readFileSync(p, 'utf8'))
  } catch {
    return null
  }
}

/**
 * Refresh the last-landed cache. Returns a small result object; never throws.
 * @param {{ env?: Record<string,string>, stateDir?: string }} opts
 */
export async function refreshLanded({ env = {}, stateDir } = {}) {
  /*
   * THE DELIVERY CACHE IS TRUST-BEARING, so its directory is not negotiable by
   * the environment. last-landed.json drives the status line's health indicator
   * AND the refresh throttle (landedRefreshDue reads it), so a repository that
   * can choose this directory can pre-seed a fresh, healthy cache: the status
   * line then reports delivery that is not happening, and suppresses the very
   * refresh that would discover it. Silence dressed as health.
   *
   * The deployment PIN survives, on a channel a repository cannot write: the
   * device's own global settings file on the passwd home, which is where redeem
   * writes and where the endpoints are already read from. What is dropped is the
   * AMBIENT process.env read — the one Claude Code fills from a repo's
   * .claude/settings.json. An explicit stateDir still wins; that is how the
   * tests sandbox it.
   */
  const pinned = trustedGlobalSettingsEnv().TOKENSCOPE_STATE_DIR
  const dir = stateDir || (pinned && String(pinned).trim()) || claudeInstallStateDir()
  /*
   * A TEST MUST NEVER WRITE THE REAL DEVICE STORE. Moving this default off the
   * ambient env means any caller that used to redirect it with
   * TOKENSCOPE_STATE_DIR now lands on the passwd home instead — which is how a
   * test suite silently starts writing a developer's own ~/.tokenscope. That
   * already happened once on this branch, in redeem. The signal is the vitest
   * worker global, not process.env.VITEST, because the environment is the
   * channel this function has just stopped trusting.
   */
  const underVitest =
    typeof globalThis.__vitest_worker__ === 'object' && globalThis.__vitest_worker__ !== null
  if (underVitest && (dir === trustedStateDir() || dir.startsWith(trustedStateDir() + sep))) {
    return { ok: false, reason: 'refusing to write the real device store from a test' }
  }
  /*
   * NO AMBIENT FALLBACK (MDASH F116 follow-up). refreshLanded posts the device's
   * real cached access token to this endpoint as a Bearer. Repointing the CLI at
   * trustedGlobalSettingsEnv did NOT close this sink: the function still reached
   * past its argument into process.env, which is the repo-merged environment.
   * The caller supplies a trusted env or there is no request.
   */
  const bearerEndpoint = env.TOKENSCOPE_BEARER_ENDPOINT || ''
  const attrs = env.OTEL_RESOURCE_ATTRIBUTES || process.env.OTEL_RESOURCE_ATTRIBUTES || ''
  const instanceId = attrs.match(/tokenscope\.instance_id=([^,]+)/)?.[1]
  if (!bearerEndpoint || !instanceId) return { ok: false, reason: 'not-configured' }

  // .../instances/{id}/bearer  →  .../instances/{id}/health
  const healthUrl = bearerEndpoint.replace(/\/bearer(\?.*)?$/, '/health')
  if (healthUrl === bearerEndpoint) return { ok: false, reason: 'bad-endpoint' }
  // S1 fix 3: validate before the fetch (defence-in-depth — a backstop for
  // ANY caller, regardless of which fallback above resolved bearerEndpoint).
  // Loopback allowed: local-dev TOKENSCOPE_API_BASE (:3450) legitimately
  // returns a loopback bearer endpoint.
  try {
    assertSafeEndpoint(healthUrl, { allowLoopback: true })
  } catch {
    return { ok: false, reason: 'bad-endpoint' }
  }
  // The cache labels the answer with `instanceId`, and the answer is about the
  // instance this endpoint addresses. A repo tag can name another local install's.
  if (bearerInstance(bearerEndpoint) !== instanceId) return { ok: false, reason: 'instance-mismatch' }

  const access = readJson(accessCachePath('claude-code', dir))
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
  // The client's last bearer mint = a proxy for recent EMIT ACTIVITY. The
  // statusline uses it to tell a DEAD EXPORT (client actively emitting, landed
  // watermark frozen) apart from an IDLE client (nobody's emitting → a stale
  // last_emission is EXPECTED, not a fault). Without it, now−last_emission alone
  // false-alarms red on any idle session.
  const lastBearer = body?.last_bearer_at ?? null
  // The enrolment's own start. Lets the statusline age a NEVER-landed instance:
  // null last_emission on a minutes-old enrolment is a first record still in
  // flight; the same null hours later is a fault. Absent from an older server →
  // null → the statusline keeps its previous (neutral) behaviour.
  const tsStart = body?.ts_start ?? null
  const silent = !!body?.silent
  const revoked = !!body?.revoked
  try {
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      // Per tool (#453): the Copilot plugin writes its own landing record into the
      // same ~/.tokenscope, and a shared name let each overwrite the other's.
      join(dir, 'last-landed.claude-code.json'),
      // `ok:true` records that /health was REACHED (auth + read path both work) —
      // it lets the statusline tell a live-but-stale answer (dead export) apart
      // from an unreachable endpoint (unknown). `checkedAt` doubles as the poll
      // throttle stamp the statusline reads to decide when a background refresh
      // is due; `revoked` carries the enrolment-revoked flag through to the render.
      `${JSON.stringify({ ok: true, instanceId, lastEmission, lastBearer, tsStart, silent, revoked, checkedAt: new Date().toISOString() })}\n`,
      { mode: 0o600 },
    )
  } catch {
    /* cache write is best-effort */
  }
  return { ok: true, lastEmission, lastBearer, tsStart, silent, revoked }
}

// CLI: refresh using the global settings.json env (best-effort, prints the result).
//
// TRUSTED read (F116). This env names TOKENSCOPE_BEARER_ENDPOINT, and
// refreshLanded sends the device's real cached access token there as a Bearer.
// Resolved through homedir() it was a repo-moved HOME's choice of destination —
// nothing repairs HOME on this path, because neutraliseRepoHome runs only in
// the SessionStart hook.
if (isMainModule(import.meta.url)) {
  refreshLanded({ env: trustedGlobalSettingsEnv() }).then((r) =>
    process.stdout.write(`${JSON.stringify(r)}\n`),
  )
}
