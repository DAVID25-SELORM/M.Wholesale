import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { admin, closePool, createAuthUser, createOrg, withUser, type Org } from '../helpers/db'
let org: Org; let operator: string; const oldSession = randomUUID(); const newSession = randomUUID()
beforeAll(async () => {
  org = await createOrg('SESSIONS'); operator = await createAuthUser()
  await admin.query('alter table auth.users add column if not exists email_confirmed_at timestamptz')
  await admin.query('update auth.users set email_confirmed_at=now() where id=$1', [operator])
  await admin.query("insert into private.platform_operators(user_id,permissions) values($1,array['users'])", [operator])
  await admin.query('create table if not exists auth.sessions(id uuid primary key,user_id uuid not null,created_at timestamptz not null)')
  await admin.query("insert into auth.sessions(id,user_id,created_at) values($1,$2,now()-interval '1 hour')", [oldSession, org.ownerId])
})
afterAll(closePool)
it('returns only session metadata and retained event names', async () => {
  await admin.query('create table if not exists auth.audit_log_entries(id uuid primary key,created_at timestamptz not null,payload jsonb not null)')
  await admin.query("insert into auth.audit_log_entries values($1,now(),jsonb_build_object('actor_id',$2::text,'action','login','secret','must-not-leak'))", [randomUUID(), org.ownerId])
  const data = (await withUser(operator, c => c.q('select public.platform_user_sessions($1) data', [org.ownerId]))).rows[0].data
  expect(data.sessions[0].id).toBe(oldSession)
  expect(data.events[0].action).toBe('login')
  expect(JSON.stringify(data)).not.toContain('must-not-leak')
  expect((await withUser(org.ownerId, c => c.attempt('select public.platform_user_sessions($1)', [org.ownerId]))).ok).toBe(false)
})
it('denies old and refreshed sessions while allowing a new login', async () => {
  await withUser(operator, c => c.q("select public.platform_revoke_sessions($1,'Requested security reset')", [org.ownerId]), { commit: true })
  await withUser(org.ownerId, async c => {
    expect((await c.q('select private.current_organization_id() id')).rows[0].id).toBeNull()
    expect((await c.q('select public.get_session_context() data')).rows[0].data.status).toBe('session_revoked')
    expect((await c.q('select id from public.branches')).rows).toEqual([])
  }, { claims: { session_id: oldSession, iat: Math.floor(Date.now() / 1000) + 100 } })
  await admin.query('insert into auth.sessions(id,user_id,created_at) values($1,$2,clock_timestamp())', [newSession, org.ownerId])
  expect((await withUser(org.ownerId, c => c.q('select private.current_organization_id() id'), { claims: { session_id: newSession } })).rows[0].id).toBe(org.id)
})
it('denies tenant callers, self revocation and users-only operators targeting operators', async () => {
  expect((await withUser(org.ownerId, c => c.attempt("select public.platform_revoke_sessions($1,'Reset access')", [operator]), { claims: { session_id: newSession } })).ok).toBe(false)
  expect((await withUser(operator, c => c.attempt("select public.platform_revoke_sessions($1,'Reset access')", [operator]))).ok).toBe(false)
  const target = await createAuthUser()
  await admin.query('insert into private.platform_operators(user_id) values($1)', [target])
  expect((await withUser(operator, c => c.attempt("select public.platform_revoke_sessions($1,'Reset access')", [target]))).ok).toBe(false)
})
