/*
 * clock-pin middleware — seeds `event.context.serverClock` from `?clock=` /
 * the pin cookie, in demo-capable envs only, on GET and HEAD only.
 *
 * The whole decision lives in `server/utils/clock-pin.ts` (pure, unit-tested);
 * this file is the h3 plumbing. It runs BEFORE every handler, so `requestClock`
 * finds the pin already seeded and memoises it — one instant for the SSR render,
 * the SQL windows and the shipped `/api/v1/clock` payload alike.
 *
 * See `server/utils/clock-pin.ts` for why this exists and what gates it.
 */
import { defineEventHandler, getQuery, getCookie, setCookie, deleteCookie, createError } from 'h3'
import { currentServerDeployEnv, isDemoCapableEnv } from '../../shared/env/deploy-env'
import { CLOCK_PIN_COOKIE, CLOCK_PIN_PARAM, resolveClockPin } from '../utils/clock-pin'

export default defineEventHandler((event) => {
  const raw = getQuery(event)[CLOCK_PIN_PARAM]
  const query = typeof raw === 'string' ? raw : undefined
  const cookie = getCookie(event, CLOCK_PIN_COOKIE)

  // Nothing to do on the overwhelming majority of requests — check before
  // classifying the env so this costs a property read, not a string parse.
  if (query === undefined && cookie === undefined) return
  // Writes always run on the wall clock: a pinned clock would move the
  // tenure and cap checks they make. The cookie is left alone for the reads.
  if (event.method !== 'GET' && event.method !== 'HEAD') return

  const verdict = resolveClockPin({
    demoCapable: isDemoCapableEnv(currentServerDeployEnv()),
    query,
    cookie,
  })

  switch (verdict.action) {
    case 'none':
      return
    case 'clear':
      deleteCookie(event, CLOCK_PIN_COOKIE, { path: '/' })
      return
    case 'reject':
      throw createError({
        statusCode: 400,
        statusMessage: verdict.reason,
        data: {
          type: 'https://tokenscope.example.com/errors/bad-clock-pin',
          title: 'Bad clock pin',
          status: 400,
          detail: verdict.reason,
        },
      })
    case 'pin':
      event.context.serverClock = verdict.clock
      if (verdict.setCookie) {
        // Session cookie: no maxAge, so the pin dies with the browser and cannot
        // outlive the capture that set it. httpOnly because nothing in the page
        // reads it — the page reads the CLOCK, which is what the pin produces.
        setCookie(event, CLOCK_PIN_COOKIE, verdict.clock.now, {
          path: '/',
          httpOnly: true,
          sameSite: 'lax',
        })
      }
      console.warn(`[clock-pin] request clock pinned to ${verdict.clock.now} (demo-capable env)`)
      return
  }
})
