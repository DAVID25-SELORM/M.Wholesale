import {randomUUID} from 'node:crypto'
import {beforeAll,afterAll,it,expect} from 'vitest'
import {admin,closePool,createOrg,createAuthUser,withUser,type Org} from '../helpers/db'
let a:Org;let b:Org;let operator:string
beforeAll(async()=>{
 a=await createOrg('SUPPORT-A');b=await createOrg('SUPPORT-B');operator=await createAuthUser()
 await admin.query('alter table auth.users add column if not exists email_confirmed_at timestamptz')
 await admin.query('update auth.users set email_confirmed_at=now() where id=$1',[operator])
 await admin.query('insert into private.platform_operators(user_id) values($1)',[operator])
})
afterAll(closePool)
it('isolates tenants, protects internal notes and supports conversation lifecycle',async()=>{
 const id=randomUUID()
 await withUser(a.ownerId,async c=>{
  await c.q("select public.tenant_support_write('CREATE',$1,'Help needed','Please investigate')",[id])
  await c.q("select public.tenant_support_write('CREATE',$1,'Help needed','Please investigate')",[id])
 },{commit:true})
 await withUser(b.ownerId,async c=>{
  expect((await c.attempt('select public.tenant_support_read($1)',[id])).ok).toBe(false)
  expect((await c.attempt("select public.tenant_support_write('REPLY',$1,null,'Cross tenant')",[id])).ok).toBe(false)
  expect((await c.q('select public.tenant_support_read() data')).rows[0].data.total).toBe(0)
 })
 await withUser(operator,async c=>{
  await c.q("select public.platform_write('ticket.reply',$1,'Internal discussion')",[{id,body:'Private internal note'}])
  await c.q("select public.platform_reply_to_tenant($1,'Public response')",[id])
 },{commit:true})
 await withUser(a.ownerId,async c=>{
  const detail=(await c.q('select public.tenant_support_read($1) data',[id])).rows[0].data
  expect(detail.replies.map((r:{body:string})=>r.body)).toEqual(['Public response'])
  expect(JSON.stringify(detail)).not.toContain('assigned_to')
  await c.q("select public.tenant_support_write('CLOSE',$1)",[id])
  expect((await c.attempt("select public.tenant_support_write('REPLY',$1,null,'Closed reply')",[id])).ok).toBe(false)
  await c.q("select public.tenant_support_write('REOPEN',$1)",[id])
  await c.q("select public.tenant_support_write('REPLY',$1,null,'Thank you')",[id])
 })
 await admin.query('update public.organizations set is_active=false where id=$1',[a.id])
 expect((await withUser(a.ownerId,c=>c.attempt('select public.tenant_support_read()'))).ok).toBe(false)
})
