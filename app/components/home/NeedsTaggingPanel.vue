<script setup lang="ts">
/*
 * HomeNeedsTaggingPanel — the needs-tagging worklist.
 *
 * The card is a DECISION QUEUE, not a list of rows: every item is waiting on
 * one of three decisions — tag it, dismiss it ("mine, not project work, not
 * worth a label"), or leave it for later. Dismissal is what lets the queue
 * reach zero; it changes no money (the spend stays unallocated and still
 * charges to the developer's cost centre), and it is reversible from the
 * Dismissed drawer. Design: docs/design/needs-tagging-worklist.md.
 *
 * Two item kinds share the queue and the selection model:
 *   - SESSIONS — conversations with unallocated ledger rows.
 *   - PROVIDER-RECORDED DAYS — §A unaccounted_usage rows (no session id).
 * They stay in separate groups (different units, different provenance) with
 * their own subtotals, because the money is routinely NOT where the item count
 * is: a month of 12 sessions worth $0.52 alongside 10 days worth $168 is the
 * normal shape, and a card that only shows a grand total hides that.
 *
 * Selection drives one bulk call (/me/worklist/bulk) for tag / dismiss /
 * restore. Tagging is handed UP to the page, which owns the shared
 * TagSessionDialog; dismiss + restore are posted from here.
 */
import { computed, ref, watch } from 'vue'
import UiButton from '../ui/Button.vue'
import { fmtUsd, fmtTokens, fmtTimeAgo, clientMeta } from '../../composables/useFormat'
import { apiErrorDetail } from '../../composables/useApiError'
import {
  WORKLIST_LIST_LIMIT,
  WORKLIST_SMALL_ITEM_USD,
  type WorklistDay,
  type WorklistSession,
} from '#shared/schemas/worklist'

/**
 * The needs-tagging slice of /me/usage — the authoritative MONTH figures, which
 * the capped all-time lists below cannot produce. The month's DISMISSED total
 * lives on the hero card next to the unallocated total it belongs to; this panel
 * describes the dismissed set it can actually restore (see dismissedShownCost).
 */
export interface WorklistSummary {
  untagged_cost_usd: string
  needs_tagging_count: number
  needs_tagging_sessions: number
  needs_tagging_days: number
}

const props = defineProps<{
  sessions: WorklistSession[]
  unaccounted: WorklistDay[]
  dismissed: { sessions: WorklistSession[]; unaccounted: WorklistDay[] }
  summary: WorklistSummary
  /**
   * The worklist fetch failed. An empty list then means "we don't know", NOT
   * "nothing to do" — see `settled` below.
   */
  loadFailed?: boolean
}>()

const emit = defineEmits<{
  /** Tag ONE session — the page opens the shared dialog. */
  tagSession: [WorklistSession]
  /** Tag ONE provider-recorded day. */
  tagDay: [WorklistDay]
  /** Open ONE provider-recorded day's breakdown — the day's counterpart of a
   *  session's "Details". The page owns the drawer. */
  dayDetail: [WorklistDay]
  /** Tag the current selection in one save. */
  tagBulk: [{ sessions: string[]; unaccounted: string[]; count: number; cost_usd: number }]
  /** A dismiss/restore landed — the page refetches usage + worklist. */
  changed: []
}>()

// ── Selection ────────────────────────────────────────────────────────────────
// Keyed by kind so a session id and a record id can never collide.
const sKey = (s: WorklistSession) => `s:${s.session_id}`
const dKey = (d: WorklistDay) => `d:${d.id}`
const selected = ref<Set<string>>(new Set())

const activeKeys = computed(() => [...props.sessions.map(sKey), ...props.unaccounted.map(dKey)])

// A refresh (or someone else's tab) can retire an item that is still selected.
// Prune to what is actually on the card, so the action bar never counts ghosts.
watch(activeKeys, (keys) => {
  const live = new Set(keys)
  const next = new Set([...selected.value].filter((k) => live.has(k)))
  if (next.size !== selected.value.size) selected.value = next
})

