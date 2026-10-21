// ── PostgreSQL Flexible Server ─────────────────────────────────────
//
// TokenScope schema requires `btree_gist`, `ltree`, `pgcrypto`. The allow-listed extensions are configured
// via the `azure.extensions` server param; the Drizzle migrations issue
// `CREATE EXTENSION` once they're allow-listed.

@description('Resource name suffix (e.g. tokenscope-sandbox-aue).')
param name string

@description('Azure region.')
param location string

@description('Environment name (drives SKU + HA shape).')
@allowed(['sandbox', 'dev', 'demo', 'staging', 'production'])
param environment string

@description('Administrator login.')
@secure()
param adminLogin string

@description('Administrator password.')
@secure()
param adminPassword string

// ── Private Endpoint params (off in the sandbox posture) ──────────────

@description('Enable private endpoint.')
param enablePrivateEndpoint bool = false

@description('Subnet ID for the private endpoint NIC.')
param privateEndpointSubnetId string = ''

@description('Private DNS zone ID for `privatelink.postgres.database.azure.com`.')
param privateDnsZoneId string = ''

@description('Log Analytics workspace resource ID for diagnostic settings. Empty = no diagnostic settings (PG audit logs disappear). Set to monitoring.outputs.logAnalyticsId for production-shape retention. Note PG audit logs ALSO require the server parameter `log_min_messages` set to `WARNING` or lower; the diagnostic settings only export what PG produces.')
param logAnalyticsId string = ''

@description('Tags applied to every resource.')
param tags object = {}

// Non-production = burstable B2s; production = D2ds_v4 with geo-redundant
// backup + ZoneRedundant HA.
//
// STORAGE IOPS, NOT THE COMPUTE TIER, is what bounds this workload. Measured:
// a /me/usage request spent 17.3 s of summed statement time across
// 44 statements while CPU sat at 23% and burst credits never left their
// maximum — the 32 GB disk's 120 IOPS was the ceiling, and it was exceeded.
// So the disk carries a PERFORMANCE TIER above its size band (see
// storageTier), and the SKU stays Burstable, which is the tier Azure
// designates for dev and which the credit metric shows is not the constraint.
// B2s tops out at 1280 IOPS, so P15's ~1100 fits under it without waste.
var skuName = environment == 'production' ? 'Standard_D2ds_v4' : 'Standard_B2s'
var skuTier = environment == 'production' ? 'GeneralPurpose' : 'Burstable'
var storageSizeGB = environment == 'production' ? 128 : 64
// Performance tier: bills the IOPS of a larger disk without provisioning its
// size. Empty on production, whose 128 GB band already exceeds what dev needs.
var storageTier = environment == 'production' ? null : 'P15'

// PG flex server name max 63 chars; defensive truncation in case a
// future projectName change pushes the suffix past that limit.
var pgServerName = take('pg-${name}', 63)

resource postgresql 'Microsoft.DBforPostgreSQL/flexibleServers@2024-08-01' = {
  name: pgServerName
  location: location
  tags: tags
  sku: {
    name: skuName
    tier: skuTier
  }
  properties: {
    version: '16'
    administratorLogin: adminLogin
    administratorLoginPassword: adminPassword
    storage: union(
      { storageSizeGB: storageSizeGB },
      storageTier == null ? {} : { tier: storageTier }
    )
    backup: {
      backupRetentionDays: environment == 'production' ? 35 : 7
      geoRedundantBackup: environment == 'production' ? 'Enabled' : 'Disabled'
    }
    highAvailability: {
      mode: environment == 'production' ? 'ZoneRedundant' : 'Disabled'
    }
    // network: {} when public; `publicNetworkAccess: Disabled` when PE on.
    // Empty object {} is the documented Bicep idiom for "no networking
    // overrides".
    network: enablePrivateEndpoint ? {
      publicNetworkAccess: 'Disabled'
    } : {}
  }
}

// ── Extensions allow-list ───────────────────────────────────────────
// `azure.extensions` is a dynamic param — no server restart required.
// This allow-lists; migrations issue `CREATE EXTENSION` to materialise.

