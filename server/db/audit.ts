/*
 * recordAuditEvent — the canonical write into audit_event.
 *
 * Per AGENTS.md §Audit events: handlers MUST go through this helper, never
 * insert directly into audit_event. The append-only trigger on audit_event
 * (drizzle/migrations/0001_schema.sql) means a row, once written, cannot
 * be UPDATEd or DELETEd — so the helper is the only allocation point.
 *
 * THE HANDLE MUST CARRY AN RLS IDENTITY (docs/design/rls-enforcement.md §4).
 * `audit_event` has an RLS policy, and `recordAuditEvent(getDb(), …)` — the
 * global pool, no GUCs — was the single most common leak in server/api/**:
 * handlers that wrapped their MAIN work in `withRequestRls` and then wrote the
 * audit row outside it. Under `FORCE ROW LEVEL SECURITY` every one of those
 * INSERTs errors, so the handler 500s AFTER doing its work. Pass:
 *   - a request handler → the `tx` from `withRequestRls(event, …)`
 *   - a machine/credential handler → the `tx` from `withMachineRls(…)`
 *   - a worker → its own handle, which comes from the worker pool
 * `scripts/check-handler-rls-context.mjs` is the CI guard for the first case.
 *
 * Named after a sibling project's `lib/audit/` pattern (R2 F3 of the build plan).
 */
import net from 'node:net'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { sql } from 'drizzle-orm'
import { auditEvent } from '../../drizzle/schema'

/*
 * THE REAL ACTOR UNDER PERSONA OVERRIDE (mig 0154). An override rewrites the
 * request session to the persona, so actor_teammate_id names the persona. The
 * admin behind it reaches this helper through the transaction-local GUC
 * `app.impersonator_oid`, which withRequestRls → applyRlsContext sets from
 * Session.impersonatorOid — one place, so no caller can forget to pass it and
 * no caller can claim one. A handle that never set it (machine lane, worker,
 * a test's bare db) reads NULL/'' and writes NULL.
 */
const IMPERSONATOR_FROM_TX = sql`NULLIF(current_setting('app.impersonator_oid', true), '')`

/*
 * Every audit event names its actor (SYS-3, robustness-review-2026-06-09):
 * either the teammate who acted or an explicit system identity (worker /
 * flow name). Omitting both is how forensically-blind rows like the
 * actor-less project-member-added events (API-3) slipped through — so the
 * union makes that a type error rather than a convention.
 */
export type AuditActor =
  | { actorTeammateId: string; actorSystem?: string | null }
  | { actorSystem: string; actorTeammateId?: string | null }

export type AuditEventInput = {
  eventType: string
  subjectKind?: string | null
  subjectId?: string | null
  payload: Record<string, unknown>
  ipAddress?: string | null
  userAgent?: string | null
} & AuditActor

/**
 * Coerce a client address into something the `inet` column accepts. h3's
 * getRequestIP can return `host:port` (dev's WAF forwards the source port in
 * X-Forwarded-For, e.g. `10.80.12.36:46306`), and `inet` rejects a port — which
 * 500s the whole request. Strip the port (IPv4 + bracketed IPv6), and null
 * anything that still isn't a bare IP, since the audit IP is best-effort and
 * must never crash the operation it's recording.
 */
export function normalizeInet(ip: string | null | undefined): string | null {
  if (!ip) return null
  const s = String(ip).trim()
  // Capture ANY bracket contents and let net.isIP below judge them. A charset
  // here is a second, weaker parser: [0-9a-fA-F:]+ excludes dots, so the valid
  // IPv4-mapped `[::ffff:192.0.2.1]:443` was discarded as malformed.
  const v6 = s.match(/^\[([^\]]+)\](?::\d+)?$/) // [::1]:443 -> ::1
  const v4 = s.match(/^(\d{1,3}(?:\.\d{1,3}){3}):\d+$/) // 10.0.0.1:443 -> 10.0.0.1
  const candidate = v6?.[1] ?? v4?.[1] ?? s
  /*
   * VALIDATE, never shape-match, and REJECT ZONE IDS. Both are load-bearing: a
   * shape test accepts 999.999.999.999 and `deadbeef`, and net.isIP alone
   * accepts `fe80::1%eth0` — `inet` refuses all three, the INSERT throws, and
   * two callers swallow it. The value is a client-set header, so either gap
   * lets a request suppress the audit row recording its own refusal.
   * See docs/security-sprint/epic-mdash-remediation.md (W2.1).
   */
  if (candidate.includes('%')) return null
  return net.isIP(candidate) !== 0 ? candidate : null
}

/**
 * @param tx an RLS-bearing handle — a `withRequestRls` / `withMachineRls`
 *           transaction, or a worker-pool handle. NEVER the bare `getDb()`
 *           pool from inside a request handler (see the file header).
 */
export async function recordAuditEvent(
  tx: PostgresJsDatabase<Record<string, unknown>>,
  input: AuditEventInput,
): Promise<{ id: string }> {
  const [row] = await tx
    .insert(auditEvent)
    .values({
      eventType: input.eventType,
      actorTeammateId: input.actorTeammateId ?? null,
      actorSystem: input.actorSystem ?? null,
      subjectKind: input.subjectKind ?? null,
      subjectId: input.subjectId ?? null,
      payload: input.payload,
      ipAddress: normalizeInet(input.ipAddress),
      userAgent: input.userAgent ?? null,
      impersonatorOid: IMPERSONATOR_FROM_TX,
    })
    .returning({ id: auditEvent.id })

  if (!row) {
    throw new Error('recordAuditEvent: insert returned no row')
  }
  return { id: row.id }
}
