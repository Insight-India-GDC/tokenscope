/*
 * The unhomed cause-split PANEL invariants (app/pages/admin/diagnostics.vue).
 *
 * WHY SOURCE-LEVEL rather than a mount: the same reasoning as
 * tests/unit/pages/admin-grants.test.ts. What is being protected here is not
 * "what one fixture renders" but properties of the TEMPLATE that must hold on
 * every code path — including the ones a fixture would not reach:
 *
 *   - the card shows exactly ONE unhomed total, so the split can never be read
 *     against a second figure;
 *   - a non-zero residual SUPPRESSES the breakdown rather than rendering four
 *     plausible numbers that do not add up;
 *   - every zero on the panel carries a state an operator (and QA) can tell
 *     apart: "none" is not "we could not look" is not "not applicable";
 *   - the visibility block reuses the existing scope vocabulary instead of
 *     inventing a parallel one.
 *
 * A mount test would assert the first of these for one set of props and say
 * nothing about the rest. Every assertion below was mutation-proven: edit the
 * template to violate it and the test fails (see the suite's commit message for
 * the list).
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const ROOT = resolve(__dirname, '../../..')
const SRC = readFileSync(resolve(ROOT, 'app/pages/admin/diagnostics.vue'), 'utf8')

/** The template half of the SFC — script-side type declarations are not markup. */
const TEMPLATE = SRC.slice(SRC.indexOf('<template>'))

/** The split panel only, so a match elsewhere on this large page cannot stand in for one here. */
const PANEL_START = TEMPLATE.indexOf('data-testid="admin-diag-unhomed-causes"')
const PANEL = TEMPLATE.slice(PANEL_START, TEMPLATE.indexOf('</UiCard>', PANEL_START))

/** Vue templates wrap prose across lines; match on words, not on line breaks. */
function says(haystack: string, phrase: string): boolean {
  return new RegExp(phrase.split(/\s+/).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s+')).test(haystack)
}

/** Every value a `data-state` can take here — literal attributes AND ternary branches. */
function dataStateTokens(src: string): Set<string> {
  const out = new Set<string>()
  for (const m of src.matchAll(/:?data-state="([^"]*)"/g)) {
    const v = m[1]!
    if (/^[a-z-]+$/.test(v)) out.add(v)
    for (const q of v.matchAll(/'([a-z-]+)'/g)) out.add(q[1]!)
  }
  return out
}

