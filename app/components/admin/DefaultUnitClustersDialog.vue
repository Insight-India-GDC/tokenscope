<script setup lang="ts">
/*
 * DefaultUnitClustersDialog — the to-do list behind the catch-all warning (C9).
 *
 * A `(default)` unit holding hundreds of people is not a placement success. It is
 * the org tree reporting which units have no owner: those people landed there
 * because the manager-chain walk climbed past their own manager, found no nearer
 * owner, and hit the catch-all at the top — while every downstream report reads
 * them as "placed".
 *
 * SO THIS IS A TO-DO LIST, NOT A SCOLD. The occupants who do not belong are
 * grouped by THEIR OWN manager — "12 report to Lee Hughes" — because each cluster
 * is one concrete action: make that manager an owner of the Business Unit their team
 * belongs to, or place the cluster by hand from the worklist. Every one the admin
 * does subtracts itself from the number above, which is the property that makes a
 * warning get used instead of dismissed.
 *
 * "NOT LOOKED UP" IS ITS OWN NUMBER, deliberately. A teammate whose manager has
 * never been captured is not evidence of a misplacement — we have not asked. It is
 * shown separately, with the action that actually fixes it (a placement pass),
 * rather than inflating a warning that no amount of assigning owners could reduce.
 *
 * ── THE ADVICE IS NOT OFFERED WHERE IT WOULD BACKFIRE ─────────────────────────
 * "Make that manager an owner" is only a fix while the manager owns NOTHING else.
 * Give an existing owner a second active Business Unit and the chain walk can no
 * longer tell which of the two a report belongs to: it skips them entirely and
 * they place nobody — on the new unit OR the one they already owned. That is the
 * ambiguity the region page's own ⚠ warning exists to flag, so proposing it here
 * would be one screen telling an admin to create what another screen calls a
 * misconfiguration. `manager_owns_unit_count` comes back per cluster and the
 * action is replaced, for those rows, by the reason it is not on offer.
 */
import { ref, watch, type ComponentPublicInstance } from 'vue'
import { consola } from 'consola'
import UiButton from '../ui/Button.vue'
import { apiErrorDetail } from '../../composables/useApiError'
import { useModalA11y } from '../../composables/useModalA11y'

interface Cluster {
  manager_oid: string | null
  manager_label: string
  people: number
  /** Active cost-owning units this manager already owns. > 0 ⇒ making them an
   *  owner here makes them ambiguous, and they would then place NOBODY. */
  manager_owns_unit_count: number
}
interface OccupancyResponse {
  org_unit: { id: string; code: string; display_name: string; is_default: boolean }
  owners: Array<{ teammate_id: string; display_name: string | null; email: string }>
  threshold: number
  occupants: number
  direct_reports: number
  not_direct_reports: number
  manager_unknown: number
  warn: boolean
  clusters: Cluster[]
  clusters_truncated: boolean
}

const props = defineProps<{ orgUnitId: string | null; unitName: string }>()
const emit = defineEmits<{ close: []; 'open-worklist': [] }>()

// Shared dialog contract: Escape closes, Tab is trapped, Close takes focus on
// open (the content is read-only until it loads) and focus returns on close.
const dialogEl = ref<HTMLElement | null>(null)
const closeBtn = ref<ComponentPublicInstance | null>(null)
useModalA11y({
  isOpen: () => props.orgUnitId !== null,
  dialogEl,
  firstField: closeBtn,
  onClose: () => emit('close'),
})

const data = ref<OccupancyResponse | null>(null)
const loading = ref(false)
const error = ref<string | null>(null)

watch(
  () => props.orgUnitId,
  async (id) => {
    data.value = null
    error.value = null
    if (!id) return
    loading.value = true
    try {
      const get = $fetch as (url: string) => Promise<OccupancyResponse>
      data.value = await get(`/api/v1/admin/org-units/${id}/occupancy`)
    } catch (e) {
      consola.warn('default-unit occupancy failed', e)
      error.value = apiErrorDetail(e, 'Could not read this unit’s occupancy.')
    } finally {
      loading.value = false
    }
  },
  { immediate: true },
)
</script>

