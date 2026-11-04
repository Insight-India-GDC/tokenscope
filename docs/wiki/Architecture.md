# Architecture

TokenScope attributes AI coding-assistant token spend — **Claude Code and GitHub Copilot** — to projects and Business Units. It is a Nuxt 4 / Nitro app with Drizzle + PostgreSQL, deployed on Azure Container Apps. The telemetry surface is **OTel log events read from Log Analytics via KQL** — not metrics, not spans — and the provider APIs supply the complete spend truth alongside it.

> **Where the money comes from has its own page.** [Data Flow](Data-Flow.md) holds the ingest paths, the §A/§B split, and how spend is valued; [Data Lineage](Data-Lineage.md) holds every table, column, transformation and invariant. This page stays at the component/topology level — where the two disagree, **Data Flow wins**.

> Sibling pages hold the rest of the detail: [Data Model](Data-Model.md), [Authentication & Security](Authentication-and-Security.md), [Background Workers](Background-Workers.md), [Claude Code Client](Claude-Code-Client.md), [Deployment & Operations](Deployment-and-Operations.md).

## Terminology

The domain topology, restated for the engineering wiki. The hierarchy is **teammate → instance → session → project**,
and spend is attributed per record.

- **Teammate** — the human (Entra identity); who incurred the spend.
- **Instance** — a device/enrolment: ONE per machine or container, minted once
  by the MCP `provision_emit` tool (run by the `tokenscope-setup` prompt).
  Identified by the OTel wire attribute `tokenscope.instance_id` and stored as
  `instance_attestation.instance_id`. The stored enrolment binds it to a
  teammate at an authenticated enrol; the `tokenscope.instance_id` on each event
  is a claim that anyone with ingest access can set (see
  [Attributed and Billed](Attributed-and-Billed.md) §2). Bearer/lifecycle routes live under
  `/api/v1/instances/...`.
- **Session** — a Claude Code session = ONE `claude` run = a conversation. It is
  Claude's own `session.id`, captured as `attribution_record.claude_session_id`
  and `session_assignment.claude_session_id`. Subagents share their PARENT
  session's id (they are not separate sessions). This is the user-facing unit
  (the **session** rows of the Activity list) and the unit of retroactive
  project assignment. There is no finer granularity than a session. A
  provider-recorded day is NOT a session — it is a `(teammate, day, tool)`
  bucket with no conversation and no instant behind it, which is why Activity
  holds both kinds of row and is not called "Sessions".
- **Project** — what the spend bills to. Resolved per record by the emitted
  `project.code_hash` (a claim), membership-gated
  ("tag proposes, membership disposes"). Untagged spend is retroactively
  assigned per-session via `session_assignment` (`claude_session_id →
  project_id`), also membership-gated.