resource allowedExtensions 'Microsoft.DBforPostgreSQL/flexibleServers/configurations@2024-08-01' = {
  parent: postgresql
  name: 'azure.extensions'
  properties: {
    // PG_STAT_STATEMENTS: allow-listing lets `CREATE EXTENSION` run. That is
    // only half of what the extension needs — the library must ALSO be
    // preloaded (see sharedPreloadLibraries below); allow-listed but not
    // preloaded, every read of the view errors with "must be loaded via
    // shared_preload_libraries". The db-performance probe reports the two
    // states separately for exactly that reason.
    value: 'BTREE_GIST,LTREE,PGCRYPTO,PG_STAT_STATEMENTS'
    source: 'user-override'
  }
}

// ── Performance observability parameters ─────────────────────────────
// Both dynamic — no
// restart. Declarative so a hand-run `az ... parameter set` cannot drift the
// environment; rollback is the same parameter, previous value. Serial
// dependsOn: configuration writes on the same server can conflict when
// deployed concurrently.

@description('log_min_duration_statement in ms — statements slower than this land in the LA-exported PG log. 1000 by default (dr-M9: a lower threshold bursts log volume on a degraded server exactly when it is sickest); tighten per environment deliberately.')
param slowStatementLogMs string = '1000'

// Query Store ONLY off the Burstable tier: Microsoft documents Query Store as
// a performance hazard on Burstable servers — enabling it on Dev's B2s
// could worsen the exact latency it exists to diagnose. On Burstable, the
// slow-statement log below is the per-query instrument; when the SKU is
// bumped, Query Store (with plan capture) lights up on the next deploy.
var queryStoreSupported = skuTier != 'Burstable'

resource queryStoreCapture 'Microsoft.DBforPostgreSQL/flexibleServers/configurations@2024-08-01' = if (queryStoreSupported) {
  parent: postgresql
  name: 'pg_qs.query_capture_mode'
  properties: {
    value: 'top'
    source: 'user-override'
  }
  dependsOn: [allowedExtensions]
}

resource queryStorePlans 'Microsoft.DBforPostgreSQL/flexibleServers/configurations@2024-08-01' = if (queryStoreSupported) {
  parent: postgresql
  name: 'pg_qs.store_query_plans'
  properties: {
    value: 'on'
    source: 'user-override'
  }
  dependsOn: [queryStoreCapture]
}

/*
 * pg_stat_statements records UTILITY statements VERBATIM when track_utility is
 * on (its default). drizzle/provision-app-role.ts issues
 * `ALTER ROLE ... PASSWORD '...'` against this server, so leaving it on would
 * put a live credential into a view any reader of pg_stat_statements can
 * select — an exposure created BY enabling the extension, not one that
 * predates it. Off: the cost is timings for DDL/utility statements, which is
 * not the question the instrument exists to answer.
 */
/*
 * pg_stat_statements.track — Azure defaults this to `none`, and `none` means
 * the extension is installed, readable, and RECORDS NOTHING.
 *
 * That is the third independent knob one extension needs, and each fails
 * differently: the LIBRARY must be preloaded (sharedPreloadLibraries), the
 * extension must be ALLOW-LISTED before CREATE EXTENSION is permitted
 * (azure.extensions), and collection must be TURNED ON here. Missing the first
 * errors on read, the second refuses creation with SQLSTATE 0A000, and the
 * third is silent — an empty table that reads as "nothing is slow".
 *
 * `top` rather than `all`: `all` also tracks statements nested inside
 * functions, which costs more and answers a question this estate is not asking.
 */
resource statStatementsTrack 'Microsoft.DBforPostgreSQL/flexibleServers/configurations@2024-08-01' = {
  parent: postgresql
  name: 'pg_stat_statements.track'
  properties: {
    value: 'top'
    source: 'user-override'
  }
  // Serial chain: the server accepts one write at a time and refuses a
  // concurrent one with ServerIsBusy, so every server-level write follows the
  // previous: extensions → Query Store → slow log → pg_stat_statements →
  // preload → max_connections → database → firewall.
  dependsOn: [slowStatementLog]
}

resource statStatementsUtility 'Microsoft.DBforPostgreSQL/flexibleServers/configurations@2024-08-01' = {
  parent: postgresql
  name: 'pg_stat_statements.track_utility'
  properties: {
    value: 'off'
    source: 'user-override'
  }
  dependsOn: [statStatementsTrack]
}

