<script setup lang="ts">
/*
 * Admin → Rate cards (PRD COST-5, safe half). The provider pricing registry
 * the joiner resolves cost from: cards grouped by scope_key, each carrying a
 * scope tier (global / region), an effective period, a basis, and its lines.
 *
 * Deliberately NO edit and NO delete: costed attribution records pin
 * (rate_card_id, rate_card_version) — COST-7 — so the only mutations are
 * "create a new card" and "retire". The in_use chip surfaces the pin.
 *
 * Scope mirrors the server (GET /api/v1/admin/rate-cards): a region admin
 * sees the global cards plus their own region's; org-wide roles see all and
 * may create global cards. The server re-checks authority on every write —
 * the UI guards are convenience.
 *
 * RBAC: client-side guard via useSession() — server still 401/403s a
 * non-admin's API calls; the page just hides itself.
 */

import { computed, ref, watch, type Ref } from 'vue'
import { consola } from 'consola'
import AdminDataTable from '../../components/admin/AdminDataTable.vue'
import AdminPageSkeleton from '../../components/admin/AdminPageSkeleton.vue'
import { useModalA11y } from '../../composables/useModalA11y'
definePageMeta({ layout: 'admin', middleware: 'admin' })

interface CardRow extends Record<string, unknown> {
  id: string
  scope_key: string
  region_id: string | null
  region_code: string | null
  cou_id: string | null
  effective: string
  effective_from: string | null
  effective_to: string | null
  basis: string
  provenance: Record<string, unknown>
  version: number
  retired_at: string | null
  line_count: number
  in_use: boolean
}

const { session } = useSession()

const isAdmin = computed(() => {
  const r = session.value?.role
  return r === 'admin' || r === 'platform-admin'
})
const isOrgWide = computed(() => {
  const r = session.value?.role
  return r === 'platform-admin'
})
const regionId = computed(() => session.value?.regionId ?? '')

// Both reads are declared lazily and never awaited: navigation is never gated
// on data, and the skeleton keys on ABSENT data, not `pending`
// (docs/design/admin-nav-responsiveness.md D1/D2).
const { data, error, refresh } = useLazyFetch<{ rate_cards: CardRow[] } | null>(
  '/api/v1/admin/rate-cards',
  { server: false, default: () => null, immediate: isAdmin.value },
)
const skeleton = computed(() => !error.value && data.value == null)

// The create dialog's region tier picker. Its `error` is kept: a region admin
// whose read failed sees a select with NO option at all (the "Global" option is
// org-wide only) and cannot tell that from "you may not pick a region" — the
// false empty D2 forbids (docs/design/admin-nav-responsiveness.md).
const {
  data: regionsData,
  error: regionsError,
  refresh: refreshRegions,
} = useLazyFetch<{ regions: { id: string; code: string; display_name: string }[] } | null>(
  '/api/v1/admin/regions',
  { server: false, default: () => null, immediate: isAdmin.value },
)

// Cards grouped by scope_key (server orders scope_key, effective desc).
const groups = computed<{ scopeKey: string; cards: CardRow[] }[]>(() => {
  const out: { scopeKey: string; cards: CardRow[] }[] = []
  for (const card of data.value?.rate_cards ?? []) {
    const last = out[out.length - 1]
    if (last && last.scopeKey === card.scope_key) last.cards.push(card)
    else out.push({ scopeKey: card.scope_key, cards: [card] })
  }
  return out
})
const scopeKeySuggestions = computed(() => groups.value.map((g) => g.scopeKey))

