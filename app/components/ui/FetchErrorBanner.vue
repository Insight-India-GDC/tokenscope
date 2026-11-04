<script setup lang="ts">
/*
 * FetchErrorBanner — visible failure surface for useFetch-backed reads (FE-2).
 *
 * An attribution product must never render a confident "$0.00" over a failed
 * fetch: pages destructure `error` + `refresh` from useFetch and drop this
 * banner above the affected section. Renders nothing while the error is null.
 */
import { computed } from 'vue'
import UiButton from './Button.vue'
import { apiErrorDetail } from '../../composables/useApiError'

const props = defineProps<{
  /** The `error` ref value from useFetch / $fetch (null when healthy). */
  error: unknown
  /** What failed, in user terms — e.g. "your usage summary". */
  label?: string
}>()

const emit = defineEmits<{ retry: [] }>()

const detail = computed(() => {
  if (!props.error) return ''
  return apiErrorDetail(props.error, '')
})
</script>

<template>
  <div
    v-if="error"
    role="alert"
    class="mb-4 px-4 py-3 rounded-md bg-brand-hunger-sheer border border-brand-hunger/40 text-sm text-brand-heart flex items-center justify-between gap-4"
    data-testid="fetch-error-banner"
  >
    <span>
      Couldn't load {{ label ?? 'this data' }} — the figures shown may be missing or stale.
      <span v-if="detail" class="text-brand-heart">({{ detail }})</span>
    </span>
    <UiButton kind="secondary" size="sm" data-testid="fetch-error-retry" @click="emit('retry')">
      Retry
    </UiButton>
  </div>
</template>
