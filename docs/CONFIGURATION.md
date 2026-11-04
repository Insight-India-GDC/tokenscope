# Configuration

TokenScope is configured entirely by environment variables (no secrets in the
tree). Locally they live in `.env` (copy `.env.example`); in Azure they are
container-app env vars, with secrets sourced from Key Vault. This page groups the
variables by concern. **Required-to-boot** variables are marked ⛔.

> Runtime overlay: secrets and per-environment values are not baked into the
> build — `nuxt.config.ts` declares placeholders and Nuxt overlays the real values
> from the environment at boot, so the same image runs in every environment. The
> one exception is `NUXT_OIDC_AUTH_DEV_MODE`, which is also read at **build** time
> (it decides whether the OIDC module is enabled and which rate-limit profile
> applies). Build production images with it unset.

## Core / boot ⛔

| Variable                                     | Purpose                                                                                                                                  |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL` ⛔                            | PostgreSQL connection string. Also used by the worker CLI.                                                                               |
| `REDIS_URL`                                  | Redis connection string (ephemeral state).                                                                                               |
| `NUXT_SESSION_SECRET` ⛔                     | Signs the app session.                                                                                                                   |
| `NUXT_HMAC_SESSION_KEY` ⛔                   | HMAC key for session integrity (≥32 chars).                                                                                              |
| `NUXT_INTERNAL_WORKER_HMAC_KEY` ⛔           | HMAC key the external scheduler signs worker calls with (≥32 chars). Separate from the session key.                                      |
| `NUXT_DEPLOY_ENV` / `NUXT_PUBLIC_DEPLOY_ENV` | `local` \| `sandbox` \| `dev` \| `staging` \| `production`. Drives the demo-capable allowlist (only `local`/`sandbox` are demo-capable). |

## Auth / OIDC (Microsoft Entra)

Optional during first bring-up (dev mode); required for real sign-in.

| Variable                                                                                                                                                                 | Purpose                                                                                                  |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| `NUXT_OIDC_AUTH_DEV_MODE`                                                                                                                                                | `true` locally disables real OIDC and enables the persona cookie. **Must be unset or `false` in production, both at build and at run time.** |
| `NUXT_OIDC_PROVIDERS_ENTRA_CLIENT_ID` / `_CLIENT_SECRET` / `_REDIRECT_URI` / `_AUTHORIZATION_URL` / `_TOKEN_URL` / `_TENANT_ID` / `_LOGOUT_URL` / `_LOGOUT_REDIRECT_URI` | Entra OIDC app registration wiring.                                                                      |
| `NUXT_OIDC_SESSION_SECRET` / `NUXT_OIDC_AUTH_SESSION_SECRET` / `NUXT_OIDC_TOKEN_KEY`                                                                                     | OIDC module encryption keys — **must stay stable across revisions** or every session breaks on redeploy. Floors: the two session secrets ≥ 48 characters; the token key a base64-encoded 32 bytes (44 characters). A value set below its floor (or with low entropy) logs a warning at boot; it does not stop the app. |
| `NUXT_ALLOW_PERSONA_OVERRIDE`                                                                                                                                            | Demo persona impersonation gate. **Must be `false` in production.**                                      |
| `NUXT_BOOTSTRAP_ADMIN_EMAIL`                                                                                                                                             | First matching Entra sign-in becomes `platform-admin` on JIT creation.                                    |
| `NUXT_ENROLLMENT_SECRET`                                                                                                                                                 | Optional bootstrap secret for the unauthenticated emit-on-install enrol endpoint (`POST /api/v1/setup/enroll`): a plugin presenting it may enrol. Unset = only secrets in the `enrollment_secret` table are accepted. The normal OAuth setup path does not need it. |
| `NUXT_OAUTH_CLIENT_ID`                                                                                                                                                   | Optional; normally unset. MCP clients register dynamically and the redeem response carries each device's real client id. If set, it is only copied into the Copilot provisioning bundle. |

## Telemetry read path (Azure Log Analytics)

| Variable                            | Purpose                                                                                                                                                                                                                                                                                                                              |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `NUXT_TELEMETRY_READER`             | Which telemetry store the read-joiner queries. `log-analytics` in Azure; unset (the default, `local`) reads the local collector at `NUXT_AZURE_MONITOR_ENDPOINT`. |
| `NUXT_LOG_ANALYTICS_WORKSPACE_ID`   | The workspace the read-joiner queries.                                                                                                                                                                                                                                                                                               |
| `NUXT_AZURE_MI_CLIENT_ID`           | User-assigned managed identity client id (query + ingest auth).                                                                                                                                                                                                                                                                      |
| `NUXT_AZURE_MONITOR_AUTH`           | `mi` for managed identity.                                                                                                                                                                                                                                                                                                           |
| `NUXT_AZURE_MONITOR_LOGS_ENDPOINT`  | Full DCR OTLP-logs ingest URL (the Data Collection Endpoint URL). The server hands it to devices at provision time; devices send OTLP there directly.                                                                                                                                                                                                                                                                                                       |
| `NUXT_AZURE_MONITOR_ENDPOINT`       | Local/dev collector endpoint the reader queries; also the logs-ingest fallback when `_LOGS_ENDPOINT` is unset.                                                                                                                                                                                                                       |
| `NUXT_AZURE_MONITOR_QUERY_ENDPOINT` | Log Analytics query endpoint override. Leave unset: the SDK default (`api.loganalytics.io`) also works when the query path is private (`monitorQueryPrivateOnly`). |
| `NUXT_JOINER_INSTANCE_CAP`          | Max instances scanned per read tick (default 500). Raise this — not the liveness window — if `worker_run.result->>'selectionCapHit'` is non-null.                                                                                                                                                                                    |
| `NUXT_JOINER_LIVE_BEARER_HOURS`     | How recently an open instance must have minted an ingest bearer to count as live and be re-scanned, regardless of enrolment age (default 336 = 14 days; min 1, max 2160 = 90 days). Widening is safe but enlarges the selection against `NUXT_JOINER_INSTANCE_CAP`; out-of-range values fall back to the default or clamp, and warn. |
| `NUXT_AZURE_DCR_RESOURCE_ID`        | ARM resource id of the Data Collection Rule, for the ingest-coverage metrics probe (needs Monitoring Reader on the DCR; Bicep sets both). Unset = the probe reports unknown. |
| `TELEMETRY_DAILY_CAP_GB`            | The telemetry workspace's daily ingestion cap in GB. Bicep sets it from the value that sets the cap. The `telemetry-cap` ops alert raises a critical at 80% of it; unset, empty or not positive = the alert cannot decide and stays indeterminate. |
| `NUXT_COPILOT_NATIVE_OTEL`          | `true` enables the native Copilot GenAI read-side (default off).                                                                                                                                                                                                                                                                     |

## Directory placement (Microsoft Graph)

| Variable                    | Purpose                                                                            |
| --------------------------- | ---------------------------------------------------------------------------------- |
| `NUXT_GRAPH_DIRECTORY_MODE` | `graph` to place teammates into Business Units from Entra (directory attributes + manager chain); empty = mock. |
| `NUXT_GRAPH_BASE_URL`       | Microsoft Graph base URL.                                                          |

Placement precedence, highest first: a directory-attribute rule naming a
**unit**; a manager-chain **unit** owner; a manager-chain **region** leader; a
directory-attribute **region rule**. The chain is walked up to 12 managers. The
attribute-rule step lets each tenant map a
region-correlated directory field (company name, country, office location,
state, or department) to a region, curated in the admin **Region rules**
surface — so directories where region tracks an attribute rather than the
manager chain still place correctly.

**Placement check** (admin, platform admins only) compares every teammate's
current region and Business Unit with what the directory derives now. "Start
check" begins a new read of everyone's directory record and manager chain;
each "Run another pass" reads the next batch while some remain, and "Retry failed"
re-reads the people whose lookup failed in this check. Verdicts are worked out on each page load
against the current rules, owners and Region leaders, so a new rule or owner
shows without another check. Select rows and Apply to move them: a region move
signs the person out of the web app, usage already recorded stays where it is,
and people an admin placed by hand need a second confirmation. The Region rules
page has a Preview that lists who a draft rule would move, based on the last
check.

## Providers

| Variable                                                     | Purpose                                                                                                                                 |
| ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| `NUXT_ANTHROPIC_API_ENDPOINT`                                | `https://api.anthropic.com` on reconciled envs; empty = poller no-op.                                                                   |
| `NUXT_ANTHROPIC_KEY_<SUFFIX>`                                | Admin API key for the Anthropic analytics poller (per-org).                                                                             |
| `NUXT_GITHUB_PAT_<SUFFIX>`                                   | Classic GitHub PAT for Copilot reconciliation: `manage_billing:enterprise`, plus `read:org` (and SSO-authorised for each SAML org) so GitHub logins can be joined to directory emails. Name derived from the provider's `credential_secret_name`. |
| `NUXT_GITHUB_APP_KEY_<SUFFIX>`                               | GitHub App private key (base64 PEM) for App-mode reconciliation.                                                                        |
| `NUXT_GITHUB_CHARGEBACK_EXEMPT_ENTERPRISES` / `_EXEMPT_ORGS` | Pooled-chargeback exemptions.                                                                                                           |
| `NUXT_COPILOT_CHARGEBACK_ENABLED`                            | Gate Copilot §B chargeback (default off → usage-vs-pool showback).                                                                      |

