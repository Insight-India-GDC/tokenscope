/*
 * GitHub Copilot reconciliation adapter (Stream B).
 *
 * One instance is bound to one enterprise + its manage_billing PAT. It sweeps the
 * Copilot seat roster (the lane authority: login -> license-org), resolves each
 * login to a TokenScope teammate via the directory-seeded identity map, pulls
 * per-user `ai_credit/usage` for each UTC day in the window, and emits
 * provider-neutral `ReconciledLine[]` in the NATIVE credit unit. The engine prices
 * the OTel side credit-vs-credit (attribution_record.credit_qty) and books USD at
 * the authoritative grossAmount/grossQuantity rate. See docs/design/reconciliation-engine.md
 * §4.2, §4.3, §5.2, §7.1, §8.
 *
 * Identity is directory-sourced, never telemetry-trusted: the Copilot OTel span
 * carries only a salted `enduser.pseudo.id` and the *repo* org — neither is used
 * here (§4.3).
 *
 * Intent: ADR-0010. This adapter stages the METERED ai_credit usage into
 * reconciliation_record; the Copilot BILL (whole-month flat seat + per-user overage)
 * is computed from that staged usage + the seat roster by the copilot-bill writer
 * (server/workers/copilot-bill.ts) and written to actual_spend (the showback/chargeback
 * lane). A login with no identity link is SKIPPED here for THIS run's usage-staging — but
 * it is no longer lost: identity-sync now bill-driven-PROVISIONS that seat-holder
 * (github-identity.ts, ADR-0010 rule 1), so the next run maps + stages + bills them. The
 * old "carried forward, never dropped" wording was false (the seat's cost was dropped);
 * provisioning is what actually closes it.
 */
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { sql } from 'drizzle-orm'
import type * as schema from '../../../drizzle/schema'
import type {
  Adapter,
  AdapterPullOptions,
  ReconciledLine,
  ReconcileCategory,
  SpendClass,
  IndicativeReason,
} from '../types'
import type { AdapterScope } from './registry'
import { GithubCopilotClient, type GithubSeat, type GithubUsageItem } from './github-client'
import { GithubAppAuth } from './github-app-auth'
import { reconciledTeammateLine } from './teammate-line'
import { createGovernanceKeyCache, resolveGithubGovernanceKey } from '../governance-keys'
import { loadGovernanceResolutionContext, resolveGithubVerdict } from '../../governance/verdict'

type Db = PostgresJsDatabase<typeof schema>

/* Flat $0.01 USD per AI credit — the priced rate for the App-mode metrics consumption path.
 * The metrics report carries credit CONSUMPTION (no USD); GitHub prices AI credits at this
 * fixed rate (owner-confirmed). The PAT billing path keeps GitHub's authoritative
 * grossAmount/grossQuantity rate instead. */
const AIC_USD_RATE = 0.01

/*
 * Map a billing SKU/product to a reconcile category. Only "Copilot AI Credits" is
 * confirmed against a live PAT (2026-06-08); the Cloud/coding-agent SKU label is not
 * yet observed, so it is matched defensively and the default is the interactive lane.
 * [VERIFY §15.1] the coding-agent SKU string when one lands.
 */
const CODING_AGENT_SKU = /coding[\s_-]?agent|padawan|cloud[\s_-]?agent/i

export function categoriseSku(item: GithubUsageItem): ReconcileCategory {
  const label = `${item.product ?? ''} ${item.sku ?? ''}`
  return CODING_AGENT_SKU.test(label) ? 'copilot_coding_agent' : 'copilot_interactive'
}

/** License org for a seat: the managed-by org, else the assigning team name (§15.2). */
export function seatLicenseOrg(seat: GithubSeat): string | null {
  if (seat.organization?.login) return seat.organization.login
  const team = seat.assigning_team
  if (typeof team === 'string') return team
  if (team && typeof team === 'object' && 'name' in team) return team.name
  return null
}

export interface DayKey {
  iso: string
  year: number
  month: number
  day: number
}

/** Inclusive list of UTC days between two YYYY-MM-DD strings (bounded for safety). */
export function enumerateDays(startDate: string, endDate: string): DayKey[] {
  const out: DayKey[] = []
  const start = new Date(`${startDate}T00:00:00.000Z`)
  const end = new Date(`${endDate}T00:00:00.000Z`)
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end < start) return out
  for (let d = new Date(start), guard = 0; d <= end && guard < 400; d.setUTCDate(d.getUTCDate() + 1), guard++) {
    out.push({
      iso: d.toISOString().slice(0, 10),
      year: d.getUTCFullYear(),
      month: d.getUTCMonth() + 1,
      day: d.getUTCDate(),
    })
  }
  return out
}

