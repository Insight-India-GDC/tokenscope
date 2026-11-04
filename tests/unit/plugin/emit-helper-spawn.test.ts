// @vitest-environment node
/*
 * Which program runs the headers helper, with which argv (#408 S5/S7) — the ONE
 * shared choice (plugin/scripts/emit-helper-spawn.mjs) and every Node site that
 * spawns the helper through it: runEmitHelper (status + session-start probe),
 * the Copilot lane's mintBearer and the Copilot status probe. `platform` is
 * injected, so the Windows branch is asserted on Linux.
 *
 * child_process is mocked: these tests pin the spawn ARGV. The real .ps1 under
 * pwsh is exercised end to end in copilot-usage-windows.test.ts.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const calls: Array<{ fn: string; file: string; args: string[] }> = []
vi.mock('node:child_process', async (orig) => {
  const real = await orig<typeof import('node:child_process')>()
  return {
    ...real,
    execFileSync: vi.fn((file: string, args: string[]) => {
      calls.push({ fn: 'execFileSync', file, args })
      return '{"Authorization":"Bearer mocked"}'
    }),
    spawnSync: vi.fn((file: string, args: string[]) => {
      calls.push({ fn: 'spawnSync', file, args })
      return { status: 0, stdout: '{"Authorization":"Bearer mocked"}', stderr: '' }
    }),
  }
})

const ROOT = resolve(__dirname, '../../..')
const PS = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
const PS_FLAGS = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File']
// Windows (#430): the "without PowerShell" cases rely on nothing existing at
// C:\Windows, which holds off Windows and is false on a Windows machine. A
// test premise, not product behaviour: the resolver's no-PowerShell branch is
// covered above with an injected `exists`.
const HAS_REAL_WINDOWS = process.platform === 'win32'

let state: string
beforeAll(() => {
  state = mkdtempSync(join(tmpdir(), 'ts-spawn-'))
  writeFileSync(
    join(state, 'config.copilot-cli.json'),
    JSON.stringify({
      version: 2,
      tool: 'copilot-cli',
      instance_id: 'inst-1',
      bearer_endpoint: 'https://ts.example/api/v1/instances/inst-1/bearer',
      oauth_token_endpoint: 'https://ts.example/api/v1/oauth/token',
      oauth_client_id: 'cid',
      oauth_refresh_token: 'rt-SECRET',
      logs_endpoint: 'https://ingest.example/v1/logs',
    }),
    { mode: 0o600 },
  )
  vi.stubEnv('TOKENSCOPE_STATE_DIR', state)
})
afterAll(() => {
  vi.unstubAllEnvs()
  rmSync(state, { recursive: true, force: true })
})
beforeEach(() => {
  calls.length = 0
})

describe('emitHelperSpawn / windowsPowerShellPath', () => {
  it('POSIX: /bin/sh, absolute, argv unchanged', async () => {
    const { emitHelperSpawn } = await import('../../../plugin/scripts/emit-helper-spawn.mjs')
    expect(emitHelperSpawn({ helper: '/p/otel-headers-helper.sh', stateDir: '/s', tool: 'claude-code', platform: 'linux' })).toEqual({
      file: '/bin/sh',
      args: ['/p/otel-headers-helper.sh', '--state-dir', '/s', '--tool', 'claude-code'],
    })
  })

  it('win32: C:\\Windows powershell.exe with the setup shape, never PATH', async () => {
    const { emitHelperSpawn } = await import('../../../plugin/scripts/emit-helper-spawn.mjs')
    const seen: string[] = []
    const exists = (p: string) => (seen.push(p), p === PS)
    const r = emitHelperSpawn({
      helper: 'C:\\p\\otel-headers-helper.ps1',
      stateDir: 'C:\\Users\\A B\\.tokenscope',
      tool: 'copilot-cli',
      platform: 'win32',
      env: { SystemRoot: 'D:\\Evil', PATH: 'C:\\repo\\bin' },
      exists,
    })
    expect(r).toEqual({
      file: PS,
      args: [...PS_FLAGS, 'C:\\p\\otel-headers-helper.ps1', '--state-dir', 'C:\\Users\\A B\\.tokenscope', '--tool', 'copilot-cli'],
    })
    expect(seen).toEqual([PS]) // the fixed location wins; SystemRoot never consulted
  })

  it('win32: SystemRoot only when C:\\Windows is absent, and only as <drive>:\\Windows', async () => {
    const { windowsPowerShellPath } = await import('../../../plugin/scripts/emit-helper-spawn.mjs')
    const all = () => true
    const noC = (p: string) => !p.startsWith('C:\\')
    expect(windowsPowerShellPath({ env: { SystemRoot: 'D:\\WINDOWS' }, exists: noC })).toBe(
      'D:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    )
    // A repo-chosen directory is not a Windows directory.
    for (const sr of ['D:\\repo\\Windows', '.\\Windows', 'D:\\Windows\\..\\repo', '\\\\host\\share\\Windows', 'D:Windows', '']) {
      expect(windowsPowerShellPath({ env: { SystemRoot: sr }, exists: noC })).toBeNull()
    }
    expect(windowsPowerShellPath({ env: {}, exists: () => false })).toBeNull()
    expect(windowsPowerShellPath({ env: { SystemRoot: 'E:\\Windows' }, exists: all })).toBe(PS)
  })

  it('win32 with no PowerShell found: null (callers fail closed)', async () => {
    const { emitHelperSpawn } = await import('../../../plugin/scripts/emit-helper-spawn.mjs')
    expect(emitHelperSpawn({ helper: 'h', stateDir: 's', tool: 'claude-code', platform: 'win32', env: {}, exists: () => false })).toBeNull()
  })
})

describe('every helper spawn site picks the interpreter by platform', () => {
  it('runEmitHelper on win32 spawns the .ps1 under PowerShell', async () => {
    const { runEmitHelper } = await import('../../../plugin/scripts/plugin-runtime.mjs')
    const r = runEmitHelper({ platform: 'win32', powershell: 'X:\\ps.exe', stateDir: state, env: {} })
    expect(r).toEqual({ ran: true, status: 0, hasAuth: true })
    expect(calls).toHaveLength(1)
    expect(calls[0].file).toBe('X:\\ps.exe')
    expect(calls[0].args).toEqual([
      ...PS_FLAGS, join(ROOT, 'plugin/scripts/otel-headers-helper.ps1'), '--state-dir', state, '--tool', 'claude-code',
    ])
  })

  it.skipIf(HAS_REAL_WINDOWS)('runEmitHelper on win32 without PowerShell reports not-run and spawns nothing', async () => {
    const { runEmitHelper } = await import('../../../plugin/scripts/plugin-runtime.mjs')
    // Off Windows nothing exists at C:\Windows, so resolution fails as it would on a broken install.
    expect(runEmitHelper({ platform: 'win32', stateDir: state, env: {} })).toEqual({ ran: false, status: null, hasAuth: false })
    expect(calls).toHaveLength(0)
  })

  it('runEmitHelper on POSIX is unchanged', async () => {
    const { runEmitHelper } = await import('../../../plugin/scripts/plugin-runtime.mjs')
    runEmitHelper({ platform: 'linux', stateDir: state, env: {} })
    expect(calls[0].file).toBe('/bin/sh')
    expect(calls[0].args).toEqual([join(ROOT, 'plugin/scripts/otel-headers-helper.sh'), '--state-dir', state, '--tool', 'claude-code'])
  })

  for (const lane of ['plugin', 'copilot-plugin'] as const) {
    it(`${lane}/scripts/copilot-emit.mjs mintBearer on win32: exact argv, refresh token only in env`, async () => {
      const mod = await import(`../../../${lane}/scripts/copilot-emit.mjs`)
      expect(mod.mintBearer(true, { platform: 'win32', powershell: 'X:\\ps.exe' })).toBe('Bearer mocked')
      expect(calls).toHaveLength(1)
      expect(calls[0].file).toBe('X:\\ps.exe')
      expect(calls[0].args).toEqual([
        ...PS_FLAGS, join(ROOT, lane, 'scripts/otel-headers-helper.ps1'), '--state-dir', state, '--tool', 'copilot-cli',
      ])
      expect(calls[0].args.join(' ')).not.toContain('rt-SECRET')
    })

    it.skipIf(HAS_REAL_WINDOWS)(`${lane}/scripts/copilot-emit.mjs mintBearer on win32 without PowerShell throws before spawning`, async () => {
      const mod = await import(`../../../${lane}/scripts/copilot-emit.mjs`)
      expect(() => mod.mintBearer(true, { platform: 'win32' })).toThrow(/Windows PowerShell/)
      expect(calls).toHaveLength(0)
    })

    it(`${lane}/scripts/copilot-emit.mjs mintBearer on POSIX is unchanged`, async () => {
      const mod = await import(`../../../${lane}/scripts/copilot-emit.mjs`)
      mod.mintBearer(true, { platform: 'linux' })
      expect(calls[0].file).toBe('/bin/sh')
      expect(calls[0].args).toEqual([join(ROOT, lane, 'scripts/otel-headers-helper.sh'), '--state-dir', state, '--tool', 'copilot-cli'])
    })
  }

  it('the Copilot status probe on win32 spawns the vendored .ps1 under PowerShell', async () => {
    const { probeEmissionAuth } = await import('../../../copilot-plugin/scripts/status.mjs')
    const v = probeEmissionAuth(state, { platform: 'win32', powershell: 'X:\\ps.exe' })
    expect(v.emitting).toBe(true)
    expect(calls).toHaveLength(1)
    expect(calls[0].file).toBe('X:\\ps.exe')
    expect(calls[0].args).toEqual([
      ...PS_FLAGS, join(ROOT, 'copilot-plugin/scripts/otel-headers-helper.ps1'), '--state-dir', state, '--tool', 'copilot-cli',
    ])
  })

  it.skipIf(HAS_REAL_WINDOWS)('the Copilot status probe on win32 without PowerShell says so and spawns nothing', async () => {
    const { probeEmissionAuth } = await import('../../../copilot-plugin/scripts/status.mjs')
    const v = probeEmissionAuth(state, { platform: 'win32' })
    expect(v).toMatchObject({ emitting: false, probe_status: null })
    expect(v.message).toMatch(/Windows PowerShell/)
    expect(calls).toHaveLength(0)
  })
})
