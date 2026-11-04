<script setup lang="ts">
/*
 * Developer view (Journey 1 / design-notes §Screen 2).
 *
 * Six sections per the hi-fi: page-head greeting (Hello {firstName}.)
 * + PeriodSwitch + hero summary card + project buckets list +
 * untagged card with CLI snippet + inbox preview + the Activity
 * table with Export CSV.
 *
 * Wired against:
 *   GET /api/v1/me/home              (Epic 11 — extended)
 *   GET /api/v1/me/inbox?limit=3     (Epic 7)
 *   GET /api/v1/me/activity          (§F4 — sessions AND provider-recorded
 *                                     days; the recent-sessions route retired)
 */
import { computed, ref } from 'vue'
import type { ConnectGuideKind } from '#shared/connect'
import type { WorklistDay, WorklistResponse, WorklistSession } from '#shared/schemas/worklist'
import type { RunRate } from '#shared/schemas/usage'
import type { SpendLens } from '#shared/usage/lens'
import type { LensDisclosureData } from '../components/me/LensDisclosure.vue'
import ActivityCard from '../components/me/ActivityCard.vue'
import type { TagTarget as DialogTagTarget } from '../components/home/TagSessionDialog.vue'
import { budgetPace, budgetPaceKind, budgetPaceLabel, projectedMonthEnd, type BudgetPace } from '../composables/useRagState'
import { useConnectConfig } from '../composables/useConnectConfig'

interface Bucket {
  project_code: string
  display_name: string
  cost_usd: string
  tokens: number
  allocation_total_usd: string
  is_active_now: boolean
  /*
   * Why this project appears in the bucket list:
   *   'assigned'    — user has a project_assignment row
   *   'contributed' — user emitted attribution_record this month (no assignment)
   *   'both'        — assignment AND attribution
   * The UI renders a chip for 'contributed' so the user understands
   * an unassigned project showing up isn't a glitch.
   */
  source: 'assigned' | 'contributed' | 'both'
  // D5: the project has ended. Its pre-end spend stays in the MTD total (kept
  // honest) but the row is collapsed into an "Ended" group in the UI.
  ended: boolean
  /** Distinct contributing clients this month (per-project brand marks). */
  tools: string[]
}

interface TaggedSpendRow {
  activity: string
  cost_usd: string
  tokens: number
  sessions: number
  /** Distinct contributing clients for this activity (brand marks). */
  tools: string[]
}
interface UnallocatedSummary {
  total_cost_usd: string
  total_tokens: number
  tagged_cost_usd: string
  untagged_cost_usd: string
  // The needs-tagging queue, split by item kind (mig 0094 / needs-tagging-worklist.md).
  needs_tagging_count: number
  needs_tagging_sessions: number
  needs_tagging_days: number
  // Decided-and-left-unallocated: still inside total_cost_usd, out of the queue.
  dismissed_cost_usd: string
  dismissed_count: number
  // §A arm 3 (mig 0101): provider-reported usage with no session and no
  // unaccounted_usage row behind it, so there is nothing to attach a tag to.
  // Inside total_cost_usd, never inside the needs-tagging queue.
  untaggable_cost_usd: string
  untaggable_count: number
  soft_cap_usd: string
  over_soft_cap: boolean
}
// §B (#142) — non-Code Claude surface spend (Chat / Cowork / Office / …):
// read-only chargeback lanes from the provider bill. No sessions, never
// taggable — rendered in the separate "Other Claude surfaces" panel.
interface SurfaceRow {
  tool: string
  label: string
  mtd_usd: string
  days: { day: string; usd: string }[]
}
/**
 * The hero's ONE figure under the selected lens, plus everything derived from
 * it (ADR 0012). Built server-side together with the figure so a percentage,
 * bar or run rate can never come from a different lane than the scalar it is
 * rendered beside (decision 4). `quota` is §A only — null under chargeback.
 */
interface Headline {
  lane: SpendLens
  month: string
  mtd_usd: string
  run_rate: RunRate
  quota: {
    total_usd: string
    base_allowance_usd: string
    allocation_usd: string
    projection:
      | { state: 'no-quota' }
      | { state: 'no-spend' }
      | { state: 'exhausted'; over_usd: string }
      | { state: 'projected'; date: string }
      | { state: 'not-at-this-pace' }
  } | null
}

interface UsageResponse {
  month_to_date: string
  total_cost_usd: string
  total_tokens: number
  total_allocation_usd: string
  base_allowance_usd: string
  total_quota_usd: string
  buckets: Bucket[]
  // Unallocated + tagged are now SERVER-computed (accurate, month-scoped, uncapped)
  // — the single source for the cards. /me/sessions/untagged is kept ONLY for the
  // needs-tagging ACTION list (its LIMIT-100/all-time list no longer skews totals).
  unallocated: UnallocatedSummary
  tagged_spend: TaggedSpendRow[]
  surfaces: SurfaceRow[]
  /** null = no event to measure against — renders "freshness unknown" (§A6.1). */
  freshness_minutes_ago: number | null
  note: string
  // ── ADR 0012 (additive: getMyUsage's own shape is also the MCP contract) ──
  headline: Headline
  disclosure: LensDisclosureData
  /**
   * Has this teammate EVER emitted OTel? The onboarding signal, answered on the
   * OTel lane alone (`attribution_record`) — see the CTA note below. Optional so
   * the failed-fetch default can leave it UNSET: absent means "not answered",
   * never "no".
   */
  has_ever_emitted?: boolean
  /** §A6.2 — the degradation banner's signal; null = healthy, banner hidden. */
  attribution_stall?: { since: string } | null
}


// The Activity table (sessions AND provider-recorded days) lives in
// components/me/ActivityCard.vue and owns its own keyset fetch — see §F4.
// This page keeps only the one-row probe the onboarding CTA needs.

const { session, ensure } = useSession()
await ensure()

// Time-bound controls live on the RecentSpendStrip below (rolling 7/30/90-day
// windows over attribution_aggregate) — NOT a page-head period switch. The hero
// stays month-to-date because it is budget-vs-allocation, which is inherently
// monthly; windowing it would imply a "7-day budget", which is meaningless.

// FE-2/FE-10: usage is the page's headline figure — keep it awaited (SSR-
// rendered); every other fetch below is `lazy` (they all have zero-filled
// defaults and render progressively), so SSR no longer serialises six
// round-trips. Each fetch's `error` is surfaced as a visible retry banner —
// a failed fetch must never read as a confident "$0.00".
//
// NO LENS ON THIS PAGE. The hero is made entirely of §A constructs — budgets,
// allocations, the unallocated soft cap — and every one of them measures
// attributed usage, so flipping it to §B collapsed the card to a single scalar
// and a paragraph explaining what had just disappeared. The dashboard therefore
// asks for the default (usage) lens and never sends `?lane`; the chargeback
// lane stays reachable from the (i) under the hero and on the usage-detail page
// (`/usage`), which is single-figure by nature and re-lenses cleanly.
const { data: usage, refresh: refreshUsage, error: usageError } = await useFetch<UsageResponse>(
  '/api/v1/me/home',
  {
    default: () => ({
      month_to_date: '',
      total_cost_usd: '0.00',
      total_tokens: 0,
      total_allocation_usd: '0.00',
      base_allowance_usd: '0.00',
      total_quota_usd: '0.00',
      buckets: [],
      unallocated: {
        total_cost_usd: '0.00',
        total_tokens: 0,
        tagged_cost_usd: '0.00',
        untagged_cost_usd: '0.00',
        needs_tagging_count: 0,
        needs_tagging_sessions: 0,
        needs_tagging_days: 0,
        dismissed_cost_usd: '0.00',
        dismissed_count: 0,
        untaggable_cost_usd: '0.00',
        untaggable_count: 0,
        soft_cap_usd: '0.00',
        over_soft_cap: false,
      },
      tagged_spend: [],
      surfaces: [],
      // §A6.1: a failed fetch is UNKNOWN freshness, never "Updated 0 min ago".
      freshness_minutes_ago: null,
      note: '',
      // The zero-state hero. A failed fetch still raises the retry banner
      // below, so this is never a confident "$0.00" standing on its own.
      headline: {
        lane: 'usage' as SpendLens,
        month: '',
        mtd_usd: '0.00',
        run_rate: {
          projected_month_end_usd: '0.00',
          days_elapsed: 0,
          days_in_month: 0,
          method: 'linear-mtd' as const,
          is_projection: false,
        },
        quota: null,
      },
      disclosure: {
        attributed_usage_usd: '0.00',
        provider_reported_usd: '0.00',
        chargeable_usd: '0.00',
        declared_personal: [],
        declared_personal_usage_usd: '0.00',
        tool_gaps: [],
        cost_centre: null,
        billing_states: [],
      },
    }),
  },
)

