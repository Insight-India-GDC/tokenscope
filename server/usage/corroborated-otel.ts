/*
 * ── THE ONE OPERAND ─────────────────────────────────────────────────────────
 *
 * "Corroborated, provider-billed OTel, per (teammate, UTC day[, tool])."
 *
 * Design: docs/design/emitting-identity-and-subscription-type.md §7, §9.
 *
 * WHY IT IS A MODULE. Three separate queries net §A against this same quantity,
 * and they must agree with each other exactly:
 *
 *   - server/usage/unaccounted-reconciliation.ts — the UNDER direction
 *     (API − OTel → the taggable "needs tagging" residual)
 *   - server/usage/over-emission-detection.ts    — the OVER direction
 *     (OTel − API → the suspected-forgery flag)
 *   - server/usage/ab-decomposition.ts           — the floor and unreconciled
 *     terms, which MODEL the two queries above
 *
 * Each of the three previously carried its own copy. Change two and leave the
 * third and nothing fails: the decomposition's residual still closes (moving
 * money between terms cannot change a sum), so the breakage is silent. That is
 * why this is one exported fragment rather than a convention.
 *
 * ── WHAT IT EXCLUDES, AND WHY EACH EXCLUSION IS HERE ────────────────────────
 *
 * 1. OPEN `api-uncorroborated` QUARANTINES. Conversations the developer has
 *    confirmed as forgeries. Pre-existing behaviour: the under and over lanes
 *    must net against the SAME corroborated OTel, or a quarantined forgery
 *    inflates the OTel total and MASKS genuine un-enrolled usage that day.
 *
 * 2. `billing_lane = 'self-billed'` (mig 0119). Spend emitted from a personal
 *    subscription has no invoice behind it, so it must not be subtracted from
 *    the provider's bill. Leaving it in is what suppresses a mixed teammate's
 *    needs-tagging worklist by exactly the amount of their personal usage.
 *
 * ── DAY BINNING ─────────────────────────────────────────────────────────────
 *
 * `(ts_event AT TIME ZONE 'UTC')::date`, never a bare `::date` — the latter
 * casts in the session TimeZone and disagrees at every day boundary on a server
 * not set to UTC.
 *
 * ── PER-CELL COMPLETENESS (§9) — the part that is easy to get wrong ─────────
 *
 * The new exclusion is applied PER CELL, not globally. A `(teammate, day, tool)`
 * cell containing ANY `unknown` row keeps the OLD operand (sum everything); only
 * a fully-stamped cell uses the new one.
 *
 * This is not caution, it is correctness. Rows written before mig 0119 sit at
 * 'unknown'. If a cell mixes stamped and unstamped rows and we applied the new
 * operand, the still-'unknown' self-billed rows would remain in the subtrahend
 * and PARTIALLY suppress the residual — a figure that is neither the old
 * behaviour nor the new one, and that nothing would flag. Holding a partial cell
 * on the old operand keeps it exactly reproducing today, which is why 'unknown'
 * is a distinct lane value rather than folded into 'provider-billed'.
 *
 * COMPLETENESS IS EVALUATED OVER THE POST-QUARANTINE POPULATION. The quarantine
 * exclusion is in the WHERE clause, so `bool_or` sees only rows that survive it.
 * Moving that exclusion into a FILTER would let ONE quarantined 'unknown' row —
 * a row that contributes nothing to either total — force otherwise-valid
 * self-billed rows back into the subtrahend.
 *
 * COST AND TOKENS USE THE IDENTICAL TEST. `unaccounted_usage` recomputes both;
 * excluding self-billed cost but not its tokens yields one row whose dollars and
 * tokens describe different populations.
 */
import { sql, type SQL } from 'drizzle-orm'

export interface CorroboratedOtelOptions {
  /** Inclusive lower bound on `ts_event`, as a timestamptz-typed SQL expression. */
  startExpr: SQL
  /** Exclusive upper bound on `ts_event`, as a timestamptz-typed SQL expression. */
  endExpr: SQL
  /**
   * Extra AND-ed predicates on the `ar` alias — a teammate filter, a tool
   * restriction. Must be a complete `AND …` fragment or empty.
   */
  extra?: SQL
  /**
   * Carry `ar.tool` as a grouping key and an output column.
   *
   * `false` is only correct when `extra` already pins a single tool: the cell
   * must stay `(teammate, day, tool)` either way, or the completeness test is
   * computed over a population that mixes tools and one tool's 'unknown' rows
   * would hold another tool's cell on the old operand.
   */
  withTool: boolean
  /** Also emit `otel_tokens`, under the identical per-cell test. */
  withTokens: boolean
  /**
   * Also group by `ar.model` (trimmed — D9: pairing is on the trimmed,
   * case-preserved string, mirroring the API side's `modelOf`) and emit it as
   * `model`. The output grain becomes (teammate, day[, tool], model).
   *
   * THE COMPLETENESS GATE DOES NOT DECOMPOSE PER MODEL (design r1-H1,
   * 07-model-axis-subtraction-build.md D2). The billing_lane gate is a
   * per-TOOL-CELL decision: an 'unknown' row in one model and fully-stamped
   * self-billed rows in another would otherwise flip the decision per model
   * and make Σ model cells ≠ tool cell — the parent (computed without
   * `withModel`) and its children would subtract DIFFERENT operands. So with
   * `withModel` the gate is computed ONCE at (teammate, day, tool) grain via a
   * window over the grouped rows and applied unchanged to every model cell of
   * that key.
   */
  withModel?: boolean
}

