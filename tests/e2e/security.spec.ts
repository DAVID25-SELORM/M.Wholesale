import { createHmac } from 'node:crypto'
import { expect, test } from '@playwright/test'
import { accessToken, anonKey, authFile, signIn, USERS } from './helpers'

/** RFC 6238 one-time code for a base32 secret, as an authenticator app would show it. */
function totp(secret: string, at = Date.now()): string {
  let bits = ''
  for (const c of secret.replace(/=+$/, '').toUpperCase()) bits += 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'.indexOf(c).toString(2).padStart(5, '0')
  const key = Buffer.from(bits.match(/.{8}/g)!.map((b) => parseInt(b, 2)))
  const counter = Buffer.alloc(8)
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 30000)))
  const h = createHmac('sha1', key).update(counter).digest()
  const o = h[h.length - 1]! & 0xf
  return String((h.readUInt32BE(o) & 0x7fffffff) % 1_000_000).padStart(6, '0')
}

/** On a phone the box sits behind a button. */
async function openSearch(page: import('@playwright/test').Page) {
  const toggle = page.getByRole('button', { name: 'Open search' })
  await expect(page.getByRole('button', { name: 'User menu' })).toBeVisible()
  if (await toggle.isVisible()) await toggle.click()
  return page.getByRole('combobox', { name: 'Global search' })
}

test.describe('global search', () => {
  test.use({ storageState: authFile('owner') })
  test('finds a product by name and opens it, and says so when nothing matches', async ({ page }) => {
    await page.goto('/')
    let box = await openSearch(page)
    await box.fill('panadol')
    await page.getByRole('option').filter({ hasText: /panadol/i }).first().click()
    await expect(page).toHaveURL(/\/catalog\/products\/[0-9a-f-]{36}$/)
    box = await openSearch(page)
    await box.fill('zzzz-nothing-here')
    await expect(page.getByText('No matches.')).toBeVisible()
    // characters with a meaning in a filter are neutralised, not passed through
    await box.fill('a%,name.ilike.*)"(')
    await expect(page.getByRole('alert')).toHaveCount(0)
  })
})

test.describe('global search without supplier access', () => {
  test.use({ storageState: authFile('cashier') })
  test('does not offer sections the person cannot open', async ({ page }) => {
    await page.goto('/')
    const requests: string[] = []
    page.on('request', (r) => { if (r.url().includes('/rest/v1/')) requests.push(r.url()) })
    await (await openSearch(page)).fill('pa')
    await expect(page.getByRole('listbox', { name: 'Search results' })).toBeAttached()
    await page.waitForTimeout(1500)
    expect(requests.some((u) => /\/rest\/v1\/(suppliers|purchase_orders)\?.*ilike/.test(u))).toBe(false)
  })
})

test.describe('two-step sign-in', () => {
  test('set up, sign in with a code, password alone gets nothing, then turn off', async ({ page }) => {
    test.setTimeout(180_000)
    await signIn(page, USERS.viewer)
    await expect(page.getByRole('button', { name: 'User menu' })).toBeVisible()
    await page.goto('/account/security')
    await page.getByRole('button', { name: 'Set up authenticator' }).click()
    await expect(page.getByRole('img', { name: /QR code/i })).toBeVisible()
    const secret = (await page.getByTestId('mfa-secret').innerText()).trim()
    await page.getByLabel(/6-digit code/i).fill(totp(secret))
    await page.getByRole('button', { name: 'Turn on' }).click()
    await expect(page.getByRole('status')).toContainText(/two-step sign-in is on/i)

    await page.getByRole('button', { name: 'User menu' }).click()
    await page.getByText('Sign out').click()
    await expect(page).toHaveURL(/\/login/)
    await signIn(page, USERS.viewer)
    await expect(page.getByRole('heading', { name: 'Enter your sign-in code' })).toBeVisible()

    // the password-only session really has no access, including straight against the API
    const headers = { apikey: anonKey(), Authorization: `Bearer ${await accessToken(page)}` }
    expect(await (await page.request.get('/rest/v1/products?select=id', { headers })).json()).toEqual([])
    await page.goto('/catalog/products')
    await expect(page.getByRole('heading', { name: 'Enter your sign-in code' })).toBeVisible()

    const wrong = totp(secret) === '000000' ? '111111' : '000000'
    await page.getByLabel(/6-digit code/i).fill(wrong)
    await page.getByRole('button', { name: 'Verify' }).click()
    await expect(page.getByRole('alert')).toBeVisible()
    await page.getByLabel(/6-digit code/i).fill(totp(secret))
    await page.getByRole('button', { name: 'Verify' }).click()
    await expect(page.getByRole('heading', { name: 'Enter your sign-in code' })).toHaveCount(0)
    const after = { apikey: anonKey(), Authorization: `Bearer ${await accessToken(page)}` }
    expect(((await (await page.request.get('/rest/v1/products?select=id', { headers: after })).json()) as unknown[]).length).toBeGreaterThan(0)

    await page.goto('/account/security')
    await page.getByRole('button', { name: 'Turn off' }).click()
    await page.getByRole('dialog').getByRole('button', { name: 'Turn off' }).click()
    await expect(page.getByRole('status')).toContainText(/is off/i)
  })
})
