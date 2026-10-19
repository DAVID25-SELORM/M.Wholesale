import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { chromium, type FullConfig } from '@playwright/test'
import { PASSWORD, USERS, authFile, signIn, type UserKey } from './helpers'

// Signs each seeded demo user in once and keeps the browser session, so the specs start signed in without repeating the login.
export default async function globalSetup(config: FullConfig) {
  if (!PASSWORD) throw new Error('E2E_PASSWORD is not set: run the tests with `npm run test:e2e`, which seeds the users and sets it.')
  const baseURL = config.projects[0]!.use.baseURL!
  const browser = await chromium.launch({ channel: process.env.E2E_BROWSER ?? 'chrome' })
  try {
    for (const key of ['owner', 'kumasiManager', 'auditor', 'cashier', 'viewer', 'otherOwner'] as UserKey[]) {
      const context = await browser.newContext({ baseURL })
      const page = await context.newPage()
      await signIn(page, USERS[key])
      await page.waitForFunction(() => location.pathname === '/' && !document.body.innerText.includes('Loading your workspace'), undefined, { timeout: 30_000 })
      mkdirSync(dirname(authFile(key)), { recursive: true })
      await context.storageState({ path: authFile(key) })
      await context.close()
    }
  } finally {
    await browser.close()
  }
}