/* Aggregate of one category's usage items for a (login, day) — summed in credits. */
interface CategoryAgg {
  gross: number
  discount: number
  net: number
  grossAmount: number
}

/*
 * Pure normalisation of one seat-day's usage items into ReconciledLine[]. Exported for
 * unit testing the credit->line mapping (no DB, no HTTP): groups items by category, sums
 * gross/discount/net in credits, books USD at the authoritative grossAmount/grossQuantity
 * rate, and emits one line per category with billable (gross > 0) credits.
 */
export function normaliseSeatDay(args: {
  enterpriseRef: string
  teammateId: string
  licenseOrg: string | null
  periodDate: string
  /** True when the license org is finance/chargeback-exempt (was `indicative` / NFR). */
  chargebackExempt: boolean
  usageItems: GithubUsageItem[]
  login: string
}): ReconciledLine[] {
  const byCategory = new Map<ReconcileCategory, CategoryAgg>()
  for (const item of args.usageItems) {
    const category = categoriseSku(item)
    const agg = byCategory.get(category) ?? { gross: 0, discount: 0, net: 0, grossAmount: 0 }
    agg.gross += item.grossQuantity
    agg.discount += item.discountQuantity
    agg.net += item.netQuantity
    agg.grossAmount += item.grossAmount
    byCategory.set(category, agg)
  }

  const lines: ReconciledLine[] = []
  for (const [category, agg] of byCategory) {
    // No billable credits that day -> no line (gross is the billable operand).
    if (agg.gross <= 0) continue
    // Authoritative per-credit rate. gross > 0 here, so never a divide-by-zero.
    const rate = agg.grossAmount / agg.gross
    // v1: Copilot is ALWAYS held indicative (out of cross-charge). There is no F2
    // GitHub billing/booking worker yet to promote it, and the finance booking policy
    // is deferred — so reconciled Copilot credits are shown/tracked but must NOT enter
    // v_finance_reportable_spend.
    //
    // The REASON distinguishes WHY a line is non-finance-reportable, and is forward-load-
    // bearing for F2: `chargeback-exempt` orgs (the configured finance-exclusion set —
    // already paid directly, e.g. credit card / a partner-NFR enterprise) STAY excluded
    // even after F2 promotes Copilot to finance-reportable; `copilot-pre-billing` orgs are
    // chargeback-ELIGIBLE and become reportable the moment F2 lands. Both gate identically
    // TODAY (spend_class='indicative'), so the generalisation is behaviour-preserving now
    // and correct at activation. args.chargebackExempt == "org is in the exempt set".
    const spendClass: SpendClass = 'indicative'
    const indicativeReason: IndicativeReason = args.chargebackExempt
      ? 'chargeback-exempt'
      : 'copilot-pre-billing'

    lines.push(
      reconciledTeammateLine({
        provider: 'github',
        enterpriseRef: args.enterpriseRef,
        periodDate: args.periodDate,
        teammateId: args.teammateId,
        category,
        quantity: agg.gross,
        unitType: 'ai-credits',
        amountUsd: agg.grossAmount,
        // Authoritative per-credit rate (grossAmount/grossQuantity); gross > 0 here.
        rateUsdPerUnit: rate,
        spendClass,
        indicativeReason,
        licenseOrg: args.licenseOrg,
        facets: { gross: agg.gross, discount: agg.discount, net: agg.net },
        raw: { login: args.login, licenseOrg: args.licenseOrg, periodDate: args.periodDate, category, items: args.usageItems },
      }),
    )
  }
  return lines
}

/*
 * Pure normalisation of one teammate's daily AI-credit CONSUMPTION (App-mode metrics path)
 * into ONE ReconciledLine. Exported for unit testing the credit->line mapping. The metrics
 * report carries a single per-user-day credit total (no SKU split), so it maps to the
 * copilot_interactive lane priced at the flat $0.01/credit (AIC_USD_RATE); facets gross=net
 * =credits (GROSS consumption, no discount/allowance applied — that netting is the billing
 * API's job). Held `indicative` exactly like the PAT billing path (out of cross-charge
 * until F2), with the same chargeback-exempt vs copilot-pre-billing reason split.
 */
