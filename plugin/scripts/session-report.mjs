/*
 * session-report — tell TokenScope which install THIS Claude session runs on
 * (#494, docs/design/session-instance-report.md).
 *
 * A tagged repo's .claude/settings.local.json carries the whole
 * OTEL_RESOURCE_ATTRIBUTES, instance id included, and Claude Code lets the repo
 * value replace the install's. So when Claude Code CLI and Claude Desktop open
 * one tagged repo, both emit with whichever install wrote the file last, and
 * one install's usage is labelled with the other's device. The resource
 * attributes are fixed before any hook runs, so the hook cannot correct them;
 * it reports instead: "session S runs on instance I", signed with this
 * install's own emit credential. The server books the session's rows to I when
 * I is the same teammate's as the instance the rows name.
 *
 * TRUST: everything comes from this install's OWN global settings (the caller
 * passes trustedGlobalSettingsEnv()), never the repo-merged process env: the
 * repo tag is exactly what may name the other install. The instance is the one
 * the bearer endpoint addresses, the token is the one cached for that endpoint,
 * and the request goes only to that endpoint's origin.
 *
 * Best-effort and fail-open: a short timeout, never throws, returns a reason.
 */
import { readFileSync } from 'node:fs'
import { accessCachePath, bearerInstance, readBoundAccessToken } from './device-store.mjs'
import { claudeInstallStateDir } from './plugin-runtime.mjs'
import { assertSafeEndpoint } from './endpoint-guard.mjs'

const TIMEOUT_MS = 3000
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

function readJson(p) {
  try {
    return JSON.parse(readFileSync(p, 'utf8'))
  } catch {
    return null
  }
}

/**
 * The SessionStart hook's stdin payload, parsed, or null. Claude Code writes
 * one JSON object (session_id, cwd, source, transcript_path) and closes the
 * pipe; a terminal or an open pipe with nothing on it must not hold the hook,
 * so the read gives up after `timeoutMs`.
 *
 * @param {{ stdin?: NodeJS.ReadableStream & { isTTY?: boolean }, timeoutMs?: number }} [opts]
 * @returns {Promise<Record<string, unknown> | null>}
 */
export function readHookInput({ stdin = process.stdin, timeoutMs = 1000 } = {}) {
  if (!stdin || stdin.isTTY) return Promise.resolve(null)
  return new Promise((resolve) => {
    let raw = ''
    let done = false
    const finish = () => {
      if (done) return
      done = true
      clearTimeout(timer)
      // Destroy, not pause: a paused pipe still holds the event loop open, and
      // the hook would then sit out its whole timeout after finishing.
      stdin.removeAllListeners?.('data')
      stdin.destroy?.()
      try {
        const v = JSON.parse(raw)
        resolve(v && typeof v === 'object' && !Array.isArray(v) ? v : null)
      } catch {
        resolve(null)
      }
    }
    const timer = setTimeout(finish, timeoutMs)
    stdin.setEncoding?.('utf8')
    stdin.on('data', (chunk) => {
      raw += chunk
      // A payload is a few hundred bytes; anything far larger is not ours.
      if (raw.length > 65536) {
        raw = ''
        finish()
      }
    })
    stdin.on('end', finish)
    stdin.on('error', finish)
  })
}

/**
 * Report `sessionId` against this install's instance.
 *
 * @param {{ sessionId: unknown, env?: Record<string,string>, stateDir?: string, fetchImpl?: typeof fetch }} args
 * @returns {Promise<{ ok: true, instanceId: string } | { ok: false, reason: string }>}
 */
export async function reportSessionInstance({ sessionId, env = {}, stateDir, fetchImpl = fetch } = {}) {
  const sid = typeof sessionId === 'string' ? sessionId.trim().toLowerCase() : ''
  if (!SESSION_ID.test(sid)) return { ok: false, reason: 'no-session-id' }
  const bearerEndpoint = String(env.TOKENSCOPE_BEARER_ENDPOINT || '').trim()
  if (!bearerEndpoint) return { ok: false, reason: 'not-configured' }
  // The instance is the one this install's own credential is bound to.
  const instanceId = bearerInstance(bearerEndpoint)
  if (!instanceId) return { ok: false, reason: 'bad-endpoint' }
  // .../instances/{id}/bearer  →  .../instances/{id}/claude-sessions
  const url = bearerEndpoint.replace(/\/bearer$/, '/claude-sessions')
  if (url === bearerEndpoint) return { ok: false, reason: 'bad-endpoint' }
  try {
    assertSafeEndpoint(url, { allowLoopback: true })
  } catch {
    return { ok: false, reason: 'bad-endpoint' }
  }
  const dir = stateDir || claudeInstallStateDir()
  const token = readBoundAccessToken(readJson(accessCachePath('claude-code', dir)), bearerEndpoint)
  if (!token) return { ok: false, reason: 'no-token' }

  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS)
  let res
  try {
    res = await fetchImpl(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ claudeSessionId: sid }),
      signal: ctrl.signal,
      // Never follow: the guard checked only this URL, and a redirect would
      // re-send the credential somewhere it did not check.
      redirect: 'error',
    })
  } catch {
    return { ok: false, reason: 'fetch-failed' }
  } finally {
    clearTimeout(t)
  }
  if (res.status !== 204 && !res.ok) return { ok: false, reason: `http-${res.status}` }
  return { ok: true, instanceId }
}
