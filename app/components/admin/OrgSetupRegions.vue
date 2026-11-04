<script setup lang="ts">
/*
 * Org setup step 2: pick a region for each person under the top of the organisation.
 * Picks are a draft until "Save regions"; the "What this changes" column is the server
 * preview of the draft (docs/design/org-setup/00-spec.md, Screens 2).
 */
import { computed, nextTick, ref, watch } from 'vue'
import UiButton from '../ui/Button.vue'
import { apiErrorDetail } from '../../composables/useApiError'
import type { OrgSetupDraft } from '../../composables/useOrgSetupDraft'
import type { OrgTreeNode } from '#shared/org-setup/contract'
import { BU_LABEL } from '#shared/reports/vocabulary'
import {
  ancestors,
  childNodes,
  effectiveLeaderRegion,
  indexNodes,
  mostAlreadyThere,
  nodeLabel,
  plural,
  regionChangeLines,
  regionRows,
} from '../../utils/org-setup-view'

const props = defineProps<{
  nodes: OrgTreeNode[]
  regions: { id: string; name: string }[]
  topOid: string
  draft: OrgSetupDraft
  notRead: number
  focusOid: string | null
  refresh: () => Promise<void>
}>()

const NEW = '__new'
const SPLIT = '__split'

const rows = computed(() => regionRows(props.nodes, props.topOid))
const rowId = (oid: string) => `org-setup-region-row-${oid}`
const showSmall = ref(false)
const expanded = ref<Set<string>>(new Set())

function toggleExpanded(oid: string) {
  const next = new Set(expanded.value)
  if (next.has(oid)) next.delete(oid)
  else next.add(oid)
  expanded.value = next
}

// Opening at a person (a "No placement" decision): unfold the rows above them.
watch(
  () => [props.focusOid, props.nodes.length] as const,
  ([oid]) => {
    if (!oid) return
    const chain = ancestors(indexNodes(props.nodes), oid).filter((a) => a.oid !== props.topOid)
    if (!chain.length && rows.value.small.some((n) => n.oid === oid)) showSmall.value = true
    const top = chain[chain.length - 1]
    if (top && rows.value.small.some((n) => n.oid === top.oid)) showSmall.value = true
    expanded.value = new Set([...expanded.value, ...chain.map((a) => a.oid)])
    void nextTick(() => document.getElementById(rowId(oid))?.scrollIntoView?.({ block: 'center' }))
  },
  { immediate: true },
)

interface Row {
  node: OrgTreeNode
  depth: number
}
const visible = computed<Row[]>(() => {
  const out: Row[] = []
  const add = (n: OrgTreeNode, depth: number) => {
    out.push({ node: n, depth })
    if (expanded.value.has(n.oid)) for (const c of childNodes(props.nodes, n.oid)) if (c.users > 0) add(c, depth + 1)
  }
  for (const n of rows.value.main) add(n, 0)
  if (showSmall.value) for (const n of rows.value.small) add(n, 0)
  return out
})

const picked = (n: OrgTreeNode) => effectiveLeaderRegion(n, props.draft.leaderChoices)
const changeLines = (oid: string) => regionChangeLines(props.draft.preview?.byNode[oid]?.groups ?? [])

function onPick(n: OrgTreeNode, e: Event) {
  const el = e.target as HTMLSelectElement
  const value = el.value
  if (value === NEW || value === SPLIT) {
    el.value = picked(n) ?? ''
    if (value === NEW) openNewRegion(n.oid)
    else toggleExpanded(n.oid)
    return
  }
  props.draft.setLeader(n.oid, value || null)
}

const newRegionFor = ref<string | null>(null)
const newRegionName = ref('')
const newRegionCode = ref('')
const codeEdited = ref(false)
const creating = ref(false)
const newRegionError = ref<string | null>(null)

function openNewRegion(oid: string) {
  newRegionFor.value = oid
  newRegionName.value = ''
  newRegionCode.value = ''
  codeEdited.value = false
  newRegionError.value = null
}
watch(newRegionName, (name) => {
  if (!codeEdited.value) newRegionCode.value = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40)
})

