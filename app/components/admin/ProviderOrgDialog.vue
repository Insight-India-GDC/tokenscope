<script setup lang="ts">
/*
 * ProviderOrgDialog — create OR edit a provider_org for either provider. Replaces
 * the brittle seed.ts template rows with an audited onboarding path.
 *
 * One dialog, two modes:
 *   - create (target === null && open) → POST  .../orgs
 *   - edit   (target is an existing row) → PATCH .../orgs/{id}
 * In edit mode `provider` AND `externalOrgId` are IMMUTABLE (provider flips the
 * api_kind invariant + credential env-prefix; external_org_id is half the UNIQUE
 * identity — re-keying is a delete+create), so both are shown read-only.
 *
 * Anthropic flow:
 *   credential-secret-name → DISCOVER button → POST .../anthropic/discover.
 *   On 200 we auto-fill externalOrgId (read-only, "discovered") and the api_kind
 *   variant, and show a success note. On 422 we surface the SAFE reason inline.
 *   Manual externalOrgId entry stays available as a fallback (discover unavailable).
 * GitHub flow:
 *   externalOrgId (slug/login) + a provider_enterprise picker (github only) +
 *   display name + mode. The credential lives on the enterprise, not the org.
 *
 * Server validation (400/404/409/422) is surfaced inline; the key value is NEVER
 * sent back to us. A11y mirrors SetBudgetDialog / AddTeammateDialog.
 */
import { ref, computed, watch, type Ref } from 'vue'
import { consola } from 'consola'
import UiButton from '../ui/Button.vue'
import UiAuxFetchError from '../ui/AuxFetchError.vue'
import { useModalA11y } from '../../composables/useModalA11y'
import { apiErrorDetail } from '../../composables/useApiError'

type Provider = 'anthropic' | 'github'
type ApiKind = 'enterprise-analytics' | 'claude-code-admin'

export interface OrgEditTarget {
  id: string
  provider: Provider
  externalOrgId: string
  displayName: string
  reconciliationMode: string
  billing: string
  apiKind: ApiKind | null
  credentialSecretName: string | null
  providerEnterpriseId: string | null
  /* ADR-0010 D4 — the region this GitHub org bills to. null = unmapped. */
  regionId: string | null
}

export interface EnterpriseOption {
  id: string
  provider: string
  externalId: string
  displayName: string
}

export interface RegionOption {
  id: string
  code: string
  displayName: string
}

const props = defineProps<{
  /* null = CREATE mode; a target = EDIT mode. */
  target: OrgEditTarget | null
  /* Drives open-state independently of target so CREATE (target=null) can open. */
  open: boolean
  /* All enterprises (filtered to github inside for the org→enterprise picker). */
  enterprises: EnterpriseOption[]
  /* All regions, for the GitHub org→region home picker (ADR-0010 D4). */
  regions: RegionOption[]
  /*
   * The caller's region read failed. Without it the picker holds only
   * "— unmapped —" and reads as "there is nowhere to map this org" — the false
   * empty D2 forbids (docs/design/admin-nav-responsiveness.md).
   */
  regionsError?: unknown
  /*
   * The caller's region read has not landed yet. Region is OPTIONAL and
   * `canSubmit` does not check it, so an enabled picker holding only
   * "— unmapped —" lets an operator persist regionId: null before the real
   * options arrive. Absent data disables the control, exactly as a failure does.
   */
  regionsLoading?: boolean
  /* Workstream B (ADR-0011 D11): once true, provider_org.billing is meaningless
   * for a github org (the enterprise is authoritative) — the field is hidden
   * for github and never sent on save (the server rejects the write anyway;
   * this keeps the form from 409ing on an unrelated edit). Always shown/sent
   * for anthropic, where the org remains its own billing unit. */
  governanceActivated?: boolean
  /* anthropic/discover is platform-admin only server-side (it resolves the
   * deployment-wide credential namespace); hide the button from region admins. */
  canDiscoverOrg?: boolean
  /* Creating an Anthropic org assigns a credential name and starts unmapped,
   * both platform-admin only server-side (orgs.post), so for anyone else the
   * Anthropic create path could only end in 403: it is not offered. */
  canCreateAnthropicOrg?: boolean
}>()
const emit = defineEmits<{ close: []; saved: []; retryRegions: [] }>()

