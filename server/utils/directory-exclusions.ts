/*
 * directory-exclusions — the admin-configurable policy for directory accounts
 * that must never become teammates (privileged/service accounts that don't run
 * the tools, don't emit, don't bill), stored as UPN glob patterns in
 * `directory_exclusion_pattern` (mig 0083). Applied at three sites: the
 * people-picker search filter, the assign-time guard
 * (assertDirectoryIdentityPickable), and the opt-in retro-cleanup worker.
 *
 * PORTABILITY: nothing org-specific is hardcoded. The patterns are DATA an
 * admin edits; a fresh install has NONE and therefore excludes NOBODY
 * (fail-open) until an admin opts in. `loadDirectoryExclusionPatterns` reads
 * the table with a plain db handle so it works from a request handler AND a
 * worker (mirrors server/utils/governance-settings.ts).
 *
 * MATCHING: `*` is the only wildcard (any run, incl. empty). Everything else is
 * a literal. Both the pattern and the UPN are lowercased (the UPN is already
 * lowercased on read in azure/directory.ts, and the unique index is on
 * lower(pattern)). A pattern matches the WHOLE UPN.
 */
import { sql } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { LIKE_ESCAPE } from './sql-like'

type Db = PostgresJsDatabase<Record<string, unknown>>

/**
 * Validate a pattern for the match-all footgun and structural sanity. A pattern
 * that reduces to "match everything" would empty every people-picker and (in
 * the cleanup worker) mass-deactivate — so it is rejected here AND at the API
 * layer (defense in depth). Returns an error string, or null when valid.
 *
 * Rules: non-empty; not all-wildcard (`***`); ≤200 chars; and the portion after
 * the last `@` must contain at least one literal (non-`*`) dot-bearing domain
 * label — i.e. the pattern must pin a real domain, not `*` / `*@*` / `*@*.com`.
 */
export function validateExclusionPattern(raw: string): string | null {
  const p = raw.trim().toLowerCase()
  if (!p) return 'Pattern is empty.'
  if (p.length > 200) return 'Pattern is too long (max 200 characters).'
  if (/^\*+$/.test(p)) return 'Pattern matches everything — pin a domain (e.g. *@*.onmicrosoft.com).'
  const at = p.lastIndexOf('@')
  const domain = at >= 0 ? p.slice(at + 1) : p
  // The literal (wildcards removed) domain must pin a REAL domain — at least two
  // non-empty labels (SLD.TLD), so `*@*.com` (all of .com, incl. example.com),
  // `*@*.*` and `*@*` are rejected while `*@contoso.onmicrosoft.com` and
  // `*-cld@example.com` pass.
  const literalLabels = domain
    .replace(/\*/g, '')
    .split('.')
    .filter((l) => /[a-z0-9]/.test(l))
  if (literalLabels.length < 2) {
    return 'Pattern must pin a real domain after "@" (e.g. *@contoso.onmicrosoft.com).'
  }
  return null
}

/**
 * True when the `*`-glob matches the WHOLE upn. A two-pointer match with
 * backtrack-to-last-star, O(len(pattern) * len(upn)) at worst: a RegExp with one
 * `.*` per wildcard backtracks polynomially, which a many-wildcard pattern turns
 * into seconds per sign-in.
 */
export function upnGlobMatches(pattern: string, upn: string): boolean {
  const p = pattern.trim().toLowerCase()
  const u = upn.toLowerCase()
  let pi = 0
  let ui = 0
  let star = -1
  let resume = 0
  while (ui < u.length) {
    if (pi < p.length && p[pi] === '*') {
      star = pi++
      resume = ui
    } else if (pi < p.length && p[pi] === u[ui]) {
      pi++
      ui++
    } else if (star >= 0) {
      pi = star + 1
      ui = ++resume
    } else {
      return false
    }
  }
  while (pi < p.length && p[pi] === '*') pi++
  return pi === p.length
}

/**
 * Translate a `*`-glob to a SQL `LIKE` body — bind `LIKE_ESCAPE` (from
 * ./sql-like) as a PARAMETER at the call site (`ESCAPE ${LIKE_ESCAPE}`),
 * never as a literal `ESCAPE '\'` in the template: that literal collapses to
 * `ESCAPE ''` before Postgres ever sees it, silently disabling the escaping
 * this function just did (see ./sql-like's header for the full trap). `*` →
 * `%`; LIKE metacharacters (`% _ \`) in the literal parts are escaped.
 * Agrees with `upnGlobMatches` for these patterns (both treat `.` as
 * literal).
 */
export function upnGlobToSqlLike(pattern: string): string {
  return pattern
    .trim()
    .toLowerCase()
    .replace(/\*+/g, '*')
    .split('*')
    .map((seg) => seg.replace(/[\\%_]/g, `${LIKE_ESCAPE}$&`))
    .join('%')
}

/**
 * True when `upn` matches any exclusion pattern. FAIL-OPEN by construction: an
 * empty pattern list, or a null/blank upn, returns false (exclude nobody). This
 * direction is deliberate and load-bearing — the cleanup worker deactivates on
 * a `true`, so fail-closed would mass-deactivate.
 */
export function isExcludedUpn(upn: string | null | undefined, patterns: string[]): boolean {
  if (!upn || patterns.length === 0) return false
  const u = upn.toLowerCase()
  for (const p of patterns) {
    if (upnGlobMatches(p, u)) return true
  }
  return false
}

/**
 * Load the active exclusion patterns. Plain db handle → works from a request
 * (pre-tx) or a worker. No RLS gotcha: the read policy is USING(true) and RLS
 * is runtime-inert (owner connection), mirroring governance_setting.
 *
 * REAL defense-in-depth (not just the POST validator): every row is
 * re-validated here and an INVALID one is SKIPPED (logged), so a match-all
 * pattern that reached the table by any path OTHER than the POST route (a
 * bulk import, a migration backfill, a direct psql fix) can never empty every
 * picker or drive the cleanup worker — the guard is enforced at the read, not
 * only at the write.
 */
export async function loadDirectoryExclusionPatterns(db: Db): Promise<string[]> {
  const rows = await db.execute<{ pattern: string }>(sql`
    SELECT pattern FROM directory_exclusion_pattern ORDER BY lower(pattern)
  `)
  const out: string[] = []
  for (const r of rows) {
    const bad = validateExclusionPattern(r.pattern)
    if (bad) {
      console.warn(`[directory-exclusions] skipping invalid stored pattern ${JSON.stringify(r.pattern)}: ${bad}`)
      continue
    }
    out.push(r.pattern)
  }
  return out
}
