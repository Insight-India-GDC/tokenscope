# Deployment and Operations

How TokenScope is deployed and operated on Azure. Audience: developers,
maintainers, operators. See also [Architecture](Architecture.md) and
[Background Workers](Background-Workers.md).

> TokenScope ships two deployment **modes**: a simpler **sandbox** shape (public
> ingress + RBAC, `example-sandbox.bicepparam`) and a **VNet-integrated** shape
> (internal ACA, data plane over private endpoints, `example-vnetted.bicepparam`)
> for staging and production. This page documents the VNet-integrated mode;
> every environment follows the same Bicep with different switches. The
> step-by-step walkthrough is [DEPLOY-AZURE.md](../DEPLOY-AZURE.md).

## Azure topology

In the VNet-integrated mode the ACA environment has a **private VIP** (internal
ingress) and the data plane (Postgres, Redis, Key Vault and **ACR**) is reached
over **private endpoints**. The public entrypoint is one of:

- **(a) your own WAF / App Gateway / reverse proxy** in front of the internal
  app, or
- **(b) Azure Front Door Premium over Private Link** (`enableFrontDoor=true`,
  `frontDoorSku='Premium'`), the recommended production shape: nothing is
  exposed except through Front Door's WAF.

A single **user-assigned Managed Identity** carries every grant the app needs.

![One user-assigned identity carries every grant the app and its jobs need; PostgreSQL is the exception, reached with a password kept in Key Vault](images/deployment-and-operations-identity.svg)

1. The Container App and every `caj-ts-*` job run as the same user-assigned identity, `id-<name>`.
2. `AcrPull` on the registry lets the app and the jobs pull their image.
3. `Key Vault Secrets User` lets them resolve their secrets as Key Vault references.
4. `Monitoring Metrics Publisher` on the OTLP data collection rule is what the device ingest bearer carries: the app mints it with this identity and hands it to enrolled devices. `Monitoring Reader` on the same rule feeds the read path's ingest-coverage probe.
5. `Log Analytics Reader` on the telemetry workspace lets the read joiner run its KQL.

*Every grant the running system needs sits on one identity. PostgreSQL takes a password login instead, and Redis is provisioned but unused.*

The network layout (subnets, private endpoints, the ops workspace) is drawn on
[Network Architecture](Network-Architecture.md).

- **The ACA environment is INTERNAL** (`internalIngress=true`, driven by
  `enablePrivateNetworking`), so the Container App has a private VIP and is not
  directly reachable on the public internet.
- **Front Door in this mode must be Premium.** Standard can only reach a public
  origin, and the template refuses `enablePrivateNetworking` + `enableFrontDoor`
  + `frontDoorSku='Standard'` at validation, before anything is created. Premium
  requests a private endpoint on the managed environment, which must be
  **approved while the apply runs**: start the apply with `--no-wait`, then run
  `infra/scripts/approve-front-door-private-link.sh <rg>`. Premium adds the
  managed WAF rule sets (DRS 2.1, Bot Manager 1.1), which start in `Log` mode
  (`frontDoorWafManagedRuleAction`); switch to `Block` once the logs are clean.
- **Data plane and ACR are all private.** KV, PG, Redis and the **Premium ACR**
  each sit behind a private endpoint on the PE subnet (`/28`, 11 usable: 4 PEs
  plus headroom), resolved through private DNS. ACR public access is Disabled;
  image pull is MI-only.
- **All secrets** resolve via Key Vault references using the **user-assigned MI**.
  The same MI holds AcrPull (image pull), KV Secrets User, Log Analytics Reader,
  Monitoring Metrics Publisher and Monitoring Reader. RBAC role assignments are
  gated on `deployRbac`.
- **Telemetry read** is via MI: the app mints an MI bearer and reads token-usage
  from Log Analytics (the LAW shared key is fetched in-module via `listKeys()`,
  never crossing a module-output boundary).
- **Cron jobs** (`caj-ts-*`) are ACA jobs in the same environment that
  HMAC-trigger the in-app worker endpoint `/api/v1/internal/run-worker/{name}`
  at `workerBaseUrl`: the internal Container App address with your own WAF, or
  the Front Door endpoint once `frontDoorId` is set (the app then refuses direct
  calls). See [Background Workers](Background-Workers.md).

