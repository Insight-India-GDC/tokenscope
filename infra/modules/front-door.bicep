// ── Azure Front Door — WAF-protected ingress for TokenScope ──────────
//
// Single endpoint, single origin group, single origin — TokenScope is one
// Nuxt container app. Two SKUs:
//   - Standard: the origin is the app's PUBLIC ingress. Standard cannot reach
//     an internal Container Apps environment.
//   - Premium: may instead reach an INTERNAL (VNet) environment over Private
//     Link (privateLinkResourceId set). Front Door then requests a private
//     endpoint on the managed environment, which must be APPROVED before any
//     traffic flows (docs/DEPLOY-AZURE.md). Premium also carries Microsoft's
//     managed WAF rule sets.
// Either way the container app's require-front-door middleware rejects
// requests without this profile's X-Azure-FDID header once frontDoorId is set.
//
// AVM consideration: `avm/res/cdn/profile` (Azure Verified Module) covers
// AFD profile/endpoints/origins, but does NOT bundle the WAF policy +
// securityPolicy under one abstraction. To keep the WAF rule definitions
// (TokenScope-specific, OWASP-Standard-SKU custom rules) co-located with
// the AFD provisioning that consumes them, this module is custom — same
// pattern as the rest of `infra/modules/`. Revisit when AVM exposes a
// composite "AFD + WAF + policy-binding" module.
//
// Health probe path: `/api/health` (Nuxt convention; matches
// container-app.bicep's startup/readiness probes, so it includes the DB check.
// Only the liveness probe uses `?probe=live`, which skips it).
//
// Custom domains are added out-of-band via `az afd custom-domain create`
// AFTER DNS validation (managing custom domains in Bicep races DNS
// propagation). When a custom domain is added,
// it MUST also be added to the securityPolicy.associations.domains array
// via `az afd security-policy update` — AFD does NOT inherit WAF coverage
// from the endpoint to attached custom domains.

@description('Resource name suffix (e.g. tokenscope-sandbox-aue).')
param name string

@description('Environment name (drives tags + sanity asserts).')
@allowed(['sandbox', 'dev', 'demo', 'staging', 'production'])
param environment string

@description('Container App FQDN (from container-app module output). The AFD origin points at this host AND uses it as the originHostHeader so the CA ingress accepts the request.')
param originFqdn string

@description('AFD origin response timeout (seconds). Defaults to 240, the maximum Azure allows. Scheduled worker jobs call through Front Door when it is enforced, so this must stay at or above the 200 s worker dispatch budget (DISPATCH_TIMEOUT_MS in shared/workers/dispatch-budget.ts); below it, a finished worker is reported as a failed job execution.')
@minValue(16)
@maxValue(240)
param originResponseTimeoutSeconds int = 240

@description('ISO-3166 alpha-2 country codes allowed to reach the app. Empty array (default) = no geo restriction. Populate with e.g. [\'AU\', \'US\'] to restrict.')
param wafGeoAllowedCountries array = []

@description('Front Door tier. Premium is required for a Private Link origin and for the managed WAF rule sets.')
@allowed(['Standard', 'Premium'])
param sku string = 'Standard'

@description('Managed environment resource id to reach over Private Link (Premium only). Empty = public origin.')
param privateLinkResourceId string = ''

@description('Region of the managed environment (Private Link location). Required with privateLinkResourceId.')
param privateLinkLocation string = ''

@description('What the Premium managed rule sets (DRS 2.1, Bot Manager 1.1) do on a match: Log (observe) or Block. Ignored on Standard.')
@allowed(['Log', 'Block'])
param managedRuleAction string = 'Log'

@description('Log Analytics workspace resource id for Front Door access, health-probe and WAF logs. Empty = no diagnostic setting.')
param logAnalyticsId string = ''

@description('Requests per IP per 5 minutes before the WAF rate-limit rule blocks. Everyone behind one NAT address shares a budget.')
@minValue(10)
param rateLimitPerIpPer5Min int = 100

@description('Tags applied to every resource that accepts the tags property.')
param tags object = {}

