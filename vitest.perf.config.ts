import { defineConfig } from 'vitest/config'

// Volume test (tests/perf): builds a year of data in the throwaway database and times the screens' queries. Run with `node scripts/perf-test.mjs`.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/perf/**/*.test.ts'],
    fileParallelism: false,
    testTimeout: 120_000,
    hookTimeout: 900_000,
  },
})
