<script setup lang="ts">
/*
 * My account → linked identities. A teammate adds the Claude / GitHub / client
 * emails they use so spend across all of them attributes to them
 * (teammate_identity_map). Integrity: you can't claim an identity owned by
 * another teammate or already linked (server-enforced); links are unverified +
 * audited. See docs/design/client-attribution-auth-spec.md §2.
 */
// Render-boundary sanitizer for a self-registered client_name — see S6: names
// registered before the bounds fix shipped may still carry control/bidi
// characters, so this strips them defensively wherever the name is displayed.
import { sanitizeClientNameForDisplay } from '#shared/schemas/oauth'
import { useConnectConfig } from '../composables/useConnectConfig'

interface Identity {
  id: string
  system: string
  identifier: string
  kind: string
  verified: boolean
  source: string
}

const { data, refresh } = await useFetch<{ primary: string; identities: Identity[] }>(
  '/api/v1/me/identities',
  { default: () => ({ primary: '', identities: [] }) },
)

const newSystem = ref<'claude-code' | 'github' | 'copilot-cli' | 'other'>('claude-code')
const newKind = ref<'email' | 'username'>('email')
const newIdentifier = ref('')
const busy = ref(false)
const error = ref<string | null>(null)

async function addIdentity() {
  const identifier = newIdentifier.value.trim()
  if (!identifier) return
  busy.value = true
  error.value = null
  try {
    await $fetch('/api/v1/me/identities', {
      method: 'POST',
      body: { system: newSystem.value, identifier, identifier_kind: newKind.value },
    })
    newIdentifier.value = ''
    await refresh()
  } catch (e: unknown) {
    error.value = apiErrorDetail(e, 'Failed to link identity')
  } finally {
    busy.value = false
  }
}

async function removeIdentity(id: string) {
  busy.value = true
  error.value = null
  try {
    await $fetch(`/api/v1/me/identities/${id}`, { method: 'DELETE' })
    await refresh()
  } catch (e: unknown) {
    error.value = apiErrorDetail(e, 'Failed to remove')
  } finally {
    busy.value = false
  }
}

// ── Connect Claude Code (MCP-first model) ──
//   1. Install the plugin (once, inside Claude Code) — the MCP server it
//      registers handles emit provisioning + querying via OAuth.
//   2. Tag a REPO's project via a committed `.tokenscope` file — no token; the
//      tag travels with the repo and is membership-gated at attribution time.
// Device emit is now provisioned by the MCP `provision_emit` tool (the
// tokenscope-setup prompt) over the MCP OAuth connection — there is no
// web-minted device/setup token anymore.
const { data: projData } = await useFetch<{ projects: { id: string; code: string; display_name: string }[] }>(
  '/api/v1/me/projects',
  { default: () => ({ projects: [] }) },
)

// Install commands now live in the shared ConnectClientGuide component (the
// single source for both this page and the homepage connect dialog), built from
// this deployment's connect config (#415).
const {
  config: connectConfig,
  failed: connectConfigFailed,
  isEnabled: isClientEnabled,
} = useConnectConfig()

// Tagging is now the `project` MCP prompt: it lists the projects you can bill,
// you pick one, and it writes the committable `.tokenscope` + tags the repo
// (no code to type, no token). Surfaced in Claude Code as a slash command.
const applyCmd = '/plugin:tokenscope:tokenscope:project'

// ── Your devices (ADR-0005 decision 3 — dev: spot + block your own) ──
// List the caller's own enrolled instances with per-device spend + anomaly
// flags, and a self-service revoke that sets ts_actual_end → /bearer 401s →
// emission stops. Owner-scoped server-side (teammate_id = session).
interface MyInstance {
  instance_id: string
  tool: string
  project: string | null
  ts_start: string
  ts_actual_end: string | null
  last_emission: string | null
  spend_usd_mtd: string
  revoked: boolean
  silent: boolean
}
const { data: instData, refresh: refreshInstances } = await useFetch<{ instances: MyInstance[] }>(
  '/api/v1/me/instances',
  { default: () => ({ instances: [] }) },
)
const revokingInst = ref<Set<string>>(new Set())
const instToast = ref<{ kind: 'ok' | 'err'; message: string } | null>(null)
let instToastTimer: ReturnType<typeof setTimeout> | null = null
function flashInstToast(kind: 'ok' | 'err', message: string) {
  instToast.value = { kind, message }
  if (instToastTimer) clearTimeout(instToastTimer)
  instToastTimer = setTimeout(() => { instToast.value = null }, 3500)
}

