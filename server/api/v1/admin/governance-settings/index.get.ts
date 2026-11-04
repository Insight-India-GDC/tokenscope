/*
 * GET /api/v1/admin/governance-settings — the governance dials (mig 0049) as
 * the admin editor sees them: every platform baseline plus the region
 * overrides. A region admin sees only their OWN region's overrides (the
 * platform baseline is what they'd override); platform-admin
 * see every region's.
 */
import { defineEventHandler } from 'h3'
import { sql } from 'drizzle-orm'
import { requireRole } from '../../../../auth/rbac'
import { withRequestRls } from '../../../../db/request-rls'
import { isPlatformAdmin } from '../../../../../shared/auth/roles'
import {
  GOVERNANCE_PLATFORM_ONLY_KEYS,
  GOVERNANCE_SETTING_KEYS,
  GOVERNANCE_SWITCH_KEYS,
} from '../../../../utils/governance-settings'

interface PlatformRow extends Record<string, unknown> {
  key: string
  value_numeric: string
  updated_at: string
}
interface OverrideRow extends Record<string, unknown> {
  key: string
  region_id: string
  region_code: string
  value_numeric: string
  updated_at: string
}

export default defineEventHandler(async (event) => {
  const caller = await requireRole(event, 'admin')
  const regionUnbounded = isPlatformAdmin(caller.role)

  return await withRequestRls(event, async (tx) => {
    const platform = await tx.execute<PlatformRow>(sql`
      SELECT key, value_numeric::text AS value_numeric, updated_at::text AS updated_at
        FROM governance_setting
       WHERE scope_type = 'platform'
       ORDER BY key
    `)
    // Region admins are clamped to their own region app-side (RLS is inert at
    // runtime — owner connection), matching requireRegionScope's posture.
    const overrides = await tx.execute<OverrideRow>(sql`
      SELECT gs.key,
             gs.scope_id::text AS region_id,
             r.code AS region_code,
             gs.value_numeric::text AS value_numeric,
             gs.updated_at::text AS updated_at
        FROM governance_setting gs
        JOIN region r ON r.id = gs.scope_id
       WHERE gs.scope_type = 'region'
         AND (${regionUnbounded} OR gs.scope_id = ${caller.regionId}::uuid)
       ORDER BY r.code, gs.key
    `)
    return {
      keys: GOVERNANCE_SETTING_KEYS,
      switch_keys: GOVERNANCE_SWITCH_KEYS,
      platform_only_keys: GOVERNANCE_PLATFORM_ONLY_KEYS,
      platform: [...platform].map((r) => ({
        key: r.key,
        value: Number(r.value_numeric),
        updated_at: r.updated_at,
      })),
      region_overrides: [...overrides].map((r) => ({
        key: r.key,
        region_id: r.region_id,
        region_code: r.region_code,
        value: Number(r.value_numeric),
        updated_at: r.updated_at,
      })),
    }
  })
})
