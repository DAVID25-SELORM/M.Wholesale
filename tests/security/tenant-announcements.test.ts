import {beforeAll,afterAll,it,expect} from 'vitest'
import {admin,closePool,createOrg,createAuthUser,withUser,type Org} from '../helpers/db'
let a:Org;let b:Org;let operator:string
beforeAll(async()=>{
 a=await createOrg('ANNOUNCEMENTS-A');b=await createOrg('ANNOUNCEMENTS-B');operator=await createAuthUser()
 await admin.query('alter table auth.users add column if not exists email_confirmed_at timestamptz')
 await admin.query('update auth.users set email_confirmed_at=now() where id=$1',[operator])
 await admin.query('insert into private.platform_operators(user_id) values($1)',[operator])
})
afterAll(closePool)
it('requires publication, isolates read receipts and supports withdrawal',async()=>{
 const id=(await withUser(operator,c=>c.q("select public.platform_write('announcement.create',$1,'Create update') id",[{title:'Platform update',body:'A planned update notice',expires_at:new Date(Date.now()+86400000).toISOString()}]),{commit:true})).rows[0].id
 expect((await withUser(a.ownerId,c=>c.q('select public.tenant_announcements() data'))).rows[0].data.rows.some((r:{id:string})=>r.id===id)).toBe(false)
 expect((await withUser(a.ownerId,c=>c.attempt("select public.platform_publish_announcement($1,true,'Not authorized')",[id]))).ok).toBe(false)
 await withUser(operator,c=>c.q("select public.platform_publish_announcement($1,true,'Publish update')",[id]),{commit:true})
 await withUser(a.ownerId,async c=>{await c.q('select public.tenant_read_announcement($1)',[id]);await c.q('select public.tenant_read_announcement($1)',[id])},{commit:true})
 for(const [user,read] of [[a.ownerId,true],[b.ownerId,false]] as const){
  const data=(await withUser(user,c=>c.q('select public.tenant_announcements() data'))).rows[0].data
  expect(data.rows.find((r:{id:string})=>r.id===id).is_read).toBe(read)
 }
 await withUser(operator,c=>c.q("select public.platform_publish_announcement($1,false,'Withdraw update')",[id]),{commit:true})
 expect((await withUser(b.ownerId,c=>c.attempt('select public.tenant_read_announcement($1)',[id]))).ok).toBe(false)
 await admin.query('update public.organizations set is_active=false where id=$1',[a.id])
 expect((await withUser(a.ownerId,c=>c.attempt('select public.tenant_announcements()'))).ok).toBe(false)
 expect((await withUser(null,c=>c.attempt('select public.tenant_announcements()'))).ok).toBe(false)
})
