import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { addLocation, addProduct, addUser, addWarehouse, admin, closePool, createOrg, rand, withUser, type Org } from '../helpers/db'

let org: Org
let other: Org
let warehouse: string
let viewer: string
const call = (user: string, sql: string, params: unknown[] = []) => withUser(user, c => c.attempt(sql, params), { commit: true })
async function ok(user: string, sql: string, params: unknown[] = []) {
  const result = await call(user, sql, params)
  if (!result.ok) throw new Error(`${result.code}: ${result.message}`)
  return result.rows
}
beforeAll(async () => {
  org = await createOrg('RECALL-A')
  other = await createOrg('RECALL-B')
  warehouse = await addWarehouse(org.id, org.hq, 'RECALL')
  viewer = await addUser(org.id, 'AUDITOR')
})
afterAll(closePool)

describe('recall workflow', () => {
  it('releases only recall-held quantities and makes retries harmless', async () => {
    const product = await addProduct(org.id, { cls: 'GSL' })
    const batchNumber = `RELEASE-${rand()}`
    await ok(org.ownerId, "select public.post_stock_document('OPENING',$1,$2::jsonb)", [warehouse, JSON.stringify([{ product_id: product.id, quantity: 15, batch_number: batchNumber, expiry_date: '2030-12-31', unit_cost: 2 }])])
    const batch = (await admin.query('select id from public.batches where organization_id=$1 and batch_number=$2', [org.id, batchNumber])).rows[0].id
    await ok(org.ownerId, "select public.post_stock_document('STATUS_CHANGE',$1,$2::jsonb,null,'QUALITY_HOLD','Unrelated quality hold')", [warehouse, JSON.stringify([{ product_id: product.id, quantity: 5, batch_id: batch, status: 'AVAILABLE', to_status: 'QUARANTINE' }])])
    const recall = (await ok(org.ownerId, "select public.create_recall('INTERNAL','II','Release test','Hold affected stock') id"))[0].id
    const scope = (await ok(org.ownerId, 'select public.add_recall_batch($1,$2) id', [recall, batch]))[0].id
    await ok(org.ownerId, "select public.quarantine_recall_batch($1,'Recall quarantine')", [scope])
    await ok(org.ownerId, "select public.cancel_recall($1,'Recall cancelled after investigation')", [recall])
    expect((await call(other.ownerId, "select public.release_recall_batch($1,'Foreign attempt')", [scope])).ok).toBe(false)
    const released = (await ok(org.ownerId, "select public.release_recall_batch($1,'Cleared recall hold') result", [scope]))[0].result
    expect(released.released).toBe(10)
    const retry = (await ok(org.ownerId, "select public.release_recall_batch($1,'Repeated release') result", [scope]))[0].result
    expect(retry.released).toBe(0)
    const held = (await admin.query("select sum(quantity)::float8 qty from public.stock_balances where batch_id=$1 and stock_status='QUARANTINE'", [batch])).rows[0].qty
    expect(held).toBe(5)
  })
  it('quarantines the exact location, keeps evidence, and closes only scoped quarantined stock', async () => {
    const product = await addProduct(org.id, { cls: 'GSL' })
    const location = await addLocation(org.id, warehouse, `R-${rand()}`)
    const batchNumber = `RECALL-${rand()}`
    await ok(org.ownerId, `select public.post_stock_document('OPENING',$1,$2::jsonb)`, [warehouse, JSON.stringify([{ product_id: product.id, quantity: 12, batch_number: batchNumber, expiry_date: '2030-12-31', unit_cost: 2, location_id: location }])])
    const batch = (await admin.query('select id from public.batches where organization_id=$1 and batch_number=$2', [org.id, batchNumber])).rows[0].id
    const recall = (await ok(org.ownerId, `select public.create_recall('INTERNAL','II','Recall test','Quarantine affected stock') id`))[0].id
    expect((await call(org.ownerId, 'select public.close_recall($1)', [recall])).ok).toBe(false)
    const scope = (await ok(org.ownerId, 'select public.add_recall_batch($1,$2) id', [recall, batch]))[0].id
    expect(await ok(viewer, 'select * from public.recall_customer_exposure($1)', [recall])).toEqual([])
    expect((await call(other.ownerId, 'select * from public.recall_customer_exposure($1)', [recall])).ok).toBe(false)
    expect((await call(other.ownerId, 'select public.quarantine_recall_batch($1,$2)', [scope, 'Unauthorized attempt'])).ok).toBe(false)
    expect((await call(viewer, 'select public.quarantine_recall_batch($1,$2)', [scope, 'Read only attempt'])).ok).toBe(false)
    const result = (await ok(org.ownerId, 'select public.quarantine_recall_batch($1,$2) result', [scope, 'Affected batch quarantined']))[0].result
    expect(result.quarantined).toBe(12)
    expect(result.documents).toHaveLength(1)
    const balances = (await admin.query('select location_id,stock_status,quantity::float8 quantity from public.stock_balances where organization_id=$1 and batch_id=$2 and quantity>0', [org.id, batch])).rows
    expect(balances).toEqual([{ location_id: location, stock_status: 'QUARANTINE', quantity: 12 }])
    await ok(org.ownerId, 'select public.close_recall($1)', [recall])
    expect((await call(org.ownerId, 'select public.quarantine_recall_batch($1,$2)', [scope, 'Closed recall attempt'])).ok).toBe(false)
    expect((await call(org.ownerId, `select public.post_stock_document('STATUS_CHANGE',$1,$2::jsonb)`, [warehouse, JSON.stringify([{ product_id: product.id, quantity: 1, batch_id: batch, location_id: location, to_location_id: location, status: 'QUARANTINE', to_status: 'AVAILABLE' }])])).ok).toBe(false)
  })
})
