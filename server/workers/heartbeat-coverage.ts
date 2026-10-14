/*
 * Heartbeat-coverage / quarantined-spend detector (MCP client backbone — design
 * doc §"Heartbeat-coverage / quarantined spend" + §"untrusted LAW channel").
 *
 * THE THREAT. The emit credential is the most broadly-readable secret in the
 * system: it lives in ~/.claude/settings.json on every dev box (and every CW
 * sharing that host). The emit channel is therefore UNTRUSTED / effectively
 * public-write — anyone with an emit token can write SPOOFED attribution_record
 * rows claiming a victim's instance_id / project / email. That telemetry lands
 * "assigned to you" in the attributed (indicative) lane. Reconciliation against
 * the provider's figures does not delete it: it flags telemetry far above the
 * provider figure for the owner's review. Telemetry never sets a billed total;
 * it only weights the project split of the person's own billed cost
 * (v_finance_project_overlay). (Accepted by design — there's no cheap per-record signing
 * for a broadly-distributed client; defense is revoke + detect + reconcile.)
 *
 * THE SIGNAL. Each successful /bearer mint stamps instance_attestation.last_bearer_at
 * — an AUTHENTICATED heartbeat: "the OWNER of instance X held a valid emit
 * credential at time T" (the /bearer caller must own the instanceId, which a
 * cross-instance spoofer cannot). ts_start is the first such proof. So an
 * instance's authenticated-live window is approximately
 *   [ts_start, last_bearer_at + GRACE].
 *
 * THE CHECK (per session, off the hot path). Group attribution_record by
 * conversation (COALESCE(claude_session_id, instance_id)) + instance_id; take the
 * session's [MIN(ts_event), MAX(ts_event)]. The session is COVERED/verified iff its
 * instance's authenticated-live window spans that range. Otherwise QUARANTINED
 * ("unverified spend") — the cross-instance-spoof signal: spend claiming an
 * instance with no covering heartbeat.
 *
 * GRACE. Legit spend is always within ~one bearer-TTL of a heartbeat (the client
 * refreshes ~every 29 min). We add a grace (~35 min, env-tunable) on BOTH ends so a
 * normal session whose last event lands just after the most recent /bearer stamp —
 * or whose first event lands a touch before ts_start due to clock skew — is NOT
 * false-positived. The grace must comfortably exceed the refresh cadence; 35 min
 * gives ~6 min of margin over 29.
 *
 * HISTORICAL-DATA GUARD. last_bearer_at only began being stamped at this feature's
 * rollout (mig 0030). An instance enrolled before then has last_bearer_at IS NULL
 * NOT because it was spoofed but because nothing ever stamped it. Quarantining that
 * retroactively would flag ALL historical spend. So we ONLY evaluate an instance
 * once it has a heartbeat: last_bearer_at IS NOT NULL. An instance with
 * last_bearer_at IS NULL is SKIPPED entirely (no signal yet) — never quarantined.
 * (A genuinely-spoofed victim instance that the real owner is actively using WILL
 * have a last_bearer_at from the owner's own /bearer mints, so the spoofed session —
 * whose events fall outside that window — still gets caught. A spoofer targeting an
 * instance that has NEVER minted a bearer produces no heartbeat to compare against;
 * that case is left to reconciliation, by design.)
 *
 * INFORMATIONAL ONLY — NEVER AUTO-REVOKE / AUTO-DELETE. Quarantine is the EARLY/UX
 * detection leg of revoke+detect+reconcile, surfacing "unverified spend" on the web
 * before reconciliation (which lags ~1h+). It does NOT touch credentials, instances,
 * or spend. Nothing deletes non-reconciling spend automatically: reconciliation
 * against Anthropic actuals may flag it, and a developer who quarantines a flagged
 * session excludes it from attributed figures and the project-split weights (the
 * records stay). This worker only writes/clears session_quarantine rows.
 *
 * WHAT IT CATCHES / DOESN'T. Catches the cross-instance spoof (records claiming a
 * victim instance_id the spoofer can't mint a bearer for → no covering heartbeat).
 * Does NOT catch full emit-credential THEFT (the thief owns the instance, so its
 * /bearer mints heartbeat AS the victim) — that stays on revocation + reconciliation.
 *
 * Mirrors went-silent.ts / reconciliation-gap.ts for structure + registry wiring.
 */
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { sql } from 'drizzle-orm'
import type * as schema from '../../drizzle/schema'
import { recordAuditEvent } from '../db/audit'

