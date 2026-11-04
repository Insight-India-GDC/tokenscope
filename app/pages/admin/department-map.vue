<script setup lang="ts">
/*
 * Admin → Region rules. Curate "when a user's <directory attribute> = <value>,
 * their region is <R>" rules (mig 0089) — the placement signal for people who
 * appear on a provider bill before they ever log in. Any tenant keys on the
 * attribute that is region-correlated on THEIR directory (companyName at
 * Insight); the Discover panel samples the directory and shows which one that
 * is. GLOBAL roles only. Unit rules and a Business Unit owner or Region leader in a person's
 * manager chain outrank these rules.
 */
import { computed, ref } from 'vue'
import { consola } from 'consola'
import { useAdminAccess } from '../../composables/useAdminAccess'
import {
  REGION_ATTRIBUTES,
  regionAttribute,
  regionAttributeLabel,
  type MatchMode,
} from '#shared/placement/region-attributes'
import type { AttributeDistribution } from '#shared/placement/field-distribution'
import type { PlacementRulePreviewRequest } from '#shared/placement/placement-check'
import PlacementRulePreview from '../../components/admin/PlacementRulePreview.vue'

definePageMeta({ layout: 'admin', middleware: 'admin' })

interface Rule {
  id: string
  attribute: string
  match_mode: string
  match_value: string
  match_value_raw: string
  region_id: string
  region_code: string
  region_display_name: string
}

// Region rules are ORG-WIDE cross-region placement config, so the rules /
// diagnostic APIs are global-roles-only. Gate the whole page on isOrgWide (not
// isAdmin) — a region admin would otherwise land on a page whose every action
// 403s. The sidebar item is 'org-wide' too, so they see it locked with a hint.
const { isOrgWide } = useAdminAccess()

// Lazy, client-only, null default: docs/design/admin-nav-responsiveness.md D1/D2.
// The Add-rule form's Region select. Its `error` is kept: collapsed into `[]` a
// failed read leaves the picker holding only the disabled "Select…" placeholder,
// which reads as "there are no regions" — the false empty D2 forbids
// (docs/design/admin-nav-responsiveness.md).
const {
  data: regionsData,
  error: regionsError,
  refresh: refreshRegions,
} = useLazyFetch<{ regions: { id: string; code: string; display_name: string }[] } | null>(
  '/api/v1/admin/regions',
  { key: 'region-rules-regions', server: false, default: () => null, immediate: isOrgWide.value },
)
const regions = computed(() => regionsData.value?.regions ?? [])

const { data, error, refresh } = useLazyFetch<{ rules: Rule[] } | null>('/api/v1/admin/directory-region-rules', {
  key: 'region-rules-list',
  server: false,
  default: () => null,
  immediate: isOrgWide.value,
})
const rules = computed(() => data.value?.rules ?? [])
const rulesByAttribute = computed(() => {
  const groups = new Map<string, Rule[]>()
  for (const r of rules.value) {
    const g = groups.get(r.attribute) ?? []
    g.push(r)
    groups.set(r.attribute, g)
  }
  return REGION_ATTRIBUTES.map((a) => ({ attribute: a.key, label: a.label, rows: groups.get(a.key) ?? [] })).filter(
    (g) => g.rows.length,
  )
})

const toast = ref<{ kind: 'ok' | 'err'; message: string } | null>(null)
let toastTimer: ReturnType<typeof setTimeout> | null = null
function flashToast(kind: 'ok' | 'err', message: string) {
  toast.value = { kind, message }
  if (toastTimer) clearTimeout(toastTimer)
  toastTimer = setTimeout(() => (toast.value = null), 3500)
}

// ── Add-rule form ──────────────────────────────────────────────────────────
const formAttribute = ref<string>('companyName')
const formMode = ref<MatchMode>('exact')
const formValue = ref('')
const formRegion = ref('')
const saving = ref(false)
const formHint = computed(() => regionAttribute(formAttribute.value)?.hint ?? '')
const selectedRegion = computed(() => regions.value.find((r) => r.id === formRegion.value))
const previewDraft = computed<PlacementRulePreviewRequest | null>(() =>
  formValue.value.trim() && formRegion.value
    ? { attribute: formAttribute.value, match_mode: formMode.value, match_value: formValue.value.trim(), region_id: formRegion.value }
    : null,
)

