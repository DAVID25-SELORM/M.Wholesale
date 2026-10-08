// Runs the database/security test suite against a freshly migrated throwaway database.
//   node scripts/db-test.mjs            -> reset db, apply migrations, run tests/database + tests/security
//   node scripts/db-test.mjs --migrate-only
import { spawnSync } from 'node:child_process'
import { ensureContainer, waitForDb, resetTestDatabase } from './lib/db.mjs'

ensureContainer()
await waitForDb()
console.log('applying migrations to a fresh wps_test database ...')
await resetTestDatabase()
console.log('migrations applied')

if (process.argv.includes('--migrate-only')) process.exit(0)

const res = spawnSync(
  process.execPath,
  ['node_modules/vitest/vitest.mjs', 'run', '--config', 'vitest.db.config.ts', ...process.argv.slice(2)],
  { stdio: 'inherit' },
)
process.exit(res.status ?? 1)
