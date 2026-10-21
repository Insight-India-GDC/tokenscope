// ── Container App — TokenScope Nuxt application ───────────────────────
//
// Includes the Container Apps managed environment as well as the app
// itself. The user-assigned MI (created at root scope in
// main.bicep) is passed in via identityId + identityClientId and is the
// identity used for BOTH ACR pull AND KV-reference resolution.

@description('Resource name suffix (e.g. tokenscope-sandbox-aue).')
param name string

@description('Azure region.')
param location string

@description('Environment name (drives resources + replica counts).')
@allowed(['sandbox', 'dev', 'demo', 'staging', 'production'])
param environment string

@description('Container image tag (e.g. sandbox-abc1234). The full image is composed inside this module from acrLoginServer + tag.')
param imageTag string

@description('ACR login server FQDN (e.g. crtokenscopesandbox.azurecr.io).')
param acrLoginServer string

@description('User-assigned MI resource ID — for ACR pull + KV secret access.')
param identityId string

@description('User-assigned MI client ID — for DefaultAzureCredential / Workload-Identity-style auth from the app.')
param identityClientId string

@description('Application Insights connection string. Wires APPLICATIONINSIGHTS_CONNECTION_STRING.')
param appInsightsConnectionString string

@description('Key Vault URI (e.g. https://kv-tokenscope-sandbox-aue.vault.azure.net/).')
param keyVaultUri string

@description('Entra ID tenant ID for nuxt-oidc-auth.')
param entraTenantId string = ''

@description('Entra ID client ID for nuxt-oidc-auth.')
param entraClientId string = ''

@description('Entra ID redirect URI for nuxt-oidc-auth (public callback URL).')
param entraRedirectUri string = ''

@description('Optional pinned PUBLIC origin (scheme://host) when an upstream WAF/proxy fronts the app under a fixed hostname (e.g. https://tokenscope.your-company.example behind your own WAF). Empty = derive the public origin from Front Door / the request Host. See server/utils/public-url.ts.')
param appPublicOrigin string = ''

@description('Break-glass EXTRA hostnames the MCP transport answers to, comma-separated. The app already derives its public origin and its Container Apps app/revision FQDNs; this covers a topology that derivation does not model (custom backend domain, private DNS alias, traffic-label FQDN) WITHOUT a code change and release. Empty is the normal state. See server/utils/public-url.ts platformSelfHosts().')
param mcpAllowedHosts string = ''

@description('Whether admin users can override their session into a demo persona via /api/v1/auth/dev-login. Production MUST be false.')
param allowPersonaOverride bool = false

@description('Bootstrap admin email — the first Entra sign-in matching this address gets the `platform-admin` role on JIT teammate creation.')
param bootstrapAdminEmail string = ''

// ── VNet Integration (Wave-III) ─────────────────────────────────────

@description('Subnet ID for Container App Environment VNet integration. Empty = no VNet.')
param containerAppsSubnetId string = ''

@description('Make the Container Apps environment INTERNAL — a private VIP on the VNet, no public endpoint. Whatever fronts it (Front Door Premium over Private Link, or your own WAF / application gateway) is then the only public entrypoint, reaching the internal VIP over the VNet. Wired from main.bicep `enablePrivateNetworking`. Requires containerAppsSubnetId.')
param internalIngress bool = false

// ── Log Analytics ────────────────────────────────────────────────────

@description('TELEMETRY workspace customer ID (workspace GUID): what the app\'s reader queries for OTelLogs (NUXT_LOG_ANALYTICS_WORKSPACE_ID). Not where the environment\'s own logs go — that is appLogsWorkspaceCustomerId.')
param logAnalyticsCustomerId string = ''

@description('Workspace customer ID the Container Apps environment sends console/system logs to (monitoring.outputs.opsLogAnalyticsCustomerId). Empty = no app-logs destination.')
param appLogsWorkspaceCustomerId string = ''

@description('Name of the appLogsWorkspaceCustomerId workspace. Container app references it as `existing` and calls `listKeys()` to read the shared key inline, so the secret never appears as a cross-module output.')
param appLogsWorkspaceName string = ''

@description('Ship the environment\'s logs through a diagnostic setting (destination azure-monitor) into appLogsWorkspaceId. Required when that workspace is outside an Azure Monitor Private Link Scope the VNet resolves through. Tables become ContainerAppConsoleLogs / ContainerAppSystemLogs (no _CL).')
param appLogsViaDiagnosticSettings bool = false

@description('Resource ID of the workspace the diagnostic setting writes to. Read only when appLogsViaDiagnosticSettings.')
param appLogsWorkspaceId string = ''

@description('vCPU for the app container. Null = 1.0 in production, 0.5 otherwise. Must pair with appMemory per the Consumption profile ratio (0.5 → 1Gi, 1.0 → 2Gi, …).')
param appCpu string?

@description('Memory for the app container. Null = 2Gi in production, 1Gi otherwise. Node\'s default heap limit is about half of it.')
param appMemory string?

@description('Full Azure Monitor OTLP logs ingest URL (DCE logs endpoint + DCR immutable id + Microsoft-OTLP-Logs stream), composed in main.bicep. Empty = phase-1 bring-up before the DCE/DCR exist → the telemetry reader env is omitted and the read joiner stays off.')
param azureMonitorLogsEndpoint string = ''

@description('DCR ARM resource id for the read-path ingest-coverage metrics probe (NUXT_AZURE_DCR_RESOURCE_ID). Empty = the probe reads unknown and the stall alerts fall back to the bearer gate.')
param dcrResourceId string = ''

