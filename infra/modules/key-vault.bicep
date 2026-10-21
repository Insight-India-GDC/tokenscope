// ── Key Vault — Secrets Management ────────────────────────────────
//
// RBAC authorization, soft-delete +
// purge-protection always on, optional private endpoint, optional
// Key-Vault-Secrets-User role assignment for the app's user-assigned MI.
//
// Per the hard-constraint contract:
//   • `deployRbac` defaults to false — the role assignment is only
//     emitted when the deploying principal is Owner (SP via OIDC).
//   • `createMode: 'recover'` lets us restore a soft-deleted vault
//     of the same name (sandbox iteration).
//   • `enablePrivateEndpoint` is OFF by default (on with enablePrivateNetworking).

@description('Resource name suffix (e.g. tokenscope-sandbox-aue).')
param name string

@description('Azure region.')
param location string

@description('Environment name — drives soft-delete retention.')
@allowed(['sandbox', 'dev', 'demo', 'staging', 'production'])
param environment string

@description('Set to `recover` to restore a soft-deleted vault with the same name.')
@allowed(['default', 'recover'])
param createMode string = 'default'

// ── RBAC params ────────────────────────────────────────────────────────

@description('Principal ID of the user-assigned managed identity to grant Key Vault Secrets User. Empty means no role assignment is emitted regardless of deployRbac.')
param identityPrincipalId string = ''

@description('Deploy RBAC role assignment (requires Owner/UAA on the deploying principal). Default false for Contributor-safe applies.')
param deployRbac bool = false

// ── Private Endpoint params (off in the sandbox posture) ──────────────

@description('Enable private endpoint for the vault.')
param enablePrivateEndpoint bool = false

@description('Subnet ID for the private endpoint NIC.')
param privateEndpointSubnetId string = ''

@description('Private DNS zone ID for `privatelink.vaultcore.azure.net`.')
param privateDnsZoneId string = ''

@description('Log Analytics workspace resource ID for diagnostic settings. Empty = no diagnostic settings (KV audit logs disappear after KV native retention). Set to monitoring.outputs.logAnalyticsId for production-shape audit retention.')
param logAnalyticsId string = ''

@description('Tags applied to every resource in this module.')
param tags object = {}

// Key Vault names must be 3-24 characters, alphanumeric + hyphen.
// `kv-${nameSuffix}` is 3 + length(nameSuffix); take(24) is defence-in-depth
// against future name suffixes growing past 21 chars.
var kvName = take('kv-${name}', 24)

resource keyVault 'Microsoft.KeyVault/vaults@2024-11-01' = {
  name: kvName
  location: location
  tags: tags
  properties: {
    createMode: createMode
    sku: {
      family: 'A'
      name: 'standard'
    }
    tenantId: subscription().tenantId
    enableRbacAuthorization: true
    enableSoftDelete: true
    softDeleteRetentionInDays: environment == 'production' ? 90 : 7
    // Purge protection is irreversible once enabled. We enable it everywhere
    // so a sandbox vault behaves identically to staging/prod for recovery.
    enablePurgeProtection: true
    networkAcls: enablePrivateEndpoint ? {
      defaultAction: 'Deny'
      bypass: 'AzureServices'
    } : {
      defaultAction: 'Allow'
      bypass: 'AzureServices'
    }
  }
}

// ── Key Vault Secrets User RBAC ────────────────────────────────────────
// Grants the container app's user-assigned MI permission to read secrets
// when ACA resolves the keyVaultUrl-referenced secrets at runtime.
// Skipped when deployRbac=false or no principal supplied.

var kvSecretsUserRoleId = '4633458b-17de-408a-b874-0445c86b69e6'

resource kvSecretsUserRoleAssignment 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (deployRbac && !empty(identityPrincipalId)) {
  name: guid(keyVault.id, identityPrincipalId, kvSecretsUserRoleId)
  scope: keyVault
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', kvSecretsUserRoleId)
    principalId: identityPrincipalId
    principalType: 'ServicePrincipal'
  }
}

// ── Private Endpoint ─────────────────────────────────────────────────

resource privateEndpoint 'Microsoft.Network/privateEndpoints@2024-01-01' = if (enablePrivateEndpoint) {
  name: 'pe-kv-${name}'
  location: location
  tags: tags
  properties: {
    subnet: {
      id: privateEndpointSubnetId
    }
    privateLinkServiceConnections: [
      {
        name: 'pe-kv-${name}'
        properties: {
          privateLinkServiceId: keyVault.id
          groupIds: [
            'vault'
          ]
        }
      }
    ]
  }
}

// Zone group only when a zone ID was supplied. Central-DNS environments
// where the SP has no write rights on the zones pass '' — the PE still
// provisions, and the zone owner registers the A record (the PE's
// customDnsConfigs list the name and IP to register).
resource dnsZoneGroup 'Microsoft.Network/privateEndpoints/privateDnsZoneGroups@2024-01-01' = if (enablePrivateEndpoint && !empty(privateDnsZoneId)) {
  parent: privateEndpoint
  name: 'default'
  properties: {
    privateDnsZoneConfigs: [
      {
        name: 'keyvault'
        properties: {
          privateDnsZoneId: privateDnsZoneId
        }
      }
    ]
  }
}

// ── Diagnostic Settings ────────────────────────────────────────────
// Routes KV audit logs (secret-access, RBAC denies, policy events) to
// Log Analytics. Without this, security-relevant KV events vanish
// shortly after they happen — KV's native retention is brief.

resource keyVaultDiagnostics 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = if (!empty(logAnalyticsId)) {
  name: 'diag-${kvName}'
  scope: keyVault
  properties: {
    workspaceId: logAnalyticsId
    logs: [
      {
        categoryGroup: 'allLogs'
        enabled: true
      }
    ]
    metrics: [
      {
        category: 'AllMetrics'
        enabled: true
      }
    ]
  }
}

@description('Key Vault URI (e.g. https://kv-tokenscope-sandbox-aue.vault.azure.net/).')
output keyVaultUri string = keyVault.properties.vaultUri

@description('Key Vault resource name.')
output keyVaultName string = keyVault.name
