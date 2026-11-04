# TokenScope Claude Code plugin

Tracks your Claude Code token usage in TokenScope, so it is billed to the right
project.

## Quick start

About 5 minutes, once per computer. Do every step in Claude Code in a
terminal. **Using the Claude app?** Follow [Claude Desktop](#claude-desktop)
instead: the app can't add this marketplace with `/plugin`.
Windows: nothing else to install. macOS / Linux: needs Node.js.

1. **Install the plugin.** Run these one at a time, with your TokenScope
   address in place of `<your-tokenscope>`:

   ```
   /plugin marketplace add https://<your-tokenscope>/api/v1/plugin/marketplace.json
   /plugin install tokenscope@tokenscope
   ```

   When asked, choose **Install for you**. If it asks for a server URL, keep
   the one it shows.
2. **Sign in.** Run `/mcp`, choose **tokenscope**, and approve in your browser.
3. **Turn on tracking.** Run `/tokenscope:setup`.
4. **Restart Claude Code.**
5. **Check it works.** Run `/tokenscope:status`. Green means you're done.

Then, in each repo you bill to a project, run the `project` prompt once and
commit the `.tokenscope` file it writes.

Your TokenScope Connect dialog shows the exact commands. The plugin your
deployment serves already points at it, so there is no server URL to set, and
you don't need Git. It needs Claude Code 2.1.224 or later. Can't use that
address? [Install from Git](#install-from-git-fallback) instead. Stuck? See
[Troubleshooting](#troubleshooting). How setup works:
[How setup works](#how-setup-works).

## What the plugin gives you

The model is **connect once, then tag each repo**:

- **`tokenscope-setup`** (MCP prompt) — **run once per device.** Authenticates you
  (one browser OAuth consent) AND provisions emitting: it writes the OTel plumbing
  + your device's durable emit credential into the **global** `~/.claude/settings.json`.
  The durable emit secret is redeemed by a local helper, never through the chat.
  After this, every Claude CLI on the device emits to TokenScope (untagged until a
  repo is tagged).
- **`project`** (MCP prompt) — **run per repo.** Lists the projects you can bill,
  you pick one; it writes the repo's committed `.tokenscope` (computing
  `project.code_hash` locally) and tags this checkout. No need to know the exact slug.
- **`tag`** (MCP prompt) — tag a specific session to a budget and/or activity
  (lists your budgets + activity suggestions, then records it).
- **`usage`** (MCP prompt) / **`my_usage`** (MCP tool) — your month-to-date spend
  split per budget, plus unallocated + tagged spend.
- `/tokenscope:setup` — **run this first** on a new device/session: connect +
  provision emitting (one OAuth consent; the durable credential is redeemed
  locally). A first-class command mirroring the `tokenscope-setup` MCP prompt.
- `/tokenscope:status` — "is my Claude emitting to TokenScope, and is the MCP
  connected?".
- `/tokenscope:statusline [on|off]` — toggle the status line (see below).
- `/tokenscope:backfill` — re-emit recent local usage that may have been dropped.

The MCP prompts (`tokenscope-setup`, `project`, `tag`, `usage`) surface in Claude
Code's slash menu tagged **(MCP)** — e.g. `/plugin:tokenscope:tokenscope:tokenscope-setup`.
They are the reusable spine (every MCP client supports tools/prompts); the local
`/tokenscope:*` commands above are the Claude-specific surface (status line, emit
probe, backfill).

Tagging is also **zero-touch**: a `SessionStart` hook ensures the repo-local
`project.code_hash` is set whenever you start `claude` in a repo that has a
committed `.tokenscope` and the device is connected (see *Zero-touch tagging*).

## Install

Every TokenScope deployment serves its own Claude Code marketplace at
`/api/v1/plugin/marketplace.json`. The plugin in it is a zip of this `plugin/`
directory, with that deployment's address written in. Adding it needs no Git and
no GitHub account. In a terminal, run the two commands **one at a time**, because
Claude Code treats a multi-line paste as one command:

```
/plugin marketplace add https://<your-tokenscope>/api/v1/plugin/marketplace.json
/plugin install tokenscope@tokenscope
```

When prompted for an install scope, choose **"Install for you (user scope)"**.
The plugin is a personal tool that emits across all your repos. Don't use
*project* scope (commits plugin config into the repo + force-installs it on
collaborators) or *local* scope (this repo only). The committed `.tokenscope`
file is what travels per-repo, not the plugin.

This needs Claude Code 2.1.224 or later (`archive` plugin sources). The
deployment must know its own public HTTPS address (`appPublicOrigin`). Without
it, the marketplace answers 503 and the Connect dialog shows the Git steps.

An organisation can try adding the marketplace for every device in managed settings
(not yet tested with TokenScope; see the note after the block):

```json
{
  "extraKnownMarketplaces": {
    "tokenscope": { "source": { "source": "url", "url": "https://<your-tokenscope>/api/v1/plugin/marketplace.json" } }
  },
  "enabledPlugins": { "tokenscope@tokenscope": true }
}
```

Put it in `managed-settings.json`: `/Library/Application Support/ClaudeCode/` on
macOS, `C:\Program Files\ClaudeCode\` on Windows, `/etc/claude-code/` on Linux.
Claude Code documents that it reads these keys from managed settings. This route
is not yet tested with TokenScope, and Claude Code issue [#16870](https://github.com/anthropics/claude-code/issues/16870) reports managed `extraKnownMarketplaces`
being ignored, including by the Windows desktop app; try one device first. The admin
**Client connection** page shows the block with your deployment's address filled in.

### Claude Desktop

Don't run `/plugin marketplace add` in the Claude app. Its Code tab hands it to the
app's own **Add marketplace** form, which accepts only Git hosts and answers
"This host isn't supported" for a deployment's URL. The app does read the same
settings files as the CLI, so add the marketplace there instead:

1. In a **local** Code session, paste the prompt from your Connect dialog
   (**Connect Claude Desktop**). It asks Claude to merge two keys into
   `~/.claude/settings.json` (on Windows, `%USERPROFILE%\.claude\settings.json`):

   ```json
   {
     "extraKnownMarketplaces": {
       "tokenscope": { "source": { "source": "url", "url": "https://<your-tokenscope>/api/v1/plugin/marketplace.json" } }
     },
     "enabledPlugins": { "tokenscope@tokenscope": true }
   }
   ```

   Editing the file yourself works too. Keep the keys already in it.
2. Quit the app completely and open it again. The plugin installs when the next
   session starts. It **won't** appear under **+ → Plugins**, which lists
   marketplaces added in the app, not ones added in settings; type `/tokenscope:`
   to see its commands.
3. Run `/mcp`, choose **tokenscope**, select **Connect**, and approve in your
   browser.
4. Run `/tokenscope:setup`, quit and reopen the app, then run `/tokenscope:status`.
   In the app, setup also puts this device's labels
   (`OTEL_RESOURCE_ATTRIBUTES=tokenscope.instance_id=…,tool=claude-code`) in your
   login environment: `launchctl setenv` plus a LaunchAgent
   (`~/Library/LaunchAgents/com.tokenscope.desktop-otel-env.plist`) on macOS, a
   user environment variable on Windows. The app launches Claude Code with its own
   `OTEL_RESOURCE_ATTRIBUTES` and ignores the settings file's
   ([anthropics/claude-code#67657](https://github.com/anthropics/claude-code/issues/67657)),
   but it merges the login value into its own. Without this, Desktop usage arrives
   and cannot be linked to you. The CLI is unaffected: setup run from a terminal
   does not do this, and the CLI keeps reading its settings file. `/tokenscope:status`
   in the app reports `desktop_env` when the login value is missing or names
   another device. To undo on macOS: `launchctl unsetenv OTEL_RESOURCE_ATTRIBUTES`
   and delete the LaunchAgent; on Windows, remove the user variable.

Cloud and WSL sessions in the app don't load plugins. If you added a `tokenscope`
marketplace from Git before, Claude Code keeps that one and refuses a second
source under the same name: remove it first. Verified on macOS (app with bundled
Claude Code 2.1.293); not yet on Windows.

### Install from Git (fallback)

Use this when the URL above doesn't work for you, or to install a fork. It needs
Git on your PATH and read access to the repository your Connect dialog names. The
marketplace manifest is at the **repo root** (`.claude-plugin/marketplace.json`),
so the GitHub shorthand resolves it:

```
/plugin marketplace add <owner>/<repo>
/plugin install tokenscope@tokenscope
```

A plugin installed from Git does not know your deployment's address. Set it
next ([Point the plugins at your deployment](#point-the-plugins-at-your-deployment)).

Both marketplaces are named `tokenscope`, and Claude Code keeps one per name.
To switch, run `/plugin marketplace remove tokenscope` first. That also removes
the plugin and its saved options.

**Lighter Git alternative (needs the standalone `claude` CLI on PATH).** The
terminal form supports `--sparse`, a git sparse-checkout of just `.claude-plugin`
+ `plugin`, so the whole repository isn't checked out:

```
claude plugin marketplace add <owner>/<repo> --sparse .claude-plugin plugin
claude plugin install tokenscope@tokenscope
```

From a local checkout you can instead `claude plugin marketplace add .`.
A plugin installed that way runs from the checkout itself, so setup writes the
checkout's path into `settings.json`. Once you switch back to a normal install,
the next session start moves it to the installed copy. On a host whose
`~/.claude` is shared with containers, the checkout path must exist inside the
containers too (mount the checkout at the same path), or test from the
marketplace instead.

### One `~/.claude` shared with containers

Some setups share one `~/.claude` between a host and its containers (dev
containers, launchers that bind-mount the host's `~/.claude`). Each side then
sees the plugin under its own home, for example `/home/you/.claude/...` on the
host and `/home/claude/.claude/...` in a container, while `settings.json` can
hold only one path for the telemetry helper.

TokenScope does not rewrite a path that the other side wrote (it used to, and
each side's sessions then broke the other's). Each side notes itself in
`tokenscope-sides.json` next to `settings.json` when a session starts; a side
not seen for two weeks (a home that was renamed, say) is forgotten, and its old
paths are repaired as usual. Instead, a session on the side
the path does not suit says so when it starts: "...shared with another computer
or container... this session's usage is NOT being sent". To fix it, make both
paths valid on both sides, then restart Claude Code:

- on the host, link the container's folder to yours, for example
  `sudo ln -s /home/you/.claude /home/claude/.claude` (create `/home/claude`
  first, and only if that path is free: not when `/home/claude` is a real
  account's home);
- in each container, link or mount the host's path to the same folder, for
  example mount the host's `~/.claude` at both `/home/claude/.claude` and
  `/home/you/.claude`.

## Point the plugins at your deployment

**Claude Code from your deployment's own marketplace: nothing to do.** The
served plugin already carries the address ([Install](#install)). The rest of
this section is for a plugin installed from Git.

**Claude Code from Git: set the plugin's server URL.** No fork is needed. The plugin
declares one option, `server_url`. Copy the server URL from your TokenScope
deployment's Connect dialog, then in Claude Code run `/plugin`, choose
**tokenscope**, then **Configure**, and paste it (just the address, such as
`https://tokenscope.your-company.example`, with no path). Restart Claude Code.

Claude Code stores the value in your user settings (`~/.claude/settings.json`,
under `pluginConfigs["tokenscope@<marketplace>"].options.server_url`) and puts it
into the plugin's MCP server URL (`${user_config.server_url}/api/v1/mcp`). The
plugin's scripts (setup redeem, enrolment) read the same value from the same
file, so both halves talk to one server. An organisation can set it for every
device in managed settings instead (`pluginConfigs` is read from managed and user
settings).

A repository cannot set it. From Claude Code 2.1.207, `pluginConfigs` in a
project's `.claude/settings.json` or `settings.local.json` is ignored, and the
scripts never read the `CLAUDE_PLUGIN_OPTION_SERVER_URL` variable Claude Code
exports to hooks, because a repository's `env` can set that too. Older Claude
Code versions read `pluginConfigs` from project settings, so a cloned repository
could move their MCP server; the scripts still ignore it there.

What the default is depends on the build:

- **This repository's build** defaults `server_url` to the maintainers' Dev
  deployment, so an install that never configures it keeps working.
- **The public build** has no default. Until you set it, `claude mcp list` shows
  *"URL is unset or invalid — open /plugin manage and configure"* and the setup
  helpers stop with *"No TokenScope server is configured"*.

If you run Claude Code with a custom `CLAUDE_CONFIG_DIR` (the Claude app can
have its own, e.g. `~/.claude-desktop`), the scripts read and write that
folder's files instead of `~/.claude`, but only when the folder is inside your
home, outside any git repository, and no project settings file sets the
variable: a repository can set it for hook processes, and this folder decides
where the credential is written. Otherwise they use `~/.claude`, and
`/tokenscope:status` says why (`config_dir_refused`). The Windows PowerShell
lane (no Node) always uses `~/.claude`.

**Copilot CLI: register the server.** Copilot has no plugin options. Run the
`copilot mcp add` command your Connect dialog shows:

```
copilot mcp add --transport http tokenscope https://<your-host>/api/v1/mcp
```

The Copilot plugin's scripts discover that registration and use its host.

**Changing the packaged default (maintainers).** The packaged host lives in
`plugin/.claude-plugin/plugin.json` (`userConfig.server_url.default`),
`plugin/scripts/api-base.mjs` (`DEFAULT_API_BASE`), `copilot-plugin/.mcp.json`,
`copilot-plugin/scripts/enroll.mjs` (`DEFAULT_API_BASE`) and `shared/connect.ts`
(`CLAUDE_PLUGIN_DEFAULT_ORIGIN`, `COPILOT_PLUGIN_BUNDLED_ORIGIN`).
`npm run check:copilot-plugin-sync` fails when they disagree (the three Claude
defaults may all be empty, which is the public build),
or when `plugin/.mcp.json` is anything but the `server_url` template. Bump both
plugin versions with the change: an installed plugin is replaced only when its
version increases.

## Configure

| Var | Default | Purpose |
|---|---|---|
| `TOKENSCOPE_API_BASE` | unset | **Local development only.** Honoured only for a loopback value (`http://localhost:3450`); any other value is ignored, because a repository can set this variable. It does not move the MCP server. For a local server, set the plugin's `server_url` to `http://localhost:3450` instead (see [Point the plugins at your deployment](#point-the-plugins-at-your-deployment)); that moves both the MCP server and the scripts. |

Tagging makes **no server call** at write time and needs no env var — the
`project` prompt resolves the code from your memberships and hashes it locally.

## How setup works

After install, the plugin registers the TokenScope **MCP server**. Authenticate it,
then run the setup prompt:

1. **`/mcp`** → select `tokenscope` → it opens a browser **OAuth consent**. Approve
   the read + tag scopes. (Copy the callback URL back into Claude Code if the
   loopback redirect can't reach you — the consent page shows a Copy button.)
2. Run the **`tokenscope-setup`** MCP prompt. It provisions emitting: `provision_emit`
   returns a short-TTL handoff code + a ready-to-run `redeem_command` that invokes
   the bundled **`claude-redeem.mjs`** helper (Copilot's analogue is `copilot-redeem.mjs`).
   The agent runs that command, which redeems the handoff **locally** (process→server,
   never through the chat) for the durable emit credential and writes it into the
   **global** `~/.claude/settings.json` (atomic temp+rename; mode 0600 on POSIX,
   the profile's own ACL on Windows), merging in:
   - `otelHeadersHelper` — the command that runs the headers helper for the OS:
     `scripts/otel-headers-helper.sh` on POSIX, `scripts/otel-headers-helper.ps1`
     under an absolute `powershell.exe` on Windows (ADR-0015). The
     Azure Monitor Bearer can ONLY be configured as a helper via this settings key.
     Claude runs the helper at startup and every ~29 min; it mints a short-lived
     OAuth `tokenscope.emit` access token (refresh-token grant) and presents THAT to
     `TOKENSCOPE_BEARER_ENDPOINT` to mint a fresh Azure token. The bearer is never a
     static header.

     That same request also states what the device is running:
     `X-TokenScope-Plugin-Version` (read from the `plugin.json` beside the helper,
     so it is the version that actually ran) and `X-TokenScope-Client-Version`
     (the CLI version, from `CLAUDE_CODE_EXECPATH` / `AI_AGENT`), plus
     `X-TokenScope-Client-Platform` (`<os>-<arch>` from `uname`, in Node's
     vocabulary: `darwin-arm64`, `linux-x64`, `win32-x64`) and
     `X-TokenScope-Client-Surface` (`CLAUDE_CODE_ENTRYPOINT`, or `app`/`cli` from
     Copilot's `AI_AGENT`). The server records them on `instance_attestation` as
     **client-asserted diagnostic
     hints** — never an authorisation or costing input — so an operator can answer
     "does this device need to update?" from data instead of asking the human. A
     value that cannot be determined is **omitted**, not guessed: the resulting
     NULL means "running a build older than the one that reports", which is the
     signal you want during a rollout. Reporting is never load-bearing — if it
     fails for any reason the mint still succeeds.
   - `env` — `CLAUDE_CODE_ENABLE_TELEMETRY=1`, logs-only OTLP config
     (`OTEL_LOGS_EXPORTER=otlp`, `OTEL_METRICS_EXPORTER=none`,
     `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT`, `OTEL_EXPORTER_OTLP_LOGS_PROTOCOL=http/protobuf`),
     `TOKENSCOPE_BEARER_ENDPOINT` + the durable OAuth emit credential
     (`TOKENSCOPE_OAUTH_REFRESH_TOKEN` / `…_TOKEN_ENDPOINT` / `…_CLIENT_ID`), and
     `OTEL_RESOURCE_ATTRIBUTES = tokenscope.instance_id=<DEVICE_SID>,tool=claude-code`
     (note: **no** `project.code_hash` — that's per-repo).

Restart `claude` to begin emitting. Until a repo is tagged, its sessions emit
**untagged** and surface in the untagged-spend worklist.

## Tag a repo (per repo)

Run the **`project`** MCP prompt in the repo. It lists the projects you can bill,
you pick one, and it:

- writes a committable `./.tokenscope` (`project.code: <code>`, preserving any
  existing fields) so the tag travels with the repo, then
- writes the **repo-local** `./.claude/settings.local.json` (mode 0600 on POSIX) with
  ONE env key, `OTEL_RESOURCE_ATTRIBUTES`:
  `tokenscope.instance_id=<DEVICE_SID>,project.code_hash=<sha256(code)>,tool=claude-code`.
  Claude Code merges the `env` blocks **per key**, so the helper, exporter,
  endpoints and credentials apply from your install's own settings and are never
  copied into the repo; any other key you keep in that file is left alone. If that
  file is tracked by git, nothing is written and the session start says so.

The tag is checked on **every** `claude` launch in that repo. Its instance id is
kept while another Claude install on this computer (the CLI, Claude Desktop) is
enrolled with it against the same TokenScope server, so installs sharing a repo
do not rewrite it in turn; any other instance (after a re-enrol, or one enrolled
with a different server) is replaced.
Commit the `.tokenscope`; teammates who clone it just run the `project` prompt
with no project (or let the SessionStart hook auto-apply it). Restart `claude`
in the repo — OTel resource attrs are read at startup, so the **next** session
is tagged.

The project name/code is not emitted; the hash is a stable identifier, not a
secret.

## `.tokenscope` file

Commit this at the repo root so every developer on the project gets the same
attribution:

```yaml
project:
  code: "1000012345/450000001"
  id: "contoso-ai-insights"
  name: "Contoso - AI Insights"

# Optional context — informational, not used for tagging.
client: "Contoso"
practice: "Data & AI"
engagement_type: "Fixed Price"
pm: "Alex Example"
```

The `project` prompt + the SessionStart hook use `project.code` (the canonical
code) to compute the hash. `id` / `name` are informational.

## Session activity (`/tokenscope:activity`)

A session's **activity** says what the work was (research, development,
testing, ...). Set it from inside the session:

```
/tokenscope:activity research     # tag this session
/tokenscope:activity              # list the suggestions and pick one
/tokenscope:activity clear        # remove this session's own tag
```

The command tags the session it runs in: no session id to find or paste. The
last choice wins, and it re-tags the usage the session has already recorded.
`clear` removes the session's own tag: usage already recorded keeps no
activity, and new usage gets the folder default, if the folder has one.
In Copilot CLI the `activity` skill does the same for the session that last
sent usage from the folder.

**A default for a folder.** To tag every new session started in a folder, add
it to that folder's `.claude/settings.local.json` (the personal file Claude
Code keeps out of git; never the shared `.claude/settings.json` or
`.tokenscope`):

```json
{ "tokenscope": { "activity": "research" } }
```

- It applies from the next session.
- TokenScope keeps it only when it is one of your region's activity types.
  Anything else (a client or bid name, say) is not stored in TokenScope's
  usage records. It is still sent with the session's telemetry, so put only an
  activity name here.
- A tag set with the command, the tag prompt or the web Tag dialog always wins
  over it.

The status line shows the project and activity after its health label, for
example `TokenScope ✓ landed · HBR-2041 · Research #c3f1a2e0`, and
`/tokenscope:status` says where each came from.

## Zero-touch tagging (SessionStart hook)

The plugin registers a `SessionStart` hook (`hooks/session-start.mjs`, wired via
`hooks/hooks.json`). On every session start it checks: is the device connected,
and does the cwd's repo have a committed `.tokenscope` with a `project.code`? If
so, it ensures `./.claude/settings.local.json` carries the matching
`project.code_hash`.

**Semantics:** OTel resource attributes are frozen at process startup, so the
hook cannot re-tag the *running* session — it writes the repo-local settings so
the **next** launch is tagged. The first-ever launch in a fresh repo therefore
emits untagged once (surfaces in the untagged-spend worklist); every subsequent
launch is tagged. Run the `project` prompt + relaunch to tag immediately. The
hook fails **open** — any error (not connected, no `.tokenscope`, parse failure)
exits silently and never breaks your session.

## Status line

The status line is **off** until you turn it on. `/tokenscope:statusline on`
installs it in `~/.claude/settings.json`, **replacing** any custom status line you
had; `/tokenscope:statusline off` removes it (a status line that isn't TokenScope's
is left untouched). Restart `claude` for the change to take effect.

It shows emission and delivery **health**, MCP-connection state and the current
**session id** (`#` + the first 8 characters of Claude's session id), for example
`TokenScope ✓ landed #65d2c64f`. The full list of states and what each means is in
[`commands/statusline.md`](commands/statusline.md). `/tokenscope:status` reports
the same verdict in detail; for your spend breakdown use the `usage` prompt /
`my_usage` tool / web dashboard.

## MCP server (the cross-client backbone)

The plugin registers a **remote MCP server** (`plugin/.mcp.json`) — a
streamable-HTTP server at the deployed base + `/api/v1/mcp`, authenticated by
OAuth 2.1 (no token to paste; the browser consent runs on first connect). It
points at the same deployment as the rest of the plugin. From Git its URL is
`${user_config.server_url}/api/v1/mcp`, the `server_url` option you configure
(see [Point the plugins at your deployment](#point-the-plugins-at-your-deployment)).
The plugin a deployment serves has the literal URL written in instead: the Claude
app's `/mcp` Connect cannot expand the template and refuses to sign in.

Over MCP the server exposes read tools (`list_my_projects`, `list_activity_types`,
`my_usage`, `resolve_repo_project`) + a tag tool (`tag_session`), and **prompts**
(`tokenscope-setup`, `tag`, `project`, `usage`) that orchestrate them. This is the
reusable spine — every MCP client supports tools/prompts; the device-local
`/tokenscope:*` scripts (status line, emit probe, backfill) remain the
Claude-specific surface.

## What this plugin does NOT do

- Block Claude — TokenScope never enforces. Going over budget raises an item in
  your TokenScope inbox (in the web app), not a hard stop. TokenScope does not
  send Teams messages or email.
- Send your project name to any AI coach — the project name/code is not
  emitted; the hash is a stable identifier, not a secret.
- The durable OAuth emit **refresh token** lives in `~/.claude/settings.json` on
  your machine (never commit it); the server stores only its HMAC. It auto-refreshes
  short-lived access tokens — there is no legacy session token. It is never
  written to a per-repo `settings.local.json` (see "Tag a repo" above): a tagged
  repo's session mints its bearer from the device's own state-dir credential store.

## Troubleshooting

| Problem | What to do |
| --- | --- |
| "Failed to add marketplace" with `owner/repo` | That form runs Git, which isn't installed. Use your deployment's URL instead ([Install](#install)). |
| Claude app: "This host isn't supported" | The app's marketplace form takes only Git hosts. Add the marketplace through settings instead ([Claude Desktop](#claude-desktop)). |
| Claude app: "Couldn't start sign-in … points at a different server URL" | The app is using a plugin from before the literal MCP URL (0.1.45 or older). Quit the app completely, reopen it and retry. If it stays, the app hasn't picked up 0.1.46 yet. |
| "Failed to add marketplace … source doesn't match" | You added TokenScope from the other source before. Run `/plugin marketplace remove tokenscope`, then add it again. This also removes the plugin. |
| The URL install fails, or your Claude Code is older than 2.1.224 | [Install from Git](#install-from-git-fallback), then set the server URL. |
| Windows without Node.js | Tracking works. The status line, `/tokenscope:backfill` and tagging sessions from a `.tokenscope` file need Node.js. Without it, a plugin update doesn't update your tracking settings, so run `/tokenscope:setup` again after each update. To get everything, run `winget install OpenJS.NodeJS.LTS`, then `/tokenscope:setup` again. |
| macOS / Linux: setup says `node: command not found` | Install Node.js (`sudo apt-get install -y nodejs`, `brew install node`, or add it to your container image), then run `/tokenscope:setup` again. |
| The browser sign-in can't get back to Claude Code | Copy the link the sign-in page shows into Claude Code. |
| `/mcp` says "URL is unset or invalid" | A Git install. Set the plugin's server URL ([Point the plugins at your deployment](#point-the-plugins-at-your-deployment)), then restart Claude Code. |
| `/tokenscope:status` isn't green | Check you restarted Claude Code. In a repo with a `.tokenscope` file, restart once more if you see a "superseded device enrolment" warning. Still not green? Run `/tokenscope:setup` again. |
| Green, but no usage in TokenScope yet | Usage shows about 5 minutes after you use Claude Code. Status checks the credential, not delivery. |
