// Admin navigation responsiveness gate — docs/design/admin-nav-responsiveness.md D6.
//
// Every /api/v1/admin/** response is delayed by DELAY_MS (Dev-like slow data),
// then, per persona in PERSONAS (default admin,finance — the region-scoped and
// the org-wide sidebar; keys from shared/auth/roles.ts DEMO_PERSONAS), every
// sidebar link is clicked from another admin page in a fresh browser context.
// Overview ('/admin') is timed like any other route — it is launched from the
// static Roles & terms page, every other route from Overview. Per route the
// gate asserts:
//   1. the target's shell is on screen — `main [data-admin-page="<path>"]` —
//      within SHELL_BUDGET_MS of the click (browser-URL commitment proves
//      nothing: Vue Router pushes the URL before Nuxt's suspense resolves)
//   2. a loading state — `main [aria-busy="true"]` — is visible ONCE THE
//      TARGET'S SHELL IS, so the launch pad's own busy state can never stand in
//      for the target's, AND it clears: a busy state still set DELAY_MS + 20 s
//      after the click is a page whose read never settles (data ms → null)
//   3. no page errors (uncaught exceptions) and no HTTP 5xx response owned by
//      the route; 4xx are reported, not fatal (a region-scoped persona
//      legitimately gets 403 from org-wide endpoints)
// A 5xx is attributed to the route that was current when the REQUEST STARTED,
// never when the response arrived: a slow auxiliary request outlives its route,
// and blaming the next route (or nobody) hides it. Late responses are collected
// after the context closes and still fail, against their owning route.
// Across personas: at least one persona and one route must actually be
// executed — an empty PERSONAS / a ROUTES that matches nothing is a failure,
// not a vacuous pass — each persona must discover at least one link, and the
// union of links discovered must cover every shared/nav/admin-nav.ts item whose
// `access` at least one run persona meets — a nav item never exercised fails.
// It fails on any page that awaits its data at setup scope — that is the point.
//
// Run: BASE_URL=http://127.0.0.1:3450 node tests/smoke/admin-nav-timing.mjs
// Needs a seeded DB (persona login). Env: DELAY_MS, SHELL_BUDGET_MS, PERSONAS.
import { chromium } from 'playwright-chromium'
import { allAdminNavItems, roleMeetsAccess } from '../../shared/nav/admin-nav.ts'
import { getPersona } from '../../shared/auth/roles.ts'

const base = process.env.BASE_URL ?? 'http://127.0.0.1:3450'
const DELAY = Number(process.env.DELAY_MS ?? 1500)
const SHELL_BUDGET = Number(process.env.SHELL_BUDGET_MS ?? 500)
// Default: the Region admin persona, the only demo persona with an admin role. `finance` is a
// developer with a report_access_grant (shared/auth/roles.ts) and opens no admin page, so it is
// not run. Platform-only and org-wide items need a platform-admin, and no demo persona is one
// (deliberately: dev-login could then impersonate an org-wide admin), so this gate does not time
// them; the run names them below instead of passing over them in silence.
const PERSONAS = (process.env.PERSONAS ?? 'admin').split(',').map((p) => p.trim()).filter(Boolean)
// ROUTES=/admin/a,/admin/b limits the run; WARM=1 visits each route once before
// timing it (isolates route-chunk load — a dev-server cost, since a prod build
// prefetches visible NuxtLink chunks — from the page's own behaviour).
const ONLY = new Set((process.env.ROUTES ?? '').split(',').map((p) => p.trim().split('?')[0]).filter(Boolean))
const WARM = process.env.WARM === '1'
// Static pages and redirect stubs carry no data; they only need their marker.
const NO_DATA = new Set(['/admin/help', '/admin/settings', '/admin/region', '/admin/policies'])
// Redirect stubs resolve to another page's marker.
const REDIRECTS = new Map([
  ['/admin/policies', '/admin/policies/report-access'],
  ['/admin/settings', '/admin/system'],
])
const BUSY_CLEAR_TIMEOUT = DELAY + 20000
// Closing the context cancels whatever is still in flight, so a response that
// outlives the route that started it would never be seen. Hold the context open
// briefly after the last route so late arrivals land and are attributed.
const LATE_GRACE = Number(process.env.LATE_GRACE_MS ?? 1000)
// Timing a route means CLICKING its sidebar link from ANOTHER admin page — the
// click-to-shell measurement only means anything across a real navigation.
// Overview is the launch pad for every route; Overview itself launches from
// Roles & terms, which carries no data and so can never leave a busy state
// behind for the Overview measurement to inherit.
const HUB = '/admin'
const HUB_LAUNCH_PAD = '/admin/help'
const launchPadFor = (href) => (href.split('?')[0] === HUB ? HUB_LAUNCH_PAD : HUB)
const markerFor = (path) => `main [data-admin-page="${REDIRECTS.get(path) ?? path}"]`

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const failures = []
const rows = []
const discovered = new Set()
const clientErrors = [] // 4xx — reported, never fatal
// A run that selects nothing must fail: PERSONAS= or a ROUTES= naming a path no
// sidebar offers otherwise iterates zero times and exits 0, certifying nothing.
const executedPersonas = new Set()
const executedRoutes = new Set()
const browser = await chromium.launch()

