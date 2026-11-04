/*
 * Escalated over-emission flags reach the admins who can investigate them.
 *
 * Raised by the usage-reconciliation worker, not the resolve route: the route
 * runs under the developer's row-level security, which can neither see the
 * admins nor insert an item addressed to someone else.
 *
 * Once per escalation: a flag is picked up while escalation_notified_at is unset
 * or older than resolved_at (mig 0156, a partial index holds exactly those), so a
 * re-escalated flag is notified again. Routing is dispatch.ts's: the admins of
 * the region the teammate sits in NOW (not over_emission.region_id, the stamp
 * at detection) plus the platform admins.
 */
import { sql } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import type * as schema from '../../drizzle/schema'
import { dispatchInbox } from './dispatch'

type Db = PostgresJsDatabase<typeof schema>

/** Flags notified per run; the rest wait for the next run. */
export const ESCALATION_NOTIFY_LIMIT = 50
/**
 * Flags looked at per run. A flag with no recipient yet (no eligible admin)
 * stays pending, so the scan reaches past up to this many of them; more than
 * that would need a deployment with no eligible platform admin at all.
 */
export const ESCALATION_SCAN_LIMIT = 500

export interface EscalationNotifyResult {
  /** Flags an item was raised for in this run. */
  notified: number
  /** Inbox items created (one per recipient). */
  items: number
}

// The predicate of over_emission_escalation_unnotified (mig 0156); keep them equal.
const unnotified = sql`
  oe.state = 'escalated'
  AND (oe.escalation_notified_at IS NULL OR oe.escalation_notified_at < oe.resolved_at)`

export async function notifyEscalatedOverEmission(
  db: Db,
  opts?: { limit?: number; scanLimit?: number },
): Promise<EscalationNotifyResult> {
  const limit = opts?.limit ?? ESCALATION_NOTIFY_LIMIT
  const candidates = await db.execute<{ id: string }>(sql`
    SELECT oe.id::text AS id FROM over_emission oe
    WHERE ${unnotified}
    ORDER BY oe.resolved_at, oe.id
    LIMIT ${opts?.scanLimit ?? ESCALATION_SCAN_LIMIT}
  `)
  let notified = 0
  let items = 0
  for (const c of candidates) {
    if (notified >= limit) break
    const n = await db.transaction(async (tx) => {
      // Lock and recheck, so two overlapping runs cannot both notify one escalation.
      const rows = await tx.execute<{
        teammate_id: string
        teammate_name: string
        region_id: string
        day: string
        tool: string
        over_usd: string
        resolved_over_usd: string | null
        computed_at: string
        by_system: boolean
      }>(sql`
        SELECT oe.teammate_id::text AS teammate_id,
               COALESCE(NULLIF(t.display_name, ''), t.email) AS teammate_name,
               t.region_id::text AS region_id,
               oe.day::text AS day, oe.tool,
               oe.over_usd::text AS over_usd,
               oe.resolved_over_usd::text AS resolved_over_usd,
               to_char(oe.computed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS computed_at,
               oe.resolved_by IS NULL AS by_system
        FROM over_emission oe JOIN teammate t ON t.id = oe.teammate_id
        WHERE oe.id = ${c.id}::uuid AND ${unnotified}
        FOR UPDATE OF oe SKIP LOCKED
      `)
      const f = [...rows][0]
      if (!f) return 0
      const dispatched = await dispatchInbox(tx, {
        category: 'over-emission-escalated',
        subject: f.by_system
          ? `An over-emission flag for ${f.teammate_name} was escalated automatically (${f.tool}, ${f.day})`
          : `${f.teammate_name} escalated an over-emission flag (${f.tool}, ${f.day})`,
        body: {
          overEmissionId: c.id,
          teammateId: f.teammate_id,
          teammateName: f.teammate_name,
          day: f.day,
          tool: f.tool,
          // The excess when the flag was resolved: escalated by the developer, or
          // (for a sweep escalation) quarantined by them. Nothing rewrites it later.
          resolvedOverUsd: f.resolved_over_usd === null ? null : Number(f.resolved_over_usd),
          // The excess as last computed. Every detection run (this worker, the
          // backfill) rewrites it, so it is labelled as current. otel_usd and
          // api_usd are not sent: when the excess stops being material detection
          // zeroes over_usd alone, so they can be stale beside it.
          currentOverUsd: Number(f.over_usd),
          computedAt: f.computed_at,
          escalatedBy: f.by_system ? 'system' : 'teammate',
          // The teammate report needs a frame (?src=, D33): the teammate's region,
          // which every recipient holds.
          actionHref: `/reporting/teammate/${encodeURIComponent(f.teammate_id)}?${new URLSearchParams({
            src: `region:${f.region_id}`,
            from: f.day,
            to: f.day,
          }).toString()}`,
        },
        relatedEntityKind: 'over-emission',
        relatedEntityId: c.id,
        regionId: f.region_id,
      })
      // With no recipient yet (no admin), the flag stays pending for a later run.
      if (dispatched.length > 0) {
        await tx.execute(sql`UPDATE over_emission SET escalation_notified_at = now() WHERE id = ${c.id}::uuid`)
      }
      return dispatched.length
    })
    if (n > 0) notified++
    items += n
  }
  return { notified, items }
}