## Deploy pipeline

Any deployment can be run by hand from [DEPLOY-AZURE.md](../DEPLOY-AZURE.md), or
automated with the two copy-in example workflows in `examples/github-actions/`
(setup: [examples/github-actions/README.md](../../examples/github-actions/README.md)).
Copy both into `.github/workflows/` in your fork. Both sign in to Azure with OIDC
(a federated credential, no stored Azure secret) and share a concurrency group
per environment, so they never overlap.

Infra (Bicep) and image rolls are separate cycles:

- **`tokenscope-infra.yml`** compiles your committed parameter file, runs
  `what-if`, and in `apply` mode starts `az deployment group create --no-wait`
  and runs `infra/scripts/approve-front-door-private-link.sh`, which approves
  Front Door Premium's Private Link request while the apply runs (for any other
  posture it just waits for the deployment). A first apply, which stops at the
  Container App because no image exists yet, ends green with a notice; any
  other failure fails the run. Worker jobs are created one at a time, named
  `<workerJobPrefix>-<worker>` (default `caj-ts`). The parameter file reads every secret from
  environment variables, which the workflow maps from the GitHub environment's
  secrets.
- **`tokenscope-deploy.yml`** builds the image under the commit tag, rolls the
  Container App, verifies the new build, and only then moves `latest`.

![latest moves only after Azure confirms the new revision serves this commit; a failed roll or verification restores the image that was running before](images/deployment-and-operations-pipeline.svg)

1. After the OIDC sign-in, the job finds the registry and the Container App and records the image running now as the rollback target, pinned by digest when the registry is readable from the runner.
2. The `build` input picks where the image is built, tagged with the 12-character commit SHA: `acr-task` in ACR Tasks (public registry only), `docker` on a runner inside the network, `acr-agent-pool` in an ACR Tasks agent pool in `snet-build`, or `prebuilt` when your own pipeline already pushed it.
3. `az containerapp update` rolls the app to the commit tag.
4. Azure's view comes first: the newest revision runs this image, is `Healthy` and is the ready revision. Then, if an address is known, an HTTP check that `/api/v1/meta/build` reports this commit and `/api/health` returns 200.
5. `az acr import` copies the commit tag to `latest`, which the worker jobs and the next infra apply use.
6. A failed roll or verification rolls the app back to the recorded image and leaves `latest` alone. A failed promotion does not roll back, because the new build is already verified and serving.

*`latest` only ever names a build that passed verification.*

- **Build path is chosen by the `build` input.** `acr-task` builds in Azure and
  only works against a registry that accepts public traffic (sandbox). A
  VNet deployment's registry is private-endpoint-only, so it builds from inside
  the VNet: `docker` on a self-hosted runner that can reach the registry's
  private endpoint, or `acr-agent-pool` (an ACR Tasks agent pool, a preview
  feature) while the workflow stays on a GitHub-hosted runner. Both use the
  build subnet (`buildSubnetPrefix`, below).
- **Verification needs no network path to the app.** The workflow first checks
  Azure's view: the newest revision runs this commit's image, is `Healthy`
  (its `/api/health` probes pass) and is the ready revision. It then checks over
  HTTP that `/api/v1/meta/build` reports this commit and `/api/health` returns
  200, at `TOKENSCOPE_HEALTH_URL` if set, else the app's `APP_PUBLIC_ORIGIN`,
  else the app's own address when its environment is not internal. With none of
  these it stops at Azure's view.
- **`latest` moves only after verification**, so worker jobs and the next infra
  apply always get a build that passed. On failure the workflow rolls the app
  back to the image it ran before (pinned by digest where the registry is
  readable) and leaves `latest` alone.
- The deployment identity needs **Owner** on the resource group, because the
  template creates role assignments.

## Reference

### Resource naming

