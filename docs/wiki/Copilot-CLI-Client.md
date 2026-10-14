# Copilot CLI Client

Built spec for **TokenScope maintainers**: how the GitHub Copilot client is
wired — the `copilot-plugin/` package, the **usage extension** that emits token
usage from Copilot CLI and the Copilot App, and the provisioning flow that makes
a developer's Copilot sessions emit attributable token spend to Azure Monitor.
This is the as-built mechanism.

See also: [Architecture](Architecture.md) · [Claude Code Client](Claude-Code-Client.md) ·
[API Reference](API-Reference.md) · [Data Flow](Data-Flow.md).

> **Telemetry-priced Copilot spend is indicative (tier-2 / telemetry-only).** It
> is priced from the emitted AI-credit value (1 credit = $0.01 USD). The
> reconciled Copilot figures come from GitHub's own APIs on the provider lane
> (`reconciliation-sync`, `copilot-pool-bill`); see [Data Flow](Data-Flow.md).

---

## The usage extension (the live emitter)

`copilot-plugin/extensions/tokenscope-usage/extension.mjs` is loaded by the
Copilot runtime: the **Copilot App** always, and the **terminal CLI** when
Copilot's `EXTENSIONS` feature is on (setup turns it on). The extension file is
wiring only; the logic is `copilot-plugin/scripts/copilot-usage.mjs`. It registers no hooks,
tools or permission handlers, so the runtime never asks for an
extension-permission grant.

1. It joins the session and receives the runtime's typed events. Each
   **`assistant.usage`** event becomes one `api_request` OTLP log record: a
   hashed provider call id as `request_id`, `model`, Copilot's `session.id`, the
   four token counts, `query_source`, and `github.copilot.nano_aiu` (Copilot's
   own cost, used for pricing). Token counts and ids only, never content.
2. `query_source` is `main` for conversation turns (the agent and its
   subagents) and the interaction type otherwise (e.g. compaction), the same wire
   attribute Claude emits, so the server-side overhead detector works for both.
3. Behavioural signals (context saturation from `session.usage_info`, turn and
   MCP-call counts at `session.idle`) ride a separate, non-billing
   `usage_signal` record with no token attributes, so the billing reader never
   sees them.
4. Every record is **spooled (0600) under `~/.tokenscope/copilot-usage-spool/`
   before any send**, so a crash or a failed POST loses nothing. Records are sent
   on a debounce, on `session.idle` and on close. Spool files belong to a random
   per-process writer id with a 30 s heartbeat (`~/.tokenscope` can be shared by
   a host and its containers, whose pid namespaces differ); a writer silent past
   the stale threshold is dead and its files are adopted. Spooled records older
   than 7 days are dropped.
5. Sending goes through `copilot-plugin/scripts/copilot-emit.mjs`: the per-tool credential
   store, the bearer mint (`otel-headers-helper.sh`, or `otel-headers-helper.ps1`
   on Windows) and a guarded HTTPS POST of OTLP-logs **protobuf** to the Azure
   Monitor DCE.
6. A per-checkpoint comparison of Copilot's own cost total against the recorded
   calls writes a **drift** verdict under `~/.tokenscope/copilot-usage-drift/`,
   which the `status` skill reports.

Each batch carries resource attributes `tokenscope.instance_id`,
`tool=copilot-cli`, `copilot.surface` (`cli` or `app`),
`tokenscope.emitter=extension`, and, when resolved, `project.code_hash` and
`github.org`.

**Windows.** Copilot CLI and the Copilot App on Windows are supported. CI runs
the plugin unit suite on `windows-latest` under Windows PowerShell 5.1,
including the PowerShell helper conformance and the usage-extension Windows
tests; a few files not yet Windows-ready are excluded by name. Nothing
extra is installed: setup (`copilot-redeem.mjs`) and the extension run in
Copilot's own Node, and the bearer mint runs the PowerShell twin of the helper
under the Windows PowerShell 5.1 that ships with Windows, as
`<SystemRoot>\System32\WindowsPowerShell\v1.0\powershell.exe -NoProfile
-NonInteractive -ExecutionPolicy Bypass -File otel-headers-helper.ps1 --state-dir
<dir> --tool copilot-cli`. No admin rights are needed: `-ExecutionPolicy Bypass`
applies to that one process (a Group Policy execution policy overrides it, and on
such a machine the mint fails and `status` shows emission failing). `powershell.exe` is never resolved through `PATH`:
`C:\Windows` is tried first and `%SystemRoot%` only when it has the
`<drive>:\Windows` shape, because the environment is not trusted; the reasoning
is in `copilot-plugin/scripts/emit-helper-spawn.mjs`, the one module every
helper spawn (mint, status probe, Claude-lane probe and backfill) goes through.
The `status` skill's emission probe uses the same spawn.

