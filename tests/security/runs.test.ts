import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { addBranch, addProduct, addUser, addWarehouse, admin, closePool, createOrg, rand, withUser, type Org, type QueryResult } from '../helpers/db'
let a: Org; let b: Org; let wh: string; let branch2: string; let driverUser: string; let otherDriver: string; let branchUser: string; let auditor: string; let priceList: string
const day = (n = 0) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10)
const q = async (sql: string, params: unknown[] = []) => (await admin.query(sql, params)).rows
const call = (u: string | null, sql: string, params: unknown[] = []) => withUser(u, c => c.attempt(sql, params), { commit: true })
async function ok(p: Promise<QueryResult>) { const r = await p; if (!r.ok) throw new Error(`${r.code}: ${r.message}`); return r.rows }
async function denied(p: Promise<QueryResult>, code?: string) { const r = await p; expect(r.ok).toBe(false); if (!r.ok && code) expect(r.code).toBe(code) }
beforeAll(async () => {
  a = await createOrg('RUN-A'); b = await createOrg('RUN-B'); wh = await addWarehouse(a.id, a.hq, 'RW')
  branch2 = await addBranch(a.id, 'RB2'); driverUser = await addUser(a.id, 'DRIVER', a.hq); otherDriver = await addUser(a.id, 'DRIVER', a.hq)
  branchUser = await addUser(a.id, 'BRANCH_MANAGER', branch2); auditor = await addUser(a.id, 'AUDITOR')
  priceList = (await q(`insert into public.price_lists(organization_id,code,name,is_default) values($1,'RETAIL','Retail',true) returning id`, [a.id]))[0].id
})
afterAll(closePool)
async function fleet() {
  const driver = (await q(`insert into public.drivers(organization_id,branch_id,code,name,licence_number,licence_expiry) values($1,$2,$3,'Test driver','LIC',$4) returning id`, [a.id, a.hq, `D${rand()}`, day(300)]))[0].id
  const vehicle = (await q(`insert into public.vehicles(organization_id,branch_id,registration_number,capacity_packages,capacity_kg,refrigerated,insurance_expiry,roadworthy_expiry) values($1,$2,$3,10,100,true,$4,$4) returning id`, [a.id, a.hq, `V${rand()}`, day(300)]))[0].id
  return { driver, vehicle }
}
async function run() {
  const f = await fleet()
  const id = (await ok(call(a.ownerId, `select public.create_delivery_run($1,$2,$3,$4) id`, [a.hq, f.driver, f.vehicle, day()])))[0].id
  return { ...f, id }
}
async function delivery(cold = false) {
  const p = await addProduct(a.id, { cls: 'GSL' })
  await q(`insert into public.price_list_items(organization_id,price_list_id,product_id,product_unit_id,unit_price) values($1,$2,$3,$4,10)`, [a.id, priceList, p.id, p.baseUnitRowId])
  await ok(call(a.ownerId, `select public.post_stock_document('OPENING',$1,$2::jsonb)`, [wh, JSON.stringify([{ product_id: p.id, quantity: 100, batch_number: `B${rand()}`, expiry_date: day(200), unit_cost: 4 }])]))
  const customer = (await q(`insert into public.customers(organization_id,code,name,customer_type,licence_number,licence_expiry,payment_terms_days,credit_limit) values($1,$2,$4,'PHARMACY','LIC',$3,30,1000000) returning id`, [a.id, `C${rand()}`, day(300), `Run customer ${rand()}`]))[0].id
  const inv = (await ok(call(a.ownerId, `select public.save_sales_invoice(null,$1,$2,null,null,$3::jsonb) id`, [customer, wh, JSON.stringify([{ product_id: p.id, quantity: 2 }])])))[0].id
  await ok(call(a.ownerId, `select public.post_sales_invoice($1)`, [inv]))
  const order = (await ok(call(a.ownerId, `select public.release_to_warehouse($1) id`, [inv])))[0].id
  await ok(call(a.ownerId, `select public.claim_fulfilment_order($1)`, [order]))
  const line = (await q(`select id from public.pick_lines where fulfilment_order_id=$1`, [order]))[0].id
  await ok(call(a.ownerId, `select public.confirm_pick_line($1,2)`, [line]))
  await ok(call(a.ownerId, `select public.start_packing($1)`, [order]))
  const pkg = (await ok(call(a.ownerId, `select public.create_package($1,'CARTON',$2,false) id`, [order, cold])))[0].id
  await ok(call(a.ownerId, `select public.pack_line($1,$2,2)`, [pkg, line]))
  await ok(call(a.ownerId, `select public.finish_packing($1)`, [order]))
  const note = (await ok(call(a.ownerId, `select public.prepare_packed_delivery($1,'Address','Contact','123','Instructions') id`, [order])))[0].id
  return { inv, note, order }
}
const add = async (runId: string, note: string, weight = 5) => (await ok(call(a.ownerId, `select public.add_run_stop($1,$2,$3) id`, [runId, note, weight])))[0].id
const state = async (id: string) => (await q(`select status from public.delivery_runs where id=$1`, [id]))[0].status
describe('delivery runs', () => {
  it('plans, reorders, loads, dispatches atomically, records outcomes and returns failed goods without stock movements', async () => {
    const r = await run(); const d1 = await delivery(); const d2 = await delivery(true)
    const s1 = await add(r.id, d1.note); const s2 = await add(r.id, d2.note)
    const before = (await q(`select count(*)::int n from public.stock_movements where organization_id=$1`, [a.id]))[0].n
    await ok(call(a.ownerId, `select public.reorder_run_stops($1,$2::uuid[])`, [r.id, [s2, s1]]))
    expect((await q(`select id from public.delivery_run_stops where run_id=$1 order by position`, [r.id])).map(s => s.id)).toEqual([s2, s1])
    await denied(call(a.ownerId, `select public.dispatch_delivery_note($1,'Driver',null)`, [d1.note]), '22023')
    await ok(call(a.ownerId, `select public.start_run_loading($1)`, [r.id]))
    await denied(call(a.ownerId, `select public.dispatch_delivery_run($1)`, [r.id]), '22023')
    await denied(call(a.ownerId, `select public.load_run_stop($1,2)`, [s1]), '22023')
    for (const id of [s1, s2]) await ok(call(a.ownerId, `select public.load_run_stop($1,1)`, [id]))
    await ok(call(a.ownerId, `select public.dispatch_delivery_run($1)`, [r.id]))
    expect(await state(r.id)).toBe('ON_ROAD')
    await denied(call(a.ownerId, `select public.confirm_delivery($1,'Receiver')`, [d1.note]), '22023')
    await denied(call(auditor, `select public.record_run_outcome($1,true,'Receiver','')`, [s1]), '42501')
    await ok(call(a.ownerId, `select public.record_run_outcome($1,true,'Receiver','')`, [s1]))
    await denied(call(a.ownerId, `select public.record_run_outcome($1,true,'Duplicate','')`, [s1]), '22023')
    await ok(call(a.ownerId, `select public.record_run_outcome($1,false,'','Customer unavailable')`, [s2]))
    expect(await state(r.id)).toBe('COMPLETED')
    await ok(call(a.ownerId, `select public.return_run_stop($1)`, [s2]))
    await denied(call(a.ownerId, `select public.return_run_stop($1)`, [s2]), '22023')
    expect((await q(`select count(*)::int n from public.stock_movements where organization_id=$1`, [a.id]))[0].n).toBe(before)
    expect((await q(`select status from public.delivery_notes where id=$1`, [d1.note]))[0].status).toBe('DELIVERED')
  })
  it('rejects expired or missing documents, duplicate assignments, overloads and non-refrigerated cold-chain loads', async () => {
    const f = await fleet()
    await q(`update public.drivers set licence_expiry=$2 where id=$1`, [f.driver, day(-1)])
    await denied(call(a.ownerId, `select public.create_delivery_run($1,$2,$3,$4)`, [a.hq, f.driver, f.vehicle, day()]), '22023')
    await q(`update public.drivers set licence_expiry=$2 where id=$1`, [f.driver, day(300)])
    await q(`update public.vehicles set insurance_expiry=null where id=$1`, [f.vehicle])
    await denied(call(a.ownerId, `select public.create_delivery_run($1,$2,$3,$4)`, [a.hq, f.driver, f.vehicle, day()]), '22023')
    const r = await run(); const d = await delivery(true)
    await denied(call(a.ownerId, `select public.create_delivery_run($1,$2,$3,$4)`, [a.hq, r.driver, r.vehicle, day()]), '23505')
    await denied(call(a.ownerId, `select public.add_run_stop($1,$2,101)`, [r.id, d.note]), '22023')
    await q(`update public.vehicles set refrigerated=false where id=$1`, [r.vehicle])
    await denied(call(a.ownerId, `select public.add_run_stop($1,$2,5)`, [r.id, d.note]), '22023')
    await q(`update public.vehicles set refrigerated=true where id=$1`, [r.vehicle])
    const stop = await add(r.id, d.note)
    const other = await run()
    await denied(call(a.ownerId, `select public.add_run_stop($1,$2,5)`, [other.id, d.note]), '23505')
    await ok(call(a.ownerId, `select public.start_run_loading($1)`, [r.id])); await ok(call(a.ownerId, `select public.load_run_stop($1,1)`, [stop]))
    await q(`update public.vehicles set roadworthy_expiry=$2 where id=$1`, [r.vehicle, day(-1)])
    await denied(call(a.ownerId, `select public.dispatch_delivery_run($1)`, [r.id]), '22023')
    expect(await state(r.id)).toBe('LOADING')
  })
  it('limits drivers to assigned runs, blocks cross-tenant/branch reads and mutations and direct writes', async () => {
    const r = await run(); const d = await delivery(); const stop = await add(r.id, d.note)
    await ok(call(a.ownerId, `select public.link_driver_profile($1,$2)`, [r.driver, driverUser]))
    expect((await ok(call(driverUser, `select public.delivery_run_list() data`)))[0].data.map((x: { id: string }) => x.id)).toEqual([r.id])
    for (const u of [b.ownerId, branchUser, otherDriver]) {
      expect((await ok(call(u, `select public.delivery_run_list() data`)))[0].data).toEqual([])
      for (const sql of ['select public.delivery_run_detail($1)', 'select public.start_run_loading($1)', 'select public.dispatch_delivery_run($1)', "select public.cancel_delivery_run($1,'Cancel test')"]) await denied(call(u, sql, [r.id]), 'P0002')
      await denied(call(u, `select public.record_run_outcome($1,true,'Name','')`, [stop]), 'P0002')
      await denied(call(u, `select public.load_run_stop($1,1)`, [stop]), 'P0002')
      await denied(call(u, `select public.return_run_stop($1)`, [stop]), 'P0002')
      expect(await withUser(u, async c => (await c.q(`select id from public.delivery_run_stops where run_id=$1`, [r.id])).rows)).toEqual([])
    }
    await denied(call(driverUser, `select public.start_run_loading($1)`, [r.id]), '42501')
    await denied(call(driverUser, `update public.delivery_runs set status='ON_ROAD' where id=$1`, [r.id]), '42501')
    await denied(call(driverUser, `update public.drivers set profile_id=$2 where id=$1`, [r.driver, otherDriver]), '42501')
    await denied(call(a.ownerId, `select public.link_driver_profile($1,$2)`, [r.driver, b.ownerId]), '22023')
    await denied(call(null, `select public.delivery_run_list()`), '42501')
    await ok(call(a.ownerId, `select public.start_run_loading($1)`, [r.id])); await ok(call(a.ownerId, `select public.load_run_stop($1,1)`, [stop])); await ok(call(a.ownerId, `select public.dispatch_delivery_run($1)`, [r.id]))
    await ok(call(driverUser, `select public.record_run_outcome($1,true,'Receiver','')`, [stop]))
    expect(await state(r.id)).toBe('COMPLETED')
    await expect(admin.query(`insert into public.delivery_runs(organization_id,branch_id,run_number,run_date,driver_id,vehicle_id,created_by) values($1,$2,'FORGED',current_date,$3,$4,$5)`, [b.id, b.hq, r.driver, r.vehicle, b.ownerId])).rejects.toMatchObject({ code: '23503' })
  })
  it('retains removed stops and cancellations while releasing assignments', async () => {
    const r = await run(); const d = await delivery(); const stop = await add(r.id, d.note)
    await ok(call(a.ownerId, `select public.remove_run_stop($1,'Wrong route')`, [stop]))
    const again = await add(r.id, d.note)
    await denied(call(a.ownerId, `select public.reorder_run_stops($1,$2::uuid[])`, [r.id, [stop]]), '22023')
    await ok(call(a.ownerId, `select public.cancel_delivery_run($1,'Route cancelled')`, [r.id]))
    expect((await q(`select status from public.delivery_run_stops where id=$1`, [again]))[0].status).toBe('REMOVED')
    await ok(call(a.ownerId, `select public.create_delivery_run($1,$2,$3,$4)`, [a.hq, r.driver, r.vehicle, day()]))
  })
  it('requires returned-goods check-in before a failed invoice can be planned again', async () => {
    const r = await run(); const d = await delivery(); const stop = await add(r.id, d.note)
    await ok(call(a.ownerId, `select public.start_run_loading($1)`, [r.id]))
    await ok(call(a.ownerId, `select public.load_run_stop($1,1)`, [stop]))
    await ok(call(a.ownerId, `select public.dispatch_delivery_run($1)`, [r.id]))
    await ok(call(a.ownerId, `select public.record_run_outcome($1,false,'','Not at address')`, [stop]))
    const note = (await ok(call(a.ownerId, `select public.prepare_packed_delivery($1,'Address','Contact','123','Redelivery') id`, [d.order])))[0].id
    const next = await run()
    await denied(call(a.ownerId, `select public.add_run_stop($1,$2,5)`, [next.id, note]), '22023')
    await ok(call(a.ownerId, `select public.return_run_stop($1)`, [stop]))
    await add(next.id, note)
  })
  it('serializes competing assignments and denies foreign planning inputs', async () => {
    const f = await fleet()
    const attempts = await Promise.all([1, 2].map(() => call(a.ownerId, `select public.create_delivery_run($1,$2,$3,$4)`, [a.hq, f.driver, f.vehicle, day()])))
    expect(attempts.filter(x => x.ok)).toHaveLength(1)
    expect(attempts.filter(x => !x.ok)).toHaveLength(1)
    await denied(call(b.ownerId, `select public.create_delivery_run($1,$2,$3,$4)`, [b.hq, f.driver, f.vehicle, day()]), '22023')
    await denied(call(branchUser, `select public.run_planning_options($1)`, [a.hq]), '42501')
    await denied(call(b.ownerId, `select public.run_planning_options($1)`, [a.hq]), '42501')
    const r = await run(); const d = await delivery()
    await denied(call(b.ownerId, `select public.add_run_stop($1,$2,1)`, [r.id, d.note]), 'P0002')
    const id = await add(r.id, d.note)
    await denied(call(b.ownerId, `select public.remove_run_stop($1,'Forbidden')`, [id]), 'P0002')
    await denied(call(b.ownerId, `select public.reorder_run_stops($1,$2::uuid[])`, [r.id, [id]]), 'P0002')
    await denied(call(b.ownerId, `select public.driver_profile_options($1)`, [r.driver]), 'P0002')
    const dispatcher = await addUser(a.id, 'DISPATCHER')
    await denied(call(dispatcher, `select public.link_driver_profile($1,$2)`, [r.driver, driverUser]), '42501')
    await denied(call(dispatcher, `insert into public.drivers(branch_id,code,name,profile_id) values($1,$2,'Unauthorized link',$3)`, [a.hq, `D${rand()}`, driverUser]), '42501')
  })
})
