/*
 * useProjectCreate — create a project, its PM and its baseline budget in ONE
 * atomic call (projects/new.vue). Admins post to /admin/projects, PMO-list
 * holders to /projects; both take the same body. A refusal from the server
 * leaves nothing behind, so a retry simply resubmits. A failure with no answer
 * (network, 5xx) may have created the project: outcomeUnknown says so.
 */
import { ref } from 'vue'
import { apiErrorDetail, isConfirmedRejection } from './useApiError'

export interface ProjectCreateBody {
  code: string
  display_name: string
  type: string
  region_id: string
  cost_owning_unit_id: string
  /** Optional finance-system WBS code (correlation only). */
  wbs_code?: string
  end_date?: string
  /** Required by the PMO route; optional for admins. */
  pm_teammate_id?: string
  budget: { amount_usd: string; from: string; to: string }
}

export type ProjectCreateRoute = 'admin' | 'pmo'

export interface ProjectCreated {
  id: string
  code: string
  allocation_id: string
}

/**
 * Where to go after a create. An admin route lands on the new baseline. On the
 * PMO route the project page opens only for members, and the creator is one
 * only when they named themselves PM: anyone else goes back to My projects,
 * which names the project it created.
 */
export function afterCreatePath(
  route: ProjectCreateRoute,
  created: ProjectCreated,
  who: { pmId: string | null; viewerId: string | null },
): string {
  if (route === 'admin') return `/allocations/${created.allocation_id}`
  if (who.pmId !== null && who.pmId === who.viewerId) return `/projects/${encodeURIComponent(created.code)}`
  return `/projects?created=${encodeURIComponent(created.code)}`
}

type PostFn =<T>(url: string, body: Record<string, unknown>) => Promise<T>

export const PROJECT_CREATE_URL: Record<ProjectCreateRoute, string> = {
  admin: '/api/v1/admin/projects',
  pmo: '/api/v1/projects',
}

export function useProjectCreate(deps?: { post?: PostFn }) {
  // Injectable for unit tests; defaults to $fetch in the app.
  const post: PostFn =
    deps?.post ??
    (<T,>(url: string, body: Record<string, unknown>) =>
      $fetch<T>(url, { method: 'POST', body }) as Promise<T>)

  const submitting = ref(false)
  const error = ref<string | null>(null)
  /** The last failure had no server refusal behind it, so the project may exist. */
  const outcomeUnknown = ref(false)

  /** The created project on success, null on failure (inspect `error`). */
  async function submit(route: ProjectCreateRoute, body: ProjectCreateBody): Promise<ProjectCreated | null> {
    if (submitting.value) return null
    submitting.value = true
    error.value = null
    outcomeUnknown.value = false
    try {
      return await post<ProjectCreated>(PROJECT_CREATE_URL[route], { ...body })
    } catch (err) {
      outcomeUnknown.value = !isConfirmedRejection(err)
      error.value = apiErrorDetail(err, 'Project create failed.')
      return null
    } finally {
      submitting.value = false
    }
  }

  return { submitting, error, outcomeUnknown, submit }
}
