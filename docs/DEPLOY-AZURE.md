# Deploy to Azure

TokenScope runs as one container on **Azure Container Apps**. Bicep in `infra/`
provisions everything around it: PostgreSQL, Redis, Key Vault, Container
Registry, Log Analytics with the OTLP ingest endpoint, a user-assigned managed
identity, scheduled worker jobs, and optionally a VNet with private endpoints
and Front Door.

Pick a posture. Each has an example parameter file:

| | **Sandbox** | **Staging / production** (VNet-integrated) |
|---|---|---|
| Use it for | Trying TokenScope on Azure: a developer or pilot environment | Anything people rely on |
| Parameters | `infra/parameters/example-sandbox.bicepparam` | `infra/parameters/example-vnetted.bicepparam` |
| Data plane | Public endpoints. Postgres admits any Azure-hosted client (the "Allow Azure services" rule) plus its password; Redis is public with its access key | Private endpoints on Key Vault, Postgres, Redis and the registry; nothing public |
| App ingress | Public (optionally behind Front Door Standard) | Internal only. **Recommended:** Azure Front Door Premium over Private Link, so the only public surface is Front Door's WAF. Alternative: your own WAF / application gateway |
| Deploy with | This guide by hand, or the example workflows | The example GitHub Actions workflows ([examples/github-actions/](../examples/github-actions/README.md)) |
| You provide | An Azure subscription and an Entra app registration | That, plus address space and a way to build images inside the network |
| Time to first sign-in | About an hour | Half a day, most of it waiting on Azure |

Every apply below uses the same command; the staging / production section only
adds steps.

## 1. Prerequisites

### Tools

