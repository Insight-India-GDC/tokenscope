<script setup lang="ts">
/*
 * ActivityCard — ONE list of what you did: OTel-observed sessions AND
 * provider-recorded days, in the same table (owner ruling 2026-08-05; design
 * §F4 D17-D21). It replaces RecentSessionsCard, which could only ever show
 * sessions — see shared/schemas/activity.ts for why a tagged provider day used
 * to vanish, and why this list is called Activity and not Sessions.
 *
 * TWO GRAINS, TWO RENDERINGS, ONE SORT. Every row sorts on the UTC day. A
 * SESSION then renders its real instant (`ts_last`) in the viewer's zone,
 * because it is a moment. A PROVIDER-RECORDED DAY renders the DATE and nothing
 * else — the type carries no timestamp, and this component must never invent
 * one. "00:00" here would be the NULL-as-0 defect wearing a clock.
 *
 * TWO DRAWERS, NEITHER OF THEM NEW (D21). A session row opens the session
 * drawer; a provider-day row opens the provider-day drawer (#231). Both already
 * ship, both are mounted by the pages, and this card only says WHICH — it
 * builds no details pane of its own, here or on the tagging worklist.
 *
 * The card owns its own filters, paging and fetch (a keyset list cannot be
 * driven from outside without moving the cursor there too) and exposes
 * `refresh()` so the pages keep their post-tag refresh choreography.
 */
import { computed, ref, watch } from 'vue'
import type {
  ActivityFilters,
  ActivityListResponse,
  ActivityRow,
} from '#shared/schemas/activity'

/** The tag/re-tag intent — shaped for HomeTagSessionDialog's TagTarget prop. */
export interface ActivityRetagTarget {
  session_id: string
  instance_id: string | null
  tool: string
  cost_usd: string | number
  /** NULL = the provider reported no token quantity (see the wire type). */
  tokens: number | null
  last_event: string
  project_id: string | null
  activity: string | null
  by_model?: { model: string; tokens: number; cost_usd: string }[]
  /** §A per-day records POST to their own assign route; the dialog is the same. */
  assign_url?: string
  subject_kind?: 'session' | 'day'
  subject_label?: string
}

const props = defineProps<{
  /** /me/quarantined-spend rows — drives the "unverified" badge on session rows. */
  quarantined?: { session_id: string; instance_id: string; cost_usd: string }[]
}>()

const emit = defineEmits<{
  /** The id is a conversation key for `open-session`, a record id for `open-provider-day`. */
  'open-session': [id: string]
  'open-provider-day': [id: string]
  retag: [target: ActivityRetagTarget]
}>()

const collapsed = ref(false) // open by default — it was too easy to miss collapsed

// ── Filters (D20). The CSV below is built from these SAME values. ────────────
const kind = ref<ActivityFilters['kind']>('all')
const tagged = ref<ActivityFilters['tagged']>('all')
const tool = ref<string>('')

const activeFilters = computed(() => {
  const q: Record<string, string> = {}
  if (kind.value !== 'all') q.kind = kind.value
  if (tagged.value !== 'all') q.tagged = tagged.value
  if (tool.value) q.tool = tool.value
  return q
})
const exportHref = computed(() => {
  const q = new URLSearchParams(activeFilters.value)
  const qs = q.toString()
  return `/api/v1/me/activity/export${qs ? `?${qs}` : ''}`
})

function exportCsv() {
  // Direct navigation — the browser handles the Content-Disposition. The URL
  // carries the ACTIVE filters, so the file is what the reader is looking at.
  if (import.meta.client) window.location.href = exportHref.value
}

// ── The keyset page (D18). `cursor` is opaque; only the server mints it. ─────
const PAGE_SIZE = 25
const rows = ref<ActivityRow[]>([])
const nextCursor = ref<string | null>(null)
const hasMore = ref(false)
const pending = ref(false)
const loadError = ref(false)

/*
 * ONLY THE NEWEST REQUEST MAY WRITE (external review). Three things call `load`
 * — a filter change, "Load more", and the page's post-tag `refresh()` — and
 * nothing stopped their responses landing out of order. Flip a filter twice
 * quickly and the FIRST response could arrive last and replace the list with
 * rows that do not match the controls above them; a `refresh()` racing a "Load
 * more" could append a page cut under different filters. On a list whose whole
 * job is "what did I do", a row that does not belong is indistinguishable from a
 * data error.
 *
 * A monotonic token is the whole mechanism: every call claims the next number,
 * and a response whose number is no longer current is DISCARDED — rows, cursor,
 * error and the pending flag alike. The last request wins because it is the last
 * request, not because it happened to be quickest.
 */
