<script setup lang="ts">
/*
 * Admin → System info. The read-only configuration that used to sit at the top
 * of the old /admin/settings junk drawer: Auth flags, Entra (public) IDs, the
 * caller's region, the running build, and feature flags. No secrets are ever
 * surfaced. Editable policy surfaces moved to /admin/policies/*.
 */
import { computed } from 'vue'
import { useAdminAccess } from '../../composables/useAdminAccess'
import { policyNavItemsFor } from '#shared/nav/admin-nav'

definePageMeta({ layout: 'admin', middleware: 'admin' })

interface SettingsResp {
  auth: {
    devMode: boolean
    allowPersonaOverride: boolean
    // S8: the address itself is no longer served — knowing WHETHER a bootstrap
    // admin is configured is the operational question; the address is an
    // account identifier the region-admin tier has no reason to read.
    bootstrapAdminConfigured: boolean
    deployEnv: string
    demoCapable: boolean
  }
  build: { commitSha: string | null }
  sessionStore: {
    driver: string
    durable: boolean
    reachable: boolean
    error: string | null
    sessions: number
    probes: number
    newestSessionAt: string | null
  }
  entra: { tenantId: string; clientId: string; redirectUri: string }
  features: Record<string, boolean>
  region: { id: string; code: string; displayName: string } | null
  nodeEnv: string
}

const { isAdmin, role } = useAdminAccess()
// The sidebar's Policies group, filtered to what this role can open, so the
// two lists cannot drift apart again.
const policyLinks = computed(() => policyNavItemsFor(role.value))

// Lazy, client-only, null default: docs/design/admin-nav-responsiveness.md D1/D2.
const { data, error, refresh } = useLazyFetch<SettingsResp | null>('/api/v1/admin/settings', {
  server: false,
  default: () => null,
  immediate: isAdmin.value,
})

const flagBadge = (v: boolean) =>
  v ? { kind: 'rag-amber' as const, label: 'on' } : { kind: 'neutral' as const, label: 'off' }
</script>

