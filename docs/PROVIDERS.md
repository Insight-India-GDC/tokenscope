# Providers

TokenScope attributes any AI-coding tool that can emit OpenTelemetry token usage
(or expose a usage/billing API). Two are supported today; more follow as OTel and
provider APIs allow. Both onboard through **one OAuth-2.1 MCP server** and follow
the same **zero-touch, emit-now-attribute-later** principle.

## Claude Code

**Plugin:** `plugin/`.

- **Onboarding** — an MCP server (`/api/v1/mcp`) plus prompts (`tokenscope-setup`,
  `project`, `tag`, `usage`) and local commands (`/tokenscope:setup`,
  `/tokenscope:status`, `/tokenscope:statusline`, `/tokenscope:backfill`). One
  OAuth consent.
- **Emission** — **native OpenTelemetry**. Claude Code emits OTLP `api_request`
  log events (the token counts per API call) directly to the telemetry sink. The
  setup step mints a one-time handoff that is redeemed for a durable emit
  credential and points Claude's OTel exporter at your workspace.
- **Identity** — the setup step injects the server-minted `tokenscope.instance_id`
  resource attribute, so every emitted record joins to a teammate unspoofably.
- **Billing (§B)** — Anthropic's Enterprise Analytics bills **per user**, and
  TokenScope charges it per teammate — **per surface**. Each Claude surface is its
  own chargeback lane: Claude Code, Claude Chat, Cowork, Office Agents, Claude in
  Chrome, Claude Design, and Claude in Slack, with anything the API cannot
  attribute landing in a labelled *Claude (other)* lane rather than silently
  dropped or folded into Claude Code. Session **tagging stays Code-only**: the
  non-Code surfaces have no sessions to tag, so they are chargeback-only (§B) and
  appear read-only in a developer's usage view — they never generate
  "needs tagging" work (§A/§B separation).

### Install

Your deployment serves its own Claude Code marketplace, with a plugin that
already points at it. Inside a Claude Code session, run these one at a time:

```
/plugin marketplace add https://<your-tokenscope>/api/v1/plugin/marketplace.json
/plugin install tokenscope@tokenscope
```

When asked, choose **Install for you**. No Git and no server URL to set (Claude
Code 2.1.224+). If that doesn't work for you, install from your fork with Git
instead (`/plugin marketplace add <your-org>/<your-fork>`) and then
[point the plugin at your deployment](../plugin/README.md#point-the-plugins-at-your-deployment). Then sign in, turn on tracking and
restart, as in the [Quick start](../plugin/README.md#quick-start).

In the Claude desktop app, `/plugin marketplace add` opens a form that takes only
Git hosts, so the app installs through settings instead: see
[Claude Desktop](../plugin/README.md#claude-desktop), or the Connect dialog's
**Claude Desktop** guide.

## GitHub Copilot

**Plugin:** `copilot-plugin/`.

- **Onboarding** — the same MCP server plus skills (`tokenscope-setup`,
  `project`, `usage`, and `status`, the Copilot analogue of `/tokenscope:status`).
- **Emission** — the plugin's **usage extension**
  (`copilot-plugin/extensions/tokenscope-usage/`), loaded by the Copilot runtime
  (the Copilot App, and the CLI with extensions enabled). It reads Copilot's
  `assistant.usage` events, spools them locally and sends them as OTLP log
  records to the same telemetry sink, carrying the same `tokenscope.instance_id`
  key, so a device's Claude and Copilot usage unify. An older file-based
  forwarder still runs for terminals that export
  `COPILOT_OTEL_FILE_EXPORTER_PATH`; it is a legacy lane. The server can also
  read Copilot's own OpenTelemetry under the GenAI semantic conventions
  (`gen_ai.usage.*`), but that read-side is **off by default**
  (`NUXT_COPILOT_NATIVE_OTEL=true` turns it on; see `server/azure/reader.ts`).
- **Billing (§B)** — GitHub Copilot bills a **pooled** allowance per (org, SKU),
  which TokenScope charges **per Business Unit** via a configured GitHub-org →
  Business Unit map — read from the bill, not inferred from seats. Per-user
  Copilot usage is *shown* (§A), not charged.

### Install

As for Claude Code, install from the marketplace that carries your deployment's
host ([Point the plugins at your deployment](../plugin/README.md#point-the-plugins-at-your-deployment)).
In a terminal, one at a time:

```bash
copilot plugin marketplace add <your-org>/<your-fork>
copilot plugin install tokenscope-copilot@tokenscope
```

Then run the `tokenscope-setup` skill inside a `copilot` session, restart
`copilot`, and check with the `status` skill.

## Reconciliation (both providers)

Alongside the streaming OTel signal, a batch **truth-poller** reads the
provider's usage/billing API and reconciles:

- **§A completeness** — fills the gap between the provider's per-user/day total
  and what OTel captured, so "my usage" is never under the provider's truth.
- **§B billing** — the authoritative cost-of-record, at the provider's billing
  grain.

Per-organisation **reconciliation lanes** decide whether a provider's spend is
*reconciled* (billable) or *indicative* (tracked-only) in a given environment.

## Adding a provider

The attribution pipeline (`attribution_record`, the read-joiner, rate cards, the
reconciliation engine) is provider-generic — it branches on a `tool`/source and
carries provider-specific operands (e.g. token counts vs credits) as first-class
fields. A new provider needs: an emission path (native OTel is ideal), an
identity join key (reuse `tokenscope.instance_id`), and — for §B — a usage/billing
API adapter. Contributions welcome; see [CONTRIBUTING.md](../CONTRIBUTING.md).
