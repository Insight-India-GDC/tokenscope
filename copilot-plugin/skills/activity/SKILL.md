---
description: Tag this Copilot session with an activity (research, development, ...), or clear it
argument-hint: '[activity | clear]'
---

# activity: tag this session with what the work is

Tag the **current** Copilot CLI session with an activity, so its usage in
TokenScope shows what the work was. The last choice wins, and it re-tags the
usage this session has already recorded.

## Steps

1. **Find this session.** Copilot CLI does not tell a skill its own session id,
   so ask the TokenScope plugin which session last sent usage from this folder
   (run it from the folder Copilot was started in):

   ```bash
   sh -c 's=$(ls -d "$HOME"/.copilot/installed-plugins/*/tokenscope-copilot/scripts/copilot-session.mjs 2>/dev/null | grep -v "/installed-plugins/_direct/" | sort -V | tail -n1); [ -n "$s" ] || s=$(for d in "$HOME"/.copilot/installed-plugins/_direct/*/; do [ -f "${d}scripts/copilot-session.mjs" ] && node -e "try{process.exit(JSON.parse(require(\"fs\").readFileSync(process.argv[1],\"utf8\")).name===\"tokenscope\"?0:1)}catch(e){process.exit(1)}" "${d}plugin.json" 2>/dev/null && echo "${d}scripts/copilot-session.mjs"; done | sort -V | tail -n1);
     [ -n "$s" ] || { echo "copilot-session.mjs not found — is the tokenscope plugin installed?" >&2; exit 1; }
     exec node "$s"'
   ```

   It prints `{"session_id": "...", "at": "..."}`, or a null
   `session_id` when nothing was sent from this folder in the last two
   hours. When it is null, say so in one line ("TokenScope hasn't received
   usage from this session yet; it arrives a few minutes after your first
   prompt. Run this again shortly, or tag it on the web under Recent sessions."),
   and stop. Never ask the user to paste an id.

2. **No argument:** call `list_activity_types`. Show the suggestions as a short
   numbered list and ask which one (or another label of theirs).

3. **`clear`:** call `tag_session` with `session_id` = the `session_id`
   and `activity: null`.

4. **Anything else:** call `tag_session` with `session_id` = the
   `session_id` and `activity` = the argument, trimmed. If it matches a
   suggestion apart from case, use the suggestion's spelling. Do not send
   `project_id`.

5. **Reply in one line**, naming the session briefly so it is clear which one
   was tagged (with two Copilot sessions in one folder it is the one that last
   sent usage):
   - set: "This session (<first 8 characters of the id>) is now tagged <activity> (project <project_code>)." Use "(no project)" when `project_code` is null.
   - cleared: "This session's own activity is cleared." If the folder has a
     default activity (below), add: "New usage gets the folder default."

If `tag_session` says the session is not recorded yet, say usage arrives within
about 5 minutes and to try again. If it says you are not signed in, tell them to
sign in to the TokenScope MCP server and run this again.

## A default for this folder

To tag every new session in this folder, put the activity in the folder's
`.claude/settings.local.json` (a personal file, kept out of git; never the
committed `.tokenscope`):

```json
{ "tokenscope": { "activity": "research" } }
```

TokenScope keeps it only when it is one of your region's activity types, and a
tag set with this skill always wins over it. A name that is not kept is still
sent with the session's telemetry, so put only an activity name there.
