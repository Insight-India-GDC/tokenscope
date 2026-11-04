#!/usr/bin/env node
/*
 * claude-redeem — local helper that redeems a TokenScope emit handoff for a
 * Claude Code device. Called by the tokenscope-setup skill AFTER provision_emit
 * returns a handoff_code + redeem_command. Runs process→server (NOT through the
 * MCP/chat), so the durable emit credential never enters the LLM's context.
 *
 * This is the Claude-Code analogue of copilot-redeem.mjs. The cutover to the
 * MCP-first OAuth client (commit c88228b) deleted the old enrol-time global
 * writer (enrol.mjs + env-builder's buildDeviceEnvBlock) on the premise that
 * `provision_emit → /setup/redeem` would replace it — but only the Copilot
 * redeem helper was ever written, so claude-code lost its global-settings writer
 * entirely. This restores it.
 *
 * Writes (merging, never clobbering):
 *   the install's settings.json, ~/.claude unless a gated CLAUDE_CONFIG_DIR
 *   names another folder (claude-config-dir.mjs) (mode 0600, atomic temp+rename) —
 *     - otelHeadersHelper: the helper COMMAND for this platform, built from a
 *       record by env-builder's buildHelperCommand (the only way to configure
 *       the Azure Monitor Bearer as a refreshing helper). It carries
 *       `--state-dir` when this redeem was given one (#410).
 *     - env: CLAUDE_CODE_ENABLE_TELEMETRY + logs-only OTLP plumbing +
 *       TOKENSCOPE_BEARER_ENDPOINT + TOKENSCOPE_OAUTH_TOKEN_ENDPOINT/_CLIENT_ID +
 *       OTEL_RESOURCE_ATTRIBUTES (tokenscope.instance_id=<sid>,tool=claude-code).
 *       NOT the refresh token: every process Claude Code spawns inherits this
 *       env block, so the durable credential lives only in the 0600 device
 *       store (config.claude-code.json), which the emit helper reads first.
 *   Pre-existing top-level keys other than otelHeadersHelper (e.g. permissions,
 *   statusLine) are always preserved. Same-environment re-runs rotate the credential in place.
 *   When the redeem points at a DIFFERENT deployment than the one currently
 *   configured (the bearer-endpoint host changed — Sandbox→Dev, Dev→Prod), the
 *   env block is REPLACED wholesale instead of additively merged, so stale
 *   credentials and endpoints from the old environment (a now-removed legacy
 *   TOKENSCOPE_SESSION_TOKEN, TOKENSCOPE_READ_*, TOKENSCOPE_OAUTH_*, and the old
 *   TOKENSCOPE_BEARER_ENDPOINT / OTEL_EXPORTER_OTLP_LOGS_ENDPOINT) cannot survive
 *   at rest pointing at the wrong deployment.
 *
 * Usage (prefer the --handoff-code form — a base64url code can begin with `-`,
 * which a bare positional arg would be mis-parsed as a flag):
 *   node claude-redeem.mjs --handoff-code <code> \
 *       [--api-base <base>] [--instance-id <uuid>] [--settings-path <path>]
 *   node claude-redeem.mjs <code>            # positional also accepted
 *
 * EVERY flag is validated before it is used (argv-guard.mjs): the argv of this
 * process is composed by a model under a prefix `allowed-tools` grant, so an
 * unknown flag is refused outright, --settings-path is confined to the account's
 * own home, and --api-base may only SELECT among the origins this device already
 * knows (loopback, the packaged default, the configured `server_url`, the
 * discovered MCP registration).
 * `--redeem-url` was deleted rather than validated: it named the POST target
 * outright, bypassing api-base.mjs entirely, and nothing in the product ever
 * passed it — the `redeem_command` the server builds (server/utils/mcp.ts) sends
 * only --handoff-code and, when it can vouch for its own origin, --api-base.
 *
 * The API base is resolved by api-base.mjs: the configured `server_url`, else a
 * discovered registration, else the packaged default; a loopback
 * TOKENSCOPE_API_BASE overrides them for local dev.
 *
 * Restart `claude` after running — Claude reads its OTel config once at startup.
 */
import { mkdirSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isMainModule } from './is-main.mjs'
import { resolveApiBase, configuredServerUrl, knownApiOrigins } from './api-base.mjs'
import { discoverMcpOrigin } from './mcp-origin.mjs'
import { resolveClaudeConfigDir } from './claude-config-dir.mjs'
import { staleInstall, staleInstallMessage } from './stale-install.mjs'
import {
  acceptApiBaseArg,
  assertConfinedPath,
  assertKnownFlag,
  flagValue,
} from './argv-guard.mjs'
import {
  resolveScriptsDir,
  httpsPostJson,
  realHome,
  trustedStateDir,
  claudeStateDir,
  writeDeviceStore,
  attrsInstance,
  assertStoreConsistent,
  casWriteFile,
  recordSettingsFile,
  recordIsolatedSettingsFile,
} from './plugin-runtime.mjs'
import { mergeClaudeSettings } from './env-builder.mjs'
import { emitEnvLabel } from './statusline.mjs'
import { assertSafeEndpoint, unsafeEndpointError } from './endpoint-guard.mjs'
import { applyDesktopEnv, desktopRestartAdvice, isNearDesktopSession, isTrustedDesktopSession } from './desktop-env.mjs'