resource slowStatementLog 'Microsoft.DBforPostgreSQL/flexibleServers/configurations@2024-08-01' = {
  parent: postgresql
  name: 'log_min_duration_statement'
  properties: {
    value: slowStatementLogMs
    source: 'user-override'
  }
  // After the Query Store pair, and after allowedExtensions directly: on
  // Burstable the pair is condition-false, and ARM starts a resource whose
  // dependency is skipped at once, so without it this write races the
  // extensions write. See the chain note on statStatementsTrack.
  dependsOn: [queryStorePlans, allowedExtensions]
}

// ── shared_preload_libraries — pg_stat_statements ────────────────────────────
//
// ⚠ THIS PARAMETER REQUIRES A SERVER RESTART TO TAKE EFFECT. ⚠
// Unlike every other parameter in this file, `shared_preload_libraries` is
// STATIC: the deployment writes the value and the server keeps running on the
// OLD one until it is restarted (portal → Restart, or
// `az postgres flexible-server restart -g <rg> -n <server>`). Until then
// `pg_settings.pending_restart` is true for this row and the extension is still
// not loaded. The db-performance probe surfaces both facts
// (GET /api/v1/admin/diagnostics/db-performance → `settings[].pendingRestart`
// and `statements.extension.preloaded`), so "applied but not in force" is
// visible in Admin instead of being inferred from silence.
//
// The value REPLACES the server's list wholesale — every library the server
// needs must appear here, which is why Azure's own default entry `pg_cron` is
// carried through rather than dropped. Rollback is this parameter, previous
// value, plus a restart.
//
// Why declare it at all: `pg_stat_statements` is the ONLY per-statement
// instrument that works on Burstable (Query Store is deliberately off there —
// see above), and it is what makes GET /admin/diagnostics/db-performance able
// to answer "which statement spends the time" rather than "the database is
// busy". Declaring it means the good configuration is the deployed default
// rather than a portal click someone has to remember.
/*
 * shared_preload_libraries is STATIC (a change needs a server RESTART) and
 * REPLACES THE WHOLE LIST — a shorter value is destructive, not additive.
 *
 * THEREFORE AN UNMEASURED ENVIRONMENT IS NOT MANAGED. Empty means "leave the
 * server's list alone": only a list someone has read off the live server may be
 * written back to it. A default applied everywhere would export one
 * environment's list onto the others and drop whatever they carry that it does
 * not — the same destructive-replacement bug this block exists to prevent, one
 * tier up. `infra/main.bicep` passes nothing today, so the module default IS
 * the value every environment gets.
 *
 * Rollback is this parameter, the previous value, plus a restart. Drift is
 * visible in Admin: the db-performance probe reports the live value.
 */
@description('shared_preload_libraries. STATIC — a change requires a server RESTART. Replaces the whole list, so it must name every USER-settable library the server needs. Empty leaves the setting unmanaged — except dev, which applies devPreloadLibraries below.')
param sharedPreloadLibraries string = ''

// ONLY the USER-settable libraries the app needs. Azure auto-injects and manages
// its own preload libraries (azure, pg_qs, pgaadauth for Entra auth, pgms_stats,
// pgms_wait_sampling, pg_availability): they appear in the effective read-out but
// are not in `allowedValues` and cannot be set here. #297 wrote that full
// effective list back, so every Dev infra apply since failed with
// ServerParameterToCMSUnAllowedParameterValue — the six are auto-managed, not
// dropped by a shorter value.
var devPreloadLibraries = 'pg_cron,pg_stat_statements'
var effectivePreloadLibraries = !empty(sharedPreloadLibraries)
  ? sharedPreloadLibraries
  : (environment == 'dev' || environment == 'demo' ? devPreloadLibraries : '')

resource preloadLibraries 'Microsoft.DBforPostgreSQL/flexibleServers/configurations@2024-08-01' = if (!empty(effectivePreloadLibraries)) {
  parent: postgresql
  name: 'shared_preload_libraries'
  properties: {
    value: effectivePreloadLibraries
    source: 'user-override'
  }
  // Same serial chain as the parameters above.
  dependsOn: [statStatementsUtility]
}

