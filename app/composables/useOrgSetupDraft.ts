/*
 * The unsaved Org setup choices (region leaders, new units), the server preview of
 * what they change, and saving them. Every "what this changes" number on the page is
 * `preview`, fetched with the unsaved choices (docs/design/org-setup/00-spec.md).
 */
import { computed, onUnmounted, reactive, ref, watch } from 'vue'
import { apiErrorDetail } from './useApiError'
import type {
  OrgSetupPreviewResponse,
  OrgSetupUnitItem,
  OrgSetupUnitsResponse,
  OrgTreeNode,
  ProposedChanges,
} from '#shared/org-setup/contract'
import {
  defaultUnitName,
  leaderDiff,
  newUnitKey,
  nodeLabel,
  ownsIn,
  proposedLeaders,
  proposedNewUnits,
  saveDraftUnits,
  type DraftUnits,
  type LeaderChoices,
} from '../utils/org-setup-view'

export const PREVIEW_DEBOUNCE_MS = 400

function without<T>(rec: Record<string, T>, keys: readonly string[]): Record<string, T> {
  return Object.fromEntries(Object.entries(rec).filter(([k]) => !keys.includes(k)))
}

interface LeaderRow {
  id: string
  leader_oid: string
}

export function useOrgSetupDraft(opts: { nodes: () => OrgTreeNode[]; refresh: () => Promise<void> }) {
  const leaderChoices = ref<LeaderChoices>({})
  const draftUnits = ref<DraftUnits>({})
  const proposed = computed<ProposedChanges>(() => ({
    leaders: proposedLeaders(opts.nodes(), leaderChoices.value),
    newUnits: proposedNewUnits(draftUnits.value),
  }))

  const preview = ref<OrgSetupPreviewResponse | null>(null)
  /** True from the moment a choice changes until its preview lands. */
  const previewing = ref(false)
  const previewError = ref<string | null>(null)
  /** Previews run only while a setup step is open. */
  const active = ref(false)
  let timer: ReturnType<typeof setTimeout> | null = null
  let seq = 0

  function requestPreview(delayMs = PREVIEW_DEBOUNCE_MS) {
    if (timer) clearTimeout(timer)
    previewing.value = true
    timer = setTimeout(async () => {
      timer = null
      const token = ++seq
      try {
        const res = await $fetch<OrgSetupPreviewResponse>('/api/v1/admin/org-setup/preview', {
          method: 'POST',
          body: proposed.value,
        })
        if (token !== seq) return
        preview.value = res
        previewError.value = null
      } catch (e: unknown) {
        if (token !== seq) return
        previewError.value = apiErrorDetail(e, 'Could not work out what this changes.')
      } finally {
        if (token === seq && timer == null) previewing.value = false
      }
    }, delayMs)
  }

  watch(
    () => JSON.stringify(proposed.value),
    () => {
      if (active.value) requestPreview()
    },
  )
  watch(active, (on) => {
    if (on) requestPreview(0)
  })
  onUnmounted(() => {
    if (timer) clearTimeout(timer)
    seq++
  })
  /** Asks again now: the way out when a preview failed and no choice has changed since. */
  function refreshPreview() {
    requestPreview(0)
  }

  function setLeader(oid: string, regionId: string | null) {
    leaderChoices.value = { ...leaderChoices.value, [oid]: regionId }
  }
  function tick(node: OrgTreeNode, regionId: string) {
    draftUnits.value = { ...draftUnits.value, [node.oid]: { regionId, name: defaultUnitName(node) } }
  }
  function untick(oid: string) {
    draftUnits.value = without(draftUnits.value, [oid])
    unitErrors.value = without(unitErrors.value, [oid])
  }
  function rename(oid: string, name: string) {
    const d = draftUnits.value[oid]
    if (d) draftUnits.value = { ...draftUnits.value, [oid]: { ...d, name } }
  }

  const saving = ref<'leaders' | 'units' | null>(null)
  const leaderErrors = ref<Record<string, string>>({})
  const unitErrors = ref<Record<string, string>>({})
  const saveError = ref<string | null>(null)
  /** Draft key → the unit id it became, for every unit this draft created. */
  const createdUnits = ref<Record<string, string>>({})

  /** Revokes changed leaders, then assigns the new picks. True when every change saved. */
  async function saveLeaders(): Promise<boolean> {
    const submitted = leaderChoices.value
    const { revoke, assign } = leaderDiff(opts.nodes(), submitted)
    if (!revoke.length && !assign.length) return true
    saving.value = 'leaders'
    saveError.value = null
    const errors: Record<string, string> = {}
    const listed = new Map<string, LeaderRow[]>()
    const regionUrl = (id: string) => `/api/v1/admin/regions/${encodeURIComponent(id)}/leaders`
    for (const r of revoke) {
      try {
        let rows = listed.get(r.regionId)
        if (!rows) {
          rows = (await $fetch<{ leaders: LeaderRow[] }>(regionUrl(r.regionId))).leaders ?? []
          listed.set(r.regionId, rows)
        }
        const row = rows.find((l) => l.leader_oid === r.oid)
        if (row) await $fetch(`${regionUrl(r.regionId)}/${encodeURIComponent(row.id)}`, { method: 'DELETE' })
      } catch (e: unknown) {
        errors[r.oid] = apiErrorDetail(e, 'Could not remove them as a region leader.')
      }
    }
    for (const a of assign) {
      if (errors[a.node.oid]) continue
      if (!a.node.email) {
        errors[a.node.oid] = 'The directory has no email for them, so they cannot be made a region leader here.'
        continue
      }
      try {
        await $fetch(regionUrl(a.regionId), {
          method: 'POST',
          body: { leader_oid: a.node.oid, leader_email: a.node.email, kind: 'region-svp', display_name: a.node.name ?? undefined },
        })
      } catch (e: unknown) {
        errors[a.node.oid] = apiErrorDetail(e, `Could not make ${nodeLabel(a.node)} a region leader.`)
      }
    }
    // Only a choice that saved, and still reads as it was sent, leaves the draft: one
    // picked or changed while the requests ran is not saved yet and goes with the next save.
    const kept: LeaderChoices = {}
    for (const [oid, regionId] of Object.entries(leaderChoices.value)) {
      const saved = !errors[oid] && oid in submitted && submitted[oid] === regionId
      if (!saved) kept[oid] = regionId ?? null
    }
    leaderChoices.value = kept
    leaderErrors.value = errors
    try {
      await opts.refresh()
    } finally {
      saving.value = null
      if (active.value) requestPreview(0)
    }
    return Object.keys(errors).length === 0
  }

  /** Creates the drafted units. True when every one was created. */
  async function saveUnits(): Promise<boolean> {
    if (!Object.keys(draftUnits.value).length) return true
    saving.value = 'units'
    saveError.value = null
    const { results, error } = await saveDraftUnits(opts.nodes(), draftUnits.value, (items: OrgSetupUnitItem[]) =>
      $fetch<OrgSetupUnitsResponse>('/api/v1/admin/org-setup/units', { method: 'POST', body: { items } }),
    )
    const errors: Record<string, string> = {}
    const created: string[] = []
    const ids = { ...createdUnits.value }
    for (const [oid, r] of results) {
      if (r.status === 'created') {
        created.push(oid)
        ids[newUnitKey(oid)] = r.orgUnitId
      } else errors[oid] = r.detail || r.reason
    }
    createdUnits.value = ids
    // A created unit leaves the draft whatever its row reads now: the unit exists,
    // and sending it again is refused (its owner already owns one). A unit ticked
    // while the request ran was not sent and stays.
    draftUnits.value = without(draftUnits.value, created)
    unitErrors.value = errors
    if (error) saveError.value = apiErrorDetail(error, 'Saving stopped. The units still ticked here were not created; untick or save them again.')
    try {
      await opts.refresh()
    } finally {
      saving.value = null
      if (active.value) requestPreview(0)
    }
    // A save whose reply was lost still committed: when the refreshed tree shows the
    // owner owning a unit in the draft's region, that draft is done.
    const settled = settledDrafts()
    if (settled.length) {
      for (const [oid, unit] of settled) ids[newUnitKey(oid)] = unit.orgUnitId
      createdUnits.value = { ...ids }
      draftUnits.value = without(draftUnits.value, settled.map(([oid]) => oid))
      unitErrors.value = without(unitErrors.value, settled.map(([oid]) => oid))
    }
    return !error && Object.keys(unitErrors.value).length === 0
  }

  function settledDrafts(): [string, { orgUnitId: string }][] {
    const byOid = new Map(opts.nodes().map((n) => [n.oid, n]))
    const out: [string, { orgUnitId: string }][] = []
    for (const [oid, d] of Object.entries(draftUnits.value)) {
      const node = byOid.get(oid)
      const owned = node ? ownsIn(node, d.regionId) : null
      if (owned) out.push([oid, owned])
    }
    return out
  }

  const unsavedLeaders = computed(() => proposed.value.leaders.length)
  const unsavedUnits = computed(() => proposed.value.newUnits.length)

  return reactive({
    leaderChoices,
    draftUnits,
    proposed,
    preview,
    previewing,
    previewError,
    active,
    saving,
    leaderErrors,
    unitErrors,
    saveError,
    createdUnits,
    unsavedLeaders,
    unsavedUnits,
    requestPreview,
    refreshPreview,
    setLeader,
    tick,
    untick,
    rename,
    saveLeaders,
    saveUnits,
  })
}

export type OrgSetupDraft = ReturnType<typeof useOrgSetupDraft>
