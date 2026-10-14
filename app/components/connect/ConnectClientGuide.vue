<script setup lang="ts">
/*
 * ConnectClientGuide — the SINGLE source of truth for per-client "connect this
 * tool to TokenScope" instructions. Rendered in two surfaces:
 *   1. the account page (inline, one card per client), and
 *   2. the homepage connect dialog (ConnectClientDialog wraps this).
 * Both consume this one component so the instructions can never drift apart.
 *
 * The copy is built by connect-guides.ts from THIS deployment's connect config
 * (GET /api/v1/connect/config, #415): marketplace, plugin names and server URL
 * are the admin's "Client connection" policy, never baked here. The parent
 * fetches the config once (useConnectConfig) and passes it in.
 *
 * Steps show only what to do; each step's reasons sit in a collapsed "More
 * detail", and edge cases plus this deployment's server and marketplace sit in a
 * collapsed "Trouble connecting?" (#418).
 */
import { computed } from 'vue'
import { guideClient, type ConnectGuideKind, type ConnectConfig } from '#shared/connect'
import UiCodeBlock from '../ui/CodeBlock.vue'
import ConnectSegments from './ConnectSegments.vue'
import { buildGuide } from './connect-guides'

const props = defineProps<{
  /* Claude Desktop and the CLI share one policy client but install differently. */
  kind: ConnectGuideKind
  /* null while loading or when the fetch failed (see `failed`). */
  config: ConnectConfig | null
  failed?: boolean
  /* Optional heading id — lets a wrapping dialog point aria-labelledby at it. */
  titleId?: string
}>()

const CLIENT_LABEL: Record<ConnectGuideKind, { name: string; icon: string; accent: string; testid: string }> = {
  'claude-desktop': { name: 'Claude Desktop', icon: 'logos:claude-icon', accent: '#D97757', testid: 'connect-claude-desktop' },
  'claude-cli': { name: 'Claude Code CLI', icon: 'logos:claude-icon', accent: '#D97757', testid: 'connect-claude-code' },
  'copilot-cli': { name: 'Copilot CLI', icon: 'logos:github-copilot', accent: '#3e332d', testid: 'connect-copilot-cli' },
}

const head = computed(() => CLIENT_LABEL[props.kind])
const client = computed(() => guideClient(props.kind))
const enabled = computed(() => !props.config || props.config.enabledClients.includes(client.value))
const guide = computed(() => (props.config && enabled.value ? buildGuide(props.kind, props.config) : null))
</script>

