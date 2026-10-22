import { expect, test, type Page } from '@playwright/test'
import { authFile } from './helpers'

test.use({ storageState: authFile('owner') })

// The layout at the five widths people really use: no sideways scrolling of the page, the menu reachable, and dialogs inside the screen.
const SIZES = [
  { name: 'desktop 1440', width: 1440, height: 900 },
  { name: 'laptop 1024', width: 1024, height: 768 },
  { name: 'tablet 768', width: 768, height: 1024 },
  { name: 'mobile 390', width: 390, height: 844 },
  { name: 'small mobile 375', width: 375, height: 812 },
]
const PAGES = [
  '/', '/admin/branches', '/admin/users', '/admin/audit', '/admin/settings', '/catalog/products', '/sales/invoices', '/sales/customers', '/sales/receivables',
  '/pos', '/inventory/stock', '/inventory/expiry', '/purchasing/orders', '/reports/sales', '/reports/stock', '/accounting', '/accounting/statements', '/accounting/bank',
  '/delivery/drivers', '/delivery/vehicles', '/warehouse/picking',
]

async function overflow(page: Page) {
  return page.evaluate(() => {
    const scrollable = (el: Element) => { for (let e = el.parentElement; e && e !== document.body; e = e.parentElement) if (/(auto|scroll|hidden)/.test(getComputedStyle(e).overflowX)) return true; return false }
    const offenders: string[] = []
    for (const el of document.querySelectorAll('body *')) {
      const r = el.getBoundingClientRect()
      if (r.width > 0 && r.height > 0 && r.right > window.innerWidth + 1 && !scrollable(el)) { offenders.push(`${el.tagName.toLowerCase()}.${String(el.className).slice(0, 40)}`); if (offenders.length > 2) break }
    }
    return { page: document.documentElement.scrollWidth - window.innerWidth, offenders }
  })
}

for (const size of SIZES) {
  test.describe(size.name, () => {
    test.use({ viewport: { width: size.width, height: size.height } })

    test('no page scrolls sideways and every page has its heading', async ({ page }) => {
      const problems: string[] = []                                                          // collect every page's problem, not just the first
      for (const path of PAGES) {
        await page.goto(path)
        await expect(page.getByRole('heading', { level: 1 }).first(), `${path} has no heading`).toBeVisible()
        await page.waitForLoadState('networkidle')
        const o = await overflow(page)
        if (o.page > 0 || o.offenders.length > 0) problems.push(`${path}: scrolls sideways by ${o.page}px; beyond the edge: ${o.offenders.join(' | ')}`)
      }
      expect(problems).toEqual([])
    })

    test('the menu is reachable and a dialog fits the screen', async ({ page }) => {
      await page.goto('/admin/branches')
      if (size.width < 1024) {
        await page.getByRole('button', { name: 'Open navigation menu' }).click()
        const drawer = page.getByRole('complementary', { name: 'Navigation menu' })
        await expect(drawer.getByRole('link', { name: 'Dashboard' })).toBeVisible()
        await page.getByRole('button', { name: 'Close navigation menu' }).first().click()
      } else {
        await expect(page.getByRole('link', { name: 'Branches', exact: true })).toBeVisible()
      }
      await page.getByRole('button', { name: 'New branch' }).click()
      const dialog = page.getByRole('dialog')
      await expect(dialog).toBeVisible()
      const box = (await dialog.boundingBox())!
      expect(box.x).toBeGreaterThanOrEqual(-1)
      expect(box.x + box.width).toBeLessThanOrEqual(size.width + 1)
      expect(box.y + box.height).toBeLessThanOrEqual(size.height + 1)
      await expect(dialog.getByRole('button', { name: 'Create branch' })).toBeInViewport()               // the action is never pushed off the screen
    })
  })
}

test.describe('a document preview (the invoice page)', () => {
  for (const size of [SIZES[0]!, SIZES[2]!, SIZES[4]!]) {
    test(`fits at ${size.name}`, async ({ browser }) => {
      const ctx = await browser.newContext({ storageState: authFile('owner'), viewport: { width: size.width, height: size.height }, baseURL: 'http://127.0.0.1:5273' })
      const page = await ctx.newPage()
      await page.goto('/sales/invoices')
      await page.getByRole('table').getByRole('link').first().click()
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
      await page.waitForLoadState('networkidle')
      const o = await overflow(page)
      expect(o.page).toBeLessThanOrEqual(0)
      expect(o.offenders).toEqual([])
      await ctx.close()
    })
  }
})
