#!/usr/bin/env node

/*
 * /tokenscope:status implementation — "is my Claude emitting to TokenScope, and
 * is the MCP connection (the query side) authed?"
 *
 * Two purely-LOCAL signals — NO settings.json read credential, NO server call:
 *
 *  1. EMISSION PROBE (unchanged). Invoke the SAME `otel-headers-helper.sh` that
 *     Claude Code calls every ~29 min to mint the Azure ingest bearer, and branch
 *     on its exit code (via plugin-runtime::runEmitHelper). Exit 0 (a bearer was
 *     minted) → emitting; non-zero → the helper already wrote a failure sentinel
 *     with the precise HTTP status + reason, which we surface.
 *
 *     WHY invoke the helper rather than GET /bearer ourselves: the helper is the
 *     REAL emit path — it presents the auto-refreshing OAuth emit credential. The
 *     bearer JSON the helper prints is NEVER surfaced (runEmitHelper returns only
 *     whether a bearer was minted, never the token).
 *
 *  2. MCP-AUTH PROBE (new). Read Claude Code's own credential store (the macOS
 *     Keychain, else .credentials.json in the install's config folder; claude-credentials.mjs). If its `.mcpOAuth` object holds an entry for
 *     the TokenScope MCP server (a key like `plugin:tokenscope:tokenscope|...`),
 *     the MCP connection is authed — so the my_usage / tag_session tools and the
 *     setup/tag/project/usage prompts can run. Presence = authed (the documented
 *     script-readable signal). Fail-defensive: no store → false; malformed → false.
 *
 * The server-side attribution view (recent sessions / what landed) is GONE from
 * this script — query it via the `my_usage` MCP tool or the web dashboard.
 *
 * Env in:
 *   TOKENSCOPE_BEARER_ENDPOINT   the per-instance /bearer URL (consumed by the helper)
 *   TOKENSCOPE_OAUTH_*           the OAuth emit credential (consumed by the helper)
 *   TOKENSCOPE_STATE_DIR         sentinel dir override (default $HOME/.tokenscope)
 *   CLAUDE_PLUGIN_ROOT           where otel-headers-helper.sh lives (set by Claude)
 */
import { isMainModule } from './is-main.mjs'
import { claudeInstallStateDir, degradedExpiryNote, readEmitDegraded, readEmitSentinel, readSettingsEnv, repoTagEnv, runEmitHelper, safeProcessEnv, storeHoldsEnrolment, trustedGlobalSettingsEnv, trustedStateDir } from './plugin-runtime.mjs'
import { checkRepoProjectBillable } from './project-check.mjs'
import { isMcpAuthed, probeMcpAuth } from './claude-credentials.mjs'
import { desktopEnvVerdict, desktopRestartAdvice, isTrustedDesktopSession, readDesktopEnv, sessionDesktopAttrs } from './desktop-env.mjs'
import { resolveClaudeConfigDir } from './claude-config-dir.mjs'
import { realHome } from './real-home.mjs'
import { join } from 'node:path'
import { attrsInstance, bearerInstance } from './device-store.mjs'
import { refreshLanded } from './landed-check.mjs'
import { readLandedCache } from './statusline.mjs'
import { readFileSync } from 'node:fs'
import { findTokenscopeFile, parseTokenscope, isSafeProjectCode, readFolderActivity } from './tokenscope-project.mjs'
import { resolveRepoRoot } from './tag-repo.mjs'
import { readSessionActivity } from './session-activity.mjs'

/**
 * #475: what this session's work is tagged with, and where each part came from.
 * Pure over its inputs + exported for tests:
 *   - `set`: what /tokenscope:activity recorded for this session (or null);
 *   - `tokenscopeCode`: the repo's `.tokenscope` code (or null);
 *   - `settingsHash`: a project.code_hash a committed `.claude/settings.json`
 *     carries in its OTEL_RESOURCE_ATTRIBUTES (or null);
 *   - `folderActivity`: the folder's default activity (or null).
 */
export function workReport({ set = null, tokenscopeCode = null, settingsHash = null, folderActivity = null }) {
  let project = { code: null, source: null }
  if (set?.project) project = { code: set.project, source: 'set this session' }
  else if (tokenscopeCode) project = { code: tokenscopeCode, source: 'from .tokenscope' }
  else if (settingsHash) project = { code: null, code_hash: settingsHash, source: 'from .claude/settings.json' }
  let activity = { label: null, source: null }
  if (set?.activity) activity = { label: set.activity, source: 'set this session' }
  // A claim, not a fact: the server keeps it only when it names an activity type,
  // and it reaches a session's records from the next session on.
  else if (folderActivity) activity = { label: folderActivity, source: 'folder default', note: "applies from the next session, and only if it is one of your region's activity types" }
  return { project, activity }
}