const CRED_RE = /^[a-z0-9-]{3,64}$/

const provider = ref<Provider>(props.canCreateAnthropicOrg ? 'anthropic' : 'github')
const externalOrgId = ref('')
const displayName = ref('')
const reconciliationMode = ref<'reconciled' | 'indicative'>('reconciled')
const billing = ref<'billed' | 'tracked'>('tracked')
const apiKind = ref<ApiKind | null>('claude-code-admin')
const credentialSecretName = ref('')
const providerEnterpriseId = ref('')
const regionId = ref('')
const saving = ref(false)
const error = ref<string | null>(null)

// Discover sub-flow (anthropic only).
const discovering = ref(false)
const discovered = ref(false) // true once a discover 200 auto-filled the org id
const discoverNote = ref<string | null>(null)
const discoverError = ref<string | null>(null)

const firstField = ref<HTMLElement | null>(null)
const dialogEl = ref<HTMLElement | null>(null)
const titleId = 'provider-org-title'

const isEdit = computed(() => props.target !== null)
const githubEnterprises = computed(() => props.enterprises.filter((e) => e.provider === 'github'))

const REASON_LABEL: Record<string, string> = {
  'no-key': 'No key wired for that credential name.',
  'endpoint-unset': 'Anthropic endpoint not configured — discovery is unavailable. Enter the org id manually.',
  '400-bad-request': 'The API rejected the request (400) — a malformed or missing parameter.',
  '401-unauthorized': 'Unauthorized (401) — the key was rejected.',
  '403-forbidden-scope': 'Forbidden (403) — the key lacks the required scope.',
  '404-wrong-endpoint': 'Wrong endpoint (404) — the key may be for the other API variant.',
  'parse-mismatch': 'Connected, but the response did not carry an organization id.',
  'connect-failed': 'Could not connect to the Anthropic API.',
  'key-format-mismatch': 'The key format does not match the detected variant.',
  '429-rate-limited': 'Rate-limited (429) — try again shortly.',
}
function reasonLabel(reason: string): string {
  return REASON_LABEL[reason] ?? `Discovery failed: ${reason}.`
}
function apiKindLabel(kind: ApiKind | null): string {
  if (kind === 'enterprise-analytics') return 'Enterprise Analytics'
  if (kind === 'claude-code-admin') return 'Claude Code (Admin)'
  return '—'
}

useModalA11y({
  isOpen: () => props.open,
  dialogEl,
  firstField: firstField as Ref<HTMLElement | null>,
  onClose: () => emit('close'),
  onOpen: () => {
    const t = props.target
    provider.value = t?.provider ?? (props.canCreateAnthropicOrg ? 'anthropic' : 'github')
    externalOrgId.value = t?.externalOrgId ?? ''
    displayName.value = t?.displayName ?? ''
    reconciliationMode.value = (t?.reconciliationMode as 'reconciled' | 'indicative') ?? 'reconciled'
    billing.value = (t?.billing as 'billed' | 'tracked') ?? 'tracked'
    apiKind.value = t ? t.apiKind : 'claude-code-admin'
    credentialSecretName.value = t?.credentialSecretName ?? ''
    providerEnterpriseId.value = t?.providerEnterpriseId ?? ''
    regionId.value = t?.regionId ?? ''
    error.value = null
    discovering.value = false
    discovered.value = false
    discoverNote.value = null
    discoverError.value = null
  },
})

