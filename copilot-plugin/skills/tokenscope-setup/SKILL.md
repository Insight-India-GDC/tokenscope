---
description: Connect GitHub Copilot CLI to TokenScope and provision emitting (one OAuth consent authenticates + provisions; the durable secret is redeemed locally, never via chat)
---

# tokenscope-setup — Connect & Provision Emitting (Copilot CLI)

Connect GitHub Copilot CLI to TokenScope and turn on token attribution for this
device. One OAuth consent both **authenticates** you (read/tag tools work) and
**provisions emitting** (sessions start attributing spend). The durable emit
credential never passes through this conversation — a local helper redeems it
process-to-process.

## When to Use

- First time using Copilot CLI with TokenScope on this device.
- Sessions stopped emitting and you want to re-provision.
- After re-installing the plugin or moving to a new host.

## Workflow

### Step 1: Ensure the MCP connection is authenticated

The TokenScope MCP server is a remote HTTP server registered by the plugin's
`.mcp.json`. Call the `my_usage` tool. If it returns data (or an empty-but-valid
usage summary), auth is good. If it reports "Not authenticated", let the client
complete the browser OAuth consent and retry.

### Step 2: Read any existing device id (idempotency — SAME ENVIRONMENT **AND SAME TOOL** ONLY)

Get this host's current Copilot `instance_id` if it has one — re-running against
the **same deployment** rotates that device's credential rather than minting a new
one. Ask the device-identity helper, which prints only non-secret fields:

```bash
sh -c 's=$(ls -d "$HOME"/.copilot/installed-plugins/*/tokenscope-copilot/scripts/device-id.mjs 2>/dev/null | grep -v "/installed-plugins/_direct/" | sort -V | tail -n1); [ -n "$s" ] || s=$(for d in "$HOME"/.copilot/installed-plugins/_direct/*/; do [ -f "${d}scripts/device-id.mjs" ] && node -e "try{process.exit(JSON.parse(require(\"fs\").readFileSync(process.argv[1],\"utf8\")).name===\"tokenscope\"?0:1)}catch(e){process.exit(1)}" "${d}plugin.json" 2>/dev/null && echo "${d}scripts/device-id.mjs"; done | sort -V | tail -n1);
  [ -n "$s" ] || { echo "device-id.mjs not found — is the tokenscope plugin installed?" >&2; exit 1; }
  exec node "$s" --tool copilot-cli'
```

It prints `{"enrolled":…,"tool":…,"instance_id":…,"bearer_host":…,"reason":…}` and
nothing else. Use `instance_id` only when `enrolled` is `true`; anything else
(including `enrolled: false`) → treat this as a fresh device and omit the id.

> **Never go looking for the id yourself.** The device credential store that
> carries it also carries this device's **durable emit credential** as a
> neighbouring key, so opening it copies a long-lived secret into this
> conversation. The helper reads it out-of-process and prints only the non-secret
> fields — use it, and only it. The same goes for the other CLI's settings file, a
> `last-landed.json`, or any status/health cache: do not read them for an id.
>
> **`--tool copilot-cli` is required, not decoration** — omitted, the helper
> defaults to `claude-code` and reads the wrong store. Instances are per-**HOST**
> but bound to ONE emit tool, and the helper reads only the store belonging to
> `--tool`, so `--tool copilot-cli` can only ever report a `copilot-cli` instance
> and never hands you the **Claude Code** id on a host running both. If Copilot
> has never been set up here it reports `enrolled: false`
> (`reason: "no-enrolment"`) — there is no Copilot instance to reuse, so **omit
> `instance_id` and mint a fresh one.** This matters because provisioning a Claude
> id as `copilot-cli` revokes the Claude credential and **breaks Claude Code
> emitting** — silently, since nothing warns and Claude keeps running while
> emitting nothing. The server now refuses a cross-tool re-provision with HTTP 409
> before any rotation, but do not rely on that alone — pass the right id, or none.

**Re-provisioning against a DIFFERENT deployment? Do NOT reuse the old id.** When
you are moving this device from one TokenScope deployment to another (for example
from a sandbox to production), **omit** the existing `instance_id` so a fresh
instance is minted under the new deployment — passing the old id would try to
rotate an instance that belongs to the _other_ deployment. To tell, compare the
**`bearer_host`** the device-id helper printed in Step 2 with the host of the
deployment you are provisioning against (the host of the TokenScope MCP server
this session is connected to).

