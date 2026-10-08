// Lightweight LOCAL Supabase-compatible stack for development and browser verification:
//   real Supabase Postgres image  +  GoTrue (auth)  +  PostgREST (data API)
// It reuses the throwaway test database container (scripts/lib/db.mjs) but its own `postgres` database,
// so it never touches the automated-test database. Full `npx supabase start` also works
// (see supabase/config.toml and docs/DEVELOPMENT.md); this exists because it needs far fewer images/RAM.
//
//   node scripts/dev-stack.mjs up      start (idempotent), apply migrations, write .env.local
//   node scripts/dev-stack.mjs down    stop and remove the auth/API containers (data stays)
//   node scripts/dev-stack.mjs status
//   node scripts/dev-stack.mjs reset   wipe the dev database and re-apply migrations
//
// Everything printed here is LOCAL ONLY. Generated secrets live in .stack/ (git-ignored).
import { execFileSync } from 'node:child_process'
import { createHmac, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'
import { TEST_DB, adminConfig, ensureContainer, migrationFiles, waitForDb } from './lib/db.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const stackDir = join(root, '.stack')
const secretsFile = join(stackDir, 'secrets.json')

const NET = 'wps-net'
const AUTH = 'wps-dev-auth'
const REST = 'wps-dev-rest'
const AUTH_PORT = 55330
const REST_PORT = 55331
const WEB_URL = 'http://127.0.0.1:5273'
const GOTRUE_IMAGE = 'public.ecr.aws/supabase/gotrue:v2.197.0'
const POSTGREST_IMAGE = 'public.ecr.aws/supabase/postgrest:v16.3'

const docker = (args, opts = {}) => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts })
const tryDocker = (args) => { try { return docker(args) } catch { return '' } }

const b64url = (b) => Buffer.from(b).toString('base64url')
function signJwt(payload, secret) {
  const h = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
  const p = b64url(JSON.stringify(payload))
  const sig = createHmac('sha256', secret).update(`${h}.${p}`).digest('base64url')
  return `${h}.${p}.${sig}`
}

function loadSecrets() {
  if (existsSync(secretsFile)) return JSON.parse(readFileSync(secretsFile, 'utf8'))
  const jwtSecret = randomBytes(32).toString('hex')
  const iat = Math.floor(Date.now() / 1000)
  const exp = iat + 60 * 60 * 24 * 365 * 5
  const secrets = {
    jwtSecret,
    anonKey: signJwt({ role: 'anon', iss: 'wps-local', iat, exp }, jwtSecret),
    serviceKey: signJwt({ role: 'service_role', iss: 'wps-local', iat, exp }, jwtSecret),
    authUrl: `http://127.0.0.1:${AUTH_PORT}`,
    restUrl: `http://127.0.0.1:${REST_PORT}`,
  }
  mkdirSync(stackDir, { recursive: true })
  writeFileSync(secretsFile, JSON.stringify(secrets, null, 2))
  return secrets
}

async function waitHttp(url, label, ms = 90_000) {
  const start = Date.now()
  while (Date.now() - start < ms) {
    try { const r = await fetch(url); if (r.status < 500) return } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 1500))
  }
  throw new Error(`${label} did not become ready at ${url}`)
}

async function applyMigrations() {
  const db = new pg.Client(adminConfig('postgres'))
  await db.connect()
  await db.query('create table if not exists public._wps_migrations (name text primary key, applied_at timestamptz default now())')
  await db.query('alter table public._wps_migrations enable row level security')
  await db.query('revoke all on public._wps_migrations from anon, authenticated')
  const done = new Set((await db.query('select name from public._wps_migrations')).rows.map((r) => r.name))
  for (const m of migrationFiles()) {
    if (done.has(m.name)) continue
    try {
      await db.query('begin')
      await db.query(m.sql)
      await db.query('insert into public._wps_migrations (name) values ($1)', [m.name])
      await db.query('commit')
      console.log(`  applied ${m.name}`)
    } catch (e) {
      await db.query('rollback')
      await db.end()
      throw new Error(`migration ${m.name} failed: ${e.message}`)
    }
  }
  await db.end()
}