@description('Daily ingestion cap of the TELEMETRY workspace in GB (monitoring.outputs.telemetryDailyCapGb), set as TELEMETRY_DAILY_CAP_GB for the ops-alert telemetry-cap condition. 0 = unknown: the condition is indeterminate.')
param telemetryDailyCapGb int = 0

// ── Optional secret-presence flags ──────────────────────────────────
// These flags mirror the if-guards in keyvault-secrets.bicep. The
// container app must NOT reference a KV secret that doesn't exist —
// ACA rejects KV refs to missing secrets and the deploy fails.

@description('Whether the anthropic-admin-api-key KV secret exists (the Anthropic admin key for the analytics poller, read as NUXT_ANTHROPIC_KEY_MAIN). Set true once the secret is in Key Vault.')
param hasAnthropicKey bool = false

// ── GitHub Copilot reconciliation PAT presence flags (F2 — GATED OFF) ──
// TEMPLATE. The reconciliation worker runs IN THIS web-app process (the cron job
// just HMAC-pings /api/v1/internal/run-worker/<name>), so the PAT env vars belong
// HERE, not on worker-jobs.bicep. Read at runtime as NUXT_GITHUB_PAT_<NAME> by
// server/reconciliation/credentials.ts. Default false = no KV ref emitted (ACA
// rejects a ref to a missing secret), so this is a clean no-op until a PAT is
// provided + the matching provider_enterprise row is seeded.
@description('Whether the github-pat-partner-demo KV secret was created (F2 NFR/internal enterprise). Default false — F2 stays gated off.')
param hasGithubPatPartnerDemo bool = false

@description('Whether the github-pat-production KV secret was created (F2 production enterprise). Default false. Rename to match the production credential_secret_name once known.')
param hasGithubPatProduction bool = false

@description('Whether the github-pat-enterprise-nfr KV secret exists (the APAC GitHub NFR/internal enterprise Copilot reconciliation PAT, read as NUXT_GITHUB_PAT_ENTERPRISE_NFR; credential_secret_name "enterprise-nfr"). Default false; flip true ONLY after the PAT is placed in Key Vault as github-pat-enterprise-nfr (ACA rejects a KV ref to a missing secret).')
param hasGithubPatApacNfr bool = false

@description('Whether the github-app-key-partner-demo KV secret was created (the GitHub App PRIVATE KEY, base64 PEM, for the partner-demo enterprise App-credential path; read as NUXT_GITHUB_APP_KEY_PARTNER_DEMO; credential_secret_name "partner-demo"). Default false = no KV ref emitted; flip true ONLY after the key is in Key Vault (ACA rejects a ref to a missing secret).')
param hasGithubAppKeyPartnerDemo bool = false

// Ops alerting channel. The ntfy topic URL
// IS the credential, so it reaches the container ONLY as a secretRef — never a
// plain env value (ar-M20). False = no KV ref, no env var: the ops-alert
// worker sees an empty NUXT_OPS_ALERT_NTFY_URL and alerting is disabled (the
// sandbox/local default).
@description('Whether the ops-alert-ntfy-url KV secret exists (the operator push channel, read as NUXT_OPS_ALERT_NTFY_URL). Default false = no KV ref emitted (ACA rejects a ref to a missing secret); alerting disabled.')
param hasOpsAlertNtfyUrl bool = false

// ── RLS enforcement: the non-owner app role ──
// FOUR FLAGS, FOUR SEPARATE DECISIONS, ALL DEFAULT FALSE (a fifth,
// rotateAppDbPassword, is a rare deliberate act — see below). They are not one
// switch because they fail in different ways, and the order between them is the
// whole safety property:
//   1. hasAppRoleSecrets  — the KV secrets exist, so reference them and hand the
//      password to the boot step. Referencing a KV secret that does not exist is
//      an ACA deploy failure, which is why this mirrors keyvault-secrets.bicep's
//      if-guard rather than being inferred.
//   2. provisionAppRole   — let the boot step actually CREATE the role, grant it
//      and set its ALTER DEFAULT PRIVILEGES. IT DOES NOT TOUCH ROW-LEVEL
//      SECURITY: creating a role and cutting an estate over to RLS enforcement
//      are two decisions, and folding the second into the first is what made the
//      sweep's trigger wrong three adversarial rounds running.
//   3. runRlsCutoverSweep — THE CUTOVER SWEEP, its own script
//      (drizzle/cutover-rls-sweep.ts) behind its own flag. DISABLE row-level
//      security on EVERY RLS-enabled table that is not already FORCEd, not just
//      the bootstrap ones: a non-owner is bound by ENABLE alone, so anything
//      left enabled would filter the app the instant (4) lands. The app is still
//      the owner at this point, so nothing observable changes.
//      IT NEVER DISABLES A FORCEd TABLE — that is how a rollout phase says
//      "deliberately enabled, hands off" (§7), and a boot script reverting one
//      is the defect this split exists to end. A BOOTSTRAP table that is FORCEd
//      is a real §5-vs-§7 conflict: it REFUSES, changes nothing, and names both
//      resolutions rather than picking a winner.
//      THE SWEEP RUNS ONCE. It is stamped in seed_state, so a later boot logs
//      the sweep it WOULD have run and changes nothing — which is what makes
//      this flag safe to leave true. Re-sweeping means bumping
//      RLS_CUTOVER_SWEEP_VERSION, deliberately.
//   4. useAppRoleAtRuntime — the cutover: the runtime pools connect as the role,
//      and the RLS policies start executing. Requires the role to EXIST, i.e. a
//      previous deploy with (2) on and a boot log that verified it.
// Rollback is turning (4) back off and re-applying. That returns every runtime
// query to the owner connection; it does NOT re-enable the swept tables, which
// is a deliberate step of its own.
//
// (4) WITHOUT (2) IS NOT BLOCKED HERE, ON PURPOSE. It is a hazard — the runtime
// points at a role nothing maintains — but the boot step answers it directly:
// even when dormant, it probes TOKENSCOPE_APP_DATABASE_URL and aborts boot on a
// credential that is genuinely broken. That probe has to exist anyway (the role
// can be dropped, or the secret can drift, with (2) firmly on), so AND-ing the
// two flags would add nothing but another way for a flag to read as enabled
// while silently doing nothing.
//
// THE BOOT STEP SETS THE ROLE'S PASSWORD ONCE, WHEN IT CREATES IT. Leaving
// provisionAppRole on afterwards is safe precisely because a later boot does NOT
// touch the password — it converges the role's attributes and grants and stops.
// Rolling the credential is (5) rotateAppDbPassword, on for one deliberate boot.
@description('Whether the app-db-password + database-url-app KV secrets exist (created by keyvault-secrets.bicep from a generated password). Default false = no KV ref emitted. Flip true on the SAME apply that first writes them.')
param hasAppRoleSecrets bool = false

