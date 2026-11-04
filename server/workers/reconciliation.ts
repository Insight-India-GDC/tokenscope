/*
 * OTel-vs-Anthropic reconciliation worker.
 *
 * Per docs/build/mvp-lite-epic.md §Epic 9 EVS: "OTel-vs-Anthropic
 * reconciliation surface creates info-severity inbox items for users
 * with >10 % gap".
 *
 * Gap = (anthropic_actual - otel_attributed) / anthropic_actual.
 * Anthropic actuals are the truth source; OTel is best-effort.
 * Positive gap → some of the user's spend wasn't attributed to a
 * session (untagged via the plugin, or OTel emit failed). Dispatch an
 * info-severity inbox item to the dev so they can re-attest.
 *
 * One inbox item per (teammate, month) — idempotent via the related
 * entity unique check.
 */
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { sql } from 'drizzle-orm'
import type * as schema from '../../drizzle/schema'
import { dispatchInbox } from '../notifications/dispatch'
import { recordAuditEvent } from '../db/audit'
import {
  GOV_RECONCILIATION_GAP_THRESHOLD,
  resolveGovernanceSetting,
} from '../utils/governance-settings'

export interface ReconcileResult {
  teammatesScanned: number
  gapsFlagged: number
  // Over-attribution (slice 11): reconciled-lane OTel spend that EXCEEDS the
  // authoritative Anthropic actual — the forgery / mis-tag backstop. Advisory
  // only (flag + audit), never a hard cap — "tag proposes, membership disposes,
  // reconciliation truths" but the budget teaches; we don't block.
  overAttributionsFlagged: number
}

export async function runReconciliation(
  db: PostgresJsDatabase<typeof schema>,
  opts?: { now?: Date },
): Promise<ReconcileResult> {
  const now = opts?.now ?? new Date()
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
  // Gap-threshold dial (mig 0049; platform default 0.1 = 10% per EVS),
  // resolved once per run. Platform scope: the worker spans regions and the
  // gap bar is an org-wide reconciliation contract, not a per-region signal.
  const gapThreshold = await resolveGovernanceSetting(db, GOV_RECONCILIATION_GAP_THRESHOLD)

  const rows = await db.execute<{
    teammate_id: string
    actual_cost: string
    otel_cost: string
  }>(
    sql`
      WITH anthropic AS (
        SELECT teammate_id, COALESCE(SUM(cost_usd), 0)::text AS cost
        FROM actual_spend
        WHERE date >= ${monthStart.toISOString().slice(0, 10)}::date
          -- match every Anthropic lane: legacy single-org 'anthropic-analytics-api'
          -- plus per-org 'anthropic-analytics-api:<orgId>' (multi-org poller).
          -- Exact forms only (R1 #10): a bare prefix LIKE would also match an
          -- unrelated 'anthropic-analytics-api-<x>' source.
          AND (source = 'anthropic-analytics-api' OR source LIKE 'anthropic-analytics-api:%')
        GROUP BY teammate_id
      ),
      otel AS (
        -- Only the reconcilable lane: telemetry-only (indicative/unknown-org)
        -- attribution lives in a provider org our Anthropic API can't see, so
        -- comparing it against actual_spend would manufacture false gaps.
        -- See docs/design/client-attribution-auth-spec.md §2.1.
        SELECT teammate_id, COALESCE(SUM(cost_usd), 0)::text AS cost
        FROM attribution_record
        WHERE ts_event >= ${monthStart.toISOString()}::timestamptz
          AND cost_basis <> 'telemetry-only'
        GROUP BY teammate_id
      )
      SELECT
        a.teammate_id::text AS teammate_id,
        a.cost AS actual_cost,
        COALESCE(o.cost, '0') AS otel_cost
      FROM anthropic a
      LEFT JOIN otel o ON o.teammate_id = a.teammate_id
    `,
  )

  let flagged = 0
  let overFlagged = 0
  for (const r of rows) {
    const actual = Number(r.actual_cost)
    const otel = Number(r.otel_cost)
    // actual > 0 is guaranteed (rows come FROM the anthropic CTE), so the
    // poller HAS a ceiling for this teammate this month. We never evaluate
    // over-attribution without a real actual — when actual_spend is empty
    // (poller not yet run / no reconciled org) there are simply no rows, so
    // there's no false "everything is over-attributed" storm.
    if (actual <= 0) continue
    const gap = (actual - otel) / actual

    if (gap >= gapThreshold) {
      // UNDER-attribution: Anthropic reports more than the sessions we recorded
      // (tagged OR untagged: the otel CTE does not filter on project), so this
      // is missing telemetry, not missing tags → point the dev at emission.
      if (await hasOpenItem(db, r.teammate_id, 'untagged-backlog', monthStart)) continue
      await dispatchInbox(db, {
        category: 'untagged-backlog',
        severity: 'info',
        subject: `Unrecorded spend: ${(gap * 100).toFixed(0)}% of what Anthropic reports for you this month has no recorded session`,
        body: {
          anthropic_actual_usd: actual,
          otel_attributed_usd: otel,
          gap_pct: gap,
          suggestion: 'Check that your devices are sending usage (/tokenscope:status); a session that never reached TokenScope can be re-sent with /tokenscope:backfill.',
        },
        recipientTeammateIdHint: r.teammate_id,
      })
      flagged += 1
    } else if (gap <= -gapThreshold) {
      // OVER-attribution (slice 11): reconciled-lane recorded spend EXCEEDS the
      // authoritative Anthropic actual — a mis-tag or forgery. Flag + audit
      // (advisory; the poller actual is the ceiling, but we don't hard-cap).
      const overPct = -gap
      if (await hasOpenItem(db, r.teammate_id, 'over-attribution', monthStart)) continue
      await dispatchInbox(db, {
        category: 'over-attribution',
        severity: 'attention',
        subject: `Over-attribution: your recorded session spend exceeds what Anthropic reports for you by ${(overPct * 100).toFixed(0)}%`,
        body: {
          anthropic_actual_usd: actual,
          otel_attributed_usd: otel,
          over_pct: overPct,
          note: 'Your recorded sessions add up to more than Anthropic reports for you this month. A session may be recorded under you that is not yours, or counted twice; check Recent sessions on My usage.',
        },
        recipientTeammateIdHint: r.teammate_id,
      })
      await recordAuditEvent(db, {
        eventType: 'over-attribution-flagged',
        actorSystem: 'reconciliation',
        subjectKind: 'teammate',
        subjectId: r.teammate_id,
        payload: { anthropic_actual_usd: actual, otel_attributed_usd: otel, over_pct: overPct, month: monthStart.toISOString().slice(0, 7) },
      })
      overFlagged += 1
    }
  }

  return { teammatesScanned: rows.length, gapsFlagged: flagged, overAttributionsFlagged: overFlagged }
}

/** Idempotency: an unresolved inbox item for this teammate + category this month. */
async function hasOpenItem(
  db: PostgresJsDatabase<typeof schema>,
  teammateId: string,
  category: string,
  monthStart: Date,
): Promise<boolean> {
  const existing = await db.execute<{ id: string }>(
    sql`
      SELECT id::text AS id FROM inbox_item
      WHERE recipient_teammate_id = ${teammateId}::uuid
        AND category = ${category}
        AND ack_state IN ('unread', 'read', 'acknowledged')
        AND created_at >= ${monthStart.toISOString()}::timestamptz
      LIMIT 1
    `,
  )
  return existing.length > 0
}
