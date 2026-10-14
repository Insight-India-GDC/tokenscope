/*
 * Needs-tagging worklist — the shared contract for a BULK decision over the
 * queue. Design: docs/design/needs-tagging-worklist.md.
 *
 * One queue, two item kinds (a conversation and a provider-recorded day), three
 * decisions (tag / dismiss / restore). The client and the handler validate the
 * same shape, so the constants below — the batch cap and the de-minimis line the
 * "select the small ones" quick-selector uses — are single-sourced here.
 */
import { ACTIVITY_LABEL_MAX, displayText } from './display-text'
import { z } from 'zod'

/**
 * Ceiling on one bulk decision. Generous enough for "select every item on the
 * card" (the read lists cap at 100 per kind) while bounding the per-item tag
 * work — a tag is a full tagSessionTx per conversation, not one blanket UPDATE.
 */
export const WORKLIST_BULK_MAX_ITEMS = 200

/**
 * Per-kind cap on the worklist read lists (active AND dismissed). The month's
 * authoritative, uncapped totals come from /me/usage — these lists are the
 * ACTION surface, and a screen that offers more than this many items at once is
 * not a worklist, it is a wall.
 */
export const WORKLIST_LIST_LIMIT = 100

/**
 * The de-minimis line for the "select the small ones" quick-selector, USD.
 * Purely an ergonomic default for building a selection — it gates nothing,
 * hides nothing, and no decision is ever taken automatically because an item
 * falls under it.
 */
export const WORKLIST_SMALL_ITEM_USD = 0.1

export const WORKLIST_BULK_ACTIONS = ['tag', 'dismiss', 'restore'] as const
export type WorklistBulkAction = (typeof WORKLIST_BULK_ACTIONS)[number]

export const WorklistBulkBody = z
  .object({
    action: z.enum(WORKLIST_BULK_ACTIONS),
    /** Conversation keys (Claude's session.id; NOT uuids in our schema). */
    sessions: z.array(z.string().min(1).max(256)).default([]),
    /** unaccounted_usage row ids (§A per-day records). */
    unaccounted: z.array(z.string().uuid()).default([]),
    // Tag axes — action: 'tag' only. Same semantics as the single-item assign:
    // uuid = set, null = off budget / clear, omitted = preserve.
    project_id: z.string().uuid().nullable().optional(),
    // Same bound as every other activity writer: the label reaches agents (#1394).
    activity: z.union([displayText(ACTIVITY_LABEL_MAX, { trim: true }), z.null()]).optional(),
  })
  .superRefine((b, ctx) => {
    // Count DISTINCT items: the handler de-duplicates before applying, so a
    // selection of 201 ids holding 150 distinct ones is 150 items of work and
    // must not be rejected against a cap documented as bounding the work.
    const total = new Set(b.sessions).size + new Set(b.unaccounted).size
    if (total === 0) {
      // Batch-level, not field-level: an empty or oversized SELECTION is not the
      // `sessions` field's fault (it may be entirely unaccounted ids), and a
      // form keying errors by path would point at the wrong thing.
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [], message: 'select at least one item' })
    }
    if (total > WORKLIST_BULK_MAX_ITEMS) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [],
        message: `too many items in one action (max ${WORKLIST_BULK_MAX_ITEMS})`,
      })
    }
    if (b.action === 'tag') {
      // A bulk tag must actually SET something. Every item in the queue is
      // untagged by definition, so "clear both axes on 40 items" is a no-op
      // that would report success — reject it rather than lie.
      const setsProject = b.project_id != null
      const setsActivity = b.activity != null && b.activity !== ''
      if (!setsProject && !setsActivity) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['project_id'],
          message: 'pick a budget and/or an activity to tag with',
        })
      }
    } else if (b.project_id !== undefined || b.activity !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['action'],
        message: `project_id / activity apply to action 'tag' only`,
      })
    }
  })
export type WorklistBulkBody = z.infer<typeof WorklistBulkBody>

/** One untagged conversation on the worklist (GET /me/sessions/untagged). */
export interface WorklistSession {
  session_id: string
  instance_id: string | null
  first_event: string
  last_event: string
  tokens: number
  cost_usd: string
  /** Activity-only tag echoed back (mig 0020) — set but still project-untagged. */
  activity: string | null
  /** Which client emitted it (claude-code / copilot-cli). */
  tool: string
  models?: string[]
  by_model?: { model: string; tokens: number; cost_usd: string }[]
}

/**
 * One provider-recorded day: usage the provider's API counted that OTel never
 * captured (§A). The unit is a (teammate, day, tool) record — there is no
 * session id, which is why it is a separate group on the same worklist.
 */
export interface WorklistDay {
  id: string
  day: string
  tool: string
  cost_usd: string
  tokens: number
}

export interface WorklistResponse {
  sessions: WorklistSession[]
  unaccounted: WorklistDay[]
  /** Decided-and-left-unallocated. Out of the queue, restorable, spend unchanged. */
  dismissed: { sessions: WorklistSession[]; unaccounted: WorklistDay[] }
}

export interface WorklistBulkResult {
  action: WorklistBulkAction
  /** Distinct items the action applied to, per kind (duplicates collapsed). */
  sessions: number
  unaccounted: number
  total: number
}
