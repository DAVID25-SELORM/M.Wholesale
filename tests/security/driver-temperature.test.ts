import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { addProduct, addUser, addWarehouse, admin, closePool, createOrg, rand, withUser, type Org, type QueryResult } from '../helpers/db'

let a: Org
let b: Org
let wh: string
let driverUser: string
let otherDriver: string
let auditor: string
let priceList: string
const day = (n = 0) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10)
const q = async (sql: string, params: unknown[] = []) => (await admin.query(sql, params)).rows
const call = (u: string | null, sql: string, params: unknown[] = []) => withUser(u, (c) => c.attempt(sql, params), { commit: true })
async function ok(p: Promise<QueryResult>) { const r = await p; if (!r.ok) throw new Error(`${r.code}: ${r.message}`); return r.rows }
async function code(p: Promise<QueryResult>) { const r = await p; return r.ok ? 'ok' : r.code }

beforeAll(async () => {
  a = await createOrg('DRVT-A')
  b = await createOrg('DRVT-B')
  wh = await addWarehouse(a.id, a.hq, 'DW')
  driverUser = await addUser(a.id, 'DRIVER', a.hq)
  otherDriver = await addUser(a.id, 'DRIVER', a.hq)
  auditor = await addUser(a.id, 'AUDITOR')
  priceList = (await q(`insert into public.price_lists(organization_id,code,name,is_default) values($1,'RETAIL','Retail',true) returning id`, [a.id]))[0].id
})
afterAll(closePool)

async function delivery(cold: boolean) {
  const p = await addProduct(a.id, { cls: 'GSL' })
  await q(`insert into public.price_list_items(organization_id,price_list_id,product_id,product_unit_id,unit_price) values($1,$2,$3,$4,10)`, [a.id, priceList, p.id, p.baseUnitRowId])
  await ok(call(a.ownerId, `select public.post_stock_document('OPENING',$1,$2::jsonb)`, [wh, JSON.stringify([{ product_id: p.id, quantity: 100, batch_number: `B${rand()}`, expiry_date: day(200), unit_cost: 4 }])]))
  const customer = (await q(`insert into public.customers(organization_id,code,name,customer_type,licence_number,licence_expiry,payment_terms_days,credit_limit) values($1,$2,$4,'PHARMACY','LIC',$3,30,1000000) returning id`, [a.id, `C${rand()}`, day(300), `Cust ${rand()}`]))[0].id
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
  const note = (await ok(call(a.ownerId, `select public.prepare_packed_delivery($1,'Address','Contact','123',null) id`, [order])))[0].id
  return { note, pkg: pkg as string }
}
async function plannedRun(stops: { note: string }[]) {
  const driver = (await q(`insert into public.drivers(organization_id,branch_id,code,name,licence_number,licence_expiry,profile_id) values($1,$2,$3,'Run driver','LIC',$4,$5) returning id`, [a.id, a.hq, `D${rand()}`, day(300), driverUser]))[0].id
  const vehicle = (await q(`insert into public.vehicles(organization_id,branch_id,registration_number,capacity_packages,capacity_kg,refrigerated,insurance_expiry,roadworthy_expiry) values($1,$2,$3,10,100,true,$4,$4) returning id`, [a.id, a.hq, `V${rand()}`, day(300)]))[0].id
  const id = (await ok(call(a.ownerId, `select public.create_delivery_run($1,$2,$3,$4) id`, [a.hq, driver, vehicle, day()])))[0].id
  const ids: string[] = []
  for (const s of stops) ids.push((await ok(call(a.ownerId, `select public.add_run_stop($1,$2,5) id`, [id, s.note])))[0].id)
  return { id: id as string, ids }
}
const record = (u: string, run: string, pkg: string, stage: string, t: number) => call(u, `select public.record_run_temperature($1,$2,$3,$4,'Probe check') r`, [run, pkg, stage, t])

