/*
 * Reconciliation engine — platform-agnostic. Consumes ReconciledLine[] from any
 * adapter and writes signed deltas to reconciliation_record (status='proposed').
 * Never branches on provider. See docs/design/reconciliation-engine.md §8.
 *
 * Split: `classifyDelta` is a PURE function (unit-tested, no DB); `runReconcileEngine`
 * does the DB I/O (fetch the OTel operand, resolve dimensions, upsert records).
 *
 * Gating: every row is written `status='proposed'`. Nothing enters effective spend
 * until applied (mode=propose ramp, §11) — so the engine is side-effect-safe to run.
 */
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { sql } from 'drizzle-orm'
import type * as schema from '../../drizzle/schema'
import type { ReconciledLine, ReconcileResult, ReconcileCategory } from './types'
import { createGovernanceKeyCache, resolveGovernanceKeyForLine } from './governance-keys'

type Db = PostgresJsDatabase<typeof schema>

export interface ReconcileEngineOptions {
  /** Injected for deterministic tests; defaults to wall-clock. */
  now?: Date
  /** Matched-band floor in USD: |delta| <= epsilon -> 'matched' (rounding noise). */
  epsilonUsd?: number
  /** Walk-back lag buffer (hours): within this window -> lag_state='within_buffer'. */
  lagBufferHours?: number
  /** worker_run.id of the dispatch that wrote these records (stamped onto run_id for
   * the runs<->records drill-down). Null when run outside a worker dispatch. */
  runId?: string | null
}

// Fallbacks for direct/test callers only — the live driver (reconciliation-sync)
// injects the 'reconciliation.epsilon_usd' / 'reconciliation.lag_buffer_hours'
// governance dials (mig 0049, seeded to these same values) as options.
const DEFAULT_EPSILON_USD = 0.01
const DEFAULT_LAG_BUFFER_HOURS = 48

/* Categories whose spend OTel never emits -> the OTel operand is always 0. */
const OTEL_INVISIBLE: ReadonlySet<ReconcileCategory> = new Set<ReconcileCategory>([
  'copilot_coding_agent',
  'web_search',
  'code_execution',
  'priority_tier',
])

/*
 * Per-user categories -> the tool lane the category belongs to. For the OTel-
 * reconcilable categories this is the attribution_record `tool` to sum;
 * copilot_coding_agent is OTEL_INVISIBLE (ingest_only, above), so its operand
 * query is never reached — the mapping records its §A usage-lane binding
 * ('copilot-agent', the v_teammate_usage_daily lane id, mig 0086) so any
 * consult of this map carries the right tool. Display-only: never taggable,
 * never OTel-joined.
 */
const CATEGORY_TOOL: Partial<Record<ReconcileCategory, string>> = {
  model_tokens: 'claude-code',
  copilot_interactive: 'copilot-cli',
  copilot_coding_agent: 'copilot-agent',
}

export type Disposition = 'untagged' | 'walk_back' | 'matched' | 'no_install' | 'ingest_only'

export interface Classification {
  disposition: Disposition
  lagState: 'within_buffer' | 'settled' | null
  deltaUsd: number
}

function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6
}

/** End of a UTC day (next midnight) for a YYYY-MM-DD string. */
function periodEndUtc(periodDate: string): Date {
  const end = new Date(`${periodDate}T00:00:00.000Z`)
  end.setUTCDate(end.getUTCDate() + 1)
  return end
}

function hoursSince(from: Date, now: Date): number {
  return (now.getTime() - from.getTime()) / 3_600_000
}

/*
 * Pure delta classification (no DB).
 *   over  (delta > +eps):  real untagged spend. 'no_install' when the subject has
 *                          a bill but zero OTel history (seat present, never emitted)
 *                          -> CC spill, no re-alert; otherwise 'untagged' (awaiting a
 *                          project-margin tag; the charge still lands at the CC).
 *   under (delta < -eps):  OTel over-counted -> 'walk_back', gated by the lag buffer.
 *   matched (|delta|<=eps): rounding noise.
 * Coding-agent is OTel-invisible -> always 'ingest_only' (never a walk-back).
 */
