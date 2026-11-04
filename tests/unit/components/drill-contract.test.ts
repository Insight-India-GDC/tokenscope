// @vitest-environment happy-dom
/*
 * THE DRILL CONTRACT (developer pages build W4 — D29/D30/D38, prototype fix 7).
 *
 * "Every teammate/project name on a reports surface is a real link or plain text
 * — never a dead button." This file pins the RULES and the RENDERING that
 * enforce it, and the split that a round-1 HIGH (r1-H4) turned on: NAMING a row
 * and OPENING a drill are different questions, decided by different exports.
 *
 * T26 (link-or-plain), T27 (echo round-trip), plus the two-rules pin.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { mount } from '@vue/test-utils'
import DriversTable from '../../../app/components/reporting/DriversTable.vue'
import DrillName from '../../../app/components/reporting/DrillName.vue'
import {
  drillQuery,
  entryReportRoute,
  frameWindow,
  projectDrillTarget,
  dimFact, teammateDrillTarget,
  NO_DRILL_GRANTS,
  type DrillGrants,
} from '../../../app/components/reporting/drill-contract'
import {
  namedContributionRow,
  teammateDrillAdmission,
} from '../../../shared/auth/report-visibility'
import type { DriverRow } from '../../../shared/reports/types'

const linkHref = (to: unknown): string => {
  if (typeof to === 'string') return to
  const r = to as { path?: string; query?: Record<string, string> }
  const q = r.query ? new URLSearchParams(r.query).toString() : ''
  return `${r.path ?? ''}${q ? `?${q}` : ''}`
}
const global = {
  stubs: {
    NuxtLink: {
      props: ['to'],
      computed: {
        href(): string {
          return linkHref((this as { to: unknown }).to)
        },
      },
      template: '<a :href="href"><slot /></a>',
    },
    UiBadge: { template: '<span><slot /></span>' },
    LaneLegend: true,
    BudgetStateCell: true,
  },
  mocks: {
    fmtUsd: (v: number) => `$${v.toFixed(2)}`,
    fmtPct: (v: number) => `${Math.round(v * 100)}%`,
  },
}

const GRANTED: DrillGrants = { teammate: 'people-scope', project: 'member-in-scope' }
const FRAME = { src: 'cc:cc-1', month: '2026-07' }

// ── The two rules are DISTINCT (r1-H4) ───────────────────────────────────────

describe('namedContributionRow vs teammateDrillAdmission — two rules, never one', () => {
  /*
   * THE CASE THE CONFLATION BREAKS. A project MEMBER may see their team-mates
   * NAMED (that is the member-depth team table, no grants model in sight) and
   * hold no reports grant at all. If "named ⇒ drillable" the same member would
   * be handed an audited, refusal-gated per-person governance view — the
   * membership bypass the prototype pins at 403 (`:780-785`).
   */
  it('a project MEMBER names their team-mates but opens NO drill on them', () => {
    const viewer = { grants: { teammate: false as const } }
    const subject = { id: 'sub-1', inPeopleScope: false, isSelf: false }
    expect(namedContributionRow(viewer, subject, { viewerIsMember: true })).toBe(true)
    expect(
      teammateDrillAdmission(
        viewer,
        { id: 'sub-1', hasInScopeWindowRow: true, isActive: true, isProvisional: false },
        { src: 'cc:cc-1', held: true },
        { from: '2026-07-01', to: '2026-07-31' },
      ),
    ).toEqual({ admit: false, reason: 'no-teammate-grant' })
  })

  it('a people-scope viewer both names AND drills a subject in scope', () => {
    const viewer = { grants: { teammate: 'people-scope' as const } }
    expect(
      namedContributionRow(viewer, { id: 's', inPeopleScope: true, isSelf: false }, { viewerIsMember: false }),
    ).toBe(true)
    expect(
      teammateDrillAdmission(
        viewer,
        { id: 's', hasInScopeWindowRow: true, isActive: true, isProvisional: false },
        { src: 'region:r1', held: true },
        { from: '2026-07-01', to: '2026-07-31' },
      ),
    ).toEqual({ admit: true })
  })

  it('an out-of-scope subject folds into the remainder — no name, no door', () => {
    const viewer = { grants: { teammate: 'people-scope' as const } }
    expect(
      namedContributionRow(viewer, { id: 's', inPeopleScope: false, isSelf: false }, { viewerIsMember: false }),
    ).toBe(false)
  })

  it('an unidentified row (the aggregate remainder) is never named and never a door', () => {
    const viewer = { grants: { teammate: 'people-scope' as const } }
    expect(
      namedContributionRow(viewer, { id: null, inPeopleScope: true, isSelf: false }, { viewerIsMember: true }),
    ).toBe(false)
    expect(
      teammateDrillAdmission(
        viewer,
        { id: null, hasInScopeWindowRow: true, isActive: true, isProvisional: false },
        { src: 'across', held: true },
        { from: '2026-07-01', to: '2026-07-31' },
      ),
    ).toEqual({ admit: false, reason: 'unidentified-subject' })
  })

  /*
   * D34's two conjuncts, ISOLATED. Each must be able to fail on its own, or the
   * gate is one rule wearing two names.
   */
  it('emit-time homing and is_active are SEPARATE conjuncts', () => {
    const viewer = { grants: { teammate: 'people-scope' as const } }
    const frame = { src: 'cc:c', held: true }
    const win = { from: '2026-07-01', to: '2026-07-31' }
    expect(
      teammateDrillAdmission(viewer, { id: 's', hasInScopeWindowRow: false, isActive: true, isProvisional: false }, frame, win),
    ).toEqual({ admit: false, reason: 'no-in-scope-row' })
    expect(
      teammateDrillAdmission(viewer, { id: 's', hasInScopeWindowRow: true, isActive: false, isProvisional: false }, frame, win),
    ).toEqual({ admit: false, reason: 'inactive-subject' })
  })

  it('a scope frame the viewer does not hold is a refusal, never a fallback (D33)', () => {
    const viewer = { grants: { teammate: 'people-scope' as const } }
    expect(
      teammateDrillAdmission(
        viewer,
        { id: 's', hasInScopeWindowRow: true, isActive: true, isProvisional: false },
        { src: 'cc:not-mine', held: false },
        { from: '2026-07-01', to: '2026-07-31' },
      ),
    ).toEqual({ admit: false, reason: 'no-scope-frame' })
    expect(
      teammateDrillAdmission(
        viewer,
        { id: 's', hasInScopeWindowRow: true, isActive: true, isProvisional: false },
        { src: null, held: true },
        { from: '2026-07-01', to: '2026-07-31' },
      ),
    ).toEqual({ admit: false, reason: 'no-scope-frame' })
  })
})

