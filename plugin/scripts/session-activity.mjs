#!/usr/bin/env node
/*
 * session-activity — the local note of what `/tokenscope:activity` set for a
 * session (#475), so the status line and /tokenscope:status can show it without
 * asking the server on every refresh.
 *
 * The SERVER is the record: `tag_session` (the MCP tool the command calls) writes
 * the tag and re-tags the session's usage. This file only remembers the answer
 * the server gave, per Claude session id, in this install's state dir
 * (`<state>/session-activity.json`, newest 200 sessions). A tag set elsewhere
 * (the web Tag dialog, another install) is not reflected here until the command
 * runs again; the status line then shows the folder default or nothing.
 *
 * CLI (called by the command after tag_session succeeds):
 *   node session-activity.mjs --session <id> --activity <label|""> [--project <code>]
 * An empty --activity records a cleared activity.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { isMainModule } from './is-main.mjs'
import { claudeInstallStateDir } from './plugin-runtime.mjs'

const FILE = 'session-activity.json'
const KEEP = 200
const SESSION_ID = /^[A-Za-z0-9-]{8,128}$/
// eslint-disable-next-line no-control-regex -- refusing control characters is the point
const LABEL = /^[^\u0000-\u001f\u007f]{0,64}$/
const CODE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,63}$/

function readAll(dir) {
  try {
    const parsed = JSON.parse(readFileSync(join(dir, FILE), 'utf8'))
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

/** What this install recorded for `sessionId`: { activity, project, at } or null. */
export function readSessionActivity(sessionId, dir = claudeInstallStateDir()) {
  if (typeof sessionId !== 'string' || !SESSION_ID.test(sessionId)) return null
  const e = readAll(dir)[sessionId]
  return e && typeof e === 'object' ? e : null
}

/** Record the server's answer for `sessionId`. Throws on a malformed argument. */
export function recordSessionActivity({ sessionId, activity, project = null, now = new Date() }, dir = claudeInstallStateDir()) {
  if (typeof sessionId !== 'string' || !SESSION_ID.test(sessionId)) throw new Error('session id is not a Claude session id')
  if (typeof activity !== 'string' || !LABEL.test(activity)) throw new Error('activity is not a label')
  if (project !== null && (typeof project !== 'string' || !CODE.test(project))) throw new Error('project is not a project code')
  const all = readAll(dir)
  all[sessionId] = { activity: activity.trim() || null, project, at: now.toISOString() }
  const kept = Object.fromEntries(
    Object.entries(all)
      .sort(([, a], [, b]) => String(b?.at ?? '').localeCompare(String(a?.at ?? '')))
      .slice(0, KEEP),
  )
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const tmp = join(dir, `${FILE}.tmp.${process.pid}.${randomBytes(6).toString('hex')}`)
  writeFileSync(tmp, `${JSON.stringify(kept, null, 2)}\n`, { mode: 0o600 })
  renameSync(tmp, join(dir, FILE))
  return all[sessionId]
}

function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i += 2) {
    const key = { '--session': 'sessionId', '--activity': 'activity', '--project': 'project' }[argv[i]]
    if (!key || key in out || i + 1 >= argv.length) throw new Error(`unexpected argument: ${argv[i]}`)
    out[key] = argv[i + 1]
  }
  return out
}

if (isMainModule(import.meta.url)) {
  try {
    const a = parseArgs(process.argv.slice(2))
    const saved = recordSessionActivity({ sessionId: a.sessionId, activity: a.activity ?? '', project: a.project || null })
    process.stdout.write(`${JSON.stringify({ ok: true, ...saved })}\n`)
  } catch (err) {
    process.stderr.write(`[tokenscope] ${err instanceof Error ? err.message : String(err)}\n`)
    process.exit(1)
  }
}
