<script setup lang="ts">
/*
 * GovernanceDialsSection — the editable governance dials (S4) on
 * Admin → Settings, backed by GET/PUT /api/v1/admin/governance-settings
 * (mig 0049, server/utils/governance-settings.ts).
 *
 * Persona contract:
 *  - Region admin: no scope picker. They see their region's RESOLVED values
 *    (their override + the platform default it shadows); Save writes their
 *    region's override. The server clamps scope authority — a refused write
 *    surfaces as a toast, we don't pre-hide the controls.
 *  - platform-admin: a scope picker (platform + per-region
 *    overrides); Save writes the selected scope.
 *
 * There is NO DELETE on the API — overrides can only be re-valued, never
 * removed, and the UI says so rather than inventing a "clear" affordance.
 *
 * Extracted from settings.vue so the render logic is unit-testable with the
 * plain @vue/test-utils harness (no Nuxt runtime): data arrives via props,
 * only the PUT uses the global $fetch.
 */
import { ref, computed, watch } from 'vue'
import UiCard from '../ui/Card.vue'
import UiEyebrow from '../ui/Eyebrow.vue'
import UiBadge from '../ui/Badge.vue'
import UiButton from '../ui/Button.vue'
import UiAuxFetchError from '../ui/AuxFetchError.vue'
import { apiErrorDetail } from '../../composables/useApiError'

export interface GovernanceDialsData {
  keys: string[]
  /** Keys that hold 0 or 1, edited as a yes/no switch. */
  switch_keys?: string[]
  /** Keys with no region override; editable only at platform scope. */
  platform_only_keys?: string[]
  platform: { key: string; value: number; updated_at: string }[]
  region_overrides: {
    key: string
    region_id: string
    region_code: string
    value: number
    updated_at: string
  }[]
}

export interface GovernanceRegionOption {
  id: string
  code: string
  display_name: string
}

const props = defineProps<{
  data: GovernanceDialsData | null
  /** Region list for the org-wide scope picker (unused for region admins). */
  regions: GovernanceRegionOption[]
  /** platform-admin — gets the scope picker + platform writes. */
  orgWide: boolean
  /** Caller's home region — the region admin's write target. */
  regionId: string | null
  /** Display code for the caller's home region (region-admin caption). */
  regionCode: string | null
  /*
   * The caller's region read failed. The scope picker would otherwise offer
   * "Platform default" alone, which reads as "there are no region overrides to
   * make" — the false empty D2 forbids
   * (docs/design/admin-nav-responsiveness.md).
   */
  regionsError?: unknown
}>()

const emit = defineEmits<{ saved: []; retryRegions: [] }>()

// Human label + honest one-liner per known dial. Keys the server reports
// that we don't know yet still render (label = key) so a new dial is never
// invisible in the editor.
const DIAL_META: Record<string, { label: string; explanation: string }> = {
  'velocity.spike_threshold': {
    label: 'Velocity spike threshold',
    explanation:
      'Velocity spike flag — current week vs 4-week mean, as a fraction (0.25 = +25%)',
  },
  'reconciliation.gap_threshold': {
    label: 'Reconciliation gap threshold',
    explanation: 'OTel-vs-actuals gap worker alert fraction',
  },
  'reconciliation.epsilon_usd': {
    label: 'Reconciliation epsilon (USD)',
    explanation: 'Reconciliation matched-band in USD',
  },
  'reconciliation.lag_buffer_hours': {
    label: 'Reconciliation lag buffer (hours)',
    explanation: 'Reconciliation walk-back lag buffer (hours)',
  },
  'placement.default_unit_warn_threshold': {
    label: 'Catch-all unit warning (people)',
    explanation:
      'How many people may sit in a region’s (default) unit without reporting to its owner before the region page warns. It is a span of control, so it differs by organisation.',
  },
  'projects.pm_own_region_only': {
    label: 'Project Managers create only in their own region',
    explanation:
      'When on, someone on the Project managers list can create projects only in the region they are placed in now. Admins and approved project requests are not affected.',
  },
}

// Scope selection. 'platform' or a region id — org-wide only; a region admin
// is pinned to their own region (no picker, server enforces it anyway).
const selectedScope = ref<string>('platform')
const scopeRegionId = computed<string | null>(() => {
  if (!props.orgWide) return props.regionId
  return selectedScope.value === 'platform' ? null : selectedScope.value
})