export function classifyDelta(args: {
  actualUsd: number
  otelUsd: number
  category: ReconcileCategory
  periodDate: string
  /** Does the subject have ANY attribution for this tool (lifetime)? */
  hasOtelHistory: boolean
  now: Date
  epsilonUsd: number
  lagBufferHours: number
}): Classification {
  const { actualUsd, otelUsd, category, periodDate, hasOtelHistory, now, epsilonUsd, lagBufferHours } =
    args
  const deltaUsd = round6(actualUsd - otelUsd)

  if (category === 'copilot_coding_agent') {
    return { disposition: 'ingest_only', lagState: null, deltaUsd }
  }

  if (Math.abs(deltaUsd) <= epsilonUsd) {
    return { disposition: 'matched', lagState: null, deltaUsd }
  }

  if (deltaUsd > 0) {
    // Org-grain invisible categories (web/code-exec) are real cost but never a
    // no_install (there is no per-seat install to be missing) -> 'untagged' at org scope.
    if (!hasOtelHistory && !OTEL_INVISIBLE.has(category)) {
      return { disposition: 'no_install', lagState: null, deltaUsd }
    }
    return { disposition: 'untagged', lagState: null, deltaUsd }
  }

  const settled = hoursSince(periodEndUtc(periodDate), now) >= lagBufferHours
  return { disposition: 'walk_back', lagState: settled ? 'settled' : 'within_buffer', deltaUsd }
}

interface TeammateDims {
  regionId: string
  orgUnitId: string
  /** The Business Unit of orgUnitId (v_org_unit_cost_owner); NULL when it has none. */
  costOwningUnitId: string | null
}

/*
 * ING-4: aggregate lines by the reconciliation_record conflict key before any
 * classification/upsert. Two adapter lines colliding on (provider, enterprise_ref,
 * period_date, category, scope, teammate) — e.g. two SKUs for one actor-day —
 * would otherwise REPLACE each other via DO UPDATE, and each would be classified
 * against the full-day OTel operand (nonsense deltas). Quantities and USD sum;
 * the rate is recomputed from the merged totals (falling back to the first
 * line's rate when the merged quantity is 0); raw keeps every contributor.
 */
function aggregateByConflictKey(lines: ReconciledLine[]): ReconciledLine[] {
  const merged = new Map<string, { line: ReconciledLine; raws: unknown[] }>()
  for (const line of lines) {
    const teammateKey = line.subject.kind === 'teammate' ? line.subject.teammateId : ''
    const key = [line.provider, line.enterpriseRef, line.periodDate, line.category, line.subject.kind, teammateKey].join('|')
    const prev = merged.get(key)
    if (!prev) {
      merged.set(key, { line: { ...line }, raws: [line.raw] })
      continue
    }
    const quantity = prev.line.unit.quantity + line.unit.quantity
    const amountUsd = Number(prev.line.amountUsd) + Number(line.amountUsd)
    prev.line = {
      ...prev.line,
      unit: { ...prev.line.unit, quantity },
      amountUsd: amountUsd.toFixed(6),
      rateUsdPerUnit: quantity > 0 ? (amountUsd / quantity).toFixed(8) : prev.line.rateUsdPerUnit,
    }
    prev.raws.push(line.raw)
  }
  return [...merged.values()].map(({ line, raws }) =>
    // Single-contributor groups keep the adapter's verbatim raw (no shape change).
    raws.length === 1 ? line : { ...line, raw: raws },
  )
}

/*
 * Reconcile a batch of normalised lines. For each line: compute the OTel operand
 * (USD, in the line's native unit), classify, resolve dimensions, upsert one
 * 'proposed' reconciliation_record. Idempotent per the open-record partial unique
 * index (re-pulls refresh the open row). Returns per-run counts.
 */
