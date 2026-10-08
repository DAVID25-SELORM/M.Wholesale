// Regenerates src/types/database.ts from a migrated database.
//   npm run db:types                      -> from the local test database (scripts/db-test.mjs --migrate-only first)
//   DATABASE_URL=postgres://... npm run db:types
import { spawnSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { TEST_DB } from './lib/db.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const url =
  process.env.DATABASE_URL ??
  `postgresql://${TEST_DB.user}:${TEST_DB.password}@${TEST_DB.host}:${TEST_DB.port}/${TEST_DB.database}?sslmode=disable`

const res = spawnSync(
  process.platform === 'win32' ? 'npx.cmd' : 'npx',
  ['--yes', 'supabase@latest', 'gen', 'types', 'typescript', '--db-url', url, '--schema', 'public'],
  { cwd: root, encoding: 'utf8', shell: process.platform === 'win32' },
)
if (res.status !== 0 || !res.stdout.includes('export type Database')) {
  console.error(res.stderr || res.stdout)
  process.exit(res.status || 1)
}
writeFileSync(join(root, 'src', 'types', 'database.ts'), res.stdout)
console.log('wrote src/types/database.ts')
