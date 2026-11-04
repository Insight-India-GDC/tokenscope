# Claude Code Client

Built spec for **TokenScope maintainers**: how the Claude Code client is wired —
the marketplace plugin plus the telemetry contract that makes a developer's
`claude` sessions emit attributable token usage to Azure Monitor. This is the
as-built mechanism, not an end-user tutorial.

See also: [Architecture](Architecture.md) · [API Reference](API-Reference.md).

Device onboarding is an MCP OAuth flow: connect the MCP (one browser consent),
then run the `tokenscope-setup` prompt, which provisions emitting via a
secret-isolating handoff (`provision_emit` → `/api/v1/setup/redeem`).

## Where it works

| Surface | Supported | How usage arrives |
| --- | --- | --- |
| Claude Code CLI — macOS, Linux, WSL, containers | Yes | Telemetry via `otel-headers-helper.sh` (`sh` + `curl`); setup needs Node |
| Claude Code CLI — Windows | Yes | Telemetry via `otel-headers-helper.ps1` (Windows PowerShell 5.1); setup with Node, or emit-only via PowerShell |
| Claude Desktop **Code tab** (local sessions) — macOS, Windows | Yes | Same settings, plugin and helper as the CLI on that OS |
| Claude Code in VS Code / JetBrains | Yes (same engine and settings) | As the CLI on that OS |
| Claude Desktop Code tab **WSL / cloud** sessions; claude.ai/code | No plugin | Anthropic Analytics API `claude_code` lane: per user, per day, untagged |
| Claude Desktop chat, Cowork, claude.ai, Chrome, Office, Slack | No plugin | Anthropic Analytics API: per user, per day, per surface; billing only, never tagged |

