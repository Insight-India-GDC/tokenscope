/*
 * desktop-env.mjs: the Claude Desktop-only step that puts this device's resource
 * attributes in the user's login environment (anthropics/claude-code#67657).
 * Every side effect is injected, so this runs on any OS and touches nothing.
 */
import { describe, it, expect } from 'vitest'
import {
  DESKTOP_ENV_VAR,
  LAUNCH_AGENT_LABEL,
  applyDesktopEnv,
  desktopAttrsValue,
  desktopEnvVerdict,
  isDesktopSession,
  isTrustedDesktopSession,
  isNearDesktopSession,
  launchAgentPlist,
  linuxEnvFilePath,
  linuxEnvFileText,
  mergeDesktopAttrs,
  parseLinuxEnvFile,
  projectSetsEntrypoint,
  readDesktopEnv,
  desktopRestartAdvice,
  sessionDesktopAttrs,
} from '../../../plugin/scripts/desktop-env.mjs'

// Windows (#430): skipped on win32 because this file expects the macOS LaunchAgent path under /Users.
const POSIX_ONLY = process.platform === 'win32'

const IID = '273f7fb3-7001-40a7-9096-3592d14a2328'
const VALUE = `tokenscope.instance_id=${IID},tool=claude-code`

function recorder() {
  const calls: { kind: string; args: unknown[] }[] = []
  return {
    calls,
    exec: (file: string, args: string[]) => {
      calls.push({ kind: 'exec', args: [file, ...args] })
      return ''
    },
    write: (path: string, data: string) => calls.push({ kind: 'write', args: [path, data] }),
    mkdir: (path: string) => calls.push({ kind: 'mkdir', args: [path] }),
  }
}

describe.skipIf(POSIX_ONLY)('isDesktopSession: only the Claude app runs this', () => {
  it('is true for the app’s entrypoint and false for everything else, the CLI included', () => {
    expect(isDesktopSession({ CLAUDE_CODE_ENTRYPOINT: 'claude-desktop' })).toBe(true)
    // Exact only: a near miss is reported by setup, never acted on.
    expect(isDesktopSession({ CLAUDE_CODE_ENTRYPOINT: 'claude-desktop-win' })).toBe(false)
    expect(isNearDesktopSession({ CLAUDE_CODE_ENTRYPOINT: 'claude-desktop-win' })).toBe(true)
    expect(isNearDesktopSession({ CLAUDE_CODE_ENTRYPOINT: 'claude-desktop' })).toBe(false)
    for (const e of ['cli', 'sdk-ts', 'claude-vscode', '', undefined]) {
      expect(isDesktopSession({ CLAUDE_CODE_ENTRYPOINT: e })).toBe(false)
    }
  })
})

describe.skipIf(POSIX_ONLY)('desktopAttrsValue: built from the instance id, never passed through', () => {
  it('carries only the device keys', () => {
    expect(desktopAttrsValue(IID)).toBe(VALUE)
    expect(desktopAttrsValue(IID.toUpperCase())).toBe(VALUE)
  })

  it('refuses anything that is not a UUID, so nothing else rides into the environment', () => {
    for (const bad of ['', 'x', `${IID},project.code_hash=abc`, `${IID}<string>`, null, undefined, 42]) {
      expect(desktopAttrsValue(bad as string)).toBeNull()
    }
  })
})