let requestSeq = 0

async function load(opts: { append: boolean }) {
  const seq = ++requestSeq
  pending.value = true
  if (!opts.append) loadError.value = false
  try {
    const res = await $fetch<ActivityListResponse>('/api/v1/me/activity', {
      query: {
        ...activeFilters.value,
        limit: PAGE_SIZE,
        ...(opts.append && nextCursor.value ? { cursor: nextCursor.value } : {}),
      },
    })
    if (seq !== requestSeq) return
    rows.value = opts.append ? [...rows.value, ...res.rows] : res.rows
    nextCursor.value = res.next_cursor
    hasMore.value = res.has_more
  } catch {
    if (seq !== requestSeq) return
    loadError.value = true
    if (!opts.append) rows.value = []
  } finally {
    // A superseded request must not clear the flag the CURRENT one is holding up.
    if (seq === requestSeq) pending.value = false
  }
}

/** Re-read from the first page — the pages call this after a tag or a resolve. */
async function refresh() {
  nextCursor.value = null
  await load({ append: false })
}

/*
 * THIS CARD ANSWERS NOTHING ABOUT ONBOARDING, AND NO LONGER PRETENDS TO
 * (external review r2). It briefly published `loaded`/`hasRows` so `/` could
 * decide its new-user CTA from this list instead of a second probe. Both facts
 * are about the CURRENT PAGE of the CURRENT FILTER — an active filter matching
 * nothing, or a failed refresh, read identically to "has never emitted" — and
 * the list is a UNION of OTel sessions and API-reported provider days, so it
 * cannot speak for the OTel lane the CTA is about at all. The page now reads a
 * server fact (`/me/home.has_ever_emitted`); only `refresh` is exposed.
 */
defineExpose({ refresh })

// A filter change is a NEW list, never an extension of the old one: appending
// across a cursor minted under different filters is how a paged list starts
// showing rows that do not match its own controls.
watch([kind, tagged, tool], () => void refresh(), { immediate: true })

// ── Rendering ────────────────────────────────────────────────────────────────
const quarantinedKeys = computed(
  () => new Set((props.quarantined ?? []).map((q) => `${q.session_id}|${q.instance_id}`)),
)
function isQuarantined(r: ActivityRow): boolean {
  return (
    r.kind === 'session' &&
    r.instance_id != null &&
    quarantinedKeys.value.has(`${r.id}|${r.instance_id}`)
  )
}

/*
 * A TOKEN COUNT THAT WAS NEVER MEASURED IS NOT A ZERO (external review).
 * GitHub's AI-credit usage API reports credits, not tokens, so a Copilot
 * provider-day genuinely has no token quantity — and this column printed "0" for
 * it, which reads as "measured, and it was nothing" beside a non-zero cost. It
 * is the same NULL-as-0 defect the `day` cell below refuses to commit with a
 * fabricated "00:00".
 *
 * The wire type is `number | null` (`ActivityRowBase.tokens`), and the retag
 * target this card emits carries the null through rather than flattening it —
 * the dialog states absence in its own subject row too. The formatting stays in
 * the template: `fmtTokens` is a Nuxt auto-import and is not in module scope.
 */
function tokensMissing(r: ActivityRow): boolean {
  return r.tokens == null
}

function toolPillProp(t: string): 'CC' | 'Cop' | 'Mixed' {
  if (t === 'copilot-cli') return 'Cop'
  if (t === 'mixed') return 'Mixed'
  return 'CC'
}

function openDetail(r: ActivityRow) {
  if (r.kind === 'session') emit('open-session', r.id)
  else emit('open-provider-day', r.id)
}

function retag(r: ActivityRow) {
  if (r.kind === 'session') {
    emit('retag', {
      session_id: r.id,
      instance_id: r.instance_id,
      tool: r.tool,
      cost_usd: r.cost_usd,
      tokens: r.tokens,
      last_event: r.ts_last,
      project_id: r.project_id,
      activity: r.activity,
      by_model: r.by_model,
      subject_kind: 'session',
    })
  } else {
    emit('retag', {
      session_id: r.id,
      instance_id: null,
      tool: r.tool,
      cost_usd: r.cost_usd,
      tokens: r.tokens,
      // The day IS the subject. No instant is invented to fill this field.
      last_event: r.day,
      project_id: r.project_id,
      activity: r.activity,
      assign_url: `/api/v1/me/unaccounted/${r.id}/assign`,
      subject_kind: 'day',
      subject_label: r.day,
    })
  }
}
</script>