function prefill(attribute: string, value: string, mode: MatchMode = 'exact') {
  formAttribute.value = attribute
  formValue.value = value
  formMode.value = mode
  document.querySelector<HTMLInputElement>('[data-testid="rule-value"]')?.focus()
}

async function addRule() {
  if (!formValue.value.trim() || !formRegion.value) {
    flashToast('err', 'Pick an attribute value and a region.')
    return
  }
  // Money-policy guardrail: mapping an attribute value to Global/Shared asserts
  // "this whole group is a shared function regardless of geography" — a
  // deliberate, spend-affecting choice. Confirm before it lands in that region's
  // unattributed bucket.
  if (
    selectedRegion.value?.code === 'global-shared' &&
    !confirm(
      `Map ${regionAttributeLabel(formAttribute.value)} “${formValue.value.trim()}” to Global/Shared? Everyone matching becomes a shared function regardless of their reporting line.`,
    )
  ) {
    return
  }
  saving.value = true
  try {
    await $fetch('/api/v1/admin/directory-region-rules', {
      method: 'POST',
      body: {
        attribute: formAttribute.value,
        match_mode: formMode.value,
        match_value: formValue.value.trim(),
        region_id: formRegion.value,
      },
    })
    flashToast('ok', `Rule saved: ${regionAttributeLabel(formAttribute.value)} “${formValue.value.trim()}”.`)
    formValue.value = ''
    await refresh()
  } catch (e) {
    consola.error(e)
    flashToast('err', 'Save failed.')
  } finally {
    saving.value = false
  }
}

async function removeRule(r: Rule) {
  if (!confirm(`Remove the rule ${regionAttributeLabel(r.attribute)} “${r.match_value_raw}” → ${r.region_display_name}?`)) return
  try {
    await $fetch(`/api/v1/admin/directory-region-rules/${r.id}`, { method: 'DELETE' })
    flashToast('ok', 'Rule removed.')
    await refresh()
  } catch (e) {
    consola.error(e)
    flashToast('err', 'Remove failed.')
  }
}

// ── Discover panel (field-distribution diagnostic) ───────────────────────────
const discovering = ref(false)
const discovered = ref<{ sampled: number; attributes: AttributeDistribution[] } | null>(null)
type FieldDist = { sampled: number; attributes: AttributeDistribution[] }
async function discover() {
  discovering.value = true
  try {
    // Narrowed $fetch sig — the query-string URL otherwise trips Nuxt's
    // route-union typegen into a TS2321 "excessive stack depth" (same trap as
    // useSession.ts).
    const get = $fetch as (url: string) => Promise<FieldDist>
    discovered.value = await get('/api/v1/admin/directory/field-distribution?sample=300')
  } catch (e) {
    consola.error(e)
    flashToast('err', 'Could not sample the directory.')
  } finally {
    discovering.value = false
  }
}
</script>