- A checkout of the latest [release](https://github.com/Insight-Services-APAC/tokenscope-public/releases)
  (`git checkout v<version>`), not `main`: its notes say which of these
  postures it passed on Azure before it was tagged, and anything to do before
  upgrading
- Azure CLI 2.60+ with a current Bicep (`az bicep install` or `az bicep upgrade`), signed in with `az login`
- `openssl` (to generate secrets)
- VNet posture only: Docker, on a machine that can reach the private registry

### Azure

- A subscription and an empty resource group in the target region.
- **Owner** (or Contributor + User Access Administrator) on that resource group.
  The template assigns the app's managed identity its roles, which needs
  permission to create role assignments.
- These resource providers registered on the subscription:

  ```bash
  for ns in Microsoft.App Microsoft.OperationalInsights Microsoft.Insights \
            Microsoft.Monitor Microsoft.KeyVault Microsoft.ContainerRegistry \
            Microsoft.DBforPostgreSQL Microsoft.Cache Microsoft.ManagedIdentity \
            Microsoft.Network Microsoft.Cdn; do
    az provider register --namespace "$ns"
  done
  ```

  If your organisation will not register `Microsoft.Monitor`, set
  `deployAzureMonitorWorkspace = false` (nothing reads that workspace today).
  `Microsoft.Cdn` is only needed for Front Door.
- **Unique names.** Key Vault, Container Registry, Postgres and Redis names are
  derived from `projectName-env-region` and must be globally unique. Change
  `projectName` if the default is taken. Short region codes exist only for
  `australiaeast` and `westus3`; other regions use the full name, and the Key
  Vault name is truncated to 24 characters.

### Entra ID app registration

One app registration serves both sign-in and the directory lookups (people
picker, manager chain). Create it in **Entra ID → App registrations → New
registration**:

1. **Supported account types:** single tenant.
2. **Redirect URI:** leave empty for now. You add it once you know the app's
   public host (sandbox step 5, VNet step 7).
3. **Certificates & secrets:** create a client secret. Note its value; you
   pass it as `entraIdClientSecret`.
4. **API permissions** (Microsoft Graph):
   - Delegated: `openid`, `profile`, `email`, `offline_access`. `User.Read` is
     added by default; keep it.
   - Application: `User.Read.All`. The server calls Graph app-only with this
     registration's credentials to search users and read managers. Deployed
     environments always use real Graph, so this is not optional.
   - **Grant admin consent** for the tenant. `User.Read.All` requires it, and
     tenants that restrict user consent need it for the delegated scopes too.
     Without consent the deployment still works; what fails is visible:
     sign-in stops at Entra's "Approval required" (or "Need admin approval")
     page when users may not consent themselves, and without `User.Read.All`
     the people picker and manager lookups return errors. Developer enrolment, telemetry and
     reporting do not depend on it.
5. **Token configuration:** add the optional claim `email` to the ID token.
   Sign-in needs an email, and the bootstrap admin is matched on it.
6. Note the **Directory (tenant) ID** and **Application (client) ID**.

If "Assignment required" is on for the enterprise application, assign the
users or groups who should sign in. Conditional Access policies apply as for
any other web app. TokenScope has no Entra app roles: roles live in its own
database, and the first admin is bootstrapped by email (below).

Nothing needs registering for the developer plugins. The MCP and device OAuth
clients are created by the server itself.

### Secrets

Generate these once per environment, keep them in a gitignored file (the
repo ignores `*secrets.env`), and load the same file for every apply. Changing
them later signs everyone out or, for the Postgres password, rotates the
database login.

```bash
SECRETS=.azure-sandbox-secrets.env      # one file per environment
cat > "$SECRETS" <<EOF
PG_ADMIN_LOGIN='tsadmin'
PG_ADMIN_PASSWORD='$(openssl rand -base64 24)Aa1!'
SESSION_SECRET='$(openssl rand -base64 48)'
HMAC_SESSION_KEY='$(openssl rand -base64 48)'
INTERNAL_WORKER_HMAC_KEY='$(openssl rand -base64 48)'
OIDC_SESSION_SECRET='$(openssl rand -base64 36)'
OIDC_AUTH_SESSION_SECRET='$(openssl rand -base64 36)'
OIDC_TOKEN_KEY='$(openssl rand -base64 32)'
EOF
chmod 600 "$SECRETS"
```

Then add the client secret from the app registration to the file,
single-quoted: `ENTRA_CLIENT_SECRET='<value>'`.

The example parameter files read every secret from these environment
variables (`readEnvironmentVariable`), so secrets never appear on a command
line, and an apply without the file loaded stops with an error naming the
missing variable. Keep the file out of anything you share: `.gitignore` and
`.dockerignore` both exclude `*secrets.env`.

The session and HMAC keys must be at least 32 high-entropy characters; weaker
values make the app reject sign-ins and worker calls. The three `OIDC_*` values keep sign-in sessions valid
across restarts and replicas: without them every roll signs users out and
sign-in can loop.

### Optional provider credentials

Each is a variable in the same secrets file, read by the parameter file;
remove it from the file and the next apply unhooks it from the app.

- **Anthropic** (Claude spend reconciliation): an Admin API key or an
  Enterprise Analytics key. Add `ANTHROPIC_API_KEY='<key>'` to the secrets file
  and uncomment `anthropicApiEndpoint` in the parameter file. The app reads it
  under the credential name `main`; use that name when you register the
  organisation under **Admin → Reconciliation**.
- **GitHub** (Copilot usage and billing): a classic PAT with
  `manage_billing:enterprise` and `read:org`, or a GitHub App private key
  (base64-encoded PEM). The template has three PAT slots and one App key
  slot, each tied to the credential name you then use when registering the
  enterprise:

  | Secrets-file variable | Credential name |
  |---|---|
  | `GH_PAT_1` | `github-1` |
  | `GH_PAT_2` | `github-2` |
  | `GH_PAT_3` | `github-3` |
  | `GH_APP_KEY_1` (App key) | `github-1` |

  An App key and a PAT can share a credential name: the enterprise's GitHub
  App id decides which one it uses. Any other credential name needs a template
  change (`infra/modules/container-app.bicep`). Upgrading from a release that
  used the earlier named GitHub secrets: see the upgrade note in
  [CHANGELOG.md](../CHANGELOG.md). See [PROVIDERS.md](PROVIDERS.md).

Both can be added later: add the value and apply again.

## 2. The apply command

Every step that says "apply" runs this (swap in your parameter and secrets
files for each environment):

```bash
RG=<your-resource-group>
PARAMS=infra/parameters/my.bicepparam
SECRETS=./.azure-sandbox-secrets.env
set -a; . "$SECRETS"; set +a

az deployment group create --resource-group "$RG" \
  --template-file infra/main.bicep --parameters "$PARAMS" --no-wait
infra/scripts/approve-front-door-private-link.sh "$RG"
```

The script waits for the deployment and exits non-zero with Azure's error if it
fails. It exits 3 when the only failure is a new Container App's missing
image (`MANIFEST_UNKNOWN`), which is how a first apply ends: build the image,
then apply again. It exits 4 when only Azure's platform failed (every failed
resource reports an error such as `InternalError`, a timeout, `Conflict` or
`AnotherOperationInProgress`), or when the deployment succeeded but Front Door
still does not serve the app after 30 minutes: run the same apply again (the
template is idempotent; the example infra workflow does this up to twice). Any
other error names the template or your parameters, and applying again would
fail the same way. With Front Door Premium on a VNet deployment it also approves Front
Door's Private Link request while the apply runs: Front Door does not finish
until that request is approved. Front Door files one request per origin, so
the script approves it only when it is the only one. If another request
carries the same message, one is already approved, or the request was already
waiting before the script started, the script approves none and stops. It
lists each request with the command that approves it. Neither the order nor
the message shows which request is Front Door's. Its private endpoint is in a
Microsoft-managed subscription, while an outsider's is in their own. Reject
any request that is not Front Door's, approve Front Door's with the printed
command (an approval in the portal replaces the message the script looks
for), and run the script again. For every other posture it only waits.

