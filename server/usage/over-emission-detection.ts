/*
 * Over-emission detection — the integrity counterpart of §A's unaccounted reconciliation.
 * docs/design/provider-billing-attribution-model.md §A + ADR-0010 rule 2 / ADR-0008.
 *
 * The provider API is the truth. When OTel emits MORE than the API corroborates
 * (accidentally or maliciously — a forged/mis-tagged emission), the excess is flagged for
 * the developer to review. Per (teammate, day, tool):
 *
 *     over = max(0, Σ OTel(excl. already-quarantined) − API daily total)
 *
 * CRITICAL — basis (CLAUDE lane): actual_spend is the provider BILL; attribution_record is the
 * OTel rate-carded ESTIMATE (different money bases — that's why a cost-drift view exists). So
 * `OTel − bill` is NON-zero for honest usage whenever the rate card runs high, and a naive
 * flag would CRY FRAUD on honest heavy users. (The COPILOT lane is cleaner: both OTel cost and
 * the reconciliation usage are gross-credits × $0.01, the SAME basis, so honest Copilot usage
 * sits at ~1.0× — the guards below still apply uniformly.) Two guards keep this an integrity
 * signal, not an estimate-drift alarm:
 *   1. MATERIALITY — flag only when OTel EXCEEDS 2× the bill AND the excess clears a high
 *      absolute floor (over > GREATEST($25, 1.0 × api)). A forgery (API $50, OTel $500) is
 *      10×; honest rate-card drift lives in the 1.1–1.5× band and never trips this.
 *   2. SETTLED-BILL ONLY — the bill for recent days is still filling (the hourly poller)
 *      while OTel is real-time, so we never flag the trailing `settledLagDays` (default 3);
 *      a transiently-incomplete bill must not read as forgery.
 *
 * The OTel sum EXCLUDES conversations already in an open api-uncorroborated quarantine, so
 * once the dev quarantines the suspect session the over recomputes down (and the flag
 * clears). State + the suspect session are PRESERVED across recompute; a recompute whose
 * over MATERIALLY exceeds the watermark at resolution RE-OPENS the flag (a new forgery on
 * a day the dev already vouched for is not silently swallowed).
 *
 * Both providers: the per-(teammate, day, tool) API USAGE truth comes from the
 * `v_teammate_usage_daily` view (mig 0073) — claude-code from actual_spend, copilot-cli GROSS
 * from reconciliation_record (GitHub ai_credit/usage is per-(user, day)). Do NOT confuse this
 * per-user USAGE with Copilot's POOLED per-cost-centre BILL (§B) — different axis. A tool with
 * no API usage that day yields api_usd=0 and is never flagged (the materiality guard below).
 *
 * The display-only 'copilot-agent' lane (mig 0086, design D4) needs no exclusion here: the
 * computation starts FROM the OTel side and joins the API truth onto it, and no OTel emission
 * ever carries tool='copilot-agent' (the category is OTEL_INVISIBLE) — so its view rows are
 * structurally unreachable. Splitting the coding-agent credits OUT of the copilot-cli api_usd
 * (0086) also puts interactive OTel and interactive API on the SAME basis, tightening the
 * Copilot corroboration rather than loosening it.
 */
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { sql } from 'drizzle-orm'
import type * as schema from '../../drizzle/schema'
import { dispatchInbox } from '../notifications/dispatch'
import { CLAUDE_FAMILY_TOOLS } from '../../shared/usage/surface'
import { corroboratedOtelDaily } from './corroborated-otel'
import { advisoryXactLock } from '../db/advisory-lock'
import { recordAuditEvent } from '../db/audit'
import {
  hasActivePersonalSubscription,
  personalSubscriptionLockKey,
} from '../governance/personal-subscription'

type Db = PostgresJsDatabase<typeof schema>

/** Materiality: OTel must exceed 2× the bill (over > 1.0×api) AND clear a high absolute
 *  floor — so rate-card estimate drift (bill vs estimate basis) is never flagged. */
