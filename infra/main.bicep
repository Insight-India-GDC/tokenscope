// ── TokenScope — Root Bicep Template ──────────────────────────────────
//
// Deploys all Azure resources for TokenScope. Walkthrough: docs/DEPLOY-AZURE.md.
// Usage (the example parameter files read every secret from environment
// variables, so export those first):
//   az deployment group create \
//     -g <resource-group> \
//     -f infra/main.bicep \
//     -p infra/parameters/example-sandbox.bicepparam   # or example-vnetted.bicepparam
// A copy-in GitHub Actions workflow that compiles, runs what-if and applies is
// in examples/github-actions/tokenscope-infra.yml.
//
// Deployment graph documented at the bottom of this file.
//
// ── Front Door ────────────────────────────────────────────────────────
// `enableFrontDoor` provisions Azure Front Door + WAF; `frontDoorSku` picks
// the tier:
//   - Standard fronts the app's PUBLIC ingress (the sandbox posture).
//   - Premium reaches the internal (VNet) environment over Private Link. It
//     is required with `enablePrivateNetworking`: Standard + VNet is refused
//     by a fail() before anything is created. Front Door's private endpoint
//     request must be approved WHILE the apply runs — start the apply with
//     `--no-wait`, then run infra/scripts/approve-front-door-private-link.sh <rg>.
//
// Enforcement: Front Door sends its instance id in `X-Azure-FDID`. After an
// apply with Front Door on, read the `frontDoorInstanceId` output and re-apply
// with `frontDoorId=<that value>`; the container app gets AZURE_FRONT_DOOR_ID
// and its require-front-door middleware then rejects requests without the
// matching header. `frontDoorId=''` (the default) means not enforced.

targetScope = 'resourceGroup'

// ── Parameters ────────────────────────────────────────────────────

@description('Environment name. Drives every SKU / capacity / retention choice across the modules. Only `production` gets the production SKUs; `sandbox` is the only deployed env that may enable persona override. See infra/parameters/example-*.bicepparam.')
@allowed(['sandbox', 'dev', 'demo', 'staging', 'production'])
param env string

@description('Environment label used only in resource names (e.g. `uat` while env = `staging`). Empty = use env.')
param envNameLabel string = ''

@description('Azure region for all resources. Defaults to the resource-group region.')
param location string = resourceGroup().location

@description('Project name used in resource naming. Leave as `tokenscope` unless you are forking.')
param projectName string = 'tokenscope'

@description('Container image tag to deploy. Override at apply time; defaults to `latest` for first apply.')
param imageTag string = 'latest'

@description('Git commit SHA at deploy time. Empty = use the build-time baked value (Dockerfile ARG GIT_COMMIT_SHA). Non-empty values override the Dockerfile bake at runtime and are surfaced via /admin/settings → build.commitSha so operators can verify the running revision.')
param gitCommitSha string = ''

@description('Prefix of the scheduled worker jobs\' names (<prefix>-<worker>, at most 8 characters). Keep the default unless two deployments share a resource group: job names are per resource group, and a deleted job\'s name stays unavailable for a while.')
@minLength(1)
@maxLength(8)
param workerJobPrefix string = 'caj-ts'

@description('Anthropic analytics API base URL (NUXT_ANTHROPIC_API_ENDPOINT). Empty = reconciliation/poller no-op. Set to https://api.anthropic.com on envs with a reconciled Anthropic org.')
param anthropicApiEndpoint string = ''

// ── Database (secrets) ───────────────────────────────────────────────

@description('PostgreSQL administrator login. URL-encoded inside keyvault-secrets when building database-url.')
@secure()
param pgAdminLogin string

@description('PostgreSQL administrator password.')
@secure()
param pgAdminPassword string

// ── RLS enforcement: the non-owner app role ──
// The 40 RLS policies do not execute today because the app connects as the table
// OWNER. Enforcement needs a non-owner login, which drizzle/provision-app-role.ts
// creates at boot using the credentials below.
//
// FIVE FLAGS, ALL DEFAULT FALSE — an apply that names none of them changes
// nothing. They are separate because they fail differently and their ORDER is
// the safety property. The intended sequence, one apply each:
//
//   1. writeAppDbPassword=true, hasAppRoleSecrets=true, provisionAppRole=true
//      → generates the password, writes app-db-password + database-url-app, and
//        the next boot CREATES THE ROLE. It does NOT touch row-level security:
//        creating a role and cutting the estate over are two decisions. The app
//        still connects as the OWNER; read the boot log for the
//        "[provision-app-role] verified" line before going on.
//   2. writeAppDbPassword BACK TO FALSE, add runRlsCutoverSweep=true → the next boot runs the ONE-TIME cutover
//        sweep: DISABLE row-level security on every RLS-enabled table that is
//        not already FORCEd (a non-owner is bound by ENABLE alone, so anything
//        left enabled filters the app the instant step 3 lands). It NEVER
//        disables a FORCEd table — that is how a rollout phase says "hands off"
//        — and it REFUSES, changing nothing, if a bootstrap table is FORCEd.
//        Stamped in seed_state, so it does not re-run and the flag is safe to
//        leave on. Read the boot log for "[cutover-rls-sweep] verified".
//
//        THE WRITE FLAG MUST GO OFF HERE. `appDbPasswordSeed` defaults to `newGuid()`, which yields a
//        NEW value on every deployment, so a second dispatch with the flag
//        still true rewrites app-db-password and database-url-app with a
//        password the ROLE DOES NOT HAVE — provisioning sets a password only
//        when it CREATEs the role, and moving an existing one needs
//        rotateAppDbPassword. Step 3 would then bind a credential that cannot
//        authenticate, and the boot aborts.
//   3. keep the others, add useAppRoleAtRuntime=true → THE CUTOVER. The runtime
//      pools connect as the role and the policies start executing.
//   4. Rollback, if anything looks wrong: useAppRoleAtRuntime=false, re-apply.
//      One variable, no code change, no migration to reverse. It does NOT
//      re-enable the swept tables; that is a deliberate step of its own.
//
// AND A SIXTH FLAG THAT IS NOT PART OF THAT SEQUENCE: rotateAppDbPassword. The
// boot step sets the role's password ONCE, when it CREATEs it, and a later boot
// never touches it UNLESS this flag is on — which is why provisionAppRole is
// safe to leave on. Rolling the credential is deliberate: writeAppDbPassword=true
// to mint a new one, then ONE boot with rotateAppDbPassword=true, then both back
// to false.
//
// WHY writeAppDbPassword IS ITS OWN FLAG: newGuid() yields a NEW value on every
// deployment. Writing it unconditionally would rotate the password on every
// unrelated apply, and a rotation under a live app leaves draining replicas
// holding a password the role no longer has. So the write is deliberate, and an
// ordinary apply passes '' — which keyvault-secrets.bicep treats as a NO-OP that
// leaves the stored value alone (its SAFETY CONTRACT).
@description('Generate a NEW app-role password and (re)write the app-db-password + database-url-app Key Vault secrets. This is also how they are created the first time. Leave false on ordinary applies: true mints a new credential, and an EXISTING role only picks it up on a boot with rotateAppDbPassword=true — provisionAppRole alone will not move an existing role password. A role being CREATED for the first time is set to whatever password this apply wrote, which is the intended first-run path and needs no rotation flag.')
param writeAppDbPassword bool = false