Preview any apply with `az deployment group what-if` and the same `--parameters`.

## 3. Sandbox

1. **Copy and edit the parameters.**

   ```bash
   cp infra/parameters/example-sandbox.bicepparam infra/parameters/my.bicepparam
   ```

   Set `location`, a unique `projectName`, `entraIdTenantId`,
   `entraIdClientId` and `bootstrapAdminEmail` (your own email; the first
   sign-in with it becomes `platform-admin`). Leave `entraIdRedirectUri`,
   `appPublicOrigin` and `workerBaseUrl` empty for now.

2. **First apply.** It creates every resource. The Container App is **expected
   to fail** with `MANIFEST_UNKNOWN`, because the new registry has no image
   yet, so the script exits 3 and says so. The resources that depend on the
   app (alerts, worker jobs) are skipped until the next apply.

3. **Build the image into the new registry.**

   ```bash
   # The registry the Container App from step 2 pulls from (it exists, failing):
   APP=$(az containerapp list -g "$RG" --query "[0].name" -o tsv)
   ACR=$(az containerapp show -g "$RG" -n "$APP" --query "properties.configuration.registries[0].server" -o tsv)
   ACR=${ACR%%.*}
   az acr build --registry "$ACR" --image tokenscope:latest \
     --build-arg GIT_COMMIT_SHA="$(git rev-parse HEAD)" --file Dockerfile .
   ```

   This builds in Azure (no local Docker). Never pass
   `NUXT_OIDC_AUTH_DEV_MODE` to a build: it disables real sign-in in the image.

4. **Apply again.** The Container App now provisions. Its public host is the
   `containerAppUrl` deployment output:

   ```bash
   az deployment group show -g "$RG" -n main \
     --query properties.outputs.containerAppUrl.value -o tsv
   ```

5. **Wire the public host, sign-in and the workers.** In `my.bicepparam` set:

   ```
   param appPublicOrigin = 'https://<containerAppUrl>'
   param entraIdRedirectUri = 'https://<containerAppUrl>/auth/entra/callback'
   param workerBaseUrl = 'https://<containerAppUrl>'
   ```

   `appPublicOrigin` is what the app puts in developer enrolments; without it
   (and without Front Door) it refuses to enrol devices. It is also the server
   URL the Connect dialog shows developers: without it the dialog says the
   deployment has no pinned public origin and shows no URL, rather than
   guessing one. What the dialog tells developers to install is set in
   **Admin → Policies → Client connection** (platform admins).

   In the app registration, add two **Web** redirect URIs:
   `https://<containerAppUrl>/auth/entra/callback` and
   `https://<containerAppUrl>/login` (the post-logout page).

6. **Apply again.** The worker jobs are created and sign-in is live.

