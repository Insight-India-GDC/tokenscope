<script setup lang="ts">
/*
 * MeLensDisclosure — why a dollar does or does not reach a cost centre
 * (ADR 0012 decision 5).
 *
 * TWO VARIANTS, BOTH BEHIND AN AFFORDANCE (owner ruling 2026-08-05). The
 * page-body CARD this component started as — three scalars over a four-line
 * paragraph, headed "What is and is not chargeable" — is RETIRED from /usage:
 * the three scalars are already answered better by the lane toggle, the hero
 * tiles (the lead tile becomes Chargeable in the billed lane, with Attributed
 * usage beside it) and the settlement/coverage chip row, and the paragraph
 * violated the standing dashboard-prose ruling (visuals tell the story;
 * explanations open on demand). The INFORMATION did not die with it — it moved
 * behind the `dot` variant, an InfoDot on the lane toggle, compressed to the
 * sentences a reader needs at the moment they ask.
 *
 * The two lenses can disagree by a lot: one developer's July was $6,846.35 of
 * attributed usage against $1,449.70 the providers reported and about $6 that
 * actually cross-charges. That gap is past the over-emission detector's
 * materiality threshold — but the subscription behind it is DECLARED, and the
 * declaration's own copy promises that declared usage "is never flagged as
 * suspicious for having no Insight bill behind it". So the thing owed to the
 * reader is not an alarm, it is the explanation: how much of the month's
 * attributed usage is declared-personal, and what that does and does not do.
 *
 * PRECISION MATTERS HERE, because the obvious sentence is false. Migration
 * 0105:16-19 states it outright: "A declaration NEVER changes an actual_spend
 * chargeback verdict. Provider API records remain governed exclusively by
 * provider_org.billing or provider_enterprise.billing (ADR-0011 D1), including
 * when provider-backed and personal usage coexist for the same teammate and
 * tool." So a declaration suppresses the no-bill over-emission query and
 * nothing else. Declared usage escapes chargeback only when there is no
 * provider bill behind it — which is usually true for a personal subscription
 * and is NOT a property the declaration confers.
 *
 * PER TOOL, not per account. A declaration explains only the tool it names
 * (`personal_subscription_declaration` is scoped to one tool), so the server
 * classifies each tool against its own declaration and its own provider record
 * and hands them over as `tool_gaps`. A declared Claude subscription therefore
 * cannot swallow an undeclared Copilot over-emission — both sentences render.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO (decision 6): it does not hedge the
 * headline. It never says the usage figure is notional, provisional, or should
 * be discounted. The tokens were consumed; the product exists to change
 * behaviour before the invoice catches up. This block discloses what is and is
 * not chargeable — it does not undermine the primary figure.
 *
 * The per-tool sentences render only when there is something true to say: an
 * active declaration, a tool whose gap the detector itself would consider
 * material, or a tool with no provider record behind a month of usage.
 */
import { computed, ref } from 'vue'
import InfoDot from '../ui/InfoDot.vue'
import { CLAUDE_FAMILY_TOOLS } from '#shared/usage/surface'

export interface DeclaredPersonal {
  tool: string
  label: string
  subscription_type: string
  monthly_cost_usd: string
  /**
   * Sent, deliberately not rendered here. The retired card printed "declared
   * 30 Jul 2026"; the compressed (i) drops it because a reader asking why their
   * usage does not cross-charge does not need the date to get their answer —
   * and /account, which this component links to, renders it beside the price on
   * the declaration it manages. Kept on the wire because it is part of the
   * declaration record `buildMeLensDisclosure` returns, not a leg of its own.
   */
  declared_at: string
  usage_mtd_usd: string
}

/** One tool's classification — see `MeToolGapState` in server/utils/me-lens.ts. */
export interface ToolGap {
  tool: string
  label: string
  attributed_usage_usd: string
  provider_reported_usd: string
  state: 'declared' | 'material_gap' | 'provider_record_missing' | 'nothing_to_disclose'
  has_open_review: boolean
}

