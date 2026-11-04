<script setup lang="ts">
/*
 * Admin → Policies → Provider governance (Workstream B + C). The operator
 * surfaces the design's rollout/rollback runbook depends on:
 *   1. Governance cutover — preflight / activate / rollback the GitHub
 *      heuristic → governance-data switch (ADR-0011 D1/D2/D11).
 *   2. Reporting snapshots — record what a calendar month's
 *      chargeback verdict freeze.
 *   3. Governance-unresolved — the operator diagnostic for money rows whose
 *      governance key could not be resolved, with a recheck action.
 *   4. Copilot rate plans + overage allocation (Workstream C) — effective-
 *      dated seat price / included allowance history (ADR-0011 D9) and an
 *      audited historical bill re-pull for one enterprise + month
 *      (design §5.3/§5.4/§8.4).
 *
 * platform-admin ONLY (org-wide access) — mirrors the
 * server-side RBAC on every endpoint this page calls.
 */
import { ref, computed, watch } from 'vue'
import { useAdminAccess } from '../../../composables/useAdminAccess'
import { apiErrorDetail } from '../../../composables/useApiError'

definePageMeta({ layout: 'admin', middleware: 'admin' })

// The root is v-if="isOrgWide": the nav hides this page from region admins
// (shared/nav/admin-nav.ts, access: 'org-wide') but a typed URL lands here, and
// every read below is gated on isOrgWide — rendering the cards would show
// loading states that never resolve.
const { isOrgWide } = useAdminAccess()

// ── Governance cutover ──────────────────────────────────────────────────
interface CutoverState {
  status: 'not_started' | 'preflight_verified' | 'activated' | 'rolled_back'
  preflightSnapshot: unknown
  preflightVerifiedAt: string | null
  activatedAt: string | null
  rolledBackAt: string | null
}
// Every read on this page is DECLARED, never awaited (admin-nav-responsiveness
// D1): lazy, client-only, `null` until it lands; each card renders skeleton /
// error / data keyed on the ABSENCE of data, never on `pending` (D2).
const { data: cutover, error: cutoverFetchError, refresh: refreshCutover } = useLazyFetch<CutoverState | null>(
  '/api/v1/admin/governance-cutover',
  { server: false, default: () => null, immediate: isOrgWide.value },
)
const cutoverBusy = ref(false)
const cutoverError = ref<string | null>(null)
const rollbackReason = ref('')

const cutoverBadgeKind = computed(() => {
  switch (cutover.value?.status) {
    case 'activated':
      return 'rag-green'
    case 'preflight_verified':
      return 'rag-amber'
    case 'rolled_back':
      return 'rag-red'
    default:
      return 'neutral'
  }
})

async function runPreflight() {
  cutoverBusy.value = true
  cutoverError.value = null
  try {
    await $fetch('/api/v1/admin/governance-cutover/preflight', { method: 'POST', body: {} })
    await refreshCutover()
  } catch (e: unknown) {
    cutoverError.value = apiErrorDetail(e, 'Preflight failed')
  } finally {
    cutoverBusy.value = false
  }
}
async function activate() {
  cutoverBusy.value = true
  cutoverError.value = null
  try {
    await $fetch('/api/v1/admin/governance-cutover/activate', { method: 'POST', body: {} })
    await refreshCutover()
  } catch (e: unknown) {
    cutoverError.value = apiErrorDetail(e, 'Activation failed')
  } finally {
    cutoverBusy.value = false
  }
}
async function rollback() {
  if (!rollbackReason.value.trim()) return
  cutoverBusy.value = true
  cutoverError.value = null
  try {
    await $fetch('/api/v1/admin/governance-cutover/rollback', { method: 'POST', body: { reason: rollbackReason.value.trim() } })
    rollbackReason.value = ''
    await refreshCutover()
  } catch (e: unknown) {
    cutoverError.value = apiErrorDetail(e, 'Rollback failed')
  } finally {
    cutoverBusy.value = false
  }
}

// ── Reporting snapshots ─────────────────────────────────────────────────
/*
 * RECORD A MONTH. There is no reopen and no restate: mig 0128 demoted the close
 * from a freeze to a snapshot, and this card still called
 * `/admin/finance-periods/{month}/{close,reopen,restate}` — four endpoints that
 * no longer exist. Every button here 404'd.
 *
 * What replaces them is one action and one question. Recording a month writes
 * down what it read; asking for it again returns that plus what the month reads
 * NOW and the movement between them, because the bill lands after the month is
 * reported and the product's job is to surface that, not to refuse it.
 */
