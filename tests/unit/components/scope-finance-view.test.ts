// @vitest-environment happy-dom
/*
 * ScopeFinanceView — the presentational Finance tree (Wave 5). Verifies
 * build-design §3's "exactly one of skeleton / error / empty / data" contract (for
 * BOTH the index and the drill), the VISIBLE Σ=bill check row states (green matched /
 * RED unsettled, with the amounts), the exempt-gap card, the per-CoU table, and the
 * INFORMATIONAL Overage Drivers panel (D-Q6, never a charge).
 */
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import ScopeFinanceView from '../../../app/components/reporting/ScopeFinanceView.vue'
import type { FinanceReport, FinanceDrill } from '../../../app/components/reporting/finance-report-types'

const meta = {
  month: '2026-05',
  monthFloor: '2026-05',
  asOfDate: '2026-05-31',
  providerStates: [
    { vendor: 'anthropic' as const, state: 'settling' as const, settlesAt: '2026-06-30', closeRun: false as const },
    { vendor: 'github' as const, state: 'settling' as const, settlesAt: '2026-06-07', invoiceReconciled: false, closeRun: false as const },
  ],
  scope: 'finance' as const,
}

const HOMING = 'Chargeback rows are homed to the current org structure.'

function makeReport(over: Partial<FinanceReport> = {}): FinanceReport {
  return {
    meta,
    billCheck: {
      chargebackUsd: 360,
      billUsd: 360,
      deltaUsd: 0,
      matched: true,
      unsettled: false,
      copilotChargebackUsd: 300,
      // V3: the Copilot §B lane split + the Anthropic per-surface split (Σ == 60).
      copilotLanes: [
        { lane: 'copilot-license', label: 'Copilot License', usd: 200 },
        { lane: 'copilot-usage', label: 'Copilot Usage', usd: 100 },
        { lane: 'copilot-unclassified', label: 'Copilot (unclassified)', usd: 0 },
      ],
      anthropicLanes: [
        { lane: 'claude', label: 'Claude Code', usd: 40 },
        { lane: 'claude-ai', label: 'Claude Chat', usd: 20 },
      ],
      providers: [
        { provider: 'anthropic', billUsd: 60, unsettled: false },
        { provider: 'github', billUsd: 300, unsettled: false },
      ],
    },
    cous: [
      {
        couId: 'a', code: 'a', displayName: 'Practice A', regionCode: 'ra', anthropicUsd: 50, copilotUsd: 300, copilotPending: false, chargeableUsd: 350,
        // #142 — the per-surface split: Σ non-copilot lanes == anthropicUsd.
        lanes: [
          { lane: 'claude', label: 'Claude Code', usd: 30 },
          { lane: 'claude-ai', label: 'Claude Chat', usd: 20 },
          { lane: 'copilot', label: 'Copilot', usd: 300 },
        ],
      },
      {
        couId: null, code: null, displayName: 'Unallocated', regionCode: null, anthropicUsd: 0, copilotUsd: 20, copilotPending: false, chargeableUsd: 20,
        lanes: [{ lane: 'copilot', label: 'Copilot', usd: 20 }],
      },
    ],
    copilot: { mode: 'chargeback', pending: false },
    exemptGap: { indicativeUsageUsd: 90, chargebackUsd: 360, gapUsd: -270, copilotChargebackUsd: 300 },
    region: null,
    homingNote: HOMING,
    ...over,
  }
}

function makeDrill(over: Partial<FinanceDrill> = {}): FinanceDrill {
  return {
    meta,
    cou: { id: 'a', code: 'a', displayName: 'Practice A', regionCode: 'ra' },
    anthropicCharges: [
      // V3: each teammate row carries its per-lane split (Σ lanes == chargeUsd).
      {
        teammateId: 'al',
        label: 'alice',
        chargeUsd: 30,
        lanes: [
          { lane: 'claude', label: 'Claude Code', usd: 25 },
          { lane: 'claude-ai', label: 'Claude Chat', usd: 5 },
        ],
      },
      {
        teammateId: 'bo',
        label: 'bob',
        chargeUsd: 20,
        lanes: [{ lane: 'claude', label: 'Claude Code', usd: 20 }],
      },
    ],
    anthropicChargeableUsd: 50,
    copilot: {
      mode: 'chargeback',
      pending: false,
      pooledLines: [{ orgId: 'o1', label: 'Octo Org', licenseUsd: 200, overageUsd: 100, netUsd: 300, unsettled: false }],
      poolUtilisation: null,
      chargeableUsd: 300,
      licenseNetUsd: 200,
      overageNetUsd: 100,
      unsettled: false,
    },
    chargeableUsd: 350,
    projectOverlay: [
      { key: 'p1', label: 'Project X', usd: 30, sharePct: 0.6, spendClass: 'indicative' },
      { key: '__untagged', label: 'Untagged', usd: 20, sharePct: 0.4, spendClass: 'indicative' },
    ],
    projectHeadlineUsd: 50,
    overageDrivers: {
      overageNetUsd: 100,
      perSeatShareUsd: 100,
      rows: [
        { key: 'al', label: 'alice', usd: 75, sharePct: 0.75, spendClass: 'indicative' },
        { key: 'bo', label: 'bob', usd: 25, sharePct: 0.25, spendClass: 'indicative' },
      ],
    },
    homingNote: HOMING,
    ...over,
  }
}

