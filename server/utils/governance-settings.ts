/*
 * Governance-settings resolver — the configurable thresholds ("dials") for
 * the live detection mechanisms, held in `governance_setting` (mig 0049):
 * the velocity spike flag and the reconciliation gap/epsilon/lag dials.
 *
 * Precedence: a region row overrides the platform row (most-specific-wins),
 * mirroring project_lifecycle_policy (server/db/project-lifecycle-policy.ts).
 * UNLIKE that resolver there is NO hard-coded fallback: the migration seeds
 * one platform row per key, so an absent key means a broken deploy — fail
 * loud rather than silently invent a threshold.
 *
 * Three entry points:
 *  - resolveGovernanceSetting(db, key, regionId?)   — one dial, one query.
 *  - resolveGovernanceSettings(db, keys, regionId?) — batched, one query.
 *  - loadGovernanceSettingResolver(db, key)         — snapshot platform + ALL
 *    region overrides for one key, return a pure (regionId) => number fn, for
 *    region-spanning workers (velocity-watch resolves per teammate's region)
 *    — zero per-row queries, like loadLifecyclePolicyResolver.
 *
 * Workers run outside request scope — these accept a plain db handle
 * (PostgresJsDatabase), like server/auth/org-roles.ts.
 */
import { sql } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'

type Db = PostgresJsDatabase<Record<string, unknown>>

// Canonical key names — the allowlist the admin PUT validates against.
export const GOV_VELOCITY_SPIKE_THRESHOLD = 'velocity.spike_threshold'
export const GOV_RECONCILIATION_GAP_THRESHOLD = 'reconciliation.gap_threshold'
export const GOV_RECONCILIATION_EPSILON_USD = 'reconciliation.epsilon_usd'
export const GOV_RECONCILIATION_LAG_BUFFER_HOURS = 'reconciliation.lag_buffer_hours'
/**
 * C9 — how many occupants of a region's `default` unit may NOT be direct reports
 * of its owner before the region page warns.
 *
 * A count, not a ratio, and deliberately a DIAL: the default unit's expected
 * population is "the owner's own direct reports", so the tolerance is a span of
 * control, and span of control differs by organisation. Anything hard-coded here
 * would be one tenant's shape shipped as a product constant. mig 0112 seeds the
 * platform baseline; a region admin overrides it for their own region through the
 * same PUT as every other dial.
 */
export const GOV_DEFAULT_UNIT_WARN_THRESHOLD = 'placement.default_unit_warn_threshold'
/**
 * A4 (docs/design/project-requests/00-spec.md): 1 = a PMO-list holder may create
 * projects only in the region they are currently placed in; 0 = any region.
 * A switch, and platform-scoped only (the two sets below).
 */
export const GOV_PROJECTS_PM_OWN_REGION_ONLY = 'projects.pm_own_region_only'

export type GovernanceSettingKey =
  | typeof GOV_VELOCITY_SPIKE_THRESHOLD
  | typeof GOV_RECONCILIATION_GAP_THRESHOLD
  | typeof GOV_RECONCILIATION_EPSILON_USD
  | typeof GOV_RECONCILIATION_LAG_BUFFER_HOURS
  | typeof GOV_DEFAULT_UNIT_WARN_THRESHOLD
  | typeof GOV_PROJECTS_PM_OWN_REGION_ONLY

/*
 * Per-key value bounds, enforced by the admin PUT (the DB stores any
 * NUMERIC — sanity lives app-side, like the lifecycle Body schema's
 * min/max). `minExclusive` marks (min, max] vs [min, max].
 */
export const GOVERNANCE_SETTING_BOUNDS: Record<
  GovernanceSettingKey,
  { min: number; max: number; minExclusive: boolean }
> = {
  [GOV_VELOCITY_SPIKE_THRESHOLD]: { min: 0, max: 10, minExclusive: true },
  [GOV_RECONCILIATION_GAP_THRESHOLD]: { min: 0, max: 1, minExclusive: true },
  [GOV_RECONCILIATION_EPSILON_USD]: { min: 0, max: 100, minExclusive: true },
  [GOV_RECONCILIATION_LAG_BUFFER_HOURS]: { min: 0, max: 720, minExclusive: false },
  // A whole-person count. 0 is admissible and means "warn as soon as anyone in
  // the default unit does not report to its owner" — a legitimate posture for a
  // small region, not a misconfiguration, so the bound is inclusive.
  [GOV_DEFAULT_UNIT_WARN_THRESHOLD]: { min: 0, max: 10_000, minExclusive: false },
  [GOV_PROJECTS_PM_OWN_REGION_ONLY]: { min: 0, max: 1, minExclusive: false },
}