<template>
  <div
    v-if="orgUnitId"
    class="fixed inset-0 z-50 flex items-center justify-center bg-carbon/40 p-4"
    data-testid="default-clusters-overlay"
    @click.self="emit('close')"
  >
    <div
      ref="dialogEl"
      class="w-full max-w-2xl bg-white rounded-xl shadow-xl max-h-[85vh] overflow-y-auto"
      role="dialog"
      aria-modal="true"
      aria-labelledby="default-clusters-title"
      data-testid="default-clusters-dialog"
    >
      <div class="px-6 py-4 border-b border-calm-2 flex items-start justify-between gap-4">
        <div>
          <p class="text-xs font-bold uppercase tracking-[1.4px] text-brand-harmony">Catch-all</p>
          <h2 id="default-clusters-title" class="text-lg font-bold text-carbon mt-0.5">
            Who is in {{ unitName }} that should not be?
          </h2>
        </div>
        <UiButton ref="closeBtn" kind="ghost" size="sm" data-testid="default-clusters-close" @click="emit('close')">Close</UiButton>
      </div>

      <div class="px-6 py-4">
        <div v-if="loading" class="text-sm text-carbon-3 py-6 text-center">Loading…</div>
        <p v-else-if="error" class="text-xs text-rag-red" role="alert">{{ error }}</p>

        <template v-else-if="data">
          <p class="text-sm text-carbon-2 leading-relaxed">
            This is the region's fallback unit. Its expected occupants are the direct reports of
            <template v-if="data.owners.length">
              <strong>{{ data.owners.map((o) => o.display_name ?? o.email).join(', ') }}</strong>.
            </template>
            <template v-else>
              its owner — and it has <strong>no owner</strong>, so everyone here arrived by the
              catch-all.
            </template>
            Anyone else landed here because the manager chain climbed past their own manager and
            found no nearer owner. They read as “placed” everywhere downstream.
          </p>

          <div class="mt-4 grid grid-cols-2 md:grid-cols-4 gap-3">
            <div class="p-2.5 rounded-md border border-calm-2">
              <div class="text-lg font-bold text-carbon">{{ data.occupants }}</div>
              <div class="text-[11px] text-carbon-3">in this unit</div>
            </div>
            <div class="p-2.5 rounded-md border border-calm-2">
              <div class="text-lg font-bold text-carbon">{{ data.direct_reports }}</div>
              <div class="text-[11px] text-carbon-3">report to the owner</div>
            </div>
            <div class="p-2.5 rounded-md border border-calm-2">
              <div
                class="text-lg font-bold"
                :class="data.warn ? 'text-rag-amber' : 'text-carbon'"
                data-testid="default-clusters-not-direct"
              >
                {{ data.not_direct_reports }}
              </div>
              <div class="text-[11px] text-carbon-3">do not (warns above {{ data.threshold }})</div>
            </div>
            <div class="p-2.5 rounded-md border border-calm-2">
              <div class="text-lg font-bold text-carbon" data-testid="default-clusters-unknown">
                {{ data.manager_unknown }}
              </div>
              <div class="text-[11px] text-carbon-3">not looked up yet</div>
            </div>
          </div>

          <p
            v-if="data.manager_unknown > 0"
            class="text-[11px] text-carbon-3 mt-2 leading-relaxed"
            data-testid="default-clusters-unknown-hint"
          >
            “Not looked up yet” means no placement pass has read their manager from the directory,
            so they are not counted as misplaced — we have not asked. <strong>Re-resolve
            placement</strong> captures it as it goes.
          </p>

          <div v-if="data.clusters.length" class="mt-5" data-testid="default-clusters-list">
            <h3 class="text-[11px] font-bold uppercase tracking-[1.2px] text-carbon-3 mb-2">
              What to do next
            </h3>
            <p class="text-[11px] text-carbon-3 mb-2 leading-relaxed">
              Where the manager owns no Business Unit yet, making them the owner of the one their
              team belongs to — and re-resolving — moves the cluster out. Otherwise, place their
              people directly from the worklist.
            </p>
            <div class="rounded-lg border border-calm-2 divide-y divide-calm-2">
              <div
                v-for="c in data.clusters"
                :key="c.manager_oid ?? 'none'"
                class="flex items-start justify-between gap-3 px-4 py-2.5"
                :data-testid="`default-cluster-${c.manager_oid ?? 'none'}`"
              >
                <span class="text-sm text-carbon truncate">
                  <strong>{{ c.people }}</strong>
                  {{ c.people === 1 ? 'person reports' : 'people report' }} to
                  {{ c.manager_label }}
                </span>
                <!-- The action is only a fix while it leaves the manager owning
                     exactly one Business Unit. See the header. -->
                <span
                  v-if="c.manager_owns_unit_count === 0"
                  class="text-[11px] text-carbon-3 shrink-0 text-right"
                  :data-testid="`default-cluster-action-${c.manager_oid ?? 'none'}`"
                >
                  Make them the owner of their team's Business Unit
                </span>
                <span
                  v-else
                  class="text-[11px] text-rag-amber shrink-0 text-right max-w-[16rem]"
                  :data-testid="`default-cluster-ambiguous-${c.manager_oid ?? 'none'}`"
                >
                  Already owns {{ c.manager_owns_unit_count }}
                  {{ c.manager_owns_unit_count === 1 ? 'Business Unit' : 'Business Units' }} — giving
                  them another makes them ambiguous, and they would place nobody on any of them.
                  Place these people directly instead.
                </span>
              </div>
            </div>
            <p v-if="data.clusters_truncated" class="text-[11px] text-carbon-3 mt-2 italic">
              Showing the largest clusters only — the tail is many small ones.
            </p>
            <div class="mt-4">
              <UiButton kind="primary" size="sm" data-testid="default-clusters-worklist" @click="emit('open-worklist')">
                Open the placement worklist
              </UiButton>
            </div>
          </div>
          <p v-else class="text-sm text-carbon-2 mt-4" data-testid="default-clusters-empty">
            Nobody here is a stranger to this unit — every occupant whose manager we know reports
            to its owner. Nothing to do.
          </p>
        </template>
      </div>
    </div>
  </div>
</template>
