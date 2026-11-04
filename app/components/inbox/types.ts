/*
 * Shared types and the per-kind drawer-body routing function for the
 * inbox UI. Extracted out of InboxDrawer.vue so the routing logic is
 * unit-testable without mounting the component.
 */

export interface InboxItem {
  id: string
  category: string
  severity: 'info' | 'attention' | 'urgent'
  subject: string
  body: Record<string, unknown>
  related_entity_kind: string | null
  related_entity_id: string | null
  /*
   * Server-resolved navigation target for the "Open project" affordance.
   * When related_entity_kind='project', this is the id of the project's
   * currently-effective baseline allocation. Null if no such allocation
   * exists or the related entity is not a project.
   */
  target_allocation_id: string | null
  /*
   * Server-resolved target for "Open project →": the project's code, emitted
   * only when this recipient can open /projects/{code}. Null otherwise.
   */
  target_project_code: string | null
  ack_state: 'unread' | 'read' | 'acknowledged' | 'dismissed' | 'resolved'
  ack_at: string | null
  created_at: string
}

export type DrawerBodyVariant =
  | 'over-budget'
  | 'velocity'
  | 'sync-conflict'
  | 'untagged'
  | 'personal-subscription'
  | 'over-emission'
  | 'project-request'
  | 'budget-request'
  | 'generic'

export function variantForCategory(category: string): DrawerBodyVariant {
  switch (category) {
    case 'over-budget':
      return 'over-budget'
    case 'velocity-warning':
      return 'velocity'
    case 'sync-conflict':
    case 'structural-conflict':
      return 'sync-conflict'
    case 'untagged-backlog':
      return 'untagged'
    case 'personal-subscription-prompt':
      return 'personal-subscription'
    case 'over-emission-escalated':
      return 'over-emission'
    case 'project-request':
    case 'project-request-decided':
      return 'project-request'
    case 'quota-request':
    case 'quota-request-decided':
      return 'budget-request'
    default:
      return 'generic'
  }
}

/** The words a person reads for a category; an unlisted one shows its raw key. */
export function categoryLabel(category: string): string {
  switch (category) {
    case 'over-budget':
      return 'Over budget'
    case 'velocity-warning':
      return 'Velocity'
    case 'sync-conflict':
      return 'Sync conflict'
    case 'untagged-backlog':
      return 'Untagged'
    case 'structural-conflict':
      return 'Structural'
    case 'connector-health':
      return 'Connector'
    case 'over-emission-escalated':
      return 'Over-emission'
    case 'project-request':
      return 'Project request'
    case 'project-request-decided':
      return 'Project decision'
    case 'quota-request':
      return 'Budget request'
    case 'quota-request-decided':
      return 'Budget decision'
    default:
      return category
  }
}
