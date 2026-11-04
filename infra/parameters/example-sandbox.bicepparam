// ── TokenScope — Sandbox example parameters ──────────────────────────────
//
// Public endpoints, no VNet, no private endpoints; Front Door optional. Fast to
// stand up for a pilot. Walkthrough: docs/DEPLOY-AZURE.md §Sandbox.
//
// Secrets are read from environment variables at apply time (below).

using '../main.bicep'

param env = 'sandbox'
param location = 'australiaeast'   // your Azure region
// CHANGE THIS. Key Vault, ACR, Postgres and Redis names derive from
// projectName-env-region and must be globally unique; the default is taken.
param projectName = 'tokenscope'
param imageTag = 'latest'

// Grants the app's managed identity AcrPull, Key Vault Secrets User and the
// monitoring roles. Needs Owner (or User Access Administrator) on the resource
// group. Without it the app cannot pull its image or read its secrets.
param deployRbac = true

// ── Secrets: read from the environment, never written here ───────────────
// Source your secrets file first (docs/DEPLOY-AZURE.md §Secrets). A missing
// required variable stops the apply with an error naming it.
param pgAdminLogin = readEnvironmentVariable('PG_ADMIN_LOGIN')
param pgAdminPassword = readEnvironmentVariable('PG_ADMIN_PASSWORD')
param sessionSecret = readEnvironmentVariable('SESSION_SECRET')
param hmacSessionKey = readEnvironmentVariable('HMAC_SESSION_KEY')
param internalWorkerHmacKey = readEnvironmentVariable('INTERNAL_WORKER_HMAC_KEY')
param oidcSessionSecret = readEnvironmentVariable('OIDC_SESSION_SECRET')
param oidcAuthSessionSecret = readEnvironmentVariable('OIDC_AUTH_SESSION_SECRET')
param oidcTokenKey = readEnvironmentVariable('OIDC_TOKEN_KEY')
param entraIdClientSecret = readEnvironmentVariable('ENTRA_CLIENT_SECRET')
// Optional provider credentials: empty = not configured.
param anthropicApiKey = readEnvironmentVariable('ANTHROPIC_API_KEY', '')
// GitHub: up to three PATs and one GitHub App key. Register each GitHub
// enterprise in Admin, Reconciliation under its slot's credential name:
// GH_PAT_1 and GH_APP_KEY_1 -> github-1, GH_PAT_2 -> github-2, GH_PAT_3 -> github-3.
param githubPat1 = readEnvironmentVariable('GH_PAT_1', '')
param githubPat2 = readEnvironmentVariable('GH_PAT_2', '')
param githubPat3 = readEnvironmentVariable('GH_PAT_3', '')
param githubAppKey1 = readEnvironmentVariable('GH_APP_KEY_1', '')
// DEPRECATED: the earlier, named GitHub secrets (and their GITHUB_* spelling).
// Still read for now so a deployment that set them keeps reconciling under its
// old credential names; CHANGELOG.md says how to move to the slots above and
// when these stop being read.
param githubPatPartnerDemo = readEnvironmentVariable('GH_PAT_PARTNER_DEMO', readEnvironmentVariable('GITHUB_PAT_PARTNER_DEMO', ''))
param githubPatProduction = readEnvironmentVariable('GH_PAT_PRODUCTION', readEnvironmentVariable('GITHUB_PAT_PRODUCTION', ''))
param githubPatApacNfr = readEnvironmentVariable('GH_PAT_ENTERPRISE_NFR', readEnvironmentVariable('GITHUB_PAT_APAC_NFR', ''))
param githubAppKeyPartnerDemo = readEnvironmentVariable('GH_APP_KEY_PARTNER_DEMO', readEnvironmentVariable('GITHUB_APP_KEY_PARTNER_DEMO', ''))

// ── Auth (Entra ID OIDC) ─────────────────────────────────────────────────
// Deployed images have no dev-mode sign-in: until these are set, nobody can
// sign in. The redirect URI is known only after the first apply (step 5 of
// the walkthrough): https://<public-host>/auth/entra/callback.
param entraIdTenantId = ''
param entraIdClientId = ''
param entraIdRedirectUri = ''

// The app's public origin. Without Front Door it must be pinned, or the app
// refuses to hand developer devices an enrolment (it will not vouch for a Host
// header it cannot verify). Set after the first apply: https://<containerAppUrl>.
param appPublicOrigin = ''

// First Entra sign-in with this email is created as platform-admin.
param bootstrapAdminEmail = ''

// Demo-persona impersonation for admins. Needs the demo personas, which only
// the local seed (npm run db:seed) creates; a deployed sandbox has none.
param allowPersonaOverride = false

// ── Scheduled workers ────────────────────────────────────────────────────
// Empty = no worker jobs, so telemetry is never joined and dashboards stay at
// $0. Set after the first apply:
//   no Front Door:     https://<containerAppUrl output>
//   Front Door (ph.3): https://<frontDoorEndpointFqdn output>
param workerBaseUrl = ''

// ── Networking / Front Door ──────────────────────────────────────────────
param enablePrivateNetworking = false   // public endpoints, RBAC + firewall
param enableFrontDoor = false           // three-phase apply, docs/DEPLOY-AZURE.md
// param frontDoorSku = 'Standard'      // 'Premium' adds the managed WAF rule sets
// param frontDoorId = ''               // phase 3: the frontDoorInstanceId output

// ── Optional ─────────────────────────────────────────────────────────────
// Azure Monitor Workspace needs the Microsoft.Monitor resource provider;
// set false if your subscription cannot register it.
// param deployAzureMonitorWorkspace = false
// param alertNotificationEmail = 'ops@example.com'
// param anthropicApiEndpoint = 'https://api.anthropic.com'   // with ANTHROPIC_API_KEY set

param keyVaultCreateMode = 'default'    // 'recover' to redeploy within KV soft-delete
