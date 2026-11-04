/*
 * weekly-lanes — kit-level WEEKLY lane folding + the partial-week rules for
 * every weekly lane-dimensioned chart (lane-visuals iter-2 I1/I2/I4).
 *
 * The rules, stated mechanically:
 *   - the WEEK AXIS zero-fills every ISO week (Monday keys, matching Postgres
 *     `date_trunc('week')`) intersecting the rendered window, so a week with no
 *     rows renders a genuine 0 (temporal shape stays honest).
 *   - the PARTIAL CURRENT WEEK (the week containing `today`) is rendered but
 *     flagged `inProgressWeek`: it is EXCLUDED from fold ranking and from every
 *     delta/stat (r1-F4), and the chart styles it lighter + dashed.
 *   - fold MEMBERSHIP is a pure function of the rendered window's COMPLETE
 *     weeks (rank-once, MAX_CHART_LANES — fold-lanes.ts rules; the partial week
 *     is excluded from the ranking input only, never from the rendered bars).
 *     Cross-render reshuffling is handled by DISCLOSURE, not freezing (r2-1):
 *     the remainder's per-week composition is itemised for its tooltip.
 *   - the SHARE rendering allocates each week's lane shares with the
 *     largest-remainder method (allocate-cents over percent units), so the
 *     share rows sum to exactly 100.00 for every week with data.
 *   - deltas (`computeCompositionDelta`) come from the UNFOLDED cells (r1-F5):
 *     fold membership can never pollute them. MoM = the last COMPLETE 4 weeks
 *     vs the prior complete 4.
 *
 * Pure TS (no Vue, no DOM) so the maths is unit-testable — the weekly sibling
 * of fold-lanes.ts.
 */
import { VENDOR_LANES, VENDOR_LABELS, toolToVendor } from '#shared/usage/vendor'
import { CLAUDE_CODE_TOOL } from '#shared/usage/surface'
import { utcWeekStart } from '#shared/reports/clock'
import { allocateCents } from '#shared/usage/allocate-cents'
import { foldLaneTotals, FOLDED_LANE_ID, FOLDED_LANE_LABEL, MAX_CHART_LANES } from './fold-lanes'

/** One `(ISO week, lane)` cell — the minimal weekly lane input shape. */
export interface WeeklyLaneCell {
  /** `YYYY-MM-DD` — the ISO week's Monday. */
  weekStart: string
  lane: string
  usd: number
}

/** One weekly point (mirrors the chart kit's TrendPoint). */
export interface WeeklyLanePoint {
  x: string
  y: number
}

/** One weekly series (mirrors the chart kit's TrendSeries). */
export interface WeeklyLaneSeries {
  name: string
  key: string
  data: WeeklyLanePoint[]
}

/** The composition delta (unfolded basis, complete-4-weeks vs prior-4 — I1). */
export interface CompositionDelta {
  /** Avg non-Code $ per week over the last 4 COMPLETE weeks. */
  nonCodeAvgWeekUsd: number
  /** (last4 − prior4) / prior4 non-Code $, a FRACTION; null when prior4 ≤ 0. */
  nonCodeMomPct: number | null
  /** Non-Code share of the last 4 complete weeks, a FRACTION in [0,1]. */
  nonCodeSharePct: number
  /** share(last4) − share(prior4) in share POINTS (fraction diff); null when prior4 total ≤ 0. */
  nonCodeShareDeltaPts: number | null
}

export interface BuiltWeeklyLanes {
  /** Zero-filled ISO-week axis (Monday keys) over the rendered window, ascending. */
  weeks: string[]
  /** The rendered partial current week's Monday, or null when the window has none. */
  inProgressWeek: string | null
  /** Folded absolute-$ series (kept lanes in canonical order + remainder last),
   *  INCLUDING the partial week's bars (tooltip-flagged; stats exclude it). */
  series: WeeklyLaneSeries[]
  /** The SAME folded series as per-week 100%-shares (percent units; each data
   *  week's rows sum to exactly 100.00 via largest-remainder allocation). */
  shareSeries: WeeklyLaneSeries[]
  /** The lane ids actually rendered (kept + the folded remainder) — legend source. */
  laneIds: string[]
  /** Whole-WINDOW totals of the folded-away lanes — disclosure itemisation. */
  folded: Array<{ lane: string; label: string; total: number }>
  /** Per-week remainder composition (weekStart → folded lanes' $ that week) —
   *  the r2-1 disclosure: every remainder segment's tooltip itemises exactly
   *  what it contains that week. */
  remainderByWeek: Record<string, Array<{ lane: string; label: string; usd: number }>>
  /** Σ over EVERY input cell (incl. the partial week) — the conservation operand. */
  totalUsd: number
  /** Composition delta from the UNFOLDED cells (null when < 8 complete weeks). */
  delta: CompositionDelta | null
}

