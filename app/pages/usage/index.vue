<script setup lang="ts">
/*
 * My usage — the self-depth surface, rebuilt to the prototype
 * (developer-pages-consolidation/01-build-design.md W2; prototype
 * #p=usage&v=self). Section order (prototype :416-606): lane toggle + window
 * presets → chip row → month band + four tiles → Daily spend (AS BUILT, D18)
 * → context residency + session economics → Top models + insights → Where it
 * went → engagement pair → needs tagging (worklist, kept) → Activity.
 *
 * §F4: the tail is ACTIVITY, not "recent sessions" — one list holding OTel
 * sessions AND provider-recorded days. The worklist above it stays: it is the
 * task list (what awaits a decision), Activity is the record (what happened).
 * Making the worklist double as the only inventory of provider-days is what
 * made a tagged day disappear.
 *
 * TWO CARDS ARE GONE (owner ruling 2026-08-05), and nothing they carried is:
 *   - "What is and is not chargeable" (MeLensDisclosure's card variant) — its
 *     three scalars are the lane toggle + the hero tiles (the lead tile is
 *     Chargeable in the billed lane, Attributed usage beside it) + the
 *     settlement/coverage chip row; its paragraph is the (i) ON the toggle.
 *   - "What kind of AI work drove this" (ConsumptionHeroCard, §I3) — "what
 *     drove this" is answered by Daily spend, the Claude/Copilot engagement
 *     pair, Top models with its coverage footer, and Where it went. Its `hero`
 *     endpoint leg went with it.
 *
 * The developer is the CUSTOMER of this page, not its subject: no peer
 * comparisons, no manager visibility of insights (principle note :570).
 * Explanatory prose lives behind (i) — InfoDot carries it; card bodies carry
 * data (D12). The worklist contract (#231/#235) is MOUNTED here, not changed:
 * the panel/drawer/dialog components and their endpoints are byte-identical
 * to Home's (D24 — dual-mount is deliberate this sprint).
 */
import { computed, ref } from 'vue'
import type { TagTarget as DialogTagTarget } from '../../components/home/TagSessionDialog.vue'
import { provideReportStateKeys, WINDOW_STATE_KEYS } from '../../composables/useReportState'
import { modelDisplay } from '../../composables/useModelDisplay'
import { projectedMonthEnd } from '../../composables/useRagState'
import ReportSkeleton from '../../components/reporting/ReportSkeleton.vue'
import ModelSplitPanel from '../../components/reporting/ModelSplitPanel.vue'
import BudgetStateCell from '../../components/reporting/BudgetStateCell.vue'
import DateRangeControl from '../../components/reporting/DateRangeControl.vue'
import CcHeaderNotes from '../../components/reporting/cost-centre/CcHeaderNotes.vue'
import InfoDot from '../../components/ui/InfoDot.vue'
import MeHeroTiles from '../../components/me/MeHeroTiles.vue'
import ActivityCard from '../../components/me/ActivityCard.vue'
import type { MeHeroTileWire, MeHeroWindowWire } from '../../components/me/MeHeroTiles.vue'
import type { LensDisclosureData } from '../../components/me/LensDisclosure.vue'
import type { WorklistDay, WorklistResponse, WorklistSession } from '#shared/schemas/worklist'
import { PERSONAL_LENS_COPY, type SpendLens } from '#shared/usage/lens'
import type { DriverRow, ProviderState, ReportCoverageMeta } from '#shared/reports/types'
import type {
  DaySpend,
  Finding,
  ModelDaySpend,
  ModelSpend,
  RunRate,
  TokenTypeSpend,
} from '#shared/schemas/usage'

/**
 * Where this month's spend stands against the quota, as a STATE. Mirrors
 * server/usage/projections.ts `QuotaProjection` — see that module for why it
 * is a union and not a nullable date.
 */
type QuotaProjection =
  | { state: 'no-quota' }
  | { state: 'no-spend' }
  | { state: 'exhausted'; over_usd: string }
  | { state: 'projected'; date: string }
  | { state: 'not-at-this-pace' }

/**
 * The page's ONE headline figure and everything derived from it (ADR 0012
 * decision 4): `run_rate` and `quota.projection` are built server-side under
 * the same lens as `mtd_usd`, so the quota tile's operands can never come
 * from a different lane than the scalar beside them.
 */
interface Headline {
  lane: SpendLens
  month: string
  mtd_usd: string
  run_rate: RunRate
  /** §A only — null under the chargeback lens; a quota measures attributed usage. */
  quota: {
    total_usd: string
    base_allowance_usd: string
    allocation_usd: string
    projection: QuotaProjection
  } | null
}

/** D5/D19 — the banded residency read (server module shape, as-is). */
interface ContextResidencyLeg {
  window: { from: string; to: string }
  segments: { band: string; costUsd: number }[]
  remainder: { costUsd: number; reason: string; label: string } | null
  totalUsd: number
}

/** D10/D19 — the OTel-arm session distribution (server module shape, as-is). */
interface SessionEconomicsLeg {
  sessions: number
  medianUsd: number | null
  p90Usd: number | null
  topShare: { n: number; pct: number | null }
  arm: 'otel'
}

/** D20 — reason-typed model rows + the mix's OWN denominator. */
interface ModelMixLeg {
  rows: { key: string; label: string; cost_usd: string; tokens: number; gap_reason: string | null }[]
  total_usd: string
}

/** D21 — one row per budget destination; `allocation_usd` ABSENT = no budget concept (custom range). */
interface WhereItWentRow {
  project_id: string
  code: string
  display_name: string
  mine_usd: string
  /** The PROJECT's window total — the same figure the PM sees (prototype :536). */
  project_total_usd: string
  is_member: boolean
  allocation_usd?: string | null
}

/** D22 — each provider its OWN vocabulary; null = empty state, never zeros. */
interface ClaudeEngagementLeg {
  sessions: number
  active_days: number
  web_searches: number
  surfaces: { tool: string; usd: string }[]
}
interface CopilotEngagementLeg {
  interactions: number | null
  locKept: number | null
  locSuggested: number | null
  locDeleted: number | null
  locSuggestedToDelete: number | null
  keptPct: number | null
  generationActivity: number | null
  acceptanceActivity: number | null
  languages: { language: string; sharePct: number }[] | null
  models: { model: string; sharePct: number }[] | null
  harnesses: { harness: string; sharePct: number }[] | null
  ideActivityExcluded: boolean
}