// Status: retired beats everything; current = effective @> now AND not
// retired; future = starts after now; active = period ended but the card is
// still live for late events inside its period (the joiner resolves on the
// EVENT timestamp, so a non-retired past card still prices stragglers).
type CardStatus = 'retired' | 'current' | 'future' | 'active'
function statusOf(card: CardRow): CardStatus {
  if (card.retired_at) return 'retired'
  const now = Date.now()
  const from = card.effective_from ? new Date(card.effective_from).getTime() : -Infinity
  const to = card.effective_to ? new Date(card.effective_to).getTime() : Infinity
  if (from > now) return 'future'
  if (now < to) return 'current'
  return 'active'
}
const STATUS_BADGE: Record<CardStatus, 'rag-green' | 'vision' | 'harmony' | 'neutral'> = {
  current: 'rag-green',
  future: 'vision',
  active: 'harmony',
  retired: 'neutral',
}

function fmtDay(iso: string | null): string {
  return iso ? iso.slice(0, 10) : '—'
}

const toast = ref<{ kind: 'ok' | 'err'; message: string } | null>(null)
let toastTimer: ReturnType<typeof setTimeout> | null = null
function flashToast(kind: 'ok' | 'err', message: string) {
  toast.value = { kind, message }
  if (toastTimer) clearTimeout(toastTimer)
  toastTimer = setTimeout(() => { toast.value = null }, 3500)
}

const columns = [
  { key: 'scope', label: 'Scope' },
  { key: 'effective', label: 'Effective' },
  { key: 'basis', label: 'Basis' },
  { key: 'version', label: 'Version' },
  { key: 'line_count', label: 'Lines' },
  { key: 'status', label: 'Status' },
  { key: 'in_use', label: 'In use' },
  { key: 'actions', label: 'Actions' },
]

function asCard(row: Record<string, unknown>): CardRow {
  return row as unknown as CardRow
}

// ── retire ──────────────────────────────────────────────────────────────────
const mutating = ref<Set<string>>(new Set())
function markBusy(id: string, busy: boolean) {
  const next = new Set(mutating.value)
  if (busy) next.add(id)
  else next.delete(id)
  mutating.value = next
}
function canRetire(card: CardRow): boolean {
  if (card.retired_at) return false
  return isOrgWide.value || card.region_id === regionId.value
}
async function retire(card: CardRow) {
  if (
    !confirm(
      `Retire ${card.scope_key} v${card.version} (${fmtDay(card.effective_from)} → ${fmtDay(card.effective_to)})? ` +
        'It stops pricing future events; already-costed records keep it pinned. This cannot be undone.',
    )
  )
    return
  markBusy(card.id, true)
  try {
    await $fetch(`/api/v1/admin/rate-cards/${card.id}/retire`, { method: 'POST' })
    flashToast('ok', `Retired ${card.scope_key} v${card.version}.`)
    await refresh()
  } catch (err) {
    flashToast('err', apiErrorDetail(err, 'Retire refused.'))
    consola.warn('rate-card retire failed', err)
  } finally {
    markBusy(card.id, false)
  }
}

// ── new-card dialog ─────────────────────────────────────────────────────────
interface LineDraft {
  unit: string
  qty: string
  cost: string
  model: string
}
const COST_RE = /^\d{1,6}(\.\d{1,8})?$/
// The four Anthropic units (mig 0004 / emitter contract — exact strings the
// joiner filters on), prefilled as a template for anthropic:* scope keys.
const ANTHROPIC_TEMPLATE: LineDraft[] = [
  { unit: 'input', qty: '1000000', cost: '', model: '' },
  { unit: 'output', qty: '1000000', cost: '', model: '' },
  { unit: 'cache-read', qty: '1000000', cost: '', model: '' },
  { unit: 'cache-write', qty: '1000000', cost: '', model: '' },
]

const showCreate = ref(false)
const newScopeKey = ref('')
const newRegionId = ref('') // '' = global (org-wide roles only)
const newFrom = ref('')
const newTo = ref('')
const newBasis = ref<'list' | 'negotiated' | 'invoice-derived'>('list')
const newNote = ref('')
const newLines = ref<LineDraft[]>([{ unit: '', qty: '1000000', cost: '', model: '' }])
const linesTouched = ref(false)
const saving = ref(false)
const createErrorMsg = ref<string | null>(null)
const dialogEl = ref<HTMLElement | null>(null)
const firstField = ref<HTMLInputElement | null>(null)

