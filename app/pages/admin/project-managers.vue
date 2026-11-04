<script setup lang="ts">
/*
 * Admin → Project managers: the PMO list (docs/design/project-requests/00-spec.md
 * §1). People on it create projects in any region without approval, unless the
 * own-region switch (Detection thresholds → governance dials) limits them to
 * their current region. Platform admin only (A3).
 */
import { ref } from 'vue'
import TeammatePicker, { type PickedTeammate } from '../../components/projects/TeammatePicker.vue'
import { useAdminAccess } from '../../composables/useAdminAccess'
import { apiErrorDetail } from '../../composables/useApiError'

definePageMeta({ layout: 'admin', middleware: 'admin' })

interface Grant {
  id: string
  teammate_id: string
  display_name: string | null
  email: string
  region_code: string | null
  is_active: boolean
  granted_by_name: string | null
  granted_at: string
  note: string | null
}

const { isPlatform } = useAdminAccess()

const { data, error, refresh } = useLazyFetch<{ grants: Grant[] } | null>('/api/v1/admin/project-managers', {
  server: false,
  default: () => null,
  immediate: isPlatform.value,
})

const picked = ref<PickedTeammate | null>(null)
const note = ref('')
const adding = ref(false)
const message = ref<{ kind: 'ok' | 'err'; text: string } | null>(null)

async function add() {
  if (!picked.value) return
  adding.value = true
  message.value = null
  const who = picked.value.display_name ?? picked.value.email
  try {
    await $fetch('/api/v1/admin/project-managers', {
      method: 'POST',
      body: { teammate_id: picked.value.id, ...(note.value.trim() ? { note: note.value.trim() } : {}) },
    })
    message.value = { kind: 'ok', text: `${who} can now create projects.` }
    picked.value = null
    note.value = ''
    await refresh()
  } catch (e) {
    message.value = { kind: 'err', text: apiErrorDetail(e, 'Could not add them.') }
  } finally {
    adding.value = false
  }
}

const armedId = ref<string | null>(null)
const busyId = ref<string | null>(null)
async function revoke(g: Grant) {
  if (armedId.value !== g.id) {
    armedId.value = g.id
    return
  }
  busyId.value = g.id
  message.value = null
  try {
    await $fetch(`/api/v1/admin/project-managers/${g.id}/revoke`, { method: 'POST' })
    message.value = { kind: 'ok', text: `${g.display_name ?? g.email} was removed. Projects they already manage are unchanged.` }
    armedId.value = null
    await refresh()
  } catch (e) {
    message.value = { kind: 'err', text: apiErrorDetail(e, 'Could not remove them.') }
  } finally {
    busyId.value = null
  }
}
</script>

<template>
  <div v-if="isPlatform" class="max-w-[1200px] mx-auto px-10 py-8 pb-20" data-testid="admin-project-managers" data-admin-page="/admin/project-managers">
    <UiPageHead
      eyebrow="Organisation"
      title="Project managers"
      sub="People on this list create projects without approval and become their project manager. Everyone else requests a project."
    />

    <div
      v-if="message"
      class="mb-4 p-3 rounded-md text-sm font-medium"
      :class="message.kind === 'ok'
        ? 'bg-brand-harmony-sheer text-brand-harmony border border-brand-harmony/30'
        : 'bg-brand-hunger/10 text-brand-heart border border-brand-hunger/30'"
      :data-testid="`project-managers-message-${message.kind}`"
    >
      {{ message.text }}
    </div>

    <UiCard class="mb-6">
      <div class="text-sm font-bold text-carbon mb-2">Add a person</div>
      <div class="grid grid-cols-[1fr_1fr_auto] gap-3 items-start">
        <TeammatePicker v-model="picked" testid="project-managers-picker" />
        <input
          v-model="note"
          type="text"
          maxlength="500"
          placeholder="Note (optional), e.g. the account they run"
          class="w-full px-3 py-2 text-sm border border-calm-2 rounded-md focus:border-brand-harmony"
          data-testid="project-managers-note"
        >
        <UiButton kind="primary" size="sm" :disabled="!picked || adding" data-testid="project-managers-add" @click="add">
          {{ adding ? 'Adding…' : 'Add' }}
        </UiButton>
      </div>
    </UiCard>

    <UiFetchErrorBanner v-if="error" :error="error" label="project managers" @retry="refresh" />
    <AdminPageSkeleton v-else-if="data == null" :rows="4" />
    <UiEmptyState
      v-else-if="!data.grants.length"
      headline="Nobody is on the list yet"
      sub="Until someone is added, only admins create projects; everyone else sends a request."
    />
    <UiCard v-else>
      <ul class="divide-y divide-calm-2" data-testid="project-managers-list">
        <li v-for="g in data.grants" :key="g.id" class="py-3 flex flex-wrap items-center gap-x-6 gap-y-1">
          <div class="min-w-0 flex-1">
            <div class="text-sm font-medium text-carbon">
              {{ g.display_name ?? g.email }}
              <UiBadge v-if="!g.is_active" kind="neutral" class="ml-1">Inactive</UiBadge>
            </div>
            <div class="text-[11px] text-carbon-3">
              {{ g.email }}<template v-if="g.region_code"> · {{ g.region_code }}</template>
              · added {{ new Date(g.granted_at).toLocaleDateString() }}<template v-if="g.granted_by_name"> by {{ g.granted_by_name }}</template>
              <template v-if="g.note"> · {{ g.note }}</template>
            </div>
          </div>
          <div class="flex items-center gap-2">
            <UiButton
              v-if="armedId === g.id && busyId !== g.id"
              kind="ghost"
              size="sm"
              @click="armedId = null"
            >
              Cancel
            </UiButton>
            <UiButton
              kind="ghost"
              size="sm"
              :disabled="busyId === g.id"
              :data-testid="`project-managers-revoke-${g.id}`"
              @click="revoke(g)"
            >
              {{ busyId === g.id ? 'Removing…' : armedId === g.id ? 'Confirm remove?' : 'Remove' }}
            </UiButton>
          </div>
        </li>
      </ul>
    </UiCard>
  </div>
  <div v-else class="max-w-[1200px] mx-auto px-10 py-16 text-center" data-admin-page="/admin/project-managers">
    <div class="text-lg font-bold text-carbon">Admin access required.</div>
  </div>
</template>