export const OVER_EMISSION_MIN_USD = 25.0
export const OVER_EMISSION_REL = 1.0
/** Days whose bill is still settling are never flagged (poller fills hourly; OTel is real-time). */
export const OVER_EMISSION_SETTLED_LAG_DAYS = 3
/** A resolved flag re-opens only when the new over exceeds the watermark by this factor. */
export const OVER_EMISSION_REFLAG_FACTOR = 1.5

/*
 * (A) — the "api_usd = 0" gap. `material` below requires `api_usd > 0`
 * (line ~121's WHERE), by design: api=0 means EITHER the org isn't
 * reconciled yet OR spend is genuinely zero, and the two are indistinguishable
 * from this view alone — so a naive widen-the-threshold fix would flag every
 * teammate in an unreconciled org as a suspected forger (the false positive
 * this gate exists to avoid). But that same design means a FULLY unreconciled
 * org has NO high-confidence flag no matter how large the OTel total — a real
 * detection hole the audit correctly called out.
 *
 * The fix is a SEPARATE, LOWER-CONFIDENCE lane (never merged into the
 * high-confidence flag): when api_usd = 0, an OTel total above a floor
 * MATERIALLY HIGHER than OVER_EMISSION_MIN_USD is worth a developer's
 * attention even without a bill to corroborate against. Set high on purpose —
 * see the Must-not-break note this story shipped with: a floor set too low
 * flags ordinary usage in an unreconciled org as a suspected forger and burns
 * the credibility of the whole quarantine UX. This is a JUDGEMENT CALL (no
 * prior art in this codebase to anchor it to) — flagged as such in the story
 * return value; revisit with real unreconciled-org volume once observed.
 *
 * PERSISTED SINCE MIG 0132 (UF-21), UNDER ITS OWN NAME. `over_emission.reason`
 * now discriminates the two lanes, so this one is written as
 * `reason='no-bill-to-corroborate'` instead of living only in this function's
 * return value. It is still NOT a high-confidence flag and still not an
 * accusation: every developer-facing reader (GET /api/v1/me/over-emission, the
 * resolve route, me-lens's has_open_review) filters to 'api-uncorroborated', so
 * nothing about a developer's review queue changed when this lane started
 * landing. What changed is that the number is durable and queryable rather than
 * observable only in one worker run's result.
 *
 * The non-accusatory `personal-subscription-prompt` inbox item is unchanged and
 * still the only thing this lane says to a human. The prompt asks rather than
 * classifies, and migration 0109 deduplicates it per teammate/tool/signal-month.
 */
export const OVER_EMISSION_NO_BILL_FLOOR_USD = 250.0

/**
 * over_emission.reason (mig 0132) — which lane wrote the row. Exported because
 * the read side has to filter on it: a reader that forgets puts a
 * "your org isn't reconciled" row into a forgery review queue.
 */
export const OVER_EMISSION_REASON_API_UNCORROBORATED = 'api-uncorroborated'
export const OVER_EMISSION_REASON_NO_BILL = 'no-bill-to-corroborate'

export interface OverEmissionOptions {
  startDate: string
  endDate: string
  teammateId?: string
  /** Don't flag days newer than (endDate − this). Default OVER_EMISSION_SETTLED_LAG_DAYS. */
  settledLagDays?: number
  /** Disable teammate prompts for historical administrative backfills. The
   *  scheduled trailing-window worker leaves this enabled. */
  dispatchPersonalPrompts?: boolean
}

export interface OverEmissionResult {
  flagged: number
  totalOverUsd: number
  /**
   * (A) — (teammate, day, tool) combinations with OTel spend but NO bill to
   * corroborate against (api_usd = 0) whose OTel total clears
   * OVER_EMISSION_NO_BILL_FLOOR_USD. Written to `over_emission` under
   * `reason = 'no-bill-to-corroborate'` since mig 0132 (UF-21), and NEVER merged
   * into `flagged`/`totalOverUsd` — those two count the high-confidence
   * 'api-uncorroborated' lane only, which is also the only lane any
   * developer-facing reader shows.
   */
  noBillFlagged: number
  totalNoBillUsd: number
  /** Teammate prompts inserted for likely-personal Claude usage. The database
   *  deduplicates these per teammate/tool/signal-month. */
  personalPromptsDispatched: number
}

