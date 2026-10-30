import { afterAll, beforeAll, expect, it } from 'vitest'
import { createOrg, addSupplier, addProduct, addWarehouse, withUser, closePool, type Org } from '../helpers/db'
let org: Org; let other: Org; let supplier: string; let warehouse: string; let product: string
const call = (user: string, sql: string, args: unknown[] = []) => withUser(user, c => c.attempt(sql, args), { commit: true })
beforeAll(async () => { org = await createOrg('QUOTATIONS'); other = await createOrg('OTHER'); supplier = await addSupplier(org.id); warehouse = await addWarehouse(org.id, org.hq, 'MAIN'); product = (await addProduct(org.id, { cls: 'GSL' })).id })
afterAll(closePool)
it('creates a draft purchase order exactly once and isolates the quotation', async () => {
  const created = await call(org.ownerId, "select public.record_supplier_quotation($1,$2,'Q-1',current_date+10,'Supplier offer',$3) id", [supplier, warehouse, JSON.stringify([{ product_id: product, quantity: 10, unit_cost: 2 }])])
  if (!created.ok) throw new Error(created.message)
  const id = created.rows[0].id
  expect((await call(other.ownerId, 'select public.convert_supplier_quotation($1)', [id])).ok).toBe(false)
  const order = await call(org.ownerId, 'select public.convert_supplier_quotation($1) id', [id])
  if (!order.ok) throw new Error(order.message)
  const retry = await call(org.ownerId, 'select public.convert_supplier_quotation($1) id', [id])
  expect(retry.ok && retry.rows[0].id).toBe(order.rows[0].id)
  const row = await call(org.ownerId, 'select status,total_amount from public.purchase_orders where id=$1', [order.rows[0].id])
  expect(row.ok && row.rows[0].status).toBe('DRAFT')
  expect(row.ok && Number(row.rows[0].total_amount)).toBe(20)
  expect((await call(org.ownerId, 'select public.cancel_supplier_quotation($1)', [id])).ok).toBe(false)
})
it('rejects invalid quantities and foreign products', async () => {
  const foreign = (await addProduct(other.id)).id
  for (const line of [{ product_id: product, quantity: 0, unit_cost: 1 }, { product_id: foreign, quantity: 1, unit_cost: 1 }]) {
    expect((await call(org.ownerId, "select public.record_supplier_quotation($1,$2,'BAD',current_date+10,'',$3)", [supplier, warehouse, JSON.stringify([line])])).ok).toBe(false)
  }
})
