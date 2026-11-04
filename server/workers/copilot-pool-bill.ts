/*
 * copilot-pool-bill worker — the POOLED Copilot chargeback writer. A READER, NOT a calculator.
 *
 * Intent: docs/design/provider-billing-attribution-model.md §B + reporting-consolidation
 * build-design §6 Wave 0. Supersedes the copilot-bill overage block (WRONG model #1) and the
 * seats×flat-rate license (WRONG model #2). For each reconciled github enterprise it READS the
 * enterprise billing usage report per (org, sku, month) and writes copilot_pool_bill (mig 0080):
 *
 *   - license_net_usd        = the "Copilot Enterprise" SKU NET (the seat license — READ, not
 *                              seats×rate). ABSENT for an org-month with usage → write NO
 *                              license figure (NULL), emit an alert, month reports UNSETTLED.
 *                              NEVER a flat-rate fallback — the enterprise's configured flat
 *                              seat price never feeds a chargeback figure.
 *   - overage_net_usd        = the AI-Credits / Cloud-Agent SKU NET (the pooled chargeable
 *                              authority; $0 when the pool covered all consumption). NEVER
 *                              Σusage − pool.
 *   - unclassified_net_usd   = the NET of Copilot-product lines matching NEITHER classifier
 *                              (mig 0085 / design D3). Booked to the visible
 *                              copilot-unclassified lane, alerted
 *                              ('copilot-bill-unclassified'), NEVER charged. Non-Copilot
 *                              products (spark_ai_credits, models_inference, …) are excluded
 *                              but COUNTED per product in the run result (ignoredProducts).
 *   - included_allowance_usd = the `included` discount line (the pool allowance; context).
 *   - usage_gross_usd        = gross AI-credit consumption (context / unsettled signal).
 *
 * HOMING (D-Homing = point-in-time via the org→CoU config map): each org's net lines home via
 * provider_org.cost_owning_unit_id (copied onto the row). An org-less bill line (or an org with
 * no provider_org registry row) folds into the SINGLE explicit unallocated enterprise-residual
 * row (provider_org_id NULL) — NEVER a pro-rata spread across orgs. Re-pointing an org's CoU
 * restates prior months (documented v1 limitation; point-in-time restatement is a Wave 5 item).
 *
 * EXEMPT orgs are excluded by the writer (canonical §B: "simply not written — no pool leak, no
 * allocation"); their usage still surfaces `indicative` via the usage lane (v_teammate_usage_daily
 * copilot branch) — never $0-hidden, never charged.
 *
 * Idempotent per (enterprise, month): the whole enterprise-month is DELETE+INSERT rewritten each
 * run (the §B "full recompute-and-replace" idiom), so a re-pull re-states the month cleanly.
 *
 * SCHEDULED: registered in server/workers/registry.ts AND scheduled in
 * infra/modules/worker-jobs.bicep — an unscheduled worker is a silent no-op (known trap).
 */
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { sql } from 'drizzle-orm'
import { consola } from 'consola'
import type * as schema from '../../drizzle/schema'
import { copilotChargebackEnabled } from '../reports/copilot-mode'
import {
  GithubCopilotClient,
  type GithubBillingUsageItem,
} from '../reconciliation/adapters/github-client'
import { GithubAppAuth } from '../reconciliation/adapters/github-app-auth'
import { resolveEnterpriseCredential } from '../reconciliation/credentials'
import { loadGovernanceResolutionContext, resolveGithubVerdict } from '../governance/verdict'
import { dispatchInbox } from '../notifications/dispatch'
import { advisoryXactLock } from '../db/advisory-lock'
import {
  persistCopilotOverageAllocation,
  type PersistCopilotOverageAllocationResult,
} from '../governance/copilot-overage-allocation'
import { describeError } from '../utils/redact-probe-error'

type Db = PostgresJsDatabase<typeof schema>

/** The read surface the worker consumes (the enterprise billing usage report). Test seam. */
export type BillingReportClient = Pick<GithubCopilotClient, 'getEnterpriseBillingUsage'>

/*
 * SKU classification (canonical §B cost shape + copilot-surface-lanes D3, June-2026 SKU
 * reality). THREE-WAY over Copilot-product lines:
 *   - AI-credit / coding-agent / premium-request SKUs → the pooled OVERAGE (copilot-usage
 *     lane). Tested BEFORE license so a line matching both classifiers (e.g. a hypothetical
 *     "copilot_enterprise_ai_credits") routes to overage — priority pinned by fixture.
 *     Covers the snake_case June-2026 ids (copilot_ai_credits, coding_agent_ai_credit) and
 *     the legacy copilot_premium_request (metered usage, never a seat).
 *   - seat SKUs → the LICENSE (copilot-license lane). ANCHORED on the documented concrete
 *     SKU ids ONLY — copilot_enterprise, copilot_for_business, copilot_standalone (and
 *     their human forms "Copilot Enterprise" / "Copilot Business" / "Copilot Standalone"),
 *     tolerant of space/underscore/hyphen and case. NEVER bare generic words
 *     ('seat'/'subscription'/'license'/'enterprise'/'business' alone): a generic-word match
 *     silently books an AMBIGUOUS future SKU as chargeable, bypassing the unclassified
 *     safety net for exactly the case it exists to catch (r1 finding 2).
 *   - anything else on a Copilot product → UNCLASSIFIED (unclassified_net_usd → the
 *     copilot-unclassified lane): counted, alerted ('copilot-bill-unclassified'), NEVER
 *     charged — never a silent drop and never a mis-booked license. That safety net is
 *     the intended destination for any Copilot line the anchored classifiers don't know.
 * Copilot-ness anchors on the PRODUCT field (June-2026 products are snake_case ids —
 * spark_ai_credits / models_inference are NOT Copilot even though their SKUs contain
 * 'ai_credit'); a blank product falls back to the sku. Non-Copilot products are excluded
 * from Copilot's bill but COUNTED per product per (enterprise, month) in the run result
 * (`ignoredProducts`), so a new spend category is visible drift, never silence.
 */
