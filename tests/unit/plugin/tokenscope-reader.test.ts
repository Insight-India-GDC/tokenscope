/*
 * .tokenscope reader — walk-up + YAML parsing unit tests.
 *
 * Per docs/build/mvp-lite-epic.md §Epic 5 testing: "unit (skill arg
 * parsing, .tokenscope YAML reader, walk-up logic)".
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { findTokenscopeFile, parseTokenscope } from '../../../plugin/scripts/tokenscope-reader.mjs'

let root: string

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'ts-reader-'))
  // Create a nested layout:
  //   root/
  //     .tokenscope            <-- present at root
  //     deep/very/nested/
  //       (no .tokenscope here; walk-up should find root's)
  //     other/repo/.tokenscope <-- present at this level too
  //     other/repo/inside/
  //       (walk-up should find other/repo/.tokenscope, not root's)
  mkdirSync(join(root, 'deep', 'very', 'nested'), { recursive: true })
  mkdirSync(join(root, 'other', 'repo', 'inside'), { recursive: true })

  writeFileSync(
    join(root, '.tokenscope'),
    [
      '# root-level .tokenscope',
      'project:',
      '  code: "CSL-AII"',
      '  id: "afl-ai-insights"',
      '  name: "Contoso League · AI Insights"',
      '',
      'client: "Contoso League"',
      'pm: "Anil Verma"',
    ].join('\n'),
  )

  writeFileSync(
    join(root, 'other', 'repo', '.tokenscope'),
    [
      'project:',
      '  code: NWB-CIB',
      '  id: nab-cib-modernise',
      '  name: "Northwind Bank · CIB Modernise"',
    ].join('\n'),
  )
})

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('findTokenscopeFile', () => {
  it('skips a .tokenscope DIRECTORY (the plugin state dir under the home) and keeps walking', () => {
    const base = mkdtempSync(join(tmpdir(), 'ts-reader-dir-'))
    try {
      // home/.tokenscope is the state directory; home/repo/sub has no tag.
      mkdirSync(join(base, '.tokenscope'), { recursive: true })
      mkdirSync(join(base, 'repo', 'sub'), { recursive: true })
      const found = findTokenscopeFile(join(base, 'repo', 'sub'))
      expect(found === null || !found.startsWith(base)).toBe(true)
      // A real tag file above is still found.
      writeFileSync(join(base, 'repo', '.tokenscope'), 'project:\n  code: ABC\n')
      expect(findTokenscopeFile(join(base, 'repo', 'sub'))).toBe(join(base, 'repo', '.tokenscope'))
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  })

  it('finds the file in the same dir', () => {
    expect(findTokenscopeFile(root)).toBe(join(root, '.tokenscope'))
  })

  it('walks up from a nested directory to the first .tokenscope found', () => {
    expect(findTokenscopeFile(join(root, 'deep', 'very', 'nested'))).toBe(
      join(root, '.tokenscope'),
    )
  })

  it('stops at the closest .tokenscope (does not skip past it)', () => {
    expect(findTokenscopeFile(join(root, 'other', 'repo', 'inside'))).toBe(
      join(root, 'other', 'repo', '.tokenscope'),
    )
  })

  it('returns null when no .tokenscope is found above /', () => {
    // Use a temp dir guaranteed outside any .tokenscope ancestor — tmpdir
    // root on most systems has no .tokenscope.
    const orphan = mkdtempSync(join(tmpdir(), 'ts-no-file-'))
    expect(findTokenscopeFile(orphan)).toBeNull()
    rmSync(orphan, { recursive: true, force: true })
  })
})

describe('parseTokenscope', () => {
  it('reads project.code, .id, .name', () => {
    const parsed = parseTokenscope(join(root, '.tokenscope'))
    expect(parsed.project.code).toBe('CSL-AII')
    expect(parsed.project.id).toBe('afl-ai-insights')
    expect(parsed.project.name).toBe('Contoso League · AI Insights')
  })

  it('reads optional top-level fields (client, pm, etc.)', () => {
    const parsed = parseTokenscope(join(root, '.tokenscope'))
    expect(parsed.optional.client).toBe('Contoso League')
    expect(parsed.optional.pm).toBe('Anil Verma')
  })

  it('handles unquoted scalar values', () => {
    const parsed = parseTokenscope(join(root, 'other', 'repo', '.tokenscope'))
    expect(parsed.project.code).toBe('NWB-CIB')
    expect(parsed.project.id).toBe('nab-cib-modernise')
  })

  it('strips line comments', () => {
    const path = join(root, 'commented.tokenscope')
    writeFileSync(
      path,
      ['project:', '  code: ABC  # inline comment', '  id: abc', '  name: "ABC"'].join('\n'),
    )
    const parsed = parseTokenscope(path)
    expect(parsed.project.code).toBe('ABC')
  })
})