7. **Check it.** `curl https://<containerAppUrl>/api/health` returns 200. Sign
   in with the bootstrap email; you land as platform-admin.

### Optional: Front Door

Front Door (Standard + WAF; `frontDoorSku = 'Premium'` adds Microsoft's
managed rule sets) goes in front of the public app in three applies, because
each side needs the other's identity:

1. With `enableFrontDoor = false`: done above.
2. Set `enableFrontDoor = true` and apply. Note the `frontDoorEndpointFqdn` and
   `frontDoorInstanceId` outputs.
3. Set `frontDoorId = '<frontDoorInstanceId>'` and move the public host to Front
   Door: `appPublicOrigin`, `entraIdRedirectUri` and `workerBaseUrl` use
   `https://<frontDoorEndpointFqdn>`, and the two redirect URIs in Entra change
   to match. Devices enrolled before this point hold the old address; re-run
   setup on them. Apply. The app now rejects requests that lack this Front
   Door's `X-Azure-FDID` header (except `/api/health`), which is why the
   workers must call Front Door too.

With Standard the app's own address stays public, and the header check is the
only thing keeping callers on Front Door. Between applies 2 and 3 there is no
check at all: the app answers on its own address and the WAF can be walked
around. After apply 3 the ID it checks is not a secret, so this deters casual
bypass of the WAF but is not a network boundary; a caller who skips Front Door
also picks the address the rate limiter counts against. App sign-in still
applies either way. That is fine for a sandbox; for production use the VNet
posture with Front Door Premium, where the app has no public address at all.

## 4. Staging and production (VNet-integrated)

The app, its jobs and every data plane live in your VNet: Key Vault, Postgres,
Redis and the registry are private endpoints, and the Container Apps
environment is internal. Deploy it with the example GitHub Actions workflows
([examples/github-actions/](../examples/github-actions/README.md)); the steps
below are what they run, and work by hand too.

### Choose the entry point

- **(b) Azure Front Door Premium over Private Link (recommended).** Front Door
  reaches the internal environment through a private endpoint in Microsoft's
  network, so the only public surface is Front Door and its WAF (with
  Microsoft's managed rule sets, logging by default:
  `frontDoorWafManagedRuleAction = 'Block'` once the logs are clean). No DNS
  zone of your own, no inbound rule, no proxy to run. Front Door Premium has a
  base fee of about USD 330 a month, billed hourly.
- **(a) Your own WAF or application gateway** in front of the internal app,
  when your organisation already runs one. You also create the environment's
  private DNS zone (below).

Front Door Standard cannot reach an internal environment; the template refuses
that combination before deploying anything.

### Additional prerequisites

- **Outbound traffic.** The app and its worker jobs call Entra ID, Azure
  Monitor, the provider APIs and (with Front Door Premium) the Front Door
  endpoint; the build subnet reaches GitHub and base-image registries. Azure is
  retiring default outbound access for new subnets, so give the Container Apps
  and build subnets a NAT gateway (`natGatewayId`) or a route through your
  firewall (`subnetRouteTableId`). A landing-zone NSG goes in
  `subnetNetworkSecurityGroupId`. Set these in the parameter file rather than
  on the subnets: the template lists the VNet's subnets and their attachments,
  so the next apply clears anything attached by hand.
- **Address space** from your IPAM, at least a /24: a Container Apps subnet
  (/27), a private-endpoint subnet (/28), and a build subnet (`buildSubnetPrefix`,
  e.g. /27) if you build images inside the VNet. The example uses `10.0.0.0/24`.
  Declare every subnet in the parameter file: the template lists the VNet's
  subnets, so the next apply removes one added by hand.
