import { beforeAll, afterAll, it, expect } from 'vitest'
import { admin, closePool, createOrg, createAuthUser, withUser, type Org } from '../helpers/db'
let org: Org; let foreign: Org; let operator: string; let replacement: string
beforeAll(async () => {
  org = await createOrg('TRANSFER'); foreign = await createOrg('FOREIGN')
  operator = await createAuthUser(); replacement = await createAuthUser()
  await admin.query('alter table auth.users add column if not exists email_confirmed_at timestamptz')
  await admin.query('update auth.users set email_confirmed_at=now() where id=any($1::uuid[])', [[operator, replacement]])
  await admin.query("insert into private.platform_operators(user_id,permissions) values($1,array['organizations','users'])", [operator])
  await admin.query("insert into public.profiles(id,organization_id,first_name,last_name) values($1,$2,'Next','Owner')", [replacement, org.id])
})
afterAll(closePool)
it('transfers atomically within the organization and rejects unauthorized or stale transfers', async () => {
  const sql = "select public.platform_transfer_ownership($1,$2,$3,'Approved owner replacement')"
  expect((await withUser(org.ownerId, c => c.attempt(sql, [org.id, org.ownerId, replacement]))).ok).toBe(false)
  await withUser(operator, async c => {
    const options = (await c.q('select public.platform_ownership_options($1) data', [org.id])).rows[0].data
    expect(options.some((r: { id: string; is_owner: boolean }) => r.id === org.ownerId && r.is_owner)).toBe(true)
    expect(options.some((r: { id: string; eligible: boolean }) => r.id === replacement && r.eligible)).toBe(true)
    expect(options.some((r: { id: string }) => r.id === foreign.ownerId)).toBe(false)
    expect((await c.attempt(sql, [org.id, org.ownerId, foreign.ownerId])).ok).toBe(false)
    await c.q(sql, [org.id, org.ownerId, replacement])
    expect((await c.attempt(sql, [org.id, org.ownerId, replacement])).ok).toBe(false)
  }, { commit: true })
  const owners = await admin.query("select ur.user_id from public.user_roles ur join public.roles r on r.id=ur.role_id where ur.organization_id=$1 and r.code='OWNER'", [org.id])
  expect(owners.rows.map(r => r.user_id)).toEqual([replacement])
  const audit = await admin.query("select count(*)::integer n from private.platform_audit where organization_id=$1 and action='organization.ownership_transferred'", [org.id])
  expect(audit.rows[0].n).toBe(1)
})

it('rejects unverified replacements and operators lacking either required permission', async () => {
  const unverified = await createAuthUser()
  await admin.query("insert into public.profiles(id,organization_id,first_name,last_name) values($1,$2,'Unverified','Member')", [unverified, org.id])
  const sql = "select public.platform_transfer_ownership($1,$2,$3,'Owner replacement request')"
  expect((await withUser(operator, c => c.attempt(sql, [org.id, replacement, unverified]))).ok).toBe(false)
  const limited = await createAuthUser()
  await admin.query('update auth.users set email_confirmed_at=now() where id=$1', [limited])
  await admin.query("insert into private.platform_operators(user_id,permissions) values($1,array['organizations'])", [limited])
  expect((await withUser(limited, c => c.attempt('select public.platform_ownership_options($1)', [org.id]))).ok).toBe(false)
  expect((await withUser(limited, c => c.attempt(sql, [org.id, replacement, org.ownerId]))).ok).toBe(false)
})