@description('Machine-generated app-role password. NEVER pass this explicitly and never read it — newGuid() makes the deployment generate it, Key Vault stores it, the container consumes it, and no human or log ever sees it. Used only when writeAppDbPassword is true.')
@secure()
param appDbPasswordSeed string = newGuid()

@description('The app-db-password + database-url-app KV secrets exist, so the container app may reference them and the boot step gets TOKENSCOPE_APP_DB_PASSWORD. Set true on the same apply that first sets writeAppDbPassword, and keep it true.')
param hasAppRoleSecrets bool = false

@description('Let the boot step CREATE the non-owner role, grant it and set its ALTER DEFAULT PRIVILEGES. It does NOT change row-level security — that is runRlsCutoverSweep, deliberately separate. Requires hasAppRoleSecrets. Safe to keep true afterwards: a boot that finds the role already there converges its attributes and grants and never touches its password unless rotateAppDbPassword is also on.')
param provisionAppRole bool = false

@description('Run the ONE-TIME cutover sweep: DISABLE row-level security on every RLS-enabled table that is not already FORCEd, so no unvetted table binds the app when useAppRoleAtRuntime lands (a non-owner is bound by ENABLE alone). It NEVER disables a FORCEd table — that is a rollout phase deliberately enabling one — and it REFUSES, changing nothing, if a BOOTSTRAP table is FORCEd, because §5 and §7 disagree about that table and no boot script may pick a winner. Stamped in seed_state, so it does not re-run and this is safe to leave true; re-sweeping means bumping RLS_CUTOVER_SWEEP_VERSION. Needs no Key Vault secret and no app role — it runs on the OWNER connection — but it does need DATABASE_URL and a migrated schema it recognises, and it is pointless before the role exists.')
param runRlsCutoverSweep bool = false

@description('ROLL THE APP ROLE PASSWORD — the ONLY path that changes an EXISTING role password to the app-db-password secret. On for ONE deliberate boot after an apply with writeAppDbPassword=true, then back off: left on, every replica restart is a rotation, and a rotation under a live app invalidates the old password for any NEW connection — an established session keeps working, so the symptom is a replica that serves fine until its pool next opens a connection, which is worse to diagnose than an outright failure. Requires provisionAppRole + hasAppRoleSecrets.')
param rotateAppDbPassword bool = false

@description('THE CUTOVER: point the runtime pools at the non-owner role, so the RLS policies begin to execute. TAKES EFFECT ONLY WITH hasAppRoleSecrets — this parameter is AND-ed with it below, because the runtime url is a Key Vault reference and ACA fails a deploy that references a missing secret; on its own this flag changes nothing at all. Requires a role that already exists (do a provisionAppRole apply first and read its boot log) AND an estate the sweep has already prepared. That second precondition is ENFORCED for every DEPLOYED start rather than documented: once the runtime url is actually emitted, entrypoint.sh runs drizzle/assert-runtime-rls-safe.ts before Nitro and REFUSES TO START if any bootstrap table is still RLS-ENABLED or any enabled table is un-FORCEd, because a non-owner is bound by ENABLE alone and booting anyway stops the emit fleet behind a green deploy. The check is one snapshot taken before the server binds, not a lifetime guarantee. A refusal fails the revision and leaves the previous one serving. Turning this back off is the rollback.')
param useAppRoleAtRuntime bool = false

// ── Entra OIDC ────────────────────────────────────────────────────────

@description('Entra ID tenant ID for nuxt-oidc-auth. Empty = OIDC not configured (sandbox-bring-up before app reg).')
param entraIdTenantId string = ''

@description('Entra ID client ID for nuxt-oidc-auth.')
param entraIdClientId string = ''

@description('Entra ID client secret. Empty = no entra-client-secret KV secret written. Setting it later requires explicit value (SAFETY CONTRACT).')
@secure()
param entraIdClientSecret string = ''

@description('Entra ID redirect URI for nuxt-oidc-auth (the public callback URL, e.g. https://<ca-fqdn>/auth/entra/callback). Empty during first bring-up (before the app registration exists); operator passes the value at apply time once the FQDN is known.')
param entraIdRedirectUri string = ''

@description('Optional pinned PUBLIC origin (scheme://host) when an upstream WAF/proxy fronts the app under a fixed hostname (for example your own WAF or application gateway). Empty = derive from Front Door / the request Host. See server/utils/public-url.ts.')
param appPublicOrigin string = ''

@description('Break-glass EXTRA hostnames the MCP transport answers to, comma-separated. The app already derives its public origin and its Container Apps app/revision FQDNs; this covers a topology that derivation does not model (custom backend domain, private DNS alias, traffic-label FQDN) WITHOUT a code change and release. Empty is the normal state. See server/utils/public-url.ts platformSelfHosts().')
param mcpAllowedHosts string = ''

// ── Persona-impersonation gate ──────────────────────────────
// SAFETY FLOOR: defaulted to `false`. The triple-gate in
// server/api/v1/auth/dev-login.post.ts refuses unless one of:
//   a) NUXT_OIDC_AUTH_DEV_MODE=true (local dev fallback), OR
//   b) NUXT_ALLOW_PERSONA_OVERRIDE=true AND caller has a valid Entra
//      session AND session.role in ('admin', 'platform-admin').
// Production hard-locks this to false; sandbox flips it true so admins
// can step through the demo personas without re-seeding the DB.
@description('Allow admin / platform-admin users to override their session into a demo persona (dev-login route). MUST be false in production. Sandbox = true; staging starts false (flip only when audit pattern is stakeholder-accepted).')
param allowPersonaOverride bool = false

@description('Bootstrap admin email — the first Entra sign-in matching this address gets the `platform-admin` role on JIT teammate creation. Empty = no bootstrap (all JIT-created teammates default to `developer`).')
param bootstrapAdminEmail string = ''

// ── External-API + app secrets ───────────────────────────────────────

@description('Anthropic admin key VALUE for the analytics poller. Optional: when set, CREATES the anthropic-admin-api-key KV secret. Leave empty when the secret is placed in KV out-of-band (dev) and reference it via hasAnthropicKey.')
@secure()
param anthropicApiKey string = ''

@description('Whether the anthropic-admin-api-key KV secret exists (read by the app as NUXT_ANTHROPIC_KEY_MAIN). Set true when the secret was placed in Key Vault out-of-band; a non-empty anthropicApiKey implies it.')
param hasAnthropicKey bool = false

@description('log_min_duration_statement (ms) forwarded to the PG module — the per-environment slow-statement threshold.')
param slowStatementLogMs string = '1000'