/** The Claude CODE lane id, registry-derived (never a hand literal). */
const CODE_LANE = toolToVendor(CLAUDE_CODE_TOOL)

const LANE_ORDER = new Map<string, number>(VENDOR_LANES.map((l, i) => [l, i]))

/** Display label for a registry lane id (falls back to the raw id). */
function laneLabel(lane: string): string {
  return (VENDOR_LABELS as Readonly<Record<string, string>>)[lane] ?? lane
}

const DAY_MS = 86_400_000

/**
 * The ISO week's Monday (`YYYY-MM-DD`) for a UTC day — matches Postgres
 * `date_trunc('week')`. The shared definition, so the practice endpoint's week
 * buckets and this axis cannot drift apart.
 */
export function mondayOf(day: string): string {
  return utcWeekStart(day)
}

/**
 * Zero-filled Monday axis covering `[from, to]` (both inclusive `YYYY-MM-DD`),
 * CLAMPED so it never runs past a week that has not begun.
 *
 * WHY THE CLAMP. Every series on this axis is zero-filled across it, so a week
 * beyond today renders as a measured $0 — the chart asserting "nobody spent that
 * week" about a week that has not happened. That is the same false claim the KPI
 * sparklines carried at day grain (fixed in the reporting engine's
 * `fetchDailyMetrics` / `fetchChargebackTrend`), and leaving it here would make
 * the daily and weekly views of one dataset disagree about where the data ends.
 *
 * It is NOT live at today's call sites — in month mode the trend window is
 * `[today-59, today]`, so `to` IS today. It becomes reachable through the custom
 * date range, whose `to` input carries no upper bound: pick a `to` next month and
 * the hero currently draws flat zero weeks out to it.
 *
 * `lastCellWeek` is the same escape hatch the server-side clamp has: if a cell
 * genuinely carries a week beyond today, the axis extends to include it rather
 * than dropping money the totals still count. Weeks strictly inside `[from, to]`
 * that are merely EMPTY are untouched — a past week with no spend is a real zero.
 */
function weekAxis(from: string, to: string, opts?: { today?: string; lastCellWeek?: string }): string[] {
  const at = (d: string) => Date.parse(`${mondayOf(d)}T00:00:00.000Z`)
  const start = at(from)
  let last = at(to)
  if (opts?.today) {
    const frontier = Math.max(at(opts.today), opts.lastCellWeek ? at(opts.lastCellWeek) : -Infinity)
    last = Math.min(last, frontier)
  }
  const weeks: string[] = []
  for (let t = start; t <= last; t += 7 * DAY_MS) {
    weeks.push(new Date(t).toISOString().slice(0, 10))
  }
  return weeks
}

/**
 * Regroup per-(day, lane) points to per-(ISO week, lane) cells — the weekly
 * regrouping the chargeback lane trend renders at (iter-2 I2/I4). Pure Σ over
 * UTC-Monday buckets: Σ(weekly cells) == Σ(daily points) by construction (the
 * grain-conservation test pins it).
 */
export function groupLaneDaysToWeeks(
  points: ReadonlyArray<{ day: string; lane: string; chargeUsd: number }>,
): WeeklyLaneCell[] {
  const byWeekLane = new Map<string, number>()
  for (const p of points) {
    const k = `${mondayOf(p.day)} ${p.lane}`
    byWeekLane.set(k, (byWeekLane.get(k) ?? 0) + p.chargeUsd)
  }
  return [...byWeekLane.entries()]
    .map(([k, usd]) => {
      const [weekStart, lane] = k.split(' ') as [string, string]
      return { weekStart, lane, usd }
    })
    .sort(
      (a, b) =>
        (a.weekStart < b.weekStart ? -1 : a.weekStart > b.weekStart ? 1 : 0) ||
        (LANE_ORDER.get(a.lane) ?? 99) - (LANE_ORDER.get(b.lane) ?? 99),
    )
}