/*
 * The tab can outlive the month it is showing (this page headlined "July 2026"
 * at 06:27 on 1 August). The month comes from the SERVER clock at fetch time
 * and useFetch then caches, so re-read on focus — the mechanism UiBuildStamp
 * already used for the same class of staleness.
 */
useRefreshOnVisible(refreshUsage)

/** The Activity table's own handle — the post-tag refresh needs it. */
const activityCard = ref<{ refresh: () => Promise<void> } | null>(null)

/*
 * THE ONBOARDING SIGNAL IS "HAS THIS PERSON EVER EMITTED OTel", AND NOTHING ELSE
 * (external review r2 + owner ruling).
 *
 * Two wrong answers have now been tried here:
 *
 *  1. A standalone `/me/activity?limit=1` probe — a second independent read of
 *     the list rendered 900 lines below, which could disagree with it.
 *  2. The ActivityCard's own `hasRows`, published upward to retire that probe.
 *     But `hasRows` means "the CURRENT page of the CURRENT filter returned
 *     rows": an active filter matching nothing, or a failed refresh, reads as
 *     "never emitted" and shows a new-user CTA to an established developer.
 *
 * Both also answered the wrong QUESTION. F4 made Activity a deliberate UNION of
 * OTel sessions and API-reported provider days, so a Copilot-only teammate — who
 * has never emitted and is exactly who this CTA is for — fills the list and
 * counts as onboarded. That is the rollout gap ("people who SPENT versus people
 * EMITTING through TokenScope") mis-read as coverage.
 *
 * So the signal is a server fact on the OTel lane alone (`attribution_record`,
 * whose only writer is the Azure-Monitor reader), all-time and unfiltered, and
 * it rides the AWAITED `/me/home` payload — no second read to disagree with, and
 * a failed fetch leaves the field UNSET rather than false, so an error can never
 * present as emptiness. `=== false` is the only value that shows the CTA.
 *
 * THREE STATES, NOT TWO (owner ruling 2026-08-06 — "name the gap explicitly").
 * `has_ever_emitted` is the OTel lane alone, so it splits the CTA population in
 * a way "has any activity" cannot:
 *
 *   never emitted, NO records anywhere  → a genuinely new teammate.
 *   never emitted, but PROVIDER-API records exist → they are spending, we can
 *     see it through the provider's own API, and they are invisible to us as an
 *     emitter. Telling this person "no usage yet" is false to their face, and
 *     silently treating them as established is worse: they are exactly the
 *     rollout gap the product exists to measure — "people who SPENT versus
 *     people EMITTING through TokenScope … the one figure that measures us
 *     rather than them" (reporting prototype).
 *   emitting → no CTA.
 *
 * The middle state is detected from the awaited `usage` payload rather than a
 * second read: attributed spend with no emission is precisely provider-reported
 * money. A missing payload leaves it false, so a failed fetch never invents the
 * claim that we can see their usage.
 */
const isEmptyAccount = computed(() => usage.value?.has_ever_emitted === false)
const seenViaProviderOnly = computed(
  () => isEmptyAccount.value && Number(usage.value?.total_cost_usd ?? 0) > 0,
)

async function refreshActivityViews() {
  await (activityCard.value?.refresh() ?? Promise.resolve())
}

// Quarantined ("unverified") spend — sessions whose claimed instance has no
// covering /bearer heartbeat (the cross-instance-spoof signal, maintained by the
// heartbeat-coverage worker). INFORMATIONAL only: pending reconciliation, nothing
// is revoked or deleted. ActivityCard builds the (session|instance)
// key set from these rows to flag matching rows with an "unverified" badge.
interface QuarantinedRow {
  session_id: string
  instance_id: string
  cost_usd: string
}
const { data: quarantined, refresh: refreshQuarantined, error: quarantinedError } = useFetch<{ sessions: QuarantinedRow[] }>(
  '/api/v1/me/quarantined-spend',
  { default: () => ({ sessions: [] }), lazy: true },
)

// The needs-tagging worklist: untagged OTel sessions + the §A per-day records
// the provider billed but OTel never captured, plus whatever the developer has
// dismissed (decided to leave unallocated — reversible). Rendered by
// HomeNeedsTaggingPanel; see docs/design/needs-tagging-worklist.md and
// client-attribution-auth-spec §4.
const { data: untagged, refresh: refreshUntagged, error: untaggedError } = useFetch<WorklistResponse>(
  '/api/v1/me/sessions/untagged',
  { default: () => ({ sessions: [], unaccounted: [], dismissed: { sessions: [], unaccounted: [] } }), lazy: true },
)
const unaccounted = computed(() => untagged.value?.unaccounted ?? [])
const dismissedItems = computed(
  () => untagged.value?.dismissed ?? { sessions: [], unaccounted: [] },
)

// §A — OPEN over-emission flags: days where the caller's OTel-reported usage materially
// EXCEEDS the provider API truth (uncorroborated; possibly a forged/mis-tagged emission).
// Rare — the section only renders when flags exist. Each flag carries the day's sessions
// (cost desc) so the dev can flag the outlier, accept, or escalate via
// /me/over-emission/{id}/resolve.
interface OverEmissionSession {
  conversation_id: string
  cost_usd: string
  tokens: number
  first_event: string
  last_event: string
}
interface OverEmissionFlag {
  id: string
  day: string
  tool: string
  otel_usd: string
  api_usd: string
  over_usd: string
  sessions: OverEmissionSession[]
}
const { data: overEmission, refresh: refreshOverEmission, error: overEmissionError } = useFetch<{ flags: OverEmissionFlag[] }>(
  '/api/v1/me/over-emission',
  { default: () => ({ flags: [] }), lazy: true },
)
const overEmissionFlags = computed(() => overEmission.value?.flags ?? [])
const { data: myProjects, refresh: refreshMyProjects, error: myProjectsError } = useFetch<{ projects: { id: string; code: string; display_name: string; type: string }[] }>(
  '/api/v1/me/projects',
  { default: () => ({ projects: [] }), lazy: true },
)
const { data: activityTypes, refresh: refreshActivityTypes, error: activityTypesError } = useFetch<{ activity_types: { label: string; is_standard: boolean; is_mine: boolean }[] }>(
  '/api/v1/me/activity-types',
  { default: () => ({ activity_types: [] }), lazy: true },
)
/*
 * The universal tag/re-tag editor target (null = closed). Set from a
 * needs-tagging "Tag" or an Activity "Re-tag"; TagSessionDialog owns the form
 * and the save call.
 *
 * IMPORTED, no longer re-declared. This page and `/usage` each held a
 * structurally-identical copy, and `tokens` widening to `number | null` (a
 * provider-day carries no token quantity) had to be made in three places or the
 * copies stopped matching. One exported type, one place the null rule lives.
 */
