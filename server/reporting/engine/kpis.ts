/*
 * The reporting KPI row, scope-parameterised — ONE implementation for the
 * regional and whole-company headline tiles that previously carried a copy each.
 *
 * The pair these replace were line-identical once the scope predicate was
 * normalised away, across FIVE queries (§A totals, the month floor, the §B daily
 * bill grain, the §B pooled Copilot month, and the previous-month chargeback
 * operand) plus the composition that turns them into tiles. Every fix therefore
 * had to be applied twice, and a fix applied to one copy only is a silent
 * divergence between two surfaces that report the same money at two scopes.
 *
 * WHY THIS MODULE READS BOTH LANES, when every other engine module reads one.
 * The KPI row is the one place a §A figure and a §B figure are rendered side by
 * side: `genuineUsd` is USAGE (usage_rollup_daily — the day-grain rollup whose
 * content is defined as an aggregate of v_complete_usage, so it IS what the
 * company consumed; docs/design/usage-rollup-lane.md R5) and
 * `chargeableUsd` / `prevChargeableUsd` / `billedTokens` / `billedTeammates` are
 * BILL (the v_finance_* views — what is charged back). They are never summed
 * with each other here, and no returned field mixes them: the two lanes answer
 * different questions on different grains
 * (docs/design/provider-billing-attribution-model.md, consistency contract C2).
 *
 * That is precisely why the scope argument is a PAIR of separately-lane-typed
 * clamps rather than one predicate: §A clamps address the people in a placement (or a current-lens column)
 * and §B clamps address (region_id, cost_owning_unit_id), so passing either one
 * where the other belongs is a compile error (engine/scope.ts `Lane`), not a
 * quietly smaller number.
 */
import { sql } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { laneListSql } from '../../../shared/usage/vendor'
import {
  GITHUB_CHARGEABLE_LANES,
  GITHUB_FIREWALL_EXCLUSIONS,
} from '../../../shared/usage/github-surface'
import { isMonthAlignedWindow, momPaceWindow, type UsageWindow } from '../params'
import { monthKeyUtc, monthRangeUtc, type MonthRangeUtc } from '../../utils/period'
import { reportMonthFloor } from '../month-floor'
import { scopeSql, type FinanceScope, type UsageScope } from './scope'

type Tx = PostgresJsDatabase<Record<string, unknown>>

interface KpiRow extends Record<string, unknown> {
  genuine: string
  tokens: string
  active_users: number
  as_of: string | null
}
interface ChargeRow extends Record<string, unknown> {
  anthropic: string
  copilot: string
}

/**
 * The two clamps a KPI row is summed over, plus the identity its month floor is
 * cached under.
 *
 * `monthFloorKey` is supplied by the caller because only the caller knows what
 * makes its scope unique; the floor's PREDICATE is not, and is taken from
 * `usage` here. That is the point: the floor and the §A headline are then
 * clamped by the same object by construction, so a floor that answered for a
 * different scope than the total beside it — a wrong 400 on a month the caller
 * does have data in — cannot be introduced by editing one and not the other.
 */
export interface ReportKpiScope {
  /** §A clamp, unaliased, on `v_usage_rollup_current` (`teammate_id`, or a current-lens column). */
  usage: UsageScope
  /** §B clamp, over (`region_id`, `cost_owning_unit_id`) on the `v_finance_*` views. */
  finance: FinanceScope
  /** Cache identity for the month floor. MUST vary with `usage` (month-floor.ts). */
  monthFloorKey: string
}

/**
 * The KPI figures BOTH reporting scopes publish. Each scope's own exported
 * interface is this shape (whole-company adds the §A month-over-month trio it
 * alone renders).
 */
