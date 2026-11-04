<script setup lang="ts">
/*
 * ReResolvePlacementDialog — apply the current placement configuration to the
 * people who already exist in this region (spec C7).
 *
 * PREVIEW FIRST, ALWAYS. Opening runs a DRY RUN: how many would move, and to
 * where. Nothing is written until the admin clicks Apply, and the endpoint's
 * `dry_run` defaults to true so a mis-shaped request cannot skip that.
 *
 * ── THE ORDERING TRAP, ON SCREEN ──────────────────────────────────────────────
 * Re-resolving re-derives against CURRENT configuration. If nothing can place
 * anyone yet — no unambiguous Business Unit owner, no unit rule pointing into this
 * region — everyone is re-derived straight back onto the holding node and the
 * admin concludes the feature is broken. So the server answers that question
 * first and returns `routes.viable`, and when it is false this dialog says FIX
 * THE CONFIGURATION FIRST and disables Apply rather than running to no effect.
 *
 * That verdict is the server's, computed from the very maps the run would use.
 * Re-deriving it here from the tree would be a second opinion that can disagree
 * with the thing it is describing — and "an owner exists" is not the same claim
 * as "an owner the walk can actually use", which is the one that matters.
 *
 * ── BATCHED, AND HONEST ABOUT IT ──────────────────────────────────────────────
 * Each pass is capped (Graph manager hops inside an HTTP request), so the
 * response carries `remaining` / `more`. The dialog shows cumulative progress and
 * keeps offering the next pass instead of pretending one click finished the job.
 */
import { computed, ref, watch, type ComponentPublicInstance } from 'vue'
import { consola } from 'consola'
import UiButton from '../ui/Button.vue'
import { apiErrorDetail } from '../../composables/useApiError'
import { useModalA11y } from '../../composables/useModalA11y'

interface Move {
  teammate_id: string
  email: string
  display_name: string | null
  from_display_name: string
  to_display_name: string
  via: 'unit' | 'unit-rule'
}
interface ReResolveResponse {
  dry_run: boolean
  routes: { unambiguous_owners: number; unit_rules: number; viable: boolean }
  candidates: number
  considered: number
  moved: number
  already_correct: number
  unresolved: number
  out_of_region: number
  errors: number
  /** Decided, then refused at write time because something changed under it. */
  skipped: number
  remaining: number
  more: boolean
  moves: Move[]
}

const props = defineProps<{ open: boolean; regionId: string; regionName: string }>()
const emit = defineEmits<{ close: []; applied: [summary: { moved: number; more: boolean }] }>()

const loading = ref(false)
const applying = ref(false)
const error = ref<string | null>(null)
const preview = ref<ReResolveResponse | null>(null)
/** Cumulative across passes — one click is a batch, not the whole job. */
const appliedTotal = ref(0)
const passes = ref(0)
/** Cumulative too, and only ever from a WRITE — see the note beside its copy. */
const skippedTotal = ref(0)

async function run(dryRun: boolean): Promise<ReResolveResponse | null> {
  error.value = null
  try {
    return await $fetch<ReResolveResponse>(`/api/v1/admin/region/${encodeURIComponent(props.regionId)}/re-resolve`, {
      method: 'POST',
      body: { dry_run: dryRun },
    })
  } catch (e) {
    consola.warn('re-resolve failed', e)
    error.value = apiErrorDetail(e, 'Could not re-resolve placement.')
    return null
  }
}

async function loadPreview() {
  loading.value = true
  preview.value = await run(true)
  loading.value = false
}

async function apply() {
  applying.value = true
  const res = await run(false)
  applying.value = false
  if (!res) return
  appliedTotal.value += res.moved
  skippedTotal.value += res.skipped
  passes.value += 1
  // Re-preview so the panel reflects what is LEFT, not what was true before the
  // write. A stale preview after an apply is how "it did nothing" gets believed.
  await loadPreview()
  emit('applied', { moved: res.moved, more: res.more })
}

watch(
  () => props.open,
  (isOpen) => {
    if (!isOpen) return
    preview.value = null
    error.value = null
    appliedTotal.value = 0
    skippedTotal.value = 0
    passes.value = 0
    void loadPreview()
  },
  { immediate: true },
)