@description('Postgres max_connections, forwarded to the PG module. 0 (default) = unmanaged: an unmeasured environment keeps the server\'s own value. STATIC — a change takes effect only after a Postgres restart. Size it against maxReplicas × (request pool + worker pool + dispatch-lock pool) + 15 reserved (tests/unit/infra/postgres-connection-budget.test.ts checks every parameter file that sets it).')
@minValue(0)
@maxValue(5000)
param postgresMaxConnections int = 0

// ── GitHub Copilot reconciliation PATs (F2 — GATED OFF; TEMPLATE) ──
// Empty (the default) = NO-OP: no KV secret written, no container-app KV ref/env
// var emitted, F2 stays gated off (no reconciled provider_enterprise → no lookup).
// Supply the value at apply time (a redeploy) when onboarding that enterprise.
@description('GitHub manage_billing PAT for the NFR/internal enterprise (credential_secret_name "partner-demo"). Empty = NO-OP.')
@secure()
param githubPatPartnerDemo string = ''

@description('GitHub manage_billing PAT for the production client enterprise (TEMPLATE — rename to the real credential_secret_name). Empty = NO-OP.')
@secure()
param githubPatProduction string = ''

@description('GitHub manage_billing PAT for the APAC NFR/internal enterprise (credential_secret_name "enterprise-nfr", read as NUXT_GITHUB_PAT_ENTERPRISE_NFR). Supply as a GitHub Actions secret at apply time — the deploy CREATES the github-pat-enterprise-nfr KV secret from this value and the container app references it (hasGithubPatApacNfr derives from non-empty). Empty = NO-OP.')
@secure()
param githubPatApacNfr string = ''

// ── GitHub App private key (App-credential path — OPT-IN; create-from-value) ──
// The App-mode replacement for a PAT.
// CRITICAL: the value is the App private key (multi-line PEM) BASE64-ENCODED — raw
// newlines don't survive the GH-secret → bicep → KV → container-env pipeline. Supplied
// at apply time (e.g. from a CI secret such as GH_APP_KEY_PARTNER_DEMO). Empty = NO-OP.
@description('GitHub App private key (BASE64-encoded PEM) for the partner-demo enterprise App-credential path (credential_secret_name "partner-demo", read as NUXT_GITHUB_APP_KEY_PARTNER_DEMO). Pair with provider_enterprise.github_app_id via onboarding. Empty = NO-OP.')
@secure()
param githubAppKeyPartnerDemo string = ''

// ── Ops alerting channel ─────────────────────────────────────────────
// GitHub env secret OPS_ALERT_NTFY_URL → this param → KV secret
// ops-alert-ntfy-url → container secretRef → NUXT_OPS_ALERT_NTFY_URL.
// The topic URL IS the credential (public ntfy.sh; the 64-char CSPRNG topic
// name is the access control — ar-H8 accepted residual), so it is secretRef-
// only downstream (ar-M20). Empty = NO-OP write (safety contract) AND no
// container ref/env = alerting disabled (the sandbox/local default).
@description('ntfy topic URL for operator push alerts (NUXT_OPS_ALERT_NTFY_URL). Supplied at apply time (e.g. from a CI secret OPS_ALERT_NTFY_URL). Empty = NO-OP: no KV write, no container ref, alerting disabled.')
@secure()
param opsAlertNtfyUrl string = ''

@description('Nuxt session signing secret (NUXT_SESSION_SECRET). REQUIRED for the app to boot.')
@secure()
param sessionSecret string

@description('Nuxt HMAC session key (NUXT_HMAC_SESSION_KEY). REQUIRED for the app to boot.')
@secure()
param hmacSessionKey string

@description('Internal worker HMAC key (NUXT_INTERNAL_WORKER_HMAC_KEY). REQUIRED for cross-service auth.')
@secure()
param internalWorkerHmacKey string

// ── nuxt-oidc-auth module encryption secrets ──────────────────────
// These three keys MUST be stable across revisions. The module
// generates random per-boot values if absent, which invalidates every
// OIDC session on every container deploy AND breaks the SSR-side
// cookie decryption in /api/v1/auth/me.

@description('nuxt-oidc-auth user-session encryption secret (NUXT_OIDC_SESSION_SECRET). Empty = module generates random per boot (bad for stability; sessions break on every roll).')
@secure()
param oidcSessionSecret string = ''

@description('nuxt-oidc-auth auth-flow session encryption secret (NUXT_OIDC_AUTH_SESSION_SECRET).')
@secure()
param oidcAuthSessionSecret string = ''

@description('nuxt-oidc-auth refresh-token AES key (NUXT_OIDC_TOKEN_KEY), base64-encoded 32 bytes.')
@secure()
param oidcTokenKey string = ''

// ── Private Networking ──────────────────────────────────────────────

@description('Enable VNet + private endpoints (Key Vault, Postgres, Redis, ACR) and internal ingress. False for the sandbox posture (example-sandbox.bicepparam); true for staging / production (example-vnetted.bicepparam).')
param enablePrivateNetworking bool = false

@description('Make the Log Analytics QUERY path private: publicNetworkAccessForQuery=Disabled, queryable only over an Azure Monitor Private Link Scope. Ingestion stays public. Requires enablePrivateNetworking. Default false — the back-out lever. Flipping this on before the AMPLS privatelink DNS resolves locks query out, the app included, so arrange the DNS first. Who owns the scope is useCentralAmpls.')
param monitorQueryPrivateOnly bool = false

@description('Consume a central Azure Monitor Private Link Scope (owned by whoever owns the central private DNS zones) instead of deploying our own. DEFAULTS from centralDnsZonesSubscriptionId, because the two are the same constraint: one shared privatelink zone holds ONE set of Monitor A records, so a scope of our own overwrites the central one and blackholes whoever it displaced. An env on central zones therefore consumes the central scope unless someone opts out ON PURPOSE. The scope owner joins our workspace to their scope as a scoped resource.')
param useCentralAmpls bool = !empty(centralDnsZonesSubscriptionId)

@description('Send the platform\'s own logs (Container Apps console/system logs, diagnostic settings, log alert rules) to a separate ops workspace whose query path is public and governed by Entra RBAC. DEFAULTS on exactly when query is private (enablePrivateNetworking && monitorQueryPrivateOnly, the same predicate monitoring.bicep applies): query privacy is workspace-wide, so a private-query env without it leaves its crash logs readable only by the app.')
param separateOpsWorkspace bool = enablePrivateNetworking && monitorQueryPrivateOnly

@description('App container vCPU, e.g. \'1.0\'. Unset = 1.0 in production, 0.5 otherwise. Pair with appMemory per the Consumption ratio (0.5 → 1Gi, 1.0 → 2Gi).')
param appCpu string?

@description('App container memory, e.g. 2Gi. Unset = 2Gi in production, 1Gi otherwise. Node\'s default heap limit is about half of it. Set appCpu with it.')
param appMemory string?

