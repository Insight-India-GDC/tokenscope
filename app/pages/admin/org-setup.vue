<script setup lang="ts">
/*
 * Admin → Org setup (docs/design/org-setup/00-spec.md). Admin (platform-admin) only.
 * Pick the top of the organisation, read the directory, choose region leaders and
 * Business Unit owners, then move people through the placement check's apply.
 * The page never works out placement itself: every count is the server's.
 */
import { computed, ref, watch } from 'vue'
import UiButton from '../../components/ui/Button.vue'
import { useAdminAccess } from '../../composables/useAdminAccess'
import { apiErrorDetail } from '../../composables/useApiError'
import { usePlacementRead } from '../../composables/usePlacementRead'
import { useOrgSetupDraft } from '../../composables/useOrgSetupDraft'
import DirectoryPeoplePicker, { type DirectoryHit } from '../../components/admin/DirectoryPeoplePicker.vue'
import OrgSetupRegions from '../../components/admin/OrgSetupRegions.vue'
import OrgSetupUnits from '../../components/admin/OrgSetupUnits.vue'
import OrgSetupReview from '../../components/admin/OrgSetupReview.vue'
import OrgSetupOverview from '../../components/admin/OrgSetupOverview.vue'
import { plural } from '../../utils/org-setup-view'
import type { OrgSetupDecisionsResponse, OrgTreeResponse } from '#shared/org-setup/contract'
import { BU_LABEL_PLURAL } from '#shared/reports/vocabulary'

definePageMeta({ layout: 'admin', middleware: 'admin' })

const { isPlatform } = useAdminAccess()

// Lazy, client-only, null default: docs/design/admin-nav-responsiveness.md D1/D2.
const { data: tree, error: treeError, refresh: refreshTree } = useLazyFetch<OrgTreeResponse | null>('/api/v1/admin/org-setup/tree', {
  server: false,
  default: () => null,
  immediate: isPlatform.value,
})
const { data: decisions, error: decisionsError, refresh: refreshDecisions } = useLazyFetch<OrgSetupDecisionsResponse | null>(
  '/api/v1/admin/org-setup/decisions',
  { server: false, default: () => null, immediate: isPlatform.value },
)
async function refreshAll() {
  await Promise.all([refreshTree(), refreshDecisions()])
}

type Step = 'top' | 'regions' | 'units' | 'review'
const SETUP_STEPS = [
  { key: 'regions', n: 2, label: 'Regions' },
  { key: 'units', n: 3, label: BU_LABEL_PLURAL },
  { key: 'review', n: 4, label: 'Review and apply' },
] as const
const step = ref<Step | null>(null)
const topSet = computed(() => tree.value?.settings.top != null)
const showTop = computed(() => tree.value != null && (!topSet.value || step.value === 'top'))
const inSetup = computed(() => topSet.value && step.value != null && step.value !== 'top')

// ── Directory read ──────────────────────────────────────────────────────────
const readState = computed(() => tree.value?.read ?? null)
const read = usePlacementRead({ refresh: refreshTree, remaining: () => tree.value?.read.remaining ?? 0 })
const { busy: readBusy, error: readError, stopRequested, runStartRemaining, retryResult } = read
async function readDirectory(retryFailed: boolean) {
  await read.runPass(retryFailed)
  await refreshDecisions()
}
const remaining = computed(() => readState.value?.remaining ?? 0)
const failed = computed(() => readState.value?.failed ?? 0)
const readTotal = computed(() => runStartRemaining.value ?? remaining.value)
const readDone = computed(() => Math.max(0, readTotal.value - remaining.value))

// ── Step 1: top of the organisation ─────────────────────────────────────────
const chosen = ref<DirectoryHit | null>(null)
const savingTop = ref(false)
const topError = ref<string | null>(null)
/** Picking again from the overview: the picker, prefilled with the current person. */
const changingTop = ref(false)
/** A different person was picked; the new read is said before it starts. */
const topChangeWarned = ref(false)
const topMode = computed<'pick' | 'change' | 'read'>(() => (!topSet.value ? 'pick' : changingTop.value ? 'change' : 'read'))
const sameTop = computed(() => chosen.value != null && chosen.value.oid === tree.value?.settings.top?.oid)

function changeTop() {
  const t = tree.value?.settings.top
  if (!t) return
  chosen.value = { oid: t.oid, email: t.email ?? '', display_name: t.name, department: null, job_title: null }
  changingTop.value = true
  topChangeWarned.value = false
  topError.value = null
  step.value = 'top'
}
function cancelChangeTop() {
  changingTop.value = false
  topChangeWarned.value = false
  chosen.value = null
  step.value = null
}