export async function detectOverEmission(db: Db, opts: OverEmissionOptions): Promise<OverEmissionResult> {
  const teammateFilterApi = opts.teammateId ? sql`AND teammate_id = ${opts.teammateId}::uuid` : sql``
  const teammateFilterOtel = opts.teammateId ? sql`AND ar.teammate_id = ${opts.teammateId}::uuid` : sql``

  // Settled-bill cutoff: never flag days whose bill is still filling.
  const lag = opts.settledLagDays ?? OVER_EMISSION_SETTLED_LAG_DAYS
  const cutoff = new Date(`${opts.endDate}T00:00:00.000Z`)
  cutoff.setUTCDate(cutoff.getUTCDate() - lag)
  const settledBefore = cutoff.toISOString().slice(0, 10)

  // Shared computation: per (teammate, day, tool), the OTel total EXCLUDING open-quarantined
  // conversations, vs the API truth; the material over-emission.
  const computed = sql`
    WITH api AS (
      SELECT teammate_id, day, tool, usage_usd AS api_usd
      FROM v_teammate_usage_daily
      WHERE day >= ${opts.startDate}::date AND day <= ${opts.endDate}::date ${teammateFilterApi}
    ),
    -- THE shared operand (server/usage/corroborated-otel.ts) — byte-identical to
    -- the one the UNDER direction nets against (unaccounted-reconciliation.ts).
    -- The two directions must agree or a dollar can be both "un-enrolled usage we
    -- missed" and "emission we cannot corroborate" at once. Since mig 0119 that
    -- operand also drops self-billed rows in a fully-stamped cell: personal-
    -- subscription usage has no bill to corroborate against, so counting it here
    -- manufactured over-emission flags against developers doing nothing wrong.
    otel AS (${corroboratedOtelDaily({
      startExpr: sql`${opts.startDate}::date::timestamptz`,
      endExpr: sql`(${opts.endDate}::date + 1)::timestamptz`,
      extra: teammateFilterOtel,
      withTool: true,
      withTokens: false,
    })}),
    recon AS (
      SELECT otel.teammate_id, otel.day, otel.tool,
             otel.otel_usd,
             COALESCE(api.api_usd, 0) AS api_usd,
             GREATEST(0, otel.otel_usd - COALESCE(api.api_usd, 0)) AS over_usd
      FROM otel
      LEFT JOIN api ON api.teammate_id = otel.teammate_id AND api.day = otel.day AND api.tool = otel.tool
    ),
    material AS (
      SELECT * FROM recon
      -- api_usd > 0: there must be an actual bill for that day to corroborate against.
      -- api=0 means the bill is MISSING (org not reconciled) OR genuinely $0 — we can't
      -- tell which, so we never read "no bill data" as "forgery". (Without this, every
      -- OTel day for a teammate whose org isn't reconciled false-flags as uncorroborated.)
      WHERE api_usd > 0
        AND over_usd > GREATEST(${OVER_EMISSION_MIN_USD}, ${OVER_EMISSION_REL} * api_usd)
        AND day <= ${settledBefore}::date   -- settled-bill only (don't flag a still-filling day)
    ),
    -- (A) — the SEPARATE, lower-confidence lane: api_usd = 0 (no bill at all,
    -- so no ratio to compare against — only the absolute floor applies), OTel
    -- above OVER_EMISSION_NO_BILL_FLOOR_USD, same settled-bill guard. NEVER
    -- unioned with the material CTE above — see OverEmissionResult.noBillFlagged.
    --
    -- PERSONAL-DECLARATION CARVE-OUT (ADR-0011 D3/D4, design §4.3): a teammate
    -- who has explicitly declared a (tool) as their OWN personal subscription
    -- is, by construction, never going to have a bill to corroborate against —
    -- there IS no Insight-paid org for it. Without this exclusion, EVERY
    -- declared-personal teammate's usage would sit in this lane forever,
    -- reading as a suspected forger for doing exactly what they told us they
    -- were doing. Scoped PRECISELY to the declared (teammate, tool) contract —
    -- never a blanket exemption, and never applied to the 'material' lane
    -- above (a REAL bill mismatch is never waived by a personal declaration).
    material_no_bill AS (
      SELECT recon.* FROM recon
      WHERE api_usd = 0
        AND over_usd > ${OVER_EMISSION_NO_BILL_FLOOR_USD}
        AND day <= ${settledBefore}::date
        AND NOT EXISTS (
          SELECT 1 FROM personal_subscription_declaration psd
          WHERE psd.teammate_id = recon.teammate_id AND psd.tool = recon.tool AND psd.revoked_at IS NULL
        )
    )`

  // 1. Upsert the material over-emissions (preserve the dev's state + suspect-session call).
  const flagged = await db.execute<{ id: string }>(sql`
    ${computed}
    INSERT INTO over_emission (teammate_id, region_id, org_unit_id, day, tool, otel_usd, api_usd, over_usd, reason, computed_at)
    SELECT m.teammate_id, t.region_id, t.org_unit_id, m.day, m.tool,
           m.otel_usd::numeric(14,6), m.api_usd::numeric(14,6), m.over_usd::numeric(14,6),
           ${OVER_EMISSION_REASON_API_UNCORROBORATED}, now()
    FROM material m JOIN teammate t ON t.id = m.teammate_id
    -- PLACEMENT IS ABSENT FROM THIS LIST ON PURPOSE (issue #44). region_id and
    -- org_unit_id are stamped by the INSERT above and never refreshed, so a flag
    -- keeps the placement it was raised under. Do not add them: a reorg would
    -- drag old flags onto the new unit, and a date-floored placement correction
    -- would be silently undone on the next tick. Asserted in
    -- tests/integration/usage/placement-freeze.test.ts.
    ON CONFLICT (teammate_id, day, tool) DO UPDATE SET
      otel_usd = EXCLUDED.otel_usd, api_usd = EXCLUDED.api_usd, over_usd = EXCLUDED.over_usd,
      -- A cell CHANGES LANE when its org starts reconciling: yesterday there was no
      -- bill to corroborate against, today there is one and OTel materially exceeds
      -- it. Same (teammate, day, tool), so the same row — it must stop describing
      -- itself as the lane it is no longer in.
      reason = EXCLUDED.reason, computed_at = now(),
      -- Re-open a resolved flag when a NEW forgery pushes the over materially past what the
      -- dev vouched for (watermark); otherwise the dev's call stands.
      state = CASE
        WHEN over_emission.state <> 'open'
          AND over_emission.resolved_over_usd IS NOT NULL
          AND EXCLUDED.over_usd > over_emission.resolved_over_usd * ${OVER_EMISSION_REFLAG_FACTOR}
        THEN 'open' ELSE over_emission.state END,
      resolved_at = CASE
        WHEN over_emission.state <> 'open'
          AND over_emission.resolved_over_usd IS NOT NULL
          AND EXCLUDED.over_usd > over_emission.resolved_over_usd * ${OVER_EMISSION_REFLAG_FACTOR}
        THEN NULL ELSE over_emission.resolved_at END
    RETURNING id::text AS id
  `)

  // 1b. Upsert the no-bill lane under its own `reason` (mig 0132). Separate statement,
  //     not a UNION into step 1, for two reasons: `flagged` must keep counting the
  //     high-confidence lane ONLY, and this lane has no developer resolution to
  //     preserve — it is never offered as a review item, so there is no watermark and
  //     no re-open rule. Placement is stamped on INSERT and never refreshed, same as
  //     step 1 (issue #44).
  await db.execute(sql`
    ${computed}
    INSERT INTO over_emission (teammate_id, region_id, org_unit_id, day, tool, otel_usd, api_usd, over_usd, reason, computed_at)
    SELECT n.teammate_id, t.region_id, t.org_unit_id, n.day, n.tool,
           n.otel_usd::numeric(14,6), n.api_usd::numeric(14,6), n.over_usd::numeric(14,6),
           ${OVER_EMISSION_REASON_NO_BILL}, now()
    FROM material_no_bill n JOIN teammate t ON t.id = n.teammate_id
    ON CONFLICT (teammate_id, day, tool) DO UPDATE SET
      otel_usd = EXCLUDED.otel_usd, api_usd = EXCLUDED.api_usd, over_usd = EXCLUDED.over_usd,
      reason = EXCLUDED.reason, computed_at = now()
  `)

  // 2. Refresh any window row whose over is no longer material to 0 — covers an OPEN flag
  //    falling below threshold AND a row the dev already resolved (e.g. quarantined the
  //    suspect session → OTel dropped → over now 0). State is preserved either way; only
  //    the stored over_usd is corrected to current reality.
  //
  //    BOTH lanes are checked. Zeroing a row merely because it is absent from `material`
  //    would blank every no-bill row on the same tick that wrote it — the two CTEs are
  //    disjoint by construction, so "not in material" is not the same claim as
  //    "no longer flagged".
  await db.execute(sql`
    ${computed}
    UPDATE over_emission oe SET over_usd = 0, computed_at = now()
    WHERE oe.over_usd > 0
      AND oe.day >= ${opts.startDate}::date AND oe.day <= ${opts.endDate}::date
      ${opts.teammateId ? sql`AND oe.teammate_id = ${opts.teammateId}::uuid` : sql``}
      AND NOT EXISTS (
        SELECT 1 FROM material m
        WHERE m.teammate_id = oe.teammate_id AND m.day = oe.day AND m.tool = oe.tool
      )
      AND NOT EXISTS (
        SELECT 1 FROM material_no_bill n
        WHERE n.teammate_id = oe.teammate_id AND n.day = oe.day AND n.tool = oe.tool
      )
  `)

  // The HIGH-CONFIDENCE lane only. `totalOverUsd` is the "uncorroborated excess"
  // figure operators read; folding in rows that had no bill to corroborate against
  // would make an unreconciled org look like a fleet of forgers.
  const [agg] = await db.execute<{ n: string; usd: string }>(sql`
    SELECT COUNT(*) FILTER (WHERE state = 'open' AND over_usd > 0)::text AS n,
           COALESCE(SUM(over_usd) FILTER (WHERE state = 'open' AND over_usd > 0), 0)::text AS usd
    FROM over_emission
    WHERE day >= ${opts.startDate}::date AND day <= ${opts.endDate}::date
      AND reason = ${OVER_EMISSION_REASON_API_UNCORROBORATED}
      ${opts.teammateId ? sql`AND teammate_id = ${opts.teammateId}::uuid` : sql``}
  `)

  // 3. (A) — the no-bill lane is freshly recomputed every call, and step 1b has
  // just persisted it under `reason = 'no-bill-to-corroborate'`. It never becomes
  // a HIGH-CONFIDENCE row and is never offered as a review item; declarable Claude
  // tools are grouped into the lower-confidence prompt stream below.
  const promptRows =
    opts.dispatchPersonalPrompts === false
      ? []
      : await db.execute<{
          teammate_id: string
          tool: string
          signal_month: string
          usage_usd: string
          days: string
          first_day: string
          last_day: string
        }>(sql`
          ${computed}
          SELECT teammate_id::text AS teammate_id,
                 tool,
                 to_char(day, 'YYYY-MM') AS signal_month,
                 SUM(over_usd)::text AS usage_usd,
                 COUNT(*)::text AS days,
                 MIN(day)::text AS first_day,
                 MAX(day)::text AS last_day
          FROM material_no_bill
          WHERE tool IN (${sql.join(CLAUDE_FAMILY_TOOLS.map((tool) => sql`${tool}`), sql`, `)})
          GROUP BY teammate_id, tool, to_char(day, 'YYYY-MM')
          ORDER BY teammate_id, tool, signal_month
        `)

  const [noBillAgg] = await db.execute<{
    n: string
    usd: string
  }>(sql`
    ${computed}
    SELECT COUNT(*)::text AS n, COALESCE(SUM(over_usd), 0)::text AS usd
    FROM material_no_bill
  `)

  let personalPromptsDispatched = 0
  for (const prompt of promptRows) {
    personalPromptsDispatched += await db.transaction(async (tx) => {
      const keyArgs = { teammateId: prompt.teammate_id, tool: prompt.tool }
      await tx.execute(advisoryXactLock('personalSubscription', personalSubscriptionLockKey(keyArgs)))
      if (await hasActivePersonalSubscription(tx, keyArgs)) return 0

      const dispatched = await dispatchInbox(tx, {
        category: 'personal-subscription-prompt',
        severity: 'info',
        subject: `Could your ${prompt.tool} usage be from a personal subscription?`,
        body: {
          kind: 'likely-personal-subscription',
          tool: prompt.tool,
          signalMonth: prompt.signal_month,
          usageUsd: Number(prompt.usage_usd),
          days: Number(prompt.days),
          firstDay: prompt.first_day,
          lastDay: prompt.last_day,
          actionHref: '/account#personal-subscription',
        },
        recipientTeammateIdHint: prompt.teammate_id,
        relatedEntityKind: 'teammate',
        relatedEntityId: prompt.teammate_id,
      })
      return dispatched.length
    })
  }

  return {
    flagged: flagged.length,
    totalOverUsd: Number(agg?.usd ?? 0),
    noBillFlagged: Number(noBillAgg?.n ?? 0),
    totalNoBillUsd: Number(noBillAgg?.usd ?? 0),
    personalPromptsDispatched,
  }
}

