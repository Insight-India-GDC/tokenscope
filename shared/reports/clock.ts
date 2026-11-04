/*
 * THE CLOCK — one resolution, shipped, never re-derived.
 *
 * `docs/design/clock-and-day-boundary.md` settles what a day is: **UTC,
 * everywhere**, because all three sources bill and report in UTC days
 * (Anthropic `bucket_width=1d` at `[day 00:00:00Z, next 00:00:00Z)`, Copilot
 * per `getUTCDate()`, OTel instants bucketed `AT TIME ZONE 'UTC'`). A local-day
 * product would make every one of our days straddle two provider days, so
 * `Σ(our days)` could never equal the bill.
 *
 * D3 is the rule this module exists for: **"today" is not a wall-clock fact, so
 * the browser must not compute it.** The server resolves the clock ONCE and
 * ships it; every clock-sensitive control consumes it. That is an *ownership*
 * rule, not a timezone one — most of the offenders it retires already used
 * correct UTC arithmetic (`getUTCFullYear`, `Date.UTC`), which is exactly why
 * two clocks disagreeing never read as a bug.
 *
 * THREE QUANTITIES, KEPT APART (D2 of the fix sprint). The codebase conflated
 * the last two and that conflation IS the morning dip:
 *
 *   - `now`            — an INSTANT. Renders in the viewer's local zone.
 *   - `today`          — the UTC day `now` falls in. STILL FILLING: it is drawn
 *                        partial and excluded from trend lines, trailing means
 *                        and peak labels. It is NOT the axis edge.
 *   - `settledThrough` — the last COMPLETE UTC day. THE AXIS EDGE.
 *
 * And a fourth that is deliberately NOT here: `asOfDate` (`MAX(event_date)`) is
 * a *data* fact — the last day we hold rows for. `settledThrough` is a
 * *coverage* fact. A series may legitimately run past `asOfDate` (a settled day
 * with genuinely no spend is a measured zero) and must never be padded past
 * `settledThrough` (a day we have not finished observing is not a zero — NULL
 * is not 0).
 *
 * DEFERRED, DISCLOSED (fix-sprint F1): provider lag as a *distinct* cause of a
 * short edge. `settledThrough` here is the last complete UTC day, full stop. A
 * provider whose pull is 30 h behind still shortens what the data can say, but
 * this contract does not yet narrow the edge for it — `clock-rot-audit.md` §H.1
 * records why (the freshness signal is a per-teammate, per-provider staleness
 * verdict, not a global last-covered day, and the fail-closed rule needs an
 * owner decision for the global case).
 */

/** The server's resolved clock, shipped to every clock-sensitive surface. */
export interface ServerClock {
  /**
   * The server instant, ISO-8601 UTC (`2026-08-05T09:14:22.000Z`). An INSTANT —
   * render it in the viewer's local zone (D2). Nothing reconciles against it.
   */
  now: string
  /**
   * The UTC day `now` falls in (`YYYY-MM-DD`). A day bucket: NEVER converted for
   * display. Still filling, so it is drawn partial, never as a dip, and it is
   * not the right edge of an axis.
   */
  today: string
  /**
   * The last COMPLETE UTC day (`YYYY-MM-DD`) — `today` minus one day. Charts run
   * to here; `today` is drawn distinctly beyond it (D4).
   */
  settledThrough: string
}

const DAY_MS = 86_400_000

/** The UTC day a `YYYY-MM-DD` string names, as epoch ms at 00:00:00Z. */
function dayMs(day: string): number {
  const ms = Date.parse(`${day}T00:00:00.000Z`)
  if (Number.isNaN(ms)) throw new Error(`not a YYYY-MM-DD UTC day: ${day}`)
  return ms
}

/** `YYYY-MM-DD` of an epoch-ms instant, in UTC. */
export function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10)
}

/**
 * Shift a UTC day by whole days. Pure, clock-free, DST-immune (UTC has no DST,
 * which is half of why D1 picked it).
 */
export function shiftUtcDay(day: string, days: number): string {
  return utcDay(dayMs(day) + days * DAY_MS)
}

/**
 * Resolve the clock. The ONE place `now` becomes `today` and `settledThrough`.
 *
 * `now` is a REQUIRED argument — the seam the rest of the codebase already
 * proves (`server/utils/period.ts`, `server/reports/settling.ts`, every worker).
 * A default of `new Date()` would put a second clock inside the module whose
 * whole purpose is that there is only one.
 */
export function resolveServerClock(now: Date): ServerClock {
  const iso = now.toISOString()
  const today = iso.slice(0, 10)
  return { now: iso, today, settledThrough: shiftUtcDay(today, -1) }
}

// ── Pure derivations from a UTC day (no clock involved) ──────────────────────
// These take a `YYYY-MM-DD` the SERVER resolved. They are safe on the client
// precisely because they read an argument rather than asking the browser what
// time it is.

/** The UTC month (`YYYY-MM`) a day belongs to. */
export function utcMonthOf(day: string): string {
  return day.slice(0, 7)
}

/** 1-based day-of-month. The pace DIVISOR — a browser-derived one reaches money. */
export function utcDayOfMonth(day: string): number {
  return Number(day.slice(8, 10))
}

/** Days in the UTC month a day belongs to. */
export function utcDaysInMonth(day: string): number {
  const y = Number(day.slice(0, 4))
  const m = Number(day.slice(5, 7))
  return new Date(Date.UTC(y, m, 0)).getUTCDate()
}

/**
 * The Monday (`YYYY-MM-DD`) of the ISO week a UTC day belongs to: the same
 * bucket Postgres `date_trunc('week', …)` gives, computed from a server-resolved
 * day instead of the database's own `NOW()`.
 */
export function utcWeekStart(day: string): string {
  const dow = new Date(dayMs(day)).getUTCDay() // 0=Sun..6=Sat
  return shiftUtcDay(day, -((dow + 6) % 7)) // Mon→0 … Sun→6
}

/** The last UTC day (`YYYY-MM-DD`) of the month a day belongs to. */
export function utcMonthEnd(day: string): string {
  return `${utcMonthOf(day)}-${String(utcDaysInMonth(day)).padStart(2, '0')}`
}