async function runPersona(persona) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const page = await context.newPage()
  const pageErrors = []
  // `phase` is the route being exercised (or the login / launch-pad load before
  // it). It is captured PER REQUEST at request time — see requestOwner — and
  // never read at response time: a request started under route A that answers
  // during route B belongs to A.
  let phase = 'login'
  const requestOwner = new WeakMap() // Playwright Request → the phase that started it
  const errorsByOwner = new Map() // phase → Set of '<status> <url>'
  const ownerErrors = (owner) => {
    let s = errorsByOwner.get(owner)
    if (!s) errorsByOwner.set(owner, (s = new Set()))
    return s
  }
  page.on('pageerror', (e) => pageErrors.push(String(e)))
  page.on('console', (m) => {
    if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) pageErrors.push(m.text())
  })
  page.on('request', (r) => requestOwner.set(r, phase))
  page.on('response', (r) => {
    const status = r.status()
    if (status < 400) return
    // Fall back to the live phase only for a request this listener never saw
    // start (there is none in practice — the listener is attached first).
    const owner = requestOwner.get(r.request()) ?? phase
    if (status >= 500) ownerErrors(owner).add(`${status} ${r.url()}`)
    else clientErrors.push(`${persona} ${owner}: ${status} ${r.url()}`)
  })
  await page.route('**/api/v1/admin/**', async (route) => {
    await new Promise((r) => setTimeout(r, DELAY))
    await route.continue()
  })

  // Land on an admin page and wait until it is settled — its marker present and
  // its own busy state gone — so nothing it started bleeds into the next
  // measurement.
  async function landOn(path) {
    await page.goto(`${base}${path}`, { waitUntil: 'networkidle' })
    await page.waitForSelector(markerFor(path), { timeout: 30000 })
    if (path === HUB) await page.waitForSelector('[data-testid="admin-hub"]', { timeout: 30000 })
    await page
      .waitForFunction(() => !document.querySelector('main [aria-busy="true"]'), null, { timeout: BUSY_CLEAR_TIMEOUT })
      .catch(() => {})
  }

  try {
    await page.goto(`${base}/login`, { waitUntil: 'networkidle' })
    await page.click(`[data-testid="persona-${persona}"]`)
    // Personas land on their own page (finance → /reporting); the hub is a
    // separate visit.
    await page.waitForURL((u) => !u.pathname.endsWith('/login'), { timeout: 30000 })
    phase = 'hub'
    await landOn(HUB)

    const links = await page.$$eval('[data-testid^="admin-nav-"]', (els) =>
      els.map((e) => ({ id: e.dataset.testid, href: e.getAttribute('href') })),
    )
    const all = links.filter((t) => t.href?.startsWith('/admin'))
    for (const t of all) discovered.add(t.href)
    const targets = all.filter((t) => ONLY.size === 0 || ONLY.has(t.href.split('?')[0]))
    if (all.length === 0) {
      failures.push(`${persona}: no admin sidebar links discovered`)
      return
    }

    for (const t of targets) {
      const owner = t.href
      // The launch-pad navigation is its own phase: a 5xx while loading the
      // page we click FROM is a real failure, but it is not this route's.
      phase = `launch-pad for ${owner}`
      if (WARM) {
        await page.goto(`${base}${t.href}`, { waitUntil: 'networkidle' }).catch(() => {})
      }
      await landOn(launchPadFor(owner))
      phase = owner
      const path = t.href.split('?')[0]
      const sel = markerFor(path)
      const t0 = Date.now()
      let tShell = null
      let busySeen = false
      page.click(`[data-testid="${t.id}"]`).catch(() => {})
      const deadline = t0 + DELAY + 15000
      while (Date.now() < deadline) {
        const [shell, busy] = await Promise.all([
          page.$(sel).then((h) => Boolean(h)).catch(() => false),
          page.$('main [aria-busy="true"]').then((h) => Boolean(h)).catch(() => false),
        ])
        if (tShell == null && shell) tShell = Date.now() - t0
        // Only the TARGET's busy state counts. Before its shell is on screen the
        // launch pad is still rendered, and Overview now announces its own tiles
        // busy — without this the launch pad would satisfy every route's D2.
        if (busy && tShell != null) busySeen = true
        if (tShell != null && (busySeen || NO_DATA.has(path))) break
        if (tShell != null && Date.now() - t0 > DELAY + 500) break // data landed without a busy state
        await sleep(25)
      }
      // Data has landed when the busy state clears (networkidle ignores requests
      // held by page.route, so it cannot measure this). A busy state that never
      // clears is a page whose read never settles — a permanent skeleton.
      let tData = null
      let busyCleared = true
      await page
        .waitForFunction(() => !document.querySelector('main [aria-busy="true"]'), null, { timeout: BUSY_CLEAR_TIMEOUT })
        .then(() => {
          tData = Date.now() - t0
        })
        .catch(() => {
          busyCleared = false
        })
      const problems = []
      if (tShell == null) problems.push(`shell marker ${sel} never appeared in ${Date.now() - t0}ms`)
      else if (tShell > SHELL_BUDGET) problems.push(`shell at ${tShell}ms (> ${SHELL_BUDGET}ms budget)`)
      if (!NO_DATA.has(path) && !busySeen) problems.push('no aria-busy loading state before data landed')
      if (!busyCleared) problems.push(`busy state never cleared — data never landed (aria-busy still set ${BUSY_CLEAR_TIMEOUT}ms after the click)`)
      const seen5xx = [...ownerErrors(owner)]
      if (seen5xx.length) problems.push(`HTTP 5xx: ${seen5xx.join(', ')}`)
      rows.push({ persona, route: owner, tShell, tData, busySeen, serverErrors: seen5xx, problems })
      executedPersonas.add(persona)
      executedRoutes.add(owner)
      if (problems.length) failures.push(`${persona} ${owner}: ${problems.join('; ')}`)
    }
  } catch (err) {
    failures.push(`harness (${persona}): ${err instanceof Error ? err.message : String(err)}`)
  } finally {
    phase = 'teardown'
    await sleep(LATE_GRACE)
    await context.close()
  }
  // Closing the context is what makes the 5xx ledger final: nothing can answer
  // after it. Anything an owning route did not already report arrived after its
  // window closed — still its 5xx, still fatal.
  for (const [owner, set] of errorsByOwner) {
    const row = rows.find((r) => r.persona === persona && r.route === owner)
    const late = [...set].filter((e) => !row?.serverErrors.includes(e))
    if (!late.length) continue
    if (row) {
      row.serverErrors.push(...late)
      failures.push(`${persona} ${owner}: HTTP 5xx landing after the route's window (started under it): ${late.join(', ')}`)
    } else {
      failures.push(`${persona} HTTP 5xx during ${owner}: ${late.join(', ')}`)
    }
  }
  if (pageErrors.length) failures.push(`${persona} page errors: ${pageErrors.slice(0, 5).join(' | ')}`)
}