// ── max_connections ─────────────────────────────────────────────────────────
//
// ⚠ STATIC, like shared_preload_libraries: the apply writes the value, and the
// server keeps running on the old one until it is RESTARTED (see that block for
// how; the db-performance probe shows `pendingRestart` for this row until then). ⚠
//
// Same rule as the preload list above: AN UNMEASURED ENVIRONMENT IS NOT
// MANAGED. Azure's default is a function of the SKU's memory and changes with
// the SKU, so 0 (the default) emits nothing and leaves the server's value
// alone. An environment that sets it has read its live value and sized it
// against the app's pools; tests/unit/infra/postgres-connection-budget.test.ts
// checks maxReplicas × (request + worker + dispatch-lock pool) + 15 reserved
// fits under it for every parameter file that sets it.
@description('max_connections. 0 (default) = unmanaged: the server keeps its own value. STATIC — a change takes effect only after a server restart. Set it only after reading the live value, and keep it at or above maxReplicas × (request pool + worker pool + dispatch-lock pool) + 15.')
@minValue(0)
@maxValue(5000)
param maxConnections int = 0

resource maxConnectionsSetting 'Microsoft.DBforPostgreSQL/flexibleServers/configurations@2024-08-01' = if (maxConnections > 0) {
  parent: postgresql
  name: 'max_connections'
  properties: {
    value: string(maxConnections)
    source: 'user-override'
  }
  // preloadLibraries can be condition-false, and a skipped dependency does not
  // serialise, so the last unconditional write is named too.
  dependsOn: [preloadLibraries, statStatementsUtility]
}

// ── Database ────────────────────────────────────────────────────────

resource database 'Microsoft.DBforPostgreSQL/flexibleServers/databases@2024-08-01' = {
  parent: postgresql
  name: 'tokenscope'
  properties: {
    charset: 'UTF8'
    collation: 'en_US.utf8'
  }
  dependsOn: [maxConnectionsSetting, preloadLibraries, statStatementsUtility]
}

// Allow Azure-services traffic when NOT using a private endpoint — this is
// what lets the Container App connect to PG over the Azure backbone in
// sandbox + staging. The `0.0.0.0` start/end pair is Azure's documented
// idiom for the AllowAllAzureServicesAndResourcesWithinAzureIps switch.
resource firewallAllowAzure 'Microsoft.DBforPostgreSQL/flexibleServers/firewallRules@2024-08-01' = if (!enablePrivateEndpoint) {
  parent: postgresql
  name: 'AllowAzureServices'
  properties: {
    startIpAddress: '0.0.0.0'
    endIpAddress: '0.0.0.0'
  }
  dependsOn: [database]
}

// ── Private Endpoint ─────────────────────────────────────────────────

resource privateEndpoint 'Microsoft.Network/privateEndpoints@2024-01-01' = if (enablePrivateEndpoint) {
  name: 'pe-pg-${name}'
  location: location
  tags: tags
  // Its connection is a write on the server too: last in the serial chain.
  dependsOn: [database]
  properties: {
    subnet: {
      id: privateEndpointSubnetId
    }
    privateLinkServiceConnections: [
      {
        name: 'pe-pg-${name}'
        properties: {
          privateLinkServiceId: postgresql.id
          groupIds: [
            'postgresqlServer'
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
        name: 'postgresql'
        properties: {
          privateDnsZoneId: privateDnsZoneId
        }
      }
    ]
  }
}

// ── Diagnostic Settings ────────────────────────────────────────────
// Routes PG diagnostics to LAW. PG flex server emits log categories:
// PostgreSQLLogs, PostgreSQLFlexSessions, PostgreSQLFlexQueryStoreRuntime,
// PostgreSQLFlexQueryStoreWaitStats. `allLogs` exports them all.

resource pgDiagnostics 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = if (!empty(logAnalyticsId)) {
  name: 'diag-${pgServerName}'
  scope: postgresql
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

@description('Server fully qualified domain name.')
output serverFqdn string = postgresql.properties.fullyQualifiedDomainName

@description('Server resource name.')
output serverName string = postgresql.name

@description('Server resource ID — the scope target for the ops-alerts module\'s is_db_alive metric alert (ops-alerting.md ar-H3).')
output serverId string = postgresql.id
