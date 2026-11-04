<script setup lang="ts">
/*
 * Admin home card for Org setup (docs/design/org-setup/00-spec.md, Screens 6). Admin
 * only. "Set up the organisation" before a top person is set; afterwards shown only
 * while there is something to decide. Two lazy client-only reads, never awaited.
 */
import { computed } from 'vue'
import { useAdminAccess } from '../../composables/useAdminAccess'
import { homeCardState } from '../../utils/org-setup-view'
import type { OrgSetupDecisionsResponse, OrgSetupSettings } from '#shared/org-setup/contract'

const { isPlatform } = useAdminAccess()
const platformAtSetup = isPlatform.value

const { data: settings } = useLazyFetch<OrgSetupSettings | null>('/api/v1/admin/org-setup/settings', {
  key: 'admin-home-org-setup-settings',
  server: false,
  default: () => null,
  immediate: platformAtSetup,
})
const { data: decisions } = useLazyFetch<OrgSetupDecisionsResponse | null>('/api/v1/admin/org-setup/decisions', {
  key: 'admin-home-org-setup-decisions',
  server: false,
  default: () => null,
  immediate: platformAtSetup,
})

const state = computed(() => (isPlatform.value ? homeCardState(settings.value, decisions.value) : null))
</script>

<template>
  <NuxtLink v-if="state" to="/admin/org-setup" class="block mb-8 max-w-2xl" data-testid="admin-org-setup-card">
    <UiCard accent="vision" hover>
      <template v-if="state.kind === 'setup'">
        <h2 class="text-lg font-bold text-carbon">Set up the organisation</h2>
        <p class="text-sm text-carbon-2 mt-1">Pick the top of the organisation and place everyone by deciding about their managers.</p>
        <span class="mt-3 inline-flex min-h-[44px] items-center text-sm font-bold text-brand-harmony" data-testid="admin-org-setup-card-start">Start</span>
      </template>
      <template v-else>
        <h2 class="text-lg font-bold text-carbon">Org setup</h2>
        <p class="text-sm text-carbon-2 mt-1" data-testid="admin-org-setup-card-count">
          {{ state.count }} {{ state.count === 1 ? 'thing' : 'things' }} to decide
        </p>
        <ul class="mt-2 text-sm text-carbon list-disc pl-5" data-testid="admin-org-setup-card-titles">
          <li v-for="t in state.titles" :key="t">{{ t }}</li>
        </ul>
        <span class="mt-3 inline-flex min-h-[44px] items-center text-sm font-bold text-brand-harmony">Review</span>
      </template>
    </UiCard>
  </NuxtLink>
</template>
