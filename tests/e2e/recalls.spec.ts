import { expect, test } from '@playwright/test'
import { authFile } from './helpers'

test.use({ storageState: authFile('owner') })
test('creates and explicitly selects a recall without allowing empty closure', async ({ page }) => {
  await page.goto('/inventory/recalls')
  await page.getByRole('button', { name: 'New recall' }).click()
  const title = `Local recall ${Date.now()}`
  await page.getByRole('textbox', { name: 'Title', exact: true }).fill(title)
  await page.getByRole('textbox', { name: 'Instructions', exact: true }).fill('Synthetic recall; no stock is scoped by this test.')
  await page.getByRole('button', { name: 'Create recall', exact: true }).click()
  await expect(page.getByRole('heading', { name: new RegExp(title) })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Close recall' })).toBeDisabled()
  await expect(page.getByRole('button', { name: 'Add batch to this recall' })).toBeDisabled()
  await page.reload()
  await expect(page.getByText(title, { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Close recall' })).toHaveCount(0)
})