/** Keys that hold exactly 0 or 1, edited as a yes/no switch. */
export const GOVERNANCE_SWITCH_KEYS: readonly GovernanceSettingKey[] = [GOV_PROJECTS_PM_OWN_REGION_ONLY]

/** Keys with a platform row only: the PUT refuses a region override. */
export const GOVERNANCE_PLATFORM_ONLY_KEYS: readonly GovernanceSettingKey[] = [GOV_PROJECTS_PM_OWN_REGION_ONLY]

export const GOVERNANCE_SETTING_KEYS = Object.keys(
  GOVERNANCE_SETTING_BOUNDS,
) as GovernanceSettingKey[]

export function isGovernanceSettingKey(key: string): key is GovernanceSettingKey {
  return key in GOVERNANCE_SETTING_BOUNDS
}

interface SettingRow extends Record<string, unknown> {
  key: string
  scope_type: string
  scope_id: string | null
  value_numeric: string
}

/**
 * Resolve one dial for a region (region override wins over platform).
 * Throws when no row exists — the migration seeds platform rows, so absence
 * means a broken deploy, not a default to silently invent.
 */
export async function resolveGovernanceSetting(
  db: Db,
  key: string,
  regionId?: string | null,
): Promise<number> {
  const resolved = await resolveGovernanceSettings(db, [key], regionId)
  return resolved[key]!
}

/**
 * Batched variant: resolve several dials in ONE query. Same precedence and
 * fail-loud contract per key.
 */
export async function resolveGovernanceSettings(
  db: Db,
  keys: string[],
  regionId?: string | null,
): Promise<Record<string, number>> {
  // NB: drizzle renders an array param as a parenthesised list — IN, not ANY.
  const rows = await db.execute<SettingRow>(sql`
    SELECT key, scope_type, scope_id::text AS scope_id, value_numeric::text AS value_numeric
      FROM governance_setting
     WHERE key IN ${keys}
       AND (scope_type = 'platform'
            OR (scope_type = 'region' AND scope_id = ${regionId ?? null}::uuid))
  `)
  const resolved: Record<string, number> = {}
  for (const r of rows) {
    // Region rows win: never let a later platform row clobber an override.
    if (r.scope_type === 'region' || !(r.key in resolved)) {
      resolved[r.key] = Number(r.value_numeric)
    }
  }
  const missing = keys.filter((k) => !(k in resolved))
  if (missing.length > 0) {
    throw new Error(
      `governance_setting has no platform row for key(s) ${missing.join(', ')} — ` +
        'migration 0049 seeds these, so this is a broken deploy, not a config gap',
    )
  }
  return resolved
}

/**
 * Snapshot platform + every region override for ONE key and return a pure
 * resolver. Use in region-spanning batch passes (velocity-watch resolves per
 * teammate's region) to avoid a query per row.
 */
export async function loadGovernanceSettingResolver(
  db: Db,
  key: string,
): Promise<(regionId: string | null) => number> {
  const rows = await db.execute<SettingRow>(sql`
    SELECT key, scope_type, scope_id::text AS scope_id, value_numeric::text AS value_numeric
      FROM governance_setting
     WHERE key = ${key}
  `)
  let platform: number | null = null
  const byRegion = new Map<string, number>()
  for (const r of rows) {
    if (r.scope_type === 'platform') platform = Number(r.value_numeric)
    else if (r.scope_id) byRegion.set(r.scope_id, Number(r.value_numeric))
  }
  if (platform === null) {
    throw new Error(
      `governance_setting has no platform row for key '${key}' — ` +
        'migration 0049 seeds it, so this is a broken deploy, not a config gap',
    )
  }
  const platformValue = platform
  return (regionId) => (regionId ? byRegion.get(regionId) ?? platformValue : platformValue)
}