function toggle(key: string) {
  const next = new Set(selected.value)
  if (next.has(key)) next.delete(key)
  else next.add(key)
  selected.value = next
}
const isSelected = (key: string) => selected.value.has(key)

const selectedSessions = computed(() =>
  props.sessions.filter((s) => selected.value.has(sKey(s))),
)
const selectedDays = computed(() => props.unaccounted.filter((d) => selected.value.has(dKey(d))))
const selectedCount = computed(() => selectedSessions.value.length + selectedDays.value.length)
const selectedCost = computed(
  () =>
    selectedSessions.value.reduce((a, s) => a + Number(s.cost_usd), 0) +
    selectedDays.value.reduce((a, d) => a + Number(d.cost_usd), 0),
)

const allSelected = computed(
  () => activeKeys.value.length > 0 && selected.value.size === activeKeys.value.length,
)
const someSelected = computed(() => selected.value.size > 0 && !allSelected.value)

function toggleAll() {
  selected.value = allSelected.value ? new Set() : new Set(activeKeys.value)
}

/*
 * "Select the small ones" — the one-click answer to a queue full of $0.01
 * subagent probes. It only BUILDS a selection: nothing is dismissed, hidden or
 * decided because an item is small; the developer still presses the verb.
 */
const smallKeys = computed(() => [
  ...props.sessions.filter((s) => Number(s.cost_usd) < WORKLIST_SMALL_ITEM_USD).map(sKey),
  ...props.unaccounted.filter((d) => Number(d.cost_usd) < WORKLIST_SMALL_ITEM_USD).map(dKey),
])
function selectSmall() {
  selected.value = new Set(smallKeys.value)
}
const smallLabel = computed(() => `Select the ${smallKeys.value.length} under ${fmtUsd(WORKLIST_SMALL_ITEM_USD)}`)

// ── Group subtotals (of what is SHOWN — the month figures are in `summary`) ──
const sessionsShownCost = computed(() => props.sessions.reduce((a, s) => a + Number(s.cost_usd), 0))
const daysShownCost = computed(() => props.unaccounted.reduce((a, d) => a + Number(d.cost_usd), 0))
// The dismissed drawer describes ITSELF: how many items are restorable and what
// they are worth. Deliberately not the month figure — the drawer is all-time, so
// pairing a month count with an all-time list would make one of them a lie. The
// month's dismissed total is on the hero, beside the unallocated total it sits in.
const dismissedShown = computed(
  () => props.dismissed.sessions.length + props.dismissed.unaccounted.length,
)
const dismissedShownCost = computed(
  () =>
    props.dismissed.sessions.reduce((a, s) => a + Number(s.cost_usd), 0) +
    props.dismissed.unaccounted.reduce((a, d) => a + Number(d.cost_usd), 0),
)
// Either dismissed list can be at the read cap, in which case "restore
// everything" is not something this drawer can offer — it can only restore what
// it is holding. Say so, and name the button after what it actually does.
const dismissedAtCap = computed(
  () =>
    props.dismissed.sessions.length >= WORKLIST_LIST_LIMIT ||
    props.dismissed.unaccounted.length >= WORKLIST_LIST_LIMIT,
)

// The lists are all-time and capped; the counts in `summary` are this month and
// uncapped, so the two differ in BOTH directions and the card must say which.
// (The old copy assumed one direction and announced a "showing the 12 most
// recent" tail that did not exist — the 22 it compared against was 12 sessions
// plus 10 days.) Only ever state a difference that is actually there.
const moreSessions = computed(() =>
  Math.max(0, props.summary.needs_tagging_sessions - props.sessions.length),
)
const moreDays = computed(() =>
  Math.max(0, props.summary.needs_tagging_days - props.unaccounted.length),
)
const olderSessions = computed(() =>
  Math.max(0, props.sessions.length - props.summary.needs_tagging_sessions),
)
const olderDays = computed(() =>
  Math.max(0, props.unaccounted.length - props.summary.needs_tagging_days),
)
/*
 * The BACKLOG, named. `summary` is month-scoped; the lists below are not, so a
 * developer could read "2 items this month need a decision" over 15 live
 * Tag/Dismiss buttons worth $100.27 — the headline describing the queue's
 * ARRIVAL RATE while the thing under it is its DEPTH.
 *
 * Derived, never a second source of truth: everything rendered below, minus the
 * month the headline already states.
 */
