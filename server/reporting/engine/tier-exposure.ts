/*
 * fetchTierExposure — billed spend against consumption, banded by model tier,
 * scope-parameterised (docs/design/reporting-consolidation/04-prototype-delta.md
 * §5 `fetchTierExposure`).
 *
 * WHAT IT ANSWERS. "Behavioural exposure": each band is one thing a developer or
 * a policy can change, and the card shows money over volume in the SAME bands so
 * the premium is visible. A spend share alone overstates how much a thing is
 * used, because every band bills at a different rate.
 *
 * THE LANE. `provider_usage_fact` — the NORMALISED layer, not an Anthropic
 * surface (`0118:44-45`: `provider text NOT NULL`, no CHECK on the value, both
 * providers landing through their own adapter). A report reads the normalised
 * layer and nothing else, so this card is never blocked on an unwritten adapter:
 * it reports what has arrived and gains the rest when the arm lands.
 *
 * ONE `GROUP BY` YIELDS BOTH MEASURES. The measure-exclusivity CHECK
 * (`0118:141-165`) makes a cost row carry no tokens and a token row carry no
 * cost, so `SUM(cost_usd)` ignores token rows and `SUM(input+output)` ignores
 * cost rows. Nothing multiplies when both reports are loaded, and no filter or
 * merged view is needed.
 *
 * BANDING HAPPENS IN TYPESCRIPT, THROUGH `resolveTier` — DELIBERATELY, and this
 * is the single most load-bearing decision in the file. `model_catalog` matches
 * by SUBSTRING with a `sort_order` tie-break (`0046:122-146`), so `gpt-5-mini`
 * matches BOTH the `gpt-5-mini` row (sort_order 50, lightweight) and the `gpt-5`
 * row (70, frontier). A direct equijoin fans out: the SAME dollar is returned
 * twice, once per matching pattern, and every band total — and the card's
 * headline — overstates the money. Calling `resolveTier` (the function the
 * frontier-share detector already uses) resolves each model to exactly one tier
 * before a single dollar is added anywhere, so a fan-out is not merely avoided,
 * it is structurally impossible: there is no join. It also means this card and
 * that detector can never publish two different frontier shares.
 *
 * NEVER a §A usage figure, never `attribution_record` / `attribution_aggregate` /
 * raw `actual_spend` (the lane firewall, build-design §7(7)).
 */
import { sql } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import {
  TIER_BANDS,
  bandForModel,
  type ContextWindowExposure,
  type ExposureKind,
  type ExposureUnit,
  type TierBand,
  type TierExposure,
  type TierExposureArm,
  type TierExposureBand,
  type TierExposureCell,
} from '../../../shared/reports/tier-exposure'
import { compareContextBands } from '../../../shared/reports/context-window'
import { fetchCatalog, resolveTier, type CatalogEntry } from '../../usage/insights'
import type { UsageWindow } from '../params'
import { scopeSql, type FinanceScope } from './scope'

type Tx = PostgresJsDatabase<Record<string, unknown>>

/**
 * The providers an arm is ALWAYS emitted for, so an unwritten adapter is stated
 * rather than absent. `github` has no rows in `provider_usage_fact` today (#49 /
 * Track E is the arm that writes them) and its arm reports `no-data-yet` — which
 * the card must render differently from a genuine zero.
 */
const KNOWN_PROVIDERS = ['anthropic', 'github'] as const

/**
 * `github` is `mix-only` because of what the provider SENDS, settled by the
 * wire-shape capture of 2026-08-02 and not inferred from our schemas:
 * `totals_by_language_model[].model` is present 756/756, but `ai_credits_used`
 * sits at the RECORD ROOT, at day grain. Copilot money therefore cannot be
 * banded, and this arm never tries: splitting a day's credits across models by
 * activity share would be a ratio, and this design does not do ratios anywhere.
 *
 * Any other provider is treated as `cost-and-tokens` so its money is BANDED
 * rather than dropped — dropping it would break the "bands sum to the lane
 * total" invariant silently. If a capture later shows a provider meters
 * differently, it gets a row here.
 */