describe.skipIf(POSIX_ONLY)('applyDesktopEnv', () => {
  it('macOS: writes the LaunchAgent for later logins and sets the value now', () => {
    const r = recorder()
    expect(applyDesktopEnv(IID, { platform: 'darwin', home: '/Users/x', ...r, current: () => null })).toEqual({
      applied: true,
      how: 'launchctl',
    })
    const write = r.calls.find((c) => c.kind === 'write')!
    expect(write.args[0]).toBe(`/Users/x/Library/LaunchAgents/${LAUNCH_AGENT_LABEL}.plist`)
    expect(write.args[1]).toBe(launchAgentPlist(VALUE))
    expect(r.calls.find((c) => c.kind === 'exec')!.args).toEqual(['/bin/launchctl', 'setenv', DESKTOP_ENV_VAR, VALUE])
  })

  it('the LaunchAgent re-runs launchctl setenv at login with exactly that value', () => {
    const plist = launchAgentPlist(VALUE)
    expect(plist).toContain('<string>/bin/launchctl</string>')
    expect(plist).toContain(`<string>${DESKTOP_ENV_VAR}</string>`)
    expect(plist).toContain(`<string>${VALUE}</string>`)
    expect(plist).toContain('<key>RunAtLoad</key>')
  })

  it('Windows: sets a user environment variable with the validated setx.exe', () => {
    const r = recorder()
    const system32 = (n: string) => `C:\\Windows\\System32\\${n}`
    expect(applyDesktopEnv(IID, { platform: 'win32', ...r, system32, current: () => null })).toEqual({ applied: true, how: 'setx' })
    expect(r.calls[0]!.args).toEqual(['C:\\Windows\\System32\\setx.exe', DESKTOP_ENV_VAR, VALUE])
  })

  it('Windows: runs nothing when no trusted setx.exe resolves (never a SystemRoot a repo chose)', () => {
    const r = recorder()
    expect(applyDesktopEnv(IID, { platform: 'win32', ...r, system32: () => null, current: () => null })).toEqual({
      applied: false,
      reason: 'C:\\Windows\\System32\\setx.exe not found',
    })
    expect(r.calls).toEqual([])
  })

  it('does nothing on other platforms, or without a usable instance id', () => {
    const r = recorder()
    expect(applyDesktopEnv(IID, { platform: 'freebsd', ...r })).toEqual({ applied: false, reason: 'unsupported-platform' })
    expect(applyDesktopEnv('nope', { platform: 'darwin', ...r })).toEqual({ applied: false, reason: 'no-instance' })
    expect(applyDesktopEnv('nope', { platform: 'linux', ...r })).toEqual({ applied: false, reason: 'no-instance' })
    expect(r.calls).toEqual([])
  })

  it('Linux: writes one environment.d file under the passwd home, and runs nothing', () => {
    const r = recorder()
    const home = '/home/u'
    const out = applyDesktopEnv(IID, { platform: 'linux', home, ...r })
    const file = '/home/u/.config/environment.d/90-tokenscope.conf'
    expect(out).toEqual({ applied: true, how: 'environment.d', file })
    expect(linuxEnvFilePath(home)).toBe(file)
    expect(r.calls.filter((c) => c.kind === 'exec')).toEqual([])
    const written = r.calls.find((c) => c.kind === 'write')!
    expect(written.args[0]).toBe(file)
    // It appends to whatever the login already has, so nothing of the user's
    // is replaced, and holds only this device's labels.
    expect(String(written.args[1])).toContain(
      `OTEL_RESOURCE_ATTRIBUTES=\${OTEL_RESOURCE_ATTRIBUTES:+\${OTEL_RESOURCE_ATTRIBUTES},}${VALUE}\n`,
    )
  })

  it('Linux: a write failure is reported, not thrown', () => {
    const out = applyDesktopEnv(IID, {
      platform: 'linux',
      home: '/home/u',
      mkdir: () => undefined,
      write: () => {
        throw new Error('EACCES')
      },
    })
    expect(out).toEqual({ applied: false, reason: 'failed: EACCES' })
  })

  it('reports a failure instead of throwing: setup has already succeeded', () => {
    const r = recorder()
    const out = applyDesktopEnv(IID, {
      platform: 'darwin',
      home: '/Users/x',
      ...r,
      current: () => null,
      exec: () => {
        throw new Error('launchctl refused')
      },
    })
    expect(out).toEqual({ applied: false, reason: 'failed: launchctl refused' })
  })
})

