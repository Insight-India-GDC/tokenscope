---
description: Tag this session with an activity (research, development, ...), or clear it
argument-hint: "[activity | clear]"
allowed-tools: mcp__plugin_tokenscope_tokenscope__tag_session, mcp__plugin_tokenscope_tokenscope__list_activity_types, mcp__tokenscope__tag_session, mcp__tokenscope__list_activity_types, Bash(node "${CLAUDE_PLUGIN_ROOT}/scripts/session-activity.mjs":*)
---

Tag the **current** Claude Code session with an activity, so its usage shows
what the work was. The last choice wins, and it re-tags the usage this session
has already recorded.

This session's id is `${CLAUDE_SESSION_ID}`. Use it as is; never ask the user
for a session id.

The argument is: `$ARGUMENTS`

## Steps

1. **Check the session id.** If the id above is empty, or still reads literally
   as a dollar sign and `CLAUDE_SESSION_ID` in braces, this Claude Code version
   cannot name its own session. Say so in one line ("This Claude Code version
   can't tag its own session from a command; use the TokenScope tag prompt, or
   tag it on the web under Recent sessions"), and stop.

2. **No argument:** call `list_activity_types`. Show the suggestions as a short
   numbered list, and ask which one (or another label of theirs). Then continue
   with their answer as the argument.

3. **`clear`:** call `tag_session` with `session_id` = the id above and
   `activity: null`.

4. **Anything else:** call `tag_session` with `session_id` = the id above and
   `activity` = the argument, trimmed. Use their wording. If it matches a
   suggestion from `list_activity_types` apart from case, use the suggestion's
   spelling. Do not send `project_id`: the project stays as it is.

5. **Remember it locally**, so the status line shows it. Run this, with the
   `activity` and `project_code` that `tag_session` returned (an empty string
   for a cleared activity; leave out `--project` when `project_code` is null):

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/session-activity.mjs" --session "${CLAUDE_SESSION_ID}" --activity "<activity>" --project "<project_code>"
   ```

   If `node` is not found (a Windows device set up without Node), skip this
   step: the tag is saved on TokenScope either way.

6. **Reply in one line:**
   - set: "This session is now tagged <activity> (project <project_code>)."
     Use "(no project)" when `project_code` is null.
   - cleared: "This session's own activity is cleared." If the folder has a
     default activity (below), add: "New usage gets the folder default."

## When `tag_session` fails

- **"not recorded yet"**: TokenScope has not received any usage from this
  session yet. It usually arrives within about 5 minutes of the first reply.
  Say so, and suggest running the command again shortly.
- **Not authenticated, or a missing scope**: say "You're not signed in to
  TokenScope in this chat: run `/mcp`, choose tokenscope and approve in your
  browser, then run `/tokenscope:activity` again."
- **Anything else**: quote the error in one line. Do not retry with another
  session id.

## A default for this folder

To tag every new session started in this folder with an activity, put it in
the folder's `.claude/settings.local.json` (the personal file Claude Code keeps
out of git; never `.claude/settings.json` or `.tokenscope`, which are shared):

```json
{ "tokenscope": { "activity": "research" } }
```

It applies from the next session. TokenScope keeps it only when it is one of
your region's activity types (your own custom labels are not accepted as a
folder default), and a tag set with this command always wins over it. A name
that is not kept is still sent with the session's telemetry, so put only an
activity name there.