- **A way to build images inside the network.** The registry accepts no public
  traffic, so `az acr build` cannot push to it. Either a self-hosted runner (a
  VM in `snet-build`, at least 8 GB of RAM) or an ACR Tasks agent pool in
  `snet-build` (preview, not offered in every region). The build subnet needs
  outbound internet: Azure is retiring default outbound access for new
  subnets, so plan a NAT gateway or a firewall route.
  [examples/github-actions/README.md](../examples/github-actions/README.md#building-for-a-private-registry-vnet)
  has both.
- **DNS.** The template creates and links the privatelink zones for Key Vault,
  Postgres, Redis and the registry and registers every record. If a central
  team owns private DNS in a hub subscription, use the commented "central DNS"
  variant in the parameter file and give that team the record list.

### Steps (Front Door Premium)

1. **Copy and edit the parameters.**

   ```bash
   cp infra/parameters/example-vnetted.bicepparam infra/parameters/staging.bicepparam
   ```

   Commit it if you deploy with the workflows (names starting `my` are
   gitignored). Fill in `env`, `location`, a unique `projectName`, the subnet
   prefixes and `buildSubnetPrefix`, `entraIdTenantId`, `entraIdClientId` and
   `bootstrapAdminEmail`. Leave `appPublicOrigin`, `entraIdRedirectUri`,
   `workerBaseUrl` and `enableFrontDoor` as they are for now. Generate a
   secrets file for this environment and set `SECRETS` to it.

2. **First apply.** The VNet, private endpoints, zones and data planes are
   created; the Container App fails with `MANIFEST_UNKNOWN`, as in the
   sandbox, because the registry is empty.

3. **Build and push the image from inside the VNet**, with the deploy
   workflow (`docker` on your runner, or `acr-agent-pool`) or by hand:

   ```bash
   # The registry the Container App from step 2 pulls from (it exists, failing):
   APP=$(az containerapp list -g "$RG" --query "[0].name" -o tsv)
   ACR=$(az containerapp show -g "$RG" -n "$APP" --query "properties.configuration.registries[0].server" -o tsv)
   ACR=${ACR%%.*}
   # agent pool (created once; see examples/github-actions/README.md)
   az acr build --registry "$ACR" --agent-pool tokenscope-builds \
     --image tokenscope:latest --build-arg GIT_COMMIT_SHA="$(git rev-parse HEAD)" --file Dockerfile .
   ```

   The deploy workflow also rolls the app, so the Container App from step 2
   comes up without another apply. By hand, apply again instead.

4. **Turn on Front Door.** Set `enableFrontDoor = true` and
   `frontDoorSku = 'Premium'`, and apply. The approval script in the apply
   command approves Front Door's Private Link request while the apply runs.
   Note the `frontDoorEndpointFqdn` and `frontDoorInstanceId` outputs. A new
   Premium endpoint can keep answering Front Door's own 404 for a while after
   the apply; the script waits for it to serve the app and re-approves the
   connection meanwhile, which has cleared it in testing.

5. **Move everything to the Front Door host.** Set
   `frontDoorId = '<frontDoorInstanceId>'`, and `appPublicOrigin`,
   `entraIdRedirectUri` and `workerBaseUrl` on `https://<frontDoorEndpointFqdn>`
   (the worker jobs reach it through the environment's outbound access). Add
   the two redirect URIs to the app registration
   (`/auth/entra/callback` and `/login` on that host). Apply. From now on the
   app refuses any request that did not come through this Front Door (except
   `/api/health`).

6. **Check it.** `https://<frontDoorEndpointFqdn>/api/health` returns 200 and
   `/api/v1/meta/build` reports your commit; the bootstrap email signs in as
   platform-admin. The deploy workflow checks each deploy through the app's
   public origin (`appPublicOrigin`), so it verifies Front Door end to end.

7. **Tune the WAF, then block.** Premium's managed rule sets start in Log
   mode. Front Door's WAF log goes to the deployment's Log Analytics
   workspace; review what the managed rules would have blocked:

   ```bash
   WS=$(az monitor log-analytics workspace list -g "$RG" --query "[0].customerId" -o tsv)
   az monitor log-analytics query -w "$WS" -o table --analytics-query \
     "AzureDiagnostics | where Category == 'FrontDoorWebApplicationFirewallLog'
      | where TimeGenerated > ago(7d) and action_s == 'Log'
      | summarize hits=count() by ruleName_s, requestUri_s | order by hits desc"
   ```

   When the matches are all attacks rather than your developers' traffic, set
   `frontDoorWafManagedRuleAction = 'Block'` and apply. Block is the intended
   production end state.

**Custom domains** are not part of the template. If you add one to Front Door
(`az afd custom-domain create`), also add it to the WAF security policy
(`az afd security-policy update`), and repeat that after every apply: the
template declares the policy with the default endpoint only, so an apply drops
the custom domain's WAF coverage.

### Steps (your own WAF)

As above, with these differences: leave `enableFrontDoor = false`; set
`appPublicOrigin` and `entraIdRedirectUri` to your public hostname in step 1
and register the redirect URIs then; and replace steps 4 and 5 with:

- **Create the Container Apps environment's DNS zone** so your proxy (and the
  worker jobs) can resolve the internal app:

  ```bash
  ENV_NAME=$(az containerapp env list -g "$RG" --query "[0].name" -o tsv)
  DOMAIN=$(az containerapp env show -g "$RG" -n "$ENV_NAME" --query properties.defaultDomain -o tsv)
  IP=$(az containerapp env show -g "$RG" -n "$ENV_NAME" --query properties.staticIp -o tsv)
  VNET=$(az network vnet list -g "$RG" --query "[0].id" -o tsv)
  az network private-dns zone create -g "$RG" -n "$DOMAIN"
  az network private-dns record-set a add-record -g "$RG" -z "$DOMAIN" -n '*' -a "$IP"
  az network private-dns record-set a add-record -g "$RG" -z "$DOMAIN" -n '@' -a "$IP"
  az network private-dns link vnet create -g "$RG" -z "$DOMAIN" -n app-vnet \
    -v "$VNET" -e false
  ```

  Link it to your proxy's network too.
- **Point your proxy at the app** (`https://<containerAppUrl>`, sending that
  FQDN as the backend host header), set
  `workerBaseUrl = 'https://<containerAppUrl>'` (the internal address: the jobs
  run inside the environment and usually cannot reach your proxy), and apply.

**Private Log Analytics query** (`monitorQueryPrivateOnly`, off in the example)
routes the app's telemetry reads through an Azure Monitor Private Link Scope.
Before turning it on, create the `privatelink.monitor.azure.com`,
`privatelink.oms.opinsights.azure.com`, `privatelink.ods.opinsights.azure.com`
and `privatelink.blob.core.windows.net` zones with the AMPLS endpoint's
records. Turning it on without them cuts the app off from its own telemetry.
By default it also moves the platform's own logs (console, system, diagnostic
settings) to a second workspace, `log-ops-<name>`, which stays queryable from
the portal (`separateOpsWorkspace`). The OTel telemetry stays private.
On an existing deployment the security audit-write alert is recreated as
`alert-security-audit-write-ops-<name>`, because Azure cannot move a log alert
to another workspace; delete the old `alert-security-audit-write-<name>`, which
no longer receives logs.