describe('driver temperature capture', () => {
  it('lets only the assigned driver record, only while on the road, only for cold packages on the run', async () => {
    const cold = await delivery(true)
    const warm = await delivery(false)
    const run = await plannedRun([cold, warm])
    expect(await code(record(driverUser, run.id, cold.pkg, 'TRANSIT', 20))).toBe('22023')      // not on the road yet
    await ok(call(a.ownerId, `select public.start_run_loading($1)`, [run.id]))
    for (const id of run.ids) await ok(call(a.ownerId, `select public.load_run_stop($1,1)`, [id]))
    await ok(call(a.ownerId, `select public.dispatch_delivery_run($1)`, [run.id]))
    const elsewhere = await delivery(true)
    const movements = (await q(`select count(*)::int n from public.stock_movements where organization_id=$1`, [a.id]))[0].n

    // the run lists only its cold-chain package, to the driver and to a run viewer, and not to another driver or organization
    expect((await ok(call(driverUser, `select package_id from public.run_cold_packages($1)`, [run.id]))).map((r) => r.package_id)).toEqual([cold.pkg])
    expect((await ok(call(auditor, `select package_id from public.run_cold_packages($1)`, [run.id]))).length).toBe(1)
    expect(await code(call(otherDriver, `select * from public.run_cold_packages($1)`, [run.id]))).toBe('P0002')
    expect(await code(call(b.ownerId, `select * from public.run_cold_packages($1)`, [run.id]))).toBe('P0002')

    const good = (await ok(record(driverUser, run.id, cold.pkg, 'TRANSIT', 22)))[0].r
    expect(good).toMatchObject({ within_range: true, excursion_id: null })
    const bad = (await ok(record(driverUser, run.id, cold.pkg, 'DELIVERY', 40)))[0].r
    expect(bad.within_range).toBe(false)
    expect(bad.excursion_id).toBeTruthy()
    expect((await q(`select stage,recorded_by from public.temperature_readings where package_id=$1 order by recorded_at`, [cold.pkg])).map((r) => `${r.stage}:${r.recorded_by}`)).toEqual([`TRANSIT:${driverUser}`, `DELIVERY:${driverUser}`])

    expect(await code(record(driverUser, run.id, cold.pkg, 'PACKING', 5))).toBe('22023')       // warehouse stages are not a driver's to record
    expect(await code(record(driverUser, run.id, warm.pkg, 'TRANSIT', 5))).toBe('22023')       // not a cold-chain package
    expect(await code(record(otherDriver, run.id, cold.pkg, 'TRANSIT', 5))).not.toBe('ok')     // not the assigned driver
    expect(await code(record(auditor, run.id, cold.pkg, 'TRANSIT', 5))).not.toBe('ok')         // view only
    expect(await code(record(b.ownerId, run.id, cold.pkg, 'TRANSIT', 5))).toBe('P0002')        // another organization
    expect(await code(record(driverUser, run.id, elsewhere.pkg, 'TRANSIT', 5))).toBe('P0002')  // a package that is not on this run

    // drivers hold no broad temperature rights: no direct recording, no reading the log, no deciding
    expect(await code(call(driverUser, `select public.record_temperature_reading($1,'TRANSIT',5)`, [cold.pkg]))).not.toBe('ok')
    expect((await ok(call(driverUser, `select id from public.temperature_readings where package_id=$1`, [cold.pkg]))).length).toBe(0)
    expect(await code(call(driverUser, `select public.resolve_temperature_excursion($1,'ACCEPT_USE','Driver deciding own reading')`, [bad.excursion_id]))).not.toBe('ok')
    // a manager who did not record it can decide it
    await ok(call(a.ownerId, `select public.resolve_temperature_excursion($1,'ACCEPT_USE','Checked against manufacturer stability data')`, [bad.excursion_id]))

    // finishing the run closes capture
    await ok(call(a.ownerId, `select public.record_run_outcome($1,true,'Receiver','')`, [run.ids[0]]))
    await ok(call(a.ownerId, `select public.record_run_outcome($1,true,'Receiver','')`, [run.ids[1]]))
    expect(await code(record(driverUser, run.id, cold.pkg, 'DELIVERY', 22))).toBe('22023')
    expect((await q(`select count(*)::int n from public.stock_movements where organization_id=$1`, [a.id]))[0].n).toBe(movements)
  })
})