**Https-only egress.** Every credential-bearing call routes through the same
`assertSafeEndpoint()` validator the Claude lane uses: the file is vendored
verbatim into `copilot-plugin/scripts/endpoint-guard.mjs` by the sync script
rather than reimplemented, so the two lanes cannot drift. Off-box plaintext is
refused; loopback is exempt only where a caller explicitly opts in.

---

## Attribution identity

| What | Where it comes from | Why |
|---|---|---|
| `instance_id` (teammate binding) | `~/.tokenscope/config.copilot-cli.json` (minted by `provision_emit`), read at send time | Written by the local redeem helper, never taken from an event or the spool. On the wire it is a claim the server resolves against the authenticated enrolment |
| session (grouping) | Copilot's `session.id` | Copilot's own session id |
| `project.code_hash` (project claim) | Per session, from the `.tokenscope` of the session's working directory, via the shared `resolveRepoProjectCode` + `computeCodeHash` | The SAME resolver Claude Code uses, so both hash an identical repo to the same value. No `.tokenscope` → untagged |
| `github.org` (+ mirrored `github.repository`) | The project's git remote (`remote.origin.url`) | For org→enterprise keying. Lowercased org; omitted when unknown. Not an identity factor |
| `tool` | always `copilot-cli` | Fixed — not controllable by the Copilot client |

> **Attribution is split by concern.** `instance_id` and the emit endpoints come
> from `~/.tokenscope/config.copilot-cli.json`, never from process env. The
> `project.code_hash` is a **different axis**: it comes from the project being
> worked in, not from config. Nothing is exported into the shell, so a plain
> `copilot` works alongside Claude Code with no per-tool OTel env. The Claude
> lane keeps its own `config.claude-code.json`; neither lane reads or writes the
> other's.

---

## Provisioning flow

```
Developer runs the tokenscope-setup skill
         │
         ▼
provision_emit { tool: 'copilot-cli' }   (MCP tool, OAuth-scoped)
         │
         ├─ locates/creates instance_attestation (tool='copilot-cli')
         └─ returns: handoff_code + redeem URL + CopilotBundle
                      │
                      ▼
   node copilot-redeem.mjs <handoff_code>   (runs locally)
         │
         ├─ POST /api/v1/setup/redeem { handoff_code }
         │  ← response: instance_id, bearer_endpoint, oauth_token_endpoint,
         │              logs_endpoint, OAuth emit credential
         │
         ├─ write ~/.tokenscope/config.copilot-cli.json  (durable emit credential + endpoints)
         ├─ enable enabledFeatureFlags.EXTENSIONS + extensions.mode load_only in Copilot's
         │  settings.json (merged into plain JSON; otherwise the user is told what to change)
         └─ remove the forwarder's per-project files and any shell-rc block an earlier setup wrote
```

After setup, **start a new `copilot` session** so the extension loads, then run
the `status` skill.

**Emit-on-install** (`copilot-plugin/scripts/enroll.mjs`, run by the
SessionStart hook) is the no-human alternative: with a bundled enrolment secret
it POSTs `/api/v1/setup/enroll` and creates `config.copilot-cli.json`
**exclusively**. It is a no-op whenever that file already exists, in any shape —
a complete one is `already-enrolled`, an incomplete or corrupt one is
`own-store-incomplete` and is repaired only by the manual redeem, never by
re-enrolling.

### What the setup skill may hand the redeem helper

Copilot CLI has no `allowed-tools` mechanism, so the argv of
`copilot-redeem.mjs` is whatever the model wrote, and the process it starts
spends a live single-use handoff code. The validation therefore sits in the
helper, in the shared `argv-guard.mjs` vendored from `plugin/scripts/`:

- An **unknown `--flag` refuses the whole argv**, and a flag missing its value is
  refused rather than reinterpreted as the next token. A second bare positional
  is refused too.
