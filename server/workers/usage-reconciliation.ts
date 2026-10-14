/*
 * usage-reconciliation worker — recomputes the per-(teammate, day, tool)
 * "unaccounted usage" (provider API truth − OTel captured) over a trailing window,
 * so a developer's "My usage" reflects the COMPLETE provider truth and the un-enrolled
 * delta is taggable day-by-day. See docs/design/provider-billing-attribution-model.md §A.
 *
 * Trailing 35-day window (crosses the month boundary, absorbs late OTel arrivals); the
 * upsert is idempotent and tag-preserving, so re-running only refreshes the amounts.
 */
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import type * as schema from '../../drizzle/schema'
import { reconcileUnaccountedUsage, type ReconcileUnaccountedResult } from '../usage/unaccounted-reconciliation'
import {
  detectOverEmission,
  sweepStrayQuarantines,
  type OverEmissionResult,
  type StrayQuarantineSweepResult,
} from '../usage/over-emission-detection'
import { notifyEscalatedOverEmission, type EscalationNotifyResult } from '../notifications/over-emission'

type Db = PostgresJsDatabase<typeof schema>

const TRAILING_DAYS = 35

function utcDay(d: Date): string {
  return d.toISOString().slice(0, 10)
}

export interface UsageReconciliationResult {
  unaccounted: ReconcileUnaccountedResult
  overEmission: OverEmissionResult
  quarantineSweep: StrayQuarantineSweepResult
  escalationNotify: EscalationNotifyResult
}

export async function runUsageReconciliation(
  db: Db,
  opts?: { now?: Date },
): Promise<UsageReconciliationResult> {
  const now = opts?.now ?? new Date()
  const endDate = utcDay(now)
  const start = new Date(now)
  start.setUTCDate(start.getUTCDate() - (TRAILING_DAYS - 1))
  const startDate = utcDay(start)
  // First: lift any developer quarantine whose conversation has since recorded
  // usage outside its flag's (UTC day, tool) cell, and escalate the flag. Not
  // windowed (a quarantine can be any age), bounded per run, one transaction per
  // flag. It runs BEFORE the two reconciliations so they net against the
  // conversation's restored OTel on this same tick.
  const quarantineSweep = await sweepStrayQuarantines(db)
  // Then every flag escalated since its last notice (by the developer, or by the
  // sweep just above) goes to its region's admins' inbox.
  const escalationNotify = await notifyEscalatedOverEmission(db)
  // Two sides of the same API-vs-OTel reconciliation: under (usage OTel missed → taggable)
  // and over (uncorroborated OTel excess → flagged for the dev to review).
  const unaccounted = await reconcileUnaccountedUsage(db, { startDate, endDate })
  const overEmission = await detectOverEmission(db, { startDate, endDate })
  return { unaccounted, overEmission, quarantineSweep, escalationNotify }
}
