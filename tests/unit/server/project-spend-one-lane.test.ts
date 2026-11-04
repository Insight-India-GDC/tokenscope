// @vitest-environment node
/*
 * THE CALL-SITE CONTRACT for "project spend this month".
 *
 * `tests/integration/reports/known-outcome-validation.test.ts` proves the shared
 * helper computes the right number. That is helper correctness, and it is NOT
 * call-site coverage: it calls `completeProjectSpend` directly, so reverting the
 * project page, the /projects cards, the budget editor, the cost-centre card or
 * the budget alert to `attribution_aggregate` or the raw ledger leaves it GREEN
 * and ships five surfaces quoting different money.
 *
 * This file closes that gap statically: every producer of a project-spend figure
 * must OBTAIN it from server/usage/complete-spend.ts and must contain no second
 * source it could obtain it from instead. A source-level contract rather than
 * six end-to-end fixtures, because the failure being guarded is a change to
 * WHICH SOURCE a call site reads — visible in the source, and cheap enough to
 * run on every commit rather than only when a container is available.
 *
 * Comments are stripped first, so a doc comment explaining what a file used to
 * read ("it was a SUM over attribution_record here") is not a false positive.
 * The counts are pinned deliberately: a new read of any of these tables inside a
 * producer is a decision that has to be argued for in review, not one that
 * lands quietly.
 */
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it, expect } from 'vitest'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8')

/** Strip block + line comments (line-comment strip skips `https://` URLs). */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
}

const SEAM = 'server/usage/complete-spend.ts'

/** Every entry point that returns a §A project figure. */
const SANCTIONED = [
  'completeProjectSpend',
  'completeOneProjectSpend',
  'completeProjectSpendByMember',
  'completeProjectSpendByActivity',
  'completeProjectAxisSpend',
  /*
   * The UNCAPPED sibling of the axis seam — same lane, same clamp contract, no
   * ranking cut (04-prototype-delta.md §5b: at one cost centre the list IS the
   * population, so a top-N hides the budget the owner came to find).
   *
   * It is listed HERE, beside the ranked one, because that is the whole point:
   * the two differ only in whether a tail is folded, so a caller must be able to
   * pick either without leaving the seam. What must never happen is a THIRD
   * definition of "what a project spent" appearing because neither shape fitted.
   */
  'completeProjectAxisPopulation',
  'completeCostCentreProjectResiduals',
  'completeCostCentreProjectResidual',
]

/**
 * The producers. Each one publishes a project-spend figure to a human: the
 * project page headline, the /projects cards, the budget editor's consumption
 * card, the manager's per-project table, the P&L owner's card, and the alert
 * that pages a PM. `sourceReads` pins the reads of a NON-seam spend source that
 * the file is allowed to keep, with the reason.
 *
 * `via` is WHERE the file gets the figure from. Nearly always the seam itself;
 * the two reporting scopes now reach it one hop away, through the shared driver
 * engine that owns their PROJECT axis. Recording the hop rather than dropping
 * them from this list keeps both halves pinned — the delegate has to be a listed
 * producer that reads the seam, and the delegating file's own inline lane reads
 * stay counted.
 */