var skuName = '${sku}_AzureFrontDoor'
var usePrivateLink = sku == 'Premium' && !empty(privateLinkResourceId)
// Front Door's private endpoint request carries this message; the approval
// step matches on it (Front Door can file duplicate requests).
var privateLinkRequestMessage = 'TokenScope Front Door fd-${name}'
var premiumManagedRuleSets = [
  {
    ruleSetType: 'Microsoft_DefaultRuleSet'
    ruleSetVersion: '2.1'
    ruleSetAction: managedRuleAction
  }
  {
    ruleSetType: 'Microsoft_BotManagerRuleSet'
    ruleSetVersion: '1.1'
    ruleSetAction: managedRuleAction
  }
]

// Merge the environment marker into tags so the module is self-describing
// even when the caller passes an empty tags object. Module's
// `environment: env` is AUTHORITATIVE — main.bicep's tags object can't
// override it via a key collision (union is right-biased on the second
// arg; we keep the module value last so it wins).
var effectiveTags = union(tags, {
  environment: environment
})

// ── Front Door Profile ──────────────────────────────────────────────

resource frontDoorProfile 'Microsoft.Cdn/profiles@2024-02-01' = {
  name: 'fd-${name}'
  location: 'global'
  sku: {
    name: skuName
  }
  properties: {
    originResponseTimeoutSeconds: originResponseTimeoutSeconds
  }
  tags: effectiveTags
}

// ── Endpoint (single — TokenScope is one app) ───────────────────────

resource endpoint 'Microsoft.Cdn/profiles/afdEndpoints@2024-02-01' = {
  parent: frontDoorProfile
  name: 'ep-${name}'
  location: 'global'
  tags: effectiveTags
  properties: {
    enabledState: 'Enabled'
  }
}

// ── Origin Group (single — load balancing settings + health probe) ──

resource originGroup 'Microsoft.Cdn/profiles/originGroups@2024-02-01' = {
  parent: frontDoorProfile
  name: 'og-tokenscope'
  properties: {
    loadBalancingSettings: {
      sampleSize: 4
      successfulSamplesRequired: 3
      additionalLatencyInMilliseconds: 50
    }
    healthProbeSettings: {
      probePath: '/api/health'
      probeProtocol: 'Https'
      probeIntervalInSeconds: 100
      probeRequestType: 'HEAD'
    }
    sessionAffinityState: 'Disabled'
  }
}

// ── Origin (the container app) ──────────────────────────────────────

resource origin 'Microsoft.Cdn/profiles/originGroups/origins@2024-02-01' = {
  parent: originGroup
  name: 'origin-tokenscope'
  properties: {
    hostName: originFqdn
    httpPort: 80
    httpsPort: 443
    originHostHeader: originFqdn
    priority: 1
    weight: 1000
    enabledState: 'Enabled'
    sharedPrivateLinkResource: usePrivateLink ? {
      privateLink: {
        id: privateLinkResourceId
      }
      groupId: 'managedEnvironments'
      privateLinkLocation: privateLinkLocation
      requestMessage: privateLinkRequestMessage
    } : null
  }
}

// ── Route (the endpoint routes /* HTTPS-only to the origin group) ───
// `dependsOn: [origin]` is explicit. The route binds
// to the origin group via id, but ARM occasionally races the route
// provisioning ahead of the origin write, which the explicit dependsOn
// avoids.

resource route 'Microsoft.Cdn/profiles/afdEndpoints/routes@2024-02-01' = {
  parent: endpoint
  name: 'route-default'
  properties: {
    originGroup: {
      id: originGroup.id
    }
    supportedProtocols: [
      'Https'
    ]
    patternsToMatch: [
      '/*'
    ]
    forwardingProtocol: 'HttpsOnly'
    linkToDefaultDomain: 'Enabled'
    httpsRedirect: 'Enabled'
  }
  dependsOn: [
    origin
  ]
}

