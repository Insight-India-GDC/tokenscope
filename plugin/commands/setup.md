---
description: Set up TokenScope on this device — connect + provision emitting (one OAuth consent; the durable credential is redeemed locally, never via chat)
allowed-tools: mcp__plugin_tokenscope_tokenscope__provision_emit, mcp__plugin_tokenscope_tokenscope__my_usage, mcp__tokenscope__provision_emit, mcp__tokenscope__my_usage, Bash(node "${CLAUDE_PLUGIN_ROOT}/scripts/device-id.mjs":*), Bash(node "${CLAUDE_PLUGIN_ROOT}/scripts/claude-redeem.mjs":*), Bash(C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${CLAUDE_PLUGIN_ROOT}/scripts/device-id.ps1":*), Bash(C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${CLAUDE_PLUGIN_ROOT}/scripts/claude-redeem.ps1":*), PowerShell(C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${CLAUDE_PLUGIN_ROOT}/scripts/device-id.ps1"), PowerShell(C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${CLAUDE_PLUGIN_ROOT}/scripts/claude-redeem.ps1":*)
---

Connect Claude Code to TokenScope and turn on token attribution for this device.
One OAuth consent both **authenticates** you (so the read/tag tools work) and
**provisions emitting** (so your sessions attribute spend). The durable emit
credential never passes through this conversation — a local helper redeems it
process-to-process.

## When to use

- First time using Claude Code with TokenScope on this device.
- Your sessions stopped emitting and you want to re-provision.
- After reinstalling the plugin or moving to a new host.

After a plugin update, quit and restart Claude Code before running setup: a
session that was open during the update still runs the old version's steps.
From this version on, the Node redeem helper checks this and stops, before using
the one-time code, with "This session is running TokenScope <old>, but <new> is
installed now"; if you see that, tell the user to restart Claude Code and run
`/tokenscope:setup` again. Older versions' helpers and the PowerShell lane do
not check, so the restart is still the rule.

## Workflow

### 0. Detect the platform and runtime (BEFORE anything else)

Setup runs on one of two **lanes**, and this step picks it. Do it first: a device
that cannot finish setup must stop **before** the OAuth consent and before
`provision_emit` spends anything.

