/*
 * reporting/teammate-freshness — the operand behind the teammate drill's
 * STALENESS REFUSAL (developer pages build D36, r1-H5 + r2-H1).
 *
 * ── WHY THIS IS NOT `reportCoverageMeta` (r1-H5) ────────────────────────────
 * That helper returns an estate-wide GitHub-enterprise CENSUS marker with a
 * boolean `stale` and no timestamp (`server/reports/coverage-meta.ts:29-52`).
 * It answers "can we claim completeness of the org list", not "how old is the
 * money we are about to publish about a named person". It stays chip-only.
 *
 * ── WHY A REFUSAL AND NOT A CAVEAT ──────────────────────────────────────────
 * On a governance surface about a named individual, a stale figure is a
 * finding-shaped defamation risk, not a caveat (annex :926-928). Self and member
 * depths do NOT refuse — a stale figure about yourself is a caveat, and the chip
 * row discloses it (D14).
 *
 * ── THE STALEST RELEVANT PROVIDER DECIDES (r2-H1) ───────────────────────────
 * RELEVANCE is subject-scoped: only providers actually present in the subject's
 * in-window, in-scope rows can gate the page. An irrelevant provider's stale
 * clock must not refuse a page it contributed nothing to.
 *
 * And "present" means PRESENT AS A SOURCE, not merely as a vendor label. An
 * `otel-emitted` row (arm 1) is emitted live by the client and reaches the lane
 * without any provider pull, so no provider clock says anything about how fresh
 * it is; refusing an OTel-only subject because a provider nobody polls has never
 * been observed would withhold figures that are, in fact, current — and would
 * make the whole drill unreachable on an estate that emits but does not
 * reconcile. Rows whose provenance IS provider-fed (`api-reconciled`,
 * `provider-usage`) are exactly the rows a stale pull would misstate, and they
 * are the ones that gate.
 *
 * The CLOCK is per relevant SOURCE and UNWINDOWED:
 * `MAX(provider_usage_fact.pulled_at)` for each `(provider, source)` that
 * carried the SUBJECT's facts inside the window. It answers "when did we last
 * hear from that source at all", which is the collection clock the prototype's
 * copy names ("Provider coverage is 26 h old against a 12 h threshold").
 * Windowing the clock would make every historical month refuse forever, which
 * says nothing about whether the data is current — so RELEVANCE is windowed and
 * subject-scoped while the CLOCK behind it is neither. Sources are pulled
 * independently (one per org / enterprise / connector), so a per-PROVIDER
 * estate-wide MAX let an unrelated organisation's recent pull vouch for a
 * subject's own stale source (r3-M3).
 *
 * A fresh Anthropic clock must NOT mask a stale Copilot one, so the endpoint
 * refuses when ANY relevant provider is past the threshold — and a relevant
 * provider we have NEVER observed is treated as stale, not as fresh: fail-closed
 * is the only honest reading of "we cannot establish how old this is".
 *
 * LANE: `provider_usage_fact` only. `actual_spend`'s own refresh marker would be
 * the other candidate operand and is unreachable from here BY DESIGN — the lane
 * firewall bans raw `actual_spend` in every reporting read path
 * (tests/unit/server/reports-lane-firewall.test.ts). `provider_usage_fact` is
 * written by the same transform on the same run, so it carries the same clock.
 */
import { sql } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { toolToVendor, vendorProvider } from '../../shared/usage/vendor'
import { scopeSql, type UsageScope } from './engine/scope'
import { CONFIRMED_ONLY } from './teammate'
import type { UsageWindow } from './params'

type Tx = PostgresJsDatabase<Record<string, unknown>>

/**
 * How old a relevant provider's latest observation may be before the drill
 * withholds its figures. Exported BESIDE the query (D36) so the test that moves
 * a clock past it and the endpoint that enforces it read the same number.
 *
 * 12 hours is the prototype's copy (`prototype.html:811`). It sits far inside
 * the settling-window contract, which is a different (months-grain) concern:
 * settling says "this month is not closed"; this says "we have not looked
 * recently enough to publish it about a person".
 */
export const TEAMMATE_FRESHNESS_THRESHOLD_HOURS = 12

export interface ProviderFreshness {
  /** 'anthropic' | 'github' — the provider whose clock this is. */
  provider: string
  /**
   * The STALEST relevant SOURCE behind this provider's verdict, or `null` when
   * the subject has no observed source for it (never-observed ⇒ stale).
   * Carried so a refusal can be diagnosed without re-running the query.
   */
  source: string | null
  /** Latest observation of that source, ISO. `null` = never observed (stale). */
  observedAt: string | null
  /** Hours since `observedAt`, or `null` when never observed. */
  ageHours: number | null
}

export interface SubjectFreshness {
  /** One entry per provider PRESENT in the subject's in-scope window rows. */
  providers: ProviderFreshness[]
  /** The threshold in force, echoed so the refusal card can state it. */
  thresholdHours: number
  /**
   * The stalest RELEVANT provider past the threshold, or `null` when every
   * relevant clock is inside it. Non-null ⇒ the endpoint withholds.
   */
  stale: ProviderFreshness | null
}