interface ConsumptionResp {
  headline: Headline
  disclosure: LensDisclosureData
  month: {
    spend_usd: string
    tokens: number
    quota_usd: string
    base_allowance_usd: string
    allocation_usd: string
    run_rate: RunRate
  }
  window_days: number
  series: DaySpend[]
  series_by_model: ModelDaySpend[]
  mix: {
    by_model: ModelSpend[]
    by_token_type: TokenTypeSpend[]
    buckets: { project_code: string; display_name: string; cost_usd: string }[]
    tagged_spend: { activity: string; cost_usd: string }[]
    unallocated: {
      total_cost_usd: string
      untagged_cost_usd: string
      needs_tagging_count: number
      needs_tagging_sessions?: number
      needs_tagging_days?: number
    }
  }
  fidelity: { window_cost_usd: string; advisory_cost_usd: string }
  insights: Finding[]
  freshness_minutes_ago: number | null
  aggregate_refreshed_minutes_ago: number | null
  /**
   * The W2 band hero (D17). It used to be a SIBLING of a §I3 basis-group `hero`
   * leg carrying the two weekly stacks; that card and its leg are RETIRED
   * (owner ruling 2026-08-05), so this is now the page's only hero.
   */
  hero_tiles?: { window: MeHeroWindowWire; tiles: MeHeroTileWire[] }
  provider_truth: { month: string; mtd_usd: string; run_rate: RunRate }
  page_freshness: {
    telemetry_minutes_ago: number | null
    aggregate_minutes_ago: number | null
    provider_feed_minutes_ago: number | null
    worst_minutes_ago: number | null
  }
  /** §A6.2 — the degradation banner's signal; null = healthy, banner hidden. */
  attribution_stall?: { since: string } | null
  /** W0c D11 — the chip row's real operands (D14). */
  providerStates?: ProviderState[]
  coverage?: ReportCoverageMeta | null
  // ── W2 legs ─────────────────────────────────────────────────────────────
  context_residency?: ContextResidencyLeg
  session_economics?: SessionEconomicsLeg
  model_mix?: ModelMixLeg
  where_it_went?: {
    total_usd: string
    untagged_usd: string
    /** The no-project remainder, by the state it is in (r3-M5). */
    no_project?: {
      worklist_usd: string
      activity_tagged_usd: string
      dismissed_usd: string
      untaggable_usd: string
    }
    rows: WhereItWentRow[]
  }
  engagement?: { claude: ClaudeEngagementLeg | null; copilot: CopilotEngagementLeg | null }
}

const { session, ensure } = useSession()
await ensure()

// Daily-spend card's OWN trailing window (D18 — kept as built, independent of
// the month presets; its (i) says "rolls with the days").
const windowDays = ref<30 | 90>(30)
const stackByModel = ref(false)

// ADR 0012 — the LENS. Owned by the URL (`?lane=`), same key/default/validator
// as the reporting area's; the server resolves the headline under it.
const lane = usePersonalLens()

// D16 — the page WINDOW rides the report vocabulary (`?month` XOR `?from/&to`),
// owned by useReportState; DateRangeControl self-wires to the same state.
// `?lane` ownership stays with usePersonalLens — disjoint keys (T13).
//
// W4: this page owns the WINDOW keys and nothing else. `?scope=` is the
// reporting shell's tab selector; without this declaration a DateRangeControl
// preset click stamped `?scope=region` onto a developer-page URL — a key no
// endpoint here reads and no control here can clear.
provideReportStateKeys(WINDOW_STATE_KEYS)
const rs = useReportState()

const { data, refresh, pending, error } = await useFetch<ConsumptionResp>(
  '/api/v1/me/usage',
  {
    query: computed(() => ({
      window: windowDays.value,
      lane: lane.value,
      month: rs.month.value ?? undefined,
      from: rs.from.value ?? undefined,
      to: rs.to.value ?? undefined,
    })),
    lazy: true,
  },
)

/*
 * The tab can outlive the month it is showing: the month is resolved from the
 * SERVER clock at fetch time and useFetch then caches. Re-read on focus.
 */
useRefreshOnVisible(refresh)

const headline = computed(() => data.value?.headline ?? null)
const quota = computed(() => headline.value?.quota ?? null)
const runRate = computed(() => headline.value?.run_rate ?? null)
/*
 * ADR 0012 decision 4, applied to the SWITCH itself: everything the reader
 * sees derives from the lane the SERVER echoed on the headline it actually
 * returned; `lane` (the URL) is the request, not the answer.
 */
const resolvedLane = computed<SpendLens>(() => headline.value?.lane ?? lane.value)
/** The requested lane has moved ahead of the lane the figures on screen are in. */
const laneSwitching = computed(() => lane.value !== resolvedLane.value)
const shownLane = computed<SpendLens>({
  get: () => resolvedLane.value,
  set: (v: SpendLens) => {
    lane.value = v
  },
})
const lensCopy = computed(() => PERSONAL_LENS_COPY[resolvedLane.value])
/** Per-lens explanation under the control — the personal surfaces' own copy. */
const LENS_CAPTIONS: Record<SpendLens, string> = {
  usage: PERSONAL_LENS_COPY.usage.caption,
  chargeback: PERSONAL_LENS_COPY.chargeback.caption,
}

// ── The band + tiles (D17) ───────────────────────────────────────────────────
const heroTiles = computed<MeHeroTileWire[]>(() => data.value?.hero_tiles?.tiles ?? [])
const tilesWindow = computed<MeHeroWindowWire | null>(() => data.value?.hero_tiles?.window ?? null)
/**
 * The band's ONE headline figure = the LEAD tile's window figure (attributed
 * under usage, chargeable under chargeback — the server orders the lane's
 * tiles lead-first). Falls back to the MTD headline for payloads without
 * tiles, which is the same figure under the default window.
 */
const bandTotalUsd = computed(
  () => heroTiles.value[0]?.value_usd ?? headline.value?.mtd_usd ?? '0',
)

/** `2026-07` → `July 2026`, from the SERVER-resolved window (never a client clock). */
function monthWord(m: string | null | undefined): string {
  if (!m) return ''
  const [y, mm] = m.split('-')
  if (!y || !mm) return m
  return new Date(Number(y), Number(mm) - 1, 1).toLocaleString(undefined, {
    month: 'long',
    year: 'numeric',
  })
}
const windowLabel = computed(() => {
  const w = tilesWindow.value
  if (!w) return monthWord(headline.value?.month)
  if (w.is_month) return monthWord(w.month)
  return `${w.from} → ${w.to}`
})
/** "day X of Y" for the in-progress month; "full month" for a complete one. */
const windowDayLine = computed(() => {
  const w = tilesWindow.value
  if (!w?.is_month || w.days_elapsed == null || w.days_in_month == null) return null
  return w.days_elapsed < w.days_in_month || headline.value?.run_rate.is_projection
    ? `day ${w.days_elapsed} of ${w.days_in_month}`
    : `day ${w.days_elapsed} of ${w.days_in_month}`
})
/** The month's LAST day, for the per-row "on pace for ~$X by <date>" line. */
const monthEndLabel = computed(() => {
  const w = tilesWindow.value
  if (!w?.is_month || !w.month || !(w.days_in_month ?? 0)) return null
  const [y, mm] = w.month.split('-')
  if (!y || !mm) return null
  return new Date(Number(y), Number(mm) - 1, w.days_in_month!).toLocaleString(undefined, {
    month: 'long',
    day: 'numeric',
  })
})

// ── Daily spend (kept as built, D18) ─────────────────────────────────────────
// The rolling chart's right edge is the SERVER's settled day (F1/D3); today is
// the partial marker beyond it. Never a browser `new Date()`.
const { settledThrough: chartEndDay, today: chartPartialDay } = useServerClock()
const modelKeyOrder = computed(() => data.value?.mix.by_model.map((m) => m.model) ?? [])
const stackedRows = computed(() =>
  (data.value?.series_by_model ?? []).map((r) => ({ day: r.day, key: r.model, value: Number(r.cost_usd) })),
)
const advisory = computed(() => Number(data.value?.fidelity.advisory_cost_usd ?? 0))