/**
 * Batch bound for {@link sweepStrayQuarantines}: candidates handled per run. The
 * sweep runs every usage-reconciliation tick, so a backlog drains over a few ticks
 * instead of one run holding locks on an unbounded set.
 */
export const STRAY_QUARANTINE_SWEEP_LIMIT = 200

export interface StrayQuarantineSweepResult {
  /** Flags escalated and quarantines lifted in this run. */
  lifted: number
}

/**
 * Lift a developer quarantine once its conversation has STRAYED OUTSIDE the flag
 * that justified it.
 *
 * The resolve route (POST /api/v1/me/over-emission/{id}/resolve) only lets a
 * developer quarantine a conversation whose records all sit in the flag's
 * (UTC day, tool) cell. But that is checked once, when the developer decides. The
 * quarantine itself is conversation-wide: the corroborated-OTel operand and
 * v_complete_usage drop EVERY record of that conversation, including records
 * ingested later, on another day or tool. Without this sweep, a developer could
 * quarantine one session against a genuine flag and keep using the same
 * conversation id, and everything it did afterwards would be gone from their §A
 * usage.
 *
 * For each open 'api-uncorroborated' quarantine whose conversation now has a
 * record outside the cell of the flag that quarantined it, one transaction:
 *   - lifts the quarantine (resolved_at = now(), keeping the row, the same way
 *     heartbeat-coverage clears its own rows), so the conversation counts again;
 *   - sets the flag to 'escalated', the state the developer's own "escalate"
 *     action uses to hand a flag to the region admin. resolved_by is NULL because
 *     the system made this call. The flag leaves the developer's queue, so they
 *     cannot quarantine again from it;
 *   - queues the teammate for a full rollup recompute, as the resolve route does;
 *   - writes an `over-emission-quarantine-lifted` audit event.
 *
 * It matches a flag in ANY state, not only 'quarantined'. The detector can re-open
 * a quarantined flag while its quarantine stays open, and the developer can then
 * accept it. Without that, the quarantine would stay open under an 'accepted' flag
 * and still hide the later records. Idempotent: once the quarantine is lifted the
 * candidate query no longer matches, and the locked recheck skips any row another
 * run already handled.
 */