<template>
  <UiCard flush data-testid="activity-card">
    <div class="px-6 pt-6 pb-4 border-b border-calm-2">
      <div class="flex items-center justify-between gap-4">
        <button
          class="flex items-center gap-2.5 text-left group"
          data-testid="activity-toggle"
          :aria-expanded="!collapsed"
          @click="collapsed = !collapsed"
        >
          <Icon
            name="tabler:chevron-down"
            class="text-lg text-carbon-3 transition-transform group-hover:text-carbon"
            :class="collapsed ? '-rotate-90' : ''"
          />
          <div>
            <div class="text-lg font-bold text-carbon group-hover:text-brand-harmony transition-colors">Activity</div>
            <div class="text-xs text-carbon-3 mt-0.5">
              Your sessions and your provider-recorded days, newest first. A record of what
              happened — decided or not.
            </div>
          </div>
        </button>
        <UiButton v-if="!collapsed" kind="ghost" size="sm" data-testid="export-csv" @click="exportCsv">
          Export CSV
        </UiButton>
      </div>
      <!-- Filters (D20). The CSV above is built from these same values. -->
      <div v-if="!collapsed" class="flex flex-wrap items-center gap-2 mt-3" data-testid="activity-filters">
        <select
          v-model="kind"
          class="text-[11px] border border-calm-2 rounded px-2 py-1 text-carbon-2 bg-white"
          aria-label="Filter by record kind"
          data-testid="activity-filter-kind"
        >
          <option value="all">All records</option>
          <option value="session">Sessions</option>
          <option value="provider-day">Provider-recorded days</option>
        </select>
        <select
          v-model="tagged"
          class="text-[11px] border border-calm-2 rounded px-2 py-1 text-carbon-2 bg-white"
          aria-label="Filter by budget state"
          data-testid="activity-filter-tagged"
        >
          <option value="all">On or off a budget</option>
          <option value="tagged">On a budget</option>
          <option value="untagged">Not on a budget</option>
        </select>
        <select
          v-model="tool"
          class="text-[11px] border border-calm-2 rounded px-2 py-1 text-carbon-2 bg-white"
          aria-label="Filter by client"
          data-testid="activity-filter-tool"
        >
          <option value="">Every client</option>
          <option value="claude-code">Claude Code</option>
          <option value="copilot-cli">Copilot CLI</option>
        </select>
      </div>
    </div>

    <UiEmptyState
      v-if="!collapsed && loadError"
      headline="Couldn't load your activity"
      sub="Something went wrong fetching this list. Change a filter or refresh to try again."
      data-testid="activity-error"
    />
    <UiEmptyState
      v-else-if="!collapsed && !rows.length && !pending"
      headline="Nothing here yet"
      sub="Run Claude Code in a repository that has a .tokenscope file, then run the project MCP prompt. The session lands here within a minute. Provider-recorded days arrive with reconciliation."
    />
    <div v-else-if="!collapsed" class="overflow-x-auto">
      <table class="w-full text-sm">
        <thead class="text-[11px] text-carbon-3 uppercase tracking-[1.2px]">
          <tr class="bg-brand-harmony-sheer/40">
            <th class="text-left font-bold px-6 py-3">Record</th>
            <th class="text-left font-bold px-6 py-3">Device</th>
            <th class="text-left font-bold px-6 py-3">Project</th>
            <th class="text-left font-bold px-6 py-3">Tool</th>
            <th class="text-left font-bold px-6 py-3">When</th>
            <th class="text-right font-bold px-6 py-3">Tokens</th>
            <th class="text-right font-bold px-6 py-3">Cost</th>
            <th class="px-6 py-3"><span class="sr-only">Actions</span></th>
          </tr>
        </thead>
        <tbody class="divide-y divide-calm-2">
          <tr v-for="r in rows" :key="r.kind + '|' + r.id" :data-testid="`activity-row-${r.id}`">
            <td class="px-6 py-3">
              <button
                type="button"
                class="text-carbon hover:text-brand-harmony hover:underline underline-offset-2 transition-colors font-mono text-[12px]"
                :data-testid="`activity-open-${r.id}`"
                :title="r.kind === 'session' ? `View full breakdown for ${r.id}` : `View what the provider counted on ${r.day}`"
                @click="openDetail(r)"
              >
                <template v-if="r.kind === 'session'">{{ r.id.slice(0, 12) }}</template>
                <template v-else>Provider-recorded day</template>
              </button>
              <span
                class="ml-2 text-[10px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded"
                :class="r.kind === 'session' ? 'bg-brand-harmony-sheer text-carbon-2' : 'bg-brand-vision/15 text-carbon-2'"
                :data-testid="`activity-kind-${r.id}`"
              >{{ r.kind === 'session' ? 'session' : 'provider day' }}</span>
            </td>
            <td class="px-6 py-3 font-mono text-[11px] text-carbon-3" :title="(r.kind === 'session' && r.instance_id) || ''">
              {{ r.kind === 'session' && r.instance_id ? r.instance_id.slice(0, 8) : '—' }}
            </td>
            <td class="px-6 py-3">
              <span class="font-semibold text-carbon">{{ r.project_code ?? '—' }}</span>
              <span
                v-if="!r.attributed"
                class="ml-2 text-[10px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded bg-calm/50 text-carbon-3"
                title="No budget — unallocated spend. Tag it to assign it."
              >unallocated</span>
              <span
                v-if="r.kind === 'provider-day' && r.dismissed"
                class="ml-2 text-[10px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded bg-calm-2 text-carbon-2"
                title="You decided to leave this unallocated. The spend is untouched, and the decision is reversible."
                data-testid="activity-dismissed-badge"
              >dismissed</span>
              <span
                v-if="r.kind === 'session' && r.partly_ended"
                class="ml-2 text-[10px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded bg-calm-2 text-carbon-2"
                :title="`Part of this conversation ran on ${r.ended_project_code ?? 'an ended project'} (now ended). Re-tagging moves only the spilled portion.`"
                data-testid="partly-ended-badge"
              >partly on ended {{ r.ended_project_code ?? 'project' }}</span>
              <span
                v-if="r.activity"
                class="ml-2 text-[10px] font-medium px-1.5 py-0.5 rounded bg-brand-zeal-lite/60 text-carbon-2"
                :title="`Activity: ${r.activity}`"
              >{{ r.activity }}</span>
              <span
                v-if="isQuarantined(r)"
                class="ml-2 text-[10px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded bg-rag-amber/10 text-rag-amber"
                title="Unverified spend — this session claims an instance with no covering emit heartbeat. It's pending reconciliation (which confirms or removes it). Nothing is revoked or deleted; this is an early heads-up, not an enforcement action."
                data-testid="quarantined-badge"
              >unverified</span>
            </td>
            <td class="px-6 py-3">
              <span class="inline-flex items-center gap-1.5">
                <UiToolPill :tool="toolPillProp(r.tool)" />
                <UsageModelBadge v-if="r.kind === 'session'" :by-model="r.by_model" />
              </span>
            </td>
            <!--
              THE GRAIN RULE, in one cell. A session is an instant and renders
              in the viewer's zone; a provider-recorded day has no instant and
              renders its UTC date, never a fabricated time.
            -->
            <td class="px-6 py-3 text-carbon-2 text-[12px]" :data-testid="`activity-when-${r.id}`">
              <template v-if="r.kind === 'session'">{{ fmtTimeAgo(r.ts_last) }}</template>
              <template v-else>{{ r.day }}</template>
            </td>
            <!-- "not reported" ≠ 0: some providers count credits, not tokens. -->
            <td
              class="px-6 py-3 text-right text-carbon-2"
              style="font-variant-numeric: tabular-nums"
              :class="tokensMissing(r) ? 'italic text-carbon-3' : ''"
              :title="tokensMissing(r) ? 'This provider reports no token quantity for a recorded day — the cost is real, the token count was never measured.' : undefined"
              :data-testid="`activity-tokens-${r.id}`"
            >
              {{ tokensMissing(r) ? 'not reported' : fmtTokens(r.tokens) }}
            </td>
            <td class="px-6 py-3 text-right font-bold text-carbon" style="font-variant-numeric: tabular-nums">
              {{ fmtUsd(r.cost_usd) }}
            </td>
            <td class="px-6 py-3 text-right whitespace-nowrap">
              <UiButton kind="ghost" size="sm" :data-testid="`details-${r.id}`" @click="openDetail(r)">
                Details
              </UiButton>
              <UiButton kind="ghost" size="sm" :data-testid="`retag-${r.id}`" @click="retag(r)">
                {{ r.attributed ? 'Re-tag' : 'Tag' }}
              </UiButton>
            </td>
          </tr>
        </tbody>
      </table>
      <div v-if="hasMore" class="px-6 py-4 border-t border-calm-2 text-center">
        <UiButton kind="ghost" size="sm" :disabled="pending" data-testid="activity-load-more" @click="load({ append: true })">
          {{ pending ? 'Loading…' : 'Load more' }}
        </UiButton>
      </div>
    </div>
  </UiCard>
</template>
