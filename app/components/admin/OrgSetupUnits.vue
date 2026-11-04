<script setup lang="ts">
/*
 * Org setup step 3: tick the managers who should own a new Business Unit, one tab per
 * region. Existing owners are shown locked; changing them is done on the region page.
 * Ticks are a draft until "Save Business Units" (docs/design/org-setup/00-spec.md, Screens 3).
 */
import { computed, ref, watch } from 'vue'
import UiButton from '../ui/Button.vue'
import type { OrgSetupDraft } from '../../composables/useOrgSetupDraft'
import type { OrgTreeNode, OrgTreeRegion } from '#shared/org-setup/contract'
import { BU_LABEL, BU_LABEL_PLURAL } from '#shared/reports/vocabulary'
import {
  nodeLabel,
  ownsElsewhere,
  ownsIn,
  plural,
  unitChangeLines,
  unitParent,
  unitRows,
} from '../../utils/org-setup-view'

const props = defineProps<{
  nodes: OrgTreeNode[]
  regions: OrgTreeRegion[]
  draft: OrgSetupDraft
  initialRegion: string | null
}>()

const tab = ref<string>(props.initialRegion ?? props.regions[0]?.id ?? '')
watch(
  () => props.initialRegion,
  (id) => {
    if (id) tab.value = id
  },
)

const regionName = computed(() => new Map(props.regions.map((r) => [r.id, r.name])))
const region = computed(() => props.regions.find((r) => r.id === tab.value) ?? null)
const rows = computed(() => (tab.value ? unitRows(props.nodes, tab.value, props.draft.leaderChoices) : []))
/** Ticked on THIS tab: a draft for another region is that region's, whatever tab shows the person. */
const ticked = (oid: string) => props.draft.draftUnits[oid]?.regionId === tab.value

function parentText(n: OrgTreeNode): string {
  const p = unitParent(props.nodes, n.oid, tab.value, props.draft.draftUnits)
  return p ? `New unit inside ${p.name}` : `New unit inside ${regionName.value.get(tab.value) ?? 'this region'}'s default unit`
}
const changeLines = (oid: string) => unitChangeLines(props.draft.preview?.byNode[oid]?.groups ?? [])

function toggle(n: OrgTreeNode, on: boolean) {
  if (on) props.draft.tick(n, tab.value)
  else props.draft.untick(n.oid)
}

const saved = ref(false)
async function save() {
  saved.value = false
  saved.value = await props.draft.saveUnits()
}
watch(
  () => props.draft.unsavedUnits,
  (n, before) => {
    if (n > (before ?? 0)) saved.value = false
  },
)
</script>

