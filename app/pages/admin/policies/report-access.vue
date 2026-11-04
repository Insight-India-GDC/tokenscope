<script setup lang="ts">
/*
 * Admin → Policies → Report access. Per-teammate report-access grants (mig
 * 0129, task #19) — replaces the retired org-wide report-visibility dial.
 *
 * ORG-WIDE ONLY, end to end (post external design review, amendment B1): the
 * server-side endpoints are requireRole(event, 'platform-admin') with no
 * region-admin read access at all (a per-teammate grant list is a narrower,
 * more sensitive surface than the retired org-wide dial was). The sidebar
 * item is 'org-wide' too, so a region admin sees this page locked with a hint
 * rather than a page whose every action 403s — same pattern as
 * /admin/department-map.
 */
import { useAdminAccess } from '../../../composables/useAdminAccess'
import type { ReportAccessData } from '../../../components/admin/ReportAccessSection.vue'

definePageMeta({ layout: 'admin', middleware: 'admin' })

const { isOrgWide } = useAdminAccess()

// Lazy, client-only, null default: docs/design/admin-nav-responsiveness.md D1/D2.
const { data, error, refresh } = useLazyFetch<ReportAccessData | null>('/api/v1/admin/report-access', {
  server: false,
  default: () => null,
  immediate: isOrgWide.value,
})
</script>

<template>
  <div v-if="isOrgWide" class="max-w-[1600px] mx-auto px-10 py-8 pb-20" data-testid="admin-policy-report-access" data-admin-page="/admin/policies/report-access">
    <UiPageHead
      eyebrow="Policies"
      title="Report access"
      sub="Grant a named teammate company-wide reporting access, on top of what their role already sees."
    />
    <UiFetchErrorBanner v-if="error" :error="error" label="report access grants" @retry="refresh" />
    <AdminPageSkeleton v-else-if="data == null" :rows="5" />
    <AdminReportAccessSection v-else :data="data" @changed="refresh()" />
  </div>
  <div v-else class="max-w-[1600px] mx-auto px-10 py-16 text-center" data-admin-page="/admin/policies/report-access">
    <div class="text-lg font-bold text-carbon">Admin access required.</div>
  </div>
</template>