const baseProps = {
  month: '2026-05',
  floor: '2026-01',
  ceiling: '2026-06',
  exportParams: { scope: 'finance', report: 'ledger', month: '2026-05' },
  exportFilename: 'tokenscope-finance-ledger-2026-05.csv',
  drillPending: false,
}

const indexSeen = (w: ReturnType<typeof mount>) => ({
  skeleton: w.find('[data-testid="report-skeleton"]').exists(),
  error: w.find('[data-testid="fetch-error-banner"]').exists(),
  empty: w.find('[data-testid="report-empty"]').exists(),
  data: w.find('[data-testid="finance-index-data"]').exists(),
})

describe('ScopeFinanceView — the index four exclusive states', () => {
  it('SKELETON while pending with no data', () => {
    const w = mount(ScopeFinanceView, { props: { ...baseProps, report: null, drill: null, isDrill: false, pending: true } })
    expect(indexSeen(w)).toEqual({ skeleton: true, error: false, empty: false, data: false })
  })

  it('ERROR when the index fetch failed', () => {
    const w = mount(ScopeFinanceView, { props: { ...baseProps, report: null, drill: null, isDrill: false, pending: false, error: new Error('boom') } })
    const s = indexSeen(w)
    expect(s.error).toBe(true)
    expect([s.skeleton, s.empty, s.data]).toEqual([false, false, false])
  })

  it('EMPTY when the month has no finance data at all', () => {
    const empty = makeReport({
      cous: [],
      billCheck: { chargebackUsd: 0, billUsd: 0, deltaUsd: 0, matched: true, unsettled: false, copilotChargebackUsd: 0, providers: [] },
      exemptGap: { indicativeUsageUsd: 0, chargebackUsd: 0, gapUsd: 0, copilotChargebackUsd: 0 },
    })
    const w = mount(ScopeFinanceView, { props: { ...baseProps, report: empty, drill: null, isDrill: false, pending: false } })
    expect(indexSeen(w)).toEqual({ skeleton: false, error: false, empty: true, data: false })
  })

  it('DATA renders the Σ=bill row, exempt-gap card, per-CoU table + homing disclosure + export', () => {
    const w = mount(ScopeFinanceView, { props: { ...baseProps, report: makeReport(), drill: null, isDrill: false, pending: false } })
    expect(indexSeen(w)).toEqual({ skeleton: false, error: false, empty: false, data: true })
    expect(w.find('[data-testid="finance-bill-check"]').exists()).toBe(true)
    expect(w.find('[data-testid="finance-exempt-gap"]').exists()).toBe(true)
    expect(w.find('[data-testid="finance-cou-table"]').exists()).toBe(true)
    expect(w.find('[data-testid="finance-cou-row-a"]').exists()).toBe(true)
    expect(w.find('[data-testid="finance-homing"]').text().toLowerCase()).toContain('current org structure')
    expect(w.find('[data-testid="export-csv-button"]').exists()).toBe(true)
  })

  it('hides the (month-grained) ledger export in a multi-month range, showing a note instead', () => {
    const w = mount(ScopeFinanceView, {
      props: { ...baseProps, report: makeReport(), drill: null, isDrill: false, pending: false, ledgerMonthOnly: true },
    })
    expect(w.find('[data-testid="export-csv-button"]').exists()).toBe(false)
    expect(w.find('[data-testid="finance-ledger-month-only"]').text().toLowerCase()).toContain('month-grained')
  })
})