@description('Resource ID of the central AMPLS to point our own private endpoint at. Read only when useCentralAmpls, and needed only if the central PE is unreachable from our VNet. Empty (default) = we deploy no AMPLS PE at all. Requires amplsSubnetPrefix, and no same-named PE already pointing at another scope (privateLinkServiceId is immutable).')
param centralAmplsResourceId string = ''

@description('VNet resource name override. Empty = `vnet-{nameSuffix}` convention. Set it when your network team issues the VNet name, e.g. because hub peerings and central-DNS VNet links are scripted against it.')
param vnetName string = ''

@description('Subscription ID of central private DNS zones you do not own (privatelink.* + the ACA-env zone). Empty = self-owned zones. Set together with centralDnsZonesResourceGroup.')
param centralDnsZonesSubscriptionId string = ''

@description('Resource group of the central private DNS zones. Empty = self-owned zones. Set together with centralDnsZonesSubscriptionId.')
param centralDnsZonesResourceGroup string = ''

@description('Write DNS on our side: attach privateDnsZoneGroups to the PEs. Set FALSE when the deploying SP has no write rights on the (central) zones (e.g. the SP is Owner on its own resource group only) — PEs still provision, and the zone owner creates the records. True (default) for self-owned-zone environments. NOTE: this template never writes the Container Apps environment\'s private DNS zone; its records are always created outside the template.')
param registerDnsZoneGroups bool = true

@description('VNet address space CIDR. Default 10.0.0.0/16. Override with the range your network team assigns when the VNet peers into a corporate network.')
param vnetAddressSpace string = '10.0.0.0/16'

@description('Container Apps subnet CIDR. Minimum /27 for our workload-profiles env (/23 is the legacy Consumption-only minimum). Default /23 is generous headroom; a tight IPAM allocation can use /27. Override alongside vnetAddressSpace.')
param containerAppsSubnetPrefix string = '10.0.0.0/23'

@description('Private-endpoint subnet CIDR. Default /24 is roomy; dev uses /28 (11 usable) for 4 PEs — KV/PG/Redis + ACR when ACR is private — plus headroom. (/29 only holds 3, pre-ACR-private.)')
param privateEndpointsSubnetPrefix string = '10.0.2.0/24'

@description('Optional dedicated subnet CIDR for the AMPLS private endpoint (the `azuremonitor` PE is multi-IP and overflows the shared PE subnet). Empty = no AMPLS subnet/PE. Set where monitorQueryPrivateOnly is on (e.g. a /28 inside your VNet range).')
param amplsSubnetPrefix string = ''

@description('Optional subnet CIDR for image builds inside the VNet: a self-hosted CI runner or an ACR Tasks agent pool (a private registry refuses builds from outside). Empty = none. Requires enablePrivateNetworking.')
param buildSubnetPrefix string = ''

@description('Optional network security group resource id attached to every subnet the template creates. Landing zones often require one; attach it here, since the template lists its subnets and would clear one attached by hand.')
param subnetNetworkSecurityGroupId string = ''

@description('Optional route table resource id (e.g. forced tunnelling to a hub firewall) attached to the Container Apps and build subnets.')
param subnetRouteTableId string = ''

@description('Optional NAT gateway resource id for outbound traffic from the Container Apps and build subnets. Azure is retiring default outbound access for new subnets; provide this or a route through a firewall.')
param natGatewayId string = ''

@description('Optional hub VNet resource ID for spoke-to-hub peering. Empty = no peering (default). Set when a hub network you do not own requires peering for on-prem connectivity.')
param hubVnetId string = ''

@description('Use the hub VNet\'s gateway for on-prem connectivity. Default false; set true ONLY when the hub owner confirms the hub has a gateway and has set allowGatewayTransit=true on the reverse peering.')
param useRemoteGateways bool = false

// ── Key Vault Recovery ──────────────────────────────────────────────

@description('Set `recover` to restore a soft-deleted Key Vault with the same name (e.g. on a teardown-then-redeploy in sandbox within the soft-delete window).')
@allowed(['default', 'recover'])
param keyVaultCreateMode string = 'default'

// ── Monitoring ──────────────────────────────────────────────────────

@description('Optional notification email for the Azure Monitor alert action group. Empty = alerts still fire (visible in Monitor) but no email goes out.')
param alertNotificationEmail string = ''

@description('Deploy the Azure Monitor Workspace (preview metrics path; currently consumer-less). Set FALSE where the Microsoft.Monitor resource provider is not registered in the subscription and you cannot register it; the apply would otherwise fail with MissingSubscriptionRegistration.')
param deployAzureMonitorWorkspace bool = true

// ── RBAC two-phase flag ─────────────────────────────────────────────

@description('Deploy RBAC role assignments. Requires Owner / User-Access-Administrator on the deploying principal. The CI/CD service principal needs Owner (or Contributor + User Access Administrator). Set true in `.bicepparam` for normal deploys; false only for a Contributor dry-run.')
// Defaults to false as a safety floor — applying main.bicep WITHOUT a
// bicepparam (e.g. a quick `az deployment group create` test) will skip
// every role assignment. The expected failure mode in that case: the
// container app's first revision can't pull from ACR (401) and can't
// resolve KV-ref secrets (403). Every parameter file in
// infra/parameters/ sets it true; do not bare-apply main.bicep.
param deployRbac bool = false

// ── Front Door ──────────────────────────────────────────────────────
// Tiers, Private Link approval and FDID enforcement: see the file header and
// docs/DEPLOY-AZURE.md.

@description('Provision Azure Front Door + WAF in front of the container app. Defaults false; set it explicitly. With enablePrivateNetworking it requires frontDoorSku Premium.')
param enableFrontDoor bool = false

@description('Front Door tier when enableFrontDoor. Standard fronts the app\'s public ingress. Premium is required with enablePrivateNetworking: it reaches the internal environment over Private Link, and its private endpoint request must be approved after the apply (docs/DEPLOY-AZURE.md). Premium adds the managed WAF rule sets.')
@allowed(['Standard', 'Premium'])
param frontDoorSku string = 'Standard'

@description('Premium only: what the managed WAF rule sets (DRS 2.1, Bot Manager 1.1) do on a match. Log observes; switch to Block once the logs show no false positives on developer traffic.')
@allowed(['Log', 'Block'])
param frontDoorWafManagedRuleAction string = 'Log'

@description('Front Door WAF: requests per client IP per 5 minutes before blocking (all paths). Raise it when many users share one NAT address.')
@minValue(10)
param frontDoorRateLimitPerIpPer5Min int = 100

@description('ISO-3166 alpha-2 country codes allowed through the AFD WAF. Empty array = no geo restriction (global access). Forwarded directly to `front-door.bicep`.')
param wafGeoAllowedCountries array = []

@description('AFD origin response timeout (seconds). Defaults to 240, the maximum Azure allows. With Front Door enforced (frontDoorId set) the scheduled worker jobs call through it, so it must stay at or above the 200 s worker dispatch budget (DISPATCH_TIMEOUT_MS in shared/workers/dispatch-budget.ts): below it, a worker that finishes and records success is still reported as a failed job execution, and its retry 409s. It is not a control on user endpoints, which stay bounded by the replica and their own timeouts.')
@minValue(16)
@maxValue(240)
param afdOriginResponseTimeoutSeconds int = 240

