<script setup lang="ts">
/*
 * Org setup step 4: what the saved choices move, and moving them. "Save and move"
 * saves any unsaved draft first, reads the live placement check, keeps only the rows
 * the groups on this screen stand for (plus the hand-placed people ticked), asks once,
 * then applies those rows and no others (docs/design/org-setup/00-spec.md, Screens 4).
 */
import { computed, ref } from 'vue'
import UiButton from '../ui/Button.vue'
import OrgSetupMoveConfirm from './OrgSetupMoveConfirm.vue'
import { apiErrorDetail } from '../../composables/useApiError'
import type { OrgSetupDraft } from '../../composables/useOrgSetupDraft'
import { PLACEMENT_VERDICT_TEXT } from '../../utils/placement-check-view'
import { applyShownRows, readLiveCheck } from '../../utils/placement-apply'
import {
  groupLink,
  groupMovesRegion,
  moveGroups,
  placementCheckLink,
  plural,
  rowsToApply,
  sideText,
  withCreatedUnitIds,
} from '../../utils/org-setup-view'
import type { PlacementCheckRow, PlacementVerdict } from '#shared/placement/placement-check'

const props = defineProps<{ draft: OrgSetupDraft }>()
const emit = defineEmits<{ later: []; moved: [] }>()

const preview = computed(() => props.draft.preview)
/** A unit the preview names by its draft key is named by its id once this draft created it, for the links and the live check. */
const groups = computed(() => withCreatedUnitIds(moveGroups(preview.value?.groups ?? []), props.draft.createdUnits))
/** A group still aimed at an unsaved unit has no link: nobody is in that unit until it exists. */
const groupRows = computed(() => groups.value.map((g) => ({ ...g, link: groupLink(g) })))
/** A preview still loading or failed may not match the choices; nothing is applied from it. */
const previewStale = computed(() => props.draft.previewing || props.draft.previewError !== null)
const regionMoves = computed(() => groups.value.some(groupMovesRegion))
const notMoved = computed(() =>
  (Object.entries(preview.value?.notMoved ?? {}) as [PlacementVerdict, number][]).filter(([, n]) => n > 0),
)
const manual = computed(() => preview.value?.manual ?? [])
const manualTicked = ref<Set<string>>(new Set())
function toggleManual(id: string, on: boolean) {
  const next = new Set(manualTicked.value)
  if (on) next.add(id)
  else next.delete(id)
  manualTicked.value = next
}
const moveTotal = computed(() => groups.value.reduce((s, g) => s + g.count, 0) + manualTicked.value.size)
/** Nothing left to save or move: the only way on is back to the overview. */
const nothingLeft = computed(
  () => !!preview.value && !previewStale.value && moveTotal.value === 0 && !props.draft.unsavedLeaders && !props.draft.unsavedUnits,
)

const busy = ref(false)
/** "Move people later" is saving the unsaved choices before leaving. */
const leaving = ref(false)
const error = ref<string | null>(null)
const result = ref<{ moved: number; refused: number } | null>(null)
/** The rows read from the live check for the confirmation; applied as shown, or dropped on Cancel. */
const toConfirm = ref<PlacementCheckRow[] | null>(null)

/** Saves the unsaved leader and unit choices. False, with the error shown, when any did not save. */
async function saveChoices(consequence: string): Promise<boolean> {
  if (!(await props.draft.saveLeaders())) {
    error.value = `Some region leaders were not saved${consequence}. See the Regions step.`
    return false
  }
  if (!(await props.draft.saveUnits())) {
    error.value = `Some Business Units were not created${consequence}. See the Business Units step.`
    return false
  }
  return true
}

async function saveAndRead() {
  if (previewStale.value) return
  busy.value = true
  error.value = null
  result.value = null
  try {
    if (!(await saveChoices(', so nobody was moved'))) return
    const shown = groups.value
    const ticked = manualTicked.value
    const { rows, error: e } = await readLiveCheck((live) => rowsToApply(live, shown, ticked))
    if (e) {
      error.value = apiErrorDetail(e, 'Could not read the placement check. Nobody was moved.')
      return
    }
    if (!rows.length) {
      error.value = 'Nobody in these groups is waiting to move in the placement check now. Nobody was moved.'
      return
    }
    toConfirm.value = rows
  } finally {
    busy.value = false
  }
}

async function move() {
  const rows = toConfirm.value
  if (!rows) return
  busy.value = true
  error.value = null
  try {
    const { done, error: e } = await applyShownRows(rows)
    const moved = done.results.filter((r) => r.outcome === 'moved').length
    result.value = { moved, refused: done.results.length - moved }
    if (e) {
      error.value = done.results.length
        ? apiErrorDetail(e, `Moving stopped after ${done.results.length} of ${rows.length}; the rest were not moved.`)
        : apiErrorDetail(e, 'Moving failed. Nobody was moved.')
    }
    manualTicked.value = new Set()
    if (done.results.length) emit('moved')
  } finally {
    toConfirm.value = null
    busy.value = false
    props.draft.refreshPreview()
  }
}

/** Saves the unsaved choices without moving anyone, then leaves; stays here with the errors when a save fails. */
async function later() {
  leaving.value = true
  error.value = null
  result.value = null
  try {
    if (await saveChoices('')) emit('later')
  } finally {
    leaving.value = false
  }
}
</script>

