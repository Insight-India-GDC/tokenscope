// ── Monitoring — Log Analytics + App Insights + AMW + alert rules ───
//
// Log Analytics + Application Insights + alert rules, plus the DCE/DCR
// that devices send OTLP logs to directly, and an optional Azure Monitor
// Workspace for OTLP-preview metrics (nothing consumes it today).
//
// Outputs consumed by:
//   - container-app.bicep (AppInsights connection string + LAW
//     customer ID/key for the ACA env's LogAnalytics destination)
//   - main.bicep (AMW ingestion endpoint forwarded to the container
//     app env var NUXT_AZURE_MONITOR_ENDPOINT)
//
// AVM note: avm/res/operational-insights/workspace and
// avm/res/insights/component cover the LAW + AppInsights resources
// individually. We use native resources here to keep the alert-rule wiring + AMW addition in one auditable place.
// Migration to AVM is a follow-up; revisit when the AppInsights AVM
// module supports the WorkspaceResourceId field consistently across
// versions.

@description('Resource name suffix (e.g. tokenscope-sandbox-aue).')
param name string

@description('Azure region.')
param location string

@description('Environment name — drives retention + alert severity defaults.')
@allowed(['sandbox', 'dev', 'demo', 'staging', 'production'])
param environment string

@description('Daily ingestion cap in GB, applied to EACH Log Analytics workspace (cost guard). Per workspace on purpose: a platform-log flood cannot use up the cap that OTel ingestion depends on.')
@minValue(1)
param dailyIngestionCapGb int = 2

@description('Optional notification email for the alert action group. Empty = alerts fire but no email goes out (still visible in Monitor).')
param notificationEmail string = ''

@description('Tags applied to every resource in this module.')
param tags object = {}

@description('Principal ID of the user-assigned MI to grant OTLP-ingest publish + LAW read. Empty = no role assignments regardless of deployRbac.')
param identityPrincipalId string = ''

@description('Gate RBAC role assignments (the OIDC SP applying has Owner, so deployRbac=true is the normal sandbox apply).')
param deployRbac bool = false

@description('Deploy the Azure Monitor Workspace (Prometheus-shape OTLP metrics, preview). NOTHING consumes its outputs today — the token-usage path is LOGS via DCE/DCR. Set FALSE where the Microsoft.Monitor resource provider is not registered in the subscription and the deploying principal cannot register it (the apply would fail with MissingSubscriptionRegistration).')
param deployAzureMonitorWorkspace bool = true

@description('Make the Log Analytics QUERY path private: publicNetworkAccessForQuery=Disabled, so the corpus is queryable ONLY over an Azure Monitor Private Link Scope. INGESTION stays public (clients emit OTLP from outside the zone). Who owns the scope is useCentralAmpls. Default false — the back-out lever. Leave NUXT_AZURE_MONITOR_QUERY_ENDPOINT EMPTY: the reader SDK default api.loganalytics.io resolves over the PE, while api.monitor.azure.com 404s the LA query path. Redeploy the app after any posture change — a running revision caches the pre-change resolution.')
param enableQueryPrivateLink bool = false

@description('PE subnet resource id for the AMPLS private endpoint (from the networking module). Empty = no PE.')
param privateEndpointSubnetId string = ''

@description('A central network team owns the Azure Monitor Private Link Scope: create neither the scope nor its scoped-resource link — the scope owner joins our workspace to theirs. TRUE wherever the privatelink DNS zones are central, because one shared zone holds ONE set of Monitor A records and a second scope PE overwrites the first, blackholing it. ARM is incremental, so flipping this does NOT delete a scope already deployed — remove it by hand.')
param useCentralAmpls bool = false

@description('Resource ID of the central AMPLS to point OUR private endpoint at, for when the central PE is not reachable from our VNet. Read only when useCentralAmpls. Empty (default) = create no PE either and reach the central scope over the scope owner\'s own PE. Two prerequisites: privateEndpointSubnetId must be set (no subnet, no PE — the id is otherwise ignored in silence), and no PE of the same name may already point at a different scope, because privateLinkServiceId is IMMUTABLE — Azure rejects the retarget, so delete that PE first. Cross-subscription: the connection lands Pending until the scope owner approves it.')
param centralAmplsResourceId string = ''

