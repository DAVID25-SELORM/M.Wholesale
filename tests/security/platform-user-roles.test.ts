import {beforeAll,afterAll,it,expect} from 'vitest'
import {admin,closePool,createOrg,createAuthUser,withUser,roleId,type Org} from '../helpers/db'
let a:Org;let b:Org;let operator:string
beforeAll(async()=>{
 a=await createOrg('ROLE-A');b=await createOrg('ROLE-B');operator=await createAuthUser()
 await admin.query('alter table auth.users add column if not exists email_confirmed_at timestamptz')
 await admin.query('update auth.users set email_confirmed_at=now() where id=$1',[operator])
 await admin.query("insert into private.platform_operators(user_id,permissions) values($1,array['users'])",[operator])
})
afterAll(closePool)
it('supports scoped grants and revocation, blocks foreign branches and owner roles',async()=>{
 const role=(await admin.query("select id from public.roles where organization_id is null and code not in ('OWNER','SUPER_ADMIN') and is_active limit 1")).rows[0].id
 await withUser(operator,async c=>{
  expect((await c.attempt("select public.platform_change_user_role($1,$2,$3,true,'Foreign branch')",[a.ownerId,role,b.hq])).ok).toBe(false)
  expect((await c.attempt("select public.platform_change_user_role($1,$2,null,false,'Revoke owner')",[a.ownerId,await roleId('OWNER')])).ok).toBe(false)
  await c.q("select public.platform_change_user_role($1,$2,$3,true,'Grant scoped access')",[a.ownerId,role,a.hq])
  const data=(await c.q('select public.platform_user_roles($1) data',[a.ownerId])).rows[0].data
  expect(data.assigned.some((r:{role_id:string;branch_id:string})=>r.role_id===role&&r.branch_id===a.hq)).toBe(true)
  await c.q("select public.platform_change_user_role($1,$2,$3,false,'Remove scoped access')",[a.ownerId,role,a.hq])
 })
 expect((await withUser(a.ownerId,c=>c.attempt('select public.platform_user_roles($1)',[b.ownerId]))).ok).toBe(false)
})
