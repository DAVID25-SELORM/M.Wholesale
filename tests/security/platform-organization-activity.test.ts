import { beforeAll, afterAll, it, expect } from 'vitest'
import { admin, closePool, createOrg, createAuthUser, withUser, type Org } from '../helpers/db'
let org: Org; let other: Org; let operator: string; let limited: string
beforeAll(async () => {
  org = await createOrg('ACTIVITY'); other = await createOrg('OTHER')
  operator = await createAuthUser(); limited = await createAuthUser()
  await admin.query('alter table auth.users add column if not exists email_confirmed_at timestamptz')
  await admin.query('update auth.users set email_confirmed_at=now() where id=any($1::uuid[])', [[operator, limited]])
  await admin.query("insert into private.platform_operators(user_id,permissions) values($1,array['organizations','audit']),($2,array['organizations'])", [operator, limited])
  await admin.query("insert into private.platform_audit(actor_id,organization_id,action) select $1,$2,'activity.test' from generate_series(1,26)", [operator, org.id])
  await admin.query("insert into private.platform_audit(actor_id,organization_id,action) values($1,$2,'foreign.test')", [operator, other.id])
})
afterAll(closePool)
it('paginates only the selected organization and requires both permissions', async () => {
  await withUser(operator, async c => {
    const first = (await c.q('select public.platform_organization_activity($1,0) data', [org.id])).rows[0].data
    const second = (await c.q('select public.platform_organization_activity($1,1) data', [org.id])).rows[0].data
    expect(first.total).toBe(26); expect(first.rows).toHaveLength(25); expect(second.rows).toHaveLength(1)
    expect(first.rows.every((row: { action: string }) => row.action === 'activity.test')).toBe(true)
    expect((await c.attempt('select public.platform_organization_activity($1,-1)', [org.id])).ok).toBe(false)
  })
  for (const user of [limited, org.ownerId, null]) expect((await withUser(user, c => c.attempt('select public.platform_organization_activity($1)', [org.id]))).ok).toBe(false)
})
