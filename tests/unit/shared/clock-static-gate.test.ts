/*
 * T5 — no clock read survives in a windowing or labelling path.
 *
 * WHY A STATIC GATE AND NOT A BEHAVIOURAL TEST. `clock-rot-audit.md` §F is the
 * argument: the suite runs entirely at `TZ=UTC`, so `getDate()` and
 * `getUTCDate()` are currently the same function and every local-vs-UTC defect
 * is invisible BY CONSTRUCTION. Worse, this defect class is not a timezone bug
 * at all — the offenders already use correct UTC arithmetic. It is OWNERSHIP: a
 * second clock that can disagree with the first. Two clocks agreeing today is
 * indistinguishable, behaviourally, from one clock. Only the source can tell.
 *
 * Five of these surfaces had ZERO test signal of any kind (§F-b) — they would
 * have regressed silently, with no red test and no green one.
 *
 * WHAT IT BANS, in files whose job is to decide or label a window:
 *   - `new Date()` with no argument, and `Date.now()`   → the browser's clock
 *   - `CURRENT_DATE` / `NOW()` in SQL                   → the database's clock,
 *     a THIRD one, and the actual mechanism of the morning dip
 *
 * WHAT IT ALLOWS: `new Date(<something>)`. Parsing a server-supplied day or
 * formatting an instant is not a clock read.
 *
 * ADDING A FILE HERE IS THE POINT. The list is the slice's own perimeter, and it
 * only grows.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { stripComments as stripCommentsShared } from '../../helpers/strip-comments'

const ROOT = resolve(__dirname, '../../..')

/** Files that DECIDE or LABEL a window. None of them may hold a clock. */
const WINDOWING_PATHS = [
  // The contract and the one pure shaper every day-grain chart consumes.
  'shared/reports/clock.ts',
  'shared/reports/day-axis.ts',
  // The chart primitives. Both used to default their axis to the browser's today.
  'app/composables/useChartScale.ts',
  'app/components/charts/TrendArea.vue',
  'app/components/charts/StackedBars.vue',
  // The period controls — the origin of the whole question (four reads in one file).
  'app/components/reporting/DateRangeControl.vue',
  'app/components/reporting/period-presets.ts',
  'app/components/reporting/FinancePeriodControl.vue',
  'app/components/reporting/ScopeFinance.vue',
  // The two rolling trend windows, previously byte-duplicate browser clocks.
  'app/components/reporting/trend-window.ts',
  'app/components/reporting/ScopeRegional.vue',
  'app/components/reporting/ScopeAcrossRegions.vue',
  // The money-shaped one: `dayOfMonth` is every card's pace divisor.
  'app/pages/projects/index.vue',
  // The default budget period on the project create and request forms.
  'app/composables/useProjectFormOptions.ts',
  'app/pages/projects/new.vue',
  'app/pages/projects/request.vue',
  // The §A / §B day-series SQL — where `CURRENT_DATE` was the third clock.
  'server/reporting/engine/usage-series.ts',
  'server/reporting/engine/chargeback-series.ts',
  // The diagnostics cost windows. Split out of the snapshot handler, which is
  // how their SQL `now()` came to be read afresh: a NEW file starts outside
  // this list, so the gate that would have caught it never looked.
  'server/api/v1/admin/diagnostics/costing.get.ts',
  // The practice page's weekly buckets and the drill frame's default month
  // (issue 491): `date_trunc('week', NOW())` and a browser `new Date()`.
  'server/api/v1/rollups/practice/[ouId].get.ts',
  'app/components/reporting/drill-contract.ts',
  'app/composables/useDrillContract.ts',
] as const

/** `new Date()` / `Date.now()` — a clock read with no argument to anchor it. */
const BARE_CLOCK = /\bnew\s+Date\s*\(\s*\)|\bDate\s*\.\s*now\s*\(\s*\)/g
/** SQL's own clock. Word-bounded so `CURRENT_DATE` in prose still trips it. */
const SQL_CLOCK = /\bCURRENT_DATE\b|\bCURRENT_TIMESTAMP\b|\bNOW\s*\(\s*\)/gi

