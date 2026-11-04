/*
 * Convergence Epic — cross-surface data parity E2E.
 *
 * The convergence epic closed a class of bug where one user could see
 * contradictory numbers across surfaces: inbox alert claiming X, bucket
 * card showing Y, recent sessions showing Z. This spec pins the parity
 * contracts so a future regression fails at E2E time, not at demo time.
 *
 * Covers:
 *   - Manager's bucket card lists CSL-AII with `Contributed` chip + Over
 *     status, dollar values matching the inbox over-budget alert exactly
 *     ($12,710 / $12,500, $210 over).
 *   - Developer's bucket card does NOT include the over-budget alert
 *     (she didn't contribute to CSL-AII).
 *   - "Open project" link from the over-budget drawer lands on the
 *     project's allocator without auto-focusing the top-up form.
 *   - "Add top-up" link lands on the SAME allocator URL plus
 *     `?focus=topup`, and the top-up form is pre-expanded with the
 *     amount input focused.
 *   - Clicking "Add top-up" does NOT auto-resolve the inbox item (the
 *     item state stays `read`, not `resolved`).
 *   - Inbox bell badge reflects actual unread count, not the per-request
 *     limit (the COUNT-OVER fix).
 */
import { test, expect } from '@playwright/test'
import { baseUrl, signInAs } from './helpers'