describe('unhomed cause-split panel', () => {
  it('renders the unhomed figure from ONE source, and sees every place it appears', () => {
    /*
     * The earlier version of this test matched only two spellings of the figure,
     * so it certified "exactly ONE unhomed total" while the trend below rendered
     * the SAME month's unhomed dollars a second time and was never counted.
     *
     * This enumerates EVERY money render on the card and then filters to the ones
     * that are an unhomed total, so a third one cannot be added without failing
     * here — the check can no longer be blind to what it is counting.
     */
    const abUsdArgs = [...TEMPLATE.matchAll(/abUsd\(([^)]*)\)/g)].map((m) => m[1]!.trim())
    const unhomedRenders = abUsdArgs.filter((a) => /unhomedChargeUsd|\.unhomedUsd/.test(a))
    expect(unhomedRenders).toEqual([
      // The HEADLINE — the line the split extends, and the only authoritative one.
      'abData.diagnostics.unhomedChargeUsd',
      /*
       * The trend's own row, per month. It repeats the SELECTED month's figure on
       * purpose (a series with a hole where the selected month should be is
       * unreadable), and it is not a second DEFINITION: the trend's money comes
       * out of the probe's own statement, from the same expression as the
       * headline. It IS a second STATEMENT — the headline is computed in
       * ab-decomposition.ts — so the two are byte-identical on a quiescent
       * estate and can differ by whatever placement changed between the reads.
       * An earlier version of this comment said they "cannot disagree", which
       * was not true. What this assertion pins is narrower and real: no THIRD
       * unhomed figure is rendered on the card.
       */
      'h.unhomedUsd ?? undefined',
    ])
    // The split panel never renders a total OF ITS OWN beside the headline.
    expect(PANEL).not.toContain('unhomedProbe.unhomedUsd')
    // …and the copy admits the two-statement gap rather than implying agreement.
    expect(says(PANEL, 'in a separate query')).toBe(true)
    expect(says(PANEL, 'the residual will not show it')).toBe(true)
  })

  it('suppresses the breakdown when the residual is non-zero', () => {
    // The bucket rows and the drill must live INSIDE the reconciles branch, so a
    // split that does not add back to its own total cannot be read as one.
    const guard = PANEL.indexOf('v-if="!unhomedReconciles"')
    expect(guard).toBeGreaterThan(-1)

    // Textual order alone is NOT enough — it stays true if the `v-else` is
    // deleted and the table renders unconditionally, which is precisely the
    // regression this guards. Assert the branch itself sits between them.
    const buckets = PANEL.indexOf('admin-diag-unhomed-cause-')
    const worklist = PANEL.indexOf('admin-diag-unhomed-worklist-')
    const residualRow = PANEL.indexOf('admin-diag-unhomed-residual')
    expect(buckets).toBeGreaterThan(guard)
    expect(worklist).toBeGreaterThan(guard)
    expect(residualRow).toBeGreaterThan(guard)
    expect(PANEL.slice(guard, buckets)).toContain('<template v-else>')

    // …and the suppression says WHY, in the words the card already uses for its
    // own non-zero residual: a figure you must not size anything against.
    expect(says(PANEL, 'must not be used to size any bucket')).toBe(true)
  })

  it('says what a ZERO residual proves — and what it does not', () => {
    /*
     * A zero residual detects money in the total and in NO cause. It is ONE
     * equation over signed sums, so there are two distinct things it cannot see,
     * and the copy has claimed both at different times:
     *
     *   - money in the WRONG cause — moving a dollar between two causes leaves
     *     the sum unchanged;
     *   - a dollar dropped from one cause AND a dollar double-counted in
     *     another — those cancel.
     *
     * "No dollar is missing and none is counted twice" asserted exactly the
     * second one, and an external reviewer caught it after three internal rounds
     * had read past it. An operator sizes a placement campaign on this number.
     */
    expect(says(PANEL, 'the causes SUM to the figure above, and nothing more than that')).toBe(true)

    // Both limits stated in the same breath, not left to be inferred.
    expect(says(PANEL, 'dropped from one cause and a dollar double-counted in another')).toBe(true)
    expect(says(PANEL, 'does <strong>not</strong> mean')).toBe(true)
    expect(says(PANEL, 'every dollar is in the right cause')).toBe(true)

    // The superseded overstatement must not come back.
    expect(says(PANEL, 'no dollar is missing from the split and none is counted twice')).toBe(false)
  })

  it('calls a month empty by COUNTING rows, never by two sums netting to zero', () => {
    /*
     * Chargeable spend is signed, so a credit note can net a month to exactly
     * $0.00 with real billed rows inside it. Both the chargeable-only rule and
     * the later both-sums-zero rule called such a month empty and hid the money
     * the panel exists to surface. Only a zero ROW COUNT means nothing arrived.
     *
     * Pinned against the sums as well as for the count: an edit that reverts to
     * either sum-based rule has to fail here, not merely stop matching a string.
     */
    const guard = SRC.slice(
      SRC.indexOf('const unhomedNothingToSplit'),
      SRC.indexOf('const unhomedVisibleWorklists'),
    )
    expect(guard).toContain('sourceRows === 0')
    expect(guard).not.toContain('chargeableUsd')
    expect(guard).not.toContain('unhomedUsd')

    // …and the sentence says the same thing, so the screen and the predicate
    // cannot drift — which is exactly how they came apart before.
    expect(PANEL).toContain('v-else-if="unhomedNothingToSplit"')
    expect(says(PANEL, 'No billed rows reached this month at all')).toBe(true)
    expect(says(PANEL, 'and no unhomed spend either')).toBe(false)
  })

  it('states no share for a month whose chargeable nets to zero', () => {
    /*
     * The SAME defect as `unhomedNothingToSplit`, one level down. A credit note
     * can net a month to $0.00 chargeable with real unhomed dollars inside, and
     * the trend called that month empty. Fixing the state alone is not enough:
     * the measured row divides by that zero. `(h.sharePct ?? 0).toFixed(1)`
     * renders 0.0% — 0% beside a row that is ENTIRELY unhomed — and dropping the
     * coalesce renders Infinity%. Both are inventions, so the percentage lives
     * inside a branch on the null and the else-branch says what is true.
     */
    const start = PANEL.indexOf('data-testid="admin-diag-unhomed-history"')
    const hist = PANEL.slice(start, PANEL.indexOf('admin-diag-unhomed-period-note', start))

    const guard = hist.indexOf('v-if="h.sharePct !== null"')
    expect(guard).toBeGreaterThan(-1)
    const pct = hist.indexOf('sharePct.toFixed')
    expect(pct).toBeGreaterThan(guard)
    // …and it is INSIDE that branch, not merely after it.
    expect(hist.slice(guard, pct)).not.toContain('</template>')
    expect(says(hist, 'share undefined: this month’s chargeable nets to $0.00')).toBe(true)

    // The empty-month row now says BOTH halves of what its state means, so the
    // sentence and the predicate behind it agree (server/usage/unhomed-causes.ts
    // only assigns `no-spend` when chargeable AND unhomed are both zero).
    expect(says(hist, 'No chargeable spend in this month, and none unhomed either')).toBe(true)
  })

  it('distinguishes every kind of zero in the DOM', () => {
    // AC-6's vocabulary. A "$0.00" that might mean "clean" and might mean
    // "blind" is not evidence, so each state is assertable by QA.
    const states = dataStateTokens(PANEL)
    for (const state of ['no-reading', 'not-applicable', 'unknown', 'zero', 'measured']) {
      expect([...states], `missing data-state ${state}`).toContain(state)
    }
    // EVERY cause row must carry the zero/measured distinction, not just one of
    // them — a set membership check passes while the other row has lost it.
    // Two tbodies: the three placement causes, and the separated pooled cause.
    expect(
      [...PANEL.matchAll(/:data-state="Number\(c\.usd\) === 0 \? 'zero' : 'measured'"/g)],
    ).toHaveLength(2)
    // The history's own three states are bound from the probe, not hard-coded —
    // a month that billed nothing and a month before the estate had data must
    // not render alike.
    expect(PANEL).toContain(':data-state="h.state"')

    // The words that make each zero readable.
    expect(says(PANEL, 'No reading.')).toBe(true)
    expect(says(PANEL, 'Coverage unknown.')).toBe(true)
    expect(says(PANEL, 'No chargeable spend in this month')).toBe(true)
    expect(says(PANEL, 'Not measured')).toBe(true)
  })

  it('discloses the worklist cap and the money it is showing', () => {
    // A truncated list that does not say it is truncated reads as the whole
    // bucket, and an operator sizes a remediation against a fifth of it.
    const start = PANEL.indexOf('admin-diag-unhomed-worklist-')
    const block = PANEL.slice(start, PANEL.indexOf('</div>', start))
    expect(says(block, 'top {{ w.shown }} of {{ w.total }}')).toBe(true)
    // Money shown AGAINST money in the bucket — both, always, in both branches.
    expect([...block.matchAll(/abUsd\(w\.shownUsd\)[\s\S]{0,40}abUsd\(w\.bucketUsd\)/g)]).toHaveLength(2)
  })

  it('never prints a dollar figure for an unreadable probe', () => {
    // "No reading" plus the reason, styled neutral — never a number, never
    // green. The failure branch must not interpolate any money.
    const start = PANEL.indexOf('data-state="no-reading"')
    const noReadingBlock = PANEL.slice(start, PANEL.indexOf('</p>', start))
    expect(noReadingBlock).not.toMatch(/abUsd\(/)
    expect(noReadingBlock).toContain('unhomedError')
  })

  it('renders each month’s RECORDED state from that month’s own data', () => {
    /*
     * The state was once pinned in the probe and nowhere on the surface, so a
     * month could render the wrong word with the whole suite green.
     *
     * The words changed with the thing: Open/Closed became Recorded/Not
     * recorded, because recording a month no longer freezes it. The property
     * under test is unchanged — each row's word comes from that row's own data,
     * through one mapping, and no literal is printed in the trend.
     */
    const start = PANEL.indexOf('data-testid="admin-diag-unhomed-history"')
    const hist = PANEL.slice(start, PANEL.indexOf('admin-diag-unhomed-period-note', start))

    // The word comes from the month's own state, through one mapping…
    expect(hist).toContain('SNAPSHOT_WORD[snapshotKey(h.recorded)]')
    expect(hist).toContain(':data-period-state="snapshotKey(h.recorded)"')
    // …which maps each state to its own word. Swap two and this fails.
    expect(SRC).toMatch(/recorded:\s*'Recorded'/)
    expect(SRC).toMatch(/'not-recorded':\s*'Not recorded'/)
    expect(SRC).toMatch(/unknown:\s*'Unknown'/)
    // No literal word is printed in the trend, so the cell cannot go constant
    // while still looking plausible.
    expect(hist).not.toMatch(/\{\{[^}]*'(Recorded|Not recorded)'[^}]*\}\}/)

    // A FAILED read is its own word. It is not "not recorded": absence of a row
    // means never recorded, absence of an ANSWER does not, and the two must not
    // render alike — so the consequence line spells out all three.
    expect(says(SRC, 'Unknown — the snapshot read for this month failed')).toBe(true)
    expect(says(SRC, 'This is not “not recorded”')).toBe(true)
    expect(PANEL).toContain('snapshotConsequence.unknown')
    expect(PANEL).toContain('snapshotConsequence.recorded')
    expect(PANEL).toContain("snapshotConsequence['not-recorded']")
  })

  it('reuses the existing report-visibility vocabulary instead of inventing one', () => {
    // The scope names come from `grantsToScopes` on the wire. If any of them is
    // typed into this template, there are two vocabularies and one will drift.
    for (const scope of [
      'Across regions',
      'Regional (own region)',
      'Regional (all regions)',
      'Business Units (owned)',
      'Business Units (all)',
      'Finance (whole company)',
    ]) {
      expect(PANEL, `scope name hard-coded in the template: ${scope}`).not.toContain(scope)
    }
    expect(PANEL).toContain('p.scopes')
    // The three-mode dial is gone (mig 0129: per-teammate grants replace it) — no
    // mode/label/description/isDefault left to render, and no second copy of a
    // matrix that no longer exists.
    expect(PANEL).not.toContain('abData.visibility.label')
    expect(PANEL).not.toContain('abData.visibility.mode')
    expect(PANEL).not.toContain('abData.visibility.description')
    expect(PANEL).not.toContain('visibility.isDefault')
    expect(PANEL).not.toContain('visibility.modes')
    // …and it shows the ONE live fact the probe adds — how many teammates hold an
    // ACTIVE grant right now — with a link to the admin surface that owns the real
    // grant list, never a second render of it inside a diagnostics card.
    expect(says(PANEL, 'teammates hold elevated grants')).toBe(true)
    expect(PANEL).toContain('abData.visibility.elevated.teammates')
    expect(PANEL).toContain('abData.visibility.elevated.operational')
    expect(PANEL).toContain('abData.visibility.elevated.finance')
    expect(PANEL).toContain('/admin/policies/report-access')
    expect(PANEL).not.toContain('/admin/policies/report-visibility')
  })

  it('says who owns each fix: Admin, the one admin role, who reads this page', () => {
    // A diagnostic that names a problem without naming its owner is half a
    // feature. Region admin can no longer be granted, so no fix is handed over.
    expect(SRC).toContain('UNHOMED_ACTIONS')
    expect(PANEL).toContain('Owner:')
    expect(PANEL).not.toContain('data-testid="admin-diag-unhomed-handover"')
    expect(SRC).not.toContain('REGION_ADMIN_LABEL')
  })

  it('names the ROLES from the shared persona list, not as free text', () => {
    /*
     * `grantsToScopes` was lifted to shared/auth/report-visibility.ts so this card
     * and the policy pane would name the SCOPES with one vocabulary — and the
     * owner labels three lines below were then typed out by hand, which is a
     * second vocabulary for the ROLES on the same card. Rename a persona and this
     * panel must follow.
     */
    expect(SRC).toContain("import { REPORT_VISIBILITY_PERSONAS } from '#shared/auth/report-visibility'")
    expect(SRC).toContain('const PERSONA_LABEL')

    const actions = SRC.slice(SRC.indexOf('const UNHOMED_ACTIONS'), SRC.indexOf('const UNHOMED_COUNT_NOUNS'))
    for (const label of ['Region admin', 'Global finance']) {
      expect(actions, `role label re-typed in UNHOMED_ACTIONS: ${label}`).not.toContain(label)
    }
    expect(actions).toContain('ORG_WIDE_LABEL')
    expect(actions).not.toMatch(/owner: '/)
  })

  it('states what is NOT in the figure', () => {
    // Stops an operator chasing a discrepancy against the reconciliation
    // surface, and stops them calling the split wrong when it is merely scoped.
    expect(says(PANEL, 'covers CHARGEABLE spend only')).toBe(true)
    expect(says(PANEL, 'chargeback-exempt spend can also carry no Business Unit')).toBe(true)
  })

  it('admits the history is half live and half snapshot, not uniformly recomputed', () => {
    /*
     * The per-teammate arm re-homes from today's org tree on every read; the
     * pooled Copilot arm reads the cost-owning unit stamped on each bill row when
     * that month was pulled (mig 0107 selects it straight off copilot_pool_bill,
     * never re-derived). Claiming the whole series is recomputed told an operator
     * that re-pointing a provider organisation would move the history — it does
     * not, until that month is re-pulled.
     */
    expect(says(PANEL, 'half live, half snapshot')).toBe(true)
    expect(says(PANEL, 'closed months included')).toBe(true)
    expect(says(PANEL, 'until that month is re-pulled')).toBe(true)

    // The superseded uniform claim must not come back.
    expect(says(PANEL, 'Every month is recomputed from today’s homing rules')).toBe(false)
  })
})
