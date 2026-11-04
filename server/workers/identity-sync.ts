/*
 * identity-sync worker — daily. Runs each registered per-provider identity
 * resolver to seed teammate_identity_map from the provider directory (GitHub:
 * seats + SCIM/SAML -> github_login -> SSO email -> teammate). Covers every
 * licensed seat irrespective of client install. See docs/design/reconciliation-engine.md §10.
 *
 * Phase 0: IDENTITY_RESOLVERS is empty -> clean no-op (resolversRun: 0). Stream A
 * registers the Anthropic resolver; Stream B the GitHub one.
 */
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import type * as schema from '../../drizzle/schema'
import { IDENTITY_RESOLVERS } from '../reconciliation/adapters/registry'
import { describeError } from '../utils/redact-probe-error'

type Db = PostgresJsDatabase<typeof schema>

export interface IdentitySyncResult {
  resolversRun: number
  resolversErrored: number
  upserts: number
}

export async function runIdentitySync(db: Db): Promise<IdentitySyncResult> {
  const result: IdentitySyncResult = { resolversRun: 0, resolversErrored: 0, upserts: 0 }
  for (const resolver of IDENTITY_RESOLVERS) {
    try {
      const r = await resolver(db)
      result.upserts += r.upserts
      result.resolversRun += 1
    } catch (err) {
      // Isolate one bad resolver so it cannot starve the others (matches the
      // per-scope isolation in reconciliation-sync); surfaced for observability.
      result.resolversErrored += 1
      console.warn(`[identity-sync] resolver failed: ${describeError(err)}`)
    }
  }
  return result
}