@description('Send the platform\'s OWN logs (Container Apps console/system logs, resource diagnostic settings, log alert rules) to a second workspace, log-ops-<name>, whose query path is public and governed by Entra RBAC. The telemetry workspace keeps the OTel streams the DCR ingests and the Application Insights component that DCR enriches with. Wanted wherever enableQueryPrivateLink is on: query privacy is workspace-wide, so without this the crash logs of the app are readable only by the app.')
param separateOpsWorkspace bool = false

// ── Log Analytics Workspace ─────────────────────────────────────────

resource logAnalytics 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: 'log-${name}'
  location: location
  tags: tags
  properties: {
    sku: {
      name: 'PerGB2018'
    }
    retentionInDays: environment == 'production' ? 90 : 30
    workspaceCapping: {
      dailyQuotaGb: dailyIngestionCapGb
    }
    // INGESTION stays public — developer clients emit OTLP to the DCE from
    // outside the private network. QUERY goes private
    // when enableQueryPrivateLink: only the in-VNet app MI (Log Analytics
    // Reader) can then query, shrinking the exfiltration surface of a stolen
    // Reader credential.
    publicNetworkAccessForIngestion: 'Enabled'
    publicNetworkAccessForQuery: enableQueryPrivateLink ? 'Disabled' : 'Enabled'
  }
}

// ── Ops Log Analytics Workspace (platform logs, human-queryable) ────
// Never joined to an AMPLS: operators query it from the portal under Entra RBAC.

resource opsLogAnalytics 'Microsoft.OperationalInsights/workspaces@2023-09-01' = if (separateOpsWorkspace) {
  name: 'log-ops-${name}'
  location: location
  tags: tags
  properties: {
    sku: {
      name: 'PerGB2018'
    }
    retentionInDays: environment == 'production' ? 90 : 30
    workspaceCapping: {
      dailyQuotaGb: dailyIngestionCapGb
    }
    publicNetworkAccessForIngestion: 'Enabled'
    publicNetworkAccessForQuery: 'Enabled'
  }
}

var opsWorkspaceId = separateOpsWorkspace ? opsLogAnalytics!.id : logAnalytics.id

// ── Azure Monitor Private Link Scope (private QUERY, public INGEST) ──
// ingestionAccessMode=Open keeps the DCE/ingest path public; queryAccessMode=
// PrivateOnly forces scoped-resource queries through an AMPLS private endpoint.
// Scoped resource = the Log Analytics workspace (what the read-joiner queries).
// We deploy a scope ONLY where we own one (useCentralAmpls=false); the PE
// carries no DNS zone group, so the A records in the Azure Monitor privatelink
// zones must be registered by whoever owns those zones.

resource ampls 'Microsoft.Insights/privateLinkScopes@2021-07-01-preview' = if (enableQueryPrivateLink && !useCentralAmpls) {
  name: 'ampls-${name}'
  location: 'global'
  tags: tags
  properties: {
    accessModeSettings: {
      ingestionAccessMode: 'Open'
      queryAccessMode: 'PrivateOnly'
    }
  }
}

resource amplsScopedLaw 'Microsoft.Insights/privateLinkScopes/scopedResources@2021-07-01-preview' = if (enableQueryPrivateLink && !useCentralAmpls) {
  parent: ampls
  name: 'scoped-law'
  properties: {
    linkedResourceId: logAnalytics.id
  }
}

// Our own PE: always when we own the scope, and on a central scope only when
// the scope owner's PE cannot serve our VNet (centralAmplsResourceId set).
var deployAmplsPrivateEndpoint = enableQueryPrivateLink && !empty(privateEndpointSubnetId) && (!useCentralAmpls || !empty(centralAmplsResourceId))

resource amplsPrivateEndpoint 'Microsoft.Network/privateEndpoints@2024-01-01' = if (deployAmplsPrivateEndpoint) {
  name: 'pe-ampls-${name}'
  location: location
  tags: tags
  properties: {
    subnet: {
      id: privateEndpointSubnetId
    }
    privateLinkServiceConnections: [
      {
        name: 'pe-ampls-${name}'
        properties: {
          privateLinkServiceId: useCentralAmpls ? centralAmplsResourceId : ampls!.id
          groupIds: [
            'azuremonitor'
          ]
        }
      }
    ]
  }
}

// ── Application Insights ────────────────────────────────────────────