Child resources follow `{kind}-{projectName}-{env}-{regionShort}` (`projectName`
defaults to `tokenscope`). `regionShort` is **derived from `location`** in
`main.bicep`. ACR is the exception — alphanumeric only, hyphens stripped:
`cr{projectName}{env}{region}`. The scheduled worker jobs are named
`caj-ts-{worker}` regardless of project or env, so one resource group holds one
deployment. ACA job names are capped at 32 characters, so a long worker name
takes a short override: `privileged-identity-cleanup` runs as
`caj-ts-priv-identity-cleanup`.

| Kind | Pattern |
|---|---|
| Resource group | Passed at `-g` (may follow your organisation's naming standard) |
| Container App | `ca-{projectName}-{env}-{region}` |
| Container Registry | `cr{projectName}{env}{region}` (Premium when private, else Basic/Standard) |
| Key Vault | `kv-{projectName}-{env}-{region}` (truncated to 24 characters) |
| Managed Identity | `id-{projectName}-{env}-{region}` |

Only the child resources follow the `{kind}-...` scheme; the RG name is passed at
`-g` and may follow an org standard.

### Parameters

The per-env contract lives in a `.bicepparam` file (`using ../main.bicep`); start
from `infra/parameters/example-sandbox.bicepparam` or
`infra/parameters/example-vnetted.bicepparam`. Key switches: `env`, `location`,
`enablePrivateNetworking` (VNet + internal ingress + private endpoints),
`deployRbac` (MI role assignments), `enableFrontDoor` + `frontDoorSku` (Standard
fronts a public app; Premium is required with `enablePrivateNetworking`),
`frontDoorWafManagedRuleAction` (Premium only), `monitorQueryPrivateOnly`
(private Log Analytics query; platform logs then go to a separate, portal-readable
`log-ops-<name>` workspace), `appCpu` + `appMemory` (app container size; default
0.5 / 1Gi, production 1.0 / 2Gi), and `buildSubnetPrefix` (optional `snet-build`
subnet for a self-hosted runner or an ACR Tasks agent pool).

Subnet minimums: `/27` for Container Apps, `/28` for private endpoints, and a
`/28` for AMPLS (its endpoint is multi-IP). A `/26` VNet holds exactly those
three subnets and nothing more; `example-vnetted` uses a `/24` so there is room
for `snet-build` (e.g. `10.0.0.64/27`). Replace the `10.0.0.0` base with the
range your IPAM assigns. Declare every subnet in the parameter file rather than
adding one by hand: the template lists the VNet's subnets, so the next apply
removes any it does not know.

`@secure()` params (DB, session/HMAC keys, OIDC secrets, provider credentials)
are never hardcoded: the example files read them from environment variables
(`readEnvironmentVariable`), from your secrets file when applying by hand or
from the GitHub environment's secrets in the example workflow.

### Configurable options & network coordination

- **Build subnet ↔ registry line-of-sight.** A private registry refuses builds
  from outside the VNet. Set `buildSubnetPrefix` and build from `snet-build`
  (self-hosted runner or ACR Tasks agent pool); the subnet needs outbound
  internet (GitHub, base images, Azure services), e.g. through a NAT gateway or
  your firewall.
- **Public entrypoint ↔ internal ACA path.** With your own WAF, decide how it
  reaches the internal Container App; with Front Door Premium it is Private Link.
  The public hostname feeds `entraIdRedirectUri` and `appPublicOrigin`.
- **Private DNS: self-owned vs central.** `networking.bicep` either creates the
  `privatelink` zones (vaultcore / postgres / redis / azurecr) and links them, or
  consumes central zones (`centralDnsZonesSubscriptionId` /
  `centralDnsZonesResourceGroup`) when a platform team runs centralised private
  DNS. Pick per environment.

## Logs and monitoring

Two kinds of data, two workspaces when the telemetry query path is private (the
figure below); one workspace otherwise (see *Without the split*). The usage
telemetry devices send is for the app to read. The platform's own logs are for
operators. Query privacy on a Log
Analytics workspace applies to the whole workspace, so when the telemetry query
path is private (`monitorQueryPrivateOnly`), the platform logs need a workspace
of their own or nobody but the app can read them, crash logs included.

![With private telemetry query, platform logs go to an operator-readable ops workspace; usage telemetry stays in its own workspace](images/deployment-and-operations-logs.svg)

1. Devices send OTLP logs to the public data collection endpoint. The DCR
   writes them to `OTelLogs` (and OTel traces to their tables) in
   `log-<name>`, enriched with the App Insights component `appi-<name>`.
2. The app reads `OTelLogs` with KQL as its managed identity (Log Analytics
   Reader). With `monitorQueryPrivateOnly` on, the workspace answers only
   through an Azure Monitor Private Link Scope, yours or a central one
   (`useCentralAmpls`).
3. The Container Apps environment ships console and system logs, for the app
   and all 32 `caj-ts-*` jobs, through a diagnostic setting into
   `log-ops-<name>` (tables `ContainerAppConsoleLogs`,
   `ContainerAppSystemLogs`). Azure delivers it, so it does not depend on DNS
   inside the VNet resolving a workspace that is outside the private link
   scope.
4. Key Vault, Postgres, ACR and, when `enableFrontDoor` is on, Front Door send
   `allLogs` and `AllMetrics` to `log-ops-<name>`. Redis has no diagnostic
   setting.
5. Operators query `log-ops-<name>` from the portal or CLI, governed by Entra
   roles, from outside the VNet: inside a VNet that resolves Azure Monitor
   through a private link scope, a workspace outside that scope may not be
   reachable. The security audit-write log alert reads it too.

*Edges 3 to 5 exist so an operator can read the platform's logs while the
usage telemetry stays private.*

**Without the split.** `separateOpsWorkspace` defaults to
`enablePrivateNetworking && monitorQueryPrivateOnly`, the condition under which
the telemetry query path is private. With it off there is one workspace, `log-<name>`:
the environment writes to it through its direct `log-analytics` destination
(tables `ContainerAppConsoleLogs_CL`, `ContainerAppSystemLogs_CL`), resource
diagnostics and the log alert use it as well, and its query path is public
under Entra RBAC, so operators read it directly. Turning the split on later
moves new rows only; older rows stay in `log-<name>`.

### Who watches what

![Azure Monitor alerts keep evaluating when the app is down, and one of them watches the app's own alerting](images/deployment-and-operations-alerts.svg)

1. **App down.** Container App `Replicas` maximum below 1 over 15 minutes.
   `minReplicas` is 1, so this means no replica existed for the whole window.
2. **App crash-looping.** `RestartCount` above 1 for one replica over 30
   minutes. Replicas stays at 1 while a replica loops, so rule 1 cannot see
   this.
3. **Database down.** Postgres `is_db_alive` maximum below 1 over 15 minutes.
   A database outage also silences everything on the right-hand side.
4. **Dead-man.** No successful execution of the `caj-ts-ops-alert` job in the
   trailing hour, which expects four. This is the rule that notices when the
   app's own alerting has stopped. It exists when the worker jobs do, that is
   when `workerBaseUrl` is set.
5. **Security audit write failed.** A log alert that counts
   `[SECURITY-AUDIT-WRITE-FAILED]` lines in the console logs of
   `log-ops-<name>`, evaluated every 15 minutes over a 30-minute window so a
   line that arrives late is still counted. It reads logs, not the database,
   because the failure it reports is a database write. With the split it is
   named `alert-security-audit-write-ops-<name>`: Azure cannot move a log alert
   to another workspace, so the rule changes name when it changes workspace.
6. **Platform logs silent.** A log alert that fires when `log-ops-<name>`
   receives no container console line for an hour (Sev 2). Every cron job run
   logs a line, so an hour of silence means log delivery broke, and rule 5
   would be reading an empty table. It exists only when the worker jobs do.
7. **App Insights metric alerts** for 5xx count, response time, exceptions and
   dependency failures (Sev 2 and 3, from `infra/modules/monitoring.bicep`).
   They are deployed, but the app does not run the App Insights SDK, so they
   receive nothing from it and cannot fire on an app failure.
8. The `caj-ts-ops-alert` job (cron `9,24,39,54 * * * *`) triggers the
   `ops-alert` worker inside the app with an HMAC-signed request.
9. The worker evaluates the telemetry read probe, attribution stall, the
   private-link network sweep, worker failures, worker durations against the
   dispatch budget and the telemetry workspace's daily cap, and pushes **critical**
   conditions to the ntfy topic in `NUXT_OPS_ALERT_NTFY_URL` (empty means no
   push).
10. It keeps each condition's state in Postgres and writes every severity to
   the Admins' inbox and the audit log.

*Rules 1 to 6 run in Azure Monitor and evaluate whether or not the app is up,
and notify through the action group when one is configured; the in-app worker covers what only the app can measure, rule
4 covers the worker, and rule 6 covers the logs rule 5 reads.* Rules 1 to 5 are
Sev 1. The action group emails
`alertNotificationEmail`; when that is empty no action group is created, and
the alerts still show in Azure Monitor.

## Ops alerting

Degradation pages the operator; it never waits to be looked at.

- **Evaluator**: the `ops-alert` worker (cron `9,24,39,54 * * * *`, see
  [Background Workers](Background-Workers.md)) checks, each tick: a bounded read
  of the joiner's real telemetry table, the private-link network sweep,
  attribution stall (people emitting, no rows landing), per-worker fleet
  failures, `worker-duration` (a warning: a worker's two latest runs with a
  recorded duration both at or above 80% of the 200 s dispatch budget) and
  `telemetry-cap` (critical: billable ingestion into the telemetry workspace
  over the trailing 24 hours at or above 80% of its daily cap, `TELEMETRY_DAILY_CAP_GB`; a read
  that cannot answer leaves the condition as it was). Every condition needs two consecutive runs at the same severity
  before it is announced; **only `critical` is pushed** to the channel, while
  warnings go to the admin inbox and audit log. Reminders every 6h while
  unresolved; a recovery is pushed only for an alert that was pushed, so a
  warning recovers in the inbox only.
- **Channel**: a public ntfy.sh topic — the 64-char random topic name is the
  access control. The URL is the `@secure()` `opsAlertNtfyUrl` parameter → Key
  Vault `ops-alert-ntfy-url` → container `secretRef`
  `NUXT_OPS_ALERT_NTFY_URL`; empty = alerting disabled (the default). Read it
  from an environment variable in your parameter file, like the other secrets. The
  payload is allowlisted to severity, condition key, env tag, UTC timestamp
  and an aggregate count — nothing else, enforced by tests. Logs record
  host + HTTP status + condition key, never the URL. Rotation = new topic,
  update the value, re-apply.
- **Azure-native legs** (`infra/modules/ops-alerts.bicep`, the existing action
  group + `alertNotificationEmail`): Container App `Replicas` < 1, per-replica
  `RestartCount` > 1 in 30 minutes, Postgres `is_db_alive` < 1, a dead-man on
  the `caj-ts-ops-alert` job's successful executions, a log alert on
  security audit-write failures, and a log alert on the platform-log workspace
  going silent for an hour. These evaluate inside Azure even when the
  app, AMPLS or the worker itself is down (they notify only through a configured
  action group); [Who watches what](#who-watches-what)
  draws them.
- **Parity**: every externally-notified condition also upserts one admin inbox
  item (platform-admin) and writes
  `ops-alert-{delivered,failed,reminded,recovered}` audit events.
- **User surface**: while the stall condition holds, Home and My usage show a
  degradation banner ("recent spend may be missing"), and the freshness dot
  never shows green for an age it cannot vouch for — worker and UI share one
  decision function (`server/usage/attribution-stall.ts`).

## Operator pointers

- **Secret rotation** goes through an apply: update your secrets file or the
  GitHub environment's secrets, then re-apply `main.bicep`. **Never**
  `az keyvault secret set` by hand. An
  empty-string secret is a no-op (does NOT clear the existing value — the
  keyvault-secrets SAFETY CONTRACT).
- **CI** (`.github/workflows/ci.yml`) runs static, unit, integration
  (testcontainers Postgres) and smoke jobs. It never deploys.
- **Access split**: Contributor on the RG is enough to read resources and
  `az containerapp logs`, not to rewrite RBAC. The deployment identity needs
  Owner.
- **Key Vault soft-delete** is 7 days for non-prod; switch
  `keyVaultCreateMode=recover` if the KV is torn down and re-applied within that
  window.
</content>
