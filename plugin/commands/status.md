---
description: Check whether your Claude sessions are emitting to TokenScope
allowed-tools: Bash(node "${CLAUDE_PLUGIN_ROOT}/scripts/status.mjs":*), Bash(C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${CLAUDE_PLUGIN_ROOT}/scripts/status.ps1":*), PowerShell(C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${CLAUDE_PLUGIN_ROOT}/scripts/status.ps1")
---

Tell the developer whether their Claude telemetry is reaching TokenScope
(emission health) and whether the TokenScope MCP connection is authed (so the
query tools/prompts can run).

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/status.mjs" --session "${CLAUDE_SESSION_ID}"
```

**Windows without Node** (`node` is not found): run the PowerShell probe
instead. It prints the same JSON, the project-tag check included:

```
C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${CLAUDE_PLUGIN_ROOT}/scripts/status.ps1"
```

If that path does not exist, Windows is on another drive (`$env:SystemRoot`
names it): run the same command with that drive letter in place of `C:`. Never
shorten it to a bare `powershell.exe`, which is looked up on a PATH the
repository can change.

On such a device emitting works and so do the MCP tools, but the status line,
`/tokenscope:backfill` and the repo project pin need Node. Say so once if
`runtime` is `"powershell"`, and that installing Node and re-running
`/tokenscope:setup` turns them on.

Returns:

```json
{
  "emitting": true,
  "probe": { "status": 200, "message": "OK: this computer can send usage to TokenScope." },
  "device": { "instance": "203d6725", "message": "This install is device 203d6725, as listed on your Account page." },
  "project": { "code": "HBR-2041", "billable": true, "message": "Project tag “HBR-2041” is billable on this environment." },
  "last_landed": { "at": "2026-10-30T09:12:00Z", "source": "server", "message": "Usage from this computer last arrived at ..." },
  "work": { "project": { "code": "HBR-2041", "source": "from .tokenscope" }, "activity": { "label": "Research", "source": "folder default" } },
  "last_failure": { "ts": "...", "http_status": 401, "message": "..." },
  "mcp_authed": true
}
```

Summarise as a 3-state health: the verdict first, then one next step, in plain
words (no "emit", "bearer" or "OAuth" in what you say):

- **GREEN — ✓ emitting + connected** (`emitting` true AND `mcp_authed` true):
  this device's emit credential works AND the MCP connection is authed. Quote
  `probe.message`, then `last_landed.message` (when usage last arrived).
- **YELLOW — ⚠ emit-only** (`emitting` true, `mcp_authed` false): usage IS
  recorded, but the MCP server isn't connected, so the query tools/prompts
  (`my_usage`, `tag_session`, the setup/tag/project/usage prompts) can't run.
  Tell them: "Tracking works, but you're not signed in, so the TokenScope tools
  in this chat can't run. Run `/mcp`, choose tokenscope and approve in your
  browser, then run `/tokenscope:status` again."
- **RED — ✗ not emitting** (`emitting` false): telemetry dropped. Drive off
  `probe.status`:
  - 401/403/404 → say **NOT EMITTING ✗**, quote `probe.message`, and tell them
    to run `/tokenscope:setup` again (it re-provisions via `provision_emit`).
  - null/0 → emission could NOT be verified (often a transient network blip;
    suggest re-running) — do NOT cry "dropped".

Also:

- **Claude app (`desktop_env`)**: present only in a Claude app (Desktop)
  session. The app replaces the settings file's device labels, so its sessions
  are attributed only when the login environment carries this device too.
  `desktop_env.verdict` `ok` adds nothing to say. `missing` or `mismatch` means
  this session's usage arrives but cannot be linked to them: even when the rest
  is green, say so in plain words and give `desktop_env.fix`. `next-login`
  (Linux) means setup is done but this session started before it took effect:
  give `desktop_env.fix` (log out and back in), and do NOT tell them to run
  setup again. `duplicate` (Linux) means the session carries an older device
  label too: give `desktop_env.fix` (restart the computer), not setup.
- **Which install**: `settings_file` is the settings file this report checked.
  Mention it when it is not `~/.claude/settings.json`. If `config_dir_refused`
  is present, quote it: CLAUDE_CONFIG_DIR was set but not trusted, so the
  report is about `~/.claude` instead.
- **This device (`device`)**: quote `device.message` once, so they can match
  this install to its row on the Account page. The Claude app and the Claude
  Code CLI on one computer are separate installs with separate devices. Null
  means this install is not set up.
- **Project tag billability (`project`)**: `billable` true or false, quote
  `project.message` (false means spend in this folder is landing untagged: give
  the re-tag step it names). `billable` null with a `reason` means the check
  could not run: quote `project.message`, which names why; it is not a warning
  about the tag itself.
- **What the work is tagged with (`work`)**: say the project and the activity,
  each with where it came from (`source`: "set this session" by
  `/tokenscope:activity`, "from .tokenscope", "from .claude/settings.json", or
  "folder default", the folder's `tokenscope.activity`). For a folder default,
  also say `activity.note`: it applies from the next session, and only if it is
  one of the region's activity types. A project from
  `.claude/settings.json` has only its `code_hash`; say the folder is tagged
  there. A null part is "none"; for no activity, mention `/tokenscope:activity`.
- **Last arrival (`last_landed`)**: when TokenScope last received usage from
  this computer. `source` `server` is a live answer; `cache` is the status
  line's last answer (TokenScope could not be asked just now, `checked_at` says
  when it was); `null` means it is not known (not set up, or never checked).
  Quote `last_landed.message`. Usage arrives about 4-5 min after it happens, so
  a time a few minutes old is normal; hours old during active use is worth
  re-running `/tokenscope:status` for, and then `/tokenscope:setup`.
- **Last recorded failure**: if `last_failure` is non-null, surface it (HTTP
  `last_failure.http_status`: `last_failure.message` at `last_failure.ts`). Even
  if the live probe now succeeds, a recent sentinel means emission flapped.
- For the attribution view (recent sessions / what's attributed) use the
  **`my_usage`** MCP tool or the TokenScope **web dashboard**.
- If `emitting` is false but they just set up: tell them to restart Claude Code.
  Claude reads telemetry config only at **startup**.
