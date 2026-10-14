# Data Protection

For InfoSec / data-privacy review of TokenScope. What data the system holds,
where it lives, how it's protected, and the one property that matters most:
**TokenScope stores token-usage *metadata* only — never prompt or response
content.**

See also [Security Overview](Security-Overview.md)
([Authentication & Security](Authentication-and-Security.md) as-built),
[Architecture](Architecture.md), [Data Model](Data-Model.md).

Labels used throughout: **[Current]** = as-built and running; **[Planned]** =
designed, not yet enforced; **[VERIFY]** = needs deployment-owner confirmation.

---

## The headline: metadata, not content

> **TokenScope never ingests prompts, responses, file contents, or any
> message body.** It records *counts*.

Claude Code emits OpenTelemetry `api_request` **log events** carrying token
**counts** — `input_tokens`, `output_tokens`, `cache_read_tokens`,
`cache_creation_tokens`, `cost_usd`, `model`, `request_id`, `duration_ms`.
There is **no message-body field** in the telemetry contract. The read joiner
records counts / cost / model / timestamp per session into `attribution_record`.

Confirmed against the as-built schema — `attribution_record`
(`drizzle/schema/attribution.ts`) has these columns and **no content column**:

| Carries | `tokens` (count) · `cost_usd` · `model` · `token_type` · `ts_event` · session/teammate/project/org FKs |
|---|---|
| **Does NOT carry** | prompt text · response text · file paths · code · message bodies |