const AI_CREDIT_SKU = /ai[\s_-]?credit|coding[\s_-]?agent|padawan|cloud[\s_-]?agent|premium[\s_-]?request/i
// Anchored license classifier: 'copilot' + a documented seat-SKU qualifier, any separator.
const LICENSE_SKU = /copilot[\s_-]+(?:enterprise|(?:for[\s_-]+)?business|standalone)/i
/*
 * Copilot-ness = the 'copilot' token OR one of GitHub's OWN Copilot-agent product
 * aliases: the coding agent has shipped under 'coding_agent', 'padawan' (its internal
 * codename) and 'cloud_agent' — all Copilot products that may not carry the copilot
 * token themselves. ACCEPTED RISK (r1 finding 3): an alias match is by definition
 * indistinguishable from an unrelated future product that reuses the same words (a
 * hypothetical 'cloud_agent_gateway' would be swept in) — no negative fixture can
 * exist for that. The aliases are kept deliberately because they ARE Copilot's
 * product names; if GitHub ever ships an unrelated colliding product, drop the alias
 * and re-run the month (D3 runbook, docs/build/worker-scheduler.md).
 */
const COPILOT_AGENT_PRODUCT_ALIASES = /coding[\s_-]?agent|padawan|cloud[\s_-]?agent/i
const COPILOT_PRODUCT = new RegExp(`copilot|${COPILOT_AGENT_PRODUCT_ALIASES.source}`, 'i')

/** Product-anchored Copilot test (blank product → sku fallback). */
function isCopilotLine(it: GithubBillingUsageItem): boolean {
  const product = (it.product ?? '').trim()
  if (product) return COPILOT_PRODUCT.test(product)
  return COPILOT_PRODUCT.test(it.sku ?? '')
}

export interface OrgBillAgg {
  /** null = no "Copilot Enterprise" SKU (license) line was present. */
  licenseNetUsd: number | null
  overageNetUsd: number
  /** NET of Copilot lines matching neither classifier — the copilot-unclassified lane. */
  unclassifiedNetUsd: number
  includedAllowanceUsd: number
  usageGrossUsd: number
  seats: number | null
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0
}

/*
 * Pure categorisation of one org's billing-report lines into the copilot_pool_bill figures.
 * READ, never recompute: license/overage/included are summed straight off the bill's
 * net/discount fields. Copilot lines matching neither classifier land in
 * `unclassifiedNetUsd` (visible + alerted, never charged); non-Copilot products are summed
 * per product into the optional `ignoredProducts` accumulator (the caller passes one
 * accumulator PER (enterprise, month) — run-result provenance, r1 finding 8).
 * Exported for unit testing (the recomputation-divergence / mid-month seat-change case is a
 * fixture over this).
 */
export function aggregateOrgBill(
  items: GithubBillingUsageItem[],
  ignoredProducts?: Record<string, number>,
): OrgBillAgg {
  let licenseNet: number | null = null
  let overageNet = 0
  let unclassifiedNet = 0
  let included = 0
  let usageGross = 0
  let seats: number | null = null
  for (const it of items) {
    if (!isCopilotLine(it)) {
      if (ignoredProducts) {
        const key = (it.product ?? '').trim() || '(no product)'
        ignoredProducts[key] = (ignoredProducts[key] ?? 0) + num(it.netAmount)
      }
      continue
    }
    const label = `${it.product ?? ''} ${it.sku ?? ''}`
    if (AI_CREDIT_SKU.test(label)) {
      overageNet += num(it.netAmount)
      included += num(it.discountAmount)
      usageGross += num(it.grossAmount)
    } else if (LICENSE_SKU.test(label)) {
      licenseNet = (licenseNet ?? 0) + num(it.netAmount)
      seats = Math.max(seats ?? 0, num(it.quantity))
    } else {
      unclassifiedNet += num(it.netAmount)
    }
  }
  return {
    licenseNetUsd: licenseNet,
    overageNetUsd: overageNet,
    unclassifiedNetUsd: unclassifiedNet,
    includedAllowanceUsd: included,
    usageGrossUsd: usageGross,
    seats,
  }
}

/** Σ raw Copilot-line NET — the C1 conservation reference (columns vs raw). */
export function copilotRawNetUsd(items: GithubBillingUsageItem[]): number {
  return items.reduce((a, it) => (isCopilotLine(it) ? a + num(it.netAmount) : a), 0)
}

/*
 * C1 runtime assertion (design D2, r1-F1): per org group, the classified columns
 * (license + overage + unclassified) must equal Σ raw Copilot net EXACTLY (both sides
 * are sums of the same floats; the epsilon only absorbs float re-association). Checked
 * PRE-normalisation — normalizeUnsettled deliberately refuses to book a drifted license,
 * which is the unsettled path, not a classification leak.
 */
function c1DeltaUsd(agg: OrgBillAgg, items: GithubBillingUsageItem[]): number {
  const columns = (agg.licenseNetUsd ?? 0) + agg.overageNetUsd + agg.unclassifiedNetUsd
  return columns - copilotRawNetUsd(items)
}

/** True when the agg carries any Copilot content worth a row. */
function hasContent(a: OrgBillAgg): boolean {
  return (
    a.licenseNetUsd !== null ||
    a.overageNetUsd !== 0 ||
    a.unclassifiedNetUsd !== 0 ||
    a.usageGrossUsd > 0 ||
    (a.seats ?? 0) > 0
  )
}

/** Unsettled = usage present but no read license charge (license SKU line NULL). */
function isUnsettled(a: OrgBillAgg): boolean {
  return a.licenseNetUsd === null && a.usageGrossUsd > 0
}