/**
 * The per-cell completeness CASE for one measure.
 *
 * `COALESCE(…, 0)` on the filtered branch matters: a cell that is fully stamped
 * AND fully self-billed has no rows left to sum, and `SUM() FILTER` returns NULL
 * there. Every consumer LEFT JOINs this and would then read NULL where it means
 * zero.
 *
 * `billing_lane IS NULL` is folded into the 'unknown' arm defensively. The
 * column is `NOT NULL DEFAULT 'unknown'` so it cannot fire today; if that ever
 * changed, this degrades to the OLD behaviour rather than silently treating an
 * unclassified row as classified.
 */
function completenessGated(measure: SQL, gate: SQL): SQL {
  return sql`CASE WHEN ${gate}
                  THEN SUM(${measure})
                  ELSE COALESCE(SUM(${measure}) FILTER (WHERE ar.billing_lane <> 'self-billed'), 0)
             END`
}

/** One row that holds its cell on the OLD operand — see the header's §9 note. */
const UNKNOWN_ROW = sql`ar.billing_lane IS NULL OR ar.billing_lane = 'unknown'`

/**
 * Build the corroborated-OTel aggregate as a SELECT, for use as a CTE body.
 *
 * Output columns: `teammate_id`, `day`, [`tool`], [`model`], `otel_usd`,
 * [`otel_tokens`].
 */
export function corroboratedOtelDaily(opts: CorroboratedOtelOptions): SQL {
  const day = sql`(ar.ts_event AT TIME ZONE 'UTC')::date`
  const toolSelect = opts.withTool ? sql`, ar.tool` : sql``
  const toolGroup = opts.withTool ? sql`, ar.tool` : sql``
  const modelSelect = opts.withModel ? sql`, btrim(ar.model) AS model` : sql``
  const modelGroup = opts.withModel ? sql`, btrim(ar.model)` : sql``
  /*
   * The completeness flag for one cell. WITHOUT `withModel` this is the
   * original per-group `bool_or` — the emitted SQL is unchanged for every
   * existing consumer. WITH `withModel` the GROUP BY is finer than the cell
   * the gate is defined over, so the flag is the nested-aggregate window form
   * `bool_or(bool_or(…)) OVER (PARTITION BY teammate, day[, tool])`: the inner
   * bool_or is the per-(model) group aggregate, the outer window ORs those
   * over the WHOLE (teammate, day, tool) cell — one decision per cell, applied
   * unchanged to every model row of it (r1-H1). A plain per-group bool_or here
   * would decompose the gate per model, which is exactly the bug the design
   * names: Σ model cells would stop equalling the tool cell whenever lanes mix
   * within a key.
   */
  const gate = opts.withModel
    ? sql`bool_or(bool_or(${UNKNOWN_ROW})) OVER (PARTITION BY ar.teammate_id, ${day}${toolGroup})`
    : sql`bool_or(${UNKNOWN_ROW})`
  const tokens = opts.withTokens
    ? sql`, ${completenessGated(sql`ar.tokens`, gate)} AS otel_tokens`
    : sql``
  return sql`
    SELECT ar.teammate_id,
           ${day} AS day${toolSelect}${modelSelect},
           ${completenessGated(sql`ar.cost_usd`, gate)} AS otel_usd${tokens}
    FROM attribution_record ar
    WHERE ar.ts_event >= ${opts.startExpr}
      AND ar.ts_event < ${opts.endExpr}
      ${opts.extra ?? sql``}
      -- Exclude dev-CONFIRMED forgeries. In the WHERE, NOT a FILTER — see the
      -- post-quarantine note in this file's header.
      AND NOT EXISTS (
        SELECT 1 FROM session_quarantine sq
        WHERE sq.teammate_id = ar.teammate_id
          AND sq.conversation_id = COALESCE(ar.claude_session_id, ar.instance_id::text)
          AND sq.resolved_at IS NULL
          AND sq.reason = 'api-uncorroborated'
      )
    GROUP BY ar.teammate_id, ${day}${toolGroup}${modelGroup}
  `
}
