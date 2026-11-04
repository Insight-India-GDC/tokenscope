<script setup lang="ts">
/*
 * Admin → Overview. A BOUNDED role-aware launcher, not a second navigation: an
 * at-a-glance status strip + a short list of the highest-value common tasks
 * (the ones that were buried deepest in the old flat tile wall). Everything
 * else lives in the persistent sidebar — this page deliberately does NOT
 * re-list it.
 */
import { computed } from 'vue'
import { useAdminAccess } from '../../composables/useAdminAccess'
import OrgSetupHomeCard from '../../components/admin/OrgSetupHomeCard.vue'

definePageMeta({ layout: 'admin', middleware: 'admin' })

const { isAdmin, isOrgWide, isPlatform, regionId, displayName, roleDisplay } = useAdminAccess()

// Every tile is lazy, client-only, null-default and never awaited:
// docs/design/admin-nav-responsiveness.md D1/D2. The users URL getter is '' for
// org-wide admins (no home region), which is the one case D1 gives an explicit
// key + watch.
//
// `immediate` is evaluated ONCE, at setup: a read that was never issued can
// never become busy, so the same captured gate drives both. Without it a tile
// whose read never fired would sit on '…' for ever and announce itself busy.
const adminAtSetup = isAdmin.value

const { data: users, error: usersError, refresh: refreshUsers } = useLazyFetch<{ total: number } | null>(
  () => (regionId.value ? `/api/v1/admin/users?region=${regionId.value}&limit=1` : ''),
  {
    key: 'admin-overview-users',
    server: false,
    default: () => null,
    immediate: !!regionId.value,
    watch: [regionId],
  },
)

const { data: regions, error: regionsError, refresh: refreshRegions } = useLazyFetch<{ regions: { id: string; display_name: string }[] } | null>('/api/v1/admin/regions', {
  key: 'admin-overview-regions',
  server: false,
  default: () => null,
  immediate: adminAtSetup,
})

// The SERVER owns `now` (CLAUDE.md §The clock): this read is client-only, so a
// browser-computed cutoff would let a skewed clock ask for a window the server
// is not serving. The URL is empty until the clock lands; the watch issues the
// request then, and the tile reads busy in the meantime.
const { clock } = useServerClock()
const since24h = computed(() => {
  const now = clock.value?.now
  return now ? new Date(new Date(now).getTime() - 24 * 60 * 60 * 1000).toISOString() : ''
})
const { data: audit, error: auditError, refresh: refreshAudit } = useLazyFetch<{ total: number } | null>(
  () => (since24h.value ? `/api/v1/admin/audit?limit=1&since=${encodeURIComponent(since24h.value)}` : ''),
  {
    key: 'admin-overview-audit',
    server: false,
    default: () => null,
    immediate: false,
    watch: [since24h],
  },
)
const { data: diag, error: diagError, refresh: refreshDiag } = useLazyFetch<{ postgres: { reachable: boolean } } | null>(
  '/api/v1/admin/diagnostics',
  { key: 'admin-overview-diag', server: false, default: () => null, immediate: adminAtSetup },
)
const { data: recon, error: reconError, refresh: refreshRecon } = useLazyFetch<{ summary: { total: number } } | null>(
  '/api/v1/admin/reconciliation/records?limit=1',
  { key: 'admin-overview-recon', server: false, default: () => null, immediate: adminAtSetup },
)

// One of busy / error / value per tile — D2, keyed on the ABSENCE of data, not
// on `pending`. 'na' is the read that was never issued (org-wide admin has no
// home region), which is a real '—', not a pending state.
type TileState = 'busy' | 'error' | 'ready' | 'na'
function tile<T>(issued: boolean, data: T | null | undefined, error: unknown, render: (d: T) => string): { value: string; state: TileState } {
  if (error) return { value: '—', state: 'error' }
  if (data != null) return { value: render(data), state: 'ready' }
  return issued ? { value: '…', state: 'busy' } : { value: '—', state: 'na' }
}

// The teammate count is per region (the users read takes one), so the tile names it.
const homeRegionName = computed(() => regions.value?.regions.find((r) => r.id === regionId.value)?.display_name ?? 'your home region')
const teammatesLabel = computed(() => `Teammates in ${homeRegionName.value}`)

const stats = computed(() => [
  {
    key: 'regions',
    label: 'Regions',
    to: '/admin/regions',
    ...tile(adminAtSetup, regions.value, regionsError.value, (d) => String(d.regions.length)),
  },
  {
    key: 'teammates',
    label: teammatesLabel.value,
    to: '/admin/users',
    ...tile(!!regionId.value, users.value, usersError.value, (d) => String(d.total)),
  },
  {
    key: 'recon',
    label: 'Proposed reconciliation deltas',
    to: '/admin/reconciliation',
    ...tile(adminAtSetup, recon.value, reconError.value, (d) => String(d.summary.total)),
  },
  {
    key: 'audit',
    label: 'Audit events · 24h',
    to: '/admin/audit',
    ...tile(adminAtSetup, audit.value, auditError.value, (d) => String(d.total)),
  },
  {
    key: 'postgres',
    label: 'Postgres',
    to: '/admin/diagnostics',
    ...tile(adminAtSetup, diag.value, diagError.value, (d) => (d.postgres.reachable ? 'ok' : 'down')),
  },
])