const olderCount = computed(() => olderSessions.value + olderDays.value)
/** Everything rendered below: the QUEUE, which is the question being asked. */
const listedCount = computed(() => props.sessions.length + props.unaccounted.length)
const monthCost = computed(() => Number(props.summary.untagged_cost_usd ?? 0))
/** Share of the queue that is this month — drives the proportion bar. */
const monthSharePct = computed(() =>
  listedCost.value > 0 ? Math.min(100, (monthCost.value / listedCost.value) * 100) : 0,
)
const listedCost = computed(
  () =>
    props.sessions.reduce((a, s) => a + Number(s.cost_usd), 0) +
    props.unaccounted.reduce((a, d) => a + Number(d.cost_usd), 0),
)
const olderCost = computed(() =>
  Math.max(0, listedCost.value - Number(props.summary.untagged_cost_usd ?? 0)),
)

// ── Bulk actions ─────────────────────────────────────────────────────────────
const busy = ref<'dismiss' | 'restore' | null>(null)
const error = ref<string | null>(null)

async function post(action: 'dismiss' | 'restore', sessions: string[], unaccounted: string[]) {
  if (busy.value) return
  busy.value = action
  error.value = null
  try {
    await $fetch('/api/v1/me/worklist/bulk', { method: 'POST', body: { action, sessions, unaccounted } })
    selected.value = new Set()
    emit('changed')
  } catch (e: unknown) {
    error.value = apiErrorDetail(e, `Could not ${action} those items`)
    // A rejection usually means the card is stale — someone else tagged the item,
    // or it left the queue. Refetch anyway (the message stays): otherwise the
    // now-invalid item is still listed and still selected, and the developer can
    // only click the same failing button again.
    emit('changed')
  } finally {
    busy.value = null
  }
}

const dismissSelected = () =>
  post(
    'dismiss',
    selectedSessions.value.map((s) => s.session_id),
    selectedDays.value.map((d) => d.id),
  )
const dismissSession = (s: WorklistSession) => post('dismiss', [s.session_id], [])
const dismissDay = (d: WorklistDay) => post('dismiss', [], [d.id])
const restoreAll = () =>
  post(
    'restore',
    props.dismissed.sessions.map((s) => s.session_id),
    props.dismissed.unaccounted.map((d) => d.id),
  )
const restoreSession = (s: WorklistSession) => post('restore', [s.session_id], [])
const restoreDay = (d: WorklistDay) => post('restore', [], [d.id])

function tagSelected() {
  emit('tagBulk', {
    sessions: selectedSessions.value.map((s) => s.session_id),
    unaccounted: selectedDays.value.map((d) => d.id),
    count: selectedCount.value,
    cost_usd: selectedCost.value,
  })
}

/*
 * "Nothing needs tagging 🎉" is a CLAIM about the developer's month, and it is
 * only safe to make when the data actually arrived. If the fetch failed, or the
 * last decision was rejected (a 401 after a deploy signs everyone out, say),
 * the list is empty because we know nothing — and congratulating someone on an
 * empty queue while an error sits above it is the "a failed fetch must never
 * read as a confident $0.00" rule, broken.
 *
 * The two reasons are kept APART rather than folded into one flag, because they
 * are different facts and the replacement copy has to say which one happened.
 * `error` is set only by a rejected dismiss/restore (see `post` above) — never
 * by the fetch — so telling someone "couldn't load your worklist" after a 409 on
 * an otherwise healthy load is simply untrue. It is also the LIKELIEST way to
 * land here: `post` explains that a rejection usually means the item already
 * left the queue, and it refetches, which is exactly how the list ends up empty.
 */