const PRODUCERS: {
  file: string
  what: string
  attributionRecord: number
  attributionAggregate: number
  completeUsage: number
  /**
   * Token count of `usage_rollup_daily` — the §A day-grain rollup the region
   * reports' non-project axes read (docs/design/usage-rollup-lane.md R5). It
   * CARRIES project_id in its grain, so an unpinned read is exactly the hole
   * this suite guards: a project figure computed inline from the rollup would
   * be a second definition of project spend beside the seam. Defaults to 0.
   */
  usageRollup?: number
  /** The module this file obtains the project figure from. Defaults to the seam. */
  via?: string
  why?: string
}[] = [
  {
    file: 'server/api/v1/me/projects/[code]/index.get.ts',
    what: 'the project page headline, team table and activity donut',
    attributionRecord: 0,
    attributionAggregate: 0,
    completeUsage: 0,
  },
  {
    file: 'server/api/v1/me/projects/summary.get.ts',
    what: 'the /projects cards',
    attributionRecord: 0,
    attributionAggregate: 0,
    completeUsage: 0,
  },
  {
    file: 'server/api/v1/me/cost-centres.get.ts',
    what: "the P&L owner's per-project burn and the CC reconciliation",
    attributionRecord: 0,
    attributionAggregate: 0,
    completeUsage: 0,
  },
  {
    file: 'server/api/v1/projects/[id]/consumption.get.ts',
    what: 'the budget editor consumption card ("Manage budget →")',
    attributionRecord: 0,
    attributionAggregate: 0,
    completeUsage: 0,
  },
  {
    file: 'server/workers/budget-alert.ts',
    what: 'the over-budget alert that pages a PM',
    attributionRecord: 0,
    attributionAggregate: 0,
    completeUsage: 0,
  },
  {
    file: 'server/reporting/cost-centres.ts',
    what: "the cost-centre drill's PROJECT axis",
    attributionRecord: 0,
    attributionAggregate: 0,
    /*
     * The cost-centre BURN is a different question on a different clamp (the
     * usage row's cost-owning unit) and legitimately reads the lane inline:
     * cards, drill total, and the teammate / surface / model axes — five. Was
     * six until the month floor moved to the shared month-floor.ts.
     *
     * SEVEN since F5, and both additions are burn-clamped reads, not project
     * totals — which is exactly the line this gate draws:
     *   - `fetchCostCentreProjectShare` (D25) — how much of a project's spend
     *     THIS CENTRE carries. Its clamp is `u.cost_owning_unit_id`, the burn
     *     clamp; the project's OWN total on the same row still comes from the
     *     seam (`completeProjectAxisPopulation`), and the two operands sit side
     *     by side precisely because they are different questions.
     *   - `fetchCostCentreTeammateTierMix` — spend per (teammate, model) under
     *     this centre's burn clamp. Not a project figure at all.
     * An eighth is a new inline figure and has to be argued for here.
     */
    completeUsage: 7,
    why: "the cost centre's own burn, clamped on the usage row, not on a project",
  },
  {
    file: 'server/reporting/regional.ts',
    what: "the regional drill's PROJECT axis",
    via: 'server/reporting/engine/drivers.ts',
    attributionRecord: 0,
    attributionAggregate: 0,
    // Every other regional figure is a REGION/org-unit-scoped usage read, not a
    // project one. Pinned so a future project figure computed inline here is
    // visible in review rather than quietly becoming a second definition.
    // (Counted AFTER comment-stripping, like every other row here.)
    // 15 → 14: the month floor moved to the shared month-floor.ts. It is NOT a
    // project-spend producer (it answers "earliest month in scope"), so it is
    // deliberately absent from this list; its own duplication guard lives in
    // tests/unit/server/month-floor-cache.test.ts.
    // 14 → 13: the §A weekly lane series moved to engine/usage-series.ts, which
    // is likewise a lane series rather than a project-spend producer; its clamp
    // and lane-firewall guards live in the scope-engine integration test.
    // 13 → 12: the per-day metrics moved to the same engine module.
    // 12 → 11: the KPI row's §A totals moved to engine/kpis.ts. That module reads
    // both lanes by design (the tiles render a §A and a §B figure side by side)
    // and is not a project-spend producer either.
    // 11 → 7: the driver axes (teammate, surface, model, practice) moved to
    // engine/drivers.ts, which took the PROJECT axis with them — hence `via`.
    // 7 → 5: the spend trend and the active-developer trend moved to
    // engine/trend-series.ts so the cost-centre scope could reach them. Both are
    // day-grained LANE series over a scope predicate — neither is a project-spend
    // producer, so neither earns a row of its own here; their clamp is executed
    // per scope by tests/integration/reports/cost-centre-engine-wrappers.test.ts.
    // 5 → 1: the vendor split, practices ranking, provider split and exceptions
    // strip moved onto usage_rollup_daily (usage-rollup-lane.md R5) — counted in
    // `usageRollup` below. Seasonality is the ONE read left on the live view
    // (off the page's request path, design R5).
    completeUsage: 1,
    // 5 → 4: the exceptions strip's SQL comment no longer names the table; its
    // FROM (now v_usage_rollup_current, counted with the table) is unchanged.
    usageRollup: 4,
    why: 'region-scoped usage figures on other axes, not project spend',
  },
  {
    file: 'server/reporting/across-regions.ts',
    what: "the whole-company drill's PROJECT axis",
    via: 'server/reporting/engine/drivers.ts',
    attributionRecord: 0,
    attributionAggregate: 0,
    // 16 → 15: the month floor moved to the shared month-floor.ts (see above).
    // 15 → 14: the §A weekly lane series moved to engine/usage-series.ts.
    // 14 → 13: the per-day metrics moved to the same engine module.
    // 13 → 12: the KPI row's §A totals moved to engine/kpis.ts (see above). The
    // §A month-over-month operand stays here — only this scope renders it.
    // 12 → 7: the driver axes moved to engine/drivers.ts (see above). The five
    // that remain are the region cards, the provider split, the trend, the
    // concentration scan and the active-users trend — none of them a project
    // figure. Two of the seven are the §A MoM operand and its own totals read.
    // 7 → 8: the per-PERSON cohort (`fetchAcrossPerPerson`) — the median and
    // percentile spread behind the Median-per-person tile, which absorbed the
    // standalone Concentration card (prototype `note('fix 6', …)`).
    // 8 → 6: BOTH of those left. The Region width now renders the same KPI row,
    // so the §A MoM operand moved into engine/kpis.ts and the per-person cohort
    // into engine/per-person.ts — each scope-clamped, each read once. This file's
    // invariant is unchanged and the surface it can be broken on is smaller:
    // every read left here is a whole-company figure on a NON-project axis.
    // 6 → 1: the region cards, provider split, trend, concentration scan and
    // active-users trend moved onto usage_rollup_daily (usage-rollup-lane.md R5)
    // — counted in `usageRollup` below. Seasonality is the ONE read left on the
    // live view (off the page's request path, design R5).
    completeUsage: 1,
    usageRollup: 5,
    why: 'whole-company usage figures on other axes, not project spend',
  },
  {
    file: 'server/reporting/engine/drivers.ts',
    what: "BOTH reporting scopes' PROJECT axis, scope-parameterised",
    /*
     * ONE MORE HOP. The project axis moved out of this file into
     * `engine/budget-axis.ts` when the reporting lane toggle reached the
     * drivers: it is now the ONE axis whose lane does not follow the toggle
     * (`provider_usage_fact` has no project column, and inventing a split is the
     * apportionment target-state-data-architecture.md §5 deleted), and giving it
     * its own module is what makes that argument reviewable in one place rather
     * than as a branch inside a six-way switch.
     *
     * The hop is recorded rather than the row deleted, for the reason the `via`
     * mechanism exists: both halves stay pinned, so the delegate has to remain a
     * listed producer that reads the seam.
     */
    via: 'server/reporting/engine/budget-axis.ts',
    attributionRecord: 0,
    attributionAggregate: 0,
    // The other five driver axes (teammate, surface, region, model, practice)
    // read the §A lane inline: each is a scope-grain ranking, not a project
    // total. Since the rollup swap (usage-rollup-lane.md R5) those five read
    // usage_rollup_daily — counted in `usageRollup` — while the PROJECT axis
    // reads THROUGH the seam, which scans the rollup for this caller
    // (`source: 'rollup'`, R5b) and the live view for every non-report
    // consumer. A sixth inline read is a new axis and has to be argued for
    // here.
    completeUsage: 0,
    usageRollup: 5,
    why: 'the other five driver axes, each a scope-grain ranking',
  },
  {
    file: 'server/reporting/engine/budget-axis.ts',
    what: 'the BUDGET axis — the shipped attribution, in BOTH lanes',
    attributionRecord: 0,
    attributionAggregate: 0,
    /*
     * ZERO inline lane reads, and that is the point of the module: the budget
     * answer is the seam's, never a second grouping written beside it. It is
     * also the file most exposed to the temptation this suite guards — a reader
     * asking "why is the budget axis not billed?" is one step from computing a
     * billed-money-by-budget figure inline, which is the ratio §5 deleted.
     */
    completeUsage: 0,
    why: 'the budget answer is the seam’s alone — no inline lane read at all',
  },
]