export interface ReportKpiCore {
  /** §A usage-lane genuine total over the window (all genuine cost incl. NFR/exempt). */
  genuineUsd: number
  /**
   * §B chargeable total: `anthropicChargeableUsd` always, PLUS the pooled Copilot
   * net only when chargeback mode is on AND the window is month-aligned (see
   * `copilotPartialMonthUnavailable`). Never summed with `genuineUsd`.
   */
  chargeableUsd: number
  /** §B Anthropic chargeable over the window (always included in `chargeableUsd`). */
  anthropicChargeableUsd: number
  /**
   * §B Copilot pooled net for the months inside the window. REPORTED whatever the
   * mode, so a caller can render it; FOLDED into `chargeableUsd` only in chargeback
   * mode over a month-aligned window.
   */
  copilotChargeableUsd: number
  /** §A tokens over the window. */
  tokens: number
  /**
   * §A people who SPENT: distinct teammates whose Σ `cost_usd` over this scope
   * and window is POSITIVE. NOT "carried a row" — a $0 window is not spend, and
   * this is the SAME population `fetchAcrossPerPerson` takes the median and the
   * concentration percentiles over, so the KPI row's headcount and its median's
   * denominator are one number by construction.
   */
  activeUsers: number
  /**
   * Previous-CALENDAR-month §B chargeable, composed exactly like `chargeableUsd`
   * — the chargeback MoM operand. 0 unless the viewed month is CLOSED (see the
   * `chargeMomClosed` gate below), which includes range mode.
   */
  prevChargeableUsd: number
  /**
   * (chargeable − prevChargeable)/prevChargeable as a FRACTION, or null when
   * there is no prior operand. The §B analogue of the §A usage MoM — month-grained,
   * so it compares whole months (no day-of-month pacing, a §A concern). The two
   * are NEVER mixed.
   */
  chargeMomDeltaPct: number | null
  /**
   * §B distinct teammates carrying an ANTHROPIC chargeback bill over the window
   * (`v_finance_bill_chargeback`). Anthropic-lane only: Copilot chargeback is
   * pooled per cost-centre and carries no per-teammate row at all.
   */
  billedTeammates: number
  /** §B Σ ANTHROPIC bill tokens over the window (`v_finance_bill_chargeback.bill_tokens`). */
  billedTokens: number
  /**
   * §B Anthropic chargeable ÷ billed teammates (0 when none). Deliberately NOT
   * `chargeableUsd` ÷ teammates — the Copilot half of that total is pooled and has
   * no per-user charge to average.
   */
  avgChargePerBilledUser: number
  /**
   * §B copilot chargeback is ON but the window is NOT month-aligned, so the pooled
   * (monthly) Copilot net is withheld from `chargeableUsd` — never a partial slice,
   * never a silent $0 under a "+ Copilot pooled net" label. The UI renders a caveat
   * on this flag instead.
   */
  copilotPartialMonthUnavailable: boolean
  /**
   * §A previous-month genuine total over the SAME scope — the usage MoM operand.
   * 0 in range mode (no month anchor) and when the window carries no data.
   */
  prevGenuineUsd: number
  /**
   * §A (genuine − prev)/prev as a FRACTION, or null when there is no prior operand.
   *
   * DAY-PACED, unlike the §B `chargeMomDeltaPct` beside it: the usage lane is
   * day-grained, so the previous month is clipped to the same day-of-month the
   * DATA has reached (`momPaceWindow` on `asOfDate`, never on `now` — during
   * settling `as_of` lags today, and pacing on `now` measures a partial month
   * against MORE previous-month days, i.e. a spurious drop). The bill lane cannot
   * be paced that way, which is why the two deltas are computed differently and
   * are never mixed.
   */
  momDeltaPct: number | null
  /** §A MAX(day) in the window (`YYYY-MM-DD`), or null when the window has no data. */
  asOfDate: string | null
  /** §A earliest month with data in scope (`YYYY-MM`), or null. Cached (month-floor.ts). */
  monthFloor: string | null
}

/**
 * Sum the KPI row for one scope pair and window.
 *
 * `copilotChargeback` decides whether the Copilot pooled net is folded into
 * `chargeableUsd` (chargeback mode) or held back with a "pending" marker
 * (pool-utilisation mode) — build-design §6. `momMonthRange` is the VIEWED
 * month's range and is what makes both MoM deltas computable at all; a custom
 * from/to range passes null, because a month-over-month delta has no meaning for
 * an arbitrary span.
 *
 * THE §A MoM IS COMPUTED HERE, for every scope. It used to live at the
 * whole-company call site alone, on the reasoning that the Regional scope did not
 * render it. That stopped being true when the two widths were brought to one KPI
 * row: the Region width was left computing its own delta CLIENT-side, from a
 * second fetch of the previous month, which is a divergent second implementation
 * of the figure this module exists to own. One query, one clamp, both widths.
 */