@description('Set TOKENSCOPE_PROVISION_APP_ROLE=true, letting the boot step create the non-owner role, grant it and set its ALTER DEFAULT PRIVILEGES. It does NOT change row-level security — that is runRlsCutoverSweep. Requires hasAppRoleSecrets. Default false = the boot step logs one line and exits. Safe to keep true afterwards: a boot that finds the role already there converges its attributes and grants and never touches its password unless rotateAppDbPassword is also on.')
param provisionAppRole bool = false

@description('Set TOKENSCOPE_RLS_CUTOVER_SWEEP=true, letting the boot step run the one-time cutover sweep that DISABLEs row-level security on every RLS-enabled table not already FORCEd. It never disables a FORCEd table, and it REFUSES (changing nothing) if a bootstrap table is FORCEd. Stamped in seed_state, so it does not re-run and this is safe to leave true. Default false = the step logs one line and exits.')
param runRlsCutoverSweep bool = false

@description('ROLL THE APP ROLE PASSWORD. Sets TOKENSCOPE_ROTATE_APP_DB_PASSWORD=true, the ONLY path that changes an EXISTING role password to the app-db-password secret. Turn on for ONE deliberate boot after an apply with writeAppDbPassword=true, then turn it back off — left on, every replica restart is a rotation, and a rotation under a live app takes the credential out from under whichever replica is already serving. Requires provisionAppRole + hasAppRoleSecrets.')
param rotateAppDbPassword bool = false

@description('THE CUTOVER: set TOKENSCOPE_APP_DATABASE_URL so the runtime pools connect as the non-owner role and the RLS policies begin to execute. Requires a role that already EXISTS — deploy with provisionAppRole first and read the boot log. Default false = the app connects as the owner exactly as today; turning it back off is the rollback.')
param useAppRoleAtRuntime bool = false

@description('Whether the entra-client-secret KV secret was created.')
param hasEntraClientSecret bool = false

@description('Whether the three nuxt-oidc-auth module encryption KV secrets were created. When true, the OIDC module uses stable secrets across revisions (sessions survive rolls); when false, the module generates random per-boot values and sessions break across redeploys.')
param hasOidcModuleSecrets bool = false

@description('Azure AI Foundry endpoint URL (empty = not used; Anthropic direct).')
param aiFoundryEndpoint string = ''

@description('Azure Front Door instance ID. Default empty = the app does not require requests to come through Front Door.')
param azureFrontDoorId string = ''

@description('Git commit SHA at deploy time. Empty = use the build-time baked value (Dockerfile ARG GIT_COMMIT_SHA). The /admin/settings → build.commitSha read reflects whichever wins.')
param gitCommitSha string = ''

@description('Anthropic analytics API base URL (NUXT_ANTHROPIC_API_ENDPOINT). Empty = reconciliation + analytics-poller no-op. Set to https://api.anthropic.com on envs with a reconciled Anthropic org. Non-secret config.')
param anthropicApiEndpoint string = ''

@description('Tags applied to every resource.')
param tags object = {}

// ── Container App Environment ──────────────────────────────────────
// The managed env lives inside this module so it's
// always co-versioned with the app revision.

resource containerAppEnvDiagnostics 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = if (appLogsViaDiagnosticSettings && !empty(appLogsWorkspaceId)) {
  name: 'diag-${name}'
  scope: containerAppEnv
  properties: {
    workspaceId: appLogsWorkspaceId
    logs: [
      { category: 'ContainerAppConsoleLogs', enabled: true }
      { category: 'ContainerAppSystemLogs', enabled: true }
    ]
  }
}

// Reference the LAW as `existing` so the shared key resolves inline
// via listKeys() — keeps the key out of every cross-module boundary.
// The lookup is unconditional (Bicep's `existing` is a symbolic compile
// -time reference; ARM only resolves it when listKeys() is invoked,
// which the appLogsConfiguration ternary below reaches only when
// appLogsViaDiagnosticSettings is off and appLogsWorkspaceName is set). When
// the name is empty, the deploy is a config-only test and the LAW isn't
// expected to exist — listKeys() is never called.
resource appLogsWorkspace 'Microsoft.OperationalInsights/workspaces@2023-09-01' existing = {
  name: empty(appLogsWorkspaceName) ? 'placeholder-never-used' : appLogsWorkspaceName
}

