<script setup lang="ts">
/*
 * Optimisation playbook (brief §4.1.8) — the eight levers as long-form
 * education, separate from the dashboard (AEUF's token-optimization page
 * pattern: education is a linked resource, never a pop-up). Lever content
 * adapted from Insight-Services-APAC/agentic-engineering-usage-forecast
 * (AEUF R1–R6), rewritten for TokenScope's platform reality.
 *
 * Evidence badges: a lever shows "observed in your usage" when one of the
 * caller's CURRENT insights names it — evidence before advice.
 */
import { computed } from 'vue'
import type { Finding } from '#shared/schemas/usage'

interface Lever {
  id: string
  title: string
  group: string
  savings: string
  summary: string
  how: string[]
}

const LEVERS: Lever[] = [
  {
    id: 'R1',
    title: 'Model routing — frontier only where it earns its keep',
    group: 'Tool mastery',
    savings: 'typically the single largest lever (≈30% in field data)',
    summary:
      'Frontier-tier models (Fable, Opus) cost several times a workhorse-tier model per token. Many routine tasks — renames, test scaffolding, mechanical refactors, doc edits — produce the same outcome on Sonnet-class models. Keep frontier for genuinely hard reasoning.',
    how: [
      'Pick the model per task, not per habit: `/model` mid-session is cheap to flip.',
      'Default new sessions to a workhorse model; escalate when the task resists.',
      'Sub-agents and background tasks rarely need the frontier tier.',
    ],
  },
  {
    id: 'R2',
    title: 'Context discipline + /compact',
    group: 'Context management',
    savings: '≈15% in field data',
    summary:
      'Everything in context is re-read (and re-billed) on every turn. Big build outputs, vendored dirs, and stale file dumps inflate every subsequent message — and shrink your cache hit ratio.',
    how: [
      'Run /compact at natural task boundaries instead of letting auto-compact fire mid-thought.',
      'Deny-list build/vendor directories so file reads stay lean.',
      'Prefer targeted reads (line ranges, greps) over whole-file dumps in long sessions.',
    ],
  },
  {
    id: 'R3',
    title: 'Cache-TTL awareness',
    group: 'Context management',
    savings: '≈10% in field data',
    summary:
      'The prompt cache expires after ~5 minutes of inactivity. Bursty work that returns just past the TTL re-writes the whole context at full price — your cache-write lane grows while cache-read stays flat.',
    how: [
      'Batch related questions inside one active stretch instead of drip-feeding across breaks.',
      'For long pauses, expect the first message back to re-prime the cache — make it count.',
    ],
  },
  {
    id: 'R4',
    title: 'Output filtering',
    group: 'Tool mastery',
    savings: '≈7% in field data',
    summary:
      'Tool output is model input: a 10k-line log dumped into the session is paid for on every later turn. Auxiliary harness lanes amplify this.',
    how: [
      'Cap tool output (BASH_MAX_OUTPUT_LENGTH, MAX_MCP_OUTPUT_TOKENS) in your settings.',
      'Pre-grep logs and pipe through tail/head instead of dumping raw output.',
    ],
  },
  {
    id: 'R5',
    title: 'Effort + thinking discipline',
    group: 'Tool mastery',
    savings: '≈7% in field data',
    summary:
      'Extended thinking and high effort settings multiply output tokens. Routine work rarely benefits; hard problems genuinely do. Match the dial to the task.',
    how: [
      'Use lower effort modes for mechanical work; save deep reasoning for design and debugging.',
      'Watch your output-token share in the token-type mix — thinking-heavy sessions show up there.',
    ],
  },
  {
    id: 'R6',
    title: '/clear between unrelated tasks',
    group: 'Session hygiene',
    savings: '≈5% in field data',
    summary:
      'Carrying one task\'s context into the next means paying to cache and re-read material the new task never needed — the classic cause of a cache-write-heavy, cache-read-light profile.',
    how: [
      'Start unrelated work with /clear (or a fresh session) instead of riding one conversation all day.',
      'One conversation per task also keeps your session tagging clean.',
    ],
  },
  {
    id: 'R7',
    title: 'Curate your tool + MCP surface',
    group: 'Tool mastery',
    savings: 'field guidance: ~13 essential tools vs ~40 loaded',
    summary:
      'Every tool definition and MCP server you load is advertised to the model — its schema is re-sent as input on every request, whether or not you use it. A sprawling tool surface is a fixed tax on each turn, and it crowds the model\'s attention away from the task.',
    how: [
      'Disable MCP servers you are not actively using (in Copilot, manage the server list; in Claude Code, /mcp).',
      'Trim custom tools and skills to the ones this kind of work actually needs.',
      'Prefer deferred / tool-search loading where available — the catalogue stays reachable without paying for every definition up front.',
    ],
  },
  {
    id: 'R8',
    title: 'Plan before you execute',
    group: 'Session hygiene',
    savings: 'fewer agent turns = fewer paid round-trips',
    summary:
      'Long agent loops — many turns chasing one goal — re-read the whole context on each iteration. A specific prompt, or an explicit plan step, reaches the outcome in fewer turns, and every turn avoided is input you don\'t pay to re-process.',
    how: [
      'State the concrete change up front (files, behaviour, constraints) instead of an open-ended ask.',
      'Use plan mode (or a short plan step) for multi-file work, then execute against it.',
      'Offload well-scoped sub-tasks to a sub-agent rather than growing one long loop.',
    ],
  },
]