The helper is chosen per platform at setup and again at every session start
(`buildHelperCommand` in `plugin/scripts/env-builder.mjs`); both helpers read and
write the same files, so a device moves between them without re-enrolling. Why
two native helpers rather than one runtime: [ADR-0015](Design-Decisions.md#adr-0015--native-client-runtime-per-os) (client runtime native per OS).
Copilot's equivalent table is in [Copilot CLI Client](Copilot-CLI-Client.md).

## Connect + emission flow

Two distinct developer actions: **connect + provision the device once** (one
OAuth consent → global config), then **tag each repo** with a committed
`.tokenscope` file. Identity is anchored to the device attestation (by
`tokenscope.instance_id` / DEVICE_SID, minted by `provision_emit`); the
**project** is an emitted per-event claim, membership-gated at join (see
[ADR-0004](Design-Decisions.md#adr-0004--attribution-trust-model)).

![One consent connects the device, a local helper redeems the emit credential outside the chat, and a committed .tokenscope file tags the repo on a later launch](images/claude-code-client-onboarding.svg)

1. `/mcp` opens a browser consent at `/api/v1/oauth/authorize`. The PKCE exchange at `/api/v1/oauth/token` gives the MCP client a `tokenscope.read` + `tag` token, and the MCP tools start working.
2. The `tokenscope-setup` prompt calls `provision_emit`. It locates or creates this device's `instance_attestation` and returns a single-use handoff code that expires in about five minutes. The code passes through the chat; the durable credential never does.
3. The agent runs the redeem helper for its lane (see [Setup lanes](#setup-lanes-node-or-powershell-on-windows)): `plugin/scripts/claude-redeem.mjs`, or `claude-redeem.ps1` on Windows without Node. It POSTs the code to `/api/v1/setup/redeem`. The response carries `instance_id`, `bearer_endpoint`, the durable `tokenscope.emit` refresh token and `telemetry.claude`. The script writes them to the install's `settings.json` (`~/.claude`, or the install's own `CLAUDE_CONFIG_DIR` when it passes the gate in `plugin/scripts/claude-config-dir.mjs`) and to the device store `~/.tokenscope/config.claude-code.json`.
4. The `project` prompt writes a one-line `.tokenscope` file holding the project code; the developer commits it. The plugin's `SessionStart` hook reads it, computes `sha256(code)` and writes `OTEL_RESOURCE_ATTRIBUTES` (a local `tokenscope.instance_id`, `project.code_hash`, `tool`, plus `tokenscope.activity` when the folder sets a default activity in that same file's `tokenscope.activity`) into the repo's gitignored `.claude/settings.local.json`. `/tokenscope:activity` tags the running session itself. The hook writes no helper, endpoint or credential there (see [Project tag in the repo file](#project-tag-in-the-repo-file)).
5. Claude Code reads its settings once, at startup. The session in which the hook writes the repo file still emits under the old attributes; the next launch carries the project claim.
6. Claude Code gets its export headers from the headers helper for its OS (`otel-headers-helper.sh` on POSIX, `otel-headers-helper.ps1` on Windows; [ADR-0015](Design-Decisions.md#adr-0015--native-client-runtime-per-os)). It trades the refresh token for a `tokenscope.emit` access token and calls `GET /api/v1/instances/{id}/bearer`, which returns an Azure Monitor token minted from the app's managed identity.
7. Claude Code sends OTLP `api_request` log events, with that bearer, to the data collection endpoint. The DCR lands them in `OTelLogs`.
8. The read joiner (`azure-monitor-read`) queries `OTelLogs` by `tokenscope.instance_id`. It takes the teammate from `instance_attestation` and bills the project only if that teammate is a current member; otherwise the spend stays untagged and an `attribution-spill-unauthorized` audit event is written.
9. The `SessionStart` hook also reports which install the session runs on (`POST /api/v1/instances/{instanceId}/claude-sessions`, with that install's own credential). A tagged repo's file names one instance for every install that opens it, so when the Claude Code CLI and the Claude app share a repo, the joiner books each session to the install that reported it, provided it is the same teammate's.

*The model sees the handoff code and nothing durable: the emit credential travels only between `claude-redeem.mjs` and the server.*

- **One consent authenticates AND provisions.** Connecting the MCP runs the
  browser PKCE consent (read + tag). The `tokenscope-setup` prompt then calls the
  read-scoped `provision_emit` tool, which locates-or-creates this device's
  `instance_attestation` and returns a **short-TTL one-time handoff code** — never
  the durable emit credential. A local helper redeems that handoff
  process→server at `/api/v1/setup/redeem` for the durable OAuth emit credential +
  the OTel bundle, and writes the **global** `~/.claude/settings.json`. The
  durable secret never enters the LLM's context (the secret-isolating handoff;
  the single audited read→emit crossing, [ADR-0005](Design-Decisions.md#adr-0005--durable-emission-credentials-and-revocation) E1).
- **Per-repo project travels with the repo.** Each repo commits a `.tokenscope`
  file (the project code), which the `project` MCP prompt writes. The
  `SessionStart` hook resolves it and writes `project.code_hash = sha256(code)`
  (with the DEVICE_SID) into the **repo-local** settings, so the project rides
  along with the repo across every ephemeral session — no per-repo token, no
  re-provision. The repo-local block carries the resource attributes only:
  **not the helper, the endpoints or the
  telemetry-enabling keys** (they apply from the install's own settings; see "Project tag in the
  repo file" below) **and not the durable OAuth refresh token** — the emit helper reads
  that from the device's own store first (`~/.tokenscope/config.claude-code.json`:
  0600 in a 0700 dir on POSIX, the profile's own ACL on Windows;
  `~/.claude/settings.json` only while no store exists), so
  the durable credential is not planted in every tagged working tree.
- **Membership-gated attribution.** The joiner resolves the **teammate from the
  attestation by DEVICE_SID** (the stored binding is authenticated; the
  DEVICE_SID on each event is a claim anyone with ingest access can set) and takes the **project
  from the emitted `code_hash` claim**, billing it only if that teammate is a
  _current_ member of the project; otherwise the spend spills to untagged + an
  `attribution-spill-unauthorized` audit ([ADR-0004](Design-Decisions.md#adr-0004--attribution-trust-model)).
- **Untagged-first.** A device with no repo `.tokenscope` (or an
  unrecognised/unauthorised code) emits without a `project.code_hash` claim, so it
  surfaces in the web **untagged-spend** card. Assign it to a project later via
  the untagged-spend quick-assign picker (`POST /api/v1/me/sessions/[sid]/assign`).
- The **OAuth `tokenscope.emit` access token is the bearer-helper credential**
  (minted by the helper via the refresh-token grant), not a static OTLP header —
  Azure rejects the TokenScope token directly.

### Setup lanes: Node, or PowerShell on Windows

`/tokenscope:setup` starts with a runtime check (step 0) before the OAuth consent,
so a device that cannot finish setup stops before `provision_emit` spends a
handoff code. It runs `node device-id.mjs`, which also reports `platform` and the
`node` version.

| Device | Lane | Setup helpers | What works |
| --- | --- | --- | --- |
| Node on PATH (any OS) | Node | `device-id.mjs`, `claude-redeem.mjs` | Everything |
| macOS, Linux, WSL, container, no Node | none | — | Setup stops at step 0 and names the install line: `sudo apt-get install -y nodejs`, `brew install node`, or Node in the container image |
| Windows, no Node | PowerShell (emit-only) | `device-id.ps1`, `claude-redeem.ps1` (Windows PowerShell 5.1, ships with Windows) | Emitting, and the MCP tools (tagging, `my_usage`). Not the status line, `/tokenscope:backfill`, the repo pin from `.tokenscope`, or the session-start self-heal; `/tokenscope:status` uses its PowerShell probe. The emit helper runs from a snapshot copied to `<state>\helper\scripts\` at setup: it survives a plugin update but is not refreshed by one, so re-run setup after updating (once Node is installed the self-heal moves the command onto the active install) |

On the PowerShell lane setup tells the user what emit-only means before the
consent, and the redeem's own output repeats it with the way out:
`winget install OpenJS.NodeJS.LTS`, then re-run setup.

The setup and status commands start Windows PowerShell by its absolute path,
`C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe`, never a bare
`powershell.exe`: the redeem carries the one-time handoff code in argv, and the
model runs it with the session's environment, where a repository can set `PATH`.
The forward-slash, unquoted form runs verbatim in both Git Bash and the
PowerShell tool. On a Windows installed on another drive the model substitutes
that drive letter (`$env:SystemRoot`).

`claude-redeem.ps1` is a port of `claude-redeem.mjs`, not a reduced version. It
takes the same arguments under the same argv rules (unknown flags refused,
`--api-base` may only select a known origin, `--settings-path` / `--state-dir`
confined to the profile and refused inside a git repository), writes the same
v2 store and the same `settings.json` merge (refuses non-JSON, keeps unrelated
keys, replaces the env block on a cross-environment move), and records
`--settings-path` targets the same way. The differences are the platform in the
helper record (`win32`, so `otelHeadersHelper` is the
`"<absolute>\powershell.exe" … -File otel-headers-helper.ps1` command) and the `X-TokenScope-Setup-Mode: emit-only`
header, which the server stores beside the device for diagnostics only.
`tests/unit/plugin/claude-redeem-ps1.test.ts` runs both redeems on the same
fixtures and compares the files they write byte for byte.

One divergence is deliberate: the Node redeem resolves symlinks before its
profile-containment check, while Windows PowerShell 5.1 cannot resolve a
junction's target, so the PowerShell redeem refuses any link below the profile
in a `--settings-path` / `--state-dir` value.

## Client surfaces: MCP tools + prompts, plus local commands

The reusable spine is the **MCP server** (`plugin/.mcp.json` → `/api/v1/mcp`):
every MCP client supports tools + prompts, so this is the cross-client surface.

- **MCP tools** (talk to the server): `list_my_projects`, `list_activity_types`,
  `my_usage`, `tag_session`, `resolve_repo_project`, `provision_emit`.
- **MCP prompts** (orchestration skills, surfaced in Claude Code's slash menu
  tagged **(MCP)**): `tokenscope-setup`, `tag`, `project`, `usage`. A prompt tells
  the agent which tools to call; the agent does the genuinely local steps — a
  tool never writes the user's disk. It writes `.tokenscope` with its own file
  tool, and it **runs a script** for anything that touches the credential store:
  `claude-redeem.mjs` redeems the handoff and writes the device's settings
  itself, and `device-id.mjs` answers the one question setup needs from that
  store.

**The device store is never opened by the agent.** Re-running setup should
*rotate* this device rather than mint a duplicate, which needs one non-secret
fact: the `tokenscope.instance_id` the host was last provisioned with. That id
sits in `~/.claude/settings.json` next to `TOKENSCOPE_OAUTH_REFRESH_TOKEN` (and,
on the Copilot side, in `~/.tokenscope/config.copilot-cli.json` next to
`oauth_refresh_token`), so instructing the agent to read the file would pull a
durable credential into the model's context on every ordinary setup — no attacker
required. `plugin/scripts/device-id.mjs` reads the store out of process and
prints a fixed five-key object and nothing else:
`{enrolled, tool, instance_id, bearer_host, reason}`. The object is built from a
fixed key set rather than a spread of the parsed store, so a key added to either
store later cannot leak through it. It takes `--tool claude-code|copilot-cli` and
reads only that tool's store, reporting `enrolled: false` with a `reason` of
`no-enrolment` or `tool-mismatch` rather than an id the caller would misuse —
instances are per-host but bound to one emit tool, and provisioning the other
tool's id revokes that tool's credential. `bearer_host` is also how the prompts
tell which deployment a device currently points at. The file is dependency-free
so it vendors verbatim into the Copilot plugin.

The **device-local** commands (`plugin/commands/*.md` → `plugin/scripts/*.mjs`)
are the Claude-specific surface that the MCP spine can't cover — genuinely local
or emit-probe work. Install — **slash form, inside Claude Code in a terminal**:
`/plugin marketplace add https://<your-tokenscope>/api/v1/plugin/marketplace.json`
then `/plugin install tokenscope@tokenscope`. Each deployment serves that
marketplace itself: an `archive` plugin source (a zip of `plugin/` with the
deployment's origin written into `server_url`'s default, the MCP URL in
`.mcp.json` and `DEFAULT_API_BASE`), pinned by sha256. It needs no Git and no
server-URL step (Claude Code 2.1.224+; the routes are in the API reference).

**Claude Desktop** can't use the slash form: the app's Code tab hands
`/plugin marketplace add` to its own form, which accepts only Git hosts ("This
host isn't supported"). Instead the URL marketplace goes into the settings file
of the app's install (`extraKnownMarketplaces` + `enabledPlugins`):
`$CLAUDE_CONFIG_DIR/settings.json` when the app keeps its own folder (seen on
Linux: `~/.claude-desktop`), else `~/.claude/settings.json`. The app's local Code
sessions read it; the Connect dialog's **Claude Desktop** guide gives a prompt
that makes that edit. The app's **+ → Plugins** list never shows a
marketplace added this way.

The app launches Claude Code with its own `OTEL_SERVICE_NAME=claude-code-desktop`
and `OTEL_RESOURCE_ATTRIBUTES`, so the settings file's `tokenscope.instance_id`
and `tool` never reach its records (anthropics/claude-code#67657), and the reader,
which selects on `tokenscope.instance_id`, would skip them. The app does merge a
value from the user's login environment, so `/tokenscope:setup` run inside the app
(`CLAUDE_CODE_ENTRYPOINT=claude-desktop`) also sets
`OTEL_RESOURCE_ATTRIBUTES=tokenscope.instance_id=<id>,tool=claude-code` there
(`plugin/scripts/desktop-env.mjs`: `launchctl setenv` plus a LaunchAgent on
macOS, a user variable on Windows, and on Linux a
`~/.config/environment.d/90-tokenscope.conf` that appends to the login's value
and takes effect at the next login). Desktop records then carry the instance and
join like CLI ones; `service.name` is not read. Setup from a terminal does not do
this. A per-repo `project.code_hash` cannot ride a user-wide variable, so Desktop
sessions arrive untagged and are tagged per session. Managed settings with the same two keys are Claude
Code's documented organisation-wide route; it is not verified for TokenScope, and
Claude Code issue [#16870](https://github.com/anthropics/claude-code/issues/16870) reports managed `extraKnownMarketplaces` being ignored.

**Fallback: install from Git.** `/plugin marketplace add <owner>/<repo>`, where
`<owner>/<repo>` is the repository that carries your deployment's plugin (see
"Installing for your own deployment" below). The manifest is the repo-root
`.claude-plugin/marketplace.json`; the add is a git clone (authenticated, so a
private fork works), and the plugin then needs its server URL set. A lighter
terminal-CLI alternative (`claude plugin marketplace add … --sparse .claude-plugin plugin`)
sparse-checks-out only those two dirs but requires the standalone `claude` CLI.
Both marketplaces are named `tokenscope`; switching means
`/plugin marketplace remove tokenscope` first.

| Command                            | What it does                                                                                                                                                                                                                                                                                             | Backing                                                                  |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `/tokenscope:setup`                | Set up TokenScope on this device — connect + provision emitting in one OAuth consent. The **local counterpart** to the `tokenscope-setup` MCP prompt: it calls `provision_emit`/`my_usage` and runs the local redeem helper, so the durable emit credential is redeemed process→process, never via chat. | `provision_emit` + `my_usage` (MCP) + local `device-id.mjs` and `claude-redeem.mjs` (their `.ps1` twins on Windows without Node) |
| `/tokenscope:status`               | Report whether your sessions are emitting **and** whether the MCP is connected — the 3-state verdict (🟢 emit+MCP / 🟡 emit-only / 🔴 not emitting). It names this install's device as the Account page shows it, and whether the folder's project tag is billable (or why that could not be checked). A Copilot CLI emission failure on the same machine is reported separately (`copilot_lane_failure`), never as a Claude one.                                                                                                                                                     | local emit probe (the OS's headers helper → `/bearer`) + MCP-auth probe |
| `/tokenscope:statusline [on\|off]` | Install/remove the status line (Claude Code's own emission health + MCP-connection state + session id; a failing Copilot CLI emitter on the same machine never turns it red).                                                                                                                                                                                                                    | local-only                                                               |
| `/tokenscope:backfill`             | Re-emit recent local Claude usage that may have been dropped (short emission-gap catch-up).                                                                                                                                                                                                              | local-only                                                               |

Each script resolves the API base via `api-base.mjs`, most explicit first: the
caller's explicit argument, else `TOKENSCOPE_API_BASE` **but only when it names
loopback**, else the plugin's **`server_url` option** as the user configured it
(read from managed and user settings, never from the repository), else the MCP
server's **registered origin** (discovered from configuration the user wrote),
else the **packaged default**. `plugin/.mcp.json` is
`${user_config.server_url}/api/v1/mcp`, so Claude Code puts the same configured
value (or the same default) into the MCP server's URL. The plugin a deployment
serves has the literal URL instead, because Claude Desktop's `/mcp` Connect
cannot expand the template and refuses to sign in.

**Neither of the two channels a repository or a model can reach may name a
destination.** Claude Code merges a project's `.claude/settings.local.json` env
over the global one, so `TOKENSCOPE_API_BASE` is something a cloned repository
can set and nothing downstream can tell that value apart from one the developer
exported — hence loopback-only, for every script, with no opt-out flag. And on
the redeem path `--api-base` may only **select** an origin the device already
knows (loopback, the packaged default, the configured `server_url`, or the
discovered registration), never
introduce one, because that argv is composed by a model under a prefix
`allowed-tools` grant that pre-approves every tail. The redeem request carries a
live single-use handoff code whose answer is a durable emit credential, so it is
the one call that must not be steerable. Local dev against
`http://localhost:3450` still works: to be served by loopback something must
already be running on the machine, and whoever registered an MCP server there is
discovered from their own configuration anyway. When resolution fails, the remedy
is to set `server_url` (or register the server with the CLI) — not to pass a flag,
which on a device that knows nothing can only accept loopback values.

`status` (emission probe) invokes the real emit path (the headers helper for the
OS: `otel-headers-helper.sh`, or `otel-headers-helper.ps1` on Windows). Reads and tagging go over MCP and authenticate
with the connection's **`tokenscope.read`/`tag` OAuth** grant — a client
authenticates as itself, never via a borrowed browser cookie.

The published versions are declared in three places that must move
together, and this page deliberately does NOT restate the numbers. Read them from `.claude-plugin/marketplace.json` (both entries) and each plugin's own
manifest. Claude Code caches an installed plugin **by version** and re-installs
only when the number **increases** — a fix shipped without a bump reaches no
device, however many restarts the fleet does. A CI check fails the build on a
plugin-code change with no version bump, and a sync-manifest guard keeps the
vendored `copilot-plugin/` copies byte-identical to their sources.

### Installing for your own deployment

**Claude Code: set the plugin's `server_url`.** In Claude Code run `/plugin`,
choose **tokenscope**, then **Configure**, and paste the server URL from your
deployment's Connect dialog. No fork. Claude Code saves it in user settings as
`pluginConfigs["tokenscope@<marketplace>"].options.server_url` and substitutes it
into the plugin's MCP URL; the scripts read the same entry from
`~/.claude/settings.json` (or from managed settings, which outrank it, so an
organisation can set it for every device).

Only the user or the organisation can set it. Claude Code ignores `pluginConfigs`
in project and local settings from 2.1.207, and the scripts never read the
`CLAUDE_PLUGIN_OPTION_SERVER_URL` variable it exports to hooks, because a
repository's `env` reaches hook processes too. On Claude Code older than 2.1.207 a
cloned repository can still move the MCP server's URL through its own settings;
the scripts, which carry the credentials, ignore it.

The internal build defaults `server_url` to the maintainers' Dev deployment, so
internal installs need no configuration. The public build ships no default: an
unconfigured install reports *"URL is unset or invalid — open /plugin manage and
configure"* for the MCP server, and the setup helpers stop with *"No TokenScope
server is configured"*.

**Copilot CLI** has no plugin options. Register the server with
`copilot mcp add --transport http tokenscope https://<your-host>/api/v1/mcp` (the
Connect dialog shows it); the Copilot scripts discover that registration.

**Changing the packaged default** means editing six places that
`npm run check:copilot-plugin-sync` holds together:
`plugin/.claude-plugin/plugin.json` (`userConfig.server_url.default`),
`plugin/scripts/api-base.mjs` (`DEFAULT_API_BASE`), `copilot-plugin/.mcp.json`,
`copilot-plugin/scripts/enroll.mjs` and `shared/connect.ts`
(`CLAUDE_PLUGIN_DEFAULT_ORIGIN`, `COPILOT_PLUGIN_BUNDLED_ORIGIN`). The Claude
default may be empty (the public build), and then the Connect dialog always
shows the step that points the plugin at the deployment. The check also fails if `plugin/.mcp.json` is anything
other than the `server_url` template. Bump both plugin versions with it.

## Plugin trust boundary

Claude Code merges a repository's `.claude/settings.local.json` over the device's
global `~/.claude/settings.json`, **per key**, with the repo-local value winning
any key present in both — measured on Claude Code 2.1.232 and 2.1.283.
Any cloned repository therefore gets a vote on the environment the plugin's own
scripts run under — which is fine for a project claim and not fine for anything
that carries a credential. Merge makes the boundary **more** important than
replacement would: a repo can override a single key and leave every other value
looking untouched.

- **The repo may supply `OTEL_RESOURCE_ATTRIBUTES`, and nothing else.**
  `repoTagEnv(globalEnv, repoEnv)` in `plugin-runtime.mjs` is a **positive
  allowlist**: the resource attributes come from the repo-local file, every other
  key comes from the device's global settings. A deny-list would have missed
  `TOKENSCOPE_STATE_DIR`, which is credential-bearing — the bearer helper writes
  the freshly minted emit access token into that directory, so a repo-steered
  state dir drops a live token inside the attacker's working tree with no network
  call to catch.
- **The two keys with no legitimate global source are deleted, not outvoted.**
  `TOKENSCOPE_STATE_DIR` and `TOKENSCOPE_API_BASE` are never written to global
  settings, so spreading the global block last cannot overrule a repo-supplied
  value. Every env handed to a child process or used for a fetch removes them
  outright, and `stateDir()` ignores a passed `env` entirely, reading the
  override from `process.env`. The direct readers (`landed-check.mjs`,
  `project-check.mjs`) route through the same helper so one deletion covers them
  all.
- **Provenance for `TOKENSCOPE_STATE_DIR` is established at the hook, not in
  `stateDir()`.** Reading `process.env` is a narrowing, not a boundary: Claude
  Code merges the repo-local settings `env` into the process environment, so by
  the time `stateDir()` runs the two sources are indistinguishable. The settings
  *files* still carry provenance, so `hookStateDir()` in `session-start.mjs`
  reads them: if any `.claude/settings.json` or `.claude/settings.local.json`
  from the cwd up to and including the **git root** names the key at all (matched
  case-insensitively), the inherited value is replaced with the global settings
  value, or removed so the state dir falls back to `~/.tokenscope` on the passwd
  home. A repo that says nothing about the key leaves a genuine process-level pin
  untouched. It matters because that directory is where the bearer helper caches
  the freshly minted emit access token. Every state-dir read in the hook goes through this, and
  anything the hook spawns is pinned to its result.
- **One endpoint validator, shared.** `assertSafeEndpoint()` in
  `endpoint-guard.mjs` is the single validator every credential-bearing call
  routes through — redeem, enrol, status, backfill, the landed check, the project
  check and the bearer helper. It requires an absolute
  `https:` URL for any off-box host (loopback is exempt only when the caller
  explicitly opts in, for the local dev override and local ingest stubs) and rejects a value beginning with `-`, which a shell interpolation would
  otherwise read as a flag. The file is dependency-free precisely so it can be vendored verbatim into
  the Copilot plugin rather than reimplemented there.
- **One argv validator, shared — because the ARGV is repo-steerable too.** A
  slash command's `allowed-tools` entry is a **prefix** grant
  (`Bash(node "${CLAUDE_PLUGIN_ROOT}/scripts/claude-redeem.mjs":*)`), so every
  argument tail is pre-approved with no prompt, and a prompt-injected model can
  append flags to the documented invocation. Copilot CLI has no grant mechanism
  at all. `argv-guard.mjs` (vendored the same way `endpoint-guard.mjs` is) is
  therefore the control: an unknown `--flag` refuses the whole argv, a flag
  missing its value is refused rather than reinterpreted, `--api-base` may only
  select a known origin (and a value outside that set is warned about and
  dropped, not fatal — exiting would hand a prompt injection a denial of setup),
  and the path-valued flags (`--settings-path` for the credential file,
  `--shell-rc` for the shell init block) are confined to the home directory and
  to the filename each flag exists to name. Confinement compares **real**,
  symlink-resolved paths on both sides, so a `~/.claude` pointing out of the home
  cannot pass. **No flag names the POST target**: the redeem path is fixed at
  `/api/v1/setup/redeem` on the resolved base. That is also why refusal, not
  tolerance, is the right answer to an unknown flag — a tolerated one degrades to
  "silently ignored", where its value still lands as a stray positional.

## Telemetry contract

The load-bearing detail. Claude Code emits OTLP **directly** to Azure Monitor —
**no collector on the Claude path**. Verified against Claude Code v2.1.158.

- **Emit LOG events, not metrics.** Attribution joins on the `api_request` log
  event — it carries `input_tokens`, `output_tokens`, `cache_read_tokens`,
  `cache_creation_tokens`, `cost_usd`, `model`, `request_id` in one record. The
  plugin sets `OTEL_LOGS_EXPORTER=otlp`, `OTEL_METRICS_EXPORTER=none`.
- **Ingest URL** is the full DCR logs path:
  `https://<logs-dce>/dataCollectionRules/<dcrImmutableId>/streams/Microsoft-OTLP-Logs/otlp/v1/logs`,
  pointed at by `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT`.
- **Stream segment** `Microsoft-OTLP-Logs` (service-managed built-in) — **not**
  `Microsoft-OTel-Logs` (that is only the DCR `dataFlows` id; wrong
  name → `400 InvalidStream`).
- **Protocol** `http/protobuf` (`OTEL_EXPORTER_OTLP_LOGS_PROTOCOL`).
  Content-Type `application/x-protobuf` (JSON → `415`). **Content-Length must be
  explicit** — chunked streaming → `400 MissingContentLengthHeader`. Success is
  HTTP **204**.
- **Bearer** minted by TokenScope's managed identity at scope
  `https://monitor.azure.com/.default`. It is refreshed dynamically by
  `otelHeadersHelper` (configured in settings, **not** an env var — there is no
  `OTEL_*_HEADERS_HELPER` env). Claude runs the helper at startup and every
  ~29 min; the helper for the OS (`plugin/scripts/otel-headers-helper.sh`, or
  `otel-headers-helper.ps1` on Windows; [ADR-0015](Design-Decisions.md#adr-0015--native-client-runtime-per-os)) mints a short-lived OAuth
  `tokenscope.emit` access token and presents it to `TOKENSCOPE_BEARER_ENDPOINT`
  (`/api/v1/instances/{instanceId}/bearer`) to mint the Azure token. grpc cannot use the helper.
  **The helper takes its state dir as an argument (`--state-dir`), never from
  `TOKENSCOPE_STATE_DIR`.** Claude Code invokes it *itself*, as a sibling of every
  hook and with its own merged environment, so no hook can repair what it reads;
  argv is the one channel a settings file cannot contribute to. With no argument
  it resolves `~/.tokenscope` from the **passwd database**, which `$HOME` cannot
  move. Our own callers pass the dir they resolved. The helper also prepends a
  trusted `PATH` and passes `curl -q`, because it is handed the durable refresh
  token and both the interpreter and the tools were otherwise repo-selectable.
  *One documented gap:* on a host with **no passwd entry for the uid** (some
  minimal containers) it falls back to `$HOME` — leak-susceptible again — and
  says so loudly on stderr. Pass `--state-dir` there.
- **Join key** is **`tokenscope.instance_id`** (the device INSTANCE id, minted by
  `provision_emit` at setup and carried verbatim in `OTEL_RESOURCE_ATTRIBUTES`) —
  **NOT** Claude's own `session.id`, which is the per-SESSION id we don't
  know at provision time. We do capture Claude's `session.id` per-record as
  `claude_session_id` on `attribution_record`.
- **Landing + latency.** Events land in the **`OTelLogs`** table: resource
  attributes → `ResourceAttributes` column, per-event token fields →
  `Attributes` column (there is no `Properties` column). Ingest→queryable
  latency is **~4–5 min**. `server/azure/reader.ts` (`LogAnalyticsReader`)
  reads it via KQL.

### Project tag in the repo file

The repo tag (`writeRepoTag`) writes one key into a tagged repo's
`.claude/settings.local.json`: `env.OTEL_RESOURCE_ATTRIBUTES`, carrying an instance
id, `project.code_hash` and `tool`. The helper, the endpoints and the credential
apply from the install's own `settings.json`, because Claude Code merges `env` per
key, so Claude Desktop and the CLI each keep their own when they open the same repo.
A key an earlier plugin copied in (`otelHeadersHelper`, `TOKENSCOPE_*`, the
telemetry keys) is removed on the next session start; any other key in the file is
yours and is left alone. A git-tracked `settings.local.json` is never written. The
project tag applies from the repo file (measured on Claude Code 2.1.232 and
2.1.283). Supported CLI builds are roughly the last 4-6 weeks.

The instance in the tag stays as it is while another Claude install on the machine
is enrolled with it (`~/.tokenscope/config.claude-code.json` or
`~/.tokenscope/claude-config/*/config.claude-code.json`) against the same
deployment (the same bearer-endpoint origin), so two installs do not rewrite it in
turn and their sessions in that repo emit under one instance. Any other instance is
replaced, with the "superseded device enrolment" warning. Backfill stamps the
instance the tag keeps. A helper an earlier plugin copied into the file is removed
only once the install's own settings name a usable one. The status line reads the
landing state of the instance in the tag, and shows it as unconfirmed when that
instance is not kept or the other install's answer is over two hours old.

### Why restart, and where to verify

- Claude reads telemetry config **at startup**. Running the `tokenscope-setup`
  or `project` prompt in an already-running session does nothing until `claude`
  is relaunched in that directory. (The `SessionStart` hook sidesteps this for
  the per-repo project injection on a fresh session.)
- The `SessionStart` hook does more than per-repo project injection. On each fresh
  session it also: resolves every state-dir read through **`hookStateDir`**
  (above), so a repo-claimed `TOKENSCOPE_STATE_DIR` reaches neither the hook nor
  anything it spawns — and repairs the **execution-steering** variables
  (`PATH`, `NODE_OPTIONS`, `BASH_ENV`, `ENV`, `LD_PRELOAD`, `LD_LIBRARY_PATH`,
  `NODE_PATH`) on the same provenance test, because a repo-set `PATH` chooses the
  `sh` that runs the emit helper and a repo-set `NODE_OPTIONS=--require` runs code
  inside any Node child it spawns. **Neither repair reaches the ~29-minute
  `otelHeadersHelper` refresh** — Claude Code invokes that one directly, which is
  why the helper takes its state dir from argv (above) instead. It also **emit-on-install auto-enrols** (`enrollIfNeeded`, a no-op unless a
  bundled secret is present and the device is not yet enrolled), **self-heals** the
  plugin script paths, and surfaces one-line warnings: emission health, a
  project-not-billable-here warning, and a superseded-instance-pin warning. Every
  step is fail-open, so a failure never breaks session start.
- `/tokenscope:status` showing not-emitting right after setup usually means the
  ~4–5 min ingest lag or a missing restart — not a wiring fault.
- In a repo with a `.tokenscope` tag, re-enrolling takes **two** relaunches. The
  repo keeps its own merged copy of the enrolment and the hook can only reconcile
  it *after* the session has read its env, so the first relaunch repairs the file
  while still emitting under the previous instance. That session prints the
  superseded-instance-pin warning; the next one is correct. Untagged repos have no
  repo-local override and pick the new instance up on the first relaunch.

## Key files

| Concern                            | Path                                                                         |
| ---------------------------------- | ---------------------------------------------------------------------------- |
| MCP server config                  | `plugin/.mcp.json`                                                           |
| MCP tools + prompts (server)       | `server/utils/mcp.ts`                                                        |
| MCP endpoint                       | `server/api/v1/mcp/[...].ts`                                                 |
| Local commands                     | `plugin/commands/{setup,status,statusline,backfill}.md`                      |
| Local scripts                      | `plugin/scripts/{status,statusline,statusline-toggle,backfill,tag-repo}.mjs` |
| Device-identity accessor           | `plugin/scripts/device-id.mjs` (`device-id.ps1` on Windows without Node)     |
| Redeem, Windows without Node       | `plugin/scripts/claude-redeem.ps1` (+ `ps-json.ps1`)                         |
| Redeem-argv validator              | `plugin/scripts/argv-guard.mjs`                                              |
| OTel env/settings builder          | `plugin/scripts/env-builder.mjs`                                             |
| Bearer-refresh helper              | `plugin/scripts/otel-headers-helper.sh` (POSIX), `otel-headers-helper.ps1` (Windows) |
| Emit-handoff redeem                | `server/api/v1/setup/redeem.post.ts`                                         |
| OAuth 2.1 routes                   | `server/api/v1/oauth/*.ts`                                                   |
| Retroactive assign                 | `server/api/v1/me/sessions/[sid]/assign`                                     |
| Telemetry reader                   | `server/azure/reader.ts`                                                     |
| Plugin user guide                  | `plugin/README.md`                                                           |

> [VERIFY] `claude plugin marketplace add` / `claude plugin install` verb names
> against live `code.claude.com` docs at install time.
> [VERIFY] VS Code honors the settings `env` block for `OTEL_RESOURCE_ATTRIBUTES`
> — validated on the CLI, not yet exercised in VS Code.
