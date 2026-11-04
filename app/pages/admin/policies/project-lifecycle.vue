<script setup lang="ts">
/*
 * Admin → Policies → Project lifecycle. The platform end-date cadence (grace +
 * warning window). Editable by org-wide admins; region admins see it read-only
 * (they override on their own region page). Split out of /admin/settings.
 */
import { ref, watch } from 'vue'
import { useAdminAccess } from '../../../composables/useAdminAccess'
import { apiErrorDetail } from '../../../composables/useApiError'

definePageMeta({ layout: 'admin', middleware: 'admin' })

const { isAdmin, isOrgWide } = useAdminAccess()

interface LifecycleResp {
  platform: { grace_hours: number; warn_days: number }
}
// Lazy, client-only, null default: docs/design/admin-nav-responsiveness.md D1/D2.
const {
  data: lifecycle,
  error: lifecycleFetchError,
  refresh: refreshLifecycle,
} = useLazyFetch<LifecycleResp | null>('/api/v1/admin/settings/project-lifecycle', {
  server: false,
  default: () => null,
  immediate: isAdmin.value,
})

const graceHours = ref<number | null>(null)
const warnDays = ref<number | null>(null)
watch(
  lifecycle,
  (v) => {
    if (v) {
      graceHours.value = v.platform.grace_hours
      warnDays.value = v.platform.warn_days
    }
  },
  { immediate: true },
)

const savingLifecycle = ref(false)
const lifecycleError = ref<string | null>(null)
const lifecycleSaved = ref(false)
async function saveLifecycle() {
  if (graceHours.value === null || warnDays.value === null) return
  savingLifecycle.value = true
  lifecycleError.value = null
  try {
    await $fetch('/api/v1/admin/settings/project-lifecycle', {
      method: 'PUT',
      body: { grace_hours: graceHours.value, warn_days: warnDays.value },
    })
    lifecycleSaved.value = true
    setTimeout(() => (lifecycleSaved.value = false), 3000)
    await refreshLifecycle()
  } catch (e: unknown) {
    lifecycleError.value = apiErrorDetail(e, 'Save failed')
  } finally {
    savingLifecycle.value = false
  }
}
</script>

<template>
  <div class="max-w-[1600px] mx-auto px-10 py-8 pb-20" data-testid="admin-policy-project-lifecycle" data-admin-page="/admin/policies/project-lifecycle">
    <UiPageHead
      eyebrow="Policies"
      title="Project lifecycle"
      sub="Platform defaults for the project end-date model. Regions can override these on their region page."
    />
    <UiFetchErrorBanner v-if="lifecycleFetchError" :error="lifecycleFetchError" label="the project lifecycle policy" @retry="refreshLifecycle" />
    <AdminPageSkeleton v-else-if="lifecycle == null" :rows="3" :toolbar="false" class="max-w-2xl" />
    <UiCard v-else accent="zeal" class="max-w-2xl" data-testid="admin-settings-lifecycle">
      <UiEyebrow>End-date cadence</UiEyebrow>
      <div class="space-y-3 text-sm mt-3">
        <div>
          <label for="lifecycle-grace" class="text-[12px] font-semibold text-carbon">
            Grace — hours after a project ends before in-flight spend spills to unallocated
          </label>
          <input
            id="lifecycle-grace"
            v-model.number="graceHours"
            type="number"
            min="0"
            max="168"
            :disabled="!isOrgWide"
            data-testid="admin-settings-lifecycle-grace"
            class="mt-1 w-full px-3 py-2 text-sm border border-calm-2 rounded-md focus:border-brand-harmony disabled:bg-calm-1 disabled:text-carbon-3"
          >
        </div>
        <div>
          <label for="lifecycle-warn" class="text-[12px] font-semibold text-carbon">
            Warning window — days before the end date to warn assigned developers
          </label>
          <input
            id="lifecycle-warn"
            v-model.number="warnDays"
            type="number"
            min="1"
            max="90"
            :disabled="!isOrgWide"
            data-testid="admin-settings-lifecycle-warn"
            class="mt-1 w-full px-3 py-2 text-sm border border-calm-2 rounded-md focus:border-brand-harmony disabled:bg-calm-1 disabled:text-carbon-3"
          >
        </div>
        <p v-if="lifecycleError" class="text-xs text-rag-red" role="alert">{{ lifecycleError }}</p>
        <p v-if="lifecycleSaved" class="text-xs text-brand-harmony" data-testid="admin-settings-lifecycle-saved">Saved.</p>
        <div v-if="isOrgWide" class="flex justify-end">
          <UiButton
            kind="primary"
            size="sm"
            :disabled="savingLifecycle"
            data-testid="admin-settings-lifecycle-save"
            @click="saveLifecycle"
          >
            {{ savingLifecycle ? 'Saving…' : 'Save' }}
          </UiButton>
        </div>
        <p v-else class="text-[11px] text-carbon-3 italic">
          Only platform / global-finance admins can change the platform default. You can override it for your region on its page.
        </p>
      </div>
    </UiCard>
  </div>
</template>