### Check that telemetry arrives

Once a developer has enrolled (next section) and run one Claude Code turn, the
rows appear in Log Analytics within a few minutes, and in the app after the next
`azure-monitor-read` run (every 5 minutes):

```bash
WS=$(az monitor log-analytics workspace list -g "$RG" --query "[0].customerId" -o tsv)
az monitor log-analytics query -w "$WS" -o table --analytics-query \
  "OTelLogs | where TimeGenerated > ago(1h)
   | project TimeGenerated, event=tostring(Attributes['event.name']),
             instance=tostring(ResourceAttributes['tokenscope.instance_id'])"
```

`az containerapp job execution list -g "$RG" -n caj-ts-azure-monitor-read`
shows the join job's runs.

## 5. After the first sign-in

- **Workers.** `workerBaseUrl` creates the scheduled jobs (Container Apps
  Jobs). They join telemetry every 5 minutes and roll up dashboards every 15.
  An empty value means dashboards stay at $0.
- **People.** New sign-ins are created as `developer`, unplaced, in the
  alphabetically first region. Place them into Business Units under **Admin**.
- **Developers.** Onboard Claude Code or Copilot CLI through the plugin: see
  [PROVIDERS.md](PROVIDERS.md). Telemetry goes from each device straight to the
  deployment's OTLP ingest endpoint; no collector runs anywhere.
- **Providers and settings:** [CONFIGURATION.md](CONFIGURATION.md).

### Deploying with GitHub Actions

Two example workflows automate this guide: infra (`what-if` and apply) and
deploy (build, roll, health check, roll back). Copy them from
[`examples/github-actions/`](../examples/github-actions/README.md) into your
fork; that README covers the federated deployment identity, the GitHub
environment and the order to run them in.

