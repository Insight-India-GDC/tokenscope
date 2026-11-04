<script setup lang="ts">
/*
 * Admin → Policies → Client connection (#415). Which plugin marketplace and
 * plugins the connect dialog tells developers to install, which clients it
 * offers, and where they go for help. Platform-admin only, like the API
 * (server/api/v1/admin/settings/client-connection.*). The server URL is not set
 * here: it is the deployment's appPublicOrigin, shown read-only from the same
 * config the dialog reads.
 */
import { computed, ref, watch } from 'vue'
import { useAdminAccess } from '../../../composables/useAdminAccess'
import { apiErrorDetail } from '../../../composables/useApiError'
import {
  CONNECT_CLIENTS,
  needsMcpRegistration,
  managedSettingsJson,
  type ConnectClient,
  type ConnectConfig,
} from '#shared/connect'

definePageMeta({ layout: 'admin', middleware: 'admin' })

const { isPlatform } = useAdminAccess()

interface PolicyResp {
  configured: boolean
  marketplace_source: string
  marketplace_ref: string | null
  marketplace_name: string
  claude_plugin: string
  copilot_plugin: string
  enabled_clients: ConnectClient[]
  support_url: string | null
  updated_at: string | null
}

// Lazy, client-only, null default: docs/design/admin-nav-responsiveness.md D1/D2.
const { data: policy, error: fetchError, refresh } = useLazyFetch<PolicyResp | null>(
  '/api/v1/admin/settings/client-connection',
  { server: false, default: () => null, immediate: isPlatform.value },
)
const { data: connect } = useLazyFetch<ConnectConfig | null>('/api/v1/connect/config', {
  server: false,
  default: () => null,
  immediate: isPlatform.value,
})

const CLIENT_NAMES: Record<ConnectClient, string> = {
  'claude-code': 'Claude Code (Desktop and CLI)',
  'copilot-cli': 'Copilot CLI',
}

/* The same two keys the Desktop guide has each user add, for IT to push instead.
 * Gated on the SAVED policy: unticked-but-unsaved Claude Code still shows it. */
const managedSettings = computed(() =>
  managedSettingsJson(connect.value?.claudeMarketplaceUrl ?? null, policy.value?.enabled_clients ?? []),
)

const source = ref('')
const pinnedRef = ref('')
const marketplaceName = ref('')
const claudePlugin = ref('')
const copilotPlugin = ref('')
const clients = ref<ConnectClient[]>([])
const supportUrl = ref('')
watch(
  policy,
  (v) => {
    if (!v) return
    source.value = v.marketplace_source
    pinnedRef.value = v.marketplace_ref ?? ''
    marketplaceName.value = v.marketplace_name
    claudePlugin.value = v.claude_plugin
    copilotPlugin.value = v.copilot_plugin
    clients.value = [...v.enabled_clients]
    supportUrl.value = v.support_url ?? ''
  },
  { immediate: true },
)

const saving = ref(false)
const saveError = ref<string | null>(null)
const saved = ref(false)
async function save() {
  saving.value = true
  saveError.value = null
  try {
    await $fetch('/api/v1/admin/settings/client-connection', {
      method: 'PUT',
      body: {
        marketplace_source: source.value,
        marketplace_ref: pinnedRef.value || null,
        marketplace_name: marketplaceName.value,
        claude_plugin: claudePlugin.value,
        copilot_plugin: copilotPlugin.value,
        enabled_clients: clients.value,
        support_url: supportUrl.value || null,
      },
    })
    saved.value = true
    setTimeout(() => (saved.value = false), 3000)
    await refresh()
  } catch (e: unknown) {
    saveError.value = apiErrorDetail(e, 'Save failed')
  } finally {
    saving.value = false
  }
}

const inputClass =
  'mt-1 w-full px-3 py-2 text-sm border border-calm-2 rounded-md focus:border-brand-harmony'
</script>