async function saveTop() {
  const hit = chosen.value
  if (!hit) return
  if (changingTop.value) {
    if (sameTop.value) return cancelChangeTop()
    if (!topChangeWarned.value) {
      topChangeWarned.value = true
      return
    }
  }
  savingTop.value = true
  topError.value = null
  try {
    await $fetch('/api/v1/admin/org-setup/settings', {
      method: 'PUT',
      body: { top: { oid: hit.oid, name: hit.display_name, email: hit.email } },
    })
    changingTop.value = false
    topChangeWarned.value = false
    step.value = 'top'
    await refreshTree()
  } catch (e: unknown) {
    topError.value = apiErrorDetail(e, 'Could not save the top of the organisation.')
    return
  } finally {
    savingTop.value = false
  }
  await readDirectory(false)
}

// ── Setup steps ─────────────────────────────────────────────────────────────
const draft = useOrgSetupDraft({ nodes: () => tree.value?.nodes ?? [], refresh: refreshAll })
watch(inSetup, (on) => (draft.active = on), { immediate: true })

const focusOid = ref<string | null>(null)
const unitsRegion = ref<string | null>(null)
function openRegions(oid: string | null) {
  focusOid.value = oid
  step.value = 'regions'
}
function openUnits(regionId: string) {
  unitsRegion.value = regionId
  step.value = 'units'
}
function toOverview() {
  step.value = null
  focusOid.value = null
  void refreshDecisions()
}
const stepIndex = computed(() => SETUP_STEPS.findIndex((s) => s.key === step.value))
</script>

