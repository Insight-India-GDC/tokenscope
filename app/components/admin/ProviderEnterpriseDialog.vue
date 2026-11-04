<script setup lang="ts">
/*
 * ProviderEnterpriseDialog — create OR edit a provider_enterprise (the
 * credential-custody / onboarding unit above provider_org). GitHub holds one
 * manage_billing PAT per enterprise here; Anthropic's per-org key stays on the
 * org, but an Anthropic enterprise can still be registered as a grouping parent.
 *
 * One dialog, two modes:
 *   - create (target === null && open)      → POST   .../enterprises
 *   - edit   (target is an existing row)     → PATCH  .../enterprises/{id}
 * In edit mode `provider` is IMMUTABLE (it flips the credential env-prefix and the
 * api_kind relationship of linked orgs — the server rejects a provider change), so
 * the select is shown read-only.
 *
 * external_id is stored LOWERCASE (mig 0062): an anthropic org id is case-
 * insensitive (auto-lowercased server-side), but a github SLUG must already be
 * lowercase — we hint it and the server rejects a mixed-case slug loudly.
 *
 * Server validation (400/409) is surfaced inline; the key value is NEVER sent back
 * to us — only a presence flag in the list. A11y mirrors SetBudgetDialog /
 * AddTeammateDialog (role=dialog, aria-modal, Escape, focus-trap, first-field focus).
 */
import { ref, computed, watch, type Ref } from 'vue'
import { consola } from 'consola'
import UiButton from '../ui/Button.vue'
import { useModalA11y } from '../../composables/useModalA11y'
import { apiErrorDetail } from '../../composables/useApiError'

export interface EnterpriseEditTarget {
  id: string
  provider: 'anthropic' | 'github'
  externalId: string
  displayName: string
  reconciliationMode: string
  billing: string
  credentialSecretName: string | null
  /* ADR-0010 D1/D2 — Copilot billing structure (GitHub only). null = unset.
   * FORECAST/SHOWBACK reference only — see the "Copilot billing" section copy below. */
  flatSeatPriceUsd: number | null
  includedAllowanceUsd: number | null
  /* ADR-0011 D10 — configurable per-enterprise pooled-overage allocation policy. */
  overageAllocationPolicy: string
  /** GitHub App id (mig 0078). Non-null = App credential path opted in. */
  githubAppId: string | null
}

const props = defineProps<{
  /* When null the dialog is in CREATE mode; a target puts it in EDIT mode. */
  target: EnterpriseEditTarget | null
  /* Drives open-state independently of target so CREATE (target=null) can open. */
  open: boolean
}>()
const emit = defineEmits<{ close: []; saved: [] }>()

const CRED_RE = /^[a-z0-9-]{3,64}$/
const APP_ID_RE = /^\d+$/

const provider = ref<'anthropic' | 'github'>('github')
const externalId = ref('')
const displayName = ref('')
const reconciliationMode = ref<'reconciled' | 'indicative'>('indicative')
const billing = ref<'billed' | 'tracked'>('tracked')
const credentialSecretName = ref('')
// ADR-0010 D1/D2 — Copilot billing structure (GitHub only). Strings so an empty
// field cleanly means "unset / disabled" (vs 0, which means "free"). FORECAST/
// SHOWBACK reference only (see the section copy below) — never the bill-net source.
const flatSeatPriceUsd = ref('')
const includedAllowanceUsd = ref('')
// ADR-0011 D10 — configurable per-enterprise pooled-overage allocation policy.
// consumption-share is Insight's default.
const overageAllocationPolicy = ref<'consumption-share' | 'excess-share' | 'excess-equal' | 'seat-share'>('consumption-share')
// GitHub App id (mig 0078) — opt into the App credential path. Empty = PAT mode (the
// default). github-only (the field is hidden for anthropic).
const githubAppId = ref('')
const saving = ref(false)
const error = ref<string | null>(null)

const firstField = ref<HTMLElement | null>(null)
const dialogEl = ref<HTMLElement | null>(null)
const titleId = 'provider-enterprise-title'

const isEdit = computed(() => props.target !== null)

