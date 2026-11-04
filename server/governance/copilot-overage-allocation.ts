/*
 * copilot-overage-allocation — compute + persist the per-cost-owning-unit
 * distribution of one (enterprise, month)'s PAID pooled Copilot overage
 * (ADR-0011 D10, design §5.4). `copilot_pool_bill.overage_net_usd` is the
 * bill-anchored source of record (read straight off the enterprise billing
 * usage report by server/workers/copilot-pool-bill.ts) — this module NEVER
 * changes that figure. It only DISTRIBUTES it: every policy conserves
 * `Σ allocated_usd == overage_net_usd` exactly, asserted by a read-back after
 * persistence, never merely in memory.
 *
 * GRAIN: (provider_enterprise_id, month, cost_owning_unit_id) — "recipient" is
 * the seat-holder's cost-owning unit (D10: "user weights summed to the
 * seat-holder's cost-owning unit"), NOT the org the seat happens to be
 * licensed under. This is the entire point of the mechanism: a single shared
 * GitHub org's overage can now be split across every practice/CoU that
 * actually consumed, rather than landing wholesale on the one CoU the org's
 * `provider_org.cost_owning_unit_id` happens to map to (the coarser, existing
 * org-homed figure `v_finance_copilot_pool_chargeback` falls back to when no
 * allocation has been computed yet — see the migration rewriting that view).
 *
 * WHICH UNIT: the Business Unit the teammate sits in WHEN THIS RUNS
 * (v_org_unit_cost_owner of teammate.org_unit_id; NULL when there is none),
 * never the rows' stamped placement (current-org-lens §3.3). The split is
 * persisted, so a month outside copilot-pool-bill's default window keeps its
 * homing until an operator re-runs that month.
 *
 * LOCKING + THE MONTH'S SNAPSHOT (design §8.4): every persist call acquires the
 * `reportingSnapshot` advisory lock (keyed on the month) THEN the
 * `copilotOverageAllocation` lock (keyed on `${enterpriseId}:${month}`) —
 * the SAME lock the copilot-pool-bill worker's bill rewrite takes — before
 * touching any row, so a concurrent snapshot close or bill refresh can never
 * race a write here. A month that has been CLOSED is not special: the provider
 * is the record of truth, its corrected bill lands, and the difference against
 * that month's snapshot surfaces as a delta.
 *
 * WEIGHT SOURCES (never actual_spend's copilot rows — v_teammate_usage_daily
 * itself excludes those in favour of reconciliation_record for exactly this
 * reason, mig 0101 PART 3):
 *   - consumption-share / excess-share / excess-equal: per-teammate Copilot
 *     USAGE for the month, from `reconciliation_record` (scope='teammate',
 *     provider='github') — the same gross source v_teammate_usage_daily's
 *     copilot branch reads (mig 0038/0086), so the weight is the same number
 *     already shown to users as "usage". Governance-filtered so an
 *     exempt/tracked org's usage never dilutes or claims a chargeable share.
 *   - seat-share: the roster of ACTIVE SEATS this month, from
 *     `actual_spend` WHERE category='seat-license' (copilot-bill.ts's
 *     whole-month showback row — written for EVERY seat regardless of usage,
 *     which is exactly the roster seat-share needs and reconciliation_record,
 *     usage-driven, cannot provide).
 *
 * VERIFIED LOGINS ONLY. A weight homes on a Business Unit only when its GitHub
 * login has a directory-sync or admin binding (this enterprise's lane of
 * teammate_identity_map) to the same teammate. A login known only through the
 * self-service lane (POST /me/identities, unverified) still shows as that
 * person's usage, but its weight goes to the unallocated (NULL) bucket: anyone
 * can claim a login, and a claim must not move a billed overage between units.
 * An admin bind (map.post) verifies it and the next recompute homes it.
 */
import { sql, type SQL } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { advisoryXactLock } from '../db/advisory-lock'
import { recordAuditEvent, type AuditActor } from '../db/audit'
import { allocateCents } from '../../shared/usage/allocate-cents'
import type { OverageAllocationPolicy } from '../reconciliation/provider-validation'
import {
  loadGovernanceResolutionContext,
  resolveGithubVerdict,
  type GovernanceResolutionContext,
} from './verdict'

type Tx = PostgresJsDatabase<Record<string, unknown>>

