/*
 * Copilot flat-seat writer — SHOWBACK / DISPLAY-ONLY per-seat rows → actual_spend.
 *
 * SUPERSEDED FOR CHARGEBACK (reporting-consolidation Wave 0 / canonical §B): the Copilot
 * CHARGEBACK now comes from EXACTLY ONE surface — copilot_pool_bill (the POOLED bill net, read
 * by the copilot-pool-bill worker) — homed org→CoU. The per-seat rows this writer emits are
 * SHOWBACK / DISPLAY-ONLY: they are excluded from v_finance_bill_chargeback, from
 * v_finance_chargeback_month, and from the Σ=bill operand (test-enforced). The per-user OVERAGE
 * charge (`usage − $allowance`) that this writer used to emit was WRONG model #1
 * (docs/design/provider-billing-attribution-model.md §B) and has been REMOVED; the pooled
 * overage authority is copilot_pool_bill.overage_net_usd (read from the bill). The mig 0081
 * migration deletes the legacy source='copilot-overage' rows.
 *
 * What remains here: the whole-month flat per-seat rows (D1: a seat active any day owes the full
 * month), source='copilot-seat:<org>', tool='copilot-cli'. These are kept as a showback/display
 * signal only (a manager's "every dollar my people consume" view, rule 3); they are NOT a
 * chargeback figure and NEVER feed the pooled §B charge. Both dated the 1st of the month → a
 * re-run UPSERTS the same row (idempotent); each month gets its own set.
 *
 * NOTE (D-Showback): the owner decision REPLACES the per-seat showback rows with the §A-sanctioned
 * per-user usage display (the ai-credit usage lane, v_teammate_usage_daily copilot branch) in
 * user-facing lanes. This writer is retained for backward compatibility of the showback lane
 * until that display lands (Wave 5); its rows are firewalled out of every chargeback operand now.
 *
 * chargeback_exempt is still set from the license-org so NFR/exempt Copilot cost is shown in
 * showback (rule 3) but excluded from chargeback (rule 5) — the flag lives on the row; the
 * exclusion lives in the chargeback view. (Copilot is now excluded from chargeback wholesale by
 * tool anyway; the flag remains meaningful for the showback lane.)
 *
 * SEAT CONVERGENCE (S9): earlier versions only ever upserted rows for seats present in THIS
 * tick's roster and never deleted a row it did not re-assert — a seat removal, a login
 * rebind, or an org moving off the enterprise left the OLD showback row live forever (double
 * showback: the report/theme-5-duplicate-seat finding). runCopilotBillWriter now runs a
 * guarded stale-row prune after the seat loop, in the SAME successful run, scoped to this
 * enterprise's provider_org set (not just orgs seen this tick) — see the guard block below for
 * the preconditions (six, as of UF-19 + the roster-integrity flag). It is a DELETE on a
 * money table; every precondition exists because
 * an empty/short seats pull is NOT reliably an error signal (github-client.ts's
 * listSeatsWithDiagnostics).
 *
 * TWO SEAT SOURCES, ONE PER CREDENTIAL KIND (UF-19). The enterprise seats endpoint
 * (listSeats / listSeatsWithDiagnostics) is a PAT surface: it always presents a Bearer
 * PAT header, and a withApp()-constructed client holds no PAT — so an App-mode
 * enterprise 401'd here and its flat-seat showback never populated. This writer now
 * branches on credential.kind at the SEAT-DATA path the same way it already branched at
 * the credential-CONSTRUCTION path. (github.ts and github-identity.ts both branch the
 * data path too; the per-org SEAT surface used here is github-identity.ts's App path.
 * github.ts's App path reads a different surface again — the users-1-day metrics
 * report — because it is after per-user CONSUMPTION, not the seat roster.)
 *   - PAT mode: ONE enterprise pull (unchanged; seat.organization = the license org).
 *   - App mode: listOrgCopilotSeatsWithDiagnostics(org) per ONBOARDED license org
 *     (provider_org), each read with that org's installation token. The license org is
 *     the org we queried, so the `copilot-seat:<org>` source key is identical in both
 *     modes and a PAT→App cutover does not orphan a single showback row.
 * App mode adds a THIRD way the roster can be incomplete — an org whose seats could not
 * be read at all (App not installed/suspended, or the pull threw). Those orgs are
 * isolated (their seats simply carry forward) and counted onto
 * `seatOrgsUnavailable`, which is a prune precondition: an unknown org roster must
 * never be read as "that org's seats are gone".
 */
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { sql } from 'drizzle-orm'
import { consola } from 'consola'
import type * as schema from '../../drizzle/schema'
import { GithubCopilotClient } from '../reconciliation/adapters/github-client'
import { GithubAppAuth } from '../reconciliation/adapters/github-app-auth'
import type { ResolvedCredential } from '../reconciliation/credentials'
import { seatLicenseOrg } from '../reconciliation/adapters/github'
import { createGovernanceKeyCache, resolveGithubGovernanceKey, type GovernanceKeyRef } from '../reconciliation/governance-keys'
import { loadGovernanceResolutionContext, resolveGithubVerdict } from '../governance/verdict'
import {
  teammateDimensionSnapshotSql,
  DIMENSION_SOURCE_INGEST_SNAPSHOT,
} from '../reconciliation/dimension-snapshot'
import { recordAuditEvent } from '../db/audit'
import { describeError } from '../utils/redact-probe-error'