useModalA11y({
  isOpen: () => props.open,
  dialogEl,
  firstField: firstField as Ref<HTMLElement | null>,
  onClose: () => emit('close'),
  onOpen: () => {
    const t = props.target
    provider.value = t?.provider ?? 'github'
    externalId.value = t?.externalId ?? ''
    displayName.value = t?.displayName ?? ''
    reconciliationMode.value = (t?.reconciliationMode as 'reconciled' | 'indicative') ?? 'indicative'
    billing.value = (t?.billing as 'billed' | 'tracked') ?? 'tracked'
    credentialSecretName.value = t?.credentialSecretName ?? ''
    flatSeatPriceUsd.value = t?.flatSeatPriceUsd != null ? String(t.flatSeatPriceUsd) : ''
    includedAllowanceUsd.value = t?.includedAllowanceUsd != null ? String(t.includedAllowanceUsd) : ''
    overageAllocationPolicy.value =
      (t?.overageAllocationPolicy as 'consumption-share' | 'excess-share' | 'excess-equal' | 'seat-share') ?? 'consumption-share'
    githubAppId.value = t?.githubAppId ?? ''
    error.value = null
  },
})

// Copilot billing fields apply to GitHub only (Anthropic Claude is pure metered —
// no flat seat, no allowance). Hidden for anthropic so the form can't set nonsense.
const showCopilotBilling = computed(() => provider.value === 'github')

// A money field is valid when blank (= unset) OR a finite number >= 0. Coerce to string
// first — a <input type="number"> v-model can hand back a number, not a string.
function moneyInvalid(v: string | number): boolean {
  const t = String(v ?? '').trim()
  if (t === '') return false
  const n = Number(t)
  return !Number.isFinite(n) || n < 0
}
const flatInvalid = computed(() => showCopilotBilling.value && moneyInvalid(flatSeatPriceUsd.value))
const allowanceInvalid = computed(() => showCopilotBilling.value && moneyInvalid(includedAllowanceUsd.value))
// null when blank; the numeric value otherwise.
function moneyOrNull(v: string | number): number | null {
  const t = String(v ?? '').trim()
  return t === '' ? null : Number(t)
}

// github slugs are lowercase-only (the slug is part of the credential lane key).
const githubSlugWarn = computed(
  () =>
    provider.value === 'github' &&
    externalId.value.length > 0 &&
    externalId.value !== externalId.value.toLowerCase(),
)
const credInvalid = computed(
  () => credentialSecretName.value.length > 0 && !CRED_RE.test(credentialSecretName.value),
)
// App id: github-only, digits only. (anthropic never sends it — the field is hidden.)
const appIdInvalid = computed(
  () => provider.value === 'github' && githubAppId.value.trim().length > 0 && !APP_ID_RE.test(githubAppId.value.trim()),
)

const canSubmit = computed(() => {
  if (saving.value) return false
  if (!externalId.value.trim() || !displayName.value.trim()) return false
  if (githubSlugWarn.value) return false
  if (credInvalid.value) return false
  if (flatInvalid.value || allowanceInvalid.value) return false
  if (appIdInvalid.value) return false
  return true
})

// Re-validate as the user types so a stale server error clears.
watch(
  [
    externalId,
    displayName,
    credentialSecretName,
    githubAppId,
    reconciliationMode,
    billing,
    flatSeatPriceUsd,
    includedAllowanceUsd,
    overageAllocationPolicy,
  ],
  () => {
    if (error.value) error.value = null
  },
)