type TagTarget = DialogTagTarget
const tagSession = ref<TagTarget | null>(null)
// The session drill-down drawer target (null = closed). Set from a recent
// session's conversation-id / "Details" affordance; SessionDetailDrawer owns
// the fetch of the full SessionDetail breakdown.
const sessionDetailId = ref<string | null>(null)
// Which client's connect pop-up is open (null = closed). Opened by the
// "Connect Claude Desktop" / "Claude Code CLI" / "Copilot" buttons in the page head.
const connectGuide = ref<ConnectGuideKind | null>(null)
// Hide a client the admin has not enabled for this deployment (#415).
const { isEnabled: isClientEnabled } = useConnectConfig()
function openTag(t: TagTarget) {
  tagSession.value = t
}
function openSessionDetail(sessionId: string) {
  sessionDetailId.value = sessionId
}
// The provider-recorded-day drill-down target (null = closed). The day's
// counterpart of sessionDetailId; ProviderDayDetailDrawer owns the fetch.
const providerDayDetailId = ref<string | null>(null)
function openProviderDayDetail(u: WorklistDay) {
  providerDayDetailId.value = u.id
}
// The tag/activity drill-down target (null = closed). Opened from a tagged-spend
// row; the drawer's session rows hand back to the session drawer via openSessionDetail.
const activityDetailName = ref<string | null>(null)
function openActivityDetail(activity: string) {
  activityDetailName.value = activity
}
async function onTagSaved() {
  tagSession.value = null
  await Promise.all([refreshUntagged(), refreshUsage(), refreshActivityViews()])
}

// The worklist hands back whole items; the dialog wants a TagTarget.
function openTagSession(s: WorklistSession) {
  openTag({
    session_id: s.session_id,
    instance_id: s.instance_id,
    tool: s.tool,
    cost_usd: s.cost_usd,
    tokens: s.tokens,
    last_event: s.last_event,
    project_id: null,
    activity: s.activity,
    by_model: s.by_model,
  })
}

// Bulk tag: ONE save for the whole selection, via /me/worklist/bulk. The subject
// is the selection itself (count + total), so the per-session fields are inert.
function openTagBulk(sel: { sessions: string[]; unaccounted: string[]; count: number; cost_usd: number }) {
  tagSession.value = {
    session_id: '',
    instance_id: null,
    tool: 'claude-code',
    cost_usd: sel.cost_usd,
    tokens: 0,
    last_event: '',
    project_id: null,
    activity: null,
    subject_kind: 'bulk',
    bulk: { sessions: sel.sessions, unaccounted: sel.unaccounted },
  }
}

// A dismiss / restore landed: the queue AND the month split both moved.
async function onWorklistChanged() {
  await Promise.all([refreshUntagged(), refreshUsage()])
}

// §A — open the SAME tag dialog for a per-day unaccounted-usage record. Reuses the
// project/activity picker; only the POST target + subject display differ.
function openTagUnaccounted(u: WorklistDay) {
  tagSession.value = {
    session_id: u.id,
    instance_id: null,
    tool: u.tool,
    cost_usd: u.cost_usd,
    tokens: u.tokens,
    last_event: u.day,
    project_id: null,
    activity: null,
    assign_url: `/api/v1/me/unaccounted/${u.id}/assign`,
    subject_kind: 'day',
    subject_label: u.day,
  }
}

// §A — resolve an over-emission flag (quarantine the suspect session / accept / escalate).
// Quarantining changes the totals, so on success we refresh BOTH the over-emission list and
// the usage/untagged fetches. resolvingFlag guards against double-submits.
const resolvingFlag = ref<string | null>(null)
const overEmissionResolveError = ref<string | null>(null)
async function resolveOverEmission(
  id: string,
  action: 'quarantine' | 'accept' | 'escalate',
  conversationId?: string,
) {
  if (resolvingFlag.value) return
  resolvingFlag.value = id
  overEmissionResolveError.value = null
  try {
    await $fetch(`/api/v1/me/over-emission/${id}/resolve`, {
      method: 'POST',
      body: { action, ...(conversationId ? { conversation_id: conversationId } : {}) },
    })
    await Promise.all([refreshOverEmission(), refreshUsage(), refreshUntagged(), refreshActivityViews()])
  } catch (e: unknown) {
    overEmissionResolveError.value = apiErrorDetail(e, 'Could not resolve this flag')
  } finally {
    resolvingFlag.value = null
  }
}

const firstName = computed(() => {
  const dn = session.value?.displayName ?? ''
  return dn.split(/[\s]+/)[0] ?? 'there'
})

// The month comes from the SERVER's clock at fetch time (never a client
// `new Date()`), and is re-read on focus — see useRefreshOnVisible above.
const monthLabel = computed(() => {
  const m = usage.value?.headline?.month || usage.value?.month_to_date
  if (!m) return ''
  const [y, mm] = m.split('-')
  if (!y || !mm) return m
  const d = new Date(Number(y), Number(mm) - 1, 1)
  return d.toLocaleString(undefined, { month: 'long', year: 'numeric' })
})

// The month's LAST day, for the pace-over row's "on pace for ~$X by <date>"
// line. Same server clock as the band (headline.month + run_rate.days_in_month
// — never a client `new Date()` for "now"); same long-month formatting as
// monthLabel above.
const monthEndLabel = computed(() => {
  const m = usage.value?.headline?.month || usage.value?.month_to_date
  if (!m || !(daysInMonth.value > 0)) return ''
  const [y, mm] = m.split('-')
  if (!y || !mm) return ''
  const d = new Date(Number(y), Number(mm) - 1, daysInMonth.value)
  return d.toLocaleString(undefined, { month: 'long', day: 'numeric' })
})

/*
 * The hero's calendar. `headline.run_rate` is built server-side from the same
 * clock as the month, so the day the band prints is the day the projection
 * below it divides by.
 */
const headline = computed(() => usage.value?.headline ?? null)
const daysElapsed = computed(() => headline.value?.run_rate?.days_elapsed ?? 0)
const daysInMonth = computed(() => headline.value?.run_rate?.days_in_month ?? 0)

const sortedBuckets = computed<Array<Bucket & { pct: number; pace: BudgetPace; paceProjection: number | null }>>(() => {
  const buckets = usage.value?.buckets ?? []
  return [...buckets]
    .map((b) => {
      const alloc = Number(b.allocation_total_usd)
      const used = Number(b.cost_usd)
      const pct = alloc > 0 ? used / alloc : 0
      // The BAR still shows raw percent-of-budget; only the PILL beside it
      // changed basis, to where this project's month will land (see budgetPace).
      const pace = budgetPace(used, alloc, daysElapsed.value, daysInMonth.value)
      // The figure behind a pace-over pill, computed PER BUCKET from this
      // row's own spend (r1-M4) — never `monthEndProjection` below, which is
      // the portfolio total and would print every project's combined landing
      // under each individual pill.
      const paceProjection =
        pace === 'pace-over' ? projectedMonthEnd(used, daysElapsed.value, daysInMonth.value) : null
      return { ...b, pct, pace, paceProjection }
    })
    // Ended projects sink to the bottom (D5 collapse) — still shown (their
    // pre-end spend is real MTD), just out of the active group.
    .sort(
      (a, b) =>
        Number(a.ended) - Number(b.ended) ||
        b.pct - a.pct ||
        Number(b.cost_usd) - Number(a.cost_usd),
    )
})

const totals = computed(() => {
  const u = usage.value
  // Budgeted lane only. Unallocated is now SERVER-composed (usage.unallocated;
  // see getUnallocatedSummary) — not the client-side ledger sum.
  const projectSpend = Number(u?.total_cost_usd ?? 0)
  const allocations = Number(u?.total_allocation_usd ?? 0)
  const base = Number(u?.base_allowance_usd ?? 0)
  return { projectSpend, allocations, base }
})

