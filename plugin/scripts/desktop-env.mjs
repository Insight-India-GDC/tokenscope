/*
 * Claude Desktop: put this device's resource attributes in the user's LOGIN
 * environment, because Desktop launches its bundled `claude` with its own
 * OTEL_RESOURCE_ATTRIBUTES and the settings-file value never reaches the OTel
 * resource (anthropics/claude-code#67657). Desktop merges an inherited value
 * into its own, so a login-environment value does reach Desktop sessions.
 *
 * Desktop only: setup calls this when it runs inside a Desktop session, and it
 * changes nothing for the CLI, which keeps reading its settings file. The value
 * is built from the instance id, never passed through, so nothing else can ride
 * into the user's environment. It carries only device-level keys: a per-repo
 * project tag cannot live in a user-wide variable.
 *
 * macOS: `launchctl setenv` now, plus a LaunchAgent that repeats it at login.
 * Windows: a user environment variable (setx, which tells running Explorer).
 * Both take effect for apps started afterwards, so the user restarts Desktop.
 * Linux: a systemd `environment.d` file, which the login session reads, so it
 * takes effect at the next login (verified on Fedora/sway 2026-10-10: apps
 * started from the launcher carry environment.d values, and
 * `systemctl --user set-environment` does not reach them until then).
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { windowsSystem32Path } from './emit-helper-spawn.mjs'
import { readSettingsEnv } from './plugin-runtime.mjs'
import { realHome } from './real-home.mjs'
import { claudeSettingsPath, projectSetsEnvKey } from './claude-config-dir.mjs'

export const DESKTOP_ENV_VAR = 'OTEL_RESOURCE_ATTRIBUTES'
export const LAUNCH_AGENT_LABEL = 'com.tokenscope.desktop-otel-env'

/**
 * The Claude desktop app sets CLAUDE_CODE_ENTRYPOINT=claude-desktop (verified on
 * macOS, Desktop 2.26454.2). Matched exactly; a near miss (`claude-desktop…`) is
 * reported by setup, never acted on.
 */
export const DESKTOP_ENTRYPOINT = 'claude-desktop'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function isDesktopSession(env = process.env) {
  return String(env.CLAUDE_CODE_ENTRYPOINT ?? '').trim() === DESKTOP_ENTRYPOINT
}

/** An entrypoint that looks like the app's but is not the verified value. */
export function isNearDesktopSession(env = process.env) {
  const e = String(env.CLAUDE_CODE_ENTRYPOINT ?? '').trim()
  return e !== DESKTOP_ENTRYPOINT && e.startsWith(DESKTOP_ENTRYPOINT)
}

/**
 * Whether a PROJECT settings file (`.claude/settings.json` or
 * `settings.local.json`, from `cwd` up to the root) sets CLAUDE_CODE_ENTRYPOINT.
 * Claude Code applies a project's `env` to the session, so a checked-out
 * repository could otherwise switch the Desktop step on in a CLI session. The
 * user's own `~/.claude/settings.json` is not a project file and stays trusted.
 *
 * This reads the files as they are now, so a session that changed directory or
 * a project that removed the key after loading defeats it. The bound on the harm
 * is the value: it is always this device's own labels (desktopAttrsValue), so a
 * spoof can only give a CLI user the Desktop users' setting, nothing else.
 */
export function projectSetsEntrypoint(cwd = process.cwd(), { home = realHome(), readEnv = readSettingsEnv } = {}) {
  const userFiles = [join(home, '.claude', 'settings.json'), claudeSettingsPath({ home, trustedHome: home, cwd })]
  return projectSetsEnvKey('CLAUDE_CODE_ENTRYPOINT', cwd, { userFiles, readEnv })
}

/** The Desktop gate: the app's entrypoint, not one a project's settings supplied. */
export function isTrustedDesktopSession(env = process.env, cwd = process.cwd(), opts) {
  return isDesktopSession(env) && !projectSetsEntrypoint(cwd, opts)
}

/** `tokenscope.instance_id=<id>,tool=claude-code`, or null for anything but a UUID. */
export function desktopAttrsValue(instanceId) {
  return typeof instanceId === 'string' && UUID.test(instanceId)
    ? `tokenscope.instance_id=${instanceId.toLowerCase()},tool=claude-code`
    : null
}

const XML = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }

/**
 * The login value with this device's labels in it: any other `key=value` pairs
 * the user already had are kept, ours replace any earlier tokenscope.instance_id
 * and tool. null when the existing value is not `key=value` pairs (left alone).
 */
export function mergeDesktopAttrs(existing, instanceId) {
  const ours = desktopAttrsValue(instanceId)
  if (!ours) return null
  const kept = []
  for (const seg of String(existing ?? '').split(',').map((s) => s.trim()).filter(Boolean)) {
    const eq = seg.indexOf('=')
    if (eq <= 0) return null
    const key = seg.slice(0, eq).trim()
    if (key !== 'tokenscope.instance_id' && key !== 'tool') kept.push(seg)
  }
  return [...kept, ours].join(',')
}

