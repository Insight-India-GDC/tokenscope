// ── TokenScope — VNet-integrated example parameters (dev / prod posture) ─
//
// Modelled on the project's own Dev environment, with organisation-specific
// values replaced by placeholders: private endpoints on Key Vault, Postgres,
// Redis and ACR, internal-only Container Apps ingress, and your own WAF /
// reverse proxy as the public entry point. Dev also uses a central team's DNS
// zones and private Log Analytics query; both are variants below.
// Walkthrough: docs/DEPLOY-AZURE.md §VNet-integrated.
//
// Secrets are read from environment variables at apply time (below).

using '../main.bicep'

// 'production': General Purpose Postgres with zone-redundant HA and
// geo-backup, 1 vCPU / 2 GiB replicas (up to 5), 90-day Key Vault retention.
// 'dev' / 'staging': Burstable Postgres, 0.5 vCPU / 1 GiB (up to 3). Only
// 'dev' preloads pg_stat_statements for the query diagnostics.
param env = 'production'
param location = 'westus3'            // your Azure region
param projectName = 'tokenscope'      // CHANGE THIS: names must be globally unique
param imageTag = 'latest'

// Grants the app identity its roles (AcrPull, KV Secrets User, monitoring).
// Needs Owner or User Access Administrator on the resource group.
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

// ── Public entry point: pick ONE ─────────────────────────────────────────
// Ingress is internal. Users reach the app through either
//   (a) your own WAF, App Gateway or reverse proxy (the default below), or
//   (b) Azure Front Door Premium over Private Link (the Front Door section).
// Pin the public origin users see so self-URLs, CSRF, cookies and OAuth
// metadata are right: (a) your hostname, (b) https://<frontDoorEndpointFqdn>.
param appPublicOrigin = 'https://tokenscope.example.com'

// ── Auth (Entra ID OIDC) ─────────────────────────────────────────────────
param entraIdTenantId = ''
param entraIdClientId = ''
param entraIdRedirectUri = 'https://tokenscope.example.com/auth/entra/callback'
param bootstrapAdminEmail = ''        // first sign-in → platform-admin
param allowPersonaOverride = false    // refused outside local/sandbox anyway

// ── Scheduled workers ────────────────────────────────────────────────────
// The address the worker jobs call. Empty = no worker jobs: telemetry is
// never joined, dashboards stay at $0. After the first apply:
//   (a) own WAF: https://<containerAppUrl output>, the INTERNAL address; the
//       jobs run inside the environment and usually cannot reach your WAF.
//   (b) Front Door: https://<frontDoorEndpointFqdn output>. Once frontDoorId
//       is set the app refuses direct calls, and the jobs reach Front Door
//       through the environment's outbound internet access (allow it if you
//       force outbound traffic through a firewall).
param workerBaseUrl = ''

// ── Networking ───────────────────────────────────────────────────────────
param enablePrivateNetworking = true

// Address space from your IPAM. Minimums: Container Apps /27, private
// endpoints /28 (4 PEs + headroom), AMPLS /28 (its endpoint is multi-IP).
param vnetName = ''                   // empty = vnet-<project>-<env>-<region>
param vnetAddressSpace = '10.0.0.0/24'
param containerAppsSubnetPrefix = '10.0.0.0/27'
param privateEndpointsSubnetPrefix = '10.0.0.32/28'
param amplsSubnetPrefix = '10.0.0.48/28'
// Optional build subnet for a private registry: a self-hosted runner or an ACR
// agent pool builds from here (examples/github-actions/README.md). Declare it
// here rather than adding it by hand: the next apply removes unlisted subnets.
param buildSubnetPrefix = ''          // e.g. '10.0.0.64/27'
// Egress and landing-zone controls, attached by the template (anything attached
// to a subnet by hand is cleared on the next apply):
// param natGatewayId = '/subscriptions/<sub>/resourceGroups/<rg>/providers/Microsoft.Network/natGateways/<nat>'
// param subnetRouteTableId = '<route table id>'    // e.g. forced tunnelling to a hub firewall
// param subnetNetworkSecurityGroupId = '<nsg id>'

// Private DNS. Default: the template creates the privatelink zones for Key
// Vault, Postgres, Redis and ACR, links them to the VNet and registers every
// private-endpoint record. Keep true unless a central team owns the zones.
param registerDnsZoneGroups = true

// Log Analytics query over Private Link only. Before turning this on, create
// the Azure Monitor privatelink zones for the AMPLS endpoint (the template
// does not): privatelink.monitor.azure.com, privatelink.oms.opinsights.azure.com,
// privatelink.ods.opinsights.azure.com and privatelink.blob.core.windows.net,
// with the endpoint's records. Turned on without them, the app (and everyone
// else) loses query access to the workspace.
param monitorQueryPrivateOnly = false

// ── Variant: central (hub) private DNS zones ─────────────────────────────
// When a platform team owns the privatelink zones in another subscription,
// point at them. The deploying principal usually cannot write there, so turn
// off zone-group registration and hand the record list to that team. An env
// on central zones also consumes their Azure Monitor Private Link Scope
// (useCentralAmpls defaults on), which that team must join you to.
// param centralDnsZonesSubscriptionId = '<hub-subscription-guid>'
// param centralDnsZonesResourceGroup = '<hub-dns-resource-group>'
// param registerDnsZoneGroups = false

// ── Variant: hub peering ─────────────────────────────────────────────────
// param hubVnetId = '/subscriptions/<sub>/resourceGroups/<rg>/providers/Microsoft.Network/virtualNetworks/<hub>'
// param useRemoteGateways = true     // only if the hub has a gateway + allowGatewayTransit

// ── Front Door ───────────────────────────────────────────────────────────
// Off for option (a). For option (b), Premium only: Standard cannot reach an
// internal environment, and the template refuses that combination. Three
// applies, as in docs/DEPLOY-AZURE.md §Front Door Premium:
//   1. enableFrontDoor = true, frontDoorSku = 'Premium'; then approve Front
//      Door's private endpoint request (infra/scripts/approve-front-door-private-link.sh)
//   2. frontDoorId = '<frontDoorInstanceId output>', and appPublicOrigin,
//      entraIdRedirectUri and workerBaseUrl on the Front Door endpoint
// Premium's managed WAF rules start in Log mode; set
// frontDoorWafManagedRuleAction = 'Block' once the logs are clean.
param enableFrontDoor = false
// param frontDoorSku = 'Premium'
// param frontDoorId = ''
// param frontDoorWafManagedRuleAction = 'Log'

// ── Optional ─────────────────────────────────────────────────────────────
// param deployAzureMonitorWorkspace = false   // if Microsoft.Monitor cannot be registered
// param alertNotificationEmail = 'ops@example.com'
// param anthropicApiEndpoint = 'https://api.anthropic.com'   // with ANTHROPIC_API_KEY set

param keyVaultCreateMode = 'default'