// The strip is busy while ANY issued read is still absent, and stops being busy
// the moment every read has landed or failed: the gate
// (docs/design/admin-nav-responsiveness.md D6) fails a busy state that never
// clears, and a permanent '…' is exactly that defect.
const stripBusy = computed(() => stats.value.some((s) => s.state === 'busy'))

// Failure is announced, never rendered as a confident number. One banner for
// the strip; retry refreshes only the reads that actually failed.
const failed = [
  { label: 'Regions', error: regionsError, refresh: refreshRegions },
  { label: 'Teammates', error: usersError, refresh: refreshUsers },
  { label: 'Proposed reconciliation deltas', error: reconError, refresh: refreshRecon },
  { label: 'Audit events · 24h', error: auditError, refresh: refreshAudit },
  { label: 'Postgres', error: diagError, refresh: refreshDiag },
]
const failedReads = computed(() => failed.filter((r) => r.error.value))
const stripError = computed(() => failedReads.value[0]?.error.value ?? null)
const stripErrorLabel = computed(() => failedReads.value.map((r) => r.label).join(', '))
function retryFailed() {
  for (const r of failedReads.value) void r.refresh()
}

// Common tasks — the deepest / most-frequent actions, role-aware. Kept short on
// purpose; the sidebar is the complete surface.
const quickActions = computed(() => {
  const actions = [
    // Org setup is Admin-only; a legacy Region admin keeps their own region's page.
    isPlatform.value
      ? { key: 'org-setup', label: 'Org setup', sub: 'Regions, Business Units, owners and leaders', to: '/admin/org-setup', accent: 'vision' as const }
      : { key: 'region', label: 'Set up your region', sub: 'Business Units, owners, leaders, teammates', to: regionId.value ? `/admin/regions/${regionId.value}` : '/admin/regions', accent: 'vision' as const },
    { key: 'teammates', label: 'Add a teammate', sub: 'Provision someone from the directory', to: '/admin/users', accent: 'harmony' as const },
    { key: 'projects', label: 'Create a project', sub: 'Set a budget and add members', to: '/admin/projects', accent: 'zeal' as const },
    { key: 'reconciliation', label: 'Review reconciliation', sub: 'Runs, deltas and provider onboarding', to: '/admin/reconciliation', accent: 'harmony' as const },
  ]
  if (isOrgWide.value) {
    actions.push({ key: 'report-access', label: 'Report access', sub: 'Grant a teammate company-wide reporting access', to: '/admin/policies/report-access', accent: 'vision' as const })
  }
  return actions
})
</script>

<template>
  <div v-if="isAdmin" class="max-w-[1600px] mx-auto px-10 py-8 pb-20" data-testid="admin-hub" data-admin-page="/admin">
    <UiPageHead
      eyebrow="Administration"
      title="Overview"
      :sub="`Welcome back, ${displayName || roleDisplay}. Here's the organisation at a glance.`"
    />

    <UiFetchErrorBanner v-if="stripError" :error="stripError" :label="stripErrorLabel" @retry="retryFailed" />

    <!-- Status strip -->
    <div
      class="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-4 mb-10"
      data-testid="admin-overview-stats"
      :aria-busy="stripBusy ? 'true' : undefined"
    >
      <span v-if="stripBusy" class="sr-only" role="status">Loading overview status…</span>
      <NuxtLink
        v-for="s in stats"
        :key="s.key"
        :to="s.to"
        :data-testid="`admin-stat-${s.key}`"
        :data-state="s.state"
        class="block p-4 rounded-xl border border-calm-2 bg-paper no-underline hover:border-brand-harmony/40 transition-colors"
      >
        <div class="text-2xl font-bold text-carbon tabular-nums leading-none">{{ s.value }}</div>
        <div class="text-[11px] text-carbon-3 mt-1.5 leading-tight">{{ s.label }}</div>
      </NuxtLink>
    </div>

    <OrgSetupHomeCard />

    <!-- Common tasks -->
    <h2 class="text-base font-bold text-carbon tracking-tight mb-1">Common tasks</h2>
    <p class="text-sm text-carbon-2 mb-4 leading-relaxed">
      The things admins do most. Everything else is in the sidebar on the left.
    </p>
    <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
      <NuxtLink
        v-for="a in quickActions"
        :key="a.key"
        :to="a.to"
        :data-testid="`admin-qa-${a.key}`"
        class="block"
      >
        <UiCard :accent="a.accent" hover>
          <div class="flex items-start justify-between gap-3">
            <h3 class="text-lg font-bold text-carbon leading-snug">{{ a.label }}</h3>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="text-carbon-3 mt-1 shrink-0" aria-hidden="true"><path d="M5 12h14M12 5l7 7-7 7" /></svg>
          </div>
          <p class="text-sm text-carbon-2 mt-2 leading-relaxed">{{ a.sub }}</p>
        </UiCard>
      </NuxtLink>
    </div>
  </div>
  <div v-else class="max-w-[1600px] mx-auto px-10 py-16 text-center" data-admin-page="/admin">
    <div class="text-lg font-bold text-carbon">Admin access required.</div>
    <p class="text-sm text-carbon-2 mt-2">Sign in as an admin to view this page.</p>
  </div>
</template>
