/*
 * org-units DB helpers — shared validation used across the admin endpoints.
 *
 * assertOrgUnitInRegion centralises the repeated "the supplied org_unit_id
 * must be an org unit in this region" guard. Several endpoints duplicated the
 * same SELECT-then-422 shape:
 *   - projects.post.ts (cost-owning unit) — does NOT require active.
 *   - projects/[id].patch.ts (cost-owning unit) — requires active.
 *   - teammates.post.ts (placement org unit) — requires active.
 *   - users/[id]/org-unit.patch.ts (intra-region move) — requires active.
 *
 * Pass mustBeActive to add the `AND retired_at IS NULL` clause; each call site
 * keeps its own statusMessage so the existing error text is unchanged.
 */
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { sql } from 'drizzle-orm'
import { createError } from 'h3'
import { HOLDING_UNIT_TYPE } from '../../shared/placement/holding-nodes'

/**
 * A HOLDING node must never be cost-owning.
 *
 * WHY THE RULE EXISTS. The Unplaced row is where an admin lands when they notice
 * "290 teammates, region known, cost centre unknown", and Edit → "Cost-owning
 * unit" was the only control on that screen that moved the number. Ticking it
 * moves it to ZERO: the chargeback view homes spend on the nearest cost-owning
 * ANCESTOR, so the holding node would instantly become 290 people's cost centre.
 * Every unhomed dollar would report as homed, to a bucket nobody owns and no P&L
 * answers for, and nothing would have been fixed. That is worse than the defect —
 * a silent, plausible zero.
 *
 * WHAT ENFORCES IT, AND WHERE — precisely, because "must never" used to be a
 * claim about a helper that two HTTP handlers happened to call, which left raw
 * SQL, migrations, seeds and future workers unrestricted:
 *
 *   STRUCTURAL   `org_unit_holding_never_cost_owning`, a CHECK constraint
 *                (drizzle/migrations/0110_holding_node_never_cost_owning.sql).
 *                Every writer is bound by it, including ones that never call
 *                this function. That is the guarantee.
 *   API          this function, on both write doors (POST /admin/org-units and
 *                PATCH /admin/org-units/:id). It is NOT the guarantee — it is
 *                the legible sentence an admin needs, which a constraint
 *                violation cannot give them.
 *
 * Keyed on `unit_type`, the classification key
 * (shared/placement/holding-nodes.ts), so a second holding node minted under a
 * different code is covered by the same rule. The constraint keys on the same
 * value.
 */
export function assertHoldingNodeNotCostOwning(opts: {
  unitType: string
  isCostOwningUnit: boolean
}): void {
  if (opts.unitType !== HOLDING_UNIT_TYPE || !opts.isCostOwningUnit) return
  throw createError({
    statusCode: 422,
    statusMessage: 'holding nodes cannot be Business Units',
    data: {
      type: 'https://tokenscope.example.com/errors/unprocessable',
      title: 'Unprocessable',
      status: 422,
      detail:
        'The Unplaced holding node cannot be a Business Unit. Marking it one would home every unplaced teammate\'s spend to a Business Unit nobody owns — the unhomed figure would drop to zero without a single person being placed. Place the teammates into real Business Units instead.',
    },
  })
}

/**
 * An existing HOLDING node's `unit_type` is not a user-editable property.
 *
 * WHY THIS IS SEPARATE FROM THE RULE ABOVE. The cost-owning guard is evaluated
 * against the EFFECTIVE row a PATCH would produce, which is right for a body
 * that only sets the flag — and is exactly the bypass when the body sets BOTH:
 * `{ unit_type: 'team', is_cost_owning_unit: true }` on the holding node
 * produces an effective row that is no longer a holding node, so the guard waves
 * it through. Everyone stays on the node while it becomes a cost centre, which is
 * the precise outcome the guard exists to prevent — reached by relabelling rather
 * than by ticking the box. The two-step (retype, then enable) is the same bypass
 * spread over two requests, and this refusal kills both, because it is the first
 * step that both need.
 *
 * The reverse direction is deliberately NOT refused: turning a plain unit INTO a
 * holding node is a legitimate (if unusual) admin action, and the cost-owning
 * rule still binds the result.
 *
 * API-ONLY, and the constraint in mig 0110 does not extend to it: raw SQL can
 * still retype a holding node and then flip the flag. Say so rather than imply a
 * structural guarantee that is not there.
 */
export function assertHoldingNodeTypeImmutable(opts: {
  existingUnitType: string
  requestedUnitType?: string
}): void {
  if (opts.existingUnitType !== HOLDING_UNIT_TYPE) return
  if (opts.requestedUnitType === undefined || opts.requestedUnitType === opts.existingUnitType) return
  const detail =
    'The Unplaced holding node\'s type cannot be changed. Re-typing it is how it would stop counting as a holding node — the unplaced worklist, the region\'s unplaced count and the rule that keeps it out of chargeback all key on that type, and every teammate sitting on it would silently read as placed.'
  throw createError({
    statusCode: 422,
    statusMessage: 'holding node unit_type cannot be changed',
    data: {
      type: 'https://tokenscope.example.com/errors/unprocessable',
      title: 'Unprocessable',
      status: 422,
      detail,
    },
  })
}

export interface AssertOrgUnitInRegionOpts {
  orgUnitId: string
  regionId: string
  mustBeActive: boolean
  /**
   * Require `is_cost_owning_unit`. Off by default so every existing caller is
   * unchanged.
   *
   * The placement callers genuinely accept any active unit — people sit on plain
   * team nodes. The callers that write `cost_owning_unit_id` do not: that column
   * names a P&L node, and without this an admin could stamp historic attribution
   * onto an ordinary org node, which no report clamps on and no owner can see.
   */
  mustBeCostOwning?: boolean
  statusMessage?: string
  /*
   * Optional RFC-9457 Problem-Details body. Two call sites attach one (the
   * client reads `err.data.data.detail`); pass it through verbatim so the
   * surfaced message is unchanged after the dedup.
   */
  data?: Record<string, unknown>
}

export async function assertOrgUnitInRegion(
  tx: PostgresJsDatabase<Record<string, unknown>>,
  opts: AssertOrgUnitInRegionOpts,
): Promise<void> {
  const rows = await tx.execute<{ id: string }>(sql`
    SELECT id::text AS id FROM org_unit
    WHERE id = ${opts.orgUnitId}::uuid
      AND region_id = ${opts.regionId}::uuid
      ${opts.mustBeActive ? sql`AND retired_at IS NULL` : sql``}
      ${opts.mustBeCostOwning ? sql`AND is_cost_owning_unit = TRUE` : sql``}
    LIMIT 1
  `)
  if (![...rows][0]) {
    throw createError({
      statusCode: 422,
      statusMessage: opts.statusMessage ?? 'org_unit_id is not a valid org unit in this region',
      ...(opts.data ? { data: opts.data } : {}),
    })
  }
}
