/*
 * GET /api/v1/admin/diagnostics/costing — the 7-day costing aggregates of the
 * diagnostics snapshot: `costDrift` (our rate-card estimate vs the provider's
 * figure, v_cost_drift) and `costingRungs` (which rung of the precedence
 * ladder priced real spend, attribution_record.cost_basis).
 *
 * Split out of GET /diagnostics (docs/design/admin-nav-responsiveness.md D4):
 * both are fact-table scans over a week of partitions, the most expensive
 * reads the old single endpoint carried, and the page draws their panel as a
 * skeleton until they land. The two queries are byte-identical to the blocks
 * they were cut from. Each runs in its OWN transaction with its own catch: a
 * failing statement aborts the transaction it is in, and `costDrift` can fail
 * on its own (v_cost_drift is absent on a pre-0045 database), so sharing one
 * would blank the rungs card whenever the drift card is unavailable. F5
 * concurrent issuance is deliberately not used here for that reason.
 *
 * A caught failure keeps the read's ZERO shape so existing consumers keep
 * working, but never returns it unlabelled: `reads.costDrift` /
 * `reads.costingRungs` carry `available` (plus a classified reason and a
 * correlation id when false). Zero spans and a failed query are otherwise the
 * same bytes, and the card would report "no data" for "we could not find out".
 *
 * RBAC: admin / platform-admin (the same gate as the snapshot). Read-only.
 * The drift section is platform-admin only: v_cost_drift has no region_id, so
 * a region admin cannot be clamped to their own region there. For a region
 * admin the drift query never runs; `costDrift` is null, `reads` carries no
 * `costDrift` entry, and `costDriftScopedOut` states why. `costingRungs` stays
 * region-clamped, on the region each teammate sits in now.
 */
import { defineEventHandler } from 'h3'
import { sql } from 'drizzle-orm'
import { requireRole } from '../../../../auth/rbac'
import { requestClock } from '../../../../utils/request-clock'
import { withRequestRls } from '../../../../db/request-rls'
import { readUnavailable, type ReadAvailability } from '../../../../utils/redact-probe-error'

