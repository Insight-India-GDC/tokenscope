/*
 * pgErrorCode — extract the Postgres SQLSTATE code from an error, whether it
 * surfaces as a bare `postgres` PostgresError (`.code`) OR wrapped in Drizzle's
 * DrizzleQueryError (`.cause.code`).
 *
 * Drizzle wraps errors from `tx.execute(sql\`...\`)` in a DrizzleQueryError that
 * carries the original PostgresError on `.cause`, so reading `err.code` directly
 * misses the SQLSTATE for raw-SQL paths (e.g. a 23505 unique-violation on an
 * UPDATE). The query-builder paths sometimes surface the bare error. This helper
 * checks both so a clean 409/23503 mapping works regardless of the call style.
 */
/** The table a Postgres error names (`table_name`), bare or under Drizzle's `.cause`. */
export function pgErrorTable(err: unknown): string | undefined {
  if (typeof err !== 'object' || err === null) return undefined
  for (const e of [err, (err as { cause?: unknown }).cause]) {
    const t = typeof e === 'object' && e !== null ? (e as { table_name?: unknown }).table_name : undefined
    if (typeof t === 'string' && t) return t
  }
  return undefined
}

export function pgErrorCode(err: unknown): string | undefined {
  if (typeof err !== 'object' || err === null) return undefined
  const top = (err as { code?: unknown }).code
  if (typeof top === 'string') return top
  const cause = (err as { cause?: unknown }).cause
  if (typeof cause === 'object' && cause !== null) {
    const inner = (cause as { code?: unknown }).code
    if (typeof inner === 'string') return inner
  }
  return undefined
}