## 6. Shipping a new version

The deploy workflow does this for you. By hand: build under a unique tag, roll
the app to it, check it, and only then move `latest` (the worker jobs, and every
re-apply, use `tokenscope:latest`, so it should only ever point at a build that
works).

```bash
TAG=$(git rev-parse --short HEAD)
APP=$(az containerapp list -g "$RG" --query "[0].name" -o tsv)   # one TokenScope app per group
# The registry the app pulls from (a group can also hold an older registry):
ACR=$(az containerapp show -g "$RG" -n "$APP" --query "properties.configuration.registries[0].server" -o tsv)
ACR=${ACR%%.*}

# Sandbox: build in Azure
az acr build --registry "$ACR" --image "tokenscope:$TAG" \
  --build-arg GIT_COMMIT_SHA="$(git rev-parse HEAD)" --file Dockerfile .
# VNet: build inside the network instead (runner or agent pool; see the examples README)

az containerapp update -g "$RG" -n "$APP" --image "$ACR.azurecr.io/tokenscope:$TAG"

# Check https://<public-host>/api/v1/meta/build reports $TAG, then:
az acr import --name "$ACR" --source "$ACR.azurecr.io/tokenscope:$TAG" \
  --image tokenscope:latest --force
```

On boot the container migrates the database and applies its idempotent seeds.
Re-run the apply command only when parameters or infrastructure change.

## Troubleshooting

| Symptom | Cause |
|---|---|
| Container App `Failed` with `MANIFEST_UNKNOWN` | No image in the registry yet. Build it, then apply again. |
| The apply that creates the worker jobs fails on one job: `Secret "caj-ts-<job>--msi" not found` | A known Azure-side failure when that job is created, root cause not yet understood: the other jobs, on the same identity, are created, and the app is unaffected. Applying again has failed on the same job, so that one worker does not run until this is resolved. |
| Revision fails pulling the image (401) or resolving secrets (403) | `deployRbac` is false, or the deploying identity cannot create role assignments. |
| Key Vault name conflict on a redeploy | A soft-deleted vault with that name exists. Set `keyVaultCreateMode = 'recover'`, or change `projectName`. |
| Sign-in redirects back to the login page, or signs out on every deploy | The `OIDC_*` secrets changed between applies, or `OIDC_TOKEN_KEY` is not base64 of 32 bytes. |
| Apply stops with `Environment variable "…" does not exist` | The secrets file was not loaded into this shell, or lacks that variable. |
| Developer enrolment fails with an error asking for `APP_PUBLIC_ORIGIN` | `appPublicOrigin` is empty on a deployment without Front Door. |
| Sign-in error about the redirect URI | The URI in `entraIdRedirectUri` is not registered on the app registration, or the `/login` one is missing. |
| People picker / manager lookups fail | `User.Read.All` (Application) is missing or not admin-consented. |
| Dashboards stay at $0 while developers are enrolled | `workerBaseUrl` is empty, or points at a host the jobs cannot reach. |
| VNet with your own WAF: the app FQDN does not resolve | The Container Apps environment's DNS zone is missing or not linked to the querying network. |
| Front Door Premium apply sits on the origin for many minutes | Its Private Link request is waiting for approval; run the apply with the approval script (§2). |
| Front Door endpoint answers its own `404` "Page not found" after a successful apply | Front Door is not routing to the Private Link origin yet. The approval script waits 30 minutes for it, re-approving the connection meanwhile, then exits 4; run the apply again (the example infra workflow retries it twice). |
| Apply fails with `InternalError` and "Sorry, it looks like there was an error on our end" | An Azure platform fault. The approval script exits 4; apply again. The example infra workflow retries it twice. |
| Apply fails with `ServerIsBusy` on a Postgres setting | Two writes reached the server at once. Current templates write them one at a time; apply again. |
| A self-hosted build runner goes offline mid-build | It ran out of memory; the build needs at least 8 GB of RAM. |
| Apply fails before creating anything: "Front Door Standard cannot reach a VNet" | Standard cannot reach an internal environment: set `frontDoorSku = 'Premium'`, or use your own WAF. |