<template>
  <section data-testid="org-setup-review" aria-labelledby="org-setup-review-title">
    <h2 id="org-setup-review-title" class="text-lg font-bold text-carbon">Review and apply</h2>
    <p class="text-sm text-carbon-2 mt-1 max-w-3xl">
      What moves when you confirm, worked out from the directory with your choices.
      <template v-if="draft.unsavedLeaders || draft.unsavedUnits">Your unsaved choices are saved first.</template>
    </p>
    <p class="text-[12px] text-carbon-3 mt-1 min-h-4" aria-live="polite" data-testid="org-setup-review-status">
      <template v-if="draft.previewing">Updating…</template>
      <template v-else-if="draft.previewError">
        <span class="text-rag-red">{{ draft.previewError }}</span>
        <button type="button" class="ml-2 font-semibold text-brand-harmony hover:underline" data-testid="org-setup-review-retry" @click="draft.refreshPreview()">
          Retry
        </button>
      </template>
    </p>

    <div v-if="!preview" class="mt-3 text-sm text-carbon-3" data-testid="org-setup-review-pending">
      <template v-if="draft.previewError">Nothing to show until the preview works.</template>
      <template v-else>Working out what moves…</template>
    </div>
    <template v-else>
      <h3 class="mt-4 text-sm font-bold text-carbon">Everything waiting to move once you save, including moves left from earlier</h3>
      <ul v-if="groups.length" class="mt-2 border border-calm-2 rounded-lg divide-y divide-calm-2" data-testid="org-setup-review-groups">
        <li v-for="(g, i) in groupRows" :key="i" class="flex flex-wrap items-baseline gap-x-3 px-4 py-2.5 text-sm" :data-testid="`org-setup-review-group-${i}`">
          <span class="font-semibold tabular-nums">{{ g.count.toLocaleString('en') }}</span>
          <span>{{ sideText(g.from) }} <span class="text-carbon-3">→</span> {{ sideText(g.to) }}</span>
          <NuxtLink v-if="g.link" :to="g.link" class="ml-auto text-[12px] font-semibold text-brand-harmony hover:underline" :data-testid="`org-setup-review-see-who-${i}`">See who</NuxtLink>
          <span v-else class="ml-auto text-[12px] text-carbon-3" :data-testid="`org-setup-review-save-first-${i}`">Save first to see who</span>
        </li>
      </ul>
      <p v-else class="mt-2 text-sm text-carbon-2" data-testid="org-setup-review-no-moves">Nobody needs to move.</p>
      <p v-if="regionMoves" class="mt-2 text-[12px] text-carbon-2" data-testid="org-setup-review-region-note">
        Each person is signed out of the web app once. Reports show their usage, including what they have already recorded, where they sit now.
      </p>

      <template v-if="manual.length">
        <h3 class="mt-5 text-sm font-bold text-carbon">Placed by an admin</h3>
        <p class="text-[12px] text-carbon-2">An admin placed these people by hand. Tick the ones to move anyway.</p>
        <ul class="mt-2 border border-calm-2 rounded-lg divide-y divide-calm-2" data-testid="org-setup-review-manual">
          <li v-for="m in manual" :key="m.teammateId" class="px-4 py-2">
            <label class="flex items-start gap-3 min-h-[44px] cursor-pointer">
              <input
                type="checkbox"
                class="mt-1 w-5 h-5"
                :checked="manualTicked.has(m.teammateId)"
                :data-testid="`org-setup-review-manual-${m.teammateId}`"
                @change="toggleManual(m.teammateId, ($event.target as HTMLInputElement).checked)"
              >
              <span class="text-sm">
                <span class="font-semibold">{{ m.name ?? m.email }}</span>
                <span class="block text-[12px] text-carbon-2">{{ m.from }} → {{ m.to }}</span>
              </span>
            </label>
          </li>
        </ul>
      </template>

      <template v-if="notMoved.length">
        <h3 class="mt-5 text-sm font-bold text-carbon">Not moved, and why</h3>
        <ul class="mt-2 space-y-1 text-sm" data-testid="org-setup-review-not-moved">
          <li v-for="[v, n] in notMoved" :key="v" :data-testid="`org-setup-review-not-moved-${v}`">
            <span class="font-semibold tabular-nums">{{ n.toLocaleString('en') }}</span>
            {{ PLACEMENT_VERDICT_TEXT[v].label }}: {{ PLACEMENT_VERDICT_TEXT[v].hint }}
            <NuxtLink :to="placementCheckLink({ verdict: v })" class="text-[12px] font-semibold text-brand-harmony hover:underline">See who</NuxtLink>
          </li>
        </ul>
      </template>
    </template>

    <p v-if="error" class="mt-4 text-sm text-rag-red" role="alert" data-testid="org-setup-review-error">{{ error }}</p>
    <p v-if="result" class="mt-4 text-sm text-carbon" role="status" data-testid="org-setup-review-result">
      {{ plural(result.moved, 'person moved', 'people moved') }}<template v-if="result.refused">; {{ result.refused }} could not be moved and were left as they were</template>.
    </p>

    <div v-if="nothingLeft" class="mt-5">
      <UiButton kind="primary" data-testid="org-setup-review-done" @click="emit('later')">Back to overview</UiButton>
    </div>
    <div v-else class="mt-5 flex flex-wrap gap-3">
      <UiButton kind="primary" :disabled="busy || leaving || draft.saving !== null || !preview || previewStale" data-testid="org-setup-review-apply" @click="saveAndRead">
        {{ busy ? 'Working…' : `Save and move ${plural(moveTotal, 'person', 'people')}` }}
      </UiButton>
      <UiButton kind="secondary" :disabled="busy || leaving || draft.saving !== null" data-testid="org-setup-review-later" @click="later">
        {{ leaving ? 'Saving…' : 'Move people later' }}
      </UiButton>
    </div>

    <OrgSetupMoveConfirm :open="toConfirm !== null" :rows="toConfirm ?? []" :busy="busy" @confirm="move" @close="toConfirm = null" />
  </section>
</template>