- **`--api-base` may only select an origin this device already knows**: loopback,
  or whatever discovery returns — the user-scope MCP registration
  (`~/.copilot/mcp-config.json` first, then the Claude CLI's own user config),
  falling back to the plugin's bundled `.mcp.json`. A **repo-local** `.mcp.json`
  is deliberately not a candidate, for the same reason `TOKENSCOPE_API_BASE` is
  not. Anything else is warned about and dropped. No flag names the POST target:
  the path is fixed at `/api/v1/setup/redeem` on the resolved base.
- **`--shell-rc` is confined** to the user's own home — compared on real,
  symlink-resolved paths — and to the shell init filenames the no-flag default
  already considers. Setup only removes its own old block from that file, but it
  still rewrites a file every future shell executes.

The skill needs this host's existing `instance_id` so a re-run rotates the
device instead of minting a duplicate, and that id sits next to the durable
refresh token. It therefore asks `scripts/device-id.mjs --tool copilot-cli`,
which reads the store out of process and prints only
`{enrolled, tool, instance_id, bearer_host, reason}`. `--tool` is load-bearing:
it can never hand back the Claude Code id on a host running both, and
provisioning the other tool's id would revoke that tool's credential.

---

## Server-side pricing (Copilot-only)

The read joiner (`server/workers/azure-monitor-reader.ts`) detects
`tool='copilot-cli'` and bypasses the token rate-card path:

```
cost_usd = (nano_aiu / 1e9) × COPILOT_AI_CREDIT_USD   // COPILOT_AI_CREDIT_USD = 0.01
```

- Priced once on the `input` token-type record; output/cache records get `cost_usd = 0`.
- `rateCardId` / `rateCardVersion` are `NULL` for Copilot rows.
- `fidelityTier = 'tier-2'`, `costBasis = 'telemetry-only'` (indicative).

---

## Plugin package (`copilot-plugin/`)

```
copilot-plugin/
  plugin.json                     manifest (version)
  .mcp.json                       MCP server → <host>/api/v1/mcp (a literal URL)
  extensions/tokenscope-usage/extension.mjs   the usage extension (wiring only)
  hooks/hooks.json                SessionStart (enrol + file forwarder) + Stop (forwarder flush)
  hooks/forwarder-lifecycle.mjs   hook driver
  scripts/copilot-usage.mjs       usage-extension core (event → record, spool, heartbeat, drift)
  scripts/copilot-emit.mjs        credential store, bearer mint, guarded POST
  scripts/otlp-logs.mjs           OTLP-logs record + protobuf encoding
  scripts/copilot-redeem.mjs      local redeem helper (setup)
  scripts/enroll.mjs              emit-on-install enrolment
  scripts/device-store.mjs        per-tool credential store
  scripts/device-id.mjs           credential-free device identity
  scripts/status.mjs              emission / landed / managed-telemetry probe (status skill)
  scripts/landed-check.mjs        did a record land? (/instances/{id}/health)
  scripts/managed-telemetry.mjs   enterprise-managed telemetry-setting detector
  scripts/argv-guard.mjs          redeem-argv validator
  scripts/endpoint-guard.mjs      https-only endpoint validator
  scripts/copilot-forwarder.mjs   file forwarder (see below)
  scripts/...                     shared helpers (mcp-origin, real-home, trusted-git, …)
  skills/tokenscope-setup/SKILL.md   connect + provision
  skills/project/SKILL.md            bind this repo to a project (.tokenscope)
  skills/usage/SKILL.md              month-to-date usage
  skills/status/SKILL.md             is this device emitting, landing and attributing?
```

Most of `scripts/` is vendored verbatim from `plugin/scripts/` by
`npm run sync:copilot-plugin`; `npm run check:copilot-plugin-sync` fails when a
copy is stale. The skills reuse the same MCP tools (`provision_emit`,
`my_usage`, `list_my_projects`, `resolve_repo_project`, `tag_session`) as the
Claude Code prompts; `tokenscope-setup` passes `tool: 'copilot-cli'` to
`provision_emit`.

### Enterprise-managed `telemetry` detection

GitHub Copilot CLI honours an enterprise-managed `telemetry` setting
(`managed-settings.json` — file-based / native-MDM / server-managed) that can
disable or reroute telemetry **while a valid TokenScope credential still mints a
healthy bearer**. `copilot-plugin/scripts/managed-telemetry.mjs` checks every locally-readable
channel (the per-OS file path; best-effort Windows registry / macOS managed
preferences) and classifies `hostile` / `benign` / `none` / `unknown`, never
printing header/endpoint values and never guessing at server-managed settings
(not locally readable). `copilot-plugin/scripts/status.mjs` reports it as `emission_healthy`
(distinct from `emitting`: `true` only when the credential is valid AND no
hostile setting was found), and `copilot-plugin/scripts/enroll.mjs` runs it as a best-effort
post-enrol check.

---

## Distribution

The plugin ships from the repository's `.claude-plugin/marketplace.json`
(entry `tokenscope-copilot`, source `./copilot-plugin`). Its API host is baked
into `copilot-plugin/.mcp.json` and `copilot-plugin/scripts/enroll.mjs`, so a
self-hosted deployment needs its own copy — see "Installing for your own
deployment" below.

**Individual/Pro (manual):** about 5 minutes, once per computer.

1. **Install the plugin.** In a terminal, run these one at a time:

   ```bash
   copilot plugin marketplace add <owner>/<repo>
   copilot plugin install tokenscope-copilot@tokenscope
   ```

2. **Sign in and turn on tracking.** Start `copilot`, type `/` and run the
   `tokenscope-setup` skill. Approve the sign-in in your browser.
3. **Restart `copilot`.**
4. **Check it works.** After a few minutes of use, run the `status` skill. Green
   means you're done.

Why: the usage extension loads only when a session starts, hence the restart.
Copilot CLI has no always-on status line, so the `status` skill is the check: it
confirms emitting, landing and attribution, and reports
`usage_capture.enabled: false` when the extension would not load. Ingestion
takes ~4–5 min.

**Enterprise-managed (Business/Enterprise):** in your organisation's
<!-- docs-check: ignore (a path in your organisation's repository, not this one) -->
`.github-private` repository, add `.github/copilot/settings.json` naming your
repository as a known marketplace and enabling the plugin, for example:

```json
{
  "copilot": {
    "chat": {
      "plugins": {
        "extraKnownMarketplaces": [
          {
            "name": "TokenScope",
            "url": "https://github.com/<owner>/<repo>",
            "description": "TokenScope — attribute Copilot token spend to projects."
          }
        ],
        "enabledPlugins": [
          { "source": "<owner>/<repo>", "path": "copilot-plugin" }
        ]
      }
    }
  }
}
```

The published version is declared in both `copilot-plugin/plugin.json` and the
repo-root `.claude-plugin/marketplace.json`; read it from there. An installed
copy is cached by version and replaced only when the number **increases** — a
fix that ships without a bump reaches no enrolled device. CI fails a
plugin-code change with no version bump.

### Installing for your own deployment

The API base is baked per deployment, by design: an off-box
`TOKENSCOPE_API_BASE` is ignored (only loopback is honoured, for local dev),
because a cloned repository can set it. Either:

1. **Fork and set your host (recommended).** Set `https://<your-host>` in
   `copilot-plugin/.mcp.json` (a literal URL: Copilot does not expand `${VAR}`),
   `copilot-plugin/scripts/enroll.mjs` (`DEFAULT_API_BASE`) and
   `shared/connect.ts` (`COPILOT_PLUGIN_BUNDLED_ORIGIN`). If you also ship the Claude Code
   plugin with that default, set it in `plugin/scripts/api-base.mjs`
   (`DEFAULT_API_BASE`), `plugin/.claude-plugin/plugin.json`
   (`userConfig.server_url.default`) and `shared/connect.ts`
   (`CLAUDE_PLUGIN_DEFAULT_ORIGIN`); Claude Code users can instead set the
   plugin's server URL themselves (see the Claude Code Client page).
   Run `npm run sync:copilot-plugin` and `npm run check:copilot-plugin-sync`
   (it fails if the hosts disagree), bump the plugin versions
   (`copilot-plugin/plugin.json`, `plugin/.claude-plugin/plugin.json` and both
   entries in `.claude-plugin/marketplace.json`), and have developers add your
   fork as the marketplace.
2. **Register the MCP server yourself** in `~/.copilot/mcp-config.json`
   (`copilot-plugin/.mcp.json` notes the form
   `copilot mcp add --transport http tokenscope https://<your-host>/api/v1/mcp`).
   The redeem helper discovers that registration ahead of the bundled one.
   Emit-on-install still targets the baked host, so a fork is the complete
   option.

---

## File forwarder (due to be removed)

The plugin also carries a per-project **file forwarder**
(`copilot-plugin/scripts/copilot-forwarder.mjs`, started by the SessionStart hook): Copilot CLI
writes spans to a file named by `COPILOT_OTEL_FILE_EXPORTER_PATH`, and the
forwarder transcodes `chat` spans into the same `api_request` records and sends
them.

**Which lane sends a session** is decided by whether Copilot's `EXTENSIONS`
feature is on (read from Copilot's `settings.json`). On: the extension sends
every session and the forwarder idles; setup removes the forwarder's per-project
files when it turns the feature on. Off: no extension loads in the CLI and the forwarder runs for
sessions from a terminal that still exports the span variable. If a session
still has that variable while extensions are off, the extension records only
what it *would* send (shadow mode). A call is never sent by both lanes.

---

## Not covered

- **VS Code Copilot Chat** — the usage extension runs in Copilot CLI and the
  Copilot App; the plugin does not capture VS Code.
- **Per-span project resolution for multi-repo sessions** — a session is tagged
  from the `.tokenscope` of its working directory only.
- **A server-side OTLP-receive route** is not planned: clients send straight to
  Azure Monitor.