// Switching provider on a fresh create resets the cross-provider fields so the
// row never violates the api_kind CHECK (anthropic⇒apiKind; github⇒null).
watch(provider, (p) => {
  if (isEdit.value) return
  if (p === 'anthropic') {
    apiKind.value = 'claude-code-admin'
    providerEnterpriseId.value = ''
    reconciliationMode.value = 'reconciled'
  } else {
    apiKind.value = null
    credentialSecretName.value = ''
    reconciliationMode.value = 'indicative'
  }
  discovered.value = false
  discoverNote.value = null
  discoverError.value = null
})

const credInvalid = computed(
  () => credentialSecretName.value.length > 0 && !CRED_RE.test(credentialSecretName.value),
)
// github org logins/slugs are lowercase-only (the slug is part of the credential
// lane key; the server canonicalises to lowercase and rejects a mixed-case slug —
// mirror the enterprise dialog so the user fixes it client-side). Anthropic org ids
// are case-insensitive (auto-lowercased server-side), so no warning there.
const githubSlugWarn = computed(
  () =>
    provider.value === 'github' &&
    externalOrgId.value.length > 0 &&
    externalOrgId.value !== externalOrgId.value.toLowerCase(),
)
// A reconciled anthropic org REQUIRES a credential (the poller can't reconcile
// without a key) — mirror the server rule so the button reflects it.
const reconciledNeedsCred = computed(
  () =>
    provider.value === 'anthropic' &&
    reconciliationMode.value === 'reconciled' &&
    !credentialSecretName.value.trim(),
)
const canDiscover = computed(
  () =>
    props.canDiscoverOrg === true &&
    provider.value === 'anthropic' &&
    !discovering.value &&
    credentialSecretName.value.trim().length > 0 &&
    CRED_RE.test(credentialSecretName.value.trim()),
)

// ADR-0011 D11: billing is org-level ONLY for anthropic once activated; a
// github org's billing lives on its enterprise and this field is inert.
const billingAppliesToOrg = computed(() => provider.value === 'anthropic' || !props.governanceActivated)

const canSubmit = computed(() => {
  if (saving.value) return false
  if (!externalOrgId.value.trim() || !displayName.value.trim()) return false
  if (credInvalid.value) return false
  if (githubSlugWarn.value) return false
  if (provider.value === 'anthropic') {
    if (!apiKind.value) return false
    if (reconciledNeedsCred.value) return false
  }
  return true
})

watch([externalOrgId, displayName, credentialSecretName, reconciliationMode, billing, apiKind, providerEnterpriseId], () => {
  if (error.value) error.value = null
})
// Typing a new credential after a discover invalidates the discovered org id.
watch(credentialSecretName, () => {
  discovered.value = false
  discoverNote.value = null
  discoverError.value = null
})

async function discover() {
  if (!canDiscover.value) return
  discovering.value = true
  discoverNote.value = null
  discoverError.value = null
  try {
    const res = await $fetch<{ organizationId: string; apiKindDetected: ApiKind; keyFormatLooksLike: string }>(
      '/api/v1/admin/reconciliation/anthropic/discover',
      { method: 'POST', body: { credentialSecretName: credentialSecretName.value.trim() } },
    )
    externalOrgId.value = res.organizationId
    apiKind.value = res.apiKindDetected
    discovered.value = true
    discoverNote.value = `Discovered org ${res.organizationId} — ${apiKindLabel(res.apiKindDetected)} (key looks ${res.keyFormatLooksLike}).`
  } catch (e: unknown) {
    // 422 carries a SAFE classified reason in data.reason; fall back to detail.
    const reason = (e as { data?: { reason?: string } } | null)?.data?.reason
    discoverError.value = reason ? reasonLabel(reason) : apiErrorDetail(e, 'Discovery failed.')
    consola.warn('anthropic discover failed', e)
  } finally {
    discovering.value = false
  }
}

