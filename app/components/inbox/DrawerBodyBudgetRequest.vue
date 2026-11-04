<script setup lang="ts">
/*
 * A budget request (quota_request, spec §5): either a member asking the
 * project's managers for more budget ('quota-request'), or the requester being
 * told the decision ('quota-request-decided'). The inbox only notifies (A10):
 * deciding happens in the project page's Manage drawer (Budget requests), which this links to.
 */
import { computed } from 'vue'

const props = defineProps<{
  category: string
  body: Record<string, unknown>
}>()

function text(key: string): string | null {
  const value = props.body[key]
  return typeof value === 'string' && value !== '' ? value : null
}

const usd = (v: string | null) => (v === null ? '—' : `$${Number(v).toFixed(2)}`)
const isDecision = computed(() => props.category === 'quota-request-decided')
const projectCode = computed(() => text('project_code'))
const projectName = computed(() => text('project_name') ?? projectCode.value ?? 'the project')
const requester = computed(() => text('requester_name') ?? 'A project member')
const amount = computed(() => text('amount_usd'))
const approvedAmount = computed(() => text('approved_amount_usd'))
const reason = computed(() => text('reason'))
const decision = computed(() => text('decision'))
const note = computed(() => text('note'))
// The dispatcher stamps routing_scope only when it fell back to the region's admins.
const toAdmins = computed(() => text('routing_scope') !== null)
const projectHref = computed(() =>
  projectCode.value ? `/projects/${encodeURIComponent(projectCode.value)}#manage` : null,
)
</script>

<template>
  <section class="space-y-5">
    <div v-if="!isDecision">
      <div class="text-[11px] font-bold uppercase tracking-[1.2px] text-carbon-3 mb-2">
        Budget request
      </div>
      <p class="text-sm text-carbon-2 leading-relaxed" data-testid="budget-request-facts">
        {{ requester }} asked for <strong>{{ usd(amount) }}</strong> more budget on {{ projectName }}.
      </p>
      <p v-if="reason" class="mt-2 text-sm text-carbon-2 leading-relaxed whitespace-pre-line" data-testid="budget-request-reason">
        “{{ reason }}”
      </p>
      <p class="mt-3 text-[12px] text-carbon-3 leading-relaxed">
        Approve it, with this amount or another, or decline it with a note, under Manage at the top of
        the project's page. Every pending request stays listed there, whatever happens to this message.
      </p>
      <p v-if="toAdmins" class="mt-2 text-[12px] text-carbon-3 leading-relaxed" data-testid="budget-request-no-manager">
        This project has no manager, so the request came to its region's admins. Decide it from the
        project's page, where Manage opens for you as an admin. Name a manager under Admin → Projects
        (Members) and later requests go to them instead.
      </p>
    </div>

    <div v-else>
      <div class="text-[11px] font-bold uppercase tracking-[1.2px] text-carbon-3 mb-2">
        Your budget request
      </div>
      <p v-if="decision === 'approved'" class="text-sm text-carbon-2 leading-relaxed" data-testid="budget-request-decision">
        Approved: {{ projectName }}'s budget went up by <strong>{{ usd(approvedAmount) }}</strong>
        <span v-if="approvedAmount !== amount"> (you asked for {{ usd(amount) }})</span>.
      </p>
      <p v-else class="text-sm text-carbon-2 leading-relaxed" data-testid="budget-request-decision">
        Your request for {{ usd(amount) }} more budget on {{ projectName }} was declined.
      </p>
      <p v-if="note" class="mt-2 text-sm text-carbon-2 leading-relaxed whitespace-pre-line" data-testid="budget-request-note">
        Note: “{{ note }}”
      </p>
    </div>

    <UiButton
      v-if="projectHref"
      :to="projectHref"
      kind="primary"
      size="sm"
      data-testid="budget-request-open-project"
    >
      Open {{ projectName }} →
    </UiButton>
  </section>
</template>
