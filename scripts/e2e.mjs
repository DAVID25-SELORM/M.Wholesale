// Runs the end-to-end tests against the LOCAL stack only.
//   node scripts/e2e.mjs                 resets the local dev database, seeds the demo users with a fresh random password, runs the tests
//   E2E_KEEP_DB=1 E2E_PASSWORD=... node scripts/e2e.mjs   reuse a database you already seeded
// It never touches the hosted project: it needs .stack/secrets.json (written by `node scripts/dev-stack.mjs up`).
import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'

const run = (cmd, args, env = {}) => {
  const r = spawnSync(cmd, args, { stdio: 'inherit', shell: process.platform === 'win32', env: { ...process.env, ...env } })
  if (r.status !== 0) process.exit(r.status ?? 1)
}

let password = process.env.E2E_PASSWORD
if (process.env.E2E_KEEP_DB !== '1') {
  password = process.env.E2E_PASSWORD || `E2e-${randomBytes(6).toString('hex')}-Aa1!`
  console.log('resetting the local dev database and seeding demo users (local only) ...')
  run('node', ['scripts/dev-stack.mjs', 'reset'])
  run('node', ['scripts/seed-dev.mjs'], { DEV_SEED_PASSWORD: password })
}
if (!password) { console.error('Set E2E_PASSWORD (or let this script seed a fresh database).'); process.exit(1) }
if (!existsSync('.stack/secrets.json')) { console.error('Local stack not found. Run: node scripts/dev-stack.mjs up'); process.exit(1) }
const res = spawnSync('npx', ['playwright', 'test', ...process.argv.slice(2)], { stdio: 'inherit', shell: process.platform === 'win32', env: { ...process.env, E2E_PASSWORD: password } })
process.exit(res.status ?? 1)