// ── T26: link WITH the grant, plain text WITHOUT — same fixture row ──────────

describe('T26 — link or plain text BY GRANT, on the same row', () => {
  // States BOTH facts now: the helper fails closed on an absent one (r6-H1),
  // which is the whole point — a fixture that omits a fact is a row that
  // never arrived, and such a row must not link.
  const teammateRow = { id: 'tm-1', isActive: true, isProvisional: false }

  it('a teammate name links with the grant and is plain text without it', () => {
    expect(teammateDrillTarget(GRANTED, teammateRow, FRAME)).toEqual({
      kind: 'link',
      to: { path: '/reporting/teammate/tm-1', query: { src: 'cc:cc-1', month: '2026-07' } },
    })
    expect(teammateDrillTarget(NO_DRILL_GRANTS, teammateRow, FRAME)).toBeNull()
  })

  it('a DEACTIVATED subject is plain text even for a granted viewer (never a dead link)', () => {
    expect(teammateDrillTarget(GRANTED, { id: 'tm-1', isActive: false }, FRAME)).toBeNull()
  })

  /*
   * r3-M4 — the row's own presence is evidence ONLY where the row's predicate
   * IS the frame. On the project reports depth it is not: naming reads the
   * viewer's whole PEOPLE scope while the link carries one `?src=` frame, so a
   * contributor named through a different owned cost centre gets a link whose
   * destination correctly 403s. The server answers the conjunct; a `false`
   * answer must plain-text the name, not decorate it.
   */
  it('a SERVER-RESOLVED absent in-frame row is plain text, whatever named the row', () => {
    expect(
      teammateDrillTarget(GRANTED, { id: 'tm-1', isActive: true, isProvisional: false, hasInScopeWindowRow: false }, FRAME),
    ).toBeNull()
    // …and the default stays `true`, so every surface whose rows ARE computed
    // over the carried frame keeps linking without carrying a redundant flag.
    expect(
      teammateDrillTarget(GRANTED, { id: 'tm-1', isActive: true, isProvisional: false, hasInScopeWindowRow: true }, FRAME),
    ).not.toBeNull()
  })

  /*
   * r3-H2 — an unconfirmed claimed identity is refused at the endpoint, so a
   * link to it is a dead button; and the name behind it is an email nobody has
   * authenticated.
   */
  it('a PROVISIONAL subject is plain text even for a granted viewer', () => {
    expect(
      teammateDrillTarget(GRANTED, { id: 'tm-1', isActive: true, isProvisional: true }, FRAME),
    ).toBeNull()
    expect(
      teammateDrillAdmission(
        { grants: GRANTED },
        { id: 'tm-1', hasInScopeWindowRow: true, isActive: true, isProvisional: true },
        { src: 'cc:cc-1', held: true },
        { from: '2026-07-01', to: '2026-07-31' },
      ),
    ).toEqual({ admit: false, reason: 'provisional-subject' })
  })

  it('a project name links on a reports grant and is plain text on membership alone', () => {
    expect(projectDrillTarget(GRANTED, 'PROJ-A', FRAME)).toEqual({
      kind: 'link',
      to: { path: '/projects/PROJ-A', query: { src: 'cc:cc-1', month: '2026-07' } },
    })
    expect(projectDrillTarget({ teammate: false, project: 'membership' }, 'PROJ-A', FRAME)).toBeNull()
    expect(projectDrillTarget({ teammate: false, project: 'region-wide' }, 'PROJ-A', FRAME)).not.toBeNull()
  })

  it('a row that can name NO target id is plain text by construction', () => {
    expect(projectDrillTarget(GRANTED, null, FRAME)).toBeNull()
    expect(teammateDrillTarget(GRANTED, { id: null, isActive: true, isProvisional: false }, FRAME)).toBeNull()
  })

  /*
   * The RENDERING half of the same contract: a plain name must carry no button
   * and no link role, so nothing announces it as actionable to a screen reader.
   */
  it('DrillName renders an anchor with a target and a bare span without one', () => {
    const linked = mount(DrillName, {
      global,
      props: { target: { kind: 'link', to: { path: '/x', query: {} } }, label: 'Ada' },
    })
    expect(linked.find('[data-testid="drill-link"]').exists()).toBe(true)
    expect(linked.find('button').exists()).toBe(false)

    const plain = mount(DrillName, { global, props: { target: null, label: 'Ada' } })
    expect(plain.find('[data-testid="drill-plain"]').exists()).toBe(true)
    expect(plain.find('a').exists()).toBe(false)
    expect(plain.find('button').exists()).toBe(false)
    expect(plain.text()).toBe('Ada')
  })

  it('DriversTable renders the SAME row three ways: link · action · plain text', () => {
    const rows: DriverRow[] = [
      { key: 'tm-1', label: 'Ada', usd: 40, sharePct: 1, spendClass: 'indicative' },
    ]
    const base = { rows, headlineUsd: 40, denominatorLabel: 'region usage' }

    const asLink = mount(DriversTable, {
      global,
      props: { ...base, drillable: (r: DriverRow) => teammateDrillTarget(GRANTED, { id: r.key, isActive: true, isProvisional: false }, FRAME) },
    })
    expect(asLink.find('[data-testid="drivers-drill-link"]').attributes('href')).toContain(
      '/reporting/teammate/tm-1',
    )

    const asAction = mount(DriversTable, {
      global,
      props: { ...base, drillable: () => ({ kind: 'action' as const }) },
    })
    expect(asAction.find('[data-testid="drivers-drill"]').exists()).toBe(true)

    const asPlain = mount(DriversTable, {
      global,
      props: { ...base, drillable: (r: DriverRow) => teammateDrillTarget(NO_DRILL_GRANTS, { id: r.key, isActive: true, isProvisional: false }, FRAME) },
    })
    expect(asPlain.find('[data-testid="drivers-plain"]').exists()).toBe(true)
    expect(asPlain.find('button[data-testid="drivers-drill"]').exists()).toBe(false)
    expect(asPlain.find('[data-testid="drivers-drill-link"]').exists()).toBe(false)
  })
})