async function revokeInstance(id: string) {
  if (!confirm('Revoke this device? It will stop emitting usage immediately. You can re-enrol later.')) return
  revokingInst.value = new Set([...revokingInst.value, id])
  try {
    await $fetch(`/api/v1/me/instances/${id}/revoke`, { method: 'POST', body: {} })
    flashInstToast('ok', 'Device revoked — emission stopped.')
    await refreshInstances()
  } catch (e: unknown) {
    flashInstToast('err', apiErrorDetail(e, 'Revoke failed.'))
  } finally {
    const next = new Set(revokingInst.value)
    next.delete(id)
    revokingInst.value = next
  }
}

function fmtTs(v: string | null): string {
  return v ? new Date(v).toLocaleString() : '—'
}

// ── Devices awaiting confirmation (emit-on-install, slice 5) ──
// Provisional devices that emitted under YOUR claimed email BEFORE you signed in
// (the plugin enrols + emits on install, no login). Confirming one is the audited
// merge that folds its pre-sign-in usage onto your real identity — display only,
// it NEVER moves money (finance tracks the provider bill, not identity_state).
// Owner-scoped by email match server-side: only devices that claimed YOUR email
// are ever returned, so this list leaks nothing about anyone else.
interface ProvisionalInstance {
  instance_id: string
  tool: string
  device_hint: string | null
  first_seen: string
  last_seen: string | null
  provisional_spend_usd: string
}
const { data: provData, refresh: refreshProvisional } = await useFetch<{ provisional_instances: ProvisionalInstance[] }>(
  '/api/v1/me/provisional-instances',
  { default: () => ({ provisional_instances: [] }) },
)
const confirmingInst = ref<Set<string>>(new Set())
const provToast = ref<{ kind: 'ok' | 'err'; message: string } | null>(null)
let provToastTimer: ReturnType<typeof setTimeout> | null = null
function flashProvToast(kind: 'ok' | 'err', message: string) {
  provToast.value = { kind, message }
  if (provToastTimer) clearTimeout(provToastTimer)
  provToastTimer = setTimeout(() => { provToast.value = null }, 3500)
}

async function confirmInstance(id: string) {
  if (!confirm('Confirm this device is yours? Its usage from before you signed in will be merged onto your identity. This only changes how spend is labelled — it never changes what you’re billed.')) return
  confirmingInst.value = new Set([...confirmingInst.value, id])
  try {
    await $fetch(`/api/v1/me/provisional-instances/${id}/confirm`, { method: 'POST', body: {} })
    flashProvToast('ok', 'Device confirmed — its earlier usage is now yours.')
    // The device moves provisional → confirmed: drop it from this list and let it
    // surface under "Your devices".
    await Promise.all([refreshProvisional(), refreshInstances()])
  } catch (e: unknown) {
    flashProvToast('err', apiErrorDetail(e, 'Confirm failed.'))
  } finally {
    const next = new Set(confirmingInst.value)
    next.delete(id)
    confirmingInst.value = next
  }
}

