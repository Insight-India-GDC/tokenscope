<script setup lang="ts">
/*
 * UnallocatedRemediationLink — a quiet link from an explicit "Unallocated"
 * bucket (requirement 6) to the reconciliation admin surface, where an admin
 * fixes the underlying org homing (map the org to a cost-owning unit). Money
 * in this bucket is real and stays IN the estate total (never dropped) — this
 * link is the remediation path, never a dismissal of the row.
 *
 * ADMINS ONLY. `/admin/**` sends everyone else to `/` (middleware/admin.ts), so
 * for a non-admin this was a door that opens onto the home page. The CONTAINER
 * (ScopeRegional / ScopeFinance), where the session lives, decides with the same
 * `isAdminRole` that middleware uses and passes it down; absent, nothing renders.
 */
withDefaults(defineProps<{ canFix?: boolean }>(), { canFix: false })
</script>

<template>
  <NuxtLink
    v-if="canFix"
    to="/admin/reconciliation"
    class="text-[11px] font-semibold text-brand-harmony hover:underline whitespace-nowrap"
    data-testid="unallocated-remediation-link"
  >Fix org homing →</NuxtLink>
</template>