## Tuning (all optional, sensible defaults)

`NUXT_RECONCILIATION_GAP_PCT` / `_GAP_USD`, `NUXT_HEARTBEAT_GRACE_MINUTES` /
`_LOOKBACK_DAYS`, `NUXT_BASE_ALLOWANCE_USD`, `LEDGER_ROLLUP_FREEZE_FLOOR_DAYS`,
`MAX_PROVISIONAL_INSTANCES` / `_PER_EMAIL`, `MAX_LIVE_EMIT_INSTANCES` /
`_PER_TEAMMATE`.

The four `MAX_*_INSTANCES*` caps come in pairs, one pair per provisioning door:
`MAX_PROVISIONAL_*` bounds the unauthenticated enrol path
(`server/auth/enroll-provision.ts`), `MAX_LIVE_EMIT_*` bounds the authenticated
one (`server/auth/emit-provision.ts`). Each pair is a per-identity bound plus a
global DoS backstop. Note that one human who uses BOTH Claude Code and Copilot
CLI on one host consumes TWO instances, since an instance is bound to a single
emit tool, so size the per-identity caps for tools-per-person, not people.

## Azure-injected (set by the deploy, not by you)

`APP_PUBLIC_ORIGIN`, `AZURE_FRONT_DOOR_ID`, `AZURE_CLIENT_ID`,
`AZURE_KEYVAULT_URL`, `APPLICATIONINSIGHTS_CONNECTION_STRING`, `GIT_COMMIT_SHA`,
`NITRO_PORT`, `NODE_ENV`, `NUXT_SECURITY_RATE_LIMITER_IP_HEADER`
(`x-azure-socketip` only when Front Door is enforced).