/** One row of the "why a dollar does or does not reach the cost centre" list.
 *  Mirrors `MeBillingState` in server/utils/me-lens.ts — read its doc comment
 *  before changing any of the copy below: it states what each state covers and
 *  why the three do not sum to the month. */
export interface BillingState {
  tool: string
  label: string
  state: 'declared-personal' | 'exempt' | 'charged'
  usd: string
  subscription_type: string | null
}

export interface LensDisclosureData {
  attributed_usage_usd: string
  provider_reported_usd: string
  chargeable_usd: string
  declared_personal: DeclaredPersonal[]
  declared_personal_usage_usd: string
  tool_gaps: ToolGap[]
  /** `APAC · CTO`, or null when the caller's placement names no cost centre. */
  cost_centre?: string | null
  billing_states?: BillingState[]
}

/*
 * NO `lane` PROP. The card carried one for a single footnote — "you are viewing
 * the chargeback lens; your budgets and the soft cap are measured on attributed
 * usage, switch the lens above". That sentence now lives on the surface it is
 * about: MeHeroTiles renders the quota tile's `deltaEmpty` reason under the
 * chargeback lane ("your quota — allowance + allocations — measures attributed
 * usage, so it is not shown in the chargeback lens. Switch to Usage to see
 * it."). Neither remaining variant reads the lens, so the prop went with the
 * footnote rather than lingering as an argument nothing consumes.
 */
const props = withDefaults(
  defineProps<{
    disclosure: LensDisclosureData | null | undefined
    /**
     * `dot`  — an InfoDot on the /usage lane toggle: the compressed
     *          chargeback-follows-the-bill explanation plus the per-tool
     *          sentences, on demand.
     * `line` — ONE sentence plus an (i) that itemises it (the dashboard).
     *
     * The dashboard variant exists because the retired card spent about a fifth
     * of the fold reprinting the hero's own figure beside two zeros and a
     * paragraph. The sentence a developer actually wants there is how much of
     * the month reaches their cost centre; the reasons belong behind the (i).
     * `dot` is the same principle taken the rest of the way on /usage, where
     * the hero tiles already print the figures the card was reprinting.
     */
    variant?: 'dot' | 'line'
  }>(),
  { variant: 'dot' },
)

const d = computed(() => props.disclosure ?? null)
const declarations = computed(() => d.value?.declared_personal ?? [])
const toolGaps = computed(() => d.value?.tool_gaps ?? [])
/** Tools whose excess clears the detector's own materiality bar, undeclared. */
const materialGaps = computed(() => toolGaps.value.filter((g) => g.state === 'material_gap'))
/** Tools with a month of usage and no provider record to reconcile against. */
const missingRecords = computed(() =>
  toolGaps.value.filter((g) => g.state === 'provider_record_missing'),
)
/*
 * NO `show` GATE ON THE DOT. The retired CARD was gated on "is there a
 * declaration, a material gap, or a missing provider record" — correctly, since
 * a page-body block with nothing to say is noise. An (i) on the lane toggle is
 * not: it costs a reader nothing until they ask, and the question it answers
 * ("why doesn't my usage cross-charge?") is asked at the toggle whether or not
 * this month happens to carry a declaration. So the lead sentence renders
 * whenever the payload does; the per-tool blocks still render only when true.
 */

/*
 * Can this tool actually carry a declaration? THE SAME constant the endpoint
 * validates against (server/api/v1/me/personal-subscription.put.ts imports
 * CLAUDE_FAMILY_TOOLS and 400s anything outside it), imported rather than
 * restated so the copy cannot drift from what the product accepts.
 *
 * This matters because the gap sentence is per tool and the emit surface is
 * not Claude-only: `copilot-cli` is a first-class emit tool, so an undeclared
 * Copilot gap is an ordinary state. Telling that reader "you have no personal
 * subscription declared for Copilot — declare it on your account page" points
 * them at a picker that has no Copilot option, behind an endpoint that would
 * reject it, four lines under this card's own sentence saying Copilot is billed
 * pooled per cost centre and has no per-person charge. The gap is real and is
 * still stated; the instruction is the part that was never true.
 */