// ── T27: the drill carries the entry state, and back restores it ─────────────

describe('T27 — echo round-trip: scope + window out, entry report back', () => {
  it('the link carries src + the window in the report vocabulary', () => {
    expect(drillQuery({ src: 'region:r1', month: '2026-07' })).toEqual({
      src: 'region:r1',
      month: '2026-07',
    })
    expect(drillQuery({ src: 'across', from: '2026-07-01', to: '2026-07-15' })).toEqual({
      src: 'across',
      from: '2026-07-01',
      to: '2026-07-15',
    })
    // A frameless surface carries nothing — and its rows are plain text anyway.
    expect(drillQuery({ src: null })).toEqual({})
  })

  it('the breadcrumb reconstructs the ENTRY report URL from the same state', () => {
    expect(entryReportRoute({ src: 'cc:cc-1', month: '2026-07' })).toEqual({
      path: '/reporting',
      query: { scope: 'cost-centre', cc: 'cc-1', month: '2026-07' },
    })
    expect(entryReportRoute({ src: 'region:r1', from: '2026-07-01', to: '2026-07-15' })).toEqual({
      path: '/reporting',
      query: { scope: 'region', region: 'r1', from: '2026-07-01', to: '2026-07-15' },
    })
    expect(entryReportRoute({ src: 'across', month: '2026-07' })).toEqual({
      path: '/reporting',
      query: { scope: 'region', region: 'all', month: '2026-07' },
    })
    expect(entryReportRoute({ src: 'finance', month: '2026-07' })).toEqual({
      path: '/reporting',
      query: { scope: 'finance', month: '2026-07' },
    })
  })

  it('drill → target → back is a byte-stable round trip on the same state', () => {
    const entry = { src: 'cc:cc-1', month: '2026-07' }
    const link = teammateDrillTarget(GRANTED, { id: 'tm-1', isActive: true, isProvisional: false }, entry)!
    // What the target page would parse back out of its own URL…
    const carried = (link as { to: { query: Record<string, string> } }).to.query
    expect(carried).toEqual({ src: 'cc:cc-1', month: '2026-07' })
    // …and reconstruct the entry report from.
    expect(entryReportRoute({ src: carried.src!, month: carried.month! })).toEqual({
      path: '/reporting',
      query: { scope: 'cost-centre', cc: 'cc-1', month: '2026-07' },
    })
  })
})