<template>
  <div class="max-w-[1600px] mx-auto px-10 py-8 pb-20" data-testid="admin-org-setup" data-admin-page="/admin/org-setup">
    <UiPageHead
      eyebrow="Organisation"
      title="Org setup"
      sub="Place everyone by deciding about managers, not about individual people."
    />
    <p v-if="!isPlatform" class="text-sm text-carbon-2">Only an Admin can set up the organisation.</p>
    <template v-else>
      <UiFetchErrorBanner v-if="treeError" :error="treeError" label="Org setup" @retry="refreshTree" />
      <AdminPageSkeleton v-else-if="tree == null" :tiles="3" :rows="6" />

      <section v-else-if="showTop" class="max-w-2xl" data-testid="org-setup-top" aria-labelledby="org-setup-top-title">
        <p class="text-xs font-bold uppercase tracking-[1.4px] text-brand-harmony">Step 1 of 4</p>
        <h2 id="org-setup-top-title" class="text-lg font-bold text-carbon mt-1">Who is at the top of the organisation?</h2>

        <template v-if="topMode !== 'read'">
          <p class="text-sm text-carbon-2 mt-1">
            Everyone whose manager chain reaches this person is set up from here. Usually the CEO.
          </p>
          <DirectoryPeoplePicker
            class="mt-4"
            label="Top of the organisation"
            action-label="Choose"
            testid="org-setup-top-picker"
            @pick="chosen = $event; topChangeWarned = false"
          />
          <div v-if="chosen" class="mt-4 p-3 border border-calm-2 rounded-md flex flex-wrap items-center gap-3" data-testid="org-setup-top-chosen">
            <div class="flex-1 min-w-0">
              <div class="font-semibold text-carbon">{{ chosen.display_name ?? chosen.email }}</div>
              <div class="text-[12px] text-carbon-3">{{ chosen.email }}</div>
            </div>
            <p v-if="topChangeWarned" class="w-full text-sm text-carbon" role="status" data-testid="org-setup-top-change-warning">
              Changing the top person starts a new directory read.
            </p>
            <UiButton kind="primary" :disabled="savingTop" data-testid="org-setup-top-save" @click="saveTop">
              <template v-if="savingTop">Saving…</template>
              <template v-else-if="topMode === 'change' && sameTop">Keep {{ chosen.display_name ?? chosen.email }}</template>
              <template v-else-if="topChangeWarned">Change and read the directory</template>
              <template v-else>Save and read the directory</template>
            </UiButton>
            <UiButton v-if="topMode === 'change'" kind="ghost" :disabled="savingTop" data-testid="org-setup-top-cancel" @click="cancelChangeTop">Cancel</UiButton>
          </div>
          <p v-if="topError" class="mt-2 text-sm text-rag-red" role="alert" data-testid="org-setup-top-error">{{ topError }}</p>
        </template>

        <template v-else>
          <p class="text-sm text-carbon mt-1" data-testid="org-setup-top-name">
            {{ tree.settings.top?.name ?? tree.settings.top?.email }}. Now reading everyone's manager from the directory.
          </p>
          <div class="mt-4" data-testid="org-setup-read">
            <div
              class="h-2.5 bg-calm-2 rounded-full overflow-hidden"
              role="progressbar"
              aria-label="Directory read"
              aria-valuemin="0"
              :aria-valuemax="readTotal"
              :aria-valuenow="readDone"
            >
              <div class="h-full bg-brand-harmony transition-[width]" :style="{ width: readTotal ? `${(readDone / readTotal) * 100}%` : '100%' }" />
            </div>
            <p class="mt-2 text-sm text-carbon" data-testid="org-setup-read-progress">
              {{ readDone.toLocaleString('en') }} of {{ readTotal.toLocaleString('en') }} people read.
            </p>
            <p v-if="retryResult" class="text-[12px] text-carbon-3" data-testid="org-setup-retry-result">
              Retried {{ retryResult.checked }}: {{ retryResult.checked - retryResult.errors }} read, {{ retryResult.errors }} still failing.
            </p>
            <p v-if="readError" class="mt-1 text-sm text-rag-red" role="alert" data-testid="org-setup-read-error">{{ readError }}</p>
          </div>

          <div class="mt-4 flex flex-wrap items-center gap-3">
            <UiButton
              v-if="remaining > 0 && readBusy === null"
              kind="primary"
              data-testid="org-setup-read-continue-reading"
              @click="readDirectory(false)"
            >
              Read directory ({{ remaining.toLocaleString('en') }} left)
            </UiButton>
            <UiButton v-if="readBusy === 'pass'" :disabled="stopRequested" data-testid="org-setup-read-stop" @click="stopRequested = true">
              {{ stopRequested ? 'Stopping after this pass…' : 'Stop' }}
            </UiButton>
            <template v-if="remaining === 0 && failed > 0">
              <p class="w-full text-sm text-carbon-2" data-testid="org-setup-read-failed">
                {{ plural(failed, 'person', 'people') }} could not be read from the directory.
              </p>
              <UiButton :disabled="readBusy !== null" data-testid="org-setup-read-retry" @click="readDirectory(true)">
                {{ readBusy === 'retry' ? 'Retrying…' : 'Retry failed' }}
              </UiButton>
              <UiButton kind="primary" :disabled="readBusy !== null" data-testid="org-setup-read-continue-without" @click="step = 'regions'">
                Continue without {{ plural(failed, 'person', 'people') }}
              </UiButton>
            </template>
            <UiButton
              v-else
              kind="primary"
              :disabled="remaining > 0 || readBusy !== null"
              data-testid="org-setup-read-continue"
              @click="step = 'regions'"
            >
              Continue
            </UiButton>
          </div>
        </template>
      </section>

      <template v-else-if="inSetup">
        <nav aria-label="Setup steps" class="mb-6 flex flex-wrap items-center gap-2" data-testid="org-setup-stepper">
          <ol class="flex flex-wrap gap-2">
            <li v-for="(s, i) in SETUP_STEPS" :key="s.key">
              <button
                type="button"
                class="min-h-[44px] px-4 rounded-full border text-sm font-semibold"
                :class="step === s.key ? 'bg-brand-harmony text-white border-brand-harmony' : i < stepIndex ? 'border-brand-harmony text-brand-harmony bg-white' : 'border-calm-2 text-carbon-2 bg-white'"
                :aria-current="step === s.key ? 'step' : undefined"
                :data-testid="`org-setup-step-${s.key}`"
                @click="step = s.key"
              >
                {{ s.n }}. {{ s.label }}
              </button>
            </li>
          </ol>
          <span class="flex-1" />
          <UiButton kind="ghost" size="sm" class="min-h-[44px]" data-testid="org-setup-to-overview" @click="toOverview">Back to overview</UiButton>
        </nav>

        <OrgSetupRegions
          v-if="step === 'regions'"
          :nodes="tree.nodes"
          :regions="tree.regions"
          :top-oid="tree.settings.top!.oid"
          :draft="draft"
          :not-read="failed"
          :focus-oid="focusOid"
          :refresh="refreshAll"
        />
        <OrgSetupUnits v-else-if="step === 'units'" :nodes="tree.nodes" :regions="tree.regions" :draft="draft" :initial-region="unitsRegion" />
        <OrgSetupReview v-else-if="step === 'review'" :draft="draft" @later="toOverview" @moved="refreshAll" />

        <div class="mt-8 flex gap-3">
          <UiButton v-if="stepIndex > 0" data-testid="org-setup-back" @click="step = SETUP_STEPS[stepIndex - 1]!.key">Back</UiButton>
          <UiButton v-if="stepIndex < SETUP_STEPS.length - 1" kind="primary" data-testid="org-setup-next" @click="step = SETUP_STEPS[stepIndex + 1]!.key">
            Next: {{ SETUP_STEPS[stepIndex + 1]!.label }}
          </UiButton>
        </div>
      </template>

      <OrgSetupOverview
        v-else
        :tree="tree"
        :decisions="decisions"
        :decisions-error="decisionsError"
        :read-busy="readBusy"
        :refresh-all="refreshAll"
        @open-regions="openRegions"
        @open-units="openUnits"
        @change-top="changeTop"
        @read-directory="readDirectory(false)"
        @retry-failed="readDirectory(true)"
      />
    </template>
  </div>
</template>