/**
 * Evaluate the subject's provider freshness for one frame + window.
 *
 * Called on EVERY request, BEFORE the response-cache lookup (r1-H7): a warm
 * cached body must become unreachable the moment the threshold passes, not at
 * TTL expiry. That ordering is the endpoint's job; this function is pure read.
 */
export async function subjectFreshness(
  tx: Tx,
  scope: UsageScope,
  subjectId: string,
  win: UsageWindow,
  now: Date,
): Promise<SubjectFreshness> {
  /*
   * WHICH providers are relevant — the subject's own in-scope, in-window rows,
   * restricted to the PROVIDER-FED ones. `usage_provenance` is the discriminator
   * (mig 0101): 'otel-emitted' arrived without a pull and has no provider clock
   * to be stale against.
   */
  const toolRows = await tx.execute<{ tool: string | null; provenance: string | null }>(sql`
    SELECT DISTINCT u.tool AS tool, u.usage_provenance AS provenance
      FROM v_complete_usage_current u
     WHERE u.teammate_id = ${subjectId}::uuid
       AND ${scopeSql(scope)}
       AND ${CONFIRMED_ONLY}
       AND u.ts_event >= ${win.startIso}::timestamptz
       AND u.ts_event <  ${win.endIso}::timestamptz`)
  const relevant = new Set<string>()
  for (const r of [...toolRows]) {
    if (r.provenance === 'otel-emitted') continue
    const provider = vendorProvider(toolToVendor(r.tool))
    // The 'other' catch-all belongs to no provider — it has no clock to be
    // stale, and inventing one would refuse pages on a lane nobody polls.
    if (provider) relevant.add(provider)
  }

  if (relevant.size === 0) {
    return { providers: [], thresholdHours: TEAMMATE_FRESHNESS_THRESHOLD_HOURS, stale: null }
  }

  /*
   * THE CLOCKS — PER RELEVANT SOURCE, not per provider estate-wide (r3-M3).
   *
   * The query this replaces was `MAX(pulled_at) GROUP BY provider` over the WHOLE
   * estate. Provider sources are pulled INDEPENDENTLY (one per org / enterprise
   * / connector — `provider_usage_fact.source` mirrors `actual_spend.source`), so
   * a recent pull of a completely unrelated organisation reported the subject's
   * own 26-hour-old source as fresh, and the page published stale named-person
   * figures instead of refusing. "The stalest RELEVANT provider decides" was
   * already the rule; its OPERAND was wrong.
   *
   * RELEVANCE IS WINDOWED, THE CLOCK IS NOT — and the split is deliberate:
   *   - relevance asks "which sources produced the money we are about to
   *     publish", so it is scoped to the SUBJECT and to the WINDOW;
   *   - the clock asks "when did we last hear from that source AT ALL", which
   *     must stay unwindowed or every historical month refuses forever (the
   *     reason stated at the top of this file).
   * A relevant provider with no observed source in the window keeps the existing
   * never-observed treatment: stale, because we cannot state an age.
   */
  const clockRows = await tx.execute<{
    provider: string
    source: string
    observed_at: string | null
  }>(sql`
    WITH relevant_source AS (
      SELECT DISTINCT f.provider, f.source
        FROM provider_usage_fact f
       WHERE f.teammate_id = ${subjectId}::uuid
         AND f.date >= ${win.startIso}::date
         AND f.date <  ${win.endIso}::date
    )
    SELECT rs.provider AS provider,
           rs.source   AS source,
           MAX(f.pulled_at)::text AS observed_at
      FROM relevant_source rs
      JOIN provider_usage_fact f
        ON f.provider = rs.provider AND f.source = rs.source
     GROUP BY rs.provider, rs.source`)

  /** provider → its stalest relevant source (the one that decides). */
  const stalestSource = new Map<string, { source: string; observedMs: number }>()
  for (const r of [...clockRows]) {
    const ms = r.observed_at ? Date.parse(r.observed_at) : NaN
    if (!Number.isFinite(ms)) continue
    const cur = stalestSource.get(r.provider)
    // ANY relevant source past the threshold refuses, so the OLDEST wins — a
    // freshly-pulled sibling source must not speak for the one that is behind.
    if (!cur || ms < cur.observedMs) stalestSource.set(r.provider, { source: r.source, observedMs: ms })
  }

  const providers: ProviderFreshness[] = [...relevant]
    .sort()
    .map((provider) => {
      const hit = stalestSource.get(provider)
      if (!hit) return { provider, source: null, observedAt: null, ageHours: null }
      return {
        provider,
        source: hit.source,
        observedAt: new Date(hit.observedMs).toISOString(),
        ageHours: Number(((now.getTime() - hit.observedMs) / 3_600_000).toFixed(2)),
      }
    })

  /*
   * The stalest decides. A NEVER-observed provider sorts as the stalest of all
   * (fail-closed): we cannot state an age, so we cannot state that it is fresh.
   */
  const staleRank = (p: ProviderFreshness): number =>
    p.ageHours == null ? Number.MAX_SAFE_INTEGER : p.ageHours
  const past = providers
    .filter((p) => p.ageHours == null || p.ageHours > TEAMMATE_FRESHNESS_THRESHOLD_HOURS)
    .sort((a, b) => staleRank(b) - staleRank(a))
  const stale = past[0] ?? null

  return { providers, thresholdHours: TEAMMATE_FRESHNESS_THRESHOLD_HOURS, stale }
}