/*
 * r6-H1 — the facts fail CLOSED at RUNTIME, not merely in the type.
 *
 * Both fields are declared required, so TypeScript is satisfied at every call
 * site. But a type is a promise about source, not about the bytes on the wire:
 * a cached response body or a rolling deploy can hand this function a row that
 * predates the fields. Reading that absence as `false` (the shape the first fix
 * shipped) means "not provisional, so link it" — a shadow identity handed a
 * door that 403s at the destination. Absent must mean unknown, and unknown must
 * not link.
 */
describe('an absent fact never admits a drill', () => {
  const grants = { teammate: 'people-scope' } as never
  // No explicit window: the server's day names the default one (frameWindow).
  const frame = { src: 'cc:11111111-1111-4111-8111-111111111111', today: '2026-08-15' } as never

  it('plain-texts a row whose isProvisional never arrived', () => {
    const row = { id: '22222222-2222-4222-8222-222222222222', isActive: true } as never
    expect(teammateDrillTarget(grants, row, frame)).toBeNull()
  })

  it('plain-texts a row whose isActive never arrived', () => {
    const row = {
      id: '22222222-2222-4222-8222-222222222222',
      isProvisional: false,
    } as never
    expect(teammateDrillTarget(grants, row, frame)).toBeNull()
  })

  it('still links when both facts arrive and both are good', () => {
    const row = {
      id: '22222222-2222-4222-8222-222222222222',
      isActive: true,
      isProvisional: false,
    } as never
    expect(teammateDrillTarget(grants, row, frame)).not.toBeNull()
  })
})

/*
 * r7-H1 — the RULE refuses an unknown, not just its client mirror.
 *
 * `teammateDrillTarget` was made fail-closed first, which left
 * `teammateDrillAdmission` — the rule every server caller uses directly —
 * still admitting a subject whose facts never arrived. The two teammate
 * endpoints were also collapsing `identity?.isProvisional` to `false` before
 * the rule could see it, so a missing identity row read as "confirmed".
 * Absence must disqualify at the bottom, where every caller inherits it.
 */
