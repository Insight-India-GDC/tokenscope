<script setup lang="ts">
/*
 * ProjectEditDialog — edit a project's budget-owning metadata from the
 * top-level Admin → Projects page. Modelled on TagSessionDialog for the a11y
 * contract (role="dialog" + aria-modal + aria-labelledby, Escape closes, first
 * field focused on open, focus trap, error as aria-live alert).
 *
 * Submits only the changed fields to PATCH /api/v1/admin/projects/{id}; the
 * parent owns the success toast + list refresh via the `saved` emit.
 */
import { ref, computed, watch, type Ref } from 'vue'
import UiButton from '../ui/Button.vue'
import UiAuxFetchError from '../ui/AuxFetchError.vue'
import { useModalA11y } from '../../composables/useModalA11y'
import { apiErrorDetail } from '../../composables/useApiError'
import { BU_LABEL } from '#shared/reports/vocabulary'

export interface ProjectEditTarget {
  id: string
  code: string
  display_name: string
  client_facing_name?: string | null
  wbs_code?: string | null
  type: 'billable' | 'pursuit' | 'internal' | string
  cost_owning_unit_id: string | null
  is_authorised: boolean
}

const props = defineProps<{
  project: ProjectEditTarget | null
  couOptions: { id: string; display_name: string }[]
  /*
   * The caller's org-units read failed. Without this the unit picker renders
   * empty and reads as "this region has no units" — the false empty D2 forbids
   * (docs/design/admin-nav-responsiveness.md).
   */
  couOptionsError?: unknown
}>()
const emit = defineEmits<{ close: []; saved: []; retryCouOptions: [] }>()

const displayName = ref('')
const clientFacingName = ref('')
const wbsCode = ref('')
const type = ref<'billable' | 'pursuit' | 'internal'>('billable')
const couId = ref('')
const isAuthorised = ref(false)

const saving = ref(false)
const error = ref<string | null>(null)
const firstField = ref<HTMLInputElement | null>(null)
const dialogEl = ref<HTMLElement | null>(null)
const titleId = 'project-edit-title'

const normalisedType = (t: string): 'billable' | 'pursuit' | 'internal' =>
  t === 'pursuit' || t === 'internal' ? t : 'billable'

// Shared dialog a11y; onOpen prefills the form from the project being edited.
useModalA11y({
  isOpen: () => !!props.project,
  dialogEl,
  firstField: firstField as Ref<HTMLElement | null>,
  onClose: () => emit('close'),
  onOpen: () => {
    const p = props.project
    if (!p) return
    displayName.value = p.display_name ?? ''
    clientFacingName.value = p.client_facing_name ?? ''
    wbsCode.value = p.wbs_code ?? ''
    type.value = normalisedType(p.type)
    couId.value = p.cost_owning_unit_id ?? ''
    isAuthorised.value = !!p.is_authorised
    error.value = null
  },
})

const canSubmit = computed(() => !saving.value && displayName.value.trim().length > 0)

/*
 * ── MIGRATE ──────────────────────────────────────────────────────────────────
 * Changing the Business Unit here only affects FUTURE usage: the BU is stamped
 * onto each usage row when it is written and never refreshed. That default is
 * right for a reorg and wrong for a correction, and the product used to give no
 * hint which you were getting — a BU owner homed four projects and watched the
 * page stay at $0.00 while listing those projects' real totals.
 *
 * So the moment the unit actually changes, we say what will happen to the spend
 * already recorded, and offer to bring it along. PREVIEW FIRST, always: money
 * changing home is not something to discover afterwards.
 */
const buChanged = computed(
  () => !!couId.value && couId.value !== (props.project?.cost_owning_unit_id ?? ''),
)
const migrateSpend = ref(false)
/** '' = everything recorded; otherwise a YYYY-MM-DD floor. */
const migrateFrom = ref('')
interface MigratePreview {
  affected: { periodMonth: string; rows: number; usd: number }[]
  refused: { periodMonth: string; rows: number; usd: number; reason: string }[]
  totalRows: number
  totalUsd: number
  token: string
}
const preview = ref<MigratePreview | null>(null)
const previewing = ref(false)
const previewError = ref<string | null>(null)

function migrateRange() {
  return migrateFrom.value
    ? { from: migrateFrom.value }
    : { from: 'all' as const, confirm_unbounded: true as const }
}

async function runPreview() {
  const p = props.project
  if (!p || !buChanged.value) return
  previewing.value = true
  previewError.value = null
  preview.value = null
  try {
    // Explicitly typed, and the path widened to `string`: Nuxt's route-literal
    // inference recurses to "excessive stack depth" on a templated admin path.
    preview.value = await $fetch<MigratePreview>(
      `/api/v1/admin/projects/${p.id}/migrate-preview` as string,
      { method: 'POST', body: { to_cost_owning_unit_id: couId.value, range: migrateRange() } },
    )
  } catch (e: unknown) {
    previewError.value = apiErrorDetail(e, 'Could not work out what would move')
  } finally {
    previewing.value = false
  }
}

