<script setup lang="ts">
/*
 * Org setup overview (every visit after setup): the top person, the last directory
 * read and its cadence, one card per region, then the decisions the server lists
 * for an Admin (docs/design/org-setup/00-spec.md, Screens 5).
 */
import { computed, ref, watch } from 'vue'
import UiButton from '../ui/Button.vue'
import DirectoryPeoplePicker, { type DirectoryHit } from './DirectoryPeoplePicker.vue'
import OrgSetupMoveConfirm from './OrgSetupMoveConfirm.vue'
import { apiErrorDetail, isConfirmedRejection } from '../../composables/useApiError'
import { fmtTimeAgo } from '../../composables/useFormat'
import { applyShownRows, readLiveCheck } from '../../utils/placement-apply'
import {
  decisionData,
  groupLink,
  moveGroups,
  nodeLabel,
  placementCheckLink,
  plural,
  rowsInGroups,
  sideText,
} from '../../utils/org-setup-view'
import type {
  OrgSetupDecision,
  OrgSetupDecisionsResponse,
  OrgSetupUnitsResponse,
  OrgTreeResponse,
  ReadCadence,
} from '#shared/org-setup/contract'
import type { PlacementCheckRow } from '#shared/placement/placement-check'
import { BU_LABEL, BU_LABEL_PLURAL } from '#shared/reports/vocabulary'

const props = defineProps<{
  tree: OrgTreeResponse
  decisions: OrgSetupDecisionsResponse | null
  decisionsError: unknown
  readBusy: 'pass' | 'retry' | null
  refreshAll: () => Promise<void>
}>()
const emit = defineEmits<{
  'open-regions': [oid: string | null]
  'open-units': [regionId: string]
  'change-top': []
  'read-directory': []
  'retry-failed': []
}>()

const top = computed(() => props.tree.settings.top)
const topName = computed(() => top.value?.name ?? top.value?.email ?? top.value?.oid ?? '')
/** The Users page opened on the top person, where their home is changed. */
const topHomeLink = computed(() => {
  const h = props.tree.topHome
  if (!h || h.kind === 'not-a-user') return null
  return `/admin/users?region=${encodeURIComponent(h.regionId)}&q=${encodeURIComponent(h.email)}`
})
const read = computed(() => props.tree.read)

const cadenceBusy = ref(false)
const cadenceError = ref<string | null>(null)
async function setCadence(c: ReadCadence) {
  if (c === props.tree.settings.readCadence) return
  cadenceBusy.value = true
  cadenceError.value = null
  try {
    await $fetch('/api/v1/admin/org-setup/settings', { method: 'PUT', body: { readCadence: c } })
    await props.refreshAll()
  } catch (e: unknown) {
    cadenceError.value = apiErrorDetail(e, 'Could not change how often the directory is read.')
  } finally {
    cadenceBusy.value = false
  }
}