If the hosts differ, this is a cross-environment transition: omit the old id. (The local redeem helper
also detects the change from the bearer host and writes a **clean** config, so the
old environment's credentials and endpoints are dropped rather than left at rest.)

### Step 3: Provision emitting

Call the `provision_emit` tool with:

- `tool: "copilot-cli"` — **required** so the server returns the Copilot bundle
  (file exporter env vars, forwarder config), not the Claude OTel bundle.
- `instance_id` — the existing device id from Step 2, **only for a
  same-environment re-run** (omit it for a fresh device _or_ a cross-environment
  move — see Step 2).

It does **not** return the durable emit secret. It returns a short-TTL (~5 minute)
one-time **handoff code**, a per-device **redeem URL**, and a note to run the local
redeem helper (command in Step 4).

### Step 4: Redeem locally (process → process, NOT through this chat)

Run the local redeem helper **exactly as `provision_emit` instructs** — it returns a
ready-to-run `redeem_command` that locates the script itself. Prefer that verbatim.

If you need to run it by hand, do **not** guess the path: the plugin lives under
`~/.copilot/installed-plugins/<marketplace>/tokenscope-copilot/scripts/` (a direct
(path) install: `~/.copilot/installed-plugins/_direct/<folder>/scripts/`, counted only
when that folder's `plugin.json` has the top-level `name` `tokenscope`, and only
when there is no marketplace install). The
MARKETPLACE segment varies by how the marketplace was added, so it is globbed; the
plugin segment is the literal marketplace entry name, so it is NOT. Globbing it too
would also match a different installed plugin that happens to ship a file of the same
name, and hand it your one-time handoff code as an argument. (There is no
`~/.copilot/plugins/` directory.) Note the code is passed via `--handoff-code` because
it may begin with `-`:

```bash
sh -c 's=$(ls -d "$HOME"/.copilot/installed-plugins/*/tokenscope-copilot/scripts/copilot-redeem.mjs 2>/dev/null | grep -v "/installed-plugins/_direct/" | sort -V | tail -n1); [ -n "$s" ] || s=$(for d in "$HOME"/.copilot/installed-plugins/_direct/*/; do [ -f "${d}scripts/copilot-redeem.mjs" ] && node -e "try{process.exit(JSON.parse(require(\"fs\").readFileSync(process.argv[1],\"utf8\")).name===\"tokenscope\"?0:1)}catch(e){process.exit(1)}" "${d}plugin.json" 2>/dev/null && echo "${d}scripts/copilot-redeem.mjs"; done | sort -V | tail -n1);
  [ -n "$s" ] || { echo "copilot-redeem.mjs not found — is the tokenscope plugin installed?" >&2; exit 1; }
  exec node "$s" --handoff-code "$1"' tokenscope-redeem '<handoff_code>'
```

A relative `redeem_url` (`/api/v1/setup/redeem`) is normal: the server returns an
absolute URL only when it can prove its own public origin, and degrades rather than
name a host derived from a request header. The helper resolves the base itself, in
order: the origin of the MCP server as actually registered in THIS client's local
config, then the other client's, then the packaged default. It does not need to be
told. `TOKENSCOPE_API_BASE` is deliberately NOT consulted here: a checked-out
repository can set environment variables, and a process cannot tell a repo-supplied
value from one the developer exported, so the paths that carry a live single-use
credential do not read it.

Do **not** try to supply the host yourself. `--api-base` is checked against the
origins this device already knows — loopback, or the MCP registration above — and
a value naming anything else is ignored with a warning, because the argv of that
process is composed here, in a conversation, and the handoff is a live single-use
credential. If resolution fails, the fix is to register the TokenScope MCP server
in `~/.copilot/mcp-config.json` (a file the user edits, outside this chat) and
re-run; the helper's own error message says so.

It makes a direct process→server HTTP call, redeems the handoff code, and:

1. Writes this device's TokenScope credential store with the durable emit
   credential (and an empty access-token cache for the bearer helper). On a
   same-environment re-run it rotates the credential/endpoint fields in place
   (preserving any unrelated keys); on a **cross-environment** move (the bearer host
   changed) it writes a clean config and prints a one-line `Environment changed:
old → new` note so the old deployment's credentials/endpoints don't linger.
2. Turns on Copilot's extensions feature (`enabledFeatureFlags.EXTENSIONS` in Copilot's
   `settings.json`, with `extensions.mode: load_only` unless the user chose a mode: the
   helper prints the mode in effect), so the plugin's usage extension loads and
   captures each model call's usage. Tell the user, in these words or close to
   them: "Setup turned on Copilot extensions so TokenScope can see your usage. This
   also lets a repository you trust in Copilot run its own extensions, the same way
   it can already run its hooks." It also removes the
   `# >>> TokenScope >>>` block an earlier setup wrote into your shell rc, and the old
   forwarder's files from your projects: nothing is written into your shell or your
   repositories any more.

