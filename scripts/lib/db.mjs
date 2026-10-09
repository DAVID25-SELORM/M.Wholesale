// Shared helpers for local database scripts (test database lifecycle + migrations).
import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

export const TEST_DB = {
  container: process.env.WPS_TEST_CONTAINER ?? 'wps-phase0-testdb',
  image: process.env.WPS_TEST_IMAGE ?? 'public.ecr.aws/supabase/postgres:17.6.1.171',
  host: '127.0.0.1',
  port: Number(process.env.WPS_TEST_PORT ?? 54522),
  user: 'postgres',
  // Throwaway local container only; this password protects nothing but a test database.
  password: process.env.WPS_TEST_PASSWORD ?? 'wps_test_pw',
  database: 'wps_test',
}

export function adminConfig(database = 'postgres') {
  return {
    host: TEST_DB.host,
    port: TEST_DB.port,
    user: TEST_DB.user,
    password: TEST_DB.password,
    database,
  }
}

function docker(args, opts = {}) {
  return execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts })
}

export function ensureContainer() {
  let state = ''
  try {
    state = docker(['inspect', '-f', '{{.State.Status}}', TEST_DB.container]).trim()
  } catch {
    state = ''
  }
  if (state === '') {
    docker([
      'run', '-d', '--name', TEST_DB.container,
      '-e', `POSTGRES_PASSWORD=${TEST_DB.password}`,
      '-p', `${TEST_DB.port}:5432`,
      TEST_DB.image,
    ])
  } else if (state !== 'running') {
    docker(['start', TEST_DB.container])
  }
}

export async function waitForDb(timeoutMs = 120_000) {
  const start = Date.now()
  let lastErr
  while (Date.now() - start < timeoutMs) {
    const client = new pg.Client(adminConfig())
    try {
      await client.connect()
      // The image restarts once after first-run initialisation; wait for the real roles.
      const r = await client.query("select 1 from pg_roles where rolname = 'authenticated'")
      await client.end()
      if (r.rowCount === 1) return
    } catch (e) {
      lastErr = e
      try { await client.end() } catch { /* ignore */ }
    }
    await new Promise((res) => setTimeout(res, 1500))
  }
  throw new Error(`database not ready: ${lastErr?.message ?? 'timeout'}`)
}

export function migrationFiles() {
  const dir = join(root, 'supabase', 'migrations')
  return readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((f) => ({ name: f, sql: readFileSync(join(dir, f), 'utf8') }))
}

// Stand-in for the pieces of a Supabase project that migrations rely on: the auth schema
// (auth.uid()/auth.role() read the verified JWT claims exactly as GoTrue/PostgREST set them),
// auth.users, and Supabase's permissive DEFAULT privileges on public. Replicating the
// permissive defaults on purpose proves our explicit REVOKEs hold in a real project.
const SUPABASE_SHIM = `
create schema if not exists auth;
create table if not exists auth.users (
  id uuid primary key,
  email text,
  created_at timestamptz default now()
);
create or replace function auth.uid() returns uuid language sql stable as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
  )::uuid
$$;
create or replace function auth.role() returns text language sql stable as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role')
  )::text
$$;
-- PostgREST connects as a low-privilege login role and SET ROLEs to anon/authenticated per request.
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'wps_authenticator') then
    create role wps_authenticator login noinherit password 'wps_test_pw';
  end if;
end $$;
grant anon, authenticated, service_role to wps_authenticator;
-- Supabase keeps extensions in their own schema
create schema if not exists extensions;
grant usage on schema extensions to anon, authenticated, service_role;
grant usage on schema auth to anon, authenticated, service_role;
grant execute on all functions in schema auth to anon, authenticated, service_role;
grant usage on schema public to anon, authenticated, service_role;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
`

/** Drops and recreates the throwaway test database, installs the shim and applies all migrations. */
export async function resetTestDatabase() {
  const admin = new pg.Client(adminConfig('postgres'))
  await admin.connect()
  await admin.query(`select pg_terminate_backend(pid) from pg_stat_activity where datname = $1 and pid <> pg_backend_pid()`, [TEST_DB.database])
  await admin.query(`drop database if exists ${TEST_DB.database}`)
  await admin.query(`create database ${TEST_DB.database} template template0`)
  await admin.end()

  const db = new pg.Client(adminConfig(TEST_DB.database))
  await db.connect()
  await db.query(SUPABASE_SHIM)
  for (const m of migrationFiles()) {
    try {
      await db.query(m.sql)
    } catch (e) {
      await db.end()
      throw new Error(`migration ${m.name} failed: ${e.message}${e.position ? ` (position ${e.position})` : ''}`)
    }
  }
  await db.end()
}