<template>
  <div class="max-w-[1600px] mx-auto px-10 py-8 pb-20" data-testid="admin-policy-client-connection" data-admin-page="/admin/policies/client-connection">
    <UiPageHead
      eyebrow="Policies"
      title="Client connection"
      sub="What the Connect dialog tells developers to install, for this deployment."
    />
    <p v-if="!isPlatform" class="text-sm text-carbon-2">Only an Admin can view or change the client connection policy.</p>
    <template v-else>
      <UiFetchErrorBanner v-if="fetchError" :error="fetchError" label="the client connection policy" @retry="refresh" />
      <AdminPageSkeleton v-else-if="policy == null" :rows="6" :toolbar="false" class="max-w-2xl" />
      <UiCard v-else accent="zeal" class="max-w-2xl" data-testid="admin-client-connection">
        <UiEyebrow>Server</UiEyebrow>
        <p v-if="connect?.origin" class="text-sm mt-2" data-testid="admin-client-connection-origin">
          Developers connect to <code class="text-[12px] bg-calm/40 px-1 rounded">{{ connect.origin }}</code>.
          This is the deployment's public origin (<code class="text-[12px] bg-calm/40 px-1 rounded">appPublicOrigin</code>), not a setting on this page.
        </p>
        <p v-else-if="connect" class="text-sm text-rag-red mt-2" role="alert" data-testid="admin-client-connection-origin-missing">
          {{ connect.originMissingReason }} Until then the Connect dialog cannot show a server URL.
        </p>
        <p v-if="connect?.claudeMarketplaceUrl" class="text-[12px] text-carbon-3 mt-1" data-testid="admin-client-connection-claude-served">
          Claude Code installs from this deployment's own marketplace, <code class="text-[12px] bg-calm/40 px-1 rounded">{{ connect.claudeMarketplaceUrl }}</code>, and that plugin already points here. No Git needed. Claude Desktop users add it to their settings file, because the app's own marketplace form accepts only Git hosts. The Git marketplace below is the CLI fallback the dialog lists under troubleshooting.
        </p>
        <p v-if="connect && needsMcpRegistration(connect, 'claude-code')" class="text-[12px] text-carbon-3 mt-1" data-testid="admin-client-connection-claude-step">
          <template v-if="connect.claudeBundledOrigin">The Claude Code plugin from Git connects to {{ connect.claudeBundledOrigin }}</template>
          <template v-else>The Claude Code plugin from Git ships without a server</template>, so the dialog's Git steps include one that points it at this server.
        </p>
        <p v-if="connect && connect.origin && needsMcpRegistration(connect, 'copilot-cli')" class="text-[12px] text-carbon-3 mt-1" data-testid="admin-client-connection-copilot-step">
          The default Copilot CLI plugin build connects to {{ connect.copilotBundledOrigin }}, so the dialog adds a step that registers this server for the user.
        </p>

        <UiEyebrow class="mt-5">Marketplace</UiEyebrow>
        <div class="space-y-3 text-sm mt-3">
          <div>
            <label for="cc-source" class="text-[12px] font-semibold text-carbon">Source — GitHub <code>owner/repo</code> or an <code>https://</code> git URL</label>
            <input id="cc-source" v-model.trim="source" type="text" :class="inputClass" data-testid="admin-client-connection-source">
          </div>
          <div>
            <label for="cc-ref" class="text-[12px] font-semibold text-carbon">Pinned branch or tag (optional; Claude Code only)</label>
            <input id="cc-ref" v-model.trim="pinnedRef" type="text" :class="inputClass" data-testid="admin-client-connection-ref">
          </div>
          <div>
            <label for="cc-mname" class="text-[12px] font-semibold text-carbon">Marketplace name — the <code>name</code> in its <code>.claude-plugin/marketplace.json</code></label>
            <input id="cc-mname" v-model.trim="marketplaceName" type="text" :class="inputClass" data-testid="admin-client-connection-marketplace-name">
          </div>
          <div class="grid grid-cols-2 gap-3">
            <div>
              <label for="cc-claude" class="text-[12px] font-semibold text-carbon">Claude Code plugin</label>
              <input id="cc-claude" v-model.trim="claudePlugin" type="text" :class="inputClass" data-testid="admin-client-connection-claude-plugin">
            </div>
            <div>
              <label for="cc-copilot" class="text-[12px] font-semibold text-carbon">Copilot CLI plugin</label>
              <input id="cc-copilot" v-model.trim="copilotPlugin" type="text" :class="inputClass" data-testid="admin-client-connection-copilot-plugin">
            </div>
          </div>
          <p class="text-[11px] text-carbon-3">
            Plugin names are the install names in the marketplace. The slash commands keep the plugin's own
            <code>tokenscope:</code> prefix unless your build renames the plugin itself.
          </p>

          <fieldset>
            <legend class="text-[12px] font-semibold text-carbon">Clients offered</legend>
            <label v-for="c in CONNECT_CLIENTS" :key="c" class="flex items-center gap-2 mt-1">
              <input v-model="clients" type="checkbox" :value="c" :data-testid="`admin-client-connection-client-${c}`">
              {{ CLIENT_NAMES[c] }}
            </label>
          </fieldset>

          <div>
            <label for="cc-support" class="text-[12px] font-semibold text-carbon">Support link (optional, https)</label>
            <input id="cc-support" v-model.trim="supportUrl" type="url" :class="inputClass" data-testid="admin-client-connection-support">
          </div>

          <p v-if="!policy.configured" class="text-[11px] text-carbon-3 italic">Not configured: these are the defaults the dialog uses.</p>
          <p v-if="saveError" class="text-xs text-rag-red" role="alert">{{ saveError }}</p>
          <p v-if="saved" class="text-xs text-brand-harmony" data-testid="admin-client-connection-saved">Saved.</p>
          <div class="flex justify-end">
            <UiButton kind="primary" size="sm" :disabled="saving" data-testid="admin-client-connection-save" @click="save">
              {{ saving ? 'Saving…' : 'Save' }}
            </UiButton>
          </div>
        </div>
      </UiCard>

      <UiCard v-if="managedSettings" class="max-w-2xl mt-5" data-testid="admin-client-connection-managed">
        <UiEyebrow>Install for everyone (untested)</UiEyebrow>
        <p class="text-sm mt-2">
          Claude Code documents these keys in its managed settings file as the way to install a plugin on every
          computer. This has not been tested with TokenScope, and an open Claude Code issue
          (<a href="https://github.com/anthropics/claude-code/issues/16870" target="_blank" rel="noopener noreferrer" class="text-brand-harmony font-semibold hover:underline">#16870</a>)
          reports managed marketplaces being ignored, including by the Windows desktop app. Try one computer before
          rolling it out. Developers still sign in and run <code class="text-[12px] bg-calm/40 px-1 rounded">/tokenscope:setup</code> once.
        </p>
        <UiCodeBlock class="mt-2" :code="managedSettings" data-testid="admin-client-connection-managed-json" />
        <p class="text-[12px] text-carbon-3 mt-2">
          A device that already added a <code class="text-[11px] bg-calm/40 px-1 rounded">tokenscope</code> marketplace from Git keeps that one,
          and Claude Code refuses a second source under the same name: remove it there first
          (<code class="text-[11px] bg-calm/40 px-1 rounded">/plugin marketplace remove tokenscope</code>). To also limit which marketplaces
          developers can add, set <code class="text-[11px] bg-calm/40 px-1 rounded">strictKnownMarketplaces</code> as well; this block does not.
        </p>
        <p class="text-[12px] text-carbon-3 mt-2">
          Merge them into the file your device management already deploys, or create it:
        </p>
        <ul class="text-[12px] text-carbon-3 list-disc pl-5 mt-1 space-y-0.5">
          <li>macOS: <code class="text-[11px] bg-calm/40 px-1 rounded">/Library/Application Support/ClaudeCode/managed-settings.json</code></li>
          <li>Windows: <code class="text-[11px] bg-calm/40 px-1 rounded">C:\Program Files\ClaudeCode\managed-settings.json</code></li>
          <li>Linux: <code class="text-[11px] bg-calm/40 px-1 rounded">/etc/claude-code/managed-settings.json</code></li>
        </ul>
      </UiCard>
    </template>
  </div>
</template>