export default defineEventHandler(async (event) => {
  const session = await requireRole(event, 'admin')
  // The SERVER owns `now`, once per request (CLAUDE.md §The clock). SQL's own
  // `now()` is a SECOND clock: two predicates in one response could straddle
  // different instants, and a clock-pinned request would be ignored outright.
  const windowEnd = requestClock(event).now

  // One entry per independently-fallible read below. A caught failure keeps the
  // read's zero shape for existing consumers; THIS is the only thing that
  // separates that zero from a genuine finding.
  let driftRead: ReadAvailability = { available: true }
  // v_cost_drift has no region_id, so platform-admin is the only clamp.
  const driftVisible = session.role === 'platform-admin'
  let rungsRead: ReadAvailability = { available: true }

  // ── Cost drift (our rate-card estimate vs the provider, migs 0045/0091) ──
  // v_cost_drift compares our rate-card ESTIMATE against the PROVIDER's own
  // figure, per span, across both cost vintages: pre-cutover rows where
  // cost_usd is the estimate, and provider-priced rows where cost_usd is the
  // provider's number and the estimate rides in metadata.rate_card_cost_usd
  // (mig 0091 owns that branching; this endpoint just reads the columns).
  // A creeping mean drift = the rate card is stale — caught here before
  // reconciliation books the gap. 7-day window keeps the scan cheap and
  // recent-biased, and prunes to one or two monthly partitions.
  //
  // NOTE the drift card and the costing-rung card below answer DIFFERENT
  // questions and must not be conflated: drift asks "how wrong is the rate
  // card", rungs ask "did we have to USE it". A fleet can be entirely
  // provider-priced (rungs green) while drift is 50% — that is the healthy
  // state, and it is exactly the number the rate card is still needed for
  // (slicing a span total across token types).
  let costDrift: {
    spansCompared: number
    meanAbsDriftPct: number | null
    /** Per-vintage split of spansCompared — 'mixed' spans count as provider. */
    providerPricedSpans: number
    rateCardPricedSpans: number
    worstSpan: {
      spanKey: string
      model: string
      rateCardCostUsd: string
      lawCostUsd: string
      driftUsd: string
      pricedBy: string
    } | null
  } = {
    spansCompared: 0,
    meanAbsDriftPct: null,
    providerPricedSpans: 0,
    rateCardPricedSpans: 0,
    worstSpan: null,
  }

  // ── Costing rungs (which rung priced real spend) ───────────────────
  // docs/design/provider-cost-precedence.md §"Making it visible": the ladder is
  //   1. the provider's reported cost   2. the rate card   3. skip the span
  // and "a healthy fleet is ENTIRELY provider. Any other rung costing a real
  // span is unexpected enough to ALERT on, not merely to count."
  //
  // Sourced from attribution_record.cost_basis, NOT from the joiner's per-run
  // costingRungs counters: those are transient (they live for the length of one
  // worker run and are gone), while cost_basis is the persisted, queryable truth
  // and survives a restart, a redeploy and a missed alert. A rung that fired
  // three days ago is still visible here; the counter is not.
  //
  // Grain is the SPAN, not the row: one api_request explodes into up to four
  // token-type rows, and counting rows would make a cache-heavy span look four
  // times as alarming as a plain one. Same span key the drift view groups on.
  //
  // Scoped to tool='claude-code'. Copilot is untouched by the provider-cost
  // change — it is priced from AI credits and never used a rate card (design
  // §"Where cost comes from") — so including it would park a permanent
  // non-provider bucket on the card and train operators to ignore red.
  //
  // Region admins see the people who sit in their region now, the same filter
  // the pipeline block uses (the RLS policy treats 'admin' as org-wide).
  const regionAnd =
    session.role === 'admin'
      ? sql`AND teammate_id IN (SELECT id FROM teammate WHERE region_id = ${session.regionId}::uuid)`
      : sql``
  const COSTING_WINDOW_DAYS = 7
  let costingRungs: {
    windowDays: number
    spans: number
    provider: number
    rateCard: number
    other: number
    /**
     * provider + rateCard — the spans the LADDER actually priced, and the
     * denominator of rateCardPct. See the comment where it is computed.
     */
    ladderSpans: number
    rateCardPct: number | null
    fallbackModels: { model: string; spans: number }[]
  } = {
    windowDays: COSTING_WINDOW_DAYS,
    spans: 0,
    provider: 0,
    rateCard: 0,
    other: 0,
    ladderSpans: 0,
    rateCardPct: null,
    fallbackModels: [],
  }
  if (driftVisible) {
    try {
      const driftRows = await withRequestRls(event, (tx) =>
        tx.execute<{
          spans: string
          provider_spans: string
          rate_card_spans: string
          mean_abs_pct: string | null
          span_key: string | null
          model: string | null
          rate_card_cost_usd: string | null
          law_cost_usd: string | null
          drift_usd: string | null
          priced_by: string | null
        }>(sql`
          WITH windowed AS (
            SELECT * FROM v_cost_drift
            WHERE ts_event >= ${windowEnd}::timestamptz - interval '7 days' AND law_cost_usd > 0
          ),
          worst AS (
            SELECT * FROM windowed ORDER BY ABS(drift_usd) DESC LIMIT 1
          )
          SELECT
            (SELECT COUNT(*) FROM windowed)::text AS spans,
            (SELECT COUNT(*) FROM windowed WHERE priced_by <> 'rate-card')::text AS provider_spans,
            (SELECT COUNT(*) FROM windowed WHERE priced_by = 'rate-card')::text AS rate_card_spans,
            (SELECT AVG(ABS(drift_usd) / law_cost_usd) * 100 FROM windowed)::text AS mean_abs_pct,
            w.span_key, w.model,
            w.rate_card_cost_usd::text AS rate_card_cost_usd,
            w.law_cost_usd::text AS law_cost_usd,
            w.drift_usd::text AS drift_usd,
            w.priced_by
          FROM (SELECT 1) one
          LEFT JOIN worst w ON TRUE
        `),
      )
      const r = [...driftRows][0]
      const spans = Number(r?.spans ?? 0)
      costDrift = {
        spansCompared: spans,
        meanAbsDriftPct:
          r?.mean_abs_pct != null ? Number(Number(r.mean_abs_pct).toFixed(2)) : null,
        providerPricedSpans: Number(r?.provider_spans ?? 0),
        rateCardPricedSpans: Number(r?.rate_card_spans ?? 0),
        worstSpan:
          spans > 0 && r?.span_key != null
            ? {
                spanKey: r.span_key,
                model: r.model ?? 'unknown',
                rateCardCostUsd: r.rate_card_cost_usd ?? '0',
                lawCostUsd: r.law_cost_usd ?? '0',
                driftUsd: r.drift_usd ?? '0',
                pricedBy: r.priced_by ?? 'unknown',
              }
            : null,
      }
    } catch (err) {
      // Non-fatal — pre-0045 DBs have no view. costDrift keeps its zero shape,
      // and reads.costDrift says the shape is a failure, not a finding.
      driftRead = readUnavailable(err, 'diagnostics:cost-drift')
    }
  }

  try {
    const rungRows = await withRequestRls(event, (tx) =>
      tx.execute<{
        spans: string
        provider_spans: string
        rate_card_spans: string
        other_spans: string
        fallback_models: { model: string; spans: number }[] | null
      }>(sql`
        WITH span AS (
          SELECT
            MAX(model) AS model,
            -- A span is provider-priced if ANY of its rows says so; the rows of
            -- one api_request are priced together, and a half-and-half span
            -- (written across the cutover) is a provider span with stragglers,
            -- not a fallback.
            --
            -- DELIBERATELY NARROWER THAN v_cost_drift's predicate, which also
            -- treats a NULL rate_card_id as provider-priced (mig 0091). The two
            -- want opposite failure directions. The view's risk is a
            -- TAUTOLOGICAL ZERO — reading a provider figure as an estimate and
            -- reporting no drift — so it detects broadly. This counter's risk is
            -- a FALSE GREEN: claiming the provider priced a span it did not,
            -- which would silence the alert the design exists to raise. So it
            -- believes only the explicit marker. The cost of the narrower test
            -- is that a backfilled provider-priced span (cost_basis carries
            -- 'telemetry-only' for that provenance, not the rung) lands in the
            -- "other" bucket rather than "provider" — an undercount that can
            -- only make the card noisier, never quieter.
            bool_or(cost_basis = 'provider-reported') AS any_provider,
            -- 'estimated' is the rate-card rung. Anything else that is not
            -- provider-reported ('telemetry-only' backfill provenance) is
            -- neither rung and lands in the "other" bucket rather than being
            -- silently folded into the alerting one.
            bool_or(cost_basis = 'estimated') AS any_estimated
          FROM attribution_record
          WHERE tool = 'claude-code'
            AND ts_event >= ${windowEnd}::timestamptz - make_interval(days => ${COSTING_WINDOW_DAYS}::int)
            ${regionAnd}
          GROUP BY instance_id, COALESCE(claude_session_id, ''), ts_event, COALESCE(source_run_id, '')
        ),
        totals AS (
          SELECT
            COUNT(*)::text AS spans,
            COUNT(*) FILTER (WHERE any_provider)::text AS provider_spans,
            COUNT(*) FILTER (WHERE NOT any_provider AND any_estimated)::text AS rate_card_spans,
            COUNT(*) FILTER (WHERE NOT any_provider AND NOT any_estimated)::text AS other_spans
          FROM span
        ),
        fallback AS (
          SELECT model, COUNT(*)::int AS spans
          FROM span
          WHERE NOT any_provider AND any_estimated
          GROUP BY model
          ORDER BY COUNT(*) DESC, model
          LIMIT 5
        )
        SELECT
          t.spans, t.provider_spans, t.rate_card_spans, t.other_spans,
          COALESCE(
            (SELECT json_agg(json_build_object('model', f.model, 'spans', f.spans)) FROM fallback f),
            '[]'::json
          ) AS fallback_models
        FROM totals t
      `),
    )
    const r = [...rungRows][0]
    const spans = Number(r?.spans ?? 0)
    const rateCard = Number(r?.rate_card_spans ?? 0)
    const provider = Number(r?.provider_spans ?? 0)
    /*
     * DENOMINATOR = provider + rateCard, NOT every span in the window.
     *
     * The question this figure answers is "of the spans the precedence ladder
     * priced, what share did our own rate card have to price?" — so only the two
     * ladder buckets belong underneath it. The `other` bucket is neither rung:
     * it is backfill provenance (cost_basis 'telemetry-only'), and a backfill
     * campaign is exactly the kind of thing an operator kicks off during an
     * incident. Counting it in the denominator would let heavy backfill traffic
     * mechanically shrink this percentage while the number of real fallbacks was
     * unchanged or rising — softening the alert precisely when it is most needed.
     * `spans`, `provider`, `rateCard` and `other` are all still reported, so the
     * broader share is one subtraction away for anyone who wants it.
     */
    const ladderSpans = provider + rateCard
    costingRungs = {
      windowDays: COSTING_WINDOW_DAYS,
      spans,
      provider,
      rateCard,
      other: Number(r?.other_spans ?? 0),
      ladderSpans,
      rateCardPct: ladderSpans > 0 ? Number(((rateCard / ladderSpans) * 100).toFixed(2)) : null,
      fallbackModels: (r?.fallback_models ?? []).map((m) => ({
        model: m.model,
        spans: Number(m.spans),
      })),
    }
  } catch (err) {
    // Non-fatal — costingRungs keeps its zero shape; reads.costingRungs marks
    // it unavailable so the alert card cannot read as a healthy quiet fleet.
    rungsRead = readUnavailable(err, 'diagnostics:costing-rungs')
  }

  if (!driftVisible) {
    return {
      costDrift: null,
      costDriftScopedOut: {
        reason: 'platform-admin-only' as const,
        detail: 'Cost drift is estate-wide (it has no region), so only an Admin can read it.',
      },
      costingRungs,
      reads: { costingRungs: rungsRead },
    }
  }
  return { costDrift, costingRungs, reads: { costDrift: driftRead, costingRungs: rungsRead } }
})