export async function runReconcileEngine(
  db: Db,
  lines: ReconciledLine[],
  opts: ReconcileEngineOptions = {},
): Promise<ReconcileResult> {
  const now = opts.now ?? new Date()
  const epsilonUsd = opts.epsilonUsd ?? DEFAULT_EPSILON_USD
  const lagBufferHours = opts.lagBufferHours ?? DEFAULT_LAG_BUFFER_HOURS
  const runId = opts.runId ?? null

  const result: ReconcileResult = {
    linesProcessed: 0,
    recordsWritten: 0,
    over: 0,
    under: 0,
    matched: 0,
    skippedUnresolved: 0,
    skippedInvalid: 0,
  }

  // Per-run caches keyed by teammateId.
  const dimsCache = new Map<string, TeammateDims | null>()
  const historyCache = new Map<string, boolean>() // key: `${teammateId}:${tool}`
  const govKeyCache = createGovernanceKeyCache()

  // Reject malformed adapter lines rather than writing NaN into a NOT NULL
  // numeric column (PG numeric accepts 'NaN') or letting an empty/whitespace
  // string (Number('')===0 passes isFinite, but ''::numeric throws) slip the
  // guard. amountUsd is always required; rate is the credit->USD multiplier.
  // Validated BEFORE the conflict-key aggregation so one garbage line can't
  // poison a whole merged actor-day group (ING-4).
  const validLines: ReconciledLine[] = []
  for (const line of lines) {
    result.linesProcessed += 1
    const usd = Number(line.amountUsd)
    const lineRate = Number(line.rateUsdPerUnit)
    if (
      String(line.amountUsd).trim() === '' ||
      !Number.isFinite(usd) ||
      (line.unit.unitType === 'ai-credits' &&
        (String(line.rateUsdPerUnit).trim() === '' || !Number.isFinite(lineRate)))
    ) {
      result.skippedInvalid += 1
      continue
    }
    validLines.push(line)
  }

  for (const line of aggregateByConflictKey(validLines)) {
    const scope = line.subject.kind === 'org' ? 'org' : 'teammate'
    const teammateId = line.subject.kind === 'teammate' ? line.subject.teammateId : null
    const tool = CATEGORY_TOOL[line.category]
    const actualUsd = Number(line.amountUsd)
    const rate = Number(line.rateUsdPerUnit)

    // OTel operand (USD). Invisible categories + org scope -> 0 (OTel never emits).
    let otelUsd = 0
    let hasOtelHistory = false
    if (scope === 'teammate' && teammateId && tool && !OTEL_INVISIBLE.has(line.category)) {
      // Lane-aware telemetry-only filter. The TOKEN lane excludes telemetry-only
      // rows (indicative/personal-sub tokens have no rate card, not billing-
      // reconcilable). The CREDIT lane must NOT: credit_qty is written ONLY on
      // Copilot rows, which are telemetry-only by design in v1 (promoted to tier-1
      // when the GitHub billing worker lands) — so excluding them would zero the
      // OTel credit operand and make every GitHub line falsely untagged.
      const telemetryFilter =
        line.unit.unitType === 'ai-credits' ? sql`` : sql`AND cost_basis <> 'telemetry-only'`
      const [agg] = await db.execute<{ usd: string; credits: string }>(sql`
        SELECT COALESCE(SUM(cost_usd), 0)::text AS usd,
               COALESCE(SUM(credit_qty), 0)::text AS credits
        FROM attribution_record
        WHERE teammate_id = ${teammateId}::uuid
          AND date_trunc('day', ts_event AT TIME ZONE 'UTC') = ${line.periodDate}::date
          AND tool = ${tool}
          ${telemetryFilter}
      `)
      otelUsd =
        line.unit.unitType === 'ai-credits'
          ? round6(Number(agg?.credits ?? 0) * rate)
          : Number(agg?.usd ?? 0)

      const historyKey = `${teammateId}:${tool}`
      if (historyCache.has(historyKey)) {
        hasOtelHistory = historyCache.get(historyKey)!
      } else {
        const [h] = await db.execute<{ has: boolean }>(sql`
          SELECT EXISTS(
            SELECT 1 FROM attribution_record WHERE teammate_id = ${teammateId}::uuid AND tool = ${tool}
          ) AS has
        `)
        hasOtelHistory = h?.has ?? false
        historyCache.set(historyKey, hasOtelHistory)
      }
    }

    const cls = classifyDelta({
      actualUsd,
      otelUsd,
      category: line.category,
      periodDate: line.periodDate,
      hasOtelHistory,
      now,
      epsilonUsd,
      lagBufferHours,
    })

    if (cls.disposition === 'matched') {
      result.matched += 1
      continue // no reconciliation_record for rounding-noise matches
    }

    // Resolve dimensions (teammate scope only). cost_owning_unit defaults to the
    // teammate's Business Unit: the nearest live cost-owning ancestor of their org
    // unit (v_org_unit_cost_owner), NULL when there is none. Never the raw unit,
    // which is often a team node (#450); every other writer stamps the same way.
    let regionId: string | null = null
    let orgUnitId: string | null = null
    let costOwningUnitId: string | null = line.subject.kind === 'org' ? line.subject.costOwningUnitId : null
    if (teammateId) {
      let dims = dimsCache.get(teammateId)
      if (dims === undefined) {
        const [row] = await db.execute<{ region_id: string; org_unit_id: string; cost_owning_unit_id: string | null }>(sql`
          SELECT t.region_id::text AS region_id, t.org_unit_id::text AS org_unit_id,
                 c.cost_owning_unit_id::text AS cost_owning_unit_id
          FROM teammate t
          LEFT JOIN v_org_unit_cost_owner c ON c.org_unit_id = t.org_unit_id
          WHERE t.id = ${teammateId}::uuid
        `)
        dims = row ? { regionId: row.region_id, orgUnitId: row.org_unit_id, costOwningUnitId: row.cost_owning_unit_id } : null
        dimsCache.set(teammateId, dims)
      }
      if (!dims) {
        // The adapter resolved a teammateId that no longer exists — skip + carry
        // forward rather than write a dangling FK (no silent guess).
        result.skippedUnresolved += 1
        continue
      }
      regionId = dims.regionId
      orgUnitId = dims.orgUnitId
      costOwningUnitId = costOwningUnitId ?? dims.costOwningUnitId
    }

    // Count only lines that actually produce a record (after the skip guards).
    if (cls.disposition === 'walk_back') result.under += 1
    else result.over += 1

    // Bind decimal values as ::numeric strings from the VALIDATED number (never the
    // raw adapter string, and never a JS-float round-trip). Binding the raw string
    // would let inputs the JS guard accepts as finite (e.g. '' / '  ' -> Number 0)
    // throw on PG ::numeric, and would desync actual_usd from the Number()-derived
    // delta. toFixed(6) of a finite number is always valid numeric input, and makes
    // actual_usd - otel == delta hold exactly at scale 6.
    const actualQtyParam = Number.isFinite(line.unit.quantity) ? line.unit.quantity.toFixed(6) : null
    const actualUsdParam = actualUsd.toFixed(6)
    const otelAttributedUsd = round6(otelUsd).toFixed(6)
    const deltaParam = cls.deltaUsd.toFixed(6)
    const rawJson = JSON.stringify(line.raw ?? null)

    // Governance key (mig 0103, design §4.0): resolved generically (branches
    // internally on line.provider so THIS function stays provider-agnostic).
    const govKey = await resolveGovernanceKeyForLine(db, govKeyCache, {
      provider: line.provider,
      enterpriseRef: line.enterpriseRef,
      licenseOrg: line.licenseOrg,
    })
    const govKeyStatus = govKey.providerOrgId || govKey.providerEnterpriseId ? 'resolved' : 'unresolved'

    await db.execute(sql`
      INSERT INTO reconciliation_record (
        provider, enterprise_ref, license_org, period_date, category, scope,
        teammate_id, region_id, org_unit_id, cost_owning_unit_id,
        actual_qty, actual_unit_type, actual_usd, otel_attributed_usd, delta_usd,
        spend_class, indicative_reason, disposition, lag_state, raw, status, run_id,
        provider_org_id, provider_enterprise_id, governance_key_status
      ) VALUES (
        ${line.provider}, ${line.enterpriseRef}, ${line.licenseOrg}, ${line.periodDate}::date,
        ${line.category}, ${scope},
        ${teammateId}, ${regionId}, ${orgUnitId}, ${costOwningUnitId},
        ${actualQtyParam}::numeric, ${line.unit.unitType}, ${actualUsdParam}::numeric,
        ${otelAttributedUsd}::numeric, ${deltaParam}::numeric,
        ${line.spendClass}, ${line.indicativeReason ?? null}, ${cls.disposition}, ${cls.lagState},
        ${rawJson}::jsonb, 'proposed', ${runId},
        ${govKey.providerOrgId}::uuid, ${govKey.providerEnterpriseId}::uuid, ${govKeyStatus}
      )
      ON CONFLICT (
        provider, enterprise_ref, period_date, category, scope,
        (COALESCE(teammate_id, '00000000-0000-0000-0000-000000000000'::uuid))
      ) WHERE status = 'proposed'
      DO UPDATE SET
        license_org = EXCLUDED.license_org,
        region_id = EXCLUDED.region_id,
        org_unit_id = EXCLUDED.org_unit_id,
        cost_owning_unit_id = EXCLUDED.cost_owning_unit_id,
        provider_org_id = EXCLUDED.provider_org_id,
        provider_enterprise_id = EXCLUDED.provider_enterprise_id,
        governance_key_status = EXCLUDED.governance_key_status,
        actual_qty = EXCLUDED.actual_qty,
        actual_unit_type = EXCLUDED.actual_unit_type,
        actual_usd = EXCLUDED.actual_usd,
        otel_attributed_usd = EXCLUDED.otel_attributed_usd,
        delta_usd = EXCLUDED.delta_usd,
        spend_class = EXCLUDED.spend_class,
        indicative_reason = EXCLUDED.indicative_reason,
        disposition = EXCLUDED.disposition,
        lag_state = EXCLUDED.lag_state,
        raw = EXCLUDED.raw,
        run_id = EXCLUDED.run_id,
        computed_at = now()
    `)
    result.recordsWritten += 1
  }

  return result
}
