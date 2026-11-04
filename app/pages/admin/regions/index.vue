<script setup lang="ts">
/*
 * Admin → Regions. The list of regions, each owning its own Business Unit
 * tree, projects, and teammates. "Manage" deep-links into the per-region
 * page (/admin/regions/:id).
 *
 * Platform-admins get a "+ New region" CTA that opens an accessible create
 * dialog (role=dialog, aria-modal, aria-labelledby, Escape closes, first
 * field focused on open, focus trap). Non-platform-admins see a note that
 * region creation is platform-admin only — the server enforces the 403.
 *
 * RBAC: client-side guard via useSession() — server middleware still
 * 401/403s a non-admin's API calls; the page just hides itself.
 */

import { computed, ref } from 'vue'
import { consola } from 'consola'
import AdminPageSkeleton from '../../../components/admin/AdminPageSkeleton.vue'
import { useModalA11y } from '../../../composables/useModalA11y'
definePageMeta({ layout: 'admin', middleware: 'admin' })

interface RegionRow {
  id: string
  code: string
  display_name: string
}

const { session } = useSession()

const isAdmin = computed(() => {
  const r = session.value?.role
  return r === 'admin' || r === 'platform-admin'
})
const isPlatformAdmin = computed(() => session.value?.role === 'platform-admin')

// Declared lazily, never awaited: navigation is never gated on data, and the
// skeleton keys on ABSENT data, not `pending` (docs/design/admin-nav-responsiveness.md D1/D2).
// `fetchError` — the dialog owns the `error` name below.
const { data, error: fetchError, refresh } = useLazyFetch<{ regions: RegionRow[] } | null>(
  '/api/v1/admin/regions',
  {
    server: false,
    default: () => null,
    immediate: isAdmin.value,
  },
)
const regions = computed(() => data.value?.regions ?? [])
const skeleton = computed(() => !fetchError.value && data.value == null)

// ── Create dialog ─────────────────────────────────────────────────────
// role=dialog + aria-modal + aria-labelledby; keyboard handling is useModalA11y.
const open = ref(false)
const code = ref('')
const displayName = ref('')
const saving = ref(false)
const error = ref<string | null>(null)
const firstField = ref<HTMLInputElement | null>(null)
const dialogEl = ref<HTMLElement | null>(null)
const titleId = 'region-create-title'
function openDialog() {
  code.value = ''
  displayName.value = ''
  error.value = null
  open.value = true
}

function closeDialog() {
  open.value = false
}

// The shared dialog contract: Escape closes, Tab is trapped in the dialog,
// the first field is focused on open and focus returns on close.
useModalA11y({
  isOpen: () => open.value,
  dialogEl,
  firstField,
  onClose: closeDialog,
})