function kindFor(provider: string): ExposureKind {
  return provider === 'github' ? 'mix-only' : 'cost-and-tokens'
}

/**
 * Copilot's activity measure is `user_initiated_interaction_count` — a model's
 * share of DELIBERATE user interactions, the closest thing it has to "how much
 * work ran on this model". Its language dimension is irrelevant here. It lands
 * in `provider_usage_fact.requests`; Anthropic's consumption is tokens.
 */
function unitFor(provider: string): ExposureUnit {
  return provider === 'github' ? 'interactions' : 'tokens'
}

/*
 * The per-provider clause on the unbanded figure.
 *
 * It used to explain the METERING ("ai_credits_used sits at the record root, so
 * they are reported whole and never split across models") — how the provider
 * bills, which is this module's business and not the reader's. The card already
 * prints "$X of credits, reported whole"; what a reader additionally needs is
 * that no model split exists to ask for, which is one clause.
 */
const UNBANDED_NOTE: Record<string, string> = {
  github: 'No model split exists for Copilot credits.',
}

/**
 * One `(provider, model, day)` aggregate of `provider_usage_fact`.
 *
 * The `*_rows` counts are the part worth reading twice: they are what makes
 * "not counted" distinguishable from "zero", which no `SUM` can do on its own.
 * Exported so a test can state the fixture it is about in the same terms the
 * query produces.
 */
export interface TierExposureFactRow extends Record<string, unknown> {
  provider: string
  model: string | null
  /** `provider_usage_fact.context_window` — the provider's own band string,
   *  verbatim; NULL = un-banded (pre-collection history, or a wire that has no
   *  such dimension). A grain member of the scan since W0a D6. */
  context_window: string | null
  /** `YYYY-MM-DD`. */
  day: string
  /** Σ `cost_usd` (numeric, so it crosses the wire as text). */
  spend: string
  /** Σ `input_tokens + output_tokens`, NULLs treated as 0. */
  tokens: string
  /** Rows carrying ANY token lane — 0 means the tokens sum is not a measurement. */
  token_rows: number
  /** Σ `requests` — Copilot's `user_initiated_interaction_count` lands here. */
  interactions: string
  /** Rows carrying `requests` — 0 means the interactions sum is not a measurement. */
  interaction_rows: number
}

/** A (day, band) accumulator — `consumption` stays null until a row supplies one. */
interface Acc {
  spendUsd: number
  consumption: number | null
}

function addConsumption(acc: Acc, value: number, counted: boolean): void {
  if (!counted) return
  acc.consumption = (acc.consumption ?? 0) + value
}

/**
 * Billed spend against consumption, banded by `model_catalog.tier`, for the
 * period AND as a day-grain series over the SAME window.
 *
 * THE WINDOW IS THE CALLER'S. The design's "60-day series" is the REGION card's
 * choice of window, not a constant baked in here: the cost-centre drill passes
 * its own active window and gets the same shape. A primitive never learns which
 * surface it serves.
 *
 * SCOPE CLAMP: a §B (`finance`-lane) clamp addressing `(region_id,
 * cost_owning_unit_id)` on `v_provider_usage_fact_current` — the person's current
 * region and Business Unit. The view is NOT aliased, so callers build their predicate as
 * `scope.financeScope('region_id', 'cost_owning_unit_id')`; that is part of this
 * function's contract with them, exactly as `fetchDailyMetrics`' `u.` alias is
 * part of its own.
 */
