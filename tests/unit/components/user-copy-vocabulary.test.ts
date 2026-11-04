// @vitest-environment node
/*
 * USER COPY SAYS WHAT THE PRODUCT SAYS (issue 489, REMAINING C1, C2, C9).
 *
 * Three classes of word kept reaching users after each was fixed by hand:
 *
 *   1. "Cost centre" / "Cost-owning unit" for the thing the product reports on.
 *      The user-facing word is **Business Unit** (AGENTS.md banner). "Cost
 *      centre" is a DIFFERENT object here: an optional finance code tag on a
 *      BU. The finance-code sense is the only one allowed on screen.
 *   2. Internal notation: section signs ("§A", "§B"), Σ, ADR numbers. They are
 *      the design docs' shorthand and mean nothing to a reader.
 *   3. Raw role codes and retired role names ("platform-admin", "Platform admin
 *      access required."). `shared/auth/roles.ts` `roleLabel` owns the words.
 *
 * Every fix was right and the class came back, because a rename is never one
 * site (CLAUDE.md rule 14). So this walks the sources a user can read and
 * fails on a NEW occurrence.
 *
 * ── WHAT COUNTS AS USER COPY ────────────────────────────────────────────────
 * Parsed, not grepped, so comments never count and identifiers never match:
 *   - `.vue` templates: text nodes, static attribute values (except the
 *     non-visible ones in HIDDEN_ATTRS) and every string literal inside a
 *     binding or interpolation;
 *   - every string and template literal in `app/` and `shared/` scripts and in
 *     `server/` (statusMessage, labels, hints and CSV headers are all read by
 *     someone). SQL comment lines inside a literal are dropped first.
 * A string with no whitespace that is all lower-case identifier characters
 * (`'cost-centre'`, `cost-centres/drill`) is a key, route or testid and is
 * skipped; a hyphenated fragment inside prose (`cost-centre-owner`) is too.
 *
 * ── ALLOWLIST ───────────────────────────────────────────────────────────────
 * The finance-code sense ("cost-centre code", a teammate's DIRECTORY cost
 * centre, which is the real finance attribute from Entra) is always allowed.
 * Anything else needs an entry in ALLOW with the reason it is not user copy.
 */
import { describe, it, expect } from 'vitest'
import { globSync, readFileSync } from 'node:fs'
import { join, dirname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { parse as parseSfc } from '@vue/compiler-sfc'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

/** Attributes a reader never sees. */
const HIDDEN_ATTRS = new Set([
  'class', 'style', 'id', 'to', 'href', 'src', 'name', 'key', 'ref', 'anchor', 'type', 'kind',
  'size', 'role', 'for', 'is', 'lang', 'setup', 'scope', 'tab', 'value', 'method', 'target',
])
const hiddenAttr = (name: string) =>
  HIDDEN_ATTRS.has(name) || name.startsWith('data-') || name.startsWith('v-') || name.startsWith('@')

interface Found { file: string; line: number; text: string }

function literalsFromTs(code: string, file: string, lineOffset: number): Found[] {
  const sf = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const out: Found[] = []
  const visit = (n: ts.Node) => {
    if (
      ts.isStringLiteral(n) ||
      ts.isNoSubstitutionTemplateLiteral(n) ||
      ts.isTemplateHead(n) ||
      ts.isTemplateMiddle(n) ||
      ts.isTemplateTail(n)
    ) {
      const { line } = sf.getLineAndCharacterOfPosition(n.getStart(sf))
      out.push({ file, line: line + 1 + lineOffset, text: (n as ts.LiteralLikeNode).text })
    }
    // Import specifiers are paths, never copy.
    if (ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) return
    // A server log line is read by an operator in the log stream, not by a user.
    if (
      ts.isCallExpression(n) &&
      ts.isPropertyAccessExpression(n.expression) &&
      ts.isIdentifier(n.expression.expression) &&
      ['consola', 'console', 'logger', 'log'].includes(n.expression.expression.text)
    ) {
      return
    }
    ts.forEachChild(n, visit)
  }
  visit(sf)
  return out
}

interface TemplateNode {
  type: number
  content?: string | TemplateNode
  children?: TemplateNode[]
  props?: Array<{ type: number; name: string; value?: { content: string }; exp?: { content: string } }>
  loc: { start: { line: number } }
}

function stringsFromVue(src: string, file: string): Found[] {
  const { descriptor } = parseSfc(src, { filename: file })
  const out: Found[] = []
  for (const block of [descriptor.script, descriptor.scriptSetup]) {
    if (block) out.push(...literalsFromTs(block.content, file, block.loc.start.line - 1))
  }
  const expr = (code: string, line: number) => literalsFromTs(`(${code})`, file, line - 1)
  const walk = (n: TemplateNode) => {
    const line = n.loc.start.line
    if (n.type === 2 && typeof n.content === 'string') out.push({ file, line, text: n.content })
    if (n.type === 5 && n.content && typeof n.content === 'object' && typeof n.content.content === 'string') {
      out.push(...expr(n.content.content, line))
    }
    for (const p of n.props ?? []) {
      if (p.type === 6 && p.value && !hiddenAttr(p.name)) out.push({ file, line, text: p.value.content })
      if (p.type === 7 && p.exp?.content) {
        const arg = (p as unknown as { arg?: { content?: string } }).arg?.content ?? ''
        if (p.name === 'bind' && hiddenAttr(arg)) continue
        out.push(...expr(p.exp.content, line))
      }
    }
    for (const c of n.children ?? []) walk(c)
  }
  if (descriptor.template?.ast) walk(descriptor.template.ast as unknown as TemplateNode)
  return out
}

function stringsOf(rel: string): Found[] {
  const src = readFileSync(join(ROOT, rel), 'utf8')
  return rel.endsWith('.vue') ? stringsFromVue(src, rel) : literalsFromTs(src, rel, 0)
}

/** SQL comments inside a literal are for the next engineer, not the reader. */
const dropSqlComments = (s: string) =>
  s
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|\n)\s*--[^\n]*/g, '$1')
    .replace(/\s--\s[^\n]*/g, ' ')