// ── arg parsing ──────────────────────────────────────────────────────────────
// STRICT: this process spends a live single-use handoff code, and its argv is
// composed by a model under a prefix (`:*`) allowed-tools grant, so anything the
// documented flow does not produce is refused rather than reinterpreted. See
// argv-guard.mjs for the invariant and why the control has to live here.
// Throws on a bad argv; main() runs inside the top-level catch that prints it.
function parseArgs(argv) {
  const out = {
    handoffCode: null,
    apiBase: null,
    instanceId: null,
    settingsPath: null,
    // Where the shared credential store lives. Defaults to the passwd home
    // (trustedStateDir) in main(); on ARGV so the suite can redirect it without
    // an environment variable — trustedStateDir deliberately ignores those, and
    // that is exactly what stops a hostile repo choosing the destination. Same
    // rationale as the helper's own --state-dir / --tool-dir.
    stateDir: null,
  }
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]
    switch (flag) {
      case '--handoff-code':
        out.handoffCode = flagValue(argv, ++i, flag, { allowLeadingDash: true })
        break
      case '--api-base':
        // Value-checked in main(), where the origins this device knows (the
        // packaged default + the discovered MCP registration) are in hand.
        out.apiBase = flagValue(argv, ++i, flag)
        break
      case '--instance-id':
        out.instanceId = flagValue(argv, ++i, flag)
        break
      case '--state-dir':
        /*
         * CONFINED, exactly like --settings-path.
         *
         * This flag was added so the test suite could redirect the credential
         * store after trustedStateDir() stopped honouring TOKENSCOPE_STATE_DIR.
         * Unconfined it reopened the sink argv-guard exists to close: the setup
         * command's grant ends in `:*`, so a prompt-injected model can append
         * any argv tail with no permission prompt, and this path receives the
         * DURABLE refresh token. argv-guard's invariant is stated in its header —
         * argv may SELECT which file under the account's own home is written, it
         * may never INTRODUCE one — and an unconfined --state-dir is precisely
         * introducing one.
         */
        out.stateDir = assertConfinedPath(flagValue(argv, ++i, flag), { flag, refuseInsideRepo: true })
        break
      case '--settings-path':
        // The emit endpoints and client id are written to this path, so it is a
        // trust sink, not merely a location — confine it to the account's own
        // (passwd, HOME-leak-proof) home, the same anchor main() uses for the
        // default. `settings.json` because that is the file Claude Code reads;
        // this flag exists to point at one, never to name an arbitrary file.
        out.settingsPath = assertConfinedPath(flagValue(argv, ++i, flag), {
          flag,
          allowedBasenames: ['settings.json'],
          // Same sink as --state-dir, and the comment above already says so:
          // this file carries the env block, and the env block carries the
          // durable refresh token. The review cited only --state-dir; home
          // containment is exactly as insufficient here.
          refuseInsideRepo: true,
        })
        break
      default:
        // A stray empty token (Claude can pass an empty $ARGUMENTS) is not an
        // argument at all.
        if (!flag.trim()) break
        assertKnownFlag(flag)
        // Accept a bare positional argument as the handoff code (documented
        // fallback). The canonical invocation uses --handoff-code, which is
        // robust to a base64url code that begins with '-'. A SECOND positional
        // means the argv is not one this flow produces.
        if (out.handoffCode) throw new Error('unexpected extra argument')
        out.handoffCode = flag
    }
  }
  return out
}

// ── env-block builder ─────────────────────────────────────────────────────────
// Mirrors the (deleted) env-builder buildDeviceEnvBlock, EMIT-ONLY: the redeem
// leg ships only the device's durable emit credential — the read+tag credential
// came from the SAME OAuth consent that authorised provision_emit (the MCP grant),
// so no TOKENSCOPE_READ_* keys are written here. Prefer the server-sent bundle
// values; fall back to the documented defaults if a field is absent.
// (assertClaudeRedeemResponse guarantees the attribution-critical fields are
// present before this runs on the real path.) Exported for unit testing.

// Retired credential keys a pre-OAuth/legacy enrolment may have left in
// settings.json. The read credential is gone (read rides the MCP-client OAuth
// bearer); TOKENSCOPE_SESSION_TOKEN is the removed pre-OAuth session token.
// Single source of truth: stripped from the new block (buildClaudeDeviceEnv) AND
// from the merged result (writeClaudeSettings) so they never survive a redeem —
// including a SAME-environment additive merge where the old block is kept.
const RETIRED_ENV_KEYS = [
  'TOKENSCOPE_SESSION_TOKEN',
  'TOKENSCOPE_READ_REFRESH_TOKEN',
  'TOKENSCOPE_READ_CLIENT_ID',
]

/*
 * Kept in the envBlock (the store is written from it) but never in settings.json:
 * that file's env block reaches every hook, Bash command and MCP server Claude
 * Code spawns. Stripping the MERGED result also removes a copy an older redeem
 * left behind.
 */
export const STORE_ONLY_ENV_KEYS = ['TOKENSCOPE_OAUTH_REFRESH_TOKEN']