// ── WAF Policy ──────────────────────────────────────────────────────
// Standard SKU = custom rules only (no managed OWASP rulesets). The
// rules below:
//   - Geo-restriction is now a conditional knob (wafGeoAllowedCountries).
//   - The block-response page is a generic TokenScope card.
//   - The OIDC-callback comment for the 8192 limit is preserved verbatim
//     because the same Entra-callback-URL-length pressure applies.
//
// Custom block response body — generic TokenScope card served on any
// WAF block (geo, SQLi, XSS, scanner, path-traversal, etc.). Regenerate
// via `base64 -w 0` on this HTML if the page changes:
//
//   <!DOCTYPE html>
//   <html lang="en">
//   <head>
//   <meta charset="utf-8">
//   <meta name="viewport" content="width=device-width, initial-scale=1">
//   <title>TokenScope — Request blocked</title>
//   <style>
//   *{box-sizing:border-box}
//   body{font-family:-apple-system,BlinkMacSystemFont,system-ui,sans-serif;max-width:32rem;margin:3rem auto;padding:1.75rem;color:#1e293b;line-height:1.55;background:linear-gradient(180deg,#f1f5f9,#fafaf9 60%,#eff6ff);min-height:100vh;margin:0;padding-top:5rem}
//   .card{max-width:32rem;margin:0 auto;padding:1.75rem;background:#ffffff;border:1px solid rgba(226,232,240,0.7);border-radius:14px;box-shadow:0 1px 2px rgba(15,23,42,0.04)}
//   h1{font-size:1.4rem;letter-spacing:-0.01em;margin:0 0 0.75rem;color:#0f172a}
//   p{margin:0.75rem 0}
//   footer{color:#94a3b8;font-size:0.78rem;margin:2rem auto 0;text-align:center;max-width:32rem;padding:0 1.75rem}
//   </style>
//   </head>
//   <body>
//   <main class="card">
//   <h1>Request blocked</h1>
//   <p>The Web Application Firewall in front of TokenScope rejected this request. This is usually because the request matched a known-bad pattern (SQL injection, XSS, scanner, path traversal) or your client tripped a rate limit.</p>
//   <p>If you believe this is a mistake, contact your TokenScope administrator and include this page's URL plus the approximate time.</p>
//   </main>
//   <footer>TokenScope</footer>
//   </body>
//   </html>
var wafBlockResponseBodyBase64 = 'PCFET0NUWVBFIGh0bWw+CjxodG1sIGxhbmc9ImVuIj4KPGhlYWQ+CjxtZXRhIGNoYXJzZXQ9InV0Zi04Ij4KPG1ldGEgbmFtZT0idmlld3BvcnQiIGNvbnRlbnQ9IndpZHRoPWRldmljZS13aWR0aCwgaW5pdGlhbC1zY2FsZT0xIj4KPHRpdGxlPlRva2VuU2NvcGUg4oCUIFJlcXVlc3QgYmxvY2tlZDwvdGl0bGU+CjxzdHlsZT4KKntib3gtc2l6aW5nOmJvcmRlci1ib3h9CmJvZHl7Zm9udC1mYW1pbHk6LWFwcGxlLXN5c3RlbSxCbGlua01hY1N5c3RlbUZvbnQsc3lzdGVtLXVpLHNhbnMtc2VyaWY7bWF4LXdpZHRoOjMycmVtO21hcmdpbjozcmVtIGF1dG87cGFkZGluZzoxLjc1cmVtO2NvbG9yOiMxZTI5M2I7bGluZS1oZWlnaHQ6MS41NTtiYWNrZ3JvdW5kOmxpbmVhci1ncmFkaWVudCgxODBkZWcsI2YxZjVmOSwjZmFmYWY5IDYwJSwjZWZmNmZmKTttaW4taGVpZ2h0OjEwMHZoO21hcmdpbjowO3BhZGRpbmctdG9wOjVyZW19Ci5jYXJke21heC13aWR0aDozMnJlbTttYXJnaW46MCBhdXRvO3BhZGRpbmc6MS43NXJlbTtiYWNrZ3JvdW5kOiNmZmZmZmY7Ym9yZGVyOjFweCBzb2xpZCByZ2JhKDIyNiwyMzIsMjQwLDAuNyk7Ym9yZGVyLXJhZGl1czoxNHB4O2JveC1zaGFkb3c6MCAxcHggMnB4IHJnYmEoMTUsMjMsNDIsMC4wNCl9Cmgxe2ZvbnQtc2l6ZToxLjRyZW07bGV0dGVyLXNwYWNpbmc6LTAuMDFlbTttYXJnaW46MCAwIDAuNzVyZW07Y29sb3I6IzBmMTcyYX0KcHttYXJnaW46MC43NXJlbSAwfQpmb290ZXJ7Y29sb3I6Izk0YTNiODtmb250LXNpemU6MC43OHJlbTttYXJnaW46MnJlbSBhdXRvIDA7dGV4dC1hbGlnbjpjZW50ZXI7bWF4LXdpZHRoOjMycmVtO3BhZGRpbmc6MCAxLjc1cmVtfQo8L3N0eWxlPgo8L2hlYWQ+Cjxib2R5Pgo8bWFpbiBjbGFzcz0iY2FyZCI+CjxoMT5SZXF1ZXN0IGJsb2NrZWQ8L2gxPgo8cD5UaGUgV2ViIEFwcGxpY2F0aW9uIEZpcmV3YWxsIGluIGZyb250IG9mIFRva2VuU2NvcGUgcmVqZWN0ZWQgdGhpcyByZXF1ZXN0LiBUaGlzIGlzIHVzdWFsbHkgYmVjYXVzZSB0aGUgcmVxdWVzdCBtYXRjaGVkIGEga25vd24tYmFkIHBhdHRlcm4gKFNRTCBpbmplY3Rpb24sIFhTUywgc2Nhbm5lciwgcGF0aCB0cmF2ZXJzYWwpIG9yIHlvdXIgY2xpZW50IHRyaXBwZWQgYSByYXRlIGxpbWl0LjwvcD4KPHA+SWYgeW91IGJlbGlldmUgdGhpcyBpcyBhIG1pc3Rha2UsIGNvbnRhY3QgeW91ciBUb2tlblNjb3BlIGFkbWluaXN0cmF0b3IgYW5kIGluY2x1ZGUgdGhpcyBwYWdlJ3MgVVJMIHBsdXMgdGhlIGFwcHJveGltYXRlIHRpbWUuPC9wPgo8L21haW4+Cjxmb290ZXI+VG9rZW5TY29wZTwvZm9vdGVyPgo8L2JvZHk+CjwvaHRtbD4K'

