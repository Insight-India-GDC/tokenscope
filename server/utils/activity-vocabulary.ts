/*
 * The standard activity vocabulary (activity_type) as a GATE, for the folder
 * default the plugins emit as tokenscope.activity (#475). getActivityTypes
 * (me-queries.ts) is the picker's SUGGESTION list and merges the caller's own
 * free-form labels; this does not. An emitted label counts only if it names an
 * active entry that is global or belongs to the region, so a client or bid
 * name typed into a folder default never reaches storage.
 */
import { sql } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { ACTIVITY_LABEL_MAX, cleanDisplayText } from '../../shared/schemas/display-text'

type Exec = Pick<PostgresJsDatabase<Record<string, unknown>>, 'execute'>

/**
 * Display label for a vocabulary entry: title-case only entries that are ALL
 * lowercase (the lazily-seeded ones like 'research' -> 'Research'), preserving
 * any intentional mixed casing an admin chose (e.g. 'WorkIQ' stays 'WorkIQ').
 */
export function activityDisplayLabel(s: string): string {
  return s === s.toLowerCase() ? s.replace(/\b\w/g, (c) => c.toUpperCase()) : s
}

/** Lower-cased label → the label as stored: the spelling a tag picked from the picker stores. */
export type ActivityVocabulary = ReadonlyMap<string, string>

export async function loadActivityVocabulary(exec: Exec, regionId: string): Promise<ActivityVocabulary> {
  const rows = await exec.execute<{ label: string }>(sql`
    SELECT label FROM activity_type
     WHERE is_active = TRUE
       AND (region_id IS NULL OR region_id = ${regionId}::uuid)
     ORDER BY (region_id IS NULL) DESC, sort_order, lower(label)
  `)
  const out = new Map<string, string>()
  for (const r of rows) {
    const label = cleanDisplayText(activityDisplayLabel(r.label), ACTIVITY_LABEL_MAX)
    if (!label) continue
    // A global entry wins over a region's entry of the same name (ORDER BY above).
    const key = label.toLowerCase()
    if (!out.has(key)) out.set(key, label)
  }
  return out
}

/** The vocabulary's spelling of `emitted` (case-insensitive), or null when it is not a standard activity. */
export function matchActivityVocabulary(vocab: ActivityVocabulary, emitted: string | undefined): string | null {
  if (!emitted) return null
  return vocab.get(emitted.trim().toLowerCase()) ?? null
}