function buildClaudeDeviceEnv(claude, oauth) {
  if (!claude) return {}
  const env = {
    CLAUDE_CODE_ENABLE_TELEMETRY: '1',
    OTEL_LOGS_EXPORTER: claude.OTEL_LOGS_EXPORTER ?? 'otlp',
    OTEL_METRICS_EXPORTER: claude.OTEL_METRICS_EXPORTER ?? 'none',
    OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: claude.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT ?? '',
    OTEL_EXPORTER_OTLP_LOGS_PROTOCOL: claude.OTEL_EXPORTER_OTLP_LOGS_PROTOCOL ?? 'http/protobuf',
    // Device attrs carry sid + tool only (no project.code_hash — that's per-repo,
    // written by the SessionStart hook into ./.claude/settings.local.json).
    OTEL_RESOURCE_ATTRIBUTES: claude.OTEL_RESOURCE_ATTRIBUTES ?? '',
    // The bearer endpoint the helper presents the OAuth access token to. The
    // claude bundle carries it as otel_headers_helper_url.
    TOKENSCOPE_BEARER_ENDPOINT: claude.otel_headers_helper_url ?? '',
  }
  // The durable OAuth emit credential — only emit these keys when the redeem
  // response carried a COMPLETE block, so a partial/legacy response never writes
  // a half-configured (and thus silently ignored) credential. otel-headers-helper.sh
  // requires all three or it fails loud ("emission auth NOT CONFIGURED").
  if (oauth && oauth.refresh_token && oauth.token_endpoint && oauth.client_id) {
    env.TOKENSCOPE_OAUTH_REFRESH_TOKEN = oauth.refresh_token
    env.TOKENSCOPE_OAUTH_TOKEN_ENDPOINT = oauth.token_endpoint
    env.TOKENSCOPE_OAUTH_CLIENT_ID = oauth.client_id
  }
  // Defence-in-depth: the keys are never SET above, but explicitly strip the
  // retired legacy credentials so this block can never carry them — even if a
  // future change or a copied object reintroduces one. Mirrors tag-repo's
  // `delete deviceEnv.TOKENSCOPE_READ_*` (the read credential is gone — read now
  // rides the MCP-client OAuth bearer) plus the pre-OAuth TOKENSCOPE_SESSION_TOKEN.
  // (writeClaudeSettings also strips these from the MERGED result, covering the
  // same-environment additive-merge case where the old block is preserved.)
  for (const k of RETIRED_ENV_KEYS) delete env[k]
  return env
}

// ── redeem-response validation ─────────────────────────────────────────────────
// Throw a clear Error on any response that would enrol the device into a broken
// state, rather than writing it and printing a false success. Returns
// { claude, oauth } on success. Exported for unit testing.
//
// The OTEL_RESOURCE_ATTRIBUTES check is load-bearing for the project's core
// objective: a bundle missing the instance id would enrol "successfully" yet emit
// telemetry that can never be joined to a teammate (silent unattributable spend).
// otel-headers-helper.sh only validates the bearer/OAuth env, so nothing else
// would catch it.
function assertClaudeRedeemResponse(resp) {
  const claude = resp?.telemetry?.claude
  if (resp?.tool === 'copilot-cli' || (!claude && resp?.telemetry?.copilot)) {
    throw new Error(
      'Redeem returned a Copilot bundle — provision_emit was called with tool=copilot-cli. ' +
        'Use copilot-redeem.mjs, or re-run provision_emit with tool=claude-code.',
    )
  }
  if (!claude || !claude.otel_headers_helper_url || !claude.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT) {
    throw new Error(
      'Redeem did not return a usable Claude Code bundle (bundle=' +
        !!claude +
        ' bearer_endpoint=' +
        !!claude?.otel_headers_helper_url +
        ' logs_endpoint=' +
        !!claude?.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT +
        ').',
    )
  }
  // S1 fix 3 — validate BEFORE persisting a server-supplied bundle: a
  // compromised/MITM'd redeem response could otherwise plant a plaintext or
  // malformed endpoint into settings.json, and every SUBSEQUENT bearer mint
  // (otel-headers-helper.sh, every ~29 min) would then send the real durable
  // credential wherever that endpoint points. Loopback allowed — a
  // locally-running dev server legitimately returns its own loopback address.
  for (const [label, value] of [
    ['otel_headers_helper_url', claude.otel_headers_helper_url],
    ['OTEL_EXPORTER_OTLP_LOGS_ENDPOINT', claude.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT],
  ]) {
    try {
      assertSafeEndpoint(value, { allowLoopback: true })
    } catch (err) {
      // REASON ONLY, never the value — this bundle is SERVER-supplied and the
      // caller prints this message. unsafeEndpointError() enforces that
      // structurally, including dropping the value-bearing `cause` that Node
      // would otherwise print. See endpoint-guard.mjs.
      throw unsafeEndpointError(`Redeem bundle's ${label}`, err)
    }
  }
  // Attribution invariant: the device attrs MUST carry a NON-EMPTY instance id, or
  // every emitted record is unjoinable to the teammate. `tokenscope.instance_id=`
  // with an empty value (e.g. `tokenscope.instance_id=,tool=claude-code`) is just
  // as broken as the key being absent, so require at least one non-delimiter char.
  const attrs = claude.OTEL_RESOURCE_ATTRIBUTES
  if (typeof attrs !== 'string' || !/tokenscope\.instance_id=[^,\s]/.test(attrs)) {
    throw new Error(
      'Redeem bundle is missing a non-empty OTEL_RESOURCE_ATTRIBUTES tokenscope.instance_id — ' +
        'refusing to enrol a device that would emit unattributable telemetry.',
    )
  }
  // The durable OAuth credential must be complete — a partial response (schema
  // mismatch / out-of-date server) would write an emit credential that
  // otel-headers-helper.sh silently treats as NOT CONFIGURED.
  for (const field of ['oauth_refresh_token', 'oauth_token_endpoint', 'oauth_client_id']) {
    if (!resp[field] || typeof resp[field] !== 'string') {
      throw new Error(`Redeem response missing ${field} — server may be out of date.`)
    }
  }
  // S1 fix 3 — same "before persisting" rule for the OAuth token endpoint: the
  // helper POSTs the durable refresh token there every ~29 min.
  try {
    assertSafeEndpoint(resp.oauth_token_endpoint, { allowLoopback: true })
  } catch (err) {
    throw unsafeEndpointError("Redeem response's oauth_token_endpoint", err)
  }
  // The COMPLETE tuple, under the same rule the helper refuses on, BEFORE either
  // file is written. settings.json is persisted first and the store holds the
  // refresh token, so a bundle that fails this check must reach neither.
  // Throws naming the field, never the value.
  assertStoreConsistent(
    'claude-code',
    claudeStoreFields(resp.oauth_refresh_token, {
      tokenEndpoint: resp.oauth_token_endpoint,
      bearerEndpoint: claude.otel_headers_helper_url,
      clientId: resp.oauth_client_id,
      logsEndpoint: claude.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT,
      resourceAttributes: attrs,
    }),
  )
  return {
    claude,
    oauth: {
      refresh_token: resp.oauth_refresh_token,
      token_endpoint: resp.oauth_token_endpoint,
      client_id: resp.oauth_client_id,
    },
  }
}

