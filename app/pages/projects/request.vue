<script setup lang="ts">
/*
 * Request a project (docs/design/project-requests/00-spec.md §3). Anyone may
 * ask; an admin of the chosen region reviews it, sets the final code and
 * approves or rejects. Before submitting, existing projects with similar names
 * are listed so a duplicate can be spotted.
 */
import { computed, ref, watch } from 'vue'
import TeammatePicker, { type PickedTeammate } from '../../components/projects/TeammatePicker.vue'
import { defaultBudgetPeriod, useBusinessUnits, utcMidnight } from '../../composables/useProjectFormOptions'
import { useDebouncedSearch } from '../../composables/useDebouncedSearch'
import { mutationErrorDetail } from '../../composables/useApiError'
import { BU_LABEL } from '#shared/reports/vocabulary'

const { session, ensure } = useSession()
await ensure()
const { units, regions, myUnitId } = useBusinessUnits()
const { today } = useServerClock()

const displayName = ref('')
const type = ref<'billable' | 'pursuit' | 'internal'>('billable')
const justification = ref('')
const budgetUsd = ref('')
const endDate = ref('')
const wbsCode = ref('')
const suggestedCode = ref('')
const pm = ref<PickedTeammate | null>(null)

/*
 * Region, Business Unit and budget period DEFAULT from data that may land after
 * setup (the picker units, the server clock). So each is the person's pick when
 * they made one, else the default derived from whatever has landed: a default
 * can arrive late without ever overwriting a choice, and the server renders the
 * same value the client hydrates (a watcher seeding a ref fires on the client
 * but not on the server after setup).
 */
