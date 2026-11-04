// https://nuxt.com/docs/api/configuration/nuxt-config
import pkg from './package.json' with { type: 'json' }

export default defineNuxtConfig({
  compatibilityDate: '2025-07-15',

  // Off: @nuxt/devtools 3.x imports simple-git's default export, which 4.x (the
  // only line with the fixes for its critical advisories) no longer has, so
  // with the override in package.json enabling it breaks `nuxt prepare`.
  // Re-enable once a devtools release depends on simple-git 4.
  devtools: { enabled: false },

  modules: ['@nuxt/ui', '@nuxt/eslint', 'nuxt-oidc-auth', 'nuxt-security', 'nuxt-echarts'],

  css: ['~/assets/css/main.css'],

  // The app has one (light) theme. @nuxt/ui's colour mode followed the OS (and
  // remembers that choice in the browser), put `dark` on <html> and turned native
  // checkboxes into solid black squares on a light page. Off, not just defaulted.
  ui: { colorMode: false },

  // nuxt-echarts — tree-shaken ECharts wiring for the branded reporting chart
  // kit (app/components/reporting/charts/**). SVG renderer keeps the DOM
  // inspectable + CSP-clean (no canvas image data) and lets brand CSS vars
  // resolve; only the charts/components/features actually used are bundled so
  // we don't ship all of ECharts. The module registers <VChart> globally and a
  // generated global `ECOption` type composed from the enabled pieces.
  echarts: {
    renderer: 'svg',
    charts: ['LineChart', 'BarChart', 'PieChart', 'HeatmapChart'],
    components: [
      'GridComponent',
      'TooltipComponent',
      'LegendComponent',
      'DatasetComponent',
      'MarkLineComponent',
      'MarkAreaComponent',
      'GraphicComponent',
      'VisualMapComponent',
    ],
    // LegacyGridContainLabel is required in ECharts 6: `grid.containLabel` was
    // extracted into this opt-in legacy feature, so without it the option is a
    // silent no-op and axis / bar-end labels clip. The chart kit relies on
    // containLabel to fit ranked-bar category + value labels.
    features: ['LabelLayout', 'UniversalTransition', 'LegacyGridContainLabel'],
  },

  devServer: {
    host: '0.0.0.0',
    port: 3450,
  },

  app: {
    head: {
      htmlAttrs: { lang: 'en' },
      title: 'TokenScope',
      meta: [
        { name: 'viewport', content: 'width=device-width, initial-scale=1' },
        {
          name: 'description',
          content:
            'TokenScope — Usage-Based Token Attribution Platform. Trust the developer. Track every token. Let the budget do the teaching.',
        },
      ],
      link: [
        { rel: 'preconnect', href: 'https://fonts.googleapis.com' },
        { rel: 'preconnect', href: 'https://fonts.gstatic.com', crossorigin: '' },
        {
          rel: 'stylesheet',
          href: 'https://fonts.googleapis.com/css2?family=Manrope:wght@400;500;600;700;800&family=Zilla+Slab:ital,wght@1,500&family=JetBrains+Mono:wght@400;500&display=swap',
        },
      ],
    },
  },

  typescript: {
    strict: true,
    typeCheck: false,
  },

  runtimeConfig: {
    sessionSecret: process.env.NUXT_SESSION_SECRET || '',
    azureMonitorEndpoint: process.env.NUXT_AZURE_MONITOR_ENDPOINT || '',
    public: {
      // The artefact's own version, read from package.json at BUILD time —
      // which is the only time it can be known, and the only place it is
      // maintained. Surfaced through /api/v1/meta/build so no view ever
      // hand-types a version string (see shared/build-info.ts).
      appVersion: pkg.version,
      authDevMode: process.env.NUXT_OIDC_AUTH_DEV_MODE === 'true',
      // Client mirror of NUXT_DEPLOY_ENV, consumed by useDemoFeatures() to hide
      // persona/demo UI off demo-capable envs. Empty placeholder — runtime-overlaid
      // from NUXT_PUBLIC_DEPLOY_ENV at container BOOT (never a build-time read; see
      // the OIDC comment below for why build-time process.env reads are unsafe).
      // Bicep sets NUXT_PUBLIC_DEPLOY_ENV from the SAME `environment` param as
      // NUXT_DEPLOY_ENV so the client/server mirrors cannot drift. The UI gate is
      // cosmetic defense-in-depth; the server gate is authoritative.
      deployEnv: '',
    },
  },

  // OIDC config:
  //   - Local dev (NUXT_OIDC_AUTH_DEV_MODE=true): enabled:false; the
  //     custom cookie path (server/auth/session.ts) switches between
  //     4 demo personas.
  //   - Sandbox / prod (Epic 10): real Entra OIDC via nuxt-oidc-auth.
  //
  // CRITICAL: do NOT read process.env.* inside provider config fields.
  // nuxt.config.ts is evaluated at BUILD time (e.g. inside `az acr build`,
  // which has no Azure secrets). Build-baked '' would override every env
  // var read by the running container. Instead, declare placeholder
  // strings here and let Nuxt's runtime-config overlay fill them in
  // from these env vars at boot:
  //
  //   NUXT_OIDC_PROVIDERS_ENTRA_CLIENT_ID
  //   NUXT_OIDC_PROVIDERS_ENTRA_CLIENT_SECRET
  //   NUXT_OIDC_PROVIDERS_ENTRA_REDIRECT_URI
  //   NUXT_OIDC_PROVIDERS_ENTRA_AUTHORIZATION_URL
  //   NUXT_OIDC_PROVIDERS_ENTRA_TOKEN_URL
  //
  // Bicep (infra/modules/container-app.bicep) sets each one. Placeholders
  // are non-empty so the build-time requiredProperties validation passes;
  // the runtime overlay swaps in real values.
  oidc: {
    enabled: process.env.NUXT_OIDC_AUTH_DEV_MODE !== 'true',
    middleware: { globalMiddlewareEnabled: false },
    defaultProvider: 'entra',
    providers: {
      entra: {
        // Placeholders — overridden at runtime by NUXT_OIDC_PROVIDERS_ENTRA_* env vars.
        clientId: '__set_at_runtime__',
        clientSecret: '__set_at_runtime__',
        authorizationUrl: 'https://login.microsoftonline.com/__tenant_id__/oauth2/v2.0/authorize',
        tokenUrl: 'https://login.microsoftonline.com/__tenant_id__/oauth2/v2.0/token',
        redirectUri: 'https://__hostname__/auth/entra/callback',
        // Federated logout. Both keys MUST be declared here (even as
        // placeholders) so Nuxt creates the runtimeConfig slots that
        // NUXT_OIDC_PROVIDERS_ENTRA_LOGOUT_{URL,REDIRECT_URI} override at
        // container boot — same build-time-declaration requirement as
        // redirectUri above. Without logoutUrl the module's logout handler
        // falls back to redirecting at getRequestURL().host, which under
        // Azure Front Door is the REWRITTEN origin FQDN → direct Container
        // App hit → require-front-door 500. logoutRedirectUri is the
        // post_logout_redirect_uri sent to Entra's end_session_endpoint;
        // it MUST be registered as a redirect URI on the app registration.
        logoutUrl: 'https://login.microsoftonline.com/__tenant_id__/oauth2/v2.0/logout',
        logoutRedirectUri: 'https://__hostname__/login',
        scope: ['openid', 'profile', 'email', 'offline_access'],
        userNameClaim: 'preferred_username',
        // Wave-V — JIT teammate creator reads these claims from the id
        // token. `oid` is the durable Entra object id (the audit
        // record's actualOid); `email` + `name` are the JIT-creation
        // payload. nuxt-oidc-auth's callback handler copies any claim
        // listed here into user.claims for downstream session-hook
        // consumers.
        //
        // `preferred_username` / `upn` carry the sign-in UPN, which is the axis
        // the directory-exclusion policy matches on (#121,
        // server/auth/jit-teammate.ts). THIS LIST IS THE ONLY SOURCE FOR THEM:
        // nuxt-oidc-auth populates user.claims strictly from optionalClaims
        // (dist/runtime/server/handler/callback.js), and user.userInfo is
        // written only when a userInfoUrl is configured — we configure none. So
        // while the UPN was absent from this list, extractClaims' three lookups
        // were all permanently undefined and the JIT exclusion guard fails open
        // on every sign-in.
        //
        // `userNameClaim` above is NOT a substitute: the module reads it out of
        // the ACCESS token, not the id token, and an Entra Graph access token
        // does not reliably carry preferred_username.
        //
        // TODAY'S EXPOSURE IS NIL, and this must not be described as closing a
        // live hole: mig 0083 seeds ZERO exclusion patterns and the cleanup
        // worker returns early with none, so the guard currently matches nobody
        // either way. This ARMS the control for the deployment that first adds
        // a pattern.
        optionalClaims: ['oid', 'email', 'name', 'preferred_username', 'upn'],
        // Per-provider override of the entra preset's expirationThreshold:1800
        // (defu leftmost-priority in the module's _useSession) — without it every
        // API request in the last 30 min of a token's life pays a synchronous
        // Entra refresh. docs/design/request-floor-performance.md F7.
        sessionConfiguration: { expirationThreshold: 300 },
      },
    },
  },

  // Security headers via nuxt-security. CSP frame-ancestors set to
  // 'none' (clickjacking defense — TokenScope is never iframed by
  // design); 'unsafe-inline' on style-src remains a known Epic-3
  // baseline gap that @nuxt/ui v4 requires.
  //
  // Rate limiter — default 150 req/5min/IP is too tight for the E2E
  // suite (single localhost IP, many dev-login cycles + API hits per
  // test). Disable in dev mode (`NUXT_OIDC_AUTH_DEV_MODE=true`); keep
  // default in sandbox/prod.
  //
  // IP keying (CORE-4): nuxt-security's default keys the bucket on the FIRST
  // X-Forwarded-For hop, which is CLIENT-controlled behind Azure Front Door
  // (AFD *appends* its hop) — a caller rotating fake XFF values bypasses the
  // limit, and pinning a victim's IP exhausts their bucket. `ipHeader` (v2.5+)
  // names a single trustworthy header instead. The trust gate is the SAME as
  // getPublicRequestURL / require-front-door: only when AZURE_FRONT_DOOR_ID is
  // enforced do requests carry AFD's headers, and the one to key on is
  // X-Azure-SocketIP (the TCP peer AFD saw). X-Azure-ClientIP is NOT
  // authoritative: it follows a caller's X-Forwarded-For (see
  // server/api/v1/oauth/register.post.ts). That is a RUNTIME condition and this file
  // is evaluated at BUILD time (see the OIDC note above), so we declare the
  // ipHeader slot as an empty placeholder ('' → falls back to the default
  // resolution) and let the runtime-config overlay fill it: deployments that
  // set AZURE_FRONT_DOOR_ID must also set
  //   NUXT_SECURITY_RATE_LIMITER_IP_HEADER=x-azure-socketip
  // (Bicep sets both together; without AFD the placeholder keeps local /
  // phase-1 behaviour unchanged).
  security: {
    headers: {
      contentSecurityPolicy: {
        'img-src': ["'self'", 'data:'],
        'font-src': ["'self'", 'https://fonts.gstatic.com', 'data:'],
        'style-src': ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
        'frame-ancestors': ["'none'"],
      },
      crossOriginEmbedderPolicy: 'unsafe-none',
    },
    // Bounded high limit in dev mode rather than full disable so a stray
    // test loop still trips an upper bound. Production keeps the
    // nuxt-security defaults (150/5min). `ipHeader: ''` is a runtime-override
    // SLOT, not a working value: empty is falsy so nuxt-security falls back to
    // the spoofable first-XFF hop until the deployment sets
    // NUXT_SECURITY_RATE_LIMITER_IP_HEADER=x-azure-socketip — wired in lockstep
    // with AZURE_FRONT_DOOR_ID in infra/modules/container-app.bicep (CORE-4).
    rateLimiter:
      process.env.NUXT_OIDC_AUTH_DEV_MODE === 'true'
        ? { tokensPerInterval: 5000, interval: 'second', ipHeader: '' }
        : { tokensPerInterval: 150, interval: 300_000, ipHeader: '' },
  },

  routeRules: {
    // API responses carry credentials and per-person data, so no shared cache
    // may keep them. Nitro sets route-rule headers before the handler runs, so a
    // handler that sets its own Cache-Control (report-cache's `private, max-age`,
    // the plugin files' `immutable`) still wins.
    '/api/**': { headers: { 'cache-control': 'no-store' } },
    // /api/health is probed by Container Apps' internal LB directly (no AFD →
    // no X-Azure-SocketIP). With ipHeader keying, every probe would share the
    // '' bucket and a 429'd health probe restart-loops the replicas — exempt
    // it (it is also the one path require-front-door excludes). nuxt-security
    // matches the path without its query, so this also covers the liveness
    // probe's /api/health?probe=live.
    '/api/health': { security: { rateLimiter: false } },
    // The consent page delivers an approved code to the MCP client's loopback in
    // a popup and closes it once the outcome is known (#478): on redeemed, and on
    // undelivered, where the popup shows a browser error over the paste-back
    // steps. Under the default COOP `same-origin` the popup's cross-origin
    // navigation severs this page's handle and close() does nothing.
    // `same-origin-allow-popups` keeps the handle for popups this page opens;
    // the only ones it opens are the client's own loopback callback, whose
    // opener is cleared before it navigates. Every other page keeps the default.
    '/oauth/authorize': { security: { headers: { crossOriginOpenerPolicy: 'same-origin-allow-popups' } } },
  },

  nitro: {
    // Build-time compression of the hashed /_nuxt assets; the node server
    // serves the .br/.gz siblings with Content-Encoding on every environment
    // — including Dev, which has no Front Door to compress for it
    // (docs/design/performance-observability-baseline.md O6a, dr-H10; the
    // 2026-08-20 cold-load capture moved 2.2 MB for 2.5 MB of resources).
    compressPublicAssets: { gzip: true, brotli: true },
  },
})