/**
 * Composition delta over UNFOLDED weekly cells (r1-F5 — fold membership can
 * never pollute it): the last 4 COMPLETE weeks vs the prior complete 4.
 * `completeWeeks` is the ascending complete-week axis (the partial current week
 * already excluded); weeks with no cells count as genuine $0 weeks. Returns
 * null when fewer than 8 complete weeks are rendered or the last 4 carry no
 * spend (no honest delta exists).
 */
export function computeCompositionDelta(
  cells: readonly WeeklyLaneCell[],
  completeWeeks: readonly string[],
  opts: { codeLane?: string } = {},
): CompositionDelta | null {
  if (completeWeeks.length < 8) return null
  const codeLane = opts.codeLane ?? CODE_LANE
  const last4 = new Set(completeWeeks.slice(-4))
  const prior4 = new Set(completeWeeks.slice(-8, -4))
  let last4Total = 0
  let last4NonCode = 0
  let prior4Total = 0
  let prior4NonCode = 0
  for (const c of cells) {
    if (last4.has(c.weekStart)) {
      last4Total += c.usd
      if (c.lane !== codeLane) last4NonCode += c.usd
    } else if (prior4.has(c.weekStart)) {
      prior4Total += c.usd
      if (c.lane !== codeLane) prior4NonCode += c.usd
    }
  }
  if (last4Total <= 0) return null
  const share = last4NonCode / last4Total
  const priorShare = prior4Total > 0 ? prior4NonCode / prior4Total : null
  return {
    nonCodeAvgWeekUsd: last4NonCode / 4,
    nonCodeMomPct: prior4NonCode > 0 ? (last4NonCode - prior4NonCode) / prior4NonCode : null,
    nonCodeSharePct: share,
    nonCodeShareDeltaPts: priorShare == null ? null : share - priorShare,
  }
}

/**
 * Build the folded weekly lane stack (+ its 100%-share twin, disclosure
 * itemisation, and the unfolded composition delta) from `(week, lane, usd)`
 * cells over an inclusive `[from, to]` window.
 *
 * @param opts.today          `YYYY-MM-DD` (UTC) — identifies the partial current week
 * @param opts.remainderLabel remainder display label (the hero passes its
 *                            "(composition varies)" variant; default kit label)
 */