try {
  for (const persona of PERSONAS) {
    const p = getPersona(persona)
    if (!p) {
      failures.push(`harness: unknown persona '${persona}' (see shared/auth/roles.ts DEMO_PERSONAS)`)
      continue
    }
    await runPersona(persona)
  }
} finally {
  await browser.close()
}

// Selection guards. Zero iterations is the one way this gate can exit 0 while
// asserting nothing, so an empty selection is a failure in its own right.
if (PERSONAS.length === 0) failures.push('no personas selected — PERSONAS= is empty (default admin)')
if (executedPersonas.size === 0) failures.push('no persona timed a single route — the run asserted nothing')
if (executedRoutes.size === 0) failures.push(`no routes timed${ONLY.size ? ` for ROUTES=${[...ONLY].join(',')}` : ''} — the run asserted nothing`)
const discoveredPaths = new Set([...discovered].map((h) => h.split('?')[0]))
const unmatched = [...ONLY].filter((p) => !discoveredPaths.has(p))
if (unmatched.length) {
  failures.push(`ROUTES= names path(s) no persona's sidebar offers: ${unmatched.join(', ')}`)
}

// Coverage: every nav item at least one run persona may reach must have been
// discovered by one of them (restricted to ROUTES= when set). Overview ('/admin')
// is a nav item like any other and is covered here too.
const roles = PERSONAS.map((k) => getPersona(k)?.role).filter(Boolean)
const expected = allAdminNavItems().filter(
  (i) => roles.some((r) => roleMeetsAccess(r, i.access)) && (ONLY.size === 0 || ONLY.has(i.to.split('?')[0])),
)
// An unrestricted run that expects nothing has a broken nav or role mapping —
// its coverage assertion would be vacuous. (A ROUTES= run may legitimately
// narrow to a non-nav destination such as the pinned /admin/help.)
if (ONLY.size === 0 && expected.length === 0) {
  failures.push(`no nav items are reachable by ${PERSONAS.join('/')} — coverage would assert nothing`)
}
const untimed = allAdminNavItems().filter((i) => !roles.some((r) => roleMeetsAccess(r, i.access)))
const neverExercised = expected.filter((i) => !discovered.has(i.to))
if (neverExercised.length) {
  failures.push(`nav items never exercised by ${PERSONAS.join('/')}: ${neverExercised.map((i) => `${i.label} (${i.to}, ${i.access})`).join(', ')}`)
}