async function save() {
  if (!canSubmit.value) return
  saving.value = true
  error.value = null
  const cred = credentialSecretName.value.trim() ? credentialSecretName.value.trim() : null
  // Copilot billing applies to GitHub only; null for anthropic (clears any stray value).
  const flat = showCopilotBilling.value ? moneyOrNull(flatSeatPriceUsd.value) : null
  const allowance = showCopilotBilling.value ? moneyOrNull(includedAllowanceUsd.value) : null
  // App id only for github; empty → null (PAT mode / clears App mode on PATCH).
  const appId =
    provider.value === 'github' && githubAppId.value.trim() ? githubAppId.value.trim() : null
  try {
    if (isEdit.value && props.target) {
      // PATCH: provider is immutable — send only the mutable fields. githubAppId is sent
      // explicitly (null clears App mode) so toggling App↔PAT is a first-class edit.
      await $fetch(`/api/v1/admin/reconciliation/enterprises/${props.target.id}`, {
        method: 'PATCH',
        body: {
          externalId: externalId.value.trim(),
          displayName: displayName.value.trim(),
          reconciliationMode: reconciliationMode.value,
          billing: billing.value,
          credentialSecretName: cred,
          flatSeatPriceUsd: flat,
          includedAllowanceUsd: allowance,
          overageAllocationPolicy: showCopilotBilling.value ? overageAllocationPolicy.value : undefined,
          githubAppId: appId,
        },
      })
    } else {
      await $fetch('/api/v1/admin/reconciliation/enterprises', {
        method: 'POST',
        body: {
          provider: provider.value,
          externalId: externalId.value.trim(),
          displayName: displayName.value.trim(),
          reconciliationMode: reconciliationMode.value,
          billing: billing.value,
          credentialSecretName: cred,
          flatSeatPriceUsd: flat,
          includedAllowanceUsd: allowance,
          overageAllocationPolicy: showCopilotBilling.value ? overageAllocationPolicy.value : undefined,
          githubAppId: appId,
        },
      })
    }
    emit('saved')
  } catch (e: unknown) {
    error.value = apiErrorDetail(e, isEdit.value ? 'Enterprise update failed.' : 'Enterprise creation failed.')
    consola.warn('provider-enterprise save failed', e)
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <div
    v-if="open"
    class="fixed inset-0 z-50 flex items-center justify-center bg-carbon/40 p-4"
    data-testid="provider-enterprise-dialog"
    @click.self="emit('close')"
  >
    <div
      ref="dialogEl"
      class="w-full max-w-lg bg-white rounded-xl shadow-xl max-h-[90vh] overflow-y-auto"
      role="dialog"
      aria-modal="true"
      :aria-labelledby="titleId"
    >
      <div class="px-6 py-4 border-b border-calm-2 flex items-start justify-between gap-4">
        <div>
          <p class="text-xs font-bold uppercase tracking-[1.4px] text-brand-harmony">
            {{ isEdit ? 'Edit enterprise' : 'New enterprise' }}
          </p>
          <h2 :id="titleId" class="text-lg font-bold text-carbon mt-0.5">
            {{ isEdit ? displayName || 'Enterprise' : 'Register a provider enterprise' }}
          </h2>
        </div>
        <UiButton kind="ghost" size="sm" data-testid="provider-enterprise-close" @click="emit('close')">Close</UiButton>
      </div>

      <div class="px-6 py-4">
        <p class="text-[12px] text-carbon-2 mb-3">
          The credential-custody unit above orgs. GitHub holds one billing PAT per enterprise here;
          Anthropic's per-org key stays on the org.
        </p>

        <div class="grid grid-cols-2 gap-3">
          <div>
            <label for="pe-provider" class="text-[12px] font-semibold text-carbon">Provider</label>
            <select
              id="pe-provider"
              ref="firstField"
              v-model="provider"
              :disabled="isEdit"
              class="mt-1 w-full px-3 py-2 text-sm border border-calm-2 rounded-md bg-white focus:border-brand-harmony disabled:bg-calm/30"
              data-testid="pe-provider"
            >
              <option value="github">github</option>
              <option value="anthropic">anthropic</option>
            </select>
            <p v-if="isEdit" class="text-[11px] text-carbon-3 mt-1">Provider can't change after creation.</p>
          </div>
          <div>
            <label for="pe-external-id" class="text-[12px] font-semibold text-carbon">
              External id <span class="text-carbon-3 font-normal">({{ provider === 'github' ? 'slug, lowercase' : 'org id' }})</span>
            </label>
            <input
              id="pe-external-id"
              v-model="externalId"
              type="text"
              :placeholder="provider === 'github' ? 'acme-corp' : 'org-abc123'"
              class="mt-1 w-full px-3 py-2 text-sm border border-calm-2 rounded-md font-mono focus:border-brand-harmony"
              data-testid="pe-external-id"
            >
            <p v-if="githubSlugWarn" class="text-[11px] text-rag-red mt-1" data-testid="pe-slug-warn">
              GitHub slugs must be lowercase.
            </p>
          </div>
        </div>

        <div class="mt-3">
          <label for="pe-display-name" class="text-[12px] font-semibold text-carbon">Display name</label>
          <input
            id="pe-display-name"
            v-model="displayName"
            type="text"
            placeholder="Acme Corp (GitHub Enterprise)"
            class="mt-1 w-full px-3 py-2 text-sm border border-calm-2 rounded-md focus:border-brand-harmony"
            data-testid="pe-display-name"
          >
        </div>

        <div class="grid grid-cols-2 gap-3 mt-3">
          <div>
            <label for="pe-mode" class="text-[12px] font-semibold text-carbon">Reconciliation mode</label>
            <select
              id="pe-mode"
              v-model="reconciliationMode"
              class="mt-1 w-full px-3 py-2 text-sm border border-calm-2 rounded-md bg-white focus:border-brand-harmony"
              data-testid="pe-mode"
            >
              <option value="indicative">indicative</option>
              <option value="reconciled">reconciled</option>
            </select>
          </div>
          <div>
            <label for="pe-billing" class="text-[12px] font-semibold text-carbon">Billing</label>
            <select
              id="pe-billing"
              v-model="billing"
              class="mt-1 w-full px-3 py-2 text-sm border border-calm-2 rounded-md bg-white focus:border-brand-harmony"
              data-testid="pe-billing"
            >
              <option value="tracked">tracked</option>
              <option value="billed">billed</option>
            </select>
            <p v-if="provider === 'github'" class="text-[11px] text-carbon-3 mt-1" data-testid="pe-billing-authoritative-note">
              The authoritative chargeability setting for every org under this enterprise — GitHub bills the
              enterprise, not the org.
            </p>
          </div>
        </div>

        <div class="mt-3">
          <label for="pe-cred" class="text-[12px] font-semibold text-carbon">
            Credential secret name <span class="text-carbon-3 font-normal">(optional)</span>
          </label>
          <input
            id="pe-cred"
            v-model="credentialSecretName"
            type="text"
            placeholder="acme-github-pat"
            class="mt-1 w-full px-3 py-2 text-sm border border-calm-2 rounded-md font-mono focus:border-brand-harmony"
            data-testid="pe-cred"
          >
          <p class="text-[11px] text-carbon-3 mt-1">
            Names the env var that holds the key (never the key itself). Lowercase, digits, hyphen — 3–64 chars.
          </p>
          <p v-if="credInvalid" class="text-[11px] text-rag-red mt-1" data-testid="pe-cred-warn">
            Must match ^[a-z0-9-]{3,64}$.
          </p>
        </div>

        <!-- GitHub App credential opt-in (mig 0078). github-only. Non-empty = App mode:
             the credential secret name then points at the App PRIVATE KEY env
             (NUXT_GITHUB_APP_KEY_<NAME>, base64 PEM) instead of a PAT. Empty = PAT mode. -->
        <div v-if="provider === 'github'" class="mt-3">
          <label for="pe-app-id" class="text-[12px] font-semibold text-carbon">
            GitHub App id <span class="text-carbon-3 font-normal">(optional — opts into App auth)</span>
          </label>
          <input
            id="pe-app-id"
            v-model="githubAppId"
            type="text"
            inputmode="numeric"
            placeholder="1234567"
            class="mt-1 w-full px-3 py-2 text-sm border border-calm-2 rounded-md font-mono focus:border-brand-harmony"
            data-testid="pe-app-id"
          >
          <p class="text-[11px] text-carbon-3 mt-1">
            Set this to authenticate Copilot reads via a GitHub App (installation tokens) instead of a classic PAT.
            The credential secret name then holds the App private key (base64 PEM) under <code>NUXT_GITHUB_APP_KEY_…</code>.
            Leave blank to use the classic PAT path.
          </p>
          <p v-if="appIdInvalid" class="text-[11px] text-rag-red mt-1" data-testid="pe-app-id-warn">
            Must be a positive integer (the GitHub App id).
          </p>
        </div>

        <!-- ADR-0011 D6/D8/D9/D10: GitHub Copilot billing structure. GitHub only — Claude/
             Anthropic is pure metered (no flat seat, no allowance), so this section is hidden
             there. -->
        <div v-if="showCopilotBilling" class="mt-5 pt-4 border-t border-calm-2" data-testid="pe-copilot-billing">
          <p class="text-[12px] font-bold uppercase tracking-[1.2px] text-brand-harmony">Copilot billing</p>
          <p class="text-[12px] text-carbon-2 mt-1">
            Copilot's AI-credit allowance <strong>pools at the ORG level</strong> — an individual exceeding
            their own share costs nothing while the pool holds; overage only accrues once the whole org's
            pool is exhausted. The figures below are a <strong>forecast / showback
            reference only</strong> — they drive the projected per-seat display and never reconstruct a
            charge. The <strong>actual bill net</strong> (read straight from the enterprise billing usage
            report) is always the authoritative cost of record, for both the seat licence and any overage.
          </p>
          <p class="text-[12px] text-carbon-2 mt-2">
            These are the <strong>current</strong> values. Rates are effective-dated: a change
            here does not itself re-cost a closed month. Manage dated rate-plan history — including future
            scheduled changes — from this enterprise's row action on
            <strong>Policies → Provider governance</strong>.
          </p>

          <div class="grid grid-cols-2 gap-3 mt-3">
            <div>
              <label for="pe-flat" class="text-[12px] font-semibold text-carbon">Flat seat price (USD / month)</label>
              <input
                id="pe-flat"
                v-model="flatSeatPriceUsd"
                type="number"
                min="0"
                step="0.01"
                inputmode="decimal"
                placeholder="e.g. 39"
                class="mt-1 w-full px-3 py-2 text-sm border border-calm-2 rounded-md focus:border-brand-harmony"
                data-testid="pe-flat"
              >
              <p class="text-[11px] text-carbon-3 mt-1">Per seat, whole month — a seat active any day owes the full price. Forecast reference; the bill's own SKU net is what's actually charged.</p>
              <p v-if="flatInvalid" class="text-[11px] text-rag-red mt-1" data-testid="pe-flat-warn">Enter a number ≥ 0, or leave blank.</p>
            </div>
            <div>
              <label for="pe-allowance" class="text-[12px] font-semibold text-carbon">Included allowance (USD / org pool)</label>
              <input
                id="pe-allowance"
                v-model="includedAllowanceUsd"
                type="number"
                min="0"
                step="0.01"
                inputmode="decimal"
                placeholder="e.g. 70"
                class="mt-1 w-full px-3 py-2 text-sm border border-calm-2 rounded-md focus:border-brand-harmony"
                data-testid="pe-allowance"
              >
              <p class="text-[11px] text-carbon-3 mt-1">Per-seat contribution to the ORG pool — not a per-user cap. Overage accrues only once the pool (seats × allowance) is exhausted.</p>
              <p v-if="allowanceInvalid" class="text-[11px] text-rag-red mt-1" data-testid="pe-allowance-warn">Enter a number ≥ 0, or leave blank.</p>
            </div>
          </div>

          <div class="mt-3">
            <label for="pe-overage-policy" class="text-[12px] font-semibold text-carbon">Overage allocation policy</label>
            <select
              id="pe-overage-policy"
              v-model="overageAllocationPolicy"
              class="mt-1 w-full px-3 py-2 text-sm border border-calm-2 rounded-md bg-white focus:border-brand-harmony"
              data-testid="pe-overage-policy"
            >
              <option value="consumption-share">consumption-share (Insight default) — split by usage</option>
              <option value="excess-share">excess-share — split by excess above the per-seat share</option>
              <option value="excess-equal">excess-equal — equal split among everyone over</option>
              <option value="seat-share">seat-share — equal split across every active seat</option>
            </select>
            <p class="text-[11px] text-carbon-3 mt-1">
              How a PAID pooled overage (real money already on the bill) is DISTRIBUTED across Business
              Units. Never derives or creates a charge — when the pool holds, this allocates
              zero, no matter which policy is set.
            </p>
          </div>
        </div>

        <p v-if="error" class="text-xs text-rag-red mt-3" data-testid="provider-enterprise-error" role="alert">
          {{ error }}
        </p>

        <div class="flex justify-end gap-2 mt-5">
          <UiButton kind="ghost" data-testid="provider-enterprise-cancel" @click="emit('close')">Cancel</UiButton>
          <UiButton kind="primary" :disabled="!canSubmit" data-testid="pe-submit" @click="save">
            {{ saving ? (isEdit ? 'Saving…' : 'Creating…') : isEdit ? 'Save changes' : 'Create enterprise' }}
          </UiButton>
        </div>
      </div>
    </div>
  </div>
</template>