describe('ScopeFinanceView — the Σ=bill check row states', () => {
  it('a MATCHED month renders GREEN "reconciles to bill" with the amounts', () => {
    const w = mount(ScopeFinanceView, { props: { ...baseProps, report: makeReport(), drill: null, isDrill: false, pending: false } })
    const check = w.find('[data-testid="finance-bill-check"]')
    expect(check.attributes('data-matched')).toBe('true')
    expect(w.find('[data-testid="finance-bill-check-matched"]').exists()).toBe(true)
    expect(w.find('[data-testid="finance-bill-check-unsettled"]').exists()).toBe(false)
    expect(check.text()).toContain('$360') // chargeback = bill amount shown
  })

  it('an UNSETTLED month renders RED "unsettled" with the amounts (never a silent pass)', () => {
    const report = makeReport({
      billCheck: {
        chargebackUsd: 50, billUsd: 50, deltaUsd: 0, matched: false, unsettled: true, copilotChargebackUsd: 50,
        providers: [{ provider: 'github', billUsd: 50, unsettled: true }],
      },
    })
    const w = mount(ScopeFinanceView, { props: { ...baseProps, report, drill: null, isDrill: false, pending: false } })
    const check = w.find('[data-testid="finance-bill-check"]')
    expect(check.attributes('data-matched')).toBe('false')
    const chip = w.find('[data-testid="finance-bill-check-unsettled"]')
    expect(chip.exists()).toBe(true)
    expect(chip.text()).toContain('unsettled')
    expect(check.text()).toContain('$50')
  })
})

describe('ScopeFinanceView — the Copilot chargeback chip (index)', () => {
  it('shows the "pending" chip in pool-utilisation mode', () => {
    const report = makeReport({
      copilot: { mode: 'pool-utilisation', pending: true },
      cous: [{ couId: 'a', code: 'a', displayName: 'Practice A', regionCode: 'ra', anthropicUsd: 50, copilotUsd: 300, copilotPending: true, chargeableUsd: 50 }],
    })
    const w = mount(ScopeFinanceView, { props: { ...baseProps, report, drill: null, isDrill: false, pending: false } })
    expect(w.find('[data-testid="finance-copilot-pending-chip"]').exists()).toBe(true)
    expect(w.find('[data-testid="finance-copilot-chargeback-chip"]').exists()).toBe(false)
    // The Copilot column reads "pending", never a leaked charge into the total.
    expect(w.find('[data-testid="finance-cou-row-a"]').text().toLowerCase()).toContain('pending')
  })

  it('shows the "included" chip once chargeback mode is validated', () => {
    const w = mount(ScopeFinanceView, { props: { ...baseProps, report: makeReport(), drill: null, isDrill: false, pending: false } })
    expect(w.find('[data-testid="finance-copilot-pending-chip"]').exists()).toBe(false)
    expect(w.find('[data-testid="finance-copilot-chargeback-chip"]').exists()).toBe(true)
  })
})

const drillSeen = (w: ReturnType<typeof mount>) => ({
  skeleton: w.find('[data-testid="report-skeleton"]').exists(),
  error: w.find('[data-testid="fetch-error-banner"]').exists(),
  empty: w.find('[data-testid="report-empty"]').exists(),
  data: w.find('[data-testid="finance-drill-data"]').exists(),
})