// ── Authorized connections (oauth grants) ──
// MCP/OAuth clients the dev approved (the consent flow's grant rows). Each shows
// the client, plain-language scopes, derived state, and a Revoke. Revoking a
// read+tag grant logs that client out; revoking an emit grant ALSO stops the
// device emitting (the server cascades ts_actual_end). Owner-scoped server-side.
interface Grant {
  id: string
  client_id: string
  client_name: string
  client_registered_at: string
  scopes: string[]
  scope_labels: string[]
  state: 'active' | 'inactive' | 'revoked' | 'expired'
  created_at: string
  last_used_at: string | null
  is_emit: boolean
}
const { data: grantData, refresh: refreshGrants } = await useFetch<{ grants: Grant[] }>(
  '/api/v1/me/grants',
  { default: () => ({ grants: [] }) },
)
const revokingGrant = ref<Set<string>>(new Set())
const grantToast = ref<{ kind: 'ok' | 'err'; message: string } | null>(null)
let grantToastTimer: ReturnType<typeof setTimeout> | null = null
function flashGrantToast(kind: 'ok' | 'err', message: string) {
  grantToast.value = { kind, message }
  if (grantToastTimer) clearTimeout(grantToastTimer)
  grantToastTimer = setTimeout(() => { grantToast.value = null }, 3500)
}

function grantBadge(g: Grant): { kind: 'hunger' | 'rag-amber' | 'rag-green'; label: string } {
  switch (g.state) {
    case 'revoked': return { kind: 'hunger', label: 'Revoked' }
    case 'expired': return { kind: 'rag-amber', label: 'Expired' }
    case 'inactive': return { kind: 'rag-amber', label: 'Inactive' }
    default: return { kind: 'rag-green', label: 'Active' }
  }
}

async function revokeGrant(g: Grant) {
  // Cascade-aware confirm: emit grants stop the device emitting; read+tag grants
  // just log the client out.
  const msg = g.is_emit
    ? 'Revoke this connection? Revoking this emit grant stops this device emitting usage immediately. You can re-enrol later.'
    : 'Revoke this connection? Revoking this MCP grant logs that client out — it will need to reconnect (re-consent) to use TokenScope again.'
  if (!confirm(msg)) return
  revokingGrant.value = new Set([...revokingGrant.value, g.id])
  try {
    await $fetch(`/api/v1/me/grants/${g.id}/revoke`, { method: 'POST', body: {} })
    flashGrantToast('ok', g.is_emit ? 'Connection revoked — device emission stopped.' : 'Connection revoked — client logged out.')
    await refreshGrants()
  } catch (e: unknown) {
    flashGrantToast('err', apiErrorDetail(e, 'Revoke failed.'))
  } finally {
    const next = new Set(revokingGrant.value)
    next.delete(g.id)
    revokingGrant.value = next
  }
}

// ── Personal subscription declaration (ADR-0011 D3/D4) ──
// A teammate-level attribute, not an org one — see docs/design/
// usage-completeness-and-provider-governance.md §4.3. Declaring a tool as
// personal exempts ITS usage from the "no bill to corroborate" suspicion and
// from chargeback; it never auto-classifies (only this form ever creates one).
interface PersonalSubscriptionDeclaration {
  id: string
  tool: string
  subscriptionType: string
  monthlyCostUsd: number
  declaredAt: string
}
const { data: subsData, refresh: refreshSubs } = await useFetch<{ declarations: PersonalSubscriptionDeclaration[] }>(
  '/api/v1/me/personal-subscription',
  { default: () => ({ declarations: [] }) },
)
const PERSONAL_SUB_TOOLS = [
  { value: 'claude-code', label: 'Claude Code' },
  { value: 'claude-ai', label: 'Claude Chat' },
  { value: 'claude-cowork', label: 'Claude Cowork' },
  { value: 'claude-office', label: 'Claude for Office' },
  { value: 'claude-chrome', label: 'Claude for Chrome' },
  { value: 'claude-design', label: 'Claude for Design' },
  { value: 'claude-slack', label: 'Claude for Slack' },
]
const newSubTool = ref('claude-code')
const newSubType = ref('')
const newSubCost = ref<number | null>(null)
const subBusy = ref(false)
const subError = ref<string | null>(null)

