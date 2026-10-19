import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, type Page } from '@playwright/test'

export const PASSWORD = process.env.E2E_PASSWORD ?? ''
export const USERS = {
  owner: 'owner@demo.test',
  kumasiManager: 'kumasi.manager@demo.test',
  auditor: 'auditor@demo.test',
  cashier: 'cashier@demo.test',
  viewer: 'viewer@demo.test',
  inactive: 'inactive@demo.test',
  otherOwner: 'owner@other.test',
} as const
export type UserKey = keyof typeof USERS

export const authFile = (key: UserKey) => join(import.meta.dirname, '.auth', `${key}.json`)

/** The anonymous (publishable) API key of the local stack: public by design, the same one the app is built with. */
export const anonKey = (): string => (JSON.parse(readFileSync(join(import.meta.dirname, '..', '..', '.stack', 'secrets.json'), 'utf8')) as { anonKey: string }).anonKey

export async function signIn(page: Page, email: string, password = PASSWORD) {
  await page.goto('/login')
  await page.getByLabel('Email').fill(email)
  await page.getByLabel('Password').fill(password)
  await page.getByRole('button', { name: 'Sign in' }).click()
}

/** The access token of the signed-in browser session, for tests that talk to the API directly as that user. */
export async function accessToken(page: Page): Promise<string> {
  return page.evaluate(() => {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i)!
      if (k.endsWith('-auth-token')) return (JSON.parse(localStorage.getItem(k)!) as { access_token: string }).access_token
    }
    return ''
  })
}

export async function openDashboard(page: Page) {
  await page.goto('/')
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
}