// A preview describes ONE proposed move. Change any input and it is stale, so
// it is dropped rather than left on screen next to different numbers.
watch([couId, migrateFrom, migrateSpend], () => {
  preview.value = null
  previewError.value = null
})

/** Applying without previewing would defeat the point of previewing. */
const migrateReady = computed(() => !migrateSpend.value || !!preview.value)

async function save() {
  const p = props.project
  if (!p) return
  // Build a patch of only the changed fields.
  const body: Record<string, unknown> = {}
  const nextName = displayName.value.trim()
  if (nextName !== (p.display_name ?? '')) body.display_name = nextName
  const nextClient = clientFacingName.value.trim()
  if (nextClient !== (p.client_facing_name ?? '')) body.client_facing_name = nextClient
  const nextWbs = wbsCode.value.trim()
  if (nextWbs !== (p.wbs_code ?? '')) body.wbs_code = nextWbs // '' clears it server-side
  if (type.value !== normalisedType(p.type)) body.type = type.value
  if (couId.value && couId.value !== (p.cost_owning_unit_id ?? '')) body.cost_owning_unit_id = couId.value
  if (isAuthorised.value !== !!p.is_authorised) body.is_authorised = isAuthorised.value
  /*
   * The token binds this write to the row set the admin was SHOWN. If ingest or
   * a close has moved the picture since, the server 409s with the current plan
   * instead of writing something nobody agreed to.
   */
  if (migrateSpend.value && buChanged.value && preview.value) {
    body.migrate_spend = migrateRange()
    body.migrate_expect_token = preview.value.token
  }

  if (Object.keys(body).length === 0) {
    emit('close')
    return
  }

  saving.value = true
  error.value = null
  try {
    await $fetch(`/api/v1/admin/projects/${p.id}`, { method: 'PATCH', body })
    emit('saved')
  } catch (e: unknown) {
    error.value = apiErrorDetail(e, 'Save failed')
    /*
     * A stale-token 409 ships the CURRENT plan precisely so the admin can
     * re-confirm against what is true now, rather than re-previewing blind.
     * Swapping it in replaces the figures they were shown with the figures that
     * refused them — which for the commonest case (a migration that committed
     * after the browser stopped waiting) reads "0 record(s) · $0.00", the
     * evidence for the sentence above it.
     */
    const fresh = (e as { data?: { data?: { current_plan?: MigratePreview } } })?.data?.data?.current_plan
    if (fresh) preview.value = fresh
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <div
    v-if="project"
    class="fixed inset-0 z-50 flex items-center justify-center bg-carbon/40 p-4"
    data-testid="project-edit-dialog"
    @click.self="emit('close')"
  >
    <div
      ref="dialogEl"
      class="w-full max-w-md bg-white rounded-xl shadow-xl max-h-[85vh] overflow-y-auto"
      role="dialog"
      aria-modal="true"
      :aria-labelledby="titleId"
    >
      <div class="px-6 py-4 border-b border-calm-2 flex items-start justify-between gap-4">
        <div>
          <p class="text-xs font-bold uppercase tracking-[1.4px] text-brand-harmony">Edit project</p>
          <h2 :id="titleId" class="text-lg font-bold text-carbon mt-0.5">{{ project.display_name }}</h2>
          <code class="text-[11px] bg-calm/40 px-1 rounded">{{ project.code }}</code>
        </div>
        <UiButton kind="ghost" size="sm" data-testid="project-edit-close" @click="emit('close')">Close</UiButton>
      </div>

      <div class="px-6 py-4">
        <label for="pe-name" class="text-[12px] font-semibold text-carbon">Display name</label>
        <input
          id="pe-name"
          ref="firstField"
          v-model="displayName"
          type="text"
          class="mt-1 mb-3 w-full px-3 py-2 text-sm border border-calm-2 rounded-md focus:border-brand-harmony"
          data-testid="pe-name"
        >

        <label for="pe-client-name" class="text-[12px] font-semibold text-carbon">Client-facing name</label>
        <input
          id="pe-client-name"
          v-model="clientFacingName"
          type="text"
          placeholder="Optional — shown to the client"
          class="mt-1 mb-3 w-full px-3 py-2 text-sm border border-calm-2 rounded-md focus:border-brand-harmony"
          data-testid="pe-client-name"
        >

        <label for="pe-wbs" class="text-[12px] font-semibold text-carbon">WBS code</label>
        <input
          id="pe-wbs"
          v-model="wbsCode"
          type="text"
          maxlength="64"
          placeholder="Optional — finance-system WBS code"
          class="mt-1 mb-3 w-full px-3 py-2 text-sm border border-calm-2 rounded-md font-mono focus:border-brand-harmony"
          data-testid="pe-wbs"
        >

        <label for="pe-type" class="text-[12px] font-semibold text-carbon">Type</label>
        <select
          id="pe-type"
          v-model="type"
          class="mt-1 mb-3 w-full px-3 py-2 text-sm border border-calm-2 rounded-md bg-white focus:border-brand-harmony"
          data-testid="pe-type"
        >
          <option value="billable">Billable</option>
          <option value="pursuit">Pursuit</option>
          <option value="internal">Internal</option>
        </select>

        <label for="pe-cou" class="text-[12px] font-semibold text-carbon">{{ BU_LABEL }}</label>
        <div class="mt-1 mb-3">
          <select
            id="pe-cou"
            v-model="couId"
            :disabled="!!couOptionsError"
            class="w-full px-3 py-2 text-sm border border-calm-2 rounded-md bg-white focus:border-brand-harmony disabled:bg-calm/40 disabled:cursor-not-allowed"
            data-testid="pe-cou"
          >
            <option value="" disabled>Select a unit…</option>
            <option v-for="u in couOptions" :key="u.id" :value="u.id">{{ u.display_name }}</option>
          </select>
          <UiAuxFetchError
            :error="couOptionsError"
            :label="`${BU_LABEL}s`"
            testid="pe-cou-error"
            @retry="emit('retryCouOptions')"
          />
        </div>

        <!--
          MIGRATE. Only once the unit has actually changed — until then there is
          nothing to say, and a permanently-visible warning is one nobody reads.
        -->
        <div
          v-if="buChanged"
          class="mb-3 -mt-1 rounded-md border border-rag-amber/50 bg-rag-amber/5 px-3 py-2.5"
          data-testid="pe-migrate"
        >
          <p class="text-[12px] text-carbon leading-snug">
            <span class="font-semibold">Spend already recorded stays on the old {{ BU_LABEL }}.</span>
            Usage is stamped with its {{ BU_LABEL }} when it is recorded, so this change
            applies to future usage only.
          </p>

          <label class="mt-2 flex items-start gap-2 text-[12px] text-carbon">
            <input v-model="migrateSpend" type="checkbox" class="mt-0.5 rounded border-calm-2" data-testid="pe-migrate-toggle">
            <span>Also migrate the spend already recorded against this project</span>
          </label>

          <div v-if="migrateSpend" class="mt-2 pl-6">
            <label for="pe-migrate-from" class="text-[11px] font-semibold text-carbon-2">From</label>
            <input
              id="pe-migrate-from"
              v-model="migrateFrom"
              type="date"
              class="ml-2 px-2 py-1 text-[12px] border border-calm-2 rounded bg-white"
              data-testid="pe-migrate-from"
            >
            <span class="ml-2 text-[11px] text-carbon-3">blank = everything recorded</span>

            <div class="mt-2">
              <UiButton kind="secondary" size="sm" :disabled="previewing" data-testid="pe-migrate-preview" @click="runPreview">
                {{ previewing ? 'Checking…' : 'Check what would move' }}
              </UiButton>
            </div>

            <p v-if="previewError" class="mt-2 text-[11px] text-rag-red" role="alert" data-testid="pe-migrate-error">
              {{ previewError }}
            </p>

            <!-- The impact, stated before the write, never after. -->
            <div v-if="preview" class="mt-2 text-[11px] text-carbon" data-testid="pe-migrate-preview-result">
              <p class="font-semibold">
                {{ preview.totalRows }} record(s) · ${{ preview.totalUsd.toFixed(2) }} would move to the new {{ BU_LABEL }}.
              </p>
              <p v-if="preview.totalRows === 0" class="text-carbon-3">
                Nothing recorded in that range is on a different {{ BU_LABEL }}.
              </p>
              <ul v-if="preview.refused.length" class="mt-1 text-carbon-2">
                <!-- `archived` is the only refusal left: a recorded month is a
                     snapshot, not a lock, so nothing is refused for being
                     closed any more. -->
                <li v-for="r in preview.refused" :key="r.periodMonth + r.reason">
                  {{ r.periodMonth.slice(0, 7) }}: {{ r.rows }} record(s) left alone —
                  archived; the detail behind it is no longer stored
                </li>
              </ul>
              <p class="mt-1 text-carbon-3">
                This restates reported usage. Anyone reconciling the old {{ BU_LABEL }} will see it change,
                and other people's open reports can take up to a minute to catch up.
              </p>
            </div>
          </div>
        </div>

        <label class="flex items-center gap-2 text-[12px] font-semibold text-carbon mt-1">
          <input
            v-model="isAuthorised"
            type="checkbox"
            class="rounded border-calm-2"
            data-testid="pe-authorised"
          >
          Authorised for spend
        </label>

        <p v-if="error" class="text-xs text-rag-red mt-3" data-testid="project-edit-error" role="alert">{{ error }}</p>

        <div class="flex justify-end gap-2 mt-5">
          <UiButton kind="ghost" data-testid="project-edit-cancel" @click="emit('close')">Cancel</UiButton>
          <UiButton kind="primary" :disabled="!canSubmit || !migrateReady" data-testid="pe-submit" @click="save">
            {{ saving ? 'Saving…' : 'Save changes' }}
          </UiButton>
        </div>
      </div>
    </div>
  </div>
</template>
