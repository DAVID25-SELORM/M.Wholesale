import { beforeAll, afterAll, expect, it } from 'vitest'
import { admin, closePool, createAuthUser, withUser } from '../helpers/db'
let operator: string
let colleague: string
let outsider: string
beforeAll(async () => {
 operator = await createAuthUser(); colleague = await createAuthUser(); outsider = await createAuthUser()
 await admin.query('alter table auth.users add column if not exists email_confirmed_at timestamptz')
 await admin.query('update auth.users set email_confirmed_at=now() where id=any($1::uuid[])', [[operator,colleague,outsider]])
 await admin.query("insert into private.platform_operators(user_id,permissions) values($1,array['support']),($2,array['support'])", [operator,colleague])
})
afterAll(closePool)
it('lists support colleagues without exposing operator-management access', async () => {
 await withUser(operator, async c => {
  const rows = (await c.q('select public.platform_support_assignees() data')).rows[0].data
  expect(rows.some((r: { id: string }) => r.id === colleague)).toBe(true)
  expect(rows.some((r: { id: string }) => r.id === outsider)).toBe(false)
  expect((await c.attempt("select public.platform_read('operators')")).ok).toBe(false)
 })
 expect((await withUser(outsider,c => c.attempt('select public.platform_support_assignees()'))).ok).toBe(false)
})
it('assigns, rejects invalid assignees, unassigns and preserves assignment history', async () => {
 let ticket: string
 await withUser(operator, async c => {
  ticket = (await c.q("select public.platform_write('ticket.create',$1,'Support request') id", [{ subject:'Assignment test',body:'Please investigate this issue',priority:'NORMAL' }])).rows[0].id
  expect((await c.attempt("select public.platform_write('ticket.update',$1,'Invalid assignment')", [{id:ticket,status:'OPEN',priority:'NORMAL',assigned_to:outsider}])).ok).toBe(false)
  await c.q("select public.platform_write('ticket.update',$1,'Assign colleague')", [{id:ticket,status:'IN_PROGRESS',priority:'HIGH',assigned_to:colleague}])
  const result = (await c.q("select public.platform_read('ticket','',0,current_date-365,current_date,$1) data", [ticket])).rows[0].data
  expect(result.ticket.assigned_to).toBe(colleague)
 }, {commit:true})
 await admin.query('update private.platform_operators set is_active=false where user_id=$1',[colleague])
 await withUser(operator, async c => {
  await c.q("select public.platform_write('ticket.update',$1,'Unassign inactive colleague')",[{id:ticket,status:'OPEN',priority:'NORMAL',assigned_to:null}])
  expect((await c.attempt("select public.platform_write('ticket.update',$1,'Cannot reassign inactive colleague')",[{id:ticket,status:'OPEN',priority:'NORMAL',assigned_to:colleague}])).ok).toBe(false)
 },{commit:true})
 const events = await admin.query("select metadata from private.platform_audit where target_id=$1 and action='ticket.assigned' order by created_at",[ticket!])
 expect(events.rows).toHaveLength(2)
 expect(events.rows[0].metadata.assignee).toBe(colleague)
 expect(events.rows[1].metadata.assignee).toBeNull()
})
