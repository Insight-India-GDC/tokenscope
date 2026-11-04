#!/usr/bin/env node
// SYNC NOTE: Auto-generated copy for standalone copilot-plugin distribution. Source: plugin/scripts/copilot-session.mjs. Re-generate with: npm run sync:copilot-plugin
/*
 * copilot-session — the Copilot session that last sent usage from a folder
 * (#475), so the Copilot `activity` skill can tag "this session" without asking
 * for an id: Copilot CLI does not hand a skill its own session id.
 *
 * The senders (the usage extension, copilot-usage.mjs, and the legacy file
 * forwarder) note the session after each successful send, in the TokenScope
 * state folder (`~/.tokenscope/copilot-last-session/<key>.json`, keyed by the
 * session's folder), never in the project folder itself. With two Copilot
 * sessions open in one folder the note names the one that last sent usage; the
 * skill says which id it tagged.
 *
 * CLI (the skill, run from the session's folder): prints
 * `{"session_id": "...", "at": "..."}` for a note from the last two hours, else
 * `{"session_id": null, "reason": "..."}`.
 */
import fs from 'node:fs'
import { join, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { isMainModule } from './is-main.mjs'
import { TOKENSCOPE_DIR } from './copilot-emit.mjs'

const DIRNAME = 'copilot-last-session'
const FRESH_MS = 2 * 60 * 60 * 1000
const SAFE_ID = /^[A-Za-z0-9-]{8,128}$/

function noteFile(cwd, stateDir) {
  let dir = resolve(cwd)
  try {
    dir = fs.realpathSync(dir)
  } catch {
    /* the folder as given */
  }
  return join(stateDir, DIRNAME, `${createHash('sha256').update(dir).digest('hex').slice(0, 16)}.json`)
}

/** Note that `sessionId` just sent usage from `cwd`. Best-effort, never throws. */
export function recordLastSession(sessionId, cwd, stateDir = TOKENSCOPE_DIR, now = new Date()) {
  try {
    if (typeof sessionId !== 'string' || !SAFE_ID.test(sessionId)) return
    const file = noteFile(cwd, stateDir)
    fs.mkdirSync(join(stateDir, DIRNAME), { recursive: true, mode: 0o700 })
    fs.writeFileSync(file, `${JSON.stringify({ session_id: sessionId, at: now.toISOString() })}\n`, { mode: 0o600 })
  } catch {
    /* best-effort */
  }
}

/** The session that last sent usage from `cwd` within two hours, or a reason it is unknown. */
export function lastSession(cwd = process.cwd(), stateDir = TOKENSCOPE_DIR, now = Date.now()) {
  try {
    const note = JSON.parse(fs.readFileSync(noteFile(cwd, stateDir), 'utf8'))
    const id = typeof note?.session_id === 'string' && SAFE_ID.test(note.session_id) ? note.session_id : null
    const at = Date.parse(note?.at ?? '')
    // Fresh means the last two hours, and not dated in the future (beyond a little clock skew).
    if (!id || !(at > now - FRESH_MS && at <= now + 5 * 60 * 1000)) return { session_id: null, reason: 'none-recent' }
    return { session_id: id, at: note.at }
  } catch {
    return { session_id: null, reason: 'none-yet' }
  }
}

if (isMainModule(import.meta.url)) {
  process.stdout.write(`${JSON.stringify(lastSession())}\n`)
}