<template>
  <section data-testid="org-setup-units" aria-labelledby="org-setup-units-title">
    <h2 id="org-setup-units-title" class="text-lg font-bold text-carbon">{{ BU_LABEL_PLURAL }}</h2>
    <p class="text-sm text-carbon-2 mt-1 max-w-3xl">
      Tick a manager to give them a new {{ BU_LABEL }}, with them as its owner. It sits inside the unit of the nearest manager above
      them who owns one or is ticked, else inside the region's default unit. Nobody moves until you confirm it on the last step.
    </p>

    <div class="flex flex-wrap gap-1 border-b border-calm-2 mt-4" role="tablist">
      <button
        v-for="r in regions"
        :key="r.id"
        type="button"
        role="tab"
        :aria-selected="tab === r.id"
        class="min-h-[44px] px-4 text-sm font-semibold border-b-2 -mb-px"
        :class="tab === r.id ? 'text-brand-harmony border-brand-harmony' : 'text-carbon-2 border-transparent hover:text-brand-harmony'"
        :data-testid="`org-setup-units-tab-${r.id}`"
        @click="tab = r.id"
      >
        {{ r.name }}
      </button>
    </div>

    <div class="flex flex-wrap items-center justify-between gap-3 mt-3">
      <p class="text-sm text-carbon" data-testid="org-setup-units-progress">
        {{ (region?.inUnit ?? 0).toLocaleString('en') }} of {{ (region?.users ?? 0).toLocaleString('en') }} in a {{ BU_LABEL }} today
      </p>
      <p class="text-[12px] text-carbon-3 min-h-4" aria-live="polite">
        <template v-if="draft.previewing">Updating…</template>
        <template v-else-if="draft.previewError">
          <span class="text-rag-red">{{ draft.previewError }}</span>
          <button type="button" class="ml-2 font-semibold text-brand-harmony hover:underline" @click="draft.refreshPreview()">Retry</button>
        </template>
      </p>
    </div>

    <p v-if="!rows.length" class="mt-4 text-sm text-carbon-2" data-testid="org-setup-units-empty">
      <template v-if="!region?.leaders.length">This region has no leader yet. Pick one on the Regions step first.</template>
      <template v-else>No one to tick here: this region's leaders are outside the top person's line, or nobody reports to them.</template>
    </p>
    <ul v-else class="mt-3 border border-calm-2 rounded-lg divide-y divide-calm-2">
      <li
        v-for="r in rows"
        :key="r.node.oid"
        class="py-2 pr-4"
        :style="{ paddingLeft: `${16 + r.depth * 28}px` }"
        :data-testid="`org-setup-unit-row-${r.node.oid}`"
      >
        <div class="flex flex-wrap items-start gap-3">
          <template v-if="ownsIn(r.node, tab)">
            <input
              :id="`org-setup-unit-${r.node.oid}`"
              type="checkbox"
              class="mt-1 w-5 h-5"
              checked
              disabled
              :data-testid="`org-setup-unit-check-${r.node.oid}`"
            >
            <div class="min-w-0 flex-1">
              <label :for="`org-setup-unit-${r.node.oid}`" class="font-semibold text-carbon">{{ nodeLabel(r.node) }}</label>
              <span class="text-[12px] text-carbon-3"> · {{ plural(r.node.users, 'person', 'people') }}</span>
              <div class="text-[12px] text-carbon-2" :data-testid="`org-setup-unit-owns-${r.node.oid}`">
                Owns {{ ownsIn(r.node, tab)!.name }}.
                <NuxtLink :to="`/admin/regions/${tab}`" class="text-brand-harmony hover:underline">Change it on the region page</NuxtLink>
              </div>
            </div>
          </template>
          <template v-else-if="ownsElsewhere(r.node, tab)">
            <input :id="`org-setup-unit-${r.node.oid}`" type="checkbox" class="mt-1 w-5 h-5" disabled :data-testid="`org-setup-unit-check-${r.node.oid}`">
            <div class="min-w-0 flex-1">
              <label :for="`org-setup-unit-${r.node.oid}`" class="font-semibold text-carbon">{{ nodeLabel(r.node) }}</label>
              <div class="text-[12px] text-carbon-2" :data-testid="`org-setup-unit-elsewhere-${r.node.oid}`">
                Owns {{ ownsElsewhere(r.node, tab)!.name }} in {{ regionName.get(ownsElsewhere(r.node, tab)!.regionId) ?? 'another region' }}.
              </div>
            </div>
          </template>
          <template v-else>
            <input
              :id="`org-setup-unit-${r.node.oid}`"
              type="checkbox"
              class="mt-1 w-5 h-5"
              :checked="ticked(r.node.oid)"
              :data-testid="`org-setup-unit-check-${r.node.oid}`"
              @change="toggle(r.node, ($event.target as HTMLInputElement).checked)"
            >
            <div class="min-w-0 flex-1">
              <label :for="`org-setup-unit-${r.node.oid}`" class="font-semibold text-carbon">{{ nodeLabel(r.node) }}</label>
              <span class="text-[12px] text-carbon-3"> · {{ plural(r.node.users, 'person', 'people') }}</span>
              <div v-if="ticked(r.node.oid)" class="mt-1 flex flex-wrap items-center gap-2">
                <label class="text-[12px] text-carbon-2">
                  Unit name
                  <input
                    :value="draft.draftUnits[r.node.oid]!.name"
                    class="ml-1 min-h-[44px] px-2 text-sm border border-calm-2 rounded-md"
                    :data-testid="`org-setup-unit-name-${r.node.oid}`"
                    @input="draft.rename(r.node.oid, ($event.target as HTMLInputElement).value)"
                  >
                </label>
                <span class="text-[12px] text-carbon-2" :data-testid="`org-setup-unit-parent-${r.node.oid}`">{{ parentText(r.node) }}</span>
              </div>
              <p v-if="draft.unitErrors[r.node.oid]" class="text-[12px] text-rag-red" role="alert" :data-testid="`org-setup-unit-error-${r.node.oid}`">
                {{ draft.unitErrors[r.node.oid] }}
              </p>
            </div>
          </template>
          <div class="text-[12px] text-carbon-2 sm:text-right" :data-testid="`org-setup-unit-note-${r.node.oid}`">
            <div v-for="line in changeLines(r.node.oid)" :key="line">{{ line }}</div>
            <div v-if="r.node.decidedBy['unit-rule']">{{ plural(r.node.decidedBy['unit-rule'], 'person is', 'people are') }} placed by a unit rule.</div>
          </div>
        </div>
      </li>
    </ul>

    <div class="mt-4 flex flex-wrap items-center gap-3">
      <UiButton kind="primary" :disabled="!draft.unsavedUnits || draft.saving !== null" data-testid="org-setup-units-save" @click="save">
        {{ draft.saving === 'units' ? 'Saving…' : `Save ${BU_LABEL_PLURAL}` }}
      </UiButton>
      <span v-if="draft.unsavedUnits" class="text-[12px] text-carbon-2">{{ plural(draft.unsavedUnits, `new ${BU_LABEL}`, `new ${BU_LABEL_PLURAL}`) }} not saved.</span>
      <span v-else-if="saved" class="text-[12px] text-carbon-2" role="status" data-testid="org-setup-units-saved">Saved. Nobody has moved yet.</span>
      <p v-if="draft.saveError" class="w-full text-[12px] text-rag-red" role="alert" data-testid="org-setup-units-save-error">{{ draft.saveError }}</p>
    </div>
  </section>
</template>
