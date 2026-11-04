/*
 * Static rules every TokenScope PowerShell script follows. They are about the
 * environment Claude Code hands these scripts, which a repository's settings
 * env can contribute to, and about Windows PowerShell 5.1's web defaults.
 * Each rule walks EVERY .ps1 we ship, so a new script is covered on arrival.
 *
 *   - PSModulePath is reset first, and PATH is pinned (on Windows) right after:
 *     the .sh helper pins TRUSTED_PATH for the same reason.
 *   - TLS 1.2 is OR-ed into SecurityProtocol, never assigned (an assignment
 *     switches TLS 1.3 off where the host has it).
 *   - Files are replaced with File.Replace, never Move-Item -Force.
 *   - Web requests go through System.Net.Http.HttpClient, never
 *     Invoke-WebRequest / Invoke-RestMethod: on 5.1 their -TimeoutSec bounds
 *     only the wait for the response, not the body read (#418). A script that
 *     makes one sets Expect100Continue off and TLS 1.2 in, refuses redirects,
 *     and bounds the whole request (Timeout + ResponseContentRead).
 *     tests/unit/plugin/otel-helper-error-body.test.ts proves the behaviour.
 */
import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const DIRS = ['plugin/scripts', 'copilot-plugin/scripts'].map((d) => join(process.cwd(), d))
// Dot-sourced libraries run inside an entry script, after its preamble.
// claude-config-dir.ps1 (#449) defines functions only; claude-redeem.ps1 and
// status.ps1 dot-source it after their own PSModulePath and PATH pins.
const LIBRARIES = new Set(['ps-json.ps1', 'claude-config-dir.ps1'])

const scripts = DIRS.flatMap((d) =>
  readdirSync(d)
    .filter((f) => f.endsWith('.ps1'))
    .map((f) => ({ name: `${d.split('/').slice(-2).join('/')}/${f}`, file: f, src: readFileSync(join(d, f), 'utf8') })),
)
const entries = scripts.filter((s) => !LIBRARIES.has(s.file))

const statements = (src: string) =>
  src
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))

describe('every shipped .ps1', () => {
  it('there are scripts to check', () => {
    expect(entries.map((s) => s.file)).toEqual(
      expect.arrayContaining(['otel-headers-helper.ps1', 'claude-redeem.ps1', 'status.ps1', 'device-id.ps1']),
    )
  })

  it.each(entries.map((s) => [s.name, s.src]))('%s: PSModulePath first, then the Windows PATH pin', (_n, src) => {
    const [first, second] = statements(src)
    expect(first).toMatch(/^\$env:PSModulePath = .*\$PSHOME/)
    expect(second).toBe(
      "if ([Environment]::OSVersion.Platform -eq [PlatformID]::Win32NT) { $env:PATH = [Environment]::SystemDirectory + ';' + [Environment]::SystemDirectory + '\\WindowsPowerShell\\v1.0' }",
    )
  })

  it.each(scripts.map((s) => [s.name, s.src]))('%s: TLS 1.2 is OR-ed in, never assigned', (_n, src) => {
    for (const line of statements(src).filter((l) => /SecurityProtocol\s*=/.test(l))) {
      expect(line).toMatch(/SecurityProtocol\s*=\s*\[(System\.)?Net\.ServicePointManager\]::SecurityProtocol\s+-bor\s/)
    }
  })

  // Move-Item -Force over an existing file deletes it first: a reader (the next
  // helper run, a concurrent session) can find no cache at all. File.Replace is
  // one ReplaceFile call on Windows.
  it.each(scripts.map((s) => [s.name, s.src]))('%s: files are replaced atomically, never with Move-Item', (_n, src) => {
    expect(statements(src).filter((l) => /\bMove-Item\b/.test(l))).toEqual([])
  })

  it.each(scripts.map((s) => [s.name, s.src]))('%s: no Invoke-WebRequest / Invoke-RestMethod', (_n, src) => {
    expect(statements(src).filter((l) => /Invoke-(WebRequest|RestMethod)\b/.test(l))).toEqual([])
  })

  it.each(scripts.map((s) => [s.name, s.src]))('%s: an HttpClient request has one deadline and follows no redirect', (_n, src) => {
    if (!/System\.Net\.Http\.HttpClient\b/.test(src)) return
    expect(src).toMatch(/\[(System\.)?Net\.ServicePointManager\]::Expect100Continue = \$false/)
    expect(src).toMatch(/\[(System\.)?Net\.ServicePointManager\]::SecurityProtocol = /)
    expect(src).toContain('$req.Headers.ExpectContinue = $false')
    expect(src).toContain('.AllowAutoRedirect = $false')
    expect(src).not.toMatch(/AllowAutoRedirect = \$true/)
    expect(src).toMatch(/\$client\.Timeout = \[TimeSpan\]::FromMilliseconds\(/)
    expect(src).toContain('[System.Net.Http.HttpCompletionOption]::ResponseContentRead')
    expect(src).not.toContain('ResponseHeadersRead')
    expect(src).toMatch(/Microsoft\.PowerShell\.Utility\\Add-Type -AssemblyName System\.Net\.Http/)
  })
})
