<script setup lang="ts">
/*
 * Pick an existing teammate by name or email (GET /api/v1/pickers/teammates).
 * Never provisions from the directory: a person who has not signed in yet is
 * not offered.
 */
import { ref } from 'vue'
import UiButton from '../ui/Button.vue'
import { useDebouncedSearch } from '../../composables/useDebouncedSearch'
import { apiErrorDetail } from '../../composables/useApiError'

export interface PickedTeammate {
  id: string
  display_name: string | null
  email: string
}

const model = defineModel<PickedTeammate | null>({ required: true })
const props = withDefaults(defineProps<{ testid: string; placeholder?: string; disabled?: boolean }>(), {
  placeholder: 'Search by name or email…',
  disabled: false,
})

const query = ref('')
const results = ref<PickedTeammate[]>([])
const searchError = ref<string | null>(null)

const { run, cancel, pending } = useDebouncedSearch<{ teammates: PickedTeammate[] }>({
  search: (term) => $fetch<{ teammates: PickedTeammate[] }>('/api/v1/pickers/teammates', { query: { q: term } }),
  apply: (r) => {
    results.value = r.teammates ?? []
    searchError.value = null
  },
  onError: (e: unknown) => {
    results.value = []
    searchError.value = apiErrorDetail(e, 'Search failed')
  },
})

function onInput() {
  const q = query.value.trim()
  if (q.length < 2) {
    cancel()
    results.value = []
    searchError.value = null
    return
  }
  run(q)
}

function pick(hit: PickedTeammate) {
  model.value = hit
  query.value = ''
  results.value = []
}
</script>

<template>
  <div :data-testid="props.testid">
    <div v-if="model" class="flex items-center justify-between gap-2 px-3 py-2 border border-calm-2 rounded-md bg-white">
      <div class="min-w-0 text-sm text-carbon truncate" :data-testid="`${props.testid}-picked`">
        {{ model.display_name ?? model.email }}
        <span class="text-carbon-3 text-xs">· {{ model.email }}</span>
      </div>
      <UiButton
        v-if="!props.disabled"
        kind="ghost"
        size="sm"
        :data-testid="`${props.testid}-change`"
        @click="model = null"
      >
        Change
      </UiButton>
    </div>
    <template v-else>
      <input
        v-model="query"
        type="search"
        :placeholder="props.placeholder"
        :disabled="props.disabled"
        class="w-full px-3 py-2 text-sm border border-calm-2 rounded-md focus:border-brand-harmony"
        :data-testid="`${props.testid}-search`"
        @input="onInput"
      >
      <p v-if="searchError" class="text-xs text-rag-red mt-1">{{ searchError }}</p>
      <ul v-if="results.length" class="mt-1 border border-calm-2 rounded-md divide-y divide-calm-2 bg-white">
        <li v-for="hit in results" :key="hit.id">
          <button
            type="button"
            class="w-full text-left px-3 py-2 hover:bg-brand-harmony-sheer/40"
            :data-testid="`${props.testid}-hit-${hit.id}`"
            @click="pick(hit)"
          >
            <span class="text-sm text-carbon">{{ hit.display_name ?? hit.email }}</span>
            <span class="text-[11px] text-carbon-3"> · {{ hit.email }}</span>
          </button>
        </li>
      </ul>
      <p v-else-if="query.trim().length >= 2 && !pending && !searchError" class="text-[12px] text-carbon-3 mt-1">
        No matching teammates. Only people who have signed in to TokenScope can be picked.
      </p>
    </template>
  </div>
</template>
