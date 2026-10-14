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
    default:
      return 'generic'
  }
}
