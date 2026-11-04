/*
 * reports/velocity — the SINGLE velocity definition for the reporting area
 * (reporting-consolidation D-Q7, docs/design/reporting-consolidation/
 * 02-owner-decisions.md; build-design §8 Q7). The governance dial
 * (`velocity.spike_threshold`, mig 0049) is THE definition. The old practice-page
 * `FLAG_MULT = 2` literal is a second, hard-coded threshold still used by the
 * practice page. This module is the canonical resolver the reporting endpoints call.
 *
 * The dial is a FRACTIONAL delta (platform default 0.25 = "25% over baseline"),
 * resolved most-specific-wins (region overrides platform), fail-loud on an absent
 * platform row — see server/utils/governance-settings.ts.
 */
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import {
  GOV_VELOCITY_SPIKE_THRESHOLD,
  loadGovernanceSettingResolver,
  resolveGovernanceSetting,
} from '../utils/governance-settings'

type Db = PostgresJsDatabase<Record<string, unknown>>

/** The canonical dial key the reporting velocity signal resolves against. */
export const VELOCITY_SPIKE_DIAL = GOV_VELOCITY_SPIKE_THRESHOLD

/**
 * Resolve the velocity spike threshold for a region (region override wins over
 * platform). Per-request path — one dial, one query.
 */
export function resolveVelocitySpikeThreshold(db: Db, regionId?: string | null): Promise<number> {
  return resolveGovernanceSetting(db, GOV_VELOCITY_SPIKE_THRESHOLD, regionId)
}

/**
 * Snapshot the dial (platform + all region overrides) into a pure
 * `(regionId) => threshold` resolver, for region-spanning reporting passes that
 * flag many rows without a query per row (mirrors velocity-watch's usage).
 */
export function loadVelocitySpikeResolver(db: Db): Promise<(regionId: string | null) => number> {
  return loadGovernanceSettingResolver(db, GOV_VELOCITY_SPIKE_THRESHOLD)
}

/**
 * The pure spike decision that replaces the `FLAG_MULT` literal: a row is flagged
 * when its current spend exceeds its baseline mean by AT LEAST `threshold`
 * (fractional delta). Zero/absent baseline → never flagged (no divide, no noise).
 * The output tracks the dial — a higher threshold flags strictly fewer rows.
 */
export function isVelocitySpike(
  currentUsd: number,
  baselineMeanUsd: number,
  threshold: number,
): boolean {
  if (baselineMeanUsd <= 0) return false
  return (currentUsd - baselineMeanUsd) / baselineMeanUsd >= threshold
}
