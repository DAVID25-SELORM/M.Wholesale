import { afterAll, beforeAll, expect, it } from 'vitest'
import { createOrg, addUser, closePool, withUser, type Org } from '../helpers/db'
let org: Org
let other: Org
let reader: string
const call = (user: string, sql: string, args: unknown[] = []) => withUser(user, c => c.attempt(sql, args), { commit: true })
beforeAll(async () => { org = await createOrg('CRM'); other = await createOrg('OTHER'); reader = await addUser(org.id, 'WAREHOUSE_MANAGER') })
afterAll(closePool)
it('persists territories and representatives and rejects cross-tenant changes', async () => {
  const created = await call(org.ownerId, 'select public.save_crm_record($1,null,$2::jsonb) id', ['territories', JSON.stringify({ name: 'North', area: 'Northern area' })])
  if (!created.ok) throw new Error(created.message)
  const territory = created.rows[0].id
  const rep = await call(org.ownerId, 'select public.save_crm_record($1,null,$2::jsonb) id', ['representatives', JSON.stringify({ profile_id: org.ownerId, territory_id: territory })])
  if (!rep.ok) throw new Error(rep.message)
  expect((await call(other.ownerId, 'select public.save_crm_record($1,$2,$3::jsonb)', ['territories', territory, JSON.stringify({ name: 'Stolen', area: 'Wrong tenant', is_active: true })])).ok).toBe(false)
  expect((await call(other.ownerId, 'select public.save_crm_record($1,null,$2::jsonb)', ['representatives', JSON.stringify({ profile_id: other.ownerId, territory_id: territory })])).ok).toBe(false)
  const list = await call(org.ownerId, "select public.crm_workspace('territories',0) data")
  expect(list.ok && list.rows[0].data.rows[0].name).toBe('North')
  const hidden = await call(other.ownerId, 'select id from public.crm_territories where id=$1', [territory])
  expect(hidden.ok && hidden.rows.length).toBe(0)
  expect((await call(reader, "select public.crm_workspace('territories',0)")).ok).toBe(false)
  const target = { representative_id: rep.rows[0].id, period_start: '2026-10-01', period_end: '2026-10-31', sales_target: 1000 }
  expect((await call(org.ownerId, 'select public.save_crm_record($1,null,$2::jsonb)', ['targets', JSON.stringify(target)])).ok).toBe(true)
  expect((await call(org.ownerId, 'select public.save_crm_record($1,null,$2::jsonb)', ['targets', JSON.stringify({ ...target, sales_target: -1 })])).ok).toBe(false)
})
it('rejects unknown record types and invalid pagination', async () => {
  expect((await call(org.ownerId, "select public.crm_workspace('profiles',0)")).ok).toBe(false)
  expect((await call(org.ownerId, "select public.crm_workspace('visits',-1)")).ok).toBe(false)
  expect((await call(org.ownerId, "select public.save_crm_record('territories',null,'{}')")).ok).toBe(false)
})
