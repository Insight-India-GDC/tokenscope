/*
 * A minimal same-origin h3 event for calling a route handler directly, with the
 * session injected (the shape the admin route tests build inline).
 */
import type { H3Event } from 'h3'
import { injectTestSession } from '../../helpers/auth'
import type { Session } from '../../../server/utils/auth'

export function routeEvent(opts: {
  method: string
  session: Session
  params?: Record<string, string>
  query?: Record<string, string>
  body?: unknown
}): H3Event {
  const qs = opts.query ? `?${new URLSearchParams(opts.query).toString()}` : ''
  const url = `/x${qs}`
  const headers: Record<string, string> = { host: 'localhost:3450', origin: 'http://localhost:3450' }
  const e = {
    method: opts.method,
    path: url,
    context: { params: opts.params ?? {} },
    node: {
      req: {
        method: opts.method,
        url,
        body: opts.body,
        socket: { remoteAddress: '127.0.0.1' },
        get headers() {
          return { ...headers, 'content-type': 'application/json' }
        },
      },
      res: {
        _headers: {} as Record<string, string | string[]>,
        statusCode: 200,
        getHeader(n: string) { return this._headers[n.toLowerCase()] },
        setHeader(n: string, v: string | string[]) { this._headers[n.toLowerCase()] = v },
        removeHeader(n: string) { this._headers[n.toLowerCase()] = '' },
        appendHeader(n: string, v: string | string[]) { this._headers[n.toLowerCase()] = v },
        get headersSent() { return false },
      },
    },
  }
  injectTestSession(e as unknown as H3Event, opts.session)
  return e as unknown as H3Event
}