<template>
  <div class="max-w-[1600px] mx-auto px-10 py-8 pb-20" data-testid="admin-system" data-admin-page="/admin/system">
    <UiPageHead
      eyebrow="Operations"
      title="System info"
      sub="Read-only public configuration. Secret material is never surfaced here."
    />

    <!-- Looking for an editable setting? It moved to Policies. Cross-link so
         anyone redirected here from the old /admin/settings finds it. -->
    <div class="mb-6 p-4 rounded-lg border border-calm-2 bg-calm-1/40" data-testid="system-policies-links">
      <p class="text-xs font-semibold text-carbon-2 mb-2">Editable settings live under <span class="text-carbon">Policies</span>:</p>
      <div class="flex flex-wrap gap-x-4 gap-y-1 text-sm">
        <NuxtLink
          v-for="l in policyLinks"
          :key="l.to"
          :to="l.to"
          class="text-brand-harmony hover:underline"
          :data-testid="`system-policy-link-${l.testid}`"
        >{{ l.label }}</NuxtLink>
      </div>
    </div>

    <UiFetchErrorBanner v-if="error" :error="error" label="system info" @retry="refresh" />
    <AdminPageSkeleton v-else-if="data == null" :rows="8" :toolbar="false" />
    <div v-else class="grid grid-cols-1 lg:grid-cols-2 gap-5">
      <!-- Auth -->
      <UiCard accent="harmony" data-testid="admin-settings-auth">
        <UiEyebrow>Auth</UiEyebrow>
        <h2 class="text-lg font-bold text-carbon mt-1 mb-4">Sign-in + persona</h2>
        <dl class="space-y-3 text-sm">
          <div class="flex items-center justify-between">
            <dt class="text-carbon-2">Dev mode</dt>
            <dd><UiBadge :kind="flagBadge(data.auth.devMode).kind">{{ flagBadge(data.auth.devMode).label }}</UiBadge></dd>
          </div>
          <div class="flex items-center justify-between">
            <dt class="text-carbon-2">Persona override</dt>
            <dd><UiBadge :kind="flagBadge(data.auth.allowPersonaOverride).kind">{{ flagBadge(data.auth.allowPersonaOverride).label }}</UiBadge></dd>
          </div>
          <div class="flex items-center justify-between">
            <dt class="text-carbon-2">Deploy env</dt>
            <dd class="font-mono text-xs text-carbon" data-testid="admin-settings-deploy-env">{{ data.auth.deployEnv }}</dd>
          </div>
          <div class="flex items-center justify-between">
            <dt class="text-carbon-2">Demo features</dt>
            <dd data-testid="admin-settings-demo-capable">
              <UiBadge :kind="data.auth.demoCapable ? 'rag-amber' : 'rag-green'">
                {{ data.auth.demoCapable ? 'Demo-capable (local/sandbox)' : 'Locked down' }}
              </UiBadge>
            </dd>
          </div>
          <div class="flex items-center justify-between">
            <dt class="text-carbon-2">Bootstrap admin</dt>
            <dd class="font-mono text-xs text-carbon" data-testid="admin-settings-bootstrap-admin">
              {{ data.auth.bootstrapAdminConfigured ? 'configured' : 'not configured' }}
            </dd>
          </div>
          <div class="flex items-center justify-between">
            <dt class="text-carbon-2">NODE_ENV</dt>
            <dd class="font-mono text-xs text-carbon">{{ data.nodeEnv }}</dd>
          </div>
        </dl>
      </UiCard>

      <!-- Entra -->
      <UiCard accent="vision" data-testid="admin-settings-entra">
        <UiEyebrow>Entra ID (public)</UiEyebrow>
        <h2 class="text-lg font-bold text-carbon mt-1 mb-4">OIDC provider</h2>
        <dl class="space-y-3 text-sm">
          <div>
            <dt class="text-carbon-2 mb-1">Tenant ID</dt>
            <dd class="font-mono text-xs text-carbon break-all">{{ data.entra.tenantId || '—' }}</dd>
          </div>
          <div>
            <dt class="text-carbon-2 mb-1">Client ID</dt>
            <dd class="font-mono text-xs text-carbon break-all">{{ data.entra.clientId || '—' }}</dd>
          </div>
          <div>
            <dt class="text-carbon-2 mb-1">Redirect URI</dt>
            <dd class="font-mono text-xs text-carbon break-all">{{ data.entra.redirectUri || '—' }}</dd>
          </div>
        </dl>
        <p class="text-[11px] text-carbon-3 mt-4 leading-relaxed italic">
          Client secret is held in Key Vault and never surfaced through this endpoint.
        </p>
      </UiCard>

      <!-- Region -->
      <UiCard accent="zeal" data-testid="admin-settings-region">
        <UiEyebrow>Region</UiEyebrow>
        <h2 class="text-lg font-bold text-carbon mt-1 mb-4">Your active region</h2>
        <dl v-if="data.region" class="space-y-3 text-sm">
          <div class="flex items-center justify-between">
            <dt class="text-carbon-2">Code</dt>
            <dd class="font-mono text-xs text-carbon">{{ data.region.code }}</dd>
          </div>
          <div class="flex items-center justify-between">
            <dt class="text-carbon-2">Display name</dt>
            <dd class="text-carbon">{{ data.region.displayName }}</dd>
          </div>
          <div>
            <dt class="text-carbon-2 mb-1">Region ID</dt>
            <dd class="font-mono text-[11px] text-carbon-3 break-all">{{ data.region.id }}</dd>
          </div>
        </dl>
        <p v-else class="text-sm text-carbon-3 italic">No region assigned to this session.</p>
      </UiCard>

      <!-- Build -->
      <UiCard accent="vision" data-testid="admin-settings-build">
        <UiEyebrow>Build</UiEyebrow>
        <h2 class="text-lg font-bold text-carbon mt-1 mb-4">Running revision</h2>
        <dl class="space-y-3 text-sm">
          <div>
            <dt class="text-carbon-2 mb-1">Commit SHA</dt>
            <dd
              class="font-mono text-xs break-all"
              :class="data.build.commitSha ? 'text-carbon' : 'text-carbon-3 italic'"
              data-testid="admin-settings-build-commit-sha"
            >{{ data.build.commitSha ?? 'unknown' }}</dd>
          </div>
        </dl>
        <p class="text-[11px] text-carbon-3 mt-4 leading-relaxed italic">
          Commit SHA is baked into the image at build time and may be overridden at deploy time
          via the GIT_COMMIT_SHA env var. <code class="font-mono">unknown</code> means neither path populated a value.
        </p>
      </UiCard>

      <!-- Session store (mig 0097) -->
      <UiCard
        :accent="data.sessionStore.durable && data.sessionStore.reachable ? 'harmony' : 'zeal'"
        data-testid="admin-session-store"
      >
        <UiEyebrow>Session store</UiEyebrow>
        <h2 class="text-lg font-bold text-carbon mt-1 mb-4">Sign-in durability</h2>
        <dl class="space-y-3 text-sm">
          <div>
            <dt class="text-carbon-2 mb-1">Status</dt>
            <dd
              class="font-semibold"
              :class="data.sessionStore.durable && data.sessionStore.reachable ? 'text-rag-green' : 'text-rag-red'"
              data-testid="admin-session-store-status"
            >
              <template v-if="data.sessionStore.durable && data.sessionStore.reachable">
                Durable — sessions survive deploys and extra replicas
              </template>
              <template v-else-if="!data.sessionStore.durable">
                IN-MEMORY — every deploy signs everyone out, and users loop at /login once a second replica runs
              </template>
              <template v-else>
                Mounted but unreachable — sign-in will error
              </template>
            </dd>
          </div>
          <div>
            <dt class="text-carbon-2 mb-1">Driver</dt>
            <dd class="font-mono text-xs text-carbon" data-testid="admin-session-store-driver">
              {{ data.sessionStore.driver }}
            </dd>
          </div>
          <div>
            <dt class="text-carbon-2 mb-1">Live rows</dt>
            <dd class="text-carbon" data-testid="admin-session-store-rows">
              {{ data.sessionStore.sessions }} session{{ data.sessionStore.sessions === 1 ? '' : 's' }} ·
              {{ data.sessionStore.probes }} boot probe{{ data.sessionStore.probes === 1 ? '' : 's' }}
            </dd>
          </div>
          <div v-if="data.sessionStore.error">
            <dt class="text-carbon-2 mb-1">Error</dt>
            <dd class="text-xs text-rag-red break-all" data-testid="admin-session-store-error">
              {{ data.sessionStore.error }}
            </dd>
          </div>
        </dl>
        <p class="text-[11px] text-carbon-3 mt-4 leading-relaxed italic">
          Checked live on each load: a write and read-back through whatever driver is actually
          mounted — which reaches <code class="font-mono">kv_store</code> only when the status above
          says Durable. That distinction is the point: an in-memory fallback passes the round trip
          too, which is why it is reported separately rather than as one "healthy". Row counts come
          from <code class="font-mono">kv_store</code>; one boot probe row appears per replica that
          started recently, so this also shows how many replicas are serving.
        </p>
      </UiCard>

      <!-- Features -->
      <UiCard accent="hunger" class="lg:col-span-2" data-testid="admin-settings-features">
        <UiEyebrow>Features</UiEyebrow>
        <h2 class="text-lg font-bold text-carbon mt-1 mb-4">Feature flags</h2>
        <p v-if="Object.keys(data.features).length === 0" class="text-sm text-carbon-3 italic">
          No feature flags wired yet. This panel is a placeholder for a later slice.
        </p>
        <dl v-else class="space-y-2 text-sm">
          <div v-for="(v, k) in data.features" :key="k" class="flex items-center justify-between">
            <dt class="text-carbon-2 font-mono text-xs">{{ k }}</dt>
            <dd><UiBadge :kind="v ? 'rag-green' : 'neutral'">{{ v ? 'on' : 'off' }}</UiBadge></dd>
          </div>
        </dl>
      </UiCard>
    </div>
  </div>
</template>