resource containerAppEnv 'Microsoft.App/managedEnvironments@2024-03-01' = {
  name: 'cae-${name}'
  location: location
  tags: tags
  properties: {
    zoneRedundant: false
    vnetConfiguration: !empty(containerAppsSubnetId) ? {
      infrastructureSubnetId: containerAppsSubnetId
      // Internal = private VIP only (no public endpoint); Front Door Premium
      // (Private Link) or your own WAF fronts it. External otherwise (standalone public ingress).
      internal: internalIngress
    } : null
    appLogsConfiguration: appLogsViaDiagnosticSettings ? {
      destination: 'azure-monitor'
    } : !empty(appLogsWorkspaceCustomerId) && !empty(appLogsWorkspaceName) ? {
      destination: 'log-analytics'
      logAnalyticsConfiguration: {
        customerId: appLogsWorkspaceCustomerId
        sharedKey: appLogsWorkspace.listKeys().primarySharedKey
      }
    } : null
    workloadProfiles: [
      {
        name: 'Consumption'
        workloadProfileType: 'Consumption'
      }
    ]
  }
}

// ── Secrets (Key Vault references) ──────────────────────────────────
// `identity` is the user-assigned MI's resource ID. ACA uses it to
// resolve the keyVaultUrl-referenced secret at runtime — the MI must
// have Key Vault Secrets User on the vault (granted by key-vault.bicep
// when deployRbac=true) AND the secrets must already exist (kvSecrets
// runs before this module via main.bicep dependsOn).

var requiredSecrets = [
  {
    name: 'database-url'
    keyVaultUrl: '${keyVaultUri}secrets/database-url'
    identity: identityId
  }
  {
    name: 'redis-url'
    keyVaultUrl: '${keyVaultUri}secrets/redis-url'
    identity: identityId
  }
  {
    name: 'session-secret'
    keyVaultUrl: '${keyVaultUri}secrets/session-secret'
    identity: identityId
  }
  {
    name: 'hmac-session-key'
    keyVaultUrl: '${keyVaultUri}secrets/hmac-session-key'
    identity: identityId
  }
  {
    name: 'internal-worker-hmac-key'
    keyVaultUrl: '${keyVaultUri}secrets/internal-worker-hmac-key'
    identity: identityId
  }
]

// Conditional secrets — guards mirror keyvault-secrets.bicep's if-clauses.
var anthropicSecrets = hasAnthropicKey ? [
  {
    name: 'anthropic-admin-api-key'
    keyVaultUrl: '${keyVaultUri}secrets/anthropic-admin-api-key'
    identity: identityId
  }
] : []

// GitHub Copilot reconciliation PATs (F2 — GATED OFF; empty flags = no ref emitted).
var githubPatSecrets = concat(
  hasGithubPatPartnerDemo ? [
    {
      name: 'github-pat-partner-demo'
      keyVaultUrl: '${keyVaultUri}secrets/github-pat-partner-demo'
      identity: identityId
    }
  ] : [],
  hasGithubPatProduction ? [
    {
      name: 'github-pat-production'
      keyVaultUrl: '${keyVaultUri}secrets/github-pat-production'
      identity: identityId
    }
  ] : [],
  hasGithubPatApacNfr ? [
    {
      name: 'github-pat-enterprise-nfr'
      keyVaultUrl: '${keyVaultUri}secrets/github-pat-enterprise-nfr'
      identity: identityId
    }
  ] : [],
  // GitHub App private key (App-credential path; base64 PEM).
  hasGithubAppKeyPartnerDemo ? [
    {
      name: 'github-app-key-partner-demo'
      keyVaultUrl: '${keyVaultUri}secrets/github-app-key-partner-demo'
      identity: identityId
    }
  ] : []
)

// The app role's two secrets travel together — keyvault-secrets.bicep writes
// both or neither, so one flag guards both refs. What they are USED for is
// gated separately, on the env vars below.
var appRoleSecrets = hasAppRoleSecrets ? [
  {
    name: 'app-db-password'
    keyVaultUrl: '${keyVaultUri}secrets/app-db-password'
    identity: identityId
  }
  {
    name: 'database-url-app'
    keyVaultUrl: '${keyVaultUri}secrets/database-url-app'
    identity: identityId
  }
] : []

// Ops alerting channel (§A1) — secretRef-only, the topic URL is the credential (ar-M20).
var opsAlertSecrets = hasOpsAlertNtfyUrl ? [
  {
    name: 'ops-alert-ntfy-url'
    keyVaultUrl: '${keyVaultUri}secrets/ops-alert-ntfy-url'
    identity: identityId
  }
] : []

var entraSecrets = hasEntraClientSecret ? [
  {
    name: 'entra-client-secret'
    keyVaultUrl: '${keyVaultUri}secrets/entra-client-secret'
    identity: identityId
  }
] : []

// Three KV secrets backing the nuxt-oidc-auth module's encryption keys.
// All three are required for stable OIDC sessions across revisions.
var oidcModuleSecrets = hasOidcModuleSecrets ? [
  {
    name: 'oidc-session-secret'
    keyVaultUrl: '${keyVaultUri}secrets/oidc-session-secret'
    identity: identityId
  }
  {
    name: 'oidc-auth-session-secret'
    keyVaultUrl: '${keyVaultUri}secrets/oidc-auth-session-secret'
    identity: identityId
  }
  {
    name: 'oidc-token-key'
    keyVaultUrl: '${keyVaultUri}secrets/oidc-token-key'
    identity: identityId
  }
] : []