describe('the RULE itself refuses an unstated fact', () => {
  const viewer = { grants: { teammate: 'people-scope' } } as never
  const frame = { src: 'cc:11111111-1111-4111-8111-111111111111', held: true } as never
  const win = { month: '2026-08' } as never
  const base = { id: 'tm-1', hasInScopeWindowRow: true }

  it('refuses when isProvisional never arrived', () => {
    const d = teammateDrillAdmission(viewer, { ...base, isActive: true } as never, frame, win)
    expect(d.admit).toBe(false)
    expect(d.reason).toBe('provisional-subject')
  })

  it('refuses when isActive never arrived', () => {
    const d = teammateDrillAdmission(viewer, { ...base, isProvisional: false } as never, frame, win)
    expect(d.admit).toBe(false)
    expect(d.reason).toBe('inactive-subject')
  })

  it('admits only when both facts are stated and good', () => {
    const d = teammateDrillAdmission(
      viewer,
      { ...base, isActive: true, isProvisional: false } as never,
      frame,
      win,
    )
    expect(d.admit).toBe(true)
  })
})

/*
 * r8-H1 — a driver row's identity dims are STRINGS, and a dim can be absent or
 * null. `dims?.x === 'true'` collapsed both to `false`, which for
 * `teammate_provisional` reads as "confirmed" — the same fail-open, one layer
 * out, on the four surfaces that read dims directly. `dimFact` keeps the
 * unknown as `undefined` so the rule's fail-closed default decides.
 */
describe('dimFact keeps an unknown unknown', () => {
  it('reads a stated fact', () => {
    expect(dimFact({ teammate_provisional: 'true' }, 'teammate_provisional')).toBe(true)
    expect(dimFact({ teammate_provisional: 'false' }, 'teammate_provisional')).toBe(false)
  })

  it('returns undefined for an absent dim, a null dim, and absent dims', () => {
    expect(dimFact({}, 'teammate_provisional')).toBeUndefined()
    expect(dimFact({ teammate_provisional: null }, 'teammate_provisional')).toBeUndefined()
    expect(dimFact(undefined, 'teammate_provisional')).toBeUndefined()
  })

  it('feeds the rule an unknown that is then REFUSED, not admitted', () => {
    const d = teammateDrillAdmission(
      { grants: { teammate: 'people-scope' } } as never,
      {
        id: 'tm-1',
        hasInScopeWindowRow: true,
        isActive: dimFact({}, 'teammate_active'),
        isProvisional: dimFact({}, 'teammate_provisional'),
      } as never,
      { src: 'cc:11111111-1111-4111-8111-111111111111', held: true } as never,
      { month: '2026-08' } as never,
    )
    expect(d.admit).toBe(false)
  })
})

/*
 * The default window is the SERVER's month, never the browser's (issue 491,
 * clock-and-day-boundary.md D3). The browser clock is pinned to a different UTC
 * day AND month from the server's, so a browser read would show up as the wrong
 * month here.
 */
describe('frameWindow: the default month comes from the server clock', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('a frame with no window is at the server day\'s month, whatever the browser says', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-01T02:00:00Z'))
    expect(frameWindow({ src: 'cc:c', today: '2026-08-31' })).toEqual({ from: '2026-08-01', to: '2026-08-01' })
  })

  it('with no server day yet there is no window, and the rule refuses rather than guessing', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-01T02:00:00Z'))
    expect(frameWindow({ src: 'cc:c' })).toBeNull()
    expect(frameWindow({ src: 'cc:c', today: null })).toBeNull()
    const row = { id: '22222222-2222-4222-8222-222222222222', isActive: true, isProvisional: false }
    expect(teammateDrillTarget(GRANTED, row, { src: 'cc:c' })).toBeNull()
    expect(teammateDrillTarget(GRANTED, row, { src: 'cc:c', today: '2026-08-31' })).not.toBeNull()
  })

  it('an explicit window wins over the server day, and the day never rides the link', () => {
    expect(frameWindow({ src: 'cc:c', month: '2026-07', today: '2026-08-31' })).toEqual({ from: '2026-07-01', to: '2026-07-01' })
    expect(frameWindow({ src: 'cc:c', from: '2026-06-03', to: '2026-06-09', today: '2026-08-31' })).toEqual({ from: '2026-06-03', to: '2026-06-09' })
    expect(drillQuery({ src: 'cc:c', today: '2026-08-31' })).toEqual({ src: 'cc:c' })
  })
})
