<script setup lang="ts">
/*
 * Project allocation editor / list (Journey 4 / design-notes §Screen 4).
 *
 * Lists allocations; per-row "Edit" navigates to a deeper editor
 * (deferred — single-row form is Epic 9 polish). For Epic 8 the list
 * surface + create-CTA placeholder satisfy the verifiable end state.
 */
import { computed } from 'vue'
import { isOrgWideRole } from '#shared/auth/roles'
import { apiErrorDetail, isConfirmedRejection } from '../../composables/useApiError'

interface AllocRow {
  id: string
  scope_type: string
  scope_id: string
  budget_usd: string
  effective: string
  allocation_kind: string
  project_code: string | null
  project_display_name: string | null
}

const { data, error, refresh } = useFetch<{ allocations: AllocRow[] }>('/api/v1/allocations', {
  default: () => ({ allocations: [] }),
})

/*
 * Empty, refused and failed are three answers. `default` fills `data` with an
 * empty list even when the read failed, so the error is checked first: a 403
 * must never read as "No allocations yet". Refused = the server answered with a
 * 4xx and a reason (isConfirmedRejection); anything else is a failure, and then
 * we cannot know what the list holds.
 */
const loadState = computed<'refused' | 'failed' | null>(() => {
  if (!error.value) return null
  return isConfirmedRejection(error.value) ? 'refused' : 'failed'
})
const refusedForbidden = computed(
  () => (error.value as { statusCode?: number } | null)?.statusCode === 403,
)
const refusedDetail = computed(() => apiErrorDetail(error.value, 'none').replace(/\.$/, ''))

// Label the scope so this list and the region-scoped /admin tabs don't look
// contradictory. Per the live allocation-scope predicate
// (server/auth/allocation-scope.ts): only platform-admin is unbounded; a Region
// admin sees every project in THEIR OWN region; a manager sees their part of
// the org.
const { session } = useSession()
const scopeNote = computed(() => {
  const r = session.value?.role
  if (isOrgWideRole(r)) return 'Showing projects across all regions (org-wide).'
  if (r === 'admin') return 'Showing every project in your region.'
  return 'Showing the projects in your part of the org.'
})

// Money cells use the shared guarded formatter from ~/composables/useFormat
// (auto-imported, SYS-5) — the local no-separator clone is gone.
</script>

<template>
  <div class="max-w-[1600px] mx-auto px-10 py-8 pb-20">
    <UiPageHead
      eyebrow="Allocations"
      title="Project budgets"
      :sub="`Baseline budgets + top-ups + bursts. ${scopeNote}`"
    >
      <template #actions>
        <NuxtLink to="/projects/new" data-testid="new-project-link">
          <UiButton kind="primary" size="sm">
            + New project
          </UiButton>
        </NuxtLink>
      </template>
    </UiPageHead>

    <UiCard flush data-testid="allocation-list">
      <table class="w-full text-sm">
        <thead>
          <tr class="bg-brand-harmony-sheer border-b border-calm-2">
            <th class="text-left text-[11px] font-bold uppercase tracking-[1.2px] text-carbon-3 px-5 py-3">Project</th>
            <th class="text-left text-[11px] font-bold uppercase tracking-[1.2px] text-carbon-3 px-5 py-3">Kind</th>
            <th class="text-right text-[11px] font-bold uppercase tracking-[1.2px] text-carbon-3 px-5 py-3">Budget</th>
            <th class="text-left text-[11px] font-bold uppercase tracking-[1.2px] text-carbon-3 px-5 py-3">Effective</th>
            <th class="px-5 py-3"/>
          </tr>
        </thead>
        <tbody>
          <tr v-if="loadState === 'refused'" data-testid="allocations-refused">
            <td colspan="5" class="p-10 text-center text-sm">
              <div class="font-bold text-carbon">
                {{ refusedForbidden ? "You don't have access to project budgets." : 'The server refused to list project budgets.' }}
              </div>
              <div class="text-carbon-3 mt-1">
                <template v-if="refusedForbidden">
                  Project budgets are for managers and admins. This is not an empty list: budgets may exist that you can't see.
                </template>
                <template v-else>Reason given: {{ refusedDetail }}.</template>
              </div>
            </td>
          </tr>
          <tr v-else-if="loadState === 'failed'" data-testid="allocations-failed">
            <td colspan="5" class="p-10 text-center text-sm">
              <div class="font-bold text-carbon">Project budgets didn't load.</div>
              <div class="text-carbon-3 mt-1">
                We couldn't get an answer from the server, so we can't tell which budgets exist.
              </div>
              <UiButton class="mt-3" kind="secondary" size="sm" data-testid="allocations-retry" @click="refresh()">
                Try again
              </UiButton>
            </td>
          </tr>
          <tr v-else-if="(data?.allocations.length ?? 0) === 0" data-testid="allocations-empty">
            <td colspan="5" class="p-10 text-center text-carbon-3 text-sm">
              No project budgets in your scope yet.
            </td>
          </tr>
          <tr
            v-for="r in loadState ? [] : (data?.allocations ?? [])"
            :key="r.id"
            class="border-b border-calm-2 last:border-b-0 hover:bg-brand-harmony-sheer/40"
          >
            <td class="px-5 py-4">
              <div class="font-bold text-carbon">
                {{ r.project_display_name ?? r.scope_id }}
              </div>
              <div class="text-[11px] text-carbon-3 font-mono mt-0.5">
                {{ r.project_code ?? r.scope_type }}
              </div>
            </td>
            <td class="px-5 py-4">
              <UiBadge :kind="r.allocation_kind === 'top-up' ? 'hunger' : 'harmony'">
                {{ r.allocation_kind }}
              </UiBadge>
            </td>
            <td class="text-right px-5 py-4" style="font-variant-numeric: tabular-nums">
              {{ fmtUsd(r.budget_usd) }}
            </td>
            <td class="px-5 py-4 text-xs text-carbon-3 font-mono">
              {{ r.effective }}
            </td>
            <td class="px-5 py-4">
              <NuxtLink
                :to="`/allocations/${r.id}`"
                class="inline-flex items-center gap-2 rounded-lg font-bold tracking-tight whitespace-nowrap px-3 py-1.5 text-xs bg-transparent text-carbon-2 hover:bg-brand-harmony-sheer hover:text-brand-harmony transition-colors cursor-pointer"
                data-testid="allocations-edit-link"
              >
                Edit →
              </NuxtLink>
            </td>
          </tr>
        </tbody>
      </table>
    </UiCard>
  </div>
</template>
