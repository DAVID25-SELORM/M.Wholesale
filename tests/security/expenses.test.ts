import { afterAll, beforeAll, expect, it } from 'vitest'
import { admin, createOrg, addUser, withUser, closePool, type Org } from '../helpers/db'
let org: Org; let approver: string; let expense: string; let credit: string
const call = (user: string, sql: string, args: unknown[] = []) => withUser(user, c => c.attempt(sql, args), { commit: true })
beforeAll(async () => {
  org = await createOrg('EXPENSES'); approver = await addUser(org.id, 'ACCOUNTS_MANAGER')
  const started = await call(org.ownerId, "select public.start_accounting(current_date,'[]'::jsonb)")
  if (!started.ok) throw new Error(started.message)
  const exp = await call(org.ownerId, "select public.save_gl_account(null,'6901','Office expense','EXPENSE') id")
  const cr = await call(org.ownerId, "select public.save_gl_account(null,'1901','Expense clearing','ASSET') id")
  if (!exp.ok || !cr.ok) throw new Error('Unable to create test accounts')
  expense = exp.rows[0].id; credit = cr.rows[0].id
})
afterAll(closePool)
it('requires independent approval and posts one balanced journal on retries', async () => {
  const made = await call(org.ownerId, "select public.submit_expense($1,current_date,'Vendor','Office supplies','R-1',$2,$3,25) id", [org.hq, expense, credit])
  if (!made.ok) throw new Error(made.message)
  const id = made.rows[0].id
  expect((await call(org.ownerId, "select public.decide_expense($1,'APPROVE','Self approval')", [id])).ok).toBe(false)
  const posted = await call(approver, "select public.decide_expense($1,'APPROVE','Receipt reviewed') id", [id])
  if (!posted.ok) throw new Error(posted.message)
  const retry = await call(approver, "select public.decide_expense($1,'APPROVE','Receipt reviewed') id", [id])
  expect(retry.ok && retry.rows[0].id).toBe(posted.rows[0].id)
  const balance = await admin.query('select sum(debit) debit,sum(credit) credit from public.gl_journal_lines where journal_id=$1', [posted.rows[0].id])
  expect(Number(balance.rows[0].debit)).toBe(25); expect(Number(balance.rows[0].credit)).toBe(25)
  expect((await call(org.ownerId, "select public.decide_expense($1,'CANCEL','Already posted')", [id])).ok).toBe(false)
})
