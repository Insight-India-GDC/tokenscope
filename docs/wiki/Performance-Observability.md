# Performance Observability

How to answer "why is this slow?" with instruments instead of inference.
Every layer that can be slow has a readable instrument; this page is the
inventory, the triage ladder, and the recorded baselines.

## The instrument inventory

| Layer | Instrument | Where to read it | Attributes | Cannot attribute |
|---|---|---|---|---|
| Request (server side) | `Server-Timing` response header on buffered `/api/**` responses: `db;dur` (summed per-statement settlement time — under the codebase's pipelined waves each statement's span includes queue-wait behind its wave-mates, so `db;dur` can EXCEED `app;dur`; read it as "the time lives in the DB round-trips", not as additive wall time), `stmts` (statement count), `app;dur` (handler wall time); report GETs add `cache;desc=hit\|miss\|join` | Browser F12 → Network → any API row → Headers/Timing | DB time vs handler compute, statement volume, report-cache state | Body serialization + transfer (read the browser's TTFB/download columns beside it); the MCP direct-write path and OAuth redirects carry no header |
| Statement (database) | TIER-SPLIT: on non-Burstable servers, Query Store + plan capture (declarative in `postgresql.bicep`); on Burstable, ONLY the slow-statement log (`log_min_duration_statement`, 1000 ms default) — Query Store is deliberately off there (Microsoft documents it as a Burstable performance hazard) | Query Performance Insight (non-Burstable); the Log Analytics-exported PG log (all tiers) | Which query text is slow, how often — with plan-level stats where Query Store runs | On Burstable: anything faster than the log threshold has no capture IN THIS INSTRUMENT until the SKU is bumped — `pg_stat_statements` (next row) covers every statement on every tier, but without parameters or plans. And both readers here need a Log Analytics **data-plane** role, which control-plane Contributor does not include |
| Statement + relation (database), FROM ADMIN | `GET /api/v1/admin/diagnostics/db-performance` — the "Run database check" button on Admin → Diagnostics (`platform-admin`, launched on demand, never on page load). Six sections: `pg_stat_statements` top-N by total exec time; sequential-scan pressure (`seq_scan` / `seq_tup_read` vs `idx_scan` / `n_live_tup`, each with ANALYZE freshness — `lastAnalyzed` (WORST-CASE: the least-recently-analysed partition), `neverAnalyzed`, `rowsChangedSinceAnalyze` — so a scan the planner chose for want of statistics is distinguishable from one it chose correctly); cache behaviour (heap+index block hits vs reads, as a per-table hit ratio); unused indexes (`idx_scan = 0`, ≥ 64 KiB, excluding unique/PK **and exclusion-constraint** indexes — an exclusion index is enforced on write, not scanned, so it looks unused while holding an invariant); table + index sizes; and the server settings that govern them (`shared_buffers`, `work_mem`, `effective_cache_size`, `max_connections`, `log_min_duration_statement`, `track_io_timing`, `shared_preload_libraries`, each with its `pending_restart` state). Every row rolls partitions up to the partition ROOT, so `attribution_record` reports as one table. `statsWindow` names how far back the `pg_stat_user_*` counters reach (the last database-wide reset) — a major-version upgrade resets them, and a single table or index can be reset without moving that date, so it is a floor rather than an exact per-row window. | Admin → Diagnostics → Database performance | Which statement texts carry the estate's total DB time; which big tables are being walked instead of indexed; which tables miss the buffer cache; which indexes cost writes for nothing; where the bytes are; what the server is configured to do | **Per-request attribution** — `pg_stat_statements` counters are CUMULATIVE since the last reset or server restart, so they rank the estate, not one slow request (pair them with `Server-Timing` for that). **Plans** — no EXPLAIN, ever. **Anything at all** when `pg_stat_statements` is not in `shared_preload_libraries`: that section then says exactly that and what would enable it, and the other five still answer |
| Server (platform) | Always-on Azure platform metrics: `cpu_percent`, `cpu_credits_remaining` (Burstable SKUs), `active_connections`, `memory_percent`, IOPS; Container App CPU/memory/requests | Portal metrics blade, or `az monitor metrics list` (control-plane — works from anywhere) | Saturation, credit exhaustion, connection pressure | Which query or request caused it |
| Workers | `worker_run` ledger (name, status, `duration_ms`, result) + the 24 h summary (`GET /api/v1/admin/worker-runs?summary=24h`: per worker, over runs STARTED in the last 24 h — a long run started just before the window contributes nothing; one started just inside contributes its full duration): runs, p50, max, busy ms rendered on the admin worker-controls card | Admin → Workers | Worker activity: how long each cron ran and when — a CORRELATION instrument for "did the slow window coincide with worker work" | In-flight runs (no `finished_at` yet); and duration_ms is worker WALL time — a run may spend it on provider I/O or app compute, so this cannot attribute database time specifically |
| Frontend delivery | The F12 capture discipline: same pages, cold load, Network tab totals (requests / transferred / resources / DOMContentLoaded / Finish) | Browser | Asset count, compression (transferred ≈ resources means uncompressed), waterfall shape | Server-side time (that is what `Server-Timing` is for) |

## The triage ladder

0. **If the symptom is *broken* rather than *slow* — stalled attribution, red
   probes, a dead worker — you should have been pinged.** The `ops-alert`
   worker pages the external ntfy channel for exactly that class
   ([Background Workers](Background-Workers.md); [Deployment & Operations](Deployment-and-Operations.md#ops-alerting)).
   If you weren't pinged, check ops-alert's own health FIRST — the dead-man
   metric alert on the `caj-ts-ops-alert` job's successful-execution count, and
   the worker's `worker_run` rows — before trusting any in-app signal: a silent
   alerting channel and a healthy product look identical from the inside.
1. **F12 `Server-Timing`** on the slow request. Read it as three signals,
   never as an equation (`db;dur` is a non-additive pipelined sum): `db;dur`
   near or above `app;dur` → the time lives in DB round-trips; `app;dur`
   large while `db;dur` is small → handler compute; browser TTFB/download
   large while `app;dur` is small → serialization + network. Is `stmts`
   unexpectedly high? Is a report `cache;desc=miss` when it should be warm?
2. **If DB-heavy → Admin → Diagnostics → "Run database check"**
   (`GET /api/v1/admin/diagnostics/db-performance`). It is first because it
   is the only statement-level instrument that needs no Azure role at all:
   Query Performance Insight and the LA-exported PG log both live behind a
   **data-plane** role (`Log Analytics Reader`) that control-plane Contributor
   does not include and cannot self-assign, so for a Contributor the evidence exists and
   is unreachable. The app's own connection reads the statistics views
   directly. Read it as: which statements hold the total exec time; is a big
   table's `seq_tup_read` climbing while its `idx_scan` sits still; is a hot
   table's hit ratio low; are the sizes and settings what you assumed.
   **What it cannot tell you:** anything about ONE request (`pg_stat_statements`
   is cumulative since the last reset or restart — step 1 owns the per-request
   question), and nothing at all about statements if the extension is not
   loaded. When `shared_preload_libraries` does not include
   `pg_stat_statements` the panel says so and names the fix
   (`infra/modules/postgresql.bicep` declares it; the parameter is STATIC and
   needs a server **restart**, which the panel reports as `restart pending` on
   that setting); the other five sections answer regardless.
3. **Still DB-heavy, and you have workspace access →** on a non-Burstable
   server, Query Performance Insight for the window (statement texts,
   frequency, cost — with plan-level stats, which step 2 has no equivalent
   for). On Burstable, the slow-statement log is the instrument —
   ≥1 s outliers **with their parameters** in the LA-exported PG log;
   sub-threshold statements have no per-query capture there.
4. **Platform metrics** for the same window: `cpu_credits_remaining` floor
   (Burstable throttling), CPU/memory/IOPS saturation, connection count.
5. **Worker duty cycle** (admin card / `worker_run`): did the slow window
   coincide with heavy cron work? The `usage-rollup` result rows also carry
   `wide: true` on the once-daily wide pass.
6. Record what you conclude next to the baselines below — the next "feels
   slow" starts from evidence.

**"An admin page feels slow" is two symptoms, and the ladder above only
measures one.** The request can be slow (ladder step 1 onward), or the page
can be *waiting* on it — nothing changes after the click until the slowest
read finishes. `npm run test:nav` is the instrument for the second: it delays every
`/api/v1/admin/**` response by 1.5 s, clicks every sidebar link, and fails any
route whose page shell is not on screen within 500 ms of the click or that
shows no loading state before its data lands. Run it before reaching for
`Server-Timing` — a page that only changes once the data lands is a page bug,
not a database one.

## Recorded baselines — the two product pages, cold, F12

One operator, same pages, cold loads, on the reference deployment, measured
2026-08-20. The run coincided with the `*/15` worker tick grid and with a
wider `usage-rollup` recompute than the worker does now, so read the report
rows as an upper bound.

| endpoint | cold load |
|---|---|
| `/me/usage` | 5.03 s |
| `/me/activity?limit=25` | 4.43 s |
| `/me/sessions/untagged` | 0.38 s |
| usage-page floor endpoints | 0.23–0.47 s |
| `/reports/region?region=all` | 6.89 s |
| `/reports/region/trend` | 3.94 s |
| `/reports/region/active-trend` | 2.04 s |
| `/reports/region/drivers` (project / model) | 5.87 / 2.03 s |
| `/reports/region/behaviour` | 4.81 s |
| `/me/inbox` beside the reports burst | 2.22 s |
| Home cold load | 96 req · 2.2 MB (≈uncompressed) · DCL 3.14 s · finish 6.65 s |

## Escape hatches / rollback

- `NUXT_SERVER_TIMING=off` strips the header (env, no deploy).
- The PG parameters roll back by redeploying with the previous value
  (`slowStatementLogMs` bicep param; `pg_qs.query_capture_mode`).
- `shared_preload_libraries` (`sharedPreloadLibraries` bicep param) is the one
  exception: it is a STATIC parameter, so both applying it and rolling it back
  need a server **restart** before they take effect. Until then the server runs
  on the old value and `pending_restart` is true for that setting — which the
  db-performance panel shows.
