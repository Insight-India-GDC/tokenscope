<script setup lang="ts">
/*
 * PlacementWhy: the row expand on /admin/placement-check. The decisive step,
 * the manager chain from the person upward with owner / leader / ambiguous
 * owners marked, and how the walk ended. Explains the DERIVED home only.
 */
import { computed } from 'vue'
import type { PlacementCheckRow } from '#shared/placement/placement-check'
import UiBadge from '../ui/Badge.vue'
import {
  PLACEMENT_WALK_END_TEXT,
  placementAmbiguousWarning,
  placementChainView,
  placementDecisiveText,
  placementProvenanceText,
} from '../../utils/placement-check-view'

const props = defineProps<{ row: PlacementCheckRow }>()

const chain = computed(() => placementChainView(props.row))
const ambiguousWarning = computed(() => placementAmbiguousWarning(props.row))
</script>

<template>
  <div class="text-sm text-carbon space-y-3" :data-testid="`placement-why-${row.teammateId}`">
    <p data-testid="placement-why-decisive">
      <span class="font-semibold">Derived now:</span> {{ placementDecisiveText(row) }}
    </p>
    <p v-if="ambiguousWarning" class="text-[12px] text-carbon" data-testid="placement-why-ambiguous-warning">
      {{ ambiguousWarning }}
    </p>
    <p class="text-[12px] text-carbon-3">
      Current placement recorded as: {{ placementProvenanceText(row) }}.
    </p>
    <div v-if="chain.length">
      <p class="text-[11px] font-bold uppercase tracking-[1.2px] text-carbon-3 mb-1">Manager chain</p>
      <ol class="space-y-0.5" data-testid="placement-why-chain">
        <li
          v-for="link in chain"
          :key="link.oid"
          class="flex flex-wrap items-baseline gap-x-2"
          :style="{ paddingLeft: `${link.depth * 12}px` }"
        >
          <span>{{ link.name ?? link.email ?? link.oid }}</span>
          <span v-if="link.email && link.name" class="text-[11px] text-carbon-3">{{ link.email }}</span>
          <UiBadge v-for="m in link.marks" :key="m" kind="outline">{{ m }}</UiBadge>
        </li>
      </ol>
    </div>
    <p class="text-[12px] text-carbon-2" data-testid="placement-why-walk-end">{{ PLACEMENT_WALK_END_TEXT[row.why.walkEnd] }}</p>
  </div>
</template>