resource appInsights 'Microsoft.Insights/components@2020-02-02' = {
  name: 'appi-${name}'
  location: location
  tags: tags
  kind: 'web'
  properties: {
    Application_Type: 'web'
    // Telemetry workspace even when split: the OTLP DCR enriches its streams
    // with this component.
    WorkspaceResourceId: logAnalytics.id
    SamplingPercentage: 100
  }
}

// ── Azure Monitor Workspace (OTLP-preview metric ingestion) ─────────
// Preview target for Prometheus-shape metrics. Not used by the app, and
// nothing emits here today: token usage travels as LOGS via the DCE/DCR.

resource azureMonitorWorkspace 'Microsoft.Monitor/accounts@2023-04-03' = if (deployAzureMonitorWorkspace) {
  name: 'amw-${name}'
  location: location
  tags: tags
}

// ── OTLP ingestion (preview): DCE + DCR + MI RBAC ───────────────────
// Devices post OTLP/HTTP DIRECT to the DCE with an
// Entra bearer the TokenScope app mints via its MI (server/auth/obo.ts,
// audience https://monitor.azure.com/.default). The app's MI needs
// `Monitoring Metrics Publisher` to write and `Log Analytics Reader` to
// run the read-joiner's KQL.
//
// Verified against a live deployment:
//   (a) Wiring is DCE + DCR + stream. The OTLP ingest URL is
//         https://<logs-dce-domain>/dataCollectionRules/<dcrImmutableId>/streams/Microsoft-OTLP-Logs/otlp/v1/logs
//       where Microsoft-OTLP-Logs is a SERVICE-MANAGED built-in stream (the
//       DCR needs no streamDeclarations for it). Events land in OTelLogs.
//   (b) The POST needs: Authorization: Bearer <monitor.azure.com/.default
//       token>, Content-Type: application/x-protobuf (JSON → HTTP 415), and
//       an explicit Content-Length (chunked → HTTP 400 MissingContentLengthHeader).
//       Our injected resource attrs land in OTelLogs.ResourceAttributes and
//       per-event token fields in OTelLogs.Attributes (see server/azure/reader.ts).

resource dataCollectionEndpoint 'Microsoft.Insights/dataCollectionEndpoints@2023-03-11' = {
  name: 'dce-${name}'
  location: location
  tags: tags
  properties: {
    networkAcls: {
      publicNetworkAccess: 'Enabled'
    }
  }
}

// Verified against a live DCR: direct OTLP ingestion to the DCE is only accepted when the DCR
// declares `directDataSources.otelLogs` (the "sent directly with OTel Collector"
// path per Microsoft's OTLP-ingestion doc). A plain logs DCR (dataFlows only)
// returns HTTP 400 InvalidStream for POSTs to .../streams/Microsoft-OTLP-Logs/....
// We add the
// `dataSources` + `directDataSources` + `references` sections the doc requires,
// at api-version 2024-03-11 (the version that expresses `directDataSources`).
//
// Logs + traces only: `otelMetrics` is intentionally omitted because it must
// route to an Azure Monitor Workspace `monitoringAccounts` destination, and envs
// with `deployAzureMonitorWorkspace = false` have none — including it would fail
// the apply. Token usage is logs.
//
// Stream-name note: the direct-OTLP ingest URL uses the service-managed
// 'Microsoft-OTLP-Logs' segment, while the DCR-internal stream id (in
// dataSources/directDataSources/dataFlows) is 'Microsoft-OTel-Logs'. The names
// differ by design.
resource dataCollectionRule 'Microsoft.Insights/dataCollectionRules@2024-03-11' = {
  name: 'dcr-${name}-otlp'
  location: location
  tags: tags
  properties: {
    dataCollectionEndpointId: dataCollectionEndpoint.id
    references: {
      applicationInsights: [
        {
          name: 'applicationInsightsResource'
          resourceId: appInsights.id
        }
      ]
    }
    dataSources: {
      otelLogs: [
        {
          name: 'otelLogsDataSource'
          streams: [ 'Microsoft-OTel-Logs' ]
          enrichWithReference: 'applicationInsightsResource'
          enrichWithResourceAttributes: [ '*' ]
          replaceResourceIdWithReference: true
        }
      ]
      otelTraces: [
        {
          name: 'otelTracesDataSource'
          streams: [
            'Microsoft-OTel-Traces-Spans'
            'Microsoft-OTel-Traces-Events'
            'Microsoft-OTel-Traces-Resources'
          ]
          enrichWithReference: 'applicationInsightsResource'
          enrichWithResourceAttributes: [ '*' ]
          replaceResourceIdWithReference: true
        }
      ]
    }
    directDataSources: {
      otelLogs: [
        {
          name: 'otelLogsDataSourceDirect'
          streams: [ 'Microsoft-OTel-Logs' ]
          enrichWithReference: 'applicationInsightsResource'
          enrichWithResourceAttributes: [ '*' ]
          replaceResourceIdWithReference: true
        }
      ]
      otelTraces: [
        {
          name: 'otelTracesDataSourceDirect'
          streams: [
            'Microsoft-OTel-Traces-Spans'
            'Microsoft-OTel-Traces-Events'
            'Microsoft-OTel-Traces-Resources'
          ]
          enrichWithReference: 'applicationInsightsResource'
          enrichWithResourceAttributes: [ '*' ]
          replaceResourceIdWithReference: true
        }
      ]
    }
    destinations: {
      logAnalytics: [
        {
          workspaceResourceId: logAnalytics.id
          name: 'la-dest'
        }
      ]
    }
    dataFlows: [
      {
        streams: [
          'Microsoft-OTel-Logs'
          'Microsoft-OTel-Traces-Spans'
          'Microsoft-OTel-Traces-Events'
          'Microsoft-OTel-Traces-Resources'
        ]
        destinations: [ 'la-dest' ]
      }
    ]
  }
}

