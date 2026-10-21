// TokenScope — uat (SKU tier 'staging'). Secrets come from the environment.
using '../main.bicep'

param env = 'staging'
param envNameLabel = 'uat'
param projectName = 'tokenscope'
param imageTag = 'latest'
param deployRbac = true

param tags = {
  project: 'tokenscope'
  organisation: readEnvironmentVariable('ORG_NAME')
  environment: 'uat'
  managedBy: 'github-actions'
}

// ── Secrets ─────────────────────────────────────────────────────────────
param pgAdminLogin = readEnvironmentVariable('PG_ADMIN_LOGIN')
param pgAdminPassword = readEnvironmentVariable('PG_ADMIN_PASSWORD')
param sessionSecret = readEnvironmentVariable('SESSION_SECRET')
param hmacSessionKey = readEnvironmentVariable('HMAC_SESSION_KEY')
param internalWorkerHmacKey = readEnvironmentVariable('INTERNAL_WORKER_HMAC_KEY')
param oidcSessionSecret = readEnvironmentVariable('OIDC_SESSION_SECRET')
param oidcAuthSessionSecret = readEnvironmentVariable('OIDC_AUTH_SESSION_SECRET')
param oidcTokenKey = readEnvironmentVariable('OIDC_TOKEN_KEY')
param entraIdClientSecret = readEnvironmentVariable('ENTRA_CLIENT_SECRET', '')

// ── App settings ────────────────────────────────────────────────────────
param appPublicOrigin = readEnvironmentVariable('APP_PUBLIC_ORIGIN', '')
param entraIdTenantId = readEnvironmentVariable('ENTRA_TENANT_ID', '')
param entraIdClientId = readEnvironmentVariable('ENTRA_CLIENT_ID', '')
param entraIdRedirectUri = readEnvironmentVariable('ENTRA_REDIRECT_URI', '')
param bootstrapAdminEmail = readEnvironmentVariable('BOOTSTRAP_ADMIN_EMAIL', '')
param alertNotificationEmail = readEnvironmentVariable('ALERT_NOTIFICATION_EMAIL', '')
param workerBaseUrl = readEnvironmentVariable('WORKER_BASE_URL', '')

// ── Networking ──────────────────────────────────────────────────────────
param enablePrivateNetworking = true
param registerDnsZoneGroups = true
param monitorQueryPrivateOnly = false
param vnetAddressSpace = '10.20.0.0/24'
param containerAppsSubnetPrefix = '10.20.0.0/27'
param privateEndpointsSubnetPrefix = '10.20.0.32/28'
param amplsSubnetPrefix = ''
param buildSubnetPrefix = ''

// ── Front Door ──────────────────────────────────────────────────────────
param enableFrontDoor = true
param frontDoorSku = 'Premium'
param frontDoorWafManagedRuleAction = 'Log'
param frontDoorId = readEnvironmentVariable('FRONT_DOOR_ID', '')
