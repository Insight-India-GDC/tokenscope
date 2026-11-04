<script setup lang="ts">
/*
 * New project (Journey 4; docs/design/project-requests/00-spec.md §2). Serves
 * admins and Project Managers (the PMO list). One atomic call creates the
 * project, its PM and its baseline budget: admins post to /admin/projects
 * when the region is in their scope, everyone else to /projects, where the
 * server applies the PMO gate. People who can do neither are pointed at the
 * request form.
 */
import { computed, ref, watch } from 'vue'
import type { Crumb } from '../../components/ui/Breadcrumb.vue'
import TeammatePicker, { type PickedTeammate } from '../../components/projects/TeammatePicker.vue'
import { useAdminAccess } from '../../composables/useAdminAccess'
import { afterCreatePath } from '../../composables/useProjectCreate'
import {
  defaultBudgetPeriod,
  useBusinessUnits,
  useProjectCapabilities,
  utcMidnight,
} from '../../composables/useProjectFormOptions'
import { BU_LABEL } from '#shared/reports/vocabulary'

const { session, ensure } = useSession()
await ensure()
const { isAdmin, isOrgWide } = useAdminAccess()
const { capabilities } = useProjectCapabilities()
const { units, regions: allRegions } = useBusinessUnits()
const { today } = useServerClock()

const isPmo = computed(() => capabilities.value?.can_create_projects === true)
const canCreate = computed(() => isAdmin.value || isPmo.value)
const homeRegionId = computed(() => session.value?.regionId ?? '')

/** Regions this person may create in: an admin's scope, widened by a PMO grant. */
const regionOptions = computed(() => {
  const pmoAnywhere = isPmo.value && !capabilities.value?.pm_own_region_only
  if (isOrgWide.value || pmoAnywhere) return allRegions.value
  return allRegions.value.filter((r) => r.id === homeRegionId.value)
})

const code = ref('')
const displayName = ref('')
const wbsCode = ref('')
const type = ref<'billable' | 'pursuit' | 'internal'>('billable')
const couId = ref('')
const pm = ref<PickedTeammate | null>(null)
const endDate = ref('')
const budgetUsd = ref('')

/*
 * The region and the budget period DEFAULT from data that may land after setup
 * (the picker units, the server clock), so each is derived: the person's pick
 * while it is still valid, else the default. A watcher seeding a ref fired on
 * the client, where the data is already in the payload, but never on the server
 * after setup, so the server rendered no region and an admin got a hydration
 * mismatch ("Project manager" vs "Project manager (optional)": the admin route
 * depends on the region).
 */
const regionPick = ref<string | null>(null)
const regionId = computed<string>({
  get: () => {
    const opts = regionOptions.value
    if (regionPick.value !== null && opts.some((r) => r.id === regionPick.value)) return regionPick.value
    return opts.find((r) => r.id === homeRegionId.value)?.id ?? opts[0]?.id ?? ''
  },
  set: (v) => {
    regionPick.value = v
  },
})
const period = computed(() => (today.value ? defaultBudgetPeriod(today.value) : null))
const fromPick = ref<string | null>(null)
const toPick = ref<string | null>(null)
const fromIso = computed<string>({
  get: () => fromPick.value ?? period.value?.from ?? '',
  set: (v) => {
    fromPick.value = v
  },
})
const toIso = computed<string>({
  get: () => toPick.value ?? period.value?.to ?? '',
  set: (v) => {
    toPick.value = v
  },
})
const couOptions = computed(() => units.value.filter((u) => u.region_id === regionId.value))
watch(regionId, () => {
  if (!couOptions.value.some((u) => u.id === couId.value)) couId.value = ''
})
// A Project Manager becomes the PM by default. An admin's PM is optional, as the
// admin flow has always been: they often set a project up for someone else.
watch(
  [session, isAdmin],
  ([s, admin]) => {
    if (!admin && !pm.value && s?.teammateId && s.email) {
      pm.value = { id: s.teammateId, display_name: s.displayName ?? null, email: s.email }
    }
  },
  { immediate: true },
)

/** Admins use the admin route inside their scope; otherwise the PMO route decides. */
const route = computed<'admin' | 'pmo'>(() =>
  isAdmin.value && (isOrgWide.value || regionId.value === homeRegionId.value) ? 'admin' : 'pmo',
)

const { submitting, error: submitError, outcomeUnknown, submit: submitCreate } = useProjectCreate()

