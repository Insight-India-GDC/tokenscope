/*
 * apiErrorDetail (SYS-5) — the single error-extraction chokepoint. The
 * precedence order matters: RFC-9457 Problem-Details bodies carry the human
 * text at data.data.detail and MUST win over h3's statusMessage; several
 * hand-rolled copies missed that path before the consolidation sweep.
 */
import { describe, it, expect } from 'vitest'
import { apiErrorDetail, isConfirmedRejection, mutationErrorDetail } from '../../../app/composables/useApiError'

describe('apiErrorDetail', () => {
  it('prefers the RFC-9457 data.data.detail path', () => {
    expect(
      apiErrorDetail(
        {
          data: {
            data: { detail: 'Budget overlaps an existing allocation.' },
            statusMessage: 'Conflict',
            detail: 'other',
          },
          message: 'Request failed',
        },
        'fallback',
      ),
    ).toBe('Budget overlaps an existing allocation.')
  })

  it('falls back to statusMessage, then data.detail, then message', () => {
    expect(apiErrorDetail({ data: { statusMessage: 'Forbidden' } }, 'f')).toBe('Forbidden')
    expect(apiErrorDetail({ data: { detail: 'plain detail' } }, 'f')).toBe('plain detail')
    expect(apiErrorDetail({ message: 'boom' }, 'f')).toBe('boom')
  })

  it('returns the fallback for null/undefined/shapeless errors', () => {
    expect(apiErrorDetail(null, 'fallback')).toBe('fallback')
    expect(apiErrorDetail(undefined, 'fallback')).toBe('fallback')
    expect(apiErrorDetail({}, 'fallback')).toBe('fallback')
  })
})

describe('isConfirmedRejection / mutationErrorDetail', () => {
  it('only a 4xx with a body is a confirmed refusal', () => {
    expect(isConfirmedRejection({ statusCode: 409, data: { detail: 'taken' } })).toBe(true)
    expect(isConfirmedRejection({ status: 422, data: {} })).toBe(true)
    // No response at all: a network failure, a CORS block, an aborted request.
    expect(isConfirmedRejection(new TypeError('Failed to fetch'))).toBe(false)
    expect(isConfirmedRejection({ message: '<no response> Failed to fetch' })).toBe(false)
    // The server (or a gateway in front of it) failed: the change may have landed.
    expect(isConfirmedRejection({ statusCode: 500, data: { detail: 'boom' } })).toBe(false)
    expect(isConfirmedRejection({ statusCode: 504, data: {} })).toBe(false)
    // A 4xx with no body did not come from our handler.
    expect(isConfirmedRejection({ statusCode: 408 })).toBe(false)
  })

  it('gives the server reason on a refusal and the unknown-outcome text otherwise', () => {
    expect(mutationErrorDetail({ statusCode: 409, data: { detail: 'taken' } }, 'refused', 'unknown')).toBe('taken')
    expect(mutationErrorDetail({ statusCode: 409, data: {} }, 'refused', 'unknown')).toBe('refused')
    expect(mutationErrorDetail(new TypeError('Failed to fetch'), 'refused', 'unknown')).toBe('unknown')
  })
})
