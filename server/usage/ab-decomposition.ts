/*
 * ab-decomposition — the §A/§B delta decomposition module.
 *
 * Decomposes the gap between §A (attributed usage, v_complete_usage) and §B
 * (chargeable, v_finance_chargeback_month) into the named, mutually exclusive
 * terms of AB_DECOMPOSITION_TERMS (the design predicted six; there are more,
 * and the const is the count — see its header for why each was added).
 * The residual MUST be zero if the decomposition is exhaustive.
 *
 * Term counts AND term ordinals are deliberately NOT restated in prose here or
 * anywhere else: three rounds of review added terms and each one left a stale
 * count behind in a different file. The const is the count AND the order.
 *
 * The ordinal half of that rule was learned the hard way, twice. Numbered
 * headers ("Term 3", "Terms 8 + 9") were kept alongside the const; inserting
 * copilotAgentUsage produced a "Term 3a" rather than a renumber, and inserting
 * chargebackExemptUsage then left TWO blocks both labelled "Term 7" and three
 * files disagreeing about which term was which. Renumbering would only have
 * reset the clock until the twelfth term. Blocks and plantings are labelled by
 * NAME, and cross-references name the term they mean. A name cannot go stale
 * when a term is inserted above it.
 *
 * Design: docs/design/usage-completeness-and-provider-governance.md §1.1
 * ("Gate on a full decomposition, not a subtraction").
 *
 * This module is the LOGIC — no HTTP handler, no route. A later task adds the
 * endpoint and admin UI card. Follows the precedent in
 * server/api/v1/admin/diagnostics/attribution-gaps.get.ts: "If a check matters
 * enough to run, it belongs in the product."
 */
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { sql } from 'drizzle-orm'
import { consola } from 'consola'
import {
  AB_DECOMPOSITION_TERMS,
  type AbDecompositionTermName,
} from '../../shared/usage/ab-decomposition-terms'
import { NON_CODE_CLAUDE_TOOLS } from '../../shared/usage/surface'
import { corroboratedOtelDaily } from './corroborated-otel'
import { unhomedByMonthSql } from './unhomed-causes'
import {
  GITHUB_FIREWALL_EXCLUSIONS,
  GITHUB_USAGE_VIEW_TOOLS,
  COPILOT_CLI_TOOL,
  COPILOT_AGENT_TOOL,
} from '../../shared/usage/github-surface'

export { AB_DECOMPOSITION_TERMS } from '../../shared/usage/ab-decomposition-terms'
export type { AbDecompositionTermName } from '../../shared/usage/ab-decomposition-terms'

/*
 * Deliberately NOT PostgresJsDatabase<typeof schema>. This module only ever calls
 * db.execute() with raw SQL, and withRequestRls (the RLS-scoped handle every API
 * route must use) hands back a differently-parameterised database. Pinning the
 * schema generic here would force every caller to cast, and a cast at the call
 * site is how a non-RLS handle gets passed in by accident.
 */
type Db = Pick<PostgresJsDatabase<Record<string, never>>, 'execute'>

export interface AbDecompositionWindow {
  /** ISO timestamp, inclusive start of period. */
  startIso: string
  /** ISO timestamp, exclusive end of period. */
  endIso: string
}

export interface AbDecompositionResult {
  /** §A total (numeric string, 6 decimal places). */
  sectionA: string
  /** §B total (numeric string, 6 decimal places). */
  sectionB: string
  /** §B − §A (signed numeric string). */
  delta: string
  /** Every term in AB_DECOMPOSITION_TERMS (signed numeric string). */
  terms: Record<AbDecompositionTermName, string>
  /** delta − Σ(terms). MUST be '0.000000' if exhaustive. */
  residual: string
  /** Figures that are not delta terms but that an operator needs to see. */
  diagnostics: {
    /**
     * §B money whose teammate has no cost-owning ancestor. It IS in the global
     * §B total (so it is not a delta term), but it vanishes from every bucket
     * when §B is sliced by cost-owning unit.
     */
    unhomedChargeUsd: string
    /**
     * Quarantined OTel cost in the window. NOT a delta term: quarantined money
     * has already left §A arm 1, and its contribution to the DELTA is nil in
     * every case — which is the precise claim, not "the money reaches neither
     * side". Uncorroborated: it reaches neither side, no §B counterpart.
     * Corroborated: the equivalent API amount DOES reach both, via arm 2 and via
     * actual_spend, and cancels. Term `quarantine` works this through.
     * It is surfaced because an operator investigating a large floor term needs
     * to know how much OTel was disowned, and because a term pinned at zero
     * cannot carry that number.
     */
    quarantinedOtelUsd: string
    /*
     * POST-CUTOVER (mig 0101, A3): the coding-agent lane now HAS a §A arm
     * (v_complete_usage's third, ingest-only union arm), so this is the actual
     * §A-visible coding-agent total, and `copilotAgentUsage` is now the TRUE
     * signed (raw − this) term rather than a pure sum (see the term's own
     * comment). This diagnostic stays independent of that term deliberately: a
     * term is summed into the residual, where a per-key cancellation ELSEWHERE
     * could in principle mask this lane going to zero (absent) or doubling
     * (double-counted) without moving the residual. Comparing this against
     * `codingAgentRawUsd` directly, with NOTHING else in between, is the
     * "independent diagnostic" the design calls for. Equal ⇒ healthy. Less ⇒
     * arm 3 is missing coverage (absent). More ⇒ the lane is reaching §A twice
     * (e.g. arm 1/2's ingest-only exclusion regressed).
     */
    codingAgentInSectionAUsd: string
    /**
     * The coding-agent lane's §B-side raw total (v_teammate_usage_daily,
     * tool='copilot-agent') — `copilotAgentUsage`'s B-operand, exposed so
     * `codingAgentInSectionAUsd` has an explicit, independent counterpart to be
     * compared against rather than an implicit one buried in the term.
     */
    codingAgentRawUsd: string
    /**
     * The non-Code Claude surfaces' actual §A-visible total
     * (v_complete_usage, restricted to NON_CODE_CLAUDE_TOOLS) — the arm-3
     * coverage as the view under test actually produces it. The independent
     * counterpart to `nonCodeSurfacesRawUsd`: equal ⇒ healthy; less ⇒ arm 3 is
     * absent/incomplete for this lane; more ⇒ the lane is reaching §A twice.
     * Mirrors `codingAgentInSectionAUsd` for the OTHER newly-visible lane.
     */
    nonCodeSurfacesInSectionAUsd: string
    /**
     * The non-Code Claude surfaces' TRUE total (actual_spend, unfiltered by
     * chargeback_exempt) — what a healthy arm 3 must exactly equal, since
     * v_teammate_usage_daily's actual_spend branch carries no exempt filter
     * either. NOT the same quantity as `nonCodeSurfaces` the term (which is
     * exempt-EXCLUDED on both sides, so the exempt carve-out is not
     * double-counted against `chargebackExemptUsage`) — this is deliberately
     * the UNFILTERED total, so it is directly comparable to
     * `nonCodeSurfacesInSectionAUsd`, which is also unfiltered.
     */
    nonCodeSurfacesRawUsd: string
  }
}