var monitoringMetricsPublisherRoleId = '3913510d-42f4-4e42-8a64-420c390055eb' // Monitoring Metrics Publisher
var logAnalyticsReaderRoleId = '73c42c96-874c-492b-b04d-ab87d138a893' // Log Analytics Reader
var monitoringReaderRoleId = '43d0d8ad-25c7-4714-9337-8ba259a9fe05' // Monitoring Reader

resource publisherOnDcr 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (deployRbac && !empty(identityPrincipalId)) {
  name: guid(dataCollectionRule.id, identityPrincipalId, monitoringMetricsPublisherRoleId)
  scope: dataCollectionRule
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', monitoringMetricsPublisherRoleId)
    principalId: identityPrincipalId
    principalType: 'ServicePrincipal'
  }
}

// Monitoring Reader on the DCR — required to READ the DCR platform metrics
// (RowsReceived_Count / RowsDropped_Count / TransformationErrors_Count) the
// read-path stall alerts use as their ingest-side coverage signal. Distinct from
// publisherOnDcr above, which grants PUBLISH (the ingest-bearer path); READ of
// the metrics needs its own role. Until this is applied, the coverage probe
// gets a 403 and the alerts fall back to the bearer gate (fails toward paging).
resource monitoringReaderOnDcr 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (deployRbac && !empty(identityPrincipalId)) {
  name: guid(dataCollectionRule.id, identityPrincipalId, monitoringReaderRoleId)
  scope: dataCollectionRule
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', monitoringReaderRoleId)
    principalId: identityPrincipalId
    principalType: 'ServicePrincipal'
  }
}

resource readerOnLaw 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (deployRbac && !empty(identityPrincipalId)) {
  name: guid(logAnalytics.id, identityPrincipalId, logAnalyticsReaderRoleId)
  scope: logAnalytics
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', logAnalyticsReaderRoleId)
    principalId: identityPrincipalId
    principalType: 'ServicePrincipal'
  }
}

// ── Action Group ────────────────────────────────────────────────────
// Empty notificationEmail = no group provisioned, alerts still fire
// (visible in Monitor) but no email/Teams ping.

resource actionGroup 'Microsoft.Insights/actionGroups@2023-01-01' = if (!empty(notificationEmail)) {
  name: 'ag-${name}'
  location: 'global'
  tags: tags
  properties: {
    // `groupShortName` max length is 12 chars (ARM constraint). It shows
    // up in email subjects + SMS. A `take(replace(name,'-',''),12)`
    // would collapse to the same 'tokenscopesa' across all envs, making
    // on-call routing ambiguous. Map env name → short tag explicitly:
    //   sandbox    → ts-sand    (8)
    //   dev        → ts-dev     (7)
    //   staging    → ts-stage   (9)
    //   production → ts-prod    (8)
    // All under 12; all env-distinguishable.
    groupShortName: 'ts-${environment == 'production' ? 'prod' : environment == 'staging' ? 'stage' : environment == 'dev' ? 'dev' : environment == 'demo' ? 'demo' : 'sand'}'
    enabled: true
    emailReceivers: [
      {
        name: 'ops-email'
        emailAddress: notificationEmail
        useCommonAlertSchema: true
      }
    ]
  }
}