function normaliseMonth(month: string): string {
  const m = /^(\d{4})-(\d{2})(?:-01)?$/.exec(month)
  if (!m) throw new Error(`copilot-overage-allocation: month must be YYYY-MM or YYYY-MM-01, got '${month}'`)
  return `${m[1]}-${m[2]}-01`
}


export interface CopilotOverageAllocationRecipient {
  costOwningUnitId: string | null
  weight: number
  allocatedUsd: number
}

export interface PersistCopilotOverageAllocationResult {
  policy: OverageAllocationPolicy
  overageNetUsd: number
  recipients: CopilotOverageAllocationRecipient[]
  /** true when overageNetUsd rounds to $0 — the month's stale allocation (if
   *  any, from a since-corrected bill pull) is cleared and NOTHING is
   *  written, matching D10 rule 1 ("no pool overage, no charge beyond the
   *  seat" — there is nothing to distribute). */
  skippedZeroOverage: boolean
  /** true when a single unallocated (NULL cost_owning_unit_id) row carries
   *  the WHOLE overage net because total weight was zero (design §5.4: a
   *  paid overage with no attributable usage — a coverage gap, never
   *  dropped or spread). */
  unallocated: boolean
}

interface WeightArgs {
  providerEnterpriseId: string
  enterpriseExternalId: string
  month: string
  policy: OverageAllocationPolicy
  perSeatShareUsd: number
  governanceContext: GovernanceResolutionContext
}

/** Sum per-teammate weight into its cost-owning-unit bucket (NULL = unhomed —
 *  a legitimate bucket, not an error; it lands in the same unallocated row
 *  semantics as a zero-total-weight month, just partially). */
function makeAccumulator() {
  const weights = new Map<string | null, number>()
  return {
    add: (cou: string | null, w: number) => {
      if (w === 0) return
      weights.set(cou, (weights.get(cou) ?? 0) + w)
    },
    weights,
  }
}

/** TRUE when `login` is bound to `teammateId` in this enterprise's directory/admin lane. */
function enterpriseBoundSql(providerEnterpriseId: string, login: SQL, teammateId: SQL): SQL {
  return sql`EXISTS (
    SELECT 1 FROM teammate_identity_map m
    JOIN provider_enterprise pe ON pe.id = ${providerEnterpriseId}::uuid
    WHERE m.system = 'github'
      AND lower(m.enterprise_slug) = lower(pe.external_id)
      AND lower(m.identifier) = lower(${login})
      AND m.teammate_id = ${teammateId})`
}

