/*
 * Platform logs go to the ops workspace; usage telemetry and its reader stay on
 * the telemetry workspace. Each wire is a plain string in Bicep and no deploy
 * fails when one is crossed.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { PUBLIC_SNAPSHOT } from '../helpers/public-snapshot'

const ROOT = resolve(__dirname, '../../..')
const MAIN = readFileSync(resolve(ROOT, 'infra/main.bicep'), 'utf8')
const MONITORING = readFileSync(resolve(ROOT, 'infra/modules/monitoring.bicep'), 'utf8')
const CONTAINER_APP = readFileSync(resolve(ROOT, 'infra/modules/container-app.bicep'), 'utf8')
// dev.bicepparam is internal-only: read here, skipped in the public snapshot.
const DEV_PARAMS = PUBLIC_SNAPSHOT ? null : readFileSync(resolve(ROOT, 'infra/parameters/dev.bicepparam'), 'utf8')
const OPS_ALERTS = readFileSync(resolve(ROOT, 'infra/modules/ops-alerts.bicep'), 'utf8')

/** The body of `resource <symbol> '...' = ... { ... }` up to the next top-level declaration. */
function resourceBlock(src: string, symbol: string): string {
  const start = src.search(new RegExp(`^resource ${symbol} `, 'm'))
  expect(start, `resource ${symbol} not found`).toBeGreaterThanOrEqual(0)
  const rest = src.slice(start)
  const end = rest.slice(1).search(/^(resource|module|output|var|param) /m)
  return end === -1 ? rest : rest.slice(0, end + 1)
}

