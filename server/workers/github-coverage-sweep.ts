/*
 * github-coverage-sweep — scheduled, bounded GitHub enterprise-org coverage detection
 * (Workstream D, design §6/§8.4: "so gaps are detected without an admin visit").
 *
 * For every registered GitHub provider_enterprise: compute LIVE coverage
 * (github-coverage.ts, App-mode only — a PAT enterprise short-circuits cheaply to
 * census-unavailable with no network calls), persist the result as the new latest
 * observation (coverage-store.ts), and — comparing against what was persisted BEFORE
 * this write — dispatch a DEDUPLICATED admin inbox alert exactly on a transition into a
 * non-connected state or a capability loss, auto-resolving when an org/enterprise
 * recovers. The PRIOR-vs-NEW comparison IS the dedup key: an org stuck in the same
 * non-connected state tick-over-tick never re-alerts; only a genuine change does.
 *
 * BOUNDED (requirement 5): per-enterprise work is bounded by
 * computeEnterpriseCoverage's own MAX_ORG_PROBES_PER_PASS + the census client's
 * pagination hard cap (github-coverage.ts / github-client.ts) — this worker adds no
 * further unbounded loop; the number of ENTERPRISES swept per tick is bounded by how
 * many are registered (an operator-controlled quantity, not attacker-controlled),
 * mirroring copilot-pool-bill.ts's per-tick enterprise loop.
 *
 * SECRETS NEVER LEAK: every value persisted/dispatched is a login, uuid, boolean,
 * count, or classified enum — computeEnterpriseCoverage already enforces this; this
 * worker adds no new secret-adjacent read.
 */
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { sql } from 'drizzle-orm'
import { consola } from 'consola'
import type * as schema from '../../drizzle/schema'
import { computeEnterpriseCoverage, type CoverageEnterpriseRow } from '../reconciliation/github-coverage'
import {
  persistEnterpriseCoverage,
  loadPersistedEnterpriseCoverage,
  type PersistedEnterpriseCoverage,
} from '../reconciliation/coverage-store'
import { reconcileCoverageTransitions } from '../reconciliation/coverage-alerts'
import { describeError } from '../utils/redact-probe-error'

type Db = PostgresJsDatabase<typeof schema>

export interface GithubCoverageSweepResult {
  enterprisesSwept: number
  /** Enterprises whose live compute itself threw (an OUR-side bug, not a classified
   *  census/installation state — computeEnterpriseCoverage should never throw, so a
   *  non-zero count here is itself a run-warning-worthy signal). */
  coverageComputeErrors: number
  /** Snapshot AFTER this sweep: total orgs currently classified non-connected across
   *  every swept enterprise (a run-warning trigger; requirement per design §6). */
  nonConnectedOrgs: number
  /** Snapshot AFTER this sweep: enterprises whose census is currently unavailable
   *  (no denominator can be claimed) — a run-warning trigger distinct from a single
   *  org gap. */
  censusUnknownEnterprises: number
  /** Alerts freshly dispatched THIS tick (a genuine transition into a non-connected
   *  state, or a fresh capability loss) — deduplicated against the PRIOR observation. */
  newAlerts: number
  /** Inbox alerts auto-resolved THIS tick (an org/enterprise recovered). */
  autoResolved: number
}

/** Every currently-registered GitHub provider_enterprise (App or PAT mode). */
async function loadGithubEnterprises(db: Db): Promise<CoverageEnterpriseRow[]> {
  const rows = await db.execute<{ id: string; external_id: string; github_app_id: string | null }>(sql`
    SELECT id::text AS id, external_id, github_app_id
    FROM provider_enterprise WHERE provider = 'github' ORDER BY display_name, id
  `)
  return [...rows].map((r) => ({ enterpriseId: r.id, externalId: r.external_id, githubAppId: r.github_app_id }))
}

export async function runGithubCoverageSweep(
  db: Db,
  opts?: { now?: Date; regionId?: string },
): Promise<GithubCoverageSweepResult> {
  const now = opts?.now ?? new Date()

  const enterprises = await loadGithubEnterprises(db)
  let coverageComputeErrors = 0
  let nonConnectedOrgs = 0
  let censusUnknownEnterprises = 0
  let newAlerts = 0
  let autoResolved = 0

  for (const ent of enterprises) {
    let prior: PersistedEnterpriseCoverage
    try {
      prior = await loadPersistedEnterpriseCoverage(db, ent.enterpriseId, { now })
    } catch (err) {
      // A DB read failing is OUR infrastructure, not a classified state — isolate this
      // enterprise (like copilot-pool-bill.ts does per (enterprise, month)) and move on.
      coverageComputeErrors += 1
      consola.warn(`[github-coverage-sweep] failed to load prior coverage for '${ent.externalId}': ${describeError(err)}`)
      continue
    }
    let result
    try {
      result = await computeEnterpriseCoverage(db, ent)
    } catch (err) {
      coverageComputeErrors += 1
      consola.warn(`[github-coverage-sweep] compute failed for '${ent.externalId}': ${describeError(err)}`)
      continue
    }

    const transitions = await db.transaction(async (tx) => {
      await persistEnterpriseCoverage(tx, result, { now })
      return reconcileCoverageTransitions(tx, ent, prior, result, now)
    })
    nonConnectedOrgs += transitions.nonConnectedOrgs
    newAlerts += transitions.newAlerts
    autoResolved += transitions.autoResolved

    if (!result.census.available) censusUnknownEnterprises += 1
  }

  return { enterprisesSwept: enterprises.length, coverageComputeErrors, nonConnectedOrgs, censusUnknownEnterprises, newAlerts, autoResolved }
}
