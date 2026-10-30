import { beforeAll, afterAll, expect, it } from 'vitest'
import { admin, closePool, createAuthUser, createOrg, withUser, type Org } from '../helpers/db'

let org: Org
let operator: string
beforeAll(async () => {
  org = await createOrg('PLATFORM-CONTROL')
  operator = await createAuthUser()
  await admin.query('alter table auth.users add column if not exists email_confirmed_at timestamptz')
  await admin.query('update auth.users set email_confirmed_at=now() where id=$1', [operator])
  await admin.query('insert into private.platform_operators(user_id) values($1)', [operator])
})
afterAll(closePool)

it('denies tenant owners and anonymous users access to every platform section and mutation', async () => {
  for (const user of [org.ownerId, null]) await withUser(user, async c => {
    for (const section of ['overview', 'organizations', 'users', 'operators', 'plans', 'subscriptions', 'tickets', 'audit', 'settings', 'owners']) {
      expect((await c.attempt('select public.platform_read($1)', [section])).ok).toBe(false)
    }
    expect((await c.attempt("select public.platform_write('organization.suspend',$1,'test reason')", [{ id: org.id }])).ok).toBe(false)
    expect((await c.attempt('select * from private.platform_audit')).ok).toBe(false)
  })
})
it('reads all implemented sections without exposing Auth tokens', async () => {
  await withUser(operator, async c => {
    for (const section of ['access', 'overview', 'organizations', 'organization', 'users', 'operators', 'plans', 'subscriptions', 'tickets', 'ticket', 'announcements', 'settings', 'audit', 'notifications', 'owners']) {
      const r = await c.q('select public.platform_read($1) result', [section])
      expect(JSON.stringify(r.rows)).not.toContain('encrypted_password')
    }
  })
})
it('suspends tenant access immediately and preserves independent platform access', async () => {
  await withUser(operator, c => c.q("select public.platform_write('organization.suspend',$1,'Support suspension')", [{ id: org.id }]), { commit: true })
  const hidden = await withUser(org.ownerId, c => c.q('select * from public.organizations'))
  expect(hidden.rows).toHaveLength(0)
  await withUser(operator, async c => {
    expect((await c.q('select public.platform_operator_access() allowed')).rows[0].allowed).toBe(true)
    await c.q("select public.platform_write('organization.reactivate',$1,'Issue resolved')", [{ id: org.id }])
  }, { commit: true })
  expect((await withUser(org.ownerId, c => c.q('select * from public.organizations'))).rows).toHaveLength(1)
})
it('persists plans, subscriptions, tickets and settings and audits mutations', async () => {
  await withUser(operator, async c => {
    const plan = (await c.q("select public.platform_write('plan.save',$1,'Create test plan') id", [{ name: 'Test platform plan', currency: 'GHS', monthly_price: 10, annual_price: 100, user_limit: 5, branch_limit: 2, warehouse_limit: 3 }])).rows[0].id
    await c.q("select public.platform_write('subscription.save',$1,'Assign test subscription')", [{ organization_id: org.id, plan_id: plan, cycle: 'MONTHLY', status: 'ACTIVE', starts_on: '2026-10-01', ends_on: '2026-11-01' }])
    const ticket = (await c.q("select public.platform_write('ticket.create',$1,'Customer request') id", [{ subject: 'Test support', body: 'Please help with onboarding', priority: 'NORMAL' }])).rows[0].id
    await c.q("select public.platform_write('ticket.reply',$1,'Support response')", [{ id: ticket, body: 'We are investigating' }])
    const detail = (await c.q("select public.platform_read('ticket','',0,current_date-365,current_date,$1) result", [ticket])).rows[0].result
    expect(detail.replies).toHaveLength(1)
    await c.q("select public.platform_write('settings.save',$1,'Update platform settings')", [{ name: 'Test control centre', support_email: 'support@test.invalid', support_phone: '', country: 'GH', currency: 'GHS', timezone: 'Africa/Accra' }])
    expect((await c.q("select public.platform_read('settings') result")).rows[0].result.name).toBe('Test control centre')
    expect((await c.q("select public.platform_read('audit') result")).rows[0].result.total).toBeGreaterThan(3)
    expect((await c.attempt('delete from private.platform_audit')).ok).toBe(false)
  })
})
it('enforces permission grants and revocation', async () => {
  await admin.query("update private.platform_operators set permissions=array['overview'] where user_id=$1", [operator])
  await withUser(operator, async c => {
    expect((await c.attempt("select public.platform_read('overview')")).ok).toBe(true)
    expect((await c.attempt("select public.platform_read('users')")).ok).toBe(false)
    expect((await c.attempt("select public.platform_write('organization.suspend',$1,'Not permitted')", [{ id: org.id }])).ok).toBe(false)
  })
  await admin.query('update private.platform_operators set is_active=false where user_id=$1', [operator])
  expect((await withUser(operator, c => c.q('select public.platform_operator_access() allowed'))).rows[0].allowed).toBe(false)
})