const { session, ensure } = useSession()
await ensure()

const { data } = await useFetch<{ insights: Finding[] }>(
  '/api/v1/me/usage',
  { query: { window: 30 }, lazy: true },
)
const observedLevers = computed(() => {
  const set = new Set<string>()
  for (const f of data.value?.insights ?? []) for (const l of f.related_levers) set.add(l)
  return set
})
</script>

<template>
  <div v-if="session" class="max-w-[900px] mx-auto px-10 py-8 pb-20" data-testid="playbook">
    <UiPageHead
      title="Optimisation playbook"
      sub="Eight levers that change outcome-per-dollar. All optional — your call which fit how you work."
      :crumbs="['My usage', 'Playbook']"
    />

    <nav class="mb-6 flex flex-wrap gap-2" aria-label="Levers">
      <a
        v-for="l in LEVERS"
        :key="l.id"
        :href="`#${l.id}`"
        class="text-[11px] px-2 py-1 rounded border border-calm-2 text-carbon-2 hover:border-brand-harmony"
      >{{ l.id }} · {{ l.title.split(' — ')[0] }}</a>
    </nav>

    <div class="space-y-5">
      <UiCard v-for="l in LEVERS" :id="l.id" :key="l.id" :data-testid="`lever-${l.id}`" class="scroll-mt-20">
        <div class="flex items-center gap-2 flex-wrap">
          <span class="text-[11px] font-bold uppercase tracking-[1.2px] text-brand-harmony">{{ l.id }}</span>
          <UiEyebrow>{{ l.group }}</UiEyebrow>
          <UiBadge
            v-if="observedLevers.has(l.id)"
            kind="rag-amber"
            :data-testid="`observed-${l.id}`"
          >observed in your usage</UiBadge>
        </div>
        <h2 class="text-lg font-bold text-carbon mt-1">{{ l.title }}</h2>
        <p class="text-sm text-carbon-2 mt-2">{{ l.summary }}</p>
        <ul class="mt-3 space-y-1.5">
          <li v-for="(h, i) in l.how" :key="i" class="text-[13px] text-carbon-2 flex gap-2">
            <span class="text-brand-zeal-ink font-bold shrink-0">→</span><span>{{ h }}</span>
          </li>
        </ul>
        <p class="text-[11px] text-carbon-3 mt-3">{{ l.savings }} — savings compound multiplicatively, not additively.</p>
      </UiCard>
    </div>

    <p class="text-[11px] text-carbon-3 mt-6">
      Levers R1–R6 adapted from an Insight study of agentic engineering usage; R7–R8 from GitHub
      and Anthropic token-efficiency guidance. Estimates on your dashboard are computed from
      your own usage and the live rate card — not these field ranges.
    </p>
  </div>
</template>