describe('ScopeFinanceView — the drill four exclusive states', () => {
  it('SKELETON while the drill is pending with no drill data', () => {
    const w = mount(ScopeFinanceView, { props: { ...baseProps, report: makeReport(), drill: null, isDrill: true, pending: false, drillPending: true } })
    expect(drillSeen(w)).toEqual({ skeleton: true, error: false, empty: false, data: false })
  })

  it('ERROR when the drill fetch failed (e.g. a 404)', () => {
    const w = mount(ScopeFinanceView, { props: { ...baseProps, report: makeReport(), drill: null, isDrill: true, pending: false, drillError: new Error('404') } })
    expect(drillSeen(w).error).toBe(true)
  })

  it('DATA renders the Anthropic charges, Copilot pooled lines, project overlay, Overage Drivers', () => {
    const w = mount(ScopeFinanceView, { props: { ...baseProps, report: makeReport(), drill: makeDrill(), isDrill: true, pending: false } })
    expect(drillSeen(w)).toEqual({ skeleton: false, error: false, empty: false, data: true })
    expect(w.find('[data-testid="finance-anthropic-charges"]').exists()).toBe(true)
    expect(w.find('[data-testid="finance-copilot-pooled-lines"]').exists()).toBe(true)
    expect(w.find('[data-testid="finance-copilot-pool-card"]').exists()).toBe(false)
    expect(w.find('[data-testid="finance-project-overlay"]').exists()).toBe(true)
    expect(w.find('[data-testid="finance-overage-drivers"]').exists()).toBe(true)
  })

  it('pool-utilisation mode renders the pool card, NOT the pooled lines, and hides Overage Drivers', () => {
    const drill = makeDrill({
      copilot: { mode: 'pool-utilisation', pending: true, pooledLines: null, poolUtilisation: { usageGrossUsd: 500, poolUsd: 400, utilisation: 1.25 }, chargeableUsd: null, licenseNetUsd: 200, overageNetUsd: 100, unsettled: false },
      chargeableUsd: 50,
      overageDrivers: null,
    })
    const w = mount(ScopeFinanceView, { props: { ...baseProps, report: makeReport(), drill, isDrill: true, pending: false } })
    expect(w.find('[data-testid="finance-copilot-pool-card"]').exists()).toBe(true)
    expect(w.find('[data-testid="finance-copilot-pooled-lines"]').exists()).toBe(false)
    // "pooled — pending correct writer" named an internal work item; the state a
    // finance reader needs is that the figure is held back and the rest is an
    // estimate.
    expect(w.find('[data-testid="finance-copilot-pending-note"]').text().toLowerCase()).toContain(
      'held back until validated',
    )
    expect(w.find('[data-testid="finance-overage-drivers"]').exists()).toBe(false)
    expect(w.find('[data-testid="finance-copilot-pending-chip"]').exists()).toBe(true)
  })
})

describe('ScopeFinanceView — the Overage Drivers panel is INFORMATIONAL', () => {
  it('labels the shares informational — not a charge — and reconciles to the paid overage', () => {
    const w = mount(ScopeFinanceView, { props: { ...baseProps, report: makeReport(), drill: makeDrill(), isDrill: true, pending: false } })
    const panel = w.find('[data-testid="finance-overage-drivers"]')
    expect(panel.exists()).toBe(true)
    expect(panel.find('[data-testid="finance-overage-note"]').text().toLowerCase()).toContain('never a charge')
    // The DriversTable sum-back row reconciles (Σ shares = paid overage) — not RED.
    const sumback = panel.find('[data-testid="drivers-sumback"]')
    expect(sumback.attributes('data-mismatch')).toBe('false')
  })
})

// ── M1: pool-utilisation foot-mismatch honesty (Σ=bill + exempt-gap captions) ──
describe('ScopeFinanceView — pool-utilisation reconciling captions (M1)', () => {
  const poolUtilReport = () =>
    makeReport({
      copilot: { mode: 'pool-utilisation', pending: true },
      // Σ=bill stays whole-truth (300 Copilot pooled net), while the CoU column holds it back.
      cous: [{ couId: 'a', code: 'a', displayName: 'Practice A', regionCode: 'ra', anthropicUsd: 60, copilotUsd: 300, copilotPending: true, chargeableUsd: 60 }],
    })

  it('pool-utilisation mode: the Σ=bill row carries the held-back Copilot caption with the exact amount', () => {
    const w = mount(ScopeFinanceView, { props: { ...baseProps, report: poolUtilReport(), drill: null, isDrill: false, pending: false } })
    const cap = w.find('[data-testid="finance-bill-copilot-caption"]')
    expect(cap.exists()).toBe(true)
    expect(cap.text().toLowerCase()).toContain('pending cutover')
    expect(cap.text()).toContain('$300') // billCheck.copilotChargebackUsd
  })

  it('pool-utilisation mode: the exempt-gap card carries the same held-back caption', () => {
    const w = mount(ScopeFinanceView, { props: { ...baseProps, report: poolUtilReport(), drill: null, isDrill: false, pending: false } })
    const cap = w.find('[data-testid="finance-exempt-gap-copilot-caption"]')
    expect(cap.exists()).toBe(true)
    expect(cap.text()).toContain('$300') // exemptGap.copilotChargebackUsd
  })

  it('chargeback mode: NO reconciling captions (the Σ=bill row and the Chargeable column foot)', () => {
    const w = mount(ScopeFinanceView, { props: { ...baseProps, report: makeReport(), drill: null, isDrill: false, pending: false } })
    expect(w.find('[data-testid="finance-bill-copilot-caption"]').exists()).toBe(false)
    expect(w.find('[data-testid="finance-exempt-gap-copilot-caption"]').exists()).toBe(false)
  })
})

