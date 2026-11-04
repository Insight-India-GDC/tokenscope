// @vitest-environment node
/*
 * The public-snapshot leak gate (tools/publish/leak-gate.sh) must mask allowed
 * phrases out of a line, not drop the whole line: a forbidden identifier that
 * shares a line with "Application Insights" is still a leak.
 *
 * Forbidden fixtures are assembled at runtime so this file never carries them.
 * tools/publish is internal-only, so the public snapshot skips this suite.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { PUBLIC_SNAPSHOT } from '../helpers/public-snapshot'

const exec = promisify(execFile)
const GATE = resolve(__dirname, '../../../tools/publish/leak-gate.sh')
const FORBIDDEN_EMAIL = ['owner', '@', 'insight', '.com'].join('')

let dir = ''

async function gate(files: Record<string, string>): Promise<string[]> {
  const root = await mkdtemp(join(dir, 'case-'))
  for (const [name, body] of Object.entries(files)) {
    await mkdir(join(root, name, '..'), { recursive: true })
    await writeFile(join(root, name), body)
  }
  const { stdout } = await exec('bash', [GATE, root])
  return stdout.split('\n').filter(Boolean).map((l) => l.replace(`${root}/`, ''))
}

describe.skipIf(PUBLIC_SNAPSHOT)('publish leak gate', () => {
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ts-leak-gate-'))
  })
  afterAll(async () => {
    if (dir) await rm(dir, { recursive: true, force: true })
  })

  it('catches a forbidden identifier on the same line as an allowed phrase', async () => {
    const hits = await gate({ 'docs/a.md': `Application Insights alerts go to ${FORBIDDEN_EMAIL}\n` })
    expect(hits).toEqual([`docs/a.md:1:Application Insights alerts go to ${FORBIDDEN_EMAIL}`])
  })

  it('passes a line whose only match is an allowed phrase', async () => {
    expect(await gate({ 'a.md': 'Send traces to Application Insights and Azure Monitor\n' })).toEqual([])
  })

  it('still catches a forbidden identifier on its own line, with its line number', async () => {
    expect(await gate({ 'b.txt': `ok\ncontact ${FORBIDDEN_EMAIL}\n` })).toEqual([`b.txt:2:contact ${FORBIDDEN_EMAIL}`])
  })

  it('an empty tree is clean and exits 0', async () => {
    expect(await gate({ 'c.txt': 'nothing here\n' })).toEqual([])
  })
})