async function computeCopilotOverageAllocationWeights(tx: Tx, args: WeightArgs): Promise<Map<string | null, number>> {
  const { add, weights } = makeAccumulator()

  if (args.policy === 'seat-share') {
    // The active-seat roster (weight = 1 per seat-holding teammate), NOT
    // usage-weighted — seat-share treats the pool as a shared facility cost.
    // DISTINCT ON collapses a teammate holding seats in >1 org under this
    // enterprise to one seat; its login decides verification.
    const rows = await tx.execute<{ teammate_id: string; cost_owning_unit_id: string | null }>(sql`
      SELECT DISTINCT ON (s.teammate_id) s.teammate_id::text AS teammate_id,
             CASE WHEN ${enterpriseBoundSql(args.providerEnterpriseId, sql`s.raw_payload->>'login'`, sql`s.teammate_id`)}
                  THEN c.cost_owning_unit_id::text END AS cost_owning_unit_id
      FROM actual_spend s
      JOIN teammate t ON t.id = s.teammate_id
      LEFT JOIN v_org_unit_cost_owner c ON c.org_unit_id = t.org_unit_id
      WHERE s.category = 'seat-license'
        AND s.provider_enterprise_id = ${args.providerEnterpriseId}::uuid
        AND date_trunc('month', s.date)::date = ${args.month}::date
        AND NOT s.chargeback_exempt
      ORDER BY s.teammate_id, s.pulled_at DESC
    `)
    for (const r of rows) add(r.cost_owning_unit_id, 1)
    return weights
  }

  // consumption-share / excess-share / excess-equal: per-(teammate,
  // cost-owning-unit, license_org, category) Copilot usage for the month,
  // deduplicated exactly like v_teammate_usage_daily's copilot branch (mig
  // 0086/0101) — one row per logical (provider, enterprise_ref, period_date,
  // category, scope, teammate) key, highest-precedence non-terminal status,
  // newest computed_at as tiebreak.
  //
  // Homed on the Business Unit of the teammate's CURRENT unit (see header), NULL
  // when that unit has no cost-owning ancestor. `raw` is one adapter line, or an array of
  // them when several lines merged on the conflict key: the row is verified only
  // when every login in it is enterprise-bound. So a teammate with one bound and
  // one self-only login on the same day is wholly Unallocated until an admin
  // binds the second; totals still sum to the bill.
  const rows = await tx.execute<{
    teammate_id: string
    cost_owning_unit_id: string | null
    license_org: string | null
    category: string
    actual_usd: string
  }>(sql`
    SELECT teammate_id::text AS teammate_id, cost_owning_unit_id::text AS cost_owning_unit_id,
           license_org, category, SUM(actual_usd)::text AS actual_usd
    FROM (
      SELECT dedup.teammate_id, dedup.license_org, dedup.category, dedup.actual_usd,
             CASE WHEN NOT EXISTS (
                    SELECT 1
                    FROM jsonb_array_elements(
                      CASE jsonb_typeof(dedup.raw) WHEN 'array' THEN dedup.raw ELSE jsonb_build_array(dedup.raw) END
                    ) AS line(v)
                    WHERE NOT ${enterpriseBoundSql(args.providerEnterpriseId, sql`line.v->>'login'`, sql`dedup.teammate_id`)}
                  )
                  THEN c.cost_owning_unit_id END AS cost_owning_unit_id
      FROM (
        SELECT DISTINCT ON (r.provider, r.enterprise_ref, r.period_date, r.category, r.scope, r.teammate_id)
          r.teammate_id, r.license_org, r.category, r.actual_usd, r.raw
        FROM reconciliation_record r
        WHERE r.provider = 'github' AND r.scope = 'teammate' AND r.teammate_id IS NOT NULL
          AND r.provider_enterprise_id = ${args.providerEnterpriseId}::uuid
          AND date_trunc('month', r.period_date)::date = ${args.month}::date
          AND r.status NOT IN ('rejected', 'superseded')
        ORDER BY r.provider, r.enterprise_ref, r.period_date, r.category, r.scope, r.teammate_id,
                 CASE r.status WHEN 'applied' THEN 0 WHEN 'proposed' THEN 1 ELSE 2 END, r.computed_at DESC
      ) dedup
      JOIN teammate t ON t.id = dedup.teammate_id
      LEFT JOIN v_org_unit_cost_owner c ON c.org_unit_id = t.org_unit_id
    ) homed
    GROUP BY teammate_id, cost_owning_unit_id, license_org, category
  `)

  for (const r of rows) {
    const verdict = resolveGithubVerdict(args.governanceContext, {
      providerEnterpriseId: args.providerEnterpriseId,
      enterpriseSlug: args.enterpriseExternalId,
      licenseOrg: r.license_org,
    })
    if (verdict.exempt) continue

    const usage = Number(r.actual_usd)
    if (args.policy === 'consumption-share') {
      add(r.cost_owning_unit_id, usage)
    } else if (args.policy === 'excess-share') {
      add(r.cost_owning_unit_id, Math.max(0, usage - args.perSeatShareUsd))
    } else {
      // excess-equal: equal weight across every teammate whose usage exceeds
      // the blended per-seat share.
      if (usage > args.perSeatShareUsd) add(r.cost_owning_unit_id, 1)
    }
  }
  return weights
}

export interface PersistCopilotOverageAllocationArgs {
  providerEnterpriseId: string
  /** The enterprise's external slug — needed for the legacy (pre-cutover)
   *  governance-verdict fallback path. */
  enterpriseExternalId: string
  /** 'YYYY-MM' or 'YYYY-MM-01'. */
  month: string
  /** Pre-loaded governance context — avoids a reload per-enterprise when the
   *  caller (the copilot-pool-bill worker) already loaded one for its own run. */
  governanceContext?: GovernanceResolutionContext
  actorTeammateId?: string | null
  actorSystem?: string | null
  ipAddress?: string | null
  userAgent?: string | null
}

/**
 * Compute and persist the overage allocation for ONE (enterprise, month),
 * idempotent delete-and-replace. MUST be called with `tx` already positioned
 * to run further statements (a transaction) — the reporting-snapshot +
 * enterprise/month advisory locks are acquired INSIDE this call, so it is
 * safe to call directly from a bare `db.transaction(...)` callback.
 */