var actionGroups = empty(notificationEmail) ? [] : [
  { actionGroupId: actionGroup.id }
]

// ── Alert Rules ────────────────────────────────────────────────────
// Sev 2 = page; Sev 3 = noise floor. Sandbox keeps all alerts on for
// validation; production may want to tune thresholds upward as load
// grows.

// 1. Server Error Rate (5xx) — Sev 2
resource errorRateAlert 'Microsoft.Insights/metricAlerts@2018-03-01' = {
  name: 'alert-error-rate-${name}'
  location: 'global'
  tags: tags
  properties: {
    description: 'Failed request count (5xx) exceeds 5 over a 5-minute window.'
    severity: 2
    enabled: true
    scopes: [ appInsights.id ]
    evaluationFrequency: 'PT1M'
    windowSize: 'PT5M'
    criteria: {
      'odata.type': 'Microsoft.Azure.Monitor.SingleResourceMultipleMetricCriteria'
      allOf: [
        {
          name: 'ServerErrorRate'
          metricName: 'requests/failed'
          metricNamespace: 'microsoft.insights/components'
          operator: 'GreaterThan'
          threshold: 5
          timeAggregation: 'Count'
          criterionType: 'StaticThresholdCriterion'
          dimensions: [
            {
              name: 'request/resultCode'
              operator: 'Include'
              values: ['500', '501', '502', '503', '504']
            }
          ]
        }
      ]
    }
    actions: actionGroups
  }
}

// 2. Response Time — Sev 3
resource responseTimeAlert 'Microsoft.Insights/metricAlerts@2018-03-01' = {
  name: 'alert-response-time-${name}'
  location: 'global'
  tags: tags
  properties: {
    description: 'Average response time exceeds 3 seconds over a 5-minute window.'
    severity: 3
    enabled: true
    scopes: [ appInsights.id ]
    evaluationFrequency: 'PT1M'
    windowSize: 'PT5M'
    criteria: {
      'odata.type': 'Microsoft.Azure.Monitor.SingleResourceMultipleMetricCriteria'
      allOf: [
        {
          name: 'HighResponseTime'
          metricName: 'requests/duration'
          metricNamespace: 'microsoft.insights/components'
          operator: 'GreaterThan'
          threshold: 3000
          timeAggregation: 'Average'
          criterionType: 'StaticThresholdCriterion'
        }
      ]
    }
    actions: actionGroups
  }
}

// 3. Exception Rate — Sev 2
resource exceptionRateAlert 'Microsoft.Insights/metricAlerts@2018-03-01' = {
  name: 'alert-exception-rate-${name}'
  location: 'global'
  tags: tags
  properties: {
    description: 'Exception count exceeds 10 in 5 minutes.'
    severity: 2
    enabled: true
    scopes: [ appInsights.id ]
    evaluationFrequency: 'PT1M'
    windowSize: 'PT5M'
    criteria: {
      'odata.type': 'Microsoft.Azure.Monitor.SingleResourceMultipleMetricCriteria'
      allOf: [
        {
          name: 'ExceptionSpike'
          metricName: 'exceptions/count'
          metricNamespace: 'microsoft.insights/components'
          operator: 'GreaterThan'
          threshold: 10
          timeAggregation: 'Count'
          criterionType: 'StaticThresholdCriterion'
        }
      ]
    }
    actions: actionGroups
  }
}

// 4. Dependency Failure Rate — Sev 2
// Catches PG / Redis / Anthropic API failures the app reports as
// dependency failures via AppInsights auto-instrumentation.
resource dependencyFailureAlert 'Microsoft.Insights/metricAlerts@2018-03-01' = {
  name: 'alert-dependency-failures-${name}'
  location: 'global'
  tags: tags
  properties: {
    description: 'Dependency failure count exceeds 5 in 5 minutes — check PG / Redis / Anthropic API.'
    severity: 2
    enabled: true
    scopes: [ appInsights.id ]
    evaluationFrequency: 'PT1M'
    windowSize: 'PT5M'
    criteria: {
      'odata.type': 'Microsoft.Azure.Monitor.SingleResourceMultipleMetricCriteria'
      allOf: [
        {
          name: 'DependencyFailures'
          metricName: 'dependencies/failed'
          metricNamespace: 'microsoft.insights/components'
          operator: 'GreaterThan'
          threshold: 5
          timeAggregation: 'Count'
          criterionType: 'StaticThresholdCriterion'
        }
      ]
    }
    actions: actionGroups
  }
}