// ── env-change detection ───────────────────────────────────────────────────────
// URL host of a TOKENSCOPE_BEARER_ENDPOINT, lowercased, or '' if absent/unparseable.
// Reuses the host-derivation idea from statusline.emitEnvLabel: the bearer
// endpoint names the deployment origin, so its host is the stable per-deployment key.
function bearerHost(env) {
  try {
    return new URL((env?.TOKENSCOPE_BEARER_ENDPOINT || '').trim()).host.toLowerCase()
  } catch {
    return ''
  }
}

// Detect whether the redeem points at a DIFFERENT deployment than the one already
// configured, by comparing the bearer-endpoint host of the EXISTING env vs the new
// one. Returns { changed, oldLabel, newLabel }. `changed` is false on a fresh
// device (no existing bearer host) and on a same-host re-run; true only when both
// hosts are present AND differ — the cross-environment transition this guards.
function detectEnvChange(existing, newEnvBlock) {
  const oldHost = bearerHost(existing?.env)
  const newHost = bearerHost(newEnvBlock)
  const changed = Boolean(oldHost) && Boolean(newHost) && oldHost !== newHost
  return {
    changed,
    oldLabel: emitEnvLabel(existing?.env) ?? oldHost ?? null,
    newLabel: emitEnvLabel(newEnvBlock) ?? newHost ?? null,
  }
}

/**
 * The v2 store this lane persists, as one object, so the validator and the
 * writer see the SAME fields. instance_id is the server-sent one in the
 * attributes (fresh from the bundle; migration does the opposite because legacy
 * attributes can be stale).
 */
function claudeStoreFields(oauthRefreshToken, endpoints = {}) {
  const attrs = endpoints.resourceAttributes ?? ''
  return {
    version: 2,
    tool: 'claude-code',
    instance_id: attrsInstance(attrs),
    bearer_endpoint: endpoints.bearerEndpoint ?? '',
    oauth_token_endpoint: endpoints.tokenEndpoint ?? '',
    oauth_client_id: endpoints.clientId ?? '',
    logs_endpoint: endpoints.logsEndpoint ?? '',
    oauth_refresh_token: oauthRefreshToken,
    otel_resource_attributes: attrs,
  }
}

/**
 * Write this lane's own store, `${dir}/config.claude-code.json`, whole.
 *
 * The helper reads it FIRST (source 1 of the ordered list in
 * otel-headers-helper.sh). It is the only place the refresh token is written,
 * so a failure is always fatal. docs/design/device-store-per-tool-sections.md
 */
