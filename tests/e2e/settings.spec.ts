import { expect, test, type Page } from '@playwright/test'
import { authFile } from './helpers'

test.use({ storageState: authFile('owner') })
test.describe.configure({ mode: 'serial' })

const tab = (page: Page, name: string) => page.getByRole('tab', { name })

// The Settings module in a browser: validation, persistence, the reason required for security settings, numbering, and the audit trail.
test.describe('settings', () => {
  test('saves a value, keeps it across a reload, and uses it as the default for a new customer', async ({ page }) => {
    await page.goto('/admin/settings')
    await tab(page, 'Sales and credit').click()
    const terms = page.getByLabel('Default payment terms for new customers')
    const next = (await terms.inputValue()) === '14' ? '15' : '14'                           // always a change, so the test also passes on a used database
    await terms.fill(next)
    await page.getByRole('button', { name: 'Save' }).first().click()
    await expect(page.getByText('Saved.').first()).toBeVisible()
    await page.reload()
    await tab(page, 'Sales and credit').click()
    await expect(page.getByLabel('Default payment terms for new customers')).toHaveValue(next)
    // the setting is really used: a new customer starts with those terms
    await page.goto('/sales/customers')
    await page.getByRole('button', { name: 'New customer' }).click()
    await expect(page.getByRole('dialog').getByLabel(/Payment terms/)).toHaveValue(next)
  })

  test('refuses out-of-range values before sending, with the rule stated', async ({ page }) => {
    await page.goto('/admin/settings')
    await tab(page, 'Sales and credit').click()
    const terms = page.getByLabel('Default payment terms for new customers')
    await terms.fill('400')
    await expect(page.getByText('At most 365.')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Save' }).first()).toBeDisabled()
    await terms.fill('7.5')
    await expect(page.getByText('Whole numbers only.')).toBeVisible()
  })

  test('a security setting needs a reason, which is stored with the audit entry', async ({ page }) => {
    await page.goto('/admin/settings')
    await tab(page, 'Security and session').click()
    const idle = page.getByLabel('Sign out after inactivity')
    await idle.fill('3')
    await expect(page.getByText('Use 0 (off) or at least 5.')).toBeVisible()
    await idle.fill('45')
    await page.getByRole('button', { name: 'Save' }).click()
    await page.getByRole('dialog').getByRole('button', { name: 'Confirm' }).click()
    await expect(page.getByRole('dialog').getByRole('alert')).toBeVisible()                   // no reason yet
    await page.getByRole('dialog').getByLabel(/Reason/).fill('E2E: shared counter computers')
    await page.getByRole('dialog').getByRole('button', { name: 'Confirm' }).click()
    await expect(page.getByText('Saved.').first()).toBeVisible()
    // put it back (also needs a reason) so the rest of the run is not signed out
    await page.getByRole('button', { name: 'Reset to default' }).click()
    await page.getByRole('dialog').getByLabel(/Reason/).fill('E2E: restore the default')
    await page.getByRole('dialog').getByRole('button', { name: 'Confirm' }).click()
    await expect(page.getByText('Back to the default.').first()).toBeVisible()
    await page.goto('/admin/audit')
    await expect(page.getByRole('table')).toContainText('system_setting')
  })

  test('document numbering: shows the next number, previews a change, rejects a bad prefix, saves a good one', async ({ page }) => {
    await page.goto('/admin/settings')
    await tab(page, 'Document numbering').click()
    const invoices = page.getByRole('row', { name: /Sales invoices/ })
    const shown = (await invoices.textContent())!.match(/-(\d{4})-(\d+)/)!                         // the next number as the screen shows it: PREFIX-year-counter
    expect(shown).not.toBeNull()
    const prefix = `T${Date.now().toString(36).slice(-5).toUpperCase()}`                        // unique per run
    await invoices.getByRole('button', { name: 'Edit' }).click()
    const dialog = page.getByRole('dialog')
    await dialog.getByLabel(/Prefix/).fill('bad prefix!')
    await dialog.getByRole('button', { name: 'Save' }).click()
    await expect(dialog.getByRole('alert')).toContainText(/prefix/i)
    await dialog.getByLabel(/Prefix/).fill(prefix.toLowerCase())
    await expect(dialog).toContainText(`${prefix}-${shown[1]}-${shown[2]}`)                       // same year and counter, new prefix
    await dialog.getByRole('button', { name: 'Save' }).click()
    await expect(page.getByRole('row', { name: /Sales invoices/ })).toContainText(`${prefix}-`)
    // another document cannot take the same prefix (the database refuses it and the message is shown)
    await page.getByRole('row', { name: /Sales orders/ }).getByRole('button', { name: 'Edit' }).click()
    await page.getByRole('dialog').getByLabel(/Prefix/).fill(prefix)
    await page.getByRole('dialog').getByRole('button', { name: 'Save' }).click()
    await expect(page.getByRole('dialog').getByRole('alert')).toContainText(/already uses the prefix/i)
  })

  test('notifications and integrations are honest placeholders with nothing to configure', async ({ page }) => {
    await page.goto('/admin/settings')
    await tab(page, 'Notifications and integrations').click()
    await expect(page.getByText(/nothing to configure/i)).toBeVisible()
    await expect(page.getByText('Not connected')).toHaveCount(3)
  })
})
