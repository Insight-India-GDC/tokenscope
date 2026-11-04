<script setup lang="ts">
/*
 * TagSessionDialog — the universal tag / re-tag / correction editor for a Claude
 * conversation. Opened from a needs-tagging "Tag" button or a recent-session
 * "Re-tag"; pre-filled with the session's current project + activity. Sends BOTH
 * axes explicitly on save (null = clear), so it can also move a session OFF budget
 * or clear an activity. Self-contained: owns its form state + the assign call, and
 * emits `saved` so the parent can refresh.
 *
 * Accessibility: role="dialog" + aria-modal + aria-labelledby, Escape closes,
 * first field is focused on open, the error is an aria-live alert.
 */
import { ref, computed, type Ref } from 'vue'
import UiButton from '../ui/Button.vue'
import { fmtUsd, fmtTokens, fmtTimeAgo, clientMeta } from '../../composables/useFormat'
import { apiErrorDetail } from '../../composables/useApiError'
import { useModalA11y } from '../../composables/useModalA11y'
// The product's word for the object the wire keys as `'project'`. This dialog is
// where it was already right; the reporting layer now reads the SAME constant
// rather than a second copy of the string.
import { BUDGET_LABEL } from '#shared/reports/vocabulary'

export interface TagTarget {
  session_id: string
  instance_id: string | null
  tool: string
  cost_usd: string | number
  /*
   * NULL = the provider reported no token quantity, which is EVERY Copilot
   * provider-day: GitHub's `ai_credit/usage` meters in ai-credits and reports no
   * tokens at all (`shared/schemas/activity.ts`). It renders as absence, never
   * as `0` — a measured-looking zero beside a real cost is a measurement nobody
   * made. Sessions are OTel-observed and always carry a number.
   */
  tokens: number | null
  last_event: string
  project_id: string | null
  activity: string | null
  // Model mix (cost-share desc) — renders the dominant-model chip in the
  // header. Optional: legacy callers / conversations without a breakdown.
  by_model?: { model: string; tokens: number; cost_usd: string }[]
  // POST target for the save. Default (omitted) = the session-assign endpoint.
  // The per-day "unaccounted usage" worklist sets this to
  // /api/v1/me/unaccounted/{id}/assign so it reuses this exact picker (§A) — same
  // { project_id, activity } body, different subject (a day, not a conversation).
  assign_url?: string
  // Display variant. 'session' (default) renders the Session/Instance rows;
  // 'day' renders a single "Day" row (unaccounted records have no session id);
  // 'bulk' renders the selection's counts + total.
  subject_kind?: 'session' | 'day' | 'bulk'
  // The label shown in the subject row when subject_kind === 'day' (e.g. the date).
  subject_label?: string
  // BULK mode: the worklist ids this ONE save applies to. Present = the save
  // goes to /me/worklist/bulk (action 'tag') instead of a per-item assign, so a
  // month's backlog is cleared in a single atomic call. Because every item in
  // the queue is untagged by definition, bulk mode requires the developer to SET
  // something — saving with both axes empty would be a no-op reporting success.
  bulk?: { sessions: string[]; unaccounted: string[] }
}

const props = defineProps<{
  target: TagTarget | null
  projects: { id: string; code: string; display_name: string; type?: string }[]
  activityTypes: { label: string; is_mine?: boolean }[]
}>()

// Budgets are TYPED (billable / pursuit / internal) — group the picker by type so
// it reads as "Budgeted spend" (a budget of some kind), not project-only. A budget
// IS a project under the hood; the type is the category it bills under.
//
// INTERIM: these display labels are hardcoded. They should ultimately be
// REGION-CONFIGURABLE with enterprise defaults — the same hybrid pattern as the
// activity-tag vocabulary (activity_type: global standard + per-region overrides,
// managed by the region-admin Activity-tags page). A future budget_type_label (or
// equivalent) table + admin surface replaces this map. Tracked, not built yet.
const BUDGET_TYPE_LABELS: Record<string, string> = {
  billable: 'Billable',
  pursuit: 'Pursuit',
  internal: 'Internal',
}
const budgetGroups = computed(() => {
  const order = ['billable', 'pursuit', 'internal']
  const byType = new Map<string, typeof props.projects>()
  for (const p of props.projects) {
    const key = p.type && order.includes(p.type) ? p.type : 'other'
    if (!byType.has(key)) byType.set(key, [])
    byType.get(key)!.push(p)
  }
  return [...order, 'other']
    .filter((k) => byType.has(k))
    .map((k) => ({ key: k, label: BUDGET_TYPE_LABELS[k] ?? 'Other', projects: byType.get(k)! }))
})