<template>
  <div v-if="isOrgWide" class="max-w-[1600px] mx-auto px-10 py-8 pb-20" data-testid="admin-region-rules" data-admin-page="/admin/department-map">
    <UiPageHead
      eyebrow="Organisation"
      title="Region rules"
      sub="Home never-logged-in people to their region from their Entra profile. Pick the directory attribute that maps to region on your tenant."
    />
    <p class="-mt-4 mb-8 text-sm text-carbon-2 leading-relaxed max-w-3xl">
      A rule says “when a teammate's <strong>&lt;attribute&gt;</strong> equals <strong>&lt;value&gt;</strong>, their
      region is <strong>&lt;R&gt;</strong>”. A unit rule, a Business Unit owner in the person's manager chain
      and a <NuxtLink to="/admin/regions" class="text-brand-harmony hover:underline">Region leader</NuxtLink>
      in it all outrank it. With none of these, a first sign-in lands on the default region's Unplaced
      node; someone first seen on a bill lands on their billing region's Unplaced node when it is known
      (Copilot), otherwise on Unassigned.
      Not sure which attribute? <strong>Discover</strong> samples your directory below.
    </p>

    <div
      v-if="toast"
      :data-testid="`region-rules-toast-${toast.kind}`"
      class="mb-4 p-3 rounded-md text-sm font-medium"
      :class="toast.kind === 'ok' ? 'bg-brand-harmony-sheer text-brand-harmony border border-brand-harmony/30' : 'bg-brand-hunger/10 text-brand-heart border border-brand-hunger/30'"
    >
      {{ toast.message }}
    </div>

    <!-- Discover panel -->
    <UiCard accent="vision" class="mb-8" data-testid="region-rules-discover">
      <div class="flex items-center justify-between gap-3 flex-wrap mb-1">
        <div>
          <UiEyebrow>Discover</UiEyebrow>
          <h2 class="text-lg font-bold text-carbon mt-0.5">Which attribute maps to region?</h2>
        </div>
        <UiButton kind="primary" size="sm" :disabled="discovering" data-testid="region-rules-discover-run" @click="discover">
          {{ discovering ? 'Sampling…' : discovered ? 'Re-sample directory' : 'Sample directory' }}
        </UiButton>
      </div>
      <p class="text-xs text-carbon-3 mb-4 leading-relaxed">
        Samples up to 300 directory users (best-effort, not a census) and shows each attribute's coverage + top
        values. Values are aggregate counts only — no personal data. Rare values (&lt;5 people) are hidden.
      </p>

      <div v-if="discovered" class="grid grid-cols-1 lg:grid-cols-2 gap-4" data-testid="region-rules-discover-results">
        <div
          v-for="a in discovered.attributes"
          :key="a.attribute"
          class="p-3 rounded-lg border border-calm-2"
          :data-testid="`discover-attr-${a.attribute}`"
        >
          <div class="flex items-center justify-between gap-2">
            <span class="text-sm font-bold text-carbon">{{ a.label }}</span>
            <span class="text-[11px] text-carbon-3">{{ a.coveragePct }}% populated · {{ a.distinct }} distinct</span>
          </div>
          <div class="h-1.5 mt-1.5 rounded bg-calm-1 overflow-hidden">
            <div class="h-full bg-brand-harmony" :style="{ width: `${a.coveragePct}%` }" />
          </div>
          <p class="text-[10.5px] text-carbon-3 mt-1.5 leading-tight">{{ regionAttribute(a.attribute)?.hint }}</p>
          <div v-if="a.top.length" class="mt-2 flex flex-col gap-1">
            <div v-for="v in a.top" :key="v.value" class="flex items-center justify-between gap-2 text-sm">
              <span class="text-carbon-2 truncate">{{ v.value }} <span class="text-carbon-3 text-xs">· {{ v.count }}</span></span>
              <button
                type="button"
                class="text-[11px] font-semibold text-brand-harmony hover:underline shrink-0"
                :data-testid="`discover-map-${a.attribute}`"
                @click="prefill(a.attribute, v.value)"
              >Map →</button>
            </div>
            <p v-if="a.other.values" class="text-[11px] text-carbon-3 italic">+ {{ a.other.values }} smaller values ({{ a.other.users }} people)</p>
          </div>
          <p v-else class="text-[11px] text-carbon-3 italic mt-2">No values with ≥5 people.</p>
        </div>
      </div>
    </UiCard>

    <!-- Add rule -->
    <UiCard class="mb-8" data-testid="region-rules-add">
      <UiEyebrow>Add a rule</UiEyebrow>
      <div class="grid grid-cols-1 md:grid-cols-[180px_120px_1fr_1fr_auto] gap-3 items-end mt-3">
        <label class="text-[12px] font-semibold text-carbon">
          Attribute
          <select v-model="formAttribute" data-testid="rule-attribute" class="mt-1 w-full px-3 py-2 text-sm border border-calm-2 rounded-md bg-white">
            <option v-for="a in REGION_ATTRIBUTES" :key="a.key" :value="a.key">{{ a.label }}</option>
          </select>
        </label>
        <label class="text-[12px] font-semibold text-carbon">
          Match
          <select v-model="formMode" data-testid="rule-mode" class="mt-1 w-full px-3 py-2 text-sm border border-calm-2 rounded-md bg-white">
            <option value="exact">Exact</option>
            <option value="prefix">Prefix</option>
          </select>
        </label>
        <label class="text-[12px] font-semibold text-carbon">
          Value
          <input v-model="formValue" data-testid="rule-value" :placeholder="regionAttribute(formAttribute)?.example" class="mt-1 w-full px-3 py-2 text-sm border border-calm-2 rounded-md focus:border-brand-harmony">
        </label>
        <div>
          <label class="text-[12px] font-semibold text-carbon">
            Region
            <select
              v-model="formRegion"
              :disabled="!regionsData"
              data-testid="rule-region"
              class="mt-1 w-full px-3 py-2 text-sm border border-calm-2 rounded-md bg-white disabled:bg-calm/40 disabled:cursor-not-allowed"
            >
              <option value="" disabled>Select…</option>
              <option v-for="r in regions" :key="r.id" :value="r.id">{{ r.display_name }}</option>
            </select>
          </label>
          <UiAuxFetchError
            :error="regionsError"
            label="regions"
            testid="rule-region-error"
            @retry="refreshRegions"
          />
        </div>
        <UiButton kind="primary" size="sm" :disabled="saving" data-testid="rule-add" @click="addRule">
          {{ saving ? 'Saving…' : 'Add rule' }}
        </UiButton>
      </div>
      <p class="text-[11px] text-carbon-3 mt-2 leading-relaxed">{{ formHint }}</p>
      <div class="mt-4 pt-4 border-t border-calm-2">
        <p class="text-[12px] text-carbon-2 mb-2">Preview lists who would derive a different placement with this rule, from the last placement check.</p>
        <PlacementRulePreview :draft="previewDraft" />
      </div>
    </UiCard>

    <!-- Rules -->
    <UiFetchErrorBanner v-if="error" :error="error" label="region rules" @retry="refresh" />
    <AdminPageSkeleton v-else-if="data == null" :toolbar="false" />
    <div v-else-if="!rules.length" class="p-6 rounded-lg border border-calm-2 text-center" data-testid="region-rules-empty">
      <p class="text-sm text-carbon-2">No region rules yet. Run <strong>Discover</strong> to see which attribute maps to region, then add rules. Until then, people are placed by unit rules and the owners and Region leaders in their manager chain, or fall back as described above.</p>
    </div>
    <div v-else class="flex flex-col gap-6" data-testid="region-rules-list">
      <div v-for="g in rulesByAttribute" :key="g.attribute">
        <h3 class="text-[11px] font-bold uppercase tracking-[1.2px] text-carbon-3 mb-2">{{ g.label }}</h3>
        <div class="rounded-lg border border-calm-2 divide-y divide-calm-2">
          <div v-for="r in g.rows" :key="r.id" class="flex items-center justify-between gap-3 px-4 py-2.5" :data-testid="`rule-row-${r.id}`">
            <div class="flex items-center gap-2 min-w-0 flex-wrap">
              <span class="text-sm font-semibold text-carbon truncate">{{ r.match_value_raw }}</span>
              <UiBadge v-if="r.match_mode === 'prefix'" kind="neutral">prefix</UiBadge>
              <span class="text-carbon-3 text-sm">→</span>
              <UiBadge :kind="r.region_code === 'global-shared' ? 'neutral' : 'harmony'">{{ r.region_display_name }}</UiBadge>
            </div>
            <button type="button" class="text-xs font-semibold text-brand-hunger hover:underline shrink-0" :data-testid="`rule-remove-${r.id}`" @click="removeRule(r)">Remove</button>
          </div>
        </div>
      </div>
    </div>
  </div>
  <div v-else class="max-w-[1600px] mx-auto px-10 py-16 text-center" data-admin-page="/admin/department-map">
    <div class="text-lg font-bold text-carbon">Admin access required.</div>
  </div>
</template>