export function normaliseMetricsCreditLine(args: {
  enterpriseRef: string
  teammateId: string
  periodDate: string
  credits: number
  login: string
  /** True when the enterprise is finance/chargeback-exempt (NFR/demo). */
  chargebackExempt: boolean
  raw: unknown
}): ReconciledLine {
  return reconciledTeammateLine({
    provider: 'github',
    enterpriseRef: args.enterpriseRef,
    periodDate: args.periodDate,
    teammateId: args.teammateId,
    category: 'copilot_interactive',
    quantity: args.credits,
    unitType: 'ai-credits',
    amountUsd: args.credits * AIC_USD_RATE,
    rateUsdPerUnit: AIC_USD_RATE,
    spendClass: 'indicative',
    indicativeReason: args.chargebackExempt ? 'chargeback-exempt' : 'copilot-pre-billing',
    licenseOrg: null,
    facets: { gross: args.credits, discount: 0, net: args.credits },
    raw: { login: args.login, periodDate: args.periodDate, credits: args.credits, record: args.raw },
  })
}

/*
 * Shared roster reader: login (lowercased) → teammateId, from the directory-seeded
 * identity map for ONE github enterprise. Extracted from GithubAdapter.resolveRoster
 * so the health probe (github-health.ts) reuses the EXACT same login→teammate mapping
 * the reconciliation adapter uses, never a re-implemented (and drifting) query. The
 * probe splits its count: logins found only through the self lane
 * (resolveGithubSelfOnlyLogins) are reported as selfClaimed, not rosterMatched, and
 * count as unmatched in the verdict; the reconciler attributes both.
 *
 * CANONICAL CASING (P1-7 / mig 0062): enterprise_slug is written lowercase by the
 * directory-sync UPSERT; the lower()=lower() match is the consistent read-side lookup
 * (also used by the credential resolver). Do NOT "fix" it to an exact match.
 *
 * TWO LANES, enterprise-lane authoritative (identity-tail layer 2): the roster reads
 * BOTH the enterprise/directory-sync lane (enterprise_slug = the enterprise slug) AND the
 * self-service lane (enterprise_slug IS NULL, written by POST /me/identities with
 * source='self'). A self-link is "this github login is me" — anti-claim-jack-guaranteed
 * (the self-service POST throws 409 on a login already linked to anyone), so it is a valid
 * attribution signal for the residual tail of seat-holders the directory sweep hasn't bound
 * yet. PRECEDENCE is exact and MONEY-PATH-critical: when BOTH lanes hold a row for the SAME
 * login, the ENTERPRISE lane wins (the authoritative directory/admin binding), so a self-link
 * can only ever ADD a login, never OVERRIDE the authoritative teammate. DISTINCT ON dedups per
 * login; `(enterprise_slug IS NULL) ASC` sorts the NOT-NULL (enterprise) row FIRST → it wins.
 *
 * §A ONLY: the self lane is ESTATE-GLOBAL and unverified — a `source='self'` link makes that
 * login attributable as the claimant's usage in ANY enterprise. That is deliberate for §A ("trust
 * the developer"). It does not reach the billed overage split: copilot-overage-allocation.ts homes
 * a weight on a Business Unit only through an enterprise-lane binding, and sends self-only usage
 * to Unallocated until an admin binds the login (map.post).
 */
export async function resolveGithubRoster(
  // Widened db (the credentials.ts convention): this reader uses only db.execute(sql`…`), so
  // it accepts BOTH the schema-typed adapter db AND the health probe's widened request/getDb
  // handle without an unsafe cast (the schema-typed db is assignable to the widened one).
  db: PostgresJsDatabase<Record<string, unknown>>,
  enterpriseRef: string,
): Promise<Map<string, string>> {
  const rows = await db.execute<{ login: string; teammate_id: string }>(sql`
    SELECT DISTINCT ON (lower(identifier))
           lower(identifier) AS login, teammate_id::text AS teammate_id
    FROM teammate_identity_map
    WHERE system = 'github'
      AND (lower(enterprise_slug) = lower(${enterpriseRef}) OR enterprise_slug IS NULL)
    ORDER BY lower(identifier), (enterprise_slug IS NULL) ASC
  `)
  const map = new Map<string, string>()
  for (const r of rows) map.set(r.login, r.teammate_id)
  return map
}

