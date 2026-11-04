<script setup lang="ts">
/*
 * PlacementRulePreview: who a draft directory rule would move, before it is
 * saved (docs/design/placement-check/00-spec.md P8).
 * POST /api/v1/admin/placement-check/preview.
 *
 * Exact only against the stored placement-check evidence, so it states that
 * evidence's age and how many people have none. A result for an older draft is
 * dropped as soon as the draft changes.
 */
import { computed, ref, watch } from 'vue'
import UiButton from '../ui/Button.vue'
import { apiErrorDetail } from '../../composables/useApiError'
import { fmtTimeAgo } from '../../composables/useFormat'
import type { PlacementRulePreviewRequest, PlacementRulePreviewResponse } from '#shared/placement/placement-check'
import { placementHomeText } from '../../utils/placement-check-view'

const props = defineProps<{ draft: PlacementRulePreviewRequest | null }>()

const loading = ref(false)
const error = ref<string | null>(null)
const result = ref<PlacementRulePreviewResponse | null>(null)
const draftKey = computed(() => JSON.stringify(props.draft))
watch(draftKey, () => {
  result.value = null
  error.value = null
})

async function preview() {
  if (!props.draft) return
  const key = draftKey.value
  loading.value = true
  error.value = null
  try {
    const res = await $fetch<PlacementRulePreviewResponse>('/api/v1/admin/placement-check/preview', {
      method: 'POST',
      body: props.draft,
    })
    if (key === draftKey.value) result.value = res
  } catch (e: unknown) {
    if (key === draftKey.value) error.value = apiErrorDetail(e, 'Preview failed.')
  } finally {
    loading.value = false
  }
}
</script>

<template>
  <div data-testid="rule-preview">
    <UiButton size="sm" :disabled="!draft || loading" data-testid="rule-preview-run" @click="preview">
      {{ loading ? 'Previewing…' : 'Preview' }}
    </UiButton>
    <p v-if="error" class="text-xs text-rag-red mt-2" role="alert" data-testid="rule-preview-error">{{ error }}</p>
    <div v-if="result" class="mt-3 text-sm text-carbon" data-testid="rule-preview-result">
      <p data-testid="rule-preview-summary">
        <template v-if="result.changes.length">
          With this rule, {{ result.changes.length }} {{ result.changes.length === 1 ? 'person' : 'people' }} would derive a different placement.
        </template>
        <template v-else>With this rule, nobody's derived placement changes.</template>
      </p>
      <p class="text-[11px] text-carbon-3 mt-1" data-testid="rule-preview-age">
        <template v-if="result.evidenceAge.oldest">
          Based on directory records read between {{ fmtTimeAgo(result.evidenceAge.oldest) }} and {{ fmtTimeAgo(result.evidenceAge.newest) }}.
        </template>
        <template v-else>No directory records have been read yet; run a placement check first.</template>
        <template v-if="result.unchecked">
          {{ result.unchecked }} {{ result.unchecked === 1 ? 'teammate is' : 'teammates are' }} not checked yet or the directory lookup failed, and not counted.
        </template>
      </p>
      <p v-if="result.changes.length" class="text-[11px] font-bold uppercase tracking-[1.2px] text-carbon-3 mt-3">Derived now → with this rule</p>
      <ul
        v-if="result.changes.length"
        class="mt-2 border border-calm-2 rounded-md divide-y divide-calm-2 max-h-72 overflow-y-auto"
        data-testid="rule-preview-changes"
      >
        <li v-for="c in result.changes" :key="c.teammateId" class="px-3 py-2" :data-testid="`rule-preview-change-${c.teammateId}`">
          <div class="flex flex-wrap items-baseline gap-x-2">
            <span class="font-semibold">{{ c.name ?? c.email }}</span>
            <span v-if="c.name" class="text-[11px] text-carbon-3">{{ c.email }}</span>
          </div>
          <div class="text-[12px] text-carbon-2">
            {{ placementHomeText(c.from) }} <span class="text-carbon-3">→</span> {{ placementHomeText(c.to) }}
          </div>
        </li>
      </ul>
    </div>
  </div>
</template>