export async function fetchKpiCore(
  tx: Tx,
  scope: ReportKpiScope,
  window: UsageWindow,
  opts: { copilotChargeback: boolean; momMonthRange?: MonthRangeUtc | null; now?: Date },
): Promise<ReportKpiCore> {
  const startDate = window.startIso.slice(0, 10)
  const endDate = window.endIso.slice(0, 10)

  // §B chargeback MoM is computed ONLY for a fully-CLOSED calendar month. The bill lane
  // accrues intra-month, so an in-progress month is a PARTIAL MTD accrual; comparing it
  // against a WHOLE prior month understates it (a spurious decline), and month-grained
  // data CANNOT be day-paced the way the day-grained usage lane is. So the MoM is withheld
  // (null) until the viewed month closes. Range mode (no momMonthRange) is null for the
  // same "no month anchor" reason.
  const now = opts.now ?? new Date()
  // Closed = strictly BEFORE the current month (YYYY-MM string compare); `!==` would
  // treat a FUTURE month as closed vs the still-open current month (round-2 #5).
  const chargeMomClosed = opts.momMonthRange != null && opts.momMonthRange.month < monthKeyUtc(now)
  // The gate reads only `opts`, so the prev-month §B read rides wave 1 below.
  const prevMonth = chargeMomClosed
    ? monthRangeUtc(monthKeyUtc(new Date(opts.momMonthRange!.monthStartUtc.getTime() - 1)))
    : null

  /*
   * Concurrent issuance on ONE tx connection: postgres-js pipelines and answers
   * in order — safe; the win is no per-query await gaps (fully one wave on
   * prepared statements), not true parallelism
   * (docs/design/request-floor-performance.md F5). The five reads below share
   * no outputs; only the §A usage-MoM operand after the wave consumes a wave
   * result (`totals.as_of` paces its window), so it alone stays sequential.
   *
   * Per-read notes:
   *
   * TOTALS — grouped per teammate FIRST, then rolled up, because `activeUsers`
   * is a statement about PEOPLE WHO SPENT and that cannot be expressed on the
   * flat rows: `COUNT(DISTINCT teammate_id)` counted anyone carrying a row at
   * all, including a teammate whose whole window nets to $0. That is a
   * different population from the one the per-person cohort divides by
   * (`fetchAcrossPerPerson`, `HAVING SUM(cost_usd) > 0`), so the KPI row
   * published a headcount its own median contradicted. ONE definition, written
   * once: a person is ACTIVE when their Σ `cost_usd` over this scope and window
   * is POSITIVE. `genuine`, `tokens` and `as_of` are unchanged — summing the
   * per-teammate sums is the same total, and `teammate_id` is NOT NULL in the
   * rollup grain (mig 0136), so the grouping introduces no phantom bucket.
   * The read is `usage_rollup_daily`, not the live view (usage-rollup-lane.md
   * R5): the rollup pre-sums the lane per (day, teammate, dims) cell, so
   * per-teammate Σ over cells ≡ Σ over rows, and `MAX(day)` is the same
   * frontier `MAX(ts_event)` dated to UTC was. The window is exact because
   * `startIso`/`endIso` are UTC-midnight instants by construction
   * (resolveReportWindow).
   *
   * FLOOR — cached per scope (month-floor.ts). This query cannot be windowed —
   * it IS a MIN over all history — so it was the one unbounded scan on the
   * page. The predicate is taken from `scope.usage` rather than re-derived, and
   * whole-company passes `null` rather than a `TRUE` clause: month-floor.ts
   * branches on it to emit a query with no WHERE at all, which is the SQL both
   * copies of this function issued before the extraction.
   *
   * BILLED — §B ANTHROPIC chargeable + the per-teammate bill grain — BOTH from
   * the DAILY bill lane (`v_finance_bill_chargeback`, `period_date`-windowed,
   * clamped by the SAME finance predicate). The month view's Anthropic portion
   * is EXACTLY this view rolled to month, so reading it daily is correct for
   * ANY window — a non-month-aligned custom range no longer drops the charge to
   * $0 — and keeps the Anthropic chargeable, billed teammates + billed tokens
   * on ONE window+grain (so `avgChargePerBilledUser` divides same-day-set
   * operands). Copilot is ABSENT from this view (pooled, per-org, no
   * per-teammate row) by construction.
   *
   * CHARGE — §B COPILOT pooled net is POOLED-MONTHLY (month grain — no daily
   * grain to window). Keep it month-grained (summed over every `period_month`
   * inside the window) and fold it on top only in chargeback mode. Clamped by
   * the SAME finance predicate. CHARGEABLE lanes only (registry-driven, mig
   * 0085): copilot-license + copilot-usage; copilot-unclassified NEVER enters a
   * chargeable figure (design D2).
   *
   * PREV CHARGE — Anthropic = everything OUTSIDE the unified GitHub firewall
   * set (every lane id + §A tool literal — never the narrower chargeback-lane
   * list, r1 finding 1); copilot = the CHARGEABLE lanes only (unclassified
   * never charges).
   */
  const [totalsRows, floorMonth, billedRows, chargeRows, prevChargeRows] = await Promise.all([
    tx.execute<KpiRow>(sql`
      WITH per_person AS (
        SELECT teammate_id,
               SUM(cost_usd)  AS cost,
               SUM(tokens)    AS tokens,
               MAX(day)       AS as_of
        FROM v_usage_rollup_current
        WHERE ${scopeSql(scope.usage)}
          AND day >= ${startDate}::date
          AND day <  ${endDate}::date
        GROUP BY teammate_id
      )
      SELECT COALESCE(SUM(cost), 0)::text AS genuine,
             COALESCE(SUM(tokens), 0)::text AS tokens,
             COUNT(*) FILTER (WHERE cost > 0)::int AS active_users,
             to_char(MAX(as_of), 'YYYY-MM-DD') AS as_of
      FROM per_person`),
    reportMonthFloor(tx, {
      key: scope.monthFloorKey,
      where: scope.usage.kind === 'clamped' ? scope.usage.predicate : null,
    }),
    tx.execute<{ anthropic: string; billed_teammates: number; billed_tokens: string }>(sql`
      SELECT COALESCE(SUM(bill_usd), 0)::text AS anthropic,
             COUNT(DISTINCT teammate_id)::int AS billed_teammates,
             COALESCE(SUM(bill_tokens), 0)::text AS billed_tokens
      FROM v_finance_bill_chargeback
      WHERE ${scopeSql(scope.finance)}
        AND period_date >= ${startDate}::date AND period_date < ${endDate}::date`),
    tx.execute<{ copilot: string }>(sql`
      SELECT COALESCE(SUM(charge_usd), 0)::text AS copilot
      FROM v_finance_chargeback_month
      WHERE ${scopeSql(scope.finance)}
        AND tool IN (${laneListSql(GITHUB_CHARGEABLE_LANES)})
        AND period_month >= ${startDate}::date AND period_month < ${endDate}::date`),
    prevMonth
      ? tx.execute<ChargeRow>(sql`
        SELECT COALESCE(SUM(charge_usd) FILTER (WHERE tool NOT IN (${laneListSql(GITHUB_FIREWALL_EXCLUSIONS)})), 0)::text AS anthropic,
               COALESCE(SUM(charge_usd) FILTER (WHERE tool IN (${laneListSql(GITHUB_CHARGEABLE_LANES)})), 0)::text  AS copilot
        FROM v_finance_chargeback_month
        WHERE ${scopeSql(scope.finance)}
          AND period_month >= ${prevMonth.startIso.slice(0, 10)}::date AND period_month < ${prevMonth.endIso.slice(0, 10)}::date`)
      : null,
  ])
  const [totals] = [...totalsRows]
  const [billed] = [...billedRows]
  const [charge] = [...chargeRows]
  const [prevCharge] = prevChargeRows ? [...prevChargeRows] : []
  // No closed prior month ⇒ no rows ⇒ both operands 0, exactly as before.
  const prevChargeableAnthropic = Number(prevCharge?.anthropic ?? 0)
  const prevChargeableCopilot = Number(prevCharge?.copilot ?? 0)

  // Anthropic from the DAILY bill lane (windowed); Copilot from the MONTH pool view.
  const anthropicChargeableUsd = Number(billed?.anthropic ?? 0)
  const copilotChargeableUsd = Number(charge?.copilot ?? 0)
  // The Copilot pool is POOLED-MONTHLY (no daily grain), so it may only be folded over a
  // MONTH-ALIGNED window. Over a partial-month range it is withheld (never a partial slice,
  // never a silent $0 under a "+ Copilot pooled net" label) and flagged for the UI.
  const isMonthAligned = isMonthAlignedWindow(window)
  const foldCopilot = opts.copilotChargeback && isMonthAligned
  const copilotPartialMonthUnavailable = opts.copilotChargeback && !isMonthAligned
  const chargeableUsd = anthropicChargeableUsd + (foldCopilot ? copilotChargeableUsd : 0)
  const prevChargeableUsd = prevChargeableAnthropic + (foldCopilot ? prevChargeableCopilot : 0)
  /*
   * §A previous-month genuine over the SAME clamp — the usage MoM operand.
   *
   * The pace window is clipped to the DATA's as-of day-of-month, NOT `now`: during
   * settling `as_of` lags today, so pacing on `now` would measure the current
   * month's partial data against MORE previous-month days → a spurious drop. No
   * month anchor (range mode) or no as_of (no data in window) ⇒ no MoM at all,
   * rather than a delta against an operand that does not correspond.
   */
  const genuineUsd = Number(totals?.genuine ?? 0)
  const asOfDate = totals?.as_of ?? null
  let prevGenuineUsd = 0
  if (opts.momMonthRange && asOfDate) {
    const momPrevWindow = momPaceWindow(
      opts.momMonthRange,
      new Date(`${asOfDate}T00:00:00.000Z`),
    )
    const [prev] = [
      // Same rollup read as the headline (usage-rollup-lane.md R5) — both MoM
      // operands come from one table, so the delta cannot straddle the rollup
      // cadence. momPaceWindow's bounds are UTC-midnight instants (month starts
      // plus whole days), so the ::date translation is exact.
      ...(await tx.execute<{ genuine: string }>(sql`
        SELECT COALESCE(SUM(cost_usd), 0)::text AS genuine
        FROM v_usage_rollup_current
        WHERE ${scopeSql(scope.usage)}
          AND day >= ${momPrevWindow.startIso.slice(0, 10)}::date
          AND day <  ${momPrevWindow.endIso.slice(0, 10)}::date`)),
    ]
    prevGenuineUsd = Number(prev?.genuine ?? 0)
  }

  const billedTeammates = Number(billed?.billed_teammates ?? 0)
  return {
    genuineUsd,
    anthropicChargeableUsd,
    copilotChargeableUsd,
    chargeableUsd,
    tokens: Number(totals?.tokens ?? 0),
    activeUsers: Number(totals?.active_users ?? 0),
    prevChargeableUsd,
    chargeMomDeltaPct:
      prevChargeableUsd > 0 ? (chargeableUsd - prevChargeableUsd) / prevChargeableUsd : null,
    billedTeammates,
    billedTokens: Number(billed?.billed_tokens ?? 0),
    avgChargePerBilledUser: billedTeammates > 0 ? anthropicChargeableUsd / billedTeammates : 0,
    copilotPartialMonthUnavailable,
    prevGenuineUsd,
    momDeltaPct: prevGenuineUsd > 0 ? (genuineUsd - prevGenuineUsd) / prevGenuineUsd : null,
    asOfDate,
    monthFloor: floorMonth,
  }
}
