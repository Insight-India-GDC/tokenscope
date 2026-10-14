/*
 * Admin-authored display text that leaves the app verbatim — project names and
 * activity-tag labels are serialised into MCP tool results that every member's
 * Claude Code agent reads (server/utils/me-queries.ts getMyProjects and
 * getActivityTypes), so they are bounded at the write boundary.
 *
 * Bounded on length and on control characters: C0 (0x00-0x1F), DEL (0x7F) and C1
 * (0x80-0x9F, which includes 0x9B, the one-character CSI terminal escape). A newline or
 * escape sequence is what lets a name render as something else in an agent's
 * context or a terminal. Unicode, punctuation and spaces pass unchanged.
 *
 * The SAME bounds are enforced in the database by CHECK constraints (mig 0155);
 * change one, change both. Both count Unicode code points (Postgres char_length;
 * here `[...s].length`), so an emoji is one character at both layers.
 *
 * The constraints are NOT VALID, so rows written before 0155 are not checked.
 * cleanDisplayText is applied where those values leave for an agent (the MCP
 * read paths), so a legacy value is bounded on the way out regardless.
 */
import { z } from 'zod'

// eslint-disable-next-line no-control-regex -- INTENTIONAL: the point is to exclude control characters.
export const NO_CONTROL_CHARS_RE = /^[^\x00-\x1F\x7F-\x9F]*$/

export const PROJECT_NAME_MAX = 200
export const ACTIVITY_LABEL_MAX = 64

const codePoints = (s: string) => [...s].length

/** A display string of 1..max characters (code points) with no control characters; trim first when asked. */
export function displayText(max: number, opts: { trim?: boolean } = {}) {
  const base = opts.trim ? z.string().trim() : z.string()
  return base
    .refine((s) => codePoints(s) >= 1, { message: 'must not be empty' })
    .refine((s) => codePoints(s) <= max, { message: `must be at most ${max} characters` })
    .regex(NO_CONTROL_CHARS_RE, 'must not contain control characters')
}

// eslint-disable-next-line no-control-regex -- INTENTIONAL: replaces control characters.
const CONTROL_RUN_RE = /[\x00-\x1F\x7F-\x9F]+/g

/**
 * Output-side bound for a value that may predate the 0155 constraints: control
 * characters become a single space, the result is trimmed and cut to `max` code
 * points. A value that already satisfies displayText comes back unchanged.
 */
export function cleanDisplayText(s: string, max: number): string {
  const cleaned = String(s ?? '').replace(CONTROL_RUN_RE, ' ').trim()
  return codePoints(cleaned) <= max ? cleaned : [...cleaned].slice(0, max).join('')
}