async function save() {
  if (!canSubmit.value) return
  saving.value = true
  error.value = null
  const cred = credentialSecretName.value.trim() ? credentialSecretName.value.trim() : null
  const entId = providerEnterpriseId.value || null
  try {
    if (isEdit.value && props.target) {
      // PATCH: provider + externalOrgId are immutable — send the mutable set.
      // The PATCH route treats an ABSENT key as "leave unchanged"; only GitHub orgs
      // expose the enterprise picker, so for an anthropic org we OMIT
      // providerEnterpriseId entirely (sending null would silently clear an existing
      // link the dialog doesn't manage). For github the picker IS the source of truth.
      await $fetch(`/api/v1/admin/reconciliation/orgs/${props.target.id}`, {
        method: 'PATCH',
        body: {
          displayName: displayName.value.trim(),
          reconciliationMode: reconciliationMode.value,
          ...(billingAppliesToOrg.value ? { billing: billing.value } : {}),
          apiKind: provider.value === 'anthropic' ? apiKind.value : null,
          credentialSecretName: provider.value === 'anthropic' ? cred : null,
          ...(provider.value === 'github' ? { providerEnterpriseId: entId, regionId: regionId.value || null } : {}),
        },
      })
    } else {
      await $fetch('/api/v1/admin/reconciliation/orgs', {
        method: 'POST',
        body: {
          provider: provider.value,
          externalOrgId: externalOrgId.value.trim(),
          displayName: displayName.value.trim(),
          reconciliationMode: reconciliationMode.value,
          ...(billingAppliesToOrg.value ? { billing: billing.value } : {}),
          apiKind: provider.value === 'anthropic' ? apiKind.value : null,
          credentialSecretName: provider.value === 'anthropic' ? cred : null,
          providerEnterpriseId: provider.value === 'github' ? entId : null,
          regionId: provider.value === 'github' ? regionId.value || null : null,
        },
      })
    }
    emit('saved')
  } catch (e: unknown) {
    error.value = apiErrorDetail(e, isEdit.value ? 'Org update failed.' : 'Org creation failed.')
    consola.warn('provider-org save failed', e)
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <div
    v-if="open"
    class="fixed inset-0 z-50 flex items-center justify-center bg-carbon/40 p-4"
    data-testid="provider-org-dialog"
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
            {{ isEdit ? 'Edit org' : 'New org' }}
          </p>
          <h2 :id="titleId" class="text-lg font-bold text-carbon mt-0.5">
            {{ isEdit ? displayName || 'Org' : 'Onboard a provider org' }}
          </h2>
        </div>
        <UiButton kind="ghost" size="sm" data-testid="provider-org-close" @click="emit('close')">Close</UiButton>
      </div>

      <div class="px-6 py-4">
        <!-- Provider -->
        <div>
          <label for="po-provider" class="text-[12px] font-semibold text-carbon">Provider</label>
          <select
            id="po-provider"
            ref="firstField"
            v-model="provider"
            :disabled="isEdit"
            class="mt-1 w-full px-3 py-2 text-sm border border-calm-2 rounded-md bg-white focus:border-brand-harmony disabled:bg-calm/30"
            data-testid="po-provider"
          >
            <option v-if="isEdit || canCreateAnthropicOrg" value="anthropic">anthropic</option>
            <option value="github">github</option>
          </select>
          <p v-if="isEdit" class="text-[11px] text-carbon-3 mt-1">Provider can't change after creation.</p>
          <p v-else-if="!canCreateAnthropicOrg" class="text-[11px] text-carbon-3 mt-1" data-testid="po-anthropic-platform-only">
            Anthropic orgs are added by an Admin, because they hold a credential.
          </p>
        </div>

        <!-- ===================== ANTHROPIC ===================== -->
        <template v-if="provider === 'anthropic'">
          <div class="mt-3">
            <label for="po-cred" class="text-[12px] font-semibold text-carbon">Credential secret name</label>
            <div class="flex gap-2 mt-1">
              <input
                id="po-cred"
                v-model="credentialSecretName"
                type="text"
                placeholder="acme-anthropic-admin-key"
                class="flex-1 px-3 py-2 text-sm border border-calm-2 rounded-md font-mono focus:border-brand-harmony"
                data-testid="po-cred"
              >
              <UiButton
                v-if="canDiscoverOrg"
                kind="secondary"
                size="sm"
                :disabled="!canDiscover"
                data-testid="po-discover"
                title="Probe the key to read back the organization id and detect the API variant."
                @click="discover"
              >
                {{ discovering ? 'Discovering…' : 'Discover' }}
              </UiButton>
            </div>
            <p class="text-[11px] text-carbon-3 mt-1">
              Names the env var holding the admin/analytics key (never the key itself). Lowercase, digits, hyphen.
            </p>
            <p v-if="credInvalid" class="text-[11px] text-rag-red mt-1" data-testid="po-cred-warn">
              Must match ^[a-z0-9-]{3,64}$.
            </p>
            <p v-if="discoverNote" class="text-[11px] text-brand-harmony mt-1 font-medium" data-testid="po-discover-note">
              {{ discoverNote }}
            </p>
            <p v-if="discoverError" class="text-[11px] text-rag-red mt-1" data-testid="po-discover-error" role="alert">
              {{ discoverError }}
            </p>
          </div>

          <div class="grid grid-cols-2 gap-3 mt-3">
            <div>
              <label for="po-org-id" class="text-[12px] font-semibold text-carbon">
                Org id
                <span v-if="discovered" class="text-brand-harmony font-normal">(discovered)</span>
              </label>
              <input
                id="po-org-id"
                v-model="externalOrgId"
                type="text"
                :readonly="discovered"
                :disabled="isEdit"
                placeholder="org-abc123 (or use Discover)"
                class="mt-1 w-full px-3 py-2 text-sm border border-calm-2 rounded-md font-mono focus:border-brand-harmony read-only:bg-calm/30 disabled:bg-calm/30"
                data-testid="po-org-id"
              >
              <p v-if="isEdit" class="text-[11px] text-carbon-3 mt-1">Org id is immutable.</p>
            </div>
            <div>
              <label for="po-api-kind" class="text-[12px] font-semibold text-carbon">API variant</label>
              <select
                id="po-api-kind"
                v-model="apiKind"
                class="mt-1 w-full px-3 py-2 text-sm border border-calm-2 rounded-md bg-white focus:border-brand-harmony"
                data-testid="po-api-kind"
              >
                <option value="claude-code-admin">Claude Code (Admin)</option>
                <option value="enterprise-analytics">Enterprise Analytics</option>
              </select>
            </div>
          </div>
        </template>

        <!-- ===================== GITHUB ===================== -->
        <template v-else>
          <div class="mt-3">
            <label for="po-org-id-gh" class="text-[12px] font-semibold text-carbon">
              Org login / external id <span class="text-carbon-3 font-normal">(slug)</span>
            </label>
            <input
              id="po-org-id-gh"
              v-model="externalOrgId"
              type="text"
              :disabled="isEdit"
              placeholder="acme-engineering"
              class="mt-1 w-full px-3 py-2 text-sm border border-calm-2 rounded-md font-mono focus:border-brand-harmony disabled:bg-calm/30"
              data-testid="po-org-id-gh"
            >
            <p v-if="githubSlugWarn" class="text-[11px] text-rag-red mt-1" data-testid="po-slug-warn">
              GitHub org logins must be lowercase.
            </p>
            <p v-if="isEdit" class="text-[11px] text-carbon-3 mt-1">Org id is immutable.</p>
          </div>
          <div class="mt-3">
            <label for="po-enterprise" class="text-[12px] font-semibold text-carbon">
              Enterprise <span class="text-carbon-3 font-normal">(optional)</span>
            </label>
            <select
              id="po-enterprise"
              v-model="providerEnterpriseId"
              class="mt-1 w-full px-3 py-2 text-sm border border-calm-2 rounded-md bg-white focus:border-brand-harmony"
              data-testid="po-enterprise"
            >
              <option value="">— none —</option>
              <option v-for="e in githubEnterprises" :key="e.id" :value="e.id">
                {{ e.displayName }} ({{ e.externalId }})
              </option>
            </select>
            <p v-if="githubEnterprises.length === 0" class="text-[11px] text-carbon-3 mt-1">
              No GitHub enterprises yet — register one first to hold the billing PAT.
            </p>
          </div>
          <div class="mt-3">
            <label for="po-region" class="text-[12px] font-semibold text-carbon">
              Region home <span class="text-carbon-3 font-normal">(optional)</span>
            </label>
            <select
              id="po-region"
              v-model="regionId"
              :disabled="!!regionsError || !!regionsLoading"
              class="mt-1 w-full px-3 py-2 text-sm border border-calm-2 rounded-md bg-white focus:border-brand-harmony disabled:bg-calm/40 disabled:cursor-not-allowed"
              data-testid="po-region"
            >
              <option value="">— unmapped —</option>
              <option v-for="r in regions" :key="r.id" :value="r.id">{{ r.displayName }}</option>
            </select>
            <p
              v-if="regionsLoading && !regionsError"
              class="mt-1 text-[11px] text-carbon-3"
              role="status"
              aria-busy="true"
              data-testid="po-region-loading"
            >Loading regions…</p>
            <UiAuxFetchError
              :error="regionsError"
              label="regions"
              testid="po-region-error"
              @retry="emit('retryRegions')"
            />
            <p class="text-[11px] text-carbon-3 mt-1">
              The region this org's Copilot cost belongs to. Used as the fallback home when a
              seat-holder can't be placed into a practice automatically. Leave unmapped if unsure.
            </p>
          </div>
        </template>

        <!-- Common fields -->
        <div class="mt-3">
          <label for="po-display-name" class="text-[12px] font-semibold text-carbon">Display name</label>
          <input
            id="po-display-name"
            v-model="displayName"
            type="text"
            placeholder="Acme Engineering"
            class="mt-1 w-full px-3 py-2 text-sm border border-calm-2 rounded-md focus:border-brand-harmony"
            data-testid="po-display-name"
          >
        </div>

        <div class="grid grid-cols-2 gap-3 mt-3">
          <div>
            <label for="po-mode" class="text-[12px] font-semibold text-carbon">Reconciliation mode</label>
            <select
              id="po-mode"
              v-model="reconciliationMode"
              class="mt-1 w-full px-3 py-2 text-sm border border-calm-2 rounded-md bg-white focus:border-brand-harmony"
              data-testid="po-mode"
            >
              <option value="reconciled">reconciled</option>
              <option value="indicative">indicative</option>
            </select>
            <p v-if="reconciledNeedsCred" class="text-[11px] text-rag-red mt-1" data-testid="po-mode-warn">
              A reconciled anthropic org needs a credential.
            </p>
          </div>
          <div v-if="billingAppliesToOrg">
            <label for="po-billing" class="text-[12px] font-semibold text-carbon">Billing</label>
            <select
              id="po-billing"
              v-model="billing"
              class="mt-1 w-full px-3 py-2 text-sm border border-calm-2 rounded-md bg-white focus:border-brand-harmony"
              data-testid="po-billing"
            >
              <option value="tracked">tracked</option>
              <option value="billed">billed</option>
            </select>
          </div>
          <p v-else class="text-[12px] text-carbon-3" data-testid="po-billing-on-enterprise">
            Billing is set on the linked GitHub enterprise (governance is active).
          </p>
        </div>

        <p v-if="error" class="text-xs text-rag-red mt-3" data-testid="provider-org-error" role="alert">
          {{ error }}
        </p>

        <div class="flex justify-end gap-2 mt-5">
          <UiButton kind="ghost" data-testid="provider-org-cancel" @click="emit('close')">Cancel</UiButton>
          <UiButton kind="primary" :disabled="!canSubmit" data-testid="po-submit" @click="save">
            {{ saving ? (isEdit ? 'Saving…' : 'Creating…') : isEdit ? 'Save changes' : 'Create org' }}
          </UiButton>
        </div>
      </div>
    </div>
  </div>
</template>