const canSubmit = computed(() => {
  if (submitting.value || !canCreate.value) return false
  if (!code.value.trim() || !displayName.value.trim()) return false
  if (!regionId.value || !couId.value) return false
  if (route.value === 'pmo' && !pm.value) return false
  if (!/^\d+(\.\d{1,2})?$/.test(budgetUsd.value) || Number(budgetUsd.value) <= 0) return false
  if (!fromIso.value || !toIso.value) return false
  return fromIso.value < toIso.value
})

const crumbs = computed<Crumb[]>(() =>
  isAdmin.value
    ? [{ label: 'Allocations', to: '/allocations' }, { label: 'New project' }]
    : [{ label: 'My projects', to: '/projects' }, { label: 'New project' }],
)

async function submit() {
  if (!canSubmit.value) return
  const created = await submitCreate(route.value, {
    code: code.value.trim(),
    display_name: displayName.value.trim(),
    type: type.value,
    region_id: regionId.value,
    cost_owning_unit_id: couId.value,
    ...(pm.value ? { pm_teammate_id: pm.value.id } : {}),
    ...(wbsCode.value.trim() ? { wbs_code: wbsCode.value.trim() } : {}),
    ...(endDate.value ? { end_date: utcMidnight(endDate.value) } : {}),
    budget: { amount_usd: budgetUsd.value, from: utcMidnight(fromIso.value), to: utcMidnight(toIso.value) },
  })
  if (!created) return
  await navigateTo(
    afterCreatePath(route.value, created, { pmId: pm.value?.id ?? null, viewerId: session.value?.teammateId ?? null }),
  )
}
</script>