const count = (src: string, table: string) =>
  (src.match(new RegExp(`\\b${table}\\b`, 'g')) ?? []).length

describe('project spend has ONE source, at every call site', () => {
  it('the seam itself reads the §A lane and nothing else', () => {
    const code = stripComments(read(SEAM))
    expect(code).toMatch(/\bv_complete_usage\b/)
    expect(code, 'the seam must not read the ledger').not.toMatch(/\battribution_record\b/)
    expect(code, 'the seam must not read the OTel-only rollup').not.toMatch(
      /\battribution_aggregate\b/,
    )
  })

  it.each(PRODUCERS)('$file obtains project spend from the seam ($what)', ({ file, via }) => {
    const code = stripComments(read(file))
    if (via) {
      /*
       * A CHAIN, not a single hop. `regional.ts` reaches the seam through
       * `engine/drivers.ts`, which now reaches it through `engine/budget-axis.ts`
       * — the module the budget axis moved into when the lane toggle arrived. A
       * one-hop rule would have forced either a fake `via` or the deletion of a
       * row, and both lose the property this check exists for.
       *
       * BOTH HALVES OF EVERY LINK STILL MATTER: each file must actually import
       * the delegate it names, and the chain must TERMINATE at a listed producer
       * that reads the seam directly. A cycle, or a chain ending at a module that
       * stopped reading the seam, leaves a project figure with no pinned source
       * at all — so the walk is bounded and the terminus is asserted.
       */
      const seen = new Set<string>()
      let current: string = file
      let delegate: string | undefined = via
      while (delegate) {
        expect(seen.has(current), `${file}: delegation cycle at ${current}`).toBe(false)
        seen.add(current)
        // The import specifier is relative to the DELEGATING file's directory, so
        // match on the delegate's module name rather than reconstructing a path
        // that only happens to be right for one directory depth.
        const moduleName = delegate.split('/').pop()!.replace(/\.ts$/, '')
        expect(
          stripComments(read(current)),
          `${current} must import its delegate ${delegate}`,
        ).toMatch(new RegExp(`from ['"][^'"]*/${moduleName}['"]`))
        const next: (typeof PRODUCERS)[number] | undefined = PRODUCERS.find(
          (p) => p.file === delegate,
        )
        expect(next, `${delegate} must itself be a listed producer`).toBeDefined()
        current = delegate
        delegate = next!.via
      }
      // The terminus reads the seam directly — asserted by its own `via`-less run
      // of this same test, which the loop above has just proven is reachable.
      expect(PRODUCERS.some((p) => p.file === current && !p.via)).toBe(true)
      return
    }
    expect(code, `${file} must import from the project-spend seam`).toMatch(
      /from ['"][^'"]*usage\/complete-spend['"]/,
    )
    const called = SANCTIONED.filter((fn) => code.includes(`${fn}(`))
    expect(
      called.length,
      `${file} imports the seam but calls none of ${SANCTIONED.join(', ')} — ` +
        'a project figure computed some other way is exactly the regression this pins',
    ).toBeGreaterThan(0)
  })

  it.each(PRODUCERS)(
    '$file has no second spend source it could read instead',
    ({ file, attributionRecord, attributionAggregate, completeUsage, usageRollup, why }) => {
      const code = stripComments(read(file))
      const note = why ? ` (allowed: ${why})` : ''
      expect(count(code, 'attribution_record'), `${file}: attribution_record reads${note}`).toBe(
        attributionRecord,
      )
      expect(
        count(code, 'attribution_aggregate'),
        `${file}: attribution_aggregate is the OTel-only, cron-lagged rollup — ` +
          'the source every one of these surfaces was moved OFF',
      ).toBe(attributionAggregate)
      // The current-org lens views (mig 0162) are the same lane read through the
      // teammate's current placement, so they count as the lane they wrap.
      expect(
        count(code, 'v_complete_usage') + count(code, 'v_complete_usage_current'),
        `${file}: inline lane reads${note} — a project total belongs to the seam, ` +
          'so that one definition can be changed in one place',
      ).toBe(completeUsage)
      expect(
        count(code, 'usage_rollup_daily') + count(code, 'v_usage_rollup_current'),
        `${file}: inline §A rollup reads${note} — the rollup carries project_id ` +
          '(usage-rollup-lane.md R2), so an unpinned read is where a second ' +
          'definition of project spend would land quietly',
      ).toBe(usageRollup ?? 0)
    },
  )

  it('pins the producer list itself — a new project-spend surface must be added here', () => {
    // The list is the contract. If a further surface starts publishing a project
    // figure and is not listed, nothing above covers it — so the count is
    // asserted, forcing the author of that surface through this file.
    expect(PRODUCERS.length).toBe(10)
    // And each named file must exist (a rename must not silently empty the set).
    for (const p of PRODUCERS) expect(() => read(p.file)).not.toThrow()
  })
})