/** The project.code_hash a folder's committed `.claude/settings.json` names, or null. */
function settingsJsonHash(root) {
  try {
    const attrs = JSON.parse(readFileSync(join(root, '.claude', 'settings.json'), 'utf8'))?.env?.OTEL_RESOURCE_ATTRIBUTES
    return (typeof attrs === 'string' && /(?:^|,)project\.code_hash=([0-9a-f]{64})(?=,|$)/.exec(attrs)?.[1]) || null
  } catch {
    return null
  }
}

/** This folder's inputs to workReport. Never throws. */
function folderWork(cwd, sessionId, stateDir) {
  try {
    const root = resolveRepoRoot(cwd) ?? cwd
    const ts = findTokenscopeFile(cwd)
    const code = ts ? parseTokenscope(ts)?.project?.code : null
    return workReport({
      set: sessionId ? readSessionActivity(sessionId, stateDir) : null,
      tokenscopeCode: code && isSafeProjectCode(code) ? code : null,
      settingsHash: settingsJsonHash(root),
      folderActivity: readFolderActivity(root),
    })
  } catch {
    return workReport({})
  }
}

/** `--session <id>` from argv (the command passes Claude's own session id), or null. */
function sessionArg(argv = process.argv.slice(2)) {
  const i = argv.indexOf('--session')
  const v = i >= 0 ? argv[i + 1] : null
  return typeof v === 'string' && /^[A-Za-z0-9-]{8,128}$/.test(v) ? v : null
}

/**
 * When this device's usage last landed (#457), from the server's /health answer
 * when it was reachable, else from the landing record the status line keeps.
 * Pure + exported for tests. `live` is refreshLanded()'s result, `cache` the
 * parsed landing record (or null), `instanceId` this install's instance: a record
 * naming another instance (an old shared file) is not this device's and is ignored.
 */
export function landedReport(live, cache, instanceId) {
  if (live && live.ok) {
    return {
      at: live.lastEmission ?? null,
      source: 'server',
      message: live.lastEmission
        ? `Usage from this computer last arrived at ${live.lastEmission}.`
        : 'TokenScope has not received usage from this computer yet.',
    }
  }
  if (cache && cache.instanceId && cache.instanceId === instanceId && cache.checkedAt) {
    return {
      at: cache.lastEmission ?? null,
      source: 'cache',
      checked_at: cache.checkedAt,
      message: cache.lastEmission
        ? `Usage from this computer last arrived at ${cache.lastEmission} (as of ${cache.checkedAt}; TokenScope could not be asked just now).`
        : `TokenScope had not received usage from this computer as of ${cache.checkedAt} (it could not be asked just now).`,
    }
  }
  return { at: null, source: null, message: 'Could not find out when usage from this computer last arrived.' }
}

/**
 * Decide the emission verdict from the helper's exit result + any sentinel it
 * wrote. Pure + exported for tests. `status` is the helper's exit code,
 * `stdoutHasAuth` whether a bearer was minted, `sentinel` the parsed
 * emit-failure.json (or null).
 */