function isDeclarable(tool: string): boolean {
  return (CLAUDE_FAMILY_TOOLS as readonly string[]).includes(tool)
}
/** True when at least one tool named above can actually be declared. */
const anyDeclarable = computed(() =>
  [...materialGaps.value, ...missingRecords.value].some((g) => isDeclarable(g.tool)),
)

/*
 * ── the `line` variant ────────────────────────────────────────────────────
 *
 * THE PAYER IS THE COST CENTRE. Nothing here is ever chargeable to a person,
 * and the sentence must not shorten into one.
 *
 * The unit is named HUMAN and REGION-QUALIFIED (`APAC · CTO`), never by its
 * slug: `org_unit.code` is unique only per region, so short unit names repeat
 * and a bare "CTO" is ambiguous. The slug is an identifier to search or copy —
 * it belongs in admin lists and exports, not mid-sentence. When the caller's
 * placement resolves to no cost-owning unit the server sends null, and the
 * subject falls back to the product's existing unqualified phrase.
 */
/*
 * NULL means the caller's placement resolves to NO cost-owning ancestor —
 * `v_org_unit_cost_owner` is total via LEFT JOIN, so unhomed is a real state,
 * not a lookup miss. Falling back to "your cost centre" asserted that money
 * reached a centre that does not exist. Say the true thing instead.
 */
const costCentre = computed(() => d.value?.cost_centre ?? null)
const billingStates = computed(() => d.value?.billing_states ?? [])
/**
 * What reaches the cost centre. This is `chargeable_usd`
 * (`v_finance_bill_chargeback`, month to date) — NOT a sum computed here, so the
 * sentence and the itemisation cannot drift; the charged rows below come from
 * the same view over the same window, and an integration test pins Σ to it.
 */
const reachesUsd = computed(() => Number(d.value?.chargeable_usd ?? 0))

/**
 * The reason one row's money does or does not reach the cost centre. THREE
 * genuinely different reasons, and collapsing them into one "nothing
 * chargeable" loses the only part a cost-centre owner cares about: "no bill
 * exists" and "a bill exists and is charged" are not the same claim.
 *
 * `exempt` is stated as a property of the ORG'S AGREEMENT, never of the tool.
 * The flag comes from `provider_org.billing` / `provider_enterprise.billing`
 * being `tracked` (ADR-0011 D1) — another org's Copilot is chargeable, and this
 * sentence must never read as a fact about Copilot.
 *
 * `charged` names Anthropic as the invoicing party because
 * `v_finance_bill_chargeback` excludes every GitHub lane by construction (mig
 * 0115, the GITHUB_FIREWALL_EXCLUSIONS list) — every row that can reach this
 * branch is an Anthropic bill row. Copilot is billed pooled per cost centre and
 * has no per-person charge, which is why it can never appear here as `charged`.
 */
function whyText(b: BillingState): string {
  if (b.state === 'declared-personal') {
    /*
     * NOT "so no Insight invoice exists". Migration 0105:16-19 — a declaration
     * NEVER changes an actual_spend chargeback verdict, so the same tool can
     * legitimately appear here AND as `charged` in the same month. Claiming the
     * absence of an invoice is a claim about the provider bill that this row
     * has no standing to make.
     */
    /*
     * SAYS ONLY WHAT THE QUERY COMPUTES: usage on this tool inside the window
     * the declaration was active. It deliberately makes no claim about WHO
     * PAID — a declaration cannot separate personally-funded from
     * enterprise-funded usage of the same tool — and none about billing, which
     * mig 0105 reserves to the provider bill. Two earlier versions of this
     * string claimed each of those in turn.
     */
    /*
     * Continues the sentence the template started, like the `charged` branch
     * below — the row renders as `{label} — {whyText}`, so repeating the label
     * here reads "Claude Code — Claude Code usage while...".
     */
    return `usage recorded while your declared ${b.subscription_type ?? 'personal subscription'} was active.`
  }
  if (b.state === 'exempt') {
    /*
     * "not charged on", not "is on an NFR agreement". The predicate is
     * `chargeback_exempt AND governance_verdict_source = 'governance:tracked'`,
     * and `tracked` is where a provider org SITS BY DEFAULT before anyone
     * classifies it commercially. NFR is one reason a org is tracked-only; it
     * is not the only one, and this row cannot tell them apart.
     */
    return `your ${b.label} usage is on a provider agreement that is not charged on — real usage, no money. That is a property of the agreement, not of ${b.label}.`
  }
  return costCentre.value
    ? `invoiced by Anthropic and charged to ${costCentre.value}.`
    : 'invoiced by Anthropic. Your placement resolves to no Business Unit, so it is not yet charged to one.'
}