useModalA11y({
  isOpen: () => showCreate.value,
  dialogEl,
  firstField: firstField as Ref<HTMLElement | null>,
  onClose: () => { showCreate.value = false },
  onOpen: () => {
    newScopeKey.value = ''
    newRegionId.value = isOrgWide.value ? '' : regionId.value
    newFrom.value = ''
    newTo.value = ''
    newBasis.value = 'list'
    newNote.value = ''
    newLines.value = [{ unit: '', qty: '1000000', cost: '', model: '' }]
    linesTouched.value = false
    createErrorMsg.value = null
  },
})

// Prefill the Anthropic unit template while the lines are still pristine.
watch(newScopeKey, (key) => {
  if (linesTouched.value) return
  if (key.startsWith('anthropic:')) {
    newLines.value = ANTHROPIC_TEMPLATE.map((l) => ({ ...l }))
  }
})

function addLine() {
  if (newLines.value.length >= 20) return
  linesTouched.value = true
  newLines.value.push({ unit: '', qty: '1000000', cost: '', model: '' })
}
function removeLine(i: number) {
  linesTouched.value = true
  newLines.value.splice(i, 1)
}

function lineValid(l: LineDraft): boolean {
  if (!l.unit.trim()) return false
  const qty = Number(l.qty)
  if (!Number.isInteger(qty) || qty <= 0) return false
  return COST_RE.test(l.cost) && Number(l.cost) > 0
}
const canSubmit = computed(() => {
  if (saving.value) return false
  if (!/^[a-z0-9-]+:[a-z0-9-]+$/.test(newScopeKey.value)) return false
  if (!isOrgWide.value && !newRegionId.value) return false
  if (!newFrom.value || !newTo.value || newFrom.value >= newTo.value) return false
  if (newLines.value.length < 1 || newLines.value.length > 20) return false
  return newLines.value.every(lineValid)
})

