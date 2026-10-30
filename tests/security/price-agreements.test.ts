import { afterAll, beforeAll, expect, it } from 'vitest'
import { admin, createOrg, addProduct, addUser, withUser, closePool, type Org } from '../helpers/db'
let org: Org; let other: Org; let customer: string; let unit: string
const call = (user: string, sql: string, args: unknown[] = []) => withUser(user, c => c.attempt(sql, args), { commit: true })
beforeAll(async () => { org = await createOrg('AGREEMENTS'); other = await createOrg('OTHER'); unit = (await addProduct(org.id, { cls: 'GSL' })).baseUnitRowId; customer = (await admin.query("insert into public.customers(organization_id,code,name,customer_type) values($1,'C1','Customer','RETAILER') returning id", [org.id])).rows[0].id })
afterAll(closePool)
it('uses the effective price, rejects overlaps and isolates tenants', async () => {
  const made = await call(org.ownerId, "select public.create_price_agreement($1,$2,12.5,current_date,current_date+30,'Negotiated offer') id", [customer, unit])
  if (!made.ok) throw new Error(made.message)
  const price = await call(org.ownerId, 'select public.resolve_price($1,$2) price', [customer, unit])
  expect(price.ok && Number(price.rows[0].price)).toBe(12.5)
  const salesperson = await addUser(org.id, 'SALES_REP', org.hq)
  const scopedPrice = await call(salesperson, 'select public.resolve_price($1,$2) price', [customer, unit])
  expect(scopedPrice.ok && Number(scopedPrice.rows[0].price)).toBe(12.5)
  expect((await call(org.ownerId, "select public.create_price_agreement($1,$2,10,current_date+1,current_date+40,'Overlap')", [customer, unit])).ok).toBe(false)
  expect((await call(other.ownerId, "select public.cancel_price_agreement($1,'Wrong tenant')", [made.rows[0].id])).ok).toBe(false)
  const hidden = await call(other.ownerId, 'select public.resolve_price($1,$2) price', [customer, unit])
  expect(hidden.ok && hidden.rows[0].price).toBe(null)
  expect((await call(org.ownerId, "select public.cancel_price_agreement($1,'Offer withdrawn')", [made.rows[0].id])).ok).toBe(true)
  const cancelled = await call(org.ownerId, 'select public.resolve_price($1,$2) price', [customer, unit])
  expect(cancelled.ok && cancelled.rows[0].price).toBe(null)
})