type Db = PostgresJsDatabase<typeof schema>

/*
 * The seat surfaces this writer reads, one per credential kind (see the module header).
 * BOTH optional so a test seam can stub exactly the one its mode uses — and so an
 * App-mode stub can prove the PAT surface is never touched by omitting it (or by
 * supplying one that throws). The real GithubCopilotClient satisfies both.
 */
export type CopilotBillSeatClient = Partial<
  Pick<GithubCopilotClient, 'listSeatsWithDiagnostics' | 'listOrgCopilotSeatsWithDiagnostics'>
>

export interface CopilotBillOptions {
  enterpriseSlug: string
  /** The RESOLVED credential (PAT or App key) — branch on `.kind`, exactly as
   *  copilot-pool-bill.ts does. S9: this used to be flattened to the raw string
   *  (`credential.value`) by the caller and handed to withPat, which — in App mode —
   *  fed the GitHub App PRIVATE KEY to withPat as if it were a PAT. UF-19: the same
   *  `.kind` now also selects the SEAT SOURCE (enterprise pull vs per-org pull). */
  credential: ResolvedCredential
  /** Run clock; the bill rows are dated the 1st of this month (D1/M2). */
  now: Date
  /** ADR-0010 D1: whole-month flat per-seat price (provider_enterprise config). NULL → no flat row. */
  flatSeatPriceUsd: number | null
  /** Test seam: stub the seat pull (no live GitHub call). */
  clientOverride?: CopilotBillSeatClient
}

export interface CopilotBillResult {
  seatsTotal: number
  seatsResolved: number
  /** Seats whose login isn't bound to a teammate yet (identity-sync provisions them next run). */
  seatsCarriedUnmapped: number
  flatRowsWritten: number
  /** Always 0 — the per-user overage charge (WRONG model #1) was removed; the pooled overage
   *  is copilot_pool_bill.overage_net_usd. Kept for result-shape stability. */
  overageRowsWritten: number
  /** S9 seat-convergence prune: actual_spend copilot-seat rows deleted this run because
   *  the seat/org they were written for is no longer present for this enterprise (seat
   *  removed, rebind, or org moved off this enterprise entirely) — see the guard block
   *  in runCopilotBillWriter for the preconditions that gate this DELETE. */
  prunedRows: number
  /** The seats pull hit the 100-page (10,000-seat) hard cap this run — the roster MAY
   *  be truncated (github-client.ts's pullSeats). */
  seatPagesCapped: boolean
  /** The seat pull carried positive evidence of truncation — a prune precondition. */
  seatRosterIncomplete: boolean
  /** The seats pull ended via a short page — the normal end-of-roster signal, but
   *  indistinguishable at that layer from a partial/empty pull. Surfaced so a
   *  suspiciously small seatsTotal can be cross-checked against this. In App mode this
   *  is the OR across the per-org pulls (any org that ended short). */
  seatPageShort: boolean
  /** App mode only (UF-19): onboarded license orgs whose seat roster could NOT be read
   *  this run — the App is not installed/is suspended on the org, or its pull threw.
   *  Their seats carry forward. >0 means the roster is INCOMPLETE for reasons the
   *  pagination flags cannot express, so the seat-convergence prune is skipped. Always
   *  0 in PAT mode (one enterprise-wide call: it either succeeds or throws). */
  seatOrgsUnavailable: number
}

