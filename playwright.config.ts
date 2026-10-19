import { defineConfig } from '@playwright/test'

// End-to-end tests: a real browser against the real app and the local database stack (never production).
//   npm run test:e2e        resets the local dev database, seeds demo users with a fresh random password, starts the app, runs the tests
// The tests sign in as seeded demo users (see scripts/seed-dev.mjs); the password comes from E2E_PASSWORD, which scripts/e2e.mjs sets for you.
// The browser is the Chrome (or Edge) already installed on the machine: nothing is downloaded.
export default defineConfig({
  testDir: 'tests/e2e',
  testMatch: '**/*.spec.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [['list']],
  globalSetup: './tests/e2e/global-setup.ts',
  use: {
    baseURL: 'http://127.0.0.1:5273',
    channel: process.env.E2E_BROWSER ?? 'chrome',
    viewport: { width: 1440, height: 900 },
    screenshot: 'only-on-failure',
    trace: 'off',
  },
  outputDir: 'tests/e2e/.results',
  webServer: { command: 'npm run dev', url: 'http://127.0.0.1:5273/login', reuseExistingServer: true, timeout: 120_000 },
})