@description('Azure Front Door instance ID. Default empty = not enforced. Set it to the `frontDoorInstanceId` output of an apply with Front Door on; the container-app revision then rejects requests without the matching X-Azure-FDID header.')
param frontDoorId string = ''

@description('Base URL the scheduled worker jobs call. Empty = no worker jobs (nothing joins telemetry or rolls up). With Front Door enforced (frontDoorId set) it must be the Front Door endpoint, because the app rejects direct calls; otherwise the Container App FQDN (https://<containerAppUrl output>), which for internal ingress is the only address the jobs can reach.')
param workerBaseUrl string = ''

// ── Tags ────────────────────────────────────────────────────────────

@description('Tags applied to every resource that accepts the tags property.')
param tags object = {
  project: 'tokenscope'
  environment: env
  costcenter: 'apac-services'
}

// ── Naming Convention ─────────────────────────────────────────────
// Pattern: {kind}-{projectName}-{env}-{regionShort}
// e.g. kv-tokenscope-sandbox-aue (Australia East, sandbox),
//      ca-tokenscope-example   (West US 3, dev).
// ACR is the exception (alphanumeric only) — `cr${nameSuffix}` with
// hyphens stripped, inside container-registry.bicep.
//
// regionShort is DERIVED from `location` so the suffix tracks the region
// automatically; an unmapped region uses its full name. Add a row here for a
// new region. Child-resource names use this `tokenscope-<env>-<region>`
// scheme; the resource group is yours to name and is passed at deploy time (`-g`).
var regionShortMap = {
  australiaeast: 'aue'
  westus3: 'wus3'
  westeurope: 'weu'
}
var regionShort = contains(regionShortMap, location) ? regionShortMap[location] : location
var nameSuffix = '${projectName}-${empty(envNameLabel) ? env : envNameLabel}-${regionShort}'

// ── User-Assigned Managed Identity ────────────────────────────────
// Created at root scope so its principalId is available BEFORE any
// module that needs it (key-vault for RBAC, container-app for ACR pull
// + KV-ref resolution). Without this, RBAC + KV-ref wiring would
// require a circular or two-phase apply.

// Front Door Standard cannot reach an internal environment. Checked on a
// top-level resource because Azure's pre-deployment validation evaluates those,
// so the apply is refused before anything is created (a check inside a module's
// inputs would only fire mid-deployment).
var frontDoorTierAllowed = !(enablePrivateNetworking && enableFrontDoor && frontDoorSku == 'Standard')

resource appIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: 'id-${nameSuffix}'
  location: location
  tags: frontDoorTierAllowed
    ? tags
    : fail('Front Door Standard cannot reach a VNet (internal) environment: set frontDoorSku to Premium, or use your own WAF with enableFrontDoor false.')
}

// ── Monitoring ──────────────────────────────────────────────────────
// Provides LAW + AppInsights + AMW + alerts.

module monitoring 'modules/monitoring.bicep' = {
  name: 'monitoring'
  params: {
    name: nameSuffix
    location: location
    environment: env
    notificationEmail: alertNotificationEmail
    deployAzureMonitorWorkspace: deployAzureMonitorWorkspace
    // OTLP ingest DCE/DCR + MI RBAC (Monitoring Metrics Publisher on the
    // DCR, Log Analytics Reader on the LAW) — same deployRbac gate as KV.
    identityPrincipalId: appIdentity.properties.principalId
    deployRbac: deployRbac
    // Private-query hardening (ingestion stays public). The `azuremonitor` PE
    // needs its OWN subnet (multi-IP; SubnetIsFull beside the data-plane PEs),
    // so it uses amplsSubnetId, not the shared PE subnet. On useCentralAmpls we
    // deploy no scope, and no PE either unless centralAmplsResourceId is set.
    enableQueryPrivateLink: enablePrivateNetworking && monitorQueryPrivateOnly
    separateOpsWorkspace: separateOpsWorkspace
    privateEndpointSubnetId: enablePrivateNetworking ? networking!.outputs.amplsSubnetId : ''
    useCentralAmpls: useCentralAmpls
    centralAmplsResourceId: centralAmplsResourceId
    tags: tags
  }
}

// ── Networking ───────────────────────────────────────────
// Conditional on `enablePrivateNetworking`. Provides:
//   - VNet 10.0.0.0/16
//   - snet-container-apps  10.0.0.0/23  (Container Apps env delegation)
//   - snet-private-endpoints 10.0.2.0/24
//   - private DNS zones + VNet links for KV, PG, Redis
// Sandbox stays off; staging + production turn it on once validated.

module networking 'modules/networking.bicep' = if (enablePrivateNetworking) {
  name: 'networking'
  params: {
    name: nameSuffix
    location: location
    vnetName: vnetName
    vnetAddressSpace: vnetAddressSpace
    containerAppsSubnetPrefix: containerAppsSubnetPrefix
    privateEndpointsSubnetPrefix: privateEndpointsSubnetPrefix
    amplsSubnetPrefix: amplsSubnetPrefix
    buildSubnetPrefix: buildSubnetPrefix
    subnetNetworkSecurityGroupId: subnetNetworkSecurityGroupId
    subnetRouteTableId: subnetRouteTableId
    natGatewayId: natGatewayId
    hubVnetId: hubVnetId
    useRemoteGateways: useRemoteGateways
    centralDnsZonesSubscriptionId: centralDnsZonesSubscriptionId
    centralDnsZonesResourceGroup: centralDnsZonesResourceGroup
    tags: tags
  }
}

// ── Key Vault ───────────────────────────────────────────────────────
// RBAC role-assignment is gated on `deployRbac`; the SP applying via
// OIDC has Owner, so deployRbac=true is the normal sandbox apply.

module keyVault 'modules/key-vault.bicep' = {
  name: 'key-vault'
  params: {
    name: nameSuffix
    location: location
    environment: env
    createMode: keyVaultCreateMode
    identityPrincipalId: appIdentity.properties.principalId
    deployRbac: deployRbac
    enablePrivateEndpoint: enablePrivateNetworking
    // privateEndpointSubnetId + privateDnsZoneId come from the
    // networking module when `enablePrivateNetworking=true`. When
    // false, both are '' and the data-plane module's if-guard skips
    // the private-endpoint resources.
    privateEndpointSubnetId: enablePrivateNetworking ? networking!.outputs.privateEndpointSubnetId : ''
    privateDnsZoneId: (enablePrivateNetworking && registerDnsZoneGroups) ? networking!.outputs.dnsZoneKeyVaultId : ''
    logAnalyticsId: monitoring.outputs.opsLogAnalyticsId
    tags: tags
  }
}

// ── Container Registry ──────────────────────────────────────────────