**Do not** ask for, print, or store the durable credential in this conversation.

### Step 5: Confirm

Call `my_usage` again to confirm the MCP connection still answers. Then tell the
user, in these words or close to them (one short line each):

- **You're signed in** to TokenScope.
- **Tracking is on** for this computer. If the helper said it could not update
  Copilot's settings, say that instead and relay its one-line instruction.
- **Restart Copilot:** "Quit `copilot` and start it again. The next session is the
  first one that sends usage."
- **Check it works:** "After a few minutes of using Copilot, type `/` and run the
  TokenScope **status** skill. Green means you're done. Your usage shows in
  TokenScope about 5 minutes after you use Copilot."
- **Next:** "To bill a repo to a project, run the `project` skill in that repo.
  Usage anywhere else shows as untagged until you tag it."

Background for you (do not recite it; use it to answer questions):

- The restart is needed because the usage extension loads when a session starts.
- **`my_usage` confirms the sign-in, not sending.** A successful `my_usage` call
  proves the MCP (chat tools) sign-in works. It does **not** exercise the separate
  device-bound emit credential: the `status` skill's local emission probe is what
  checks that. Neither proves a record landed — Azure Monitor ingest is minutes
  downstream and not observable client-side, so never present a clean setup as
  "telemetry arrived". Landing is confirmed by `my_usage` (or the dashboard)
  showing this device's spend after a few minutes of real `copilot` usage.
- **A valid credential is not proof of capture either.** The `status` skill's
  `emission_healthy` (not `emitting` alone) and `usage_capture` say whether usage is
  captured: `enabled: false` means Copilot extensions are off: only sessions from a
  terminal that still exports the old `COPILOT_OTEL_FILE_EXPORTER_PATH` are captured
  (by the legacy forwarder), and nothing else is. The fix is to re-run setup.
- Copilot spend in a repo with a committed `.tokenscope` (written by the `project`
  skill) is tagged to that project; elsewhere it lands untagged until tagged with
  `tag_session`.

## Troubleshooting

| Problem                                           | Solution                                                                                                                                                               |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `my_usage` says "Not authenticated"               | Let the browser OAuth consent finish, then retry.                                                                                                                      |
| `provision_emit` handoff expired before redeem    | Handoff codes are ~5 min single-use — re-run `provision_emit` for a fresh one.                                                                                         |
| Redeem helper reports a network error (not a 401) | Check network connectivity to the TokenScope server. If the base resolved wrongly, register the server in `~/.copilot/mcp-config.json` and re-run — the helper only accepts an origin it can already see, so neither `--api-base` nor `TOKENSCOPE_API_BASE` can introduce a host from this chat. |
| Sessions not appearing in TokenScope              | Run the `status` skill. `usage_capture.enabled: false`: re-run setup, which enables Copilot extensions or says exactly what to change by hand (extension mode `disabled`, TokenScope's extension switched off in `/extensions`, or keys in Copilot's `config.json`), then restart copilot. `usage_capture.drift` set: Copilot's own totals and the recorded calls disagree, so report it. `usage_capture.backlog` over 24h old: records are not reaching the ingest endpoint (network); `usage_capture.backlog.error`: the spool directory cannot be read (check its permissions). |