function writeSharedCredentialStore(oauthRefreshToken, dir, endpoints = {}, helperRecord = undefined) {
  if (!oauthRefreshToken) return
  // Before any write: a store that would be refused is a bad bundle, not an
  // I/O failure. `helper` is the record the
  // settings command was built from, so session start rebuilds the same string
  // (S1, #408).
  const fields = assertStoreConsistent('claude-code', {
    ...claudeStoreFields(oauthRefreshToken, endpoints),
    ...(helperRecord ? { helper: helperRecord } : {}),
  })
  /*
   * A TEST MUST NEVER WRITE THE REAL CREDENTIAL STORE.
   *
   * Not defensive padding — this happened. Switching the store to
   * trustedStateDir() (which correctly ignores TOKENSCOPE_STATE_DIR, so a hostile
   * repo cannot choose where the durable credential lands) also removed the only
   * lever the suite had to redirect it, and a redeem test wrote its stub
   * server's endpoints and fixture refresh token over a live enrolment in the
   * developer's own ~/.tokenscope/config.claude-code.json.
   *
   * Every call site now passes an explicit dir, and this refuses the passwd home
   * under a test runner so the next one that forgets fails loudly instead of
   * silently clobbering someone's credential.
   */
  // realpath BOTH sides: a lexical compare misses a test dir that is a SYMLINK
  // to the real store, which is the same guard-bypass shape as the .gitignore
  // finding. Fall back to the lexical path when the target does not exist yet.
  const canon = (d) => {
    try {
      return realpathSync(d)
    } catch {
      return resolve(d)
    }
  }
  /*
   * `globalThis.__vitest_worker__`, NOT `process.env.VITEST`.
   *
   * The environment is the channel this whole module distrusts: Claude Code
   * merges a repo's `.claude/settings.json` env block into the processes it
   * spawns, so a hostile repo could set VITEST=1 and make a genuine setup run
   * throw here — turning a test-safety guard into a remote switch for "this
   * device may not enrol". The worker global only exists inside a vitest worker
   * and cannot be set from a settings file.
   *
   * RESIDUAL, stated rather than papered over: a spawned CLI is a child process
   * with no such global, so it is NOT covered here. Both suites that spawn this
   * script pass an explicit --state-dir sandbox, but nothing enforces that a
   * future one will. A source-scanning test was tried and removed: file-level
   * matching was vacuous, and per-call matching false-positived on a sibling
   * script's spawns. The real fix is a shared sandboxed spawn helper.
   */
  const underVitest = typeof globalThis.__vitest_worker__ === 'object' && globalThis.__vitest_worker__ !== null
  const realStore = canon(join(realHome(), '.tokenscope'))
  if (underVitest && (canon(dir) === realStore || canon(dir).startsWith(realStore + sep))) {
    throw new Error(
      'refusing to write the REAL credential store from a test — pass an explicit dir',
    )
  }
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    // A COMPLETE store for THIS lane, whole-file. This is its REPLACING writer;
    // migrateStoredEndpoints only ever creates it exclusively.
    // docs/design/device-store-per-tool-sections.md
    writeDeviceStore('claude-code', fields, dir)
  } catch (err) {
    // Always fatal: settings.json no longer carries the credential, so a store
    // that did not land leaves this device with nothing to emit with.
    throw new Error(
      `TokenScope: could not write the device credential store in ${dir}. The emit helper ` +
        'reads the durable credential only from that store, so this device would not emit. ' +
        'Enrolment is NOT complete: make the directory writable (mode 0700) and re-run setup.',
      { cause: err },
    )
  }
}

// ── ~/.claude/settings.json writer ─────────────────────────────────────────────
// Read-merge-write so a developer's pre-existing top-level settings (permissions,
// statusLine) survive; otelHeadersHelper is ours and is rewritten. Never logs
// the env block. Refuses to proceed if an existing settings.json is present but
// unparseable, rather than clobbering it. Writes atomically (temp + rename, 0600)
// so a concurrent `claude` / SessionStart hook never reads a half-written file.
//
// CROSS-ENVIRONMENT TRANSITION: when the existing config points at a DIFFERENT
// deployment (the bearer-endpoint host changed), the env block is REPLACED
// wholesale (replaceEnv) instead of additively merged — otherwise stale
// credentials/endpoints from the old environment would survive at rest pointing at
// the wrong deployment. On a same-environment
// re-run or a fresh device the merge stays ADDITIVE, so an unrelated env key a
// developer set by hand is preserved. Returns the env-change descriptor so main()
// can print a one-line note (never a credential).
/*
 * `credentialStoreDir` is an explicit ARGUMENT, never an environment override:
 * trustedStateDir() ignores TOKENSCOPE_STATE_DIR so a repo cannot choose where
 * the durable credential lands, which also means callers (including tests) must
 * pass the directory rather than steer it. Default keeps production on the
 * passwd home. See epic-mdash-remediation.md (Wave 1, credential-store guard).
 */
/*
 * `helper` is `{ record, scriptsDir }`: mergeClaudeSettings builds the command
 * from it and the store keeps the record. `sessionScoped` (a --settings-path
 * target) lists the file in the state dir so session start can migrate it.
 * When that state dir is not `indexDir` (the trusted default store, the only
 * one session start is sure to read), the file is ALSO indexed there with the
 * state dir it belongs to; otherwise nothing would ever find it again.
 */
