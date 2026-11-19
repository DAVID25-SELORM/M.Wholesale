import { expect, test, type Page } from '@playwright/test'
import { accessToken, anonKey, authFile } from './helpers'

test.describe.configure({ mode: 'serial' })

// Cold-chain temperature logging in a browser: record in range, record out of range, the excursion needs a different decider.
test.describe('cold chain', () => {
  test.use({ storageState: authFile('owner') })
  let packageNumber = ''

  async function api(page: Page) {
    const headers = { apikey: anonKey(), Authorization: `Bearer ${await accessToken(page)}`, 'Content-Type': 'application/json' }
    return {
      get: async (path: string) => (await (await page.request.get(`/rest/v1/${path}`, { headers })).json()) as any[],
      rpc: async (fn: string, data: object) => { const r = await page.request.post(`/rest/v1/rpc/${fn}`, { headers, data }); const t = await r.text(); expect(r.ok(), `${fn}: ${t}`).toBeTruthy(); return t ? JSON.parse(t) : null },
    }
  }

  test.beforeAll(async ({ browser }) => {
    const page = await browser.newPage({ storageState: authFile('owner'), baseURL: 'http://127.0.0.1:5273' })
    await page.goto('/')
    const a = await api(page)
    const posted = await a.get('sales_invoices?select=id&status=eq.POSTED&is_opening=is.false&order=created_at')
    const live = await a.get('fulfilment_orders?select=id,sales_invoice_id&status=neq.CANCELLED')
    const free = posted.find((i) => !live.some((o) => o.sales_invoice_id === i.id)) ?? posted[0]
    for (const o of live.filter((x) => x.sales_invoice_id === free.id)) await a.rpc('cancel_fulfilment_order', { p_id: o.id, p_reason: 'e2e reset' })
    const order = await a.rpc('release_to_warehouse', { p_invoice_id: free.id, p_priority: 2 })
    const orderId = typeof order === 'string' ? order : order.id ?? order
    await a.rpc('claim_fulfilment_order', { p_id: orderId })
    const lines = await a.get(`pick_lines?select=id,product_id,expected_quantity&fulfilment_order_id=eq.${orderId}`)
    for (const l of lines) {
      const r = await page.request.patch(`/rest/v1/products?id=eq.${l.product_id}`, { headers: { apikey: anonKey(), Authorization: `Bearer ${await accessToken(page)}`, 'Content-Type': 'application/json' }, data: { storage_condition: 'REFRIGERATED' } })
      expect(r.ok(), await r.text()).toBeTruthy()
    }
    for (const l of lines) await a.rpc('confirm_pick_line', { p_line_id: l.id, p_quantity: l.expected_quantity })
    await a.rpc('start_packing', { p_id: orderId })
    const pkg = await a.rpc('create_package', { p_id: orderId, p_kind: 'COOL_BOX', p_cold_chain: true, p_fragile: false })
    for (const l of lines) await a.rpc('pack_line', { p_package_id: pkg, p_line_id: l.id, p_quantity: l.expected_quantity })
    packageNumber = (await a.get(`packages?select=package_number&id=eq.${pkg}`))[0].package_number
    await page.close()
  })

  test('records an in-range reading, then an out-of-range reading that opens an excursion only a different person can decide', async ({ page }) => {
    await page.goto('/warehouse/cold-chain')
    await expect(page.getByRole('heading', { level: 1, name: 'Cold chain' })).toBeVisible()
    const value = await page.getByLabel('Cold-chain package').locator('option', { hasText: packageNumber }).first().getAttribute('value')
    await page.getByLabel('Cold-chain package').selectOption(value!)
    await page.getByLabel('Temperature (°C)').fill('4.5')
    await page.getByRole('button', { name: 'Record temperature' }).click()
    await expect(page.getByRole('status')).toContainText(/within the/i)
    await page.getByLabel('Temperature (°C)').fill('15')
    await page.getByRole('button', { name: 'Record temperature' }).click()
    await expect(page.getByRole('status')).toContainText(/outside the .* range/i)
    await expect(page.getByText('Needs decision').first()).toBeVisible()
    await page.getByRole('button', { name: 'Accept for use' }).first().click()
    await page.getByLabel('Reason').fill('Owner tries to accept own reading')
    await page.getByRole('button', { name: 'Confirm decision' }).click()
    await expect(page.getByRole('alert')).toContainText(/different person/i)
  })

  test.describe('without temperature permission', () => {
    test.use({ storageState: authFile('cashier') })
    test('the cashier has no cold-chain menu entry and the page shows unauthorized', async ({ page }) => {
      await page.goto('/')
      await expect(page.locator('aside').first().getByRole('link', { name: 'Cold chain' })).toHaveCount(0)
      await page.goto('/warehouse/cold-chain')
      await expect(page.getByRole('heading', { name: /don.t have access to this page/i })).toBeVisible()
      await expect(page.getByRole('table')).toHaveCount(0)
    })
  })
})