// ── M2: unsettled CoU-month drill caveats the Chargeable headline + shows amber ──
describe('ScopeFinanceView — unsettled CoU-month drill (M2)', () => {
  const unsettledDrill = () =>
    makeDrill({
      // A pooled line with usage but no read license SKU → chargeableUsd drops the unread license.
      copilot: {
        mode: 'chargeback',
        pending: false,
        pooledLines: [{ orgId: 'o1', label: 'Octo Org', licenseUsd: 0, overageUsd: 50, netUsd: 50, unsettled: true }],
        poolUtilisation: null,
        chargeableUsd: 50,
        licenseNetUsd: 0,
        overageNetUsd: 50,
        unsettled: true,
      },
      chargeableUsd: 50,
      overageDrivers: null,
    })

  it('renders the amber unsettled chip + Chargeable caveat, NOT the green "included" chip', () => {
    const w = mount(ScopeFinanceView, { props: { ...baseProps, report: makeReport(), drill: unsettledDrill(), isDrill: true, pending: false } })
    expect(w.find('[data-testid="finance-copilot-unsettled-chip"]').exists()).toBe(true)
    expect(w.find('[data-testid="finance-copilot-chargeback-chip"]').exists()).toBe(false)
    const caveat = w.find('[data-testid="finance-drill-chargeable-caveat"]')
    expect(caveat.exists()).toBe(true)
    expect(caveat.text().toLowerCase()).toContain('excludes unread license')
  })

  it('a settled drill still shows the green "included" chip and no caveat', () => {
    const w = mount(ScopeFinanceView, { props: { ...baseProps, report: makeReport(), drill: makeDrill(), isDrill: true, pending: false } })
    expect(w.find('[data-testid="finance-copilot-chargeback-chip"]').exists()).toBe(true)
    expect(w.find('[data-testid="finance-copilot-unsettled-chip"]').exists()).toBe(false)
    expect(w.find('[data-testid="finance-drill-chargeable-caveat"]').exists()).toBe(false)
  })
})

// ── V3: per-lane structure within provider groups + the drill's dominant-lane badge ──
describe('ScopeFinanceView — bill-compare per-lane structure (lane-visuals V3)', () => {
  it('renders the Anthropic surface-lane chips AND the Copilot §B lane chips (zero lanes elided)', () => {
    const w = mount(ScopeFinanceView, { props: { ...baseProps, report: makeReport(), drill: null, isDrill: false, pending: false } })
    const anthropic = w.find('[data-testid="finance-compare-anthropic-lanes"]')
    expect(anthropic.exists()).toBe(true)
    expect(anthropic.text()).toContain('Claude Code')
    expect(anthropic.text()).toContain('Claude Chat')
    const copilot = w.find('[data-testid="finance-compare-copilot-lanes"]')
    expect(copilot.exists()).toBe(true)
    expect(copilot.text()).toContain('Copilot License')
    // The $0 copilot-unclassified lane is elided (zero lanes never render).
    expect(w.find('[data-testid="finance-compare-lane-copilot-unclassified"]').exists()).toBe(false)
  })

  it('FOLDS the Anthropic group past 5 lanes into ONE "Other surfaces" remainder (r1-F3)', () => {
    const report = makeReport({
      billCheck: {
        ...makeReport().billCheck,
        anthropicLanes: [
          { lane: 'claude', label: 'Claude Code', usd: 30 },
          { lane: 'claude-ai', label: 'Claude Chat', usd: 12 },
          { lane: 'claude-cowork', label: 'Claude Cowork', usd: 8 },
          { lane: 'claude-office', label: 'Claude Office Agents', usd: 5 },
          { lane: 'claude-chrome', label: 'Claude in Chrome', usd: 3 },
          { lane: 'claude-slack', label: 'Claude in Slack', usd: 1.5 },
          { lane: 'claude-other', label: 'Claude (other)', usd: 0.5 },
        ],
      },
    })
    const w = mount(ScopeFinanceView, { props: { ...baseProps, report, drill: null, isDrill: false, pending: false } })
    const anthropic = w.find('[data-testid="finance-compare-anthropic-lanes"]')
    // Top-4 keep identity + ONE remainder = 5 chips; the folded two never render alone.
    expect(anthropic.findAll('[data-testid^="finance-compare-lane-"]').length).toBe(5)
    const remainder = w.find('[data-testid="finance-compare-lane-other-lanes"]')
    expect(remainder.exists()).toBe(true)
    expect(remainder.text()).toContain('Other surfaces')
    // Conservation: the remainder carries the folded Σ (3 + 1.5 + 0.5 = 5.00 —
    // top-4 keep identity, r1-F3) and its tooltip itemises the folded lanes.
    expect(remainder.text()).toContain('$5.00')
    expect(remainder.attributes('title')).toContain('Claude in Chrome')
    expect(remainder.attributes('title')).toContain('Claude in Slack')
    expect(remainder.attributes('title')).toContain('Claude (other)')
    expect(w.find('[data-testid="finance-compare-lane-claude-slack"]').exists()).toBe(false)
  })
})