var allSecrets = concat(requiredSecrets, anthropicSecrets, githubPatSecrets, appRoleSecrets, opsAlertSecrets, entraSecrets, oidcModuleSecrets)

// ── Environment Variables ───────────────────────────────────────────

var baseEnvVars = [
  // NODE_ENV is Nuxt's build-mode signal — stays 'production' on every
  // deployed container so Nuxt's production optimisations engage (SSR
  // chunking, minified output, telemetry off). It is NOT a "what env
  // am I in" signal; that role belongs to NUXT_DEPLOY_ENV below.
  { name: 'NODE_ENV', value: 'production' }
  // NUXT_DEPLOY_ENV — the deployed environment's identity. The persona-override
  // gate + the env classifier (shared/env/deploy-env.ts) read this through an
  // ALLOWLIST: only {local, sandbox} are demo-capable; dev / staging / production
  // / unknown refuse impersonation structurally regardless of any flag. Decouples
  // deploy identity from Nuxt build mode.
  { name: 'NUXT_DEPLOY_ENV', value: environment }
  // Client mirror of the deploy env — set from the SAME `environment` param so the
  // browser-side gate (useDemoFeatures) cannot drift from the server. Used only to
  // hide persona/demo UI off demo-capable envs (cosmetic; server is authoritative).
  { name: 'NUXT_PUBLIC_DEPLOY_ENV', value: environment }
  // Anthropic analytics API base (reconciliation + poller). Empty => unset => clean
  // no-op (adapter/poller return early). Real api.anthropic.com where a reconciled
  // Anthropic org exists. Non-secret config.
  { name: 'NUXT_ANTHROPIC_API_ENDPOINT', value: anthropicApiEndpoint }
  // Entra directory people-picker (Region Leaders / Add-teammate): 'graph' = real
  // Microsoft Graph (User.Read.All, app-only via the OIDC app reg); unset/other =
  // the 6-person mock roster. ALL deployed envs use real Graph — the mock is for
  // local dev / tests only (off-Azure). See server/azure/directory.ts isRealGraph().
  { name: 'NUXT_GRAPH_DIRECTORY_MODE', value: 'graph' }
  // ── Database + Redis (from KV) ──
  { name: 'DATABASE_URL', secretRef: 'database-url' }
  { name: 'REDIS_URL', secretRef: 'redis-url' }
  // ── Session secrets (from KV) ──
  { name: 'NUXT_SESSION_SECRET', secretRef: 'session-secret' }
  { name: 'NUXT_HMAC_SESSION_KEY', secretRef: 'hmac-session-key' }
  { name: 'NUXT_INTERNAL_WORKER_HMAC_KEY', secretRef: 'internal-worker-hmac-key' }
  // ── OIDC (real Entra; not dev-mode) ──
  // Env var NAMES MUST match Nuxt's runtimeConfig.oidc.providers.entra.*
  // overlay path. `NUXT_OIDC_PROVIDERS_ENTRA_<FIELD>` overrides the
  // build-baked placeholder in nuxt.config.ts at container boot.
  //
  // Authorization + token URLs are built here from the tenant ID so the
  // runtime container has fully-formed values; nuxt.config.ts can't
  // derive them (process.env reads there happen at build time and are
  // empty inside az acr build). Compose only if tenant ID is non-empty
  // — empty = phase-1 bring-up before app reg exists.
  { name: 'NUXT_OIDC_AUTH_DEV_MODE', value: 'false' }
  { name: 'NUXT_OIDC_PROVIDERS_ENTRA_CLIENT_ID', value: entraClientId }
  { name: 'NUXT_OIDC_PROVIDERS_ENTRA_REDIRECT_URI', value: entraRedirectUri }
  {
    name: 'NUXT_OIDC_PROVIDERS_ENTRA_AUTHORIZATION_URL'
    value: empty(entraTenantId) ? '' : 'https://login.microsoftonline.com/${entraTenantId}/oauth2/v2.0/authorize'
  }
  {
    name: 'NUXT_OIDC_PROVIDERS_ENTRA_TOKEN_URL'
    value: empty(entraTenantId) ? '' : 'https://login.microsoftonline.com/${entraTenantId}/oauth2/v2.0/token'
  }
  // ── Federated logout (end_session_endpoint) ──
  // LOGOUT_URL: Entra's v2.0 end_session_endpoint, composed from tenant.
  // LOGOUT_REDIRECT_URI: post_logout_redirect_uri Entra bounces back to;
  //   derived from the callback URI (…/auth/entra/callback → …/login) so a
  //   single entraRedirectUri param drives both. MUST be registered as a
  //   redirect URI on the app registration or Entra rejects the redirect.
  // Without LOGOUT_URL the module redirects logout at the request Host,
  // which AFD rewrites to the origin FQDN → require-front-door 500.
  {
    name: 'NUXT_OIDC_PROVIDERS_ENTRA_LOGOUT_URL'
    value: empty(entraTenantId) ? '' : 'https://login.microsoftonline.com/${entraTenantId}/oauth2/v2.0/logout'
  }
  {
    name: 'NUXT_OIDC_PROVIDERS_ENTRA_LOGOUT_REDIRECT_URI'
    value: empty(entraRedirectUri) ? '' : replace(entraRedirectUri, '/auth/entra/callback', '/login')
  }
  // ── Wave-V persona override + JIT bootstrap ──
  // Bicep's string(true) returns 'True' (capital T, .NET-style), NOT
  // 'true'. The triple-gate in dev-login.post.ts compares against the
  // literal lowercase 'true' — so string(bool) silently breaks the
  // override on every deploy. Use a ternary to emit a canonical
  // lowercase token.
  { name: 'NUXT_ALLOW_PERSONA_OVERRIDE', value: allowPersonaOverride ? 'true' : 'false' }
  { name: 'NUXT_BOOTSTRAP_ADMIN_EMAIL', value: bootstrapAdminEmail }
  // ── Monitoring ──
  { name: 'APPLICATIONINSIGHTS_CONNECTION_STRING', value: appInsightsConnectionString }
  // ── App / runtime config ──
  { name: 'NITRO_PORT', value: '3000' }
  { name: 'AZURE_CLIENT_ID', value: identityClientId }
  { name: 'AZURE_KEYVAULT_URL', value: keyVaultUri }
  // ── Front Door enforcement hook ──
  // Empty = the require-front-door middleware is a no-op. Set to the Front
  // Door instance id, it rejects requests without a matching X-Azure-FDID.
  { name: 'AZURE_FRONT_DOOR_ID', value: azureFrontDoorId }
  // Pinned public origin for a proxy-fronted custom hostname.
  // Empty everywhere else → public origin derives from AFD / the request Host.
  { name: 'APP_PUBLIC_ORIGIN', value: appPublicOrigin }
  { name: 'MCP_ALLOWED_HOSTS', value: mcpAllowedHosts }
  // ── Rate-limiter trustworthy IP source (CORE-4) ──
  // nuxt-security's limiter defaults to the first X-Forwarded-For hop, which
  // AFD only APPENDS to (so it is client-controlled → spoofable). When AFD
  // fronts the app, key the limiter on X-Azure-SocketIP, the TCP peer Front
  // Door saw. Not X-Azure-ClientIP: that follows a caller's X-Forwarded-For
  // (server/api/v1/oauth/register.post.ts keys on the socket IP for the same
  // reason). With AFD off, the empty value keeps the single-origin default.
  // Set in lockstep with AZURE_FRONT_DOOR_ID above — the nuxt.config
  // `ipHeader: ''` slot only takes effect once this overlay binds it. On a
  // publicly reachable origin a direct caller that presents the FDID can still
  // set this header itself; the FDID is not a secret.
  { name: 'NUXT_SECURITY_RATE_LIMITER_IP_HEADER', value: empty(azureFrontDoorId) ? '' : 'x-azure-socketip' }
]

