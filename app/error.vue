<script setup lang="ts">
/*
 * app/error.vue — the page Nuxt shows for an unhandled error: an unknown URL,
 * or a page that threw while loading. Without it the framework's default screen
 * showed instead.
 *
 * It says which of three things happened, because they mean different things to
 * the reader: the page does not exist (404), they may not open it (403), or
 * something failed and we do not know more. It never prints the error's message
 * or stack for a failure: those are for the server log, not the reader.
 *
 * Self-contained on purpose (no layout, no header): the header fetches the
 * session, and the error may BE that fetch failing.
 */
import { computed } from 'vue'
import type { NuxtError } from '#app'

const props = defineProps<{ error: NuxtError }>()

const status = computed(() => props.error?.statusCode ?? 500)

const copy = computed(() => {
  if (status.value === 404) {
    return {
      title: "This page doesn't exist",
      body: 'The address may be mistyped, or the page may have moved. Nothing is wrong with your data.',
    }
  }
  if (status.value === 403) {
    return {
      title: "You don't have access to this page",
      body: 'Your role or scope does not include it. If you think it should, ask an admin for your region.',
    }
  }
  return {
    title: 'Something went wrong',
    body: "This page failed to load, and we can't tell you more here. Try again, or go back to the start.",
  }
})

useHead({ title: computed(() => `${copy.value.title} · TokenScope`) })

function goHome() {
  clearError({ redirect: '/' })
}
function retry() {
  // Re-request the same URL with a clean slate.
  if (import.meta.client) window.location.reload()
}
</script>

<template>
  <main
    id="main-content"
    class="min-h-screen flex items-center justify-center bg-paper px-6"
    data-testid="app-error"
  >
    <div class="max-w-md text-center">
      <p class="text-[11px] font-bold uppercase tracking-[1.2px] text-carbon-3" data-testid="app-error-status">
        Error {{ status }}
      </p>
      <h1 class="mt-2 text-2xl font-bold tracking-tight text-carbon">{{ copy.title }}</h1>
      <p class="mt-3 text-sm text-carbon-2 leading-relaxed">{{ copy.body }}</p>
      <div class="mt-6 flex items-center justify-center gap-3">
        <button
          type="button"
          class="px-4 py-2 rounded-lg text-sm font-bold bg-brand-harmony text-white hover:opacity-90 cursor-pointer"
          data-testid="app-error-home"
          @click="goHome"
        >
          Go to the start
        </button>
        <button
          v-if="status !== 404 && status !== 403"
          type="button"
          class="px-4 py-2 rounded-lg text-sm font-bold text-carbon-2 border border-calm-2 hover:bg-brand-harmony-sheer cursor-pointer"
          data-testid="app-error-retry"
          @click="retry"
        >
          Try again
        </button>
      </div>
    </div>
  </main>
</template>
