import { pgTable, uuid, text, timestamp, primaryKey, index } from 'drizzle-orm/pg-core'
import { instanceAttestation } from './instance-attestation'

/*
 * session_instance_report (migration 0166, #494) — "Claude session S runs on
 * instance I", reported by that install's SessionStart hook with its own emit
 * credential (POST /api/v1/instances/{instanceId}/claude-sessions).
 *
 * The read-joiner books a session's rows to the reported instance when it is
 * the same teammate's as the instance the record names, so Claude Code CLI and
 * Claude Desktop opening one tagged repo each keep their own device
 * (docs/design/session-instance-report.md). No teammate_id: it comes through
 * instance_attestation.
 */
export const sessionInstanceReport = pgTable(
  'session_instance_report',
  {
    claudeSessionId: text('claude_session_id').notNull(),
    instanceId: uuid('instance_id')
      .notNull()
      .references(() => instanceAttestation.instanceId),
    reportedAt: timestamp('reported_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.claudeSessionId, t.instanceId] }),
    index('session_instance_report_instance_t').on(t.instanceId, t.reportedAt),
  ],
)
