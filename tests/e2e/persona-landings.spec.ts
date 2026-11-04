/*
 * Persona landing pages — per-role smoke + headline numbers.
 *
 * For each persona, sign in and assert the landing page renders the
 * expected hero number, project count, inbox count, and any persona-
 * specific affordances. These tests are intentionally tight: a future
 * regression on any one of these numbers fails THIS test, surfacing
 * which surface drifted.
 *
 * Why not extend journey-1.spec.ts: journey-1 covers nav + landing
 * route; this covers the numbers visible on those landings — a
 * different lens with different failure modes.
 *
 * Includes a regression test for the rollups/manager SQL syntax error
 * (trailing comma before SELECT) that broke the manager landing during
 * the convergence E2E sweep.
 */
import { test, expect } from '@playwright/test'
import { baseUrl, signInAs } from './helpers'

// Reporting cutover: this spec asserts the now-deleted legacy pages (Team / Finance) and
// their old persona landings. Skipped pending a rewrite against /reporting?scope=… (needs
// the browser E2E suite, not runnable in CI here). Tracked as a cutover follow-up.
test.beforeEach(() => {
  test.skip(true, 'reporting cutover — rewrite this spec against /reporting (see cutover PR)')
})

test.describe('Persona landings', () => {
  test('developer (priya) lands with seeded buckets + 2 inbox items + two-lane hero', async ({ page }) => {
    await signInAs(page, 'developer')
    await expect(page.locator('h1')).toContainText('Hello Priya.')

    // Homepage redesign (consumption sprint): the single 48px KPI was
    // replaced by a two-lane hero — Budgeted (spend vs allocations) and
    // Unallocated (vs soft cap). We deliberately do NOT assert dollar
    // figures here: Priya's MTD spend depends on where the run date
    // falls relative to the seed's ISO-week velocity ramp, and other
    // suites (journey-mvp-path) add spend mid-run. Structure is the
    // convergence-relevant contract; exact parity is pinned in
    // convergence-data-parity.spec.ts against the manager's stable spike.
    const hero = page.locator('[data-testid="hero-summary"]')
    await expect(hero).toBeVisible()
    await expect(hero).toContainText('Budgeted ·')
    await expect(hero).toContainText('Unallocated · soft cap')
    await expect(page.locator('[data-testid="hero-status"]')).toBeVisible()

    // The 3 seeded buckets (CSL-DRP contributed, CSL-AII assigned+PM,
    // INT-PLT assigned). Asserted individually, not as a count —
    // journey-mvp-path adds an Acme bucket when it runs first.
    await expect(page.locator('[data-testid="usage-bucket-CSL-DRP"]')).toBeVisible()
    await expect(page.locator('[data-testid="usage-bucket-CSL-AII"]')).toBeVisible()
    await expect(page.locator('[data-testid="usage-bucket-INT-PLT"]')).toBeVisible()

    // No fake "↓ N% vs last month" — that delta was hardcoded and was
    // removed in the convergence epic.
    await expect(page.locator('main')).not.toContainText('vs last month')

    // Inbox bell shows 3 unread (velocity-warning + untagged-backlog +
    // over-budget — Priya is CSL-AII's PM, a budget-responsible recipient).
    await expect(
      page.locator('[data-testid="inbox-bell"] span.bg-brand-hunger'),
    ).toHaveText('3')
  })

  test('manager (anil) lands on /rollups WITHOUT a 500', async ({ page }) => {
    /*
     * Regression: rollups/manager.get.ts had a trailing-comma SQL bug
     * that 500'd the manager landing page. The page now loads.
     */
    await signInAs(page, 'manager')
    expect(page.url()).toContain('/rollups')
    await expect(page.locator('h1')).toContainText('Practice Delta rollup')
    // The page should render some content beyond the page head — verify
    // the per-teammate table or its empty state exists.
    await expect(page.locator('main')).toBeVisible()
  })

  test("manager's homepage (when visited directly) shows CSL-AII Contributed", async ({ page }) => {
    await signInAs(page, 'manager')
    await page.goto(`${baseUrl}/`)
    await expect(page.locator('h1')).toContainText('Hello Anil.')
    await expect(page.locator('[data-testid="project-bucket-list"] li')).toHaveCount(3)
    const aflRow = page.locator('[data-testid="project-bucket-list"] li').filter({ hasText: 'CSL-AII' })
    await expect(aflRow.locator('[data-testid="contributed-badge"]')).toBeVisible()
  })

  test('admin (lena) lands on the Overview launcher', async ({ page }) => {
    await signInAs(page, 'admin')
    expect(page.url()).toContain('/admin')
    // The old flat tile wall was replaced by the Overview launcher (h1
    // "Overview"): an at-a-glance status strip + role-aware "Common tasks"
    // quick actions. Everything else lives in the persistent admin sidebar.
    await expect(page.locator('h1')).toContainText('Overview')
    await expect(page.locator('[data-testid="admin-overview-stats"]')).toBeVisible()
    await expect(page.locator('[data-testid="admin-qa-region"]')).toBeVisible()
    // The sidebar is the complete surface — spot-check a couple of items.
    await expect(page.locator('[data-testid="admin-nav-teammates"]')).toBeVisible()
    await expect(page.locator('[data-testid="admin-nav-providers"]')).toBeVisible()
  })

  test('finance (mara) lands on /finance with Practice Delta as top CoU', async ({ page }) => {
    await signInAs(page, 'finance')
    expect(page.url()).toContain('/finance')
    await expect(page.locator('h1')).toContainText('Month-end cross-charge')
    // Practice Delta should be the top CoU by spend (priya + anil are
    // the only current-month contributors and both book to Delta).
    // The total = anil's $12,710 CSL-AII spike (always current-month)
    // + priya's velocity-ramp tail ($0–$250 of it lands in the current
    // month depending on the run date) → assert the $12,xxx band, not
    // a day-exact literal.
    await expect(page.locator('table tbody tr').first()).toContainText('Practice Delta')
    await expect(page.locator('table tbody tr').first()).toContainText(/\$12,\d{3}/)
  })

  test('finance inbox carries the seeded sync-conflict (admin-class routing)', async ({ page }) => {
    /*
     * resolveAdmins (server/notifications/dispatch.ts) routes
     * sync-conflict to admin-CLASS roles — admin, platform-admin AND
     * platform-admin — so Mara now sees the seeded "Pathway · APAC reports
     * conflict on Northwind Bank · CIB Modernise" item. (Pre-region-model this
     * spec asserted an empty finance inbox; routing changed.)
     */
    await signInAs(page, 'finance')
    await page.goto(`${baseUrl}/inbox`)
    await page.waitForLoadState('networkidle')
    await expect(page.locator('[data-testid^="inbox-row-"]')).toHaveCount(1)
    await expect(page.locator('[data-testid^="inbox-row-"]').first()).toContainText('conflict')
  })
})