Run the device-identity helper with Node:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/device-id.mjs" --tool claude-code
```

- **It prints JSON** → the **Node lane**. Keep the output: it is also step 2's
  answer (`enrolled`, `instance_id`, `bearer_host`), and `platform` / `node` say
  where you are. Continue with step 1.
- **`node` is not found** (`command not found`, exit 127) → which lane depends on
  the operating system this session runs on:
  - **macOS, Linux, WSL, a container or devcontainer → STOP here.** Do not call
    `my_usage` or `provision_emit`. Setup on these systems needs Node.js. Tell the
    user to install it, then re-run `/tokenscope:setup`:
    - Debian / Ubuntu: `sudo apt-get install -y nodejs`
    - macOS: `brew install node`
    - a container or devcontainer: add Node.js to the image (for example
      `RUN apt-get update && apt-get install -y nodejs` in the Dockerfile, or the
      devcontainer `node` feature) and rebuild it.
  - **Windows → the PowerShell lane.** Run the PowerShell twin of the helper
    (Windows PowerShell ships with Windows; nothing to install):

    ```bash
    C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${CLAUDE_PLUGIN_ROOT}/scripts/device-id.ps1"
    ```

    It reads the Claude Code store (no `--tool` needed) and prints the same JSON
    with `"node": null`. Keep it for step 2. Then, **before
    step 1**, tell the user what this **emit-only** lane means, in these words or
    close to them:

    > This computer doesn't have Node.js, so TokenScope will set up tracking only.
    > Your Claude Code usage **will** be tracked, and the TokenScope tools in this
    > chat (tagging, `my_usage`) **will** work. The status line,
    > `/tokenscope:backfill` and tagging sessions from a repo's `.tokenscope` file
    > need Node.js. Without Node.js, a plugin update doesn't update your tracking
    > settings, so run `/tokenscope:setup` again after each update. To get
    > everything later: `winget install OpenJS.NodeJS.LTS`, then run
    > `/tokenscope:setup` again.

    Continue unless the user would rather install Node first.

Use the same lane for every later step. Never mix them: the Node lane runs only
the `.mjs` helpers and the PowerShell lane only the `.ps1` helpers.

### 1. Ensure the MCP connection is authenticated

Call the `my_usage` tool. If it returns data (or an empty-but-valid usage
summary), auth is good. If it reports "Not authenticated", let the client
complete the browser OAuth consent and retry.

### 2. Read any existing device id (idempotency — SAME ENVIRONMENT **AND SAME TOOL** ONLY)

Get this host's current `tokenscope.instance_id` if it has one, so re-running
against the **same deployment** rotates the existing credential instead of minting
a new one. You already asked the device-identity helper in step 0 (the
`device-id.mjs` run on the Node lane, `device-id.ps1` on the PowerShell lane); use
that output rather than running it again.

It prints `{"enrolled":…,"tool":…,"instance_id":…,"bearer_host":…,"reason":…,"platform":…,"node":…}`
and nothing else. Use `instance_id` only when `enrolled` is `true`; anything else
(including `enrolled: false`) → treat this as a fresh device and omit the id.

> **Never go looking for the id yourself.** The device store that carries it also
> carries this device's **durable emit credential** as a neighbouring key, so
> opening it copies a long-lived secret into this conversation. The helper reads
> the store out-of-process and prints only the non-secret fields — use it, and
> only it.
>
> **Ask it for the tool you are provisioning.** Instances are per-**HOST** but
> bound to ONE emit tool, and the helper reads only the store belonging to
> `--tool` — so `--tool claude-code` can only ever report a `claude-code`
> instance, and never hands you the Copilot CLI's id on a host running both. When
> that store holds no instance, or holds one bound to another tool, it reports
> `enrolled: false` (`reason: "no-enrolment"` / `"tool-mismatch"`) instead of an
> id you would misuse. That matters because a cross-tool re-provision revokes the
> other CLI's credential and **breaks its emitting** — silently, since the
> affected CLI keeps running while emitting nothing. The server refuses this with
> HTTP 409 before any rotation, but pass the right id, or none.

**Re-provisioning against a DIFFERENT deployment? Do NOT reuse the old id.** When
you are moving this device from one TokenScope deployment to another (for example
from a sandbox to production), **omit** the existing `instance_id` so a fresh
instance is minted under the new deployment — passing the old id would try to
rotate an instance that belongs to the _other_ deployment. To tell, compare the
**`bearer_host`** the device-id helper printed in step 2 with the host of the
deployment you are provisioning against (the host of the TokenScope MCP server
this session is connected to).

If the hosts differ, this is a cross-environment transition: omit the old id. (The local redeem helper
also detects the change from the bearer host and **replaces** the env block, so the
old environment's credentials and endpoints are dropped rather than left at rest.)

### 3. Provision emitting

Call the `provision_emit` tool, passing the existing `instance_id` from step 2
**only for a same-environment re-run** (omit it for a fresh device _or_ a
cross-environment move — see step 2). It does **not** return the durable emit
secret. It returns a short-TTL (~5 minute) one-time **handoff code**, a
per-instance **redeem URL**, and a short local-redeem instruction.

### 4. Redeem locally (process → process, NOT through this chat)

Run **your lane's** local redeem helper, passing **only the handoff code**
`provision_emit` returned — do not construct any other invocation. Ignore the
`redeem_command` in `provision_emit`'s answer: it is for clients without this
plugin and looks under `~/.claude`, which is the wrong folder for an install
with its own config folder (`CLAUDE_CONFIG_DIR`, e.g. the Claude app's). `--redeem-url` no longer
exists, and the helper checks `--api-base` against the origins the device already
knows (loopback, the packaged deployment, the server URL configured for this
plugin, the MCP server registered in your own client config), so a relayed value
can select one of those but cannot name a new
host. Pass neither:

Node lane:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/claude-redeem.mjs" --handoff-code <code>
```

PowerShell lane (Windows without Node):

```bash
C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${CLAUDE_PLUGIN_ROOT}/scripts/claude-redeem.ps1" --handoff-code <code>
```