function lastCompleteMonth(): string {
  const now = new Date()
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 0))
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`
}
const periodMonth = ref(lastCompleteMonth())
interface SnapshotDelta {
  // `periodMonth`, `closedAt` and `basis` are TOP-LEVEL on the delta; `snapshot`
  // carries only the three figures. Reading `snapshot.closedAt` rendered
  // "Recorded Invalid Date" on every recorded month.
  periodMonth: string
  closedAt: string
  snapshotVersion: number
  snapshot: { attributedUsd: number; chargeableUsd: number; exemptUsd: number }
  current: { attributedUsd: number; chargeableUsd: number; exemptUsd: number }
  deltaUsd: { attributed: number; chargeable: number; exempt: number } | null
  incomparableReason: string | null
  chargeableUnchanged: boolean
  attributedMoved: boolean
}
/*
 * The snapshot read owns its data/error/refresh like every other read (D1).
 * The route answers `null` for a month never recorded — a real answer, not
 * "not loaded" — so the payload is wrapped: `periodData == null` means the
 * read has not landed; `periodData.delta == null` means never recorded.
 * `watch: [periodMonth]` is what refetches when the month changes.
 */
const {
  data: periodData,
  error: periodFetchError,
  pending: periodPending,
  refresh: loadPeriod,
} = useLazyAsyncData(
  'provider-governance-period',
  async () => ({
    delta: await $fetch<SnapshotDelta | null>(`/api/v1/admin/reporting-snapshots/${periodMonth.value}`),
  }),
  { server: false, default: () => null, immediate: isOrgWide.value, watch: [periodMonth] },
)
/** null = never recorded, or not yet loaded (the template tells them apart via
 *  periodData). Distinct from recorded-and-unchanged. */
const period = computed(() => periodData.value?.delta ?? null)
const periodBusy = ref(false)
const periodError = ref<string | null>(null)

async function closePeriod() {
  periodBusy.value = true
  periodError.value = null
  try {
    // `loadPeriod()` re-reads `periodMonth`, so the month input is disabled
    // while `periodBusy` (template): the confirmation the operator sees is
    // always for the month that was written. Disabling the one control beats
    // threading a captured month through the read's own handler.
    await $fetch(`/api/v1/admin/reporting-snapshots/${periodMonth.value}/close`, { method: 'POST', body: {} })
  } catch (e: unknown) {
    // A second close is refused on purpose — replacing what was reported the
    // first time is the one thing a snapshot exists to prevent.
    periodError.value = apiErrorDetail(e, 'Could not record the month')
    periodBusy.value = false
    return
  }
  /*
   * PAST THIS LINE THE MONTH IS RECORDED. The reload is outside the write's
   * catch so a read failure can never render as a failed record. Nuxt's
   * `refresh()` resolves on failure (it reports into `periodFetchError`, which
   * the banner above renders), so this catch is the belt-and-braces path.
   */
  try {
    await loadPeriod()
  } catch (e: unknown) {
    periodError.value = apiErrorDetail(e, 'Recorded — but the snapshot could not be reloaded. Reload the page to see it.')
  } finally {
    periodBusy.value = false
  }
}

const money = (n: number) =>
  n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 })

// ── Governance-unresolved diagnostics ────────────────────────────────────
interface UnresolvedDiagnostics {
  reachable: boolean
  actualSpend?: { pendingBackfill: number; parkedUnresolved: number }
  reconciliationRecord?: { pendingBackfill: number; parkedUnresolved: number }
  pendingPlacement?: { unresolved: number }
  bySource?: { source: string; count: number; costUsd: string }[]
}
const { data: unresolved, error: unresolvedError, refresh: refreshUnresolved } = useLazyFetch<UnresolvedDiagnostics | null>(
  '/api/v1/admin/diagnostics/governance-unresolved',
  { server: false, default: () => null, immediate: isOrgWide.value },
)
const recheckBusy = ref(false)
async function recheck() {
  recheckBusy.value = true
  try {
    await $fetch('/api/v1/admin/diagnostics/governance-unresolved/recheck', { method: 'POST', body: {} })
    await refreshUnresolved()
  } finally {
    recheckBusy.value = false
  }
}

// ── Personal subscription declarations (design §4.3) ────────────────────────
// The only governance input a teammate creates for themselves, and it exempts
// the declared (teammate, tool) from chargeback. Until this card the only
// surface that listed one was the declaring teammate's own /account page — an
// exemption visible to nobody but its beneficiary is not a reviewable control.
// Read-only by design: 0105 says a declaration is only ever created by an
// explicit teammate action, and withdrawing one should work the same way.
interface PersonalSubscriptionDecl {
  id: string
  email: string
  displayName: string
  tool: string
  subscriptionType: string
  declaredMonthlyCostUsd: string
  declaredAt: string
  revokedAt: string | null
  activeAtMonthEnd: boolean
  usageUsd: string
  providerSpendUsd: string
}
interface PersonalSubscriptionsResp {
  month: string
  declarations: PersonalSubscriptionDecl[]
  totals: {
    effectiveCount: number
    activeAtMonthEndCount: number
    endedDuringMonthCount: number
    effectiveUsageUsd: string
    effectiveProviderSpendUsd: string
    providerBackedCount: number
  }
}
function currentMonthParam(): string {
  const d = new Date()
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`
}
const psMonth = ref(currentMonthParam())
const { data: personalSubs, error: psError, refresh: refreshPersonalSubs } = useLazyFetch<PersonalSubscriptionsResp | null>(
  '/api/v1/admin/governance/personal-subscriptions',
  { query: { month: psMonth }, server: false, default: () => null, immediate: isOrgWide.value },
)
function psUsd(v: string | undefined): string {
  if (v === undefined) return '—'
  return `$${Number(v).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

// ── Copilot rate plans + overage policy + historical bill re-pull (Workstream C) ─────
interface EnterpriseOption {
  id: string
  provider: 'anthropic' | 'github'
  externalId: string
  displayName: string
}
const { data: enterprisesData, error: enterprisesError, refresh: refreshEnterprises } = useLazyFetch<{ enterprises: EnterpriseOption[] } | null>(
  '/api/v1/admin/reconciliation/enterprises',
  { server: false, default: () => null, immediate: isOrgWide.value },
)
// Copilot money-model surfaces apply to github enterprises only (ADR-0011 D9/D10/D11 —
// GitHub is the Copilot billing unit; Anthropic is pure metered).
const githubEnterprises = computed(() => (enterprisesData.value?.enterprises ?? []).filter((e) => e.provider === 'github'))
const selectedEnterpriseId = ref('')

interface CopilotRatePlan {
  id: string
  validFrom: string
  validTo: string | null
  flatSeatPriceUsd: number | null
  includedAllowanceUsd: number | null
  notes: string | null
  retiredAt: string | null
}
/*
 * The rate-plan history owns its data/error/refresh like every other read (D1).
 * `null` until the read lands; a resolved `[]` is the real "no plan recorded"
 * answer, so the template never shows the empty row for an unloaded list (D2).
 * With no enterprise selected the handler resolves `null` without a request.
 * Nuxt keeps the previous `data` while a `watch`-triggered refetch is in
 * flight, so the payload carries the enterprise it was read for and
 * `ratePlans` is `null` (skeleton) whenever that is not the current selection —
 * the previous enterprise's plans are never shown under the new one.
 */
const {
  data: ratePlansData,
  error: ratePlansFetchError,
  refresh: refreshRatePlans,
} = useLazyAsyncData<{ enterpriseId: string; plans: CopilotRatePlan[] } | null>(
  'provider-governance-rate-plans',
  async () => {
    const enterpriseId = selectedEnterpriseId.value
    if (!enterpriseId) return null
    const { plans } = await $fetch<{ plans: CopilotRatePlan[] }>(
      `/api/v1/admin/reconciliation/enterprises/${enterpriseId}/copilot-rate-plans`,
    )
    return { enterpriseId, plans }
  },
  { server: false, default: () => null, immediate: isOrgWide.value, watch: [selectedEnterpriseId] },
)
const ratePlans = computed<CopilotRatePlan[] | null>(() =>
  ratePlansData.value?.enterpriseId === selectedEnterpriseId.value ? ratePlansData.value.plans : null,
)
const ratePlansBusy = ref(false)
const ratePlansError = ref<string | null>(null)

const newPlanValidFrom = ref('')
const newPlanFlat = ref('')
const newPlanAllowance = ref('')
const newPlanNotes = ref('')

async function createRatePlan() {
  if (!selectedEnterpriseId.value || !newPlanValidFrom.value) return
  ratePlansBusy.value = true
  ratePlansError.value = null
  try {
    // `refreshRatePlans()` re-reads `selectedEnterpriseId`, so the enterprise
    // select is disabled while `ratePlansBusy` (template): the history the
    // operator sees refreshed is always the enterprise that was written to.
    await $fetch(`/api/v1/admin/reconciliation/enterprises/${selectedEnterpriseId.value}/copilot-rate-plans`, {
      method: 'POST',
      body: {
        validFrom: newPlanValidFrom.value,
        flatSeatPriceUsd: newPlanFlat.value.trim() ? Number(newPlanFlat.value) : null,
        includedAllowanceUsd: newPlanAllowance.value.trim() ? Number(newPlanAllowance.value) : null,
        notes: newPlanNotes.value.trim() || null,
      },
    })
  } catch (e: unknown) {
    ratePlansError.value = apiErrorDetail(e, 'Failed to create rate plan')
    ratePlansBusy.value = false
    return
  }
  /*
   * PAST THIS LINE THE PLAN EXISTS. Clearing the form and reloading the history
   * are after-effects of a committed write, so they sit outside its catch — the
   * form is cleared because the create succeeded, and a read failure can never
   * render as "Failed to create rate plan". Nuxt's `refresh()` resolves on
   * failure (it reports into `ratePlansFetchError`, which the banner renders),
   * so this catch is the belt-and-braces path.
   */
  newPlanValidFrom.value = ''
  newPlanFlat.value = ''
  newPlanAllowance.value = ''
  newPlanNotes.value = ''
  try {
    await refreshRatePlans()
  } catch (e: unknown) {
    ratePlansError.value = apiErrorDetail(e, 'Rate plan created — but the history could not be reloaded. Reload the page to see it.')
  } finally {
    ratePlansBusy.value = false
  }
}

// Historical bill re-pull (design §5.4/§8.4) — an audited, bounded, one-month re-pull that
// refuses a CLOSED finance period outright (reopen/restate first).
const repullMonth = ref(lastCompleteMonth())
const repullReason = ref('')
const repullBusy = ref(false)
const repullError = ref<string | null>(null)
interface RepullResponse {
  month: string
  result: {
    orgRowsWritten: number
    residualRowsWritten: number
    overageAllocationsComputed: number
    overageAllocationsUnallocated: number
    enterprisesErrored: number
  }
}
const repullResult = ref<RepullResponse | null>(null)

/*
 * A rate-plan error, a re-pull error and a re-pull result all belong to the
 * enterprise they were produced for, and all three render inside the block
 * keyed on `selectedEnterpriseId`. Selecting another enterprise clears them —
 * the locked selector closes the in-flight window, this closes the one after it.
 */
watch(selectedEnterpriseId, () => {
  ratePlansError.value = null
  repullError.value = null
  repullResult.value = null
})

async function triggerRepull() {
  if (!selectedEnterpriseId.value || !repullReason.value.trim()) return
  repullBusy.value = true
  repullError.value = null
  repullResult.value = null
  try {
    repullResult.value = await $fetch<RepullResponse>(
      `/api/v1/admin/reconciliation/enterprises/${selectedEnterpriseId.value}/copilot-bill-repull`,
      { method: 'POST', body: { month: repullMonth.value, reason: repullReason.value.trim() } },
    )
    repullReason.value = ''
  } catch (e: unknown) {
    repullError.value = apiErrorDetail(e, 'Copilot bill re-pull failed')
  } finally {
    repullBusy.value = false
  }
}
</script>

<template>
  <div
    v-if="isOrgWide"
    class="max-w-[1600px] mx-auto px-10 py-8 pb-20"
    data-testid="admin-policy-provider-governance"
    data-admin-page="/admin/policies/provider-governance"
  >
    <UiPageHead
      eyebrow="Policies"
      title="Provider governance"
      sub="The move from GitHub heuristics to governance data, reporting snapshots, the unresolved backlog, personal subscription declarations and Copilot rate plans."
    />

    <UiCard data-testid="governance-cutover-card">
      <UiEyebrow>Governance cutover</UiEyebrow>
      <p class="text-sm text-carbon-2 mt-1">
        Before activation, GitHub chargeability is decided by the legacy name/env heuristic (unchanged, safe
        rollback). After activation, every money path reads <code class="text-[11px] bg-calm/40 px-1 rounded">billing</code>
        authoritatively and the heuristic is never consulted again.
      </p>
      <UiFetchErrorBanner :error="cutoverFetchError" label="the cutover state" class="mt-3" @retry="refreshCutover()" />
      <div class="mt-3 flex items-center gap-2">
        <span class="text-[12px] font-semibold text-carbon">Status:</span>
        <span
          v-if="!cutoverFetchError && cutover == null"
          class="inline-block h-5 w-24 rounded-full bg-calm-2 animate-pulse align-middle"
          role="status"
          aria-busy="true"
          data-testid="cutover-status-loading"
        ><span class="sr-only">Loading the cutover state…</span></span>
        <UiBadge v-else-if="cutover" :kind="cutoverBadgeKind" data-testid="cutover-status-badge">{{ cutover.status }}</UiBadge>
      </div>
      <div class="mt-4 flex flex-wrap gap-2">
        <!-- `activated` is the ONLY status the server refuses a preflight in
             (server/governance/cutover.ts:244 → 409 wrong-state). `rolled_back`
             is NOT terminal here: the state machine re-runs preflight from
             not_started / preflight_verified / rolled_back by design, so
             disabling it there would break the documented recovery path. -->
        <UiButton
          kind="secondary"
          size="sm"
          :disabled="cutoverBusy || cutover?.status === 'activated'"
          data-testid="run-preflight"
          @click="runPreflight"
        >
          Run preflight
        </UiButton>
        <UiButton
          kind="primary"
          size="sm"
          :disabled="cutoverBusy || cutover?.status !== 'preflight_verified'"
          data-testid="activate-governance"
          @click="activate"
        >
          Activate
        </UiButton>
        <p
          v-if="cutover?.status === 'activated'"
          class="text-[11px] text-carbon-3 basis-full"
          data-testid="preflight-blocked-note"
        >
          Preflight cannot run while governance is activated — roll back first.
        </p>
      </div>
      <div v-if="cutover?.status === 'activated'" class="mt-4 pt-4 border-t border-calm-2">
        <label for="rollback-reason" class="text-[12px] font-semibold text-carbon">Rollback reason</label>
        <textarea
          id="rollback-reason"
          v-model="rollbackReason"
          rows="2"
          class="mt-1 w-full px-3 py-2 text-sm border border-calm-2 rounded-md"
          data-testid="rollback-reason"
        />
        <UiButton
          kind="secondary"
          size="sm"
          class="mt-2"
          :disabled="cutoverBusy || !rollbackReason.trim()"
          data-testid="rollback-governance"
          @click="rollback"
        >
          Roll back
        </UiButton>
        <p class="text-[11px] text-carbon-3 mt-1">Only allowed before any month has been recorded under the new regime.</p>
      </div>
      <p v-if="cutoverError" class="text-xs text-rag-red mt-2" data-testid="cutover-error">{{ cutoverError }}</p>
    </UiCard>

    <UiCard class="mt-5" data-testid="finance-period-card">
      <UiEyebrow>Reporting snapshots</UiEyebrow>
      <p class="text-sm text-carbon-2 mt-1">
        Recording a month writes down what it read, and who recorded it. It does
        <strong>not</strong> lock anything — the provider corrects its rows and the bill
        lands after we report, so a recorded month still accepts both. What you get back
        is the movement since.
      </p>
      <div class="mt-3 flex items-center gap-2">
        <label for="period-month" class="text-[12px] font-semibold text-carbon">Month</label>
        <!-- Locked while a record is in flight: `closePeriod`'s reload re-reads
             this month, so letting it move mid-write would confirm a month the
             operator did not just record. -->
        <input
          id="period-month"
          v-model="periodMonth"
          type="month"
          :disabled="periodBusy"
          class="border border-calm-2 rounded-md px-2 py-1.5 text-sm disabled:bg-calm-2 disabled:text-carbon-3"
          data-testid="period-month"
        >
        <span
          v-if="!periodFetchError && periodData == null"
          class="inline-block h-5 w-24 rounded-full bg-calm-2 animate-pulse align-middle"
          role="status"
          aria-busy="true"
          data-testid="period-state-loading"
        ><span class="sr-only">Loading the snapshot…</span></span>
        <UiBadge v-else-if="!periodFetchError" :kind="period ? 'rag-green' : 'neutral'" data-testid="period-state-badge">
          {{ period ? 'recorded' : 'not recorded' }}
        </UiBadge>
        <span v-if="periodPending && periodData != null" class="text-[11px] text-carbon-3 italic" aria-busy="true">refreshing…</span>
      </div>
      <UiFetchErrorBanner :error="periodFetchError" label="the reporting snapshot" class="mt-3" @retry="loadPeriod()" />

      <div v-if="period" class="mt-3 text-[12px] text-carbon" data-testid="period-delta">
        <!-- Version 0 = closed under the old machinery, which stored a state and
             no figures. Rendering its zero defaults as "attributed $0.00" would
             be a fabricated number rather than a missing one. -->
        <p v-if="period.snapshotVersion === 0">
          Recorded {{ new Date(period.closedAt).toLocaleString() }} — figures not
          recorded (closed before this system captured them).
        </p>
        <p v-else>
          Recorded {{ new Date(period.closedAt).toLocaleString() }} —
          attributed {{ money(period.snapshot.attributedUsd) }} ·
          chargeable {{ money(period.snapshot.chargeableUsd) }}
        </p>
        <!-- The reason the snapshot exists. A month that has not moved says so;
             one that has says by how much, and one that cannot be compared says
             why instead of showing a difference that is not movement. -->
        <p v-if="period.incomparableReason" class="mt-1 text-rag-amber">
          Not comparable ({{ period.incomparableReason }}) — the month now reads
          {{ money(period.current.chargeableUsd) }} chargeable, but the difference is what
          changing how we count costs, not money moving.
        </p>
        <p v-else-if="period.chargeableUnchanged && !period.attributedMoved" class="mt-1 text-carbon-3">
          Unchanged since it was recorded.
        </p>
        <p v-else class="mt-1 text-rag-amber">
          Moved since recording — chargeable {{ money(period.deltaUsd?.chargeable ?? 0) }},
          exempt {{ money(period.deltaUsd?.exempt ?? 0) }},
          attributed {{ money(period.deltaUsd?.attributed ?? 0) }}.
        </p>
      </div>

      <div class="mt-4 flex flex-wrap items-end gap-2">
        <UiButton
          kind="primary"
          size="sm"
          :disabled="periodBusy || !!period || periodData == null"
          data-testid="close-period"
          @click="closePeriod"
        >
          Record this month
        </UiButton>
        <p v-if="period" class="text-[11px] text-carbon-3">
          Already recorded. A month is recorded once — re-recording would overwrite
          what was reported.
        </p>
      </div>
      <p v-if="periodError" class="text-xs text-rag-red mt-2" data-testid="period-error">{{ periodError }}</p>
    </UiCard>

    <UiCard class="mt-5" data-testid="governance-unresolved-card">
      <UiEyebrow>Governance-unresolved</UiEyebrow>
      <p class="text-sm text-carbon-2 mt-1">
        Money rows whose provider org/enterprise could not be resolved. Always showback-visible; never chargeable
        while unresolved. Register or link the missing org, then recheck.
      </p>
      <AdminPageSkeleton v-if="!unresolvedError && unresolved == null" :rows="2" :toolbar="false" class="mt-3" />
      <UiFetchErrorBanner v-else-if="unresolvedError" :error="unresolvedError" label="the governance-unresolved counts" class="mt-3" @retry="refreshUnresolved()" />
      <div v-else-if="unresolved?.reachable" class="mt-3 grid grid-cols-3 gap-4 text-sm">
        <div>
          <p class="text-[11px] uppercase text-carbon-3">Provider spend</p>
          <p class="font-mono">{{ unresolved.actualSpend?.pendingBackfill ?? 0 }} pending / {{ unresolved.actualSpend?.parkedUnresolved ?? 0 }} parked</p>
        </div>
        <div>
          <p class="text-[11px] uppercase text-carbon-3">Reconciliation records</p>
          <p class="font-mono">{{ unresolved.reconciliationRecord?.pendingBackfill ?? 0 }} pending / {{ unresolved.reconciliationRecord?.parkedUnresolved ?? 0 }} parked</p>
        </div>
        <div>
          <p class="text-[11px] uppercase text-carbon-3">Pending placements</p>
          <p class="font-mono">{{ unresolved.pendingPlacement?.unresolved ?? 0 }} unresolved</p>
        </div>
      </div>
      <ul v-if="unresolved?.bySource?.length" class="mt-3 divide-y divide-calm-2" data-testid="unresolved-by-source">
        <li v-for="s in unresolved.bySource" :key="s.source" class="py-1.5 flex justify-between text-[12px]">
          <code class="bg-calm/40 px-1 rounded">{{ s.source }}</code>
          <span>{{ s.count }} rows · ${{ s.costUsd }}</span>
        </li>
      </ul>
      <UiButton kind="secondary" size="sm" class="mt-3" :disabled="recheckBusy" data-testid="recheck-unresolved" @click="recheck">
        Recheck now
      </UiButton>
    </UiCard>

    <!--
      Personal subscription declarations. Read-only on purpose — there is no
      admin revoke, because a declaration is a teammate's own statement and
      withdrawing it should be too. An admin who thinks one is wrong has a
      conversation; a button here would make it silently revocable, which is
      the failure this card exists to fix.
    -->
    <UiCard class="mt-5" data-testid="personal-subscriptions-card">
      <div class="flex items-start justify-between gap-4">
        <div>
          <UiEyebrow>Personal subscription declarations</UiEyebrow>
          <p class="text-sm text-carbon-2 mt-1">
            Teammate-declared personal subscriptions suppress only the no-bill usage signal. They never alter
            provider-backed chargeback, which remains controlled by provider billing settings. Self-declared and
            audited — this is where they are reviewable.
          </p>
        </div>
        <input
          v-model="psMonth"
          type="month"
          class="text-xs border border-calm-2 rounded px-2 py-1"
          data-testid="ps-month"
        >
      </div>

      <AdminPageSkeleton v-if="!psError && personalSubs == null" :rows="3" :toolbar="false" class="mt-3" />
      <UiFetchErrorBanner v-else-if="psError" :error="psError" label="personal subscription declarations" class="mt-3" @retry="refreshPersonalSubs()" />
      <template v-else-if="personalSubs">
        <div class="mt-3 grid grid-cols-3 gap-4 text-sm">
          <div>
            <p class="text-[11px] uppercase text-carbon-3">Effective in month</p>
            <p class="font-mono" data-testid="ps-effective-count">{{ personalSubs.totals.effectiveCount }}</p>
          </div>
          <div>
            <p class="text-[11px] uppercase text-carbon-3">Usage vouched for</p>
            <p class="font-mono" data-testid="ps-effective-usage">{{ psUsd(personalSubs.totals.effectiveUsageUsd) }}</p>
          </div>
          <div>
            <p class="text-[11px] uppercase text-carbon-3">With provider spend</p>
            <p
              class="font-mono"
              data-testid="ps-provider-backed"
            >
              {{ personalSubs.totals.providerBackedCount }}
            </p>
          </div>
        </div>

        <p
          v-if="personalSubs.totals.providerBackedCount > 0"
          class="text-xs text-carbon-2 mt-2"
          data-testid="ps-provider-backed-note"
        >
          {{ psUsd(personalSubs.totals.effectiveProviderSpendUsd) }} of provider spend sits against a tool
          also declared as personally funded. This may be legitimate mixed funding or an inaccurate declaration.
          Provider billing remains authoritative either way.
        </p>

        <table v-if="personalSubs.declarations.length" class="w-full mt-3 text-[12px]" data-testid="ps-table">
          <thead>
            <tr class="text-carbon-3 text-left">
              <th class="py-1 pr-3 font-medium">Teammate</th>
              <th class="py-1 pr-3 font-medium">Tool</th>
              <th class="py-1 pr-3 font-medium">Subscription</th>
              <th class="py-1 pr-3 font-medium text-right">Declared cost</th>
              <th class="py-1 pr-3 font-medium text-right">Usage</th>
              <th class="py-1 pr-3 font-medium text-right">Provider spend</th>
              <th class="py-1 font-medium">State</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="d in personalSubs.declarations"
              :key="d.id"
              class="border-t border-calm-2"
              :class="d.activeAtMonthEnd ? '' : 'text-carbon-3'"
            >
              <td class="py-1 pr-3">{{ d.email }}</td>
              <td class="py-1 pr-3"><code class="bg-calm/40 px-1 rounded">{{ d.tool }}</code></td>
              <td class="py-1 pr-3">{{ d.subscriptionType }}</td>
              <td class="py-1 pr-3 text-right font-mono">{{ psUsd(d.declaredMonthlyCostUsd) }}</td>
              <td class="py-1 pr-3 text-right font-mono">{{ psUsd(d.usageUsd) }}</td>
              <td
                class="py-1 pr-3 text-right font-mono"
              >
                {{ psUsd(d.providerSpendUsd) }}
              </td>
              <td class="py-1">
                <UiBadge :kind="d.activeAtMonthEnd ? 'rag-green' : 'neutral'">
                  {{ d.activeAtMonthEnd ? 'active at month end' : 'ended during month' }}
                </UiBadge>
              </td>
            </tr>
          </tbody>
        </table>
        <p v-else class="text-sm text-carbon-3 mt-3" data-testid="ps-empty">
          No personal subscriptions were effective in this month.
        </p>
      </template>
    </UiCard>

    <UiCard class="mt-5" data-testid="copilot-money-model-card">
      <UiEyebrow>Copilot rate plans &amp; overage allocation</UiEyebrow>
      <p class="text-sm text-carbon-2 mt-1">
        Effective-dated seat price and included allowance, and the pooled-overage
        allocation policy — <strong>forecast/showback and distribution inputs only</strong>.
        The reconciled enterprise bill net is always the authoritative cost of record; a rate-plan
        change never re-costs a closed month, and allocation only redistributes the overage
        already on the bill.
      </p>

      <UiFetchErrorBanner :error="enterprisesError" label="the enterprise list" class="mt-3" @retry="refreshEnterprises()" />
      <div class="mt-3">
        <label for="copilot-ent-select" class="text-[12px] font-semibold text-carbon">GitHub enterprise</label>
        <!-- Locked while a rate-plan create or a bill re-pull is in flight: both
             capture this enterprise, and both report their outcome (refreshed
             history / re-pull counts) under whatever is selected when they land. -->
        <select
          id="copilot-ent-select"
          v-model="selectedEnterpriseId"
          :disabled="ratePlansBusy || repullBusy"
          class="mt-1 w-full px-3 py-2 text-sm border border-calm-2 rounded-md bg-white focus:border-brand-harmony disabled:bg-calm-2 disabled:text-carbon-3"
          data-testid="copilot-ent-select"
        >
          <option value="">Select an enterprise…</option>
          <option v-for="e in githubEnterprises" :key="e.id" :value="e.id">{{ e.displayName }} ({{ e.externalId }})</option>
        </select>
        <p class="text-[11px] text-carbon-3 mt-1">
          Set the allocation policy itself, and the current scalar forecast figures, from the
          enterprise's edit dialog on the Reconciliation page — this panel manages effective-dated
          history and the historical re-pull.
        </p>
      </div>

      <div v-if="selectedEnterpriseId" class="mt-4 pt-4 border-t border-calm-2">
        <p class="text-[12px] font-bold uppercase tracking-[1.2px] text-brand-harmony">Rate-plan history</p>
        <AdminPageSkeleton v-if="!ratePlansFetchError && ratePlans == null" :rows="3" :toolbar="false" class="mt-2" />
        <UiFetchErrorBanner v-else-if="ratePlansFetchError" :error="ratePlansFetchError" label="the rate-plan history" class="mt-2" @retry="refreshRatePlans()" />
        <table v-else class="w-full mt-2 text-[12px]" data-testid="rate-plan-history">
          <thead>
            <tr class="text-left text-carbon-3">
              <th class="font-semibold pb-1">Effective from</th>
              <th class="font-semibold pb-1">Effective to</th>
              <th class="font-semibold pb-1">Flat seat</th>
              <th class="font-semibold pb-1">Allowance</th>
              <th class="font-semibold pb-1">Status</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="p in ratePlans" :key="p.id" class="border-t border-calm-2">
              <td class="py-1 font-mono">{{ p.validFrom }}</td>
              <td class="py-1 font-mono">{{ p.validTo ?? 'open-ended' }}</td>
              <td class="py-1">{{ p.flatSeatPriceUsd != null ? `$${p.flatSeatPriceUsd}` : '—' }}</td>
              <td class="py-1">{{ p.includedAllowanceUsd != null ? `$${p.includedAllowanceUsd}` : '—' }}</td>
              <td class="py-1">{{ p.retiredAt ? 'retired' : 'live' }}</td>
            </tr>
            <tr v-if="ratePlans?.length === 0"><td colspan="5" class="py-2 text-carbon-3">No rate plan recorded yet.</td></tr>
          </tbody>
        </table>

        <p class="text-[12px] font-bold uppercase tracking-[1.2px] text-brand-harmony mt-4">New rate plan</p>
        <div class="grid grid-cols-2 gap-3 mt-2">
          <div>
            <label for="rp-valid-from" class="text-[12px] font-semibold text-carbon">Effective from</label>
            <input id="rp-valid-from" v-model="newPlanValidFrom" type="date" class="mt-1 w-full px-3 py-2 text-sm border border-calm-2 rounded-md" data-testid="rp-valid-from">
          </div>
          <div />
          <div>
            <label for="rp-flat" class="text-[12px] font-semibold text-carbon">Flat seat price (USD)</label>
            <input id="rp-flat" v-model="newPlanFlat" type="number" min="0" step="0.01" class="mt-1 w-full px-3 py-2 text-sm border border-calm-2 rounded-md" data-testid="rp-flat">
          </div>
          <div>
            <label for="rp-allowance" class="text-[12px] font-semibold text-carbon">Included allowance (USD)</label>
            <input id="rp-allowance" v-model="newPlanAllowance" type="number" min="0" step="0.01" class="mt-1 w-full px-3 py-2 text-sm border border-calm-2 rounded-md" data-testid="rp-allowance">
          </div>
        </div>
        <input v-model="newPlanNotes" type="text" placeholder="Notes (optional)" class="mt-2 w-full px-3 py-2 text-sm border border-calm-2 rounded-md" data-testid="rp-notes">
        <UiButton kind="primary" size="sm" class="mt-2" :disabled="ratePlansBusy || !newPlanValidFrom" data-testid="rp-create" @click="createRatePlan">
          Add rate plan
        </UiButton>
        <p v-if="ratePlansError" class="text-xs text-rag-red mt-2" data-testid="rate-plan-error">{{ ratePlansError }}</p>

        <div class="mt-5 pt-4 border-t border-calm-2">
          <p class="text-[12px] font-bold uppercase tracking-[1.2px] text-brand-harmony">Historical bill re-pull</p>
          <p class="text-[12px] text-carbon-2 mt-1">
            Re-pull the Copilot pooled bill straight from GitHub for one explicit month and recompute
            its overage allocation. The allocation splits the overage by the Business Unit each person
            sits in when it is computed: the current and previous month follow a restructure on the
            next scheduled run, and an older month keeps its split until you re-pull it here.
          </p>
          <div class="mt-2 flex flex-wrap items-end gap-2">
            <div>
              <label for="repull-month" class="text-[12px] font-semibold text-carbon">Month</label>
              <input id="repull-month" v-model="repullMonth" type="month" class="mt-1 border border-calm-2 rounded-md px-2 py-1.5 text-sm" data-testid="repull-month">
            </div>
            <div class="flex-1 min-w-[14rem]">
              <label for="repull-reason" class="text-[12px] font-semibold text-carbon">Reason</label>
              <input id="repull-reason" v-model="repullReason" type="text" placeholder="Why this month is being re-pulled" class="mt-1 w-full border border-calm-2 rounded-md px-2 py-2 text-sm" data-testid="repull-reason">
            </div>
            <UiButton kind="secondary" size="sm" :disabled="repullBusy || !repullReason.trim()" data-testid="trigger-repull" @click="triggerRepull">
              Re-pull bill
            </UiButton>
          </div>
          <p v-if="repullError" class="text-xs text-rag-red mt-2" data-testid="repull-error">{{ repullError }}</p>
          <p v-if="repullResult" class="text-[12px] text-carbon-2 mt-2" data-testid="repull-result">
            {{ repullResult.month }}: {{ repullResult.result.orgRowsWritten }} org row(s),
            {{ repullResult.result.residualRowsWritten }} residual row(s),
            {{ repullResult.result.overageAllocationsComputed }} allocation(s) recomputed
            ({{ repullResult.result.overageAllocationsUnallocated }} unallocated).
          </p>
        </div>
      </div>
    </UiCard>
  </div>
  <div v-else class="max-w-[1600px] mx-auto px-10 py-16 text-center" data-admin-page="/admin/policies/provider-governance">
    <div class="text-lg font-bold text-carbon">Admin access required.</div>
  </div>
</template>