/** The LaunchAgent that re-applies the value at login. */
export function launchAgentPlist(value) {
  const v = String(value).replace(/[&<>"']/g, (c) => XML[c])
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCH_AGENT_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/launchctl</string>
    <string>setenv</string>
    <string>${DESKTOP_ENV_VAR}</string>
    <string>${v}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
</dict>
</plist>
`
}

const run = (file, args) => execFileSync(file, args, { stdio: ['ignore', 'pipe', 'pipe'], timeout: 10_000, encoding: 'utf8' })

/**
 * The Linux login-environment file. `~/.config` on the passwd home, not
 * XDG_CONFIG_HOME: that is environment a repository can set, and ~/.config is
 * where systemd looks by default. `90-` so it sorts after most user files.
 */
export function linuxEnvFilePath(home = realHome()) {
  return join(home, '.config', 'environment.d', '90-tokenscope.conf')
}

/**
 * The assignment APPENDS to whatever value the login already has (an earlier
 * environment.d file, or the user manager's own environment): environment.d
 * expands `${VAR:+${VAR},}` (verified with systemd 252's generator), so nothing
 * the user set is replaced and this file holds only TokenScope's labels.
 */
const LINUX_APPEND_PREFIX = `\${${DESKTOP_ENV_VAR}:+\${${DESKTOP_ENV_VAR}},}`

/** This file's own labels (the part after the append prefix), or null. */
export function parseLinuxEnvFile(text) {
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const m = line.match(/^\s*OTEL_RESOURCE_ATTRIBUTES=(.*)$/)
    if (!m) continue
    const v = m[1].trim()
    const ours = v.startsWith(LINUX_APPEND_PREFIX) ? v.slice(LINUX_APPEND_PREFIX.length) : v
    return ours || null
  }
  return null
}

/** The whole file: a header saying who wrote it, then the one assignment. */
export function linuxEnvFileText(labels) {
  return [
    '# Written by TokenScope setup (/tokenscope:setup in the Claude app). It labels',
    '# Claude app sessions with this device so their usage is linked to you.',
    '# Read at login; remove this file to stop. Rewritten by the next setup.',
    `${DESKTOP_ENV_VAR}=${LINUX_APPEND_PREFIX}${labels}`,
    '',
  ].join('\n')
}

/** Read the Linux file, or null when it is absent or unreadable. */
function readLinuxEnvFile(home, read = readFileSync) {
  try {
    return parseLinuxEnvFile(read(linuxEnvFilePath(home), 'utf8'))
  } catch {
    return null
  }
}

/**
 * Apply the value for `instanceId`. Returns `{ applied, how }`, or
 * `{ applied: false, reason }`. Never throws: setup has already succeeded.
 * Side effects are injectable for tests.
 */
export function applyDesktopEnv(
  instanceId,
  {
    platform = process.platform,
    home = realHome(),
    exec = run,
    write = writeFileSync,
    mkdir = mkdirSync,
    system32 = windowsSystem32Path,
    current = () => readDesktopEnv({ platform, exec, system32 }),
  } = {},
) {
  const labels = desktopAttrsValue(instanceId)
  if (!labels) return { applied: false, reason: 'no-instance' }
  if (platform === 'linux') {
    // Only this device's labels (a UUID and fixed keys), appended at login to
    // whatever the user already has, so there is nothing of theirs to merge.
    try {
      const file = linuxEnvFilePath(home)
      mkdir(join(home, '.config', 'environment.d'), { recursive: true })
      write(file, linuxEnvFileText(labels), { mode: 0o644 })
      return { applied: true, how: 'environment.d', file }
    } catch (err) {
      return { applied: false, reason: `failed: ${err.message}` }
    }
  }
  if (platform !== 'darwin' && platform !== 'win32') return { applied: false, reason: 'unsupported-platform' }
  const value = mergeDesktopAttrs(current(), instanceId)
  if (!value) return { applied: false, reason: `your login ${DESKTOP_ENV_VAR} is not key=value pairs; left unchanged` }
  try {
    if (platform === 'darwin') {
      const dir = join(home, 'Library', 'LaunchAgents')
      mkdir(dir, { recursive: true })
      write(join(dir, `${LAUNCH_AGENT_LABEL}.plist`), launchAgentPlist(value), { mode: 0o644 })
      exec('/bin/launchctl', ['setenv', DESKTOP_ENV_VAR, value])
      return { applied: true, how: 'launchctl' }
    }
    if (platform === 'win32') {
      const setx = system32('setx.exe')
      if (!setx) return { applied: false, reason: 'C:\\Windows\\System32\\setx.exe not found' }
      exec(setx, [DESKTOP_ENV_VAR, value])
      return { applied: true, how: 'setx' }
    }
    return { applied: false, reason: 'unsupported-platform' }
  } catch (err) {
    return { applied: false, reason: `failed: ${err.message}` }
  }
}

/**
 * The login-environment value, for status. null when unset or unreadable.
 * macOS: `launchctl getenv`. Windows: the user environment key in the registry.
 * Linux: the environment.d file setup writes, which is what the NEXT login gets.
 */
export function readDesktopEnv({
  platform = process.platform,
  exec = run,
  system32 = windowsSystem32Path,
  home = realHome(),
  read = readFileSync,
} = {}) {
  if (platform === 'linux') return readLinuxEnvFile(home, read)
  try {
    if (platform === 'darwin') return exec('/bin/launchctl', ['getenv', DESKTOP_ENV_VAR]).trim() || null
    if (platform === 'win32') {
      const reg = system32('reg.exe')
      if (!reg) return null
      const out = exec(reg, [
        'query',
        'HKCU\\Environment',
        '/v',
        DESKTOP_ENV_VAR,
      ])
      return out.match(/REG_(?:EXPAND_)?SZ\s+(.+)$/m)?.[1].trim() || null
    }
  } catch {
    /* unset, or the tool is unavailable */
  }
  return null
}

/** Every tokenscope.instance_id in an OTEL_RESOURCE_ATTRIBUTES string, lower-cased. */
function instanceIds(value) {
  return [...String(value ?? '').matchAll(/(?:^|,)\s*tokenscope\.instance_id=([^,]+)/g)].map((m) => m[1].trim().toLowerCase())
}

/** Whether `value` names `instanceId` and no other instance. */
function carriesInstance(value, instanceId) {
  const ids = instanceIds(value)
  const want = String(instanceId ?? '').toLowerCase()
  return Boolean(want) && ids.length > 0 && ids.every((id) => id === want)
}

/**
 * Status verdict. `ok`: this device is in the login environment (and, where
 * the session's own value is known, in this session too). `next-login` (Linux):
 * the file has it but this session started before it took effect. `duplicate`
 * (Linux): this session carries this device AND another instance, e.g. an old
 * value a user manager kept across logout; which one a record carries is not
 * ours to guess. `missing` / `mismatch`: setup has not put this device there.
 *
 * `sessionValue` is the session's own OTEL_RESOURCE_ATTRIBUTES when it can be
 * read (sessionDesktopAttrs, Linux), else undefined.
 */
export function desktopEnvVerdict(loginValue, instanceId, sessionValue = undefined) {
  if (sessionValue !== undefined && carriesInstance(sessionValue, instanceId)) return 'ok'
  if (sessionValue !== undefined && instanceId && instanceIds(sessionValue).includes(String(instanceId).toLowerCase())) {
    return 'duplicate'
  }
  if (!loginValue) return 'missing'
  if (!carriesInstance(loginValue, instanceId)) return 'mismatch'
  return sessionValue === undefined ? 'ok' : 'next-login'
}

/** What the user does after setup for the value to reach a new Desktop session. */
export function desktopRestartAdvice(platform = process.platform) {
  return platform === 'linux'
    ? 'log out of your computer and back in, then open the Claude app'
    : 'quit the Claude app completely and open it again'
}

/**
 * Linux only: OTEL_RESOURCE_ATTRIBUTES of this session's own `claude` process,
 * the nearest ancestor whose name is `claude`, or undefined when there is none
 * or it cannot be read. The tool shell does not carry OTEL_* and the app's own
 * process blanks its environ, so the session's `claude` process is the one
 * place the merged value can be seen. Only that one variable is extracted; the
 * rest of the environ (it holds credentials) is never kept or returned.
 * `readProc(pid, file)` is injectable for tests.
 */
export function sessionDesktopAttrs({
  platform = process.platform,
  pid = process.pid,
  readProc = (p, file) => readFileSync(`/proc/${p}/${file}`),
  maxDepth = 12,
} = {}) {
  if (platform !== 'linux') return undefined
  try {
    let cur = pid
    for (let i = 0; i < maxDepth && cur > 1; i++) {
      const status = readProc(cur, 'status').toString('utf8')
      const name = status.match(/^Name:\s*(.+)$/m)?.[1].trim()
      if (name === 'claude') {
        const environ = readProc(cur, 'environ')
        const prefix = `${DESKTOP_ENV_VAR}=`
        for (const entry of environ.toString('utf8').split('\0')) {
          if (entry.startsWith(prefix)) return entry.slice(prefix.length)
        }
        return ''
      }
      const ppid = Number(status.match(/^PPid:\s*(\d+)$/m)?.[1])
      if (!Number.isInteger(ppid) || ppid <= 0 || ppid === cur) return undefined
      cur = ppid
    }
  } catch {
    /* /proc unavailable or not ours to read */
  }
  return undefined
}
