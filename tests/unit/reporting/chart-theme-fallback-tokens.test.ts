/*
 * The chart theme's server-render fallback colours must equal the brand tokens.
 *
 * useChartTheme keeps a second copy of every colour it reads (FALLBACK) for a server render or a
 * missing token. Nothing tied that copy to brand-tokens.css, so a token change (a contrast fix, a
 * new lane hue) would leave server-rendered charts in the old colour (#493). This reads the
 * :root block of brand-tokens.css, follows var() aliases, and compares every colour entry.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { FALLBACK } from '../../../app/components/reporting/charts/useChartTheme'

const css = readFileSync(resolve(__dirname, '../../../app/assets/css/brand-tokens.css'), 'utf8')

function rootTokens(source: string): Map<string, string> {
  const root = /:root\s*\{([\s\S]*?)\n\}/.exec(source)
  if (!root) throw new Error('brand-tokens.css has no :root block')
  const tokens = new Map<string, string>()
  const body = root[1]!.replace(/\/\*[\s\S]*?\*\//g, '')
  for (const m of body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) tokens.set(m[1]!, m[2]!.trim())
  return tokens
}

function resolveToken(tokens: Map<string, string>, name: string, seen = new Set<string>()): string | undefined {
  if (seen.has(name)) throw new Error(`token cycle at ${name}`)
  seen.add(name)
  const value = tokens.get(name)
  if (value === undefined) return undefined
  const alias = /^var\((--[\w-]+)\)$/.exec(value)
  return alias ? resolveToken(tokens, alias[1]!, seen) : value
}

describe('useChartTheme FALLBACK matches brand-tokens.css', () => {
  const tokens = rootTokens(css)
  const colourEntries = Object.entries(FALLBACK).filter(([, v]) => v.startsWith('#'))

  it('has colour entries to check', () => {
    expect(colourEntries.length).toBeGreaterThan(10)
  })

  it.each(colourEntries)('%s equals its token', (name, fallback) => {
    const token = resolveToken(tokens, name)
    expect(token, `${name} is not defined in brand-tokens.css :root`).toBeDefined()
    expect(fallback.toLowerCase()).toBe(token!.toLowerCase())
  })
})