// ── Context residency + session economics (D19) ──────────────────────────────
const residency = computed(() => data.value?.context_residency ?? null)
const RESIDENCY_COLOURS = ['bg-brand-harmony', 'bg-rag-amber', 'bg-brand-zeal', 'bg-calm-2']
const residencySegments = computed(() => {
  const r = residency.value
  if (!r || r.totalUsd <= 0) return []
  return r.segments.map((s, i) => ({
    ...s,
    pct: (s.costUsd / r.totalUsd) * 100,
    colour: RESIDENCY_COLOURS[i % RESIDENCY_COLOURS.length],
  }))
})
const residencyRemainderPct = computed(() => {
  const r = residency.value
  if (!r?.remainder || r.totalUsd <= 0) return 0
  return (r.remainder.costUsd / r.totalUsd) * 100
})
/** Σ beyond the first (standard) band — the premium-band footer operand. */
const residencyPremium = computed(() => {
  const segs = residencySegments.value
  if (segs.length < 2) return null
  const usd = segs.slice(1).reduce((a, s) => a + s.costUsd, 0)
  const pct = segs.slice(1).reduce((a, s) => a + s.pct, 0)
  return { usd, pct, bands: segs.slice(1).map((s) => s.band).join(' + ') }
})

const econ = computed(() => data.value?.session_economics ?? null)
/** Below this a "distribution" names individual sessions — say so instead. */
const ECON_MIN_SESSIONS = 5
const econOtherShare = computed(() => {
  const pct = econ.value?.topShare.pct
  return pct == null ? null : Math.max(0, 100 - pct)
})

// ── Top models (D20) ─────────────────────────────────────────────────────────
const modelDenominator = computed(() => Number(data.value?.model_mix?.total_usd ?? 0))
const modelRows = computed<DriverRow[] | null>(() => {
  const mm = data.value?.model_mix
  if (!mm) return null
  const denom = modelDenominator.value
  return mm.rows.map((r) => ({
    key: r.key,
    label: r.label,
    usd: Number(r.cost_usd),
    sharePct: denom > 0 ? Number(r.cost_usd) / denom : 0,
    spendClass: 'indicative' as const,
    ...(r.gap_reason ? { gap_reason: r.gap_reason } : {}),
  }))
})

// ── Where it went (D21) ──────────────────────────────────────────────────────
const whereItWent = computed(() => data.value?.where_it_went ?? null)
const whereMax = computed(() => {
  const w = whereItWent.value
  if (!w) return 1
  return Math.max(1e-9, ...w.rows.map((r) => Number(r.mine_usd)), Number(w.untagged_usd))
})
/**
 * The no-project remainder as SEGMENTS, in the state each dollar is actually in
 * (r3-M5). Only the first is anybody's queue — the pull-through pill quotes it
 * and nothing else, so a page that used to promise "$35 → worklist" over $3 of
 * actionable money now shows the $3 and draws the rest as what it is.
 *
 * Zero segments are elided: a $0 segment is a state the developer is not in.
 * The bar is the whole story — there is no explanatory paragraph.
 */
const NO_PROJECT_SEGMENTS = [
  { key: 'worklist', label: 'needs tagging', colour: 'bg-rag-amber' },
  { key: 'activity_tagged', label: 'activity-tagged', colour: 'bg-brand-harmony/60' },
  { key: 'dismissed', label: 'dismissed', colour: 'bg-cloud' },
  { key: 'untaggable', label: 'untaggable', colour: 'bg-calm' },
] as const
const noProjectWorklistUsd = computed(() =>
  Number(whereItWent.value?.no_project?.worklist_usd ?? 0),
)
const noProjectSegments = computed(() => {
  const np = whereItWent.value?.no_project
  if (!np) return []
  const raw = NO_PROJECT_SEGMENTS.map((s) => ({
    ...s,
    usd: Number(np[`${s.key}_usd` as keyof typeof np] ?? 0),
  })).filter((s) => s.usd > 0)
  const sum = raw.reduce((a, s) => a + s.usd, 0)
  return sum > 0 ? raw.map((s) => ({ ...s, pct: (s.usd / sum) * 100 })) : []
})

/** THIS row's own month-end landing (per-bucket, never the portfolio — 07-r1-M4). */
function rowProjection(r: WhereItWentRow): number | null {
  const w = tilesWindow.value
  if (!w?.is_month || w.days_elapsed == null || w.days_in_month == null) return null
  if (!('allocation_usd' in r) || r.allocation_usd == null) return null
  return projectedMonthEnd(Number(r.project_total_usd), w.days_elapsed, w.days_in_month)
}
function rowBudgetUsd(r: WhereItWentRow): number | null | undefined {
  if (!('allocation_usd' in r)) return undefined
  return r.allocation_usd == null ? null : Number(r.allocation_usd)
}

// ── Engagement (D22) ─────────────────────────────────────────────────────────
const claudeEng = computed(() => data.value?.engagement?.claude ?? null)
const copilotEng = computed(() => data.value?.engagement?.copilot ?? null)
const SURFACE_COLOURS = ['bg-brand-hunger', 'bg-lane-claude-ai', 'bg-brand-zeal', 'bg-calm-2']
const claudeSurfaces = computed(() => {
  const c = claudeEng.value
  if (!c?.surfaces.length) return []
  const total = c.surfaces.reduce((a, s) => a + Number(s.usd), 0)
  if (total <= 0) return []
  return c.surfaces.map((s, i) => ({
    tool: s.tool,
    pct: (Number(s.usd) / total) * 100,
    colour: SURFACE_COLOURS[i % SURFACE_COLOURS.length],
  }))
})
const LANG_COLOURS = ['bg-brand-vision', 'bg-brand-harmony', 'bg-brand-zeal', 'bg-calm-2']
const copilotLanguages = computed(() =>
  (copilotEng.value?.languages ?? []).map((l, i) => ({
    ...l,
    colour: LANG_COLOURS[i % LANG_COLOURS.length],
  })),
)
/* CLI vs App by requests (D22 keeps session vocabulary off this card). Own palette
 * so two bars are not read as one dimension. */
const HARNESS_COLOURS = ['bg-brand-zeal', 'bg-calm-2']
const copilotHarnesses = computed(() =>
  (copilotEng.value?.harnesses ?? []).map((h, i) => ({
    ...h,
    colour: HARNESS_COLOURS[i % HARNESS_COLOURS.length],
  })),
)
/*
 * Does the card have anything to SAY, as opposed to an object to render from?
 * An all-null object is the normal shape for many spenders, and branching on
 * `copilotEng` alone left that case between the v-if and the v-else — a card
 * holding a heading and nothing else. An empty card is the one outcome the
 * design rules out: absent is SAID, never blank and never zero.
 */
const copilotHasDetail = computed(() => {
  const c = copilotEng.value
  if (!c) return false
  return (
    c.interactions != null ||
    (c.locKept != null && c.locSuggested != null) ||
    (c.locDeleted != null && c.locSuggestedToDelete != null) ||
    copilotLanguages.value.length > 0 ||
    copilotHarnesses.value.length > 0 ||
    c.ideActivityExcluded
  )
})
function fmtLines(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n)
}