/*
 * MEDIUM-1(b) shape-drift sentinel. An org-month with real usage (gross > 0) but NO positive
 * money at all — license AND overage both non-positive — is almost certainly a bill-shape drift
 * (money fields renamed/zeroed), NOT a genuine fully-covered month. Booking it as a confident $0
 * would sail past isUnsettled (which keys on license === null). Force the license to NULL so the
 * row books UNSETTLED (never a silent $0) — that also drives the Σ=bill view's unsettled flag
 * (license_net_usd IS NULL AND usage_gross_usd > 0) — and the worker raises the unsettled alert.
 * A month with genuine paid overage (overage > 0) is NOT touched — that is real settled money.
 */
function normalizeUnsettled(a: OrgBillAgg): OrgBillAgg {
  if (
    a.usageGrossUsd > 0 &&
    (a.licenseNetUsd ?? 0) <= 0 &&
    a.overageNetUsd <= 0 &&
    a.unclassifiedNetUsd <= 0
  ) {
    return { ...a, licenseNetUsd: null }
  }
  return a
}

/** Merge one org's agg into the enterprise-residual accumulator (folds org-less / unregistered). */
function foldResidual(dst: OrgBillAgg, src: OrgBillAgg): void {
  if (src.licenseNetUsd !== null) dst.licenseNetUsd = (dst.licenseNetUsd ?? 0) + src.licenseNetUsd
  dst.overageNetUsd += src.overageNetUsd
  dst.unclassifiedNetUsd += src.unclassifiedNetUsd
  dst.includedAllowanceUsd += src.includedAllowanceUsd
  dst.usageGrossUsd += src.usageGrossUsd
  if (src.seats !== null) dst.seats = (dst.seats ?? 0) + src.seats
}

function n6(v: number | null): string | null {
  return v === null ? null : v.toFixed(6)
}

interface MonthKey {
  monthStart: string // YYYY-MM-01
  year: number
  month: number // 1-12
}

/** The current month and the `monthsBack` prior months (default: current + previous). */
export function billingMonths(now: Date, monthsBack: number): MonthKey[] {
  const out: MonthKey[] = []
  for (let i = 0; i <= monthsBack; i++) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1))
    const year = d.getUTCFullYear()
    const month = d.getUTCMonth() + 1
    out.push({ monthStart: `${year}-${String(month).padStart(2, '0')}-01`, year, month })
  }
  return out
}

export interface CopilotPoolBillOptions {
  now?: Date
  /** Test seam: this billing-report client is used for EVERY enterprise instead of resolving a
   *  live credential + constructing a client. */
  clientOverride?: BillingReportClient
  /** How many months BEFORE the current one to also pull (default 1 → current + previous, so
   *  late prior-month settling is captured). Ignored when `explicitMonths` is supplied. */
  monthsBack?: number
  /** Workstream C: scope the run to ONE provider_enterprise (by id) — used by the admin
   *  historical bill re-pull route. Default: every reconciled github enterprise. */
  enterpriseId?: string
  /** Workstream C: an explicit list of calendar months (YYYY-MM-01), OVERRIDING the
   *  now/monthsBack rolling-window derivation entirely. Used by the admin historical
   *  re-pull so a targeted re-pull can reach an ARBITRARY past month without widening
   *  the worker's normal current+monthsBack window. */
  explicitMonths?: string[]
}

export interface CopilotPoolBillResult {
  enterprisesConsidered: number
  enterprisesRun: number
  enterprisesSkippedNoCredential: number
  enterprisesErrored: number
  monthsProcessed: number
  orgRowsWritten: number
  residualRowsWritten: number
  orgsExemptSkipped: number
  /** Named to match run-warnings extraction; also the count of missing-SKU alerts raised. */
  unsettledOrgMonths: number
  /** Org-months (incl. the residual) that booked unclassified_net_usd > 0 (D3 alert). */
  unclassifiedOrgMonths: number
  alertsEmitted: number
  /** Non-Copilot products seen on the bill (spark_ai_credits, models_inference, …),
   *  keyed per (enterprise, month) — `'<enterpriseRef>:<YYYY-MM>'` → product →
   *  Σ netAmount USD — so a new product surfacing in one org-month is
   *  distinguishable from the same product in another (r1 finding 8). Counted,
   *  never booked — visible drift, never silence. */
  ignoredProducts: Record<string, Record<string, number>>
  /** Workstream C: (enterprise, month) pairs whose overage allocation was recomputed
   *  this run (incl. a $0 clear-only recompute). */
  overageAllocationsComputed: number
  /** Of the above, how many landed a `__unallocated` (NULL cost_owning_unit_id) row
   *  because total attributable weight was zero for a paid overage. */
  overageAllocationsUnallocated: number
}

interface OrgGroup {
  orgName: string // original-case representative name ('' = org-less)
  items: GithubBillingUsageItem[]
}

/* Provider_org registry row (per enterprise): resolves an org name → its id + CoU homing. */
interface RegisteredOrg {
  id: string
  costOwningUnitId: string | null
}

interface OrgRegistry {
  /** Bill-org name (lowercased) → registered org. Keyed by BOTH login and display name. */
  byName: Map<string, RegisteredOrg>
  /** Count of provider_org rows for the enterprise (the homing-mismatch denominator). */
  registeredCount: number
}

