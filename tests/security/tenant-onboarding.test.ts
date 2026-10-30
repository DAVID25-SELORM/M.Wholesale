import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { admin, closePool, createAuthUser, createOrg, withUser, type Org } from '../helpers/db'

let tenant: Org
const sql = 'select public.onboard_tenant($1,$2,$3,$4,$5) id'
beforeAll(async () => {
  tenant = await createOrg('ONBOARDING-EXISTING')
  // The local Auth shim lacks this production Supabase field.
  await admin.query('alter table auth.users add column if not exists email_confirmed_at timestamptz')
})
afterAll(closePool)

it('denies tenant owners and anonymous callers platform provisioning', async () => {
  for (const user of [tenant.ownerId, null]) {
    const result = await withUser(user, c => c.attempt(sql, [randomUUID(), randomUUID(), 'Jane', 'Owner', 'Forbidden tenant']))
    expect(result.ok).toBe(false)
  }
})

it('requires verification and creates the same organization on retry', async () => {
  const owner = await createAuthUser()
  const args = [randomUUID(), owner, 'Jane', 'Owner', 'Onboarded tenant']
  await expect(admin.query(sql, args)).rejects.toMatchObject({ code: '22023' })
  await admin.query('update auth.users set email_confirmed_at=now() where id=$1', [owner])
  const first = await admin.query(sql, args)
  const second = await admin.query(sql, args)
  expect(second.rows[0].id).toBe(first.rows[0].id)
  await expect(admin.query(sql, [args[0], owner, 'Jane', 'Owner', 'Changed details'])).rejects.toMatchObject({ code: '22023' })
  await expect(admin.query(sql, [randomUUID(), owner, 'Jane', 'Owner', 'Second tenant'])).rejects.toMatchObject({ code: '22023' })
  const visible = await withUser(tenant.ownerId, c => c.q('select id from public.organizations where id=$1', [first.rows[0].id]))
  expect(visible.rows).toHaveLength(0)
  const own = await withUser(owner, c => c.q('select id from public.organizations'))
  expect(own.rows.map(r => r.id)).toEqual([first.rows[0].id])
})

it('allows only explicitly appointed verified platform operators to list and onboard tenants', async () => {
  const denied = await withUser(tenant.ownerId, c => c.attempt('select * from public.platform_tenants(0)'))
  expect(denied.ok).toBe(false)
  await admin.query('update auth.users set email_confirmed_at=now() where id=$1', [tenant.ownerId])
  await admin.query('insert into private.platform_operators(user_id) values($1)', [tenant.ownerId])
  const owner = await createAuthUser()
  await admin.query('update auth.users set email_confirmed_at=now() where id=$1', [owner])
  const result = await withUser(tenant.ownerId, c => c.attempt(sql, [randomUUID(), owner, 'New', 'Owner', 'Console tenant']), { commit: true })
  if (!result.ok) throw new Error(`${result.code}: ${result.message}`)
  const list = await withUser(tenant.ownerId, c => c.q('select * from public.platform_tenants(0)'))
  expect(list.rows.length).toBeGreaterThan(0)
  await admin.query('delete from private.platform_operators where user_id=$1', [tenant.ownerId])
  expect((await withUser(tenant.ownerId, c => c.attempt('select * from public.platform_tenants(0)'))).ok).toBe(false)
})