// The caller's OWN previously-used tags — surfaced as one-click quick-picks above
// the input so they don't have to retype (or hunt the datalist) for a tag they
// already use. The full vocabulary still lives in the datalist below.
const myActivities = computed(() => props.activityTypes.filter((a) => a.is_mine).map((a) => a.label))

// Bulk subject: how many, of which kinds. The two kinds are named because they
// behave differently downstream (a day carries no session id), so "12 items"
// alone would hide what is about to be tagged.
const bulkCount = computed(() => {
  const b = props.target?.bulk
  return b ? b.sessions.length + b.unaccounted.length : 0
})
const bulkBreakdown = computed(() => {
  const b = props.target?.bulk
  if (!b) return ''
  const parts: string[] = []
  if (b.sessions.length) parts.push(`${b.sessions.length} session${b.sessions.length === 1 ? '' : 's'}`)
  if (b.unaccounted.length) parts.push(`${b.unaccounted.length} provider-recorded day${b.unaccounted.length === 1 ? '' : 's'}`)
  return parts.join(' · ')
})
const emit = defineEmits<{ close: []; saved: [] }>()

const projectId = ref('')
const activity = ref('')
const saving = ref(false)
const error = ref<string | null>(null)
const firstField = ref<HTMLSelectElement | null>(null)
const dialogEl = ref<HTMLElement | null>(null)
const titleId = 'tag-dialog-title'

// Shared dialog a11y (Escape-close, Tab focus-trap, focus first field on open,
// focus-restore on close). onOpen carries this dialog's prefill.
useModalA11y({
  isOpen: () => !!props.target,
  dialogEl,
  firstField: firstField as Ref<HTMLElement | null>,
  onClose: () => emit('close'),
  onOpen: () => {
    const t = props.target
    if (!t) return
    projectId.value = t.project_id ?? ''
    activity.value = t.activity ?? ''
    error.value = null
  },
})

// Bulk needs at least one axis SET (see TagTarget.bulk); the single-item paths
// keep accepting "no budget + no activity" as the clear-everything correction.
const canSave = computed(
  () => !props.target?.bulk || !!projectId.value || activity.value.trim().length > 0,
)

