<script setup lang="ts">
/*
 * DrawerBodySyncConflict — body content for a sync-conflict inbox item.
 *
 * Per design-notes §Screen 7: side-by-side cards (manual vs sync); no
 * semantic diff yet (deferred — MVP-Lite spec §"What's deferred").
 *
 * Body payload fields read (all optional):
 *   - field    : string  (which field disagrees, e.g. "Cost-owning unit")
 *   - manual   : string  (value as stored by manual entry)
 *   - sync     : string  (value as reported by the upstream sync)
 *   - source   : string  (sync source name — Pathway / Workday / NetSuite)
 */

import UiCard from '../ui/Card.vue'

const props = defineProps<{
  body: Record<string, unknown>
}>()

function str(k: string, fallback: string): string {
  const v = props.body[k]
  return typeof v === 'string' ? v : fallback
}

const field = str('field', 'Business Unit')
const manualVal = str('manual', '—')
const syncVal = str('sync', '—')
const source = str('source', 'sync source')
</script>

<template>
  <section class="space-y-5">
    <div class="grid grid-cols-2 gap-3">
      <UiCard class="!p-4">
        <div class="text-[11px] font-bold uppercase tracking-[1.2px] text-carbon-3 mb-2">
          Manual
        </div>
        <div class="text-sm font-semibold text-carbon">{{ manualVal }}</div>
        <div class="text-[11px] text-carbon-3 mt-2">{{ field }}</div>
      </UiCard>
      <UiCard accent="vision" class="!p-4">
        <div class="text-[11px] font-bold uppercase tracking-[1.2px] text-carbon-3 mb-2">
          {{ source }}
        </div>
        <div class="text-sm font-semibold text-carbon">{{ syncVal }}</div>
        <div class="text-[11px] text-carbon-3 mt-2">{{ field }}</div>
      </UiCard>
    </div>
    <div>
      <div class="text-[11px] font-bold uppercase tracking-[1.2px] text-carbon-3 mb-2">
        What to do
      </div>
      <p class="text-sm text-carbon-2 leading-relaxed">
        Pick one or escalate. Resolve marks the manual value as the
        canonical and stops the daily reminder; Dismiss keeps the
        conflict tracked but hides it from the inbox for 24 hours.
      </p>
    </div>
  </section>
</template>