// ── Wave-VII build provenance (R1 F2) ──
// CONDITIONAL emit. Container Apps semantics: an explicit empty env value
// OVERRIDES the image's baked ENV. To preserve the Dockerfile-baked
// fallback when Bicep doesn't carry a SHA (e.g., a `latest`-tag re-apply
// with no pipeline-supplied SHA), only emit the env var when non-empty.
// Empty `gitCommitSha` → no env var → container reads the bake.
var gitCommitShaEnvVars = !empty(gitCommitSha) ? [
  { name: 'GIT_COMMIT_SHA', value: gitCommitSha }
] : []

// ── Conditional env vars (only when corresponding KV secret exists) ──
// The analytics poller reads the org admin key as NUXT_ANTHROPIC_KEY_<credential_secret_name>
// (server/workers/analytics-poller.ts::resolveOrgApiKey). credential_secret_name 'main'
// -> NUXT_ANTHROPIC_KEY_MAIN. The KV secret name (anthropic-admin-api-key) is decoupled
// from the env var; this secretRef is what links them. (Replaces the dead ANTHROPIC_API_KEY,
// which nothing read.)
var anthropicEnvVars = hasAnthropicKey ? [
  { name: 'NUXT_ANTHROPIC_KEY_MAIN', secretRef: 'anthropic-admin-api-key' }
] : []
// GitHub Copilot reconciliation PATs (F2 — GATED OFF). Env var name MUST equal
// envKeyForSecret('github', credential_secret_name) = NUXT_GITHUB_PAT_ + upper,
// '-'→'_' (credentials.ts). NUXT_GITHUB_PAT_PARTNER_DEMO <- credential_secret_name
// 'partner-demo'. Emitted only when the corresponding KV secret exists.
var githubPatEnvVars = concat(
  hasGithubPatPartnerDemo ? [
    { name: 'NUXT_GITHUB_PAT_PARTNER_DEMO', secretRef: 'github-pat-partner-demo' }
  ] : [],
  hasGithubPatProduction ? [
    // TEMPLATE: rename PRODUCTION to match the production credential_secret_name
    // (upper-cased, '-'→'_'), and the secretRef to its kv secret name.
    { name: 'NUXT_GITHUB_PAT_PRODUCTION', secretRef: 'github-pat-production' }
  ] : [],
  hasGithubPatApacNfr ? [
    // APAC NFR/internal enterprise — credential_secret_name 'enterprise-nfr'.
    { name: 'NUXT_GITHUB_PAT_ENTERPRISE_NFR', secretRef: 'github-pat-enterprise-nfr' }
  ] : []
)
// GitHub App private keys (App-credential path). Env var name MUST equal
// envKeyForGithubAppKey(credential_secret_name) = NUXT_GITHUB_APP_KEY_ + upper, '-'→'_'
// (credentials.ts). NUXT_GITHUB_APP_KEY_PARTNER_DEMO <- credential_secret_name
// 'partner-demo'. The value is the base64 PEM (github-app-auth.ts base64-decodes it).
var githubAppKeyEnvVars = concat(
  hasGithubAppKeyPartnerDemo ? [
    { name: 'NUXT_GITHUB_APP_KEY_PARTNER_DEMO', secretRef: 'github-app-key-partner-demo' }
  ] : []
)
// RLS enforcement. Five env vars, emitted
// on five separate flags — see the param block for why the order matters.
// Nothing here is emitted by default, so an apply that does not name these
// flags leaves the app connecting exactly as it does today.
var appRoleEnvVars = concat(
  // Consumed ONLY by drizzle/provision-app-role.ts at boot, on the OWNER's
  // connection. Present without TOKENSCOPE_PROVISION_APP_ROLE it does nothing.
  hasAppRoleSecrets ? [
    { name: 'TOKENSCOPE_APP_DB_PASSWORD', secretRef: 'app-db-password' }
  ] : [],
  // The opt-in the boot step gates on. AND-ed with hasAppRoleSecrets because
  // the step needs the password too — 'true' with no password is a no-op that
  // would read as enabled in the template.
  (provisionAppRole && hasAppRoleSecrets) ? [
    { name: 'TOKENSCOPE_PROVISION_APP_ROLE', value: 'true' }
  ] : [],
  // The deliberate rotation. AND-ed with the two above because on its own it is
  // inert — the boot step only reads it while it is provisioning, and only when
  // the role already exists. Meant to be on for ONE boot.
  (rotateAppDbPassword && provisionAppRole && hasAppRoleSecrets) ? [
    { name: 'TOKENSCOPE_ROTATE_APP_DB_PASSWORD', value: 'true' }
  ] : [],
  // The cutover sweep's own opt-in. NOT AND-ed with anything: it runs on the
  // OWNER's DATABASE_URL and needs no Key Vault secret, so narrowing it would
  // only create another flag that reads as enabled and does nothing.
  runRlsCutoverSweep ? [
    { name: 'TOKENSCOPE_RLS_CUTOVER_SWEEP', value: 'true' }
  ] : [],
  // The cutover: the runtime pools (server/db/index.ts, server/db/worker-db.ts)
  // prefer this over DATABASE_URL. Migrations keep the owner URL.
  (useAppRoleAtRuntime && hasAppRoleSecrets) ? [
    { name: 'TOKENSCOPE_APP_DATABASE_URL', secretRef: 'database-url-app' }
  ] : []
)