export async function fetchTierExposure(
  tx: Tx,
  scope: FinanceScope,
  window: UsageWindow,
): Promise<TierExposure> {
  const startDate = window.startIso.slice(0, 10)
  const endDate = window.endIso.slice(0, 10)

  /*
   * ONE scan, at (provider, model, day) grain — the finest grain either output
   * needs. The period bands are this rolled up over days; the series is this
   * rolled up over models. Two scans would let the bars and the trend under them
   * disagree, which is the defect "one number, one home" exists to prevent.
   *
   * `*_rows` counts are what make "not counted" distinguishable from "zero".
   * `SUM(COALESCE(input,0) + COALESCE(output,0))` over a set containing only
   * COST rows returns 0, not NULL, so the sum alone cannot tell a band with no
   * token row from a band that genuinely consumed nothing. The count can, and a
   * band with no consumption row must SAY SO rather than being re-based into the
   * volume bar at zero width.
   *
   * CONSUMPTION IS `input + output` — the tokens the work itself moved. The
   * cache lanes are deliberately outside it: they are a harness-managed property
   * (`feedback_a_metric_is_only_a_lever_if_movable`), and this card's contract is
   * that every band is a lever someone holds.
   */
  /*
   * `context_window` joined the grain (W0a D6): the ONE scan now also carries
   * the dimension the context-tier chip reads, so the tier bands and the
   * context bands are computed from the same rows and cannot disagree. Adding
   * a GROUP BY member only splits rows finer — every tier figure is a SUM over
   * them and is unchanged by the split.
   */
  const rows = await tx.execute<TierExposureFactRow>(sql`
    SELECT provider,
           model,
           context_window,
           to_char(date, 'YYYY-MM-DD') AS day,
           COALESCE(SUM(cost_usd), 0)::text                                       AS spend,
           COALESCE(SUM(COALESCE(input_tokens, 0) + COALESCE(output_tokens, 0)), 0)::text AS tokens,
           COUNT(*) FILTER (WHERE input_tokens IS NOT NULL
                               OR output_tokens IS NOT NULL)::int                 AS token_rows,
           COALESCE(SUM(COALESCE(requests, 0)), 0)::text                          AS interactions,
           COUNT(*) FILTER (WHERE requests IS NOT NULL)::int                      AS interaction_rows
    FROM v_provider_usage_fact_current
    WHERE ${scopeSql(scope)}
      AND date >= ${startDate}::date
      AND date <  ${endDate}::date
    GROUP BY provider, model, context_window, date
    ORDER BY date`)

  /*
   * HAS THIS PROVIDER'S ADAPTER EVER WRITTEN? Deliberately UNWINDOWED and
   * UNCLAMPED, because that is exactly the question: "no rows in this scope and
   * window" is a genuine zero, while "no rows anywhere, ever" means the arm is
   * unwritten. Conflating the two is what makes an operator chase a spend
   * anomaly that is really a missing adapter.
   */
  const [presence] = [
    ...(await tx.execute<{ anthropic: boolean; github: boolean }>(sql`
      SELECT EXISTS (SELECT 1 FROM provider_usage_fact WHERE provider = 'anthropic') AS anthropic,
             EXISTS (SELECT 1 FROM provider_usage_fact WHERE provider = 'github')    AS github`)),
  ]
  const everWritten = new Set<string>()
  if (presence?.anthropic) everWritten.add('anthropic')
  if (presence?.github) everWritten.add('github')

  const catalog = await fetchCatalog(tx)
  // `window.endIso` is EXCLUSIVE; every `{ from, to }` echo in the reporting
  // contract is INCLUSIVE (ReportMeta.range, AcrossTrend.window). Echoing the
  // exclusive bound would label a 60-day card "61 days" and put a day in the
  // header that no figure on the card was computed over.
  const inclusiveTo = new Date(`${endDate}T00:00:00.000Z`)
  inclusiveTo.setUTCDate(inclusiveTo.getUTCDate() - 1)
  return buildTierExposure([...rows], catalog, everWritten, {
    from: startDate,
    to: inclusiveTo.toISOString().slice(0, 10),
  })
}

/**
 * The PURE core: fact rows + catalog → the card's payload. Separated from the
 * fetch so the banding — the part a fan-out would break — is unit-testable with
 * zero DB, on a fixture that names the models it is about.
 *
 * @param everWritten providers with at least one row in the lane, ever (see the
 *   presence probe above). A provider absent from this set reports
 *   `no-data-yet`; a provider in it with no rows in the window reports `ok` with
 *   zeros, which is a genuine zero.
 */
