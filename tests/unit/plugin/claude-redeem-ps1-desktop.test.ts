/*
 * claude-redeem.ps1's Desktop merge (Merge-TsDesktopAttrs) must agree with
 * desktop-env.mjs mergeDesktopAttrs. Runs under pwsh when available (CI's
 * macOS and Windows runners), by dot-sourcing the script, which loads its
 * functions without running setup.
 */
import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { mergeDesktopAttrs } from '../../../plugin/scripts/desktop-env.mjs'
import { resolvePwsh } from './helpers/shells.js'

const PWSH = resolvePwsh()
const HAVE_PWSH = Boolean(PWSH) && spawnSync(PWSH!, ['-NoProfile', '-Command', 'exit 0']).status === 0
const SCRIPT = join(__dirname, '..', '..', '..', 'plugin', 'scripts', 'claude-redeem.ps1')
const IID = '273F7FB3-7001-40A7-9096-3592D14A2328'

function psMerge(existing: string): string | null {
  const esc = (v: string) => v.replace(/'/g, "''")
  const r = spawnSync(
    PWSH!,
    ['-NoProfile', '-NonInteractive', '-Command', `. '${esc(SCRIPT)}'; $m = Merge-TsDesktopAttrs '${esc(existing)}' '${IID}'; if ($null -eq $m) { 'NULL' } else { $m }`],
    { encoding: 'utf8' },
  )
  expect(r.status, r.stderr).toBe(0)
  const out = r.stdout.trim()
  return out === 'NULL' ? null : out
}

describe.skipIf(!HAVE_PWSH)('Merge-TsDesktopAttrs == mergeDesktopAttrs', () => {
  it.each(['', 'team=apac', 'deployment.env=prod, team=apac', 'tokenscope.instance_id=old,tool=copilot-cli,team=apac', 'just-a-word', '=x'])(
    '%j',
    (existing) => {
      expect(psMerge(existing)).toBe(mergeDesktopAttrs(existing, IID))
    },
  )

  it('dot-sourcing loads the functions without running setup', () => {
    const r = spawnSync(PWSH!, ['-NoProfile', '-NonInteractive', '-Command', `. '${SCRIPT}'; 'loaded'`], { encoding: 'utf8' })
    expect(r.stdout.trim()).toBe('loaded')
    expect(r.stderr).not.toMatch(/handoff/i)
  })
})
