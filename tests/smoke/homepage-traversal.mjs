// Homepage traversal smoke — logs in as the developer persona (Priya, seeded)
// and clicks through every interactive surface of the redesigned homepage so a
// fully-working UI can be verified before deploy. Assertion-rich (unlike the cheap
// boot smoke). Run against a dev server with NUXT_OIDC_AUTH_DEV_MODE=true + the
// demo seed loaded.
import { chromium } from 'playwright-chromium'

const baseUrl = process.env.BASE_URL || 'http://127.0.0.1:3450'
const errors = []
let step = 'init'
let exitCode = 0

const browser = await chromium.launch()
const ctx = await browser.newContext({ viewport: { width: 1440, height: 1100 } })
const page = await ctx.newPage()
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))

const must = async (sel, label) => {
  const el = await page.$(sel)
  if (!el || !(await el.isVisible())) throw new Error(`[${step}] missing/hidden: ${label} (${sel})`)
  return el
}
const count = async (sel) => (await page.$$(sel)).length

try {
  // ── login as the developer persona (Priya) ──
  step = 'login'
  await page.goto(`${baseUrl}/login`, { waitUntil: 'networkidle' })
  await must('[data-testid="persona-developer"]', 'developer persona button')
  await page.click('[data-testid="persona-developer"]')
  await page.waitForURL((u) => !u.toString().includes('/login'), { timeout: 20000 })
  await page.waitForSelector('[data-testid="hero-summary"]', { timeout: 20000 })

  // ── panels render ──
  step = 'panels'
  for (const [sel, label] of [
    ['[data-testid="hero-summary"]', 'hero'],
    ['[data-testid="hero-status"]', 'health badge'],
    ['[data-testid="connect-desktop"]', 'connect claude desktop'],
    ['[data-testid="connect-claude"]', 'connect claude code cli'],
    ['[data-testid="connect-copilot"]', 'connect copilot'],
    ['[data-testid="project-bucket-list"]', 'project spend list'],
    ['[data-testid="spill-card"]', 'tagged spend card'],
    ['[data-testid="untagged-sessions"]', 'needs-tagging grid'],
    ['[data-testid="activity-card"]', 'activity list'],
  ]) await must(sel, label)

  // project bars present (budgeted projects seeded)
  if ((await count('[data-testid^="usage-bucket-"]')) < 1) throw new Error('[panels] no project buckets')

  // ── connect-client pop-up: open from a head button, assert it renders the
  //    shared guide, then close via Escape (both buttons use one component) ──
  step = 'connect-dialog'
  await page.click('[data-testid="connect-claude"]')
  await must('[data-testid="connect-client-modal"]', 'connect dialog')
  await must('[data-testid="connect-claude-code"]', 'claude guide in dialog')
  await page.keyboard.press('Escape')
  await page.waitForTimeout(150)
  if (await page.$('[data-testid="connect-client-modal"]')) {
    const m = await page.$('[data-testid="connect-client-modal"]')
    if (await m.isVisible()) throw new Error('[connect-dialog] modal still visible after Escape')
  }
  await page.click('[data-testid="connect-desktop"]')
  await must('[data-testid="connect-claude-desktop"]', 'claude desktop guide in dialog')
  await page.click('[data-testid="connect-close"]')
  await page.waitForTimeout(150)
  await page.click('[data-testid="connect-copilot"]')
  await must('[data-testid="connect-copilot-cli"]', 'copilot guide in dialog')
  await page.click('[data-testid="connect-close"]')
  await page.waitForTimeout(150)

  // ── recent sessions toggle (collapse + expand) ──
  step = 'recent-toggle'
  await page.click('[data-testid="recent-toggle"]')
  await page.waitForTimeout(150)
  if (await page.$('table')) {
    const t = await page.$('table')
    if (await t.isVisible()) throw new Error('recent table still visible after collapse')
  }
  await page.click('[data-testid="recent-toggle"]')
  await must('table', 'recent table re-expanded')

  // ── Tag dialog: open from a needs-tagging card, assign a project, save ──
  step = 'tag-open'
  const needsCount = await count('[data-testid="untagged-sessions"] [data-testid^="untagged-"]')
  if (needsCount < 1) throw new Error('no needs-tagging sessions to tag')
  await page.click('[data-testid="untagged-sessions"] [data-testid^="tag-"]')
  await must('[data-testid="tag-session-modal"]', 'tag dialog')
  await must('[data-testid="tag-project"]', 'budget select')
  await must('[data-testid="tag-activity"]', 'activity input')
  // pick the first real project option + save
  step = 'tag-save'
  const opts = await page.$$eval('[data-testid="tag-project"] option', (os) => os.map((o) => o.value).filter(Boolean))
  if (opts.length < 1) throw new Error('no project options in budget select')
  await page.selectOption('[data-testid="tag-project"]', opts[0])
  await page.click('[data-testid="tag-submit"]')
  await page.waitForSelector('[data-testid="tag-session-modal"]', { state: 'detached', timeout: 15000 })
  await page.waitForTimeout(600) // let refresh settle
  const needsAfter = await count('[data-testid="untagged-sessions"] [data-testid^="untagged-"]')
  if (needsAfter >= needsCount) throw new Error(`tag did not remove a session (before ${needsCount}, after ${needsAfter})`)

  // ── Re-tag from a recent session, then cancel (Escape) ──
  step = 're-tag'
  await must('[data-testid^="retag-"]', 'a recent re-tag button')
  await page.click('[data-testid^="retag-"]')
  await must('[data-testid="tag-session-modal"]', 're-tag dialog')
  await page.keyboard.press('Escape')
  await page.waitForSelector('[data-testid="tag-session-modal"]', { state: 'detached', timeout: 5000 })

  // ── nav present (developer-first order) ──
  step = 'nav'
  if (!(await page.$('a[href="/"]'))) throw new Error('My usage nav link missing')

  if (errors.length) throw new Error(`console errors:\n  ${errors.join('\n  ')}`)
  console.warn('homepage-traversal: PASS — login, panels, recent toggle, tag+save, re-tag+escape, no console errors')
} catch (err) {
  console.error('homepage-traversal: FAIL —', err instanceof Error ? err.message : err)
  if (errors.length) console.error('console errors:\n  ' + errors.join('\n  '))
  exitCode = 1
} finally {
  await ctx.close()
  await browser.close()
  process.exit(exitCode)
}
