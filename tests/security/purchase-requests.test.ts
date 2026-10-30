import { afterAll, beforeAll, expect, it } from 'vitest'
import { addBranch, addProduct, addSupplier, addUser, addWarehouse, closePool, createOrg, withUser, type Org } from '../helpers/db'
let org: Org
let other: Org
let approver: string
let product: string
const call = (user: string, sql: string, params: unknown[] = []) => withUser(user, c => c.attempt(sql, params), { commit: true })
beforeAll(async () => {
  org = await createOrg('REQUEST-A'); other = await createOrg('REQUEST-B')
  approver = await addUser(org.id, 'BRANCH_MANAGER', org.hq)
  product = (await addProduct(org.id, { cls: 'GSL' })).id
})
afterAll(closePool)
it('converts approved demand once, rejecting foreign branches, missing costs and unapproved requests', async () => {
  const supplier = await addSupplier(org.id)
  const warehouse = await addWarehouse(org.id, org.hq, 'REQUEST-ORDER')
  const foreignWarehouse = await addWarehouse(other.id, other.hq, 'FOREIGN-REQUEST')
  const created = await call(org.ownerId, 'select public.create_purchase_request($1,null,null,null,$2) id', [org.hq, JSON.stringify([{ product_id: product, quantity: 3 }])])
  if (!created.ok) throw new Error(created.message)
  const id = created.rows[0].id
  const sql = 'select public.convert_purchase_request($1,$2,$3,$4) id'
  const args = [id, supplier, warehouse, JSON.stringify({ [product]: 2 })]
  expect((await call(org.ownerId, sql, args)).ok).toBe(false)
  await call(org.ownerId, 'select public.submit_purchase_request($1)', [id])
  await call(approver, "select public.decide_purchase_request($1,true,'Approved budget')", [id])
  expect((await call(other.ownerId, sql, args)).ok).toBe(false)
  expect((await call(org.ownerId, sql, [id, supplier, foreignWarehouse, args[3]])).ok).toBe(false)
  expect((await call(org.ownerId, sql, [id, supplier, warehouse, '{}'])).ok).toBe(false)
  const order = await call(org.ownerId, sql, args)
  if (!order.ok) throw new Error(order.message)
  const retry = await call(org.ownerId, sql, args)
  expect(retry.ok && retry.rows[0].id).toBe(order.rows[0].id)
  const row = await call(org.ownerId, 'select status,total_amount from public.purchase_orders where id=$1', [order.rows[0].id])
  expect(row.ok && row.rows[0].status).toBe('DRAFT')
  expect(row.ok && Number(row.rows[0].total_amount)).toBe(6)
})
it('limits branch approvers to their branch', async () => {
  const branch = await addBranch(org.id, 'SECOND')
  const created = await call(org.ownerId, 'select public.create_purchase_request($1,null,null,null,$2::jsonb) id', [branch, JSON.stringify([{ product_id: product, quantity: 1 }])])
  if (!created.ok) throw new Error(created.message)
  const id = created.rows[0].id
  await call(org.ownerId, 'select public.submit_purchase_request($1)', [id])
  const hidden = await call(approver, 'select id from public.purchase_requests where id=$1', [id])
  expect(hidden.ok && hidden.rows.length).toBe(0)
  expect((await call(approver, 'select public.decide_purchase_request($1,true,$2)', [id, 'Wrong branch'])).ok).toBe(false)
})
it('persists a request, requires independent approval, and isolates tenants', async () => {
  const created = await call(org.ownerId, 'select public.create_purchase_request($1,null,null,$2,$3::jsonb) id', [org.hq, 'Routine replenishment', JSON.stringify([{ product_id: product, quantity: 2 }])])
  if (!created.ok) throw new Error(created.message)
  const id = created.rows[0].id
  expect((await call(org.ownerId, 'select public.submit_purchase_request($1)', [id])).ok).toBe(true)
  expect((await call(org.ownerId, 'select public.decide_purchase_request($1,true,$2)', [id, 'Self approval'])).ok).toBe(false)
  expect((await call(other.ownerId, 'select public.decide_purchase_request($1,true,$2)', [id, 'Cross tenant'])).ok).toBe(false)
  const hidden = await call(other.ownerId, 'select id from public.purchase_requests where id=$1', [id])
  expect(hidden.ok && hidden.rows.length).toBe(0)
  expect((await call(approver, 'select public.decide_purchase_request($1,null,$2)', [id, 'Missing decision'])).ok).toBe(false)
  expect((await call(approver, 'select public.decide_purchase_request($1,true,$2)', [id, 'Budget confirmed'])).ok).toBe(true)
  expect((await call(org.ownerId, 'select public.cancel_purchase_request($1,$2)', [id, 'Cannot cancel approval'])).ok).toBe(false)
})
it('rejects foreign products, invalid quantities, and foreign warehouses', async () => {
  const foreign = (await addProduct(other.id, { cls: 'GSL' })).id
  const warehouse = await addWarehouse(other.id, other.hq, 'OTHER')
  for (const lines of [[], [{ product_id: foreign, quantity: 1 }], [{ product_id: product, quantity: 0 }], [{ product_id: product, quantity: 0.0001 }], [{ product_id: product, quantity: 'NaN' }]]) {
    expect((await call(org.ownerId, 'select public.create_purchase_request($1,null,null,null,$2::jsonb)', [org.hq, JSON.stringify(lines)])).ok).toBe(false)
  }
  expect((await call(org.ownerId, 'select public.create_purchase_request($1,$2,null,null,$3::jsonb)', [org.hq, warehouse, JSON.stringify([{ product_id: product, quantity: 1 }])])).ok).toBe(false)
})
