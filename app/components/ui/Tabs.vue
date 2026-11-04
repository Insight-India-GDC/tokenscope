<script setup lang="ts">
/*
 * UiTabs — top-level tab switcher.
 *
 * Controlled via v-model:value. Each tab is `{ key, label, count? }`. The
 * selected tab carries aria-current, so a screen reader hears which button is
 * the open one. They are buttons, not an ARIA tablist; label the panels.
 */

interface Tab {
  key: string
  label: string
  count?: number
}

defineProps<{
  tabs: Tab[]
  modelValue: string
}>()

const emit = defineEmits<{
  (e: 'update:modelValue', value: string): void
}>()

function select(key: string) {
  emit('update:modelValue', key)
}
</script>

<template>
  <div class="flex gap-1 border-b border-calm-2 mb-6">
    <button
      v-for="t in tabs"
      :key="t.key"
      type="button"
      :aria-current="modelValue === t.key ? 'true' : undefined"
      class="px-[18px] py-3 text-sm font-semibold text-carbon-2 cursor-pointer border-b-2 border-transparent -mb-px tracking-tight whitespace-nowrap hover:text-brand-harmony"
      :class="[modelValue === t.key && 'text-brand-harmony border-b-brand-harmony font-bold']"
      @click="select(t.key)"
    >
      {{ t.label }}
      <span v-if="t.count != null" class="ml-2 text-carbon-3 font-medium">{{ t.count }}</span>
    </button>
  </div>
</template>