// Ops alerting channel (§A1). secretRef, never a value (ar-M20 — the topic IS
// the credential; failure logging in the worker records host + status only).
// Absent = the worker reads an empty NUXT_OPS_ALERT_NTFY_URL = alerting off.
var opsAlertEnvVars = hasOpsAlertNtfyUrl ? [
  { name: 'NUXT_OPS_ALERT_NTFY_URL', secretRef: 'ops-alert-ntfy-url' }
] : []

var entraEnvVars = hasEntraClientSecret ? [
  { name: 'NUXT_OIDC_PROVIDERS_ENTRA_CLIENT_SECRET', secretRef: 'entra-client-secret' }
] : []

// nuxt-oidc-auth module's encryption-key env vars. Without these the
// module generates random per-boot values (every revision roll =
// every active session invalidated AND /api/v1/auth/me can't decrypt
// the cookie set by /auth/entra/callback).
var oidcModuleEnvVars = hasOidcModuleSecrets ? [
  { name: 'NUXT_OIDC_SESSION_SECRET', secretRef: 'oidc-session-secret' }
  { name: 'NUXT_OIDC_AUTH_SESSION_SECRET', secretRef: 'oidc-auth-session-secret' }
  { name: 'NUXT_OIDC_TOKEN_KEY', secretRef: 'oidc-token-key' }
] : []
var aiFoundryEnvVars = !empty(aiFoundryEndpoint) ? [
  { name: 'ANTHROPIC_BASE_URL', value: aiFoundryEndpoint }
] : []

// ── Telemetry reader (Path B — Claude → Azure Monitor → Log Analytics) ──
// Emitted only once the DCE/DCR exist (azureMonitorLogsEndpoint non-empty).
// Flips the app to the LogAnalyticsReader + the real MI bearer mint:
//   - NUXT_TELEMETRY_READER=log-analytics → server/azure/reader.ts queries the
//     LAW via @azure/monitor-query (MI auth) instead of the local collector.
//   - NUXT_AZURE_MONITOR_AUTH=mi → server/auth/obo.ts mints the Azure Monitor
//     bearer via the user-assigned MI over IMDS (the real path; no static/mock).
//   - NUXT_AZURE_MONITOR_LOGS_ENDPOINT is the DCR logs URL the attest endpoint
//     hands the plugin as OTEL_EXPORTER_OTLP_LOGS_ENDPOINT.
var telemetryReaderEnvVars = !empty(azureMonitorLogsEndpoint) ? [
  { name: 'NUXT_TELEMETRY_READER', value: 'log-analytics' }
  { name: 'NUXT_LOG_ANALYTICS_WORKSPACE_ID', value: logAnalyticsCustomerId }
  { name: 'NUXT_AZURE_MI_CLIENT_ID', value: identityClientId }
  { name: 'NUXT_AZURE_MONITOR_AUTH', value: 'mi' }
  { name: 'NUXT_AZURE_MONITOR_LOGS_ENDPOINT', value: azureMonitorLogsEndpoint }
  // The ingest-coverage metrics probe (PR #319). Empty until the DCR id is
  // threaded through → probe reads unknown → stall alerts on the bearer gate.
  { name: 'NUXT_AZURE_DCR_RESOURCE_ID', value: dcrResourceId }
  // The workspace's daily cap, from the value that sets it (monitoring.bicep),
  // for the telemetry-cap ops alert. '0' reads as no cap known (indeterminate).
  { name: 'TELEMETRY_DAILY_CAP_GB', value: string(telemetryDailyCapGb) }
] : []

