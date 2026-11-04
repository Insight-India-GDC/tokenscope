<script setup lang="ts">
/*
 * Manage drawer body on the project page (docs/design/project-requests/00-spec.md
 * §4; layout docs/design/ideas/project-page-actions, #477): what the project's
 * PM, or an admin in scope, can change here, one tab each: pending budget
 * requests, budget, end date, members. Hidden tabs stay mounted (v-show), so a
 * half-filled form survives a look at another tab.
 *
 * Every action calls the route that decides; nothing here re-derives the gate.
 * The server's own refusal text is shown as-is (e.g. the last-PM 409).
 *
 * Dates: an end date is a UTC instant set at 00:00 UTC on the chosen day, and
 * "today" is the server's UTC day (useServerClock via the parent), never the
 * browser's. Budgets are reporting only, so nothing here says spend is blocked.
 */
import { computed, ref, watch } from 'vue'
import type { BudgetRequestRow } from '#shared/schemas/project-budget'
import { apiErrorDetail, isConfirmedRejection } from '../../composables/useApiError'

const props = defineProps<{
  projectId: string
  /** project.end_date as the server sent it (timestamptz text) or null. */
  endDate: string | null
  ended: boolean
  /** The pool baseline in effect: what the allocation editor changes and splits. */
  budgetAllocationId: string | null
  /** The latest top-up in effect when the budget is top-ups only (no baseline) (#513). */
  budgetTopupAllocationId?: string | null
  /** The server's UTC day (YYYY-MM-DD), null until the clock lands. */
  todayUtc: string | null
  pendingRequests: BudgetRequestRow[]
  /** Whether pendingRequests loaded: an empty list means "none" only when 'ready'. */
  requestsState: 'loading' | 'error' | 'ready'
}>()

const emit = defineEmits<{ changed: []; retry: [] }>()

const tab = defineModel<ManageTab>('tab', { default: 'budget' })
const tabs = computed(() => [
  {
    key: 'requests',
    // The count only once the list loaded: "(0)" for a list that failed would be a claim.
    label: props.requestsState === 'ready' ? `Budget requests (${props.pendingRequests.length})` : 'Budget requests',
  },
  { key: 'budget', label: 'Budget' },
  { key: 'end-date', label: 'End date' },
  { key: 'members', label: 'Members' },
])

/**
 * The message for a failed save. When the server refused (a 4xx), its reason.
 * Otherwise (no answer, a 5xx) the save may have landed: say so, and reload
 * what it touched so the section shows what is actually stored.
 */
function failed(err: unknown, rejected: string, what: string, reload: () => unknown = () => emit('changed')): string {
  if (isConfirmedRejection(err)) return apiErrorDetail(err, rejected)
  void reload()
  return `We could not tell whether ${what}. This section is being reloaded: check it before trying again.`
}

// ── Budget ──────────────────────────────────────────────────────────────────
const budgetAmount = ref('')
const budgetFrom = ref('')
const budgetTo = ref('')
const budgetError = ref<string | null>(null)
const budgetSaving = ref(false)