interface DialRow {
  key: string
  label: string
  explanation: string
  platformValue: number | null
  overrideValue: number | null
  effective: number | null
  source: 'platform' | 'region override'
  isSwitch: boolean
  /** Platform-only key while a region scope is selected: shown, not editable. */
  locked: boolean
}

const rows = computed<DialRow[]>(() => {
  const d = props.data
  if (!d) return []
  return d.keys.map((key) => {
    const meta = DIAL_META[key] ?? { label: key, explanation: '' }
    const platformValue = d.platform.find((p) => p.key === key)?.value ?? null
    const override = scopeRegionId.value
      ? d.region_overrides.find((o) => o.key === key && o.region_id === scopeRegionId.value)
      : undefined
    const overrideValue = override?.value ?? null
    return {
      key,
      label: meta.label,
      explanation: meta.explanation,
      platformValue,
      overrideValue,
      effective: overrideValue ?? platformValue,
      source: overrideValue !== null ? ('region override' as const) : ('platform' as const),
      isSwitch: d.switch_keys?.includes(key) ?? false,
      locked: scopeRegionId.value !== null && (d.platform_only_keys?.includes(key) ?? false),
    }
  })
})

// Drafts keyed by dial — initialised to the effective value for the selected
// scope, re-seeded whenever the data refreshes or the scope changes.
const drafts = ref<Record<string, number | null>>({})
watch(
  rows,
  (next) => {
    const seeded: Record<string, number | null> = {}
    for (const r of next) seeded[r.key] = r.effective
    drafts.value = seeded
  },
  { immediate: true },
)

const toast = ref<{ kind: 'ok' | 'err'; message: string } | null>(null)
let toastTimer: ReturnType<typeof setTimeout> | null = null
function flashToast(kind: 'ok' | 'err', message: string) {
  toast.value = { kind, message }
  if (toastTimer) clearTimeout(toastTimer)
  toastTimer = setTimeout(() => { toast.value = null }, 3500)
}

const savingKey = ref<string | null>(null)

async function saveDial(row: DialRow) {
  const value = drafts.value[row.key]
  if (value === null || value === undefined || typeof value !== 'number') {
    flashToast('err', `Enter a numeric value for ${row.label}.`)
    return
  }
  const regionId = scopeRegionId.value
  if (!props.orgWide && !regionId) {
    // A region admin without a home region has nothing to write against.
    flashToast('err', 'No region assigned to this session.')
    return
  }
  savingKey.value = row.key
  try {
    await $fetch('/api/v1/admin/governance-settings', {
      method: 'PUT',
      body: regionId
        ? { key: row.key, scope_type: 'region', region_id: regionId, value }
        : { key: row.key, scope_type: 'platform', value },
    })
    flashToast(
      'ok',
      `${row.label} saved (${regionId ? 'region override' : 'platform default'}).`,
    )
    emit('saved')
  } catch (err) {
    flashToast('err', apiErrorDetail(err, 'Save refused.'))
  } finally {
    savingKey.value = null
  }
}

const scopeLabel = computed(() => {
  if (!props.orgWide) return props.regionCode ? `your region (${props.regionCode})` : 'your region'
  if (selectedScope.value === 'platform') return 'platform default'
  const region = props.regions.find((r) => r.id === selectedScope.value)
  return region ? `${region.display_name} override` : 'region override'
})
</script>

