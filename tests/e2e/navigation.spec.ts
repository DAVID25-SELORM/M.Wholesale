import { expect, test, type Page } from '@playwright/test'
import { authFile } from './helpers'

const nav = (page: Page) => page.locator('aside').first()

// Permission-aware navigation and protected routes. The menu is a convenience; the unauthorized page proves the route itself is guarded.
test.describe('owner', () => {
  test.use({ storageState: authFile('owner') })
  test('sees the administration, accounting and settings entries, and future modules as non-links marked Soon', async ({ page }) => {
    await page.goto('/')
    for (const name of ['Users', 'Roles & permissions', 'Audit log', 'Application errors', 'Settings', 'Organization', 'Branches']) {
      await expect(nav(page).getByRole('link', { name, exact: true })).toBeVisible()
    }
    await page.getByRole('button', { name: /Accounting/ }).first().click().catch(() => undefined)
    await expect(nav(page).getByText('Soon').first()).toBeVisible()
    await expect(nav(page).getByRole('link', { name: 'Approvals' })).toHaveCount(0)             // a planned module has no route
  })
})

test.describe('cashier', () => {
  test.use({ storageState: authFile('cashier') })
  test('does not see administration pages, and typing their address shows the unauthorized page, not data', async ({ page }) => {
    await page.goto('/')
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
    for (const name of ['Users', 'Roles & permissions', 'Audit log', 'Settings', 'Application errors']) {
      await expect(nav(page).getByRole('link', { name, exact: true })).toHaveCount(0)
    }
    for (const path of ['/admin/users', '/admin/audit', '/admin/settings', '/admin/errors', '/accounting', '/admin/roles']) {
      await page.goto(path)
      await expect(page.getByRole('heading', { name: /don.t have access to this page/i })).toBeVisible()
      await expect(page.getByRole('table')).toHaveCount(0)
    }
  })
})

test.describe('auditor (view-only)', () => {
  test.use({ storageState: authFile('auditor') })
  test('can read the audit log and the settings, but the settings are read-only', async ({ page }) => {
    await page.goto('/admin/audit')
    await expect(page.getByRole('heading', { name: 'Audit log' })).toBeVisible()
    await page.goto('/admin/settings')
    await expect(page.getByText(/view settings but not change them/i)).toBeVisible()
    await expect(page.getByRole('button', { name: 'Save' })).toHaveCount(0)
  })
})
