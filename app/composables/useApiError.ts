/*
 * useApiError — robust extraction of a human-readable detail from an $fetch
 * error.
 *
 * The server returns errors in a few shapes: RFC-9457 Problem-Details bodies
 * carry `data.data.detail`; h3's createError surfaces `data.statusMessage`;
 * some handlers put the message at `data.detail`. Components hand-rolled this
 * with inconsistent precedence — this helper standardises the order so the
 * surfaced text is predictable.
 *
 * Order: data.data.detail → data.statusMessage → data.detail → message →
 * fallback.
 */
interface ApiErrorShape {
  data?: {
    data?: { detail?: string }
    statusMessage?: string
    detail?: string
  }
  message?: string
}

/**
 * True only when the server answered and refused: a 4xx with a body. Then the
 * change did not happen. Anything else (no response, a 5xx, a gateway timeout)
 * and the client cannot know whether the change landed before it failed.
 */
export function isConfirmedRejection(err: unknown): boolean {
  const e = err as { statusCode?: number; status?: number; data?: unknown } | null | undefined
  const status = e?.statusCode ?? e?.status
  return typeof status === 'number' && status >= 400 && status < 500 && e?.data != null
}

/**
 * The text for a failed change: the server's own reason when it refused, else
 * `unknown`, which must say the outcome is unknown and where to check it.
 */
export function mutationErrorDetail(err: unknown, rejectedFallback: string, unknown: string): string {
  return isConfirmedRejection(err) ? apiErrorDetail(err, rejectedFallback) : unknown
}

export function apiErrorDetail(err: unknown, fallback: string): string {
  const e = err as ApiErrorShape | null | undefined
  return (
    e?.data?.data?.detail ??
    e?.data?.statusMessage ??
    e?.data?.detail ??
    e?.message ??
    fallback
  )
}