`CONTAINER_APP_NAME`, `CONTAINER_APP_ENV_DNS_SUFFIX` and
`CONTAINER_APP_HOSTNAME` are injected by the Container Apps platform itself (no
Bicep entry). The MCP transport answers to the app's own Container Apps FQDNs
(derived from them) plus its public host (`APP_PUBLIC_ORIGIN` when set); any other
`Host` gets `Invalid Host header`.

`MCP_ALLOWED_HOSTS` (Bicep param `mcpAllowedHosts`, empty by default) is a
**break-glass** comma-separated list of EXTRA hostnames the MCP transport should
answer to, for a fronting topology the derivation above does not model (custom
backend domain, private DNS alias, traffic-label FQDN). Reach for it when MCP
returns `Invalid Host header` on a deployment you cannot immediately re-derive;
prefer fixing the derivation afterwards.

## Workers / scheduler

Workers are triggered by an **external scheduler** POSTing to an HMAC-signed
endpoint — there is no in-app cron:

```
POST /api/v1/internal/run-worker/{name}
X-Internal-Timestamp: <unix seconds>
X-Internal-Signature: hex(HMAC-SHA256(key, `${ts}\n${method}\n${path}\n${sha256(body)}`))
```

Key = `NUXT_INTERNAL_WORKER_HMAC_KEY`; replay window ±300 s. The **source of
truth for worker names and cadences is `server/workers/registry.ts`** (each entry
carries a `recommendedCron`). The Azure deploy ships Container Apps Jobs
(`scripts/cron-trigger.mjs`) to drive them; locally, run one directly with
`npm run worker -- <name>` (or `--list`).