// Shared dialog contract: Escape closes, Tab is trapped, Close takes focus on
// open (the preview is still loading) and focus returns on close.
const dialogEl = ref<HTMLElement | null>(null)
const closeBtn = ref<ComponentPublicInstance | null>(null)
useModalA11y({
  isOpen: () => props.open,
  dialogEl,
  firstField: closeBtn,
  onClose: () => emit('close'),
})

const viable = computed(() => preview.value?.routes.viable ?? false)
const nothingToDo = computed(() => Boolean(preview.value) && preview.value!.candidates === 0)
</script>

<template>
  <div
    v-if="open"
    class="fixed inset-0 z-50 flex items-center justify-center bg-carbon/40 p-4"
    data-testid="re-resolve-overlay"
    @click.self="emit('close')"
  >
    <div
      ref="dialogEl"
      class="w-full max-w-2xl bg-white rounded-xl shadow-xl max-h-[85vh] overflow-y-auto"
      role="dialog"
      aria-modal="true"
      aria-labelledby="re-resolve-title"
      data-testid="re-resolve-dialog"
    >
      <div class="px-6 py-4 border-b border-calm-2 flex items-start justify-between gap-4">
        <div>
          <p class="text-xs font-bold uppercase tracking-[1.4px] text-brand-harmony">Placement</p>
          <h2 id="re-resolve-title" class="text-lg font-bold text-carbon mt-0.5">
            Re-resolve placement — {{ regionName }}
          </h2>
        </div>
        <UiButton ref="closeBtn" kind="ghost" size="sm" data-testid="re-resolve-close" @click="emit('close')">Close</UiButton>
      </div>

      <div class="px-6 py-4">
        <p class="text-sm text-carbon-2 leading-relaxed">
          Re-runs the placement derivation for people in {{ regionName }} who have never
          signed in and have no live session — against the configuration as it stands
          <em>now</em>. It only ever moves someone <strong>into</strong> a Business Unit in this
          region: it never removes a placement, and never moves anyone to another region.
        </p>

        <div v-if="loading" class="text-sm text-carbon-3 py-6 text-center" data-testid="re-resolve-loading">
          Working out what would move…
        </div>

        <p v-if="error" class="text-xs text-rag-red mt-3" data-testid="re-resolve-error" role="alert">{{ error }}</p>

        <template v-if="preview && !loading">
          <!-- THE ORDERING TRAP. No route ⇒ running changes nothing. -->
          <div
            v-if="!viable"
            class="mt-4 p-3 rounded-md bg-rag-amber/10 border border-rag-amber/40"
            data-testid="re-resolve-not-viable"
          >
            <div class="text-sm font-bold text-carbon">Fix the configuration first.</div>
            <p class="text-sm text-carbon-2 mt-1 leading-relaxed">
              Nothing in {{ regionName }} can place anyone yet — there is no Business Unit owner
              the manager chain can use, and no rule pointing at one of this region's
              Business Units. Running now would re-derive
              {{ preview.candidates }} {{ preview.candidates === 1 ? 'person' : 'people' }}
              straight back to where they already are.
            </p>
            <p class="text-sm text-carbon-2 mt-2 leading-relaxed">
              Assign an owner to a Business Unit (an owner of <em>more than one</em> Business Unit
              is ambiguous and places nobody), or place a cluster by hand and accept the rule
              you are offered afterwards. Then come back here.
            </p>
          </div>

          <div v-else-if="nothingToDo" class="mt-4 text-sm text-carbon-2" data-testid="re-resolve-nothing">
            Nobody in {{ regionName }} is eligible for re-resolution. Everyone here has either
            been placed deliberately, or has signed in — those moves go through Admin → Users so
            their session is revoked properly.
          </div>

          <template v-else>
            <div class="mt-4 grid grid-cols-2 md:grid-cols-4 gap-3" data-testid="re-resolve-counts">
              <div class="p-2.5 rounded-md border border-calm-2">
                <div class="text-lg font-bold text-brand-harmony" data-testid="re-resolve-would-move">{{ preview.moved }}</div>
                <div class="text-[11px] text-carbon-3">would move</div>
              </div>
              <div class="p-2.5 rounded-md border border-calm-2">
                <div class="text-lg font-bold text-carbon">{{ preview.already_correct }}</div>
                <div class="text-[11px] text-carbon-3">already right</div>
              </div>
              <div class="p-2.5 rounded-md border border-calm-2">
                <div class="text-lg font-bold text-carbon">{{ preview.unresolved }}</div>
                <div class="text-[11px] text-carbon-3">no route yet</div>
              </div>
              <div class="p-2.5 rounded-md border border-calm-2">
                <div class="text-lg font-bold text-carbon">{{ preview.out_of_region }}</div>
                <div class="text-[11px] text-carbon-3">belong elsewhere</div>
              </div>
            </div>

            <p class="text-[11px] text-carbon-3 mt-2 leading-relaxed">
              Looked at {{ preview.considered }} of {{ preview.candidates }} eligible
              {{ preview.candidates === 1 ? 'person' : 'people' }} this pass.
              <span v-if="preview.more" data-testid="re-resolve-more">
                Another pass is needed for the remaining {{ preview.remaining }}.
              </span>
              <span v-if="preview.out_of_region > 0">
                “Belong elsewhere” are derived into another region — a cross-region
                move revokes their sessions, so it is not this action's to make.
              </span>
              <!-- HONEST ABOUT THE LIMIT OF THAT LABEL. Telling "belongs elsewhere"
                   apart from "no route yet" requires READING the other region's
                   owners, and a region admin's scope does not include them. So a
                   foreign chain is reported as "no route yet" here whenever that
                   region's configuration is not visible to this account, and the
                   panel says so instead of promising a classification it cannot
                   always make. -->
              <span>
                A chain that reaches a Business Unit you cannot see is counted under “no route
                yet”, not “belong elsewhere” — either way nobody is moved across a region
                boundary.
              </span>
            </p>


            <ul
              v-if="preview.moves.length"
              class="mt-3 border border-calm-2 rounded-md divide-y divide-calm-2 max-h-64 overflow-y-auto"
              data-testid="re-resolve-moves"
            >
              <li v-for="m in preview.moves" :key="m.teammate_id" class="px-3 py-2 flex items-center justify-between gap-3">
                <span class="text-sm text-carbon truncate">{{ m.display_name ?? m.email }}</span>
                <span class="text-[11px] text-carbon-3 shrink-0">
                  {{ m.from_display_name }} → <strong class="text-carbon-2">{{ m.to_display_name }}</strong>
                  <span class="ml-1">({{ m.via === 'unit-rule' ? 'rule' : 'manager chain' }})</span>
                </span>
              </li>
            </ul>
          </template>

          <p v-if="passes > 0" class="text-sm text-brand-harmony font-semibold mt-3" data-testid="re-resolve-applied">
            Moved {{ appliedTotal }} so far, over {{ passes }} {{ passes === 1 ? 'pass' : 'passes' }}.
          </p>
          <!-- Reported from the APPLY, not from the preview that follows it: a
               preview writes nothing, so it can never skip anything, and the count
               would vanish the moment the panel refreshed. -->
          <p
            v-if="skippedTotal > 0"
            class="text-[11px] text-rag-amber mt-2 leading-relaxed"
            data-testid="re-resolve-skipped"
          >
            {{ skippedTotal }} {{ skippedTotal === 1 ? 'person was' : 'people were' }} left alone at
            the last moment: something changed while the pass was running — a session started, or
            the destination stopped being an active Business Unit in this region. They were not
            moved, and are still waiting.
          </p>
        </template>

        <div class="flex justify-end gap-2 mt-5">
          <UiButton kind="ghost" data-testid="re-resolve-cancel" @click="emit('close')">Close</UiButton>
          <UiButton
            kind="ghost"
            size="sm"
            :disabled="loading || applying"
            data-testid="re-resolve-refresh"
            @click="loadPreview"
          >
            Re-check
          </UiButton>
          <UiButton
            kind="primary"
            :disabled="applying || loading || !viable || !preview || preview.moved === 0"
            data-testid="re-resolve-apply"
            @click="apply"
          >
            {{ applying ? 'Applying…' : preview && preview.moved > 0 ? `Move ${preview.moved}` : 'Nothing to move' }}
          </UiButton>
        </div>
      </div>
    </div>
  </div>
</template>