describe.skipIf(POSIX_ONLY)('mergeDesktopAttrs: the user’s own login attributes survive', () => {
  it('keeps other key=value pairs and replaces only ours', () => {
    expect(mergeDesktopAttrs(null, IID)).toBe(VALUE)
    expect(mergeDesktopAttrs('deployment.env=prod, team=apac', IID)).toBe(`deployment.env=prod,team=apac,${VALUE}`)
    expect(
      mergeDesktopAttrs('tokenscope.instance_id=9a1e0000-0000-4000-8000-000000000001,tool=copilot-cli,team=apac', IID),
    ).toBe(`team=apac,${VALUE}`)
  })

  it('leaves a value that is not key=value pairs alone', () => {
    expect(mergeDesktopAttrs('just-a-word', IID)).toBeNull()
    expect(mergeDesktopAttrs('=x', IID)).toBeNull()
  })

  it('apply writes the merged value, and refuses rather than overwrite a malformed one', () => {
    const r = recorder()
    applyDesktopEnv(IID, { platform: 'darwin', home: '/Users/x', ...r, current: () => 'team=apac' })
    expect(r.calls.find((c) => c.kind === 'exec')!.args.at(-1)).toBe(`team=apac,${VALUE}`)
    const r2 = recorder()
    expect(applyDesktopEnv(IID, { platform: 'darwin', home: '/Users/x', ...r2, current: () => 'oops' }).applied).toBe(false)
    expect(r2.calls).toEqual([])
  })

  it('the LaunchAgent escapes a kept value for XML', () => {
    expect(launchAgentPlist(`a=<b>&"c",${VALUE}`)).toContain(`<string>a=&lt;b&gt;&amp;&quot;c&quot;,${VALUE}</string>`)
  })
})

describe.skipIf(POSIX_ONLY)('readDesktopEnv and desktopEnvVerdict (status)', () => {
  it('reads launchctl on macOS and the user environment key on Windows', () => {
    expect(readDesktopEnv({ platform: 'darwin', exec: () => `${VALUE}\n` })).toBe(VALUE)
    const reg = `\r\nHKEY_CURRENT_USER\\Environment\r\n    OTEL_RESOURCE_ATTRIBUTES    REG_SZ    ${VALUE}\r\n`
    const system32 = (n: string) => `C:\\Windows\\System32\\${n}`
    expect(readDesktopEnv({ platform: 'win32', exec: () => reg, system32 })).toBe(VALUE)
    expect(readDesktopEnv({ platform: 'win32', exec: () => reg, system32: () => null })).toBeNull()
    expect(readDesktopEnv({ platform: 'darwin', exec: () => '\n' })).toBeNull()
    expect(
      readDesktopEnv({
        platform: 'win32',
        system32,
        exec: () => {
          throw new Error('not found')
        },
      }),
    ).toBeNull()
  })

  it('reads the environment.d file on Linux: its own labels, not the append prefix', () => {
    const text = linuxEnvFileText(VALUE)
    expect(parseLinuxEnvFile(text)).toBe(VALUE)
    expect(readDesktopEnv({ platform: 'linux', home: '/home/u', read: () => text })).toBe(VALUE)
    expect(
      readDesktopEnv({
        platform: 'linux',
        home: '/home/u',
        read: () => {
          throw new Error('ENOENT')
        },
      }),
    ).toBeNull()
    expect(parseLinuxEnvFile('# nothing here\n')).toBeNull()
  })

  it('with the session’s own value (Linux): ok in this session, next-login when only the file has it', () => {
    expect(desktopEnvVerdict(VALUE, IID, `service.name=claude-code-desktop,${VALUE},process.owner=u`)).toBe('ok')
    expect(desktopEnvVerdict(VALUE, IID, 'service.name=claude-code-desktop,process.owner=u')).toBe('next-login')
    expect(desktopEnvVerdict(VALUE, IID, '')).toBe('next-login')
    expect(desktopEnvVerdict(null, IID, 'service.name=claude-code-desktop')).toBe('missing')
    // The session carrying the device is enough, whatever the file says now.
    expect(desktopEnvVerdict(null, IID, VALUE)).toBe('ok')
    // An older device label kept alongside (a user manager that outlived the
    // logout): not ok, and not "run setup again" either.
    const old = 'tokenscope.instance_id=9a1e0000-0000-4000-8000-000000000001,tool=claude-code'
    expect(desktopEnvVerdict(VALUE, IID, `service.name=x,${old},${VALUE}`)).toBe('duplicate')
    expect(desktopEnvVerdict(VALUE, IID, `service.name=x,${old}`)).toBe('next-login')
  })

  it('restart advice: log out on Linux, quit the app elsewhere', () => {
    expect(desktopRestartAdvice('linux')).toBe('log out of your computer and back in, then open the Claude app')
    expect(desktopRestartAdvice('darwin')).toBe('quit the Claude app completely and open it again')
    expect(desktopRestartAdvice('win32')).toBe('quit the Claude app completely and open it again')
  })

  it('ok only when the login value names this device', () => {
    expect(desktopEnvVerdict(VALUE, IID)).toBe('ok')
    expect(desktopEnvVerdict(`service.name=x,${VALUE}`, IID.toUpperCase())).toBe('ok')
    expect(desktopEnvVerdict(null, IID)).toBe('missing')
    expect(desktopEnvVerdict('tokenscope.instance_id=9a1e0000-0000-4000-8000-000000000001,tool=claude-code', IID)).toBe(
      'mismatch',
    )
    expect(desktopEnvVerdict(VALUE, null)).toBe('mismatch')
  })
})