Both take the same arguments, apply the same checks and write the same files. The
PowerShell one also tells the server this device is emit-only (a diagnostic, it
changes nothing about what is accepted) and ends its output by restating what does
and does not work without Node. It runs the emit helper from a **snapshot** it
copies into the TokenScope state folder, so a plugin update cannot strand it, but
an update does not refresh it either: re-running setup after an update does.

It redeems the handoff code and writes this device's Claude Code settings itself,
in this install's config folder (`CLAUDE_CONFIG_DIR` when it is set to a folder
of the user's, else `~/.claude`); its last line names the file.
**Do not** ask for, print, or store the durable credential in this conversation,
and do not read the settings back to check it — the helper's own output already
says whether it succeeded.

### 5. Confirm + restart

Call `my_usage` again to confirm the MCP connection still answers, then tell the
user, in these words or close to them (one short line each):

- **You're signed in** to TokenScope.
- **Tracking is on** for this computer. On the PowerShell lane, repeat the step 0
  lines on what needs Node.js and why to run setup again after each plugin update.
- **Restart Claude Code** to start tracking. "In a repo with a `.tokenscope`
  file, restart once more if you see a *superseded device enrolment* warning."
  In the Claude app, repeat the helper's own `Next:` line instead: quit the app
  completely, or on Linux log out and back in.
- **Check with `/tokenscope:status`.** "Green means setup worked. Your usage
  shows in TokenScope about 5 minutes after you use Claude Code."
- **Next:** "To bill a repo to a project, run the `project` prompt in that repo."

Background for you (do not recite it; use it to answer questions):

- Telemetry config is read at startup, which is why the restart is needed. A
  repo with a `.tokenscope` tag keeps the instance id in its own
  `.claude/settings.local.json`, and project settings override user settings;
  after a re-enrol the SessionStart hook replaces the old id *after* the session
  has read its env, so the first relaunch repairs the file while still emitting
  under the previous device. Untagged repos are unaffected.
- On the PowerShell lane the emit helper runs from a snapshot, so a plugin
  update does not refresh it; re-running setup does (installing Node makes that
  automatic).
- `/tokenscope:status` runs the Node probe on the Node lane and the PowerShell
  probe on a Windows device without Node. It checks emit-AUTH health, not
  delivery: it confirms the emit credential can mint an ingest bearer, not that a
  record landed. Ingest is ~4–5 min downstream through Azure Monitor OTLP and is
  not observable client-side, so never present green as "telemetry arrived".
  Actual landing is confirmed by `my_usage` (or the dashboard) after a few
  minutes of real usage.
- The `project` MCP prompt writes a `.tokenscope` file so the repo's sessions
  attribute to a budget instead of landing as untagged.

## Troubleshooting

| Problem                                           | Solution                                                                                |
| ------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Step 0: `node: command not found` on macOS/Linux  | Install Node.js (`sudo apt-get install -y nodejs`, `brew install node`, or add it to the container image), then re-run setup. |
| Step 0: `node: command not found` on Windows      | Expected without Node: take the PowerShell lane (step 0). For the full feature set: `winget install OpenJS.NodeJS.LTS`, then re-run setup. |
| PowerShell lane: `C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe` not found | Windows is installed on another drive (`$env:SystemRoot` names it, e.g. `D:\Windows`). Run the same command with that drive letter in place of `C:`, still in the forward-slash form. Never shorten it to a bare `powershell.exe`: that is looked up on a PATH the repository can change. |
| `my_usage` says "Not authenticated"               | Let the MCP client finish the browser OAuth consent, then retry.                        |
| No `my_usage` tool, or `/mcp` shows "URL is unset or invalid" | No TokenScope server is set for this plugin. Ask the user to run `/plugin`, choose tokenscope, then Configure, paste the server URL from their TokenScope Connect dialog, and restart Claude Code. |
| `provision_emit` handoff expired before redeem    | Handoff codes are ~5 min single-use — re-run `provision_emit` for a fresh one.          |
| Redeem helper reports a network error (not a 401) | The local helper couldn't reach the server; check the plugin's API base / connectivity. |
| Sessions still not emitting after redeem          | Restart `claude` — the OTel env is read once at process start.                          |
| "Superseded device enrolment" warning at start    | A `.tokenscope` repo's settings copy was just refreshed; relaunch `claude` once more.   |