/*
 * "Corroborated OTel per (teammate, UTC day)" for claude-code — the floor term's
 * and the unreconciled term's shared operand.
 *
 * This used to be a private copy living in this file. It is now THE shared
 * fragment (server/usage/corroborated-otel.ts), because the two terms here model
 * opposite sides of the SAME reconciliation query and must agree not only with
 * each other but with `unaccounted-reconciliation.ts` and
 * `over-emission-detection.ts`. A private copy meant three implementations of one
 * definition, and the decomposition is the one that fails SILENTLY when they
 * drift: its residual still closes, because moving money between terms cannot
 * change a sum.
 *
 * `withTool: false` with `tool = 'claude-code'` in `extra` is correct rather than
 * merely convenient — the cell stays (teammate, day, claude-code) either way, so
 * the per-cell completeness test is computed over the same population as the two
 * queries this models.
 */
function claudeCodeCorroboratedOtelDaily(startIso: string, endIso: string) {
  return corroboratedOtelDaily({
    startExpr: sql`${startIso}::timestamptz`,
    endExpr: sql`${endIso}::timestamptz`,
    extra: sql`AND ar.tool = 'claude-code'`,
    withTool: false,
    withTokens: false,
  })
}

const NUMERIC_ZERO = '0.000000'

function orZero(val: string | null | undefined): string {
  // The SQL casts already return numeric(14,6)::text (e.g. '200.000000'), so
  // there is nothing to re-format. Deliberately NOT Number()+toFixed(): these are
  // money values and must never round-trip through a float.
  return val ?? NUMERIC_ZERO
}

/**
 * Compute the §A/§B decomposition for a given period window.
 *
 * All arithmetic is done in PostgreSQL using numeric(14,6) — never JS floats.
 * The result terms are mutually exclusive and collectively exhaustive:
 * `residual = delta − Σ(terms)` === 0.
 */
