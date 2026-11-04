<script setup lang="ts">
/*
 * Project requests (server/projects/project-requests.ts): `project-request`
 * tells an admin one is waiting; `project-request-decided` tells the requester
 * the outcome. The decision itself happens on Admin → Project requests.
 */
import { computed } from 'vue'

const props = defineProps<{
  category: string
  body: Record<string, unknown>
}>()

function text(key: string): string | null {
  const value = props.body[key]
  return typeof value === 'string' && value ? value : null
}

const decided = computed(() => props.category === 'project-request-decided')
const name = computed(() => text('displayName') ?? 'A project')
const requester = computed(() => text('requesterName'))
const unit = computed(() => text('unitName'))
const region = computed(() => text('regionCode'))
const budget = computed(() => {
  const v = Number(text('budgetUsd'))
  return Number.isFinite(v) && v > 0 ? `$${v.toFixed(2)}` : null
})
const approved = computed(() => text('decision') === 'approved')
const note = computed(() => text('note'))
const projectCode = computed(() => text('projectCode'))
// The admin may rename on approval, so only projectName names the created project.
const createdName = computed(() => text('projectName'))
const actionHref = computed(() => text('actionHref'))
</script>

<template>
  <section class="space-y-5">
    <div v-if="!decided">
      <div class="text-[11px] font-bold uppercase tracking-[1.2px] text-carbon-3 mb-2">New project request</div>
      <p class="text-sm text-carbon-2 leading-relaxed" data-testid="project-request-facts">
        <template v-if="requester">{{ requester }} asks</template><template v-else>Someone asks</template>
        for <strong>{{ name }}</strong><template v-if="unit"> under {{ unit }}</template><template v-if="region"> ({{ region }})</template><template v-if="budget">, with a budget of {{ budget }}</template>.
      </p>
      <p class="mt-2 text-[12px] text-carbon-3 leading-relaxed">
        Review it on Admin → Project requests, where you can edit the details, set the project code, and approve or reject it.
      </p>
      <UiButton v-if="actionHref" :to="actionHref" kind="primary" size="sm" class="mt-3" data-testid="project-request-open">
        Open the request →
      </UiButton>
    </div>
    <div v-else>
      <div class="text-[11px] font-bold uppercase tracking-[1.2px] text-carbon-3 mb-2">
        {{ approved ? 'Request approved' : 'Request not approved' }}
      </div>
      <p class="text-sm text-carbon-2 leading-relaxed" data-testid="project-request-decision">
        <template v-if="approved">
          Your request for <strong>{{ name }}</strong> was approved<template v-if="projectCode">: the project is <template v-if="createdName"><strong>{{ createdName }}</strong> ({{ projectCode }})</template><template v-else>{{ projectCode }}</template></template>.
        </template>
        <template v-else>Your request for <strong>{{ name }}</strong> was not approved.</template>
      </p>
      <p v-if="note" class="mt-2 text-sm text-carbon-2 whitespace-pre-line" data-testid="project-request-note">
        “{{ note }}”
      </p>
      <UiButton v-if="actionHref" :to="actionHref" kind="primary" size="sm" class="mt-3" data-testid="project-request-open">
        {{ approved && projectCode ? 'Open the project →' : 'Open My projects →' }}
      </UiButton>
    </div>
  </section>
</template>
