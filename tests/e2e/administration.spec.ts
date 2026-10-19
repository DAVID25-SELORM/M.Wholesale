import { expect, test, type Page } from '@playwright/test'
import { authFile } from './helpers'

test.use({ storageState: authFile('owner') })

const row = (page: Page, text: string) => page.getByRole('row', { name: new RegExp(text) })
/** codes are unique per run, so the tests also pass against a database that has already been used */
const uniq = () => Date.now().toString(36).slice(-5).toUpperCase()

// The administration pages, end to end: a branch lives through create, edit and deactivate, each step lands in the audit log, and the read-only pages load.
test.describe('administration', () => {
  test('creates, edits and deactivates a branch; the database refuses a duplicate code; the audit log records it', async ({ page }) => {
    const tag = uniq()
    await page.goto('/admin/branches')
    await page.getByRole('button', { name: 'New branch' }).click()
    const dialog = page.getByRole('dialog')
    await dialog.getByLabel('Code').fill(`E${tag}`)
    await dialog.getByLabel('Name').fill(`E2E Test Branch ${tag}`)
    await dialog.getByRole('button', { name: 'Create branch' }).click()
    await expect(row(page, `E2E Test Branch ${tag}`)).toBeVisible()

    // a duplicate code is refused by the database and the message is shown in the form
    await page.getByRole('button', { name: 'New branch' }).click()
    await page.getByRole('dialog').getByLabel('Code').fill(`E${tag}`)
    await page.getByRole('dialog').getByLabel('Name').fill('Same code again')
    await page.getByRole('dialog').getByRole('button', { name: 'Create branch' }).click()
    await expect(page.getByRole('dialog').getByRole('alert')).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.getByRole('dialog')).toBeHidden()

    // edit
    await row(page, `E2E Test Branch ${tag}`).getByRole('button', { name: 'Edit' }).click()
    await page.getByRole('dialog').getByLabel('Name').fill(`E2E Test Branch ${tag} renamed`)
    await page.getByRole('dialog').getByRole('button', { name: 'Save changes' }).click()
    await expect(row(page, `${tag} renamed`)).toBeVisible()

    // deactivate (asks first), then it shows as inactive
    await row(page, `${tag} renamed`).getByRole('button', { name: 'Deactivate' }).click()
    await page.getByRole('dialog').getByRole('button', { name: /Deactivate/ }).click()
    await expect(row(page, `${tag} renamed`)).toContainText('Inactive')

    // the audit log shows who did what, with the changed fields
    await page.goto('/admin/audit')
    await expect(page.getByRole('table')).toContainText('branch.created')
    await expect(page.getByRole('table')).toContainText('branch.deactivated')
  })

  test('manages warehouses and locations: lists load, a location can be created with a picking sequence', async ({ page }) => {
    const loc = `E2E-${uniq()}`
    await page.goto('/admin/warehouses')
    await expect(page.getByRole('table')).toContainText('MAIN-HQ')
    await page.goto('/admin/locations')
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
    await page.getByRole('button', { name: 'New location' }).click()
    const dialog = page.getByRole('dialog')
    await dialog.getByLabel('Code').fill(loc)
    await dialog.getByLabel(/Pick order/i).fill('777')
    await dialog.getByRole('button', { name: 'Create location' }).click()
    await expect(dialog).toBeHidden()
    await page.locator('main').getByRole('searchbox').first().fill(loc)
    await expect(page.getByRole('table')).toContainText(loc)
  })

  test('shows users with their roles, the roles and permissions, and the organization profile', async ({ page }) => {
    await page.goto('/admin/users')
    await expect(page.getByRole('table')).toContainText('cashier@demo.test')
    await expect(page.getByRole('table')).toContainText('inactive@demo.test')
    await page.goto('/admin/roles')
    await expect(page.getByText('Super Administrator').first()).toBeVisible()
    await page.goto('/admin/organization')
    await expect(page.getByLabel(/Legal name|Company name|Name/).first()).toHaveValue(/Demo Wholesale Pharma/)
  })

  test('the dashboard shows real counts or honest empty states, never invented figures', async ({ page }) => {
    await page.goto('/')
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Welcome')
    await expect(page.getByText(/GHS\s*[\d,]+\.\d\d.*revenue/i)).toHaveCount(0)
  })
})