const isIdentifier = (s: string) => /^[a-z0-9_\-/.:#?=&${}[\]*]*$/.test(s)

interface Rule { name: string; re: RegExp }
const RULES: Rule[] = [
  { name: 'cost centre (say Business Unit)', re: /(?<![-\w/])[Cc]ost[ -]cent(?:re|er)s?(?![-\w/])/g },
  { name: 'cost-owning unit (say Business Unit)', re: /(?<![-\w/])[Cc]ost-owning(?![-\w/])|\bCoUs?\b/g },
  { name: 'section sign', re: /§/g },
  { name: 'sigma', re: /Σ/g },
  { name: 'ADR number', re: /\bADR[- ]?\d+/g },
  // A quoted code ('platform-admin' in SQL or a comparison) is a value, not copy.
  {
    name: 'raw or retired role name',
    re: /(?<![-\w/'])(?:platform-admin|global-finops)(?![-\w/'])|\b[Pp]latform admin\b|\bGlobal finance access\b|\bOrg-wide admin\b/g,
  },
]

/** The finance-code sense: the only "cost centre" a user may read. */
const FINANCE_CODE = /[Cc]ost[ -]cent(?:re|er)s?(?= code)|(?<=directory )[Cc]ost[ -]cent(?:re|er)s?/g
/** A standards citation in a protocol error, written for the client developer. */
const RFC_CITATION = /RFC \d+ §[\d.]+/g

/**
 * Explicit exceptions: [file, substring of the string, why it is not user copy].
 * Keep this short; every entry is a place the gate is blind.
 */
const ALLOW: Array<[string, string, string]> = [
  ['shared/auth/roles.ts', '', 'owns the role labels and codes'],
  // Worker descriptions: returned by the enablement API for operators, rendered
  // by no page. They cite design sections on purpose.
  ['server/workers/registry.ts', '', 'worker descriptions, not rendered'],
  ['shared/workers/unscheduled.ts', '', 'worker descriptions, not rendered'],
  ['server/db/rls-bootstrap.ts', '', 'RLS exemption reasons for engineers, not rendered'],
]

const FILES = [
  ...globSync('app/**/*.{vue,ts}', { cwd: ROOT }),
  ...globSync('server/**/*.ts', { cwd: ROOT }),
  ...globSync('shared/**/*.ts', { cwd: ROOT }),
]
  .map((f) => relative('.', f))
  .filter((f) => !f.includes('__tests__') && !f.endsWith('.d.ts'))

function offenders(): string[] {
  const out: string[] = []
  for (const f of FILES) {
    for (const s of stringsOf(f)) {
      const text = dropSqlComments(s.text)
      if (!/\s/.test(text.trim()) && isIdentifier(text.trim())) continue
      const cleaned = text.replace(FINANCE_CODE, '').replace(RFC_CITATION, '')
      for (const r of RULES) {
        if (!new RegExp(r.re.source, r.re.flags).test(cleaned)) continue
        if (ALLOW.some(([af, sub]) => af === f && cleaned.includes(sub))) continue
        out.push(`${f}:${s.line} [${r.name}] ${text.trim().replace(/\s+/g, ' ').slice(0, 120)}`)
      }
    }
  }
  return out
}

describe('user copy vocabulary', () => {
  it('scans the real source tree (vacuous-scan guard)', () => {
    expect(FILES.length).toBeGreaterThan(300)
    expect(FILES).toContain('app/pages/admin/help.vue')
    expect(FILES).toContain('server/api/v1/admin/region/[regionId]/index.get.ts')
  })

  it('the parser sees template text, attributes, bindings and script strings', () => {
    const found = stringsFromVue(
      `<template><p title="Static title">Text node</p><X :label="'Bound label'">{{ cond ? 'Interp' : '' }}</X><!-- Comment --></template>
<script setup lang="ts">
// a line comment
const s = 'Script string'
</script>`,
      'probe.vue',
    ).map((x) => x.text.trim())
    expect(found).toEqual(expect.arrayContaining(['Static title', 'Text node', 'Bound label', 'Interp', 'Script string']))
    expect(found.join(' ')).not.toMatch(/Comment|line comment/)
  })

  it('the rules match the drift and spare identifiers and the finance code', () => {
    const hit = (s: string) =>
      RULES.some((r) => new RegExp(r.re.source, r.re.flags).test(s.replace(FINANCE_CODE, '')))
    expect(hit('Billed to your cost centre')).toBe(true)
    expect(hit('Chargeback by cost-centre')).toBe(true)
    expect(hit('Cost-owning unit')).toBe(true)
    expect(hit('§A · month to date')).toBe(true)
    expect(hit('validated on Dev (Σ=bill)')).toBe(true)
    expect(hit('governance (ADR-0011)')).toBe(true)
    expect(hit('Role updated → platform-admin')).toBe(true)
    expect(hit('Platform admin access required.')).toBe(true)
    expect(hit('open /reports/cost-centres/x')).toBe(false)
    expect(hit('see the cost-centre-owner entry')).toBe(false)
    expect(hit('their directory cost centre matches')).toBe(false)
    expect(hit('a directory cost-centre code')).toBe(false)
  })

  it('no user-facing string uses a retired word or internal notation', () => {
    // Joined, so a failure prints every offender rather than a truncated array.
    expect(offenders().join('\n')).toBe('')
  })
})