/**
 * Strip comments before scanning. These files DOCUMENT the defect they retired
 * — quoting `new Date()` and `CURRENT_DATE` by name is exactly what stops the
 * next author reintroducing it, and a gate that punished the explanation would
 * get the explanation deleted.
 *
 * A SCANNER, not a regex: see the helper's header for the two CodeQL alerts the
 * regex versions earned. Replacement is a SPACE so two tokens either side of a
 * stripped comment cannot fuse into one.
 */
const stripComments = (src: string) => stripCommentsShared(src)

function scanSource(src: string, re: RegExp): string[] {
  const flags = re.flags.includes('g') ? re.flags : `${re.flags}g`
  return stripComments(src).match(new RegExp(re.source, flags)) ?? []
}

function scan(rel: string, re: RegExp): string[] {
  const src = stripComments(readFileSync(resolve(ROOT, rel), 'utf8'))
  // Preserve the pattern's OWN flags. Rebuilding with a bare 'g' silently
  // dropped `i`, so the SQL clock was matched case-sensitively while this
  // codebase writes `now()` lowercase — the gate looked at the right files and
  // saw nothing. `g` is added, never substituted.
  const flags = re.flags.includes('g') ? re.flags : `${re.flags}g`
  return src.match(new RegExp(re.source, flags)) ?? []
}

describe('T5 — the windowing and labelling paths hold no clock', () => {
  it.each(WINDOWING_PATHS)('%s has no bare `new Date()` / `Date.now()`', (rel) => {
    expect({ file: rel, hits: scan(rel, BARE_CLOCK) }).toEqual({ file: rel, hits: [] })
  })

  it.each(WINDOWING_PATHS)('%s has no SQL clock (CURRENT_DATE / NOW())', (rel) => {
    expect({ file: rel, hits: scan(rel, SQL_CLOCK) }).toEqual({ file: rel, hits: [] })
  })

  it('the gate itself is honest — it DOES catch a clock read', () => {
    // Guard the guard (the `ab-decomposition.test.ts:496` pattern): a regex that
    // matched nothing anywhere would pass every case above while proving nothing.
    expect(stripComments('const x = new Date()').match(BARE_CLOCK)).toHaveLength(1)
    expect(stripComments('const x = Date.now()').match(BARE_CLOCK)).toHaveLength(1)
    expect(stripComments('GREATEST(CURRENT_DATE, x)').match(SQL_CLOCK)).toHaveLength(1)
    expect(stripComments("date_trunc('week', NOW())").match(SQL_CLOCK)).toHaveLength(1)
    // SQL keywords are case-INSENSITIVE and this codebase writes them lowercase.
    // Asserting only the uppercase spelling is how a blind gate passed its own
    // honesty check: scan() rebuilt the pattern without `i`, so every real
    // `now()` in a scanned file went unseen.
    expect(stripComments("ts_event >= now() - interval '7 days'").match(SQL_CLOCK)).toHaveLength(1)
    expect(stripComments('GREATEST(current_date, x)').match(SQL_CLOCK)).toHaveLength(1)
    expect(scanSource("ts_event >= now() - interval '1 day'", SQL_CLOCK)).toHaveLength(1)
    // …and does NOT punish an anchored construction, which is not a clock read.
    expect(stripComments('new Date(Date.parse(day))').match(BARE_CLOCK)).toBeNull()
    expect(stripComments('new Date(ms)').match(BARE_CLOCK)).toBeNull()
  })

  it('the ONE allowed clock read is the request boundary, and it is singular', () => {
    // `requestClock` is where an instant enters the server, memoised per request
    // so the SQL frontier, the cache key and the shipped contract are the same
    // moment. If a second `new Date()` appears in it, there are two again.
    const src = stripComments(readFileSync(resolve(ROOT, 'server/utils/request-clock.ts'), 'utf8'))
    expect(src.match(BARE_CLOCK)).toHaveLength(1)
  })
})
