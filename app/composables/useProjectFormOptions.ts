/*
 * Shared inputs for the project create and request forms: the Business Units
 * a non-admin may pick (GET /api/v1/pickers/business-units) and the default
 * budget period, derived from the SERVER's today (never the browser clock).
 */
import { computed } from 'vue'
import { shiftUtcDay, utcMonthEnd } from '#shared/reports/clock'

export interface PickerUnit {
  id: string
  display_name: string
  path: string
  region_id: string
  region_code: string
  region_name: string
}

export interface PickerRegion {
  id: string
  code: string
  name: string
}

/** The current UTC month as date-input values: its first day, and the first day of the next month (exclusive end). */
export function defaultBudgetPeriod(today: string): { from: string; to: string } {
  return { from: `${today.slice(0, 8)}01`, to: shiftUtcDay(utcMonthEnd(today), 1) }
}

/** A `YYYY-MM-DD` date input as the UTC midnight instant the API takes. */
export function utcMidnight(day: string): string {
  return `${day}T00:00:00Z`
}

export interface ProjectCapabilities {
  /** On the PMO list (Admin → Project managers). */
  can_create_projects: boolean
  /** The own-region switch: a PMO holder may create only in `region_id`. */
  pm_own_region_only: boolean
  region_id: string
}

/** GET /api/v1/me/capabilities — a UI hint; the create route decides. */
export function useProjectCapabilities() {
  const { data } = useFetch<ProjectCapabilities | null>('/api/v1/me/capabilities', {
    key: 'me-capabilities',
    default: () => null,
  })
  return { capabilities: data }
}

export function useBusinessUnits() {
  const { data, error, pending } = useFetch<{ units: PickerUnit[]; my_unit_id: string | null }>(
    '/api/v1/pickers/business-units',
    { key: 'picker-business-units', default: () => ({ units: [], my_unit_id: null }) },
  )
  const units = computed(() => data.value?.units ?? [])
  const regions = computed<PickerRegion[]>(() => {
    const seen = new Map<string, PickerRegion>()
    for (const u of units.value) {
      if (!seen.has(u.region_id)) seen.set(u.region_id, { id: u.region_id, code: u.region_code, name: u.region_name })
    }
    return [...seen.values()]
  })
  const myUnitId = computed(() => data.value?.my_unit_id ?? null)
  return { units, regions, myUnitId, error, pending }
}
