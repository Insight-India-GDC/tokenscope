/*
 * drill-contract — "link or plain text BY GRANT, never a live-looking dead
 * button" (developer pages build D29/D30, fix 7), in ONE place.
 *
 * Every teammate/project name on a reports surface routes its decision through
 * here, and here routes it through the two EXPORTED POLICY RULES
 * (`shared/auth/report-visibility.ts`, D38). No view decides for itself: a
 * per-view `v-if` on a grant is how one surface eventually offers a door another
 * surface 403s, which is the defect the contract exists to remove (r1-H4).
 *
 * ── THE TWO RULES ARE NOT ONE ───────────────────────────────────────────────
 * `namedContributionRow` decides whether a subject may be NAMED; this module
 * decides whether that name is a LINK. A name can be named and still be plain
 * text — a project member sees their team-mates named on the member-depth table
 * and holds no reports grant at all, so none of those names is a door.
 *
 * ── WHAT RIDES THE LINK (D30) ───────────────────────────────────────────────
 * `?src=` (the entry scope token) plus the entry WINDOW in the report vocabulary
 * (`month` XOR `from`/`to`). The target echoes both in its provenance line and
 * reconstructs the entry report URL for its breadcrumb — never `history.back()`,
 * which breaks on refresh and on a shared link.
 */
import type { RouteLocationRaw } from 'vue-router'
import {
  teammateDrillAdmission,
  type DrillWindow,
  type ReportScopeGrants,
} from '#shared/auth/report-visibility'
import { utcMonthOf } from '#shared/reports/clock'

/** The grants subset the contract needs. Fail-closed when meta has not loaded. */
export interface DrillGrants {
  teammate: ReportScopeGrants['teammate']
  project: ReportScopeGrants['project']
}

/** Nothing is a door until the server has said which doors this caller holds. */
export const NO_DRILL_GRANTS: DrillGrants = { teammate: false, project: 'membership' }

/**
 * The entry state a drill carries: which of the viewer's grants framed the view,
 * and the window it was read at.
 */
export interface DrillFrame {
  /** `cc:{id}` / `region:{id}` / `across` / `finance`, or null on a frameless surface. */
  src: string | null
  month?: string | null
  from?: string | null
  to?: string | null
  /**
   * The SERVER's UTC day (`useServerClock().today`), read ONLY to name the
   * default window when the frame carries no `month`/`from`/`to`. Never put on
   * the link: the destination re-resolves its own default from the same absent
   * keys. Absent or null (the clock has not landed) means the frame has no
   * window yet, and no teammate name is a link until it has one.
   */
  today?: string | null
}

export type DrillTarget =
  /** Navigate. The whole point of the contract: a real, openable URL. */
  | { kind: 'link'; to: RouteLocationRaw }
  /**
   * An IN-PAGE pivot, not a navigation — the regional practice drill (`?ou=`),
   * which re-frames the page it is already on. It keeps a button because it IS
   * an action; the contract's ban is on buttons that do NOTHING.
   */
  | { kind: 'action' }

/**
 * The window a frame is at, in the shape the admission rule takes. A frame with
 * no explicit window is at the CURRENT month, every report's own default, so the
 * rule is told that rather than told nothing.
 *
 * "Current" is the SERVER's month (`frame.today`), never the browser's: for
 * hours a day in APAC the browser's UTC month and the server's differ around a
 * month boundary, and the admission would then name a month the report is not
 * at (clock-and-day-boundary.md D3). With no server day yet the answer is "no
 * window", which the rule refuses, so names stay plain text until it lands.
 */
export function frameWindow(frame: DrillFrame): DrillWindow | null {
  if (frame.from && frame.to) return { from: frame.from, to: frame.to }
  const month = frame.month ?? (frame.today ? utcMonthOf(frame.today) : null)
  if (!month) return null
  return { from: `${month}-01`, to: `${month}-01` }
}

/** The query a drill link carries — src + the entry window, nothing else. */
export function drillQuery(frame: DrillFrame): Record<string, string> {
  const q: Record<string, string> = {}
  if (frame.src) q.src = frame.src
  if (frame.month) q.month = frame.month
  if (frame.from) q.from = frame.from
  if (frame.to) q.to = frame.to
  return q
}

/**
 * A TEAMMATE name → `/reporting/teammate/{id}`, or null (plain text).
 *
 * `hasInScopeWindowRow` DEFAULTS to `true` — on a scope-clamped report the row
 * was computed over exactly the predicate its `?src=` frame names, so the row's
 * own existence IS D34's in-frame evidence.
 *
 * IT IS NOT ALWAYS TRUE, AND THE DEFAULT IS NOT A LICENCE (r3-M4). A surface
 * whose rows are computed over a DIFFERENT predicate than the frame it carries
 * — the project reports depth, where naming is decided by the viewer's whole
 * PEOPLE scope while the link carries one `?src=` frame — must pass the
 * SERVER-RESOLVED value. Assuming `true` there produced the exact defect this
 * module exists to prevent: a contributor named through CC-B, linked with
 * `src=cc:A`, whose destination correctly 403s.
 *
 * `isActive` and `isProvisional` cannot be inferred and must be carried on the
 * row: a deactivated subject and an unconfirmed shadow identity both 403 at the
 * endpoint, so linking either is a live-looking dead button.
 *
 * BOTH ARE REQUIRED — `isProvisional` USED to default to `false`, justified as
 * "every manager-facing figure these surfaces render already excludes
 * provisional rows". That justification was false on three surfaces at once
 * (r5-H1: the regional signals strip, the cost-centre soft-cap card, the finance
 * overage drivers), and the default is what made the omission SILENT: a producer
 * that forgot the fact still compiled, and the missing fact ADMITTED the drill.
 * A security conjunct with a permissive default is a conjunct a new call site
 * can forget, so this signature no longer lets it. The server-side facts come
 * from `server/reporting/teammate-drill-facts.ts`, and
 * `tests/unit/server/teammate-drill-facts-contract.test.ts` enumerates every
 * call site of this function so a new one fails loudly.
 */
