import { beforeAll, afterAll, it, expect } from 'vitest'
import { admin, closePool, createOrg, withUser, type Org } from '../helpers/db'
let org:Org; let plan:string
beforeAll(async()=>{
 org=await createOrg('TRIAL')
 plan=(await admin.query("insert into private.platform_plans(name,currency,monthly_price,annual_price,user_limit,branch_limit,warehouse_limit,trial_days) values('Trial plan','GHS',0,0,10,10,10,14) returning id")).rows[0].id
})
afterAll(closePool)
it('enforces inclusive trial dates on both session context and direct tenant access',async()=>{
 await admin.query("insert into private.platform_subscriptions(organization_id,plan_id,cycle,status,starts_on,ends_on) values($1,$2,'MONTHLY','TRIAL',current_date-13,current_date)",[org.id,plan])
 await withUser(org.ownerId,async c=>{
  expect((await c.q('select private.current_organization_id() id')).rows[0].id).toBe(org.id)
  expect((await c.q('select public.get_session_context() data')).rows[0].data.status).toBe('ok')
 })
 await admin.query('update private.platform_subscriptions set starts_on=current_date-14,ends_on=current_date-1 where organization_id=$1',[org.id])
 await withUser(org.ownerId,async c=>{
  expect((await c.q('select private.current_organization_id() id')).rows[0].id).toBeNull()
  expect((await c.q('select private.current_profile_id() id')).rows[0].id).toBeNull()
  expect((await c.q('select public.get_session_context() data')).rows[0].data.status).toBe('trial_unavailable')
  expect((await c.q('select id from public.branches')).rows).toEqual([])
  expect((await c.q("select private.has_permission('organizations.manage') permitted")).rows[0].permitted).toBe(false)
 })
 await admin.query("update private.platform_subscriptions set status='ACTIVE' where organization_id=$1",[org.id])
 expect((await withUser(org.ownerId,c=>c.q('select private.current_organization_id() id'))).rows[0].id).toBe(org.id)
})
it('rejects overlong trials and blocks access before trial start',async()=>{
 await expect(admin.query("update private.platform_subscriptions set status='TRIAL',starts_on=current_date,ends_on=current_date+14 where organization_id=$1",[org.id])).rejects.toMatchObject({code:'22023'})
 await admin.query("update private.platform_subscriptions set status='TRIAL',starts_on=current_date+1,ends_on=current_date+14 where organization_id=$1",[org.id])
 expect((await withUser(org.ownerId,c=>c.q('select private.current_organization_id() id'))).rows[0].id).toBeNull()
})
