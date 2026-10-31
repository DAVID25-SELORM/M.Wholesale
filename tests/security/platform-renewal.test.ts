import { beforeAll, afterAll, it, expect } from 'vitest'
import { admin, closePool, createOrg, createAuthUser, withUser, type Org } from '../helpers/db'
let org: Org; let operator: string
beforeAll(async () => {
 org=await createOrg('RENEW');operator=await createAuthUser()
 await admin.query('alter table auth.users add column if not exists email_confirmed_at timestamptz')
 await admin.query('update auth.users set email_confirmed_at=now() where id=$1',[operator])
 await admin.query("insert into private.platform_operators(user_id,permissions) values($1,array['billing'])",[operator])
 const plan=(await admin.query("insert into private.platform_plans(name,currency,monthly_price,annual_price,user_limit,branch_limit,warehouse_limit) values('Renewal','GHS',10,100,10,10,10) returning id")).rows[0].id
 await admin.query("insert into private.platform_subscriptions(organization_id,plan_id,cycle,status,starts_on,ends_on) values($1,$2,'MONTHLY','ACTIVE','2020-01-01','2020-01-31')",[org.id,plan])
})
afterAll(closePool)
it('renews one period at agreed price, issues an unpaid invoice and rejects stale retries',async()=>{
 const sql="select public.platform_renew_subscription($1,'2020-01-31','Renew agreed contract') id"
 expect((await withUser(org.ownerId,c=>c.attempt(sql,[org.id]))).ok).toBe(false)
 await withUser(operator,async c=>{
  const id=(await c.q(sql,[org.id])).rows[0].id
  expect((await c.attempt(sql,[org.id])).ok).toBe(false)
  const invoice=(await c.q("select public.platform_billing('invoices') data")).rows[0].data.rows.find((r:{id:string})=>r.id===id)
  expect(invoice.period_start).toBe('2020-02-01');expect(invoice.period_end).toBe('2020-02-29')
  expect(Number(invoice.amount)).toBe(10);expect(invoice.status).toBe('OPEN')
 })
})
it('blocks early renewal and overlapping invoice periods',async()=>{
 await admin.query("insert into private.platform_invoices(organization_id,plan_id,period_start,period_end,currency,amount,created_by) select organization_id,plan_id,'2020-02-01','2020-02-29',agreed_currency,agreed_amount,$2 from private.platform_subscriptions where organization_id=$1",[org.id,operator])
 expect((await withUser(operator,c=>c.attempt("select public.platform_renew_subscription($1,'2020-01-31','Overlapping period')",[org.id]))).ok).toBe(false)
 await admin.query('update private.platform_subscriptions set starts_on=current_date,ends_on=current_date+30 where organization_id=$1',[org.id])
 expect((await withUser(operator,c=>c.attempt("select public.platform_renew_subscription($1,current_date+30,'Premature renewal')",[org.id]))).ok).toBe(false)
})
