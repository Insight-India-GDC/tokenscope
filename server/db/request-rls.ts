/*
 * withRequestRls — bind the current request's session to a transaction
 * with the four RLS GUCs set, then run a body inside it.
 *
 * Pattern: every API handler that hits user-scoped data wraps the DB
 * call in withRequestRls(event, async (tx) => ...). The transaction
 * uses SET LOCAL so the GUCs are gone the moment the body returns.
 *
 * For pre-Epic-4 endpoints that don't yet have a real Nitro event (e.g.
 * tests, workers), use server/db/rls.ts::withRlsContext directly.
 */
import type { H3Event } from 'h3'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import type * as schema from '../../drizzle/schema'
import { getDb } from './index'
import { requireAuth } from '../utils/auth'
import { withRlsContext, type RlsIsolation, rlsRoleFor } from './rls'

export async function withRequestRls<T>(
  event: H3Event,
  fn: (tx: PostgresJsDatabase<typeof schema>) => Promise<T>,
  /**
   * READ-ONLY handlers only. See withRlsContext — 'repeatable read' makes every
   * query in the handler read one moment, which a handler comparing figures
   * derived from different bases needs and a writer must not take.
   */
  opts: { isolationLevel?: RlsIsolation } = {},
): Promise<T> {
  const session = await requireAuth(event)
  return withRlsContext(
    getDb(),
    {
      userRegionId: session.regionId,
      userOrgPath: session.orgPath,
      // platform-admin → global-finops at the RLS layer; see rlsRoleFor.
      userRole: rlsRoleFor(session.role),
      userTeammateId: session.teammateId,
      // Persona override: the session above is the PERSONA; this names the real
      // admin so recordAuditEvent can record it (mig 0154). Undefined otherwise.
      impersonatorOid: session.impersonatorOid ?? null,
    },
    fn,
    opts,
  )
}
