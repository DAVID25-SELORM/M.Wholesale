import { afterAll, beforeAll, expect, it } from 'vitest'
import { admin, closePool, createAuthUser, createOrg, withUser, type Org } from '../helpers/db'

let org: Org
let operator: string
let plan: string

beforeAll(async () => {
  org = await createOrg('FEATURES')
  operator = await createAuthUser()
  await admin.query('alter table auth.users add column if not exists email_confirmed_at timestamptz')
  await admin.query('update auth.users set email_confirmed_at=now() where id=$1', [operator])
  await admin.query("insert into private.platform_operators(user_id,permissions) values($1,array['billing'])", [operator])
  plan = (await admin.query("insert into private.platform_plans(name,currency,monthly_price,annual_price,user_limit,branch_limit,warehouse_limit) values('Feature plan','GHS',10,100,10,10,10) returning id")).rows[0].id
  await admin.query("insert into private.platform_subscriptions(organization_id,plan_id,cycle,status,starts_on,ends_on) values($1,$2,'MONTHLY','ACTIVE',current_date,current_date+30)", [org.id, plan])
})

afterAll(closePool)

it('lets platform billing disable a module while preserving foundational administration', async () => {
  await withUser(operator, c => c.q("select public.platform_set_plan_features($1,array['purchasing'],'Limit plan')", [plan]), { commit: true })
  await withUser(org.ownerId, async c => {
    expect((await c.q("select private.has_permission('purchasing.view') permitted")).rows[0].permitted).toBe(false)
    expect((await c.q("select private.has_permission('organizations.manage') permitted")).rows[0].permitted).toBe(true)
    const context = (await c.q('select public.get_session_context() data')).rows[0].data
    expect(context.org_permissions).not.toContain('purchasing.view')
  })
  const features = (await withUser(operator, c => c.q('select public.platform_plan_features($1) data', [plan]))).rows[0].data
  expect(features.disabled_modules).toEqual(['purchasing'])
  expect(features.modules).toContain('purchasing')
})

it('rejects tenant writes and unsafe module selections, and restores access when cleared', async () => {
  expect((await withUser(org.ownerId, c => c.attempt("select public.platform_set_plan_features($1,array['sales'],'No')", [plan]))).ok).toBe(false)
  expect((await withUser(operator, c => c.attempt("select public.platform_set_plan_features($1,array['organizations'],'Foundational')", [plan]))).ok).toBe(false)
  expect((await withUser(operator, c => c.attempt("select public.platform_set_plan_features($1,array['does_not_exist'],'Unknown module')", [plan]))).ok).toBe(false)
  await withUser(operator, c => c.q("select public.platform_set_plan_features($1,array[]::text[],'Restore access')", [plan]), { commit: true })
  expect((await withUser(org.ownerId, c => c.q("select private.has_permission('purchasing.view') permitted"))).rows[0].permitted).toBe(true)
})
