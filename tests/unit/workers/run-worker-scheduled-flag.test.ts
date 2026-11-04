/*
 * The run-worker endpoint (the scheduler's entrypoint) marks every dispatch
 * `scheduled: true`, and a signed body cannot unset it: placement-check runs its
 * scheduled read only from here (docs/design/org-setup/00-spec.md).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createEvent } from 'h3'
import { IncomingMessage, ServerResponse } from 'node:http'
import { Socket } from 'node:net'

const dispatch = vi.hoisted(() => ({ calls: [] as unknown[] }))

vi.mock('../../../server/auth/internal-request', () => ({ verifyInternalRequest: async () => {} }))
vi.mock('../../../server/db/worker-db', () => ({ getWorkerDb: async () => ({}) }))
vi.mock('../../../server/workers/dispatch', () => ({
  dispatchWorker: async (_db: unknown, entry: { name: string }, opts: unknown) => {
    dispatch.calls.push(opts)
    return { worker: entry.name, duration_ms: 0, result: null }
  },
}))

const { default: handler } = await import('../../../server/api/v1/internal/run-worker/[name].post')

function makeEvent(body: string) {
  const req = new IncomingMessage(new Socket())
  req.method = 'POST'
  req.url = '/api/v1/internal/run-worker/placement-check'
  const event = createEvent(req, new ServerResponse(req))
  ;(event as unknown as { _requestBody?: Buffer })._requestBody = Buffer.from(body, 'utf8')
  Object.defineProperty(event.node.req, 'rawBody', { value: Buffer.from(body, 'utf8'), writable: true })
  event.context.params = { name: 'placement-check' }
  return event
}

describe('run-worker endpoint: scheduled flag', () => {
  beforeEach(() => { dispatch.calls.length = 0 })

  it('an empty body dispatches as scheduled', async () => {
    await handler(makeEvent('{}'))
    expect(dispatch.calls).toEqual([{ scheduled: true }])
  })

  it('a body cannot unset it; other options pass through', async () => {
    await handler(makeEvent('{"scheduled":false,"retryFailed":true}'))
    expect(dispatch.calls).toEqual([{ retryFailed: true, scheduled: true }])
  })
})