describe('ops / telemetry workspace split', () => {
  it('a private-query deployment gets the ops workspace unless someone opts out on purpose', () => {
    expect(MAIN).toMatch(/^param separateOpsWorkspace bool = enablePrivateNetworking && monitorQueryPrivateOnly$/m)
    expect(MAIN).toContain('separateOpsWorkspace: separateOpsWorkspace')
  })

  it('the ops workspace is human-queryable, and the scope links only the telemetry workspace', () => {
    const ops = resourceBlock(MONITORING, 'opsLogAnalytics')
    expect(ops).toContain("publicNetworkAccessForQuery: 'Enabled'")
    const links = [...MONITORING.matchAll(/linkedResourceId:\s*(\S+)/g)].map((m) => m[1])
    expect(links).toEqual(['logAnalytics.id'])
  })

  it('the telemetry outputs and the app identity\'s reader role stay on the telemetry workspace', () => {
    expect(MONITORING).toMatch(/^output logAnalyticsId string = logAnalytics\.id$/m)
    expect(MONITORING).toMatch(/^output logAnalyticsCustomerId string = logAnalytics\.properties\.customerId$/m)
    expect(resourceBlock(MONITORING, 'readerOnLaw')).toMatch(/scope:\s*logAnalytics\s*$/m)
  })

  it('every diagnostic setting and log alert in main.bicep writes to or reads the ops workspace', () => {
    const wires = [...MAIN.matchAll(/logAnalyticsId:\s*(\S+)/g)].map((m) => m[1])
    expect(wires.length, 'no logAnalyticsId wires found — did main.bicep change shape?').toBeGreaterThan(0)
    expect(wires.filter((w) => w !== 'monitoring.outputs.opsLogAnalyticsId')).toEqual([])
    // Whatever a new wire is called, the telemetry workspace's id and name have
    // no business in main.bicep: only the reader's customer id crosses over.
    expect(MAIN).not.toContain('monitoring.outputs.logAnalyticsId')
    expect(MAIN).not.toContain('monitoring.outputs.logAnalyticsName')
  })

  it('opsWorkspaceId resolves to the ops workspace whenever the split is on', () => {
    // Every wire above routes through this one variable; aliasing it back to the
    // telemetry workspace would leave every string assertion green.
    expect(MONITORING).toMatch(/^var opsWorkspaceId = separateOpsWorkspace \? opsLogAnalytics!\.id : logAnalytics\.id$/m)
    expect(MONITORING).toMatch(/^output opsLogAnalyticsId string = opsWorkspaceId$/m)
    expect(MONITORING).toMatch(/^output opsLogAnalyticsCustomerId string = separateOpsWorkspace \? opsLogAnalytics!\.properties\.customerId : /m)
    expect(MONITORING).toMatch(/^output opsLogAnalyticsName string = separateOpsWorkspace \? opsLogAnalytics!\.name : /m)
  })

  it('the telemetry ingestion path stays on the telemetry workspace', () => {
    // The DCR lands the OTel streams, enriched with the App Insights component —
    // both belong to the private side.
    expect(resourceBlock(MONITORING, 'dataCollectionRule')).toMatch(/workspaceResourceId:\s*logAnalytics\.id/)
    expect(resourceBlock(MONITORING, 'appInsights')).toContain('WorkspaceResourceId: logAnalytics.id')
  })

  it('the Container Apps environment logs to the ops workspace', () => {
    expect(MAIN).toContain('appLogsWorkspaceCustomerId: monitoring.outputs.opsLogAnalyticsCustomerId')
    expect(MAIN).toContain('appLogsWorkspaceName: monitoring.outputs.opsLogAnalyticsName')
    const env = resourceBlock(CONTAINER_APP, 'containerAppEnv')
    expect(env).toContain('customerId: appLogsWorkspaceCustomerId')
    expect(env).toContain('appLogsWorkspace.listKeys()')
  })

  it('a split environment ships its logs by diagnostic setting, not from inside the VNet', () => {
    // The ops workspace is outside the private link scope the VNet resolves
    // Azure Monitor through, so the direct destination may never reach it.
    expect(MAIN).toContain('appLogsViaDiagnosticSettings: separateOpsWorkspace')
    expect(MAIN).toContain('appLogsWorkspaceId: monitoring.outputs.opsLogAnalyticsId')
    expect(resourceBlock(CONTAINER_APP, 'containerAppEnv')).toMatch(/appLogsViaDiagnosticSettings \? \{\s*destination: 'azure-monitor'/)
    const diag = resourceBlock(CONTAINER_APP, 'containerAppEnvDiagnostics')
    // The env switches to azure-monitor on this same flag; a setting gated on
    // anything else would leave it shipping logs nowhere.
    expect(diag).toMatch(/= if \(appLogsViaDiagnosticSettings && !empty\(appLogsWorkspaceId\)\) \{/)
    expect(diag).toContain('scope: containerAppEnv')
    expect(diag).toContain('workspaceId: appLogsWorkspaceId')
    expect(diag).toContain("{ category: 'ContainerAppConsoleLogs', enabled: true }")
    expect(diag).toContain("{ category: 'ContainerAppSystemLogs', enabled: true }")
  })

  it('the audit-write rule is renamed when it moves to the ops workspace', () => {
    // A scheduled-query rule's scope cannot be updated in place; same name, new
    // scope fails the whole ops-alerts deployment.
    expect(resourceBlock(OPS_ALERTS, 'securityAuditWriteAlert')).toContain(
      "name: logsOnOpsWorkspace ? 'alert-security-audit-write-ops-${name}' : 'alert-security-audit-write-${name}'",
    )
    expect(MAIN).toContain('logsOnOpsWorkspace: separateOpsWorkspace')
  })

  it('a silent platform-log workspace pages, so a broken delivery cannot hide', () => {
    const rule = resourceBlock(OPS_ALERTS, 'platformLogsSilentAlert')
    // Without the cron jobs there is no steady log line, so the rule would page on a quiet app.
    expect(rule).toMatch(/= if \(!empty\(logAnalyticsId\) && !empty\(opsAlertJobId\)\) \{/)
    expect(rule).toContain('scopes: [logAnalyticsId]')
    expect(rule).toMatch(/ContainerAppConsoleLogs_CL/)
    expect(rule).toMatch(/\(ContainerAppConsoleLogs \|/)
    expect(rule).toMatch(/operator: 'LessThan'\s+threshold: 1/)
  })

  it.skipIf(DEV_PARAMS === null)('Dev pins the split, so backing out private query cannot orphan the ops workspace', () => {
    expect(DEV_PARAMS).toMatch(/^param separateOpsWorkspace = true$/m)
  })

  it('the telemetry reader still queries the telemetry workspace', () => {
    expect(MAIN).toContain('logAnalyticsCustomerId: monitoring.outputs.logAnalyticsCustomerId')
    expect(CONTAINER_APP).toContain("{ name: 'NUXT_LOG_ANALYTICS_WORKSPACE_ID', value: logAnalyticsCustomerId }")
  })
})