async function declarePersonalSubscription() {
  if (!newSubType.value.trim() || newSubCost.value == null) return
  subBusy.value = true
  subError.value = null
  try {
    await $fetch('/api/v1/me/personal-subscription', {
      method: 'PUT',
      body: { tool: newSubTool.value, subscriptionType: newSubType.value.trim(), monthlyCostUsd: newSubCost.value },
    })
    newSubType.value = ''
    newSubCost.value = null
    await refreshSubs()
  } catch (e: unknown) {
    subError.value = apiErrorDetail(e, 'Failed to declare personal subscription')
  } finally {
    subBusy.value = false
  }
}

async function revokePersonalSubscription(tool: string) {
  subBusy.value = true
  subError.value = null
  try {
    await $fetch(`/api/v1/me/personal-subscription/${tool}`, { method: 'DELETE' })
    await refreshSubs()
  } catch (e: unknown) {
    subError.value = apiErrorDetail(e, 'Failed to revoke')
  } finally {
    subBusy.value = false
  }
}
</script>

<template>
  <div class="max-w-3xl mx-auto px-6 py-8" data-testid="account-page">
    <p class="text-xs font-bold uppercase tracking-[1.4px] text-brand-harmony">My account</p>
    <h1 class="text-3xl font-bold tracking-tight text-carbon mt-2">Linked identities</h1>
    <p class="text-sm text-carbon-2 mt-1">
      Add the Claude / GitHub / client emails you use — spend across all of them then attributes to you.
    </p>

    <UiCard class="mt-6 mb-5">
      <UiEyebrow>Primary</UiEyebrow>
      <div class="text-sm font-semibold text-carbon mt-1">{{ data?.primary }}</div>
      <div class="text-[11px] text-carbon-3">Your Entra identity — can't be removed.</div>
    </UiCard>

    <UiCard class="mb-5">
      <UiEyebrow>Linked identities</UiEyebrow>
      <ul v-if="data?.identities?.length" class="mt-3 divide-y divide-calm-2" data-testid="identity-list">
        <li v-for="i in data.identities" :key="i.id" class="flex items-center gap-3 py-2">
          <div class="min-w-0 flex-1">
            <div class="text-sm text-carbon truncate">{{ i.identifier }}</div>
            <div class="text-[11px] text-carbon-3">
              {{ i.system }} · {{ i.kind }} ·
              <span :class="i.verified ? 'text-rag-green' : 'text-carbon-3'">{{ i.verified ? 'verified' : 'unverified' }}</span>
            </div>
          </div>
          <UiButton v-if="i.source === 'self'" kind="ghost" size="sm" :disabled="busy" :data-testid="`remove-${i.id}`" @click="removeIdentity(i.id)">
            Remove
          </UiButton>
        </li>
      </ul>
      <p v-else class="text-xs text-carbon-2 mt-2">No linked identities yet.</p>
    </UiCard>

    <UiCard>
      <UiEyebrow>Link an identity</UiEyebrow>
      <div class="flex flex-wrap items-end gap-2 mt-3">
        <select v-model="newSystem" class="text-sm border border-calm-2 rounded-md px-2 py-2 bg-white" data-testid="new-system">
          <option value="claude-code">Claude Code</option>
          <option value="github">GitHub</option>
          <option value="copilot-cli">Copilot</option>
          <option value="other">Other</option>
        </select>
        <select v-model="newKind" class="text-sm border border-calm-2 rounded-md px-2 py-2 bg-white">
          <option value="email">Email</option>
          <option value="username">Username</option>
        </select>
        <input
          v-model="newIdentifier"
          type="text"
          placeholder="name@example.com"
          class="flex-1 min-w-[220px] px-3 py-2 text-sm border border-calm-2 rounded-md focus:border-brand-harmony"
          data-testid="new-identifier"
          @keyup.enter="addIdentity"
        >
        <UiButton kind="primary" size="sm" :disabled="busy || !newIdentifier.trim()" data-testid="link-identity" @click="addIdentity">
          Link
        </UiButton>
      </div>
      <p v-if="error" class="text-xs text-rag-red mt-2" data-testid="identity-error">{{ error }}</p>
      <p class="text-[11px] text-carbon-3 mt-3">
        Linked identities are unverified + audited. You can't claim an identity that belongs to another teammate.
      </p>
    </UiCard>

    <!-- Devices awaiting confirmation — provisional emit-on-install devices that
         claimed your email before you signed in. Only rendered when there's
         something to confirm (an action inbox, not a persistent surface).
         Confirming merges their pre-sign-in usage onto you (display only). -->
    <!-- Confirm-result toast lives OUTSIDE the conditional card: confirming your
         LAST provisional device empties the list and unmounts the card, so a toast
         nested inside would flash away before it's readable. Kept here so the
         "Device confirmed" feedback survives the list going empty. -->
    <div
      v-if="provToast"
      :data-testid="`provisional-toast-${provToast.kind}`"
      class="mt-5 p-2.5 rounded-md text-sm font-medium"
      :class="provToast.kind === 'ok'
        ? 'bg-brand-harmony-sheer text-brand-harmony border border-brand-harmony/30'
        : 'bg-brand-hunger/10 text-brand-heart border border-brand-hunger/30'"
    >
      {{ provToast.message }}
    </div>

    <UiCard
      v-if="provData?.provisional_instances?.length"
      class="mt-5 border-brand-harmony/40"
      data-testid="provisional-instances"
    >
      <div class="flex items-center gap-2">
        <UiEyebrow>Devices awaiting confirmation</UiEyebrow>
        <UiBadge kind="rag-amber" data-testid="provisional-count">{{ provData.provisional_instances.length }}</UiBadge>
      </div>
      <p class="text-sm text-carbon-2 mt-1">
        These devices started emitting usage under your email <strong>before you signed in</strong>
        (the plugin enrols on install). Confirm the ones that are yours to fold their earlier usage
        onto your identity. This only changes how spend is <strong>labelled</strong> — it never
        changes what you're billed. Don't recognise one? Leave it unconfirmed and tell your admin.
      </p>

      <ul class="mt-3 divide-y divide-calm-2" data-testid="provisional-list">
        <li
          v-for="inst in provData.provisional_instances"
          :key="inst.instance_id"
          class="flex flex-wrap items-center gap-3 py-3"
        >
          <div class="min-w-0 flex-1">
            <div class="flex items-center gap-2">
              <code class="text-[11px] bg-calm/40 px-1 rounded text-carbon">{{ inst.instance_id.slice(0, 8) }}</code>
              <span class="text-[12px] text-carbon-2">{{ inst.tool }}</span>
              <span v-if="inst.device_hint" class="text-[11px] text-carbon-3">· device {{ inst.device_hint }}</span>
              <UiBadge kind="rag-amber">Provisional</UiBadge>
            </div>
            <div class="text-[11px] text-carbon-3 mt-1">
              ${{ inst.provisional_spend_usd }} so far ·
              first seen {{ fmtTs(inst.first_seen) }} ·
              last seen {{ fmtTs(inst.last_seen) }}
            </div>
          </div>
          <UiButton
            kind="primary"
            size="sm"
            :disabled="confirmingInst.has(inst.instance_id)"
            :data-testid="`provisional-confirm-${inst.instance_id}`"
            @click="confirmInstance(inst.instance_id)"
          >
            <span v-if="confirmingInst.has(inst.instance_id)">…</span>
            <span v-else>This is mine</span>
          </UiButton>
        </li>
      </ul>
    </UiCard>

    <!-- Your devices — per-instance spend + anomaly flags + self-service revoke -->
    <UiCard class="mt-5" data-testid="my-instances">
      <UiEyebrow>Your devices</UiEyebrow>
      <p class="text-sm text-carbon-2 mt-1">
        Devices you've enrolled with TokenScope. If one is emitting spend you don't
        recognise — or went quiet unexpectedly — revoke it. Revoking stops emission
        immediately; you can re-enrol later.
      </p>

      <div
        v-if="instToast"
        :data-testid="`my-instances-toast-${instToast.kind}`"
        class="mt-3 p-2.5 rounded-md text-sm font-medium"
        :class="instToast.kind === 'ok'
          ? 'bg-brand-harmony-sheer text-brand-harmony border border-brand-harmony/30'
          : 'bg-brand-hunger/10 text-brand-heart border border-brand-hunger/30'"
      >
        {{ instToast.message }}
      </div>

      <ul
        v-if="instData?.instances?.length"
        class="mt-3 divide-y divide-calm-2"
        data-testid="my-instances-list"
      >
        <li
          v-for="inst in instData.instances"
          :key="inst.instance_id"
          class="flex flex-wrap items-center gap-3 py-3"
        >
          <div class="min-w-0 flex-1">
            <div class="flex items-center gap-2">
              <code class="text-[11px] bg-calm/40 px-1 rounded text-carbon">{{ inst.instance_id.slice(0, 8) }}</code>
              <span class="text-[12px] text-carbon-2">{{ inst.tool }}</span>
              <span v-if="inst.project" class="text-[11px] text-carbon-3">· {{ inst.project }}</span>
              <UiBadge v-if="inst.revoked" kind="hunger" :data-testid="`instance-revoked-${inst.instance_id}`">Revoked</UiBadge>
              <UiBadge v-else-if="inst.silent" kind="rag-amber" :data-testid="`instance-silent-${inst.instance_id}`">Silent</UiBadge>
              <UiBadge v-else kind="rag-green">Active</UiBadge>
            </div>
            <div class="text-[11px] text-carbon-3 mt-1">
              ${{ inst.spend_usd_mtd }} this month ·
              last emission {{ fmtTs(inst.last_emission) }} ·
              enrolled {{ fmtTs(inst.ts_start) }}
            </div>
          </div>
          <UiButton
            v-if="!inst.revoked"
            kind="ghost"
            size="sm"
            :disabled="revokingInst.has(inst.instance_id)"
            :data-testid="`instance-revoke-${inst.instance_id}`"
            @click="revokeInstance(inst.instance_id)"
          >
            <span v-if="revokingInst.has(inst.instance_id)">…</span>
            <span v-else>Revoke</span>
          </UiButton>
        </li>
      </ul>
      <p v-else class="text-xs text-carbon-2 mt-2" data-testid="my-instances-empty">
        No enrolled devices yet — enrol one below.
      </p>
    </UiCard>

    <!-- Authorized connections — the OAuth/MCP grants the dev consented to -->
    <UiCard class="mt-5" data-testid="my-grants">
      <UiEyebrow>Authorized connections</UiEyebrow>
      <p class="text-sm text-carbon-2 mt-1">
        Clients (Claude Code and other MCP clients) you've connected to TokenScope.
        Revoking a connection logs that client out; if the connection also emits
        usage from this device, revoking stops that emission immediately. You can
        reconnect later (you'll be asked to consent again).
      </p>

      <div
        v-if="grantToast"
        :data-testid="`my-grants-toast-${grantToast.kind}`"
        class="mt-3 p-2.5 rounded-md text-sm font-medium"
        :class="grantToast.kind === 'ok'
          ? 'bg-brand-harmony-sheer text-brand-harmony border border-brand-harmony/30'
          : 'bg-brand-hunger/10 text-brand-heart border border-brand-hunger/30'"
      >
        {{ grantToast.message }}
      </div>

      <ul
        v-if="grantData?.grants?.length"
        class="mt-3 divide-y divide-calm-2"
        data-testid="my-grants-list"
      >
        <li
          v-for="g in grantData.grants"
          :key="g.id"
          class="flex flex-wrap items-center gap-3 py-3"
        >
          <div class="min-w-0 flex-1">
            <div class="flex items-center gap-2">
              <span class="text-sm font-medium text-carbon truncate">{{ sanitizeClientNameForDisplay(g.client_name) }}</span>
              <code
                class="text-[10px] bg-calm/40 px-1 rounded text-carbon-3"
                :title="`Client registered ${fmtTs(g.client_registered_at)}`"
                :data-testid="`grant-client-id-${g.id}`"
              >{{ g.client_id.slice(0, 8) }}</code>
              <UiBadge
                :kind="grantBadge(g).kind"
                :data-testid="`grant-state-${g.id}`"
              >{{ grantBadge(g).label }}</UiBadge>
              <UiBadge v-if="g.is_emit" kind="rag-amber" :data-testid="`grant-emit-${g.id}`">Emits</UiBadge>
            </div>
            <ul class="mt-1 space-y-0.5">
              <li v-for="(label, i) in g.scope_labels" :key="i" class="text-[11px] text-carbon-3">
                · {{ label }}
              </li>
            </ul>
            <div class="text-[11px] text-carbon-3 mt-1">
              connected {{ fmtTs(g.created_at) }} ·
              last used {{ fmtTs(g.last_used_at) }}
            </div>
          </div>
          <UiButton
            v-if="g.state !== 'revoked'"
            kind="ghost"
            size="sm"
            :disabled="revokingGrant.has(g.id)"
            :data-testid="`grant-revoke-${g.id}`"
            @click="revokeGrant(g)"
          >
            <span v-if="revokingGrant.has(g.id)">…</span>
            <span v-else>Revoke</span>
          </UiButton>
          <span v-else class="text-[11px] text-carbon-3">—</span>
        </li>
      </ul>
      <p v-else class="text-xs text-carbon-2 mt-2" data-testid="my-grants-empty">
        No authorized connections yet — connect a client to TokenScope to see it here.
      </p>
    </UiCard>

    <!-- Cards 1a/1b — connect Claude Desktop, then the Claude Code CLI: one policy
         client, two installs (the app cannot add a URL marketplace). The instructions
         live in ConnectClientGuide so they can't drift from the homepage dialog. -->
    <UiCard v-if="isClientEnabled('claude-code')" class="mt-5">
      <ConnectClientGuide kind="claude-desktop" :config="connectConfig" :failed="connectConfigFailed" />
    </UiCard>

    <UiCard v-if="isClientEnabled('claude-code')" class="mt-5">
      <ConnectClientGuide kind="claude-cli" :config="connectConfig" :failed="connectConfigFailed" />
    </UiCard>

    <!-- Card 1b — connect Copilot CLI (same shared guide component). -->
    <UiCard v-if="isClientEnabled('copilot-cli')" id="connect-copilot-cli" class="mt-5">
      <ConnectClientGuide kind="copilot-cli" :config="connectConfig" :failed="connectConfigFailed" />
    </UiCard>

    <!-- Card 2 — tag a repo's project (one step: writes .tokenscope + tags) -->
    <UiCard class="mt-5" data-testid="tag-project">
      <UiEyebrow>Tag a repo's project</UiEyebrow>
      <p class="text-sm text-carbon-2 mt-1">
        In the repo, run one command in Claude Code. It writes a committable
        <code class="text-[11px] bg-calm/40 px-1 rounded">.tokenscope</code> file
        <strong>and</strong> tags this repo. The tag travels with the repo, so everyone
        working in it attributes to the same project. Attribution is
        <strong>membership-gated</strong> — you can only bill projects you're assigned to.
      </p>

      <!-- Single step — run the project MCP prompt in the repo -->
      <div class="mt-4">
        <div class="flex items-center gap-2">
          <span class="text-[13px] font-bold text-carbon">Tag the repo</span>
          <span class="text-[10px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded bg-brand-harmony-sheer text-brand-harmony">In Claude Code</span>
        </div>
        <p class="text-[12px] text-carbon-3 mt-1">
          Run the <strong>project</strong> MCP prompt in the repo — it lists the projects you can bill,
          you pick one, and it writes <code class="text-[11px] bg-calm/40 px-1 rounded">.tokenscope</code>
          (commit it so teammates inherit the tag) and tags this checkout:
        </p>
        <UiCodeBlock class="mt-1.5" :code="applyCmd" data-testid="apply-project-command" />
        <div class="mt-3">
          <p class="text-[12px] font-semibold text-carbon">Your project codes</p>
          <ul v-if="projData?.projects?.length" class="mt-1 space-y-0.5" data-testid="project-codes">
            <li v-for="p in projData.projects" :key="p.id" class="text-[12px] text-carbon-2">
              <code class="text-[11px] bg-calm/40 px-1 rounded">{{ p.code }}</code> — {{ p.display_name }}
            </li>
          </ul>
          <p v-else class="text-[12px] text-carbon-3 mt-1" data-testid="no-project-codes">
            You're not assigned to any project yet — ask an admin.
          </p>
        </div>
        <p class="text-[11px] text-carbon-3 mt-3">
          No token needed for tagging — a committed <code class="text-[11px] bg-calm/40 px-1 rounded">.tokenscope</code>
          plus your connected device is enough. Teammates who clone a repo that already has one can just run
          the <strong>project</strong> MCP prompt with no project (or let the
          SessionStart hook auto-apply it).
        </p>
      </div>
    </UiCard>
    <UiCard id="personal-subscription" class="mt-5" data-testid="personal-subscription">
      <UiEyebrow>Personal subscription</UiEyebrow>
      <p class="text-sm text-carbon-2 mt-1">
        If you pay for your own Claude subscription personally (not through Insight), declare it here.
        Declared usage stays visible in your usage (showback) and is never flagged as suspicious for
        having no Insight bill behind it. Declaring does not by itself change what is charged back:
        chargeback follows the provider bill, so usage with no Insight invoice behind it is not charged.
        Scoped exactly to the tool you declare — nothing is ever auto-classified.
      </p>

      <ul v-if="subsData?.declarations?.length" class="mt-3 divide-y divide-calm-2" data-testid="personal-subscription-list">
        <li v-for="d in subsData.declarations" :key="d.id" class="py-2 flex items-center justify-between gap-2">
          <div>
            <p class="text-[13px] font-semibold text-carbon">{{ d.tool }} — {{ d.subscriptionType }}</p>
            <p class="text-[12px] text-carbon-3">${{ d.monthlyCostUsd.toFixed(2) }}/mo · declared {{ new Date(d.declaredAt).toLocaleDateString() }}</p>
          </div>
          <UiButton
            kind="ghost"
            size="sm"
            :disabled="subBusy"
            :data-testid="`revoke-personal-subscription-${d.tool}`"
            @click="revokePersonalSubscription(d.tool)"
          >
            Revoke
          </UiButton>
        </li>
      </ul>

      <div class="mt-3 flex flex-wrap items-end gap-2">
        <select v-model="newSubTool" class="text-sm border border-calm-2 rounded-md px-2 py-2 bg-white" data-testid="new-sub-tool">
          <option v-for="t in PERSONAL_SUB_TOOLS" :key="t.value" :value="t.value">{{ t.label }}</option>
        </select>
        <input
          v-model="newSubType"
          type="text"
          placeholder="e.g. Claude Max"
          class="flex-1 min-w-[10rem] border border-calm-2 rounded-md px-2 py-2 text-sm"
          data-testid="new-sub-type"
        >
        <input
          v-model.number="newSubCost"
          type="number"
          min="0"
          step="0.01"
          placeholder="Monthly cost ($)"
          class="w-40 border border-calm-2 rounded-md px-2 py-2 text-sm"
          data-testid="new-sub-cost"
        >
        <UiButton
          kind="primary"
          size="sm"
          :disabled="subBusy || !newSubType.trim() || newSubCost == null"
          data-testid="declare-personal-subscription"
          @click="declarePersonalSubscription"
        >
          Declare
        </UiButton>
      </div>
      <p v-if="subError" class="text-xs text-rag-red mt-2" data-testid="personal-subscription-error">{{ subError }}</p>
    </UiCard>
  </div>
</template>