// Coverage and leaders are the server's (current homes, the leader table): a leader
// outside the tree still counts, and a branch still on Unplaced never reads as placed.
const regionCards = computed(() =>
  props.tree.regions.map((r) => ({
    ...r,
    leaderNames: r.leaders.map(nodeLabel),
    pct: r.users ? Math.round((r.inUnit / r.users) * 100) : null,
  })),
)
/** Beyond this many leaders a card names the first two and folds the rest. */
const LEADERS_SHOWN = 3
const leadersOpen = ref<Set<string>>(new Set())
function toggleLeaders(id: string) {
  const next = new Set(leadersOpen.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  leadersOpen.value = next
}

const list = computed(() => props.decisions?.decisions ?? [])
const busyKey = ref<string | null>(null)
const cardError = ref<Record<string, string>>({})
/** The last action's outcome; its card may be gone after the refetch. */
const notice = ref<string | null>(null)
const pickerFor = ref<string | null>(null)
const keyOf = (d: OrgSetupDecision) => `${d.kind}:${d.subjectKey}`

/** The server answered and refused this item (a per-item refusal in a 200), so nothing changed. */
class Refused extends Error {}

async function act(d: OrgSetupDecision, run: () => Promise<string | null>) {
  const key = keyOf(d)
  busyKey.value = key
  cardError.value = { ...cardError.value, [key]: '' }
  notice.value = null
  try {
    notice.value = await run()
    pickerFor.value = null
    await props.refreshAll()
  } catch (e: unknown) {
    if (e instanceof Refused || isConfirmedRejection(e)) {
      cardError.value = { ...cardError.value, [key]: apiErrorDetail(e, 'That did not work. Nothing was changed.') }
    } else {
      // It may have landed, and then this card is gone after the reload: say so where it stays visible.
      notice.value = 'We could not tell whether that went through. The decisions below have been reloaded: check them before trying again.'
      await props.refreshAll().catch(() => {})
    }
  } finally {
    busyKey.value = null
  }
}

// ── Moves waiting: the button counts the live rows its groups stand for ───────
const liveRows = ref<PlacementCheckRow[] | null>(null)
const liveError = ref<string | null>(null)
async function readLive() {
  liveRows.value = null
  liveError.value = null
  const { rows, error } = await readLiveCheck((rows) => rows)
  if (error) liveError.value = apiErrorDetail(error, 'Could not read the placement check.')
  else liveRows.value = rows
}
watch(
  () => props.decisions,
  () => {
    if (list.value.some((d) => d.kind === 'moves-waiting')) void readLive()
  },
  { immediate: true },
)

const cardGroups = (d: OrgSetupDecision) => moveGroups(decisionData(d).groups)
const liveFor = (d: OrgSetupDecision) => rowsInGroups(liveRows.value ?? [], cardGroups(d))
// A decision's groups come from the saved state, so every unit has an id and
// groupLink() is never null here; the fallback is the unfiltered page, as for several groups.
const reviewLink = (d: OrgSetupDecision) => {
  const g = cardGroups(d)
  return (g.length === 1 ? groupLink(g[0]!) : null) ?? placementCheckLink({})
}
const confirmFor = ref<OrgSetupDecision | null>(null)
const confirmRows = computed(() => (confirmFor.value ? liveFor(confirmFor.value) : []))
function moveGroup() {
  const d = confirmFor.value
  if (!d) return
  const rows = confirmRows.value
  return act(d, async () => {
    const { done, error } = await applyShownRows(rows)
    confirmFor.value = null
    if (error && !done.results.length) throw error
    const moved = done.results.filter((r) => r.outcome === 'moved').length
    const left = done.results.length - moved
    const stopped = !error
      ? ''
      : isConfirmedRejection(error)
        ? ' Moving stopped early; the rest were not moved.'
        : ' Moving stopped early, and we could not tell whether the last batch moved: the list below has been reloaded.'
    return `${plural(moved, 'person moved', 'people moved')}${left ? `; ${left} could not be moved and were left as they were` : ''}.${stopped}`
  })
}

function teamName(d: OrgSetupDecision) {
  const data = decisionData(d)
  return data.department ?? `${data.name ?? 'Their'}'s team`
}

/** The unit the new one would sit inside, as the server named it. */
function parentText(d: OrgSetupDecision) {
  const data = decisionData(d)
  if (data.parentUnitName) return data.parentUnitName
  return props.tree.regions.find((r) => r.id === data.regionId)?.name ?? 'its region'
}

// "Create a Business Unit" opens a form with the name first; only Create posts.
const createFor = ref<string | null>(null)
const createName = ref('')
function openCreate(d: OrgSetupDecision) {
  createFor.value = keyOf(d)
  createName.value = teamName(d)
  cardError.value = { ...cardError.value, [keyOf(d)]: '' }
}

function createTeam(d: OrgSetupDecision) {
  const name = createName.value.trim()
  if (!name) return
  return act(d, async () => {
    const data = decisionData(d)
    const res = await $fetch<OrgSetupUnitsResponse>('/api/v1/admin/org-setup/units', {
      method: 'POST',
      body: { items: [{ ownerOid: data.oid, name, regionId: data.regionId, parentUnitId: data.parentUnitId }] },
    })
    const r = res.results[0]
    if (r?.status === 'refused') throw new Refused(r.detail || r.reason)
    createFor.value = null
    return `Created ${name}. Nobody has moved yet; their moves wait here.`
  })
}

function dismiss(d: OrgSetupDecision) {
  return act(d, async () => {
    await $fetch('/api/v1/admin/org-setup/dismissals', { method: 'POST', body: { kind: d.kind, subjectKey: d.subjectKey } })
    return null
  })
}

const reason = (e: unknown) => apiErrorDetail(e, 'the request failed').replace(/\.$/, '')

/** Assigns the replacement, then removes the person who left; a failed removal is said, not hidden. */
function pickReplacement(d: OrgSetupDecision, hit: DirectoryHit) {
  return act(d, async () => {
    const data = decisionData(d)
    const who = hit.display_name ?? hit.email
    if (d.kind === 'owner-left') {
      const unit = `/api/v1/admin/org-units/${encodeURIComponent(data.orgUnitId ?? '')}/owners`
      await $fetch(unit, { method: 'POST', body: { oid: hit.oid } })
      const done = `${who} now owns ${data.unitName ?? `the ${BU_LABEL}`}.`
      if (!data.ownerTeammateId) return done
      try {
        await $fetch(`${unit}/${encodeURIComponent(data.ownerTeammateId)}`, { method: 'DELETE' })
      } catch (e: unknown) {
        return isConfirmedRejection(e)
          ? `New owner set, but the old owner could not be removed: ${reason(e)}. Remove them on the region page.`
          : 'New owner set. We could not tell whether the old owner was removed: check the region page.'
      }
      return done
    }
    const region = `/api/v1/admin/regions/${encodeURIComponent(data.regionId ?? '')}/leaders`
    await $fetch(region, {
      method: 'POST',
      body: { leader_oid: hit.oid, leader_email: hit.email, kind: 'region-svp', display_name: hit.display_name ?? undefined },
    })
    const done = `${who} now leads ${data.regionName ?? 'the region'}.`
    if (!data.leaderId) return done
    try {
      await $fetch(`${region}/${encodeURIComponent(data.leaderId)}`, { method: 'DELETE' })
    } catch (e: unknown) {
      return isConfirmedRejection(e)
        ? `New leader set, but the old leader could not be removed: ${reason(e)}. Remove them on the region page.`
        : 'New leader set. We could not tell whether the old leader was removed: check the region page.'
    }
    return done
  })
}
</script>

<template>
  <section data-testid="org-setup-overview">
    <div class="flex flex-wrap items-start justify-between gap-4 p-4 border border-calm-2 rounded-lg bg-white">
      <div class="text-sm text-carbon space-y-1">
        <p data-testid="org-setup-overview-top">
          Top of the organisation: <strong>{{ topName }}</strong>.
          <UiButton kind="ghost" size="sm" class="ml-1 min-h-[44px]" data-testid="org-setup-overview-change-top" @click="emit('change-top')">Change</UiButton>
        </p>
        <p v-if="tree.topHome" data-testid="org-setup-overview-top-home">
          <template v-if="tree.topHome.kind === 'not-a-user'">{{ topName }} is not a TokenScope user.</template>
          <template v-else>
            {{ topName }}'s own home in TokenScope:
            <template v-if="tree.topHome.kind === 'unassigned'">Unassigned.</template>
            <template v-else>{{ tree.topHome.regionName }} · {{ tree.topHome.unitName }}.</template>
            <NuxtLink
              v-if="topHomeLink"
              :to="topHomeLink"
              class="ml-1 min-h-[44px] inline-flex items-center font-semibold text-brand-harmony hover:underline"
              data-testid="org-setup-overview-top-home-link"
            >
              Change it on the Users page
            </NuxtLink>
          </template>
        </p>
        <p data-testid="org-setup-overview-read">
          <template v-if="!read.startedAt">The directory has not been read yet.</template>
          <template v-else-if="read.complete">Directory read {{ fmtTimeAgo(read.startedAt) }}.</template>
          <template v-else>Directory read started {{ fmtTimeAgo(read.startedAt) }}, {{ plural(read.remaining, 'person', 'people') }} left to read.</template>
          <template v-if="read.failed > 0">
            {{ ' ' }}<span data-testid="org-setup-overview-not-read">{{ plural(read.failed, 'person', 'people') }} not read.</span>
          </template>
          <UiButton
            v-if="read.remaining > 0"
            size="sm"
            class="ml-2 min-h-[44px]"
            :disabled="readBusy !== null"
            data-testid="org-setup-overview-read-button"
            @click="emit('read-directory')"
          >
            {{ readBusy === 'pass' ? 'Reading…' : 'Read directory' }}
          </UiButton>
        </p>
      </div>
      <div>
        <p id="org-setup-cadence-label" class="text-[12px] font-semibold text-carbon">Read the directory again every</p>
        <div class="mt-1 inline-flex rounded-md border border-calm-2 overflow-hidden" role="group" aria-labelledby="org-setup-cadence-label">
          <button
            v-for="c in (['month', 'week'] as const)"
            :key="c"
            type="button"
            class="min-h-[44px] px-4 text-sm font-semibold"
            :class="tree.settings.readCadence === c ? 'bg-brand-harmony text-white' : 'bg-white text-carbon-2 hover:text-brand-harmony'"
            :aria-pressed="tree.settings.readCadence === c"
            :disabled="cadenceBusy"
            :data-testid="`org-setup-cadence-${c}`"
            @click="setCadence(c)"
          >
            {{ c === 'month' ? 'Month' : 'Week' }}
          </button>
        </div>
        <p v-if="cadenceError" class="mt-1 text-[11px] text-rag-red" role="alert">{{ cadenceError }}</p>
      </div>
    </div>

    <div class="flex items-baseline justify-between mt-6">
      <h2 class="text-base font-bold text-carbon">Regions</h2>
      <UiButton kind="ghost" size="sm" class="min-h-[44px]" data-testid="org-setup-overview-regions" @click="emit('open-regions', null)">Change region leaders</UiButton>
    </div>
    <div class="mt-2 grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
      <div v-for="r in regionCards" :key="r.id" class="p-4 border border-calm-2 rounded-lg bg-white" :data-testid="`org-setup-region-card-${r.id}`">
        <h3 class="font-bold text-carbon">{{ r.name }}</h3>
        <p class="text-[12px] text-carbon-2 mt-1" :data-testid="`org-setup-region-card-leaders-${r.id}`">
          <template v-if="!r.leaderNames.length">No leader yet</template>
          <template v-else-if="r.leaderNames.length <= LEADERS_SHOWN">Led by {{ r.leaderNames.join(', ') }}</template>
          <template v-else>
            Led by {{ r.leaderNames.slice(0, 2).join(', ') }} and {{ r.leaderNames.length - 2 }} others
            <button
              type="button"
              class="ml-1 min-h-[44px] font-semibold text-brand-harmony hover:underline"
              :aria-expanded="leadersOpen.has(r.id)"
              :aria-controls="`org-setup-region-card-leaders-all-${r.id}`"
              :data-testid="`org-setup-region-card-leaders-more-${r.id}`"
              @click="toggleLeaders(r.id)"
            >
              {{ leadersOpen.has(r.id) ? 'Hide' : 'Show all' }}
            </button>
          </template>
        </p>
        <ul
          v-if="r.leaderNames.length > LEADERS_SHOWN && leadersOpen.has(r.id)"
          :id="`org-setup-region-card-leaders-all-${r.id}`"
          class="mt-1 text-[12px] text-carbon-2 list-disc pl-5"
          :data-testid="`org-setup-region-card-leaders-all-${r.id}`"
        >
          <li v-for="(n, i) in r.leaderNames" :key="i">{{ n }}</li>
        </ul>
        <p v-if="r.pct != null" class="text-sm text-carbon mt-2" :data-testid="`org-setup-region-card-pct-${r.id}`">
          {{ r.pct }}% in a {{ BU_LABEL }}
        </p>
        <p v-else class="text-sm text-carbon-3 mt-2" :data-testid="`org-setup-region-card-pct-${r.id}`">Nobody here yet</p>
        <UiButton size="sm" class="mt-3 min-h-[44px]" :data-testid="`org-setup-region-card-units-${r.id}`" @click="emit('open-units', r.id)">
          Set up {{ BU_LABEL_PLURAL }}
        </UiButton>
      </div>
    </div>

    <h2 class="text-base font-bold text-carbon mt-8" data-testid="org-setup-decisions-title">
      For you to decide <template v-if="decisions">({{ list.length }})</template><template v-else>(…)</template>
    </h2>
    <p v-if="decisionsError" class="mt-2 text-sm text-rag-red" role="alert">Could not load the decisions. Reload the page to try again.</p>
    <p v-else-if="decisions && !list.length" class="mt-2 text-sm text-carbon-2" data-testid="org-setup-decisions-empty">
      Nothing needs you right now. New people are placed from their manager when they first sign in; anyone the directory cannot place shows up here.
    </p>
    <p v-if="notice" class="mt-2 text-sm text-carbon" role="status" data-testid="org-setup-decision-notice">{{ notice }}</p>
    <div class="mt-3 space-y-3">
      <article
        v-for="d in list"
        :key="keyOf(d)"
        class="p-4 border border-calm-2 rounded-lg bg-white"
        :data-testid="`org-setup-decision-${d.kind}`"
      >
        <h3 class="font-bold text-carbon">{{ d.title }}</h3>
        <p class="text-sm text-carbon-2 mt-1">{{ d.detail }}</p>

        <ul v-if="d.kind === 'moves-waiting' && cardGroups(d).length" class="mt-2 text-sm space-y-0.5" data-testid="org-setup-decision-groups">
          <li v-for="(g, i) in cardGroups(d)" :key="i" class="flex flex-wrap items-baseline gap-x-2">
            <span class="font-semibold tabular-nums">{{ g.count.toLocaleString('en') }}</span>
            <span>{{ sideText(g.from) }} <span class="text-carbon-3">→</span> {{ sideText(g.to) }}</span>
            <NuxtLink v-if="groupLink(g)" :to="groupLink(g)!" class="text-[12px] font-semibold text-brand-harmony hover:underline" :data-testid="`org-setup-decision-see-who-${i}`">See who</NuxtLink>
          </li>
        </ul>

        <div class="mt-3 flex flex-wrap items-center gap-2">
          <template v-if="d.kind === 'moves-waiting'">
            <UiButton
              v-if="cardGroups(d).length"
              kind="primary"
              size="sm"
              class="min-h-[44px]"
              :disabled="busyKey !== null || liveRows === null || !liveFor(d).length"
              data-testid="org-setup-decision-move"
              @click="confirmFor = d"
            >
              <template v-if="busyKey === keyOf(d)">Moving…</template>
              <template v-else-if="liveRows === null">Move people…</template>
              <template v-else>Move {{ plural(liveFor(d).length, 'person', 'people') }}</template>
            </UiButton>
            <NuxtLink :to="reviewLink(d)" class="min-h-[44px] inline-flex items-center text-sm font-semibold text-brand-harmony hover:underline" data-testid="org-setup-decision-review">
              Review one by one
            </NuxtLink>
            <span v-if="liveError" class="w-full text-[12px] text-rag-red" role="alert" data-testid="org-setup-decision-live-error">
              {{ liveError }}
              <button type="button" class="ml-1 font-semibold text-brand-harmony hover:underline" @click="readLive">Retry</button>
            </span>
          </template>

          <template v-else-if="d.kind === 'new-team'">
            <UiButton
              v-if="decisionData(d).oid && decisionData(d).regionId"
              kind="primary"
              size="sm"
              class="min-h-[44px]"
              :disabled="busyKey !== null || createFor === keyOf(d)"
              :aria-expanded="createFor === keyOf(d)"
              data-testid="org-setup-decision-create-unit"
              @click="openCreate(d)"
            >
              Create a {{ BU_LABEL }} for {{ decisionData(d).name ?? 'them' }}
            </UiButton>
            <UiButton
              v-else
              kind="primary"
              size="sm"
              class="min-h-[44px]"
              data-testid="org-setup-decision-pick-region"
              @click="emit('open-regions', decisionData(d).oid)"
            >
              Pick a region
            </UiButton>
            <UiButton size="sm" class="min-h-[44px]" :disabled="busyKey !== null" data-testid="org-setup-decision-leave" @click="dismiss(d)">
              Leave them until the next read
            </UiButton>
          </template>

          <template v-else-if="d.kind === 'owner-left' || d.kind === 'leader-left'">
            <UiButton
              v-if="pickerFor !== keyOf(d)"
              kind="primary"
              size="sm"
              class="min-h-[44px]"
              :disabled="busyKey !== null"
              data-testid="org-setup-decision-choose"
              @click="pickerFor = keyOf(d)"
            >
              {{ d.kind === 'owner-left' ? 'Choose a new owner' : 'Choose a new leader' }}
            </UiButton>
            <NuxtLink
              v-if="decisionData(d).regionId"
              :to="`/admin/regions/${decisionData(d).regionId}`"
              class="min-h-[44px] inline-flex items-center text-sm font-semibold text-brand-harmony hover:underline"
            >
              Open the region
            </NuxtLink>
          </template>

          <template v-else-if="d.kind === 'new-head'">
            <UiButton
              kind="primary"
              size="sm"
              class="min-h-[44px]"
              data-testid="org-setup-decision-review-regions"
              @click="emit('open-regions', decisionData(d).oid)"
            >
              Review on the Regions step
            </UiButton>
            <UiButton size="sm" class="min-h-[44px]" :disabled="busyKey !== null" data-testid="org-setup-decision-leave" @click="dismiss(d)">
              Leave it until the next read
            </UiButton>
          </template>

          <UiButton
            v-else-if="d.kind === 'no-placement'"
            kind="primary"
            size="sm"
            class="min-h-[44px]"
            data-testid="org-setup-decision-pick-region"
            @click="emit('open-regions', decisionData(d).oid)"
          >
            Pick a region
          </UiButton>

          <UiButton
            v-else-if="d.kind === 'not-read'"
            kind="primary"
            size="sm"
            class="min-h-[44px]"
            :disabled="readBusy !== null"
            data-testid="org-setup-decision-retry"
            @click="emit('retry-failed')"
          >
            {{ readBusy === 'retry' ? 'Retrying…' : 'Retry failed' }}
          </UiButton>

          <template v-else-if="d.kind === 'unit-under-other-region'">
            <UiButton size="sm" class="min-h-[44px]" :disabled="busyKey !== null" data-testid="org-setup-decision-keep" @click="dismiss(d)">
              Keep it until the next read
            </UiButton>
            <NuxtLink
              v-if="decisionData(d).regionId"
              :to="`/admin/regions/${decisionData(d).regionId}`"
              class="min-h-[44px] inline-flex items-center text-sm font-semibold text-brand-harmony hover:underline"
            >
              Open the region
            </NuxtLink>
          </template>
        </div>

        <form
          v-if="d.kind === 'new-team' && createFor === keyOf(d)"
          class="mt-3 p-3 border border-calm-2 rounded-md bg-calm/10 space-y-2 max-w-xl"
          data-testid="org-setup-decision-create-form"
          @submit.prevent="createTeam(d)"
        >
          <label class="block text-[12px] font-semibold text-carbon">
            {{ BU_LABEL }} name
            <input
              v-model="createName"
              class="mt-1 block w-full min-h-[44px] px-2 text-sm border border-calm-2 rounded-md"
              maxlength="200"
              data-testid="org-setup-decision-create-name"
            >
          </label>
          <p class="text-[12px] text-carbon-2" data-testid="org-setup-decision-create-parent">It will sit inside {{ parentText(d) }}.</p>
          <div class="flex gap-2">
            <UiButton type="submit" kind="primary" size="sm" class="min-h-[44px]" :disabled="busyKey !== null || !createName.trim()" data-testid="org-setup-decision-create-go">
              {{ busyKey === keyOf(d) ? 'Creating…' : 'Create' }}
            </UiButton>
            <UiButton kind="ghost" size="sm" class="min-h-[44px]" :disabled="busyKey !== null" data-testid="org-setup-decision-create-cancel" @click="createFor = null">
              Cancel
            </UiButton>
          </div>
        </form>

        <DirectoryPeoplePicker
          v-if="pickerFor === keyOf(d)"
          class="mt-3"
          :label="d.kind === 'owner-left' ? 'New owner' : 'New region leader'"
          :action-label="d.kind === 'owner-left' ? 'Make owner' : 'Make leader'"
          :busy="busyKey !== null"
          :testid="`org-setup-decision-picker-${d.kind}`"
          @pick="pickReplacement(d, $event)"
        />
        <p v-if="cardError[keyOf(d)]" class="mt-2 text-[12px] text-rag-red" role="alert" data-testid="org-setup-decision-error">{{ cardError[keyOf(d)] }}</p>
      </article>
    </div>

    <OrgSetupMoveConfirm :open="confirmFor !== null" :rows="confirmRows" :busy="busyKey !== null" @confirm="moveGroup" @close="confirmFor = null" />
  </section>
</template>