async function up() {
  const secrets = loadSecrets()
  ensureContainer()
  await waitForDb()
  tryDocker(['network', 'create', NET])
  tryDocker(['network', 'connect', NET, TEST_DB.container])

  const running = (n) => tryDocker(['inspect', '-f', '{{.State.Running}}', n]).trim() === 'true'
  const dbHost = `${TEST_DB.container}:5432`

  // The service roles ship without usable passwords; set them for this throwaway local database.
  // (reserved roles can only be altered by the superuser, reachable over the container's local socket)
  for (const r of ['supabase_auth_admin', 'authenticator']) {
    docker(['exec', TEST_DB.container, 'psql', '-U', 'supabase_admin', '-d', 'postgres', '-c', `alter role ${r} with login password '${TEST_DB.password}'`])
  }

  if (!running(AUTH)) {
    tryDocker(['rm', '-f', AUTH])
    docker([
      'run', '-d', '--name', AUTH, '--network', NET, '-p', `127.0.0.1:${AUTH_PORT}:9999`,
      '-e', 'GOTRUE_API_HOST=0.0.0.0', '-e', 'GOTRUE_API_PORT=9999',
      '-e', `API_EXTERNAL_URL=${WEB_URL}`, '-e', 'GOTRUE_DB_DRIVER=postgres',
      '-e', `GOTRUE_DB_DATABASE_URL=postgres://supabase_auth_admin:${TEST_DB.password}@${dbHost}/postgres`,
      '-e', 'GOTRUE_DB_NAMESPACE=auth', '-e', `GOTRUE_SITE_URL=${WEB_URL}`,
      '-e', `GOTRUE_JWT_SECRET=${secrets.jwtSecret}`, '-e', 'GOTRUE_JWT_EXP=3600', '-e', 'GOTRUE_JWT_AUD=authenticated',
      '-e', 'GOTRUE_JWT_DEFAULT_GROUP_NAME=authenticated',
      // No public registration: users are provisioned by administrators / the server.
      '-e', 'GOTRUE_DISABLE_SIGNUP=true', '-e', 'GOTRUE_MAILER_AUTOCONFIRM=true',
      '-e', 'GOTRUE_EXTERNAL_EMAIL_ENABLED=true', '-e', 'GOTRUE_LOG_LEVEL=warn',
      GOTRUE_IMAGE,
    ])
  }
  console.log('waiting for auth ...')
  await waitHttp(`${secrets.authUrl}/health`, 'GoTrue')

  console.log('applying migrations to the dev database ...')
  await applyMigrations()

  if (!running(REST)) {
    tryDocker(['rm', '-f', REST])
    docker([
      'run', '-d', '--name', REST, '--network', NET, '-p', `127.0.0.1:${REST_PORT}:3000`,
      '-e', `PGRST_DB_URI=postgres://authenticator:${TEST_DB.password}@${dbHost}/postgres`,
      '-e', 'PGRST_DB_SCHEMAS=public', '-e', 'PGRST_DB_ANON_ROLE=anon',
      '-e', `PGRST_JWT_SECRET=${secrets.jwtSecret}`, '-e', 'PGRST_DB_MAX_ROWS=1000',
      POSTGREST_IMAGE,
    ])
  } else {
    // new migrations may have changed the schema: reload PostgREST's cache
    tryDocker(['kill', '-s', 'SIGUSR1', REST])
  }
  console.log('waiting for data API ...')
  await waitHttp(`${secrets.restUrl}/`, 'PostgREST')

  writeFileSync(
    join(root, '.env.local'),
    [
      '# generated by scripts/dev-stack.mjs - local development only, git-ignored',
      `VITE_SUPABASE_URL=${WEB_URL}`,
      `VITE_SUPABASE_ANON_KEY=${secrets.anonKey}`,
      '',
    ].join('\n'),
  )
  console.log(`\nLocal stack is up.\n  auth      ${secrets.authUrl}\n  data API  ${secrets.restUrl}\n  .env.local written (Vite proxies /auth/v1 and /rest/v1 to these)`)
}

function down() {
  for (const n of [REST, AUTH]) tryDocker(['rm', '-f', n])
  console.log('auth/API containers removed (database container and data are kept)')
}

async function reset() {
  down()
  const admin = new pg.Client(adminConfig('postgres'))
  await admin.connect()
  await admin.query('drop schema if exists public cascade; create schema public;')
  await admin.query('grant usage on schema public to anon, authenticated, service_role; grant all on schema public to postgres;')
  await admin.query('drop schema if exists private cascade;')
  await admin.query('drop schema if exists auth cascade; create schema auth authorization supabase_auth_admin;')
  await admin.end()
  console.log('dev database wiped')
  await up()
}

const cmd = process.argv[2] ?? 'status'
if (cmd === 'up') await up()
else if (cmd === 'down') down()
else if (cmd === 'reset') await reset()
else {
  for (const n of [TEST_DB.container, AUTH, REST]) console.log(n.padEnd(24), tryDocker(['inspect', '-f', '{{.State.Status}}', n]).trim() || 'absent')
}