export function interpretEmissionProbe({ status, stdoutHasAuth, sentinel, degraded = null }) {
  if (status === 0 && stdoutHasAuth && degraded) {
    // Exit 0 on the CACHED bearer (#409): TokenScope was unreachable, so nothing
    // verified the credential this run. Emitting, but not "OK".
    const reason = degraded.reason || 'TokenScope unreachable'
    const since = degraded.ts || 'unknown time'
    return {
      emitting: true,
      degraded: true,
      probe_status: 0,
      message: `DEGRADED: TokenScope is unreachable (${reason}; since ${since}). Still sending on the cached credential (${degradedExpiryNote(degraded)}), but it was NOT verified. Run /tokenscope:status again once TokenScope is reachable.`,
    }
  }
  if (status === 0 && stdoutHasAuth) {
    return {
      emitting: true,
      probe_status: 200,
      // Whether usage has ARRIVED is reported beside this, in `last_landed` (#457).
      message: 'OK: this computer can send usage to TokenScope.',
    }
  }
  if (status === 0 && !stdoutHasAuth) {
    return {
      emitting: false,
      probe_status: null,
      message:
        'ERROR: the helper finished but returned no credential. Run /tokenscope:status again; if it keeps happening, run /tokenscope:setup.',
    }
  }
  // Non-zero exit: the helper printed a loud, sanitised reason to stderr and
  // wrote a sentinel with the precise HTTP status + reason. Surface that.
  const http = sentinel && Number.isFinite(sentinel.http_status) ? sentinel.http_status : null
  const reason = (sentinel && sentinel.message) || 'credential check failed'
  let message
  if (http === 401 || http === 403 || http === 404) {
    message = `NOT SENDING: ${reason} (HTTP ${http}). Usage is being dropped. Run /tokenscope:setup to reconnect this computer.`
  } else if (http === 0) {
    // The helper recorded a NETWORK error — likely transient (the exporter keeps
    // its last bearer). Do NOT cry "dropped" or steer to re-provision.
    message = `UNVERIFIED: ${reason}. Usually a short network blip. Run /tokenscope:status again; if it keeps failing, usage may be dropped.`
  } else if (http == null) {
    // Helper exited non-zero but recorded NO sentinel (e.g. the sentinel write
    // itself failed) — a real failure with no detail. Steer to re-provision rather
    // than mislabel it transient (under-warning is as bad as crying wolf).
    message = `NOT SENDING: the helper failed without saying why. Usage may be dropped. Run /tokenscope:status again; if it keeps failing, run /tokenscope:setup.`
  } else {
    message = `NOT SENDING: ${reason} (HTTP ${http}). Usage may be dropped. Run /tokenscope:status again, or run /tokenscope:setup.`
  }
  return { emitting: false, probe_status: http, message }
}

/**
 * Active emission-auth probe. Invokes the real emit path (runEmitHelper) and
 * interprets its exit code + sentinel. NEVER surfaces the bearer.
 *
 * S1 fix 2: `env` MUST be the caller's `safeProcessEnv()` result, never raw
 * `process.env` — Claude Code has already applied a TAGGED repo's
 * `settings.local.json` onto `process.env` before spawning this script, so
 * `process.env` may be repo-controlled by the time this runs.
 * `safeProcessEnv()` re-derives the trustworthy env once in main() and every
 * read here goes through it.
 *
 * The control is unchanged; the MECHANISM named here used to say "by
 * REPLACEMENT (ADR-0006 §2)" and that is false — the blocks are merged PER KEY
 * with the repo-local value winning a conflict, captured against Claude Code
 * 2.1.232 (docs/security-sprint/env-precedence-capture.md). Merge makes this
 * control MORE important, not less: replacement is conspicuous (a repo block
 * missing a key removes it), whereas merge lets a repo override ONE key —
 * TOKENSCOPE_BEARER_ENDPOINT, say — and leave every other value looking
 * untouched.
 */
export function probeEmissionAuth(env, storeDir = claudeInstallStateDir()) {
  const endpoint = (env.TOKENSCOPE_BEARER_ENDPOINT ?? '').trim()
  // The refresh token lives in the device store; an older redeem left it in settings.
  const hasOAuth =
    storeHoldsEnrolment('claude-code', endpoint, storeDir) ||
    Boolean(
      (env.TOKENSCOPE_OAUTH_REFRESH_TOKEN ?? '').trim() &&
        (env.TOKENSCOPE_OAUTH_TOKEN_ENDPOINT ?? '').trim() &&
        (env.TOKENSCOPE_OAUTH_CLIENT_ID ?? '').trim(),
    )
  if (!endpoint || !hasOAuth) {
    return {
      emitting: false,
      probe_status: null,
      message:
        "Not configured: this session has no TokenScope credential. Run /tokenscope:setup, then restart Claude Code.",
    }
  }
  const { ran, status, hasAuth } = runEmitHelper({ env, stateDir: storeDir })
  if (!ran) {
    return {
      emitting: false,
      probe_status: null,
      message: 'Headers helper not found — is the plugin installed / CLAUDE_PLUGIN_ROOT set?',
    }
  }
  return interpretEmissionProbe({
    status,
    stdoutHasAuth: hasAuth,
    // The helper writes where runEmitHelper pinned it — storeDir, by default
    // this install's own (claudeInstallStateDir) — so read back from there. stateDir() honours a live
    // TOKENSCOPE_STATE_DIR (which safeProcessEnv only strips from its copy),
    // and reading through it missed
    // the marker and reported "Emission auth OK" during an outage.
    sentinel: readEmitSentinel(env, storeDir),
    degraded: readEmitDegraded(env, storeDir),
  })
}