export function buildWeeklyLanes(
  cells: readonly WeeklyLaneCell[],
  opts: { from: string; to: string; today: string; remainderLabel?: string },
): BuiltWeeklyLanes {
  /*
   * The latest week any CELL carries, so the axis can extend past today when
   * real data does — clamping to today alone would drop money the totals still
   * count. Computed before the axis, over the raw cells (the axis does not exist
   * yet to clip against).
   */
  const lastCellWeek = cells.reduce<string | undefined>(
    (max, c) => (max === undefined || c.weekStart > max ? c.weekStart : max),
    undefined,
  )
  const weeks =
    opts.from && opts.to
      ? weekAxis(opts.from, opts.to, { today: opts.today, lastCellWeek })
      : []
  const currentWeek = mondayOf(opts.today)
  const inProgressWeek = weeks.includes(currentWeek) ? currentWeek : null
  const completeWeeks = weeks.filter((w) => w !== inProgressWeek)
  const completeSet = new Set(completeWeeks)

  // Group cells by lane (canonical order) — clip to the rendered axis so a
  // stray out-of-window cell can never paint outside the chart.
  const weekSet = new Set(weeks)
  const byLane = new Map<string, Map<string, number>>()
  let totalUsd = 0
  for (const c of cells) {
    if (!weekSet.has(c.weekStart)) continue
    let m = byLane.get(c.lane)
    if (!m) byLane.set(c.lane, (m = new Map()))
    m.set(c.weekStart, (m.get(c.weekStart) ?? 0) + c.usd)
    totalUsd += c.usd
  }
  const lanes = [...byLane.keys()].sort(
    (a, b) => (LANE_ORDER.get(a) ?? 99) - (LANE_ORDER.get(b) ?? 99),
  )

  // Fold MEMBERSHIP from the COMPLETE weeks only (r1-F4): rank-once via the kit
  // fold over per-lane complete-week totals; the partial week is excluded from
  // the ranking input but stays in every rendered series below.
  const completeTotal = (lane: string): number => {
    let t = 0
    for (const [w, v] of byLane.get(lane) ?? []) if (completeSet.has(w)) t += v
    return t
  }
  const ranked = foldLaneTotals(
    lanes.map((lane) => ({ lane, label: laneLabel(lane), value: completeTotal(lane) })),
    { max: MAX_CHART_LANES },
  )
  const keptLanes = ranked.totals.filter((t) => t.lane !== FOLDED_LANE_ID).map((t) => t.lane)
  const foldedLanes = ranked.folded.map((f) => f.lane)
  const remainderLabel = opts.remainderLabel ?? FOLDED_LANE_LABEL

  const laneWindowTotal = (lane: string): number => {
    let t = 0
    for (const v of byLane.get(lane)?.values() ?? []) t += v
    return t
  }

  // Absolute-$ series: kept lanes + (when folding occurred) the remainder last,
  // every series zero-filled over the FULL axis (incl. the partial week).
  const series: WeeklyLaneSeries[] = keptLanes.map((lane) => ({
    name: laneLabel(lane),
    key: lane,
    data: weeks.map((x) => ({ x, y: byLane.get(lane)?.get(x) ?? 0 })),
  }))
  const remainderByWeek: Record<string, Array<{ lane: string; label: string; usd: number }>> = {}
  if (foldedLanes.length > 0) {
    series.push({
      name: remainderLabel,
      key: FOLDED_LANE_ID,
      data: weeks.map((x) => ({
        x,
        y: foldedLanes.reduce((a, lane) => a + (byLane.get(lane)?.get(x) ?? 0), 0),
      })),
    })
    // Per-week disclosure (r2-1): itemise exactly what the remainder holds each week.
    for (const w of weeks) {
      const items = foldedLanes
        .map((lane) => ({ lane, label: laneLabel(lane), usd: byLane.get(lane)?.get(w) ?? 0 }))
        .filter((i) => i.usd !== 0)
      if (items.length > 0) remainderByWeek[w] = items
    }
  }

  // 100%-share twin: per week, largest-remainder allocation over percent units
  // (allocate-cents with total=100 → 2-dp shares summing to exactly 100.00).
  const shareSeries: WeeklyLaneSeries[] = series.map((s) => ({
    name: s.name,
    key: s.key,
    data: weeks.map((x) => ({ x, y: 0 })),
  }))
  weeks.forEach((w, wi) => {
    const values = series.map((s) => s.data[wi]?.y ?? 0)
    const weekTotal = values.reduce((a, v) => a + v, 0)
    if (weekTotal <= 0) return
    const shares = allocateCents(
      values.map((v) => (v / weekTotal) * 100),
      100,
    )
    shares.forEach((pct, si) => {
      shareSeries[si]!.data[wi]!.y = pct
    })
  })

  return {
    weeks,
    inProgressWeek,
    series,
    shareSeries,
    laneIds: series.map((s) => s.key),
    folded: ranked.folded.map((f) => ({
      lane: f.lane,
      label: f.label,
      total: laneWindowTotal(f.lane),
    })),
    remainderByWeek,
    totalUsd,
    delta: computeCompositionDelta(
      cells.filter((c) => weekSet.has(c.weekStart)),
      completeWeeks,
    ),
  }
}

// ── Peak day (iter-2 I4 — the daily-grain outlier chip) ───────────────────────
/**
 * The peak day of a rendered DAILY chart — computed FROM THE CHART'S OWN series
 * (same points, same UTC day keys — r2-3), so the chip and the chart can never
 * disagree. Sums every series' y per x (the stacked/summed day total), skipping
 * projected days (`x >= excludeFrom` — a run-rate guess must never win the
 * chip). Ties resolve to the EARLIEST day. Null when nothing positive renders.
 */
export function computePeakDay(
  series: ReadonlyArray<{ data: ReadonlyArray<{ x: string; y: number }> }>,
  opts: { excludeFrom?: string } = {},
): { day: string; totalUsd: number } | null {
  const byDay = new Map<string, number>()
  for (const s of series) {
    for (const p of s.data) {
      if (opts.excludeFrom && p.x >= opts.excludeFrom) continue
      byDay.set(p.x, (byDay.get(p.x) ?? 0) + p.y)
    }
  }
  let best: { day: string; totalUsd: number } | null = null
  for (const [day, totalUsd] of byDay) {
    if (!best || totalUsd > best.totalUsd || (totalUsd === best.totalUsd && day < best.day)) {
      best = { day, totalUsd }
    }
  }
  return best && best.totalUsd > 0 ? best : null
}
