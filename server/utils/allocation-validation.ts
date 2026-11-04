/*
 * Allocation write validation + tstzrange helpers (API-6 / FE-1,
 * robustness-review-2026-06-09).
 *
 * The allocation write paths previously validated `effective` only as
 * /^\[[^,]+,[^)]+\)$/ — garbage bounds passed zod and raised 22007 in PG
 * (→ 500), and there was no lower<upper check. `budget_usd` was an
 * unbounded digit string vs the column's NUMERIC(14,2) (22003 → 500).
 * These shared schemas reject both BEFORE Postgres sees them.
 *
 * (Lives in server/utils — not shared/schemas — because both the bound
 * parsing and the consumers are server-only; the client receives the
 * normalised effective_from/effective_to ISO fields instead.)
 */
import { z } from 'zod'

/**
 * NUMERIC(14,2) magnitude bound: at most 12 integer digits + 2 decimals.
 * Same shape as the previous per-route regex, with the magnitude capped so
 * an oversized amount is a clean 400 instead of a PG 22003 → 500.
 */
export const BudgetUsdSchema = z
  .string()
  .regex(
    /^\d{1,12}(\.\d{1,2})?$/,
    'budget_usd must be a positive USD amount with at most 2 decimals and at most 12 integer digits',
  )

/**
 * Ceiling on ONE top-up (H32). A top-up is an in-period increment to a
 * project pool, not a pool itself: baselines keep the column-wide bound above,
 * but a single top-up beyond $1M is a typo or abuse, not a budget decision.
 * Validated as a decimal string so no float rounding touches the comparison.
 */
export const MAX_TOPUP_USD = 1_000_000

export const TopUpBudgetUsdSchema = BudgetUsdSchema.refine(
  (v) => {
    const [int = '', frac = ''] = v.split('.')
    const n = Number(int)
    return n < MAX_TOPUP_USD || (n === MAX_TOPUP_USD && /^0*$/.test(frac))
  },
  { message: `budget_usd for a top-up must be at most ${MAX_TOPUP_USD} USD` },
)

const RANGE_RE = /^\[([^,]+),([^)]+)\)$/

/** Parse one tstzrange bound (optionally double-quoted, as PG renders it).
 * Exported (R2 F2) so derived validators (rate-card day-alignment) parse
 * bounds with the SAME normaliser — a stricter ad-hoc parse re-creates the
 * exact `+00` mismatch this function exists to prevent. */
export function parseBound(raw: string): Date | null {
  const cleaned = raw.trim().replace(/^"+|"+$/g, '')
  if (!cleaned) return null
  // Postgres accepts a BARE-HOUR offset (e.g. `+00`) on a tstzrange bound,
  // but V8's STRICT ISO parser rejects the `T..+00` form (it requires
  // `+00:00`) while accepting the space form via its lenient legacy path.
  // The UI builds `${date}T00:00:00+00` (and API/MCP callers may too), so
  // without this the validator is STRICTER than the DB and 400s a bound PG
  // would have stored — surfacing as a bare "Validation Error" on the budget
  // step. Normalise a trailing `±HH` offset (only when it follows a full
  // HH:MM:SS time, so date-only bounds like `2026-06-01` are untouched) to
  // `±HH:00`. PG treats the two identically, so this only widens acceptance
  // to match PG, never beyond it.
  const normalised = cleaned.replace(/(\d{2}:\d{2}:\d{2})([+-]\d{2})$/, '$1$2:00')
  const d = new Date(normalised)
  return Number.isNaN(d.getTime()) ? null : d
}

/**
 * `effective` as a `[from,to)` tstzrange literal with BOTH bounds required,
 * parseable as timestamps, and lower < upper. The validated value stays the
 * original string (handlers pass it to PG with a ::tstzrange cast).
 */
export const EffectiveRangeSchema = z.string().superRefine((value, ctx) => {
  const m = RANGE_RE.exec(value)
  if (!m) {
    ctx.addIssue({ code: 'custom', message: 'effective must be a tstzrange like [from,to)' })
    return
  }
  const lower = parseBound(m[1]!)
  const upper = parseBound(m[2]!)
  if (!lower || !upper) {
    ctx.addIssue({ code: 'custom', message: 'effective bounds must be parseable timestamps' })
    return
  }
  if (lower.getTime() >= upper.getTime()) {
    ctx.addIssue({ code: 'custom', message: 'effective lower bound must be before the upper bound' })
  }
})

/**
 * Parse PG's tstzrange text output (e.g.
 * `["2026-05-01 00:00:00+00","2026-06-01 00:00:00+00")`) into normalised
 * ISO-8601 bounds. Unbounded / empty / unparseable bounds come back null —
 * the server-side half of FE-1 (clients must NOT regex-parse the raw text;
 * the quoted-bound format only parses under V8 leniency).
 */
export function parseTstzrangeText(text: string | null | undefined): {
  from: string | null
  to: string | null
} {
  if (!text) return { from: null, to: null }
  const m = /^[[(]([^,]*),([^)\]]*)[)\]]$/.exec(text.trim())
  if (!m) return { from: null, to: null }
  const from = parseBound(m[1]!)
  const to = parseBound(m[2]!)
  return { from: from ? from.toISOString() : null, to: to ? to.toISOString() : null }
}

/**
 * Most top-ups a project pool may carry that are still live (effective range
 * not yet ended) or were recorded in the last {@link TOPUP_CAP_RECENT_DAYS}
 * days. Top-ups stack and every one is a row summed on each budget read, so an
 * unbounded count is unbounded growth from one caller (H32). A back-dated
 * top-up is never live, so it must count by when it was recorded, or one
 * caller could append them without limit; old expired top-ups drop out, so a
 * long-lived project is never locked out.
 */
export const MAX_LIVE_TOPUPS_PER_PROJECT = 50
export const TOPUP_CAP_RECENT_DAYS = 30
