// ── Container Registry — Azure Container Registry ─────────────────
// Manages the ACR instance used for Container App image storage.
// Admin user disabled — access is via user-assigned MI (AcrPull role
// assigned in main.bicep where the MI's principalId is in scope).
//
// SKU: **Premium when private** (`enablePrivateEndpoint`) — private
// endpoints require Premium. Otherwise Standard (production) / Basic.
// When private, `publicNetworkAccess` is Disabled and a private endpoint
// + `privatelink.azurecr.io` DNS zone group are created; image build/push
// must then originate from inside the VNet (a VNet-injected GitHub runner
// or self-hosted runner reaching the ACR private endpoint). Pull is via
// the user-assigned MI (AcrPull); admin user is always disabled.
//
// AVM note: avm/res/container-registry/registry covers this resource. We
// keep the native resource here because (a) it matches the other native
// modules in infra/modules/, and (b) the AVM module's
// param surface for the RBAC integration with our root-scoped UAI
// requires more wrapping than benefit. Revisit if/when we need
// geo-replication or trust policies.

@description('Resource name suffix (e.g. tokenscope-sandbox-aue).')
param name string

@description('Azure region.')
param location string

@description('Environment name (drives SKU choice).')
@allowed(['sandbox', 'dev', 'demo', 'staging', 'production'])
param environment string

@description('Log Analytics workspace resource ID for diagnostic settings. Empty = no diagnostic settings (ACR pull + login events disappear from observable state). Set to monitoring.outputs.logAnalyticsId for production-shape audit retention.')
param logAnalyticsId string = ''

@description('Put ACR behind a private endpoint (forces Premium SKU + publicNetworkAccess Disabled). Wired from main.bicep `enablePrivateNetworking`.')
param enablePrivateEndpoint bool = false

@description('Private-endpoint subnet resource ID (networking.outputs.privateEndpointSubnetId). Required when enablePrivateEndpoint.')
param privateEndpointSubnetId string = ''

@description('privatelink.azurecr.io private DNS zone resource ID (networking.outputs.dnsZoneAcrId). Required when enablePrivateEndpoint.')
param privateDnsZoneId string = ''

@description('Tags applied to every resource.')
param tags object = {}

// ACR names must be alphanumeric, 5-50 chars. Strip hyphens from the
// suffix and prepend `cr` to match the {kind}-{name} convention while
// satisfying the no-hyphen constraint.
var acrName = replace('cr${name}', '-', '')

// Premium when private (PE requires Premium). Otherwise Standard for
// production (geo-replication-ready); Basic elsewhere.
var skuName = enablePrivateEndpoint ? 'Premium' : (environment == 'production' ? 'Standard' : 'Basic')

resource acr 'Microsoft.ContainerRegistry/registries@2023-07-01' = {
  name: acrName
  location: location
  tags: tags
  sku: {
    name: skuName
  }
  properties: {
    adminUserEnabled: false
    publicNetworkAccess: enablePrivateEndpoint ? 'Disabled' : 'Enabled'
  }
}

// ── Private endpoint (when ACR is private) ──────────────────────────
resource privateEndpoint 'Microsoft.Network/privateEndpoints@2024-01-01' = if (enablePrivateEndpoint) {
  name: 'pe-acr-${name}'
  location: location
  tags: tags
  properties: {
    subnet: {
      id: privateEndpointSubnetId
    }
    privateLinkServiceConnections: [
      {
        name: 'pe-acr-${name}'
        properties: {
          privateLinkServiceId: acr.id
          groupIds: [
            'registry'
          ]
        }
      }
    ]
  }
}

// Zone group only when a zone ID was supplied — '' means the owner of the
// central private DNS zones registers the records (see key-vault.bicep for the rationale).
// NOTE for that path: a Premium/private ACR needs TWO records — the
// registry FQDN and the regional data endpoint
// (<acr>.<region>.data.azurecr.io); both appear in customDnsConfigs.
resource dnsZoneGroup 'Microsoft.Network/privateEndpoints/privateDnsZoneGroups@2024-01-01' = if (enablePrivateEndpoint && !empty(privateDnsZoneId)) {
  parent: privateEndpoint
  name: 'default'
  properties: {
    privateDnsZoneConfigs: [
      {
        name: 'acr'
        properties: {
          privateDnsZoneId: privateDnsZoneId
        }
      }
    ]
  }
}

// ── Diagnostic Settings ────────────────────────────────────────────
// Routes ACR repo + login events to LAW. Without this, image-pull
// audit ("who pulled what when") doesn't retain past ACR's brief
// native window.

resource acrDiagnostics 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = if (!empty(logAnalyticsId)) {
  name: 'diag-${acrName}'
  scope: acr
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

@description('ACR login server FQDN (e.g. crtokenscopesandbox.azurecr.io).')
output loginServer string = acr.properties.loginServer

@description('ACR resource name (no hyphens).')
output name string = acr.name

@description('ACR resource ID.')
output id string = acr.id
