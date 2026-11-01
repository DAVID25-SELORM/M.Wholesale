import { beforeAll, afterAll, it, expect } from 'vitest'
import { admin, closePool, createOrg, createAuthUser, withUser, type Org } from '../helpers/db'
let org: Org; let other: Org; let operator: string; let limited: string
beforeAll(async () => {
  org = await createOrg('RECORDS'); other = await createOrg('RECORDS_OTHER')
  operator = await createAuthUser(); limited = await createAuthUser()
  await admin.query('alter table auth.users add column if not exists email_confirmed_at timestamptz')
  await admin.query('update auth.users set email_confirmed_at=now() where id=any($1::uuid[])', [[operator, limited]])
  await admin.query("insert into private.platform_operators(user_id,permissions) values($1,array['organizations','billing','users','settings']),($2,array['organizations'])", [operator, limited])
  await admin.query("insert into public.system_settings(organization_id,category,key,value) values($1,'sales','default_payment_terms_days','17'),($2,'sales','default_payment_terms_days','19')", [org.id, other.id])
})
afterAll(closePool)
it('requires separate permissions for every section', async () => {
  for (const section of ['invoices', 'payments', 'security', 'settings']) {
    for (const user of [org.ownerId, limited]) {
      expect((await withUser(user, c => c.attempt('select public.platform_organization_records($1,$2)', [org.id, section]))).ok).toBe(false)
    }
    expect((await withUser(operator, c => c.q('select public.platform_organization_records($1,$2) data', [org.id, section]))).rows[0].data).toHaveProperty('rows')
  }
})
it('isolates organizations and omits configuration values and auth secrets', async () => {
  await withUser(operator, async c => {
    const settings = (await c.q("select public.platform_organization_records($1,'settings') data", [org.id])).rows[0].data
    expect(settings.rows.some((r: { key: string }) => r.key === 'default_payment_terms_days')).toBe(true)
    expect(settings.rows.every((r: Record<string, unknown>) => !('value' in r))).toBe(true)
    const security = (await c.q("select public.platform_organization_records($1,'security') data", [org.id])).rows[0].data
    expect(security.rows.map((r: { id: string }) => r.id)).toContain(org.ownerId)
    expect(security.rows.map((r: { id: string }) => r.id)).not.toContain(other.ownerId)
    expect(Object.keys(security.rows[0]).sort()).toEqual(['email', 'email_verified', 'id', 'is_active', 'last_sign_in_at'])
    expect((await c.attempt("select public.platform_organization_records($1,'security',-1)", [org.id])).ok).toBe(false)
    expect((await c.attempt("select public.platform_organization_records($1,'unknown')", [org.id])).ok).toBe(false)
  })
})
