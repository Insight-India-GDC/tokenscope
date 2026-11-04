/*
 * Adapter & identity-resolver registration seams — the ONLY shared edit point
 * between the two concurrent streams (Stream A = Anthropic, Stream B = GitHub).
 *
 * Each provider registers by one line below (a 1-line add to a known list; no
 * other foundation file changes). The reconciliation-sync / identity-sync
 * workers iterate over whatever is registered. Registered today: the Anthropic
 * and GitHub adapters, and the GitHub identity resolver. A provider with no
 * entry here is a clean no-op for that worker.
 */
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import type * as schema from '../../../drizzle/schema'
import type { Adapter, ReconcileProvider } from '../types'
import type { ResolvedCredential } from '../credentials'
import { createAnthropicAdapter } from './anthropic'
import { createGithubAdapter } from './github'
import { createGithubIdentityResolver } from './github-identity'

type Db = PostgresJsDatabase<typeof schema>

/** Which Anthropic API reconciles an org (provider_org.api_kind, mig 0063).
 *  github scopes carry null (Copilot has a single billing API). */
export type AnthropicApiKind = 'enterprise-analytics' | 'claude-code-admin'

/** The credential-bound scope an adapter instance reconciles (one org or enterprise). */
export interface AdapterScope {
  /** anthropic org id | github enterprise slug. */
  externalRef: string
  credential: ResolvedCredential
  /** Anthropic only: which API reconciles this org. The anthropic adapter BRANCHES
   *  on it (mig 0063). Null for github / when unthreaded (adapter defaults to the
   *  legacy 'claude-code-admin' path). See docs/design/reconciliation-engine.md §4.1. */
  apiKind?: AnthropicApiKind | null
}

export type AdapterFactory = (db: Db, scope: AdapterScope) => Adapter

/** Seeds teammate_identity_map from a provider directory (seats + SCIM/SAML). */
export type IdentityResolver = (db: Db) => Promise<{ provider: ReconcileProvider; upserts: number }>

/* Both streams' adapters are registered. */
export const ADAPTER_FACTORIES: Partial<Record<ReconcileProvider, AdapterFactory>> = {
  anthropic: createAnthropicAdapter,
  github: createGithubAdapter,
}

/*
 * GitHub resolver (seats + SCIM/SAML -> github_login -> teammate) is registered.
 * Anthropic has none: its usage rows carry the actor email, resolved at reconcile.
 */
export const IDENTITY_RESOLVERS: IdentityResolver[] = [createGithubIdentityResolver()]
