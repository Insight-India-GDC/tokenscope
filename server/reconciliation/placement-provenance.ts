/*
 * placement-provenance — the vocabulary for "this home was DERIVED, and here is
 * what derived it", as one module rather than a string literal per call site.
 *
 * WHY IT MATTERS. `teammate.metadata.placedVia` is not decoration: it is the flag
 * that decides whether a later pass may re-derive someone. A derived placement
 * (manager chain, or a curated attribute rule) is a standing inference and must
 * follow the configuration when the configuration changes — that is exactly what
 * spec C7's "Re-resolve placement" applies. An ADMIN placement is an assertion
 * and must NOT be re-derived, which is why server/db/place-teammate.ts strips
 * these keys on every manual move.
 *
 * So the set of derived kinds is the re-resolve candidate set, and the key list
 * is what a manual placement must clear. Both were previously spelled out as
 * literals in four files; adding the mig-0112 rule kind to three of them and
 * missing the fourth would have left rule-placed teammates permanently frozen
 * (never re-derived) or admin placements silently re-derived away.
 */
import { sql, type SQL } from 'drizzle-orm'
import { HOLDING_UNIT_TYPE } from '../../shared/placement/holding-nodes'
import { rehomeSafePredicate } from './rehome-safety'

/** Placed by the Entra manager-chain walk → a cost-owning unit. */
export const PLACED_VIA_MANAGER_CHAIN = 'manager-chain'

/** Placed by a curated directory-attribute rule naming a unit (mig 0112). */
export const PLACED_VIA_ATTRIBUTE_RULE = 'attribute-rule'

/**
 * Placed by an admin applying a placement-check proposal. NOT derived: an admin
 * confirmed it, so no worker re-derives it; the next check reports any drift.
 * It also keeps the home out of manualPlacementSql (it carries `placedVia`).
 */
export const PLACED_VIA_PLACEMENT_CHECK = 'placement-check'

/**
 * First sign-in homes: a REGION the directory derived (on its Unplaced node), or
 * the default region when the directory gave nothing in time. Recorded so the
 * placement check can say so; not re-derivable kinds, since a signed-in person
 * is never moved automatically. A unit derived at sign-in records the derived
 * kind (manager-chain / attribute-rule) instead.
 */
export const PLACED_VIA_JIT_DIRECTORY = 'jit-directory'
export const PLACED_VIA_JIT_DEFAULT = 'jit-default'

/**
 * Every DERIVED placement kind — i.e. every value of `metadata.placedVia` whose
 * holder may be re-derived by a later pass. An admin placement has no
 * `placedVia` at all and is therefore never in this set.
 */
export const DERIVED_PLACEMENT_VIAS = [PLACED_VIA_MANAGER_CHAIN, PLACED_VIA_ATTRIBUTE_RULE] as const

export type DerivedPlacementVia = (typeof DERIVED_PLACEMENT_VIAS)[number]

/**
 * THE re-enrichment candidate predicate: a rehome-safe teammate (no live
 * credential; rehomeSafePredicate) who is EITHER on a holding node OR placed by a
 * derivation (a DERIVED_PLACEMENT_VIAS provenance). `t` is the teammate, `ou` its
 * CURRENT org_unit. One definition, used by the worker's selection
 * (server/workers/region-reenrichment.ts) and re-applied by its compare-and-set
 * write (placeTeammateIfStillSelected): an admin move that ends on the very unit
 * the person was selected on (U → V → U) leaves the unit unchanged but strips
 * the provenance, and only this predicate can see that.
 */
export function reenrichmentCandidatePredicate(t: SQL, ou: SQL): SQL {
  return sql`((${ou}.unit_type = ${HOLDING_UNIT_TYPE} OR ${t}.metadata->>'placedVia' IN ${[...DERIVED_PLACEMENT_VIAS]})
    AND ${rehomeSafePredicate(t)})`
}

/**
 * The metadata keys a placement provenance occupies. A manual placement strips
 * ALL of them; a derived placement rewrites them wholesale. Listed once so a new
 * key cannot be written by the setter and left behind by the stripper.
 */
export const PLACEMENT_PROVENANCE_KEYS = [
  'placedVia',
  'placedOwnerOid',
  'placedAttribute',
  'placedStep',
  'placedAt',
] as const

/** The provenance keys present in `metadata`, as strings; null when none is. */
export function provenanceOf(metadata: unknown): Record<string, string> | null {
  if (!metadata || typeof metadata !== 'object') return null
  const out: Record<string, string> = {}
  for (const k of PLACEMENT_PROVENANCE_KEYS) {
    const v = (metadata as Record<string, unknown>)[k]
    if (v !== undefined && v !== null) out[k] = String(v)
  }
  return Object.keys(out).length > 0 ? out : null
}

/**
 * The audit event type for a teammate's org_unit changing. ONE type for every
 * writer that moves someone (the admin per-row and bulk doors in
 * server/db/place-teammate.ts, and the re-enrichment worker's compare-and-set
 * move): it is the same fact, told apart by `actorSystem`.
 */
export const PLACEMENT_AUDIT_EVENT = 'teammate-org-unit-changed'

/**
 * The audit event type for a DERIVED teammate's provenance changing while their
 * org_unit does not (the re-enrichment worker's provenance-only write: a
 * different owner or attribute now derives the same unit). Written only when the
 * provenance actually differs, so an unchanged re-derivation adds no row.
 */
export const PLACEMENT_PROVENANCE_AUDIT_EVENT = 'teammate-placement-provenance-changed'

/** What derived this home. Discriminated so each kind carries only its own facts. */
export type PlacementProvenance =
  | { via: typeof PLACED_VIA_MANAGER_CHAIN; ownerOid: string }
  | { via: typeof PLACED_VIA_ATTRIBUTE_RULE; attribute: string }

/**
 * `- 'placedVia' - 'placedOwnerOid' - …` for every provenance key, to append to a
 * jsonb expression. Both the derived writer (which rewrites provenance and must
 * not leave a previous kind's key behind) and the manual placement (which erases
 * it) build their SQL from this one list.
 */
export function stripProvenanceKeys(): SQL {
  return sql.join(
    PLACEMENT_PROVENANCE_KEYS.map((k) => sql`- ${k}::text`),
    sql` `,
  )
}