module containerRegistry 'modules/container-registry.bicep' = {
  name: 'container-registry'
  params: {
    name: nameSuffix
    location: location
    environment: env
    logAnalyticsId: monitoring.outputs.opsLogAnalyticsId
    // ACR goes private alongside the rest of the data plane. When
    // enablePrivateNetworking=false there's no networking module, so both
    // IDs are '' and the module's if-guard skips the PE (public + RBAC).
    enablePrivateEndpoint: enablePrivateNetworking
    privateEndpointSubnetId: enablePrivateNetworking ? networking!.outputs.privateEndpointSubnetId : ''
    privateDnsZoneId: (enablePrivateNetworking && registerDnsZoneGroups) ? networking!.outputs.dnsZoneAcrId : ''
    tags: tags
  }
}

// ── PostgreSQL ──────────────────────────────────────────────────────

module postgresql 'modules/postgresql.bicep' = {
  name: 'postgresql'
  params: {
    name: nameSuffix
    location: location
    environment: env
    adminLogin: pgAdminLogin
    adminPassword: pgAdminPassword
    enablePrivateEndpoint: enablePrivateNetworking
    privateEndpointSubnetId: enablePrivateNetworking ? networking!.outputs.privateEndpointSubnetId : ''
    privateDnsZoneId: (enablePrivateNetworking && registerDnsZoneGroups) ? networking!.outputs.dnsZonePostgresqlId : ''
    logAnalyticsId: monitoring.outputs.opsLogAnalyticsId
    slowStatementLogMs: slowStatementLogMs
    maxConnections: postgresMaxConnections
    tags: tags
  }
}

// ── Redis ───────────────────────────────────────────────────────────

module redis 'modules/redis.bicep' = {
  name: 'redis'
  params: {
    name: nameSuffix
    location: location
    environment: env
    enablePrivateEndpoint: enablePrivateNetworking
    privateEndpointSubnetId: enablePrivateNetworking ? networking!.outputs.privateEndpointSubnetId : ''
    privateDnsZoneId: (enablePrivateNetworking && registerDnsZoneGroups) ? networking!.outputs.dnsZoneRedisId : ''
    tags: tags
  }
}

// ── ACR Pull RBAC ───────────────────────────────────────────────────
// Grants the user-assigned MI permission to pull images from ACR.
// Inlined at root scope (rather than inside container-app.bicep) so
// it's in the same scope as appIdentity — keeps the principalId
// reference simple and avoids passing it down twice.
//
// dependsOn: containerRegistry — the registry resource must EXIST
// before the role assignment can target it. The `existing` reference
// below evaluates at compile-time so the dependency must be explicit.

var acrPullRoleId = '7f951dda-4ed3-4680-a7ca-43fe172d538d'

resource existingAcr 'Microsoft.ContainerRegistry/registries@2023-07-01' existing = {
  name: replace('cr${nameSuffix}', '-', '')
}

resource acrPullRoleAssignment 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (deployRbac) {
  name: guid(appIdentity.id, existingAcr.id, acrPullRoleId)
  scope: existingAcr
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', acrPullRoleId)
    principalId: appIdentity.properties.principalId
    principalType: 'ServicePrincipal'
  }
  dependsOn: [
    containerRegistry
  ]
}

// ── Key Vault Secrets ───────────────────────────────────────────────
// Writes-only module. Implicit dependsOn keyVault (via
// keyVault.outputs.keyVaultName), postgresql (serverFqdn), and redis
// (hostName + primaryKey). Every secret is wrapped in an if-guard
// per the SAFETY CONTRACT in keyvault-secrets.bicep.

module kvSecrets 'modules/keyvault-secrets.bicep' = {
  name: 'keyvault-secrets'
  params: {
    keyVaultName: keyVault.outputs.keyVaultName
    // Database — components passed in, URL built inside the module to
    // keep the password out of the root template's string interpolation.
    pgAdminLogin: pgAdminLogin
    pgAdminPassword: pgAdminPassword
    pgServerFqdn: postgresql.outputs.serverFqdn
    // RLS enforcement: '' on an ordinary apply, which is a NO-OP that leaves any
    // stored app-role password (and the URL built from it) untouched. Only an
    // apply that deliberately asks for it generates and writes a new one.
    appDbPassword: writeAppDbPassword ? appDbPasswordSeed : ''
    // Redis — components passed in, URL built inside the module so the
    // primary key never lands in the root template.
    redisHostName: redis.outputs.hostName
    redisSslPort: redis.outputs.sslPort
    redisPrimaryKey: redis.outputs.primaryKey
    // App secrets
    sessionSecret: sessionSecret
    hmacSessionKey: hmacSessionKey
    internalWorkerHmacKey: internalWorkerHmacKey
    anthropicApiKey: anthropicApiKey
    // F2 GitHub Copilot reconciliation PATs (GATED OFF; empty = NO-OP).
    githubPatPartnerDemo: githubPatPartnerDemo
    githubPatProduction: githubPatProduction
    githubPatApacNfr: githubPatApacNfr
    // GitHub App private key (App-credential path; base64 PEM; empty = NO-OP).
    githubAppKeyPartnerDemo: githubAppKeyPartnerDemo
    // Ops alerting channel (§A1; empty = NO-OP — never clobbers a stored topic).
    opsAlertNtfyUrl: opsAlertNtfyUrl
    entraClientSecret: entraIdClientSecret
    oidcSessionSecret: oidcSessionSecret
    oidcAuthSessionSecret: oidcAuthSessionSecret
    oidcTokenKey: oidcTokenKey
  }
}

// ── Container App ───────────────────────────────────────────────────
// Must wait for kvSecrets (KV refs would 404 otherwise) AND for
// acrPullRoleAssignment (image pull would 401 otherwise). Both are
// explicit dependsOn entries — implicit-via-outputs is not enough for
// either, since kvSecrets has no outputs and acrPullRoleAssignment is
// only conditionally emitted (deployRbac).

