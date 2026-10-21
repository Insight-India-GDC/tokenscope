// ── Azure Cache for Redis ──────────────────────────────────────────
//
// BullMQ broker. Basic SKU in sandbox; Standard when private endpoint is
// on (Basic doesn't support PE).
//
// `primaryKey` is emitted as a @secure() output and consumed by
// keyvault-secrets.bicep to construct the redis-url. ARM deployment
// outputs are NOT logged for @secure() values, so this stays out of
// activity logs as long as the consumer doesn't unwrap it into a
// non-secure context (we don't).

@description('Resource name suffix (e.g. tokenscope-sandbox-aue).')
param name string

@description('Azure region.')
param location string

@description('Environment name (drives SKU + capacity).')
@allowed(['sandbox', 'dev', 'demo', 'staging', 'production'])
param environment string

// ── Private Endpoint params (off in the sandbox posture) ──────────────

@description('Enable private endpoint.')
param enablePrivateEndpoint bool = false

@description('Subnet ID for the private endpoint NIC.')
param privateEndpointSubnetId string = ''

@description('Private DNS zone ID for `privatelink.redis.cache.windows.net`.')
param privateDnsZoneId string = ''

@description('Tags applied to every resource.')
param tags object = {}

// Basic SKU does NOT support private endpoints — promote to Standard
// when PE is enabled. Production also gets Standard; sandbox stays
// Basic C0 (the cheapest tier).
var skuName = enablePrivateEndpoint ? 'Standard' : (environment == 'production' ? 'Standard' : 'Basic')
var capacity = environment == 'production' ? 1 : (enablePrivateEndpoint ? 1 : 0)

resource redis 'Microsoft.Cache/redis@2024-11-01' = {
  name: 'redis-${name}'
  location: location
  tags: tags
  properties: {
    sku: {
      name: skuName
      family: 'C'
      capacity: capacity
    }
    enableNonSslPort: false
    minimumTlsVersion: '1.2'
    publicNetworkAccess: enablePrivateEndpoint ? 'Disabled' : 'Enabled'
    redisConfiguration: {
      // BullMQ requires noeviction; without it, queue entries can be
      // dropped under memory pressure, producing silent job loss.
      'maxmemory-policy': 'noeviction'
    }
  }
}

// ── Private Endpoint ─────────────────────────────────────────────────

resource privateEndpoint 'Microsoft.Network/privateEndpoints@2024-01-01' = if (enablePrivateEndpoint) {
  name: 'pe-redis-${name}'
  location: location
  tags: tags
  properties: {
    subnet: {
      id: privateEndpointSubnetId
    }
    privateLinkServiceConnections: [
      {
        name: 'pe-redis-${name}'
        properties: {
          privateLinkServiceId: redis.id
          groupIds: [
            'redisCache'
          ]
        }
      }
    ]
  }
}

// Zone group only when a zone ID was supplied — '' means the zone owner
// registers the A record (see key-vault.bicep for the rationale).
resource dnsZoneGroup 'Microsoft.Network/privateEndpoints/privateDnsZoneGroups@2024-01-01' = if (enablePrivateEndpoint && !empty(privateDnsZoneId)) {
  parent: privateEndpoint
  name: 'default'
  properties: {
    privateDnsZoneConfigs: [
      {
        name: 'redis'
        properties: {
          privateDnsZoneId: privateDnsZoneId
        }
      }
    ]
  }
}

@description('Redis host name (non-sensitive).')
output hostName string = redis.properties.hostName

@description('Redis SSL port (non-sensitive; 6380 for Cache for Redis).')
output sslPort int = redis.properties.sslPort

@description('Redis primary access key — treat as secret. Consumed by keyvault-secrets to build redis-url.')
@secure()
output primaryKey string = redis.listKeys().primaryKey