// Conditional geo-block rule — emitted only when the operator has
// populated wafGeoAllowedCountries. Sandbox (default empty) gets no geo
// restriction; staging/production can opt in via the bicepparam.
var geoBlockRule = empty(wafGeoAllowedCountries) ? [] : [
  {
    name: 'GeoBlockNotAllowed'
    priority: 10
    enabledState: 'Enabled'
    ruleType: 'MatchRule'
    action: 'Block'
    matchConditions: [
      {
        matchVariable: 'RemoteAddr'
        operator: 'GeoMatch'
        matchValue: wafGeoAllowedCountries
        negateCondition: true // Block if NOT in the allow-list
      }
    ]
  }
]

var staticRules = [
  // ── Block disallowed HTTP methods ───────────────────────────────────
  // Only TRACE (XST) and CONNECT (proxy abuse) are genuinely worth blocking.
  // PUT was previously here too (PATCH never was) on a stale "TokenScope
  // uses GET/POST/DELETE only" assumption — but the app uses PUT for
  // idempotent settings saves (project-lifecycle policy + governance dials,
  // /api/v1/admin/**/*.put.ts), so the WAF returned the "Request blocked"
  // page on every such save. PUT is REST-correct here, a PUT to a route
  // with no PUT handler just 404s at the app, and every PUT route is
  // auth-gated anyway — so blocking it was never a real control.
  {
    name: 'BlockDisallowedMethods'
    priority: 20
    enabledState: 'Enabled'
    ruleType: 'MatchRule'
    action: 'Block'
    matchConditions: [
      {
        matchVariable: 'RequestMethod'
        operator: 'Equal'
        matchValue: [
          'TRACE'
          'CONNECT'
        ]
        negateCondition: false
      }
    ]
  }
  // ── Block SQL injection patterns in query strings (set 1) ──────────
  // Covers OWASP A03:2021 (Injection). Split due to 10-value limit.
  {
    name: 'BlockSQLiQueryString1'
    priority: 30
    enabledState: 'Enabled'
    ruleType: 'MatchRule'
    action: 'Block'
    matchConditions: [
      {
        matchVariable: 'QueryString'
        operator: 'Contains'
        matchValue: [
          'UNION SELECT'
          'UNION ALL SELECT'
          '; DROP '
          '; DELETE '
          '; INSERT '
          '; UPDATE '
          'OR 1=1'
        ]
        transforms: [
          'Uppercase'
        ]
        negateCondition: false
      }
    ]
  }
  // ── Block SQL injection patterns in query strings (set 2) ──────────
  {
    name: 'BlockSQLiQueryString2'
    priority: 31
    enabledState: 'Enabled'
    ruleType: 'MatchRule'
    action: 'Block'
    matchConditions: [
      {
        matchVariable: 'QueryString'
        operator: 'Contains'
        matchValue: [
          'WAITFOR DELAY'
          'BENCHMARK('
          'SLEEP('
          'xp_cmdshell'
          'INFORMATION_SCHEMA'
        ]
        transforms: [
          'Uppercase'
        ]
        negateCondition: false
      }
    ]
  }
  // ── Block SQL injection in request body ─────────────────────────────
  {
    name: 'BlockSQLiBody'
    priority: 32
    enabledState: 'Enabled'
    ruleType: 'MatchRule'
    action: 'Block'
    matchConditions: [
      {
        matchVariable: 'RequestBody'
        operator: 'Contains'
        matchValue: [
          'UNION SELECT'
          'UNION ALL SELECT'
          '; DROP '
          '; DELETE '
          'xp_cmdshell'
          'INFORMATION_SCHEMA'
          'WAITFOR DELAY'
        ]
        transforms: [
          'Uppercase'
        ]
        negateCondition: false
      }
    ]
  }
  // ── Block XSS patterns in query strings ─────────────────────────────
  // No endpoint accepts HTML in query strings. Covers OWASP A07:2021 (XSS).
  {
    name: 'BlockXSSQueryString'
    priority: 40
    enabledState: 'Enabled'
    ruleType: 'MatchRule'
    action: 'Block'
    matchConditions: [
      {
        matchVariable: 'QueryString'
        operator: 'Contains'
        matchValue: [
          '<script'
          'javascript:'
          'onerror='
          'onload='
          'onclick='
          'eval('
          'document.cookie'
          'document.write'
        ]
        transforms: [
          'Lowercase'
        ]
        negateCondition: false
      }
    ]
  }
  // ── Block path traversal ────────────────────────────────────────────
  // No endpoint serves files by user-supplied path.
  {
    name: 'BlockPathTraversal'
    priority: 50
    enabledState: 'Enabled'
    ruleType: 'MatchRule'
    action: 'Block'
    matchConditions: [
      {
        matchVariable: 'RequestUri'
        operator: 'Contains'
        matchValue: [
          '../'
          '..%2f'
          '..%5c'
          '%00'
          '/etc/passwd'
          'wp-admin'
          'wp-login'
          '.env'
          '.git/'
          'phpinfo'
        ]
        transforms: [
          'UrlDecode'
          'Lowercase'
        ]
        negateCondition: false
      }
    ]
  }
  // ── Block known scanner user-agents ─────────────────────────────────
  // No legitimate user uses these tools.
  {
    name: 'BlockScanners'
    priority: 60
    enabledState: 'Enabled'
    ruleType: 'MatchRule'
    action: 'Block'
    matchConditions: [
      {
        matchVariable: 'RequestHeader'
        selector: 'User-Agent'
        operator: 'Contains'
        matchValue: [
          'sqlmap'
          'nikto'
          'nmap'
          'masscan'
          'burpsuite'
          'nessus'
          'dirbuster'
          'gobuster'
          'acunetix'
          'zgrab'
        ]
        transforms: [
          'Lowercase'
        ]
        negateCondition: false
      }
    ]
  }
  // ── Block oversized URLs ────────────────────────────────────────────
  // `operator: 'GreaterThan'` on `matchVariable: 'RequestUri'` compares
  // the URI LENGTH to the integer in matchValue (string-typed but
  // coerced). The matchValue '8192' = 8192-char URI. This is NOT a
  // value-equality check; do not swap to operator: 'Equal' (would
  // match URIs literally equal to "8192", which never happens).
  //
  // The hard floor is the Entra OIDC redirect:
  // /auth/callback?code=…&state=…&session_state=… routinely lands at
  // 1500–4000 chars and can spike higher with larger token shapes. 8192
  // matches the de-facto industry max (nginx large_client_header_buffers
  // default, Apache LimitRequestLine default) and leaves headroom over
  // the largest observed callback (a 2048 limit blocks legitimate logins).
  {
    name: 'BlockOversizedURL'
    priority: 70
    enabledState: 'Enabled'
    ruleType: 'MatchRule'
    action: 'Block'
    matchConditions: [
      {
        matchVariable: 'RequestUri'
        operator: 'GreaterThan'
        matchValue: [
          '8192'
        ]
        transforms: []
        negateCondition: false
      }
    ]
  }
  // ── Rate limit per IP (edge-level) ──────────────────────────────────
  // 100 reqs / 5 min. Catches abusive automated
  // traffic before it reaches the container app.
  {
    name: 'RateLimitPerIP'
    priority: 100
    enabledState: 'Enabled'
    ruleType: 'RateLimitRule'
    rateLimitThreshold: rateLimitPerIpPer5Min
    rateLimitDurationInMinutes: 5
    action: 'Block'
    matchConditions: [
      {
        matchVariable: 'RemoteAddr'
        operator: 'IPMatch'
        matchValue: [
          '0.0.0.0/0'
        ]
        negateCondition: false
      }
    ]
  }
]

