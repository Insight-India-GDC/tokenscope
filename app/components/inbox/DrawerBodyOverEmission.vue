<script setup lang="ts">
/*
 * An escalated over-emission flag (server/notifications/over-emission.ts): one
 * teammate's tool reported more for a UTC day than the provider confirms, and
 * the flag left the teammate's own queue, by their choice or the sweep's.
 */
import { computed } from 'vue'

const props = defineProps<{
  body: Record<string, unknown>
}>()

function text(key: string): string | null {
  const value = props.body[key]
  return typeof value === 'string' ? value : null
}

function number(key: string): number | null {
  const value = props.body[key]
  return typeof value === 'number' ? value : null
}

const usd = (n: number | null) => (n === null ? '—' : `$${n.toFixed(2)}`)
// Computed: the drawer reuses this component when another item is selected.
const teammate = computed(() => text('teammateName') ?? 'This teammate')
const tool = computed(() => text('tool'))
const day = computed(() => text('day'))
const resolvedOverUsd = computed(() => number('resolvedOverUsd'))
const currentOverUsd = computed(() => number('currentOverUsd'))
const computedAt = computed(() => text('computedAt'))
const bySystem = computed(() => text('escalatedBy') === 'system')
const actionHref = computed(() => text('actionHref'))
</script>

<template>
  <section class="space-y-5">
    <div>
      <div class="text-[11px] font-bold uppercase tracking-[1.2px] text-carbon-3 mb-2">
        Usage the provider does not confirm
      </div>
      <p class="text-sm text-carbon-2 leading-relaxed" data-testid="over-emission-facts">
        {{ teammate }}'s <code v-if="tool" class="bg-calm/40 px-1 rounded">{{ tool }}</code> reported more
        <span v-if="day">on {{ day }} (UTC day) </span>than the provider confirms.
        <template v-if="resolvedOverUsd !== null">
          <strong>{{ usd(resolvedOverUsd) }}</strong> was unconfirmed when {{ bySystem ? 'they flagged a session for it' : 'they escalated it' }}.
        </template>
      </p>
      <p class="mt-2 text-[12px] text-carbon-3 leading-relaxed" data-testid="over-emission-current">
        Unconfirmed now: {{ usd(currentOverUsd) }}<span v-if="computedAt">, as of {{ new Date(computedAt).toLocaleString() }}</span>.
        It is recomputed as provider data arrives.
      </p>
    </div>

    <div>
      <div class="text-[11px] font-bold uppercase tracking-[1.2px] text-carbon-3 mb-2">
        Why it is here
      </div>
      <p v-if="bySystem" class="text-sm text-carbon-2 leading-relaxed" data-testid="over-emission-why">
        {{ teammate }} flagged one session as the cause, but that session went on to record usage on
        another day or tool, so excluding it would have hidden genuine usage. TokenScope put the session
        back and escalated the flag to you.
      </p>
      <p v-else class="text-sm text-carbon-2 leading-relaxed" data-testid="over-emission-why">
        {{ teammate }} escalated it to you rather than resolving it from their own usage review.
      </p>
    </div>

    <div>
      <div class="text-[11px] font-bold uppercase tracking-[1.2px] text-carbon-3 mb-2">
        What to do
      </div>
      <p class="text-sm text-carbon-2 leading-relaxed">
        Review their usage for that day with them. The unconfirmed amount stays in their usage: no
        action here excludes it, and resolving or dismissing this item changes neither the flag nor
        their usage.
      </p>
      <UiButton
        v-if="actionHref"
        :to="actionHref"
        kind="primary"
        size="sm"
        class="mt-3"
        data-testid="over-emission-open-teammate"
      >
        Open {{ teammate }}'s usage →
      </UiButton>
    </div>
  </section>
</template>
