/*
 * useDrillContract — the two things every reports surface needs before it can
 * render a name: WHICH doors this caller holds, and WHERE the reader currently
 * is (developer pages build D29/D30).
 *
 * Both are read here rather than threaded through a dozen props, because the
 * decision has to be identical on every surface: a name that links on the
 * cost-centre drill and reads as text on the regional table is the drift the
 * one-rule contract exists to remove.
 */
import { computed, type ComputedRef } from 'vue'
import {
  NO_DRILL_GRANTS,
  type DrillFrame,
  type DrillGrants,
} from '../components/reporting/drill-contract'
// Imported explicitly, not auto-imported: this module is pulled into component
// unit tests that mount without Nuxt's auto-import layer, and a composable that
// only resolves inside the app is a composable the tests cannot exercise.
import { useReportState } from './useReportState'


interface DrillMetaResp {
  drill?: { teammate: DrillGrants['teammate']; project: DrillGrants['project'] }
}

/**
 * The caller's drill grants, from `/reports/meta`.
 *
 * SAME `key` as the reporting shell's own bootstrap fetch, so a deep component
 * asking this question joins the shell's payload instead of issuing a second
 * request per table.
 *
 * FAIL-CLOSED while it is in flight or if it errors: nothing is a door until the
 * server has said which doors exist. The opposite default would flash live links
 * on first paint and then retract them.
 */
export function useDrillGrants(): ComputedRef<DrillGrants> {
  const { data } = useFetch<DrillMetaResp>('/api/v1/reports/meta', {
    key: 'reports-meta',
    retry: false,
  })
  return computed(() => {
    const d = data.value?.drill
    return d ? { teammate: d.teammate, project: d.project } : NO_DRILL_GRANTS
  })
}

/**
 * The WINDOW a drill from this surface carries, read from `useReportState` — the
 * sole owner of those keys — so a link can never carry a window different from
 * the figures beside it.
 *
 * The scope TOKEN is not here: it is a property of the SURFACE (which cost
 * centre, which region), and several surfaces render more than one at once. It
 * is built where the rows are, from the payload those rows came in.
 *
 * Called by the CONTAINERS (ScopeRegional / ScopeAcrossRegions /
 * ScopeCostCentre / ScopeFinance) and passed DOWN as a prop. The presentational
 * views take it as a prop with a fail-closed default so they stay mountable
 * without a Nuxt context — the same container/view split every fetch on this
 * surface already follows.
 */
export function useDrillWindow(): ComputedRef<Omit<DrillFrame, 'src'>> {
  const rs = useReportState()
  // The server's day names the DEFAULT window (no `month`/`from`/`to` in the
  // URL); the browser clock never does. Auto-imported, so a unit test pins it
  // with `stubServerClock`.
  const { today } = useServerClock()
  return computed(() => ({
    month: rs.month.value,
    from: rs.from.value,
    to: rs.to.value,
    today: today.value,
  }))
}
