import { randomUUID } from 'node:crypto'
import { beforeAll, afterAll, expect, it } from 'vitest'
import { admin, closePool, createAuthUser, createOrg, withUser } from '../helpers/db'
let operator: string
let owner: string
let email: string
beforeAll(async () => {
 operator = await createAuthUser(); owner = await createAuthUser()
 await admin.query('alter table auth.users add column if not exists email_confirmed_at timestamptz')
 await admin.query('update auth.users set email_confirmed_at=now() where id=any($1::uuid[])', [[operator, owner]])
 email = (await admin.query('select email from auth.users where id=$1', [owner])).rows[0].email
 await admin.query('insert into private.platform_operators(user_id) values($1)', [operator])
})
afterAll(closePool)
it('persists a failed attempt, retries safely, and creates only one organization', async () => {
 const id = randomUUID()
 const details = { email, first: 'Jane', last: 'Owner', name: 'Queue tenant', country: 'GH', currency: 'GHS', timezone: 'Africa/Accra' }
 await withUser(operator, async c => {
  await c.q('select public.platform_submit_onboarding($1,$2)', [id, details])
  await c.q('select public.platform_submit_onboarding($1,$2)', [id, details])
  expect((await c.attempt('select public.platform_submit_onboarding($1,$2)', [id, { ...details, name: 'Different' }])).ok).toBe(false)
 }, { commit: true })
 await admin.query('update auth.users set email_confirmed_at=null where id=$1', [owner])
 const failed = await withUser(operator, c => c.q("select public.platform_decide_onboarding($1,true,'Approve request') result", [id]), { commit: true })
 expect(failed.rows[0].result.status).toBe('FAILED')
 expect((await admin.query('select id from public.profiles where id=$1', [owner])).rows).toHaveLength(0)
 expect((await admin.query('select status,attempts from private.platform_onboarding_queue where id=$1', [id])).rows[0]).toEqual({ status: 'FAILED', attempts: 1 })
 await admin.query('update auth.users set email_confirmed_at=now() where id=$1', [owner])
 await withUser(operator, async c => {
  const first = (await c.q("select public.platform_decide_onboarding($1,true,'Owner verified') result", [id])).rows[0].result
  const second = (await c.q("select public.platform_decide_onboarding($1,true,'Retry safely') result", [id])).rows[0].result
  expect(first.status).toBe('COMPLETED'); expect(second.organization_id).toBe(first.organization_id)
  expect((await c.attempt("select public.platform_decide_onboarding($1,false,'Reject completed')", [id])).ok).toBe(false)
 }, { commit: true })
})
it('denies tenant owners and anonymous callers queue access', async () => {
 const tenant = await createOrg('QUEUE-DENIED')
 for (const user of [tenant.ownerId, null]) await withUser(user, async c => {
  expect((await c.attempt('select public.platform_onboarding_requests()')).ok).toBe(false)
  expect((await c.attempt("select public.platform_decide_onboarding($1,true,'Not authorized')", [randomUUID()])).ok).toBe(false)
 })
})
