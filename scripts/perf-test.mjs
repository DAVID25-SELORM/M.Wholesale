// Volume test against a freshly migrated throwaway database.
//   node scripts/perf-test.mjs              full scale (a few minutes)
//   PERF_SCALE=0.2 node scripts/perf-test.mjs   quick run
import { spawnSync } from 'node:child_process'
import { ensureContainer, waitForDb, resetTestDatabase } from './lib/db.mjs'

ensureContainer()
await waitForDb()
console.log('applying migrations to a fresh wps_test database ...')
await resetTestDatabase()
const res = spawnSync(process.execPath, ['node_modules/vitest/vitest.mjs', 'run', '--config', 'vitest.perf.config.ts', ...process.argv.slice(2)], { stdio: 'inherit' })
process.exit(res.status ?? 1)
