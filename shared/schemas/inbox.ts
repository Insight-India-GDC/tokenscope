import { z } from 'zod'

export const INBOX_CATEGORIES = [
  'sync-conflict',
  'velocity-warning',
  'over-budget',
  'untagged-backlog',
  'over-attribution',
  'structural-conflict',
  'connector-health',
  'personal-subscription-prompt',
  'over-emission-escalated',
] as const

export const INBOX_SEVERITIES = ['info', 'attention', 'urgent'] as const

/**
 * ADMIN-ROUTED categories whose items carry report data (a named teammate's
 * spend, an org's billed dollars). An admin with an active report-access deny
 * ('revoke-all', mig 0130) is not sent them, does not see delivered ones while
 * the deny is active, and cannot forward or be forwarded one. Not covered:
 * over-budget, which goes to project managers and BU owners by project role;
 * and a notice skipped during a deny is not re-sent when it is lifted.
 */
export const REPORT_DATA_INBOX_CATEGORIES: readonly string[] = [
  'over-emission-escalated',
  'copilot-bill-unsettled',
  'copilot-bill-unclassified',
]

export const INBOX_ACK_STATES = ['unread', 'read', 'acknowledged', 'dismissed', 'resolved'] as const

export const InboxListQuery = z.object({
  ack_state: z
    .enum(['unread', 'read', 'acknowledged', 'dismissed', 'resolved', 'open', 'closed'])
    .optional(),
  category: z.enum(INBOX_CATEGORIES).optional(),
  severity: z.enum(INBOX_SEVERITIES).optional(),
  limit: z.coerce.number().int().positive().max(200).default(50),
})
export type InboxListQuery = z.infer<typeof InboxListQuery>

export const InboxPatchBody = z.object({
  ack_state: z.enum(INBOX_ACK_STATES),
})
export type InboxPatchBody = z.infer<typeof InboxPatchBody>

export const InboxRouteBody = z.object({
  recipient_teammate_id: z.string().uuid(),
  reason: z.string().min(1).max(500).optional(),
})
export type InboxRouteBody = z.infer<typeof InboxRouteBody>