- **Attribution** — `attribution_record`, one row per (instance, session, event,
  token-type, model, **request**). Priced **provider-first**: the provider's own
  cost is the span total, and the rate card only *slices* that total across the
  token-type rows. The card sets the amount solely as a fallback when the
  provider sent none, which in practice is rare. See [Data Flow §4](Data-Flow.md#4-how-money-is-valued--and-the-rate-cards-real-job).

## Logical architecture

The as-built system is seven components. There is **no launcher and no server-side token broker**. (A remote **MCP server** + OAuth 2.1 client backbone is **built and live** for both Claude Code and GitHub Copilot; component 1 below.)

![The app issues credentials and reads telemetry back, but device usage goes straight to Azure Monitor](images/architecture-components.svg)

1. The plugin connects to the MCP server at `/api/v1/mcp` after one PKCE browser consent at `/api/v1/oauth/authorize`, which grants `tokenscope.read` and `tag`.
2. The `provision_emit` tool returns a one-time handoff code. The local helper redeems it at `POST /api/v1/setup/redeem` for the durable emit credential and the OTel settings. The handoff is the authentication; the credential never passes through chat.
3. When the client needs to send, it calls `GET /api/v1/instances/{instanceId}/bearer` with its `tokenscope.emit` token. The app mints an Azure Monitor ingest bearer with its own managed identity and returns it.
4. The client sends OTLP log events with that bearer straight to the data collection endpoint. No TokenScope process sits in this path.
5. The data collection rule writes the events to the `OTelLogs` table in `log-<name>`.
6. Each of the 33 `caj-ts-*` cron jobs posts an HMAC-signed request to `/api/v1/internal/run-worker/{name}`. The registry holds 34 workers; `archive-ledger` is deliberately unscheduled.
7. The read joiner, `azure-monitor-read`, queries `OTelLogs` by KQL with the managed identity.
8. `analytics-poll`, `reconciliation-sync` and `copilot-pool-bill` pull usage and bills from the provider APIs.
9. Every component reads and writes PostgreSQL: the credential endpoints keep `instance_attestation`, `emit_handoff` and `oauth_token`, and the workers write the spend tables.
10. People sign in with Entra and use the dashboard and the `/api/v1/reports/*` API.

_TokenScope never brokers usage: it hands out credentials and reads the telemetry back from Azure Monitor._

- **MCP server + OAuth 2.1** — the `/api/v1/mcp` remote MCP server (read/tag tools + prompts), authenticated by one PKCE browser consent (`tokenscope.read`+`tag`). The read-scoped `provision_emit` tool locates-or-creates the `instance_attestation` and mints a one-time `emit_handoff`; the local helper redeems it at `POST /api/v1/setup/redeem` for the durable emit credential + the OTel env bundle (Claude Code: written into `~/.claude/settings.json`; Copilot: `~/.tokenscope/config.copilot-cli.json`).
- **Bearer-refresh endpoint** — `GET /api/v1/instances/{instanceId}/bearer`, the `otelHeadersHelper` target; OAuth `tokenscope.emit` authed (not a cookie), returns the Azure Monitor bearer.
- **Emitters** — Claude Code emits `api_request` **log events** natively, directly to Azure Monitor, with our injected `OTEL_RESOURCE_ATTRIBUTES` (`tokenscope.instance_id`, `project.code_hash`, `tool`, and optionally `tokenscope.activity`, the folder's default activity, which the joiner keeps only when it names a standard activity type); no TokenScope code runs in the CLI process. For Copilot (CLI and App), the plugin's **usage extension** reads the runtime's `assistant.usage` events and sends the same `api_request` record shape as OTLP-logs protobuf ([Copilot CLI Client](Copilot-CLI-Client.md)).
- **Azure Monitor OTLP endpoint → LAW** — DCE + DCR route the built-in OTel log stream into the `OTelLogs` table on a Log Analytics Workspace.
- **TokenScope app** — attribution + costing engine, registry, dashboard, REST API, worker registry.
- **Read joiner + workers** — a static registry of **33 workers** invoked by an external scheduler; the `azure-monitor-read` worker is the read joiner. See [Background Workers](Background-Workers.md) for the full roster.
- **TokenScope DB** — the authoritative *derived* state and the join source-of-truth.

## Attribution data flow

> **This section is a summary. [Data Flow](Data-Flow.md) is the authority** — it
> carries the full diagrams, the §A/§B split, the cost ladder and the known gaps.

**Three** live ingest paths feed the spend surfaces, not two:

![Three ingest paths write their own tables; the attributed view combines them, and the billed reads take only the API lane](images/architecture-ingest-paths.svg)

1. `azure-monitor-read` (every 5 minutes) reads `OTelLogs`, resolves the teammate from `instance_attestation`, applies the membership gate and the provider org lane, costs each event, and writes `attribution_record`.
2. `analytics-poll` (every 15 minutes) re-pulls the last 30 days from the Anthropic Analytics API into `actual_spend`, keeping the provider payload in `raw_payload`.
3. `reconciliation-sync` (hourly) writes per-teammate Copilot usage to `reconciliation_record`. The dashed edge is its per-seat rows in `actual_spend`, which are showback only and excluded from every chargeback view.
4. `copilot-pool-bill` (daily) writes the pooled enterprise bill to `copilot_pool_bill`.
5. `provider-transform` (hourly) derives `provider_usage_fact`, the API lane with model and cost type, from `actual_spend.raw_payload` and, for Copilot, `reconciliation_record`.
6. `usage-reconciliation` (every 2 hours) compares the API figure with OTel per teammate, day and tool and writes the remainder to `unaccounted_usage`.
7. §A attributed usage is `v_complete_usage`. It combines OTel detail, the API-minus-OTel remainder, and the tools that never emit telemetry.
8. §B reads only the API lane: the billed axis reads `provider_usage_fact`, and the chargeback views read Anthropic rows in `actual_spend` and `copilot_pool_bill`. None of them reads `attribution_record`.

_Telemetry and the provider APIs land in separate tables; §A combines them, and §B reads only the API lane._

- **Telemetry path (detail, ~5% of the estate):** the joiner queries `OTelLogs` via KQL, joining on the TokenScope-minted `tokenscope.instance_id` (the device/enrolment INSTANCE id — not Claude's own per-SESSION `session.id`, which is captured per-record as `claude_session_id`), applies the membership gate and org-lane selection, costs each span, and writes `attribution_record`. A membership failure does **not** discard the row: it is written with `project_id` NULL, i.e. unallocated.
- **Anthropic Analytics path (truth, 100%):** `analytics-poll` polls each *reconciled* org over a **trailing 30-day window** (`[now−30d, now]` — *not* month-start), one UTC day at a time, and upserts idempotent daily rows into `actual_spend`. Each row lands in a **per-surface tool lane**. Zero reconciled orgs = clean no-op.
- **Copilot path:** `reconciliation-sync` writes per-teammate §A usage to `reconciliation_record`; `copilot-pool-bill` writes the pooled §B bill to `copilot_pool_bill`. Copilot rows in `actual_spend` are **showback-only** and are firewalled out of every chargeback view by name.
- **Billed lane:** the hourly `provider-transform` worker (plus its GitHub arm) derives `provider_usage_fact` — per-(teammate, day, tool, **model**, cost_type, context_window) facts — from the captured provider payloads (`actual_spend.raw_payload`; `reconciliation_record` for Copilot). The billed/chargeback reporting axes and the model split read it. `server/reporting/engine/` (scope, kpis, drivers, billed-axis, budget-axis, …) is the reporting read layer every `/api/v1/reports/*` route composes.
- The read joiner is **pull-and-rejoin**, not write-once. It re-scans joinable sessions each tick with a **5-minute** watermark overlap — events later than that are recovered only by the daily `telemetry-recovery` pass (the last 7 days, one instance-day at a time) or an operator recovery, **not** automatically on the next tick.

## Technical / deployment topology

The VNet-integrated deployment runs the app on **Azure Container Apps** with **internal ingress** (a private VIP) behind either **Azure Front Door Premium over Private Link** (recommended) or **your own WAF / reverse proxy**. PostgreSQL, Redis, Key Vault and ACR all sit behind private endpoints. The platform pulls images and resolves Key Vault secrets with the app's managed identity; the app reaches PostgreSQL with a password held in Key Vault. See [Network Architecture](Network-Architecture.md).

![VNet posture: the edge is the only public way into the app, and Key Vault, PostgreSQL and ACR answer only on private endpoints](images/architecture-topology.svg)

1. Browsers and the client plugins reach the app only through the edge. Front Door Premium connects to the environment's internal VIP over Private Link; your own WAF reaches it over the VNet.
2. The 32 `caj-ts-*` jobs run in the same environment with the same image and post HMAC-signed requests to the app.
3. The platform pulls the image from ACR with the managed identity (AcrPull).
4. The platform resolves the app's Key Vault secret references with the managed identity (Key Vault Secrets User).
5. The app connects to PostgreSQL with a password-bearing connection string from Key Vault, not with the managed identity.
6. The app queries `OTelLogs` with the managed identity (Log Analytics Reader). When the query path is private-only, that query goes through the optional `pe-ampls` endpoint.
7. Devices send telemetry to the public ingest endpoint directly, not through the edge.
8. The environment's console and system logs go to `log-ops-<name>` through a diagnostic setting when `separateOpsWorkspace` is on, and to `log-<name>` otherwise.
9. Key Vault, PostgreSQL and ACR diagnostics follow the same rule.

_With `enablePrivateNetworking` on, the edge is the only way in, and the data stores have no public endpoint._

- **The edge** is the only public ingress; it terminates TLS and forwards to the internal ACA VIP. Front Door Premium (`enableFrontDoor`, `frontDoorSku='Premium'`) reaches it over Private Link and, once `frontDoorId` is set, the app rejects requests without Front Door's `X-Azure-FDID` header. Your own WAF reaches it over the VNet, with no header dependency.
- **The ACA environment is internal** (`vnetConfiguration.internal: true`, private VIP) — the app is not publicly reachable except through the edge. `/api/health` remains the ACA probe target.
- **External scheduler** (ACA cron jobs) drives the workers via the HMAC-signed `run-worker/{name}` endpoint — there is no standing worker pool and no BullMQ/Redis queue.
- **PostgreSQL Flexible Server** (private endpoint) holds derived state (audit-trigger append-only). **Log Analytics** is the read-only attribution surface. **Key Vault** (private endpoint) is the single secrets surface; **ACR** (private endpoint) serves container images. **Redis** is provisioned with a private endpoint, but nothing in the app connects to it; sign-in sessions are stored in PostgreSQL.

## The ingestion paths

| Path | Source | Cadence | Role |
|---|---|---|---|
| **Telemetry** | Claude Code + Copilot usage-extension OTLP log events → `OTelLogs` | joiner ~every 5 min | The **detail** axis: session, project, activity, model. Covers only enrolled devices (~5%) |
| **Anthropic Analytics** | Enterprise Analytics API, per reconciled org | poller ~every 15 min | **§A usage truth** — complete, day grain |
| **GitHub Copilot** | metrics report (§A) + enterprise billing usage (§B) | `reconciliation-sync`, `copilot-pool-bill` | §A usage and the §B pooled bill |

Telemetry is unsampled **at ingest** but is not "full fidelity" at read: zero-token rows are pruned, an unparseable timestamp or an unsafe `model` drops the row, and a span with neither a provider cost nor a rate line is not written at all. Every drop is counted.

The provider APIs supply the authoritative spend; they are not a "ceiling" over telemetry. The API lane carries the provider's own figure. The attributed lane carries the cost reported on each event where it is present and usable; otherwise its amounts are rate-card estimates (`server/usage/span-costing.ts`). `actual_spend` is displayed directly as usage money via `v_complete_usage`. See [Data Flow](Data-Flow.md).

## Trust model

**Source split — attested identity × claimed project.** Attribution combines two independently-sourced facts: the **teammate** is resolved from the **authed device attestation** by `tokenscope.instance_id` (the DEVICE_SID / device-enrolment INSTANCE id, bound to the teammate at an authenticated device enrol; the id on each event is itself a claim that anyone with ingest access can set, see R7 in [Security Overview](Security-Overview.md)), while the **project** is taken from the emitted per-event `.tokenscope` `project.code_hash` (a *claim*). The membership gate decides whether the two combine into a bill.

**Membership gate — "tag proposes, membership disposes."** The `project.code_hash` in a session's resource attributes is a *claim*, not an authorisation. Before billing the attested teammate's spend to the claimed project, the joiner checks the teammate is a *current* `project_assignment` member. If not, it **withholds** the attribution, the spend spills to untagged (for retroactive tagging), and an `attribution-spill-unauthorized` audit event fires. The same gate guards repo tagging (the MCP `tag_session` / `resolve_repo_project` tools and the `/me/sessions/{sid}/assign` quick-assign only admit projects the teammate is a member of).

**Org-lane fidelity** — the `provider_org` registry sets each org's lane by `organization.id`:

| Lane | Fidelity / cost basis | Billing |
|---|---|---|
| **reconciled** | tier-1, `cost_basis = provider-reported` (or `estimated` only if the rate card had to price it) | billed |
| **indicative** | tier-2 / telemetry-only | tracked, excluded from billing |
| **unknown org** | tier-2 / telemetry-only, best-effort + `attribution-org-unclassified` audit event | never billed |
| **any `/tokenscope:backfill` re-emit** | forced tier-2 / telemetry-only regardless of org | never billed |

The table describes the **Claude** lane. `tool = 'copilot-cli'` skips the `provider_org` lookup entirely and is unconditionally tier-2 / telemetry-only.

## Region & RBAC

- **Region:** multi-region operating model on the surface; a deployment lands in a single region. A region-local stack is design-surface only.
- **Region derivation (placement).** A cost-bearing teammate's home region/unit is derived by a fixed precedence (highest wins): **cost-centre** (exact directory cost-centre → cost-owning unit) > **unit-rule** (a directory-attribute rule naming a cost-owning unit) > **chain-unit** (manager-chain resolves to an owned unit/practice, up to 12 managers) > **chain-region** (manager-chain resolves to a region leader) > **attribute-rule** (a configurable directory-attribute → region rule) > **billing-region** (provider license-org → region fallback) > **global** (the unassigned holding node). `placement-sync` runs this bill-driven placement; `region-reenrichment` re-derives it on a `0 */6 * * *` cadence to heal stale/unplaced homes. See [Background Workers](Background-Workers.md).
- **RBAC:** roles (cost-owning unit owner, regional/global FinOps, manager, admin) scoped by region + org-unit path, enforced in the **application** — `requireRole` plus per-resource scope predicates, with report reach as a revocable per-teammate grant (see [Authentication & Security](Authentication-and-Security.md)); dashboard auth is Entra via `nuxt-oidc-auth`. The admin area is a persistent admin shell (sidebar-navigated) with an Overview launcher, first-class Providers, a Settings split into System info + Policies, and a roles glossary.

## Built vs Planned

**Built (shipped):**
- **Claude Code client** — MCP server + OAuth 2.1 client backbone (PKCE consent, dynamic registration, grant lifecycle / revoke), `provision_emit`→`/setup/redeem` device provisioning + bearer-refresh, native OTel log-event ingestion, logs→LAW→KQL read joiner with membership gate + org-lane reconciliation.
- **GitHub Copilot client** — same MCP/OAuth backbone + `copilot-plugin/` (four skills: `tokenscope-setup`, `project`, `usage`, `status`) and its **usage extension** (`extensions/tokenscope-usage/`), which the Copilot runtime loads in the Copilot App and in the CLI: it reads `assistant.usage` events, spools them locally, and sends `api_request` OTLP-logs protobuf to Azure Monitor. The plugin still carries an older file forwarder, which sends only when Copilot's `EXTENSIONS` feature is off; it is due to be removed. Provisioning writes `~/.tokenscope/config.copilot-cli.json`. Each CLI keeps its own store — the Claude lane's is `config.claude-code.json` — so enrolling one never overwrites the other's. Copilot's OTel-observed `attribution_record` rows are **indicative** (tier-2 / telemetry-only), priced at 1 AI credit = $0.01 USD; its §A usage comes from `reconciliation_record` (GitHub `ai_credit/usage`) and its §B bill from `copilot_pool_bill`.
- 33-worker scheduler-driven registry, dashboard with budgets/rollups/untagged worklist, trigger-enforced audit log, internal ACA ingress behind Front Door Premium or your own WAF.

**Planned (future-state, not built):**
- **F2 — promoting Copilot telemetry from tier-2 to tier-1.** Copilot is already chargeable: the GitHub billing adapter, `copilot-bill` and `copilot-pool-bill` ship today, and each GitHub organisation's pooled bill (`copilot_pool_bill`) is charged monthly to the Business Unit it maps to (`v_finance_copilot_pool_chargeback`), leaving out spend that is not charged back (see [Reporting](Reporting.md)). Telemetry never sets that amount, for Copilot as for Claude, and Copilot's billed cost is not split across projects. What remains is only the telemetry lane's fidelity: Copilot's OTel rows are always tier-2 (indicative), where Claude's are tier-1 when their organisation is reconciled.
- Financial (FIN) connectors — full Polaris/Workday/SAP adapters (only the `connector-health` worker against `sync_conflict` rows shipped).
- BullMQ/Redis job queues + audit-log mirror to Log Analytics.
- Foundry-routed AI coaching.
- Per-region self-contained stacks.