const popoverOpen = ref(false)
</script>

<template>
  <!-- LINE variant (the dashboard): one sentence, and an (i) that itemises it. -->
  <div v-if="variant === 'line' && d" data-testid="lens-disclosure-line">
    <div class="flex items-center gap-2 text-[12.5px] text-carbon-3">
      <button
        v-if="billingStates.length"
        type="button"
        class="inline-flex items-center justify-center w-[18px] h-[18px] shrink-0 rounded-full border border-calm text-[11px] font-bold text-carbon-3 hover:border-brand-harmony hover:text-brand-harmony transition-colors cursor-pointer"
        :aria-expanded="popoverOpen"
        aria-controls="chargeable-breakdown"
        aria-label="Why this month does or does not reach a Business Unit"
        data-testid="chargeable-info-toggle"
        @click="popoverOpen = !popoverOpen"
      >
        i
      </button>
      <span data-testid="chargeable-line">
        <template v-if="reachesUsd > 0 && costCentre">{{ fmtUsd(d.chargeable_usd) }} of this month reaches {{ costCentre }}</template>
        <template v-else-if="reachesUsd > 0">{{ fmtUsd(d.chargeable_usd) }} of this month is chargeable, but your placement resolves to no Business Unit</template>
        <template v-else-if="costCentre">None of this month reaches {{ costCentre }}</template>
        <!-- Unhomed AND nothing chargeable. The branch above was given a null
             guard and this one was not: a sibling path left half-fixed, which
             rendered "None of this month reaches " with nothing after it. -->
        <template v-else>Nothing this month is chargeable to a Business Unit</template>
      </span>
    </div>
    <div
      v-if="popoverOpen && billingStates.length"
      id="chargeable-breakdown"
      class="mt-2 max-w-[62ch] rounded-lg border border-calm px-4 py-3 bg-white text-[12.5px] text-carbon-2"
      data-testid="chargeable-breakdown"
    >
      <dl class="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 m-0">
        <template v-for="b in billingStates" :key="`${b.state}-${b.tool}`">
          <dt
            class="font-bold text-carbon"
            style="font-variant-numeric: tabular-nums"
            :data-testid="`billing-state-${b.state}-${b.tool}`"
          >
            {{ fmtUsd(b.usd) }}
          </dt>
          <dd class="m-0">
            <span class="font-bold text-carbon">{{ b.label }}</span> — {{ whyText(b) }}
          </dd>
        </template>
      </dl>
      <NuxtLink
        to="/usage?lane=chargeback"
        class="inline-block mt-2.5 text-brand-harmony font-semibold hover:underline"
        data-testid="chargeback-view-link"
      >
        Chargeback view →
      </NuxtLink>
    </div>
  </div>

  <!--
    DOT variant (/usage): the (i) on the LANE TOGGLE. The toggle is where the
    question lives — a reader looking at "Usage · attributed" beside
    "Chargeback · billed" is asking why the two differ, and the toggle is the
    one control on screen in BOTH lanes (the chargeable tile only exists in the
    billed lane, so an explanation parked there is unreachable from the lane a
    reader spends most of their time in).

    Compressed, not relocated: the lead sentence is the true, narrow one — mig
    0105:16-19 — and the per-tool sentences below it are the retired card's own
    branches at one line each. The account-page route is kept.
  -->
  <InfoDot
    v-else-if="d"
    label="About the usage and chargeback lenses"
    data-testid="lens-disclosure-dot"
  >
    <span class="block space-y-2">
      <!-- Always. The narrow, TRUE statement: a declaration suppresses the
           no-bill over-emission query and nothing else, and usage escapes
           chargeback because there is no bill behind it — not because it was
           declared. -->
      <span class="block" data-testid="lens-disclosure-lead">
        Chargeback follows the provider bill: usage with no invoice behind it is not charged to a
        Business Unit{{ costCentre ? ` (yours is ${costCentre})` : '' }}.
      </span>

      <!-- The declared case: a disclosure, not an alarm. -->
      <span
        v-for="decl in declarations"
        :key="decl.tool"
        class="block"
        :data-testid="`declared-personal-${decl.tool}`"
      >
        <!-- The DECLARED-AT date is deliberately not here: it is on the account
             page this block links to, and the reader asking "why doesn't this
             cross-charge?" does not need it to get their answer. The price stays
             — "$6,800 of usage on a $200/month plan" IS the disclosure. -->
        <b class="font-bold text-carbon">{{ fmtUsd(decl.usage_mtd_usd) }}</b>
        of this month is on {{ decl.label }}, declared as a personal subscription
        ({{ decl.subscription_type }}, {{ fmtUsd(decl.monthly_cost_usd) }}/month). Declaring it
        stops that usage being queried as unexplained emission; it does not by itself change what
        is charged back.
      </span>

      <!-- The undeclared case, per tool. A declaration on ANOTHER tool does not
           suppress this one. The over-emission detector owns the review flow, so
           this points at it — but only for a tool that actually has an open
           review row, because the detector deliberately leaves the last few days
           unsettled and a promise of a review it will not raise would be false. -->
      <span
        v-for="gap in materialGaps"
        :key="gap.tool"
        class="block"
        :data-testid="`undeclared-gap-${gap.tool}`"
      >
        Your {{ gap.label }} usage this month is materially higher than the provider usage records
        behind it<template v-if="isDeclarable(gap.tool)">, and you have no personal subscription
        declared for {{ gap.label }}</template>.
        <!-- "Some of", not "the": has_open_review is true when AT LEAST ONE day
             this month cleared the detector's per-day bar. The gap is a month
             aggregate and the detector settles per day, so a month of emitting
             days can sit behind a single raised one. -->
        <template v-if="gap.has_open_review">
          Some of the days behind it are open for review on your
          <NuxtLink to="/" class="underline">dashboard</NuxtLink>.
        </template>
      </span>

      <!-- Decision 5a: at a provider-reported $0 there is no over-emission story
           to tell, because an unreconciled org and a genuinely quiet month look
           identical from here. The honest sentence is the absence of the record. -->
      <span
        v-for="gap in missingRecords"
        :key="gap.tool"
        class="block"
        :data-testid="`no-provider-record-${gap.tool}`"
      >
        No provider usage record has arrived for {{ gap.label }} this month, so this month's
        {{ gap.label }} usage has nothing to reconcile against yet.
      </span>

      <!-- The account-page route, kept. Neutral when a declaration already
           exists; an INSTRUCTION only when a tool named above can actually
           carry one (see isDeclarable — a Copilot-only gap gets no instruction,
           because the picker has no Copilot option and the endpoint 400s it). -->
      <span
        v-if="declarations.length"
        class="block text-carbon-3"
        data-testid="lens-disclosure-manage-cta"
      >
        Manage your declarations on your
        <NuxtLink to="/account#personal-subscription" class="underline">account page</NuxtLink>.
      </span>
      <span
        v-else-if="anyDeclarable"
        class="block text-carbon-3"
        data-testid="lens-disclosure-declare-cta"
      >
        If you pay for one of these yourself, declare it on your
        <NuxtLink to="/account#personal-subscription" class="underline">account page</NuxtLink>.
      </span>
    </span>
  </InfoDot>
</template>