const loadUnknown = computed(() => props.loadFailed === true)
const decisionRejected = computed(() => !loadUnknown.value && error.value !== null)
const settled = computed(() => !loadUnknown.value && !decisionRejected.value)

const showDismissed = ref(false)
</script>

<template>
  <UiCard accent="zeal" data-testid="untagged-card" class="mb-4">
    <div class="flex items-baseline gap-3 flex-wrap">
      <!-- HEADING ONLY. Every control below — multi-select, the dismissed count
           and its show link, the sessions vs provider-recorded-days split and
           its explanation, tool marks, model chips, session ids, Tag and
           Dismiss — is unchanged. -->
      <UiEyebrow>Still undecided</UiEyebrow>
      <!--
        THE QUEUE, THEN ITS SPLIT — as figures, not a sentence.
        This header used to be a month-scoped figure with an 11px "this month"
        beside it and a 32-word byline carrying four numbers. The reader's two
        questions are "how much is undecided" and "how much of it is old"; both
        were answers they had to assemble from prose. The instruction that
        followed ("Tag to a budget or an activity — or dismiss what isn't worth
        it") described the Tag and Dismiss buttons on every row beneath it, and
        the caveat about dismissed spend now lives on the Dismiss control, where
        it is read at the moment it applies rather than as a standing disclaimer.
      -->
      <span
        v-if="listedCount"
        class="text-2xl font-bold text-brand-zeal-ink"
        style="font-variant-numeric: tabular-nums"
        data-testid="undecided-total"
      >{{ fmtUsd(listedCost) }}</span>
      <span v-if="listedCount" class="text-sm text-carbon-2">
        · {{ listedCount }} {{ listedCount === 1 ? 'item' : 'items' }}
      </span>
      <!-- Decided-and-left. Muted by design: it is not work, but hiding it
           entirely would make a dismissal irreversible in practice. -->
      <button
        v-if="dismissedShown"
        type="button"
        class="ml-auto text-[11px] text-carbon-3 hover:text-brand-harmony underline underline-offset-2"
        data-testid="dismissed-toggle"
        :aria-expanded="showDismissed"
        @click="showDismissed = !showDismissed"
      >
        {{ dismissedShown }} dismissed · {{ fmtUsd(dismissedShownCost) }}
        · {{ showDismissed ? 'hide' : 'show' }}
      </button>
    </div>

    <div v-if="listedCount" class="mt-3 max-w-[420px]" data-testid="undecided-split">
      <div
class="flex h-1.5 rounded-full overflow-hidden bg-calm-2" role="img"
           :aria-label="`${fmtUsd(monthCost)} this month, ${fmtUsd(olderCost)} from earlier months`">
        <div class="h-full bg-brand-zeal" :style="{ width: `${monthSharePct}%` }" />
      </div>
      <div
class="flex flex-wrap gap-x-6 gap-y-1 mt-1.5 text-[12px]"
           style="font-variant-numeric: tabular-nums">
        <span class="text-carbon-2">
          <span class="inline-block w-2 h-2 rounded-full bg-brand-zeal align-middle mr-1.5" />
          This month <b class="text-carbon">{{ fmtUsd(monthCost) }}</b>
          · {{ summary.needs_tagging_count }}
        </span>
        <span v-if="olderCount" class="text-carbon-2" data-testid="undecided-older">
          <span class="inline-block w-2 h-2 rounded-full bg-calm align-middle mr-1.5" />
          Earlier months <b class="text-carbon">{{ fmtUsd(olderCost) }}</b>
          · {{ olderCount }}
        </span>
      </div>
    </div>

    <p v-if="error" class="text-xs text-rag-red mt-2" role="alert" data-testid="worklist-error">{{ error }}</p>

    <!-- Selection toolbar + action bar. One selection spans both groups, so a
         "select all → tag" clears the month in one save. -->
    <div
      v-if="activeKeys.length"
      class="mt-3 flex items-center gap-3 flex-wrap text-xs"
      data-testid="worklist-toolbar"
    >
      <label class="flex items-center gap-2 text-carbon-2 cursor-pointer">
        <input
          type="checkbox"
          class="rounded border-calm-2"
          :checked="allSelected"
          :indeterminate="someSelected"
          data-testid="worklist-select-all"
          @change="toggleAll"
        >
        Select all
      </label>
      <button
        v-if="smallKeys.length"
        type="button"
        class="text-carbon-3 hover:text-brand-harmony underline underline-offset-2"
        data-testid="worklist-select-small"
        @click="selectSmall"
      >
        {{ smallLabel }}
      </button>

      <div
        v-if="selectedCount"
        class="ml-auto flex items-center gap-2 rounded-lg bg-brand-harmony-sheer px-3 py-1.5"
        data-testid="worklist-action-bar"
      >
        <span class="font-semibold text-carbon" style="font-variant-numeric: tabular-nums">
          {{ selectedCount }} selected · {{ fmtUsd(selectedCost) }}
        </span>
        <UiButton kind="primary" size="sm" data-testid="worklist-tag-selected" @click="tagSelected">
          Tag…
        </UiButton>
        <UiButton
          kind="secondary"
          size="sm"
          :disabled="busy !== null"
          data-testid="worklist-dismiss-selected"
          @click="dismissSelected"
        >
          {{ busy === 'dismiss' ? 'Dismissing…' : 'Dismiss' }}
        </UiButton>
        <UiButton kind="ghost" size="sm" data-testid="worklist-clear" @click="selected = new Set()">
          Clear
        </UiButton>
      </div>
    </div>

    <!-- SESSIONS — conversations. 2-column grid of compact cards so the actions
         sit next to their session rather than across a full-width ocean. -->
    <div v-if="sessions.length" class="mt-4" data-testid="untagged-sessions">
      <div class="flex items-baseline gap-2 text-[11px] text-carbon-3 mb-2">
        <span class="font-bold uppercase tracking-[1px] text-carbon-2">Sessions</span>
        <span data-testid="sessions-subtotal">{{ sessions.length }} · {{ fmtUsd(sessionsShownCost) }}</span>
        <span v-if="moreSessions">· {{ moreSessions }} more this month not shown</span>
        <span v-if="olderSessions">· incl. {{ olderSessions }} from earlier months</span>
      </div>
      <div class="grid md:grid-cols-2 gap-2">
        <div
          v-for="s in sessions"
          :key="s.session_id"
          class="flex items-center gap-2.5 rounded-lg border px-3 py-2.5 transition-colors"
          :class="isSelected(sKey(s)) ? 'border-brand-harmony bg-brand-harmony-sheer' : 'border-brand-zeal-lite/70 bg-white/70'"
          :data-testid="`untagged-${s.session_id}`"
        >
          <input
            type="checkbox"
            class="rounded border-calm-2 shrink-0"
            :checked="isSelected(sKey(s))"
            :aria-label="`Select session ${s.session_id}`"
            :data-testid="`select-${s.session_id}`"
            @change="toggle(sKey(s))"
          >
          <Icon :name="clientMeta(s.tool).icon" class="text-base shrink-0" :title="clientMeta(s.tool).name" />
          <div class="min-w-0 flex-1">
            <div class="text-xs text-carbon truncate">
              <span class="font-semibold">{{ clientMeta(s.tool).name }}</span>
              <span class="text-carbon-3"> · {{ fmtTimeAgo(s.last_event) }} · {{ fmtTokens(s.tokens) }}</span>
              <UsageModelBadge :by-model="s.by_model" class="ml-1.5 align-middle" />
            </div>
            <div class="text-[11px] text-carbon-3 mt-0.5">
              Session <span class="font-mono text-carbon-2">{{ s.session_id.slice(0, 13) }}</span>
            </div>
          </div>
          <span
            class="text-sm font-bold text-carbon shrink-0"
            style="font-variant-numeric: tabular-nums"
          >{{ fmtUsd(s.cost_usd) }}</span>
          <UiButton
            kind="primary"
            size="sm"
            :disabled="busy !== null"
            :data-testid="`tag-${s.session_id}`"
            @click="emit('tagSession', s)"
          >
            Tag
          </UiButton>
          <UiButton
            kind="ghost"
            size="sm"
            :disabled="busy !== null"
            :title="`Dismiss — leave ${fmtUsd(s.cost_usd)} unallocated on your Business Unit`"
            :data-testid="`dismiss-${s.session_id}`"
            @click="dismissSession(s)"
          >
            Dismiss
          </UiButton>
        </div>
      </div>
    </div>

    <p
      v-else-if="!unaccounted.length && settled"
      class="text-xs text-carbon-2 mt-3"
      data-testid="worklist-empty"
    >
      Nothing needs tagging — all your spend is on a project, categorised, or dismissed.
    </p>
    <p
      v-else-if="!unaccounted.length && loadUnknown"
      class="text-xs text-carbon-3 mt-3"
      data-testid="worklist-unknown"
    >
      Couldn't load your worklist, so this list may be incomplete — retry above.
    </p>
    <p
      v-else-if="!unaccounted.length"
      class="text-xs text-carbon-3 mt-3"
      data-testid="worklist-stale"
    >
      Your last change didn't go through, so this list may be out of date.
    </p>

    <!-- §A — PROVIDER-RECORDED DAYS: usage the provider's API counted that OTel
         didn't capture (e.g. an un-enrolled container). Same queue, same
         decisions, but the unit is a DAY, so it reads visually distinct. -->
    <div v-if="unaccounted.length" class="mt-5 pt-4 border-t border-brand-zeal-lite/70" data-testid="unaccounted-section">
      <div class="flex items-baseline gap-2 text-[11px] text-carbon-3 mb-2">
        <span class="font-bold uppercase tracking-[1px] text-carbon-2">Provider-recorded days</span>
        <span data-testid="days-subtotal">{{ unaccounted.length }} · {{ fmtUsd(daysShownCost) }}</span>
        <span v-if="moreDays">· {{ moreDays }} more this month not shown</span>
        <span v-if="olderDays">· incl. {{ olderDays }} from earlier months</span>
      </div>
      <p class="text-xs text-carbon-2 mb-2">
        <!--
          WAS: "Usage the provider's API counted that your OTel didn't — tag each
          day to a budget, same as a session." Two problems in one line — it
          named the transport (OTel) to a reader who never chose it, and its
          second half described the Tag button sitting on every row below.
        -->
        Days your provider billed for with nothing recorded on your machine.
      </p>
      <div class="grid md:grid-cols-2 gap-2">
        <div
          v-for="u in unaccounted"
          :key="u.id"
          class="flex items-center gap-2.5 rounded-lg border border-dashed px-3 py-2.5 transition-colors"
          :class="isSelected(dKey(u)) ? 'border-brand-harmony bg-brand-harmony-sheer' : 'border-brand-zeal-lite/90 bg-brand-zeal-lite/15'"
          :data-testid="`unaccounted-row-${u.id}`"
        >
          <input
            type="checkbox"
            class="rounded border-calm-2 shrink-0"
            :checked="isSelected(dKey(u))"
            :aria-label="`Select ${u.day}`"
            :data-testid="`select-day-${u.id}`"
            @change="toggle(dKey(u))"
          >
          <Icon :name="clientMeta(u.tool).icon" class="text-base shrink-0" :title="clientMeta(u.tool).name" />
          <div class="min-w-0 flex-1">
            <div class="text-xs text-carbon truncate">
              <span class="font-semibold">{{ u.day }}</span>
              <!-- Tokens are elided at 0: the provider's billing API reports cost
                   without a token count for most lanes, so "· 0" is noise, not data. -->
              <span class="text-carbon-3"> · {{ clientMeta(u.tool).name }}<template v-if="u.tokens"> · {{ fmtTokens(u.tokens) }}</template></span>
            </div>
          </div>
          <span
            class="text-sm font-bold text-carbon shrink-0"
            style="font-variant-numeric: tabular-nums"
          >{{ fmtUsd(u.cost_usd) }}</span>
          <!-- The same drill-down affordance a session row carries. The day's
               model mix, token lanes and requests are all recorded by the
               provider; until now the row showed only the dollar figure. -->
          <UiButton
            kind="ghost"
            size="sm"
            :disabled="busy !== null"
            :data-testid="`unaccounted-details-${u.id}`"
            @click="emit('dayDetail', u)"
          >
            Details
          </UiButton>
          <UiButton
            kind="primary"
            size="sm"
            :disabled="busy !== null"
            :data-testid="`unaccounted-tag-${u.id}`"
            @click="emit('tagDay', u)"
          >
            Tag
          </UiButton>
          <UiButton
            kind="ghost"
            size="sm"
            :disabled="busy !== null"
            :title="`Dismiss — leave ${fmtUsd(u.cost_usd)} unallocated on your Business Unit`"
            :data-testid="`dismiss-day-${u.id}`"
            @click="dismissDay(u)"
          >
            Dismiss
          </UiButton>
        </div>
      </div>
    </div>

    <!-- DISMISSED — decided, out of the queue, still yours. Restorable one by
         one or all at once. The spend never left the unallocated total. -->
    <div
      v-if="showDismissed && dismissedShown"
      class="mt-5 pt-4 border-t border-calm-2"
      data-testid="dismissed-section"
    >
      <div class="flex items-baseline gap-2 mb-2">
        <span class="text-[11px] font-bold uppercase tracking-[1px] text-carbon-2">Dismissed</span>
        <span class="text-[11px] text-carbon-3">
          still unallocated · charged to your Business Unit<template v-if="dismissedAtCap"> · showing the most recent {{ WORKLIST_LIST_LIMIT }} per kind</template>
        </span>
        <UiButton
          kind="ghost"
          size="sm"
          class="ml-auto"
          :disabled="busy !== null"
          data-testid="restore-all"
          @click="restoreAll"
        >
          {{ busy === 'restore' ? 'Restoring…' : `Restore ${dismissedShown} shown` }}
        </UiButton>
      </div>
      <ul class="divide-y divide-calm-2 rounded-lg border border-calm-2 bg-white/50">
        <li
          v-for="s in dismissed.sessions"
          :key="s.session_id"
          class="flex items-center gap-3 px-3 py-2"
          :data-testid="`dismissed-${s.session_id}`"
        >
          <Icon :name="clientMeta(s.tool).icon" class="text-sm shrink-0 opacity-60" aria-hidden="true" />
          <span class="text-[11px] text-carbon-3 min-w-0 flex-1 truncate">
            <span class="font-mono">{{ s.session_id.slice(0, 13) }}</span> · {{ fmtTimeAgo(s.last_event) }}
          </span>
          <span class="text-xs text-carbon-2 shrink-0" style="font-variant-numeric: tabular-nums">{{ fmtUsd(s.cost_usd) }}</span>
          <UiButton
            kind="ghost"
            size="sm"
            :disabled="busy !== null"
            :data-testid="`restore-${s.session_id}`"
            @click="restoreSession(s)"
          >
            Restore
          </UiButton>
        </li>
        <li
          v-for="u in dismissed.unaccounted"
          :key="u.id"
          class="flex items-center gap-3 px-3 py-2"
          :data-testid="`dismissed-day-${u.id}`"
        >
          <Icon :name="clientMeta(u.tool).icon" class="text-sm shrink-0 opacity-60" aria-hidden="true" />
          <span class="text-[11px] text-carbon-3 min-w-0 flex-1 truncate">
            {{ u.day }} · {{ clientMeta(u.tool).name }}
          </span>
          <span class="text-xs text-carbon-2 shrink-0" style="font-variant-numeric: tabular-nums">{{ fmtUsd(u.cost_usd) }}</span>
          <UiButton
            kind="ghost"
            size="sm"
            :disabled="busy !== null"
            :data-testid="`restore-day-${u.id}`"
            @click="restoreDay(u)"
          >
            Restore
          </UiButton>
        </li>
      </ul>
    </div>
  </UiCard>
</template>
