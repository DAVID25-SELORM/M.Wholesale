import { defineConfig } from 'vitest/config'

// Database / security tests talk to a real PostgreSQL (see scripts/db-test.mjs).
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/database/**/*.test.ts', 'tests/security/**/*.test.ts'],
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
})