describe.skipIf(POSIX_ONLY)('sessionDesktopAttrs (Linux): the session’s own claude process', () => {
  type Proc = { name: string; ppid: number; environ?: string }
  const tree = (procs: Record<number, Proc>) => {
    const read: string[] = []
    return {
      read,
      readProc: (pid: number, file: string) => {
        read.push(`${pid}/${file}`)
        const p = procs[pid]
        if (!p) throw new Error('ENOENT')
        if (file === 'status') return Buffer.from(`Name:\t${p.name}\nState:\tS\nPPid:\t${p.ppid}\n`)
        if (file === 'environ') return Buffer.from(p.environ ?? '')
        throw new Error('unexpected file')
      },
    }
  }

  it('walks up from the shell to the nearest claude and returns only that variable', () => {
    const t = tree({
      300: { name: 'node', ppid: 200 },
      200: { name: 'bash', ppid: 100 },
      100: {
        name: 'claude',
        ppid: 50,
        environ: `TOKENSCOPE_OAUTH_REFRESH_TOKEN=rt_SECRET\0OTEL_RESOURCE_ATTRIBUTES=service.name=claude-code-desktop,${VALUE}\0HOME=/home/u\0`,
      },
      50: { name: 'claude-desktop', ppid: 1 },
    })
    const v = sessionDesktopAttrs({ platform: 'linux', pid: 300, readProc: t.readProc })
    expect(v).toBe(`service.name=claude-code-desktop,${VALUE}`)
    expect(v).not.toContain('rt_SECRET')
    // It stops at the first claude: the app's own process is never read.
    expect(t.read).not.toContain('50/status')
  })

  it('a claude without the variable is an empty value; no claude, or /proc unreadable, is unknown', () => {
    expect(
      sessionDesktopAttrs({ platform: 'linux', pid: 2, readProc: tree({ 2: { name: 'claude', ppid: 1, environ: 'A=b\0' } }).readProc }),
    ).toBe('')
    expect(
      sessionDesktopAttrs({ platform: 'linux', pid: 3, readProc: tree({ 3: { name: 'bash', ppid: 1 } }).readProc }),
    ).toBeUndefined()
    expect(sessionDesktopAttrs({ platform: 'linux', pid: 9, readProc: tree({}).readProc })).toBeUndefined()
    expect(sessionDesktopAttrs({ platform: 'darwin' })).toBeUndefined()
  })
})

describe.skipIf(POSIX_ONLY)('the Desktop gate trusts only the app, not a project’s settings', () => {
  const settings = (map: Record<string, Record<string, string>>) => (path: string) => map[path] ?? {}

  it('a project .claude/settings(.local).json that sets the entrypoint, at or above cwd, disables the gate', () => {
    const home = '/home/u'
    for (const path of ['/w/repo/.claude/settings.local.json', '/w/repo/.claude/settings.json', '/w/.claude/settings.json']) {
      const readEnv = settings({ [path]: { CLAUDE_CODE_ENTRYPOINT: 'claude-desktop' } })
      expect(projectSetsEntrypoint('/w/repo/sub', { home, readEnv })).toBe(true)
      expect(isTrustedDesktopSession({ CLAUDE_CODE_ENTRYPOINT: 'claude-desktop' }, '/w/repo/sub', { home, readEnv })).toBe(false)
    }
  })

  it('the user’s own ~/.claude/settings.json and unrelated keys do not', () => {
    const home = '/home/u'
    const readEnv = settings({
      '/home/u/.claude/settings.json': { CLAUDE_CODE_ENTRYPOINT: 'claude-desktop' },
      '/home/u/repo/.claude/settings.local.json': { OTEL_RESOURCE_ATTRIBUTES: 'x' },
    })
    expect(projectSetsEntrypoint('/home/u/repo', { home, readEnv })).toBe(false)
    expect(isTrustedDesktopSession({ CLAUDE_CODE_ENTRYPOINT: 'claude-desktop' }, '/home/u/repo', { home, readEnv })).toBe(true)
  })
})