export async function persistCopilotOverageAllocation(
  tx: Tx,
  args: PersistCopilotOverageAllocationArgs,
): Promise<PersistCopilotOverageAllocationResult> {
  const month = normaliseMonth(args.month)

  // Ascending LOCK_NAMESPACE order (reportingSnapshot=4 before
  // copilotOverageAllocation=6) — mirrors reporting-snapshot.ts's own contract.
  await tx.execute(advisoryXactLock('reportingSnapshot', month))
  await tx.execute(advisoryXactLock('copilotOverageAllocation', `${args.providerEnterpriseId}:${month}`))

  /*
   * NO CLOSED-MONTH THROW. Recomputing an allocation for a closed month is now
   * ordinary: the month's snapshot records what was reported, and any movement
   * against it surfaces as a delta rather than being prevented.
   */
  const [entRows, billRows] = await Promise.all([
    tx.execute<{ policy: OverageAllocationPolicy }>(sql`
      SELECT overage_allocation_policy AS policy FROM provider_enterprise WHERE id = ${args.providerEnterpriseId}::uuid
    `),
    tx.execute<{ overage: string; included: string; seats: string }>(sql`
      SELECT COALESCE(SUM(overage_net_usd), 0)::text AS overage,
             COALESCE(SUM(included_allowance_usd), 0)::text AS included,
             COALESCE(SUM(seats), 0)::text AS seats
      FROM copilot_pool_bill WHERE provider_enterprise_id = ${args.providerEnterpriseId}::uuid AND month = ${month}::date
    `),
  ])
  const policy = entRows[0]?.policy ?? 'consumption-share'
  const overageNetUsd = Number(billRows[0]?.overage ?? '0')
  const includedAllowanceUsd = Number(billRows[0]?.included ?? '0')
  const seats = Number(billRows[0]?.seats ?? '0')
  const perSeatShareUsd = seats > 0 ? includedAllowanceUsd / seats : 0

  // Idempotent delete-and-replace, ALWAYS — even a $0 recompute must clear a
  // stale prior allocation (e.g. a bill correction that removed the overage
  // entirely), never leave orphaned rows behind.
  const deleted = await tx.execute<{ id: string }>(sql`
    DELETE FROM copilot_overage_allocation
    WHERE provider_enterprise_id = ${args.providerEnterpriseId}::uuid AND month = ${month}::date
    RETURNING id::text AS id
  `)

  const overageNetCents = Math.round(overageNetUsd * 100)
  if (overageNetCents <= 0) {
    if (deleted.length > 0) {
      const auditActor: AuditActor = args.actorTeammateId
        ? { actorTeammateId: args.actorTeammateId }
        : { actorSystem: args.actorSystem ?? 'worker:copilot-pool-bill' }
      await recordAuditEvent(tx, {
        ...auditActor,
        eventType: 'copilot-overage-allocation-computed',
        subjectKind: 'provider-enterprise',
        subjectId: args.providerEnterpriseId,
        payload: {
          month,
          policy,
          overage_net_usd: 0,
          recipients: 0,
          cleared_recipients: deleted.length,
          unallocated: false,
        },
        ipAddress: args.ipAddress,
        userAgent: args.userAgent,
      })
    }
    return { policy, overageNetUsd: 0, recipients: [], skippedZeroOverage: true, unallocated: false }
  }

  const govCtx = args.governanceContext ?? (await loadGovernanceResolutionContext(tx))
  const weights = await computeCopilotOverageAllocationWeights(tx, {
    providerEnterpriseId: args.providerEnterpriseId,
    enterpriseExternalId: args.enterpriseExternalId,
    month,
    policy,
    perSeatShareUsd,
    governanceContext: govCtx,
  })

  const totalWeight = [...weights.values()].reduce((a, b) => a + b, 0)
  let recipients: CopilotOverageAllocationRecipient[]
  let unallocated = false
  if (totalWeight <= 0) {
    /*
     * Design §5.4: a paid overage with zero attributable weight (a coverage
     * gap) writes ONE explicit unallocated row for the FULL net — never
     * dropped, never spread across a weightless set.
     *
     * Routed through allocateCents like the weighted branch below, and that is
     * load-bearing rather than symmetry for its own sake. This branch used to
     * write the raw `overageNetUsd`, which the INSERT then rendered with
     * toFixed(2) — while the conservation check further down compares against
     * Math.round(overageNetUsd * 100). Those two disagree on a net that lands
     * on an exact half-cent: 1000.005 renders as "1000.00" (1000.005 is the
     * double just above 1000.005, but toFixed reads its exact decimal
     * expansion and truncates) while Math.round(1000.005 * 100) is 100001.
     * The check then threw `conservation broken`, rolling back the whole
     * (enterprise, month) bill write — permanently, since every retry
     * recomputes the same net, and visibly only as a consola.warn.
     *
     * allocateCents rounds the TOTAL once with the same Math.round(x * 100)
     * the check uses, so the two can no longer drift apart.
     */
    recipients = [
      { costOwningUnitId: null, weight: 0, allocatedUsd: allocateCents([overageNetUsd], overageNetUsd)[0]! },
    ]
    unallocated = true
  } else {
    // Deterministic, stable tie-break (§9 R1-M7 "deterministic remainder
    // assignment... ties broken by a stable key"): order recipients by
    // cost_owning_unit_id (NULL sorted last) BEFORE calling allocateCents, so
    // its largest-remainder tie-break (a stable array-order sort) always
    // resolves identically on a rerun with unchanged inputs.
    const ordered = [...weights.entries()].sort(([a], [b]) => {
      if (a === b) return 0
      if (a === null) return 1
      if (b === null) return -1
      return a < b ? -1 : 1
    })
    // allocateCents fixes ROUNDING drift on already-proportional dollar amounts — it does
    // NOT itself normalise raw weights against a total. Compute each recipient's exact
    // proportional share (weight_i / Σweight × overageNet) FIRST, then hand those shares
    // to allocateCents purely for the cent-exact largest-remainder rounding.
    const parts = ordered.map(([, w]) => (w / totalWeight) * overageNetUsd)
    const allocated = allocateCents(parts, overageNetUsd)
    recipients = ordered.map(([costOwningUnitId, weight], i) => ({
      costOwningUnitId,
      weight,
      allocatedUsd: allocated[i]!,
    }))
  }

  const values = recipients.map(
    (r) =>
      sql`(${args.providerEnterpriseId}::uuid, ${month}::date, ${r.costOwningUnitId}::uuid, ${policy}, ${r.weight.toFixed(6)}::numeric, ${r.allocatedUsd.toFixed(2)}::numeric, ${overageNetUsd.toFixed(6)}::numeric)`,
  )
  await tx.execute(sql`
    INSERT INTO copilot_overage_allocation
      (provider_enterprise_id, month, cost_owning_unit_id, policy, weight, allocated_usd, overage_net_usd)
    VALUES ${sql.join(values, sql`, `)}
  `)

  // Read back and assert conservation TO THE CENT (design §5.4/§9 R1-M7) — a
  // defensive check on the just-written, in-this-transaction state, not a
  // trust exercise on the numbers computed above.
  const check = await tx.execute<{ s: string }>(sql`
    SELECT COALESCE(SUM(allocated_usd), 0)::text AS s FROM copilot_overage_allocation
    WHERE provider_enterprise_id = ${args.providerEnterpriseId}::uuid AND month = ${month}::date
  `)
  const allocatedTotalCents = Math.round(Number(check[0]?.s ?? '0') * 100)
  if (allocatedTotalCents !== overageNetCents) {
    throw new Error(
      `copilot-overage-allocation: conservation broken for enterprise ${args.providerEnterpriseId} month ${month} — allocated ${allocatedTotalCents}c != overage net ${overageNetCents}c`,
    )
  }

  const auditActor: AuditActor = args.actorTeammateId
    ? { actorTeammateId: args.actorTeammateId }
    : { actorSystem: args.actorSystem ?? 'worker:copilot-pool-bill' }
  await recordAuditEvent(tx, {
    ...auditActor,
    eventType: 'copilot-overage-allocation-computed',
    subjectKind: 'provider-enterprise',
    subjectId: args.providerEnterpriseId,
    payload: {
      month,
      policy,
      overage_net_usd: overageNetUsd,
      recipients: recipients.length,
      unallocated,
    },
    ipAddress: args.ipAddress,
    userAgent: args.userAgent,
  })

  return { policy, overageNetUsd, recipients, skippedZeroOverage: false, unallocated }
}