const table = ['| persona | route | shell ms | data ms | aria-busy | 5xx |', '|---|---|---|---|---|---|']
for (const r of rows) {
  table.push(`| ${r.persona} | ${r.route} | ${r.tShell ?? '—'} | ${r.tData ?? 'null'} | ${r.busySeen ? 'yes' : 'NO'} | ${r.serverErrors.length ? r.serverErrors.join(', ') : '—'} |`)
}
console.warn(table.join('\n'))
console.warn(`admin-nav-timing: nav items never exercised: ${neverExercised.length ? neverExercised.map((i) => i.to).join(', ') : 'none'}`)
if (untimed.length) {
  console.warn(`admin-nav-timing: not timed, no run persona may open them: ${untimed.map((i) => `${i.to} (${i.access})`).join(', ')}`)
}
if (clientErrors.length) console.warn(`admin-nav-timing: ${clientErrors.length} HTTP 4xx response(s) (not fatal): ${[...new Set(clientErrors)].slice(0, 5).join(' | ')}`)
if (failures.length) {
  console.error(`admin-nav-timing: FAIL (${failures.length})\n - ${failures.join('\n - ')}`)
  process.exit(1)
}
console.warn(`admin-nav-timing: PASS — ${rows.length} routes across ${PERSONAS.join('/')} show their shell < ${SHELL_BUDGET}ms with a loading state that clears under a ${DELAY}ms API delay, no 5xx`)