async function loadOrgRegistry(db: Db, enterpriseId: string): Promise<OrgRegistry> {
  const rows = await db.execute<{
    id: string
    external_org_id: string
    display_name: string | null
    cost_owning_unit_id: string | null
  }>(sql`
    SELECT id::text AS id, external_org_id, display_name, cost_owning_unit_id::text AS cost_owning_unit_id
    FROM provider_org
    WHERE provider = 'github' AND provider_enterprise_id = ${enterpriseId}::uuid
  `)
  const byName = new Map<string, RegisteredOrg>()
  // First pass: key by login (external_org_id) — the authoritative match (mig 0064 lowercase).
  for (const r of rows) {
    byName.set(r.external_org_id.toLowerCase(), { id: r.id, costOwningUnitId: r.cost_owning_unit_id })
  }
  // MEDIUM-2: ALSO key by display_name (case-insensitive). The live bill's `organizationName`
  // may be the org DISPLAY name, not the login — matching only on the login would miss every org
  // and collapse the whole enterprise to the residual. A login key ALWAYS wins (never let a
  // display_name shadow a different org's login); a blank or duplicate display_name is skipped.
  for (const r of rows) {
    const dn = (r.display_name ?? '').trim().toLowerCase()
    if (!dn || byName.has(dn)) continue
    byName.set(dn, { id: r.id, costOwningUnitId: r.cost_owning_unit_id })
  }
  return { byName, registeredCount: rows.length }
}

/** A minimal DB executor — satisfied by both the Db and a `tx` from `db.transaction`. */
type SqlRunner = Pick<Db, 'execute'>

async function insertRow(
  db: SqlRunner,
  row: {
    monthStart: string
    enterpriseId: string
    providerOrgId: string | null
    costOwningUnitId: string | null
    agg: OrgBillAgg
    raw: unknown
  },
): Promise<void> {
  await db.execute(sql`
    INSERT INTO copilot_pool_bill
      (month, provider_enterprise_id, provider_org_id, cost_owning_unit_id, seats,
       license_net_usd, included_allowance_usd, usage_gross_usd, overage_net_usd,
       unclassified_net_usd, raw_payload)
    VALUES
      (${row.monthStart}::date, ${row.enterpriseId}::uuid, ${row.providerOrgId}::uuid,
       ${row.costOwningUnitId}::uuid, ${row.agg.seats},
       ${n6(row.agg.licenseNetUsd)}::numeric, ${n6(row.agg.includedAllowanceUsd)}::numeric,
       ${n6(row.agg.usageGrossUsd)}::numeric, ${n6(row.agg.overageNetUsd)}::numeric,
       ${n6(row.agg.unclassifiedNetUsd)}::numeric, ${JSON.stringify(row.raw)}::jsonb)
  `)
}

/* Idempotency-guarded unsettled-org alert. Admin-routed (finance concern) via dispatchInbox;
 * only raised once per (org, month) until an admin resolves it. Covers BOTH the absent-license-
 * SKU case and the MEDIUM-1(b) drift case (license present but $0 with usage → normalised NULL). */
async function alertUnsettled(
  db: Db,
  args: { enterpriseSlug: string; orgName: string; providerOrgId: string; regionId: string | null; monthStart: string; agg: OrgBillAgg },
): Promise<boolean> {
  const existing = await db.execute<{ id: string }>(sql`
    SELECT id::text AS id FROM inbox_item
     WHERE category = 'copilot-bill-unsettled'
       AND ack_state IN ('unread', 'read', 'acknowledged')
       AND related_entity_id = ${args.providerOrgId}::uuid
       AND body->>'month' = ${args.monthStart}
     LIMIT 1
  `)
  if (existing.length > 0) return false
  const dispatched = await dispatchInbox(db, {
    category: 'copilot-bill-unsettled',
    severity: 'attention',
    subject: `Copilot bill unsettled — no settled license charge for ${args.orgName} (${args.monthStart})`,
    body: {
      enterprise: args.enterpriseSlug,
      org: args.orgName,
      month: args.monthStart,
      usageGrossUsd: args.agg.usageGrossUsd,
      overageNetUsd: args.agg.overageNetUsd,
      hint: 'The enterprise billing usage report has Copilot usage for this org-month but yielded no read license charge — either no "Copilot Enterprise" SKU line, or every money field read $0 (a likely bill-shape drift). No license charge was written (never a flat-rate fallback); the month reports unsettled on the Finance chargeback = bill check. Verify the bill report or the SKU/field naming.',
    },
    relatedEntityKind: 'provider-org',
    relatedEntityId: args.providerOrgId,
    regionId: args.regionId ?? undefined,
  })
  return dispatched.length > 0
}

/* LOW: the unallocated enterprise-residual has usage but no read license → the month reports
 * unsettled on the Σ=bill view, yet no per-org owner exists to route an alert to. Raise the same
 * 'copilot-bill-unsettled' category at the ENTERPRISE grain so the residual-unsettled month is
 * not silent. Idempotent per (enterprise, month) via body->>'kind'='residual-unsettled'. */
async function alertResidualUnsettled(
  db: Db,
  args: { enterpriseId: string; enterpriseSlug: string; monthStart: string; agg: OrgBillAgg },
): Promise<boolean> {
  const existing = await db.execute<{ id: string }>(sql`
    SELECT id::text AS id FROM inbox_item
     WHERE category = 'copilot-bill-unsettled'
       AND ack_state IN ('unread', 'read', 'acknowledged')
       AND related_entity_id = ${args.enterpriseId}::uuid
       AND body->>'kind' = 'residual-unsettled'
       AND body->>'month' = ${args.monthStart}
     LIMIT 1
  `)
  if (existing.length > 0) return false
  const dispatched = await dispatchInbox(db, {
    category: 'copilot-bill-unsettled',
    severity: 'attention',
    subject: `Copilot bill unsettled — unallocated residual has usage but no license (${args.enterpriseSlug}, ${args.monthStart})`,
    body: {
      kind: 'residual-unsettled',
      enterprise: args.enterpriseSlug,
      month: args.monthStart,
      usageGrossUsd: args.agg.usageGrossUsd,
      overageNetUsd: args.agg.overageNetUsd,
      hint: 'The unallocated enterprise-residual (org-less / unregistered-org bill lines) has Copilot usage but no read "Copilot Enterprise" license line, so the month reports unsettled on the Finance chargeback = bill check with no per-org owner. Onboard the org(s) into provider_org (and map a Business Unit) or verify the bill report.',
    },
    relatedEntityKind: 'provider-enterprise',
    relatedEntityId: args.enterpriseId,
  })
  return dispatched.length > 0
}

