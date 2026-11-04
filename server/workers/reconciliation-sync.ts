/*
 * reconciliation-sync worker — the hourly driver. Iterates every RECONCILED
 * credential-scope (Anthropic per-org, GitHub per-enterprise), instantiates that
 * provider's adapter (if registered), pulls normalised lines for [yesterday, today]
 * (idempotent re-pull), and runs the platform-agnostic engine.
 *
 * Phase 0: ADAPTER_FACTORIES is empty, so this is a clean no-op (scopesRun: 0) —
 * exactly like analytics-poll with zero reconciled orgs. It begins reconciling the
 * moment Stream A / Stream B registers a factory. See docs/design/reconciliation-engine.md.
 */
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { sql } from 'drizzle-orm'
import type * as schema from '../../drizzle/schema'
import { runReconcileEngine } from '../reconciliation/engine'
import { ADAPTER_FACTORIES } from '../reconciliation/adapters/registry'
import { resolveOrgCredential, resolveEnterpriseCredential } from '../reconciliation/credentials'
import { runCopilotBillWriter, monthStartIso } from './copilot-bill'
import { resolveCopilotRatePlan } from '../governance/copilot-rate-plan'
import {
  GOV_RECONCILIATION_EPSILON_USD,
  GOV_RECONCILIATION_LAG_BUFFER_HOURS,
  resolveGovernanceSettings,
} from '../utils/governance-settings'
import { describeError } from '../utils/redact-probe-error'

type Db = PostgresJsDatabase<typeof schema>

export interface ReconcileSyncResult {
  scopesConsidered: number
  scopesRun: number
  scopesSkippedNoAdapter: number
  scopesSkippedNoCredential: number
  /** Scopes whose adapter pull / engine run threw — isolated so one bad scope
   * does not starve the rest of the run (re-attempted next tick). */
  scopesErrored: number
  /** Named so worker_run.rows_affected (extractRowsAffected) captures it. */
  rowsWritten: number
  // ADR-0010: Copilot flat-seat + overage rows written to actual_spend this run.
  copilotFlatRows: number
  copilotOverageRows: number
  copilotSeatsCarriedUnmapped: number
  // Engine aggregates summed across scopes — persisted to worker_run.result so the
  // run drill-down shows what reconciled vs didn't, and deriveRunWarnings surfaces the
  // skips (keys named to match run-warnings.ts).
  over: number
  under: number
  matched: number
  skippedInvalid: number
  skippedUnresolved: number
  // S9: seat-convergence prune rows deleted this run, summed across every github
  // enterprise scope (see copilot-bill.ts's CopilotBillResult.prunedRows).
  copilotSeatRowsPruned: number
  // S9: which credential kind resolveEnterpriseCredential selected for each github
  // scope this run — persisted on worker_run.result so a PAT-mode downgrade (an
  // App-opted enterprise that fell back, or an App key sitting unused because
  // github_app_id was never flipped) is visible in operator surfaces, not silent.
  githubAppCredentialScopes: number
  githubPatCredentialScopes: number
  githubCredentialMirrorWarnings: number
  // R2: seat-roster truncation, summed across github enterprise scopes. COUNTS, not
  // the per-enterprise booleans CopilotBillResult carries, because one tick spans
  // several enterprises (same shape as githubCredentialMirrorWarnings above).
  //
  // These MUST be aggregated here to be worth anything: copilot-bill is not its own
  // registry worker, so CopilotBillResult never becomes a worker_run.result — only
  // THIS object is persisted. deriveRunWarnings probing the booleans directly was
  // dead code, and the unit test hid that by hand-building a result object with the
  // keys already present instead of asserting what runReconciliationSync returns.
  copilotSeatPagesCapped: number
  copilotSeatPageShort: number
  // Count (not a flag): license orgs whose seat roster could not be read this run.
  // In App mode the per-org pull is isolated, so an unreadable org no longer aborts
  // the enterprise — which means this number is the ONLY thing that distinguishes
  // "that org has no seats" from "we could not see that org's seats", and it is a
  // precondition on the seat prune (copilot-bill.ts). Unaggregated it would be
  // exactly the dead counter the comment above describes.
  copilotSeatOrgsUnavailable: number
  /** Enterprises whose seat pull carried positive evidence of truncation (a page with
   *  no `seats` key, or fewer seats than the API's own total_seats). Same reason to
   *  aggregate as the counter above: CopilotBillResult is never persisted, so a prune
   *  precondition that stays on it is invisible to every operator surface. */
  copilotSeatRosterIncomplete: number
}

