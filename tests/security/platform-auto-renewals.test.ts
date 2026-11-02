import { afterAll, beforeAll, expect, it } from 'vitest'
import { admin, closePool, createAuthUser, createOrg, withUser, type Org } from '../helpers/db'
let org: Org; let operator: string; let plan: string
beforeAll(async () => {
  org = await createOrg('AUTORENEW'); operator = await createAuthUser()
  await admin.query('alter table auth.users add column if not exists email_confirmed_at timestamptz')
  await admin.query('update auth.users set email_confirmed_at=now() where id=$1', [operator])
  await admin.query("insert into private.platform_operators(user_id,permissions) values($1,array['billing'])", [operator])
  plan = (await admin.query("insert into private.platform_plans(name,currency,monthly_price,annual_price,user_limit,branch_limit,warehouse_limit) values('Automatic renewal plan','GHS',50,500,10,10,10) returning id")).rows[0].id
  await admin.query("insert into private.platform_subscriptions(organization_id,plan_id,cycle,status,starts_on,ends_on) values($1,$2,'MONTHLY','ACTIVE',current_date-15,current_date-1)", [org.id, plan])
})
afterAll(closePool)
it('requires opt in and denies tenant access to both controls and worker', async () => {
  await admin.query('select private.run_subscription_renewals()')
  expect((await admin.query('select count(*)::integer n from private.platform_invoices where organization_id=$1', [org.id])).rows[0].n).toBe(0)
  await withUser(org.ownerId, async c => {
    expect((await c.attempt("select public.platform_set_auto_renew($1,true,'Enable renewal')", [org.id])).ok).toBe(false)
    expect((await c.attempt('select private.run_subscription_renewals()')).ok).toBe(false)
  })
  await withUser(operator, c => c.q("select public.platform_set_auto_renew($1,true,'Enable scheduled renewal')", [org.id]), { commit: true })
  await admin.query('select private.run_subscription_renewals()')
  await admin.query('select private.run_subscription_renewals()')
  const invoices = (await admin.query('select amount,status from private.platform_invoices where organization_id=$1', [org.id])).rows
  expect(invoices).toEqual([{ amount: '50.00', status: 'OPEN' }])
})
it('records failures without advancing periods when the authorizer is revoked', async () => {
  await admin.query("update private.platform_subscriptions set starts_on=current_date-15,ends_on=current_date-1 where organization_id=$1", [org.id])
  await admin.query('update private.platform_operators set is_active=false where user_id=$1', [operator])
  await admin.query('select private.run_subscription_renewals()')
  const row = (await admin.query('select renewal_error,ends_on<current_date expired from private.platform_subscriptions where organization_id=$1', [org.id])).rows[0]
  expect(row).toEqual({ renewal_error: '42501', expired: true })
})
