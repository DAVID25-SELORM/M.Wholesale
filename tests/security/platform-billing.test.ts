import { beforeAll, afterAll, expect, it } from 'vitest'
import { admin, closePool, createAuthUser, createOrg, withUser, type Org } from '../helpers/db'
let org: Org
let operator: string
beforeAll(async () => {
  org = await createOrg('BILLING')
  operator = await createAuthUser()
  await admin.query('alter table auth.users add column if not exists email_confirmed_at timestamptz')
  await admin.query('update auth.users set email_confirmed_at=now() where id=$1', [operator])
  await admin.query('insert into private.platform_operators(user_id) values($1)', [operator])
})
afterAll(closePool)
it('preserves agreed subscription pricing, prevents duplicate invoices and does not fabricate payments', async () => {
  await withUser(operator, async c => {
    const data = { name: 'Billing test plan', currency: 'GHS', monthly_price: 10, annual_price: 100, user_limit: 5, branch_limit: 2, warehouse_limit: 3 }
    const plan = (await c.q("select public.platform_write('plan.save',$1,'Create plan') id", [data])).rows[0].id
    await c.q("select public.platform_write('subscription.save',$1,'Assign plan')", [{ organization_id: org.id, plan_id: plan, cycle: 'MONTHLY', status: 'ACTIVE', starts_on: '2026-10-01', ends_on: '2026-10-31' }])
    expect((await c.attempt("insert into public.branches(organization_id,code,name) values($1,'FORBIDDEN','Forbidden')", [org.id])).ok).toBe(false)
    await c.q("select public.platform_write('plan.save',$1,'Change advertised price')", [{ ...data, id: plan, monthly_price: 25 }])
    const first = (await c.q('select public.platform_issue_invoice($1,$2) id', [org.id, 'Issue invoice'])).rows[0].id
    const retry = (await c.q('select public.platform_issue_invoice($1,$2) id', [org.id, 'Retry invoice'])).rows[0].id
    expect(retry).toBe(first)
    const invoices = (await c.q("select public.platform_billing('invoices') data")).rows[0].data.rows
    expect(Number(invoices.find((r: { id: string }) => r.id === first).amount)).toBe(10)
    expect(invoices.find((r: { id: string }) => r.id === first).status).toBe('OPEN')
    expect((await c.attempt("update private.platform_invoices set status='PAID' where id=$1", [first])).ok).toBe(false)
    expect((await c.q("select public.platform_billing('payments') data")).rows[0].data.total).toBe(0)
  })
})
it('enforces active branch capacity and rejects a downgrade below usage', async () => {
  const plan = (await admin.query("insert into private.platform_plans(name,currency,monthly_price,annual_price,user_limit,branch_limit,warehouse_limit) values('Capacity test','GHS',0,0,5,1,1) returning id")).rows[0].id
  await admin.query("insert into private.platform_subscriptions(organization_id,plan_id,cycle,status,starts_on,ends_on) values($1,$2,'MONTHLY','ACTIVE',current_date,current_date+30)", [org.id, plan])
  await expect(admin.query("insert into public.branches(organization_id,code,name) values($1,'LIMITED','Limited')", [org.id])).rejects.toMatchObject({ code: '22023' })
  await admin.query("update private.platform_plans set branch_limit=2 where id=$1", [plan])
  await admin.query("insert into public.branches(organization_id,code,name) values($1,'ALLOWED','Allowed')", [org.id])
  await expect(admin.query("update private.platform_plans set branch_limit=1 where id=$1", [plan])).rejects.toMatchObject({ code: '22023' })
})
it('denies billing to tenant owners', async () => {
  await withUser(org.ownerId, async c => {
    expect((await c.attempt("select public.platform_billing('invoices')")).ok).toBe(false)
    expect((await c.attempt("select public.platform_issue_invoice($1,'Denied request')", [org.id])).ok).toBe(false)
  })
})