// ── Outputs ──────────────────────────────────────────────────────────

@description('TELEMETRY workspace resource ID (the OTel streams the DCR ingests). Platform logs go to opsLogAnalyticsId.')
output logAnalyticsId string = logAnalytics.id

@description('TELEMETRY workspace customer ID (workspace GUID) — what the app\'s reader queries.')
output logAnalyticsCustomerId string = logAnalytics.properties.customerId

@description('The daily cap in GB set on the TELEMETRY workspace (its workspaceCapping.dailyQuotaGb). The app compares the trailing 24 hours\' billable ingestion against it (TELEMETRY_DAILY_CAP_GB), so it comes from here rather than from a second copy of the number.')
output telemetryDailyCapGb int = dailyIngestionCapGb

@description('Log Analytics workspace name. Consumers needing the shared key reference the workspace as `existing` + call `listKeys()` themselves — the key never crosses a module-output boundary, which keeps it out of the ARM deployment template entirely.')
output logAnalyticsName string = logAnalytics.name

@description('Workspace for the platform\'s own logs: diagnostic settings, the Container Apps environment, log alert rules. The telemetry workspace when separateOpsWorkspace is off.')
output opsLogAnalyticsId string = opsWorkspaceId

@description('Ops workspace customer ID, for the Container Apps environment log destination.')
output opsLogAnalyticsCustomerId string = separateOpsWorkspace ? opsLogAnalytics!.properties.customerId : logAnalytics.properties.customerId

@description('Ops workspace name. The shared key stays behind listKeys() in the consumer, as for logAnalyticsName.')
output opsLogAnalyticsName string = separateOpsWorkspace ? opsLogAnalytics!.name : logAnalytics.name

@description('Application Insights connection string — wire into container app env as APPLICATIONINSIGHTS_CONNECTION_STRING.')
output appInsightsConnectionString string = appInsights.properties.ConnectionString

@description('Application Insights resource name.')
output appInsightsName string = appInsights.name

@description('Azure Monitor Workspace resource ID (preview metrics path; nothing consumes it today). Empty when deployAzureMonitorWorkspace is false. Token-usage ingest goes through the DCE/DCR pair provisioned in this module, not this workspace.')
output amwResourceId string = deployAzureMonitorWorkspace ? azureMonitorWorkspace!.id : ''

@description('Azure Monitor Workspace name — used by future DCE/DCR provisioning.')
output amwName string = deployAzureMonitorWorkspace ? azureMonitorWorkspace!.name : ''

@description('DCE logs-ingestion endpoint (host base). VERIFIED full OTLP logs URL: <this>/dataCollectionRules/<dcrImmutableId>/streams/Microsoft-OTLP-Logs/otlp/v1/logs — the plugin sets this as OTEL_EXPORTER_OTLP_LOGS_ENDPOINT and Claude POSTs application/x-protobuf with an explicit Content-Length.')
output dceLogsIngestionEndpoint string = dataCollectionEndpoint.properties.logsIngestion.endpoint

@description('DCR immutable id — required path segment in the OTLP ingest URL (…/dataCollectionRules/<this>/streams/Microsoft-OTLP-Logs/otlp/v1/logs).')
output dcrImmutableId string = dataCollectionRule.properties.immutableId

@description('DCR name.')
output dcrName string = dataCollectionRule.name

@description('DCR ARM resource id — the Azure Monitor METRICS API target for the ingest-coverage probe (NUXT_AZURE_DCR_RESOURCE_ID). Needs Monitoring Reader on the DCR (monitoringReaderOnDcr above).')
output dcrResourceId string = dataCollectionRule.id

@description('Action group resource ID (empty when notificationEmail is empty — alerts still fire, no email). Consumed by the LATE ops-alerts module (ops-alerting.md ar-M19: ONE action group, reused — never a second one) whose alert rules scope resources this module must not depend on (monitoring is their producer; see main.bicep\'s deployment graph).')
output actionGroupId string = empty(notificationEmail) ? '' : actionGroup.id