/* MEDIUM-2: the enterprise HAS registered provider_org rows but NOT ONE chargeable bill org
 * matched any of them (by login OR display name) — every org folded into the residual. That is
 * the "organizationName is the display name, not the login" symptom (or a stale registry). Emit
 * a loud enterprise-level signal so an operator sees the mismatch rather than a silent all-
 * residual. Idempotent per (enterprise, month) via body->>'kind'='org-name-mismatch'. */
async function alertOrgNameMismatch(
  db: Db,
  args: { enterpriseId: string; enterpriseSlug: string; monthStart: string; registeredCount: number; billOrgNames: string[] },
): Promise<boolean> {
  const existing = await db.execute<{ id: string }>(sql`
    SELECT id::text AS id FROM inbox_item
     WHERE category = 'copilot-bill-unsettled'
       AND ack_state IN ('unread', 'read', 'acknowledged')
       AND related_entity_id = ${args.enterpriseId}::uuid
       AND body->>'kind' = 'org-name-mismatch'
       AND body->>'month' = ${args.monthStart}
     LIMIT 1
  `)
  if (existing.length > 0) return false
  const dispatched = await dispatchInbox(db, {
    category: 'copilot-bill-unsettled',
    severity: 'attention',
    subject: `Copilot bill org-name mismatch — no bill org matched any registered provider_org (${args.enterpriseSlug}, ${args.monthStart})`,
    body: {
      kind: 'org-name-mismatch',
      enterprise: args.enterpriseSlug,
      month: args.monthStart,
      registeredOrgCount: args.registeredCount,
      billOrgNames: args.billOrgNames,
      hint: 'The enterprise has registered provider_org rows, but NONE of the billing report\'s organizationName values matched any registered org by login (external_org_id) OR display name — every chargeable org folded into the unallocated residual (no per-Business Unit homing). Likely the bill\'s organizationName is the org DISPLAY name (not the login), or the provider_org registry is stale. Verify the org registry mapping.',
    },
    relatedEntityKind: 'provider-enterprise',
    relatedEntityId: args.enterpriseId,
  })
  return dispatched.length > 0
}

/*
 * D3 unclassified / conservation alert — the 'copilot-bill-unclassified' category (the
 * platform-admin copilot-bill alert inbox; runbook: docs/build/worker-scheduler.md).
 * Two kinds, one machinery (mirrors alertUnsettled's idempotency conventions):
 *   - kind 'unclassified-spend'     : an org-month booked unclassified_net_usd > 0 —
 *     classify the SKU (extend the maps) + re-run the month; never charged meanwhile.
 *   - kind 'conservation-violation' : the C1 runtime assertion tripped (columns ≠ Σ raw
 *     Copilot net) — a classifier is dropping/double-booking money; carries the $ delta.
 * Idempotent per (entity, month, kind) until an admin resolves the inbox item.
 */
async function alertUnclassified(
  db: Db,
  args: {
    enterpriseSlug: string
    orgName: string
    monthStart: string
    relatedEntityKind: 'provider-org' | 'provider-enterprise'
    relatedEntityId: string
    regionId: string | null
    kind: 'unclassified-spend' | 'conservation-violation'
    unclassifiedNetUsd: number
    deltaUsd?: number
  },
): Promise<boolean> {
  const existing = await db.execute<{ id: string }>(sql`
    SELECT id::text AS id FROM inbox_item
     WHERE category = 'copilot-bill-unclassified'
       AND ack_state IN ('unread', 'read', 'acknowledged')
       AND related_entity_id = ${args.relatedEntityId}::uuid
       AND body->>'kind' = ${args.kind}
       AND body->>'month' = ${args.monthStart}
     LIMIT 1
  `)
  if (existing.length > 0) return false
  const subject =
    args.kind === 'conservation-violation'
      ? `Copilot bill conservation violation — classified columns ≠ the sum of raw Copilot net for ${args.orgName} (${args.monthStart})`
      : `Copilot bill unclassified spend — ${args.orgName} has unclassified Copilot lines (${args.monthStart})`
  const hint =
    args.kind === 'conservation-violation'
      ? 'license_net + overage_net + unclassified_net diverged from the sum of raw Copilot bill-line netAmount for this org-month (the C1 conservation assertion). A SKU classifier is dropping or double-booking money — fix the classification, then re-run the month.'
      : 'One or more Copilot-product bill lines matched neither the license nor the usage (AI-credit/agent) SKU classifier. The amount is booked to the visible copilot-unclassified lane and is NEVER charged. Classify the SKU by extending the worker SKU maps, then re-run the month. Do not enable Copilot chargeback mode while unclassified > 0 for the billing month (runbook: docs/build/worker-scheduler.md).'
  const dispatched = await dispatchInbox(db, {
    category: 'copilot-bill-unclassified',
    severity: 'attention',
    subject,
    body: {
      kind: args.kind,
      enterprise: args.enterpriseSlug,
      org: args.orgName,
      month: args.monthStart,
      unclassifiedNetUsd: args.unclassifiedNetUsd,
      ...(args.deltaUsd !== undefined ? { deltaUsd: args.deltaUsd } : {}),
      hint,
    },
    relatedEntityKind: args.relatedEntityKind,
    relatedEntityId: args.relatedEntityId,
    regionId: args.regionId ?? undefined,
  })
  return dispatched.length > 0
}

/** Parse a 'YYYY-MM-01' string into a MonthKey (the `explicitMonths` shape, Workstream C). */
function monthKeyFromDateString(monthStart: string): MonthKey {
  const m = /^(\d{4})-(\d{2})-01$/.exec(monthStart)
  if (!m) throw new Error(`copilot-pool-bill: explicitMonths entries must be 'YYYY-MM-01', got '${monthStart}'`)
  return { monthStart, year: Number(m[1]), month: Number(m[2]) }
}