/*
 * The hero's PRIMARY figure is the spend that has a budget behind it, because
 * the bar under it divides by the allocations and the sub-line reads "% of
 * allocated". Spend on projects that carry no allocation has no denominator in
 * that quotient, so it is named on its own line instead of silently inflating
 * the ratio.
 *
 *   budgetedSpend + noBudgetSpend = total_cost_usd (all project buckets)
 *   total_cost_usd + unallocated.total_cost_usd = monthTotal
 *
 * Both identities are pinned in tests/unit/pages/home-hero.test.ts.
 */
const budgetedBuckets = computed(() =>
  (usage.value?.buckets ?? []).filter((b) => Number(b.allocation_total_usd) > 0),
)
const budgetedSpend = computed(() =>
  budgetedBuckets.value.reduce((acc, b) => acc + Number(b.cost_usd), 0),
)
const noBudgetSpend = computed(() =>
  (usage.value?.buckets ?? [])
    .filter((b) => !(Number(b.allocation_total_usd) > 0))
    .reduce((acc, b) => acc + Number(b.cost_usd), 0),
)
const budgetedPct = computed(() =>
  totals.value.allocations > 0 ? budgetedSpend.value / totals.value.allocations : 0,
)

/**
 * A linear run-rate on the BUDGETED figure printed above it — not the payload's
 * `run_rate`, which projects the whole §A month (budgeted plus unallocated) and
 * would land a larger number under a bar drawn from a smaller one.
 *
 * Withheld before PACE_MIN_DAYS: two days of a month is not a pace, and
 * "≈$18,000 by month end" off one busy Tuesday is a forecast the data does not
 * support. The constant used to be IMPORTED, not restated — a local `= 3`
 * beside the pill's own `= 3` is two numbers that agree today, which is
 * exactly the drift the shared export exists to prevent. (I claimed they were
 * shared in the commit that exported it. They were not.) Since D8 the sharing
 * went one further: the floor AND the arithmetic live in `projectedMonthEnd`,
 * one function for this hero figure and the per-row pace-over line, so the
 * two cannot disagree about what a projection is.
 */
const monthEndProjection = computed<number | null>(() =>
  projectedMonthEnd(budgetedSpend.value, daysElapsed.value, daysInMonth.value),
)

// Unallocated/tagged totals are now SERVER-computed (accurate, month-scoped,
// uncapped) — usage.unallocated / usage.tagged_spend. The /me/sessions/untagged
// list is kept ONLY for the needs-tagging ACTION list (the assignable cards), so
// a >100-session or prior-month tail no longer skews the headline totals.
const needsTaggingSessions = computed(() => (untagged.value?.sessions ?? []).filter((s) => !s.activity))
const unallocatedTotal = computed(() => Number(usage.value?.unallocated?.total_cost_usd ?? 0))
const spillTotal = computed(() => Number(usage.value?.unallocated?.tagged_cost_usd ?? 0))
const needsTaggingTotal = computed(() => Number(usage.value?.unallocated?.untagged_cost_usd ?? 0))
const needsTaggingCount = computed(() => usage.value?.unallocated?.needs_tagging_count ?? 0)
// Third bucket of the unallocated split: decided-and-left (mig 0094). Inside
// unallocatedTotal, outside the needs-tagging queue.
const dismissedTotal = computed(() => Number(usage.value?.unallocated?.dismissed_cost_usd ?? 0))
// Fourth bucket: §A arm 3 (mig 0101) — provider-reported usage with no session
// and no unaccounted_usage row behind it. Inside unallocatedTotal, and outside
// the needs-tagging queue because there is nothing on it to tag.
const untaggableTotal = computed(() => Number(usage.value?.unallocated?.untaggable_cost_usd ?? 0))
// The worklist panel's authoritative month figures (server-computed, uncapped)
// — the lists it renders are all-time and capped, so the two are deliberately
// separate inputs and the panel reconciles them in its own copy.
const worklistSummary = computed(() => ({
  untagged_cost_usd: usage.value?.unallocated?.untagged_cost_usd ?? '0.00',
  needs_tagging_count: needsTaggingCount.value,
  needs_tagging_sessions: usage.value?.unallocated?.needs_tagging_sessions ?? 0,
  needs_tagging_days: usage.value?.unallocated?.needs_tagging_days ?? 0,
}))
// Tagged (off-budget) spend rolled up BY activity (server-computed). `tools` is
// the distinct set of contributing clients for the activity (claude-code /
// copilot-cli), driving the per-activity brand marks.
const spillByActivity = computed(() =>
  (usage.value?.tagged_spend ?? []).map((t) => ({
    activity: t.activity,
    total: Number(t.cost_usd),
    count: t.sessions,
    tools: t.tools?.length ? t.tools : ['claude-code'],
  })),
)

// fmtUsd / fmtTokens / fmtTimeAgo / clientMeta are auto-imported from
// ~/composables/useFormat (shared with TagSessionDialog).

/**
 * The month's whole attributed total — the figure the band header prints, and
 * the one number that appeared NOWHERE on this page before: project spend plus
 * everything outside a budget.
 */
const monthTotal = computed(() => totals.value.projectSpend + unallocatedTotal.value)

/*
 * The unallocated bar, in TWO segments.
 *
 * A single bar coloured by percent-of-cap painted the whole thing red and
 * labelled the card "Over" while every dollar in it was TAGGED — spend the
 * developer had already made a decision about. Tagged spend is an ANSWER, not a
 * gap (D5), so red is reserved for the untagged part and the two are drawn
 * side by side against the same denominator.
 *
 * The denominator is the larger of the total and the soft cap, so the bar
 * fills exactly at the cap and stays full past it; the tick then marks where
 * the cap sits inside an over-cap total. The two segments can be shorter than
 * the whole bar, because dismissed and no-session money is inside the total and
 * is neither tagged nor awaiting a decision — the sub-line names those parts.
 */
const softCap = computed(() => Number(usage.value?.unallocated?.soft_cap_usd ?? 0))
/*
 * `softCap > 0` was a guard against dividing by zero that quietly became a
 * verdict: with no allowance configured, ANY unallocated spend reported
 * "Within your allowance". Zero is not an allowance you are inside.
 */
/*
 * ONE computed, not three booleans read in template order. The previous shape
 * had `overSoftCap` true whenever spend exceeded a ZERO cap, so the
 * "no allowance configured" branch below it could never render and a missing
 * cap was reported as "Above the cap" — a worse answer than the one it
 * replaced. Ordering decided the verdict; now the verdict is computed once.
 */
type CapState = 'none' | 'no-allowance' | 'over' | 'within'
const capState = computed<CapState>(() => {
  if (!(unallocatedTotal.value > 0)) return 'none'
  if (!(softCap.value > 0)) return 'no-allowance'
  return unallocatedTotal.value > softCap.value ? 'over' : 'within'
})
const overSoftCap = computed(() => capState.value === 'over')
const unallocatedScale = computed(() => Math.max(unallocatedTotal.value, softCap.value))
const pctOfScale = (usd: number) =>
  unallocatedScale.value > 0 ? Math.min(100, (usd / unallocatedScale.value) * 100) : 0
const taggedWidthPct = computed(() => pctOfScale(spillTotal.value))
const untaggedWidthPct = computed(() => pctOfScale(needsTaggingTotal.value))
/** Where the soft cap falls inside an over-cap total. Only read when overSoftCap. */
const softCapTickPct = computed(() =>
  unallocatedTotal.value > 0 ? (softCap.value / unallocatedTotal.value) * 100 : 0,
)

// The table's own state (collapse, tool pill, CSV export) lives in ActivityCard
// — extracted at W2 D24.1, widened to both row kinds at §F4.

</script>