async function createCard() {
  if (!canSubmit.value) return
  saving.value = true
  createErrorMsg.value = null
  try {
    // `Z` (midnight-UTC) bounds — valid in both V8's ISO parser and PG (see
    // allocation-validation / SetBudgetDialog for the bare-`+00` trap).
    await $fetch('/api/v1/admin/rate-cards', {
      method: 'POST',
      body: {
        scope_key: newScopeKey.value,
        region_id: newRegionId.value || null,
        effective: `[${newFrom.value}T00:00:00Z,${newTo.value}T00:00:00Z)`,
        basis: newBasis.value,
        provenance: {
          source: 'admin-ui',
          ...(newNote.value.trim() ? { note: newNote.value.trim() } : {}),
        },
        lines: newLines.value.map((l) => ({
          unit: l.unit.trim(),
          unit_qty: Number(l.qty),
          unit_cost_usd: l.cost,
          model: l.model.trim() ? l.model.trim() : null,
        })),
      },
    })
    showCreate.value = false
    flashToast('ok', `Created rate card ${newScopeKey.value}.`)
    await refresh()
  } catch (err) {
    createErrorMsg.value = apiErrorDetail(err, 'Rate-card creation failed.')
    consola.warn('rate-card create failed', err)
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <div v-if="isAdmin" class="max-w-[1600px] mx-auto px-10 py-8 pb-20" data-testid="admin-rate-cards" data-admin-page="/admin/rate-cards">
    <UiPageHead
      eyebrow="Administration"
      title="Rate cards"
      sub="Provider pricing that usage is costed from — per scope, region tier, and effective period. Cards are never edited or deleted: create a new card, retire a wrong one."
    >
      <template #actions>
        <UiButton kind="primary" size="sm" data-testid="rate-card-new" @click="showCreate = true">
          + New rate card
        </UiButton>
      </template>
    </UiPageHead>

    <div
      v-if="toast"
      :data-testid="`admin-rate-cards-toast-${toast.kind}`"
      class="mb-4 p-3 rounded-md text-sm font-medium"
      :class="toast.kind === 'ok'
        ? 'bg-brand-harmony-sheer text-brand-harmony border border-brand-harmony/30'
        : 'bg-brand-hunger/10 text-brand-heart border border-brand-hunger/30'"
    >
      {{ toast.message }}
    </div>

    <UiFetchErrorBanner v-if="error" :error="error" label="rate cards" @retry="refresh" />
    <AdminPageSkeleton v-else-if="skeleton" :rows="6" :toolbar="false" />
    <UiCard v-else-if="groups.length === 0">
      <div class="py-8 text-center">
        <div class="text-sm font-bold text-carbon">No rate cards</div>
        <p class="text-xs text-carbon-2 mt-1">Create the first card to start pricing spend for a tool.</p>
      </div>
    </UiCard>

    <template v-else>
    <div v-for="group in groups" :key="group.scopeKey" class="mb-6" :data-testid="`rate-card-group-${group.scopeKey}`">
      <div class="flex items-baseline gap-2 mb-2">
        <h2 class="text-sm font-bold text-carbon font-mono">{{ group.scopeKey }}</h2>
        <span class="text-[11px] text-carbon-3">{{ group.cards.length }} card{{ group.cards.length === 1 ? '' : 's' }}</span>
      </div>
      <AdminDataTable :rows="group.cards" :columns="columns">
        <template #row="{ row }">
          <tr
            :data-testid="`rate-card-row-${asCard(row).id}`"
            class="hover:bg-brand-harmony-sheer/30"
            :class="{ 'opacity-60': !!asCard(row).retired_at }"
          >
            <td class="px-5 py-3 text-sm">
              <UiBadge :kind="asCard(row).region_id ? 'harmony' : 'vision'">
                {{ asCard(row).region_code ?? 'Global' }}
              </UiBadge>
            </td>
            <td class="px-5 py-3 text-sm font-mono text-carbon-2 whitespace-nowrap">
              {{ fmtDay(asCard(row).effective_from) }} → {{ fmtDay(asCard(row).effective_to) }}
            </td>
            <td class="px-5 py-3 text-sm text-carbon-2">{{ asCard(row).basis }}</td>
            <td class="px-5 py-3 text-sm font-mono text-carbon-2">v{{ asCard(row).version }}</td>
            <td class="px-5 py-3 text-sm font-mono text-carbon-2">{{ asCard(row).line_count }}</td>
            <td class="px-5 py-3 text-sm">
              <UiBadge :kind="STATUS_BADGE[statusOf(asCard(row))]">{{ statusOf(asCard(row)) }}</UiBadge>
            </td>
            <td class="px-5 py-3 text-sm">
              <UiBadge
                v-if="asCard(row).in_use"
                kind="zeal"
                title="Costed attribution records pin this card — it can be retired but never deleted."
                :data-testid="`rate-card-in-use-${asCard(row).id}`"
              >
                in use
              </UiBadge>
              <span v-else class="text-carbon-3">—</span>
            </td>
            <td class="px-5 py-3 text-sm whitespace-nowrap text-right">
              <UiButton
                v-if="canRetire(asCard(row))"
                kind="ghost"
                size="sm"
                :disabled="mutating.has(asCard(row).id)"
                :data-testid="`rate-card-retire-${asCard(row).id}`"
                title="Stop this card pricing future events. Past costed records keep it pinned."
                @click="retire(asCard(row))"
              >
                {{ mutating.has(asCard(row).id) ? '…' : 'Retire' }}
              </UiButton>
              <span
                v-else-if="!asCard(row).retired_at"
                class="text-[11px] text-carbon-3 italic cursor-help"
                title="Global rate cards can only be retired by an Admin."
                :data-testid="`rate-card-readonly-${asCard(row).id}`"
              >
                read-only
              </span>
              <span v-else class="text-[11px] text-carbon-3">retired {{ fmtDay(asCard(row).retired_at) }}</span>
            </td>
          </tr>
        </template>
      </AdminDataTable>
    </div>
    </template>

    <!-- New-card dialog -->
    <div
      v-if="showCreate"
      class="fixed inset-0 z-50 flex items-center justify-center bg-carbon/40 p-4"
      data-testid="rate-card-create-dialog"
      @click.self="showCreate = false"
    >
      <div
        ref="dialogEl"
        class="w-full max-w-2xl bg-white rounded-xl shadow-xl max-h-[90vh] overflow-y-auto"
        role="dialog"
        aria-modal="true"
        aria-labelledby="rate-card-create-title"
      >
        <div class="px-6 py-4 border-b border-calm-2 flex items-start justify-between gap-4">
          <div>
            <p class="text-xs font-bold uppercase tracking-[1.4px] text-brand-harmony">New rate card</p>
            <h2 id="rate-card-create-title" class="text-lg font-bold text-carbon mt-0.5">Create a pricing card</h2>
          </div>
          <UiButton kind="ghost" size="sm" data-testid="rate-card-create-close" @click="showCreate = false">Close</UiButton>
        </div>

        <div class="px-6 py-4">
          <div class="grid grid-cols-2 gap-3">
            <div>
              <label for="rc-scope-key" class="text-[12px] font-semibold text-carbon">Scope key</label>
              <input
                id="rc-scope-key"
                ref="firstField"
                v-model="newScopeKey"
                type="text"
                list="rc-scope-key-options"
                placeholder="anthropic:claude-code"
                class="mt-1 w-full px-3 py-2 text-sm border border-calm-2 rounded-md font-mono focus:border-brand-harmony"
                data-testid="rc-scope-key"
              >
              <datalist id="rc-scope-key-options">
                <option v-for="k in scopeKeySuggestions" :key="k" :value="k" />
              </datalist>
            </div>
            <div>
              <label for="rc-region" class="text-[12px] font-semibold text-carbon">Region tier</label>
              <select
                id="rc-region"
                v-model="newRegionId"
                :disabled="!isOrgWide || !regionsData"
                class="mt-1 w-full px-3 py-2 text-sm border border-calm-2 rounded-md bg-white focus:border-brand-harmony disabled:bg-calm/30"
                data-testid="rc-region"
              >
                <option v-if="isOrgWide" value="">Global (all regions)</option>
                <option v-for="r in regionsData?.regions" :key="r.id" :value="r.id">{{ r.display_name }}</option>
              </select>
              <UiAuxFetchError
                :error="regionsError"
                label="regions"
                testid="rc-region-error"
                @retry="refreshRegions"
              />
              <p v-if="!isOrgWide" class="text-[11px] text-carbon-3 mt-1">
                Region admins create cards for their own region. Global cards need an Admin.
              </p>
            </div>
            <div>
              <label for="rc-from" class="text-[12px] font-semibold text-carbon">Effective from</label>
              <input
                id="rc-from"
                v-model="newFrom"
                type="date"
                class="mt-1 w-full px-3 py-2 text-sm border border-calm-2 rounded-md focus:border-brand-harmony"
                data-testid="rc-from"
              >
            </div>
            <div>
              <label for="rc-to" class="text-[12px] font-semibold text-carbon">Effective to (exclusive)</label>
              <input
                id="rc-to"
                v-model="newTo"
                type="date"
                class="mt-1 w-full px-3 py-2 text-sm border border-calm-2 rounded-md focus:border-brand-harmony"
                data-testid="rc-to"
              >
            </div>
            <div>
              <label for="rc-basis" class="text-[12px] font-semibold text-carbon">Basis</label>
              <select
                id="rc-basis"
                v-model="newBasis"
                class="mt-1 w-full px-3 py-2 text-sm border border-calm-2 rounded-md bg-white focus:border-brand-harmony"
                data-testid="rc-basis"
              >
                <option value="list">list</option>
                <option value="negotiated">negotiated</option>
                <option value="invoice-derived">invoice-derived</option>
              </select>
            </div>
            <div>
              <label for="rc-note" class="text-[12px] font-semibold text-carbon">Provenance note (optional)</label>
              <input
                id="rc-note"
                v-model="newNote"
                type="text"
                maxlength="200"
                placeholder="e.g. FY27 negotiated pricing"
                class="mt-1 w-full px-3 py-2 text-sm border border-calm-2 rounded-md focus:border-brand-harmony"
                data-testid="rc-note"
              >
            </div>
          </div>

          <div class="mt-4">
            <div class="flex items-center justify-between mb-1">
              <span class="text-[12px] font-semibold text-carbon">Lines (per-unit pricing)</span>
              <UiButton
                kind="ghost"
                size="sm"
                :disabled="newLines.length >= 20"
                data-testid="rc-line-add"
                @click="addLine"
              >
                + Add line
              </UiButton>
            </div>
            <div
              class="grid grid-cols-[1fr_110px_120px_1fr_60px] gap-2 text-[11px] font-bold uppercase tracking-[1.2px] text-carbon-3 px-1"
            >
              <span>Unit</span><span>Per qty</span><span>Cost (USD)</span><span>Model (optional)</span><span />
            </div>
            <div
              v-for="(line, i) in newLines"
              :key="i"
              class="grid grid-cols-[1fr_110px_120px_1fr_60px] gap-2 mt-1.5 items-center"
              :data-testid="`rc-line-${i}`"
            >
              <input
                v-model="line.unit"
                type="text"
                placeholder="input"
                class="px-2 py-1.5 text-sm border border-calm-2 rounded-md font-mono focus:border-brand-harmony"
                :data-testid="`rc-line-unit-${i}`"
                @input="linesTouched = true"
              >
              <input
                v-model="line.qty"
                type="text"
                inputmode="numeric"
                placeholder="1000000"
                class="px-2 py-1.5 text-sm border border-calm-2 rounded-md font-mono focus:border-brand-harmony"
                :data-testid="`rc-line-qty-${i}`"
                @input="linesTouched = true"
              >
              <input
                v-model="line.cost"
                type="text"
                inputmode="decimal"
                placeholder="3.00"
                class="px-2 py-1.5 text-sm border border-calm-2 rounded-md font-mono focus:border-brand-harmony"
                :data-testid="`rc-line-cost-${i}`"
                @input="linesTouched = true"
              >
              <input
                v-model="line.model"
                type="text"
                placeholder="any model"
                class="px-2 py-1.5 text-sm border border-calm-2 rounded-md font-mono focus:border-brand-harmony"
                :data-testid="`rc-line-model-${i}`"
                @input="linesTouched = true"
              >
              <UiButton
                kind="ghost"
                size="sm"
                :disabled="newLines.length <= 1"
                :data-testid="`rc-line-remove-${i}`"
                @click="removeLine(i)"
              >
                ✕
              </UiButton>
            </div>
            <p class="text-[11px] text-carbon-3 mt-2">
              Cost is per the stated quantity of units (e.g. $3.00 per 1,000,000 input tokens). Lines can't be
              edited after creation — a price change is a new card.
            </p>
          </div>

          <p v-if="createErrorMsg" class="text-xs text-rag-red mt-3" data-testid="rate-card-create-error" role="alert">
            {{ createErrorMsg }}
          </p>

          <div class="flex justify-end gap-2 mt-5">
            <UiButton kind="ghost" data-testid="rate-card-create-cancel" @click="showCreate = false">Cancel</UiButton>
            <UiButton kind="primary" :disabled="!canSubmit" data-testid="rc-submit" @click="createCard">
              {{ saving ? 'Creating…' : 'Create rate card' }}
            </UiButton>
          </div>
        </div>
      </div>
    </div>
  </div>
  <div v-else class="max-w-[1600px] mx-auto px-10 py-16 text-center" data-admin-page="/admin/rate-cards">
    <div class="text-lg font-bold text-carbon">Admin access required.</div>
  </div>
</template>
