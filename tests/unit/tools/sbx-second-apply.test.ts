// @vitest-environment node
/*
 * tools/publish/validation/sbx-second-apply.sh runs the sandbox validation's
 * second apply as attempt <n> of 3. Exit 4 from the approval script (only
 * Azure's platform failed) asks for another attempt on attempts 1 and 2, and
 * fails on attempt 3; any other failure fails at once. Runs the real script in
 * a scratch folder with `az`, `sleep` and the approval script stubbed.
 * tools/publish is internal-only, so the public snapshot skips this suite.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { PUBLIC_SNAPSHOT } from '../helpers/public-snapshot'

const exec = promisify(execFile)
const SCRIPT = resolve(__dirname, '../../../tools/publish/validation/sbx-second-apply.sh')
let dir: string

async function run(attempt: number, approveRc: number) {
  const output = join(dir, 'output')
  const summary = join(dir, 'summary')
  await writeFile(output, '')
  await writeFile(summary, '')
  let code = 0
  let out: string
  try {
    const r = await exec('bash', [SCRIPT, String(attempt)], {
      cwd: dir,
      timeout: 30_000,
      env: {
        ...process.env, PATH: `${dir}/bin:${process.env.PATH}`, RG: 'rg-sbx', URL: 'https://ca.example',
        STUB_RC: String(approveRc), GITHUB_OUTPUT: output, GITHUB_STEP_SUMMARY: summary, RUNNER_TEMP: dir,
      },
    })
    out = `${r.stdout}${r.stderr}`
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string }
    code = typeof e.code === 'number' ? e.code : 1
    out = `${e.stdout ?? ''}${e.stderr ?? ''}`
  }
  return { code, out, output: await readFile(output, 'utf8'), summary: await readFile(summary, 'utf8') }
}

describe.skipIf(PUBLIC_SNAPSHOT)('sbx-second-apply.sh', () => {
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'sbx-apply-'))
    await mkdir(join(dir, 'bin'))
    await mkdir(join(dir, 'infra/scripts'), { recursive: true })
    // The operation list (for the --msi check) is empty; everything else succeeds.
    await writeFile(join(dir, 'bin/az'), '#!/bin/sh\nexit 0\n')
    await writeFile(join(dir, 'bin/sleep'), '#!/bin/sh\nexit 0\n')
    await writeFile(join(dir, 'infra/scripts/approve-front-door-private-link.sh'), 'exit "$STUB_RC"\n')
    await chmod(join(dir, 'bin/az'), 0o755)
    await chmod(join(dir, 'bin/sleep'), 0o755)
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('asks for another attempt on a platform error, on attempts 1 and 2', async () => {
    for (const attempt of [1, 2]) {
      const r = await run(attempt, 4)
      expect(r.code, r.out).toBe(0)
      expect(r.output).toContain('retry=yes')
      expect(r.summary).toContain(`attempt ${attempt}: Azure platform error; retried`)
    }
  })

  it('fails on a platform error at attempt 3', async () => {
    const r = await run(3, 4)
    expect(r.code).toBe(1)
    expect(r.output).toBe('')
    expect(r.out).toContain('::error::The second apply still failed on Azure\'s side after 2 retries')
  })

  it('fails at once on any other failure', async () => {
    const r = await run(1, 1)
    expect(r.code).toBe(1)
    expect(r.output).toBe('')
  })

  it('says in the summary when it passed after a retry', async () => {
    const r = await run(2, 0)
    expect(r.code).toBe(0)
    expect(r.summary).toContain('Sandbox second apply passed after 1 retry(ies) of an Azure platform error.')
  })
})