test.describe('Convergence — data parity across surfaces', () => {
  test('manager sees CSL-AII with Contributed chip + Over status + matching dollars', async ({
    page,
  }) => {
    await signInAs(page, 'manager')
    await page.goto(`${baseUrl}/`)
    await page.waitForLoadState('networkidle')

    // Two-lane hero (homepage redesign): the Budgeted lane carries the
    // parity numbers — Anil's $12,710 CSL-AII spike (seed, always
    // current-month) against the $12,500 current-month baseline
    // allocation. Anil's other buckets have no current allocation, so
    // these two figures are his whole Budgeted lane.
    const hero = page.locator('[data-testid="hero-summary"]')
    await expect(hero).toContainText('$12,710.00')
    await expect(hero).toContainText('$12,500.00')
    await expect(hero).toContainText('102% of allocated')
    // Worst-lane RAG state: > 100% budgeted → Over.
    await expect(page.locator('[data-testid="hero-status"]')).toHaveText('Over')

    // No "↓ N% vs last month" (the hardcoded fake delta was removed in
    // the convergence epic).
    await expect(page.locator('main')).not.toContainText('vs last month')

    // CSL-AII bucket: Contributed chip + Over status + correct dollars.
    const aflRow = page.locator('[data-testid="project-bucket-list"] li').filter({ hasText: 'CSL-AII' })
    await expect(aflRow.locator('[data-testid="contributed-badge"]')).toBeVisible()
    await expect(aflRow).toContainText('$12,710.00')
    await expect(aflRow).toContainText('$12,500.00')
    // D8 split the pill's word: "Over" is now only the FACT of spend already
    // past the allocation ('pace-over' forecasts read "On pace to exceed",
    // which does not contain "Over"). This fixture IS the fact case — $12,710
    // spent of $12,500 — so the badge text stays 'Over'.
    await expect(aflRow).toContainText('Over')

    // Assigned-only buckets must NOT carry the contributed chip.
    const nabRow = page.locator('[data-testid="project-bucket-list"] li').filter({ hasText: 'NWB-CIB' })
    await expect(nabRow.locator('[data-testid="contributed-badge"]')).toHaveCount(0)
  })

  test("developer's bucket card does NOT include CSL-AII as over-budget", async ({ page }) => {
    await signInAs(page, 'developer')
    // Priya is assigned to CSL-AII but didn't contribute. Bucket should
    // show $0.00 — NOT $12,710 — and status Healthy, NOT Over.
    const aflRow = page.locator('[data-testid="project-bucket-list"] li').filter({ hasText: 'CSL-AII' })
    await expect(aflRow).toContainText('$0.00')
    await expect(aflRow).toContainText('Healthy')
    // No Contributed chip for priya (she's assigned, not contributor-only).
    await expect(aflRow.locator('[data-testid="contributed-badge"]')).toHaveCount(0)
  })

  test('over-budget drawer body numbers match the bucket card numbers exactly', async ({
    page,
  }) => {
    await signInAs(page, 'manager')
    await page.goto(`${baseUrl}/inbox`)
    await page.waitForLoadState('networkidle')

    await page.click('[data-testid^="inbox-row-"] button')
    await expect(page.locator('[data-testid="inbox-drawer"]')).toBeVisible()
    await expect(page.locator('[data-testid="inbox-drawer"]')).toHaveAttribute(
      'data-variant',
      'over-budget',
    )

    // Same numbers in the drawer body as the bucket card.
    const drawerBody = page.locator('[data-testid="inbox-drawer"]')
    await expect(drawerBody).toContainText('$12710.00')
    await expect(drawerBody).toContainText('$12500.00')
    await expect(drawerBody).toContainText('102% used')
  })

  /*
   * Resolved (was a FIXME'd genuine bug, found 2026-06-11 rebaseline):
   * over-budget alerts now route to budget-RESPONSIBLE parties (current
   * PMs + CC owners, dispatch.ts) in addition to contributors, and the
   * inbox read path emits the editor deep-link ONLY when the recipient
   * passes the editor's own dual gate (honourable-links rule,
   * me/inbox/index.get.ts). Priya — developer role, PM of CSL-AII —
   * exercises the working-links path; Anil — manager role, cross-CoU
   * contributor with no authority over delta — exercises the
   * links-withheld path below.
   */
  test('"Open project" → /projects/{code}, the project page, not the budget editor (PM recipient)', async ({
    page,
  }) => {
    // Issue 488: "Open project" opened the budget editor, which a member who is
    // not the manager cannot open. It now opens the project page, whose gate
    // (membership, BU ownership or a region admin) the server checks before it
    // emits the link. The editor stays one click away on "Add top-up".
    await signInAs(page, 'developer')
    await page.goto(`${baseUrl}/inbox`)
    await page.waitForLoadState('networkidle')
    await page
      .locator('[data-testid^="inbox-row-"]', { hasText: 'over allocation' })
      .locator('button')
      .first()
      .click()

    const openLink = page.locator('[data-testid="drawer-open-project"]')
    await expect(openLink).toBeVisible()
    const href = await openLink.getAttribute('href')
    expect(href).toBe('/projects/CSL-AII')

    await openLink.click()
    await page.waitForURL(/\/projects\/CSL-AII$/)
  })

  test('"Add top-up" → /allocations/{id}?focus=topup + form expanded + amount focused + item NOT auto-resolved (PM recipient)', async ({
    page,
  }) => {
    await signInAs(page, 'developer')
    await page.goto(`${baseUrl}/inbox`)
    await page.waitForLoadState('networkidle')
    await page
      .locator('[data-testid^="inbox-row-"]', { hasText: 'over allocation' })
      .locator('button')
      .first()
      .click()

    const topupBtn = page.locator('[data-testid="drawer-action-add-topup"]')
    await expect(topupBtn).toBeVisible()
    const href = await topupBtn.getAttribute('href')
    expect(href).toMatch(/^\/allocations\/[0-9a-f-]+\?focus=topup$/)

    await topupBtn.click()
    await page.waitForURL(/\/allocations\/[0-9a-f-]+\?focus=topup$/)
    // Top-up form pre-expanded.
    await expect(page.locator('[data-testid="topup-form"]')).toBeVisible()
    // Amount input has focus.
    await expect(page.locator('[data-testid="topup-amount"]')).toBeFocused()

    // The inbox item must NOT be auto-resolved when the user clicks
    // Add top-up — they may decide not to add a top-up after seeing
    // the allocator. State should be `read` (auto-marked-read when the
    // drawer opened), not `resolved`.
    const inboxResp = await page.request.get(`${baseUrl}/api/v1/me/inbox`)
    const inboxBody = (await inboxResp.json()) as {
      items: Array<{ category: string; ack_state: string }>
    }
    const overBudget = inboxBody.items.find((i) => i.category === 'over-budget')
    expect(overBudget?.ack_state).toBe('read')
  })

  test('contributor without editor authority gets the alert with links WITHHELD', async ({
    page,
  }) => {
    // Anil: manager role, but CSL-AII's CoU (delta) is outside his org
    // subtree (echo) and he is not its PM — the honourable-links rule
    // keeps the alert (awareness) and drops the dead editor buttons.
    await signInAs(page, 'manager')
    await page.goto(`${baseUrl}/inbox`)
    await page.waitForLoadState('networkidle')
    const row = page.locator('[data-testid^="inbox-row-"]', { hasText: 'over allocation' })
    await expect(row).toBeVisible()
    await row.locator('button').first().click()

    await expect(page.locator('[data-testid="inbox-drawer"]')).toBeVisible()
    await expect(page.locator('[data-testid="drawer-open-project"]')).toHaveCount(0)
    await expect(page.locator('[data-testid="drawer-action-add-topup"]')).toHaveCount(0)
  })

  test('inbox bell badge reflects actual unread count, not the limit-bounded total', async ({
    page,
  }) => {
    /*
     * Priya has 3 unread items (velocity + untagged + over-budget,
     * as CSL-AII's PM). Pre-fix the
     * /api/v1/me/inbox endpoint returned `total = rows.length`
     * (bounded by limit=1 from AppHeader) → badge maxed at "1". Post
     * fix uses COUNT(*) OVER () so total reflects the real unread
     * count.
     */
    await signInAs(page, 'developer')
    // The bell renders count inside a `bg-brand-hunger` span. Wait for
    // it to populate (useFetch resolves after first paint).
    const bellBadge = page.locator(
      '[data-testid="inbox-bell"] span.bg-brand-hunger',
    )
    await expect(bellBadge).toBeVisible()
    await expect(bellBadge).toHaveText('3')

    // Also verify the API directly: items length is 1 (limit=1), total is 3.
    const inboxResp = await page.request.get(
      `${baseUrl}/api/v1/me/inbox?ack_state=open&limit=1`,
    )
    const inboxBody = (await inboxResp.json()) as { items: unknown[]; total: number }
    expect(inboxBody.items.length).toBe(1)
    expect(inboxBody.total).toBe(3)
  })
})