/*
 * Logins this enterprise's roster resolves ONLY through the self lane (no directory-sync or admin
 * binding for this enterprise), lowercased → the claimant's email. The admin "Unresolved Copilot
 * users" queue lists them, because their billed overage stays Unallocated until an admin binds them.
 */
export async function resolveGithubSelfOnlyLogins(
  db: PostgresJsDatabase<Record<string, unknown>>,
  enterpriseRef: string,
): Promise<Map<string, string>> {
  const rows = await db.execute<{ login: string; email: string }>(sql`
    SELECT DISTINCT ON (lower(s.identifier)) lower(s.identifier) AS login, t.email
    FROM teammate_identity_map s
    JOIN teammate t ON t.id = s.teammate_id
    WHERE s.system = 'github' AND s.enterprise_slug IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM teammate_identity_map e
        WHERE e.system = 'github' AND lower(e.enterprise_slug) = lower(${enterpriseRef})
          AND lower(e.identifier) = lower(s.identifier))
    ORDER BY lower(s.identifier), s.id
  `)
  return new Map(rows.map((r) => [r.login, r.email]))
}

/*
 * §org->enterprise keying (F2 activation-time logic — GATED OFF until onboarded).
 *
 * Enterprise attribution for Copilot is derived from the REPO's GitHub org -> enterprise:
 * a GitHub org belongs to exactly one enterprise, modelled by the existing
 * provider_org.provider_enterprise_id -> provider_enterprise link (mig 0038). The Copilot
 * emit now carries the repo org (a sibling track adds the wire stamp); at activation the
 * reconciler can map that org to the enterprise's credential/reconciliation LANE
 * (provider_enterprise.external_id = the enterprise slug = the adapter's externalRef).
 *
 * This is a pure, no-op-until-onboarded reader: if no provider_org row for the org links
 * to a provider_enterprise (the F2 onboarding seed/migration is a TEMPLATE — no real
 * slugs exist yet), it returns null. It NEVER invents an enterprise. Today's reconciler
 * keys the lane off provider_enterprise rows directly + the seat roster's license org;
 * this resolver is the bridge for org-stamped records once an enterprise+PAT is live.
 *
 * Returns the enterprise slug (lowercased to match the canonical-casing read convention
 * used by the roster reader + credential resolver), or null.
 */
export async function resolveEnterpriseForOrg(
  db: Db,
  githubOrg: string | null | undefined,
): Promise<string | null> {
  if (!githubOrg) return null
  const org = githubOrg.trim()
  if (!org) return null
  const rows = await db.execute<{ external_id: string }>(sql`
    SELECT pe.external_id AS external_id
    FROM provider_org po
    JOIN provider_enterprise pe ON pe.id = po.provider_enterprise_id
    WHERE po.provider = 'github'
      AND lower(po.external_org_id) = lower(${org})
      AND pe.provider = 'github'
    LIMIT 1
  `)
  const slug = rows[0]?.external_id
  return slug ? slug.toLowerCase() : null
}

/* The PAT-mode read surface the adapter consumes (today's enterprise endpoints). */
type GithubPatClient = Pick<GithubCopilotClient, 'listSeats' | 'getAiCreditUsage'>
/* The App-mode read surface: enterprise-grain, READ-ONLY per-user AI-credit consumption. */
type GithubAppClient = Pick<GithubCopilotClient, 'getUserDailyCredits'>

class GithubAdapter implements Adapter {
  readonly provider = 'github' as const
  readonly enterpriseRef: string
  /** Set in PAT mode (credential.kind !== 'github-app'). Today's path. */
  private readonly patClient?: GithubPatClient
  /** Set in App mode (credential.kind === 'github-app'). */
  private readonly appClient?: GithubAppClient

  constructor(
    private readonly db: Db,
    scope: AdapterScope,
    clientOverride?: GithubPatClient | GithubAppClient,
  ) {
    this.enterpriseRef = scope.externalRef
    // Branch the auth path at the ADAPTER seam by credential.kind (requirement 1) — the
    // live PAT methods are never overloaded. App mode runs ONLY when an App credential
    // is configured; absent github_app_id, kind is undefined/'github-pat' → PAT path.
    if (scope.credential.kind === 'github-app') {
      this.appClient =
        (clientOverride as GithubAppClient | undefined) ??
        GithubCopilotClient.withApp(
          scope.externalRef,
          // value = base64 PEM, appId = github_app_id (resolved + fail-loud in credentials.ts).
          new GithubAppAuth(scope.credential.appId!, scope.credential.value),
        )
    } else {
      this.patClient =
        (clientOverride as GithubPatClient | undefined) ??
        GithubCopilotClient.withPat(scope.externalRef, scope.credential.value)
    }
  }