async function createRegion() {
  const oid = newRegionFor.value
  if (!oid || !newRegionName.value.trim()) return
  creating.value = true
  newRegionError.value = null
  try {
    const created = await $fetch<{ id: string }>('/api/v1/admin/regions', {
      method: 'POST',
      body: { code: newRegionCode.value, display_name: newRegionName.value.trim() },
    })
    await props.refresh()
    props.draft.setLeader(oid, created.id)
    newRegionFor.value = null
  } catch (e: unknown) {
    newRegionError.value = apiErrorDetail(e, 'Could not create the region.')
  } finally {
    creating.value = false
  }
}

const saved = ref(false)
async function save() {
  saved.value = false
  saved.value = await props.draft.saveLeaders()
}
watch(
  () => props.draft.unsavedLeaders,
  (n) => {
    if (n) saved.value = false
  },
)
</script>

<template>
  <section data-testid="org-setup-regions" aria-labelledby="org-setup-regions-title">
    <h2 id="org-setup-regions-title" class="text-lg font-bold text-carbon">Regions</h2>
    <p class="text-sm text-carbon-2 mt-1 max-w-3xl">
      Pick a region for each person below. The people under them go to that region, unless a {{ BU_LABEL }} places them.
      Nobody moves until you confirm it on the last step.
    </p>
    <p v-if="notRead > 0" class="text-[12px] text-carbon-3 mt-1" data-testid="org-setup-regions-not-read">
      {{ plural(notRead, 'person was', 'people were') }} not read from the directory, so they are not counted here.
    </p>
    <p class="text-[12px] text-carbon-3 mt-1 min-h-4" aria-live="polite" data-testid="org-setup-preview-status">
      <template v-if="draft.previewing">Updating…</template>
      <template v-else-if="draft.previewError">
        <span class="text-rag-red">{{ draft.previewError }}</span>
        <button type="button" class="ml-2 font-semibold text-brand-harmony hover:underline" @click="draft.refreshPreview()">Retry</button>
      </template>
    </p>

    <div class="mt-3 overflow-x-auto border border-calm-2 rounded-lg">
      <table class="w-full text-sm">
        <thead class="bg-calm/30 text-left text-[12px] text-carbon-2">
          <tr>
            <th scope="col" class="px-4 py-2 font-semibold">Person</th>
            <th scope="col" class="px-4 py-2 font-semibold text-right">People</th>
            <th scope="col" class="px-4 py-2 font-semibold">What this changes</th>
            <th scope="col" class="px-4 py-2 font-semibold">Region</th>
          </tr>
        </thead>
        <tbody class="divide-y divide-calm-2">
          <tr v-for="r in visible" :id="rowId(r.node.oid)" :key="r.node.oid" :data-testid="`org-setup-region-row-${r.node.oid}`" :class="r.node.oid === focusOid ? 'bg-brand-harmony-sheer/40' : ''">
            <td class="px-4 py-2.5 align-top" :style="{ paddingLeft: `${16 + r.depth * 28}px` }">
              <div class="font-semibold text-carbon">{{ nodeLabel(r.node) }}</div>
              <div v-if="r.node.email" class="text-[11px] text-carbon-3">{{ r.node.email }}</div>
              <div v-if="r.node.owns.length" class="text-[11px] text-carbon-2 mt-0.5" :data-testid="`org-setup-region-owns-${r.node.oid}`">
                Their people follow their {{ BU_LABEL }}, {{ r.node.owns[0]!.name }}.
              </div>
            </td>
            <td class="px-4 py-2.5 align-top text-right tabular-nums">{{ r.node.users.toLocaleString('en') }}</td>
            <td class="px-4 py-2.5 align-top text-[12px] text-carbon-2" :data-testid="`org-setup-region-change-${r.node.oid}`">
              <template v-if="draft.preview">
                <div v-for="line in changeLines(r.node.oid)" :key="line">{{ line }}</div>
                <div v-if="!changeLines(r.node.oid).length" class="text-carbon-3">No region changes</div>
              </template>
              <div v-if="mostAlreadyThere(r.node, picked(r.node))" class="text-carbon-3" :data-testid="`org-setup-region-most-${r.node.oid}`">
                Most of them are there already.
              </div>
            </td>
            <td class="px-4 py-2.5 align-top">
              <label :for="`org-setup-region-pick-${r.node.oid}`" class="sr-only">Region for {{ nodeLabel(r.node) }}</label>
              <select
                :id="`org-setup-region-pick-${r.node.oid}`"
                :value="picked(r.node) ?? ''"
                class="min-h-[44px] px-2 py-2 text-sm border border-calm-2 rounded-md bg-white"
                :data-testid="`org-setup-region-pick-${r.node.oid}`"
                @change="onPick(r.node, $event)"
              >
                <option value="">No region</option>
                <option v-for="g in regions" :key="g.id" :value="g.id">{{ g.name }}</option>
                <option :value="NEW">+ New region…</option>
                <option :value="SPLIT">{{ expanded.has(r.node.oid) ? 'Hide their managers' : 'Pick a region for each of their managers' }}</option>
              </select>
              <p v-if="draft.leaderErrors[r.node.oid]" class="mt-1 text-[11px] text-rag-red" role="alert" :data-testid="`org-setup-region-error-${r.node.oid}`">
                {{ draft.leaderErrors[r.node.oid] }}
              </p>
              <form
                v-if="newRegionFor === r.node.oid"
                class="mt-2 p-3 border border-calm-2 rounded-md bg-calm/10 space-y-2"
                data-testid="org-setup-new-region"
                @submit.prevent="createRegion"
              >
                <label class="block text-[12px] font-semibold text-carbon">
                  Region name
                  <input v-model="newRegionName" class="mt-1 block w-full min-h-[44px] px-2 text-sm border border-calm-2 rounded-md" data-testid="org-setup-new-region-name">
                </label>
                <label class="block text-[12px] font-semibold text-carbon">
                  Code
                  <input v-model="newRegionCode" class="mt-1 block w-full min-h-[44px] px-2 text-sm border border-calm-2 rounded-md" data-testid="org-setup-new-region-code" @input="codeEdited = true">
                </label>
                <p v-if="newRegionError" class="text-[11px] text-rag-red" role="alert">{{ newRegionError }}</p>
                <div class="flex gap-2">
                  <UiButton type="submit" kind="primary" size="sm" :disabled="creating || !newRegionName.trim()" data-testid="org-setup-new-region-create">
                    {{ creating ? 'Creating…' : 'Create region' }}
                  </UiButton>
                  <UiButton kind="ghost" size="sm" @click="newRegionFor = null">Cancel</UiButton>
                </div>
              </form>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <button
      v-if="rows.small.length"
      type="button"
      class="mt-2 min-h-[44px] text-sm font-semibold text-brand-harmony hover:underline"
      :aria-expanded="showSmall"
      data-testid="org-setup-regions-show-small"
      @click="showSmall = !showSmall"
    >
      {{ showSmall ? 'Hide' : 'Show' }} {{ rows.small.length }} more {{ rows.small.length === 1 ? 'person' : 'people' }} with fewer than 5 users under them ({{ plural(rows.smallPeople, 'person', 'people') }})
    </button>

    <div class="mt-4 flex flex-wrap items-center gap-3">
      <UiButton kind="primary" :disabled="!draft.unsavedLeaders || draft.saving !== null" data-testid="org-setup-regions-save" @click="save">
        {{ draft.saving === 'leaders' ? 'Saving…' : 'Save regions' }}
      </UiButton>
      <span v-if="draft.unsavedLeaders" class="text-[12px] text-carbon-2">{{ plural(draft.unsavedLeaders, 'change', 'changes') }} not saved.</span>
      <span v-else-if="saved" class="text-[12px] text-carbon-2" role="status" data-testid="org-setup-regions-saved">Saved. Nobody has moved yet.</span>
    </div>
  </section>
</template>