// ── Container App ──────────────────────────────────────────────────

resource containerApp 'Microsoft.App/containerApps@2024-03-01' = {
  name: 'ca-${name}'
  location: location
  tags: tags
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${identityId}': {}
    }
  }
  properties: {
    managedEnvironmentId: containerAppEnv.id
    workloadProfileName: 'Consumption'
    configuration: {
      ingress: {
        external: true
        targetPort: 3000
        transport: 'auto'
        allowInsecure: false
      }
      registries: [
        {
          server: acrLoginServer
          identity: identityId
        }
      ]
      secrets: allSecrets
    }
    template: {
      containers: [
        {
          name: 'tokenscope'
          image: '${acrLoginServer}/tokenscope:${imageTag}'
          resources: {
            cpu: json(appCpu ?? (environment == 'production' ? '1.0' : '0.5'))
            memory: appMemory ?? (environment == 'production' ? '2Gi' : '1Gi')
          }
          env: concat(baseEnvVars, anthropicEnvVars, githubPatEnvVars, githubAppKeyEnvVars, appRoleEnvVars, opsAlertEnvVars, entraEnvVars, oidcModuleEnvVars, aiFoundryEnvVars, gitCommitShaEnvVars, telemetryReaderEnvVars)
          probes: [
            // Startup probe: gives the Nuxt server time to bind and run
            // any first-touch DB / Redis warmups. 5s initial delay +
            // 44 × 5s = 225s startup window.
            //
            // WIDENED FROM 125s, because the RLS enablement added bounded boot
            // steps in front of Nitro and they are SERIAL. Worst case, in
            // order: pre-flight (30s) + provisioning (30s, plus its exit-3
            // credential classifier's 10s connect + 10s statement, which only
            // runs once that deadline has fired) + the cutover sweep (30s) +
            // the binding gate (25s, covering three serial round trips
            // including a second connection) + 15s of client teardown that
            // runs after each step's own deadline is cleared. ~150s of
            // legitimately-bounded work before the server binds at all — so
            // against the old 125s window a slow but perfectly healthy estate
            // could be SIGKILLed with every individual bound behaving exactly
            // as designed, and the symptom would read as a startup-probe
            // failure rather than as whichever step was slow.
            //
            // THE COST, STATED: a genuinely hung boot now takes 225s rather
            // than 125s to fail, on every deploy including ones with no RLS
            // involvement. That is the price of the steps being bounded and
            // serial, and it is paid in the failure path only.
            //
            // This number has been wrong twice — once by omitting the gate
            // entirely and once by omitting teardown — so it is no longer
            // maintained by hand: `provision-app-role-contract.test.ts`
            // derives every term from its own source, adds the teardown, and
            // requires 60s of headroom for Nitro's own launch.
            {
              type: 'Startup'
              httpGet: {
                path: '/api/health'
                port: 3000
              }
              initialDelaySeconds: 5
              periodSeconds: 5
              failureThreshold: 44
              timeoutSeconds: 5
            }
            // Liveness probe: process-only check; MUST NOT touch deps.
            // A transient PG/Redis blip into liveness would loop-restart.
            // `?probe=live` answers without the DB (server/api/health.get.ts);
            // Startup and Readiness keep the DB check on the bare path.
            {
              type: 'Liveness'
              httpGet: {
                path: '/api/health?probe=live'
                port: 3000
              }
              periodSeconds: 30
              failureThreshold: 3
              timeoutSeconds: 5
            }
            {
              type: 'Readiness'
              httpGet: {
                path: '/api/health'
                port: 3000
              }
              initialDelaySeconds: 5
              periodSeconds: 10
              failureThreshold: 3
              timeoutSeconds: 5
            }
          ]
        }
      ]
      scale: {
        minReplicas: 1
        maxReplicas: environment == 'production' ? 5 : 3
      }
    }
  }
}

@description('Container App FQDN (e.g. ca-tokenscope-sandbox-aue.greenfield-xxx.australiaeast.azurecontainerapps.io).')
output fqdn string = containerApp.properties.configuration.ingress.fqdn

@description('Container App resource name.')
output appName string = containerApp.name

@description('Container App resource ID — the scope target for the ops-alerts module\'s Replicas metric alert (ops-alerting.md ar-H7).')
output appId string = containerApp.id

@description('Container App Environment resource ID (for future co-deployed apps in the same env).')
output environmentId string = containerAppEnv.id

@description('ACA environment default domain (e.g. happyhill-0a1b2c3d.westus3.azurecontainerapps.io). For an INTERNAL env this is the private DNS zone name that must exist in your private DNS, with A records pointing at the staticIp output.')
output defaultDomain string = containerAppEnv.properties.defaultDomain

@description('ACA environment static IP. Internal env → the private VIP on snet-container-apps that the private DNS A records must point at. External env → the public inbound IP.')
output staticIp string = containerAppEnv.properties.staticIp

@description('Latest revision name — handy for rollback wiring in deploy workflows.')
output revisionName string = containerApp.properties.latestRevisionName
