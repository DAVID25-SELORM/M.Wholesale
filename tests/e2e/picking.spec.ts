import { expect, test, type Page } from '@playwright/test'
import { accessToken, anonKey, authFile } from './helpers'

test.describe.configure({ mode: 'serial' })

// Picking in a browser: release an invoice, claim, pick in full, short pick with a reason, supervisor resolution, cancel.
test.describe('picking', () => {
  test.use({ storageState: authFile('owner') })
  let invoiceId = ''
  let invoiceNumber = ''

  async function api(page: Page) {
    const headers = { apikey: anonKey(), Authorization: `Bearer ${await accessToken(page)}`, 'Content-Type': 'application/json' }
    return {
      get: async (path: string) => (await (await page.request.get(`/rest/v1/${path}`, { headers })).json()) as any[],
      rpc: (fn: string, data: object) => page.request.post(`/rest/v1/rpc/${fn}`, { headers, data }),
    }
  }

  test.beforeAll(async ({ browser }) => {
    const page = await browser.newPage({ storageState: authFile('owner'), baseURL: 'http://127.0.0.1:5273' })
    await page.goto('/')
    const a = await api(page)
    const posted = await a.get('sales_invoices?select=id,invoice_number,is_opening&status=eq.POSTED&is_opening=is.false&order=created_at')
    expect(posted.length, 'the seed has at least one posted invoice').toBeGreaterThan(0)
    const live = await a.get('fulfilment_orders?select=id,sales_invoice_id&status=neq.CANCELLED')
    const free = posted.find((i) => !live.some((o) => o.sales_invoice_id === i.id))
    const chosen = free ?? posted[0]
    if (!free) for (const o of live.filter((x) => x.sales_invoice_id === chosen.id)) await a.rpc('cancel_fulfilment_order', { p_id: o.id, p_reason: 'e2e reset' })
    invoiceId = chosen.id
    invoiceNumber = chosen.invoice_number
    await page.close()
  })

  async function release(page: Page) {
    await page.goto(`/sales/invoices/${invoiceId}`)
    await page.getByRole('button', { name: 'Release to warehouse' }).click()
    await page.getByRole('dialog').getByRole('button', { name: 'Release' }).click()
    await expect(page).toHaveURL(/\/warehouse\/picking\/[0-9a-f-]{36}$/)
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(/^FO-\d{4}-\d{6}$/)
  }
  async function confirmAll(page: Page) {
    const buttons = page.getByRole('button', { name: 'Confirm picked' })
    for (let guard = 0; guard < 20; guard++) {
      const n = await buttons.count()
      if (n === 0) break
      await buttons.first().click()
      await expect(buttons).toHaveCount(n - 1)                                                       // the confirmed line no longer offers a form
    }
  }

  test('releases an invoice, claims it, picks every line, and the order becomes Picked', async ({ page }) => {
    await release(page)
    await expect(page.getByText('Waiting to pick').first()).toBeVisible()
    await expect(page.getByRole('list', { name: 'Pick lines in walking order' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Confirm picked' })).toHaveCount(0)               // nothing can be confirmed before claiming
    await page.getByRole('button', { name: 'Claim this order' }).click()
    await expect(page.getByText('Being picked').first()).toBeVisible()
    await confirmAll(page)
    await expect(page.getByText('Picked', { exact: true }).first()).toBeVisible()
    await page.goto('/warehouse/picking')
    await page.getByLabel('Order status').selectOption('PICKED')
    await expect(page.getByRole('table')).toContainText('FO-')
  })

  test('the invoice page links to its order and no longer offers a release', async ({ page }) => {
    await page.goto(`/sales/invoices/${invoiceId}`)
    await expect(page.getByRole('link', { name: /^FO-\d{4}-\d{6}/ })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Release to warehouse' })).toHaveCount(0)
    expect(invoiceNumber).toBeTruthy()
  })

  test('a short pick needs a reason; the order stays open until a supervisor accepts it', async ({ page }) => {
    await page.goto(`/sales/invoices/${invoiceId}`)
    await page.getByRole('link', { name: /^FO-\d{4}-\d{6}/ }).click()
    await page.getByRole('button', { name: 'Cancel order' }).click()
    await page.getByRole('dialog').getByLabel('Reason').fill('Re-pick for the e2e test')
    await page.getByRole('dialog').getByRole('button', { name: 'Cancel order' }).click()
    await expect(page.getByText('Order cancelled.').first()).toBeVisible()
    await release(page)
    await page.getByRole('button', { name: 'Claim this order' }).click()
    await expect(page.getByText('Being picked').first()).toBeVisible()
    const first = page.getByLabel('Quantity picked').first()
    await first.fill('0')
    await page.getByRole('button', { name: 'Confirm short pick' }).first().click()
    await expect(page.getByText('Say why it is short.')).toBeVisible()
    await page.getByLabel('Why is it short?').first().selectOption('NOT_FOUND')
    await page.getByRole('button', { name: 'Confirm short pick' }).first().click()
    await expect(page.getByText('Line confirmed').first()).toBeVisible()
    await confirmAll(page)
    await expect(page.getByText(/short pick is waiting for a supervisor/)).toBeVisible()
    await expect(page.getByText('Being picked').first()).toBeVisible()
    await page.getByRole('button', { name: 'Accept short pick' }).click()
    await page.getByRole('dialog').getByLabel('Reason').fill('Customer agreed to the short quantity')
    await page.getByRole('dialog').getByRole('button', { name: 'Accept short pick' }).click()
    await expect(page.getByText('Short pick accepted.').first()).toBeVisible()
    await expect(page.getByText('Picked', { exact: true }).first()).toBeVisible()
  })
})

test.describe('picking: access', () => {
  test.use({ storageState: authFile('cashier') })
  test('a cashier does not get the picking screens', async ({ page }) => {
    await page.goto('/warehouse/picking')
    await expect(page.getByRole('heading', { name: 'Picking' })).toHaveCount(0)
    await expect(page.getByRole('table')).toHaveCount(0)
  })
})

test.describe('picking: another organization', () => {
  test.use({ storageState: authFile('otherOwner') })
  test('sees an empty queue, never the demo organization\'s orders', async ({ page }) => {
    await page.goto('/warehouse/picking')
    await expect(page.getByRole('heading', { name: 'Picking' })).toBeVisible()
    await expect(page.getByText('Nothing waiting to be picked')).toBeVisible()
    await page.getByLabel('Order status').selectOption('')
    await expect(page.getByText('No orders match')).toBeVisible()
  })
})
