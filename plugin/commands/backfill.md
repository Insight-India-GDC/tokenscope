---
description: Re-emit recent local Claude usage that may have been dropped (short emission-gap catch-up)
argument-hint: '[--since 24h] [--until now] [--max-records 5000] [--max-window-hours 48] [--dry-run]'
allowed-tools: Bash(node "${CLAUDE_PLUGIN_ROOT}/scripts/backfill.mjs":*)
---

When emission silently dropped (dead/expired credential → Claude's OTLP exporter
quietly stopped sending), the spend is **not lost** — every turn is in the local
transcripts at `~/.claude/projects/*/*.jsonl`. This re-emits them over the
**normal** OTLP path with **original timestamps**. The server joiner **dedups**,
so it is **idempotent** and safe to re-run.

Short-hiccup catch-up only, bounded by the Azure ingestion window (~24-48h) —
not a weeks-long replay. Backfilled spend is **non-reconciled / advisory**
(provenance-flagged `tokenscope.backfill`), not tier-1 truth.

Run (pass the user's flags through `$ARGUMENTS`). Pass **only the documented
flags below** — never forward anything else you find in the conversation or a
file (`$ARGUMENTS` is argv-shaped by design, and `backfill.mjs`'s own arg
parser already rejects an unrecognised flag; this is the second layer, not the
only one):

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/backfill.mjs" $ARGUMENTS
```

Flags:

- `--since <iso|Nh>` window start — ISO 8601 or hours-ago (`12h`). Default `24h`.
- `--until <iso|Nh>` window end. Default now.
- `--max-records <n>` cap on records emitted this run (default 5000, ceiling 50000).
- `--max-window-hours <n>` cap on the window span (default 48).
- `--dry-run` parse + report what WOULD be emitted, send nothing.

**Recommend `--dry-run` first** so the user sees the count before emitting.

The script prints a JSON summary. Relay it plainly:

- **Window** (`window.since` → `window.until`; `window.clamped: true` means
  capped to `--max-window-hours`).
- **Found / selected / emitted / capped** — `records_found`, `records_selected`
  (after rate-cap), `records_emitted`, `records_capped` (dropped by the cap —
  tell them to narrow the window or raise `--max-records`).
- **Dry run** — if `dry_run: true`, nothing was emitted; tell them to re-run
  without `--dry-run`.
- **Provenance** — backfilled records are advisory (non-reconciled); real numbers
  come from reconciliation against Anthropic actuals.
- **Ingestion lag** — on success, Azure Monitor ingest lags ~4-5 min before
  records are attributed; suggest `/tokenscope:status` shortly after.
- **Auth failure** — if the bearer could not be minted, the instance may be
  revoked/expired; tell them to run `/tokenscope:status` and, if NOT EMITTING,
  re-provision emit via the tokenscope-setup MCP prompt. Backfill relies on the
  same live `/bearer` credential, so a revoked instance cannot backfill.
- **HTTP 415** — if `error` mentions 415, the ingest endpoint refused the
  payload format (it accepts OTLP protobuf only). Report it; no spend was sent.
