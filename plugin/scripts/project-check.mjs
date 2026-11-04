#!/usr/bin/env node
/*
 * project-check — ask the server whether THIS repo's project tag is actually
 * billable on the env the device emits to, and classify the result for the
 * session-start hook + `/tokenscope:status`.
 *
 * The wrong-env-tag trap: a committed `.tokenscope` can name a project that
 * exists on a DIFFERENT environment (e.g. a sandbox project code on a device that
 * emits to dev). The joiner then silently spills that spend to UNTAGGED. This
 * probe surfaces it.
 *
 * Authoritative via the EMIT credential: it calls
 *   GET /api/v1/instances/{id}/project-resolve?code_hash=…
 * with the same emit access token the headers-helper caches — so the answer is
 * "billable on the device's OWN emit env", with no read/emit divergence and no MCP
 * auth. Sends ONLY the hash, never a repo path.
 *
 * FALSE-POSITIVE FIREWALL / fail-open: ONLY an explicit HTTP-200 `billable:false`
 * returns 'not-billable' (the one case we warn). EVERY other path — no `.tokenscope`,
 * no emitting tag, no token, offline, timeout, 401/403/4xx/5xx, bad JSON — returns
 * 'no-tag' or 'unverifiable' and stays SILENT, so the hook never cries wolf and
 * never breaks the session.
 */
import { readFileSync } from 'node:fs'

import { accessCachePath, bearerInstance, readBoundAccessToken } from './device-store.mjs'
import { isMainModule } from './is-main.mjs'
import { resolveRepoProjectCode, computeCodeHash } from './tag-repo.mjs'
import { stateDir as resolveStateDir, trustedGlobalSettingsEnv } from './plugin-runtime.mjs'
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
 * Classify the repo's project-tag billability. Returns a small result object;
 * never throws. status ∈ 'ok' | 'not-billable' | 'unverifiable' | 'no-tag'.
 * @param {{ env?: Record<string,string>, cwd?: string, stateDir?: string, timeoutMs?: number }} opts
 */
export async function checkRepoProjectBillable({
  env = {},
  cwd = process.cwd(),
  stateDir,
  timeoutMs = TIMEOUT_MS,
} = {}) {
  // S1 fix 2: route through the shared stateDir() resolver — see landed-check.mjs's
  // identical note; one deletion (safeProcessEnv / repoTagEnv) then covers this too.
  const dir = stateDir || resolveStateDir(env)
  const attrs = env.OTEL_RESOURCE_ATTRIBUTES || process.env.OTEL_RESOURCE_ATTRIBUTES || ''
  // The attrs' instance, else the one this install's own endpoint addresses: a
  // command run from a session gets no OTEL_* keys at all (#503), and the
  // request below goes to the endpoint whatever the attrs say.
  const instanceId =
    attrs.match(/tokenscope\.instance_id=([^,]+)/)?.[1] || bearerInstance(env.TOKENSCOPE_BEARER_ENDPOINT) || undefined
  // The hash THIS session is actually emitting (frozen at process start), if tagged.
  const emittingHash = attrs.match(/project\.code_hash=([^,]+)/)?.[1] || null

  // The committed `.tokenscope` code → its hash (the next-launch tag). Throws when
  // there's no committed project code; that's the 'no-tag' (silent) case.
  let committedCode = null
  let committedHash = null
  try {
    const resolved = resolveRepoProjectCode({ arg: '', cwd })
    if (resolved.source === 'tokenscope' && resolved.code) {
      committedCode = resolved.code
      committedHash = computeCodeHash(resolved.code)
    }
  } catch {
    /* no .tokenscope / no project.code — leave committed null */
  }

  // Nothing tagged at all (no live tag AND no committed tag) → nothing to check.
  if (!emittingHash && !committedHash) return { status: 'no-tag' }

  // Prefer the LIVE emitting hash (what spend is landing as right now); fall back
  // to the committed hash (the next-launch tag) when this session is untagged.
  const hashToCheck = emittingHash || committedHash
  const scope = emittingHash ? 'emitting' : 'committed'

  /*
   * NO AMBIENT FALLBACK (MDASH follow-up). This endpoint receives the device's
   * real cached access token as a Bearer, so a `process.env` fallback let a
   * repo-merged environment name the destination even after the CALLER was
   * repointed at the trusted settings — closing the caller and leaving the sink
   * open. The caller must pass a trusted env; there is no second guess.
   */
  const bearerEndpoint = env.TOKENSCOPE_BEARER_ENDPOINT || ''
  if (!bearerEndpoint || !instanceId) return { status: 'unverifiable', reason: 'not-configured' }

  // .../instances/{id}/bearer  →  .../instances/{id}/project-resolve?code_hash=…
  const base = bearerEndpoint.replace(/\/bearer(\?.*)?$/, '/project-resolve')
  if (base === bearerEndpoint) return { status: 'unverifiable', reason: 'bad-endpoint' }
  const url = `${base}?code_hash=${encodeURIComponent(hashToCheck)}`
  // S1 fix 3: validate before the fetch (defence-in-depth backstop). Loopback
  // allowed: local-dev TOKENSCOPE_API_BASE (:3450) legitimately returns a
  // loopback bearer endpoint.
  try {
    assertSafeEndpoint(url, { allowLoopback: true })
  } catch {
    return { status: 'unverifiable', reason: 'bad-endpoint' }
  }

  const access = readJson(accessCachePath('claude-code', dir))
  // Only a cache bound to this destination may be presented.
  const token = readBoundAccessToken(access, bearerEndpoint)
  if (!token) return { status: 'unverifiable', reason: 'no-token' }

  let res
  try {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), timeoutMs)
    res = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, signal: ctrl.signal, redirect: 'error' })
    clearTimeout(timer)
  } catch {
    return { status: 'unverifiable', reason: 'fetch-failed' }
  }
  if (!res.ok) return { status: 'unverifiable', reason: `http-${res.status}` }

  let body
  try {
    body = await res.json()
  } catch {
    return { status: 'unverifiable', reason: 'bad-json' }
  }

  // Report the human code ONLY when it corresponds to the hash we actually checked.
  // When the live emitting hash differs from the committed .tokenscope (e.g. a fix
  // was committed but this frozen session still emits the old tag), we have the
  // emitting HASH but not its code — naming committedCode here would misdirect the
  // user to re-tag away from their own fix. Null it in that case.
  const reportedCode = hashToCheck === committedHash ? committedCode : null

  if (body?.billable === true) {
    return { status: 'ok', code: reportedCode, scope }
  }
  if (body?.billable === false) {
    return {
      status: 'not-billable',
      code: reportedCode,
      scope,
      emittingHash,
      committedHash,
      committedDiffers: Boolean(committedHash && committedHash !== emittingHash),
      yourProjects: Array.isArray(body.your_projects) ? body.your_projects : [],
    }
  }
  // Anything else (shape we don't recognise) — stay silent.
  return { status: 'unverifiable', reason: 'unexpected-shape' }
}

// CLI: classify using the global settings.json env (best-effort, prints the result).
if (isMainModule(import.meta.url)) {
  // TRUSTED read: homedir() honours HOME, which a hostile repo can move, and this
  // env names the endpoint the access token above is sent to.
  checkRepoProjectBillable({ env: trustedGlobalSettingsEnv() }).then((r) =>
    process.stdout.write(`${JSON.stringify(r)}\n`),
  )
}