export async function computeAbDecomposition(
  db: Db,
  window: AbDecompositionWindow,
): Promise<AbDecompositionResult> {
  const { startIso, endIso } = window

  consola.debug('[ab-decomposition] Computing for window', { startIso, endIso })

  // ── §A: v_complete_usage total in window ───────────────────────────────────
  // arm 1: attribution_record minus quarantined rows
  // arm 2: unaccounted_usage where cost > 0
  // arm 3 (mig 0101, A3): the ingest-only completeness union (non-Code Claude
  // surfaces + copilot-agent) — this is what makes `nonCodeSurfaces` and
  // `copilotAgentUsage` genuine (not structurally-forced-zero) B-minus-A terms.
  const [sectionARow] = await db.execute<{ total: string }>(sql`
    SELECT COALESCE(SUM(cost_usd), 0)::numeric(14,6)::text AS total
    FROM v_complete_usage
    WHERE ts_event >= ${startIso}::timestamptz AND ts_event < ${endIso}::timestamptz
  `)
  const sectionA = orZero(sectionARow?.total)

  /*
   * ── §B: chargeable spend in window, and the unhomed slice of it ──────────
   * v_finance_chargeback_month = anthropic per-teammate (month-rolled) UNION ALL
   * the copilot pool lanes, keyed on period_month (first-of-month dates).
   *
   * Read through `unhomedByMonthSql` (server/usage/unhomed-causes.ts), which is
   * the ONE expression in the codebase that says what chargeable §B spend is
   * and which part of it is unhomed. It emits both per month, so §B and
   * `diagnostics.unhomedChargeUsd` are ONE query over ONE predicate rather than
   * two expressions for the same quantity rendered on the same card — the
   * previous round unified "unhomed" and stopped one line short of
   * "chargeable", leaving the lane exclusion hardcoded here and imported there.
   *
   * copilot-unclassified is EXCLUDED (that exclusion now lives in the shared
   * expression, keyed on COPILOT_UNCLASSIFIED_LANE rather than a literal). It is
   * a visible chargeback lane but it is NEVER charged (server/reporting/
   * finance.ts: chargeableUsd = license + usage only; drizzle/schema/
   * copilot-pool-bill.ts says the same, and >0 raises the
   * copilot-bill-unclassified alert). Summing every lane would make the figure
   * this card labels "Chargeable (§B)" disagree with the number the rest of the
   * product calls chargeable, so the gate would be measuring against a §B no
   * finance surface recognises. An unclassified SKU is an unmapped-bill problem,
   * not money that failed to be attributed, so it does not belong in this gap.
   */
  const [sectionBRow] = await db.execute<{ total: string; unhomed: string }>(sql`
    SELECT COALESCE(SUM(m.chargeable_usd), 0)::numeric(14,6)::text AS total,
           COALESCE(SUM(m.unhomed_usd), 0)::numeric(14,6)::text   AS unhomed
    FROM (${unhomedByMonthSql(startIso, endIso)}) m
  `)
  const sectionB = orZero(sectionBRow?.total)
  const unhomedChargeUsd = orZero(sectionBRow?.unhomed)

  // ── Delta ──────────────────────────────────────────────────────────────────
  const [deltaRow] = await db.execute<{ delta: string }>(sql`
    SELECT (${sectionB}::numeric(14,6) - ${sectionA}::numeric(14,6))::numeric(14,6)::text AS delta
  `)
  const delta = orZero(deltaRow?.delta)

  // ── nonCodeSurfaces ────────────────────────────────────────────────────────
  /*
   * POST-CUTOVER (mig 0101, A1/A3): before, these tools were absent from BOTH
   * §A arms (no OTel, excluded from v_teammate_usage_daily so no
   * unaccounted_usage row either), so this was a PURE §B sum — §A contributed
   * structurally nothing, so there was nothing to subtract. Migration 0101
   * restores them to v_teammate_usage_daily (A1) and adds the ingest-only
   * completeness arm to v_complete_usage (A3), so §A now genuinely sees this
   * money. The term becomes a TRUE §B-minus-§A missing-usage amount and MUST
   * read (approximately) zero once the fix is healthy — a non-zero value now
   * means real coverage is missing, not "the mechanism doesn't exist yet".
   *
   * The §A operand deliberately reads `actual_spend` directly (mirroring
   * `chargebackExemptUsage`'s existing style) rather than `v_complete_usage`,
   * and EXCLUDES `chargeback_exempt` rows — matching what
   * `v_finance_bill_chargeback` already excludes on the §B side. Comparing
   * "non-exempt vs non-exempt" keeps this term about GENUINE coverage gaps
   * only: the exempt carve-out is a SEPARATE, already-named phenomenon
   * (`chargebackExemptUsage`, whose exclusion list mig 0101 narrows to match —
   * see that term's comment). Reading v_complete_usage here instead — which
   * carries no exempt filter — would silently fold the exempt carve-out into
   * this term too, double-counting it against `chargebackExemptUsage`.
   *
   * This does NOT verify arm 3 itself (it never touches v_complete_usage), by
   * design: `actual_spend` is the single, join-free, row-preserving source of
   * truth for this money, so this term cannot be fooled by a bug WITHIN the
   * view. That verification is `diagnostics.nonCodeSurfacesInSectionAUsd` vs
   * `diagnostics.nonCodeSurfacesRawUsd`'s job — an INDEPENDENT alarm that reads
   * the view directly and cannot be masked by term cancellation elsewhere.
   */
  const nonCodeTools = [...NON_CODE_CLAUDE_TOOLS]
  const nonCodeToolsList = sql.join(
    nonCodeTools.map((t) => sql`${t}`),
    sql`, `,
  )
  const [nonCodeBRow] = await db.execute<{ total: string }>(sql`
    SELECT COALESCE(SUM(bill_usd), 0)::numeric(14,6)::text AS total
    FROM v_finance_bill_chargeback
    WHERE tool IN (${nonCodeToolsList})
      AND period_date >= ${startIso}::date AND period_date < ${endIso}::date
  `)
  const [nonCodeARow] = await db.execute<{ total: string }>(sql`
    SELECT COALESCE(SUM(a.cost_usd), 0)::numeric(14,6)::text AS total
    FROM actual_spend a
    WHERE a.tool IN (${nonCodeToolsList})
      AND NOT a.chargeback_exempt
      AND a.date >= ${startIso}::date AND a.date < ${endIso}::date
  `)
  const [nonCodeGapRow] = await db.execute<{ total: string }>(sql`
    SELECT (${orZero(nonCodeBRow?.total)}::numeric(14,6) - ${orZero(nonCodeARow?.total)}::numeric(14,6))::numeric(14,6)::text AS total
  `)
  const nonCodeSurfaces = orZero(nonCodeGapRow?.total)

  // The independent absence/double-count diagnostic pair (see the interface
  // doc): the ACTUAL arm-3 coverage the view produces, vs the TRUE unfiltered
  // total it must equal when healthy. Deliberately UNFILTERED by
  // chargeback_exempt on both sides (unlike the term above), since
  // v_teammate_usage_daily's actual_spend branch carries no such filter either
  // — an exempt row is exactly as "should be covered by arm 3" as any other.
  const [nonCodeInSectionARow] = await db.execute<{ total: string }>(sql`
    SELECT COALESCE(SUM(cost_usd), 0)::numeric(14,6)::text AS total
    FROM v_complete_usage
    WHERE tool IN (${nonCodeToolsList})
      AND ts_event >= ${startIso}::timestamptz AND ts_event < ${endIso}::timestamptz
  `)
  const [nonCodeRawRow] = await db.execute<{ total: string }>(sql`
    SELECT COALESCE(SUM(a.cost_usd), 0)::numeric(14,6)::text AS total
    FROM actual_spend a
    WHERE a.tool IN (${nonCodeToolsList})
      AND a.date >= ${startIso}::date AND a.date < ${endIso}::date
  `)
  const nonCodeSurfacesInSectionA = orZero(nonCodeInSectionARow?.total)
  const nonCodeSurfacesRaw = orZero(nonCodeRawRow?.total)

  // ── licenceLanes ───────────────────────────────────────────────────────────
  // `copilot-license` seat SKUs — a PURE SUM, never a subtraction. An idle
  // licensed seat is legitimately §A = 0, §B > 0, so this lane has NO §A
  // counterpart to net off. Subtracting the whole Copilot §A from the whole
  // Copilot §B (the shape this replaced) would absorb every Copilot-side
  // discrepancy into one term and force the residual to zero by construction,
  // which is precisely the subtraction the gate forbids.
  const [licenceRow] = await db.execute<{ total: string }>(sql`
    SELECT COALESCE(SUM(charge_usd), 0)::numeric(14,6)::text AS total
    FROM v_finance_copilot_pool_chargeback
    WHERE tool = 'copilot-license'
      AND period_month >= ${startIso}::date AND period_month < ${endIso}::date
  `)
  const licenceLanes = orZero(licenceRow?.total)

  // ── copilotUsageGap ────────────────────────────────────────────────────────
  // `copilot-usage` measured against the §A per-user
  // gross. Unlike the licence lane these DO have an §A counterpart, but the two
  // sides measure at different grains: §B is the pooled enterprise invoice, §A is
  // per-user `ai_credit/usage`. This is a NARROW, explicitly-named subtraction
  // over one lane pair — not a catch-all for the whole Copilot side.
  const [copUsageBRow] = await db.execute<{ total: string }>(sql`
    SELECT COALESCE(SUM(charge_usd), 0)::numeric(14,6)::text AS total
    FROM v_finance_copilot_pool_chargeback
    WHERE tool = 'copilot-usage'
      AND period_month >= ${startIso}::date AND period_month < ${endIso}::date
  `)
  /*
   * The §A side MUST be v_complete_usage, not unaccounted_usage alone. §A's
   * copilot money arrives through BOTH arms: arm 2 (unaccounted_usage, the
   * materialised per-user gap) and arm 1 (attribution_record, for a Copilot
   * device that emits OTel directly). Reading only arm 2 silently drops arm 1,
   * which showed up against real data as a $1.47 residual — small enough to look
   * like rounding and therefore exactly the kind of error that survives review.
   */
  const [copUsageARow] = await db.execute<{ total: string }>(sql`
    SELECT COALESCE(SUM(cost_usd), 0)::numeric(14,6)::text AS total
    FROM v_complete_usage
    WHERE tool IN (${COPILOT_CLI_TOOL}, ${COPILOT_AGENT_TOOL})
      AND ts_event >= ${startIso}::timestamptz AND ts_event < ${endIso}::timestamptz
  `)
  /*
   * ── copilotAgentUsage ──────────────────────────────────────────────────────
   * PRE-CUTOVER this was a PURE SUM, deliberately not `(provider total −
   * v_complete_usage total)`: migration 0086 excluded the coding-agent lane
   * from `v_complete_usage` BY CONSTRUCTION, so that subtraction's second
   * operand was structurally $0 no matter what — a "self-zeroing" difference
   * of two ESTATE-WIDE aggregates that could never mean anything, because it
   * could never be anything other than the raw figure. Missing coverage on one
   * teammate-day and excess coverage on another would have been free to cancel
   * behind it, and the zero would then have been misread as "the lane is
   * visible to §A", which was never true pre-cutover.
   *
   * POST-CUTOVER (mig 0101, A3): `v_complete_usage`'s third (ingest-only) union
   * arm is EXACTLY the mechanism that makes this lane §A-visible, sourced from
   * `v_teammate_usage_daily` with no further transformation that could drop or
   * duplicate a row (no JOIN, a straight pass-through filter). Subtracting it
   * is therefore no longer the same cancellation-prone shape it would have
   * been before this workstream existed: a per-teammate-day mismatch here can
   * only arise from a GLOBAL bug in arm 3's inclusion predicate or arm 1/2's
   * exclusion of it (both single, unconditional filters, not a join that could
   * drop one row and duplicate another) — not from independent per-key drift
   * the way `copilotUsageGap`'s pooled-vs-per-user grain mismatch can. The term
   * becomes the TRUE (raw − §A-visible) missing amount, and MUST read
   * (approximately) zero once arm 3 is healthy.
   *
   * `copilotUsageGap` (below) is UNCHANGED CODE and stays numerically
   * IDENTICAL across this transition: it subtracts `copilotAgentUsage` from
   * `copUsageARow` (which itself grows by exactly what arm 3 now contributes),
   * so the two changes cancel algebraically — the coding-agent lane's money
   * moves entirely within `copilotAgentUsage` and never touches the grain-gap
   * remainder. See the residual-preserving algebra note there.
   *
   * `diagnostics.codingAgentInSectionAUsd` / `diagnostics.codingAgentRawUsd`
   * are the INDEPENDENT alarm: this term is summed into the residual, where
   * (in principle) a compensating error elsewhere could mask it going wrong;
   * the diagnostic pair compares the same two quantities OUTSIDE that sum, so
   * neither term cancellation nor a partial fix can hide an absent or
   * doubled lane from an operator reading the card.
   */
  const [copAgentRow] = await db.execute<{ total: string }>(sql`
    SELECT COALESCE(SUM(usage_usd), 0)::numeric(14,6)::text AS total
    FROM v_teammate_usage_daily
    WHERE tool = ${COPILOT_AGENT_TOOL}
      AND day >= ${startIso}::date AND day < ${endIso}::date
  `)
  const codingAgentRaw = orZero(copAgentRow?.total)

  // The independent alarm (see the interface doc + the term comment above).
  // Equal to `codingAgentRaw` ⇒ healthy. Less ⇒ arm 3 is missing coverage
  // (absent). More ⇒ the lane is reaching §A twice (double-counted).
  const [copAgentInARow] = await db.execute<{ total: string }>(sql`
    SELECT COALESCE(SUM(cost_usd), 0)::numeric(14,6)::text AS total
    FROM v_complete_usage
    WHERE tool = ${COPILOT_AGENT_TOOL}
      AND ts_event >= ${startIso}::timestamptz AND ts_event < ${endIso}::timestamptz
  `)
  const codingAgentInSectionA = orZero(copAgentInARow?.total)

  const [copAgentGapRow] = await db.execute<{ total: string }>(sql`
    SELECT (${codingAgentRaw}::numeric(14,6) - ${codingAgentInSectionA}::numeric(14,6))::numeric(14,6)::text AS total
  `)
  const copilotAgentUsage = orZero(copAgentGapRow?.total)

  /*
   * The gap is now the REMAINDER after the coding-agent lane is named, which is
   * what makes it a narrow grain gap rather than a catch-all. Subtracting the
   * named term here keeps the identity intact by construction: the two together
   * still sum to (§B usage lane - §A copilot), so naming the lane moves money
   * between two visible numbers and never changes the residual.
   *
   * RESIDUAL-PRESERVING ALGEBRA ACROSS THE 0101 CUTOVER (worth stating once,
   * precisely, because it is not obvious by inspection): `copUsageARow` now
   * includes arm 3's coding-agent contribution (call it `x`, $0 pre-cutover),
   * so it grows from `A0` to `A0 + x`. `copilotAgentUsage` shrinks from `raw`
   * to `raw − x`. Their SUM in this subtraction, `copUsageARow +
   * copilotAgentUsage`, is `(A0 + x) + (raw − x) = A0 + raw` — UNCHANGED. So
   * `copilotUsageGap` reads the SAME value before and after the cutover on the
   * same underlying data, even though its two inputs individually moved. This
   * is exactly the "moving money between two visible numbers never changes a
   * sum" principle the ABSORPTION SWEEP below is built on, demonstrated across
   * a real migration rather than just within one call.
   */
  const [copGapRow] = await db.execute<{ total: string }>(sql`
    SELECT (${orZero(copUsageBRow?.total)}::numeric(14,6)
          - ${orZero(copUsageARow?.total)}::numeric(14,6)
          - ${copilotAgentUsage}::numeric(14,6))::numeric(14,6)::text AS total
  `)
  const copilotUsageGap = orZero(copGapRow?.total)

  /*
   * ── quarantine ─────────────────────────────────────────────────────────────
   * STRUCTURALLY ZERO, and that is a correction, not an oversight. The quantity
   * operators care about is still returned, as `diagnostics.quarantinedOtelUsd`.
   *
   * This term used to sum quarantined attribution_record cost as a positive
   * contribution, and the residual closed. It closed because the floor term was
   * ALSO counting the same rows with the opposite sign: floor summed OTel over
   * the API without excluding quarantined rows, so a forged session appeared as
   * +75 here and -75 there. Two terms that cancel are not two explanations; the
   * pair inflated the absolute denominator the dominance verdict divides by
   * (by twice the quarantined amount) while explaining nothing.
   *
   * Work the arithmetic per (teammate, day) for claude-code, where
   * corroborated = OTel excluding quarantined rows:
   *
   *     §A = arm1 + arm2 = corroborated + max(0, API - corroborated)
   *                      = max(corroborated, API)
   *     §B = API
   *     δ  = API - max(corroborated, API) = -max(0, corroborated - API)
   *
   * which is exactly the floor term. Quarantined money has already left arm 1,
   * and reconciliation nets against the SAME corroborated OTel, so it cannot
   * reach §A by either arm; a forged session has no actual_spend so it never
   * reaches §B either. Its contribution to the delta is nil in every case:
   * uncorroborated (no §B counterpart), and corroborated (arm 2 adds the API
   * amount straight back, and §B bills that same amount).
   *
   * So the term is retained for the reader, who needs to see that quarantine was
   * considered, and pinned at zero. The real figure moves to diagnostics, where a
   * non-zero value is verifiable rather than cancelling invisibly against floor.
   */
  const [quarantineRow] = await db.execute<{ quarantined: string }>(sql`
    SELECT COALESCE(SUM(ar.cost_usd), 0)::numeric(14,6)::text AS quarantined
    FROM attribution_record ar
    WHERE ar.ts_event >= ${startIso}::timestamptz AND ar.ts_event < ${endIso}::timestamptz
      AND EXISTS (
        SELECT 1 FROM session_quarantine sq
        WHERE sq.teammate_id = ar.teammate_id
          AND sq.conversation_id = COALESCE(ar.claude_session_id, ar.instance_id::text)
          AND sq.resolved_at IS NULL
          AND sq.reason = 'api-uncorroborated'
      )
  `)
  const quarantinedOtelUsd = orZero(quarantineRow?.quarantined)
  const quarantine = '0.000000'

  // ── floor ──────────────────────────────────────────────────────────────────
  // For each (teammate, day, tool=claude-code) where OTel > API: the excess is
  // absorbed by max(0,...) in the unaccounted reconciliation. This makes §A
  // LARGER than the API truth (OTel is counted in full via attribution_record,
  // but the negative unaccounted is floored at 0). Effect on delta: NEGATIVE
  // (reduces §B−§A).
  //
  // Compute: for each (teammate, day) in the window, compare attribution_record
  // sum (OTel) against actual_spend (API truth). Where OTel > API, sum the excess.
  // Only for claude-code (non-code surfaces have no OTel, copilot is separate).
  /*
   * The OTel side MUST mirror server/usage/unaccounted-reconciliation.ts exactly,
   * because this term models the floor that query applies. Two ways it can drift,
   * both of which produce a wrong number that still LOOKS right:
   *
   *  1. Quarantined rows. Reconciliation excludes dev-confirmed forgeries from
   *     its OTel total ("the under and over lanes must net against the SAME
   *     corroborated OTel"), and v_complete_usage drops them from §A too. Summing
   *     them here would model an excess against an OTel total neither §A nor the
   *     reconciliation ever used, double-counting money the quarantine term
   *     already accounts for.
   *  2. Day binning. Reconciliation bins on (ts_event AT TIME ZONE 'UTC')::date.
   *     A bare ts_event::date casts using the session TimeZone, so on any server
   *     not set to UTC the two disagree at every day boundary and the excess is
   *     compared against the wrong day's API truth.
   *
   * Neither drift shows up as a non-zero residual unless a quarantined session
   * happens to land on a day where OTel already exceeds the API, which is why the
   * fixture now plants exactly that case.
   */
  const [floorRow] = await db.execute<{ total: string }>(sql`
    WITH otel_daily AS (${claudeCodeCorroboratedOtelDaily(startIso, endIso)}),
    api_daily AS (
      SELECT a.teammate_id, a.date AS day, SUM(a.cost_usd) AS api_usd
      FROM actual_spend a
      WHERE a.tool = 'claude-code'
        AND a.date >= ${startIso}::date AND a.date < ${endIso}::date
      GROUP BY a.teammate_id, a.date
    )
    SELECT (-COALESCE(SUM(GREATEST(0, o.otel_usd - COALESCE(a.api_usd, 0))), 0))::numeric(14,6)::text AS total
    FROM otel_daily o
    LEFT JOIN api_daily a ON o.teammate_id = a.teammate_id AND o.day = a.day
    WHERE o.otel_usd > COALESCE(a.api_usd, 0)
  `)
  // Negated in SQL above: the floor makes §A larger, so it REDUCES §B−§A.
  const floor = orZero(floorRow?.total)

  // ── chargebackExemptUsage ──────────────────────────────────────────────────
  /*
   * Money that `chargeback_exempt` removes from §B while leaving it in §A.
   *
   * Every §B lane filters `WHERE NOT chargeback_exempt` (migrations 0073, 0081,
   * 0085). `v_teammate_usage_daily` does NOT, so the reconciliation worker
   * materialises exempt spend into `unaccounted_usage` and it reaches §A through
   * arm 2 anyway. One-directional, no counterpart, so it is a named term rather
   * than a filter: the `api_daily` CTEs above deliberately keep exempt rows
   * because they model the WORKER, and the worker keeps them.
   *
   * The tool list is the inverse of what `v_teammate_usage_daily`'s first arm
   * excludes, and MUST mirror it exactly (`GITHUB_USAGE_VIEW_TOOLS`, never the
   * wider `GITHUB_USAGE_TOOLS`, which carries provider_usage_fact's own) — a tool
   * excluded from that view's actual_spend branch never reaches §A from
   * `actual_spend` by any path, so its exempt rows are absent from BOTH sides
   * and including them here would invent a gap:
   *
   *   copilot-cli / copilot-agent — STILL excluded (mig 0101 did not change
   *     this): their §A usage truth is `reconciliation_record`, not
   *     `actual_spend`, so an actual_spend row carrying either tool literal
   *     reaches NEITHER v_teammate_usage_daily's actual_spend branch nor (by
   *     extension) v_complete_usage. §B comes from `copilot_pool_bill`. An
   *     exempt actual_spend row for either tool feeds neither side.
   *
   * POST-CUTOVER (mig 0101, A1/A3) CHANGE: the non-Code Claude surfaces used to
   * be excluded here too, for the identical reason — absent from §A, and their
   * §B lane already filters exempt, so an exempt non-Code row reached neither
   * side. Migration 0101 restores them to `v_teammate_usage_daily` (A1, no
   * exempt filter there either) and to `v_complete_usage` via the ingest-only
   * arm (A3), so an exempt non-Code row NOW reaches §A while still being
   * excluded from §B (`v_finance_bill_chargeback` filters it) — the exact same
   * one-directional shape claude-code has always had. They are REMOVED from
   * the exclusion list so this term counts them.
   *
   * NOT double-counted against `nonCodeSurfaces`: that term's §A operand
   * explicitly excludes `chargeback_exempt` rows too (see its own comment), so
   * the exempt carve-out is owned EXCLUSIVELY by this term — `nonCodeSurfaces`
   * only ever measures the non-exempt gap.
   *
   * Effect: NEGATIVE (raises §A with no §B counterpart, so it reduces §B−§A).
   */
  const sectionAReachingExclusions = [...GITHUB_USAGE_VIEW_TOOLS]
  const [exemptRow] = await db.execute<{ total: string }>(sql`
    SELECT (-COALESCE(SUM(a.cost_usd), 0))::numeric(14,6)::text AS total
    FROM actual_spend a
    WHERE a.chargeback_exempt
      AND a.tool NOT IN (${sql.join(
        sectionAReachingExclusions.map((t) => sql`${t}`),
        sql`, `,
      )})
      AND a.date >= ${startIso}::date AND a.date < ${endIso}::date
  `)
  const chargebackExemptUsage = orZero(exemptRow?.total)

  // ── populationDifference ───────────────────────────────────────────────────
  // actual_spend rows where teammate_id has NO matching teammate row. The INNER
  // JOIN in v_finance_bill_chargeback drops them from §B. They're also absent
  // from §A (FK constraints). Effect: NEGATIVE (reduces §B, makes delta smaller).
  const firewallTools = [...GITHUB_FIREWALL_EXCLUSIONS]
  const [popRow] = await db.execute<{ total: string }>(sql`
    SELECT (-COALESCE(SUM(a.cost_usd), 0))::numeric(14,6)::text AS total
    FROM actual_spend a
    WHERE NOT a.chargeback_exempt
      AND a.tool NOT IN (${sql.join(
        firewallTools.map((t) => sql`${t}`),
        sql`, `,
      )})
      AND a.date >= ${startIso}::date AND a.date < ${endIso}::date
      AND NOT EXISTS (SELECT 1 FROM teammate t WHERE t.id = a.teammate_id)
  `)
  // Negated in SQL: these rows are dropped from §B, so they REDUCE §B−§A.
  // Under the current FK (actual_spend.teammate_id → teammate.id) this is
  // structurally 0. It is COMPUTED rather than hardcoded so that a future
  // soft-delete or FK relaxation surfaces here instead of silently inflating
  // the residual.
  const populationDifference = orZero(popRow?.total)

  /*
   * ── homingLoss ───────────────────────────────────────────────────────────
   * HARDCODED ZERO, deliberately, and unlike populationDifference it is NOT
   * computed. Say so
   * plainly: an earlier version of this comment claimed it was computed "for the
   * same reason as populationDifference" while the SQL below selected a literal,
   * which is the
   * kind of comment that outlives the code it describes and then lies to the
   * next reader. It is now a TS constant rather than a `SELECT '0.000000'`, so
   * there is no round-trip left to mistake for a measurement.
   *
   * It is zero by proof, not by measurement. The LEFT JOIN LATERAL to the
   * nearest cost-owning ancestor cannot DROP a row: an unhomed teammate yields a
   * NULL cost_owning_unit_id and the row still sums into the §B total. There is
   * no query that could return anything but 0 here at the estate grain, so there
   * is nothing to compute and no future regression for a computed form to catch.
   *
   * The term stays in the list because the reader of a decomposition needs to see
   * that homing was considered and why it contributes nothing. The quantity that
   * IS real gets surfaced next to it as `unhomedChargeUsd` — money that vanishes
   * the moment §B is sliced BY cost-owning unit. That is the figure the card
   * shows, and it is the one the test asserts against.
   *
   * `unhomedChargeUsd` is read at the §B block above, out of the SAME row and
   * the SAME expression (`unhomedByMonthSql`) as §B itself — one query, one
   * predicate, no second definition of either quantity. The cause split that
   * decomposes this figure (server/usage/unhomed-causes.ts) carries that same
   * expression into the same statement as its own buckets, so the split cannot
   * disagree WITH ITSELF — the alternative, a second query at teammate grain, is
   * exactly how a breakdown silently stops adding up to the thing it breaks down.
   *
   * The split IS a separate statement from this one, and this comment used to
   * read as though it were not. Same definition, different snapshot under READ
   * COMMITTED: the two figures can differ by whatever placement changed between
   * the two reads, and neither residual would show it. See that module's ONE
   * DEFINITION, TWO STATEMENTS header for why merging them would cost the
   * guarantee this block relies on.
   */
  const homingLoss = NUMERIC_ZERO

  // ── unreconciledApiLag / unreconciledApiStale ──────────────────────────────
  // The SYMMETRIC COUNTERPART of `floor`. The floor names (teammate, day) pairs
  // where OTel over-reads the API; this names the pairs where the API over-reads
  // OTel and the reconciliation worker has NOT yet written the difference into
  // unaccounted_usage. Until it does, §B bills that money and §A has no row for
  // it, so it is a real, nameable, self-healing component of the delta.
  //
  // TWO TERMS, not one, and the split is the whole point. This was a single
  // signed number computed as (Σ expected over the estate) - (Σ materialised
  // over the estate). Two estate-wide aggregates subtracted after the
  // (teammate, day) key is discarded: $100 of missing materialisation on one
  // teammate-day and $100 of stale materialisation on another cancelled exactly,
  // the term read $0, the residual still closed, and the card reported no
  // reconciliation problem while $200 of it sat there. It also silently shrank
  // the absolute denominator the dominance verdict divides by.
  //
  // The FULL OUTER JOIN below keeps the key, so the two directions are summed
  // separately and neither can hide the other. They are opposite phenomena with
  // opposite operator responses: `lag` is the worker behind (wait, or backfill
  // if the day has aged out of its 35-day window), `stale` is §A carrying more
  // than the API now reports (late telemetry after a day was reconciled). A
  // single number could not have told an operator which they were looking at.
  //
  // Their sum is unchanged, so the identity and the residual are untouched.
  //
  // Found by running the decomposition against real data for the first time: it
  // returned a $698.53 residual, of which $700.00 was exactly this (the rest was
  // a separate copilot §A bug). The fixture could not have surfaced it — every
  // synthesised API row had a matching OTel row or a matching unaccounted row.
  //
  // claude-code only: the Copilot lanes are handled by copilotUsageGap, and the
  // non-Code surfaces by nonCodeSurfaces (they have no OTel arm at all, so they
  // are not "unreconciled", they are structurally absent).
  const [unreconciledRow] = await db.execute<{ lag: string; stale: string }>(sql`
    WITH otel_daily AS (${claudeCodeCorroboratedOtelDaily(startIso, endIso)}),
    api_daily AS (
      SELECT a.teammate_id, a.date AS day, SUM(a.cost_usd) AS api_usd
      FROM actual_spend a
      WHERE a.tool = 'claude-code'
        AND a.date >= ${startIso}::date AND a.date < ${endIso}::date
      GROUP BY a.teammate_id, a.date
    ),
    expected AS (
      SELECT a.teammate_id, a.day,
             GREATEST(0, a.api_usd - COALESCE(o.otel_usd, 0)) AS v
      FROM api_daily a
      LEFT JOIN otel_daily o ON o.teammate_id = a.teammate_id AND o.day = a.day
    ),
    materialised AS (
      SELECT u.teammate_id, u.day, SUM(u.cost_usd) AS v
      FROM unaccounted_usage u
      WHERE u.tool = 'claude-code' AND u.cost_usd > 0
        AND u.day >= ${startIso}::date AND u.day < ${endIso}::date
      GROUP BY u.teammate_id, u.day
    ),
    per_key AS (
      SELECT COALESCE(e.v, 0) - COALESCE(m.v, 0) AS d
      FROM expected e
      FULL OUTER JOIN materialised m
        ON m.teammate_id = e.teammate_id AND m.day = e.day
    )
    SELECT COALESCE(SUM(GREATEST(0, d)), 0)::numeric(14,6)::text AS lag,
           (-COALESCE(SUM(GREATEST(0, -d)), 0))::numeric(14,6)::text AS stale
    FROM per_key
  `)
  const unreconciledApiLag = orZero(unreconciledRow?.lag)
  const unreconciledApiStale = orZero(unreconciledRow?.stale)

  /*
   * ── ABSORPTION SWEEP ───────────────────────────────────────────────────────
   * Four review rounds each found another term that could absorb a phenomenon
   * rather than name one, and each time the residual stayed at zero throughout,
   * because moving money between two terms cannot change a sum. Finding the
   * fifth by waiting for a fifth round is not a method. Every term is therefore
   * classified here by SHAPE, since the shape is what determines whether
   * absorption is possible at all:
   *
   *   FILTERED SUMS - one aggregate over one source, with no second quantity
   *   subtracted from it, so there is nothing for a second phenomenon to cancel
   *   against. (populationDifference negates its own sum, which is a sign, not a
   *   subtraction.)
   *     licenceLanes, populationDifference.
   *
   *   PER-KEY, ONE-DIRECTIONAL - subtract, but only ever inside a
   *   (teammate, day) group and only in one direction, so two different keys
   *   cannot cancel each other:
   *     floor, unreconciledApiLag, unreconciledApiStale.
   *
   *   ESTATE-WIDE SUBTRACTIONS, PROVEN SAFE BY CONSTRUCTION (mig 0101) -
   *   subtracts two whole-window aggregates, which is normally the exact shape
   *   this sweep exists to forbid — EXCEPT where the source relationship
   *   between the two operands is a single unconditional filter with no JOIN
   *   that could drop one row and duplicate another, which makes a per-key
   *   cancellation (one teammate-day missing, another double) structurally
   *   impossible; only a GLOBAL predicate bug remains, and that is exactly what
   *   `chargebackExemptUsage`'s tool-list mirror-check and each lane's
   *   independent in-section-A-vs-raw diagnostic exist to catch:
   *     nonCodeSurfaces, copilotAgentUsage, chargebackExemptUsage.
   *   `nonCodeSurfaces` and `copilotAgentUsage` were FILTERED SUMS before
   *   migration 0101 gave their lanes a real §A arm to subtract (see each
   *   term's own comment for why the pre-0101 form was a pure sum, not a
   *   subtraction, and why post-0101 it safely can be).
   *
   *   STRUCTURALLY ZERO, with the real quantity exposed as a diagnostic:
   *     quarantine (diagnostics.quarantinedOtelUsd) and homingLoss
   *     (diagnostics.unhomedChargeUsd). homingLoss is a literal zero rather than
   *     a computed per-key difference; it is kept in the term list so a reader
   *     sees that homing was considered.
   *
   *   THE REMAINDER - and there is exactly one, deliberately:
   *     copilotUsageGap.
   *
   * copilotUsageGap subtracts two estate-wide aggregates AND cannot be proven
   * safe the way the three above were: the §B side is a pooled enterprise
   * invoice with no teammate grain to join on, so there is no predicate fix
   * that could make it keyable. A decomposition needs somewhere for the
   * unnamed to land, and it is better to have one term that admits to being
   * that place than several that do not.
   *
   * What is required of it in exchange is honesty at the surface: its hint names
   * the largest thing known to hide in it (Copilot users with no teammate
   * mapping, skipped before any usage row is written, so billed in §B and absent
   * from §A) and points at the admin surface that can quantify it. Anything else
   * unexplained lands here too. Treat a large or moving copilotUsageGap as
   * unexplained spend, not as a measurement artefact.
   *
   * THE PREDICTED SCENARIO, RESOLVED (mig 0101). This section used to warn: "if
   * coding-agent spend ever becomes visible to §A, copilotAgentUsage keeps
   * counting it AND copilotUsageGap falls by the same amount... the residual
   * will not report that double-count... codingAgentInSectionAUsd is surfaced
   * as an independent alarm instead". That day has now arrived — arm 3 makes
   * the lane §A-visible — and the resolution is exactly as designed:
   * `copilotAgentUsage` became the true (raw − §A) term (reading ~0 when
   * healthy, not silently absorbing anything), `copilotUsageGap`'s CODE did not
   * change and reads the SAME value it always did (see its residual-preserving
   * algebra note), and `codingAgentInSectionAUsd` / `codingAgentRawUsd` remain
   * the independent, non-summed pair that would catch an absence or a
   * double-count even if some OTHER term's cancellation masked it from the
   * residual. The same three-part answer (true term + unchanged neighbour +
   * independent diagnostic pair) is why `nonCodeSurfaces` could follow the
   * identical shape for its own lane.
   */

  // ── Assemble result ────────────────────────────────────────────────────────
  const terms: Record<AbDecompositionTermName, string> = {
    nonCodeSurfaces,
    licenceLanes,
    copilotAgentUsage,
    copilotUsageGap,
    quarantine,
    floor,
    chargebackExemptUsage,
    populationDifference,
    homingLoss,
    unreconciledApiLag,
    unreconciledApiStale,
  }

  // residual = delta − Σ(terms), computed in SQL so money never touches a float.
  // Σ is built from AB_DECOMPOSITION_TERMS (not a hand-written list) so adding a
  // term to the shared const can never silently leave it out of the residual.
  const termValues = AB_DECOMPOSITION_TERMS.map((t) => terms[t])
  const [residualRow] = await db.execute<{ residual: string }>(sql`
    SELECT (${delta}::numeric(14,6) - (${sql.join(
      termValues.map((v) => sql`${v}::numeric(14,6)`),
      sql` + `,
    )}))::numeric(14,6)::text AS residual
  `)
  const residual = orZero(residualRow?.residual)

  consola.debug('[ab-decomposition] Result', {
    sectionA,
    sectionB,
    delta,
    terms,
    residual,
    unhomedChargeUsd,
  })

  return {
    sectionA,
    sectionB,
    delta,
    terms,
    residual,
    diagnostics: {
      unhomedChargeUsd,
      quarantinedOtelUsd,
      codingAgentInSectionAUsd: codingAgentInSectionA,
      codingAgentRawUsd: codingAgentRaw,
      nonCodeSurfacesInSectionAUsd: nonCodeSurfacesInSectionA,
      nonCodeSurfacesRawUsd: nonCodeSurfacesRaw,
    },
  }
}
