import { expect, test } from '@playwright/test'
import { PASSWORD, USERS, signIn } from './helpers'

// Authentication and route protection, in a real browser with no saved session.
test.describe('authentication', () => {
  test('a visitor without a session is sent to the sign-in page from any protected address', async ({ page }) => {
    for (const path of ['/', '/admin/users', '/sales/invoices', '/accounting', '/admin/settings']) {
      await page.goto(path)
      await expect(page).toHaveURL(/\/login/)
      await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible()
    }
    // and the sign-in page offers no way to create an account
    await expect(page.getByText(/sign up|create an account|register/i)).toHaveCount(0)
    await expect(page.getByText('Accounts are created by your administrator.')).toBeVisible()
  })

  test('requires both fields, and a wrong password gives a safe message that reveals nothing', async ({ page }) => {
    await page.goto('/login')
    await page.getByRole('button', { name: 'Sign in' }).click()
    await expect(page.getByText('Enter your email and password.')).toBeVisible()
    await signIn(page, USERS.owner, `${PASSWORD}-wrong`)
    const alert = page.getByRole('alert')
    await expect(alert).toBeVisible()
    await expect(alert).not.toContainText(/not found|no such user|does not exist|invalid_grant/i)
    await expect(page).toHaveURL(/\/login/)
    await signIn(page, 'nobody@demo.test', PASSWORD)
    await expect(page.getByRole('alert')).toBeVisible()                                      // the same kind of message for an unknown user
  })

  test('signs in, shows the workspace, and signing out ends the session', async ({ page }) => {
    await signIn(page, USERS.owner)
    await expect(page).toHaveURL((u) => u.pathname === '/')
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Welcome')
    await expect(page.locator('#branch-selector')).toBeVisible()
    await page.getByRole('button', { name: 'User menu' }).click()
    await page.getByRole('menuitem', { name: /Sign out/ }).click()
    await expect(page).toHaveURL(/\/login/)
    await page.goto('/admin/branches')                                                       // the session is really gone
    await expect(page).toHaveURL(/\/login/)
  })

  test('a deactivated person can sign in to the authentication service but is shown "access disabled" and nothing else', async ({ page }) => {
    await signIn(page, USERS.inactive)
    await expect(page.getByRole('heading', { name: 'Access disabled' })).toBeVisible()
    await page.goto('/admin/branches')
    await expect(page.getByRole('heading', { name: 'Access disabled' })).toBeVisible()
    await expect(page.getByRole('table')).toHaveCount(0)
  })

  test('the idle notice appears on the sign-in page after an inactivity sign-out', async ({ page }) => {
    await page.goto('/login?idle=1')
    await expect(page.getByText(/signed out after a period of inactivity/i)).toBeVisible()
  })
})
