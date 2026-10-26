import { expect, test } from '@playwright/test'
import { accessToken, anonKey, authFile } from './helpers'

test.use({ storageState: authFile('owner') })
test('plans and completes a local synthetic delivery run through the screens', async ({ page }) => {
  test.setTimeout(180_000)
  await page.goto('/')
  const headers = { apikey: anonKey(), Authorization: `Bearer ${await accessToken(page)}`, 'Content-Type': 'application/json' }
  const get = async (path: string) => {
    const r = await page.request.get(`/rest/v1/${path}`, { headers }); expect(r.ok()).toBeTruthy(); return r.json()
  }
  const rpc = async (name: string, data: object) => {
    const r = await page.request.post(`/rest/v1/rpc/${name}`, { headers, data }); expect(r.ok(), await r.text()).toBeTruthy(); const body = await r.text(); return body ? JSON.parse(body) : null
  }
  const insert = async (table: string, data: object) => {
    const r = await page.request.post(`/rest/v1/${table}?select=id`, { headers: { ...headers, Prefer: 'return=representation' }, data }); expect(r.ok(), await r.text()).toBeTruthy(); return (await r.json())[0].id
  }
  const wh = (await get('warehouses?select=id,branch_id&code=eq.MAIN-HQ'))[0]
  const product = (await get('products?select=id&sku=eq.PANADOL-500-100'))[0]
  const customer = (await get('customers?select=id&code=eq.ADOM'))[0]
  const invoice = await rpc('save_sales_invoice', { p_id: null, p_customer_id: customer.id, p_warehouse_id: wh.id, p_customer_reference: 'LOCAL-RUN-TEST', p_notes: null, p_lines: [{ product_id: product.id, quantity: 1 }] })
  await rpc('post_sales_invoice', { p_id: invoice })
  const order = await rpc('release_to_warehouse', { p_invoice_id: invoice })
  await rpc('claim_fulfilment_order', { p_id: order })
  const lines = await rpc('fulfilment_pick_list', { p_id: order })
  for (const l of lines) await rpc('confirm_pick_line', { p_line_id: l.line_id, p_quantity: l.expected_quantity })
  await rpc('start_packing', { p_id: order })
  const pkg = await rpc('create_package', { p_id: order, p_kind: 'CARTON' })
  for (const l of lines) await rpc('pack_line', { p_package_id: pkg, p_line_id: l.line_id, p_quantity: l.expected_quantity })
  await rpc('finish_packing', { p_id: order })
  const note = await rpc('prepare_packed_delivery', { p_id: order, p_address: 'Local test address', p_contact_name: 'Test receiver', p_contact_phone: '000', p_notes: 'Synthetic test only' })
  const suffix = Date.now().toString(36).toUpperCase()
  const future = new Date(Date.now() + 365 * 86400000).toISOString().slice(0, 10)
  const driver = await insert('drivers', { branch_id: wh.branch_id, code: `E${suffix}`, name: `Test driver ${suffix}`, licence_number: 'TEST', licence_expiry: future })
  const vehicle = await insert('vehicles', { branch_id: wh.branch_id, registration_number: `E${suffix}`, capacity_packages: 20, capacity_kg: 200, insurance_expiry: future, roadworthy_expiry: future })
  await page.goto('/delivery/runs')
  await page.getByRole('button', { name: 'New run' }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByLabel('Branch').selectOption(wh.branch_id)
  await dialog.getByLabel('Driver', { exact: true }).selectOption(driver)
  await dialog.getByLabel('Vehicle', { exact: true }).selectOption(vehicle)
  await dialog.getByRole('button', { name: 'Create run' }).click()
  await expect(page).toHaveURL(/\/delivery\/runs\/[0-9a-f-]{36}$/)
  const runUrl = page.url()
  await page.getByLabel('Delivery note', { exact: true }).selectOption(note)
  await page.getByLabel('Measured load weight (kg)').fill('5')
  await page.getByRole('button', { name: 'Add stop' }).click()
  await expect(page.getByText('Local test address')).toBeVisible()
  await page.getByRole('button', { name: 'Start loading' }).click()
  await page.getByRole('button', { name: 'Confirm loaded packages' }).click()
  await page.getByLabel('Packages counted').fill('1')
  await page.getByRole('button', { name: 'Confirm load', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Dispatch run' })).toBeEnabled()
  await page.getByRole('button', { name: 'Dispatch run' }).click()
  await page.getByRole('button', { name: 'Record delivery outcome' }).click()
  await page.getByLabel('Received by').fill('Test receiver')
  await page.getByRole('button', { name: 'Save outcome' }).click()
  await expect(page.getByText('COMPLETED', { exact: true })).toBeVisible()
  expect((await get(`delivery_notes?select=status&id=eq.${note}`))[0].status).toBe('DELIVERED')
  const foreignContext = await page.context().browser()!.newContext({ storageState: authFile('otherOwner') })
  const foreign = await foreignContext.newPage()
  await foreign.goto(runUrl)
  await expect(foreign.getByText('Run not found')).toBeVisible()
  await foreignContext.close()
})
