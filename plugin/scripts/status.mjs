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
import { degradedExpiryNote, readEmitDegraded, readEmitSentinel, runEmitHelper, safeProcessEnv, trustedGlobalSettingsEnv, trustedStateDir } from './plugin-runtime.mjs'
import { checkRepoProjectBillable } from './project-check.mjs'
import { isMcpAuthed, probeMcpAuth } from './claude-credentials.mjs'
import { desktopEnvVerdict, desktopRestartAdvice, isTrustedDesktopSession, readDesktopEnv, sessionDesktopAttrs } from './desktop-env.mjs'
import { resolveClaudeConfigDir } from './claude-config-dir.mjs'
import { realHome } from './real-home.mjs'
import { join } from 'node:path'
import { attrsInstance } from './device-store.mjs'

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
      message:
        'OK: this computer can send usage to TokenScope. This checks the credential only; it cannot see whether your usage has arrived.',
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
export function probeEmissionAuth(env) {
  const endpoint = (env.TOKENSCOPE_BEARER_ENDPOINT ?? '').trim()
  const hasOAuth = Boolean(
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
  const { ran, status, hasAuth } = runEmitHelper({ env })
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
    // The helper writes where runEmitHelper pinned it — trustedStateDir() — so
    // read back from there. stateDir() honours a live TOKENSCOPE_STATE_DIR (which
    // safeProcessEnv only strips from its copy), and reading through it missed
    // the marker and reported "Emission auth OK" during an outage.
    sentinel: readEmitSentinel(env, trustedStateDir()),
    degraded: readEmitDegraded(env, trustedStateDir()),
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
  return {
    code: null,
    billable: null,
    message: 'Project-tag billability unverified (offline, or emit not yet authed).',
  }
}

async function main() {
  // S1 fix 2: compute the safe env ONCE — global settings win for every key
  // global carries, and TOKENSCOPE_STATE_DIR / TOKENSCOPE_API_BASE (which
  // global never writes at all) are deleted outright. Every credential-
  // adjacent read below threads this SAME object through, so there is no
  // second, forgotten call site still reading raw process.env.
  const env = safeProcessEnv()
  const probe = probeEmissionAuth(env)
  const sentinel = readEmitSentinel(env, trustedStateDir())
  const otherLaneFailure = readEmitSentinel(env, trustedStateDir(), 'copilot-cli')
  const mcpAuthed = probeMcpAuth()
  const project = await projectBlock(env)
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
        project,
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