/** Exported (Workstream C): reconciliation-sync.ts uses this to resolve the SAME
 *  calendar month's effective-dated rate plan the showback row will be dated. */
export function monthStartIso(now: Date): string {
  const y = now.getUTCFullYear()
  const m = String(now.getUTCMonth() + 1).padStart(2, '0')
  return `${y}-${m}-01`
}

/* login (lowercased) → teammateId for this enterprise, from the directory-seeded identity
 * map (github-identity.ts is the writer). Same read the reconciliation adapter uses.
 *
 * TWO LANES, enterprise-lane authoritative (identity-tail layer 2): reads BOTH the
 * directory-sync/admin enterprise lane (enterprise_slug = the slug) AND the self-service lane
 * (enterprise_slug IS NULL, source='self'), so a seat-holder who self-linked their github login
 * also has their flat-seat showback attributed. When both lanes hold the SAME login the
 * ENTERPRISE lane wins (DISTINCT ON + `(enterprise_slug IS NULL) ASC`) — a self-link only ever
 * ADDS a login, never overrides the authoritative binding. Mirrors resolveGithubRoster in
 * server/reconciliation/adapters/github.ts (kept in lock-step — both feed Copilot attribution).
 * The self lane is estate-global + unverified: §A showback only. The seat-share overage split
 * reads these rows but homes a self-only seat as Unallocated (see resolveGithubRoster). */
async function resolveRoster(db: Db, enterpriseSlug: string): Promise<Map<string, string>> {
  const rows = await db.execute<{ login: string; teammate_id: string }>(sql`
    SELECT DISTINCT ON (lower(identifier))
           lower(identifier) AS login, teammate_id::text AS teammate_id
    FROM teammate_identity_map
    WHERE system = 'github'
      AND (lower(enterprise_slug) = lower(${enterpriseSlug}) OR enterprise_slug IS NULL)
    ORDER BY lower(identifier), (enterprise_slug IS NULL) ASC
  `)
  const map = new Map<string, string>()
  for (const r of rows) map.set(r.login, r.teammate_id)
  return map
}

/* Idempotent actual_spend upsert for a Copilot flat-seat showback row. Carries category +
 * chargeback_exempt (ADR-0010). Tokens are 0 — a flat license is a USD figure, not tokens.
 * Dimension snapshot (mig 0101): stamped on INSERT only, omitted from the ON CONFLICT SET
 * list — see the analogous note in analytics-poller.ts's upsertActualSpend. */