  /*
   * login (lowercased) -> teammateId, from the directory-seeded identity map for THIS
   * enterprise. The identity-sync worker is the writer (github-identity.ts); the adapter
   * is a pure reader here so reconciliation never trusts a telemetry-side identity.
   *
   * CANONICAL CASING (P1-7 / mig 0062): enterprise_slug is written lowercase by the
   * directory-sync UPSERT; this lower()=lower() match is the consistent read-side
   * lookup (also used by the credential resolver). Do NOT "fix" it to an exact match —
   * the case-insensitive compare is the deliberate, uniform regime.
   */
  private async resolveRoster(): Promise<Map<string, string>> {
    // Delegates to the shared reader (extracted so the health probe reuses the EXACT
    // same login→teammate mapping — see resolveGithubRoster above).
    return resolveGithubRoster(this.db, this.enterpriseRef)
  }

  /*
   * pull() branches by mode at the top — mirroring the Anthropic adapter's branch by
   * api_kind:
   *   - PAT mode → pullPatBilling: the enterprise seat roster (lane authority) + per-
   *                (login, day) ai_credit/usage billing read (gross/discount/net + USD + SKU).
   *   - App mode → pullAppMetrics: the enterprise users-1-day metrics report → per-user
   *                ai_credits_used, priced at the flat $0.01/credit.
   * Both resolve login → teammate via the directory-seeded identity map and emit provider-
   * neutral ReconciledLine[]; a login with no identity link is carried forward, never guessed.
   */
  async pull(opts: AdapterPullOptions): Promise<ReconciledLine[]> {
    const days = enumerateDays(opts.startDate, opts.endDate)
    if (days.length === 0) return []
    return this.appClient ? this.pullAppMetrics(days) : this.pullPatBilling(days)
  }

  /*
   * PAT mode (today's path): the enterprise seat roster is the lane authority
   * (login → license org); for each seated, identity-matched login, pull per-(login, day)
   * ai_credit/usage and normalise the billing-grade usageItems[] into ReconciledLine[].
   */
  private async pullPatBilling(days: DayKey[]): Promise<ReconciledLine[]> {
    const [seats, identityByLogin, ctx] = await Promise.all([
      this.patClient!.listSeats(),
      this.resolveRoster(),
      loadGovernanceResolutionContext(this.db),
    ])
    const govKeyCache = createGovernanceKeyCache()
    const lines: ReconciledLine[] = []

    // ai_credit/usage is PER-USER (keyed by login; returns the user's total regardless of
    // org). A user holding seats in multiple orgs would otherwise have the SAME usage pulled
    // + emitted once per seat and SUMMED by the engine's conflict-key aggregation (which
    // excludes license_org) — inflating their usage Nx. Stage usage ONCE per login (first
    // seat wins for the org label). The flat per-seat LICENSE is modelled separately, per
    // seat, by the copilot-bill writer (server/workers/copilot-bill.ts). See ADR-0010.
    const seenLogins = new Set<string>()

    for (const seat of seats) {
      const login = seat.assignee.login
      if (seenLogins.has(login.toLowerCase())) continue
      seenLogins.add(login.toLowerCase())
      const teammateId = identityByLogin.get(login.toLowerCase())
      // Unmatched login -> skip THIS run's usage-staging (never emit org-bucketed or
      // guessed spend). The seat's cost is NOT lost: identity-sync bill-driven-provisions
      // the holder (ADR-0010 rule 1), so the next run maps + stages + bills them.
      if (!teammateId) continue

      const licenseOrg = seatLicenseOrg(seat)
      // Chargeability is resolved by server/governance/verdict.ts — enterprise-level
      // `billing` once governance is activated (ADR-0011 D11), the legacy per-org
      // heuristic before then (the rollback seam). Never both.
      const govKey = await resolveGithubGovernanceKey(this.db, govKeyCache, {
        enterpriseSlug: this.enterpriseRef,
        licenseOrg,
      })
      const chargebackExempt = resolveGithubVerdict(ctx, {
        providerEnterpriseId: govKey.providerEnterpriseId,
        enterpriseSlug: this.enterpriseRef,
        licenseOrg,
      }).exempt

      for (const day of days) {
        let usage
        try {
          usage = await this.patClient!.getAiCreditUsage(login, day)
        } catch (err) {
          // Isolate a single bad seat-day so it cannot starve the rest of the sweep; it is
          // retried on the next tick. Worker-visible per conventions.
          console.warn(`[github-adapter] ${this.enterpriseRef} ai_credit/usage failed for a seat on ${day.iso}: ${String(err)}`)
          continue
        }
        lines.push(
          ...normaliseSeatDay({
            enterpriseRef: this.enterpriseRef,
            teammateId,
            licenseOrg,
            periodDate: day.iso,
            chargebackExempt,
            usageItems: usage.usageItems,
            login,
          }),
        )
      }
    }
    return lines
  }