export interface HeartbeatCoverageResult {
  sessionsScanned: number
  quarantined: number
  resolved: number
  /*
   * (B) — the `AND ar.tool = 'claude-code'` filter above is CORRECT on its
   * merits (Copilot's reactive ~hourly bearer mint would false-quarantine —
   * see the module doc), not merely unimplemented. But an exemption that is
   * silent is indistinguishable from a gap nobody noticed, so this counts the
   * non-Claude population THIS RUN did not (and structurally cannot)
   * evaluate — every distinct (conversation, instance) with attribution_record
   * activity in the same lookback window whose tool is NOT 'claude-code'.
   * Making the exemption COUNTABLE is the fix; the exemption itself is
   * unchanged. Purely informational: nothing alarms on it (that would need a
   * decision about which surface pages an operator, out of this story's
   * scope — the same UF-11 boundary as JoinResult.telemetryOnlySpend).
   */
  notEvaluable: number
}

/** Grace minutes added to the instance's authenticated-live window on both ends. */
function graceMinutes(): number {
  const raw = Number(process.env.NUXT_HEARTBEAT_GRACE_MINUTES)
  // Must comfortably exceed the ~29-min /bearer refresh cadence; default 35.
  return Number.isFinite(raw) && raw > 0 ? raw : 35
}

/**
 * Lookback window — only sessions with activity in the last N days are scanned
 * each run (bounded cost on production-scale tables; mirrors the read-joiner's
 * 24h-style bounding). Older sessions are reconciliation's lane by then anyway.
 * Env-tunable; default 7 days.
 */
function lookbackDays(): number {
  const raw = Number(process.env.NUXT_HEARTBEAT_LOOKBACK_DAYS)
  return Number.isFinite(raw) && raw > 0 ? raw : 7
}

interface CoverageRow extends Record<string, unknown> {
  conversation_id: string
  instance_id: string
  teammate_id: string
  region_id: string
  org_unit_id: string
  session_ts_start: string
  session_ts_end: string
  instance_ts_start: string
  last_bearer_at: string | null
  cost_usd: string
  tokens: string
  covered: boolean
}