const myUnit = computed(() => units.value.find((u) => u.id === myUnitId.value) ?? null)
const regionPick = ref<string | null>(null)
const regionId = computed<string>({
  get: () => regionPick.value ?? myUnit.value?.region_id ?? session.value?.regionId ?? '',
  set: (v) => {
    regionPick.value = v
  },
})
const couOptions = computed(() => units.value.filter((u) => u.region_id === regionId.value))
const couPick = ref<string | null>(null)
const couId = computed<string>({
  get: () => {
    const valid = (id: string | undefined) => !!id && couOptions.value.some((u) => u.id === id)
    if (couPick.value !== null) return valid(couPick.value) ? couPick.value : ''
    return valid(myUnit.value?.id) ? myUnit.value!.id : ''
  },
  set: (v) => {
    couPick.value = v
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
watch(
  session,
  (s) => {
    if (!pm.value && s?.teammateId && s.email) {
      pm.value = { id: s.teammateId, display_name: s.displayName ?? null, email: s.email }
    }
  },
  { immediate: true },
)

interface Similar { id: string; code: string; display_name: string; region_code: string }
const similar = ref<Similar[]>([])
const { run: runSimilar, cancel: cancelSimilar } = useDebouncedSearch<{ projects: Similar[] }>({
  search: (name) => $fetch<{ projects: Similar[] }>('/api/v1/pickers/similar-projects', { query: { name } }),
  apply: (r) => { similar.value = r.projects ?? [] },
  onError: () => { similar.value = [] },
})
watch(displayName, (name) => {
  if (name.trim().length < 3) {
    cancelSimilar()
    similar.value = []
    return
  }
  runSimilar(name.trim())
})

const submitting = ref(false)
const submitError = ref<string | null>(null)

/*
 * One idempotency key per content, for as long as the page is open: a resend of
 * the same content carries the same key, so a request that landed before its
 * answer was lost is not filed twice (the server returns the one already filed),
 * even after an edit that was changed back. Different content is a different
 * request and gets its own key. Without crypto.randomUUID (a page served over
 * plain HTTP off localhost) no key is sent, as from an older client.
 */
const idempotencyKeys = new Map<string, string>()
function idempotencyKeyFor(body: object): string | undefined {
  if (typeof globalThis.crypto?.randomUUID !== 'function') return undefined
  const content = JSON.stringify(body)
  let key = idempotencyKeys.get(content)
  if (!key) {
    key = globalThis.crypto.randomUUID()
    idempotencyKeys.set(content, key)
  }
  return key
}

const canSubmit = computed(() => {
  if (submitting.value) return false
  if (!displayName.value.trim() || !justification.value.trim()) return false
  if (!regionId.value || !couId.value || !pm.value) return false
  if (!/^\d+(\.\d{1,2})?$/.test(budgetUsd.value) || Number(budgetUsd.value) <= 0) return false
  if (!fromIso.value || !toIso.value) return false
  return fromIso.value < toIso.value
})

async function submit() {
  if (!canSubmit.value || !pm.value) return
  submitting.value = true
  submitError.value = null
  const body = {
    display_name: displayName.value.trim(),
    type: type.value,
    region_id: regionId.value,
    cost_owning_unit_id: couId.value,
    justification: justification.value.trim(),
    proposed_pm_teammate_id: pm.value.id,
    budget: { amount_usd: budgetUsd.value, from: utcMidnight(fromIso.value), to: utcMidnight(toIso.value) },
    ...(endDate.value ? { end_date: utcMidnight(endDate.value) } : {}),
    ...(wbsCode.value.trim() ? { wbs_code: wbsCode.value.trim() } : {}),
    ...(suggestedCode.value.trim() ? { suggested_code: suggestedCode.value.trim() } : {}),
  }
  const idempotencyKey = idempotencyKeyFor(body)
  try {
    await $fetch('/api/v1/me/project-requests', {
      method: 'POST',
      body: { ...body, idempotency_key: idempotencyKey },
    })
    await navigateTo('/projects')
  } catch (err) {
    submitError.value = mutationErrorDetail(
      err,
      'The request could not be sent.',
      idempotencyKey
        ? 'We could not tell whether your request was sent. Send it again without changing anything: if it already arrived, it is not sent twice. Or check "Your project requests" on My projects.'
        : 'We could not tell whether your request was sent. Check "Your project requests" on My projects before sending it again.',
    )
  } finally {
    submitting.value = false
  }
}

const inputClass = 'w-full px-3 py-2 text-sm border border-calm-2 rounded-md focus:border-brand-harmony'
const labelClass = 'block text-carbon-3 font-bold uppercase tracking-[1px] mb-1'
</script>

<template>
  <div class="max-w-[920px] mx-auto px-10 py-8 pb-20" data-testid="project-request-form">
    <UiPageHead
      eyebrow="My projects"
      title="Request a project"
      sub="An admin for the region reviews your request, sets the project code, and creates it."
      :crumbs="['My projects', 'Request a project']"
    >
      <template #actions>
        <NuxtLink to="/projects"><UiButton kind="secondary" size="sm">Cancel</UiButton></NuxtLink>
        <UiButton kind="primary" size="sm" :disabled="!canSubmit" data-testid="project-request-submit" @click="submit">
          {{ submitting ? 'Sending…' : 'Send request' }}
        </UiButton>
      </template>
    </UiPageHead>

    <div
      v-if="submitError"
      class="mb-5 px-4 py-3 rounded-md bg-brand-hunger-sheer border border-brand-hunger/40 text-sm text-brand-heart"
      role="alert"
      data-testid="project-request-error"
    >
      {{ submitError }}
    </div>

    <div class="space-y-5">
      <UiCard>
        <div class="text-sm font-bold text-carbon mb-3">The project</div>
        <div class="grid grid-cols-2 gap-4">
          <label class="text-xs col-span-2">
            <span :class="labelClass">Name</span>
            <input v-model="displayName" type="text" :class="inputClass" placeholder="e.g. Acme platform rebuild" data-testid="project-request-name">
          </label>
          <div
            v-if="similar.length"
            class="col-span-2 p-3 rounded-md border border-rag-amber/40 bg-rag-amber/5 text-xs text-carbon-2"
            data-testid="project-request-similar"
          >
            <div class="font-semibold text-carbon mb-1">Projects with similar names already exist. Is one of these yours?</div>
            <ul class="space-y-0.5">
              <li v-for="p in similar" :key="p.id">
                <span class="font-mono">{{ p.code }}</span> · {{ p.display_name }} <span class="text-carbon-3">({{ p.region_code }})</span>
              </li>
            </ul>
          </div>
          <label class="text-xs">
            <span :class="labelClass">Type</span>
            <select v-model="type" :class="inputClass" class="bg-white" data-testid="project-request-type">
              <option value="billable">Billable</option>
              <option value="pursuit">Pursuit</option>
              <option value="internal">Internal</option>
            </select>
          </label>
          <label class="text-xs">
            <span :class="labelClass">Region</span>
            <select v-model="regionId" :class="inputClass" class="bg-white" data-testid="project-request-region">
              <option v-for="r in regions" :key="r.id" :value="r.id">{{ r.name }}</option>
            </select>
          </label>
          <label class="text-xs">
            <span :class="labelClass">{{ BU_LABEL }}</span>
            <select v-model="couId" :class="inputClass" class="bg-white" data-testid="project-request-cou">
              <option value="" disabled>Select a {{ BU_LABEL.toLowerCase() }}…</option>
              <option v-for="u in couOptions" :key="u.id" :value="u.id">{{ u.display_name }}</option>
            </select>
          </label>
          <div class="text-xs">
            <span :class="labelClass">Project manager</span>
            <TeammatePicker v-model="pm" testid="project-request-pm" />
          </div>
          <label class="text-xs col-span-2">
            <span :class="labelClass">Why is it needed?</span>
            <textarea
              v-model="justification"
              rows="3"
              maxlength="2000"
              :class="inputClass"
              placeholder="What the work is, and who it is for."
              data-testid="project-request-justification"
            />
          </label>
        </div>
      </UiCard>

      <UiCard>
        <div class="text-sm font-bold text-carbon mb-3">Budget</div>
        <div class="grid grid-cols-3 gap-4">
          <label class="text-xs">
            <span :class="labelClass">Budget (USD)</span>
            <input v-model="budgetUsd" type="text" inputmode="decimal" placeholder="1000.00" :class="inputClass" class="font-mono" data-testid="project-request-budget">
          </label>
          <label class="text-xs">
            <span :class="labelClass">From (UTC)</span>
            <input v-model="fromIso" type="date" :class="inputClass" data-testid="project-request-from">
          </label>
          <label class="text-xs">
            <span :class="labelClass">Until (UTC, not included)</span>
            <input v-model="toIso" type="date" :class="inputClass" data-testid="project-request-to">
          </label>
        </div>
        <p class="text-[11px] text-carbon-3 mt-3 leading-relaxed">
          A budget is for reporting: spend is compared against it, and going over it blocks nothing.
        </p>
      </UiCard>

      <UiCard>
        <div class="text-sm font-bold text-carbon mb-3">Optional</div>
        <div class="grid grid-cols-3 gap-4">
          <label class="text-xs">
            <span :class="labelClass">Suggested code</span>
            <input v-model="suggestedCode" type="text" placeholder="e.g. ACME-2026" :class="inputClass" class="font-mono" data-testid="project-request-code">
          </label>
          <label class="text-xs">
            <span :class="labelClass">WBS code</span>
            <input v-model="wbsCode" type="text" maxlength="64" :class="inputClass" class="font-mono" data-testid="project-request-wbs">
          </label>
          <label class="text-xs">
            <span :class="labelClass">End date</span>
            <input v-model="endDate" type="date" :class="inputClass" data-testid="project-request-end-date">
          </label>
        </div>
        <p class="text-[11px] text-carbon-3 mt-3">The admin decides the final project code; yours is a suggestion.</p>
      </UiCard>
    </div>
  </div>
</template>