<template>
  <div class="max-w-[920px] mx-auto px-10 py-8 pb-20">
    <UiPageHead
      eyebrow="Onboarding"
      title="New project"
      sub="Create a project, its project manager and its baseline budget in one step."
    >
      <template #actions>
        <NuxtLink :to="isAdmin ? '/allocations' : '/projects'">
          <UiButton kind="secondary" size="sm">Cancel</UiButton>
        </NuxtLink>
        <UiButton
          v-if="canCreate"
          kind="primary"
          size="sm"
          :disabled="!canSubmit"
          :title="!canSubmit && !submitting ? `Fill in code, name, ${BU_LABEL}, project manager, a positive budget, and a valid period.` : undefined"
          data-testid="new-project-submit"
          @click="submit"
        >
          {{ submitting ? 'Creating…' : 'Create project + budget' }}
        </UiButton>
      </template>
    </UiPageHead>
    <UiBreadcrumb :crumbs="crumbs" class="-mt-6 mb-6" />

    <UiEmptyState
      v-if="capabilities && !canCreate"
      headline="Only Project Managers create projects directly"
      sub="Ask for one instead: an admin reviews the request and creates the project."
      data-testid="new-project-not-allowed"
    >
      <UiButton to="/projects/request" kind="primary" size="sm" class="mt-3">Request a project</UiButton>
    </UiEmptyState>

    <template v-else>
      <div
        v-if="submitError"
        class="mb-5 px-4 py-3 rounded-md bg-brand-hunger-sheer border border-brand-hunger/40 text-sm text-brand-heart"
        data-testid="new-project-error"
        role="alert"
      >
        <template v-if="outcomeUnknown">
          We could not tell whether the project was created ({{ submitError }}). Trying again is
          safe: a project code is unique, so if the first attempt went through, the retry is refused
          as a code already taken, and nothing is created twice.
        </template>
        <template v-else>
          Could not create project — {{ submitError }} Nothing was created; fix the form and try again.
        </template>
      </div>

      <div class="space-y-5">
        <UiCard>
          <div class="text-sm font-bold text-carbon mb-3">Project details</div>
          <div class="grid grid-cols-2 gap-4">
            <label class="text-xs">
              <span class="block text-carbon-3 font-bold uppercase tracking-[1px] mb-1">Project code</span>
              <input
                v-model="code"
                type="text"
                placeholder="e.g. ACME-2026"
                class="w-full px-3 py-2 text-sm border border-calm-2 rounded-md font-mono focus:border-brand-harmony"
                data-testid="new-project-code"
              >
            </label>
            <label class="text-xs">
              <span class="block text-carbon-3 font-bold uppercase tracking-[1px] mb-1">Display name</span>
              <input
                v-model="displayName"
                type="text"
                placeholder="e.g. Acme platform rebuild"
                class="w-full px-3 py-2 text-sm border border-calm-2 rounded-md focus:border-brand-harmony"
                data-testid="new-project-name"
              >
            </label>
            <label class="text-xs">
              <span class="block text-carbon-3 font-bold uppercase tracking-[1px] mb-1">Type</span>
              <select
                v-model="type"
                class="w-full px-3 py-2 text-sm border border-calm-2 rounded-md bg-white focus:border-brand-harmony"
                data-testid="new-project-type"
              >
                <option value="billable">Billable</option>
                <option value="pursuit">Pursuit</option>
                <option value="internal">Internal</option>
              </select>
            </label>
            <label class="text-xs">
              <span class="block text-carbon-3 font-bold uppercase tracking-[1px] mb-1">Region</span>
              <select
                v-model="regionId"
                class="w-full px-3 py-2 text-sm border border-calm-2 rounded-md bg-white focus:border-brand-harmony"
                data-testid="new-project-region"
              >
                <option v-for="r in regionOptions" :key="r.id" :value="r.id">{{ r.name }}</option>
              </select>
            </label>
            <label class="text-xs">
              <span class="block text-carbon-3 font-bold uppercase tracking-[1px] mb-1">{{ BU_LABEL }}</span>
              <select
                v-model="couId"
                class="w-full px-3 py-2 text-sm border border-calm-2 rounded-md bg-white focus:border-brand-harmony"
                data-testid="new-project-cou"
              >
                <option value="" disabled>Select a {{ BU_LABEL.toLowerCase() }}…</option>
                <option v-for="u in couOptions" :key="u.id" :value="u.id">{{ u.display_name }}</option>
              </select>
            </label>
            <label class="text-xs">
              <span class="block text-carbon-3 font-bold uppercase tracking-[1px] mb-1">WBS code (optional)</span>
              <input
                v-model="wbsCode"
                type="text"
                maxlength="64"
                placeholder="e.g. 1.2.3 — finance-system correlation"
                class="w-full px-3 py-2 text-sm border border-calm-2 rounded-md font-mono focus:border-brand-harmony"
                data-testid="new-project-wbs"
              >
            </label>
            <div class="text-xs">
              <span class="block text-carbon-3 font-bold uppercase tracking-[1px] mb-1">Project manager{{ route === 'admin' ? ' (optional)' : '' }}</span>
              <TeammatePicker v-model="pm" testid="new-project-pm" />
            </div>
            <label class="text-xs">
              <span class="block text-carbon-3 font-bold uppercase tracking-[1px] mb-1">End date (optional)</span>
              <input
                v-model="endDate"
                type="date"
                class="w-full px-3 py-2 text-sm border border-calm-2 rounded-md focus:border-brand-harmony"
                data-testid="new-project-end-date"
              >
            </label>
          </div>
        </UiCard>

        <UiCard>
          <div class="text-sm font-bold text-carbon mb-3">Baseline budget and period</div>
          <div class="grid grid-cols-3 gap-4">
            <label class="text-xs">
              <span class="block text-carbon-3 font-bold uppercase tracking-[1px] mb-1">Budget (USD)</span>
              <input
                v-model="budgetUsd"
                type="text"
                inputmode="decimal"
                placeholder="1000.00"
                class="w-full px-3 py-2 text-sm border border-calm-2 rounded-md font-mono focus:border-brand-harmony"
                data-testid="new-project-budget"
              >
            </label>
            <label class="text-xs">
              <span class="block text-carbon-3 font-bold uppercase tracking-[1px] mb-1">From (UTC)</span>
              <input
                v-model="fromIso"
                type="date"
                class="w-full px-3 py-2 text-sm border border-calm-2 rounded-md focus:border-brand-harmony"
                data-testid="new-project-from"
              >
            </label>
            <label class="text-xs">
              <span class="block text-carbon-3 font-bold uppercase tracking-[1px] mb-1">Until (UTC, not included)</span>
              <input
                v-model="toIso"
                type="date"
                class="w-full px-3 py-2 text-sm border border-calm-2 rounded-md focus:border-brand-harmony"
                data-testid="new-project-to"
              >
            </label>
          </div>
          <p class="text-[11px] text-carbon-3 mt-3 leading-relaxed">
            A budget is for reporting: spend is compared against it, and going over it blocks nothing.
          </p>
        </UiCard>
      </div>
    </template>
  </div>
</template>