<template>
  <div :data-testid="head.testid">
    <!-- Prominent, brand-marked header — unmistakable which client this is for. -->
    <div
      class="flex items-center gap-3 pb-3 mb-4 border-b-2"
      :style="{ borderBottomColor: head.accent }"
    >
      <span
        class="grid place-items-center w-12 h-12 rounded-xl shrink-0"
        :style="{ backgroundColor: `${head.accent}1A` }"
        aria-hidden="true"
      >
        <Icon :name="head.icon" class="text-[26px]" />
      </span>
      <div class="min-w-0">
        <p
          class="text-[11px] font-bold uppercase tracking-[1.4px]"
          :style="{ color: head.accent }"
        >
          About 5 minutes · once per computer
        </p>
        <h3 :id="titleId" class="text-xl font-bold text-carbon leading-tight">Connect {{ head.name }}</h3>
      </div>
    </div>

    <p v-if="failed" class="text-sm text-rag-red" role="alert" data-testid="connect-config-error">
      Couldn’t load this deployment’s connection settings, so there are no instructions to show. Reload the page to try again.
    </p>
    <p v-else-if="!config" class="text-sm text-carbon-3" data-testid="connect-config-loading">
      Loading this deployment’s connection settings…
    </p>
    <p v-else-if="!enabled" class="text-sm text-carbon-2" data-testid="connect-client-disabled">
      {{ head.name }} is not turned on for this TokenScope deployment. Ask your administrator if you need it.
    </p>
    <template v-else-if="guide">
      <p v-if="!config.origin" class="text-[12px] text-rag-red mb-3" role="alert" data-testid="connect-origin-missing">
        {{ config.originMissingReason }}
      </p>

      <p class="text-sm text-carbon-2"><ConnectSegments :segs="guide.lead" /></p>
      <p v-if="guide.prerequisites" class="mt-1 text-[12px] text-carbon-3" data-testid="connect-prerequisites">
        <ConnectSegments :segs="guide.prerequisites" />
      </p>

      <!-- list-none drops the list role in Safari/VoiceOver; role="list" restores it. -->
      <ol class="list-none p-0" role="list">
        <li v-for="(step, si) in guide.steps" :key="si" class="mt-4" data-testid="connect-step">
          <div class="flex items-center gap-2">
            <span class="text-[13px] font-bold text-carbon">{{ step.title }}</span>
            <span
              v-if="step.badge"
              class="text-[10px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded text-white"
              :style="{ backgroundColor: guide.accent }"
              >{{ step.badge }}</span
            >
          </div>

          <p class="text-[12px] text-carbon-2 mt-1"><ConnectSegments :segs="step.intro" /></p>

          <UiCodeBlock
            v-for="(c, ci) in step.commands"
            :key="ci"
            class="mt-1.5"
            :code="c"
            :data-testid="`${guide.cmdTestidPrefix}-${si}-${ci}`"
          />

          <p v-for="(note, ni) in step.notes" :key="ni" class="text-[12px] text-carbon-2 mt-1.5">
            <ConnectSegments :segs="note" />
          </p>

          <details v-if="step.details?.length" class="mt-1" data-testid="connect-step-detail">
            <summary class="text-[11px] text-carbon-3 cursor-pointer select-none">
              More detail<span class="sr-only"> about {{ step.title }}</span>
            </summary>
            <p v-for="(d, di) in step.details" :key="di" class="text-[12px] text-carbon-3 mt-1">
              <ConnectSegments :segs="d" />
            </p>
          </details>
        </li>
      </ol>

      <details class="mt-5 border-t border-calm pt-3" data-testid="connect-troubleshooting">
        <summary class="text-[12px] font-semibold text-carbon-2 cursor-pointer select-none">Trouble connecting?</summary>
        <ul class="mt-2 text-[12px] text-carbon-3 list-disc pl-5 space-y-1">
          <li v-for="(t, ti) in guide.troubleshooting" :key="ti"><ConnectSegments :segs="t" /></li>
        </ul>
        <div class="mt-3" data-testid="connect-server">
          <template v-if="config.origin">
            <p class="text-[12px] font-semibold text-carbon">This deployment’s server</p>
            <UiCodeBlock class="mt-1" :code="config.origin" data-testid="connect-server-url" />
          </template>
          <p v-if="kind === 'claude-desktop' && config.claudeMarketplaceUrl" class="text-[12px] text-carbon-3 mt-1.5" data-testid="connect-marketplace">
            The plugin comes from this deployment’s marketplace
            <code class="text-[11px] bg-calm/40 px-1 rounded">{{ config.claudeMarketplaceUrl }}</code>.
          </p>
          <p v-else-if="client === 'claude-code' && config.claudeMarketplaceUrl" class="text-[12px] text-carbon-3 mt-1.5" data-testid="connect-marketplace">
            The plugin comes from this deployment’s marketplace
            <code class="text-[11px] bg-calm/40 px-1 rounded">{{ config.claudeMarketplaceUrl }}</code>. The Git fallback uses
            <code class="text-[11px] bg-calm/40 px-1 rounded">{{ config.marketplaceSource }}</code
            ><template v-if="config.marketplaceRef">
              at <code class="text-[11px] bg-calm/40 px-1 rounded">{{ config.marketplaceRef }}</code></template
            >.
          </p>
          <p v-else class="text-[12px] text-carbon-3 mt-1.5" data-testid="connect-marketplace">
            Plugins come from the marketplace
            <code class="text-[11px] bg-calm/40 px-1 rounded">{{ config.marketplaceSource }}</code
            ><template v-if="config.marketplaceRef">
              at <code class="text-[11px] bg-calm/40 px-1 rounded">{{ config.marketplaceRef }}</code></template
            >.
          </p>
        </div>
      </details>
      <p v-if="config.supportUrl" class="mt-2 text-[12px] text-carbon-3">
        Still stuck? <a :href="config.supportUrl" target="_blank" rel="noopener noreferrer" class="text-brand-harmony font-semibold hover:underline">Get help</a>.
      </p>
    </template>
  </div>
</template>