async function upsertCopilotBillRow(
  db: Db,
  row: {
    teammateId: string
    date: string
    source: string
    category: string
    costUsd: number
    chargebackExempt: boolean
    governanceVerdictSource: string
    governanceKey: GovernanceKeyRef
    raw: unknown
  },
): Promise<boolean> {
  const teammateIdSql = sql`${row.teammateId}::uuid`
  const dims = teammateDimensionSnapshotSql(teammateIdSql)
  const result = await db.execute<{ id: string }>(sql`
    INSERT INTO actual_spend
      (teammate_id, date, tool, input_tokens, output_tokens, cost_usd, source, category, chargeback_exempt, raw_payload,
       region_id, org_unit_id, cost_owning_unit_id, dimension_source,
       provider_org_id, provider_enterprise_id, governance_key_status, governance_verdict_source)
    VALUES
      (${row.teammateId}::uuid, ${row.date}::date, 'copilot-cli', 0::bigint, 0::bigint,
       ${row.costUsd.toFixed(6)}::numeric, ${row.source}, ${row.category}, ${row.chargebackExempt},
       ${JSON.stringify(row.raw)}::jsonb,
       ${dims.regionId}, ${dims.orgUnitId}, ${dims.costOwningUnitId}, ${DIMENSION_SOURCE_INGEST_SNAPSHOT},
       ${row.governanceKey.providerOrgId}::uuid, ${row.governanceKey.providerEnterpriseId}::uuid,
       ${row.governanceKey.providerEnterpriseId ? 'resolved' : 'unresolved'}, ${row.governanceVerdictSource})
    ON CONFLICT (teammate_id, date, tool, source)
    DO UPDATE SET
      cost_usd = EXCLUDED.cost_usd,
      category = EXCLUDED.category,
      raw_payload = EXCLUDED.raw_payload,
      pulled_at = NOW(),
      provider_org_id = EXCLUDED.provider_org_id,
      provider_enterprise_id = EXCLUDED.provider_enterprise_id,
      governance_key_status = EXCLUDED.governance_key_status,
      -- The verdict refreshes like any other field. It used to be frozen once a
      -- period closed, so a late seat correction updated the cost and left a
      -- stale classification beside it — two halves of one row disagreeing about
      -- which month they belong to. A recorded month that moves now reports the
      -- difference (mig 0128) instead of being prevented from moving.
      chargeback_exempt = EXCLUDED.chargeback_exempt,
      governance_verdict_source = EXCLUDED.governance_verdict_source
    RETURNING id::text AS id
  `)
  return result.length > 0
}


/*
 * The seat-convergence prune's org-scope guard skips the DELETE when an outsized share
 * of this run's roster failed to bind a teammate (mirrors PRUNE_MAX_SKIP_RATIO in
 * analytics-poller.ts) — a broken identity-resolution run must never be read as "the
 * seats are gone".
 */
const PRUNE_MAX_SKIP_RATIO = 0.5

/*
 * The enterprise's github license-org set, from provider_org (NOT just the orgs seen
 * in THIS run's roster) — so an org that vanished from the roster ENTIRELY (not merely
 * rebound or moved within it) is still covered by the prune scope. Lowercased (canonical
 * per mig 0064, matches orgKey's `.toLowerCase()`).
 */
async function enterpriseOrgSet(db: Db, enterpriseSlug: string): Promise<string[]> {
  const rows = await db.execute<{ org: string }>(sql`
    SELECT DISTINCT lower(po.external_org_id) AS org
    FROM provider_org po
    JOIN provider_enterprise pe ON pe.id = po.provider_enterprise_id
    WHERE po.provider = 'github' AND pe.provider = 'github' AND lower(pe.external_id) = lower(${enterpriseSlug})
    ORDER BY org
  `)
  return rows.map((r) => r.org)
}

/*
 * One enterprise's seat roster, NORMALISED across both credential kinds: the writer
 * downstream of this only ever sees (login, licenseOrg) plus the flags that say how far
 * to trust it, so the seat loop and the prune are mode-agnostic.
 */
interface SeatRosterPull {
  seats: Array<{ login: string; licenseOrg: string | null }>
  pagesCapped: boolean
  shortPageBreak: boolean
  /** Positive evidence the roster was not fully read (missing `seats` key, or fewer
   *  seats than the API's own `total_seats`). A prune precondition — unlike
   *  shortPageBreak, which is true for every normal roster under 100 seats. */
  rosterIncomplete: boolean
  orgsUnavailable: number
}

/*
 * UF-19: read the seat roster with the credential kind's OWN surface.
 *
 * PAT mode is the unchanged enterprise pull. App mode iterates the enterprise's
 * ONBOARDED license orgs (the same provider_org → provider_enterprise enumeration
 * github-identity.ts's App path walks) and reads each org's seats with that org's
 * installation token, because the enterprise seats endpoint presents a Bearer PAT header
 * that an App-mode client does not have.
 *
 * Per-org failures are ISOLATED (one bad org must not cost the enterprise every other
 * org's showback) and COUNTED — a counted org is one whose roster we do not know, which
 * is a different thing from one we know to be empty, and the prune must not confuse them.
 */