This is the system's primary **data-minimisation** property: the most sensitive
data class (conversation content) is never collected, transmitted, or stored.
(Sources: [Data Model](Data-Model.md) `attribution_record`;
[Claude Code Client](Claude-Code-Client.md#telemetry-contract).)

---

## Data classification

What TokenScope holds, ranked by sensitivity.

| Data | Class | Where stored | Retention |
|---|---|---|---|
| **Identity** — Entra OID, email (`teammate`, `instance_attestation.principal_email`, `teammate_identity_map`) | **PII** | Postgres | ~12 mo active, then soft-purge **[Current]** |
| **Emit handoff code** (`emit_handoff`, one-time device setup) | Secret | Postgres — **hashed** (HMAC-SHA-256, KV service key) | ~5 min, single-use; raw never stored |
| **OAuth access and refresh tokens** (`oauth_token`, the device's durable credential) | Secret | Postgres — **hashed** (HMAC-SHA-256, KV service key) | access 30 days; refresh 90 days, renewed while the device is in use; raw never stored |
| **Org / project metadata** — units, project codes, `raw_project_code`, client-facing name | Confidential (business) | Postgres | life of project (soft-retire) |
| **Telemetry-derived usage** — token counts, model, cost, timestamps, session id, token-type (`attribution_record`, `actual_spend`) | Internal (non-PII per row, but joins to a person) | Postgres | ~7 yr finance horizon **[VERIFY w/ finance]** |
| **Governance** — budgets, allocations, limits, tiers | Internal | Postgres | life of policy |
| **Audit log** (`audit_event`) | Internal — security record | Postgres (append-only) | indefinite **[Current]** |
| **Raw telemetry events** (`OTelLogs`) | Internal — counts only | Azure Log Analytics Workspace — **query private** (AMPLS PE, in-VNet only); **ingestion public** (DCE) | workspace-configured **[VERIFY]** |

> Telemetry rows are not content, but a row keyed to a `teammate` is
> *attributable to a person*. Treat the joined view as PII-adjacent; the raw
> count rows are not PII on their own.

---

## Data flow — PII vs non-PII at each hop

![With TokenScope's client settings no prompt or response text leaves the device, but Claude Code attaches the signed-in email to its events, and that email reaches Log Analytics and a column on attribution_record](images/data-protection-pii-hops.svg)

1. **Device → Azure Monitor.** Each `api_request` log event carries token counts, `cost_usd`, `model`, Claude's `session.id` and TokenScope's resource attributes (`tokenscope.instance_id`, `project.code_hash`, `tool`). Claude Code also attaches `user.email` and `organization.id`. TokenScope does not strip them. **[Current]**, strip/keep policy **[VERIFY / Planned]**.
2. **Azure Monitor → joiner.** `OTelLogs` keeps every attribute as emitted. The joiner's KQL reads `api_request` rows for one `tokenscope.instance_id` (`server/azure/reader.ts`) and takes the teammate from `instance_attestation`, never from the email.
3. **Joiner → Postgres.** It writes the ledger row to `attribution_record`, with the email canonicalised into `emitting_email` and the org id into `emitting_org_id` as evidence for the billing lane. Entra identity (OID, email) lives in `teammate`, `instance_attestation.principal_email` and `teammate_identity_map`.
4. **Postgres → dashboard.** Reads go through Entra OIDC and the application's role and scope checks (`requireRole`, the region and unit clamps). Row-level security policies exist but do not execute: the app connects as the table owner, which RLS does not restrict, and [ADR-0013](Design-Decisions.md#adr-0013--authorization-is-enforced-in-the-application) keeps it that way. This is where names and emails are shown back.
5. **Not emitted by default.** TokenScope's client settings never set `OTEL_LOG_USER_PROMPTS` or `OTEL_LOG_TOOL_DETAILS`, so Claude Code sends no prompt text or tool parameters. This is a client default, not an enforced boundary: a user who sets either variable would send that content, and the data collection rule stores every log event it receives. The joiner reads only `api_request` events.

*With the default client settings content stays on the device; identity does not, as `user.email` when Claude Code supplies it, and it is stored twice before anyone signs in to read it.*

---

## Encryption

| Layer | Posture | Status |
|---|---|---|
| **In transit — edge** | TLS 1.2+ at the upstream WAF (OWASP ruleset); HTTPS-only ingress. *(In a Front-Door-fronted topology the edge is Azure Front Door + WAF policy — optional, `enableFrontDoor`.)* | **[Current]** |
| **In transit — data plane** | Postgres, Redis, Key Vault reached over **private endpoints inside the VNet** (no public exposure / no TLS-over-internet hop) | **[Current]** |
| **In transit — telemetry** | TLS 443 to Azure Monitor's Data Collection Endpoint (`monitor.azure.com`) | **[Current]** |
| **At rest — Postgres** | Flexible Server platform-managed encryption | **[Current]** |
| **At rest — Key Vault** | HSM-backed; soft-delete + purge-protection for prod | **[Current]**, prod hardening **[Planned]** |
| **At rest — Log Analytics** | Azure platform-managed encryption | **[Current]** |
| **CMK (customer-managed keys)** | Available where data classification mandates | **[Planned / on demand]** |

"Platform defaults" = Azure-managed keys everywhere unless CMK is required.
(Source: `architecture.md` §Encryption posture; per-store settings in
[Deployment & Operations](Deployment-and-Operations.md).)

---

## PII handling & minimisation

- **The PII is emails and Entra OIDs** — held in `teammate`,
  `teammate_identity_map`, and denormalised onto `instance_attestation`
  (`principal_oid`, `principal_email` for audit display).
- **`raw_project_code` is audit/display only.** It can embed client identity
  (`PRJ-CLIENTX-RENEWAL`), so the canonical `code_hash` (SHA-256) is the value
  that crosses any AI-coaching boundary — the raw code and client name **never**
  do. **[Current]** for the hashing; the coach itself isn't built (see Planned).
- **Soft-purge over hard-delete.** A purge clears the PII fields
  (`principal_email`, `raw_project_code`, notes) and sets `ts_purged`, while
  *retaining* the row and `instance_id` so the
  `attribution_record → instance_attestation` FK stays valid across the much
  longer finance-audit horizon. Both halves are **[Current]**: the schema
  column, and the nightly `soft-purge` worker that enforces it (03:00 UTC,
  12-month window, one `session-pii-purged` audit event per row). It purges
  ENDED devices only: a device in use renews its life, and needs its identity
  columns while it is live.
- **Credentials are never stored raw.** The emit handoff code and the OAuth
  access and refresh tokens are stored only as an HMAC-SHA-256 hash (Key-Vault
  service key), so rotating the key invalidates them all at once. **[Current]**
- **k-anonymity suppression on the directory diagnostic.** The Region-rules
  "which directory attribute maps to region on my tenant?" diagnostic
  (`GET /api/v1/admin/directory/field-distribution`,
  `shared/placement/field-distribution.ts`) samples the directory and returns,
  per attribute, coverage + the top distinct values. It is **PII-safe by
  construction**: only attribute *values* (company / country / …) and counts —
  never names or emails — and a **k-anonymity floor of `MIN_CELL = 5`** suppresses
  any value cell seen fewer than 5 times (rare values fold into an "other"
  bucket), so a rare value + count can't de-anonymise one person. The endpoint is
  **global-roles-only** (`requireRole('platform-admin')`), the
  same posture as the region rules it feeds. **[Current]**

---

## Retention

| Item | Window | Status |
|---|---|---|
| Emit handoff code | ~5 min, single-use, hashed | **[Current]** |
| OAuth access / refresh token | 30 days / 90 days renewed in use, hashed | **[Current]** |
| `instance_attestation` PII | ~12 mo active → soft-purge (PII cleared, row kept) | **[Current]** — column + the nightly `soft-purge` worker |
| `attribution_record` | ~7 yr finance-audit horizon | **[Current]** (no automated purge); ~7 yr **[VERIFY w/ finance]** |
| `audit_event` | indefinite, append-only (trigger-enforced) | **[Current]** |
| Log Analytics `OTelLogs` | workspace-configured | **[Current]**, value **[VERIFY]** |
| Coaching-nudge text | ~30 day purge | **[Planned]** — coach not built |

> **Two retention jobs run today, and the rest are still windows on paper.**
> The nightly `soft-purge` worker enforces the 12-month `instance_attestation`
> PII window. The nightly `session-gc` worker deletes used or expired handoff
> codes after a day, and revoked or refresh-expired OAuth tokens after 30 days;
> an expired code or token is refused at use before then. `archive-ledger`, which retires cold `attribution_record`
> partitions, is registered but not scheduled on any deployment, and does
> nothing unless `LEDGER_ARCHIVE_ENABLED=true`. Append-only audit retention is
> enforced by a DB trigger that denies UPDATE/DELETE. Everything else in the
> table above is a designed window with no job behind it yet.

---

## Data residency

- **Single-region deployment.** TokenScope deploys into one region and resource
  group (chosen via `location` / passed at `-g`); all stores live in that region.
  **[Current]**
- **Region and org-subtree scoping.** Multi-tenant tables carry `region_id` /
  `org_unit_id`, and every scoped surface clamps on them in-query through shared
  scope-predicate helpers. This is the authorization boundary; see
  [Authentication & Security](Authentication-and-Security.md). **[Current]**
- **Sovereignty posture:** all stores (Postgres, Key Vault, Log Analytics) are
  Azure PaaS within the deploying tenant and the single deployment region — data
  does not leave Azure / the deployment region. Cross-region data isolation is
  enforced by *single-region deployment* and the application's region checks;
  the RLS region policies do not execute ([ADR-0013](Design-Decisions.md#adr-0013--authorization-is-enforced-in-the-application)). **[VERIFY]** the tenant/region against the
  deployment owner's data-classification policy for the target dataset.

---

## Planned (not yet enforced) — summary for reviewers

| Control | State |
|---|---|
| Formal retention/expiry jobs (Log Analytics tiering; attribution beyond the archive worker) | **[Planned]** — `archive-ledger` (retires cold `attribution_record` partitions) is not scheduled and is off unless `LEDGER_ARCHIVE_ENABLED=true`; nothing tiers Log Analytics |
| Deployment-time region choice (residency) | **[Planned]** — a single region is fixed per deployment today (via `location`) |
| AI-coaching privacy boundary (hash-only, aggregates-only, 30 d purge) | **[Planned]** — coach not built; the privacy *contract* is documented as the bar any future build must meet |
| Strip/keep policy for Claude's own identity attrs in telemetry | **[VERIFY / Planned]** |

The coaching data-path contract (only aggregates + hashed `code_hash` cross the
boundary; raw code / client name / message content never do) is a **binding
design constraint** for the future feature, not shipped behaviour.