  /*
   * App mode (off-PAT, READ-ONLY): one users-1-day metrics report per UTC day yields
   * per-user ai_credits_used for the whole enterprise; resolve each login → teammate and
   * emit ONE copilot line per (teammate, day) priced at the flat $0.01/credit. No seats, no
   * org-grain calls → Enterprise-only read permissions (the IT-acceptable least privilege).
   *
   * Chargeability is resolved at the ENTERPRISE grain (server/governance/verdict.ts,
   * resolveGithubVerdict with licenseOrg=null): the metrics record carries no per-user
   * license org, so ONE verdict applies to the whole enterprise, exactly as it always has
   * (pre-activation via the legacy per-enterprise heuristic; post-activation via
   * `provider_enterprise.billing`, which is enterprise-grain by construction — D11).
   */
  private async pullAppMetrics(days: DayKey[]): Promise<ReconciledLine[]> {
    const [identityByLogin, ctx] = await Promise.all([this.resolveRoster(), loadGovernanceResolutionContext(this.db)])
    const govKeyCache = createGovernanceKeyCache()
    const govKey = await resolveGithubGovernanceKey(this.db, govKeyCache, { enterpriseSlug: this.enterpriseRef })
    const chargebackExempt = resolveGithubVerdict(ctx, {
      providerEnterpriseId: govKey.providerEnterpriseId,
      enterpriseSlug: this.enterpriseRef,
      licenseOrg: null,
    }).exempt
    const lines: ReconciledLine[] = []

    for (const day of days) {
      let rows
      try {
        rows = await this.appClient!.getUserDailyCredits(day.iso)
      } catch (err) {
        // Isolate a single bad day (the whole-enterprise report) so it cannot starve the
        // rest of the window; it retries next tick. Surface the upstream surface + status.
        const detail = (err as { data?: { detail?: string } })?.data?.detail ?? String(err)
        console.warn(`[github-adapter] ${this.enterpriseRef} metrics users-1-day failed on ${day.iso}: ${detail}`)
        continue
      }
      for (const { login, credits, raw } of rows) {
        const teammateId = identityByLogin.get(login.toLowerCase())
        if (!teammateId) continue // unmatched login -> carry forward
        // Defensive: never book a non-finite / non-positive credit into amountUsd (the report
        // is the source of truth, but guard the money path). Mirrors the PAT gross<=0 skip.
        if (!Number.isFinite(credits) || credits <= 0) continue
        lines.push(
          normaliseMetricsCreditLine({
            enterpriseRef: this.enterpriseRef,
            teammateId,
            periodDate: day.iso,
            credits,
            login,
            chargebackExempt,
            raw,
          }),
        )
      }
    }
    return lines
  }
}

/** Adapter factory registered in registry.ts (ADAPTER_FACTORIES.github). */
export function createGithubAdapter(db: Db, scope: AdapterScope): Adapter {
  return new GithubAdapter(db, scope)
}

/*
 * Test seam: build the adapter with a stubbed client (no live GitHub calls). Accepts
 * either the PAT-mode read surface (listSeats + getAiCreditUsage) or the App-mode one
 * (getUserDailyCredits); the adapter picks the path by scope.credential.kind, so pass an
 * App-shaped stub WITH a kind:'github-app' scope.
 */
export function createGithubAdapterWithClient(
  db: Db,
  scope: AdapterScope,
  client: GithubPatClient | GithubAppClient,
): Adapter {
  return new GithubAdapter(db, scope, client)
}