async function pullSeatRoster(
  client: CopilotBillSeatClient,
  credential: ResolvedCredential,
  enterpriseSlug: string,
  orgSet: string[],
): Promise<SeatRosterPull> {
  if (credential.kind !== 'github-app') {
    if (!client.listSeatsWithDiagnostics) {
      throw new Error('copilot-bill: PAT mode requires a client exposing listSeatsWithDiagnostics')
    }
    const pull = await client.listSeatsWithDiagnostics()
    return {
      seats: pull.seats.map((s) => ({ login: s.assignee.login, licenseOrg: seatLicenseOrg(s) })),
      pagesCapped: pull.pagesCapped,
      shortPageBreak: pull.shortPageBreak,
      rosterIncomplete: pull.rosterIncomplete,
      orgsUnavailable: 0,
    }
  }

  if (!client.listOrgCopilotSeatsWithDiagnostics) {
    throw new Error('copilot-bill: App mode requires a client exposing listOrgCopilotSeatsWithDiagnostics')
  }
  const readOrgSeats = client.listOrgCopilotSeatsWithDiagnostics.bind(client)
  if (orgSet.length === 0) {
    // No license org onboarded ⇒ nothing to read. A legible warn, not a throw and not a
    // silent success: seatsTotal stays 0, which the prune already refuses to act on.
    consola.warn(
      `[copilot-bill] ${enterpriseSlug} App mode: no license orgs onboarded (provider_org) — no seats to bill`,
    )
    return { seats: [], pagesCapped: false, shortPageBreak: false, rosterIncomplete: false, orgsUnavailable: 0 }
  }
  const seats: SeatRosterPull['seats'] = []
  let pagesCapped = false
  let shortPageBreak = false
  let rosterIncomplete = false
  let orgsUnavailable = 0
  for (const org of orgSet) {
    try {
      const pull = await readOrgSeats(org)
      if (!pull.installed) {
        // The App is not installed (or is suspended) on this org: no seats call was made,
        // so this org's roster is UNKNOWN. Counted, never read as "no seats here".
        orgsUnavailable += 1
        consola.warn(`[copilot-bill] ${enterpriseSlug} App mode: App not installed on license org '${org}' — its seats carry forward`)
        continue
      }
      // The license org is the org we QUERIED, so it agrees with provider_org's canonical
      // lowercase and with the PAT path's lowercased seat.organization.login → the
      // `copilot-seat:<org>` source key is identical across a PAT→App cutover.
      for (const s of pull.seats) seats.push({ login: s.login, licenseOrg: org })
      pagesCapped = pagesCapped || pull.pagesCapped
      shortPageBreak = shortPageBreak || pull.shortPageBreak
      rosterIncomplete = rosterIncomplete || pull.rosterIncomplete
    } catch (err) {
      orgsUnavailable += 1
      consola.warn(`[copilot-bill] ${enterpriseSlug} App mode: seat pull failed for license org '${org}': ${describeError(err)}`)
    }
  }
  return { seats, pagesCapped, shortPageBreak, rosterIncomplete, orgsUnavailable }
}