function utcDay(d: Date): string {
  return d.toISOString().slice(0, 10)
}

export async function runReconciliationSync(
  db: Db,
  opts?: { now?: Date; runId?: string | null },
): Promise<ReconcileSyncResult> {
  const now = opts?.now ?? new Date()
  const runId = opts?.runId ?? null // stamped onto reconciliation_record.run_id by the engine
  const endDate = utcDay(now)
  const y = new Date(now)
  y.setUTCDate(y.getUTCDate() - 1)
  const startDate = utcDay(y) // re-pull yesterday + today; the engine upsert is idempotent

  // Engine dials (mig 0049; platform defaults 0.01 USD / 48h), resolved once
  // per run and injected as options — the engine itself stays pure/injectable.
  const dials = await resolveGovernanceSettings(db, [
    GOV_RECONCILIATION_EPSILON_USD,
    GOV_RECONCILIATION_LAG_BUFFER_HOURS,
  ])
  const epsilonUsd = dials[GOV_RECONCILIATION_EPSILON_USD]
  const lagBufferHours = dials[GOV_RECONCILIATION_LAG_BUFFER_HOURS]

  const result: ReconcileSyncResult = {
    scopesConsidered: 0,
    scopesRun: 0,
    scopesSkippedNoAdapter: 0,
    scopesSkippedNoCredential: 0,
    scopesErrored: 0,
    rowsWritten: 0,
    copilotFlatRows: 0,
    copilotOverageRows: 0,
    copilotSeatsCarriedUnmapped: 0,
    over: 0,
    under: 0,
    matched: 0,
    skippedInvalid: 0,
    skippedUnresolved: 0,
    copilotSeatRowsPruned: 0,
    githubAppCredentialScopes: 0,
    githubPatCredentialScopes: 0,
    githubCredentialMirrorWarnings: 0,
    copilotSeatPagesCapped: 0,
    copilotSeatPageShort: 0,
    copilotSeatOrgsUnavailable: 0,
    copilotSeatRosterIncomplete: 0,
  }

  // Anthropic — credential grain is the org.
  const orgs = await db.execute<{ external_org_id: string }>(sql`
    SELECT external_org_id FROM provider_org
    WHERE provider = 'anthropic' AND reconciliation_mode = 'reconciled'
    ORDER BY external_org_id
  `)
  for (const o of orgs) {
    result.scopesConsidered += 1
    const factory = ADAPTER_FACTORIES.anthropic
    if (!factory) {
      result.scopesSkippedNoAdapter += 1
      continue
    }
    const credential = await resolveOrgCredential(db, {
      provider: 'anthropic',
      externalOrgId: o.external_org_id,
    })
    if (!credential) {
      result.scopesSkippedNoCredential += 1
      continue
    }
    try {
      // Thread the org's api_kind (mig 0063) onto the scope so the anthropic
      // adapter branches Enterprise-Analytics vs claude-code-admin. resolveOrgCredential
      // read it off provider_org alongside the credential.
      const adapter = factory(db, {
        externalRef: o.external_org_id,
        credential,
        apiKind: credential.apiKind ?? null,
      })
      const lines = await adapter.pull({ startDate, endDate })
      const r = await runReconcileEngine(db, lines, { now, runId, epsilonUsd, lagBufferHours })
      result.rowsWritten += r.recordsWritten
      result.over += r.over
      result.under += r.under
      result.matched += r.matched
      result.skippedInvalid += r.skippedInvalid
      result.skippedUnresolved += r.skippedUnresolved
      result.scopesRun += 1
    } catch (err) {
      // Isolate one bad scope so it cannot starve the rest of the run (the hourly
      // re-pull retries it next tick); surface it so a persistently-failing scope
      // is visible in logs, not a silent green run.
      result.scopesErrored += 1
      console.warn(`[reconciliation-sync] anthropic scope ${o.external_org_id} failed: ${describeError(err)}`)
    }
  }

  // GitHub — credential grain is the enterprise (one PAT reads all child orgs).
  // Workstream C: the flat-seat showback writer resolves its price from the
  // effective-dated rate plan (server/governance/copilot-rate-plan.ts) keyed on
  // THIS run's write month, not the raw provider_enterprise scalar — a later
  // rate-plan change must never re-cost a month whose showback row already wrote.
  const ents = await db.execute<{
    id: string
    external_id: string
  }>(sql`
    SELECT id::text AS id, external_id FROM provider_enterprise
    WHERE provider = 'github' AND reconciliation_mode = 'reconciled'
    ORDER BY external_id
  `)
  for (const e of ents) {
    result.scopesConsidered += 1
    const factory = ADAPTER_FACTORIES.github
    if (!factory) {
      result.scopesSkippedNoAdapter += 1
      continue
    }
    // UF-20: resolveEnterpriseCredential THROWS (MissingGithubAppKeyError) for an
    // enterprise that opted into App mode with the key unwired — deliberately
    // fail-loud, never a silent PAT downgrade. Unguarded, that one enterprise's
    // config gap aborted every REMAINING scope in the tick and failed the whole
    // worker_run: a config problem on one enterprise stopped reconciling the
    // others. Isolated per-enterprise exactly like copilot-pool-bill.ts:611-618,
    // and onto the SAME scopesErrored counter the pull/engine catch below uses,
    // so a persistently-unwired enterprise is visible in worker_run.result rather
    // than only in a log line.
    let credential
    try {
      credential = await resolveEnterpriseCredential(db, {
        provider: 'github',
        externalId: e.external_id,
      })
    } catch (err) {
      result.scopesErrored += 1
      console.warn(`[reconciliation-sync] github credential resolve failed for ${e.external_id}: ${describeError(err)}`)
      continue
    }
    if (!credential) {
      result.scopesSkippedNoCredential += 1
      continue
    }
    // S9: record the SELECTED credential kind on worker_run.result so a downgrade
    // (an App-opted enterprise that fell back to PAT, or a PAT enterprise sitting on
    // an unused App key — credentials.ts's silent-mirror warning) is visible in
    // operator surfaces rather than only a console line.
    if (credential.kind === 'github-app') result.githubAppCredentialScopes += 1
    else result.githubPatCredentialScopes += 1
    if (credential.appKeyMirrorWarning) result.githubCredentialMirrorWarnings += 1
    try {
      const adapter = factory(db, { externalRef: e.external_id, credential })
      const lines = await adapter.pull({ startDate, endDate })
      const r = await runReconcileEngine(db, lines, { now, runId, epsilonUsd, lagBufferHours })
      result.rowsWritten += r.recordsWritten
      result.over += r.over
      result.under += r.under
      result.matched += r.matched
      result.skippedInvalid += r.skippedInvalid
      result.skippedUnresolved += r.skippedUnresolved
      result.scopesRun += 1

      // ADR-0010 / reporting-consolidation Wave 0: the flat per-seat SHOWBACK rows in
      // actual_spend (display-only; the pooled §B chargeback is copilot_pool_bill, written by
      // the copilot-pool-bill worker). Own try/catch — a bill-writer hiccup must not undo the
      // reconciliation that already committed. Runs every tick; rows are dated the 1st and
      // upserted, so re-runs refresh idempotently. (The per-user overage charge was removed —
      // WRONG model #1; overageRowsWritten is always 0.)
      try {
        const ratePlan = await resolveCopilotRatePlan(db, {
          providerEnterpriseId: e.id,
          periodMonth: monthStartIso(now),
        })
        const bill = await runCopilotBillWriter(db, {
          enterpriseSlug: e.external_id,
          // S9: pass the WHOLE resolved credential — copilot-bill.ts branches on
          // .kind exactly like copilot-pool-bill.ts does. Flattening to .value here
          // (the old shape) fed the GitHub App private key to withPat as a Bearer
          // token whenever this enterprise was App-mode.
          credential,
          now,
          // Workstream C: period-aware (design C3 — closed-month recompute
          // stability), never the raw provider_enterprise scalar directly.
          flatSeatPriceUsd: ratePlan.flatSeatPriceUsd,
        })
        result.copilotSeatRowsPruned += bill.prunedRows
        result.rowsWritten += bill.flatRowsWritten + bill.overageRowsWritten
        result.copilotFlatRows += bill.flatRowsWritten
        result.copilotOverageRows += bill.overageRowsWritten
        result.copilotSeatsCarriedUnmapped += bill.seatsCarriedUnmapped
        if (bill.seatPagesCapped) result.copilotSeatPagesCapped += 1
        if (bill.seatPageShort) result.copilotSeatPageShort += 1
        result.copilotSeatOrgsUnavailable += bill.seatOrgsUnavailable
        if (bill.seatRosterIncomplete) result.copilotSeatRosterIncomplete += 1
      } catch (err) {
        console.warn(`[reconciliation-sync] copilot bill writer ${e.external_id} failed: ${describeError(err)}`)
      }
    } catch (err) {
      result.scopesErrored += 1
      console.warn(`[reconciliation-sync] github scope ${e.external_id} failed: ${describeError(err)}`)
    }
  }

  return result
}