function nextMonthStart(day: string): string {
  const y = Number(day.slice(0, 4))
  const m = Number(day.slice(5, 7))
  return m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`
}
watch(
  () => props.todayUtc,
  (today) => {
    if (!today || budgetFrom.value) return
    budgetFrom.value = `${today.slice(0, 7)}-01`
    budgetTo.value = nextMonthStart(today)
  },
  { immediate: true },
)
const canSetBudget = computed(
  () =>
    !budgetSaving.value &&
    /^\d{1,12}(\.\d{1,2})?$/.test(budgetAmount.value) &&
    Number(budgetAmount.value) > 0 &&
    !!budgetFrom.value &&
    !!budgetTo.value &&
    budgetFrom.value < budgetTo.value,
)
async function setBudget() {
  budgetSaving.value = true
  budgetError.value = null
  try {
    await $fetch('/api/v1/allocations', {
      method: 'POST',
      body: {
        project_id: props.projectId,
        budget_usd: budgetAmount.value,
        effective: `[${budgetFrom.value}T00:00:00Z,${budgetTo.value}T00:00:00Z)`,
      },
    })
    budgetAmount.value = ''
    emit('changed')
  } catch (err) {
    budgetError.value = failed(err, 'Could not set the budget.', 'the budget was set')
  } finally {
    budgetSaving.value = false
  }
}

// ── End date ────────────────────────────────────────────────────────────────
const endDay = ref(props.endDate ? props.endDate.slice(0, 10) : '')
watch(
  () => props.endDate,
  (v) => {
    endDay.value = v ? v.slice(0, 10) : ''
  },
)
const endError = ref<string | null>(null)
const endSaving = ref(false)
const confirmingEarly = ref(false)
/** On or before the server's today: the project would be ended as soon as this saves. */
const endsNow = computed(() => !!endDay.value && !!props.todayUtc && endDay.value <= props.todayUtc)
const endUnchanged = computed(() => endDay.value === (props.endDate ? props.endDate.slice(0, 10) : ''))

async function saveEndDate(day: string | null) {
  // Without the server's today, a past date cannot be told from a future one,
  // so it would save without the confirmation. The button waits for the clock.
  if (day && !props.todayUtc) return
  if (day && endsNow.value && !confirmingEarly.value) {
    confirmingEarly.value = true
    return
  }
  endSaving.value = true
  endError.value = null
  try {
    await $fetch(`/api/v1/projects/${props.projectId}/timeline`, {
      method: 'PATCH',
      body: { end_date: day ? `${day}T00:00:00Z` : null },
    })
    confirmingEarly.value = false
    emit('changed')
  } catch (err) {
    endError.value = failed(err, 'Could not change the end date.', 'the end date was saved')
  } finally {
    endSaving.value = false
  }
}
watch(endDay, () => {
  confirmingEarly.value = false
})
const fmtDay = (day: string) =>
  new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(
    new Date(`${day}T00:00:00Z`),
  )

// ── Members ─────────────────────────────────────────────────────────────────
interface Member {
  teammate_id: string
  email: string
  display_name: string | null
  role: 'manager' | 'member'
}
const { data: membersData, refresh: refreshMembers } = useFetch<{ members: Member[] }>(
  () => `/api/v1/admin/projects/${props.projectId}/assignments`,
  { default: () => ({ members: [] }), lazy: true },
)
const memberError = ref<string | null>(null)
const memberBusy = ref<string | null>(null)

async function memberAction(teammateId: string, action: 'manager' | 'member' | 'remove') {
  memberBusy.value = teammateId
  memberError.value = null
  try {
    const url = `/api/v1/admin/projects/${props.projectId}/assignments/${teammateId}`
    if (action === 'remove') await $fetch(url, { method: 'DELETE' })
    else await $fetch(url, { method: 'PATCH', body: { role: action } })
    await refreshMembers()
    emit('changed')
  } catch (err) {
    memberError.value = failed(err, 'Could not change this member.', 'the change to this member was saved', refreshMembers)
  } finally {
    memberBusy.value = null
  }
}

interface Pick {
  id: string
  display_name: string | null
  email: string
}
const addTerm = ref('')
const addResults = ref<Pick[]>([])
const picker = useDebouncedSearch<Pick[]>({
  search: async (term) => {
    const res = await $fetch<{ teammates: Pick[] }>('/api/v1/pickers/teammates', { query: { q: term } })
    return res.teammates.slice(0, 8)
  },
  apply: (r) => {
    addResults.value = r
  },
  onError: (err) => {
    memberError.value = apiErrorDetail(err, 'Teammate search failed.')
  },
})
function onAddInput() {
  memberError.value = null
  const term = addTerm.value.trim()
  if (term.length < 2) {
    picker.cancel()
    addResults.value = []
    return
  }
  picker.run(term)
}
const members = computed<Member[]>(() => membersData.value?.members ?? [])
const memberIds = computed(() => new Set(members.value.map((m) => m.teammate_id)))
async function addMember(teammateId: string) {
  memberBusy.value = teammateId
  memberError.value = null
  try {
    await $fetch(`/api/v1/admin/projects/${props.projectId}/assignments`, {
      method: 'POST',
      body: { teammate_id: teammateId },
    })
    addTerm.value = ''
    picker.cancel()
    addResults.value = []
    await refreshMembers()
    emit('changed')
  } catch (err) {
    memberError.value = failed(err, 'Could not add this person.', 'this person was added', refreshMembers)
  } finally {
    memberBusy.value = null
  }
}

// ── Pending budget requests ─────────────────────────────────────────────────
const approveAmount = ref<Record<string, string>>({})
const decisionNote = ref<Record<string, string>>({})
const rejecting = ref<string | null>(null)
const requestError = ref<Record<string, string>>({})
const requestBusy = ref<string | null>(null)
watch(
  () => props.pendingRequests,
  (rows) => {
    for (const r of rows) {
      if (approveAmount.value[r.id] === undefined) approveAmount.value[r.id] = Number(r.amount_usd).toFixed(2)
    }
  },
  { immediate: true },
)
async function decide(r: BudgetRequestRow, kind: 'approve' | 'reject') {
  requestBusy.value = r.id
  requestError.value[r.id] = ''
  try {
    const note = (decisionNote.value[r.id] ?? '').trim()
    await $fetch(`/api/v1/projects/${props.projectId}/budget-requests/${r.id}/${kind}`, {
      method: 'POST',
      body: kind === 'approve' ? { amount_usd: approveAmount.value[r.id], note: note || undefined } : { note },
    })
    rejecting.value = null
    emit('changed')
  } catch (err) {
    requestError.value[r.id] = failed(err, 'Could not record the decision.', 'your decision was recorded')
  } finally {
    requestBusy.value = null
  }
}
const who = (r: BudgetRequestRow) => r.requester_display_name ?? r.requester_email.split('@')[0]
</script>

<script lang="ts">
export type ManageTab = 'requests' | 'budget' | 'end-date' | 'members'
</script>

<template>
  <div data-testid="project-manage">
    <div class="overflow-x-auto mb-3">
      <UiTabs class="!mb-0" :tabs="tabs" :model-value="tab" @update:model-value="tab = $event as ManageTab" />
    </div>
    <p class="text-[11px] text-carbon-3 mb-4">Budgets here are for reporting: they block nothing.</p>
    <p v-if="ended" class="text-[12px] text-carbon-3 -mt-2 mb-4" data-testid="manage-ended">
      This project has ended, so its budget no longer changes.
    </p>

    <!-- Budget -->
    <section v-show="tab === 'budget'" aria-label="Budget" data-testid="manage-budget">
      <!-- Ended: the budget no longer changes (the line above says so), so no
           top-up, change or create offer; only the way to look at it. -->
      <div v-if="ended" class="text-[12px]" data-testid="manage-budget-ended">
        <NuxtLink
          v-if="budgetAllocationId || budgetTopupAllocationId"
          :to="`/allocations/${budgetAllocationId ?? budgetTopupAllocationId}`"
          class="font-semibold text-brand-harmony hover:underline"
          data-testid="manage-see-budget"
        >
          See the budget →
        </NuxtLink>
        <span v-else class="text-carbon-3">It has no budget for the current period.</span>
      </div>
      <div v-else-if="budgetAllocationId" class="flex items-center gap-4 flex-wrap">
        <NuxtLink
          :to="`/allocations/${budgetAllocationId}?focus=topup`"
          class="text-[12px] font-semibold text-brand-harmony hover:underline"
          data-testid="manage-topup"
        >
          Add to the budget →
        </NuxtLink>
        <NuxtLink
          :to="`/allocations/${budgetAllocationId}`"
          class="text-[12px] font-semibold text-brand-harmony hover:underline"
          data-testid="pm-manage-budget"
        >
          Change the budget or per-developer split →
        </NuxtLink>
      </div>
      <div v-else class="space-y-2" data-testid="manage-set-budget">
        <!-- Budgeted by top-ups alone (#513): the budget exists, so say so; a
             baseline set here adds to the top-ups, it does not replace them. -->
        <template v-if="budgetTopupAllocationId">
          <p class="text-[12px] text-carbon-2" data-testid="manage-topups-only">
            This project's budget for the current period is top-ups only, with no baseline.
          </p>
          <NuxtLink
            :to="`/allocations/${budgetTopupAllocationId}?focus=topup`"
            class="inline-block text-[12px] font-semibold text-brand-harmony hover:underline"
            data-testid="manage-topup"
          >
            Add to the budget →
          </NuxtLink>
          <p class="text-[12px] text-carbon-2">
            To change the total or split it per developer, set a baseline. It is added to the top-ups, it does not replace them:
          </p>
        </template>
        <p v-else class="text-[12px] text-carbon-2">This project has no budget for the current period. Set one:</p>
        <div class="flex items-end gap-2 flex-wrap">
          <label class="text-[11px] text-carbon-3">
            Amount (USD)
            <input v-model="budgetAmount" inputmode="decimal" class="block w-28 px-2 py-1.5 text-sm border border-calm-2 rounded-md" data-testid="manage-budget-amount">
          </label>
          <label class="text-[11px] text-carbon-3">
            From (UTC)
            <input v-model="budgetFrom" type="date" class="block px-2 py-1.5 text-sm border border-calm-2 rounded-md">
          </label>
          <label class="text-[11px] text-carbon-3">
            Until (UTC, not included)
            <input v-model="budgetTo" type="date" class="block px-2 py-1.5 text-sm border border-calm-2 rounded-md">
          </label>
          <UiButton kind="primary" size="sm" :disabled="!canSetBudget" data-testid="manage-budget-save" @click="setBudget">
            Set budget
          </UiButton>
        </div>
        <p v-if="budgetError" class="text-[12px] text-brand-heart" data-testid="manage-budget-error">{{ budgetError }}</p>
      </div>
    </section>

    <!-- End date -->
    <section v-show="tab === 'end-date'" aria-label="End date" data-testid="manage-end-date">
      <div class="flex items-end gap-2 flex-wrap">
        <label class="text-[11px] text-carbon-3">
          Ends at 00:00 UTC on
          <input v-model="endDay" type="date" class="block px-2 py-1.5 text-sm border border-calm-2 rounded-md" data-testid="manage-end-input">
        </label>
        <UiButton
          kind="secondary"
          size="sm"
          :disabled="endSaving || !endDay || endUnchanged || !todayUtc"
          :title="!todayUtc ? 'Waiting for the server clock, to check the date against today.' : undefined"
          data-testid="manage-end-save"
          @click="saveEndDate(endDay)"
        >
          Save end date
        </UiButton>
        <UiButton
          v-if="endDate"
          kind="ghost"
          size="sm"
          :disabled="endSaving"
          data-testid="manage-end-clear"
          @click="saveEndDate(null)"
        >
          Remove end date
        </UiButton>
      </div>
      <p class="text-[11px] text-carbon-3 mt-2 leading-relaxed" data-testid="manage-end-explainer">
        From the end date, sessions can no longer be tagged to this project. Spend tagged to it and
        recorded after the end date plus the grace period your admins set goes to unallocated instead.
        Moving the end date later does not, by itself, move that spend back.
      </p>
      <div
        v-if="confirmingEarly"
        class="mt-2 px-3 py-2 rounded-md bg-brand-hunger-sheer border border-brand-hunger/40 text-[12px] text-carbon-2"
        data-testid="manage-end-confirm"
      >
        {{ fmtDay(endDay) }} is not after today ({{ todayUtc ? fmtDay(todayUtc) : 'today' }}, UTC), so the
        project ends as soon as you save: sessions can no longer be tagged to it. Spend already attributed
        to it stays. Spend tagged to it after the end date plus the grace period goes to unallocated.
        Moving the end date later does not, by itself, move that spend back.
        <div class="mt-2 flex gap-2">
          <UiButton kind="primary" size="sm" :disabled="endSaving" data-testid="manage-end-confirm-yes" @click="saveEndDate(endDay)">
            End the project
          </UiButton>
          <UiButton kind="ghost" size="sm" @click="confirmingEarly = false">Cancel</UiButton>
        </div>
      </div>
      <p v-if="endError" class="text-[12px] text-brand-heart mt-2" data-testid="manage-end-error">{{ endError }}</p>
    </section>

    <!-- Members -->
    <section v-show="tab === 'members'" aria-label="Members" data-testid="manage-members">
      <ul class="space-y-1">
        <li
          v-for="m in members"
          :key="m.teammate_id"
          class="flex items-center justify-between gap-3 px-3 py-1.5 rounded-md border border-calm-2"
          :data-testid="`manage-member-${m.teammate_id}`"
        >
          <div class="min-w-0">
            <span class="text-sm font-semibold text-carbon">{{ m.display_name ?? m.email.split('@')[0] }}</span>
            <UiBadge v-if="m.role === 'manager'" kind="neutral" class="ml-2">manager</UiBadge>
            <div class="text-[11px] text-carbon-3 truncate">{{ m.email }}</div>
          </div>
          <div class="flex gap-1">
            <UiButton
              v-if="m.role === 'member'"
              kind="ghost"
              size="sm"
              :disabled="memberBusy === m.teammate_id"
              @click="memberAction(m.teammate_id, 'manager')"
            >
              Make manager
            </UiButton>
            <UiButton
              v-else
              kind="ghost"
              size="sm"
              :disabled="memberBusy === m.teammate_id"
              @click="memberAction(m.teammate_id, 'member')"
            >
              Make member
            </UiButton>
            <UiButton
              kind="ghost"
              size="sm"
              :disabled="memberBusy === m.teammate_id"
              :data-testid="`manage-remove-${m.teammate_id}`"
              @click="memberAction(m.teammate_id, 'remove')"
            >
              Remove
            </UiButton>
          </div>
        </li>
      </ul>
      <div class="mt-3">
        <input
          v-model="addTerm"
          type="text"
          placeholder="Add someone who already uses TokenScope: search by name or email…"
          class="w-full px-3 py-2 text-sm border border-calm-2 rounded-md"
          data-testid="manage-add-search"
          @input="onAddInput"
        >
        <ul v-if="addResults.length" class="mt-2 space-y-1">
          <li
            v-for="p in addResults"
            :key="p.id"
            class="flex items-center justify-between gap-3 px-3 py-1.5 rounded-md border border-calm-2"
          >
            <div class="min-w-0">
              <div class="text-sm text-carbon truncate">{{ p.display_name ?? p.email.split('@')[0] }}</div>
              <div class="text-[11px] text-carbon-3 truncate">{{ p.email }}</div>
            </div>
            <span v-if="memberIds.has(p.id)" class="text-[11px] text-carbon-3">already a member</span>
            <UiButton v-else kind="secondary" size="sm" :disabled="memberBusy === p.id" :data-testid="`manage-add-${p.id}`" @click="addMember(p.id)">
              + Add
            </UiButton>
          </li>
        </ul>
        <p class="text-[11px] text-carbon-3 mt-1">Someone not yet in TokenScope? Ask an admin to add them.</p>
      </div>
      <p v-if="memberError" class="text-[12px] text-brand-heart mt-2" data-testid="manage-member-error">{{ memberError }}</p>
    </section>

    <!-- Pending budget requests: this list is the work queue (A10). -->
    <section v-show="tab === 'requests'" aria-label="Budget requests" data-testid="manage-budget-requests">
      <p v-if="requestsState === 'loading'" class="text-[12px] text-carbon-3" data-testid="manage-requests-loading">
        Loading budget requests…
      </p>
      <div v-else-if="requestsState === 'error'" class="flex items-center gap-2" data-testid="manage-requests-error">
        <p class="text-[12px] text-brand-heart">Could not load budget requests, so any that are waiting are not shown.</p>
        <UiButton kind="secondary" size="sm" data-testid="manage-requests-retry" @click="emit('retry')">Retry</UiButton>
      </div>
      <p v-else-if="!pendingRequests.length" class="text-[12px] text-carbon-3" data-testid="manage-requests-empty">No requests waiting.</p>
      <ul class="space-y-2">
        <li
          v-for="r in pendingRequests"
          :key="r.id"
          class="px-3 py-2 rounded-md border border-calm-2"
          :data-testid="`manage-request-${r.id}`"
        >
          <div class="text-sm text-carbon">
            <strong>{{ who(r) }}</strong> asked for <strong>{{ fmtUsd(r.amount_usd) }}</strong> more
            <span class="text-[11px] text-carbon-3">· {{ new Date(r.created_at).toLocaleString() }}</span>
          </div>
          <p class="text-[12px] text-carbon-2 mt-1 whitespace-pre-line">“{{ r.reason }}”</p>
          <div class="mt-2 flex items-end gap-2 flex-wrap">
            <label class="text-[11px] text-carbon-3">
              Amount to add (USD)
              <input v-model="approveAmount[r.id]" inputmode="decimal" class="block w-28 px-2 py-1.5 text-sm border border-calm-2 rounded-md">
            </label>
            <label class="text-[11px] text-carbon-3 grow">
              Note {{ rejecting === r.id ? '(required to decline)' : '(optional)' }}
              <input v-model="decisionNote[r.id]" class="block w-full px-2 py-1.5 text-sm border border-calm-2 rounded-md">
            </label>
            <UiButton
              v-if="rejecting !== r.id"
              kind="primary"
              size="sm"
              :disabled="requestBusy === r.id || ended"
              :title="ended ? 'This project has ended, so its budget can no longer change.' : undefined"
              :data-testid="`manage-approve-${r.id}`"
              @click="decide(r, 'approve')"
            >
              Approve
            </UiButton>
            <UiButton
              v-if="rejecting !== r.id"
              kind="ghost"
              size="sm"
              @click="rejecting = r.id"
            >
              Decline…
            </UiButton>
            <UiButton
              v-else
              kind="secondary"
              size="sm"
              :disabled="requestBusy === r.id || !(decisionNote[r.id] ?? '').trim()"
              :data-testid="`manage-reject-${r.id}`"
              @click="decide(r, 'reject')"
            >
              Decline with this note
            </UiButton>
          </div>
          <p v-if="requestError[r.id]" class="text-[12px] text-brand-heart mt-1">{{ requestError[r.id] }}</p>
        </li>
      </ul>
    </section>
  </div>
</template>
