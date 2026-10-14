# TokenScope — Engineering Wiki

The **built spec** for TokenScope: the living, as-built reference for developers,
maintainers, and operators. For _why_ the system is shaped this way see
[ARCHITECTURE.md](../ARCHITECTURE.md) and [PRINCIPLES.md](../PRINCIPLES.md); this
wiki is _what is actually running_.

> **Status: released.** The running version is on `/api/v1/meta/build`; release
> notes are in `CHANGELOG.md`. TokenScope runs end to end on Azure
> ([DEPLOY-AZURE.md](../DEPLOY-AZURE.md)). **Claude Code and GitHub Copilot are
> both supported clients**, on a shared MCP server + OAuth 2.1 backbone.
> Usage is reconciled against the provider APIs on both lanes — Anthropic's
> Analytics API and GitHub's Copilot billing API — and reporting covers
> attributed usage, chargeback and budgets.
>
> The tenant OTLP bridge and finance-system connectors are designed but **not
> built**. Every page marks _Planned_ items explicitly, and the
> [Security Overview](Security-Overview.md) keeps an open register of accepted
> residual risks — read both before assuming a control is in force.

## The system at a glance

![TokenScope at a glance: telemetry says whose work it was, the provider APIs say how much, and TokenScope reconciles the two](images/home-at-a-glance.svg)

1. Claude Code and the Copilot CLI send OTLP usage log events straight to Azure Monitor, which stores them in the `OTelLogs` table. Each event names the device's enrolment and, when the repo is tagged, the project.
2. TokenScope's read joiner queries `OTelLogs` by KQL every five minutes.
3. The plugin talks to TokenScope over MCP: it enrols the device once, and later tags sessions to projects.
4. TokenScope pulls complete daily usage and bills from the Anthropic Analytics API and the GitHub Copilot APIs. These cover every teammate in an onboarded scope, enrolled or not.
5. The dashboard serves budgets, rollups, the untagged worklist and chargeback.

_Telemetry carries the detail, the provider APIs carry the amount, and TokenScope reconciles them per teammate and day._

TokenScope joins AI-tool usage telemetry to project financials so every token of
spend is attributed to a project (or spills to a named cost-owning unit). It
governs by _financial gravity_ — additive budgets, velocity limits, a spill
bucket — not static quotas.

## Pages

**Engineering (built spec):**

- **[Architecture](Architecture.md)** — logical + technical architecture, the attribution data flow, the trust model.
- **[Data Model](Data-Model.md)** — the as-built Postgres schema, by domain.
- **[Reporting](Reporting.md)** — showback vs chargeback, the three axes (provenance, billing status, lane), the per-metered-lane §A ≥ §B invariant, and the contract every report is built against.
- **[API Reference](API-Reference.md)** — the `/api/v1` endpoints clients and operators use, their auth gates and purpose.
- **[Background Workers](Background-Workers.md)** — the external-cron scheduler + the 33 workers.
- **[Claude Code Client](Claude-Code-Client.md)** — the plugin, provisioning flow, and the OTel telemetry contract.
- **[Copilot CLI Client](Copilot-CLI-Client.md)** — the GitHub Copilot plugin, its usage extension, and the Copilot spend model.
- **[Deployment & Operations](Deployment-and-Operations.md)** — Azure topology, the deploy pipeline, environments, runbooks.

**Security & network (review surfaces):**

- **[Security Overview](Security-Overview.md)** — InfoSec entry point: trust boundaries, threat-model summary, controls (current + planned), risk register.
- **[Attributed and Billed](Attributed-and-Billed.md)** — the trust model: what is money and what is indicative, what a developer can change, the checks, and the known limitations.
- **[Design Decisions](Design-Decisions.md)** — each architecture decision record (ADR) the wiki cites, summarised as it stands today.
- **[Authentication & Security](Authentication-and-Security.md)** — auth flows, RBAC, RLS, CSRF, Front Door.
- **[Data Protection](Data-Protection.md)** — data classification, PII, what is _not_ collected, retention, residency.
- **[Network Architecture](Network-Architecture.md)** — current vs target Azure network: VNet isolation, ingress/egress, public surfaces, ingestion points.

## Conventions

This wiki is published from `docs/wiki/` in the main repo by the **Publish Wiki**
GitHub Action — edit the Markdown there, not the wiki directly. Pages are
diagram-forward and concise by design.