function writeClaudeSettings(
  settingsPath,
  helper,
  envBlock,
  credentialStoreDir = trustedStateDir(),
  { sessionScoped = false, indexDir = trustedStateDir() } = {},
) {
  // BEFORE the first persist, so settings.json never receives endpoints the
  // store write would then refuse; main() has already checked the response,
  // this makes the function safe on its own.
  assertStoreConsistent('claude-code', claudeStoreFields(envBlock.TOKENSCOPE_OAUTH_REFRESH_TOKEN, {
    tokenEndpoint: envBlock.TOKENSCOPE_OAUTH_TOKEN_ENDPOINT,
    bearerEndpoint: envBlock.TOKENSCOPE_BEARER_ENDPOINT,
    clientId: envBlock.TOKENSCOPE_OAUTH_CLIENT_ID,
    logsEndpoint: envBlock.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT,
    resourceAttributes: envBlock.OTEL_RESOURCE_ATTRIBUTES,
  }))
  let envChange = null
  // casWriteFile, like every other writer of this file: the render re-derives
  // from the CURRENT bytes on each attempt, so a snapshot taken before a
  // concurrent session-start, toggle or redeem landed is never renamed over it.
  const result = casWriteFile(settingsPath, (raw) => {
    let existing = null
    if (raw !== null) {
      try {
        existing = JSON.parse(raw)
      } catch {
        throw new Error(
          `Existing ${settingsPath} is not valid JSON — refusing to overwrite. Fix or move it, then re-run.`,
        )
      }
    }
    envChange = detectEnvChange(existing, envBlock)
    // Replace the env block ONLY on a detected environment change; an additive merge
    // would leave the old deployment's credentials/endpoints at rest. mergeClaudeSettings
    // preserves top-level non-env keys (permissions, statusLine) in both modes.
    const merged = mergeClaudeSettings(existing, helper, envBlock, {
      replaceEnv: envChange.changed,
    })
    // Strip retired credentials from the MERGED result, not just the new block: on a
    // same-environment re-provision (replaceEnv=false) the additive merge keeps the
    // old env, so a legacy TOKENSCOPE_SESSION_TOKEN/READ_* would otherwise persist at
    // rest. replaceEnv=true already drops them, so this is the same-env safety net.
    if (merged.env) for (const k of [...RETIRED_ENV_KEYS, ...STORE_ONLY_ENV_KEYS]) delete merged.env[k]
    return JSON.stringify(merged, null, 2) + '\n'
  })
  // Persistent contention means the credential did NOT land; success would lie.
  if (result.reason === 'contended') {
    throw new Error(
      `${settingsPath} kept changing while the enrolment was being written — nothing was saved. Re-run setup.`,
    )
  }
  // The refresh token goes to the device credential store and nowhere else.
  // Uses envBlock (the value THIS redeem just minted): merged.env no longer
  // carries it.
  // trustedStateDir(), NOT stateDir(): the latter honours TOKENSCOPE_STATE_DIR
  // from the ambient environment, so running setup inside a hostile repo wrote
  // the DURABLE refresh token into a directory that repo chose. The helper
  // already reads this store from the passwd home, so the two now agree.
  writeSharedCredentialStore(envBlock.TOKENSCOPE_OAUTH_REFRESH_TOKEN, credentialStoreDir, {
    tokenEndpoint: envBlock.TOKENSCOPE_OAUTH_TOKEN_ENDPOINT,
    bearerEndpoint: envBlock.TOKENSCOPE_BEARER_ENDPOINT,
    clientId: envBlock.TOKENSCOPE_OAUTH_CLIENT_ID,
    logsEndpoint: envBlock.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT,
    resourceAttributes: envBlock.OTEL_RESOURCE_ATTRIBUTES,
  }, helper?.record)
  if (sessionScoped) {
    // Best-effort: the enrolment itself is complete. Missing from the list only
    // means a later plugin update will not rebuild this file's helper command.
    try {
      recordSettingsFile('claude-code', credentialStoreDir, settingsPath)
    } catch {
      console.error(
        `[tokenscope] WARN: could not list ${settingsPath} in ${credentialStoreDir}; a plugin update will not migrate its helper command. Re-run setup after updating.`,
      )
    }
    if (canonDir(indexDir) !== canonDir(credentialStoreDir)) {
      // OUTSIDE the best-effort catch: a test that forgets to pass indexDir
      // must fail, not quietly add its fixture paths to the developer's index.
      if (underVitestWorker() && canonDir(indexDir) === canonDir(join(realHome(), '.tokenscope'))) {
        throw new Error('refusing to write the REAL settings index from a test — pass an explicit indexDir')
      }
      try {
        mkdirSync(indexDir, { recursive: true, mode: 0o700 })
        recordIsolatedSettingsFile('claude-code', indexDir, settingsPath, credentialStoreDir)
      } catch {
        console.error(
          `[tokenscope] WARN: could not index ${settingsPath} in ${indexDir}; a plugin update will not migrate its helper command. Re-run setup after updating.`,
        )
      }
    }
  }
  return envChange
}

/** realpath, or the lexical path when it does not exist yet. */
function canonDir(d) {
  try {
    return realpathSync(d)
  } catch {
    return resolve(d)
  }
}

/** Inside a vitest worker (a global no settings file can set; see writeSharedCredentialStore). */
function underVitestWorker() {
  return typeof globalThis.__vitest_worker__ === 'object' && globalThis.__vitest_worker__ !== null
}

