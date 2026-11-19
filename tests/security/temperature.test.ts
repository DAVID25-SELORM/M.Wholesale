import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { addBranch, addProduct, addUser, addWarehouse, admin, closePool, createOrg, rand, withUser, type Org } from '../helpers/db'

let a: Org
let b: Org
let wh: string
let owner: string
let ownerB: string
let picker: string
let packer: string
let packerOtherBranch: string
let pharmacist: string
let auditor: string
let cashier: string
let defaultList: string

const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10)
type Out = { ok: true; rows: any[]; rowCount: number } | { ok: false; code: string; message: string }
const call = (user: string, sql: string, params: unknown[] = []): Promise<Out> => withUser(user, (c) => c.attempt(sql, params), { commit: true }) as Promise<Out>
const ok = async (p: Promise<Out>) => { const r = await p; if (!r.ok) throw new Error(`expected ok, got ${r.code}: ${r.message}`); return r.rows }
const failure = async (p: Promise<Out>) => { const r = await p; return r.ok ? { code: 'ok', message: '' } : { code: r.code, message: r.message } }
const q = async (sql: string, params: unknown[] = []) => (await admin.query(sql, params)).rows

beforeAll(async () => {
  a = await createOrg('TEMP-A')
  b = await createOrg('TEMP-B')
  wh = await addWarehouse(a.id, a.hq, 'W1')
  const branch2 = await addBranch(a.id, 'B2')
  await addWarehouse(a.id, branch2, 'W2')
  owner = a.ownerId
  ownerB = b.ownerId
  picker = await addUser(a.id, 'WAREHOUSE_PICKER')
  packer = await addUser(a.id, 'WAREHOUSE_PACKER')
  packerOtherBranch = await addUser(a.id, 'WAREHOUSE_PACKER', branch2)
  pharmacist = await addUser(a.id, 'PHARMACIST')
  auditor = await addUser(a.id, 'AUDITOR')
  cashier = await addUser(a.id, 'CASHIER')
  defaultList = (await q(`insert into public.price_lists (organization_id, code, name, is_default) values ($1, 'RETAIL', 'Retail', true) returning id`, [a.id]))[0].id
})
afterAll(closePool)

/** a posted invoice for one product of the given storage condition, picked, with a packing order open */
async function packingOrder(condition: string) {
  const product = await addProduct(a.id, { cls: 'GSL' })
  await q(`update public.products set storage_condition=$2 where id=$1`, [product.id, condition])
  await q(`insert into public.price_list_items (organization_id, price_list_id, product_id, product_unit_id, unit_price) values ($1,$2,$3,$4,10)`, [a.id, defaultList, product.id, product.baseUnitRowId])
  await ok(call(owner, `select public.post_stock_document('OPENING',$1,$2::jsonb)`, [wh, JSON.stringify([{ product_id: product.id, quantity: 100, batch_number: `T${rand()}`, expiry_date: day(300), unit_cost: 4 }])]))
  const customer = (await q(`insert into public.customers (organization_id, code, name, customer_type, licence_number, licence_expiry, payment_terms_days, credit_limit, address)
    values ($1,$2,$3,'PHARMACY','PC/1',$4,30,1000000,'Plot 4') returning id`, [a.id, `C${rand()}`, `Cust ${rand()}`, day(300)]))[0].id
  const inv = (await ok(call(owner, `select public.save_sales_invoice(null,$1,$2,null,null,$3::jsonb) as id`, [customer, wh, JSON.stringify([{ product_id: product.id, quantity: 5 }])])))[0].id
  await ok(call(owner, `select public.post_sales_invoice($1) as r`, [inv]))
  const id = (await ok(call(owner, `select public.release_to_warehouse($1,2::smallint) as id`, [inv])))[0].id
  await ok(call(picker, `select public.claim_fulfilment_order($1)`, [id]))
  const ls = await q(`select * from public.pick_lines where fulfilment_order_id=$1`, [id])
  for (const l of ls) await ok(call(picker, `select public.confirm_pick_line($1,$2)`, [l.id, l.expected_quantity]))
  await ok(call(packer, `select public.start_packing($1)`, [id]))
  return { id, inv, line: ls[0] }
}
async function coldPackage(o: { id: string; line: any }, cold = true) {
  const pk = (await ok(call(packer, `select public.create_package($1,'COOL_BOX',$2) id`, [o.id, cold])))[0].id
  await ok(call(packer, `select public.pack_line($1,$2,$3)`, [pk, o.line.id, o.line.expected_quantity]))
  return pk as string
}
const record = (user: string, pk: string, stage: string, t: number, note: string | null = null) =>
  call(user, `select public.record_temperature_reading($1,$2,$3,$4) r`, [pk, stage, t, note])