// ── Insights (kept — self-visible, dismissible only) ─────────────────────────
const GROUP_LABEL: Record<string, string> = {
  'tool-mastery': 'Tool mastery',
  'context-management': 'Context management',
  'session-hygiene': 'Session hygiene',
}
const dismissing = ref<string | null>(null)
async function dismiss(id: string) {
  dismissing.value = id
  try {
    await $fetch(`/api/v1/me/insights/${id}/ack`, { method: 'POST' })
    await refresh()
  } finally {
    dismissing.value = null
  }
}

// ── Activity chips (kept) + drill-down drawers ───────────────────────────────
const taggedByActivity = computed(() =>
  (data.value?.mix.tagged_spend ?? []).filter((t) => t.activity && Number(t.cost_usd) > 0),
)
const activityDetailName = ref<string | null>(null)
const sessionDetailId = ref<string | null>(null)
function openActivityDetail(activity: string) {
  activityDetailName.value = activity
}
function openSessionDetail(sessionId: string) {
  sessionDetailId.value = sessionId
}

/*
 * ── The worklist + Recent sessions mounts (D24) ─────────────────────────────
 * The SAME wiring Home has (app/pages/index.vue) — the #231/#235 contract
 * lives in the components and their endpoints, none of which change here.
 */
const { data: untagged, refresh: refreshUntagged, error: untaggedError } = useFetch<WorklistResponse>(
  '/api/v1/me/sessions/untagged',
  { default: () => ({ sessions: [], unaccounted: [], dismissed: { sessions: [], unaccounted: [] } }), lazy: true },
)
const unaccounted = computed(() => untagged.value?.unaccounted ?? [])
const dismissedItems = computed(
  () => untagged.value?.dismissed ?? { sessions: [], unaccounted: [] },
)
const needsTaggingSessions = computed(() => (untagged.value?.sessions ?? []).filter((s) => !s.activity))
// The panel's authoritative month figures (server-computed, uncapped) — the
// same `unallocated` leg Home reads, carried by this page's own payload.
const worklistSummary = computed(() => ({
  untagged_cost_usd: data.value?.mix.unallocated?.untagged_cost_usd ?? '0.00',
  needs_tagging_count: data.value?.mix.unallocated?.needs_tagging_count ?? 0,
  needs_tagging_sessions: data.value?.mix.unallocated?.needs_tagging_sessions ?? 0,
  needs_tagging_days: data.value?.mix.unallocated?.needs_tagging_days ?? 0,
}))

/*
 * Activity (§F4) owns its own keyset fetch inside the card — a paged list
 * cannot be driven from the page without moving the cursor here too. The page
 * keeps a handle so the post-tag refresh choreography still reaches it.
 */
const activityCard = ref<{ refresh: () => Promise<void> } | null>(null)
interface QuarantinedRow {
  session_id: string
  instance_id: string
  cost_usd: string
}
const { data: quarantined } = useFetch<{ sessions: QuarantinedRow[] }>(
  '/api/v1/me/quarantined-spend',
  { default: () => ({ sessions: [] }), lazy: true },
)
const { data: myProjects } = useFetch<{ projects: { id: string; code: string; display_name: string; type: string }[] }>(
  '/api/v1/me/projects',
  { default: () => ({ projects: [] }), lazy: true },
)
const { data: activityTypes } = useFetch<{ activity_types: { label: string; is_standard: boolean; is_mine: boolean }[] }>(
  '/api/v1/me/activity-types',
  { default: () => ({ activity_types: [] }), lazy: true },
)

/*
 * The universal tag/re-tag editor target — IMPORTED from the dialog that owns
 * it, not re-declared. See the note on `/`'s copy: three spellings of one shape
 * is three places the `tokens: number | null` rule has to be remembered.
 */
type TagTarget = DialogTagTarget
const tagSession = ref<TagTarget | null>(null)
const providerDayDetailId = ref<string | null>(null)
function openTag(t: TagTarget) {
  tagSession.value = t
}
function openProviderDayDetail(u: WorklistDay) {
  providerDayDetailId.value = u.id
}
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
async function onTagSaved() {
  tagSession.value = null
  await Promise.all([refreshUntagged(), refresh(), activityCard.value?.refresh() ?? Promise.resolve()])
}
async function onWorklistChanged() {
  await Promise.all([refreshUntagged(), refresh()])
}
</script>