resource wafPolicy 'Microsoft.Network/FrontDoorWebApplicationFirewallPolicies@2024-02-01' = {
  // WAF policy names cannot contain hyphens or dots. Strip them.
  name: replace(replace('waf${name}', '-', ''), '.', '')
  location: 'global'
  tags: effectiveTags
  sku: {
    // A WAF policy must match its profile's tier.
    name: skuName
  }
  properties: {
    policySettings: {
      enabledState: 'Enabled'
      // Prevention mode actually blocks (vs Detection = log-only).
      mode: 'Prevention'
      requestBodyCheck: 'Enabled'
      customBlockResponseStatusCode: 403
      customBlockResponseBody: wafBlockResponseBodyBase64
    }
    managedRules: {
      managedRuleSets: sku == 'Premium' ? premiumManagedRuleSets : []
    }
    customRules: {
      // Concat the conditional geo rule (priority 10) with the static
      // ruleset. When wafGeoAllowedCountries is empty, geoBlockRule is
      // [] and only the static rules are emitted.
      rules: concat(geoBlockRule, staticRules)
    }
  }
}

// ── Security Policy (binds WAF to the endpoint) ─────────────────────
// Azure Front Door allows one security policy per WAF per profile.
//
// IMPORTANT: when custom domains are added (out-of-band via az CLI),
// they MUST be added to this policy's associations.domains via:
//
//   az afd security-policy update --resource-group <rg> \
//       --profile-name <profile> --security-policy-name sp-waf \
//       --domains <ep-id> <customdomain-ids…>
//
// Listing only the AFD endpoint here leaves attached custom-domain
// traffic UNPROTECTED — AFD does NOT inherit WAF coverage automatically.