async function save() {
  // FE-9: the Save button is disabled while saving, but the activity input's
  // @keyup.enter is not — guard here so Enter cannot double-fire the assign.
  if (saving.value) return
  const t = props.target
  if (!t) return
  if (!canSave.value) return
  saving.value = true
  error.value = null
  try {
    if (t.bulk) {
      await $fetch('/api/v1/me/worklist/bulk', {
        method: 'POST',
        body: {
          action: 'tag',
          sessions: t.bulk.sessions,
          unaccounted: t.bulk.unaccounted,
          project_id: projectId.value || null,
          activity: activity.value.trim() || null,
        },
      })
      emit('saved')
      return
    }
    await $fetch(t.assign_url ?? `/api/v1/me/sessions/${t.session_id}/assign`, {
      method: 'POST',
      body: { project_id: projectId.value || null, activity: activity.value.trim() || null },
    })
    emit('saved')
  } catch (e: unknown) {
    error.value = apiErrorDetail(e, 'Save failed')
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <div
    v-if="target"
    class="fixed inset-0 z-50 flex items-center justify-center bg-carbon/40 p-4"
    data-testid="tag-session-modal"
    @click.self="emit('close')"
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
            <template v-if="target.bulk">Tag selected items</template>
            <template v-else-if="target.subject_kind === 'day'">{{ target.project_id || target.activity ? 'Re-tag usage' : 'Tag unaccounted usage' }}</template>
            <template v-else>{{ target.project_id || target.activity ? 'Re-tag session' : 'Tag session' }}</template>
          </p>
          <h2 v-if="target.bulk" :id="titleId" class="text-lg font-bold text-carbon mt-0.5">
            {{ bulkCount }} {{ bulkCount === 1 ? 'item' : 'items' }}
          </h2>
          <h2 v-else :id="titleId" class="inline-flex items-center gap-1.5 text-lg font-bold text-carbon mt-0.5">
            <Icon :name="clientMeta(target.tool).icon" class="text-base" aria-hidden="true" />
            {{ clientMeta(target.tool).name }}
            <UsageModelBadge v-if="target.subject_kind !== 'day'" :by-model="target.by_model" />
          </h2>
        </div>
        <UiButton kind="ghost" size="sm" data-testid="tag-close" @click="emit('close')">Close</UiButton>
      </div>
      <div class="px-6 py-4">
        <dl class="grid grid-cols-[5rem_1fr] gap-x-2 gap-y-1 text-xs mb-4 items-baseline">
          <template v-if="target.bulk">
            <dt class="text-carbon-3">Items</dt>
            <dd class="text-carbon" data-testid="tag-bulk-items">{{ bulkBreakdown }}</dd>
            <dt class="text-carbon-3">Spend</dt>
            <dd class="text-carbon">{{ fmtUsd(target.cost_usd) }}</dd>
          </template>
          <template v-else-if="target.subject_kind === 'day'">
            <dt class="text-carbon-3">Day</dt>
            <dd class="text-carbon">{{ target.subject_label ?? target.session_id }}</dd>
            <dt class="text-carbon-3">Usage</dt>
            <dd class="text-carbon" data-testid="tag-day-usage">
              {{ fmtUsd(target.cost_usd) }} ·
              <span v-if="target.tokens == null" class="italic text-carbon-3" title="This provider reports no token quantity for a recorded day — the cost is real, the token count was never measured.">tokens not reported</span>
              <template v-else>{{ fmtTokens(target.tokens) }}</template>
            </dd>
          </template>
          <template v-else>
            <dt class="text-carbon-3">Session</dt>
            <dd class="font-mono text-carbon truncate" :title="target.session_id">{{ target.session_id }}</dd>
            <dt class="text-carbon-3">Device</dt>
            <dd class="font-mono text-carbon-2 truncate" :title="target.instance_id ?? ''">{{ target.instance_id ?? '—' }}</dd>
            <dt class="text-carbon-3">Spend</dt>
            <dd class="text-carbon">
              {{ fmtUsd(target.cost_usd) }} ·
              <span v-if="target.tokens == null" class="italic text-carbon-3">tokens not reported</span>
              <template v-else>{{ fmtTokens(target.tokens) }}</template>
              · {{ fmtTimeAgo(target.last_event) }}
            </dd>
          </template>
        </dl>
        <p v-if="target.bulk" class="text-[12px] text-carbon-2 mb-3">
          One save for every selected item. Pick a <strong>budget</strong> and/or an
          <strong>activity</strong> — it applies to all of them, or to none if any item fails.
        </p>
        <p v-else-if="target.subject_kind === 'day'" class="text-[12px] text-carbon-2 mb-3">
          This day's usage was counted by the provider but never captured by OTel (e.g. an un-enrolled container). Assign a <strong>budget</strong> and/or an <strong>activity</strong>, same as a session.
        </p>
        <p v-else class="text-[12px] text-carbon-2 mb-3">
          Assign a <strong>budget</strong> and/or an <strong>activity</strong>. Budgets are billable, pursuit or internal — choose “No budget” to leave it unallocated; clear the activity to untag it.
        </p>

        <label for="tag-budget" class="text-[12px] font-semibold text-carbon">{{ BUDGET_LABEL }}</label>
        <select
          id="tag-budget"
          ref="firstField"
          v-model="projectId"
          class="mt-1 mb-3 w-full px-3 py-2 text-sm border border-calm-2 rounded-md bg-white focus:border-brand-harmony"
          data-testid="tag-project"
        >
          <option value="">No budget — unallocated</option>
          <optgroup v-for="g in budgetGroups" :key="g.key" :label="g.label">
            <option v-for="p in g.projects" :key="p.id" :value="p.id">{{ p.code }} — {{ p.display_name }}</option>
          </optgroup>
        </select>

        <label for="tag-activity-input" class="text-[12px] font-semibold text-carbon">Activity</label>
        <div v-if="myActivities.length" class="flex flex-wrap gap-1.5 mt-1 mb-1.5" data-testid="tag-activity-mine">
          <button
            v-for="label in myActivities"
            :key="label"
            type="button"
            class="px-2 py-0.5 text-[11px] rounded-full border border-calm-2 text-carbon-2 hover:border-brand-harmony hover:text-brand-harmony transition-colors"
            :class="activity === label ? 'border-brand-harmony text-brand-harmony bg-brand-harmony-sheer' : ''"
            @click="activity = label"
          >
            {{ label }}
          </button>
        </div>
        <input
          id="tag-activity-input"
          v-model="activity"
          list="tag-activity-types"
          placeholder="e.g. Research, Documentation"
          class="mt-1 w-full px-3 py-2 text-sm border border-calm-2 rounded-md bg-white focus:border-brand-harmony"
          data-testid="tag-activity"
          @keyup.enter="save"
        >
        <datalist id="tag-activity-types">
          <option v-for="a in activityTypes" :key="a.label" :value="a.label" />
        </datalist>

        <p v-if="error" class="text-xs text-rag-red mt-3" data-testid="tag-error" role="alert">{{ error }}</p>

        <div class="flex justify-end gap-2 mt-5">
          <UiButton kind="ghost" data-testid="tag-cancel" @click="emit('close')">Cancel</UiButton>
          <UiButton kind="primary" :disabled="saving || !canSave" data-testid="tag-submit" @click="save">
            {{ saving ? 'Saving…' : 'Save' }}
          </UiButton>
        </div>
      </div>
    </div>
  </div>
</template>