export async function runCopilotPoolBill(db: Db, opts?: CopilotPoolBillOptions): Promise<CopilotPoolBillResult> {
  const now = opts?.now ?? new Date()
  const monthsBack = opts?.monthsBack ?? 1
  // Workstream C: an explicit month list (the admin historical re-pull) bypasses the
  // current+monthsBack rolling window entirely, so a targeted re-pull can reach an
  // arbitrary past month without widening the worker's normal window.
  const months = opts?.explicitMonths ? opts.explicitMonths.map(monthKeyFromDateString) : billingMonths(now, monthsBack)
  const govCtx = await loadGovernanceResolutionContext(db)

  const result: CopilotPoolBillResult = {
    enterprisesConsidered: 0,
    enterprisesRun: 0,
    enterprisesSkippedNoCredential: 0,
    enterprisesErrored: 0,
    monthsProcessed: 0,
    orgRowsWritten: 0,
    residualRowsWritten: 0,
    orgsExemptSkipped: 0,
    unsettledOrgMonths: 0,
    unclassifiedOrgMonths: 0,
    alertsEmitted: 0,
    ignoredProducts: {},
    overageAllocationsComputed: 0,
    overageAllocationsUnallocated: 0,
  }

  const ents = await db.execute<{
    id: string
    external_id: string
    github_app_id: string | null
  }>(sql`
    SELECT id::text AS id, external_id, github_app_id
    FROM provider_enterprise
    WHERE provider = 'github' AND reconciliation_mode = 'reconciled'
      AND (${opts?.enterpriseId ?? null}::uuid IS NULL OR id = ${opts?.enterpriseId ?? null}::uuid)
    ORDER BY external_id
  `)

  for (const ent of ents) {
    result.enterprisesConsidered += 1

    // Client: the test seam wins; otherwise resolve the enterprise credential (PAT or App) and
    // build a real client. No credential → skip (never a green zero).
    let client: BillingReportClient
    if (opts?.clientOverride) {
      client = opts.clientOverride
    } else {
      let credential
      try {
        credential = await resolveEnterpriseCredential(db, { provider: 'github', externalId: ent.external_id })
      } catch (err) {
        // MissingGithubAppKeyError (App-opted enterprise, key unwired) — fail-loud, isolated.
        result.enterprisesErrored += 1
        consola.warn(`[copilot-pool-bill] credential resolve failed for ${ent.external_id}: ${describeError(err)}`)
        continue
      }
      if (!credential) {
        result.enterprisesSkippedNoCredential += 1
        continue
      }
      client =
        credential.kind === 'github-app'
          ? GithubCopilotClient.withApp(ent.external_id, new GithubAppAuth(credential.appId!, credential.value))
          : GithubCopilotClient.withPat(ent.external_id, credential.value)
    }

    const orgRegistry = await loadOrgRegistry(db, ent.id)
    let entRan = false

    for (const mk of months) {
      let report
      try {
        report = await client.getEnterpriseBillingUsage(mk.year, mk.month)
      } catch (err) {
        // Isolate a bad (enterprise, month) pull — never write a silent $0. Retried next run.
        // MEDIUM-1(a): an ABSENT/renamed NET money field makes the client's Zod parse THROW, so a
        // bill-shape drift lands HERE (fail-loud, month isolated) — never coerced to a $0 report.
        result.enterprisesErrored += 1
        consola.warn(`[copilot-pool-bill] ${ent.external_id} billing report ${mk.monthStart} failed: ${describeError(err)}`)
        continue
      }
      entRan = true

      // Group the report's items by org name (lowercased; '' = org-less).
      const groups = new Map<string, OrgGroup>()
      for (const it of report.usageItems) {
        const name = (it.organizationName ?? '').trim()
        const key = name.toLowerCase()
        const g = groups.get(key) ?? { orgName: name, items: [] }
        g.items.push(it)
        groups.set(key, g)
      }

      // Categorise the groups into the rows to write + the alert candidates BEFORE touching the
      // DB, so the DELETE + re-INSERT rewrite runs inside ONE transaction (LOW: the rewrite must
      // be atomic — a mid-loop crash must never leave the month short).
      const orgRows: { providerOrgId: string; costOwningUnitId: string | null; agg: OrgBillAgg; raw: unknown }[] = []
      const orgAlerts: { orgName: string; providerOrgId: string; costOwningUnitId: string | null; agg: OrgBillAgg }[] = []
      // D3 alert candidates: unclassified spend > 0 and/or a C1 conservation break.
      const unclassifiedAlerts: {
        orgName: string
        relatedEntityKind: 'provider-org' | 'provider-enterprise'
        relatedEntityId: string
        costOwningUnitId: string | null
        kind: 'unclassified-spend' | 'conservation-violation'
        unclassifiedNetUsd: number
        deltaUsd?: number
      }[] = []
      const residual: OrgBillAgg = {
        licenseNetUsd: null,
        overageNetUsd: 0,
        unclassifiedNetUsd: 0,
        includedAllowanceUsd: 0,
        usageGrossUsd: 0,
        seats: null,
      }
      // Per-(enterprise, month) ignored-product accumulator (r1 finding 8) — folded
      // into the run result under '<enterpriseRef>:<YYYY-MM>' after the group loop.
      const monthIgnoredProducts: Record<string, number> = {}
      // C1 delta of everything folded into the residual (org-less + unregistered orgs).
      let residualDeltaUsd = 0
      let residualHasContent = false
      // MEDIUM-2 homing-mismatch signal: of the CHARGEABLE named bill orgs, did any match a
      // registered provider_org (by login OR display name)? If NONE did while a registry exists,
      // every org folded to residual (the "organizationName is the display name" symptom).
      let anyChargeableOrgMatched = false
      let chargeableNamedOrgCount = 0
      const sampleBillOrgNames: string[] = []

      for (const [key, group] of groups) {
        let agg = aggregateOrgBill(group.items, monthIgnoredProducts)
        if (!hasContent(agg)) continue
        // C1 (columns vs raw), checked PRE-normalisation: the classified columns must equal
        // Σ raw Copilot net for the group. normalizeUnsettled deliberately refuses to book a
        // drifted license (the unsettled path), so it must not trip this assertion.
        const groupDeltaUsd = c1DeltaUsd(agg, group.items)
        // MEDIUM-1(b): usage present but no positive money → force unsettled (never a silent $0).
        agg = normalizeUnsettled(agg)

        if (key === '') {
          // Org-less bill line → the unallocated enterprise-residual row.
          foldResidual(residual, agg)
          residualDeltaUsd += groupDeltaUsd
          residualHasContent = true
          continue
        }

        const registered = orgRegistry.byName.get(key)
        const exempt = resolveGithubVerdict(govCtx, {
          providerEnterpriseId: ent.id,
          enterpriseSlug: ent.external_id,
          licenseOrg: group.orgName,
        }).exempt

        if (exempt) {
          // Canonical §B: exempt orgs are NOT written (no pool leak). Usage still surfaces
          // indicative via the usage lane. Neutral for the homing-mismatch signal.
          result.orgsExemptSkipped += 1
          continue
        }

        // Chargeable named org — it counts toward the homing-mismatch denominator.
        chargeableNamedOrgCount += 1
        if (sampleBillOrgNames.length < 25) sampleBillOrgNames.push(group.orgName)
        if (registered) anyChargeableOrgMatched = true

        if (!registered) {
          // An org with no provider_org registry row: fold into the visible residual (never
          // dropped). Onboard the org (+ map its CoU) for per-org granularity — v1 limitation.
          foldResidual(residual, agg)
          residualDeltaUsd += groupDeltaUsd
          residualHasContent = true
          continue
        }

        orgRows.push({
          providerOrgId: registered.id,
          costOwningUnitId: registered.costOwningUnitId,
          agg,
          raw: { organizationName: group.orgName, month: mk.monthStart, items: group.items },
        })
        if (isUnsettled(agg)) {
          orgAlerts.push({ orgName: group.orgName, providerOrgId: registered.id, costOwningUnitId: registered.costOwningUnitId, agg })
        }
        // D3: unclassified spend and/or a C1 break on a registered org → org-grain alerts.
        if (Math.abs(groupDeltaUsd) > 0.005) {
          unclassifiedAlerts.push({
            orgName: group.orgName,
            relatedEntityKind: 'provider-org',
            relatedEntityId: registered.id,
            costOwningUnitId: registered.costOwningUnitId,
            kind: 'conservation-violation',
            unclassifiedNetUsd: agg.unclassifiedNetUsd,
            deltaUsd: groupDeltaUsd,
          })
        }
        if (agg.unclassifiedNetUsd > 0) {
          unclassifiedAlerts.push({
            orgName: group.orgName,
            relatedEntityKind: 'provider-org',
            relatedEntityId: registered.id,
            costOwningUnitId: registered.costOwningUnitId,
            kind: 'unclassified-spend',
            unclassifiedNetUsd: agg.unclassifiedNetUsd,
          })
        }
      }

      const residualFinal = residualHasContent ? normalizeUnsettled(residual) : residual
      // D3: the residual's unclassified / C1 signals have no per-org owner → enterprise grain
      // (same convention as alertResidualUnsettled).
      if (residualHasContent && Math.abs(residualDeltaUsd) > 0.005) {
        unclassifiedAlerts.push({
          orgName: 'unallocated enterprise residual',
          relatedEntityKind: 'provider-enterprise',
          relatedEntityId: ent.id,
          costOwningUnitId: null,
          kind: 'conservation-violation',
          unclassifiedNetUsd: residualFinal.unclassifiedNetUsd,
          deltaUsd: residualDeltaUsd,
        })
      }
      if (residualHasContent && residualFinal.unclassifiedNetUsd > 0) {
        unclassifiedAlerts.push({
          orgName: 'unallocated enterprise residual',
          relatedEntityKind: 'provider-enterprise',
          relatedEntityId: ent.id,
          costOwningUnitId: null,
          kind: 'unclassified-spend',
          unclassifiedNetUsd: residualFinal.unclassifiedNetUsd,
        })
      }

      // Fold the (enterprise, month) ignored-product counts into the run result
      // under their provenance key (empty months contribute no key — no noise).
      if (Object.keys(monthIgnoredProducts).length > 0) {
        result.ignoredProducts[`${ent.external_id}:${mk.monthStart.slice(0, 7)}`] =
          monthIgnoredProducts
      }

      // Workstream C (design §8.4): the whole (enterprise, month) DELETE + re-INSERT,
      // AND the overage-allocation recompute that must stay consistent with it, run in
      // ONE transaction, under the reportingSnapshot + copilotOverageAllocation advisory
      // locks — the SAME lock persistCopilotOverageAllocation itself takes, so a
      // concurrent admin re-pull (or a second worker tick) for this exact
      // (enterprise, month) can never interleave with this write. A CLOSED finance
      // period refuses the whole rewrite outright (never a silent recost of history —
      // reopen or restate first).
      let txResult:
        | { skippedClosed: false; allocation: PersistCopilotOverageAllocationResult }
      try {
        txResult = await db.transaction(async (tx) => {
          await tx.execute(advisoryXactLock('reportingSnapshot', mk.monthStart))
          await tx.execute(advisoryXactLock('copilotOverageAllocation', `${ent.id}:${mk.monthStart}`))
          /*
           * NO CLOSED-MONTH SKIP. A closed month used to have its bill rewrite
           * and overage recompute silently declined. The provider is the record
           * of truth: its corrected bill lands, and the difference against the
           * month's snapshot is reported as a delta.
           */
          await tx.execute(sql`
            DELETE FROM copilot_pool_bill
            WHERE provider_enterprise_id = ${ent.id}::uuid AND month = ${mk.monthStart}::date
          `)
          for (const r of orgRows) {
            await insertRow(tx, {
              monthStart: mk.monthStart,
              enterpriseId: ent.id,
              providerOrgId: r.providerOrgId,
              costOwningUnitId: r.costOwningUnitId,
              agg: r.agg,
              raw: r.raw,
            })
          }
          if (residualHasContent) {
            await insertRow(tx, {
              monthStart: mk.monthStart,
              enterpriseId: ent.id,
              providerOrgId: null,
              costOwningUnitId: null,
              agg: residualFinal,
              raw: { organizationName: null, month: mk.monthStart, kind: 'unallocated-enterprise-residual' },
            })
          }

          // ADR-0011 D10: recompute the persisted overage-allocation distribution to
          // match the bill just written, in the SAME transaction (bill + its
          // allocation are never observably out of step with each other).
          const allocation = await persistCopilotOverageAllocation(tx, {
            providerEnterpriseId: ent.id,
            enterpriseExternalId: ent.external_id,
            month: mk.monthStart,
            governanceContext: govCtx,
            actorSystem: 'worker:copilot-pool-bill',
          })
          return { skippedClosed: false as const, allocation }
        })
      } catch (err) {
        result.enterprisesErrored += 1
        consola.warn(
          `[copilot-pool-bill] ${ent.external_id} bill/allocation persist ${mk.monthStart} failed: ${describeError(err)}`,
        )
        continue
      }

      result.orgRowsWritten += orgRows.length
      if (residualHasContent) result.residualRowsWritten += 1
      result.overageAllocationsComputed += 1
      if (txResult.allocation.unallocated) result.overageAllocationsUnallocated += 1

      // Alerts fire AFTER the rewrite COMMITS — never alert on a rolled-back month.
      for (const a of orgAlerts) {
        result.unsettledOrgMonths += 1
        const regionId = await orgRegionForCou(db, a.costOwningUnitId)
        const emitted = await alertUnsettled(db, {
          enterpriseSlug: ent.external_id,
          orgName: a.orgName,
          providerOrgId: a.providerOrgId,
          regionId,
          monthStart: mk.monthStart,
          agg: a.agg,
        })
        if (emitted) result.alertsEmitted += 1
      }

      // D3: unclassified / conservation alerts — same post-commit discipline. Each
      // 'unclassified-spend' candidate is one unclassified org-month (counted whether or not
      // the idempotency guard suppressed a duplicate inbox item).
      for (const a of unclassifiedAlerts) {
        if (a.kind === 'unclassified-spend') result.unclassifiedOrgMonths += 1
        const regionId = await orgRegionForCou(db, a.costOwningUnitId)
        const emitted = await alertUnclassified(db, {
          enterpriseSlug: ent.external_id,
          orgName: a.orgName,
          monthStart: mk.monthStart,
          relatedEntityKind: a.relatedEntityKind,
          relatedEntityId: a.relatedEntityId,
          regionId,
          kind: a.kind,
          unclassifiedNetUsd: a.unclassifiedNetUsd,
          deltaUsd: a.deltaUsd,
        })
        if (emitted) result.alertsEmitted += 1
      }

      // LOW: a residual that is license-NULL with usage → unsettled on the Σ=bill view, but
      // previously NO inbox item. Raise the same 'copilot-bill-unsettled' category for it too.
      if (residualHasContent && isUnsettled(residualFinal)) {
        result.unsettledOrgMonths += 1
        const emitted = await alertResidualUnsettled(db, {
          enterpriseId: ent.id,
          enterpriseSlug: ent.external_id,
          monthStart: mk.monthStart,
          agg: residualFinal,
        })
        if (emitted) result.alertsEmitted += 1
      }

      // MEDIUM-2: registered orgs exist but NOT ONE chargeable bill org matched → loud signal.
      if (orgRegistry.registeredCount > 0 && chargeableNamedOrgCount > 0 && !anyChargeableOrgMatched) {
        const emitted = await alertOrgNameMismatch(db, {
          enterpriseId: ent.id,
          enterpriseSlug: ent.external_id,
          monthStart: mk.monthStart,
          registeredCount: orgRegistry.registeredCount,
          billOrgNames: sampleBillOrgNames,
        })
        if (emitted) result.alertsEmitted += 1
      }

      result.monthsProcessed += 1
    }

    if (entRan) result.enterprisesRun += 1
  }

  // ADVISORY, never a data block (r1 finding 10): chargeback mode is live while this
  // run booked unclassified Copilot spend. Unclassified money is never charged, so the
  // data stays correct — but the runbook says classify + re-run BEFORE enabling the
  // mode, so shout. The finance API surfaces the matching `unclassifiedWarning` flag
  // and the finance scope view banners it.
  if (result.unclassifiedOrgMonths > 0 && copilotChargebackEnabled()) {
    consola.warn(
      `[copilot-pool-bill] Copilot chargeback mode is ENABLED while ${result.unclassifiedOrgMonths} org-month(s) carry unclassified Copilot spend — unclassified money is never charged; classify the SKU(s) and re-run the month (runbook: docs/build/worker-scheduler.md, D3).`,
    )
  }

  return result
}

/* Region of a cost-owning unit (for scoping the unsettled alert). NULL when the org is unmapped. */
async function orgRegionForCou(db: Db, costOwningUnitId: string | null): Promise<string | null> {
  if (!costOwningUnitId) return null
  const rows = await db.execute<{ region_id: string | null }>(sql`
    SELECT region_id::text AS region_id FROM org_unit WHERE id = ${costOwningUnitId}::uuid LIMIT 1
  `)
  return rows[0]?.region_id ?? null
}
