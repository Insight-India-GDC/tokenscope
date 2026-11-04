// @vitest-environment node
/*
 * classifyProbeError — the redaction contract every admin probe handler
 * shares (modelled on api/health.get.ts's "log raw, return static" pattern).
 * Pins the property that actually matters: NO substring of the raw error —
 * host, database, user, port, connection string — ever reaches the returned
 * value, while the raw error still reaches the server log at full fidelity
 * under a correlation id the caller also gets back.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { consola } from 'consola'
import { classifyProbeError, describeError } from '../../../server/utils/redact-probe-error'

afterEach(() => {
  vi.restoreAllMocks()
})

/** Shapes postgres-js's `Errors.connection()` factory (src/errors.js). */
function syntheticConnectionError(code: string, host: string, port: number): Error {
  return Object.assign(new Error(`write ${code} ${host}:${port}`), { code, errno: code, address: host, port })
}

/** Shapes postgres-js's PostgresError (src/errors.js `Object.assign(this, x)`). */
function syntheticPostgresError(code: string, message: string, extra: Record<string, unknown> = {}): Error {
  return Object.assign(new Error(message), { name: 'PostgresError', code, ...extra })
}

describe('classifyProbeError — redaction', () => {
  it('a synthetic postgres-js connection error carrying host/port maps to a reason code, and NO substring of the input appears in the output', () => {
    vi.spyOn(consola, 'error').mockImplementation(() => {})
    const err = syntheticConnectionError('ECONNREFUSED', '10.0.0.4', 5432)
    const result = classifyProbeError(err, 'test-probe')

    expect(result.reason).toBe('connect-refused')
    expect(typeof result.correlationId).toBe('string')
    expect(result.correlationId.length).toBeGreaterThan(0)

    const serialised = JSON.stringify(result)
    for (const secret of ['10.0.0.4', '5432', 'ECONNREFUSED', err.message]) {
      expect(serialised).not.toContain(secret)
    }
  })

  it('a synthetic postgres-js auth error carrying host/db/user maps to auth-denied, with no leak', () => {
    vi.spyOn(consola, 'error').mockImplementation(() => {})
    const err = syntheticPostgresError(
      '28P01',
      'password authentication failed for user "tokenscope-app"',
      { database: 'tokenscope', host: 'ts-pg-dev.postgres.database.azure.com', user: 'tokenscope-app' },
    )
    const result = classifyProbeError(err, 'test-probe')

    expect(result.reason).toBe('auth-denied')
    const serialised = JSON.stringify(result)
    for (const secret of ['tokenscope-app', 'tokenscope', 'ts-pg-dev.postgres.database.azure.com', '28P01', err.message]) {
      expect(serialised).not.toContain(secret)
    }
  })

  it('maps DNS failure, timeout/unreachable, and undefined-table codes to their reason codes', () => {
    vi.spyOn(consola, 'error').mockImplementation(() => {})
    expect(classifyProbeError(syntheticConnectionError('ENOTFOUND', 'nope.invalid', 5432), 'x').reason).toBe('dns-fail')
    expect(classifyProbeError(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }), 'x').reason).toBe('driver-unreachable')
    expect(classifyProbeError(syntheticPostgresError('42P01', 'relation "foo" does not exist'), 'x').reason).toBe('relation-missing')
  })

  /*
   * A bounded probe must be able to name its OWN bound. Before 57014 was
   * classified, a `statement_timeout` a probe set on its own transaction came
   * back as 'unknown' — the uninformative-by-construction shape this module
   * exists to avoid — and it must not read as 'driver-unreachable' either: the
   * connection was fine and the server answered; the WORK was too slow, which
   * is a different fix.
   */
  it("maps a cancelled statement (57014) to statement-timeout, not 'unknown' and not 'driver-unreachable'", () => {
    vi.spyOn(consola, 'error').mockImplementation(() => {})
    const reason = classifyProbeError(
      syntheticPostgresError('57014', 'canceling statement due to statement timeout'),
      'x',
    ).reason
    expect(reason).toBe('statement-timeout')
    expect(reason).not.toBe('unknown')
    expect(reason).not.toBe('driver-unreachable')
  })

  it('finds the code UNDER a wrapper — drizzle rethrows every driver error as DrizzleQueryError with the real one on .cause', () => {
    vi.spyOn(consola, 'error').mockImplementation(() => {})
    // drizzle-orm/pg-core/session.js: `throw new DrizzleQueryError(query, params, e)`.
    // The wrapper has no `code` of its own, so reading only `err.code` would
    // classify every database probe failure as 'unknown' — an "unavailable"
    // signal that never says why.
    const wrapped = Object.assign(new Error('Failed query: select * from v_cost_drift'), {
      cause: syntheticPostgresError('42P01', 'relation "v_cost_drift" does not exist'),
    })
    const result = classifyProbeError(wrapped, 'x')
    expect(result.reason).toBe('relation-missing')
    // Still nothing from the wrapper's own message (which carries the SQL).
    expect(JSON.stringify(result)).not.toContain('v_cost_drift')
  })

  it('a cyclic cause chain terminates instead of spinning', () => {
    vi.spyOn(consola, 'error').mockImplementation(() => {})
    const a: Error & { cause?: unknown } = new Error('a')
    const b: Error & { cause?: unknown } = new Error('b')
    a.cause = b
    b.cause = a
    expect(classifyProbeError(a, 'x').reason).toBe('unknown')
  })

  it('an error with no recognisable code classifies as unknown, not a guess', () => {
    vi.spyOn(consola, 'error').mockImplementation(() => {})
    expect(classifyProbeError(new Error('something odd happened'), 'x').reason).toBe('unknown')
  })

  it('a non-Error thrown value still classifies (unknown) and still redacts', () => {
    vi.spyOn(consola, 'error').mockImplementation(() => {})
    const result = classifyProbeError('a raw string with secret-token-abc123', 'x')
    expect(result.reason).toBe('unknown')
    expect(JSON.stringify(result)).not.toContain('secret-token-abc123')
  })

  it('logs the RAW error server-side at full fidelity, tagged with the SAME correlation id returned to the caller', () => {
    const errSpy = vi.spyOn(consola, 'error').mockImplementation(() => {})
    const err = syntheticConnectionError('ECONNREFUSED', '10.0.0.4', 5432)
    const result = classifyProbeError(err, 'diagnostics:postgres')

    expect(errSpy).toHaveBeenCalledTimes(1)
    const loggedArgs = errSpy.mock.calls[0]!
    // The correlation id ties the log line back to this exact response.
    expect(loggedArgs.some((a) => typeof a === 'string' && a.includes(result.correlationId))).toBe(true)
    // The raw error object itself (or its message) reached the log — full fidelity.
    expect(loggedArgs).toContain(err)
  })

  it('two calls for the same underlying error get DIFFERENT correlation ids (no cross-call collision)', () => {
    vi.spyOn(consola, 'error').mockImplementation(() => {})
    const err = syntheticConnectionError('ECONNREFUSED', '10.0.0.4', 5432)
    const a = classifyProbeError(err, 'x')
    const b = classifyProbeError(err, 'x')
    expect(a.correlationId).not.toBe(b.correlationId)
  })
})

describe('describeError', () => {
  it('keeps the cause chain undici hides behind "fetch failed"', () => {
    const tls = Object.assign(new Error('unable to verify the first certificate'), { code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' })
    const line = describeError(new TypeError('fetch failed', { cause: tls }))
    expect(line).toContain('fetch failed')
    expect(line).toContain('UNABLE_TO_VERIFY_LEAF_SIGNATURE')
    expect(line).toContain('unable to verify the first certificate')
  })

  it('drops URL query strings, where a signed link carries its signature', () => {
    const line = describeError(new Error('GET https://blob.example/r.csv?sv=1&sig=SECRETSIG failed'))
    expect(line).toContain('https://blob.example/r.csv')
    expect(line).not.toContain('SECRETSIG')
  })

  it('stops on a cyclic cause', () => {
    const a: Error & { cause?: unknown } = new Error('a')
    a.cause = a
    expect(describeError(a).split('caused by').length).toBeLessThanOrEqual(5)
  })
})