module containerApp 'modules/container-app.bicep' = {
  name: 'container-app'
  params: {
    name: nameSuffix
    location: location
    environment: env
    imageTag: imageTag
    acrLoginServer: containerRegistry.outputs.loginServer
    identityId: appIdentity.id
    identityClientId: appIdentity.properties.clientId
    appInsightsConnectionString: monitoring.outputs.appInsightsConnectionString
    keyVaultUri: keyVault.outputs.keyVaultUri
    entraTenantId: entraIdTenantId
    entraClientId: entraIdClientId
    entraRedirectUri: entraIdRedirectUri
    appPublicOrigin: appPublicOrigin
    mcpAllowedHosts: mcpAllowedHosts
    allowPersonaOverride: allowPersonaOverride
    bootstrapAdminEmail: bootstrapAdminEmail
    containerAppsSubnetId: enablePrivateNetworking ? networking!.outputs.containerAppsSubnetId : ''
    // Private networking → internal ACA env (private VIP; Front Door Premium or your own WAF fronts it).
    internalIngress: enablePrivateNetworking
    // Reader: telemetry workspace. Environment logs: ops workspace.
    logAnalyticsCustomerId: monitoring.outputs.logAnalyticsCustomerId
    appLogsWorkspaceCustomerId: monitoring.outputs.opsLogAnalyticsCustomerId
    // The name lets container-app call listKeys() itself — the shared key
    // never crosses a module-output boundary.
    appLogsWorkspaceName: monitoring.outputs.opsLogAnalyticsName
    // The ops workspace is outside the private link scope the VNet resolves through.
    appLogsViaDiagnosticSettings: separateOpsWorkspace
    appLogsWorkspaceId: monitoring.outputs.opsLogAnalyticsId
    appCpu: appCpu
    appMemory: appMemory
    // Full OTLP logs ingest URL (VERIFIED form, sandbox-realclaude-journey.md):
    // <dce-logs-endpoint>/dataCollectionRules/<dcrImmutableId>/streams/
    // Microsoft-OTLP-Logs/otlp/v1/logs. Drives the app's LogAnalyticsReader +
    // MI bearer mint + the attest endpoint's emit-config for the plugin.
    azureMonitorLogsEndpoint: '${monitoring.outputs.dceLogsIngestionEndpoint}/dataCollectionRules/${monitoring.outputs.dcrImmutableId}/streams/Microsoft-OTLP-Logs/otlp/v1/logs'
    // DCR ARM resource id — the Azure Monitor METRICS API target for the
    // read-path ingest-coverage probe (NUXT_AZURE_DCR_RESOURCE_ID). Needs
    // Monitoring Reader on the DCR (granted in monitoring.bicep).
    dcrResourceId: monitoring.outputs.dcrResourceId
    // The telemetry workspace's daily cap, for the telemetry-cap ops alert.
    telemetryDailyCapGb: monitoring.outputs.telemetryDailyCapGb
    hasAnthropicKey: hasAnthropicKey || !empty(anthropicApiKey)
    // F2 GitHub Copilot reconciliation PATs (GATED OFF; flags false until provided).
    hasGithubPatPartnerDemo: !empty(githubPatPartnerDemo)
    hasGithubPatProduction: !empty(githubPatProduction)
    hasGithubPatApacNfr: !empty(githubPatApacNfr)
    // GitHub App private key (App-credential path; flag false until the base64 PEM is provided).
    hasGithubAppKeyPartnerDemo: !empty(githubAppKeyPartnerDemo)
    // Ops alerting channel (§A1) — derived-flag pattern (same as the PATs):
    // the ref/env is emitted only on an apply that also wrote the KV secret,
    // so a KV ref to a missing secret (an ACA deploy failure) is unreachable.
    hasOpsAlertNtfyUrl: !empty(opsAlertNtfyUrl)
    // RLS enforcement (§9). Every consumer is AND-ed with hasAppRoleSecrets so
    // a flag set out of order narrows to a no-op instead of emitting a KV
    // reference to a secret that was never written (which ACA rejects at deploy
    // time, and which would read as "enabled" in the template either way).
    // rotateAppDbPassword additionally requires provisionAppRole: the boot step
    // only reads it while it is provisioning, so on its own it is inert and
    // would read as "rotating" in the template while nothing rotated.
    hasAppRoleSecrets: hasAppRoleSecrets
    provisionAppRole: provisionAppRole && hasAppRoleSecrets
    rotateAppDbPassword: rotateAppDbPassword && provisionAppRole && hasAppRoleSecrets
    // NOT AND-ed with anything. The sweep runs on the OWNER connection and needs
    // no secret, so narrowing it would only add another way for a flag to read
    // as enabled while doing nothing.
    runRlsCutoverSweep: runRlsCutoverSweep
    /*
     * DELIBERATELY NOT AND-ed with provisionAppRole either, though that
     * combination is a real hazard: useAppRoleAtRuntime=true with
     * provisionAppRole=false points the runtime at a role nothing maintains. The
     * fix is in the boot step, not here — drizzle/provision-app-role.ts probes
     * TOKENSCOPE_APP_DATABASE_URL and aborts on a broken credential EVEN WHEN IT
     * IS DORMANT. That check has to exist regardless, because the role can be
     * dropped or the secret can drift with provisioning firmly on, and once it
     * exists the coupling here would add nothing but a silent no-op.
     *
     * AND-ing WITH runRlsCutoverSweep WOULD BE WRONG, not merely redundant —
     * worth stating because it is the obvious "fix" to reach for. The sweep is
     * once-per-environment and stamped; the steady state after a successful
     * cutover is runRlsCutoverSweep=false with useAppRoleAtRuntime=true. A
     * template AND would make the correct end state un-expressible and every
     * later deploy silently drop the runtime back to the owner.
     *
     * The real precondition is not "was the sweep requested this apply?" but
     * "is the DATABASE in a state the app can bind to?" — true or false
     * independently of which apply made it so. Only the boot step can ask that,
     * and drizzle/assert-runtime-rls-safe.ts does, fatally.
     */
    useAppRoleAtRuntime: useAppRoleAtRuntime && hasAppRoleSecrets
    hasEntraClientSecret: !empty(entraIdClientSecret)
    hasOidcModuleSecrets: !empty(oidcSessionSecret) && !empty(oidcAuthSessionSecret) && !empty(oidcTokenKey)
    aiFoundryEndpoint: ''
    azureFrontDoorId: frontDoorId
    gitCommitSha: gitCommitSha
    anthropicApiEndpoint: anthropicApiEndpoint
    tags: tags
  }
  dependsOn: [
    kvSecrets              // KV refs would 404 without secrets seeded
    acrPullRoleAssignment  // image pull would 401 without AcrPull
  ]
}

// ── Front Door ─────────────────────────────────────────────────
// Conditional on `enableFrontDoor`. Origin FQDN comes from
// containerApp.outputs.fqdn — both an implicit dependency (output ref)
// AND an explicit dependsOn so deployment-graph order is unambiguous.
// With `enableFrontDoor=false` the whole module is elided and no AFD
// resources are touched.

module frontDoor 'modules/front-door.bicep' = if (enableFrontDoor) {
  name: 'front-door'
  params: {
    name: nameSuffix
    environment: env
    // Implicit dependency on containerApp via the .outputs.fqdn reference
    // — ARM orders frontDoor after containerApp without an explicit
    // dependsOn (and Bicep's linter rejects the redundant explicit form).
    // The deployment-graph comment block at the bottom of this file
    // documents the ordering for human readers.
    originFqdn: containerApp.outputs.fqdn
    originResponseTimeoutSeconds: afdOriginResponseTimeoutSeconds
    wafGeoAllowedCountries: wafGeoAllowedCountries
    sku: frontDoorSku
    privateLinkResourceId: enablePrivateNetworking ? containerApp.outputs.environmentId : ''
    privateLinkLocation: enablePrivateNetworking ? location : ''
    managedRuleAction: frontDoorWafManagedRuleAction
    logAnalyticsId: monitoring.outputs.opsLogAnalyticsId
    rateLimitPerIpPer5Min: frontDoorRateLimitPerIpPer5Min
    tags: tags
  }
}