describe('ScopeFinanceView — drill dominant-lane badge (lane-visuals V3, r1-F7/r2-5)', () => {
  it('each teammate row badges its DOMINANT lane with the share %, not a mini-stack', () => {
    const w = mount(ScopeFinanceView, { props: { ...baseProps, report: makeReport(), drill: makeDrill(), isDrill: true, pending: false } })
    const badges = w.findAll('[data-testid="finance-drill-lane-badge"]')
    expect(badges.length).toBe(2)
    // alice: claude 25 of 30 ≈ 83% dominant, +1 surface tooltip itemising the rest.
    expect(badges[0]!.attributes('data-lane')).toBe('claude')
    expect(badges[0]!.text()).toContain('Claude Code')
    expect(badges[0]!.text()).toContain('83%')
    const others = badges[0]!.find('[data-testid="finance-drill-lane-others"]')
    expect(others.exists()).toBe(true)
    expect(others.text()).toContain('+1 surface')
    expect(others.attributes('title')).toContain('Claude Chat')
    expect(others.attributes('title')).toContain('$5.00')
    // bob: single-lane row — badge at 100%, no "+N surfaces" affordance.
    expect(badges[1]!.text()).toContain('100%')
    expect(badges[1]!.find('[data-testid="finance-drill-lane-others"]').exists()).toBe(false)
  })

  it('MIXED-sign row (credit lane): the badge SUPPRESSES the share — lane + $ without a % (r3-5)', () => {
    const drill = makeDrill({
      anthropicCharges: [
        {
          teammateId: 'cr',
          label: 'carol',
          // Σ lanes == chargeUsd (conservation) but one lane is a CREDIT:
          // claude 100 / chargeUsd 70 would render "143%" — never a share.
          chargeUsd: 70,
          lanes: [
            { lane: 'claude', label: 'Claude Code', usd: 100 },
            { lane: 'claude-ai', label: 'Claude Chat', usd: -30 },
          ],
        },
      ],
      anthropicChargeableUsd: 70,
    })
    const w = mount(ScopeFinanceView, { props: { ...baseProps, report: makeReport(), drill, isDrill: true, pending: false } })
    const badge = w.find('[data-testid="finance-drill-lane-badge"]')
    expect(badge.exists()).toBe(true)
    expect(badge.attributes('data-lane')).toBe('claude')
    expect(badge.text()).toContain('Claude Code')
    // The dominant lane's $ replaces the share; NO percentage renders anywhere.
    expect(badge.text()).toContain('$100.00')
    expect(badge.text()).not.toContain('%')
    // The tooltip still itemises the credit lane.
    const others = badge.find('[data-testid="finance-drill-lane-others"]')
    expect(others.exists()).toBe(true)
    expect(others.attributes('title')).toContain('Claude Chat')
  })
})

/*
 * ── THE BLANK FINANCE PAGE ────────────────────────────────────────────────────
 *
 * The four states above were only ever asserted MUTUALLY EXCLUSIVE. They were never
 * asserted EXHAUSTIVE, and they were not: `report === null` with `pending === false`
 * and no error matched none of them, so the body rendered nothing at all. That is
 * exactly the state Nuxt reports on the SERVER pass for the container's
 * `useFetch(..., { lazy: true, server: false })` — the fetch is deliberately skipped
 * during SSR, so nothing is in flight and no data has arrived — which is why the
 * page shipped its header, period control and "defaults to the last complete month"
 * line above an empty space, and then mismatched on hydration.
 *
 * "Exactly one of four" is only a guarantee if the four cover every input.
 */