export function buildTierExposure(
  rows: readonly TierExposureFactRow[],
  catalog: readonly CatalogEntry[],
  everWritten: ReadonlySet<string>,
  window: { from: string; to: string },
): TierExposure {
  const providers = new Set<string>([...KNOWN_PROVIDERS, ...rows.map((r) => r.provider)])

  /*
   * ONE tier lookup per DISTINCT model, not per row. `resolveTier` walks the
   * whole catalog, and the series grain is (model × day) — memoising keeps a
   * 60-day window at one walk per model instead of sixty.
   */
  const bandCache = new Map<string, TierBand>()
  const bandOf = (model: string | null): TierBand => {
    if (!model) return 'no-model'
    const hit = bandCache.get(model)
    if (hit) return hit
    const band = bandForModel(model, resolveTier(model, [...catalog]))
    bandCache.set(model, band)
    return band
  }

  const arms: TierExposureArm[] = []
  for (const provider of providers) {
    const kind = kindFor(provider)
    const unit = unitFor(provider)
    const mine = rows.filter((r) => r.provider === provider)

    const periodTotals = new Map<TierBand, Acc>()
    /*
     * NESTED rather than a composite `day|band` string key. A composite key
     * needs a separator that neither member can contain, and the last two
     * modules to need one picked DIFFERENT separators and drifted
     * (engine/chargeback-series.ts:27-38). Nesting has no separator to get
     * wrong.
     */
    const dayTotals = new Map<string, Map<TierBand, Acc>>()
    let unbandedSpendUsd = 0

    /*
     * The CONTEXT-WINDOW leg (W0a D6), accumulated from the SAME rows in the
     * same pass. Only a `cost-and-tokens` arm gets one — a `mix-only` provider
     * has no context-window dimension on its wire, which is a different fact
     * from "everything un-banded" and must not render as a remainder.
     */
    const ctxBands = new Map<string, { spendUsd: number; tokens: number | null }>()
    let ctxUnbandedSpendUsd = 0

    for (const r of mine) {
      const band = bandOf(r.model)
      const spend = Number(r.spend)
      /*
       * A `mix-only` arm's money NEVER enters a band. Even if an adapter one day
       * writes a model on a credit row — which the wire shape says cannot
       * happen, since the credits live at the record root — this arm carries it
       * whole rather than attributing it to a model the provider never priced.
       * The failure mode is then "Copilot money is reported unbanded", which is
       * true, instead of "Copilot money is attributed per model", which would not be.
       */
      const banded = kind === 'cost-and-tokens' ? spend : 0
      if (kind === 'mix-only') unbandedSpendUsd += spend

      const consumption = unit === 'interactions' ? Number(r.interactions) : Number(r.tokens)
      const counted = unit === 'interactions' ? r.interaction_rows > 0 : r.token_rows > 0

      if (kind === 'cost-and-tokens') {
        if (r.context_window !== null) {
          const ctx = ctxBands.get(r.context_window) ?? { spendUsd: 0, tokens: null }
          ctx.spendUsd += spend
          // Same counted discipline as the tier bands: a band whose rows carry
          // no token lane is NOT COUNTED, never claimed as zero tokens.
          if (r.token_rows > 0) ctx.tokens = (ctx.tokens ?? 0) + Number(r.tokens)
          ctxBands.set(r.context_window, ctx)
        } else {
          ctxUnbandedSpendUsd += spend
        }
      }

      const period = periodTotals.get(band) ?? { spendUsd: 0, consumption: null }
      period.spendUsd += banded
      addConsumption(period, consumption, counted)
      periodTotals.set(band, period)

      let byBand = dayTotals.get(r.day)
      if (!byBand) {
        byBand = new Map<TierBand, Acc>()
        dayTotals.set(r.day, byBand)
      }
      const day = byBand.get(band) ?? { spendUsd: 0, consumption: null }
      day.spendUsd += banded
      addConsumption(day, consumption, counted)
      byBand.set(band, day)
    }

    const bandedSpendUsd = [...periodTotals.values()].reduce((a, b) => a + b.spendUsd, 0)
    /*
     * The volume bar's denominator is the bands that HAVE a count, and it is a
     * DIFFERENT population from the money bar's. `consumptionCoveredSpendUsd` is
     * how much of the money that population carries, so the card can state what
     * the volume bar spans instead of letting "63% of spend vs 13% of tokens" be
     * read as covering money it does not.
     */
    let totalConsumption: number | null = null
    let consumptionCoveredSpendUsd = 0
    for (const acc of periodTotals.values()) {
      if (acc.consumption === null) continue
      totalConsumption = (totalConsumption ?? 0) + acc.consumption
      consumptionCoveredSpendUsd += acc.spendUsd
    }

    const bands: TierExposureBand[] = TIER_BANDS.map((band) => {
      const acc = periodTotals.get(band) ?? { spendUsd: 0, consumption: null }
      return {
        band,
        spendUsd: acc.spendUsd,
        consumption: acc.consumption,
        spendSharePct: bandedSpendUsd > 0 ? acc.spendUsd / bandedSpendUsd : null,
        consumptionSharePct:
          acc.consumption !== null && totalConsumption !== null && totalConsumption > 0
            ? acc.consumption / totalConsumption
            : null,
      }
    })

    const series: TierExposureCell[] = []
    for (const [day, byBand] of [...dayTotals.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
      for (const band of TIER_BANDS) {
        const acc = byBand.get(band)
        // A cell with neither money nor a count is a GAP in the line, never a
        // claimed zero — the day simply had no row for that band, and drawing a
        // zero there would assert the band was chosen and cost nothing.
        if (!acc || (acc.spendUsd === 0 && acc.consumption === null)) continue
        series.push({ day, band, spendUsd: acc.spendUsd, consumption: acc.consumption })
      }
    }

    /*
     * Shares are computed HERE, beside the figures they divide — the card's
     * view model draws and never recomputes ("one number, one home"). The
     * observed-bands invariant worth knowing: for a cost-and-tokens arm,
     * ctx banded + ctx un-banded = the arm's bandedSpendUsd — both sum the
     * same cost rows, partitioned two different ways.
     */
    let contextWindow: ContextWindowExposure | null = null
    if (kind === 'cost-and-tokens') {
      const ctxBandedSpendUsd = [...ctxBands.values()].reduce((a, b) => a + b.spendUsd, 0)
      const ctxCountedTokens = [...ctxBands.values()].reduce<number | null>(
        (a, b) => (b.tokens === null ? a : (a ?? 0) + b.tokens),
        null,
      )
      contextWindow = {
        bands: [...ctxBands.entries()]
          .sort(([a], [b]) => compareContextBands(a, b))
          .map(([band, acc]) => ({
            band,
            spendUsd: acc.spendUsd,
            spendSharePct: ctxBandedSpendUsd > 0 ? acc.spendUsd / ctxBandedSpendUsd : null,
            tokens: acc.tokens,
            tokensSharePct:
              acc.tokens !== null && ctxCountedTokens !== null && ctxCountedTokens > 0
                ? acc.tokens / ctxCountedTokens
                : null,
          })),
        bandedSpendUsd: ctxBandedSpendUsd,
        unbandedSpendUsd: ctxUnbandedSpendUsd,
        unbandedReason: ctxUnbandedSpendUsd > 0 ? 'before-collection' : null,
      }
    }

    arms.push({
      provider,
      kind,
      availability: everWritten.has(provider) ? 'ok' : 'no-data-yet',
      unit,
      bandedSpendUsd,
      unbandedSpendUsd,
      unbandedNote: unbandedSpendUsd > 0 ? (UNBANDED_NOTE[provider] ?? null) : null,
      totalConsumption,
      consumptionCoveredSpendUsd,
      bands,
      series,
      contextWindow,
    })
  }

  // Known providers first, in their declared order, so the card's arm order is
  // stable whatever order the scan returned rows in.
  const rank = (p: string) => {
    const i = (KNOWN_PROVIDERS as readonly string[]).indexOf(p)
    return i === -1 ? KNOWN_PROVIDERS.length : i
  }
  arms.sort((a, b) => rank(a.provider) - rank(b.provider) || a.provider.localeCompare(b.provider))

  return { window, bandOrder: [...TIER_BANDS], providers: arms }
}