// ── main ─────────────────────────────────────────────────────────────────────
async function main() {
  const args = parseArgs(process.argv.slice(2))

  if (!args.handoffCode) {
    console.error(
      '[tokenscope] handoff code is required (pass it as the first argument or via --handoff-code)',
    )
    process.exit(1)
  }

  // #456: a session open across a plugin update still serves the old version's
  // setup text, pointing here. Stop before the handoff is spent, so nothing an
  // older redeem would write (or undo) reaches this install.
  const stale = staleInstall({
    pluginRoot: fileURLToPath(new URL('..', import.meta.url)),
    configDir: resolveClaudeConfigDir({ home: realHome() }).dir,
  })
  if (stale) {
    console.error(staleInstallMessage(stale))
    process.exit(1)
  }

  // Resolve the full redeem URL. A handoff can ONLY be redeemed at the server
  // that minted it, so the base must track wherever the MCP server is actually
  // registered — not the baked default. discoverMcpOrigin reads only files a
  // human wrote at registration time; it returns null on a stock install, where
  // the baked default is right by construction.
  //
  // WHAT DECIDES THE HOST, and what merely selects among them. `setup.md` asks
  // the model to pass only --handoff-code, but that is prose, and the
  // allowed-tools grant it appeals to ends in `:*` — a PREFIX grant under which
  // every argv tail is pre-approved with no prompt. So a prompt-injected model
  // CAN append flags here, and the control is that --api-base is checked
  // against the origins this device already knows (the packaged default, the
  // configured `server_url`, the discovered registration, plus loopback) before
  // it is used: it can select
  // one of them, never introduce one. A value outside that set is warned about
  // and dropped, and resolution continues from local configuration — see
  // argv-guard.mjs for why dropping beats exiting.
  //
  // The ENVIRONMENT is kept out of the same decision for the same reason:
  // Claude Code merges a repository's .claude/settings.local.json env over the
  // global one, so a cloned repo could otherwise nominate the host the live
  // handoff is posted to. resolveApiBase accepts TOKENSCOPE_API_BASE solely
  // when it names loopback, which cannot express that threat, and there is no
  // flag left for a caller to opt back into the hole with.
  const discovered = discoverMcpOrigin(fileURLToPath(new URL('.', import.meta.url)), {
    client: 'claude',
  })
  const configured = configuredServerUrl()
  const apiBase = resolveApiBase(
    acceptApiBaseArg(args.apiBase, {
      allowed: knownApiOrigins({ configured, discovered }),
      warn: (m) => console.error(m),
    }),
    { discovered, configured },
  )
  // The path is FIXED. It used to come from `--redeem-url`, which bypassed all
  // of the above — an absolute value became the POST target verbatim — and which
  // nothing in the product ever passed; that flag is gone, and argv-guard's
  // unknown-flag refusal keeps it gone rather than letting it degrade to
  // "silently ignored", where the VALUE could still land as a stray positional.
  const redeemUrl = `${apiBase}/api/v1/setup/redeem`
  // Not dead: resolveApiBase's guard exempts a LOOPBACK base from its https
  // requirement (the documented dev exception) and therefore does not check the
  // scheme there at all, so a discovered `ftp://127.0.0.1` registration would
  // reach this line. httpsPostJson would refuse it too; failing here names the
  // cause instead of a generic endpoint rejection.
  if (!redeemUrl.startsWith('http')) {
    console.error(
      '[tokenscope] Cannot resolve redeem URL — the API base needs an http(s):// scheme (check the tokenscope MCP server registered in your client config, or pass --api-base).',
    )
    process.exit(1)
  }

  console.log('[tokenscope] Redeeming handoff...')
  const reqBody = { handoff_code: args.handoffCode }
  // Defence-in-depth: bind the redeem to the instance provision_emit returned, so
  // a code can't be redirected onto another device (the server 401s a mismatch).
  if (args.instanceId) reqBody.instance_id = args.instanceId

  let resp
  try {
    // Diagnostic only (mig 0150): this is the FULL setup. The PowerShell redeem
    // for Windows devices without Node sends `emit-only`.
    resp = await httpsPostJson(redeemUrl, reqBody, { headers: { 'X-TokenScope-Setup-Mode': 'full' } })
  } catch (err) {
    console.error(`[tokenscope] Redeem failed: ${err.message}`)
    process.exit(1)
  }

  // Validate the response before writing — do NOT log the raw response (it carries
  // the durable oauth_refresh_token).
  let claude, oauth
  try {
    ;({ claude, oauth } = assertClaudeRedeemResponse(resp))
  } catch (err) {
    console.error(`[tokenscope] ${err.message}`)
    process.exit(1)
  }

  const envBlock = buildClaudeDeviceEnv(claude, oauth)
  // The durable emit credential lands in this file, which makes the path a
  // trust sink and not merely a location. os.homedir() trusts $HOME, so a
  // leaked or planted HOME writes a live refresh token into a directory
  // somebody else chose. Anchor it on the passwd entry, which an env var
  // cannot move.
  //
  // This does mean that under a moved HOME we write somewhere Claude Code --
  // which resolves its own settings through HOME -- will not read, so setup
  // succeeds and emission never starts. That is the right way round: the
  // alternative hands the credential to whoever moved HOME. Say so loudly,
  // because the failure is otherwise invisible, and name both paths so it is
  // fixable rather than merely reported.
  //
  // `--settings-path` is anchored on the SAME home (parseArgs → assertConfinedPath):
  // an override that could name any path at all would have walked straight past
  // this anchor, which is the point of anchoring it.
  const trustedHome = realHome()
  if (!args.settingsPath && trustedHome !== homedir()) {
    console.error(
      `[tokenscope] WARN: $HOME (${homedir()}) differs from your account's real home (${trustedHome}). ` +
        'Writing the credential to the real home; Claude Code reads $HOME, so emission may not start ' +
        'until HOME is corrected.',
    )
  }
  // The config folder of the install running this setup (claude-config-dir.mjs):
  // CLAUDE_CONFIG_DIR when the user's environment set it to a folder of theirs,
  // e.g. Claude Desktop's own install, else ~/.claude on the passwd home.
  const configDir = resolveClaudeConfigDir({ home: trustedHome })
  if (!args.settingsPath && configDir.refused) {
    console.error(
      `[tokenscope] WARN: CLAUDE_CONFIG_DIR is set but was not used (${configDir.refused.reason}); writing ${join(configDir.dir, 'settings.json')} instead.`,
    )
  }
  const settingsPath = args.settingsPath ?? join(configDir.dir, 'settings.json')
  const storeDir = args.stateDir || (args.settingsPath ? trustedStateDir() : claudeStateDir(configDir.dir))
  // The record the helper command is built from. --state-dir rides along so
  // the command mints from the store this redeem wrote, not the default one
  // (#410: without it a session-scoped enrolment minted another identity).
  const recordDir = args.stateDir || (storeDir !== trustedStateDir() ? storeDir : undefined)
  const helper = {
    record: { tool: 'claude-code', platform: process.platform, ...(recordDir ? { stateDir: recordDir } : {}) },
    scriptsDir: resolveScriptsDir(),
  }
  let envChange
  try {
    envChange = writeClaudeSettings(settingsPath, helper, envBlock, storeDir, {
      sessionScoped: Boolean(args.settingsPath),
    })
  } catch (err) {
    console.error(`[tokenscope] ${err.message}`)
    process.exit(1)
  }

  console.log('')
  // Cross-environment transition note (never prints a credential — only env labels).
  // The bearer-endpoint host changed, so the device just moved deployments and the
  // env block was REPLACED with a fresh config (stale old-env creds/endpoints dropped).
  if (envChange?.changed) {
    const from = envChange.oldLabel ?? 'previous'
    const to = envChange.newLabel ?? 'new'
    console.log(`[tokenscope] Environment changed: ${from} → ${to}. Old credentials and endpoints removed.`)
  }
  console.log('[tokenscope] ✓ Tracking is on for Claude Code on this computer.')
  // Claude Desktop only: it replaces the settings-file resource attributes at
  // launch, so this device's attributes also go into the login environment,
  // which it merges (desktop-env.mjs). The CLI path never runs this.
  const desktopLines = desktopSetupStep(resp.instance_id)
  for (const line of desktopLines) console.log(line)
  // In the Claude app the Desktop step owns the restart line (on Linux it is a
  // log out, not a restart); printing both would contradict it.
  if (!desktopLines.some((l) => l.includes('Next:'))) {
    console.log('[tokenscope]   Next: restart Claude Code. Tracking starts in the new session.')
  }
  console.log('[tokenscope]   In a repo with a .tokenscope file, restart once more if you see a "superseded device enrolment" warning.')
  console.log('[tokenscope]   Then, to bill a repo to a project, run the `project` prompt in that repo.')
  console.log(`[tokenscope]   Saved to ${settingsPath} (device ${resp.instance_id}).`)
}