// Signed in = Claude Code's store has a TokenScope MCP OAuth entry; read from the
// macOS Keychain or the config folder's .credentials.json (claude-credentials.mjs).
export { isMcpAuthed }

/**
 * The project-tag billability block: is THIS repo's project tag billable on the
 * env the device emits to? Deterministic over the running session's frozen env (no
 * MCP needed). Fail-defensive: any non-billable verdict is the actionable wrong-env
 * warning; everything else (offline/unauth/no-tag) is reported neutrally, never red.
 */
async function projectBlock(env) {
  let r
  try {
    r = await checkRepoProjectBillable({ env, cwd: process.cwd() })
  } catch {
    return { code: null, billable: null, message: 'Project-tag check unavailable.' }
  }
  if (r.status === 'ok') {
    return {
      code: r.code ?? null,
      billable: true,
      message: `Project tag${r.code ? ` “${r.code}”` : ''} is billable on this environment.`,
    }
  }
  if (r.status === 'not-billable') {
    const projects = (r.yourProjects || []).map((p) => p && p.code).filter(Boolean)
    const hint = projects.length ? ` Your budgets: ${projects.join(', ')}.` : ''
    return {
      code: r.code ?? null,
      billable: false,
      message: `Wrong-env tag:${r.code ? ` “${r.code}”` : ''} is NOT billable here — spend is landing UNTAGGED. Re-tag via /tokenscope:project.${hint}`,
    }
  }
  if (r.status === 'no-tag') {
    return {
      code: null,
      billable: null,
      message: 'No project tag (.tokenscope) in this repo — spend is untagged by default.',
    }
  }
  return { code: null, billable: null, reason: r.reason ?? null, message: unverifiedMessage(r.reason) }
}

/**
 * Why the project check could not run, in words that name the cause (#503).
 * The reasons are project-check.mjs's; anything unlisted is TokenScope
 * answering in a way this plugin does not understand.
 *
 * @param {string | undefined} reason
 */
export function unverifiedMessage(reason) {
  const lead = 'Could not check whether the project tag is billable:'
  if (reason === 'not-configured') return `${lead} this device is not set up to send usage. Run /tokenscope:setup.`
  if (reason === 'no-token') {
    return `${lead} this device has no current sign-in to TokenScope yet. It signs in when Claude Code next sends usage; if this stays, run /tokenscope:setup.`
  }
  if (reason === 'fetch-failed') return `${lead} TokenScope could not be reached (offline, or a network block).`
  if (reason === 'http-401' || reason === 'http-403') {
    return `${lead} TokenScope refused this device's sign-in. Run /tokenscope:setup.`
  }
  return `${lead} TokenScope answered unexpectedly (${reason ?? 'unknown'}).`
}

/**
 * The environment the project check reads: this install's own settings, with
 * only the repo tag's OTEL_RESOURCE_ATTRIBUTES taken from the repo (#503).
 * Claude Code withholds every OTEL_* key from the commands a session runs, so
 * the process env never carries the tag this session emits with. The repo's
 * attributes come from `.claude/settings.local.json` (the plugin's tag), else
 * the committed `.claude/settings.json` (a tag `folderWork` also reports), as
 * Claude Code itself ranks them. Endpoints and credentials never come from
 * either (repoTagEnv takes the attributes alone).
 *
 * @param {Record<string,string>} installEnv
 * @param {string} cwd
 */
export function projectCheckEnv(installEnv, cwd) {
  const root = resolveRepoRoot(cwd) ?? cwd
  const local = readSettingsEnv(join(root, '.claude', 'settings.local.json'))
  const repo = local.OTEL_RESOURCE_ATTRIBUTES ? local : readSettingsEnv(join(root, '.claude', 'settings.json'))
  return repoTagEnv(installEnv, repo)
}

/**
 * Which device this install reports as (#494): the instance its own settings
 * name, shortened the way the Account page shows it. Null when not set up.
 *
 * @param {Record<string,string>} installEnv
 */