export async function runCopilotBillWriter(db: Db, opts: CopilotBillOptions): Promise<CopilotBillResult> {
  const result: CopilotBillResult = {
    seatsTotal: 0,
    seatsResolved: 0,
    seatsCarriedUnmapped: 0,
    flatRowsWritten: 0,
    overageRowsWritten: 0,
    prunedRows: 0,
    seatPagesCapped: false,
    seatRosterIncomplete: false,
    seatPageShort: false,
    seatOrgsUnavailable: 0,
  }

  const monthStart = monthStartIso(opts.now)

  // DB-CLOCK start marker for the seat-convergence prune below — mirrors
  // analytics-poller.ts:353-359 verbatim. pulled_at is written by NOW() (below), so the
  // "not re-asserted this run" marker must be DB time too: an app-clock runStarted
  // running ahead of DB time would delete rows THIS run just wrote. Read BEFORE the
  // seats pull so a slow/retried API call cannot widen the prune window. THROWS on
  // failure — a run that cannot establish its own clock must not guess at one.
  const [clock] = await db.execute<{ run_started: string }>(sql`SELECT now()::timestamptz AS run_started`)
  if (!clock) throw new Error('copilot-bill: could not read DB clock for the prune marker')
  const runStarted = clock.run_started

  // S9: branch on the RESOLVED credential kind exactly as copilot-pool-bill.ts does —
  // never flatten to `.value` and hand it to withPat (that fed the App private key to
  // withPat as a Bearer token at this call site and at discover-orgs.post.ts).
  const client: CopilotBillSeatClient =
    opts.clientOverride ??
    (opts.credential.kind === 'github-app'
      ? GithubCopilotClient.withApp(opts.enterpriseSlug, new GithubAppAuth(opts.credential.appId!, opts.credential.value))
      : GithubCopilotClient.withPat(opts.enterpriseSlug, opts.credential.value))
  // The enterprise's provider_org set is read ONCE, BEFORE the pull: App mode enumerates
  // the orgs to pull seats FROM it (UF-19), and the prune below is scoped to it. One read
  // for both keeps the two in agreement — re-reading it after a slow pull could hand the
  // DELETE an org whose seats this run never even attempted.
  const orgSet = await enterpriseOrgSet(db, opts.enterpriseSlug)
  const [seatPull, roster] = await Promise.all([
    pullSeatRoster(client, opts.credential, opts.enterpriseSlug, orgSet),
    resolveRoster(db, opts.enterpriseSlug),
  ])
  const seats = seatPull.seats
  result.seatPagesCapped = seatPull.pagesCapped
  result.seatPageShort = seatPull.shortPageBreak
  result.seatRosterIncomplete = seatPull.rosterIncomplete
  result.seatOrgsUnavailable = seatPull.orgsUnavailable

  const govCtx = await loadGovernanceResolutionContext(db)
  const govKeyCache = createGovernanceKeyCache()

  for (const seat of seats) {
    result.seatsTotal += 1
    const login = seat.login
    const teammateId = roster.get(login.toLowerCase())
    if (!teammateId) {
      // Unmapped: identity-sync (with bill-driven provisioning) binds the login next run,
      // then this writer attributes the seat. Counted, not silently dropped.
      result.seatsCarriedUnmapped += 1
      continue
    }
    result.seatsResolved += 1

    const licenseOrg = seat.licenseOrg
    const orgKey = licenseOrg?.toLowerCase() ?? 'unknown'
    const governanceKey = await resolveGithubGovernanceKey(db, govKeyCache, {
      enterpriseSlug: opts.enterpriseSlug,
      licenseOrg,
    })
    const verdict = resolveGithubVerdict(govCtx, {
      providerEnterpriseId: governanceKey.providerEnterpriseId,
      enterpriseSlug: opts.enterpriseSlug,
      licenseOrg,
    })

    // Flat seat (D1: whole-month, no proration) — PER SEAT, SHOWBACK/DISPLAY-ONLY. One row per
    // (teammate, org). NOT a chargeback figure (the pooled §B charge is copilot_pool_bill).
    if (opts.flatSeatPriceUsd != null) {
      const wrote = await upsertCopilotBillRow(db, {
        teammateId,
        date: monthStart,
        source: `copilot-seat:${orgKey}`,
        category: 'seat-license',
        costUsd: opts.flatSeatPriceUsd,
        chargebackExempt: verdict.exempt,
        governanceVerdictSource: verdict.source,
        governanceKey,
        raw: { kind: 'flat-seat', login, licenseOrg, month: monthStart, priceUsd: opts.flatSeatPriceUsd, showbackOnly: true },
      })
      if (wrote) result.flatRowsWritten += 1
    }
  }

  /*
   * SEAT-CONVERGENCE PRUNE (S9) — mirrors the Claude lane's stale-row prune
   * (analytics-poller.ts:495-521), converging showback to seats that ACTUALLY still
   * exist (seat removed, login rebound, or an org moved off this enterprise). THREE
   * preconditions gate the DELETE — one more than the Claude lane needs, because
   * `listSeats()`/`listSeatsWithDiagnostics()` can return a short OR EMPTY roster
   * WITHOUT THROWING, three separate ways (the `seats` schema default([]) on a 200
   * missing/renaming the key, a short-page break, the 100-page hard cap). An
   * enterprise with genuinely zero seats is INDISTINGUISHABLE from an API-shape change
   * or a partial outage at this layer, so "no seats came back" must NEVER be read as
   * "no seats exist". A mechanical port of the Claude lane's guard alone
   * (`skipRatio = total > 0 ? skipped / total : 0`, prune when `<= 0.5`) prunes on
   * `total === 0` (ratio 0 <= 0.5) — deliberate there, WRONG here (see
   * analytics-poller.ts:480-481 vs the empty-roster contract above):
   *
   *   1. seatsTotal > 0, EXPLICITLY — the guard the Claude lane does not need.
   *   2. seatsCarriedUnmapped / seatsTotal <= PRUNE_MAX_SKIP_RATIO — an outsized share
   *      of unmapped logins means identity resolution looks broken, not that the
   *      seats are gone.
   *   3. listSeats() throwing aborts BEFORE this point, unswallowed — a genuine pull
   *      failure never reaches the prune (there is no try/catch around the pull above).
   *      App mode weakens that guarantee ON PURPOSE: a per-org pull failure is isolated
   *      so one bad org cannot cost the enterprise every other org's showback, which
   *      means a failure CAN reach this point. Precondition 5 is what replaces the
   *      abort for those — see below.
   *
   * Scope is the ENTERPRISE'S org set from provider_org, not merely the orgs seen in
   * THIS run's roster — so an org that vanished from the roster ENTIRELY is still
   * covered, not only a rebind or an org-move within a roster that still lists it.
   *
   * KNOWN UNDER-DELETE (documented, not "fixed" here — the safe direction): a seat with
   * no resolvable license org writes source='copilot-seat:unknown' (see orgKey above),
   * which this provider_org-keyed filter never matches, so those rows are never pruned
   * by this pass. Widening the filter to a `LIKE 'copilot-seat:%'` was explicitly
   * rejected — that would delete a DIFFERENT enterprise's org rows sharing the same
   * `actual_spend` table. This lane does not fully converge; it converges everything
   * except the unresolved-org fallback.
   *
   * This is a DELETE on a money table: if any precondition doesn't hold, skip the
   * prune and log why — a stale showback row is recoverable, a deleted month is not.
   */
  const skipRatio = result.seatsTotal > 0 ? result.seatsCarriedUnmapped / result.seatsTotal : 1
  // Precondition 4 (seatPagesCapped) is the one the diagnostics exist FOR. pullSeats
  // hard-caps at page 100 and sets pagesCapped precisely so "a caller that DELETEs
  // based on the roster can tell a truncated pull apart from a genuinely small one"
  // (github-client.ts). Without it, an enterprise above the cap has every seat past
  // page 100 absent from the roster through no fault of identity resolution — so the
  // skip-ratio stays low, the other preconditions hold, and the prune deletes
  // real, still-valid showback rows as "stale". Shipping the signal and not consuming
  // it is the exact control-versus-prose gap this sprint exists to close.
  // Precondition 5 (seatOrgsUnavailable, UF-19) is App mode's replacement for the abort
  // precondition 3 relies on. Its per-org pull is isolated, so an org the App is not
  // installed on — or one whose pull threw — yields an UNKNOWN roster for that org while
  // the run continues. The prune's scope is the whole provider_org set, so without this
  // guard those orgs' still-valid showback rows would be deleted as "not re-asserted this
  // run": exactly the seatPagesCapped failure mode, arriving through a different door.
  // Precondition 6 (seatRosterIncomplete) closes the hole the OTHER two ways
  // SeatsPullDiagnostics names. Its header lists three ways a small roster is
  // indistinguishable from a truncated one, and preconditions 4 and 5 consumed only
  // the page cap. The remaining two are the `seats` key being absent on a 200 — which
  // `z.array().default([])` used to silently turn into an empty page — and the API's
  // own `total_seats` exceeding what we collected. Either is POSITIVE evidence the
  // pull is short, and either would otherwise satisfy all four earlier preconditions:
  // seatsTotal > 0 from the pages that DID arrive, a low skip ratio, no page cap, no
  // unavailable org — and the DELETE would remove every still-valid row the truncated
  // pages would have re-asserted.
  //
  // NOT gated on seatPageShort, deliberately: that is true for every roster under 100
  // seats, so consuming it here would block convergence for nearly every enterprise
  // permanently. The distinction is evidence-of-truncation versus absence-of-evidence.
  const prunePreconditionsMet =
    result.seatsTotal > 0 &&
    skipRatio <= PRUNE_MAX_SKIP_RATIO &&
    !result.seatPagesCapped &&
    result.seatOrgsUnavailable === 0 &&
    !result.seatRosterIncomplete
  if (prunePreconditionsMet) {
    if (orgSet.length > 0) {
      const sourceList = sql.join(
        orgSet.map((org) => sql`${`copilot-seat:${org}`}`),
        sql.raw(', '),
      )
      // ATOMIC with its audit row. Previously the DELETE autocommitted and the audit
      // write was a separate statement, so a throw in between left money rows gone
      // with neither an audit trail nor a reported count — and a DB blip is exactly
      // when an audit write is most likely to fail. Inside one transaction the audit
      // failure now ROLLS THE DELETE BACK: a stale showback row is recoverable, an
      // unaudited deletion is not.
      await db.transaction(async (tx) => {
        const pruned = await tx.execute<{ id: string }>(sql`
          DELETE FROM actual_spend
          WHERE tool = 'copilot-cli'
            AND date = ${monthStart}::date
            AND source IN (${sourceList})
            AND pulled_at < ${runStarted}::timestamptz
          RETURNING id::text AS id
        `)
        if (pruned.length > 0) {
          // Money rows vanishing is consequential — leave an audit trail beyond worker
          // logs (mirrors the Claude lane's 'actual-spend-surface-adjusted' event).
          await recordAuditEvent(tx, {
            eventType: 'actual-spend-surface-adjusted',
            actorSystem: 'worker:copilot-bill',
            subjectKind: 'provider_enterprise',
            subjectId: null,
            payload: {
              enterpriseSlug: opts.enterpriseSlug,
              monthStart,
              prunedRows: pruned.length,
              seatsTotal: result.seatsTotal,
              seatsCarriedUnmapped: result.seatsCarriedUnmapped,
              seatPagesCapped: result.seatPagesCapped,
              seatPageShort: result.seatPageShort,
              seatOrgsUnavailable: result.seatOrgsUnavailable,
            },
          })
        }
        // Assigned INSIDE the transaction: if the audit write throws, the DELETE is
        // rolled back and prunedRows correctly stays 0 rather than reporting a
        // deletion that did not survive.
        result.prunedRows = pruned.length
      })
    }
  } else {
    consola.warn(
      `[copilot-bill] skipping seat-convergence prune for ${opts.enterpriseSlug}: ` +
        (result.seatsTotal === 0
          ? 'seatsTotal is 0 (a genuinely empty roster is indistinguishable from a truncated pull — never pruning on it)'
          : result.seatPagesCapped
            ? 'seat pull hit the pagination cap — the roster is TRUNCATED, so seats absent from it are unfetched, not removed'
            : result.seatOrgsUnavailable > 0
              ? `${result.seatOrgsUnavailable} license org(s) could not be read this run (App not installed / pull failed) — their rosters are UNKNOWN, not empty`
              : result.seatRosterIncomplete
                ? 'the seat roster came back INCOMPLETE (a page with no `seats` key, or fewer seats than the API\'s own total_seats) — the missing seats are unread, not removed'
                : `${result.seatsCarriedUnmapped}/${result.seatsTotal} seats unmapped (ratio ${skipRatio.toFixed(2)} > ${PRUNE_MAX_SKIP_RATIO}) — identity resolution looks broken`),
    )
  }

  return result
}