<template>
  <div class="max-w-[1440px] mx-auto px-10 py-8 pb-20">
    <UiPageHead
      :title="`Hello ${firstName}.`"
      :sub="`Here's your token spend for ${monthLabel}.`"
    >
      <template #actions>
        <div class="flex flex-col items-end gap-3">
          <!-- Connect tools — compact, brand-marked, top-right page action.
               Both Claude Code and Copilot CLI are live; each opens a small
               pop-up with the same per-client setup instructions shown on
               /account (shared ConnectClientGuide → no drift). -->
          <div class="flex flex-wrap items-center gap-2 justify-end" data-testid="home-connect-tools">
            <button
              v-if="isClientEnabled('claude-code')"
              type="button"
              class="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg border border-[#D97757]/40 bg-[#D97757]/5 hover:bg-[#D97757]/12 transition-colors text-sm font-semibold text-carbon cursor-pointer"
              data-testid="connect-desktop"
              @click="connectGuide = 'claude-desktop'"
            >
              <Icon name="logos:claude-icon" class="text-base" aria-hidden="true" />
              Connect Claude Desktop
            </button>
            <button
              v-if="isClientEnabled('claude-code')"
              type="button"
              class="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg border border-[#D97757]/40 bg-[#D97757]/5 hover:bg-[#D97757]/12 transition-colors text-sm font-semibold text-carbon cursor-pointer"
              data-testid="connect-claude"
              @click="connectGuide = 'claude-cli'"
            >
              <Icon name="logos:claude-icon" class="text-base" aria-hidden="true" />
              Connect Claude Code CLI
            </button>
            <button
              v-if="isClientEnabled('copilot-cli')"
              type="button"
              class="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg border border-carbon/15 bg-carbon/5 hover:bg-carbon/10 transition-colors text-sm font-semibold text-carbon cursor-pointer"
              data-testid="connect-copilot"
              @click="connectGuide = 'copilot-cli'"
            >
              <Icon name="logos:github-copilot" class="text-base" aria-hidden="true" />
              Connect Copilot
            </button>
          </div>
        </div>
      </template>
    </UiPageHead>

    <!-- FE-2: fetch failures surface as retry banners — never a silent $0.00. -->
    <UiFetchErrorBanner :error="usageError" label="your usage summary" @retry="refreshUsage" />
    <UiFetchErrorBanner :error="untaggedError" label="your untagged sessions" @retry="refreshUntagged" />
    <UiFetchErrorBanner :error="overEmissionError" label="uncorroborated-usage flags" @retry="refreshOverEmission" />
    <UiFetchErrorBanner :error="quarantinedError" label="unverified-spend flags" @retry="refreshQuarantined" />
    <UiFetchErrorBanner :error="myProjectsError" label="your assignable projects" @retry="refreshMyProjects" />
    <UiFetchErrorBanner :error="activityTypesError" label="the activity-tag vocabulary" @retry="refreshActivityTypes" />

    <!-- Zero-usage onboarding CTA — a brand-new dev who has never emitted gets a
         prominent "connect a tool to start" card, not just the small header button. -->
    <UiCard v-if="isEmptyAccount" accent="harmony" class="mb-6 brand-wash" data-testid="onboarding-cta">
      <div class="flex flex-col md:flex-row md:items-center gap-5">
        <div class="flex-1">
          <div class="text-[11px] font-bold uppercase tracking-[1.4px] text-brand-harmony">Get started</div>
          <!-- Two headlines, one card. See `seenViaProviderOnly` above for why the
               middle state exists at all; the point of naming it is that this
               person already knows they use AI, so "no usage yet" reads as the
               product being broken rather than as an invitation. -->
          <h2
            v-if="seenViaProviderOnly"
            class="text-xl font-bold text-carbon mt-1"
            data-testid="onboarding-headline-provider-only"
          >
            We can see your spend from your provider — but nothing is being emitted from your machine yet.
          </h2>
          <h2 v-else class="text-xl font-bold text-carbon mt-1" data-testid="onboarding-headline-new">
            No usage yet — connect a tool to start tracking.
          </h2>
          <p v-if="seenViaProviderOnly" class="text-sm text-carbon-2 mt-1.5">
            Your provider reports {{ fmtUsd(usage?.total_cost_usd ?? 0) }} this period, so your spend is already
            counted. What is missing is the session detail — which project, which model, which conversation —
            and that only arrives once you connect a client on this machine. Full step-by-step guides live on
            your <NuxtLink to="/account" class="text-brand-harmony font-semibold hover:underline">account page</NuxtLink>.
          </p>
          <p v-else class="text-sm text-carbon-2 mt-1.5">
            Connect Claude Code or GitHub Copilot CLI once per machine and your token spend lands here automatically —
            usually within a few minutes of your next session. Full step-by-step guides live on your
            <NuxtLink to="/account" class="text-brand-harmony font-semibold hover:underline">account page</NuxtLink>.
          </p>
        </div>
        <div class="flex flex-wrap items-center gap-2 shrink-0">
          <button
            v-if="isClientEnabled('claude-code')"
            type="button"
            class="inline-flex items-center gap-2 px-3.5 py-2 rounded-lg border border-[#D97757]/40 bg-[#D97757]/5 hover:bg-[#D97757]/12 transition-colors text-sm font-semibold text-carbon cursor-pointer"
            data-testid="onboarding-connect-desktop"
            @click="connectGuide = 'claude-desktop'"
          >
            <Icon name="logos:claude-icon" class="text-base" aria-hidden="true" />
            Connect Claude Desktop
          </button>
          <button
            v-if="isClientEnabled('claude-code')"
            type="button"
            class="inline-flex items-center gap-2 px-3.5 py-2 rounded-lg border border-[#D97757]/40 bg-[#D97757]/5 hover:bg-[#D97757]/12 transition-colors text-sm font-semibold text-carbon cursor-pointer"
            data-testid="onboarding-connect-claude"
            @click="connectGuide = 'claude-cli'"
          >
            <Icon name="logos:claude-icon" class="text-base" aria-hidden="true" />
            Connect Claude Code CLI
          </button>
          <button
            v-if="isClientEnabled('copilot-cli')"
            type="button"
            class="inline-flex items-center gap-2 px-3.5 py-2 rounded-lg border border-carbon/15 bg-carbon/5 hover:bg-carbon/10 transition-colors text-sm font-semibold text-carbon cursor-pointer"
            data-testid="onboarding-connect-copilot"
            @click="connectGuide = 'copilot-cli'"
          >
            <Icon name="logos:github-copilot" class="text-base" aria-hidden="true" />
            Connect Copilot
          </button>
        </div>
      </div>
    </UiCard>

    <!-- §A6.2 degradation banner — above the hero, so the trust caveat frames
         every figure below it. Renders nothing while the signal is null. -->
    <UiAttributionStallBanner :stall="usage?.attribution_stall" class="mb-4" />

    <!-- Band header: the month, its TOTAL, and where in the month we are. The
         month total appeared nowhere on this page before — the two hero cards
         below split it (project spend, then everything outside a budget) and
         neither of them is it. -->
    <div
      class="flex items-baseline flex-wrap gap-x-3 gap-y-1.5 pb-2 mb-4 border-b-2 border-brand-harmony/15"
      data-testid="month-band"
    >
      <span class="text-[18px] font-extrabold tracking-[-0.01em] text-carbon">{{ monthLabel || 'This month' }}</span>
      <span
        class="text-[22px] font-extrabold tracking-[-0.02em] text-carbon pl-3 border-l border-calm"
        style="font-variant-numeric: tabular-nums"
        data-testid="month-band-total"
      >{{ fmtUsd(monthTotal) }}</span>
      <span class="text-[12.5px] text-carbon-2" data-testid="month-band-basis">
        attributed usage · month to date · day {{ daysElapsed }} of {{ daysInMonth }}
      </span>
    </div>

    <!-- Hero summary. NO lens control: every construct in this card (budgets,
         allocations, the soft cap) measures attributed usage, so there is no
         second lane for it to be drawn in. NO status pill either — the
         projection under the bar IS the health signal, and a pill beside it
         would be a third way of saying one thing. -->
    <UiCard accent="harmony" class="mb-4 brand-wash" data-testid="hero-summary">
      <div data-testid="hero-figures">
        <!-- §A. Two measurement lines: budgeted (allocated, primary) and
             unallocated (tagged + untagged, secondary). They are NOT one pooled
             bar — different denominators, different meaning. -->
        <div class="grid md:grid-cols-2 gap-6">
          <!-- PRIMARY: budgeted / allocated -->
          <div class="md:border-r md:border-brand-harmony/10 md:pr-6">
            <!--
              With NO allocation anywhere, `budgetedSpend` is arithmetically
              forced to $0.00 — the eyebrow already said "0 budgets", so the
              40px figure below restated it and carried no information, while
              the month's real money sat in 11px underneath. In that state the
              card's subject is project spend, so it says so and shows it.
            -->
            <div class="text-[11px] font-bold uppercase tracking-wide text-carbon-3">{{ totals.allocations > 0 ? 'Budgeted' : 'On projects' }} · {{ budgetedBuckets.length }} {{ budgetedBuckets.length === 1 ? 'budget' : 'budgets' }}</div>
            <div
              class="text-[40px] font-bold tracking-[-1.5px] text-carbon mt-1 leading-[1]"
              style="font-variant-numeric: tabular-nums"
              data-testid="hero-primary-figure"
              data-mtd-scalar="usage"
            >
              {{ fmtUsd(totals.allocations > 0 ? budgetedSpend : noBudgetSpend) }}
              <span v-if="totals.allocations > 0" class="text-xl text-carbon-3 font-medium">/ {{ fmtUsd(totals.allocations) }}</span>
              <span v-else class="text-base text-carbon-3 font-medium align-middle"> · no budget allocated</span>
            </div>
            <UiPbar v-if="totals.allocations > 0" :pct="budgetedPct" size="lg" class="mt-3" />
            <div v-else class="h-2 mt-3 rounded-full bg-calm/40" title="No allocation on these projects yet" />
            <!-- The AGGREGATE TOKEN COUNT used to sit here. It is gone: a Fable
                 5 token and an Opus 5 token differ by orders of magnitude in
                 price, so one summed number measures nothing and invites a
                 per-token mental model that is wrong. -->
            <div class="text-[11px] text-carbon-3 mt-1.5" style="font-variant-numeric: tabular-nums" data-testid="hero-budgeted-share">
              <template v-if="totals.allocations > 0">{{ Math.round(budgetedPct * 100) }}% of allocated · </template>day {{ daysElapsed }} of {{ daysInMonth }}
            </div>
            <!-- The projection IS the health signal on this card. Withheld
                 before day 3, where a "pace" is one or two days of spend. -->
            <div class="text-[11px] text-carbon-3 mt-1" style="font-variant-numeric: tabular-nums" data-testid="hero-projection">
              <template v-if="monthEndProjection !== null">≈{{ fmtUsd(monthEndProjection) }} by month end</template>
              <template v-else>too early to project</template>
            </div>
            <!-- Spend on projects that carry no allocation. Outside the figure
                 above because it has no denominator in the bar's quotient — but
                 inside the month total in the band, so it is named here rather
                 than dropped. -->
            <!--
              Only when a budget EXISTS to be "plus" to. With none, this figure
              IS the one above and repeating it as an afterthought is what made
              the card unreadable.
            -->
            <div
              v-if="noBudgetSpend > 0 && totals.allocations > 0"
              class="text-[11px] text-carbon-3 mt-1"
              style="font-variant-numeric: tabular-nums"
              data-testid="hero-no-budget-spend"
            >
              plus {{ fmtUsd(noBudgetSpend) }} on projects with no budget set
            </div>
          </div>

          <!-- SECONDARY: unallocated (spill + untagged) -->
          <div>
            <div class="text-[11px] font-bold uppercase tracking-wide text-carbon-3">Unallocated · soft cap {{ fmtUsd(totals.base) }}</div>
            <div class="text-[40px] font-bold tracking-[-1.5px] text-carbon mt-1 leading-[1]" style="font-variant-numeric: tabular-nums">
              {{ fmtUsd(unallocatedTotal) }}
            </div>
            <!-- TWO segments, never one solid colour: tagged spend is a
                 decision the developer has already made, so it is drawn in the
                 brand colour and only the UNTAGGED part is amber. A single bar
                 coloured by percent-of-cap painted the whole thing red and
                 labelled the card "Over" while every dollar in it was tagged.
                 Tagged spend is an ANSWER, not a gap (D5). -->
            <div
              class="relative flex h-2.5 mt-3 rounded-full bg-calm-2 overflow-hidden"
              role="img"
              :aria-label="`Unallocated ${fmtUsd(unallocatedTotal)}: tagged ${fmtUsd(spillTotal)}, untagged ${fmtUsd(needsTaggingTotal)}, against a soft cap of ${fmtUsd(totals.base)}`"
              data-testid="unallocated-bar"
            >
              <div class="h-full bg-brand-harmony" :style="{ width: taggedWidthPct + '%' }" data-testid="unallocated-bar-tagged" />
              <div class="h-full bg-rag-amber" :style="{ width: untaggedWidthPct + '%' }" data-testid="unallocated-bar-untagged" />
              <span
                v-if="overSoftCap"
                class="absolute inset-y-0 w-0.5 rounded-sm bg-carbon/60"
                :style="{ left: softCapTickPct + '%' }"
                aria-hidden="true"
                data-testid="unallocated-soft-cap-tick"
              />
            </div>
            <div class="text-[12px] text-carbon-2 mt-1.5 flex flex-wrap gap-x-3" style="font-variant-numeric: tabular-nums">
              <span>tagged {{ fmtUsd(spillTotal) }}</span>
              <span>untagged {{ fmtUsd(needsTaggingTotal) }}</span>
              <!-- The third bucket: decided, left unallocated. Still inside the
                   total above — dismissing never moves money. -->
              <span v-if="dismissedTotal > 0" class="text-carbon-3" data-testid="hero-dismissed">dismissed {{ fmtUsd(dismissedTotal) }}</span>
              <!-- The fourth bucket: §A arm 3. Inside the total above, and outside
                   the needs-tagging count beside it. Named here so the four parts
                   foot to the total.

                   LABELLED BY WHAT IT IS, not by what the system cannot do to it.
                   "Not taggable" described a property of a database row: it told
                   a reader their money had been categorised by an implementation
                   detail they have no name for. "No session" is the same fact in
                   the product's own vocabulary — sessions are a first-class thing
                   a developer already tags — and it answers the question the chip
                   actually raises, which is why this money is not in the list
                   below. It does NOT mean the spend is exempt from anything. -->
              <span
                v-if="untaggableTotal > 0"
                class="text-carbon-3"
                data-testid="hero-untaggable"
                title="Usage the providers reported with no session behind it — Claude Chat, the Copilot coding agent, and the other non-Code surfaces. It counts toward your unallocated total and your soft cap like every other dollar; there is just no session on it to tag, so it is not in the tagging list below."
              >no session {{ fmtUsd(untaggableTotal) }}</span>
            </div>
            <div class="text-[11px] text-carbon-3 mt-1" style="font-variant-numeric: tabular-nums" data-testid="hero-unallocated-state">
              <template v-if="capState === 'over'">Above the cap · {{ fmtUsd(needsTaggingTotal) }} undecided</template>
              <template v-else-if="capState === 'no-allowance'">No allowance configured</template>
              <template v-else-if="capState === 'within'">Within your allowance</template>
              <template v-else>Nothing outside a budget this month</template>
            </div>
          </div>
        </div>
      </div>

      <!-- §A6.1: the REAL minutes or nothing — a `?? 0` here is the fabricated
           green the design kills; null renders the neutral unknown state. -->
      <UiFreshness :minutes="usage?.freshness_minutes_ago" class="mt-4" />
    </UiCard>

    <!-- What does and does not reach the cost centre: ONE line, with an (i)
         that itemises the reasons (ADR 0012 decision 5). -->
    <MeLensDisclosure
      variant="line"
      :disclosure="usage?.disclosure"
      class="mb-6"
    />

    <!-- Rolling-window spend velocity (7/30/90d) — the honest home for the
         time-bound controls; the hero above stays month-to-date (budget). -->
    <HomeRecentSpendStrip />

    <!-- Two columns: budgeted project spend (left) vs spill — tagged but not on a
         budget (right). Uses the page width and reads as the allocated/unallocated
         contrast the model is built on. -->
    <div class="grid lg:grid-cols-3 gap-5 mb-6">
      <!-- LEFT: budgeted project spend — the primary focus, gets 2/3 width. -->
      <UiCard flush class="lg:col-span-2">
        <div class="px-6 pt-6 pb-4 border-b border-calm-2 flex items-end justify-between gap-4">
          <div>
            <div class="text-lg font-bold text-carbon">Your budgeted spend</div>
            <div class="text-xs text-carbon-3 mt-1">
              Attributed usage against allocated budgets, highest % first.
            </div>
          </div>
          <NuxtLink to="/inbox" class="text-xs text-brand-harmony font-bold hover:underline shrink-0">
            Alerts →
          </NuxtLink>
        </div>
        <UiEmptyState
          v-if="sortedBuckets.length === 0"
          headline="No project assignments yet"
          sub="Ask your admin to assign you to a project; it'll show here."
        />
        <ul v-else class="divide-y divide-calm-2" data-testid="project-bucket-list">
          <li
            v-for="bucket in sortedBuckets"
            :key="bucket.project_code"
            class="px-6 py-4"
            :data-active="bucket.is_active_now ? 'true' : 'false'"
            :data-ended="bucket.ended ? 'true' : 'false'"
            :class="bucket.ended ? 'opacity-70' : ''"
            :data-testid="`usage-bucket-${bucket.project_code}`"
          >
            <div class="flex items-start justify-between gap-3">
              <div class="min-w-0">
                <div class="flex items-center gap-2 flex-wrap">
                  <span class="text-sm font-bold text-carbon truncate">{{ bucket.display_name }}</span>
                  <span
                    v-if="bucket.ended"
                    class="inline-flex items-center px-2 py-0.5 rounded-md text-[10px] font-bold bg-calm-2 text-carbon-2"
                    title="This project has ended. Its pre-end spend is still counted; new spend spills to unallocated until re-tagged."
                    data-testid="ended-badge"
                  >
                    Ended
                  </span>
                  <!-- Contributing client(s) — one small brand mark per distinct
                       client that contributed this month (Claude Code / Copilot CLI),
                       from bucket.tools. Empty (assigned, no spend yet) → no mark. -->
                  <span
                    v-if="bucket.tools.length"
                    class="inline-flex items-center gap-1 shrink-0"
                    :aria-label="bucket.tools.map((t) => clientMeta(t).name).join(', ') + ' contributed'"
                    data-testid="bucket-clients"
                  >
                    <Icon
                      v-for="t in bucket.tools"
                      :key="t"
                      :name="clientMeta(t).icon"
                      class="text-sm"
                      :title="clientMeta(t).name"
                    />
                  </span>
                  <span
                    v-if="bucket.is_active_now"
                    class="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md text-[10px] font-bold bg-brand-zeal-lite text-brand-zeal-ink"
                    data-testid="active-now-badge"
                  >
                    <span class="inline-block w-1.5 h-1.5 rounded-full bg-brand-zeal animate-pulse" aria-hidden="true" />
                    Active
                  </span>
                  <span
                    v-if="bucket.source === 'contributed'"
                    class="inline-flex items-center px-2 py-0.5 rounded-md text-[10px] font-bold bg-brand-hunger-lite text-brand-heart"
                    title="You contributed spend to this project this month but aren't formally assigned to it."
                    data-testid="contributed-badge"
                  >
                    Contributed
                  </span>
                </div>
                <div class="text-[11px] text-carbon-3 font-mono mt-0.5">{{ bucket.project_code }}</div>
              </div>
              <div class="text-right shrink-0" style="font-variant-numeric: tabular-nums">
                <div class="text-sm font-bold text-carbon">{{ fmtUsd(bucket.cost_usd) }}</div>
                <div class="text-[11px] text-carbon-3">{{ Number(bucket.allocation_total_usd) > 0 ? '/ ' + fmtUsd(bucket.allocation_total_usd) : 'no budget' }}</div>
              </div>
            </div>
            <!-- The pill's BASIS changed first: where this project's month
                 will LAND against the allocation, not the raw percent spent so
                 far (see budgetPace) — raw percent called 90% on day 28 and
                 90% on day 5 the same thing, and gave a project at $0.00 of
                 $500 a green "Healthy". D8 then split its WORD: "Over" (red)
                 is only the fact of spend already past the allocation; the
                 forecast reads "On pace to exceed" (amber), with the figure
                 that justifies it on the line below. -->
            <div class="flex items-center gap-2 mt-2">
              <template v-if="bucket.pace !== 'no-budget'">
                <UiPbar :pct="bucket.pct" size="lg" class="flex-1" />
                <UiBadge :kind="budgetPaceKind(bucket.pace)" :data-testid="`pace-${bucket.project_code}`">
                  {{ budgetPaceLabel(bucket.pace) }}
                </UiBadge>
              </template>
              <span v-else class="flex-1 text-right text-[11px] text-carbon-3">no budget set</span>
            </div>
            <!-- The forecast pill carries its number: THIS row's own month-end
                 landing (r1-M4) — per-bucket spend on the shared elapsed
                 fraction, never the hero's monthEndProjection, which is the
                 portfolio total. -->
            <div
              v-if="bucket.pace === 'pace-over' && bucket.paceProjection !== null"
              class="text-right text-[11px] text-carbon-3 mt-1"
              style="font-variant-numeric: tabular-nums"
              :data-testid="`pace-projection-${bucket.project_code}`"
            >on pace for ~{{ fmtUsd(bucket.paceProjection) }} by {{ monthEndLabel || 'month end' }}</div>
          </li>
        </ul>
      </UiCard>

      <!-- RIGHT: tagged-but-unbudgeted spend (the canonical "spill" lane in
           finance terms — rolls to the practice Spill Bucket — but labelled plainly
           for the developer). Still re-assignable to a project. -->
      <UiCard flush data-testid="spill-card">
        <div class="px-6 pt-6 pb-4 border-b border-calm-2 flex items-end justify-between gap-4">
          <div>
            <div class="text-lg font-bold text-carbon">Tagged spend</div>
            <div class="text-xs text-carbon-3 mt-1">
              Attributed usage categorised with an activity, not on a budget.
            </div>
          </div>
          <span class="text-lg font-bold text-carbon shrink-0" style="font-variant-numeric: tabular-nums">{{ fmtUsd(spillTotal) }}</span>
        </div>
        <ul v-if="spillByActivity.length" class="divide-y divide-calm-2">
          <li v-for="row in spillByActivity" :key="row.activity">
            <button
              type="button"
              class="w-full px-6 py-3.5 flex items-center justify-between gap-3 text-left hover:bg-brand-harmony-sheer/40 transition-colors"
              :data-testid="`tagged-${row.activity}`"
              :title="`See how ${row.activity} broke down — models, lanes, sessions`"
              @click="openActivityDetail(row.activity)"
            >
              <div class="min-w-0">
                <div class="text-sm font-semibold text-carbon capitalize truncate">{{ row.activity }}</div>
                <div class="flex items-center gap-1.5 mt-1">
                  <Icon
                    v-for="t in row.tools"
                    :key="t"
                    :name="clientMeta(t).icon"
                    class="text-sm"
                    :title="clientMeta(t).name"
                  />
                  <span class="text-[11px] text-carbon-3">{{ row.count }} {{ row.count === 1 ? 'session' : 'sessions' }}</span>
                </div>
              </div>
              <span class="text-sm font-bold text-carbon shrink-0" style="font-variant-numeric: tabular-nums">{{ fmtUsd(row.total) }}</span>
            </button>
          </li>
        </ul>
        <div v-else class="px-6 py-10 text-center text-xs text-carbon-2">
          Nothing tagged off-budget — your categorised spend is all on a budget.
        </div>
      </UiCard>
    </div>


    <!-- NEEDS TAGGING: the decision queue — untagged sessions + the §A
         provider-recorded days, with dismiss + bulk actions. Tagged-but-unbudgeted
         spend lives in the calm Spill card above. -->
    <HomeNeedsTaggingPanel
      :sessions="needsTaggingSessions"
      :unaccounted="unaccounted"
      :dismissed="dismissedItems"
      :summary="worklistSummary"
      :load-failed="!!untaggedError"
      @tag-session="openTagSession"
      @tag-day="openTagUnaccounted"
      @day-detail="openProviderDayDetail"
      @tag-bulk="openTagBulk"
      @changed="onWorklistChanged"
    />

    <!-- §A — NEEDS REVIEW: uncorroborated (over-emission) usage. Days where the caller's
         OTel-reported usage EXCEEDS the provider API truth — possibly a forged/mis-tagged
         emission. Rare: only rendered when there are open flags. The API has no session ids,
         so the system never auto-picks the outlier — the dev reviews the day's sessions and
         flags the wrong one, accepts the lot, or escalates. /me/over-emission/{id}/resolve. -->
    <UiCard v-if="overEmissionFlags.length" accent="harmony" data-testid="over-emission-section" class="mb-4">
      <UiEyebrow>Needs review · uncorroborated usage</UiEyebrow>
      <p class="text-xs text-carbon-2 mt-2">
        On these days your tools reported more than the provider's bill confirms. Review the sessions and either flag the one that's wrong, mark it correct, or escalate.
      </p>
      <p v-if="overEmissionResolveError" class="text-xs text-rag-red mt-2" role="alert" data-testid="over-emission-error">
        {{ overEmissionResolveError }}
      </p>

      <div class="mt-3 space-y-3">
        <div
          v-for="f in overEmissionFlags"
          :key="f.id"
          class="rounded-lg border border-rag-amber/30 bg-rag-amber/5 px-4 py-3"
          :data-testid="`over-emission-flag-${f.id}`"
        >
          <div class="flex items-start justify-between gap-3 flex-wrap">
            <div class="text-sm text-carbon">
              <Icon :name="clientMeta(f.tool).icon" class="text-base align-middle mr-1" :title="clientMeta(f.tool).name" />
              <span class="font-bold">{{ f.day }}</span>:
              your tools reported <span class="font-semibold">{{ fmtUsd(f.otel_usd) }}</span>,
              the provider bill is <span class="font-semibold">{{ fmtUsd(f.api_usd) }}</span> —
              <span class="font-bold text-rag-amber">{{ fmtUsd(f.over_usd) }}</span> is uncorroborated.
            </div>
            <div class="flex items-center gap-2 shrink-0">
              <UiButton
                kind="ghost"
                size="sm"
                :disabled="resolvingFlag === f.id"
                :data-testid="`over-emission-accept-${f.id}`"
                @click="resolveOverEmission(f.id, 'accept')"
              >
                It's all correct
              </UiButton>
              <UiButton
                kind="ghost"
                size="sm"
                :disabled="resolvingFlag === f.id"
                :data-testid="`over-emission-escalate-${f.id}`"
                @click="resolveOverEmission(f.id, 'escalate')"
              >
                Escalate
              </UiButton>
            </div>
          </div>

          <ul v-if="f.sessions.length" class="mt-3 divide-y divide-rag-amber/15 rounded-md border border-rag-amber/15 bg-white/60">
            <li
              v-for="s in f.sessions"
              :key="s.conversation_id"
              class="flex items-center gap-3 px-3 py-2.5"
            >
              <div class="min-w-0 flex-1">
                <div class="text-xs text-carbon truncate">
                  <span class="font-mono text-carbon-2">{{ s.conversation_id.slice(0, 13) }}</span>
                  <span class="text-carbon-3"> · {{ fmtTokens(s.tokens) }} tokens</span>
                </div>
                <div class="text-[11px] text-carbon-3 mt-0.5">
                  {{ fmtTimeAgo(s.first_event) }} → {{ fmtTimeAgo(s.last_event) }}
                </div>
              </div>
              <span class="text-sm font-bold text-carbon shrink-0" style="font-variant-numeric: tabular-nums">{{ fmtUsd(s.cost_usd) }}</span>
              <UiButton
                kind="ghost"
                size="sm"
                :disabled="resolvingFlag === f.id"
                :data-testid="`over-emission-quarantine-${s.conversation_id}`"
                @click="resolveOverEmission(f.id, 'quarantine', s.conversation_id)"
              >
                Flag as wrong
              </UiButton>
            </li>
          </ul>
          <p v-else class="text-[11px] text-carbon-3 mt-2">
            No sessions on record for this day — accept or escalate to resolve.
          </p>
        </div>
      </div>
    </UiCard>

    <!-- Activity (§F4) — ONE list holding sessions AND provider-recorded days,
         dual-mounted here and on /usage. Each row kind opens the drawer that
         already exists for it; neither drawer is rebuilt here. -->
    <ActivityCard
      ref="activityCard"
      :quarantined="quarantined?.sessions ?? []"
      @open-session="openSessionDetail"
      @open-provider-day="providerDayDetailId = $event"
      @retag="openTag"
    />

    <!-- §B (#142) — OTHER CLAUDE SURFACES: read-only chargeback lanes (Chat /
         Cowork / Office / …) from the provider bill. Deliberately BELOW and
         separate from the taggable sessions/worklist area: these surfaces have
         no sessions and are never taggable — informational only, no actions. -->
    <HomeOtherSurfacesPanel
      v-if="usage?.surfaces?.length"
      :surfaces="usage.surfaces"
      :month-to-date="usage.month_to_date"
    />

    <!-- Universal tag / re-tag editor (extracted; focus-trapped, Escape, aria). -->
    <HomeTagSessionDialog
      :target="tagSession"
      :projects="myProjects?.projects ?? []"
      :activity-types="activityTypes?.activity_types ?? []"
      @close="tagSession = null"
      @saved="onTagSaved"
    />

    <!-- Session drill-down — full attribution breakdown for one conversation. -->
    <SessionDetailDrawer :session-id="sessionDetailId" @close="sessionDetailId = null" />

    <!-- Provider-recorded-day drill-down — the same breakdown for the unit that
         has no session, read from the provider's own rows. -->
    <ProviderDayDetailDrawer
      :record-id="providerDayDetailId"
      @close="providerDayDetailId = null"
    />

    <!-- Activity/tag drill-down — its session rows hand off to the session drawer. -->
    <ActivityDetailDrawer
      :activity="activityDetailName"
      @close="activityDetailName = null"
      @open-session="openSessionDetail"
    />

    <!-- Connect-a-client pop-up — same ConnectClientGuide as /account. -->
    <ConnectClientDialog :kind="connectGuide" @close="connectGuide = null" />
  </div>
</template>

<style scoped>
.brand-wash {
  background:
    radial-gradient(ellipse 60% 80% at 100% 0%, rgba(212, 14, 140, 0.08), transparent 60%),
    radial-gradient(ellipse 70% 90% at 0% 100%, rgba(89, 144, 240, 0.06), transparent 60%),
    var(--white);
}
</style>