export async function runHeartbeatCoverage(
  db: PostgresJsDatabase<typeof schema>,
  opts?: { now?: Date; graceMinutes?: number; lookbackDays?: number },
): Promise<HeartbeatCoverageResult> {
  const now = opts?.now ?? new Date()
  const grace = opts?.graceMinutes ?? graceMinutes()
  const lookback = opts?.lookbackDays ?? lookbackDays()
  const lookbackCutoff = new Date(now.getTime() - lookback * 24 * 60 * 60 * 1000)

  // Per-session coverage scan. One row per (conversation, instance), with the
  // session's [min,max] ts_event, its summed spend, and the instance's
  // authenticated-live window. `covered` is computed in SQL so the worker just
  // partitions verified vs quarantined.
  //
  // HISTORICAL GUARD lives in the WHERE: ia.last_bearer_at IS NOT NULL. An instance
  // that never minted a /bearer (pre-rollout, or never alive) has no heartbeat to
  // compare against and is excluded — we never quarantine it retroactively.
  //
  // The grace interval widens the window on both ends. We compare against
  // session_ts_start >= ia.ts_start - grace (clock-skew tolerance on enrolment) and
  // session_ts_end <= last_bearer_at + grace (the refresh-cadence tail).
  const rows = await db.execute<CoverageRow>(sql`
    WITH session_window AS (
      SELECT
        COALESCE(ar.claude_session_id, ar.instance_id::text) AS conversation_id,
        ar.instance_id                                       AS instance_id,
        MIN(ar.ts_event)                                     AS session_ts_start,
        MAX(ar.ts_event)                                     AS session_ts_end,
        SUM(ar.cost_usd)                                     AS cost_usd,
        SUM(ar.tokens)                                       AS tokens
      FROM attribution_record ar
      WHERE ar.ts_event >= ${lookbackCutoff.toISOString()}::timestamptz
        -- CLAUDE-ONLY. The grace window is calibrated to Claude Code's proactive
        -- ~29-min otelHeadersHelper /bearer mint. copilot-cli DOES mint /bearer,
        -- but its forwarder mints REACTIVELY (~hourly, on 401/403), so last_bearer_at
        -- lags a long Copilot session and the coverage check would false-quarantine
        -- it. copilot-cli cross-instance-spoof detection is handled by §A
        -- reconciliation against GitHub actuals (usage-reconciliation, already
        -- scheduled) — ADR-0008's layer-1 money backstop — not this early-warning leg.
        AND ar.tool = 'claude-code'
      GROUP BY COALESCE(ar.claude_session_id, ar.instance_id::text), ar.instance_id
    )
    SELECT
      sw.conversation_id                       AS conversation_id,
      sw.instance_id::text                     AS instance_id,
      ia.teammate_id::text                     AS teammate_id,
      ia.region_id::text                       AS region_id,
      ia.org_unit_id::text                     AS org_unit_id,
      sw.session_ts_start::text                AS session_ts_start,
      sw.session_ts_end::text                  AS session_ts_end,
      ia.ts_start::text                        AS instance_ts_start,
      ia.last_bearer_at::text                  AS last_bearer_at,
      sw.cost_usd::text                        AS cost_usd,
      sw.tokens::text                          AS tokens,
      (
        sw.session_ts_start >= ia.ts_start - (${grace} || ' minutes')::interval
        -- Upper bound = the instance's authenticated-live END: its last heartbeat,
        -- OR ts_actual_end if it was explicitly ended LATER (a just-ended device's
        -- session tail is legitimate, not a spoof — R2 F3). Spend past that + grace
        -- (when the dead instance couldn't mint a bearer) is still quarantined.
        AND sw.session_ts_end <= COALESCE(ia.ts_actual_end, ia.last_bearer_at) + (${grace} || ' minutes')::interval
      )                                        AS covered
    FROM session_window sw
    JOIN instance_attestation ia ON ia.instance_id = sw.instance_id
    -- HISTORICAL GUARD: only instances with a heartbeat are evaluable.
    WHERE ia.last_bearer_at IS NOT NULL
  `)

  // (B) — the SAME lookback window's complement: distinct (conversation,
  // instance) pairs whose tool is NOT 'claude-code'. Deliberately does NOT
  // apply the `ia.last_bearer_at IS NOT NULL` historical guard the Claude scan
  // uses — that guard exists to avoid retroactively quarantining pre-rollout
  // data, which does not apply to a population this worker never evaluates in
  // the first place regardless of heartbeat history.
  const [notEvaluableRow] = await db.execute<{ n: string }>(sql`
    SELECT count(*)::text AS n FROM (
      SELECT DISTINCT COALESCE(ar.claude_session_id, ar.instance_id::text) AS conversation_id,
             ar.instance_id AS instance_id
      FROM attribution_record ar
      WHERE ar.ts_event >= ${lookbackCutoff.toISOString()}::timestamptz
        AND ar.tool <> 'claude-code'
    ) non_claude
  `)
  const notEvaluable = Number(notEvaluableRow?.n ?? 0)

  let quarantined = 0
  const nowIso = now.toISOString()

  for (const r of rows) {
    if (r.covered) continue

    // Upsert the quarantine row (idempotent on (conversation, instance)). A
    // re-run refreshes the window/spend; resolved_at is cleared in case a row was
    // previously resolved and the session went uncovered again.
    const upserted = await db.execute<{ inserted: boolean }>(sql`
      INSERT INTO session_quarantine (
        conversation_id, instance_id, teammate_id, region_id, org_unit_id,
        session_ts_start, session_ts_end, instance_ts_start, last_bearer_at,
        cost_usd, tokens, reason, detected_at, updated_at, resolved_at
      ) VALUES (
        ${r.conversation_id}, ${r.instance_id}::uuid, ${r.teammate_id}::uuid,
        ${r.region_id}::uuid, ${r.org_unit_id}::uuid,
        ${r.session_ts_start}::timestamptz, ${r.session_ts_end}::timestamptz,
        ${r.instance_ts_start}::timestamptz, ${r.last_bearer_at}::timestamptz,
        ${r.cost_usd}::numeric, ${r.tokens}::bigint, 'no-covering-heartbeat',
        ${nowIso}::timestamptz, ${nowIso}::timestamptz, NULL
      )
      ON CONFLICT (conversation_id, instance_id) DO UPDATE SET
        session_ts_start = EXCLUDED.session_ts_start,
        session_ts_end   = EXCLUDED.session_ts_end,
        last_bearer_at   = EXCLUDED.last_bearer_at,
        cost_usd         = EXCLUDED.cost_usd,
        tokens           = EXCLUDED.tokens,
        updated_at       = EXCLUDED.updated_at,
        resolved_at      = NULL
        -- ONLY ever touch OUR OWN rows. session_quarantine has ONE unique key
        -- (conversation_id, instance_id) shared with the dev-confirmed-forgery
        -- lane (reason='api-uncorroborated', written by /me/over-emission/resolve).
        -- Without this guard, an unrelated informational tick would overwrite a
        -- forgery row's cost/window and reset its resolved_at — corrupting the
        -- record that EXCLUDES forged spend from v_complete_usage.
        WHERE session_quarantine.reason = 'no-covering-heartbeat'
      RETURNING (xmax = 0) AS inserted
    `)
    const wasNew = [...upserted][0]?.inserted === true
    quarantined += 1
    if (wasNew) {
      // Audit only on first detection (not every re-run) — an informational
      // detection event, explicitly NOT an enforcement action.
      await recordAuditEvent(db, {
        eventType: 'spend-quarantined',
        actorSystem: 'heartbeat-coverage',
        subjectKind: 'teammate',
        subjectId: r.teammate_id,
        payload: {
          conversation_id: r.conversation_id,
          instance_id: r.instance_id,
          session_ts_start: r.session_ts_start,
          session_ts_end: r.session_ts_end,
          last_bearer_at: r.last_bearer_at,
          cost_usd: r.cost_usd,
          reason: 'no-covering-heartbeat',
          note: 'INFORMATIONAL detection — no auto-revoke/delete. Pending reconciliation.',
        },
      })
    }
  }

  // Auto-resolve: any OPEN quarantine row whose (conversation, instance) is now
  // covered (a later /bearer stamp extended the window, or the spoofed rows were
  // reconciled away so the remaining session fits the window). We pass the set of
  // currently-covered keys; mark their open rows resolved. Cleared, not deleted,
  // so the reconciliation reviewer keeps the audit trail.
  const coveredKeys = [...rows]
    .filter((r) => r.covered)
    .map((r) => ({ conversation_id: r.conversation_id, instance_id: r.instance_id }))

  let resolved = 0
  for (const k of coveredKeys) {
    const res = await db.execute<{ id: string }>(sql`
      UPDATE session_quarantine
         SET resolved_at = ${nowIso}::timestamptz, updated_at = ${nowIso}::timestamptz
       WHERE conversation_id = ${k.conversation_id}
         AND instance_id = ${k.instance_id}::uuid
         AND resolved_at IS NULL
         -- CRITICAL: only resolve OUR OWN informational rows. The unique key
         -- (conversation_id, instance_id) is SHARED with the dev-confirmed-forgery
         -- lane ('api-uncorroborated'), which is what keeps forged spend OUT of
         -- v_complete_usage / me-queries. Without this filter a single covered
         -- tick silently un-quarantines a forgery — and since budget-alert and
         -- velocity-watch now read v_complete_usage, that re-admitted spend can
         -- page a PM. Latent for the life of the code; this branch is the first
         -- thing that ever schedules the worker.
         AND reason = 'no-covering-heartbeat'
      RETURNING id::text AS id
    `)
    resolved += [...res].length
  }

  return { sessionsScanned: rows.length, quarantined, resolved, notEvaluable }
}
