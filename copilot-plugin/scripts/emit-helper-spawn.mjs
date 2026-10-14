// SYNC NOTE: Auto-generated copy for standalone copilot-plugin distribution. Source: plugin/scripts/emit-helper-spawn.mjs. Re-generate with: npm run sync:copilot-plugin
/*
 * emit-helper-spawn — the ONE answer to "which program runs the headers helper,
 * with which arguments" for every Node caller that mints a bearer by spawning it
 * (#408 S5/S7): the /tokenscope:status and session-start probe (runEmitHelper),
 * backfill, the Copilot lane's mintBearer and the Copilot status probe.
 *
 * POSIX: `/bin/sh <helper>.sh --state-dir <dir> --tool <tool>`, unchanged.
 * Windows: `<SystemRoot>\System32\WindowsPowerShell\v1.0\powershell.exe -NoProfile
 * -NonInteractive -ExecutionPolicy Bypass -File <helper>.ps1 --state-dir <dir>
 * --tool <tool>`, the same shape buildHelperCommand writes into otelHeadersHelper.
 *
 * NEITHER INTERPRETER IS RESOLVED THROUGH PATH. A repository can set PATH for
 * the Claude lane (the settings merge; docs/security-sprint/env-precedence-capture.md),
 * and whichever binary we run is handed the refresh token through its env.
 *
 * WHERE WINDOWS IS. `SystemRoot` is an environment variable, and on the Claude
 * lane the environment is repo-mergeable too, so it is NOT trusted first. The
 * fixed `C:\Windows` is tried first; `SystemRoot` is consulted only when that
 * does not exist (Windows installed on another drive), and only in the shape
 * `<drive>:\Windows`. Trade-off, stated: on a machine whose Windows is not on
 * C:, a repository that can also create `<drive>:\Windows\System32\...\powershell.exe`
 * on some other drive could pick the binary. That needs a planted directory tree
 * at a drive root, not just an env value, and the machines it reaches are the
 * rare non-C: installs. Nothing found -> null, and every caller fails closed.
 *
 * Dependency-free (node built-ins only) so it vendors verbatim into
 * copilot-plugin/scripts/ (gated by scripts/check-copilot-plugin-sync.mjs).
 */
import { existsSync } from 'node:fs'
import { win32 } from 'node:path'

/** The helper script a platform runs: PowerShell on Windows, `sh` elsewhere. */
export function helperScriptName(platform) {
  return platform === 'win32' ? 'otel-headers-helper.ps1' : 'otel-headers-helper.sh'
}

const POWERSHELL_TAIL = ['System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe']
const DEFAULT_WINDOWS_DIR = 'C:\\Windows'
const DRIVE_WINDOWS_DIR = /^[A-Za-z]:\\Windows\\?$/i

/** Where Windows PowerShell 5.1 lives on a Windows installed on C:. */
export const DEFAULT_WINDOWS_POWERSHELL = win32.join(DEFAULT_WINDOWS_DIR, ...POWERSHELL_TAIL)

/**
 * Absolute path of Windows PowerShell 5.1, or null. `env` and `exists` are
 * injectable so the resolution can be tested off Windows.
 */
export function windowsPowerShellPath({ env = process.env, exists = existsSync } = {}) {
  const fixed = DEFAULT_WINDOWS_POWERSHELL
  if (exists(fixed)) return fixed
  const sr = typeof env.SystemRoot === 'string' ? env.SystemRoot.trim() : ''
  if (!DRIVE_WINDOWS_DIR.test(sr)) return null
  const fromEnv = win32.join(sr, ...POWERSHELL_TAIL)
  return exists(fromEnv) ? fromEnv : null
}

/**
 * Absolute path of `C:\Windows\System32\<name>` (setx.exe, reg.exe), or null.
 * The fixed path only, never SystemRoot: a repository's settings can set that,
 * and a `<drive>:\Windows` shape check does not prove a directory is Windows'
 * own. A Windows installed elsewhere gets null, and the caller says so.
 */
export function windowsSystem32Path(name, { exists = existsSync } = {}) {
  const fixed = win32.join(DEFAULT_WINDOWS_DIR, 'System32', name)
  return exists(fixed) ? fixed : null
}

/**
 * `{ file, args }` for spawning the helper at `helper` (an absolute path to the
 * platform's script, see helperScriptName), or null when Windows PowerShell
 * cannot be found. `powershell` replaces the resolved executable: a FUNCTION
 * ARGUMENT for tests (they run the .ps1 under `pwsh` on Linux), never read from
 * the environment, so nothing a repository sets can choose it.
 */
export function emitHelperSpawn({
  helper,
  stateDir,
  tool,
  platform = process.platform,
  env = process.env,
  exists = existsSync,
  powershell,
}) {
  const tail = [...(stateDir ? ['--state-dir', stateDir] : []), '--tool', tool]
  if (platform !== 'win32') return { file: '/bin/sh', args: [helper, ...tail] }
  const file = powershell ?? windowsPowerShellPath({ env, exists })
  if (!file) return null
  return {
    file,
    args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', helper, ...tail],
  }
}
