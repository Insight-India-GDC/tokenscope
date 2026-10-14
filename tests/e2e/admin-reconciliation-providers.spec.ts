/*
 * Admin → Reconciliation → Providers — onboarding surface smoke.
 *
 * Light structural check (not data-parity) of what the demo `admin` persona (a
 * region admin) sees on the Providers tab:
 *   - the region-clamped Orgs table and its "+ Add org" action render
 *   - the estate-wide Enterprises table, "+ Add enterprise" and coverage do not
 *   - the Add Org dialog offers GitHub only (no Anthropic, credential or Discover),
 *     and its GitHub enterprise picker works
 * Deeper CRUD + the discover happy/sad paths are pinned deterministically in
 * tests/unit/components/provider-onboarding-dialogs.test.ts and the backend
 * integration suite; this is the wired-together smoke.
 */
import { test, expect } from '@playwright/test'
import { baseUrl, signInAs } from './helpers'

test.describe('Admin reconciliation — providers onboarding (region admin)', () => {
  // The demo `admin` persona is a REGION admin. Provider configuration is estate
  // config (owner ruling 2026-10-08, owner-decisions.md §1/§11): the Enterprises
  // table, Add enterprise, coverage and Discover are platform-admin only, and there
  // is no platform-admin demo persona. Those platform-admin views are pinned in
  // tests/unit/components/provider-onboarding-dialogs.test.ts and the integration
  // suite (tests/integration/admin/reconciliation-platform-admin-only.test.ts,
  // github-coverage-routes.test.ts). This spec pins what a region admin sees.
  test('Providers tab: the region-clamped Orgs table and Add org, no estate-wide config', async ({ page }) => {
    await signInAs(page, 'admin')
    await page.goto(`${baseUrl}/admin/reconciliation`)
    await page.waitForLoadState('networkidle')

    await page.click('[data-testid="admin-recon-tab-providers"]')
    await expect(page.locator('[data-testid="admin-recon-providers"]')).toBeVisible()

    // The region-clamped Orgs table (rows or its empty-state CTA) and its Add action.
    const orgs = page.locator('[data-testid="admin-recon-org-empty"], [data-testid^="admin-recon-org-"]').first()
    await expect(orgs).toBeVisible()
    await expect(page.locator('[data-testid="admin-recon-add-org"]')).toBeVisible()

    // Estate-wide provider config is not offered to a region admin.
    await expect(page.locator('[data-testid="admin-recon-add-enterprise"]')).toHaveCount(0)
    await expect(page.locator('[data-testid="admin-recon-ent-empty"]')).toHaveCount(0)
    await expect(page.locator('[data-testid="admin-recon-coverage-banner"]')).toHaveCount(0)
    // And nothing it no longer may read surfaces as a broken state.
    await expect(page.getByText('coverage unknown')).toHaveCount(0)
  })

  test('Add Org dialog: GitHub only for a region admin, with a working enterprise picker', async ({ page }) => {
    await signInAs(page, 'admin')
    await page.goto(`${baseUrl}/admin/reconciliation`)
    await page.waitForLoadState('networkidle')
    await page.click('[data-testid="admin-recon-tab-providers"]')

    await page.click('[data-testid="admin-recon-add-org"]')
    await expect(page.locator('[data-testid="provider-org-dialog"]')).toBeVisible()

    // Creating an Anthropic org assigns a credential and starts unmapped, both
    // platform-admin only, so a region admin starts on GitHub with no Anthropic
    // option, no credential field and no Discover, and is told why.
    await expect(page.locator('[data-testid="po-provider"]')).toHaveValue('github')
    await expect(page.locator('[data-testid="po-provider"] option[value="anthropic"]')).toHaveCount(0)
    await expect(page.locator('[data-testid="po-anthropic-platform-only"]')).toBeVisible()
    await expect(page.locator('[data-testid="po-cred"]')).toHaveCount(0)
    await expect(page.locator('[data-testid="po-discover"]')).toHaveCount(0)

    // GitHub: the enterprise picker reads the names-only enterprise list.
    await expect(page.locator('[data-testid="po-enterprise"]')).toBeVisible()
    await expect(page.locator('[data-testid="po-org-id-gh"]')).toBeVisible()

    await page.click('[data-testid="provider-org-cancel"]')
    await expect(page.locator('[data-testid="provider-org-dialog"]')).toHaveCount(0)
  })
})
