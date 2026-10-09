import path from 'node:path'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

// Frontend unit/component tests (jsdom). Database tests use vitest.db.config.ts.
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: [
      { find: '@', replacement: path.resolve(import.meta.dirname, 'src') },
      // Deno-style `npm:` imports in supabase/functions (see tests/stubs/deno-npm-stub.ts)
      { find: /^npm:.*/, replacement: path.resolve(import.meta.dirname, 'tests/stubs/deno-npm-stub.ts') },
    ],
  },
  test: {
    environment: 'jsdom',
    globals: false,
    include: ['src/**/*.test.{ts,tsx}', 'tests/unit/**/*.test.{ts,tsx}'],
    setupFiles: ['tests/setup.ts'],
    css: false,
    // threads start much faster than forks on slow/busy machines; keep concurrency modest
    pool: 'threads',
    maxWorkers: 2,
    testTimeout: 20_000,
    hookTimeout: 30_000,
  },
})