export async function sweepStrayQuarantines(
  db: Db,
  opts?: { limit?: number },
): Promise<StrayQuarantineSweepResult> {
  const limit = opts?.limit ?? STRAY_QUARANTINE_SWEEP_LIMIT
  // The conversation key is COALESCE(claude_session_id, instance_id::text), the
  // same one the resolve route uses. It is spelled out as an OR so the
  // claude_session_id index can serve it. The day is the UTC day the detector
  // buckets on (corroborated-otel.ts).
  // Both fragments read the flag through the alias `oe`.
  const stray = sql`
    EXISTS (
      SELECT 1 FROM attribution_record ar
      WHERE ar.teammate_id = oe.teammate_id
        AND (ar.claude_session_id = oe.quarantined_conversation_id
             OR (ar.claude_session_id IS NULL AND ar.instance_id::text = oe.quarantined_conversation_id))
        AND ((ar.ts_event AT TIME ZONE 'UTC')::date <> oe.day OR ar.tool <> oe.tool)
    )`
  const openQuarantine = sql`
    EXISTS (
      SELECT 1 FROM session_quarantine sq
      WHERE sq.teammate_id = oe.teammate_id
        AND sq.conversation_id = oe.quarantined_conversation_id
        AND sq.reason = 'api-uncorroborated'
        AND sq.resolved_at IS NULL
    )`

  const candidates = await db.execute<{ id: string }>(sql`
    SELECT oe.id::text AS id
    FROM over_emission oe
    WHERE oe.quarantined_conversation_id IS NOT NULL
      AND ${openQuarantine}
      AND ${stray}
    ORDER BY oe.day, oe.id
    LIMIT ${limit}
  `)

  let lifted = 0
  for (const c of candidates) {
    lifted += await db.transaction(async (tx) => {
      // Same lock order as the resolve route (flag first, then quarantine).
      // Recheck under the lock so a concurrent run cannot double-handle the row.
      const flagRows = await tx.execute<{
        teammate_id: string; day: string; tool: string; state: string; conversation_id: string
      }>(sql`
        SELECT oe.teammate_id::text AS teammate_id, oe.day::text AS day, oe.tool, oe.state,
               oe.quarantined_conversation_id AS conversation_id
        FROM over_emission oe
        WHERE oe.id = ${c.id}::uuid
          AND oe.quarantined_conversation_id IS NOT NULL
          AND ${openQuarantine}
          AND ${stray}
        FOR UPDATE OF oe
      `)
      const flag = [...flagRows][0]
      if (!flag) return 0

      const liftedRows = await tx.execute<{ id: string }>(sql`
        UPDATE session_quarantine
           SET resolved_at = now(), updated_at = now()
         WHERE teammate_id = ${flag.teammate_id}::uuid
           AND conversation_id = ${flag.conversation_id}
           AND reason = 'api-uncorroborated'
           AND resolved_at IS NULL
        RETURNING id::text AS id
      `)
      await tx.execute(sql`
        UPDATE over_emission
           SET state = 'escalated', resolved_at = now(), resolved_by = NULL
         WHERE id = ${c.id}::uuid
      `)
      // The lift puts this conversation's whole history back into
      // v_complete_usage arm 1, with no timestamp a trailing window can see.
      // Queue a full-history recompute, exactly as the resolve route does.
      await tx.execute(sql`
        INSERT INTO usage_rollup_refresh (teammate_id, requested_at)
        VALUES (${flag.teammate_id}::uuid, statement_timestamp())
        ON CONFLICT (teammate_id) DO UPDATE SET requested_at = GREATEST(usage_rollup_refresh.requested_at + interval '1 microsecond', statement_timestamp())
      `)
      await recordAuditEvent(tx, {
        eventType: 'over-emission-quarantine-lifted',
        actorSystem: 'usage-reconciliation',
        subjectKind: 'over-emission',
        subjectId: c.id,
        payload: {
          teammate_id: flag.teammate_id,
          conversation_id: flag.conversation_id,
          flag_day: flag.day,
          flag_tool: flag.tool,
          previous_state: flag.state,
          new_state: 'escalated',
          session_quarantine_ids: [...liftedRows].map((r) => r.id),
          reason: 'conversation has usage outside the flag\'s (UTC day, tool) cell',
        },
      })
      return 1
    })
  }
  return { lifted }
}
