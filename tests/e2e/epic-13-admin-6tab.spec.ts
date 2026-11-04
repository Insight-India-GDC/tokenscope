/*
 * Epic 13 — Admin region detail end-to-end coverage.
 *
 * The original 6-tab /admin/region mega-page (checklist / org-units /
 * teammates / projects / repos / connectors) was dissolved by the
 * region-lifecycle sprint into /admin/regions (list) + /admin/regions/:id
 * (detail). The detail page has FOUR tabs — Cost centres (default) /
 * Teammates / Setup checklist / Connectors — and the legacy /admin/region
 * path is kept as a redirect stub to the caller's home region.
 *
 * This spec drives the redirect + the four tabs:
 *   - admin lands on the Cost centres tab (editable LTREE list)
 *   - Setup checklist renders progress bar + 7 rows (J4 added
 *     'Assign Business Unit owners' + 'Designate project managers')
 *   - Connectors states that no finance-system connector exists
 *   - ?tab= deep-link works on the regions/:id route
 *   - all 4 tabs reachable without console errors
 */
import { test, expect } from '@playwright/test'

const baseUrl = process.env.BASE_URL || 'http://localhost:3450'

async function signInAsAdmin(page) {
  await page.goto(`${baseUrl}/login`)
  await page.waitForLoadState('networkidle')
  const loginResp = page.waitForResponse(
    (r) => r.url().endsWith('/api/v1/auth/dev-login') && r.request().method() === 'POST',
  )
  await page.click('[data-testid="persona-admin"]')
  await loginResp
  await page.waitForURL(`${baseUrl}/admin`)
  // Legacy /admin/region redirects to the caller's home-region detail
  // page — keep driving it so the redirect stub stays covered.
  await page.goto(`${baseUrl}/admin/region`)
  await page.waitForURL(/\/admin\/regions\/[0-9a-f-]+/)
  await page.waitForLoadState('networkidle')
}

test.describe('Admin region detail (4-tab)', () => {
  test('lands on the Cost centres tab with the editable LTREE list', async ({ page }) => {
    await signInAsAdmin(page)
    await expect(page.locator('[data-testid="admin-tabs"]')).toBeVisible()
    await expect(page.locator('[data-testid="panel-cost-centres"]')).toBeVisible()
    // Seeded skeleton: BU 'services' + practices delta/echo/foxtrot,
    // indented by LTREE depth.
    await expect(page.locator('[data-testid="cc-row-services"]')).toBeVisible()
    await expect(page.locator('[data-testid="cc-row-delta"]')).toBeVisible()
    await expect(page.locator('[data-testid="cc-row-foxtrot"]')).toBeVisible()
  })

  test('Setup checklist tab renders progress bar + 7 checklist rows', async ({ page }) => {
    await signInAsAdmin(page)
    await page.click('[data-testid="admin-tab-checklist"]')
    await expect(page).toHaveURL(/\?tab=checklist$/)
    await expect(page.locator('[data-testid="panel-checklist"]')).toBeVisible()
    await expect(page.locator('[data-testid="setup-progress-bar"]')).toBeVisible()
    // 5 original rows + the J4 relationship steps (cou-owners, project-pms).
    const rows = page.locator('[data-testid="checklist-row"]')
    await expect(rows).toHaveCount(7)
    await expect(page.locator('[data-testid="panel-checklist"]')).toContainText(
      'Assign Business Unit owners',
    )
    await expect(page.locator('[data-testid="panel-checklist"]')).toContainText(
      'Designate project managers',
    )
  })

  test('Connectors tab states the real connector state, not pilot cards', async ({ page }) => {
    await signInAsAdmin(page)
    await page.click('[data-testid="admin-tab-connectors"]')
    await expect(page).toHaveURL(/\?tab=connectors$/)
    await expect(page.locator('[data-testid="panel-connectors"]')).toBeVisible()
    await expect(page.locator('[data-testid="connectors-none"]')).toContainText('No finance-system connector')
    await expect(page.locator('[data-testid="connector-card"]')).toHaveCount(0)
  })

  test('deep-link via ?tab=teammates lands on the Teammates panel', async ({ page }) => {
    await signInAsAdmin(page)
    // NOTE: the legacy /admin/region redirect DROPS the query string, so
    // the deep-link must target the regions/:id route directly. Build it
    // from the post-redirect URL (the region id is per-seed).
    const regionUrl = page.url().split('?')[0]
    await page.goto(`${regionUrl}?tab=teammates`)
    await page.waitForLoadState('networkidle')
    await expect(page.locator('[data-testid="entity-table-teammates"]')).toBeVisible()
  })

  test('all 4 tabs reachable without console errors', async ({ page }) => {
    const consoleErrors: string[] = []
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text())
    })
    page.on('pageerror', (err) => consoleErrors.push(err.message))

    await signInAsAdmin(page)
    for (const tab of ['cost-centres', 'teammates', 'checklist', 'connectors']) {
      await page.click(`[data-testid="admin-tab-${tab}"]`)
      await page.waitForLoadState('networkidle')
    }
    const real = consoleErrors.filter((e) => !/favicon|manifest|hydration mismatch text/.test(e))
    expect(real, `console errors:\n${real.join('\n')}`).toEqual([])
  })
})
