<script setup lang="ts">
/*
 * DirectoryPeoplePicker: type-ahead over GET /api/v1/admin/directory/search; emits
 * the picked person. The caller decides what picking does.
 */
import { ref } from 'vue'
import UiButton from '../ui/Button.vue'
import { apiErrorDetail } from '../../composables/useApiError'
import { useDebouncedSearch } from '../../composables/useDebouncedSearch'

export interface DirectoryHit {
  oid: string
  email: string
  display_name: string | null
  department: string | null
  job_title: string | null
}

const props = withDefaults(defineProps<{ label: string; actionLabel?: string; busy?: boolean; testid?: string }>(), {
  actionLabel: 'Choose',
  busy: false,
  testid: 'people-picker',
})
const emit = defineEmits<{ pick: [hit: DirectoryHit] }>()

const query = ref('')
const results = ref<DirectoryHit[]>([])
const error = ref<string | null>(null)
const searched = ref(false)

const search = useDebouncedSearch<{ results: DirectoryHit[] }>({
  search: (q) => $fetch<{ results: DirectoryHit[] }>(`/api/v1/admin/directory/search?q=${encodeURIComponent(q)}&limit=10`),
  apply: (r) => {
    results.value = r.results ?? []
    searched.value = true
  },
  onError: (e) => (error.value = apiErrorDetail(e, 'Directory search failed.')),
})

const searchPending = search.pending

function onInput() {
  error.value = null
  const q = query.value.trim()
  if (!q) {
    search.cancel()
    results.value = []
    searched.value = false
    return
  }
  search.run(q)
}

const inputId = `${props.testid}-input`
</script>

<template>
  <div :data-testid="testid">
    <label :for="inputId" class="block text-[12px] font-semibold text-carbon">{{ label }}</label>
    <input
      :id="inputId"
      v-model="query"
      type="search"
      autocomplete="off"
      placeholder="Search the directory by name or email"
      class="mt-1 w-full min-h-[44px] px-3 py-2 text-sm border border-calm-2 rounded-md focus:border-brand-harmony"
      :data-testid="`${testid}-search`"
      @input="onInput"
    >
    <p v-if="error" class="mt-2 text-xs text-rag-red" role="alert">{{ error }}</p>
    <ul v-if="results.length" class="mt-2 border border-calm-2 rounded-md divide-y divide-calm-2">
      <li v-for="h in results" :key="h.oid" class="flex items-center gap-3 px-3 py-2">
        <div class="min-w-0 flex-1">
          <div class="text-sm text-carbon truncate">{{ h.display_name ?? h.email }}</div>
          <div class="text-[11px] text-carbon-3 truncate">
            {{ h.email }}<span v-if="h.job_title"> · {{ h.job_title }}</span><span v-if="h.department"> · {{ h.department }}</span>
          </div>
        </div>
        <UiButton
          kind="primary"
          size="sm"
          class="min-h-[44px]"
          :disabled="busy"
          :data-testid="`${testid}-pick-${h.oid}`"
          @click="emit('pick', h)"
        >
          {{ actionLabel }}
        </UiButton>
      </li>
    </ul>
    <p v-else-if="searched && !searchPending" class="text-[12px] text-carbon-3 mt-2">No matching people.</p>
  </div>
</template>