export function teammateDrillTarget(
  grants: DrillGrants,
  subject: {
    id: string | null
    /**
     * REQUIRED KEYS, `undefined` VALUES ALLOWED. Writing `boolean | undefined`
     * rather than `boolean?` keeps the compiler's "you must decide" — the key
     * cannot be forgotten — while letting a caller pass a fact its payload did
     * not carry. The absence then fails closed HERE, once, instead of each
     * call site collapsing it to `false` and re-opening the door.
     */
    isActive: boolean | undefined
    /** Server-resolved for THIS frame + window. Omit only where the row's own predicate IS the frame. */
    hasInScopeWindowRow?: boolean
    /** REQUIRED. See above — a default here is how three surfaces shipped a dead link. */
    isProvisional: boolean | undefined
  },
  frame: DrillFrame,
): DrillTarget | null {
  const decision = teammateDrillAdmission(
    { grants },
    {
      id: subject.id,
      hasInScopeWindowRow: subject.hasInScopeWindowRow ?? true,
      // BOTH facts fail CLOSED at runtime, not just in the type. The fields are
      // declared required, but a type is a promise about SOURCE — a cached body
      // or a rolling deploy can hand this function a row that predates them.
      // `isActive === true` and `isProvisional !== false` mean an absent fact
      // reads as "inactive, unconfirmed" and plain-texts the row. Reading
      // absence as `false` is how a shadow identity gets a door that 403s.
      isActive: subject.isActive === true,
      isProvisional: subject.isProvisional !== false,
    },
    { src: frame.src, held: true },
    // The window is CARRIED here, not verified — the server re-resolves it from
    // the same query keys. A surface showing its own default window carries no
    // `month`/`from`/`to` in the URL yet is still windowed, so the default is
    // named rather than treated as "no window" (which would plain-text every row
    // on every unparameterised report).
    frameWindow(frame),
  )
  if (!decision.admit) return null
  return {
    kind: 'link',
    to: { path: `/reporting/teammate/${encodeURIComponent(subject.id!)}`, query: drillQuery(frame) },
  }
}

/**
 * A PROJECT name → `/projects/{code}`, or null (plain text).
 *
 * The project rule is the grant column, not the teammate one: a viewer admitted
 * `member-in-scope` or `region-wide` reaches the reports-depth arm of the
 * project page (D37), so the link always opens onto something.
 *
 * A `'membership'`-only viewer gets PLAIN TEXT on a reports surface even for a
 * project they are a member of. That is deliberate: membership is unknown here
 * (the reports lane has no reason to query `project_assignment` per row), and a
 * link that opens for some rows and 404s for others is worse than a name. Their
 * own projects are one click away on `/projects`, which IS the membership list.
 */
export function projectDrillTarget(
  grants: DrillGrants,
  code: string | null,
  frame: DrillFrame,
): DrillTarget | null {
  if (!code) return null
  if (grants.project !== 'member-in-scope' && grants.project !== 'region-wide') return null
  return {
    kind: 'link',
    to: { path: `/projects/${encodeURIComponent(code)}`, query: drillQuery(frame) },
  }
}

/**
 * Reconstruct the ENTRY report URL from a carried frame (D30) — what the drill
 * target's breadcrumb links back to.
 *
 * Built from state, never `history.back()`: a reader who refreshed, or who
 * opened the link someone pasted them, has no history to go back through, and a
 * breadcrumb that silently does nothing is the same broken promise as a dead
 * button.
 */
export function entryReportRoute(frame: DrillFrame): RouteLocationRaw {
  const query: Record<string, string> = {}
  if (frame.month) query.month = frame.month
  if (frame.from) query.from = frame.from
  if (frame.to) query.to = frame.to
  const src = frame.src ?? ''
  if (src.startsWith('cc:')) {
    query.scope = 'cost-centre'
    query.cc = src.slice(3)
  } else if (src.startsWith('region:')) {
    query.scope = 'region'
    query.region = src.slice('region:'.length)
  } else if (src === 'across') {
    query.scope = 'region'
    query.region = 'all'
  } else if (src === 'finance') {
    query.scope = 'finance'
  }
  return { path: '/reporting', query }
}

/*
 * Driver rows carry the identity facts as STRING dims, and a dim can simply be
 * absent — a cached body, a rolling deploy, a producer that predates the field.
 * `dims?.x === 'true'` turns that absence into `false`, which for
 * `teammate_provisional` reads as "confirmed" and re-opens the door the rule
 * closes. These two keep the unknown as `undefined` so the fail-closed default
 * in `teammateDrillAdmission` is what decides (r8-H1).
 */
export function dimFact(
  dims: Record<string, string | null> | undefined,
  key: string,
): boolean | undefined {
  const raw = dims?.[key]
  // NULL is as unknown as absent — a producer that emitted the column but had
  // nothing to say is not asserting 'false'.
  return raw == null ? undefined : raw === 'true'
}