export function deviceBlock(installEnv) {
  const id = bearerInstance(installEnv.TOKENSCOPE_BEARER_ENDPOINT) || attrsInstance(installEnv.OTEL_RESOURCE_ATTRIBUTES)
  if (!id) return null
  const short = String(id).slice(0, 8)
  return {
    instance: short,
    message: `This install is device ${short}, as listed on your Account page.`,
  }
}

async function main() {
  // S1 fix 2: compute the safe env ONCE — global settings win for every key
  // global carries, and TOKENSCOPE_STATE_DIR / TOKENSCOPE_API_BASE (which
  // global never writes at all) are deleted outright. Every credential-
  // adjacent read below threads this SAME object through, so there is no
  // second, forgotten call site still reading raw process.env.
  const env = safeProcessEnv()
  const storeDir = claudeInstallStateDir()
  const probe = probeEmissionAuth(env, storeDir)
  const sentinel = readEmitSentinel(env, storeDir)
  const otherLaneFailure = readEmitSentinel(env, trustedStateDir(), 'copilot-cli')
  const mcpAuthed = probeMcpAuth()
  // This install's own attrs and endpoint, as the SessionStart hook passes them:
  // the repo-merged env may name another local install's instance.
  const installEnv = trustedGlobalSettingsEnv()
  const [project, live] = await Promise.all([
    projectBlock(projectCheckEnv(installEnv, process.cwd())),
    probe.emitting ? refreshLanded({ env: installEnv }).catch(() => null) : Promise.resolve(null),
  ])
  // The folder refreshLanded writes to: a pinned TOKENSCOPE_STATE_DIR in the
  // device's own settings, else this install's own.
  const landedDir = (installEnv.TOKENSCOPE_STATE_DIR && String(installEnv.TOKENSCOPE_STATE_DIR).trim()) || storeDir
  const lastLanded = landedReport(live, readLandedCache(landedDir), attrsInstance(installEnv.OTEL_RESOURCE_ATTRIBUTES))
  // Claude Desktop only: its sessions are attributed through the login
  // environment (desktop-env.mjs), so check it carries this device. On Linux
  // the session's own value is readable too, so "set for the next login" is
  // told apart from "in this session".
  const desktopEnv = isTrustedDesktopSession(process.env)
    ? desktopEnvVerdict(
        readDesktopEnv(),
        attrsInstance(trustedGlobalSettingsEnv().OTEL_RESOURCE_ATTRIBUTES),
        sessionDesktopAttrs(),
      )
    : null
  // Which install's settings this report is about (claude-config-dir.mjs).
  const configDir = resolveClaudeConfigDir({ home: realHome() })

  console.log(
    JSON.stringify(
      {
        emitting: probe.emitting,
        probe: {
          status: probe.probe_status,
          message: probe.message,
        },
        device: deviceBlock(installEnv),
        project,
        work: folderWork(process.cwd(), sessionArg(), storeDir),
        last_landed: lastLanded,
        last_failure: sentinel,
        // The Copilot lane's own failure on this host, reported, never merged into
        // this lane's verdict: its fix is a Copilot setup, not a Claude one.
        ...(otherLaneFailure
          ? { copilot_lane_failure: { ...otherLaneFailure, fix: 'Run TokenScope setup in a Copilot CLI session.' } }
          : {}),
        mcp_authed: mcpAuthed,
        settings_file: join(configDir.dir, 'settings.json'),
        ...(configDir.refused
          ? { config_dir_refused: `CLAUDE_CONFIG_DIR is set but was not used (${configDir.refused.reason}).` }
          : {}),
        ...(desktopEnv
          ? {
              desktop_env: {
                verdict: desktopEnv,
                ...(desktopEnv === 'ok'
                  ? {}
                  : desktopEnv === 'next-login'
                    ? { fix: `Setup is done for this computer: ${desktopRestartAdvice()}, and start a new Code session.` }
                    : desktopEnv === 'duplicate'
                      ? { fix: 'This session carries an earlier TokenScope device label as well as this one: restart your computer, then open the Claude app and start a new Code session.' }
                      : { fix: `Run /tokenscope:setup in this Claude app session, then ${desktopRestartAdvice()}.` }),
              },
            }
          : {}),
      },
      null,
      2,
    ),
  )
}

// CLI entry guard so tests can import the pure helpers without running the probe
// (mirrors backfill.mjs).
const isMain = isMainModule(import.meta.url)
if (isMain) {
  main().catch((err) => {
    console.error(
      JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }),
    )
    process.exit(1)
  })
}