// ── Scheduled worker jobs (Container Apps Jobs) ─────────────────────
// Codifies the cron worker surface (registry.ts recommendedCron) incl. the
// observability workers (went-silent, reconciliation-gap). Guarded on
// workerBaseUrl, so an apply without it (e.g. before the Front Door host is
// known) elides it. NOTE: an apply CONVERGES existing jobs of the same names to
// the values declared in the module (it overwrites any drifted live config,
// e.g. replicaTimeout) — it is NOT a safe no-op over hand-edited jobs. See the
// module header.
module workerJobs 'modules/worker-jobs.bicep' = if (!empty(workerBaseUrl)) {
  name: 'worker-jobs'
  params: {
    namePrefix: workerJobPrefix
    location: location
    environmentId: containerApp.outputs.environmentId
    userAssignedIdentityId: appIdentity.id
    acrLoginServer: containerRegistry.outputs.loginServer
    image: '${containerRegistry.outputs.loginServer}/tokenscope:${imageTag}'
    tokenscopeBaseUrl: workerBaseUrl
    internalWorkerHmacKeyVaultUrl: '${keyVault.outputs.keyVaultUri}secrets/internal-worker-hmac-key'
  }
}

// ── Ops alerting — platform metric alerts ──
// A LATE module by graph necessity: monitoring is a PRODUCER for postgresql
// and container-app, so alert rules scoping those resources cannot live in
// monitoring.bicep without a cycle. This module is the graph's last consumer —
// it reuses monitoring's action group (ar-M19: ONE group, never a second) and
// scopes the targets by their producers' id outputs. See the module header.
module opsAlerts 'modules/ops-alerts.bicep' = {
  name: 'ops-alerts'
  params: {
    name: nameSuffix
    actionGroupId: monitoring.outputs.actionGroupId
    containerAppId: containerApp.outputs.appId
    postgresServerId: postgresql.outputs.serverId
    // The dead-man (ar-H4) scopes the caj-ts-ops-alert JOB, which exists only
    // when worker-jobs deploys ('caj-ts-' + registry key, the worker-jobs.bicep
    // naming rule; the ops-alert workers-array entry + ar-L22 cron lockstep are
    // owned there). Same workerBaseUrl gate as the workerJobs module, so
    // applies without workerBaseUrl elide the rule instead of scoping a missing resource.
    // resourceId() is a pure string build — NO implicit dependency — hence the
    // explicit dependsOn below.
    opsAlertJobId: !empty(workerBaseUrl) ? resourceId('Microsoft.App/jobs', '${workerJobPrefix}-ops-alert') : ''
    logAnalyticsId: monitoring.outputs.opsLogAnalyticsId
    logsOnOpsWorkspace: separateOpsWorkspace
    tags: tags
  }
  dependsOn: [
    workerJobs // the dead-man's scope must EXIST before a metric alert can target it
  ]
}

// ── Outputs ─────────────────────────────────────────────────────────

@description('Container App ingress FQDN.')
output containerAppUrl string = containerApp.outputs.fqdn

@description('Container App resource name (e.g. ca-tokenscope-sandbox-aue).')
output containerAppName string = containerApp.outputs.appName

@description('ACR login server FQDN.')
output acrLoginServer string = containerRegistry.outputs.loginServer

@description('Key Vault resource name.')
output keyVaultName string = keyVault.outputs.keyVaultName

@description('PostgreSQL Flexible Server resource name.')
output postgresqlServerName string = postgresql.outputs.serverName

@description('Redis cache host name (non-sensitive).')
output redisHostName string = redis.outputs.hostName

// ── Network outputs ─────────────────────────────────────────────────
// For whoever creates DNS records / peerings outside the template.

@description('VNet name (empty when private networking is off).')
output vnetName string = enablePrivateNetworking ? networking!.outputs.vnetName : ''

@description('Build subnet resource ID when buildSubnetPrefix is set (for a runner VM or `az acr agentpool create --subnet-id`).')
output buildSubnetId string = enablePrivateNetworking ? networking!.outputs.buildSubnetId : ''

// ── Front Door outputs ─────────────────────────────────────────────
// Emitted unconditionally; they resolve to '' when `enableFrontDoor=false`.

@description('Public AFD endpoint FQDN (e.g. ep-tokenscope-sandbox-aue-<hash>.azurefd.net). Empty when enableFrontDoor=false.')
// The `!` non-null assertion is safe: enableFrontDoor=true is the exact
// condition under which the `frontDoor` module is emitted (BCP318
// warning otherwise — the type system treats conditional modules as
// possibly-null).
output frontDoorEndpointFqdn string = enableFrontDoor ? frontDoor!.outputs.endpointFqdn : ''

@description('AFD instance ID (the X-Azure-FDID header value). Pass it back as `frontDoorId` on the next apply to enforce Front Door.')
output frontDoorInstanceId string = enableFrontDoor ? frontDoor!.outputs.frontDoorId : ''

@description('Premium + Private Link: the message on Front Door\'s private endpoint request to approve. Empty otherwise.')
output frontDoorPrivateLinkRequestMessage string = enableFrontDoor ? frontDoor!.outputs.privateLinkRequestMessage : ''

// ── Deployment graph (consumer ← producer) ──────────────────────────
//
// appIdentity            (root-scope resource, no deps)
// monitoring             (no deps; LAW + AppInsights + AMW + alerts)
// networking             (no deps; VNet + subnets + 3 private DNS zones).
//                        Gated on `enablePrivateNetworking`.
// keyVault              ← appIdentity (principalId for RBAC),
//                         networking (when private endpoints on)
// containerRegistry      (no deps)
// postgresql            ← networking (when private endpoints on)
// redis                 ← networking (when private endpoints on)
// acrPullRoleAssignment ← appIdentity, containerRegistry (dependsOn)
// kvSecrets             ← keyVault, postgresql, redis (implicit via outputs)
// containerApp          ← appIdentity, containerRegistry, monitoring,
//                         keyVault, networking (when private networking
//                         on, for snet-container-apps); implicit via
//                         outputs. + kvSecrets, acrPullRoleAssignment
//                         (explicit dependsOn).
// frontDoor             ← containerApp (implicit via outputs.fqdn).
//                        Gated on `enableFrontDoor`.
// workerJobs            ← containerApp (environmentId), containerRegistry,
//                         keyVault, appIdentity (implicit via outputs).
//                        Gated on `workerBaseUrl`.
// opsAlerts             ← monitoring (actionGroupId), containerApp (appId),
//                         postgresql (serverId) — implicit via outputs — and
//                         workerJobs (explicit dependsOn: the dead-man rule
//                         scopes the caj-ts-ops-alert job). The LAST consumer:
//                         its alert rules scope resources monitoring produces
//                         FOR, which is why they cannot live in monitoring.bicep.
//
// No cycles. Every consumer comes after its producer.
// When private networking is off (sandbox), the networking module is
// elided and the data-plane modules receive '' for their subnet/DNS
// params; their if-guards short-circuit the PE resources.
