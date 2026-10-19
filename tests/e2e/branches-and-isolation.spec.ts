import { expect, test } from '@playwright/test'
import { accessToken, anonKey, authFile } from './helpers'

// Branch switching, and tenant isolation checked the way an attacker would: with a valid session of one organization, in the browser and straight at the API.
test.describe('branch switching', () => {
  test.describe('owner (organization-wide)', () => {
    test.use({ storageState: authFile('owner') })
    test('may choose all branches or either branch, and the choice sticks across a reload', async ({ page }) => {
      await page.goto('/')
      const select = page.locator('#branch-selector')
      await expect(select.locator('option').first()).toBeAttached()                           // the workspace has loaded
      const labels = await select.locator('option').allTextContents()
      expect(labels).toEqual(expect.arrayContaining(['All branches', 'Head Office', 'Kumasi Branch']))
      await select.selectOption({ label: 'Kumasi Branch' })
      await page.reload()
      await expect(page.locator('#branch-selector option:checked')).toHaveText('Kumasi Branch')
    })
  })

  test.describe('Kumasi branch manager (one branch only)', () => {
    test.use({ storageState: authFile('kumasiManager') })
    test('is offered only their own branch, and a tampered stored selection is ignored', async ({ page }) => {
      await page.addInitScript(() => localStorage.setItem('wps.selectedBranch', 'ALL'))      // pretend to have picked "all branches"
      await page.goto('/')
      const select = page.locator('#branch-selector')
      await expect(select.locator('option').first()).toBeAttached()
      expect(await select.locator('option').allTextContents()).toEqual(['Kumasi Branch'])
      await expect(select.locator('option:checked')).toHaveText('Kumasi Branch')
    })

    test('sees only their branch in the branch list, and none of the other branch in the warehouse list', async ({ page }) => {
      await page.goto('/admin/branches')
      await expect(page.getByRole('table')).toContainText('Kumasi Branch')
      await expect(page.getByRole('table')).not.toContainText('Head Office')
      await page.goto('/admin/warehouses')
      await expect(page.getByRole('table')).toContainText('MAIN-KUM')
      await expect(page.getByRole('table')).not.toContainText('MAIN-HQ')
    })

    test('cannot read or change the other branch even by calling the API directly', async ({ page }) => {
      await page.goto('/')
      const token = await accessToken(page)
      const headers = { apikey: anonKey(), Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Prefer: 'return=representation' }
      const rows = await (await page.request.get('/rest/v1/branches?select=name,is_head_office', { headers })).json()
      expect(rows.map((r: { name: string }) => r.name)).toEqual(['Kumasi Branch'])
      const patched = await page.request.patch('/rest/v1/branches?is_head_office=is.true', { headers, data: { name: 'pwned' } })
      expect(await patched.json()).toEqual([])
    })
  })
})

test.describe('tenant isolation', () => {
  test.describe('organization B owner', () => {
    test.use({ storageState: authFile('otherOwner') })

    test('sees only their own organization in the screens', async ({ page }) => {
      await page.goto('/admin/branches')
      await expect(page.getByRole('table')).not.toContainText('Kumasi Branch')
      await page.goto('/admin/users')
      await expect(page.getByRole('table')).not.toContainText('owner@demo.test')
      await expect(page.getByRole('table')).toContainText('Other')
      await page.goto('/admin/organization')
      await expect(page.locator('input').first()).not.toHaveValue(/Demo Wholesale/)
    })

    test('cannot read, change or insert into organization A through the API, whatever ids or organization_id are sent', async ({ page, browser }) => {
      await page.goto('/')
      const tokenB = await accessToken(page)
      const hB = { apikey: anonKey(), Authorization: `Bearer ${tokenB}`, 'Content-Type': 'application/json', Prefer: 'return=representation' }

      // learn organization A's ids the legitimate way, as A's owner
      const ctxA = await browser.newContext({ storageState: authFile('owner'), baseURL: 'http://127.0.0.1:5273' })
      const pageA = await ctxA.newPage()
      await pageA.goto('/')
      const tokenA = await accessToken(pageA)
      const hA = { apikey: anonKey(), Authorization: `Bearer ${tokenA}`, 'Content-Type': 'application/json' }
      const orgA = (await (await pageA.request.get('/rest/v1/organizations?select=id,name', { headers: hA })).json())[0] as { id: string; name: string }
      const kumasi = (await (await pageA.request.get('/rest/v1/branches?select=id&name=eq.Kumasi%20Branch', { headers: hA })).json())[0] as { id: string }
      expect(orgA.name).toContain('Demo Wholesale')

      for (const table of ['branches', 'warehouses', 'warehouse_locations', 'profiles', 'user_roles', 'audit_logs', 'system_settings', 'customers', 'products', 'stock_balances', 'sales_invoices', 'gl_journals']) {
        const res = await page.request.get(`/rest/v1/${table}?select=organization_id&organization_id=eq.${orgA.id}`, { headers: hB })
        const body = await res.json()
        expect(Array.isArray(body) && body.length === 0, `${table} leaked organization A rows`).toBe(true)
      }
      expect(await (await page.request.get(`/rest/v1/branches?id=eq.${kumasi.id}&select=id`, { headers: hB })).json()).toEqual([])
      expect(await (await page.request.patch(`/rest/v1/branches?id=eq.${kumasi.id}`, { headers: hB, data: { name: 'pwned' } })).json()).toEqual([])
      expect(await (await page.request.patch(`/rest/v1/organizations?id=eq.${orgA.id}`, { headers: hB, data: { name: 'pwned' } })).json()).toEqual([])
      const spoof = await page.request.post('/rest/v1/branches', { headers: hB, data: { organization_id: orgA.id, code: 'EVIL', name: 'Planted in A' } })
      expect(spoof.ok()).toBe(false)                                                          // organization_id spoofing is refused
      const rpc = await page.request.post('/rest/v1/rpc/assign_user_role', { headers: hB, data: { p_user_id: orgA.id, p_role_id: orgA.id } })
      expect(rpc.ok()).toBe(false)

      // organization A is unchanged
      const after = await (await pageA.request.get(`/rest/v1/branches?id=eq.${kumasi.id}&select=name`, { headers: hA })).json()
      expect(after).toEqual([{ name: 'Kumasi Branch' }])
      expect((await (await pageA.request.get('/rest/v1/branches?code=eq.EVIL&select=id', { headers: hA })).json()).length).toBe(0)
      await ctxA.close()
    })
  })
})