<template>
  <div v-if="session" class="max-w-[1400px] mx-auto px-10 py-8 pb-20" data-testid="my-consumption">
    <UiPageHead
      title="My usage"
      sub="What you spent, where it went, and what you could change."
      :crumbs="['My usage']"
    >
      <template #actions>
        <NuxtLink to="/usage/playbook">
          <UiButton kind="ghost" size="sm" data-testid="playbook-link">Optimisation playbook</UiButton>
        </NuxtLink>
      </template>
    </UiPageHead>

    <div v-if="data" class="space-y-5">
      <!-- §A6.2 degradation banner — first thing on the page when attribution
           has stalled; every figure below is suspect while it shows. -->
      <UiAttributionStallBanner :stall="data.attribution_stall" />

      <!-- Lane toggle (fix 6 — /usage keeps its lens) + window presets (fix 1/D16). -->
      <div class="flex items-start justify-between gap-3 flex-wrap">
        <div class="flex items-start gap-3 flex-wrap">
          <ReportingLaneToggle v-model="shownLane" :captions="LENS_CAPTIONS" />
          <!-- The retired "What is and is not chargeable" card's information,
               behind the (i) ON THE CONTROL THAT RAISES THE QUESTION (owner
               ruling 2026-08-05). The card's three scalars are already answered
               by this toggle + the hero tiles + the chip row; only its
               explanation was worth keeping, and an explanation belongs behind
               an affordance, not in the page body (D12). -->
          <span class="mt-1.5">
            <MeLensDisclosure :disclosure="data.disclosure" />
          </span>
          <!-- The re-lens is NAMED, not merely implied by a dimmed card. -->
          <span
            v-if="laneSwitching"
            class="inline-flex items-center gap-1.5 mt-1.5 text-[11px] font-semibold text-carbon-3"
            data-testid="lens-switching"
            role="status"
          >
            <span
              class="inline-block h-1.5 w-1.5 rounded-full bg-brand-harmony animate-pulse"
              aria-hidden="true"
            />
            Switching lens…
          </span>
        </div>
        <DateRangeControl />
      </div>

      <!-- The settlement/coverage chip row (D14, fix 5) — replaces the
           worst-of-sources freshness prose. Real operands (W0c D11). -->
      <div class="flex items-center gap-2 flex-wrap" data-testid="me-chip-row">
        <CcHeaderNotes
          :provider-states="data.providerStates ?? []"
          :coverage="data.coverage ?? null"
          :lane="resolvedLane"
        />
      </div>

      <!-- Month band + the four ScopeKpiTile hero (D17, fix 2). -->
      <UiCard accent="harmony" data-testid="month-band">
        <div
          :class="laneSwitching ? 'opacity-50' : ''"
          :aria-busy="laneSwitching ? 'true' : 'false'"
          data-testid="month-band-figures"
        >
          <div class="flex items-baseline gap-3 flex-wrap mb-4">
            <UiEyebrow>{{ windowLabel }}</UiEyebrow>
            <span
              class="text-[26px] font-bold text-carbon leading-none"
              style="font-variant-numeric: tabular-nums"
              data-testid="mtd-scalar"
              :data-mtd-scalar="resolvedLane"
            >{{ fmtUsd(bandTotalUsd) }}</span>
            <span class="text-xs text-carbon-3" data-testid="mtd-basis">
              {{ lensCopy.basis }}<template v-if="windowDayLine"> · {{ windowDayLine }}</template>
            </span>
          </div>
          <MeHeroTiles
            :tiles="heroTiles"
            :window="tilesWindow"
            :lane="resolvedLane"
            :quota="quota"
            :run-rate="runRate"
            :mtd-usd="headline?.mtd_usd ?? null"
          />
        </div>
      </UiCard>

      <!-- Daily spend — KEPT AS BUILT (owner ruling, D18): trailing 30/90d,
           by-model stack toggle, advisory footnote. Moved up; not redesigned. -->
      <UiCard data-testid="trend-card">
        <div class="flex items-center justify-between mb-2">
          <UiEyebrow>
            Daily spend · attributed telemetry · last {{ windowDays }}d
            <InfoDot label="About the daily spend window">
              Rolls with the days — independent of the month presets above.
            </InfoDot>
          </UiEyebrow>
          <UsageWindowToggle v-model="windowDays">
            <button
              class="text-[11px] px-2 py-0.5 rounded border"
              :class="stackByModel ? 'border-brand-harmony text-brand-harmony font-bold' : 'border-calm-2 text-carbon-3'"
              :aria-pressed="stackByModel"
              data-testid="stack-toggle"
              @click="stackByModel = !stackByModel"
            >by model</button>
          </UsageWindowToggle>
        </div>
        <ChartsStackedBars
          v-if="stackByModel && chartEndDay"
          :rows="stackedRows"
          :key-order="modelKeyOrder"
          :label-for="(k) => modelDisplay(k).label"
          :window-days="windowDays"
          :end-day="chartEndDay"
          :partial-day="chartPartialDay"
        />
        <ChartsTrendArea
          v-else-if="chartEndDay"
          :series="data.series"
          :window-days="windowDays"
          :end-day="chartEndDay"
          :partial-day="chartPartialDay"
          empty-label="No telemetry-observed spend in this window — provider-recorded days are listed below, not charted here."
        />
        <p v-if="advisory > 0" class="text-[10px] text-carbon-3 mt-1 text-right">
          {{ fmtUsd(advisory) }} of the last {{ windowDays }}d is advisory (telemetry-only) spend
        </p>
      </UiCard>

      <!-- The two cost-behaviour cards share a row (D19): the restart-the-
           session lever, priced two ways. -->
      <div class="grid grid-cols-1 lg:grid-cols-2 gap-5">
        <UiCard data-testid="context-residency-card">
          <UiEyebrow>Where your context lived</UiEyebrow>
          <p class="text-[11px] text-carbon-3 mt-0.5">
            Spend by context-window band
            <InfoDot label="About context-window residency">
              The provider reports the dimension itself — <code>context_window</code> rides every
              Anthropic row. The larger band bills premium input rates; a fresh session resets the
              window.
            </InfoDot>
          </p>
          <template v-if="residency && residency.totalUsd > 0">
            <div class="flex h-[22px] rounded overflow-hidden mt-3" aria-hidden="true">
              <div
                v-for="s in residencySegments"
                :key="s.band"
                :class="s.colour"
                :style="{ width: `${s.pct}%` }"
                :title="`${s.band} · ${fmtUsd(s.costUsd)}`"
              />
              <div
                v-if="residencyRemainderPct > 0"
                class="bg-calm"
                :style="{ width: `${residencyRemainderPct}%` }"
                :title="residency.remainder?.label"
              />
            </div>
            <div class="flex flex-wrap gap-x-4 gap-y-1 mt-2 text-[11px] text-carbon-2">
              <span v-for="s in residencySegments" :key="s.band" :data-testid="`residency-band-${s.band}`">
                <span class="inline-block w-2 h-2 rounded-full align-middle mr-1" :class="s.colour" />
                {{ s.band }} · {{ fmtUsd(s.costUsd) }} · {{ Math.round(s.pct) }}%
              </span>
            </div>
            <p class="text-[11px] text-carbon-3 mt-3 pt-2 border-t border-calm-2" data-testid="residency-footer">
              <template v-if="residencyPremium && residencyPremium.usd > 0">
                <b class="text-carbon-2">{{ Math.round(residencyPremium.pct) }}% in {{ residencyPremium.bands }}</b>
                — the premium band<template v-if="residency.remainder"> · </template>
              </template>
              <template v-else-if="!residency.remainder">nearly all in the standard window</template>
              <span v-if="residency.remainder" data-testid="residency-remainder">
                {{ fmtUsd(residency.remainder.costUsd) }} {{ residency.remainder.label }}
              </span>
            </p>
          </template>
          <!--
            AN ABSENT DIMENSION IS NOT ABSENT SPEND.
            This card reads ONE lane: `provider_usage_fact` where
            `provider='anthropic'` — Anthropic's own billing feed. It is not a
            view of the teammate's Anthropic usage, and the difference is the
            whole subject of this comment.

            Two very different things make it empty:
              (a) rows exist but `context_window` is NULL — the band was not
                  reported for them. `residency.remainder` carries that money.
              (b) there are no Anthropic API-lane rows AT ALL. This says nothing
                  about whether the person used Claude: OTel-observed usage never
                  appears in this table, so a Max-subscription developer with
                  thousands of dollars of `claude-code` in `v_complete_usage` sits
                  here with zero rows.

            It once answered BOTH with "No Anthropic spend in this window" — false
            to a developer with Claude usage on the same screen, and the
            most-reported defect of the last release.

            THE ROUND-1 FIX OF THAT DEFECT INTRODUCED A SECOND ONE (external
            review, round 2): case (b) was rewritten as "none of your spend in
            this window is Anthropic", which reads API-lane absence as VENDOR
            absence — the same conflation wearing the opposite coat, and wrong for
            exactly the OTel-only Claude user the original defect was about.

            So (b) now names the LANE and claims nothing about the vendor or the
            spend. The rule this card keeps failing and must not fail again: state
            what is missing from the lane you read, never what the reader spent.
          -->
          <p v-else class="text-xs text-carbon-3 italic py-6 text-center" data-testid="residency-empty">
            <template v-if="residency?.remainder">
              Context-window bands aren't available for this window — your Anthropic
              spend is counted, it just isn't split by band yet.
            </template>
            <template v-else-if="Number(data?.month?.spend_usd ?? 0) > 0">
              Context-window bands come from Anthropic's billing feed, and none of
              your spend in this window reached us through it — your spend is
              counted in full elsewhere on this page.
            </template>
            <template v-else>No usage in this window.</template>
          </p>
        </UiCard>

        <UiCard data-testid="session-economics-card">
          <UiEyebrow>Session economics</UiEyebrow>
          <p class="text-[11px] text-carbon-3 mt-0.5">
            OTel-observed sessions
            <InfoDot label="About session economics">
              A provider-recorded day is not a conversation — api-reconciled days carry no session
              behind them and are not blended in. This card reads your OTel-observed conversations
              only.
            </InfoDot>
          </p>
          <template v-if="econ && econ.sessions >= ECON_MIN_SESSIONS">
            <div class="flex gap-8 mt-3" data-testid="session-economics-stats">
              <div>
                <UiEyebrow>median</UiEyebrow>
                <div class="text-xl font-bold text-carbon" style="font-variant-numeric: tabular-nums">
                  {{ econ.medianUsd != null ? fmtUsd(econ.medianUsd) : '—' }}
                </div>
              </div>
              <div>
                <UiEyebrow>p90</UiEyebrow>
                <div class="text-xl font-bold text-carbon" style="font-variant-numeric: tabular-nums">
                  {{ econ.p90Usd != null ? fmtUsd(econ.p90Usd) : '—' }}
                </div>
                <div v-if="econ.medianUsd && econ.p90Usd && econ.medianUsd > 0" class="text-[11px] text-carbon-3">
                  {{ Math.round(econ.p90Usd / econ.medianUsd) }}× median
                </div>
              </div>
              <div>
                <UiEyebrow>top {{ econ.topShare.n }} sessions</UiEyebrow>
                <div class="text-xl font-bold text-carbon" style="font-variant-numeric: tabular-nums">
                  {{ econ.topShare.pct != null ? `${Math.round(econ.topShare.pct)}%` : '—' }}
                </div>
                <div class="text-[11px] text-carbon-3">of session spend</div>
              </div>
            </div>
            <template v-if="econ.topShare.pct != null && econOtherShare != null">
              <div class="flex h-[16px] rounded overflow-hidden mt-3" aria-hidden="true">
                <div class="bg-brand-harmony" :style="{ width: `${econ.topShare.pct}%` }" />
                <div class="bg-calm" :style="{ width: `${econOtherShare}%` }" />
              </div>
              <div class="flex gap-4 mt-1.5 text-[11px] text-carbon-2">
                <span><span class="inline-block w-2 h-2 rounded-full align-middle mr-1 bg-brand-harmony" />top {{ econ.topShare.n }} · {{ Math.round(econ.topShare.pct) }}%</span>
                <span><span class="inline-block w-2 h-2 rounded-full align-middle mr-1 bg-calm" />{{ econ.sessions - econ.topShare.n }} others · {{ Math.round(econOtherShare) }}%</span>
              </div>
            </template>
          </template>
          <p
            v-else-if="econ && econ.sessions > 0"
            class="text-xs text-carbon-3 italic py-6 text-center"
            data-testid="session-economics-early"
          >
            {{ econ.sessions }} session{{ econ.sessions === 1 ? '' : 's' }} so far — a distribution
            needs a few days
          </p>
          <p v-else class="text-xs text-carbon-3 italic py-6 text-center" data-testid="session-economics-empty">
            No sessions in this window.
          </p>
        </UiCard>
      </div>

      <!-- Top models (D20, fix 3 — the donut idiom dies) + insights beside it. -->
      <div class="grid grid-cols-1 lg:grid-cols-2 gap-5 items-start">
        <UiCard data-testid="top-models-card">
          <UiEyebrow>Top models</UiEyebrow>
          <p class="text-[11px] text-carbon-3 mt-0.5 mb-3">Ranked by attributed cost · this window</p>
          <ModelSplitPanel
            :rows="modelRows"
            :denominator-usd="modelDenominator"
            lane="attributed"
            :top-n="8"
          />
        </UiCard>

        <div>
          <UiCard v-if="data.insights.length" accent="vision" data-testid="insights-card">
            <UiEyebrow>Observed in your usage</UiEyebrow>
            <p class="text-[11px] text-carbon-3 mt-1 mb-3">
              Patterns from your own last 28 days
              <InfoDot label="About these insights">
                Entirely optional and dismissible — never visible to anyone else. Insights stay
                self-visible; manager depth never sees behavioural findings.
              </InfoDot>
            </p>
            <div class="space-y-3">
              <div
                v-for="f in data.insights"
                :key="f.id"
                class="rounded-lg border border-calm-2 bg-white/70 px-4 py-3"
                :data-testid="`insight-${f.id}`"
              >
                <div class="flex items-start justify-between gap-3">
                  <div class="min-w-0">
                    <div class="flex items-center gap-2">
                      <span
                        class="inline-block w-2 h-2 rounded-full shrink-0"
                        :class="f.severity === 'medium' ? 'bg-rag-amber' : 'bg-cloud'"
                        aria-hidden="true"
                      />
                      <span class="text-[10px] font-bold uppercase tracking-wide text-carbon-3">
                        {{ GROUP_LABEL[f.group] ?? f.group }}
                      </span>
                      <UiBadge v-if="f.estimated_monthly_savings_usd" kind="zeal">
                        ~{{ fmtUsd(f.estimated_monthly_savings_usd) }}/mo if changed
                      </UiBadge>
                    </div>
                    <p class="text-sm text-carbon mt-1.5">{{ f.headline }}</p>
                    <p class="text-[11px] text-carbon-3 mt-1">
                      Levers:
                      <NuxtLink
                        v-for="lever in f.related_levers"
                        :key="lever"
                        :to="`/usage/playbook#${lever}`"
                        class="underline mr-1.5"
                      >{{ lever }}</NuxtLink>
                    </p>
                  </div>
                  <UiButton
                    kind="ghost"
                    size="sm"
                    :disabled="dismissing === f.id"
                    :data-testid="`dismiss-${f.id}`"
                    @click="dismiss(f.id)"
                  >
                    Dismiss
                  </UiButton>
                </div>
              </div>
            </div>
          </UiCard>
          <UiCard v-else data-testid="insights-empty">
            <UiEyebrow>Observed in your usage</UiEyebrow>
            <p class="text-sm text-carbon-2 mt-2">
              Nothing to flag in your last 28 days — your usage patterns look healthy. The
              <NuxtLink to="/usage/playbook" class="underline">playbook</NuxtLink> is there if you're curious.
            </p>
          </UiCard>
        </div>
      </div>

      <!-- Where it went (D21, fix 4) — bar rows with the PROJECT's against-
           budget state through the ONE BudgetStateCell implementation. -->
      <UiCard v-if="whereItWent" data-testid="where-it-went">
        <UiEyebrow>
          Where it went
          <InfoDot label="About the against-budget column">
            The against-budget column is the PROJECT's state — the same figure the PM and the
            reports project axis see, never your share of it.
          </InfoDot>
        </UiEyebrow>
        <p class="text-[11px] text-carbon-3 mt-0.5 mb-3">Your spend by budget destination · this window</p>
        <div class="hidden sm:flex items-center gap-3 text-[10px] font-bold uppercase tracking-wide text-carbon-3 mb-1.5">
          <span class="flex-none w-[220px]">Project</span>
          <span class="flex-1">share of your spend</span>
          <span class="flex-none w-[90px] text-right">this window</span>
          <span class="flex-none w-[170px] text-right">against budget</span>
        </div>
        <div class="space-y-1.5">
          <div
            v-for="r in whereItWent.rows"
            :key="r.project_id"
            class="flex items-center gap-3"
            :data-testid="`where-row-${r.code}`"
          >
            <span class="flex-none w-[220px] text-[13px] font-semibold text-carbon truncate">
              <!-- D29's rule applied here: link iff current member — never a dead link. -->
              <NuxtLink
                v-if="r.is_member"
                :to="`/projects/${r.code}`"
                class="hover:text-brand-harmony hover:underline underline-offset-2"
                :data-testid="`where-link-${r.code}`"
              >{{ r.display_name }}</NuxtLink>
              <template v-else>{{ r.display_name }}</template>
            </span>
            <span class="flex-1 h-[10px] rounded bg-calm-2/50 overflow-hidden">
              <span
                class="block h-full bg-brand-harmony rounded"
                :style="{ width: `${(Number(r.mine_usd) / whereMax) * 100}%` }"
              />
            </span>
            <span class="flex-none w-[90px] text-right text-[13px] font-bold text-carbon" style="font-variant-numeric: tabular-nums">
              {{ fmtUsd(r.mine_usd) }}
            </span>
            <span class="flex-none w-[170px] text-right">
              <BudgetStateCell
                :usd="Number(r.project_total_usd)"
                :budget-usd="rowBudgetUsd(r)"
                :projected-usd="rowProjection(r)"
                :month-end="monthEndLabel"
              />
            </span>
          </div>
          <div class="flex items-center gap-3" data-testid="where-row-untagged">
            <span class="flex-none w-[220px] text-[13px] font-semibold text-carbon">
              No project
              <!-- The pill quotes the WORKLIST-ELIGIBLE figure only (r3-M5): it
                   is a link into a queue, so it must state the queue's money. -->
              <a
                v-if="noProjectWorklistUsd > 0"
                href="#worklist"
                class="ml-1.5 text-[10px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded bg-rag-amber/10 text-rag-amber hover:underline"
                data-testid="where-untagged-worklist-pill"
              >{{ fmtUsd(noProjectWorklistUsd) }} → worklist</a>
            </span>
            <span class="flex-1 h-[10px] rounded bg-calm-2/50 overflow-hidden">
              <!-- SEGMENTED by state — the visual IS the disclosure. -->
              <span
                v-if="noProjectSegments.length"
                class="flex h-full rounded overflow-hidden"
                :style="{ width: `${(Number(whereItWent.untagged_usd) / whereMax) * 100}%` }"
              >
                <span
                  v-for="s in noProjectSegments"
                  :key="s.key"
                  :class="s.colour"
                  :style="{ width: `${s.pct}%` }"
                  :title="`${fmtUsd(s.usd)} ${s.label}`"
                  :data-testid="`where-untagged-seg-${s.key}`"
                />
              </span>
              <span
                v-else
                class="block h-full bg-calm rounded"
                :style="{ width: `${(Number(whereItWent.untagged_usd) / whereMax) * 100}%` }"
              />
            </span>
            <span class="flex-none w-[90px] text-right text-[13px] font-bold text-carbon" style="font-variant-numeric: tabular-nums">
              {{ fmtUsd(whereItWent.untagged_usd) }}
            </span>
            <span class="flex-none w-[170px] text-right">
              <!-- No budget CONCEPT on the untagged bucket — n/a, never "no budget set". -->
              <BudgetStateCell :usd="Number(whereItWent.untagged_usd)" />
            </span>
          </div>
        </div>
      </UiCard>

      <!-- Engagement side by side (D22) — each provider its OWN vocabulary;
           no metric is manufactured to mirror the other column. -->
      <div class="grid grid-cols-1 lg:grid-cols-2 gap-5">
        <UiCard data-testid="engagement-claude">
          <UiEyebrow>Claude — what the spend was</UiEyebrow>
          <template v-if="claudeEng">
            <!--
              A ZERO FROM AN ABSENT LANE IS NOT A MEASUREMENT.
              `sessions` counts OTel-observed sessions; `surfaces` splits MONEY,
              which includes provider-recorded days that carry no session at all
              (F4: "a provider-recorded day is not a conversation"). A teammate
              whose spend is entirely provider-recorded therefore produced
              "0 sessions · Claude Code 100%" — two true numbers making one false
              sentence. The server's own comment says "empty = null, never
              zeros"; the `||` at usage.get.ts:530 lets a partially-empty block
              through with the zero still in it.
              So the count is stated only when it was MEASURED, and its absence
              is named rather than printed as nought.
            -->
            <p class="text-sm text-carbon-2 mt-2" data-testid="engagement-claude-lede">
              <template v-if="claudeEng.sessions > 0">
                {{ claudeEng.sessions }} session{{ claudeEng.sessions === 1 ? '' : 's' }} ·
                {{ claudeEng.active_days }} active day{{ claudeEng.active_days === 1 ? '' : 's' }} ·
                {{ claudeEng.web_searches }} web search{{ claudeEng.web_searches === 1 ? '' : 'es' }}
              </template>
              <!-- A <span>, not a <template>: a template renders nothing, so the
                   testid was silently dropped and could never have been asserted.

                   TWO NO-SESSION CASES (external review, round 2). The server
                   builds this block on `sessions > 0 || surfaces.length > 0 ||
                   webSearches > 0`, so web-search activity ALONE opens it — with
                   no surfaces and no money. Saying "no sessions behind this
                   spend" there asserts a spend that does not exist, which is the
                   same class as the defect above, inverted. `claudeSurfaces` is
                   the money split, so it is what decides which sentence is true. -->
              <span v-else-if="claudeSurfaces.length" data-testid="engagement-claude-no-sessions">
                No sessions behind this spend — it arrived as provider-recorded days,
                which carry no session to count.
              </span>
              <span v-else data-testid="engagement-claude-no-spend">
                No sessions and no spend recorded in this window.
              </span>
            </p>
            <template v-if="claudeSurfaces.length">
              <div class="flex items-center gap-2 mt-3">
                <span class="text-[10px] font-bold uppercase tracking-wide text-carbon-3 w-[64px]">Surface</span>
                <span class="flex-1 flex h-[12px] rounded overflow-hidden">
                  <span
                    v-for="s in claudeSurfaces"
                    :key="s.tool"
                    :class="s.colour"
                    :style="{ width: `${s.pct}%` }"
                    :title="clientMeta(s.tool).name"
                  />
                </span>
              </div>
              <div class="flex flex-wrap gap-x-4 gap-y-1 mt-1.5 ml-[72px] text-[11px] text-carbon-2">
                <span v-for="s in claudeSurfaces" :key="s.tool">
                  <span class="inline-block w-2 h-2 rounded-full align-middle mr-1" :class="s.colour" />
                  {{ clientMeta(s.tool).name }} {{ Math.round(s.pct) }}%
                </span>
              </div>
            </template>
          </template>
          <p v-else class="text-xs text-carbon-3 italic py-6 text-center" data-testid="engagement-claude-empty">
            No Claude usage in this window.
          </p>
        </UiCard>

        <UiCard data-testid="engagement-copilot">
          <UiEyebrow>Copilot — what you got for it</UiEyebrow>
          <!-- `copilotEng &&` is redundant at runtime (copilotHasDetail implies
               it) and required for the compiler to narrow the block below. -->
          <template v-if="copilotEng && copilotHasDetail">
            <p class="text-sm text-carbon-2 mt-2" data-testid="engagement-copilot-lede">
              <template v-if="copilotEng.interactions != null">{{ copilotEng.interactions }} interactions</template>
              <template v-if="copilotEng.locKept != null && copilotEng.locSuggested != null">
                <template v-if="copilotEng.interactions != null"> · </template>
                <b>{{ fmtLines(copilotEng.locKept) }} lines kept</b> of
                {{ fmtLines(copilotEng.locSuggested) }} suggested<template v-if="copilotEng.keptPct != null"> ({{ Math.round(copilotEng.keptPct) }}%)</template>
              </template>
            </p>
            <!-- Deleted-LOC legs render ONLY when the wire sent them (honest numbers). -->
            <p
              v-if="copilotEng.locDeleted != null && copilotEng.locSuggestedToDelete != null"
              class="text-[11px] text-carbon-3 mt-1"
              data-testid="engagement-copilot-deleted"
            >
              {{ fmtLines(copilotEng.locDeleted) }} lines deleted of
              {{ fmtLines(copilotEng.locSuggestedToDelete) }} suggested deletions
            </p>
            <!-- HARNESS, not SURFACE: the Claude card's SURFACE bar splits MONEY, which
                 Copilot's one-per-day figure cannot be. The basis is printed on the bar. -->
            <template v-if="copilotHarnesses.length">
              <div class="flex items-center gap-2 mt-3">
                <span class="text-[10px] font-bold uppercase tracking-wide text-carbon-3 w-[64px]">Harness</span>
                <span class="flex-1 flex h-[12px] rounded overflow-hidden" data-testid="engagement-copilot-harness-bar">
                  <span
                    v-for="h in copilotHarnesses"
                    :key="h.harness"
                    :class="h.colour"
                    :style="{ width: `${h.sharePct}%` }"
                    :title="`${h.harness} ${Math.round(h.sharePct)}% of requests`"
                  />
                </span>
                <span class="text-[10px] text-carbon-3 whitespace-nowrap">by requests</span>
              </div>
              <div
                class="flex flex-wrap gap-x-4 gap-y-1 mt-1.5 ml-[72px] text-[11px] text-carbon-2"
                data-testid="engagement-copilot-harness-legend"
              >
                <span v-for="h in copilotHarnesses" :key="h.harness">
                  <span class="inline-block w-2 h-2 rounded-full align-middle mr-1" :class="h.colour" />
                  {{ h.harness }} {{ Math.round(h.sharePct) }}%
                </span>
              </div>
            </template>
            <!-- OUTSIDE the bar: most Copilot days are IDE-only, so this is usually the
                 only harness line there is. Nested, it would never have rendered. -->
            <p
              v-if="copilotEng.ideActivityExcluded"
              class="text-[11px] text-carbon-3 mt-1"
              :class="copilotHarnesses.length ? 'ml-[72px]' : 'mt-3'"
              data-testid="engagement-copilot-harness-ide-note"
            >
              IDE activity reported on a different measure
            </p>
            <template v-if="copilotLanguages.length">
              <div class="flex items-center gap-2 mt-3">
                <span class="text-[10px] font-bold uppercase tracking-wide text-carbon-3 w-[64px]">Languages</span>
                <span class="flex-1 flex h-[12px] rounded overflow-hidden">
                  <span
                    v-for="l in copilotLanguages"
                    :key="l.language"
                    :class="l.colour"
                    :style="{ width: `${l.sharePct}%` }"
                    :title="l.language"
                  />
                </span>
              </div>
              <div class="flex flex-wrap gap-x-4 gap-y-1 mt-1.5 ml-[72px] text-[11px] text-carbon-2">
                <span v-for="l in copilotLanguages" :key="l.language">
                  <span class="inline-block w-2 h-2 rounded-full align-middle mr-1" :class="l.colour" />
                  {{ l.language }} {{ Math.round(l.sharePct) }}%
                </span>
              </div>
            </template>
          </template>
          <!--
            Two DIFFERENT absences, said differently: nothing happened, versus
            something happened and the detail behind it is not reported. Folding
            them into one sentence would tell a spending Copilot user they had
            no activity.
          -->
          <p
            v-else-if="copilotEng"
            class="text-xs text-carbon-3 italic py-6 text-center"
            data-testid="engagement-copilot-nodetail"
          >
            No Copilot engagement detail in this window.
          </p>
          <p v-else class="text-xs text-carbon-3 italic py-6 text-center" data-testid="engagement-copilot-empty">
            No Copilot activity in this window.
          </p>
        </UiCard>
      </div>

      <!-- Tagged-by-activity — kept without ruling. -->
      <UiCard v-if="taggedByActivity.length" data-testid="activity-chips">
        <UiEyebrow>By activity · tagged spend</UiEyebrow>
        <p class="text-[11px] text-carbon-3 mt-0.5">Click a tag to see how it broke down — models, token lanes, and the sessions behind it.</p>
        <div class="flex flex-wrap gap-2 mt-3">
          <button
            v-for="a in taggedByActivity"
            :key="a.activity"
            type="button"
            class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full border border-calm-2 text-xs text-carbon-2 hover:border-brand-harmony hover:text-brand-harmony transition-colors capitalize"
            :data-testid="`activity-chip-${a.activity}`"
            @click="openActivityDetail(a.activity)"
          >
            {{ a.activity }}
            <span class="font-semibold text-carbon" style="font-variant-numeric: tabular-nums">{{ fmtUsd(a.cost_usd) }}</span>
          </button>
        </div>
      </UiCard>

      <!-- NEEDS TAGGING (D24, fix 11) — the #231/#235 worklist contract,
           mounted with the SAME wiring Home has. The anchor is the Where-it-
           went untagged pill's target. -->
      <div id="worklist">
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
      </div>

      <!-- Activity (§F4) — ONE list holding sessions AND provider-recorded
           days, dual-mounted with Home. The worklist above is the TASK list;
           this is the RECORD, and a decided provider-day stays on it. Each row
           kind opens the drawer that already exists for it, mounted below. -->
      <ActivityCard
        ref="activityCard"
        :quarantined="quarantined?.sessions ?? []"
        @open-session="openSessionDetail"
        @open-provider-day="providerDayDetailId = $event"
        @retag="openTag"
      />
    </div>
    <UiEmptyState
      v-else-if="error"
      headline="Couldn't load your usage"
      sub="Something went wrong fetching this page. Refresh to try again."
      data-testid="my-consumption-error"
    />
    <!-- D13 (fix 12): the pending state is the report skeleton, not prose — the
         same settle() signal parity-shots keys on (skeleton gone + rendered money). -->
    <ReportSkeleton v-else-if="pending" :kpis="4" :rows="6" />

    <!-- Drill-downs: activity → its sessions → full session breakdown. -->
    <ActivityDetailDrawer
      :activity="activityDetailName"
      @close="activityDetailName = null"
      @open-session="openSessionDetail"
    />
    <SessionDetailDrawer :session-id="sessionDetailId" @close="sessionDetailId = null" />

    <!-- The worklist contract's editor + day drawer (D24 — components unchanged). -->
    <HomeTagSessionDialog
      :target="tagSession"
      :projects="myProjects?.projects ?? []"
      :activity-types="activityTypes?.activity_types ?? []"
      @close="tagSession = null"
      @saved="onTagSaved"
    />
    <ProviderDayDetailDrawer
      :record-id="providerDayDetailId"
      @close="providerDayDetailId = null"
    />
  </div>
</template>