async function createRegion() {
  saving.value = true
  error.value = null
  try {
    await $fetch('/api/v1/admin/regions', {
      method: 'POST',
      body: { code: code.value.trim(), display_name: displayName.value.trim() },
    })
    await refresh()
    closeDialog()
  } catch (err) {
    error.value = apiErrorDetail(err, 'Region create refused.')
    consola.warn('region create failed', err)
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <div v-if="isAdmin" class="max-w-[1600px] mx-auto px-10 py-8 pb-20" data-testid="admin-regions" data-admin-page="/admin/regions">
    <UiPageHead
      eyebrow="Administration"
      title="Regions"
      sub="Each region owns its Business Unit tree, projects, and teammates."
    />

    <div class="mb-4 flex items-center justify-between gap-3">
      <p v-if="!isPlatformAdmin" class="text-xs text-carbon-3">
        Only an Admin can add regions.
      </p>
      <span v-else />
      <UiButton
        v-if="isPlatformAdmin"
        kind="primary"
        size="sm"
        data-testid="region-create-open"
        @click="openDialog"
      >
        + New region
      </UiButton>
    </div>

    <UiFetchErrorBanner v-if="fetchError" :error="fetchError" label="regions" @retry="refresh" />
    <AdminPageSkeleton v-else-if="skeleton" :rows="4" :toolbar="false" />
    <UiCard v-else flush data-testid="regions-list">
      <div v-if="regions.length === 0">
        <UiEmptyState
          headline="No regions yet"
          sub="No regions are on file."
        />
      </div>
      <div v-else class="overflow-x-auto">
        <table class="w-full text-sm">
          <thead>
            <tr class="bg-brand-harmony-sheer/40 border-b border-calm-2">
              <th class="text-left text-[11px] font-bold uppercase tracking-[1.2px] text-carbon-3 px-5 py-3">
                Code
              </th>
              <th class="text-left text-[11px] font-bold uppercase tracking-[1.2px] text-carbon-3 px-5 py-3">
                Name
              </th>
              <th class="px-5 py-3"><span class="sr-only">Actions</span></th>
            </tr>
          </thead>
          <tbody class="divide-y divide-calm-2">
            <tr
              v-for="r in regions"
              :key="r.id"
              :data-testid="`region-row-${r.code}`"
              class="hover:bg-brand-harmony-sheer/30"
            >
              <td class="px-5 py-3 text-sm text-carbon font-mono">{{ r.code }}</td>
              <td class="px-5 py-3 text-sm text-carbon font-medium">{{ r.display_name }}</td>
              <td class="px-5 py-3 text-right whitespace-nowrap">
                <NuxtLink
                  :to="`/admin/regions/${r.id}`"
                  :data-testid="`region-manage-${r.code}`"
                  class="text-sm font-semibold text-brand-harmony hover:underline"
                >
                  Manage →
                </NuxtLink>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </UiCard>

    <div
      v-if="open"
      class="fixed inset-0 z-50 flex items-center justify-center bg-carbon/40 p-4"
      data-testid="region-create-modal"
      @click.self="closeDialog"
    >
      <div
        ref="dialogEl"
        class="w-full max-w-md bg-white rounded-xl shadow-xl"
        role="dialog"
        aria-modal="true"
        :aria-labelledby="titleId"
      >
        <div class="px-6 py-4 border-b border-calm-2 flex items-start justify-between gap-4">
          <div>
            <p class="text-xs font-bold uppercase tracking-[1.4px] text-brand-harmony">
              New region
            </p>
            <h2 :id="titleId" class="text-lg font-bold text-carbon mt-0.5">
              Add a region
            </h2>
          </div>
          <UiButton kind="ghost" size="sm" data-testid="region-create-close" @click="closeDialog">Close</UiButton>
        </div>
        <div class="px-6 py-4">
          <label for="region-create-code" class="text-[12px] font-semibold text-carbon">Code</label>
          <input
            id="region-create-code"
            ref="firstField"
            v-model="code"
            placeholder="e.g. apac, emea"
            class="mt-1 mb-3 w-full px-3 py-2 text-sm border border-calm-2 rounded-md bg-white font-mono focus:border-brand-harmony"
            data-testid="region-create-code"
          >

          <label for="region-create-name" class="text-[12px] font-semibold text-carbon">Display name</label>
          <input
            id="region-create-name"
            v-model="displayName"
            placeholder="e.g. Asia-Pacific"
            class="mt-1 w-full px-3 py-2 text-sm border border-calm-2 rounded-md bg-white focus:border-brand-harmony"
            data-testid="region-create-name"
            @keyup.enter="createRegion"
          >

          <p v-if="error" class="text-xs text-rag-red mt-3" data-testid="region-create-error" role="alert">{{ error }}</p>

          <div class="flex justify-end gap-2 mt-5">
            <UiButton kind="ghost" data-testid="region-create-cancel" @click="closeDialog">Cancel</UiButton>
            <UiButton kind="primary" :disabled="saving" data-testid="region-create-submit" @click="createRegion">
              {{ saving ? 'Saving…' : 'Create region' }}
            </UiButton>
          </div>
        </div>
      </div>
    </div>
  </div>
  <div v-else class="max-w-[1600px] mx-auto px-10 py-16 text-center" data-admin-page="/admin/regions">
    <div class="text-lg font-bold text-carbon">Admin access required.</div>
  </div>
</template>