<template>
  <UiCard accent="harmony" data-testid="settings-governance-dials">
    <UiEyebrow>Detection thresholds</UiEyebrow>
    <h2 class="text-lg font-bold text-carbon mt-1 mb-1">Values and overrides</h2>
    <p class="text-xs text-carbon-3 mb-4 leading-relaxed">
      Thresholds for the live detection mechanisms. A region override shadows the platform
      default; saving writes the <span class="font-semibold">{{ scopeLabel }}</span> value.
    </p>

    <div
      v-if="toast"
      :data-testid="`settings-governance-toast-${toast.kind}`"
      class="mb-4 p-3 rounded-md text-sm font-medium"
      :class="toast.kind === 'ok'
        ? 'bg-brand-harmony-sheer text-brand-harmony border border-brand-harmony/30'
        : 'bg-brand-hunger/10 text-brand-heart border border-brand-hunger/30'"
    >
      {{ toast.message }}
    </div>

    <div v-if="orgWide" class="mb-4">
      <label for="governance-scope" class="text-[12px] font-semibold text-carbon block mb-1">
        Scope
      </label>
      <select
        id="governance-scope"
        v-model="selectedScope"
        :disabled="!!regionsError"
        class="px-3 py-2 text-sm border border-calm-2 rounded-md bg-white disabled:bg-calm/40 disabled:cursor-not-allowed"
        data-testid="settings-governance-scope"
      >
        <option value="platform">Platform default</option>
        <option v-for="r in regions" :key="r.id" :value="r.id">
          {{ r.display_name }} — region override
        </option>
      </select>
      <UiAuxFetchError
        :error="regionsError"
        label="regions"
        testid="settings-governance-regions-error"
        @retry="emit('retryRegions')"
      />
    </div>

    <p v-if="!data" class="text-sm text-carbon-3 italic">Loading governance settings…</p>
    <div v-else class="divide-y divide-calm-2">
      <div
        v-for="row in rows"
        :key="row.key"
        class="py-4 first:pt-0 last:pb-0"
        :data-testid="`governance-dial-${row.key}`"
      >
        <div class="flex flex-wrap items-start justify-between gap-x-6 gap-y-2">
          <div class="min-w-[240px] flex-1">
            <div class="text-sm font-semibold text-carbon">{{ row.label }}</div>
            <div class="text-xs text-carbon-3 leading-relaxed mt-0.5">{{ row.explanation }}</div>
            <dl class="flex flex-wrap items-center gap-x-5 gap-y-1 mt-2 text-xs">
              <div class="flex items-center gap-1.5">
                <dt class="text-carbon-3">Platform</dt>
                <dd class="font-mono text-carbon" :data-testid="`governance-platform-${row.key}`">
                  {{ row.platformValue ?? '—' }}
                </dd>
              </div>
              <div class="flex items-center gap-1.5">
                <dt class="text-carbon-3">Region override</dt>
                <dd class="font-mono text-carbon" :data-testid="`governance-override-${row.key}`">
                  {{ row.overrideValue ?? '—' }}
                </dd>
              </div>
              <div class="flex items-center gap-1.5">
                <dt class="text-carbon-3">Effective</dt>
                <dd
                  class="font-mono font-bold text-carbon text-sm"
                  :data-testid="`governance-effective-${row.key}`"
                >
                  {{ row.effective ?? '—' }}
                </dd>
                <dd>
                  <UiBadge
                    :kind="row.source === 'region override' ? 'rag-amber' : 'neutral'"
                    :data-testid="`governance-source-${row.key}`"
                  >{{ row.source }}</UiBadge>
                </dd>
              </div>
            </dl>
          </div>
          <p
            v-if="row.locked"
            class="text-xs text-carbon-3 italic max-w-[220px]"
            :data-testid="`governance-locked-${row.key}`"
          >
            Platform-wide: set at the platform default scope, not per region.
          </p>
          <div v-else-if="row.isSwitch" class="flex items-center gap-2">
            <label class="flex items-center gap-2 text-sm text-carbon cursor-pointer">
              <input
                :id="`governance-input-${row.key}`"
                type="checkbox"
                :checked="drafts[row.key] === 1"
                :aria-label="row.label"
                :data-testid="`governance-input-${row.key}`"
                @change="drafts[row.key] = ($event.target as HTMLInputElement).checked ? 1 : 0"
              >
              {{ drafts[row.key] === 1 ? 'Yes' : 'No' }}
            </label>
            <UiButton
              kind="primary"
              size="sm"
              :disabled="savingKey === row.key"
              :data-testid="`governance-save-${row.key}`"
              @click="saveDial(row)"
            >
              {{ savingKey === row.key ? 'Saving…' : 'Save' }}
            </UiButton>
          </div>
          <div v-else class="flex items-center gap-2">
            <label class="sr-only" :for="`governance-input-${row.key}`">{{ row.label }}</label>
            <input
              :id="`governance-input-${row.key}`"
              v-model.number="drafts[row.key]"
              type="number"
              step="any"
              class="w-32 px-3 py-2 text-sm border border-calm-2 rounded-md focus:border-brand-harmony"
              :data-testid="`governance-input-${row.key}`"
            >
            <UiButton
              kind="primary"
              size="sm"
              :disabled="savingKey === row.key"
              :data-testid="`governance-save-${row.key}`"
              @click="saveDial(row)"
            >
              {{ savingKey === row.key ? 'Saving…' : 'Save' }}
            </UiButton>
          </div>
        </div>
      </div>
    </div>

    <p class="text-[11px] text-carbon-3 mt-4 leading-relaxed italic">
      Overrides cannot be removed in v1, only re-valued.
      <template v-if="!orgWide">
        Saving writes your region's override; the platform default is read-only here.
      </template>
    </p>
  </UiCard>
</template>
