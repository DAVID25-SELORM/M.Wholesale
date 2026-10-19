import { expect, test } from '@playwright/test'
import { authFile } from './helpers'

test.describe.configure({ mode: 'serial' })

const stamp = Date.now().toString(36).toUpperCase()

// Drivers and vehicles in a browser: create, validation, expiry badges, deactivation.
test.describe('fleet', () => {
  test.use({ storageState: authFile('owner') })

  test('creates a driver with an expired licence, shows the expired badge, and deactivates them', async ({ page }) => {
    await page.goto('/delivery/drivers')
    await page.getByRole('button', { name: 'New driver' }).click()
    const dlg = page.getByRole('dialog')
    await dlg.getByLabel('Code').fill(`E${stamp}`)
    await dlg.getByLabel('Name').fill(`Test Driver ${stamp}`)
    await dlg.getByLabel('Licence expiry').fill('2020-01-31')
    await dlg.getByRole('button', { name: 'Create driver' }).click()
    await expect(page.getByText('Driver created.').first()).toBeVisible()
    await page.getByLabel('Search drivers').fill(stamp)
    const row = page.getByRole('row', { name: new RegExp(`Test Driver ${stamp}`) })
    await expect(row.getByText('Expired')).toBeVisible()
    await row.getByRole('button', { name: 'Deactivate' }).click()
    await page.getByRole('dialog').getByRole('button', { name: 'Deactivate' }).click()
    await expect(page.getByText('Driver deactivated.').first()).toBeVisible()
  })

  test('a duplicate driver code is refused with a message', async ({ page }) => {
    await page.goto('/delivery/drivers')
    await page.getByRole('button', { name: 'New driver' }).click()
    const dlg = page.getByRole('dialog')
    await dlg.getByLabel('Code').fill(`E${stamp}`)
    await dlg.getByLabel('Name').fill('Duplicate')
    await dlg.getByRole('button', { name: 'Create driver' }).click()
    await expect(dlg.getByRole('alert').first()).toBeVisible()
  })

  test('creates a vehicle, validates the registration before sending, and shows a valid insurance badge', async ({ page }) => {
    await page.goto('/delivery/vehicles')
    await page.getByRole('button', { name: 'New vehicle' }).click()
    const dlg = page.getByRole('dialog')
    await dlg.getByLabel('Registration number').fill('x')
    await dlg.getByRole('button', { name: 'Create vehicle' }).click()
    await expect(dlg.getByText(/Use 3–20 letters/)).toBeVisible()
    const reg = `GT-${stamp}`
    await dlg.getByLabel('Registration number').fill(reg)
    await dlg.getByLabel('Insurance expiry').fill('2099-01-01')
    await dlg.getByRole('button', { name: 'Create vehicle' }).click()
    await expect(page.getByText('Vehicle created.').first()).toBeVisible()
    await page.getByLabel('Search vehicles').fill(stamp)
    await expect(page.getByRole('row', { name: new RegExp(reg) }).getByText('Valid').first()).toBeVisible()
  })

  test('the warning window setting is on the Delivery tab of Settings', async ({ page }) => {
    await page.goto('/admin/settings')
    await page.getByRole('tab', { name: 'Delivery' }).click()
    await expect(page.getByLabel('Licence and insurance warning window')).toBeVisible()
  })
})

test.describe('fleet: people without the right', () => {
  test.use({ storageState: authFile('cashier') })

  test('a cashier typing the address sees the unauthorized page, not data', async ({ page }) => {
    await page.goto('/delivery/drivers')
    await expect(page.getByRole('heading', { name: 'Drivers' })).toHaveCount(0)
    await expect(page).toHaveURL(/unauthorized|delivery\/drivers/)
    await expect(page.getByRole('button', { name: 'New driver' })).toHaveCount(0)
  })
})