describe('temperature logging', () => {
  it('derives the allowed range from the goods and opens an excursion only when out of range', async () => {
    const o = await packingOrder('REFRIGERATED')
    const pk = await coldPackage(o)
    const good = (await ok(record(packer, pk, 'PACKING', 5.04)))[0].r
    expect(good).toMatchObject({ within_range: true, excursion_id: null, storage_condition: 'REFRIGERATED' })
    expect(Number(good.limit_min_c)).toBe(2)
    expect(Number(good.limit_max_c)).toBe(8)
    const bad = (await ok(record(packer, pk, 'DISPATCH', 9.5, 'Cooler door left open')))[0].r
    expect(bad.within_range).toBe(false)
    expect(bad.excursion_id).toBeTruthy()
    const frozen = await packingOrder('FROZEN')
    const fpk = await coldPackage(frozen)
    expect((await ok(record(packer, fpk, 'PACKING', -20)))[0].r.within_range).toBe(true)
    expect((await ok(record(packer, fpk, 'PACKING', -5)))[0].r.within_range).toBe(false)
  })

  it('blocks dispatch until a different person accepts the goods, and keeps the evidence', async () => {
    const o = await packingOrder('REFRIGERATED')
    const pk = await coldPackage(o)
    const exc = (await ok(record(packer, pk, 'PACKING', 12)))[0].r.excursion_id
    const dn = await prepareDispatchOrSkip(o)
    expect((await failure(call(owner, `select public.dispatch_delivery_note($1,'Driver','Vehicle')`, [dn]))).code).toBe('22023')
    expect((await failure(call(packer, `select public.resolve_temperature_excursion($1,'ACCEPT_USE','Packer cannot decide')`, [exc]))).code).toBe('42501')
    expect((await failure(call(pharmacist, `select public.resolve_temperature_excursion($1,'ACCEPT_USE','short')`, [exc]))).code).toBe('22023')
    expect((await failure(call(pharmacist, `select public.resolve_temperature_excursion($1,'MAYBE','Not a real decision value')`, [exc]))).code).toBe('22023')
    await ok(call(pharmacist, `select public.resolve_temperature_excursion($1,'ACCEPT_USE','Within manufacturer stability data for 2 hours')`, [exc]))
    expect((await failure(call(pharmacist, `select public.resolve_temperature_excursion($1,'ACCEPT_USE','Decided twice by mistake')`, [exc]))).code).toBe('22023')
    await ok(call(owner, `select public.dispatch_delivery_note($1,'Driver','Vehicle')`, [dn]))
    const row = (await q(`select status,decision,decided_by from public.temperature_excursions where id=$1`, [exc]))[0]
    expect(row).toMatchObject({ status: 'RESOLVED', decision: 'ACCEPT_USE', decided_by: pharmacist })
    expect((await q(`select count(*)::int n from public.audit_logs where entity_type='temperature_excursion' and entity_id=$1`, [exc]))[0].n).toBeGreaterThanOrEqual(2)
  })

  it('keeps rejected goods from leaving until the package is voided and repacked', async () => {
    const o = await packingOrder('COOL')
    const pk = await coldPackage(o)
    const exc = (await ok(record(packer, pk, 'PACKING', 20)))[0].r.excursion_id
    await ok(call(pharmacist, `select public.resolve_temperature_excursion($1,'REJECT_GOODS','Exposed above limit for too long')`, [exc]))
    await ok(call(packer, `select public.void_package($1,'Temperature rejected')`, [pk]))
    const pk2 = await coldPackage(o)
    expect((await ok(record(packer, pk2, 'PACKING', 10)))[0].r.within_range).toBe(true)
    const dn = await prepareDispatchOrSkip(o)
    await ok(call(owner, `select public.dispatch_delivery_note($1,'Driver','Vehicle')`, [dn]))
  })

  it('refuses unauthorized, cross-branch, cross-tenant and malformed requests and never moves stock', async () => {
    const o = await packingOrder('REFRIGERATED')
    const pk = await coldPackage(o)
    const before = (await q(`select count(*)::int n from public.stock_movements where organization_id=$1`, [a.id]))[0].n
    const plain = await coldPackage(o, false).catch(() => null)
    expect((await failure(record(cashier, pk, 'PACKING', 5))).code).not.toBe('ok')
    expect((await failure(record(auditor, pk, 'PACKING', 5))).code).not.toBe('ok')
    expect((await failure(record(packerOtherBranch, pk, 'PACKING', 5))).code).not.toBe('ok')
    expect((await failure(record(ownerB, pk, 'PACKING', 5))).code).toBe('P0002')
    expect((await failure(record(packer, pk, 'ELSEWHERE', 5))).code).toBe('22023')
    expect((await failure(record(packer, pk, 'PACKING', 99))).code).toBe('22023')
    expect((await failure(call(packer, `select public.record_temperature_reading($1,'PACKING','NaN'::numeric)`, [pk]))).code).toBe('22023')
    if (plain) expect((await failure(record(packer, plain, 'PACKING', 5))).code).toBe('22023')
    const exc = (await ok(record(packer, pk, 'PACKING', 15)))[0].r.excursion_id
    expect((await failure(call(ownerB, `select public.resolve_temperature_excursion($1,'ACCEPT_USE','Foreign organization attempt')`, [exc]))).code).toBe('P0002')
    expect((await failure(call(auditor, `select public.resolve_temperature_excursion($1,'ACCEPT_USE','Auditor is read only here')`, [exc]))).code).not.toBe('ok')
    // visibility: auditor reads, the other organization sees nothing, nobody writes directly
    expect((await ok(call(auditor, `select id from public.temperature_readings where package_id=$1`, [pk]))).length).toBeGreaterThan(0)
    expect((await ok(call(cashier, `select id from public.temperature_readings where package_id=$1`, [pk]))).length).toBe(0)
    expect((await ok(call(ownerB, `select id from public.temperature_readings where package_id=$1`, [pk]))).length).toBe(0)
    expect((await ok(call(ownerB, `select id from public.temperature_excursions where id=$1`, [exc]))).length).toBe(0)
    expect((await ok(call(ownerB, `select package_id from public.cold_chain_packages()`))).map((r) => r.package_id)).not.toContain(pk)
    expect((await ok(call(owner, `select package_id from public.cold_chain_packages()`))).map((r) => r.package_id)).toContain(pk)
    expect((await failure(call(owner, `insert into public.temperature_readings(branch_id,fulfilment_order_id,package_id,stage,temperature_c,storage_condition,limit_min_c,limit_max_c,within_range) values($1,$2,$3,'PACKING',5,'COOL',8,15,true)`, [a.hq, o.id, pk]))).code).not.toBe('ok')
    expect((await failure(call(owner, `update public.temperature_excursions set status='RESOLVED' where id=$1`, [exc]))).code).not.toBe('ok')
    expect((await failure(call(owner, `delete from public.temperature_excursions where id=$1`, [exc]))).code).not.toBe('ok')
    expect((await q(`select count(*)::int n from public.stock_movements where organization_id=$1`, [a.id]))[0].n).toBe(before)
  })
})

/** prepare the delivery note; controlled lines need an independent verifier, which these GSL lines do not */
async function prepareDispatchOrSkip(o: { id: string; line: any }) {
  await ok(call(packer, `select public.finish_packing($1)`, [o.id]))
  return (await ok(call(owner, `select public.prepare_packed_delivery($1,'Address','Contact','123',null) id`, [o.id])))[0].id as string
}