/**
 * Claude Desktop only: the lines setup prints after putting this device in the
 * login environment, or none at all outside the Claude app (the CLI never calls
 * `apply`), including when a project's settings supplied the app's entrypoint.
 * `env`, `apply` and `trusted` are injectable for tests.
 */
function desktopSetupStep(
  instanceId,
  env = process.env,
  apply = applyDesktopEnv,
  trusted = isTrustedDesktopSession,
  platform = process.platform,
) {
  if (isNearDesktopSession(env)) {
    return [`[tokenscope] WARN: CLAUDE_CODE_ENTRYPOINT is "${String(env.CLAUDE_CODE_ENTRYPOINT).trim().slice(0, 40)}", not the Claude app's "claude-desktop"; the Desktop step was skipped.`]
  }
  if (!trusted(env)) return []
  const desktop = apply(instanceId)
  if (!desktop.applied) {
    // Usage is still sent (the settings file is written); only the link to this
    // device is missing, so the restart is still the next step, in the app's words.
    return [
      `[tokenscope] WARN: Desktop sessions will not be attributed: could not set your login environment (${desktop.reason}).`,
      '[tokenscope]   Next: quit the Claude app completely and open it again: usage is sent, but is not linked to you until that is fixed and setup is run again.',
    ]
  }
  const where = desktop.file ? ` (${desktop.file})` : ''
  const next = desktopRestartAdvice(platform)
  return [
    `[tokenscope] ✓ Claude Desktop: this device is set in your login environment${where}, so Desktop sessions are attributed.`,
    `[tokenscope]   Next: ${next.charAt(0).toUpperCase()}${next.slice(1)}. Tracking starts in the new session.`,
  ]
}

// Only run main() when executed directly (not when imported as a module for testing).
if (isMainModule(import.meta.url)) {
  main().catch((err) => {
    console.error('[tokenscope] Fatal:', err.message)
    process.exit(1)
  })
}

// Named exports for unit testing only — not part of the public API.
export {
  buildClaudeDeviceEnv,
  assertClaudeRedeemResponse,
  writeClaudeSettings,
  writeSharedCredentialStore,
  parseArgs,
  desktopSetupStep,
}