describe.skipIf(POSIX_ONLY)('setup (claude-redeem.mjs): the Desktop step never runs outside the Claude app', () => {
  it('outside Desktop it does not touch the environment and prints nothing', async () => {
    const { desktopSetupStep } = await import('../../../plugin/scripts/claude-redeem.mjs')
    let called = 0
    const apply = () => {
      called++
      return { applied: true, how: 'launchctl' }
    }
    for (const e of ['cli', 'claude-vscode', undefined]) {
      expect(desktopSetupStep(IID, { CLAUDE_CODE_ENTRYPOINT: e }, apply)).toEqual([])
    }
    expect(called).toBe(0)
  })

  it('in Desktop it applies once, and says to restart the app', async () => {
    const { desktopSetupStep } = await import('../../../plugin/scripts/claude-redeem.mjs')
    const seen: string[] = []
    const lines = desktopSetupStep(
      IID,
      { CLAUDE_CODE_ENTRYPOINT: 'claude-desktop' },
      (id: string) => {
        seen.push(id)
        return { applied: true, how: 'launchctl' }
      },
      () => true,
      'darwin',
    )
    expect(seen).toEqual([IID])
    expect(lines.join('\n')).toContain('Quit the Claude app completely')
    // Linux: the file takes effect at the next login, so it says to log out, and names the file.
    const linux = desktopSetupStep(
      IID,
      { CLAUDE_CODE_ENTRYPOINT: 'claude-desktop' },
      () => ({ applied: true, how: 'environment.d', file: '/home/u/.config/environment.d/90-tokenscope.conf' }),
      () => true,
      'linux',
    ).join('\n')
    expect(linux).toContain('(/home/u/.config/environment.d/90-tokenscope.conf)')
    expect(linux).toContain('Next: Log out of your computer and back in, then open the Claude app.')
    expect(linux).not.toContain('Quit the Claude app')
    // A near-miss entrypoint is reported, never acted on.
    expect(desktopSetupStep(IID, { CLAUDE_CODE_ENTRYPOINT: 'claude-desktop-x' }, () => ({ applied: true }), () => true)[0]).toMatch(
      /^\[tokenscope\] WARN: CLAUDE_CODE_ENTRYPOINT is "claude-desktop-x"/,
    )
    // A project that supplied the entrypoint gets nothing, even in the app.
    expect(desktopSetupStep(IID, { CLAUDE_CODE_ENTRYPOINT: 'claude-desktop' }, () => ({ applied: true }), () => false)).toEqual([])
    expect(
      desktopSetupStep(IID, { CLAUDE_CODE_ENTRYPOINT: 'claude-desktop' }, () => ({ applied: false, reason: 'failed: x' }), () => true),
    ).toEqual([
      '[tokenscope] WARN: Desktop sessions will not be attributed: could not set your login environment (failed: x).',
      // Its own next step, so setup does not add "restart Claude Code" after it.
      '[tokenscope]   Next: quit the Claude app completely and open it again: usage is sent, but is not linked to you until that is fixed and setup is run again.',
    ])
  })
})

describe.skipIf(POSIX_ONLY)('windowsSystem32Path (emit-helper-spawn.mjs)', () => {
  it('the fixed C:\\Windows path only; SystemRoot is never consulted', async () => {
    const { windowsSystem32Path } = await import('../../../plugin/scripts/emit-helper-spawn.mjs')
    const has = (paths: string[]) => (p: string) => paths.includes(p)
    expect(windowsSystem32Path('setx.exe', { exists: has(['C:\\Windows\\System32\\setx.exe']) })).toBe(
      'C:\\Windows\\System32\\setx.exe',
    )
    // A Windows on another drive, or a SystemRoot a repo planted: null, nothing runs.
    expect(windowsSystem32Path('setx.exe', { exists: has(['D:\\Windows\\System32\\setx.exe']) })).toBeNull()
  })
})