describe('ScopeFinanceView — the four states are EXHAUSTIVE (never a blank body)', () => {
  it('INDEX: renders the skeleton when there is no report, nothing in flight and no error', () => {
    const w = mount(ScopeFinanceView, {
      props: { ...baseProps, report: null, drill: null, isDrill: false, pending: false },
    })
    expect(indexSeen(w)).toEqual({ skeleton: true, error: false, empty: false, data: false })
    // And the body is not empty — the defect was visual before it was logical.
    expect(w.find('[data-testid="scope-finance"]').element.children.length).toBeGreaterThan(0)
  })

  it('DRILL: renders the skeleton when there is no drill, nothing in flight and no error', () => {
    const w = mount(ScopeFinanceView, {
      props: { ...baseProps, report: makeReport(), drill: null, isDrill: true, pending: false, drillPending: false },
    })
    expect(drillSeen(w)).toEqual({ skeleton: true, error: false, empty: false, data: false })
    expect(w.find('[data-testid="scope-finance"]').element.children.length).toBeGreaterThan(0)
  })

  it('INDEX: every (report × pending × error) combination renders exactly one state', () => {
    for (const report of [null, makeReport()]) {
      for (const pending of [true, false]) {
        for (const error of [undefined, new Error('boom')]) {
          const w = mount(ScopeFinanceView, {
            props: { ...baseProps, report, drill: null, isDrill: false, pending, error },
          })
          const lit = Object.entries(indexSeen(w)).filter(([, on]) => on).map(([k]) => k)
          expect(lit, `report=${report ? 'set' : 'null'} pending=${pending} error=${Boolean(error)}`).toHaveLength(1)
        }
      }
    }
  })

  it('DRILL: every (drill × drillPending × drillError) combination renders exactly one state', () => {
    for (const drill of [null, makeDrill()]) {
      for (const drillPending of [true, false]) {
        for (const drillError of [undefined, new Error('404')]) {
          const w = mount(ScopeFinanceView, {
            props: { ...baseProps, report: makeReport(), drill, isDrill: true, pending: false, drillPending, drillError },
          })
          const lit = Object.entries(drillSeen(w)).filter(([, on]) => on).map(([k]) => k)
          expect(lit, `drill=${drill ? 'set' : 'null'} pending=${drillPending} error=${Boolean(drillError)}`).toHaveLength(1)
        }
      }
    }
  })
})

/*
 * The "Bill vs chargeback" band is in the owner-signed prototype unconditionally,
 * and it lists GitHub Copilot explicitly as "Pooled net — pending cutover" at $0.00.
 * Filtering zero rows out and then gating the card on `max > 0` deleted the whole
 * band from a period whose only Copilot state was "pending" — the reader lost a
 * section of the report with nothing put in its place.
 */
describe('FinanceBillCompare — a pending provider is shown, not dropped', () => {
  const pendingOnly = () =>
    makeReport({
      billCheck: {
        chargebackUsd: 0, billUsd: 0, deltaUsd: 0, matched: true, unsettled: false,
        copilotChargebackUsd: 0, copilotLanes: [], anthropicLanes: [], providers: [],
      },
      copilot: { mode: 'pool-utilisation', pending: true, unclassifiedWarning: false },
    })

  it('keeps the band, with the pending provider at $0.00, when Copilot chargeback is held back', () => {
    const w = mount(ScopeFinanceView, {
      props: { ...baseProps, report: pendingOnly(), drill: null, isDrill: false, pending: false },
    })
    const card = w.find('[data-testid="finance-bill-compare"]')
    expect(card.exists()).toBe(true)
    const row = w.find('[data-testid="finance-compare-row"][data-provider="copilot"]')
    expect(row.exists()).toBe(true)
    expect(row.text()).toContain('pending cutover')
  })

  it('makes NO reconciliation claim on a row with no money on either bar', () => {
    const w = mount(ScopeFinanceView, {
      props: { ...baseProps, report: pendingOnly(), drill: null, isDrill: false, pending: false },
    })
    // "matched" over $0.00 vs $0.00 is true, vacuous, and reads as a settled month.
    const row = w.find('[data-testid="finance-compare-row"][data-provider="copilot"]')
    expect(row.text()).not.toContain('matched')
  })
})