resource securityPolicy 'Microsoft.Cdn/profiles/securityPolicies@2024-02-01' = {
  parent: frontDoorProfile
  name: 'sp-waf'
  properties: {
    parameters: {
      type: 'WebApplicationFirewall'
      wafPolicy: {
        id: wafPolicy.id
      }
      associations: [
        {
          domains: [
            {
              id: endpoint.id
            }
          ]
          patternsToMatch: [
            '/*'
          ]
        }
      ]
    }
  }
}

// ── Outputs ─────────────────────────────────────────────────────────

@description('The unique AFD instance ID — gets injected as the X-Azure-FDID header value on every AFD-fronted request. Consumed by the container app\'s require-front-door middleware.')
output frontDoorId string = frontDoorProfile.properties.frontDoorId

@description('Public AFD endpoint FQDN (e.g. ep-tokenscope-sandbox-aue-<hash>.azurefd.net). The customer-facing URL once Front Door is live.')
output endpointFqdn string = endpoint.properties.hostName

@description('Front Door profile resource name (fd-<nameSuffix>).')
output profileName string = frontDoorProfile.name

@description('WAF policy resource name — useful for `az afd security-policy update` commands.')
output wafPolicyName string = wafPolicy.name

@description('Message on Front Door\'s private endpoint request; approve pending connections carrying it. Empty without Private Link.')
output privateLinkRequestMessage string = usePrivateLink ? privateLinkRequestMessage : ''

// Access, health-probe and WAF logs, so managed-rule matches in Log mode can be
// reviewed before switching to Block (docs/DEPLOY-AZURE.md).
resource frontDoorDiagnostics 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = if (!empty(logAnalyticsId)) {
  name: 'diag-fd-${name}'
  scope: frontDoorProfile
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
